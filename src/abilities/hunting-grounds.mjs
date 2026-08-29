import { SYSTEM_ID } from "../constants.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import {
  ATTACK_CRITICAL_FAILURE_DISABLED_EFFECT_KEY,
  getReverseEffectKey
} from "../utils/active-effect-keys.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { getDetectionModeRangeEffectKey } from "../canvas/vision-effect-keys.mjs";
import { getActorFactionRelation } from "../settings/factions.mjs";
import { isPhantomEntity } from "./phantom-entity.mjs";

export const HUNTING_GROUNDS_DETECTION_MODE_ID = "huntingGrounds";
export const HUNTING_GROUNDS_REGION_FLAG_KEY = "huntingGroundsRegion";
export const HUNTING_GROUNDS_SESSION_EFFECT_FLAG_KEY = "huntingGroundsSession";
export const HUNTING_GROUNDS_PREY_EFFECT_FLAG_KEY = "huntingGroundsPrey";
export const HUNTING_GROUNDS_RESOURCE_OBSERVER_ID = "fallout-maw.fixed.huntingGrounds.resourceSpent";

const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const DEFAULT_ICON = "icons/svg/target.svg";
const RESOURCE_EVENT_KEY = "fallout-maw.combat.resource.spent";
const INDEX_SEPARATOR = "\u0000";

let runtimeRegistered = false;
let indexesInitialized = false;
let movementQueue = Promise.resolve();
let visibilityRefreshQueued = false;
let visibilityInitializeQueued = false;

/** @type {Map<string, ActiveEffect>} */
const indexedEffects = new Map();
/** @type {Map<string, object>} */
const indexedEffectData = new Map();
/** @type {Map<string, Set<string>>} */
const sessionEffectsBySourceActor = new Map();
/** @type {Map<string, Set<string>>} */
const preyEffectsByTargetActor = new Map();
/** @type {Map<string, Set<string>>} */
const preyEffectsByTokenPair = new Map();
/** @type {Map<string, Map<string, number>>} target Token UUID -> hunter Token UUID -> expiresAt */
const detectableHuntersByTargetToken = new Map();
/** @type {Map<string, RegionDocument>} */
const indexedRegions = new Map();
/** @type {Map<string, Set<string>>} */
const regionUuidsByScene = new Map();
const preyCheckLocks = new Map();
const preyEffectMutationQueues = new Map();
const cleaningSessions = new Set();

/**
 * Register the complete engine-native runtime once during system init.
 * No polling is used: world-time, movement, document, and combat-spend events
 * are the only hot paths.
 */
export function registerHuntingGroundsRuntime() {
  if (runtimeRegistered) return false;
  runtimeRegistered = true;

  registerHuntingGroundsDetectionMode();
  registerQueuedWorldTimeProcessor(processHuntingGroundsWorldTime, { priority: 40 });
  registerSystemEventObserver({
    id: HUNTING_GROUNDS_RESOURCE_OBSERVER_ID,
    eventKeys: [RESOURCE_EVENT_KEY],
    priority: 150,
    observe: observeHuntingGroundsResourceSpent
  });

  Hooks.on("moveToken", queueHuntingGroundsTokenMovement);
  Hooks.on("createActiveEffect", onCreateOrUpdateHuntingGroundsEffect);
  Hooks.on("updateActiveEffect", onCreateOrUpdateHuntingGroundsEffect);
  Hooks.on("deleteActiveEffect", onDeleteHuntingGroundsEffect);
  Hooks.on("createRegion", onCreateOrUpdateHuntingGroundsRegion);
  Hooks.on("updateRegion", onCreateOrUpdateHuntingGroundsRegion);
  Hooks.on("deleteRegion", onDeleteHuntingGroundsRegion);
  Hooks.on("deleteToken", onDeleteHuntingGroundsToken);
  Hooks.on("canvasReady", onHuntingGroundsCanvasReady);
  const initializeIndexes = () => {
    if (!indexesInitialized) rebuildHuntingGroundsIndexes();
    if (isHuntingGroundsAuthority()) {
      void processHuntingGroundsWorldTime(getWorldTime());
    }
  };
  if (game.ready) initializeIndexes();
  else Hooks.once("ready", initializeIndexes);
  return true;
}

/**
 * Create a new 20x20x20m (or configured) Hunting Grounds session.
 * This function is intentionally GM-authoritative and is suitable as the
 * terminal operation of the fixed-function socket request.
 */
export async function activateHuntingGrounds({
  sourceActor = null,
  sourceToken = null,
  abilityItem = null,
  abilityFunction = null,
  settings = {},
  center = null
} = {}) {
  const tokenDocument = getTokenDocument(sourceToken);
  const scene = tokenDocument?.parent ?? null;
  if (!isHuntingGroundsAuthority()) return activationFailure("notAuthority");
  if (!sourceActor || !tokenDocument || tokenDocument.actor?.uuid !== sourceActor.uuid) {
    return activationFailure("invalidSource");
  }
  if (!scene?.regions || !abilityItem || !abilityFunction || isPhantomEntity(sourceActor) || isPhantomEntity(tokenDocument)) {
    return activationFailure("invalidDocuments");
  }
  const active = findActiveHuntingGroundsSession(sourceActor, abilityItem, abilityFunction);
  if (active) return { success: false, reason: "active", effect: active, session: getHuntingGroundsSessionData(active) };

  const runtime = normalizeHuntingGroundsRuntimeSettings(settings, sourceActor);
  if (runtime.durationSeconds <= 0 || runtime.zoneSizeMeters <= 0) return activationFailure("invalidSettings");
  const point = normalizeCenter(center, tokenDocument);
  if (!point || (point.levelId && !scene.levels?.has?.(point.levelId))) {
    return activationFailure("invalidCenter");
  }

  const now = getWorldTime();
  const sessionId = foundry.utils.randomID();
  const expiresAt = now + runtime.durationSeconds;
  const identifiers = {
    sessionId,
    sourceActorUuid: String(sourceActor.uuid ?? ""),
    sourceTokenUuid: String(tokenDocument.uuid ?? ""),
    abilityItemId: String(abilityItem.id ?? ""),
    abilityItemUuid: String(abilityItem.uuid ?? ""),
    abilitySourceId: String(abilityItem.getFlag?.("core", "sourceId") ?? abilityItem.flags?.core?.sourceId ?? ""),
    functionId: String(abilityFunction.id ?? ""),
    fixedKey: String(abilityFunction.fixedKey ?? "huntingGrounds"),
    createdAt: now,
    expiresAt
  };
  const regionData = createHuntingGroundsSquareRegionData({
    scene,
    center: point,
    sourceActor,
    abilityItem,
    runtime,
    identifiers
  });

  let region = null;
  let effect = null;
  try {
    [region] = await scene.createEmbeddedDocuments("Region", [regionData]);
    if (!region) return activationFailure("regionNotCreated");
    indexHuntingGroundsRegion(region);

    [effect] = await sourceActor.createEmbeddedDocuments("ActiveEffect", [
      buildHuntingGroundsSessionEffectData({
        sourceActor,
        abilityItem,
        runtime,
        identifiers: { ...identifiers, regionUuid: region.uuid }
      })
    ], { animate: false });
    if (!effect) {
      await region.delete();
      return activationFailure("effectNotCreated");
    }
    indexHuntingGroundsEffect(effect);
    await checkCurrentHuntingGroundsRegionTargets(region, { useSceneFallback: true });
    return {
      success: true,
      reason: "created",
      effect,
      region,
      session: getHuntingGroundsSessionData(effect)
    };
  } catch (error) {
    console.error(`${SYSTEM_ID} | Hunting Grounds activation failed`, error);
    if (effect?.parent?.effects?.has?.(effect.id)) await effect.delete().catch(() => undefined);
    if (region?.parent?.regions?.has?.(region.id)) await region.delete().catch(() => undefined);
    return activationFailure("creationFailed");
  }
}

