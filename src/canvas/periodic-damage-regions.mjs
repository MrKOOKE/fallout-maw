import { SYSTEM_ID } from "../constants.mjs";
import { requestRegionMovementDamageBatch } from "../combat/damage-hub.mjs";
import { measureTheoreticalMovementSegmentsCost } from "../combat/movement-resources.mjs";
import { evaluateFormulaVariables } from "../formulas/evaluation.mjs";
import { getCombatSettings, getDamageTypeSettings } from "../settings/accessors.mjs";
import { evaluateActorFormula, isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { toInteger } from "../utils/numbers.mjs";

const BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const CLOCK_FLAG_KEY = "periodicDamage";
const MOVEMENT_FLAG_KEY = "periodicDamageMovement";
const EFFECT_FLAG_KEY = "periodicDamageRegion";
const MOVEMENT_HISTORY_LIMIT = 50;
const EFFECT_SYNC_DELAY_MS = 50;
const EFFECT_IMG = "icons/svg/fire.svg";

let movementQueue = Promise.resolve();
let effectSyncTimeout = 0;
const pendingDamageGroups = new Map();

export function registerPeriodicDamageRegionHooks() {
  Hooks.on("moveToken", onMoveToken);
  for (const hook of [
    "createToken", "updateToken", "deleteToken",
    "createRegion", "updateRegion", "deleteRegion",
    "createRegionBehavior", "updateRegionBehavior", "deleteRegionBehavior",
    "updateActor", "updateWorldTime"
  ]) Hooks.on(hook, queuePeriodicDamageRegionEffectSync);
}

export async function syncPeriodicDamageRegionEffects() {
  if (!game.user?.isActiveGM) return;
  const actors = collectLoadedActors();
  const desiredByActor = collectDesiredRegionEffects();

  for (const actor of actors.values()) {
    if (!actor?.isOwner) continue;
    const desired = desiredByActor.get(actor.uuid) ?? new Map();
    const existing = Array.from(actor.effects ?? []).filter(effect => effect.getFlag?.(SYSTEM_ID, EFFECT_FLAG_KEY));
    const existingByBehavior = new Map(existing.map(effect => [
      String(effect.getFlag(SYSTEM_ID, EFFECT_FLAG_KEY)?.behaviorUuid ?? ""),
      effect
    ]));

    const creates = [];
    const updates = [];
    for (const [behaviorUuid, entry] of desired) {
      const effectData = buildRegionEffectData(entry.region, entry.behavior, actor);
      const effect = existingByBehavior.get(behaviorUuid);
      if (!effect) creates.push(effectData);
      else if (regionEffectNeedsUpdate(effect, effectData)) updates.push({ _id: effect.id, ...effectData });
      existingByBehavior.delete(behaviorUuid);
    }

    if (creates.length) await actor.createEmbeddedDocuments("ActiveEffect", creates, { animate: false });
    if (updates.length) await actor.updateEmbeddedDocuments("ActiveEffect", updates, { animate: false });
    const deleteIds = Array.from(existingByBehavior.values()).map(effect => effect.id);
    if (deleteIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", deleteIds, { animate: false });
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
    queuePeriodicDamageRegionEffectSync();
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
  queuePeriodicDamageRegionEffectSync();
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

function collectDesiredRegionEffects() {
  const desired = new Map();
  for (const scene of game.scenes?.contents ?? []) {
    for (const region of scene.regions?.contents ?? []) {
      for (const behavior of region.behaviors?.contents ?? []) {
        if (!isBehaviorCurrentlyActive(region, behavior) || !getDamageEntries(behavior.system).length) continue;
        for (const token of scene.tokens?.contents ?? []) {
          if (!token.actor || !isTokenInsideRegion(token, region)) continue;
          const actorEffects = desired.get(token.actor.uuid) ?? new Map();
          actorEffects.set(behavior.uuid, { region, behavior });
          desired.set(token.actor.uuid, actorEffects);
        }
      }
    }
  }
  return desired;
}

function collectLoadedActors() {
  const actors = new Map((game.actors?.contents ?? []).map(actor => [actor.uuid, actor]));
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens?.contents ?? []) {
      if (token.actor?.uuid) actors.set(token.actor.uuid, token.actor);
    }
  }
  return actors;
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

function queuePeriodicDamageRegionEffectSync() {
  if (!game.user?.isActiveGM) return;
  window.clearTimeout(effectSyncTimeout);
  effectSyncTimeout = window.setTimeout(() => {
    void syncPeriodicDamageRegionEffects().catch(error => (
      console.error(`${SYSTEM_ID} | Periodic damage region effect sync failed`, error)
    ));
  }, EFFECT_SYNC_DELAY_MS);
}

function escapeHtml(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}
