import { DEFAULT_HEALTH_PER_LEVEL_FORMULA } from "../config/defaults.mjs";
import { evaluateFormula } from "../formulas/evaluation.mjs";

const HEALTH_RESOURCE_KEY = "health";
const HEALTH_PROGRESSION_FORMULA_DATA = new WeakMap();

export function usesIndependentHealthModel(actor, runtimeSettings = {}) {
  if (!actor || actor.type === "construct") return false;
  if (runtimeSettings?.rulesProfile?.healthFormulaSource !== "race") return false;
  return runtimeSettings?.resourceSettings?.some(setting => (
    setting?.key === HEALTH_RESOURCE_KEY && setting?.formulaSource === "race"
  )) === true;
}

export function createIndependentHealthState(resource = {}) {
  const min = toFiniteInteger(resource.min, 0);
  const max = Math.max(min, toFiniteInteger(resource.max, min));
  const value = Math.min(max, Math.max(min, toFiniteInteger(resource.value, max)));
  return { min, max, value };
}

export function applyIndependentHealthChange(state, amount = 0, mode = "damage") {
  const requested = roundNonNegative(amount);
  if (!state || requested <= 0) return 0;
  const previous = state.value;
  state.value = mode === "healing"
    ? Math.min(state.max, previous + requested)
    : Math.max(state.min, previous - requested);
  return Math.abs(state.value - previous);
}

export function calculateIndependentLimbDamage(
  lostHealth = 0,
  maximumHealth = 0,
  profileMultiplier = 0
) {
  const loss = Math.max(0, Number(lostHealth) || 0);
  const maximum = Math.max(0, Number(maximumHealth) || 0);
  if (!loss || !maximum) return 0;
  const profile = Math.max(0, Number(profileMultiplier) || 0);
  return roundNonNegative((loss / maximum) * 100 * profile);
}

export function calculateIntegratedProsthesisHealthLoss(
  previousCondition = 0,
  nextCondition = 0,
  integrationPercent = 0
) {
  const integration = Math.max(0, Math.min(100, Number(integrationPercent) || 0));
  const previous = Math.max(0, Number(previousCondition) || 0);
  const next = Math.min(previous, Math.max(0, Number(nextCondition) || 0));
  return Math.max(
    0,
    roundNonNegative((previous * integration) / 100)
      - roundNonNegative((next * integration) / 100)
  );
}

export function calculateLevelHealthBonus(formula, characteristics, characteristicSettings, level) {
  const normalizedLevel = Math.max(1, toFiniteInteger(level, 1));
  let formulaData = HEALTH_PROGRESSION_FORMULA_DATA.get(characteristicSettings);
  if (!formulaData) {
    formulaData = {
      characteristicSettings,
      characteristics,
      variables: ["level"],
      formulaVariables: { level: normalizedLevel }
    };
    HEALTH_PROGRESSION_FORMULA_DATA.set(characteristicSettings, formulaData);
  } else {
    formulaData.characteristics = characteristics;
    formulaData.formulaVariables.level = normalizedLevel;
  }

  const source = String(formula ?? DEFAULT_HEALTH_PER_LEVEL_FORMULA).trim() || DEFAULT_HEALTH_PER_LEVEL_FORMULA;
  try {
    return Math.max(0, evaluateFormula(`(${source}) * level`, formulaData));
  } catch (_error) {
    return Math.max(0, evaluateFormula(`(${DEFAULT_HEALTH_PER_LEVEL_FORMULA}) * level`, formulaData));
  }
}

export function buildIndependentHealthUpdate(state) {
  if (!state) return {};
  return {
    system: {
      resources: {
        health: {
          value: state.value,
          spent: Math.max(0, state.max - state.value)
        }
      }
    }
  };
}

function toFiniteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function roundNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}
