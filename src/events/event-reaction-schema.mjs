import {
  ABILITY_CONDITION_TYPES,
  ABILITY_EVENT_SUBJECTS,
  ABILITY_EVENT_TRACKING_TARGETS
} from "../settings/abilities.mjs";
import { getSystemEventDescriptor } from "./catalog.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorFactionBelongs,
  getRelationTo
} from "../settings/factions.mjs";

const TRACKING_SOURCE_ROLES = new Set([
  "subject", "source", "initiator", "attacker", "healer", "observer"
]);
const TRACKING_TARGET_ROLES = new Set([
  "target", "defender", "patient", "observed", "recipient"
]);

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

export function getEventReactionTrackingParticipants({
  eventKey = "",
  sourceActor = null,
  targetActor = null,
  roles = null
} = {}) {
  const catalogRoles = Array.isArray(roles)
    ? roles
    : (getSystemEventDescriptor(String(eventKey ?? "").trim())?.roles ?? ["subject"]);
  const includeSource = catalogRoles.some(role => TRACKING_SOURCE_ROLES.has(role));
  const includeTarget = catalogRoles.some(role => TRACKING_TARGET_ROLES.has(role));
  // Default subject-only events (skill checks, etc.): track who the event is about, not a
  // collateral attack target attached on the envelope.
  const participants = [];
  if (includeSource || !includeTarget) {
    if (sourceActor) participants.push(sourceActor);
  }
  if (includeTarget && targetActor) participants.push(targetActor);
  return participants;
}

export function eventReactionTrackingTargetsMatch(condition = {}, {
  reactorActor = null,
  sourceActor = null,
  targetActor = null,
  eventKey = "",
  roles = null,
  resolveRelation = null
} = {}) {
  const accepted = new Set(normalizeEventTrackingTargets(condition?.trackingTargets));
  if (!accepted.size) return true;
  const participants = getEventReactionTrackingParticipants({
    eventKey: eventKey || condition?.eventKey,
    sourceActor,
    targetActor,
    roles
  });
  if (!participants.length) return false;
  const matched = participants.some(actor => accepted.has(getEventTrackingRelation(reactorActor, actor, { resolveRelation })));
  return matched;
}

export const EVENT_REACTION_SKILL_FILTER_ALL = "*";

export function getEventReactionPathSegments(eventKey = "") {
  const key = String(eventKey ?? "").trim();
  const path = key.startsWith("fallout-maw.") ? key.slice("fallout-maw.".length) : key;
  return path.split(".").filter(Boolean);
}

export function getEventReactionFamilyParts(eventKey = "") {
  const segments = getEventReactionPathSegments(eventKey);
  if (!segments.length) return { familyPath: "", variant: "" };
  if (segments.length === 1) return { familyPath: segments[0], variant: "" };
  return {
    familyPath: segments.slice(0, -1).join("."),
    variant: segments.at(-1)
  };
}

export function isEventReactionSkillCheckFamily(eventKey = "") {
  const segments = getEventReactionPathSegments(eventKey);
  return segments[0] === "skill" && segments[1] === "check";
}

export function getEventEnvelopeSkillKey(envelope = {}) {
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : {};
  return String(data.skillKey ?? data.skill?.key ?? data.request?.skillKey ?? "").trim();
}

export function normalizeEventReactionSkillKeys(value = []) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" ? Object.values(value) : [value];
  return Array.from(new Set(source.map(entry => String(entry ?? "").trim()).filter(Boolean)));
}

export function eventReactionSkillKeysMatch(condition = {}, envelope = {}) {
  if (!isEventReactionSkillCheckFamily(condition?.eventKey || envelope?.key)) return true;
  const accepted = normalizeEventReactionSkillKeys(condition?.skillKeys);
  if (!accepted.length || accepted.includes(EVENT_REACTION_SKILL_FILTER_ALL)) return true;
  const skillKey = getEventEnvelopeSkillKey(envelope);
  return Boolean(skillKey && accepted.includes(skillKey));
}

export function buildEventReactionPathTree(descriptors = [], { localizeEventLabel = null } = {}) {
  const root = createEventReactionPathNode("", "");
  for (const descriptor of descriptors ?? []) {
    const key = String(descriptor?.key ?? "").trim();
    const segments = getEventReactionPathSegments(key);
    if (!segments.length) continue;
    const labelParts = splitEventReactionLabel(
      typeof localizeEventLabel === "function"
        ? localizeEventLabel(descriptor)
        : key
    );
    let node = root;
    let path = "";
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      path = path ? `${path}.${segment}` : segment;
      if (!node.children.has(segment)) {
        node.children.set(segment, createEventReactionPathNode(segment, path));
      }
      node = node.children.get(segment);
      if (labelParts.length === segments.length) {
        const label = String(labelParts[index] ?? "").trim();
        if (label) node.label = label;
      } else if (labelParts.length === 1 && segments.length === 1) {
        const label = String(labelParts[0] ?? "").trim();
        if (label) node.label = label;
      } else if (index === segments.length - 1 && labelParts.length) {
        const label = String(labelParts.at(-1) ?? "").trim();
        if (label) node.label = label;
      }
      if (index === segments.length - 1) {
        node.eventKey = key;
        node.descriptor = descriptor;
      }
    }
  }
  return root;
}

