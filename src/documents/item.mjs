import {
  BUTCHERING_STORAGE_PARENT_ID,
  BUTCHERING_STORAGE_PLACEMENT_MODE,
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  createAnchoredItemStackPartsForQuantity,
  createItemStackPartsForQuantity,
  getContainerContents,
  getContainerInventoryGridOptions,
  getContextInventoryItems,
  getItemDeletionClosureIds,
  getItemContainerParentId,
  getItemFootprint,
  getItemStackParts,
  getItemTotalWeight,
  isContainerItem,
  isInventoryPlacementAvailable,
  normalizeInventoryPlacement,
  validateInventoryTree,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import {
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions
} from "../utils/actor-display-data.mjs";
import { DISEASE_CREATE_OPTION, TRAUMA_CREATE_OPTION } from "../constants.mjs";
import {
  INVENTORY_ATOMIC_OPTION,
  INVENTORY_EXPECTED_IDS_OPTION
} from "../inventory/constants.mjs";
import { validateActorNonInventoryPlacementState } from "../inventory/repair.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { migrateItemData } from "../migrations/documents.mjs";
import { handleItemDamageUpdate, prepareItemDamageUpdate } from "../combat/damage-hub.mjs";
import {
  cleanBooleanSlotSelections,
  getCreatureEquipmentSlotSelectionKeys,
  getCreatureWeaponSlotSelectionKeys
} from "../utils/equipment-slots.mjs";

const MANUALLY_CREATABLE_ITEM_TYPES = Object.freeze(["gear", "ability"]);

export class FalloutMaWItem extends Item {
  static TRAUMA_CREATE_OPTION = TRAUMA_CREATE_OPTION;
  static DISEASE_CREATE_OPTION = DISEASE_CREATE_OPTION;

  static async deleteDocuments(ids = [], operation = {}) {
    const actor = await getInventoryOperationActor(operation);
    if (!actor) return super.deleteDocuments(ids, operation);

    const requestedIds = operation.deleteAll
      ? Array.from(actor.items ?? [], item => item.id)
      : normalizeDeletionIds(ids);
    const expectedIds = operation[INVENTORY_EXPECTED_IDS_OPTION];
    const deletionIds = (
      operation[INVENTORY_ATOMIC_OPTION] === true
      && Array.isArray(expectedIds)
    )
      ? normalizeDeletionIds(expectedIds)
      : getItemDeletionClosureIds(requestedIds, actor.items);
    operation[INVENTORY_ATOMIC_OPTION] = true;
    operation[INVENTORY_EXPECTED_IDS_OPTION] = deletionIds;

    const deleted = await super.deleteDocuments(operation.deleteAll ? [] : deletionIds, operation);
    assertAtomicInventoryOperationIds(deleted, operation, "delete");
    return deleted;
  }

  static async _preCreateOperation(documents, operation, user) {
    const allowed = await super._preCreateOperation(documents, operation, user);
    assertAtomicInventoryOperationAllowed(allowed, operation, "create");
    assertAtomicInventoryOperationIds(documents, operation, "create");
    return allowed;
  }

  static async _preUpdateOperation(documents, operation, user) {
    const allowed = await super._preUpdateOperation(documents, operation, user);
    assertAtomicInventoryOperationAllowed(allowed, operation, "update");
    assertAtomicInventoryOperationIds(documents, operation, "update");
    return allowed;
  }

  static async _preDeleteOperation(documents, operation, user) {
    const allowed = await super._preDeleteOperation(documents, operation, user);
    assertAtomicInventoryOperationAllowed(allowed, operation, "delete");
    assertAtomicInventoryOperationIds(documents, operation, "delete");
    return allowed;
  }

  static async createDialog(data = {}, createOptions = {}, dialogOptions = {}, renderOptions = {}) {
    const requestedTypes = Array.isArray(dialogOptions.types) ? dialogOptions.types : MANUALLY_CREATABLE_ITEM_TYPES;
    const types = requestedTypes.filter(type => MANUALLY_CREATABLE_ITEM_TYPES.includes(type));
    const createData = foundry.utils.deepClone(data ?? {});
    if (!MANUALLY_CREATABLE_ITEM_TYPES.includes(createData.type)) delete createData.type;
    return super.createDialog(createData, createOptions, {
      ...dialogOptions,
      types: types.length ? types : MANUALLY_CREATABLE_ITEM_TYPES
    }, renderOptions);
  }

  static migrateData(source, options) {
    source = super.migrateData(source, options);
    return migrateItemData(source, options);
  }

  _initializeSource(data, options = {}) {
    if (["weapon", "armor"].includes(data?.type)) {
      data.type = "gear";
    }
    return super._initializeSource(data, options);
  }

  async _preCreate(data, options, user) {
    if ((await super._preCreate(data, options, user)) === false) {
      return cancelInventoryDocumentOperation(this, options, "create");
    }
    prepareItemDamageUpdate(this, data, options, { operation: "create" });
    this.updateSource(getCleanSlotRequirementSource(this));
    if (this.type === "trauma" && options?.[TRAUMA_CREATE_OPTION] !== true) {
      ui.notifications?.warn?.("Травмы создаются только системой при получении повреждения.");
      return cancelInventoryDocumentOperation(this, options, "create");
    }
    if (this.type === "disease" && options?.[DISEASE_CREATE_OPTION] !== true) {
      ui.notifications?.warn?.("Болезни создаются только системой.");
      return cancelInventoryDocumentOperation(this, options, "create");
    }
    if (this.type === "trauma") {
      this.updateSource({
        system: {
          generated: true
        },
        flags: {
          "fallout-maw": {
            generatedTrauma: true
          }
        }
      });
      return undefined;
    }
    if (this.type === "disease") {
      this.updateSource({
        system: {
          generated: true
        },
        flags: {
          "fallout-maw": {
            generatedDisease: true
          }
        }
      });
      return undefined;
    }
    if (!this.parent) {
      this.updateSource({
        system: {
          equipped: false,
          placement: {
            mode: "inventory",
            equipmentSlot: "",
            weaponSet: "",
            weaponSlot: "",
            limbKey: ""
          }
        }
      });
    }
    if (isContainerItem(data ?? this)) {
      this.updateSource({
        system: {
          quantity: 1,
          maxStack: 1
        }
      });
    }
    if (this.parent?.documentName === "Actor" && usesVirtualInventoryStacks(this)) {
      const stackParts = prepareUpdatedStackParts(this, this.toObject(), {
        repack: true,
        validatePositioned: options?.[INVENTORY_ATOMIC_OPTION] !== true
      });
      if (!stackParts) {
        ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
        return cancelInventoryDocumentOperation(this, options, "create");
      }
      const primaryPart = stackParts[0] ?? null;
      this.updateSource({
        system: {
          stackParts,
          ...(primaryPart?.x && primaryPart?.y ? {
            placement: {
              x: primaryPart.x,
              y: primaryPart.y,
              rotated: Boolean(primaryPart.rotated)
            }
          } : {})
        }
      });
    }
    return undefined;
  }

  async _preUpdate(changes, options, user) {
    if ((await super._preUpdate(changes, options, user)) === false) {
      return cancelInventoryDocumentOperation(this, options, "update");
    }

    const requestedSource = foundry.utils.mergeObject(this.toObject(), changes, { inplace: false });
    Object.assign(changes, getSlotRequirementDeletionUpdates(requestedSource));
    if (isContainerItem(requestedSource)) {
      foundry.utils.setProperty(changes, "system.quantity", 1);
      foundry.utils.setProperty(changes, "system.maxStack", 1);
    }

    if (getItemContainerParentId(requestedSource)) {
      foundry.utils.setProperty(changes, "system.equipped", false);
      foundry.utils.setProperty(changes, "system.placement.mode", "inventory");
      foundry.utils.setProperty(changes, "system.placement.equipmentSlot", "");
      foundry.utils.setProperty(changes, "system.placement.weaponSet", "");
      foundry.utils.setProperty(changes, "system.placement.weaponSlot", "");
      foundry.utils.setProperty(changes, "system.placement.limbKey", "");
    }

    const changesStackShape = ["system.quantity", "system.maxStack", "system.stackParts"]
      .some(path => foundry.utils.hasProperty(changes, path));
    if (changesStackShape) {
      const nextSource = foundry.utils.mergeObject(this.toObject(), changes, { inplace: false });
      const explicitStackParts = foundry.utils.hasProperty(changes, "system.stackParts");
      const stackParts = prepareUpdatedStackParts(this, nextSource, {
        repack: !explicitStackParts && options?.falloutMawRepackStacks === true,
        validatePositioned: !explicitStackParts
      });
      if (!stackParts) {
        ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
        return cancelInventoryDocumentOperation(this, options, "update");
      }
      foundry.utils.setProperty(changes, "system.stackParts", stackParts);
      const primaryPart = stackParts[0] ?? null;
      if (primaryPart?.x && primaryPart?.y) {
        foundry.utils.setProperty(changes, "system.placement.x", primaryPart.x);
        foundry.utils.setProperty(changes, "system.placement.y", primaryPart.y);
        foundry.utils.setProperty(changes, "system.placement.rotated", Boolean(primaryPart.rotated));
      }
    }

    prepareItemDamageUpdate(this, changes, options, { operation: "update" });
    if (
      options?.[INVENTORY_ATOMIC_OPTION] !== true
      && shouldValidateProjectedInventoryUpdate(this, changes)
    ) {
      const validation = validateProjectedActorInventoryUpdate(this, changes);
      if (!validation.valid) {
        warnInventoryValidationFailure(validation);
        return false;
      }
    }
    return undefined;
  }

  async _preDelete(options, user) {
    if ((await super._preDelete(options, user)) === false) {
      return cancelInventoryDocumentOperation(this, options, "delete");
    }
    prepareItemDamageUpdate(this, this.toObject(), options, { operation: "delete" });
    return undefined;
  }

  _onUpdate(changes, options, userId) {
    super._onUpdate(changes, options, userId);
    handleItemDamageUpdate(this, changes, options);
  }

  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    handleItemDamageUpdate(this, data, options);
  }

  _onDelete(options, userId) {
    super._onDelete(options, userId);
    handleItemDamageUpdate(this, this.toObject(), options);
  }

  get isEquipped() {
    return Boolean(this.system?.equipped);
  }

  get isContainer() {
    return isContainerItem(this);
  }

  get containerParentId() {
    return getItemContainerParentId(this);
  }

  get containerContents() {
    return this.actor ? getContainerContents(this, this.actor.items) : [];
  }

  get totalWeight() {
    return getItemTotalWeight(this, this.actor?.items ?? []);
  }
}

