import {
  createObserverOrdinaryVisionMask,
  testObserverVisibilityBatch
} from "../canvas/physical-los.mjs";
import {
  getSmokeRegionRevision,
  getSmokeRegionsInBounds,
  measureSmokePath
} from "../canvas/smoke-vision.mjs";
import { analyzeLightingPoint } from "./lighting.mjs";
import {
  getActorSmokeDensityAdjustment,
  getActorSmokePerceptionPercent
} from "../canvas/smoke-perception.mjs";
import {
  isStealthObserverIncapacitated,
  isValidStealthObserver
} from "./observers.mjs";
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
const DETECTION_DISTANCE_EPSILON = 1e-6;

const detectionZoneCache = new Map();
const detectionPointCache = new Map();
const settingsSignatures = new WeakMap();
let detectionZoneCachedCells = 0;
let detectionCacheRevision = 0;

/**
 * Build the observer zones relevant to one hidden token.
 *
 * `visibleOnly` means that the hidden token can perceive the observer. The
 * preview is actor-specific for every user role and batches every target
 * through one temporary native VisionSource.
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
    observers = observers.filter(isObserverVisibleToLocalPreview);
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
  if (
    !observerToken?.actor
    || isStealthObserverIncapacitated(observerToken)
    || !activeCanvas?.ready
    || activeCanvas.grid?.isGridless
  ) return null;
  const maxRange = evaluateStealthDetectionRange(observerToken.actor, settings);
  const maxPixels = sceneDistanceToPixels(maxRange);
  const center = normalizePoint(origin ?? getTokenCenter(observerToken), observerToken.document?.elevation);
  const contactLevel = getGridOffsetElevation(activeCanvas.grid?.getOffset?.(center));
  const cacheKey = getDetectionZoneCacheKey(observerToken, center, settings, maxRange);
  const cached = readCache(detectionZoneCache, cacheKey);
  if (cached) return cached;
  if (maxPixels <= 0) {
    const offset = normalizeGridOffset(activeCanvas.grid?.getOffset?.(center));
    if (!offset) return null;
    const zone = {
      offsets: [offset],
      contactKeys: new Set([getGridSpaceOffsetKey({ ...offset, k: contactLevel })]),
      origin: center,
      range: 0,
      truncated: false,
      cacheSignature: `${detectionCacheRevision}:${cacheKey}`
    };
    writeDetectionZoneCache(cacheKey, zone);
    return zone;
  }

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
  const smokeRegionCandidates = getSmokeRegionsInBounds({
    x: center.x - radiusWithCell,
    y: center.y - radiusWithCell,
    width: radiusWithCell * 2,
    height: radiusWithCell * 2
  }, { elevation: center.elevation });

  const ordinaryVision = createObserverOrdinaryVisionMask(observerToken, { origin: center });
  try {
    for (let i = i0; i < i1; i += 1) {
      for (let j = j0; j < j1; j += 1) {
        const offset = { i, j };
        const point = normalizePoint(activeCanvas.grid.getCenterPoint(offset), center.elevation);
        const dx = point.x - center.x;
        const dy = point.y - center.y;
        if ((dx * dx) + (dy * dy) > radiusSquared) continue;
        if (ordinaryVision && !ordinaryVision.contains(point)) continue;
        if (observerToken.checkCollision?.(point, { origin: center, type: "sight", mode: "any" })) continue;
        if (computeDetectionPathCost(observerToken, center, point, settings, {
          costLimit: maxRange,
          sampleLimit: DETECTION_PREVIEW_PATH_SAMPLE_LIMIT,
          smokeRegionCandidates
        }) > maxRange) continue;
        offsets.push(offset);
      }
    }
  } finally {
    ordinaryVision?.destroy();
  }

  const zone = {
    offsets,
    contactKeys: new Set(offsets.map(offset => getGridSpaceOffsetKey({
      ...offset,
      k: contactLevel
    }))),
    origin: center,
    range: maxRange,
    truncated: previewRange.truncated,
    cacheSignature: `${detectionCacheRevision}:${cacheKey}`
  };
  writeDetectionZoneCache(cacheKey, zone);
  return zone;
}

export function testStealthDetectionPoint(observerToken, observerOrigin, targetPoint, {
  rangeBonus = 0,
  snapTargetToGrid = true,
  settings = getRuntimeStealthSettings()
} = {}) {
  const activeCanvas = globalThis.canvas;
  if (
    !observerToken?.actor
    || isStealthObserverIncapacitated(observerToken)
    || !targetPoint
    || !activeCanvas?.ready
  ) return false;
  const origin = normalizePoint(observerOrigin ?? getTokenCenter(observerToken), observerToken.document?.elevation);
  let point = normalizePoint(targetPoint, origin.elevation);
  if (
    snapTargetToGrid
    && !activeCanvas.grid?.isGridless
    && activeCanvas.grid?.getOffset
    && activeCanvas.grid?.getCenterPoint
  ) {
    point = normalizePoint(activeCanvas.grid.getCenterPoint(activeCanvas.grid.getOffset(point)), origin.elevation);
  }
  const baseRange = evaluateStealthDetectionRange(observerToken.actor, settings);
  const normalizedRangeBonus = normalizeRangeBonus(rangeBonus);
  const maxRange = baseRange + normalizedRangeBonus;
  if (maxRange <= 0) return false;
  const cacheKey = getDetectionPointCacheKey(
    observerToken,
    origin,
    point,
    settings,
    baseRange,
    normalizedRangeBonus
  );
  const cached = readCache(detectionPointCache, cacheKey, { allowFalse: true });
  if (cached.hit) return cached.value;

  const margin = pixelsToSceneDistance(Number(activeCanvas.grid?.size) || 0);
  const directDistance = measurePointSceneDistance(origin, point);
  let result = true;
  if (directDistance > maxRange + margin) result = false;
  else if (observerToken.checkCollision?.(point, { origin, type: "sight", mode: "any" })) result = false;
  else {
    const ordinaryVision = createObserverOrdinaryVisionMask(observerToken, { origin });
    let ordinarilyVisible = true;
    try {
      ordinarilyVisible = !ordinaryVision || ordinaryVision.contains(point);
    } finally {
      ordinaryVision?.destroy();
    }
    if (!ordinarilyVisible) result = false;
    else {
      const path = computeDetectionPathReach(observerToken, origin, point, settings, { baseRange });
      result = path.cost <= baseRange + DETECTION_DISTANCE_EPSILON
        || Math.max(0, path.directDistance - path.baseReachDistance)
          <= normalizedRangeBonus + DETECTION_DISTANCE_EPSILON;
    }
  }

  writeCache(detectionPointCache, cacheKey, result, STEALTH_DETECTION_POINT_CACHE_LIMIT);
  return result;
}

/**
 * Build one grid-cell zone owned by the weapon-noise source. Unlike observer
 * zones this zone is not shaped by sight or darkness: those rules have already
 * shaped the ordinary observer zone which it must reach.
 */
