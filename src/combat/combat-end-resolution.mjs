import {
  COMBAT_DELETION_SETTLED_HOOK,
  SYSTEM_ID,
  TEMPLATES
} from "../constants.mjs";
import {
  applyDamageApplication,
  getLimbEffectiveMaximum,
  isCriticalLimb,
  isLimbDestroyed
} from "./damage-hub.mjs";
import { openSearchInventoryWindow } from "../apps/search-inventory.mjs";
import { getTokenActionHudIcons } from "../settings/accessors.mjs";
import { DEFAULT_FACTION_NAME, getActorFactionBelongs } from "../settings/factions.mjs";
import {
  COMBAT_END_SESSION_REGISTRY_DEFAULTS,
  createCombatEndSessionRegistry
} from "./combat-end-session-registry.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const COMBAT_END_SOCKET = `system.${SYSTEM_ID}`;
const COMBAT_END_SOCKET_SCOPE = "fallout-maw.combatEndResolution";
const COMBAT_END_FINISH_QUERY = `${SYSTEM_ID}.combatEndFinish`;
const COMBAT_END_COMPLETE_QUERY = `${SYSTEM_ID}.combatEndComplete`;
const COMBAT_END_FINISH_QUERY_TIMEOUT = 60 * 1000;
const COMBAT_END_FINISH_CLAIM_TTL = 60 * 1000;
const COMBAT_END_MAX_PENDING_FINISHES = 128;
const COMBAT_END_REGISTRY_PRUNE_INTERVAL = 60 * 1000;
const COMBAT_END_AUTHORITY_SYNC_DELAY = 100;
const COMBAT_END_RECOVERY_TIMEOUT = 2 * 1000;
const COMBAT_END_MAX_RECOVERY_DONORS = 8;

const STATUS_DEAD = "dead";
const STATUS_UNCONSCIOUS = "unconscious";
const WINDOW_MARGIN = 12;
const WINDOW_TOP = 16;

const combatEndSessionRegistry = createCombatEndSessionRegistry();
const renderedApplications = new Map();
const pendingFinishOperations = new Map();
let combatEndOperationQueue = Promise.resolve();
let combatEndRegistryPruneInterval = null;
let combatEndAuthoritySyncTimeout = null;
let combatEndRecoveryTimeout = null;
let combatEndFinishClaimExpiryTimeout = null;
let observedCombatEndAuthorityUserId = "";
let pendingCombatEndRecovery = null;
let combatEndHooksRegistered = false;
let combatEndSocketRegistered = false;

export function registerCombatEndResolutionHooks() {
  if (combatEndHooksRegistered) return;
  combatEndHooksRegistered = true;
  CONFIG.queries ??= {};
  CONFIG.queries[COMBAT_END_FINISH_QUERY] = handleCombatEndFinishQuery;
  CONFIG.queries[COMBAT_END_COMPLETE_QUERY] = handleCombatEndCompleteQuery;
  Hooks.on(COMBAT_DELETION_SETTLED_HOOK, handleCombatDeleted);
  Hooks.on("updateActor", actor => refreshCombatEndSessionsForActor(actor));
  Hooks.on("deleteActor", actor => removeActorFromCombatEndSessions(actor));
  Hooks.on("controlToken", () => {
    pruneCombatEndSessionRegistry();
    rerenderCombatEndApplications();
  });
  Hooks.on("canvasReady", reconcileCombatEndApplicationPresentation);
  Hooks.on("userConnected", handleCombatEndUserConnected);
  if (combatEndRegistryPruneInterval === null) {
    combatEndRegistryPruneInterval = globalThis.setInterval(
      pruneCombatEndSessionRegistry,
      COMBAT_END_REGISTRY_PRUNE_INTERVAL
    );
  }
}

export function registerCombatEndResolutionSocket() {
  if (combatEndSocketRegistered) return;
  combatEndSocketRegistered = true;
  game.socket.on(COMBAT_END_SOCKET, handleCombatEndSocketMessage);
  observedCombatEndAuthorityUserId = getResponsibleGM()?.id ?? "";
  if (isResponsibleGM()) {
    if (!requestCombatEndAuthorityRecovery()) {
      scheduleCombatEndAuthorityCanonicalRefresh();
    }
  }
}

function handleCombatDeleted(combat) {
  if (!isResponsibleGM()) return;
  const session = createCombatEndSession(combat);
  if (!session?.entries?.length) return;
  broadcastCombatEndSession(session);
}

function createCombatEndSession(combat) {
  const now = Date.now();
  const combatants = Array.from(combat?.combatants ?? []);
  const participantActorUuids = Array.from(new Set(combatants
    .map(combatant => combatant.actor?.uuid ?? "")
    .filter(Boolean)));
  const livingFactionNames = collectLivingFactionNames(combatants);
  const seenActorUuids = new Set();
  const entries = [];

  for (const combatant of combatants) {
    const actor = combatant.actor;
    if (!actor?.uuid || seenActorUuids.has(actor.uuid)) continue;
    seenActorUuids.add(actor.uuid);

    const status = getDefeatedActorStatus(actor);
    if (!status) continue;

    const factions = getExplicitActorFactions(actor);
    if (factions.some(name => livingFactionNames.has(name))) continue;

    entries.push(createSessionEntry(actor, combatant, status));
  }

  if (!entries.length) return null;
  return {
    id: String(combat?.id ?? foundry.utils.randomID()),
    combatId: combat?.id ?? "",
    sceneId: combat?.scene?.id ?? combat?.sceneId ?? combat?._source?.scene ?? "",
    participantActorUuids,
    entries,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + COMBAT_END_SESSION_REGISTRY_DEFAULTS.sessionTtlMs,
    revision: 0,
    operationPending: false
  };
}

