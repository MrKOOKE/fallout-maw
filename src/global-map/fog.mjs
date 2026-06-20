import { GLOBAL_MAP_SOCKET } from "./constants.mjs";
import {
  cellKey,
  getCellCluster,
  getCellVertices,
  getLocationCells,
  pointToCell,
  tokenCenter
} from "./geometry.mjs";
import { getGlobalMapFlag, getSceneState, setDiscovered, updateSceneState } from "./storage.mjs";

let discoveryQueued = false;

export function registerGlobalMapFogHooks() {
  Hooks.on("visibilityRefresh", applyCellVision);
  Hooks.on("canvasReady", () => queueDiscoveryRefresh());
  Hooks.on("sightRefresh", () => queueDiscoveryRefresh());
  Hooks.on("updateToken", () => queueDiscoveryRefresh());
  Hooks.on("resetFog", onFogReset);
}

export function registerGlobalMapFogSocket() {
  game.socket.on(GLOBAL_MAP_SOCKET, handleFogSocket);
}

function applyCellVision(visibility) {
  const scene = canvas?.scene;
  if (!getGlobalMapFlag(scene)) return;
  const state = getSceneState(scene);
  if (state.fog.mode !== "cells" || !visibility?.vision?.sight) return;
  const sight = visibility.vision.sight;
  sight.clear().beginFill(0xFF0000);
  const tokens = getContributingTokens();
  for (const token of tokens) {
    const center = pointToCell(scene, token.center ?? tokenCenter(token.document, scene));
    if (!center) continue;
    const tokenSize = Math.max(Number(token.document?.width) || 1, Number(token.document?.height) || 1);
    const radius = Math.max(1, state.fog.cellRadius + Math.ceil(tokenSize) - 1);
    for (const cell of getCellCluster(scene, center, radius)) {
      const vertices = getCellVertices(scene, cell);
      if (vertices.length >= 3) sight.drawPolygon(vertices.flatMap(point => [point.x, point.y]));
    }
  }
}

function queueDiscoveryRefresh() {
  if (discoveryQueued) return;
  discoveryQueued = true;
  queueMicrotask(async () => {
    discoveryQueued = false;
    await discoverVisibleObjects();
    canvas.falloutMaWGlobalMap?.refresh?.();
  });
}

async function discoverVisibleObjects() {
  const scene = canvas?.scene;
  if (!scene || !getGlobalMapFlag(scene)) return;
  const state = getSceneState(scene);
  const locationIds = state.locations
    .filter(location => location.alwaysDiscovered || isLocationVisible(scene, state, location))
    .map(location => location.id)
    .filter(id => !state.discoveredLocationIds.includes(id));
  const transitionIds = state.transitions
    .filter(transition => !transition.hidden && isCellsVisible(scene, state, transition.cells))
    .map(transition => transition.id)
    .filter(id => !state.discoveredTransitionIds.includes(id));
  if (!locationIds.length && !transitionIds.length) return;
  if (game.user?.isGM && isResponsibleGM()) {
    await applyDiscoveries(scene, locationIds, transitionIds);
  } else {
    game.socket.emit(GLOBAL_MAP_SOCKET, {
      action: "globalMap.discovery.request",
      sceneId: scene.id,
      userId: game.user?.id,
      locationIds,
      transitionIds
    });
  }
}

async function handleFogSocket(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.action === "globalMap.discovery.request" && game.user?.isGM && isResponsibleGM()) {
    const scene = game.scenes?.get(payload.sceneId);
    const user = game.users?.get(payload.userId);
    if (!scene || !user) return;
    const allowedLocationIds = [];
    const allowedTransitionIds = [];
    const state = getSceneState(scene);
    for (const id of payload.locationIds ?? []) {
      const location = state.locations.find(entry => entry.id === id);
      if (location?.alwaysDiscovered || userHasNearbyOwnedToken(user, scene, state, location, "location")) {
        allowedLocationIds.push(id);
      }
    }
    for (const id of payload.transitionIds ?? []) {
      const transition = state.transitions.find(entry => entry.id === id && !entry.hidden);
      if (transition && userHasNearbyOwnedToken(user, scene, state, transition, "transition")) {
        allowedTransitionIds.push(id);
      }
    }
    await applyDiscoveries(scene, allowedLocationIds, allowedTransitionIds);
  } else if (payload.action === "globalMap.discovery.changed" && payload.sceneId === canvas.scene?.id) {
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
}

