import { prepareActorResourceSpend, runOneTimeResourceMutation } from "../combat/one-time-resources.mjs";

export const REACTION_POINTS_RESOURCE_KEY = "reactionPoints";
export const HEALTH_RESOURCE_KEY = "health";
export const POWER_RESOURCE_KEY = "power";
/** Dynamic combat spend: OД on the actor's turn, OР outside it. */
export const ACTION_OR_REACTION_POINTS_RESOURCE_KEY = "actionOrReactionPoints";
export const STRICT_REACTION_RESOURCE_UPDATE_OPTION = "falloutMawReactionResourceUpdate";

export const REACTION_COST_FAILURES = Object.freeze({
  invalidFormula: "invalidFormula",
  missingResourceKey: "missingResourceKey",
  unknownResourceKey: "unknownResourceKey",
  missingResource: "missingResource",
  insufficientResource: "insufficientResource",
  staleQuote: "staleQuote",
  spendFailed: "spendFailed"
});

export function createResourceCostRegistry({
  getResourceDefinitions = () => [],
  evaluateFormula = defaultEvaluateFormula,
  adapters = {},
  defaultAdapter = null,
  spendVector = null,
  afterCommit = null,
  formatCostLine = defaultFormatCostLine,
  logger = console
} = {}) {
  const actorLocks = new Map();
  const activeActorLockTokens = new Map();
  const adapterMap = new Map(Object.entries(adapters ?? {}));

  function registerAdapter(resourceKey, adapter) {
    const key = String(resourceKey ?? "").trim();
    if (!key || !isCostAdapter(adapter)) return false;
    adapterMap.set(key, adapter);
    return true;
  }

  function getAdapter(resourceKey) {
    return adapterMap.get(String(resourceKey ?? "").trim()) ?? defaultAdapter;
  }

  async function quote(actor, rows = [], context = {}) {
    const definitions = normalizeResourceDefinitions(await getResourceDefinitions(actor, context));
    const components = [];
    const totals = new Map();
    for (const [index, row] of normalizeCostRows(rows).entries()) {
      if (!row.resourceKey) {
        return invalidQuote(REACTION_COST_FAILURES.missingResourceKey, { rowId: row.id, rowIndex: index });
      }
      const definition = definitions.get(row.resourceKey);
      const adapter = getAdapter(row.resourceKey);
      if (!definition || !isCostAdapter(adapter)) {
        return invalidQuote(REACTION_COST_FAILURES.unknownResourceKey, {
          resourceKey: row.resourceKey,
          rowId: row.id,
          rowIndex: index
        });
      }

      let rawAmount;
      if (!row.formula) {
        return invalidQuote(REACTION_COST_FAILURES.invalidFormula, {
          resourceKey: row.resourceKey,
          rowId: row.id,
          rowIndex: index
        });
      }
      try {
        rawAmount = await evaluateFormula(row.formula, actor, {
          ...context,
          resourceKey: row.resourceKey,
          rowId: row.id
        });
      } catch (error) {
        logger?.warn?.(`fallout-maw | Trigger cost formula failed for '${row.resourceKey}'.`, error);
        return invalidQuote(REACTION_COST_FAILURES.invalidFormula, {
          resourceKey: row.resourceKey,
          rowId: row.id,
          rowIndex: index,
          message: String(error?.message ?? error ?? "")
        });
      }
      const number = Number(rawAmount);
      if (!Number.isFinite(number)) {
        return invalidQuote(REACTION_COST_FAILURES.invalidFormula, {
          resourceKey: row.resourceKey,
          rowId: row.id,
          rowIndex: index
        });
      }
      const amount = Math.max(0, Math.trunc(number));
      components.push({
        id: row.id,
        resourceKey: row.resourceKey,
        formula: row.formula,
        amount
      });
      totals.set(row.resourceKey, (totals.get(row.resourceKey) ?? 0) + amount);
    }

    const costs = [];
    for (const [resourceKey, amount] of Array.from(totals.entries()).sort(([left], [right]) => left.localeCompare(right))) {
      const definition = definitions.get(resourceKey);
      const adapter = getAdapter(resourceKey);
      let available;
      try {
        const rawAvailable = Number(await adapter.getAvailable(actor, definition, context));
        if (!Number.isFinite(rawAvailable)) throw new Error("Resource availability is not a finite number.");
        available = Math.max(0, Math.trunc(rawAvailable));
      } catch (error) {
        logger?.warn?.(`fallout-maw | Trigger-cost resource adapter failed for '${resourceKey}'.`, error);
        return invalidQuote(REACTION_COST_FAILURES.missingResource, { resourceKey });
      }
      costs.push({
        resourceKey,
        label: String(definition.label ?? resourceKey),
        amount,
        available
      });
    }

    const fingerprint = createReactionCostFingerprint({ components, costs });
    const affordable = costs.every(cost => cost.amount <= cost.available);
    return {
      valid: true,
      affordable,
      reason: affordable ? "" : REACTION_COST_FAILURES.insufficientResource,
      components,
      costs,
      fingerprint,
      costLines: costs.filter(cost => cost.amount > 0).map(cost => formatCostLine(cost, context))
    };
  }

  async function execute(actor, rows = [], {
    expectedFingerprint = "",
    afterSpend = null,
    actorLockToken = null,
    actorLockScope = "",
    ...context
  } = {}) {
    const lockScope = String(actorLockScope || context.rootId || "").trim();
    const spendResult = await withActorLock(actor, async leaseToken => {
      const executionContext = { ...context, actorLockToken: leaseToken };
      const current = await quote(actor, rows, executionContext);
      if (!current.valid) return { ok: false, reason: current.reason, quote: current };
      if (expectedFingerprint && current.fingerprint !== expectedFingerprint) {
        return { ok: false, reason: REACTION_COST_FAILURES.staleQuote, quote: current };
      }
      if (!current.affordable) {
        return { ok: false, reason: REACTION_COST_FAILURES.insufficientResource, quote: current };
      }
      try {
        let spendReceipt = null;
        if (typeof spendVector === "function") {
          spendReceipt = await spendVector(actor, current.costs, {
            ...executionContext,
            quote: current,
            getAdapter
          });
        } else {
          for (const cost of current.costs) {
            if (cost.amount <= 0) continue;
            const definition = normalizeResourceDefinitions(await getResourceDefinitions(actor, executionContext)).get(cost.resourceKey);
            await getAdapter(cost.resourceKey).spend(actor, cost.amount, definition, executionContext);
          }
        }
        return { ok: true, reason: "", quote: current, spendReceipt };
      } catch (error) {
        logger?.error?.("fallout-maw | Trigger-cost resource spend failed.", error);
        const failureReason = Object.values(REACTION_COST_FAILURES).includes(error?.reason)
          ? error.reason
          : REACTION_COST_FAILURES.spendFailed;
        return {
          ok: false,
          reason: failureReason,
          quote: current,
          error
        };
      }
    }, actorLockToken, lockScope);
    if (!spendResult.ok) return spendResult;

    if (typeof afterCommit === "function") {
      try {
        await afterCommit(actor, spendResult.quote, {
          ...context,
          spendReceipt: spendResult.spendReceipt
        });
      } catch (error) {
        // The vector is already committed. A secondary notification failure
        // cannot make the paid action retryable.
        logger?.error?.("fallout-maw | Trigger-cost commit notification failed.", error);
      }
    }
    if (typeof afterSpend !== "function") return spendResult;

    try {
      const afterResult = await afterSpend(spendResult.quote, context);
      return { ...spendResult, afterResult };
    } catch (error) {
      logger?.error?.("fallout-maw | Trigger-cost post-spend execution failed.", error);
      return {
        ok: false,
        reason: REACTION_COST_FAILURES.spendFailed,
        quote: spendResult.quote,
        error
      };
    }
  }

  function withActorLock(actor, operation, actorLockToken = null, actorLockScope = "") {
    const actorKey = String(actor?.uuid ?? actor?.id ?? "").trim();
    if (!actorKey) return Promise.resolve().then(operation);
    const lockScope = String(actorLockScope ?? "").trim();
    const activeLease = activeActorLockTokens.get(actorKey);
    if ((actorLockToken && activeLease === actorLockToken)
      || (lockScope && activeLease?.scope === lockScope)) {
      return Promise.resolve().then(() => operation(activeLease));
    }
    const leaseToken = Object.freeze({ actorKey, scope: lockScope, id: Symbol(actorKey) });
    const previous = actorLocks.get(actorKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        activeActorLockTokens.set(actorKey, leaseToken);
        try {
          return await operation(leaseToken);
        } finally {
          if (activeActorLockTokens.get(actorKey) === leaseToken) activeActorLockTokens.delete(actorKey);
        }
      })
      .finally(() => {
        if (actorLocks.get(actorKey) === next) actorLocks.delete(actorKey);
      });
    actorLocks.set(actorKey, next);
    return next;
  }

  return Object.freeze({
    quote,
    execute,
    withActorLock,
    registerAdapter,
    getAdapter
  });
}

