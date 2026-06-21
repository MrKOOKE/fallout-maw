import { FalloutMaWFormApplicationV2 } from "../apps/base-form-application-v2.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  ACTOR_CONTAINER_FLAG,
  getActorContainerFlag,
  getActorContainerSeatDefinitions,
  hasActorContainer,
  moveActorContainerPassengerData
} from "../utils/actor-containers.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "../utils/item-functions.mjs";
import {
  GLOBAL_MAP_LAYER,
  GLOBAL_MAP_SOCKET,
  GLOBAL_MAP_VERSION,
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
import { findLocation, getGlobalMapFlag, getSceneState, setDiscovered, updateSceneState } from "./storage.mjs";
import { getTravelGroupImage, getTravelGroupPrototypeToken } from "./travel-settings.mjs";
import { createTravelFormulaSnapshot, evaluateTravelSpeed } from "./travel-speed.mjs";
import { queueGlobalMapApplicationPosition } from "./window-position.mjs";

const { DialogV2 } = foundry.applications.api;
const TEMPLATE = `systems/${FALLOUT_MAW.id}/templates/global-map/travel-assembly.hbs`;
const TRAVEL_BYPASS_OPTION = "falloutMaWTravelGroupBypass";
const ARRIVAL_TIMEOUT_MS = 60_000;
const assemblyApps = new Map();
const pendingExitPrompts = new Map();
const arrivalTimers = new Map();
let responsibleRequestQueue = Promise.resolve();

export function registerTravelGroupHooks() {
  Hooks.on("preUpdateActor", protectTravelActorUpdate);
  Hooks.on("preDeleteActor", protectTravelActorDelete);
  Hooks.on("preDeleteToken", protectTravelTokenDelete);
  Hooks.on("preUpdateToken", protectTravelTokenUpdate);
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
    if (isResponsibleGM()) resumeArrivalTimers();
  });
  Hooks.on("ready", () => {
    if (isResponsibleGM()) resumeArrivalTimers();
    void restoreAssemblyWindowsForCurrentUser();
  });
  Hooks.on("canvasReady", () => restoreArrivalSelectionForCurrentUser());
}

export function registerTravelGroupSocket() {
  game.socket.on(GLOBAL_MAP_SOCKET, handleTravelGroupSocket);
  if (isResponsibleGM()) resumeArrivalTimers();
}