export function buildWeaponNoiseZone(noiseSource, {
  noiseLevel = 0
} = {}) {
  const activeCanvas = globalThis.canvas;
  const grid = activeCanvas?.grid;
  if (
    !noiseSource
    || !activeCanvas?.ready
    || grid?.isGridless
    || typeof grid?.getOffset !== "function"
    || typeof grid?.getCenterPoint !== "function"
  ) return null;

  const normalizedNoise = normalizeWeaponNoiseLevel(noiseLevel);
  const sourceToken = noiseSource?.document ? noiseSource : null;
  const origin = normalizePoint(sourceToken ? getTokenCenter(sourceToken) : noiseSource);
  const sourceSpaces = getWeaponNoiseSourceOffsets(sourceToken, origin, grid);
  if (!sourceSpaces.length) return null;
  const sourceOffsets = collectUniqueOffsets(sourceSpaces);
  const sourceCenters = sourceSpaces.map(offset => {
    const point = grid.getCenterPoint(offset);
    return {
      x: Number(point?.x) || 0,
      y: Number(point?.y) || 0,
      k: getGridOffsetElevation(offset)
    };
  });
  if (normalizedNoise === 0) {
    const offsetKeys = new Set(sourceOffsets.map(getGridOffsetKey));
    return {
      offsets: sourceOffsets,
      offsetKeys,
      contactKeys: new Set(sourceSpaces.map(getGridSpaceOffsetKey)),
      origin,
      noiseLevel: 0
    };
  }

  const Rectangle = globalThis.PIXI?.Rectangle;
  if (typeof Rectangle !== "function" || typeof grid.getOffsetRange !== "function") return null;
  const radius = normalizedNoise * Math.max(1, Number(grid.size) || 100);
  const sourceBounds = sourceCenters.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y)
  }), {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity
  });
  const sceneRect = activeCanvas.dimensions?.rect
    ?? new Rectangle(0, 0, activeCanvas.dimensions?.width ?? Infinity, activeCanvas.dimensions?.height ?? Infinity);
  const bounds = new Rectangle(
    sourceBounds.minX - radius,
    sourceBounds.minY - radius,
    (sourceBounds.maxX - sourceBounds.minX) + (radius * 2),
    (sourceBounds.maxY - sourceBounds.minY) + (radius * 2)
  ).fit(sceneRect);
  const [i0, j0, i1, j1] = grid.getOffsetRange(bounds);
  const radiusSquared = (radius + DETECTION_DISTANCE_EPSILON) ** 2;
  const offsets = [];
  const offsetKeys = new Set();
  const contactKeys = new Set();

  for (let i = i0; i < i1; i += 1) {
    for (let j = j0; j < j1; j += 1) {
      const offset = { i, j };
      const point = grid.getCenterPoint(offset);
      const contactingSourceCenters = sourceCenters.filter(sourceCenter => {
        const dx = (Number(point?.x) || 0) - sourceCenter.x;
        const dy = (Number(point?.y) || 0) - sourceCenter.y;
        return ((dx * dx) + (dy * dy)) <= radiusSquared;
      });
      if (!contactingSourceCenters.length) continue;
      offsets.push(offset);
      offsetKeys.add(getGridOffsetKey(offset));
      for (const sourceCenter of contactingSourceCenters) {
        contactKeys.add(getGridSpaceOffsetKey({ ...offset, k: sourceCenter.k }));
      }
    }
  }

  return {
    offsets,
    offsetKeys,
    contactKeys,
    origin,
    noiseLevel: normalizedNoise
  };
}

