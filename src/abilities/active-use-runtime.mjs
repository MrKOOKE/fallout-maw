const handlers = new Map();

/** Resolve the shared semantic id used by chance, costs, cooldowns and use counters. */
export function getActiveUseOperationId(context = {}, ...fallbacks) {
  const source = context && typeof context === "object" ? context : {};
  const check = source.check && typeof source.check === "object" ? source.check : {};
  const envelope = source.eventEnvelope && typeof source.eventEnvelope === "object"
    ? source.eventEnvelope
    : source.event && typeof source.event === "object" ? source.event : {};
  const eventData = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
  const request = source.request && typeof source.request === "object"
    ? source.request
    : eventData.request && typeof eventData.request === "object" ? eventData.request : {};
  const costContext = source.costContext && typeof source.costContext === "object" ? source.costContext : {};
  return firstActiveUseText(
    source.chanceOperationId,
    check.chanceOperationId,
    request.chanceOperationId,
    source.attackId,
    source.weaponAttackId,
    check.attackId,
    check.weaponAttackId,
    source.activationId,
    source.movementId,
    source.limitedUseOperationId,
    check.limitedUseOperationId,
    source.damageHubOperationRef,
    check.damageHubOperationRef,
    source.occurrenceKey,
    source.occurrenceId,
    costContext.occurrenceId,
    envelope.occurrenceKey,
    source.eventId,
    envelope.eventId,
    request.systemEventOperationId,
    source.operationId,
    envelope.operationId,
    source.rootId,
    envelope.rootId,
    costContext.rootId,
    ...fallbacks
  );
}

/** Register one consumer of semantic active-use preparations. */
export function registerActiveUseRuntimeHandler(id = "", handler = {}) {
  const key = String(id ?? "").trim();
  if (!key || typeof handler?.prepare !== "function" || typeof handler?.commit !== "function") {
    return () => undefined;
  }
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key);
  };
}

/** Capture operation participants synchronously before mutable actor state changes. */
export function prepareActiveUseOperation(context = {}) {
  const entries = [];
  for (const [id, handler] of handlers) {
    const data = handler.prepare(context);
    if (data !== null && data !== undefined) entries.push({ id, data });
  }
  return entries.length ? { entries } : null;
}

/** Commit one or more preparations as one semantic use per participating source. */
export async function commitPreparedActiveUseOperations(preparations = [], context = {}) {
  const grouped = new Map();
  for (const preparation of preparations ?? []) {
    for (const entry of preparation?.entries ?? []) {
      const values = grouped.get(entry.id) ?? [];
      values.push(entry.data);
      grouped.set(entry.id, values);
    }
  }
  const results = [];
  for (const [id, values] of grouped) {
    const handler = handlers.get(id);
    if (!handler) continue;
    results.push(await handler.commit(values, context));
  }
  return results.flat().filter(Boolean);
}

function firstActiveUseText(...values) {
  return values.map(value => String(value ?? "").trim()).find(Boolean) ?? "";
}