/** Build the native V14 Region source for a cubic, wall-independent zone. */
export function createHuntingGroundsSquareRegionData({
  scene = null,
  center = null,
  sourceActor = null,
  abilityItem = null,
  runtime = {},
  identifiers = {}
} = {}) {
  const sidePixels = metersToPixels(runtime.zoneSizeMeters, scene);
  const x = Number(center?.x) || 0;
  const y = Number(center?.y) || 0;
  const levelId = String(center?.levelId ?? "").trim();
  const elevationCenter = finiteNumber(center?.elevationCenter, finiteNumber(center?.elevation));
  const halfHeight = Math.max(0, finiteNumber(runtime.zoneSizeMeters)) / 2;
  const elevationBottom = elevationCenter - halfHeight;
  const elevationTop = elevationCenter + halfHeight;
  const now = Number(identifiers.createdAt) || getWorldTime();
  const interval = Math.max(1, toInteger(runtime.checkIntervalSeconds));
  const flag = {
    ...identifiers,
    sourceActorUuid: String(identifiers.sourceActorUuid ?? sourceActor?.uuid ?? ""),
    abilityItemId: String(identifiers.abilityItemId ?? abilityItem?.id ?? ""),
    nextCheckAt: now + interval,
    settings: cloneData(runtime)
  };
  return {
    name: `${String(abilityItem?.name ?? "Охотничьи угодья")}: зона`,
    color: "#7f9f55",
    shapes: [{
      type: "rectangle",
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(sidePixels),
      height: Math.round(sidePixels),
      anchorX: 0.5,
      anchorY: 0.5,
      rotation: 0,
      gridBased: true
    }],
    elevation: { bottom: elevationBottom, top: elevationTop, topInclusive: true },
    levels: collectIntersectingLevelIds(scene, elevationBottom, elevationTop, levelId),
    restriction: { enabled: false, type: "move", priority: 0 },
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    highlightMode: "shapes",
    displayMeasurements: false,
    behaviors: [],
    flags: {
      [SYSTEM_ID]: {
        [HUNTING_GROUNDS_REGION_FLAG_KEY]: flag
      }
    }
  };
}

/** Find the still-live source session matching this exact ability function. */
export function findActiveHuntingGroundsSession(sourceActor, abilityItem = null, abilityFunction = null) {
  if (!sourceActor) return null;
  const itemId = normalizeDocumentId(abilityItem);
  const functionId = normalizeDocumentId(abilityFunction);
  const indexed = sessionEffectsBySourceActor.get(String(sourceActor.uuid ?? ""));
  const candidates = indexed?.size
    ? Array.from(indexed, uuid => indexedEffects.get(uuid)).filter(Boolean)
    : Array.from(sourceActor.effects ?? []);
  const now = getWorldTime();
  return candidates.find(effect => {
    const data = getHuntingGroundsSessionData(effect);
    if (!data || !isEffectLive(effect, data, now)) return false;
    if (itemId && data.abilityItemId !== itemId && data.abilityItemUuid !== String(abilityItem?.uuid ?? "")) return false;
    if (functionId && data.functionId !== functionId) return false;
    return true;
  }) ?? null;
}

/** Return normalized source-session flag data, or null for another effect. */
export function getHuntingGroundsSessionData(effect = null) {
  const raw = readFlag(effect, HUNTING_GROUNDS_SESSION_EFFECT_FLAG_KEY);
  if (!raw?.sessionId || !raw?.sourceActorUuid) return null;
  return {
    ...cloneData(raw),
    sessionId: String(raw.sessionId),
    sourceActorUuid: String(raw.sourceActorUuid),
    sourceTokenUuid: String(raw.sourceTokenUuid ?? ""),
    regionUuid: String(raw.regionUuid ?? ""),
    abilityItemId: String(raw.abilityItemId ?? ""),
    abilityItemUuid: String(raw.abilityItemUuid ?? ""),
    functionId: String(raw.functionId ?? ""),
    createdAt: finiteNumber(raw.createdAt),
    expiresAt: finiteNumber(raw.expiresAt),
    settings: normalizeStoredRuntimeSettings(raw.settings)
  };
}

/** Return normalized Prey/Target state, or null for another effect. */
export function getHuntingGroundsPreyData(effect = null) {
  const raw = readFlag(effect, HUNTING_GROUNDS_PREY_EFFECT_FLAG_KEY);
  if (!raw?.sessionId || !raw?.sourceActorUuid || !raw?.targetActorUuid) return null;
  const maxMarks = Math.max(1, toInteger(raw.maxMarks ?? raw.settings?.maxMarks ?? 4));
  return {
    ...cloneData(raw),
    sessionId: String(raw.sessionId),
    sourceActorUuid: String(raw.sourceActorUuid),
    sourceTokenUuid: String(raw.sourceTokenUuid ?? ""),
    targetActorUuid: String(raw.targetActorUuid),
    targetTokenUuid: String(raw.targetTokenUuid ?? ""),
    regionUuid: String(raw.regionUuid ?? ""),
    abilityItemId: String(raw.abilityItemId ?? ""),
    functionId: String(raw.functionId ?? ""),
    createdAt: finiteNumber(raw.createdAt),
    expiresAt: finiteNumber(raw.expiresAt),
    marks: Math.max(0, Math.min(maxMarks, toInteger(raw.marks))),
    maxMarks,
    actionPointProgress: Math.max(0, toInteger(raw.actionPointProgress)),
    movementPointProgress: Math.max(0, toInteger(raw.movementPointProgress)),
    actionPointThreshold: Math.max(1, toInteger(raw.actionPointThreshold ?? 4)),
    movementPointThreshold: Math.max(1, toInteger(raw.movementPointThreshold ?? 6)),
    incomingDamagePercentPerMark: toInteger(raw.incomingDamagePercentPerMark ?? 20),
    accuracyPerMark: toInteger(raw.accuracyPerMark ?? 40)
  };
}