async function getInventoryOperationActor(operation = {}) {
  if (operation.parent?.documentName === "Actor") return operation.parent;
  if (operation.parent || !operation.parentUuid) return null;

  const resolveUuid = globalThis.fromUuid ?? foundry.utils.fromUuid;
  const parent = await resolveUuid?.(operation.parentUuid);
  if (parent?.documentName !== "Actor") return null;
  operation.parent = parent;
  return parent;
}

function normalizeDeletionIds(ids = []) {
  if (!Array.isArray(ids)) throw new TypeError("Item deletion IDs must be an Array.");
  const normalized = ids.map(id => String(id ?? ""));
  if (normalized.some(id => !id)) throw new TypeError("Item deletion IDs must be non-empty strings.");
  return Array.from(new Set(normalized));
}

function assertAtomicInventoryOperationAllowed(allowed, operation, action) {
  if (operation?.[INVENTORY_ATOMIC_OPTION] !== true || allowed !== false) return;
  throw new Error(`Atomic inventory ${action} operation was rejected.`);
}

function assertAtomicInventoryOperationIds(documents, operation, action) {
  if (operation?.[INVENTORY_ATOMIC_OPTION] !== true) return;

  const expectedIds = operation?.[INVENTORY_EXPECTED_IDS_OPTION];
  if (
    !Array.isArray(expectedIds)
    || expectedIds.some(id => typeof id !== "string" || !id)
    || new Set(expectedIds).size !== expectedIds.length
  ) {
    throw new TypeError(`Atomic inventory ${action} operation requires unique expected Item IDs.`);
  }

  const values = Array.isArray(documents) ? documents : Array.from(documents ?? []);
  const actualIds = values.map(value => (
    typeof value === "string" ? value : String(value?.id ?? value?._id ?? "")
  ));
  const actualIdSet = new Set(actualIds);
  const expectedIdSet = new Set(expectedIds);
  const isExactMatch = (
    actualIds.length === expectedIds.length
    && actualIdSet.size === actualIds.length
    && actualIds.every(id => id && expectedIdSet.has(id))
  );
  if (isExactMatch) return;

  const missing = expectedIds.filter(id => !actualIdSet.has(id));
  const unexpected = actualIds.filter(id => !expectedIdSet.has(id));
  const details = [
    missing.length ? `missing: ${missing.join(", ")}` : "",
    unexpected.length ? `unexpected: ${unexpected.join(", ")}` : "",
    actualIdSet.size !== actualIds.length ? "duplicate result IDs" : ""
  ].filter(Boolean).join("; ");
  throw new Error(
    `Atomic inventory ${action} operation changed its requested Item set`
    + (details ? ` (${details}).` : ".")
  );
}

