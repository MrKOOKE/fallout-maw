import { SYSTEM_ID } from "../constants.mjs";
import { getContextualAbilityChangeValue } from "../abilities/evaluation.mjs";
import { getActorEffectChangeEntries } from "../documents/actor-effect-preparation-index.mjs";
import { evaluateFormula, getSkillValues } from "../formulas/index.mjs";
import { getPreparedRuntimeSettings } from "../settings/accessors.mjs";
import { DEFAULT_ENERGY_REGENERATION_FORMULA, DEFAULT_REGENERATION_FORMULA } from "../settings/creature-options.mjs";
import { evaluateActorEffectChangeBaseNumber } from "../utils/active-effect-changes.mjs";
import { ENERGY_REGENERATION_EFFECT_KEY, HEALTH_REGENERATION_EFFECT_KEY } from "./regeneration-effect-keys.mjs";

/** Hourly rates: constructs have no biological baseline; explicit effects can grant either rate. */
export function getActorRegenerationRate(actor, { resource = "health" } = {}) {
  const energy = resource === "energy";
  const key = energy ? ENERGY_REGENERATION_EFFECT_KEY : HEALTH_REGENERATION_EFFECT_KEY;
  let rate = getActorBaseRegenerationRate(actor, energy);
  const changes = getActorEffectChangeEntries(actor, key)
    .filter(({ effect }) => !effect?.disabled && effect?.active !== false)
    .map(({ effect, change }) => ({ ...change, effect }))
    .sort((left, right) => (Number(left.priority) || 0) - (Number(right.priority) || 0));
  for (const change of changes) {
    const amount = evaluateActorEffectChangeBaseNumber(actor, change);
    if (!Number.isFinite(amount)) continue;
    if (change.type === "multiply") rate *= amount;
    else if (change.type === "override") rate = amount;
    else if (change.type === "upgrade") rate = Math.max(rate, amount);
    else if (change.type === "downgrade") rate = Math.min(rate, amount);
    else rate += amount;
  }
  return Math.max(0, getContextualAbilityChangeValue(actor, key, { baseValue: rate }));
}

function getActorBaseRegenerationRate(actor, energy) {
  if (!actor || actor.type === "construct") return 0;
  const { characteristicSettings, skillSettings, creatureOptions } = getPreparedRuntimeSettings();
  const race = creatureOptions.races.find(entry => entry.id === actor.system?.creature?.raceId);
  const formulaKey = energy ? "energyFormula" : "formula";
  const fallback = energy ? DEFAULT_ENERGY_REGENERATION_FORMULA : DEFAULT_REGENERATION_FORMULA;
  const formula = String(race?.regeneration?.[formulaKey] ?? fallback).trim() || fallback;
  try {
    return Math.max(0, evaluateFormula(formula, { characteristicSettings, skillSettings,
      characteristics: actor.system?.characteristics ?? {}, skills: getSkillValues(actor.system?.skills ?? {}) }));
  } catch (error) {
    console.warn(`${SYSTEM_ID} | ${energy ? "energy" : "health"} regeneration formula failed for ${actor.name}: ${error.message}`);
    return 0;
  }
}
