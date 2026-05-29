import { createEffectKeyToken } from "../apps/effect-key-autocomplete.mjs";

const ACQUISITION_CHANGE_GROUP = "Ability acquisition";
const ACQUISITION_CHANGE_KEYS = Object.freeze([
  {
    code: "experience",
    key: "experience",
    labelKey: "FALLOUTMAW.Advancement.Experience",
    fallback: "Experience",
    path: "system.development.experience"
  },
  {
    code: "characteristicPoints",
    key: "characteristics",
    labelKey: "FALLOUTMAW.Advancement.CharacteristicPoints",
    fallback: "Characteristic points",
    path: "system.development.points.characteristics"
  },
  {
    code: "signatureSkillPoints",
    key: "signatureSkills",
    labelKey: "FALLOUTMAW.Advancement.SignatureSkillPoints",
    fallback: "Signature skill points",
    path: "system.development.points.signatureSkills"
  },
  {
    code: "traitPoints",
    key: "traits",
    labelKey: "FALLOUTMAW.Advancement.TraitPoints",
    fallback: "Trait points",
    path: "system.development.points.traits"
  },
  {
    code: "proficiencyPoints",
    key: "proficiencies",
    labelKey: "FALLOUTMAW.Advancement.ProficiencyPoints",
    fallback: "Proficiency points",
    path: "system.development.points.proficiencies"
  },
  {
    code: "skillPoints",
    key: "skills",
    labelKey: "FALLOUTMAW.Advancement.SkillPoints",
    fallback: "Skill points",
    path: "system.development.points.skills"
  },
  {
    code: "researchPoints",
    key: "researches",
    labelKey: "FALLOUTMAW.Advancement.ResearchPoints",
    fallback: "Research points",
    path: "system.development.points.researches"
  }
]);

const ACQUISITION_CHANGE_PATHS = new Set(ACQUISITION_CHANGE_KEYS.map(entry => entry.path));

export function buildAbilityAcquisitionChangeKeyTokens() {
  return ACQUISITION_CHANGE_KEYS.map(entry => createEffectKeyToken({
    code: entry.code,
    key: entry.key,
    label: localizeOrFallback(entry.labelKey, entry.fallback),
    path: entry.path,
    group: localizeOrFallback("FALLOUTMAW.Advancement.Title", ACQUISITION_CHANGE_GROUP)
  })).filter(Boolean);
}

export function isAbilityAcquisitionChangeKey(key = "") {
  return ACQUISITION_CHANGE_PATHS.has(String(key ?? "").trim());
}

function localizeOrFallback(key, fallback) {
  const value = game.i18n.localize(key);
  return value === key ? fallback : value;
}