export async function promptLocationExit({ sceneId, exitZoneId, tokenId, userId = game.user?.id } = {}) {
  const scene = game.scenes?.get(sceneId);
  const zone = getSceneState(scene).locationExitZones.find(entry => entry.id === exitZoneId);
  const token = scene?.tokens?.get(tokenId);
  if (!scene || !zone || !token) return false;
  const promptKey = `${sceneId}:${tokenId}`;
  if (pendingExitPrompts.has(promptKey)) return false;
  pendingExitPrompts.set(promptKey, { dialog: null, sceneId, exitZoneId, tokenId, userId });
  const result = await DialogV2.wait({
    window: { title: zone.name || "Покинуть локацию?" },
    content: `<p>Покинуть локацию через <strong>${foundry.utils.escapeHTML(zone.name || "зону выхода")}</strong>?</p>`,
    buttons: [
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
  if (result !== "solo" && result !== "group") return false;
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
      removeMember: TravelAssemblyApplication.#removeMember
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
      canManage
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
    const placement = target.dataset.dropKind === "vehicle-cell"
      ? {
          vehicleTokenId: target.dataset.vehicleTokenId,
          slotId: target.dataset.slotId,
          slotIndex: Number(target.dataset.slotIndex),
          x: Number(target.dataset.x),
          y: Number(target.dataset.y)
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
  if (!getResponsibleGM()) {
    ui.notifications.warn("Путешествие недоступно: нет активного GM.");
    return false;
  }
  game.socket.emit(GLOBAL_MAP_SOCKET, request);
  return true;
}

async function handleTravelGroupSocket(payload) {
  if (!payload || typeof payload !== "object" || !String(payload.action ?? "").startsWith("travelGroup.")) return;
  if (isTravelGroupRequestAction(payload.action)) {
    if (game.user?.isGM && isResponsibleGM()) await queueResponsibleGMRequest(payload);
    return;
  }
  if (payload.action === "travelGroup.assembly.changed") {
    await handleAssemblyChanged(payload);
  } else if (payload.action === "travelGroup.assembly.closed") {
    const app = assemblyApps.get(`${payload.sceneId}:${payload.assemblyId}`);
    await app?.close?.({ falloutMaWAssemblyClosed: true });
  } else if (payload.action === "travelGroup.arrival.open") {
    if (!(payload.viewerUserIds ?? []).includes(game.user?.id)) return;
    runWhenCanvasSceneReady(payload.targetSceneId, () => (
      canvas.falloutMaWGlobalMap?.startArrivalSelection?.(payload)
    ));
  } else if (payload.action === "travelGroup.arrival.closed") {
    await restoreTokenControlsAfterArrival(payload);
  } else if (payload.action === "travelGroup.error" && payload.requestingUserId === game.user?.id) {
    ui.notifications.error(payload.message || "Не удалось выполнить путешествие.");
  }
}

function queueResponsibleGMRequest(payload) {
  const task = responsibleRequestQueue.then(() => handleResponsibleGMRequest(payload));
  responsibleRequestQueue = task.catch(() => {});
  return task;
}

async function handleResponsibleGMRequest(payload) {
  try {
    switch (payload.action) {
      case "travelGroup.exit.request": return handleExitRequest(payload);
      case "travelGroup.assembly.ready": return handleReadyRequest(payload);
      case "travelGroup.assembly.place": return handlePlaceRequest(payload);
      case "travelGroup.assembly.remove": return handleRemoveRequest(payload);
      case "travelGroup.assembly.depart": return handleDepartRequest(payload);
      case "travelGroup.assembly.cancel": return handleCancelRequest(payload);
      case "travelGroup.carrier.movePassenger": return handleCarrierMovePassengerRequest(payload);
      case "travelGroup.arrival.request": return handleArrivalRequest(payload);
      case "travelGroup.arrival.select": return handleArrivalSelectRequest(payload);
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
  await departAssemblyWhenReady(scene, assembly);
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

async function departAssemblyWhenReady(scene, assembly) {
  const model = await buildAssemblyModel(scene, assembly);
  const required = model.members.filter(memberRequiresReady);
  if (!required.length
    || model.members.some(member => member.missing)
    || required.some(member => !model.readyMemberIds.has(member.id))) return false;
  return performAssemblyDeparture(
    scene,
    assembly,
    model,
    assembly.leaderUserId || game.users?.activeGM?.id
  );
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
  if (!user.isGM && !token.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) throw new Error("Нет прав на группу.");
  const currentKey = cellKey(pointToCell(originScene, tokenCenter(token, originScene)));
  if (!getLocationCells(originScene, found.location).some(cell => cellKey(cell) === currentKey)) throw new Error("Группа больше не находится на локации.");
  const targetScene = found.location.linkedSceneId ? game.scenes?.get(found.location.linkedSceneId) : null;
  const zones = getSceneState(targetScene).locationExitZones.filter(zone => zone.cells?.length);
  if (!targetScene || !zones.length) throw new Error("На сцене локации не установлены зоны входа и выхода.");
  const group = token.actor.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG);
  const pending = {
    groupId: group.groupId,
    locationId: found.location.id,
    targetSceneId: targetScene.id,
    requestedByUserId: user.id,
    deadline: Date.now() + ARRIVAL_TIMEOUT_MS
  };
  await token.update({ [`flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}.pendingArrival`]: pending });
  const viewerUserIds = getTravelGroupViewerUserIds(token.actor);
  if (!targetScene.active) await targetScene.activate();
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "travelGroup.arrival.open",
    originSceneId: originScene.id,
    tokenId: token.id,
    ...pending,
    viewerUserIds
  });
  if (viewerUserIds.includes(game.user.id)) {
    runWhenCanvasSceneReady(targetScene.id, () => canvas.falloutMaWGlobalMap?.startArrivalSelection?.({
      originSceneId: originScene.id,
      tokenId: token.id,
      ...pending,
      viewerUserIds
    }));
  }
  scheduleArrivalTimer(originScene.id, token.id, pending.deadline);
  return true;
}

async function handleArrivalSelectRequest(payload) {
  const originScene = game.scenes?.get(payload.originSceneId);
  const token = originScene?.tokens?.get(payload.tokenId);
  const pending = token?.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival;
  const user = game.users?.get(payload.requestingUserId);
  if (!originScene || !token?.actor || !pending || !user) throw new Error("Ожидающий вход не найден.");
  if (!user.isGM && !token.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) throw new Error("Нет прав на выбор зоны.");
  validatePendingCarrierPosition(originScene, token, pending);
  const targetScene = game.scenes?.get(pending.targetSceneId);
  const zone = getSceneState(targetScene).locationExitZones.find(entry => entry.id === payload.exitZoneId && entry.cells?.length);
  if (!targetScene || !zone) throw new Error("Зона прибытия не найдена.");
  return performArrival(originScene, token, targetScene, zone, pending);
}

async function performDeparture({ scene, zone, tokenDocuments, model = null, requestingUserId, assemblyId = null }) {
  const sceneFlag = getGlobalMapFlag(scene);
  const parentScene = sceneFlag?.parentSceneId ? game.scenes?.get(sceneFlag.parentSceneId) : null;
  const location = parentScene ? getSceneState(parentScene).locations.find(entry => entry.id === sceneFlag.nodeId) : null;
  if (!parentScene || !location) throw new Error("Родительская карта локации не найдена.");
  const activeModel = model ?? await buildSoloAssemblyModel(scene, tokenDocuments[0]);
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
      }, { [TRAVEL_BYPASS_OPTION]: true });
      appliedPlans.push(plan);
    }
    topUnits = buildTopTravelUnits(activeModel);
    carrierActor = await createTravelCarrier({
      originScene: scene,
      targetScene: parentScene,
      topUnits,
      allActors: activeModel.members.map(member => member.actor).filter(Boolean),
      requestingUserId,
      assemblyId
    });
    const prototype = await carrierActor.getTokenDocument({}, { parent: parentScene });
    const carrierData = prototype.toObject();
    delete carrierData._id;
    const position = findFreePlacement(parentScene, carrierData, getLocationCells(parentScene, location));
    carrierData.x = position.x;
    carrierData.y = position.y;
    const group = carrierActor.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG);
    foundry.utils.setProperty(carrierData, `flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}`, {
      version: GLOBAL_MAP_VERSION,
      groupId: group.groupId,
      pendingArrival: null
    });
    [carrierToken] = await parentScene.createEmbeddedDocuments("Token", [carrierData]);
    if (!carrierToken) throw new Error("Не удалось создать токен группы.");
    await scene.deleteEmbeddedDocuments(
      "Token",
      tokenDocuments.map(token => token.id),
      { [TRAVEL_BYPASS_OPTION]: true }
    );
  } catch (error) {
    if (carrierToken) await parentScene.deleteEmbeddedDocuments("Token", [carrierToken.id], { [TRAVEL_BYPASS_OPTION]: true }).catch(() => {});
    for (const plan of appliedPlans.reverse()) {
      await plan.actor.update({
        ownership: plan.originalOwnership,
        [`flags.${FALLOUT_MAW.id}.${ACTOR_CONTAINER_FLAG}.passengers`]: plan.originalPassengers
      }, { [TRAVEL_BYPASS_OPTION]: true }).catch(() => {});
    }
    const missing = tokenDocuments.filter(token => !scene.tokens?.get(token.id)).map(token => {
      const data = foundry.utils.deepClone(originalTokenData.get(token.id));
      delete data._id;
      return data;
    });
    if (missing.length) await scene.createEmbeddedDocuments("Token", missing).catch(() => {});
    if (carrierActor) await carrierActor.delete({ [TRAVEL_BYPASS_OPTION]: true }).catch(() => {});
    throw error;
  }
  const viewerUserIds = getTravelGroupViewerUserIds(carrierActor);
  if (!parentScene.active) await parentScene.activate();
  notifyTravelComplete(parentScene.id, viewerUserIds);
  return true;
}

