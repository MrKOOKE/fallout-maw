import { createPhysicalLosTransitionCache, testObserverVisibilityBatch } from "../canvas/physical-los.mjs";
import { withSystemEventRoot } from "./dispatcher.mjs";
import {
  eventReactionIndexHasAny,
  getEventReactionSubscriptionIndex,
  VISION_EVENT_REACTION_KEYS
} from "./event-reaction-index.mjs";

const TOKEN_VISION_PATHS = [
  "x", "y", "elevation", "width", "height", "hidden", "sight", "detectionModes", "texture.scaleX", "texture.scaleY"
];
const ACTOR_VISION_PATHS = ["statuses", "system.statuses", "system.conditions", "system.vision"];
const SCENE_VISION_PATHS = ["darkness", "environment", "globalLight", "tokenVision"];
const VISION_STATUS_IDS = new Set(["blind", "blinded", "burrow", "ethereal", "invisible"]);

let hooksRegistered = false;
let worldReady = false;
let transitionSequence = 0;
const pendingVisionTransitions = new Map();

const physicalLosCache = createPhysicalLosTransitionCache({
  collectSceneTokens,
  testObserverBatch: (observerToken, targetTokens) => testObserverVisibilityBatch(observerToken, targetTokens),
  emit: emitVisionTransition
});

export function registerFoundryVisionSystemEventHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("canvasReady", () => onCanvasReady());
  Hooks.on("canvasTearDown", () => resetVisionScene(null));
  Hooks.on("moveToken", token => invalidateToken(token));
  Hooks.on("createToken", token => invalidateToken(token, { silent: true }));
  Hooks.on("deleteToken", token => removeToken(token));
  Hooks.on("updateToken", (token, changes) => {
    if (hasAnyPath(changes, TOKEN_VISION_PATHS)) invalidateToken(token);
  });
  for (const documentName of ["Wall", "AmbientLight"]) {
    Hooks.on(`create${documentName}`, document => invalidateSceneFull(document?.parent));
    Hooks.on(`update${documentName}`, document => invalidateSceneFull(document?.parent));
    Hooks.on(`delete${documentName}`, document => invalidateSceneFull(document?.parent));
  }
  Hooks.on("updateScene", (scene, changes) => {
    if (hasAnyPath(changes, SCENE_VISION_PATHS)) invalidateSceneFull(scene);
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (hasAnyPath(changes, ACTOR_VISION_PATHS)) invalidateActorTokens(actor);
  });
  for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(hook, effect => {
      if (!effectAffectsPhysicalVision(effect)) return;
      invalidateActorTokens(effect?.parent);
    });
  }
}

/**
 * Arm tracking after world startup. Does not seed O(n²) pairs — work runs only when
 * vision Event Reaction subscribers exist on the active scene.
 */
export async function armFoundryVisionTracking() {
  worldReady = true;
  const demanded = await eventReactionIndexHasAny(VISION_EVENT_REACTION_KEYS);
  physicalLosCache.setArmed(Boolean(demanded));
  return physicalLosCache.sceneCaches.get(getActiveSceneKey()) ?? new Map();
}

/** @deprecated Use armFoundryVisionTracking — kept so older call sites do not seed a full snapshot. */
export async function initializeFoundryVisionSnapshot(_scene = canvas?.scene) {
  return armFoundryVisionTracking();
}

export function getFoundryPhysicalLosCache() {
  return physicalLosCache;
}

function onCanvasReady() {
  const sceneKey = getActiveSceneKey();
  resetVisionScene(canvas?.scene);
  if (!worldReady || !isCurrentActiveGM()) {
    physicalLosCache.setArmed(false);
    return;
  }
  void refreshVisionDemand();
}

async function refreshVisionDemand() {
  const demanded = await eventReactionIndexHasAny(VISION_EVENT_REACTION_KEYS);
  physicalLosCache.setArmed(Boolean(demanded));
  return demanded;
}

function visionTrackingWantedSync() {
  if (!physicalLosCache.isArmed()) return false;
  const current = getEventReactionSubscriptionIndex();
  if (current.isDirty) return false;
  return Boolean(current.hasAnyOf(VISION_EVENT_REACTION_KEYS));
}

async function collectSceneTokens(sceneKey) {
  if (!isCurrentActiveGM() || !canvas?.ready || !canvas.scene) return [];
  if (getActiveSceneKey() !== String(sceneKey ?? "")) return [];
  return (canvas.tokens?.placeables ?? []).filter(token => token?.actor && tokenDocumentUuid(token));
}

async function emitVisionTransition({ type, pair } = {}) {
  if (!isCurrentActiveGM() || !visionTrackingWantedSync() || !pair) return;
  transitionSequence += 1;
  const sceneKey = String(pair.sceneUuid ?? getActiveSceneKey());
  const state = pendingVisionTransitions.get(sceneKey) ?? { entries: [], timerId: null };
  state.entries.push({ type, pair, sequence: transitionSequence });
  if (state.timerId === null) {
    state.timerId = globalThis.setTimeout(() => {
      pendingVisionTransitions.delete(sceneKey);
      void flushVisionTransitions(sceneKey, state.entries);
    }, 0);
  }
  pendingVisionTransitions.set(sceneKey, state);
}

