import { localize as auditLocalize } from "../utils/i18n.mjs";
import { getMapTokenLevelId, isMapAreaOnLevel } from "./levels.mjs";
import { GLOBAL_MAP_SOCKET } from "./constants.mjs";
import {
  buildGlobalMapDiscoveryEvents,
  withSystemEventRoot
} from "../events/foundry-world-events.mjs";
import {
  cellKey,
  getCellCluster,
  getCellVertices,
  getLocationCells,
  parseCellKey,
  pointToCell,
  tokenCenter
} from "./geometry.mjs";
import { getGlobalMapFlag, getSceneState, updateSceneState } from "./storage.mjs";

let discoveryQueued = false;
let cellExplorationQueued = false;
let cellExplorationGraphic = null;
let nativeVisibilityFilter = null;
let cellVisibilityFilter = null;

// Explored cells are cached as Sets so per-frame checks are O(1) and never scan the
// whole (and ever growing) explored list. Newly found cells are accumulated in a dirty
// buffer and persisted by a single serialized writer, mirroring how Foundry's own
// FogManager commits exploration (merge into a buffer, then one queued save).
let knownExploredKeys = null;
let knownExploredSourceKey = null;
let knownExploredArrayRef = null;
let knownFogConfig = null;
let knownFogConfigSource = null;
let knownFogConfigKey = null;
let dirtyCellKeys = new Set();
let cellExplorationFlushScheduled = false;
// Serialized write chain for cell fog; see queueCellFogWrite.
let fogWriteChain = Promise.resolve();
// Bumped on every reset so an in-flight write can never resurrect cleared cells.
let cellFogGeneration = 0;
let drawnCellFogKeys = new Set();
class CellFogVisibilityFilter extends PIXI.Filter {
  constructor(visionTexture) {
    super(CellFogVisibilityFilter.vertexShader, CellFogVisibilityFilter.fragmentShader, {
      visionTexture,
      primaryTexture: canvas.primary?.renderTexture ?? PIXI.Texture.EMPTY,
      exploredColor: [1, 1, 1],
      unexploredColor: [0, 0, 0],
      backgroundColor: [0, 0, 0],
      screenDimensions: [1, 1]
    });
    this.blendMode = PIXI.BLEND_MODES.NORMAL;
  }

  apply(filterManager, input, output, clear) {
    this.uniforms.screenDimensions = canvas.screenDimensions;
    filterManager.applyFilter(this, input, output, clear);
  }

  static vertexShader = `
    attribute vec2 aVertexPosition;
    uniform mat3 projectionMatrix;
    uniform vec2 screenDimensions;
    uniform vec4 inputSize;
    uniform vec4 outputFrame;
    varying vec2 vTextureCoord;
    varying vec2 vMaskTextureCoord;

    void main() {
      vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
      gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
      vTextureCoord = aVertexPosition * (outputFrame.zw * inputSize.zw);
      vMaskTextureCoord = (vTextureCoord * inputSize.xy + outputFrame.xy) / screenDimensions;
    }
  `;

  static fragmentShader = `
    varying vec2 vTextureCoord;
    varying vec2 vMaskTextureCoord;
    uniform sampler2D uSampler;
    uniform sampler2D visionTexture;

    void main() {
      float explored = texture2D(uSampler, vTextureCoord).r;
      float visible = texture2D(visionTexture, vMaskTextureCoord).r;
      float fog = 1.0 - max(explored, visible);
      gl_FragColor = vec4(0.0, 0.0, 0.0, fog);
    }
  `;
}

