import { SYSTEM_ID } from "../constants.mjs";
import { getSmokeRuntimeProperties } from "../utils/region-special-properties.mjs";
import { toOptionalFiniteNumber } from "../utils/numbers.mjs";
import {
  actorHasSmokePerceptionChange,
  effectHasSmokePerceptionChange,
  getActorSmokeDensityAdjustment,
  getActorSmokePerceptionPercent,
  invalidateActorSmokePerception,
  SMOKE_PERCEPTION_PERCENT_EFFECT_KEY
} from "./smoke-perception.mjs";

const PERIODIC_DAMAGE_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const PERIODIC_DAMAGE_FLAG = "periodicDamage";
const CELL_SIZE = 512;
const FALLBACK_CONSTRAINT_DENSITY = 32;
const CONSTRAINT_TRANSITION_ITERATIONS = 18;
const CONSTRAINT_TRANSITION_PIXEL_TOLERANCE = 0.05;
const SOURCE_CONSTRAINT_CACHE_LIMIT = 4;
const BRIGHT_LIGHT_DENSITY_MULTIPLIER = 1;
const DIM_LIGHT_DENSITY_MULTIPLIER = 2;
const EPSILON = 1e-6;

let smokeIndexByScene = new WeakMap();
let smokeRevisionByScene = new WeakMap();
let smokeIndexSignatureByScene = new WeakMap();
let smokeSignatureByScene = new WeakMap();
let sourceConstraintCache = new WeakMap();
let clearSmokeLosCache = new WeakMap();
let smokeLightRanges = new WeakMap();
let dispersedSmokeGeometryCache = new WeakMap();
let smokeLightCandidateSignatureCache = new WeakMap();
let smokeLightRevision = 0;
const smokeMeshes = new Map();
let lightDependentVisionRefreshScheduled = false;
const pendingSmokePerceptionEffectUpdates = new WeakSet();

export function registerSmokeVisionHooks() {
  patchSmokeDetectionRanges();
  registerVisionSourceClass();
  registerLightSourceClass();
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
  Hooks.on("createToken", document => refreshVisionForLocalLightDocument(document));
  Hooks.on("deleteToken", document => refreshVisionForLocalLightDocument(document));
  Hooks.on("updateToken", (document, changed) => {
    if (hasAnyChangedPath(changed, ["x", "y", "elevation", "rotation", "width", "height", "hidden", "light"])) {
      refreshVisionForLocalLightDocument(document, { force: hasAnyChangedPath(changed, ["light"]) });
    }
  });
  Hooks.on("createAmbientLight", document => refreshVisionForLocalLightDocument(document));
  Hooks.on("deleteAmbientLight", document => refreshVisionForLocalLightDocument(document));
  Hooks.on("updateAmbientLight", (document, changed) => {
    if (hasAnyChangedPath(changed, ["x", "y", "elevation", "rotation", "hidden", "walls", "vision", "config", "levels"])) {
      refreshVisionForLocalLightDocument(document, { force: hasAnyChangedPath(changed, ["config"]) });
    }
  });
  Hooks.on("createActiveEffect", effect => refreshVisionForSmokePerceptionEffect(effect));
  Hooks.on("deleteActiveEffect", effect => refreshVisionForSmokePerceptionEffect(effect));
  Hooks.on("preUpdateActiveEffect", (effect, changed) => {
    if (effectHasSmokePerceptionChange(effect) || changedContainsSmokePerceptionChange(changed)) {
      pendingSmokePerceptionEffectUpdates.add(effect);
    }
  });
  Hooks.on("updateActiveEffect", effect => {
    if (!pendingSmokePerceptionEffectUpdates.delete(effect)) return;
    refreshVisionForSmokePerceptionEffect(effect, { allowMissingChange: true });
  });
  Hooks.on("updateActor", actor => {
    if (actorHasSmokePerceptionChange(actor)) refreshVisionForSmokePerceptionActor(actor);
  });
  Hooks.on("updateItem", item => {
    const effect = Array.from(item?.effects ?? []).find(effectHasSmokePerceptionChange);
    if (effect) {
      refreshVisionForSmokePerceptionEffect(effect, { allowMissingChange: true });
      return;
    }
    const actor = item?.parent?.documentName === "Actor" ? item.parent : null;
    if (actorHasSmokePerceptionChange(actor)) refreshVisionForSmokePerceptionActor(actor);
  });
  Hooks.on("canvasReady", () => {
    patchSmokeDetectionRanges();
    registerVisionSourceClass();
    registerLightSourceClass();
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
    clearSmokeLosCache = new WeakMap();
    smokeLightRanges = new WeakMap();
    dispersedSmokeGeometryCache = new WeakMap();
    smokeLightCandidateSignatureCache = new WeakMap();
    smokeLightRevision = 0;
    invalidateActorSmokePerception();
    lightDependentVisionRefreshScheduled = false;
  });
}

function refreshVisionForSmokePerceptionEffect(effect, { allowMissingChange = false } = {}) {
  if (!allowMissingChange && !effectHasSmokePerceptionChange(effect)) return;
  refreshVisionForSmokePerceptionActor(getActiveEffectActor(effect));
}

function refreshVisionForSmokePerceptionActor(actor) {
  invalidateActorSmokePerception(actor);
  if (!getSmokeRegionIndex(canvas?.scene)?.hasVisionSmoke) return;
  if (!actor || !(canvas?.tokens?.placeables ?? []).some(token => token?.actor === actor)) return;
  Hooks.callAll?.(`${SYSTEM_ID}.smokePerceptionChanged`, actor);
  canvas?.perception?.update?.({ initializeVision: true, refreshVision: true });
}

function changedContainsSmokePerceptionChange(changed) {
  if (!changed || typeof changed !== "object") return false;
  const changes = changed?.system?.changes ?? changed?.changes;
  if ((Array.isArray(changes) ? changes : Object.values(changes ?? {}))
    .some(change => String(change?.key ?? "").trim() === SMOKE_PERCEPTION_PERCENT_EFFECT_KEY)) return true;
  return JSON.stringify(changed).includes(SMOKE_PERCEPTION_PERCENT_EFFECT_KEY);
}