function createSessionEntry(actor, combatant = null, status = getDefeatedActorStatus(actor)) {
  return {
    id: actor.uuid,
    actorUuid: actor.uuid,
    tokenUuid: combatant?.token?.uuid ?? "",
    name: combatant?.name || actor.name || game.i18n.localize("DOCUMENT.Actor"),
    img: combatant?.img || actor.img || "icons/svg/mystery-man.svg",
    status,
    finishing: false,
    finishClaim: null,
    canFinish: status === STATUS_UNCONSCIOUS && Boolean(selectFinishingCriticalLimb(actor))
  };
}

function collectLivingFactionNames(combatants = []) {
  const names = new Set();
  for (const combatant of combatants) {
    const actor = combatant?.actor;
    if (!actor || combatant.defeated || getDefeatedActorStatus(actor)) continue;
    for (const faction of getExplicitActorFactions(actor)) names.add(faction);
  }
  return names;
}

function getExplicitActorFactions(actor) {
  return getActorFactionBelongs(actor).filter(name => name && name !== DEFAULT_FACTION_NAME);
}

function getDefeatedActorStatus(actor) {
  if (actor?.statuses?.has?.(STATUS_DEAD)) return STATUS_DEAD;
  if (actor?.statuses?.has?.(STATUS_UNCONSCIOUS)) return STATUS_UNCONSCIOUS;
  return "";
}

function isActorAvailableForAction(actor, user = game.user) {
  return Boolean(
    actor
    && (user?.isGM || actor.testUserPermission?.(user, "OWNER"))
    && !getDefeatedActorStatus(actor)
  );
}

function resolveCombatEndActionActor(session) {
  const controlled = canvas?.tokens?.controlled ?? [];
  for (const token of controlled) {
    if (isActorAvailableForAction(token?.actor)) return token.actor;
  }

  if (isActorAvailableForAction(game.user?.character)) return game.user.character;

  for (const actorUuid of session?.participantActorUuids ?? []) {
    const actor = resolveActorSync(actorUuid);
    if (isActorAvailableForAction(actor)) return actor;
  }
  return null;
}

function broadcastCombatEndSession(session) {
  if (!isResponsibleGM() || !session?.id) return false;
  session.revision = getNextCombatEndSessionRevision(session);
  session.updatedAt = Date.now();
  renderCombatEndSession(session);
  const snapshot = serializeSession(session);
  game.socket?.emit?.(COMBAT_END_SOCKET, {
    scope: COMBAT_END_SOCKET_SCOPE,
    type: "state",
    authorityUserId: game.user?.id ?? "",
    session: snapshot
  });
  scheduleCombatEndFinishClaimExpiryRefresh();
  return true;
}

function broadcastCombatEndTerminal(sessionId, revision = 0) {
  if (!isResponsibleGM()) return false;
  return broadcastCombatEndSession({
    id: String(sessionId ?? ""),
    entries: [],
    revision: Math.max(0, toInteger(revision)),
    updatedAt: Date.now()
  });
}

function serializeSession(session) {
  return foundry.utils.deepClone(session);
}

function renderCombatEndSession(session, { present = true } = {}) {
  if (!session?.id) return;
  const result = combatEndSessionRegistry.upsert(session);
  applyCombatEndRegistryChanges(result);
  if (!result.stored) return;
  const storedSession = combatEndSessionRegistry.get(session.id);
  if (!storedSession) return;
  presentStoredCombatEndSession(storedSession, { present });
}

function presentStoredCombatEndSession(storedSession, { present = true } = {}) {
  const sessionId = String(storedSession?.id ?? "");
  if (!sessionId) return null;
  let application = renderedApplications.get(sessionId);
  if (application) {
    application.updateSession(storedSession);
    if (!present) return application;
    if (!shouldPresentCombatEndSession(storedSession)) {
      closeCombatEndApplication(sessionId, { dismiss: false, animate: false });
      return null;
    }
    if (application.rendered) application.render({ force: true });
    return application;
  }
  if (
    !present
    || combatEndSessionRegistry.isDismissed(sessionId)
    || !shouldPresentCombatEndSession(storedSession)
  ) return null;

  application = new CombatEndResolutionApplication(storedSession);
  renderedApplications.set(sessionId, application);
  application.render({ force: true });
  return application;
}

function shouldPresentCombatEndSession(session) {
  const sceneId = String(session?.sceneId ?? "");
  const viewedSceneId = String(canvas?.scene?.id ?? game.scenes?.viewed?.id ?? "");
  if (sceneId && viewedSceneId && sceneId !== viewedSceneId) return false;
  if (game.user?.isGM) return true;
  return (session?.participantActorUuids ?? []).some(actorUuid => (
    resolveActorSync(actorUuid)?.testUserPermission?.(game.user, "OWNER")
  ));
}

function reconcileCombatEndApplicationPresentation() {
  pruneCombatEndSessionRegistry();
  for (const sessionId of Array.from(renderedApplications.keys())) {
    if (!combatEndSessionRegistry.has(sessionId)) {
      closeCombatEndApplication(sessionId, { dismiss: false, animate: false });
    }
  }
  for (const session of combatEndSessionRegistry.values()) presentStoredCombatEndSession(session);
}

function closeCombatEndApplication(sessionId, options = {}) {
  const application = renderedApplications.get(sessionId);
  if (!application) return;
  renderedApplications.delete(sessionId);
  void application.close(options);
}

function rerenderCombatEndApplications() {
  for (const sessionId of Array.from(renderedApplications.keys())) {
    if (!combatEndSessionRegistry.has(sessionId)) {
      closeCombatEndApplication(sessionId, { dismiss: false, animate: false });
    }
  }
  for (const session of combatEndSessionRegistry.values()) presentStoredCombatEndSession(session);
}

