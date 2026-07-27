export const UNABLE_TO_ACT_STATUSES = Object.freeze(["dead", "unconscious"]);

export function actorHasIncapacitatingStatus(actor = null) {
  if (!actor) return false;
  const defeatedStatus = globalThis.CONFIG?.specialStatusEffects?.DEFEATED;
  return Boolean(
    UNABLE_TO_ACT_STATUSES.some(status => actor.statuses?.has?.(status))
    || (defeatedStatus && actor.statuses?.has?.(defeatedStatus))
  );
}

export function actorStatusAllowsReaction(actor = null, {
  allowUnconscious = false,
  allowDead = false
} = {}) {
  if (!actor) return false;
  const defeatedStatus = globalThis.CONFIG?.specialStatusEffects?.DEFEATED;
  const hasStatus = status => Boolean(status && actor.statuses?.has?.(status));
  const isDead = hasStatus("dead") || hasStatus(defeatedStatus);
  if (isDead) return Boolean(allowDead);
  if (hasStatus("unconscious")) return Boolean(allowUnconscious);
  return true;
}