function getActiveEffectActor(effect) {
  const parent = effect?.parent;
  if (parent?.documentName === "Actor") return parent;
  if (parent?.documentName === "Item" && parent.parent?.documentName === "Actor") return parent.parent;
  return null;
}

function refreshVisionForLocalLightDocument(document, { force = false } = {}) {
  if (!getSmokeRegionIndex(canvas?.scene)?.hasVisionSmoke || (!force && !documentUsesLocalLight(document))) return;
  if (lightDependentVisionRefreshScheduled) return;
  lightDependentVisionRefreshScheduled = true;
  queueMicrotask(() => {
    lightDependentVisionRefreshScheduled = false;
    canvas?.perception?.update?.({ initializeVision: true });
  });
}

function documentUsesLocalLight(document) {
  const light = document?.light ?? document?.config;
  if (!light || light.negative === true) return false;
  return Math.max(Math.abs(Number(light.bright) || 0), Math.abs(Number(light.dim) || 0)) > 0;
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
  densityMultiplier = 1,
  densityAdjustment = 0,
  chargeClearDistance = true,
  useLightDispersion = false,
  lightCandidates = null
} = {}) {
  const profile = buildSmokePathProfile(from, to, {
    scene,
    elevation,
    regionCandidates,
    densityMultiplier,
    densityAdjustment,
    useLightDispersion,
    lightCandidates
  });
  const cost = calculateProfileCost(profile, { chargeClearDistance });
  return {
    cost,
    hasSmoke: profile.hasSmoke,
    length: profile.length,
    segments: profile.segments,
    visibleDistance: calculateProfileVisibleDistance(profile, budget, { chargeClearDistance })
  };
}

function buildSmokePathProfile(from, to, {
  scene = canvas?.scene,
  elevation = null,
  regionCandidates = null,
  densityMultiplier = 1,
  densityAdjustment = 0,
  useLightDispersion = false,
  lightCandidates = null
} = {}) {
  return buildSmokePathProfiles(from, to, {
    scene,
    elevation,
    regionCandidates,
    densityMultipliers: [densityMultiplier],
    densityAdjustment,
    useLightDispersion,
    lightCandidates
  })[0];
}

function buildSmokePathProfiles(from, to, {
  scene = canvas?.scene,
  elevation = null,
  regionCandidates = null,
  densityMultipliers = [1],
  densityAdjustment = 0,
  useLightDispersion = false,
  lightCandidates = null
} = {}) {
  const start = normalizePoint(from);
  const end = normalizePoint(to);
  const totalLength = Math.hypot(end.x - start.x, end.y - start.y);
  const multipliers = densityMultipliers.map(value => Math.max(0, Number(value) || 0));
  const rawDensityAdjustment = Number(densityAdjustment);
  const perceivedDensityAdjustment = Number.isFinite(rawDensityAdjustment) ? rawDensityAdjustment : 0;
  if (!totalLength) return multipliers.map(() => ({ hasSmoke: false, length: 0, segments: [] }));
  const queryElevation = elevation === null || elevation === undefined || start.elevation !== end.elevation
    ? null
    : elevation;
  const segmentBounds = getSegmentBounds(start, end);
  const regions = (regionCandidates ?? getSmokeRegionsAlongRay(start, end, { scene, elevation: queryElevation }))
    .filter(entry => !entry.bounds || boundsIntersect(entry.bounds, segmentBounds))
    .filter(entry => isRegionOnElevation(entry.region, queryElevation));
  if (!regions.length) return multipliers.map(() => ({
    hasSmoke: false,
    length: totalLength,
    segments: [{ start: 0, end: 1, length: totalLength, retained: 1 }]
  }));

  const dispersionCandidates = useLightDispersion
    ? (lightCandidates ?? getSmokeDispersionCandidates(segmentBounds, { elevation: queryElevation }))
    : [];
  const hasDispersionCandidates = useLightDispersion && dispersionCandidates.length > 0;
  const intervals = new Map();
  const breakpoints = new Set([0, 1]);
  let requiresRayDispersion = false;
  for (const entry of regions) {
    const dispersedGeometry = hasDispersionCandidates
      ? getDispersedSmokeGeometry(entry, dispersionCandidates)
      : null;
    if (hasDispersionCandidates && !dispersedGeometry) requiresRayDispersion = true;
    const segments = getRegionRayIntervals(entry, start, end, elevation, dispersedGeometry ?? undefined);
    intervals.set(entry, segments);
    for (const [a, b] of segments) {
      breakpoints.add(a);
      breakpoints.add(b);
    }
  }
  if (requiresRayDispersion) {
    for (const candidate of dispersionCandidates) {
      addPolygonRayBreakpoints(breakpoints, candidate.source.shape, start, end);
    }
  }

  const sorted = [...breakpoints].sort((left, right) => left - right);
  const segmentsByMultiplier = multipliers.map(() => []);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b - a <= EPSILON) continue;
    const midpoint = (a + b) / 2;
    const densities = [];
    for (const entry of regions) {
      if (!intervals.get(entry)?.some(([startT, endT]) => midpoint >= startT - EPSILON && midpoint <= endT + EPSILON)) continue;
      densities.push(Math.max(0, Number(entry.smoke.density) || 0));
    }
    const dispersion = requiresRayDispersion && densities.length && dispersionCandidates.length
      ? getMaximumSmokeLightDispersion({
        x: start.x + ((end.x - start.x) * midpoint),
        y: start.y + ((end.y - start.y) * midpoint),
        elevation: start.elevation + ((end.elevation - start.elevation) * midpoint)
      }, dispersionCandidates)
      : 0;
    for (let multiplierIndex = 0; multiplierIndex < multipliers.length; multiplierIndex++) {
      const multiplier = multipliers[multiplierIndex];
      let retained = 1;
      for (const density of densities) {
        const perceivedDensity = Math.min(1, (density * multiplier) + perceivedDensityAdjustment);
        retained *= 1 - perceivedDensity;
      }
      retained = applySmokeLightDispersion(retained, dispersion);
      segmentsByMultiplier[multiplierIndex].push({
        start: a,
        end: b,
        length: totalLength * (b - a),
        retained,
        hasSmoke: densities.length > 0
      });
    }
  }
  return segmentsByMultiplier.map(segments => ({
    hasSmoke: segments.some(segment => segment.hasSmoke),
    length: totalLength,
    segments
  }));
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
    _createShapes() {
      super._createShapes();
      const index = getSmokeRegionIndex(canvas?.scene);
      if (!index?.hasVisionSmoke || !this.los) return;
      const lightRadius = Math.max(0, Number(this.lightRadius) || 0);
      const sightRadius = Math.max(0, Number(this.radius || this.data.externalRadius) || 0);
      const radius = Math.max(lightRadius, sightRadius);
      const budget = getBasicSightRadius(this, sightRadius) ?? sightRadius;
      const constraint = buildSmokeVisionConstraint(this, radius, budget);
      if (!constraint || radius <= 0) return;

      // Foundry builds one unrestricted LOS and derives both the light-perception and restricted-sight polygons
      // from it. Smoke must enter that same stage; independently constraining `light` and `shape` produces two
      // competing visibility silhouettes in the vision mask.
      this.los = this.los.applyConstraint(constraint);
      this.light = constrainVisionPolygon(this.los, this, lightRadius);
      this.shape = constrainVisionPolygon(this.los, this, sightRadius);
    }
  }
  Object.defineProperty(SmokeVisionSource, "__falloutMawSmokeVisionSource", { value: true });
  CONFIG.Canvas.visionSourceClass = SmokeVisionSource;
}

