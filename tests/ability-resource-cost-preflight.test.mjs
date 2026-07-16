import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.foundry = {
  utils: { randomID: () => "test-id" },
  applications: {
    api: { DialogV2: {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  }
};

const {
  ABILITY_ACTIVE_APPLICATION_COST_PAYERS,
  normalizeActiveApplicationSettings
} = await import("../src/settings/abilities.mjs");
const { buildActiveApplicationCostPlanEntries } = await import("../src/abilities/active-application-costs.mjs");

const {
  configureAbilityTriggerCostRuntime,
  payAbilityFunctionResourceCosts,
  quoteAbilityFunctionResourceCosts
} = await import("../src/abilities/trigger-cost-runtime.mjs");
const { createFoundryReactionCostRegistry } = await import("../src/events/foundry-reaction-costs.mjs");
const { isCombatResourceCostActive } = await import("../src/combat/resource-cost-policy.mjs");

function createQuote(rows = [], actor = null) {
  const costs = rows.map(row => ({
    resourceKey: row.resourceKey,
    label: row.resourceKey,
    amount: isCombatResourceCostActive(actor, row.resourceKey)
      ? Math.max(0, Math.trunc(Number(row.formula) || 0))
      : 0,
    available: 100
  }));
  return {
    valid: true,
    affordable: true,
    reason: "",
    components: [],
    costs,
    fingerprint: JSON.stringify(costs.map(cost => [cost.resourceKey, cost.amount])),
    costLines: []
  };
}

test("ability-cost preflight ignores every combat-only resource outside the actor's combat and reuses its fingerprint", async () => {
  const calls = { quote: [], execute: [] };
  const registry = {
    async quote(_actor, rows, context) {
      calls.quote.push({ rows, context });
      return createQuote(rows, _actor);
    },
    async execute(_actor, rows, context) {
      calls.execute.push({ rows, context });
      const quote = createQuote(rows, _actor);
      assert.equal(context.expectedFingerprint, quote.fingerprint);
      return { ok: true, reason: "", quote };
    }
  };
  configureAbilityTriggerCostRuntime({ costRegistry: registry });

  const actor = { uuid: "Actor.A", isOwner: true, system: { resources: {} }, effects: [] };
  const sourceItem = { id: "Ability.1", uuid: "Actor.A.Item.Ability.1" };
  const abilityFunction = { id: "active-1" };
  const costRows = [
    { id: "power", resourceKey: "power", formula: "30" },
    { id: "health", resourceKey: "health", formula: "2" },
    { id: "custom", resourceKey: "customResource", formula: "4" },
    { id: "ap", resourceKey: "actionPoints", formula: "5" },
    { id: "rp", resourceKey: "reactionPoints", formula: "3" },
    { id: "mp", resourceKey: "movementPoints", formula: "2" },
    { id: "dodge", resourceKey: "dodge", formula: "10" }
  ];

  globalThis.game = { combat: null };
  const preflight = await quoteAbilityFunctionResourceCosts({
    actor,
    sourceItem,
    abilityFunction,
    costRows,
    context: { rootId: "root-1" }
  });
  assert.equal(preflight.ok, true);
  assert.deepEqual(calls.quote[0].rows.map(row => row.resourceKey), [
    "power",
    "health",
    "customResource",
    "actionPoints",
    "reactionPoints",
    "movementPoints",
    "dodge"
  ]);
  assert.deepEqual(
    preflight.entries[0].baseRows.map(row => row.resourceKey),
    [
      "power",
      "health",
      "customResource",
      "actionPoints",
      "reactionPoints",
      "movementPoints",
      "dodge"
    ]
  );
  for (const key of ["actionPoints", "reactionPoints", "movementPoints", "dodge"]) {
    assert.equal(preflight.quote.costs.find(cost => cost.resourceKey === key)?.amount, 0, key);
  }

  const payment = await payAbilityFunctionResourceCosts({
    actor,
    sourceItem,
    abilityFunction,
    costRows,
    expectedFingerprint: preflight.fingerprint,
    context: { rootId: "root-1" }
  });
  assert.equal(payment.ok, true);
  assert.deepEqual(
    calls.execute[0].rows.map(row => row.resourceKey),
    [
      "power",
      "health",
      "customResource",
      "actionPoints",
      "reactionPoints",
      "movementPoints",
      "dodge"
    ]
  );

  globalThis.game = {
    combat: {
      started: true,
      combatants: [{ actor }]
    }
  };
  const combatPreflight = await quoteAbilityFunctionResourceCosts({
    actor,
    sourceItem,
    abilityFunction,
    costRows
  });
  assert.equal(combatPreflight.ok, true);
  assert.deepEqual(calls.quote[1].rows.map(row => row.resourceKey), [
    "power",
    "health",
    "customResource",
    "actionPoints",
    "reactionPoints",
    "movementPoints",
    "dodge"
  ]);

  globalThis.game.combat.combatants = [{ actor: { uuid: "Actor.B" } }];
  const unrelatedCombatPreflight = await quoteAbilityFunctionResourceCosts({
    actor,
    sourceItem,
    abilityFunction,
    costRows
  });
  assert.equal(unrelatedCombatPreflight.ok, true);
  assert.deepEqual(
    Object.fromEntries(calls.quote[2].rows.map(row => [row.resourceKey, true])),
    Object.fromEntries(costRows.map(row => [row.resourceKey, true]))
  );
  for (const key of ["actionPoints", "reactionPoints", "movementPoints", "dodge"]) {
    assert.equal(unrelatedCombatPreflight.quote.costs.find(cost => cost.resourceKey === key)?.amount, 0, key);
  }
});

test("failed preflight exposes the exact shortage before commit", async () => {
  let executeCalled = false;
  configureAbilityTriggerCostRuntime({
    costRegistry: {
      async quote() {
        return {
          valid: true,
          affordable: false,
          reason: "insufficientResource",
          components: [],
          costs: [{ resourceKey: "power", label: "Энергия", amount: 30, available: 12 }],
          fingerprint: "shortage",
          costLines: []
        };
      },
      async execute() {
        executeCalled = true;
        return { ok: true, quote: createQuote([]) };
      }
    }
  });
  globalThis.game = { combat: null };
  const result = await quoteAbilityFunctionResourceCosts({
    actor: { uuid: "Actor.A", system: {}, effects: [] },
    sourceItem: { id: "A", uuid: "Actor.A.Item.A" },
    abilityFunction: { id: "F" },
    costRows: [{ id: "power", resourceKey: "power", formula: "30" }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficientResource");
  assert.deepEqual(result.quote.costs[0], {
    resourceKey: "power",
    label: "Энергия",
    amount: 30,
    available: 12
  });
  assert.equal(executeCalled, false);
});

test("a combat-state change between preflight and commit is rejected as a stale quote", async () => {
  const registry = {
    async quote(_actor, rows) {
      return createQuote(rows, _actor);
    },
    async execute(_actor, rows, context) {
      const quote = createQuote(rows, _actor);
      if (context.expectedFingerprint && context.expectedFingerprint !== quote.fingerprint) {
        return { ok: false, reason: "staleQuote", quote };
      }
      return { ok: true, reason: "", quote };
    }
  };
  configureAbilityTriggerCostRuntime({ costRegistry: registry });
  const actor = { uuid: "Actor.A", isOwner: true, system: { resources: {} }, effects: [] };
  const sourceItem = { id: "A", uuid: "Actor.A.Item.A" };
  const abilityFunction = { id: "F" };
  const costRows = [{ id: "ap", resourceKey: "actionPoints", formula: "5" }];

  globalThis.game = { combat: null };
  const preflight = await quoteAbilityFunctionResourceCosts({ actor, sourceItem, abilityFunction, costRows });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.charged, false);
  assert.equal(preflight.fingerprint, "[[\"actionPoints\",0]]");

  globalThis.game = { combat: { started: true, combatants: [{ actor }] } };
  const payment = await payAbilityFunctionResourceCosts({
    actor,
    sourceItem,
    abilityFunction,
    costRows,
    expectedFingerprint: preflight.fingerprint
  });
  assert.equal(payment.ok, false);
  assert.equal(payment.reason, "staleQuote");
});

test("combat-only rows are re-evaluated after waiting for the actor lock", async () => {
  const actor = {
    uuid: "Actor.QueuedCombatEntry",
    isOwner: true,
    effects: [],
    system: {
      resources: {
        actionPoints: { value: 1, min: 0, max: 10 }
      }
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const match = /^system\.resources\.([^.]+)\.(value|spent)$/.exec(path);
        if (match) this.system.resources[match[1]][match[2]] = value;
      }
    }
  };
  const registry = createFoundryReactionCostRegistry({
    resourceSettings: [{ key: "actionPoints", label: "ОД" }],
    evaluateCostFormula: formula => Number(formula),
    notifyResourceSpend: () => [],
    logger: { warn() {}, error() {} }
  });
  configureAbilityTriggerCostRuntime({ costRegistry: registry });
  globalThis.game = { combat: null, combats: [] };

  let releaseLock;
  let confirmLock;
  const lockHeld = new Promise(resolve => { confirmLock = resolve; });
  const lockRelease = new Promise(resolve => { releaseLock = resolve; });
  const blocker = registry.withActorLock(actor, async () => {
    confirmLock();
    await lockRelease;
  }, null, "blocking-operation");
  await lockHeld;

  const sourceItem = { id: "A", uuid: "Actor.QueuedCombatEntry.Item.A" };
  const abilityFunction = { id: "F" };
  const costRows = [{ id: "ap", resourceKey: "actionPoints", formula: "5" }];
  const preflight = await quoteAbilityFunctionResourceCosts({ actor, sourceItem, abilityFunction, costRows });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.quote.costs[0].amount, 0);
  const paymentPromise = payAbilityFunctionResourceCosts({
    actor,
    sourceItem,
    abilityFunction,
    costRows,
    expectedFingerprint: preflight.fingerprint
  });

  const combat = { started: true, combatants: [{ actor }] };
  globalThis.game = { combat, combats: [combat] };
  releaseLock();
  await blocker;
  const payment = await paymentPromise;
  assert.equal(payment.ok, false);
  assert.equal(payment.reason, "staleQuote");
  assert.equal(actor.system.resources.actionPoints.value, 1);
});

test("interactive ability paths quote costs before opening target or change pickers", async () => {
  const fixedSource = await readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8");
  const activeStart = fixedSource.indexOf("async function useActiveApplicationAbilityFunction");
  const activeEnd = fixedSource.indexOf("async function executeActiveApplicationUse", activeStart);
  const activeFlow = fixedSource.slice(activeStart, activeEnd);
  assert.ok(activeFlow.indexOf("quoteAbilityFunctionResourceCosts") >= 0);
  assert.ok(activeFlow.indexOf("quoteAbilityFunctionResourceCosts") < activeFlow.indexOf("resolveActiveApplicationTargets"));
  assert.match(activeFlow, /costRows:\s*sourceActivationCosts/);
  const executionStart = fixedSource.indexOf("async function executeActiveApplicationUse");
  const executionEnd = fixedSource.indexOf("async function gateActiveApplicationTargets", executionStart);
  const executionFlow = fixedSource.slice(executionStart, executionEnd);
  assert.ok(executionFlow.indexOf("quoteActiveApplicationCostPlan") >= 0);
  assert.ok(executionFlow.indexOf("quoteActiveApplicationCostPlan") < executionFlow.indexOf("resolveLimitedChangeSet"));
  assert.ok(executionFlow.indexOf("quoteActiveApplicationCostPlan") < executionFlow.indexOf("prepareAbilityFunctionActions"));
  assert.match(executionFlow, /resourceReservations:\s*costPlanQuote\.resourceReservations/);
  assert.match(executionFlow, /costFingerprints:\s*costPlanQuote\.fingerprints/);
  assert.match(fixedSource, /restoreActorHealthCost\(actor, healthRefund, \{ chainRef \}\)/);

  const itemUseSource = await readFile(new URL("../src/abilities/item-use-triggers.mjs", import.meta.url), "utf8");
  const itemUseStart = itemUseSource.indexOf("async function advanceItemUseCounter");
  const itemUseEnd = itemUseSource.indexOf("async function createTriggeredAbilityEffect", itemUseStart);
  const itemUseFlow = itemUseSource.slice(itemUseStart, itemUseEnd);
  assert.ok(itemUseFlow.indexOf("quoteAbilityFunctionTriggerCost") >= 0);
  assert.ok(itemUseFlow.indexOf("quoteAbilityFunctionTriggerCost") < itemUseFlow.indexOf("selectRuntimeChanges"));
  assert.match(itemUseFlow, /expectedFingerprint:\s*costPreflight\?\.fingerprint/);
});

test("active-application cost payers normalize independently from trigger costs", () => {
  const settings = normalizeActiveApplicationSettings({
    costs: [
      { id: "legacy", resourceKey: "power", formula: "3" },
      { id: "target", resourceKey: "customResource", formula: "4", payer: "targets" },
      { id: "invalid", resourceKey: "health", formula: "2", payer: "executor" }
    ]
  });
  assert.deepEqual(settings.costs.map(cost => cost.payer), [
    ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source,
    ABILITY_ACTIVE_APPLICATION_COST_PAYERS.targets,
    ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source
  ]);
});

test("target-payer rows expand once per unique final target and merge self with source", () => {
  const source = { uuid: "Actor.A", name: "A" };
  const targetB = { uuid: "Actor.B", name: "B" };
  const targetC = { uuid: "Actor.C", name: "C" };
  const entries = buildActiveApplicationCostPlanEntries(source, [
    { id: "power", resourceKey: "power", formula: "30", payer: "source" },
    { id: "ap", resourceKey: "actionPoints", formula: "5", payer: "targets" },
    { id: "custom", resourceKey: "customResource", formula: "spe/10", payer: "targets" }
  ], [
    { actor: targetB },
    { actor: source },
    { actor: targetB },
    { actor: targetC }
  ]);
  assert.deepEqual(entries.map(entry => entry.actor.uuid), ["Actor.A", "Actor.B", "Actor.C"]);
  assert.deepEqual(entries.map(entry => entry.costRows.map(row => row.id)), [
    ["power", "ap", "custom"],
    ["ap", "custom"],
    ["ap", "custom"]
  ]);
  assert.equal(entries[1].costRows[1].formula, "spe/10");
});

test("active-application payer UI and GM authority preserve and reconstruct cost ownership", async () => {
  const [catalogTemplate, itemTemplate, catalogSource, itemSheetSource, fixedSource] = await Promise.all([
    readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8")
  ]);
  assert.match(catalogTemplate, /data-field="active\.costPayer"/);
  assert.match(itemTemplate, /data-ability-active-cost-payer/);
  assert.match(catalogSource, /querySelector\("\[data-field='active\.costPayer'\]"\)/);
  assert.match(itemSheetSource, /querySelector\("\[data-ability-active-cost-payer\]"\)/);
  const planSource = await readFile(new URL("../src/abilities/active-application-costs.mjs", import.meta.url), "utf8");
  assert.match(planSource, /cost\?\.payer === ABILITY_ACTIVE_APPLICATION_COST_PAYERS\.targets/);
  assert.match(fixedSource, /buildActiveApplicationCostPlanEntries\(sourceActor, settings\.costs, resolvedTargets\)/);
  assert.match(fixedSource, /JSON\.stringify\(expectedActorUuids\) !== JSON\.stringify\(suppliedActorUuids\)/);
  assert.match(fixedSource, /payActiveApplicationCostPlan/);
  assert.match(fixedSource, /rollbackActiveApplicationPaymentPlan/);
});

test("the shared Foundry registry spends health, power and custom resources outside combat but not combat resources", async () => {
  const resourceKeys = [
    "health",
    "power",
    "customResource",
    "actionPoints",
    "reactionPoints",
    "movementPoints",
    "dodge"
  ];
  const actor = {
    uuid: "Actor.Registry",
    isOwner: true,
    effects: [],
    system: {
      resources: Object.fromEntries(resourceKeys.map(key => [key, { value: 50, min: 0, max: 50 }]))
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const match = /^system\.resources\.([^.]+)\.(value|spent)$/.exec(path);
        if (match) this.system.resources[match[1]][match[2]] = value;
      }
    }
  };
  const combatSpendNotifications = [];
  const registry = createFoundryReactionCostRegistry({
    resourceSettings: resourceKeys.map(key => ({ key, label: key })),
    evaluateCostFormula: formula => Number(formula),
    applyHealthCost: request => {
      actor.system.resources.health.value -= request.amount;
      return { actorUuid: actor.uuid, healthDelta: request.amount };
    },
    notifyResourceSpend: (_actor, resources) => {
      combatSpendNotifications.push(resources);
      return [];
    },
    logger: { warn() {}, error() {} }
  });
  const rows = resourceKeys.map((resourceKey, index) => ({
    id: `cost-${index}`,
    resourceKey,
    formula: "5"
  }));

  globalThis.game = { combat: null };
  const quote = await registry.quote(actor, rows);
  assert.equal(quote.valid, true);
  assert.equal(quote.affordable, true);
  const amounts = Object.fromEntries(quote.costs.map(cost => [cost.resourceKey, cost.amount]));
  assert.deepEqual(amounts, {
    actionPoints: 0,
    customResource: 5,
    dodge: 0,
    health: 5,
    movementPoints: 0,
    power: 5,
    reactionPoints: 0
  });
  const payment = await registry.execute(actor, rows, { expectedFingerprint: quote.fingerprint });
  assert.equal(payment.ok, true);
  assert.equal(actor.system.resources.health.value, 45);
  assert.equal(actor.system.resources.power.value, 45);
  assert.equal(actor.system.resources.customResource.value, 45);
  for (const key of ["actionPoints", "reactionPoints", "movementPoints", "dodge"]) {
    assert.equal(actor.system.resources[key].value, 50, key);
  }
  assert.deepEqual(combatSpendNotifications, []);

  globalThis.game = { combat: { started: true, combatants: [{ actor }] } };
  const combatQuote = await registry.quote(actor, rows);
  for (const key of ["actionPoints", "reactionPoints", "movementPoints", "dodge"]) {
    assert.equal(combatQuote.costs.find(cost => cost.resourceKey === key)?.amount, 5, key);
  }
  const combatPayment = await registry.execute(actor, rows, {
    expectedFingerprint: combatQuote.fingerprint
  });
  assert.equal(combatPayment.ok, true);
  assert.deepEqual(combatSpendNotifications, [{
    actionPoints: 5,
    reactionPoints: 5,
    movementPoints: 5,
    dodge: 5
  }]);
});

test("inactive combat-only costs do not require those resources to exist on an out-of-combat actor", async () => {
  const actor = {
    uuid: "Actor.WithoutCombatResources",
    isOwner: true,
    effects: [],
    system: {
      resources: {
        power: { value: 12, min: 0, max: 12 }
      }
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const match = /^system\.resources\.([^.]+)\.(value|spent)$/.exec(path);
        if (match) this.system.resources[match[1]][match[2]] = value;
      }
    }
  };
  const resourceKeys = [
    "power",
    "actionPoints",
    "reactionPoints",
    "movementPoints",
    "dodge"
  ];
  const registry = createFoundryReactionCostRegistry({
    resourceSettings: resourceKeys.map(key => ({ key, label: key })),
    evaluateCostFormula: formula => Number(formula),
    notifyResourceSpend: () => [],
    logger: { warn() {}, error() {} }
  });
  const rows = resourceKeys.map((resourceKey, index) => ({
    id: `cost-${index}`,
    resourceKey,
    formula: "3"
  }));

  globalThis.game = { combat: null, combats: [] };
  const quote = await registry.quote(actor, rows);
  assert.equal(quote.valid, true);
  assert.equal(quote.affordable, true);
  assert.deepEqual(Object.fromEntries(quote.costs.map(cost => [cost.resourceKey, cost.amount])), {
    actionPoints: 0,
    dodge: 0,
    movementPoints: 0,
    power: 3,
    reactionPoints: 0
  });
  const payment = await registry.execute(actor, rows, { expectedFingerprint: quote.fingerprint });
  assert.equal(payment.ok, true);
  assert.equal(actor.system.resources.power.value, 9);
});

