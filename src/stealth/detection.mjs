import { testObserverVisibilityBatch } from "../canvas/physical-los.mjs";
import { analyzeLightingPoint } from "./lighting.mjs";
import { isValidStealthObserver } from "./observers.mjs";
import {
  clampNumber,
  evaluateStealthDetectionRange,
  getDetectionRangeFactor,
  getRuntimeStealthSettings,
  getTokenCenter,
  normalizePoint,
  pixelsToSceneDistance,
  sceneDistanceToPixels
} from "./rules.mjs";

const STEALTH_DETECTION_ZONE_CACHE_ENTRY_LIMIT = 64;
const STEALTH_DETECTION_ZONE_CACHE_CELL_LIMIT = 16_384;
const STEALTH_DETECTION_POINT_CACHE_LIMIT = 2_048;
const DETECTION_PREVIEW_PATH_SAMPLE_LIMIT = 16;
const DETECTION_PREVIEW_CELL_TEST_LIMIT = 4_096;

const detectionZoneCache = new Map();
const detectionPointCache = new Map();
const settingsSignatures = new WeakMap();
let detectionZoneCachedCells = 0;

/**
 * Build the observer zones relevant to one hidden token.
 *
 * `visibleOnly` deliberately means that the hidden token can physically see
 * the observer. This preserves the anti-metagame direction of the original UI
 * while batching every target through one temporary VisionSource.
 */
export function getStealthObserverZones(hiddenToken, {
  visibleOnly = false,
  settings = getRuntimeStealthSettings()
} = {}) {
  const activeCanvas = globalThis.canvas;
  if (!hiddenToken?.actor || !activeCanvas?.ready) return [];

  let observers = (activeCanvas.tokens?.placeables ?? [])
    .filter(observerToken => isValidStealthObserver(hiddenToken, observerToken));
  if (visibleOnly && observers.length) {
    const visibility = testObserverVisibilityBatch(hiddenToken, observers);
    observers = observers.filter(observerToken => visibility.get(getTokenDocumentUuid(observerToken)) === true);
  }

  const zones = [];
  for (const observerToken of observers) {
    const zone = buildObserverDetectionZone(observerToken, { settings });
    if (!zone?.offsets?.length) continue;
    zones.push({ hiddenToken, observerToken, ...zone });
  }
  return zones;
}

export function buildObserverDetectionZone(observerToken, {
  origin = null,
  settings = getRuntimeStealthSettings()
} = {}) {
  const activeCanvas = globalThis.canvas;
  if (!observerToken?.actor || !activeCanvas?.ready || activeCanvas.grid?.isGridless) return null;
  const maxRange = evaluateStealthDetectionRange(observerToken.actor, settings);
  const maxPixels = sceneDistanceToPixels(maxRange);
  if (maxPixels <= 0) return null;

  const center = normalizePoint(origin ?? getTokenCenter(observerToken), observerToken.document?.elevation);
  const cacheKey = getDetectionZoneCacheKey(observerToken, center, settings, maxRange);
  const cached = readCache(detectionZoneCache, cacheKey);
  if (cached) return cached;

  const sceneRect = activeCanvas.dimensions?.rect
    ?? new PIXI.Rectangle(0, 0, activeCanvas.dimensions?.width ?? Infinity, activeCanvas.dimensions?.height ?? Infinity);
  const bounds = new PIXI.Rectangle(center.x - maxPixels, center.y - maxPixels, maxPixels * 2, maxPixels * 2)
    .fit(sceneRect);
  const previewRange = getBoundedPreviewOffsetRange(
    activeCanvas.grid.getOffsetRange(bounds),
    center,
    activeCanvas.grid
  );
  const [i0, j0, i1, j1] = previewRange.range;
  const offsets = [];
  const radiusWithCell = maxPixels + (activeCanvas.grid.size / 2);
  const radiusSquared = radiusWithCell * radiusWithCell;

  for (let i = i0; i < i1; i += 1) {
    for (let j = j0; j < j1; j += 1) {
      const offset = { i, j };
      const point = normalizePoint(activeCanvas.grid.getCenterPoint(offset), center.elevation);
      const dx = point.x - center.x;
      const dy = point.y - center.y;
      if ((dx * dx) + (dy * dy) > radiusSquared) continue;
      if (observerToken.checkCollision?.(point, { origin: center, type: "sight", mode: "any" })) continue;
      if (computeDetectionPathCost(observerToken, center, point, settings, {
        costLimit: maxRange,
        sampleLimit: DETECTION_PREVIEW_PATH_SAMPLE_LIMIT
      }) > maxRange) continue;
      offsets.push(offset);
    }
  }

  const zone = { offsets, origin: center, range: maxRange, truncated: previewRange.truncated };
  writeDetectionZoneCache(cacheKey, zone);
  return zone;
}