/**
 * Pure resource accumulator. AP and MP never share progress, and completed
 * thresholds above the cap are discarded instead of being banked invisibly.
 */
export function advanceHuntingGroundsMarks(state = {}, resources = {}) {
  const maxMarks = Math.max(1, toInteger(state.maxMarks ?? 4));
  const actionPointThreshold = Math.max(1, toInteger(state.actionPointThreshold ?? 4));
  const movementPointThreshold = Math.max(1, toInteger(state.movementPointThreshold ?? 6));
  const actionSpent = Math.max(0, toInteger(resources.actionPoints));
  const movementSpent = Math.max(0, toInteger(resources.movementPoints));
  const actionTotal = Math.max(0, toInteger(state.actionPointProgress)) + actionSpent;
  const movementTotal = Math.max(0, toInteger(state.movementPointProgress)) + movementSpent;
  const actionGains = Math.floor(actionTotal / actionPointThreshold);
  const movementGains = Math.floor(movementTotal / movementPointThreshold);
  const previousMarks = Math.max(0, Math.min(maxMarks, toInteger(state.marks)));
  const marks = Math.min(maxMarks, previousMarks + actionGains + movementGains);
  return {
    marks,
    maxMarks,
    actionPointThreshold,
    movementPointThreshold,
    actionPointProgress: actionTotal % actionPointThreshold,
    movementPointProgress: movementTotal % movementPointThreshold,
    gainedMarks: marks - previousMarks,
    completedThresholds: actionGains + movementGains
  };
}

/** Update marks directly while retaining Prey even at zero marks. */
export async function updateHuntingGroundsMarks(effect, marks, {
  actionPointProgress = undefined,
  movementPointProgress = undefined
} = {}) {
  return queuePreyEffectMutation(effect, current => updateHuntingGroundsMarksNow(current, marks, {
    actionPointProgress,
    movementPointProgress
  }));
}

async function updateHuntingGroundsMarksNow(effect, marks, {
  actionPointProgress = undefined,
  movementPointProgress = undefined
} = {}) {
  const current = resolveCurrentEffect(effect);
  const data = getHuntingGroundsPreyData(current);
  if (!current || !data || !isEffectLive(current, data) || !canMutateHuntingGroundsEffect(current)) return null;
  const nextMarks = Math.max(0, Math.min(data.maxMarks, toInteger(marks)));
  const update = {
    name: buildPreyEffectName(nextMarks),
    "system.changes": buildPreyEffectChanges(
      nextMarks,
      data.incomingDamagePercentPerMark,
      data.accuracyPerMark
    ),
    [`flags.${SYSTEM_ID}.${HUNTING_GROUNDS_PREY_EFFECT_FLAG_KEY}.marks`]: nextMarks
  };
  if (actionPointProgress !== undefined) {
    update[`flags.${SYSTEM_ID}.${HUNTING_GROUNDS_PREY_EFFECT_FLAG_KEY}.actionPointProgress`] = Math.max(0, toInteger(actionPointProgress));
  }
  if (movementPointProgress !== undefined) {
    update[`flags.${SYSTEM_ID}.${HUNTING_GROUNDS_PREY_EFFECT_FLAG_KEY}.movementPointProgress`] = Math.max(0, toInteger(movementPointProgress));
  }
  await current.update(update, { animate: false });
  return resolveCurrentEffect(current);
}

/** Consume marks after the free aimed attack has actually executed. */
export async function consumeHuntingGroundsMarks(effectOrActor, count = 2, session = null) {
  const effect = resolvePreyEffectArgument(effectOrActor, session);
  const requested = Math.max(0, toInteger(count));
  if (!effect || requested <= 0) {
    const data = getHuntingGroundsPreyData(effect);
    return { success: false, previous: data?.marks ?? 0, consumed: 0, marks: data?.marks ?? 0, effect: effect ?? null };
  }
  return queuePreyEffectMutation(effect, async current => {
    const data = getHuntingGroundsPreyData(current);
    if (!current || !data || data.marks < requested) {
      return { success: false, previous: data?.marks ?? 0, consumed: 0, marks: data?.marks ?? 0, effect: current ?? null };
    }
    const updated = await updateHuntingGroundsMarksNow(current, data.marks - requested);
    if (!updated) return { success: false, previous: data.marks, consumed: 0, marks: data.marks, effect: current };
    return { success: true, previous: data.marks, consumed: requested, marks: data.marks - requested, effect: updated };
  });
}

/** Delete the Region, source effect, and every persistent Prey effect for one session. */
export async function cleanupHuntingGroundsSession(sessionOrEffect, {
  deleteRegion = true,
  deleteSourceEffect = true,
  deletePreyEffects = true
} = {}) {
  if (!isHuntingGroundsAuthority()) return false;
  const session = typeof sessionOrEffect === "string"
    ? { sessionId: sessionOrEffect }
    : (getHuntingGroundsSessionData(sessionOrEffect) ?? getHuntingGroundsPreyData(sessionOrEffect) ?? sessionOrEffect);
  const sessionId = String(session?.sessionId ?? "").trim();
  if (!sessionId || cleaningSessions.has(sessionId)) return false;
  cleaningSessions.add(sessionId);
  try {
    if (deletePreyEffects) {
      const preyEffects = getIndexedPreyEffectsForSession(sessionId);
      for (const effect of preyEffects) {
        const current = resolveCurrentEffect(effect);
        if (current) await current.delete({ animate: false });
      }
    }
    if (deleteSourceEffect) {
      for (const effect of getIndexedSessionEffects(sessionId)) {
        const current = resolveCurrentEffect(effect);
        if (current) await current.delete({ animate: false });
      }
    }
    if (deleteRegion) {
      const region = resolveHuntingGroundsRegion(session?.regionUuid, sessionId);
      if (region?.parent?.regions?.has?.(region.id)) await region.delete();
    }
    return true;
  } finally {
    cleaningSessions.delete(sessionId);
    scheduleHuntingGroundsVisibilityRefresh(true);
  }
}

function registerHuntingGroundsDetectionMode() {
  const detectionModes = globalThis.CONFIG?.Canvas?.detectionModes;
  const DetectionModeAll = globalThis.foundry?.canvas?.perception?.DetectionModeAll;
  const DetectionMode = globalThis.foundry?.canvas?.perception?.DetectionMode;
  if (!detectionModes || !DetectionModeAll || !DetectionMode) return false;
  if (detectionModes[HUNTING_GROUNDS_DETECTION_MODE_ID]) return true;

  class HuntingGroundsDetectionMode extends DetectionModeAll {
    constructor() {
      super({
        id: HUNTING_GROUNDS_DETECTION_MODE_ID,
        label: "Охотничьи угодья: Добыча",
        tokenConfig: false,
        walls: false,
        angle: false,
        type: DetectionMode.DETECTION_TYPES.OTHER
      });
    }

    _canDetect(visionSource, target) {
      const sourceUuid = String(visionSource?.object?.document?.uuid ?? "");
      const targetUuid = String(target?.document?.uuid ?? "");
      const expiresAt = detectableHuntersByTargetToken.get(targetUuid)?.get(sourceUuid);
      return Boolean(sourceUuid && targetUuid && Number(expiresAt) > getWorldTime());
    }

    _testRange() {
      return true;
    }

    _testLOS() {
      return true;
    }
  }

  detectionModes[HUNTING_GROUNDS_DETECTION_MODE_ID] = new HuntingGroundsDetectionMode();
  return true;
}

