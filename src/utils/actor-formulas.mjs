import { calculateSkillDevelopmentBonuses } from "../advancement/calculations.mjs";
import { evaluateFormula, evaluateSkillFormulas, getSkillValues } from "../formulas/evaluation.mjs";
import { getCharacteristicSettings, getSkillAdvancementSettings, getSkillSettings } from "../settings/accessors.mjs";
import { toInteger } from "./numbers.mjs";

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
  const characteristics = buildActorFormulaCharacteristics(actor, characteristicSettings, {
    includeDevelopment: stage === "initial-active-effect"
  });
  const skills = stage === "initial-active-effect"
    ? buildInitialActiveEffectSkillValues(actor, characteristicSettings, skillSettings, characteristics)
    : getSkillValues(actor?.system?.skills ?? {});

  return {
    characteristicSettings,
    skillSettings,
    characteristics,
    skills
  };
}

export function isFormulaTextConfigured(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && text !== "0";
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
