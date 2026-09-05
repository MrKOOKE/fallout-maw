import {
  BUTCHERING_STORAGE_PARENT_ID,
  BUTCHERING_STORAGE_PLACEMENT_MODE,
  createItemStackPartsForQuantity,
  createStoredPlacement,
  getContainerContentsWeight,
  getContainerDimensions,
  getContainerInventoryGridOptions,
  getContainerMaxLoad,
  getItemBaseFootprint,
  getItemContainerParentId,
  getItemFootprint,
  getItemId,
  getItemLockedStateForPlacementTransition,
  getItemQuantity,
  getItemStackParts,
  getItemSystem,
  getItemType,
  getItemsArray,
  inventoryPlacementsOverlap,
  isContainerItem,
  isInventoryPlacementWithinBounds,
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  ROOT_CONTAINER_ID,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import {
  getRequiredEquipmentSlotsForItem,
  getRequiredWeaponSlotsForItem,
  getWeaponSlotRequirement,
  getWeaponSlotRequirementSize
} from "../utils/equipment-slots.mjs";
import {
  getConstructPartSlotId,
  isInstalledConstructPartItem
} from "../utils/construct-parts.mjs";
import {
  ITEM_FUNCTIONS,
  hasItemFunction
} from "../utils/item-functions.mjs";
import {
  getNaturalRaceItemFlag,
  isCanonicalNaturalRaceWeaponPlacement,
  NATURAL_RACE_WEAPON_SET_KEY
} from "../races/natural-item-identity.mjs";

const INVENTORY_PLACEMENT_MODE = "inventory";
const ROOT_TARGET = "root";
const LOCKED_STORAGE_TARGET = "locked-storage";
const SLOT_FIELDS = Object.freeze([
  "equipmentSlot",
  "weaponSet",
  "weaponSlot",
  "limbKey"
]);
const KNOWN_NON_INVENTORY_PLACEMENT_MODES = new Set([
  "equipment",
  "weapon",
  "implant",
  "prosthesis",
  "constructPart"
]);
const readOnlyPlacementValidators = new WeakSet();

/**
 * Build a deterministic, side-effect-free repair plan for embedded Item data.
 *
 * `items` may be an array, a Foundry Collection, or any iterable of plain
 * objects. The returned updates are suitable for one
 * `actor.updateEmbeddedDocuments("Item", plan.updates)` call.
 *
 * LOCKED_STORAGE_PARENT_ID is a virtual UI context. Existing inventory code
 * persists ROOT_CONTAINER_ID in `system.container.parentId` and distinguishes
 * the storage through `system.placement.mode`; this planner preserves that
 * document invariant.
 */
export function planInventoryRepair(items, rootDimensions = {}, options = {}) {
  const sourceItems = getItemsArray(items)
    .filter(isInventoryManagedItem)
    .filter(item => getItemId(item));
  const readOnlyValidation = !options.isNonInventoryPlacementValid
    || readOnlyPlacementValidators.has(options.isNonInventoryPlacementValid);
  const projectedItems = sourceItems.map(item => cloneRepairProjection(item, readOnlyValidation));
  const sourceById = new Map(sourceItems.map(item => [getItemId(item), item]));
  const projectedById = new Map(projectedItems.map(item => [getItemId(item), item]));
  const sourceOrder = new Map(sourceItems.map((item, index) => [getItemId(item), index]));
  const recoveryById = new Map();
  const dimensions = normalizeGridDimensions(rootDimensions);
  const rootOptions = {
    ...(options.rootOptions ?? {}),
    allowOverflowRows: Boolean(options.rootOptions?.allowOverflowRows ?? rootDimensions?.allowOverflowRows)
  };

  const requestRecovery = (itemOrId, reason, target = ROOT_TARGET) => {
    const itemId = typeof itemOrId === "string" ? itemOrId : getItemId(itemOrId);
    if (!itemId || !projectedById.has(itemId)) return;
    const existingRecovery = recoveryById.get(itemId);
    const recovery = existingRecovery ?? {
      itemId,
      reasons: [],
      target
    };
    if (reason && !recovery.reasons.includes(reason)) recovery.reasons.push(reason);
    if (target === ROOT_TARGET) recovery.target = ROOT_TARGET;
    else if (!existingRecovery) recovery.target = LOCKED_STORAGE_TARGET;
    recoveryById.set(itemId, recovery);
  };

  identifyBrokenParentLinks(projectedItems, projectedById, requestRecovery);
  identifyContainerCycles(projectedItems, projectedById, requestRecovery);

  for (const recovery of recoveryById.values()) {
    prepareProjectedItemForContext(projectedById.get(recovery.itemId), ROOT_TARGET);
  }

  repairInvalidContainerContexts({
    projectedItems,
    projectedById,
    recoveryById,
    requestRecovery
  });

  const rootOccupied = [];
  for (const item of projectedItems) {
    const itemId = getItemId(item);
    if (recoveryById.has(itemId)) continue;
    if (getItemContainerParentId(item) !== ROOT_CONTAINER_ID) continue;
    if (getPlacementMode(item) !== INVENTORY_PLACEMENT_MODE) continue;
    if (reserveStoredItemPlacements(
      item,
      projectedItems,
      dimensions,
      rootOptions,
      INVENTORY_PLACEMENT_MODE,
      ROOT_CONTAINER_ID,
      rootOccupied
    )) continue;

    requestRecovery(itemId, "invalid-placement");
    prepareProjectedItemForContext(item, ROOT_TARGET);
  }

  for (const item of projectedItems) {
    const itemId = getItemId(item);
    if (recoveryById.has(itemId)) continue;
    if (getItemContainerParentId(item) !== ROOT_CONTAINER_ID) continue;
    const mode = getPlacementMode(item);
    if (
      mode === INVENTORY_PLACEMENT_MODE
      || mode === LOCKED_STORAGE_PLACEMENT_MODE
      || mode === BUTCHERING_STORAGE_PLACEMENT_MODE
    ) continue;
    if (KNOWN_NON_INVENTORY_PLACEMENT_MODES.has(mode)) {
      if (options.isNonInventoryPlacementValid?.(item, projectedItems) !== false) continue;
      requestRecovery(itemId, "invalid-placement");
      prepareProjectedItemForContext(item, ROOT_TARGET);
      continue;
    }
    requestRecovery(itemId, "invalid-placement");
    prepareProjectedItemForContext(item, ROOT_TARGET);
  }

  const lockedColumns = getLockedStorageColumns(projectedItems, dimensions.columns);
  const lockedDimensions = { columns: lockedColumns, rows: 1 };
  const lockedOptions = {
    allowOverflowRows: true,
    placementMode: LOCKED_STORAGE_PLACEMENT_MODE,
    preferredPlacementModes: [LOCKED_STORAGE_PLACEMENT_MODE]
  };
  const lockedOccupied = [];

  const butcheringOccupied = [];
  const butcheringOptions = {
    allowOverflowRows: true,
    placementMode: BUTCHERING_STORAGE_PLACEMENT_MODE,
    preferredPlacementModes: [BUTCHERING_STORAGE_PLACEMENT_MODE]
  };
  for (const item of projectedItems) {
    const itemId = getItemId(item);
    if (recoveryById.has(itemId)) continue;
    if (getPlacementMode(item) !== BUTCHERING_STORAGE_PLACEMENT_MODE) continue;
    if (reserveStoredItemPlacements(
      item,
      projectedItems,
      lockedDimensions,
      butcheringOptions,
      BUTCHERING_STORAGE_PLACEMENT_MODE,
      ROOT_CONTAINER_ID,
      butcheringOccupied
    )) continue;

    requestRecovery(itemId, "invalid-placement");
    prepareProjectedItemForContext(item, ROOT_TARGET);
  }

  for (const item of projectedItems) {
    const itemId = getItemId(item);
    if (recoveryById.has(itemId)) continue;
    if (getPlacementMode(item) !== LOCKED_STORAGE_PLACEMENT_MODE) continue;
    if (reserveStoredItemPlacements(
      item,
      projectedItems,
      lockedDimensions,
      lockedOptions,
      LOCKED_STORAGE_PLACEMENT_MODE,
      ROOT_CONTAINER_ID,
      lockedOccupied
    )) continue;

    requestRecovery(itemId, "invalid-placement", LOCKED_STORAGE_TARGET);
    const recovery = recoveryById.get(itemId);
    if (recovery) recovery.target = LOCKED_STORAGE_TARGET;
    prepareProjectedItemForContext(item, LOCKED_STORAGE_TARGET);
  }

  const plannedPlacements = new Map();
  const orderedRecoveries = Array.from(recoveryById.values())
    .sort((left, right) => (
      (sourceOrder.get(left.itemId) ?? Number.MAX_SAFE_INTEGER)
      - (sourceOrder.get(right.itemId) ?? Number.MAX_SAFE_INTEGER)
    ));

  for (const recovery of orderedRecoveries) {
    if (recovery.target === LOCKED_STORAGE_TARGET) continue;
    const item = projectedById.get(recovery.itemId);
    const placements = packItemIntoContext(
      item,
      projectedItems,
      dimensions,
      rootOptions,
      INVENTORY_PLACEMENT_MODE,
      rootOccupied
    );
    if (placements) {
      plannedPlacements.set(recovery.itemId, {
        placements,
        target: ROOT_TARGET
      });
      rootOccupied.push(...placements);
      continue;
    }

    recovery.target = LOCKED_STORAGE_TARGET;
    prepareProjectedItemForContext(item, LOCKED_STORAGE_TARGET);
  }

  for (const recovery of orderedRecoveries) {
    if (recovery.target !== LOCKED_STORAGE_TARGET) continue;
    const item = projectedById.get(recovery.itemId);
    const placements = packItemIntoContext(
      item,
      projectedItems,
      lockedDimensions,
      lockedOptions,
      LOCKED_STORAGE_PLACEMENT_MODE,
      lockedOccupied
    ) ?? createEmergencyLockedStoragePlacements(
      item,
      projectedItems,
      lockedOccupied,
      LOCKED_STORAGE_PLACEMENT_MODE
    );
    plannedPlacements.set(recovery.itemId, {
      placements,
      target: LOCKED_STORAGE_TARGET
    });
    lockedOccupied.push(...placements);
  }

  const updates = [];
  const repairs = [];
  for (const recovery of orderedRecoveries) {
    const source = sourceById.get(recovery.itemId);
    const planned = plannedPlacements.get(recovery.itemId);
    if (!source || !planned?.placements?.length) continue;
    const update = createRecoveryUpdate(source, planned.placements, planned.target);
    updates.push(update);
    repairs.push({
      itemId: recovery.itemId,
      reasons: [...recovery.reasons],
      targetParentId: planned.target === LOCKED_STORAGE_TARGET
        ? LOCKED_STORAGE_PARENT_ID
        : ROOT_CONTAINER_ID,
      placementMode: planned.target === LOCKED_STORAGE_TARGET
        ? LOCKED_STORAGE_PLACEMENT_MODE
        : INVENTORY_PLACEMENT_MODE
    });
  }

  return {
    updates,
    repairs,
    lockedStorage: {
      parentId: LOCKED_STORAGE_PARENT_ID,
      placementMode: LOCKED_STORAGE_PLACEMENT_MODE,
      columns: lockedColumns,
      rows: Math.max(1, getOccupiedRows(lockedOccupied))
    }
  };
}

export function createInventoryRepairUpdates(items, rootDimensions = {}, options = {}) {
  return planInventoryRepair(items, rootDimensions, options).updates;
}

/**
 * Foundry-facing adapter. Importing this module remains safe in plain Node;
 * actor-display-data is loaded only when the adapter is actually used.
 * Tests may inject its two small utilities through `actorDisplayUtilities`.
 */
export async function planActorInventoryRepair(actor, race = null, options = {}) {
  const {
    actorDisplayUtilities: injectedUtilities,
    items: explicitItems,
    rootDimensions: explicitRootDimensions,
    rootOptions: explicitRootOptions,
    isNonInventoryPlacementValid: explicitNonInventoryPlacementValidator,
    ...repairOptions
  } = options;
  const actorDisplayUtilities = injectedUtilities ?? await import("../utils/actor-display-data.mjs");
  const rootGridDimensions = explicitRootDimensions
    ?? actorDisplayUtilities.getActorInventoryGridDimensions(actor, race);
  const rootGridOptions = explicitRootOptions
    ?? actorDisplayUtilities.getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID);

  const inventoryItems = explicitItems ?? actor?.items;
  return planInventoryRepair(inventoryItems, rootGridDimensions, {
    ...repairOptions,
    rootOptions: rootGridOptions,
    isNonInventoryPlacementValid: explicitNonInventoryPlacementValidator
      ?? createActorNonInventoryPlacementValidator(actor, race, inventoryItems)
  });
}