export function createReactionCostFingerprint({ components = [], costs = [] } = {}) {
  const normalizedComponents = (components ?? [])
    .map(component => ({
      id: String(component?.id ?? ""),
      resourceKey: String(component?.resourceKey ?? ""),
      formula: String(component?.formula ?? "0"),
      amount: Math.max(0, Math.trunc(Number(component?.amount) || 0))
    }))
    .sort((left, right) => (
      left.id.localeCompare(right.id)
      || left.resourceKey.localeCompare(right.resourceKey)
      || left.formula.localeCompare(right.formula)
    ));
  const normalizedCosts = (costs ?? [])
    .map(cost => ({
      resourceKey: String(cost?.resourceKey ?? ""),
      amount: Math.max(0, Math.trunc(Number(cost?.amount) || 0))
    }))
    .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey));
  return JSON.stringify({ components: normalizedComponents, costs: normalizedCosts });
}

export function normalizeCostRows(rows = []) {
  const source = Array.isArray(rows) ? rows : Object.values(rows ?? {});
  return source.map((row, index) => {
    const overloadDurationSeconds = Math.max(0, Math.trunc(Number(row?.overloadDurationSeconds) || 0));
    return {
      id: String(row?.id ?? `cost-${index + 1}`).trim() || `cost-${index + 1}`,
      resourceKey: String(row?.resourceKey ?? row?.key ?? "").trim(),
      formula: String(row?.formula ?? row?.value ?? "0").trim(),
      overloadAmount: overloadDurationSeconds > 0
        ? Math.max(0, Math.trunc(Number(row?.overloadAmount ?? row?.overload) || 0))
        : 0,
      overloadDurationSeconds
    };
  });
}