/**
 * Authoritative contact test between the attacker's grid-cell noise zone and
 * an observer's ordinary wall- and darkness-shaped zone. Gridless scenes
 * retain the previous continuous point calculation because they have no cells.
 */
export function testWeaponNoiseZoneContact(observerToken, observerOrigin, noiseOrigin, {
  noiseLevel = 0,
  noiseZone = null,
  settings = getRuntimeStealthSettings()
} = {}) {
  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.grid?.isGridless) {
    const observerZone = buildObserverDetectionZone(observerToken, {
      origin: observerOrigin,
      settings
    });
    const sourceZone = noiseZone ?? buildWeaponNoiseZone(noiseOrigin, { noiseLevel });
    return Boolean(observerZone && sourceZone && doGridZonesOverlap(observerZone, sourceZone));
  }

  return testStealthDetectionPoint(observerToken, observerOrigin, noiseOrigin, {
    rangeBonus: weaponNoiseToRangeBonus(noiseLevel),
    snapTargetToGrid: false,
    settings
  });
}

export function isPointInsideObserverZone(
  point,
  observerToken,
  observerOrigin,
  settings = getRuntimeStealthSettings()
) {
  return testStealthDetectionPoint(observerToken, observerOrigin, point, { settings });
}

/**
 * Convert the integer weapon-noise scale to scene distance for the continuous
 * gridless fallback. On gridded scenes the same scale constructs a source-owned
 * set of cells instead of expanding observer ranges.
 */
export function weaponNoiseToRangeBonus(noiseLevel) {
  const normalizedNoise = normalizeWeaponNoiseLevel(noiseLevel);
  const gridSize = Math.max(1, Number(globalThis.canvas?.grid?.size) || 100);
  return pixelsToSceneDistance(normalizedNoise * gridSize);
}

export function doGridZonesOverlap(leftZone, rightZone) {
  const leftKeys = getZoneContactKeys(leftZone);
  const rightKeys = getZoneContactKeys(rightZone);
  const [smaller, larger] = leftKeys.size <= rightKeys.size
    ? [leftKeys, rightKeys]
    : [rightKeys, leftKeys];
  for (const key of smaller) {
    if (larger.has(key)) return true;
  }
  return false;
}