/**
 * Validate whether every non-grid placement still maps to a real, visible
 * Actor slot. The closure reserves occupied slots in deterministic Item order,
 * causing duplicate or stale assignments to be recovered into the grid.
 */
export function createActorNonInventoryPlacementValidator(actor, race = null, items = null) {
  const equipmentOccupants = new Set();
  const weaponOccupants = new Set();
  const prosthesisLimbs = new Set();
  const constructPartSlots = new Set();
  const naturalWeaponSlots = new Set();
  const actorItems = getItemsArray(items ?? actor?.items);

  const validate = (item, projectedItems = actorItems) => {
    const placementItems = getItemsArray(projectedItems);
    const placement = getItemSystem(item).placement ?? {};
    const mode = String(placement.mode ?? "");
    if (getItemContainerParentId(item) !== ROOT_CONTAINER_ID) return false;

    if (mode === "equipment") {
      if (
        !placement.equipmentSlot
        || placement.weaponSet
        || placement.weaponSlot
        || placement.limbKey
      ) return false;
      const slots = getRequiredEquipmentSlotsForItem(race, item, placement.equipmentSlot);
      if (!slots.length || !slots.some(slot => slot.key === placement.equipmentSlot)) return false;
      const keys = slots.map(slot => String(slot.key ?? "")).filter(Boolean);
      if (!keys.length || keys.some(key => equipmentOccupants.has(key))) return false;
      for (const key of keys) equipmentOccupants.add(key);
      return true;
    }

    if (mode === "weapon") {
      if (String(placement.weaponSet ?? "") === NATURAL_RACE_WEAPON_SET_KEY) {
        if (!isCanonicalNaturalRaceWeaponPlacement(actor, item)) return false;
        const sourceId = String(getNaturalRaceItemFlag(item)?.sourceId ?? "");
        if (naturalWeaponSlots.has(sourceId)) return false;
        naturalWeaponSlots.add(sourceId);
        return true;
      }
      if (
        placement.equipmentSlot
        || !placement.weaponSet
        || !placement.weaponSlot
        || placement.limbKey
      ) return false;
      const slotKeys = getActorWeaponPlacementSlotKeys(
        actor,
        race,
        item,
        placement,
        placementItems
      );
      if (!slotKeys.length) return false;
      const keys = slotKeys.map(key => `${placement.weaponSet}:${key}`);
      if (keys.some(key => weaponOccupants.has(key))) return false;
      for (const key of keys) weaponOccupants.add(key);
      return true;
    }

    if (mode === "implant" || mode === "prosthesis") {
      const limbKey = String(placement.limbKey ?? "");
      if (
        actor?.type === "construct"
        || !limbKey
        || !Object.hasOwn(actor?.system?.limbs ?? {}, limbKey)
        || placement.equipmentSlot
        || placement.weaponSet
        || placement.weaponSlot
      ) return false;
      if (mode === "prosthesis") {
        if (prosthesisLimbs.has(limbKey)) return false;
        prosthesisLimbs.add(limbKey);
      }
      return true;
    }

    if (mode === ITEM_FUNCTIONS.constructPart) {
      const slotId = getConstructPartSlotId(item);
      if (
        actor?.type !== "construct"
        || !slotId
        || !isInstalledConstructPartItem(item)
        || placement.equipmentSlot
        || placement.weaponSet
        || placement.weaponSlot
        || constructPartSlots.has(slotId)
      ) return false;
      constructPartSlots.add(slotId);
      return true;
    }

    return false;
  };
  readOnlyPlacementValidators.add(validate);
  return validate;
}

