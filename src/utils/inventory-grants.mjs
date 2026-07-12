import { getCreatureOptions } from "../settings/accessors.mjs";
import {
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions
} from "./actor-display-data.mjs";
import {
  getValidSelectedEquipmentSlotKeysForOptions,
  getValidSelectedWeaponSlotKeysForOptions,
  getWeaponSlotRequirement
} from "./equipment-slots.mjs";
import {
  ROOT_CONTAINER_ID,
  createAnchoredItemStackPartsForQuantity,
  createItemStackPartAdditionUpdate,
  createStoredPlacement,
  findFirstAvailableResolvedInventoryPlacement,
  getContainerContentsWeight,
  getContainerInventoryGridOptions,
  getContainerMaxLoad,
  getContextInventoryItems,
  getItemActorLoadWeight,
  getItemContainerParentId,
  getItemFootprint,
  getItemMaxStack,
  getItemQuantity,
  getItemStackAdditionOverflowQuantity,
  getItemUnitWeight,
  isContainerItem,
  isItemLocked,
  normalizeInventoryPlacement,
  usesVirtualInventoryStacks
} from "./inventory-containers.mjs";
import { toInteger } from "./numbers.mjs";

/**
 * Grant ordinary item data into an actor inventory while preserving the virtual-stack invariant.
 * Compatible virtual items remain one Item document; only overflow receives new grid placements.
 */
export async function grantActorInventoryItem(actor, itemOrData, {
  quantity = getItemQuantity(itemOrData),
  parentId = ROOT_CONTAINER_ID,
  preferredPlacement = null,
  merge = true
} = {}) {
  if (!actor?.createEmbeddedDocuments || !itemOrData || isContainerItem(itemOrData)) return null;

  const grantQuantity = Math.max(1, toInteger(quantity) || getItemQuantity(itemOrData) || 1);
  const itemData = prepareGrantItemData(itemOrData, grantQuantity, parentId);
  const context = getGrantInventoryContext(actor, parentId);
  if (!context) throwInventoryNoSpace();
  if (parentId) {
    const container = actor.items?.get(parentId);
    const nextWeight = getContainerContentsWeight(container, actor.items) + (getItemUnitWeight(itemData) * grantQuantity);
    if (nextWeight > (getContainerMaxLoad(container) + 0.0001)) throwInventoryNoSpace();
  }
  const contextItems = getContextInventoryItems(parentId, actor.items);
  const normalizedPreferredPlacement = preferredPlacement
    ? normalizeInventoryPlacement(preferredPlacement, itemData, actor.items)
    : null;

  if (usesVirtualInventoryStacks(itemData)) {
    const target = merge
      ? contextItems.find(candidate => (
        usesVirtualInventoryStacks(candidate)
        && areInventoryItemsStackCompatible(itemData, candidate)
      )) ?? null
      : null;
    const overflowQuantity = target
      ? getItemStackAdditionOverflowQuantity(target, grantQuantity)
      : grantQuantity;
    const stackParts = createAnchoredItemStackPartsForQuantity({
      itemData,
      quantity: overflowQuantity,
      preferredPlacement: normalizedPreferredPlacement,
      contextItems,
      columns: context.columns,
      rows: context.rows,
      allItems: actor.items,
      options: context.options
    });
    if (!stackParts) throwInventoryNoSpace();

    if (target) {
      const update = createItemStackPartAdditionUpdate(target, grantQuantity, null, stackParts);
      if (!update) return target;
      if (!validateActorGrantLoad(actor, { updates: [update] })) throwActorLoadLimit();
      await actor.updateEmbeddedDocuments("Item", [update]);
      return actor.items.get(target.id) ?? target;
    }

    const createData = createGrantedInventoryItemData(
      itemData,
      grantQuantity,
      parentId,
      stackParts[0],
      stackParts
    );
    if (!validateActorGrantLoad(actor, { creates: [createData] })) throwActorLoadLimit();
    const created = await actor.createEmbeddedDocuments("Item", [createData]);
    return created?.[0] ?? null;
  }

  let remaining = grantQuantity;
  const updates = [];
  if (merge) {
    for (const target of contextItems) {
      if (!areInventoryItemsStackCompatible(itemData, target)) continue;
      const available = Math.max(0, getItemMaxStack(target) - getItemQuantity(target));
      const added = Math.min(remaining, available);
      if (!added) continue;
      updates.push({
        _id: target.id,
        "system.quantity": getItemQuantity(target) + added
      });
      remaining -= added;
      if (!remaining) break;
    }
  }

  const creates = [];
  const reservedPlacements = [];
  let firstPlacement = normalizedPreferredPlacement;
  const maxStack = getItemMaxStack(itemData);
  while (remaining > 0) {
    const stackQuantity = Math.min(remaining, maxStack);
    const placement = firstPlacement ?? findFirstAvailableResolvedInventoryPlacement(
      contextItems,
      context.columns,
      context.rows,
      itemData,
      actor.items,
      [],
      reservedPlacements,
      context.options
    );
    if (!placement) throwInventoryNoSpace();
    creates.push(createGrantedInventoryItemData(itemData, stackQuantity, parentId, placement, []));
    reservedPlacements.push(placement);
    firstPlacement = null;
    remaining -= stackQuantity;
  }

  if (!validateActorGrantLoad(actor, { updates, creates })) throwActorLoadLimit();
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  const created = creates.length ? await actor.createEmbeddedDocuments("Item", creates) : [];
  if (created?.length) return created[0];
  return updates.length ? actor.items.get(updates[0]._id) ?? null : null;
}

