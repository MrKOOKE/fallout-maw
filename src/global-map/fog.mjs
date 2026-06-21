import { GLOBAL_MAP_SOCKET } from "./constants.mjs";
import {
  cellKey,
  getCellCluster,
  getCellVertices,
  getLocationCells,
  pointToCell,
  tokenCenter
} from "./geometry.mjs";
import { getGlobalMapFlag, getSceneState, updateSceneState } from "./storage.mjs";

let discoveryQueued = false;
let cellExplorationQueued = false;
let cellExplorationGraphic = null;

export function registerGlobalMapFogHooks() {
  Hooks.on("visibilityRefresh", applyCellVision);
  Hooks.on("canvasReady", async () => {
    await enforceCellFogIsolation(canvas.scene);
    await reconcileDiscoveredLocationCells(canvas.scene);
    syncCellExplorationDisplay();
    queueDiscoveryRefresh();
    queueCellExploration();
  });
  Hooks.on("sightRefresh", () => queueDiscoveryRefresh());
  Hooks.on("updateToken", () => {
    queueDiscoveryRefresh();
    queueCellExploration();
  });
  Hooks.on("updateScene", scene => {
    if (scene.id !== canvas.scene?.id || !getGlobalMapFlag(scene)) return;
    queueDiscoveryRefresh();
    void reconcileDiscoveredLocationCells(scene);
    syncCellExplorationDisplay();
    canvas.perception?.update?.({ refreshVision: true });
  });
  Hooks.on("canvasTearDown", clearCellExplorationDisplay);
  Hooks.on("resetFog", onFogReset);
}

async function enforceCellFogIsolation(scene) {
  if (!scene || !getGlobalMapFlag(scene) || !game.user?.isGM || !isResponsibleGM()) return;
  const state = getSceneState(scene);
  const disabled = CONST.FOG_EXPLORATION_MODES.DISABLED;
  if (state.fog.mode === "cells" && scene.fog.mode !== disabled) {
    const nativeMode = scene.fog.mode;
    await updateSceneState(scene, current => {
      current.fog.nativeMode = nativeMode;
      return current;
    });
    await scene.update({ "fog.mode": disabled });
    return;
  }
  if (state.fog.mode === "native" && scene.fog.mode === disabled && Number.isInteger(state.fog.nativeMode)) {
    await scene.update({ "fog.mode": state.fog.nativeMode });
  }
}

async function reconcileDiscoveredLocationCells(scene) {
  if (!scene || !game.user?.isGM || !isResponsibleGM()) return;
  const state = getSceneState(scene);
  if (state.fog.mode !== "cells") return;
  const discovered = new Set([
    ...state.discoveredLocationIds,
    ...state.locations.filter(location => location.alwaysDiscovered).map(location => location.id)
  ]);
  const requiredKeys = state.locations
    .filter(location => discovered.has(location.id))
    .flatMap(location => getLocationCells(scene, location).map(cellKey));
  const existing = new Set(state.fog.exploredCellKeys);
  if (requiredKeys.every(key => existing.has(key))) return;
  await updateSceneState(scene, current => {
    current.fog.exploredCellKeys = Array.from(new Set([
      ...current.fog.exploredCellKeys,
      ...requiredKeys
    ]));
    return current;
  });
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.cellFog.changed",
    sceneId: scene.id
  });
}

export function registerGlobalMapFogSocket() {
  game.socket.on(GLOBAL_MAP_SOCKET, handleFogSocket);
}

function applyCellVision(visibility) {
  const scene = canvas?.scene;
  if (!getGlobalMapFlag(scene)) return;
  const state = getSceneState(scene);
  syncCellExplorationDisplay();
  if (state.fog.mode !== "cells" || !visibility?.vision?.sight) return;
  const vision = visibility.vision;
  const masks = [
    vision.sight,
    vision.sight?.preview,
    vision.sight?.shared,
    vision.light?.mask,
    vision.light?.mask?.preview,
    vision.light?.mask?.shared
  ].filter(Boolean);
  for (const mask of masks) mask.clear().beginFill(0xFF0000);
  const cells = getVisibleCellsForTokens(scene, getContributingTokens(), state.fog.cellRadius);
  drawCells(vision.sight, scene, cells);
  drawCells(vision.light?.mask, scene, cells);
  queueCellExploration(cells.map(cellKey));
}