/**
 * Validate placement modes which are intentionally excluded from grid
 * collision checks (equipment, weapon sets, implants and construct parts).
 */
export function validateActorNonInventoryPlacementState(actor, items = null, race = null) {
  const actorItems = getItemsArray(items ?? actor?.items)
    .filter(isInventoryManagedItem)
    .filter(item => getItemId(item));
  const validatePlacement = createActorNonInventoryPlacementValidator(
    actor,
    race,
    actorItems
  );

  for (const item of actorItems) {
    if (getItemContainerParentId(item) !== ROOT_CONTAINER_ID) continue;
    const mode = getPlacementMode(item);
    if (
      mode === INVENTORY_PLACEMENT_MODE
      || mode === LOCKED_STORAGE_PLACEMENT_MODE
      || mode === BUTCHERING_STORAGE_PLACEMENT_MODE
    ) continue;
    if (
      KNOWN_NON_INVENTORY_PLACEMENT_MODES.has(mode)
      && validatePlacement(item, actorItems)
    ) continue;
    return {
      valid: false,
      reason: "invalid-placement",
      itemId: getItemId(item),
      mode
    };
  }
  return { valid: true };
}

function getActorWeaponPlacementSlotKeys(actor, race, item, placement, actorItems) {
  const setKey = String(placement.weaponSet ?? "");
  const primarySlotKey = String(placement.weaponSlot ?? "");
  if (
    !setKey
    || !primarySlotKey
    || !getWeaponSlotRequirement(item).selectedKeys.size
  ) return [];

  if (!setKey.startsWith("container:")) {
    return getRequiredWeaponSlotsForItem(race, item, setKey, primarySlotKey)
      .map(slot => String(slot.key ?? ""))
      .filter(Boolean);
  }

  const slotCount = getContainerWeaponSlotCount(actor, setKey, actorItems);
  const primaryIndex = getDynamicWeaponSlotIndex(setKey, primarySlotKey);
  const requiredCount = getWeaponSlotRequirementSize(item, race);
  if (
    slotCount <= 0
    || primaryIndex < 0
    || requiredCount <= 0
    || (primaryIndex + requiredCount) > slotCount
  ) return [];

  const prefix = setKey.startsWith("container:constructPart:")
    ? "constructPartWeaponSlot"
    : "extraWeaponSlot";
  return Array.from(
    { length: requiredCount },
    (_value, index) => `${prefix}${primaryIndex + index + 1}`
  );
}

