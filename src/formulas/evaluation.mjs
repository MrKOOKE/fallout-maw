import { FALLOUT_MAW } from "../config/system-config.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { parseFormula, normalizeFormulaOptions } from "./parser.mjs";
import { normalizeCharacteristicSettings, normalizeFormulaMap, normalizeNeedSettings, normalizeResourceSettings, normalizeSkillSettings } from "./normalization.mjs";

const formulaEvaluationCache = new WeakMap();

export function evaluateFormula(formula, data = {}) {
  const source = String(formula ?? "0");
  const context = getFormulaEvaluationContext(data);
  const options = context.options;
  let expression = context.expressions.get(source);
  if (!expression) {
    expression = parseFormula(source, options);
    context.expressions.set(source, expression);
  }
  const value = expression.evaluate(identifier => {
    const normalized = identifier.toLowerCase();
    const characteristic = options.characteristicAliases[normalized];
    if (characteristic) return Number(data.characteristics?.[characteristic] ?? data[characteristic]) || 0;

    const skill = options.skillAliases[normalized];
    if (skill) return Number(data.skills?.[skill] ?? data[skill]) || 0;

    const variable = options.variableAliases[normalized];
    if (variable) return Number(data.formulaVariables?.[variable] ?? data[variable]) || 0;

    const referenceKey = identifier.startsWith("@") ? identifier.slice(1) : identifier;
    const reference = options.referenceAliases[referenceKey.toLowerCase()];
    if (reference) return Number(data.formulaReferences?.[reference] ?? data.references?.[reference]) || 0;

    throw new Error(format("FALLOUTMAW.Formula.UnknownParameter", { identifier }));
  });

  if (!Number.isFinite(value)) throw new Error(localize("FALLOUTMAW.Formula.InvalidNumberValue"));
  return Math.trunc(value);
}

function getFormulaEvaluationContext(data = {}) {
  if (data && (typeof data === "object" || typeof data === "function")) {
    const cached = formulaEvaluationCache.get(data);
    if (cached) return cached;
    const created = createFormulaEvaluationContext(data);
    formulaEvaluationCache.set(data, created);
    return created;
  }
  return createFormulaEvaluationContext(data);
}

function createFormulaEvaluationContext(data = {}) {
  return {
    options: normalizeFormulaOptions({
      characteristics: data?.characteristicSettings,
      skills: data?.skillSettings,
      allowSkills: Boolean(data?.skills),
      variables: data?.variables,
      references: data?.formulaReferences ?? data?.references
    }),
    expressions: new Map()
  };
}

export function evaluateFormulaVariables(formula, variables = {}) {
  const normalizedVariables = Object.fromEntries(
    Object.entries(variables ?? {}).map(([key, value]) => [String(key).toLowerCase(), Number(value) || 0])
  );
  const expression = parseFormula(String(formula ?? "0"), {
    variables: Object.keys(variables ?? {})
  });
  const value = expression.evaluate(identifier => normalizedVariables[String(identifier).toLowerCase()] ?? 0);

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
          evaluateFormula(skill.formula, {
            characteristicSettings: normalizedCharacteristics,
            characteristics
          })
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

export function evaluateResourceSettings(
  resourceSettings = [],
  characteristicSettings,
  skillSettings,
  characteristics = {},
  skills = {},
  variables = {}
) {
  return evaluateFormulaSettings(normalizeResourceSettings(resourceSettings), characteristicSettings, skillSettings, characteristics, skills, variables);
}

export function evaluateNeedSettings(
  needSettings = [],
  characteristicSettings,
  skillSettings,
  characteristics = {},
  skills = {}
) {
  return evaluateFormulaSettings(normalizeNeedSettings(needSettings), characteristicSettings, skillSettings, characteristics, skills);
}

function evaluateFormulaSettings(settings = [], characteristicSettings, skillSettings, characteristics = {}, skills = {}, variables = {}) {
  const normalizedCharacteristics = normalizeCharacteristicSettings(characteristicSettings);
  const normalizedSkills = normalizeSkillSettings(skillSettings);

  return Object.fromEntries(
    settings.map(setting => {
      try {
        return [
          setting.key,
          Math.max(
            0,
            evaluateFormula(setting.formula, {
              characteristicSettings: normalizedCharacteristics,
              skillSettings: normalizedSkills,
              characteristics,
              skills,
              formulaVariables: variables,
              variables: Object.keys(variables ?? {})
            })
          )
        ];
      } catch (error) {
        console.warn(
          `${FALLOUT_MAW.title} | ${format("FALLOUTMAW.Formula.FormulaError", {
            key: setting.key,
            message: error.message
          })}`
        );
        return [setting.key, 0];
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
          evaluateFormula(normalized[definition.key], {
            characteristicSettings: normalizedCharacteristics,
            skillSettings: normalizedSkills,
            characteristics,
            skills
          })
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
