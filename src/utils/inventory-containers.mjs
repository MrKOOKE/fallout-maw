import { toInteger } from "./numbers.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "./item-functions.mjs";

export const CONTAINER_FUNCTION = ITEM_FUNCTIONS.container;
export const ROOT_CONTAINER_ID = "";

export function getItemsArray(items) {
  if (Array.isArray(items)) return items;
  if (items?.contents) return items.contents;
  return Array.from(items ?? []);
}

export function getItemSystem(itemOrSystem = null) {
  return itemOrSystem?.system ?? itemOrSystem ?? {};
}

export function getItemId(itemOrSystem = null) {
  return String(itemOrSystem?.id ?? itemOrSystem?._id ?? "");
}

export function getItemType(itemOrSystem = null) {
  return String(itemOrSystem?.type ?? getItemSystem(itemOrSystem)?.type ?? "");
}

export function isContainerItem(itemOrSystem = null) {
  return (
    getItemType(itemOrSystem) === "gear"
    && hasItemFunction(itemOrSystem, CONTAINER_FUNCTION)
  );
}

export function getItemContainerParentId(itemOrSystem = null) {
  return String(getItemSystem(itemOrSystem)?.container?.parentId ?? "");
}

export function getItemQuantity(itemOrSystem = null) {
  if (isContainerItem(itemOrSystem)) return 1;
  return Math.max(0, toInteger(getItemSystem(itemOrSystem)?.quantity));
}

export function getItemMaxStack(itemOrSystem = null) {
  if (isContainerItem(itemOrSystem)) return 1;
  return Math.max(1, toInteger(getItemSystem(itemOrSystem)?.maxStack) || 1);
}

export function getItemUnitWeight(itemOrSystem = null) {
  return Math.max(0, Number(getItemSystem(itemOrSystem)?.weight) || 0);
}

export function getContainerDimensions(itemOrSystem = null) {
  const container = getItemSystem(itemOrSystem)?.container ?? {};
  return {
    columns: Math.max(1, toInteger(container.columns) || 1),
    rows: Math.max(1, toInteger(container.rows) || 1)
  };
}

export function getContainerMaxLoad(itemOrSystem = null) {
  return Math.max(0, Number(getItemSystem(itemOrSystem)?.container?.maxLoad) || 0);
}

export function getItemBaseFootprint(itemOrSystem = null) {
  const placement = getItemSystem(itemOrSystem)?.placement ?? {};
  return {
    width: Math.max(1, toInteger(placement.width) || 1),
    height: Math.max(1, toInteger(placement.height) || 1)
  };
}

export function getContainerContents(containerOrId, items) {
  const parentId = typeof containerOrId === "string" ? containerOrId : getItemId(containerOrId);
  if (!parentId) return [];
  return getItemsArray(items).filter(item => getItemContainerParentId(item) === parentId);
}

export function getContainerAncestorIds(containerOrId, items) {
  const itemsArray = getItemsArray(items);
  const itemMap = new Map(itemsArray.map(item => [getItemId(item), item]));
  const ancestors = [];
  let parentId = typeof containerOrId === "string"
    ? getItemContainerParentId(itemMap.get(containerOrId))
    : getItemContainerParentId(containerOrId);
  const visited = new Set();

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    ancestors.push(parentId);
    parentId = getItemContainerParentId(itemMap.get(parentId));
  }

  return ancestors;
}

export function hasContainerCycle(itemOrId, targetParentId, items) {
  const itemId = typeof itemOrId === "string" ? itemOrId : getItemId(itemOrId);
  if (!itemId || !targetParentId) return false;
  if (itemId === targetParentId) return true;
  return getContainerAncestorIds(targetParentId, items).includes(itemId);
}

export function getAllContainedItems(containerOrId, items, visited = new Set()) {
  const containerId = typeof containerOrId === "string" ? containerOrId : getItemId(containerOrId);
  if (!containerId || visited.has(containerId)) return [];
  visited.add(containerId);

  const contents = getContainerContents(containerId, items);
  const allContents = [...contents];
  for (const item of contents) {
    if (!isContainerItem(item)) continue;
    allContents.push(...getAllContainedItems(item, items, visited));
  }
  return allContents;
}

export function getItemTotalWeight(itemOrSystem = null, items = null, memo = new Map(), visiting = new Set()) {
  const itemId = getItemId(itemOrSystem);
  if (itemId && memo.has(itemId)) return memo.get(itemId);

  const ownWeight = getItemQuantity(itemOrSystem) * getItemUnitWeight(itemOrSystem);
  if (!isContainerItem(itemOrSystem) || !items || !itemId) {
    if (itemId) memo.set(itemId, ownWeight);
    return ownWeight;
  }

  if (visiting.has(itemId)) return ownWeight;
  visiting.add(itemId);

  const totalWeight = ownWeight + getContainerContents(itemId, items).reduce(
    (total, item) => total + getItemTotalWeight(item, items, memo, visiting),
    0
  );

  visiting.delete(itemId);
  memo.set(itemId, totalWeight);
  return totalWeight;
}