function getContainerWeaponSlotCount(actor, setKey, actorItems) {
  const constructMatch = /^container:constructPart:([^:]+):(.+)$/.exec(setKey);
  if (constructMatch) {
    const [, slotId, setId] = constructMatch;
    const constructPart = actorItems.find(item => (
      isInstalledConstructPartItem(item)
      && getConstructPartSlotId(item) === slotId
    ));
    if (
      !constructPart
      || !hasItemFunction(constructPart, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })
    ) return 0;
    const weaponSets = getItemSystem(constructPart).functions?.constructPart?.weaponSets;
    const set = (Array.isArray(weaponSets) ? weaponSets : [])
      .find(entry => String(entry?.id ?? "") === setId);
    return Math.max(0, Math.trunc(Number(set?.quantity) || 0));
  }

  const containerId = setKey.slice("container:".length);
  const container = actorItems.find(item => getItemId(item) === containerId);
  if (
    !container
    || !isContainerItem(container)
    || !hasItemFunction(container, ITEM_FUNCTIONS.container)
    || !Boolean(getItemSystem(container).equipped)
  ) return 0;
  return Math.max(
    0,
    Math.trunc(Number(getItemSystem(container).functions?.container?.extraWeaponSlots) || 0)
  );
}

function getDynamicWeaponSlotIndex(setKey, slotKey) {
  const prefix = setKey.startsWith("container:constructPart:")
    ? "constructPartWeaponSlot"
    : "extraWeaponSlot";
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(slotKey);
  return match ? Math.max(0, Number(match[1]) - 1) : -1;
}

