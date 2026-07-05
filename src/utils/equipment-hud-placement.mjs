import { getCreatureOptions } from "../settings/accessors.mjs";
import {
  canUseWeaponSlotForItem,
  doesItemOccupyEquipmentSlot,
  getRaceEquipmentSlotsForItem,
  getRequiredEquipmentSlotsForItem,
  getRequiredWeaponSlotsForItem,
  getWeaponSlotRequirement,
  getWeaponSlotRequirementSize,
  isContainerWeaponSetKey
} from "./equipment-slots.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableInventoryPlacement,
  getContainerContentsWeight,
  getContainerInventoryGridOptions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemContainerParentId,
  getItemFootprint,
  getItemTotalWeight,
  hasContainerCycle
} from "./inventory-containers.mjs";
import {
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions,
  prepareInventoryContext
} from "./actor-display-data.mjs";

export function getActorRace(actor) {
  const raceId = String(actor?.system?.creature?.raceId ?? "");
  return getCreatureOptions().races.find(entry => entry.id === raceId) ?? null;
}

export function getEquipmentSlotCandidateItems(actor, slot = {}) {
  const race = getActorRace(actor);
  const slotKey = String(slot?.key ?? "");
  if (!actor || !slotKey) return [];
  return actor.items.contents.filter(item => (
    isInventoryEquipmentHudCandidate(item)
    && getRaceEquipmentSlotsForItem(race, item).some(candidate => candidate.key === slotKey)
  ));
}

export function getWeaponSlotCandidateItems(actor, weaponSetKey = "", weaponSlotKey = "") {
  const race = getActorRace(actor);
  if (!actor || !weaponSetKey || !weaponSlotKey) return [];
  return actor.items.contents.filter(item => (
    isInventoryEquipmentHudCandidate(item)
    && getWeaponSlotRequirement(item).selectedKeys.size
    && canUseWeaponSlotForItem(race, item, weaponSetKey, weaponSlotKey)
  ));
}

function isInventoryEquipmentHudCandidate(item) {
  if (item?.type !== "gear") return false;
  if (item.system?.equipped) return false;
  return String(item.system?.placement?.mode ?? "inventory") === "inventory";
}

export async function equipActorItemInEquipmentSlot(actor, item, slotKey = "") {
  if (!actor?.isOwner || !item || !slotKey) return null;
  const placement = resolveEquipmentPlacement(actor, item, { mode: "equipment", equipmentSlot: slotKey }, [item.id], {
    allowReplacement: true
  });
  if (!placement) {
    ui.notifications.warn("Предмет не подходит для этого слота.");
    return null;
  }

  const conflicts = getEquipmentConflictingItems(actor, item, placement, [item.id]);
  const replacementUpdates = createUnequipReplacementUpdates(actor, conflicts, [item.id]);
  if (!replacementUpdates) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
    return null;
  }

  const storedPlacement = createStoredPlacement(placement, item);
  await actor.updateEmbeddedDocuments("Item", [
    ...replacementUpdates,
    {
      _id: item.id,
      "system.equipped": true,
      "system.container.parentId": ROOT_CONTAINER_ID,
      "system.placement.mode": "equipment",
      "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
      "system.placement.weaponSet": "",
      "system.placement.weaponSlot": "",
      "system.placement.limbKey": "",
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height,
      "system.placement.rotated": storedPlacement.rotated
    }
  ]);
  return actor.items.get(item.id) ?? null;
}

export async function equipActorItemInWeaponSlot(actor, item, weaponSetKey = "", weaponSlotKey = "") {
  if (!actor?.isOwner || !item || !weaponSetKey || !weaponSlotKey) return null;
  const placement = resolveWeaponPlacement(actor, item, {
    mode: "weapon",
    weaponSet: weaponSetKey,
    weaponSlot: weaponSlotKey
  }, [item.id], { allowReplacement: true });
  if (!placement) {
    ui.notifications.warn("Предмет не подходит для этого слота оружия.");
    return null;
  }

  const conflicts = getWeaponConflictingItems(actor, item, placement, [item.id]);
  const replacementUpdates = createUnequipReplacementUpdates(actor, conflicts, [item.id]);
  if (!replacementUpdates) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
    return null;
  }

  const storedPlacement = createStoredPlacement(placement, item);
  await actor.updateEmbeddedDocuments("Item", [
    ...replacementUpdates,
    {
      _id: item.id,
      "system.equipped": true,
      "system.container.parentId": ROOT_CONTAINER_ID,
      "system.placement.mode": "weapon",
      "system.placement.equipmentSlot": "",
      "system.placement.weaponSet": storedPlacement.weaponSet,
      "system.placement.weaponSlot": storedPlacement.weaponSlot,
      "system.placement.limbKey": storedPlacement.limbKey,
      "system.placement.x": storedPlacement.x,
      "system.placement.y": storedPlacement.y,
      "system.placement.width": storedPlacement.width,
      "system.placement.height": storedPlacement.height,
      "system.placement.rotated": storedPlacement.rotated
    }
  ]);
  return actor.items.get(item.id) ?? null;
}

