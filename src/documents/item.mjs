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
  getItemContainerParentId,
  getItemFootprint,
  getItemStackParts,
  getItemTotalWeight,
  isContainerItem,
  isInventoryPlacementAvailable,
  normalizeInventoryPlacement,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import {
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions
} from "../utils/actor-display-data.mjs";
import { DISEASE_CREATE_OPTION, TRAUMA_CREATE_OPTION } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { migrateItemData } from "../migrations/documents.mjs";
import { handleItemDamageUpdate } from "../combat/damage-hub.mjs";
import {
  cleanBooleanSlotSelections,
  getCreatureEquipmentSlotSelectionKeys,
  getCreatureWeaponSlotSelectionKeys
} from "../utils/equipment-slots.mjs";

const MANUALLY_CREATABLE_ITEM_TYPES = Object.freeze(["gear", "ability"]);

export class FalloutMaWItem extends Item {
  static TRAUMA_CREATE_OPTION = TRAUMA_CREATE_OPTION;
  static DISEASE_CREATE_OPTION = DISEASE_CREATE_OPTION;

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

  static migrateData(source) {
    source = super.migrateData(source);
    return migrateItemData(source);
  }

  _initializeSource(data, options = {}) {
    if (["weapon", "armor"].includes(data?.type)) {
      data.type = "gear";
    }
    return super._initializeSource(data, options);
  }

  async _preCreate(data, options, user) {
    if ((await super._preCreate(data, options, user)) === false) return false;
    this.updateSource(getCleanSlotRequirementSource(this));
    if (this.type === "trauma" && options?.[TRAUMA_CREATE_OPTION] !== true) {
      ui.notifications?.warn?.("Травмы создаются только системой при получении повреждения.");
      return false;
    }
    if (this.type === "disease" && options?.[DISEASE_CREATE_OPTION] !== true) {
      ui.notifications?.warn?.("Болезни создаются только системой.");
      return false;
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
      const stackParts = prepareUpdatedStackParts(this, this.toObject(), { repack: true });
      if (!stackParts) {
        ui.notifications?.warn?.(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
        return false;
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
    if ((await super._preUpdate(changes, options, user)) === false) return false;

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
        return false;
      }
      foundry.utils.setProperty(changes, "system.stackParts", stackParts);
      const primaryPart = stackParts[0] ?? null;
      if (primaryPart?.x && primaryPart?.y) {
        foundry.utils.setProperty(changes, "system.placement.x", primaryPart.x);
        foundry.utils.setProperty(changes, "system.placement.y", primaryPart.y);
        foundry.utils.setProperty(changes, "system.placement.rotated", Boolean(primaryPart.rotated));
      }
    }

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
    updates[`${path}.-=${key}`] = null;
  }
  return updates;
}