function identifyBrokenParentLinks(items, itemById, requestRecovery) {
  for (const item of items) {
    const itemId = getItemId(item);
    const parentId = getItemContainerParentId(item);
    if (!parentId) continue;
    if (isMatchingVirtualStorageParent(item, parentId)) continue;

    if (parentId === itemId) {
      requestRecovery(itemId, "self-parent");
      continue;
    }

    const parent = itemById.get(parentId);
    if (!parent) {
      requestRecovery(itemId, "missing-parent");
      continue;
    }
    if (!isContainerItem(parent)) {
      requestRecovery(itemId, "invalid-parent");
      continue;
    }
    if (getPlacementMode(item) !== INVENTORY_PLACEMENT_MODE) {
      requestRecovery(itemId, "invalid-placement");
    }
  }
}

function identifyContainerCycles(items, itemById, requestRecovery) {
  const completed = new Set();

  for (const item of items) {
    const startId = getItemId(item);
    if (!startId || completed.has(startId)) continue;
    const path = [];
    const pathIndex = new Map();
    let currentId = startId;

    while (currentId && itemById.has(currentId) && !completed.has(currentId)) {
      if (pathIndex.has(currentId)) {
        const cycleStart = pathIndex.get(currentId);
        for (const cycleId of path.slice(cycleStart)) requestRecovery(cycleId, "cycle");
        break;
      }

      pathIndex.set(currentId, path.length);
      path.push(currentId);
      const current = itemById.get(currentId);
      const parentId = getItemContainerParentId(current);
      if (!parentId || isMatchingVirtualStorageParent(current, parentId)) break;
      const parent = itemById.get(parentId);
      if (!parent || !isContainerItem(parent)) break;
      currentId = parentId;
    }

    for (const visitedId of path) completed.add(visitedId);
  }
}

function repairInvalidContainerContexts({
  projectedItems,
  projectedById,
  recoveryById,
  requestRecovery
}) {
  const containers = projectedItems
    .filter(isContainerItem)
    .map((item, index) => ({
      item,
      index,
      depth: getContainerDepth(item, projectedById)
    }))
    .sort((left, right) => (right.depth - left.depth) || (left.index - right.index));

  for (const { item: container } of containers) {
    const containerId = getItemId(container);
    const contextItems = projectedItems.filter(item => (
      getItemContainerParentId(item) === containerId
    ));
    if (!contextItems.length) continue;

    const gridOptions = getRepairContainerGridOptions(container);
    const dimensions = normalizeGridDimensions(gridOptions);
    const occupied = [];
    for (const item of contextItems) {
      const itemId = getItemId(item);
      if (recoveryById.has(itemId)) continue;
      if (reserveStoredItemPlacements(
        item,
        projectedItems,
        dimensions,
        gridOptions,
        INVENTORY_PLACEMENT_MODE,
        containerId,
        occupied
      )) continue;

      requestRecovery(itemId, "invalid-placement");
      prepareProjectedItemForContext(item, ROOT_TARGET);
    }

    const evictionCandidates = contextItems
      .filter(item => getItemContainerParentId(item) === containerId)
      .reverse();
    while (
      getContainerContentsWeight(container, projectedItems) > getContainerMaxLoad(container)
      && evictionCandidates.length
    ) {
      const item = evictionCandidates.shift();
      const itemId = getItemId(item);
      requestRecovery(itemId, "max-load");
      prepareProjectedItemForContext(item, ROOT_TARGET);
    }
  }
}

function reserveStoredItemPlacements(
  item,
  allItems,
  dimensions,
  options,
  expectedMode,
  expectedStoredParentId,
  occupied
) {
  if (!hasValidInventoryMetadata(item, expectedMode, expectedStoredParentId)) return false;
  const placements = getStoredVisualPlacements(item, allItems, expectedMode);
  if (!placements.length) return false;

  const itemPlacements = [];
  for (const placement of placements) {
    if (!isStoredPlacementCoordinateValid(placement)) return false;
    if (!isInventoryPlacementWithinBounds(
      placement,
      dimensions.columns,
      dimensions.rows,
      options
    )) return false;
    if (occupied.some(existing => inventoryPlacementsOverlap(placement, existing))) return false;
    if (itemPlacements.some(existing => inventoryPlacementsOverlap(placement, existing))) return false;
    itemPlacements.push(placement);
  }

  occupied.push(...itemPlacements);
  return true;
}

function hasValidInventoryMetadata(item, expectedMode, expectedStoredParentId) {
  const system = getItemSystem(item);
  const placement = system.placement ?? {};
  const baseFootprint = getItemBaseFootprint(item);
  if (getItemContainerParentId(item) !== expectedStoredParentId) return false;
  if (String(placement.mode ?? INVENTORY_PLACEMENT_MODE) !== expectedMode) return false;
  if (Boolean(system.equipped)) return false;
  if (SLOT_FIELDS.some(field => String(placement[field] ?? ""))) return false;
  if (toNonNegativeInteger(placement.constructPartOrder) !== 0) return false;
  if (getStrictPositiveInteger(placement.width) !== baseFootprint.width) return false;
  if (getStrictPositiveInteger(placement.height) !== baseFootprint.height) return false;

  if (usesVirtualInventoryStacks(item)) {
    const parts = getItemStackParts(item);
    if (parts.length) {
      const primary = parts[0];
      if (
        getStrictPositiveInteger(placement.x) !== getStrictPositiveInteger(primary.x)
        || getStrictPositiveInteger(placement.y) !== getStrictPositiveInteger(primary.y)
        || Boolean(placement.rotated) !== Boolean(primary.rotated)
      ) return false;
    }
  }
  return true;
}

