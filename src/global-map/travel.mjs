import { FALLOUT_MAW } from "../config/system-config.mjs";
import { GLOBAL_MAP_SOCKET } from "./constants.mjs";
import { cellKey, getLocationCells, pointToCell, tokenCenter, tokenTopLeftAtCell } from "./geometry.mjs";
import { getSceneState } from "./storage.mjs";
import {
  isSystemEventCancelled,
  systemEventParticipant,
  withSystemEventRoot
} from "../events/foundry-world-events.mjs";
import {
  promptLocationEntry,
  promptLocationExit,
  travelToLocation as travelGroupToLocation
} from "./travel-groups.mjs";

const { DialogV2 } = foundry.applications.api;
const runtimeMembership = new Map();
const activeTriggerPrompts = new Set();

export function registerGlobalMapTravelHooks() {
  Hooks.on("moveToken", onTokenMoved);
  Hooks.on("createToken", seedTokenMembership);
  Hooks.on("deleteToken", clearTokenMembership);
  Hooks.on("canvasReady", seedCanvasMembership);
  Hooks.on("canvasTearDown", () => {
    runtimeMembership.clear();
    activeTriggerPrompts.clear();
  });
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
  return travelGroupToLocation(locationId, { tokenIds });
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

function seedCanvasMembership() {
  runtimeMembership.clear();
  for (const token of canvas.scene?.tokens?.contents ?? []) seedTokenMembership(token);
}

function seedTokenMembership(tokenDocument) {
  const scene = tokenDocument?.parent;
  if (!scene) return;
  runtimeMembership.set(getRuntimeKey(scene.id, tokenDocument.id), getCandidateKeys(scene, tokenDocument));
}

function clearTokenMembership(tokenDocument) {
  const sceneId = tokenDocument?.parent?.id;
  if (!sceneId) return;
  const runtimeKey = getRuntimeKey(sceneId, tokenDocument.id);
  runtimeMembership.delete(runtimeKey);
  activeTriggerPrompts.delete(runtimeKey);
}

async function onTokenMoved(tokenDocument, movement, _operation, user) {
  if (user?.id !== game.user?.id || !canvas?.ready || tokenDocument.parent?.id !== canvas.scene?.id) return;
  const destination = movement?.passed?.waypoints?.at(-1);
  if (!destination) return;
  const scene = canvas.scene;
  const runtimeKey = getRuntimeKey(scene.id, tokenDocument.id);
  const previous = new Set(runtimeMembership.get(runtimeKey) ?? []);
  const candidates = getCandidatesAtToken(scene, tokenDocument, destination);
  runtimeMembership.set(runtimeKey, candidates.map(candidate => candidate.key));
  const entered = candidates.filter(candidate => !previous.has(candidate.key));
  if (!entered.length || activeTriggerPrompts.has(runtimeKey)) return;
  activeTriggerPrompts.add(runtimeKey);
  try {
    await movement.animation?.ended;
    if (!canvas?.ready || canvas.scene?.id !== scene.id) return;
    const currentMembership = new Set(runtimeMembership.get(runtimeKey) ?? []);
    const activeEntered = entered.filter(candidate => currentMembership.has(candidate.key));
    if (!activeEntered.length) return;
    const selected = await chooseCandidate(activeEntered);
    if (selected) await executeCandidate(selected, tokenDocument, user.id);
  } finally {
    activeTriggerPrompts.delete(runtimeKey);
  }
}

async function chooseCandidate(candidates) {
  if (candidates.length === 1) return candidates[0];
  const result = await DialogV2.input({
    window: { title: "Выберите переход" },
    content: `<label>Действие<select name="candidate">${candidates.map((entry, index) => `<option value="${index}">${foundry.utils.escapeHTML(entry.label)}</option>`).join("")}</select></label>`,
    ok: { label: "Продолжить" },
    rejectClose: false
  });
  if (!result) return null;
  return candidates[Math.max(0, Number(result.candidate) || 0)] ?? candidates[0];
}

async function executeCandidate(selected, tokenDocument, userId) {
  if (selected.kind === "locationExit") {
    return promptLocationExit({
      sceneId: canvas.scene.id,
      exitZoneId: selected.exit.id,
      tokenId: tokenDocument.id,
      userId
    });
  }
  if (selected.kind === "location") {
    return promptLocationEntry({
      sceneId: canvas.scene.id,
      locationId: selected.location.id,
      tokenId: tokenDocument.id,
      userId
    });
  }
  if (selected.kind === "linkedTransition") {
    const confirmed = await DialogV2.confirm({
      window: { title: "Переход" },
      content: `<p>Перейти в <strong>${foundry.utils.escapeHTML(selected.linkedTransition.transition.name)}</strong>?</p>`,
      yes: { label: "Перейти" },
      no: { label: "Остаться" }
    });
    if (!confirmed) return false;
    return requestDirectTravel({
      originSceneId: canvas.scene.id,
      targetSceneId: selected.linkedTransition.scene.id,
      tokenIds: getTriggeredTravelTokenIds(tokenDocument),
      requestingUserId: userId,
      anchorCells: selected.linkedTransition.transition.cells ?? [],
      linkedTransitionId: selected.linkedTransition.transition.id,
      triggerTokenId: tokenDocument.id
    });
  }
  const confirmed = await DialogV2.confirm({
    window: { title: "Переход" },
    content: `<p>Перейти в <strong>${foundry.utils.escapeHTML(selected.transition.name)}</strong>?</p>`,
    yes: { label: "Перейти" },
    no: { label: "Остаться" }
  });
  if (!confirmed) return false;
  return requestTransitionTravel({
    originSceneId: canvas.scene.id,
    transitionId: selected.transition.id,
    tokenIds: getTriggeredTravelTokenIds(tokenDocument),
    requestingUserId: userId
  });
}

function getCandidateKeys(scene, tokenDocument) {
  return getCandidatesAtToken(scene, tokenDocument).map(candidate => candidate.key);
}

function getCandidatesAtToken(scene, tokenDocument, position = tokenDocument) {
  const currentCell = pointToCell(scene, tokenCenter({
    x: position.x,
    y: position.y,
    width: position.width ?? tokenDocument.width,
    height: position.height ?? tokenDocument.height
  }, scene));
  if (!currentCell) return [];
  const key = cellKey(currentCell);
  const state = getSceneState(scene);
  const candidates = [];
  for (const transition of state.transitions) {
    if (!transition.hidden && transition.cells?.includes(key)) {
      candidates.push({
        key: `transition:${transition.id}`,
        kind: "transition",
        label: `Переход: ${transition.name}`,
        transition
      });
    }
  }
  for (const linkedTransition of findLinkedTransitionEntries(scene, key)) {
    candidates.push({
      key: `linkedTransition:${linkedTransition.scene.id}:${linkedTransition.transition.id}`,
      kind: "linkedTransition",
      label: `Переход: ${linkedTransition.transition.name}`,
      linkedTransition
    });
  }
  for (const exit of state.locationExitZones) {
    if (!exit.cells?.includes(key)) continue;
    candidates.push({
      key: `locationExit:${exit.id}`,
      kind: "locationExit",
      label: `Выход: ${exit.name}`,
      exit
    });
  }
  for (const location of state.locations) {
    if (!location.linkedSceneId || !getLocationCells(scene, location).some(cell => cellKey(cell) === key)) continue;
    candidates.push({
      key: `location:${location.id}`,
      kind: "location",
      label: `Локация: ${location.name}`,
      location
    });
  }
  return candidates;
}

function getRuntimeKey(sceneId, tokenId) {
  return `${sceneId}:${tokenId}`;
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
    if (payload.activateTokenControls && canvas.scene?.id === scene?.id) {
      canvas.tokens?.activate?.({ tool: "select" });
    }
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
    anchorCells: transition.entryCells ?? []
  });
}

