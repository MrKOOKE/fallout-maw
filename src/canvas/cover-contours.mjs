const GEOMETRY_EPSILON = 1e-6;
const sceneContourRegistries = new WeakMap();

/**
 * Atomically replace every prepared contour owned by one producer.
 * Runtime consumers receive geometry and properties only; source documents are never retained.
 */
export function replaceCoverContours(scene, namespace, entries = []) {
  const registry = getSceneRegistry(scene, true);
  const key = normalizeKey(namespace);
  if (!registry || !key) return;

  const prepared = new Map();
  for (const entry of entries ?? []) {
    const sourceId = normalizeKey(entry?.sourceId);
    const contour = prepareCoverContour(entry);
    if (sourceId && contour) prepared.set(sourceId, contour);
  }
  if (prepared.size) registry.set(key, prepared);
  else registry.delete(key);
}

/** Add or replace one prepared contour. Invalid data removes the previous contour with the same key. */
export function upsertCoverContour(scene, namespace, sourceId, entry) {
  const registry = getSceneRegistry(scene, true);
  const namespaceKey = normalizeKey(namespace);
  const sourceKey = normalizeKey(sourceId);
  if (!registry || !namespaceKey || !sourceKey) return;

  const contour = prepareCoverContour(entry);
  if (!contour) {
    removeCoverContour(scene, namespaceKey, sourceKey);
    return;
  }
  let contours = registry.get(namespaceKey);
  if (!contours) {
    contours = new Map();
    registry.set(namespaceKey, contours);
  }
  contours.set(sourceKey, contour);
}

/** Remove one producer-owned contour without touching other geometry in the Scene. */
export function removeCoverContour(scene, namespace, sourceId) {
  const registry = getSceneRegistry(scene, false);
  const namespaceKey = normalizeKey(namespace);
  const sourceKey = normalizeKey(sourceId);
  if (!registry || !namespaceKey || !sourceKey) return;
  const contours = registry.get(namespaceKey);
  if (!contours) return;
  contours.delete(sourceKey);
  if (!contours.size) registry.delete(namespaceKey);
}

/** Drop either one producer namespace or the complete transient Scene registry. */
export function clearCoverContours(scene, namespace = "") {
  if (!scene || typeof scene !== "object") return;
  const namespaceKey = normalizeKey(namespace);
  if (!namespaceKey) {
    sceneContourRegistries.delete(scene);
    return;
  }
  sceneContourRegistries.get(scene)?.delete(namespaceKey);
}

/**
 * Return configured cover keys whose prepared green contour overlaps the supplied actor polygon.
 * This hot path performs only level, cached-AABB, and polygon tests.
 */
export function getCoverKeysIntersectingPolygon(scene, actorPolygon, levelId = "") {
  const actorPoints = getPolygonPoints(actorPolygon);
  if (!scene || actorPoints.length < 3) return new Set();

  const registry = getSceneRegistry(scene, false);
  if (!registry?.size) return new Set();
  const actorBounds = getPointBounds(actorPoints);
  const actorLevelId = normalizeKey(levelId);
  const keys = new Set();
  for (const contours of registry.values()) {
    for (const contour of contours.values()) {
      if (contour.levelIds.size && (!actorLevelId || !contour.levelIds.has(actorLevelId))) continue;
      if (!boundsOverlap(contour.bounds, actorBounds)) continue;
      if (preparedPolygonsIntersect(contour.points, actorPoints)) keys.add(contour.coverKey);
    }
  }
  return keys;
}

/**
 * Return one union mask per configured cover key for finite origin-to-sample segments which pass
 * through the strict interior of a prepared contour. A contour containing the origin is ignored so
 * cover surrounding the attacker cannot protect the target.
 */