function getStoredVisualPlacements(item, allItems, mode) {
  const system = getItemSystem(item);
  const primaryPlacement = system.placement ?? {};
  const descriptors = getVisualStackDescriptors(item);
  return descriptors.map((descriptor, index) => {
    const x = descriptor.x ?? (index === 0 ? primaryPlacement.x : null);
    const y = descriptor.y ?? (index === 0 ? primaryPlacement.y : null);
    const rotated = Boolean(descriptor.rotated ?? primaryPlacement.rotated);
    const footprint = getFootprintForRotation(item, allItems, rotated);
    return {
      mode,
      x: Number(x),
      y: Number(y),
      width: footprint.width,
      height: footprint.height,
      rotated
    };
  });
}

function getVisualStackDescriptors(item) {
  if (!usesVirtualInventoryStacks(item)) {
    const placement = getItemSystem(item).placement ?? {};
    return [{
      quantity: getItemQuantity(item),
      x: placement.x,
      y: placement.y,
      rotated: placement.rotated
    }];
  }

  const parts = getItemStackParts(item);
  if (parts.length) return parts.map(part => ({ ...part }));
  return [{
    quantity: 0,
    x: getItemSystem(item).placement?.x,
    y: getItemSystem(item).placement?.y,
    rotated: getItemSystem(item).placement?.rotated
  }];
}

function packItemIntoContext(item, allItems, dimensions, options, mode, occupied) {
  const descriptors = getRepairStackDescriptors(item);
  const reserved = [...occupied];
  const placements = [];

  for (const descriptor of descriptors) {
    const placement = findAvailablePlacement(
      item,
      allItems,
      dimensions,
      options,
      mode,
      reserved,
      descriptor.rotated
    );
    if (!placement) return null;
    placements.push({
      ...placement,
      quantity: descriptor.quantity
    });
    reserved.push(placement);
  }
  return placements;
}

function getRepairStackDescriptors(item) {
  if (!usesVirtualInventoryStacks(item)) {
    return [{
      quantity: getItemQuantity(item),
      rotated: Boolean(getItemSystem(item).placement?.rotated)
    }];
  }

  const normalized = getItemStackParts(item);
  const parts = normalized.length
    ? normalized
    : createItemStackPartsForQuantity(item, getItemQuantity(item));
  if (!parts.length) {
    return [{
      quantity: 0,
      rotated: Boolean(getItemSystem(item).placement?.rotated)
    }];
  }
  return parts.map(part => ({
    quantity: part.quantity,
    rotated: Boolean(part.rotated ?? getItemSystem(item).placement?.rotated)
  }));
}

function findAvailablePlacement(
  item,
  allItems,
  dimensions,
  options,
  mode,
  occupied,
  preferredRotated
) {
  const rotations = getRotationPreference(item, preferredRotated);
  const occupiedBottom = getOccupiedRows(occupied);

  for (const rotated of rotations) {
    const footprint = getFootprintForRotation(item, allItems, rotated);
    if (footprint.width > dimensions.columns) continue;
    const maxX = dimensions.columns - footprint.width + 1;
    const maxY = options.allowOverflowRows
      ? Math.max(dimensions.rows, occupiedBottom) + Math.max(64, footprint.height + occupied.length + 1)
      : dimensions.rows - footprint.height + 1;
    if (maxX < 1 || maxY < 1) continue;

    for (let y = 1; y <= maxY; y += 1) {
      for (let x = 1; x <= maxX; x += 1) {
        const placement = {
          mode,
          equipmentSlot: "",
          weaponSet: "",
          weaponSlot: "",
          limbKey: "",
          constructPartOrder: 0,
          x,
          y,
          width: footprint.width,
          height: footprint.height,
          rotated
        };
        if (!isInventoryPlacementWithinBounds(
          placement,
          dimensions.columns,
          dimensions.rows,
          options
        )) continue;
        if (occupied.some(existing => inventoryPlacementsOverlap(placement, existing))) continue;
        return placement;
      }
    }
  }
  return null;
}

function createEmergencyLockedStoragePlacements(item, allItems, occupied, mode) {
  const descriptors = getRepairStackDescriptors(item);
  const placements = [];
  let y = getOccupiedRows(occupied) + 1;

  for (const descriptor of descriptors) {
    const rotated = Boolean(descriptor.rotated);
    const footprint = getFootprintForRotation(item, allItems, rotated);
    placements.push({
      mode,
      equipmentSlot: "",
      weaponSet: "",
      weaponSlot: "",
      limbKey: "",
      constructPartOrder: 0,
      x: 1,
      y,
      width: footprint.width,
      height: footprint.height,
      rotated,
      quantity: descriptor.quantity
    });
    y += footprint.height;
  }
  return placements;
}

