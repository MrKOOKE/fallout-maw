import {
  getEffectiveRangeDistanceState,
  normalizeAttackDistanceMeters,
  normalizeAttackEffectiveRange
} from "./attack-distance.mjs";
import { applyWeaponEffectiveRangeBonuses } from "./weapon-range.mjs";

/** Resolve whether a ranged aimed action may select a target at this distance. */
export function getAimedRangeSelectionState({
  attackDistanceMeters = null,
  effectiveRange = null,
  nearBonusMeters = 0,
  farBonusMeters = 0,
  nearLimitDisabled = 0,
  farLimitDisabled = 0
} = {}) {
  const baseEffectiveRange = normalizeAttackEffectiveRange(effectiveRange);
  if (!baseEffectiveRange) {
    return {
      ...getEffectiveRangeDistanceState({ attackDistanceMeters, effectiveRange: null }),
      baseEffectiveRange: null,
      allowed: true,
      limitDisabled: false
    };
  }

  const aimedEffectiveRange = applyWeaponEffectiveRangeBonuses(baseEffectiveRange, {
    nearBonusMeters,
    farBonusMeters
  });
  const state = aimedEffectiveRange
    ? getEffectiveRangeDistanceState({
      attackDistanceMeters,
      effectiveRange: aimedEffectiveRange
    })
    : getCollapsedAimedRangeState(attackDistanceMeters);
  const limitDisabled = state.side === "near"
    ? Number(nearLimitDisabled) > 0
    : state.side === "far" && Number(farLimitDisabled) > 0;
  return {
    ...state,
    baseEffectiveRange,
    allowed: !state.resolved || state.side === "inside" || limitDisabled,
    limitDisabled
  };
}

function getCollapsedAimedRangeState(attackDistanceMeters) {
  const distance = normalizeAttackDistanceMeters(attackDistanceMeters);
  const resolved = distance !== null;
  const side = resolved && distance > 0 ? "far" : resolved ? "inside" : "";
  const overrunMeters = side === "far" ? distance : 0;
  const roundedOverrunMeters = Math.max(0, Math.round(overrunMeters));
  return {
    resolved,
    attackDistanceMeters: distance,
    effectiveRange: { min: 0, max: 0 },
    side,
    overrunMeters,
    roundedOverrunMeters,
    basePenalty: roundedOverrunMeters * 10
  };
}
