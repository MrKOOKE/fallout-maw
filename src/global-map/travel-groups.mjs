import { FalloutMaWFormApplicationV2 } from "../apps/base-form-application-v2.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  ACTOR_CONTAINER_FLAG,
  getActorContainerFlag,
  getActorContainerSeatDefinitions,
  hasActorContainer,
  moveActorContainerPassengerData
} from "../utils/actor-containers.mjs";
import { getInventoryGridPointerPosition } from "../utils/inventory-grid-dom.mjs";
import { buildInventoryGridStyle } from "../utils/inventory-containers.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "../utils/item-functions.mjs";
import {
  GLOBAL_MAP_LAYER,
  GLOBAL_MAP_SOCKET,
  GLOBAL_MAP_VERSION,
  LOCATION_ENTRY_MODES,
  TRAVEL_GROUP_FLAG,
  TRAVEL_GROUP_FOLDER_FLAG,
  TRAVEL_GROUP_TOKEN_FLAG
} from "./constants.mjs";
import {
  cellKey,
  getCellCluster,
  getLocationCells,
  parseCellKey,
  pointToCell,
  tokenCenter
} from "./geometry.mjs";
import {
  findLocation,
  getGlobalMapFlag,
  getSceneState,
  normalizeLocationEntryMode,
  setDiscovered,
  updateSceneState
} from "./storage.mjs";
import {
  getTravelGroupData,
  getTravelGroupViewerUserIds,
  getTravelPassengerChildren,
  isTravelGroupCarrierActor,
  resolveTravelPassengerActor,
  resolveTravelGroupParticipants
} from "./travel-group-data.mjs";
import { buildTravelGroupRouteUpdate, createPendingArrival } from "./travel-group-routing.mjs";
import { getTravelGroupImage, getTravelGroupPrototypeToken } from "./travel-settings.mjs";
import { createTravelFormulaSnapshot, evaluateTravelSpeed } from "./travel-speed.mjs";
import { transferTokensBetweenScenes } from "./token-transfer.mjs";
import { queueGlobalMapApplicationPosition } from "./window-position.mjs";
import {
  isSystemEventCancelled,
  systemEventParticipant,
  withSystemEventRoot
} from "../events/foundry-world-events.mjs";

const { DialogV2 } = foundry.applications.api;
const TEMPLATE = `systems/${FALLOUT_MAW.id}/templates/global-map/travel-assembly.hbs`;
const TRAVEL_BYPASS_OPTION = "falloutMaWTravelGroupBypass";
const ARRIVAL_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const assemblyApps = new Map();
const pendingExitPrompts = new Map();
const arrivalTimers = new Map();
const arrivalSelectionWaiters = new Map();
const pendingRequests = new Map();
let responsibleRequestQueue = Promise.resolve();

function runAfterCanvasSettles(callback) {
  const attempt = () => {
    if (canvas.loading) {
      setTimeout(attempt, 16);
      return;
    }
    void callback();
  };
  setTimeout(attempt, 0);
}

export function registerTravelGroupHooks() {
  Hooks.on("preUpdateActor", protectTravelActorUpdate);
  Hooks.on("preDeleteActor", protectTravelActorDelete);
  Hooks.on("preDeleteToken", protectTravelTokenDelete);
  Hooks.on("preCreateItem", (item, _data, options, userId) => protectTravelEmbeddedItem(item, options, userId));
  Hooks.on("preUpdateItem", (item, _changes, options, userId) => protectTravelEmbeddedItem(item, options, userId));
  Hooks.on("preDeleteItem", (item, options, userId) => protectTravelEmbeddedItem(item, options, userId));
  Hooks.on("updateActor", (actor, changes, options) => {
    const flagPath = `flags.${FALLOUT_MAW.id}.${ACTOR_CONTAINER_FLAG}`;
    const changesContainer = foundry.utils.hasProperty(changes, flagPath)
      || Object.keys(changes ?? {}).some(key => key === flagPath || key.startsWith(`${flagPath}.`));
    if (!options?.[TRAVEL_BYPASS_OPTION] && changesContainer) {
      queueAssemblyInvalidation(actor);
    }
  });
  Hooks.on("createItem", (item, options) => {
    if (item?.actor && hasItemFunction(item, ITEM_FUNCTIONS.actorContainer, { ignoreBroken: true })
      && !options?.[TRAVEL_BYPASS_OPTION]) queueAssemblyInvalidation(item.actor);
  });
  Hooks.on("updateItem", (item, changes, options) => {
    const changesContainer = foundry.utils.hasProperty(changes, "system.functions.actorContainer")
      || Object.keys(changes ?? {}).some(key => key === "system.functions.actorContainer" || key.startsWith("system.functions.actorContainer."));
    if (item?.actor && (changesContainer || hasItemFunction(item, ITEM_FUNCTIONS.actorContainer, { ignoreBroken: true }))
      && !options?.[TRAVEL_BYPASS_OPTION]) queueAssemblyInvalidation(item.actor);
  });
  Hooks.on("deleteItem", (item, options) => {
    if (item?.actor && hasItemFunction(item, ITEM_FUNCTIONS.actorContainer, { ignoreBroken: true })
      && !options?.[TRAVEL_BYPASS_OPTION]) queueAssemblyInvalidation(item.actor);
  });
  Hooks.on("updateToken", (token, changes, options) => {
    if (options?.[TRAVEL_BYPASS_OPTION]) return;
    if (changes.width !== undefined || changes.height !== undefined || changes.actorId !== undefined) {
      queueAssemblyTokenInvalidation(token.parent, token.id);
    }
  });
  Hooks.on("deleteToken", (token, options) => {
    if (!options?.[TRAVEL_BYPASS_OPTION]) refreshAssembliesContainingToken(token.parent, token.id);
  });
  Hooks.on("updateUser", () => {
    if (isResponsibleGM()) void maintainAssemblyLeaders();
    if (isResponsibleGM()) queueResumeArrivalTimers();
  });
  Hooks.on("ready", () => {
    if (isResponsibleGM()) queueResumeArrivalTimers();
    void restoreAssemblyWindowsForCurrentUser();
  });
  Hooks.on("canvasReady", () => runAfterCanvasSettles(restoreArrivalSelectionForCurrentUser));
}

export function registerTravelGroupSocket() {
  game.socket.on(GLOBAL_MAP_SOCKET, handleTravelGroupSocket);
  if (isResponsibleGM()) queueResumeArrivalTimers();
}

export async function promptLocationExit({ sceneId, exitZoneId, tokenId, userId = game.user?.id } = {}) {
  const scene = game.scenes?.get(sceneId);
  const zone = getSceneState(scene).locationExitZones.find(entry => entry.id === exitZoneId);
  const token = scene?.tokens?.get(tokenId);
  if (!scene || !zone || !token) return false;
  const promptKey = `${sceneId}:${tokenId}`;
  if (pendingExitPrompts.has(promptKey)) return false;
  pendingExitPrompts.set(promptKey, { dialog: null, sceneId, exitZoneId, tokenId, userId });
  const preservesCarrier = isTravelGroupCarrierActor(token.actor);
  const parentScene = game.scenes?.get(getGlobalMapFlag(scene)?.parentSceneId);
  const parentSceneName = String(parentScene?.name ?? "").trim();
  const returnDestination = parentSceneName ? `на «${parentSceneName}»` : "назад";
  const returnDestinationHtml = parentSceneName
    ? `на «${foundry.utils.escapeHTML(parentSceneName)}»`
    : "назад";
  const result = await DialogV2.wait({
    window: { title: preservesCarrier ? `Вернуться ${returnDestination}?` : (zone.name || "Покинуть локацию?") },
    content: preservesCarrier
      ? `<p>Вернуться ${returnDestinationHtml} всей путешествующей группой?</p>`
      : `<p>Покинуть локацию через <strong>${foundry.utils.escapeHTML(zone.name || "зону выхода")}</strong>?</p>`,
    buttons: preservesCarrier
      ? [
        { action: "carrier", label: `Вернуться ${returnDestination}`, icon: "fa-solid fa-arrow-left", default: true },
        { action: "stay", label: "Остаться", icon: "fa-solid fa-xmark" }
      ]
      : [
        { action: "solo", label: "Покинуть самому", icon: "fa-solid fa-person-walking-arrow-right" },
        { action: "group", label: "В составе группы", icon: "fa-solid fa-people-group", default: true },
        { action: "stay", label: "Остаться", icon: "fa-solid fa-xmark" }
      ],
    rejectClose: false,
    render: (_event, dialog) => {
      if (!pendingExitPrompts.has(promptKey)) {
        void dialog.close();
        return;
      }
      pendingExitPrompts.set(promptKey, { dialog, sceneId, exitZoneId, tokenId, userId });
    }
  });
  pendingExitPrompts.delete(promptKey);
  if (!["solo", "group", "carrier"].includes(result)) return false;
  return requestLocationExit({ sceneId, exitZoneId, tokenId, mode: result, requestingUserId: userId });
}

export async function promptLocationEntry({ sceneId, locationId, tokenId, userId = game.user?.id } = {}) {
  const found = findLocation(locationId);
  const token = game.scenes?.get(sceneId)?.tokens?.get(tokenId);
  if (!found?.location?.linkedSceneId || !token) return false;
  if (!token.actor?.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG)?.groupId) {
    ui.notifications.warn("На глобальной карте в локацию входит только носитель путешествующей группы.");
    return false;
  }
  const confirmed = await DialogV2.confirm({
    window: { title: "Войти в локацию?" },
    content: `<p>Переместиться в <strong>${foundry.utils.escapeHTML(found.location.name)}</strong>?</p>`,
    yes: { label: "Переместиться" },
    no: { label: "Остаться" }
  });
  if (!confirmed) return false;
  return requestLocationEntry({ sceneId, locationId, tokenId, requestingUserId: userId });
}

export function requestLocationExit(payload = {}) {
  return submitTravelGroupRequest("travelGroup.exit.request", payload);
}

export function requestLocationEntry(payload = {}) {
  return submitTravelGroupRequest("travelGroup.arrival.request", payload);
}

export function selectArrivalZone(payload = {}) {
  return submitTravelGroupRequest("travelGroup.arrival.select", payload);
}

export function cancelTravelAssembly(assemblyId, sceneId = canvas.scene?.id) {
  return submitTravelGroupRequest("travelGroup.assembly.cancel", { assemblyId, sceneId });
}

export function moveTravelCarrierPassenger(payload = {}) {
  return submitTravelGroupRequest("travelGroup.carrier.movePassenger", payload);
}

export function openTravelAssembly(assemblyId, sceneId = canvas.scene?.id) {
  const key = `${sceneId}:${assemblyId}`;
  let app = assemblyApps.get(key);
  if (!app) {
    app = new TravelAssemblyApplication(sceneId, assemblyId);
    assemblyApps.set(key, app);
  }
  app.render(true);
  return app;
}

export async function travelToLocation(locationId, { tokenIds = null } = {}) {
  const tokenId = tokenIds?.[0] ?? canvas.tokens?.controlled?.[0]?.id;
  if (!canvas.scene?.id || !tokenId) {
    ui.notifications.warn("Выберите токен путешествующей группы.");
    return false;
  }
  return promptLocationEntry({ sceneId: canvas.scene.id, locationId, tokenId });
}

class TravelAssemblyApplication extends FalloutMaWFormApplicationV2 {
  #initialPositionApplied = false;
  #dragDrop = null;

  constructor(sceneId, assemblyId, options = {}) {
    super({ ...options, id: `fallout-maw-travel-assembly-${sceneId}-${assemblyId}` });
    this.sceneId = sceneId;
    this.assemblyId = assemblyId;
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-travel-assembly",
    classes: [...super.DEFAULT_OPTIONS.classes, "standard-form", "fallout-maw-global-map-editor", "fallout-maw-travel-assembly"],
    position: { width: "auto", height: "auto" },
    window: { title: "Сбор группы", resizable: true },
    actions: {
      toggleReady: TravelAssemblyApplication.#toggleReady,
      removeMember: TravelAssemblyApplication.#removeMember,
      depart: TravelAssemblyApplication.#depart
    },
    form: {
      handler: TravelAssemblyApplication.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    }
  };

