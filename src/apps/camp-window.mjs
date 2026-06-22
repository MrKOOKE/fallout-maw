import { FALLOUT_MAW } from "../config/system-config.mjs";
import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import {
  getCampSettings,
  getCampState,
  setCampState
} from "../settings/accessors.mjs";
import {
  createCampParticipant,
  createEmptyCampState,
  getDefaultCampRestPlaceId,
  normalizeCampState
} from "../settings/camp.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { advanceWorldTime } from "./world-time-control.mjs";

const { DialogV2 } = foundry.applications.api;
const CAMP_SOCKET = `system.${SYSTEM_ID}`;
const CAMP_SOCKET_SCOPE = "fallout-maw.camp";
const CAMP_SOCKET_TIMEOUT = 10000;
const DEFAULT_CAMP_REST_SECONDS = 8 * 60 * 60;

let hooksRegistered = false;
let campWindow = null;
let localCampActorUuid = "";
let campOperationQueue = Promise.resolve();
let campRenderTimeout = null;
const pendingCampSocketRequests = new Map();

export function registerCampHooks() {
  if (hooksRegistered) return;
  Hooks.on("updateSetting", setting => {
    if (setting?.key !== `${FALLOUT_MAW.id}.campState`) return;
    rerenderCampWindow();
  });
  hooksRegistered = true;
}

export function registerCampSocket() {
  game.socket.on(CAMP_SOCKET, handleCampSocketMessage);
}

export async function openCampFromHud(actors = []) {
  const actorUuids = collectActorUuids(actors);
  if (!actorUuids.length) {
    ui.notifications.warn("Выберите своего актёра для лагеря.");
    return null;
  }
  localCampActorUuid = actorUuids[0];

  const state = getCampState();
  if (state.active && game.user?.isGM) {
    const action = await promptGmCampEntry();
    if (action === "observe") return openCampWindow();
    if (action !== "join") return null;
  } else {
    const confirmed = state.active
      ? await DialogV2.confirm({
        window: { title: "Лагерь" },
        content: "<p>Хотите присоединиться к лагерю?</p>",
        yes: { label: "Присоединиться", icon: "fa-solid fa-campground" },
        no: { label: game.i18n.localize("FALLOUTMAW.Common.Cancel") },
        rejectClose: false
      })
      : await DialogV2.confirm({
      window: { title: "Лагерь" },
      content: "<p>Вы хотите разбить лагерь?</p>",
      yes: { label: "Разбить лагерь", icon: "fa-solid fa-campground" },
      no: { label: game.i18n.localize("FALLOUTMAW.Common.Cancel") },
      rejectClose: false
    });
    if (!confirmed) return null;
  }

  const result = await runCampOperation("createOrJoin", {
    actorUuids: state.active ? actorUuids.slice(0, 1) : actorUuids
  });
  if (!result) return null;
  return openCampWindow();
}

export function openCampWindow() {
  campWindow ??= new CampWindow();
  return campWindow.render({ force: true });
}

async function promptGmCampEntry() {
  return DialogV2.wait({
    window: { title: "Лагерь" },
    content: "<p>Хотите присоединиться к лагерю?</p>",
    buttons: [
      {
        action: "join",
        label: "Присоединиться",
        icon: "fa-solid fa-campground",
        default: true,
        callback: () => "join"
      },
      {
        action: "observe",
        label: "Зайти как наблюдатель",
        icon: "fa-solid fa-eye",
        callback: () => "observe"
      },
      {
        action: "cancel",
        label: game.i18n.localize("FALLOUTMAW.Common.Cancel"),
        icon: "fa-solid fa-xmark",
        callback: () => "cancel"
      }
    ],
    rejectClose: false
  });
}

