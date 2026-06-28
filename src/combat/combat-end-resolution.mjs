import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import {
  applyDamageApplication,
  getLimbEffectiveMaximum,
  isCriticalLimb,
  isLimbDestroyed
} from "./damage-hub.mjs";
import { openSearchInventoryWindow } from "../apps/search-inventory.mjs";
import { getTokenActionHudIcons } from "../settings/accessors.mjs";
import { DEFAULT_FACTION_NAME, getActorFactionBelongs } from "../settings/factions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const COMBAT_END_SOCKET = `system.${SYSTEM_ID}`;
const COMBAT_END_SOCKET_SCOPE = "fallout-maw.combatEndResolution";
const COMBAT_END_SOCKET_TIMEOUT = 10000;

const STATUS_DEAD = "dead";
const STATUS_UNCONSCIOUS = "unconscious";
const WINDOW_MARGIN = 12;
const WINDOW_TOP = 16;

const activeSessions = new Map();
const renderedApplications = new Map();
const dismissedSessionIds = new Set();
const pendingSocketRequests = new Map();
let combatEndOperationQueue = Promise.resolve();

export function registerCombatEndResolutionHooks() {
  Hooks.on("deleteCombat", handleCombatDeleted);
  Hooks.on("updateActor", actor => refreshCombatEndSessionsForActor(actor));
  Hooks.on("deleteActor", actor => removeActorFromCombatEndSessions(actor));
  Hooks.on("controlToken", () => rerenderCombatEndApplications());
}

export function registerCombatEndResolutionSocket() {
  game.socket.on(COMBAT_END_SOCKET, handleCombatEndSocketMessage);
}

function handleCombatDeleted(combat) {
  if (!isResponsibleGM()) return;
  const session = createCombatEndSession(combat);
  if (!session?.entries?.length) return;
  activeSessions.set(session.id, session);
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
    createdAt: Date.now()
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
  const snapshot = serializeSession(session);
  renderCombatEndSession(snapshot);
  game.socket?.emit?.(COMBAT_END_SOCKET, {
    scope: COMBAT_END_SOCKET_SCOPE,
    type: "state",
    session: snapshot
  });
}

function serializeSession(session) {
  return foundry.utils.deepClone(session);
}

function renderCombatEndSession(session) {
  if (!session?.id) return;
  activeSessions.set(session.id, session);
  if (dismissedSessionIds.has(session.id)) return;

  if (!session.entries?.length) {
    closeCombatEndApplication(session.id, { dismiss: false });
    return;
  }

  let application = renderedApplications.get(session.id);
  if (!application) {
    application = new CombatEndResolutionApplication(session);
    renderedApplications.set(session.id, application);
  } else {
    application.updateSession(session);
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

function refreshCombatEndSessionsForActor(actor) {
  if (!isResponsibleGM() || !actor?.uuid) return;
  for (const session of activeSessions.values()) {
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
  for (const session of activeSessions.values()) {
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
  const canFinish = status === STATUS_UNCONSCIOUS && Boolean(selectFinishingCriticalLimb(actor));
  const changed = entry.status !== status || entry.canFinish !== canFinish || entry.finishing;
  entry.removed = false;
  entry.status = status;
  entry.canFinish = canFinish;
  if (status !== STATUS_UNCONSCIOUS) entry.finishing = false;
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
    return enqueueCombatEndOperation(() => handleCombatEndFinish(request));
  }

  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingSocketRequests.delete(requestId);
      reject(new Error("GM не ответил на запрос добивания."));
    }, COMBAT_END_SOCKET_TIMEOUT);
    pendingSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(COMBAT_END_SOCKET, {
    scope: COMBAT_END_SOCKET_SCOPE,
    type: "finishRequest",
    requestId,
    gmUserId: gm.id,
    requesterUserId: request.requesterUserId,
    payload: request
  });
  return promise;
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
    renderCombatEndSession(message.session);
    return;
  }

  if (message.type === "finishResponse") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Combat end request failed."));
    return;
  }

  if (message.type !== "finishRequest") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    const result = await enqueueCombatEndOperation(() => handleCombatEndFinish({
      ...(message.payload ?? {}),
      requesterUserId: message.requesterUserId ?? ""
    }));
    game.socket.emit(COMBAT_END_SOCKET, {
      scope: COMBAT_END_SOCKET_SCOPE,
      type: "finishResponse",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Combat end finish request failed`, error);
    game.socket.emit(COMBAT_END_SOCKET, {
      scope: COMBAT_END_SOCKET_SCOPE,
      type: "finishResponse",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

function enqueueCombatEndOperation(operation) {
  const next = combatEndOperationQueue.then(operation);
  combatEndOperationQueue = next.catch(error => {
    console.error(`${SYSTEM_ID} | Combat end operation failed`, error);
  });
  return next;
}

async function handleCombatEndFinish({
  sessionId = "",
  actorUuid = "",
  attackerActorUuid = "",
  requesterUserId = ""
} = {}) {
  const session = activeSessions.get(sessionId);
  if (!session) return { ok: false, message: "Сессия завершения боя недоступна." };

  const entry = session.entries.find(candidate => candidate.actorUuid === actorUuid);
  if (!entry) return { ok: false, message: "Цель больше недоступна." };
  if (entry.finishing) return { ok: false, message: "Эту цель уже добивают." };

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
    await applyDamageApplication({
      actor: targetActor,
      limbKey: limb.limbKey,
      amount: limb.amount,
      damageTypeKey: "",
      mode: "damage",
      scope: "limb",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source: {
        attackerUuid: attacker.uuid,
        combatEndResolution: true,
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
    entry.finishing = false;
    const currentActor = await resolveActor(actorUuid);
    if (currentActor) refreshSessionEntry(entry, currentActor);
    session.entries = session.entries.filter(candidate => !candidate.removed);
    broadcastCombatEndSession(session);
  }
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
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function isResponsibleGM() {
  return Boolean(game.user?.isGM && getResponsibleGM()?.id === game.user.id);
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
      width: 360,
      height: "auto"
    },
    window: {
      resizable: false
    },
    actions: {
      search: this.#onSearch,
      finish: this.#onFinish
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
    if (options.dismiss !== false && this.#session?.id) dismissedSessionIds.add(this.#session.id);
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
      statusLabel: entry.status === STATUS_DEAD ? "Мертв" : "Без сознания",
      statusClass: entry.status === STATUS_DEAD ? "is-dead" : "is-unconscious",
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
      || 360;
    this.setPosition({
      left: Math.max(WINDOW_MARGIN, Math.round(rightBoundary - width - WINDOW_MARGIN)),
      top: WINDOW_TOP
    });
  }
}
