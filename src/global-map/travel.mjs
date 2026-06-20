import { FALLOUT_MAW } from "../config/system-config.mjs";
import { GLOBAL_MAP_SOCKET } from "./constants.mjs";
import { cellKey, pointToCell, tokenCenter, tokenTopLeftAtCell } from "./geometry.mjs";
import { findLocation, getSceneState } from "./storage.mjs";

const { DialogV2 } = foundry.applications.api;
const runtimeCells = new Map();

export function registerGlobalMapTravelHooks() {
  Hooks.on("updateToken", onTokenUpdated);
}

export function registerGlobalMapTravelSocket() {
  game.socket.on(GLOBAL_MAP_SOCKET, handleTravelSocket);
}

export async function requestTransitionTravel({
  originSceneId,
  transitionId,
  tokenIds,
  requestingUserId = game.user?.id
} = {}) {
  const payload = {
    action: "globalMap.travel.request",
    requestId: foundry.utils.randomID(),
    requestingUserId,
    originSceneId,
    transitionId,
    tokenIds: Array.from(new Set(tokenIds ?? []))
  };
  if (game.user?.isGM && isResponsibleGM()) return performTransitionTravel(payload);
  if (!getResponsibleGM()) {
    ui.notifications.warn("Переход недоступен: нет активного GM.");
    return false;
  }
  game.socket.emit(GLOBAL_MAP_SOCKET, payload);
  return true;
}

export async function travelToLocation(locationId, { tokenIds = null } = {}) {
  const found = findLocation(locationId);
  const targetScene = found?.location?.linkedSceneId ? game.scenes?.get(found.location.linkedSceneId) : null;
  if (!found || !targetScene) {
    ui.notifications.warn("У локации нет связанной сцены.");
    return false;
  }
  const ids = tokenIds ?? getDefaultTravelTokenIds();
  return requestDirectTravel({
    originSceneId: canvas.scene?.id,
    targetSceneId: targetScene.id,
    tokenIds: ids,
    requestingUserId: game.user?.id,
    anchorCells: []
  });
}

export async function requestDirectTravel(payload = {}) {
  const request = {
    action: "globalMap.travel.directRequest",
    requestId: foundry.utils.randomID(),
    requestingUserId: game.user?.id,
    ...payload
  };
  if (game.user?.isGM && isResponsibleGM()) return performDirectTravel(request);
  if (!getResponsibleGM()) {
    ui.notifications.warn("Переход недоступен: нет активного GM.");
    return false;
  }
  game.socket.emit(GLOBAL_MAP_SOCKET, request);
  return true;
}

async function onTokenUpdated(tokenDocument, changes, _options, userId) {
  if (userId !== game.user?.id || !canvas?.ready || tokenDocument.parent?.id !== canvas.scene?.id) return;
  if (changes.x === undefined && changes.y === undefined) return;
  const state = getSceneState(canvas.scene);
  const center = tokenCenter(tokenDocument, canvas.scene);
  const currentCell = pointToCell(canvas.scene, center);
  if (!currentCell) return;
  const runtimeKey = `${canvas.scene.id}:${tokenDocument.id}`;
  const key = cellKey(currentCell);
  const previous = runtimeCells.get(runtimeKey);
  runtimeCells.set(runtimeKey, key);
  if (previous === key) return;

  const transition = state.transitions.find(entry =>
    !entry.hidden && Array.isArray(entry.cells) && entry.cells.includes(key)
  );
  if (!transition) {
    const incoming = findIncomingTransition(tokenDocument, key);
    if (!incoming) return;
    const confirmedReturn = await DialogV2.confirm({
      window: { title: "Вернуться?" },
      content: `<p>Вернуться через <strong>${foundry.utils.escapeHTML(incoming.transition.name)}</strong>?</p>`,
      yes: { label: "Вернуться" },
      no: { label: "Остаться" }
    });
    if (!confirmedReturn) return;
    await requestDirectTravel({
      originSceneId: canvas.scene.id,
      targetSceneId: incoming.scene.id,
      tokenIds: getTriggeredTravelTokenIds(tokenDocument),
      requestingUserId: userId,
      anchorCells: incoming.transition.cells ?? []
    });
    return;
  }
  const confirmed = await DialogV2.confirm({
    window: { title: "Переход" },
    content: `<p>Перейти в <strong>${foundry.utils.escapeHTML(transition.name)}</strong>?</p>`,
    yes: { label: "Перейти" },
    no: { label: "Остаться" }
  });
  if (!confirmed) return;
  await requestTransitionTravel({
    originSceneId: canvas.scene.id,
    transitionId: transition.id,
    tokenIds: getTriggeredTravelTokenIds(tokenDocument),
    requestingUserId: userId
  });
}

async function handleTravelSocket(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.action === "globalMap.travel.request") {
    if (game.user?.isGM && isResponsibleGM()) await performTransitionTravel(payload);
  } else if (payload.action === "globalMap.travel.directRequest") {
    if (game.user?.isGM && isResponsibleGM()) await performDirectTravel(payload);
  } else if (payload.action === "globalMap.travel.complete") {
    if (!(payload.viewerUserIds ?? []).includes(game.user?.id)) return;
    const scene = game.scenes?.get(payload.targetSceneId);
    if (scene && canvas.scene?.id !== scene.id) await scene.view();
  } else if (payload.action === "globalMap.travel.error" && payload.requestingUserId === game.user?.id) {
    ui.notifications.error(payload.message || "Не удалось выполнить переход.");
  }
}

