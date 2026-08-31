import { SYSTEM_ID } from "../constants.mjs";
import { getSmokeRuntimeProperties } from "../utils/region-special-properties.mjs";
import { toOptionalFiniteNumber } from "../utils/numbers.mjs";
import { regionBehaviorTargetsActor } from "./region-targeting.mjs";
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
const CONSTRAINT_TRANSITION_ITERATIONS = 18;
const CONSTRAINT_TRANSITION_PIXEL_TOLERANCE = 0.05;
const SOURCE_CONSTRAINT_CACHE_LIMIT = 4;
const BRIGHT_LIGHT_DENSITY_MULTIPLIER = 1;
const DIM_LIGHT_DENSITY_MULTIPLIER = 2;
const EPSILON = 1e-6;
const REGION_ANIMATION_PATCH = Symbol.for(`${SYSTEM_ID}.smokeRegionAnimationPatch`);
const VISIBILITY_REFRESH_PATCH = Symbol.for(`${SYSTEM_ID}.smokeVisibilityRefreshPatch`);
const POINT_ONLY_SMOKE_VISION = Symbol.for(`${SYSTEM_ID}.pointOnlySmokeVision`);
const TEST_SMOKE_VISION_POINT = Symbol.for(`${SYSTEM_ID}.testSmokeVisionPoint`);

let smokeIndexByScene = new WeakMap();
let smokeRevisionByScene = new WeakMap();
let smokeStructureRevisionByScene = new WeakMap();
let smokeIndexSignatureByScene = new WeakMap();
let smokeGeometryByPolygonTree = new WeakMap();
let smokeSignatureByScene = new WeakMap();
let sourceConstraintCache = new WeakMap();
let clearSmokeLosCache = new WeakMap();
let smokeLightRanges = new WeakMap();
let dispersedSmokeGeometryCache = new WeakMap();
let smokeLightCandidateSignatureCache = new WeakMap();
let smokeLightRevision = 0;
let smokeRegionAnimationTransforms = new WeakMap();
let smokeRegionAnimationEligibility = new WeakMap();
let smokeRegionCommittedStates = new WeakMap();
let pendingSmokeAnimationChangesByScene = new WeakMap();
let pendingSmokeAnimationCommitsByScene = new WeakMap();
let failedSmokeAnimationSourcesByScene = new WeakMap();
let failedNativeSmokeSources = new Map();
let smokeAnimationFailureKeyByScene = new WeakMap();
let animatedSmokeSourceTransitions = new WeakMap();
const smokeMeshes = new Map();
let lightDependentVisionRefreshScheduled = false;
const pendingSmokePerceptionEffectUpdates = new WeakSet();
let smokeAnimationTicker = null;
let smokeAnimationCommitTicker = null;
let smokeAnimationTickerOwner = null;
let strictSmokeVisionInitializationDepth = 0;

