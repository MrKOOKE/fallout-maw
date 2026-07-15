import { SYSTEM_ID } from "../constants.mjs";
import { getSystemEventDescriptor } from "../events/catalog.mjs";
import { getEventParticipantActorUuid } from "../events/event-reaction-schema.mjs";
import { getCombatSettings } from "../settings/accessors.mjs";
import { escapeHTML, normalizeImagePath } from "../utils/actor-display-data.mjs";
import { canActorSpendEnergy } from "./energy-resource.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;

export const REACTION_EVENT_KEYS = Object.freeze({
  weaponAttackTargeted: "weaponAttackTargeted",
  weaponAttackCommitted: "weaponAttackCommitted",
  aimedAttackLimbSelected: "aimedAttackLimbSelected",
  weaponAttackResolved: "weaponAttackResolved",
  tokenLeavingAdjacency: "tokenLeavingAdjacency",
  oversightThreshold: "oversightThreshold"
});
const LEGACY_REACTION_EVENT_KEYS = new Set(Object.values(REACTION_EVENT_KEYS));

export const REACTION_RESULT = Object.freeze({
  declined: "declined",
  failed: "failed",
  success: "success"
});

const REACTION_SOCKET = `system.${SYSTEM_ID}`;
const REACTION_SOCKET_SCOPE = "fallout-maw.reactionHub";
const REACTION_QUERY_NAME = "falloutMawReaction";
const DEFAULT_REACTION_TIMEOUT_MS = 20000;
const REACTION_SOCKET_COMPLETION_GRACE_MS = 30000;
export const REACTION_LOCK_BYPASS_OPTION = "falloutMawReactionLockBypass";
const UNABLE_TO_ACT_STATUSES = new Set(["dead", "unconscious", "stunned"]);
const pendingReactionSocketRequests = new Map();
const reactionProviders = new Map();
const activeReactionLocks = new Map();
/** Requests deferred while a reaction execute cycle is already running. */
const pendingReactionRequests = [];
let reactionExecutionDepth = 0;
let drainingReactionQueue = false;
let reactionHubHooksRegistered = false;
let reactionEventSemanticAdapter = null;
let reactionExecutionGuard = null;

export function registerReactionHubConfig() {
  CONFIG.queries[REACTION_QUERY_NAME] = handleReactionQuery;
  registerReactionHubHooks();
}

export function registerReactionHubSocket() {
  registerReactionHubConfig();
  game.socket.on(REACTION_SOCKET, handleReactionSocketMessage);
}

export function registerReactionProvider(provider = {}) {
  const id = String(provider?.id ?? "").trim();
  if (!id || typeof provider.collect !== "function" || typeof provider.execute !== "function") return false;
  reactionProviders.set(id, provider);
  return true;
}

export function registerReactionEventSemanticAdapter(adapter = null) {
  reactionEventSemanticAdapter = typeof adapter === "function" ? adapter : null;
  return () => {
    if (reactionEventSemanticAdapter === adapter) reactionEventSemanticAdapter = null;
  };
}

export function registerReactionExecutionGuard(guard = null) {
  reactionExecutionGuard = typeof guard === "function" ? guard : null;
  return () => {
    if (reactionExecutionGuard === guard) reactionExecutionGuard = null;
  };
}

/**
 * Run work while nesting reaction requests into the hub queue, then drain one
 * opportunity wave (column hub, single choice) when the work finishes.
 */
export async function withQueuedReactionOpportunityWave(work) {
  reactionExecutionDepth += 1;
  try {
    return await work();
  } finally {
    reactionExecutionDepth -= 1;
    if (reactionExecutionDepth === 0) await drainPendingReactionRequests();
  }
}

export function isReactionSystemLocked() {
  return activeReactionLocks.size > 0;
}

export function isActorUnableToAct(actor = null) {
  return !actor || actorHasIncapacitatingStatus(actor);
}

export function actorHasIncapacitatingStatus(actor = null) {
  if (!actor) return false;
  const defeatedStatus = CONFIG.specialStatusEffects.DEFEATED;
  return Boolean(
    Array.from(UNABLE_TO_ACT_STATUSES).some(status => actor.statuses?.has?.(status))
    || (defeatedStatus && actor.statuses?.has?.(defeatedStatus))
  );
}

export async function requestReactionEvent(eventKey = "", context = {}) {
  const normalizedEventKey = String(eventKey ?? "").trim();
  if (!normalizedEventKey) return createReactionHubResult();
  const request = {
    eventKey: normalizedEventKey,
    context: foundry.utils.deepClone(context ?? {}),
    requesterUserId: game.user?.id ?? ""
  };
  if (isCurrentActiveGM()) return dispatchReactionEventRequest(request);
  const gm = getResponsibleGM();
  if (!gm) return createReactionHubResult({ reason: "noGM" });
  return requestReactionEventFromGM(gm, request, getReactionTimeoutMs());
}