function pruneCombatEndSessionRegistry() {
  applyCombatEndRegistryChanges(combatEndSessionRegistry.prune());
}

function applyCombatEndRegistryChanges(changes = {}) {
  const removedSessions = Array.isArray(changes.removedSessions) ? changes.removedSessions : [];
  for (const removal of removedSessions) {
    closeCombatEndApplication(removal.id, { dismiss: false, animate: false });
  }
  if (!isResponsibleGM()) return;
  for (const removal of removedSessions) {
    if (!["capacity", "expired"].includes(removal.reason)) continue;
    broadcastCombatEndTerminal(removal.id, removal.revision);
  }
}

function handleCombatEndUserConnected(user) {
  if (!user?.id) return;
  pruneCombatEndSessionRegistry();
  const activeGM = getResponsibleGM();
  const authorityUserId = activeGM?.id ?? "";
  const previousAuthorityUserId = observedCombatEndAuthorityUserId;
  const authorityChanged = authorityUserId !== previousAuthorityUserId;
  observedCombatEndAuthorityUserId = authorityUserId;
  if (!activeGM) {
    clearPendingCombatEndRecovery();
    clearCombatEndFinishClaimExpiryRefresh();
    return;
  }

  if (authorityChanged) {
    if (activeGM.id === game.user?.id) {
      const recoveryStarted = requestCombatEndAuthorityRecovery({
        preferredDonorUserId: previousAuthorityUserId
      });
      if (!recoveryStarted) scheduleCombatEndAuthorityCanonicalRefresh();
    } else {
      clearPendingCombatEndRecovery();
      clearCombatEndFinishClaimExpiryRefresh();
    }
  }
}

function requestCombatEndAuthorityRecovery({ preferredDonorUserId = "" } = {}) {
  if (!isResponsibleGM()) return false;
  clearPendingCombatEndRecovery();
  const donors = getCombatEndRecoveryDonors(preferredDonorUserId);
  if (!donors.length) return false;
  const requestId = foundry.utils.randomID();
  const donorUserIds = donors.map(user => user.id);
  pendingCombatEndRecovery = {
    requestId,
    donorUserIds: new Set(donorUserIds),
    respondedUserIds: new Set()
  };
  combatEndRecoveryTimeout = globalThis.setTimeout(() => {
    finishCombatEndAuthorityRecovery();
  }, COMBAT_END_RECOVERY_TIMEOUT);
  game.socket?.emit?.(COMBAT_END_SOCKET, {
    scope: COMBAT_END_SOCKET_SCOPE,
    type: "syncRequest",
    requestId,
    requesterUserId: game.user?.id ?? "",
    donorUserIds
  });
  return true;
}

function getCombatEndRecoveryDonors(preferredDonorUserId = "") {
  const preferredId = String(preferredDonorUserId ?? "");
  return (game.users?.contents ?? [])
    .filter(user => user?.active && user.isGM && user.id !== game.user?.id)
    .sort((left, right) => (
      Number(right.id === preferredId) - Number(left.id === preferredId)
      || Number(Boolean(right.isGM)) - Number(Boolean(left.isGM))
      || left.id.localeCompare(right.id)
    ))
    .slice(0, COMBAT_END_MAX_RECOVERY_DONORS);
}

function clearPendingCombatEndRecovery() {
  if (combatEndRecoveryTimeout !== null) {
    globalThis.clearTimeout(combatEndRecoveryTimeout);
    combatEndRecoveryTimeout = null;
  }
  pendingCombatEndRecovery = null;
}

function finishCombatEndAuthorityRecovery() {
  if (!pendingCombatEndRecovery) return;
  clearPendingCombatEndRecovery();
  scheduleCombatEndAuthorityCanonicalRefresh();
}

function sendCombatEndSessionSync(recipientUserId = "", requestId = "") {
  const recipient = String(recipientUserId ?? "");
  if (!recipient || recipient === game.user?.id) return;
  pruneCombatEndSessionRegistry();
  const recoverableSessions = Array.from(combatEndSessionRegistry.values())
    .filter(session => (
      session?.operationPending || sessionHasActiveCombatEndFinishClaims(session)
    ));
  game.socket?.emit?.(COMBAT_END_SOCKET, {
    scope: COMBAT_END_SOCKET_SCOPE,
    type: "syncState",
    requestId: String(requestId ?? ""),
    senderUserId: game.user?.id ?? "",
    recipientUserId: recipient,
    sessions: recoverableSessions.map(serializeSession),
    terminals: Array.from(combatEndSessionRegistry.terminalEntries(), ([id, revision]) => ({
      id,
      revision,
      entries: [],
      updatedAt: Date.now()
    }))
  });
}

function scheduleCombatEndAuthorityCanonicalRefresh() {
  if (!isResponsibleGM()) return;
  if (combatEndAuthoritySyncTimeout !== null) {
    globalThis.clearTimeout(combatEndAuthoritySyncTimeout);
  }
  combatEndAuthoritySyncTimeout = globalThis.setTimeout(() => {
    combatEndAuthoritySyncTimeout = null;
    void enqueueCombatEndOperation(refreshAllCombatEndSessionsAsAuthority);
  }, COMBAT_END_AUTHORITY_SYNC_DELAY);
}

