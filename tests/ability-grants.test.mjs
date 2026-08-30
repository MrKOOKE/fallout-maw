import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    flattenObject: value => flattenObject(value),
    getProperty: (object, path) => getProperty(object, path),
    randomID: () => "generated-id",
    setProperty: (object, path, value) => setProperty(object, path, value)
  }
};
globalThis.game = {
  settings: {
    get() {
      throw new Error("settings are unavailable in this unit test");
    }
  }
};
globalThis.ui = { notifications: { warn() {} } };

const {
  ABILITY_SOURCE_FLAG,
  ABILITY_CONDITION_TYPES,
  createAbilityCondition
} = await import("../src/settings/abilities.mjs");
const { getAbilityEffectChangesFromFunctions } = await import("../src/abilities/evaluation.mjs");
const {
  completeAbilityResearch,
  findCatalogAbility,
  grantAbilityItemData,
  grantCatalogAbility,
  hasUnsafeAbilityEvolutionAcquisitionChanges,
  prepareCatalogAbilityItemData
} = await import("../src/abilities/purchase.mjs");

test("ability grants persist only selected changes before creating the item", async () => {
  const actor = createActor();
  const source = createLimitedAbilityData();

  const result = await grantAbilityItemData(actor, source, {
    evaluateLimit: () => 1,
    chooseLimitedChanges: ({ selectionIds }) => [selectionIds[1]]
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.item?.name, "Selective Feature");
  assert.equal(actor.created.length, 1);
  assert.deepEqual(
    actor.created[0].system.functions[0].changes.map(change => change.id),
    ["change-b"]
  );
  assert.equal(
    actor.created[0].system.functions[0].conditions.some(
      condition => condition.type === ABILITY_CONDITION_TYPES.limitedChanges
    ),
    false
  );
  assert.equal(source.system.functions[0].changes.length, 2, "source catalog data must remain unchanged");
});

test("cancelling a limited-change grant creates no item", async () => {
  const actor = createActor();
  const result = await grantAbilityItemData(actor, createLimitedAbilityData(), {
    evaluateLimit: () => 1,
    chooseLimitedChanges: () => null
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.item, null);
  assert.equal(actor.created.length, 0);
});

test("item-use limited changes remain available for runtime selection", async () => {
  const actor = createActor();
  const source = createLimitedAbilityData();
  source.system.functions[0].conditions.push({
    id: "item-use-id",
    groupId: "",
    type: ABILITY_CONDITION_TYPES.itemUse,
    itemCategories: ["consumable"]
  });

  const result = await grantAbilityItemData(actor, source, {
    evaluateLimit: () => 1,
    chooseLimitedChanges: () => {
      throw new Error("item-use selection must not run during the grant");
    }
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.item?.system.functions[0].changes.length, 2);
  assert.equal(
    result.item?.system.functions[0].conditions.some(
      condition => condition.type === ABILITY_CONDITION_TYPES.limitedChanges
    ),
    true
  );
});

test("unresolved limited changes never project every passive bonus", () => {
  const source = createLimitedAbilityData();
  const changes = getAbilityEffectChangesFromFunctions(
    { uuid: "Actor.Test" },
    source.system.functions,
    { abilityItemId: "ability-id" }
  );
  assert.deepEqual(changes, []);
});

test("limited changes normalize as non-OR metadata", () => {
  const condition = createAbilityCondition({
    type: ABILITY_CONDITION_TYPES.limitedChanges,
    groupId: "legacy-or-group",
    limit: 1
  });
  assert.equal(condition.groupId, "");
});

test("catalog lookup finds a nested evolution with its incoming predecessor", () => {
  const catalog = createEvolutionCatalog();
  const entry = findCatalogAbility("reactive-2", catalog);

  assert.equal(entry?.ability?.name, "Реактивный II");
  assert.equal(entry?.rootAbility?.id, "reactive-1");
  assert.deepEqual(entry?.incomingSourceIds, ["reactive-1"]);
  assert.equal(entry?.category?.id, "athletics");
});

test("every catalog snapshot path preserves nested evolution lineage", () => {
  const entry = findCatalogAbility("reactive-2", createEvolutionCatalog());
  const itemData = prepareCatalogAbilityItemData(entry);
  assert.deepEqual(itemData.flags["fallout-maw"][ABILITY_SOURCE_FLAG], {
    id: "reactive-2",
    categoryId: "athletics",
    evolutionRootId: "reactive-1",
    evolutionParentIds: ["reactive-1"],
    evolutionAncestorIds: ["reactive-1"]
  });
});

test("granting an evolution replaces exactly one predecessor in place", async () => {
  const actor = createActor({ ownedSourceId: "reactive-1" });
  const originalItemId = actor.items[0].id;
  actor.items[0].flags.externalModule = { retained: true };
  actor.items[0].flags["fallout-maw"].abilityFixedFunctionState = { stale: true };

  const evolved = await grantCatalogAbility(actor, "reactive-2", createEvolutionCatalog());

  assert.equal(actor.created.length, 0, "evolution must never create a second embedded Item");
  assert.equal(actor.updated.length, 1);
  assert.equal(actor.updated[0].documentName, "Item");
  assert.deepEqual(actor.updated[0].options, { diff: false, recursive: false });
  assert.equal(actor.updated[0].data._id, originalItemId, "the predecessor Item UUID must remain stable");
  assert.equal(evolved?.id, originalItemId);
  assert.equal(evolved?.name, "Реактивный II");
  assert.deepEqual(evolved?.flags?.externalModule, { retained: true });
  assert.equal(Object.hasOwn(evolved?.flags?.["fallout-maw"] ?? {}, "abilityFixedFunctionState"), false);
  assert.deepEqual(evolved?.flags?.["fallout-maw"]?.[ABILITY_SOURCE_FLAG], {
    id: "reactive-2",
    categoryId: "athletics",
    evolutionRootId: "reactive-1",
    evolutionParentIds: ["reactive-1"],
    evolutionAncestorIds: ["reactive-1"]
  });
});

test("evolution replacement forwards non-rendering options to its single update", async () => {
  const actor = createActor({ ownedSourceId: "reactive-1" });
  const entry = findCatalogAbility("reactive-2", createEvolutionCatalog());
  const result = await grantAbilityItemData(actor, prepareCatalogAbilityItemData(entry), {
    sourceId: "reactive-2",
    createOptions: { render: false }
  });

  assert.ok(result.item);
  assert.deepEqual(actor.updated[0].options, {
    render: false,
    diff: false,
    recursive: false
  });
});

test("concurrent evolution grants update the predecessor only once", async () => {
  const actor = createActor({ ownedSourceId: "reactive-1" });
  let releaseUpdate;
  const updateStarted = new Promise(resolve => {
    actor.beforeUpdate = () => new Promise(release => {
      releaseUpdate = release;
      resolve();
    });
  });

  const firstGrant = grantCatalogAbility(actor, "reactive-2", createEvolutionCatalog());
  await updateStarted;
  const secondGrant = await grantCatalogAbility(actor, "reactive-2", createEvolutionCatalog());
  assert.equal(secondGrant, null);
  assert.equal(actor.updated.length, 1);

  releaseUpdate();
  const evolved = await firstGrant;
  assert.equal(evolved?.name, "Реактивный II");
  assert.equal(actor.updated.length, 1);
});

test("unsafe evolution acquisition changes keep completed research and predecessor intact", async () => {
  const actor = createActor({ ownedSourceId: "reactive-1" });
  const reward = createEvolutionRewardData({ withAcquisitionChange: true });
  assert.equal(
    hasUnsafeAbilityEvolutionAcquisitionChanges(actor, reward, ["reactive-1"]),
    true,
    "advancement must be able to block the cost before research starts"
  );
  actor.system.researches = [{
    id: "research-evolution",
    type: "ability",
    sourceId: "reactive-2",
    progress: 100,
    target: 100,
    rewards: [{ type: "item", itemData: reward }]
  }];

  const result = await completeAbilityResearch(actor, "research-evolution");

  assert.equal(result?.blocked, true);
  assert.equal(result?.item, null);
  assert.equal(actor.deletedResearches.length, 0, "blocked reward must leave completed research available");
  assert.equal(actor.updated.length, 0);
  assert.equal(actor.items[0].flags["fallout-maw"][ABILITY_SOURCE_FLAG].id, "reactive-1");
});

function createActor({ ownedSourceId = "" } = {}) {
  const actor = {
    items: [],
    system: {},
    created: [],
    updated: [],
    deletedResearches: [],
    beforeUpdate: null,
    async createEmbeddedDocuments(documentName, entries) {
      assert.equal(documentName, "Item");
      const data = structuredClone(entries[0]);
      this.created.push(data);
      const item = {
        ...data,
        getFlag(namespace, key) {
          return this.flags?.[namespace]?.[key];
        }
      };
      this.items.push(item);
      return [item];
    },
    async updateEmbeddedDocuments(documentName, entries, options) {
      assert.equal(documentName, "Item");
      const data = structuredClone(entries[0]);
      this.updated.push({ documentName, data, options: structuredClone(options) });
      await this.beforeUpdate?.();
      const index = this.items.findIndex(item => item.id === data._id || item._id === data._id);
      if (index < 0) return [];
      const item = {
        ...data,
        id: data._id,
        getFlag(namespace, key) {
          return this.flags?.[namespace]?.[key];
        }
      };
      this.items[index] = item;
      return [item];
    },
    async deleteResearch(researchId) {
      this.deletedResearches.push(researchId);
      this.system.researches = this.system.researches.filter(research => research.id !== researchId);
    },
    async update() {}
  };
  if (ownedSourceId) {
    actor.items.push(createOwnedAbility("owned-ability-id", ownedSourceId));
  }
  return actor;
}

function createLimitedAbilityData() {
  return {
    name: "Selective Feature",
    type: "ability",
    system: {
      functions: [{
        id: "function-id",
        type: "effectChanges",
        changes: [
          createChange("change-a", "system.skills.a.bonus"),
          createChange("change-b", "system.skills.b.bonus")
        ],
        conditions: [{
          id: "limit-id",
          groupId: "legacy-or-group",
          type: ABILITY_CONDITION_TYPES.limitedChanges,
          limit: 1,
          limitFormula: "1"
        }],
        penalties: []
      }]
    },
    flags: {}
  };
}

function createChange(id, key) {
  return {
    id,
    key,
    type: "add",
    value: "10",
    phase: "initial",
    priority: null
  };
}

function createEvolutionCatalog() {
  return {
    categories: [{
      id: "athletics",
      name: "Атлетика",
      abilities: [{
        id: "reactive-1",
        name: "Реактивный",
        img: "icons/svg/aura.svg",
        system: {
          functions: [],
          evolution: {
            nodes: [{
              id: "reactive-2",
              x: 300,
              y: 0,
              ability: {
                id: "reactive-2",
                name: "Реактивный II",
                img: "icons/svg/aura.svg",
                description: "Каждые 4 потраченных ОП дают +2 ОД.",
                system: { functions: [] }
              }
            }],
            links: [{ id: "reactive-link", fromId: "reactive-1", toId: "reactive-2" }]
          }
        }
      }]
    }]
  };
}

function createEvolutionRewardData({ withAcquisitionChange = false } = {}) {
  return {
    name: "Реактивный II",
    type: "ability",
    system: {
      functions: withAcquisitionChange ? [{
        id: "unsafe-acquisition",
        type: "acquisitionChanges",
        changes: [createChange("unsafe-change", "system.development.points.skills")],
        conditions: [],
        penalties: []
      }] : []
    },
    flags: {
      "fallout-maw": {
        [ABILITY_SOURCE_FLAG]: {
          id: "reactive-2",
          categoryId: "athletics",
          evolutionRootId: "reactive-1",
          evolutionParentIds: ["reactive-1"]
        }
      }
    }
  };
}

function createOwnedAbility(id, sourceId) {
  return {
    id,
    _id: id,
    name: "Реактивный",
    type: "ability",
    system: { functions: [] },
    flags: {
      "fallout-maw": {
        [ABILITY_SOURCE_FLAG]: {
          id: sourceId,
          categoryId: "athletics",
          evolutionRootId: "",
          evolutionParentIds: []
        }
      }
    },
    getFlag(namespace, key) {
      return this.flags?.[namespace]?.[key];
    }
  };
}

function getProperty(object, path) {
  return String(path ?? "").split(".").filter(Boolean).reduce((value, key) => value?.[key], object);
}

function setProperty(object, path, value) {
  const parts = String(path ?? "").split(".").filter(Boolean);
  const key = parts.pop();
  const target = parts.reduce((entry, part) => (entry[part] ??= {}), object);
  target[key] = value;
  return true;
}

function flattenObject(object, prefix = "", result = {}) {
  for (const [key, value] of Object.entries(object ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flattenObject(value, path, result);
    else result[path] = value;
  }
  return result;
}