export function testStealthDetectionPoint(observerToken, observerOrigin, targetPoint, {
  settings = getRuntimeStealthSettings()
} = {}) {
  const activeCanvas = globalThis.canvas;
  if (!observerToken?.actor || !targetPoint || !activeCanvas?.ready) return false;
  const origin = normalizePoint(observerOrigin ?? getTokenCenter(observerToken), observerToken.document?.elevation);
  let point = normalizePoint(targetPoint, origin.elevation);
  if (!activeCanvas.grid?.isGridless && activeCanvas.grid?.getOffset && activeCanvas.grid?.getCenterPoint) {
    point = normalizePoint(activeCanvas.grid.getCenterPoint(activeCanvas.grid.getOffset(point)), origin.elevation);
  }
  const maxRange = evaluateStealthDetectionRange(observerToken.actor, settings);
  if (maxRange <= 0) return false;
  const cacheKey = getDetectionPointCacheKey(observerToken, origin, point, settings, maxRange);
  const cached = readCache(detectionPointCache, cacheKey, { allowFalse: true });
  if (cached.hit) return cached.value;

  const margin = pixelsToSceneDistance(Number(activeCanvas.grid?.size) || 0);
  const directDistance = measurePointSceneDistance(origin, point);
  let result = true;
  if (directDistance > maxRange + margin) result = false;
  else if (observerToken.checkCollision?.(point, { origin, type: "sight", mode: "any" })) result = false;
  else result = computeDetectionPathCost(observerToken, origin, point, settings, { costLimit: maxRange }) <= maxRange;

  writeCache(detectionPointCache, cacheKey, result, STEALTH_DETECTION_POINT_CACHE_LIMIT);
  return result;
}

export function isPointInsideObserverZone(point, observerToken, observerOrigin, settings = getRuntimeStealthSettings()) {
  return testStealthDetectionPoint(observerToken, observerOrigin, point, { settings });
}

export function computeDetectionPathCost(
  observerToken,
  origin,
  destination,
  settings = getRuntimeStealthSettings(),
  { costLimit = Infinity, sampleLimit = Infinity } = {}
) {
  const activeCanvas = globalThis.canvas;
  const directDistance = measurePointSceneDistance(origin, destination);
  if (directDistance <= 0) return 0;
  const unaidedSightRange = getObserverUnaidedSightRange(observerToken);
  if (unaidedSightRange === Infinity || unaidedSightRange >= directDistance) return directDistance;
  const stepPixels = Math.max(1, Number(activeCanvas?.grid?.size) || 100);
  // Authoritative gameplay keeps one sample per grid step. Only callers which
  // explicitly provide sampleLimit (the visual preview) use a coarse ceiling.
  const exactSteps = Math.max(1, Math.ceil(sceneDistanceToPixels(directDistance) / stepPixels));
  const normalizedSampleLimit = Number.isFinite(Number(sampleLimit))
    ? Math.max(1, Math.floor(Number(sampleLimit)))
    : Infinity;
  const steps = Math.min(exactSteps, normalizedSampleLimit);
  let consumed = 0;
  let last = origin;

  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    const point = {
      x: origin.x + ((destination.x - origin.x) * ratio),
      y: origin.y + ((destination.y - origin.y) * ratio),
      elevation: origin.elevation + ((destination.elevation - origin.elevation) * ratio)
    };
    const segmentDistance = measurePointSceneDistance(last, point);
    const startDistance = measurePointSceneDistance(origin, last);
    const endDistance = measurePointSceneDistance(origin, point);
    const distanceDelta = Math.max(0.0001, endDistance - startDistance);
    const unaidedRatio = clampNumber((unaidedSightRange - startDistance) / distanceDelta, 0, 1);
    const unaidedDistance = segmentDistance * unaidedRatio;
    const attenuatedDistance = Math.max(0, segmentDistance - unaidedDistance);
    consumed += unaidedDistance;
    if (attenuatedDistance > 0) {
      const factor = getDetectionRangeFactor(analyzeLightingPoint(point).effectiveDarkness, settings);
      consumed += attenuatedDistance / Math.max(0.01, factor);
    }
    if (consumed > costLimit) return consumed;
    last = point;
  }
  return consumed;
}