/**
 * Unified scheduling: while any reaction execute is in flight, new opportunities
 * enqueue and return a non-cancelling result so the active cycle is not nested.
 * Queued requests drain FIFO after the current execute cycle finishes.
 */
function dispatchReactionEventRequest(request = {}) {
  if (reactionExecutionDepth > 0) {
    // Nested requests drain after the current wave releases its root lease/token.
    // Keep the payload, but drop chainRef so drain opens a fresh root instead of
    // failing acquire with invalidLease / expiredLineage.
    const context = foundry.utils.deepClone(request?.context ?? {});
    if (context.chainRef) context.chainRef = null;
    if (context.envelope && typeof context.envelope === "object") context.envelope.chainRef = null;
    if (context.semanticEvent && typeof context.semanticEvent === "object") context.semanticEvent.chainRef = null;
    pendingReactionRequests.push({ ...request, context });
    return Promise.resolve(createReactionHubResult({ reason: "queued" }));
  }
  return processReactionEventRequest(request);
}

async function drainPendingReactionRequests() {
  if (drainingReactionQueue || reactionExecutionDepth > 0) return;
  drainingReactionQueue = true;
  try {
    while (pendingReactionRequests.length) {
      // One wave = everything already queued. Collect all real opportunities first,
      // then one column hub (one choice). Empty adapter/no-offer requests just clear.
      const wave = pendingReactionRequests.splice(0, pendingReactionRequests.length);
      const opportunities = [];
      // Keep nested requestReactionEvent calls queued while we collect the wave.
      reactionExecutionDepth += 1;
      try {
        for (const request of wave) {
          const resolved = await resolveReactionRequestOffers(request);
          if (resolved.adapterResult) continue;
          if (!resolved.offers.length) continue;
          opportunities.push(resolved);
        }
      } finally {
        reactionExecutionDepth -= 1;
      }
      if (opportunities.length) await presentAndExecuteReactionOpportunities(opportunities);
    }
  } finally {
    drainingReactionQueue = false;
  }
}

function requestReactionEventFromGM(gm, request, timeoutMs = getReactionTimeoutMs()) {
  const requestId = foundry.utils.randomID();
  return new Promise(resolve => {
    const timeoutId = globalThis.setTimeout(() => {
      pendingReactionSocketRequests.delete(requestId);
      resolve(createReactionHubResult({ reason: "timeout" }));
    }, timeoutMs + REACTION_SOCKET_COMPLETION_GRACE_MS);
    pendingReactionSocketRequests.set(requestId, { resolve, timeoutId });
    game.socket.emit(REACTION_SOCKET, {
      scope: REACTION_SOCKET_SCOPE,
      action: "requestReactionEvent",
      requestId,
      targetUserId: gm.id,
      request
    });
  });
}

async function handleReactionSocketMessage(payload = {}) {
  if (payload?.scope !== REACTION_SOCKET_SCOPE) return;
  if (payload.action === "setReactionLock") {
    setLocalReactionLock(payload.lockId, Boolean(payload.active), payload.reason);
    return;
  }
  if (payload.action === "requestReactionEvent") {
    if (!isCurrentActiveGM() || payload.targetUserId !== game.user.id) return;
    const result = await dispatchReactionEventRequest(payload.request ?? {});
    game.socket.emit(REACTION_SOCKET, {
      scope: REACTION_SOCKET_SCOPE,
      action: "reactionEventResult",
      requestId: payload.requestId,
      targetUserId: payload.request?.requesterUserId ?? "",
      result
    });
    return;
  }
  if (payload.action !== "reactionEventResult" || payload.targetUserId !== game.user?.id) return;
  const pending = pendingReactionSocketRequests.get(payload.requestId);
  if (!pending) return;
  pendingReactionSocketRequests.delete(payload.requestId);
  globalThis.clearTimeout(pending.timeoutId);
  pending.resolve(payload.result ?? createReactionHubResult());
}

async function processReactionEventRequest(request = {}) {
  const resolved = await resolveReactionRequestOffers(request);
  if (resolved.adapterResult) return resolved.adapterResult;
  if (!resolved.offers.length) return createReactionHubResult();
  return presentAndExecuteReactionOpportunities([resolved]);
}

/**
 * Adapt/collect for one request without opening the hub UI.
 * Returns either an early adapter result, or offers + column metadata for a wave.
 */
