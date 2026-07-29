import { SYSTEM_ID } from "../constants.mjs";
import { requestRegionMovementDamageBatch } from "../combat/damage-hub.mjs";
import { measureTheoreticalMovementSegmentsCost } from "../combat/movement-resources.mjs";
import { evaluateFormulaVariables } from "../formulas/evaluation.mjs";
import { getCombatSettings, getDamageTypeSettings } from "../settings/accessors.mjs";
import { evaluateActorFormula, isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { createPeriodicDamageEffectSyncScheduler } from "./periodic-damage-effect-sync-scheduler.mjs";

const BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const CLOCK_FLAG_KEY = "periodicDamage";
const MOVEMENT_FLAG_KEY = "periodicDamageMovement";
const EFFECT_FLAG_KEY = "periodicDamageRegion";
const PREVIOUS_TOKEN_ACTORS_OPTION = "falloutMawPeriodicDamagePreviousTokenActors";
const PREVIOUS_SCENE_ACTORS_OPTION = "falloutMawPeriodicDamagePreviousSceneActors";
const ACTOR_SYNC_TARGET = Symbol("periodicDamageActorSyncTarget");
const MOVEMENT_HISTORY_LIMIT = 50;
const EFFECT_SYNC_DELAY_MS = 50;
const EFFECT_IMG = "icons/svg/fire.svg";
const ACTOR_EXPANSION_RANK = Object.freeze({
  none: 0,
  linked: 1,
  all: 2
});
const TOKEN_EFFECT_PATHS = [
  "_regions",
  "actorId",
  "actorLink",
  "delta",
  "x",
  "y",
  "elevation",
  "width",
  "height",
  "depth",
  "shape",
  "level"
];
const REGION_EFFECT_PATHS = [
  "behaviors",
  "hidden",
  "shapes",
  "elevation",
  "levels",
  "_shapeConstraints",
  "restriction"
];
const BEHAVIOR_EFFECT_PATHS = [
  "type",
  "disabled",
  "system",
  `flags.${SYSTEM_ID}.${CLOCK_FLAG_KEY}.activateAt`,
  `flags.${SYSTEM_ID}.${CLOCK_FLAG_KEY}.expiresAt`
];
const SCENE_EFFECT_PATHS = [
  "grid.type",
  "grid.size",
  "grid.distance",
  "width",
  "height",
  "padding",
  "levels",
  "lights",
  "regions",
  "tokens",
  "walls"
];

let movementQueue = Promise.resolve();
let effectSyncScheduler = null;
let hooksRegistered = false;
let periodicSceneIndex = null;
let lastActiveGmId = null;
const periodicBehaviorsByScene = new WeakMap();
const pendingDamageGroups = new Map();

export function registerPeriodicDamageRegionHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("moveToken", onMoveToken);
  Hooks.on("preUpdateToken", onPreUpdatePeriodicDamageToken);
  Hooks.on("createToken", onCreatePeriodicDamageToken);
  Hooks.on("updateToken", onUpdatePeriodicDamageToken);
  Hooks.on("deleteToken", onDeletePeriodicDamageToken);
  Hooks.on("createRegion", onCreatePeriodicDamageRegion);
  Hooks.on("updateRegion", onUpdatePeriodicDamageRegion);
  Hooks.on("deleteRegion", onDeletePeriodicDamageRegion);
  Hooks.on("createRegionBehavior", onCreatePeriodicDamageRegionBehavior);
  Hooks.on("updateRegionBehavior", onUpdatePeriodicDamageRegionBehavior);
  Hooks.on("deleteRegionBehavior", onDeletePeriodicDamageRegionBehavior);
  Hooks.on("createScene", onCreatePeriodicDamageScene);
  Hooks.on("preUpdateScene", onPreUpdatePeriodicDamageScene);
  Hooks.on("updateScene", onUpdatePeriodicDamageScene);
  Hooks.on("deleteScene", onDeletePeriodicDamageScene);
  Hooks.on("updateActor", onUpdatePeriodicDamageActor);
  Hooks.on("updateWorldTime", onPeriodicDamageWorldTimeUpdate);
  Hooks.on("userConnected", onPeriodicDamageUserConnection);
  Hooks.on("updateUser", onPeriodicDamageUserUpdate);
}

export async function syncPeriodicDamageRegionEffects() {
  lastActiveGmId = getActiveGmId();
  return syncPeriodicDamageRegionEffectScopes({
    actors: game.actors?.contents ?? [],
    scenes: game.scenes?.contents ?? []
  });
}

export async function syncPeriodicDamageRegionEffectsForActors(actors = []) {
  return syncPeriodicDamageRegionEffectScopes({ actors });
}

export async function syncPeriodicDamageRegionEffectsForScenes(scenes = []) {
  return syncPeriodicDamageRegionEffectScopes({ scenes });
}

