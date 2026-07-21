import { normalizeAbilityFunctions } from "../settings/abilities.mjs";

export const EFFECT_LIFECYCLE_FLAG_KEY = "effectLifecycle";

export const EFFECT_LIFECYCLE_KINDS = Object.freeze({
  sourceProjection: "sourceProjection",
  disposableInstance: "disposableInstance",
  reconciledInstance: "reconciledInstance"
});

/**
 * Keep only the function fields needed to attribute an applied change back to
 * its conditions. Generated effects must not retain the much larger action or
 * fixed-function configuration when they cannot execute it themselves.
 */
export function buildEffectFunctionSnapshot(abilityFunction = {}) {
  if (!String(abilityFunction?.id ?? "").trim()) return null;
  const normalized = normalizeAbilityFunctions([abilityFunction])[0];
  if (!normalized) return null;
  return clonePlainData({
    id: normalized.id,
    type: normalized.type,
    changes: normalized.changes ?? [],
    conditions: normalized.conditions ?? [],
    penalties: normalized.penalties ?? []
  });
}

function clonePlainData(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
