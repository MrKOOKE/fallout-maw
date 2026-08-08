import { SYSTEM_ID } from "../constants.mjs";
import { getSmokeRuntimeProperties } from "../utils/region-special-properties.mjs";

const PERIODIC_DAMAGE_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const PERIODIC_DAMAGE_FLAG = "periodicDamage";
const CELL_SIZE = 512;
const STAR_SAMPLES = 96;
const BINARY_STEPS = 12;
const EPSILON = 1e-6;

let smokeIndexByScene = new WeakMap();
let detectionModePatched = false;
const smokeMeshes = new Map();

export function registerSmokeVisionHooks() {
  patchBasicSightRange();
  registerVisionSourceClass();
  for (const hook of ["createRegion", "updateRegion", "deleteRegion", "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior"]) {
    Hooks.on(hook, document => {
      const scene = document?.documentName === "Scene"
        ? document
        : document?.parent?.documentName === "Scene"
          ? document.parent
          : canvas?.scene;
      invalidateSmokeRegionIndex(scene);
      scheduleSmokeRefresh();
    });
  }
  Hooks.on("canvasReady", () => {
    patchBasicSightRange();
    registerVisionSourceClass();
    invalidateSmokeRegionIndex(canvas?.scene);
    syncSmokeDarknessMeshes();
    canvas?.perception?.update?.({ refreshVision: true, refreshLighting: true });
  });
  Hooks.on("updateWorldTime", () => {
    invalidateSmokeRegionIndex(canvas?.scene);
    scheduleSmokeRefresh();
  });
  Hooks.on("canvasTearDown", () => {
    destroySmokeDarknessMeshes();
    smokeIndexByScene = new WeakMap();
  });
}

export function invalidateSmokeRegionIndex(scene = canvas?.scene) {
  if (scene) smokeIndexByScene.delete(scene);
}

export function getSmokeRegionIndex(scene = canvas?.scene) {
  if (!scene) return null;
  const cached = smokeIndexByScene.get(scene);
  if (cached) return cached;
  const entries = [];
  const buckets = new Map();
  for (const region of scene.regions?.contents ?? []) {
    if (!region || region.hidden) continue;
    for (const behavior of region.behaviors?.contents ?? []) {
      if (behavior.type !== PERIODIC_DAMAGE_BEHAVIOR_TYPE || behavior.disabled || behavior.visible === false) continue;
      const smoke = getActiveSmokeProperties(region, behavior);
      if (!smoke) continue;
      const entry = { region, behavior, smoke, bounds: getRegionBounds(region) };
      const index = entries.push(entry) - 1;
      for (const key of getBoundsCells(entry.bounds)) {
        const bucket = buckets.get(key) ?? [];
        bucket.push(index);
        buckets.set(key, bucket);
      }
    }
  }
  const index = { entries, buckets };
  smokeIndexByScene.set(scene, index);
  return index;
}

export function getSmokeRegionsAlongRay(from, to, { scene = canvas?.scene, elevation = null } = {}) {
  const index = getSmokeRegionIndex(scene);
  if (!index?.entries.length) return [];
  const bounds = getSegmentBounds(from, to);
  const candidates = new Set();
  for (const key of getBoundsCells(bounds)) {
    for (const candidate of index.buckets.get(key) ?? []) candidates.add(candidate);
  }
  for (const [candidate, entry] of index.entries.entries()) {
    if (!entry.bounds) candidates.add(candidate);
  }
  return [...candidates]
    .map(candidate => index.entries[candidate])
    .filter(entry => entry && (!entry.bounds || boundsIntersect(entry.bounds, bounds)))
    .filter(entry => isRegionOnElevation(entry.region, elevation));
}

export function calculateSmokePathCost(from, to, { scene = canvas?.scene, elevation = null } = {}) {
  const start = normalizePoint(from);
  const end = normalizePoint(to);
  const totalLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (!totalLength) return 0;
  const queryElevation = elevation === null || elevation === undefined || start.elevation !== end.elevation
    ? null
    : elevation;
  const regions = getSmokeRegionsAlongRay(start, end, { scene, elevation: queryElevation });
  if (!regions.length) return totalLength;

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
  let cost = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b - a <= EPSILON) continue;
    const midpoint = (a + b) / 2;
    const segmentLength = totalLength * (b - a);
    let retained = 1;
    for (const entry of regions) {
      if (!intervals.get(entry)?.some(([startT, endT]) => midpoint >= startT - EPSILON && midpoint <= endT + EPSILON)) continue;
      retained *= Math.max(0, 1 - Number(entry.smoke.density) || 0);
    }
    if (retained <= EPSILON) return Infinity;
    cost += segmentLength / retained;
  }
  return cost;
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
      if (!radius || !canvas?.scene || !getSmokeRegionIndex(canvas.scene)?.entries.length) return basePolygon;
      const star = buildSmokeConstraint(this, radius);
      return star ? basePolygon.applyConstraint(star, { density: STAR_SAMPLES }) : basePolygon;
    }
  }
  Object.defineProperty(SmokeVisionSource, "__falloutMawSmokeVisionSource", { value: true });
  CONFIG.Canvas.visionSourceClass = SmokeVisionSource;
}

