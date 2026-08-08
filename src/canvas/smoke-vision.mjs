import { SYSTEM_ID } from "../constants.mjs";
import { getSmokeRuntimeProperties } from "../utils/region-special-properties.mjs";
import { toOptionalFiniteNumber } from "../utils/numbers.mjs";

const PERIODIC_DAMAGE_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const PERIODIC_DAMAGE_FLAG = "periodicDamage";
const SMOKE_EDGE_TYPE = `${SYSTEM_ID}.smoke`;
const CELL_SIZE = 512;
const MIN_CONSTRAINT_SAMPLES = 48;
const MAX_CONSTRAINT_SAMPLES = 192;
const SOURCE_CONSTRAINT_CACHE_LIMIT = 2;
const EPSILON = 1e-6;
const ANGLE_EPSILON = 1e-7;

let smokeIndexByScene = new WeakMap();
let smokeRevisionByScene = new WeakMap();
let smokeIndexSignatureByScene = new WeakMap();
let smokeSignatureByScene = new WeakMap();
let sourceConstraintCache = new WeakMap();
let clearSmokeLosCache = new WeakMap();
const smokeMeshes = new Map();
const smokeBoundaryEdgeIds = new Set();
const smokeBoundaryBehaviorUuids = new Set();
let smokeBoundaryEdgeScene = null;
let smokeBoundaryEdgeSignature = "";

export function registerSmokeVisionHooks() {
  patchSmokeDetectionRanges();
  registerSmokeSweepBackend();
  registerVisionSourceClass();
  Hooks.on("createRegion", document => refreshForDocument(document));
  Hooks.on("deleteRegion", document => refreshForDocument(document));
  Hooks.on("updateRegion", (document, changed) => {
    if (hasAnyChangedPath(changed, ["shapes", "elevation", "hidden", "visibility", "levels"])) {
      refreshForDocument(document);
    }
  });
  Hooks.on("createRegionBehavior", document => refreshForDocument(document));
  Hooks.on("deleteRegionBehavior", document => refreshForDocument(document));
  Hooks.on("updateRegionBehavior", (document, changed) => {
    if (document?.type !== PERIODIC_DAMAGE_BEHAVIOR_TYPE) return;
    if (hasAnyChangedPath(changed, [
      "disabled",
      "type",
      "system.regionSpecialProperties",
      "system.delaySeconds",
      "system.durationSeconds",
      `flags.${SYSTEM_ID}.${PERIODIC_DAMAGE_FLAG}.activateAt`,
      `flags.${SYSTEM_ID}.${PERIODIC_DAMAGE_FLAG}.expiresAt`
    ])) refreshForDocument(document);
  });
  Hooks.on("canvasReady", () => {
    patchSmokeDetectionRanges();
    registerSmokeSweepBackend();
    registerVisionSourceClass();
    invalidateSmokeRegionIndex(canvas?.scene);
    syncSmokeDarknessMeshes({ forceRendering: true, forceVision: true });
  });
  Hooks.on("updateWorldTime", (worldTime, delta) => {
    const index = getSmokeRegionIndex(canvas?.scene);
    const transitionDue = Number.isFinite(index?.nextTransitionAt)
      && Number(worldTime) >= index.nextTransitionAt;
    if (!(Number(delta) < 0) && !transitionDue) return;
    invalidateSmokeRegionIndex(canvas?.scene, { bumpRevision: false });
    scheduleSmokeRefresh();
  });
  Hooks.on("canvasTearDown", () => {
    destroySmokeBoundaryEdges();
    destroySmokeDarknessMeshes();
    smokeIndexByScene = new WeakMap();
    smokeRevisionByScene = new WeakMap();
    smokeIndexSignatureByScene = new WeakMap();
    smokeSignatureByScene = new WeakMap();
    sourceConstraintCache = new WeakMap();
    clearSmokeLosCache = new WeakMap();
  });
}

function refreshForDocument(document) {
  const scene = document?.documentName === "Scene"
    ? document
    : document?.parent?.documentName === "Scene"
      ? document.parent
      : document?.parent?.parent?.documentName === "Scene"
        ? document.parent.parent
        : canvas?.scene;
  invalidateSmokeRegionIndex(scene);
  scheduleSmokeRefresh({ forceRendering: true, forceVision: true });
}

function hasAnyChangedPath(changed, paths) {
  if (!changed || typeof changed !== "object") return false;
  return paths.some(path => {
    if (Object.hasOwn(changed, path) || Object.keys(changed).some(key => key.startsWith(`${path}.`))) return true;
    let value = changed;
    for (const part of path.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return false;
      value = value[part];
    }
    return true;
  });
}

export function invalidateSmokeRegionIndex(scene = canvas?.scene, { bumpRevision = true } = {}) {
  if (!scene) return;
  smokeIndexByScene.delete(scene);
  if (bumpRevision) smokeRevisionByScene.set(scene, (smokeRevisionByScene.get(scene) ?? 0) + 1);
}

export function queueSmokeRegionRefresh({ forceRendering = true, forceVision = true } = {}) {
  invalidateSmokeRegionIndex(canvas?.scene);
  scheduleSmokeRefresh({ forceRendering, forceVision });
}

