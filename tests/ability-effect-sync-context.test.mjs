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
  let value = object;
  for (const key of String(path).split(".")) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value;
}

function setProperty(object, path, value) {
  const parts = String(path).split(".");
  const finalKey = parts.pop();
  let target = object;
  for (const key of parts) target = target[key] ??= {};
  target[finalKey] = value;
  return true;
}

let randomIdCalls = 0;
globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  documents: {
    ActiveEffect: {
      implementation: {
        CHANGE_TYPES: {
          add: { defaultPriority: 20 },
          multiply: { defaultPriority: 10 },
          subtract: { defaultPriority: 20 },
          override: { defaultPriority: 30 },
          upgrade: { defaultPriority: 40 },
          downgrade: { defaultPriority: 40 }
        }
      }
    }
  },
  utils: {
    deepClone: structuredClone,
    flattenObject,
    getProperty,
    hasProperty: (object, path) => getProperty(object, path) !== undefined,
    mergeObject: (original, other) => ({ ...original, ...other }),
    randomID: () => `generated-${++randomIdCalls}`,
    setProperty
  }
};
globalThis.game = {
  settings: { get: () => undefined },
  i18n: { localize: key => key, format: key => key },
  user: { isActiveGM: true, id: "gm" },
  users: new Map(),
  actors: [],
  time: { worldTime: 0 },
  combat: null
};
globalThis.canvas = { tokens: { placeables: [] }, scene: null };
globalThis.fromUuidSync = () => null;
globalThis._del = Symbol("delete");
globalThis.Hooks = { on() {}, callAll() {} };

const {
  ABILITY_AURA_MODES,
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions
} = await import("../src/settings/abilities.mjs");
const {
  ABILITY_EFFECT_FLAG_KEY,
  EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY,
  ITEM_EFFECT_FLAG_KEY,
  abilityFunctionsMayContainAuraCondition,
  buildAbilityEffectSourceDescriptor,
  buildActorAbilityEffectSyncIndex,
  getLiveIndexedEffects,
  getLiveStaleIndexedEffects
} = await import("../src/abilities/effect-sync-context.mjs");
const {
  getAbilityEffectProjectionFromFunctions,
  getAbilityEffectProjectionFromNormalizedFunctions
} = await import("../src/abilities/evaluation.mjs");
const {
  withoutTimedTriggerCostFunctions,
  withoutTimedTriggerCostNormalizedFunctions
} = await import("../src/abilities/trigger-cost-effects.mjs");
const {
  buildEffectFunctionSnapshot,
  buildNormalizedEffectFunctionSnapshot
} = await import("../src/abilities/effect-lifecycle.mjs");
const {
  syncActorAbilityEffects,
  syncAuraGeneratedEffects
} = await import("../src/abilities/effects.mjs");
const { SYSTEM_ID } = await import("../src/constants.mjs");

function change(id, key, value = "1") {
  return { id, key, type: "add", value, phase: "initial", priority: null };
}

function condition(id, type, data = {}) {
  return { id, groupId: "", type, ...data };
}

