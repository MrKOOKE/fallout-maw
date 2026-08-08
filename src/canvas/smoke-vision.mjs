import { SYSTEM_ID } from "../constants.mjs";
import { getSmokeRuntimeProperties } from "../utils/region-special-properties.mjs";
import { toOptionalFiniteNumber } from "../utils/numbers.mjs";

const PERIODIC_DAMAGE_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const PERIODIC_DAMAGE_FLAG = "periodicDamage";
const CELL_SIZE = 512;
const STAR_SAMPLES = 48;
const EPSILON = 1e-6;

let smokeIndexByScene = new WeakMap();
let smokeRevisionByScene = new WeakMap();
let smokeIndexSignatureByScene = new WeakMap();
let smokeSignatureByScene = new WeakMap();
let sourceConstraintCache = new WeakMap();
let detectionModePatched = false;
const smokeMeshes = new Map();

export function registerSmokeVisionHooks() {
  patchBasicSightRange();
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
    patchBasicSightRange();
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
    destroySmokeDarknessMeshes();
    smokeIndexByScene = new WeakMap();
    smokeRevisionByScene = new WeakMap();
    smokeIndexSignatureByScene = new WeakMap();
    smokeSignatureByScene = new WeakMap();
    sourceConstraintCache = new WeakMap();
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
      const entry = { region, behavior, smoke: state.smoke, bounds: getRegionBounds(region) };
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
  regionCandidates = null
} = {}) {
  const profile = buildSmokePathProfile(from, to, { scene, elevation, regionCandidates });
  let cost = 0;
  for (const segment of profile.segments) {
    if (segment.retained <= EPSILON) {
      cost = Infinity;
      break;
    }
    cost += segment.length / segment.retained;
  }
  return {
    cost,
    hasSmoke: profile.hasSmoke,
    length: profile.length,
    segments: profile.segments,
    visibleDistance: calculateProfileVisibleDistance(profile, budget)
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
    const segments = getRegionRayIntervals(entry.region, start, end, elevation);
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
  if (budget === Infinity) return calculateSmokePathCost(from, to, options) !== Infinity;
  if (!Number.isFinite(budget) || budget < 0) return false;
  return calculateSmokePathCost(from, to, options) <= budget + EPSILON;
}

function registerVisionSourceClass() {
  const base = CONFIG.Canvas?.visionSourceClass;
  if (!base || base.__falloutMawSmokeVisionSource) return;
  class SmokeVisionSource extends base {
    _createRestrictedPolygon() {
      const basePolygon = super._createRestrictedPolygon();
      const radius = this.radius || this.data.externalRadius || 0;
      if (!radius || !canvas?.scene || !getSmokeRegionIndex(canvas.scene)?.hasVisionSmoke) return basePolygon;
      const budget = getBasicSightRadius(this, radius);
      if (budget === null) return basePolygon;
      const star = buildSmokeConstraint(this, radius, budget);
      return star ? basePolygon.applyConstraint(star, { density: STAR_SAMPLES }) : basePolygon;
    }
  }
  Object.defineProperty(SmokeVisionSource, "__falloutMawSmokeVisionSource", { value: true });
  CONFIG.Canvas.visionSourceClass = SmokeVisionSource;
}

function buildSmokeConstraint(source, radius, budget = radius) {
  radius = Number.isFinite(radius) ? radius : (canvas.dimensions?.maxR ?? 0);
  if (!radius) return null;
  const { x, y, elevation } = source.data;
  const revision = getSmokeRegionIndex(canvas.scene)?.revision ?? 0;
  const cached = sourceConstraintCache.get(source);
  if (cached
    && cached.revision === revision
    && cached.x === x
    && cached.y === y
    && cached.elevation === elevation
    && cached.radius === radius
    && cached.budget === budget) return cached.polygon;
  const regionCandidates = getSmokeRegionsInBounds({
    x: x - radius,
    y: y - radius,
    width: radius * 2,
    height: radius * 2
  }, { elevation });
  if (!regionCandidates.length) {
    sourceConstraintCache.set(source, { revision, x, y, elevation, radius, budget, polygon: null });
    return null;
  }
  const points = [];
  for (let i = 0; i < STAR_SAMPLES; i++) {
    const angle = (i / STAR_SAMPLES) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const distance = calculateSmokeVisibleDistance(
      { x, y, elevation },
      { x: x + (dx * radius), y: y + (dy * radius), elevation },
      budget,
      { elevation, regionCandidates }
    );
    points.push(x + (dx * distance), y + (dy * distance));
  }
  const polygon = new PIXI.Polygon(points);
  sourceConstraintCache.set(source, { revision, x, y, elevation, radius, budget, polygon });
  return polygon;
}

function calculateSmokeVisibleDistance(from, to, budget, options = {}) {
  const profile = buildSmokePathProfile(from, to, options);
  if (!profile.hasSmoke) return profile.length;
  return calculateProfileVisibleDistance(profile, budget);
}

function calculateProfileVisibleDistance(profile, budget) {
  if (budget === Infinity) {
    const opaque = profile.segments.find(segment => segment.retained <= EPSILON);
    return opaque ? opaque.start * profile.length : profile.length;
  }
  let remaining = Math.max(0, Number(budget) || 0);
  for (const segment of profile.segments) {
    if (segment.retained <= EPSILON) return segment.start * profile.length;
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

function patchBasicSightRange() {
  if (detectionModePatched) return;
  const mode = CONFIG.Canvas?.detectionModes?.basicSight;
  if (!mode || mode._falloutMawSmokeRangePatched) return;
  const original = mode._testRange;
  if (typeof original !== "function") return;
  mode._testRange = function smokeAwareRange(visionSource, detectionMode, target, test) {
    if (!original.call(this, visionSource, detectionMode, target, test)) return false;
    const maximumDistance = detectionMode.range === Infinity
      ? Infinity
      : visionSource.object.getLightRadius(detectionMode.range);
    if (!getSmokeRegionIndex(canvas?.scene)?.hasVisionSmoke) return true;
    return isSmokePathVisible(
      { x: visionSource.data.x, y: visionSource.data.y, elevation: visionSource.data.elevation },
      test.point,
      maximumDistance,
      { elevation: visionSource.data.elevation }
    );
  };
  Object.defineProperty(mode, "_falloutMawSmokeRangePatched", { value: true });
  detectionModePatched = true;
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

function getRegionRayIntervals(region, from, to, elevation) {
  const shapes = region.shapes ?? region.document?.shapes;
  if (shapes?.length === 1 && shapes[0]?.type === "circle") {
    return getCircleRayIntervals(shapes[0], from, to);
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

function getCircleRayIntervals(circle, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const fx = from.x - (Number(circle.x) || 0);
  const fy = from.y - (Number(circle.y) || 0);
  const radius = Math.max(0, Number(circle.radius) || 0);
  const a = (dx * dx) + (dy * dy);
  if (!a || !radius) return [];
  const b = 2 * ((fx * dx) + (fy * dy));
  const c = (fx * fx) + (fy * fy) - (radius * radius);
  const discriminant = (b * b) - (4 * a * c);
  if (discriminant <= EPSILON) return [];
  const root = Math.sqrt(discriminant);
  const start = Math.max(0, (-b - root) / (2 * a));
  const end = Math.min(1, (-b + root) / (2 * a));
  return end - start > EPSILON ? [[start, end]] : [];
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
  const shaders = foundry.canvas?.rendering?.shaders;
  const darknessCollection = canvas.effects?.illumination?.darknessLevelMeshes;
  const illuminationMeshes = canvas.visibility?.vision?.light?.global?.meshes;
  if (!shaders?.AdjustDarknessLevelRegionShader || !shaders?.IlluminationDarknessLevelRegionShader || !darknessCollection || !illuminationMeshes) return;
  const desired = new Map();
  const index = getSmokeRegionIndex(canvas.scene);
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
  const refreshVision = forceVision || smokeStateChanged
    || (renderingChanged && canvas.environment?.globalLightSource?.active);
  if (renderingChanged || refreshVision) {
    canvas.perception.update({ refreshLighting: renderingChanged, refreshVision });
  }
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