export async function syncPeriodicDamageRegionEffectScopes({ actors = [], scenes = [] } = {}) {
  if (!game.user?.isActiveGM) return;
  const {
    actors: affectedActors,
    tokensByScene
  } = collectPeriodicDamageEffectScope({ actors, scenes });
  if (!affectedActors.size) return;
  const desiredByActor = collectDesiredRegionEffects(tokensByScene);
  await reconcilePeriodicDamageRegionEffects(affectedActors, desiredByActor);
}

export function flushPeriodicDamageRegionEffectSync() {
  return effectSyncScheduler?.flushNow() ?? Promise.resolve();
}

async function reconcilePeriodicDamageRegionEffects(actors, desiredByActor) {
  for (const candidate of actors.values()) {
    if (!game.user?.isActiveGM) return;
    const actor = resolveCurrentActor(candidate);
    if (!actor?.isOwner) continue;
    const desired = desiredByActor.get(actor.uuid) ?? new Map();
    const existing = Array.from(actor.effects ?? []).filter(effect => effect.getFlag?.(SYSTEM_ID, EFFECT_FLAG_KEY));
    const existingByBehavior = new Map();
    for (const effect of existing) {
      const behaviorUuid = String(effect.getFlag(SYSTEM_ID, EFFECT_FLAG_KEY)?.behaviorUuid ?? "");
      const effects = existingByBehavior.get(behaviorUuid) ?? [];
      effects.push(effect);
      existingByBehavior.set(behaviorUuid, effects);
    }

    const creates = [];
    const updates = [];
    const deleteIds = [];
    for (const [behaviorUuid, entry] of desired) {
      const effectData = buildRegionEffectData(entry.region, entry.behavior, actor);
      const [effect, ...duplicates] = existingByBehavior.get(behaviorUuid) ?? [];
      if (!effect) creates.push(effectData);
      else if (regionEffectNeedsUpdate(effect, effectData)) updates.push({ _id: effect.id, ...effectData });
      deleteIds.push(...duplicates.map(duplicate => duplicate.id));
      existingByBehavior.delete(behaviorUuid);
    }
    for (const effects of existingByBehavior.values()) {
      deleteIds.push(...effects.map(effect => effect.id));
    }

    if (creates.length && game.user?.isActiveGM && documentIsCurrent(actor)) {
      await actor.createEmbeddedDocuments("ActiveEffect", creates, { animate: false });
    }
    if (updates.length && game.user?.isActiveGM && documentIsCurrent(actor)) {
      await actor.updateEmbeddedDocuments("ActiveEffect", updates, { animate: false });
    }
    if (deleteIds.length && game.user?.isActiveGM && documentIsCurrent(actor)) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", deleteIds, { animate: false });
    }
  }
}

function onMoveToken(tokenDocument, movement) {
  if (!game.user?.isActiveGM || !tokenDocument?.actor || !movement) return;
  const documentMovement = tokenDocument.movement;
  const routeFinished = documentMovement?.id === movement.id
    && (documentMovement.state === "completed" || documentMovement.state === "stopped");
  movementQueue = movementQueue
    .then(() => processTokenMovement(tokenDocument, movement, { documentMovement, routeFinished }))
    .catch(error => console.error(`${SYSTEM_ID} | Periodic damage region movement failed`, error));
}

