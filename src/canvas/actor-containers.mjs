import { SYSTEM_ID } from "../constants.mjs";
import {
  ACTOR_CONTAINER_FLAG,
  findFirstAvailableActorContainerSeat,
  getActorContainerFlag,
  hasActorContainer,
  isActorInActorContainer,
  resolveActorContainerPassengerActor
} from "../utils/actor-containers.mjs";

const ACTOR_CONTAINER_SOCKET = `system.${SYSTEM_ID}`;
const ACTOR_CONTAINER_SOCKET_SCOPE = `${SYSTEM_ID}.actorContainers`;
const ACTOR_CONTAINER_SOCKET_TIMEOUT = 10000;
const ACTOR_CONTAINER_HIGHLIGHT_LAYER = "fallout-maw-actor-container-targets";
const ACTOR_CONTAINER_PLACEMENT_LAYER = "fallout-maw-actor-container-placement";
const ACTOR_CONTAINER_HIGHLIGHT_COLOR = 0x4fb6ff;
const ACTOR_CONTAINER_PLACEMENT_COLOR = 0x6fdc7a;
const BLOCKED_CANVAS_EVENT_TYPES = Object.freeze([
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu"
]);

let activeBoardingMode = null;
let activeExitPlacement = null;
const pendingRequests = new Map();
let actorContainerRequestQueue = Promise.resolve();

export function registerActorContainerHooks() {
  Hooks.on("canvasReady", () => {
    refreshActorContainerHighlights();
    refreshActorContainerExitPreview();
  });
  Hooks.on("controlToken", refreshActorContainerHighlights);
  Hooks.on("createToken", refreshActorContainerHighlights);
  Hooks.on("updateToken", refreshActorContainerHighlights);
  Hooks.on("deleteToken", refreshActorContainerHighlights);
  Hooks.on("updateActor", refreshActorContainerHighlights);
  Hooks.on("createItem", item => {
    if (item?.actor) refreshActorContainerHighlights();
  });
  Hooks.on("updateItem", item => {
    if (item?.actor) refreshActorContainerHighlights();
  });
  Hooks.on("deleteItem", item => {
    if (item?.actor) refreshActorContainerHighlights();
  });
  Hooks.on("canvasTearDown", () => {
    cancelActorContainerBoardingMode();
    cancelActorContainerExitPlacement();
  });
}

export function registerActorContainerSocket() {
  game.socket.on(ACTOR_CONTAINER_SOCKET, handleActorContainerSocketMessage);
}

export function startActorContainerBoardingMode({ actor = null, token = null } = {}) {
  const passengerActor = actor ?? token?.actor ?? token?.document?.actor ?? null;
  const passengerToken = token?.document ?? token ?? null;
  if (!passengerActor?.isOwner || !passengerToken?.id) {
    ui.notifications.warn("Для посадки нужен выбранный актёр с правами владельца.");
    return false;
  }
  if (isActorInActorContainer(passengerActor)) {
    ui.notifications.warn(`${passengerActor.name}: уже находится в транспорте.`);
    return false;
  }
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.warn("Сцена не готова для посадки в транспорт.");
    return false;
  }
  if (!game.user?.isGM && !getResponsibleGM()) {
    ui.notifications.warn("Нет активного GM для посадки в транспорт.");
    return false;
  }

  cancelActorContainerExitPlacement();
  cancelActorContainerBoardingMode();
  activeBoardingMode = {
    actor: passengerActor,
    token: passengerToken,
    actorUuid: passengerActor.uuid,
    tokenId: passengerToken.id,
    sceneId: canvas.scene.id,
    inputShield: createCanvasInputShield("pointer")
  };
  bindCanvasInput(activeBoardingMode, onBoardingCanvasEvent);
  window.addEventListener("keydown", onBoardingKeyDown, { capture: true });
  refreshActorContainerHighlights();
  ui.notifications.info("Посадка в транспорт: выберите подсвеченный транспорт. Esc/ПКМ отменяет.");
  return true;
}