export function getContainerContentsWeight(containerOrId, items) {
  return getContainerContents(containerOrId, items).reduce(
    (total, item) => total + getItemTotalWeight(item, items),
    0
  );
}

export function getItemFootprint(itemOrSystem = null, items = null, memo = new Map(), visiting = new Set()) {
  const baseFootprint = getItemBaseFootprint(itemOrSystem);
  const itemId = getItemId(itemOrSystem);

  if (!isContainerItem(itemOrSystem) || !items || !itemId) return baseFootprint;
  if (memo.has(itemId)) return memo.get(itemId);
  if (visiting.has(itemId)) return baseFootprint;

  visiting.add(itemId);

  const occupiedColumns = new Set();
  const occupiedRows = new Set();
  for (const item of getContainerContents(itemId, items)) {
    const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, items, memo, visiting);
    for (let x = placement.x; x < (placement.x + placement.width); x += 1) occupiedColumns.add(x);
    for (let y = placement.y; y < (placement.y + placement.height); y += 1) occupiedRows.add(y);
  }

  visiting.delete(itemId);
  const footprint = {
    width: Math.max(baseFootprint.width, occupiedColumns.size || 0),
    height: Math.max(baseFootprint.height, occupiedRows.size || 0)
  };
  memo.set(itemId, footprint);
  return footprint;
}

export function createInventoryPlacement(x = 1, y = 1, itemOrSystem = null, items = null) {
  const { width, height } = items ? getItemFootprint(itemOrSystem, items) : getItemBaseFootprint(itemOrSystem);
  return {
    mode: "inventory",
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    x: Math.max(1, toInteger(x)),
    y: Math.max(1, toInteger(y)),
    width,
    height
  };
}

export function normalizeInventoryPlacement(
  placement = {},
  itemOrSystem = null,
  items = null,
  memo = new Map(),
  visiting = new Set()
) {
  const basePlacement = createInventoryPlacement(placement?.x, placement?.y, itemOrSystem, null);
  const effectiveFootprint = items
    ? getItemFootprint(itemOrSystem, items, memo, visiting)
    : getItemBaseFootprint(itemOrSystem);

  return {
    ...basePlacement,
    mode: String(placement?.mode ?? "inventory"),
    equipmentSlot: String(placement?.equipmentSlot ?? ""),
    weaponSet: String(placement?.weaponSet ?? ""),
    weaponSlot: String(placement?.weaponSlot ?? ""),
    width: isContainerItem(itemOrSystem)
      ? effectiveFootprint.width
      : Math.max(1, toInteger(placement?.width) || effectiveFootprint.width),
    height: isContainerItem(itemOrSystem)
      ? effectiveFootprint.height
      : Math.max(1, toInteger(placement?.height) || effectiveFootprint.height)
  };
}

export function createStoredPlacement(placement = {}, itemOrSystem = null) {
  const baseFootprint = getItemBaseFootprint(itemOrSystem);
  return {
    mode: String(placement?.mode ?? "inventory"),
    equipmentSlot: String(placement?.equipmentSlot ?? ""),
    weaponSet: String(placement?.weaponSet ?? ""),
    weaponSlot: String(placement?.weaponSlot ?? ""),
    x: Math.max(1, toInteger(placement?.x)),
    y: Math.max(1, toInteger(placement?.y)),
    width: baseFootprint.width,
    height: baseFootprint.height
  };
}

export function isInventoryPlacementWithinBounds(placement, columns, rows) {
  if (!placement) return false;
  return (
    placement.x >= 1
    && placement.y >= 1
    && (placement.x + placement.width - 1) <= columns
    && (placement.y + placement.height - 1) <= rows
  );
}

export function placementContainsInventoryCell(placement, x, y) {
  if (!placement) return false;
  return (
    x >= placement.x
    && x < (placement.x + placement.width)
    && y >= placement.y
    && y < (placement.y + placement.height)
  );
}

export function inventoryPlacementsOverlap(left, right) {
  if (!left || !right) return false;
  return !(
    (left.x + left.width - 1) < right.x
    || (right.x + right.width - 1) < left.x
    || (left.y + left.height - 1) < right.y
    || (right.y + right.height - 1) < left.y
  );
}

export function getContextInventoryItems(parentId = ROOT_CONTAINER_ID, items = null) {
  return getItemsArray(items).filter(item => {
    if (getItemContainerParentId(item) !== String(parentId ?? "")) return false;
    const placement = item.system?.placement ?? {};
    return (String(placement.mode ?? "inventory") === "inventory");
  });
}

export function isInventoryPlacementAvailable(
  placement,
  contextItems,
  columns,
  rows,
  allItems = contextItems,
  excludeItemIds = [],
  reservedPlacements = []
) {
  if (!isInventoryPlacementWithinBounds(placement, columns, rows)) return false;
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  if (reservedPlacements.some(existing => inventoryPlacementsOverlap(placement, existing))) return false;

  return !getItemsArray(contextItems).some(item => {
    if (!item || excluded.has(getItemId(item))) return false;
    const itemPlacement = normalizeInventoryPlacement(item.system?.placement ?? item.placement ?? {}, item, allItems);
    return itemPlacement.mode === "inventory" && inventoryPlacementsOverlap(placement, itemPlacement);
  });
}

