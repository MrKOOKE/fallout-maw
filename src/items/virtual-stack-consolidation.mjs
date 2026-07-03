import { getCreatureOptions } from "../settings/accessors.mjs";
import {
  getItemContainerParentId,
  getItemFootprint,
  getItemMaxStack,
  createItemStackPartsForQuantity,
  getItemStackParts,
  isContainerItem,
  isItemLocked,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import {
  getWeaponSlotRequirement,
  getValidSelectedEquipmentSlotKeysForOptions
} from "../utils/equipment-slots.mjs";
import { toInteger } from "../utils/numbers.mjs";

const pendingActorIds = new Set();
const legacyRepackActorIds = new Set();
let consolidationTimeout = null;
let consolidating = false;

export function registerVirtualStackConsolidationHooks() {
  Hooks.once("ready", () => {
    if (!game.user?.isActiveGM) return;
    for (const actor of game.actors ?? []) {
      if (actor?.id) legacyRepackActorIds.add(actor.id);
      queueActorVirtualStackConsolidation(actor);
    }
  });

  Hooks.on("createItem", item => {
    if (!game.user?.isActiveGM || !usesVirtualInventoryStacks(item)) return;
    queueActorVirtualStackConsolidation(item.parent);
  });

  Hooks.on("updateItem", item => {
    if (!game.user?.isActiveGM || !usesVirtualInventoryStacks(item)) return;
    queueActorVirtualStackConsolidation(item.parent);
  });
}

function queueActorVirtualStackConsolidation(actor = null) {
  if (!actor?.id || !actor.items) return;
  pendingActorIds.add(actor.id);
  if (consolidationTimeout) return;
  consolidationTimeout = setTimeout(() => void flushVirtualStackConsolidationQueue(), 100);
}

async function flushVirtualStackConsolidationQueue() {
  if (consolidating) return;
  consolidating = true;
  consolidationTimeout = null;
  const actorIds = Array.from(pendingActorIds);
  pendingActorIds.clear();
  try {
    for (const actorId of actorIds) {
      const actor = game.actors?.get(actorId);
      if (actor) await consolidateActorVirtualInventoryStacks(actor);
    }
  } finally {
    consolidating = false;
    if (pendingActorIds.size) consolidationTimeout = setTimeout(() => void flushVirtualStackConsolidationQueue(), 100);
  }
}

async function consolidateActorVirtualInventoryStacks(actor) {
  const items = actor?.items?.contents ?? [];
  const groups = new Map();
  for (const item of items) {
    if (!usesVirtualInventoryStacks(item)) continue;
    if (isContainerItem(item)) continue;
    const placementMode = String(item.system?.placement?.mode ?? "");
    if (placementMode && !["inventory", "lockedStorage", "butcheringStorage"].includes(placementMode)) continue;
    const key = createVirtualStackGroupKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) {
      const item = group[0];
      if (!item || !legacyRepackActorIds.has(actor.id) || !shouldRepackLegacyStackParts(item)) continue;
      const legacyParts = getStackPartsWithPlacementFallback(item);
      const stackParts = repackStackPartsWithLegacyPlacements(item, legacyParts);
      const updateData = {
        _id: item.id,
        "system.stackParts": stackParts
      };
      const firstPart = stackParts[0];
      if (firstPart && toInteger(firstPart.x) > 0 && toInteger(firstPart.y) > 0) {
        updateData["system.placement.x"] = toInteger(firstPart.x);
        updateData["system.placement.y"] = toInteger(firstPart.y);
        updateData["system.placement.rotated"] = Boolean(firstPart.rotated);
      }
      await actor.updateEmbeddedDocuments("Item", [updateData], { render: false });
      continue;
    }
    const [primary, ...rest] = group;
    const legacyParts = group.flatMap(item => getStackPartsWithPlacementFallback(item));
    const quantity = legacyParts.reduce((total, part) => total + Math.max(1, toInteger(part.quantity)), 0);
    const stackParts = repackStackPartsWithLegacyPlacements(primary, legacyParts, quantity);
    const updateData = {
      _id: primary.id,
      "system.quantity": quantity,
      "system.stackParts": stackParts
    };
    const firstPart = stackParts[0];
    if (firstPart && toInteger(firstPart.x) > 0 && toInteger(firstPart.y) > 0) {
      updateData["system.placement.x"] = toInteger(firstPart.x);
      updateData["system.placement.y"] = toInteger(firstPart.y);
      updateData["system.placement.rotated"] = Boolean(firstPart.rotated);
    }
    await actor.updateEmbeddedDocuments("Item", [updateData], { render: false });
    await actor.deleteEmbeddedDocuments("Item", rest.map(item => item.id), { render: false });
  }
  legacyRepackActorIds.delete(actor.id);
}

function shouldRepackLegacyStackParts(item) {
  const parts = getItemStackParts(item);
  const canonicalLength = createItemStackPartsForQuantity(item).length;
  return parts.length > canonicalLength + 2;
}

function repackStackPartsWithLegacyPlacements(item, legacyParts = [], quantity = null) {
  const totalQuantity = quantity ?? legacyParts.reduce((total, part) => total + Math.max(1, toInteger(part.quantity)), 0);
  return createItemStackPartsForQuantity(item, totalQuantity).map((part, index) => {
    const placementPart = legacyParts[index] ?? null;
    if (!placementPart) return part;
    const next = { ...part };
    if (toInteger(placementPart.x) > 0) next.x = toInteger(placementPart.x);
    if (toInteger(placementPart.y) > 0) next.y = toInteger(placementPart.y);
    if (placementPart.rotated !== undefined && placementPart.rotated !== null) next.rotated = Boolean(placementPart.rotated);
    return next;
  });
}

function getStackPartsWithPlacementFallback(item) {
  const placement = item.system?.placement ?? {};
  return getItemStackParts(item).map((part, index) => {
    const result = { ...part };
    if (toInteger(result.x) <= 0 && index === 0 && toInteger(placement.x) > 0) result.x = toInteger(placement.x);
    if (toInteger(result.y) <= 0 && index === 0 && toInteger(placement.y) > 0) result.y = toInteger(placement.y);
    if (result.rotated === undefined || result.rotated === null) result.rotated = Boolean(placement.rotated);
    return result;
  });
}

function createVirtualStackGroupKey(item) {
  const system = item.system ?? {};
  const footprint = getItemFootprint(item);
  return JSON.stringify({
    type: item.type,
    name: item.name,
    img: item.img,
    parentId: getItemContainerParentId(item),
    placementMode: String(system.placement?.mode ?? ""),
    locked: isItemLocked(item),
    weight: Number(system.weight),
    price: Number(system.price),
    priceCurrency: String(system.priceCurrency ?? ""),
    maxStack: getItemMaxStack(item),
    width: footprint.width,
    height: footprint.height,
    equipmentSlots: serializeSet(getValidSelectedEquipmentSlotKeysForOptions(getCreatureOptions(), system)),
    weaponSlots: serializeWeaponSlotRequirement(system),
    functions: normalizeStackComparableValue(system.functions)
  });
}

function serializeSet(set) {
  return Array.from(set ?? []).sort().join("|");
}

function serializeWeaponSlotRequirement(system = {}) {
  return JSON.stringify(normalizeStackComparableValue(getWeaponSlotRequirement(system)));
}

function normalizeStackComparableValue(value) {
  if (typeof value?.toObject === "function") return normalizeStackComparableValue(value.toObject(false));
  if (value instanceof Set) return Array.from(value).sort();
  if (Array.isArray(value)) return value.map(entry => normalizeStackComparableValue(entry));
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, normalizeStackComparableValue(entryValue)])
  );
}
