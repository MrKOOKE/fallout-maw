import { calculateSkillDevelopmentBonuses } from "../advancement/calculations.mjs";
import {
  buildActorFormulaAutocompleteEntries,
  buildActorFormulaReferenceData
} from "../formulas/actor-references.mjs";
import { evaluateFormula, evaluateSkillFormulas, getSkillValues } from "../formulas/evaluation.mjs";
import { DEFAULT_NEEDS } from "../config/defaults.mjs";
import {
  getActorNeedSettings,
  getCharacteristicSettings,
  getCreatureOptions,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillAdvancementSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { toInteger } from "./numbers.mjs";
import { formatFormulaForDisplay } from "./formula-display.mjs";

export function evaluateActorFormula(formula, actor = null, { fallback = 0, minimum = 0, context = "" } = {}) {
  const text = String(formula ?? "").trim();
  if (!text) return Math.max(minimum, toInteger(fallback));
  try {
    const value = evaluateFormula(text, buildActorFormulaData(actor));
    return Math.max(minimum, value);
  } catch (error) {
    const label = context ? ` (${context})` : "";
    console.warn(`Fallout MaW | Formula evaluation failed${label}: ${error.message}`);
    return Math.max(minimum, toInteger(fallback));
  }
}

export function buildActorFormulaData(actor = null, { stage = "prepared" } = {}) {
  const characteristicSettings = getCharacteristicSettings();
  const skillSettings = getSkillSettings();
  const resourceSettings = getResourceSettings();
  const needSettings = getFormulaNeedSettings(actor, { includeGlobal: true });
  const proficiencySettings = getProficiencySettings();
  const characteristics = buildActorFormulaCharacteristics(actor, characteristicSettings, {
    includeDevelopment: stage === "initial-active-effect"
  });
  const skills = stage === "initial-active-effect"
    ? buildInitialActiveEffectSkillValues(actor, characteristicSettings, skillSettings, characteristics)
    : getSkillValues(actor?.system?.skills ?? {});
  const formulaReferences = buildActorFormulaReferenceData({
    system: actor?.system ?? {},
    characteristicSettings,
    skillSettings,
    resourceSettings,
    needSettings,
    proficiencySettings,
    limbSettings: getActorLimbSettings(actor),
    characteristicValues: characteristics,
    skillValues: skills
  });

  return {
    characteristicSettings,
    skillSettings,
    resourceSettings,
    needSettings,
    proficiencySettings,
    characteristics,
    skills,
    ...formulaReferences
  };
}

export function getActorFormulaAutocompleteEntries(subject = null) {
  const actor = resolveFormulaActor(subject);
  return buildActorFormulaAutocompleteEntries({
    skills: getSkillSettings(),
    resources: getResourceSettings(),
    needs: getFormulaNeedSettings(actor, { includeGlobal: true }),
    proficiencies: getProficiencySettings(),
    limbs: getFormulaLimbSettings(actor),
    includeLoad: true
  });
}

export function isFormulaTextConfigured(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && text !== "0";
}

export function formatActorFormulaForDisplay(formula = "0", actor = null, { includeValues = Boolean(actor) } = {}) {
  const data = buildActorFormulaData(actor);
  return formatFormulaForDisplay(formula, {
    characteristics: data.characteristicSettings,
    skills: data.skillSettings,
    characteristicValues: data.characteristics,
    skillValues: data.skills,
    variables: data.formulaVariableSettings,
    variableValues: data.formulaVariables,
    references: data.formulaReferenceSettings,
    referenceValues: data.formulaReferences,
    includeValues
  });
}

function getFormulaNeedSettings(actor = null, { includeGlobal = false } = {}) {
  const globalSettings = includeGlobal || !actor ? safeGetNeedSettings() : [];
  if (!actor) return globalSettings;
  let actorSettings = [];
  try {
    actorSettings = getActorNeedSettings(actor);
  } catch (_error) {
    actorSettings = [];
  }
  return mergeFormulaSettings(globalSettings, actorSettings);
}

function safeGetNeedSettings() {
  try {
    const settings = getNeedSettings();
    return settings.length ? settings : getFallbackNeedSettings();
  } catch (_error) {
    return getFallbackNeedSettings();
  }
}

function getFallbackNeedSettings() {
  return DEFAULT_NEEDS.map(entry => ({ ...entry }));
}

function getActorLimbSettings(actor = null) {
  return Object.entries(actor?.system?.limbs ?? {}).map(([key, limb]) => ({
    key,
    label: String(limb?.label ?? key)
  }));
}

function getFormulaLimbSettings(actor = null) {
  const configured = [];
  try {
    for (const race of getCreatureOptions()?.races ?? []) {
      configured.push(...(race?.limbs ?? []));
    }
  } catch (_error) {
    // Actor-owned limb definitions below remain available without settings.
  }
  return mergeFormulaSettings(configured, getActorLimbSettings(actor));
}

function mergeFormulaSettings(...collections) {
  const byKey = new Map();
  for (const entry of collections.flat()) {
    const key = String(entry?.key ?? "").trim();
    if (!key) continue;
    byKey.set(key, { ...byKey.get(key), ...entry, key });
  }
  return Array.from(byKey.values());
}

function resolveFormulaActor(subject = null) {
  if (!subject) return null;
  if (subject.documentName === "Actor") return subject;
  if (subject.actor?.documentName === "Actor") return subject.actor;
  if (subject.parent?.documentName === "Actor") return subject.parent;
  if (subject.parent?.actor?.documentName === "Actor") return subject.parent.actor;
  if (subject.system?.resources || subject.system?.characteristics) return subject;
  return null;
}

function buildActorFormulaCharacteristics(actor = null, characteristicSettings = [], { includeDevelopment = false } = {}) {
  const characteristics = actor?.system?.characteristics ?? {};
  const development = includeDevelopment ? actor?.system?.development?.characteristics ?? {} : {};
  return Object.fromEntries(
    characteristicSettings.map(characteristic => [
      characteristic.key,
      toInteger(characteristics?.[characteristic.key]) + toInteger(development?.[characteristic.key])
    ])
  );
}

function buildInitialActiveEffectSkillValues(actor = null, characteristicSettings = [], skillSettings = [], characteristics = {}) {
  const skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
  const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, characteristics);
  const skillBonuses = calculateSkillDevelopmentBonuses(
    skillSettings,
    characteristics,
    skillAdvancementSettings,
    actor?.system?.development,
    {}
  );
  const max = Math.max(0, toInteger(skillAdvancementSettings?.developmentLimit));

  return Object.fromEntries(
    skillSettings.map(skill => {
      const current = actor?.system?.skills?.[skill.key] ?? {};
      const min = Math.max(0, toInteger(current?.min));
      const bonus = toInteger(current?.bonus);
      const value = Math.min(
        Math.max(toInteger(skillBases?.[skill.key]) + bonus + toInteger(skillBonuses?.[skill.key]), min),
        max
      );
      return [skill.key, value];
    })
  );
}
