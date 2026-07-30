import { toInteger } from "./numbers.mjs";

/**
 * Clamp a skill value to the same integer limits used by the Actor data model.
 */
export function clampSkillValue(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const lower = toInteger(min);
  const numericMax = Number(max);
  const upper = Number.isFinite(numericMax)
    ? Math.max(lower, Math.trunc(numericMax))
    : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(toInteger(value), lower), upper);
}

/**
 * Apply the additive percentage layer to an already composed flat skill value.
 *
 * Percentage changes are a second layer over the already composed flat value.
 * In pure-only mode the upper limit must not touch that value because it may
 * legitimately contain external bonuses above the development limit. Callers
 * using the limit as an absolute cap request both the pre- and post-scale clamp.
 */
export function applySkillBonusPercent(value, bonusPercent = 0, {
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  capResult = false
} = {}) {
  const limits = { min, max };
  const valueBeforePercent = capResult
    ? clampSkillValue(value, limits)
    : Math.max(toInteger(min), toInteger(value));
  const factor = Math.max(0, 1 + (toInteger(bonusPercent) / 100));
  const adjusted = Math.round(valueBeforePercent * factor);
  return capResult
    ? clampSkillValue(adjusted, limits)
    : Math.max(toInteger(min), adjusted);
}

/**
 * Compose every prepared skill component in the canonical order.
 */
export function composePreparedSkillValue(skill = {}) {
  const base = toInteger(skill.base);
  const bonus = toInteger(skill.bonus);
  const developmentBonus = toInteger(skill.developmentBonus);
  const abilityBonus = toInteger(skill.abilityBonus);
  const bonusPercent = toInteger(skill.bonusPercent);
  const configuredPureValue = Number(skill.pureValue);
  const pureValue = Number.isFinite(configuredPureValue)
    ? Math.max(0, Math.trunc(configuredPureValue))
    : Math.max(0, base + developmentBonus);
  const developmentLimitPureOnly = skill.developmentLimitPureOnly !== false;
  const min = toInteger(skill.min);
  const numericMax = Number(skill.max);
  const max = Number.isFinite(numericMax)
    ? Math.max(min, Math.trunc(numericMax))
    : Number.MAX_SAFE_INTEGER;
  const rawFlatValue = base + bonus + developmentBonus + abilityBonus;
  const limitedPureValue = clampSkillValue(pureValue, { min, max });
  const externalFlatValue = rawFlatValue - pureValue;
  const flatUnclamped = developmentLimitPureOnly
    ? limitedPureValue + externalFlatValue
    : rawFlatValue;
  const valueBeforePercent = developmentLimitPureOnly
    ? Math.max(min, flatUnclamped)
    : clampSkillValue(flatUnclamped, { min, max });
  const factor = Math.max(0, 1 + (bonusPercent / 100));
  const unclamped = Math.round(valueBeforePercent * factor);
  const value = developmentLimitPureOnly
    ? Math.max(min, unclamped)
    : clampSkillValue(unclamped, { min, max });
  return {
    base,
    bonus,
    developmentBonus,
    abilityBonus,
    bonusPercent,
    pureValue,
    limitedPureValue,
    externalFlatValue,
    developmentLimitPureOnly,
    min,
    max,
    rawFlatValue,
    flatUnclamped,
    valueBeforePercent,
    unclamped,
    value
  };
}

/**
 * Read the prepared flat layer while remaining compatible with older/test data.
 */
export function getSkillValueBeforePercent(skill = {}) {
  const prepared = Number(skill?.valueBeforePercent);
  return Number.isFinite(prepared) ? Math.trunc(prepared) : toInteger(skill?.value);
}
