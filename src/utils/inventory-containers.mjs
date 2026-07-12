import { toInteger } from "./numbers.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "./item-functions.mjs";

export const CONTAINER_FUNCTION = ITEM_FUNCTIONS.container;
export const ROOT_CONTAINER_ID = "";
export const INFINITE_ROOT_INVENTORY_EMPTY_ROWS = 4;
export const LOCKED_STORAGE_PARENT_ID = "__lockedStorage";
export const LOCKED_STORAGE_PLACEMENT_MODE = "lockedStorage";
export const BUTCHERING_STORAGE_PARENT_ID = "__butcheringStorage";
export const BUTCHERING_STORAGE_PLACEMENT_MODE = "butcheringStorage";

// #region agent log
let _agentPerf = null;
function _agentLog(hypothesisId, location, message, data = {}) {
  fetch('http://127.0.0.1:7815/ingest/477c0bca-778e-4b72-9d68-e7f8bcefd8f5',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'363203'},body:JSON.stringify({sessionId:'363203',runId:'repro2',hypothesisId,location,message,data,timestamp:Date.now()})}).catch(()=>{});
}
// #endregion

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

export function isItemLocked(itemOrSystem = null) {
  return Boolean(getItemSystem(itemOrSystem)?.locked);
}

export function isLockedStoragePlacement(placement = null) {
  return String(placement?.mode ?? "") === LOCKED_STORAGE_PLACEMENT_MODE;
}

export function isItemInLockedStorage(itemOrSystem = null) {
  return isLockedStoragePlacement(getItemSystem(itemOrSystem)?.placement ?? {});
}

export function isButcheringStoragePlacement(placement = null) {
  return String(placement?.mode ?? "") === BUTCHERING_STORAGE_PLACEMENT_MODE;
}

export function isItemInButcheringStorage(itemOrSystem = null) {
  return isButcheringStoragePlacement(getItemSystem(itemOrSystem)?.placement ?? {});
}

export function getItemQuantity(itemOrSystem = null) {
  if (isContainerItem(itemOrSystem)) return 1;
  return Math.max(0, toInteger(getItemSystem(itemOrSystem)?.quantity));
}

export function getItemMaxStack(itemOrSystem = null) {
  if (isContainerItem(itemOrSystem)) return 1;
  return Math.max(1, toInteger(getItemSystem(itemOrSystem)?.maxStack) || 1);
}

export function usesVirtualInventoryStacks(itemOrSystem = null) {
  return !isContainerItem(itemOrSystem) && getItemMaxStack(itemOrSystem) > 1;
}

export function getItemStackParts(itemOrSystem = null) {
  const quantity = getItemQuantity(itemOrSystem);
  if (quantity <= 0) return [];
  const maxStack = getItemMaxStack(itemOrSystem);
  if (maxStack <= 1) return [{ quantity }];
  const rawParts = Array.isArray(getItemSystem(itemOrSystem)?.stackParts)
    ? getItemSystem(itemOrSystem).stackParts
    : [];
  const parts = rawParts
    .map(part => normalizeRawStackPart(part, maxStack))
    .filter(part => part.quantity > 0);
  return consolidateUnpositionedStackParts(
    normalizeItemStackParts(parts, quantity, maxStack),
    maxStack,
    getItemSystem(itemOrSystem)?.placement
  );
}

export function getItemStackPartQuantity(itemOrSystem = null, stackIndex = 0) {
  const parts = getItemStackParts(itemOrSystem);
  const index = Math.max(0, toInteger(stackIndex));
  return parts[index]?.quantity ?? parts[0]?.quantity ?? getItemQuantity(itemOrSystem);
}

export function getItemStackAvailableSpace(itemOrSystem = null, targetStackIndex = null) {
  const maxStack = getItemMaxStack(itemOrSystem);
  if (!usesVirtualInventoryStacks(itemOrSystem)) {
    return Math.max(0, maxStack - getItemQuantity(itemOrSystem));
  }
  const parts = getItemStackParts(itemOrSystem);
  if (targetStackIndex !== null && targetStackIndex !== undefined) {
    const index = Math.max(0, Math.min(parts.length - 1, toInteger(targetStackIndex)));
    return Math.max(0, maxStack - Math.max(0, toInteger(parts[index]?.quantity)));
  }
  return parts.reduce(
    (total, part) => total + Math.max(0, maxStack - Math.max(0, toInteger(part?.quantity))),
    0
  );
}

export function getItemStackAdditionOverflowQuantity(itemOrSystem = null, amount = 0, targetStackIndex = null) {
  const addQuantity = Math.max(0, toInteger(amount));
  return Math.max(0, addQuantity - getItemStackAvailableSpace(itemOrSystem, targetStackIndex));
}

export function createItemStackPartPlacementUpdate(itemOrSystem = null, stackIndex = 0, placement = null) {
  const itemId = getItemId(itemOrSystem);
  if (!itemId || !usesVirtualInventoryStacks(itemOrSystem) || !placement) return null;
  const maxStack = getItemMaxStack(itemOrSystem);
  const parts = getItemStackParts(itemOrSystem);
  const index = Math.max(0, Math.min(parts.length - 1, toInteger(stackIndex)));
  const part = parts[index];
  if (!part) return null;

  parts[index] = {
    ...part,
    x: Math.max(1, toInteger(placement.x)),
    y: Math.max(1, toInteger(placement.y)),
    rotated: Boolean(placement.rotated)
  };
  const normalized = normalizeItemStackParts(parts, getItemQuantity(itemOrSystem), maxStack);
  return {
    _id: itemId,
    "system.stackParts": normalized,
    ...createPrimaryStackPlacementUpdate(normalized[0], placement)
  };
}

export function createItemStackPartSplitUpdate(itemOrSystem = null, stackIndex = 0, amount = 0, placement = null) {
  const itemId = getItemId(itemOrSystem);
  if (!itemId || !usesVirtualInventoryStacks(itemOrSystem)) return null;
  const parts = getItemStackParts(itemOrSystem);
  const index = Math.max(0, Math.min(parts.length - 1, toInteger(stackIndex)));
  const part = parts[index];
  if (!part) return null;
  const splitQuantity = Math.max(1, Math.min(part.quantity - 1, toInteger(amount)));
  if (part.quantity <= 1 || !splitQuantity) return null;
  const remainingPart = {
    ...part,
    quantity: part.quantity - splitQuantity
  };
  const splitPart = {
    quantity: splitQuantity,
    rotated: part.rotated
  };
  applyStackPartPlacement(splitPart, placement);
  parts.splice(index, 1, remainingPart, splitPart);
  const normalized = normalizeItemStackParts(parts, getItemQuantity(itemOrSystem), getItemMaxStack(itemOrSystem));
  return {
    _id: itemId,
    "system.stackParts": normalized,
    ...createPrimaryStackPlacementUpdate(normalized[0], itemOrSystem?.system?.placement)
  };
}

export function createItemStackPartRemovalUpdate(itemOrSystem = null, amount = 0, stackIndex = 0) {
  const itemId = getItemId(itemOrSystem);
  const quantity = getItemQuantity(itemOrSystem);
  const removeQuantity = Math.max(0, Math.min(quantity, toInteger(amount)));
  if (!itemId || !removeQuantity) return null;

  const maxStack = getItemMaxStack(itemOrSystem);
  const parts = getItemStackParts(itemOrSystem);
  let remaining = removeQuantity;
  let index = Math.max(0, Math.min(parts.length - 1, toInteger(stackIndex)));
  if (!parts.length) index = 0;

  while (remaining > 0 && parts.length) {
    const taken = Math.min(parts[index]?.quantity ?? 0, remaining);
    parts[index] = {
      ...parts[index],
      quantity: Math.max(0, (parts[index]?.quantity ?? 0) - taken)
    };
    remaining -= taken;
    if ((parts[index]?.quantity ?? 0) <= 0) parts.splice(index, 1);
    if (index >= parts.length) index = Math.max(0, parts.length - 1);
  }

  const normalized = normalizeItemStackParts(parts, Math.max(0, quantity - removeQuantity), maxStack);
  const nextQuantity = Math.max(0, quantity - removeQuantity);
  return {
    _id: itemId,
    "system.quantity": nextQuantity,
    "system.stackParts": normalized,
    ...createPrimaryStackPlacementUpdate(normalized[0], itemOrSystem?.system?.placement)
  };
}