export function startActorContainerPassengerExitPlacement({ vehicleActor = null, passengerId = "" } = {}) {
  const passenger = getActorContainerFlag(vehicleActor).passengers.find(entry => entry.id === passengerId);
  if (!vehicleActor?.isOwner || !passenger) return false;
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.warn("Сцена не готова для выхода из транспорта.");
    return false;
  }
  if (!game.user?.isGM && !getResponsibleGM()) {
    ui.notifications.warn("Нет активного GM для выхода из транспорта.");
    return false;
  }

  cancelActorContainerBoardingMode();
  cancelActorContainerExitPlacement();
  activeExitPlacement = {
    vehicleActorUuid: vehicleActor.uuid,
    passengerId,
    tokenData: foundry.utils.deepClone(passenger.tokenData ?? {}),
    previewImage: String(passenger.tokenData?.texture?.src ?? passenger.actorImg ?? "icons/svg/mystery-man.svg"),
    preview: null,
    inputShield: createCanvasInputShield("crosshair"),
    previewPoint: null
  };
  void createActorContainerExitPreview(activeExitPlacement);
  bindCanvasInput(activeExitPlacement, onExitPlacementCanvasEvent, { pointerMove: true });
  window.addEventListener("keydown", onExitPlacementKeyDown, { capture: true });
  refreshActorContainerExitPreview();
  ui.notifications.info("Выход из транспорта: выберите точку размещения. Esc/ПКМ отменяет.");
  return true;
}

export function prepareHudActorContainerPassengers(actor = null) {
  return getActorContainerFlag(actor).passengers.map(passenger => ({
    id: passenger.id,
    name: passenger.actorName || passenger.actorUuid,
    img: passenger.actorImg || "icons/svg/mystery-man.svg",
    sizeLabel: `${passenger.width} / ${passenger.height}`
  }));
}

export function actorHasHudActorContainerPassengers(actor = null) {
  return getActorContainerFlag(actor).passengers.length > 0;
}

export async function openActorContainerPassengerSheet({ vehicleActor = null, passengerId = "" } = {}) {
  const actor = await resolveActorContainerPassengerActor(vehicleActor, passengerId);
  if (!actor) {
    ui.notifications.warn("Не удалось найти актера пассажира.");
    return false;
  }
  if (!actor.testUserPermission?.(game.user, "OBSERVER")) {
    ui.notifications.warn("Нет прав наблюдателя на этого пассажира.");
    return false;
  }
  actor.sheet?.render?.(true);
  return true;
}

async function onBoardingPointerDown(event) {
  if (!activeBoardingMode || event.button !== 0) return;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  const vehicleToken = getActorContainerTokenAtPoint(point, activeBoardingMode);
  if (!vehicleToken) {
    ui.notifications.warn("Выберите подсвеченный транспорт.");
    return;
  }
  const request = {
    sceneId: activeBoardingMode.sceneId,
    passengerActorUuid: activeBoardingMode.actorUuid,
    passengerTokenId: activeBoardingMode.tokenId,
    vehicleActorUuid: vehicleToken.actor.uuid
  };
  cancelActorContainerBoardingMode();
  try {
    await requestActorContainerSocket("boardPassenger", request);
  } catch (error) {
    ui.notifications.warn(error.message);
  }
}

function onBoardingCanvasEvent(event) {
  if (!activeBoardingMode) return;
  stopCanvasInputEvent(event);
  if (event.type === "contextmenu" || event.button === 2) {
    cancelActorContainerBoardingMode({ notify: true });
    return;
  }
  if (event.type === "pointerdown" || event.type === "mousedown") void onBoardingPointerDown(event);
}

