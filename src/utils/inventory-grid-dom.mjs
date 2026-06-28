import {
  ROOT_CONTAINER_ID,
  buildInventoryCellStyle
} from "./inventory-containers.mjs";
import { toInteger } from "./numbers.mjs";

const VIRTUAL_CELL_CLASS = "fallout-maw-inventory-virtual-cell";
const PLACEMENT_PREVIEW_CLASS = "fallout-maw-inventory-placement-preview";

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
  const styles = globalThis.getComputedStyle?.(grid);
  const gapX = readPixelValue(styles?.columnGap) || readPixelValue(styles?.gap) || 0;
  const gapY = readPixelValue(styles?.rowGap) || readPixelValue(styles?.gap) || gapX;
  const cellWidth = Math.max(1, (rect.width - (gapX * Math.max(0, columnCount - 1))) / columnCount);
  const cellHeight = Math.max(1, (rect.height - (gapY * Math.max(0, rowCount - 1))) / rowCount);
  const stepX = cellWidth + gapX;
  const stepY = cellHeight + gapY;
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
  let cell = grid.querySelector(`:scope > .${VIRTUAL_CELL_CLASS}`);
  if (!cell) {
    cell = document.createElement("div");
    cell.className = `fallout-maw-inventory-cell ${VIRTUAL_CELL_CLASS}`;
    cell.dataset.inventoryCell = "";
    cell.dataset.dropZone = "";
    grid.append(cell);
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
  root?.querySelectorAll?.(`.${VIRTUAL_CELL_CLASS}`).forEach(element => element.remove());
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