class CampWindow extends FalloutMaWFormApplicationV2 {
  #suppressCampClose = false;
  #changeHandler = event => void this.#onChange(event);
  #clickHandler = event => void this.#onParticipantClick(event);

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-camp-window",
    classes: ["fallout-maw", "fallout-maw-camp-window"],
    position: {
      width: 760,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      rest: CampWindow.#onRest,
      leave: CampWindow.#onLeave
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.campWindow
    }
  };

  get title() {
    return "Лагерь";
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const state = getCampState();
    const settings = getCampSettings();
    const restPlaceOptions = settings.restPlaces.map(place => ({
      value: place.id,
      label: place.label || place.id
    }));
    const participants = [];
    for (const participant of state.participants) {
      participants.push(await prepareCampParticipantContext(participant, state, restPlaceOptions));
    }
    const localParticipant = participants.find(participant => participant.actorUuid === localCampActorUuid)
      ?? participants.find(participant => participant.canEdit)
      ?? null;
    const canEditWatch = Boolean(game.user?.isGM || participants.some(participant => participant.canEdit));
    if (localParticipant) {
      localCampActorUuid = localParticipant.actorUuid;
      localParticipant.canEditWatch = canEditWatch;
      for (const participant of participants) participant.selected = participant.actorUuid === localParticipant.actorUuid;
    }
    return {
      ...context,
      active: state.active,
      restHours: secondsToHoursInput(state.restSeconds),
      participants,
      localParticipant,
      canRest: canRest(state, participants)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.removeEventListener("change", this.#changeHandler);
    this.element?.addEventListener("change", this.#changeHandler);
    this.element?.removeEventListener("click", this.#clickHandler);
    this.element?.addEventListener("click", this.#clickHandler);
  }

  async _processFormData() {
    return undefined;
  }

  async #onChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches("[data-camp-rest-hours]")) {
      await runCampOperation("updateRestSeconds", {
        restSeconds: hoursInputToSeconds(target.value)
      });
      return;
    }
    if (target.matches("[data-camp-local-watch]")) {
      await runCampOperation("updateParticipant", {
        actorUuid: target.dataset.actorUuid ?? "",
        watchSeconds: hoursInputToSeconds(target.value)
      });
      return;
    }

    const row = target.closest("[data-camp-participant-row]");
    const actorUuid = row?.dataset.actorUuid ?? "";
    if (!actorUuid) return;
    if (target.matches("[data-camp-rest-place]")) {
      await runCampOperation("updateParticipant", {
        actorUuid,
        restPlaceId: target.value
      });
      return;
    }
    if (target.matches("[data-camp-ready]")) {
      await runCampOperation("updateParticipant", {
        actorUuid,
        ready: target.checked
      });
    }
  }

  async #onParticipantClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("input, select, button, label")) return;
    const row = target.closest("[data-camp-participant-row]");
    const actorUuid = row?.dataset.actorUuid ?? "";
    if (!actorUuid || actorUuid === localCampActorUuid) return;
    localCampActorUuid = actorUuid;
    await this.render({ force: true });
  }

  static async #onRest(event) {
    event.preventDefault();
    const result = await runCampOperation("rest", {});
    if (!result) return;
    this.#suppressCampClose = true;
    await this.close();
  }

  static async #onLeave(event, target) {
    event.preventDefault();
    const actorUuid = target.closest("[data-camp-participant-row]")?.dataset.actorUuid ?? "";
    if (!actorUuid) return undefined;
    await runCampOperation("leave", { actorUuid });
    return undefined;
  }

  _onClose(options) {
    super._onClose(options);
    if (!this.#suppressCampClose && game.user?.isGM && getCampState().active) {
      void runCampOperation("closeCamp", {});
    }
    if (campWindow === this) campWindow = null;
  }
}

async function prepareCampParticipantContext(participant, state, restPlaceOptions) {
  const actor = await resolveActor(participant.actorUuid);
  const restPlaceId = participant.restPlaceId || restPlaceOptions[0]?.value || "";
  return {
    ...participant,
    actor,
    name: actor?.name ?? "Недоступный участник",
    img: actor?.img ?? "icons/svg/mystery-man.svg",
    missing: !actor,
    watchHours: secondsToHoursInput(Math.min(participant.watchSeconds, state.restSeconds)),
    restHours: secondsToHoursInput(Math.max(0, state.restSeconds - Math.min(participant.watchSeconds, state.restSeconds))),
    readyChecked: participant.ready,
    restPlaceOptions: restPlaceOptions.map(option => ({
      ...option,
      selected: option.value === restPlaceId
    })),
    canEdit: Boolean(actor && (game.user?.isGM || actor.testUserPermission?.(game.user, "OWNER"))),
    canRemove: Boolean(game.user?.isGM || actor?.testUserPermission?.(game.user, "OWNER"))
  };
}

function canRest(state, participantContexts = []) {
  if (!state.active || state.restSeconds <= 0 || !participantContexts.length) return false;
  if (participantContexts.some(participant => participant.missing)) return false;
  return participantContexts.every(participant => participant.readyChecked);
}

