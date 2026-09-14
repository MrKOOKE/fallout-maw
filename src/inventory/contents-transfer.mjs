import {
  BUTCHERING_STORAGE_PARENT_ID, LOCKED_STORAGE_PARENT_ID,
  getContextInventoryItems, getItemQuantity, getItemStackParts,
  getItemStackAvailableSpace, getItemFootprint, hasContainerCycle, usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { canStackInventoryItems } from "./stacking.mjs";
import { planContentsPlacements } from "./contents-packing.mjs";

export function isSameContentsZone(source, target) {
  return source.actor?.uuid === target.actor?.uuid && source.parentId === target.parentId
    && source.kind === target.kind;
}

/** Snapshot direct contents only: a nested container travels with its tree once. */
export function getContentsTransferEntries(actor, parentId = "") {
  return getContextInventoryItems(parentId, actor.items)
    .map(item => ({ item, footprint: getItemFootprint(item, actor.items) }))
    .sort((a, b) => b.footprint.width * b.footprint.height - a.footprint.width * a.footprint.height)
    .flatMap(({ item }) => {
      const parts = usesVirtualInventoryStacks(item) ? getItemStackParts(item) : [{ quantity: getItemQuantity(item) }];
      // Removing a later virtual part does not renumber any earlier pending part.
      return parts.map((part, sourceStackIndex) => ({
        itemId: item.id, sourceStackIndex, quantity: part.quantity,
        rotated: Boolean(part.rotated ?? item.system?.placement?.rotated)
      })).reverse();
    });
}

export async function transferInventoryContents({ source, target, canTransfer, move }) {
  const result = { moved: 0, failed: 0, errors: [] };
  if (isSameContentsZone(source, target) || !canTransfer(source, target)) return result;
  const entries = getContentsTransferEntries(source.actor, source.parentId);
  let placements = [];
  let planStart = 0;
  let needsPlan = true;
  for (const [index, entry] of entries.entries()) {
    if (!canTransfer(source, target)) {
      result.failed += entries.length - result.moved - result.failed;
      break;
    }
    const item = source.actor.items.get(entry.itemId);
    if (!item || !getContextInventoryItems(source.parentId, source.actor.items).some(i => i.id === item.id)) {
      needsPlan = true;
      continue;
    }
    if (source.actor.uuid === target.actor.uuid && hasContainerCycle(item, target.parentId, source.actor.items)) {
      result.failed += 1;
      continue;
    }
    const stackTarget = target.kind === "offer" ? null : getContextInventoryItems(target.parentId, target.actor.items)
      .find(candidate => !(source.actor.uuid === target.actor.uuid && candidate.id === item.id)
        && getItemStackAvailableSpace(candidate) > 0 && canStackInventoryItems(item, candidate));
    try {
      if (needsPlan) {
        placements = planContentsPlacements(source, target, entries.slice(index));
        planStart = index;
        needsPlan = false;
      }
      const placement = placements[index - planStart];
      const mergesEntirely = stackTarget && getItemStackAvailableSpace(stackTarget) >= entry.quantity;
      const moved = await move({
        sourceActorUuid: source.actor.uuid, targetActorUuid: target.actor.uuid,
        itemId: item.id, targetMode: target.parentId === LOCKED_STORAGE_PARENT_ID ? "lockedStorage" : "inventory",
        targetParentId: target.parentId, targetItemId: stackTarget?.id ?? "",
        sourceStackIndex: entry.sourceStackIndex, quantity: entry.quantity,
        targetX: placement?.x ?? null, targetY: placement?.y ?? null,
        targetRotated: placement?.rotated ?? entry.rotated
      }, { source, target, item });
      if (moved === false) { result.failed += 1; needsPlan = true; }
      else result.moved += 1;
      if (mergesEntirely || !placement) needsPlan = true;
    } catch (error) {
      result.failed += 1;
      needsPlan = true;
      if (error?.message && !result.errors.includes(error.message)) result.errors.push(error.message);
    }
  }
  return result;
}

export function canTransferOwnedContents(source, target) {
  return Boolean(source.actor?.isOwner && target.actor?.isOwner && target.kind !== "offer"
    && source.parentId !== BUTCHERING_STORAGE_PARENT_ID && target.parentId !== BUTCHERING_STORAGE_PARENT_ID);
}

export async function transferOwnedInventoryContents({ source, target }) {
  const { requestInventoryContentsTransfer } = await import("../apps/search-inventory.mjs");
  return requestInventoryContentsTransfer({
    ownedContents: true, sourceActorUuid: source.actor.uuid, targetActorUuid: target.actor.uuid,
    sourceParentId: source.parentId, targetParentId: target.parentId
  });
}
