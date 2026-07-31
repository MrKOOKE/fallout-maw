import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  }
};

const {
  eventReactionCombatAllows,
  eventReactionSkillKeysMatch,
  eventReactionSubscriptionMatches,
  eventReactionTrackingTargetsMatch,
  getEventTrackingRelation
} = await import("../src/events/event-reaction-schema.mjs");
const {
  collectActiveSceneReactorActors,
  collectEventReactionReactorActors,
  collectEventReactionCandidates,
  evaluateEventReactionSecondaryConditions
} = await import("../src/events/event-reaction-scanner.mjs");
const {
  REACTION_COST_FAILURES,
  STRICT_REACTION_RESOURCE_UPDATE_OPTION,
  applyReactionHealthCost,
  createResourceCostRegistry,
  spendActorResourceCostVector
} = await import("../src/events/reaction-costs.mjs");
const {
  buildAccumulatorEffectChanges,
  buildEventReactionEffectData,
  buildNextAccumulatorState,
  createEventReactionEffectManager,
  getEventReactionEffectFlag,
  hasAbilityFunctionEventEffectOutput
} = await import("../src/events/reaction-effects.mjs");
const {
  createGenericEventReactionProvider,
  buildEventReactionCostLines
} = await import("../src/events/event-reaction-provider.mjs");
const {
  getSystemEventGroupKey,
  getSystemEventNumericValue
} = await import("../src/events/event-values.mjs");
const {
  normalizeAbilityAccumulation,
  normalizeAbilityCondition
} = await import("../src/settings/abilities.mjs");
const { actorStatusAllowsReaction } = await import("../src/combat/incapacitation.mjs");
const {
  ABILITY_OVERLOAD_EFFECT_FLAG_KEY,
  ABILITY_OVERLOAD_REACTION_COST_ID,
  getAbilityOverloadReactionCostId,
  withAbilityOverloadCostRows,
  withAbilityOverloadEnergyCostRows
} = await import("../src/abilities/overload.mjs");
const {
  ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
  getAbilityOverloadCostEffectKey
} = await import("../src/utils/active-effect-changes.mjs");
const { SYSTEM_ID } = await import("../src/constants.mjs");

const EVENT_KEY = "fallout-maw.weapon.attack.targeted";

function applyActorResourceChanges(actor, changes = {}) {
  for (const [path, value] of Object.entries(changes)) {
    const match = /^system\.resources\.([^.]+)\.(value|spent)$/.exec(path);
    if (!match) continue;
    actor.system.resources[match[1]][match[2]] = value;
  }
}

test("event reaction tracking targets match owner, ally, enemy and empty-any", () => {
  const reactor = { uuid: "Actor.A" };
  const ally = { uuid: "Actor.B" };
  const enemy = { uuid: "Actor.C" };
  const resolveRelation = (_reactor, other) => (other.uuid === "Actor.B" ? "ally" : "enemy");

  assert.equal(getEventTrackingRelation(reactor, reactor), "owner");
  assert.equal(getEventTrackingRelation(reactor, ally, { resolveRelation }), "ally");
  assert.equal(getEventTrackingRelation(reactor, enemy, { resolveRelation }), "enemy");

  assert.equal(eventReactionTrackingTargetsMatch({ trackingTargets: [] }, {
    reactorActor: reactor,
    sourceActor: enemy,
    targetActor: ally,
    resolveRelation
  }), true);
  assert.equal(eventReactionTrackingTargetsMatch({ trackingTargets: ["owner"] }, {
    reactorActor: reactor,
    sourceActor: reactor,
    targetActor: ally,
    resolveRelation
  }), true);
  // Subject-only events (skill checks): ally on target must not match.
  assert.equal(eventReactionTrackingTargetsMatch({ trackingTargets: ["ally"] }, {
    reactorActor: reactor,
    sourceActor: enemy,
    targetActor: ally,
    eventKey: "fallout-maw.skill.check.beforeRoll",
    resolveRelation
  }), false);
  // Dual-role events can match via defender/target.
  assert.equal(eventReactionTrackingTargetsMatch({ trackingTargets: ["ally"] }, {
    reactorActor: reactor,
    sourceActor: enemy,
    targetActor: ally,
    eventKey: "fallout-maw.weapon.attack.committed",
    resolveRelation
  }), true);
  assert.equal(eventReactionTrackingTargetsMatch({ trackingTargets: ["enemy"] }, {
    reactorActor: reactor,
    sourceActor: ally,
    targetActor: null,
    resolveRelation
  }), false);
  // Own skill check must not match enemy tracking just because attack target is enemy.
  assert.equal(eventReactionTrackingTargetsMatch({ trackingTargets: ["enemy", "ally", "neutral"] }, {
    reactorActor: reactor,
    sourceActor: reactor,
    targetActor: enemy,
    eventKey: "fallout-maw.skill.check.beforeRoll",
    resolveRelation
  }), false);
});

test("combat-only reactions require an active combat when requested", () => {
  assert.equal(eventReactionCombatAllows({ combatOnly: false }, { inCombat: false }), true);
  assert.equal(eventReactionCombatAllows({ combatOnly: true }, { inCombat: true }), true);
  assert.equal(eventReactionCombatAllows({ combatOnly: true }, { inCombat: false }), false);
});

test("event reaction status permissions default off and remain independent", () => {
  const normalizedDefault = normalizeAbilityCondition({
    id: "event-default-status-policy",
    type: "eventReaction"
  });
  assert.equal(normalizedDefault.allowUnconscious, false);
  assert.equal(normalizedDefault.allowDead, false);

  const normalizedEnabled = normalizeAbilityCondition({
    id: "event-enabled-status-policy",
    type: "eventReaction",
    allowUnconscious: true,
    allowDead: true
  });
  assert.equal(normalizedEnabled.allowUnconscious, true);
  assert.equal(normalizedEnabled.allowDead, true);

  assert.equal(actorStatusAllowsReaction({ statuses: new Set() }), true);
  assert.equal(actorStatusAllowsReaction({ statuses: new Set(["unconscious"]) }), false);
  assert.equal(actorStatusAllowsReaction(
    { statuses: new Set(["unconscious"]) },
    { allowUnconscious: true }
  ), true);
  assert.equal(actorStatusAllowsReaction(
    { statuses: new Set(["dead"]) },
    { allowUnconscious: true }
  ), false);
  assert.equal(actorStatusAllowsReaction(
    { statuses: new Set(["dead"]) },
    { allowDead: true }
  ), true);
  assert.equal(actorStatusAllowsReaction(
    { statuses: new Set(["stunned"]) },
    { allowUnconscious: true, allowDead: true }
  ), true);
});