export function findFirstAvailableInventoryPlacement(
  contextItems,
  columns,
  rows,
  itemOrSystem = null,
  allItems = contextItems,
  excludeItemIds = [],
  reservedPlacements = []
) {
  for (let y = 1; y <= rows; y += 1) {
    for (let x = 1; x <= columns; x += 1) {
      const candidate = createInventoryPlacement(x, y, itemOrSystem, allItems);
      if (isInventoryPlacementAvailable(candidate, contextItems, columns, rows, allItems, excludeItemIds, reservedPlacements)) {
        return candidate;
      }
    }
  }
  return null;
}

export function buildInventoryCellStyle(x, y, placement = null) {
  if (placement) {
    return [
      `grid-column: ${placement.x} / span ${placement.width};`,
      `grid-row: ${placement.y} / span ${placement.height};`
    ].join(" ");
  }
  return `grid-column: ${x}; grid-row: ${y};`;
}

export function prepareInventoryGridContext(contextItems, columns, rows, allItems, mapItem) {
  const items = getItemsArray(contextItems);
  const reservedPlacements = [];
  const placedItems = [];
  const preferredItems = items
    .filter(item => String(item.system?.placement?.mode ?? "inventory") === "inventory")
    .sort((left, right) => {
      const leftPlacement = left.system?.placement ?? {};
      const rightPlacement = right.system?.placement ?? {};
      const yDifference = toInteger(leftPlacement.y) - toInteger(rightPlacement.y);
      if (yDifference !== 0) return yDifference;
      return toInteger(leftPlacement.x) - toInteger(rightPlacement.x);
    });
  const deferredItems = items.filter(item => !preferredItems.includes(item));

  for (const item of [...preferredItems, ...deferredItems]) {
    const preferredPlacement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, allItems);
    const placement = isInventoryPlacementAvailable(preferredPlacement, [], columns, rows, allItems, [], reservedPlacements)
      ? preferredPlacement
      : findFirstAvailableInventoryPlacement([], columns, rows, item, allItems, [], reservedPlacements);
    if (!placement) continue;
    reservedPlacements.push(placement);
    placedItems.push(mapItem(item, placement));
  }

  const cells = [];
  for (let y = 1; y <= rows; y += 1) {
    for (let x = 1; x <= columns; x += 1) {
      cells.push({
        x,
        y,
        occupied: reservedPlacements.some(placement => placementContainsInventoryCell(placement, x, y)),
        style: buildInventoryCellStyle(x, y)
      });
    }
  }

  return {
    columns,
    rows,
    cells,
    items: placedItems
  };
}

export function validateInventoryTree(items, rootDimensions) {
  const itemsArray = getItemsArray(items);
  const itemMap = new Map(itemsArray.map(item => [getItemId(item), item]));

  for (const item of itemsArray) {
    const itemId = getItemId(item);
    const parentId = getItemContainerParentId(item);
    if (!parentId) continue;

    if (parentId === itemId || hasContainerCycle(itemId, parentId, itemsArray)) {
      return { valid: false, reason: "recursive", itemId, parentId };
    }

    const parent = itemMap.get(parentId);
    if (!parent || !isContainerItem(parent)) {
      return { valid: false, reason: "invalid-parent", itemId, parentId };
    }

    if (String(item.system?.placement?.mode ?? "inventory") !== "inventory") {
      return { valid: false, reason: "invalid-placement", itemId, parentId };
    }
  }

  const rootItems = getContextInventoryItems(ROOT_CONTAINER_ID, itemsArray);
  if (!validateContextPlacements(rootItems, rootDimensions.columns, rootDimensions.rows, itemsArray)) {
    return { valid: false, reason: "no-space", parentId: ROOT_CONTAINER_ID };
  }

  for (const container of itemsArray.filter(item => isContainerItem(item))) {
    const { columns, rows } = getContainerDimensions(container);
    const contents = getContextInventoryItems(container.id, itemsArray);
    if (!validateContextPlacements(contents, columns, rows, itemsArray)) {
      return { valid: false, reason: "no-space", parentId: container.id, itemId: container.id };
    }

    if (getContainerContentsWeight(container, itemsArray) > getContainerMaxLoad(container)) {
      return { valid: false, reason: "max-load", parentId: container.id, itemId: container.id };
    }
  }

  return { valid: true };
}

function validateContextPlacements(contextItems, columns, rows, allItems) {
  const placements = [];
  for (const item of getItemsArray(contextItems)) {
    const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, allItems);
    if (!isInventoryPlacementWithinBounds(placement, columns, rows)) return false;
    if (placements.some(existing => inventoryPlacementsOverlap(existing, placement))) return false;
    placements.push(placement);
  }
  return true;
}