async function refreshAllCombatEndSessionsAsAuthority() {
  if (!isResponsibleGM()) return;
  pruneCombatEndSessionRegistry();
  const sessions = Array.from(combatEndSessionRegistry.values());
  for (const session of sessions) {
    if (!isResponsibleGM()) return;
    let hasActiveFinishClaim = false;
    for (const entry of session.entries ?? []) {
      const claim = getActiveCombatEndFinishClaim(entry);
      if (claim) {
        entry.finishing = true;
        entry.canFinish = false;
        hasActiveFinishClaim = true;
      } else {
        clearCombatEndFinishClaim(entry);
      }
      const actor = await resolveActor(entry.actorUuid);
      if (!actor) {
        entry.removed = true;
        continue;
      }
      refreshSessionEntry(entry, actor);
    }
    session.operationPending = hasActiveFinishClaim;
    session.entries = (session.entries ?? []).filter(entry => !entry.removed);
    broadcastCombatEndSession(session);
  }
}

function refreshCombatEndSessionsForActor(actor) {
  if (!isResponsibleGM() || !actor?.uuid) return;
  pruneCombatEndSessionRegistry();
  for (const session of combatEndSessionRegistry.sessionsForActor(actor.uuid)) {
    const entry = session.entries.find(candidate => candidate.actorUuid === actor.uuid);
    if (!entry) continue;
    const changed = refreshSessionEntry(entry, actor);
    if (!changed) continue;
    session.entries = session.entries.filter(candidate => !candidate.removed);
    broadcastCombatEndSession(session);
  }
}

function removeActorFromCombatEndSessions(actor) {
  if (!isResponsibleGM() || !actor?.uuid) return;
  pruneCombatEndSessionRegistry();
  for (const session of combatEndSessionRegistry.sessionsForActor(actor.uuid)) {
    const before = session.entries.length;
    session.entries = session.entries.filter(entry => entry.actorUuid !== actor.uuid);
    if (session.entries.length !== before) broadcastCombatEndSession(session);
  }
}

function refreshSessionEntry(entry, actor) {
  const status = getDefeatedActorStatus(actor);
  if (!status) {
    const changed = !entry.removed;
    entry.removed = true;
    return changed;
  }
  const finishing = Boolean(getActiveCombatEndFinishClaim(entry));
  if (!finishing && entry.finishClaim) clearCombatEndFinishClaim(entry);
  const canFinish = !finishing
    && status === STATUS_UNCONSCIOUS
    && Boolean(selectFinishingCriticalLimb(actor));
  const changed = entry.status !== status
    || entry.canFinish !== canFinish
    || entry.finishing !== finishing;
  entry.removed = false;
  entry.status = status;
  entry.finishing = finishing;
  entry.canFinish = canFinish;
  return changed;
}

async function requestCombatEndFinish(payload = {}) {
  const gm = getResponsibleGM();
  if (!gm) throw new Error("Нет активного GM для добивания.");
  const request = {
    ...payload,
    requesterUserId: game.user?.id ?? ""
  };

  if (game.user?.isGM && gm.id === game.user.id) {
    return enqueuePinnedCombatEndFinish(request);
  }

  return gm.query(
    COMBAT_END_FINISH_QUERY,
    payload,
    { timeout: COMBAT_END_FINISH_QUERY_TIMEOUT }
  );
}

async function runCombatEndFinish(payload = {}) {
  try {
    const result = await requestCombatEndFinish(payload);
    if (!result?.ok && result?.message) ui.notifications.warn(result.message);
    return result;
  } catch (error) {
    ui.notifications.error(error.message || "Добивание не выполнено.");
    return { ok: false, message: error.message };
  }
}

async function requestCombatEndComplete(sessionId = "") {
  const gm = getResponsibleGM();
  if (!gm) throw new Error("Нет активного GM для завершения послебоевой сессии.");
  if (gm.id === game.user?.id) return completeCombatEndSessionAsAuthority(sessionId);
  return gm.query(
    COMBAT_END_COMPLETE_QUERY,
    { sessionId: String(sessionId ?? "") },
    { timeout: COMBAT_END_FINISH_QUERY_TIMEOUT }
  );
}

function completeCombatEndSessionAsAuthority(sessionId = "") {
  if (!isResponsibleGM()) throw new Error("Combat-end authority changed.");
  const id = String(sessionId ?? "");
  expireCombatEndFinishClaimsAsAuthority();
  const session = combatEndSessionRegistry.get(id);
  if (!session) return { ok: true, alreadyComplete: true };
  if (sessionHasActiveCombatEndFinishClaims(session)) {
    return {
      ok: false,
      message: "Дождитесь завершения выполняемого послебоевого действия."
    };
  }
  session.operationPending = false;
  broadcastCombatEndTerminal(id, session.revision);
  return { ok: true };
}

async function handleCombatEndSocketMessage(message = {}, socketSenderUserId = "") {
  if (message.scope !== COMBAT_END_SOCKET_SCOPE) return;
  const senderUserId = String(socketSenderUserId ?? "");
  if (!senderUserId) return;

  if (message.type === "state") {
    if (
      message.authorityUserId !== senderUserId
      || !isCurrentCombatEndAuthority(senderUserId)
    ) return;
    renderCombatEndSession(message.session);
    return;
  }

  if (message.type === "syncRequest") {
    if (
      message.requesterUserId !== senderUserId
      || !isCurrentCombatEndAuthority(senderUserId)
      || !Array.isArray(message.donorUserIds)
      || !message.donorUserIds.includes(game.user?.id)
    ) return;
    sendCombatEndSessionSync(message.requesterUserId, message.requestId);
    return;
  }

  if (message.type === "syncState") {
    const recovery = pendingCombatEndRecovery;
    if (
      !isResponsibleGM()
      || message.recipientUserId !== game.user?.id
      || message.senderUserId !== senderUserId
      || recovery?.requestId !== message.requestId
      || !recovery?.donorUserIds?.has(senderUserId)
      || recovery.respondedUserIds.has(senderUserId)
    ) return;
    for (const session of message.sessions ?? []) {
      renderCombatEndSession(session, { present: false });
    }
    for (const terminal of message.terminals ?? []) {
      renderCombatEndSession(terminal, { present: false });
    }
    recovery.respondedUserIds.add(senderUserId);
    if (recovery.respondedUserIds.size >= recovery.donorUserIds.size) {
      finishCombatEndAuthorityRecovery();
    }
    return;
  }

}

