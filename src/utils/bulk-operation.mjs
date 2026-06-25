const flushers = new Set();

let depth = 0;
let state = createBulkState();

function createBulkState() {
  return {
    abilityActors: new Map(),
    auraState: false,
    stealthActors: new Map(),
    stealthVisibility: false,
    postureActors: new Map()
  };
}

export function isBulkOperationActive() {
  return depth > 0;
}

export function beginBulkOperation() {
  depth += 1;
}

export async function endBulkOperation() {
  if (depth <= 0) return;
  depth -= 1;
  if (depth > 0) return;

  const context = state;
  state = createBulkState();
  for (const flusher of flushers) await flusher(context);
}

export function registerBulkOperationFlusher(flusher) {
  if (typeof flusher !== "function") return () => undefined;
  flushers.add(flusher);
  return () => flushers.delete(flusher);
}

export function deferAbilityEffectSync(actor, context = {}, { aura = false } = {}) {
  if (!isBulkOperationActive()) return false;
  const actorUuid = actor?.uuid;
  if (!actorUuid) return true;
  const queued = state.abilityActors.get(actorUuid) ?? { actor, context: {}, aura: false };
  queued.actor = actor;
  queued.context = { ...queued.context, ...context };
  queued.aura = queued.aura || aura;
  state.abilityActors.set(actorUuid, queued);
  return true;
}

export function deferAuraStateSync() {
  if (!isBulkOperationActive()) return false;
  state.auraState = true;
  return true;
}

export function deferStealthActorRefresh(actor) {
  if (!isBulkOperationActive()) return false;
  if (actor?.uuid) state.stealthActors.set(actor.uuid, actor);
  return true;
}

export function deferStealthedTokenVisibilityRefresh() {
  if (!isBulkOperationActive()) return false;
  state.stealthVisibility = true;
  return true;
}

export function deferActorPosture(actor, action = "walk") {
  if (!isBulkOperationActive()) return false;
  if (actor?.uuid) state.postureActors.set(actor.uuid, { actor, action });
  return true;
}
