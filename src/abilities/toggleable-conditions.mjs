import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";

export const ABILITY_TOGGLE_CONDITION_STATE_FLAG = "abilityToggleConditions";

export function getAbilityToggleConditionEntries(item) {
  if (item?.type !== "ability") return [];
  return normalizeAbilityFunctions(item.system?.functions ?? []).flatMap(abilityFunction => {
    if (abilityFunction.type !== ABILITY_FUNCTION_TYPES.effectChanges) return [];
    return (abilityFunction.conditions ?? [])
      .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.toggleable)
      .map(condition => ({ abilityFunction, condition }));
  });
}

export function getAbilityToggleConditionState(item, functionId = "", conditionId = "") {
  const key = getStateKey(functionId, conditionId);
  const stored = item?.getFlag?.(SYSTEM_ID, ABILITY_TOGGLE_CONDITION_STATE_FLAG)
    ?? item?.flags?.[SYSTEM_ID]?.[ABILITY_TOGGLE_CONDITION_STATE_FLAG]
    ?? {};
  const state = stored?.[key] ?? {};
  return {
    active: Boolean(state.active),
    changedAt: Number.isFinite(Number(state.changedAt)) ? Number(state.changedAt) : null
  };
}

export function isAbilityToggleConditionActive(actor, abilityItemId = "", functionId = "", conditionId = "") {
  const item = actor?.items?.get?.(String(abilityItemId ?? "")) ?? null;
  return getAbilityToggleConditionState(item, functionId, conditionId).active;
}

export async function toggleAbilityCondition({ actor = null, item = null, functionId = "", conditionId = "" } = {}) {
  if (!actor?.isOwner || item?.type !== "ability" || item.parent?.id !== actor.id) return false;
  const entries = getAbilityToggleConditionEntries(item);
  const entryIndex = entries.findIndex(candidate => (
    candidate.abilityFunction.id === functionId && candidate.condition.id === conditionId
  ));
  const entry = entries[entryIndex];
  if (!entry) return false;

  const current = getAbilityToggleConditionState(item, functionId, conditionId);
  const nextActive = !current.active;
  const now = Number(game.time?.worldTime ?? 0);
  const requiredSeconds = entry.condition.cooldownSeconds;
  if (current.changedAt !== null && requiredSeconds !== null) {
    const remaining = Math.max(0, Number(requiredSeconds) - Math.max(0, now - current.changedAt));
    if (remaining > 0) {
      ui.notifications.warn(game.i18n.format("FALLOUTMAW.Ability.Toggle.TimeLocked", {
        seconds: Math.ceil(remaining)
      }));
      return false;
    }
  }

  const allStates = foundry.utils.deepClone(
    item.getFlag(SYSTEM_ID, ABILITY_TOGGLE_CONDITION_STATE_FLAG) ?? {}
  );
  allStates[getStateKey(functionId, conditionId)] = { active: nextActive, changedAt: now };
  await item.setFlag(SYSTEM_ID, ABILITY_TOGGLE_CONDITION_STATE_FLAG, allStates);
  ui.notifications.info(game.i18n.format(
    nextActive ? "FALLOUTMAW.Ability.Toggle.Enabled" : "FALLOUTMAW.Ability.Toggle.Disabled",
    { name: getAbilityToggleDisplayName(item, entry.condition, entryIndex + 1) }
  ));
  return true;
}

export function getAbilityToggleDisplayName(item, condition = {}, ordinal = 1) {
  const customName = String(condition?.name ?? "").trim();
  if (customName) return customName;
  const baseName = String(item?.name ?? "").trim();
  return ordinal > 1 ? `${baseName} ${ordinal}` : baseName;
}

function getStateKey(functionId = "", conditionId = "") {
  return `${String(functionId)}:${String(conditionId)}`;
}
