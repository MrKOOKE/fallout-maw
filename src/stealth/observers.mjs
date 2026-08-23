import { actorHasIncapacitatingStatus } from "../combat/incapacitation.mjs";
import { isPhantomEntity } from "../abilities/phantom-entity.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorFactionBelongs,
  getFactionMatrix,
  getFactionScore,
  getRelationFromScore,
  getRelationTo
} from "../settings/factions.mjs";

const STEALTH_RELATION_CACHE_LIMIT = 3000;
const SIGHT_DETECTION_MODE_IDS = new Set([
  "basicSight",
  "lightPerception",
  "seeAll",
  "seeInvisibility"
]);
const SIGHT_DETECTION_TYPE = 0;
const observerExclusionProviders = new Map();

const allyCache = new Map();
let factionMatrix = null;

export function isValidStealthObserver(hiddenToken, observerToken) {
  if (!hiddenToken?.actor || !observerToken?.actor) return false;
  if (isPhantomEntity(hiddenToken) || isPhantomEntity(observerToken)) return false;
  if (hiddenToken.id === observerToken.id) return false;
  if (hiddenToken.actor.uuid === observerToken.actor.uuid) return false;
  if (isStealthObserverIncapacitated(observerToken)) return false;
  for (const provider of observerExclusionProviders.values()) {
    if (provider(hiddenToken, observerToken) === true) return false;
  }
  return !areActorsStealthAlliesCached(hiddenToken.actor, observerToken.actor);
}

export function registerStealthObserverExclusionProvider(id = "", provider = null) {
  const key = String(id ?? "").trim();
  if (!key || typeof provider !== "function") return false;
  observerExclusionProviders.set(key, provider);
  return true;
}

export function unregisterStealthObserverExclusionProvider(id = "") {
  return observerExclusionProviders.delete(String(id ?? "").trim());
}

export function isStealthObserverIncapacitated(observerToken) {
  const actor = observerToken?.actor ?? null;
  if (actorHasIncapacitatingStatus(actor)) return true;
  if (
    observerToken?.document?.hasStatusEffect?.("dead")
    || observerToken?.document?.hasStatusEffect?.("unconscious")
    || observerToken?.hasStatusEffect?.("dead")
    || observerToken?.hasStatusEffect?.("unconscious")
  ) return true;
  if (isStealthObserverBlind(observerToken)) return true;
  return !hasOperationalStealthSight(observerToken);
}

/**
 * Foundry only allows an enabled detection mode with a positive range to
 * participate in visibility tests. Mirror that gate here so a token whose
 * Basic Sight and Light Perception are both zero cannot retain a skill-based
 * stealth zone or regain one through weapon noise.
 */
export function hasOperationalStealthSight(observerToken) {
  const document = observerToken?.document ?? observerToken;
  if (!observerToken?.actor || !document) return false;
  if (observerToken?.hasSight === false || document.sight?.enabled === false) return false;

  const modes = Object.entries(document.detectionModes ?? {});
  if (!modes.length) return hasPositiveDetectionRange(document.sight?.range);
  return modes.some(([modeId, mode]) => (
    mode?.enabled !== false
    && hasPositiveDetectionRange(mode?.range)
    && isSightDetectionMode(modeId)
  ));
}

export function areActorsStealthAlliesCached(hiddenActor, observerActor) {
  const key = `${hiddenActor?.uuid ?? ""}|${observerActor?.uuid ?? ""}`;
  if (allyCache.has(key)) {
    const result = allyCache.get(key);
    allyCache.delete(key);
    allyCache.set(key, result);
    return result;
  }
  const result = areActorsStealthAllies(hiddenActor, observerActor);
  allyCache.set(key, result);
  trimCacheMap(allyCache, STEALTH_RELATION_CACHE_LIMIT);
  return result;
}

export function areActorsStealthAllies(hiddenActor, observerActor) {
  const hiddenFactions = getEffectiveActorFactions(hiddenActor);
  const observerFactions = getEffectiveActorFactions(observerActor);
  if (hiddenFactions.some(faction => observerFactions.includes(faction))) return true;

  const matrix = factionMatrix ??= getFactionMatrix();
  for (const hiddenFaction of hiddenFactions) {
    if (hiddenFaction === DEFAULT_FACTION_NAME) continue;
    if (getRelationTo(observerActor, hiddenFaction) === "ally") return true;
    for (const observerFaction of observerFactions) {
      if (observerFaction === DEFAULT_FACTION_NAME) continue;
      if (getRelationFromScore(getFactionScore(observerFaction, hiddenFaction, matrix)) === "ally") return true;
    }
  }
  return false;
}

export function invalidateStealthRelationCache(actor = null) {
  const actorUuid = String(actor?.uuid ?? actor ?? "").trim();
  factionMatrix = null;
  if (!actorUuid) {
    allyCache.clear();
    return;
  }
  for (const key of allyCache.keys()) {
    const [hiddenUuid, observerUuid] = key.split("|");
    if (hiddenUuid === actorUuid || observerUuid === actorUuid) allyCache.delete(key);
  }
}

export function getEffectiveActorFactions(actor) {
  return getActorFactionBelongs(actor).filter(faction => faction && faction !== DEFAULT_FACTION_NAME);
}

function trimCacheMap(map, limit) {
  while (map.size > limit) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
}

function isStealthObserverBlind(observerToken) {
  const document = observerToken?.document ?? observerToken;
  const actor = observerToken?.actor ?? document?.actor ?? null;
  const blindStatus = globalThis.CONFIG?.specialStatusEffects?.BLIND ?? "blind";
  const statusIds = new Set([blindStatus, "blind", "blinded"].filter(Boolean));
  for (const statusId of statusIds) {
    if (actor?.statuses?.has?.(statusId)) return true;
    if (document?.hasStatusEffect?.(statusId)) return true;
    if (observerToken?.hasStatusEffect?.(statusId)) return true;
  }
  return Boolean(
    observerToken?.vision?.blinded?.blind
    || observerToken?._getVisionBlindedStates?.()?.blind
  );
}

function isSightDetectionMode(modeId) {
  const definition = globalThis.CONFIG?.Canvas?.detectionModes?.[modeId];
  if (definition?.type !== undefined && definition?.type !== null) {
    return Number(definition.type) === SIGHT_DETECTION_TYPE;
  }
  return SIGHT_DETECTION_MODE_IDS.has(modeId);
}

function hasPositiveDetectionRange(value) {
  if (value === null || value === undefined) return true;
  const range = Number(value);
  return range === Infinity || (Number.isFinite(range) && range > 0);
}
