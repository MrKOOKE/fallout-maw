import { evaluateFormula, getSkillValues } from "../formulas/index.mjs";
import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";

export function prepareEffectChangeForApplication(actor, change = {}) {
  const result = tryEvaluateEffectChangeValue(actor, change?.value);
  if (!result.ok) return change;
  return { ...change, value: result.value };
}

export function evaluateEffectChangeNumber(actor, value, { fallback = Number.NaN } = {}) {
  const result = tryEvaluateEffectChangeValue(actor, value);
  return result.ok ? result.value : fallback;
}

export function tryEvaluateEffectChangeValue(actor, value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, value: Number.NaN };
  }
  if (typeof value !== "string") return { ok: false, value: Number.NaN };

  const text = value.trim();
  if (!text) return { ok: false, value: Number.NaN };

  const direct = Number(text);
  if (Number.isFinite(direct)) return { ok: true, value: direct };

  try {
    const evaluated = evaluateFormula(text, buildEffectChangeFormulaData(actor));
    return Number.isFinite(evaluated)
      ? { ok: true, value: evaluated }
      : { ok: false, value: Number.NaN };
  } catch (_error) {
    return { ok: false, value: Number.NaN };
  }
}

function buildEffectChangeFormulaData(actor) {
  return {
    characteristicSettings: getCharacteristicSettings(),
    skillSettings: getSkillSettings(),
    characteristics: actor?.system?.characteristics ?? {},
    skills: getSkillValues(actor?.system?.skills ?? {})
  };
}
