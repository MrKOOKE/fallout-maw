import { normalizeActorDevelopment } from "./storage.mjs";

export function calculateSpentCharacteristicPoints(development = {}) {
  return Object.values(development?.characteristics ?? {}).reduce((total, value) => total + (Number(value) || 0), 0);
}

export function calculateSpentSkillPoints(development = {}) {
  return Object.values(development?.skills ?? {}).reduce((total, skill) => total + (Number(skill?.points) || 0), 0);
}

export function calculateSpentSignatureSkillPoints(development = {}) {
  return Object.values(development?.skills ?? {}).reduce((total, skill) => total + (skill?.signature ? 1 : 0), 0);
}

export function calculateRemainingDevelopmentPoints(development = {}) {
  return {
    characteristics: Math.max(0, (Number(development?.points?.characteristics) || 0) - calculateSpentCharacteristicPoints(development)),
    signatureSkills: Math.max(0, (Number(development?.points?.signatureSkills) || 0) - calculateSpentSignatureSkillPoints(development)),
    traits: Math.max(0, Number(development?.points?.traits) || 0),
    proficiencies: Math.max(0, Number(development?.points?.proficiencies) || 0),
    skills: Math.max(0, (Number(development?.points?.skills) || 0) - calculateSpentSkillPoints(development)),
    researches: Math.max(0, Number(development?.points?.researches) || 0)
  };
}

export function calculateSkillPointMultiplier(skillKey, characteristics = {}, advancementSettings = {}) {
  const entry = advancementSettings?.entries?.[skillKey] ?? {};
  let multiplier = Number(entry?.base) || 0;

  for (const [characteristicKey, coefficient] of Object.entries(entry?.characteristics ?? {})) {
    multiplier += (Number(characteristics?.[characteristicKey]) || 0) * (Number(coefficient) || 0);
  }

  return multiplier;
}

export function calculateSkillDevelopmentBonus(skillKey, characteristics = {}, advancementSettings = {}, developmentSkill = {}) {
  const points = Math.max(0, Number(developmentSkill?.points) || 0);
  const investedValue = points * calculateSkillPointMultiplier(skillKey, characteristics, advancementSettings);
  if (!developmentSkill?.signature) return investedValue;

  const signatureMultiplier = Number(advancementSettings?.signatureMultiplier) || 0;
  const signatureFlatBonus = Number(advancementSettings?.signatureFlatBonus) || 0;
  return (investedValue * signatureMultiplier) + signatureFlatBonus;
}

export function calculateSkillDevelopmentBonuses(
  skillSettings = [],
  characteristics = {},
  advancementSettings = {},
  development = {}
) {
  const normalized = normalizeActorDevelopment(development, [], skillSettings);
  return Object.fromEntries(
    skillSettings.map(skill => [
      skill.key,
      calculateSkillDevelopmentBonus(skill.key, characteristics, advancementSettings, normalized.skills?.[skill.key])
    ])
  );
}
