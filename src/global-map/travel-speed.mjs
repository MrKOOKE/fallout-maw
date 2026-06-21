import { evaluateFormula, validateFormula } from "../formulas/index.mjs";
import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";
import { buildActorFormulaData } from "../utils/actor-formulas.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  GLOBAL_MAP_TRAVEL_SPEED_FORMULA_DEFAULT,
  GLOBAL_MAP_TRAVEL_SPEED_FORMULA_SETTING
} from "./constants.mjs";

export const TRAVEL_SPEED_FORMULA_VARIABLES = Object.freeze([
  Object.freeze({ key: "movementPoints", abbr: "mov", label: "Максимум очков передвижения" })
]);

export function getTravelSpeedFormula() {
  try {
    return String(game.settings.get(FALLOUT_MAW.id, GLOBAL_MAP_TRAVEL_SPEED_FORMULA_SETTING) ?? "").trim()
      || GLOBAL_MAP_TRAVEL_SPEED_FORMULA_DEFAULT;
  } catch (_error) {
    return GLOBAL_MAP_TRAVEL_SPEED_FORMULA_DEFAULT;
  }
}

export function validateTravelSpeedFormula(formula) {
  return validateFormula(String(formula ?? "").trim() || GLOBAL_MAP_TRAVEL_SPEED_FORMULA_DEFAULT, {
    allowSkills: true,
    characteristics: getCharacteristicSettings(),
    skills: getSkillSettings(),
    variables: TRAVEL_SPEED_FORMULA_VARIABLES
  });
}

export function createTravelFormulaSnapshot(actor = null) {
  return {
    characteristics: Object.fromEntries(Object.entries(actor?.system?.characteristics ?? {}).map(([key, value]) => [key, toInteger(value)])),
    skills: Object.fromEntries(Object.entries(actor?.system?.skills ?? {}).map(([key, value]) => [key, toInteger(value?.value ?? value)])),
    movementPointsMax: Math.max(0, Number(actor?.system?.resources?.movementPoints?.max) || 0)
  };
}

export function evaluateTravelSpeed(actor = null, snapshot = null, { fallback = 0 } = {}) {
  if (!actor && !snapshot) return Math.max(0, Number(fallback) || 0);
  const formula = getTravelSpeedFormula();
  const data = actor ? buildActorFormulaData(actor) : {
    characteristicSettings: getCharacteristicSettings(),
    skillSettings: getSkillSettings(),
    characteristics: snapshot?.characteristics ?? {},
    skills: snapshot?.skills ?? {}
  };
  const movementPointsMax = actor
    ? Math.max(0, Number(actor.system?.resources?.movementPoints?.max) || 0)
    : Math.max(0, Number(snapshot?.movementPointsMax) || 0);
  try {
    return Math.max(0, evaluateFormula(formula, {
      ...data,
      variables: TRAVEL_SPEED_FORMULA_VARIABLES,
      formulaVariables: { movementPoints: movementPointsMax }
    }));
  } catch (error) {
    console.warn(`${FALLOUT_MAW.id} | Travel speed formula failed: ${error.message}`);
    return Math.max(0, Number(fallback) || 0);
  }
}