  static PARTS = { form: { template: TEMPLATE } };

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: "[data-travel-member-drag]",
      dropSelector: "[data-travel-drop]",
      callbacks: {
        dragstart: this.#onDragStart.bind(this),
        dragend: this.#onDragEnd.bind(this),
        dragenter: this.#onDragEnter.bind(this),
        dragleave: this.#onDragLeave.bind(this),
        drop: this.#onDrop.bind(this)
      }
    });
  }

  async _prepareContext() {
    const scene = game.scenes?.get(this.sceneId);
    const assembly = getAssembly(scene, this.assemblyId);
    if (!scene || !assembly) return { missing: true };
    const user = game.user;
    const model = await buildAssemblyModel(scene, assembly);
    const canManage = canUserManageAssembly(scene, assembly, user, model);
    const requiredMembers = model.members.filter(memberRequiresReady);
    const readyToDepart = requiredMembers.length > 0
      && !model.members.some(member => member.missing)
      && requiredMembers.every(member => model.readyMemberIds.has(member.id));
    const members = model.members.map(member => ({
      ...member,
      requiresReady: memberRequiresReady(member),
      ready: !memberRequiresReady(member) || model.readyMemberIds.has(member.id),
      canReady: memberRequiresReady(member)
        && Boolean(user?.isGM || member.actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)),
      canDrag: Boolean(!member.vehicle && (user?.isGM || member.actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))),
      canRemove: Boolean(canManage)
    }));
    const vehicles = model.vehicles.map(vehicle => {
      const vehicleMember = members.find(member => member.id === vehicle.memberId);
      return {
        ...vehicle,
        ready: vehicleMember?.ready ?? true,
        canReady: vehicleMember?.canReady ?? false,
        canRemove: Boolean(canManage),
        seatGroups: buildVehicleSeatGroups(vehicle, members)
      };
    });
    return {
      missing: false,
      assembly,
      members: members.filter(member => !member.vehicle),
      vehicles,
      hasVehicles: vehicles.length > 0,
      canManage,
      canDepart: canManage,
      readyToDepart
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!this.#initialPositionApplied) {
      this.#initialPositionApplied = true;
      queueGlobalMapApplicationPosition(this);
    }
    this._dragDrop.bind(this.element);
  }

  async _processFormData() {}

  _onClose(options) {
    super._onClose(options);
    assemblyApps.delete(`${this.sceneId}:${this.assemblyId}`);
    if (!options?.falloutMaWAssemblyClosed && getAssembly(game.scenes?.get(this.sceneId), this.assemblyId)) {
      void cancelTravelAssembly(this.assemblyId, this.sceneId);
    }
  }

  static #toggleReady(_event, target) {
    return submitTravelGroupRequest("travelGroup.assembly.ready", {
      sceneId: this.sceneId,
      assemblyId: this.assemblyId,
      memberId: target.dataset.memberId
    });
  }

  static #removeMember(_event, target) {
    return submitTravelGroupRequest("travelGroup.assembly.remove", {
      sceneId: this.sceneId,
      assemblyId: this.assemblyId,
      memberId: target.dataset.memberId
    });
  }

  static #depart() {
    return submitTravelGroupRequest("travelGroup.assembly.depart", {
      sceneId: this.sceneId,
      assemblyId: this.assemblyId
    });
  }

  #onDragStart(event) {
    const member = event.currentTarget?.closest?.("[data-travel-member-drag]");
    const memberId = String(member?.dataset.memberId ?? "");
    if (!memberId || member?.dataset.canDrag !== "true") {
      event.preventDefault();
      return;
    }
    const data = {
      type: "TravelAssemblyMember",
      sceneId: this.sceneId,
      assemblyId: this.assemblyId,
      memberId
    };
    event.dataTransfer?.setData("application/json", JSON.stringify(data));
    event.dataTransfer?.setData("text/plain", JSON.stringify(data));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    member.classList.add("dragging");
  }

  #onDragEnd() {
    this.element?.querySelectorAll(".dragging, .drop-preview")
      .forEach(element => element.classList.remove("dragging", "drop-preview"));
  }

  #onDragEnter(event) {
    event.currentTarget?.closest?.("[data-travel-drop]")?.classList.add("drop-preview");
  }

  #onDragLeave(event) {
    const target = event.currentTarget?.closest?.("[data-travel-drop]");
    if (target && !target.contains(event.relatedTarget)) target.classList.remove("drop-preview");
  }

  #onDrop(event) {
    const target = event.currentTarget?.closest?.("[data-travel-drop]");
    target?.classList.remove("drop-preview");
    const data = getTravelAssemblyDragData(event);
    if (data.type !== "TravelAssemblyMember"
      || data.sceneId !== this.sceneId
      || data.assemblyId !== this.assemblyId
      || !target) return false;
    const pointer = target.dataset.dropKind === "vehicle-cell"
      ? getInventoryGridPointerPosition(event, target)
      : null;
    if (target.dataset.dropKind === "vehicle-cell" && !pointer) return false;
    const placement = target.dataset.dropKind === "vehicle-cell"
      ? {
          vehicleTokenId: target.dataset.vehicleTokenId,
          slotId: target.dataset.slotId,
          slotIndex: Number(target.dataset.slotIndex),
          x: pointer.x,
          y: pointer.y
        }
      : null;
    return submitTravelGroupRequest("travelGroup.assembly.place", {
      sceneId: this.sceneId,
      assemblyId: this.assemblyId,
      memberId: data.memberId,
      placement
    });
  }
}

async function submitTravelGroupRequest(action, payload = {}) {
  const request = {
    action,
    requestId: foundry.utils.randomID(),
    requestingUserId: game.user?.id,
    ...payload
  };
  if (game.user?.isGM && isResponsibleGM()) return queueResponsibleGMRequest(request);
  const responsibleGM = getResponsibleGM();
  if (!responsibleGM) {
    ui.notifications.warn("Путешествие недоступно: нет активного GM.");
    return false;
  }
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(request.requestId);
      ui.notifications.error("GM не подтвердил запрос перехода. Обновите клиент GM и повторите попытку.");
      resolve(false);
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(request.requestId, { resolve, timeout });
    game.socket.emit(GLOBAL_MAP_SOCKET, request, { recipients: [responsibleGM.id] });
  });
}

async function handleTravelGroupSocket(payload, senderUserId = null) {
  if (!payload || typeof payload !== "object" || !String(payload.action ?? "").startsWith("travelGroup.")) return;
  if (isTravelGroupRequestAction(payload.action)) {
    if (senderUserId && payload.requestingUserId !== senderUserId) return;
    if (game.user?.isGM && isResponsibleGM()) {
      const result = await queueResponsibleGMRequest(payload);
      emitGroupRequestComplete(payload, result !== false);
    }
    return;
  }
  if (payload.action === "travelGroup.request.complete" && payload.requestingUserId === game.user?.id) {
    resolvePendingRequest(payload.requestId, payload.success !== false);
  } else if (payload.action === "travelGroup.assembly.changed") {
    await handleAssemblyChanged(payload);
  } else if (payload.action === "travelGroup.assembly.closed") {
    const app = assemblyApps.get(`${payload.sceneId}:${payload.assemblyId}`);
    await app?.close?.({ falloutMaWAssemblyClosed: true });
  } else if (payload.action === "travelGroup.arrival.open") {
    if (!(payload.viewerUserIds ?? []).includes(game.user?.id)) return;
    await openArrivalSelection(payload);
  } else if (payload.action === "travelGroup.arrival.closed") {
    await restoreTokenControlsAfterArrival(payload);
  } else if (payload.action === "travelGroup.error" && payload.requestingUserId === game.user?.id) {
    resolvePendingRequest(payload.requestId, false);
    ui.notifications.error(payload.message || "Не удалось выполнить путешествие.");
  }
}

function resolvePendingRequest(requestId, result) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingRequests.delete(requestId);
  pending.resolve(result);
}

function emitGroupRequestComplete(payload, success = true) {
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "travelGroup.request.complete",
    requestId: payload.requestId,
    requestingUserId: payload.requestingUserId,
    success
  }, { recipients: [payload.requestingUserId] });
}

function queueResponsibleGMRequest(payload) {
  return queueResponsibleGMTask(() => handleResponsibleGMRequest(payload));
}

function queueResponsibleGMTask(callback) {
  const task = responsibleRequestQueue.then(callback);
  responsibleRequestQueue = task.catch(() => {});
  return task;
}

function queueResumeArrivalTimers() {
  void queueResponsibleGMTask(resumeArrivalTimers).catch(error => {
    console.warn(`${FALLOUT_MAW.id} | Could not resume pending travel-group arrivals`, error);
  });
}

async function handleResponsibleGMRequest(payload) {
  try {
    switch (payload.action) {
      case "travelGroup.exit.request": return await handleExitRequest(payload);
      case "travelGroup.assembly.ready": return await handleReadyRequest(payload);
      case "travelGroup.assembly.place": return await handlePlaceRequest(payload);
      case "travelGroup.assembly.remove": return await handleRemoveRequest(payload);
      case "travelGroup.assembly.depart": return await handleDepartRequest(payload);
      case "travelGroup.assembly.cancel": return await handleCancelRequest(payload);
      case "travelGroup.carrier.movePassenger": return await handleCarrierMovePassengerRequest(payload);
      case "travelGroup.arrival.request": return await handleArrivalRequest(payload);
      case "travelGroup.arrival.select": return await handleArrivalSelectRequest(payload);
      default: return false;
    }
  } catch (error) {
    console.error(`${FALLOUT_MAW.id} | Travel-group request failed`, error);
    return emitGroupError(payload, error.message || "Не удалось выполнить путешествие.");
  }
}