async function performTransitionTravel(payload) {
  const originScene = game.scenes?.get(payload.originSceneId);
  const transition = getSceneState(originScene).transitions.find(entry => entry.id === payload.transitionId);
  if (!originScene || !transition || transition.hidden) return emitTravelError(payload, "Переход не найден.");
  const targetScene = transition.targetSceneId ? game.scenes?.get(transition.targetSceneId) : null;
  if (!targetScene) return emitTravelError(payload, "Целевая сцена не найдена.");
  return performTravel({
    ...payload,
    originScene,
    targetScene,
    anchorCells: transition.entryCells ?? [],
    travelMeta: { fromTransitionId: transition.id }
  });
}

async function performDirectTravel(payload) {
  const originScene = game.scenes?.get(payload.originSceneId);
  const targetScene = game.scenes?.get(payload.targetSceneId);
  if (!originScene || !targetScene) return emitTravelError(payload, "Сцена перехода не найдена.");
  const requestingUser = game.users?.get(payload.requestingUserId);
  if (!requestingUser?.isGM && !isAuthorizedDirectTarget(originScene, targetScene, payload.tokenIds)) {
    return emitTravelError(payload, "Этот переход не связан с целевой сценой.");
  }
  return performTravel({ ...payload, originScene, targetScene, anchorCells: payload.anchorCells ?? [] });
}

async function performTravel({ originScene, targetScene, tokenIds, requestingUserId, requestId, anchorCells, travelMeta = {} }) {
  const requestingUser = game.users?.get(requestingUserId);
  const tokenDocuments = (tokenIds ?? [])
    .map(id => originScene.tokens?.get(id))
    .filter(token => token && canUserMoveToken(requestingUser, token));
  if (!tokenDocuments.length) return emitTravelError({ requestingUserId, requestId }, "Нет доступных токенов для перехода.");

  const createData = tokenDocuments.map((token, index) => {
    const data = token.toObject();
    delete data._id;
    delete data.id;
    const cell = selectAnchorCell(anchorCells, index, targetScene);
    const position = tokenTopLeftAtCell(targetScene, data, cell, index);
    data.x = position.x;
    data.y = position.y;
    foundry.utils.setProperty(data, `flags.${FALLOUT_MAW.id}.globalMapTravel`, {
      fromSceneId: originScene.id,
      toSceneId: targetScene.id,
      ...travelMeta,
      timestamp: Date.now()
    });
    return data;
  });

  let created = [];
  try {
    created = await targetScene.createEmbeddedDocuments("Token", createData);
    if (created.length !== createData.length) throw new Error("Not all target tokens were created.");
    await originScene.deleteEmbeddedDocuments("Token", tokenDocuments.map(token => token.id));
  } catch (error) {
    if (created.length) {
      await targetScene.deleteEmbeddedDocuments("Token", created.map(token => token.id)).catch(() => {});
    }
    console.error(`${FALLOUT_MAW.id} | Global-map travel failed`, error);
    return emitTravelError({ requestingUserId, requestId }, "Перенос токенов не завершён; исходные токены сохранены.");
  }

  const viewerUserIds = new Set([requestingUserId]);
  for (const token of tokenDocuments) {
    for (const user of game.users?.contents ?? []) {
      if (user.active && token.actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
        viewerUserIds.add(user.id);
      }
    }
  }
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.travel.complete",
    requestId,
    targetSceneId: targetScene.id,
    viewerUserIds: Array.from(viewerUserIds)
  });
  if (viewerUserIds.has(game.user.id) && canvas.scene?.id !== targetScene.id) await targetScene.view();
  return true;
}

function getTriggeredTravelTokenIds(triggerToken) {
  const controlled = canvas.tokens?.controlled ?? [];
  if (controlled.some(token => token.id === triggerToken.id)) {
    return controlled.map(token => token.id);
  }
  return [triggerToken.id];
}

function getDefaultTravelTokenIds() {
  const controlled = canvas.tokens?.controlled ?? [];
  return controlled.length ? controlled.map(token => token.id) : [];
}

function selectAnchorCell(keys, index, scene) {
  const parsed = keys.map(key => {
    const [i, j] = String(key).split(",").map(Number);
    return Number.isFinite(i) && Number.isFinite(j) ? { i, j } : null;
  }).filter(Boolean);
  if (parsed.length) return parsed[index % parsed.length];
  return pointToCell(scene, { x: scene.width / 2, y: scene.height / 2 }) ?? { i: 0, j: 0 };
}

function canUserMoveToken(user, token) {
  return Boolean(user?.isGM || token.actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
}

function findIncomingTransition(tokenDocument, key) {
  const travel = tokenDocument.getFlag?.(FALLOUT_MAW.id, "globalMapTravel");
  if (!travel?.fromSceneId || !travel?.fromTransitionId) return null;
  const sourceScene = game.scenes?.get(travel.fromSceneId);
  const transition = getSceneState(sourceScene).transitions.find(entry =>
    entry.id === travel.fromTransitionId
    && entry.targetSceneId === canvas.scene?.id
    && Array.isArray(entry.entryCells)
    && entry.entryCells.includes(key)
  );
  return transition ? { scene: sourceScene, transition } : null;
}

function isAuthorizedDirectTarget(originScene, targetScene, tokenIds) {
  const state = getSceneState(originScene);
  if (state.locations.some(entry => entry.linkedSceneId === targetScene.id)) return true;
  if (state.transitions.some(entry => entry.targetSceneId === targetScene.id && !entry.hidden)) return true;
  return (tokenIds ?? []).every(id => {
    const token = originScene.tokens?.get(id);
    return token?.getFlag?.(FALLOUT_MAW.id, "globalMapTravel")?.fromSceneId === targetScene.id;
  });
}

function emitTravelError(payload, message) {
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.travel.error",
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