test("event subscription requires an exact stable event key", () => {
  const envelope = {
    key: EVENT_KEY,
    source: { actorUuid: "Actor.A" },
    target: { actorUuid: "Actor.B" }
  };
  assert.equal(eventReactionSubscriptionMatches(
    { eventKey: EVENT_KEY, trackingTargets: ["owner"] },
    envelope,
    "Actor.B",
    { reactorActor: { uuid: "Actor.B" }, sourceActor: { uuid: "Actor.A" }, targetActor: { uuid: "Actor.B" } }
  ), true);
  assert.equal(eventReactionSubscriptionMatches(
    { eventKey: `${EVENT_KEY}.other`, trackingTargets: ["owner"] },
    envelope,
    "Actor.B",
    { reactorActor: { uuid: "Actor.B" }, sourceActor: { uuid: "Actor.A" }, targetActor: { uuid: "Actor.B" } }
  ), false);
});

test("skill-check reactions can filter by skill keys or accept all", () => {
  const beforeEnvelope = {
    key: "fallout-maw.skill.check.beforeRoll",
    data: { skill: { key: "athletics" } }
  };
  const resolvedEnvelope = {
    key: "fallout-maw.skill.check.resolved",
    data: { skillKey: "guns" }
  };

  assert.equal(eventReactionSkillKeysMatch({ eventKey: beforeEnvelope.key, skillKeys: [] }, beforeEnvelope), true);
  assert.equal(eventReactionSkillKeysMatch({ eventKey: beforeEnvelope.key, skillKeys: ["*"] }, beforeEnvelope), true);
  assert.equal(eventReactionSkillKeysMatch({ eventKey: beforeEnvelope.key, skillKeys: ["athletics"] }, beforeEnvelope), true);
  assert.equal(eventReactionSkillKeysMatch({ eventKey: beforeEnvelope.key, skillKeys: ["guns"] }, beforeEnvelope), false);
  assert.equal(eventReactionSkillKeysMatch({ eventKey: resolvedEnvelope.key, skillKeys: ["guns", "athletics"] }, resolvedEnvelope), true);
  assert.equal(eventReactionSkillKeysMatch({ eventKey: EVENT_KEY, skillKeys: ["guns"] }, { key: EVENT_KEY, data: {} }), true);

  assert.equal(eventReactionSubscriptionMatches(
    { eventKey: beforeEnvelope.key, skillKeys: ["athletics"], trackingTargets: [] },
    beforeEnvelope,
    "Actor.A",
    { reactorActor: { uuid: "Actor.A" }, sourceActor: { uuid: "Actor.A" }, targetActor: null }
  ), true);
  assert.equal(eventReactionSubscriptionMatches(
    { eventKey: beforeEnvelope.key, skillKeys: ["guns"], trackingTargets: [] },
    beforeEnvelope,
    "Actor.A",
    { reactorActor: { uuid: "Actor.A" }, sourceActor: { uuid: "Actor.A" }, targetActor: null }
  ), false);
});

test("active-scene reactor pool includes hidden tokens and deduplicates actors", () => {
  const actorA = { uuid: "Actor.A" };
  const actorB = { uuid: "Actor.B" };
  const scene = { id: "scene" };
  const actors = collectActiveSceneReactorActors({
    scene,
    tokens: [
      { actor: actorA, document: { parent: scene, hidden: false } },
      { actor: actorA, document: { parent: scene, hidden: true } },
      { actor: actorB, document: { parent: scene, hidden: true } },
      { actor: { uuid: "Actor.Elsewhere" }, document: { parent: { id: "other" } } }
    ]
  });
  assert.deepEqual(actors.map(actor => actor.uuid), ["Actor.A", "Actor.B"]);
});

test("reactor pool includes off-scene semantic-event participants", async () => {
  const sceneActor = { uuid: "Actor.Scene" };
  const targetActor = { uuid: "Actor.Target" };
  const actors = await collectEventReactionReactorActors({
    source: {},
    target: { actorUuid: targetActor.uuid }
  }, {
    resolveUuid: uuid => uuid === targetActor.uuid ? targetActor : null,
    scene: { id: "scene" },
    tokens: [{ actor: sceneActor }]
  });
  assert.deepEqual(actors.map(actor => actor.uuid).sort(), ["Actor.Scene", "Actor.Target"]);
});

test("scanner supports owned abilities, active gear, tracking OR subscriptions, and unique actors", async () => {
  const actor = { uuid: "Actor.C", items: [] };
  const ability = createSourceItem(actor, {
    id: "ability",
    uuid: "Actor.C.Item.ability",
    type: "ability",
    functions: [eventFunction({ id: "observer", trackingTargets: [[], ["enemy"]] })]
  });
  const activeGear = createSourceItem(actor, {
    id: "gear-active",
    uuid: "Actor.C.Item.gear-active",
    type: "gear",
    equipped: true,
    functions: [eventFunction({ id: "gear-reaction", trackingTargets: [[]] })]
  });
  const inactiveGear = createSourceItem(actor, {
    id: "gear-inactive",
    uuid: "Actor.C.Item.gear-inactive",
    type: "gear",
    functions: [eventFunction({ id: "inactive", trackingTargets: [[]] })]
  });
  actor.items = [ability, activeGear, inactiveGear];
  const envelope = eventEnvelope();
  const candidates = await collectEventReactionCandidates({
    envelope,
    reactors: [actor, actor],
    normalizeFunctions: functions => functions,
    conditionEvaluator: () => true,
    resolveUuid: async () => null
  });
  assert.deepEqual(candidates.map(candidate => candidate.functionId), ["observer", "gear-reaction"]);
  assert.equal(new Set(candidates.map(candidate => candidate.actorUuid)).size, 1);
});

test("secondary filters retain AND/OR groups, explicit subjects, and ignore incompatible saved rows", async () => {
  const reactor = { uuid: "Actor.C", system: { marker: "reactor" } };
  const sourceActor = { uuid: "Actor.A", system: { marker: "source" } };
  const targetActor = { uuid: "Actor.B", system: { marker: "target" } };
  const warnings = [];
  const abilityFunction = eventFunction({
    id: "filters",
    trackingTargets: [[]],
    extraConditions: [
      { id: "standalone", groupId: "", type: "healthPercent", eventSubject: "eventTarget", expected: "target" },
      { id: "or-false", groupId: "g", type: "targetRace", eventSubject: "eventSource", expected: "wrong" },
      { id: "or-true", groupId: "g", type: "occupiedCover", eventSubject: "reactor", expected: "reactor" },
      { id: "ignored", groupId: "", type: "cooldown" }
    ]
  });
  const applies = await evaluateEventReactionSecondaryConditions({
    reactor,
    abilityFunction,
    envelope: eventEnvelope(),
    participants: { sourceActor, targetActor, sourceToken: null, targetToken: null, reactorTokens: [] },
    conditionEvaluator: (subject, condition) => subject.system.marker === condition.expected,
    warn: warning => warnings.push(warning)
  });
  assert.equal(applies, true);
  assert.deepEqual(warnings.map(warning => warning.type), ["cooldown"]);

  const missingTarget = await evaluateEventReactionSecondaryConditions({
    reactor,
    abilityFunction: eventFunction({
      id: "missing",
      trackingTargets: [[]],
      extraConditions: [{ id: "target", groupId: "", type: "healthPercent", eventSubject: "eventTarget" }]
    }),
    envelope: eventEnvelope(),
    participants: { sourceActor, targetActor: null, sourceToken: null, targetToken: null, reactorTokens: [] },
    conditionEvaluator: () => true,
    warn: () => undefined
  });
  assert.equal(missingTarget, false);
});