async function handleCombatEndFinishQuery(payload = {}, { user: requester } = {}) {
  if (!isResponsibleGM()) throw new Error("Combat-end authority changed.");
  if (!requester?.id || game.users?.get?.(requester.id) !== requester) {
    throw new Error("Combat-end requester is not an authenticated world user.");
  }
  return enqueuePinnedCombatEndFinish({
    sessionId: String(payload?.sessionId ?? ""),
    actorUuid: String(payload?.actorUuid ?? ""),
    attackerActorUuid: String(payload?.attackerActorUuid ?? ""),
    requesterUserId: requester.id
  });
}

async function handleCombatEndCompleteQuery(payload = {}, { user: requester } = {}) {
  if (!isResponsibleGM()) throw new Error("Combat-end authority changed.");
  if (!requester?.id || game.users?.get?.(requester.id) !== requester) {
    throw new Error("Combat-end requester is not an authenticated world user.");
  }
  const sessionId = String(payload?.sessionId ?? "");
  const session = combatEndSessionRegistry.get(sessionId);
  if (session && !requester.isGM && !(session.participantActorUuids ?? []).some(actorUuid => (
    resolveActorSync(actorUuid)?.testUserPermission?.(requester, "OWNER")
  ))) {
    throw new Error("The requester may not complete this combat-end session.");
  }
  return completeCombatEndSessionAsAuthority(sessionId);
}

function enqueueCombatEndOperation(operation) {
  const next = combatEndOperationQueue.then(operation);
  combatEndOperationQueue = next.catch(error => {
    console.error(`${SYSTEM_ID} | Combat end operation failed`, error);
  });
  return next;
}

function enqueuePinnedCombatEndFinish(payload = {}) {
  const sessionId = String(payload?.sessionId ?? "");
  const actorUuid = String(payload?.actorUuid ?? "");
  const operationKey = getCombatEndFinishOperationKey(sessionId, actorUuid);
  const pending = pendingFinishOperations.get(operationKey);
  if (pending) return pending;
  if (pendingFinishOperations.size >= COMBAT_END_MAX_PENDING_FINISHES) {
    return Promise.resolve({
      ok: false,
      message: "Слишком много операций завершения боя. Дождитесь их окончания и повторите действие."
    });
  }

  const session = combatEndSessionRegistry.get(sessionId);
  const entry = session?.entries?.find(candidate => candidate.actorUuid === actorUuid);
  const authorityUserId = getResponsibleGM()?.id ?? "";
  if (!session || !entry || !isCombatEndAuthority(authorityUserId)) {
    return Promise.resolve({
      ok: false,
      message: "Сессия завершения боя недоступна."
    });
  }

  const activeClaim = getActiveCombatEndFinishClaim(entry);
  if (activeClaim) {
    return Promise.resolve({
      ok: false,
      message: "Эту цель уже добивают."
    });
  }
  clearCombatEndFinishClaim(entry);
  if (!combatEndSessionRegistry.pin(sessionId)) {
    return Promise.resolve({
      ok: false,
      message: "Сессия завершения боя недоступна."
    });
  }

  const operationId = foundry.utils.randomID();
  setCombatEndFinishClaim(entry, {
    operationId,
    authorityUserId,
    requesterUserId: payload?.requesterUserId
  });
  session.operationPending = true;
  broadcastCombatEndSession(session);

  const operation = enqueueCombatEndOperation(async () => {
    if (!isCombatEndAuthority(authorityUserId)) {
      return {
        ok: false,
        message: "Активный GM изменился. Повторите действие."
      };
    }
    const currentSession = combatEndSessionRegistry.get(sessionId);
    const currentEntry = currentSession?.entries?.find(candidate => candidate.actorUuid === actorUuid);
    if (!currentEntry
      || !isMatchingCombatEndFinishClaim(currentEntry, operationId, authorityUserId)) {
      return {
        ok: false,
        message: "Операция завершения боя устарела."
      };
    }
    setCombatEndFinishClaim(currentEntry, {
      operationId,
      authorityUserId,
      requesterUserId: payload?.requesterUserId
    });
    broadcastCombatEndSession(currentSession);
    return handleCombatEndFinish({
      ...payload,
      sessionId,
      actorUuid,
      operationId,
      authorityUserId
    });
  }).finally(() => {
    const release = combatEndSessionRegistry.unpin(sessionId);
    applyCombatEndRegistryChanges(release);
    const current = combatEndSessionRegistry.get(sessionId);
    if (!current) return;
    const currentEntry = current.entries?.find(candidate => candidate.actorUuid === actorUuid);
    if (isCombatEndAuthority(authorityUserId)
      && isMatchingCombatEndFinishClaim(currentEntry, operationId, authorityUserId)) {
      clearCombatEndFinishClaim(currentEntry);
    }
    current.operationPending = release.pinCount > 0 || sessionHasActiveCombatEndFinishClaims(current);
    if (!current.operationPending) pruneCombatEndSessionRegistry();
    const releasedSession = combatEndSessionRegistry.get(sessionId);
    if (!releasedSession) return;
    if (!isCombatEndAuthority(authorityUserId)) return;
    broadcastCombatEndSession(releasedSession);
  });
  pendingFinishOperations.set(operationKey, operation);
  void operation.finally(() => {
    if (pendingFinishOperations.get(operationKey) === operation) {
      pendingFinishOperations.delete(operationKey);
    }
  }).catch(() => {});
  return operation;
}