async function resolveReactionRequestOffers(request = {}) {
  if (!isCurrentActiveGM()) {
    return { adapterResult: createReactionHubResult({ reason: "notGM" }), offers: [], column: null, request };
  }
  const eventKey = String(request.eventKey ?? "").trim();
  const context = request.context ?? {};
  const requiresSemanticAdapter = LEGACY_REACTION_EVENT_KEYS.has(eventKey)
    && !context?.falloutMawSemanticReactionAdapted;
  if (requiresSemanticAdapter) {
    if (!reactionEventSemanticAdapter) {
      return {
        adapterResult: createReactionHubResult({ reason: "semanticAdapterUnavailable" }),
        offers: [],
        column: null,
        request
      };
    }
    try {
      const adapted = await reactionEventSemanticAdapter(eventKey, context);
      return {
        adapterResult: createReactionHubResult(adapted ?? { reason: "semanticEventUnavailable" }),
        offers: [],
        column: null,
        request
      };
    } catch (error) {
      console.error(`${SYSTEM_ID} | Semantic reaction adapter failed for '${eventKey}'`, error);
      return {
        adapterResult: createReactionHubResult({ reason: "semanticAdapterError" }),
        offers: [],
        column: null,
        request
      };
    }
  }
  if (reactionEventSemanticAdapter && !context?.falloutMawSemanticReactionAdapted) {
    try {
      const adapted = await reactionEventSemanticAdapter(eventKey, context);
      if (adapted !== undefined) {
        return {
          adapterResult: createReactionHubResult(adapted ?? {}),
          offers: [],
          column: null,
          request
        };
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Semantic reaction adapter failed for '${eventKey}'`, error);
      return {
        adapterResult: createReactionHubResult({ reason: "semanticAdapterError" }),
        offers: [],
        column: null,
        request
      };
    }
  }

  const semanticEvent = request.semanticEvent ?? context?.semanticEvent ?? null;
  const offers = [];
  for (const provider of reactionProviders.values()) {
    let providerOffers = [];
    try {
      providerOffers = await provider.collect({ eventKey, context, semanticEvent });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Reaction provider failed: ${provider.id}`, error);
    }
    for (const offer of providerOffers ?? []) {
      const actorUuid = String(offer?.actorUuid ?? "").trim();
      const offerId = String(offer?.offerId ?? offer?.reactionId ?? provider.id).trim();
      if (!actorUuid || !offerId) continue;
      const actor = await fromUuid(actorUuid);
      if (!canActorReact(actor)) continue;
      if (!canAffordReactionOffer(actor, offer)) continue;
      offers.push({
        ...offer,
        providerId: provider.id,
        offerId
      });
    }
  }
  const column = await buildReactionOpportunityColumn(request, eventKey, context, semanticEvent);
  return {
    adapterResult: null,
    offers,
    column,
    eventKey,
    context,
    semanticEvent,
    request
  };
}

async function buildReactionOpportunityColumn(request = {}, eventKey = "", context = {}, semanticEvent = null) {
  const envelope = semanticEvent
    ?? context?.semanticEvent
    ?? context?.envelope
    ?? request?.semanticEvent
    ?? null;
  const triggerActorUuid = getEventParticipantActorUuid(envelope?.source);
  let triggerActor = triggerActorUuid ? await fromUuid(triggerActorUuid).catch(() => null) : null;
  if (!triggerActor && envelope?.source?.actor) triggerActor = envelope.source.actor;
  const descriptor = getSystemEventDescriptor(eventKey);
  const eventLabel = descriptor?.labelKey
    ? localizeReactionText(descriptor.labelKey, eventKey)
    : (context?.title || eventKey || localizeReactionText("FALLOUTMAW.Events.Reaction.Title", "Reaction"));
  const eventDescription = descriptor?.descriptionKey
    ? localizeReactionText(descriptor.descriptionKey, "")
    : String(context?.message ?? "");
  return {
    columnId: [
      eventKey,
      triggerActorUuid,
      String(envelope?.rootId ?? ""),
      String(envelope?.eventId ?? foundry.utils.randomID())
    ].join("|"),
    eventKey,
    eventLabel,
    eventDescription,
    triggerActorUuid,
    triggerActorName: String(triggerActor?.name ?? context?.triggerActorName ?? "").trim()
      || localizeReactionText("FALLOUTMAW.Events.Reaction.UnknownSubject", "Unknown subject"),
    triggerActorImg: normalizeImagePath(triggerActor?.img, "icons/svg/mystery-man.svg"),
    rootId: String(envelope?.rootId ?? "")
  };
}

