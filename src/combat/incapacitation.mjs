export const UNABLE_TO_ACT_STATUSES = Object.freeze(["dead", "unconscious", "stunned"]);

export function actorHasIncapacitatingStatus(actor = null) {
  if (!actor) return false;
  const defeatedStatus = globalThis.CONFIG?.specialStatusEffects?.DEFEATED;
  return Boolean(
    UNABLE_TO_ACT_STATUSES.some(status => actor.statuses?.has?.(status))
    || (defeatedStatus && actor.statuses?.has?.(defeatedStatus))
  );
}