async function createTravelCarrier({ originScene, targetScene, topUnits, allActors, requestingUserId, assemblyId }) {
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
  const ownerUserIds = await collectTravelOwnerUserIds(allActors);
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
          memberActorUuids: allActors.map(actor => actor?.uuid).filter(Boolean),
          units: storedUnits,
          createdAt: Date.now()
        }
      }
    }
  }, { renderSheet: false, [TRAVEL_BYPASS_OPTION]: true });
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
  const carrierActor = game.actors?.get(carrierToken.actorId) ?? carrierToken.actor;
  const viewerUserIds = getTravelGroupViewerUserIds(carrierActor);
  const units = getTravelCarrierUnits(carrierActor);
  if (!units.length) throw new Error("В группе нет участников для размещения.");
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
    created = await targetScene.createEmbeddedDocuments("Token", createData);
    if (created.length !== createData.length) throw new Error("Не все участники были размещены.");
    await originScene.deleteEmbeddedDocuments("Token", [carrierToken.id], { [TRAVEL_BYPASS_OPTION]: true });
  } catch (error) {
    if (created.length) await targetScene.deleteEmbeddedDocuments("Token", created.map(token => token.id)).catch(() => {});
    throw error;
  }
  await carrierActor.delete({ [TRAVEL_BYPASS_OPTION]: true }).catch(error => {
    console.warn(`${FALLOUT_MAW.id} | Travel-group carrier actor cleanup failed`, error);
  });
  await setDiscovered(targetScene, "exit", zone.id, true);
  clearArrivalTimer(originScene.id, carrierToken.id);
  if (!targetScene.active) await targetScene.activate();
  const closedPayload = {
    action: "travelGroup.arrival.closed",
    groupId: pending.groupId,
    targetSceneId: targetScene.id,
    viewerUserIds
  };
  game.socket.emit(GLOBAL_MAP_SOCKET, closedPayload);
  await restoreTokenControlsAfterArrival(closedPayload);
  notifyTravelComplete(targetScene.id, viewerUserIds, { activateTokenControls: true });
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
      if (!originalSources.has(userId)) originalSources.set(userId, passenger);
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
      const temporarySource = plan.nextPassengers.find(passenger => passenger.temporaryOwnerUserIds?.includes(user.id));
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

