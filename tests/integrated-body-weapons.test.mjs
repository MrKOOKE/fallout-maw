import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getDeployedWeaponSetKey,
  isInstalledBodyWeapon
} from "../src/utils/item-functions.mjs";

function createBodyItem({ mode = "prosthesis", bodyEnabled = true, weaponEnabled = true } = {}) {
  return {
    id: `${mode}-item`,
    system: {
      equipped: true,
      placement: { mode },
      functions: {
        implant: { enabled: mode === "implant" && bodyEnabled },
        prosthesis: { enabled: mode === "prosthesis" && bodyEnabled },
        weapon: { enabled: weaponEnabled }
      }
    }
  };
}

test("only installed prostheses and implants with a weapon function are integrated body weapons", () => {
  assert.equal(isInstalledBodyWeapon(createBodyItem({ mode: "prosthesis" })), true);
  assert.equal(isInstalledBodyWeapon(createBodyItem({ mode: "implant" })), true);
  assert.equal(isInstalledBodyWeapon(createBodyItem({ mode: "inventory" })), false);
  assert.equal(isInstalledBodyWeapon(createBodyItem({ bodyEnabled: false })), false);
  assert.equal(isInstalledBodyWeapon(createBodyItem({ weaponEnabled: false })), false);
  const unequipped = createBodyItem();
  unequipped.system.equipped = false;
  assert.equal(isInstalledBodyWeapon(unequipped), false);
});

test("installed body weapons participate in combat as members of the natural set", () => {
  assert.equal(getDeployedWeaponSetKey(createBodyItem({ mode: "prosthesis" })), "naturalRaceWeapons");
  assert.equal(getDeployedWeaponSetKey(createBodyItem({ mode: "implant" })), "naturalRaceWeapons");
  assert.equal(getDeployedWeaponSetKey({
    system: {
      placement: { mode: "weapon", weaponSet: "primary" },
      functions: { weapon: { enabled: true } }
    }
  }), "primary");
  assert.equal(getDeployedWeaponSetKey(createBodyItem({ weaponEnabled: false })), "");
});

test("the shared sheet and HUD context appends body weapons to the natural set by source Item id", async () => {
  installFoundryGlobals();
  const { prepareHudWeaponSetsContext } = await import("../src/utils/actor-display-data.mjs");
  const bodyWeapon = {
    ...createBodyItem({ mode: "implant" }),
    uuid: "Actor.test.Item.implant-item",
    name: "Arm Cannon",
    img: "arm-cannon.webp",
    type: "gear",
    system: {
      ...createBodyItem({ mode: "implant" }).system,
      quantity: 1,
      maxStack: 1,
      weight: 2,
      price: 0,
      container: { parentId: "" },
      placement: {
        mode: "implant",
        limbKey: "arm",
        x: 1,
        y: 1,
        width: 1,
        height: 1
      }
    }
  };
  const naturalWeapon = {
    id: "bite-item",
    uuid: "Actor.test.Item.bite-item",
    name: "Bite",
    img: "bite.webp",
    type: "gear",
    flags: {
      "fallout-maw": {
        naturalRaceItem: { kind: "weapon", sourceId: "bite" }
      }
    },
    system: {
      quantity: 1,
      weight: 0,
      price: 0,
      container: { parentId: "" },
      placement: { mode: "weapon", weaponSet: "naturalRaceWeapons", weaponSlot: "bite" },
      functions: { weapon: { enabled: true } }
    }
  };
  const contents = [naturalWeapon, bodyWeapon];
  const items = {
    contents,
    get: id => contents.find(item => item.id === id) ?? null,
    *[Symbol.iterator]() { yield* contents; },
    *values() { yield* contents; }
  };
  const actor = {
    type: "character",
    uuid: "Actor.test",
    items,
    system: {
      creature: { subtypeId: "default" },
      limbs: { arm: { label: "Arm" } },
      trade: {}
    },
    getFlag: () => ""
  };
  for (const item of contents) item.actor = actor;
  const bodyPlacement = structuredClone(bodyWeapon.system.placement);
  const race = {
    limbs: [],
    weaponSets: [],
    naturalItemSets: [{
      id: "default",
      label: "Natural",
      naturalWeapons: [{ id: "bite", item: { name: "Bite" } }]
    }]
  };

  const { naturalWeaponSet } = prepareHudWeaponSetsContext(actor, race);

  assert.deepEqual(naturalWeaponSet.slots.map(slot => slot.item?.id), ["bite-item", "implant-item"]);
  assert.equal(naturalWeaponSet.slots[1].integratedBodyWeapon, true);
  assert.equal(naturalWeaponSet.slots[1].canReplace, false);
  assert.equal(actor.items.get(naturalWeaponSet.slots[1].item.id), bodyWeapon);
  assert.deepEqual(bodyWeapon.system.placement, bodyPlacement, "projection must not rewrite implant placement");
});