async function handleExitRequest(payload) {
  const scene = game.scenes?.get(payload.sceneId);
  const token = scene?.tokens?.get(payload.tokenId);
  const zone = getSceneState(scene).locationExitZones.find(entry => entry.id === payload.exitZoneId);
  const user = game.users?.get(payload.requestingUserId);
  validateExitParticipant(scene, zone, token, user);
  if (isTravelGroupCarrierActor(token.actor)) {
    if (token.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival) {
      throw new Error("Сначала завершите уже начатый переход группы.");
    }
    return performCarrierDeparture({ scene, zone, carrierToken: token, requestingUserId: user.id });
  }
  if (!["solo", "group"].includes(payload.mode)) throw new Error("Не выбран режим выхода.");
  if (payload.mode === "solo") {
    const result = await performDeparture({ scene, zone, tokenDocuments: [token], requestingUserId: user.id });
    if (result) await removeTokenFromAssemblies(scene, token.id);
    return result;
  }
  let assembly = getSceneState(scene).travelAssemblies.find(entry => entry.exitZoneId === zone.id && entry.status === "open");
  if (!assembly) {
    assembly = {
      id: foundry.utils.randomID(),
      exitZoneId: zone.id,
      leaderUserId: user.id,
      leaderMemberId: tokenMemberId(token.id),
      memberTokenIds: [],
      readyMemberIds: [],
      readyTokenIds: [],
      placements: {},
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }
  if (!assembly.memberTokenIds.includes(token.id)) assembly.memberTokenIds.push(token.id);
  assembly.updatedAt = Date.now();
  await storeAssembly(scene, assembly);
  broadcastAssemblyChanged(scene, assembly);
  return true;
}

async function handleReadyRequest(payload) {
  const { scene, assembly, user } = getAssemblyRequestContext(payload);
  const model = await buildAssemblyModel(scene, assembly);
  const member = model.membersById.get(payload.memberId);
  if (!member?.actor) throw new Error("Участник не найден.");
  if (!memberRequiresReady(member)) throw new Error("Этот участник не требует подтверждения готовности.");
  if (!user.isGM && !member.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
    throw new Error("Нет прав на подтверждение этого участника.");
  }
  const ready = new Set(model.readyMemberIds);
  if (ready.has(member.id)) ready.delete(member.id);
  else ready.add(member.id);
  assembly.readyMemberIds = Array.from(ready);
  assembly.readyTokenIds = [];
  assembly.updatedAt = Date.now();
  await storeAssembly(scene, assembly);
  broadcastAssemblyChanged(scene, assembly);
  return true;
}

async function handlePlaceRequest(payload) {
  const { scene, assembly, user } = getAssemblyRequestContext(payload);
  const model = await buildAssemblyModel(scene, assembly);
  const member = model.membersById.get(payload.memberId);
  if (!member?.actor || member.vehicle) throw new Error("Актёр недоступен для рассадки.");
  if (!user.isGM && !member.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
    throw new Error("Перемещать можно только принадлежащего вам актёра.");
  }
  const placement = normalizeAssemblyPlacement(payload.placement);
  if (placement) validateAssemblyPlacement(model, member, placement);
  const previous = member.placement;
  assembly.placements ??= {};
  assembly.placements[member.id] = placement;
  const affected = new Set([
    member.id,
    previous?.vehicleTokenId ? tokenMemberId(previous.vehicleTokenId) : "",
    placement?.vehicleTokenId ? tokenMemberId(placement.vehicleTokenId) : ""
  ].filter(Boolean));
  assembly.readyMemberIds = Array.from(model.readyMemberIds).filter(id => !affected.has(id));
  assembly.readyTokenIds = [];
  assembly.updatedAt = Date.now();
  await storeAssembly(scene, assembly);
  broadcastAssemblyChanged(scene, assembly);
  return true;
}

async function handleRemoveRequest(payload) {
  const { scene, assembly, user } = getAssemblyRequestContext(payload);
  const model = await buildAssemblyModel(scene, assembly);
  requireAssemblyManager(scene, assembly, user, model);
  const member = model.membersById.get(payload.memberId);
  if (!member) throw new Error("Участник не найден.");
  if (!member.topLevel) return removePassengerFromAssembly(scene, assembly, model, member);
  if (!member.tokenId) throw new Error("Участник не найден.");
  const affectedIds = new Set(model.members
    .filter(entry =>
      entry.id === member.id
      || entry.sourceVehicleTokenId === member.tokenId
      || entry.placement?.vehicleTokenId === member.tokenId
    )
    .map(entry => entry.id));
  assembly.memberTokenIds = assembly.memberTokenIds.filter(id => id !== member.tokenId);
  assembly.readyMemberIds = Array.from(model.readyMemberIds).filter(id => !affectedIds.has(id));
  delete assembly.placements?.[member.id];
  for (const affected of model.members.filter(entry => affectedIds.has(entry.id))) {
    if (affected.sourceVehicleTokenId === member.tokenId) delete assembly.placements?.[affected.id];
    else if (affected.placement?.vehicleTokenId === member.tokenId) assembly.placements[affected.id] = null;
  }
  if (!assembly.memberTokenIds.length) return closeAssembly(scene, assembly.id);
  const currentLeader = game.users?.get(assembly.leaderUserId);
  const nextModel = await buildAssemblyModel(scene, assembly);
  assembly.leaderMemberId = nextModel.leaderMemberId;
  if (!canLeadAssembly(scene, assembly, currentLeader, nextModel)) {
    const next = selectNextLeader(scene, assembly, nextModel);
    if (!next) return closeAssembly(scene, assembly.id);
    assembly.leaderUserId = next.user.id;
    assembly.leaderMemberId = next.member.id;
  }
  assembly.updatedAt = Date.now();
  await storeAssembly(scene, assembly);
  broadcastAssemblyChanged(scene, assembly);
  return true;
}

async function removePassengerFromAssembly(scene, assembly, model, member) {
  const vehicleToken = scene.tokens?.get(member.sourceVehicleTokenId);
  const vehicleActor = vehicleToken?.actor;
  const sourcePassenger = member.sourcePassenger;
  if (!vehicleToken || !vehicleActor || !sourcePassenger?.tokenData) {
    throw new Error("Исходный транспорт пассажира недоступен.");
  }
  const tokenData = foundry.utils.deepClone(sourcePassenger.tokenData);
  delete tokenData._id;
  delete tokenData.id;
  tokenData.hidden = false;
  const center = pointToCell(scene, tokenCenter(vehicleToken, scene));
  const preferred = center ? getCellCluster(scene, center, 2) : [];
  const position = findFreePlacement(scene, tokenData, preferred);
  tokenData.x = position.x;
  tokenData.y = position.y;
  let createdToken = null;
  const originalPassengers = getActorContainerFlag(vehicleActor).passengers;
  const remaining = originalPassengers.filter(passenger => passenger.id !== sourcePassenger.id);
  const ownership = getPassengerRemovalOwnership(vehicleActor, sourcePassenger, remaining);
  try {
    [createdToken] = await scene.createEmbeddedDocuments("Token", [tokenData], { [TRAVEL_BYPASS_OPTION]: true });
    if (!createdToken) throw new Error("Не удалось разместить исключённого пассажира.");
    await vehicleActor.update({
      ownership,
      [`flags.${FALLOUT_MAW.id}.${ACTOR_CONTAINER_FLAG}.passengers`]: remaining
    }, { [TRAVEL_BYPASS_OPTION]: true });
  } catch (error) {
    if (createdToken) {
      await scene.deleteEmbeddedDocuments("Token", [createdToken.id], { [TRAVEL_BYPASS_OPTION]: true }).catch(() => {});
    }
    throw error;
  }
  assembly.readyMemberIds = Array.from(model.readyMemberIds).filter(id =>
    id !== member.id && id !== tokenMemberId(vehicleToken.id)
  );
  delete assembly.placements?.[member.id];
  if (model.leaderMemberId === member.id) {
    const nextModel = await buildAssemblyModel(scene, assembly);
    const next = selectNextLeader(scene, assembly, nextModel);
    if (!next) return closeAssembly(scene, assembly.id);
    assembly.leaderMemberId = next.member.id;
    assembly.leaderUserId = next.user.id;
  }
  assembly.updatedAt = Date.now();
  await storeAssembly(scene, assembly);
  broadcastAssemblyChanged(scene, assembly);
  return true;
}

function getPassengerRemovalOwnership(vehicleActor, removedPassenger, remainingPassengers) {
  const ownership = foundry.utils.deepClone(vehicleActor.ownership ?? {});
  const activeTemporaryUsers = new Set(remainingPassengers.flatMap(passenger => passenger.temporaryOwnerUserIds ?? []));
  for (const userId of removedPassenger.temporaryOwnerUserIds ?? []) {
    if (activeTemporaryUsers.has(userId)) continue;
    if (Object.hasOwn(removedPassenger.temporaryOwnerLevels ?? {}, userId)) {
      ownership[userId] = removedPassenger.temporaryOwnerLevels[userId];
    } else {
      delete ownership[userId];
    }
  }
  return ownership;
}

async function handleDepartRequest(payload) {
  const { scene, assembly, user } = getAssemblyRequestContext(payload);
  const model = await buildAssemblyModel(scene, assembly);
  requireAssemblyManager(scene, assembly, user, model);
  return performAssemblyDeparture(scene, assembly, model, user.id);
}

async function performAssemblyDeparture(scene, assembly, model, requestingUserId) {
  const tokenDocuments = assembly.memberTokenIds.map(id => scene.tokens?.get(id)).filter(Boolean);
  if (tokenDocuments.length !== assembly.memberTokenIds.length) throw new Error("Один из участников больше недоступен.");
  if (model.members.some(member => member.missing)
    || model.members.filter(memberRequiresReady).some(member => !model.readyMemberIds.has(member.id))) {
    throw new Error("Не все участники подтвердили готовность.");
  }
  const zone = getSceneState(scene).locationExitZones.find(entry => entry.id === assembly.exitZoneId);
  if (!zone) throw new Error("Зона выхода не найдена.");
  const result = await performDeparture({
    scene,
    zone,
    tokenDocuments,
    model,
    requestingUserId,
    assemblyId: assembly.id
  });
  if (result) await closeAssembly(scene, assembly.id);
  return result;
}

async function handleCancelRequest(payload) {
  const { scene, assembly, user } = getAssemblyRequestContext(payload);
  const model = await buildAssemblyModel(scene, assembly);
  requireAssemblyManager(scene, assembly, user, model);
  return closeAssembly(scene, assembly.id);
}

async function handleArrivalRequest(payload) {
  const originScene = game.scenes?.get(payload.sceneId);
  const token = originScene?.tokens?.get(payload.tokenId);
  const user = game.users?.get(payload.requestingUserId);
  const found = findLocation(payload.locationId);
  if (!originScene || !token?.actor || !user || !found || found.scene.id !== originScene.id) throw new Error("Локация или группа не найдена.");
  if (!token.actor.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG)?.groupId) throw new Error("На глобальную карту может входить только носитель группы.");
  if (!getTravelCarrierUnits(token.actor).length) throw new Error("В группе нет участников для переноса.");
  if (!user.isGM && !token.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) throw new Error("Нет прав на группу.");
  const currentKey = cellKey(pointToCell(originScene, tokenCenter(token, originScene)));
  if (!getLocationCells(originScene, found.location).some(cell => cellKey(cell) === currentKey)) throw new Error("Группа больше не находится на локации.");
  if (token.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival) {
    throw new Error("Для группы уже выполняется переход.");
  }
  const targetScene = found.location.linkedSceneId ? game.scenes?.get(found.location.linkedSceneId) : null;
  if (!targetScene) throw new Error("Сцена локации не найдена.");
  const group = token.actor.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG);
  const entryMode = normalizeLocationEntryMode(found.location.entryMode);
  const transferId = foundry.utils.randomID();
  const originCellKeys = getLocationCells(originScene, found.location).map(cellKey);
  const pending = createPendingArrival({
    transferId,
    groupId: group.groupId,
    locationId: found.location.id,
    entryMode,
    originSceneId: originScene.id,
    targetSceneId: targetScene.id,
    requestedByUserId: user.id,
    deadline: Date.now() + ARRIVAL_TIMEOUT_MS,
    originCellKeys
  });
  const zones = getValidArrivalZones(targetScene, token, pending);
  if (!zones.length) throw new Error("На сцене локации нет допустимой зоны входа и выхода.");
  pending.validExitZoneIds = zones.map(zone => zone.id);
  const eventParticipants = await collectTravelGroupEventParticipants(token.actor);
  await withSystemEventRoot({
    kind: "travelArrivalPending",
    operationId: `travel-arrival-pending:${transferId}`,
    sceneUuid: String(originScene.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? "")
  }, async scope => {
    await token.update({ [`flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}.pendingArrival`]: pending }, {
      falloutMawSystemEventChainRef: scope.chainRef,
      chainRef: scope.chainRef
    });
    const target = systemEventParticipant({ actor: token.actor, token });
    await scope.emit("fallout-maw.travel.arrival.pending", {
      data: {
        ...pending,
        originSceneUuid: String(originScene.uuid ?? ""),
        targetSceneUuid: String(targetScene.uuid ?? ""),
        carrierActorUuid: String(token.actor.uuid ?? ""),
        carrierTokenUuid: String(token.uuid ?? "")
      },
      outcome: { success: true, pending: true }
    }, {
      occurrenceKey: `travel-arrival-pending:${transferId}`,
      participants: { source: target, target, related: eventParticipants }
    });
    return true;
  });
  if (zones.length === 1) {
    scheduleArrivalTimer(originScene.id, token.id, pending.deadline);
    return performArrival(originScene, token, targetScene, zones[0], pending);
  }

  const viewerUserIds = getTravelGroupViewerUserIds(token.actor, { requestingUserId: user.id });
  scheduleArrivalTimer(originScene.id, token.id, pending.deadline);
  if (!targetScene.active) await targetScene.activate();
  const selection = {
    action: "travelGroup.arrival.open",
    originSceneId: originScene.id,
    tokenId: token.id,
    ...pending,
    viewerUserIds
  };
  game.socket.emit(GLOBAL_MAP_SOCKET, selection);
  if (viewerUserIds.includes(game.user.id)) await openArrivalSelection(selection);
  return true;
}

async function handleArrivalSelectRequest(payload) {
  const originScene = game.scenes?.get(payload.originSceneId);
  const token = originScene?.tokens?.get(payload.tokenId);
  const pending = token?.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival;
  const user = game.users?.get(payload.requestingUserId);
  if (!originScene || !token?.actor || !pending || !user) throw new Error("Ожидающий вход не найден.");
  if (!user.isGM && !token.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) throw new Error("Нет прав на выбор зоны.");
  if (!payload.transferId || payload.transferId !== pending.transferId) throw new Error("Этот выбор зоны уже устарел.");
  validatePendingCarrierPosition(originScene, token, pending);
  const targetScene = game.scenes?.get(pending.targetSceneId);
  const zone = getSceneState(targetScene).locationExitZones.find(entry => entry.id === payload.exitZoneId && entry.cells?.length);
  if (!targetScene || !zone) throw new Error("Зона прибытия не найдена.");
  if (!getValidArrivalZones(targetScene, token, pending).some(entry => entry.id === zone.id)) {
    throw new Error("В выбранной зоне недостаточно свободного места.");
  }
  return performArrival(originScene, token, targetScene, zone, pending);
}

async function performCarrierDeparture({ scene, zone, carrierToken, requestingUserId }) {
  const transferId = foundry.utils.randomID();
  return withSystemEventRoot({
    kind: "travelDeparture",
    operationId: `travel-carrier-departure:${transferId}`,
    sceneUuid: String(scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? "")
  }, scope => performCarrierDepartureInRoot({
    scene,
    zone,
    carrierToken,
    requestingUserId,
    transferId
  }, scope));
}

async function performCarrierDepartureInRoot({
  scene,
  zone,
  carrierToken,
  requestingUserId,
  transferId
}, scope) {
  const sceneFlag = getGlobalMapFlag(scene);
  const parentScene = sceneFlag?.parentSceneId ? game.scenes?.get(sceneFlag.parentSceneId) : null;
  const location = parentScene
    ? getSceneState(parentScene).locations.find(entry => entry.id === sceneFlag.nodeId)
    : null;
  const carrierActor = game.actors?.get(carrierToken.actorId) ?? carrierToken.actor;
  const group = getTravelGroupData(carrierActor);
  if (!parentScene || !location) throw new Error("Родительская карта локации не найдена.");
  if (!group?.groupId) throw new Error("Носитель путешествующей группы не найден.");
  if (!getTravelCarrierUnits(carrierActor).length) throw new Error("В группе нет участников для переноса.");

  const eventParticipants = await collectTravelGroupEventParticipants(carrierActor);
  const commonData = {
    groupId: String(group.groupId),
    transferId,
    entryMode: LOCATION_ENTRY_MODES.CARRIER,
    groupPreserved: true,
    direction: "ascend",
    originSceneUuid: String(scene.uuid ?? ""),
    targetSceneUuid: String(parentScene.uuid ?? ""),
    locationId: String(location.id ?? ""),
    exitZoneId: String(zone.id ?? ""),
    requestingUserId: String(requestingUserId ?? ""),
    carrierActorUuid: String(carrierActor.uuid ?? ""),
    carrierTokenUuid: String(carrierToken.uuid ?? "")
  };
  for (const [index, target] of eventParticipants.entries()) {
    const gate = await scope.emit("fallout-maw.travel.departure.before", {
      data: { ...commonData, actorUuid: target.actorUuid, tokenUuid: target.tokenUuid }
    }, {
      occurrenceKey: `travel-carrier:${transferId}:departure-before:${target.actorUuid || index}`,
      participants: { source: target, target, related: eventParticipants.filter(entry => entry !== target) }
    });
    if (isSystemEventCancelled(gate)) return false;
  }

  const destinationUpdate = {};
  const position = findFreePlacement(
    parentScene,
    carrierToken.toObject(),
    getLocationCells(parentScene, location),
    [],
    { strictPreferredCells: true }
  );
  destinationUpdate.x = position.x;
  destinationUpdate.y = position.y;
  foundry.utils.setProperty(
    destinationUpdate,
    `flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}.pendingArrival`,
    null
  );
  const transfer = await transferTokensBetweenScenes({
    originScene: scene,
    targetScene: parentScene,
    tokenDocuments: [carrierToken],
    destinationUpdates: [destinationUpdate],
    actorUpdates: [buildTravelGroupRouteUpdate(carrierActor, parentScene, transferId)],
    operationOptions: travelDocumentOptions(scope, { [TRAVEL_BYPASS_OPTION]: true })
  });
  const destinationToken = transfer.tokenMap.get(carrierToken) ?? transfer.transfers[0]?.destinationToken;
  if (!destinationToken) throw new Error("Носитель группы не был создан на родительской карте.");

  const viewerUserIds = getTravelGroupViewerUserIds(carrierActor, { requestingUserId });
  if (!parentScene.active) await parentScene.activate().catch(error => {
    console.warn(`${FALLOUT_MAW.id} | Could not activate parent Scene`, error);
  });
  notifyTravelComplete(parentScene.id, viewerUserIds, {
    activateTokenControls: true,
    controlTokenIds: [destinationToken.id]
  });
  for (const [index, target] of eventParticipants.entries()) {
    const related = eventParticipants.filter(entry => entry !== target);
    const data = {
      ...commonData,
      carrierTokenUuid: String(destinationToken.uuid ?? ""),
      actorUuid: target.actorUuid,
      tokenUuid: target.tokenUuid
    };
    await scope.emit("fallout-maw.travel.location.left", { data, outcome: { success: true } }, {
      occurrenceKey: `travel-carrier:${transferId}:location-left:${target.actorUuid || index}`,
      participants: { source: target, target, related }
    });
    await scope.emit("fallout-maw.travel.departure.completed", {
      data,
      outcome: { success: true, completed: true }
    }, {
      occurrenceKey: `travel-carrier:${transferId}:departure-completed:${target.actorUuid || index}`,
      participants: { source: target, target, related }
    });
  }
  return true;
}

async function performDeparture(args) {
  const transferId = String(args.transferId ?? foundry.utils.randomID());
  const request = { ...args, transferId };
  return withSystemEventRoot({
    kind: "travelDeparture",
    operationId: `travel-departure:${transferId}`,
    sceneUuid: String(args.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? "")
  }, scope => performDepartureInRoot(request, scope));
}