function cancelInventoryDocumentOperation(item, options, action) {
  if (options?.[INVENTORY_ATOMIC_OPTION] !== true) return false;
  throw new Error(`Atomic inventory ${action} was rejected for Item ${item?.id ?? "(pending)"}.`);
}

function shouldValidateProjectedInventoryUpdate(item, changes = {}) {
  if (item.parent?.documentName !== "Actor") return false;
  const inventoryPaths = [
    "type",
    "system.container",
    "system.functions.container",
    "system.itemFunction",
    "system.maxStack",
    "system.placement",
    "system.quantity",
    "system.stackParts",
    "system.weight"
  ];
  return Object.keys(foundry.utils.flattenObject(changes)).some(path => {
    const canonicalPath = path.replaceAll(".-=", ".");
    return inventoryPaths.some(prefix => (
      canonicalPath === prefix || canonicalPath.startsWith(`${prefix}.`)
    ));
  });
}

function validateProjectedActorInventoryUpdate(item, changes = {}) {
  const actor = item.parent;
  const projectedItems = Array.from(actor.items ?? [], candidate => {
    const source = candidate.toObject();
    if (candidate.id !== item.id) return source;
    return foundry.utils.mergeObject(source, changes, {
      applyOperators: true,
      inplace: false
    });
  });
  const raceId = String(actor.system?.creature?.raceId ?? "");
  const race = getCreatureOptions().races.find(entry => String(entry.id) === raceId) ?? null;
  const treeValidation = validateInventoryTree(projectedItems, getActorInventoryGridDimensions(actor, race), {
    rootOptions: getActorRootInventoryGridOptions(actor, "")
  });
  if (!treeValidation.valid) return treeValidation;
  return validateActorNonInventoryPlacementState(actor, projectedItems, race);
}

