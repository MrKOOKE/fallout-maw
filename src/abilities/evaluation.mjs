import { getCreatureOptions } from "../settings/accessors.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { DEFAULT_FACTION_NAME, getActorFactionBelongs } from "../settings/factions.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_EQUIPMENT_OPERATORS,
  ABILITY_FUNCTION_TYPES,
  ABILITY_HEALTH_LIMB_ALL,
  ABILITY_HEALTH_TARGETS,
  ABILITY_POSTURE_SUBJECTS,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { getEquipmentSlotSelectionKey, getValidSelectedEquipmentSlotKeys } from "../utils/equipment-slots.mjs";
import { isAbilityAcquisitionChangeKey } from "../utils/ability-acquisition-change-keys.mjs";
import { evaluateEffectChangeNumber } from "../utils/effect-change-values.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { hasAbilityFunctionCooldown } from "./runtime-state.mjs";

export function getAbilityEffectChanges(actor, item, context = {}) {
  return getAbilityEffectChangesFromFunctions(actor, item?.system?.functions ?? [], {
    ...context,
    abilityItemId: item?.id ?? ""
  });
}

export function getAbilityEffectChangesFromFunctions(actor, functions = [], context = {}) {
  return normalizeAbilityFunctions(functions)
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .flatMap(entry => getConditionalFunctionChanges(actor, entry, context))
    .filter(change => change.key && change.value !== "");
}

export function getAbilityAcquisitionChanges(itemOrData) {
  return normalizeAbilityFunctions(itemOrData?.system?.functions ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.acquisitionChanges)
    .flatMap(entry => entry.changes)
    .filter(change => change.key && change.value !== "" && isAbilityAcquisitionChangeKey(change.key));
}

export function getAbilitySkillAdvancementBaseBonuses(actor, skillSettings = []) {
  const bonuses = Object.fromEntries((skillSettings ?? []).map(skill => [skill.key, 0]));
  for (const item of actor?.items ?? []) {
    if (item?.type !== "ability") continue;
    for (const change of getAbilityEffectChanges(actor, item)) {
      const key = String(change?.key ?? "");
      if (!key.startsWith("system.skillAdvancementBase.")) continue;
      const target = key.slice("system.skillAdvancementBase.".length);
      const value = evaluateEffectChangeNumber(actor, change.value, { fallback: 0 });
      if (target === "all") {
        for (const skill of skillSettings ?? []) bonuses[skill.key] = (Number(bonuses[skill.key]) || 0) + value;
      } else if (Object.hasOwn(bonuses, target)) {
        bonuses[target] = (Number(bonuses[target]) || 0) + value;
      }
    }
  }
  return bonuses;
}

export function abilityConditionsApply(actor, conditions = [], context = {}) {
  const standalone = [];
  const groups = new Map();
  for (const condition of conditions ?? []) {
    if (!condition?.type) continue;
    const groupId = String(condition?.groupId ?? "").trim();
    if (!groupId) {
      standalone.push(condition);
      continue;
    }
    const entries = groups.get(groupId) ?? [];
    entries.push(condition);
    groups.set(groupId, entries);
  }

  return standalone.every(condition => abilityConditionApplies(actor, condition, context))
    && Array.from(groups.values()).every(group => group.some(condition => abilityConditionApplies(actor, condition, context)));
}