async function performDepartureInRoot({
  scene,
  zone,
  tokenDocuments,
  model = null,
  requestingUserId,
  assemblyId = null,
  transferId
}, scope) {
  const sceneFlag = getGlobalMapFlag(scene);
  const parentScene = sceneFlag?.parentSceneId ? game.scenes?.get(sceneFlag.parentSceneId) : null;
  const location = parentScene ? getSceneState(parentScene).locations.find(entry => entry.id === sceneFlag.nodeId) : null;
  if (!parentScene || !location) throw new Error("Родительская карта локации не найдена.");
  const activeModel = model ?? await buildSoloAssemblyModel(scene, tokenDocuments[0]);
  const directParticipants = new Map(activeModel.members.map(member => [
    member.actorUuid,
    systemEventParticipant({ actor: member.actor, token: member.token ?? scene.tokens?.get(member.tokenId) })
  ]));
  const travelActors = await collectTravelActors(activeModel.members);
  const eventParticipants = uniqueActorParticipants(travelActors.map(actor => (
    directParticipants.get(actor.uuid) ?? systemEventParticipant({ actor })
  )));
  for (const [index, target] of eventParticipants.entries()) {
    const gate = await scope.emit("fallout-maw.travel.departure.before", {
      data: {
        originSceneUuid: String(scene.uuid ?? ""),
        targetSceneUuid: String(parentScene.uuid ?? ""),
        locationId: String(location.id ?? ""),
        exitZoneId: String(zone.id ?? ""),
        assemblyId: String(assemblyId ?? ""),
        requestingUserId: String(requestingUserId ?? ""),
        transferId,
        entryMode: normalizeLocationEntryMode(location.entryMode),
        groupPreserved: false,
        direction: "ascend",
        actorUuid: target.actorUuid,
        tokenUuid: target.tokenUuid
      }
    }, {
      occurrenceKey: `travel-departure:${assemblyId || tokenDocuments[0]?.id}:before:${target.actorUuid || index}`,
      participants: { source: target, target, related: eventParticipants.filter(entry => entry !== target) }
    });
    if (isSystemEventCancelled(gate)) return false;
  }
  for (const member of activeModel.members.filter(entry => entry.placement)) {
    validateAssemblyPlacement(activeModel, member, member.placement);
  }
  const vehicleActorUuids = activeModel.vehicles.map(vehicle => vehicle.actor?.uuid).filter(Boolean);
  if (new Set(vehicleActorUuids).size !== vehicleActorUuids.length) {
    throw new Error("Каждый транспорт каравана должен использовать отдельного актёра.");
  }
  const vehiclePlans = await buildVehiclePlans(activeModel, scene);
  let topUnits = buildTopTravelUnits(activeModel);
  if (!topUnits.length) throw new Error("В группе нет участников.");
  const originalTokenData = new Map(tokenDocuments.map(token => [token.id, token.toObject()]));
  let carrierActor = null;
  let carrierToken = null;
  const appliedPlans = [];
  try {
    for (const plan of vehiclePlans.values()) {
      await plan.actor.update({
        ownership: plan.nextOwnership,
        [`flags.${FALLOUT_MAW.id}.${ACTOR_CONTAINER_FLAG}.passengers`]: plan.nextPassengers
      }, travelDocumentOptions(scope, { [TRAVEL_BYPASS_OPTION]: true }));
      appliedPlans.push(plan);
    }
    topUnits = buildTopTravelUnits(activeModel);
    carrierActor = await createTravelCarrier({
      originScene: scene,
      targetScene: parentScene,
      topUnits,
      allActors: travelActors,
      requestingUserId,
      assemblyId,
      transferId,
      chainRef: scope.chainRef
    });
    const prototype = await carrierActor.getTokenDocument({}, { parent: parentScene });
    const carrierData = prototype.toObject();
    delete carrierData._id;
    const position = findFreePlacement(
      parentScene,
      carrierData,
      getLocationCells(parentScene, location),
      [],
      { strictPreferredCells: true }
    );
    carrierData.x = position.x;
    carrierData.y = position.y;
    const group = carrierActor.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG);
    foundry.utils.setProperty(carrierData, `flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}`, {
      version: GLOBAL_MAP_VERSION,
      groupId: group.groupId,
      pendingArrival: null
    });
    [carrierToken] = await parentScene.createEmbeddedDocuments("Token", [carrierData], travelDocumentOptions(scope));
    if (!carrierToken) throw new Error("Не удалось создать токен группы.");
    await scene.deleteEmbeddedDocuments(
      "Token",
      tokenDocuments.map(token => token.id),
      travelDocumentOptions(scope, { [TRAVEL_BYPASS_OPTION]: true })
    );
  } catch (error) {
    if (carrierToken) await parentScene.deleteEmbeddedDocuments(
      "Token",
      [carrierToken.id],
      travelDocumentOptions(scope, { [TRAVEL_BYPASS_OPTION]: true })
    ).catch(() => {});
    for (const plan of appliedPlans.reverse()) {
      await plan.actor.update({
        ownership: plan.originalOwnership,
        [`flags.${FALLOUT_MAW.id}.${ACTOR_CONTAINER_FLAG}.passengers`]: plan.originalPassengers
      }, travelDocumentOptions(scope, { [TRAVEL_BYPASS_OPTION]: true })).catch(() => {});
    }
    const missing = tokenDocuments.filter(token => !scene.tokens?.get(token.id)).map(token => {
      const data = foundry.utils.deepClone(originalTokenData.get(token.id));
      delete data._id;
      return data;
    });
    if (missing.length) await scene.createEmbeddedDocuments("Token", missing, travelDocumentOptions(scope)).catch(() => {});
    if (carrierActor) await carrierActor.delete(travelDocumentOptions(scope, { [TRAVEL_BYPASS_OPTION]: true })).catch(() => {});
    throw error;
  }
  const viewerUserIds = getTravelGroupViewerUserIds(carrierActor);
  if (!parentScene.active) await parentScene.activate();
  notifyTravelComplete(parentScene.id, viewerUserIds);
  const group = carrierActor.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG);
  const groupData = {
    groupId: String(group?.groupId ?? ""),
    assemblyId: String(assemblyId ?? ""),
    originSceneUuid: String(scene.uuid ?? ""),
    targetSceneUuid: String(parentScene.uuid ?? ""),
    locationId: String(location.id ?? ""),
    exitZoneId: String(zone.id ?? ""),
    requestingUserId: String(requestingUserId ?? ""),
    transferId,
    entryMode: normalizeLocationEntryMode(location.entryMode),
    groupPreserved: false,
    direction: "ascend"
  };
  await scope.emit("fallout-maw.travel.group.formed", {
    data: {
      ...groupData,
      carrierActorUuid: String(carrierActor.uuid ?? ""),
      carrierTokenUuid: String(carrierToken?.uuid ?? ""),
      memberActorUuids: eventParticipants.map(entry => entry.actorUuid)
    },
    outcome: { success: true, formed: true }
  }, {
    occurrenceKey: `travel-group:${groupData.groupId}:formed`,
    participants: { source: null, target: null, related: eventParticipants }
  });
  for (const [index, target] of eventParticipants.entries()) {
    const participants = { source: null, target, related: eventParticipants.filter(entry => entry !== target) };
    const data = { ...groupData, actorUuid: target.actorUuid, tokenUuid: target.tokenUuid };
    await scope.emit("fallout-maw.travel.group.memberJoined", { data, outcome: { success: true, joined: true } }, {
      occurrenceKey: `travel-group:${groupData.groupId}:member-joined:${target.actorUuid || index}`,
      participants
    });
    await scope.emit("fallout-maw.travel.location.left", { data, outcome: { success: true } }, {
      occurrenceKey: `travel-group:${groupData.groupId}:location-left:${target.actorUuid || index}`,
      participants: { source: target, target, related: participants.related }
    });
    await scope.emit("fallout-maw.travel.departure.completed", { data, outcome: { success: true, completed: true } }, {
      occurrenceKey: `travel-group:${groupData.groupId}:departure-completed:${target.actorUuid || index}`,
      participants: { source: target, target, related: participants.related }
    });
  }
  return true;
}

async function createTravelCarrier({
  originScene,
  targetScene,
  topUnits,
  allActors,
  requestingUserId,
  assemblyId,
  transferId,
  chainRef = null
}) {
  const folder = await ensureTravelGroupFolder();
  const configuredPrototype = foundry.utils.deepClone(getTravelGroupPrototypeToken());
  const image = getTravelGroupImage();
  const prototypeToken = foundry.utils.mergeObject({
    name: "Путешествие",
    actorLink: true,
    texture: { src: image },
    width: 1,
    height: 1
  }, configuredPrototype, { inplace: false });
  prototypeToken.actorLink = true;
  prototypeToken.name = "Путешествие";
  const memberActors = await collectTravelActors(allActors);
  const ownerUserIds = collectOwnerUserIds(memberActors);
  const ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };
  for (const userId of ownerUserIds) ownership[userId] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const groupId = foundry.utils.randomID();
  const storedUnits = topUnits.map(prepareTravelGroupUnitForStorage);
  const speedKmh = Math.min(...storedUnits.map(unit => unit.speedKmh));
  const actor = await Actor.create({
    name: "Путешествие",
    type: "character",
    img: image,
    folder: folder.id,
    ownership,
    prototypeToken,
    flags: {
      [FALLOUT_MAW.id]: {
        [TRAVEL_GROUP_FLAG]: {
          version: GLOBAL_MAP_VERSION,
          groupId,
          assemblyId,
          originSceneId: originScene.id,
          targetSceneId: targetScene.id,
          requestingUserId,
          ownerUserIds,
          effectiveSpeedKmh: Number.isFinite(speedKmh) ? speedKmh : 0,
          memberActorUuids: memberActors.map(actor => actor?.uuid).filter(Boolean),
          units: storedUnits,
          currentSceneId: targetScene.id,
          currentNodeId: String(getGlobalMapFlag(targetScene)?.nodeId ?? ""),
          lastTransferId: String(transferId ?? ""),
          createdAt: Date.now()
        }
      }
    }
  }, {
    renderSheet: false,
    [TRAVEL_BYPASS_OPTION]: true,
    falloutMawSystemEventChainRef: chainRef,
    chainRef
  });
  if (!actor) throw new Error("Не удалось создать временного актёра группы.");
  return actor;
}

async function handleCarrierMovePassengerRequest(payload) {
  const carrierActor = game.actors?.get(payload.carrierActorId);
  const user = game.users?.get(payload.requestingUserId);
  const group = foundry.utils.deepClone(carrierActor?.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG) ?? null);
  if (!carrierActor || !group?.groupId || !user) throw new Error("Группа путешествия не найдена.");
  if (!user.isGM && !carrierActor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
    throw new Error("Нет прав на изменение состава путешествия.");
  }
  const units = Array.isArray(group.units) ? group.units : [];
  const unit = units.find(entry => String(entry?.id ?? "") === String(payload.unitId ?? ""));
  const snapshot = normalizeTravelGroupActorContainerSnapshot(unit?.actorContainer);
  if (!unit || !snapshot) throw new Error("Транспорт путешествия не найден.");
  const passengers = moveActorContainerPassengerData(
    snapshot.seats,
    snapshot.passengers,
    String(payload.passengerId ?? ""),
    payload.target ?? {}
  );
  if (!passengers) throw new Error("Пассажир не помещается в выбранную область.");

  unit.actorContainer = { seats: snapshot.seats, passengers };
  if (unit.tokenData?.actorLink) {
    const vehicleActor = game.actors?.get(unit.tokenData.actorId);
    if (!vehicleActor) throw new Error("Связанный транспорт не найден.");
    await vehicleActor.update({
      [`flags.${FALLOUT_MAW.id}.${ACTOR_CONTAINER_FLAG}.passengers`]: passengers
    }, { [TRAVEL_BYPASS_OPTION]: true });
  } else {
    unit.tokenData.delta ??= {};
    unit.tokenData.delta.flags ??= {};
    foundry.utils.setProperty(
      unit,
      `tokenData.delta.flags.${FALLOUT_MAW.id}.${ACTOR_CONTAINER_FLAG}.passengers`,
      foundry.utils.deepClone(passengers)
    );
  }
  await carrierActor.update({
    [`flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_FLAG}.units`]: units
  }, { [TRAVEL_BYPASS_OPTION]: true });
  return true;
}

async function performArrival(originScene, carrierToken, targetScene, zone, pending) {
  const attemptId = foundry.utils.randomID();
  const request = {
    ...pending,
    transferId: String(pending?.transferId ?? foundry.utils.randomID()),
    entryMode: normalizeLocationEntryMode(pending?.entryMode),
    direction: "descend"
  };
  request.groupPreserved = request.entryMode === LOCATION_ENTRY_MODES.CARRIER;
  return withSystemEventRoot({
    kind: "travelArrival",
    operationId: `travel-arrival:${request.transferId}:${attemptId}`,
    sceneUuid: String(originScene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? "")
  }, scope => request.entryMode === LOCATION_ENTRY_MODES.CARRIER
    ? performCarrierArrivalInRoot(originScene, carrierToken, targetScene, zone, request, scope)
    : performDeployArrivalInRoot(originScene, carrierToken, targetScene, zone, request, scope));
}