function warnInventoryValidationFailure(validation = {}) {
  let messageKey = "FALLOUTMAW.Messages.InventoryNoSpace";
  if (validation.reason === "recursive") {
    messageKey = "FALLOUTMAW.Messages.ContainerRecursiveError";
  } else if (validation.reason === "max-load") {
    messageKey = "FALLOUTMAW.Messages.ContainerMaxLoadExceeded";
  }
  ui.notifications?.warn?.(game.i18n.localize(messageKey));
}

function prepareUpdatedStackParts(item, nextSource, { repack = false, validatePositioned = true } = {}) {
  if (!usesVirtualInventoryStacks(nextSource)) return [];

  const parts = repack
    ? createRepackedStackParts(item, nextSource)
    : getItemStackParts(nextSource).map(part => ({ ...part }));
  if (!parts.length) return [];

  const actor = item.parent?.documentName === "Actor" ? item.parent : null;
  const placementMode = String(nextSource.system?.placement?.mode ?? "inventory");
  const inventoryManaged = [
    "inventory",
    LOCKED_STORAGE_PLACEMENT_MODE,
    BUTCHERING_STORAGE_PLACEMENT_MODE
  ].includes(placementMode);
  if (!actor || !inventoryManaged) return parts;

  const context = getStackInventoryContext(actor, nextSource, placementMode);
  if (!context) return null;
  const basePlacement = nextSource.system?.placement ?? {};
  const contextItems = getContextInventoryItems(context.parentId, actor.items)
    .filter(candidate => candidate.id !== item.id);
  const positionedParts = [];
  const reservedPlacements = [];
  let missingQuantity = 0;
  for (const part of parts) {
    if (!hasStoredStackPartPlacement(part)) {
      missingQuantity += Math.max(0, Number(part.quantity) || 0);
      continue;
    }
    const placement = normalizeInventoryPlacement({
      ...basePlacement,
      mode: placementMode,
      x: part.x,
      y: part.y,
      rotated: part.rotated ?? basePlacement.rotated
    }, nextSource, actor.items);
    if (validatePositioned && !isInventoryPlacementAvailable(
      placement,
      contextItems,
      context.columns,
      context.rows,
      actor.items,
      [item.id],
      reservedPlacements,
      { ...context.options, allowResolvedAvailability: true }
    )) {
      missingQuantity += Math.max(0, Number(part.quantity) || 0);
      continue;
    }
    positionedParts.push(part);
    reservedPlacements.push(placement);
  }
  if (!missingQuantity) return positionedParts;

  const preferredPlacement = positionedParts.length
    ? null
    : normalizeInventoryPlacement({ ...basePlacement, mode: placementMode }, nextSource, actor.items);
  const missingParts = createAnchoredItemStackPartsForQuantity({
    itemData: nextSource,
    quantity: missingQuantity,
    preferredPlacement,
    contextItems,
    columns: context.columns,
    rows: context.rows,
    allItems: actor.items,
    excludeItemIds: [item.id],
    reservedPlacements,
    options: context.options
  });
  if (!missingParts) return null;
  return [...positionedParts, ...missingParts];
}

