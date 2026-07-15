import {
  ABILITY_CONDITION_TYPES,
  ABILITY_EVENT_SUBJECTS,
  ABILITY_FUNCTION_TYPES,
  ABILITY_POSTURE_SUBJECTS,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import {
  eventReactionSubscriptionMatches,
  getEventParticipantActorUuid,
  getEventParticipantTokenUuid,
  getEventReactionSecondaryConditions,
  getEventReactionSubscriptions,
  normalizeEventSubject
} from "./event-reaction-schema.mjs";

export function collectActiveSceneReactorActors({ scene = globalThis.canvas?.scene, tokens = null } = {}) {
  const candidates = tokens
    ?? globalThis.canvas?.tokens?.placeables
    ?? scene?.tokens?.contents
    ?? scene?.tokens
    ?? [];
  const actors = new Map();
  for (const candidate of candidates ?? []) {
    const token = candidate?.document ?? candidate;
    if (scene?.id && token?.parent?.id && token.parent.id !== scene.id) continue;
    const actor = candidate?.actor ?? token?.actor ?? null;
    const actorUuid = String(actor?.uuid ?? "").trim();
    if (actorUuid && !actors.has(actorUuid)) actors.set(actorUuid, actor);
  }
  return Array.from(actors.values());
}

export function isActiveEventReactionGearItem(item = null) {
  if (item?.type !== "gear" || !item.system?.functions?.freeSettings?.enabled) return false;
  return Boolean(item.system?.equipped)
    || ["equipment", "weapon", "constructPart"].includes(item.system?.placement?.mode);
}

export function getActorEventReactionSourceItems(actor = null, {
  getItems = getActorItemDocuments
} = {}) {
  const sources = [];
  const seen = new Set();
  for (const item of getItems(actor) ?? []) {
    const uuid = String(item?.uuid ?? `${actor?.uuid ?? ""}.Item.${item?.id ?? ""}`).trim();
    if (!uuid || seen.has(uuid)) continue;
    if (item?.type !== "ability" && !isActiveEventReactionGearItem(item)) continue;
    seen.add(uuid);
    sources.push(item);
  }
  return sources;
}

export function getEventReactionItemFunctions(item = null, {
  normalizeFunctions = normalizeAbilityFunctions
} = {}) {
  const functions = item?.type === "ability"
    ? item.system?.functions ?? []
    : isActiveEventReactionGearItem(item)
      ? item.system?.functions?.freeSettings?.entries ?? []
      : [];
  return normalizeFunctions(functions)
    .filter(entry => entry?.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .filter(entry => getEventReactionSubscriptions(entry.conditions).length > 0);
}

export async function collectEventReactionCandidates({
  envelope = {},
  reactors = [],
  resolveUuid = defaultResolveUuid,
  getItems = getActorItemDocuments,
  normalizeFunctions = normalizeAbilityFunctions,
  conditionEvaluator = defaultConditionEvaluator,
  warn = defaultWarn
} = {}) {
  const participants = await resolveEventReactionParticipants(envelope, resolveUuid);
  const candidates = [];
  const seenActors = new Set();
  for (const reactorEntry of reactors ?? []) {
    const reactor = reactorEntry?.actor ?? reactorEntry?.document?.actor ?? reactorEntry;
    const actorUuid = String(reactor?.uuid ?? "").trim();
    if (!actorUuid || seenActors.has(actorUuid)) continue;
    seenActors.add(actorUuid);
    for (const item of getActorEventReactionSourceItems(reactor, { getItems })) {
      for (const abilityFunction of getEventReactionItemFunctions(item, { normalizeFunctions })) {
        const matchedConditionIds = await getMatchingEventReactionSubscriptionIds({
          reactor,
          item,
          abilityFunction,
          envelope,
          participants,
          conditionEvaluator,
          warn
        });
        if (!matchedConditionIds.length) continue;
        candidates.push(buildEventReactionCandidate({
          reactor,
          item,
          abilityFunction,
          envelope,
          matchedConditionIds
        }));
      }
    }
  }
  return candidates;
}

export async function eventReactionFunctionMatches({
  reactor = null,
  item = null,
  abilityFunction = {},
  envelope = {},
  participants = null,
  resolveUuid = defaultResolveUuid,
  conditionEvaluator = defaultConditionEvaluator,
  warn = defaultWarn
} = {}) {
  return (await getMatchingEventReactionSubscriptionIds({
    reactor,
    item,
    abilityFunction,
    envelope,
    participants,
    resolveUuid,
    conditionEvaluator,
    warn
  })).length > 0;
}

/** Return the matching Event Reaction subscription ids after all secondary filters pass. */
export async function getMatchingEventReactionSubscriptionIds({
  reactor = null,
  item = null,
  abilityFunction = {},
  envelope = {},
  participants = null,
  resolveUuid = defaultResolveUuid,
  conditionEvaluator = defaultConditionEvaluator,
  warn = defaultWarn
} = {}) {
  const reactorActorUuid = String(reactor?.uuid ?? "").trim();
  if (!reactorActorUuid || abilityFunction?.type !== ABILITY_FUNCTION_TYPES.effectChanges) return [];
  const resolved = participants ?? await resolveEventReactionParticipants(envelope, resolveUuid);
  const subscriptions = getEventReactionSubscriptions(abilityFunction.conditions);
  const matchedConditionIds = subscriptions.filter(condition => eventReactionSubscriptionMatches(condition, envelope, reactorActorUuid, {
    reactorActor: reactor,
    sourceActor: resolved.sourceActor,
    targetActor: resolved.targetActor
  })).map(condition => String(condition?.id ?? "").trim()).filter(Boolean);
  if (!matchedConditionIds.length) return [];
  const secondaryMatches = await evaluateEventReactionSecondaryConditions({
    reactor,
    item,
    abilityFunction,
    envelope,
    participants: resolved,
    conditionEvaluator,
    warn
  });
  return secondaryMatches ? Array.from(new Set(matchedConditionIds)) : [];
}

export async function evaluateEventReactionSecondaryConditions({
  reactor = null,
  item = null,
  abilityFunction = {},
  envelope = {},
  participants = {},
  conditionEvaluator = defaultConditionEvaluator,
  warn = defaultWarn
} = {}) {
  const source = `${item?.uuid ?? item?.id ?? "item"}:${abilityFunction?.id ?? "function"}`;
  const conditions = getEventReactionSecondaryConditions(abilityFunction.conditions, { warn, source });
  const standalone = [];
  const groups = new Map();
  for (const condition of conditions) {
    const groupId = String(condition?.groupId ?? "").trim();
    if (!groupId) {
      standalone.push(condition);
      continue;
    }
    const group = groups.get(groupId) ?? [];
    group.push(condition);
    groups.set(groupId, group);
  }

  for (const condition of standalone) {
    if (!evaluateEventReactionFilter({ reactor, condition, envelope, participants, abilityFunction, item, conditionEvaluator })) {
      return false;
    }
  }
  for (const group of groups.values()) {
    if (!group.some(condition => evaluateEventReactionFilter({
      reactor,
      condition,
      envelope,
      participants,
      abilityFunction,
      item,
      conditionEvaluator
    }))) return false;
  }
  return true;
}

export function evaluateEventReactionFilter({
  reactor = null,
  condition = {},
  envelope = {},
  participants = {},
  abilityFunction = {},
  item = null,
  conditionEvaluator = defaultConditionEvaluator
} = {}) {
  const subject = normalizeEventSubject(condition?.eventSubject);
  const subjectActor = subject === ABILITY_EVENT_SUBJECTS.eventSource
    ? participants.sourceActor
    : subject === ABILITY_EVENT_SUBJECTS.eventTarget
      ? participants.targetActor
      : reactor;
  const subjectToken = subject === ABILITY_EVENT_SUBJECTS.eventSource
    ? participants.sourceToken
    : subject === ABILITY_EVENT_SUBJECTS.eventTarget
      ? participants.targetToken
      : findActorToken(reactor, participants.reactorTokens);
  if (!subjectActor) return false;

  const eventData = envelope?.data && typeof envelope.data === "object" ? envelope.data : {};
  const evaluatedCondition = condition?.type === ABILITY_CONDITION_TYPES.posture
    ? { ...condition, postureSubject: ABILITY_POSTURE_SUBJECTS.self }
    : condition;
  return Boolean(conditionEvaluator(subjectActor, evaluatedCondition, {
    eventReaction: true,
    eventEnvelope: envelope,
    reactorActor: reactor,
    eventSourceActor: participants.sourceActor,
    eventTargetActor: participants.targetActor,
    actorToken: subjectToken,
    targetActor: subjectActor,
    targetToken: subjectToken,
    weaponActionKey: String(eventData.weaponActionKey ?? eventData.actionKey ?? "").trim(),
    weaponData: eventData.weaponData ?? eventData.weapon ?? {},
    abilityItemId: item?.id ?? "",
    functionId: abilityFunction?.id ?? ""
  }));
}

export async function resolveEventReactionParticipants(envelope = {}, resolveUuid = defaultResolveUuid) {
  const sourceActorUuid = getEventParticipantActorUuid(envelope?.source);
  const targetActorUuid = getEventParticipantActorUuid(envelope?.target);
  const sourceTokenUuid = getEventParticipantTokenUuid(envelope?.source);
  const targetTokenUuid = getEventParticipantTokenUuid(envelope?.target);
  const [sourceActor, targetActor, sourceToken, targetToken] = await Promise.all([
    resolveDocument(sourceActorUuid, resolveUuid),
    resolveDocument(targetActorUuid, resolveUuid),
    resolveDocument(sourceTokenUuid, resolveUuid),
    resolveDocument(targetTokenUuid, resolveUuid)
  ]);
  return {
    sourceActor,
    targetActor,
    sourceToken,
    targetToken,
    sourceActorUuid,
    targetActorUuid,
    sourceTokenUuid,
    targetTokenUuid,
    reactorTokens: globalThis.canvas?.tokens?.placeables ?? []
  };
}

export function buildEventReactionCandidate({
  reactor = null,
  item = null,
  abilityFunction = {},
  envelope = {},
  matchedConditionIds = []
} = {}) {
  const actorUuid = String(reactor?.uuid ?? "").trim();
  const sourceItemUuid = String(item?.uuid ?? "").trim();
  const functionId = String(abilityFunction?.id ?? "").trim();
  const rootId = String(envelope?.rootId ?? envelope?.eventId ?? "").trim();
  const eventKey = String(envelope?.key ?? "").trim();
  const chanceScope = getEventReactionOpportunityScope(envelope) || rootId;
  // Subject of the triggering event (e.g. who is rolling the skill check). Without this,
  // one shot that forces checks on two actors shares one chance and only the first is offered.
  const triggerActorUuid = getEventParticipantActorUuid(envelope?.source);
  // One accept/decline for this function across the whole root, including
  // nested events and their participants.
  const chanceKey = [rootId, actorUuid, sourceItemUuid, functionId].join("|");
  return {
    actorUuid,
    sourceItemUuid,
    sourceItemId: String(item?.id ?? ""),
    functionId,
    rootId,
    chanceScope,
    triggerActorUuid,
    eventId: String(envelope?.eventId ?? ""),
    eventKey,
    matchedConditionIds: Array.from(new Set((matchedConditionIds ?? [])
      .map(conditionId => String(conditionId ?? "").trim())
      .filter(Boolean))),
    chanceKey,
    offerId: `event-reaction:${chanceKey}`,
    label: String(item?.name ?? ""),
    description: String(item?.system?.description ?? ""),
    img: String(item?.img ?? "icons/svg/aura.svg"),
    reactionSettings: abilityFunction?.reactionSettings ?? { durationSeconds: 0, costs: [] },
    changes: abilityFunction?.changes ?? []
  };
}

export function getEventReactionOpportunityScope(envelope = {}) {
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : {};
  const request = data.request && typeof data.request === "object" ? data.request : {};
  for (const value of [
    data.systemEventOperationId,
    request.systemEventOperationId,
    envelope?.operationId,
    envelope?.rootId,
    envelope?.eventId
  ]) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
}

export function findEventReactionFunction(item = null, functionId = "", options = {}) {
  const id = String(functionId ?? "").trim();
  if (!id) return null;
  return getEventReactionItemFunctions(item, options).find(entry => entry.id === id) ?? null;
}

function findActorToken(actor, tokens = []) {
  const actorUuid = String(actor?.uuid ?? "").trim();
  return (tokens ?? []).find(token => String((token?.actor ?? token?.document?.actor)?.uuid ?? "") === actorUuid)
    ?? actor?.token
    ?? null;
}

async function resolveDocument(uuid, resolveUuid) {
  if (!uuid) return null;
  try {
    return await resolveUuid(uuid);
  } catch (_error) {
    return null;
  }
}

function defaultResolveUuid(uuid) {
  return globalThis.fromUuid?.(uuid) ?? null;
}

function getActorItemDocuments(actor = null) {
  if (Array.isArray(actor?.items?.contents)) return actor.items.contents;
  if (typeof actor?.items?.values === "function") return Array.from(actor.items.values());
  return Array.from(actor?.items ?? []);
}

function defaultConditionEvaluator() {
  return false;
}

function defaultWarn({ type, source, reason }) {
  console.warn(`fallout-maw | Ignored ${reason} '${type}' in Event Reaction ${source}.`);
}