async function performDeployArrivalInRoot(originScene, carrierToken, targetScene, zone, pending, scope) {
  const carrierActor = game.actors?.get(carrierToken.actorId) ?? carrierToken.actor;
  const viewerUserIds = getTravelGroupViewerUserIds(carrierActor, { requestingUserId: pending?.requestedByUserId });
  const units = getTravelCarrierUnits(carrierActor);
  if (!units.length) throw new Error("В группе нет участников для размещения.");
  const eventParticipants = await collectTravelGroupEventParticipants(carrierActor);
  for (const [index, target] of eventParticipants.entries()) {
    const gate = await scope.emit("fallout-maw.travel.arrival.before", {
      data: {
        groupId: String(pending?.groupId ?? ""),
        transferId: String(pending?.transferId ?? ""),
        entryMode: LOCATION_ENTRY_MODES.DEPLOY,
        groupPreserved: false,
        direction: "descend",
        locationId: String(pending?.locationId ?? ""),
        originSceneUuid: String(originScene.uuid ?? ""),
        targetSceneUuid: String(targetScene.uuid ?? ""),
        exitZoneId: String(zone.id ?? ""),
        actorUuid: target.actorUuid,
        requestedByUserId: String(pending?.requestedByUserId ?? "")
      }
    }, {
      occurrenceKey: `travel-arrival:${pending?.transferId}:before:${target.actorUuid || index}`,
      participants: { source: target, target, related: eventParticipants.filter(entry => entry !== target) }
    });
    if (isSystemEventCancelled(gate)) return false;
  }
  const createData = [];
  const reserved = [];
  for (const unit of units) {
    if (!unit.tokenData) continue;
    const data = foundry.utils.deepClone(unit.tokenData);
    delete data._id;
    delete data.id;
    data.hidden = false;
    const position = findFreePlacement(targetScene, data, zone.cells.map(parseCellKey).filter(Boolean), reserved);
    data.x = position.x;
    data.y = position.y;
    reserved.push(tokenRect(targetScene, data));
    createData.push(data);
  }
  let created = [];
  try {
    created = await targetScene.createEmbeddedDocuments("Token", createData, travelDocumentOptions(scope));
    if (created.length !== createData.length) throw new Error("Не все участники были размещены.");
    await originScene.deleteEmbeddedDocuments(
      "Token",
      [carrierToken.id],
      travelDocumentOptions(scope, { [TRAVEL_BYPASS_OPTION]: true })
    );
  } catch (error) {
    if (created.length) await targetScene.deleteEmbeddedDocuments(
      "Token",
      created.map(token => token.id),
      travelDocumentOptions(scope)
    ).catch(() => {});
    throw error;
  }
  await carrierActor.delete(travelDocumentOptions(scope, { [TRAVEL_BYPASS_OPTION]: true })).catch(error => {
    console.warn(`${FALLOUT_MAW.id} | Travel-group carrier actor cleanup failed`, error);
  });
  const exitWasDiscovered = getSceneState(targetScene).discoveredExitZoneIds.includes(zone.id);
  clearArrivalTimer(originScene.id, carrierToken.id);
  const closedPayload = {
    action: "travelGroup.arrival.closed",
    groupId: pending.groupId,
    transferId: pending.transferId,
    targetSceneId: targetScene.id,
    viewerUserIds,
    controlTokenIds: created.map(token => token.id)
  };
  game.socket.emit(GLOBAL_MAP_SOCKET, closedPayload);
  if (!targetScene.active) await targetScene.activate().catch(error => {
    console.warn(`${FALLOUT_MAW.id} | Could not activate arrival Scene`, error);
  });
  await restoreTokenControlsAfterArrival(closedPayload);
  notifyTravelComplete(targetScene.id, viewerUserIds, {
    activateTokenControls: true,
    controlTokenIds: created.map(token => token.id)
  });
  let exitDiscoveryStored = exitWasDiscovered;
  if (!exitWasDiscovered) {
    exitDiscoveryStored = await setDiscovered(targetScene, "exit", zone.id, true)
      .then(() => true)
      .catch(error => {
        console.warn(`${FALLOUT_MAW.id} | Could not store arrival-zone discovery`, error);
        return false;
      });
  }
  const commonData = {
    groupId: String(pending?.groupId ?? ""),
    transferId: String(pending?.transferId ?? ""),
    entryMode: LOCATION_ENTRY_MODES.DEPLOY,
    groupPreserved: false,
    direction: "descend",
    locationId: String(pending?.locationId ?? ""),
    originSceneUuid: String(originScene.uuid ?? ""),
    targetSceneUuid: String(targetScene.uuid ?? ""),
    exitZoneId: String(zone.id ?? ""),
    requestedByUserId: String(pending?.requestedByUserId ?? "")
  };
  if (!exitWasDiscovered && exitDiscoveryStored) {
    await scope.emit("fallout-maw.globalMap.exit.discovered", {
      data: {
        sceneUuid: String(targetScene.uuid ?? ""),
        sceneId: String(targetScene.id ?? ""),
        discoveryType: "exit",
        entryId: String(zone.id ?? ""),
        entryName: String(zone.name ?? "")
      }
    }, {
      occurrenceKey: `global-map-discovery:${targetScene.id}:exit:${zone.id}`,
      participants: { source: null, target: null, related: eventParticipants }
    });
  }
  for (const [index, target] of eventParticipants.entries()) {
    const related = eventParticipants.filter(entry => entry !== target);
    const data = { ...commonData, actorUuid: target.actorUuid };
    await scope.emit("fallout-maw.travel.group.memberLeft", { data, outcome: { success: true, left: true } }, {
      occurrenceKey: `travel-group:${commonData.groupId}:${commonData.transferId}:member-left:${target.actorUuid || index}`,
      participants: { source: target, target, related }
    });
    await scope.emit("fallout-maw.travel.location.entered", { data, outcome: { success: true } }, {
      occurrenceKey: `travel-group:${commonData.groupId}:${commonData.transferId}:location-entered:${target.actorUuid || index}`,
      participants: { source: target, target, related }
    });
    await scope.emit("fallout-maw.travel.arrival.completed", { data, outcome: { success: true, completed: true } }, {
      occurrenceKey: `travel-group:${commonData.groupId}:${commonData.transferId}:arrival-completed:${target.actorUuid || index}`,
      participants: { source: target, target, related }
    });
  }
  await scope.emit("fallout-maw.travel.group.disbanded", {
    data: { ...commonData, memberActorUuids: eventParticipants.map(entry => entry.actorUuid) },
    outcome: { success: true, disbanded: true }
  }, {
    occurrenceKey: `travel-group:${commonData.groupId}:${commonData.transferId}:disbanded`,
    participants: { source: null, target: null, related: eventParticipants }
  });
  return true;
}

async function performCarrierArrivalInRoot(originScene, carrierToken, targetScene, zone, pending, scope) {
  const carrierActor = game.actors?.get(carrierToken.actorId) ?? carrierToken.actor;
  const group = getTravelGroupData(carrierActor);
  if (!group?.groupId) throw new Error("Носитель путешествующей группы не найден.");
  if (!getTravelCarrierUnits(carrierActor).length) throw new Error("В группе нет участников для переноса.");
  const viewerUserIds = getTravelGroupViewerUserIds(carrierActor, {
    requestingUserId: pending?.requestedByUserId
  });
  const eventParticipants = await collectTravelGroupEventParticipants(carrierActor);
  const commonData = {
    groupId: String(pending?.groupId ?? group.groupId),
    transferId: String(pending?.transferId ?? ""),
    entryMode: LOCATION_ENTRY_MODES.CARRIER,
    groupPreserved: true,
    direction: "descend",
    locationId: String(pending?.locationId ?? ""),
    originSceneUuid: String(originScene.uuid ?? ""),
    targetSceneUuid: String(targetScene.uuid ?? ""),
    exitZoneId: String(zone.id ?? ""),
    requestedByUserId: String(pending?.requestedByUserId ?? ""),
    carrierActorUuid: String(carrierActor.uuid ?? ""),
    carrierTokenUuid: String(carrierToken.uuid ?? "")
  };
  for (const [index, target] of eventParticipants.entries()) {
    const gate = await scope.emit("fallout-maw.travel.arrival.before", {
      data: { ...commonData, actorUuid: target.actorUuid, tokenUuid: target.tokenUuid }
    }, {
      occurrenceKey: `travel-carrier:${pending.transferId}:arrival-before:${target.actorUuid || index}`,
      participants: { source: target, target, related: eventParticipants.filter(entry => entry !== target) }
    });
    if (isSystemEventCancelled(gate)) return false;
  }

  const destinationUpdate = {};
  const position = findFreePlacement(
    targetScene,
    carrierToken.toObject(),
    zone.cells,
    [],
    { strictPreferredCells: true }
  );
  destinationUpdate.x = position.x;
  destinationUpdate.y = position.y;
  foundry.utils.setProperty(
    destinationUpdate,
    `flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}.pendingArrival`,
    null
  );
  const transfer = await transferTokensBetweenScenes({
    originScene,
    targetScene,
    tokenDocuments: [carrierToken],
    destinationUpdates: [destinationUpdate],
    actorUpdates: [buildTravelGroupRouteUpdate(carrierActor, targetScene, pending.transferId)],
    operationOptions: travelDocumentOptions(scope, { [TRAVEL_BYPASS_OPTION]: true })
  });
  const destinationToken = transfer.tokenMap.get(carrierToken) ?? transfer.transfers[0]?.destinationToken;
  if (!destinationToken) throw new Error("Носитель группы не был создан на подкарте.");

  const exitWasDiscovered = getSceneState(targetScene).discoveredExitZoneIds.includes(zone.id);
  clearArrivalTimer(originScene.id, carrierToken.id);
  const closedPayload = {
    action: "travelGroup.arrival.closed",
    groupId: pending.groupId,
    transferId: pending.transferId,
    targetSceneId: targetScene.id,
    viewerUserIds,
    carrierTokenId: destinationToken.id,
    controlTokenIds: [destinationToken.id]
  };
  game.socket.emit(GLOBAL_MAP_SOCKET, closedPayload);
  if (!targetScene.active) await targetScene.activate().catch(error => {
    console.warn(`${FALLOUT_MAW.id} | Could not activate arrival Scene`, error);
  });
  await restoreTokenControlsAfterArrival(closedPayload);
  notifyTravelComplete(targetScene.id, viewerUserIds, {
    activateTokenControls: true,
    controlTokenIds: [destinationToken.id]
  });
  let exitDiscoveryStored = exitWasDiscovered;
  if (!exitWasDiscovered) {
    exitDiscoveryStored = await setDiscovered(targetScene, "exit", zone.id, true)
      .then(() => true)
      .catch(error => {
        console.warn(`${FALLOUT_MAW.id} | Could not store arrival-zone discovery`, error);
        return false;
      });
  }

  if (!exitWasDiscovered && exitDiscoveryStored) {
    await scope.emit("fallout-maw.globalMap.exit.discovered", {
      data: {
        sceneUuid: String(targetScene.uuid ?? ""),
        sceneId: String(targetScene.id ?? ""),
        discoveryType: "exit",
        entryId: String(zone.id ?? ""),
        entryName: String(zone.name ?? "")
      }
    }, {
      occurrenceKey: `global-map-discovery:${targetScene.id}:exit:${zone.id}`,
      participants: { source: null, target: null, related: eventParticipants }
    });
  }
  for (const [index, target] of eventParticipants.entries()) {
    const related = eventParticipants.filter(entry => entry !== target);
    const data = {
      ...commonData,
      carrierTokenUuid: String(destinationToken.uuid ?? ""),
      actorUuid: target.actorUuid,
      tokenUuid: target.tokenUuid
    };
    await scope.emit("fallout-maw.travel.location.entered", { data, outcome: { success: true } }, {
      occurrenceKey: `travel-carrier:${pending.transferId}:location-entered:${target.actorUuid || index}`,
      participants: { source: target, target, related }
    });
    await scope.emit("fallout-maw.travel.arrival.completed", {
      data,
      outcome: { success: true, completed: true }
    }, {
      occurrenceKey: `travel-carrier:${pending.transferId}:arrival-completed:${target.actorUuid || index}`,
      participants: { source: target, target, related }
    });
  }
  return true;
}

function prepareTravelGroupUnitForStorage(unit) {
  const travelFormulaData = createTravelFormulaSnapshot(unit.actor);
  const speedKmh = evaluateTravelSpeed(unit.actor, travelFormulaData);
  return {
    id: foundry.utils.randomID(),
    actorUuid: String(unit.actorUuid ?? ""),
    actorName: String(unit.name ?? ""),
    actorImg: String(unit.img ?? ""),
    tokenData: foundry.utils.deepClone(unit.tokenData ?? null),
    actorContainer: prepareTravelGroupActorContainerSnapshot(unit.actor),
    travelFormulaData,
    speedKmh,
    width: Math.max(1, Math.ceil(Number(unit.width) || 1)),
    height: Math.max(1, Math.ceil(Number(unit.height) || 1))
  };
}

function prepareTravelGroupActorContainerSnapshot(actor = null) {
  const seats = getActorContainerSeatDefinitions(actor);
  const passengers = getActorContainerFlag(actor).passengers;
  if (!seats.length && !passengers.length) return null;
  return {
    seats: foundry.utils.deepClone(seats),
    passengers: foundry.utils.deepClone(passengers)
  };
}

function getTravelCarrierUnits(actor = null) {
  const group = actor?.getFlag?.(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG) ?? {};
  const units = normalizeTravelCarrierUnits(group.units);
  if (units.length) return units;
  return normalizeTravelCarrierUnits(getActorContainerFlag(actor).passengers);
}

function getValidArrivalZones(targetScene, carrierToken, pending = {}) {
  if (!targetScene || !carrierToken) return [];
  const entryMode = normalizeLocationEntryMode(pending.entryMode);
  const units = carrierToken.actor ? getTravelCarrierUnits(carrierToken.actor) : [];
  const allowedZoneIds = Array.isArray(pending.validExitZoneIds) && pending.validExitZoneIds.length
    ? new Set(pending.validExitZoneIds.map(String))
    : null;
  return getSceneState(targetScene).locationExitZones
    .filter(zone => zone.cells?.length)
    .filter(zone => !allowedZoneIds || allowedZoneIds.has(String(zone.id)))
    .filter(zone => entryMode === LOCATION_ENTRY_MODES.CARRIER
      ? canPlaceTravelCarrier(targetScene, zone, carrierToken)
      : canPlaceTravelPassengers(targetScene, zone, units));
}

async function collectTravelGroupEventParticipants(carrierActor) {
  const references = await resolveTravelGroupParticipants(carrierActor);
  return uniqueActorParticipants(references.map(({ actor, actorUuid }) => (
    actor ? systemEventParticipant({ actor }) : { actorUuid }
  )));
}

function normalizeTravelCarrierUnits(units = []) {
  return (Array.isArray(units) ? units : [])
    .map(unit => ({
      id: String(unit?.id ?? unit?.actorUuid ?? foundry.utils.randomID()),
      actorUuid: String(unit?.actorUuid ?? ""),
      actorName: String(unit?.actorName ?? unit?.name ?? ""),
      actorImg: String(unit?.actorImg ?? unit?.img ?? ""),
      tokenData: unit?.tokenData && typeof unit.tokenData === "object"
        ? foundry.utils.deepClone(unit.tokenData)
        : null,
      actorContainer: normalizeTravelGroupActorContainerSnapshot(unit?.actorContainer),
      width: Math.max(1, Math.ceil(Number(unit?.width) || 1)),
      height: Math.max(1, Math.ceil(Number(unit?.height) || 1))
    }))
    .filter(unit => unit.actorUuid && unit.tokenData);
}

function normalizeTravelGroupActorContainerSnapshot(value = null) {
  if (!value || typeof value !== "object") return null;
  const seats = Array.isArray(value.seats) ? foundry.utils.deepClone(value.seats) : [];
  const passengers = Array.isArray(value.passengers) ? foundry.utils.deepClone(value.passengers) : [];
  return seats.length || passengers.length ? { seats, passengers } : null;
}

async function buildSoloAssemblyModel(scene, token) {
  const assembly = {
    id: "",
    memberTokenIds: [token.id],
    leaderMemberId: tokenMemberId(token.id),
    readyMemberIds: [],
    placements: {}
  };
  return buildAssemblyModel(scene, assembly);
}