function onBoardingKeyDown(event) {
  if (!activeBoardingMode || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  cancelActorContainerBoardingMode({ notify: true });
}

function cancelActorContainerBoardingMode({ notify = false } = {}) {
  if (!activeBoardingMode) {
    refreshActorContainerHighlights();
    return;
  }
  const mode = activeBoardingMode;
  activeBoardingMode = null;
  unbindCanvasInput(mode);
  window.removeEventListener("keydown", onBoardingKeyDown, { capture: true });
  refreshActorContainerHighlights();
  if (notify) ui.notifications.info("Посадка в транспорт отменена.");
}

function onExitPlacementCanvasEvent(event) {
  if (!activeExitPlacement) return;
  stopCanvasInputEvent(event);
  if (event.type === "contextmenu" || event.button === 2) {
    cancelActorContainerExitPlacement({ notify: true });
    return;
  }
  if (event.type === "pointermove") {
    activeExitPlacement.previewPoint = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    refreshActorContainerExitPreview();
    return;
  }
  if (event.type !== "pointerdown" && event.type !== "mousedown") return;
  if (event.button !== 0) return;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  const placement = getTokenPlacementAtPoint(activeExitPlacement.tokenData, point);
  const request = {
    sceneId: canvas.scene.id,
    vehicleActorUuid: activeExitPlacement.vehicleActorUuid,
    passengerId: activeExitPlacement.passengerId,
    placement
  };
  cancelActorContainerExitPlacement();
  void requestActorContainerSocket("exitPassenger", request).catch(error => {
    ui.notifications.warn(error.message);
  });
}

function onExitPlacementKeyDown(event) {
  if (!activeExitPlacement || event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  cancelActorContainerExitPlacement({ notify: true });
}

function cancelActorContainerExitPlacement({ notify = false } = {}) {
  if (!activeExitPlacement) {
    refreshActorContainerExitPreview();
    return;
  }
  const placement = activeExitPlacement;
  activeExitPlacement = null;
  unbindCanvasInput(placement);
  window.removeEventListener("keydown", onExitPlacementKeyDown, { capture: true });
  destroyActorContainerExitPreview(placement);
  refreshActorContainerExitPreview();
  if (notify) ui.notifications.info("Выход из транспорта отменен.");
}

function refreshActorContainerHighlights() {
  const grid = canvas?.interface?.grid;
  if (!canvas?.ready || !grid) return;
  const layer = grid.getHighlightLayer?.(ACTOR_CONTAINER_HIGHLIGHT_LAYER)
    ?? grid.addHighlightLayer?.(ACTOR_CONTAINER_HIGHLIGHT_LAYER);
  layer?.clear?.();
  if (!layer || !activeBoardingMode) return;
  for (const token of canvas.tokens?.placeables ?? []) {
    if (!isTokenAvailableForBoarding(token, activeBoardingMode)) continue;
    drawTokenOutline(layer, token, ACTOR_CONTAINER_HIGHLIGHT_COLOR);
  }
}

function refreshActorContainerExitPreview() {
  const grid = canvas?.interface?.grid;
  const layer = canvas?.ready && grid
    ? grid.getHighlightLayer?.(ACTOR_CONTAINER_PLACEMENT_LAYER)
      ?? grid.addHighlightLayer?.(ACTOR_CONTAINER_PLACEMENT_LAYER)
    : null;
  layer?.clear?.();
  if (activeExitPlacement?.preview?.container) {
    activeExitPlacement.preview.container.visible = Boolean(activeExitPlacement.previewPoint);
  }
  if (!canvas?.ready || !activeExitPlacement?.previewPoint) return;
  const placement = getTokenPlacementAtPoint(activeExitPlacement.tokenData, activeExitPlacement.previewPoint);
  const size = getTokenPixelSize(activeExitPlacement.tokenData);
  updateActorContainerExitPreview(activeExitPlacement, placement, size);
}

async function createActorContainerExitPreview(session) {
  const layer = canvas?.controls?._rulerPaths ?? canvas?.stage;
  if (!layer || !session) return;
  const container = new PIXI.Container();
  container.eventMode = "none";
  container.interactive = false;
  container.interactiveChildren = false;
  container.visible = false;
  const frame = new PIXI.Graphics();
  container.addChild(frame);
  layer.addChild(container);
  session.preview = { container, frame, sprite: null };

  try {
    const texture = await foundry.canvas.loadTexture(session.previewImage);
    if (activeExitPlacement !== session || !session.preview?.container || !texture?.valid) return;
    const sprite = new PIXI.Sprite(texture);
    session.preview.sprite = sprite;
    session.preview.container.addChildAt(sprite, 0);
    refreshActorContainerExitPreview();
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Actor container exit preview texture failed to load: ${session.previewImage}`, error);
  }
}

function updateActorContainerExitPreview(session, placement, size) {
  const preview = session?.preview;
  if (!preview?.container) return;
  preview.container.visible = true;
  preview.container.position.set(placement.x, placement.y);
  preview.frame.clear();
  preview.frame.lineStyle(2, ACTOR_CONTAINER_PLACEMENT_COLOR, 0.9);
  preview.frame.drawRect(0, 0, size.width, size.height);
  if (!preview.sprite) return;
  resizeActorContainerExitPreviewSprite(preview.sprite, session.tokenData, size);
  preview.sprite.angle = Number(session.tokenData?.rotation) || 0;
}

function resizeActorContainerExitPreviewSprite(sprite, tokenData = {}, size = {}) {
  const textureData = tokenData.texture ?? {};
  const textureWidth = Math.max(1, Number(sprite.texture?.width) || 1);
  const textureHeight = Math.max(1, Number(sprite.texture?.height) || 1);
  const baseWidth = Math.max(1, Number(size.width) || 1);
  const baseHeight = Math.max(1, Number(size.height) || 1);
  const fit = ["fill", "cover", "contain", "width", "height"].includes(String(textureData.fit ?? ""))
    ? String(textureData.fit)
    : "contain";
  let scaleX;
  let scaleY;
  if (fit === "fill") {
    scaleX = baseWidth / textureWidth;
    scaleY = baseHeight / textureHeight;
  } else if (fit === "cover") {
    scaleX = scaleY = Math.max(baseWidth / textureWidth, baseHeight / textureHeight);
  } else if (fit === "width") {
    scaleX = scaleY = baseWidth / textureWidth;
  } else if (fit === "height") {
    scaleX = scaleY = baseHeight / textureHeight;
  } else {
    scaleX = scaleY = Math.min(baseWidth / textureWidth, baseHeight / textureHeight);
  }
  scaleX *= Number(textureData.scaleX) || 1;
  scaleY *= Number(textureData.scaleY) || 1;
  const anchorX = Number(textureData.anchorX);
  const anchorY = Number(textureData.anchorY);
  const tokenAlpha = Number(tokenData.alpha);
  sprite.anchor.set(Number.isFinite(anchorX) ? anchorX : 0.5, Number.isFinite(anchorY) ? anchorY : 0.5);
  sprite.position.set(baseWidth / 2, baseHeight / 2);
  sprite.scale.set(scaleX, scaleY);
  sprite.alpha = 0.55 * Math.max(0, Math.min(1, Number.isFinite(tokenAlpha) ? tokenAlpha : 1));
  if (textureData.tint) sprite.tint = textureData.tint;
}

function destroyActorContainerExitPreview(session) {
  const preview = session?.preview;
  if (!preview?.container) return;
  preview.container.destroy({ children: true, texture: false, baseTexture: false });
  session.preview = null;
}

function isTokenAvailableForBoarding(token, session) {
  const passengerActor = session.actor ?? getActorByUuid(session.actorUuid);
  const passengerToken = session.token
    ?? canvas.tokens?.get?.(session.tokenId)?.document
    ?? canvas.scene?.tokens?.get?.(session.tokenId)
    ?? null;
  const actor = token?.actor;
  if (!actor || token.visible === false || token.renderable === false) return false;
  if (!passengerActor || !passengerToken || actor.uuid === passengerActor.uuid) return false;
  if (!hasActorContainer(actor)) return false;
  return Boolean(findFirstAvailableActorContainerSeat(actor, passengerActor, passengerToken));
}

function getActorContainerTokenAtPoint(point, session) {
  return (canvas.tokens?.placeables ?? [])
    .slice()
    .reverse()
    .find(token => isTokenAvailableForBoarding(token, session) && pointInToken(point, token)) ?? null;
}

function pointInToken(point, token) {
  const rect = getTokenRect(token);
  return (
    point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
  );
}

function drawTokenOutline(layer, token, color) {
  const rect = getTokenRect(token);
  const width = Math.max(2, CONFIG.Canvas.objectBorderThickness * canvas.dimensions.uiScale);
  layer.lineStyle(width, color, 0.95);
  layer.beginFill(color, 0.12);
  layer.drawRect(rect.x, rect.y, rect.width, rect.height);
  layer.endFill();
}

function getTokenRect(token) {
  const document = token?.document ?? token;
  const size = document?.getSize?.() ?? {
    width: Math.max(1, Number(document?.width) || 1) * canvas.grid.size,
    height: Math.max(1, Number(document?.height) || 1) * canvas.grid.size
  };
  return {
    x: Number(document?.x) || 0,
    y: Number(document?.y) || 0,
    width: Math.max(1, Number(size.width) || canvas.grid.size),
    height: Math.max(1, Number(size.height) || canvas.grid.size)
  };
}

function getTokenPixelSize(tokenData = {}) {
  const width = Math.max(0.5, Number(tokenData?.width) || 1);
  const height = Math.max(0.5, Number(tokenData?.height) || 1);
  return {
    width: width * canvas.grid.sizeX,
    height: height * canvas.grid.sizeY
  };
}

function getTokenPlacementAtPoint(tokenData = {}, point = {}) {
  const size = getTokenPixelSize(tokenData);
  const topLeft = {
    x: (Number(point?.x) || 0) - (size.width / 2),
    y: (Number(point?.y) || 0) - (size.height / 2)
  };
  const snapped = getSnappedTokenPosition(tokenData, topLeft);
  return {
    x: Math.round(snapped.x),
    y: Math.round(snapped.y)
  };
}

function getSnappedTokenPosition(tokenData = {}, position = {}) {
  const source = { x: Number(position?.x) || 0, y: Number(position?.y) || 0 };
  if (canvas.grid?.getSnappedPoint && !canvas.grid.isGridless && canvas.grid.isSquare) {
    const width = Math.max(0.5, Math.round((Number(tokenData?.width) || 1) * 2) / 2);
    const height = Math.max(0.5, Math.round((Number(tokenData?.height) || 1) * 2) / 2);
    const smallTokenPosition = getSmallSquareTokenPosition(source, width, height);
    if (smallTokenPosition) return smallTokenPosition;
    const modes = CONST.GRID_SNAPPING_MODES;
    const modeX = Number.isInteger(width) ? modes.VERTEX : modes.VERTEX | modes.EDGE_MIDPOINT | modes.CENTER;
    const modeY = Number.isInteger(height) ? modes.VERTEX : modes.VERTEX | modes.EDGE_MIDPOINT | modes.CENTER;
    if (modeX === modeY) return canvas.grid.getSnappedPoint(source, { mode: modeX, resolution: 1 });
    return {
      x: canvas.grid.getSnappedPoint(source, { mode: modeX, resolution: 1 }).x,
      y: canvas.grid.getSnappedPoint(source, { mode: modeY, resolution: 1 }).y
    };
  }
  return {
    x: Math.round(source.x / canvas.grid.sizeX) * canvas.grid.sizeX,
    y: Math.round(source.y / canvas.grid.sizeY) * canvas.grid.sizeY
  };
}

function getSmallSquareTokenPosition(position = {}, width = 1, height = 1) {
  const isSmall = ((width === 0.5) && (height <= 1)) || ((width <= 1) && (height === 0.5));
  if (!isSmall) return null;
  let x = position.x / canvas.grid.size;
  let y = position.y / canvas.grid.size;
  if (width === 1) x = Math.round(x);
  else x = snapSmallSquareTokenCoordinate(x);
  if (height === 1) y = Math.round(y);
  else y = snapSmallSquareTokenCoordinate(y);
  return {
    x: x * canvas.grid.size,
    y: y * canvas.grid.size
  };
}

function snapSmallSquareTokenCoordinate(value = 0) {
  let coordinate = Math.floor(value * 8);
  const remainder = ((coordinate % 8) + 8) % 8;
  if (remainder >= 6) coordinate = Math.ceil(coordinate / 8);
  else if (remainder === 5) coordinate = Math.floor(coordinate / 8) + 0.5;
  else coordinate = Math.round(coordinate / 2) / 4;
  return coordinate;
}

async function performBoardPassenger({ sceneId = "", passengerActorUuid = "", passengerTokenId = "", vehicleActorUuid = "" } = {}, requesterUserId = "") {
  const scene = game.scenes?.get(sceneId);
  const passengerActor = await fromUuid(passengerActorUuid);
  const vehicleActor = await fromUuid(vehicleActorUuid);
  const passengerToken = scene?.tokens?.get(passengerTokenId);
  const requester = requesterUserId ? game.users?.get(requesterUserId) : game.user;
  if (!scene || !passengerActor || !vehicleActor || !passengerToken) throw new Error("Не удалось найти актера, транспорт или токен.");
  if (!requester?.isGM && !passengerActor.testUserPermission?.(requester, "OWNER")) throw new Error("Нет прав на пассажира.");
  if (passengerActor.uuid === vehicleActor.uuid) throw new Error("Актер не может сесть сам в себя.");
  if (isActorInActorContainer(passengerActor)) throw new Error("Актер уже находится в транспорте.");
  const seat = findFirstAvailableActorContainerSeat(vehicleActor, passengerActor, passengerToken);
  if (!seat) throw new Error("В транспорте нет подходящего свободного места.");

  const ownershipUpdate = getTemporaryOwnershipUpdate(vehicleActor, passengerActor);
  const passenger = {
    id: foundry.utils.randomID(),
    actorUuid: passengerActor.uuid,
    actorName: passengerActor.name,
    actorImg: passengerActor.img,
    sceneId,
    tokenData: passengerToken.toObject(),
    slotId: seat.slotId,
    slotIndex: seat.slotIndex,
    x: seat.passengerX,
    y: seat.passengerY,
    width: seat.passengerWidth,
    height: seat.passengerHeight,
    temporaryOwnerUserIds: ownershipUpdate.userIds,
    temporaryOwnerLevels: ownershipUpdate.previousLevels
  };
  const passengers = [...getActorContainerFlag(vehicleActor).passengers, passenger];
  const originalOwnership = foundry.utils.deepClone(vehicleActor.ownership ?? {});
  const originalPassengers = getActorContainerFlag(vehicleActor).passengers;
  try {
    await vehicleActor.update({
      ...ownershipUpdate.update,
      [`flags.${SYSTEM_ID}.${ACTOR_CONTAINER_FLAG}.passengers`]: passengers
    });
    await scene.deleteEmbeddedDocuments("Token", [passengerToken.id]);
  } catch (error) {
    await vehicleActor.update({
      ownership: originalOwnership,
      [`flags.${SYSTEM_ID}.${ACTOR_CONTAINER_FLAG}.passengers`]: originalPassengers
    }).catch(() => {});
    throw error;
  }
  return { ok: true };
}

async function performExitPassenger({ sceneId = "", vehicleActorUuid = "", passengerId = "", placement = {} } = {}, requesterUserId = "") {
  const scene = game.scenes?.get(sceneId);
  const vehicleActor = await fromUuid(vehicleActorUuid);
  const requester = requesterUserId ? game.users?.get(requesterUserId) : game.user;
  if (!scene || !vehicleActor) throw new Error("Не удалось найти сцену или транспорт.");
  if (!requester?.isGM && !vehicleActor.testUserPermission?.(requester, "OWNER")) throw new Error("Нет прав на транспорт.");

  const passengers = getActorContainerFlag(vehicleActor).passengers;
  const passenger = passengers.find(entry => entry.id === passengerId);
  if (!passenger?.tokenData) throw new Error("Пассажир не найден.");

  const tokenData = foundry.utils.deepClone(passenger.tokenData);
  delete tokenData._id;
  tokenData.x = Math.round(Number(placement.x) || 0);
  tokenData.y = Math.round(Number(placement.y) || 0);
  tokenData.hidden = false;
  const remaining = passengers.filter(entry => entry.id !== passengerId);
  const ownershipUpdate = getTemporaryOwnershipCleanupUpdate(vehicleActor, passenger, remaining);
  let createdToken = null;
  try {
    [createdToken] = await scene.createEmbeddedDocuments("Token", [tokenData]);
    if (!createdToken) throw new Error("Не удалось создать токен пассажира.");
    await vehicleActor.update({
      ...ownershipUpdate,
      [`flags.${SYSTEM_ID}.${ACTOR_CONTAINER_FLAG}.passengers`]: remaining
    });
  } catch (error) {
    if (createdToken) await scene.deleteEmbeddedDocuments("Token", [createdToken.id]).catch(() => {});
    throw error;
  }
  return { ok: true };
}

function getTemporaryOwnershipUpdate(vehicleActor, passengerActor) {
  const update = {};
  const userIds = [];
  const previousLevels = {};
  const ownership = foundry.utils.deepClone(vehicleActor.ownership ?? {});
  const existingPassengers = getActorContainerFlag(vehicleActor).passengers;
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  for (const user of game.users?.contents ?? []) {
    if (!user || user.isGM || !passengerActor.testUserPermission?.(user, "OWNER")) continue;
    const explicit = ownership[user.id];
    const current = vehicleActor.getUserLevel?.(user)
      ?? ownership[user.id]
      ?? ownership.default
      ?? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
    if (current >= ownerLevel) {
      const temporarySource = findTemporaryOwnershipSource(existingPassengers, user.id);
      if (!temporarySource) continue;
      userIds.push(user.id);
      if (Object.hasOwn(temporarySource.temporaryOwnerLevels ?? {}, user.id)) {
        previousLevels[user.id] = temporarySource.temporaryOwnerLevels[user.id];
      }
      continue;
    }
    userIds.push(user.id);
    if (explicit !== undefined) previousLevels[user.id] = explicit;
    ownership[user.id] = ownerLevel;
  }
  if (userIds.length) update.ownership = ownership;
  return { update, userIds, previousLevels };
}

function getTemporaryOwnershipCleanupUpdate(vehicleActor, removedPassenger, remainingPassengers = []) {
  const update = {};
  const ownership = foundry.utils.deepClone(vehicleActor.ownership ?? {});
  const activeTemporaryUsers = new Set(remainingPassengers.flatMap(passenger => passenger.temporaryOwnerUserIds ?? []));
  for (const userId of removedPassenger.temporaryOwnerUserIds ?? []) {
    if (activeTemporaryUsers.has(userId)) continue;
    if (Object.hasOwn(removedPassenger.temporaryOwnerLevels ?? {}, userId)) ownership[userId] = removedPassenger.temporaryOwnerLevels[userId];
    else delete ownership[userId];
  }
  update.ownership = ownership;
  return update;
}

function findTemporaryOwnershipSource(passengers, userId) {
  const sources = (passengers ?? []).filter(passenger => passenger.temporaryOwnerUserIds?.includes(userId));
  return sources.find(passenger => Object.hasOwn(passenger.temporaryOwnerLevels ?? {}, userId)) ?? sources[0] ?? null;
}

function createCanvasInputShield(cursor = "pointer") {
  if (!document.body) return null;
  if (canvas?.currentMouseManager) {
    if (canvas.currentMouseManager.interactionData) canvas.currentMouseManager.interactionData.cancelled = true;
    canvas.currentMouseManager.cancel();
  }
  const shield = document.createElement("div");
  shield.dataset.falloutMawActorContainerInputShield = "true";
  Object.assign(shield.style, {
    position: "fixed",
    inset: "0",
    zIndex: "100000",
    background: "transparent",
    cursor,
    pointerEvents: "auto"
  });
  document.body.appendChild(shield);
  return shield;
}

function bindCanvasInput(session, listener, { pointerMove = false } = {}) {
  if (!session || typeof listener !== "function") return;
  const targets = [canvas?.app?.view, session.inputShield].filter(Boolean);
  const types = pointerMove
    ? ["pointermove", ...BLOCKED_CANVAS_EVENT_TYPES]
    : [...BLOCKED_CANVAS_EVENT_TYPES];
  for (const target of targets) {
    for (const type of types) target.addEventListener(type, listener, true);
  }
  session.canvasInputBinding = { targets, types, listener };
}

function unbindCanvasInput(session, { delay = 300 } = {}) {
  const binding = session?.canvasInputBinding;
  const shield = session?.inputShield;
  if (session) {
    session.canvasInputBinding = null;
    session.inputShield = null;
  }
  const cleanup = () => {
    if (binding) {
      for (const target of binding.targets) {
        for (const type of binding.types) target.removeEventListener(type, binding.listener, true);
      }
    }
    shield?.remove?.();
  };
  if (delay > 0) window.setTimeout(cleanup, delay);
  else cleanup();
}

function stopCanvasInputEvent(event) {
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
}

async function requestActorContainerSocket(action, payload = {}, gm = getResponsibleGM()) {
  if (game.user?.isGM) return queueActorContainerSocketRequest(action, payload, game.user.id);
  if (!gm) throw new Error("Нет активного GM.");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("GM не ответил на запрос транспорта."));
    }, ACTOR_CONTAINER_SOCKET_TIMEOUT);
    pendingRequests.set(requestId, { resolve, reject, timeout });
  });
  game.socket.emit(ACTOR_CONTAINER_SOCKET, {
    scope: ACTOR_CONTAINER_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleActorContainerSocketMessage(message = {}) {
  if (message?.scope !== ACTOR_CONTAINER_SOCKET_SCOPE) return;
  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Запрос транспорта не выполнен."));
    return;
  }
  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
  try {
    const result = await queueActorContainerSocketRequest(message.action, message.payload ?? {}, message.requesterUserId ?? "");
    game.socket.emit(ACTOR_CONTAINER_SOCKET, {
      scope: ACTOR_CONTAINER_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Actor container socket request failed`, error);
    game.socket.emit(ACTOR_CONTAINER_SOCKET, {
      scope: ACTOR_CONTAINER_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

function queueActorContainerSocketRequest(action, payload = {}, requesterUserId = "") {
  const task = actorContainerRequestQueue.then(() => handleActorContainerSocketRequest(action, payload, requesterUserId));
  actorContainerRequestQueue = task.catch(() => {});
  return task;
}

async function handleActorContainerSocketRequest(action, payload = {}, requesterUserId = "") {
  if (action === "boardPassenger") return performBoardPassenger(payload, requesterUserId);
  if (action === "exitPassenger") return performExitPassenger(payload, requesterUserId);
  return undefined;
}

function getActorByUuid(uuid = "") {
  const id = String(uuid ?? "");
  if (!id) return null;
  return globalThis.fromUuidSync?.(id) ?? foundry.utils.fromUuidSync?.(id) ?? null;
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}
