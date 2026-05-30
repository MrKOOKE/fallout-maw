import { SYSTEM_ID } from "../constants.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const ABILITY_FUNCTION_COOLDOWN_FLAG_KEY = "abilityFunctionCooldown";
export const ACTION_BLOCK_EFFECT_KEY_PREFIX = "system.blocks.actions.";

const TRUTHY_EFFECT_FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

export function getActionBlockEffectKey(actionKey = "") {
  const key = String(actionKey ?? "").trim();
  return key ? `${ACTION_BLOCK_EFFECT_KEY_PREFIX}${key}` : "";
}

export function getWeaponActionBlockState(actor, actionKey = "") {
  const key = getActionBlockEffectKey(actionKey);
  if (!key) return { blocked: false, effect: null };

  for (const effect of getActorApplicableEffects(actor)) {
    if (effect.disabled) continue;
    for (const change of effect.system?.changes ?? effect.changes ?? []) {
      if (String(change?.key ?? "").trim() !== key) continue;
      if (!isTruthyEffectValue(change?.value)) continue;
      return { blocked: true, effect };
    }
  }

  return { blocked: false, effect: null };
}

export function isWeaponActionBlocked(actor, actionKey = "") {
  return getWeaponActionBlockState(actor, actionKey).blocked;
}

export function hasAbilityFunctionCooldown(actor, { abilityItemId = "", functionId = "", conditionId = "" } = {}) {
  return getAbilityFunctionCooldownEffect(actor, { abilityItemId, functionId, conditionId }) !== null;
}

export function getAbilityFunctionCooldownEffect(actor, { abilityItemId = "", functionId = "", conditionId = "" } = {}) {
  for (const effect of getActorApplicableEffects(actor)) {
    if (effect.disabled) continue;
    const data = getAbilityFunctionCooldownData(effect);
    if (!data) continue;
    if (abilityItemId && data.abilityItemId !== String(abilityItemId)) continue;
    if (functionId && data.functionId !== String(functionId)) continue;
    if (conditionId && data.conditionId !== String(conditionId)) continue;
    return effect;
  }
  return null;
}

export function getAbilityFunctionCooldownData(effect) {
  const data = effect?.getFlag?.(SYSTEM_ID, ABILITY_FUNCTION_COOLDOWN_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[ABILITY_FUNCTION_COOLDOWN_FLAG_KEY];
  if (!data || typeof data !== "object") return null;
  return {
    abilityItemId: String(data.abilityItemId ?? ""),
    abilitySourceId: String(data.abilitySourceId ?? ""),
    functionId: String(data.functionId ?? ""),
    conditionId: String(data.conditionId ?? ""),
    untilTime: Math.max(0, toInteger(data.untilTime))
  };
}

export function isAbilityFunctionCooldownEffect(effect) {
  return Boolean(getAbilityFunctionCooldownData(effect));
}

function isTruthyEffectValue(value) {
  return !TRUTHY_EFFECT_FALSE_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function getActorApplicableEffects(actor) {
  if (typeof actor?.allApplicableEffects === "function") return Array.from(actor.allApplicableEffects());
  return Array.from(actor?.effects ?? []);
}