export function buildEventReactionPathLevels(selectedKey = "", {
  descriptors = null,
  localizeEventLabel = null,
  unsupportedLabel = ""
} = {}) {
  const key = String(selectedKey ?? "").trim();
  const events = Array.isArray(descriptors) ? descriptors : [];
  const tree = buildEventReactionPathTree(events, { localizeEventLabel });
  const selectedSegments = getEventReactionPathSegments(key);
  const levels = [];
  let node = tree;
  let segmentIndex = 0;

  while (node) {
    const childNodes = Array.from(node.children.values());
    if (!childNodes.length) break;

    const choices = childNodes
      .map(child => presentEventReactionPathChoice(child))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));

    // Skip selects that only offer one option — auto-descend instead.
    if (choices.length === 1) {
      const only = choices[0];
      if (only.isLeaf) break;
      node = node.children.get(only.segment) ?? null;
      segmentIndex += 1;
      continue;
    }

    const selectedSegment = selectedSegments[segmentIndex] ?? "";
    const selectedChoice = choices.find(choice => choice.segment === selectedSegment)
      ?? (segmentIndex === 0 && !key ? null : choices[0]);
    if (selectedChoice) selectedChoice.selected = true;

    levels.push({
      depth: levels.length,
      path: selectedChoice?.path ?? "",
      choices,
      isLeafLevel: choices.every(choice => choice.isLeaf)
    });

    if (!selectedChoice || selectedChoice.isLeaf) break;
    node = node.children.get(selectedChoice.segment) ?? null;
    segmentIndex += 1;
    if (node && node.children.size === 0) break;
  }

  if (key && !events.some(event => event.key === key) && !levels.length) {
    levels.push({
      depth: 0,
      path: key,
      choices: [{
        segment: key,
        path: key,
        label: unsupportedLabel || key,
        selected: true,
        isLeaf: true,
        eventKey: key
      }],
      isLeafLevel: true
    });
  }

  return levels;
}

function presentEventReactionPathChoice(child) {
  let current = child;
  const labelParts = [String(child.label || child.segment || "").trim()].filter(Boolean);
  while (current.children.size === 1) {
    current = current.children.values().next().value;
    const part = String(current.label || current.segment || "").trim();
    if (part) labelParts.push(part);
  }
  const collapsedToLeaf = current.children.size === 0 && Boolean(current.eventKey);
  const directLeaf = Boolean(child.eventKey) && child.children.size === 0;
  return {
    segment: child.segment,
    path: collapsedToLeaf ? current.path : child.path,
    label: collapsedToLeaf && labelParts.length > 1
      ? labelParts.join(" · ")
      : (child.label || child.segment),
    selected: false,
    isLeaf: collapsedToLeaf || directLeaf,
    eventKey: collapsedToLeaf ? current.eventKey : (child.eventKey || "")
  };
}

export function resolveEventKeyForPathPrefix(pathPrefix = "", preferredEventKey = "", descriptors = []) {
  const prefix = String(pathPrefix ?? "").trim();
  if (!prefix) return "";
  const events = (Array.isArray(descriptors) ? descriptors : [])
    .filter(event => {
      const path = getEventReactionPathSegments(event.key).join(".");
      return path === prefix || path.startsWith(`${prefix}.`);
    })
    .slice()
    .sort((left, right) => left.key.localeCompare(right.key));
  if (!events.length) return "";
  const preferred = String(preferredEventKey ?? "").trim();
  if (preferred && events.some(event => event.key === preferred)) return preferred;
  const exact = events.find(event => getEventReactionPathSegments(event.key).join(".") === prefix);
  return exact?.key ?? events[0].key;
}

function createEventReactionPathNode(segment = "", path = "") {
  return {
    segment,
    path,
    label: "",
    eventKey: "",
    descriptor: null,
    children: new Map()
  };
}

function splitEventReactionLabel(label = "") {
  return String(label ?? "").split(" · ").map(part => part.trim()).filter(Boolean);
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
  if (!eventReactionSkillKeysMatch(condition, envelope)) return false;
  return eventReactionTrackingTargetsMatch(condition, {
    reactorActor: reactorActor ?? { uuid: reactorActorUuid },
    sourceActor: sourceActor ?? actorStubFromParticipant(envelope?.source),
    targetActor: targetActor ?? actorStubFromParticipant(envelope?.target),
    eventKey,
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