export async function unequipActorItemToInventory(actor, item) {
  if (!actor?.isOwner || !item) return null;
  const placementContext = getFirstAvailableInventoryPlacementContext(actor, item, [item.id]);
  if (!placementContext) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
    return null;
  }
  await actor.updateEmbeddedDocuments("Item", [createInventoryPlacementUpdate(item, placementContext)]);
  return actor.items.get(item.id) ?? null;
}

function resolveEquipmentPlacement(actor, itemData, placement = {}, excludeItemIds = [], { allowReplacement = false } = {}) {
  const race = getActorRace(actor);
  const selectedSlots = getRaceEquipmentSlotsForItem(race, itemData);
  const targetSlot = placement.equipmentSlot
    ? selectedSlots.find(slot => slot.key === placement.equipmentSlot)
    : selectedSlots[0];
  if (!targetSlot) return null;

  const requiredSlots = getRequiredEquipmentSlotsForItem(race, itemData, targetSlot.key);
  if (!requiredSlots.length) return null;
  const blocked = requiredSlots.some(slot => Boolean(getEquipmentItemForSlot(actor, slot, excludeItemIds)));
  if (blocked && !allowReplacement) return null;

  const footprint = getItemFootprint(itemData, actor.items);
  return {
    ...placement,
    mode: "equipment",
    equipmentSlot: targetSlot.key,
    weaponSet: "",
    weaponSlot: "",
    width: footprint.width,
    height: footprint.height
  };
}

function resolveWeaponPlacement(actor, itemData, placement = {}, excludeItemIds = [], { allowReplacement = false } = {}) {
  const requiredSlotKeys = getWeaponPlacementSlotKeys(actor, itemData, placement);
  if (!requiredSlotKeys.length) return null;
  const blocked = requiredSlotKeys.some(slotKey => Boolean(getWeaponItemForSlot(
    actor,
    placement.weaponSet,
    slotKey,
    excludeItemIds
  )));
  if (blocked && !allowReplacement) return null;

  const footprint = getItemFootprint(itemData, actor.items);
  return {
    ...placement,
    mode: "weapon",
    equipmentSlot: "",
    width: footprint.width,
    height: footprint.height
  };
}

function getWeaponPlacementSlotKeys(actor, itemData, placement = {}) {
  const race = getActorRace(actor);
  const setKey = String(placement.weaponSet ?? "");
  const primarySlotKey = String(placement.weaponSlot ?? "");
  if (!setKey || !primarySlotKey) return [];
  const requirement = getWeaponSlotRequirement(itemData);
  if (!requirement.selectedKeys.size) return [];

  if (isContainerWeaponSetKey(setKey)) {
    const inventory = prepareInventoryContext(actor, race, { includeLocked: true });
    const set = (inventory.weaponSets ?? []).find(entry => entry.key === setKey);
    const slots = set?.slots ?? [];
    const primaryIndex = slots.findIndex(slot => slot.key === primarySlotKey);
    if (primaryIndex < 0) return [];
    const size = getWeaponSlotRequirementSize(itemData, race);
    const requiredSlots = slots.slice(primaryIndex, primaryIndex + size);
    return requiredSlots.length === size ? requiredSlots.map(slot => slot.key) : [];
  }

  if (!canUseWeaponSlotForItem(race, itemData, setKey, primarySlotKey)) return [];
  return getRequiredWeaponSlotsForItem(race, itemData, setKey, primarySlotKey).map(slot => slot.key);
}

function getEquipmentConflictingItems(actor, itemData, placement = {}, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const race = getActorRace(actor);
  const targetSlots = getRequiredEquipmentSlotsForItem(race, itemData, placement.equipmentSlot);
  if (!targetSlots.length) return [];

  return actor.items.contents.filter(item => (
    !excluded.has(item.id)
    && item.system?.placement?.mode === "equipment"
    && targetSlots.some(slot => doesItemOccupyEquipmentSlot(item, slot))
  ));
}

function getWeaponConflictingItems(actor, itemData, placement = {}, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const conflicts = new Map();
  for (const slotKey of getWeaponPlacementSlotKeys(actor, itemData, placement)) {
    const item = getWeaponItemForSlot(actor, placement.weaponSet, slotKey, excludeItemIds);
    if (!item || excluded.has(item.id)) continue;
    conflicts.set(item.id, item);
  }
  return Array.from(conflicts.values());
}

function getEquipmentItemForSlot(actor, slot = {}, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  return actor.items.contents.find(item => (
    !excluded.has(item.id)
    && item.system?.placement?.mode === "equipment"
    && doesItemOccupyEquipmentSlot(item, slot)
  )) ?? null;
}