async function processTokenMovement(tokenDocument, movement, { documentMovement = null, routeFinished = false } = {}) {
  if (movement.method === "undo") {
    clearPendingMovementDamage(tokenDocument);
    await restorePeriodicDamageRegionMovement(tokenDocument);
    requestPeriodicDamageTokenEffectSync(tokenDocument);
    return;
  }
  const movementKey = getMovementKey(tokenDocument, movement);
  const routeMovementId = getRouteMovementId(movement);
  const path = [movement.origin, ...(movement.passed?.waypoints ?? [])].filter(Boolean);
  if (path.length < 2) {
    if (routeFinished) {
      await waitForCompletedMovementAnimation(tokenDocument, documentMovement);
      await flushPendingMovementDamage(movementKey);
    }
    return;
  }
  const groups = [];
  const scene = tokenDocument.parent;

  for (const region of scene?.regions?.contents ?? []) {
    if (region.hidden) continue;
    const segments = tokenDocument.segmentizeRegionMovementPath(region, path)
      .filter(segment => segment.type === CONST.REGION_MOVEMENT_SEGMENTS.MOVE && !segment.teleport);
    if (!segments.length) continue;

    for (const behavior of region.behaviors?.contents ?? []) {
      if (!isBehaviorCurrentlyActive(region, behavior)) continue;
      const entries = getDamageEntries(behavior.system);
      if (!entries.length) continue;
      const cost = measureTheoreticalMovementSegmentsCost(tokenDocument, segments, {
        measureOptions: movement.measureOptions
      });
      if (cost <= 0) continue;

      const actor = tokenDocument.actor;
      const threshold = getActorMovementDamageThreshold(actor);
      const state = normalizeMovementState(behavior.getFlag(SYSTEM_ID, MOVEMENT_FLAG_KEY));
      const actorUuid = actor.uuid;
      const actorState = getMovementActorState(state, actorUuid);
      const previousProgress = actorState.progress;
      const accumulated = previousProgress + cost;
      const triggerCount = Math.floor(accumulated / threshold);
      const nextProgress = accumulated % threshold;

      actorState.progress = nextProgress;
      actorState.triggered += triggerCount;
      const movementId = routeMovementId;
      const previousEntry = state.history.at(-1);
      if (movementId && previousEntry?.movementId === movementId
        && previousEntry.actorUuid === actorUuid && previousEntry.tokenId === tokenDocument.id) {
        previousEntry.nextProgress = nextProgress;
        previousEntry.cost = Math.max(0, toInteger(previousEntry.cost)) + cost;
        previousEntry.triggerCount = Math.max(0, toInteger(previousEntry.triggerCount)) + triggerCount;
      } else {
        state.history.push({
          id: foundry.utils.randomID(),
          movementId,
          actorUuid,
          tokenId: tokenDocument.id,
          previousProgress,
          nextProgress,
          cost,
          triggerCount
        });
      }
      state.history = state.history.slice(-MOVEMENT_HISTORY_LIMIT);
      await behavior.setFlag(SYSTEM_ID, MOVEMENT_FLAG_KEY, state);

      if (triggerCount > 0) groups.push({
        actor,
        entries,
        triggerCount,
        source: {
          regionUuid: region.uuid,
          behaviorUuid: behavior.uuid,
          tokenId: tokenDocument.id,
          movementId: routeMovementId
        }
      });
    }
  }

  if (groups.length) {
    const pending = pendingDamageGroups.get(movementKey) ?? [];
    pending.push(...groups);
    pendingDamageGroups.set(movementKey, pending);
  }
  if (routeFinished) {
    await waitForCompletedMovementAnimation(tokenDocument, documentMovement);
    await flushPendingMovementDamage(movementKey);
  }
  requestPeriodicDamageTokenEffectSync(tokenDocument);
}

function getMovementKey(tokenDocument, movement) {
  return `${tokenDocument.parent?.id ?? ""}:${tokenDocument.id}:${getRouteMovementId(movement)}`;
}

function getRouteMovementId(movement) {
  return String(movement?.chain?.at(0) ?? movement?.id ?? "");
}

async function waitForCompletedMovementAnimation(tokenDocument, documentMovement) {
  await documentMovement.finished;
  await game.raceWithWindowHidden(new Promise(resolve => requestAnimationFrame(resolve)));
  const animation = tokenDocument.object?.movementAnimationPromise;
  if (animation) await game.raceWithWindowHidden(animation);
}

async function flushPendingMovementDamage(movementKey) {
  const dueGroups = combineMovementDamageGroups(pendingDamageGroups.get(movementKey) ?? []);
  pendingDamageGroups.delete(movementKey);
  if (dueGroups.length) await requestRegionMovementDamageBatch(dueGroups);
}

function clearPendingMovementDamage(tokenDocument) {
  const prefix = `${tokenDocument.parent?.id ?? ""}:${tokenDocument.id}:`;
  for (const key of pendingDamageGroups.keys()) {
    if (key.startsWith(prefix)) pendingDamageGroups.delete(key);
  }
}

function combineMovementDamageGroups(groups = []) {
  const combined = new Map();
  for (const group of groups) {
    const key = `${group.actor?.uuid ?? ""}:${group.source?.behaviorUuid ?? ""}`;
    const existing = combined.get(key);
    if (existing) existing.triggerCount += Math.max(0, toInteger(group.triggerCount));
    else combined.set(key, { ...group, triggerCount: Math.max(0, toInteger(group.triggerCount)) });
  }
  return Array.from(combined.values()).filter(group => group.triggerCount > 0);
}

async function restorePeriodicDamageRegionMovement(tokenDocument) {
  const actorUuid = tokenDocument.actor?.uuid ?? "";
  if (!actorUuid) return;
  for (const region of tokenDocument.parent?.regions?.contents ?? []) {
    for (const behavior of region.behaviors?.contents ?? []) {
      if (behavior.type !== BEHAVIOR_TYPE) continue;
      const state = normalizeMovementState(behavior.getFlag(SYSTEM_ID, MOVEMENT_FLAG_KEY));
      const index = state.history.findLastIndex(entry => (
        entry.actorUuid === actorUuid && entry.tokenId === tokenDocument.id
      ));
      if (index < 0) continue;
      const [entry] = state.history.splice(index, 1);
      getMovementActorState(state, actorUuid).progress = Math.max(0, toInteger(entry.previousProgress));
      await behavior.setFlag(SYSTEM_ID, MOVEMENT_FLAG_KEY, state);
    }
  }
}

