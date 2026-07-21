const handlers = new Map();

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
