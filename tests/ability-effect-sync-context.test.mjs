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

function deleteProperty(object, path) {
  const parts = String(path).split(".");
  const finalKey = parts.pop();
  let target = object;
  for (const key of parts) {
    target = target?.[key];
    if (!target) return false;
  }
  return delete target[finalKey];
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
    // Foundry V14's helper deliberately does not recurse into Arrays. Keep the
    // engine contract in this fixture so projection no-op tests catch callers
    // which accidentally use object equality for ActiveEffect change rows.
    equals: (left, right) => {
      if (Object.is(left, right)) return true;
      if (Array.isArray(left) || Array.isArray(right)) return false;
      if (!isPlainObject(left) || !isPlainObject(right)) return false;
      const leftKeys = Object.keys(left);
      const rightKeys = Object.keys(right);
      return leftKeys.length === rightKeys.length
        && leftKeys.every(key => (
          Object.hasOwn(right, key)
          && globalThis.foundry.utils.equals(left[key], right[key])
        ));
    },
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
const registeredHookCallbacks = new Map();
globalThis.Hooks = {
  on(name, callback) {
    const callbacks = registeredHookCallbacks.get(name) ?? [];
    callbacks.push(callback);
    registeredHookCallbacks.set(name, callbacks);
    return callback;
  },
  callAll(name, ...args) {
    for (const callback of registeredHookCallbacks.get(name) ?? []) callback(...args);
  }
};

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
  getAbilityEffectProjectionFromNormalizedFunctions,
  getLateAuraContextualChanges
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
  activeEffectUpdateNeedsAuraStateSync,
  actorUpdateNeedsAuraStateSync,
  getItemAbilityEffectSyncPlan,
  registerAbilityEffectHooks,
  syncActorAbilityEffects,
  syncAuraGeneratedEffects
} = await import("../src/abilities/effects.mjs");
const {
  registerActiveEffectAuraHooks
} = await import("../src/abilities/active-effect-auras.mjs");
const {
  buildActiveApplicationMarkerChangeUpdate,
  prepareActiveApplicationAuraFunctionData,
  resolveActiveApplicationMarkerChanges
} = await import("../src/abilities/active-application-effects.mjs");
const {
  ADVANCEMENT_PURE_EFFECT_FLAG_KEY
} = await import("../src/advancement/pure-value-effects.mjs");
const { SYSTEM_ID } = await import("../src/constants.mjs");

function change(id, key, value = "1") {
  return { id, key, type: "add", value, phase: "initial", priority: null };
}

function condition(id, type, data = {}) {
  return { id, groupId: "", type, ...data };
}

test("ActiveEffect presentation-only deltas do not request a global aura pass", () => {
  const actor = { documentName: "Actor", type: "character" };
  const effect = { parent: actor };
  const cosmeticDeltas = [
    { name: "Renamed" },
    { img: "renamed.webp" },
    { description: "Presentation only" },
    { tint: "#ffffff" },
    { showIcon: 2 },
    { folder: "folder-id" },
    { sort: 10 },
    { _stats: { modifiedTime: 100 } },
    { "-=description": null },
    {
      _id: "effect-id",
      name: "Renamed",
      img: "renamed.webp",
      _stats: { modifiedTime: 101 }
    }
  ];

  for (const changes of cosmeticDeltas) {
    assert.equal(activeEffectUpdateNeedsAuraStateSync(effect, changes), false);
  }
});

test("ActiveEffect mechanical and unknown deltas conservatively request an aura pass", () => {
  const effect = { parent: { documentName: "Actor", type: "character" } };
  const mechanicalDeltas = [
    { system: { changes: [] } },
    { "system.changes": [] },
    { disabled: true },
    { statuses: ["dead"] },
    { duration: { expired: true } },
    { "duration.value": 6 },
    { start: { time: 100 } },
    { flags: { [SYSTEM_ID]: { activeApplication: null } } },
    { origin: "Actor.source.Item.ability" },
    { type: "base" },
    { futureMechanicalField: true },
    { "-=statuses": null },
    {}
  ];

  for (const changes of mechanicalDeltas) {
    assert.equal(activeEffectUpdateNeedsAuraStateSync(effect, changes), true);
  }
});

test("ActiveEffect transfer is inert on an Actor but mechanical on an Item", () => {
  const actor = { documentName: "Actor", type: "character" };
  assert.equal(activeEffectUpdateNeedsAuraStateSync({ parent: actor }, { transfer: true }), false);
  assert.equal(activeEffectUpdateNeedsAuraStateSync({
    parent: {
      documentName: "Item",
      type: "ability",
      parent: actor
    }
  }, { transfer: true }), true);
});

function gearItem({
  mode = "equipment",
  freeSettings = true,
  mitigationRequirements = true
} = {}) {
  return {
    type: "gear",
    name: "Test gear",
    img: "icons/svg/item-bag.svg",
    system: {
      equipped: true,
      placement: { mode },
      occupiedSlots: {},
      functions: {
        condition: {
          enabled: true,
          value: 80,
          max: 100
        },
        freeSettings: {
          enabled: freeSettings,
          entries: []
        },
        damageMitigation: {
          enabled: mitigationRequirements,
          requirements: mitigationRequirements
            ? [{ type: "characteristic", key: "strength", value: 5 }]
            : []
        }
      }
    }
  };
}

test("ordinary equipment condition updates do not rebuild projections or auras", () => {
  const item = gearItem({
    mode: "equipment",
    freeSettings: true,
    mitigationRequirements: true
  });

  assert.deepEqual(
    getItemAbilityEffectSyncPlan(item, {
      "system.functions.condition.value": 79
    }),
    { actor: false, aura: false }
  );
});