function getWeaponNoiseSourceOffsets(sourceToken, origin, grid) {
  let offsets = [];
  try {
    offsets = sourceToken?.document?.getOccupiedGridSpaceOffsets?.() ?? [];
  } catch (_error) {
    offsets = [];
  }
  if (!offsets.length) offsets = [grid.getOffset(origin)];

  const unique = new Map();
  for (const offset of offsets) {
    const normalized = normalizeGridSpaceOffset(offset);
    if (!normalized) continue;
    unique.set(getGridSpaceOffsetKey(normalized), normalized);
  }
  return [...unique.values()];
}

function collectUniqueOffsets(offsets = []) {
  const unique = new Map();
  for (const offset of offsets) {
    const normalized = normalizeGridOffset(offset);
    if (!normalized) continue;
    unique.set(getGridOffsetKey(normalized), normalized);
  }
  return [...unique.values()];
}

function getZoneContactKeys(zone) {
  if (zone?.contactKeys instanceof Set) return zone.contactKeys;
  if (zone?.offsetKeys instanceof Set) return zone.offsetKeys;
  return new Set((zone?.offsets ?? []).map(getGridOffsetKey));
}

function normalizeGridOffset(offset) {
  const i = Number(offset?.i);
  const j = Number(offset?.j);
  return Number.isFinite(i) && Number.isFinite(j) ? { i, j } : null;
}

function normalizeGridSpaceOffset(offset) {
  const normalized = normalizeGridOffset(offset);
  if (!normalized) return null;
  const k = getGridOffsetElevation(offset);
  return k === undefined ? normalized : { ...normalized, k };
}

function getGridOffsetElevation(offset) {
  const k = Number(offset?.k);
  return Number.isFinite(k) ? Math.round(k) : undefined;
}

function getGridSpaceOffsetKey(offset) {
  const key = getGridOffsetKey(offset);
  const k = getGridOffsetElevation(offset);
  return k === undefined ? key : `${key}:${k}`;
}

/**
 * Measure the ordinary darkness-attenuated path cost and the physical point
 * where that ordinary budget is exhausted. Weapon noise extends from this
 * boundary in raw scene distance, so darkness can shape the original zone
 * without shrinking a configured number of additional cells.
 */
function computeDetectionPathReach(
  observerToken,
  origin,
  destination,
  settings,
  { baseRange = 0, sampleLimit = Infinity } = {}
) {
  return measureDetectionPath(observerToken, origin, destination, settings, {
    baseRange,
    sampleLimit
  });
}

export function computeDetectionPathCost(
  observerToken,
  origin,
  destination,
  settings = getRuntimeStealthSettings(),
  { costLimit = Infinity, sampleLimit = Infinity, smokeRegionCandidates = null } = {}
) {
  return measureDetectionPath(observerToken, origin, destination, settings, {
    costLimit,
    sampleLimit,
    smokeRegionCandidates
  }).cost;
}

