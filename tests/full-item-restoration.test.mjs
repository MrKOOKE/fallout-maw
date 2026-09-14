import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFullItemRestorationUpdate } from "../src/items/full-restoration.mjs";

globalThis.foundry = { utils: { deepClone: structuredClone,
  diffObject: (before, after) => isDeepStrictEqual(before, after) ? {} : structuredClone(after),
  getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
  setProperty(object, path, value) {
    const keys = path.split("."), last = keys.pop();
    for (const key of keys) object = object[key] ??= {};
    object[last] = value;
  }
} };

function item(functions, extra = {}) {
  const data = { _id: "owned", type: "gear", system: { quantity: 1, functions, ...extra } };
  return { id: data._id, uuid: "Actor.a.Item.owned", toObject: () => structuredClone(data), data };
}
const magazine = (value, max) => ({ enabled: true, magazine: { value, max, sourceItemUuid: "Item.ammo" } });
const battery = (value, max) => ({ enabled: true, reserve: { value, max } });

test("repair refills broken weapons and both kinds of battery without consuming inventory ammunition", () => {
  const source = item({ condition: { enabled: true, value: 0, max: 80 }, weapon: magazine(2, 30),
    energySource: battery(0, 12.75), energyConsumer: { enabled: true, installedSource: {
      sourceItemUuid: "Item.cell", reserve: { value: 1.5, max: 22.5 }, itemData: { system: { functions: { energySource: battery(1.5, 22.5) } } }
    } } }, { quantity: 4, container: { parentId: "backpack" } });
  const result = createFullItemRestorationUpdate(source);
  const functions = result.system.functions;
  assert.equal(functions.condition.value, 80);
  assert.equal(functions.weapon.magazine.value, 30);
  assert.equal(functions.weapon.magazine.sourceItemUuid, "Item.ammo");
  assert.equal(functions.energySource.reserve.value, 12.75);
  assert.equal(functions.energyConsumer.installedSource.reserve.value, 22.5);
  assert.equal(functions.energyConsumer.installedSource.itemData.system.functions.energySource.reserve.value, 22.5);
  assert.equal(result.system.quantity, 4);
  assert.equal(result.system.container.parentId, "backpack");
  assert.equal(source.data.system.functions.condition.value, 0, "planning does not edit the live document");
});

test("items without a condition function still refill and primary/additional magazines are independent", () => {
  const source = item({ weapon: magazine(0, 20), additionalWeapons: { grenade: magazine(0, 1) }, energySource: battery(0, 5) });
  const functions = createFullItemRestorationUpdate(source).system.functions;
  assert.equal(functions.weapon.magazine.value, 20);
  assert.equal(functions.additionalWeapons.grenade.magazine.value, 1);
  assert.equal(functions.energySource.reserve.value, 5);
  assert.equal(functions.condition, undefined);
});

test("repaired capacity modules set the effective magazine maximum and keep their own magazines and cells full", () => {
  const moduleData = { system: { functions: {
    condition: { enabled: true, value: 0, max: 100 },
    module: { enabled: true, targetFunction: "weapon", weapon: { magazineMax: 10 }, additionalWeapons: { launcher: magazine(0, 2) } },
    energyConsumer: { enabled: true, installedSource: { sourceItemUuid: "Item.module-cell", reserve: { value: 0, max: 8 } } }
  } } };
  const source = item({ weapon: { ...magazine(1, 20), moduleSlots: [{ id: "extension", itemUuid: "Item.extension", itemData: moduleData }] } });
  const weapon = createFullItemRestorationUpdate(source).system.functions.weapon;
  assert.equal(weapon.magazine.max, 20, "base capacity is preserved");
  assert.equal(weapon.magazine.value, 30, "installed capacity bonus is applied after repair");
  const functions = weapon.moduleSlots[0].itemData.system.functions;
  assert.equal(functions.condition.value, 100);
  assert.equal(functions.module.additionalWeapons.launcher.magazine.value, 2);
  assert.equal(functions.energyConsumer.installedSource.reserve.value, 8);
  assert.equal(moduleData.system.functions.condition.value, 0);
});

test("loose modules also refill their own weapon functions", () => {
  const source = item({ module: { enabled: true, additionalWeapons: [magazine(0, 3)] } });
  assert.equal(createFullItemRestorationUpdate(source).system.functions.module.additionalWeapons[0].magazine.value, 3);
});

test("disabled functions, absent installed sources and unlimited capacities are preserved", () => {
  const source = item({ weapon: magazine(50, 0), energySource: battery(15, 0),
    condition: { enabled: false, value: 2, max: 10 },
    additionalWeapons: { disabled: { ...magazine(0, 7), enabled: false } },
    energyConsumer: { enabled: true, installedSource: { sourceItemUuid: "", reserve: { value: 0, max: 20 } } }
  });
  assert.equal(createFullItemRestorationUpdate(source), null);
  assert.equal(createFullItemRestorationUpdate(item({ weapon: { ...magazine(0, 9), enabled: false },
    energySource: { ...battery(0, 15), enabled: false } })), null);
});

test("already restored items produce no update", () => {
  assert.equal(createFullItemRestorationUpdate(item({ condition: { enabled: true, value: 100, max: 100 },
    weapon: magazine(30, 30), energySource: battery(2.5, 2.5) })), null);
});

test("full healing only restores items when selected and writes every changed item together", async () => {
  const source = readFileSync(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8");
  const implementations = ["fullyRestoreActor", "fullyRepairActorItems"].map(name => {
    const match = source.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `Missing ${name}`);
    return match[0];
  }).join("\n");
  let healing = 0;
  const restore = new Function("createFullItemRestorationUpdate", "fullyRestoreActorDamageState",
    "deleteActorOverloadEffects", "setActorTokensPosture", `${implementations}\nreturn fullyRestoreActor;`)(
    createFullItemRestorationUpdate, async () => healing++, async () => {}, async () => {}
  );
  const writes = [];
  const actor = { items: [item({ weapon: magazine(0, 5) }), item({ energySource: battery(0, 10) })],
    updateEmbeddedDocuments: async (...args) => writes.push(args) };
  await restore(actor);
  assert.equal(writes.length, 0);
  await restore(actor, { repairItems: true });
  assert.equal(healing, 2);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "Item");
  assert.equal(writes[0][1].length, 2);
});