function getActorMovementDamageThreshold(actor) {
  const formula = getCombatSettings().areas.movementDamageThresholdFormula;
  const actionPointsMax = Math.max(0, toInteger(actor.system?.resources?.actionPoints?.max));
  const movementPointsMax = Math.max(0, toInteger(actor.system?.resources?.movementPoints?.max));
  return Math.max(1, evaluateFormulaVariables(formula, {
    ОД: actionPointsMax,
    ОП: movementPointsMax,
    actionPointsMax,
    movementPointsMax
  }));
}

function normalizeMovementState(value = {}) {
  const actors = Array.isArray(value?.actors)
    ? value.actors.map(normalizeMovementActorState).filter(entry => entry.actorUuid)
    : migrateLegacyMovementActorStates(value);
  return {
    actors,
    history: Array.isArray(value?.history) ? value.history.filter(entry => entry && typeof entry === "object") : []
  };
}

function getMovementActorState(state, actorUuid) {
  let actorState = state.actors.find(entry => entry.actorUuid === actorUuid);
  if (!actorState) {
    actorState = { actorUuid, progress: 0, triggered: 0 };
    state.actors.push(actorState);
  }
  return actorState;
}

function normalizeMovementActorState(value = {}) {
  return {
    actorUuid: String(value?.actorUuid ?? ""),
    progress: Math.max(0, toInteger(value?.progress)),
    triggered: Math.max(0, toInteger(value?.triggered))
  };
}

function migrateLegacyMovementActorStates(value = {}) {
  const progress = flattenLegacyActorValues(value?.progress);
  const triggered = flattenLegacyActorValues(value?.triggered);
  const actorUuids = new Set([...progress.keys(), ...triggered.keys()]);
  return Array.from(actorUuids, actorUuid => ({
    actorUuid,
    progress: Math.max(0, toInteger(progress.get(actorUuid))),
    triggered: Math.max(0, toInteger(triggered.get(actorUuid)))
  }));
}

function flattenLegacyActorValues(value, prefix = "", result = new Map()) {
  if (!value || typeof value !== "object") return result;
  for (const [key, entry] of Object.entries(value)) {
    const actorUuid = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object") flattenLegacyActorValues(entry, actorUuid, result);
    else result.set(actorUuid, entry);
  }
  return result;
}

function isBehaviorCurrentlyActive(region, behavior) {
  if (!region || region.hidden || !behavior || behavior.disabled || behavior.type !== BEHAVIOR_TYPE) return false;
  const system = behavior.system ?? {};
  const state = behavior.getFlag?.(SYSTEM_ID, CLOCK_FLAG_KEY);
  const now = Number(game.time?.worldTime) || 0;
  if (Math.max(0, toInteger(system.delaySeconds)) > 0) {
    const activateAt = Number(state?.activateAt);
    if (!Number.isFinite(activateAt) || now < activateAt) return false;
  }
  const expiresAt = Number(state?.expiresAt);
  return !Number.isFinite(expiresAt) || now < expiresAt;
}

function collectDesiredRegionEffects(tokensByScene) {
  const desired = new Map();
  for (const [scene, tokens] of tokensByScene) {
    if (!tokens.length) continue;
    for (const { region, behavior } of getPeriodicDamageBehaviors(scene)) {
      if (!isBehaviorCurrentlyActive(region, behavior) || !getDamageEntries(behavior.system).length) continue;
      for (const token of tokens) {
        const actor = token.actor;
        if (!actor?.uuid || !isTokenInsideRegion(token, region)) continue;
        const actorEffects = desired.get(actor.uuid) ?? new Map();
        actorEffects.set(behavior.uuid, { region, behavior });
        desired.set(actor.uuid, actorEffects);
      }
    }
  }
  return desired;
}

