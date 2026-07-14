import { SYSTEM_ID } from "../constants.mjs";
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
  if (isCurrentActiveGM()) return processReactionEventRequest(request);
  const gm = getResponsibleGM();
  if (!gm) return createReactionHubResult({ reason: "noGM" });
  return requestReactionEventFromGM(gm, request, getReactionTimeoutMs());
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
    const result = await processReactionEventRequest(payload.request ?? {});
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
  if (!isCurrentActiveGM()) return createReactionHubResult({ reason: "notGM" });
  const eventKey = String(request.eventKey ?? "").trim();
  const context = request.context ?? {};
  const requiresSemanticAdapter = LEGACY_REACTION_EVENT_KEYS.has(eventKey)
    && !context?.falloutMawSemanticReactionAdapted;
  if (requiresSemanticAdapter) {
    if (!reactionEventSemanticAdapter) {
      return createReactionHubResult({ reason: "semanticAdapterUnavailable" });
    }
    try {
      const adapted = await reactionEventSemanticAdapter(eventKey, context);
      return createReactionHubResult(adapted ?? { reason: "semanticEventUnavailable" });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Semantic reaction adapter failed for '${eventKey}'`, error);
      return createReactionHubResult({ reason: "semanticAdapterError" });
    }
  }
  if (reactionEventSemanticAdapter && !context?.falloutMawSemanticReactionAdapted) {
    try {
      const adapted = await reactionEventSemanticAdapter(eventKey, context);
      if (adapted !== undefined) return createReactionHubResult(adapted ?? {});
    } catch (error) {
      console.error(`${SYSTEM_ID} | Semantic reaction adapter failed for '${eventKey}'`, error);
      return createReactionHubResult({ reason: "semanticAdapterError" });
    }
  }
  const semanticEvent = request.semanticEvent ?? context?.semanticEvent ?? null;
  const timeoutMs = getReactionTimeoutMs();
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
  if (!offers.length) return createReactionHubResult();

  const lockId = foundry.utils.randomID();
  const offersByActor = new Map();
  for (const offer of offers) {
    if (!offersByActor.has(offer.actorUuid)) offersByActor.set(offer.actorUuid, []);
    offersByActor.get(offer.actorUuid).push(offer);
  }
  const actorOrder = await getStableReactionActorOrder(offersByActor.keys());
  let responses = new Map();
  // The global lock protects only the simultaneous decision window. A selected reaction may open another
  // Reaction Hub while it executes, so keeping this lock through provider.execute would nest under the parent lock.
  beginReactionLock(lockId, { reason: eventKey });
  try {
    await createReactionOpportunityMessage({ context, actorOrder, offersByActor });
    responses = await queryReactionOwners(actorOrder, offersByActor, { eventKey, context, timeoutMs });
  } finally {
    endReactionLock(lockId);
  }

  let finalResult = createReactionHubResult();
  for (const actorUuid of actorOrder) {
    const actorOffers = offersByActor.get(actorUuid) ?? [];
    const actor = await fromUuid(actorUuid);
    if (!canActorReact(actor)) continue;
    const response = responses.get(actorUuid) ?? null;
    if (!response?.offerId) continue;
    const selectedOffer = actorOffers.find(offer => offer.offerId === response.offerId);
    if (!selectedOffer) continue;
    if (!canAffordReactionOffer(actor, selectedOffer)) continue;
    const provider = reactionProviders.get(selectedOffer.providerId);
    if (!provider) continue;
    try {
      if (reactionExecutionGuard) {
        const allowed = await reactionExecutionGuard({
          eventKey,
          context,
          semanticEvent,
          offer: selectedOffer,
          response
        });
        if (allowed === false) continue;
      }
      const result = await provider.execute({
        eventKey,
        context,
        semanticEvent,
        offer: selectedOffer,
        response
      });
      const normalized = createReactionHubResult(result ?? {});
      finalResult = mergeReactionHubResults(finalResult, normalized);
      if (normalized.cancelRemaining) break;
    } catch (error) {
      console.error(`${SYSTEM_ID} | Reaction execution failed: ${selectedOffer.providerId}`, error);
    }
  }
  return finalResult;
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
  timeoutMs = getReactionTimeoutMs()
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
    queryReactionOwnerGroup(group.owner, group.actors, { eventKey, context, timeoutMs })
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
  timeoutMs = getReactionTimeoutMs()
} = {}) {
  if (!owner || !actors.length) return { selections: [] };
  const offerLabels = Array.from(new Set(actors
    .flatMap(entry => entry.offers)
    .map(offer => String(offer?.label ?? "").trim())
    .filter(Boolean)));
  const queryData = {
    eventKey,
    timeoutMs,
    title: offerLabels.length === 1
      ? offerLabels[0]
      : (context?.title ?? localizeReactionText("FALLOUTMAW.Events.Reaction.Title", "Reaction")),
    message: context?.message ?? "",
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
  const actors = Array.isArray(data.actors)
    ? data.actors.filter(entry => Array.isArray(entry?.offers) && entry.offers.length)
    : [];
  if (!actors.length) return { selections: [] };
  const timeoutMs = normalizeReactionTimeoutMs(data.timeoutMs);
  // Content must NOT wrap another <form>: DialogV2 already renders a top-level form, and nested
  // forms break button.form / FormDataExtended so accept/decline never see radio values.
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
  const content = `
    <div class="fallout-maw-reaction-dialog">
      <div class="fallout-maw-reaction-timer" aria-hidden="true">
        <span style="animation-duration: ${timeoutMs}ms;"></span>
      </div>
      ${data.message ? `<p>${escapeHTML(data.message)}</p>` : ""}
      <div class="fallout-maw-reaction-options">${sections}</div>
    </div>
  `;
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
    position: { width: 520 },
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