export function createItemStackPartMergeUpdate(itemOrSystem = null, sourceStackIndex = 0, targetStackIndex = 0, amount = 0) {
  const itemId = getItemId(itemOrSystem);
  if (!itemId || !usesVirtualInventoryStacks(itemOrSystem)) return null;
  const parts = getItemStackParts(itemOrSystem);
  const sourceIndex = Math.max(0, Math.min(parts.length - 1, toInteger(sourceStackIndex)));
  const targetIndex = Math.max(0, Math.min(parts.length - 1, toInteger(targetStackIndex)));
  if (sourceIndex === targetIndex || !parts[sourceIndex] || !parts[targetIndex]) return null;
  const maxStack = getItemMaxStack(itemOrSystem);
  const availableSpace = Math.max(0, maxStack - parts[targetIndex].quantity);
  const moveQuantity = Math.max(0, Math.min(
    toInteger(amount) || parts[sourceIndex].quantity,
    parts[sourceIndex].quantity,
    availableSpace
  ));
  if (!moveQuantity) return null;

  parts[targetIndex] = {
    ...parts[targetIndex],
    quantity: parts[targetIndex].quantity + moveQuantity
  };
  parts[sourceIndex] = {
    ...parts[sourceIndex],
    quantity: parts[sourceIndex].quantity - moveQuantity
  };
  const filtered = parts.filter(part => part.quantity > 0);
  const normalized = normalizeItemStackParts(filtered, getItemQuantity(itemOrSystem), maxStack);
  return {
    _id: itemId,
    "system.stackParts": normalized,
    ...createPrimaryStackPlacementUpdate(normalized[0], itemOrSystem?.system?.placement)
  };
}

export function createItemStackPartAdditionUpdate(itemOrSystem = null, amount = 0, targetStackIndex = null, placement = null) {
  const itemId = getItemId(itemOrSystem);
  const addQuantity = Math.max(0, toInteger(amount));
  if (!itemId || !addQuantity) return null;
  const quantity = getItemQuantity(itemOrSystem);
  const maxStack = getItemMaxStack(itemOrSystem);
  const parts = getItemStackParts(itemOrSystem);
  let remaining = addQuantity;
  const fillIndexes = targetStackIndex !== null && targetStackIndex !== undefined && parts.length
    ? [Math.max(0, Math.min(parts.length - 1, toInteger(targetStackIndex)))]
    : parts.map((_part, index) => index);
  for (const index of fillIndexes) {
    if (remaining <= 0) break;
    const room = Math.max(0, maxStack - parts[index].quantity);
    const moved = Math.min(room, remaining);
    if (moved > 0) {
      parts[index] = {
        ...parts[index],
        quantity: parts[index].quantity + moved
      };
      remaining -= moved;
    }
  }
  if (remaining > 0) {
    const addedParts = createCanonicalStackParts(remaining, maxStack);
    if (Array.isArray(placement)) {
      for (let index = 0; index < addedParts.length; index += 1) {
        applyStackPartPlacement(addedParts[index], placement[index]);
      }
    } else {
      applyStackPartPlacement(addedParts[0], placement);
    }
    parts.push(...addedParts);
  }
  const nextQuantity = quantity + addQuantity;
  const normalized = normalizeItemStackParts(parts, nextQuantity, maxStack);
  return {
    _id: itemId,
    "system.quantity": nextQuantity,
    "system.stackParts": normalized,
    ...createPrimaryStackPlacementUpdate(normalized[0], itemOrSystem?.system?.placement)
  };
}

export function createItemStackPartsForQuantity(itemOrSystem = null, quantity = getItemQuantity(itemOrSystem)) {
  return createCanonicalStackParts(Math.max(0, toInteger(quantity)), getItemMaxStack(itemOrSystem));
}

export function createAnchoredItemStackPartsForQuantity({
  itemData = null,
  quantity = getItemQuantity(itemData),
  preferredPlacement = null,
  contextItems = [],
  columns = 1,
  rows = 1,
  allItems = contextItems,
  excludeItemIds = [],
  reservedPlacements = [],
  options = {}
} = {}) {
  if (!itemData || !usesVirtualInventoryStacks(itemData)) return createItemStackPartsForQuantity(itemData, quantity);
  const parts = createItemStackPartsForQuantity(itemData, quantity);
  if (!parts.length) return [];
  const reserved = Array.isArray(reservedPlacements) ? [...reservedPlacements] : [];
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const filteredContextItems = getItemsArray(contextItems)
    .filter(item => !excluded.has(getItemId(item)));
  const contextPlacementItems = createInventoryPlacementItems(filteredContextItems, allItems);
  const resolvedContext = contextPlacementItems.some(item => item._stackHasStoredPlacement === false)
    ? resolveInventoryGridPlacements(filteredContextItems, columns, rows, allItems, options)
    : null;
  if (contextPlacementItems.some(item => item._stackHasStoredPlacement === false) && !resolvedContext) return null;
  const occupiedPlacements = resolvedContext
    ? resolvedContext.items.filter(entry => !entry.phantom).map(entry => entry.placement)
    : contextPlacementItems
      .filter(item => item._stackHasStoredPlacement !== false)
      .map(item => normalizeInventoryPlacement(item.system?.placement ?? item.placement ?? {}, item, allItems));
  const occupiedCells = createOccupiedInventoryCellSet([
    ...occupiedPlacements,
    ...reserved
  ]);
  const cursor = { x: 1, y: 1 };
  const anchored = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = { ...parts[index] };
    const partData = foundry.utils.deepClone(itemData);
    foundry.utils.setProperty(partData, "system.quantity", part.quantity);
    let placement = null;
    if (
      index === 0
      && preferredPlacement
      && isInventoryPlacementAvailable(preferredPlacement, contextItems, columns, rows, allItems, excludeItemIds, reserved, options)
    ) {
      placement = preferredPlacement;
    } else {
      placement = findFirstAvailableInventoryPlacementFromOccupied(
        occupiedCells,
        columns,
        rows,
        partData,
        allItems,
        options,
        cursor
      );
    }
    if (!placement) return null;
    applyStackPartPlacement(part, placement);
    anchored.push(part);
    reserved.push(placement);
    addInventoryPlacementCells(occupiedCells, placement);
    cursor.x = placement.x;
    cursor.y = placement.y;
  }

  return anchored;
}

export function createSingleItemStackPartForQuantity(itemOrSystem = null, quantity = getItemQuantity(itemOrSystem)) {
  const maxStack = getItemMaxStack(itemOrSystem);
  return createCanonicalStackParts(Math.max(0, toInteger(quantity)), maxStack);
}

function normalizeItemStackParts(parts = [], quantity = 0, maxStack = 1) {
  quantity = Math.max(0, toInteger(quantity));
  maxStack = Math.max(1, toInteger(maxStack) || 1);
  if (!quantity) return [];

  const normalized = [];
  let total = 0;
  for (const part of parts) {
    const value = Math.max(0, Math.min(maxStack, toInteger(part?.quantity ?? part)));
    if (!value) continue;
    const entry = {
      quantity: value
    };
    if (toInteger(part?.x) > 0) entry.x = toInteger(part.x);
    if (toInteger(part?.y) > 0) entry.y = toInteger(part.y);
    if (part?.rotated !== undefined && part?.rotated !== null) entry.rotated = Boolean(part.rotated);
    if (total + value > quantity) {
      const remainder = quantity - total;
      if (remainder > 0) normalized.push({ ...entry, quantity: remainder });
      total = quantity;
      break;
    }
    normalized.push(entry);
    total += value;
  }

  let remaining = Math.max(0, quantity - total);
  for (let index = 0; index < normalized.length && remaining > 0; index += 1) {
    const room = Math.max(0, maxStack - normalized[index].quantity);
    const moved = Math.min(room, remaining);
    if (!moved) continue;
    normalized[index] = {
      ...normalized[index],
      quantity: normalized[index].quantity + moved
    };
    remaining -= moved;
  }
  if (remaining > 0) normalized.push(...createCanonicalStackParts(remaining, maxStack));
  return normalized;
}

function createCanonicalStackParts(quantity = 0, maxStack = 1) {
  quantity = Math.max(0, toInteger(quantity));
  maxStack = Math.max(1, toInteger(maxStack) || 1);
  const parts = [];
  let remaining = quantity;
  while (remaining > 0) {
    const part = Math.min(remaining, maxStack);
    parts.push({ quantity: part });
    remaining -= part;
  }
  return parts;
}

function consolidateUnpositionedStackParts(parts = [], maxStack = 1, fallbackPlacement = null) {
  const positioned = [];
  const unpositioned = [];
  for (const part of parts) {
    if (toInteger(part?.x) > 0 && toInteger(part?.y) > 0) positioned.push({ ...part });
    else unpositioned.push({ ...part });
  }
  if (!unpositioned.length) return positioned;

  if (!positioned.length && toInteger(fallbackPlacement?.x) > 0 && toInteger(fallbackPlacement?.y) > 0) {
    const first = unpositioned.shift();
    positioned.push({
      ...first,
      x: toInteger(fallbackPlacement.x),
      y: toInteger(fallbackPlacement.y),
      rotated: Boolean(first.rotated ?? fallbackPlacement.rotated)
    });
  }

  const remainingParts = [];
  for (const part of unpositioned) {
    let remaining = Math.max(0, toInteger(part.quantity));
    for (let index = 0; index < positioned.length && remaining > 0; index += 1) {
      const room = Math.max(0, maxStack - positioned[index].quantity);
      const moved = Math.min(room, remaining);
      if (!moved) continue;
      positioned[index] = {
        ...positioned[index],
        quantity: positioned[index].quantity + moved
      };
      remaining -= moved;
    }
    if (remaining > 0) remainingParts.push({ ...part, quantity: remaining });
  }
  return [...positioned, ...remainingParts];
}