async function processHuntingGroundsWorldTime(worldTime) {
  if (!isHuntingGroundsAuthority()) return;
  const now = Number(worldTime) || getWorldTime();
  for (const region of Array.from(indexedRegions.values())) {
    const current = resolveCurrentRegion(region);
    const data = getHuntingGroundsRegionData(current);
    if (!current || !data) continue;
    const interval = Math.max(1, toInteger(data.settings.checkIntervalSeconds));
    let nextCheckAt = Number(data.nextCheckAt) || (Number(data.createdAt) + interval);
    while (nextCheckAt <= now && nextCheckAt < Number(data.expiresAt)) {
      await checkCurrentHuntingGroundsRegionTargets(current);
      nextCheckAt += interval;
    }
    if (now >= Number(data.expiresAt)) {
      await cleanupHuntingGroundsSession(data, { deleteRegion: true });
      continue;
    }
    if (nextCheckAt !== Number(data.nextCheckAt)) {
      await current.update({
        [`flags.${SYSTEM_ID}.${HUNTING_GROUNDS_REGION_FLAG_KEY}.nextCheckAt`]: nextCheckAt
      }, { render: false });
    }
  }
}

async function observeHuntingGroundsResourceSpent({ event } = {}) {
  if (!isHuntingGroundsAuthority() || String(event?.key ?? "") !== RESOURCE_EVENT_KEY) return [];
  const actorUuid = String(event?.data?.actorUuid ?? "");
  const effectUuids = preyEffectsByTargetActor.get(actorUuid);
  if (!effectUuids?.size) return [];
  const resources = event?.data?.resources ?? {};
  const actionPoints = Math.max(0, toInteger(resources.actionPoints));
  const movementPoints = Math.max(0, toInteger(resources.movementPoints));
  if (!actionPoints && !movementPoints) return [];

  const results = [];
  for (const uuid of Array.from(effectUuids)) {
    const result = await queuePreyEffectMutation(indexedEffects.get(uuid), async effect => {
      const data = getHuntingGroundsPreyData(effect);
      if (!effect || !data || !isEffectLive(effect, data) || data.marks >= data.maxMarks) return null;
      const advanced = advanceHuntingGroundsMarks(data, { actionPoints, movementPoints });
      const changed = advanced.marks !== data.marks
        || advanced.actionPointProgress !== data.actionPointProgress
        || advanced.movementPointProgress !== data.movementPointProgress;
      if (!changed) return null;
      const updated = await updateHuntingGroundsMarksNow(effect, advanced.marks, advanced);
      return { effect: updated, ...advanced };
    });
    if (result) results.push(result);
  }
  return results;
}

function queueHuntingGroundsTokenMovement(tokenDocument, movement) {
  if (!isHuntingGroundsAuthority() || !movement || !tokenDocument?.actor || isPhantomEntity(tokenDocument)) return;
  const sceneRegions = regionUuidsByScene.get(String(tokenDocument.parent?.id ?? ""));
  if (!sceneRegions?.size) return;
  movementQueue = movementQueue
    .catch(() => undefined)
    .then(() => processHuntingGroundsTokenMovement(tokenDocument, movement))
    .catch(error => console.error(`${SYSTEM_ID} | Hunting Grounds entry check failed`, error));
}

async function processHuntingGroundsTokenMovement(tokenDocument, movement) {
  const path = [movement.origin, ...(movement.passed?.waypoints ?? [])].filter(Boolean);
  if (path.length < 2 || typeof tokenDocument.segmentizeRegionMovementPath !== "function") return;
  const regionUuids = Array.from(regionUuidsByScene.get(String(tokenDocument.parent?.id ?? "")) ?? []);
  const now = getWorldTime();
  for (const uuid of regionUuids) {
    const region = resolveCurrentRegion(indexedRegions.get(uuid));
    const data = getHuntingGroundsRegionData(region);
    if (!region || !data || now >= data.expiresAt) continue;
    const entered = movementPathEntersHuntingGroundsRegion(tokenDocument, region, path);
    if (entered) await requestHuntingGroundsPreyCheck(region, tokenDocument);
  }
}

export function movementPathEntersHuntingGroundsRegion(tokenDocument, region, path = []) {
  let from = path[0];
  if (!from) return false;
  let fromLevel = String(from.level ?? tokenDocument?._source?.level ?? "");
  let fromInside = testTokenWaypointInsideRegion(tokenDocument, region, from, fromLevel);
  for (let index = 1; index < path.length; index += 1) {
    const to = path[index];
    const toLevel = String(to?.level ?? fromLevel);
    const toInside = testTokenWaypointInsideRegion(tokenDocument, region, to, toLevel);
    if (!fromInside && toInside) return true;
    if (
      fromLevel === toLevel
      && tokenDocument.segmentizeRegionMovementPath(region, [
        { ...from, level: fromLevel },
        { ...to, level: toLevel }
      ]).some(segment => segment.type === CONST.REGION_MOVEMENT_SEGMENTS.ENTER)
    ) return true;
    from = to;
    fromLevel = toLevel;
    fromInside = toInside;
  }
  return false;
}

function testTokenWaypointInsideRegion(tokenDocument, region, waypoint, level) {
  try {
    return tokenDocument.testInsideRegion(region, { ...waypoint, level });
  } catch (_error) {
    return false;
  }
}

async function checkCurrentHuntingGroundsRegionTargets(region, { useSceneFallback = false } = {}) {
  const current = resolveCurrentRegion(region);
  const data = getHuntingGroundsRegionData(current);
  if (!current || !data || !isHuntingGroundsAuthority() || getWorldTime() >= data.expiresAt) return [];
  let tokens = Array.from(current.tokens ?? []);
  if (useSceneFallback && !tokens.length) {
    tokens = Array.from(current.parent?.tokens ?? []).filter(token => {
      if (token?._regions?.has?.(current.id) || token?._source?._regions?.includes?.(current.id)) return true;
      try {
        return token?.testInsideRegion?.(current) === true;
      } catch (_error) {
        return false;
      }
    });
  }
  const results = [];
  for (const token of tokens) results.push(await requestHuntingGroundsPreyCheck(current, token));
  return results;
}

