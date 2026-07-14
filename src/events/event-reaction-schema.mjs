import {
  ABILITY_CONDITION_TYPES,
  ABILITY_EVENT_SUBJECTS,
  ABILITY_EVENT_TRACKING_TARGETS
} from "../settings/abilities.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorFactionBelongs,
  getRelationTo
} from "../settings/factions.mjs";

export const EVENT_REACTION_CONDITION_TYPE = ABILITY_CONDITION_TYPES.eventReaction;

export const EVENT_REACTION_FILTER_TYPES = Object.freeze([
  ABILITY_CONDITION_TYPES.healthPercent,
  ABILITY_CONDITION_TYPES.equipmentSlotOccupied,
  ABILITY_CONDITION_TYPES.targetFaction,
  ABILITY_CONDITION_TYPES.targetRace,
  ABILITY_CONDITION_TYPES.targetType,
  ABILITY_CONDITION_TYPES.posture,
  ABILITY_CONDITION_TYPES.occupiedCover,
  ABILITY_CONDITION_TYPES.weaponAction,
  ABILITY_CONDITION_TYPES.weaponSkill,
  ABILITY_CONDITION_TYPES.weaponProficiency
]);

export const EVENT_REACTION_IGNORED_CONDITION_TYPES = Object.freeze([
  ABILITY_CONDITION_TYPES.itemUse,
  ABILITY_CONDITION_TYPES.aura,
  ABILITY_CONDITION_TYPES.limitedChanges,
  ABILITY_CONDITION_TYPES.cooldown,
  ABILITY_CONDITION_TYPES.duration,
  ABILITY_CONDITION_TYPES.energyConsumption
]);

const FILTER_TYPES = new Set(EVENT_REACTION_FILTER_TYPES);
const IGNORED_TYPES = new Set(EVENT_REACTION_IGNORED_CONDITION_TYPES);
const TRACKING_TARGETS = new Set(ABILITY_EVENT_TRACKING_TARGETS);

export function hasEventReactionCondition(conditions = []) {
  return (conditions ?? []).some(condition => condition?.type === EVENT_REACTION_CONDITION_TYPE);
}

export function getEventReactionSubscriptions(conditions = []) {
  return (conditions ?? []).filter(condition => condition?.type === EVENT_REACTION_CONDITION_TYPE);
}

export function getEventReactionSecondaryConditions(conditions = [], { warn = null, source = "" } = {}) {
  const accepted = [];
  for (const condition of conditions ?? []) {
    const type = String(condition?.type ?? "").trim();
    if (!type || type === EVENT_REACTION_CONDITION_TYPE) continue;
    if (FILTER_TYPES.has(type)) {
      accepted.push(condition);
      continue;
    }
    if (type === ABILITY_CONDITION_TYPES.duration) continue;
    if (IGNORED_TYPES.has(type)) {
      warn?.({ type, condition, source, reason: "unsupportedEventReactionCondition" });
      continue;
    }
    warn?.({ type, condition, source, reason: "unknownEventReactionCondition" });
  }
  return accepted;
}

export function isEventReactionFilterType(type = "") {
  return FILTER_TYPES.has(String(type ?? ""));
}

export function isIgnoredEventReactionConditionType(type = "") {
  return IGNORED_TYPES.has(String(type ?? ""));
}

export function normalizeEventSubject(value = "") {
  const subject = String(value ?? "").trim();
  return Object.values(ABILITY_EVENT_SUBJECTS).includes(subject)
    ? subject
    : ABILITY_EVENT_SUBJECTS.reactor;
}

export function normalizeEventTrackingTargets(value = []) {
  return (Array.isArray(value) ? value : Object.values(value ?? {}))
    .map(entry => String(entry ?? "").trim())
    .filter(entry => TRACKING_TARGETS.has(entry));
}

export function eventReactionCombatAllows(condition = {}, { inCombat = null } = {}) {
  if (!condition?.combatOnly) return true;
  if (typeof inCombat === "boolean") return inCombat;
  const combat = globalThis.game?.combat ?? globalThis.game?.combats?.active ?? null;
  return Boolean(combat?.started);
}

export function getEventTrackingRelation(reactorActor = null, otherActor = null, {
  resolveRelation = null
} = {}) {
  const reactorUuid = String(reactorActor?.uuid ?? "").trim();
  const otherUuid = String(otherActor?.uuid ?? "").trim();
  if (!reactorUuid || !otherUuid) return "";
  if (reactorUuid === otherUuid) return "owner";
  if (typeof resolveRelation === "function") {
    const relation = String(resolveRelation(reactorActor, otherActor) ?? "").trim();
    return TRACKING_TARGETS.has(relation) && relation !== "owner" ? relation : "neutral";
  }
  const factions = getActorFactionBelongs(otherActor);
  const names = factions.length ? factions : [DEFAULT_FACTION_NAME];
  if (names.some(faction => getRelationTo(reactorActor, faction) === "ally")) return "ally";
  if (names.some(faction => getRelationTo(reactorActor, faction) === "enemy")) return "enemy";
  return "neutral";
}

export function eventReactionTrackingTargetsMatch(condition = {}, {
  reactorActor = null,
  sourceActor = null,
  targetActor = null,
  resolveRelation = null
} = {}) {
  const accepted = new Set(normalizeEventTrackingTargets(condition?.trackingTargets));
  if (!accepted.size) return true;
  const participants = [sourceActor, targetActor].filter(Boolean);
  if (!participants.length) return false;
  return participants.some(actor => accepted.has(getEventTrackingRelation(reactorActor, actor, { resolveRelation })));
}

export function eventReactionSubscriptionMatches(condition = {}, envelope = {}, reactorActorUuid = "", {
  reactorActor = null,
  sourceActor = null,
  targetActor = null,
  inCombat = null,
  resolveRelation = null
} = {}) {
  const eventKey = String(condition?.eventKey ?? "").trim();
  if (!eventKey || eventKey !== String(envelope?.key ?? "").trim()) return false;
  if (!String(reactorActorUuid ?? "").trim()) return false;
  if (!eventReactionCombatAllows(condition, { inCombat })) return false;
  return eventReactionTrackingTargetsMatch(condition, {
    reactorActor: reactorActor ?? { uuid: reactorActorUuid },
    sourceActor: sourceActor ?? actorStubFromParticipant(envelope?.source),
    targetActor: targetActor ?? actorStubFromParticipant(envelope?.target),
    resolveRelation
  });
}

export function getEventParticipantActorUuid(participant = null) {
  if (!participant || typeof participant !== "object") return "";
  return String(
    participant.actorUuid
    ?? participant.actor?.uuid
    ?? participant.actor?.actorUuid
    ?? ""
  ).trim();
}

export function getEventParticipantTokenUuid(participant = null) {
  if (!participant || typeof participant !== "object") return "";
  return String(
    participant.tokenUuid
    ?? participant.token?.uuid
    ?? participant.token?.tokenUuid
    ?? ""
  ).trim();
}

function actorStubFromParticipant(participant = null) {
  const uuid = getEventParticipantActorUuid(participant);
  return uuid ? { uuid } : null;
}
