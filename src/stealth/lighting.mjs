/**
 * Shared scene-lighting measurements used by stealth, traps and ability
 * conditions.  Keep the calculation in one place so every subsystem sees the
 * same value and callers can cache the relatively expensive token sampling.
 */
import { getSmokeLightBandAtPoint } from "../canvas/smoke-vision.mjs";

const POINT_LIGHTING_CACHE_LIMIT = 2048;
const TOKEN_LIGHTING_CACHE_LIMIT = 256;
const TOKEN_CACHE_POINT_LIMIT = 64;

const pointLightingCache = new Map();
const tokenLightingCache = new Map();
const cacheObjectIds = new WeakMap();
const cacheStatistics = {
  pointHits: 0,
  pointMisses: 0,
  tokenHits: 0,
  tokenMisses: 0,
  tokenBypasses: 0,
  invalidations: 0
};
let nextCacheObjectId = 1;

export function analyzeTokenLighting(token) {
  const points = getTokenLightingPoints(token).map(point => normalizeLightingPoint(point));
  const cacheKey = getTokenLightingCacheKey(token, points, globalThis.canvas);
  if (cacheKey) {
    const cached = getLruEntry(tokenLightingCache, cacheKey);
    if (cached) {
      cacheStatistics.tokenHits += 1;
      return cloneLightingAnalysis(cached);
    }
    cacheStatistics.tokenMisses += 1;
  } else {
    cacheStatistics.tokenBypasses += 1;
  }

  const samples = points.map(point => analyzeLightingPoint(point));
  const brightest = samples.reduce(
    (best, sample) => sample.effectiveDarkness < best.effectiveDarkness ? sample : best,
    samples[0] ?? analyzeLightingPoint(getTokenCenter(token))
  );
  const analysis = {
    ...brightest,
    darknessLabel: brightest.effectiveDarkness.toFixed(2),
    darknessPercent: Math.round(brightest.effectiveDarkness * 100),
    illuminationPercent: Math.round((1 - brightest.effectiveDarkness) * 100)
  };
  if (cacheKey) setLruEntry(tokenLightingCache, cacheKey, analysis, TOKEN_LIGHTING_CACHE_LIMIT);
  return cacheKey ? cloneLightingAnalysis(analysis) : analysis;
}

export function getTokenIlluminationPercent(token) {
  return analyzeTokenLighting(token).illuminationPercent;
}

export function analyzeLightingPoint(point) {
  const activeCanvas = globalThis.canvas;
  const elevatedPoint = normalizeLightingPoint(point);
  const cacheKey = getLightingPointCacheKey(elevatedPoint, activeCanvas);
  const cached = getLruEntry(pointLightingCache, cacheKey);
  if (cached) {
    cacheStatistics.pointHits += 1;
    return cloneLightingAnalysis(cached);
  }
  cacheStatistics.pointMisses += 1;

  const baseDarkness = clampAlpha(
    activeCanvas?.effects?.getDarknessLevel?.(elevatedPoint)
      ?? activeCanvas?.environment?.darknessLevel
      ?? activeCanvas?.scene?.environment?.darknessLevel
      ?? 0
  );
  const darknessSourcePenalty = activeCanvas?.effects?.testInsideDarkness?.(elevatedPoint) ? 1 : baseDarkness;
  const light = getPointLightIntensity(elevatedPoint, baseDarkness, activeCanvas);
  const analysis = {
    baseDarkness,
    effectiveDarkness: clampAlpha(Math.max(baseDarkness, darknessSourcePenalty) - light.intensity),
    lightIntensity: light.intensity,
    smokeDispersion: light.localIntensity
  };
  setLruEntry(pointLightingCache, cacheKey, analysis, POINT_LIGHTING_CACHE_LIMIT);
  return cloneLightingAnalysis(analysis);
}

/**
 * Clear cached measurements after lighting, darkness, scene or token geometry
 * changes. Hook ownership intentionally stays with the calling subsystem.
 */
export function invalidateLightingAnalysisCache() {
  pointLightingCache.clear();
  tokenLightingCache.clear();
  cacheStatistics.invalidations += 1;
}

/**
 * Lightweight diagnostics used by focused tests and performance inspection.
 */
export function getLightingAnalysisCacheStats() {
  return {
    point: {
      entries: pointLightingCache.size,
      maxEntries: POINT_LIGHTING_CACHE_LIMIT,
      hits: cacheStatistics.pointHits,
      misses: cacheStatistics.pointMisses
    },
    token: {
      entries: tokenLightingCache.size,
      maxEntries: TOKEN_LIGHTING_CACHE_LIMIT,
      hits: cacheStatistics.tokenHits,
      misses: cacheStatistics.tokenMisses,
      bypasses: cacheStatistics.tokenBypasses
    },
    invalidations: cacheStatistics.invalidations
  };
}

function getTokenLightingPoints(token) {
  const document = token?.document ?? token;
  const points = document?.getVisibilityTestPoints?.();
  if (Array.isArray(points) && points.length) return points;
  return [getTokenCenter(token)];
}