export async function spendActorResourceCostVector(actor, costs = [], {
  spendHealth = null,
  restoreHealth = null,
  afterSpend = null,
  healthResourceKey = HEALTH_RESOURCE_KEY,
  updateOptions = {},
  context = {}
} = {}) {
  if (!actor?.update) throw new Error("Trigger-cost actor is unavailable.");
  const committed = await runOneTimeResourceMutation(actor, async () => {
    const vector = new Map((costs ?? []).map(cost => [
      String(cost?.resourceKey ?? "").trim(),
      Math.max(0, Math.trunc(Number(cost?.amount) || 0))
    ]));
    const updates = {};
    const expectedResources = [];
    const refunds = [];
    const paidCosts = [];
    let normalHealthCost = 0;
    for (const [resourceKey, amount] of vector) {
      if (amount <= 0) continue;
      const resource = actor.system?.resources?.[resourceKey];
      if (!resource) throw new Error(`Missing trigger-cost resource '${resourceKey}'.`);
      const plan = prepareActorResourceSpend(actor, resourceKey, amount);
      if (!plan) throw new Error(`Insufficient trigger-cost resource '${resourceKey}'.`);
      if (resourceKey === healthResourceKey) normalHealthCost = plan.normalSpent;
      refunds.push({
        resourceKey,
        current: plan.current,
        onceBefore: plan.onceBefore,
        normalSpent: resourceKey === healthResourceKey ? 0 : plan.normalSpent,
        onceSpent: plan.onceSpent
      });
      for (const [path, next] of Object.entries(plan.updates)) {
        const field = path.split(".").at(-1);
        // Normal health costs use Damage Hub so limb and health models stay synchronized.
        if (resourceKey === healthResourceKey && field !== "once") continue;
        updates[path] = next;
        expectedResources.push({ resourceKey, field, next });
      }
      paidCosts.push({ resourceKey, amount });
    }
    if (Object.keys(updates).length) {
      try {
        await actor.update(updates, {
          [STRICT_REACTION_RESOURCE_UPDATE_OPTION]: true,
          falloutMawTriggerCost: true,
          ...updateOptions
        });
        if (!doesActorResourceVectorMatch(actor, expectedResources)) {
          const error = new Error("Trigger-cost Actor update was cancelled or altered.");
          error.reason = REACTION_COST_FAILURES.spendFailed;
          throw error;
        }
      } catch (error) {
        // A failed persistence call may still have written part of the vector.
        // Compensate only the observed debit before releasing the shared queue.
        const partial = refunds.map(entry => ({
          ...entry,
          normalSpent: Math.min(entry.normalSpent, Math.max(0,
            entry.current - (getActorResourceField(actor, entry.resourceKey, "value") ?? entry.current))),
          onceSpent: Math.min(entry.onceSpent, Math.max(0,
            entry.onceBefore - (getActorResourceField(actor, entry.resourceKey, "once") ?? 0))),
          correctSpent: entry.normalSpent > 0
        }));
        try {
          await refundActorResourceCostVector(actor, partial, updateOptions);
        } catch (rollbackError) {
          error.rollbackError ??= rollbackError;
        }
        throw error;
      }
    }
    return { normalHealthCost, paidCosts, refunds };
  });
  const { normalHealthCost, paidCosts, refunds } = committed;
  let healthCommitted = false;
  // These callbacks may trigger nested reactions or use the same resource queue.
  try {
    if (normalHealthCost > 0) {
      if (typeof spendHealth !== "function") throw new Error("Trigger health-cost adapter is unavailable.");
      await spendHealth(actor, normalHealthCost, context);
      healthCommitted = true;
    }
    if (typeof afterSpend === "function") {
      await afterSpend({ actor, costs: paidCosts, context });
    }
  } catch (error) {
    if (healthCommitted && typeof restoreHealth === "function") {
      try {
        await restoreHealth(actor, normalHealthCost, context);
      } catch (rollbackError) {
        error.rollbackError ??= rollbackError;
      }
    }
    try {
      await runOneTimeResourceMutation(actor, () => refundActorResourceCostVector(actor, refunds, updateOptions));
    } catch (rollbackError) {
      error.rollbackError ??= rollbackError;
    }
    throw error;
  }
  return { costs: paidCosts };
}