export function getSmokeRegionIndex(scene = canvas?.scene) {
  if (!scene) return null;
  const cached = smokeIndexByScene.get(scene);
  if (cached) return cached;
  const entries = [];
  const buckets = new Map();
  let nextTransitionAt = Infinity;
  const now = Number(globalThis.game?.time?.worldTime) || 0;
  for (const region of scene.regions?.contents ?? []) {
    if (!region || region.hidden) continue;
    for (const behavior of region.behaviors?.contents ?? []) {
      if (
        behavior.type !== PERIODIC_DAMAGE_BEHAVIOR_TYPE
        || behavior.disabled
        || behavior.viewed === false
        || behavior.visible === false
      ) continue;
      const state = getSmokeRegionState(behavior, now);
      if (!state) continue;
      if (Number.isFinite(state.nextTransitionAt)) nextTransitionAt = Math.min(nextTransitionAt, state.nextTransitionAt);
      if (!state.active) continue;
      const entry = {
        region,
        behavior,
        smoke: state.smoke,
        bounds: getRegionBounds(region),
        geometry: getSmokeRegionGeometry(region)
      };
      const index = entries.push(entry) - 1;
      for (const key of getBoundsCells(entry.bounds)) {
        const bucket = buckets.get(key) ?? [];
        bucket.push(index);
        buckets.set(key, bucket);
      }
    }
  }
  const signature = entries
    .map(entry => `${entry.behavior.uuid}:${entry.smoke.thickness}:${entry.smoke.density}`)
    .sort()
    .join("|");
  if (smokeIndexSignatureByScene.get(scene) !== signature) {
    smokeIndexSignatureByScene.set(scene, signature);
    smokeRevisionByScene.set(scene, (smokeRevisionByScene.get(scene) ?? 0) + 1);
  }
  const index = {
    entries,
    buckets,
    hasVisionSmoke: entries.some(entry => entry.smoke.density > EPSILON),
    hasPartialVisionSmoke: entries.some(entry => (
      entry.smoke.density > EPSILON && entry.smoke.density < 1 - EPSILON
    )),
    hasOpaqueVisionSmoke: entries.some(entry => entry.smoke.density >= 1 - EPSILON),
    nextTransitionAt: Number.isFinite(nextTransitionAt) ? nextTransitionAt : null,
    revision: smokeRevisionByScene.get(scene) ?? 0
  };
  smokeIndexByScene.set(scene, index);
  return index;
}

export function getSmokeRegionRevision(scene = canvas?.scene) {
  return getSmokeRegionIndex(scene)?.revision ?? 0;
}

export function getSmokeRegionsAlongRay(from, to, { scene = canvas?.scene, elevation = null } = {}) {
  return getSmokeRegionsInBounds(getSegmentBounds(from, to), { scene, elevation });
}

export function getSmokeRegionsInBounds(bounds, { scene = canvas?.scene, elevation = null } = {}) {
  const index = getSmokeRegionIndex(scene);
  if (!index?.hasVisionSmoke) return [];
  const candidates = new Set();
  for (const key of getBoundsCells(bounds)) {
    for (const candidate of index.buckets.get(key) ?? []) candidates.add(candidate);
  }
  for (const [candidate, entry] of index.entries.entries()) {
    if (!entry.bounds) candidates.add(candidate);
  }
  return [...candidates]
    .map(candidate => index.entries[candidate])
    .filter(entry => entry?.smoke?.density > EPSILON)
    .filter(entry => entry && (!entry.bounds || boundsIntersect(entry.bounds, bounds)))
    .filter(entry => isRegionOnElevation(entry.region, elevation));
}

export function calculateSmokePathCost(from, to, { scene = canvas?.scene, elevation = null } = {}) {
  return measureSmokePath(from, to, { scene, elevation }).cost;
}

export function measureSmokePath(from, to, {
  scene = canvas?.scene,
  elevation = null,
  budget = Infinity,
  regionCandidates = null,
  chargeClearDistance = true
} = {}) {
  const profile = buildSmokePathProfile(from, to, { scene, elevation, regionCandidates });
  let cost = 0;
  for (const segment of profile.segments) {
    if (segment.retained <= EPSILON) {
      cost = Infinity;
      break;
    }
    if (!chargeClearDistance && segment.retained >= 1 - EPSILON) continue;
    cost += segment.length / segment.retained;
  }
  return {
    cost,
    hasSmoke: profile.hasSmoke,
    length: profile.length,
    segments: profile.segments,
    visibleDistance: calculateProfileVisibleDistance(profile, budget, { chargeClearDistance })
  };
}