function measurePointSceneDistance(left = {}, right = {}) {
  const horizontal = pixelsToSceneDistance(Math.hypot(right.x - left.x, right.y - left.y));
  const vertical = Math.abs((Number(right.elevation) || 0) - (Number(left.elevation) || 0));
  return Math.hypot(horizontal, vertical);
}

export function getObserverUnaidedSightRange(observerToken) {
  const document = observerToken?.document ?? observerToken;
  if (!observerToken?.hasSight || document?.sight?.enabled === false) return 0;
  const basicSight = document?.detectionModes?.basicSight;
  if (basicSight?.enabled === false) return 0;
  return normalizeSceneRange(basicSight?.range, normalizeSceneRange(document?.sight?.range, 0));
}

export function getGridOffsetKey(offset = {}) {
  return `${Math.round(Number(offset.i) || 0)}:${Math.round(Number(offset.j) || 0)}`;
}

export function getTokenVisualizationGridKey(token) {
  const activeCanvas = globalThis.canvas;
  const center = getTokenCenter(token);
  const offset = activeCanvas?.grid?.getOffset?.(center) ?? { i: Math.round(center.y), j: Math.round(center.x) };
  return [
    activeCanvas?.scene?.id ?? "",
    token?.id ?? "",
    getGridOffsetKey(offset),
    normalizeExactCacheNumber(center.elevation)
  ].join(":");
}

export function invalidateStealthDetectionCache() {
  detectionZoneCache.clear();
  detectionPointCache.clear();
  detectionZoneCachedCells = 0;
}

export function getStealthDetectionCacheStats() {
  return Object.freeze({
    zones: detectionZoneCache.size,
    points: detectionPointCache.size,
    zoneCells: detectionZoneCachedCells,
    maxZones: STEALTH_DETECTION_ZONE_CACHE_ENTRY_LIMIT,
    maxZoneCells: STEALTH_DETECTION_ZONE_CACHE_CELL_LIMIT,
    maxPreviewCells: DETECTION_PREVIEW_CELL_TEST_LIMIT
  });
}

/**
 * Keep preview construction bounded before entering the O(cells * samples)
 * loop. Oversized ranges are cropped around the observer; authoritative point
 * checks never use this helper and remain exact at any distance.
 */
function getBoundedPreviewOffsetRange(range = [], center = {}, grid = null) {
  let [i0, j0, i1, j1] = range.map(value => Math.trunc(Number(value) || 0));
  const rows = Math.max(0, i1 - i0);
  const columns = Math.max(0, j1 - j0);
  if ((rows * columns) <= DETECTION_PREVIEW_CELL_TEST_LIMIT) {
    return { range: [i0, j0, i1, j1], truncated: false };
  }

  let selectedRows = Math.min(rows, Math.max(1, Math.floor(Math.sqrt(DETECTION_PREVIEW_CELL_TEST_LIMIT))));
  let selectedColumns = Math.min(columns, Math.max(1, Math.floor(DETECTION_PREVIEW_CELL_TEST_LIMIT / selectedRows)));
  selectedRows = Math.min(rows, Math.max(1, Math.floor(DETECTION_PREVIEW_CELL_TEST_LIMIT / selectedColumns)));
  const centerOffset = grid?.getOffset?.(center) ?? {};
  const centerI = Number.isFinite(Number(centerOffset.i)) ? Number(centerOffset.i) : (i0 + i1 - 1) / 2;
  const centerJ = Number.isFinite(Number(centerOffset.j)) ? Number(centerOffset.j) : (j0 + j1 - 1) / 2;
  i0 = getCenteredOffsetRangeStart(i0, i1, selectedRows, centerI);
  j0 = getCenteredOffsetRangeStart(j0, j1, selectedColumns, centerJ);
  i1 = i0 + selectedRows;
  j1 = j0 + selectedColumns;
  return { range: [i0, j0, i1, j1], truncated: true };
}

function getCenteredOffsetRangeStart(minimum, maximum, span, center) {
  const latest = Math.max(minimum, maximum - span);
  const desired = Math.floor(center - ((span - 1) / 2));
  return Math.min(latest, Math.max(minimum, desired));
}