function getWeaponItemForSlot(actor, weaponSetKey = "", weaponSlotKey = "", excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  return actor.items.contents.find(item => (
    !excluded.has(item.id)
    && item.system?.placement?.mode === "weapon"
    && String(item.system?.placement?.weaponSet ?? "") === String(weaponSetKey)
    && String(item.system?.placement?.weaponSlot ?? "") === String(weaponSlotKey)
  )) ?? null;
}

function createUnequipReplacementUpdates(actor, items = [], excludeItemIds = []) {
  const conflicts = Array.from(new Map(items.filter(Boolean).map(item => [item.id, item])).values());
  if (!conflicts.length) return [];

  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  for (const item of conflicts) excluded.add(item.id);

  const reservedPlacementContexts = [];
  const updates = [];
  for (const item of conflicts) {
    const placementContext = getFirstAvailableInventoryPlacementContext(actor, item, Array.from(excluded), reservedPlacementContexts);
    if (!placementContext) return null;
    reservedPlacementContexts.push({ ...placementContext, itemData: item });
    updates.push(createInventoryPlacementUpdate(item, placementContext));
  }
  return updates;
}

function getFirstAvailableInventoryPlacementContext(actor, itemData = null, excludeItemIds = [], reservedPlacementContexts = []) {
  for (const parentId of getInventoryPlacementParentCandidates(actor, itemData, excludeItemIds)) {
    const reservedPlacements = reservedPlacementContexts
      .filter(entry => String(entry?.parentId ?? ROOT_CONTAINER_ID) === String(parentId ?? ROOT_CONTAINER_ID))
      .map(entry => entry.placement);
    if (!canFitItemWeightInParent(actor, itemData, parentId, reservedPlacementContexts, excludeItemIds)) continue;
    const placement = getFirstAvailableInventoryPlacement(actor, parentId, itemData, excludeItemIds, reservedPlacements);
    if (placement) return { parentId, placement };
  }
  return null;
}

function getInventoryPlacementParentCandidates(actor, itemData = null, excludeItemIds = []) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const candidates = [ROOT_CONTAINER_ID];
  const inventory = prepareInventoryContext(actor, getActorRace(actor), { includeLocked: false });
  for (const container of inventory.containers ?? []) {
    const parentId = String(container?.id ?? "");
    if (!parentId || excluded.has(parentId)) continue;
    if (hasContainerCycle(itemData, parentId, actor.items)) continue;
    candidates.push(parentId);
  }
  return candidates;
}

function canFitItemWeightInParent(actor, itemData = null, parentId = ROOT_CONTAINER_ID, reservedPlacementContexts = [], excludeItemIds = []) {
  if (!parentId) return true;
  const container = actor.items.get(parentId);
  if (!container) return false;
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const releasedLoad = actor.items.contents
    .filter(item => excluded.has(item.id) && String(getItemContainerParentId(item)) === String(parentId))
    .reduce((total, item) => total + getItemTotalWeight(item, actor.items), 0);
  const currentLoad = Math.max(0, getContainerContentsWeight(container, actor.items) - releasedLoad);
  const reservedLoad = reservedPlacementContexts
    .filter(entry => String(entry?.parentId ?? ROOT_CONTAINER_ID) === String(parentId))
    .reduce((total, entry) => total + getItemTotalWeight(entry.itemData, actor.items), 0);
  return currentLoad + reservedLoad + getItemTotalWeight(itemData, actor.items) <= getContainerMaxLoad(container) + 0.0001;
}

function getFirstAvailableInventoryPlacement(actor, parentId = ROOT_CONTAINER_ID, itemData = null, excludeItemIds = [], reservedPlacements = []) {
  const race = getActorRace(actor);
  const dimensions = parentId ? getContainerInventoryGridOptions(actor.items.get(parentId)) : getActorInventoryGridDimensions(actor, race);
  const options = parentId ? dimensions : getActorRootInventoryGridOptions(actor, parentId);
  return findFirstAvailableInventoryPlacement(
    getContextInventoryItems(parentId, actor.items),
    dimensions.columns,
    dimensions.rows,
    itemData,
    actor.items,
    excludeItemIds,
    reservedPlacements,
    options
  );
}

function createInventoryPlacementUpdate(item, placementContext = {}) {
  const storedPlacement = createStoredPlacement(placementContext.placement, item);
  return {
    _id: item.id,
    "system.equipped": false,
    "system.container.parentId": String(placementContext.parentId ?? ROOT_CONTAINER_ID),
    "system.placement.mode": storedPlacement.mode,
    "system.placement.equipmentSlot": storedPlacement.equipmentSlot,
    "system.placement.weaponSet": storedPlacement.weaponSet,
    "system.placement.weaponSlot": storedPlacement.weaponSlot,
    "system.placement.limbKey": storedPlacement.limbKey,
    "system.placement.x": storedPlacement.x,
    "system.placement.y": storedPlacement.y,
    "system.placement.width": storedPlacement.width,
    "system.placement.height": storedPlacement.height,
    "system.placement.rotated": storedPlacement.rotated
  };
}