function buildSmokePathProfile(from, to, { scene = canvas?.scene, elevation = null, regionCandidates = null } = {}) {
  const start = normalizePoint(from);
  const end = normalizePoint(to);
  const totalLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (!totalLength) return { hasSmoke: false, length: 0, segments: [] };
  const queryElevation = elevation === null || elevation === undefined || start.elevation !== end.elevation
    ? null
    : elevation;
  const segmentBounds = getSegmentBounds(start, end);
  const regions = (regionCandidates ?? getSmokeRegionsAlongRay(start, end, { scene, elevation: queryElevation }))
    .filter(entry => !entry.bounds || boundsIntersect(entry.bounds, segmentBounds))
    .filter(entry => isRegionOnElevation(entry.region, queryElevation));
  if (!regions.length) return {
    hasSmoke: false,
    length: totalLength,
    segments: [{ start: 0, end: 1, length: totalLength, retained: 1 }]
  };

  const intervals = new Map();
  const breakpoints = new Set([0, 1]);
  for (const entry of regions) {
    const segments = getRegionRayIntervals(entry, start, end, elevation);
    intervals.set(entry, segments);
    for (const [a, b] of segments) {
      breakpoints.add(a);
      breakpoints.add(b);
    }
  }

  const sorted = [...breakpoints].sort((left, right) => left - right);
  const segments = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b - a <= EPSILON) continue;
    const midpoint = (a + b) / 2;
    let retained = 1;
    for (const entry of regions) {
      if (!intervals.get(entry)?.some(([startT, endT]) => midpoint >= startT - EPSILON && midpoint <= endT + EPSILON)) continue;
      retained *= Math.max(0, 1 - Number(entry.smoke.density) || 0);
    }
    segments.push({ start: a, end: b, length: totalLength * (b - a), retained });
  }
  return {
    hasSmoke: segments.some(segment => segment.retained < 1 - EPSILON),
    length: totalLength,
    segments
  };
}

export function isSmokePathVisible(from, to, maximumDistance, options = {}) {
  const budget = Number(maximumDistance);
  const measurement = measureSmokePath(from, to, options);
  if (budget === Infinity) return measurement.cost !== Infinity;
  if (!Number.isFinite(budget) || budget < 0) return false;
  return measurement.cost <= budget + EPSILON;
}

function registerVisionSourceClass() {
  const base = CONFIG.Canvas?.visionSourceClass;
  if (!base || base.__falloutMawSmokeVisionSource) return;
  class SmokeVisionSource extends base {
    _getPolygonConfiguration() {
      const config = super._getPolygonConfiguration();
      const index = getSmokeRegionIndex(canvas?.scene);
      if (index?.hasOpaqueVisionSmoke && smokeBoundaryEdgeIds.size) {
        config._falloutMawIncludeSmokeEdges = true;
      }
      return config;
    }

    _createShapes() {
      super._createShapes();
      const index = getSmokeRegionIndex(canvas?.scene);
      if (!index?.hasVisionSmoke) return;
      const lightRadius = this.lightRadius || 0;
      const sightRadius = this.radius || this.data.externalRadius || 0;
      this.light = applySmokeConstraint(this, this.light, lightRadius, {
        chargeClearDistance: false
      });
      this.shape = applySmokeConstraint(this, this.shape, sightRadius);
    }
  }
  Object.defineProperty(SmokeVisionSource, "__falloutMawSmokeVisionSource", { value: true });
  CONFIG.Canvas.visionSourceClass = SmokeVisionSource;
}

function registerSmokeSweepBackend() {
  const base = CONFIG.Canvas?.polygonBackends?.sight;
  if (!base || base.__falloutMawSmokeSweepBackend) return;
  class SmokeClockwiseSweepPolygon extends base {
    _testEdgeInclusion(edge, edgeTypes) {
      if (edge.type === SMOKE_EDGE_TYPE) {
        return this.config._falloutMawIncludeSmokeEdges === true
          && isRegionOnElevation(edge._falloutMawSmokeRegion, this.origin.elevation);
      }
      return super._testEdgeInclusion(edge, edgeTypes);
    }
  }
  Object.defineProperty(SmokeClockwiseSweepPolygon, "__falloutMawSmokeSweepBackend", { value: true });
  CONFIG.Canvas.polygonBackends.sight = SmokeClockwiseSweepPolygon;
}

function applySmokeConstraint(source, basePolygon, radius, { chargeClearDistance = true } = {}) {
  if (!radius || !canvas?.scene || !getSmokeRegionIndex(canvas.scene)?.hasVisionSmoke) return basePolygon;
  const budget = getBasicSightRadius(source, radius);
  if (budget === null) return basePolygon;
  const star = buildSmokeConstraint(source, radius, budget, { chargeClearDistance });
  return star ? basePolygon.applyConstraint(star) : basePolygon;
}