function collectPeriodicDamageEffectScope({ actors = [], scenes = [] } = {}) {
  const affectedActors = new Map();
  const tokensBySceneKey = new Map();
  const actorExpansionQueue = [];
  const expandedActorRanks = new Map();

  const addActor = candidate => {
    const target = normalizeActorSyncTarget(candidate);
    const actor = resolveCurrentActor(target.actor);
    if (!actor?.uuid) return null;
    affectedActors.set(actor.uuid, actor);
    const requestedRank = ACTOR_EXPANSION_RANK[target.expansion] ?? ACTOR_EXPANSION_RANK.all;
    if (requestedRank > (expandedActorRanks.get(actor.uuid) ?? -1)) {
      actorExpansionQueue.push({ actor, expansion: target.expansion });
    }
    return actor;
  };

  const addToken = token => {
    const scene = resolveCurrentScene(token?.parent);
    if (!scene || !sceneContainsToken(scene, token)) return;
    const actor = token?.actor;
    if (!actor?.uuid) return;
    addActor(createActorSyncTarget(actor, token.actorLink ? "linked" : "none"));
    const sceneKey = scene.uuid ?? scene.id ?? scene;
    const entry = tokensBySceneKey.get(sceneKey) ?? {
      scene,
      tokens: new Map()
    };
    entry.scene = scene;
    entry.tokens.set(token.uuid ?? token.id ?? token, token);
    tokensBySceneKey.set(sceneKey, entry);
  };

  for (const candidate of asDocumentArray(actors)) addActor(candidate);
  for (const candidate of asDocumentArray(scenes)) {
    const scene = resolveCurrentScene(candidate);
    if (!scene) continue;
    for (const token of scene.tokens?.contents ?? scene.tokens ?? []) addToken(token);
  }

  for (let index = 0; index < actorExpansionQueue.length; index += 1) {
    const { actor, expansion } = actorExpansionQueue[index];
    const requestedRank = ACTOR_EXPANSION_RANK[expansion] ?? ACTOR_EXPANSION_RANK.all;
    if (!actor?.uuid || requestedRank <= (expandedActorRanks.get(actor.uuid) ?? -1)) continue;
    expandedActorRanks.set(actor.uuid, requestedRank);
    if (requestedRank === ACTOR_EXPANSION_RANK.none) continue;
    const options = requestedRank === ACTOR_EXPANSION_RANK.linked ? { linked: true } : {};
    for (const token of actor.getDependentTokens?.(options) ?? []) addToken(token);
  }

  const tokensByScene = new Map();
  for (const { scene, tokens } of tokensBySceneKey.values()) {
    tokensByScene.set(scene, Array.from(tokens.values()));
  }
  return { actors: affectedActors, tokensByScene };
}

function resolveCurrentDocument(candidate) {
  if (!candidate) return null;
  const uuid = typeof candidate === "string" ? candidate : candidate.uuid;
  if (!uuid) return candidate;
  if (typeof globalThis.fromUuidSync === "function") return globalThis.fromUuidSync(uuid) ?? null;
  return typeof candidate === "string" ? null : candidate;
}

function resolveCurrentActor(candidate) {
  const actor = resolveCurrentDocument(candidate);
  if (!actor || actor.pack || actor.inCompendium) return null;
  if (actor.isToken) return tokenActorIsCurrent(actor) ? actor : null;
  const id = actor.id ?? actor._id;
  if (!id) return null;
  if (game.actors?.get) return game.actors.get(id) === actor ? actor : null;
  return (game.actors?.contents ?? []).includes(actor) ? actor : null;
}

function resolveCurrentScene(candidate) {
  const resolved = resolveCurrentDocument(candidate);
  if (!resolved) return null;
  const id = resolved.id ?? resolved._id;
  if (!id) return null;
  if (game.scenes?.get) return game.scenes.get(id) === resolved ? resolved : null;
  return (game.scenes?.contents ?? []).includes(resolved) ? resolved : null;
}

function tokenActorIsCurrent(actor) {
  const token = actor.token;
  return Boolean(token && token.actor === actor && sceneContainsToken(resolveCurrentScene(token.parent), token));
}

function sceneContainsToken(scene, token) {
  if (!scene || !token?.id) return false;
  if (scene.tokens?.get) return scene.tokens.get(token.id) === token;
  return (scene.tokens?.contents ?? []).includes(token);
}

function documentIsCurrent(actor) {
  return resolveCurrentActor(actor) === actor;
}

function createActorSyncTarget(actor, expansion = "all") {
  const normalizedExpansion = expansion in ACTOR_EXPANSION_RANK ? expansion : "all";
  return {
    [ACTOR_SYNC_TARGET]: true,
    id: `${actor?.uuid ?? actor?.id ?? ""}::${normalizedExpansion}`,
    actor,
    expansion: normalizedExpansion
  };
}

function normalizeActorSyncTarget(candidate) {
  if (candidate?.[ACTOR_SYNC_TARGET]) return candidate;
  return {
    actor: candidate,
    expansion: "all"
  };
}

function asDocumentArray(value) {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string" && typeof value[Symbol.iterator] === "function") return value;
  return [value];
}

function getPeriodicDamageBehaviors(scene) {
  if (!scene) return [];
  const cached = periodicBehaviorsByScene.get(scene);
  if (cached) return cached;
  const behaviors = [];
  for (const region of scene.regions?.contents ?? scene.regions ?? []) {
    for (const behavior of region.behaviors?.contents ?? region.behaviors ?? []) {
      if (behavior.type === BEHAVIOR_TYPE) behaviors.push({ region, behavior });
    }
  }
  periodicBehaviorsByScene.set(scene, behaviors);
  return behaviors;
}