export function abilityConditionApplies(actor, condition = {}, context = {}) {
  if (condition.type === ABILITY_CONDITION_TYPES.itemUse) return false;

  const targetActor = context?.targetActor ?? context?.targetToken?.actor ?? null;
  if (condition.type === ABILITY_CONDITION_TYPES.targetFaction) {
    if (!targetActor) return false;
    const accepted = new Set(condition?.targetFactionNames ?? []);
    const factions = getActorFactionBelongs(targetActor);
    return accepted.size > 0 && (factions.length ? factions : [DEFAULT_FACTION_NAME]).some(faction => accepted.has(faction));
  }

  if (condition.type === ABILITY_CONDITION_TYPES.targetRace) {
    const raceId = String(condition?.targetRaceId ?? "").trim();
    return Boolean(targetActor && raceId && targetActor.system?.creature?.raceId === raceId);
  }

  if (condition.type === ABILITY_CONDITION_TYPES.targetType) {
    const typeId = String(condition?.targetTypeId ?? "").trim();
    return Boolean(targetActor && typeId && targetActor.system?.creature?.typeId === typeId);
  }

  if (condition.type === ABILITY_CONDITION_TYPES.posture) {
    const useTarget = condition?.postureSubject === ABILITY_POSTURE_SUBJECTS.target;
    const subjectActor = useTarget ? targetActor : actor;
    const subjectToken = useTarget ? context?.targetToken : context?.actorToken;
    const accepted = new Set(condition?.postureActions ?? []);
    return Boolean(subjectActor && accepted.size && accepted.has(getContextPostureAction(subjectActor, subjectToken)));
  }

  if (condition.type === ABILITY_CONDITION_TYPES.cooldown) {
    const abilityItemId = String(context?.abilityItemId ?? "").trim();
    const functionId = String(context?.functionId ?? "").trim();
    const conditionId = String(condition?.id ?? "").trim();
    if (!abilityItemId || !functionId || !conditionId) return true;
    return !hasAbilityFunctionCooldown(actor, { abilityItemId, functionId, conditionId });
  }

  if (condition.type === ABILITY_CONDITION_TYPES.equipmentSlotOccupied) {
    const occupied = isActorEquipmentSlotOccupied(actor, condition.equipmentSlotKey);
    return condition.operator === ABILITY_EQUIPMENT_OPERATORS.empty ? !occupied : occupied;
  }

  if (condition.type === ABILITY_CONDITION_TYPES.healthPercent) {
    const threshold = Math.max(0, Math.min(100, toInteger(condition.percent ?? 50)));
    const percentages = getHealthPercentages(actor, condition);
    if (!percentages.length) return false;
    return condition.operator === "gte"
      ? percentages.every(percent => percent >= threshold)
      : percentages.some(percent => percent <= threshold);
  }

  return true;
}

function getConditionalFunctionChanges(actor, entry = {}, context = {}) {
  const conditions = entry.conditions ?? [];
  if (!conditions.length) return entry.changes ?? [];
  if (hasAbilityTargetContextCondition(conditions) && !context?.allowContextual) return [];
  if (abilityConditionsRequireTarget(conditions) && !(context?.targetActor ?? context?.targetToken?.actor)) return [];
  if (hasItemUseCondition(conditions)) return [];
  return abilityConditionsApply(actor, conditions, { ...context, functionId: entry.id ?? "" })
    ? entry.changes ?? []
    : entry.penalties ?? [];
}

function abilityConditionsRequireTarget(conditions = []) {
  const groups = new Map();
  for (const condition of conditions ?? []) {
    const groupId = String(condition?.groupId ?? "").trim();
    if (!groupId) {
      if (isTargetActorCondition(condition)) return true;
      continue;
    }
    const entries = groups.get(groupId) ?? [];
    entries.push(condition);
    groups.set(groupId, entries);
  }
  return Array.from(groups.values()).some(group => group.length > 0 && group.every(isTargetActorCondition));
}

function isTargetActorCondition(condition = {}) {
  return [
    ABILITY_CONDITION_TYPES.targetFaction,
    ABILITY_CONDITION_TYPES.targetRace,
    ABILITY_CONDITION_TYPES.targetType
  ].includes(condition?.type)
    || (condition?.type === ABILITY_CONDITION_TYPES.posture && condition?.postureSubject === ABILITY_POSTURE_SUBJECTS.target);
}

function getContextPostureAction(actor, token = null) {
  const tokenDocument = token?.document ?? token ?? actor?.token ?? null;
  const direct = String(tokenDocument?.movementAction ?? tokenDocument?._source?.movementAction ?? "").trim();
  if (direct) return direct;
  for (const effect of actor?.effects ?? []) {
    const data = effect?.getFlag?.(SYSTEM_ID, "postureMovement")
      ?? effect?.flags?.[SYSTEM_ID]?.postureMovement;
    if (data?.action) return String(data.action);
  }
  return "walk";
}

function isActiveFreeSettingsItem(item) {
  if (item?.type !== "gear" || !item.system?.functions?.freeSettings?.enabled) return false;
  return Boolean(item.system?.equipped)
    || ["equipment", "weapon", "constructPart"].includes(item.system?.placement?.mode);
}

export function getContextualAbilityEffectChanges(actor, context = {}) {
  if (!actor) return [];
  const changes = [];
  for (const item of actor.items ?? []) {
    const functions = item?.type === "ability"
      ? item.system?.functions ?? []
      : isActiveFreeSettingsItem(item) ? item.system?.functions?.freeSettings?.entries ?? [] : [];
    changes.push(...normalizeAbilityFunctions(functions)
      .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.effectChanges)
      .filter(entry => hasAbilityTargetContextCondition(entry.conditions))
      .flatMap(entry => getConditionalFunctionChanges(actor, entry, {
        ...context,
        abilityItemId: item.id ?? "",
        functionId: entry.id ?? "",
        allowContextual: true
      })));
  }
  return changes.filter(change => change?.key && change.value !== "");
}