async function presentAndExecuteReactionOpportunities(opportunities = []) {
  const usable = (opportunities ?? []).filter(entry => entry?.offers?.length && entry?.column);
  if (!usable.length) return createReactionHubResult();

  const timeoutMs = getReactionTimeoutMs();
  const allOffers = usable.flatMap(entry => entry.offers.map(offer => ({
    ...offer,
    __opportunity: entry
  })));
  const allOffersByActor = new Map();
  for (const offer of allOffers) {
    if (!allOffersByActor.has(offer.actorUuid)) allOffersByActor.set(offer.actorUuid, []);
    allOffersByActor.get(offer.actorUuid).push(offer);
  }
  const allActorOrder = await getStableReactionActorOrder(allOffersByActor.keys());
  const isolatedAutomaticOffers = allActorOrder.flatMap(actorUuid => (
    (allOffersByActor.get(actorUuid) ?? []).filter(isIsolatedAutomaticOffer)
  ));
  const standardOffers = allActorOrder.flatMap(actorUuid => (
    (allOffersByActor.get(actorUuid) ?? []).filter(offer => !isIsolatedAutomaticOffer(offer))
  ));
  let finalResult = createReactionHubResult();

  reactionExecutionDepth += 1;
  try {
    for (const offer of isolatedAutomaticOffers) {
      const result = await executeReactionOffer({
        offer,
        response: { offerId: offer.offerId, isolatedAutomatic: true },
        opportunity: offer.__opportunity
      });
      finalResult = mergeReactionHubResults(finalResult, result);
      if (finalResult.cancelRemaining) return finalResult;
    }

    if (!standardOffers.length) return finalResult;
    const offersByActor = new Map();
    for (const offer of standardOffers) {
      if (!offersByActor.has(offer.actorUuid)) offersByActor.set(offer.actorUuid, []);
      offersByActor.get(offer.actorUuid).push(offer);
    }
    const actorOrder = allActorOrder.filter(actorUuid => offersByActor.has(actorUuid));
    const standardOpportunityIds = new Set(standardOffers.map(offer => offer.__opportunity?.column?.columnId));
    const columns = usable
      .filter(entry => standardOpportunityIds.has(entry.column?.columnId))
      .map(entry => entry.column);
    const lockId = foundry.utils.randomID();
    let responses = new Map();
    beginReactionLock(lockId, { reason: "reaction-opportunity-wave" });
    try {
      await createReactionOpportunityMessage({
        context: standardOffers[0]?.__opportunity?.context ?? {},
        actorOrder,
        offersByActor
      });
      responses = await queryReactionOwners(actorOrder, offersByActor, {
        eventKey: standardOffers[0]?.__opportunity?.eventKey ?? "",
        context: standardOffers[0]?.__opportunity?.context ?? {},
        timeoutMs,
        columns,
        singleSelection: true
      });
    } finally {
      endReactionLock(lockId);
    }

    let selected = null;
    // One choice for the whole wave: first non-empty selection in reactor order.
    for (const actorUuid of actorOrder) {
      const response = responses.get(actorUuid) ?? null;
      if (!response?.offerId) continue;
      const offer = standardOffers.find(entry => entry.actorUuid === actorUuid && entry.offerId === response.offerId);
      if (offer) {
        selected = { offer, response, opportunity: offer.__opportunity };
        break;
      }
    }
    if (!selected) {
      await notifyDeclinedReactionOffers(standardOffers, { reason: "declined" });
      return finalResult;
    }
    await notifyDeclinedReactionOffers(
      standardOffers.filter(offer => offer.offerId !== selected.offer.offerId),
      { reason: "notSelected" }
    );
    finalResult = mergeReactionHubResults(finalResult, await executeReactionOffer(selected));
    return finalResult;
  } finally {
    reactionExecutionDepth -= 1;
    if (reactionExecutionDepth === 0) await drainPendingReactionRequests();
  }
}

async function executeReactionOffer({ offer = {}, response = {}, opportunity = {} } = {}) {
  const actor = await fromUuid(offer.actorUuid);
  if (!canActorReact(actor) || !canAffordReactionOffer(actor, offer)) {
    return createReactionHubResult({ status: REACTION_RESULT.failed, reason: "unableToAct" });
  }
  const provider = reactionProviders.get(offer.providerId);
  if (!provider) return createReactionHubResult({ status: REACTION_RESULT.failed, reason: "missingProvider" });
  const eventKey = opportunity.eventKey ?? "";
  const context = opportunity.context ?? {};
  const semanticEvent = opportunity.semanticEvent ?? null;
  try {
    if (reactionExecutionGuard) {
      const allowed = await reactionExecutionGuard({
        eventKey,
        context,
        semanticEvent,
        offer,
        response
      });
      if (allowed === false) return createReactionHubResult({ status: REACTION_RESULT.failed, reason: "guardBlocked" });
    }
    return createReactionHubResult(await provider.execute({
      eventKey,
      context,
      semanticEvent,
      offer,
      response
    }) ?? {});
  } catch (error) {
    console.error(`${SYSTEM_ID} | Reaction execution failed: ${offer.providerId}`, error);
    return createReactionHubResult({ status: REACTION_RESULT.failed, reason: "executionError" });
  }
}

