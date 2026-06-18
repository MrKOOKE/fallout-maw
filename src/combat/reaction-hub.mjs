import { SYSTEM_ID } from "../constants.mjs";
import { escapeHTML, normalizeImagePath } from "../utils/actor-display-data.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;

export const REACTION_EVENT_KEYS = Object.freeze({
  weaponAttackTargeted: "weaponAttackTargeted",
  weaponAttackResolved: "weaponAttackResolved",
  tokenLeavingAdjacency: "tokenLeavingAdjacency"
});

export const REACTION_RESULT = Object.freeze({
  declined: "declined",
  failed: "failed",
  success: "success"
});

const REACTION_SOCKET = `system.${SYSTEM_ID}`;
const REACTION_SOCKET_SCOPE = "fallout-maw.reactionHub";
const REACTION_QUERY_NAME = "falloutMawReaction";
const REACTION_TIMEOUT_MS = 20000;
export const REACTION_LOCK_BYPASS_OPTION = "falloutMawReactionLockBypass";
const pendingReactionSocketRequests = new Map();
const reactionProviders = new Map();
const activeReactionLocks = new Map();
let reactionHubHooksRegistered = false;

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

export function isReactionSystemLocked() {
  return activeReactionLocks.size > 0;
}

export async function requestReactionEvent(eventKey = "", context = {}) {
  const normalizedEventKey = String(eventKey ?? "").trim();
  if (!normalizedEventKey) return createReactionHubResult();
  const request = {
    eventKey: normalizedEventKey,
    context: foundry.utils.deepClone(context ?? {}),
    requesterUserId: game.user?.id ?? ""
  };
  if (game.user?.isGM) return processReactionEventRequest(request);
  const gm = getResponsibleGM();
  if (!gm) return createReactionHubResult({ reason: "noGM" });
  return requestReactionEventFromGM(gm, request);
}