test("a rejected health cost rolls back the ordinary resource vector", async () => {
  const actor = {
    uuid: "Actor.HealthFailure",
    isOwner: true,
    effects: [],
    system: {
      resources: {
        health: { value: 10, min: 0, max: 10, spent: 0 },
        power: { value: 10, min: 0, max: 10, spent: 0 },
        customResource: { value: 10, min: 0, max: 10, spent: 0 }
      }
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const match = /^system\.resources\.([^.]+)\.(value|spent)$/.exec(path);
        if (match) this.system.resources[match[1]][match[2]] = value;
      }
    }
  };
  globalThis.game = { combat: null };
  const registry = createFoundryReactionCostRegistry({
    resourceSettings: [
      { key: "health", label: "health" },
      { key: "power", label: "power" },
      { key: "customResource", label: "custom" }
    ],
    evaluateCostFormula: formula => Number(formula),
    applyHealthCost: () => undefined,
    notifyResourceSpend: () => [],
    logger: { warn() {}, error() {} }
  });
  const rows = [
    { id: "power", resourceKey: "power", formula: "4" },
    { id: "custom", resourceKey: "customResource", formula: "3" },
    { id: "health", resourceKey: "health", formula: "5" }
  ];
  const quote = await registry.quote(actor, rows);
  const payment = await registry.execute(actor, rows, { expectedFingerprint: quote.fingerprint });
  assert.equal(payment.ok, false);
  assert.equal(payment.reason, "spendFailed");
  assert.equal(actor.system.resources.health.value, 10);
  assert.equal(actor.system.resources.power.value, 10);
  assert.equal(actor.system.resources.customResource.value, 10);
});