export function registerSmokeVisionHooks() {
  patchSmokeRegionAnimationFrames();
  patchSmokeVisibilityRefresh();
  patchSmokeDetectionRanges();
  registerVisionSourceClass();
  registerLightSourceClass();
  registerDarknessSourceClass();
  Hooks.on("createRegion", document => refreshForDocument(document));
  Hooks.on("deleteRegion", document => refreshForDocument(document));
  Hooks.on("updateRegion", (document, changed) => {
    if (hasAnyChangedPath(changed, ["shapes", "elevation", "hidden", "visibility", "levels", "attachment"])) {
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
      "system.targetRelations",
      "system.sourceActorUuid",
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
  Hooks.on("updateActor", (actor, changed = {}) => {
    if (actorHasSmokePerceptionChange(actor)) refreshVisionForSmokePerceptionActor(actor);
    if (hasAnyChangedPath(changed, [
      `flags.${SYSTEM_ID}.factionBelongs`,
      `flags.${SYSTEM_ID}.factionRelations`
    ])) refreshVisionForSmokeTargetRelations();
  });
  Hooks.on(`${SYSTEM_ID}.factionSettingsChanged`, () => refreshVisionForSmokeTargetRelations());
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
    patchSmokeRegionAnimationFrames({ required: true });
    patchSmokeVisibilityRefresh({ required: true });
    patchSmokeDetectionRanges({ required: true });
    registerVisionSourceClass({ required: true });
    registerLightSourceClass({ required: true });
    registerDarknessSourceClass({ required: true });
    invalidateSmokeRegionIndex(canvas?.scene);
    syncSmokeDarknessMeshes({ forceRendering: true, forceVision: true });
    if (!attachSmokeAnimationTicker()) throw new Error("Foundry Canvas ticker contract is required for attached smoke");
  });
  Hooks.on("updateWorldTime", (worldTime, delta) => {
    // Activation windows may change without a RegionBehavior document update.
    // This only drops the tiny per-Region animation gate; the next animated
    // frame recomputes it once rather than scanning behaviors every frame.
    smokeRegionAnimationEligibility = new WeakMap();
    const index = getSmokeRegionIndex(canvas?.scene);
    const transitionDue = Number.isFinite(index?.nextTransitionAt)
      && Number(worldTime) >= index.nextTransitionAt;
    if (!(Number(delta) < 0) && !transitionDue) return;
    invalidateSmokeRegionIndex(canvas?.scene, { bumpRevision: false, bumpStructure: false });
    scheduleSmokeRefresh();
  });
  Hooks.on("canvasTearDown", () => {
    detachSmokeAnimationTicker();
    destroySmokeDarknessMeshes();
    smokeIndexByScene = new WeakMap();
    smokeRevisionByScene = new WeakMap();
    smokeStructureRevisionByScene = new WeakMap();
    smokeIndexSignatureByScene = new WeakMap();
    smokeGeometryByPolygonTree = new WeakMap();
    smokeSignatureByScene = new WeakMap();
    sourceConstraintCache = new WeakMap();
    clearSmokeLosCache = new WeakMap();
    smokeLightRanges = new WeakMap();
    dispersedSmokeGeometryCache = new WeakMap();
    smokeLightCandidateSignatureCache = new WeakMap();
    smokeRegionAnimationTransforms = new WeakMap();
    smokeRegionAnimationEligibility = new WeakMap();
    smokeRegionCommittedStates = new WeakMap();
    pendingSmokeAnimationChangesByScene = new WeakMap();
    pendingSmokeAnimationCommitsByScene = new WeakMap();
    failedSmokeAnimationSourcesByScene = new WeakMap();
    failedNativeSmokeSources = new Map();
    smokeAnimationFailureKeyByScene = new WeakMap();
    animatedSmokeSourceTransitions = new WeakMap();
    strictSmokeVisionInitializationDepth = 0;
    smokeLightRevision = 0;
    invalidateActorSmokePerception();
    lightDependentVisionRefreshScheduled = false;
  });
}

/**
 * Foundry V14.361 updates attached Region animation state directly from the
 * Token frame. Its published REGION_ANIMATION constant is not the name used by
 * that call site, so observe the native frame method. Nothing expensive runs
 * inside the attachment loop: all Regions in the scene share one deferred
 * darkness-texture and native source refresh for that animation frame.
 */
function patchSmokeRegionAnimationFrames({ required = false } = {}) {
  const RegionClass = globalThis.foundry?.canvas?.placeables?.Region;
  const prototype = RegionClass?.prototype;
  if (prototype?.[REGION_ANIMATION_PATCH]) return true;
  const original = prototype?._onTokenAnimationFrame;
  if (typeof original !== "function") {
    if (required) throw new Error("Foundry Region animation-frame contract is required for attached smoke");
    return false;
  }
  Object.defineProperty(prototype, REGION_ANIMATION_PATCH, { value: original });
  prototype._onTokenAnimationFrame = function(...args) {
    const tracksSmoke = hasActiveSmokeBehavior(this.document);
    if (!tracksSmoke) return original.apply(this, args);
    const scene = this.document?.parent;
    if (scene && pendingSmokeAnimationCommitsByScene.has(scene)) {
      commitAnimatedSmokeFrame();
      if (pendingSmokeAnimationCommitsByScene.has(scene)) return;
    }
    const previousState = captureAnimatedSmokeRegionState(this);
    const result = original.apply(this, args);
    notifySmokeRegionAnimation(this, { previousState });
    return result;
  };
  return true;
}

/**
 * Complete a pending shared-fog smoke transaction inside Foundry's already
 * scheduled visibility refresh. This keeps the source initialization strict
 * without adding a second scene-wide visibility pass to the same frame.
 */
function patchSmokeVisibilityRefresh({ required = false } = {}) {
  const visibility = globalThis.canvas?.visibility;
  if (visibility?.[VISIBILITY_REFRESH_PATCH]) return true;
  const original = visibility?.refresh;
  if (typeof original !== "function") {
    if (required) throw new Error("Foundry CanvasVisibility.refresh is required for attached smoke");
    return false;
  }
  Object.defineProperty(visibility, VISIBILITY_REFRESH_PATCH, { value: original });
  visibility.refresh = function(...args) {
    const scene = globalThis.canvas?.scene;
    const commit = scene && pendingSmokeAnimationCommitsByScene.get(scene);
    if (!commit?.awaitingNativeVisibility) return original.apply(this, args);
    strictSmokeVisionInitializationDepth += 1;
    try {
      const result = original.apply(this, args);
      if (commit.retryingNativeVisibility) commit.nativeVisibilityRetrySucceeded = true;
      else finalizeAnimatedSmokeCommit(scene, commit);
      return result;
    } catch (error) {
      // PIXI does not isolate ticker listener failures. Keep this exact
      // transaction pending and retry the same native visibility path.
      reportAnimatedSmokeFailure(scene, pendingSmokeAnimationChangesByScene.get(scene), error);
      return undefined;
    } finally {
      strictSmokeVisionInitializationDepth -= 1;
    }
  };
  return true;
}

/**
 * Mark one token-attached smoke Region frame. Exported so the native Region
 * behavior event can use the same deduplicated path if Foundry fixes its V14
 * event-name mismatch in a later build.
 */
export function notifySmokeRegionAnimation(region, { previousState = null } = {}) {
  const regionDocument = region?.document ?? region;
  const regionObject = regionDocument?.object ?? region;
  const token = regionDocument?.attachment?.token;
  const scene = regionDocument?.parent;
  if (!scene || !token || !hasActiveSmokeBehavior(regionDocument)) return false;
  const signature = [
    Boolean(regionObject?.isAnimating),
    exactAnimationNumber(token.x),
    exactAnimationNumber(token.y),
    exactAnimationNumber(token.elevation),
    exactAnimationNumber(token.rotation)
  ].join(":");
  if (smokeRegionAnimationTransforms.get(regionDocument) === signature) return false;

  const queued = queueAnimatedSmokeRegionChange(
    scene,
    regionDocument,
    previousState ?? captureAnimatedSmokeRegionState(regionDocument),
    signature
  );
  const hasTickerFlush = scene === globalThis.canvas?.scene
    && globalThis.canvas?.ready
    && attachSmokeAnimationTicker();
  if (!hasTickerFlush) throw new Error("Attached smoke requires the active Foundry Canvas ticker");
  return queued;
}

function captureAnimatedSmokeRegionState(region) {
  const regionDocument = region?.document ?? region;
  if (!regionDocument?.parent) return { known: false, bounds: null };
  const committed = smokeRegionCommittedStates.get(regionDocument);
  if (committed) return cloneAnimatedSmokeRegionState(committed);
  const indexed = getSmokeRegionIndex(regionDocument.parent)?.regionStates?.get(regionDocument);
  if (!indexed?.bounds || !indexed.count) {
    throw new Error(`Attached smoke Region ${regionDocument.uuid ?? regionDocument.id ?? "<unknown>"}`
      + " has no committed native spatial state");
  }
  const state = cloneAnimatedSmokeRegionState(indexed);
  smokeRegionCommittedStates.set(regionDocument, state);
  return cloneAnimatedSmokeRegionState(state);
}

function cloneAnimatedSmokeRegionState(state) {
  return {
    known: state?.known !== false && Boolean(state?.bounds),
    bounds: cloneBounds(state?.bounds),
    bottom: toOptionalFiniteNumber(state?.bottom),
    top: toOptionalFiniteNumber(state?.top),
    topInclusive: state?.topInclusive === true,
    level: state?.level ?? null,
    hasDensity: state?.hasDensity === true,
    hasThickness: state?.hasThickness === true
  };
}

function queueAnimatedSmokeRegionChange(scene, regionDocument, previousState, signature) {
  let changes = pendingSmokeAnimationChangesByScene.get(scene);
  if (!changes) pendingSmokeAnimationChangesByScene.set(scene, changes = new Map());
  const existing = changes.get(regionDocument);
  if (existing?.signature === signature) return false;
  if (!existing) {
    changes.set(regionDocument, {
      oldState: cloneAnimatedSmokeRegionState(previousState),
      signature
    });
    return true;
  }
  existing.signature = signature;
  return true;
}

function hasActiveSmokeBehavior(regionDocument) {
  if (!regionDocument) return false;
  if (smokeRegionAnimationEligibility.has(regionDocument)) {
    return smokeRegionAnimationEligibility.get(regionDocument);
  }
  if (regionDocument.hidden) {
    smokeRegionAnimationEligibility.set(regionDocument, false);
    return false;
  }
  const behaviors = regionDocument.behaviors?.contents ?? regionDocument.behaviors ?? [];
  let eligible = false;
  for (const behavior of behaviors) {
    if (
      behavior?.type !== PERIODIC_DAMAGE_BEHAVIOR_TYPE
      || behavior.disabled
      || behavior.viewed === false
      || behavior.visible === false
    ) continue;
    const state = getSmokeRegionState(behavior);
    if (!state?.active) continue;
    if (state.smoke.density > EPSILON || state.smoke.thickness > EPSILON) {
      eligible = true;
      break;
    }
  }
  smokeRegionAnimationEligibility.set(regionDocument, eligible);
  return eligible;
}

function exactAnimationNumber(value) {
  const number = Number(value);
  if (Number.isNaN(number)) return "NaN";
  if (number === Infinity) return "+Infinity";
  if (number === -Infinity) return "-Infinity";
  return String(number);
}

function notifySmokeNativePerceptionRefresh(payload = undefined) {
  globalThis.Hooks?.callAll?.(`${SYSTEM_ID}.smokeNativePerceptionRefresh`, payload);
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

function refreshVisionForSmokeTargetRelations() {
  if (!getSmokeRegionIndex(canvas?.scene)?.hasVisionSmoke) return;
  sourceConstraintCache = new WeakMap();
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
  const region = document?.documentName === "Region"
    ? document
    : document?.parent?.documentName === "Region"
      ? document.parent
      : document?.behaviors
        ? document
        : document?.parent?.behaviors
          ? document.parent
          : null;
  if (region) {
    smokeRegionAnimationEligibility.delete(region);
    smokeRegionCommittedStates.delete(region);
  }
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

export function invalidateSmokeRegionIndex(scene = canvas?.scene, {
  bumpRevision = true,
  bumpStructure = true
} = {}) {
  if (!scene) return;
  smokeIndexByScene.delete(scene);
  if (bumpRevision) smokeRevisionByScene.set(scene, (smokeRevisionByScene.get(scene) ?? 0) + 1);
  if (bumpStructure) {
    smokeStructureRevisionByScene.set(scene, (smokeStructureRevisionByScene.get(scene) ?? 0) + 1);
  }
}

export function queueSmokeRegionRefresh({ forceRendering = true, forceVision = true } = {}) {
  smokeRegionAnimationEligibility = new WeakMap();
  invalidateSmokeRegionIndex(canvas?.scene);
  scheduleSmokeRefresh({ forceRendering, forceVision });
}

export function getSmokeRegionIndex(scene = canvas?.scene) {
  if (!scene) return null;
  const cached = smokeIndexByScene.get(scene);
  if (cached) return cached;
  const entries = [];
  const buckets = new Map();
  const regionStates = new Map();
  const regionEntryIndexes = new Map();
  let nextTransitionAt = Infinity;
  const now = Number(globalThis.game?.time?.worldTime) || 0;
  for (const region of scene.regions?.contents ?? []) {
    if (!region || region.hidden) continue;
    let regionBounds;
    let regionGeometry;
    let regionGeometryPrepared = false;
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
      if (!regionGeometryPrepared) {
        regionBounds = getRegionBounds(region);
        regionGeometry = getSmokeRegionGeometry(region);
        regionGeometryPrepared = true;
      }
      const entry = {
        region,
        behavior,
        smoke: state.smoke,
        bounds: regionBounds,
        geometry: regionGeometry
      };
      const index = entries.push(entry) - 1;
      const regionIndexes = regionEntryIndexes.get(region) ?? [];
      regionIndexes.push(index);
      regionEntryIndexes.set(region, regionIndexes);
      const regionState = regionStates.get(region) ?? {
        bounds: null,
        cells: [],
        count: 0,
        hasDensity: false,
        hasThickness: false
      };
      regionState.bounds = unionBounds([regionState.bounds, entry.bounds].filter(Boolean));
      regionState.count += 1;
      regionState.hasDensity ||= entry.smoke.density > EPSILON;
      regionState.hasThickness ||= entry.smoke.thickness > EPSILON;
      regionStates.set(region, regionState);
      for (const key of getBoundsCells(entry.bounds)) {
        const bucket = buckets.get(key) ?? [];
        bucket.push(index);
        buckets.set(key, bucket);
      }
    }
    const regionState = regionStates.get(region);
    if (regionState) {
      regionState.cells = getBoundsCells(regionState.bounds);
      Object.assign(regionState, getAnimatedSmokeRegionElevationState(region));
      if (
        !smokeRegionCommittedStates.has(region)
        && !pendingSmokeAnimationChangesByScene.get(scene)?.has(region)
      ) {
        smokeRegionCommittedStates.set(region, cloneAnimatedSmokeRegionState(regionState));
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
    smokeStructureRevisionByScene.set(scene, (smokeStructureRevisionByScene.get(scene) ?? 0) + 1);
  }
  const index = {
    entries,
    buckets,
    regionStates,
    regionEntryIndexes,
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

/** Read the current invalidation stamp without forcing the lazy spatial index. */
export function peekSmokeRegionRevision(scene = canvas?.scene) {
  return scene ? (smokeRevisionByScene.get(scene) ?? 0) : 0;
}

function getSmokeStructureRevision(scene = canvas?.scene) {
  return scene ? (smokeStructureRevisionByScene.get(scene) ?? 0) : 0;
}

export function getSmokeRegionsAlongRay(from, to, {
  scene = canvas?.scene,
  elevation = null,
  targetActor = null
} = {}) {
  return getSmokeRegionsInBounds(getSegmentBounds(from, to), { scene, elevation, targetActor });
}

export function getSmokeRegionsInBounds(bounds, {
  scene = canvas?.scene,
  elevation = null,
  targetActor = null
} = {}) {
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
    .filter(entry => isRegionOnElevation(entry.region, elevation))
    .filter(entry => !targetActor || regionBehaviorTargetsActor(entry.region, entry.behavior, targetActor));
}

export function calculateSmokePathCost(from, to, {
  scene = canvas?.scene,
  elevation = null,
  targetActor = null
} = {}) {
  return measureSmokePath(from, to, { scene, elevation, targetActor }).cost;
}

export function measureSmokePath(from, to, {
  scene = canvas?.scene,
  elevation = null,
  targetActor = null,
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
    targetActor,
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
  targetActor = null,
  regionCandidates = null,
  densityMultiplier = 1,
  densityAdjustment = 0,
  useLightDispersion = false,
  lightCandidates = null
} = {}) {
  return buildSmokePathProfiles(from, to, {
    scene,
    elevation,
    targetActor,
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
  targetActor = null,
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
  const regions = (regionCandidates ?? getSmokeRegionsAlongRay(start, end, {
    scene,
    elevation: queryElevation,
    targetActor
  }))
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

function registerVisionSourceClass({ required = false } = {}) {
  const base = CONFIG.Canvas?.visionSourceClass;
  if (base?.__falloutMawSmokeVisionSource) return true;
  if (!base) {
    if (required) throw new Error("Foundry VisionSource class is required for smoke");
    return false;
  }
  class SmokeVisionSource extends base {
    add(...args) {
      return super.add(...args);
    }

    remove(...args) {
      const collection = this.effectsCollection;
      if (collection.get?.(this.sourceId) !== this) return undefined;
      return super.remove(...args);
    }

    initialize(...args) {
      const transition = captureAnimatedSmokeSourceTransition(this, { vision: true });
      const updateId = Number(this.updateId);
      const result = super.initialize(...args);
      recordAnimatedSmokeSourceInitialization(this, transition, updateId);
      if (strictSmokeVisionInitializationDepth
        && (!Number.isInteger(updateId) || Number(this.updateId) !== updateId + 1)) {
        throw new Error(`VisionSource ${this.sourceId ?? "<unknown>"} did not complete native shape initialization`);
      }
      return result;
    }

    destroy(...args) {
      failedNativeSmokeSources.delete(this);
      return super.destroy(...args);
    }

    _createShapes() {
      super._createShapes();
      const index = getSmokeRegionIndex(canvas?.scene);
      if (!index?.hasVisionSmoke) return;
      if (!this.los) throw new Error(`VisionSource ${this.sourceId ?? "<unknown>"} has no native LOS polygon`);
      // Stealth already needs one exact directed smoke path for its own range,
      // darkness, and noise rules. Its temporary native mask keeps the current
      // VisionSource class but replaces this radial polygon with the equivalent
      // single-ray gate exposed below.
      if (this[POINT_ONLY_SMOKE_VISION]) return;
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

    [TEST_SMOKE_VISION_POINT](point) {
      return testSmokeVisionSourcePoint(this, point);
    }
  }
  Object.defineProperty(SmokeVisionSource, "__falloutMawSmokeVisionSource", { value: true });
  CONFIG.Canvas.visionSourceClass = SmokeVisionSource;
  return true;
}

function testSmokeVisionSourcePoint(source, point) {
  const index = getSmokeRegionIndex(canvas?.scene);
  if (!index?.hasVisionSmoke) return true;
  if (!source?.los) throw new Error(`VisionSource ${source?.sourceId ?? "<unknown>"} has no native LOS polygon`);
  const lightRadius = Math.max(0, Number(source.lightRadius) || 0);
  const sightRadius = Math.max(0, Number(source.radius || source.data?.externalRadius) || 0);
  const radius = Math.max(lightRadius, sightRadius);
  const budget = getBasicSightRadius(source, sightRadius) ?? sightRadius;
  if (!radius) return true;

  const origin = normalizePoint(source.data);
  // The radial constraint is a 2D polygon built on the source elevation. Keep
  // the point substitute on that same plane; the stealth path which follows it
  // remains responsible for the real 3D target ray.
  const destination = normalizePoint({ x: point?.x, y: point?.y, elevation: origin.elevation });
  const rayElevation = origin.elevation;
  const targetActor = source.object?.actor ?? source.object?.document?.actor ?? null;
  const regionCandidates = getSmokeRegionsAlongRay(origin, destination, {
    elevation: rayElevation,
    targetActor
  }).filter(requiresRayAttenuation);
  if (!regionCandidates.length) return true;
  const segmentBounds = getSegmentBounds(origin, destination);
  return isSmokePathVisible(origin, destination, budget, {
    elevation: rayElevation,
    regionCandidates,
    useLightDispersion: true,
    lightCandidates: getSmokeDispersionCandidates(segmentBounds, { elevation: rayElevation }),
    densityAdjustment: getActorSmokeDensityAdjustment(targetActor),
    chargeClearDistance: false
  });
}

function constrainVisionPolygon(los, source, radius) {
  if (!los) return los;
  if (radius >= (Number(los.config?.radius) || 0)) return los;
  return los.applyConstraint(new PIXI.Circle(source.data.x, source.data.y, radius));
}

function registerLightSourceClass({ required = false } = {}) {
  const base = CONFIG.Canvas?.lightSourceClass;
  if (base?.__falloutMawSmokeLightSource) return true;
  if (!base) {
    if (required) throw new Error("Foundry LightSource class is required for smoke");
    return false;
  }
  class SmokeLightSource extends base {
    add(...args) {
      return super.add(...args);
    }

    remove(...args) {
      const collection = this.effectsCollection;
      if (collection.get?.(this.sourceId) !== this) return undefined;
      return super.remove(...args);
    }

    initialize(...args) {
      const transition = captureAnimatedSmokeSourceTransition(this, { vision: false });
      const updateId = Number(this.updateId);
      const result = super.initialize(...args);
      recordAnimatedSmokeSourceInitialization(this, transition, updateId);
      return result;
    }

    destroy(...args) {
      failedNativeSmokeSources.delete(this);
      return super.destroy(...args);
    }

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
  return true;
}

function registerDarknessSourceClass({ required = false } = {}) {
  const base = CONFIG.Canvas?.darknessSourceClass;
  if (base?.__falloutMawStrictSmokeDarknessSource) return true;
  if (!base) {
    if (required) throw new Error("Foundry DarknessSource class is required for smoke");
    return false;
  }
  class StrictSmokeDarknessSource extends base {
    add(...args) {
      return super.add(...args);
    }

    remove(...args) {
      const collection = this.effectsCollection;
      if (collection.get?.(this.sourceId) !== this) return undefined;
      return super.remove(...args);
    }

    initialize(...args) {
      const transition = captureAnimatedSmokeSourceTransition(this, { vision: false });
      const updateId = Number(this.updateId);
      const result = super.initialize(...args);
      recordAnimatedSmokeSourceInitialization(this, transition, updateId);
      return result;
    }

    destroy(...args) {
      failedNativeSmokeSources.delete(this);
      return super.destroy(...args);
    }

  }
  Object.defineProperty(StrictSmokeDarknessSource, "__falloutMawStrictSmokeDarknessSource", { value: true });
  CONFIG.Canvas.darknessSourceClass = StrictSmokeDarknessSource;
  return true;
}

function createSmokeLightShape(source, basePolygon) {
  const radius = Math.max(0, Number(source.radius) || 0);
  if (!radius) return null;
  if (!basePolygon || typeof basePolygon.applyConstraint !== "function") {
    throw new Error(`LightSource ${source?.sourceId ?? "<unknown>"} has no native source polygon`);
  }
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
    structureRevision: getSmokeStructureRevision(canvas?.scene),
    bright: constraints.bright,
    dim: constraints.dim,
    shape,
    sourceState: getSmokeLightSourceState(source)
  });
  return shape;
}

function buildSmokeLightConstraints(source, radius, brightRadius, dimRadius, regionCandidates) {
  const { x, y, elevation } = source.data;
  const cachedEntries = sourceConstraintCache.get(source) ?? [];
  const relativeSmokeState = createRelativeSmokeCandidateState(
    regionCandidates,
    { x, y, elevation }
  );
  const cached = cachedEntries.find(entry => entry.kind === "light"
    && areRelativeSmokeCandidateStatesEqual(entry.relativeSmokeState, relativeSmokeState)
    && entry.radius === radius
    && entry.brightRadius === brightRadius
    && entry.dimRadius === dimRadius);
  if (cached) return {
    bright: createTranslatedSmokePolygon(cached.relativeBrightPoints, x, y),
    dim: createTranslatedSmokePolygon(cached.relativeDimPoints, x, y),
    combined: createTranslatedSmokePolygon(cached.relativeCombinedPoints, x, y)
  };

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
    relativeSmokeState,
    radius,
    brightRadius,
    dimRadius,
    relativeBrightPoints: getRelativeSmokePolygonPoints(constraints.bright, x, y),
    relativeDimPoints: getRelativeSmokePolygonPoints(constraints.dim, x, y),
    relativeCombinedPoints: getRelativeSmokePolygonPoints(constraints.combined, x, y)
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
  if (!ranges || ranges.structureRevision !== getSmokeStructureRevision(canvas?.scene)) return null;
  if (ranges.bright?.contains?.(point.x, point.y)) return "bright";
  if (ranges.dim?.contains?.(point.x, point.y)) return "dim";
  return "none";
}

function setSmokeLightRanges(source, ranges) {
  const previous = smokeLightRanges.get(source);
  const originX = Number(source?.data?.x);
  const originY = Number(source?.data?.y);
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    throw new Error(`LightSource ${source?.sourceId ?? "<unknown>"} has no native planar origin`);
  }
  const changed = !previous
    || previous.sourceState !== ranges.sourceState
    || !areSmokeConstraintPolygonsEqual(previous.bright, ranges.bright)
    || !areSmokeConstraintPolygonsEqual(previous.dim, ranges.dim)
    || !areSmokeConstraintPolygonsEqual(previous.shape, ranges.shape);
  const relativeSourceState = getSmokeLightRelativeSourceState(source);
  const relativeChanged = !previous
    || previous.relativeSourceState !== relativeSourceState
    || !areSmokeConstraintPolygonsTranslationEqual(
      previous.bright, ranges.bright, previous.originX, previous.originY, originX, originY
    )
    || !areSmokeConstraintPolygonsTranslationEqual(
      previous.dim, ranges.dim, previous.originX, previous.originY, originX, originY
    )
    || !areSmokeConstraintPolygonsTranslationEqual(
      previous.shape, ranges.shape, previous.originX, previous.originY, originX, originY
    );
  if (changed) {
    smokeLightRevision += 1;
    ranges.version = smokeLightRevision;
  } else ranges.version = previous.version;
  ranges.relativeVersion = relativeChanged ? ranges.version : previous.relativeVersion;
  ranges.relativeSourceState = relativeSourceState;
  ranges.originX = originX;
  ranges.originY = originY;
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

function areSmokeConstraintPolygonsTranslationEqual(left, right, leftX, leftY, rightX, rightY) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (!areSmokePointSequencesTranslationEqual(left.points, right.points, leftX, leftY, rightX, rightY)) return false;
  return areSmokeSurfaceExposureTranslationEqual(
    left.surfaceExposure,
    right.surfaceExposure,
    leftX,
    leftY,
    rightX,
    rightY
  );
}

function areSmokePointSequencesTranslationEqual(leftPoints, rightPoints, leftX, leftY, rightX, rightY) {
  if (leftPoints === rightPoints) return true;
  if (!leftPoints || !rightPoints || leftPoints.length !== rightPoints.length) return false;
  for (let index = 0; index < leftPoints.length; index += 2) {
    if (Math.abs((Number(leftPoints[index]) - leftX) - (Number(rightPoints[index]) - rightX)) > EPSILON) {
      return false;
    }
    if (Math.abs((Number(leftPoints[index + 1]) - leftY) - (Number(rightPoints[index + 1]) - rightY)) > EPSILON) {
      return false;
    }
  }
  return true;
}

function areSmokeSurfaceExposureTranslationEqual(left, right, leftX, leftY, rightX, rightY) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.points || right.points) {
    return areSmokePointSequencesTranslationEqual(left.points, right.points, leftX, leftY, rightX, rightY);
  }
  const leftPolygons = left.polygons;
  const rightPolygons = right.polygons;
  if (!leftPolygons || !rightPolygons || leftPolygons.length !== rightPolygons.length) return false;
  for (let index = 0; index < leftPolygons.length; index += 1) {
    if (!areSmokePointSequencesTranslationEqual(
      leftPolygons[index]?.points,
      rightPolygons[index]?.points,
      leftX,
      leftY,
      rightX,
      rightY
    )) return false;
  }
  return true;
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

function getSmokeLightRelativeSourceState(source) {
  const data = source?.data ?? {};
  return [
    Number(source?.radius ?? data.radius) || 0,
    Number(data.bright) || 0,
    Number(data.dim) || 0,
    Number(data.priority) || 0,
    data.walls === false ? 0 : 1,
    source?.level?.id ?? data.level ?? ""
  ].join(":");
}

function getSmokeDispersionCandidates(bounds, { elevation = null } = {}) {
  const structureRevision = getSmokeStructureRevision(canvas?.scene);
  const candidates = [];
  const sources = canvas?.effects?.lightSources;
  for (const source of sources?.values?.() ?? sources ?? []) {
    if (!source?.active || isGlobalLightSource(source)) continue;
    const ranges = smokeLightRanges.get(source);
    if (!ranges || ranges.structureRevision !== structureRevision) continue;
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
  return getSmokeLightInfluenceElevationState({
    elevation: Number(source?.data?.elevation),
    priority: getEffectSourcePriority(source),
    verticalRadius: Math.max(0, Number(source?.radius ?? source?.data?.radius) || 0)
  }, elevation);
}

function getSmokeLightInfluenceElevationState(influence, elevation) {
  if (elevation === null || elevation === undefined) {
    return { reaches: true, planarDifference: false };
  }
  const targetElevation = Number(elevation);
  if (!Number.isFinite(targetElevation)) return { reaches: true, planarDifference: false };
  if ((Number(influence?.priority) || 0) > 0) return { reaches: true, planarDifference: true };
  const sourceElevation = Number(influence?.elevation) || 0;
  const radius = Math.max(0, Number(influence?.verticalRadius) || 0);
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
  if (typeof polygonTree?.intersectPolygon !== "function" || difference === undefined) {
    throw new Error("Native PolygonTree/Clipper difference contract is required for planar smoke dispersion");
  }
  const candidateSignature = getSmokeLightCandidateSignature(lightCandidates);
  const cachedEntries = dispersedSmokeGeometryCache.get(entry.behavior) ?? [];
  const smokeRevision = getSmokeRegionRevision(canvas?.scene);
  const cached = cachedEntries.find(value => (
    value.smokeRevision === smokeRevision && value.candidateSignature === candidateSignature
  ));
  if (cached) return cached.geometry;
  let dispersedTree = polygonTree;
  for (const candidate of lightCandidates) {
    const shape = candidate.source?.shape;
    if (typeof shape?.toClipperPoints !== "function") {
      throw new Error(`LightSource ${candidate.source?.sourceId ?? "<unknown>"} has no native clipper polygon`);
    }
    const sourceBounds = shape.bounds ?? shape.getBounds?.();
    if (entry.bounds && sourceBounds && !boundsIntersect(entry.bounds, sourceBounds)) continue;
    dispersedTree = dispersedTree.intersectPolygon(shape, { clipType: difference });
    if (!dispersedTree?.polygons) {
      throw new Error("Native PolygonTree difference returned invalid smoke geometry");
    }
    if (!dispersedTree.polygons.length) break;
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
    if (typeof source?.testPoint !== "function") {
      throw new Error(`LightSource ${source?.sourceId ?? "<unknown>"} has no native point test`);
    }
    if (!source.testPoint(point)) continue;
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
  const targetActor = source.object?.actor ?? source.object?.document?.actor ?? null;
  const perceptionPercent = getActorSmokePerceptionPercent(targetActor);
  const densityAdjustment = perceptionPercent / 100;
  const cachedEntries = sourceConstraintCache.get(source) ?? [];
  const bounds = {
    x: x - radius,
    y: y - radius,
    width: radius * 2,
    height: radius * 2
  };
  const regionCandidates = getSmokeRegionsInBounds(bounds, {
    elevation,
    targetActor
  }).filter(requiresRayAttenuation);
  if (!regionCandidates.length) return null;
  const lightCandidates = getSmokeDispersionCandidates(bounds, { elevation });
  const relativeLightState = createRelativeSmokeLightCandidateState(lightCandidates, { x, y, elevation });
  const relativeSmokeState = createRelativeSmokeCandidateState(
    regionCandidates,
    { x, y, elevation }
  );
  const cached = cachedEntries.find(entry => entry.kind === "vision-los"
    && areRelativeSmokeCandidateStatesEqual(entry.relativeSmokeState, relativeSmokeState)
    && areRelativeSmokeLightCandidateStatesEqual(entry.relativeLightState, relativeLightState)
    && entry.radius === radius
    && entry.budget === budget
    && entry.targetActorUuid === (targetActor?.uuid ?? "")
    && entry.perceptionPercent === perceptionPercent);
  if (cached) return createTranslatedSmokePolygon(cached.relativePoints, x, y);
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
    relativeSmokeState,
    relativeLightState,
    radius,
    budget,
    targetActorUuid: targetActor?.uuid ?? "",
    perceptionPercent,
    relativePoints: getRelativeSmokePolygonPoints(constraint, x, y)
  });
  return constraint;
}

function createRelativeSmokeCandidateState(entries, origin) {
  return entries.map(entry => {
    const geometry = entry.geometry;
    const elevation = getAnimatedSmokeRegionElevationState(entry.region);
    return [
      entry.behavior?.uuid ?? entry.behavior?.id ?? "",
      Number(entry.smoke?.density),
      Number(entry.bounds?.x) - origin.x,
      Number(entry.bounds?.y) - origin.y,
      Number(entry.bounds?.width),
      Number(entry.bounds?.height),
      Number(geometry?.anchorX) - origin.x,
      Number(geometry?.anchorY) - origin.y,
      geometry?.localPoints ?? null,
      Number.isFinite(elevation.bottom) ? elevation.bottom - origin.elevation : null,
      Number.isFinite(elevation.top) ? elevation.top - origin.elevation : null,
      elevation.topInclusive,
      elevation.level
    ];
  }).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}

function areRelativeSmokeCandidateStatesEqual(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let candidateIndex = 0; candidateIndex < left.length; candidateIndex += 1) {
    const leftCandidate = left[candidateIndex];
    const rightCandidate = right[candidateIndex];
    if (!Array.isArray(leftCandidate) || !Array.isArray(rightCandidate)) return false;
    for (let fieldIndex = 0; fieldIndex < leftCandidate.length; fieldIndex += 1) {
      if (fieldIndex === 8) {
        if (!areExactSmokeNumberSequencesEqual(leftCandidate[fieldIndex], rightCandidate[fieldIndex])) return false;
      } else if (!Object.is(leftCandidate[fieldIndex], rightCandidate[fieldIndex])) return false;
    }
  }
  return true;
}

function createRelativeSmokeLightCandidateState(candidates, origin) {
  return candidates.map(candidate => {
    const source = candidate.source;
    return [
      source?.sourceId ?? "",
      Number(candidate.ranges?.relativeVersion),
      Number(source?.data?.x) - origin.x,
      Number(source?.data?.y) - origin.y,
      Number(source?.data?.elevation) - origin.elevation,
      candidate.planarDifference
    ];
  }).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}

function areRelativeSmokeLightCandidateStatesEqual(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let candidateIndex = 0; candidateIndex < left.length; candidateIndex += 1) {
    const leftCandidate = left[candidateIndex];
    const rightCandidate = right[candidateIndex];
    if (!Array.isArray(leftCandidate) || !Array.isArray(rightCandidate)
      || leftCandidate.length !== rightCandidate.length) return false;
    for (let fieldIndex = 0; fieldIndex < leftCandidate.length; fieldIndex += 1) {
      if (!Object.is(leftCandidate[fieldIndex], rightCandidate[fieldIndex])) return false;
    }
  }
  return true;
}

function areExactSmokeNumberSequencesEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

function getRelativeSmokePolygonPoints(polygon, x, y) {
  if (!polygon) return null;
  if (!Array.isArray(polygon.points)) throw new Error("Native smoke constraint returned no polygon points");
  return polygon.points.map((value, index) => Number(value) - (index % 2 ? y : x));
}

function createTranslatedSmokePolygon(relativePoints, x, y) {
  if (relativePoints === null) return null;
  if (!Array.isArray(relativePoints)) throw new Error("Cached smoke constraint has invalid relative points");
  return new PIXI.Polygon(relativePoints.map((value, index) => value + (index % 2 ? y : x)));
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
  const approximateVertexDensity = globalThis.PIXI?.Circle?.approximateVertexDensity;
  if (typeof approximateVertexDensity !== "function") {
    throw new Error("PIXI.Circle.approximateVertexDensity is required for radial smoke geometry");
  }
  const nativeDensity = Number(approximateVertexDensity.call(globalThis.PIXI.Circle, radius));
  if (!(Number.isFinite(nativeDensity) && nativeDensity > 0)) {
    throw new Error("PIXI.Circle.approximateVertexDensity returned invalid radial smoke geometry");
  }
  return Math.max(3, Math.ceil(nativeDensity));
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

function getBasicSightRadius(source, sourceRadius) {
  const document = source.object?.document;
  const modes = document?.detectionModes;
  const basicSight = modes?.get?.("basicSight")
    ?? modes?.basicSight
    ?? getDetectionModeValues(modes).find(mode => mode?.id === "basicSight");
  if (basicSight?.enabled === false) return null;
  const range = basicSight?.range;
  if (range === null || range === Infinity) return sourceRadius;
  if (!Number.isFinite(Number(range))) throw new Error("basicSight has an invalid native range");
  if (typeof source.object?.getLightRadius !== "function") {
    throw new Error(`VisionSource ${source?.sourceId ?? "<unknown>"} has no native range conversion`);
  }
  const radius = Number(source.object.getLightRadius(Math.max(0, Number(range))));
  if (!Number.isFinite(radius)) throw new Error("Token.getLightRadius returned an invalid basicSight radius");
  return Math.min(sourceRadius, Math.max(0, radius));
}

function getDetectionModeValues(modes) {
  if (!modes) return [];
  if (typeof modes[Symbol.iterator] === "function") return Array.from(modes);
  return typeof modes === "object" ? Object.values(modes) : [];
}

function patchSmokeDetectionRanges({ required = false } = {}) {
  patchBasicSightRange(CONFIG.Canvas?.detectionModes?.basicSight, { required });
  patchLightPerceptionRange(CONFIG.Canvas?.detectionModes?.lightPerception, { required });
  patchSpecialSenseSmokeLos({ required });
}

function patchBasicSightRange(mode, { required = false } = {}) {
  if (mode?._falloutMawSmokeRangePatched) return true;
  const original = mode?._testRange;
  if (typeof original !== "function") {
    if (required) throw new Error("Foundry basicSight range contract is required for smoke");
    return false;
  }
  mode._testRange = function smokeAwareRange(visionSource, detectionMode, target, test) {
    if (!original.call(this, visionSource, detectionMode, target, test)) return false;
    const maximumDistance = detectionMode.range === Infinity
      ? Infinity
      : visionSource.object.getLightRadius(detectionMode.range);
    const index = getSmokeRegionIndex(canvas?.scene);
    if (!hasRayAttenuationSmoke(index)) return true;
    const targetActor = visionSource.object?.actor ?? visionSource.object?.document?.actor ?? null;
    const origin = { x: visionSource.data.x, y: visionSource.data.y, elevation: visionSource.data.elevation };
    const rayElevation = getSmokeRayElevation(origin, test.point);
    const regionCandidates = getSmokeRegionsAlongRay(origin, test.point, {
      elevation: rayElevation,
      targetActor
    }).filter(requiresRayAttenuation);
    if (!regionCandidates.length) return true;
    const densityAdjustment = getActorSmokeDensityAdjustment(targetActor);
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
  return true;
}

function patchLightPerceptionRange(mode, { required = false } = {}) {
  if (mode?._falloutMawSmokeRangePatched) return true;
  const original = mode?._testRange;
  if (typeof original !== "function") {
    if (required) throw new Error("Foundry lightPerception range contract is required for smoke");
    return false;
  }
  mode._testRange = function smokeAwareLightPerceptionRange(visionSource, detectionMode, target, test) {
    if (!original.call(this, visionSource, detectionMode, target, test)) return false;
    const index = getSmokeRegionIndex(canvas?.scene);
    if (!isTokenVisibilityTarget(target) || !hasRayAttenuationSmoke(index)) return true;
    const targetActor = visionSource.object?.actor ?? visionSource.object?.document?.actor ?? null;
    const origin = {
      x: visionSource.data.x,
      y: visionSource.data.y,
      elevation: visionSource.data.elevation
    };
    const rayElevation = getSmokeRayElevation(origin, test.point);
    const regionCandidates = getSmokeRegionsAlongRay(origin, test.point, {
      elevation: rayElevation,
      targetActor
    }).filter(requiresRayAttenuation);
    if (!regionCandidates.length) return true;
    const densityAdjustment = getActorSmokeDensityAdjustment(targetActor);
    const measurement = measureSmokePath(origin, test.point, {
      elevation: rayElevation,
      chargeClearDistance: false,
      regionCandidates,
      useLightDispersion: true,
      densityAdjustment
    });
    if (!measurement.hasSmoke) return true;
    const sourceRadius = visionSource.radius || visionSource.data.externalRadius || canvas.dimensions?.maxR || 0;
    const maximumDistance = getBasicSightRadius(visionSource, sourceRadius);
    if (maximumDistance === null) return true;
    return maximumDistance === Infinity
      ? measurement.cost !== Infinity
      : measurement.cost <= maximumDistance + EPSILON;
  };
  Object.defineProperty(mode, "_falloutMawSmokeRangePatched", { value: true });
  return true;
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
function patchSpecialSenseSmokeLos({ required = false } = {}) {
  const DetectionMode = globalThis.foundry?.canvas?.perception?.DetectionMode;
  const defaultTestLos = DetectionMode?.prototype?._testLOS;
  if (typeof defaultTestLos !== "function" || typeof DetectionMode._testCollision !== "function") {
    if (required) throw new Error("Foundry DetectionMode LOS contracts are required for smoke");
    return false;
  }
  for (const [id, mode] of Object.entries(CONFIG.Canvas?.detectionModes ?? {})) {
    if (id === "basicSight" || id === "lightPerception" || !mode?.walls) continue;
    if (mode._falloutMawSmokeLosBypassPatched || mode._testLOS !== defaultTestLos) continue;
    mode._testLOS = function smokeBypassingSpecialSenseLos(visionSource, detectionMode, target, test) {
      const index = getSmokeRegionIndex(canvas?.scene);
      if (!index?.hasVisionSmoke) return defaultTestLos.call(this, visionSource, detectionMode, target, test);
      if (!visionSource?.los?.config) throw new Error("VisionSource has no native LOS collision configuration");
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
  return true;
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
    throw new Error(`Region ${region?.uuid ?? region?.id ?? "<unknown>"} has no native movement segmentizer`);
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
    ?? region.document?.polygonTree;
  if (!polygonTree || typeof polygonTree !== "object") {
    throw new Error(`Region ${region?.uuid ?? region?.id ?? "<unknown>"} has no native PolygonTree`);
  }
  if (!Array.isArray(polygonTree.polygons) || typeof polygonTree.testPoint !== "function") {
    throw new Error(`Region ${region?.uuid ?? region?.id ?? "<unknown>"} returned an invalid native PolygonTree`);
  }
  const cached = smokeGeometryByPolygonTree.get(polygonTree);
  if (cached) return cached;
  const polygons = polygonTree.polygons;
  const geometry = createSmokeGeometry(polygonTree, polygons);
  smokeGeometryByPolygonTree.set(polygonTree, geometry);
  return geometry;
}

function createSmokeGeometry(polygonTree, polygons) {
  const segments = [];
  let anchorX = Infinity;
  let anchorY = Infinity;
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
        anchorX = Math.min(anchorX, a.x, b.x);
        anchorY = Math.min(anchorY, a.y, b.y);
      }
      a = b;
    }
  }
  if (!Number.isFinite(anchorX)) anchorX = 0;
  if (!Number.isFinite(anchorY)) anchorY = 0;
  const localPoints = new Float64Array(segments.length * 4);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const offset = index * 4;
    localPoints[offset] = segment.a.x - anchorX;
    localPoints[offset + 1] = segment.a.y - anchorY;
    localPoints[offset + 2] = segment.b.x - anchorX;
    localPoints[offset + 3] = segment.b.y - anchorY;
  }
  return {
    polygonTree,
    polygons,
    segments,
    anchorX,
    anchorY,
    localPoints
  };
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
  const animatedElevation = region.object?.isAnimating ? region.object.animationState?.elevation : null;
  const regionElevation = animatedElevation ?? region.elevation ?? {};
  const bottom = regionElevation.bottom === null || regionElevation.bottom === undefined
    ? null
    : Number(regionElevation.bottom);
  const top = regionElevation.top === null || regionElevation.top === undefined
    ? null
    : Number(regionElevation.top);
  const topInclusive = regionElevation.topInclusive ?? region.elevation?.topInclusive;
  if (Number.isFinite(bottom) && elevation < bottom) return false;
  if (Number.isFinite(top) && elevation >= top && topInclusive !== true) return false;
  return true;
}

function getAnimatedSmokeRegionElevationState(region) {
  const regionObject = region?.object ?? region;
  const animatedElevation = regionObject?.isAnimating ? regionObject.animationState?.elevation : null;
  const elevation = animatedElevation ?? region?.elevation ?? {};
  return {
    bottom: toOptionalFiniteNumber(elevation.bottom),
    top: toOptionalFiniteNumber(elevation.top),
    topInclusive: (elevation.topInclusive ?? region?.elevation?.topInclusive) === true,
    level: regionObject?.animationState?.level?.id
      ?? region?.level?.id
      ?? region?.level
      ?? null
  };
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

/**
 * Foundry runs Token animation callbacks at OBJECTS + 1, then applies
 * Placeable render flags at OBJECTS and Perception flags later. Flushing at the
 * half-step keeps attached smoke in the same rendered frame while still
 * coalescing every Region moved by that animation tick.
 */
function attachSmokeAnimationTicker() {
  const ticker = globalThis.canvas?.app?.ticker;
  const objectPriority = Number(globalThis.PIXI?.UPDATE_PRIORITY?.OBJECTS);
  const perceptionPriority = Number(globalThis.PIXI?.UPDATE_PRIORITY?.PERCEPTION);
  if (
    !ticker?.add
    || !ticker?.remove
    || !Number.isFinite(objectPriority)
    || !Number.isFinite(perceptionPriority)
  ) {
    if (smokeAnimationTickerOwner && smokeAnimationTickerOwner !== ticker) detachSmokeAnimationTicker();
    return false;
  }
  if (
    smokeAnimationTickerOwner === ticker
    && smokeAnimationTicker
    && smokeAnimationCommitTicker
  ) return true;
  detachSmokeAnimationTicker();
  smokeAnimationTicker = flushAnimatedSmokeFrame;
  smokeAnimationCommitTicker = commitAnimatedSmokeFrame;
  smokeAnimationTickerOwner = ticker;
  ticker.add(smokeAnimationTicker, undefined, objectPriority + 0.5);
  ticker.add(smokeAnimationCommitTicker, undefined, perceptionPriority + 0.5);
  return true;
}

function detachSmokeAnimationTicker() {
  if (smokeAnimationTickerOwner) {
    try {
      if (smokeAnimationTicker) smokeAnimationTickerOwner.remove(smokeAnimationTicker);
      if (smokeAnimationCommitTicker) smokeAnimationTickerOwner.remove(smokeAnimationCommitTicker);
    } catch (_error) {
      // The owning Canvas may already have destroyed its ticker.
    }
  }
  smokeAnimationTicker = null;
  smokeAnimationCommitTicker = null;
  smokeAnimationTickerOwner = null;
}

function flushAnimatedSmokeFrame() {
  const scene = globalThis.canvas?.scene;
  const changes = scene && pendingSmokeAnimationChangesByScene.get(scene);
  if (!scene || !changes?.size || pendingSmokeAnimationCommitsByScene.has(scene)) return;
  try {
    pendingSmokeAnimationCommitsByScene.set(scene, refreshAnimatedSmokeSources(scene, changes));
    smokeAnimationFailureKeyByScene.delete(scene);
  } catch (error) {
    reportAnimatedSmokeFailure(scene, changes, error);
  }
}

function commitAnimatedSmokeFrame() {
  const scene = globalThis.canvas?.scene;
  let commit = scene && pendingSmokeAnimationCommitsByScene.get(scene);
  if (!scene || !commit) return true;
  const changes = pendingSmokeAnimationChangesByScene.get(scene);
  try {
    if (commit.awaitingNativeVisibility) {
      const refreshVisibility = canvas.visibility?.refresh;
      if (typeof refreshVisibility !== "function") {
        throw new Error("Foundry CanvasVisibility.refresh is required for shared-fog smoke retry");
      }
      commit.retryingNativeVisibility = true;
      commit.nativeVisibilityRetrySucceeded = false;
      try {
        refreshVisibility.call(canvas.visibility);
      } finally {
        commit.retryingNativeVisibility = false;
      }
      if (!commit.nativeVisibilityRetrySucceeded) return false;
      if (canvas.perception?.renderFlags?.has?.("refreshOcclusionMask") !== true) {
        const refreshOcclusionMask = canvas.masks?.occlusion?._updateOcclusionMask;
        if (typeof refreshOcclusionMask !== "function") {
          throw new Error("Foundry occlusion-mask refresh is required after shared-fog smoke retry");
        }
        refreshOcclusionMask.call(canvas.masks.occlusion);
      }
      finalizeAnimatedSmokeCommit(scene, commit);
      return true;
    }
    if (!isAnimatedSmokeCommitOwnershipCurrent(commit)) {
      pendingSmokeAnimationCommitsByScene.delete(scene);
      failedSmokeAnimationSourcesByScene.delete(scene);
      commit = refreshAnimatedSmokeSources(scene, changes);
      pendingSmokeAnimationCommitsByScene.set(scene, commit);
      if (!isAnimatedSmokeCommitOwnershipCurrent(commit)) {
        throw new Error("Attached smoke source ownership changed during exact transaction rebuild");
      }
    }
    if (!commitAnimatedSmokeRender(commit)) return false;
    finalizeAnimatedSmokeCommit(scene, commit);
    return true;
  } catch (error) {
    reportAnimatedSmokeFailure(scene, changes, error);
    return false;
  }
}

function finalizeAnimatedSmokeCommit(scene, commit) {
  if (pendingSmokeAnimationCommitsByScene.get(scene) !== commit) {
    throw new Error("Attached smoke attempted to finalize a stale native transaction");
  }
  const changes = pendingSmokeAnimationChangesByScene.get(scene);
  pendingSmokeAnimationCommitsByScene.delete(scene);
  pendingSmokeAnimationChangesByScene.delete(scene);
  failedSmokeAnimationSourcesByScene.delete(scene);
  smokeAnimationFailureKeyByScene.delete(scene);
  for (const [regionDocument, change] of changes ?? []) {
    smokeRegionAnimationTransforms.set(regionDocument, change.signature);
    const currentState = commit.currentStates.get(regionDocument);
    if (currentState) smokeRegionCommittedStates.set(
      regionDocument,
      cloneAnimatedSmokeRegionState(currentState)
    );
  }
}

function reportAnimatedSmokeFailure(scene, changes, error) {
  const failureKey = [...(changes ?? [])]
    .map(([regionDocument, change]) => `${regionDocument?.uuid ?? regionDocument?.id}:${change.signature}`)
    .sort()
    .join("|");
  if (smokeAnimationFailureKeyByScene.get(scene) === failureKey) return;
  smokeAnimationFailureKeyByScene.set(scene, failureKey);
  const onError = globalThis.Hooks?.onError;
  if (typeof onError !== "function") {
    throw new Error("Foundry Hooks.onError is required for the attached-smoke ticker boundary", { cause: error });
  }
  onError.call(globalThis.Hooks, `${SYSTEM_ID}.attachedSmokeAnimation`, error, {
    msg: "Exact attached-smoke animation transaction failed; the same transaction remains pending",
    log: "error",
    notify: "error",
    sceneId: scene?.id
  });
}

function refreshAnimatedSmokeSources(scene, changes) {
  const spatialUpdate = updateAnimatedSmokeRegionIndex(scene, changes);
  const { index, currentStates, densityZones, darknessZones, refreshDarknessTexture } = spatialUpdate;
  if (refreshDarknessTexture) {
    const invalidate = canvas.effects?.illumination?.invalidateDarknessLevelContainer;
    if (typeof invalidate !== "function") {
      throw new Error("Foundry darkness-level texture invalidation contract is required for attached smoke");
    }
    invalidate.call(canvas.effects.illumination, true);
  }

  const emptyCommit = {
    scene,
    currentStates,
    affectedLightingSources: [],
    affectedVisionSources: [],
    sharedFogTokens: [],
    sharedFogVersionsApplied: false,
    sourcesInitialized: false,
    globalVisionModeRefreshRequired: false,
    visionModeChanged: false,
    refreshDarknessTexture,
    lightingConsumerZones: darknessZones,
    transactionStates: new Map()
  };
  const retainedSources = failedSmokeAnimationSourcesByScene.get(scene);
  const carrierTokens = collectAnimatedSmokeCarrierTokens(changes);
  const failedCarrierSources = collectFailedNativeSmokeCarrierSources(carrierTokens);
  if (!densityZones.length && !retainedSources?.size && !refreshDarknessTexture && !failedCarrierSources.length) {
    return emptyCommit;
  }

  const allLightSources = getEffectSourceValuesWithRetained(scene, "lightSources", failedCarrierSources);
  const allVisionSources = getEffectSourceValuesWithRetained(scene, "visionSources", failedCarrierSources);
  const darknessSources = getEffectSourceValuesWithRetained(scene, "darknessSources", failedCarrierSources);
  const forcedSources = new Set(retainedSources?.keys?.() ?? []);
  for (const source of failedCarrierSources) forcedSources.add(source);
  const affectedLightingSources = [];
  const affectedLightingSourceSet = new Set();
  const changedEdgeDependencies = [];
  const changedSmokeLightInfluences = [];
  const changedSmokeLightSourceSet = new Set();

  const seedChangedSmokeLight = (source, influences) => {
    if (changedSmokeLightSourceSet.has(source)) return;
    changedSmokeLightSourceSet.add(source);
    for (const influence of influences) changedSmokeLightInfluences.push({ source, influence });
  };

  const edgeSources = [
    ...darknessSources,
    ...(darknessSources.length
      ? allLightSources.filter(source => getEffectSourcePriority(source) > 0)
      : [])
  ].sort(compareEffectSourcePriority);
  for (const source of edgeSources) {
    const influences = getAnimatedSmokeSourceInfluences(
      source,
      { vision: false, includeVisualPadding: true },
      carrierTokens
    );
    if (influences.every(influence => influence.radius <= 0) && !forcedSources.has(source)) continue;
    const directlyAffected = source.constructor?.__falloutMawSmokeLightSource
      && influences.some(influence => smokeZonesIntersectInfluence(densityZones, influence, source));
    const edgeAffected = influences.some(influence => (
      dependencyEdgesIntersectInfluence(changedEdgeDependencies, influence)
    ));
    const sourceRefreshRequired = forcedSources.has(source) || directlyAffected || edgeAffected;
    if (sourceRefreshRequired) {
      affectedLightingSources.push(source);
      affectedLightingSourceSet.add(source);
    }
    if (influences.length > 1 || sourceRefreshRequired) {
      for (const influence of influences) {
        changedEdgeDependencies.push({
          bounds: influence.bounds,
          influence,
          source,
          priority: getEmittedEffectEdgePriority(source, influence)
        });
      }
    }
  }

  for (const source of allLightSources) {
    const influences = getAnimatedSmokeSourceInfluences(source, { vision: false }, carrierTokens);
    if (source.constructor?.__falloutMawSmokeLightSource && influences.length > 1) {
      seedChangedSmokeLight(source, influences);
    }
    if (affectedLightingSourceSet.has(source)) continue;
    if (influences.every(influence => influence.radius <= 0) && !forcedSources.has(source)) continue;
    const directlyAffected = source.constructor?.__falloutMawSmokeLightSource
      && influences.some(influence => smokeZonesIntersectInfluence(densityZones, influence, source));
    if (
      !forcedSources.has(source)
      && !directlyAffected
      && !influences.some(influence => dependencyEdgesIntersectInfluence(changedEdgeDependencies, influence))
    ) continue;
    affectedLightingSources.push(source);
    affectedLightingSourceSet.add(source);
    if (source.constructor?.__falloutMawSmokeLightSource) {
      seedChangedSmokeLight(source, influences);
    }
  }

  const affectedVisionSources = [];
  for (const source of allVisionSources) {
    const influences = getAnimatedSmokeSourceInfluences(source, { vision: true }, carrierTokens);
    if (influences.every(influence => influence.radius <= 0) && !forcedSources.has(source)) continue;
    const directlyAffected = source.constructor?.__falloutMawSmokeVisionSource
      && influences.some(influence => smokeZonesIntersectInfluence(densityZones, influence, source));
    const edgeAffected = influences.some(influence => changedEdgeDependencies.some(dependency => (
      sourceInfluencesIntersect(dependency.influence, influence)
    )));
    const dispersedLightAffected = influences.some(influence => changedSmokeLightInfluences.some(candidate => (
      sourceInfluencesIntersect(candidate.influence, influence)
      && getSmokeLightInfluenceElevationState(candidate.influence, influence.elevation).reaches
    )));
    if (!forcedSources.has(source) && !directlyAffected && !edgeAffected && !dispersedLightAffected) continue;
    affectedVisionSources.push(source);
  }
  const sharedFogTokens = collectAffectedSharedFogVisionTokens({
    densityZones,
    edgeDependencies: changedEdgeDependencies,
    smokeLightInfluences: changedSmokeLightInfluences
  });

  const retainedTransaction = new Map();
  for (const source of [...affectedLightingSources, ...affectedVisionSources]) {
    const previous = retainedSources?.get(source);
    retainedTransaction.set(source, previous ?? captureSmokeSourceTransactionState(source));
  }
  if (retainedTransaction.size) failedSmokeAnimationSourcesByScene.set(scene, retainedTransaction);

  const lightingConsumerZones = [...darknessZones];
  for (const source of affectedLightingSources) {
    const influences = getAnimatedSmokeSourceInfluences(source, { vision: false }, carrierTokens);
    for (const influence of influences) lightingConsumerZones.push(createSmokeConsumerZone(influence));
  }
  for (const source of affectedVisionSources) {
    const influences = getAnimatedSmokeSourceInfluences(source, { vision: true }, carrierTokens);
    for (const influence of influences) lightingConsumerZones.push(createSmokeConsumerZone(influence));
  }

  return {
    scene,
    currentStates,
    affectedLightingSources,
    affectedVisionSources,
    sharedFogTokens,
    sharedFogVersionsApplied: false,
    sourcesInitialized: false,
    globalVisionModeRefreshRequired: false,
    visionModeChanged: false,
    refreshDarknessTexture,
    lightingConsumerZones,
    transactionStates: retainedTransaction
  };
}

function updateAnimatedSmokeRegionIndex(scene, changes) {
  const index = getSmokeRegionIndex(scene);
  const prepared = [];
  for (const [regionDocument, change] of changes) {
    const previousIndexState = index?.regionStates?.get(regionDocument);
    const entryIndexes = index?.regionEntryIndexes?.get(regionDocument);
    const oldState = cloneAnimatedSmokeRegionState(change?.oldState);
    const newBounds = cloneBounds(getRegionBounds(regionDocument));
    if (!oldState.known || !oldState.bounds || !previousIndexState?.count || !entryIndexes?.length || !newBounds) {
      throw new Error(`Attached smoke Region ${regionDocument?.uuid ?? regionDocument?.id ?? "<unknown>"}`
        + " has no exact old/new bounds");
    }
    const geometry = getSmokeRegionGeometry(regionDocument);
    if (!geometry?.polygonTree) {
      throw new Error(`Attached smoke Region ${regionDocument?.uuid ?? regionDocument?.id ?? "<unknown>"}`
        + " has no native PolygonTree");
    }
    const entries = entryIndexes.map(entryIndex => index.entries[entryIndex]);
    const currentState = {
      bounds: newBounds,
      cells: getBoundsCells(newBounds),
      count: entryIndexes.length,
      hasDensity: entries.some(entry => entry?.smoke?.density > EPSILON),
      hasThickness: entries.some(entry => entry?.smoke?.thickness > EPSILON),
      ...getAnimatedSmokeRegionElevationState(regionDocument)
    };
    prepared.push({ regionDocument, oldState, currentState, geometry, entryIndexes, entries, previousIndexState });
  }
  if (!prepared.length) {
    return {
      index,
      currentStates: new Map(),
      densityZones: [],
      darknessZones: [],
      refreshDarknessTexture: false
    };
  }

  const currentStates = new Map();
  const densityZones = [];
  const darknessZones = [];
  let refreshDarknessTexture = false;
  for (const preparedRegion of prepared) {
    const { regionDocument, oldState, currentState, geometry, entryIndexes, entries, previousIndexState } = preparedRegion;
    const entryIndexSet = new Set(entryIndexes);
    for (const cell of previousIndexState.cells ?? getBoundsCells(previousIndexState.bounds)) {
      const bucket = index.buckets.get(cell);
      if (!bucket) continue;
      const retained = bucket.filter(entryIndex => !entryIndexSet.has(entryIndex));
      if (retained.length) index.buckets.set(cell, retained);
      else index.buckets.delete(cell);
    }
    for (let entryOffset = 0; entryOffset < entries.length; entryOffset += 1) {
      entries[entryOffset].bounds = currentState.bounds;
      entries[entryOffset].geometry = geometry;
    }
    for (const cell of currentState.cells) {
      const bucket = index.buckets.get(cell) ?? [];
      bucket.push(...entryIndexes);
      index.buckets.set(cell, bucket);
    }
    index.regionStates.set(regionDocument, currentState);
    currentStates.set(regionDocument, currentState);
    if (oldState.hasDensity || currentState.hasDensity) {
      densityZones.push(
        { ...oldState, regionDocument, entries },
        { ...currentState, regionDocument, entries }
      );
    }
    if (oldState.hasThickness || currentState.hasThickness) {
      darknessZones.push(createSmokeConsumerZone(oldState), createSmokeConsumerZone(currentState));
      refreshDarknessTexture = true;
    }
  }
  const revision = (smokeRevisionByScene.get(scene) ?? index.revision ?? 0) + 1;
  smokeRevisionByScene.set(scene, revision);
  index.revision = revision;
  for (const { regionDocument } of prepared) {
    globalThis.Hooks?.callAll?.(`${SYSTEM_ID}.smokeRegionAnimation`, regionDocument, { revision });
  }
  return { index, currentStates, densityZones, darknessZones, refreshDarknessTexture };
}

function getEffectSourceValuesWithRetained(scene, collectionName, failedCarrierSources) {
  const collection = canvas.effects?.[collectionName];
  if (!collection) throw new Error(`Foundry effects.${collectionName} is required for attached smoke`);
  const currentSources = getEffectSourceValues(collection);
  const retained = failedSmokeAnimationSourcesByScene.get(scene);
  let hasRetainedCollection = failedCarrierSources.some(
    source => source?.constructor?.effectsCollection === collectionName
  );
  if (retained) {
    for (const state of retained.values()) {
      if (state.collectionName !== collectionName) continue;
      hasRetainedCollection = true;
      break;
    }
  }
  if (!hasRetainedCollection) return currentSources;
  const sources = [...currentSources];
  const seen = new Set(sources);
  const seenSourceIds = new Set(sources.map(source => source?.sourceId));
  const appendExactSource = (source, sourceId) => {
    if (seen.has(source)) return;
    if (seenSourceIds.has(sourceId)) {
      throw new Error(`Native source identity collision for ${sourceId}`);
    }
    sources.push(source);
    seen.add(source);
    seenSourceIds.add(sourceId);
  };
  for (const [source, state] of retained ?? []) {
    if (
      state.collectionName !== collectionName
    ) continue;
    appendExactSource(source, state.sourceId);
  }
  for (const source of failedCarrierSources) {
    if (source?.constructor?.effectsCollection !== collectionName) continue;
    appendExactSource(source, source.sourceId);
  }
  return sources;
}

function captureSmokeSourceTransactionState(source) {
  const collectionName = source?.constructor?.effectsCollection;
  const collection = canvas.effects?.[collectionName];
  if (!collectionName || !collection || typeof source?.initialize !== "function") {
    throw new Error(`Invalid native effect source ${source?.sourceId ?? source?.constructor?.name ?? "<unknown>"}`);
  }
  return {
    collectionName,
    sourceId: source.sourceId,
    updateId: Number(source.updateId),
    active: source.active,
    suppressed: source.suppressed,
    visionMode: source.visionMode,
    preferred: source.preferred,
    edgeState: captureEffectSourceEdgeState(source)
  };
}

function initializeExactSmokeSource(source) {
  const collectionName = source?.constructor?.effectsCollection;
  const collection = canvas.effects?.[collectionName];
  const sourceId = source?.sourceId;
  const updateId = Number(source?.updateId);
  if (
    !collectionName
    || !collection
    || !sourceId
    || !Number.isInteger(updateId)
    || typeof source.initialize !== "function"
  ) {
    throw new Error(`Invalid native source lifecycle for ${sourceId ?? source?.constructor?.name ?? "<unknown>"}`);
  }
  const occupyingSource = collection.get?.(sourceId);
  if (occupyingSource && occupyingSource !== source) {
    throw new Error(`Native source ${sourceId} was replaced before exact initialization`);
  }
  const wasAttached = source.attached === true && occupyingSource === source;
  source.initialize();
  if (Number(source.updateId) !== updateId + 1 || !source.shape) {
    throw new Error(`Native source ${sourceId} did not complete exact shape initialization`);
  }
  if (!wasAttached) {
    if (!isEffectSourceAuthoritativelyOwned(source)) {
      throw new Error(`Native source ${sourceId} is no longer owned by its Canvas object`);
    }
    const reentrantOccupyingSource = collection.get?.(sourceId);
    if (reentrantOccupyingSource && reentrantOccupyingSource !== source) {
      throw new Error(`Native source ${sourceId} was replaced before exact reattachment`);
    }
    if (typeof source.add !== "function") throw new Error(`Native source ${sourceId} cannot reattach after exact retry`);
    source.add();
  }
  if (source.attached !== true || collection.get?.(sourceId) !== source) {
    throw new Error(`Native source ${sourceId} left effects.${collectionName} during exact initialization`);
  }
}

function isEffectSourceAuthoritativelyOwned(source) {
  const object = source?.object;
  if (!object) return false;
  return object.lightSource === source
    || object.source === source
    || object.light === source
    || object.vision === source;
}

function isAnimatedSmokeCommitOwnershipCurrent(commit) {
  for (const [source, state] of commit.transactionStates) {
    const collection = canvas.effects?.[state.collectionName];
    if (!collection || typeof collection.get !== "function") return false;
    const current = collection.get(state.sourceId);
    if (current && current !== source) return false;
    if (!current && !isEffectSourceAuthoritativelyOwned(source)) return false;
  }
  return true;
}

function initializeAnimatedSmokeCommitSources(commit) {
  if (commit.sourcesInitialized) return;
  const orderedSources = [
    ...commit.affectedLightingSources,
    ...commit.affectedVisionSources
  ];
  for (const source of orderedSources) {
    const before = commit.transactionStates.get(source);
    const currentUpdateId = Number(source.updateId);
    if (!before || !Number.isSafeInteger(before.updateId) || !Number.isSafeInteger(currentUpdateId)) {
      throw new Error(`Invalid exact source transaction for ${source?.sourceId ?? "<unknown>"}`);
    }
    if (currentUpdateId === before.updateId) {
      initializeExactSmokeSource(source);
      continue;
    }
    if (currentUpdateId < before.updateId || !source.shape) {
      throw new Error(`Native source ${source.sourceId} has an invalid post-OBJECTS shape state`);
    }
    const collectionName = source.constructor?.effectsCollection;
    const collection = canvas.effects?.[collectionName];
    if (source.attached !== true || collection?.get?.(source.sourceId) !== source) {
      throw new Error(`Native source ${source.sourceId} did not remain attached after its OBJECTS refresh`);
    }
  }
  let visionModeChanged = false;
  for (const source of commit.affectedVisionSources) {
    const before = commit.transactionStates.get(source);
    visionModeChanged ||= source.active !== before.active
      || source.visionMode !== before.visionMode
      || source.preferred !== before.preferred;
  }
  commit.visionModeChanged = visionModeChanged;
  commit.sourcesInitialized = true;
}

function captureEffectSourceEdgeState(source) {
  const edges = source?.edges;
  if (edges === undefined) return null;
  if (!Array.isArray(edges)) {
    throw new Error(`Native source ${source?.sourceId ?? "<unknown>"} has an invalid edge collection`);
  }
  const state = new Float64Array(edges.length * 5);
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    const offset = index * 5;
    state[offset] = Number(edge?.a?.x);
    state[offset + 1] = Number(edge?.a?.y);
    state[offset + 2] = Number(edge?.b?.x);
    state[offset + 3] = Number(edge?.b?.y);
    state[offset + 4] = Number(edge?.priority);
  }
  return state;
}

function areEffectSourceEdgeStatesEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

function smokeZonesIntersectInfluence(zones, influence, source, { vision = false } = {}) {
  const targetActor = (vision || source?.constructor?.effectsCollection === "visionSources")
    ? source?.object?.actor ?? source?.object?.document?.actor ?? null
    : null;
  return zones.some(zone => {
    if (!boundsIntersectCircle(zone.bounds, influence.x, influence.y, influence.radius)) return false;
    if (!isAnimatedSmokeStateOnElevation(zone, influence.elevation)) return false;
    if (!targetActor) return true;
    return zone.entries.some(entry => (
      entry?.smoke?.density > EPSILON
      && regionBehaviorTargetsActor(entry.region, entry.behavior, targetActor)
    ));
  });
}

function isAnimatedSmokeStateOnElevation(state, elevation) {
  if (!Number.isFinite(Number(elevation))) return true;
  const value = Number(elevation);
  if (Number.isFinite(state.bottom) && value < state.bottom) return false;
  if (Number.isFinite(state.top) && value >= state.top && state.topInclusive !== true) return false;
  return true;
}

function dependencyEdgesIntersectInfluence(dependencies, influence) {
  const sourcePriority = Number(influence?.priority) || 0;
  return dependencies.some(dependency => (
    dependency.priority >= sourcePriority
    && sourceInfluencesIntersect(dependency.influence, influence)
  ));
}

function getEmittedEffectEdgePriority(source, influence) {
  const priority = Number(influence?.priority) || 0;
  return source?.constructor?.effectsCollection === "darknessSources" ? priority : priority - 0.5;
}

function commitAnimatedSmokeRender(commit) {
  initializeAnimatedSmokeCommitSources(commit);
  const {
    scene,
    affectedLightingSources,
    affectedVisionSources,
    sharedFogTokens,
    visionModeChanged,
    refreshDarknessTexture,
    lightingConsumerZones,
    transactionStates
  } = commit;
  const changedConstraintTypes = new Set();
  for (const source of affectedLightingSources) {
    const before = transactionStates.get(source);
    if (areEffectSourceEdgeStatesEqual(before?.edgeState, captureEffectSourceEdgeState(source))) continue;
    if (source.constructor?.effectsCollection === "darknessSources") {
      changedConstraintTypes.add("light");
      changedConstraintTypes.add("sight");
    } else if (getEffectSourcePriority(source) > 0) changedConstraintTypes.add("darkness");
  }
  if (changedConstraintTypes.size) {
    updateAffectedRegionShapeConstraints(scene, changedConstraintTypes, lightingConsumerZones);
  }

  const perceptionFlags = canvas.perception?.renderFlags;
  const hasPendingFlag = flag => perceptionFlags?.has?.(flag) === true;
  const nativeLightingCommit = hasPendingFlag("refreshLighting") || hasPendingFlag("initializeLightSources");
  const nativeVisionCommit = hasPendingFlag("refreshVision");
  const nativeVisionSourceRefresh = hasPendingFlag("refreshVisionSources");
  const nativeVisionModeCommit = hasPendingFlag("initializeVisionModes");

  let globalVisionModeChanged = commit.globalVisionModeRefreshRequired;
  if (visionModeChanged && !nativeVisionModeCommit) {
    const initializeVisionMode = canvas.visibility?.initializeVisionMode;
    if (typeof initializeVisionMode !== "function") {
      throw new Error("Foundry CanvasVisibility.initializeVisionMode is required for smoke vision-mode changes");
    }
    const previousOptions = canvas.visibility.visionModeData?.activeLightingOptions;
    const previousLightingVisibility = captureSmokeLightingVisibilityState(canvas.visibility);
    initializeVisionMode.call(canvas.visibility);
    const lightingVisibilityChanged = !areSmokeLightingVisibilityStatesEqual(
      previousLightingVisibility,
      captureSmokeLightingVisibilityState(canvas.visibility)
    );
    if (previousOptions !== canvas.visibility.visionModeData?.activeLightingOptions || lightingVisibilityChanged) {
      commit.globalVisionModeRefreshRequired = true;
      globalVisionModeChanged = true;
    }
    const refreshPrimary = canvas.primary?.refreshPrimarySpriteMesh;
    if (typeof refreshPrimary !== "function") {
      throw new Error("Foundry PrimaryCanvasGroup.refreshPrimarySpriteMesh is required for smoke vision-mode changes");
    }
    refreshPrimary.call(canvas.primary);
  }

  if (!nativeLightingCommit) {
    const lightingSources = globalVisionModeChanged
      ? [
          ...getEffectSourceValues(canvas.effects.darknessSources),
          ...getEffectSourceValues(canvas.effects.lightSources)
        ]
      : affectedLightingSources;
    for (const source of lightingSources) {
      source.refresh();
      reconcileSmokeSourceMeshes(source, { vision: false });
      refreshAffectedAmbientLightField(source);
    }
  }
  for (const source of affectedVisionSources) {
    if (!nativeLightingCommit || !nativeVisionSourceRefresh) source.refresh();
    if (!nativeLightingCommit) reconcileSmokeSourceMeshes(source, { vision: true });
  }
  const emitsLightingRefresh = !nativeLightingCommit
    && Boolean(
      refreshDarknessTexture
      || affectedLightingSources.length
      || affectedVisionSources.length
      || globalVisionModeChanged
    );
  const requiresVisibility = affectedLightingSources.length
    || affectedVisionSources.length
    || sharedFogTokens.length
    || visionModeChanged;
  if (transactionStates.size || sharedFogTokens.length || visionModeChanged || refreshDarknessTexture) {
    notifySmokeNativePerceptionRefresh({
      scene,
      revision: peekSmokeRegionRevision(scene),
      sources: [...transactionStates.keys()].map(source => ({
        source,
        collectionName: source.constructor?.effectsCollection,
        sourceId: source.sourceId,
        updateId: Number(source.updateId),
        active: Boolean(source.active),
        suppressed: Boolean(source.suppressed)
      })),
      expectLighting: Boolean(
        refreshDarknessTexture
        || affectedLightingSources.length
        || affectedVisionSources.length
        || globalVisionModeChanged
      ),
      expectSight: Boolean(requiresVisibility)
    });
  }
  if (emitsLightingRefresh) {
    if (affectedLightingSources.length || affectedVisionSources.length || globalVisionModeChanged) {
      updateSelectiveEffectsContainerState();
    }
    globalThis.Hooks?.callAll?.("lightingRefresh", canvas.effects, {
      source: SYSTEM_ID,
      smokeRevision: peekSmokeRegionRevision(scene),
      smokeSelective: !globalVisionModeChanged && lightingConsumerZones.length > 0,
      smokeZones: lightingConsumerZones
    });
  }

  if (!commit.sharedFogVersionsApplied) {
    for (const token of sharedFogTokens) {
      if (!Number.isSafeInteger(token._visionSourceVersion)
        || token._visionSourceVersion >= Number.MAX_SAFE_INTEGER) {
        throw new Error(`Shared-fog Token ${token.id ?? "<unknown>"} has an invalid native vision version`);
      }
    }
    for (const token of sharedFogTokens) {
      token._visionSourceVersion += 1;
    }
    commit.sharedFogVersionsApplied = true;
  }
  if (sharedFogTokens.length && nativeVisionCommit) {
    commit.awaitingNativeVisibility = true;
    return false;
  }
  if (requiresVisibility && !nativeVisionCommit) {
    const refreshVisibility = canvas.visibility?.refresh;
    if (typeof refreshVisibility !== "function") {
      throw new Error("Foundry CanvasVisibility.refresh is required for attached smoke");
    }
    strictSmokeVisionInitializationDepth += 1;
    try {
      refreshVisibility.call(canvas.visibility);
    } finally {
      strictSmokeVisionInitializationDepth -= 1;
    }
  }
  if (requiresVisibility && !hasPendingFlag("refreshOcclusionMask")) {
    const refreshOcclusionMask = canvas.masks?.occlusion?._updateOcclusionMask;
    if (typeof refreshOcclusionMask !== "function") {
      throw new Error("Foundry occlusion-mask refresh is required for attached smoke");
    }
    refreshOcclusionMask.call(canvas.masks.occlusion);
  }
  return true;
}

function updateAffectedRegionShapeConstraints(scene, types, zones) {
  const updateConstraint = scene?._updateRegionShapeConstraints;
  const regions = scene?.regions;
  if (typeof updateConstraint !== "function" || typeof regions?.values !== "function") {
    throw new Error("Foundry selective Region shape-constraint contract is required for source-edge smoke changes");
  }
  if (!zones.length) {
    throw new Error("Source-edge smoke change has no exact old/current influence zone");
  }
  for (const region of regions.values()) {
    if (!region?.restriction?.enabled || !types.has(region.restriction.type)) continue;
    const bounds = getRegionBounds(region);
    if (!bounds) {
      throw new Error(`Restricted Region ${region?.uuid ?? region?.id ?? "<unknown>"} has no native bounds`);
    }
    if (!zones.some(zone => boundsIntersect(zone, bounds))) continue;
    updateConstraint.call(scene, region);
  }
}

function captureSmokeLightingVisibilityState(visibility) {
  const state = visibility?.lightingVisibility;
  if (!state || typeof state !== "object") {
    throw new Error("Foundry CanvasVisibility.lightingVisibility is required for smoke vision-mode changes");
  }
  return [
    state.background,
    state.illumination,
    state.coloration,
    state.darkness,
    state.any
  ];
}

function areSmokeLightingVisibilityStatesEqual(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

function reconcileSmokeSourceMeshes(source, { vision }) {
  if (typeof source?.drawMeshes !== "function" || !source.layers) {
    throw new Error(`Native rendered source ${source?.sourceId ?? "<unknown>"} has no mesh contract`);
  }
  const meshes = source.active && (!vision || source.radius > 0) ? source.drawMeshes() : {};
  const targets = vision
    ? {
        background: source.preferred ? canvas.effects.background.visionPreferred : canvas.effects.background.vision,
        illumination: canvas.effects.illumination.lights,
        coloration: canvas.effects.coloration
      }
    : {
        background: canvas.effects.background.lighting,
        illumination: canvas.effects.illumination.lights,
        coloration: canvas.effects.coloration,
        darkness: canvas.effects.darkness
      };
  for (const [layerId, layer] of Object.entries(source.layers)) {
    const mesh = layer?.mesh;
    if (!mesh) continue;
    const target = meshes?.[layerId] ? targets[layerId] : null;
    if (target && typeof target.addChild !== "function") {
      throw new Error(`Foundry effects container for ${layerId} is unavailable`);
    }
    if (target) {
      if (mesh.parent !== target) target.addChild(mesh);
    } else if (mesh.parent) {
      if (typeof mesh.parent.removeChild !== "function") {
        throw new Error(`Native mesh parent for ${source.sourceId}.${layerId} cannot detach`);
      }
      mesh.parent.removeChild(mesh);
    }
  }
}

function refreshAffectedAmbientLightField(source) {
  if (source?.object?.document?.documentName !== "AmbientLight") return;
  const renderFlags = source.object.renderFlags;
  if (typeof renderFlags?.set !== "function") {
    throw new Error(`AmbientLight ${source.sourceId} has no native render flags`);
  }
  renderFlags.set({ refreshField: true });
}

function updateSelectiveEffectsContainerState() {
  const effects = canvas.effects;
  const background = effects?.background;
  const illumination = effects?.illumination;
  const coloration = effects?.coloration;
  if (!background?.vision || !background?.visionPreferred || !background?.lighting || !illumination || !coloration) {
    throw new Error("Foundry effects rendering containers are required for attached smoke");
  }
  background.vision.filter.enabled = background.vision.children.length > 0;
  background.visionPreferred.filter.enabled = background.visionPreferred.children.length > 0;
  background.vision.visible = background.vision.children.length > 0;
  background.visionPreferred.visible = background.visionPreferred.children.length > 0;
  const lightingOptions = canvas.visibility?.visionModeData?.activeLightingOptions ?? {};
  background.lighting.visible = background.lighting.children.length > 0
    || (lightingOptions.background?.postProcessingModes?.length > 0);
  coloration.visible = coloration.children.length > 1
    || (lightingOptions.coloration?.postProcessingModes?.length > 0);
}

function getEffectSourceValues(collection) {
  if (!collection || typeof collection.values !== "function" || !Number.isSafeInteger(collection.size)) {
    throw new Error("Foundry effect-source Collection contract is required for attached smoke");
  }
  return Array.from(collection.values());
}

function compareEffectSourcePriority(left, right) {
  const priorityDelta = getEffectSourcePriority(right) - getEffectSourcePriority(left);
  if (priorityDelta) return priorityDelta;
  const leftDarkness = left?.constructor?.effectsCollection === "darknessSources" ? 1 : 0;
  const rightDarkness = right?.constructor?.effectsCollection === "darknessSources" ? 1 : 0;
  return rightDarkness - leftDarkness;
}

function getEffectSourcePriority(source) {
  return Number(source?.priority ?? source?.data?.priority) || 0;
}

function requireSourceInfluenceBounds(source, options) {
  const influence = getSourceInfluenceBounds(source, options);
  if (influence) return influence;
  throw new Error(`Active smoke source ${source?.sourceId ?? source?.constructor?.name ?? "<unknown>"}`
    + " has invalid native influence data");
}

function collectAffectedSharedFogVisionTokens({
  densityZones,
  edgeDependencies,
  smokeLightInfluences
}) {
  if (canvas.fog?.sharedExploration !== true) return [];
  const placeables = canvas.tokens?.placeables;
  if (!Array.isArray(placeables)) {
    throw new Error("Foundry TokenLayer.placeables is required for shared-fog smoke refresh");
  }
  const tokens = [];
  for (const token of placeables) {
    if (typeof token?._isFogExplorationSource !== "function") {
      throw new Error(`Shared-fog Token ${token?.id ?? "<unknown>"} has no native exploration-source contract`);
    }
    if (!token._isFogExplorationSource()) continue;
    if (typeof token._getVisionSourceData !== "function") {
      throw new Error(`Shared-fog Token ${token.id ?? "<unknown>"} has no native vision data contract`);
    }
    const data = token._getVisionSourceData();
    if (!data) throw new Error(`Shared-fog Token ${token.id ?? "<unknown>"} returned no vision data`);
    const sharedSource = {
      sourceId: `${token.sourceId ?? token.id}.shared`,
      object: token,
      data,
      radius: data.radius,
      lightRadius: data.lightRadius
    };
    const influence = requireSourceInfluenceBounds(sharedSource, { vision: true });
    if (influence.radius <= 0) continue;
    const directlyAffected = smokeZonesIntersectInfluence(
      densityZones,
      influence,
      sharedSource,
      { vision: true }
    );
    const edgeAffected = edgeDependencies.some(dependency => (
      sourceInfluencesIntersect(dependency.influence, influence)
    ));
    const dispersedLightAffected = smokeLightInfluences.some(candidate => (
      sourceInfluencesIntersect(candidate.influence, influence)
      && getSmokeLightInfluenceElevationState(candidate.influence, influence.elevation).reaches
    ));
    if (!directlyAffected && !edgeAffected && !dispersedLightAffected) continue;
    tokens.push(token);
  }
  return tokens;
}

function sourceInfluencesIntersect(left, right) {
  if (!left || !right) return false;
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const radius = left.radius + right.radius;
  return ((dx * dx) + (dy * dy)) <= (radius * radius);
}

function getSourceInfluenceBounds(source, { vision = false, includeVisualPadding = false } = {}) {
  const x = Number(source?.data?.x ?? source?.x);
  const y = Number(source?.data?.y ?? source?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Match the radii used by our two smoke wrappers exactly. A VisionSource's
  // unrestricted native LOS commonly has canvas.maxR, so using los.config here
  // would turn the selective path back into an all-source rebuild.
  const radii = vision
    ? [source?.lightRadius, source?.radius, source?.data?.externalRadius]
    : [
        source?.radius,
        source?.data?.radius,
        Math.abs(Number(source?.data?.bright) || 0),
        Math.abs(Number(source?.data?.dim) || 0)
      ];
  if (includeVisualPadding) {
    radii.push(source?._visualShape?.config?.radius, source?.shape?.config?.radius);
  }
  let radius = Math.max(0, ...radii.map(value => Number(value)).filter(Number.isFinite));
  if (radii.some(value => Number(value) === Infinity)) {
    radius = Number(canvas.dimensions?.maxR);
    if (!Number.isFinite(radius) || radius <= 0) return null;
  }
  return {
    x,
    y,
    radius,
    elevation: Number(source?.data?.elevation),
    priority: getEffectSourcePriority(source),
    verticalRadius: Math.max(0, Number(source?.radius ?? source?.data?.radius) || 0),
    level: source?.data?.level ?? source?.level?.id ?? null,
    bounds: { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 }
  };
}

function captureAnimatedSmokeSourceTransition(source, { vision }) {
  const owner = source?.object;
  const tickerTime = Number(globalThis.canvas?.app?.ticker?.lastTime);
  const collectionName = source?.constructor?.effectsCollection;
  if (!owner || !Number.isFinite(tickerTime)
    || !["lightSources", "darknessSources", "visionSources"].includes(collectionName)) return null;
  return {
    owner,
    tickerTime,
    collectionName,
    sourceId: source.sourceId,
    baseInfluence: getSourceInfluenceBounds(source, { vision }),
    paddedInfluence: vision
      ? null
      : getSourceInfluenceBounds(source, { vision: false, includeVisualPadding: true })
  };
}

function recordAnimatedSmokeSourceInitialization(source, transition, previousUpdateId) {
  const updateId = Number(source?.updateId);
  if (Number.isSafeInteger(previousUpdateId) && updateId === previousUpdateId + 1 && source.shape) {
    failedNativeSmokeSources.delete(source);
    recordAnimatedSmokeSourceTransition(source, transition, previousUpdateId);
    return;
  }
  if (!isEffectSourceAuthoritativelyOwned(source)) return;
  const collectionName = source?.constructor?.effectsCollection;
  if (!["lightSources", "darknessSources", "visionSources"].includes(collectionName)) return;
  failedNativeSmokeSources.set(source, {
    ...transition,
    owner: source.object,
    collectionName,
    sourceId: source.sourceId,
    updateId,
    baseInfluence: transition?.baseInfluence ?? getSourceInfluenceBounds(source, {
      vision: collectionName === "visionSources"
    }),
    paddedInfluence: transition?.paddedInfluence ?? (collectionName === "visionSources"
      ? null
      : getSourceInfluenceBounds(source, { vision: false, includeVisualPadding: true }))
  });
}

function recordAnimatedSmokeSourceTransition(source, transition, previousUpdateId) {
  if (!transition) return;
  const updateId = Number(source?.updateId);
  if (!Number.isSafeInteger(previousUpdateId) || updateId !== previousUpdateId + 1 || !source.shape) return;
  const existing = animatedSmokeSourceTransitions.get(source);
  const continuesSameFrame = existing
    && existing.tickerTime === transition.tickerTime
    && existing.owner === transition.owner
    && existing.collectionName === transition.collectionName
    && existing.sourceId === transition.sourceId
    && existing.updateId === previousUpdateId;
  animatedSmokeSourceTransitions.set(source, {
    ...(continuesSameFrame ? existing : transition),
    updateId
  });
}

function collectAnimatedSmokeCarrierTokens(changes) {
  const carriers = new Set();
  for (const [regionDocument] of changes ?? []) {
    const token = regionDocument?.attachment?.token;
    if (!token) continue;
    carriers.add(token);
    if (token.object) carriers.add(token.object);
    if (token.document) carriers.add(token.document);
  }
  return carriers;
}

function collectFailedNativeSmokeCarrierSources(carrierTokens) {
  const sources = [];
  for (const [source, failure] of failedNativeSmokeSources) {
    if (!isEffectSourceAuthoritativelyOwned(source)) {
      failedNativeSmokeSources.delete(source);
      continue;
    }
    if (carrierTokens.has(failure.owner)) sources.push(source);
  }
  return sources;
}

function getAnimatedSmokeSourceInfluences(source, options, carrierTokens) {
  const current = requireSourceInfluenceBounds(source, options);
  const transition = animatedSmokeSourceTransitions.get(source) ?? failedNativeSmokeSources.get(source);
  const tickerTime = Number(globalThis.canvas?.app?.ticker?.lastTime);
  if (!transition
    || transition.tickerTime !== tickerTime
    || !carrierTokens.has(transition.owner)
    || transition.collectionName !== source?.constructor?.effectsCollection
    || transition.sourceId !== source.sourceId
    || transition.updateId !== Number(source.updateId)) return [current];
  const previous = options?.includeVisualPadding ? transition.paddedInfluence : transition.baseInfluence;
  return previous ? [previous, current] : [current];
}

function createSmokeConsumerZone(state) {
  const bounds = state?.bounds ?? state;
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) {
    throw new Error("Attached smoke produced an invalid selective lighting zone");
  }
  return {
    x,
    y,
    width,
    height,
    bottom: Number.isFinite(state?.bottom) ? state.bottom : null,
    top: Number.isFinite(state?.top) ? state.top : null,
    topInclusive: state?.topInclusive === true
  };
}

function cloneBounds(bounds) {
  if (!bounds) return null;
  return {
    x: Number(bounds.x) || 0,
    y: Number(bounds.y) || 0,
    width: Math.max(0, Number(bounds.width) || 0),
    height: Math.max(0, Number(bounds.height) || 0)
  };
}

function unionBounds(boundsList) {
  if (!boundsList?.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const bounds of boundsList) {
    if (!bounds) continue;
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (![x, y, width, height].every(Number.isFinite)) continue;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + Math.max(0, width));
    bottom = Math.max(bottom, y + Math.max(0, height));
  }
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
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
    throw new Error("Foundry smoke Region rendering contracts are unavailable");
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
    if (sourceGeometryChanged) notifySmokeNativePerceptionRefresh();
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
