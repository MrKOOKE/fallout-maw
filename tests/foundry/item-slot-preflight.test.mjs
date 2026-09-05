import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const core = process.env.FALLOUT_MAW_FOUNDRY_CORE;

test("native Item preflight reuses settings and still cleans slot requirements", { skip: !core }, async t => {
  await import(pathToFileURL(path.join(core, "common/server.mjs")));
  foundry.applications = {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: async () => "" }
  };
  let creatures = {
    types: [{ id: "organic", name: "Organic" }],
    races: [{
      id: "human", name: "Human", typeId: "organic",
      limbs: [{ key: "rightArm", label: "Right arm" }],
      equipmentSlots: [{ key: "body", label: "Body" }],
      weaponSets: [{ key: "hands", slots: [{ key: "rightHand", limbKey: "rightArm" }] }]
    }]
  };
  let normalizations = 0;
  globalThis.game = {
    release: { version: "14.361" },
    settings: { get: (_scope, key) => {
      if (key !== "creatureOptions") return {};
      normalizations += 1;
      return creatures;
    } },
    i18n: { localize: value => value, format: value => value },
    system: {
      id: "fallout-maw", version: "0.2.1", grid: { type: 1, distance: 1, units: "m" },
      documentTypes: { Actor: { character: {} }, Item: { gear: {} } }
    },
    model: { Actor: { character: {} }, Item: { gear: {} }, ActiveEffect: { base: {} } }
  };
  globalThis.Item = foundry.documents.BaseItem;
  const models = await import("../../src/data/models/item-data-models.mjs");
  globalThis.CONFIG = {
    Actor: { documentClass: foundry.documents.BaseActor, dataModels: {} },
    Item: { documentClass: foundry.documents.BaseItem, dataModels: { gear: models.GearDataModel } },
    ActiveEffect: { documentClass: foundry.documents.BaseActiveEffect, dataModels: {} },
    Folder: {}, DatabaseBackend: { getFlagScopes: () => ["core", "fallout-maw"] }
  };
  const { FalloutMaWItem } = await import("../../src/documents/item.mjs");
  CONFIG.Item.documentClass = FalloutMaWItem;
  const { getPreparedRuntimeSettings, invalidatePreparedRuntimeSettingsCache } = await import(
    "../../src/settings/accessors.mjs"
  );
  const { getEquipmentSlotSelectionKey } = await import("../../src/utils/equipment-slots.mjs");
  const bodyKey = getEquipmentSlotSelectionKey("Body");
  const create = (system = {}) => new FalloutMaWItem({
    _id: "0000000000000001", name: "Unsaved slot fixture", type: "gear", system
  });
  const preflight = (item, changes, options = {}) => item._preUpdate(changes, options, { id: "fixture" });

  await t.test("durability changes keep valid slots and remove stale slots without normalizing race data again", async () => {
    invalidatePreparedRuntimeSettingsCache();
    getPreparedRuntimeSettings();
    const baseline = normalizations;
    const item = create({
      occupiedSlots: { [bodyKey]: true, obsolete: true, unchecked: false },
      weaponSlotRequirement: { slots: { "limb:rightArm": true, obsolete: true } },
      functions: { condition: { enabled: true, value: 100 } }
    });
    const before = item.toObject();
    for (let index = 0; index < 5; index += 1) {
      const changes = { "system.functions.condition.value": 90 - index };
      assert.equal(await preflight(item, changes), undefined);
      assert.equal(changes["system.occupiedSlots.obsolete"], globalThis._del);
      assert.equal(changes["system.occupiedSlots.unchecked"], globalThis._del);
      assert.equal(changes["system.weaponSlotRequirement.slots.obsolete"], globalThis._del);
      assert.equal(Object.hasOwn(changes, `system.occupiedSlots.${bodyKey}`), false);
      assert.equal(Object.hasOwn(changes, "system.weaponSlotRequirement.slots.limb:rightArm"), false);
      assert.equal(changes["system.functions.condition.value"], 90 - index);
    }
    assert.equal(normalizations, baseline);
    assert.deepEqual(item.toObject(), before, "preflight does not mutate Item source");
  });

  await t.test("nested slot edits are cleaned against current settings", async () => {
    const item = create();
    const changes = { system: {
      occupiedSlots: { [bodyKey]: true, unknown: true },
      weaponSlotRequirement: { slots: { "limb:rightArm": true, unknown: true } }
    } };
    await preflight(item, changes);
    assert.equal(changes["system.occupiedSlots.unknown"], globalThis._del);
    assert.equal(changes["system.weaponSlotRequirement.slots.unknown"], globalThis._del);
    assert.equal(changes.system.occupiedSlots[bodyKey], true);
    assert.equal(changes.system.weaponSlotRequirement.slots["limb:rightArm"], true);
  });

  await t.test("a settings change invalidates slot validity even on an unrelated Item edit", async () => {
    const item = create({ occupiedSlots: { [bodyKey]: true } });
    const before = normalizations;
    creatures = { ...creatures, races: creatures.races.map(race => ({ ...race, equipmentSlots: [] })) };
    invalidatePreparedRuntimeSettingsCache();
    const changes = { name: "Renamed" };
    await preflight(item, changes);
    assert.equal(changes[`system.occupiedSlots.${bodyKey}`], globalThis._del);
    assert.equal(normalizations, before + 1);
  });

  await t.test("empty requirement records do not request a race snapshot", async () => {
    const item = create();
    invalidatePreparedRuntimeSettingsCache();
    const before = normalizations;
    const changes = { "system.functions.condition.value": 80 };
    await preflight(item, changes, { falloutMawSkipConsciousnessRecovery: true });
    assert.equal(normalizations, before);
    assert.deepEqual(changes, { "system.functions.condition.value": 80 });
  });
});