function constrainVisionPolygon(los, source, radius) {
  if (!los) return los;
  if (radius >= (Number(los.config?.radius) || 0)) return los;
  return los.applyConstraint(new PIXI.Circle(source.data.x, source.data.y, radius));
}

function registerLightSourceClass() {
  const base = CONFIG.Canvas?.lightSourceClass;
  if (!base || base.__falloutMawSmokeLightSource) return;
  class SmokeLightSource extends base {
    _createShapes() {
      super._createShapes();
      const index = getSmokeRegionIndex(canvas?.scene);
      if (!hasRayAttenuationSmoke(index)) {
        clearSmokeLightRanges(this);
        return;
      }
      const shape = createSmokeLightShape(this, this.shape);
      if (shape) this.shape = shape;
      else clearSmokeLightRanges(this);
    }

    _destroy(...args) {
      clearSmokeLightRanges(this);
      return super._destroy(...args);
    }
  }
  Object.defineProperty(SmokeLightSource, "__falloutMawSmokeLightSource", { value: true });
  CONFIG.Canvas.lightSourceClass = SmokeLightSource;
}

function createSmokeLightShape(source, basePolygon) {
  const radius = Math.max(0, Number(source.radius) || 0);
  if (!radius || !basePolygon) return null;
  const { x, y, elevation } = source.data;
  const regionCandidates = getSmokeRegionsInBounds({
    x: x - radius,
    y: y - radius,
    width: radius * 2,
    height: radius * 2
  }, { elevation }).filter(entry => (
    requiresRayAttenuation(entry)
    && (!entry.bounds || boundsIntersectCircle(entry.bounds, x, y, radius))
  ));
  if (!regionCandidates.length) return null;
  const brightRadius = Math.min(radius, Math.max(0, Math.abs(Number(source.data.bright) || 0)));
  const dimRadius = Math.min(radius, Math.max(0, Math.abs(Number(source.data.dim) || 0)));
  const constraints = buildSmokeLightConstraints(source, radius, brightRadius, dimRadius, regionCandidates);
  if (!constraints) return null;
  const shape = basePolygon.applyConstraint(constraints.combined);
  setSmokeLightRanges(source, {
    revision: getSmokeRegionRevision(canvas?.scene),
    bright: constraints.bright,
    dim: constraints.dim,
    shape,
    sourceState: getSmokeLightSourceState(source)
  });
  return shape;
}

function buildSmokeLightConstraints(source, radius, brightRadius, dimRadius, regionCandidates) {
  const { x, y, elevation } = source.data;
  const revision = getSmokeRegionRevision(canvas?.scene);
  const cachedEntries = sourceConstraintCache.get(source) ?? [];
  const cached = cachedEntries.find(entry => entry.kind === "light"
    && entry.revision === revision
    && entry.x === x
    && entry.y === y
    && entry.elevation === elevation
    && entry.radius === radius
    && entry.brightRadius === brightRadius
    && entry.dimRadius === dimRadius);
  if (cached) return cached.constraints;

  const origin = { x, y, elevation };
  const anchors = getSmokeConstraintAnchors(
    origin,
    radius,
    regionCandidates,
    [],
    [brightRadius, dimRadius]
  );
  const traceCache = new Map();
  const trace = rawAngle => {
    const angle = normalizeConstraintAngle(rawAngle);
    const cachedTrace = traceCache.get(angle);
    if (cachedTrace) return cachedTrace;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const destination = { x: x + (dx * radius), y: y + (dy * radius), elevation };
    const [brightProfile, dimProfile] = buildSmokePathProfiles(origin, destination, {
      elevation,
      regionCandidates,
      densityMultipliers: [BRIGHT_LIGHT_DENSITY_MULTIPLIER, DIM_LIGHT_DENSITY_MULTIPLIER]
    });
    const brightDistance = brightRadius > 0
      ? calculateProfileVisibleDistance(brightProfile, brightRadius)
      : 0;
    const dimDistance = dimRadius > 0
      ? calculateProfileVisibleDistance(dimProfile, dimRadius)
      : 0;
    const result = {
      angle,
      brightDistance,
      dimDistance,
      combinedDistance: Math.max(brightDistance, dimDistance)
    };
    traceCache.set(angle, result);
    return result;
  };
  const samples = sampleSmokeConstraintAnchors(anchors, radius, trace);
  const brightPoints = [];
  const dimPoints = [];
  const combinedPoints = [];
  for (const sample of samples) {
    appendSmokeConstraintAnchorPoints(
      brightPoints,
      origin,
      sample.anchor.angle,
      sample.left.brightDistance,
      sample.right.brightDistance
    );
    appendSmokeConstraintAnchorPoints(
      dimPoints,
      origin,
      sample.anchor.angle,
      sample.left.dimDistance,
      sample.right.dimDistance
    );
    appendSmokeConstraintAnchorPoints(
      combinedPoints,
      origin,
      sample.anchor.angle,
      sample.left.combinedDistance,
      sample.right.combinedDistance
    );
  }
  const constraints = {
    bright: new PIXI.Polygon(brightPoints),
    dim: new PIXI.Polygon(dimPoints),
    combined: new PIXI.Polygon(combinedPoints)
  };
  writeSourceConstraintCache(source, cachedEntries, {
    kind: "light",
    revision,
    x,
    y,
    elevation,
    radius,
    brightRadius,
    dimRadius,
    constraints
  });
  return constraints;
}