test("event functions are completely excluded from passive effect and penalty evaluation", async () => {
  globalThis.foundry = {
    applications: {
      api: { DialogV2: {} },
      ux: { FormDataExtended: class {} },
      handlebars: { renderTemplate: () => "" }
    },
    utils: { randomID: () => "generated" }
  };
  globalThis.game = {};
  const { getAbilityEffectChangesFromFunctions } = await import("../src/abilities/evaluation.mjs");
  const changes = getAbilityEffectChangesFromFunctions({ uuid: "Actor.C" }, [{
    id: "event-function",
    type: "effectChanges",
    reactionSettings: { durationSeconds: 0, costs: [] },
    changes: [{ id: "change", key: "system.test", type: "add", value: "1", phase: "initial", priority: null }],
    penalties: [{ id: "penalty", key: "system.test", type: "add", value: "-1", phase: "initial", priority: null }],
    conditions: [
      { id: "event", groupId: "or", type: "eventReaction", eventKey: EVENT_KEY, trackingTargets: [] },
      { id: "ordinary", groupId: "or", type: "healthPercent", operator: "gte", percent: 0 }
    ]
  }]);
  assert.deepEqual(changes, []);
});

test("resource quote sums duplicate keys, truncates formulas, and blocks invalid or unknown costs", async () => {
  const actor = { uuid: "Actor.C", resources: { actionPoints: 10, health: 5 } };
  const adapter = {
    getAvailable: (subject, definition) => subject.resources[definition.key],
    spend: async () => undefined
  };
  const registry = createResourceCostRegistry({
    getResourceDefinitions: () => [
      { key: "actionPoints", label: "AP" },
      { key: "health", label: "HP" }
    ],
    defaultAdapter: adapter,
    evaluateFormula: formula => {
      if (formula === "bad") throw new Error("bad formula");
      return Number(formula);
    },
    logger: { warn: () => undefined, error: () => undefined }
  });
  const quote = await registry.quote(actor, [
    { id: "a", resourceKey: "actionPoints", formula: "2.9" },
    { id: "b", resourceKey: "actionPoints", formula: "3.2" },
    { id: "c", resourceKey: "health", formula: "-8" }
  ]);
  assert.equal(quote.valid, true);
  assert.equal(quote.affordable, true);
  assert.deepEqual(quote.costs.map(({ resourceKey, amount }) => ({ resourceKey, amount })), [
    { resourceKey: "actionPoints", amount: 5 },
    { resourceKey: "health", amount: 0 }
  ]);
  assert.equal((await registry.quote(actor, [{ id: "bad", resourceKey: "actionPoints", formula: "bad" }])).reason,
    REACTION_COST_FAILURES.invalidFormula);
  assert.equal((await registry.quote(actor, [{ id: "empty", resourceKey: "actionPoints", formula: "" }])).reason,
    REACTION_COST_FAILURES.invalidFormula);
  assert.equal((await registry.quote(actor, [{ id: "unknown", resourceKey: "stale", formula: "1" }])).reason,
    REACTION_COST_FAILURES.unknownResourceKey);
});

test("resource execution rejects stale quotes and serializes operations per actor", async () => {
  const actor = { uuid: "Actor.C", resources: { actionPoints: 10 } };
  const order = [];
  const adapter = {
    getAvailable: subject => subject.resources.actionPoints,
    spend: async (subject, amount) => {
      order.push(`start-${amount}`);
      await new Promise(resolve => setTimeout(resolve, amount === 2 ? 15 : 0));
      subject.resources.actionPoints -= amount;
      order.push(`end-${amount}`);
    }
  };
  const registry = createResourceCostRegistry({
    getResourceDefinitions: () => [{ key: "actionPoints", label: "AP" }],
    defaultAdapter: adapter,
    evaluateFormula: formula => Number(formula),
    logger: { warn: () => undefined, error: () => undefined }
  });
  const oldQuote = await registry.quote(actor, [{ id: "row", resourceKey: "actionPoints", formula: "1" }]);
  const stale = await registry.execute(actor, [{ id: "row", resourceKey: "actionPoints", formula: "2" }], {
    expectedFingerprint: oldQuote.fingerprint
  });
  assert.equal(stale.reason, REACTION_COST_FAILURES.staleQuote);

  await Promise.all([
    registry.execute(actor, [{ id: "two", resourceKey: "actionPoints", formula: "2" }]),
    registry.execute(actor, [{ id: "one", resourceKey: "actionPoints", formula: "1" }])
  ]);
  assert.deepEqual(order, ["start-2", "end-2", "start-1", "end-1"]);
});

