import assert from "node:assert/strict";
import test from "node:test";

class ApplicationV2 {}
const getProperty = (object, path) => String(path).split(".").reduce((value, key) => value?.[key], object);
globalThis.foundry = {
  applications: {
    api: { ApplicationV2, DialogV2: class {}, HandlebarsApplicationMixin: Base => class extends Base {} },
    apps: { FilePicker: { implementation: class {} } },
    sheets: { ActorSheetV2: class {}, ItemSheetV2: class {} },
    ux: { FormDataExtended: class {}, TextEditor: { implementation: {} } },
    handlebars: { renderTemplate: async () => "" }
  },
  canvas: { placeables: { Token: class {} } },
  utils: {
    deepClone: structuredClone,
    flattenObject: value => value,
    getProperty,
    mergeObject: (original, other) => ({ ...original, ...other }),
    randomID: () => "test-id",
    setProperty(object, path, value) {
      const keys = String(path).split(".");
      const last = keys.pop();
      for (const key of keys) object = object[key] ??= {};
      object[last] = value;
      return true;
    }
  }
};
globalThis.Actor = class {};
globalThis.Item = class {};
globalThis.ActiveEffect = class {};
globalThis.Application = ApplicationV2;
globalThis.CONFIG = {};
globalThis.Hooks = { on() {}, off() {}, callAll() {} };
globalThis.canvas = { tokens: { placeables: [] }, scene: null };
globalThis.fromUuidSync = () => null;
globalThis._del = Symbol("delete");
const creatureOptions = {
  types: [{ id: "organic", name: "Organic" }],
  races: [{
    id: "human", name: "Human", typeId: "organic",
    limbs: [{ key: "rightArm", label: "Right arm" }, { key: "leftArm", label: "Left arm" }],
    weaponSets: [{ key: "hands", label: "Hands", slots: [
      { key: "rightHand", limbKey: "rightArm" },
      { key: "leftHand", limbKey: "leftArm" }
    ] }]
  }]
};
globalThis.game = {
  settings: { get: (_scope, key) => {
    if (key === "creatureOptions") return creatureOptions;
    throw new Error("use defaults");
  } },
  i18n: { localize: key => key, format: key => key },
  user: { isGM: true, isActiveGM: true },
  users: [], actors: [], time: { worldTime: 0 }, combat: null
};

const { getCreatureOptions } = await import("../src/settings/accessors.mjs");
const { getLimbHealingCap } = await import("../src/combat/damage-hub.mjs");
const { isWeaponPlacementDisabled } = await import("../src/combat/weapon-attack-controller.mjs");
const { prepareHudWeaponSetsContext } = await import("../src/utils/actor-display-data.mjs");
const { getHudWeaponSetsForActor, getActiveHudWeaponHostItemIds } = await import("../src/utils/hud-active-items.mjs");
const { getWeaponSlotSelectionKey } = await import("../src/utils/equipment-slots.mjs");

function createFixture({ twoHanded = false } = {}) {
  const race = getCreatureOptions().races.find(entry => entry.limbs.some(limb => limb.key === "rightArm"));
  const set = race.weaponSets.find(entry => entry.slots.filter(slot => slot.limbKey).length >= 2);
  assert.ok(set, "fixture needs the configured humanoid hand slots");
  const [primary, secondary] = set.slots;
  const prosthesis = {
    id: "prosthesis", type: "gear", name: "Prosthetic arm",
    system: {
      equipped: true, quantity: 1, weight: 0, price: 0,
      placement: { mode: "prosthesis", limbKey: primary.limbKey },
      functions: {
        prosthesis: { enabled: true, integrationPercent: 0 },
        condition: { enabled: true, value: 100, max: 100 }
      }
    }
  };
  const weapon = {
    id: "weapon", type: "gear", name: "Test weapon",
    system: {
      equipped: true, quantity: 1, weight: 0, price: 0,
      placement: { mode: "weapon", weaponSet: set.key, weaponSlot: primary.key },
      weaponSlotRequirement: {
        mode: twoHanded ? "all" : "oneOf",
        slots: Object.fromEntries((twoHanded ? [primary, secondary] : [primary])
          .map(slot => [getWeaponSlotSelectionKey(slot), true]))
      },
      functions: { weapon: { enabled: true } }
    }
  };
  const contents = [weapon, prosthesis];
  const actor = {
    id: "prosthetic-limb-test", uuid: "Actor.prosthetic-limb-test", type: "character",
    items: {
      contents,
      get: id => contents.find(item => item.id === id),
      *[Symbol.iterator]() { yield* contents; },
      *values() { yield* contents; }
    },
    effects: [],
    getFlag: () => "",
    system: {
      creature: { raceId: race.id }, trade: {},
      limbs: Object.fromEntries(race.limbs.map(limb => [limb.key, {
        ...limb, min: -100, max: 100,
        missing: limb.key === primary.limbKey,
        value: limb.key === primary.limbKey ? -100 : 100
      }]))
    }
  };
  for (const item of contents) item.actor = actor;
  return { actor, race, set, primary, secondary, weapon, prosthesis };
}

