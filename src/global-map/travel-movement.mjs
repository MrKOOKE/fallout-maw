import { FALLOUT_MAW } from "../config/system-config.mjs";
import { GLOBAL_MAP_SOCKET, TRAVEL_GROUP_FLAG } from "./constants.mjs";
import { cellKey, getCellPath, pointToCell } from "./geometry.mjs";
import { getSceneState } from "./storage.mjs";
import { calculateTravelGroupSpeed, isTravelGroupCarrierActor } from "./travel-group-data.mjs";

const ARM_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const ACTION_ARM = "travelGroup.movement.arm";
const ACTION_ARM_RESULT = "travelGroup.movement.armResult";
const ACTION_DISARM = "travelGroup.movement.disarm";
const ACTION_COMPLETE = "travelGroup.movement.complete";
const pendingArmRequests = new Map();
const gmArmedMovements = new Map();
let localArmedMovement = null;
let localExpiryTimer = 0;
let hooksRegistered = false;

export function registerTravelMovementHooks() {
  if (hooksRegistered) return;
  Hooks.on("preMoveToken", validateArmedTravelMovement);
  Hooks.on("moveToken", processCompletedTravelMovement);
  Hooks.on("canvasTearDown", () => void disarmTravelMovement());
  hooksRegistered = true;
}

export function registerTravelMovementSocket() {
  game.socket.on(GLOBAL_MAP_SOCKET, handleTravelMovementSocket);
}

export function isTravelMovementArmed(token = null) {
  if (!localArmedMovement || localArmedMovement.expiresAt <= Date.now()) return false;
  if (!token) return true;
  const document = token.document ?? token;
  return localArmedMovement.sceneId === document.parent?.id && localArmedMovement.tokenId === document.id;
}

export function getTravelMovementPreview(token = null, waypoint = null) {
  const tokenDocument = token?.document ?? token;
  if (!tokenDocument?.parent || !waypoint || !isTravelMovementArmed(tokenDocument)) return null;
  const positions = [];
  let current = waypoint;
  while (current) {
    positions.push(current);
    current = current.previous;
  }
  positions.reverse();
  const cells = cellsFromPositions(tokenDocument.parent, tokenDocument, positions);
  const blocked = findImpassableEntry(tokenDocument.parent, cells);
  const metrics = calculateTravelMetrics(tokenDocument.parent, cells, localArmedMovement?.speedKmh);
  return {
    blocked,
    distanceKm: metrics.distanceKm,
    seconds: metrics.seconds,
    distanceLabel: formatTravelDistance(metrics.distanceKm),
    timeLabel: blocked ? "Вход запрещён" : formatTravelDuration(metrics.seconds / 3600)
  };
}

export async function armTravelMovement(token = null) {
  const document = token?.document ?? token;
  const actor = document?.actor;
  if (!document?.parent || !isTravelGroupCarrierActor(actor)) return false;
  if (!actor.testUserPermission?.(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
    ui.notifications.warn("Нет прав на перемещение этой путешествующей группы.");
    return false;
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Путешествие недоступно: нет активного GM.");
    return false;
  }
  const payload = {
    action: ACTION_ARM,
    requestId: foundry.utils.randomID(),
    requestingUserId: game.user.id,
    sceneId: document.parent.id,
    tokenId: document.id
  };
  const result = isResponsibleGM()
    ? await handleArmRequest(payload)
    : await requestRemoteArm(payload);
  if (!result?.success) {
    ui.notifications.warn(result?.message || "Не удалось подготовить перемещение группы.");
    return false;
  }
  setLocalArmedMovement({
    sceneId: payload.sceneId,
    tokenId: payload.tokenId,
    speedKmh: result.speedKmh,
    expiresAt: Number(result.expiresAt) || (Date.now() + ARM_TIMEOUT_MS)
  });
  return true;
}

export async function disarmTravelMovement({ notifyGM = true } = {}) {
  const current = localArmedMovement;
  clearLocalArmedMovement();
  if (!current || !notifyGM) return false;
  const payload = {
    action: ACTION_DISARM,
    requestingUserId: game.user?.id,
    sceneId: current.sceneId,
    tokenId: current.tokenId
  };
  if (isResponsibleGM()) handleDisarmRequest(payload);
  else if (getResponsibleGM()) game.socket.emit(GLOBAL_MAP_SOCKET, payload);
  return true;
}

function requestRemoteArm(payload) {
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      pendingArmRequests.delete(payload.requestId);
      resolve({ success: false, message: "GM не подтвердил режим путешествия." });
    }, REQUEST_TIMEOUT_MS);
    pendingArmRequests.set(payload.requestId, { resolve, timeout });
    game.socket.emit(GLOBAL_MAP_SOCKET, payload);
  });
}

