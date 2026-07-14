import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_ATTACKING_WEAPON_ACTION_KEYS,
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizeAtRandomSettings
} from "../settings/abilities.mjs";
import { hasEventReactionCondition } from "../events/event-reaction-schema.mjs";
import { prepareActorEffectChangeForApplication } from "../utils/active-effect-changes.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const ABILITY_FUNCTION_COOLDOWN_FLAG_KEY = "abilityFunctionCooldown";
export const ABILITY_ITEM_USE_COUNTERS_FLAG_KEY = "abilityItemUseCounters";
export const ACTION_BLOCK_EFFECT_KEY_PREFIX = "system.blocks.actions.";
export const ATTACKING_WEAPON_ACTION_KEYS = ABILITY_ATTACKING_WEAPON_ACTION_KEYS;

export function hasActorFixedAbilityFunction(actor, fixedKey = "") {
  const key = String(fixedKey ?? "").trim();
  if (!actor || !key) return false;
  return (actor.items ?? []).some(item => (
    item?.type === "ability"
    && normalizeAbilityFunctions(item.system?.functions ?? [])
      .some(entry => entry.type === ABILITY_FUNCTION_TYPES.fixed && entry.fixedKey === key)
  ));
}

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
      const prepared = prepareActorEffectChangeForApplication(actor, { ...change, effect });
      if (!prepared || !isTruthyEffectValue(prepared.value)) continue;
      return { blocked: true, effect };
    }
  }

  return { blocked: false, effect: null };
}

export function isWeaponActionBlocked(actor, actionKey = "") {
  return getWeaponActionBlockState(actor, actionKey).blocked;
}

export function isAttackingWeaponAction(actionKey = "") {
  return ATTACKING_WEAPON_ACTION_KEYS.includes(String(actionKey ?? "").trim());
}

export function getActorAtRandomActionPointCostReduction(actor, actionKey = "") {
  if (!isAttackingWeaponAction(actionKey)) return 0;
  return getActorAtRandomActionPointCostSources(actor, actionKey)
    .reduce((total, source) => total + source.reduction, 0);
}

export function getActorAtRandomActionPointCostSources(actor, actionKey = "") {
  if (!isAttackingWeaponAction(actionKey)) return [];
  const sources = [];
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.atRandom) continue;
      const settings = normalizeAtRandomSettings(abilityFunction.fixedSettings);
      if (settings.actionPointCostReduction <= 0) continue;
      sources.push({
        key: `ability:${abilityItem.id}:${abilityFunction.id}:atRandom`,
        name: String(abilityItem.name ?? "").trim() || "Способность",
        img: String(abilityItem.img ?? "").trim(),
        reduction: settings.actionPointCostReduction
      });
    }
  }
  return sources;
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

export function getAbilityItemUseCounterKey({
  abilityFunction = null,
  functionId = "",
  condition = null,
  conditionId = ""
} = {}) {
  const resolvedFunctionId = resolveRuntimeStateId(abilityFunction, functionId);
  const resolvedConditionId = resolveRuntimeStateId(condition, conditionId);
  if (!resolvedFunctionId || !resolvedConditionId) return "";
  return [resolvedFunctionId, resolvedConditionId].join("_");
}

export function getAbilityItemUseProgressEntries(abilityItem) {
  if (abilityItem?.type !== "ability") return [];
  const counters = abilityItem.getFlag(SYSTEM_ID, ABILITY_ITEM_USE_COUNTERS_FLAG_KEY) ?? {};
  const entries = [];

  for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
    if (abilityFunction.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
    if (hasEventReactionCondition(abilityFunction.conditions)) continue;

    for (const condition of abilityFunction.conditions ?? []) {
      if (condition?.type !== ABILITY_CONDITION_TYPES.itemUse) continue;

      const required = Math.max(1, toInteger(condition.requiredCount ?? condition.limit ?? 1));
      if (required <= 1) continue;

      const key = getAbilityItemUseCounterKey({ abilityFunction, condition });
      if (!key) continue;

      entries.push({
        key,
        label: getAbilityItemUseProgressLabel(condition, abilityFunction),
        current: Math.max(0, Math.min(required, toInteger(counters[key]))),
        required
      });
    }
  }

  return entries;
}

export function normalizeAbilityItemUseCategories(value = []) {
  return Array.from(new Set((Array.isArray(value) ? value : Object.values(value ?? {}))
    .map(category => String(category ?? "").trim())
    .filter(Boolean)));
}

function isTruthyEffectValue(value) {
  return !TRUTHY_EFFECT_FALSE_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function getActorApplicableEffects(actor) {
  if (typeof actor?.allApplicableEffects === "function") return Array.from(actor.allApplicableEffects());
  return Array.from(actor?.effects ?? []);
}

function resolveRuntimeStateId(documentOrId = null, explicitId = "") {
  const id = String(explicitId || documentOrId?.id || (typeof documentOrId === "string" ? documentOrId : "")).trim();
  return id;
}

function getAbilityItemUseProgressLabel(condition = {}, abilityFunction = {}) {
  const categories = normalizeAbilityItemUseCategories(condition.itemCategories);
  const conditionLabel = categories.length ? categories.join(", ") : "Категория не выбрана";
  const functionName = String(abilityFunction?.name ?? "").trim();
  return functionName ? `${functionName}: ${conditionLabel}` : conditionLabel;
}