function findFreePlacement(scene, tokenData, preferredCells = [], reserved = []) {
  const source = preferredCells
    .map(cell => typeof cell === "string" ? parseCellKey(cell) : cell)
    .filter(cell => Number.isFinite(cell?.i) && Number.isFinite(cell?.j));
  if (!source.length) {
    source.push(scene.grid.getOffset({
      x: Number(scene.width) / 2,
      y: Number(scene.height) / 2
    }));
  }

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
    if (!isCellCenterInsideScene(scene, cell)) return;
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
    if (!occupied.some(other => rectanglesOverlap(rect, other)) && rectInsideScene(scene, rect)) return position;
    for (const adjacent of scene.grid.getAdjacentOffsets(cell)) enqueue(adjacent);
  }
  throw new Error("На сцене нет свободного места для размещения группы.");
}

function isCellCenterInsideScene(scene, cell) {
  const center = scene.grid.getCenterPoint(cell);
  return Number.isFinite(center?.x)
    && Number.isFinite(center?.y)
    && center.x >= 0
    && center.y >= 0
    && center.x < Number(scene.width)
    && center.y < Number(scene.height);
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

function rectInsideScene(scene, rect) {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= scene.width && rect.y + rect.height <= scene.height;
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
      const cells = [];
      for (let y = 1; y <= seat.height; y += 1) {
        for (let x = 1; x <= seat.width; x += 1) {
          cells.push({
            x,
            y,
            slotId: seat.slotId,
            slotIndex,
            occupied: occupants.some(member =>
              x >= member.placement.x
              && x < member.placement.x + member.width
              && y >= member.placement.y
              && y < member.placement.y + member.height
            ),
            style: `grid-column: ${x}; grid-row: ${y};`
          });
        }
      }
      instances.push({
        id: `${seat.slotId}:${slotIndex}`,
        columns: seat.width,
        rows: seat.height,
        cells,
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

async function collectTravelOwnerUserIds(actors) {
  const resolved = new Map(actors.filter(Boolean).map(actor => [actor.uuid, actor]));
  const queue = [...resolved.values()];
  while (queue.length) {
    const actor = queue.shift();
    for (const passenger of getActorContainerFlag(actor).passengers) {
      if (resolved.has(passenger.actorUuid)) continue;
      const passengerActor = await globalThis.fromUuid?.(passenger.actorUuid);
      if (!passengerActor) continue;
      resolved.set(passenger.actorUuid, passengerActor);
      queue.push(passengerActor);
    }
  }
  return collectOwnerUserIds(Array.from(resolved.values()));
}

function getTravelGroupViewerUserIds(actor) {
  const group = actor?.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG);
  return Array.from(new Set([group?.requestingUserId, ...(group?.ownerUserIds ?? [])].filter(Boolean)));
}

async function restoreTokenControlsAfterArrival({ groupId, targetSceneId, viewerUserIds = [] } = {}) {
  if (!viewerUserIds.includes(game.user?.id)) return false;
  runWhenCanvasSceneReady(targetSceneId, async () => {
    await canvas.falloutMaWGlobalMap?.clearArrivalSelection?.(groupId);
    canvas.tokens?.activate?.({ tool: "select" });
  });
  return true;
}

function notifyTravelComplete(targetSceneId, viewerUserIds, { activateTokenControls = false } = {}) {
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.travel.complete",
    requestId: foundry.utils.randomID(),
    targetSceneId,
    viewerUserIds,
    activateTokenControls
  });
  if (!viewerUserIds.includes(game.user.id)) return;
  if (activateTokenControls) {
    runWhenCanvasSceneReady(targetSceneId, () => canvas.tokens?.activate?.({ tool: "select" }));
  }
}

function runWhenCanvasSceneReady(sceneId, callback) {
  const isReady = () => Boolean(
    canvas?.ready
    && !canvas.loading
    && canvas.scene?.id === sceneId
    && canvas[GLOBAL_MAP_LAYER]
  );
  if (isReady()) {
    void callback();
    return;
  }
  const hookId = Hooks.on("canvasReady", () => {
    if (!isReady()) return;
    Hooks.off("canvasReady", hookId);
    void callback();
  });
}

function scheduleArrivalTimer(sceneId, tokenId, deadline) {
  clearArrivalTimer(sceneId, tokenId);
  const delay = Math.max(0, Number(deadline) - Date.now());
  const key = `${sceneId}:${tokenId}`;
  arrivalTimers.set(key, setTimeout(() => void chooseRandomArrival(sceneId, tokenId), delay));
}

function clearArrivalTimer(sceneId, tokenId) {
  const key = `${sceneId}:${tokenId}`;
  const timer = arrivalTimers.get(key);
  if (timer) clearTimeout(timer);
  arrivalTimers.delete(key);
}

function resumeArrivalTimers() {
  if (!isResponsibleGM()) return;
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens?.contents ?? []) {
      const pending = token.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival;
      if (pending?.deadline) scheduleArrivalTimer(scene.id, token.id, pending.deadline);
    }
  }
}