async function handleTravelMovementSocket(payload = {}) {
  if (!payload || typeof payload !== "object") return;
  if (payload.action === ACTION_ARM && isResponsibleGM()) {
    const result = await handleArmRequest(payload).catch(error => ({ success: false, message: error.message }));
    game.socket.emit(GLOBAL_MAP_SOCKET, {
      action: ACTION_ARM_RESULT,
      requestId: payload.requestId,
      requestingUserId: payload.requestingUserId,
      ...result
    });
    return;
  }
  if (payload.action === ACTION_ARM_RESULT && payload.requestingUserId === game.user?.id) {
    const pending = pendingArmRequests.get(payload.requestId);
    if (!pending) return;
    pendingArmRequests.delete(payload.requestId);
    window.clearTimeout(pending.timeout);
    pending.resolve(payload);
    return;
  }
  if (payload.action === ACTION_DISARM && isResponsibleGM()) {
    handleDisarmRequest(payload);
    return;
  }
  if (payload.action === ACTION_COMPLETE && payload.requestingUserId === game.user?.id) {
    clearLocalArmedMovement();
    if (payload.message) ui.notifications.info(payload.message);
  }
}

async function handleArmRequest(payload) {
  const scene = game.scenes?.get(payload.sceneId);
  const token = scene?.tokens?.get(payload.tokenId);
  const user = game.users?.get(payload.requestingUserId);
  if (!scene || !token?.actor || !user || !isTravelGroupCarrierActor(token.actor)) {
    throw new Error("Путешествующая группа не найдена.");
  }
  if (!user.isGM && !token.actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
    throw new Error("Нет прав на перемещение этой группы.");
  }
  const speedKmh = await calculateTravelGroupSpeed(token.actor);
  if (!(speedKmh > 0)) throw new Error("Скорость группы должна быть больше нуля.");
  const expiresAt = Date.now() + ARM_TIMEOUT_MS;
  const key = armKey(scene.id, token.id, user.id);
  gmArmedMovements.set(key, { speedKmh, expiresAt });
  window.setTimeout(() => {
    const current = gmArmedMovements.get(key);
    if (current?.expiresAt === expiresAt) gmArmedMovements.delete(key);
  }, ARM_TIMEOUT_MS);
  return { success: true, speedKmh, expiresAt };
}

function handleDisarmRequest(payload) {
  gmArmedMovements.delete(armKey(payload.sceneId, payload.tokenId, payload.requestingUserId));
}

function validateArmedTravelMovement(tokenDocument, movement) {
  if (!isTravelMovementArmed(tokenDocument)) return undefined;
  const cells = movementCells(tokenDocument.parent, tokenDocument, movement, "pending");
  const blocked = findImpassableEntry(tokenDocument.parent, cells);
  if (blocked) {
    ui.notifications.warn(`Вход в местность «${blocked.name || "Непроходимая местность"}» запрещён.`);
    void disarmTravelMovement();
    return false;
  }
  if (!(localArmedMovement?.speedKmh > 0)) {
    ui.notifications.warn("Скорость группы должна быть больше нуля.");
    void disarmTravelMovement();
    return false;
  }
  movement.showRuler = true;
  return undefined;
}

async function processCompletedTravelMovement(tokenDocument, movement, _operation, user) {
  if (!isResponsibleGM() || !user?.id) return;
  const key = armKey(tokenDocument.parent?.id, tokenDocument.id, user.id);
  const armed = gmArmedMovements.get(key);
  if (!armed) return;
  gmArmedMovements.delete(key);
  if (armed.expiresAt <= Date.now() || !isTravelGroupCarrierActor(tokenDocument.actor)) return;
  const finished = await movement.finished;
  if (!finished) return emitMovementComplete(user.id, "Перемещение группы отменено.");
  const cells = movementCells(tokenDocument.parent, tokenDocument, movement, "passed");
  const blocked = findImpassableEntry(tokenDocument.parent, cells);
  if (blocked) return emitMovementComplete(user.id, "Маршрут пересекает непроходимую местность; время не изменено.");
  const speedKmh = await calculateTravelGroupSpeed(tokenDocument.actor);
  if (!(speedKmh > 0)) return emitMovementComplete(user.id, "Скорость группы равна нулю; время не изменено.");
  const { seconds } = calculateTravelMetrics(tokenDocument.parent, cells, speedKmh);
  if (seconds > 0) await game.time.advance(seconds);
  const hours = seconds / 3600;
  emitMovementComplete(user.id, seconds > 0
    ? `Путешествие заняло ${formatTravelDuration(hours)}.`
    : "Группа осталась в текущей клетке.");
}