async function performDirectTravel(payload) {
  const originScene = game.scenes?.get(payload.originSceneId);
  const targetScene = game.scenes?.get(payload.targetSceneId);
  if (!originScene || !targetScene) return emitTravelError(payload, "Сцена перехода не найдена.");
  const requestingUser = game.users?.get(payload.requestingUserId);
  if (!requestingUser?.isGM && !isAuthorizedDirectTarget(originScene, targetScene, payload)) {
    return emitTravelError(payload, "Этот переход не связан с целевой сценой.");
  }
  return performTravel({ ...payload, originScene, targetScene, anchorCells: payload.anchorCells ?? [] });
}

async function performTravel(args) {
  const {
    originScene,
    targetScene,
    tokenIds,
    requestingUserId,
    requestId
  } = args;
  const requestingUser = game.users?.get(requestingUserId);
  const tokenDocuments = (tokenIds ?? [])
    .map(id => originScene?.tokens?.get(id))
    .filter(token => token && canUserMoveToken(requestingUser, token));
  if (!originScene || !targetScene || !tokenDocuments.length) return performTravelNow(args);

  return withSystemEventRoot({
    kind: "directTravel",
    operationId: `direct-travel:${requestId || foundry.utils.randomID()}`,
    sceneUuid: String(originScene.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? "")
  }, async scope => {
    const participants = tokenDocuments.map(token => systemEventParticipant({ actor: token.actor, token })).filter(Boolean);
    for (const [index, target] of participants.entries()) {
      const common = {
        originSceneUuid: String(originScene.uuid ?? ""),
        targetSceneUuid: String(targetScene.uuid ?? ""),
        requestingUserId: String(requestingUserId ?? ""),
        requestId: String(requestId ?? ""),
        actorUuid: target.actorUuid,
        tokenUuid: target.tokenUuid
      };
      const departure = await scope.emit("fallout-maw.travel.departure.before", { data: common }, {
        occurrenceKey: `direct-travel:${requestId}:departure-before:${target.tokenUuid || index}`,
        participants: { source: target, target, related: participants.filter(entry => entry !== target) }
      });
      if (isSystemEventCancelled(departure)) return false;
      const arrival = await scope.emit("fallout-maw.travel.arrival.before", { data: common }, {
        occurrenceKey: `direct-travel:${requestId}:arrival-before:${target.tokenUuid || index}`,
        participants: { source: target, target, related: participants.filter(entry => entry !== target) }
      });
      if (isSystemEventCancelled(arrival)) return false;
    }

    const completed = await performTravelNow({ ...args, chainRef: scope.chainRef });
    if (!completed) return false;
    for (const [index, target] of participants.entries()) {
      const data = {
        originSceneUuid: String(originScene.uuid ?? ""),
        targetSceneUuid: String(targetScene.uuid ?? ""),
        requestingUserId: String(requestingUserId ?? ""),
        requestId: String(requestId ?? ""),
        actorUuid: target.actorUuid,
        tokenUuid: target.tokenUuid
      };
      const options = {
        participants: { source: target, target, related: participants.filter(entry => entry !== target) }
      };
      await scope.emit("fallout-maw.travel.location.left", { data, outcome: { success: true } }, {
        ...options,
        occurrenceKey: `direct-travel:${requestId}:location-left:${target.tokenUuid || index}`
      });
      await scope.emit("fallout-maw.travel.departure.completed", { data, outcome: { success: true, completed: true } }, {
        ...options,
        occurrenceKey: `direct-travel:${requestId}:departure-completed:${target.tokenUuid || index}`
      });
      await scope.emit("fallout-maw.travel.location.entered", { data, outcome: { success: true } }, {
        ...options,
        occurrenceKey: `direct-travel:${requestId}:location-entered:${target.tokenUuid || index}`
      });
      await scope.emit("fallout-maw.travel.arrival.completed", { data, outcome: { success: true, completed: true } }, {
        ...options,
        occurrenceKey: `direct-travel:${requestId}:arrival-completed:${target.tokenUuid || index}`
      });
    }
    return true;
  });
}