export function areInventoryItemsStackCompatible(sourceData, targetItem) {
  if (!sourceData || !targetItem) return false;
  const sourceSystem = sourceData.system ?? {};
  const targetSystem = targetItem.system ?? {};
  const creatureOptions = getCreatureOptions();
  return (
    sourceData.type === targetItem.type
    && !isContainerItem(sourceData)
    && !isContainerItem(targetItem)
    && sourceData.name === targetItem.name
    && sourceData.img === targetItem.img
    && isItemLocked(sourceData) === isItemLocked(targetItem)
    && Number(sourceSystem.weight) === Number(targetSystem.weight)
    && Number(sourceSystem.price) === Number(targetSystem.price)
    && String(sourceSystem.priceCurrency ?? "") === String(targetSystem.priceCurrency ?? "")
    && getItemMaxStack(sourceSystem) === getItemMaxStack(targetSystem)
    && getItemFootprint(sourceSystem).width === getItemFootprint(targetSystem).width
    && getItemFootprint(sourceSystem).height === getItemFootprint(targetSystem).height
    && serializeSet(getValidSelectedEquipmentSlotKeysForOptions(creatureOptions, sourceSystem)) === serializeSet(getValidSelectedEquipmentSlotKeysForOptions(creatureOptions, targetSystem))
    && serializeWeaponSlotRequirement(sourceSystem, creatureOptions) === serializeWeaponSlotRequirement(targetSystem, creatureOptions)
    && serializeItemFunctions(sourceSystem.functions) === serializeItemFunctions(targetSystem.functions)
  );
}

function prepareGrantItemData(itemOrData, quantity, parentId) {
  const source = itemOrData?.toObject?.() ?? itemOrData;
  const itemData = foundry.utils.deepClone(source);
  delete itemData._id;
  delete itemData.id;
  foundry.utils.setProperty(itemData, "system.quantity", quantity);
  foundry.utils.setProperty(itemData, "system.equipped", false);
  foundry.utils.setProperty(itemData, "system.container.parentId", String(parentId ?? ""));
  foundry.utils.setProperty(itemData, "system.placement.mode", "inventory");
  foundry.utils.setProperty(itemData, "system.placement.equipmentSlot", "");
  foundry.utils.setProperty(itemData, "system.placement.weaponSet", "");
  foundry.utils.setProperty(itemData, "system.placement.weaponSlot", "");
  foundry.utils.setProperty(itemData, "system.placement.limbKey", "");
  foundry.utils.setProperty(itemData, "system.stackParts", []);
  return itemData;
}

