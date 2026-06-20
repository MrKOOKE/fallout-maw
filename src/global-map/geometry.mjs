const GRIDLESS = 0;

export function isSupportedGrid(scene = canvas?.scene) {
  return Boolean(scene?.grid && Number(scene.grid.type) !== GRIDLESS);
}

export function isHexGrid(scene = canvas?.scene) {
  const type = Number(scene?.grid?.type);
  const gridTypes = globalThis.CONST?.GRID_TYPES;
  if (scene?.grid?.isHexagonal) return true;
  if (!gridTypes) return type >= 2 && type <= 5;
  return type >= gridTypes.HEXODDR && type <= gridTypes.HEXEVENQ;
}

export function assertSupportedGrid(scene = canvas?.scene) {
  if (isSupportedGrid(scene)) return true;
  ui.notifications?.warn?.("Глобальная карта не поддерживает сцены без сетки.");
  return false;
}

export function pointToCell(scene, point) {
  if (!isSupportedGrid(scene) || !point) return null;
  const offset = scene.grid.getOffset({ x: Number(point.x) || 0, y: Number(point.y) || 0 });
  if (!Number.isFinite(offset?.i) || !Number.isFinite(offset?.j)) return null;
  return { i: offset.i, j: offset.j };
}

export function cellToPoint(scene, cell) {
  if (!isSupportedGrid(scene) || !cell) return null;
  const point = scene.grid.getCenterPoint({ i: Number(cell.i), j: Number(cell.j) });
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? { x: point.x, y: point.y } : null;
}

export function cellKey(cell) {
  return `${Number(cell?.i) || 0},${Number(cell?.j) || 0}`;
}

export function parseCellKey(key) {
  const [i, j] = String(key ?? "").split(",").map(Number);
  return Number.isFinite(i) && Number.isFinite(j) ? { i, j } : null;
}

export function snapPoint(scene, point) {
  const cell = pointToCell(scene, point);
  return cellToPoint(scene, cell) ?? { x: Number(point?.x) || 0, y: Number(point?.y) || 0 };
}

export function getCellVertices(scene, cell) {
  if (!isSupportedGrid(scene) || !cell) return [];
  const vertices = scene.grid.getVertices?.(cell);
  if (Array.isArray(vertices) && vertices.length >= 3) {
    return vertices.map(point => ({ x: point.x, y: point.y }));
  }
  const topLeft = scene.grid.getTopLeftPoint?.(cell);
  if (!topLeft) return [];
  const width = Number(scene.grid.sizeX ?? scene.grid.size) || 100;
  const height = Number(scene.grid.sizeY ?? scene.grid.size) || 100;
  return [
    { x: topLeft.x, y: topLeft.y },
    { x: topLeft.x + width, y: topLeft.y },
    { x: topLeft.x + width, y: topLeft.y + height },
    { x: topLeft.x, y: topLeft.y + height }
  ];
}