test("prosthesis and construct condition updates refresh only Actor projections", () => {
  for (const mode of ["prosthesis", "constructPart"]) {
    const item = gearItem({
      mode,
      freeSettings: true,
      mitigationRequirements: true
    });

    assert.deepEqual(
      getItemAbilityEffectSyncPlan(item, {
        system: {
          functions: {
            condition: { value: 50 }
          }
        }
      }),
      { actor: true, aura: false },
      mode
    );
  }
});

test("item source definition and activation updates retain exact projection fanout", () => {
  const item = gearItem({
    mode: "equipment",
    freeSettings: true,
    mitigationRequirements: true
  });

  assert.deepEqual(
    getItemAbilityEffectSyncPlan(item, {
      "system.functions.freeSettings.entries": []
    }),
    { actor: true, aura: true }
  );
  assert.deepEqual(
    getItemAbilityEffectSyncPlan(item, {
      name: "Renamed aura source"
    }),
    { actor: true, aura: true }
  );
  assert.deepEqual(
    getItemAbilityEffectSyncPlan(item, {
      "system.functions.damageMitigation.requirements": []
    }),
    { actor: true, aura: false }
  );
  assert.deepEqual(
    getItemAbilityEffectSyncPlan(item, {
      "system.placement.mode": "inventory"
    }),
    { actor: true, aura: true }
  );
  assert.deepEqual(
    getItemAbilityEffectSyncPlan(item, {
      "system.functions.weapon.moduleSlots": []
    }),
    { actor: true, aura: true }
  );
});

test("ordinary Actor damage requests a scene aura pass only for a real aura source", () => {
  let contentsReads = 0;
  const ordinaryActor = {
    itemTypes: { ability: [], gear: [] },
    items: {
      get contents() {
        contentsReads += 1;
        return [];
      }
    }
  };
  const healthChange = {
    "system.resources.health.value": 7
  };

  assert.equal(actorUpdateNeedsAuraStateSync(ordinaryActor, healthChange), false);
  const readsAfterFirstLookup = contentsReads;
  assert.equal(actorUpdateNeedsAuraStateSync(ordinaryActor, healthChange), false);
  assert.equal(contentsReads, readsAfterFirstLookup, "negative aura-source lookup must stay cached");
  assert.equal(actorUpdateNeedsAuraStateSync(ordinaryActor, {
    "system.creature.typeId": "robot"
  }), true, "target membership changes still require scene reconciliation");

  const auraAbility = {
    type: "ability",
    system: {
      functions: [{
        type: ABILITY_FUNCTION_TYPES.effectChanges,
        changes: [change("aura-change", "system.resources.actionPoints.bonus")],
        conditions: [condition("aura", ABILITY_CONDITION_TYPES.aura, {
          auraMode: ABILITY_AURA_MODES.applyToTargets
        })]
      }]
    }
  };
  const sourceActor = {
    itemTypes: { ability: [auraAbility], gear: [] },
    items: { contents: [auraAbility] }
  };
  assert.equal(actorUpdateNeedsAuraStateSync(sourceActor, healthChange), true);
});

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

test("managed projection markers stop the system's own ActiveEffect requeue hooks", () => {
  const hookNames = ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"];
  const previousCounts = Object.fromEntries(
    hookNames.map(name => [name, registeredHookCallbacks.get(name)?.length ?? 0])
  );
  registerAbilityEffectHooks();
  const inaccessibleEffect = new Proxy({}, {
    get() {
      throw new Error("a marked self-sync hook must not inspect the ActiveEffect");
    }
  });
  const options = { falloutMawAbilityEffectSync: true };

  for (const hookName of hookNames) {
    const callbacks = (registeredHookCallbacks.get(hookName) ?? [])
      .slice(previousCounts[hookName]);
    assert.equal(callbacks.length, 1);
    for (const callback of callbacks) {
      assert.doesNotThrow(() => {
        if (hookName === "updateActiveEffect") callback(inaccessibleEffect, {}, options);
        else callback(inaccessibleEffect, options);
      });
    }
  }
});

