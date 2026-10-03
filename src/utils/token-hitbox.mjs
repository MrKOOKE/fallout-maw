const geometryCache = new WeakMap();
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

/** Opt in to rotating the native token footprint; never crop its grid dimensions. */
export function getTokenHitboxProfile(document, data = {}) {
  const flags = data.flags?.["fallout-maw"];
  const source = document?.flags?.["fallout-maw"]?.tokenHitbox;
  const raw = flags?.["-=tokenHitbox"] !== undefined ? null : flags?.tokenHitbox ? { ...source, ...flags.tokenHitbox } : source;
  if (!raw?.enabled) return null;
  return { enabled: true };
}

export function getTokenHitboxGeometry(document, data = {}) {
  const profile = getTokenHitboxProfile(document, data);
  if (!profile) return null;
  const { width, height } = document.getSize(data);
  const rotation = !(data.lockRotation ?? document.lockRotation) ? finite(data.rotation ?? document.rotation, 0) : 0;
  const key = `${width}:${height}:${rotation}:${data.shape ?? document.shape}:${document.parent?.grid?.type}`;
  const cached = geometryCache.get(document);
  if (cached?.key === key) return cached;
  const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const left = 0, top = 0, w = width, h = height;
  const transform = (x, y) => ({ x: width / 2 + (x - width / 2) * cos - (y - height / 2) * sin,
    y: height / 2 + (x - width / 2) * sin + (y - height / 2) * cos });
  const nativePoints = globalThis.foundry?.documents?.TokenDocument?.prototype?.getGridSpacePolygon?.call(document, data)
    ?? [{ x: left, y: top }, { x: left + w, y: top }, { x: left + w, y: top + h }, { x: left, y: top + h }];
  const points = nativePoints.map(point => transform(point.x, point.y));
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const bounds = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  const geometry = { key, points, bounds, center: transform(left + w / 2, top + h / 2), left, top, width: w, height: h, transform };
  geometryCache.set(document, geometry);
  return geometry;
}

export function getTokenHitboxWorldBounds(document, data = {}) {
  const geometry = getTokenHitboxGeometry(document, data);
  if (!geometry) return null;
  return { ...geometry.bounds, x: (data.x ?? document.x) + geometry.bounds.x, y: (data.y ?? document.y) + geometry.bounds.y };
}

/** Sample the actual body, then let the native wall/level pipeline constrain it. */
export function getTokenHitboxTestPoints(document, data = {}) {
  const geometry = getTokenHitboxGeometry(document, data);
  if (!geometry) return null;
  const grid = document.parent?.grid;
  const padX = Math.min(grid?.sizeX ?? 100, geometry.width) / 2;
  const padY = Math.min(grid?.sizeY ?? 100, geometry.height) / 2;
  const innerW = geometry.width - 2 * padX, innerH = geometry.height - 2 * padY;
  const columns = innerW ? Math.max(1, Math.round(innerW / (grid?.sizeX ?? 100))) : 0;
  const rows = innerH ? Math.max(1, Math.round(innerH / (grid?.sizeY ?? 100))) : 0;
  const x = data.x ?? document.x, y = data.y ?? document.y;
  const points = [{ x: x + geometry.center.x, y: y + geometry.center.y }];
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) {
    const point = geometry.transform(geometry.left + padX + (columns ? j * innerW / columns : 0),
      geometry.top + padY + (rows ? i * innerH / rows : 0));
    if (Math.abs(point.x - geometry.center.x) + Math.abs(point.y - geometry.center.y) < 1e-6) continue;
    points.push({ x: x + point.x, y: y + point.y });
  }
  return points;
}

/** Convex clipping avoids claiming cells merely touched by a rotated bounding rectangle. */
export function intersectConvexPolygons(subject, clip) {
  let output = subject;
  for (let i = 0; i < clip.length && output.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length], input = output; output = [];
    const side = p => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    let previous = input.at(-1), previousSide = side(previous);
    for (const current of input) {
      const currentSide = side(current);
      if ((currentSide >= 0) !== (previousSide >= 0)) {
        const t = previousSide / (previousSide - currentSide);
        output.push({ x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y) });
      }
      if (currentSide >= 0) output.push(current);
      previous = current; previousSide = currentSide;
    }
  }
  const area = Math.abs(output.reduce((sum, p, i) => {
    const next = output[(i + 1) % output.length]; return sum + p.x * next.y - p.y * next.x;
  }, 0)) / 2;
  return area > 1e-6 ? output : [];
}

/** Pure geometric footprint, also used by native movement-cost aggregation. */
export function getTokenHitboxGridCells(document, data = {}) {
  const geometry = getTokenHitboxGeometry(document, data), grid = document.parent?.grid;
  if (!geometry || !grid || grid.isGridless) return [];
  const snapped = document.getSnappedPosition?.(data);
  const x = snapped?.x ?? data.x ?? document.x, y = snapped?.y ?? data.y ?? document.y;
  const elevation = snapped?.elevation ?? data.elevation ?? document.elevation;
  const polygon = geometry.points.map(point => ({ x: point.x + x, y: point.y + y }));
  const [i0, j0, i1, j1] = grid.getOffsetRange({ ...geometry.bounds, x: x + geometry.bounds.x, y: y + geometry.bounds.y });
  const k0 = grid.getOffset({ x, y, elevation }).k;
  const depth = Math.ceil(Math.max(0.5, Math.round((data.depth ?? document.depth) * 2) / 2));
  const cells = [];
  for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
    const covered = intersectConvexPolygons(polygon, grid.getVertices({ i, j }));
    if (!covered.length) continue;
    const center = covered.reduce((p, v) => ({ x: p.x + v.x / covered.length, y: p.y + v.y / covered.length }), { x: 0, y: 0 });
    for (let k = k0; k < k0 + depth; k++) cells.push({ ...center,
      elevation: grid.getCenterPoint({ i, j, k }).elevation + grid.distance / 2, offset: { i, j, k } });
  }
  return cells;
}