function getPeriodicDamageScenes() {
  return Array.from(getPeriodicDamageSceneSet());
}

function getPeriodicDamageSceneSet() {
  if (!periodicSceneIndex) {
    periodicSceneIndex = new Set();
    for (const scene of game.scenes?.contents ?? game.scenes ?? []) {
      if (getPeriodicDamageBehaviors(scene).length) periodicSceneIndex.add(scene);
    }
  }
  return periodicSceneIndex;
}

function invalidatePeriodicDamageScene(scene) {
  if (scene) periodicBehaviorsByScene.delete(scene);
  periodicSceneIndex = null;
}

function buildRegionEffectData(region, behavior, actor) {
  const intervalSeconds = Math.max(1, toInteger(behavior.system?.intervalSeconds) || 6);
  const damageTypes = new Map(getDamageTypeSettings().map(entry => [entry.key, entry]));
  const damageLines = getDamageEntries(behavior.system).map(entry => {
    const amount = evaluateActorFormula(entry.amount, actor, { minimum: 0, context: "region effect description" });
    const label = String(damageTypes.get(entry.damageTypeKey)?.label ?? entry.damageTypeKey);
    return `<p><strong>${escapeHtml(label)}:</strong> ${amount} ${escapeHtml(game.i18n.format("FALLOUTMAW.RegionBehavior.PeriodicDamage.AreaEffectDamageTiming", { seconds: intervalSeconds }))}</p>`;
  }).join("");

  return {
    name: game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.AreaEffectName"),
    img: EFFECT_IMG,
    description: damageLines,
    origin: behavior.uuid,
    disabled: false,
    transfer: false,
    showIcon: CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS,
    flags: {
      [SYSTEM_ID]: {
        [EFFECT_FLAG_KEY]: {
          regionUuid: region.uuid,
          behaviorUuid: behavior.uuid
        }
      }
    }
  };
}

function regionEffectNeedsUpdate(effect, desired) {
  return effect.name !== desired.name
    || effect.img !== desired.img
    || effect.description !== desired.description
    || effect.origin !== desired.origin
    || effect.disabled !== desired.disabled
    || effect.showIcon !== desired.showIcon
    || effect.getFlag(SYSTEM_ID, EFFECT_FLAG_KEY)?.regionUuid !== desired.flags[SYSTEM_ID][EFFECT_FLAG_KEY].regionUuid;
}

function getDamageEntries(system = {}) {
  return (Array.isArray(system.damageEntries) ? system.damageEntries : [])
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      amount: String(entry?.amount ?? "0").trim() || "0"
    }))
    .filter(entry => entry.damageTypeKey && isFormulaTextConfigured(entry.amount));
}

function isTokenInsideRegion(token, region) {
  try {
    return token.testInsideRegion(region);
  } catch (_error) {
    return false;
  }
}

function onPreUpdatePeriodicDamageToken(token, changes = {}, options = {}) {
  if (!hasChangedPath(changes, ["actorId", "actorLink"])) return;
  const snapshots = options[PREVIOUS_TOKEN_ACTORS_OPTION] ??= {};
  snapshots[token.uuid ?? token.id] = {
    actorId: token.actorId ?? token.baseActor?.id ?? null,
    actorLink: Boolean(token.actorLink)
  };
}

function onCreatePeriodicDamageToken(token) {
  requestPeriodicDamageTokenEffectSync(token);
}

function onUpdatePeriodicDamageToken(token, changes = {}, options = {}) {
  if (!hasChangedPath(changes, TOKEN_EFFECT_PATHS)) return;
  const associationChanged = hasChangedPath(changes, ["actorId", "actorLink"]);
  const sceneIsPeriodic = sceneHasPeriodicDamageBehavior(token?.parent);
  if (!sceneIsPeriodic && !associationChanged) return;
  const actors = [];
  if (token?.actor) actors.push(token.actor);

  if (associationChanged) {
    if (token?.baseActor) actors.push(token.baseActor);
    const snapshot = options[PREVIOUS_TOKEN_ACTORS_OPTION]?.[token.uuid ?? token.id];
    const previousActorId = snapshot?.actorId ?? options.previousActorId;
    const previousBaseActor = previousActorId ? game.actors?.get?.(previousActorId) : null;
    if (previousBaseActor && snapshot?.actorLink !== false) actors.push(previousBaseActor);
  }

  requestPeriodicDamageActorEffectSync(actors, {
    force: true,
    expansion: "linked"
  });
}