function buildSmokeConstraint(source, radius, budget = radius, { chargeClearDistance = true } = {}) {
  radius = Number.isFinite(radius) ? radius : (canvas.dimensions?.maxR ?? 0);
  if (!radius) return null;
  const { x, y, elevation } = source.data;
  const revision = getSmokeRegionIndex(canvas.scene)?.revision ?? 0;
  const cachedEntries = sourceConstraintCache.get(source) ?? [];
  const cached = cachedEntries.find(entry => entry.revision === revision
    && entry.x === x
    && entry.y === y
    && entry.elevation === elevation
    && entry.radius === radius
    && entry.budget === budget
    && entry.chargeClearDistance === chargeClearDistance);
  if (cached) return cached.polygon;
  const regionCandidates = getSmokeRegionsInBounds({
    x: x - radius,
    y: y - radius,
    width: radius * 2,
    height: radius * 2
  }, { elevation }).filter(requiresRayAttenuation);
  if (!regionCandidates.length) {
    writeSourceConstraintCache(source, cachedEntries, {
      revision, x, y, elevation, radius, budget, chargeClearDistance, polygon: null
    });
    return null;
  }
  const origin = { x, y, elevation };
  const angles = getSmokeConstraintAngles(origin, radius, regionCandidates);
  const points = [];
  for (const angle of angles) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const distance = calculateSmokeVisibleDistance(
      origin,
      { x: x + (dx * radius), y: y + (dy * radius), elevation },
      budget,
      { elevation, regionCandidates, chargeClearDistance }
    );
    points.push(x + (dx * distance), y + (dy * distance));
  }
  const polygon = new PIXI.Polygon(points);
  writeSourceConstraintCache(source, cachedEntries, {
    revision, x, y, elevation, radius, budget, chargeClearDistance, polygon
  });
  return polygon;
}

function getSmokeConstraintAngles(origin, radius, regionCandidates) {
  const nativeDensity = Number(globalThis.PIXI?.Circle?.approximateVertexDensity?.(radius));
  const baseDensity = Math.max(
    MIN_CONSTRAINT_SAMPLES,
    Math.min(MAX_CONSTRAINT_SAMPLES, Number.isFinite(nativeDensity) ? nativeDensity : MIN_CONSTRAINT_SAMPLES)
  );
  const angles = [];
  const baseStep = (Math.PI * 2) / baseDensity;
  for (let i = 0; i < baseDensity; i++) angles.push(i * baseStep);
  for (const entry of regionCandidates) addRegionBoundaryConstraintAngles(angles, origin, entry);
  angles.sort((left, right) => left - right);
  const unique = [];
  for (const angle of angles) {
    if (!unique.length || angle - unique.at(-1) > ANGLE_EPSILON) unique.push(angle);
  }
  return unique;
}

function addRegionBoundaryConstraintAngles(angles, origin, entry) {
  const polygons = entry.geometry?.polygons ?? getRegionPolygons(entry.region);
  let added = false;
  for (const polygon of polygons ?? []) {
    const points = polygon?.points ?? [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      addBoundaryPointAngle(angles, origin, { x: points[i], y: points[i + 1] });
      added = true;
    }
  }
  if (added) return;
  const bounds = entry.bounds ?? getRegionBounds(entry.region);
  if (!bounds) return;
  addBoundaryPointAngle(angles, origin, { x: bounds.x, y: bounds.y });
  addBoundaryPointAngle(angles, origin, { x: bounds.x + bounds.width, y: bounds.y });
  addBoundaryPointAngle(angles, origin, { x: bounds.x + bounds.width, y: bounds.y + bounds.height });
  addBoundaryPointAngle(angles, origin, { x: bounds.x, y: bounds.y + bounds.height });
}

function addBoundaryPointAngle(angles, origin, point) {
  const dx = Number(point.x) - origin.x;
  const dy = Number(point.y) - origin.y;
  if (!dx && !dy) return;
  angles.push(normalizeAngle(Math.atan2(dy, dx)));
}

function normalizeAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

function writeSourceConstraintCache(source, entries, value) {
  sourceConstraintCache.set(source, [value, ...entries].slice(0, SOURCE_CONSTRAINT_CACHE_LIMIT));
}

function calculateSmokeVisibleDistance(from, to, budget, options = {}) {
  const profile = buildSmokePathProfile(from, to, options);
  if (!profile.hasSmoke) return profile.length;
  return calculateProfileVisibleDistance(profile, budget, options);
}

function calculateProfileVisibleDistance(profile, budget, { chargeClearDistance = true } = {}) {
  if (budget === Infinity) {
    const opaque = profile.segments.find(segment => segment.retained <= EPSILON);
    return opaque ? opaque.start * profile.length : profile.length;
  }
  let remaining = Math.max(0, Number(budget) || 0);
  for (const segment of profile.segments) {
    if (segment.retained <= EPSILON) return segment.start * profile.length;
    if (!chargeClearDistance && segment.retained >= 1 - EPSILON) continue;
    const cost = segment.length / segment.retained;
    if (cost > remaining) return (segment.start * profile.length) + (remaining * segment.retained);
    remaining -= cost;
  }
  return profile.length;
}

function getBasicSightRadius(source, fallbackRadius) {
  const document = source.object?.document;
  const modes = document?.detectionModes;
  const basicSight = modes?.get?.("basicSight")
    ?? modes?.basicSight
    ?? getDetectionModeValues(modes).find(mode => mode?.id === "basicSight");
  if (basicSight?.enabled === false) return null;
  const range = basicSight?.range;
  if (range === null || range === Infinity) return fallbackRadius;
  if (!Number.isFinite(Number(range))) return fallbackRadius;
  const radius = Number(source.object?.getLightRadius?.(Math.max(0, Number(range))));
  if (!Number.isFinite(radius)) return fallbackRadius;
  return Math.min(fallbackRadius, Math.max(0, radius));
}