test("a partial health cost is reversed and does not trust a conflicting healthDelta", async () => {
  const actor = {
    uuid: "Actor.PartialHealthFailure",
    isOwner: true,
    effects: [],
    system: {
      resources: {
        health: { value: 10, min: 0, max: 10, spent: 0 },
        power: { value: 10, min: 0, max: 10, spent: 0 }
      }
    },
    async update(changes) {
      for (const [path, value] of Object.entries(changes)) {
        const match = /^system\.resources\.([^.]+)\.(value|spent)$/.exec(path);
        if (match) this.system.resources[match[1]][match[2]] = value;
      }
    }
  };
  globalThis.game = { combat: null, combats: [] };
  const registry = createFoundryReactionCostRegistry({
    resourceSettings: [
      { key: "health", label: "health" },
      { key: "power", label: "power" }
    ],
    evaluateCostFormula: formula => Number(formula),
    applyHealthCost: request => {
      actor.system.resources.health.value -= 2;
      return {
        actorUuid: actor.uuid,
        resourceHealthDelta: 2,
        healthDelta: request.amount
      };
    },
    restoreHealthCost: (_actor, amount) => {
      actor.system.resources.health.value += amount;
      return { actor, healthDelta: amount };
    },
    notifyResourceSpend: () => [],
    logger: { warn() {}, error() {} }
  });
  const rows = [
    { id: "power", resourceKey: "power", formula: "4" },
    { id: "health", resourceKey: "health", formula: "5" }
  ];
  const quote = await registry.quote(actor, rows);
  const payment = await registry.execute(actor, rows, { expectedFingerprint: quote.fingerprint });
  assert.equal(payment.ok, false);
  assert.equal(payment.reason, "spendFailed");
  assert.equal(actor.system.resources.health.value, 10);
  assert.equal(actor.system.resources.power.value, 10);
});

