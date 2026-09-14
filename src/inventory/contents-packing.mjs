import {
  createInventoryPlacementPlanner, getContainerInventoryGridOptions, getContextInventoryItems,
  getItemStackParts, getItemStackAvailableSpace, hasContainerCycle,
  LOCKED_STORAGE_PARENT_ID, usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { getActorInventoryGridDimensions, getActorRootInventoryGridOptions } from "../utils/actor-inventory-size.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { canStackInventoryItems } from "./stacking.mjs";

/** The whole incoming group is planned against fixed, live destination contents. */
export function planContentsPlacements(source, target, entries) {
  // Offers keep a separate projected grid; its automatic placement uses the same geometry.
  if (target.kind === "offer") return [];
  const locked = target.parentId === LOCKED_STORAGE_PARENT_ID;
  const race = !target.parentId || locked
    ? getCreatureOptions().races.find(r => r.id === target.actor.system?.creature?.raceId) : null;
  const dimensions = target.parentId && !locked
    ? getContainerInventoryGridOptions(target.actor.items.get(target.parentId))
    : getActorInventoryGridDimensions(target.actor, race);
  const options = locked
    ? { allowOverflowRows: true, placementMode: "lockedStorage", preferredPlacementModes: ["lockedStorage"] }
    : target.parentId ? dimensions : getActorRootInventoryGridOptions(target.actor);
  const contents = getContextInventoryItems(target.parentId, target.actor.items);
  const planner = createInventoryPlacementPlanner(contents, dimensions.columns, dimensions.rows, target.actor.items, [], options);
  if (!planner) return [];
  const capacity = new Map(contents.map(item => [item, getItemStackAvailableSpace(item)]));
  const candidates = [];
  const indices = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const item = source.actor.items.get(entry.itemId);
    if (!item || (source.actor.uuid === target.actor.uuid && hasContainerCycle(item, target.parentId, source.actor.items))) continue;
    let remaining = entry.quantity;
    for (const [stack, space] of capacity) {
      if (!space || !canStackInventoryItems(item, stack)) continue;
      const merged = Math.min(space, remaining);
      capacity.set(stack, space - merged);
      remaining -= merged;
      break;
    }
    if (!remaining) continue;
    const part = usesVirtualInventoryStacks(item) ? getItemStackParts(item)[entry.sourceStackIndex] : null;
    const data = { id: item.id, _id: item.id, type: item.type, system: { ...item.system, placement: {
      ...item.system?.placement, rotated: part?.rotated ?? item.system?.placement?.rotated
    } } };
    candidates.push(data);
    indices.push(index);
  }
  const result = [];
  for (const [i, placement] of planner.packAndReserve(candidates, source.actor.items).entries()) result[indices[i]] = placement;
  return result;
}