function syncCellExplorationDisplay() {
  const scene = canvas?.scene;
  const visibility = canvas?.visibility;
  const explored = visibility?.explored;
  if (!scene || !explored || !getGlobalMapFlag(scene)) return;
  const state = getSceneState(scene);
  const isCellMode = state.fog.mode === "cells";
  const nativeSprite = canvas.fog?.sprite;
  if (nativeSprite) nativeSprite.visible = !isCellMode;
  if (!isCellMode) {
    clearCellExplorationDisplay();
    return;
  }
  if (!cellExplorationGraphic || cellExplorationGraphic.destroyed || cellExplorationGraphic.parent !== explored) {
    clearCellExplorationDisplay();
    cellExplorationGraphic = new PIXI.LegacyGraphics();
    cellExplorationGraphic.name = "fallout-maw-cell-fog-exploration";
    explored.addChildAt(cellExplorationGraphic, Math.min(1, explored.children.length));
  }
  cellExplorationGraphic.clear().beginFill(0xFF0000);
  drawCells(
    cellExplorationGraphic,
    scene,
    state.fog.exploredCellKeys.map(key => {
      const [i, j] = String(key).split(",").map(Number);
      return Number.isFinite(i) && Number.isFinite(j) ? { i, j } : null;
    }).filter(Boolean)
  );
  cellExplorationGraphic.endFill();
}

function clearCellExplorationDisplay() {
  if (cellExplorationGraphic && !cellExplorationGraphic.destroyed) {
    cellExplorationGraphic.destroy();
  }
  cellExplorationGraphic = null;
}

function drawCells(graphic, scene, cells) {
  if (!graphic) return;
  for (const cell of cells) {
    const vertices = getCellVertices(scene, cell);
    if (vertices.length < 3) continue;
    graphic.drawPolygon(vertices.flatMap(point => [point.x, point.y]));
  }
}

function getVisibleCellsForTokens(scene, tokens, baseRadius) {
  const cells = new Map();
  for (const token of tokens) {
    const document = token?.document ?? token;
    const centerPoint = token?.center ?? tokenCenter(document, scene);
    const center = pointToCell(scene, centerPoint);
    if (!center) continue;
    const tokenSize = Math.max(Number(document?.width) || 1, Number(document?.height) || 1);
    const radius = Math.max(1, Number(baseRadius) + Math.ceil(tokenSize) - 1);
    for (const cell of getCellCluster(scene, center, radius)) cells.set(cellKey(cell), cell);
  }
  return Array.from(cells.values());
}

function queueCellExploration(keys = null) {
  const scene = canvas?.scene;
  if (!scene || getSceneState(scene).fog.mode !== "cells") return;
  const requested = Array.isArray(keys)
    ? keys
    : getVisibleCellsForTokens(scene, getContributingTokens(), getSceneState(scene).fog.cellRadius).map(cellKey);
  if (!requested.length || requested.every(key => getSceneState(scene).fog.exploredCellKeys.includes(key))) return;
  if (cellExplorationQueued) return;
  cellExplorationQueued = true;
  queueMicrotask(async () => {
    cellExplorationQueued = false;
    const currentScene = canvas?.scene;
    if (!currentScene || getSceneState(currentScene).fog.mode !== "cells") return;
    const visibleKeys = getVisibleCellsForTokens(
      currentScene,
      getContributingTokens(),
      getSceneState(currentScene).fog.cellRadius
    ).map(cellKey);
    if (!visibleKeys.length) return;
    if (game.user?.isGM && isResponsibleGM()) {
      await applyCellExploration(currentScene, visibleKeys);
    } else {
      game.socket.emit(GLOBAL_MAP_SOCKET, {
        action: "globalMap.cellFog.request",
        sceneId: currentScene.id,
        userId: game.user?.id,
        cellKeys: visibleKeys
      });
    }
  });
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
  const exitZoneIds = state.locationExitZones
    .filter(exit => exit.alwaysDiscovered || isCellsVisible(scene, state, exit.cells))
    .map(exit => exit.id)
    .filter(id => !state.discoveredExitZoneIds.includes(id));
  if (!locationIds.length && !transitionIds.length && !exitZoneIds.length) return;
  if (game.user?.isGM && isResponsibleGM()) {
    await applyDiscoveries(scene, locationIds, transitionIds, exitZoneIds);
  } else {
    game.socket.emit(GLOBAL_MAP_SOCKET, {
      action: "globalMap.discovery.request",
      sceneId: scene.id,
      userId: game.user?.id,
      locationIds,
      transitionIds,
      exitZoneIds
    });
  }
}

async function handleFogSocket(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.action === "globalMap.cellFog.request" && game.user?.isGM && isResponsibleGM()) {
    const scene = game.scenes?.get(payload.sceneId);
    const user = game.users?.get(payload.userId);
    if (!scene || !user || getSceneState(scene).fog.mode !== "cells") return;
    const allowed = new Set(getVisibleCellsForTokens(
      scene,
      getContributingTokenDocumentsForUser(scene, user),
      getSceneState(scene).fog.cellRadius
    ).map(cellKey));
    const requested = (payload.cellKeys ?? []).map(String).filter(key => allowed.has(key));
    await applyCellExploration(scene, requested);
  } else if (payload.action === "globalMap.cellFog.changed" && payload.sceneId === canvas.scene?.id) {
    syncCellExplorationDisplay();
    canvas.perception?.update?.({ refreshVision: true });
    canvas.falloutMaWGlobalMap?.refresh?.();
  } else if (payload.action === "globalMap.discovery.request" && game.user?.isGM && isResponsibleGM()) {
    const scene = game.scenes?.get(payload.sceneId);
    const user = game.users?.get(payload.userId);
    if (!scene || !user) return;
    const allowedLocationIds = [];
    const allowedTransitionIds = [];
    const allowedExitZoneIds = [];
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
    for (const id of payload.exitZoneIds ?? []) {
      const exit = state.locationExitZones.find(entry => entry.id === id);
      if (exit?.alwaysDiscovered || (exit && userHasNearbyOwnedToken(user, scene, state, exit, "exit"))) {
        allowedExitZoneIds.push(id);
      }
    }
    await applyDiscoveries(scene, allowedLocationIds, allowedTransitionIds, allowedExitZoneIds);
  } else if (payload.action === "globalMap.discovery.changed" && payload.sceneId === canvas.scene?.id) {
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
}

