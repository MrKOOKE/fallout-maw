import { toInteger } from "../utils/numbers.mjs";

export const CONSCIOUSNESS_RESOURCE_KEY = "consciousness";
export const CONSCIOUSNESS_RECOVERY_TARGET_PATH = "system.combat.consciousnessRecoveryTarget";
export const SHOCK_SUCCESS_CONSCIOUSNESS_LOSS_PERCENT = 25;

const SHOCK_SUCCESS_RESULT_KEYS = new Set(["success", "criticalSuccess"]);
const SHOCK_FAILURE_RESULT_KEYS = new Set(["failure", "criticalFailure"]);

/**
 * Consciousness capacity is the arithmetic mean of all critical limb maximums.
 * A creature without critical limbs does not use consciousness mechanics.
 */
export function calculateCriticalLimbAverageMaximum(limbs = {}) {
  const criticalLimbs = Object.values(limbs ?? {})
    .filter(limb => limb && typeof limb === "object" && Boolean(limb.critical));
  if (!criticalLimbs.length) return 0;

  const total = criticalLimbs.reduce(
    (sum, limb) => sum + Math.max(0, toInteger(limb.max)),
    0
  );
  return Math.max(0, Math.round(total / criticalLimbs.length));
}

/**
 * While an actor is unconscious, the captured wake-up threshold temporarily
 * replaces the calculated capacity. Once the threshold is cleared, the
 * calculated maximum becomes authoritative again.
 */
export function resolveConsciousnessMaximum(calculatedMaximum = 0, recoveryTarget = 0) {
  const target = Math.max(0, toInteger(recoveryTarget));
  return target > 0
    ? target
    : Math.max(0, toInteger(calculatedMaximum));
}

export function getConsciousnessState(resource = null) {
  if (!resource || typeof resource !== "object") return null;

  // Consciousness is a fixed zero-based scale. Keeping this invariant here
  // also makes legacy/custom resource data unable to turn a failed shock check
  // into a non-zero result.
  const min = 0;
  const max = resolveConsciousnessMaximum(resource.max, resource.recoveryTarget);
  const value = Math.min(Math.max(toInteger(resource.value), min), max);
  return {
    min,
    max,
    value,
    capacity: Math.max(0, max - min),
    spent: Math.max(0, max - value)
  };
}

export function isConsciousnessDepleted(resource = null) {
  const state = getConsciousnessState(resource);
  return Boolean(state && state.capacity > 0 && state.value <= state.min);
}

export function getConsciousnessRecoveryTarget(resource = null) {
  return Math.max(0, toInteger(resource?.recoveryTarget));
}

export function isConsciousnessUnconscious(resource = null) {
  const state = getConsciousnessState(resource);
  if (!state) return false;
  const recoveryTarget = getConsciousnessRecoveryTarget(resource);
  if (recoveryTarget > 0) return state.value < recoveryTarget;
  return state.capacity > 0 && state.value <= state.min;
}

export function hasConsciousnessDepletionTransition(resource = null, requestedValue = 0) {
  const updateData = buildConsciousnessUpdateData(resource, requestedValue);
  if (!updateData) return false;
  return isConsciousnessUnconscious(resource)
    !== isConsciousnessUnconscious({ ...resource, ...updateData });
}

/**
 * A successful shock check removes 25% of the full scale. A failed check
 * depletes it completely. Unknown/non-terminal outcomes leave it unchanged.
 */
export function calculateShockConsciousnessValue(resource = null, resultKey = "") {
  const state = getConsciousnessState(resource);
  if (!state || state.capacity <= 0) return state?.value ?? 0;

  const key = String(resultKey ?? "").trim();
  if (SHOCK_FAILURE_RESULT_KEYS.has(key)) return 0;
  if (!SHOCK_SUCCESS_RESULT_KEYS.has(key)) return state.value;

  const loss = Math.max(
    1,
    Math.ceil((state.capacity * SHOCK_SUCCESS_CONSCIOUSNESS_LOSS_PERCENT) / 100)
  );
  return Math.max(state.min, state.value - loss);
}

export function calculateConsciousnessRecoveryValue(resource = null, restoredHealth = 0) {
  const state = getConsciousnessState(resource);
  if (!state) return 0;

  const recovery = Math.max(0, Math.round(Number(restoredHealth) || 0));
  return Math.min(state.max, state.value + recovery);
}

/**
 * Consciousness follows the complete applied healing delta, including the
 * portion below zero which is intentionally absent from aggregate health.
 */
export function calculateConsciousnessHealingGain(previousValue = 0, nextValue = 0) {
  return Math.max(0, toInteger(nextValue) - toInteger(previousValue));
}

export function buildConsciousnessValueData(resource = null, requestedValue = 0) {
  const state = getConsciousnessState(resource);
  if (!state) return null;

  const value = Math.min(Math.max(toInteger(requestedValue), state.min), state.max);
  return {
    value,
    spent: Math.max(0, state.max - value)
  };
}

/**
 * Build the complete persisted mutation for the consciousness state machine.
 * Reaching zero captures the current numeric maximum as a fixed wake-up target;
 * reaching that target clears it.
 */
export function buildConsciousnessUpdateData(resource = null, requestedValue = 0) {
  const valueData = buildConsciousnessValueData(resource, requestedValue);
  const state = getConsciousnessState(resource);
  if (!valueData || !state) return null;

  let recoveryTarget = getConsciousnessRecoveryTarget(resource);
  if (recoveryTarget > 0 && valueData.value >= recoveryTarget) {
    recoveryTarget = 0;
  } else if (recoveryTarget <= 0 && state.capacity > 0 && valueData.value <= state.min) {
    recoveryTarget = state.max;
  }
  return { ...valueData, recoveryTarget };
}