async function notifyDeclinedReactionOffers(offers = [], { reason = "declined" } = {}) {
  for (const offer of offers ?? []) {
    const provider = reactionProviders.get(offer?.providerId);
    if (typeof provider?.decline !== "function") continue;
    const opportunity = offer?.__opportunity ?? {};
    try {
      await provider.decline({
        eventKey: opportunity.eventKey ?? "",
        context: opportunity.context ?? {},
        semanticEvent: opportunity.semanticEvent ?? null,
        offer,
        reason
      });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Reaction decline handling failed: ${offer?.providerId ?? "unknown"}`, error);
    }
  }
}

function isIsolatedAutomaticOffer(offer = {}) {
  return String(offer?.reactionMode ?? "") === "isolatedAuto";
}

function canAffordReactionOffer(actor, offer = {}) {
  const energyCost = Math.max(0, toInteger(offer.energyCost));
  if (energyCost > 0 && !canActorSpendEnergy(actor, energyCost)) return false;
  return true;
}

async function createReactionOpportunityMessage({ context = {}, actorOrder = [], offersByActor = new Map() } = {}) {
  const rows = [];
  for (const actorUuid of actorOrder) {
    const actor = await fromUuid(actorUuid);
    if (!actor || !(offersByActor.get(actorUuid) ?? []).length) continue;
    rows.push(`<li><strong>${escapeHTML(actor.name)}</strong></li>`);
  }
  if (!rows.length) return null;
  return ChatMessage.create({
    content: `
      <div class="fallout-maw-reaction-notice">
        <p><strong>${escapeHTML(localizeReactionText(
          "FALLOUTMAW.Events.Reaction.Opportunity",
          "Actors have an opportunity to react."
        ))}</strong></p>
        <ul>${rows.join("")}</ul>
      </div>
    `,
    sound: null
  });
}

async function getStableReactionActorOrder(actorUuids = []) {
  const entries = [];
  for (const actorUuid of actorUuids) {
    const actor = await fromUuid(actorUuid);
    if (!actor) continue;
    const token = (canvas?.scene?.tokens?.contents ?? [])
      .filter(candidate => candidate?.actor?.uuid === actor.uuid)
      .sort((left, right) => (
        (Number(left.sort) || 0) - (Number(right.sort) || 0)
        || String(left.id).localeCompare(String(right.id))
      ))
      .at(0) ?? null;
    entries.push({
      actorUuid: actor.uuid,
      sceneId: String(token?.parent?.id ?? ""),
      tokenSort: Number(token?.sort) || 0,
      tokenId: String(token?.id ?? ""),
      actorName: String(actor.name ?? "")
    });
  }
  return entries
    .sort((left, right) => (
      left.sceneId.localeCompare(right.sceneId)
      || left.tokenSort - right.tokenSort
      || left.tokenId.localeCompare(right.tokenId)
      || left.actorName.localeCompare(right.actorName)
      || left.actorUuid.localeCompare(right.actorUuid)
    ))
    .map(entry => entry.actorUuid);
}

async function queryReactionOwners(actorOrder = [], offersByActor = new Map(), {
  eventKey = "",
  context = {},
  timeoutMs = getReactionTimeoutMs(),
  columns = null,
  singleSelection = false
} = {}) {
  const groups = new Map();
  for (const actorUuid of actorOrder) {
    const actor = await fromUuid(actorUuid);
    const offers = offersByActor.get(actorUuid) ?? [];
    if (!actor || !offers.length) continue;
    const owner = getResponsibleOwner(actor) ?? getResponsibleGM();
    if (!owner) continue;
    const group = groups.get(owner.id) ?? { owner, actors: [] };
    group.actors.push({ actor, offers });
    groups.set(owner.id, group);
  }

  const results = await Promise.all(Array.from(groups.values()).map(group => (
    queryReactionOwnerGroup(group.owner, group.actors, {
      eventKey,
      context,
      timeoutMs,
      columns,
      singleSelection
    })
  )));
  const responses = new Map();
  for (const result of results) {
    for (const selection of result?.selections ?? []) {
      const actorUuid = String(selection?.actorUuid ?? "").trim();
      const offerId = String(selection?.offerId ?? "").trim();
      if (actorUuid && offerId) responses.set(actorUuid, { offerId });
    }
  }
  return responses;
}

async function queryReactionOwnerGroup(owner, actors = [], {
  eventKey = "",
  context = {},
  timeoutMs = getReactionTimeoutMs(),
  columns = null,
  singleSelection = false
} = {}) {
  if (!owner || !actors.length) return { selections: [] };
  const offerLabels = Array.from(new Set(actors
    .flatMap(entry => entry.offers)
    .map(offer => String(offer?.label ?? "").trim())
    .filter(Boolean)));
  const columnPayload = Array.isArray(columns) && columns.length
    ? columns.map(column => {
      const columnOffers = actors.flatMap(({ actor, offers }) => offers
        .filter(offer => {
          const opportunity = offer.__opportunity;
          return !opportunity || opportunity.column?.columnId === column.columnId;
        })
        .map(offer => ({
          offerId: offer.offerId,
          actorUuid: actor.uuid,
          actorName: actor.name,
          label: String(offer.label ?? localizeReactionText("FALLOUTMAW.Events.Reaction.Title", "Reaction")),
          description: String(offer.description ?? ""),
          img: normalizeImagePath(offer.img, "icons/svg/aura.svg"),
          costLines: Array.isArray(offer.costLines) ? offer.costLines.map(line => String(line ?? "")) : []
        })));
      return {
        columnId: column.columnId,
        triggerActorUuid: column.triggerActorUuid,
        triggerActorName: column.triggerActorName,
        triggerActorImg: column.triggerActorImg,
        eventKey: column.eventKey,
        eventLabel: column.eventLabel,
        eventDescription: column.eventDescription,
        offers: columnOffers
      };
    }).filter(column => column.offers.length)
    : null;
  const queryData = {
    eventKey,
    timeoutMs,
    singleSelection: Boolean(singleSelection || columnPayload?.length),
    title: columnPayload?.length
      ? localizeReactionText("FALLOUTMAW.Events.Reaction.Title", "Reaction")
      : (offerLabels.length === 1
        ? offerLabels[0]
        : (context?.title ?? localizeReactionText("FALLOUTMAW.Events.Reaction.Title", "Reaction"))),
    message: context?.message ?? "",
    columns: columnPayload,
    actors: actors.map(({ actor, offers }) => ({
      actorUuid: actor.uuid,
      actorName: actor.name,
      actorImg: normalizeImagePath(actor.img, "icons/svg/mystery-man.svg"),
      offers: offers.map(offer => ({
        offerId: offer.offerId,
        label: String(offer.label ?? localizeReactionText("FALLOUTMAW.Events.Reaction.Title", "Reaction")),
        description: String(offer.description ?? ""),
        img: normalizeImagePath(offer.img, "icons/svg/aura.svg"),
        costLines: Array.isArray(offer.costLines) ? offer.costLines.map(line => String(line ?? "")) : []
      }))
    }))
  };
  try {
    if (owner.isSelf) return handleReactionQuery(queryData);
    return owner.query(REACTION_QUERY_NAME, queryData, { timeout: timeoutMs });
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Reaction query failed`, error);
    return { selections: [] };
  }
}

