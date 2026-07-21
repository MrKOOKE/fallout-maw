import { ABILITY_CONDITION_TYPES } from "../settings/abilities.mjs";
import { isActiveUseEffectKey } from "./active-use-keys.mjs";

/** Return only the limited-use metadata rows attached to a function. */
export function getLimitedUseConditions(conditions = []) {
  return (conditions ?? []).filter(condition => condition?.type === ABILITY_CONDITION_TYPES.limitedUses);
}

/** Normalize the mutable counter of one limited-use condition. */
export function getLimitedUseConditionState(condition = {}) {
  const usesSpent = Math.max(0, toWholeNumber(condition?.usesSpent));
  const usesMax = Math.max(1, toWholeNumber(condition?.usesMax, 1));
  return {
    id: String(condition?.id ?? "").trim(),
    usesSpent,
    usesMax,
    usesRemaining: Math.max(0, usesMax - usesSpent),
    exhausted: usesSpent >= usesMax
  };
}

/** Normalize all limited-use counters and their aggregate exhaustion state. */
export function getLimitedUsesState(conditions = []) {
  const entries = getLimitedUseConditions(conditions).map(getLimitedUseConditionState);
  return {
    entries,
    exhausted: entries.some(entry => entry.exhausted)
  };
}

export function isLimitedUseConditionExhausted(condition = {}) {
  return condition?.type === ABILITY_CONDITION_TYPES.limitedUses
    && getLimitedUseConditionState(condition).exhausted;
}

export function hasExhaustedLimitedUses(conditions = []) {
  return getLimitedUseConditions(conditions).some(isLimitedUseConditionExhausted);
}

/**
 * Exhaustion disables only values which are consumed by a committed operation.
 * Passive rows in the same function remain active.
 */
export function filterChangesForLimitedUses(changes = [], conditions = []) {
  const selected = Array.isArray(changes) ? changes : [];
  if (!hasExhaustedLimitedUses(conditions)) return selected;
  return selected.filter(change => !isActiveUseEffectKey(change?.key));
}

function toWholeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}
