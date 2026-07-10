import {
  getContextInventoryItems,
  getItemFootprint,
  getItemSystem,
  isInventoryPlacementAvailable,
  normalizeInventoryPlacement
} from "./inventory-containers.mjs";
import { toInteger } from "./numbers.mjs";

const ROTATABLE_PLACEMENT_MODES = new Set(["inventory", "lockedStorage"]);

export const INVENTORY_DRAG_ROTATION_KEY = "falloutMawInventoryRotated";

export function getInventoryDragRotation(dragData = null) {
  if (!dragData || !Object.hasOwn(dragData, INVENTORY_DRAG_ROTATION_KEY)) return null;
  return Boolean(dragData[INVENTORY_DRAG_ROTATION_KEY]);
}

export function applyInventoryDragRotation(itemData = null, dragData = null) {
  const rotated = getInventoryDragRotation(dragData);
  if (!itemData || rotated === null) return itemData;
  foundry.utils.setProperty(itemData, "system.placement.rotated", rotated);
  return itemData;
}

export function canShowInventoryRotateAction(itemOrSystem = null) {
  const system = getItemSystem(itemOrSystem);
  return ROTATABLE_PLACEMENT_MODES.has(String(system?.placement?.mode ?? "inventory"));
}

export function getInventoryRotationUnavailableLabel() {
  return game.i18n.localize("FALLOUTMAW.Messages.InventoryRotateNoSpace");
}

export function resolveInventoryItemRotation({
  item,
  parentId = "",
  contextItems = null,
  columns = 1,
  rows = 1,
  allItems = contextItems,
  excludeItemIds = [],
  reservedPlacements = [],
  options = {}
} = {}) {
  if (!item || !canShowInventoryRotateAction(item)) return null;

  const currentPlacement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, allItems);
  if (!ROTATABLE_PLACEMENT_MODES.has(currentPlacement.mode)) return null;

  const targetRotated = !Boolean(item.system?.placement?.rotated);
  const rotatedItem = createRotatedItemData(item, targetRotated);
  const footprint = getItemFootprint(rotatedItem, allItems);
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const itemId = String(item.id ?? item._id ?? "");
  if (itemId) excluded.add(itemId);

  const placementBase = {
    ...currentPlacement,
    width: footprint.width,
    height: footprint.height,
    rotated: targetRotated
  };
  const candidates = getRotationCandidatePositions(currentPlacement, footprint);
  const items = contextItems ?? getContextInventoryItems(parentId, allItems);

  for (const candidate of candidates) {
    const placement = {
      ...placementBase,
      x: candidate.x,
      y: candidate.y
    };
    if (isInventoryPlacementAvailable(
      placement,
      items,
      columns,
      rows,
      allItems,
      Array.from(excluded),
      reservedPlacements,
      options
    )) {
      return {
        placement,
        rotated: targetRotated,
        itemData: rotatedItem
      };
    }
  }

  return null;
}

export function createInventoryRotationUpdate(item, resolution) {
  const placement = resolution?.placement;
  if (!item || !placement) return null;
  return {
    _id: String(item.id ?? item._id ?? ""),
    "system.placement.x": placement.x,
    "system.placement.y": placement.y,
    "system.placement.rotated": Boolean(placement.rotated)
  };
}

function createRotatedItemData(item, rotated) {
  const data = item?.toObject?.() ?? foundry.utils.deepClone(item);
  foundry.utils.setProperty(data, "system.placement.rotated", Boolean(rotated));
  return data;
}

function getRotationCandidatePositions(currentPlacement, footprint) {
  const current = {
    x: Math.max(1, toInteger(currentPlacement.x) || 1),
    y: Math.max(1, toInteger(currentPlacement.y) || 1),
    width: Math.max(1, toInteger(currentPlacement.width) || 1),
    height: Math.max(1, toInteger(currentPlacement.height) || 1)
  };
  const target = {
    width: Math.max(1, toInteger(footprint.width) || 1),
    height: Math.max(1, toInteger(footprint.height) || 1)
  };
  const candidates = new Map();
  const add = (x, y) => {
    x = Math.max(1, toInteger(x));
    y = Math.max(1, toInteger(y));
    candidates.set(`${x}:${y}`, { x, y });
  };

  const anchorFractions = [0, 0.5, 1];
  for (const anchorX of anchorFractions) {
    for (const anchorY of anchorFractions) {
      const rawX = current.x + ((current.width - target.width) * anchorX);
      const rawY = current.y + ((current.height - target.height) * anchorY);
      for (const x of [Math.floor(rawX), Math.round(rawX), Math.ceil(rawX)]) {
        for (const y of [Math.floor(rawY), Math.round(rawY), Math.ceil(rawY)]) add(x, y);
      }
    }
  }

  const minX = current.x - target.width + 1;
  const maxX = current.x + current.width - 1;
  const minY = current.y - target.height + 1;
  const maxY = current.y + current.height - 1;
  const currentCenter = getPlacementCenter(current);
  const overlapCandidates = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (x < 1 || y < 1) continue;
      const center = getPlacementCenter({ x, y, width: target.width, height: target.height });
      overlapCandidates.push({
        x,
        y,
        distance: Math.abs(center.x - currentCenter.x) + Math.abs(center.y - currentCenter.y)
      });
    }
  }

  overlapCandidates
    .sort((left, right) => (
      (left.distance - right.distance)
      || (left.y - right.y)
      || (left.x - right.x)
    ))
    .forEach(candidate => add(candidate.x, candidate.y));

  return Array.from(candidates.values());
}

function getPlacementCenter(placement) {
  return {
    x: placement.x + ((placement.width - 1) / 2),
    y: placement.y + ((placement.height - 1) / 2)
  };
}
