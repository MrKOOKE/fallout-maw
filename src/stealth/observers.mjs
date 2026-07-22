import { actorHasIncapacitatingStatus } from "../combat/incapacitation.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorFactionBelongs,
  getFactionMatrix,
  getFactionScore,
  getRelationFromScore,
  getRelationTo
} from "../settings/factions.mjs";

const STEALTH_RELATION_CACHE_LIMIT = 3000;

const allyCache = new Map();
let factionMatrix = null;

export function isValidStealthObserver(hiddenToken, observerToken) {
  if (!hiddenToken?.actor || !observerToken?.actor) return false;
  if (hiddenToken.id === observerToken.id) return false;
  if (hiddenToken.actor.uuid === observerToken.actor.uuid) return false;
  if (isStealthObserverIncapacitated(observerToken)) return false;
  return !areActorsStealthAlliesCached(hiddenToken.actor, observerToken.actor);
}

export function isStealthObserverIncapacitated(observerToken) {
  const actor = observerToken?.actor ?? null;
  if (actorHasIncapacitatingStatus(actor)) return true;
  return Boolean(
    observerToken?.document?.hasStatusEffect?.("dead")
    || observerToken?.document?.hasStatusEffect?.("unconscious")
    || observerToken?.hasStatusEffect?.("dead")
    || observerToken?.hasStatusEffect?.("unconscious")
  );
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
