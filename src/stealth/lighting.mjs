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
let darknessBehaviorCache = new WeakMap();
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

export function analyzeTokenLighting(token, { position } = {}) {
  const document = token?.document ?? token;
  const level = position?.level ?? document?.level;
  const points = getTokenLightingPoints(token, position).map(point => normalizeLightingPoint({ ...point, level }));
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

  const baseDarkness = getPointDarknessLevel(elevatedPoint, activeCanvas);
  const darknessSourcePenalty = activeCanvas?.effects?.testInsideDarkness?.(elevatedPoint, {
    condition: source => isSourceInLevel(source, elevatedPoint.level, activeCanvas)
  }) ? 1 : baseDarkness;
  const light = getPointLightIntensity(elevatedPoint, baseDarkness, activeCanvas);
  const analysis = {
    baseDarkness,
    effectiveDarkness: clampAlpha(Math.max(baseDarkness, darknessSourcePenalty) - light.intensity),
    lightIntensity: light.intensity,
    smokeDispersion: light.localDispersion
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
  darknessBehaviorCache = new WeakMap();
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

function getTokenLightingPoints(token, position) {
  const document = token?.document ?? token;
  const points = document?.getVisibilityTestPoints?.(position ?? {});
  if (Array.isArray(points) && points.length) return points;
  if (position) {
    const center = document?.getCenterPoint?.(position);
    if (center) return [{ ...center, elevation: position.elevation ?? document?.elevation ?? 0 }];
    const current = getTokenCenter(token);
    return [{
      x: current.x + (Number(position.x) - (Number(document?.x) || 0)),
      y: current.y + (Number(position.y) - (Number(document?.y) || 0)),
      elevation: position.elevation ?? current.elevation
    }];
  }
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
    elevation: Number(center?.elevation ?? document?.elevation) || 0,
    level: document?.level
  };
}

function normalizeLightingPoint(point) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    elevation: Number(point?.elevation) || 0,
    level: getLevelId(point?.level ?? globalThis.canvas?.level)
  };
}

function getLightingPointCacheKey(point, activeCanvas) {
  return JSON.stringify([
    getSceneCacheKey(activeCanvas),
    getNumberCacheKey(point.x),
    getNumberCacheKey(point.y),
    getNumberCacheKey(point.elevation),
    point.level
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
      getNumberCacheKey(point.elevation),
      point.level
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

function getLevelId(level) {
  return typeof level === "string" ? level : (level?.id ?? null);
}

/**
 * V14's effects.getDarknessLevel reads viewed meshes and their last-rendered
 * uniforms. Gameplay must also work before rendering and for a token whose
 * level differs from the GM's view. Use the same behavior formulas and overlap
 * rule as AdjustDarknessLevelRegionShader/IlluminationEffectsLayer instead.
 */
function getPointDarknessLevel(point, activeCanvas) {
  const scene = activeCanvas?.scene;
  const sceneDarkness = clampAlpha(activeCanvas?.environment?.darknessLevel ?? scene?.environment?.darknessLevel);
  if (!scene?.regions) {
    return clampAlpha(activeCanvas?.effects?.getDarknessLevel?.(point) ?? sceneDarkness);
  }
  let entries = darknessBehaviorCache.get(scene);
  if (!entries) {
    entries = [];
    for (const region of scene.regions.values?.() ?? scene.regions.contents ?? scene.regions) {
      for (const behavior of region.behaviors?.values?.() ?? region.behaviors?.contents ?? region.behaviors ?? []) {
        if (behavior.type === "adjustDarknessLevel") entries.push({ region, behavior });
      }
    }
    darknessBehaviorCache.set(scene, entries);
  }
  let darkness = null;
  for (const { region, behavior } of entries) {
    if (region.hidden || behavior.disabled || behavior.active === false) continue;
    if (point.level && region.includedInLevel?.(point.level) === false) continue;
    if (!region.testPoint?.(point)) continue;
    const modifier = clampAlpha(behavior.system?.modifier);
    let adjusted;
    switch (Number(behavior.system?.mode)) {
      case 0: adjusted = modifier; break;
      case 1: adjusted = sceneDarkness * (1 - modifier); break;
      case 2: adjusted = 1 - ((1 - sceneDarkness) * (1 - modifier)); break;
      default: continue;
    }
    // Foundry sorts meshes so the lightest overlapping region wins. Each
    // adjustment uses scene darkness, not the result of the previous region.
    darkness = Math.min(darkness ?? adjusted, adjusted);
  }
  return clampAlpha(darkness ?? sceneDarkness);
}

function isSourceInLevel(source, levelId, activeCanvas) {
  if (!levelId) return true;
  const document = source?.object?.document;
  if (typeof document?.includedInLevel === "function") return document.includedInLevel(levelId);
  const sourceLevel = getLevelId(source?.level ?? source?.data?.level);
  if (!sourceLevel || sourceLevel === levelId) return true;
  return activeCanvas?.scene?.levels?.get?.(levelId)?.visibility?.levels?.has?.(sourceLevel) === true;
}

function getPointLightIntensity(point, baseDarkness, activeCanvas) {
  let intensity = getGlobalLightIntensity(point, baseDarkness, activeCanvas);
  let localIntensity = 0;
  let localDispersion = 0;
  const lightSources = activeCanvas?.effects?.lightSources;
  for (const source of lightSources?.values?.() ?? lightSources ?? []) {
    if (!source?.active || isGlobalLightSource(source)) continue;
    if (!isSourceInLevel(source, point.level, activeCanvas)) continue;
    if (!source.testPoint?.(point)) continue;
    localDispersion = 1;
    const sourceIntensity = getLocalLightIntensity(source, point);
    localIntensity = Math.max(localIntensity, sourceIntensity);
    intensity = Math.max(intensity, sourceIntensity);
  }
  return {
    intensity: clampAlpha(intensity),
    localIntensity: clampAlpha(localIntensity),
    localDispersion
  };
}

function getGlobalLightIntensity(point, baseDarkness, activeCanvas) {
  const globalLightSource = activeCanvas?.environment?.globalLightSource;
  if (!globalLightSource?.active) return 0;
  // The environment source can retain another level while the viewed level
  // changes. Apply the same membership gate used for local light sources.
  if (!isSourceInLevel(globalLightSource, point.level, activeCanvas)) return 0;
  const darkness = globalLightSource.data?.darkness ?? {};
  const minimum = Number(darkness.min) || 0;
  const maximum = Number.isFinite(Number(darkness.max)) ? Number(darkness.max) : 1;
  if (baseDarkness < minimum || baseDarkness > maximum) return 0;
  // Core global light has no spatial boundary: its local darkness threshold
  // is the test. Calling testInsideLight would query the viewed meshes again.
  return 1;
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