test("one source descriptor shares one normalized identity across passive and timed consumers", () => {
  randomIdCalls = 0;
  const rawFunctions = [
    {
      type: ABILITY_FUNCTION_TYPES.effectChanges,
      includeInPureValues: true,
      changes: [change("passive-change", "system.characteristics.strength", "2")],
      conditions: [condition("passive-aura", ABILITY_CONDITION_TYPES.aura, {
        auraMode: ABILITY_AURA_MODES.selfWhenPresent
      })]
    },
    {
      id: "timed-function",
      type: ABILITY_FUNCTION_TYPES.effectChanges,
      changes: [change("timed-change", "system.skills.survival.bonus", "3")],
      conditions: [
        condition("trigger-cost", ABILITY_CONDITION_TYPES.triggerCost),
        condition("duration", ABILITY_CONDITION_TYPES.duration, { durationSeconds: 5 }),
        condition("health", ABILITY_CONDITION_TYPES.healthPercent, { percent: 50 })
      ]
    }
  ];

  const descriptor = buildAbilityEffectSourceDescriptor(rawFunctions);

  assert.equal(randomIdCalls, 1);
  assert.equal(descriptor.normalizedFunctions.length, 2);
  assert.equal(descriptor.projectionFunctions.length, 1);
  assert.equal(descriptor.timedFunctions.length, 1);
  assert.equal(descriptor.passiveEffectFunctions.length, 1);
  assert.equal(descriptor.hasAuraCondition, true);
  assert.equal(descriptor.hasAuraPresenceCondition, true);
  assert.strictEqual(descriptor.projectionFunctions[0], descriptor.normalizedFunctions[0]);
  assert.strictEqual(descriptor.passiveEffectFunctions[0], descriptor.normalizedFunctions[0]);
  assert.strictEqual(descriptor.timedFunctions[0], descriptor.normalizedFunctions[1]);
  assert.equal(descriptor.projectionFunctions[0].id, "generated-1");

  assert.deepEqual(
    withoutTimedTriggerCostNormalizedFunctions(descriptor.normalizedFunctions),
    descriptor.projectionFunctions
  );
});

test("aura descriptor preserves target-only and event-reaction semantics", () => {
  const targetOnly = buildAbilityEffectSourceDescriptor([{
    id: "target-only",
    type: ABILITY_FUNCTION_TYPES.effectChanges,
    changes: [change("target-change", "system.resources.actionPoints.bonus")],
    conditions: [condition("target-aura", ABILITY_CONDITION_TYPES.aura, {
      auraMode: ABILITY_AURA_MODES.applyToTargets
    })]
  }]);
  assert.equal(targetOnly.hasAuraCondition, true);
  assert.equal(targetOnly.hasAuraPresenceCondition, false);

  const eventReaction = buildAbilityEffectSourceDescriptor([{
    id: "event-reaction",
    type: ABILITY_FUNCTION_TYPES.effectChanges,
    changes: [change("reaction-change", "system.resources.actionPoints.bonus")],
    conditions: [
      condition("reaction-aura", ABILITY_CONDITION_TYPES.aura, {
        auraMode: ABILITY_AURA_MODES.selfWhenPresent
      }),
      condition("event", ABILITY_CONDITION_TYPES.eventReaction)
    ]
  }]);
  assert.equal(eventReaction.hasAuraCondition, false);
  assert.equal(eventReaction.hasAuraPresenceCondition, false);

  assert.equal(abilityFunctionsMayContainAuraCondition({
    legacy: {
      condition: {
        type: ABILITY_CONDITION_TYPES.aura,
        auraMode: ABILITY_AURA_MODES.applyToTargets
      }
    }
  }), true);
  assert.equal(abilityFunctionsMayContainAuraCondition([{
    conditions: [condition("health-only", ABILITY_CONDITION_TYPES.healthPercent)]
  }]), false);
});

test("raw and normalized projection APIs preserve changes and pure-value indexes", () => {
  const rawFunctions = [{
    id: "projection-function",
    type: ABILITY_FUNCTION_TYPES.effectChanges,
    includeInPureValues: true,
    changes: [
      change("pure-change", "system.characteristics.strength", "2"),
      change("ordinary-change", "system.resources.actionPoints.bonus", "1")
    ],
    conditions: []
  }];
  const normalized = normalizeAbilityFunctions(rawFunctions);

  assert.deepEqual(
    getAbilityEffectProjectionFromFunctions({}, rawFunctions),
    getAbilityEffectProjectionFromNormalizedFunctions({}, normalized)
  );
  assert.deepEqual(
    getAbilityEffectProjectionFromNormalizedFunctions({}, normalized),
    {
      changes: [
        change("pure-change", "system.characteristics.strength", "2"),
        change("ordinary-change", "system.resources.actionPoints.bonus", "1")
      ],
      pureChangeIndexes: [0]
    }
  );
  assert.deepEqual(
    withoutTimedTriggerCostFunctions(rawFunctions),
    withoutTimedTriggerCostNormalizedFunctions(normalized)
  );
  assert.deepEqual(
    buildEffectFunctionSnapshot(rawFunctions[0]),
    buildNormalizedEffectFunctionSnapshot(normalized[0])
  );
});