function applyStackPartPlacement(part = null, placement = null) {
  if (!part || !placement) return part;
  const x = toInteger(placement.x);
  const y = toInteger(placement.y);
  if (x > 0) part.x = x;
  if (y > 0) part.y = y;
  if (placement.rotated !== undefined && placement.rotated !== null) part.rotated = Boolean(placement.rotated);
  return part;
}

function normalizeRawStackPart(part = null, maxStack = 1) {
  const quantity = Math.max(0, Math.min(maxStack, toInteger(part?.quantity ?? part)));
  const entry = { quantity };
  if (toInteger(part?.x) > 0) entry.x = toInteger(part.x);
  if (toInteger(part?.y) > 0) entry.y = toInteger(part.y);
  if (part?.rotated !== undefined && part?.rotated !== null) entry.rotated = Boolean(part.rotated);
  return entry;
}

function createPrimaryStackPlacementUpdate(primaryPart = null, fallbackPlacement = null) {
  if (!primaryPart || !toInteger(primaryPart.x) || !toInteger(primaryPart.y)) return {};
  return {
    "system.placement.x": toInteger(primaryPart.x),
    "system.placement.y": toInteger(primaryPart.y),
    "system.placement.rotated": Boolean(primaryPart.rotated ?? fallbackPlacement?.rotated)
  };
}

export function getItemUnitWeight(itemOrSystem = null) {
  return Math.max(0, Number(getItemSystem(itemOrSystem)?.weight) || 0);
}

export function getContainerLoadReduction(itemOrSystem = null) {
  if (!isContainerItem(itemOrSystem)) return 0;
  const value = Number(getItemSystem(itemOrSystem)?.functions?.container?.loadReduction) || 0;
  return Math.max(0, Math.min(100, value));
}

export function getContainerDimensions(itemOrSystem = null) {
  const container = getItemSystem(itemOrSystem)?.container ?? {};
  return {
    columns: Math.max(1, toInteger(container.columns) || 1),
    rows: Math.max(1, toInteger(container.rows) || 1)
  };
}

export function normalizeContainerSpecialGridBlock(block = null) {
  const width = Math.max(1, toInteger(block?.width) || 1);
  const height = Math.max(1, toInteger(block?.height) || 1);
  const x = Number(block?.x);
  const y = Number(block?.y);
  return {
    id: String(block?.id || foundry.utils.randomID()),
    x: snapContainerSpecialGridCoordinate(x, width),
    y: snapContainerSpecialGridCoordinate(y, height),
    width,
    height
  };
}

export function finalizeContainerSpecialGridBlock(block = null) {
  return {
    id: String(block?.id || foundry.utils.randomID()),
    x: Number(block?.x) || 0,
    y: Number(block?.y) || 0,
    width: Math.max(1, toInteger(block?.width) || 1),
    height: Math.max(1, toInteger(block?.height) || 1)
  };
}

function getContainerSpecialGridData(itemOrSystem = null) {
  return getItemSystem(itemOrSystem)?.functions?.container?.specialGrids ?? {};
}

export function computeContainerSpecialGridBaseAnchorSeed(dimensions = {}) {
  const columns = Math.max(1, toInteger(dimensions.columns) || 1);
  const rows = Math.max(1, toInteger(dimensions.rows) || 1);
  const seeded = normalizeContainerSpecialGridBlock({
    id: "__base__",
    x: 0,
    y: 0,
    width: columns,
    height: rows
  });
  return {
    left: seeded.x - (columns / 2),
    top: seeded.y - (rows / 2)
  };
}

export function hasPersistedContainerSpecialGridBaseAnchor(itemOrSystem = null) {
  const item = itemOrSystem?.documentName === "Item" ? itemOrSystem : null;
  if (item) {
    return foundry.utils.hasProperty(
      item._source?.system ?? {},
      "functions.container.specialGrids.baseAnchor"
    );
  }
  return foundry.utils.hasProperty(
    getItemSystem(itemOrSystem) ?? {},
    "functions.container.specialGrids.baseAnchor"
  );
}

