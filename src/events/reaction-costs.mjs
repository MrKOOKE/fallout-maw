export const REACTION_POINTS_RESOURCE_KEY = "reactionPoints";
export const HEALTH_RESOURCE_KEY = "health";
export const POWER_RESOURCE_KEY = "power";
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
        logger?.warn?.(`fallout-maw | Event Reaction cost formula failed for '${row.resourceKey}'.`, error);
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
        logger?.warn?.(`fallout-maw | Event Reaction resource adapter failed for '${resourceKey}'.`, error);
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
        if (typeof spendVector === "function") {
          await spendVector(actor, current.costs, {
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
        return { ok: true, reason: "", quote: current };
      } catch (error) {
        logger?.error?.("fallout-maw | Event Reaction resource spend failed.", error);
        return {
          ok: false,
          reason: REACTION_COST_FAILURES.spendFailed,
          quote: current,
          error
        };
      }
    }, actorLockToken, lockScope);
    if (!spendResult.ok || typeof afterSpend !== "function") return spendResult;

    try {
      const afterResult = await afterSpend(spendResult.quote, context);
      return { ...spendResult, afterResult };
    } catch (error) {
      logger?.error?.("fallout-maw | Event Reaction post-spend execution failed.", error);
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
  healthResourceKey = HEALTH_RESOURCE_KEY,
  updateOptions = {},
  context = {}
} = {}) {
  if (!actor?.update) throw new Error("Event Reaction cost actor is unavailable.");
  const vector = new Map((costs ?? []).map(cost => [
    String(cost?.resourceKey ?? "").trim(),
    Math.max(0, Math.trunc(Number(cost?.amount) || 0))
  ]));
  const healthCost = vector.get(healthResourceKey) ?? 0;
  vector.delete(healthResourceKey);
  const updates = {};
  for (const [resourceKey, amount] of vector) {
    if (amount <= 0) continue;
    const resource = actor.system?.resources?.[resourceKey];
    if (!resource) throw new Error(`Missing Event Reaction resource '${resourceKey}'.`);
    const current = Math.trunc(Number(resource.value) || 0);
    const minimum = Math.trunc(Number(resource.min) || 0);
    const next = current - amount;
    if (next < minimum) throw new Error(`Insufficient Event Reaction resource '${resourceKey}'.`);
    updates[`system.resources.${resourceKey}.value`] = next;
    updates[`system.resources.${resourceKey}.spent`] = Math.max(0, Math.trunc(Number(resource.max) || 0) - next);
  }
  if (Object.keys(updates).length) {
    await actor.update(updates, {
      [STRICT_REACTION_RESOURCE_UPDATE_OPTION]: true,
      falloutMawEventReactionCost: true,
      ...updateOptions
    });
  }
  if (healthCost > 0) {
    if (typeof spendHealth !== "function") throw new Error("Event Reaction health cost adapter is unavailable.");
    await spendHealth(actor, healthCost, context);
  }
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