function onDeletePeriodicDamageToken(token) {
  const baseActor = token?.baseActor;
  if (!baseActor) return;
  if (!sceneHasPeriodicDamageBehavior(token.parent)
    && !actorHasManagedPeriodicDamageEffect(baseActor)) return;
  requestPeriodicDamageActorEffectSync([baseActor], { force: true, expansion: "linked" });
}

function onCreatePeriodicDamageRegion(region) {
  const scene = region?.parent;
  invalidatePeriodicDamageScene(scene);
  if (regionHasPeriodicDamageBehavior(region)) requestPeriodicDamageSceneEffectSync([scene]);
}

function onUpdatePeriodicDamageRegion(region, changes = {}) {
  if (!hasChangedPath(changes, REGION_EFFECT_PATHS)) return;
  const behaviorsChanged = hasChangedPath(changes, ["behaviors"]);
  if (behaviorsChanged) invalidatePeriodicDamageScene(region?.parent);
  if (!behaviorsChanged && !regionHasPeriodicDamageBehavior(region)) return;
  requestPeriodicDamageSceneEffectSync([region.parent]);
}

function onDeletePeriodicDamageRegion(region) {
  const scene = region?.parent;
  const affected = regionHasPeriodicDamageBehavior(region);
  invalidatePeriodicDamageScene(scene);
  if (affected) requestPeriodicDamageSceneEffectSync([scene]);
}

function onCreatePeriodicDamageRegionBehavior(behavior) {
  if (behavior?.type !== BEHAVIOR_TYPE) return;
  invalidatePeriodicDamageScene(behavior.scene);
  requestPeriodicDamageSceneEffectSync([behavior.scene]);
}

function onUpdatePeriodicDamageRegionBehavior(behavior, changes = {}) {
  const typeChanged = hasChangedPath(changes, ["type"]);
  if ((behavior?.type !== BEHAVIOR_TYPE && !typeChanged)
    || !hasChangedPath(changes, BEHAVIOR_EFFECT_PATHS)) return;
  if (typeChanged) invalidatePeriodicDamageScene(behavior.scene);
  requestPeriodicDamageSceneEffectSync([behavior.scene]);
}

function onDeletePeriodicDamageRegionBehavior(behavior) {
  if (behavior?.type !== BEHAVIOR_TYPE) return;
  invalidatePeriodicDamageScene(behavior.scene);
  requestPeriodicDamageSceneEffectSync([behavior.scene]);
}

function onCreatePeriodicDamageScene(scene) {
  invalidatePeriodicDamageScene(scene);
  if (sceneHasPeriodicDamageBehavior(scene)) requestPeriodicDamageSceneEffectSync([scene]);
}

function onPreUpdatePeriodicDamageScene(scene, changes = {}, options = {}) {
  if (!hasChangedPath(changes, ["tokens"])) return;
  const actorIds = new Set();
  for (const token of scene.tokens?.contents ?? scene.tokens ?? []) {
    const actorId = token.baseActor?.id ?? token.actorId;
    if (actorId) actorIds.add(actorId);
  }
  const snapshots = options[PREVIOUS_SCENE_ACTORS_OPTION] ??= {};
  snapshots[scene.uuid ?? scene.id] = Array.from(actorIds);
}

function onUpdatePeriodicDamageScene(scene, changes = {}, options = {}) {
  if (!hasChangedPath(changes, SCENE_EFFECT_PATHS)) return;
  const regionsChanged = hasChangedPath(changes, ["regions"]);
  if (regionsChanged) invalidatePeriodicDamageScene(scene);

  const previousActors = (
    options[PREVIOUS_SCENE_ACTORS_OPTION]?.[scene.uuid ?? scene.id] ?? []
  ).map(actorId => game.actors?.get?.(actorId)).filter(Boolean);
  const currentPeriodic = sceneHasPeriodicDamageBehavior(scene);
  if (!currentPeriodic && !regionsChanged && !previousActors.some(actorHasManagedPeriodicDamageEffect)) return;
  requestPeriodicDamageEffectSync({
    actors: previousActors,
    actorExpansion: "linked",
    scenes: [scene]
  });
}

function onDeletePeriodicDamageScene(scene) {
  const affected = sceneHasPeriodicDamageBehavior(scene);
  const actors = [];
  for (const token of scene.tokens?.contents ?? scene.tokens ?? []) {
    const baseActor = token.baseActor;
    if (baseActor && (affected || actorHasManagedPeriodicDamageEffect(baseActor))) {
      actors.push(baseActor);
    }
  }
  invalidatePeriodicDamageScene(scene);
  if (actors.length) {
    requestPeriodicDamageActorEffectSync(actors, { force: true, expansion: "linked" });
  }
}

function onUpdatePeriodicDamageActor(actor) {
  requestPeriodicDamageActorEffectSync([actor]);
}