async function requestHuntingGroundsPreyCheck(region, targetToken) {
  const regionData = getHuntingGroundsRegionData(region);
  const targetActor = targetToken?.actor;
  if (!regionData || !targetActor || isPhantomEntity(targetToken) || isPhantomEntity(targetActor)) return false;
  const sourceActor = resolveUuidSync(regionData.sourceActorUuid);
  const sourceToken = resolveUuidSync(regionData.sourceTokenUuid);
  if (!sourceActor || !sourceToken || getActorFactionRelation(sourceActor, targetActor) === "ally") return false;
  if (findSessionPreyEffect(targetActor, regionData.sessionId, targetToken)) return false;

  const lockKey = `${regionData.sessionId}${INDEX_SEPARATOR}${String(targetToken.uuid ?? targetActor.uuid ?? "")}`;
  const prior = preyCheckLocks.get(lockKey);
  if (prior) return prior;
  const operation = performHuntingGroundsPreyCheck({
    region,
    regionData,
    sourceActor,
    sourceToken,
    targetActor,
    targetToken
  }).finally(() => {
    if (preyCheckLocks.get(lockKey) === operation) preyCheckLocks.delete(lockKey);
  });
  preyCheckLocks.set(lockKey, operation);
  return operation;
}

async function performHuntingGroundsPreyCheck({
  region,
  regionData,
  sourceActor,
  sourceToken,
  targetActor,
  targetToken
}) {
  if (findSessionPreyEffect(targetActor, regionData.sessionId, targetToken)) return false;
  const settings = regionData.settings;
  const { requestSkillCheck } = await import("../rolls/skill-check.mjs");
  const outcome = await requestSkillCheck({
    actor: targetActor,
    skillKey: settings.targetSkillKey,
    data: {
      difficulty: settings.difficulty,
      actorToken: targetToken.object ?? targetToken,
      targetActor: sourceActor,
      targetToken: sourceToken.object ?? sourceToken,
      allowImplicitTarget: false
    },
    animate: false,
    prompt: false,
    requester: "huntingGrounds"
  });
  const resultKey = String(outcome?.result?.key ?? outcome?.resultKey ?? "");
  if (!["failure", "criticalFailure"].includes(resultKey)) return false;
  const currentRegion = resolveCurrentRegion(region);
  const currentRegionData = getHuntingGroundsRegionData(currentRegion);
  if (
    !isHuntingGroundsAuthority()
    || cleaningSessions.has(regionData.sessionId)
    || getWorldTime() >= regionData.expiresAt
    || currentRegionData?.sessionId !== regionData.sessionId
    || !findLiveIndexedSessionEffect(regionData.sessionId, regionData.sourceActorUuid)
  ) return false;
  if (findSessionPreyEffect(targetActor, regionData.sessionId, targetToken)) return false;

  const remaining = Math.max(0, regionData.expiresAt - getWorldTime());
  const preyData = {
    sessionId: regionData.sessionId,
    sourceActorUuid: regionData.sourceActorUuid,
    sourceTokenUuid: regionData.sourceTokenUuid,
    targetActorUuid: String(targetActor.uuid ?? ""),
    targetTokenUuid: String(targetToken.uuid ?? ""),
    regionUuid: String(currentRegion.uuid ?? ""),
    abilityItemId: regionData.abilityItemId,
    abilityItemUuid: regionData.abilityItemUuid,
    functionId: regionData.functionId,
    fixedKey: regionData.fixedKey,
    createdAt: getWorldTime(),
    expiresAt: regionData.expiresAt,
    marks: Math.min(settings.maxMarks, settings.initialMarks),
    maxMarks: settings.maxMarks,
    actionPointProgress: 0,
    movementPointProgress: 0,
    actionPointThreshold: settings.actionPointThreshold,
    movementPointThreshold: settings.movementPointThreshold,
    incomingDamagePercentPerMark: settings.incomingDamagePercentPerMark,
    accuracyPerMark: settings.accuracyPerMark
  };
  const [effect] = await targetActor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: buildPreyEffectName(preyData.marks),
    img: resolveUuidSync(regionData.abilityItemUuid)?.img || DEFAULT_ICON,
    origin: regionData.abilityItemUuid || sourceActor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: { seconds: remaining, startTime: getWorldTime() },
    system: {
      changes: buildPreyEffectChanges(
        preyData.marks,
        preyData.incomingDamagePercentPerMark,
        preyData.accuracyPerMark
      )
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [HUNTING_GROUNDS_PREY_EFFECT_FLAG_KEY]: preyData
      }
    }
  }], { animate: false });
  if (effect) {
    indexHuntingGroundsEffect(effect);
    scheduleHuntingGroundsVisibilityRefresh();
  }
  return Boolean(effect);
}