export function getCoverSampleMasksIntersectingSegments(scene, origin, destinations = [], levelId = "") {
  const start = getFinitePoint(origin);
  if (!scene || !start) return new Map();
  const registry = getSceneRegistry(scene, false);
  if (!registry?.size) return new Map();
  const segments = [];
  const segmentFieldBounds = { left: start.x, right: start.x, top: start.y, bottom: start.y };
  for (let index = 0; index < (destinations?.length ?? 0); index += 1) {
    const destination = destinations[index];
    const end = getFinitePoint(destination);
    if (!end || pointsEqual(start, end)) continue;
    segments.push({ index, end, bounds: getSegmentBounds(start, end) });
    segmentFieldBounds.left = Math.min(segmentFieldBounds.left, end.x);
    segmentFieldBounds.right = Math.max(segmentFieldBounds.right, end.x);
    segmentFieldBounds.top = Math.min(segmentFieldBounds.top, end.y);
    segmentFieldBounds.bottom = Math.max(segmentFieldBounds.bottom, end.y);
  }
  if (!segments.length) return new Map();

  const targetLevelId = normalizeKey(levelId);
  const masks = new Map();
  for (const contours of registry.values()) {
    for (const contour of contours.values()) {
      if (contour.levelIds.size && (!targetLevelId || !contour.levelIds.has(targetLevelId))) continue;
      if (!boundsOverlap(contour.bounds, segmentFieldBounds)) continue;
      if (pointInPolygonStrict(start, contour.points)) continue;
      let mask = masks.get(contour.coverKey) ?? null;
      for (const segment of segments) {
        if (mask?.[segment.index]) continue;
        if (!boundsOverlap(contour.bounds, segment.bounds)) continue;
        if (!segmentIntersectsPolygonInterior(start, segment.end, contour.points)) continue;
        if (!mask) {
          mask = new Uint8Array(destinations.length);
          masks.set(contour.coverKey, mask);
        }
        mask[segment.index] = 1;
      }
    }
  }
  return masks;
}

/**
 * Resolve the strongest threshold reached by wall and Tile sample masks.
 * Entries must be ordered strongest-first. A Tile key is a strength cap: its mask also contributes
 * to weaker entries, while walls contribute to every positive threshold.
 */
export function resolveCoverFromSampleMasks(entries = [], wallMask = null, contourMasks = new Map(), sampleCount = 0) {
  const total = Math.max(0, Math.trunc(Number(sampleCount) || 0));
  if (!total || !Array.isArray(entries) || !entries.length) return { cover: null, obstructionPercent: 0 };

  const combinedTileMask = contourMasks?.size ? new Uint8Array(total) : null;
  let obstructionPercent = 0;
  for (const entry of entries) {
    const contourMask = contourMasks?.get?.(normalizeKey(entry?.key));
    if (contourMask && combinedTileMask) {
      for (let index = 0; index < total; index += 1) {
        if (contourMask[index]) combinedTileMask[index] = 1;
      }
    }

    const threshold = Math.min(100, Math.max(0, Math.trunc(Number(entry?.overlapPercent) || 0)));
    let blocked = 0;
    for (let index = 0; index < total; index += 1) {
      if (combinedTileMask?.[index] || (threshold > 0 && wallMask?.[index])) blocked += 1;
    }
    obstructionPercent = Math.round((blocked / total) * 100);
    if (blocked > 0 && (threshold === 0 || (blocked * 100) >= (threshold * total))) {
      return { cover: entry, obstructionPercent };
    }
  }
  return { cover: null, obstructionPercent };
}

/** Test overlap between two simple polygons, including containment and boundary contact. */
export function polygonsIntersect(leftPolygon, rightPolygon) {
  const left = getPolygonPoints(leftPolygon);
  const right = getPolygonPoints(rightPolygon);
  if (left.length < 3 || right.length < 3) return false;
  if (!boundsOverlap(getPointBounds(left), getPointBounds(right))) return false;
  return preparedPolygonsIntersect(left, right);
}

function getSceneRegistry(scene, create) {
  if (!scene || typeof scene !== "object") return null;
  let registry = sceneContourRegistries.get(scene);
  if (!registry && create) {
    registry = new Map();
    sceneContourRegistries.set(scene, registry);
  }
  return registry ?? null;
}

function prepareCoverContour(entry) {
  const coverKey = normalizeKey(entry?.coverKey);
  const points = getPolygonPoints(entry?.points);
  if (!coverKey || points.length < 3) return null;
  return {
    coverKey,
    levelIds: normalizeLevelIds(entry?.levelIds),
    points,
    bounds: getPointBounds(points)
  };
}