function buildSmokeConstraint(source, radius) {
  radius = Number.isFinite(radius) ? radius : (canvas.dimensions?.maxR ?? 0);
  if (!radius) return null;
  const { x, y, elevation } = source.data;
  const points = [];
  for (let i = 0; i < STAR_SAMPLES; i++) {
    const angle = (i / STAR_SAMPLES) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let low = 0;
    let high = radius;
    if (isSmokePathVisible({ x, y, elevation }, { x: x + (dx * high), y: y + (dy * high), elevation }, radius, { elevation })) {
      points.push(x + (dx * radius), y + (dy * radius));
      continue;
    }
    for (let step = 0; step < BINARY_STEPS; step++) {
      const middle = (low + high) / 2;
      const visible = isSmokePathVisible(
        { x, y, elevation },
        { x: x + (dx * middle), y: y + (dy * middle), elevation },
        radius,
        { elevation }
      );
      if (visible) low = middle;
      else high = middle;
    }
    points.push(x + (dx * low), y + (dy * low));
  }
  return new PIXI.Polygon(points);
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
    if (!getSmokeRegionIndex(canvas?.scene)?.entries.length) return true;
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

function getActiveSmokeProperties(region, behavior) {
  const system = behavior.system ?? {};
  const rows = system.regionSpecialProperties;
  if (!Array.isArray(rows) && !rows) return null;
  const smoke = getSmokeRuntimeProperties(rows);
  if (!smoke) return null;
  const state = behavior.getFlag?.(SYSTEM_ID, PERIODIC_DAMAGE_FLAG) ?? {};
  const now = Number(globalThis.game?.time?.worldTime) || 0;
  const delay = Math.max(0, Number(system.delaySeconds) || 0);
  const activateAt = Number.isFinite(Number(state.activateAt)) ? Number(state.activateAt) : now + delay;
  const duration = Math.max(0, Number(system.durationSeconds) || 0);
  const expiresAt = Number.isFinite(Number(state.expiresAt))
    ? Number(state.expiresAt)
    : (duration > 0 ? activateAt + duration : null);
  if (now < activateAt || (Number.isFinite(expiresAt) && now >= expiresAt)) return null;
  return smoke;
}

function getRegionRayIntervals(region, from, to, elevation) {
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

function scheduleSmokeRefresh() {
  if (scheduleSmokeRefresh.pending) return;
  scheduleSmokeRefresh.pending = true;
  setTimeout(() => {
    scheduleSmokeRefresh.pending = false;
    syncSmokeDarknessMeshes();
    canvas?.perception?.update?.({ refreshVision: true, refreshLighting: true });
  }, 0);
}

export function syncSmokeDarknessMeshes() {
  if (!canvas?.ready || !canvas.scene) return;
  const shaders = foundry.canvas?.rendering?.shaders;
  const darknessCollection = canvas.effects?.illumination?.darknessLevelMeshes;
  const illuminationMeshes = canvas.visibility?.vision?.light?.global?.meshes;
  if (!shaders?.AdjustDarknessLevelRegionShader || !shaders?.IlluminationDarknessLevelRegionShader || !darknessCollection || !illuminationMeshes) return;
  const desired = new Map();
  for (const entry of getSmokeRegionIndex(canvas.scene)?.entries ?? []) desired.set(entry.behavior.uuid, entry);
  let changed = false;
  for (const [uuid, meshes] of smokeMeshes) {
    if (desired.has(uuid)) continue;
    destroySmokeMeshPair(uuid, meshes);
    smokeMeshes.delete(uuid);
    changed = true;
  }
  for (const [uuid, entry] of desired) {
    const object = entry.region.object;
    if (!object) continue;
    const existing = smokeMeshes.get(uuid);
    if (existing) {
      changed = true;
      updateSmokeMeshPair(existing, entry.smoke.thickness);
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
    smokeMeshes.set(uuid, { darknessMesh, illuminationMesh });
    changed = true;
  }
  if (changed) {
    canvas.effects.illumination.invalidateDarknessLevelContainer(true);
    canvas.perception.update({ refreshLighting: true, refreshVision: canvas.environment?.globalLightSource?.active });
  }
}

function updateSmokeMeshPair(meshes, thickness) {
  meshes.darknessMesh.shader.modifier = thickness;
  meshes.illuminationMesh.shader.modifier = thickness;
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
