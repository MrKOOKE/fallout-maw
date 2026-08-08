import { getCreatureOptions } from "../settings/accessors.mjs";
import {
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions
} from "../utils/actor-display-data.mjs";
import {
  INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  ROOT_CONTAINER_ID,
  createItemStackPartPlacementUpdate,
  createStoredPlacement,
  getContainerContentsWeight,
  getContainerInventoryGridOptions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemContainerParentId,
  getItemLockedStateForPlacementTransition,
  getItemQuantity,
  getItemTotalWeight,
  hasContainerCycle,
  isItemInButcheringStorage,
  isInventoryPlacementAvailable,
  normalizeInventoryPlacement,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { executeInventoryMutation } from "./mutation.mjs";
import { INVENTORY_RENDER_PARTS_OPTION } from "./constants.mjs";

/**
 * Commit the common one-Item, one-update inventory move without entering the
 * generic stacking/splitting insertion planner. Returns null when the move
 * needs that planner instead.
 */
export async function moveOwnedInventoryItemInInventoryFast(actor, sourceItem, requestedPlacement, {
  parentId = ROOT_CONTAINER_ID,
  quantity = 0,
  targetItem = null,
  sourceStackIndex = 0,
  rotatedItemData = null,
  render = true,
  renderParts = []
} = {}) {
  const updateData = planOwnedInventoryItemInInventoryFast(actor, sourceItem, requestedPlacement, {
    parentId,
    quantity,
    targetItem,
    sourceStackIndex,
    rotatedItemData
  });
  if (!updateData) return null;

  const parts = Array.from(new Set((renderParts ?? []).map(String).filter(Boolean)));
  await executeInventoryMutation({
    actor,
    updates: [updateData]
  }, {
    reason: "move",
    render,
    documentOptions: parts.length ? { [INVENTORY_RENDER_PARTS_OPTION]: parts } : {}
  });
  return actor.items.get(sourceItem.id) ?? sourceItem;
}

/**
 * Plan the narrow fast path independently of Foundry's write operation so its
 * eligibility and exact update payload remain cheap to test.
 */
export function planOwnedInventoryItemInInventoryFast(actor, sourceItem, requestedPlacement, {
  parentId = ROOT_CONTAINER_ID,
  quantity = 0,
  targetItem = null,
  sourceStackIndex = 0,
  rotatedItemData = null
} = {}) {
  if (!actor || !sourceItem || targetItem) return null;
  if (!isInventoryContextPlacementMode(requestedPlacement?.mode)) return null;
  if (isItemInButcheringStorage(sourceItem)) return null;

  const sourceQuantity = Math.max(1, getItemQuantity(sourceItem));
  if (usesVirtualInventoryStacks(sourceItem)) {
    const storedParentId = getStoredInventoryParentId(parentId);
    const placementMode = getInventoryPlacementModeForParent(parentId);
    if (
      getItemContainerParentId(sourceItem) !== storedParentId
      || sourceItem.system?.placement?.mode !== placementMode
    ) return null;

    const placement = createContextInventoryPlacement(
      normalizeInventoryPlacement(requestedPlacement, rotatedItemData ?? sourceItem, actor.items),
      parentId
    );
    return createItemStackPartPlacementUpdate(sourceItem, sourceStackIndex, placement) ?? null;
  }

  if (Math.max(1, toInteger(quantity) || sourceQuantity) !== sourceQuantity) return null;
  const itemData = rotatedItemData ?? sourceItem.toObject();
  if (hasContainerCycle(sourceItem, String(parentId ?? ROOT_CONTAINER_ID), actor.items)) return null;

  const placement = createContextInventoryPlacement(
    normalizeInventoryPlacement(requestedPlacement, itemData, actor.items),
    parentId
  );
  if (!isActorInventoryPlacementAvailable(actor, parentId, placement, [sourceItem.id])) return null;
  if (!canFitItemWeightInActorParent(actor, sourceItem, parentId, [sourceItem.id])) return null;
  return createInventoryItemUpdate(sourceItem, sourceQuantity, parentId, placement);
}

function createInventoryItemUpdate(item, quantity, parentId, placement) {
  const storedPlacement = createStoredPlacement(createContextInventoryPlacement(placement, parentId), item);
  const lockedState = getItemLockedStateForPlacementTransition(item, storedPlacement.mode);
  return {
    _id: item.id,
    "system.quantity": quantity,
    "system.equipped": false,
    ...(lockedState === undefined ? {} : { "system.locked": lockedState }),
    "system.container.parentId": getStoredInventoryParentId(parentId),
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

function isActorInventoryPlacementAvailable(actor, parentId, placement, excludeItemIds = []) {
  const dimensions = getActorInventoryContextDimensions(actor, parentId);
  return isInventoryPlacementAvailable(
    placement,
    getContextInventoryItems(parentId, actor.items),
    dimensions.columns,
    dimensions.rows,
    actor.items,
    excludeItemIds,
    [],
    getActorInventoryContextOptions(actor, parentId)
  );
}

function canFitItemWeightInActorParent(actor, itemData, parentId, excludeItemIds = []) {
  if (!parentId || isLockedStorageParentId(parentId)) return true;
  const container = actor.items?.get(parentId);
  if (!container) return false;
  const excluded = new Set(excludeItemIds);
  const releasedLoad = actor.items.contents
    .filter(item => excluded.has(item.id) && getItemContainerParentId(item) === String(parentId))
    .reduce((total, item) => total + getItemTotalWeight(item, actor.items), 0);
  const currentLoad = Math.max(0, getContainerContentsWeight(container, actor.items) - releasedLoad);
  return currentLoad + getItemTotalWeight(itemData, actor.items) <= getContainerMaxLoad(container) + 0.0001;
}

function getActorInventoryContextDimensions(actor, parentId) {
  if (parentId && !isLockedStorageParentId(parentId)) {
    return getContainerInventoryGridOptions(actor.items?.get(parentId));
  }
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  return getActorInventoryGridDimensions(actor, race);
}

function getActorInventoryContextOptions(actor, parentId) {
  if (isLockedStorageParentId(parentId)) {
    return {
      allowOverflowRows: true,
      extraRows: INFINITE_ROOT_INVENTORY_EMPTY_ROWS,
      placementMode: LOCKED_STORAGE_PLACEMENT_MODE,
      preferredPlacementModes: [LOCKED_STORAGE_PLACEMENT_MODE]
    };
  }
  if (parentId) return getContainerInventoryGridOptions(actor.items?.get(parentId));
  return getActorRootInventoryGridOptions(actor, parentId);
}

function createContextInventoryPlacement(placement = {}, parentId = ROOT_CONTAINER_ID) {
  return {
    ...placement,
    mode: getInventoryPlacementModeForParent(parentId),
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    limbKey: ""
  };
}

function getStoredInventoryParentId(parentId = ROOT_CONTAINER_ID) {
  return isLockedStorageParentId(parentId) ? ROOT_CONTAINER_ID : String(parentId ?? ROOT_CONTAINER_ID);
}

function getInventoryPlacementModeForParent(parentId = ROOT_CONTAINER_ID) {
  return isLockedStorageParentId(parentId) ? LOCKED_STORAGE_PLACEMENT_MODE : "inventory";
}

function isInventoryContextPlacementMode(mode = "") {
  return mode === "inventory" || mode === LOCKED_STORAGE_PLACEMENT_MODE;
}

function isLockedStorageParentId(parentId = ROOT_CONTAINER_ID) {
  return String(parentId ?? ROOT_CONTAINER_ID) === LOCKED_STORAGE_PARENT_ID;
}
