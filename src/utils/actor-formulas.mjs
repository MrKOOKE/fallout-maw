import { evaluateFormula, getSkillValues } from "../formulas/evaluation.mjs";
import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";
import { toInteger } from "./numbers.mjs";

export function evaluateActorFormula(formula, actor = null, { fallback = 0, minimum = 0, context = "" } = {}) {
  const text = String(formula ?? "").trim();
  if (!text) return Math.max(minimum, toInteger(fallback));
  try {
    const value = evaluateFormula(text, {
      characteristicSettings: getCharacteristicSettings(),
      skillSettings: getSkillSettings(),
      characteristics: actor?.system?.characteristics ?? {},
      skills: getSkillValues(actor?.system?.skills ?? {})
    });
    return Math.max(minimum, value);
  } catch (error) {
    const label = context ? ` (${context})` : "";
    console.warn(`Fallout MaW | Formula evaluation failed${label}: ${error.message}`);
    return Math.max(minimum, toInteger(fallback));
  }
}

export function isFormulaTextConfigured(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && text !== "0";
}