function measureDetectionPath(
  observerToken,
  origin,
  destination,
  settings,
  { baseRange = null, costLimit = Infinity, sampleLimit = Infinity, smokeRegionCandidates = null } = {}
) {
  const directDistance = measurePointSceneDistance(origin, destination);
  const normalizedBaseRange = baseRange === null ? null : Math.max(0, Number(baseRange) || 0);
  if (directDistance <= 0) {
    return { cost: 0, directDistance: 0, baseReachDistance: 0 };
  }

  const smokePath = measureSmokePath(origin, destination, {
    elevation: origin.elevation === destination.elevation ? origin.elevation : null,
    regionCandidates: smokeRegionCandidates,
    densityAdjustment: getActorSmokeDensityAdjustment(observerToken?.actor)
  });
  const unaidedSightRange = getObserverUnaidedSightRange(observerToken);
  const entirelyUnaided = unaidedSightRange === Infinity || unaidedSightRange >= directDistance;
  if (!smokePath.hasSmoke && entirelyUnaided) {
    return {
      cost: directDistance,
      directDistance,
      baseReachDistance: normalizedBaseRange === null
        ? directDistance
        : Math.min(directDistance, normalizedBaseRange)
    };
  }

  const minimumCost = directDistance + getSmokePathPenalty(smokePath);
  const smokeMayBeDispersed = smokePath.hasSmoke && pathMayIntersectLocalLight(origin, destination);
  if (normalizedBaseRange === null && entirelyUnaided && !smokeMayBeDispersed) {
    return { cost: minimumCost, directDistance, baseReachDistance: directDistance };
  }
  if (normalizedBaseRange === null && minimumCost > costLimit && !smokeMayBeDispersed) {
    return { cost: minimumCost, directDistance, baseReachDistance: directDistance };
  }

  const activeCanvas = globalThis.canvas;
  const stepPixels = Math.max(1, Number(activeCanvas?.grid?.size) || 100);
  // Authoritative gameplay keeps one sample per grid step. Only callers which
  // explicitly provide sampleLimit (the visual preview) use a coarse ceiling.
  const exactSteps = Math.max(1, Math.ceil(sceneDistanceToPixels(directDistance) / stepPixels));
  const normalizedSampleLimit = Number.isFinite(Number(sampleLimit))
    ? Math.max(1, Math.floor(Number(sampleLimit)))
    : Infinity;
  const steps = Math.min(exactSteps, normalizedSampleLimit);
  const pathRatios = getDetectionPathRatios(steps, smokePath);
  let consumed = 0;
  let traveled = 0;
  let baseReachDistance = normalizedBaseRange !== null && normalizedBaseRange <= 0 ? 0 : null;

  const consume = (distance, costFactor) => {
    if (distance <= 0) return;
    const factor = Number(costFactor);
    if (!Number.isFinite(factor)) {
      if (baseReachDistance === null) baseReachDistance = traveled;
      consumed = Infinity;
      traveled += distance;
      return;
    }
    const normalizedFactor = Math.max(0.0001, factor || 1);
    const segmentCost = distance * normalizedFactor;
    if (
      normalizedBaseRange !== null
      && baseReachDistance === null
      && consumed + segmentCost >= normalizedBaseRange
    ) {
      baseReachDistance = traveled + ((normalizedBaseRange - consumed) / normalizedFactor);
    }
    consumed += segmentCost;
    traveled += distance;
  };

  for (let index = 1; index < pathRatios.length; index += 1) {
    const previousRatio = pathRatios[index - 1];
    const ratio = pathRatios[index];
    const last = interpolatePathPoint(origin, destination, previousRatio);
    const point = {
      x: origin.x + ((destination.x - origin.x) * ratio),
      y: origin.y + ((destination.y - origin.y) * ratio),
      elevation: origin.elevation + ((destination.elevation - origin.elevation) * ratio)
    };
    const segmentDistance = measurePointSceneDistance(last, point);
    const startDistance = directDistance * previousRatio;
    const endDistance = directDistance * ratio;
    const distanceDelta = Math.max(0.0001, endDistance - startDistance);
    const unaidedRatio = unaidedSightRange === Infinity
      ? 1
      : clampNumber((unaidedSightRange - startDistance) / distanceDelta, 0, 1);
    const unaidedDistance = segmentDistance * unaidedRatio;
    const attenuatedDistance = Math.max(0, segmentDistance - unaidedDistance);
    const rawSmokeCostFactor = getSmokeCostFactor(smokePath, previousRatio, ratio, segmentDistance);
    const lighting = attenuatedDistance > 0 || rawSmokeCostFactor > 0
      ? analyzeLightingPoint(point)
      : null;
    const smokeCostFactor = applySmokeDispersion(rawSmokeCostFactor, lighting?.smokeDispersion ?? 0);
    consume(unaidedDistance, 1 + smokeCostFactor);
    if (attenuatedDistance > 0) {
      const factor = getDetectionRangeFactor(lighting.effectiveDarkness, settings);
      consume(attenuatedDistance, (1 / Math.max(0.01, factor)) + smokeCostFactor);
    }
    if (consumed > costLimit && normalizedBaseRange === null) break;
    if (consumed === Infinity) break;
  }

  if (baseReachDistance === null) baseReachDistance = directDistance;
  return { cost: consumed, directDistance, baseReachDistance };
}