async function requestCampOperation(action, payload = {}, gm = getResponsibleGM()) {
  if (!gm) throw new Error("Нет активного GM для лагеря.");
  if (game.user?.isGM && gm.id === game.user.id) {
    return enqueueCampOperation(() => handleCampOperation(action, payload, game.user.id));
  }

  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingCampSocketRequests.delete(requestId);
      reject(new Error("GM did not answer camp request."));
    }, CAMP_SOCKET_TIMEOUT);
    pendingCampSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(CAMP_SOCKET, {
    scope: CAMP_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function runCampOperation(action, payload = {}) {
  try {
    return await requestCampOperation(action, payload);
  } catch (error) {
    ui.notifications.error(error.message || "Операция лагеря не выполнена.");
    return null;
  }
}

async function handleCampSocketMessage(message = {}) {
  if (message?.scope !== CAMP_SOCKET_SCOPE) return;

  if (message.type === "stateUpdated") {
    rerenderCampWindow();
    return;
  }

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingCampSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingCampSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Camp socket request failed."));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    const result = await enqueueCampOperation(() => handleCampOperation(
      message.action,
      message.payload ?? {},
      message.requesterUserId ?? ""
    ));
    game.socket.emit(CAMP_SOCKET, {
      scope: CAMP_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Camp socket request failed`, error);
    game.socket.emit(CAMP_SOCKET, {
      scope: CAMP_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

function enqueueCampOperation(operation) {
  const next = campOperationQueue.then(operation);
  campOperationQueue = next.catch(error => {
    console.error(`${SYSTEM_ID} | Camp operation failed`, error);
  });
  return next;
}

async function handleCampOperation(action, payload = {}, requesterUserId = "") {
  if (action === "createOrJoin") return createOrJoinCamp(payload, requesterUserId);
  if (action === "updateRestSeconds") return updateCampRestSeconds(payload, requesterUserId);
  if (action === "updateParticipant") return updateCampParticipant(payload, requesterUserId);
  if (action === "leave") return leaveCamp(payload, requesterUserId);
  if (action === "closeCamp") return closeCamp(requesterUserId);
  if (action === "rest") return restCamp(requesterUserId);
  return null;
}

async function createOrJoinCamp({ actorUuids = [] } = {}, requesterUserId = "") {
  const current = getCampState();
  const settings = getCampSettings();
  const ids = collectActorUuids(actorUuids);
  if (!ids.length) throw new Error("Нет участников лагеря.");
  for (const actorUuid of ids) await assertUserOwnsActor(actorUuid, requesterUserId);

  const next = current.active
    ? addParticipantsToCamp(current, ids, requesterUserId, settings)
    : normalizeCampState({
      active: true,
      id: foundry.utils.randomID(),
      createdAt: Date.now(),
      createdBy: requesterUserId,
      restSeconds: DEFAULT_CAMP_REST_SECONDS,
      participants: ids.map(actorUuid => createCampParticipant({ uuid: actorUuid }, {
        userId: requesterUserId,
        restPlaceId: getDefaultCampRestPlaceId(settings)
      }))
    });
  await saveCampState(next);
  return next;
}

async function updateCampRestSeconds({ restSeconds = 0 } = {}, requesterUserId = "") {
  const current = getCampState();
  if (!current.active) return current;
  await assertUserIsCampParticipant(current, requesterUserId);
  const nextRestSeconds = Math.max(0, toInteger(restSeconds));
  const next = normalizeCampState({
    ...current,
    restSeconds: nextRestSeconds,
    participants: current.participants.map(participant => ({
      ...participant,
      watchSeconds: Math.min(participant.watchSeconds, nextRestSeconds)
    }))
  });
  await saveCampState(next);
  return next;
}

async function updateCampParticipant({ actorUuid = "", watchSeconds, restPlaceId, ready } = {}, requesterUserId = "") {
  const current = getCampState();
  if (!current.active) return current;
  if (watchSeconds !== undefined) await assertUserIsCampParticipant(current, requesterUserId);
  if (restPlaceId !== undefined || ready !== undefined) await assertUserOwnsActor(actorUuid, requesterUserId);
  const next = normalizeCampState({
    ...current,
    participants: current.participants.map(participant => {
      if (participant.actorUuid !== actorUuid) return participant;
      const update = { ...participant };
      if (watchSeconds !== undefined) {
        update.watchSeconds = Math.min(current.restSeconds, Math.max(0, toInteger(watchSeconds)));
      }
      if (restPlaceId !== undefined) {
        update.restPlaceId = String(restPlaceId ?? "");
      }
      if (ready !== undefined) update.ready = Boolean(ready);
      return update;
    })
  });
  await saveCampState(next);
  return next;
}

async function leaveCamp({ actorUuid = "" } = {}, requesterUserId = "") {
  const current = getCampState();
  if (!current.active) return current;
  await assertUserOwnsActor(actorUuid, requesterUserId);
  const participants = current.participants.filter(participant => participant.actorUuid !== actorUuid);
  const next = participants.length
    ? normalizeCampState({ ...current, participants })
    : createEmptyCampState();
  await saveCampState(next);
  return next;
}

async function closeCamp(requesterUserId = "") {
  assertUserIsGM(requesterUserId);
  const next = createEmptyCampState();
  await saveCampState(next);
  return next;
}

async function restCamp(requesterUserId = "") {
  const current = getCampState();
  if (!current.active) return current;
  await assertUserIsCampParticipant(current, requesterUserId);
  const participantActors = await Promise.all(current.participants.map(participant => resolveActor(participant.actorUuid)));
  if (participantActors.some(actor => !actor)) throw new Error("В лагере есть недоступный участник.");
  if (current.participants.some(participant => !participant.ready)) throw new Error("Не все участники готовы к отдыху.");
  if (current.restSeconds <= 0) throw new Error("Укажите время отдыха.");

  const settings = getCampSettings();
  const restPlaces = new Map(settings.restPlaces.map(place => [place.id, place]));
  const fallbackPlace = settings.restPlaces[0] ?? null;
  await advanceWorldTime(current.restSeconds, {
    restMode: false,
    forceTimeMechanics: true,
    campRest: {
      forceTimeMechanics: true,
      participants: current.participants.map(participant => {
        const watchSeconds = Math.min(current.restSeconds, Math.max(0, toInteger(participant.watchSeconds)));
        const place = restPlaces.get(participant.restPlaceId) ?? fallbackPlace;
        return {
          actorUuid: participant.actorUuid,
          normalSeconds: watchSeconds,
          restSeconds: Math.max(0, current.restSeconds - watchSeconds),
          effects: place?.effects ?? []
        };
      })
    }
  });
  await saveCampState(createEmptyCampState());
  return createEmptyCampState();
}

function addParticipantsToCamp(state, actorUuids = [], userId = "", settings = getCampSettings()) {
  const existing = new Set(state.participants.map(participant => participant.actorUuid));
  const additions = actorUuids
    .filter(actorUuid => actorUuid && !existing.has(actorUuid))
    .map(actorUuid => createCampParticipant({ uuid: actorUuid }, {
      userId,
      restPlaceId: getDefaultCampRestPlaceId(settings)
    }));
  return normalizeCampState({
    ...state,
    participants: [...state.participants, ...additions]
  });
}

async function saveCampState(state) {
  const normalized = normalizeCampState(state);
  await setCampState(normalized);
  broadcastCampStateUpdated();
  rerenderCampWindow();
  return normalized;
}

function broadcastCampStateUpdated() {
  game.socket?.emit?.(CAMP_SOCKET, {
    scope: CAMP_SOCKET_SCOPE,
    type: "stateUpdated"
  });
}

function rerenderCampWindow() {
  if (!campWindow?.rendered) return;
  window.clearTimeout(campRenderTimeout);
  campRenderTimeout = window.setTimeout(() => {
    campRenderTimeout = null;
    if (campWindow?.rendered) void campWindow.render({ force: true });
  }, 40);
}

function getResponsibleGM() {
  return game.users?.activeGM ?? null;
}

async function resolveActor(uuid = "") {
  if (!uuid) return null;
  try {
    const document = await fromUuid(uuid);
    return document?.documentName === "Actor" ? document : null;
  } catch (_error) {
    return null;
  }
}

async function assertUserOwnsActor(actorUuid = "", userId = "") {
  const user = game.users?.get(userId);
  if (!user) throw new Error("Пользователь лагеря не найден.");
  if (user.isGM) return true;
  const actor = await resolveActor(actorUuid);
  if (!actor?.testUserPermission?.(user, "OWNER")) {
    throw new Error("Нет прав владельца на участника лагеря.");
  }
  return true;
}

async function assertUserIsCampParticipant(state, userId = "") {
  const user = game.users?.get(userId);
  if (!user) throw new Error("Пользователь лагеря не найден.");
  if (user.isGM) return true;
  for (const participant of state.participants) {
    const actor = await resolveActor(participant.actorUuid);
    if (actor?.testUserPermission?.(user, "OWNER")) return true;
  }
  throw new Error("Только участник лагеря может выполнить это действие.");
}

function assertUserIsGM(userId = "") {
  const user = game.users?.get(userId);
  if (!user?.isGM) throw new Error("Только GM может закрыть лагерь.");
  return true;
}

function collectActorUuids(actorsOrUuids = []) {
  const source = Array.isArray(actorsOrUuids) ? actorsOrUuids : [actorsOrUuids];
  const used = new Set();
  const result = [];
  for (const entry of source) {
    const uuid = String(entry?.uuid ?? entry ?? "").trim();
    if (!uuid || used.has(uuid)) continue;
    used.add(uuid);
    result.push(uuid);
  }
  return result;
}

function secondsToHoursInput(seconds) {
  const hours = (Math.max(0, Number(seconds) || 0) / 3600);
  return Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 100) / 100);
}

function hoursInputToSeconds(value) {
  return Math.max(0, Math.round((Number(value) || 0) * 3600));
}