/**
 * Return the smoke-adjusted lighting band at a point already tested against
 * the native PointLightSource shape. Consumers such as stealth can therefore
 * use the same bright/dim propagation that Foundry renders.
 */
export function getSmokeLightBandAtPoint(source, point) {
  const ranges = smokeLightRanges.get(source);
  if (!ranges || ranges.revision !== getSmokeRegionRevision(canvas?.scene)) return null;
  if (ranges.bright?.contains?.(point.x, point.y)) return "bright";
  if (ranges.dim?.contains?.(point.x, point.y)) return "dim";
  return "none";
}

function setSmokeLightRanges(source, ranges) {
  const previous = smokeLightRanges.get(source);
  const changed = !previous
    || previous.sourceState !== ranges.sourceState
    || !areSmokeConstraintPolygonsEqual(previous.bright, ranges.bright)
    || !areSmokeConstraintPolygonsEqual(previous.dim, ranges.dim)
    || !areSmokeConstraintPolygonsEqual(previous.shape, ranges.shape);
  if (changed) {
    smokeLightRevision += 1;
    ranges.version = smokeLightRevision;
  } else ranges.version = previous.version;
  smokeLightRanges.set(source, ranges);
}

function clearSmokeLightRanges(source) {
  if (!smokeLightRanges.delete(source)) return;
  smokeLightRevision += 1;
}

function areSmokeConstraintPolygonsEqual(left, right) {
  if (left === right) return true;
  if (!areSmokePointSequencesEqual(left?.points, right?.points)) return false;
  return areSmokeSurfaceExposureEqual(left?.surfaceExposure, right?.surfaceExposure);
}

function areSmokePointSequencesEqual(leftPoints, rightPoints) {
  if (leftPoints === rightPoints) return true;
  if (!leftPoints || !rightPoints || leftPoints.length !== rightPoints.length) return false;
  for (let index = 0; index < leftPoints.length; index++) {
    if (Math.abs((Number(leftPoints[index]) || 0) - (Number(rightPoints[index]) || 0)) > EPSILON) return false;
  }
  return true;
}

/**
 * Foundry stores PointSourcePolygon#surfaceExposure as a PolygonTree, not another PointSourcePolygon. Comparing it by
 * recursively looking for `.points` makes every native no-op source initialization appear different. Compare the
 * flattened PolygonTree rings directly and stop at that level; PolygonTree cannot own another surface exposure.
 */
function areSmokeSurfaceExposureEqual(leftExposure, rightExposure) {
  if (leftExposure === rightExposure) return true;
  if (!leftExposure || !rightExposure) return false;
  if (leftExposure.points || rightExposure.points) {
    return areSmokePointSequencesEqual(leftExposure.points, rightExposure.points);
  }
  const leftPolygons = leftExposure.polygons;
  const rightPolygons = rightExposure.polygons;
  if (!leftPolygons || !rightPolygons || leftPolygons.length !== rightPolygons.length) return false;
  for (let index = 0; index < leftPolygons.length; index++) {
    if (!areSmokePointSequencesEqual(leftPolygons[index]?.points, rightPolygons[index]?.points)) return false;
  }
  return true;
}

function getSmokeLightSourceState(source) {
  const data = source?.data ?? {};
  return [
    Number(data.elevation) || 0,
    Number(source?.radius ?? data.radius) || 0,
    Number(data.bright) || 0,
    Number(data.dim) || 0,
    Number(data.priority) || 0,
    data.walls === false ? 0 : 1,
    source?.level?.id ?? data.level ?? ""
  ].join(":");
}

function getSmokeDispersionCandidates(bounds, { elevation = null } = {}) {
  const revision = getSmokeRegionRevision(canvas?.scene);
  const candidates = [];
  const sources = canvas?.effects?.lightSources;
  for (const source of sources?.values?.() ?? sources ?? []) {
    if (!source?.active || isGlobalLightSource(source)) continue;
    const ranges = smokeLightRanges.get(source);
    if (!ranges || ranges.revision !== revision) continue;
    const sourceBounds = source.shape?.bounds ?? source.shape?.getBounds?.();
    if (sourceBounds && !boundsIntersect(sourceBounds, bounds)) continue;
    const elevationState = getSmokeLightElevationState(source, elevation);
    if (!elevationState.reaches) continue;
    candidates.push({ source, ranges, planarDifference: elevationState.planarDifference });
  }
  const elevationSignature = elevation !== null
    && elevation !== undefined
    && Number.isFinite(Number(elevation))
    ? Number(elevation)
    : "*";
  const versions = candidates
    .map(candidate => Number(candidate.ranges?.version) || 0)
    .sort((left, right) => left - right)
    .join("|");
  smokeLightCandidateSignatureCache.set(candidates, `${elevationSignature};${versions}`);
  return candidates;
}