function getDetectionModeValues(modes) {
  if (!modes) return [];
  if (typeof modes[Symbol.iterator] === "function") return Array.from(modes);
  return typeof modes === "object" ? Object.values(modes) : [];
}

function patchSmokeDetectionRanges() {
  patchBasicSightRange(CONFIG.Canvas?.detectionModes?.basicSight);
  patchLightPerceptionRange(CONFIG.Canvas?.detectionModes?.lightPerception);
  patchSpecialSenseSmokeLos();
}

function patchBasicSightRange(mode) {
  if (!mode || mode._falloutMawSmokeRangePatched) return;
  const original = mode._testRange;
  if (typeof original !== "function") return;
  mode._testRange = function smokeAwareRange(visionSource, detectionMode, target, test) {
    if (!original.call(this, visionSource, detectionMode, target, test)) return false;
    const maximumDistance = detectionMode.range === Infinity
      ? Infinity
      : visionSource.object.getLightRadius(detectionMode.range);
    const index = getSmokeRegionIndex(canvas?.scene);
    if (!hasRayAttenuationSmoke(index)) return true;
    const origin = { x: visionSource.data.x, y: visionSource.data.y, elevation: visionSource.data.elevation };
    const regionCandidates = getSmokeRegionsAlongRay(origin, test.point, {
      elevation: origin.elevation
    }).filter(requiresRayAttenuation);
    if (!regionCandidates.length) return true;
    return isSmokePathVisible(
      origin,
      test.point,
      maximumDistance,
      { elevation: origin.elevation, regionCandidates }
    );
  };
  Object.defineProperty(mode, "_falloutMawSmokeRangePatched", { value: true });
}

function patchLightPerceptionRange(mode) {
  if (!mode || mode._falloutMawSmokeRangePatched) return;
  const original = mode._testRange;
  if (typeof original !== "function") return;
  mode._testRange = function smokeAwareLightPerceptionRange(visionSource, detectionMode, target, test) {
    if (!original.call(this, visionSource, detectionMode, target, test)) return false;
    const index = getSmokeRegionIndex(canvas?.scene);
    if (!isTokenVisibilityTarget(target) || !hasRayAttenuationSmoke(index)) return true;
    const origin = {
      x: visionSource.data.x,
      y: visionSource.data.y,
      elevation: visionSource.data.elevation
    };
    const regionCandidates = getSmokeRegionsAlongRay(origin, test.point, {
      elevation: origin.elevation
    }).filter(requiresRayAttenuation);
    if (!regionCandidates.length) return true;
    const measurement = measureSmokePath(origin, test.point, {
      elevation: origin.elevation,
      chargeClearDistance: false,
      regionCandidates
    });
    if (!measurement.hasSmoke) return true;
    const fallbackRadius = visionSource.radius || visionSource.data.externalRadius || canvas.dimensions?.maxR || 0;
    const maximumDistance = getBasicSightRadius(visionSource, fallbackRadius);
    if (maximumDistance === null) return true;
    return maximumDistance === Infinity
      ? measurement.cost !== Infinity
      : measurement.cost <= maximumDistance + EPSILON;
  };
  Object.defineProperty(mode, "_falloutMawSmokeRangePatched", { value: true });
}

function hasRayAttenuationSmoke(index) {
  if (!index?.hasVisionSmoke) return false;
  if (index.hasPartialVisionSmoke) return true;
  return index.entries.some(requiresRayAttenuation);
}

function requiresRayAttenuation(entry) {
  return entry.smoke.density < 1 - EPSILON
    || !smokeBoundaryBehaviorUuids.has(entry.behavior.uuid);
}

/**
 * The rendered LOS contains opaque smoke. Special wall-aware senses which use
 * Foundry's default LOS method must keep their original wall-only semantics.
 * A direct native collision test is substantially cheaper than constructing a
 * second full LOS polygon for every vision source and is cached per test point.
 */
function patchSpecialSenseSmokeLos() {
  const DetectionMode = globalThis.foundry?.canvas?.perception?.DetectionMode;
  const defaultTestLos = DetectionMode?.prototype?._testLOS;
  if (typeof defaultTestLos !== "function" || typeof DetectionMode._testCollision !== "function") return;
  for (const [id, mode] of Object.entries(CONFIG.Canvas?.detectionModes ?? {})) {
    if (id === "basicSight" || id === "lightPerception" || !mode?.walls) continue;
    if (mode._falloutMawSmokeLosBypassPatched || mode._testLOS !== defaultTestLos) continue;
    mode._testLOS = function smokeBypassingSpecialSenseLos(visionSource, detectionMode, target, test) {
      const index = getSmokeRegionIndex(canvas?.scene);
      if (!index?.hasOpaqueVisionSmoke || !visionSource?.los?.config) {
        return defaultTestLos.call(this, visionSource, detectionMode, target, test);
      }
      const cached = readClearSmokeLosCache(test, this, visionSource);
      if (cached !== undefined) return cached;
      const config = {
        ...visionSource.los.config,
        _falloutMawIncludeSmokeEdges: false
      };
      if (!this.angle && visionSource.data.angle < 360) config.angle = 360;
      const hasLos = !DetectionMode._testCollision(visionSource, test, config);
      writeClearSmokeLosCache(test, this, visionSource, hasLos);
      return hasLos;
    };
    Object.defineProperty(mode, "_falloutMawSmokeLosBypassPatched", { value: true });
  }
}