test("resource execution releases the actor lock before a nested reaction workflow", async () => {
  const actor = { uuid: "Actor.C", resources: { actionPoints: 10 } };
  const order = [];
  const adapter = {
    getAvailable: subject => subject.resources.actionPoints,
    spend: async (subject, amount) => {
      subject.resources.actionPoints -= amount;
      order.push(`spend-${amount}`);
    }
  };
  const registry = createResourceCostRegistry({
    getResourceDefinitions: () => [{ key: "actionPoints", label: "AP" }],
    defaultAdapter: adapter,
    evaluateFormula: formula => Number(formula),
    logger: { warn: () => undefined, error: () => undefined }
  });

  const outer = registry.execute(actor, [{ id: "outer", resourceKey: "actionPoints", formula: "2" }], {
    rootId: "same-root",
    afterSpend: async () => {
      order.push("nested-start");
      const nested = await registry.execute(actor, [{ id: "inner", resourceKey: "actionPoints", formula: "1" }], {
        rootId: "nested-root"
      });
      assert.equal(nested.ok, true);
      order.push("nested-end");
    }
  });
  const result = await Promise.race([
    outer,
    new Promise((_, reject) => setTimeout(() => reject(new Error("nested actor lock deadlocked")), 100))
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(order, ["spend-2", "nested-start", "spend-1", "nested-end"]);
  assert.equal(actor.resources.actionPoints, 7);
});

test("ordinary vector uses one Actor update, strictly suppresses RP conversion, then pays health", async () => {
  const calls = [];
  const actor = {
    uuid: "Actor.C",
    system: {
      resources: {
        actionPoints: { value: 7, min: 0, max: 10 },
        reactionPoints: { value: 4, min: 0, max: 5 },
        health: { value: 9, min: 0, max: 10 }
      }
    },
    async update(updates, options) {
      calls.push({ updates, options });
      applyActorResourceChanges(this, updates);
    }
  };
  const healthCalls = [];
  await spendActorResourceCostVector(actor, [
    { resourceKey: "actionPoints", amount: 2 },
    { resourceKey: "reactionPoints", amount: 3 },
    { resourceKey: "health", amount: 4 }
  ], {
    context: { rootId: "root" },
    spendHealth: async (subject, amount, context) => healthCalls.push({ subject, amount, context })
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options[STRICT_REACTION_RESOURCE_UPDATE_OPTION], true);
  assert.equal(calls[0].updates["system.resources.actionPoints.value"], 5);
  assert.equal(calls[0].updates["system.resources.reactionPoints.value"], 1);
  assert.equal(healthCalls[0].amount, 4);
  assert.equal(healthCalls[0].context.rootId, "root");
});

test("a cancelled Actor resource update never commits health or the post-spend mutation", async () => {
  const actor = {
    uuid: "Actor.CancelledVector",
    system: {
      resources: {
        actionPoints: { value: 7, min: 0, max: 10, spent: 3 },
        health: { value: 9, min: 0, max: 10 }
      }
    },
    async update() {
      return undefined;
    }
  };
  let healthSpent = false;
  let postSpendCommitted = false;

  await assert.rejects(
    spendActorResourceCostVector(actor, [
      { resourceKey: "actionPoints", amount: 2 },
      { resourceKey: "health", amount: 3 }
    ], {
      spendHealth: async () => {
        healthSpent = true;
      },
      afterSpend: async () => {
        postSpendCommitted = true;
      }
    }),
    /cancelled or altered/
  );

  assert.equal(actor.system.resources.actionPoints.value, 7);
  assert.equal(healthSpent, false);
  assert.equal(postSpendCommitted, false);
});

test("a failed atomic post-spend mutation restores both actor resources and health", async () => {
  const updates = [];
  const actor = {
    uuid: "Actor.Atomic",
    system: {
      resources: {
        actionPoints: { value: 7, min: 0, max: 10, spent: 3 },
        health: { value: 9, min: 0, max: 10 }
      }
    },
    async update(changes, options) {
      updates.push({ changes, options });
      applyActorResourceChanges(this, changes);
    }
  };
  const health = [];
  await assert.rejects(
    spendActorResourceCostVector(actor, [
      { resourceKey: "actionPoints", amount: 2 },
      { resourceKey: "health", amount: 3 }
    ], {
      context: { rootId: "weapon-use" },
      spendHealth: async (_actor, amount) => health.push(["spend", amount]),
      restoreHealth: async (_actor, amount) => health.push(["restore", amount]),
      afterSpend: async () => {
        throw new Error("inventory commit failed");
      }
    }),
    /inventory commit failed/
  );
  assert.equal(updates.length, 2);
  assert.equal(updates[0].changes["system.resources.actionPoints.value"], 5);
  assert.equal(updates[1].changes["system.resources.actionPoints.value"], 7);
  assert.equal(updates[1].changes["system.resources.actionPoints.spent"], 3);
  assert.deepEqual(health, [["spend", 3], ["restore", 3]]);
});

test("health cost selects the reentrant Damage Hub path only for a current operation", async () => {
  const calls = [];
  const adapters = {
    applyInCurrentOperation: (requests, time) => calls.push({ kind: "current", requests, time }),
    requestApplication: request => calls.push({ kind: "queued", request })
  };
  await applyReactionHealthCost({ amount: 3 }, { inDamageHubOperation: true, logicalWorldTime: 42 }, adapters);
  await applyReactionHealthCost({ amount: 2 }, {}, adapters);
  assert.deepEqual(calls.map(call => call.kind), ["current", "queued"]);
  assert.equal(calls[0].requests[0].amount, 3);
  assert.equal(calls[0].time, 42);
});

test("managed effects use native v14 duration, stack timed effects per root, and isolate parallel roots", async () => {
  let worldTime = 100;
  let nextId = 1;
  const actor = { uuid: "Actor.C", effects: [] };
  const manager = createEventReactionEffectManager({
    resolveActor: async () => actor,
    listActors: () => [actor],
    worldTime: () => worldTime,
    createEffects: async (subject, entries) => {
      const created = entries.map(data => createEffectDocument(`effect-${nextId++}`, data));
      subject.effects.push(...created);
      return created;
    },
    updateEffect: async (effect, data) => {
      Object.assign(effect, data);
      return effect;
    },
    deleteEffects: async (subject, ids) => {
      subject.effects = subject.effects.filter(effect => !ids.includes(effect.id));
    }
  });
  const sourceItem = { uuid: "Actor.C.Item.ability", name: "Reaction", img: "reaction.webp" };
  const abilityFunction = eventFunction({ id: "effect" });
  abilityFunction.changes = [{ key: "system.test", value: "1", type: "add", phase: "initial" }];

  await manager.apply({ actor, sourceItem, abilityFunction, envelope: eventEnvelope({ rootId: "root-a", eventId: "event-a" }) });
  await manager.apply({ actor, sourceItem, abilityFunction, envelope: eventEnvelope({ rootId: "root-b", eventId: "event-b" }) });
  assert.equal(actor.effects.length, 2);
  assert.equal(actor.effects.every(effect => effect.duration.value === null), true);
  await manager.cleanupRoot("root-a");
  assert.equal(actor.effects.length, 1);
  assert.equal(getEventReactionEffectFlag(actor.effects[0]).rootId, "root-b");

  abilityFunction.conditions.push({
    id: "effect-duration",
    groupId: "",
    type: "duration",
    durationSeconds: 12
  });
  worldTime = 200;
  await manager.apply({ actor, sourceItem, abilityFunction, envelope: eventEnvelope({ rootId: "root-c", eventId: "event-c" }) });
  worldTime = 205;
  await manager.apply({ actor, sourceItem, abilityFunction, envelope: eventEnvelope({ rootId: "root-d", eventId: "event-d" }) });
  const timed = actor.effects.filter(effect => getEventReactionEffectFlag(effect)?.scope === "timed");
  assert.equal(timed.length, 2);
  assert.deepEqual(timed.map(effect => effect.start.time).sort((a, b) => a - b), [200, 205]);
  assert.deepEqual(
    timed.map(effect => getEventReactionEffectFlag(effect).rootId).sort(),
    ["root-c", "root-d"]
  );
});

test("root cleanup is O(1) when the root never created a managed effect", async () => {
  let listCalls = 0;
  let resolveCalls = 0;
  const manager = createEventReactionEffectManager({
    listActors: () => {
      listCalls += 1;
      return [];
    },
    resolveActor: async () => {
      resolveCalls += 1;
      return null;
    }
  });

  assert.equal(await manager.cleanupRoot("ordinary-attack-root"), 0);
  assert.equal(listCalls, 0);
  assert.equal(resolveCalls, 0);
});

test("root cleanup resolves only actors and effect ids tracked by that root", async () => {
  let listCalls = 0;
  const resolvedActorUuids = [];
  const deleted = [];
  const trackedActor = { uuid: "Actor.Tracked", effects: [] };
  const unrelatedActor = { uuid: "Actor.Unrelated", effects: [] };
  const manager = createEventReactionEffectManager({
    resolveActor: async uuid => {
      resolvedActorUuids.push(uuid);
      return uuid === trackedActor.uuid ? trackedActor : null;
    },
    listActors: () => {
      listCalls += 1;
      return [trackedActor, unrelatedActor];
    },
    createEffects: async (subject, entries) => {
      const created = entries.map(data => createEffectDocument("tracked-effect", data));
      subject.effects.push(...created);
      return created;
    },
    deleteEffects: async (subject, ids) => {
      deleted.push(...ids);
      subject.effects = subject.effects.filter(effect => !ids.includes(effect.id));
    }
  });
  const abilityFunction = eventFunction({ id: "tracked-cleanup" });
  abilityFunction.changes = [{ key: "system.test", value: "1", type: "add", phase: "initial" }];

  await manager.apply({
    actor: trackedActor,
    sourceItem: { uuid: "Actor.Tracked.Item.ability", name: "Reaction" },
    abilityFunction,
    envelope: eventEnvelope({ rootId: "root-addressed", eventId: "event-addressed" })
  });
  unrelatedActor.effects.push(createEffectDocument("unrelated-effect", buildEventReactionEffectData({
    reactor: unrelatedActor,
    sourceItem: { uuid: "Actor.Unrelated.Item.ability", name: "Other" },
    abilityFunction,
    envelope: eventEnvelope({ rootId: "root-addressed", eventId: "event-unrelated" }),
    durationSeconds: 0
  })));

  assert.equal(await manager.cleanupRoot("root-addressed"), 1);
  assert.equal(listCalls, 0);
  assert.deepEqual(resolvedActorUuids, [trackedActor.uuid]);
  assert.deepEqual(deleted, ["tracked-effect"]);
  assert.deepEqual(unrelatedActor.effects.map(effect => effect.id), ["unrelated-effect"]);
});

test("accumulating event effect keeps one timer and grants typed resistance to all limbs", async () => {
  let worldTime = 100;
  let nextId = 1;
  let updateCount = 0;
  const actor = { uuid: "Actor.C", effects: [] };
  const manager = createEventReactionEffectManager({
    worldTime: () => worldTime,
    createEffects: async (subject, entries) => {
      const created = entries.map(data => createEffectDocument(`accumulator-${nextId++}`, data));
      subject.effects.push(...created);
      return created;
    },
    updateEffect: async (effect, data) => {
      updateCount += 1;
      Object.assign(effect, structuredClone(data));
      return effect;
    },
    deleteEffects: async (subject, ids) => {
      subject.effects = subject.effects.filter(effect => !ids.includes(effect.id));
    }
  });
  const sourceItem = {
    uuid: "Actor.C.Item.adaptation",
    name: "Adaptation",
    img: "adaptation.webp",
    system: {}
  };
  const abilityFunction = accumulatingDamageFunction();

  await manager.apply({
    actor,
    sourceItem,
    abilityFunction,
    envelope: damageEnvelope({ eventId: "damage-1", damageTypeKey: "firearm", healthLoss: 100 })
  });
  assert.equal(actor.effects.length, 1);
  assert.equal(actor.effects[0].start.time, 100);
  assert.equal(actor.effects[0].duration.value, 86400);
  assert.deepEqual(actor.effects[0].system.changes, [{
    key: "system.damageResistanceBonuses.all.firearm",
    type: "add",
    value: "10",
    phase: "initial",
    priority: 0
  }]);

  worldTime = 200;
  await manager.apply({
    actor,
    sourceItem,
    abilityFunction,
    envelope: damageEnvelope({ eventId: "damage-2", damageTypeKey: "firearm", healthLoss: 50 })
  });
  await manager.apply({
    actor,
    sourceItem,
    abilityFunction,
    envelope: damageEnvelope({ eventId: "damage-3", damageTypeKey: "piercing", healthLoss: 100 })
  });
  assert.equal(actor.effects.length, 1);
  assert.equal(actor.effects[0].start.time, 100);
  assert.equal(actor.effects[0].duration.value, 86400);
  assert.deepEqual(
    Object.fromEntries(actor.effects[0].system.changes.map(change => [change.key, change.value])),
    {
      "system.damageResistanceBonuses.all.firearm": "15",
      "system.damageResistanceBonuses.all.piercing": "10"
    }
  );

  const updatesBeforeDuplicate = updateCount;
  await manager.apply({
    actor,
    sourceItem,
    abilityFunction,
    envelope: damageEnvelope({ eventId: "damage-3", damageTypeKey: "piercing", healthLoss: 100 })
  });
  assert.equal(updateCount, updatesBeforeDuplicate);

  await manager.apply({
    actor,
    sourceItem,
    abilityFunction,
    envelope: damageEnvelope({ eventId: "damage-4", damageTypeKey: "slashing", healthLoss: 1000 })
  });
  const accumulated = getEventReactionEffectFlag(actor.effects[0])
    .accumulators["adaptive-accumulation"];
  assert.deepEqual(accumulated.buckets, { firearm: 15, piercing: 10, slashing: 25 });
  assert.equal(accumulated.total, 50);
  assert.equal(actor.effects[0].start.time, 100);

  const updatesAtCap = updateCount;
  await manager.apply({
    actor,
    sourceItem,
    abilityFunction,
    envelope: damageEnvelope({ eventId: "damage-5", damageTypeKey: "firearm", healthLoss: 100 })
  });
  assert.equal(updateCount, updatesAtCap);

  worldTime = 86501;
  await manager.apply({
    actor,
    sourceItem,
    abilityFunction,
    envelope: damageEnvelope({ eventId: "damage-6", damageTypeKey: "laser", healthLoss: 20 })
  });
  assert.equal(actor.effects.length, 1);
  assert.equal(actor.effects[0].start.time, 86501);
  assert.deepEqual(
    getEventReactionEffectFlag(actor.effects[0]).accumulators["adaptive-accumulation"].buckets,
    { laser: 2 }
  );
});

test("accumulator retains fractions per damage type before rounding", () => {
  const abilityFunction = accumulatingDamageFunction();
  let state = {};
  for (let index = 0; index < 10; index += 1) {
    const envelope = damageEnvelope({
      eventId: `fraction-${index}`,
      damageTypeKey: "firearm",
      healthLoss: 1
    });
    const next = buildNextAccumulatorState(state, {
      settings: abilityFunction.conditions
        .find(condition => condition.type === "accumulation").accumulation,
      groupKey: "firearm",
      contribution: 0.1
    }, envelope);
    assert.equal(next.changed, true);
    state = next.state;
  }
  assert.equal(state.rawBuckets.firearm, 1);
  assert.equal(state.buckets.firearm, 1);
  assert.equal(state.total, 1);
  assert.equal(hasAbilityFunctionEventEffectOutput(abilityFunction), true);
});

test("accumulator exchange supports grouped templates, aggregate keys, and per-point rates", () => {
  const states = {
    pool: {
      buckets: { firearm: 2, piercing: 3 },
      total: 5
    }
  };
  const changes = buildAccumulatorEffectChanges(states, [{
    key: "system.grouped.{group}",
    type: "add",
    value: "0.5",
    phase: "initial",
    priority: 2,
    valueSource: "accumulation",
    accumulatorExchange: { conditionId: "pool", mode: "invested" }
  }, {
    key: "system.aggregate",
    type: "multiply",
    value: "2",
    phase: "initial",
    priority: 1,
    valueSource: "accumulation",
    accumulatorExchange: { conditionId: "pool", mode: "invested" }
  }]);

  assert.deepEqual(changes, [{
    key: "system.aggregate",
    type: "multiply",
    value: "10",
    phase: "initial",
    priority: 1
  }, {
    key: "system.grouped.firearm",
    type: "add",
    value: "1",
    phase: "initial",
    priority: 2
  }, {
    key: "system.grouped.piercing",
    type: "add",
    value: "1.5",
    phase: "initial",
    priority: 2
  }]);
});

test("accumulator settings normalize safely and actual health loss does not count overkill fallback", () => {
  assert.deepEqual(normalizeAbilityAccumulation({
    percent: "10",
    totalCap: "50",
    bucketCap: "-2"
  }), {
    name: "",
    valueSource: "damageActualHealthLoss",
    percent: 10,
    groupBy: "damageType",
    totalCap: 50,
    bucketCap: 0,
    rounding: "floorTotal",
    durationPolicy: "fromFirst"
  });
  assert.equal(getSystemEventNumericValue("damageActualHealthLoss", {
    data: { result: { amount: 100, healthDelta: 0 } },
    delta: { health: 0 }
  }), 0);
  assert.equal(getSystemEventNumericValue("damageAfterMitigation", {
    data: { result: { amount: 4, preBarrierAmount: 12, barrierAbsorbed: 8 } }
  }), 12);
  assert.equal(getSystemEventNumericValue("damageBarrierAbsorbed", {
    data: { result: { barrierAbsorbed: 8 } }
  }), 8);
  assert.equal(getSystemEventNumericValue("damageAfterBarrier", {
    data: { result: { amountAfterBarrier: 4 } }
  }), 4);
  assert.equal(getSystemEventGroupKey("none", {}), "all");
});

test("parallel damage roots cannot lose accumulator buckets or create duplicate effects", async () => {
  let nextId = 1;
  const actor = { uuid: "Actor.Concurrent", effects: [] };
  const manager = createEventReactionEffectManager({
    worldTime: () => 10,
    createEffects: async (subject, entries) => {
      await new Promise(resolve => setTimeout(resolve, 2));
      const created = entries.map(data => createEffectDocument(`parallel-${nextId++}`, data));
      subject.effects.push(...created);
      return created;
    },
    updateEffect: async (effect, data) => {
      await new Promise(resolve => setTimeout(resolve, 2));
      Object.assign(effect, structuredClone(data));
      return effect;
    },
    deleteEffects: async (subject, ids) => {
      subject.effects = subject.effects.filter(effect => !ids.includes(effect.id));
    }
  });
  const sourceItem = { uuid: "Actor.Concurrent.Item.adaptation", name: "Adaptation", system: {} };
  const abilityFunction = accumulatingDamageFunction();
  await Promise.all([
    manager.apply({
      actor,
      sourceItem,
      abilityFunction,
      envelope: damageEnvelope({ rootId: "parallel-a", eventId: "parallel-fire", damageTypeKey: "firearm", healthLoss: 100 })
    }),
    manager.apply({
      actor,
      sourceItem,
      abilityFunction,
      envelope: damageEnvelope({ rootId: "parallel-b", eventId: "parallel-cut", damageTypeKey: "slashing", healthLoss: 100 })
    })
  ]);
  assert.equal(actor.effects.length, 1);
  assert.deepEqual(getEventReactionEffectFlag(actor.effects[0]).accumulators["adaptive-accumulation"].buckets, {
    firearm: 10,
    slashing: 10
  });
});

test("accumulating reaction receives a separate opportunity for each typed event in one root", async () => {
  const actor = { uuid: "Actor.C", items: [], effects: [] };
  const abilityFunction = accumulatingDamageFunction({ eventKey: EVENT_KEY });
  const item = createSourceItem(actor, {
    id: "adaptation",
    uuid: "Actor.C.Item.adaptation",
    type: "ability",
    functions: [abilityFunction]
  });
  actor.items = [item];
  const docs = new Map([[actor.uuid, actor], [item.uuid, item]]);
  const provider = createGenericEventReactionProvider({
    getReactorActors: () => [actor],
    resolveUuid: uuid => docs.get(uuid) ?? null,
    costRegistry: createResourceCostRegistry({
      getResourceDefinitions: () => [],
      evaluateFormula: () => 0
    }),
    effectManager: {
      apply: async () => ({}),
      cleanupRoot: async () => 0,
      cleanupOrphans: async () => 0
    },
    canOfferToActor: (_actor, _envelope, policy) => policy.allowUnconscious && !policy.allowDead,
    conditionEvaluator: () => true,
    normalizeFunctions: functions => functions,
    hasEventKey: async () => false
  });
  const firstEnvelope = damageEnvelope({ rootId: "mixed", eventId: "mixed-fire", damageTypeKey: "firearm", healthLoss: 10, key: EVENT_KEY });
  const secondEnvelope = damageEnvelope({ rootId: "mixed", eventId: "mixed-cut", damageTypeKey: "slashing", healthLoss: 10, key: EVENT_KEY });
  const firstOffers = await provider.collect({
    eventKey: EVENT_KEY,
    context: { envelope: firstEnvelope, eventReactionParticipantIndexed: true }
  });
  assert.equal(firstOffers.length, 1);
  assert.equal(firstOffers[0].passiveAutomatic, true);
  assert.equal(firstOffers[0].allowUnconscious, true);
  assert.equal(firstOffers[0].allowDead, false);
  assert.equal((await provider.collect({
    eventKey: EVENT_KEY,
    context: { envelope: firstEnvelope, eventReactionParticipantIndexed: true }
  })).length, 0);
  assert.equal((await provider.collect({
    eventKey: EVENT_KEY,
    context: { envelope: secondEnvelope, eventReactionParticipantIndexed: true }
  })).length, 1);
});

test("ability overload adds energy cost rows for any use of the same ability", () => {
  const abilityItem = { id: "ability-1", uuid: "Actor.C.Item.ability-1" };
  const actor = {
    effects: [{
      disabled: false,
      system: {
        changes: [{
          key: ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
          type: "add",
          value: "20",
          phase: "initial"
        }]
      },
      flags: {
        [SYSTEM_ID]: {
          [ABILITY_OVERLOAD_EFFECT_FLAG_KEY]: {
            abilityItemId: "ability-1",
            abilitySourceId: "",
            resourceKey: "power"
          }
        }
      },
      getFlag(scope, key) {
        return this.flags?.[scope]?.[key];
      }
    }]
  };
  const rows = withAbilityOverloadEnergyCostRows(actor, abilityItem, { id: "fn" }, [
    { id: "base", resourceKey: "power", formula: "1" }
  ]);
  assert.deepEqual(rows.map(row => ({ id: row.id, resourceKey: row.resourceKey, formula: row.formula })), [
    { id: "base", resourceKey: "power", formula: "1" },
    { id: ABILITY_OVERLOAD_REACTION_COST_ID, resourceKey: "power", formula: "20" }
  ]);
  assert.deepEqual(
    buildEventReactionCostLines(
      { costs: [{ resourceKey: "power", label: "Энергия", amount: 1 }] },
      { costs: [{ resourceKey: "power", label: "Энергия", amount: 21 }] }
    ),
    ["Энергия: 1 базовая / 21 итоговая"]
  );
});

test("ability overload surcharge uses the cost row resource, not only energy", () => {
  const abilityItem = { id: "ability-2", uuid: "Actor.C.Item.ability-2" };
  const actor = {
    effects: [{
      disabled: false,
      system: {
        changes: [{
          key: getAbilityOverloadCostEffectKey("health"),
          type: "add",
          value: "20",
          phase: "initial"
        }]
      },
      flags: {
        [SYSTEM_ID]: {
          [ABILITY_OVERLOAD_EFFECT_FLAG_KEY]: {
            abilityItemId: "ability-2",
            abilitySourceId: "",
            resourceKey: "health"
          }
        }
      },
      getFlag(scope, key) {
        return this.flags?.[scope]?.[key];
      }
    }]
  };
  const rows = withAbilityOverloadCostRows(actor, abilityItem, { id: "fn" }, [
    { id: "base", resourceKey: "health", formula: "1" }
  ]);
  assert.deepEqual(rows.map(row => ({ id: row.id, resourceKey: row.resourceKey, formula: row.formula })), [
    { id: "base", resourceKey: "health", formula: "1" },
    { id: getAbilityOverloadReactionCostId("health"), resourceKey: "health", formula: "20" }
  ]);
  assert.deepEqual(
    buildEventReactionCostLines(
      { costs: [{ resourceKey: "health", label: "Здоровье", amount: 1 }] },
      { costs: [{ resourceKey: "health", label: "Здоровье", amount: 21 }] }
    ),
    ["Здоровье: 1 базовая / 21 итоговая"]
  );
  assert.deepEqual(
    buildEventReactionCostLines(
      { costs: [{ resourceKey: "health", label: "Здоровье", amount: 1 }] },
      { costs: [{ resourceKey: "health", label: "Здоровье", amount: 1 }] }
    ),
    ["Здоровье: 1"]
  );
});

test("legacy energy overload effect without resourceKey flag still surcharges power", () => {
  const abilityItem = { id: "ability-legacy", uuid: "Actor.C.Item.ability-legacy" };
  const actor = {
    effects: [{
      disabled: false,
      system: {
        changes: [{
          key: ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
          type: "add",
          value: "10",
          phase: "initial"
        }]
      },
      flags: {
        [SYSTEM_ID]: {
          [ABILITY_OVERLOAD_EFFECT_FLAG_KEY]: {
            abilityItemId: "ability-legacy",
            abilitySourceId: ""
          }
        }
      },
      getFlag(scope, key) {
        return this.flags?.[scope]?.[key];
      }
    }]
  };
  const rows = withAbilityOverloadCostRows(actor, abilityItem, { id: "fn" }, [
    { id: "base", resourceKey: "power", formula: "2" }
  ]);
  assert.deepEqual(rows.map(row => ({ id: row.id, resourceKey: row.resourceKey, formula: row.formula })), [
    { id: "base", resourceKey: "power", formula: "2" },
    { id: getAbilityOverloadReactionCostId("power"), resourceKey: "power", formula: "10" }
  ]);
});

test("synthetic active-HUD module effects retain module provenance and use a valid host-item origin", () => {
  const actor = {
    uuid: "Actor.C",
    items: new Map([["host", { id: "host", uuid: "Actor.C.Item.host" }]])
  };
  const data = buildEventReactionEffectData({
    reactor: actor,
    sourceItem: {
      uuid: "Actor.C.Item.host.Module.slot-1",
      system: { placement: { mode: "module", parentItemId: "host" } }
    },
    abilityFunction: { id: "module-reaction" },
    envelope: eventEnvelope(),
    durationSeconds: 0
  });
  assert.equal(data.origin, "Actor.C.Item.host");
  assert.equal(data.flags["fallout-maw"].eventReaction.sourceItemUuid, "Actor.C.Item.host.Module.slot-1");
});

test("orphan cleanup removes only root-scoped managed effects", async () => {
  const actor = { uuid: "Actor.C", effects: [] };
  let listCalls = 0;
  const rootData = buildEventReactionEffectData({
    reactor: actor,
    sourceItem: { uuid: "Item.A", name: "A" },
    abilityFunction: { id: "f" },
    envelope: eventEnvelope({ rootId: "orphan", eventId: "e" }),
    durationSeconds: 0
  });
  const timedData = buildEventReactionEffectData({
    reactor: actor,
    sourceItem: { uuid: "Item.B", name: "B" },
    abilityFunction: { id: "f" },
    envelope: eventEnvelope({ rootId: "old", eventId: "e2" }),
    durationSeconds: 5,
    worldTime: 1
  });
  actor.effects = [createEffectDocument("root", rootData), createEffectDocument("timed", timedData)];
  const manager = createEventReactionEffectManager({
    listActors: () => {
      listCalls += 1;
      return [actor];
    },
    resolveActor: async uuid => uuid === actor.uuid ? actor : null,
    deleteEffects: async (subject, ids) => {
      subject.effects = subject.effects.filter(effect => !ids.includes(effect.id));
    }
  });
  assert.equal(await manager.cleanupOrphans([]), 1);
  assert.equal(listCalls, 1);
  assert.deepEqual(actor.effects.map(effect => effect.id), ["timed"]);
});

test("generic provider consumes a declined opportunity for the same operation and event", async () => {
  const actor = { uuid: "Actor.C", items: [] };
  const item = createSourceItem(actor, {
    id: "ability",
    uuid: "Actor.C.Item.ability",
    type: "ability",
    functions: [eventFunction({ id: "generic" })]
  });
  actor.items = [item];
  const docs = new Map([[actor.uuid, actor], [item.uuid, item]]);
  const costRegistry = createResourceCostRegistry({
    getResourceDefinitions: () => [],
    evaluateFormula: () => 0
  });
  const provider = createGenericEventReactionProvider({
    getReactorActors: () => [actor],
    resolveUuid: uuid => docs.get(uuid) ?? null,
    costRegistry,
    effectManager: {
      apply: async () => ({}),
      cleanupRoot: async () => 0,
      cleanupOrphans: async () => 0
    },
    conditionEvaluator: () => true,
    normalizeFunctions: functions => functions,
    hasEventKey: async () => true
  });
  const context = { envelope: eventEnvelope(), chainRef: {} };
  const first = await provider.collect({ eventKey: EVENT_KEY, context });
  const second = await provider.collect({ eventKey: EVENT_KEY, context });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  await provider.cleanupRoot("root");
  assert.equal((await provider.collect({ eventKey: EVENT_KEY, context })).length, 1);
});

test("generic provider consumes one chance across nested operations in the same root", async () => {
  const skillKey = "fallout-maw.skill.check.beforeRoll";
  const actor = { uuid: "Actor.C", items: [] };
  const item = createSourceItem(actor, {
    id: "ability",
    uuid: "Actor.C.Item.ability",
    type: "ability",
    functions: [eventFunction({
      id: "skill-reaction",
      eventKey: skillKey
    })]
  });
  actor.items = [item];
  const docs = new Map([[actor.uuid, actor], [item.uuid, item]]);
  const provider = createGenericEventReactionProvider({
    getReactorActors: () => [actor],
    resolveUuid: uuid => docs.get(uuid) ?? null,
    costRegistry: createResourceCostRegistry({
      getResourceDefinitions: () => [],
      evaluateFormula: () => 0
    }),
    effectManager: {
      apply: async () => ({}),
      cleanupRoot: async () => 0,
      cleanupOrphans: async () => 0
    },
    conditionEvaluator: () => true,
    normalizeFunctions: functions => functions,
    hasEventKey: async () => true
  });
  const parent = await provider.collect({
    eventKey: skillKey,
    context: {
      envelope: eventEnvelope({
        key: skillKey,
        rootId: "shared-root",
        data: { systemEventOperationId: "skill:outer" }
      })
    }
  });
  const nested = await provider.collect({
    eventKey: skillKey,
    context: {
      envelope: eventEnvelope({
        key: skillKey,
        rootId: "shared-root",
        data: { systemEventOperationId: "attack:nested" }
      })
    }
  });
  assert.equal(parent.length, 1);
  assert.equal(nested.length, 0);
});

test("generic provider consumes one chance across skill-check subjects in one operation", async () => {
  const skillKey = "fallout-maw.skill.check.beforeRoll";
  const actor = { uuid: "Actor.C", items: [] };
  const item = createSourceItem(actor, {
    id: "ability",
    uuid: "Actor.C.Item.ability",
    type: "ability",
    functions: [eventFunction({ id: "skill-reaction", eventKey: skillKey })]
  });
  actor.items = [item];
  const docs = new Map([[actor.uuid, actor], [item.uuid, item]]);
  const provider = createGenericEventReactionProvider({
    getReactorActors: () => [actor],
    resolveUuid: uuid => docs.get(uuid) ?? null,
    costRegistry: createResourceCostRegistry({
      getResourceDefinitions: () => [],
      evaluateFormula: () => 0
    }),
    effectManager: {
      apply: async () => ({}),
      cleanupRoot: async () => 0,
      cleanupOrphans: async () => 0
    },
    conditionEvaluator: () => true,
    normalizeFunctions: functions => functions,
    hasEventKey: async () => true
  });
  const first = await provider.collect({
    eventKey: skillKey,
    context: {
      envelope: eventEnvelope({
        key: skillKey,
        rootId: "shared-root",
        source: { actorUuid: "Actor.VictimA" },
        data: { systemEventOperationId: "attack:aoe" }
      })
    }
  });
  const second = await provider.collect({
    eventKey: skillKey,
    context: {
      envelope: eventEnvelope({
        key: skillKey,
        rootId: "shared-root",
        source: { actorUuid: "Actor.VictimB" },
        data: { systemEventOperationId: "attack:aoe" }
      })
    }
  });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

function eventEnvelope(overrides = {}) {
  return {
    key: EVENT_KEY,
    rootId: "root",
    eventId: "event",
    source: { actorUuid: "Actor.A" },
    target: { actorUuid: "Actor.B" },
    data: {},
    ...overrides
  };
}

function eventFunction({ id, trackingTargets = [[]], extraConditions = [], eventKey = EVENT_KEY }) {
  return {
    id,
    type: "effectChanges",
    reactionSettings: { durationSeconds: 0, costs: [] },
    changes: [{ key: "system.test", type: "add", value: "1", phase: "initial" }],
    penalties: [],
    conditions: [
      ...trackingTargets.map((targets, index) => ({
        id: `${id}-event-${index}`,
        groupId: "",
        type: "eventReaction",
        eventKey,
        combatOnly: false,
        trackingTargets: targets
      })),
      ...extraConditions
    ]
  };
}

function createSourceItem(actor, { id, uuid, type, functions, equipped = false }) {
  const system = {
    description: `${id} description`,
    equipped,
    placement: { mode: "inventory" }
  };
  if (type === "ability") system.functions = functions;
  else system.functions = { freeSettings: { enabled: true, entries: functions } };
  return { id, uuid, type, name: id, img: `${id}.webp`, parent: actor, system };
}

function createEffectDocument(id, data) {
  return {
    id,
    ...structuredClone(data),
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
}

function accumulatingDamageFunction({ eventKey = "fallout-maw.damage.resolved" } = {}) {
  return {
    id: "adaptive-resistance",
    type: "effectChanges",
    changes: [{
      id: "adaptive-change",
      key: "system.damageResistanceBonuses.all.{group}",
      type: "add",
      value: "1",
      phase: "initial",
      priority: 0,
      valueSource: "accumulation",
      accumulatorExchange: {
        conditionId: "adaptive-accumulation",
        mode: "invested"
      }
    }],
    penalties: [],
    actions: [],
    conditions: [{
      id: "adaptive-event",
      groupId: "",
      type: "eventReaction",
      eventKey,
      combatOnly: false,
      allowUnconscious: true,
      allowDead: false,
      trackingTargets: ["owner"],
      reactionMode: "isolatedAuto"
    }, {
      id: "adaptive-accumulation",
      groupId: "",
      type: "accumulation",
      accumulation: {
        name: "Adaptive resistance",
        valueSource: "damageActualHealthLoss",
        percent: 10,
        groupBy: "damageType",
        totalCap: 50,
        bucketCap: 0,
        rounding: "floorTotal",
        durationPolicy: "fromFirst"
      }
    }, {
      id: "adaptive-duration",
      groupId: "",
      type: "duration",
      durationSeconds: 86400
    }]
  };
}

function damageEnvelope({
  key = "fallout-maw.damage.resolved",
  rootId = "damage-root",
  eventId = "damage-event",
  damageTypeKey = "firearm",
  healthLoss = 0
} = {}) {
  return eventEnvelope({
    key,
    rootId,
    eventId,
    target: { actorUuid: "Actor.C" },
    data: {
      amount: healthLoss,
      damageTypeKey,
      result: { amount: healthLoss, healthDelta: -healthLoss }
    },
    delta: { health: -healthLoss },
    outcome: { success: true, cancelled: false }
  });
}