function createRepackedStackParts(item, nextSource) {
  const parts = createItemStackPartsForQuantity(nextSource);
  const placement = nextSource.system?.placement ?? {};
  const storedPlacements = getItemStackParts(item)
    .filter(hasStoredStackPartPlacement);
  if (!storedPlacements.length && placement.x && placement.y) {
    storedPlacements.push({
      x: placement.x,
      y: placement.y,
      rotated: placement.rotated
    });
  }
  return parts.map((part, index) => {
    const stored = storedPlacements[index];
    if (!stored) return part;
    return {
      ...part,
      x: stored.x,
      y: stored.y,
      rotated: Boolean(stored.rotated)
    };
  });
}

function getStackInventoryContext(actor, itemData, placementMode) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId) ?? null;
  const rootDimensions = getActorInventoryGridDimensions(actor, race);
  if (placementMode === LOCKED_STORAGE_PLACEMENT_MODE) {
    return {
      parentId: LOCKED_STORAGE_PARENT_ID,
      columns: rootDimensions.columns,
      rows: 1,
      options: createSpecialStorageGridOptions(LOCKED_STORAGE_PLACEMENT_MODE)
    };
  }
  if (placementMode === BUTCHERING_STORAGE_PLACEMENT_MODE) {
    return {
      parentId: BUTCHERING_STORAGE_PARENT_ID,
      columns: Math.max(rootDimensions.columns, getItemFootprint(itemData, actor.items).width),
      rows: 1,
      options: createSpecialStorageGridOptions(BUTCHERING_STORAGE_PLACEMENT_MODE)
    };
  }

  const parentId = getItemContainerParentId(itemData);
  if (parentId) {
    const container = actor.items.get(parentId);
    if (!container) return null;
    const gridOptions = getContainerInventoryGridOptions(container);
    return {
      parentId,
      columns: gridOptions.columns,
      rows: gridOptions.rows,
      options: gridOptions
    };
  }
  return {
    parentId: "",
    columns: rootDimensions.columns,
    rows: rootDimensions.rows,
    options: getActorRootInventoryGridOptions(actor, "")
  };
}

function createSpecialStorageGridOptions(placementMode) {
  return {
    allowOverflowRows: true,
    compactRows: true,
    compactVerticalOffset: true,
    extraRows: 1,
    placementMode,
    preferredPlacementModes: [placementMode]
  };
}

function hasStoredStackPartPlacement(part) {
  return Number(part?.x) > 0 && Number(part?.y) > 0;
}

function getCleanSlotRequirementSource(itemOrData) {
  const source = itemOrData?.toObject?.() ?? itemOrData ?? {};
  if (!hasSlotRequirementSource(source)) return {};
  const creatureOptions = getCreatureOptions();
  return {
    system: {
      occupiedSlots: cleanBooleanSlotSelections(
        source.system?.occupiedSlots ?? {},
        getCreatureEquipmentSlotSelectionKeys(creatureOptions)
      ),
      weaponSlotRequirement: {
        slots: cleanBooleanSlotSelections(
          source.system?.weaponSlotRequirement?.slots ?? {},
          getCreatureWeaponSlotSelectionKeys(creatureOptions)
        )
      }
    }
  };
}

function getSlotRequirementDeletionUpdates(itemOrData) {
  const source = itemOrData?.toObject?.() ?? itemOrData ?? {};
  if (!hasSlotRequirementSource(source)) return {};
  const creatureOptions = getCreatureOptions();
  const validEquipmentKeys = getCreatureEquipmentSlotSelectionKeys(creatureOptions);
  const validWeaponKeys = getCreatureWeaponSlotSelectionKeys(creatureOptions);
  return {
    ...getSlotRequirementRecordDeletionUpdates("system.occupiedSlots", source.system?.occupiedSlots, validEquipmentKeys),
    ...getSlotRequirementRecordDeletionUpdates("system.weaponSlotRequirement.slots", source.system?.weaponSlotRequirement?.slots, validWeaponKeys)
  };
}

function hasSlotRequirementSource(source = {}) {
  return Boolean(source.system?.occupiedSlots || source.system?.weaponSlotRequirement?.slots);
}

function getSlotRequirementRecordDeletionUpdates(path, slots = {}, validKeys = new Set()) {
  const updates = {};
  for (const [key, selected] of Object.entries(slots ?? {})) {
    if (selected && validKeys.has(key)) continue;
    updates[`${path}.${key}`] = globalThis._del;
  }
  return updates;
}