function buildHuntingGroundsSessionEffectData({ sourceActor, abilityItem, runtime, identifiers }) {
  return {
    type: "base",
    name: String(abilityItem?.name ?? "Охотничьи угодья"),
    img: abilityItem?.img || DEFAULT_ICON,
    origin: abilityItem?.uuid ?? sourceActor?.uuid ?? "",
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: { seconds: runtime.durationSeconds, startTime: identifiers.createdAt },
    system: {
      changes: [{
        key: getDetectionModeRangeEffectKey(HUNTING_GROUNDS_DETECTION_MODE_ID),
        type: "add",
        value: "1",
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [HUNTING_GROUNDS_SESSION_EFFECT_FLAG_KEY]: {
          ...identifiers,
          settings: cloneData(runtime)
        }
      }
    }
  };
}

function onCreateOrUpdateHuntingGroundsEffect(effect, changes = {}) {
  const previous = indexedEffectData.get(String(effect?.uuid ?? ""));
  const previousPair = previous?.kind === "prey"
    ? tokenPairKey(previous.data.sourceTokenUuid, previous.data.targetTokenUuid)
    : "";
  const previousDetectable = previous?.kind === "prey" && isTokenPairDetectable(previous.data);
  unindexHuntingGroundsEffect(effect);
  indexHuntingGroundsEffect(effect);
  const current = indexedEffectData.get(String(effect?.uuid ?? ""));
  const currentPair = current?.kind === "prey"
    ? tokenPairKey(current.data.sourceTokenUuid, current.data.targetTokenUuid)
    : "";
  const currentDetectable = current?.kind === "prey" && isTokenPairDetectable(current.data);
  if (
    previousPair !== currentPair
    || previousDetectable !== currentDetectable
    || current?.kind === "session"
    || previous?.kind === "session"
  ) {
    scheduleHuntingGroundsVisibilityRefresh(current?.kind === "session" || previous?.kind === "session");
  }
  if (!isHuntingGroundsAuthority()) return;
  const removedOrDisabledSession = previous?.kind === "session"
    && (current?.kind !== "session" || effect.disabled || changes?.disabled === true);
  if (removedOrDisabledSession) {
    void cleanupHuntingGroundsSession(previous.data);
  }
}

function onDeleteHuntingGroundsEffect(effect) {
  const cached = indexedEffectData.get(String(effect?.uuid ?? ""));
  const session = cached?.kind === "session" ? cached.data : null;
  const inSessionCleanup = Boolean(
    cached?.data?.sessionId && cleaningSessions.has(cached.data.sessionId)
  );
  unindexHuntingGroundsEffect(effect);
  if (cached && !inSessionCleanup) {
    scheduleHuntingGroundsVisibilityRefresh(cached.kind === "session");
  }
  if (session && isHuntingGroundsAuthority() && !cleaningSessions.has(session.sessionId)) {
    void cleanupHuntingGroundsSession(session, { deleteSourceEffect: false });
  }
}

function onCreateOrUpdateHuntingGroundsRegion(region) {
  unindexHuntingGroundsRegion(region);
  indexHuntingGroundsRegion(region);
}

function onDeleteHuntingGroundsRegion(region) {
  const data = getHuntingGroundsRegionData(region);
  unindexHuntingGroundsRegion(region);
  if (data && isHuntingGroundsAuthority() && !cleaningSessions.has(data.sessionId)) {
    void cleanupHuntingGroundsSession(data, { deleteRegion: false });
  }
}

function onDeleteHuntingGroundsToken(token) {
  const tokenUuid = String(token?.uuid ?? "");
  if (!tokenUuid || !isHuntingGroundsAuthority()) return;
  const sessions = Array.from(indexedEffectData.values())
    .filter(entry => entry.kind === "session" && entry.data.sourceTokenUuid === tokenUuid)
    .map(entry => entry.data);
  for (const session of sessions) void cleanupHuntingGroundsSession(session);
}

function onHuntingGroundsCanvasReady() {
  if (!indexesInitialized) {
    rebuildHuntingGroundsIndexes();
    return;
  }
  if (indexedEffectData.size) scheduleHuntingGroundsVisibilityRefresh(true);
}

function rebuildHuntingGroundsIndexes() {
  indexedEffects.clear();
  indexedEffectData.clear();
  sessionEffectsBySourceActor.clear();
  preyEffectsByTargetActor.clear();
  preyEffectsByTokenPair.clear();
  detectableHuntersByTargetToken.clear();
  indexedRegions.clear();
  regionUuidsByScene.clear();

  const actors = new Map();
  for (const actor of game.actors?.contents ?? []) actors.set(actor.uuid, actor);
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens?.contents ?? scene.tokens ?? []) {
      if (token?.actor?.uuid) actors.set(token.actor.uuid, token.actor);
    }
    for (const region of scene.regions?.contents ?? scene.regions ?? []) indexHuntingGroundsRegion(region);
  }
  for (const actor of actors.values()) {
    for (const effect of actor.effects ?? []) indexHuntingGroundsEffect(effect);
  }
  indexesInitialized = true;
  if (indexedEffectData.size) scheduleHuntingGroundsVisibilityRefresh(true);
}

function indexHuntingGroundsEffect(effect) {
  const uuid = String(effect?.uuid ?? "");
  if (!uuid) return;
  const session = getHuntingGroundsSessionData(effect);
  if (session) {
    indexedEffects.set(uuid, effect);
    indexedEffectData.set(uuid, { kind: "session", data: session });
    addSetMapValue(sessionEffectsBySourceActor, session.sourceActorUuid, uuid);
    return;
  }
  const prey = getHuntingGroundsPreyData(effect);
  if (!prey) return;
  indexedEffects.set(uuid, effect);
  indexedEffectData.set(uuid, { kind: "prey", data: prey });
  addSetMapValue(preyEffectsByTargetActor, prey.targetActorUuid, uuid);
  if (prey.sourceTokenUuid && prey.targetTokenUuid && isEffectLive(effect, prey)) {
    addSetMapValue(preyEffectsByTokenPair, tokenPairKey(prey.sourceTokenUuid, prey.targetTokenUuid), uuid);
    const hunters = detectableHuntersByTargetToken.get(prey.targetTokenUuid) ?? new Map();
    hunters.set(prey.sourceTokenUuid, Math.max(
      Number(hunters.get(prey.sourceTokenUuid)) || 0,
      prey.expiresAt
    ));
    detectableHuntersByTargetToken.set(prey.targetTokenUuid, hunters);
  }
}

function unindexHuntingGroundsEffect(effect) {
  const uuid = String(effect?.uuid ?? effect ?? "");
  const entry = indexedEffectData.get(uuid);
  if (!entry) return;
  indexedEffects.delete(uuid);
  indexedEffectData.delete(uuid);
  if (entry.kind === "session") {
    deleteSetMapValue(sessionEffectsBySourceActor, entry.data.sourceActorUuid, uuid);
    return;
  }
  deleteSetMapValue(preyEffectsByTargetActor, entry.data.targetActorUuid, uuid);
  if (entry.data.sourceTokenUuid && entry.data.targetTokenUuid) {
    deleteSetMapValue(
      preyEffectsByTokenPair,
      tokenPairKey(entry.data.sourceTokenUuid, entry.data.targetTokenUuid),
      uuid
    );
    reindexDetectableTokenPair(entry.data.sourceTokenUuid, entry.data.targetTokenUuid);
  }
}

function reindexDetectableTokenPair(sourceTokenUuid, targetTokenUuid) {
  const sourceUuid = String(sourceTokenUuid ?? "");
  const targetUuid = String(targetTokenUuid ?? "");
  if (!sourceUuid || !targetUuid) return;
  let expiresAt = 0;
  const uuids = preyEffectsByTokenPair.get(tokenPairKey(sourceUuid, targetUuid));
  for (const uuid of uuids ?? []) {
    const entry = indexedEffectData.get(uuid);
    if (entry?.kind !== "prey") continue;
    const effect = indexedEffects.get(uuid);
    if (!isEffectLive(effect, entry.data)) continue;
    expiresAt = Math.max(expiresAt, Number(entry.data.expiresAt) || 0);
  }
  const hunters = detectableHuntersByTargetToken.get(targetUuid);
  if (expiresAt > 0) {
    const next = hunters ?? new Map();
    next.set(sourceUuid, expiresAt);
    detectableHuntersByTargetToken.set(targetUuid, next);
    return;
  }
  hunters?.delete(sourceUuid);
  if (hunters && !hunters.size) detectableHuntersByTargetToken.delete(targetUuid);
}

function indexHuntingGroundsRegion(region) {
  const data = getHuntingGroundsRegionData(region);
  const uuid = String(region?.uuid ?? "");
  if (!data || !uuid) return;
  indexedRegions.set(uuid, region);
  addSetMapValue(regionUuidsByScene, String(region.parent?.id ?? ""), uuid);
}

function unindexHuntingGroundsRegion(region) {
  const uuid = String(region?.uuid ?? region ?? "");
  const indexed = indexedRegions.get(uuid);
  if (!indexed) return;
  indexedRegions.delete(uuid);
  deleteSetMapValue(regionUuidsByScene, String(indexed.parent?.id ?? ""), uuid);
}