test("Actor sync normalizes each source once and makes one managed-effect index pass", async () => {
  randomIdCalls = 0;
  const oldEffect = managedEffect("old", {
    [ABILITY_EFFECT_FLAG_KEY]: {
      abilityItemId: "ability",
      signature: "old",
      auraCondition: false
    }
  });
  const effects = createCountingEffectCollection([oldEffect]);
  let hasChecks = 0;
  const collectionHas = effects.has.bind(effects);
  effects.has = id => {
    hasChecks += 1;
    return collectionHas(id);
  };
  const deleted = [];
  const actor = {
    id: "actor",
    uuid: "Actor.actor",
    type: "character",
    flags: {},
    effects,
    system: {
      creature: { raceId: "" },
      limbs: {},
      resources: {},
      characteristics: {},
      skills: {},
      development: {}
    },
    allApplicableEffects() {
      return [];
    },
    getFlag() {
      return undefined;
    },
    async createEmbeddedDocuments() {
      throw new Error("an empty projection must not create an ActiveEffect");
    },
    async deleteEmbeddedDocuments(_documentName, ids) {
      deleted.push(...ids);
      for (const id of ids) this.effects.delete(id);
      return [];
    }
  };
  const item = {
    id: "ability",
    uuid: "Actor.actor.Item.ability",
    type: "ability",
    name: "Ability",
    img: "ability.webp",
    parent: actor,
    flags: {},
    system: {
      functions: [{
        type: ABILITY_FUNCTION_TYPES.effectChanges,
        changes: [],
        conditions: [],
        penalties: []
      }]
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async update() {
      throw new Error("an inert source must not update its transition state");
    }
  };
  const items = [item];
  items.contents = items;
  actor.items = items;
  actor.itemTypes = { ability: [item] };

  await syncActorAbilityEffects(actor);

  assert.equal(randomIdCalls, 1);
  assert.equal(effects.iterations, 1);
  assert.equal(hasChecks, 1);
  assert.deepEqual(deleted, ["old"]);
});

test("one aura pass prepares a linked Actor source once across multiple Tokens", async () => {
  randomIdCalls = 0;
  const actor = {
    id: "aura-source",
    uuid: "Actor.aura-source",
    type: "character",
    flags: {},
    effects: [],
    system: {
      creature: { raceId: "" },
      limbs: {},
      resources: {},
      characteristics: {},
      skills: {},
      development: {}
    },
    allApplicableEffects() {
      return [];
    },
    getFlag() {
      return undefined;
    }
  };
  const item = {
    id: "aura-ability",
    uuid: "Actor.aura-source.Item.aura-ability",
    type: "ability",
    name: "Aura",
    img: "aura.webp",
    parent: actor,
    flags: {},
    system: {
      functions: [{
        type: ABILITY_FUNCTION_TYPES.effectChanges,
        changes: [change("aura-change", "system.resources.actionPoints.bonus")],
        conditions: [condition("presence-aura", ABILITY_CONDITION_TYPES.aura, {
          auraMode: ABILITY_AURA_MODES.selfWhenPresent
        })],
        penalties: []
      }]
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
  const items = [item];
  items.contents = items;
  actor.items = items;
  actor.itemTypes = { ability: [item], gear: [] };
  const previousTokens = canvas.tokens.placeables;
  canvas.tokens.placeables = [{ actor }, { actor }];

  try {
    await syncAuraGeneratedEffects();
  } finally {
    canvas.tokens.placeables = previousTokens;
  }

  assert.equal(randomIdCalls, 1);
});

test("aura pass rejects actors without raw aura dependencies before HUD preparation", async () => {
  randomIdCalls = 0;
  let actorFlagReads = 0;
  const actor = {
    uuid: "Actor.no-aura",
    type: "character",
    flags: {},
    effects: [],
    itemTypes: { ability: [], gear: [] },
    getFlag() {
      actorFlagReads += 1;
      return undefined;
    }
  };
  const item = {
    id: "ordinary-ability",
    type: "ability",
    system: {
      functions: [{
        type: ABILITY_FUNCTION_TYPES.effectChanges,
        changes: [],
        conditions: []
      }]
    }
  };
  const items = [item];
  items.contents = items;
  actor.items = items;
  actor.itemTypes.ability = [item];
  const previousTokens = canvas.tokens.placeables;
  canvas.tokens.placeables = [{ actor }];

  try {
    await syncAuraGeneratedEffects();
  } finally {
    canvas.tokens.placeables = previousTokens;
  }

  assert.equal(randomIdCalls, 0);
  assert.equal(actorFlagReads, 0);
});

test("managed projection index scans Actor.effects once and keeps strict ids plus document order", () => {
  const effects = [
    managedEffect("ability-a-1", { [ABILITY_EFFECT_FLAG_KEY]: { abilityItemId: "ability-a" } }),
    managedEffect("ability-b", { [ABILITY_EFFECT_FLAG_KEY]: { abilityItemId: "ability-b" } }),
    managedEffect("ability-a-2", { [ABILITY_EFFECT_FLAG_KEY]: { abilityItemId: "ability-a" } }),
    managedEffect("item-a", { [ITEM_EFFECT_FLAG_KEY]: { itemId: "item-a" } }),
    managedEffect("numeric-id", { [ABILITY_EFFECT_FLAG_KEY]: { abilityItemId: 1 } }),
    managedEffect("unrelated", {})
  ];
  const collection = createCountingEffectCollection(effects);
  const actor = { effects: collection };

  const index = buildActorAbilityEffectSyncIndex(actor);

  assert.equal(collection.iterations, 1);
  assert.deepEqual(
    index.abilityEffectsByItemId.get("ability-a").map(effect => effect.id),
    ["ability-a-1", "ability-a-2"]
  );
  assert.equal(index.abilityEffectsByItemId.has("1"), false);
  assert.equal(index.abilityEffectsByItemId.get(1)[0].id, "numeric-id");
  assert.deepEqual(
    getLiveStaleIndexedEffects(actor, index.abilityEffectEntries, new Set(["ability-a"]))
      .map(effect => effect.id),
    ["ability-b", "numeric-id"]
  );
  assert.deepEqual(
    getLiveIndexedEffects(actor, index.itemEffectsByItemId, "item-a")
      .map(effect => effect.id),
    ["item-a"]
  );
  assert.equal(collection.iterations, 1);
});

test("liveness checks prevent a multi-flag effect from being deleted twice in one awaited sync", () => {
  const shared = managedEffect("shared", {
    [ABILITY_EFFECT_FLAG_KEY]: { abilityItemId: "removed-ability" },
    [ITEM_EFFECT_FLAG_KEY]: { itemId: "removed-item" },
    [EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY]: { itemId: "removed-equipment" }
  });
  const collection = createCountingEffectCollection([shared]);
  const actor = { effects: collection };
  const index = buildActorAbilityEffectSyncIndex(actor);

  assert.deepEqual(
    getLiveStaleIndexedEffects(actor, index.abilityEffectEntries, new Set())
      .map(effect => effect.id),
    ["shared"]
  );

  collection.delete("shared");

  assert.deepEqual(
    getLiveStaleIndexedEffects(actor, index.itemEffectEntries, new Set()),
    []
  );
  assert.deepEqual(
    getLiveStaleIndexedEffects(actor, index.equipmentRequirementEffectEntries, new Set()),
    []
  );
});

function managedEffect(id, systemFlags) {
  return {
    id,
    flags: {
      [SYSTEM_ID]: systemFlags
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
}

function createCountingEffectCollection(effects) {
  const documents = new Map(effects.map(effect => [effect.id, effect]));
  let iterations = 0;
  return {
    get iterations() {
      return iterations;
    },
    has(id) {
      return documents.has(id);
    },
    delete(id) {
      return documents.delete(id);
    },
    filter() {
      throw new Error("the managed effect index must not call Collection.filter");
    },
    [Symbol.iterator]() {
      iterations += 1;
      return documents.values();
    }
  };
}