function onPeriodicDamageWorldTimeUpdate() {
  requestPeriodicDamageSceneEffectSync(getPeriodicDamageScenes());
}

function onPeriodicDamageUserConnection() {
  recoverPeriodicDamageAuthorityTransition();
}

function onPeriodicDamageUserUpdate() {
  recoverPeriodicDamageAuthorityTransition();
}

function recoverPeriodicDamageAuthorityTransition() {
  const activeGmId = getActiveGmId();
  const authorityChanged = activeGmId !== lastActiveGmId;
  lastActiveGmId = activeGmId;
  if (game.ready === false
    || !authorityChanged
    || !activeGmId
    || game.user?.id !== activeGmId) return;
  requestPeriodicDamageEffectSync({
    actors: game.actors?.contents ?? [],
    scenes: game.scenes?.contents ?? []
  });
}

function getActiveGmId() {
  return game.users?.activeGM?.id ?? (game.user?.isActiveGM ? game.user.id : null);
}

function requestPeriodicDamageTokenEffectSync(token) {
  if (token?.parent?.tokens?.get && token.parent.tokens.get(token.id) !== token) return false;
  if (!sceneHasPeriodicDamageBehavior(token?.parent)) return false;
  const actor = token?.actor;
  if (!actor) return false;
  return requestPeriodicDamageActorEffectSync([actor], {
    force: true,
    expansion: "linked"
  });
}

function requestPeriodicDamageActorEffectSync(actors, {
  force = false,
  expansion = "all"
} = {}) {
  if (!game.user?.isActiveGM) return false;
  const relevantActors = asDocumentArray(actors)
    .map(resolveCurrentActor)
    .filter(actor => actor?.uuid && (force || actorIsPeriodicDamageRelevant(actor)));
  return relevantActors.length
    ? getPeriodicDamageEffectSyncScheduler().requestActors(
      relevantActors.map(actor => createActorSyncTarget(actor, expansion))
    )
    : false;
}

function requestPeriodicDamageSceneEffectSync(scenes) {
  return requestPeriodicDamageEffectSync({ scenes });
}

function requestPeriodicDamageEffectSync({
  actors = [],
  actorExpansion = "all",
  scenes = []
} = {}) {
  if (!game.user?.isActiveGM) return false;
  const validActors = asDocumentArray(actors).map(resolveCurrentActor).filter(actor => actor?.uuid);
  const validScenes = asDocumentArray(scenes).filter(scene => scene?.uuid || scene?.id);
  if (!validActors.length && !validScenes.length) return false;
  return getPeriodicDamageEffectSyncScheduler().request({
    actors: validActors.map(actor => createActorSyncTarget(actor, actorExpansion)),
    scenes: validScenes
  });
}

function getPeriodicDamageEffectSyncScheduler() {
  effectSyncScheduler ??= createPeriodicDamageEffectSyncScheduler({
    debounceMs: EFFECT_SYNC_DELAY_MS,
    sync: syncPeriodicDamageRegionEffectScopes,
    onError: error => console.error(`${SYSTEM_ID} | Periodic damage region effect sync failed`, error)
  });
  return effectSyncScheduler;
}

function actorIsPeriodicDamageRelevant(actor) {
  if (actorHasManagedPeriodicDamageEffect(actor)) return true;
  const periodicScenes = getPeriodicDamageSceneSet();
  if (!periodicScenes.size) return false;
  return (actor.getDependentTokens?.() ?? []).some(token => periodicScenes.has(token?.parent));
}

function actorHasManagedPeriodicDamageEffect(actor) {
  return Array.from(actor?.effects ?? [])
    .some(effect => Boolean(effect.getFlag?.(SYSTEM_ID, EFFECT_FLAG_KEY)));
}

function sceneHasPeriodicDamageBehavior(scene) {
  return getPeriodicDamageBehaviors(scene).length > 0;
}

function regionHasPeriodicDamageBehavior(region) {
  return Array.from(region?.behaviors?.contents ?? region?.behaviors ?? [])
    .some(behavior => behavior?.type === BEHAVIOR_TYPE);
}

function hasChangedPath(changes, roots) {
  if (!changes || typeof changes !== "object") return false;
  const flattened = foundry.utils.flattenObject?.(changes);
  const paths = flattened ? Object.keys(flattened) : collectLeafPaths(changes);
  return paths.some(path => roots.some(root => (
    path === root
    || path.startsWith(`${root}.`)
    || root.startsWith(`${path}.`)
  )));
}

function collectLeafPaths(value, prefix = "", result = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) result.push(prefix);
    return result;
  }
  const entries = Object.entries(value);
  if (!entries.length && prefix) result.push(prefix);
  for (const [key, entry] of entries) {
    collectLeafPaths(entry, prefix ? `${prefix}.${key}` : key, result);
  }
  return result;
}

function escapeHtml(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}