async function handleCombatEndFinish({
  sessionId = "",
  actorUuid = "",
  attackerActorUuid = "",
  requesterUserId = "",
  operationId = "",
  authorityUserId = ""
} = {}) {
  const session = combatEndSessionRegistry.get(sessionId);
  if (!session) return { ok: false, message: "Сессия завершения боя недоступна." };

  const entry = session.entries.find(candidate => candidate.actorUuid === actorUuid);
  if (!entry) return { ok: false, message: "Цель больше недоступна." };
  if (!isMatchingCombatEndFinishClaim(entry, operationId, authorityUserId)) {
    return { ok: false, message: "Эту цель уже добивают." };
  }

  const targetActor = await resolveActor(actorUuid);
  if (!targetActor) {
    session.entries = session.entries.filter(candidate => candidate.actorUuid !== actorUuid);
    broadcastCombatEndSession(session);
    return { ok: false, message: "Цель больше не существует." };
  }

  const status = getDefeatedActorStatus(targetActor);
  if (status === STATUS_DEAD) {
    refreshSessionEntry(entry, targetActor);
    broadcastCombatEndSession(session);
    return { ok: true };
  }
  if (status !== STATUS_UNCONSCIOUS) {
    session.entries = session.entries.filter(candidate => candidate.actorUuid !== actorUuid);
    broadcastCombatEndSession(session);
    return { ok: false, message: "Цель уже не без сознания." };
  }

  const attacker = await resolveActor(attackerActorUuid);
  validateRequesterActionActor(attacker, requesterUserId);

  const limb = selectFinishingCriticalLimb(targetActor);
  if (!limb) {
    refreshSessionEntry(entry, targetActor);
    broadcastCombatEndSession(session);
    return { ok: false, message: "У цели нет доступной критической части для добивания." };
  }

  entry.finishing = true;
  entry.canFinish = false;
  broadcastCombatEndSession(session);

  try {
    if (!isCombatEndAuthority(authorityUserId)) {
      return {
        ok: false,
        message: "Активный GM изменился. Повторите действие."
      };
    }
    await applyDamageApplication({
      actor: targetActor,
      limbKey: limb.limbKey,
      amount: limb.amount,
      damageTypeKey: "",
      mode: "damage",
      scope: "limb",
      applyMitigation: false,
      processDamageTypeSettings: false,
      bypassBarrier: true,
      source: {
        attackerUuid: attacker.uuid,
        combatEndResolution: true,
        combatEndOperationId: operationId,
        requesterUserId
      }
    });

    const freshTarget = await resolveActor(actorUuid);
    if (!freshTarget) {
      session.entries = session.entries.filter(candidate => candidate.actorUuid !== actorUuid);
      return { ok: false, message: "Цель больше не существует." };
    }

    refreshSessionEntry(entry, freshTarget);
    if (entry.status !== STATUS_DEAD) {
      return { ok: false, message: "Добивание не перевело цель в состояние смерти." };
    }
    return { ok: true };
  } finally {
    if (isMatchingCombatEndFinishClaim(entry, operationId, authorityUserId)
      && isCombatEndAuthority(authorityUserId)) {
      entry.finishing = false;
    }
    const currentActor = await resolveActor(actorUuid);
    if (currentActor) refreshSessionEntry(entry, currentActor);
    session.entries = session.entries.filter(candidate => !candidate.removed);
    broadcastCombatEndSession(session);
  }
}

function getCombatEndFinishOperationKey(sessionId, actorUuid) {
  return `${String(sessionId ?? "")}\u0000${String(actorUuid ?? "")}`;
}

function setCombatEndFinishClaim(entry, {
  operationId = "",
  authorityUserId = "",
  requesterUserId = ""
} = {}) {
  if (!entry) return null;
  const claimedAt = Date.now();
  entry.finishClaim = {
    operationId: String(operationId),
    authorityUserId: String(authorityUserId),
    requesterUserId: String(requesterUserId ?? ""),
    claimedAt,
    expiresAt: claimedAt + COMBAT_END_FINISH_CLAIM_TTL
  };
  entry.finishing = true;
  entry.canFinish = false;
  return entry.finishClaim;
}

function getActiveCombatEndFinishClaim(entry, at = Date.now()) {
  const claim = entry?.finishClaim;
  if (!claim?.operationId || !claim?.authorityUserId) return null;
  const expiresAt = Number(claim.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > at ? claim : null;
}

function clearCombatEndFinishClaim(entry) {
  if (!entry) return;
  entry.finishClaim = null;
  entry.finishing = false;
}

function isMatchingCombatEndFinishClaim(entry, operationId, authorityUserId) {
  const claim = getActiveCombatEndFinishClaim(entry);
  return Boolean(
    claim
    && claim.operationId === String(operationId ?? "")
    && claim.authorityUserId === String(authorityUserId ?? "")
  );
}

function sessionHasActiveCombatEndFinishClaims(session, at = Date.now()) {
  return (session?.entries ?? []).some(entry => Boolean(getActiveCombatEndFinishClaim(entry, at)));
}

function scheduleCombatEndFinishClaimExpiryRefresh() {
  clearCombatEndFinishClaimExpiryRefresh();
  if (!isResponsibleGM()) return;
  const now = Date.now();
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const session of combatEndSessionRegistry.values()) {
    for (const entry of session?.entries ?? []) {
      const expiresAt = Number(entry?.finishClaim?.expiresAt);
      if (Number.isFinite(expiresAt)) nextExpiry = Math.min(nextExpiry, expiresAt);
    }
  }
  if (!Number.isFinite(nextExpiry)) return;
  combatEndFinishClaimExpiryTimeout = globalThis.setTimeout(() => {
    combatEndFinishClaimExpiryTimeout = null;
    expireCombatEndFinishClaimsAsAuthority();
  }, Math.max(0, nextExpiry - now + 1));
}