async function buildVehiclePlans(model, scene) {
  const plans = new Map(model.vehicles.map(vehicle => [vehicle.tokenId, {
    vehicle,
    actor: vehicle.actor,
    originalPassengers: foundry.utils.deepClone(getActorContainerFlag(vehicle.actor).passengers),
    originalOwnership: foundry.utils.deepClone(vehicle.actor.ownership ?? {}),
    nextPassengers: [],
    nextOwnership: foundry.utils.deepClone(vehicle.actor.ownership ?? {}),
    pendingMembers: []
  }]));
  for (const member of model.members.filter(entry => !entry.vehicle && entry.placement)) {
    const plan = plans.get(member.placement.vehicleTokenId);
    if (!plan) throw new Error(`${member.name}: выбранный транспорт недоступен.`);
    const staysInSource = member.sourceVehicleTokenId === plan.vehicle.tokenId && member.sourcePassenger;
    if (staysInSource) {
      plan.nextPassengers.push({
        ...foundry.utils.deepClone(member.sourcePassenger),
        slotId: member.placement.slotId,
        slotIndex: member.placement.slotIndex,
        x: member.placement.x,
        y: member.placement.y,
        width: member.width,
        height: member.height
      });
    } else {
      plan.pendingMembers.push(member);
    }
  }
  for (const plan of plans.values()) {
    reconcileRemovedPassengerOwnership(plan);
    for (const member of plan.pendingMembers) {
      plan.nextPassengers.push(buildPassengerForVehicle(plan, member, scene));
    }
    delete plan.pendingMembers;
  }
  return plans;
}

function reconcileRemovedPassengerOwnership(plan) {
  const activeTemporaryUsers = new Set(plan.nextPassengers.flatMap(passenger => passenger.temporaryOwnerUserIds ?? []));
  const originalSources = new Map();
  for (const passenger of plan.originalPassengers) {
    for (const userId of passenger.temporaryOwnerUserIds ?? []) {
      const current = originalSources.get(userId);
      const hasLevel = Object.hasOwn(passenger.temporaryOwnerLevels ?? {}, userId);
      const currentHasLevel = Object.hasOwn(current?.temporaryOwnerLevels ?? {}, userId);
      if (!current || (hasLevel && !currentHasLevel)) originalSources.set(userId, passenger);
    }
  }
  for (const [userId, source] of originalSources) {
    if (activeTemporaryUsers.has(userId)) continue;
    if (Object.hasOwn(source.temporaryOwnerLevels ?? {}, userId)) {
      plan.nextOwnership[userId] = source.temporaryOwnerLevels[userId];
    } else {
      delete plan.nextOwnership[userId];
    }
  }
}

function buildPassengerForVehicle(plan, member, scene) {
  const temporaryOwnerUserIds = [];
  const temporaryOwnerLevels = {};
  for (const user of game.users?.contents ?? []) {
    if (user.isGM || !member.actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) continue;
    const current = plan.nextOwnership[user.id]
      ?? plan.nextOwnership.default
      ?? plan.actor.getUserLevel?.(user)
      ?? 0;
    if (current >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
      const temporarySource = findTemporaryOwnershipSource(plan.nextPassengers, user.id);
      if (!temporarySource) continue;
      temporaryOwnerUserIds.push(user.id);
      if (Object.hasOwn(temporarySource.temporaryOwnerLevels ?? {}, user.id)) {
        temporaryOwnerLevels[user.id] = temporarySource.temporaryOwnerLevels[user.id];
      }
      continue;
    }
    temporaryOwnerUserIds.push(user.id);
    if (Object.hasOwn(plan.nextOwnership, user.id)) temporaryOwnerLevels[user.id] = plan.nextOwnership[user.id];
    plan.nextOwnership[user.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  }
  return {
    id: foundry.utils.randomID(),
    actorUuid: member.actorUuid,
    actorName: member.name,
    actorImg: member.img,
    sceneId: scene.id,
    tokenData: foundry.utils.deepClone(member.tokenData),
    slotId: member.placement.slotId,
    slotIndex: member.placement.slotIndex,
    x: member.placement.x,
    y: member.placement.y,
    width: member.width,
    height: member.height,
    temporaryOwnerUserIds,
    temporaryOwnerLevels
  };
}

function findTemporaryOwnershipSource(passengers, userId) {
  const sources = (passengers ?? []).filter(passenger => passenger.temporaryOwnerUserIds?.includes(userId));
  return sources.find(passenger => Object.hasOwn(passenger.temporaryOwnerLevels ?? {}, userId)) ?? sources[0] ?? null;
}

function buildTopTravelUnits(model) {
  const units = [];
  for (const member of model.members) {
    if (member.vehicle || (!member.vehicle && !member.placement)) {
      const tokenData = member.tokenId
        ? model.scene?.tokens?.get(member.tokenId)?.toObject?.() ?? member.tokenData
        : member.tokenData;
      if (!member.actor || !member.tokenData) throw new Error(`${member.name}: отсутствуют данные для путешествия.`);
      units.push({
        actor: member.actor,
        actorUuid: member.actorUuid,
        name: member.name,
        img: member.img,
        tokenData: foundry.utils.deepClone(tokenData),
        width: member.width,
        height: member.height
      });
    }
  }
  return units;
}

function findFreePlacement(scene, tokenData, preferredCells = [], reserved = [], { strictPreferredCells = false } = {}) {
  const bounds = getPlacementBounds(scene);
  const source = preferredCells
    .map(cell => typeof cell === "string" ? parseCellKey(cell) : cell)
    .filter(cell => Number.isFinite(cell?.i) && Number.isFinite(cell?.j));
  if (!source.length) {
    if (strictPreferredCells) throw new Error("В выбранной области нет клеток для размещения группы.");
    source.push(scene.grid.getOffset({
      x: Number(scene.width) / 2,
      y: Number(scene.height) / 2
    }));
  }
  const allowedCellKeys = strictPreferredCells ? new Set(source.map(cellKey)) : null;

  const occupied = [
    ...(scene.tokens?.contents ?? []).map(token => tokenRect(scene, token)),
    ...reserved
  ];

  const previewData = foundry.utils.deepClone(tokenData);
  delete previewData._id;
  delete previewData.id;
  const token = new CONFIG.Token.documentClass(previewData, { parent: scene });
  const dimensions = {
    width: token.width,
    height: token.height,
    shape: token.shape,
    elevation: token.elevation
  };
  const pivot = token.getCenterPoint({ x: 0, y: 0, ...dimensions });
  const size = token.getSize(dimensions);

  const queue = [];
  const visited = new Set();
  const enqueue = cell => {
    if (!isCellCenterInsidePlacementBounds(scene, cell, bounds)) return;
    const key = cellKey(cell);
    if (visited.has(key)) return;
    visited.add(key);
    queue.push(cell);
  };
  for (const cell of source) enqueue(cell);

  for (let index = 0; index < queue.length; index += 1) {
    const cell = queue[index];
    const center = scene.grid.getCenterPoint(cell);
    const position = token.getSnappedPosition({
      x: center.x - pivot.x,
      y: center.y - pivot.y,
      ...dimensions
    });
    const rect = {
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height
    };
    const footprintInsidePreferred = !allowedCellKeys || token.getOccupiedGridSpaceOffsets({
      x: position.x,
      y: position.y,
      ...dimensions
    }).every(offset => allowedCellKeys.has(cellKey(offset)));
    if (footprintInsidePreferred
      && !occupied.some(other => rectanglesOverlap(rect, other))
      && rectInsidePlacementBounds(rect, bounds)) return position;
    if (!strictPreferredCells) {
      for (const adjacent of scene.grid.getAdjacentOffsets(cell)) enqueue(adjacent);
    }
  }
  throw new Error("На сцене нет свободного места для размещения группы.");
}

function getPlacementBounds(scene) {
  return scene.getDimensions?.().rect ?? new PIXI.Rectangle(0, 0, scene.width, scene.height);
}

function isCellCenterInsidePlacementBounds(scene, cell, bounds) {
  const center = scene.grid.getCenterPoint(cell);
  return Number.isFinite(center?.x)
    && Number.isFinite(center?.y)
    && bounds.contains(center.x, center.y);
}

function tokenRect(scene, token) {
  const document = typeof token?.getSize === "function"
    ? token
    : new CONFIG.Token.documentClass(token, { parent: scene });
  const size = document.getSize(token);
  return {
    x: Number(token.x) || 0,
    y: Number(token.y) || 0,
    width: size.width,
    height: size.height
  };
}

function rectanglesOverlap(left, right) {
  return !(left.x + left.width <= right.x || right.x + right.width <= left.x
    || left.y + left.height <= right.y || right.y + right.height <= left.y);
}

function rectInsidePlacementBounds(rect, bounds) {
  return rect.x >= bounds.x
    && rect.y >= bounds.y
    && rect.x + rect.width <= bounds.x + bounds.width
    && rect.y + rect.height <= bounds.y + bounds.height;
}

async function ensureTravelGroupFolder() {
  const existing = game.folders?.find(folder => folder.type === "Actor" && folder.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FOLDER_FLAG)?.role === "travelGroups");
  if (existing) return existing;
  return Folder.create({
    name: "Путешествие",
    type: "Actor",
    flags: { [FALLOUT_MAW.id]: { [TRAVEL_GROUP_FOLDER_FLAG]: { version: GLOBAL_MAP_VERSION, role: "travelGroups" } } }
  });
}

function validateExitParticipant(scene, zone, token, user) {
  if (!scene || !zone || !token?.actor || !user) throw new Error("Участник или зона выхода не найдена.");
  if (!user.isGM && !token.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) throw new Error("Нет прав на участника.");
  const key = cellKey(pointToCell(scene, tokenCenter(token, scene)));
  if (!zone.cells.includes(key)) throw new Error("Участник больше не находится в зоне выхода.");
}

function getAssemblyRequestContext(payload) {
  const scene = game.scenes?.get(payload.sceneId);
  const assembly = getAssembly(scene, payload.assemblyId);
  const user = game.users?.get(payload.requestingUserId);
  if (!scene || !assembly || !user) throw new Error("Сбор группы не найден.");
  return { scene, assembly, user };
}

async function buildAssemblyModel(scene, assembly) {
  const members = [];
  const vehicles = [];
  const membersById = new Map();
  const placements = assembly.placements ?? {};
  for (const tokenId of assembly.memberTokenIds ?? []) {
    const token = scene.tokens?.get(tokenId);
    const actor = token?.actor ?? null;
    const vehicle = Boolean(actor && hasActorContainer(actor));
    const member = {
      id: tokenMemberId(tokenId),
      tokenId,
      actor,
      actorUuid: actor?.uuid ?? "",
      name: actor?.name || token?.name || "Недоступный участник",
      img: token?.texture?.src || actor?.img || "icons/svg/mystery-man.svg",
      missing: !token || !actor,
      vehicle,
      topLevel: true,
      sourceVehicleTokenId: null,
      sourcePassengerId: null,
      tokenData: token?.toObject?.() ?? null,
      width: Math.max(1, Math.ceil(Number(token?.width) || 1)),
      height: Math.max(1, Math.ceil(Number(token?.height) || 1)),
      placement: null
    };
    members.push(member);
    membersById.set(member.id, member);
    if (!vehicle || !actor) continue;
    const vehicleEntry = {
      memberId: member.id,
      tokenId,
      actor,
      name: member.name,
      img: member.img,
      seats: getActorContainerSeatDefinitions(actor)
    };
    vehicles.push(vehicleEntry);
    for (const passenger of getActorContainerFlag(actor).passengers) {
      const passengerActor = await globalThis.fromUuid?.(passenger.actorUuid)
        ?? (passenger.tokenData?.actorId ? game.actors?.get(passenger.tokenData.actorId) : null);
      const passengerId = passengerMemberId(tokenId, passenger.id);
      const defaultPlacement = {
        vehicleTokenId: tokenId,
        slotId: passenger.slotId,
        slotIndex: passenger.slotIndex,
        x: passenger.x,
        y: passenger.y
      };
      const placement = Object.hasOwn(placements, passengerId)
        ? normalizeAssemblyPlacement(placements[passengerId])
        : defaultPlacement;
      const passengerMember = {
        id: passengerId,
        tokenId: null,
        actor: passengerActor,
        actorUuid: passenger.actorUuid,
        name: passenger.actorName || passengerActor?.name || passenger.actorUuid,
        img: passenger.actorImg || passengerActor?.img || "icons/svg/mystery-man.svg",
        missing: !passengerActor || !passenger.tokenData,
        vehicle: false,
        topLevel: false,
        sourceVehicleTokenId: tokenId,
        sourcePassengerId: passenger.id,
        sourcePassenger: foundry.utils.deepClone(passenger),
        tokenData: foundry.utils.deepClone(passenger.tokenData),
        width: Math.max(1, Number(passenger.width) || 1),
        height: Math.max(1, Number(passenger.height) || 1),
        placement
      };
      members.push(passengerMember);
      membersById.set(passengerMember.id, passengerMember);
    }
  }
  for (const member of members.filter(entry => !entry.vehicle && entry.topLevel)) {
    member.placement = Object.hasOwn(placements, member.id)
      ? normalizeAssemblyPlacement(placements[member.id])
      : null;
  }
  const readyMemberIds = new Set(
    assembly.readyMemberIds?.length
      ? assembly.readyMemberIds
      : (assembly.readyTokenIds ?? []).map(tokenMemberId)
  );
  for (const id of readyMemberIds) {
    if (!memberRequiresReady(membersById.get(id))) readyMemberIds.delete(id);
  }
  const leaderMemberId = membersById.has(assembly.leaderMemberId)
    ? assembly.leaderMemberId
    : members.find(member => member.id === tokenMemberId(assembly.memberTokenIds?.[0]))?.id ?? members[0]?.id ?? "";
  return { scene, assembly, members, membersById, vehicles, readyMemberIds, leaderMemberId };
}

function memberRequiresReady(member) {
  return Boolean(member && !member.vehicle);
}