async function applyDiscoveries(scene, locationIds, transitionIds) {
  if (!locationIds.length && !transitionIds.length) return;
  await updateSceneState(scene, state => {
    state.discoveredLocationIds = Array.from(new Set([...state.discoveredLocationIds, ...locationIds]));
    state.discoveredTransitionIds = Array.from(new Set([...state.discoveredTransitionIds, ...transitionIds]));
    return state;
  });
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.discovery.changed",
    sceneId: scene.id
  });
  if (scene.id === canvas.scene?.id) canvas.falloutMaWGlobalMap?.refresh?.();
}

function isLocationVisible(scene, state, location) {
  const locationCells = getLocationCells(scene, location).map(cellKey);
  return isCellsVisible(scene, state, locationCells);
}

function isCellsVisible(scene, state, keys = []) {
  if (!keys.length) return false;
  const wanted = new Set(keys);
  if (state.fog.mode === "cells") {
    for (const token of getContributingTokens()) {
      const center = pointToCell(scene, token.center ?? tokenCenter(token.document, scene));
      if (!center) continue;
      const tokenSize = Math.max(Number(token.document?.width) || 1, Number(token.document?.height) || 1);
      const radius = state.fog.cellRadius + Math.ceil(tokenSize) - 1;
      if (getCellCluster(scene, center, radius).some(cell => wanted.has(cellKey(cell)))) return true;
    }
    return false;
  }
  for (const key of wanted) {
    const [i, j] = key.split(",").map(Number);
    const point = scene.grid.getCenterPoint({ i, j });
    if (canvas.visibility?.testVisibility(point, { tolerance: 2 })) return true;
  }
  return false;
}

function userHasNearbyOwnedToken(user, scene, state, entry, kind) {
  const keys = kind === "location" ? getLocationCells(scene, entry).map(cellKey) : entry.cells ?? [];
  const wanted = new Set(keys);
  return (scene.tokens?.contents ?? []).some(token => {
    if (!token.actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) return false;
    const center = pointToCell(scene, tokenCenter(token, scene));
    if (!center) return false;
    if (state.fog.mode === "cells") {
      return getCellCluster(scene, center, state.fog.cellRadius).some(cell => wanted.has(cellKey(cell)));
    }
    const tokenPoint = tokenCenter(token, scene);
    const sightRange = Math.max(0, Number(token.sight?.range) || 0);
    const gridDistance = Math.max(0.0001, Number(scene.grid?.distance) || 1);
    const pixelRange = Math.max(Number(scene.grid?.size) || 100, (sightRange / gridDistance) * (Number(scene.grid?.size) || 100));
    return Array.from(wanted).some(key => {
      const [i, j] = key.split(",").map(Number);
      const point = scene.grid.getCenterPoint({ i, j });
      return Math.hypot(point.x - tokenPoint.x, point.y - tokenPoint.y) <= pixelRange;
    });
  });
}

function getContributingTokens() {
  return (canvas.tokens?.placeables ?? []).filter(token =>
    !token.document.hidden && (game.user?.isGM || token.isOwner)
  );
}

async function onFogReset() {
  if (!game.user?.isGM || !isResponsibleGM() || !getGlobalMapFlag(canvas?.scene)) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Сбросить обнаружение карты?" },
    content: "<p>Туман сброшен. Также скрыть все обнаруженные локации и переходы этой сцены?</p>",
    yes: { label: "Сбросить обнаружение" },
    no: { label: "Сохранить обнаружение" }
  });
  if (!confirmed) return;
  await updateSceneState(canvas.scene, state => {
    state.discoveredLocationIds = state.locations.filter(entry => entry.alwaysDiscovered).map(entry => entry.id);
    state.discoveredTransitionIds = [];
    return state;
  });
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.discovery.changed",
    sceneId: canvas.scene.id
  });
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
}

function isResponsibleGM() {
  return getResponsibleGM()?.id === game.user?.id;
}