function readClearSmokeLosCache(test, mode, visionSource) {
  return clearSmokeLosCache.get(test)?.get(mode)?.get(visionSource);
}

function writeClearSmokeLosCache(test, mode, visionSource, value) {
  if (!test || typeof test !== "object" || !visionSource || typeof visionSource !== "object") return;
  let byMode = clearSmokeLosCache.get(test);
  if (!byMode) clearSmokeLosCache.set(test, byMode = new Map());
  let bySource = byMode.get(mode);
  if (!bySource) byMode.set(mode, bySource = new WeakMap());
  bySource.set(visionSource, value);
}

function isTokenVisibilityTarget(target) {
  const document = target?.document;
  return document?.documentName === "Token"
    || document?.constructor?.documentName === "Token"
    || Boolean(document?.actor && target?.actor);
}

function getSmokeRegionState(behavior, now = Number(globalThis.game?.time?.worldTime) || 0) {
  const system = behavior.system ?? {};
  const rows = system.regionSpecialProperties;
  if (!Array.isArray(rows) && !rows) return null;
  const smoke = getSmokeRuntimeProperties(rows);
  if (!smoke) return null;
  const state = behavior.getFlag?.(SYSTEM_ID, PERIODIC_DAMAGE_FLAG) ?? {};
  const delay = Math.max(0, Number(system.delaySeconds) || 0);
  const activateAt = toOptionalFiniteNumber(state.activateAt) ?? now + delay;
  const duration = Math.max(0, Number(system.durationSeconds) || 0);
  const expiresAt = toOptionalFiniteNumber(state.expiresAt) ?? (duration > 0 ? activateAt + duration : null);
  const active = now >= activateAt && (!Number.isFinite(expiresAt) || now < expiresAt);
  const nextTransitionAt = now < activateAt
    ? activateAt
    : (Number.isFinite(expiresAt) && now < expiresAt ? expiresAt : null);
  return { active, nextTransitionAt, smoke };
}

function getRegionRayIntervals(entry, from, to, elevation) {
  const { region, geometry } = entry;
  if (from.elevation === to.elevation
    && isRegionOnElevation(region, from.elevation)
    && geometry?.polygonTree?.testPoint
    && geometry.segments.length) {
    return getPolygonTreeRayIntervals(geometry, from, to);
  }
  if (typeof region.segmentizeMovementPath !== "function") {
    const midpoint = {
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
      elevation: elevation ?? from.elevation ?? 0
    };
    return region.testPoint?.(midpoint) ? [[0, 1]] : [];
  }
  const waypoints = [
    { x: from.x, y: from.y, elevation: from.elevation ?? elevation ?? 0 },
    { x: to.x, y: to.y, elevation: to.elevation ?? elevation ?? 0 }
  ];
  const segments = region.segmentizeMovementPath(waypoints, [{ x: 0, y: 0 }]);
  return segments
    .map(segment => [projectT(segment.from, from, to), projectT(segment.to, from, to)])
    .map(([a, b]) => [Math.max(0, Math.min(1, Math.min(a, b))), Math.max(0, Math.min(1, Math.max(a, b)))])
    .filter(([a, b]) => b - a > EPSILON);
}

function getPolygonTreeRayIntervals(geometry, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const minX = Math.min(from.x, to.x);
  const maxX = Math.max(from.x, to.x);
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);
  const intersections = [0, 1];
  for (const segment of geometry.segments) {
    if (segment.maxX < minX || segment.minX > maxX || segment.maxY < minY || segment.minY > maxY) continue;
    const edgeDx = segment.b.x - segment.a.x;
    const edgeDy = segment.b.y - segment.a.y;
    const denominator = (dx * edgeDy) - (dy * edgeDx);
    if (Math.abs(denominator) <= EPSILON) continue;
    const offsetX = segment.a.x - from.x;
    const offsetY = segment.a.y - from.y;
    const t = ((offsetX * edgeDy) - (offsetY * edgeDx)) / denominator;
    const u = ((offsetX * dy) - (offsetY * dx)) / denominator;
    if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) continue;
    intersections.push(Math.max(0, Math.min(1, t)));
  }
  intersections.sort((left, right) => left - right);
  const unique = [];
  for (const t of intersections) {
    if (!unique.length || t - unique.at(-1) > EPSILON) unique.push(t);
  }
  const intervals = [];
  for (let i = 1; i < unique.length; i++) {
    const start = unique[i - 1];
    const end = unique[i];
    if (end - start <= EPSILON) continue;
    const midpoint = (start + end) / 2;
    if (!geometry.polygonTree.testPoint({
      x: from.x + (dx * midpoint),
      y: from.y + (dy * midpoint)
    })) continue;
    const previous = intervals.at(-1);
    if (previous && start - previous[1] <= EPSILON) previous[1] = end;
    else intervals.push([start, end]);
  }
  return intervals;
}