function buildVehicleSeatGroups(vehicle, members) {
  const groups = new Map();
  for (const seat of vehicle.seats) {
    let group = groups.get(seat.itemId);
    if (!group) {
      group = { id: seat.itemId, name: seat.itemName, rows: [] };
      groups.set(seat.itemId, group);
    }
    const instances = [];
    for (let slotIndex = 0; slotIndex < seat.quantity; slotIndex += 1) {
      const occupants = members
        .filter(member => member.placement?.vehicleTokenId === vehicle.tokenId
          && member.placement?.slotId === seat.slotId
          && Number(member.placement?.slotIndex) === slotIndex)
        .map(member => ({
          ...member,
          gridStyle: [
            `grid-column: ${member.placement.x} / span ${member.width};`,
            `grid-row: ${member.placement.y} / span ${member.height};`
          ].join(" ")
        }));
      instances.push({
        id: `${seat.slotId}:${slotIndex}`,
        slotId: seat.slotId,
        slotIndex,
        columns: seat.width,
        rows: seat.height,
        style: buildInventoryGridStyle(seat.width, seat.height),
        occupants
      });
    }
    group.rows.push({ id: seat.slotId, instances });
  }
  return Array.from(groups.values());
}

function normalizeAssemblyPlacement(value) {
  if (!value || typeof value !== "object") return null;
  const vehicleTokenId = String(value.vehicleTokenId ?? "").trim();
  const slotId = String(value.slotId ?? "").trim();
  const slotIndex = Math.max(0, Math.trunc(Number(value.slotIndex) || 0));
  const x = Math.max(1, Math.trunc(Number(value.x) || 1));
  const y = Math.max(1, Math.trunc(Number(value.y) || 1));
  return vehicleTokenId && slotId ? { vehicleTokenId, slotId, slotIndex, x, y } : null;
}

function validateAssemblyPlacement(model, member, placement) {
  const vehicle = model.vehicles.find(entry => entry.tokenId === placement.vehicleTokenId);
  if (!vehicle) throw new Error("Транспорт не входит в этот сбор.");
  const seat = vehicle.seats.find(entry => entry.slotId === placement.slotId);
  if (!seat || placement.slotIndex >= seat.quantity) throw new Error("Выбранное место транспорта не найдено.");
  if (placement.x + member.width - 1 > seat.width || placement.y + member.height - 1 > seat.height) {
    throw new Error("Актёр не помещается в выбранные клетки.");
  }
  const candidate = {
    x: placement.x,
    y: placement.y,
    width: member.width,
    height: member.height
  };
  const collision = model.members.some(other =>
    other.id !== member.id
    && other.placement?.vehicleTokenId === placement.vehicleTokenId
    && other.placement?.slotId === placement.slotId
    && Number(other.placement?.slotIndex) === placement.slotIndex
    && rectanglesOverlap(candidate, {
      x: other.placement.x,
      y: other.placement.y,
      width: other.width,
      height: other.height
    })
  );
  if (collision) throw new Error("Выбранные клетки уже заняты.");
}

function canUserManageAssembly(scene, assembly, user, model) {
  if (user?.isGM) return true;
  const leader = model.membersById.get(model.leaderMemberId);
  return Boolean(user?.active && leader?.actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
}

function requireAssemblyManager(scene, assembly, user, model) {
  if (!canUserManageAssembly(scene, assembly, user, model)) {
    throw new Error("Управлять сбором может только владелец актёра-лидера или GM.");
  }
}

function tokenMemberId(tokenId) {
  return `token:${tokenId}`;
}

function passengerMemberId(vehicleTokenId, passengerId) {
  return `passenger:${vehicleTokenId}:${passengerId}`;
}

function getTravelAssemblyDragData(event) {
  for (const type of ["application/json", "text/plain"]) {
    try {
      const raw = event.dataTransfer?.getData(type);
      if (raw) return JSON.parse(raw);
    } catch (_error) {
      // Continue with the next payload.
    }
  }
  return {};
}

function getAssembly(scene, assemblyId) {
  return getSceneState(scene).travelAssemblies.find(entry => entry.id === assemblyId) ?? null;
}

async function storeAssembly(scene, assembly) {
  await updateSceneState(scene, state => {
    const index = state.travelAssemblies.findIndex(entry => entry.id === assembly.id);
    if (index >= 0) state.travelAssemblies[index] = foundry.utils.deepClone(assembly);
    else state.travelAssemblies.push(foundry.utils.deepClone(assembly));
    return state;
  });
}

async function closeAssembly(scene, assemblyId) {
  await updateSceneState(scene, state => {
    state.travelAssemblies = state.travelAssemblies.filter(entry => entry.id !== assemblyId);
    return state;
  });
  game.socket.emit(GLOBAL_MAP_SOCKET, { action: "travelGroup.assembly.closed", sceneId: scene.id, assemblyId });
  const app = assemblyApps.get(`${scene.id}:${assemblyId}`);
  await app?.close?.({ falloutMaWAssemblyClosed: true });
  return true;
}

async function removeTokenFromAssemblies(scene, tokenId) {
  for (const assembly of getSceneState(scene).travelAssemblies.filter(entry => entry.memberTokenIds.includes(tokenId))) {
    const model = await buildAssemblyModel(scene, assembly);
    const removedIds = new Set(model.members
      .filter(member => member.tokenId === tokenId || member.sourceVehicleTokenId === tokenId)
      .map(member => member.id));
    assembly.memberTokenIds = assembly.memberTokenIds.filter(id => id !== tokenId);
    assembly.readyMemberIds = Array.from(model.readyMemberIds).filter(id => !removedIds.has(id));
    for (const id of removedIds) delete assembly.placements?.[id];
    if (!assembly.memberTokenIds.length) await closeAssembly(scene, assembly.id);
    else {
      const nextModel = await buildAssemblyModel(scene, assembly);
      const leader = game.users?.get(assembly.leaderUserId);
      if (!canLeadAssembly(scene, assembly, leader, nextModel)) {
        const next = selectNextLeader(scene, assembly, nextModel);
        if (!next) {
          await closeAssembly(scene, assembly.id);
          continue;
        }
        assembly.leaderUserId = next.user.id;
        assembly.leaderMemberId = next.member.id;
      }
      assembly.updatedAt = Date.now();
      await storeAssembly(scene, assembly);
      broadcastAssemblyChanged(scene, assembly);
    }
  }
}

function broadcastAssemblyChanged(scene, assembly) {
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "travelGroup.assembly.changed",
    sceneId: scene.id,
    assemblyId: assembly.id,
    exitZoneId: assembly.exitZoneId
  });
  void handleAssemblyChanged({ sceneId: scene.id, assemblyId: assembly.id, exitZoneId: assembly.exitZoneId });
}

async function handleAssemblyChanged(payload) {
  const scene = game.scenes?.get(payload.sceneId);
  const assembly = getAssembly(scene, payload.assemblyId);
  if (!scene || !assembly) return;
  for (const [key, pending] of pendingExitPrompts) {
    if (pending.sceneId !== scene.id || pending.exitZoneId !== assembly.exitZoneId) continue;
    pendingExitPrompts.delete(key);
    await pending.dialog?.close?.();
    if (!assembly.memberTokenIds.includes(pending.tokenId)) {
      void requestLocationExit({
        sceneId: scene.id,
        exitZoneId: assembly.exitZoneId,
        tokenId: pending.tokenId,
        mode: "group",
        requestingUserId: pending.userId
      });
    }
  }
  const model = await buildAssemblyModel(scene, assembly);
  const ownsMember = model.members.some(member =>
    member.actor?.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
  );
  if (game.user?.isGM || ownsMember) openTravelAssembly(assembly.id, scene.id);
  else assemblyApps.get(`${scene.id}:${assembly.id}`)?.render?.();
}

async function maintainAssemblyLeaders() {
  for (const scene of game.scenes?.contents ?? []) {
    for (const assembly of getSceneState(scene).travelAssemblies) {
      const model = await buildAssemblyModel(scene, assembly);
      assembly.leaderMemberId = model.leaderMemberId;
      const leader = game.users?.get(assembly.leaderUserId);
      if (canLeadAssembly(scene, assembly, leader, model)) continue;
      const next = selectNextLeader(scene, assembly, model);
      if (!next) await closeAssembly(scene, assembly.id);
      else {
        assembly.leaderUserId = next.user.id;
        assembly.leaderMemberId = next.member.id;
        assembly.updatedAt = Date.now();
        await storeAssembly(scene, assembly);
        broadcastAssemblyChanged(scene, assembly);
      }
    }
  }
}

async function restoreAssemblyWindowsForCurrentUser() {
  for (const scene of game.scenes?.contents ?? []) {
    for (const assembly of getSceneState(scene).travelAssemblies) {
      const model = await buildAssemblyModel(scene, assembly);
      const ownsMember = model.members.some(member =>
        member.actor?.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
      );
      if (game.user?.isGM || ownsMember) openTravelAssembly(assembly.id, scene.id);
    }
  }
}

function queueAssemblyInvalidation(actor) {
  if (!isResponsibleGM() || !actor) return;
  const task = responsibleRequestQueue.then(async () => {
    for (const scene of game.scenes?.contents ?? []) {
      for (const assembly of getSceneState(scene).travelAssemblies) {
        const model = await buildAssemblyModel(scene, assembly);
        const affectedMembers = model.members.filter(member => member.actorUuid === actor.uuid);
        if (!affectedMembers.length) continue;
        const affected = new Set();
        for (const member of affectedMembers) {
          affected.add(member.id);
          if (member.placement?.vehicleTokenId) affected.add(tokenMemberId(member.placement.vehicleTokenId));
          if (member.sourceVehicleTokenId) affected.add(tokenMemberId(member.sourceVehicleTokenId));
        }
        assembly.readyMemberIds = Array.from(model.readyMemberIds).filter(id => !affected.has(id));
        assembly.updatedAt = Date.now();
        await storeAssembly(scene, assembly);
        broadcastAssemblyChanged(scene, assembly);
      }
    }
  });
  responsibleRequestQueue = task.catch(() => {});
}

function queueAssemblyTokenInvalidation(scene, tokenId) {
  if (!isResponsibleGM() || !scene || !tokenId) return;
  const task = responsibleRequestQueue.then(() => invalidateAssemblyToken(scene, tokenId));
  responsibleRequestQueue = task.catch(() => {});
}

async function invalidateAssemblyToken(scene, tokenId) {
  for (const assembly of getSceneState(scene).travelAssemblies.filter(entry => entry.memberTokenIds.includes(tokenId))) {
    const model = await buildAssemblyModel(scene, assembly);
    const affected = new Set([tokenMemberId(tokenId)]);
    for (const member of model.members) {
      if (member.sourceVehicleTokenId === tokenId || member.placement?.vehicleTokenId === tokenId) affected.add(member.id);
    }
    assembly.readyMemberIds = Array.from(model.readyMemberIds).filter(id => !affected.has(id));
    assembly.updatedAt = Date.now();
    await storeAssembly(scene, assembly);
    broadcastAssemblyChanged(scene, assembly);
  }
}

function refreshAssembliesContainingToken(scene, tokenId) {
  if (!scene || !tokenId) return;
  for (const assembly of getSceneState(scene).travelAssemblies.filter(entry => entry.memberTokenIds.includes(tokenId))) {
    broadcastAssemblyChanged(scene, assembly);
  }
}

