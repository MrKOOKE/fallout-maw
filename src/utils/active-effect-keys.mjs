import { SYSTEM_ID } from "../constants.mjs";

export const ALL_SKILLS_BONUS_EFFECT_KEY = "system.skills.all.bonus";
export const ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY = "system.skills.all.bonusPercent";
export const ALL_SKILLS_ADVANTAGE_EFFECT_KEY = "system.skills.all.advantage";
export const ALL_SKILLS_DISADVANTAGE_EFFECT_KEY = "system.skills.all.disadvantage";
export const ALL_SKILLS_CRITICAL_SUCCESS_CHANCE_EFFECT_KEY = "system.skills.all.criticalSuccessChance";
export const ALL_SKILLS_CRITICAL_FAILURE_CHANCE_EFFECT_KEY = "system.skills.all.criticalFailureChance";
export const ALL_COMBAT_ADVANTAGE_EFFECT_KEY = "system.combat.all.advantage";
export const ALL_COMBAT_DISADVANTAGE_EFFECT_KEY = "system.combat.all.disadvantage";
export const ATTACK_RANGE_BONUS_EFFECT_KEY = "system.combat.attackRangeBonus";
export const EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY = "system.combat.effectiveRangeNearBonus";
export const EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY = "system.combat.effectiveRangeFarBonus";
export const EFFECTIVE_RANGE_NEAR_PENALTY_PERCENT_EFFECT_KEY = "system.combat.effectiveRangeNearPenaltyPercent";
export const EFFECTIVE_RANGE_FAR_PENALTY_PERCENT_EFFECT_KEY = "system.combat.effectiveRangeFarPenaltyPercent";
export const AIMED_EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY = "system.combat.aimedEffectiveRangeNearBonus";
export const AIMED_EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY = "system.combat.aimedEffectiveRangeFarBonus";
export const AIMED_EFFECTIVE_RANGE_NEAR_RESTRICTION_DISABLED_EFFECT_KEY = "system.combat.aimedEffectiveRangeNearRestrictionDisabled";
export const AIMED_EFFECTIVE_RANGE_FAR_RESTRICTION_DISABLED_EFFECT_KEY = "system.combat.aimedEffectiveRangeFarRestrictionDisabled";
export const ATTACK_ACTION_POINT_MOVEMENT_LOSS_PERCENT_BONUS_EFFECT_KEY = "system.combat.attackActionPointMovementLossPercentBonus";
export const ATTACK_ACTION_POINT_MOVEMENT_LOSS_DISABLED_EFFECT_KEY = "system.combat.attackActionPointMovementLossDisabled";
export const CONDITION_LOSS_MULTIPLIER_EFFECT_KEY = "system.combat.conditionLossMultiplier";
export const CRITICAL_DAMAGE_PERCENT_EFFECT_KEY = "system.combat.criticalDamagePercent";
export const STUN_IMMUNITY_EFFECT_KEY = "system.combat.stunImmunity";
export const UNCONSCIOUSNESS_IMMUNITY_EFFECT_KEY = "system.combat.unconsciousnessImmunity";
export const INITIATIVE_ADVANTAGE_EFFECT_KEY = "system.attributes.initiative.advantage";
export const INITIATIVE_DISADVANTAGE_EFFECT_KEY = "system.attributes.initiative.disadvantage";
export const REVERSE_EFFECT_KEY_PREFIX = `${SYSTEM_ID}.reverse.`;

export const SMART_FUDGE_RESULT_EFFECT_KEYS = Object.freeze({
  criticalSuccess: "fallout-maw.skillCheck.smartFudge.criticalSuccess",
  success: "fallout-maw.skillCheck.smartFudge.success",
  failure: "fallout-maw.skillCheck.smartFudge.failure",
  criticalFailure: "fallout-maw.skillCheck.smartFudge.criticalFailure"
});

export const SKILL_CHECK_DISABLED_RESULT_EFFECT_KEYS = Object.freeze({
  criticalFailure: "system.skillCheck.disabledResults.criticalFailure",
  failure: "system.skillCheck.disabledResults.failure",
  success: "system.skillCheck.disabledResults.success",
  criticalSuccess: "system.skillCheck.disabledResults.criticalSuccess"
});

export function getReverseEffectKey(key = "") {
  const path = String(key ?? "").trim();
  return path ? `${REVERSE_EFFECT_KEY_PREFIX}${path}` : "";
}

export function getOriginalEffectKeyFromReverse(key = "") {
  const path = String(key ?? "").trim();
  if (!path.startsWith(REVERSE_EFFECT_KEY_PREFIX)) return "";
  return path.slice(REVERSE_EFFECT_KEY_PREFIX.length).trim();
}

export function isReverseEffectKey(key = "") {
  return Boolean(getOriginalEffectKeyFromReverse(key));
}

export function isSkillBonusPercentEffectKey(key = "") {
  const path = getOriginalEffectKeyFromReverse(key) || String(key ?? "").trim();
  return /^system\.skills\.[^.]+\.bonusPercent$/.test(path);
}