/** Called only while holding the shared resource queue. Preserve intervening grants/spends. */
async function refundActorResourceCostVector(actor, refunds, updateOptions) {
  const updates = {};
  const expected = [];
  const put = (resourceKey, field, next) => {
    if (getActorResourceField(actor, resourceKey, field) === next) return;
    updates[`system.resources.${resourceKey}.${field}`] = next;
    expected.push({ resourceKey, field, next });
  };
  for (const entry of refunds) {
    const { resourceKey, normalSpent, onceSpent } = entry;
    const resource = actor.system?.resources?.[resourceKey];
    if (!resource) throw new Error(`Trigger-cost refund resource '${resourceKey}' is unavailable.`);
    if (normalSpent > 0 || entry.correctSpent) {
      const current = getActorResourceField(actor, resourceKey, "value") ?? 0;
      const maximum = getActorResourceField(actor, resourceKey, "max") ?? current;
      const next = current + Math.min(normalSpent, Math.max(0, maximum - current));
      put(resourceKey, "value", next);
      put(resourceKey, "spent", Math.max(0, maximum - next));
    }
    if (onceSpent > 0) put(resourceKey, "once", (getActorResourceField(actor, resourceKey, "once") ?? 0) + onceSpent);
  }
  if (!Object.keys(updates).length) return;
  await actor.update(updates, {
    [STRICT_REACTION_RESOURCE_UPDATE_OPTION]: true,
    falloutMawTriggerCostRollback: true,
    ...updateOptions
  });
  if (!doesActorResourceVectorMatch(actor, expected)) throw new Error("Trigger-cost Actor rollback was cancelled or altered.");
}

function doesActorResourceVectorMatch(actor, entries = []) {
  return entries.every(entry => getActorResourceField(actor, entry.resourceKey, entry.field) === entry.next);
}

function getActorResourceField(actor, resourceKey = "", field = "value") {
  const number = Number(actor?.system?.resources?.[resourceKey]?.[field]);
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

export function applyReactionHealthCost(request, context = {}, {
  applyInCurrentOperation,
  requestApplication
} = {}) {
  if (context.inDamageHubOperation || context.damageHubOperation === "current") {
    if (typeof applyInCurrentOperation !== "function") throw new Error("Current Damage Hub operation is unavailable.");
    return applyInCurrentOperation([request], context.logicalWorldTime);
  }
  if (typeof requestApplication !== "function") throw new Error("Damage Hub request adapter is unavailable.");
  return requestApplication(request);
}

function normalizeResourceDefinitions(definitions = []) {
  const source = Array.isArray(definitions) ? definitions : Object.values(definitions ?? {});
  return new Map(source
    .map(definition => ({
      ...definition,
      key: String(definition?.key ?? "").trim(),
      label: String(definition?.label ?? definition?.key ?? "").trim()
    }))
    .filter(definition => definition.key)
    .map(definition => [definition.key, definition]));
}

function invalidQuote(reason, details = {}) {
  return {
    valid: false,
    affordable: false,
    reason,
    details,
    components: [],
    costs: [],
    fingerprint: "",
    costLines: []
  };
}

function isCostAdapter(adapter) {
  return Boolean(adapter && typeof adapter.getAvailable === "function" && typeof adapter.spend === "function");
}

function defaultEvaluateFormula(formula) {
  const value = Number(formula);
  if (!Number.isFinite(value)) throw new Error("Invalid cost formula");
  return value;
}

function defaultFormatCostLine(cost) {
  return `${cost.label}: ${cost.amount}`;
}