function selectNextLeader(_scene, _assembly, model) {
  for (const member of model.members) {
    const user = (game.users?.contents ?? []).find(candidate =>
      candidate.active
      && !candidate.isGM
      && member.actor?.testUserPermission(candidate, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
    );
    if (user) return { user, member };
  }
  return null;
}

function canLeadAssembly(_scene, _assembly, user, model) {
  if (!user?.active) return false;
  if (user.isGM) return true;
  const leader = model.membersById.get(model.leaderMemberId);
  return Boolean(leader?.actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
}

function collectOwnerUserIds(actors) {
  return (game.users?.contents ?? [])
    .filter(user => !user.isGM && actors.some(actor => actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)))
    .map(user => user.id);
}

async function collectTravelActors(sources) {
  const resolved = new Map();
  const visitedContexts = new Set();
  const visit = async (actor, passenger = null) => {
    const actorUuid = String(actor?.uuid ?? passenger?.actorUuid ?? "");
    const contextKey = passenger
      ? `passenger:${actorUuid}:${String(passenger.id ?? passenger.actorUuid ?? actorUuid)}`
      : `actor:${actorUuid}`;
    if (!actorUuid || visitedContexts.has(contextKey)) return;
    visitedContexts.add(contextKey);
    if (actor) resolved.set(actorUuid, actor);
    for (const child of getTravelPassengerChildren(passenger, actor)) {
      const childActor = await resolveTravelPassengerActor(child).catch(() => null);
      await visit(childActor, child);
    }
  };
  for (const source of Array.from(sources ?? []).filter(Boolean)) {
    const actor = source?.actor ?? source;
    const passenger = source?.sourcePassenger ?? null;
    await visit(actor, passenger);
  }
  return Array.from(resolved.values());
}

async function restoreTokenControlsAfterArrival({
  groupId,
  transferId,
  targetSceneId,
  viewerUserIds = [],
  carrierTokenId = null,
  controlTokenIds = []
} = {}) {
  if (!viewerUserIds.includes(game.user?.id)) return false;
  cancelQueuedArrivalSelections(groupId, transferId);
  runWhenCanvasSceneReady(targetSceneId, async () => {
    const layer = canvas.falloutMaWGlobalMap;
    if (layer?.completeArrivalSelection) await layer.completeArrivalSelection(groupId, transferId);
    else await layer?.clearArrivalSelection?.(groupId, transferId);
    restoreControlledTokens([carrierTokenId, ...controlTokenIds].filter(Boolean));
  });
  return true;
}

function notifyTravelComplete(targetSceneId, viewerUserIds, {
  activateTokenControls = false,
  controlTokenIds = []
} = {}) {
  const payload = {
    action: "globalMap.travel.complete",
    requestId: foundry.utils.randomID(),
    targetSceneId,
    viewerUserIds,
    activateTokenControls,
    controlTokenIds
  };
  game.socket.emit(GLOBAL_MAP_SOCKET, payload);
  if (!viewerUserIds.includes(game.user.id)) return;
  void completeTravelNotificationForCurrentViewer(payload);
}

async function completeTravelNotificationForCurrentViewer(payload) {
  const targetScene = game.scenes?.get(payload.targetSceneId);
  if (!targetScene) return false;
  if (canvas.loading) {
    runAfterCanvasSettles(() => completeTravelNotificationForCurrentViewer(payload));
    return true;
  }
  if (canvas.scene?.id !== targetScene.id) await targetScene.view();
  if (canvas.loading || canvas.scene?.id !== targetScene.id || !canvas.ready) {
    runAfterCanvasSettles(() => completeTravelNotificationForCurrentViewer(payload));
    return true;
  }
  if (payload.activateTokenControls) restoreControlledTokens(payload.controlTokenIds);
  return true;
}

function restoreControlledTokens(tokenIds = []) {
  canvas.tokens?.activate?.({ tool: "select" });
  const tokens = Array.from(new Set(tokenIds)).map(id => canvas.tokens?.get?.(id)).filter(Boolean);
  for (const [index, token] of tokens.entries()) token.control?.({ releaseOthers: index === 0 });
}

async function openArrivalSelection(payload = {}) {
  const targetScene = game.scenes?.get(payload.targetSceneId);
  if (!targetScene) return false;
  if (canvas.loading) return queueArrivalView(payload);
  if (canvas.scene?.id !== targetScene.id) await targetScene.view();
  if (canvas.loading || canvas.scene?.id !== targetScene.id) return queueArrivalView(payload);
  return queueArrivalSelection(payload);
}

function queueArrivalView(payload = {}) {
  if (!payload.groupId || !payload.targetSceneId) return false;
  cancelQueuedArrivalSelections(payload.groupId);
  const key = `view:${String(payload.transferId || `${payload.groupId}:${payload.targetSceneId}`)}`;
  const waiter = {
    groupId: payload.groupId,
    transferId: payload.transferId,
    hookId: null
  };
  arrivalSelectionWaiters.set(key, waiter);
  runAfterCanvasSettles(() => {
    if (arrivalSelectionWaiters.get(key) !== waiter) return;
    arrivalSelectionWaiters.delete(key);
    void openArrivalSelection(payload);
  });
  return true;
}

function queueArrivalSelection(payload = {}) {
  if (!payload.groupId || !payload.targetSceneId) return false;
  cancelQueuedArrivalSelections(payload.groupId);
  const start = () => canvas.falloutMaWGlobalMap?.startArrivalSelection?.(payload);
  if (isCanvasSceneReady(payload.targetSceneId)) {
    void start();
    return true;
  }
  const key = String(payload.transferId || `${payload.groupId}:${payload.targetSceneId}`);
  const hookId = Hooks.on("canvasReady", () => {
    runAfterCanvasSettles(() => {
      if (!isCanvasSceneReady(payload.targetSceneId)) {
        if (canvas.scene?.id === payload.targetSceneId) return;
        Hooks.off("canvasReady", hookId);
        arrivalSelectionWaiters.delete(key);
        void openArrivalSelection(payload);
        return;
      }
      Hooks.off("canvasReady", hookId);
      arrivalSelectionWaiters.delete(key);
      void start();
    });
  });
  arrivalSelectionWaiters.set(key, { groupId: payload.groupId, transferId: payload.transferId, hookId });
  return true;
}

function cancelQueuedArrivalSelections(groupId = null, transferId = null) {
  for (const [key, waiter] of arrivalSelectionWaiters) {
    if (groupId && waiter.groupId !== groupId) continue;
    if (transferId && waiter.transferId && waiter.transferId !== transferId) continue;
    if (waiter.hookId !== null && waiter.hookId !== undefined) Hooks.off("canvasReady", waiter.hookId);
    arrivalSelectionWaiters.delete(key);
  }
}

function runWhenCanvasSceneReady(sceneId, callback) {
  if (isCanvasSceneReady(sceneId)) {
    void callback();
    return;
  }
  if (canvas.loading) {
    runAfterCanvasSettles(() => runWhenCanvasSceneReady(sceneId, callback));
    return;
  }
  const hookId = Hooks.on("canvasReady", () => {
    runAfterCanvasSettles(() => {
      if (!isCanvasSceneReady(sceneId)) return;
      Hooks.off("canvasReady", hookId);
      void callback();
    });
  });
}

function isCanvasSceneReady(sceneId) {
  return Boolean(
    canvas?.ready
    && !canvas.loading
    && canvas.scene?.id === sceneId
    && canvas[GLOBAL_MAP_LAYER]
  );
}

function scheduleArrivalTimer(sceneId, tokenId, deadline) {
  clearArrivalTimer(sceneId, tokenId);
  const delay = Math.max(0, Number(deadline) - Date.now());
  const key = `${sceneId}:${tokenId}`;
  arrivalTimers.set(key, setTimeout(() => {
    void queueResponsibleGMTask(() => chooseRandomArrival(sceneId, tokenId));
  }, delay));
}

function clearArrivalTimer(sceneId, tokenId) {
  const key = `${sceneId}:${tokenId}`;
  const timer = arrivalTimers.get(key);
  if (timer) clearTimeout(timer);
  arrivalTimers.delete(key);
}

async function resumeArrivalTimers() {
  if (!isResponsibleGM()) return;
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens?.contents ?? []) {
      let pending = token.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival;
      if (!pending) continue;
      const needsUpgrade = !pending.transferId
        || !pending.originSceneId
        || normalizeLocationEntryMode(pending.entryMode) !== pending.entryMode
        || !Number(pending.deadline)
        || !Array.isArray(pending.originCellKeys)
        || !pending.originCellKeys.length
        || !Array.isArray(pending.validExitZoneIds)
        || !pending.validExitZoneIds.length;
      if (needsUpgrade) {
        const currentCell = pointToCell(scene, tokenCenter(token, scene));
        const targetScene = pending.targetSceneId ? game.scenes?.get(pending.targetSceneId) : null;
        const validExitZoneIds = Array.isArray(pending.validExitZoneIds) && pending.validExitZoneIds.length
          ? pending.validExitZoneIds
          : getSceneState(targetScene).locationExitZones
            .filter(zone => zone.cells?.length)
            .map(zone => zone.id);
        pending = createPendingArrival({
          ...pending,
          transferId: pending.transferId || foundry.utils.randomID(),
          originSceneId: pending.originSceneId || scene.id,
          entryMode: pending.entryMode,
          deadline: pending.deadline || (Date.now() + ARRIVAL_TIMEOUT_MS),
          originCellKeys: pending.originCellKeys?.length
            ? pending.originCellKeys
            : (currentCell ? [cellKey(currentCell)] : []),
          validExitZoneIds
        });
        const upgraded = await token.update({
          [`flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}.pendingArrival`]: pending
        }, { [TRAVEL_BYPASS_OPTION]: true }).then(() => true).catch(error => {
          console.warn(`${FALLOUT_MAW.id} | Could not upgrade pending travel-group arrival`, error);
          return false;
        });
        if (upgraded) await reopenPendingArrivalSelection(scene, token, pending);
      }
      if (pending?.deadline) scheduleArrivalTimer(scene.id, token.id, pending.deadline);
    }
  }
}

async function reopenPendingArrivalSelection(originScene, token, pending) {
  const targetScene = game.scenes?.get(pending.targetSceneId);
  if (!targetScene || getValidArrivalZones(targetScene, token, pending).length <= 1) return false;
  const viewerUserIds = getTravelGroupViewerUserIds(token.actor, {
    requestingUserId: pending.requestedByUserId
  });
  const selection = {
    action: "travelGroup.arrival.open",
    originSceneId: originScene.id,
    tokenId: token.id,
    ...pending,
    viewerUserIds
  };
  game.socket.emit(GLOBAL_MAP_SOCKET, selection);
  if (viewerUserIds.includes(game.user?.id)) await openArrivalSelection(selection);
  return true;
}

async function chooseRandomArrival(sceneId, tokenId) {
  if (!isResponsibleGM()) return;
  const originScene = game.scenes?.get(sceneId);
  const token = originScene?.tokens?.get(tokenId);
  const pending = token?.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival;
  const targetScene = pending ? game.scenes?.get(pending.targetSceneId) : null;
  if (!originScene || !token || !pending) return;
  if (!targetScene) {
    console.warn(`${FALLOUT_MAW.id} | Arrival remains pending because its target Scene is unavailable`, {
      transferId: pending.transferId,
      targetSceneId: pending.targetSceneId
    });
    await postponePendingArrival(originScene, token, pending);
    return;
  }
  const zones = getValidArrivalZones(targetScene, token, pending);
  if (!zones.length) {
    console.warn(`${FALLOUT_MAW.id} | Arrival remains pending because no valid entry zone is available`, {
      transferId: pending.transferId,
      targetSceneId: targetScene.id
    });
    await postponePendingArrival(originScene, token, pending);
    return;
  }
  try {
    validatePendingCarrierPosition(originScene, token, pending);
  } catch (error) {
    console.warn(`${FALLOUT_MAW.id} | Arrival remains pending because the carrier left its origin`, error);
    await postponePendingArrival(originScene, token, pending);
    return;
  }
  const zone = zones[Math.floor(Math.random() * zones.length)];
  try {
    const completed = await performArrival(originScene, token, targetScene, zone, pending);
    if (completed === false) await postponePendingArrival(originScene, token, pending);
  } catch (error) {
    console.error(`${FALLOUT_MAW.id} | Automatic arrival failed`, error);
    await postponePendingArrival(originScene, token, pending);
  }
}

async function postponePendingArrival(originScene, token, pending) {
  const currentToken = originScene?.tokens?.get(token?.id);
  const current = currentToken?.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival;
  if (!current || current.transferId !== pending.transferId) return false;
  const next = { ...current, deadline: Date.now() + ARRIVAL_TIMEOUT_MS };
  await currentToken.update({
    [`flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}.pendingArrival`]: next
  }, { [TRAVEL_BYPASS_OPTION]: true });
  scheduleArrivalTimer(originScene.id, currentToken.id, next.deadline);
  return true;
}

function canPlaceTravelPassengers(scene, zone, passengers) {
  const reserved = [];
  try {
    for (const passenger of passengers) {
      if (!passenger.tokenData) continue;
      const position = findFreePlacement(scene, passenger.tokenData, zone.cells, reserved);
      reserved.push(tokenRect(scene, { ...passenger.tokenData, ...position }));
    }
    return true;
  } catch (_error) {
    return false;
  }
}

async function restoreArrivalSelectionForCurrentUser() {
  const scene = canvas.scene;
  if (!scene) return;
  for (const originScene of game.scenes?.contents ?? []) {
    for (const token of originScene.tokens?.contents ?? []) {
      const pending = token.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival;
      if (!pending || pending.targetSceneId !== scene.id) continue;
      if (!pending.transferId || !pending.originSceneId || !pending.entryMode) continue;
      if (!game.user?.isGM && !token.actor?.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) continue;
      if (getValidArrivalZones(scene, token, pending).length <= 1) continue;
      queueArrivalSelection({ originSceneId: originScene.id, tokenId: token.id, ...pending });
      return;
    }
  }
}

function protectTravelActorUpdate(actor, _changes, options, userId) {
  if (!actor.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG)?.groupId || options?.[TRAVEL_BYPASS_OPTION]) return;
  if (game.users?.get(userId)?.isGM) return;
  ui.notifications.warn("Системный актёр путешествия нельзя изменять вручную.");
  return false;
}

function protectTravelActorDelete(actor, options, userId) {
  if (!actor.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG)?.groupId || options?.[TRAVEL_BYPASS_OPTION]) return;
  if (game.users?.get(userId)?.isGM) return;
  ui.notifications.warn("Системный актёр путешествия нельзя удалять вручную.");
  return false;
}

function protectTravelTokenDelete(token, options, userId) {
  if (!token.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.groupId || options?.[TRAVEL_BYPASS_OPTION]) return;
  if (game.users?.get(userId)?.isGM) return;
  ui.notifications.warn("Токен путешествующей группы удаляется только при завершении путешествия.");
  return false;
}

function protectTravelEmbeddedItem(item, options, userId) {
  if (!item.parent?.getFlag?.(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG)?.groupId || options?.[TRAVEL_BYPASS_OPTION]) return;
  if (game.users?.get(userId)?.isGM) return;
  ui.notifications.warn("Контейнер путешествующей группы нельзя изменять вручную.");
  return false;
}

function validatePendingCarrierPosition(originScene, token, pending) {
  const key = cellKey(pointToCell(originScene, tokenCenter(token, originScene)));
  const snapshotCellKeys = Array.isArray(pending.originCellKeys) ? pending.originCellKeys.map(String) : [];
  if (snapshotCellKeys.length && !snapshotCellKeys.includes(key)) {
    throw new Error("Группа покинула область локации.");
  }
  if (snapshotCellKeys.length) return true;
  const found = findLocation(pending.locationId);
  if (!found || found.scene.id !== originScene.id) throw new Error("Локация ожидающего входа не найдена.");
  if (!getLocationCells(originScene, found.location).some(cell => cellKey(cell) === key)) {
    throw new Error("Группа покинула область локации.");
  }
  return true;
}

function isTravelGroupRequestAction(action) {
  return new Set([
    "travelGroup.exit.request",
    "travelGroup.arrival.request",
    "travelGroup.arrival.select",
    "travelGroup.assembly.ready",
    "travelGroup.assembly.place",
    "travelGroup.assembly.remove",
    "travelGroup.assembly.depart",
    "travelGroup.assembly.cancel",
    "travelGroup.carrier.movePassenger"
  ]).has(action);
}

function emitGroupError(payload, message) {
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "travelGroup.error",
    requestId: payload.requestId,
    requestingUserId: payload.requestingUserId,
    message
  }, { recipients: [payload.requestingUserId] });
  if (payload.requestingUserId === game.user?.id) ui.notifications.error(message);
  return false;
}

function canPlaceTravelCarrier(scene, zone, carrierToken) {
  try {
    findFreePlacement(scene, carrierToken.toObject(), zone.cells, [], { strictPreferredCells: true });
    return true;
  } catch (_error) {
    return false;
  }
}

function uniqueActorParticipants(entries = []) {
  const actors = new Map();
  for (const entry of entries) {
    if (!entry?.actorUuid || actors.has(entry.actorUuid)) continue;
    actors.set(entry.actorUuid, {
      actorUuid: String(entry.actorUuid),
      tokenUuid: String(entry.tokenUuid ?? ""),
      itemUuid: String(entry.itemUuid ?? "")
    });
  }
  return Array.from(actors.values());
}

function travelDocumentOptions(scope, options = {}) {
  return {
    ...options,
    falloutMawSystemEventChainRef: scope?.chainRef ?? null,
    chainRef: scope?.chainRef ?? null
  };
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
}

function isResponsibleGM() {
  return getResponsibleGM()?.id === game.user?.id;
}