async function handleReactionQuery(data = {}) {
  const columns = Array.isArray(data.columns)
    ? data.columns.filter(entry => Array.isArray(entry?.offers) && entry.offers.length)
    : [];
  const actors = Array.isArray(data.actors)
    ? data.actors.filter(entry => Array.isArray(entry?.offers) && entry.offers.length)
    : [];
  if (!columns.length && !actors.length) return { selections: [] };
  const timeoutMs = normalizeReactionTimeoutMs(data.timeoutMs);
  const useColumns = columns.length > 0;
  // Content must NOT wrap another <form>: DialogV2 already renders a top-level form, and nested
  // forms break button.form / FormDataExtended so accept/decline never see radio values.
  let content;
  if (useColumns) {
    const columnSections = columns.map(column => {
      const options = column.offers.map(offer => `
        <label class="fallout-maw-reaction-option">
          <input type="radio" name="selectedOfferId" value="${escapeHTML(offer.offerId)}">
          <img src="${escapeHTML(offer.img)}" alt="">
          <span>
            <strong>${escapeHTML(offer.label)}</strong>
            ${offer.actorName ? `<small>${escapeHTML(offer.actorName)}</small>` : ""}
            ${offer.description ? `<small>${escapeHTML(offer.description)}</small>` : ""}
            ${(offer.costLines ?? []).map(line => `<em>${escapeHTML(line)}</em>`).join("")}
          </span>
        </label>
      `).join("");
      return `
        <fieldset class="fallout-maw-reaction-column" data-column-id="${escapeHTML(column.columnId)}">
          <legend>
            <img src="${escapeHTML(column.triggerActorImg)}" alt="">
            <span>
              <strong>${escapeHTML(column.triggerActorName)}</strong>
              <small>${escapeHTML(column.eventLabel)}</small>
            </span>
          </legend>
          ${column.eventDescription ? `<p class="fallout-maw-reaction-column-condition">${escapeHTML(column.eventDescription)}</p>` : ""}
          ${options}
        </fieldset>
      `;
    }).join("");
    content = `
      <div class="fallout-maw-reaction-dialog">
        <div class="fallout-maw-reaction-timer" aria-hidden="true">
          <span style="animation-duration: ${timeoutMs}ms;"></span>
        </div>
        ${data.message ? `<p>${escapeHTML(data.message)}</p>` : ""}
        <label class="fallout-maw-reaction-option fallout-maw-reaction-decline">
          <input type="radio" name="selectedOfferId" value="" checked>
          <span><strong>${escapeHTML(localizeReactionText("FALLOUTMAW.Events.Reaction.Decline", "Decline"))}</strong></span>
        </label>
        <div class="fallout-maw-reaction-columns">${columnSections}</div>
      </div>
    `;
  } else {
    const sections = actors.map((actor, actorIndex) => {
      const options = actor.offers.map(offer => `
        <label class="fallout-maw-reaction-option">
          <input type="radio" name="offerId-${actorIndex}" value="${escapeHTML(offer.offerId)}">
          <img src="${escapeHTML(offer.img)}" alt="">
          <span>
            <strong>${escapeHTML(offer.label)}</strong>
            ${offer.description ? `<small>${escapeHTML(offer.description)}</small>` : ""}
            ${(offer.costLines ?? []).map(line => `<em>${escapeHTML(line)}</em>`).join("")}
          </span>
        </label>
      `).join("");
      return `
        <fieldset class="fallout-maw-reaction-actor" data-actor-uuid="${escapeHTML(actor.actorUuid)}">
          <legend><img src="${escapeHTML(actor.actorImg)}" alt=""> ${escapeHTML(actor.actorName)}</legend>
          <label class="fallout-maw-reaction-option fallout-maw-reaction-decline">
            <input type="radio" name="offerId-${actorIndex}" value="" checked>
            <span><strong>${escapeHTML(localizeReactionText("FALLOUTMAW.Events.Reaction.Decline", "Decline"))}</strong></span>
          </label>
          ${options}
        </fieldset>
      `;
    }).join("");
    content = `
      <div class="fallout-maw-reaction-dialog">
        <div class="fallout-maw-reaction-timer" aria-hidden="true">
          <span style="animation-duration: ${timeoutMs}ms;"></span>
        </div>
        ${data.message ? `<p>${escapeHTML(data.message)}</p>` : ""}
        <div class="fallout-maw-reaction-options">${sections}</div>
      </div>
    `;
  }
  let timeoutId = null;
  const formData = await DialogV2.input({
    window: {
      title: String(data.title ?? localizeReactionText("FALLOUTMAW.Events.Reaction.Title", "Reaction"))
    },
    content,
    ok: {
      label: localizeReactionText("FALLOUTMAW.Events.Reaction.Accept", "React"),
      icon: "fa-solid fa-bolt",
      callback: (_event, button, dialog) => {
        const form = button?.form ?? dialog?.element?.querySelector?.("form.dialog-form") ?? null;
        return form ? new FormDataExtended(form).object : {};
      }
    },
    buttons: [{
      action: "decline",
      label: localizeReactionText("FALLOUTMAW.Events.Reaction.DeclineAll", "Decline all"),
      callback: () => ({ __reactionDeclineAll: true })
    }],
    position: { width: useColumns && columns.length > 1 ? Math.min(420 * columns.length, 960) : 520 },
    rejectClose: false,
    render: (_event, dialog) => {
      timeoutId = globalThis.setTimeout(() => {
        void dialog.close();
      }, timeoutMs);
    },
    close: () => {
      if (timeoutId) globalThis.clearTimeout(timeoutId);
      timeoutId = null;
      return null;
    }
  });
  if (!formData || formData === "decline" || formData?.__reactionDeclineAll) {
    return { selections: [] };
  }
  if (useColumns) {
    const offerId = String(formData?.selectedOfferId ?? "").trim();
    if (!offerId) return { selections: [] };
    const matched = columns.flatMap(column => column.offers).find(offer => offer.offerId === offerId);
    if (!matched) return { selections: [] };
    return {
      selections: [{
        actorUuid: String(matched.actorUuid ?? ""),
        offerId
      }]
    };
  }
  const selections = actors.map((actor, index) => ({
    actorUuid: String(actor.actorUuid ?? ""),
    offerId: String(formData?.[`offerId-${index}`] ?? "").trim()
  })).filter(selection => selection.actorUuid && selection.offerId);
  return { selections };
}

