// Geometry only: callers retain ownership, weight, stacking and mutation rules.
const right = r => r.x + r.width;
const bottom = r => r.y + r.height;
const area = r => r.width * r.height;
const overlaps = (a, b) => a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y;
const contains = (a, b) => a.x <= b.x && a.y <= b.y && right(a) >= right(b) && bottom(a) >= bottom(b);
const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

function subtract(rectangles, used) {
  const split = [];
  for (const r of rectangles) {
    if (!overlaps(r, used)) { split.push(r); continue; }
    if (used.x > r.x) split.push({ ...r, width: used.x - r.x });
    if (right(used) < right(r)) split.push({ ...r, x: right(used), width: right(r) - right(used) });
    if (used.y > r.y) split.push({ ...r, height: used.y - r.y });
    if (bottom(used) < bottom(r)) split.push({ ...r, y: bottom(used), height: bottom(r) - bottom(used) });
  }
  // Maximal free rectangles may overlap each other, but never occupied space.
  return split.filter((r, i) => !split.some((other, j) => i !== j
    && r.zone === other.zone && contains(other, r) && (!contains(r, other) || j < i)));
}

// Edge contact connects free space; touching at a corner does not. Pockets are
// separate regions even when their borders touch on the displayed grid.
function connected(a, b) {
  return (a.x <= right(b) && right(a) >= b.x && a.y < bottom(b) && bottom(a) > b.y)
    || (a.y <= bottom(b) && bottom(a) >= b.y && a.x < right(b) && right(a) > b.x);
}