function getDetectionPathRatios(steps, smokePath) {
  const ratios = new Set([0, 1]);
  for (let index = 1; index < steps; index += 1) ratios.add(index / steps);
  if (smokePath.hasSmoke) {
    for (const segment of smokePath.segments) {
      ratios.add(segment.start);
      ratios.add(segment.end);
    }
  }
  return [...ratios].sort((left, right) => left - right);
}

function getSmokePathPenalty(smokePath) {
  if (!smokePath.hasSmoke) return 0;
  if (smokePath.cost === Infinity) return Infinity;
  return pixelsToSceneDistance(Math.max(0, smokePath.cost - smokePath.length));
}

function getSmokeCostFactor(smokePath, startRatio, endRatio, segmentDistance) {
  if (!smokePath.hasSmoke || segmentDistance <= 0) return 0;
  const midpoint = (startRatio + endRatio) / 2;
  const retained = smokePath.segments.find(segment => (
    midpoint >= segment.start - DETECTION_DISTANCE_EPSILON
    && midpoint <= segment.end + DETECTION_DISTANCE_EPSILON
  ))?.retained ?? 1;
  if (retained <= DETECTION_DISTANCE_EPSILON) return Infinity;
  const horizontalDistance = pixelsToSceneDistance(smokePath.length * (endRatio - startRatio));
  return (horizontalDistance * ((1 / retained) - 1)) / segmentDistance;
}

function applySmokeDispersion(smokeCostFactor, localLightIntensity) {
  const dispersion = clampNumber(localLightIntensity, 0, 1);
  if (dispersion >= 1 - DETECTION_DISTANCE_EPSILON) return 0;
  if (!Number.isFinite(smokeCostFactor)) return Infinity;
  return smokeCostFactor * (1 - dispersion);
}

function pathMayIntersectLocalLight(origin, destination) {
  const minX = Math.min(origin.x, destination.x);
  const maxX = Math.max(origin.x, destination.x);
  const minY = Math.min(origin.y, destination.y);
  const maxY = Math.max(origin.y, destination.y);
  const sources = globalThis.canvas?.effects?.lightSources;
  for (const source of sources?.values?.() ?? sources ?? []) {
    if (!source?.active || source?.constructor?.name === "GlobalLightSource" || source?.name === "GlobalLight") continue;
    const bounds = source.shape?.bounds ?? source.shape?.getBounds?.();
    if (!bounds) return true;
    if (
      bounds.x <= maxX
      && bounds.x + bounds.width >= minX
      && bounds.y <= maxY
      && bounds.y + bounds.height >= minY
    ) return true;
  }
  return false;
}

function interpolatePathPoint(origin, destination, ratio) {
  return {
    x: origin.x + ((destination.x - origin.x) * ratio),
    y: origin.y + ((destination.y - origin.y) * ratio),
    elevation: origin.elevation + ((destination.elevation - origin.elevation) * ratio)
  };
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
  detectionCacheRevision += 1;
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
 * Keep gridded zone construction bounded before entering the O(cells * samples)
 * loop. Oversized ranges are cropped around the observer. Shared-cell gameplay
 * and hover both use these same retained cells so they cannot disagree.
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
    normalizeExactCacheNumber(getActorSmokePerceptionPercent(observerToken?.actor)),
    getSmokeRegionRevision(activeCanvas?.scene),
    getSettingsSignature(settings)
  ].join(":");
}

function getDetectionPointCacheKey(observerToken, origin, point, settings, baseRange, rangeBonus) {
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
    Math.round(baseRange * 100),
    Math.round(rangeBonus * 100),
    normalizeRangeCachePart(getObserverUnaidedSightRange(observerToken)),
    normalizeExactCacheNumber(getActorSmokePerceptionPercent(observerToken?.actor)),
    getSmokeRegionRevision(activeCanvas?.scene),
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

function normalizeRangeBonus(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function normalizeWeaponNoiseLevel(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
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

function isObserverVisibleToLocalPreview(observerToken) {
  if (observerToken?.document?.hidden === true || observerToken?.hidden === true) return false;
  const secret = globalThis.CONST?.TOKEN_DISPOSITIONS?.SECRET;
  if (secret !== undefined && observerToken?.document?.disposition === secret) return false;
  return true;
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
