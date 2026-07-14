import {
  ABILITY_CONDITION_TYPES,
  ABILITY_EVENT_REACTOR_ROLES,
  ABILITY_EVENT_SUBJECTS
} from "../settings/abilities.mjs";

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
  ABILITY_CONDITION_TYPES.energyConsumption
]);

const FILTER_TYPES = new Set(EVENT_REACTION_FILTER_TYPES);
const IGNORED_TYPES = new Set(EVENT_REACTION_IGNORED_CONDITION_TYPES);

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

export function eventReactionRoleMatches(role = ABILITY_EVENT_REACTOR_ROLES.any, {
  reactorActorUuid = "",
  sourceActorUuid = "",
  targetActorUuid = ""
} = {}) {
  const requested = Object.values(ABILITY_EVENT_REACTOR_ROLES).includes(role)
    ? role
    : ABILITY_EVENT_REACTOR_ROLES.any;
  const reactor = String(reactorActorUuid ?? "").trim();
  const source = String(sourceActorUuid ?? "").trim();
  const target = String(targetActorUuid ?? "").trim();
  if (!reactor) return false;
  if (requested === ABILITY_EVENT_REACTOR_ROLES.any) return true;
  if (requested === ABILITY_EVENT_REACTOR_ROLES.source) return Boolean(source && reactor === source);
  if (requested === ABILITY_EVENT_REACTOR_ROLES.target) return Boolean(target && reactor === target);
  return reactor !== source && reactor !== target;
}

export function eventReactionSubscriptionMatches(condition = {}, envelope = {}, reactorActorUuid = "") {
  const eventKey = String(condition?.eventKey ?? "").trim();
  if (!eventKey || eventKey !== String(envelope?.key ?? "").trim()) return false;
  return eventReactionRoleMatches(condition?.reactorRole, {
    reactorActorUuid,
    sourceActorUuid: getEventParticipantActorUuid(envelope?.source),
    targetActorUuid: getEventParticipantActorUuid(envelope?.target)
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