export function registerGlobalMapFogHooks() {
  Hooks.on("visibilityRefresh", applyCellVision);
  Hooks.on("canvasReady", async () => {
    resetCellExplorationBuffers();
    await enforceCellFogIsolation(canvas.scene);
    await reconcileDiscoveredLocationCells(canvas.scene);
    invalidateCellFogCaches();
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
  Hooks.on("canvasTearDown", () => {
    restoreNativeVisibilityFilter();
    clearCellExplorationDisplay();
    resetCellExplorationBuffers();
  });
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
  await pruneHiddenDiscoveries(scene);
  if (state.fog.mode !== "cells") return;
  const discovered = new Set([
    ...state.discoveredLocationIds,
    ...state.locations.filter(location => location.alwaysDiscovered && !location.hidden).map(location => location.id)
  ]);
  const requiredKeys = state.locations
    .filter(location => discovered.has(location.id) && !location.hidden)
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
  invalidateCellFogCaches();
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
  const config = getFogConfig(scene);
  syncCellExplorationDisplay();
  if (config.mode !== "cells" || !visibility?.vision?.sight) return;
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
  const cells = getVisibleCellsForTokens(scene, getContributingTokens(), config.cellRadius);
  drawCells(vision.sight, scene, cells);
  drawCells(vision.light?.mask, scene, cells);
  queueCellExploration(cells.map(cellKey));
}

function syncCellExplorationDisplay() {
  const scene = canvas?.scene;
  const visibility = canvas?.visibility;
  const explored = visibility?.explored;
  if (!scene || !explored || !getGlobalMapFlag(scene)) return;
  const isCellMode = getFogConfig(scene).mode === "cells";
  if (isCellMode) installCellVisibilityFilter();
  else restoreNativeVisibilityFilter();
  const nativeSprite = canvas.fog?.sprite;
  if (nativeSprite) nativeSprite.visible = !isCellMode;
  if (!isCellMode) {
    clearCellExplorationDisplay();
    return;
  }
  // Draw only the cells that appeared since the last pass. Rebuilding the whole
  // explored layer on every vision refresh is what made big vision radii lag.
  const keys = getKnownExploredKeys(scene);
  const pending = [];
  for (const key of keys) {
    if (drawnCellFogKeys.has(key)) continue;
    drawnCellFogKeys.add(key);
    pending.push(key);
  }
  if (!pending.length) return;
  ensureCellExplorationGraphic(explored);
  cellExplorationGraphic.beginFill(0xFF0000);
  for (const key of pending) drawCellPolygon(cellExplorationGraphic, scene, key);
  cellExplorationGraphic.endFill();
}

function ensureCellExplorationGraphic(explored) {
  if (cellExplorationGraphic && !cellExplorationGraphic.destroyed && cellExplorationGraphic.parent === explored) {
    return cellExplorationGraphic;
  }
  cellExplorationGraphic = new PIXI.LegacyGraphics();
  cellExplorationGraphic.name = "fallout-maw-cell-fog-exploration";
  explored.addChildAt(cellExplorationGraphic, Math.min(1, explored.children.length));
  return cellExplorationGraphic;
}

function installCellVisibilityFilter() {
  const visibility = canvas?.visibility;
  const visionTexture = canvas?.masks?.vision?.renderTexture;
  if (!visibility?.filter || !visionTexture) return;
  if (cellVisibilityFilter && !cellVisibilityFilter.destroyed) {
    if (visibility.filter !== cellVisibilityFilter) {
      visibility.filter = cellVisibilityFilter;
      visibility.filters = [cellVisibilityFilter];
    }
    return;
  }
  nativeVisibilityFilter = visibility.filter;
  cellVisibilityFilter = new CellFogVisibilityFilter(visionTexture);
  visibility.filter = cellVisibilityFilter;
  visibility.filters = [cellVisibilityFilter];
}

function restoreNativeVisibilityFilter() {
  const visibility = canvas?.visibility;
  if (visibility && nativeVisibilityFilter && visibility.filter === cellVisibilityFilter) {
    visibility.filter = nativeVisibilityFilter;
    visibility.filters = [nativeVisibilityFilter];
  }
  if (cellVisibilityFilter && !cellVisibilityFilter.destroyed) cellVisibilityFilter.destroy();
  cellVisibilityFilter = null;
  nativeVisibilityFilter = null;
}

function clearCellExplorationDisplay() {
  if (cellExplorationGraphic && !cellExplorationGraphic.destroyed) {
    cellExplorationGraphic.destroy();
  }
  cellExplorationGraphic = null;
  drawnCellFogKeys = new Set();
}

function drawCells(graphic, scene, cells) {
  if (!graphic) return;
  for (const cell of cells) {
    const vertices = getCellVertices(scene, cell);
    if (vertices.length < 3) continue;
    graphic.drawPolygon(vertices.flatMap(point => [point.x, point.y]));
  }
}

function drawCellPolygon(graphic, scene, key) {
  const cell = parseCellKey(key);
  if (!cell) return;
  const vertices = getCellVertices(scene, cell);
  if (vertices.length < 3) return;
  graphic.drawPolygon(vertices.flatMap(point => [point.x, point.y]));
}

/** Explored keys of the current scene as a Set, rebuilt only when the stored state changes. */
function getKnownExploredKeys(scene) {
  const sourceKey = scene?.id ?? "";
  const stored = getSceneState(scene).fog.exploredCellKeys;
  if (knownExploredKeys && knownExploredSourceKey === sourceKey && knownExploredArrayRef === stored) {
    return knownExploredKeys;
  }
  knownExploredKeys = new Set(stored);
  knownExploredSourceKey = sourceKey;
  knownExploredArrayRef = stored;
  return knownExploredKeys;
}

function invalidateCellFogCaches() {
  knownExploredKeys = null;
  knownExploredSourceKey = null;
  knownExploredArrayRef = null;
  knownFogConfig = null;
  knownFogConfigSource = null;
  knownFogConfigKey = null;
  drawnCellFogKeys = new Set();
}

/**
 * Reads only the fog configuration from the Scene flag. getSceneState() deep clones the
 * whole state (including every explored cell), which is far too heavy for the per-frame
 * vision path that only needs the mode and the radius.
 */
function getFogConfig(scene) {
  const state = getGlobalMapFlag(scene)?.state;
  const source = state?.fog;
  const key = scene?.id ?? "";
  if (knownFogConfig && knownFogConfigSource === key && knownFogConfigKey === source) return knownFogConfig;
  knownFogConfig = {
    mode: source?.mode === "cells" ? "cells" : "native",
    cellRadius: Math.max(1, Math.round(Number(source?.cellRadius) || 2))
  };
  knownFogConfigSource = key;
  knownFogConfigKey = source;
  return knownFogConfig;
}

/** Drops the dirty buffer and the queued writer, used when the canvas is torn down. */
function resetCellExplorationBuffers() {
  invalidateCellFogCaches();
  dirtyCellKeys = new Set();
  cellExplorationFlushScheduled = false;
  cellFogGeneration += 1;
}

/** Queues the serialized writer. No timers: the flush loop drains the dirty buffer. */
function scheduleCellExplorationFlush() {
  if (cellExplorationFlushScheduled) return;
  cellExplorationFlushScheduled = true;
  queueMicrotask(() => {
    cellExplorationFlushScheduled = false;
    void flushCellExploration();
  });
}

/**
 * Persists every newly explored cell. Writes are fully serialized: a write in flight is
 * awaited before the next one starts (no timers, no debounce guessing), and cells
 * discovered meanwhile are picked up by the next pass.
 */
function flushCellExploration() {
  return queueCellFogWrite(async () => {
    const scene = canvas?.scene;
    if (!scene) return;
    while (dirtyCellKeys.size && canvas?.scene === scene) {
      const generation = cellFogGeneration;
      const additions = Array.from(dirtyCellKeys);
      dirtyCellKeys = new Set();
      // A reset invalidates everything buffered before it: never resurrect those cells.
      if (generation !== cellFogGeneration) continue;
      const known = getKnownExploredKeys(scene);
      for (const key of additions) known.add(key);
      const merged = Array.from(known);
      await updateSceneState(scene, state => {
        state.fog.exploredCellKeys = merged;
        return state;
      });
      if (generation !== cellFogGeneration) continue;
      // Keep the cache valid against the freshly written array.
      knownExploredArrayRef = merged;
      knownExploredSourceKey = scene.id;
      game.socket.emit(GLOBAL_MAP_SOCKET, {
        action: "globalMap.cellFog.changed",
        sceneId: scene.id
      });
    }
  });
}

/**
 * Serializes every fog write, mirroring FogManager's Semaphore: concurrent callers wait
 * for the write in flight instead of racing it (a race could restore stale cells).
 */
function queueCellFogWrite(run) {
  const attempt = fogWriteChain.then(run, run);
  fogWriteChain = attempt.then(() => undefined, () => undefined);
  return attempt;
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
  const config = getFogConfig(scene);
  if (!scene || config.mode !== "cells") return;
  const known = getKnownExploredKeys(scene);
  const requested = Array.isArray(keys)
    ? keys
    : getVisibleCellsForTokens(scene, getContributingTokens(), config.cellRadius).map(cellKey);
  // O(1) membership per cell instead of scanning the whole explored array on every move.
  const fresh = requested.filter(key => key && !known.has(key) && !dirtyCellKeys.has(key));
  if (!fresh.length) return;
  for (const key of fresh) {
    dirtyCellKeys.add(key);
    known.add(key);
  }
  // Local rendering is immediate; the document write is serialized behind the queue.
  syncCellExplorationDisplay();
  if (game.user?.isGM && isResponsibleGM()) {
    scheduleCellExplorationFlush();
    return;
  }
  if (cellExplorationQueued) return;
  cellExplorationQueued = true;
  queueMicrotask(() => {
    cellExplorationQueued = false;
    const currentScene = canvas?.scene;
    if (!currentScene || getSceneState(currentScene).fog.mode !== "cells") return;
    const visibleKeys = getVisibleCellsForTokens(
      currentScene,
      getContributingTokens(),
      getSceneState(currentScene).fog.cellRadius
    ).map(cellKey).filter(key => key && !getKnownExploredKeys(currentScene).has(key));
    if (!visibleKeys.length) return;
    game.socket.emit(GLOBAL_MAP_SOCKET, {
      action: "globalMap.cellFog.request",
      sceneId: currentScene.id,
      userId: game.user?.id,
      cellKeys: visibleKeys
    });
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
  // Set lookups: these lists grow all game long and an includes() per candidate made
  // discovery scale with the number of already found entries.
  const knownLocations = new Set(state.discoveredLocationIds);
  const knownTransitions = new Set(state.discoveredTransitionIds);
  const knownExits = new Set(state.discoveredExitZoneIds);
  const locationIds = state.locations
    .filter(location => !location.hidden && (location.alwaysDiscovered || isLocationVisible(scene, state, location)))
    .map(location => location.id)
    .filter(id => !knownLocations.has(id));
  const transitionIds = state.transitions
    .filter(transition => !transition.hidden && isMapAreaOnLevel(scene, transition) && isCellsVisible(scene, state, transition.cells))
    .map(transition => transition.id)
    .filter(id => !knownTransitions.has(id));
  const exitZoneIds = state.locationExitZones
    .filter(exit => !exit.hidden && isMapAreaOnLevel(scene, exit) && (exit.alwaysDiscovered || isCellsVisible(scene, state, exit.cells)))
    .map(exit => exit.id)
    .filter(id => !knownExits.has(id));
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

async function handleFogSocket(payload, senderUserId = "") {
  if (!payload || typeof payload !== "object") return;
  const authenticatedSenderId = String(senderUserId ?? "").trim();
  if (!authenticatedSenderId) return;
  if (["globalMap.cellFog.request", "globalMap.discovery.request"].includes(payload.action)) {
    if (authenticatedSenderId !== String(payload.userId ?? "")) return;
  } else if (authenticatedSenderId !== getResponsibleGM()?.id) return;
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
      if (!location?.hidden && (location?.alwaysDiscovered || userHasNearbyOwnedToken(user, scene, state, location, "location"))) {
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
      if (!exit?.hidden && (exit?.alwaysDiscovered || (exit && userHasNearbyOwnedToken(user, scene, state, exit, "exit")))) {
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
  knownExploredArrayRef = null;
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
  const beforeState = getSceneState(scene);
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
  const afterState = getSceneState(scene);
  const locationSet = new Set(locationIds.map(String));
  const transitionSet = new Set(transitionIds.map(String));
  const exitSet = new Set(exitZoneIds.map(String));
  const discoveryEvents = buildGlobalMapDiscoveryEvents({
    scene,
    locations: afterState.locations.filter(entry => locationSet.has(String(entry.id))),
    transitions: afterState.transitions.filter(entry => transitionSet.has(String(entry.id))),
    exits: afterState.locationExitZones.filter(entry => exitSet.has(String(entry.id)))
  });
  if (discoveryEvents.length) {
    await withSystemEventRoot({
      kind: "globalMapDiscovery",
      operationId: `global-map-discovery:${scene.id}:${foundry.utils.randomID()}`,
      sceneUuid: String(scene.uuid ?? ""),
      combatUuid: String(game.combat?.uuid ?? "")
    }, async scope => {
      for (const [index, event] of discoveryEvents.entries()) {
        await scope.emit(event.key, {
          data: event.data,
          before: {
            discoveredLocationIds: beforeState.discoveredLocationIds,
            discoveredTransitionIds: beforeState.discoveredTransitionIds,
            discoveredExitZoneIds: beforeState.discoveredExitZoneIds
          },
          after: {
            discoveredLocationIds: afterState.discoveredLocationIds,
            discoveredTransitionIds: afterState.discoveredTransitionIds,
            discoveredExitZoneIds: afterState.discoveredExitZoneIds
          }
        }, {
          occurrenceKey: `global-map-discovery:${scene.id}:${event.data.discoveryType}:${event.data.entryId}:${index}`,
          participants: { source: null, target: null, related: [] }
        });
      }
    });
  }
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

async function pruneHiddenDiscoveries(scene) {
  if (!scene || !game.user?.isGM || !isResponsibleGM()) return false;
  const state = getSceneState(scene);
  const nextLocationIds = state.discoveredLocationIds.filter(id => !state.locations.find(entry => entry.id === id)?.hidden);
  const nextExitIds = state.discoveredExitZoneIds.filter(id => !state.locationExitZones.find(entry => entry.id === id)?.hidden);
  const changed = nextLocationIds.length !== state.discoveredLocationIds.length
    || nextExitIds.length !== state.discoveredExitZoneIds.length;
  if (!changed) return false;
  await updateSceneState(scene, current => {
    current.discoveredLocationIds = nextLocationIds;
    current.discoveredExitZoneIds = nextExitIds;
    return current;
  });
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.discovery.changed",
    sceneId: scene.id
  });
  return true;
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
    if (kind !== "location" && !isMapAreaOnLevel(scene, entry, getMapTokenLevelId(scene, token))) return false;
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

/**
 * Narrow hooks used by the unit tests to drive the exploration batcher without a
 * live canvas. They intentionally expose only the batching behaviour.
 */
export const __test = {
  queueExploration(cells) {
    queueCellExploration(cells.map(cellKey));
  },
  async flushExploration() {
    await flushCellExploration();
  },
  resetCaches() {
    invalidateCellFogCaches();
    dirtyCellKeys = new Set();
    cellExplorationFlushScheduled = false;
    cellFogGeneration += 1;
  },
  syncDisplay() {
    syncCellExplorationDisplay();
  },
  resetCellFog(scene) {
    return resetCellFog(scene);
  },
  dirtyCount() {
    return dirtyCellKeys.size;
  },
  drawnCellCount() {
    return drawnCellFogKeys.size;
  }
};

export async function resetCellFog(scene = canvas?.scene) {
  if (!scene || !game.user?.isGM || !isResponsibleGM()) return false;
  resetCellExplorationBuffers();
  // Runs on the same serialized chain as the exploration writes, so a write that is
  // already in flight cannot land after the reset and restore the cleared cells.
  await queueCellFogWrite(async () => {
    await updateSceneState(scene, state => {
      state.fog.exploredCellKeys = [];
      state.discoveredLocationIds = state.locations
        .filter(entry => entry.alwaysDiscovered && !entry.hidden)
        .map(entry => entry.id);
      state.discoveredTransitionIds = [];
      state.discoveredExitZoneIds = state.locationExitZones
        .filter(entry => entry.alwaysDiscovered && !entry.hidden)
        .map(entry => entry.id);
      return state;
    });
  });
  invalidateCellFogCaches();
  game.socket.emit(GLOBAL_MAP_SOCKET, {
    action: "globalMap.cellFog.changed",
    sceneId: scene.id
  });
  if (scene.id === canvas.scene?.id) {
    // The explored overlay is never rebuilt from scratch, so a reset has to drop the
    // already drawn cells explicitly and let Foundry clear its exploration texture.
    clearCellExplorationDisplay();
    canvas.visibility?.resetExploration?.();
    syncCellExplorationDisplay();
    canvas.perception?.initialize?.();
    canvas.perception?.update?.({ refreshVision: true });
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
  return true;
}

async function onFogReset() {
  if (!game.user?.isGM || !isResponsibleGM() || !getGlobalMapFlag(canvas?.scene)) return;
  if (getSceneState(canvas.scene).fog.mode === "cells") return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: auditLocalize("FALLOUTMAW.AuditRuntime.R0940", "Сбросить обнаружение карты?") },
    content: auditLocalize("FALLOUTMAW.AuditRuntime.R0941", "<p>Туман сброшен. Также скрыть все обнаруженные локации, переходы и зоны выхода этой сцены?</p>"),
    yes: { label: auditLocalize("FALLOUTMAW.AuditRuntime.R0942", "Сбросить обнаружение") },
    no: { label: auditLocalize("FALLOUTMAW.AuditRuntime.R0943", "Сохранить обнаружение") }
  });
  if (!confirmed) return;
  await updateSceneState(canvas.scene, state => {
    state.discoveredLocationIds = state.locations
      .filter(entry => entry.alwaysDiscovered && !entry.hidden)
      .map(entry => entry.id);
    state.discoveredTransitionIds = [];
    state.discoveredExitZoneIds = state.locationExitZones
      .filter(entry => entry.alwaysDiscovered && !entry.hidden)
      .map(entry => entry.id);
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
