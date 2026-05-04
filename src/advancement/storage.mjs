import { toInteger } from "../utils/numbers.mjs";

export function createDefaultActorDevelopment(characteristicSettings = [], skillSettings = []) {
  return {
    initialized: false,
    experience: 0,
    points: {
      characteristics: 0,
      signatureSkills: 0,
      traits: 0,
      proficiencies: 0,
      skills: 0,
      researches: 0
    },
    characteristics: Object.fromEntries(characteristicSettings.map(entry => [entry.key, 0])),
    skills: Object.fromEntries(skillSettings.map(entry => [entry.key, { points: 0, signature: false }]))
  };
}

export function normalizeActorDevelopment(development = {}, characteristicSettings = [], skillSettings = []) {
  const defaults = createDefaultActorDevelopment(characteristicSettings, skillSettings);

  return {
    initialized: Boolean(development?.initialized),
    experience: Math.max(0, toInteger(development?.experience)),
    points: {
      characteristics: Math.max(0, toInteger(development?.points?.characteristics ?? defaults.points.characteristics)),
      signatureSkills: Math.max(0, toInteger(development?.points?.signatureSkills ?? defaults.points.signatureSkills)),
      traits: Math.max(0, toInteger(development?.points?.traits ?? defaults.points.traits)),
      proficiencies: Math.max(0, toInteger(development?.points?.proficiencies ?? defaults.points.proficiencies)),
      skills: Math.max(0, toInteger(development?.points?.skills ?? defaults.points.skills)),
      researches: Math.max(0, toInteger(development?.points?.researches ?? defaults.points.researches))
    },
    characteristics: Object.fromEntries(
      characteristicSettings.map(entry => [entry.key, Math.max(0, toInteger(development?.characteristics?.[entry.key]))])
    ),
    skills: Object.fromEntries(
      skillSettings.map(entry => [entry.key, normalizeSkillDevelopment(development?.skills?.[entry.key])])
    )
  };
}

export function cloneActorDevelopment(development = {}, characteristicSettings = [], skillSettings = []) {
  return foundry.utils.deepClone(normalizeActorDevelopment(development, characteristicSettings, skillSettings));
}

function normalizeSkillDevelopment(entry = {}) {
  return {
    points: Math.max(0, toInteger(entry?.points)),
    signature: Boolean(entry?.signature)
  };
}
