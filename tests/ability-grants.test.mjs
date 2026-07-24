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
  ABILITY_CONDITION_TYPES,
  createAbilityCondition
} = await import("../src/settings/abilities.mjs");
const { getAbilityEffectChangesFromFunctions } = await import("../src/abilities/evaluation.mjs");
const { grantAbilityItemData } = await import("../src/abilities/purchase.mjs");

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

function createActor() {
  return {
    items: [],
    system: {},
    created: [],
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
    async update() {}
  };
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
