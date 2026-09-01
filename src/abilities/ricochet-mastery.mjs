import { toInteger } from "../utils/numbers.mjs";

export const RICOCHET_MASTERY_DEFAULT_SETTINGS = Object.freeze({
  activationEnergyCost: 10,
  overloadEnergyCost: 20,
  overloadDurationSeconds: 12,
  maxReflections: 4,
  maximumConeDegrees: 3,
  accuracyBonusPerReflection: 20,
  damagePercentBonusPerReflection: 10,
  penetrationBonusPerReflection: 10
});

export function normalizeRicochetMasterySettings(settings = {}) {
  return {
    activationEnergyCost: nonNegativeInteger(settings.activationEnergyCost, 10),
    overloadEnergyCost: nonNegativeInteger(settings.overloadEnergyCost, 20),
    overloadDurationSeconds: nonNegativeInteger(settings.overloadDurationSeconds, 12),
    maxReflections: nonNegativeInteger(settings.maxReflections, 4),
    maximumConeDegrees: clampNumber(settings.maximumConeDegrees, 3, 0, 180),
    accuracyBonusPerReflection: finiteInteger(settings.accuracyBonusPerReflection, 20),
    damagePercentBonusPerReflection: finiteInteger(settings.damagePercentBonusPerReflection, 10),
    penetrationBonusPerReflection: finiteInteger(settings.penetrationBonusPerReflection, 10)
  };
}

/** Immutable modifier payload consumed by attack geometry and damage paths. */
export function buildRicochetMasteryModifier(settings = {}) {
  return Object.freeze({ ...normalizeRicochetMasterySettings(settings) });
}

/** Controller geometry stores a half-angle in radians; the rule states a full cone. */
export function getRicochetMasteryMaximumHalfAngleRadians(settings = {}) {
  return normalizeRicochetMasterySettings(settings).maximumConeDegrees * Math.PI / 360;
}

export function getRicochetMasteryBonuses(reflectionCount = 0, settings = {}) {
  const normalized = normalizeRicochetMasterySettings(settings);
  const reflections = Math.max(0, Math.min(normalized.maxReflections, toInteger(reflectionCount)));
  return {
    reflections,
    accuracy: reflections * normalized.accuracyBonusPerReflection,
    damagePercent: reflections * normalized.damagePercentBonusPerReflection,
    penetration: reflections * normalized.penetrationBonusPerReflection
  };
}

/** Idempotent transition for consuming the prepared next Snapshot. */
export function consumeRicochetMasteryAttack(state = {}, {
  attackId = "",
  actionKey = "",
  committed = false
} = {}) {
  const current = normalizePreparationState(state);
  const id = String(attackId ?? "").trim();
  if (id && current.consumedAttackId === id) {
    return { consumed: false, duplicate: true, nextState: current };
  }
  if (!current.pending || !committed || String(actionKey ?? "").trim() !== "snapshot") {
    return { consumed: false, duplicate: false, nextState: current };
  }
  return {
    consumed: true,
    duplicate: false,
    nextState: { pending: false, consumedAttackId: id }
  };
}

function normalizePreparationState(state = {}) {
  return {
    pending: state?.pending === true,
    consumedAttackId: String(state?.consumedAttackId ?? "").trim()
  };
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, finiteInteger(value, fallback));
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return toInteger(Number.isFinite(number) ? number : fallback);
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
}