test("active-application authority prefers a GM rendering every required scene level", async () => {
  const source = await readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8");
  const requestStart = source.indexOf("async function requestActiveApplicationEffectOperation");
  const requestEnd = source.indexOf("function clearActiveApplicationAuthorityRequest", requestStart);
  const selectorStart = source.indexOf("function getActiveApplicationAuthorityGM");
  const selectorEnd = source.indexOf("function isTokenDocumentIncludedForUserLevel", selectorStart);
  const gmStart = source.indexOf("function getResponsibleGM");
  const gmEnd = source.indexOf("function getActiveApplicationAuthorityGM", gmStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  assert.ok(gmStart >= 0 && gmEnd > gmStart && selectorEnd > selectorStart);

  const request = source.slice(requestStart, requestEnd);
  const gmSelector = source.slice(gmStart, gmEnd);
  const applicationSelector = source.slice(selectorStart, selectorEnd);
  assert.match(request, /const gm = getActiveApplicationAuthorityGM\(payload\)/);
  assert.match(request, /if \(gm\.id === game\.user\?\.id\)/);
  assert.ok(request.indexOf("getActiveApplicationAuthorityGM") < request.indexOf("handleActiveApplicationEffectQuery"));
  assert.match(source, /CONFIG\.queries\[ACTIVE_APPLICATION_QUERY_NAME\] = handleActiveApplicationEffectQuery/);
  assert.match(request, /gm\.query\(ACTIVE_APPLICATION_QUERY_NAME, payload/);
  assert.match(source, /handleActiveApplicationEffectQuery\(payload = \{\}, \{ user: sender = null \} = \{\}\)[\s\S]*?senderUserId: sender\.id/);
  assert.doesNotMatch(source, /performActiveApplicationEffects|activeApplicationEffectsResult/);
  assert.match(gmSelector, /user\.viewedScene/);
  assert.match(gmSelector, /isTokenDocumentIncludedForUserLevel/);
  assert.match(applicationSelector, /sourceTokenDocument[\s\S]*?targetTokenDocuments/);
  assert.match(applicationSelector, /requireScene:\s*Boolean\(settings\.wallsBlock\)/);
  assert.match(source, /settings\.wallsBlock[\s\S]*?isTokenDocumentIncludedForUserLevel\(tokenDocument, game\.user\)/);
});