function requestReactionEventFromGM(gm, request) {
  const requestId = foundry.utils.randomID();
  return new Promise(resolve => {
    pendingReactionSocketRequests.set(requestId, { resolve });
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
    if (!game.user?.isGM || payload.targetUserId !== game.user.id) return;
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
  pending.resolve(payload.result ?? createReactionHubResult());
}

async function processReactionEventRequest(request = {}) {
  if (!game.user?.isGM) return createReactionHubResult({ reason: "notGM" });
  const eventKey = String(request.eventKey ?? "").trim();
  const context = request.context ?? {};
  const offers = [];
  for (const provider of reactionProviders.values()) {
    let providerOffers = [];
    try {
      providerOffers = await provider.collect({ eventKey, context });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Reaction provider failed: ${provider.id}`, error);
    }
    for (const offer of providerOffers ?? []) {
      const actorUuid = String(offer?.actorUuid ?? "").trim();
      const offerId = String(offer?.offerId ?? offer?.reactionId ?? provider.id).trim();
      if (!actorUuid || !offerId) continue;
      const actor = await fromUuid(actorUuid);
      if (!canActorReact(actor)) continue;
      offers.push({
        ...offer,
        providerId: provider.id,
        offerId
      });
    }
  }
  if (!offers.length) return createReactionHubResult();

  const lockId = foundry.utils.randomID();
  const actorOrder = [];
  const offersByActor = new Map();
  for (const offer of offers) {
    if (!offersByActor.has(offer.actorUuid)) {
      offersByActor.set(offer.actorUuid, []);
      actorOrder.push(offer.actorUuid);
    }
    offersByActor.get(offer.actorUuid).push(offer);
  }
  beginReactionLock(lockId, { reason: eventKey });
  try {
    await createReactionOpportunityMessage({ context, actorOrder, offersByActor });
    const responses = await collectReactionResponses({ eventKey, context, actorOrder, offersByActor });
    let finalResult = createReactionHubResult();
    for (const entry of responses) {
      const selectedOffer = entry.offer;
      const actor = await fromUuid(String(selectedOffer.actorUuid ?? ""));
      if (!canActorReact(actor)) continue;
      const provider = reactionProviders.get(selectedOffer.providerId);
      if (!provider) continue;
      try {
        const result = await provider.execute({
          eventKey,
          context,
          offer: selectedOffer,
          response: entry.response
        });
        const normalized = createReactionHubResult(result ?? {});
        if (normalized.handled) finalResult = normalized;
        if (normalized.cancelCurrent || normalized.cancelRemaining) return normalized;
      } catch (error) {
        console.error(`${SYSTEM_ID} | Reaction execution failed: ${selectedOffer.providerId}`, error);
      }
    }
    return finalResult;
  } finally {
    endReactionLock(lockId);
  }
}

async function collectReactionResponses({ eventKey = "", context = {}, actorOrder = [], offersByActor = new Map() } = {}) {
  let sequence = 0;
  const queries = actorOrder.map(async actorUuid => {
    const actorOffers = offersByActor.get(actorUuid) ?? [];
    const actor = await fromUuid(actorUuid);
    if (!canActorReact(actor)) return null;
    const response = await queryReactionOwner(actor, actorOffers, { eventKey, context });
    if (!response?.offerId) return null;
    const selectedOffer = actorOffers.find(offer => offer.offerId === response.offerId);
    if (!selectedOffer) return null;
    return {
      actorUuid,
      offer: selectedOffer,
      response,
      respondedAt: Date.now(),
      sequence: sequence++
    };
  });
  return (await Promise.all(queries))
    .filter(Boolean)
    .sort((left, right) => (left.respondedAt - right.respondedAt) || (left.sequence - right.sequence));
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
        <p><strong>Актеры получили возможность среагировать</strong></p>
        <ul>${rows.join("")}</ul>
      </div>
    `,
    sound: null
  });
}

async function queryReactionOwner(actor, offers = [], { eventKey = "", context = {} } = {}) {
  const owner = getResponsibleOwner(actor) ?? getResponsibleGM();
  if (!owner) return null;
  const queryData = {
    eventKey,
    actorUuid: actor.uuid,
    actorName: actor.name,
    title: context?.title ?? "Реакция",
    message: context?.message ?? "",
    offers: offers.map(offer => ({
      offerId: offer.offerId,
      label: String(offer.label ?? "Реакция"),
      description: String(offer.description ?? ""),
      img: normalizeImagePath(offer.img, "icons/svg/aura.svg"),
      costLines: Array.isArray(offer.costLines) ? offer.costLines.map(line => String(line ?? "")) : []
    }))
  };
  try {
    if (owner.isSelf) return handleReactionQuery(queryData);
    return owner.query(REACTION_QUERY_NAME, queryData, { timeout: REACTION_TIMEOUT_MS });
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Reaction query failed`, error);
    return null;
  }
}

async function handleReactionQuery(data = {}) {
  const offers = Array.isArray(data.offers) ? data.offers : [];
  if (!offers.length) return null;
  const options = offers.map((offer, index) => `
    <label class="fallout-maw-reaction-option">
      <input type="radio" name="offerId" value="${escapeHTML(offer.offerId)}" ${index === 0 ? "checked" : ""}>
      <img src="${escapeHTML(offer.img)}" alt="">
      <span>
        <strong>${escapeHTML(offer.label)}</strong>
        ${offer.description ? `<small>${escapeHTML(offer.description)}</small>` : ""}
        ${(offer.costLines ?? []).map(line => `<em>${escapeHTML(line)}</em>`).join("")}
      </span>
    </label>
  `).join("");
  const content = `
    <form class="fallout-maw-reaction-dialog">
      <div class="fallout-maw-reaction-timer" aria-hidden="true">
        <span style="animation-duration: ${REACTION_TIMEOUT_MS}ms;"></span>
      </div>
      ${data.message ? `<p>${escapeHTML(data.message)}</p>` : ""}
      <div class="fallout-maw-reaction-options">${options}</div>
    </form>
  `;
  let timeoutId = null;
  const formData = await DialogV2.input({
    window: { title: String(data.title ?? "Реакция") },
    content,
    ok: {
      label: "Среагировать",
      icon: "fa-solid fa-bolt",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{ action: "decline", label: "Отказаться" }],
    position: { width: 460 },
    rejectClose: false,
    render: (_event, dialog) => {
      timeoutId = window.setTimeout(() => {
        void dialog.close();
      }, REACTION_TIMEOUT_MS);
    },
    close: () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      timeoutId = null;
      return null;
    }
  });
  const offerId = String(formData?.offerId ?? "").trim();
  return offerId ? { offerId } : null;
}

function createReactionHubResult(data = {}) {
  return {
    handled: Boolean(data.handled),
    status: String(data.status ?? REACTION_RESULT.declined),
    cancelCurrent: Boolean(data.cancelCurrent),
    cancelRemaining: Boolean(data.cancelRemaining),
    reason: String(data.reason ?? "")
  };
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
  if (tokenDocument?.actor) ui.notifications.warn("Ожидание реакций: перемещение временно заблокировано.");
  return false;
}

function preventReactionLockedTokenUpdate(tokenDocument, changes = {}, options = {}) {
  if (options?.[REACTION_LOCK_BYPASS_OPTION]) return true;
  if (!isReactionSystemLocked()) return true;
  const moves = foundry.utils.hasProperty(changes, "x")
    || foundry.utils.hasProperty(changes, "y")
    || foundry.utils.hasProperty(changes, "elevation");
  if (!moves) return true;
  if (tokenDocument?.actor) ui.notifications.warn("Ожидание реакций: перемещение временно заблокировано.");
  return false;
}

function canActorReact(actor) {
  if (!actor) return false;
  const defeatedStatus = CONFIG.specialStatusEffects.DEFEATED;
  return !(
    actor.statuses?.has?.("dead")
    || actor.statuses?.has?.("unconscious")
    || (defeatedStatus && actor.statuses?.has?.(defeatedStatus))
  );
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function getResponsibleOwner(actor) {
  return (game.users?.contents ?? [])
    .filter(user => user.active && !user.isGM && actor?.testUserPermission?.(user, "OWNER"))
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}