function rectangleUnionArea(rectangles) {
  const xs = [...new Set(rectangles.flatMap(r => [r.x, right(r)]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < xs.length; i++) {
    const intervals = rectangles.filter(r => r.x < xs[i] && right(r) > xs[i - 1])
      .map(r => [r.y, bottom(r)]).sort((a, b) => a[0] - b[0]);
    let end = -Infinity;
    let height = 0;
    for (const [start, stop] of intervals) {
      height += Math.max(0, stop - Math.max(start, end));
      end = Math.max(end, stop);
    }
    total += (xs[i] - xs[i - 1]) * height;
  }
  return total;
}

function freeSpaceScore(rectangles) {
  const byZone = new Map();
  for (const r of rectangles) {
    if (!byZone.has(r.zone)) byZone.set(r.zone, []);
    byZone.get(r.zone).push(r);
  }
  let fragments = 0;
  let isolatedArea = 0;
  for (const zone of byZone.values()) {
    const remaining = new Set(zone);
    const components = [];
    while (remaining.size) {
      const group = [remaining.values().next().value];
      remaining.delete(group[0]);
      for (let i = 0; i < group.length; i++) {
        for (const next of remaining) {
          if (!connected(group[i], next)) continue;
          remaining.delete(next);
          group.push(next);
        }
      }
      components.push(group);
    }
    if (components.length <= 1) continue;
    fragments += components.length - 1;
    const areas = components.map(rectangleUnionArea);
    isolatedArea += areas.reduce((sum, value) => sum + value, 0) - Math.max(...areas);
  }
  return [fragments, isolatedArea];
}

/** Incremental free-space planner. Existing rectangles never move or rotate. */
export function createRectanglePacker({ columns, rows, occupied = [], zones = [], allowOverflowRows = false, strategy = "compact" }) {
  columns = Math.max(1, Math.trunc(columns) || 1);
  rows = Math.max(1, Math.trunc(rows) || 1);
  zones = Array.isArray(zones) ? zones : [];
  const used = [];
  const bounds = { width: 0, height: 0 };
  let free = [];
  const resetFree = () => {
    free = !allowOverflowRows && zones.length
      ? zones.map((z, zone) => ({ ...z, zone, zoneArea: area(z), base: Boolean(z.base) }))
        .filter(r => r.width > 0 && r.height > 0 && r.x >= 1 && r.y >= 1 && right(r) <= columns + 1 && bottom(r) <= rows + 1)
      : [{ x: 1, y: 1, width: columns, height: rows, zone: 0, zoneArea: 0, base: false }];
    for (const r of used) free = subtract(free, r);
  };
  const occupy = r => {
    used.push(r);
    bounds.width = Math.max(bounds.width, right(r) - 1);
    bounds.height = Math.max(bounds.height, bottom(r) - 1);
    free = subtract(free, r);
  };
  resetFree();
  for (const r of occupied) if (r) occupy(r);
  if (allowOverflowRows && bounds.height > rows) { rows = bounds.height; resetFree(); }

  const find = item => {
    // Callers supply legal orientations, including the real footprint of filled containers.
    const orientations = (item.orientations?.length ? item.orientations : [item])
      .filter(shape => shape.width > 0 && shape.height > 0 && shape.width <= columns);
    if (!orientations.length) return null;
    const search = () => {
      let best = null;
      let bestScore = null;
      for (const r of free) {
        for (const shape of orientations) {
          if (shape.width > r.width || shape.height > r.height) continue;
          const candidate = { x: r.x, y: r.y, width: shape.width, height: shape.height,
            ...(shape.rotated === undefined ? {} : { rotated: Boolean(shape.rotated) }) };
          const w = Math.max(bounds.width, right(candidate) - 1);
          const h = Math.max(bounds.height, bottom(candidate) - 1);
          const shortSide = Math.min(r.width - shape.width, r.height - shape.height);
          const longSide = Math.max(r.width - shape.width, r.height - shape.height);
          const turns = Number(Boolean(shape.rotated) !== Boolean(item.rotated));
          const fragmentation = strategy === "compact" ? freeSpaceScore(subtract(free, candidate)) : [];
          // Preserve small-pocket priority, saving the main compartment for bulky items.
          const score = strategy === "fit"
            ? [r.zoneArea, Number(r.base), shortSide, longSide, w * h, h, turns, r.y, r.x]
            : [r.zoneArea, Number(r.base), ...fragmentation, w * h, h, shortSide, longSide, turns, r.y, r.x];
          if (!bestScore || compare(score, bestScore) < 0) { best = candidate; bestScore = score; }
        }
      }
      return best;
    };
    let result = search();
    if (!result && allowOverflowRows) {
      const maxHeight = Math.max(...orientations.map(shape => shape.height));
      rows = Math.max(rows * 2, bounds.height + maxHeight, maxHeight);
      resetFree();
      result = search();
    }
    return result;
  };
  return {
    find,
    freeSpaceScore: () => freeSpaceScore(free),
    findAndReserve(item) { const placement = find(item); if (placement) occupy(placement); return placement; },
    reserve(r) {
      if (!r || r.x < 1 || r.y < 1 || r.width < 1 || r.height < 1 || right(r) > columns + 1) return false;
      if (!allowOverflowRows && (bottom(r) > rows + 1 || (zones.length && !zones.some(z => contains(z, r))))) return false;
      if (used.some(other => overlaps(r, other))) return false;
      occupy(r);
      if (allowOverflowRows && bottom(r) - 1 > rows) { rows = bottom(r) - 1; resetFree(); }
      return true;
    }
  };
}

/** Compare deterministic packings of the whole group; null entries did not fit. */
export function packInventoryRectangles(items, context) {
  if (!items.length) return [];
  const indexed = items.map((item, index) => ({ ...item, index }));
  const orders = [
    // The longest dimension matters after rotation too: a 4x2 rifle can become
    // taller than 3x3 armor and should be tried first, keeping the remainder open.
    indexed.slice().sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height) || area(b) - area(a) || a.index - b.index),
    indexed.slice().sort((a, b) => area(b) - area(a) || Math.max(b.width, b.height) - Math.max(a.width, a.height) || a.index - b.index),
    indexed.slice().sort((a, b) => b.height - a.height || b.width - a.width || a.index - b.index),
    indexed.slice().sort((a, b) => b.width - a.width || b.height - a.height || a.index - b.index),
    indexed
  ];
  const seen = new Set();
  let best = null;
  let bestScore = null;
  for (const order of orders) {
    const key = order.map(item => item.index).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    for (const strategy of ["compact", "fit"]) {
      const packer = createRectanglePacker({ ...context, strategy });
      const placements = Array(items.length).fill(null);
      let packedArea = 0;
      let count = 0;
      let width = 0;
      let height = 0;
      let turns = 0;
      for (const item of order) {
        const placement = packer.findAndReserve(item);
        placements[item.index] = placement;
        if (!placement) continue;
        packedArea += area(item);
        count++;
        turns += Number(Boolean(placement.rotated) !== Boolean(item.rotated));
        width = Math.max(width, right(placement) - 1);
        height = Math.max(height, bottom(placement) - 1);
      }
      const score = [-packedArea, -count, ...packer.freeSpaceScore(), width * height, height, width, turns];
      if (!bestScore || compare(score, bestScore) < 0) { best = placements; bestScore = score; }
    }
  }
  return best;
}