function movementCells(scene, tokenDocument, movement, sectionKey) {
  if (!scene || !tokenDocument || !movement) return [];
  const section = movement?.[sectionKey] ?? {};
  const positions = [movement.origin, ...(section.waypoints ?? []), movement.destination].filter(Boolean);
  return cellsFromPositions(scene, tokenDocument, positions);
}

function cellsFromPositions(scene, tokenDocument, positions = []) {
  const cells = [];
  for (let index = 0; index < positions.length; index += 1) {
    const current = positionToTokenCell(scene, tokenDocument, positions[index]);
    if (!current) continue;
    if (!cells.length) {
      cells.push(current);
      continue;
    }
    const segment = getCellPath(scene, cells.at(-1), current);
    for (const cell of segment) {
      if (cellKey(cells.at(-1)) !== cellKey(cell)) cells.push(cell);
    }
  }
  return cells;
}

function positionToTokenCell(scene, tokenDocument, position) {
  const sizeX = Number(scene.grid?.sizeX ?? scene.grid?.size) || 100;
  const sizeY = Number(scene.grid?.sizeY ?? scene.grid?.size) || 100;
  return pointToCell(scene, {
    x: (Number(position.x) || 0) + ((Number(tokenDocument.width) || 1) * sizeX / 2),
    y: (Number(position.y) || 0) + ((Number(tokenDocument.height) || 1) * sizeY / 2)
  });
}

function findImpassableEntry(scene, cells = []) {
  if (cells.length < 2) return null;
  const terrainByCell = buildTerrainCellMap(scene);
  for (const cell of cells.slice(1)) {
    const terrain = terrainByCell.get(cellKey(cell));
    if ((Number(terrain?.difficulty) || 0) >= 100) return terrain;
  }
  return null;
}

function calculateTravelMetrics(scene, cells = [], speedKmh = 0) {
  if (cells.length < 2 || !(speedKmh > 0)) return { distanceKm: 0, seconds: 0 };
  const terrainByCell = buildTerrainCellMap(scene);
  let hours = 0;
  let distanceKm = 0;
  for (let index = 0; index < cells.length - 1; index += 1) {
    const terrain = terrainByCell.get(cellKey(cells[index]));
    const segmentDistanceKm = Math.max(0.01, Number(terrain?.cellAreaKm) || 5);
    const difficulty = Math.max(0, Math.min(100, Number(terrain?.difficulty) || 0));
    const adjustedSpeed = speedKmh * (1 - (difficulty / 100));
    if (!(adjustedSpeed > 0)) return { distanceKm, seconds: 0 };
    distanceKm += segmentDistanceKm;
    hours += segmentDistanceKm / adjustedSpeed;
  }
  return { distanceKm, seconds: Math.ceil(hours * 3600) };
}

function buildTerrainCellMap(scene) {
  const map = new Map();
  for (const terrain of getSceneState(scene).terrains ?? []) {
    for (const key of terrain.cells ?? []) map.set(String(key), terrain);
  }
  return map;
}

function setLocalArmedMovement(state) {
  localArmedMovement = state;
  window.clearTimeout(localExpiryTimer);
  localExpiryTimer = window.setTimeout(() => void disarmTravelMovement(), Math.max(0, state.expiresAt - Date.now()));
  Hooks.callAll("falloutMaWTravelMovementState", true, state);
}

function clearLocalArmedMovement() {
  if (!localArmedMovement) return;
  localArmedMovement = null;
  window.clearTimeout(localExpiryTimer);
  localExpiryTimer = 0;
  Hooks.callAll("falloutMaWTravelMovementState", false, null);
}

function emitMovementComplete(requestingUserId, message) {
  game.socket.emit(GLOBAL_MAP_SOCKET, { action: ACTION_COMPLETE, requestingUserId, message });
  if (requestingUserId === game.user?.id) {
    clearLocalArmedMovement();
    if (message) ui.notifications.info(message);
  }
}

function armKey(sceneId, tokenId, userId) {
  return `${sceneId ?? ""}:${tokenId ?? ""}:${userId ?? ""}`;
}

function formatTravelDuration(hours) {
  const totalMinutes = Math.ceil(Math.max(0, hours) * 60);
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!wholeHours) return `${minutes} мин.`;
  if (!minutes) return `${wholeHours} ч.`;
  return `${wholeHours} ч. ${minutes} мин.`;
}

function formatTravelDistance(distanceKm) {
  const value = Math.max(0, Number(distanceKm) || 0);
  return `${Number.isInteger(value) ? value : value.toFixed(2)} км`;
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
}

function isResponsibleGM() {
  return getResponsibleGM()?.id === game.user?.id;
}