function getHuntingGroundsRegionData(region) {
  const raw = readFlag(region, HUNTING_GROUNDS_REGION_FLAG_KEY);
  if (!raw?.sessionId || !raw?.sourceActorUuid) return null;
  return {
    ...cloneData(raw),
    sessionId: String(raw.sessionId),
    sourceActorUuid: String(raw.sourceActorUuid),
    sourceTokenUuid: String(raw.sourceTokenUuid ?? ""),
    abilityItemId: String(raw.abilityItemId ?? ""),
    abilityItemUuid: String(raw.abilityItemUuid ?? ""),
    functionId: String(raw.functionId ?? ""),
    fixedKey: String(raw.fixedKey ?? "huntingGrounds"),
    createdAt: finiteNumber(raw.createdAt),
    expiresAt: finiteNumber(raw.expiresAt),
    nextCheckAt: finiteNumber(raw.nextCheckAt),
    settings: normalizeStoredRuntimeSettings(raw.settings)
  };
}

function findSessionPreyEffect(targetActor, sessionId, _targetToken = null) {
  const uuids = preyEffectsByTargetActor.get(String(targetActor?.uuid ?? ""));
  if (uuids?.size) {
    for (const uuid of uuids) {
      const effect = resolveCurrentEffect(indexedEffects.get(uuid));
      const data = getHuntingGroundsPreyData(effect);
      if (!effect || !data || data.sessionId !== sessionId || !isEffectLive(effect, data)) continue;
      return effect;
    }
  }
  return Array.from(targetActor?.effects ?? []).find(effect => {
    const data = getHuntingGroundsPreyData(effect);
    return data?.sessionId === sessionId
      && isEffectLive(effect, data);
  }) ?? null;
}

function getIndexedPreyEffectsForSession(sessionId) {
  const effects = [];
  for (const [uuid, entry] of indexedEffectData) {
    if (entry.kind === "prey" && entry.data.sessionId === sessionId) {
      const effect = indexedEffects.get(uuid);
      if (effect) effects.push(effect);
    }
  }
  return effects;
}

function getIndexedSessionEffects(sessionId) {
  const effects = [];
  for (const [uuid, entry] of indexedEffectData) {
    if (entry.kind === "session" && entry.data.sessionId === sessionId) {
      const effect = indexedEffects.get(uuid);
      if (effect) effects.push(effect);
    }
  }
  return effects;
}

function findLiveIndexedSessionEffect(sessionId, sourceActorUuid) {
  const uuids = sessionEffectsBySourceActor.get(String(sourceActorUuid ?? ""));
  if (!uuids?.size) return null;
  for (const uuid of uuids) {
    const effect = resolveCurrentEffect(indexedEffects.get(uuid));
    const data = getHuntingGroundsSessionData(effect);
    if (data?.sessionId === sessionId && isEffectLive(effect, data)) return effect;
  }
  return null;
}

function resolveHuntingGroundsRegion(regionUuid = "", sessionId = "") {
  const direct = resolveCurrentRegion(indexedRegions.get(String(regionUuid ?? "")) ?? resolveUuidSync(regionUuid));
  if (direct && getHuntingGroundsRegionData(direct)?.sessionId === sessionId) return direct;
  return Array.from(indexedRegions.values()).find(region => (
    getHuntingGroundsRegionData(region)?.sessionId === sessionId
  )) ?? null;
}

function resolvePreyEffectArgument(effectOrActor, session = null) {
  if (getHuntingGroundsPreyData(effectOrActor)) return resolveCurrentEffect(effectOrActor);
  const actor = effectOrActor?.documentName === "Actor" ? effectOrActor : null;
  if (!actor) return null;
  const sessionId = String(
    session?.sessionId
    ?? getHuntingGroundsSessionData(session)?.sessionId
    ?? session
    ?? ""
  );
  return Array.from(actor.effects ?? []).find(effect => {
    const data = getHuntingGroundsPreyData(effect);
    return data && (!sessionId || data.sessionId === sessionId) && isEffectLive(effect, data);
  }) ?? null;
}

function queuePreyEffectMutation(effect, operation) {
  const uuid = String(effect?.uuid ?? "");
  if (!uuid || typeof operation !== "function") return Promise.resolve(null);
  const previous = preyEffectMutationQueues.get(uuid) ?? Promise.resolve();
  const queued = previous
    .catch(() => undefined)
    .then(() => operation(resolveCurrentEffect(effect)));
  preyEffectMutationQueues.set(uuid, queued);
  return queued.finally(() => {
    if (preyEffectMutationQueues.get(uuid) === queued) preyEffectMutationQueues.delete(uuid);
  });
}

function normalizeHuntingGroundsRuntimeSettings(settings, sourceActor) {
  const sourceSkillKey = String(settings?.sourceSkillKey ?? "naturalist").trim() || "naturalist";
  const difficultyBase = toInteger(settings?.difficultyBase ?? 50);
  const sourceSkillValue = toInteger(sourceActor?.system?.skills?.[sourceSkillKey]?.value);
  return normalizeStoredRuntimeSettings({
    zoneSizeMeters: settings?.zoneSizeMeters ?? 20,
    durationSeconds: settings?.durationSeconds ?? 30,
    checkIntervalSeconds: settings?.checkIntervalSeconds ?? 6,
    difficultyBase,
    difficulty: difficultyBase + sourceSkillValue,
    sourceSkillKey,
    sourceSkillValue,
    targetSkillKey: settings?.targetSkillKey ?? "stealth",
    initialMarks: settings?.initialMarks ?? 1,
    actionPointThreshold: settings?.actionPointThreshold ?? 4,
    movementPointThreshold: settings?.movementPointThreshold ?? 6,
    maxMarks: settings?.maxMarks ?? 4,
    incomingDamagePercentPerMark: settings?.incomingDamagePercentPerMark ?? 20,
    accuracyPerMark: settings?.accuracyPerMark ?? 40
  });
}

function normalizeStoredRuntimeSettings(settings = {}) {
  const maxMarks = Math.max(1, toInteger(settings.maxMarks ?? 4));
  return {
    zoneSizeMeters: Math.max(0, finiteNumber(settings.zoneSizeMeters, 20)),
    durationSeconds: Math.max(0, toInteger(settings.durationSeconds ?? 30)),
    checkIntervalSeconds: Math.max(1, toInteger(settings.checkIntervalSeconds ?? 6)),
    difficultyBase: toInteger(settings.difficultyBase ?? 50),
    difficulty: toInteger(settings.difficulty ?? 50),
    sourceSkillKey: String(settings.sourceSkillKey ?? "naturalist").trim() || "naturalist",
    sourceSkillValue: toInteger(settings.sourceSkillValue),
    targetSkillKey: String(settings.targetSkillKey ?? "stealth").trim() || "stealth",
    initialMarks: Math.max(0, Math.min(maxMarks, toInteger(settings.initialMarks ?? 1))),
    actionPointThreshold: Math.max(1, toInteger(settings.actionPointThreshold ?? 4)),
    movementPointThreshold: Math.max(1, toInteger(settings.movementPointThreshold ?? 6)),
    maxMarks,
    incomingDamagePercentPerMark: toInteger(settings.incomingDamagePercentPerMark ?? 20),
    accuracyPerMark: toInteger(settings.accuracyPerMark ?? 40)
  };
}

