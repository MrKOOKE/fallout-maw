import {
  ROOT_CONTAINER_ID,
  buildInventoryCellStyle
} from "./inventory-containers.mjs";
import { toInteger } from "./numbers.mjs";

const VIRTUAL_CELL_CLASS = "fallout-maw-inventory-virtual-cell";
const PLACEMENT_PREVIEW_CLASS = "fallout-maw-inventory-placement-preview";
const _virtualCellCoords = new WeakMap();
const _gridMetricsCache = new WeakMap();

export function getInventoryGridPointerPosition(event = null, grid = null, {
  columns = null,
  rows = null,
  allowOverflowRows = false,
  clamp = false
} = {}) {
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  if (!grid || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

  const rect = grid.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;

  const columnCount = Math.max(1, toInteger(columns) || readGridNumber(grid, "--fallout-maw-inventory-columns") || 1);
  const rowCount = Math.max(1, toInteger(rows) || readGridNumber(grid, "--fallout-maw-inventory-rows") || 1);
  const { stepX, stepY } = readGridLayoutMetrics(grid, rect, columnCount, rowCount);
  let x = Math.floor((clientX - rect.left) / stepX) + 1;
  let y = Math.floor((clientY - rect.top) / stepY) + 1;

  if (x < 1 || y < 1) return null;
  if (!clamp && (x > columnCount || (!allowOverflowRows && y > rowCount))) return null;

  x = Math.max(1, Math.min(columnCount, x));
  y = allowOverflowRows ? Math.max(1, y) : Math.max(1, Math.min(rowCount, y));
  return { x, y };
}

export function syncInventoryVirtualCell(grid = null, point = null, extraDataset = {}) {
  if (!grid || !point) return null;
  const x = Math.max(1, toInteger(point.x) || 1);
  const y = Math.max(1, toInteger(point.y) || 1);
  const previous = _virtualCellCoords.get(grid);
  if (previous?.x === x && previous?.y === y) {
    const existing = grid.querySelector(`:scope > .${VIRTUAL_CELL_CLASS}`);
    if (existing) return existing;
  } else {
    _virtualCellCoords.set(grid, { x, y });
  }

  let cell = grid.querySelector(`:scope > .${VIRTUAL_CELL_CLASS}`);
  if (!cell) {
    cell = document.createElement("div");
    cell.className = VIRTUAL_CELL_CLASS;
    cell.dataset.inventoryCell = "";
    cell.dataset.dropZone = "";
    grid.append(cell);
  } else if (cell.classList.contains("fallout-maw-inventory-cell")) {
    cell.classList.remove("fallout-maw-inventory-cell");
  }

  cell.dataset.x = String(x);
  cell.dataset.y = String(y);
  cell.dataset.inventoryParentId = String(
    extraDataset.inventoryParentId
    ?? grid.dataset.inventoryParentId
    ?? ROOT_CONTAINER_ID
  );
  copyDatasetValue(cell, grid, extraDataset, "searchDropZone");
  copyDatasetValue(cell, grid, extraDataset, "searchActorUuid");
  copyDatasetValue(cell, grid, extraDataset, "tradeOfferActorUuid");
  copyDatasetValue(cell, grid, extraDataset, "actorContainerCell");
  copyDatasetValue(cell, grid, extraDataset, "travelUnitId");
  copyDatasetValue(cell, grid, extraDataset, "vehicleActorUuid");
  copyDatasetValue(cell, grid, extraDataset, "slotId");
  copyDatasetValue(cell, grid, extraDataset, "slotIndex");
  cell.setAttribute("style", buildInventoryCellStyle(x, y));
  return cell;
}

export function renderInventoryPlacementPreview(grid = null, placement = null, {
  className = "drop-preview",
  kind = "placement"
} = {}) {
  if (!grid || !placement) return null;
  let preview = grid.querySelector(`:scope > .${PLACEMENT_PREVIEW_CLASS}[data-preview-kind="${CSS.escape(kind)}"]`);
  if (!preview) {
    preview = document.createElement("div");
    preview.className = `${PLACEMENT_PREVIEW_CLASS} ${className}`;
    preview.dataset.previewKind = kind;
    grid.append(preview);
  }
  preview.className = `${PLACEMENT_PREVIEW_CLASS} ${className}`;
  preview.setAttribute("style", buildInventoryCellStyle(placement.x, placement.y, placement));
  return preview;
}

export function clearInventoryPlacementPreviews(root = null) {
  root?.querySelectorAll?.(`.${PLACEMENT_PREVIEW_CLASS}`).forEach(element => element.remove());
}

export function clearInventoryVirtualCells(root = null) {
  root?.querySelectorAll?.(`.${VIRTUAL_CELL_CLASS}`).forEach(element => {
    const grid = element.parentElement;
    if (grid) _virtualCellCoords.delete(grid);
    element.remove();
  });
}

function readGridLayoutMetrics(grid, rect, columnCount, rowCount) {
  const width = Number(rect?.width) || 0;
  const height = Number(rect?.height) || 0;
  const cached = _gridMetricsCache.get(grid);
  if (
    cached
    && cached.width === width
    && cached.height === height
    && cached.columnCount === columnCount
    && cached.rowCount === rowCount
  ) {
    return cached;
  }

  const styles = globalThis.getComputedStyle?.(grid);
  const gapX = readPixelValue(styles?.columnGap) || readPixelValue(styles?.gap) || 0;
  const gapY = readPixelValue(styles?.rowGap) || readPixelValue(styles?.gap) || gapX;
  const cellWidth = Math.max(1, (width - (gapX * Math.max(0, columnCount - 1))) / columnCount);
  const cellHeight = Math.max(1, (height - (gapY * Math.max(0, rowCount - 1))) / rowCount);
  const metrics = {
    width,
    height,
    columnCount,
    rowCount,
    gapX,
    gapY,
    cellWidth,
    cellHeight,
    stepX: cellWidth + gapX,
    stepY: cellHeight + gapY
  };
  _gridMetricsCache.set(grid, metrics);
  return metrics;
}

function copyDatasetValue(target, source, extraDataset, key) {
  if (Object.hasOwn(extraDataset, key)) {
    target.dataset[key] = String(extraDataset[key] ?? "");
    return;
  }
  if (source.dataset[key] !== undefined) target.dataset[key] = source.dataset[key];
  else delete target.dataset[key];
}

function readGridNumber(grid, property) {
  const inline = toInteger(grid.style?.getPropertyValue?.(property));
  if (inline > 0) return inline;
  const computed = toInteger(globalThis.getComputedStyle?.(grid)?.getPropertyValue?.(property));
  return computed > 0 ? computed : 0;
}

function readPixelValue(value) {
  const numeric = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(numeric) ? numeric : 0;
}
