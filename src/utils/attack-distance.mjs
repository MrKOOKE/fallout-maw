/** Normalize the measured distance used by attack-context consumers. */
export function normalizeAttackDistanceMeters(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : null;
}

/** Normalize a prepared effective-range snapshot without evaluating weapon formulas. */
export function normalizeAttackEffectiveRange(value = null) {
  if (!value || typeof value !== "object") return null;
  const minimum = Number(value.min ?? value.minimum);
  const maximum = Number(value.max ?? value.maximum);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null;
  return {
    min: Math.max(0, Math.min(minimum, maximum)),
    max: Math.max(0, Math.max(minimum, maximum))
  };
}

/** Keep socket/event snapshots on the same compact `{ distance, range }` contract. */
export function normalizeAttackDistanceContext(source = {}) {
  return {
    attackDistanceMeters: normalizeAttackDistanceMeters(source?.attackDistanceMeters),
    effectiveRange: normalizeAttackEffectiveRange(source?.effectiveRange ?? source?.effectiveRangeBounds)
  };
}

/**
 * Classify one prepared attack distance against its effective range.
 * `basePenalty` mirrors the weapon difficulty rule: 10 points per rounded metre.
 */
export function getEffectiveRangeDistanceState(source = {}) {
  const { attackDistanceMeters, effectiveRange } = normalizeAttackDistanceContext(source);
  if (attackDistanceMeters === null || !effectiveRange || effectiveRange.max <= 0) {
    return {
      resolved: false,
      attackDistanceMeters,
      effectiveRange,
      side: "",
      overrunMeters: 0,
      roundedOverrunMeters: 0,
      basePenalty: 0
    };
  }

  const side = attackDistanceMeters < effectiveRange.min
    ? "near"
    : attackDistanceMeters > effectiveRange.max ? "far" : "inside";
  const overrunMeters = side === "near"
    ? effectiveRange.min - attackDistanceMeters
    : side === "far" ? attackDistanceMeters - effectiveRange.max : 0;
  const roundedOverrunMeters = Math.max(0, Math.round(overrunMeters));
  return {
    resolved: true,
    attackDistanceMeters,
    effectiveRange,
    side,
    overrunMeters,
    roundedOverrunMeters,
    basePenalty: roundedOverrunMeters * 10
  };
}