function normalizeCenter(center, sourceToken) {
  const object = sourceToken?.object;
  const sourceLevelId = String(sourceToken?._source?.level ?? sourceToken?.level ?? "").trim();
  const sourceLevel = sourceToken?.parent?.levels?.get?.(sourceLevelId);
  const fallback = object?.center ?? {
    x: Number(sourceToken?.x) + ((Number(sourceToken?.width) || 1) * (Number(sourceToken?.parent?.grid?.size) || 100) / 2),
    y: Number(sourceToken?.y) + ((Number(sourceToken?.height) || 1) * (Number(sourceToken?.parent?.grid?.size) || 100) / 2)
  };
  const x = Number(center?.x ?? fallback.x);
  const y = Number(center?.y ?? fallback.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y,
    elevation: Number.isFinite(Number(center?.elevation)) ? Number(center.elevation) : Number(sourceToken?.elevation) || 0,
    levelId: String(center?.levelId ?? sourceLevelId).trim(),
    elevationCenter: Number.isFinite(Number(center?.elevationCenter))
      ? Number(center.elevationCenter)
      : finiteNumber(sourceLevel?.elevation?.base, Number(sourceToken?.elevation) || 0)
  };
}

function collectIntersectingLevelIds(scene, bottom, top, fallbackLevelId = "") {
  const ids = [];
  for (const level of scene?.levels?.contents ?? scene?.levels ?? []) {
    const rawBottom = level?.elevation?.bottom;
    const rawTop = level?.elevation?.top;
    const levelBottom = rawBottom == null ? -Infinity : finiteNumber(rawBottom, -Infinity);
    const levelTop = rawTop == null ? Infinity : finiteNumber(rawTop, Infinity);
    if (levelBottom <= top && levelTop >= bottom && level?.id) ids.push(level.id);
  }
  const fallback = String(fallbackLevelId ?? "").trim();
  if (!ids.length && fallback && scene?.levels?.has?.(fallback)) ids.push(fallback);
  return ids;
}

function metersToPixels(meters, scene) {
  const gridSize = Math.max(1, Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100);
  const gridDistance = Math.max(0.0001, Number(scene?.grid?.distance ?? canvas?.grid?.distance ?? 1) || 1);
  return Math.max(1, Number(meters) || 0) * (gridSize / gridDistance);
}

function buildPreyEffectName(marks) {
  const count = Math.max(0, toInteger(marks));
  return count > 0 ? `Охотничьи угодья: Добыча · Мишень ×${count}` : "Охотничьи угодья: Добыча";
}

export function buildPreyEffectChanges(marks, incomingDamagePercentPerMark, accuracyPerMark) {
  const count = Math.max(0, toInteger(marks));
  if (!count) return [];
  const change = (key, value) => ({
    key,
    type: "add",
    value: String(value),
    phase: "initial",
    priority: null
  });
  return [
    change(
      getReverseEffectKey("system.combat.damagePercent"),
      count * toInteger(incomingDamagePercentPerMark)
    ),
    change("system.combat.accuracy", count * toInteger(accuracyPerMark)),
    change(ATTACK_CRITICAL_FAILURE_DISABLED_EFFECT_KEY, 1)
  ];
}

function scheduleHuntingGroundsVisibilityRefresh(initializeVision = false) {
  visibilityInitializeQueued ||= initializeVision;
  if (visibilityRefreshQueued) return;
  visibilityRefreshQueued = true;
  queueMicrotask(() => {
    const initialize = visibilityInitializeQueued;
    visibilityRefreshQueued = false;
    visibilityInitializeQueued = false;
    for (const token of canvas?.tokens?.placeables ?? []) {
      token?.renderFlags?.set?.({ refreshVisibility: true });
    }
    canvas?.perception?.update?.({ initializeVision: initialize, refreshVision: true });
  });
}

function isHuntingGroundsAuthority() {
  return Boolean(game.user?.isActiveGM || (
    game.user?.id && game.users?.activeGM?.id === game.user.id
  ));
}

function canMutateHuntingGroundsEffect(effect) {
  return Boolean(isHuntingGroundsAuthority() || effect?.parent?.isOwner);
}

function isEffectLive(effect, data, now = getWorldTime()) {
  return Boolean(effect && data && !effect.disabled && Number(data.expiresAt) > now);
}

function resolveCurrentEffect(effect) {
  if (!effect?.parent || !effect?.id) return null;
  return effect.parent.effects?.get?.(effect.id) ?? null;
}

function resolveCurrentRegion(region) {
  if (!region?.parent || !region?.id) return null;
  return region.parent.regions?.get?.(region.id) ?? null;
}

function getTokenDocument(token) {
  return token?.document ?? token ?? null;
}

function resolveUuidSync(uuid) {
  const value = String(uuid ?? "").trim();
  return value ? globalThis.fromUuidSync?.(value) ?? null : null;
}

function readFlag(document, key) {
  return document?.getFlag?.(SYSTEM_ID, key)
    ?? document?.flags?.[SYSTEM_ID]?.[key]
    ?? document?._source?.flags?.[SYSTEM_ID]?.[key]
    ?? null;
}

function cloneData(value) {
  if (value == null) return value;
  return globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value);
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getWorldTime() {
  return finiteNumber(globalThis.game?.time?.worldTime, 0);
}

function normalizeDocumentId(value) {
  if (typeof value === "string") return value.trim();
  return String(value?.id ?? "").trim();
}

function tokenPairKey(sourceTokenUuid, targetTokenUuid) {
  return `${String(sourceTokenUuid ?? "")}${INDEX_SEPARATOR}${String(targetTokenUuid ?? "")}`;
}

function isTokenPairDetectable(data = {}) {
  const sourceUuid = String(data.sourceTokenUuid ?? "");
  const targetUuid = String(data.targetTokenUuid ?? "");
  return Boolean(
    sourceUuid
    && targetUuid
    && Number(detectableHuntersByTargetToken.get(targetUuid)?.get(sourceUuid)) > getWorldTime()
  );
}

function addSetMapValue(map, key, value) {
  const normalizedKey = String(key ?? "");
  if (!normalizedKey) return;
  const values = map.get(normalizedKey) ?? new Set();
  values.add(value);
  map.set(normalizedKey, values);
}

function deleteSetMapValue(map, key, value) {
  const values = map.get(String(key ?? ""));
  if (!values) return;
  values.delete(value);
  if (!values.size) map.delete(String(key ?? ""));
}

function activationFailure(reason) {
  return { success: false, reason: String(reason ?? "failed"), effect: null, region: null, session: null };
}