async function applyCellExploration(scene, keys) {
  const additions = Array.from(new Set((keys ?? []).map(String).filter(Boolean)));
  if (!additions.length) return;
  const existing = new Set(getSceneState(scene).fog.exploredCellKeys);
  if (additions.every(key => existing.has(key))) return;
  await updateSceneState(scene, state => {
    state.fog.exploredCellKeys = Array.from(new Set([
      ...state.fog.exploredCellKeys,
      ...additions
    ]));
    return state;
  });
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.cellFog.changed",
    sceneId: scene.id
  });
  if (scene.id === canvas.scene?.id) {
    syncCellExplorationDisplay();
    canvas.perception?.update?.({ refreshVision: true });
  }
}

async function applyDiscoveries(scene, locationIds, transitionIds, exitZoneIds = []) {
  if (!locationIds.length && !transitionIds.length && !exitZoneIds.length) return;
  await updateSceneState(scene, state => {
    state.discoveredLocationIds = Array.from(new Set([...state.discoveredLocationIds, ...locationIds]));
    state.discoveredTransitionIds = Array.from(new Set([...state.discoveredTransitionIds, ...transitionIds]));
    state.discoveredExitZoneIds = Array.from(new Set([...state.discoveredExitZoneIds, ...exitZoneIds]));
    if (state.fog.mode === "cells" && locationIds.length) {
      const revealedLocationIds = new Set(locationIds);
      const locationCellKeys = state.locations
        .filter(location => revealedLocationIds.has(location.id))
        .flatMap(location => getLocationCells(scene, location).map(cellKey));
      state.fog.exploredCellKeys = Array.from(new Set([
        ...state.fog.exploredCellKeys,
        ...locationCellKeys
      ]));
    }
    return state;
  });
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.discovery.changed",
    sceneId: scene.id
  });
  if (locationIds.length && getSceneState(scene).fog.mode === "cells") {
    game.socket.emit(GLOBAL_MAP_SOCKET, {
      action: "globalMap.cellFog.changed",
      sceneId: scene.id
    });
  }
  if (scene.id === canvas.scene?.id) {
    syncCellExplorationDisplay();
    canvas.perception?.update?.({ refreshVision: true });
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
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

function getContributingTokenDocumentsForUser(scene, user) {
  return (scene.tokens?.contents ?? []).filter(token =>
    !token.hidden
    && (user.isGM || token.actor?.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))
  );
}

export async function resetCellFog(scene = canvas?.scene) {
  if (!scene || !game.user?.isGM || !isResponsibleGM()) return false;
  await updateSceneState(scene, state => {
    state.fog.exploredCellKeys = [];
    state.discoveredLocationIds = state.locations
      .filter(entry => entry.alwaysDiscovered)
      .map(entry => entry.id);
    state.discoveredTransitionIds = [];
    state.discoveredExitZoneIds = state.locationExitZones
      .filter(entry => entry.alwaysDiscovered)
      .map(entry => entry.id);
    return state;
  });
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.cellFog.changed",
    sceneId: scene.id
  });
  if (scene.id === canvas.scene?.id) {
    syncCellExplorationDisplay();
    canvas.perception?.update?.({ refreshVision: true });
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
  return true;
}

async function onFogReset() {
  if (!game.user?.isGM || !isResponsibleGM() || !getGlobalMapFlag(canvas?.scene)) return;
  if (getSceneState(canvas.scene).fog.mode === "cells") return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Сбросить обнаружение карты?" },
    content: "<p>Туман сброшен. Также скрыть все обнаруженные локации, переходы и зоны выхода этой сцены?</p>",
    yes: { label: "Сбросить обнаружение" },
    no: { label: "Сохранить обнаружение" }
  });
  if (!confirmed) return;
  await updateSceneState(canvas.scene, state => {
    state.discoveredLocationIds = state.locations.filter(entry => entry.alwaysDiscovered).map(entry => entry.id);
    state.discoveredTransitionIds = [];
    state.discoveredExitZoneIds = state.locationExitZones.filter(entry => entry.alwaysDiscovered).map(entry => entry.id);
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