function localizeReactionText(key, fallback) {
  const localized = game.i18n?.localize?.(key);
  return localized && localized !== key ? localized : fallback;
}

export function getReactionTimeoutMs() {
  const seconds = Number(getCombatSettings()?.reactions?.timeoutSeconds);
  return normalizeReactionTimeoutMs(Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_REACTION_TIMEOUT_MS);
}

function normalizeReactionTimeoutMs(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return DEFAULT_REACTION_TIMEOUT_MS;
  return Math.max(1000, Math.min(600000, Math.trunc(milliseconds)));
}

export const REACTION_HUB_TESTING = Object.freeze({
  getReactionTimeoutMs,
  normalizeReactionTimeoutMs
});

function createReactionHubResult(data = {}) {
  return {
    handled: Boolean(data.handled),
    status: String(data.status ?? REACTION_RESULT.declined),
    cancelCurrent: Boolean(data.cancelCurrent),
    cancelRemaining: Boolean(data.cancelRemaining),
    difficultyBonus: toInteger(data.difficultyBonus),
    reason: String(data.reason ?? "")
  };
}

function mergeReactionHubResults(current = {}, next = {}) {
  const left = createReactionHubResult(current);
  const right = createReactionHubResult(next);
  const statusPriority = {
    [REACTION_RESULT.declined]: 0,
    [REACTION_RESULT.failed]: 1,
    [REACTION_RESULT.success]: 2
  };
  const status = (statusPriority[right.status] ?? 0) > (statusPriority[left.status] ?? 0)
    ? right.status
    : left.status;
  return createReactionHubResult({
    handled: left.handled || right.handled,
    status,
    cancelCurrent: left.cancelCurrent || right.cancelCurrent,
    cancelRemaining: left.cancelRemaining || right.cancelRemaining,
    difficultyBonus: left.difficultyBonus + right.difficultyBonus,
    reason: right.reason || left.reason
  });
}

