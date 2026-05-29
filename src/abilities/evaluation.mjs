import { getCreatureOptions } from "../settings/accessors.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_EQUIPMENT_OPERATORS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { getEquipmentSlotSelectionKey, getSelectedEquipmentSlotKeys } from "../utils/equipment-slots.mjs";
import { toInteger } from "../utils/numbers.mjs";

export function getAbilityEffectChanges(actor, item) {
  return normalizeAbilityFunctions(item?.system?.functions ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .flatMap(entry => getConditionalFunctionChanges(actor, entry))
    .filter(change => change.key && change.value !== "");
}

export function getAbilityAcquisitionChanges(itemOrData) {
  return normalizeAbilityFunctions(itemOrData?.system?.functions ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.acquisitionChanges)
    .flatMap(entry => entry.changes)
    .filter(change => change.key && change.value !== "");
}

export function getAbilitySkillAdvancementBaseBonuses(actor, skillSettings = []) {
  const bonuses = Object.fromEntries((skillSettings ?? []).map(skill => [skill.key, 0]));
  for (const item of actor?.items ?? []) {
    if (item?.type !== "ability") continue;
    for (const change of getAbilityEffectChanges(actor, item)) {
      const key = String(change?.key ?? "");
      if (!key.startsWith("system.skillAdvancementBase.")) continue;
      const target = key.slice("system.skillAdvancementBase.".length);
      const value = Number(change.value) || 0;
      if (target === "all") {
        for (const skill of skillSettings ?? []) bonuses[skill.key] = (Number(bonuses[skill.key]) || 0) + value;
      } else if (Object.hasOwn(bonuses, target)) {
        bonuses[target] = (Number(bonuses[target]) || 0) + value;
      }
    }
  }
  return bonuses;
}

export function abilityConditionsApply(actor, conditions = []) {
  return (conditions ?? []).every(condition => abilityConditionApplies(actor, condition));
}

export function abilityConditionApplies(actor, condition = {}) {
  if (condition.type === ABILITY_CONDITION_TYPES.equipmentSlotOccupied) {
    const occupied = isActorEquipmentSlotOccupied(actor, condition.equipmentSlotKey);
    return condition.operator === ABILITY_EQUIPMENT_OPERATORS.empty ? !occupied : occupied;
  }

  if (condition.type === ABILITY_CONDITION_TYPES.healthPercent) {
    const threshold = Math.max(0, Math.min(100, toInteger(condition.percent ?? 50)));
    const healthPercent = getHealthPercent(actor?.system);
    return condition.operator === "gte" ? healthPercent >= threshold : healthPercent <= threshold;
  }

  return true;
}

function getConditionalFunctionChanges(actor, entry = {}) {
  const conditions = entry.conditions ?? [];
  if (!conditions.length) return entry.changes ?? [];
  return abilityConditionsApply(actor, conditions)
    ? entry.changes ?? []
    : entry.penalties ?? [];
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

  for (const item of actor.items ?? []) {
    if (item?.type === "ability") continue;
    if (item.system?.placement?.mode !== "equipment") continue;
    if (acceptedEquipmentKeys.has(String(item.system?.placement?.equipmentSlot ?? ""))) return true;
    for (const selectedKey of getSelectedEquipmentSlotKeys(item)) {
      if (acceptedSelectionKeys.has(selectedKey)) return true;
    }
  }

  return false;
}

function getHealthPercent(sourceSystem = {}) {
  const health = sourceSystem?.resources?.health;
  const max = Math.max(0, Number(health?.max) || 0);
  if (max <= 0) return 100;

  const value = Number.isFinite(Number(health?.value))
    ? Number(health.value)
    : max - Math.max(0, Number(health?.spent) || 0);
  return Math.max(0, Math.min(100, (value / max) * 100));
}