test("managed projection markers also bypass the active-aura runtime hooks", () => {
  const hookNames = ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"];
  const previousCounts = Object.fromEntries(
    hookNames.map(name => [name, registeredHookCallbacks.get(name)?.length ?? 0])
  );
  registerActiveEffectAuraHooks();
  const inaccessibleEffect = new Proxy({}, {
    get() {
      throw new Error("a marked projection must not enter the active-aura runtime");
    }
  });
  const options = { falloutMawAbilityEffectSync: true };

  for (const hookName of hookNames) {
    const callbacks = (registeredHookCallbacks.get(hookName) ?? [])
      .slice(previousCounts[hookName]);
    assert.equal(callbacks.length, 1);
    assert.doesNotThrow(() => {
      if (hookName === "updateActiveEffect") callbacks[0](inaccessibleEffect, {}, options);
      else callbacks[0](inaccessibleEffect, options);
    });
  }
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

test("a changed ability projection updates the same ActiveEffect and then becomes a no-op", async () => {
  const ability = abilityItem("stable-ability", "1");
  const harness = createProjectionSyncHarness([ability]);

  await syncActorAbilityEffects(harness.actor);
  const effect = harness.findEffect(ABILITY_EFFECT_FLAG_KEY);
  assert.deepEqual(harness.operations.creates[0].options, {
    falloutMawAbilityEffectSync: true,
    animate: false
  });
  const originalId = effect.id;
  const originalSignature = effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY).signature;
  assert.equal(Object.hasOwn(effect.system.changes[0], "id"), false);
  assert.equal(
    JSON.parse(originalSignature).changes[0].id,
    "stable-ability-change"
  );

  const persistedSource = effect.toObject();
  persistedSource.duration = {
    value: null,
    units: "seconds",
    expiry: null,
    expired: false
  };
  effect._source = persistedSource;
  effect.duration = {
    value: Infinity,
    units: "seconds",
    expiry: null,
    expired: false
  };
  effect.statuses = new Set();
  effect.system.changes = persistedSource.system.changes.map(row => ({
    ...structuredClone(row),
    priority: 20,
    effect: { id: effect.id }
  }));
  harness.resetOperations();

  await syncActorAbilityEffects(harness.actor);
  assert.deepEqual(harness.operationCounts(), { creates: 0, updates: 0, deletes: 0 });

  effect.flags[SYSTEM_ID][ADVANCEMENT_PURE_EFFECT_FLAG_KEY] = { changeIndexes: [0] };
  effect._source.flags[SYSTEM_ID][ADVANCEMENT_PURE_EFFECT_FLAG_KEY] = { changeIndexes: [0] };
  harness.resetOperations();

  ability.system.functions[0].changes[0].value = "2";
  await syncActorAbilityEffects(harness.actor);

  assert.equal(harness.operations.creates.length, 0);
  assert.equal(harness.operations.deletes.length, 0);
  assert.equal(harness.operations.updates.length, 1);
  assert.deepEqual(harness.operations.updates[0].options, {
    falloutMawAbilityEffectSync: true,
    animate: false
  });
  assert.equal(effect.id, originalId);
  assert.equal(effect.system.changes[0].value, 2);
  assert.notEqual(
    effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY).signature,
    originalSignature
  );
  assert.equal(
    Object.hasOwn(effect.flags[SYSTEM_ID], ADVANCEMENT_PURE_EFFECT_FLAG_KEY),
    false
  );

  effect.duration = {
    ...structuredClone(effect._source.duration),
    value: Infinity
  };
  effect.system.changes = effect._source.system.changes.map(row => ({
    ...structuredClone(row),
    priority: 20,
    effect: { id: effect.id }
  }));
  harness.resetOperations();
  await syncActorAbilityEffects(harness.actor);
  assert.deepEqual(harness.operationCounts(), { creates: 0, updates: 0, deletes: 0 });
});

test("an exact projection repairs stale auxiliary flags without replacing its ActiveEffect", async () => {
  const ability = abilityItem("canonical-ability", "1");
  const harness = createProjectionSyncHarness([ability]);

  await syncActorAbilityEffects(harness.actor);
  const effect = harness.findEffect(ABILITY_EFFECT_FLAG_KEY);
  effect.flags[SYSTEM_ID][ADVANCEMENT_PURE_EFFECT_FLAG_KEY] = { changeIndexes: [0] };
  effect.flags[SYSTEM_ID][ABILITY_EFFECT_FLAG_KEY].auraCondition = true;
  harness.resetOperations();

  await syncActorAbilityEffects(harness.actor);

  assert.deepEqual(harness.operationCounts(), { creates: 0, updates: 1, deletes: 0 });
  assert.equal(
    Object.hasOwn(effect.flags[SYSTEM_ID], ADVANCEMENT_PURE_EFFECT_FLAG_KEY),
    false
  );
  assert.equal(effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY).auraCondition, false);

  harness.resetOperations();
  await syncActorAbilityEffects(harness.actor);
  assert.deepEqual(harness.operationCounts(), { creates: 0, updates: 0, deletes: 0 });
});

test("duplicate projections preserve the exact canonical effect and only delete the stale duplicate", async () => {
  const ability = abilityItem("duplicate-ability", "1");
  const harness = createProjectionSyncHarness([ability]);

  await syncActorAbilityEffects(harness.actor);
  const canonical = harness.findEffect(ABILITY_EFFECT_FLAG_KEY);
  const staleData = canonical.toObject();
  staleData.flags[SYSTEM_ID][ABILITY_EFFECT_FLAG_KEY].signature = "stale";
  harness.effects.delete(canonical.id);
  const stale = harness.addEffect(staleData, "stale-duplicate");
  harness.effects.set(canonical.id, canonical);
  harness.resetOperations();

  await syncActorAbilityEffects(harness.actor);

  assert.deepEqual(harness.operationCounts(), { creates: 0, updates: 0, deletes: 1 });
  assert.deepEqual(harness.operations.deletes[0].ids, [stale.id]);
  assert.equal(harness.effects.has(canonical.id), true);
  assert.equal(harness.effects.has(stale.id), false);
});

test("a projection with an incompatible ActiveEffect subtype uses the safe replace path", async () => {
  const ability = abilityItem("legacy-type-ability", "1");
  const harness = createProjectionSyncHarness([ability]);

  await syncActorAbilityEffects(harness.actor);
  const legacyEffect = harness.findEffect(ABILITY_EFFECT_FLAG_KEY);
  legacyEffect.type = "legacy";
  harness.resetOperations();

  ability.system.functions[0].changes[0].value = "2";
  await syncActorAbilityEffects(harness.actor);

  assert.deepEqual(harness.operationCounts(), { creates: 1, updates: 0, deletes: 1 });
  assert.equal(harness.effects.has(legacyEffect.id), false);
  assert.equal(harness.findEffect(ABILITY_EFFECT_FLAG_KEY).type, "base");
});