test("integrated body weapons reuse the source Item and expose no removal or replacement path", async () => {
  const [
    displaySource,
    naturalSource,
    template,
    sheetSource,
    hudSource,
    cacheSource,
    abilityActionSource,
    fixedAbilitySource
  ] = await Promise.all([
    readFile(new URL("../src/utils/actor-display-data.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/races/natural-items.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/actor/parts/inventory-tab.hbs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/utils/hud-active-items.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/ability-actions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8")
  ]);

  assert.match(displaySource, /isInstalledBodyWeapon\(item\)[\s\S]*?integratedBodyWeapon:\s*true[\s\S]*?canReplace:\s*false[\s\S]*?item:\s*displayItem/);
  assert.match(displaySource, /getNaturalWeaponSetContext\(actor, race, currencies, \{ additionalSlots: integratedBodyWeaponSlots \}\)/);
  assert.match(naturalSource, /slots\.push\(\.\.\.\(Array\.isArray\(additionalSlots\) \? additionalSlots : \[\]\)\)/);
  assert.match(template, /data-integrated-body-weapon-projection/);
  assert.match(sheetSource, /fixedWeaponProjection:\s*itemElement\.hasAttribute\("data-integrated-body-weapon-projection"\)/);
  assert.match(sheetSource, /isNaturalRaceWeapon\(item\) \|\| fixedWeaponProjection/);
  assert.match(hudSource, /selectedWeaponSlot\.canReplace !== false/);
  assert.match(hudSource, /if \(!canReplaceHudWeaponSlot\(actor, weaponSetKey, weaponSlotKey, itemId\)\) return undefined/);
  assert.match(hudSource, /if \(!slot \|\| slot\.canReplace === false\) return false/);
  assert.match(cacheSource, /system\.functions\?\.\[placement\.mode\]\?\.enabled/);
  assert.match(cacheSource, /system\.functions\?\.weapon\?\.enabled/);
  assert.match(abilityActionSource, /weapon\?\.type !== "gear" \|\| !getDeployedWeaponSetKey\(weapon\)/);
  assert.ok(
    (fixedAbilitySource.match(/getDeployedWeaponSetKey\(weapon\)/g) ?? []).length >= 6,
    "special weapon abilities must use the same deployed-weapon rule"
  );
});

function installFoundryGlobals() {
  const getProperty = (object, path) => String(path).split(".").reduce((value, key) => value?.[key], object);
  globalThis.foundry = {
    applications: {
      api: { DialogV2: class DialogV2 {} },
      ux: { FormDataExtended: class FormDataExtended {} },
      handlebars: { renderTemplate: async () => "" }
    },
    utils: {
      deepClone: structuredClone,
      flattenObject: value => value,
      getProperty,
      mergeObject: (original, other) => ({ ...original, ...other }),
      randomID: () => "test-id",
      setProperty(object, path, value) {
        const parts = String(path).split(".");
        const finalKey = parts.pop();
        let target = object;
        for (const key of parts) target = target[key] ??= {};
        target[finalKey] = value;
        return true;
      }
    }
  };
  globalThis.game = {
    settings: { get: () => { throw new Error("use defaults"); } },
    i18n: { localize: key => key, format: key => key },
    user: { isGM: true, isActiveGM: true },
    users: [],
    actors: [],
    time: { worldTime: 0 },
    combat: null
  };
  globalThis.canvas = { tokens: { placeables: [] }, scene: null };
  globalThis.Hooks = { on: () => undefined, callAll: () => undefined };
  globalThis.CONFIG = {};
  globalThis.fromUuidSync = () => null;
  globalThis._del = Symbol("delete");
}