function getSmokeLightElevationState(source, elevation) {
  if (elevation === null || elevation === undefined) {
    return { reaches: true, planarDifference: false };
  }
  const targetElevation = Number(elevation);
  if (!Number.isFinite(targetElevation)) return { reaches: true, planarDifference: false };
  if ((Number(source?.data?.priority) || 0) > 0) return { reaches: true, planarDifference: true };
  const sourceElevation = Number(source?.data?.elevation) || 0;
  const radius = Math.max(0, Number(source?.radius ?? source?.data?.radius) || 0);
  const distancePixels = Math.max(0, Number(canvas?.dimensions?.distancePixels) || 0);
  const verticalDistance = Math.abs(targetElevation - sourceElevation) * distancePixels;
  if (distancePixels > 0 && verticalDistance > radius + EPSILON) {
    return { reaches: false, planarDifference: false };
  }
  return {
    reaches: true,
    planarDifference: Math.abs(targetElevation - sourceElevation) <= EPSILON
  };
}

function getSmokeLightCandidateSignature(candidates) {
  const cached = smokeLightCandidateSignatureCache.get(candidates);
  if (cached !== undefined) return cached;
  const signature = candidates
    .map(candidate => Number(candidate.ranges?.version) || 0)
    .sort((left, right) => left - right)
    .join("|");
  smokeLightCandidateSignatureCache.set(candidates, signature);
  return signature;
}

