import { SYSTEM_ID } from "../constants.mjs";

export const TILE_HITBOX_FLAG = "tileHitbox";
export const TILE_HITBOX_VERSION = 1;
export const RIMWORLD_BRIDGE_ID = "rimworld-map-bridge";
export const RIMWORLD_TILE_HITBOX_FLAG = "hitbox";

const MAX_TILE_HITBOX_POINTS = 64;
const GEOMETRY_EPSILON = 1e-7;
const AREA_EPSILON = 1e-10;
const hitAreaStates = new WeakMap();
let hooksRegistered = false;

/** Register the lightweight Tile selection-hitbox bridge. */
export function registerTileHitboxHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("drawTile", applyTileHitboxHitArea);
  Hooks.on("updateTile", (tile, changes) => {
    if (tileUpdateAffectsHitbox(changes)) applyTileHitboxHitArea(tile?.object);
  });
}

/** Normalize one persisted polygon and reject malformed or unbounded geometry. */
export function normalizeTileHitbox(value) {
  if (Number(value?.version) !== TILE_HITBOX_VERSION) return null;
  const sourcePoints = getSourcePoints(value?.points);
  if (sourcePoints.length > MAX_TILE_HITBOX_POINTS) return null;
  const points = [];
  for (const sourcePoint of sourcePoints) {
    const point = {
      x: roundCoordinate(Number(sourcePoint?.x)),
      y: roundCoordinate(Number(sourcePoint?.y))
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (points.length && pointsEqual(points.at(-1), point)) continue;
    points.push(point);
  }
  if (points.length > 1 && pointsEqual(points[0], points.at(-1))) points.pop();
  if (points.length < 3 || points.length > MAX_TILE_HITBOX_POINTS) return null;
  if (Math.abs(getSignedPolygonArea(points)) <= AREA_EPSILON || !isSimplePolygon(points)) return null;
  return { version: TILE_HITBOX_VERSION, points };
}

/** Resolve the effective Tile polygon. A manual system polygon always overrides the RimWorld import. */
export function getTileHitbox(tile) {
  const document = getTileDocument(tile);
  const manual = normalizeTileHitbox(getTileFlag(document, SYSTEM_ID, TILE_HITBOX_FLAG));
  if (manual) return { ...manual, source: "manual" };
  const imported = normalizeTileHitbox(getTileFlag(document, RIMWORLD_BRIDGE_ID, RIMWORLD_TILE_HITBOX_FLAG));
  return imported ? { ...imported, source: "rimworld" } : null;
}

/** Convert the effective Tile-local polygon into prepared canvas coordinates. */
export function getTileHitboxWorldPoints(tile, hitbox = getTileHitbox(tile)) {
  const transform = getTileTransform(tile);
  if (!transform || !hitbox?.points?.length) return [];
  const { x, y, width, height, anchorX, anchorY, cos, sin } = transform;
  return hitbox.points.map(point => {
    const localX = (point.x - anchorX) * width;
    const localY = (point.y - anchorY) * height;
    return {
      x: x + (localX * cos) - (localY * sin),
      y: y + (localX * sin) + (localY * cos)
    };
  });
}

/** Convert canvas polygon vertices to Tile-local normalized coordinates for persistence. */
export function worldPointsToTileHitbox(tile, worldPoints) {
  const transform = getTileTransform(tile);
  if (!transform || !Array.isArray(worldPoints)) return null;
  const { x, y, width, height, anchorX, anchorY, cos, sin } = transform;
  return normalizeTileHitbox({
    version: TILE_HITBOX_VERSION,
    points: worldPoints.map(point => {
      const dx = Number(point?.x) - x;
      const dy = Number(point?.y) - y;
      return {
        x: ((dx * cos) + (dy * sin)) / width + anchorX,
        y: ((-dx * sin) + (dy * cos)) / height + anchorY
      };
    })
  });
}

/** Test one canvas point without allocating a transformed polygon. */
export function tileHitboxContainsCanvasPoint(tile, canvasPoint, hitbox = getTileHitbox(tile)) {
  const transform = getTileTransform(tile);
  if (!transform || !hitbox?.points?.length) return false;
  const dx = Number(canvasPoint?.x) - transform.x;
  const dy = Number(canvasPoint?.y) - transform.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const localX = ((dx * transform.cos) + (dy * transform.sin)) / transform.width + transform.anchorX;
  const localY = ((-dx * transform.sin) + (dy * transform.cos)) / transform.height + transform.anchorY;
  return pointInPolygonCoordinates(localX, localY, hitbox.points);
}

/** Apply the effective polygon to Foundry's Tile frame selection hit area. */
export function applyTileHitboxHitArea(tile) {
  const frame = tile?.frame;
  const hitArea = frame?.hitArea;
  if (!tile?.document || !hitArea || typeof hitArea.contains !== "function") return;

  let state = hitAreaStates.get(tile);
  const hitbox = getTileHitbox(tile.document);
  if (!hitbox) {
    if (state?.frame === frame && state.hitArea === hitArea && hitArea.contains === state.installedContains) {
      hitArea.contains = state.defaultContains;
    }
    hitAreaStates.delete(tile);
    return;
  }
  if (!state || state.frame !== frame || state.hitArea !== hitArea
    || (state.installedContains && hitArea.contains !== state.installedContains)) {
    state = {
      frame,
      hitArea,
      defaultContains: hitArea.contains,
      installedContains: null
    };
    hitAreaStates.set(tile, state);
  }
  const transform = getTileTransform(tile.document);
  const points = hitbox.points;
  if (!transform) {
    if (hitArea.contains === state.installedContains) hitArea.contains = state.defaultContains;
    hitAreaStates.delete(tile);
    return;
  }
  const bounds = getPointBounds(points);
  state.installedContains = (x, y) => {
    const dx = Number(x) - transform.x;
    const dy = Number(y) - transform.y;
    const localX = ((dx * transform.cos) + (dy * transform.sin)) / transform.width + transform.anchorX;
    const localY = ((-dx * transform.sin) + (dy * transform.cos)) / transform.height + transform.anchorY;
    if (localX < bounds.left || localX > bounds.right || localY < bounds.top || localY > bounds.bottom) return false;
    return pointInPolygonCoordinates(localX, localY, points);
  };
  hitArea.contains = state.installedContains;
}

/**
 * Collect a polygon with Foundry V14's transient Region placement workflow.
 * The returned data is ready for flags.fallout-maw.tileHitbox; no Region document is created.
 */
export async function drawTileHitboxOnCanvas(tile, {
  canvasObject = globalThis.canvas,
  notifications = globalThis.ui?.notifications,
  i18n = globalThis.game?.i18n
} = {}) {
  const document = getTileDocument(tile);
  const scene = document?.parent;
  if (!document || !canvasObject?.ready || !canvasObject?.regions?.placeRegion || !canvasObject.scene) return null;
  if (scene && scene !== canvasObject.scene && scene.id !== canvasObject.scene.id) return null;

  const previousLayer = canvasObject.activeLayer;
  const previousTool = globalThis.ui?.controls?.tool?.name;
  const committed = [];
  let cursor = {
    x: Number(document.x ?? document._source?.x) || 0,
    y: Number(document.y ?? document._source?.y) || 0
  };
  const updatePreview = (shape, regionDocument) => {
    shape.updateSource({ points: buildPreviewFlatPoints(committed, cursor) });
    if (regionDocument) {
      regionDocument.updateSource({ shapes: [...regionDocument.shapes.slice(0, -1), shape] });
      regionDocument.object?.renderFlags?.set?.({ refreshShapes: true });
    }
  };

  notifications?.info?.(localize(i18n, "FALLOUTMAW.Tile.HitboxDrawInstructions"));
  try {
    const preview = await canvasObject.regions.placeRegion({
      name: localize(i18n, "FALLOUTMAW.Tile.HitboxPreviewName"),
      color: "#ff7a1a",
      visibility: globalThis.CONST?.REGION_VISIBILITY?.ALWAYS,
      highlightMode: "shapes",
      displayMeasurements: false,
      levels: canvasObject.level?.id ? [canvasObject.level.id] : [],
      shapes: [{
        type: "polygon",
        points: buildPreviewFlatPoints([], cursor),
        origin: null
      }]
    }, {
      create: false,
      allowRotation: false,
      onMove: ({ position, shape }) => {
        cursor = toCanvasPoint(position, cursor);
        shape.updateSource({ points: buildPreviewFlatPoints(committed, cursor) });
        return false;
      },
      preConfirm: ({ event, document: regionDocument, shape }) => {
        cursor = getEventCanvasPoint(event, canvasObject.regions, cursor);
        const closesAtOrigin = committed.length >= 3
          && pointsNear(cursor, committed[0], getCloseDistance(canvasObject));
        const doubleClick = getPointerClickCount(event) >= 2;
        if ((closesAtOrigin || doubleClick) && committed.length >= 3) {
          const finalized = normalizeWorldPoints(committed);
          if (!finalized) {
            notifications?.warn?.(localize(i18n, "FALLOUTMAW.Tile.HitboxInvalid"));
            return false;
          }
          committed.splice(0, committed.length, ...finalized);
          shape.updateSource({ points: flattenPoints(committed) });
          regionDocument.updateSource({ shapes: [...regionDocument.shapes.slice(0, -1), shape] });
          return true;
        }
        if (committed.length >= MAX_TILE_HITBOX_POINTS) {
          notifications?.warn?.(localize(i18n, "FALLOUTMAW.Tile.HitboxPointLimit"));
          return false;
        }
        if (!committed.length || !pointsEqual(committed.at(-1), cursor)) committed.push({ ...cursor });
        updatePreview(shape, regionDocument);
        return false;
      },
      preSkip: ({ document: regionDocument, shape }) => {
        if (!committed.length) return true;
        committed.pop();
        updatePreview(shape, regionDocument);
        return false;
      }
    });
    if (!preview || committed.length < 3) return null;
    return worldPointsToTileHitbox(document, committed);
  } finally {
    if (previousLayer && !previousLayer.active) previousLayer.activate({ tool: previousTool });
  }
}

function getTileDocument(tile) {
  return tile?.document ?? tile;
}

function tileUpdateAffectsHitbox(changes) {
  if (!changes || typeof changes !== "object") return true;
  if (["x", "y", "width", "height", "rotation"].some(key => Object.hasOwn(changes, key))) return true;
  const texture = changes.texture;
  if (texture && typeof texture === "object"
    && ["anchorX", "anchorY"].some(key => Object.hasOwn(texture, key))) return true;
  return changedFlagScope(changes, SYSTEM_ID) || changedFlagScope(changes, RIMWORLD_BRIDGE_ID);
}

function changedFlagScope(changes, scope) {
  const flags = changes?.flags;
  if (flags && typeof flags === "object"
    && (Object.hasOwn(flags, scope) || Object.hasOwn(flags, `-=${scope}`))) return true;
  return Object.keys(changes ?? {}).some(key => key === `flags.${scope}`
    || key.startsWith(`flags.${scope}.`) || key.startsWith(`flags.-=${scope}`));
}

function getTileFlag(tile, scope, key) {
  return tile?.getFlag?.(scope, key)
    ?? tile?.flags?.[scope]?.[key]
    ?? tile?._source?.flags?.[scope]?.[key];
}

function getSourcePoints(value) {
  if (!Array.isArray(value)) return [];
  if (!value.length || typeof value[0] === "object") return value;
  const points = [];
  for (let index = 0; index < value.length - 1; index += 2) {
    points.push({ x: value[index], y: value[index + 1] });
  }
  return points;
}

function getTileTransform(tile) {
  const document = getTileDocument(tile);
  const x = Number(document?.x ?? document?._source?.x);
  const y = Number(document?.y ?? document?._source?.y);
  const width = Number(document?.width ?? document?._source?.width);
  const height = Number(document?.height ?? document?._source?.height);
  if (![x, y, width, height].every(Number.isFinite)
    || width <= GEOMETRY_EPSILON || height <= GEOMETRY_EPSILON) return null;
  const texture = document?.texture ?? document?._source?.texture ?? {};
  // This is physical Tile geometry: presentation-only texture fit/scale does not move occupied space.
  const anchorX = toFiniteNumber(texture?.anchorX, 0.5);
  const anchorY = toFiniteNumber(texture?.anchorY, 0.5);
  const radians = toFiniteNumber(document?.rotation ?? document?._source?.rotation) * (Math.PI / 180);
  return { x, y, width, height, anchorX, anchorY, cos: Math.cos(radians), sin: Math.sin(radians) };
}

function buildPreviewFlatPoints(points, previewPoint) {
  const preview = [...points, { ...previewPoint }];
  if (preview.length === 1) {
    preview.push(
      { x: previewPoint.x + 0.01, y: previewPoint.y },
      { x: previewPoint.x, y: previewPoint.y + 0.01 }
    );
  } else if (preview.length === 2) {
    const start = preview[0];
    const dx = previewPoint.x - start.x;
    const dy = previewPoint.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    preview.push({
      x: previewPoint.x - ((dy / length) * 0.01),
      y: previewPoint.y + ((dx / length) * 0.01)
    });
  }
  return flattenPoints(preview);
}

function flattenPoints(points) {
  return points.flatMap(point => [point.x, point.y]);
}

function normalizeWorldPoints(points) {
  const normalized = [];
  for (const point of points) {
    const candidate = toCanvasPoint(point);
    if (!normalized.length || !pointsEqual(normalized.at(-1), candidate)) normalized.push(candidate);
  }
  if (normalized.length > 1 && pointsEqual(normalized[0], normalized.at(-1))) normalized.pop();
  if (normalized.length < 3 || Math.abs(getSignedPolygonArea(normalized)) <= GEOMETRY_EPSILON) return null;
  return isSimplePolygon(normalized) ? normalized : null;
}

function toCanvasPoint(point, fallback = { x: 0, y: 0 }) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : { ...fallback };
}