async function flushVisionTransitions(sceneUuid, entries = []) {
  if (!isCurrentActiveGM() || !visionTrackingWantedSync() || !entries.length) return;
  await withSystemEventRoot({
    kind: "physicalVisionTransitions",
    operationId: `los:${sceneUuid}:${entries[0].sequence}:${entries.at(-1).sequence}`,
    sceneUuid,
    combatUuid: String(game.combat?.uuid ?? "")
  }, async scope => {
    for (const { type, pair, sequence } of entries) {
      const key = type === "gained" ? "fallout-maw.vision.target.gained" : "fallout-maw.vision.target.lost";
      await scope.emit(key, {
        data: {
          observerTokenUuid: pair.observerUuid,
          targetTokenUuid: pair.targetUuid,
          physicalLineOfSight: type === "gained"
        },
        before: { physicalLineOfSight: type !== "gained" },
        after: { physicalLineOfSight: type === "gained" },
        delta: { physicalLineOfSight: type === "gained" ? 1 : -1 }
      }, {
        occurrenceKey: `los:${pair.observerUuid}>${pair.targetUuid}:${type}:${sequence}`,
        participants: {
          source: { actorUuid: pair.observerActorUuid, tokenUuid: pair.observerUuid, itemUuid: "" },
          target: { actorUuid: pair.targetActorUuid, tokenUuid: pair.targetUuid, itemUuid: "" },
          related: []
        }
      });
    }
  });
}

function invalidateToken(token, { silent = false } = {}) {
  if (!isCurrentActiveGM()) return null;
  if (!visionTrackingWantedSync()) {
    void refreshVisionDemand().then(demanded => {
      if (demanded) invalidateToken(token, { silent });
    });
    return null;
  }
  const sceneKey = getSceneKey(token?.parent ?? canvas?.scene);
  const tokenUuid = tokenDocumentUuid(token);
  if (!sceneKey || !tokenUuid) return null;
  return physicalLosCache.invalidate(sceneKey, { silent, tokenUuids: [tokenUuid] });
}

function removeToken(token) {
  if (!isCurrentActiveGM()) return null;
  const sceneKey = getSceneKey(token?.parent ?? canvas?.scene);
  const tokenUuid = tokenDocumentUuid(token);
  if (!sceneKey || !tokenUuid) return null;
  if (!visionTrackingWantedSync()) {
    return physicalLosCache.removeToken(sceneKey, tokenUuid, { silent: true });
  }
  return physicalLosCache.invalidate(sceneKey, { removeTokenUuid: tokenUuid });
}

function resetVisionScene(scene = null) {
  const sceneKey = scene ? getSceneKey(scene) : null;
  const keys = sceneKey === null ? Array.from(pendingVisionTransitions.keys()) : [sceneKey];
  for (const key of keys) {
    const pending = pendingVisionTransitions.get(key);
    if (pending?.timerId != null) globalThis.clearTimeout(pending.timerId);
    pendingVisionTransitions.delete(key);
  }
  physicalLosCache.reset(sceneKey);
}

function invalidateSceneFull(scene) {
  if (!isCurrentActiveGM() || !visionTrackingWantedSync() || !scene) return null;
  return physicalLosCache.invalidate(getSceneKey(scene), { full: true });
}

function invalidateActorTokens(actor) {
  if (!isCurrentActiveGM() || !visionTrackingWantedSync() || !actor || !canvas?.scene) return null;
  const tokenUuids = (canvas.tokens?.placeables ?? [])
    .filter(token => token?.actor?.uuid === actor.uuid)
    .map(token => tokenDocumentUuid(token))
    .filter(Boolean);
  if (!tokenUuids.length) return null;
  return physicalLosCache.invalidate(getActiveSceneKey(), { tokenUuids });
}

function effectAffectsPhysicalVision(effect) {
  if (!effect) return false;
  const statuses = effect.statuses ?? effect._statuses ?? [];
  for (const status of statuses) {
    if (VISION_STATUS_IDS.has(String(status))) return true;
  }
  const changes = Array.isArray(effect.changes) ? effect.changes : [];
  return changes.some(change => {
    const key = String(change?.key ?? "").toLowerCase();
    return key.includes("sight")
      || key.includes("vision")
      || key.includes("detection")
      || key.includes("atl.sight")
      || key.includes("blind");
  });
}

function getActiveSceneKey() {
  return getSceneKey(canvas?.scene);
}

function getSceneKey(scene) {
  if (!scene) return "";
  return String(scene.uuid ?? (scene.id ? `Scene.${scene.id}` : ""));
}

function tokenDocumentUuid(token) {
  return String(token?.document?.uuid ?? token?.uuid ?? "").trim();
}

function hasAnyPath(changes, paths) {
  if (!changes || typeof changes !== "object") return false;
  return paths.some(path => globalThis.foundry?.utils?.hasProperty?.(changes, path)
    || Object.hasOwn(changes, path.split(".")[0]));
}

function isCurrentActiveGM() {
  return Boolean(game.users?.activeGM?.id && game.users.activeGM.id === game.user?.id);
}