function clearCombatEndFinishClaimExpiryRefresh() {
  if (combatEndFinishClaimExpiryTimeout === null) return;
  globalThis.clearTimeout(combatEndFinishClaimExpiryTimeout);
  combatEndFinishClaimExpiryTimeout = null;
}

function expireCombatEndFinishClaimsAsAuthority(at = Date.now()) {
  if (!isResponsibleGM()) {
    clearCombatEndFinishClaimExpiryRefresh();
    return;
  }
  const changedSessions = [];
  for (const session of combatEndSessionRegistry.values()) {
    let changed = false;
    for (const entry of session?.entries ?? []) {
      if (!entry?.finishClaim || getActiveCombatEndFinishClaim(entry, at)) continue;
      clearCombatEndFinishClaim(entry);
      changed = true;
    }
    const operationPending = sessionHasActiveCombatEndFinishClaims(session, at);
    if (session.operationPending !== operationPending) {
      session.operationPending = operationPending;
      changed = true;
    }
    if (changed) changedSessions.push(session);
  }
  for (const session of changedSessions) broadcastCombatEndSession(session);
  scheduleCombatEndFinishClaimExpiryRefresh();
}

function isCombatEndAuthority(authorityUserId = "") {
  return Boolean(
    isResponsibleGM()
    && game.user?.id
    && game.user.id === String(authorityUserId ?? "")
    && getResponsibleGM()?.id === game.user.id
  );
}

function validateRequesterActionActor(actor, requesterUserId = "") {
  const requester = game.users?.get?.(requesterUserId);
  if (!actor) throw new Error("Не найден актер, выполняющий действие.");
  if (!requester?.isGM && !actor.testUserPermission?.(requester, "OWNER")) {
    throw new Error("Нет прав владельца на актера, выполняющего действие.");
  }
  if (getDefeatedActorStatus(actor)) throw new Error("Повергнутый актер не может добивать цель.");
}

function selectFinishingCriticalLimb(actor) {
  return Object.entries(actor?.system?.limbs ?? {})
    .filter(([limbKey]) => isCriticalLimb(actor, limbKey) && !isLimbDestroyed(actor, limbKey))
    .map(([limbKey, limb]) => {
      const max = Math.max(1, toInteger(limb?.max));
      const min = toInteger(limb?.min ?? -max);
      const value = getLimbValue(actor, limbKey, limb);
      return {
        limbKey,
        value,
        max,
        amount: Math.max(1, value - min)
      };
    })
    .filter(limb => limb.amount > 0)
    .sort((left, right) => (left.value / left.max) - (right.value / right.max))
    .at(0) ?? null;
}