function getDetectionZoneCacheKey(observerToken, origin, settings, maxRange) {
  const activeCanvas = globalThis.canvas;
  const offset = activeCanvas?.grid?.getOffset?.(origin) ?? { i: Math.round(origin.y), j: Math.round(origin.x) };
  return [
    activeCanvas?.scene?.id ?? "",
    observerToken.id ?? "",
    getGridOffsetKey(offset),
    normalizeExactCacheNumber(origin.x),
    normalizeExactCacheNumber(origin.y),
    normalizeExactCacheNumber(origin.elevation),
    Math.round(maxRange * 100),
    normalizeRangeCachePart(getObserverUnaidedSightRange(observerToken)),
    getSettingsSignature(settings)
  ].join(":");
}

function getDetectionPointCacheKey(observerToken, origin, point, settings, maxRange) {
  const activeCanvas = globalThis.canvas;
  const originOffset = activeCanvas?.grid?.getOffset?.(origin) ?? { i: Math.round(origin.y), j: Math.round(origin.x) };
  const pointOffset = activeCanvas?.grid?.getOffset?.(point) ?? { i: Math.round(point.y), j: Math.round(point.x) };
  return [
    activeCanvas?.scene?.id ?? "",
    observerToken.id ?? "",
    getGridOffsetKey(originOffset),
    getGridOffsetKey(pointOffset),
    normalizeExactCacheNumber(origin.x),
    normalizeExactCacheNumber(origin.y),
    normalizeExactCacheNumber(point.x),
    normalizeExactCacheNumber(point.y),
    normalizeExactCacheNumber(origin.elevation),
    normalizeExactCacheNumber(point.elevation),
    Math.round(maxRange * 100),
    normalizeRangeCachePart(getObserverUnaidedSightRange(observerToken)),
    getSettingsSignature(settings)
  ].join(":");
}

function getSettingsSignature(settings) {
  if (settings && typeof settings === "object") {
    const cached = settingsSignatures.get(settings);
    if (cached) return cached;
    const signature = JSON.stringify(settings.attenuationLevels ?? []);
    settingsSignatures.set(settings, signature);
    return signature;
  }
  return "[]";
}

function normalizeSceneRange(value, fallback = 0) {
  if (value === null) return Infinity;
  const number = Number(value);
  if (number === Infinity) return Infinity;
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, number);
}

function normalizeRangeCachePart(value) {
  return value === Infinity ? "inf" : Math.round((Number(value) || 0) * 100);
}

function normalizeExactCacheNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "";
}

function getTokenDocumentUuid(token) {
  return String(token?.document?.uuid ?? token?.uuid ?? "").trim();
}

function readCache(map, key, { allowFalse = false } = {}) {
  if (!map.has(key)) return allowFalse ? { hit: false, value: undefined } : undefined;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
  return allowFalse ? { hit: true, value } : value;
}

function writeCache(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
}

function writeDetectionZoneCache(key, zone) {
  const weight = getDetectionZoneCacheWeight(zone);
  // A single huge preview is still returned to its caller, but retaining it
  // would immediately violate the memory budget and evict every useful zone.
  if (weight > STEALTH_DETECTION_ZONE_CACHE_CELL_LIMIT) return;

  const existing = detectionZoneCache.get(key);
  if (existing) {
    detectionZoneCachedCells -= getDetectionZoneCacheWeight(existing);
    detectionZoneCache.delete(key);
  }
  detectionZoneCache.set(key, zone);
  detectionZoneCachedCells += weight;

  while (
    detectionZoneCache.size > STEALTH_DETECTION_ZONE_CACHE_ENTRY_LIMIT
    || detectionZoneCachedCells > STEALTH_DETECTION_ZONE_CACHE_CELL_LIMIT
  ) {
    const firstKey = detectionZoneCache.keys().next().value;
    if (firstKey === undefined) break;
    const removed = detectionZoneCache.get(firstKey);
    detectionZoneCache.delete(firstKey);
    detectionZoneCachedCells -= getDetectionZoneCacheWeight(removed);
  }
  detectionZoneCachedCells = Math.max(0, detectionZoneCachedCells);
}

function getDetectionZoneCacheWeight(zone) {
  return Math.max(0, Number(zone?.offsets?.length) || 0);
}