async function chooseRandomArrival(sceneId, tokenId) {
  if (!isResponsibleGM()) return;
  const originScene = game.scenes?.get(sceneId);
  const token = originScene?.tokens?.get(tokenId);
  const pending = token?.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival;
  const targetScene = pending ? game.scenes?.get(pending.targetSceneId) : null;
  const units = token?.actor ? getTravelCarrierUnits(token.actor) : [];
  const zones = getSceneState(targetScene).locationExitZones
    .filter(zone => zone.cells?.length)
    .filter(zone => canPlaceTravelPassengers(targetScene, zone, units));
  if (!originScene || !token || !pending || !targetScene) return;
  if (!zones.length) {
    await token.update({ [`flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}.pendingArrival`]: null });
    clearArrivalTimer(sceneId, tokenId);
    const closedPayload = {
      action: "travelGroup.arrival.closed",
      groupId: pending.groupId,
      targetSceneId: targetScene.id,
      viewerUserIds: getTravelGroupViewerUserIds(token.actor)
    };
    game.socket.emit(GLOBAL_MAP_SOCKET, closedPayload);
    await restoreTokenControlsAfterArrival(closedPayload);
    return;
  }
  try {
    validatePendingCarrierPosition(originScene, token, pending);
  } catch (_error) {
    await token.update({ [`flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_TOKEN_FLAG}.pendingArrival`]: null });
    clearArrivalTimer(sceneId, tokenId);
    return;
  }
  const zone = zones[Math.floor(Math.random() * zones.length)];
  try {
    await performArrival(originScene, token, targetScene, zone, pending);
  } catch (error) {
    console.error(`${FALLOUT_MAW.id} | Automatic arrival failed`, error);
  }
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
      if (!game.user?.isGM && !token.actor?.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) continue;
      canvas.falloutMaWGlobalMap?.startArrivalSelection?.({ originSceneId: originScene.id, tokenId: token.id, ...pending });
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

function protectTravelTokenUpdate(token, changes, options, userId) {
  if (!token.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.groupId || options?.[TRAVEL_BYPASS_OPTION]) return;
  if (game.users?.get(userId)?.isGM) return;
  const allowed = new Set(["x", "y", "elevation", "rotation", "sort"]);
  if (Object.keys(changes ?? {}).every(key => allowed.has(key))) return;
  ui.notifications.warn("У токена путешествующей группы можно изменять только положение.");
  return false;
}

function protectTravelEmbeddedItem(item, options, userId) {
  if (!item.parent?.getFlag?.(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG)?.groupId || options?.[TRAVEL_BYPASS_OPTION]) return;
  if (game.users?.get(userId)?.isGM) return;
  ui.notifications.warn("Контейнер путешествующей группы нельзя изменять вручную.");
  return false;
}

function validatePendingCarrierPosition(originScene, token, pending) {
  const found = findLocation(pending.locationId);
  if (!found || found.scene.id !== originScene.id) throw new Error("Локация ожидающего входа не найдена.");
  const key = cellKey(pointToCell(originScene, tokenCenter(token, originScene)));
  if (!getLocationCells(originScene, found.location).some(cell => cellKey(cell) === key)) {
    throw new Error("Группа покинула область локации.");
  }
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
  });
  if (payload.requestingUserId === game.user?.id) ui.notifications.error(message);
  return false;
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
}

function isResponsibleGM() {
  return getResponsibleGM()?.id === game.user?.id;
}
