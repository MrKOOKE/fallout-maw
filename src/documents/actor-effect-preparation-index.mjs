const actorPreparationContexts = new WeakMap();

/**
 * Open an Actor-local preparation scope. The scope is synchronous by Foundry
 * contract and is closed by Actor#prepareData in a finally block.
 */
export function beginActorEffectPreparation(actor) {
  if (!actor || (typeof actor !== "object" && typeof actor !== "function")) return null;
  const context = {
    actor,
    previous: actorPreparationContexts.get(actor) ?? null,
    embeddedEffectsPrepared: false,
    snapshot: null
  };
  actorPreparationContexts.set(actor, context);
  return context;
}

/**
 * Foundry prepares every embedded Item and ActiveEffect before the Actor's
 * initial ActiveEffect phase. Only after that boundary may the snapshot be
 * retained for the rest of this preparation cycle.
 */
export function markActorEmbeddedEffectsPrepared(actor) {
  const context = actorPreparationContexts.get(actor);
  if (!context) return;
  context.embeddedEffectsPrepared = true;
  context.snapshot = null;
}

export function endActorEffectPreparation(actor, context) {
  if (!actor || actorPreparationContexts.get(actor) !== context) return;
  if (context?.previous) {
    // A nested Actor preparation may have rebuilt embedded Items or effects.
    // The enclosing preparation scope is still valid, but its document
    // membership snapshot is not.
    context.previous.snapshot = null;
    actorPreparationContexts.set(actor, context.previous);
  }
  else actorPreparationContexts.delete(actor);
}

/**
 * Return Foundry's applicable-effect iterable. During the safe portion of one
 * Actor preparation cycle this is a stable array of document references;
 * outside that scope it remains Foundry's live generator.
 */
export function getActorApplicableEffects(actor, { snapshot = null } = {}) {
  const resolved = getUsableSnapshot(actor, snapshot);
  if (resolved) return resolved.effects;

  const context = actorPreparationContexts.get(actor);
  if (!context?.embeddedEffectsPrepared) return getLiveApplicableEffects(actor);
  context.snapshot ??= createActorEffectSnapshot(actor);
  return context.snapshot.effects;
}

/**
 * Build a request-local effect snapshot. This is safe only while the caller
 * guarantees that no Actor, Item, or ActiveEffect mutation can occur.
 */
export function createActorEffectSnapshot(actor) {
  return {
    actor,
    effects: Array.from(getLiveApplicableEffects(actor)),
    entries: null,
    entriesByKey: null
  };
}

/**
 * Select original effect/change pairs by exact normalized key while preserving
 * Foundry's Actor-effect, Item-effect, and change document order.
 */
export function getActorEffectChangeEntries(actor, acceptedKeys = null, { snapshot = null } = {}) {
  const resolved = getOrCreateSnapshot(actor, snapshot);
  prepareChangeIndex(resolved);
  if (acceptedKeys === null || acceptedKeys === undefined) return resolved.entries;

  const keys = normalizeAcceptedKeys(acceptedKeys);
  if (!keys.size) return [];
  if (keys.size === 1) {
    const [key] = keys;
    return resolved.entriesByKey.get(key) ?? [];
  }

  const entries = [];
  for (const key of keys) entries.push(...(resolved.entriesByKey.get(key) ?? []));
  entries.sort((left, right) => left.order - right.order);
  return entries;
}

export function getActorEffectPreparationStats(actor) {
  const context = actorPreparationContexts.get(actor);
  return {
    active: Boolean(context),
    embeddedEffectsPrepared: Boolean(context?.embeddedEffectsPrepared),
    effectCount: context?.snapshot?.effects?.length ?? 0,
    changeCount: context?.snapshot?.entries?.length ?? 0
  };
}

function getOrCreateSnapshot(actor, snapshot = null) {
  const resolved = getUsableSnapshot(actor, snapshot);
  if (resolved) return resolved;

  const context = actorPreparationContexts.get(actor);
  if (context?.embeddedEffectsPrepared) {
    context.snapshot ??= createActorEffectSnapshot(actor);
    return context.snapshot;
  }
  return createActorEffectSnapshot(actor);
}

function getUsableSnapshot(actor, snapshot) {
  return snapshot?.actor === actor && Array.isArray(snapshot.effects)
    ? snapshot
    : null;
}

function prepareChangeIndex(snapshot) {
  if (snapshot.entries && snapshot.entriesByKey) return;
  const entries = [];
  const entriesByKey = new Map();
  let order = 0;
  for (const effect of snapshot.effects) {
    for (const change of effect?.system?.changes ?? effect?.changes ?? []) {
      const key = String(change?.key ?? "").trim();
      const entry = { effect, change, key, order: order++ };
      entries.push(entry);
      if (!key) continue;
      const keyed = entriesByKey.get(key) ?? [];
      keyed.push(entry);
      entriesByKey.set(key, keyed);
    }
  }
  snapshot.entries = entries;
  snapshot.entriesByKey = entriesByKey;
}

function normalizeAcceptedKeys(acceptedKeys) {
  const values = typeof acceptedKeys === "string"
    ? [acceptedKeys]
    : typeof acceptedKeys?.[Symbol.iterator] === "function"
      ? Array.from(acceptedKeys)
      : [acceptedKeys];
  return new Set(values
    .map(key => String(key ?? "").trim())
    .filter(Boolean));
}

function getLiveApplicableEffects(actor) {
  if (typeof actor?.allApplicableEffects === "function") return actor.allApplicableEffects();
  return actor?.effects ?? [];
}