function createRecoveryUpdate(item, placements, target) {
  const primaryPlacement = placements[0];
  const mode = target === LOCKED_STORAGE_TARGET
    ? LOCKED_STORAGE_PLACEMENT_MODE
    : INVENTORY_PLACEMENT_MODE;
  const lockedState = getItemLockedStateForPlacementTransition(item, mode);
  const storedPlacement = createStoredPlacement({
    ...primaryPlacement,
    mode,
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    limbKey: "",
    constructPartOrder: 0
  }, item);
  const update = {
    _id: getItemId(item),
    "system.equipped": false,
    ...(lockedState === undefined ? {} : { "system.locked": lockedState }),
    "system.container.parentId": ROOT_CONTAINER_ID,
    "system.placement.mode": storedPlacement.mode,
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": "",
    "system.placement.constructPartOrder": 0,
    "system.placement.x": storedPlacement.x,
    "system.placement.y": storedPlacement.y,
    "system.placement.width": storedPlacement.width,
    "system.placement.height": storedPlacement.height,
    "system.placement.rotated": storedPlacement.rotated
  };

  if (usesVirtualInventoryStacks(item)) {
    update["system.stackParts"] = getItemQuantity(item) > 0
      ? placements.map(placement => ({
        quantity: placement.quantity,
        x: placement.x,
        y: placement.y,
        rotated: Boolean(placement.rotated)
      }))
      : [];
  }
  return update;
}

function prepareProjectedItemForContext(item, target) {
  if (!item) return;
  const system = item.system ??= {};
  const container = system.container ??= {};
  const placement = system.placement ??= {};
  const targetMode = target === LOCKED_STORAGE_TARGET
    ? LOCKED_STORAGE_PLACEMENT_MODE
    : INVENTORY_PLACEMENT_MODE;
  const lockedState = getItemLockedStateForPlacementTransition(item, targetMode);
  container.parentId = ROOT_CONTAINER_ID;
  system.equipped = false;
  if (lockedState !== undefined) system.locked = lockedState;
  placement.mode = targetMode;
  for (const field of SLOT_FIELDS) placement[field] = "";
  placement.constructPartOrder = 0;
}

function getContainerDepth(item, itemById) {
  let depth = 0;
  let parentId = getItemContainerParentId(item);
  const visited = new Set([getItemId(item)]);
  while (parentId && itemById.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = getItemContainerParentId(itemById.get(parentId));
  }
  return depth;
}

function getRepairContainerGridOptions(container) {
  const specialGrids = getItemSystem(container).functions?.container?.specialGrids;
  const blocks = Array.isArray(specialGrids?.blocks) ? specialGrids.blocks : [];
  if (!blocks.length) return getContainerInventoryGridOptions(container);

  // The shared helper uses Foundry utilities to inspect persisted special-grid
  // anchors and to generate missing block ids. Reproduce only that small
  // normalization edge here so the planner remains usable with plain objects.
  const dimensions = getContainerDimensions(container);
  const normalizedBlocks = blocks.map((block, index) => ({
    id: String(block?.id || `repair-zone-${index}`),
    x: Number(block?.x) || 0,
    y: Number(block?.y) || 0,
    width: Math.max(1, Math.trunc(Number(block?.width) || 0) || 1),
    height: Math.max(1, Math.trunc(Number(block?.height) || 0) || 1)
  }));
  const defaultAnchor = {
    left: snapSpecialGridCoordinate(0, dimensions.columns) - (dimensions.columns / 2),
    top: snapSpecialGridCoordinate(0, dimensions.rows) - (dimensions.rows / 2)
  };
  const storedAnchor = specialGrids?.baseAnchor;
  const baseAnchor = (
    Object.hasOwn(specialGrids ?? {}, "baseAnchor")
    && Number.isFinite(Number(storedAnchor?.left))
    && Number.isFinite(Number(storedAnchor?.top))
  )
    ? { left: Number(storedAnchor.left), top: Number(storedAnchor.top) }
    : defaultAnchor;
  const rawZones = [{
    id: "base",
    x: 1,
    y: 1,
    width: dimensions.columns,
    height: dimensions.rows,
    base: true
  }, ...normalizedBlocks.map(block => ({
    id: block.id,
    x: Math.floor((block.x - (block.width / 2)) - baseAnchor.left) + 1,
    y: Math.floor((block.y - (block.height / 2)) - baseAnchor.top) + 1,
    width: block.width,
    height: block.height,
    base: false
  }))];
  const minimumX = rawZones.reduce((minimum, zone) => Math.min(minimum, zone.x), 1);
  const minimumY = rawZones.reduce((minimum, zone) => Math.min(minimum, zone.y), 1);
  const shiftX = Math.max(0, 1 - minimumX);
  const shiftY = Math.max(0, 1 - minimumY);
  const zones = rawZones.map(zone => ({
    ...zone,
    x: zone.x + shiftX,
    y: zone.y + shiftY
  }));
  return {
    columns: zones.reduce(
      (maximum, zone) => Math.max(maximum, zone.x + zone.width - 1),
      dimensions.columns
    ),
    rows: zones.reduce(
      (maximum, zone) => Math.max(maximum, zone.y + zone.height - 1),
      dimensions.rows
    ),
    baseColumns: dimensions.columns,
    baseRows: dimensions.rows,
    zones
  };
}

function snapSpecialGridCoordinate(value, size = 1) {
  const number = Number(value);
  const offset = (Math.max(1, Math.trunc(Number(size) || 0) || 1) - 1) / 2;
  return (Number.isFinite(number) ? Math.round(number - offset) : 0) + offset;
}