export function getContainerSpecialGridBaseAnchor(itemOrSystem = null) {
  const dimensions = getContainerDimensions(itemOrSystem);
  const defaultAnchor = computeContainerSpecialGridBaseAnchorSeed(dimensions);
  if (!hasPersistedContainerSpecialGridBaseAnchor(itemOrSystem)) {
    return defaultAnchor;
  }
  const anchor = getContainerSpecialGridData(itemOrSystem)?.baseAnchor ?? {};
  const left = Number(anchor.left);
  const top = Number(anchor.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return defaultAnchor;
  return { left, top };
}

function snapContainerSpecialGridCoordinate(value, size = 1) {
  const number = Number(value);
  const offset = (Math.max(1, toInteger(size) || 1) - 1) / 2;
  return (Number.isFinite(number) ? Math.round(number - offset) : 0) + offset;
}

export function getContainerSpecialGridBlocks(itemOrSystem = null) {
  const blocks = getItemSystem(itemOrSystem)?.functions?.container?.specialGrids?.blocks;
  if (!Array.isArray(blocks)) return [];
  return blocks
    .map(finalizeContainerSpecialGridBlock)
    .filter(block => block.width > 0 && block.height > 0);
}

export function getContainerInventoryGridOptions(itemOrSystem = null) {
  const dimensions = getContainerDimensions(itemOrSystem);
  const extraBlocks = getContainerSpecialGridBlocks(itemOrSystem);
  if (!extraBlocks.length) return { ...dimensions };

  const baseZone = {
    id: "base",
    x: 1,
    y: 1,
    width: dimensions.columns,
    height: dimensions.rows,
    base: true
  };
  const baseAnchor = getContainerSpecialGridBaseAnchor(itemOrSystem);
  const baseLeft = baseAnchor.left;
  const baseTop = baseAnchor.top;
  const extraZones = extraBlocks.map(block => ({
    id: block.id,
    x: Math.floor((block.x - (block.width / 2)) - baseLeft) + 1,
    y: Math.floor((block.y - (block.height / 2)) - baseTop) + 1,
    width: block.width,
    height: block.height,
    base: false
  }));
  const rawZones = [
    baseZone,
    ...extraZones
  ];

  const minX = rawZones.reduce((min, zone) => Math.min(min, zone.x), 1);
  const minY = rawZones.reduce((min, zone) => Math.min(min, zone.y), 1);
  const originShiftX = Math.max(0, 1 - minX);
  const originShiftY = Math.max(0, 1 - minY);
  const zones = rawZones.map(zone => ({
    ...zone,
    x: zone.x + originShiftX,
    y: zone.y + originShiftY
  }));
  const columns = zones.reduce((max, zone) => Math.max(max, zone.x + zone.width - 1), dimensions.columns);
  const rows = zones.reduce((max, zone) => Math.max(max, zone.y + zone.height - 1), dimensions.rows);
  return {
    columns,
    rows,
    baseColumns: dimensions.columns,
    baseRows: dimensions.rows,
    zones
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

export function getItemEffectiveBaseFootprint(itemOrSystem = null) {
  const footprint = getItemBaseFootprint(itemOrSystem);
  if (!Boolean(getItemSystem(itemOrSystem)?.placement?.rotated)) return footprint;
  return {
    width: footprint.height,
    height: footprint.width
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

export function getAllContainedItems(containerOrId, items, visited = new Set(), childrenByParent = null) {
  const containerId = typeof containerOrId === "string" ? containerOrId : getItemId(containerOrId);
  if (!containerId || visited.has(containerId)) return [];
  visited.add(containerId);

  childrenByParent ??= buildContainerChildrenMap(items);
  const contents = childrenByParent.get(containerId) ?? [];
  const allContents = [...contents];
  for (const item of contents) {
    if (!isContainerItem(item)) continue;
    allContents.push(...getAllContainedItems(item, items, visited, childrenByParent));
  }
  return allContents;
}

function buildContainerChildrenMap(items) {
  const childrenByParent = new Map();
  for (const item of getItemsArray(items)) {
    const parentId = getItemContainerParentId(item);
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(item);
    childrenByParent.set(parentId, children);
  }
  return childrenByParent;
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

export function getItemActorLoadWeight(itemOrSystem = null, items = null, memo = new Map(), visiting = new Set()) {
  const itemId = getItemId(itemOrSystem);
  if (itemId && memo.has(itemId)) return memo.get(itemId);
  if (isItemInButcheringStorage(itemOrSystem)) {
    if (itemId) memo.set(itemId, 0);
    return 0;
  }

  const ownWeight = getItemQuantity(itemOrSystem) * getItemUnitWeight(itemOrSystem);
  if (!isContainerItem(itemOrSystem) || !items || !itemId) {
    if (itemId) memo.set(itemId, ownWeight);
    return ownWeight;
  }

  if (visiting.has(itemId)) return ownWeight;
  visiting.add(itemId);

  const contentsWeight = getContainerContents(itemId, items).reduce(
    (total, item) => total + getItemActorLoadWeight(item, items, memo, visiting),
    0
  );
  const isEquipped = Boolean(getItemSystem(itemOrSystem)?.equipped);
  const reduction = isEquipped ? getContainerLoadReduction(itemOrSystem) / 100 : 0;
  const actorLoadWeight = ownWeight + (contentsWeight * (1 - reduction));

  visiting.delete(itemId);
  memo.set(itemId, actorLoadWeight);
  return actorLoadWeight;
}

export function getContainerContentsWeight(containerOrId, items, memo = new Map()) {
  return getContainerContents(containerOrId, items).reduce(
    (total, item) => total + getItemTotalWeight(item, items, memo),
    0
  );
}

export function getItemFootprint(itemOrSystem = null, items = null, memo = new Map(), visiting = new Set()) {
  const baseFootprint = getItemEffectiveBaseFootprint(itemOrSystem);
  const itemId = getItemId(itemOrSystem);

  if (!isContainerItem(itemOrSystem) || !items || !itemId) return baseFootprint;
  if (memo.has(itemId)) return memo.get(itemId);
  if (visiting.has(itemId)) return baseFootprint;

  visiting.add(itemId);

  let occupiedColumns = 0;
  let occupiedRows = 0;
  for (const item of getContainerContents(itemId, items)) {
    const placement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, items, memo, visiting);
    occupiedColumns = Math.max(occupiedColumns, placement.x + placement.width - 1);
    occupiedRows = Math.max(occupiedRows, placement.y + placement.height - 1);
  }

  visiting.delete(itemId);
  const footprint = {
    width: Math.max(baseFootprint.width, occupiedColumns),
    height: Math.max(baseFootprint.height, occupiedRows)
  };
  memo.set(itemId, footprint);
  return footprint;
}

export function createInventoryPlacement(x = 1, y = 1, itemOrSystem = null, items = null) {
  const { width, height } = items ? getItemFootprint(itemOrSystem, items) : getItemEffectiveBaseFootprint(itemOrSystem);
  return {
    mode: "inventory",
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    limbKey: "",
    x: Math.max(1, toInteger(x)),
    y: Math.max(1, toInteger(y)),
    width,
    height,
    rotated: Boolean(getItemSystem(itemOrSystem)?.placement?.rotated)
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
    : getItemEffectiveBaseFootprint(itemOrSystem);
  const hasItem = Boolean(itemOrSystem);

  return {
    ...basePlacement,
    mode: String(placement?.mode ?? "inventory"),
    equipmentSlot: String(placement?.equipmentSlot ?? ""),
    weaponSet: String(placement?.weaponSet ?? ""),
    weaponSlot: String(placement?.weaponSlot ?? ""),
    limbKey: String(placement?.limbKey ?? ""),
    rotated: Boolean(placement?.rotated ?? getItemSystem(itemOrSystem)?.placement?.rotated),
    width: hasItem
      ? effectiveFootprint.width
      : Math.max(1, toInteger(placement?.width) || effectiveFootprint.width),
    height: hasItem
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
    limbKey: String(placement?.limbKey ?? ""),
    constructPartOrder: Math.max(0, toInteger(placement?.constructPartOrder)),
    x: Math.max(1, toInteger(placement?.x)),
    y: Math.max(1, toInteger(placement?.y)),
    width: baseFootprint.width,
    height: baseFootprint.height,
    rotated: Boolean(placement?.rotated ?? getItemSystem(itemOrSystem)?.placement?.rotated)
  };
}

export function isInventoryPlacementWithinBounds(placement, columns, rows, { allowOverflowRows = false, zones = [] } = {}) {
  if (!placement) return false;
  const withinRect = (
    placement.x >= 1
    && placement.y >= 1
    && (placement.x + placement.width - 1) <= columns
    && (allowOverflowRows || (placement.y + placement.height - 1) <= rows)
  );
  if (!withinRect) return false;
  if (allowOverflowRows || !Array.isArray(zones) || !zones.length) return true;
  return zones.some(zone => placementFitsInventoryZone(placement, zone));
}

function placementFitsInventoryZone(placement, zone) {
  if (!placement || !zone) return false;
  return (
    placement.x >= zone.x
    && placement.y >= zone.y
    && (placement.x + placement.width - 1) <= (zone.x + zone.width - 1)
    && (placement.y + placement.height - 1) <= (zone.y + zone.height - 1)
  );
}

function getInventoryPlacementPriorityZones(zones = [], itemOrSystem = null, allItems = []) {
  if (!Array.isArray(zones) || !zones.length) return [];
  const footprint = getItemFootprint(itemOrSystem, allItems);
  return zones
    .map(zone => ({
      id: String(zone.id ?? ""),
      x: Math.max(1, toInteger(zone.x) || 1),
      y: Math.max(1, toInteger(zone.y) || 1),
      width: Math.max(1, toInteger(zone.width) || 1),
      height: Math.max(1, toInteger(zone.height) || 1),
      base: Boolean(zone.base)
    }))
    .filter(zone => footprint.width <= zone.width && footprint.height <= zone.height)
    .sort((left, right) => {
      const areaDifference = (left.width * left.height) - (right.width * right.height);
      if (areaDifference !== 0) return areaDifference;
      const baseDifference = Number(left.base) - Number(right.base);
      if (baseDifference !== 0) return baseDifference;
      const yDifference = left.y - right.y;
      if (yDifference !== 0) return yDifference;
      return left.x - right.x;
    });
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
  if (String(parentId ?? ROOT_CONTAINER_ID) === LOCKED_STORAGE_PARENT_ID) {
    return getItemsArray(items).filter(item => {
      if (!isInventoryManagedItem(item)) return false;
      return isItemInLockedStorage(item);
    });
  }
  if (String(parentId ?? ROOT_CONTAINER_ID) === BUTCHERING_STORAGE_PARENT_ID) {
    return getItemsArray(items).filter(item => {
      if (!isInventoryManagedItem(item)) return false;
      return isItemInButcheringStorage(item);
    });
  }

  return getItemsArray(items).filter(item => {
    if (!isInventoryManagedItem(item)) return false;
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
  reservedPlacements = [],
  options = {}
) {
  // #region agent log
  if (_agentPerf) _agentPerf.availabilityChecks = (_agentPerf.availabilityChecks ?? 0) + 1;
  // #endregion
  if (!isInventoryPlacementWithinBounds(placement, columns, rows, options)) return false;
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  if (reservedPlacements.some(existing => inventoryPlacementsOverlap(placement, existing))) return false;

  const contextItemsArray = getItemsArray(contextItems);
  const hasUnpositionedVirtualPart = contextItemsArray.some(usesVirtualInventoryStacks)
    && createInventoryPlacementItems(contextItemsArray, allItems)
      .some(item => item._stackHasStoredPlacement === false);
  if (
    !options.skipResolvedContext
    && (options.allowResolvedAvailability || hasUnpositionedVirtualPart)
    && contextItemsArray.some(usesVirtualInventoryStacks)
  ) {
    // #region agent log
    if (_agentPerf) _agentPerf.resolvePathChecks = (_agentPerf.resolvePathChecks ?? 0) + 1;
    // #endregion
    const resolved = resolveInventoryGridPlacements(
      contextItemsArray.filter(item => !excluded.has(getItemId(item))),
      columns,
      rows,
      allItems,
      { ...options, skipResolvedContext: true }
    );
    if (!resolved) return false;
    const available = !resolved.items.some(entry => inventoryPlacementsOverlap(placement, entry.placement));
    return available;
  }

  const placementMode = String(options.placementMode ?? placement?.mode ?? "inventory");
  return !createInventoryPlacementItems(getItemsArray(contextItems), allItems).some(item => {
    if (!item || excluded.has(getItemId(item))) return false;
    if (item._stackHasStoredPlacement === false) return true;
    const itemPlacement = normalizeInventoryPlacement(item.system?.placement ?? item.placement ?? {}, item, allItems);
    return itemPlacement.mode === placementMode && inventoryPlacementsOverlap(placement, itemPlacement);
  });
}

const _hoverPlacementCheckerCache = new Map();

export function resetInventoryHoverCheckerCache() {
  _hoverPlacementCheckerCache.clear();
}

export function createInventoryHoverPlacementChecker(
  contextItems,
  columns,
  rows,
  allItems = contextItems,
  excludeItemIds = [],
  options = {},
  parentId = ROOT_CONTAINER_ID
) {
  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds.filter(Boolean) : []);
  const cacheKey = [
    String(parentId ?? ROOT_CONTAINER_ID),
    columns,
    rows,
    String(options.placementMode ?? ""),
    Boolean(options.allowOverflowRows),
    getInventoryZoneCacheKey(options.zones),
    excluded.size ? [...excluded].sort().join(",") : "",
    getItemsArray(contextItems).length
  ].join("|");
  const cached = _hoverPlacementCheckerCache.get(cacheKey);
  if (cached) return cached;

  // #region agent log
  const _t0 = performance.now();
  // #endregion
  const filtered = getItemsArray(contextItems).filter(item => !excluded.has(getItemId(item)));
  const resolved = resolveInventoryGridPlacements(filtered, columns, rows, allItems, options);
  const occupied = resolved?.items?.filter(entry => !entry.phantom).map(entry => entry.placement) ?? [];
  const checker = placement => {
    if (!placement) return false;
    if (!isInventoryPlacementWithinBounds(placement, columns, rows, options)) return false;
    return !occupied.some(existing => inventoryPlacementsOverlap(placement, existing));
  };
  _hoverPlacementCheckerCache.set(cacheKey, checker);
  // #region agent log
  _agentLog('G', 'inventory-containers.mjs:createInventoryHoverPlacementChecker', 'hover checker built', {
    ms: Math.round(performance.now() - _t0),
    contextItems: filtered.length,
    occupied: occupied.length,
    columns,
    rows,
    cacheMiss: true
  });
  // #endregion
  return checker;
}

export function findFirstAvailableInventoryPlacement(
  contextItems,
  columns,
  rows,
  itemOrSystem = null,
  allItems = contextItems,
  excludeItemIds = [],
  reservedPlacements = [],
  options = {}
) {
  // #region agent log
  const _t0 = performance.now();
  const _prev = _agentPerf;
  _agentPerf = { availabilityChecks: 0, resolvePathChecks: 0, resolveCalls: 0, resolveMs: 0 };
  // #endregion
  // Resolve occupancy once, then scan — avoids O(cells × visualStacks) rebuilds on large inventories.
  const result = findFirstAvailableResolvedInventoryPlacement(
    contextItems,
    columns,
    rows,
    itemOrSystem,
    allItems,
    excludeItemIds,
    reservedPlacements,
    options
  );
  // #region agent log
  const stats = _agentPerf;
  _agentPerf = _prev;
  _agentLog('A', 'inventory-containers.mjs:findFirstAvailableInventoryPlacement', 'auto-place call', {
    ms: Math.round(performance.now() - _t0),
    columns,
    rows,
    contextItems: getItemsArray(contextItems).length,
    allItems: getItemsArray(allItems).length,
    allowOverflowRows: Boolean(options.allowOverflowRows),
    found: Boolean(result),
    foundAt: result ? { x: result.x, y: result.y } : null,
    ...stats
  });
  // #endregion
  return result;
}

function findFirstAvailableInventoryPlacementByZonePriority(
  contextItems,
  columns,
  rows,
  itemOrSystem = null,
  allItems = contextItems,
  excludeItemIds = [],
  reservedPlacements = [],
  options = {}
) {
  const zones = getInventoryPlacementPriorityZones(options.zones, itemOrSystem, allItems);
  if (!zones.length) return null;

  const seen = new Set();
  for (const zone of zones) {
    const maxX = zone.x + zone.width - Math.max(1, toInteger(getItemFootprint(itemOrSystem, allItems).width) || 1);
    const maxY = zone.y + zone.height - Math.max(1, toInteger(getItemFootprint(itemOrSystem, allItems).height) || 1);
    for (let y = zone.y; y <= maxY; y += 1) {
      for (let x = zone.x; x <= maxX; x += 1) {
        const key = getInventoryCellKey(x, y);
        if (seen.has(key)) continue;
        seen.add(key);
        const candidate = createInventoryPlacement(x, y, itemOrSystem, allItems);
        if (!placementFitsInventoryZone(candidate, zone)) continue;
        if (isInventoryPlacementAvailable(candidate, contextItems, columns, rows, allItems, excludeItemIds, reservedPlacements, options)) {
          return candidate;
        }
      }
    }
  }

  return null;
}

export function findFirstAvailableResolvedInventoryPlacement(
  contextItems,
  columns,
  rows,
  itemOrSystem = null,
  allItems = contextItems,
  excludeItemIds = [],
  reservedPlacements = [],
  options = {}
) {
  columns = Math.max(1, toInteger(columns) || 1);
  rows = Math.max(1, toInteger(rows) || 1);

  const excluded = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : [excludeItemIds]);
  const visibleContextItems = getItemsArray(contextItems).filter(item => !excluded.has(getItemId(item)));
  const resolved = resolveInventoryGridPlacements(visibleContextItems, columns, rows, allItems, options);
  if (!resolved) return null;

  const occupiedPlacements = resolved.items
    .filter(entry => !entry.phantom)
    .map(entry => entry.placement);

  const prioritizedPlacement = findFirstAvailableResolvedInventoryPlacementByZonePriority(
    occupiedPlacements,
    columns,
    rows,
    itemOrSystem,
    allItems,
    reservedPlacements,
    options
  );
  if (prioritizedPlacement) return prioritizedPlacement;

  const searchRows = getInventoryPlacementSearchRows(rows, itemOrSystem, allItems, contextItems, reservedPlacements, options);
  for (let y = 1; y <= searchRows; y += 1) {
    for (let x = 1; x <= columns; x += 1) {
      const candidate = createInventoryPlacement(x, y, itemOrSystem, allItems);
      if (!isInventoryPlacementWithinBounds(candidate, columns, rows, options)) continue;
      if (reservedPlacements.some(existing => inventoryPlacementsOverlap(candidate, existing))) continue;
      if (occupiedPlacements.some(existing => inventoryPlacementsOverlap(candidate, existing))) continue;
      return candidate;
    }
  }

  return null;
}

function findFirstAvailableResolvedInventoryPlacementByZonePriority(
  occupiedPlacements,
  columns,
  rows,
  itemOrSystem = null,
  allItems = [],
  reservedPlacements = [],
  options = {}
) {
  const zones = getInventoryPlacementPriorityZones(options.zones, itemOrSystem, allItems);
  if (!zones.length) return null;

  const seen = new Set();
  for (const zone of zones) {
    const footprint = getItemFootprint(itemOrSystem, allItems);
    const maxX = zone.x + zone.width - footprint.width;
    const maxY = zone.y + zone.height - footprint.height;
    for (let y = zone.y; y <= maxY; y += 1) {
      for (let x = zone.x; x <= maxX; x += 1) {
        const key = getInventoryCellKey(x, y);
        if (seen.has(key)) continue;
        seen.add(key);
        const candidate = createInventoryPlacement(x, y, itemOrSystem, allItems);
        if (!placementFitsInventoryZone(candidate, zone)) continue;
        if (!isInventoryPlacementWithinBounds(candidate, columns, rows, options)) continue;
        if (reservedPlacements.some(existing => inventoryPlacementsOverlap(candidate, existing))) continue;
        if (occupiedPlacements.some(existing => inventoryPlacementsOverlap(candidate, existing))) continue;
        return candidate;
      }
    }
  }

  return null;
}

export function buildInventoryCellStyle(x, y, placement = null) {
  if (placement) {
    const width = Math.max(1, toInteger(placement.width) || 1);
    const height = Math.max(1, toInteger(placement.height) || 1);
    return [
      `grid-column: ${placement.x} / span ${placement.width};`,
      `grid-row: ${placement.y} / span ${placement.height};`,
      `--fallout-maw-inventory-item-columns: ${width};`,
      `--fallout-maw-inventory-item-rows: ${height};`,
      `--fallout-maw-inventory-rotated-image-width: ${buildInventorySpanLengthStyle(height)};`,
      `--fallout-maw-inventory-rotated-image-height: ${buildInventorySpanLengthStyle(width)};`
    ].join(" ");
  }
  return `grid-column: ${x}; grid-row: ${y};`;
}

export function buildInventoryGridStyle(columns, rows, { baseColumns = columns, baseRows = rows } = {}) {
  columns = Math.max(1, toInteger(columns) || 1);
  rows = Math.max(1, toInteger(rows) || 1);
  baseColumns = Math.max(1, toInteger(baseColumns) || columns);
  baseRows = Math.max(1, toInteger(baseRows) || rows);
  return [
    `--fallout-maw-inventory-columns: ${columns};`,
    `--fallout-maw-inventory-rows: ${rows};`,
    `--fallout-maw-inventory-base-columns: ${baseColumns};`,
    `--fallout-maw-inventory-base-rows: ${baseRows};`
  ].join(" ");
}

export function buildInventoryGridZoneStyle(zone = {}) {
  return [
    `grid-column: ${Math.max(1, toInteger(zone.x) || 1)} / span ${Math.max(1, toInteger(zone.width) || 1)};`,
    `grid-row: ${Math.max(1, toInteger(zone.y) || 1)} / span ${Math.max(1, toInteger(zone.height) || 1)};`
  ].join(" ");
}

function buildInventorySpanLengthStyle(span) {
  span = Math.max(1, toInteger(span) || 1);
  const cells = Array.from({ length: span }, () => "var(--fallout-maw-inventory-cell-size)");
  const gaps = Array.from({ length: Math.max(0, span - 1) }, () => "var(--fallout-maw-inventory-grid-gap)");
  return `calc(${[...cells, ...gaps].join(" + ")} - 0.4rem)`;
}

export function prepareInventoryGridContext(contextItems, columns, rows, allItems, mapItem, options = {}) {
  const resolved = resolveInventoryGridPlacements(contextItems, columns, rows, allItems, options);
  const reservedPlacements = resolved.placements;
  const placedItems = [];
  const zones = prepareInventoryGridZones(options.zones);
  const baseColumns = Math.max(1, toInteger(options.baseColumns) || columns);
  const baseRows = Math.max(1, toInteger(options.baseRows) || rows);

  for (const entry of resolved.items) {
    placedItems.push({
      ...mapItem(entry.item, entry.placement, { phantom: entry.phantom }),
      phantom: entry.phantom
    });
  }

  const cells = [];
  if (options.includeCells) {
    const occupiedCells = createOccupiedInventoryCellSet(reservedPlacements);
    for (let y = 1; y <= resolved.rows; y += 1) {
      for (let x = 1; x <= resolved.columns; x += 1) {
        const phantom = !options.allowOverflowRows && (y > rows || x > columns);
        cells.push({
          x,
          y,
          phantom,
          occupied: occupiedCells.has(getInventoryCellKey(x, y)),
          style: buildInventoryCellStyle(x, y)
        });
      }
    }
  }

  return {
    columns: resolved.columns,
    rows: resolved.rows,
    baseColumns,
    baseRows,
    style: buildInventoryGridStyle(resolved.columns, resolved.rows, { baseColumns, baseRows }),
    hasZones: zones.length > 0,
    zones,
    hasPhantomItems: resolved.items.some(item => item.phantom),
    cells,
    items: placedItems
  };
}

function prepareInventoryGridZones(zones = []) {
  if (!Array.isArray(zones) || !zones.length) return [];
  return zones.map(zone => ({
    id: String(zone.id ?? ""),
    x: Math.max(1, toInteger(zone.x) || 1),
    y: Math.max(1, toInteger(zone.y) || 1),
    width: Math.max(1, toInteger(zone.width) || 1),
    height: Math.max(1, toInteger(zone.height) || 1),
    base: Boolean(zone.base),
    style: buildInventoryGridZoneStyle(zone)
  }));
}

function getInventoryZoneCacheKey(zones = []) {
  if (!Array.isArray(zones) || !zones.length) return "";
  return zones
    .map(zone => [
      String(zone.id ?? ""),
      toInteger(zone.x),
      toInteger(zone.y),
      toInteger(zone.width),
      toInteger(zone.height),
      Boolean(zone.base) ? 1 : 0
    ].join(":"))
    .join(",");
}

function createOccupiedInventoryCellSet(placements = []) {
  const cells = new Set();
  for (const placement of placements) {
    if (!placement) continue;
    addInventoryPlacementCells(cells, placement);
  }
  return cells;
}

function addInventoryPlacementCells(cells, placement) {
  if (!cells || !placement) return;
  for (let y = placement.y; y < (placement.y + placement.height); y += 1) {
    for (let x = placement.x; x < (placement.x + placement.width); x += 1) {
      cells.add(getInventoryCellKey(x, y));
    }
  }
}

function isInventoryPlacementCellSetAvailable(placement, occupiedCells) {
  if (!placement || !occupiedCells) return false;
  for (let y = placement.y; y < (placement.y + placement.height); y += 1) {
    for (let x = placement.x; x < (placement.x + placement.width); x += 1) {
      if (occupiedCells.has(getInventoryCellKey(x, y))) return false;
    }
  }
  return true;
}

function getInventoryCellKey(x, y) {
  return `${x}:${y}`;
}

export function validateInventoryTree(items, rootDimensions, options = {}) {
  // #region agent log
  const _t0 = performance.now();
  // #endregion
  const itemsArray = getItemsArray(items).filter(isInventoryManagedItem);
  const itemMap = new Map(itemsArray.map(item => [getItemId(item), item]));
  const contextItemsByParent = buildInventoryContextItemsByParent(itemsArray);
  const contentsWeightMemo = new Map();

  for (const item of itemsArray) {
    const itemId = getItemId(item);
    const parentId = getItemContainerParentId(item);
    if (!parentId) continue;

    if (parentId === itemId || hasContainerCycleInMap(itemId, parentId, itemMap)) {
      // #region agent log
      _agentLog('F', 'inventory-containers.mjs:validateInventoryTree', 'validate failed early', { ms: Math.round(performance.now()-_t0), reason: 'recursive', itemCount: itemsArray.length });
      // #endregion
      return { valid: false, reason: "recursive", itemId, parentId };
    }

    const parent = itemMap.get(parentId);
    if (!parent || !isContainerItem(parent)) {
      // #region agent log
      _agentLog('F', 'inventory-containers.mjs:validateInventoryTree', 'validate failed early', { ms: Math.round(performance.now()-_t0), reason: 'invalid-parent', itemCount: itemsArray.length });
      // #endregion
      return { valid: false, reason: "invalid-parent", itemId, parentId };
    }

    if (String(item.system?.placement?.mode ?? "inventory") !== "inventory") {
      // #region agent log
      _agentLog('F', 'inventory-containers.mjs:validateInventoryTree', 'validate failed early', { ms: Math.round(performance.now()-_t0), reason: 'invalid-placement', itemCount: itemsArray.length });
      // #endregion
      return { valid: false, reason: "invalid-placement", itemId, parentId };
    }
  }

  const rootItems = contextItemsByParent.get(ROOT_CONTAINER_ID) ?? [];
  const rootOptions = options.rootOptions ?? {
    allowOverflowRows: Boolean(rootDimensions?.allowOverflowRows),
    extraRows: 0
  };
  if (!validateContextPlacements(rootItems, rootDimensions.columns, rootDimensions.rows, itemsArray, rootOptions)) {
    // #region agent log
    _agentLog('F', 'inventory-containers.mjs:validateInventoryTree', 'validate failed root', { ms: Math.round(performance.now()-_t0), reason: 'no-space', itemCount: itemsArray.length, rootItems: rootItems.length });
    // #endregion
    return { valid: false, reason: "no-space", parentId: ROOT_CONTAINER_ID };
  }

  for (const container of itemsArray) {
    if (!isContainerItem(container)) continue;
    const gridOptions = getContainerInventoryGridOptions(container);
    const contents = contextItemsByParent.get(container.id) ?? [];
    if (!validateContextPlacements(contents, gridOptions.columns, gridOptions.rows, itemsArray, gridOptions)) {
      // #region agent log
      _agentLog('F', 'inventory-containers.mjs:validateInventoryTree', 'validate failed container', { ms: Math.round(performance.now()-_t0), reason: 'no-space', itemCount: itemsArray.length, parentId: container.id });
      // #endregion
      return { valid: false, reason: "no-space", parentId: container.id, itemId: container.id };
    }

    if (getContainerContentsWeight(container, itemsArray, contentsWeightMemo) > getContainerMaxLoad(container)) {
      // #region agent log
      _agentLog('F', 'inventory-containers.mjs:validateInventoryTree', 'validate failed max-load', { ms: Math.round(performance.now()-_t0), itemCount: itemsArray.length, parentId: container.id });
      // #endregion
      return { valid: false, reason: "max-load", parentId: container.id, itemId: container.id };
    }
  }

  // #region agent log
  const _ms = Math.round(performance.now() - _t0);
  if (_ms >= 5) _agentLog('F', 'inventory-containers.mjs:validateInventoryTree', 'validate ok', { ms: _ms, itemCount: itemsArray.length, rootItems: rootItems.length });
  // #endregion
  return { valid: true };
}

function isInventoryManagedItem(itemOrSystem = null) {
  const type = getItemType(itemOrSystem);
  return !["ability", "trauma", "disease"].includes(type);
}

function validateContextPlacements(contextItems, columns, rows, allItems, options = {}) {
  if (validateStoredContextPlacements(contextItems, columns, rows, allItems, options)) return true;
  if (!options.allowResolvedValidationFallback) return false;
  const resolved = resolveInventoryGridPlacements(contextItems, columns, rows, allItems, options);
  return Boolean(resolved);
}

export function createInventoryTreePlacementRepairUpdates(items, rootDimensions, options = {}) {
  const itemsArray = getItemsArray(items).filter(isInventoryManagedItem);
  const contextItemsByParent = buildInventoryContextItemsByParent(itemsArray);
  const updates = [];

  const rootItems = contextItemsByParent.get(ROOT_CONTAINER_ID) ?? [];
  const rootUpdates = createContextPlacementRepairUpdates(
    rootItems,
    rootDimensions.columns,
    rootDimensions.rows,
    itemsArray,
    options.rootOptions ?? {
      allowOverflowRows: Boolean(rootDimensions?.allowOverflowRows),
      extraRows: 0
    }
  );
  if (!rootUpdates) return null;
  updates.push(...rootUpdates);

  for (const container of itemsArray) {
    if (!isContainerItem(container)) continue;
    const gridOptions = getContainerInventoryGridOptions(container);
    const contents = contextItemsByParent.get(container.id) ?? [];
    const containerUpdates = createContextPlacementRepairUpdates(contents, gridOptions.columns, gridOptions.rows, itemsArray, gridOptions);
    if (!containerUpdates) return null;
    updates.push(...containerUpdates);
  }

  return mergeInventoryRepairUpdates(updates);
}

function createContextPlacementRepairUpdates(contextItems, columns, rows, allItems, options = {}) {
  const storedValid = validateStoredContextPlacements(contextItems, columns, rows, allItems, options);
  const entries = storedValid
    ? createInventoryPlacementItems(contextItems, allItems).map(item => ({
      item,
      placement: normalizeInventoryPlacement(item.system?.placement ?? item.placement ?? {}, item, allItems)
    }))
    : resolveInventoryGridPlacements(contextItems, columns, rows, allItems, options)?.items;
  if (!entries) return null;

  const sourceById = new Map(getItemsArray(allItems).map(item => [getItemId(item), item]));
  const updates = new Map();
  const virtualParts = new Map();

  for (const entry of entries) {
    const itemId = getItemId(entry.item);
    if (!itemId || String(itemId).startsWith("synthetic-")) continue;
    const source = sourceById.get(itemId) ?? entry.item;
    if (usesVirtualInventoryStacks(source)) {
      const parts = virtualParts.get(itemId) ?? [];
      parts.push({
        index: Math.max(0, toInteger(entry.item?._stackIndex)),
        quantity: Math.max(1, toInteger(entry.item?._stackQuantity) || getItemQuantity(entry.item)),
        x: Math.max(1, toInteger(entry.placement?.x)),
        y: Math.max(1, toInteger(entry.placement?.y)),
        rotated: Boolean(entry.placement?.rotated)
      });
      virtualParts.set(itemId, parts);
      continue;
    }

    const currentPlacement = normalizeInventoryPlacement(source.system?.placement ?? {}, source, allItems);
    if (!inventoryPlacementsEqual(currentPlacement, entry.placement)) {
      const storedPlacement = createStoredPlacement(entry.placement, source);
      updates.set(itemId, {
        _id: itemId,
        "system.placement.x": storedPlacement.x,
        "system.placement.y": storedPlacement.y,
        "system.placement.width": storedPlacement.width,
        "system.placement.height": storedPlacement.height,
        "system.placement.rotated": storedPlacement.rotated
      });
    }
  }

  for (const [itemId, parts] of virtualParts.entries()) {
    const source = sourceById.get(itemId);
    if (!source) continue;
    const orderedParts = parts
      .sort((left, right) => left.index - right.index)
      .map(part => ({
        quantity: part.quantity,
        x: part.x,
        y: part.y,
        rotated: part.rotated
      }));
    const currentParts = getItemStackParts(source).map(part => ({
      quantity: Math.max(1, toInteger(part.quantity)),
      x: Math.max(1, toInteger(part.x)),
      y: Math.max(1, toInteger(part.y)),
      rotated: Boolean(part.rotated)
    }));
    const primaryPart = orderedParts[0] ?? null;
    if (!primaryPart) continue;
    const needsStackUpdate = JSON.stringify(orderedParts) !== JSON.stringify(currentParts);
    const currentPlacement = source.system?.placement ?? {};
    const needsPlacementUpdate = (
      toInteger(currentPlacement.x) !== primaryPart.x
      || toInteger(currentPlacement.y) !== primaryPart.y
      || Boolean(currentPlacement.rotated) !== primaryPart.rotated
    );
    if (!needsStackUpdate && !needsPlacementUpdate) continue;
    updates.set(itemId, {
      _id: itemId,
      "system.stackParts": orderedParts,
      "system.placement.x": primaryPart.x,
      "system.placement.y": primaryPart.y,
      "system.placement.rotated": primaryPart.rotated
    });
  }

  return Array.from(updates.values());
}

function mergeInventoryRepairUpdates(updates = []) {
  const merged = new Map();
  for (const update of updates) {
    if (!update?._id) continue;
    merged.set(update._id, {
      ...(merged.get(update._id) ?? { _id: update._id }),
      ...update
    });
  }
  return Array.from(merged.values());
}

function inventoryPlacementsEqual(left, right) {
  return (
    toInteger(left?.x) === toInteger(right?.x)
    && toInteger(left?.y) === toInteger(right?.y)
    && Math.max(1, toInteger(left?.width) || 1) === Math.max(1, toInteger(right?.width) || 1)
    && Math.max(1, toInteger(left?.height) || 1) === Math.max(1, toInteger(right?.height) || 1)
    && Boolean(left?.rotated) === Boolean(right?.rotated)
  );
}

function buildInventoryContextItemsByParent(items = []) {
  const contexts = new Map();
  for (const item of getItemsArray(items)) {
    if (!isInventoryManagedItem(item)) continue;
    const placement = item.system?.placement ?? {};
    if (String(placement.mode ?? "inventory") !== "inventory") continue;
    const parentId = getItemContainerParentId(item);
    const contextItems = contexts.get(parentId) ?? [];
    contextItems.push(item);
    contexts.set(parentId, contextItems);
  }
  return contexts;
}

function hasContainerCycleInMap(itemId, parentId, itemMap) {
  if (!itemId || !parentId) return false;
  const visited = new Set();
  let currentParentId = parentId;

  while (currentParentId) {
    if (currentParentId === itemId) return true;
    if (visited.has(currentParentId)) return false;
    visited.add(currentParentId);
    currentParentId = getItemContainerParentId(itemMap.get(currentParentId));
  }

  return false;
}

function validateStoredContextPlacements(contextItems, columns, rows, allItems, options = {}) {
  columns = Math.max(1, toInteger(columns) || 1);
  rows = Math.max(1, toInteger(rows) || 1);

  const items = getItemsArray(contextItems);
  const placementMode = String(options.placementMode ?? "inventory");
  const preferredPlacementModes = new Set(options.preferredPlacementModes ?? [placementMode]);
  const placementItems = createInventoryPlacementItems(items, allItems);
  const occupiedCells = new Set();
  const footprintMemo = new Map();

  for (const item of placementItems) {
    const rawPlacement = item.system?.placement ?? item.placement ?? {};
    const rawMode = String(rawPlacement.mode ?? "inventory");
    if (!preferredPlacementModes.has(rawMode)) return false;
    if (item._stackHasStoredPlacement === false) return false;

    const placement = normalizeInventoryPlacement(rawPlacement, item, allItems, footprintMemo);
    if (!isInventoryPlacementWithinBounds(placement, columns, rows, options)) return false;

    for (let y = placement.y; y < (placement.y + placement.height); y += 1) {
      for (let x = placement.x; x < (placement.x + placement.width); x += 1) {
        const key = getInventoryCellKey(x, y);
        if (occupiedCells.has(key)) return false;
        occupiedCells.add(key);
      }
    }
  }

  return true;
}

function resolveInventoryGridPlacements(contextItems, columns, rows, allItems, options = {}) {
  // #region agent log
  const _t0 = performance.now();
  if (_agentPerf) _agentPerf.resolveCalls = (_agentPerf.resolveCalls ?? 0) + 1;
  // #endregion
  columns = Math.max(1, toInteger(columns) || 1);
  rows = Math.max(1, toInteger(rows) || 1);

  const items = createInventoryPlacementItems(getItemsArray(contextItems), allItems);
  const reservedPlacements = [];
  const occupiedCells = new Set();
  const resolvedItems = [];
  let visualColumns = columns;
  let visualRows = rows;
  const reservePlacement = (item, placement, phantom = false) => {
    reservedPlacements.push(placement);
    addInventoryPlacementCells(occupiedCells, placement);
    resolvedItems.push({ item, placement, phantom });
    visualColumns = Math.max(visualColumns, placement.x + placement.width - 1);
    visualRows = Math.max(visualRows, placement.y + placement.height - 1);
  };
  const preferredPlacementModes = new Set(options.preferredPlacementModes ?? [String(options.placementMode ?? "inventory")]);
  const preferredItems = items
    .filter(item => item._stackHasStoredPlacement !== false && preferredPlacementModes.has(String(item.system?.placement?.mode ?? "inventory")))
    .sort((left, right) => {
      const leftPlacement = left.system?.placement ?? {};
      const rightPlacement = right.system?.placement ?? {};
      const yDifference = toInteger(leftPlacement.y) - toInteger(rightPlacement.y);
      if (yDifference !== 0) return yDifference;
      return toInteger(leftPlacement.x) - toInteger(rightPlacement.x);
    });
  const preferredItemSet = new Set(preferredItems);
  const deferredItems = items.filter(item => !preferredItemSet.has(item));
  const unresolvedItems = [];
  const autoPlacementCursor = { x: 1, y: 1 };

  for (const item of preferredItems) {
    const preferredPlacement = normalizeInventoryPlacement(item.system?.placement ?? {}, item, allItems);
    if (isInventoryPlacementAvailable(preferredPlacement, [], columns, rows, allItems, [], reservedPlacements, { ...options, skipResolvedContext: true })) {
      reservePlacement(item, preferredPlacement, false);
      continue;
    }
    unresolvedItems.push(item);
  }

  for (const item of [...unresolvedItems, ...deferredItems]) {
    let phantom = false;
    let placement = findFirstAvailableInventoryPlacementFromOccupied(
      occupiedCells,
      columns,
      rows,
      item,
      allItems,
      options,
      autoPlacementCursor
    );
    if (!placement) {
      placement = findFirstPhantomInventoryPlacement(item, allItems, columns, rows, reservedPlacements);
      phantom = true;
    }
    if (!placement) return null;
    autoPlacementCursor.x = placement.x;
    autoPlacementCursor.y = placement.y;
    reservePlacement(item, placement, phantom);
  }

  if (options.compactVerticalOffset && resolvedItems.length) {
    const minY = resolvedItems.reduce((min, entry) => Math.min(min, toInteger(entry.placement?.y) || 1), Number.POSITIVE_INFINITY);
    const offset = Math.max(0, minY - 1);
    if (offset > 0) {
      for (const placement of reservedPlacements) placement.y = Math.max(1, placement.y - offset);
      visualRows = reservedPlacements.reduce(
        (max, placement) => Math.max(max, placement.y + placement.height - 1),
        rows
      );
    }
  }

  const extraRows = options.allowOverflowRows ? Math.max(0, toInteger(options.extraRows)) : 0;
  const overflowRows = options.compactRows ? Math.max(1, visualRows) : Math.max(rows, visualRows);
  // #region agent log
  const _ms = performance.now() - _t0;
  if (_agentPerf) _agentPerf.resolveMs = (_agentPerf.resolveMs ?? 0) + _ms;
  if (_ms >= 10 || _agentPerf) {
    _agentLog('B', 'inventory-containers.mjs:resolveInventoryGridPlacements', 'resolve placements', {
      ms: Math.round(_ms),
      contextItems: getItemsArray(contextItems).length,
      visualItems: items.length,
      preferred: preferredItems.length,
      deferred: deferredItems.length,
      columns,
      rows,
      insideAutoFind: Boolean(_agentPerf)
    });
  }
  // #endregion
  return {
    columns: visualColumns,
    rows: options.allowOverflowRows ? overflowRows + extraRows : visualRows,
    placements: reservedPlacements,
    items: resolvedItems
  };
}

function getInventoryPlacementSearchRows(rows, itemOrSystem, allItems, contextItems = [], reservedPlacements = [], options = {}) {
  rows = Math.max(1, toInteger(rows) || 1);
  if (!options.allowOverflowRows) return rows;
  const footprint = getItemFootprint(itemOrSystem, allItems);
  const existingRows = [
    ...createInventoryPlacementItems(getItemsArray(contextItems), allItems)
      .filter(item => item._stackHasStoredPlacement !== false)
      .map(item => normalizeInventoryPlacement(item.system?.placement ?? item.placement ?? {}, item, allItems)),
    ...reservedPlacements
  ].reduce((max, placement) => Math.max(max, toInteger(placement?.y) + Math.max(1, toInteger(placement?.height)) - 1), rows);
  const growthRows = Math.max(64, (getItemsArray(contextItems).length + reservedPlacements.length + 1) * Math.max(1, footprint.height + 1));
  return Math.max(rows, existingRows) + growthRows;
}

function findFirstAvailableInventoryPlacementFromOccupied(
  occupiedCells,
  columns,
  rows,
  itemOrSystem = null,
  allItems = [],
  options = {},
  cursor = { x: 1, y: 1 }
) {
  columns = Math.max(1, toInteger(columns) || 1);
  rows = Math.max(1, toInteger(rows) || 1);
  const footprint = getItemFootprint(itemOrSystem, allItems);
  const maxX = Math.max(1, columns - footprint.width + 1);
  const searchRows = options.allowOverflowRows
    ? rows + Math.max(64, (occupiedCells?.size ?? 0) + footprint.height + 1)
    : rows;
  let startY = Math.max(1, toInteger(cursor?.y) || 1);
  let startX = Math.max(1, Math.min(maxX, toInteger(cursor?.x) || 1));

  const zones = getInventoryPlacementPriorityZones(options.zones, itemOrSystem, allItems);
  if (zones.length) {
    const seen = new Set();
    for (const zone of zones) {
      const zoneMaxX = zone.x + zone.width - footprint.width;
      const zoneMaxY = zone.y + zone.height - footprint.height;
      for (let y = zone.y; y <= zoneMaxY; y += 1) {
        for (let x = zone.x; x <= zoneMaxX; x += 1) {
          const key = getInventoryCellKey(x, y);
          if (seen.has(key)) continue;
          seen.add(key);
          const placement = createInventoryPlacement(x, y, itemOrSystem, allItems);
          if (!placementFitsInventoryZone(placement, zone)) continue;
          if (!isInventoryPlacementWithinBounds(placement, columns, rows, options)) continue;
          if (!isInventoryPlacementCellSetAvailable(placement, occupiedCells)) continue;
          return placement;
        }
      }
    }
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const fromY = pass === 0 ? startY : 1;
    const toY = pass === 0 ? searchRows : Math.max(0, startY - 1);
    for (let y = fromY; y <= toY; y += 1) {
      const fromX = pass === 0 && y === startY ? startX : 1;
      for (let x = fromX; x <= maxX; x += 1) {
        const placement = createInventoryPlacement(x, y, itemOrSystem, allItems);
        if (!isInventoryPlacementWithinBounds(placement, columns, rows, options)) continue;
        if (!isInventoryPlacementCellSetAvailable(placement, occupiedCells)) continue;
        return placement;
      }
    }
  }

  return null;
}

function createInventoryPlacementItems(items = [], allItems = items) {
  return getItemsArray(items).flatMap(item => {
    if (!usesVirtualInventoryStacks(item)) return [item];
    const parts = getItemStackParts(item);
    if (parts.length <= 1) return [createInventoryStackVisualItem(item, parts[0] ?? { quantity: getItemQuantity(item) }, 0, true)];
    return parts.map((part, index) => createInventoryStackVisualItem(item, part, index, index === 0));
  });
}

function createInventoryStackVisualItem(item, part = {}, stackIndex = 0, useItemPlacementFallback = false) {
  const data = typeof item?.toObject === "function"
    ? item.toObject()
    : foundry.utils.deepClone(item ?? {});
  const placement = foundry.utils.deepClone(data.system?.placement ?? {});
  const hasPartPlacement = toInteger(part?.x) > 0 && toInteger(part?.y) > 0;
  if (hasPartPlacement) {
    placement.x = toInteger(part.x);
    placement.y = toInteger(part.y);
    if (part.rotated !== undefined && part.rotated !== null) placement.rotated = Boolean(part.rotated);
  } else if (!useItemPlacementFallback) {
    placement.x = 0;
    placement.y = 0;
  }

  foundry.utils.setProperty(data, "system.quantity", Math.max(1, toInteger(part?.quantity) || getItemQuantity(item)));
  foundry.utils.setProperty(data, "system.placement", placement);
  data.id = getItemId(item);
  data._id = getItemId(item);
  data._stackIndex = stackIndex;
  data._stackQuantity = Math.max(1, toInteger(part?.quantity) || getItemQuantity(item));
  data._stackVisualId = `${getItemId(item)}:${stackIndex}`;
  data._stackHasStoredPlacement = hasPartPlacement || useItemPlacementFallback;
  return data;
}

function findFirstPhantomInventoryPlacement(itemOrSystem, allItems, columns, rows, reservedPlacements = []) {
  const footprint = getItemFootprint(itemOrSystem, allItems);
  const visualColumns = Math.max(1, columns, footprint.width);
  const maxY = rows + Math.max(64, (reservedPlacements.length + 1) * Math.max(1, footprint.height + 1));

  for (let y = rows + 1; y <= maxY; y += 1) {
    for (let x = 1; x <= (visualColumns - footprint.width + 1); x += 1) {
      const candidate = {
        mode: "inventory",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        limbKey: "",
        x,
        y,
        width: footprint.width,
        height: footprint.height,
        rotated: Boolean(getItemSystem(itemOrSystem)?.placement?.rotated)
      };
      if (!reservedPlacements.some(existing => inventoryPlacementsOverlap(candidate, existing))) return candidate;
    }
  }

  return {
    mode: "inventory",
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    x: 1,
    y: maxY + 1,
    width: footprint.width,
    height: footprint.height,
    rotated: Boolean(getItemSystem(itemOrSystem)?.placement?.rotated)
  };
}
