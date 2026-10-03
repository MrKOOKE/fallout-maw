import { advanceConstructRotation } from "./construct-aim-geometry.mjs";
import { clampConstructVisualRotation, normalizeConstructVisualRotation } from "./construct-visual-model.mjs";

// A small, consumable lead covers the first frame and ordinary packet jitter.
// Capping the credit prevents idle time or new packets from banking extra turns.
export const CONSTRUCT_ROTATION_NETWORK_CREDIT_SECONDS = 0.15;
export const CONSTRUCT_ROTATION_REACHED_EPSILON = 0.001;

export function getConstructRotationTravelDegrees(current, target, sector = {}) {
  const anchor = Number(sector.anchorRotation) || 0;
  const bounded = Number.isFinite(sector.minRotation) && Number.isFinite(sector.maxRotation)
    && sector.maxRotation - sector.minRotation < 360;
  if (!bounded) return Math.abs(normalizeConstructVisualRotation(target - current));
  const from = clampConstructVisualRotation(current - anchor, sector.minRotation, sector.maxRotation);
  const to = clampConstructVisualRotation(target - anchor, sector.minRotation, sector.maxRotation);
  return Math.abs(to - from);
}

export function createConstructRotationRateState(rotation, timeMs, creditSeconds = CONSTRUCT_ROTATION_NETWORK_CREDIT_SECONDS) {
  return { rotation: normalizeConstructVisualRotation(rotation), timeMs: Number(timeMs),
    creditSeconds: Math.max(0, Math.min(CONSTRUCT_ROTATION_NETWORK_CREDIT_SECONDS, Number(creditSeconds) || 0)) };
}

/** Pure rate accounting shared by received previews and the authoritative commit. */
export function advanceConstructRotationRate(state, target, degreesPerSecond, timeMs, sector = {}) {
  const speed = Math.max(0.1, Number(degreesPerSecond) || 90);
  const elapsed = Math.max(0, (Number(timeMs) - state.timeMs) / 1000);
  const available = Math.min(CONSTRUCT_ROTATION_NETWORK_CREDIT_SECONDS, state.creditSeconds + elapsed);
  const rotation = advanceConstructRotation(state.rotation, target, speed, available, sector);
  const spent = getConstructRotationTravelDegrees(state.rotation, rotation, sector) / speed;
  return {
    reached: getConstructRotationTravelDegrees(rotation, target, sector) <= CONSTRUCT_ROTATION_REACHED_EPSILON,
    state: { rotation, timeMs: Number(timeMs), creditSeconds: Math.max(0, available - spent) }
  };
}
