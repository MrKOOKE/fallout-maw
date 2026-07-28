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
import { createCombatEndSessionRegistry } from "./combat-end-session-registry.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const COMBAT_END_SOCKET = `system.${SYSTEM_ID}`;
const COMBAT_END_SOCKET_SCOPE = "fallout-maw.combatEndResolution";
const COMBAT_END_FINISH_QUERY = `${SYSTEM_ID}.combatEndFinish`;
const COMBAT_END_FINISH_QUERY_TIMEOUT = 60 * 1000;
const COMBAT_END_FINISH_CLAIM_TTL = 60 * 1000;
const COMBAT_END_MAX_PENDING_FINISHES = 128;
const COMBAT_END_REGISTRY_PRUNE_INTERVAL = 60 * 1000;
const COMBAT_END_AUTHORITY_SYNC_DELAY = 100;

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
let observedCombatEndAuthorityUserId = "";

export function registerCombatEndResolutionHooks() {
  CONFIG.queries ??= {};
  CONFIG.queries[COMBAT_END_FINISH_QUERY] = handleCombatEndFinishQuery;
  Hooks.on(COMBAT_DELETION_SETTLED_HOOK, handleCombatDeleted);
  Hooks.on("updateActor", actor => refreshCombatEndSessionsForActor(actor));
  Hooks.on("deleteActor", actor => removeActorFromCombatEndSessions(actor));
  Hooks.on("controlToken", () => {
    pruneCombatEndSessionRegistry();
    rerenderCombatEndApplications();
  });
  Hooks.on("userConnected", handleCombatEndUserConnected);
  if (combatEndRegistryPruneInterval === null) {
    combatEndRegistryPruneInterval = globalThis.setInterval(
      pruneCombatEndSessionRegistry,
      COMBAT_END_REGISTRY_PRUNE_INTERVAL
    );
  }
}

export function registerCombatEndResolutionSocket() {
  game.socket.on(COMBAT_END_SOCKET, handleCombatEndSocketMessage);
  observedCombatEndAuthorityUserId = getResponsibleGM()?.id ?? "";
  if (isResponsibleGM()) {
    game.socket.emit(COMBAT_END_SOCKET, {
      scope: COMBAT_END_SOCKET_SCOPE,
      type: "syncRequest",
      requesterUserId: game.user?.id ?? ""
    });
    scheduleCombatEndAuthorityCanonicalRefresh();
  }
}

function handleCombatDeleted(combat) {
  if (!isResponsibleGM()) return;
  const session = createCombatEndSession(combat);
  if (!session?.entries?.length) return;
  broadcastCombatEndSession(session);
}