function normalizeLevelIds(value) {
  if (!value?.[Symbol.iterator] || typeof value === "string") return new Set();
  return new Set(Array.from(value, normalizeKey).filter(Boolean));
}

function normalizeKey(value) {
  return String(value ?? "").trim();
}

function preparedPolygonsIntersect(left, right) {
  if (pointInPolygon(left[0], right) || pointInPolygon(right[0], left)) return true;

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftStart = left[leftIndex];
    const leftEnd = left[(leftIndex + 1) % left.length];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const rightStart = right[rightIndex];
      const rightEnd = right[(rightIndex + 1) % right.length];
      if (segmentsIntersect(leftStart, leftEnd, rightStart, rightEnd)) return true;
    }
  }
  return false;
}

function getPolygonPoints(polygon) {
  if (Array.isArray(polygon)) {
    if (!polygon.length) return [];
    if (typeof polygon[0] === "object") return polygon
      .map(point => ({ x: Number(point?.x), y: Number(point?.y) }))
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    return getFlatPolygonPoints(polygon);
  }
  return getFlatPolygonPoints(polygon?.points);
}

function getFlatPolygonPoints(values) {
  if (!Array.isArray(values)) return [];
  const points = [];
  for (let index = 0; index < values.length - 1; index += 2) {
    const x = Number(values[index]);
    const y = Number(values[index + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  return points;
}

function getFinitePoint(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
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

function getSegmentBounds(start, end) {
  return {
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y)
  };
}

function boundsOverlap(left, right) {
  return left.left <= right.right + GEOMETRY_EPSILON
    && left.right + GEOMETRY_EPSILON >= right.left
    && left.top <= right.bottom + GEOMETRY_EPSILON
    && left.bottom + GEOMETRY_EPSILON >= right.top;
}

function segmentIntersectsPolygonInterior(start, end, polygon) {
  if (pointInPolygonStrict(end, polygon)) return true;
  for (let index = 0; index < polygon.length; index += 1) {
    if (segmentsProperlyIntersect(start, end, polygon[index], polygon[(index + 1) % polygon.length])) return true;
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= GEOMETRY_EPSILON * GEOMETRY_EPSILON) return false;
  const probeStep = 1e-7;
  for (const vertex of polygon) {
    if (!pointOnSegment(vertex, start, end)) continue;
    const parameter = (((vertex.x - start.x) * dx) + ((vertex.y - start.y) * dy)) / lengthSquared;
    const before = Math.max(0, parameter - probeStep);
    const after = Math.min(1, parameter + probeStep);
    if ((before < parameter && pointInPolygonStrict({ x: start.x + (dx * before), y: start.y + (dy * before) }, polygon))
      || (after > parameter && pointInPolygonStrict({ x: start.x + (dx * after), y: start.y + (dy * after) }, polygon))) return true;
  }
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index];
    const edgeEnd = polygon[(index + 1) % polygon.length];
    if (pointOnSegment(start, edgeStart, edgeEnd)
      && pointInPolygonStrict({ x: start.x + (dx * probeStep), y: start.y + (dy * probeStep) }, polygon)) return true;
    if (pointOnSegment(end, edgeStart, edgeEnd)
      && pointInPolygonStrict({ x: end.x - (dx * probeStep), y: end.y - (dy * probeStep) }, polygon)) return true;
  }
  return false;
}

function pointInPolygonStrict(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return false;
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)
        / (previousPoint.y - currentPoint.y)) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)
        / (previousPoint.y - currentPoint.y)) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
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

function segmentsProperlyIntersect(a, b, c, d) {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return ((first > GEOMETRY_EPSILON && second < -GEOMETRY_EPSILON)
      || (first < -GEOMETRY_EPSILON && second > GEOMETRY_EPSILON))
    && ((third > GEOMETRY_EPSILON && fourth < -GEOMETRY_EPSILON)
      || (third < -GEOMETRY_EPSILON && fourth > GEOMETRY_EPSILON));
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

function pointsEqual(left, right) {
  return Math.abs(left.x - right.x) <= GEOMETRY_EPSILON
    && Math.abs(left.y - right.y) <= GEOMETRY_EPSILON;
}