function getSmokeRegionGeometry(region) {
  const polygonTree = region.object?.animationState?.polygonTree
    ?? region.polygonTree
    ?? region.document?.polygonTree
    ?? null;
  const polygons = polygonTree?.polygons ?? getRegionPolygons(region);
  const segments = [];
  const signature = [];
  for (const polygon of polygons ?? []) {
    const points = polygon?.points ?? [];
    if (points.length < 6) continue;
    let a = { x: Number(points.at(-2)) || 0, y: Number(points.at(-1)) || 0 };
    for (let i = 0; i + 1 < points.length; i += 2) {
      const b = { x: Number(points[i]) || 0, y: Number(points[i + 1]) || 0 };
      if (a.x !== b.x || a.y !== b.y) {
        segments.push({
          a,
          b,
          minX: Math.min(a.x, b.x),
          maxX: Math.max(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxY: Math.max(a.y, b.y)
        });
        signature.push(a.x, a.y, b.x, b.y);
      }
      a = b;
    }
  }
  return { polygonTree, polygons, segments, signature: signature.join(",") };
}

function getRegionPolygons(region) {
  return region.object?.animationState?.polygons
    ?? region.polygons
    ?? region.document?.polygons
    ?? [];
}

function projectT(point, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (!lengthSquared) return 0;
  return (((point.x - from.x) * dx) + ((point.y - from.y) * dy)) / lengthSquared;
}

function getRegionBounds(region) {
  const bounds = region.object?.bounds ?? region.bounds;
  if (!bounds) return null;
  return {
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Math.max(0, Number(bounds.width) || 0),
    height: Math.max(0, Number(bounds.height) || 0)
  };
}

function getSegmentBounds(from, to) {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

function boundsIntersect(left, right) {
  return left.x <= right.x + right.width
    && right.x <= left.x + left.width
    && left.y <= right.y + right.height
    && right.y <= left.y + left.height;
}

function getBoundsCells(bounds) {
  if (!bounds) return [];
  const minX = Math.floor(bounds.x / CELL_SIZE);
  const maxX = Math.floor((bounds.x + bounds.width) / CELL_SIZE);
  const minY = Math.floor(bounds.y / CELL_SIZE);
  const maxY = Math.floor((bounds.y + bounds.height) / CELL_SIZE);
  const keys = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) keys.push(`${x}:${y}`);
  }
  return keys;
}

function isRegionOnElevation(region, elevation) {
  if (elevation === null || elevation === undefined) return true;
  const bottom = region.elevation?.bottom === null || region.elevation?.bottom === undefined
    ? null
    : Number(region.elevation.bottom);
  const top = region.elevation?.top === null || region.elevation?.top === undefined
    ? null
    : Number(region.elevation.top);
  if (Number.isFinite(bottom) && elevation < bottom) return false;
  if (Number.isFinite(top) && elevation >= top && region.elevation?.topInclusive !== true) return false;
  return true;
}

function normalizePoint(point) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    elevation: Number(point?.elevation) || 0
  };
}

function scheduleSmokeRefresh({ forceRendering = false, forceVision = false } = {}) {
  scheduleSmokeRefresh.forceRendering ||= forceRendering;
  scheduleSmokeRefresh.forceVision ||= forceVision;
  if (scheduleSmokeRefresh.pending) return;
  scheduleSmokeRefresh.pending = true;
  setTimeout(() => {
    scheduleSmokeRefresh.pending = false;
    const rendering = scheduleSmokeRefresh.forceRendering;
    const vision = scheduleSmokeRefresh.forceVision;
    scheduleSmokeRefresh.forceRendering = false;
    scheduleSmokeRefresh.forceVision = false;
    syncSmokeDarknessMeshes({ forceRendering: rendering, forceVision: vision });
  }, 0);
}