async function performTravelNow({ originScene, targetScene, tokenIds, requestingUserId, requestId, anchorCells, chainRef = null }) {
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
    return data;
  });

  let created = [];
  try {
    created = await targetScene.createEmbeddedDocuments("Token", createData, {
      falloutMawSystemEventChainRef: chainRef,
      chainRef
    });
    if (created.length !== createData.length) throw new Error("Not all target tokens were created.");
    await originScene.deleteEmbeddedDocuments("Token", tokenDocuments.map(token => token.id), {
      falloutMawSystemEventChainRef: chainRef,
      chainRef
    });
  } catch (error) {
    if (created.length) {
      await targetScene.deleteEmbeddedDocuments("Token", created.map(token => token.id), {
        falloutMawSystemEventChainRef: chainRef,
        chainRef
      }).catch(() => {});
    }
    console.error(`${FALLOUT_MAW.id} | Global-map travel failed`, error);
    return emitTravelError({ requestingUserId, requestId }, "Перенос токенов не завершён; исходные токены сохранены.");
  }

  const viewerUserIds = [requestingUserId].filter(Boolean);
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.travel.complete",
    requestId,
    targetSceneId: targetScene.id,
    viewerUserIds
  });
  if (viewerUserIds.includes(game.user?.id) && canvas.scene?.id !== targetScene.id) await targetScene.view();
  return true;
}

function getTriggeredTravelTokenIds(triggerToken) {
  const controlled = canvas.tokens?.controlled ?? [];
  if (controlled.some(token => token.id === triggerToken.id)) {
    return controlled.map(token => token.id);
  }
  return [triggerToken.id];
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

function findLinkedTransitionEntries(scene, key) {
  if (!scene || !key) return [];
  return (game.scenes?.contents ?? []).flatMap(sourceScene => {
    if (!sourceScene || sourceScene.id === scene.id) return [];
    return getSceneState(sourceScene).transitions
      .filter(entry =>
        !entry.hidden
        && entry.targetSceneId === scene.id
        && Array.isArray(entry.entryCells)
        && entry.entryCells.includes(key)
      )
      .map(transition => ({ scene: sourceScene, transition }));
  });
}

function isAuthorizedDirectTarget(originScene, targetScene, payload = {}) {
  const state = getSceneState(originScene);
  if (state.transitions.some(entry => entry.targetSceneId === targetScene.id && !entry.hidden)) return true;
  const linkedTransition = getSceneState(targetScene).transitions.find(entry =>
    entry.id === payload.linkedTransitionId
    && entry.targetSceneId === originScene.id
    && !entry.hidden
  );
  if (!linkedTransition?.entryCells?.length) return false;
  const triggerTokenId = payload.triggerTokenId ?? payload.tokenIds?.[0];
  const token = originScene.tokens?.get(triggerTokenId);
  const cell = token ? pointToCell(originScene, tokenCenter(token, originScene)) : null;
  return Boolean(cell && linkedTransition.entryCells.includes(cellKey(cell)));
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
