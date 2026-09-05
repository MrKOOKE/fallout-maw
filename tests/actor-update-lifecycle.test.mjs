import assert from "node:assert/strict";
import test from "node:test";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function flattenObject(value, prefix = "", output = {}) {
  for (const [key, entry] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(entry) && Object.keys(entry).length) flattenObject(entry, path, output);
    else output[path] = entry;
  }
  return output;
}

function getProperty(object, path) {
  let current = object;
  for (const segment of String(path).split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function hasProperty(object, path) {
  return getProperty(object, path) !== undefined;
}

function setProperty(object, path, value) {
  const segments = String(path).split(".");
  const leaf = segments.pop();
  let current = object;
  for (const segment of segments) {
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[leaf] = value;
  return true;
}

let settingReads = 0;
const settingValues = new Map();
globalThis.game = {
  settings: {
    get(_namespace, key) {
      settingReads += 1;
      return settingValues.get(key);
    }
  }
};
globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: structuredClone,
    flattenObject,
    getProperty,
    hasProperty,
    mergeObject: (base, update) => ({ ...base, ...update }),
    randomID: () => "test-id",
    setProperty
  }
};

const {
  captureDocumentSnapshot,
  classifyActorUpdate
} = await import("../src/events/foundry-document-events.mjs");
const {
  getAbilityCatalog,
  getActorNeedSettings,
  getCreatureOptions,
  invalidateAbilityCatalogCache,
  invalidatePreparedRuntimeSettingsCache,
  getPreparedRuntimeSettings,
  refreshPreparedActorsAfterSkillSettingsChange,
  syncSettingsIntoSystemConfig
} = await import("../src/settings/accessors.mjs");
const { buildActorFormulaData } = await import("../src/utils/actor-formulas.mjs");
const { prepareActorOrganismDevelopmentLimitBase } = await import("../src/races/organism-development.mjs");
const {
  isInventoryRelevantActorUpdate
} = await import("../src/inventory/migration.mjs");
const {
  syncTrackedResourceValueUpdates
} = await import("../src/documents/actor-resource-updates.mjs");

test("runtime limb damage does not request a structural inventory repair", () => {
  assert.equal(isInventoryRelevantActorUpdate({
    "system.limbs.arm.spent": 20,
    "system.limbs.arm.damageAccumulation": { firearm: 20 }
  }), false);
  assert.equal(isInventoryRelevantActorUpdate({
    system: {
      limbs: {
        arm: {
          value: 80,
          spent: 20,
          damageAccumulation: { firearm: 20 }
        }
      }
    }
  }), false);

  assert.equal(isInventoryRelevantActorUpdate({ "system.limbs.arm.missing": true }), true);
  assert.equal(isInventoryRelevantActorUpdate({ "system.limbs.-=arm": null }), true);
  assert.equal(isInventoryRelevantActorUpdate({ "system.inventory.columnsBonus": 1 }), true);
  assert.equal(isInventoryRelevantActorUpdate({
    "system.limbs.arm.spent": 20,
    "system.limbs.arm.missing": true
  }), true);
});

test("unrelated Actor updates do not manufacture resource changes", () => {
  const actor = {
    system: {
      resources: {
        health: { min: 0, value: 80, max: 100, spent: 20 },
        actionPoints: { min: 0, value: 8, max: 10, spent: 2 },
        dodge: { min: 0, value: 4, max: 6, spent: 2 }
      }
    }
  };
  const limbChanges = {
    "system.limbs.arm.spent": 20,
    "system.limbs.arm.damageAccumulation": { firearm: 20 }
  };

  syncTrackedResourceValueUpdates(actor, limbChanges);
  assert.deepEqual(Object.keys(flattenObject(limbChanges)).sort(), [
    "system.limbs.arm.damageAccumulation.firearm",
    "system.limbs.arm.spent"
  ]);

  const resourceChanges = { "system.resources.actionPoints.value": 4 };
  syncTrackedResourceValueUpdates(actor, resourceChanges);
  assert.equal(getProperty(resourceChanges, "system.resources.actionPoints.spent"), 6);
  assert.equal(getProperty(resourceChanges, "system.resources.dodge.spent"), undefined);
});

test("document events reuse one detached snapshot and still isolate focused payloads", () => {
  const detached = {
    system: {
      limbs: {
        arm: {
          spent: 10,
          damageAccumulation: { firearm: 10 },
          tags: ["original"]
        }
      }
    }
  };
  const actor = {
    id: "actor-1",
    uuid: "Actor.actor-1",
    documentName: "Actor",
    type: "character",
    statuses: new Set(),
    toObject: () => detached
  };
  const before = captureDocumentSnapshot(actor);
  assert.equal(before.source, detached);

  const after = {
    source: {
      system: {
        limbs: {
          arm: {
            spent: 25,
            damageAccumulation: { firearm: 25 },
            tags: ["changed"]
          }
        }
      }
    },
    meta: { uuid: actor.uuid, documentName: "Actor", statuses: [] }
  };

  const nativeStructuredClone = globalThis.structuredClone;
  let wrapperCloneCount = 0;
  globalThis.structuredClone = value => {
    if (value && Object.hasOwn(value, "source") && Object.hasOwn(value, "meta")) wrapperCloneCount += 1;
    return nativeStructuredClone(value);
  };

  try {
    const [event] = classifyActorUpdate(actor, {
      "system.limbs.arm.spent": 25,
      "system.limbs.arm.damageAccumulation": { firearm: 25 },
      "system.limbs.arm.tags": ["changed"]
    }, { before, after });

    assert.equal(wrapperCloneCount, 0);
    assert.deepEqual(event.data.changedPaths, [
      "system.limbs.arm.damageAccumulation.firearm",
      "system.limbs.arm.spent",
      "system.limbs.arm.tags"
    ]);
    assert.equal(event.before["system.limbs.arm.damageAccumulation.firearm"], 10);
    assert.equal(event.after["system.limbs.arm.damageAccumulation.firearm"], 25);

    event.before["system.limbs.arm.tags"].push("mutated");
    assert.deepEqual(before.source.system.limbs.arm.tags, ["original"]);
  } finally {
    globalThis.structuredClone = nativeStructuredClone;
  }
});

test("prepared runtime settings normalize once until Foundry settings refresh", () => {
  invalidatePreparedRuntimeSettingsCache();
  const readsBefore = settingReads;
  const first = getPreparedRuntimeSettings();
  const readsAfterBuild = settingReads;
  const second = getPreparedRuntimeSettings();

  assert.ok(readsAfterBuild > readsBefore);
  assert.equal(second, first);
  assert.equal(settingReads, readsAfterBuild);
  assert.equal(Object.isFrozen(first), true);

  syncSettingsIntoSystemConfig();
  const third = getPreparedRuntimeSettings();
  assert.notEqual(third, first);
  assert.ok(settingReads > readsAfterBuild);
});

test("skill settings refresh invalidates a cached default ability catalog", () => {
  const catalogSource = { categories: [] };
  settingValues.set("abilitiesCatalog", catalogSource);
  settingValues.set("skillSettings", {
    entries: [{ key: "oldSkill", label: "Старый навык", formula: "0" }]
  });
  invalidateAbilityCatalogCache();

  try {
    const first = getAbilityCatalog();
    assert.ok(first.categories.some(category => category.id === "skill-oldSkill"));

    settingValues.set("skillSettings", {
      entries: [{ key: "newSkill", label: "Новый навык", formula: "0" }]
    });
    assert.equal(getAbilityCatalog(), first, "the catalog source identity alone keeps the cached fallback");

    refreshPreparedActorsAfterSkillSettingsChange();
    const refreshed = getAbilityCatalog();
    assert.notEqual(refreshed, first);
    assert.equal(refreshed.categories.some(category => category.id === "skill-oldSkill"), false);
    assert.ok(refreshed.categories.some(category => (
      category.id === "skill-newSkill" && category.name === "Новый навык"
    )));
  } finally {
    settingValues.clear();
    invalidateAbilityCatalogCache();
  }
});

test("Actor base and effect formulas reuse settings while keeping live Actor and construct values", () => {
  const races = [
    { id: "race-a", organismDevelopment: { limit: 41 }, needSettings: [{ key: "fuel", label: "First race", abbr: "fa", formula: "10" }] },
    { id: "race-b", organismDevelopment: { limit: 72 }, needSettings: [{ key: "fuel", label: "Second race", abbr: "fb", formula: "20" }] }
  ];
  settingValues.set("creatureOptions", { types: [], races });
  invalidatePreparedRuntimeSettingsCache();
  try {
    const settings = getPreparedRuntimeSettings();
    const settingsBefore = structuredClone(settings);
    const readsBefore = settingReads;
    const actor = { type: "character", system: {
      creature: { raceId: "race-b" }, characteristics: { strength: 4 },
      skills: { rangedCombat: { value: 17 } }, needs: { fuel: { value: 3 } }
    } };
    prepareActorOrganismDevelopmentLimitBase(actor.system);
    assert.equal(actor.system.organismDevelopment.limit, 72);
    const data = buildActorFormulaData(actor, { cache: false });
    assert.equal(data.needSettings.find(need => need.key === "fuel").label, "Second race");
    assert.equal(data.skills.rangedCombat, 17);
    buildActorFormulaData(actor, { stage: "initial-active-effect", cache: false });

    actor.system.creature.raceId = "race-a";
    actor.system.skills.rangedCombat.value = 29;
    prepareActorOrganismDevelopmentLimitBase(actor.system);
    assert.equal(actor.system.organismDevelopment.limit, 41);
    const changed = buildActorFormulaData(actor, { cache: false });
    assert.equal(changed.skills.rangedCombat, 29);
    assert.equal(changed.needSettings.find(need => need.key === "fuel").label, "First race");
    assert.equal(settingReads, readsBefore, "no settings rereads while preparing either phase");

    const part = { type: "gear", system: { placement: { mode: "constructPart" }, functions: {
      constructPart: { enabled: true, needs: [{ key: "oil", label: "Old oil", formula: "10" }] }
    } } };
    const construct = { type: "construct", items: [part], system: {} };
    assert.equal(buildActorFormulaData(construct, { cache: false }).needSettings.find(need => need.key === "oil").label, "Old oil");
    part.system.functions.constructPart.needs[0].label = "New oil";
    assert.equal(buildActorFormulaData(construct, { cache: false }).needSettings.find(need => need.key === "oil").label, "New oil");
    construct.items = [];
    assert.equal(buildActorFormulaData(construct, { cache: false }).needSettings.some(need => need.key === "oil"), false);
    assert.deepEqual(settings, settingsBefore, "calculations do not mutate the shared settings");
  } finally {
    settingValues.clear();
    invalidatePreparedRuntimeSettingsCache();
  }
});

test("settings refresh updates race limits and formula definitions immediately; editor getters stay independent", () => {
  const race = { id: "custom", organismDevelopment: { limit: 35 }, needSettings: [{ key: "fuel", label: "Before", formula: "10" }] };
  settingValues.set("creatureOptions", { types: [], races: [race] });
  invalidatePreparedRuntimeSettingsCache();
  try {
    const actor = { type: "character", system: { creature: { raceId: "custom" } } };
    const before = buildActorFormulaData(actor, { cache: false });
    assert.equal(before.needSettings.find(need => need.key === "fuel").label, "Before");
    race.organismDevelopment.limit = 83;
    race.needSettings[0].label = "After";
    syncSettingsIntoSystemConfig();
    prepareActorOrganismDevelopmentLimitBase(actor.system);
    assert.equal(actor.system.organismDevelopment.limit, 83);
    assert.equal(buildActorFormulaData(actor, { cache: false }).needSettings.find(need => need.key === "fuel").label, "After");
    assert.equal(before.needSettings.find(need => need.key === "fuel").label, "Before");
    const editor = getCreatureOptions();
    editor.races[0].organismDevelopment.limit = 1;
    getActorNeedSettings(actor)[0].label = "Editor modification";
    prepareActorOrganismDevelopmentLimitBase(actor.system);
    assert.equal(actor.system.organismDevelopment.limit, 83);
    assert.equal(buildActorFormulaData(actor, { cache: false }).needSettings.find(need => need.key === "fuel").label, "After");
  } finally {
    settingValues.clear();
    invalidatePreparedRuntimeSettingsCache();
  }
});