export function getContextualAbilityChangeValue(actor, key, { baseValue = 0, alternateKeys = [], ...context } = {}) {
  const acceptedKeys = new Set([key, ...alternateKeys].map(value => String(value ?? "").trim()).filter(Boolean));
  const changes = getContextualAbilityEffectChanges(actor, context)
    .filter(change => acceptedKeys.has(String(change?.key ?? "").trim()))
    .sort((left, right) => toInteger(left?.priority) - toInteger(right?.priority));
  let value = Number(baseValue) || 0;
  for (const change of changes) {
    const amount = evaluateEffectChangeNumber(actor, change.value, { fallback: Number.NaN });
    if (!Number.isFinite(amount)) continue;
    if (change.type === "multiply") value *= amount;
    else if (change.type === "override") value = amount;
    else if (change.type === "upgrade") value = Math.max(value, amount);
    else if (change.type === "downgrade") value = Math.min(value, amount);
    else value += amount;
  }
  return value;
}

export function hasAbilityTargetContextCondition(conditions = []) {
  return (conditions ?? []).some(isAbilityTargetContextCondition);
}

export function isAbilityTargetContextCondition(condition = {}) {
  return [
    ABILITY_CONDITION_TYPES.targetFaction,
    ABILITY_CONDITION_TYPES.targetRace,
    ABILITY_CONDITION_TYPES.targetType
  ].includes(condition?.type)
    || (condition?.type === ABILITY_CONDITION_TYPES.posture
      && condition?.postureSubject === ABILITY_POSTURE_SUBJECTS.target);
}

function hasItemUseCondition(conditions = []) {
  return (conditions ?? []).some(condition => condition?.type === ABILITY_CONDITION_TYPES.itemUse);
}

function isActorEquipmentSlotOccupied(actor, requestedSlotKey = "") {
  const slotKey = String(requestedSlotKey ?? "").trim();
  if (!actor || !slotKey) return false;

  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const slot = (race?.equipmentSlots ?? []).find(entry => {
    const selectionKey = getEquipmentSlotSelectionKey(entry.label);
    return entry.key === slotKey || selectionKey === slotKey || String(entry.label ?? "").trim() === slotKey;
  });
  const acceptedEquipmentKeys = new Set([slotKey]);
  const acceptedSelectionKeys = new Set([slotKey]);
  if (slot) {
    acceptedEquipmentKeys.add(slot.key);
    acceptedSelectionKeys.add(getEquipmentSlotSelectionKey(slot.label));
  }
  if (!slot) return false;

  for (const item of actor.items ?? []) {
    if (item?.type === "ability") continue;
    if (item.system?.placement?.mode !== "equipment") continue;
    if (acceptedEquipmentKeys.has(String(item.system?.placement?.equipmentSlot ?? ""))) return true;
    for (const selectedKey of getValidSelectedEquipmentSlotKeys(race, item)) {
      if (acceptedSelectionKeys.has(selectedKey)) return true;
    }
  }

  return false;
}

function getHealthPercent(sourceSystem = {}) {
  const health = sourceSystem?.resources?.health;
  return getResourcePercent(health);
}

function getHealthPercentages(actor, condition = {}) {
  const target = Object.values(ABILITY_HEALTH_TARGETS).includes(condition?.healthTarget)
    ? condition.healthTarget
    : ABILITY_HEALTH_TARGETS.general;
  if (target === ABILITY_HEALTH_TARGETS.general) return [getHealthPercent(actor?.system)];

  const requestedLimbKey = String(condition?.limbKey ?? ABILITY_HEALTH_LIMB_ALL).trim() || ABILITY_HEALTH_LIMB_ALL;
  const criticalOnly = target === ABILITY_HEALTH_TARGETS.criticalLimb;
  return Object.entries(actor?.system?.limbs ?? {})
    .filter(([key, limb]) => requestedLimbKey === ABILITY_HEALTH_LIMB_ALL || key === requestedLimbKey)
    .filter(([_key, limb]) => !criticalOnly || Boolean(limb?.critical))
    .map(([_key, limb]) => getResourcePercent(limb));
}

function getResourcePercent(health = {}) {
  const max = Math.max(0, Number(health?.max) || 0);
  if (max <= 0) return 100;

  const value = Number.isFinite(Number(health?.value))
    ? Number(health.value)
    : max - Math.max(0, Number(health?.spent) || 0);
  return Math.max(0, Math.min(100, (value / max) * 100));
}
