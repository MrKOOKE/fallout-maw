import { FALLOUT_MAW } from "../config/system-config.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { parseFormula, normalizeFormulaOptions } from "./parser.mjs";
import {
  normalizeActionMovementFormulas,
  normalizeCharacteristicSettings,
  normalizeFormulaMap,
  normalizeSkillSettings
} from "./normalization.mjs";

export function evaluateFormula(formula, data = {}) {
  const options = normalizeFormulaOptions({
    characteristics: data.characteristicSettings,
    skills: data.skillSettings,
    allowSkills: Boolean(data.skills)
  });
  const expression = parseFormula(String(formula ?? "0"), options);
  const value = expression.evaluate(identifier => {
    const normalized = identifier.toLowerCase();
    const characteristic = options.characteristicAliases[normalized];
    if (characteristic) return Number(data.characteristics?.[characteristic] ?? data[characteristic]) || 0;

    const skill = options.skillAliases[normalized];
    if (skill) return Number(data.skills?.[skill] ?? data[skill]) || 0;

    throw new Error(format("FALLOUTMAW.Formula.UnknownParameter", { identifier }));
  });

  if (!Number.isFinite(value)) throw new Error(localize("FALLOUTMAW.Formula.InvalidNumberValue"));
  return Math.trunc(value);
}

export function evaluateSkillFormulas(skillSettings, characteristicSettings, characteristics = {}) {
  const normalizedSkills = normalizeSkillSettings(skillSettings);
  const normalizedCharacteristics = normalizeCharacteristicSettings(characteristicSettings);

  return Object.fromEntries(
    normalizedSkills.map(skill => {
      try {
        return [
          skill.key,
          Math.max(
            0,
            evaluateFormula(skill.formula, {
              characteristicSettings: normalizedCharacteristics,
              characteristics
            })
          )
        ];
      } catch (error) {
        console.warn(
          `${FALLOUT_MAW.title} | ${format("FALLOUTMAW.Formula.SkillFormulaError", {
            key: skill.key,
            message: error.message
          })}`
        );
        return [skill.key, 0];
      }
    })
  );
}

export function evaluateActionMovementFormulas(
  formulas = {},
  characteristicSettings,
  skillSettings,
  characteristics = {},
  skills = {}
) {
  const normalized = normalizeActionMovementFormulas(formulas);
  const normalizedCharacteristics = normalizeCharacteristicSettings(characteristicSettings);
  const normalizedSkills = normalizeSkillSettings(skillSettings);

  return Object.fromEntries(
    Object.entries(normalized).map(([key, formula]) => {
      try {
        return [
          key,
          Math.max(
            0,
            evaluateFormula(formula, {
              characteristicSettings: normalizedCharacteristics,
              skillSettings: normalizedSkills,
              characteristics,
              skills
            })
          )
        ];
      } catch (error) {
        console.warn(
          `${FALLOUT_MAW.title} | ${format("FALLOUTMAW.Formula.FormulaError", {
            key,
            message: error.message
          })}`
        );
        return [key, 0];
      }
    })
  );
}

export function evaluateFormulaMap(
  formulas = {},
  definitions = [],
  characteristicSettings,
  skillSettings,
  characteristics = {},
  skills = {}
) {
  const normalized = normalizeFormulaMap(formulas, definitions);
  const normalizedCharacteristics = normalizeCharacteristicSettings(characteristicSettings);
  const normalizedSkills = normalizeSkillSettings(skillSettings);

  return Object.fromEntries(
    definitions.map(definition => {
      try {
        return [
          definition.key,
          Math.max(
            0,
            evaluateFormula(normalized[definition.key], {
              characteristicSettings: normalizedCharacteristics,
              skillSettings: normalizedSkills,
              characteristics,
              skills
            })
          )
        ];
      } catch (error) {
        console.warn(
          `${FALLOUT_MAW.title} | ${format("FALLOUTMAW.Formula.FormulaError", {
            key: definition.key,
            message: error.message
          })}`
        );
        return [definition.key, 0];
      }
    })
  );
}

export function getSkillValues(skills = {}) {
  return Object.fromEntries(
    Object.entries(skills).map(([key, skill]) => [
      key,
      skill && typeof skill === "object" ? toInteger(skill.value) : toInteger(skill)
    ])
  );
}