test("free-settings and equipment requirement projections both update in place", async () => {
  const gear = freeSettingsEquipmentItem("combined-gear", "1", 5);
  const harness = createProjectionSyncHarness([gear], {
    characteristics: { strength: 2 }
  });

  await syncActorAbilityEffects(harness.actor);
  const freeSettingsEffect = harness.findEffect(ITEM_EFFECT_FLAG_KEY);
  const requirementEffect = harness.findEffect(EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY);
  assert.ok(freeSettingsEffect);
  assert.ok(requirementEffect);
  const freeSettingsId = freeSettingsEffect.id;
  const requirementId = requirementEffect.id;
  harness.resetOperations();

  gear.system.functions.freeSettings.entries[0].changes[0].value = "2";
  gear.system.functions.damageMitigation.requirements[0].value = 6;
  await syncActorAbilityEffects(harness.actor);

  assert.deepEqual(harness.operationCounts(), { creates: 0, updates: 2, deletes: 0 });
  assert.equal(freeSettingsEffect.id, freeSettingsId);
  assert.equal(requirementEffect.id, requirementId);
  assert.equal(freeSettingsEffect.system.changes[0].value, 2);
  assert.equal(requirementEffect.system.changes[0].value, -4);

  harness.resetOperations();
  await syncActorAbilityEffects(harness.actor);
  assert.deepEqual(harness.operationCounts(), { creates: 0, updates: 0, deletes: 0 });
});