function getLockedStorageColumns(items, rootColumns) {
  let columns = Math.max(1, toPositiveInteger(rootColumns));
  for (const item of items) {
    for (const rotated of getRotationPreference(item, getItemSystem(item).placement?.rotated)) {
      columns = Math.max(columns, getFootprintForRotation(item, items, rotated).width);
    }
  }
  return columns;
}

function getFootprintForRotation(item, allItems, rotated) {
  const system = getItemSystem(item);
  const rotatedItem = {
    ...item,
    system: {
      ...system,
      placement: {
        ...(system.placement ?? {}),
        rotated: Boolean(rotated)
      }
    }
  };
  return getItemFootprint(rotatedItem, allItems);
}

function getRotationPreference(item, preferredRotated = false) {
  const preferred = Boolean(preferredRotated);
  const footprint = getItemBaseFootprint(item);
  if (footprint.width === footprint.height) return [preferred];
  return [preferred, !preferred];
}

function getOccupiedRows(placements) {
  return getItemsArray(placements).reduce(
    (maximum, placement) => Math.max(
      maximum,
      toPositiveInteger(placement?.y) + toPositiveInteger(placement?.height) - 1
    ),
    0
  );
}

function isStoredPlacementCoordinateValid(placement) {
  return (
    Number.isInteger(placement?.x)
    && placement.x > 0
    && Number.isInteger(placement?.y)
    && placement.y > 0
    && Number.isInteger(placement?.width)
    && placement.width > 0
    && Number.isInteger(placement?.height)
    && placement.height > 0
  );
}

function isMatchingVirtualStorageParent(item, parentId) {
  const mode = getPlacementMode(item);
  return (
    (mode === LOCKED_STORAGE_PLACEMENT_MODE && parentId === LOCKED_STORAGE_PARENT_ID)
    || (mode === BUTCHERING_STORAGE_PLACEMENT_MODE && parentId === BUTCHERING_STORAGE_PARENT_ID)
  );
}

function getPlacementMode(item) {
  return String(getItemSystem(item).placement?.mode ?? INVENTORY_PLACEMENT_MODE);
}

function isInventoryManagedItem(item) {
  return !["ability", "trauma", "disease"].includes(getItemType(item));
}

function normalizeGridDimensions(dimensions = {}) {
  return {
    columns: Math.max(1, toPositiveInteger(dimensions.columns)),
    rows: Math.max(1, toPositiveInteger(dimensions.rows))
  };
}

function toPositiveInteger(value) {
  return Math.max(1, Math.trunc(Number(value) || 0));
}

function toNonNegativeInteger(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function getStrictPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

/** Take an independent full snapshot, including custom serializer output. */
export function cloneInventoryItemData(item) {
  const source = typeof item?.toObject === "function" ? item.toObject() : item;
  // Native Item serialization already returns an independent source copy.
  // Plain records and custom serializers
  // still require a detached clone, including custom compatibility shims.
  const Document = globalThis.foundry?.abstract?.Document;
  const DataModel = globalThis.foundry?.abstract?.DataModel;
  const BaseItem = globalThis.foundry?.documents?.BaseItem;
  const BaseEffect = globalThis.foundry?.documents?.BaseActiveEffect;
  if (Document && BaseItem && item instanceof BaseItem
    && item.toObject === Document.prototype.toObject && item.constructor.shimData === BaseItem.shimData
    && (globalThis.CONFIG?.ActiveEffect?.documentClass ?? BaseEffect)?.shimData === BaseEffect?.shimData
    && [globalThis.CONFIG?.Item, globalThis.CONFIG?.ActiveEffect].every(config =>
      Object.values(config?.dataModels ?? {}).every(Model => Model.shimData === DataModel?.shimData))) {
    // #region codex-runtime-debug H11 native inventory projection avoids duplicate copy
    globalThis.__falloutMawGameplayProbe?.count("inventory.repair.singleSourceCopy", "H11");
    // #endregion codex-runtime-debug
    return source;
  }
  if (typeof structuredClone === "function") return structuredClone(source);
  return JSON.parse(JSON.stringify(source));
}

function cloneRepairProjection(item, readOnlyValidation) {
  // The planner writes only equipped/locked, container.parentId and placement
  // fields in prepareProjectedItemForContext. All other branches are read-only.
  // Sharing those branches with the immutable expected snapshot avoids copying
  // every weapon function, effect and description merely to test grid positions.
  // External predicates receive a fully detached object, as before.
  if (!readOnlyValidation || typeof item?.toObject === "function"
    || !isPlainRecord(item) || !isPlainRecord(item.system)
    || (item.system.container != null && !isPlainRecord(item.system.container))
    || (item.system.placement != null && !isPlainRecord(item.system.placement))) {
    return cloneInventoryItemData(item);
  }
  // #region codex-runtime-debug H11 verify the actual snapshot-to-projection path
  globalThis.__falloutMawGameplayProbe?.count("inventory.repair.placementProjection", "H11");
  // #endregion codex-runtime-debug
  return {
    ...item,
    system: {
      ...item.system,
      container: { ...item.system.container },
      placement: { ...item.system.placement }
    }
  };
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
