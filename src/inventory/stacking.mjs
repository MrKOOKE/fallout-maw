import { getCreatureOptions } from "../settings/accessors.mjs";
import {
  getEquipmentSlotRequirement,
  getValidSelectedEquipmentSlotKeysForOptions,
  getValidSelectedWeaponSlotKeysForOptions,
  getWeaponSlotRequirement
} from "../utils/equipment-slots.mjs";
import {
  getItemFootprint,
  getItemMaxStack,
  getItemQuantity,
  isContainerItem,
  isItemLocked
} from "../utils/inventory-containers.mjs";

/**
 * The canonical stack-compatibility rule for every inventory surface.
 *
 * Placement and quantity are deliberately excluded. They describe where a
 * stack currently lives, not what the stack contains.
 */
export function canStackInventoryItems(sourceData = null, targetItem = null) {
  if (!hasMatchingInventoryStackScalars(sourceData, targetItem)) return false;
  const sourceSystem = sourceData.system ?? {};
  const targetSystem = targetItem.system ?? {};
  const creatureOptions = getCreatureOptions();

  return (
    serializeEquipmentSlotRequirement(sourceSystem, creatureOptions)
      === serializeEquipmentSlotRequirement(targetSystem, creatureOptions)
    && serializeWeaponSlotRequirement(sourceSystem, creatureOptions)
      === serializeWeaponSlotRequirement(targetSystem, creatureOptions)
    && serializeInventoryFunctions(sourceSystem.functions)
      === serializeInventoryFunctions(targetSystem.functions)
  );
}

/**
 * Cheap pre-filter used while searching large inventories for stack targets.
 * A positive result still has to pass {@link canStackInventoryItems}.
 */
export function canMaybeStackInventoryItems(sourceData = null, targetItem = null) {
  if (!hasMatchingInventoryStackScalars(sourceData, targetItem)) return false;
  if (getItemQuantity(targetItem) >= getItemMaxStack(targetItem)) return false;

  return true;
}

/**
 * Build a cheap stable bucket key for candidate discovery. Exact compatibility
 * still uses {@link canStackInventoryItems}; this key prevents unrelated Items
 * from triggering settings normalization or function serialization.
 */
export function getInventoryStackCandidateKey(itemOrData = null) {
  if (!itemOrData || isContainerItem(itemOrData)) return "";
  const system = itemOrData.system ?? {};
  const footprint = getItemFootprint(system);
  return JSON.stringify([
    String(itemOrData.type ?? ""),
    String(itemOrData.name ?? ""),
    String(itemOrData.img ?? ""),
    isItemLocked(itemOrData),
    Number(system.weight),
    Number(system.price),
    String(system.priceCurrency ?? ""),
    getItemMaxStack(system),
    footprint.width,
    footprint.height
  ]);
}

export function createInventoryStackCandidateIndex(items = []) {
  const byKey = new Map();
  for (const item of Array.from(items?.contents ?? items ?? [])) {
    const key = getInventoryStackCandidateKey(item);
    if (!key) continue;
    const bucket = byKey.get(key) ?? [];
    bucket.push(item);
    byKey.set(key, bucket);
  }
  return byKey;
}

export function getInventoryStackCandidates(index = null, itemOrData = null) {
  const key = getInventoryStackCandidateKey(itemOrData);
  return key ? index?.get(key) ?? [] : [];
}

function hasMatchingInventoryStackScalars(sourceData = null, targetItem = null) {
  if (!sourceData || !targetItem) return false;
  if (sourceData.type !== targetItem.type) return false;
  if (isContainerItem(sourceData) || isContainerItem(targetItem)) return false;
  if (sourceData.name !== targetItem.name || sourceData.img !== targetItem.img) return false;
  if (isItemLocked(sourceData) !== isItemLocked(targetItem)) return false;

  const sourceSystem = sourceData.system ?? {};
  const targetSystem = targetItem.system ?? {};
  if (Number(sourceSystem.weight) !== Number(targetSystem.weight)) return false;
  if (Number(sourceSystem.price) !== Number(targetSystem.price)) return false;
  if (String(sourceSystem.priceCurrency ?? "") !== String(targetSystem.priceCurrency ?? "")) return false;
  if (getItemMaxStack(sourceSystem) !== getItemMaxStack(targetSystem)) return false;

  const sourceFootprint = getItemFootprint(sourceSystem);
  const targetFootprint = getItemFootprint(targetSystem);
  return sourceFootprint.width === targetFootprint.width && sourceFootprint.height === targetFootprint.height;
}

function serializeEquipmentSlotRequirement(system = {}, creatureOptions = getCreatureOptions()) {
  const requirement = getEquipmentSlotRequirement(system);
  return `${requirement.mode}:${serializeSet(getValidSelectedEquipmentSlotKeysForOptions(creatureOptions, system))}`;
}

function serializeWeaponSlotRequirement(system = {}, creatureOptions = getCreatureOptions()) {
  const requirement = getWeaponSlotRequirement(system);
  return `${requirement.mode}:${serializeSet(getValidSelectedWeaponSlotKeysForOptions(creatureOptions, system))}`;
}

function serializeInventoryFunctions(functions = {}) {
  return JSON.stringify(normalizeComparableValue(functions));
}

function serializeSet(set) {
  return Array.from(set ?? []).sort().join("|");
}

function normalizeComparableValue(value) {
  if (typeof value?.toObject === "function") return normalizeComparableValue(value.toObject(false));
  if (value instanceof Set) return Array.from(value).sort();
  if (Array.isArray(value)) return value.map(entry => normalizeComparableValue(entry));
  if (!value || typeof value !== "object") return value ?? null;

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, normalizeComparableValue(entryValue)]));
}
