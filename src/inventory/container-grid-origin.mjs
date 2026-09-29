import {
  getContainerInventoryGridOptions,
  getItemContainerParentId,
  getItemId
} from "../utils/inventory-containers.mjs";

/** Keep direct contents in the same visual cells when an extra grid grows left or up. */
export function createContainerGridOriginShiftUpdates(beforeContainer, afterContainer, items) {
  const containerId = getItemId(beforeContainer);
  if (!containerId) return [];
  const before = getContainerInventoryGridOptions(beforeContainer);
  const after = getContainerInventoryGridOptions(afterContainer);
  const deltaX = (after.originShiftX ?? 0) - (before.originShiftX ?? 0);
  const deltaY = (after.originShiftY ?? 0) - (before.originShiftY ?? 0);
  if (!deltaX && !deltaY) return [];

  const shifted = (value, delta, bound) => {
    const coordinate = Number(value);
    if (!Number.isInteger(coordinate) || coordinate <= 0) return value;
    const next = coordinate + delta;
    // A cell in a removed left/top zone cannot have a nonpositive stored
    // coordinate. Park it beyond the new grid so the recovery grid shows it.
    return next > 0 ? next : bound + 1;
  };

  return Array.from(items?.contents ?? items ?? [])
    .filter(item => getItemContainerParentId(item) === containerId)
    .filter(item => String(item.system?.placement?.mode ?? "inventory") === "inventory")
    .map(item => {
      const update = { _id: getItemId(item) };
      const placement = item.system?.placement ?? {};
      if (deltaX && Number(placement.x) > 0) {
        update["system.placement.x"] = shifted(placement.x, deltaX, after.columns);
      }
      if (deltaY && Number(placement.y) > 0) {
        update["system.placement.y"] = shifted(placement.y, deltaY, after.rows);
      }
      const parts = item.system?.stackParts;
      if (Array.isArray(parts) && parts.length) {
        update["system.stackParts"] = parts.map(part => ({
          ...part,
          ...(deltaX && Number(part.x) > 0 ? { x: shifted(part.x, deltaX, after.columns) } : {}),
          ...(deltaY && Number(part.y) > 0 ? { y: shifted(part.y, deltaY, after.rows) } : {})
        }));
      }
      return update;
    })
    .filter(update => Object.keys(update).length > 1);
}
