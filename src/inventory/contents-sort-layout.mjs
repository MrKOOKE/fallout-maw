import { localize as auditLocalize } from "../utils/i18n.mjs";
import { getItemFootprint, isInventoryPlacementWithinBounds } from "../utils/inventory-containers.mjs";

const noSpace = () => new Error(auditLocalize("FALLOUTMAW.AuditRuntime.R1098", "Недостаточно места для выбранного порядка. Предметы остались на месте."));

function prepareEntries(entries, grid, allItems) {
  const turnedShapes = new Map();
  return entries.map((entry, order) => {
    let shape = { width: entry.width, height: entry.height, rotated: false };
    // Use the normal orientation unless the context itself requires a turn.
    if (shape.width > grid.columns || (!grid.allowOverflowRows && shape.height > grid.rows)) {
      if (!turnedShapes.has(entry.item.id)) {
        const item = entry.item;
        turnedShapes.set(item.id, { ...getItemFootprint({ id: item.id, type: item.type, system: {
          ...item.system, placement: { ...item.system?.placement, rotated: true }
        } }, allItems), rotated: true });
      }
      shape = turnedShapes.get(entry.item.id);
    }
    if (shape.width > grid.columns || (!grid.allowOverflowRows && shape.height > grid.rows)) throw noSpace();
    return { ...entry, ...shape, order };
  });
}

/** Every category/proficiency has its own rows, covered along the whole left edge. */
function layoutCategories(entries, grid) {
  const groups = [];
  for (const entry of entries) {
    const key = JSON.stringify([entry.item.system?.itemCategory ?? "", entry.subcategory?.label ?? ""]);
    let group = groups.at(-1);
    if (group?.key !== key) {
      group = { key, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  const placements = Array(entries.length);
  const bands = [];
  let bottom = 0, checks = 0;
  for (const group of groups) {
    const rows = [];
    const frontiers = new Map();
    const startY = bottom + 1;
    // The first card sets the row height and covers x=1 for its entire height.
    // Smaller cards of this same group may fill the remaining width to its right.
    group.entries.sort((a, b) => b.height - a.height || b.width - a.width || a.order - b.order);
    for (const entry of group.entries) {
      const key = entry.width + ":" + entry.height;
      let placement = null;
      const firstRow = grid.zones?.length ? 0 : frontiers.get(key) ?? 0;
      for (let index = firstRow; index < rows.length; index++) {
        const row = rows[index];
        if (row.nextX + entry.width - 1 > grid.columns) continue;
        const candidate = { x: row.nextX, y: row.y, width: entry.width, height: entry.height, rotated: entry.rotated };
        checks++;
        if (!isInventoryPlacementWithinBounds(candidate, grid.columns, grid.rows, grid)) continue;
        placement = candidate;
        row.nextX += entry.width;
        frontiers.set(key, index);
        break;
      }
      if (!placement) {
        placement = { x: 1, y: bottom + 1, width: entry.width, height: entry.height, rotated: entry.rotated };
        checks++;
        if (!isInventoryPlacementWithinBounds(placement, grid.columns, grid.rows, grid)) throw noSpace();
        rows.push({ y: placement.y, nextX: entry.width + 1 });
        frontiers.set(key, rows.length - 1);
        bottom += entry.height;
      }
      placements[entry.order] = { ...entry, placement };
    }
    bands.push({ category: group.entries[0].item.system?.itemCategory ?? "", subcategory: group.entries[0].subcategory?.label ?? "",
      startY, bottom, rows: rows.length, entryCount: group.entries.length });
  }
  return { placements, stats: { algorithm: "category-rows", passes: 1, candidateChecks: checks, bands } };
}

/** One ordered pass. Every rectangle takes the first legal free position. */
function layoutDense(entries, grid) {
  const occupied = new Map();
  const frontiers = new Map();
  const useMasks = grid.columns <= 32;
  let bottom = 0, checks = 0;
  const placements = [];
  const maskFor = placement => (0xffffffff >>> (32 - placement.width)) << (placement.x - 1);
  const isFree = placement => {
    if (!isInventoryPlacementWithinBounds(placement, grid.columns, grid.rows, grid)) return false;
    const mask = useMasks ? maskFor(placement) : 0;
    for (let y = placement.y; y < placement.y + placement.height; y++) {
      const row = occupied.get(y);
      if (!row) continue;
      if (useMasks) {
        if ((row & mask) !== 0) return false;
      } else {
        for (let x = placement.x; x < placement.x + placement.width; x++) if (row.has(x)) return false;
      }
    }
    return true;
  };
  const reserve = placement => {
    const mask = useMasks ? maskFor(placement) : 0;
    for (let y = placement.y; y < placement.y + placement.height; y++) {
      if (useMasks) occupied.set(y, ((occupied.get(y) ?? 0) | mask) >>> 0);
      else {
        let row = occupied.get(y);
        if (!row) { row = new Set(); occupied.set(y, row); }
        for (let x = placement.x; x < placement.x + placement.width; x++) row.add(x);
      }
    }
    bottom = Math.max(bottom, placement.y + placement.height - 1);
  };
  for (const entry of entries) {
    const key = entry.width + ":" + entry.height;
    const start = frontiers.get(key) ?? { x: 1, y: 1 };
    const lastRow = grid.allowOverflowRows ? bottom + 1 : grid.rows - entry.height + 1;
    let placement = null;
    for (let y = start.y; y <= lastRow && !placement; y++) {
      for (let x = y === start.y ? start.x : 1; x <= grid.columns - entry.width + 1; x++) {
        const candidate = { x, y, width: entry.width, height: entry.height, rotated: entry.rotated };
        checks++;
        if (isFree(candidate)) { placement = candidate; break; }
      }
    }
    if (!placement) throw noSpace();
    reserve(placement);
    // Occupancy only increases. Previously rejected positions for this exact
    // footprint stay unavailable, including pocket bounds, so skip them next time.
    frontiers.set(key, { x: placement.x + 1, y: placement.y });
    placements.push({ ...entry, placement });
  }
  return { placements, stats: { algorithm: "dense-first-free", passes: 1, candidateChecks: checks } };
}

export function planSortedContentsLayout(entries, mode, grid, allItems) {
  const prepared = prepareEntries(entries, grid, allItems);
  return mode === "category" ? layoutCategories(prepared, grid) : layoutDense(prepared, grid);
}