function getTokenCenter(token) {
  const document = token?.document ?? token;
  const center = document?.getCenterPoint?.() ?? token?.center ?? {
    x: Number(document?.x) || 0,
    y: Number(document?.y) || 0
  };
  return {
    x: Number(center?.x) || 0,
    y: Number(center?.y) || 0,
    elevation: Number(center?.elevation ?? document?.elevation) || 0
  };
}

function normalizeLightingPoint(point) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    elevation: Number(point?.elevation) || 0
  };
}

function getLightingPointCacheKey(point, activeCanvas) {
  return JSON.stringify([
    getSceneCacheKey(activeCanvas),
    getNumberCacheKey(point.x),
    getNumberCacheKey(point.y),
    getNumberCacheKey(point.elevation)
  ]);
}

function getTokenLightingCacheKey(token, points, activeCanvas) {
  if (points.length > TOKEN_CACHE_POINT_LIMIT) return null;
  const document = token?.document ?? token;
  return JSON.stringify([
    getSceneCacheKey(activeCanvas),
    getObjectCacheKey(document, "token"),
    points.map(point => [
      getNumberCacheKey(point.x),
      getNumberCacheKey(point.y),
      getNumberCacheKey(point.elevation)
    ])
  ]);
}

function getSceneCacheKey(activeCanvas) {
  const scene = activeCanvas?.scene;
  if (scene !== null && scene !== undefined) return getObjectCacheKey(scene, "scene");
  return getObjectCacheKey(activeCanvas, "canvas");
}

function getObjectCacheKey(value, prefix) {
  const type = typeof value;
  if ((type === "object" && value !== null) || type === "function") {
    let id = cacheObjectIds.get(value);
    if (!id) {
      id = nextCacheObjectId;
      nextCacheObjectId += 1;
      cacheObjectIds.set(value, id);
    }
    return `${prefix}:object:${id}`;
  }
  return `${prefix}:${type}:${String(value)}`;
}

function getNumberCacheKey(value) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Infinity";
  if (value === -Infinity) return "-Infinity";
  return String(value);
}

function getLruEntry(cache, key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setLruEntry(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size <= limit) return;
  cache.delete(cache.keys().next().value);
}

function cloneLightingAnalysis(analysis) {
  return { ...analysis };
}

function getPointLightIntensity(point, baseDarkness, activeCanvas) {
  let intensity = getGlobalLightIntensity(point, baseDarkness, activeCanvas);
  let localIntensity = 0;
  const lightSources = activeCanvas?.effects?.lightSources;
  for (const source of lightSources?.values?.() ?? lightSources ?? []) {
    if (!source?.active || isGlobalLightSource(source)) continue;
    if (!source.testPoint?.(point)) continue;
    const sourceIntensity = getLocalLightIntensity(source, point);
    localIntensity = Math.max(localIntensity, sourceIntensity);
    intensity = Math.max(intensity, sourceIntensity);
  }
  return {
    intensity: clampAlpha(intensity),
    localIntensity: clampAlpha(localIntensity)
  };
}

function getGlobalLightIntensity(point, baseDarkness, activeCanvas) {
  const globalLightSource = activeCanvas?.environment?.globalLightSource;
  if (!globalLightSource?.active) return 0;
  const darkness = globalLightSource.data?.darkness ?? {};
  const minimum = Number(darkness.min) || 0;
  const maximum = Number.isFinite(Number(darkness.max)) ? Number(darkness.max) : 1;
  if (baseDarkness < minimum || baseDarkness > maximum) return 0;
  return activeCanvas?.effects?.testInsideLight?.(point, { condition: source => isGlobalLightSource(source) }) ? 1 : 0;
}

function getLocalLightIntensity(source, point) {
  const origin = source.origin ?? source;
  const distance = Math.hypot(point.x - (Number(origin.x) || 0), point.y - (Number(origin.y) || 0));
  const brightRadius = Math.max(0, Number(source.data?.bright) || 0);
  const dimRadius = Math.max(brightRadius, Number(source.data?.dim) || Number(source.data?.radius) || 0);
  const smokeBand = getSmokeLightBandAtPoint(source, point);
  if (smokeBand === "none") return 0;
  if (smokeBand === "bright") return 1;
  if (smokeBand === null && brightRadius > 0 && distance <= brightRadius) return 1;
  if (dimRadius <= 0 || distance > dimRadius) return 0;
  if (dimRadius <= brightRadius) return 0.5;
  if (smokeBand === "dim" && distance <= brightRadius) return 0.5;
  const ratio = clampAlpha((distance - brightRadius) / Math.max(1, dimRadius - brightRadius));
  return 0.5 + ((1 - ratio) * 0.5);
}

function isGlobalLightSource(source) {
  return source?.constructor?.name === "GlobalLightSource" || source?.name === "GlobalLight";
}

function clampAlpha(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}