test("synthetic module projections persist the real host Item as their ActiveEffect origin", async () => {
  const host = {
    id: "module-host",
    uuid: "Actor.projection-actor.Item.module-host",
    type: "gear",
    name: "Module host",
    img: "module-host.webp",
    flags: {},
    system: {
      equipped: true,
      occupiedSlots: {},
      placement: { mode: "equipment" },
      functions: {}
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
  const moduleItem = freeSettingsEquipmentItem("module-projection", "1", 5);
  moduleItem.uuid = `${host.uuid}.Module.slot-1`;
  moduleItem.system.placement = {
    mode: "module",
    parentItemId: host.id,
    moduleSlotId: "slot-1"
  };
  const harness = createProjectionSyncHarness([host, moduleItem], {
    characteristics: { strength: 2 }
  });

  await syncActorAbilityEffects(harness.actor);

  const moduleEffects = Array.from(harness.effects).filter(effect => {
    const itemId = effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.itemId
      ?? effect.getFlag(SYSTEM_ID, EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY)?.itemId;
    return itemId === moduleItem.id;
  });
  assert.equal(moduleEffects.length, 2);
  assert.deepEqual(
    moduleEffects.map(effect => effect.origin),
    [host.uuid, host.uuid]
  );

  harness.resetOperations();
  await syncActorAbilityEffects(harness.actor);
  assert.deepEqual(harness.operationCounts(), { creates: 0, updates: 0, deletes: 0 });
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

function createRuntimeAuraActor(id) {
  const effects = [];
  const items = [];
  const embeddedOperations = [];
  items.contents = items;
  const actor = {
    id,
    uuid: `Actor.${id}`,
    documentName: "Actor",
    type: "character",
    effects,
    embeddedOperations,
    items,
    itemTypes: { ability: [], gear: [] },
    flags: {},
    statuses: new Set(),
    system: {
      creature: { raceId: "", typeId: "" },
      limbs: {},
      resources: {},
      characteristics: {},
      skills: {},
      development: {}
    },
    allApplicableEffects() {
      return this.effects;
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async createEmbeddedDocuments(_documentName, creations, options = {}) {
      embeddedOperations.push({ kind: "create", options });
      return creations.map((data, index) => {
        const effect = {
          ...structuredClone(data),
          id: `generated-aura-${this.effects.length}-${index}`,
          parent: this,
          disabled: false,
          duration: data.duration ?? { expired: false },
          getFlag(scope, key) {
            return this.flags?.[scope]?.[key];
          }
        };
        effect.uuid = `${this.uuid}.ActiveEffect.${effect.id}`;
        this.effects.push(effect);
        return effect;
      });
    },
    async deleteEmbeddedDocuments(_documentName, ids, options = {}) {
      embeddedOperations.push({ kind: "delete", options });
      for (const id of ids) {
        const index = this.effects.findIndex(effect => effect.id === id);
        if (index >= 0) this.effects.splice(index, 1);
      }
      return [];
    }
  };
  return actor;
}

function createRuntimeAuraToken(actor, id, x = 0, y = 0) {
  const document = {
    id,
    uuid: `Scene.aura.Token.${id}`,
    documentName: "Token",
    hidden: false,
    x,
    y,
    parent: { id: "aura", uuid: "Scene.aura" }
  };
  return {
    id,
    actor,
    document,
    center: { x, y },
    visible: true,
    renderable: true,
    checkCollision: () => false
  };
}

function createRuntimeDistributedAuraEffect(actor, token, {
  id = "runtime-aura",
  includeSelf = false,
  radius = "3",
  changeEvaluation = "target",
  changeValue = "2"
} = {}) {
  const activeApplication = {
    abilityItemId: "missing-source-item",
    sourceItemUuid: "Actor.missing.Item.missing-source-item",
    sourceActorUuid: "Actor.missing",
    targetTokenUuid: token.document.uuid,
    changeEvaluation,
    chanceOperationId: `runtime-aura:${id}`,
    functionData: {
      id: "runtime-distributed-aura",
      type: ABILITY_FUNCTION_TYPES.activeApplication,
      changes: [change("runtime-aura-change", "system.resources.actionPoints.bonus", changeValue)],
      conditions: [condition("runtime-aura-condition", ABILITY_CONDITION_TYPES.aura, {
        auraMode: ABILITY_AURA_MODES.applyToTargets,
        auraTargetGroups: ["ally"],
        auraRadiusMeters: radius,
        requiredCount: "1",
        auraWallsBlock: false,
        auraIncludeSelf: includeSelf,
        auraIgnoreIncapacitated: false,
        auraIgnoreHidden: true
      })],
      penalties: []
    }
  };
  return {
    id,
    uuid: `${actor.uuid}.ActiveEffect.${id}`,
    documentName: "ActiveEffect",
    parent: actor,
    name: `Runtime aura ${id}`,
    img: "runtime-aura.webp",
    disabled: false,
    active: true,
    duration: { expired: false, value: 18 },
    system: { changes: [] },
    flags: {
      [SYSTEM_ID]: { activeApplication }
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
}

function getGeneratedAuraEffects(actor) {
  return actor.effects.filter(effect => effect.flags?.[SYSTEM_ID]?.auraGenerated);
}

test("a temporary ActiveEffect aura emits only from its persisted target Token", async () => {
  const carrier = createRuntimeAuraActor("runtime-carrier");
  const target = createRuntimeAuraActor("runtime-target");
  const unselectedCarrierToken = createRuntimeAuraToken(carrier, "carrier-near", 0, 0);
  const selectedCarrierToken = createRuntimeAuraToken(carrier, "carrier-selected", 1000, 0);
  const targetToken = createRuntimeAuraToken(target, "target", 100, 0);
  const sourceEffect = createRuntimeDistributedAuraEffect(carrier, selectedCarrierToken);
  carrier.effects.push(sourceEffect);
  const previousTokens = canvas.tokens.placeables;
  canvas.tokens.placeables = [unselectedCarrierToken, selectedCarrierToken, targetToken];

  try {
    await syncAuraGeneratedEffects();
    assert.equal(getGeneratedAuraEffects(target).length, 0);

    selectedCarrierToken.center.x = 100;
    await syncAuraGeneratedEffects();

    const [projection] = getGeneratedAuraEffects(target);
    assert.ok(projection);
    assert.equal(projection.origin, sourceEffect.uuid);
    assert.equal(projection.flags[SYSTEM_ID].auraGenerated.sourceKind, "activeEffect");
    assert.equal(projection.flags[SYSTEM_ID].auraGenerated.sourceEffectUuid, sourceEffect.uuid);
    assert.equal(projection.system.changes[0].key, "system.resources.actionPoints.bonus");
    assert.equal(sourceEffect.system.changes.length, 0);
    assert.deepEqual(target.embeddedOperations.at(-1), {
      kind: "create",
      options: {
        falloutMawAbilityEffectSync: true,
        animate: false
      }
    });

    sourceEffect.disabled = true;
    await syncAuraGeneratedEffects();
    assert.equal(getGeneratedAuraEffects(target).length, 0);
    assert.deepEqual(target.embeddedOperations.at(-1), {
      kind: "delete",
      options: {
        falloutMawAbilityEffectSync: true,
        animate: false
      }
    });
  } finally {
    canvas.tokens.placeables = previousTokens;
  }
});

test("two temporary aura effects keep independent projections and clean up by source", async () => {
  const carrier = createRuntimeAuraActor("runtime-stacked-carrier");
  const target = createRuntimeAuraActor("runtime-stacked-target");
  const carrierToken = createRuntimeAuraToken(carrier, "stacked-carrier", 0, 0);
  const targetToken = createRuntimeAuraToken(target, "stacked-target", 100, 0);
  const first = createRuntimeDistributedAuraEffect(carrier, carrierToken, { id: "first-aura" });
  const second = createRuntimeDistributedAuraEffect(carrier, carrierToken, { id: "second-aura" });
  carrier.effects.push(first, second);
  const previousTokens = canvas.tokens.placeables;
  canvas.tokens.placeables = [carrierToken, targetToken];

  try {
    await syncAuraGeneratedEffects();
    assert.deepEqual(
      getGeneratedAuraEffects(target)
        .map(effect => effect.flags[SYSTEM_ID].auraGenerated.sourceEffectUuid)
        .sort(),
      [first.uuid, second.uuid].sort()
    );

    carrier.effects.splice(carrier.effects.indexOf(first), 1);
    await syncAuraGeneratedEffects();
    assert.deepEqual(
      getGeneratedAuraEffects(target)
        .map(effect => effect.flags[SYSTEM_ID].auraGenerated.sourceEffectUuid),
      [second.uuid]
    );

    second.duration.expired = true;
    await syncAuraGeneratedEffects();
    assert.equal(getGeneratedAuraEffects(target).length, 0);
  } finally {
    canvas.tokens.placeables = previousTokens;
  }
});

test("a temporary aura applies to its carrier only through an include-self projection", async () => {
  const carrier = createRuntimeAuraActor("runtime-self-carrier");
  const carrierToken = createRuntimeAuraToken(carrier, "self-carrier", 0, 0);
  const sourceEffect = createRuntimeDistributedAuraEffect(carrier, carrierToken, {
    includeSelf: true,
    radius: "0"
  });
  carrier.effects.push(sourceEffect);
  const previousTokens = canvas.tokens.placeables;
  canvas.tokens.placeables = [carrierToken];

  try {
    await syncAuraGeneratedEffects();
    assert.equal(sourceEffect.system.changes.length, 0);
    assert.equal(getGeneratedAuraEffects(carrier).length, 1);
    assert.equal(getGeneratedAuraEffects(carrier)[0].system.changes.length, 1);
  } finally {
    canvas.tokens.placeables = previousTokens;
  }
});

test("a temporary aura keeps late weapon conditions without its original Item", async () => {
  const carrier = createRuntimeAuraActor("runtime-context-carrier");
  const target = createRuntimeAuraActor("runtime-context-target");
  const carrierToken = createRuntimeAuraToken(carrier, "context-carrier", 0, 0);
  const targetToken = createRuntimeAuraToken(target, "context-target", 100, 0);
  const sourceEffect = createRuntimeDistributedAuraEffect(carrier, carrierToken);
  sourceEffect.flags[SYSTEM_ID].activeApplication.functionData.conditions.push(condition(
    "runtime-weapon-action",
    ABILITY_CONDITION_TYPES.weaponAction,
    { weaponActionKeys: ["aimedShot"] }
  ));
  carrier.effects.push(sourceEffect);
  const previousTokens = canvas.tokens.placeables;
  const previousFromUuidSync = globalThis.fromUuidSync;
  const documents = new Map([
    [sourceEffect.uuid, sourceEffect],
    [carrierToken.document.uuid, carrierToken],
    [targetToken.document.uuid, targetToken]
  ]);
  canvas.tokens.placeables = [carrierToken, targetToken];
  globalThis.fromUuidSync = uuid => documents.get(uuid) ?? null;

  try {
    await syncAuraGeneratedEffects();
    const [projection] = getGeneratedAuraEffects(target);
    assert.ok(projection);
    assert.equal(projection.flags[SYSTEM_ID].auraGenerated.lateContextual, true);
    assert.deepEqual(projection.system.changes, []);
    assert.deepEqual(
      getLateAuraContextualChanges(target, projection, {
        actorToken: targetToken,
        weaponActionKey: "aimedShot"
      }).map(entry => [entry.key, entry.value]),
      [["system.resources.actionPoints.bonus", 2]]
    );
    assert.deepEqual(
      getLateAuraContextualChanges(target, projection, {
        actorToken: targetToken,
        weaponActionKey: "burst"
      }),
      []
    );
  } finally {
    canvas.tokens.placeables = previousTokens;
    globalThis.fromUuidSync = previousFromUuidSync;
  }
});

test("Actor resync keeps a distributed-aura marker empty", async () => {
  const actor = createRuntimeAuraActor("runtime-marker-resync");
  const token = createRuntimeAuraToken(actor, "marker-resync", 0, 0);
  const effect = createRuntimeDistributedAuraEffect(actor, token);
  const stalePenalty = change(
    "stale-marker-penalty",
    "system.resources.actionPoints.bonus",
    "-7"
  );
  effect.flags[SYSTEM_ID].activeApplication.functionData.penalties = [stalePenalty];
  effect.flags[SYSTEM_ID].activeApplication.changeSnapshot = [stalePenalty];
  effect.flags[SYSTEM_ID].activeApplication.signature = JSON.stringify([stalePenalty]);
  effect.system.changes = [structuredClone(stalePenalty)];
  let evaluations = 0;
  const changes = resolveActiveApplicationMarkerChanges(
    effect.flags[SYSTEM_ID].activeApplication.functionData,
    {
      changeSnapshot: effect.flags[SYSTEM_ID].activeApplication.changeSnapshot,
      evaluateChanges: () => {
        evaluations += 1;
        return [stalePenalty];
      }
    }
  );
  const update = buildActiveApplicationMarkerChangeUpdate(
    effect,
    effect.flags[SYSTEM_ID].activeApplication,
    changes
  );

  assert.equal(evaluations, 0);
  assert.deepEqual(update?.["system.changes"], []);
  assert.equal(update?.[`flags.${SYSTEM_ID}.activeApplication.signature`], "[]");
});

test("source-mode aura snapshots both branches while target mode evaluates the recipient", async () => {
  const sourceFunction = createRuntimeDistributedAuraEffect(
    createRuntimeAuraActor("runtime-snapshot-source"),
    createRuntimeAuraToken(createRuntimeAuraActor("runtime-snapshot-token-actor"), "snapshot-source"),
    { changeEvaluation: "source", changeValue: "source-value" }
  ).flags[SYSTEM_ID].activeApplication.functionData;
  sourceFunction.penalties = [change(
    "runtime-aura-penalty",
    "system.resources.actionPoints.bonus",
    "source-penalty"
  )];
  const prepared = prepareActiveApplicationAuraFunctionData(sourceFunction, {
    changeEvaluation: "source",
    prepareChange: entry => ({
      ...entry,
      value: entry.value === "source-value" ? 17 : -17
    })
  });
  assert.equal(prepared.changes[0].value, 17);
  assert.equal(prepared.penalties[0].value, -17);

  const carrier = createRuntimeAuraActor("runtime-target-formula-carrier");
  const target = createRuntimeAuraActor("runtime-target-formula-recipient");
  carrier.system.resources.actionPoints = { value: 4 };
  target.system.resources.actionPoints = { value: 9 };
  const carrierToken = createRuntimeAuraToken(carrier, "target-formula-carrier", 0, 0);
  const targetToken = createRuntimeAuraToken(target, "target-formula-recipient", 100, 0);
  const sourceEffect = createRuntimeDistributedAuraEffect(carrier, carrierToken, {
    changeEvaluation: "target",
    changeValue: "@resources.actionPoints.value"
  });
  carrier.effects.push(sourceEffect);
  const previousTokens = canvas.tokens.placeables;
  canvas.tokens.placeables = [carrierToken, targetToken];

  try {
    await syncAuraGeneratedEffects();
    assert.equal(getGeneratedAuraEffects(target)[0]?.system.changes[0]?.value, 9);
  } finally {
    canvas.tokens.placeables = previousTokens;
  }
});

test("temporary aura preserves trigger chance and trigger cost without its Item", async () => {
  const carrier = createRuntimeAuraActor("runtime-metadata-carrier");
  const target = createRuntimeAuraActor("runtime-metadata-target");
  const carrierToken = createRuntimeAuraToken(carrier, "metadata-carrier", 0, 0);
  const targetToken = createRuntimeAuraToken(target, "metadata-target", 100, 0);
  const sourceEffect = createRuntimeDistributedAuraEffect(carrier, carrierToken);
  const functionData = sourceEffect.flags[SYSTEM_ID].activeApplication.functionData;
  functionData.conditions.push(
    condition("runtime-trigger-chance", ABILITY_CONDITION_TYPES.triggerChance, {
      chanceFormula: "100"
    }),
    condition("runtime-trigger-cost", ABILITY_CONDITION_TYPES.triggerCost, {
      costs: [{
        id: "runtime-ap-cost",
        resourceKey: "actionPoints",
        formula: "1"
      }]
    })
  );
  functionData.penalties = [change(
    "runtime-failed-chance",
    "system.resources.actionPoints.bonus",
    "-9"
  )];
  carrier.effects.push(sourceEffect);
  const previousTokens = canvas.tokens.placeables;
  canvas.tokens.placeables = [carrierToken, targetToken];

  try {
    await syncAuraGeneratedEffects();
    const [projection] = getGeneratedAuraEffects(target);
    assert.equal(projection?.system.changes[0]?.value, 2);
    assert.deepEqual(
      projection?.flags[SYSTEM_ID].auraGenerated.triggerCost?.costs
        .map(cost => [cost.resourceKey, cost.formula]),
      [["actionPoints", "1"]]
    );
    assert.equal(
      projection?.flags[SYSTEM_ID].auraGenerated.triggerCost?.sourceItemUuid,
      "Actor.missing.Item.missing-source-item"
    );
  } finally {
    canvas.tokens.placeables = previousTokens;
  }
});

test("Trial-routed primary changes are not also distributed by an aura", async () => {
  const carrier = createRuntimeAuraActor("runtime-trial-carrier");
  const target = createRuntimeAuraActor("runtime-trial-target");
  const carrierToken = createRuntimeAuraToken(carrier, "trial-carrier", 0, 0);
  const targetToken = createRuntimeAuraToken(target, "trial-target", 100, 0);
  const sourceEffect = createRuntimeDistributedAuraEffect(carrier, carrierToken);
  sourceEffect.flags[SYSTEM_ID].activeApplication.functionData.conditions.push(condition(
    "runtime-routed-trial",
    ABILITY_CONDITION_TYPES.trial,
    { trialRoutesPrimaryChanges: true }
  ));
  carrier.effects.push(sourceEffect);
  const previousTokens = canvas.tokens.placeables;
  canvas.tokens.placeables = [carrierToken, targetToken];

  try {
    await syncAuraGeneratedEffects();
    assert.equal(getGeneratedAuraEffects(target).length, 0);
  } finally {
    canvas.tokens.placeables = previousTokens;
  }
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

test("stale projection cleanup uses one silent deduplicated Actor batch", async () => {
  const harness = createProjectionSyncHarness([]);
  const normalAbility = harness.addEffect(staleProjectionData({
    [ABILITY_EFFECT_FLAG_KEY]: {
      abilityItemId: "removed-ability",
      signature: "ability-signature",
      auraCondition: false
    }
  }), "normal-ability");
  const auraItem = harness.addEffect(staleProjectionData({
    [ITEM_EFFECT_FLAG_KEY]: {
      itemId: "removed-item",
      signature: "item-signature",
      auraCondition: true
    }
  }), "aura-item");
  const mixedAura = harness.addEffect(staleProjectionData({
    [ABILITY_EFFECT_FLAG_KEY]: {
      abilityItemId: "removed-mixed-ability",
      signature: "mixed-ability-signature",
      auraCondition: false
    },
    [ITEM_EFFECT_FLAG_KEY]: {
      itemId: "removed-mixed-item",
      signature: "mixed-item-signature",
      auraCondition: true
    }
  }), "mixed-aura");
  const normalEquipment = harness.addEffect(staleProjectionData({
    [EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY]: {
      itemId: "removed-equipment",
      signature: "equipment-signature"
    }
  }), "normal-equipment");
  harness.resetOperations();

  await syncActorAbilityEffects(harness.actor);

  assert.deepEqual(harness.operationCounts(), { creates: 0, updates: 0, deletes: 4 });
  assert.equal(harness.operations.deletes.length, 1);
  assert.deepEqual(
    harness.operations.deletes[0].ids,
    [normalAbility.id, mixedAura.id, auraItem.id, normalEquipment.id]
  );
  assert.deepEqual(harness.operations.deletes[0].options, {
    falloutMawAbilityEffectSync: true,
    animate: false
  });
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

function staleProjectionData(systemFlags) {
  return {
    type: "base",
    name: "Stale projection",
    img: "stale.webp",
    origin: "",
    transfer: false,
    disabled: false,
    showIcon: 1,
    system: { changes: [] },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        ...systemFlags
      }
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

function abilityItem(id, value) {
  return {
    id,
    uuid: `Actor.projection-actor.Item.${id}`,
    type: "ability",
    name: `Ability ${id}`,
    img: `${id}.webp`,
    flags: {},
    system: {
      functions: [{
        id: `${id}-function`,
        type: ABILITY_FUNCTION_TYPES.effectChanges,
        includeInPureValues: false,
        changes: [change(`${id}-change`, "system.resources.actionPoints.bonus", value)],
        conditions: [],
        penalties: []
      }]
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async update() {
      throw new Error("a passive projection source must not update transition state");
    }
  };
}

function freeSettingsEquipmentItem(id, value, requiredStrength) {
  return {
    id,
    uuid: `Actor.projection-actor.Item.${id}`,
    type: "gear",
    name: `Gear ${id}`,
    img: `${id}.webp`,
    flags: {},
    system: {
      equipped: true,
      occupiedSlots: {},
      placement: { mode: "equipment" },
      functions: {
        freeSettings: {
          enabled: true,
          entries: [{
            id: `${id}-free-function`,
            type: ABILITY_FUNCTION_TYPES.effectChanges,
            includeInPureValues: false,
            changes: [change(`${id}-free-change`, "system.resources.actionPoints.bonus", value)],
            conditions: [],
            penalties: []
          }]
        },
        damageMitigation: {
          enabled: true,
          requirements: [{
            id: `${id}-requirement`,
            type: "characteristic",
            key: "strength",
            value: requiredStrength
          }]
        }
      }
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async update() {
      throw new Error("a passive projection source must not update transition state");
    }
  };
}

function createProjectionSyncHarness(sourceItems = [], actorSystem = {}) {
  const documents = new Map();
  let nextEffectId = 0;
  const operations = {
    creates: [],
    updates: [],
    deletes: []
  };
  const effects = {
    get size() {
      return documents.size;
    },
    get(id) {
      return documents.get(id);
    },
    has(id) {
      return documents.has(id);
    },
    set(id, effect) {
      documents.set(id, effect);
      return this;
    },
    delete(id) {
      return documents.delete(id);
    },
    values() {
      return documents.values();
    },
    filter(predicate) {
      return Array.from(documents.values()).filter(predicate);
    },
    some(predicate) {
      return Array.from(documents.values()).some(predicate);
    },
    [Symbol.iterator]() {
      return documents.values();
    }
  };
  const items = Array.from(sourceItems);
  items.contents = items;
  items.get = id => items.find(item => item.id === id);
  const actor = {
    id: "projection-actor",
    uuid: "Actor.projection-actor",
    type: "character",
    flags: {},
    effects,
    items,
    itemTypes: {
      ability: items.filter(item => item.type === "ability"),
      gear: items.filter(item => item.type === "gear")
    },
    system: {
      creature: { raceId: "" },
      limbs: {},
      resources: {},
      characteristics: {},
      skills: {},
      development: {},
      ...actorSystem
    },
    allApplicableEffects() {
      return [];
    },
    getFlag() {
      return undefined;
    },
    async update() {
      throw new Error("the projection fixture must not update Actor flags");
    },
    async createEmbeddedDocuments(documentName, data, options = {}) {
      assert.equal(documentName, "ActiveEffect");
      const created = data.map(row => addEffect(row));
      operations.creates.push({ ids: created.map(effect => effect.id), data, options });
      return created;
    },
    async deleteEmbeddedDocuments(documentName, ids, options = {}) {
      assert.equal(documentName, "ActiveEffect");
      operations.deletes.push({ ids: Array.from(ids), options });
      for (const id of ids) documents.delete(id);
      return [];
    }
  };
  for (const item of items) item.parent = actor;

  function addEffect(data, id = `projection-effect-${++nextEffectId}`) {
    const source = structuredClone(data);
    const effect = {
      id,
      _id: id,
      uuid: `${actor.uuid}.ActiveEffect.${id}`,
      parent: actor,
      ...source,
      getFlag(scope, key) {
        return this.flags?.[scope]?.[key];
      },
      toObject() {
        const {
          id: _idValue,
          _id,
          _source,
          uuid,
          parent,
          getFlag,
          toObject,
          update,
          ...documentData
        } = this;
        return structuredClone(documentData);
      },
      async update(patch, options = {}) {
        operations.updates.push({ id: this.id, patch, options });
        applyDocumentPatch(this, patch);
        if (this._source) applyDocumentPatch(this._source, patch);
        return this;
      }
    };
    documents.set(id, effect);
    return effect;
  }

  return {
    actor,
    effects,
    operations,
    addEffect,
    findEffect(flagKey) {
      return Array.from(documents.values())
        .find(effect => effect.getFlag(SYSTEM_ID, flagKey));
    },
    resetOperations() {
      operations.creates.length = 0;
      operations.updates.length = 0;
      operations.deletes.length = 0;
    },
    operationCounts() {
      return {
        creates: operations.creates.reduce((count, operation) => count + operation.ids.length, 0),
        updates: operations.updates.length,
        deletes: operations.deletes.reduce((count, operation) => count + operation.ids.length, 0)
      };
    }
  };
}

function applyDocumentPatch(document, patch) {
  for (const [path, value] of Object.entries(patch ?? {})) {
    if (value === globalThis._del) deleteProperty(document, path);
    else setProperty(document, path, structuredClone(value));
  }
}