function getEventCanvasPoint(event, layer, fallback) {
  return toCanvasPoint(event?.getLocalPosition?.(layer), fallback);
}

function getPointerClickCount(event) {
  return Number(event?.clickCount ?? event?.detail ?? event?.nativeEvent?.detail ?? event?.originalEvent?.detail) || 0;
}

function getCloseDistance(canvasObject) {
  const scale = Math.abs(Number(canvasObject?.stage?.scale?.x)) || 1;
  return 12 / scale;
}

function pointsNear(left, right, distance) {
  return Math.hypot(left.x - right.x, left.y - right.y) <= distance;
}

function pointsEqual(left, right) {
  return Math.abs(left.x - right.x) <= GEOMETRY_EPSILON
    && Math.abs(left.y - right.y) <= GEOMETRY_EPSILON;
}

function getSignedPolygonArea(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    sum += (points[index].x * next.y) - (next.x * points[index].y);
  }
  return sum / 2;
}

function getPointBounds(points) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  return { left, right, top, bottom };
}

function isSimplePolygon(points) {
  for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
    const leftNext = (leftIndex + 1) % points.length;
    for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
      const rightNext = (rightIndex + 1) % points.length;
      if (leftIndex === rightIndex || leftIndex === rightNext || leftNext === rightIndex) continue;
      if (segmentsIntersect(points[leftIndex], points[leftNext], points[rightIndex], points[rightNext])) return false;
    }
  }
  return true;
}

