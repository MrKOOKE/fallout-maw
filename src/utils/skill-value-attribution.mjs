import { toInteger } from "./numbers.mjs";

/**
 * Mirror the prepared skill value composition used by the actor data model.
 * The caller may attribute each component separately before applying the limits.
 */
export function decomposePreparedSkillValue(skill = {}) {
  const base = toInteger(skill.base);
  const bonus = toInteger(skill.bonus);
  const developmentBonus = toInteger(skill.developmentBonus);
  const abilityBonus = toInteger(skill.abilityBonus);
  const min = toInteger(skill.min);
  const max = Math.max(min, toInteger(skill.max));
  const unclamped = base + bonus + developmentBonus + abilityBonus;
  const value = Math.min(Math.max(unclamped, min), max);
  return { base, bonus, developmentBonus, abilityBonus, min, max, unclamped, value };
}