function createCombatEndSession(combat) {
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
    id: `${combat?.id ?? "combat"}-${foundry.utils.randomID()}`,
    combatId: combat?.id ?? "",
    participantActorUuids,
    entries,
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

function renderCombatEndSession(session) {
  if (!session?.id) return;
  const result = combatEndSessionRegistry.upsert(session);
  applyCombatEndRegistryChanges(result);
  if (!result.accepted || !result.stored) return;
  const storedSession = combatEndSessionRegistry.get(session.id);
  if (!storedSession || combatEndSessionRegistry.isDismissed(session.id)) return;

  let application = renderedApplications.get(session.id);
  if (!application) {
    application = new CombatEndResolutionApplication(storedSession);
    renderedApplications.set(session.id, application);
  } else {
    application.updateSession(storedSession);
  }
  application.render({ force: true });
}

function closeCombatEndApplication(sessionId, options = {}) {
  const application = renderedApplications.get(sessionId);
  if (!application) return;
  void application.close(options);
}

function rerenderCombatEndApplications() {
  for (const application of renderedApplications.values()) {
    if (application.rendered) application.render({ force: true });
  }
}

function pruneCombatEndSessionRegistry() {
  applyCombatEndRegistryChanges(combatEndSessionRegistry.prune());
}

function applyCombatEndRegistryChanges(changes = {}) {
  const removedSessions = Array.isArray(changes.removedSessions) ? changes.removedSessions : [];
  for (const removal of removedSessions) {
    closeCombatEndApplication(removal.id, { dismiss: false });
  }
  if (!isResponsibleGM()) return;
  for (const removal of removedSessions) {
    if (!["capacity", "expired"].includes(removal.reason)) continue;
    broadcastCombatEndTerminal(removal.id, removal.revision);
  }
}

function handleCombatEndUserConnected(user, connected) {
  if (!user?.id) return;
  pruneCombatEndSessionRegistry();
  const activeGM = getResponsibleGM();
  const authorityUserId = activeGM?.id ?? "";
  const authorityChanged = authorityUserId !== observedCombatEndAuthorityUserId;
  observedCombatEndAuthorityUserId = authorityUserId;
  if (!activeGM) return;

  if (authorityChanged) {
    if (activeGM.id === game.user?.id) {
      game.socket.emit(COMBAT_END_SOCKET, {
        scope: COMBAT_END_SOCKET_SCOPE,
        type: "syncRequest",
        requesterUserId: game.user.id
      });
      scheduleCombatEndAuthorityCanonicalRefresh();
    }
    return;
  }

  // An ordinary player joining only needs one snapshot from the authority.
  // Unrelated disconnects must not make every client exchange the entire
  // registry or cause the authority to rescan every actor.
  if (connected && activeGM.id === game.user?.id && user.id !== game.user.id) {
    sendCombatEndSessionSync(user.id);
  }
}

function sendCombatEndSessionSync(recipientUserId = "") {
  const recipient = String(recipientUserId ?? "");
  if (!recipient || recipient === game.user?.id) return;
  pruneCombatEndSessionRegistry();
  game.socket?.emit?.(COMBAT_END_SOCKET, {
    scope: COMBAT_END_SOCKET_SCOPE,
    type: "syncState",
    senderUserId: game.user?.id ?? "",
    recipientUserId: recipient,
    sessions: Array.from(combatEndSessionRegistry.values(), serializeSession),
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

async function handleCombatEndSocketMessage(message = {}) {
  if (message.scope !== COMBAT_END_SOCKET_SCOPE) return;

  if (message.type === "state") {
    if (!isCurrentCombatEndAuthority(message.authorityUserId)) return;
    renderCombatEndSession(message.session);
    return;
  }

  if (message.type === "syncRequest") {
    if (!isCurrentCombatEndAuthority(message.requesterUserId)) return;
    sendCombatEndSessionSync(message.requesterUserId);
    return;
  }

  if (message.type === "syncState") {
    if (message.recipientUserId !== game.user?.id) return;
    const sentByAuthority = isCurrentCombatEndAuthority(message.senderUserId);
    if (!sentByAuthority && !isResponsibleGM()) return;
    for (const session of message.sessions ?? []) renderCombatEndSession(session);
    for (const terminal of message.terminals ?? []) renderCombatEndSession(terminal);
    if (isResponsibleGM()) scheduleCombatEndAuthorityCanonicalRefresh();
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

function sessionHasActiveCombatEndFinishClaims(session) {
  return (session?.entries ?? []).some(entry => Boolean(getActiveCombatEndFinishClaim(entry)));
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

  async close(options = {}) {
    if (options.dismiss !== false && this.#session?.id) {
      const changes = combatEndSessionRegistry.dismiss(this.#session.id);
      applyCombatEndRegistryChanges(changes);
    }
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.removeEventListener("resize", this.#resizeHandler);
    renderedApplications.delete(this.#session?.id);
    return super.close(options);
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

  static async #onDismiss(event) {
    event.preventDefault();
    await this.close();
  }

  #getEntryFromTarget(target) {
    const row = target?.closest?.("[data-combat-end-entry-id]");
    const entryId = row?.dataset.combatEndEntryId ?? "";
    return this.#session.entries?.find(entry => entry.id === entryId || entry.actorUuid === entryId) ?? null;
  }

  #queuePosition() {
    const view = this.element?.ownerDocument?.defaultView ?? window;
    view.requestAnimationFrame?.(() => this.#positionNearSidebar()) ?? this.#positionNearSidebar();
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