function pointInPolygonCoordinates(x, y, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (pointOnSegmentCoordinates(x, y, previousPoint, currentPoint)) return true;
    const crosses = (currentPoint.y > y) !== (previousPoint.y > y)
      && x < ((previousPoint.x - currentPoint.x) * (y - currentPoint.y)
        / (previousPoint.y - currentPoint.y)) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegmentCoordinates(x, y, start, end) {
  const cross = ((end.x - start.x) * (y - start.y)) - ((end.y - start.y) * (x - start.x));
  if (Math.abs(cross) > GEOMETRY_EPSILON) return false;
  return x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON
    && x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON
    && y >= Math.min(start.y, end.y) - GEOMETRY_EPSILON
    && y <= Math.max(start.y, end.y) + GEOMETRY_EPSILON;
}

function segmentsIntersect(a, b, c, d) {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if (((first > GEOMETRY_EPSILON && second < -GEOMETRY_EPSILON)
    || (first < -GEOMETRY_EPSILON && second > GEOMETRY_EPSILON))
    && ((third > GEOMETRY_EPSILON && fourth < -GEOMETRY_EPSILON)
      || (third < -GEOMETRY_EPSILON && fourth > GEOMETRY_EPSILON))) return true;
  return (Math.abs(first) <= GEOMETRY_EPSILON && pointOnSegment(c, a, b))
    || (Math.abs(second) <= GEOMETRY_EPSILON && pointOnSegment(d, a, b))
    || (Math.abs(third) <= GEOMETRY_EPSILON && pointOnSegment(a, c, d))
    || (Math.abs(fourth) <= GEOMETRY_EPSILON && pointOnSegment(b, c, d));
}

function orientation(a, b, c) {
  return ((b.x - a.x) * (c.y - a.y)) - ((b.y - a.y) * (c.x - a.x));
}

function pointOnSegment(point, start, end) {
  if (Math.abs(orientation(start, end, point)) > GEOMETRY_EPSILON) return false;
  return point.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON
    && point.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON
    && point.y >= Math.min(start.y, end.y) - GEOMETRY_EPSILON
    && point.y <= Math.max(start.y, end.y) + GEOMETRY_EPSILON;
}

function roundCoordinate(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : Number.NaN;
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function localize(i18n, key) {
  return i18n?.localize?.(key) ?? key;
}