function assertAvailability(fixture, expected) {
  const { actor, race, set, weapon } = fixture;
  assert.equal(isWeaponPlacementDisabled(actor, weapon), !expected, "combat authority availability");
  const { weaponSets } = prepareHudWeaponSetsContext(actor, race);
  const occupied = weaponSets.find(entry => entry.key === set.key).slots.filter(slot => slot.item?.id === weapon.id);
  assert.ok(occupied.length);
  for (const slot of occupied) {
    assert.equal(slot.useDisabled, !expected, "sheet/HUD slot availability");
    assert.equal(slot.item.useDisabled, !expected, "sheet/HUD item availability");
  }
}

test("a functional prosthesis replaces a missing arm for weapons at every integration level", () => {
  const fixture = createFixture();
  for (const integration of [0, 50, 100]) {
    fixture.prosthesis.system.functions.prosthesis.integrationPercent = integration;
    assert.equal(getLimbHealingCap(fixture.actor, fixture.primary.limbKey), 0, "prostheses remain non-medical targets");
    assertAvailability(fixture, true);
  }
});

test("a two-handed weapon accepts a prosthetic hand and still requires the other hand", () => {
  const fixture = createFixture({ twoHanded: true });
  assertAvailability(fixture, true);
  fixture.actor.system.limbs[fixture.secondary.limbKey].missing = true;
  assertAvailability(fixture, false);
});

test("prosthesis condition and installation determine whether the replaced limb can be used", () => {
  const fixture = createFixture();
  const system = fixture.prosthesis.system;
  system.functions.condition.value = 1;
  assertAvailability(fixture, true);
  system.functions.condition.value = 0;
  assertAvailability(fixture, false);
  system.functions.condition.enabled = false;
  assertAvailability(fixture, true);
  system.equipped = false;
  assertAvailability(fixture, false);
  system.equipped = true;
  system.placement.mode = "inventory";
  assertAvailability(fixture, false);
  system.placement.mode = "prosthesis";
  system.placement.limbKey = fixture.secondary.limbKey;
  assertAvailability(fixture, false);
  system.placement.limbKey = fixture.primary.limbKey;
  system.functions.prosthesis.enabled = false;
  assertAvailability(fixture, false);
});

test("organic limb trauma restrictions remain active and do not disable its prosthetic replacement", () => {
  const fixture = createFixture();
  const limb = fixture.actor.system.limbs[fixture.primary.limbKey];
  limb.missing = false;
  fixture.prosthesis.system.equipped = false;
  assertAvailability(fixture, true);
  fixture.actor.items.contents.push({
    id: "crippling-trauma", type: "trauma",
    system: { limbKey: fixture.primary.limbKey, thresholdPercent: 0 }
  });
  assertAvailability(fixture, false);
  fixture.prosthesis.system.equipped = true;
  limb.missing = true;
  assertAvailability(fixture, true);
});

test("cached HUD availability refreshes when an installed prosthesis breaks or is repaired", () => {
  const fixture = createFixture();
  const { actor, set, weapon, prosthesis } = fixture;
  const first = getHudWeaponSetsForActor(actor);
  assert.equal(getHudWeaponSetsForActor(actor), first);
  const active = () => getActiveHudWeaponHostItemIds(actor, {
    weaponSet: getHudWeaponSetsForActor(actor).find(entry => entry.key === set.key)
  }).has(weapon.id);
  assert.equal(active(), true);
  prosthesis.system.functions.condition.value = 0;
  assert.notEqual(getHudWeaponSetsForActor(actor), first);
  assert.equal(active(), false);
  prosthesis.system.functions.condition.value = 25;
  assert.equal(active(), true);
});
