import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const core = process.env.FALLOUT_MAW_FOUNDRY_CORE;

test("HUD membership and inventory repair use the current prepared race snapshot", { skip: !core }, async t => {
  await import(pathToFileURL(path.join(core, "common/server.mjs")));
  foundry.applications = {
    api: { DialogV2: class {} }, ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: async () => "" }
  };
  const createCreatures = (label, columns) => ({
    types: [{ id: "organic", name: "Organic" }],
    races: [{
      id: "human", name: "Human", typeId: "organic",
      limbs: [{ key: "rightArm", label: "Right arm" }],
      inventorySize: { columns, rows: 2 },
      weaponSets: [{ key: "hands", label, slots: [{ key: "rightHand", limbKey: "rightArm" }] }]
    }]
  });
  let creatures = createCreatures("Original set", 4);
  let normalizations = 0;
  globalThis.game = {
    release: { version: "14.361" },
    settings: { get: (_scope, key) => {
      if (key !== "creatureOptions") return {};
      normalizations += 1;
      return creatures;
    } },
    i18n: { localize: value => value, format: value => value },
    system: { id: "fallout-maw", version: "0.2.1", grid: { type: 1, distance: 1, units: "m" } }
  };
  globalThis.CONFIG = { Item: {}, Actor: {}, ActiveEffect: {} };
  const { getPreparedRuntimeSettings, invalidatePreparedRuntimeSettingsCache } = await import(
    "../../src/settings/accessors.mjs"
  );
  const { getHudWeaponSetsForActor } = await import("../../src/utils/hud-active-items.mjs");
  const { repairActorInventory } = await import("../../src/inventory/migration.mjs");
  const createActor = () => {
    const items = [];
    items.contents = items;
    return {
      id: "fixture", uuid: "Actor.fixture", documentName: "Actor", type: "character", items,
      system: { creature: { raceId: "human" }, limbs: { rightArm: { value: 10, max: 10 } } },
      effects: [], getFlag: () => "", getActiveTokens: () => [],
      updateEmbeddedDocuments: () => { throw new Error("This test must not write documents"); }
    };
  };
  const freeze = value => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };

  await t.test("HUD rebuilds across Actors and changed limbs share normalized settings", () => {
    invalidatePreparedRuntimeSettingsCache();
    const snapshot = getPreparedRuntimeSettings();
    freeze(snapshot.creatureOptions);
    const before = normalizations;
    const actor = createActor();
    const first = getHudWeaponSetsForActor(actor);
    assert.equal(first.find(set => set.key === "hands").label, "Original set");
    assert.equal(getHudWeaponSetsForActor(actor), first);
    actor.system.limbs.rightArm.missing = true;
    assert.notEqual(getHudWeaponSetsForActor(actor), first, "Actor-dependent membership still invalidates");
    assert.notEqual(getHudWeaponSetsForActor(createActor()), first, "different Actors do not share mutable HUD rows");
    assert.equal(normalizations, before);
    assert.equal(snapshot.creatureOptions.races[0].weaponSets[0].label, "Original set");
  });

  await t.test("settings invalidation refreshes a HUD even if the Actor signature is unchanged", () => {
    const actor = createActor();
    const first = getHudWeaponSetsForActor(actor);
    const before = normalizations;
    creatures = createCreatures("Changed set", 7);
    invalidatePreparedRuntimeSettingsCache();
    const next = getHudWeaponSetsForActor(actor);
    assert.notEqual(next, first);
    assert.equal(next.find(set => set.key === "hands").label, "Changed set");
    assert.equal(first.find(set => set.key === "hands").label, "Original set");
    assert.equal(normalizations, before + 1);
    assert.equal(getHudWeaponSetsForActor(actor), next);
  });

  await t.test("repair uses the shared race and observes its new inventory dimensions", async () => {
    const snapshot = getPreparedRuntimeSettings();
    freeze(snapshot.creatureOptions);
    const actor = createActor();
    const before = normalizations;
    for (let index = 0; index < 3; index += 1) {
      const result = await repairActorInventory(actor, { render: false });
      assert.equal(result.changed, false);
      assert.equal(result.lockedStorage.columns, 7);
    }
    assert.equal(normalizations, before);
    creatures = createCreatures("Final set", 9);
    invalidatePreparedRuntimeSettingsCache();
    const next = await repairActorInventory(actor, { render: false });
    assert.equal(next.changed, false);
    assert.equal(next.lockedStorage.columns, 9);
    assert.equal(normalizations, before + 1);
    assert.equal(snapshot.creatureOptions.races[0].inventorySize.columns, 7);
  });

  await t.test("an explicitly supplied repair race remains authoritative", async () => {
    invalidatePreparedRuntimeSettingsCache();
    const before = normalizations;
    const race = { inventorySize: { columns: 13, rows: 1 } };
    freeze(race);
    const result = await repairActorInventory(createActor(), { race, render: false });
    assert.equal(result.changed, false);
    assert.equal(result.lockedStorage.columns, 13);
    assert.equal(normalizations, before);
  });
});
