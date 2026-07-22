function asFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** Resolve the weapon's legacy value/max fields into explicit near/far boundaries. */
export function resolveBaseWeaponEffectiveRange(effectiveRange = {}, evaluate = asFiniteNumber) {
  const near = Math.max(0, asFiniteNumber(evaluate(effectiveRange?.value), 0));
  const far = Math.max(0, asFiniteNumber(evaluate(effectiveRange?.max), 0));
  if (near <= 0 && far <= 0) return null;
  if (far <= 0) return { min: 0, max: near };
  return {
    min: Math.min(near, far),
    max: far
  };
}

/** Apply the two independent flat-metre boundary changes without swapping their roles. */
export function applyWeaponEffectiveRangeBonuses(baseRange = null, {
  nearBonusMeters = 0,
  farBonusMeters = 0
} = {}) {
  const baseNear = Math.max(0, asFiniteNumber(baseRange?.min, 0));
  const baseFar = Math.max(0, asFiniteNumber(baseRange?.max, 0));
  const far = Math.max(0, baseFar + asFiniteNumber(farBonusMeters, 0));
  if (far <= 0) return null;
  const near = Math.max(0, baseNear + asFiniteNumber(nearBonusMeters, 0));
  return {
    min: Math.min(near, far),
    max: far
  };
}
