import { FALLOUT_MAW } from "../config/system-config.mjs";
import { GLOBAL_MAP_SOCKET, LOCATION_ENTRY_MODES, TRAVEL_GROUP_TOKEN_FLAG } from "./constants.mjs";
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
import {
  getTravelGroupViewerUserIds,
  isTravelGroupCarrierActor,
  resolveTravelGroupParticipants
} from "./travel-group-data.mjs";
import { buildTravelGroupRouteUpdate } from "./travel-group-routing.mjs";
import { transferTokensBetweenScenes } from "./token-transfer.mjs";

const { DialogV2 } = foundry.applications.api;
const runtimeMembership = new Map();
const activeTriggerPrompts = new Set();
const pendingTravelViewWaiters = new Map();

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
    await completeTravelForCurrentViewer(payload);
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
  args = { ...args, requestId: String(args.requestId ?? foundry.utils.randomID()) };
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
  if (tokenDocuments.some(hasPendingCarrierArrival)) {
    return emitTravelError(args, "Сначала завершите уже начатый переход группы.");
  }

  return withSystemEventRoot({
    kind: "directTravel",
    operationId: `direct-travel:${requestId}`,
    sceneUuid: String(originScene.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? "")
  }, async scope => {
    const participantRecords = await collectTravelEventParticipants(tokenDocuments);
    const participants = participantRecords.map(record => record.target);
    for (const [index, record] of participantRecords.entries()) {
      const { target, entryMode, groupPreserved } = record;
      const common = {
        originSceneUuid: String(originScene.uuid ?? ""),
        targetSceneUuid: String(targetScene.uuid ?? ""),
        requestingUserId: String(requestingUserId ?? ""),
        requestId: String(requestId ?? ""),
        transferId: String(requestId ?? ""),
        entryMode,
        groupPreserved,
        direction: "transition",
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
    for (const [index, record] of participantRecords.entries()) {
      const { target, entryMode, groupPreserved } = record;
      const data = {
        originSceneUuid: String(originScene.uuid ?? ""),
        targetSceneUuid: String(targetScene.uuid ?? ""),
        requestingUserId: String(requestingUserId ?? ""),
        requestId: String(requestId ?? ""),
        transferId: String(requestId ?? ""),
        entryMode,
        groupPreserved,
        direction: "transition",
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
  if (tokenDocuments.some(hasPendingCarrierArrival)) {
    return emitTravelError({ requestingUserId, requestId }, "Сначала завершите уже начатый переход группы.");
  }

  const destinationUpdates = tokenDocuments.map((token, index) => {
    const data = token.toObject();
    const cell = selectAnchorCell(anchorCells, index, targetScene);
    const position = tokenTopLeftAtCell(targetScene, data, cell, index);
    return { x: position.x, y: position.y };
  });
  const carrierTokens = tokenDocuments.filter(token => isTravelGroupCarrierActor(token.actor));
  const actorUpdates = Array.from(new Map(carrierTokens.map(token => [token.actor?.id, token.actor])).values())
    .filter(Boolean)
    .map(actor => buildTravelGroupRouteUpdate(actor, targetScene, requestId));

  let transfer;
  try {
    transfer = await transferTokensBetweenScenes({
      originScene,
      targetScene,
      tokenDocuments,
      destinationUpdates,
      actorUpdates,
      operationOptions: {
        falloutMawSystemEventChainRef: chainRef,
        chainRef
      }
    });
  } catch (error) {
    console.error(`${FALLOUT_MAW.id} | Global-map travel failed`, error);
    return emitTravelError(
      { requestingUserId, requestId },
      "Перенос токенов не подтверждён. Обновите сцену перед повторной попыткой."
    );
  }

  const viewerUserIds = Array.from(new Set([
    requestingUserId,
    ...carrierTokens.flatMap(token => getTravelGroupViewerUserIds(token.actor, { requestingUserId }))
  ].filter(Boolean)));
  const controlTokenIds = carrierTokens
    .map(token => transfer.tokenMap.get(token)?.id)
    .filter(Boolean);
  const completePayload = {
    action: "globalMap.travel.complete",
    requestId,
    targetSceneId: targetScene.id,
    viewerUserIds,
    activateTokenControls: Boolean(controlTokenIds.length),
    controlTokenIds
  };
  if (carrierTokens.length && !targetScene.active) await targetScene.activate().catch(error => {
    console.warn(`${FALLOUT_MAW.id} | Could not activate carrier destination Scene`, error);
  });
  game.socket.emit(GLOBAL_MAP_SOCKET, completePayload);
  if (viewerUserIds.includes(game.user?.id)) {
    await completeTravelForCurrentViewer(completePayload);
  }
  return true;
}

async function completeTravelForCurrentViewer(payload = {}) {
  const scene = game.scenes?.get(payload.targetSceneId);
  if (!scene) return false;
  const waiterKey = String(payload.requestId || payload.targetSceneId);
  if (canvas.loading) {
    queueTravelViewRetry(waiterKey, payload);
    return true;
  }
  if (canvas.scene?.id !== scene.id) await scene.view();
  if (canvas.loading || canvas.scene?.id !== scene.id || !canvas.ready) {
    queueTravelViewRetry(waiterKey, payload);
    return true;
  }
  clearTravelViewRetry(waiterKey);
  if (payload.activateTokenControls) restoreTransferredTokenControls(payload);
  return true;
}

function queueTravelViewRetry(key, payload) {
  clearTravelViewRetry(key);
  const waiter = { hookId: null };
  pendingTravelViewWaiters.set(key, waiter);
  if (canvas.loading) {
    runAfterCanvasSettles(() => {
      if (pendingTravelViewWaiters.get(key) !== waiter) return;
      pendingTravelViewWaiters.delete(key);
      void completeTravelForCurrentViewer(payload);
    });
    return;
  }
  const hookId = Hooks.on("canvasReady", () => {
    clearTravelViewRetry(key);
    runAfterCanvasSettles(() => completeTravelForCurrentViewer(payload));
  });
  waiter.hookId = hookId;
}

function clearTravelViewRetry(key) {
  const waiter = pendingTravelViewWaiters.get(key);
  if (waiter?.hookId !== null && waiter?.hookId !== undefined) Hooks.off("canvasReady", waiter.hookId);
  pendingTravelViewWaiters.delete(key);
}

function restoreTransferredTokenControls({ targetSceneId, controlTokenIds = [] } = {}) {
  const restore = () => {
    if (!canvas?.ready || canvas.loading || canvas.scene?.id !== targetSceneId) return false;
    canvas.tokens?.activate?.({ tool: "select" });
    const tokens = controlTokenIds.map(id => canvas.tokens?.get?.(id)).filter(Boolean);
    for (const [index, token] of tokens.entries()) token.control?.({ releaseOthers: index === 0 });
    return true;
  };
  if (restore()) return;
  const hookId = Hooks.on("canvasReady", () => {
    runAfterCanvasSettles(() => {
      if (!restore()) return;
      Hooks.off("canvasReady", hookId);
    });
  });
}

async function collectTravelEventParticipants(tokenDocuments = []) {
  const records = [];
  const seen = new Set();
  const add = (target, key = "", groupPreserved = false) => {
    if (!target) return;
    const identity = key || target.tokenUuid || target.actorUuid;
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    records.push({
      target,
      groupPreserved,
      entryMode: groupPreserved ? LOCATION_ENTRY_MODES.CARRIER : LOCATION_ENTRY_MODES.DEPLOY
    });
  };
  for (const token of tokenDocuments) {
    if (!isTravelGroupCarrierActor(token.actor)) {
      add(systemEventParticipant({ actor: token.actor, token }), `token:${token.uuid}`, false);
      continue;
    }
    for (const { actor, actorUuid } of await resolveTravelGroupParticipants(token.actor)) {
      add(
        actor ? systemEventParticipant({ actor }) : { actorUuid, tokenUuid: "", itemUuid: "" },
        `actor:${actorUuid}`,
        true
      );
    }
  }
  return records;
}

function hasPendingCarrierArrival(token) {
  return Boolean(
    isTravelGroupCarrierActor(token?.actor)
    && token.getFlag?.(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.pendingArrival
  );
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
