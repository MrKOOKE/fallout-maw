import {
  createInventoryPlacement,
  getItemFootprint,
  isContainerItem
} from "./inventory-containers.mjs";
import { toInteger } from "./numbers.mjs";

/**
 * Resolve inventory placement under the pointer.
 * Preview mode (`findNearest: false`) only checks the preferred and anchor cells.
 * Drop mode (`findNearest: true`) expands outward from the preferred cell without scanning the full grid.
 */
export function resolveInventoryPointerPlacement({
  anchor = null,
  itemData = null,
  items = null,
  dimensions = {},
  options = {},
  sourceItem = null,
  findNearest = false,
  isPlacementAvailable = () => false
} = {}) {
  if (!anchor?.x || !anchor?.y || !itemData) return null;

  const basePlacement = createInventoryPlacement(1, 1, itemData, items);
  if (isContainerItem(itemData) && sourceItem) {
    const footprint = getItemFootprint(sourceItem, items);
    basePlacement.width = footprint.width;
    basePlacement.height = footprint.height;
  }

  const columns = Math.max(1, toInteger(dimensions.columns) || 1);
  const rows = Math.max(1, toInteger(dimensions.rows) || 1);
  const allowOverflowRows = Boolean(options.allowOverflowRows);
  const maxX = Math.max(1, columns - basePlacement.width + 1);
  const maxY = allowOverflowRows
    ? Math.max(1, rows - basePlacement.height + 1, Math.ceil(anchor.y) + 64)
    : Math.max(1, rows - basePlacement.height + 1);
  const preferredX = Math.max(1, Math.min(maxX, Math.round(anchor.x - ((basePlacement.width - 1) / 2))));
  const preferredY = allowOverflowRows
    ? Math.max(1, Math.round(anchor.y - ((basePlacement.height - 1) / 2)))
    : Math.max(1, Math.min(maxY, Math.round(anchor.y - ((basePlacement.height - 1) / 2))));
  const preferredPlacement = { ...basePlacement, x: preferredX, y: preferredY };

  if (isPlacementAvailable(preferredPlacement)) return preferredPlacement;

  const anchorPlacement = {
    ...basePlacement,
    x: Math.max(1, Math.min(maxX, toInteger(anchor.x) || preferredX)),
    y: allowOverflowRows
      ? Math.max(1, toInteger(anchor.y) || preferredY)
      : Math.max(1, Math.min(maxY, toInteger(anchor.y) || preferredY))
  };
  if (isPlacementAvailable(anchorPlacement)) return anchorPlacement;

  if (!findNearest) return null;
  return findNearestInventoryPlacement({
    basePlacement,
    preferredX,
    preferredY,
    maxX,
    maxY,
    isPlacementAvailable
  });
}

function findNearestInventoryPlacement({
  basePlacement,
  preferredX,
  preferredY,
  maxX,
  maxY,
  isPlacementAvailable
}) {
  const maxRadius = Math.max(maxX, maxY);
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    let foundAtRadius = false;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (const dy of [-radius, radius]) {
        const placement = buildBoundedPlacement(basePlacement, preferredX + dx, preferredY + dy, maxX, maxY);
        if (!placement) continue;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance >= bestDistance) continue;
        if (!isPlacementAvailable(placement)) continue;
        best = placement;
        bestDistance = distance;
        foundAtRadius = true;
      }
    }
    for (let dy = -radius + 1; dy <= radius - 1; dy += 1) {
      for (const dx of [-radius, radius]) {
        const placement = buildBoundedPlacement(basePlacement, preferredX + dx, preferredY + dy, maxX, maxY);
        if (!placement) continue;
        const distance = Math.abs(dx) + Math.abs(dy);
        if (distance >= bestDistance) continue;
        if (!isPlacementAvailable(placement)) continue;
        best = placement;
        bestDistance = distance;
        foundAtRadius = true;
      }
    }
    if (foundAtRadius) return best;
  }

  return best;
}

function buildBoundedPlacement(basePlacement, x, y, maxX, maxY) {
  if (x < 1 || y < 1 || x > maxX || y > maxY) return null;
  return { ...basePlacement, x, y };
}