function createGrantedInventoryItemData(itemData, quantity, parentId, placement, stackParts = []) {
  const createData = foundry.utils.deepClone(itemData);
  delete createData._id;
  delete createData.id;
  const storedPlacement = createStoredPlacement(placement, createData);
  foundry.utils.setProperty(createData, "system.quantity", quantity);
  foundry.utils.setProperty(createData, "system.equipped", false);
  foundry.utils.setProperty(createData, "system.container.parentId", String(parentId ?? ""));
  foundry.utils.setProperty(createData, "system.placement", storedPlacement);
  foundry.utils.setProperty(createData, "system.stackParts", Array.isArray(stackParts) ? stackParts : []);
  return createData;
}

function getGrantInventoryContext(actor, parentId) {
  if (parentId) {
    const container = actor.items?.get(parentId);
    if (!container) return null;
    const options = getContainerInventoryGridOptions(container);
    return { columns: options.columns, rows: options.rows, options };
  }
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId) ?? null;
  const dimensions = getActorInventoryGridDimensions(actor, race);
  return {
    columns: dimensions.columns,
    rows: dimensions.rows,
    options: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
  };
}

function validateActorGrantLoad(actor, { updates = [], creates = [] } = {}) {
  const limit = getActorLoadLimit(actor);
  if (limit <= 0) return true;
  const currentItems = actor.items?.contents ?? Array.from(actor.items ?? []);
  const currentLoad = calculateActorLoad(currentItems);
  const projected = new Map(currentItems.map(item => [item.id, item.toObject()]));
  for (const update of updates) {
    const id = String(update?._id ?? "");
    const itemData = projected.get(id);
    if (!itemData) continue;
    for (const [path, value] of Object.entries(update)) {
      if (path === "_id") continue;
      foundry.utils.setProperty(itemData, path, value);
    }
  }
  let syntheticIndex = 0;
  for (const createData of creates) {
    const id = `synthetic-inventory-grant-${syntheticIndex += 1}`;
    const itemData = foundry.utils.deepClone(createData);
    itemData._id = id;
    itemData.id = id;
    projected.set(id, itemData);
  }
  const projectedLoad = calculateActorLoad(Array.from(projected.values()));
  return projectedLoad <= (limit + 0.0001) || projectedLoad <= (currentLoad + 0.0001);
}

function getActorLoadLimit(actor) {
  if (actor?.system?.trade?.infiniteInventory) return 0;
  const max = Number(actor?.system?.load?.max) || 0;
  const percent = Math.max(0, Number(actor?.system?.load?.limitPercent) || 0);
  if (max > 0 && percent > 0) return (max * percent) / 100;
  return Number(actor?.system?.load?.limit) || 0;
}

function calculateActorLoad(items = []) {
  const list = Array.isArray(items) ? items : Array.from(items ?? []);
  return Number(list.reduce((total, item) => (
    getItemContainerParentId(item)
      ? total
      : total + (Number(getItemActorLoadWeight(item, list)) || 0)
  ), 0).toFixed(1));
}

function serializeSet(set) {
  return Array.from(set).sort().join("|");
}

function serializeWeaponSlotRequirement(system = {}, creatureOptions = getCreatureOptions()) {
  const requirement = getWeaponSlotRequirement(system);
  return `${requirement.mode}:${serializeSet(getValidSelectedWeaponSlotKeysForOptions(creatureOptions, system))}`;
}

function serializeItemFunctions(functions = {}) {
  return JSON.stringify(normalizeStackComparableValue(functions));
}

function normalizeStackComparableValue(value) {
  if (typeof value?.toObject === "function") return normalizeStackComparableValue(value.toObject(false));
  if (value instanceof Set) return Array.from(value).sort();
  if (Array.isArray(value)) return value.map(entry => normalizeStackComparableValue(entry));
  if (!value || typeof value !== "object") return value ?? null;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, normalizeStackComparableValue(entryValue)]));
}

function throwInventoryNoSpace() {
  throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
}

function throwActorLoadLimit() {
  const key = "FALLOUTMAW.Messages.ActorLoadLimitExceeded";
  const localized = game.i18n.localize(key);
  throw new Error(localized === key ? "Актёр не может нести такой вес." : localized);
}
