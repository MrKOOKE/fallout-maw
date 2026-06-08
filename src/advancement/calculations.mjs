import { normalizeActorDevelopment } from "./storage.mjs";
import { evaluateSkillFormulas } from "../formulas/index.mjs";

export function calculateRemainingDevelopmentPoints(development = {}) {
  const points = development?.points ?? {};
  return {
    characteristics: Math.max(0, Number(points.characteristics) || 0),
    signatureSkills: Math.max(0, Number(points.signatureSkills) || 0),
    traits: Math.max(0, Number(points.traits) || 0),
    proficiencies: Math.max(0, Number(points.proficiencies) || 0),
    skills: Math.max(0, Number(points.skills) || 0),
    researches: Math.max(0, Number(points.researches) || 0)
  };
}

export function calculateSkillPointMultiplier(skillKey, characteristics = {}, advancementSettings = {}, baseBonuses = {}) {
  const entry = advancementSettings?.entries?.[skillKey] ?? {};
  let multiplier = (Number(entry?.base) || 0) + (Number(baseBonuses?.[skillKey]) || 0);

  for (const [characteristicKey, coefficient] of Object.entries(entry?.characteristics ?? {})) {
    multiplier += (Number(characteristics?.[characteristicKey]) || 0) * (Number(coefficient) || 0);
  }

  return multiplier;
}

export function calculateSkillDevelopmentBonus(skillKey, characteristics = {}, advancementSettings = {}, developmentSkill = {}, baseBonuses = {}) {
  const points = Math.max(0, Number(developmentSkill?.points) || 0);
  const investedValue = points * calculateSkillPointMultiplier(skillKey, characteristics, advancementSettings, baseBonuses);
  if (!developmentSkill?.signature) return investedValue;

  const signatureMultiplier = Number(advancementSettings?.signatureMultiplier) || 0;
  const signatureFlatBonus = Number(advancementSettings?.signatureFlatBonus) || 0;
  return (investedValue * signatureMultiplier) + signatureFlatBonus;
}

export function calculateSkillDevelopmentBonuses(
  skillSettings = [],
  characteristics = {},
  advancementSettings = {},
  development = {},
  baseBonuses = {}
) {
  const normalized = normalizeActorDevelopment(development, [], skillSettings);
  return Object.fromEntries(
    skillSettings.map(skill => [
      skill.key,
      calculateSkillDevelopmentBonus(skill.key, characteristics, advancementSettings, normalized.skills?.[skill.key], baseBonuses)
    ])
  );
}

export function calculatePureSkillDevelopmentValue(
  skillKey,
  skillSettings = [],
  characteristicSettings = [],
  characteristics = {},
  advancementSettings = {},
  development = {},
  baseBonuses = {}
) {
  const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, characteristics);
  const normalized = normalizeActorDevelopment(development, [], skillSettings);
  const developmentBonus = calculateSkillDevelopmentBonus(
    skillKey,
    characteristics,
    advancementSettings,
    normalized.skills?.[skillKey],
    baseBonuses
  );
  return Math.max(0, Math.trunc((Number(skillBases?.[skillKey]) || 0) + (Number(developmentBonus) || 0)));
}
