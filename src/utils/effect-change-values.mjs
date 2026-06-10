import { evaluateFormula } from "../formulas/index.mjs";
import { buildActorFormulaData } from "./actor-formulas.mjs";

export function prepareEffectChangeForApplication(actor, change = {}, options = {}) {
  const result = tryEvaluateEffectChangeValue(actor, change?.value, options);
  if (!result.ok) return change;
  return { ...change, value: result.value };
}

export function evaluateEffectChangeNumber(actor, value, { fallback = Number.NaN, stage = "prepared" } = {}) {
  const result = tryEvaluateEffectChangeValue(actor, value, { stage });
  return result.ok ? result.value : fallback;
}

export function tryEvaluateEffectChangeValue(actor, value, { stage = "prepared" } = {}) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, value: Number.NaN };
  }
  if (typeof value !== "string") return { ok: false, value: Number.NaN };

  const text = value.trim();
  if (!text) return { ok: false, value: Number.NaN };

  const direct = Number(text);
  if (Number.isFinite(direct)) return { ok: true, value: direct };

  try {
    const evaluated = evaluateFormula(text, buildActorFormulaData(actor, { stage }));
    return Number.isFinite(evaluated)
      ? { ok: true, value: evaluated }
      : { ok: false, value: Number.NaN };
  } catch (_error) {
    return { ok: false, value: Number.NaN };
  }
}
