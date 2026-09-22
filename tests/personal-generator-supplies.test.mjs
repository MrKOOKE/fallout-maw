import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getPersonalGeneratorSupplies } from "../src/utils/personal-generator-supplies.mjs";

const item = (id, functions) => ({ uuid: `Item.${id}`, system: { functions } });
const ammo = item("ammo", { damageSource: { enabled: true } });
const ap = item("ap", { damageSource: { enabled: true } });
const grenade = item("grenade", { damageSource: { enabled: true } });
const battery = item("battery", { energySource: { enabled: true } });
const cell = item("cell", { energySource: { enabled: true } });
const weapon = item("gun", {
  weapon: { enabled: true, magazine: { sourceItemUuid: ammo.uuid, sourceItemUuids: [ammo.uuid, ap.uuid] } },
  additionalWeapons: { launcher: { enabled: true, magazine: { sourceItemUuid: grenade.uuid } } },
  energyConsumer: { enabled: true, sourceItemUuids: [battery.uuid, cell.uuid], sourceItemUuid: battery.uuid,
    activeSourceUuid: battery.uuid, installedSource: { sourceItemUuid: battery.uuid } }
});
const resolve = uuid => [ammo, ap, grenade, battery, cell, weapon].find(entry => entry.uuid === uuid);
const supplies = (items, existing = []) => getPersonalGeneratorSupplies(items, existing, resolve);

test("all ammo variants, additional weapon ammo and energy sources are included once", () => {
  assert.deepEqual(supplies([weapon]), [ammo, ap, grenade, battery, cell]);
});

test("batch drops share supplies and avoid those already in the block or dropped folder", () => {
  assert.deepEqual(supplies([weapon, structuredClone(weapon), ammo], [{ uuid: battery.uuid }]), [ap, grenade, cell]);
});

test("disabled functions, stale references and unrelated item types are ignored", () => {
  const disabled = structuredClone(weapon);
  disabled.system.functions.weapon.enabled = false;
  disabled.system.functions.energyConsumer.enabled = false;
  disabled.system.functions.additionalWeapons.launcher.magazine.sourceItemUuid = "Item.deleted";
  assert.deepEqual(supplies([disabled]), []);
  disabled.system.functions.additionalWeapons.launcher.magazine.sourceItemUuid = battery.uuid;
  assert.deepEqual(supplies([disabled]), []);
});

test("ordinary drops add only the item; Shift adds supplies with a single save and render", async () => {
  const source = readFileSync(new URL("../src/apps/personal-generator.mjs", import.meta.url), "utf8");
  const body = source.match(/  async #onDropItem\([^]*?\n  \}/)[0]
    .replace("async #onDropItem", "async function drop").replaceAll("#", "");
  const deps = { PERSONAL_GENERATOR_DROPZONE_SELECTOR: "[data-pg-block-drop]", getRowIndex: () => 0,
    createAbilityEntryFromDropData: () => null, resolveItemDocumentsFromDrop: async () => [weapon],
    getPersonalGeneratorSupplies: supplies, createItemEntryFromItem: entry => ({ uuid: entry.uuid }) };
  const drop = new Function(...Object.keys(deps), `${body}; return drop;`)(...Object.values(deps));
  for (const shiftKey of [false, true]) {
    const entries = [];
    let saves = 0;
    let renders = 0;
    const app = { resolveInternalEntryDropData: () => null, clearDropzoneHighlight() {}, resetEntryVisualState() {},
      getItemBlockElementForDrop: () => ({}), getDragEventData: () => ({ type: "Item" }),
      readConfigFromForm: () => ({ items: { blocks: [{ entries }] } }),
      saveCurrentConfig: async () => { saves++; }, render: () => { renders++; } };
    await drop.call(app, { shiftKey, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(entries.map(entry => entry.uuid), (shiftKey ? [weapon, ammo, ap, grenade, battery, cell] : [weapon]).map(entry => entry.uuid));
    assert.equal(saves, 1);
    assert.equal(renders, 1);
  }
});