export function syncSmokeDarknessMeshes({ forceRendering = false, forceVision = false } = {}) {
  if (!canvas?.ready || !canvas.scene) return;
  const index = getSmokeRegionIndex(canvas.scene);
  const boundaryEdgesChanged = syncSmokeBoundaryEdges(index);
  const shaders = foundry.canvas?.rendering?.shaders;
  const darknessCollection = canvas.effects?.illumination?.darknessLevelMeshes;
  const illuminationMeshes = canvas.visibility?.vision?.light?.global?.meshes;
  if (!shaders?.AdjustDarknessLevelRegionShader
    || !shaders?.IlluminationDarknessLevelRegionShader
    || !darknessCollection
    || !illuminationMeshes) {
    if (boundaryEdgesChanged) canvas.perception.update({ refreshVision: true });
    return;
  }
  const desired = new Map();
  for (const entry of index?.entries ?? []) desired.set(entry.behavior.uuid, entry);
  const signature = [...desired].map(([uuid, entry]) => `${uuid}:${entry.smoke.thickness}:${entry.smoke.density}`).sort().join("|");
  const smokeStateChanged = smokeSignatureByScene.get(canvas.scene) !== signature;
  smokeSignatureByScene.set(canvas.scene, signature);
  let renderingChanged = forceRendering;
  for (const [uuid, meshes] of smokeMeshes) {
    if (desired.has(uuid)) continue;
    destroySmokeMeshPair(uuid, meshes);
    smokeMeshes.delete(uuid);
    renderingChanged = true;
  }
  for (const [uuid, entry] of desired) {
    const object = entry.region.object;
    if (!object) continue;
    const existing = smokeMeshes.get(uuid);
    if (existing) {
      const meshChanged = updateSmokeMeshPair(existing, entry.smoke.thickness);
      renderingChanged ||= meshChanged;
      continue;
    }
    const darknessMesh = new foundry.canvas.placeables.regions.RegionMesh(object, shaders.AdjustDarknessLevelRegionShader);
    const illuminationMesh = new foundry.canvas.placeables.regions.RegionMesh(object, shaders.IlluminationDarknessLevelRegionShader);
    if (canvas.performance?.mode > CONST.CANVAS_PERFORMANCE_MODES.LOW) {
      darknessMesh._blurFilter = canvas.createBlurFilter(8, 2);
      darknessMesh.filters = [darknessMesh._blurFilter];
    }
    darknessMesh.name = illuminationMesh.name = uuid;
    darknessMesh.shader.mode = illuminationMesh.shader.mode = 0;
    darknessMesh.shader.modifier = illuminationMesh.shader.modifier = entry.smoke.thickness;
    darknessCollection.addChild(darknessMesh);
    illuminationMeshes.addChild(illuminationMesh);
    smokeMeshes.set(uuid, { darknessMesh, illuminationMesh, thickness: entry.smoke.thickness });
    renderingChanged = true;
  }
  if (renderingChanged) {
    canvas.effects.illumination.invalidateDarknessLevelContainer(true);
  }
  const refreshVision = forceVision || boundaryEdgesChanged || smokeStateChanged
    || (renderingChanged && canvas.environment?.globalLightSource?.active);
  if (renderingChanged || refreshVision) {
    canvas.perception.update({ refreshLighting: renderingChanged, refreshVision });
  }
}

function syncSmokeBoundaryEdges(index) {
  const scene = canvas?.scene;
  if (!scene || !canvas?.edges || !index) return false;
  const opaqueEntries = index.entries.filter(entry => entry.smoke.density >= 1 - EPSILON);
  const signature = opaqueEntries.map(entry => {
    const elevation = entry.region.elevation ?? {};
    return `${entry.behavior.uuid}:${elevation.bottom ?? ""}:${elevation.top ?? ""}`
      + `:${elevation.topInclusive === true ? 1 : 0}:${entry.geometry?.signature ?? ""}`;
  }).sort().join("|");
  if (smokeBoundaryEdgeScene === scene && smokeBoundaryEdgeSignature === signature) {
    return false;
  }
  let changed = destroySmokeBoundaryEdges();
  smokeBoundaryEdgeScene = scene;
  smokeBoundaryEdgeSignature = signature;
  const EdgeClass = foundry.canvas?.geometry?.edges?.Edge;
  if (!EdgeClass) return changed;
  for (const entry of opaqueEntries) {
    let edgeNumber = 0;
    for (const segment of entry.geometry?.segments ?? []) {
      const id = `${SMOKE_EDGE_TYPE}.${entry.behavior.uuid}.${edgeNumber++}`;
      const edge = new EdgeClass(segment.a, segment.b, {
        id,
        type: SMOKE_EDGE_TYPE,
        sight: CONST.EDGE_SENSE_TYPES.NORMAL
      });
      edge._falloutMawSmokeRegion = entry.region;
      canvas.edges.set(id, edge);
      smokeBoundaryEdgeIds.add(id);
      changed = true;
    }
    if (edgeNumber) smokeBoundaryBehaviorUuids.add(entry.behavior.uuid);
  }
  return changed;
}

function destroySmokeBoundaryEdges() {
  const edges = globalThis.canvas?.edges;
  let changed = false;
  if (edges) {
    for (const id of smokeBoundaryEdgeIds) changed = edges.delete(id) || changed;
  }
  smokeBoundaryEdgeIds.clear();
  smokeBoundaryBehaviorUuids.clear();
  smokeBoundaryEdgeScene = null;
  smokeBoundaryEdgeSignature = "";
  return changed;
}

function updateSmokeMeshPair(meshes, thickness) {
  if (meshes.thickness === thickness) return false;
  meshes.darknessMesh.shader.modifier = thickness;
  meshes.illuminationMesh.shader.modifier = thickness;
  meshes.thickness = thickness;
  return true;
}

function destroySmokeMeshPair(_uuid, meshes) {
  if (meshes.darknessMesh?._blurFilter) canvas.blurFilters?.delete(meshes.darknessMesh._blurFilter);
  meshes.darknessMesh?.destroy?.();
  meshes.illuminationMesh?.destroy?.();
}

function destroySmokeDarknessMeshes() {
  for (const [uuid, meshes] of smokeMeshes) destroySmokeMeshPair(uuid, meshes);
  smokeMeshes.clear();
}