function registerReactionHubHooks() {
  if (reactionHubHooksRegistered) return;
  reactionHubHooksRegistered = true;
  Hooks.on("preMoveToken", preventReactionLockedMovement);
  Hooks.on("preUpdateToken", preventReactionLockedTokenUpdate);
}

function beginReactionLock(lockId = "", { reason = "" } = {}) {
  setLocalReactionLock(lockId, true, reason);
  broadcastReactionLock(lockId, true, reason);
}

function endReactionLock(lockId = "") {
  setLocalReactionLock(lockId, false);
  broadcastReactionLock(lockId, false);
}

function broadcastReactionLock(lockId = "", active = false, reason = "") {
  game.socket?.emit?.(REACTION_SOCKET, {
    scope: REACTION_SOCKET_SCOPE,
    action: "setReactionLock",
    lockId,
    active: Boolean(active),
    reason: String(reason ?? "")
  });
}

function setLocalReactionLock(lockId = "", active = false, reason = "") {
  const id = String(lockId ?? "").trim();
  if (!id) return;
  if (active) activeReactionLocks.set(id, { reason: String(reason ?? ""), startedAt: Date.now() });
  else activeReactionLocks.delete(id);
}

function preventReactionLockedMovement(tokenDocument, _movement, operation = {}) {
  if (operation?.[REACTION_LOCK_BYPASS_OPTION]) return true;
  if (!isReactionSystemLocked()) return true;
  if (tokenDocument?.actor) ui.notifications.warn(localizeReactionText(
    "FALLOUTMAW.Events.Reaction.MovementLocked",
    "Waiting for reactions: movement is temporarily locked."
  ));
  return false;
}

function preventReactionLockedTokenUpdate(tokenDocument, changes = {}, options = {}) {
  if (options?.[REACTION_LOCK_BYPASS_OPTION]) return true;
  if (!isReactionSystemLocked()) return true;
  const moves = foundry.utils.hasProperty(changes, "x")
    || foundry.utils.hasProperty(changes, "y")
    || foundry.utils.hasProperty(changes, "elevation");
  if (!moves) return true;
  if (tokenDocument?.actor) ui.notifications.warn(localizeReactionText(
    "FALLOUTMAW.Events.Reaction.MovementLocked",
    "Waiting for reactions: movement is temporarily locked."
  ));
  return false;
}

function canActorReact(actor) {
  return !isActorUnableToAct(actor);
}

function getResponsibleGM() {
  return game.users?.activeGM ?? null;
}

function isCurrentActiveGM() {
  const activeGM = getResponsibleGM();
  return Boolean(activeGM && game.user?.id === activeGM.id);
}

export function getResponsibleOwner(actor) {
  return (game.users?.contents ?? [])
    .filter(user => user.active && !user.isGM && actor?.testUserPermission?.(user, "OWNER"))
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