function getLimbValue(actor, limbKey, limb) {
  const max = Math.max(0, toInteger(limb?.max));
  const min = toInteger(limb?.min ?? -max);
  const cap = Math.max(min, getLimbEffectiveMaximum(actor, limbKey));
  return Math.min(Math.max(toInteger(limb?.value), min), cap);
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function isResponsibleGM() {
  return Boolean(game.user?.isActiveGM || (
    game.user?.isGM && getResponsibleGM()?.id === game.user.id
  ));
}

function isCurrentCombatEndAuthority(userId = "") {
  const authorityId = getResponsibleGM()?.id ?? "";
  return Boolean(authorityId && authorityId === String(userId ?? ""));
}

function getNextCombatEndSessionRevision(session) {
  const revision = Number(session?.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision + 1 : 1;
}

async function resolveActor(actorUuid = "") {
  const uuid = String(actorUuid ?? "").trim();
  if (!uuid) return null;
  return resolveActorSync(uuid) ?? await fromUuid(uuid);
}

function resolveActorSync(actorUuid = "") {
  const uuid = String(actorUuid ?? "").trim();
  if (!uuid || typeof fromUuidSync !== "function") return null;
  const document = fromUuidSync(uuid);
  return document?.documentName === "Actor" ? document : null;
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

class CombatEndResolutionApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #session;
  #pendingFinishes = new Set();
  #completionPending = false;
  #positionFrame = null;
  #closePromise = null;
  #closing = false;
  #resizeHandler = () => this.#queuePosition();

  constructor(session, options = {}) {
    super({
      ...options,
      id: `fallout-maw-combat-end-resolution-${session.id}`
    });
    this.#session = session;
  }

  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-combat-end-resolution"],
    position: {
      width: 244,
      height: "auto"
    },
    window: {
      resizable: false,
      contentClasses: ["standard-form"]
    },
    actions: {
      search: this.#onSearch,
      finish: this.#onFinish,
      dismiss: this.#onDismiss
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.combatEndResolution
    }
  };

  get title() {
    return "Завершение боя";
  }

  get session() {
    return this.#session;
  }

  updateSession(session) {
    this.#session = session;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actionActor = resolveCombatEndActionActor(this.#session);
    const icons = getTokenActionHudIcons().combatEnd ?? {};
    return {
      ...context,
      actionActorName: actionActor?.name ?? "",
      actionIcons: {
        search: icons.search || "icons/svg/item-bag.svg",
        finish: icons.finish || "icons/svg/skull.svg"
      },
      completionPending: this.#completionPending,
      entries: (this.#session.entries ?? []).map(entry => this.#prepareEntryContext(entry, actionActor))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.removeEventListener("resize", this.#resizeHandler);
    view.addEventListener("resize", this.#resizeHandler);
    this.#queuePosition();
  }

  close(options = {}) {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closing) return Promise.resolve();
    this.#closing = true;
    let completedByAuthority = false;
    if (options.dismiss !== false && this.#session?.id && isResponsibleGM()) {
      try {
        completedByAuthority = Boolean(
          completeCombatEndSessionAsAuthority(this.#session.id)?.ok
        );
      } catch {
        completedByAuthority = false;
      }
    }
    if (options.dismiss !== false && !completedByAuthority && this.#session?.id) {
      const changes = combatEndSessionRegistry.dismiss(this.#session.id);
      applyCombatEndRegistryChanges(changes);
    }
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.removeEventListener("resize", this.#resizeHandler);
    if (this.#positionFrame) {
      this.#positionFrame.view.cancelAnimationFrame?.(this.#positionFrame.id);
      this.#positionFrame = null;
    }
    renderedApplications.delete(this.#session?.id);
    this.#closePromise = Promise.resolve(super.close(options));
    return this.#closePromise;
  }

  #prepareEntryContext(entry, actionActor) {
    const missingActor = !resolveActorSync(entry.actorUuid);
    const hasActionActor = Boolean(actionActor);
    const pendingFinish = this.#pendingFinishes.has(entry.actorUuid) || entry.finishing;
    const showFinish = entry.status === STATUS_UNCONSCIOUS;
    const finishDisabled = missingActor || !hasActionActor || pendingFinish || !entry.canFinish;
    const finishTitle = missingActor
      ? "Цель недоступна"
      : !hasActionActor
        ? "Нет доступного актера для действия"
        : pendingFinish
          ? "Добивание выполняется"
          : !entry.canFinish
            ? "Нет доступной критической части"
            : "Добить";
    return {
      ...entry,
      searchDisabled: missingActor || !hasActionActor,
      searchTitle: missingActor
        ? "Цель недоступна"
        : hasActionActor
          ? `Обыскать${actionActor?.name ? `: ${actionActor.name}` : ""}`
          : "Нет доступного актера для обыска",
      showFinish,
      finishDisabled,
      finishTitle,
      pendingFinish
    };
  }

  static async #onSearch(event, target) {
    event.preventDefault();
    const entry = this.#getEntryFromTarget(target);
    if (!entry) return;
    const searcherActor = resolveCombatEndActionActor(this.#session);
    if (!searcherActor) {
      ui.notifications.warn("Нет доступного актера для обыска.");
      return;
    }
    const searchedActor = await resolveActor(entry.actorUuid);
    if (!searchedActor) {
      ui.notifications.warn("Цель обыска недоступна.");
      return;
    }
    await openSearchInventoryWindow({ searcherActor, searchedActor });
  }

  static async #onFinish(event, target) {
    event.preventDefault();
    const entry = this.#getEntryFromTarget(target);
    if (!entry) return;
    const attackerActor = resolveCombatEndActionActor(this.#session);
    if (!attackerActor) {
      ui.notifications.warn("Нет доступного актера для добивания.");
      return;
    }

    this.#pendingFinishes.add(entry.actorUuid);
    this.render({ force: true });
    try {
      await runCombatEndFinish({
        sessionId: this.#session.id,
        actorUuid: entry.actorUuid,
        attackerActorUuid: attackerActor.uuid
      });
    } finally {
      this.#pendingFinishes.delete(entry.actorUuid);
      if (this.rendered) this.render({ force: true });
    }
  }

  static async #onDismiss(event, target) {
    event.preventDefault();
    if (this.#completionPending) return;
    this.#completionPending = true;
    if (target) target.disabled = true;
    try {
      const result = await requestCombatEndComplete(this.#session?.id);
      if (!result?.ok) {
        if (result?.message) ui.notifications.warn(result.message);
        return;
      }
      await this.close({ dismiss: false });
    } catch (error) {
      ui.notifications.error(error?.message || "Не удалось завершить послебоевую сессию.");
    } finally {
      this.#completionPending = false;
      if (target?.isConnected) target.disabled = false;
    }
  }

  #getEntryFromTarget(target) {
    const row = target?.closest?.("[data-combat-end-entry-id]");
    const entryId = row?.dataset.combatEndEntryId ?? "";
    return this.#session.entries?.find(entry => entry.id === entryId || entry.actorUuid === entryId) ?? null;
  }

  #queuePosition() {
    if (this.#positionFrame) return;
    const view = this.element?.ownerDocument?.defaultView ?? window;
    if (typeof view.requestAnimationFrame !== "function") {
      this.#positionNearSidebar();
      return;
    }
    const id = view.requestAnimationFrame(() => {
      this.#positionFrame = null;
      this.#positionNearSidebar();
    });
    this.#positionFrame = { view, id };
  }

  #positionNearSidebar() {
    const element = this.element;
    if (!element?.isConnected) return;
    const document = element.ownerDocument;
    const view = document.defaultView ?? window;
    const viewportWidth = Math.max(
      0,
      Number(view.visualViewport?.width) || 0,
      Number(view.innerWidth) || 0,
      Number(document.documentElement?.clientWidth) || 0
    );
    const sidebar = document.querySelector("#sidebar");
    const sidebarRect = sidebar?.getBoundingClientRect();
    const rightBoundary = sidebarRect?.width > 0 && sidebarRect.left > (viewportWidth * 0.45)
      ? sidebarRect.left
      : viewportWidth;
    const width = element.getBoundingClientRect().width
      || Number(this.position?.width)
      || Number(this.options?.position?.width)
      || 244;
    this.setPosition({
      left: Math.max(WINDOW_MARGIN, Math.round(rightBoundary - width - WINDOW_MARGIN)),
      top: WINDOW_TOP
    });
  }
}