function getDispersedSmokeGeometry(entry, lightCandidates) {
  if (lightCandidates.some(candidate => candidate.planarDifference === false)) return null;
  const polygonTree = entry.geometry?.polygonTree;
  const difference = globalThis.ClipperLib?.ClipType?.ctDifference;
  if (!polygonTree?.intersectPolygon || difference === undefined) return null;
  const candidateSignature = getSmokeLightCandidateSignature(lightCandidates);
  const cachedEntries = dispersedSmokeGeometryCache.get(entry.behavior) ?? [];
  const smokeRevision = getSmokeRegionRevision(canvas?.scene);
  const cached = cachedEntries.find(value => (
    value.smokeRevision === smokeRevision && value.candidateSignature === candidateSignature
  ));
  if (cached) return cached.geometry;
  let dispersedTree = polygonTree;
  try {
    for (const candidate of lightCandidates) {
      const shape = candidate.source?.shape;
      if (!shape?.toClipperPoints) continue;
      const sourceBounds = shape.bounds ?? shape.getBounds?.();
      if (entry.bounds && sourceBounds && !boundsIntersect(entry.bounds, sourceBounds)) continue;
      dispersedTree = dispersedTree.intersectPolygon(shape, { clipType: difference });
      if (!dispersedTree.polygons.length) break;
    }
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Failed to build cached smoke/light Region difference`, error);
    writeDispersedSmokeGeometryCache(entry.behavior, cachedEntries, {
      smokeRevision,
      candidateSignature,
      geometry: null
    });
    return null;
  }
  const geometry = createSmokeGeometry(dispersedTree, dispersedTree.polygons);
  writeDispersedSmokeGeometryCache(entry.behavior, cachedEntries, {
    smokeRevision,
    candidateSignature,
    geometry
  });
  return geometry;
}

function writeDispersedSmokeGeometryCache(behavior, entries, value) {
  dispersedSmokeGeometryCache.set(behavior, [value, ...entries].slice(0, SOURCE_CONSTRAINT_CACHE_LIMIT));
}

function getMaximumSmokeLightDispersion(point, candidates) {
  for (const { source } of candidates) {
    if (!source.testPoint?.(point)) continue;
    return 1;
  }
  return 0;
}

function applySmokeLightDispersion(retained, dispersion) {
  if (Math.abs(retained - 1) <= EPSILON || dispersion <= EPSILON) return retained;
  if (dispersion >= 1 - EPSILON) return 1;
  if (retained <= EPSILON) return 0;
  const remainingPenalty = ((1 / retained) - 1) * (1 - dispersion);
  return 1 / (1 + remainingPenalty);
}

function addPolygonRayBreakpoints(breakpoints, polygon, from, to) {
  const points = polygon?.points;
  if (!Array.isArray(points) || points.length < 6) return;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  for (let index = 0, previous = points.length - 2; index < points.length; previous = index, index += 2) {
    const ax = points[previous];
    const ay = points[previous + 1];
    const edgeDx = points[index] - ax;
    const edgeDy = points[index + 1] - ay;
    const denominator = (dx * edgeDy) - (dy * edgeDx);
    if (Math.abs(denominator) <= EPSILON) continue;
    const offsetX = ax - from.x;
    const offsetY = ay - from.y;
    const t = ((offsetX * edgeDy) - (offsetY * edgeDx)) / denominator;
    const u = ((offsetX * dy) - (offsetY * dx)) / denominator;
    if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) continue;
    breakpoints.add(Math.max(0, Math.min(1, t)));
  }
}

function isGlobalLightSource(source) {
  return source?.constructor?.name === "GlobalLightSource" || source?.name === "GlobalLight";
}

function buildSmokeVisionConstraint(source, radius, budget) {
  radius = Number.isFinite(radius) ? radius : (canvas.dimensions?.maxR ?? 0);
  if (!radius || budget === null) return null;
  const { x, y, elevation } = source.data;
  const revision = getSmokeRegionRevision(canvas?.scene);
  const perceptionPercent = getActorSmokePerceptionPercent(
    source.object?.actor ?? source.object?.document?.actor
  );
  const densityAdjustment = perceptionPercent / 100;
  const cachedEntries = sourceConstraintCache.get(source) ?? [];
  const bounds = {
    x: x - radius,
    y: y - radius,
    width: radius * 2,
    height: radius * 2
  };
  const regionCandidates = getSmokeRegionsInBounds(bounds, { elevation }).filter(requiresRayAttenuation);
  if (!regionCandidates.length) return null;
  const lightCandidates = getSmokeDispersionCandidates(bounds, { elevation });
  const lightSignature = getSmokeLightCandidateSignature(lightCandidates);
  const cached = cachedEntries.find(entry => entry.kind === "vision-los"
    && entry.revision === revision
    && entry.lightSignature === lightSignature
    && entry.x === x
    && entry.y === y
    && entry.elevation === elevation
    && entry.radius === radius
    && entry.budget === budget
    && entry.perceptionPercent === perceptionPercent);
  if (cached) return cached.constraint;
  const origin = { x, y, elevation };
  const anchors = getSmokeConstraintAnchors(origin, radius, regionCandidates, lightCandidates);
  const traceCache = new Map();
  const trace = rawAngle => {
    const angle = normalizeConstraintAngle(rawAngle);
    const cachedTrace = traceCache.get(angle);
    if (cachedTrace) return cachedTrace;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const destination = { x: x + (dx * radius), y: y + (dy * radius), elevation };
    const profile = buildSmokePathProfile(origin, destination, {
      elevation,
      regionCandidates,
      useLightDispersion: true,
      lightCandidates,
      densityAdjustment
    });
    const smokeCost = calculateProfileCost(profile, { chargeClearDistance: false });
    const traversed = budget === Infinity
      ? smokeCost !== Infinity
      : smokeCost <= Math.max(0, Number(budget) || 0) + EPSILON;
    const distance = calculateProfileVisibleDistance(profile, budget, { chargeClearDistance: false });
    const result = { angle, dx, dy, distance, traversed };
    traceCache.set(angle, result);
    return result;
  };
  const samples = sampleSmokeConstraintAnchors(anchors, radius, trace);
  const points = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const dx = Math.cos(sample.anchor.angle);
    const dy = Math.sin(sample.anchor.angle);
    appendSmokeConstraintPoint(points, origin, dx, dy, sample.left.distance);
    if (sample.left.traversed !== sample.right.traversed
      || hasSmokeConstraintDistanceJump(sample.left.distance, sample.right.distance)) {
      appendSmokeConstraintPoint(points, origin, dx, dy, sample.right.distance);
    }
    const next = samples[(index + 1) % samples.length];
    if (sample.right.traversed !== next.left.traversed) {
      appendSmokeVisionTransition(
        points,
        origin,
        findSmokeVisionTransition(sample.right, next.left, trace, radius),
        sample.right.traversed,
        radius
      );
      continue;
    }
    const midpoint = trace(getSmokeConstraintMidpointAngle(sample.right.angle, next.left.angle));
    if (midpoint.traversed === sample.right.traversed) continue;
    appendSmokeVisionTransition(
      points,
      origin,
      findSmokeVisionTransition(sample.right, midpoint, trace, radius),
      sample.right.traversed,
      radius
    );
    appendSmokeVisionTransition(
      points,
      origin,
      findSmokeVisionTransition(midpoint, next.left, trace, radius),
      midpoint.traversed,
      radius
    );
  }
  const constraint = points.length ? new PIXI.Polygon(points) : null;
  writeSourceConstraintCache(source, cachedEntries, {
    kind: "vision-los",
    revision,
    lightSignature,
    x,
    y,
    elevation,
    radius,
    budget,
    perceptionPercent,
    constraint
  });
  return constraint;
}

function sampleSmokeConstraintAnchors(anchors, radius, trace) {
  return anchors.map((anchor, index) => {
    if (!anchor.topology) {
      const sample = trace(anchor.angle);
      return { anchor, left: sample, right: sample };
    }
    const previous = anchors[(index + anchors.length - 1) % anchors.length].angle;
    const next = anchors[(index + 1) % anchors.length].angle;
    const previousGap = normalizeConstraintAngle(anchor.angle - previous) || (Math.PI * 2);
    const nextGap = normalizeConstraintAngle(next - anchor.angle) || (Math.PI * 2);
    const offset = Math.min(previousGap, nextGap) / 8;
    const pixelOffset = radius > 0 ? CONSTRAINT_TRANSITION_PIXEL_TOLERANCE / radius : offset;
    const sampleOffset = Math.min(offset, pixelOffset);
    return {
      anchor,
      left: trace(anchor.angle - sampleOffset),
      right: trace(anchor.angle + sampleOffset)
    };
  });
}

function hasSmokeConstraintDistanceJump(left, right) {
  return Math.abs((Number(left) || 0) - (Number(right) || 0)) > CONSTRAINT_TRANSITION_PIXEL_TOLERANCE;
}

function appendSmokeConstraintAnchorPoints(points, origin, angle, leftDistance, rightDistance) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  appendSmokeConstraintPoint(points, origin, dx, dy, leftDistance);
  if (hasSmokeConstraintDistanceJump(leftDistance, rightDistance)) {
    appendSmokeConstraintPoint(points, origin, dx, dy, rightDistance);
  }
}

/**
 * Build a stable angular event list for smoke attenuation. The regular Foundry circle basis supplies persistent
 * vertex indices, while effective Region boundary vertices partition changes in the smoke path topology. Native LOS
 * vertices are deliberately excluded: they are the output of the wall sweep and may be re-tessellated while the
 * underlying wall geometry remains unchanged.
 */
function getSmokeConstraintAnchors(origin, radius, regionCandidates, lightCandidates, additionalRadii = []) {
  const density = getSmokeConstraintDensity(radius);
  const anchors = new Array(density);
  const eventRadii = [...new Set([radius, ...additionalRadii]
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value > 0))];
  const step = (Math.PI * 2) / density;
  for (let index = 0; index < density; index++) anchors[index] = { angle: index * step, topology: false };
  for (const entry of regionCandidates) {
    let geometry = entry.geometry;
    if (lightCandidates.length) {
      const dispersedGeometry = getDispersedSmokeGeometry(entry, lightCandidates);
      if (dispersedGeometry) geometry = dispersedGeometry;
      else {
        for (const candidate of lightCandidates) {
          addPolygonConstraintEventAngles(anchors, origin, candidate.source?.shape, eventRadii);
        }
      }
    }
    addSmokeGeometryEventAngles(anchors, origin, geometry, eventRadii);
  }
  anchors.sort((left, right) => left.angle - right.angle);
  const unique = [];
  for (const anchor of anchors) {
    const previous = unique.at(-1);
    if (!previous || Math.abs(anchor.angle - previous.angle) > 1e-10) unique.push(anchor);
    else previous.topology ||= anchor.topology;
  }
  if (unique.length > 1 && ((unique[0].angle + (Math.PI * 2)) - unique.at(-1).angle) <= 1e-10) {
    unique[0].topology ||= unique.at(-1).topology;
    unique.pop();
  }
  return unique;
}

function addSmokeGeometryEventAngles(angles, origin, geometry, radii) {
  if (geometry?.segments?.length) {
    for (const segment of geometry.segments) {
      addConstraintEventAngle(angles, origin, segment.a);
      for (const radius of radii) {
        addConstraintCircleIntersections(angles, origin, radius, segment.a, segment.b);
      }
    }
    return;
  }
  for (const polygon of geometry?.polygons ?? []) {
    addPolygonConstraintEventAngles(angles, origin, polygon, radii);
  }
}

function addPolygonConstraintEventAngles(angles, origin, polygon, radii) {
  const points = polygon?.points ?? [];
  const count = Math.floor(points.length / 2);
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    const point = { x: Number(points[index * 2]) || 0, y: Number(points[(index * 2) + 1]) || 0 };
    const nextPoint = { x: Number(points[next * 2]) || 0, y: Number(points[(next * 2) + 1]) || 0 };
    addConstraintEventAngle(angles, origin, point);
    for (const radius of radii) {
      addConstraintCircleIntersections(angles, origin, radius, point, nextPoint);
    }
  }
}

function addConstraintCircleIntersections(angles, origin, radius, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - origin.x;
  const fy = a.y - origin.y;
  const qa = (dx * dx) + (dy * dy);
  if (qa <= EPSILON) return;
  const qb = 2 * ((fx * dx) + (fy * dy));
  const qc = (fx * fx) + (fy * fy) - (radius * radius);
  const discriminant = (qb * qb) - (4 * qa * qc);
  if (discriminant < -EPSILON) return;
  const root = Math.sqrt(Math.max(0, discriminant));
  for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
    if (t <= EPSILON || t >= 1 - EPSILON) continue;
    addConstraintEventAngle(angles, origin, { x: a.x + (dx * t), y: a.y + (dy * t) });
  }
}

function addConstraintEventAngle(angles, origin, point) {
  const dx = Number(point?.x) - origin.x;
  const dy = Number(point?.y) - origin.y;
  if (Math.abs(dx) <= EPSILON && Math.abs(dy) <= EPSILON) return;
  angles.push({ angle: normalizeConstraintAngle(Math.atan2(dy, dx)), topology: true });
}

/**
 * Locate a pass/block event to sub-pixel angular precision. The visibility boundary has two valid points at this
 * angle: the far native LOS radius and the limiting point inside smoke. Keeping both points produces the same radial
 * edge topology which Foundry's ClockwiseSweep records when a ray changes its active collision.
 */
function findSmokeVisionTransition(left, right, trace, radius) {
  let lowerAngle = left.angle;
  let upperAngle = right.angle;
  if (upperAngle <= lowerAngle) upperAngle += Math.PI * 2;
  let lower = left;
  let upper = right;
  for (let iteration = 0; iteration < CONSTRAINT_TRANSITION_ITERATIONS; iteration++) {
    if ((upperAngle - lowerAngle) * radius <= CONSTRAINT_TRANSITION_PIXEL_TOLERANCE) break;
    const middleAngle = (lowerAngle + upperAngle) / 2;
    const middle = trace(middleAngle);
    if (middle.traversed === left.traversed) {
      lowerAngle = middleAngle;
      lower = middle;
    } else {
      upperAngle = middleAngle;
      upper = middle;
    }
  }
  const angle = normalizeConstraintAngle((lowerAngle + upperAngle) / 2);
  const blocked = left.traversed ? upper : lower;
  return {
    dx: Math.cos(angle),
    dy: Math.sin(angle),
    nearDistance: Math.max(0, Math.min(radius, blocked.distance))
  };
}

function appendSmokeConstraintPoint(points, origin, dx, dy, distance) {
  points.push(origin.x + (dx * distance), origin.y + (dy * distance));
}

function appendSmokeVisionTransition(points, origin, transition, traversedBefore, radius) {
  if (traversedBefore) {
    appendSmokeConstraintPoint(points, origin, transition.dx, transition.dy, radius);
    appendSmokeConstraintPoint(points, origin, transition.dx, transition.dy, transition.nearDistance);
  } else {
    appendSmokeConstraintPoint(points, origin, transition.dx, transition.dy, transition.nearDistance);
    appendSmokeConstraintPoint(points, origin, transition.dx, transition.dy, radius);
  }
}

function getSmokeConstraintMidpointAngle(leftAngle, rightAngle) {
  if (rightAngle <= leftAngle) rightAngle += Math.PI * 2;
  return (leftAngle + rightAngle) / 2;
}

function normalizeConstraintAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

/**
 * Use the same regular, source-local radial basis that Foundry uses when it converts a limited-radius Circle into a
 * polygon. Every vertex keeps its index and direction while the source moves; only its distance changes according to
 * the smoke path profile. Native LOS is applied afterwards, so walls and limited source angles remain authoritative
 * without feeding their changing sweep vertices back into the smoke tessellation.
 */
function getSmokeConstraintDensity(radius) {
  const nativeDensity = Number(globalThis.PIXI?.Circle?.approximateVertexDensity?.(radius));
  return Math.max(3, Math.ceil(
    Number.isFinite(nativeDensity) && nativeDensity > 0
      ? nativeDensity
      : FALLBACK_CONSTRAINT_DENSITY
  ));
}

function writeSourceConstraintCache(source, entries, value) {
  sourceConstraintCache.set(source, [value, ...entries].slice(0, SOURCE_CONSTRAINT_CACHE_LIMIT));
}

function calculateProfileCost(profile, { chargeClearDistance = true } = {}) {
  let cost = 0;
  for (const segment of profile.segments) {
    if (segment.retained <= EPSILON) return Infinity;
    if (!chargeClearDistance && Math.abs(segment.retained - 1) <= EPSILON) continue;
    cost += segment.length / segment.retained;
  }
  return cost;
}

function calculateProfileVisibleDistance(profile, budget, { chargeClearDistance = true } = {}) {
  if (budget === Infinity) {
    const opaque = profile.segments.find(segment => segment.retained <= EPSILON);
    return opaque ? opaque.start * profile.length : profile.length;
  }
  let remaining = Math.max(0, Number(budget) || 0);
  for (const segment of profile.segments) {
    if (segment.retained <= EPSILON) return segment.start * profile.length;
    if (!chargeClearDistance && Math.abs(segment.retained - 1) <= EPSILON) continue;
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
    const rayElevation = getSmokeRayElevation(origin, test.point);
    const regionCandidates = getSmokeRegionsAlongRay(origin, test.point, {
      elevation: rayElevation
    }).filter(requiresRayAttenuation);
    if (!regionCandidates.length) return true;
    const densityAdjustment = getActorSmokeDensityAdjustment(
      visionSource.object?.actor ?? visionSource.object?.document?.actor
    );
    return isSmokePathVisible(
        origin,
        test.point,
        maximumDistance,
        {
          elevation: rayElevation,
          regionCandidates,
          useLightDispersion: true,
          densityAdjustment,
          chargeClearDistance: false
        }
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
    const rayElevation = getSmokeRayElevation(origin, test.point);
    const regionCandidates = getSmokeRegionsAlongRay(origin, test.point, {
      elevation: rayElevation
    }).filter(requiresRayAttenuation);
    if (!regionCandidates.length) return true;
    const densityAdjustment = getActorSmokeDensityAdjustment(
      visionSource.object?.actor ?? visionSource.object?.document?.actor
    );
    const measurement = measureSmokePath(origin, test.point, {
      elevation: rayElevation,
      chargeClearDistance: false,
      regionCandidates,
      useLightDispersion: true,
      densityAdjustment
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
  return Boolean(index?.hasVisionSmoke);
}

function requiresRayAttenuation(entry) {
  return entry?.smoke?.density > EPSILON;
}

/**
 * The rendered LOS contains smoke. Special wall-aware senses which use
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
      if (!index?.hasVisionSmoke || !visionSource?.los?.config) {
        return defaultTestLos.call(this, visionSource, detectionMode, target, test);
      }
      const cached = readClearSmokeLosCache(test, this, visionSource);
      if (cached !== undefined) return cached;
      const config = { ...visionSource.los.config };
      delete config._falloutMawIncludeSmokeEdges;
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

function getRegionRayIntervals(entry, from, to, elevation, geometryOverride) {
  const { region } = entry;
  const geometry = geometryOverride ?? entry.geometry;
  if (from.elevation === to.elevation
    && isRegionOnElevation(region, from.elevation)
    && geometry?.polygonTree?.testPoint) {
    if (geometry.segments.length) return getPolygonTreeRayIntervals(geometry, from, to);
    if (geometryOverride) return [];
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
  return createSmokeGeometry(polygonTree, polygons);
}

function createSmokeGeometry(polygonTree, polygons) {
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

function boundsIntersectCircle(bounds, x, y, radius) {
  const nearestX = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width));
  const nearestY = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height));
  const dx = nearestX - x;
  const dy = nearestY - y;
  return ((dx * dx) + (dy * dy)) <= (radius * radius);
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

function getSmokeRayElevation(from, to) {
  const start = normalizePoint(from);
  const end = normalizePoint(to);
  return Math.abs(start.elevation - end.elevation) <= EPSILON ? start.elevation : null;
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
  const desired = new Map();
  for (const entry of index?.entries ?? []) desired.set(entry.behavior.uuid, entry);
  const signature = [...desired].map(([uuid, entry]) => `${uuid}:${entry.smoke.thickness}:${entry.smoke.density}`).sort().join("|");
  const smokeStateChanged = smokeSignatureByScene.get(canvas.scene) !== signature;
  smokeSignatureByScene.set(canvas.scene, signature);
  const sourceGeometryChanged = forceVision || smokeStateChanged;
  const shaders = foundry.canvas?.rendering?.shaders;
  const darknessCollection = canvas.effects?.illumination?.darknessLevelMeshes;
  const illuminationMeshes = canvas.visibility?.vision?.light?.global?.meshes;
  if (!shaders?.AdjustDarknessLevelRegionShader
    || !shaders?.IlluminationDarknessLevelRegionShader
    || !darknessCollection
    || !illuminationMeshes) {
    if (sourceGeometryChanged) canvas.perception.update({
      initializeLightSources: true,
      initializeVision: true
    });
    return;
  }
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
  const refreshVision = sourceGeometryChanged
    || (renderingChanged && canvas.environment?.globalLightSource?.active);
  if (renderingChanged || refreshVision) {
    canvas.perception.update({
      initializeLightSources: sourceGeometryChanged,
      initializeVision: sourceGeometryChanged,
      refreshLighting: renderingChanged,
      refreshVision
    });
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