export function getCellCluster(scene, centerCell, radius = 1) {
  if (!isSupportedGrid(scene) || !centerCell) return [];
  const limit = Math.max(1, Math.round(Number(radius) || 1));
  if (!isHexGrid(scene)) return getSquareCellCluster(centerCell, limit);
  const cells = [{ i: centerCell.i, j: centerCell.j }];
  const visited = new Set([cellKey(centerCell)]);
  let frontier = [...cells];
  for (let ring = 1; ring < limit; ring += 1) {
    const next = [];
    for (const current of frontier) {
      for (const adjacent of scene.grid.getAdjacentOffsets?.(current) ?? []) {
        const key = cellKey(adjacent);
        if (visited.has(key)) continue;
        visited.add(key);
        const normalized = { i: adjacent.i, j: adjacent.j };
        cells.push(normalized);
        next.push(normalized);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return cells;
}

export function getCellPath(scene, fromCell, toCell) {
  if (!isSupportedGrid(scene) || !fromCell || !toCell) return [];
  if (cellKey(fromCell) === cellKey(toCell)) return [normalizeCell(toCell)];
  try {
    const direct = scene.grid.getDirectPath?.([fromCell, toCell]);
    if (Array.isArray(direct) && direct.length) return direct.map(normalizeCell).filter(Boolean);
  } catch (_error) {
    // Fallback below.
  }
  const fromPoint = cellToPoint(scene, fromCell);
  const toPoint = cellToPoint(scene, toCell);
  try {
    const direct = scene.grid.getDirectPath?.([fromPoint, toPoint]);
    if (Array.isArray(direct) && direct.length) return direct.map(normalizeCell).filter(Boolean);
  } catch (_error) {
    // Fallback below.
  }
  return getFallbackCellPath(fromCell, toCell);
}

export function getLocationCells(scene, location) {
  const center = pointToCell(scene, location);
  return center ? getCellCluster(scene, center, location.size) : [];
}

export function getCellsBoundaryLoops(scene, cells = []) {
  const boundaryEdges = new Map();
  for (const cell of cells) {
    const vertices = getCellVertices(scene, cell);
    if (vertices.length < 3) continue;
    for (let index = 0; index < vertices.length; index += 1) {
      const start = vertices[index];
      const end = vertices[(index + 1) % vertices.length];
      const startKey = pointKey(start);
      const endKey = pointKey(end);
      const edgeKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
      if (boundaryEdges.has(edgeKey)) boundaryEdges.delete(edgeKey);
      else boundaryEdges.set(edgeKey, { start, end, startKey, endKey });
    }
  }

  const byStart = new Map();
  for (const edge of boundaryEdges.values()) {
    if (!byStart.has(edge.startKey)) byStart.set(edge.startKey, []);
    byStart.get(edge.startKey).push(edge);
  }

  const unused = new Set(boundaryEdges.values());
  const loops = [];
  while (unused.size) {
    const first = unused.values().next().value;
    const loop = [first.start, first.end];
    unused.delete(first);
    let currentKey = first.endKey;
    while (currentKey !== first.startKey) {
      const next = (byStart.get(currentKey) ?? []).find(edge => unused.has(edge));
      if (!next) break;
      loop.push(next.end);
      unused.delete(next);
      currentKey = next.endKey;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

export function getBoundaryBounds(loops = []) {
  const points = loops.flat();
  if (!points.length) return null;
  return {
    minX: Math.min(...points.map(point => point.x)),
    minY: Math.min(...points.map(point => point.y)),
    maxX: Math.max(...points.map(point => point.x)),
    maxY: Math.max(...points.map(point => point.y))
  };
}

export function locationContainsPoint(scene, location, point) {
  const target = pointToCell(scene, point);
  if (!target) return false;
  const key = cellKey(target);
  return getLocationCells(scene, location).some(cell => cellKey(cell) === key);
}

export function tokenCenter(tokenData, scene) {
  const grid = scene?.grid;
  const sizeX = Number(grid?.sizeX ?? grid?.size) || 100;
  const sizeY = Number(grid?.sizeY ?? grid?.size) || 100;
  return {
    x: (Number(tokenData?.x) || 0) + ((Number(tokenData?.width) || 1) * sizeX / 2),
    y: (Number(tokenData?.y) || 0) + ((Number(tokenData?.height) || 1) * sizeY / 2)
  };
}

export function tokenTopLeftAtCell(scene, tokenData, cell, index = 0) {
  const center = cellToPoint(scene, cell) ?? {
    x: Number(scene?.width) / 2 || 0,
    y: Number(scene?.height) / 2 || 0
  };
  const sizeX = Number(scene?.grid?.sizeX ?? scene?.grid?.size) || 100;
  const sizeY = Number(scene?.grid?.sizeY ?? scene?.grid?.size) || 100;
  const spread = Math.max(20, Math.min(sizeX, sizeY) * 0.75);
  const angle = (index % 8) * (Math.PI / 4);
  const ring = Math.floor(index / 8);
  const distance = ring ? (ring + 1) * spread : 0;
  const point = {
    x: center.x + Math.cos(angle) * distance - ((Number(tokenData?.width) || 1) * sizeX / 2),
    y: center.y + Math.sin(angle) * distance - ((Number(tokenData?.height) || 1) * sizeY / 2)
  };
  try {
    return scene.grid.getSnappedPoint(point, {
      mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_CORNER,
      resolution: 1
    });
  } catch (_error) {
    return { x: Math.round(point.x), y: Math.round(point.y) };
  }
}

export function reprojectCellKeys(oldGrid, newGrid, keys = []) {
  if (!oldGrid || !newGrid) return [];
  const projected = new Set();
  for (const key of keys) {
    const cell = parseCellKey(key);
    if (!cell) continue;
    const center = oldGrid.getCenterPoint(cell);
    const target = newGrid.getOffset(center);
    if (Number.isFinite(target?.i) && Number.isFinite(target?.j)) projected.add(cellKey(target));
  }
  return Array.from(projected);
}

export function cellsIntersect(cellsA = [], cellsB = []) {
  const keys = new Set(cellsA.map(cell => typeof cell === "string" ? cell : cellKey(cell)));
  return cellsB.some(cell => keys.has(typeof cell === "string" ? cell : cellKey(cell)));
}

function pointKey(point) {
  return `${Math.round(Number(point?.x) * 1000)},${Math.round(Number(point?.y) * 1000)}`;
}

function getSquareCellCluster(centerCell, radius) {
  const cells = [];
  const spread = radius - 1;
  for (let di = -spread; di <= spread; di += 1) {
    for (let dj = -spread; dj <= spread; dj += 1) {
      cells.push({ i: Number(centerCell.i) + di, j: Number(centerCell.j) + dj });
    }
  }
  return cells;
}

function getFallbackCellPath(fromCell, toCell) {
  const from = normalizeCell(fromCell);
  const to = normalizeCell(toCell);
  if (!from || !to) return [];
  const cells = [];
  const di = to.i - from.i;
  const dj = to.j - from.j;
  const steps = Math.max(Math.abs(di), Math.abs(dj), 1);
  for (let step = 0; step <= steps; step += 1) {
    const i = Math.round(from.i + (di * step / steps));
    const j = Math.round(from.j + (dj * step / steps));
    const cell = { i, j };
    if (cells.at(-1) && cellKey(cells.at(-1)) === cellKey(cell)) continue;
    cells.push(cell);
  }
  return cells;
}

function normalizeCell(cell) {
  const i = Number(cell?.i);
  const j = Number(cell?.j);
  return Number.isFinite(i) && Number.isFinite(j) ? { i, j } : null;
}
