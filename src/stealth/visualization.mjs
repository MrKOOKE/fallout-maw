import {
  getStealthObserverZones,
  getTokenVisualizationGridKey,
  invalidateStealthDetectionCache
} from "./detection.mjs";
import { isValidStealthObserver } from "./observers.mjs";
import { isActorStealthed } from "./rules.mjs";

const STEALTH_DETECTION_LAYER = "falloutMawStealthDetectionZones";
const STEALTH_DETECTION_HOVER_LAYER = "falloutMawStealthDetectionHoverZone";
const VISUALIZATION_COALESCE_MS = 50;

const activeVisualizations = new Set();
const detectionVisualizations = new Map();
const movementKeys = new Map();
const movementTrackers = new Map();

let hoverTokenId = null;
let refreshTimeout = null;
let pendingRefreshAfterMovement = false;
let pendingInvalidation = false;
let refreshWindowsCallback = () => undefined;

export function configureStealthVisualization({ refreshWindows } = {}) {
  refreshWindowsCallback = typeof refreshWindows === "function" ? refreshWindows : () => undefined;
}

/**
 * Mark a hidden token as visualized. Heavy geometry is deliberately queued
 * outside ApplicationV2#render so repeated window renders collapse into one
 * canvas update.
 */
export function updateDetectionVisualization(token) {
  if (!token?.id) return;
  activeVisualizations.add(token.id);
  queueDetectionVisualizationRefresh();
}

export function removeDetectionVisualization(tokenId, { refreshHover = true } = {}) {
  if (!tokenId) return;
  activeVisualizations.delete(tokenId);
  const visualization = detectionVisualizations.get(tokenId);
  if (visualization) visualization.container?.destroy?.({ children: true });
  detectionVisualizations.delete(tokenId);
  movementKeys.delete(tokenId);
  stopDetectionVisualizationMovementTracking(tokenId);
  if (refreshHover) refreshDetectionHoverFill();
}

export function refreshDetectionVisualizations({ invalidate = false } = {}) {
  if (invalidate) invalidateStealthDetectionCache();
  const activeCanvas = globalThis.canvas;
  for (const tokenId of [...activeVisualizations]) {
    const token = activeCanvas?.tokens?.get(tokenId);
    if (!token?.actor || !isActorStealthed(token.actor)) {
      removeDetectionVisualization(tokenId, { refreshHover: false });
      continue;
    }
    rebuildDetectionVisualization(token);
  }
  refreshDetectionHoverFill();
}

export function queueDetectionVisualizationRefresh({ invalidate = false } = {}) {
  pendingInvalidation ||= Boolean(invalidate);
  if (movementTrackers.size) {
    pendingRefreshAfterMovement = true;
    return;
  }
  if (refreshTimeout) return;
  const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
  refreshTimeout = schedule(() => {
    refreshTimeout = null;
    if (movementTrackers.size) {
      pendingRefreshAfterMovement = true;
      return;
    }
    const shouldInvalidate = pendingInvalidation;
    pendingInvalidation = false;
    refreshDetectionVisualizations({ invalidate: shouldInvalidate });
  }, VISUALIZATION_COALESCE_MS);
}

export function trackDetectionVisualizationMovement(token, animationOverride = null) {
  if (!token?.id || !isTokenRelevantToDetectionVisualization(token)) return;

  const animation = animationOverride ?? token.document?.movement?.animation?.ended ?? token.movementAnimationPromise;
  if (!animation || typeof animation.then !== "function") {
    updateDetectionVisualizationForTokenCell(token, { force: true, renderWindows: true });
    return;
  }

  const existing = movementTrackers.get(token.id);
  if (existing?.animation === animation) return;
  const tracker = { animation };
  movementTrackers.set(token.id, tracker);

  const settle = () => {
    if (movementTrackers.get(token.id) !== tracker) return;
    movementTrackers.delete(token.id);
    updateDetectionVisualizationForTokenCell(token, { force: true, renderWindows: true });
    flushPendingRefreshAfterMovement();
  };
  void Promise.resolve(animation).then(settle, settle);
}

export function onTokenHoverForDetectionZone(token, hovered) {
  if (!token?.id) return;
  if (hovered) hoverTokenId = token.id;
  else if (hoverTokenId === token.id) hoverTokenId = null;
  refreshDetectionHoverFill();
}

export function cleanupTokenStealthVisualization(tokenId) {
  removeDetectionVisualization(tokenId);
}

export function cleanupAllStealthVisualizations() {
  if (refreshTimeout) {
    const clear = globalThis.window?.clearTimeout ?? globalThis.clearTimeout;
    clear(refreshTimeout);
    refreshTimeout = null;
  }
  for (const visualization of detectionVisualizations.values()) {
    visualization.container?.destroy?.({ children: true });
  }
  activeVisualizations.clear();
  detectionVisualizations.clear();
  movementKeys.clear();
  movementTrackers.clear();
  pendingRefreshAfterMovement = false;
  pendingInvalidation = false;
  hoverTokenId = null;
  const gridLayer = globalThis.canvas?.interface?.grid;
  gridLayer?.destroyHighlightLayer?.(STEALTH_DETECTION_HOVER_LAYER);
  const layer = globalThis.canvas?.controls?.[STEALTH_DETECTION_LAYER];
  layer?.destroy?.({ children: true });
  if (globalThis.canvas?.controls) delete canvas.controls[STEALTH_DETECTION_LAYER];
}

export function getStealthVisualizationStats() {
  return Object.freeze({
    active: activeVisualizations.size,
    rendered: detectionVisualizations.size,
    movements: movementTrackers.size,
    queued: Boolean(refreshTimeout)
  });
}

function rebuildDetectionVisualization(token) {
  if (!token?.id || !globalThis.canvas?.controls) return;
  const previous = detectionVisualizations.get(token.id);
  const zones = getStealthObserverZones(token, { visibleOnly: true });
  if (!zones.length) {
    previous?.container?.destroy?.({ children: true });
    detectionVisualizations.delete(token.id);
    return;
  }

  const container = new PIXI.Container();
  container.eventMode = "none";
  container.interactiveChildren = false;
  for (const zone of zones) {
    const graphics = new PIXI.Graphics();
    graphics.eventMode = "none";
    graphics.interactiveChildren = false;
    drawGridZoneOutline(graphics, zone);
    container.addChild(graphics);
  }
  getDetectionLayer().addChild(container);
  detectionVisualizations.set(token.id, { container, zones });
  previous?.container?.destroy?.({ children: true });
}

function updateDetectionVisualizationForTokenCell(token, { force = false, renderWindows = false } = {}) {
  const key = getTokenVisualizationGridKey(token);
  if (!key) return false;
  if (!force && movementKeys.get(token.id) === key) return false;
  movementKeys.set(token.id, key);
  if (renderWindows) refreshWindowsCallback();
  queueDetectionVisualizationRefresh();
  return true;
}

function stopDetectionVisualizationMovementTracking(tokenId) {
  if (!movementTrackers.has(tokenId)) return;
  movementTrackers.delete(tokenId);
  flushPendingRefreshAfterMovement();
}

function flushPendingRefreshAfterMovement() {
  if (movementTrackers.size || !pendingRefreshAfterMovement) return;
  pendingRefreshAfterMovement = false;
  queueDetectionVisualizationRefresh({ invalidate: pendingInvalidation });
}

function isTokenRelevantToDetectionVisualization(token) {
  if (!token?.actor || !activeVisualizations.size) return false;
  if (activeVisualizations.has(token.id)) return true;
  for (const hiddenTokenId of activeVisualizations) {
    const hiddenToken = globalThis.canvas?.tokens?.get(hiddenTokenId);
    if (hiddenToken && isValidStealthObserver(hiddenToken, token)) return true;
  }
  return false;
}

function getDetectionLayer() {
  const activeCanvas = globalThis.canvas;
  activeCanvas.controls[STEALTH_DETECTION_LAYER] ??= activeCanvas.controls.addChild(new PIXI.Container());
  activeCanvas.controls[STEALTH_DETECTION_LAYER].eventMode = "none";
  activeCanvas.controls[STEALTH_DETECTION_LAYER].interactiveChildren = false;
  return activeCanvas.controls[STEALTH_DETECTION_LAYER];
}

function refreshDetectionHoverFill() {
  clearDetectionHoverFill();
  const activeCanvas = globalThis.canvas;
  if (!hoverTokenId || !detectionVisualizations.size || !activeCanvas?.interface?.grid || activeCanvas.grid?.isGridless) return;

  const zones = [];
  for (const visualization of detectionVisualizations.values()) {
    for (const zone of visualization.zones ?? []) {
      if (zone.observerToken?.id === hoverTokenId) zones.push(zone);
    }
  }
  if (!zones.length) return;

  const gridLayer = activeCanvas.interface.grid;
  gridLayer.addHighlightLayer(STEALTH_DETECTION_HOVER_LAYER);
  for (const zone of zones) {
    for (const offset of zone.offsets) {
      const { x, y } = activeCanvas.grid.getTopLeftPoint(offset);
      gridLayer.highlightPosition(STEALTH_DETECTION_HOVER_LAYER, {
        x,
        y,
        color: 0xff3b3b,
        alpha: 0.14
      });
    }
  }
}

function clearDetectionHoverFill() {
  globalThis.canvas?.interface?.grid?.clearHighlightLayer?.(STEALTH_DETECTION_HOVER_LAYER);
}

function drawGridZoneOutline(graphics, zone) {
  graphics.lineStyle(2, 0xff3b3b, 0.85);
  const edges = collectGridBoundaryEdges(zone.offsets, offset => canvas.grid.getVertices(offset));
  for (const edge of edges) {
    graphics.moveTo(edge.start.x, edge.start.y);
    graphics.lineTo(edge.end.x, edge.end.y);
  }
}

/**
 * Collect polygon edges which belong to exactly one cell. Unlike the previous
 * adjacency shortcut this works for square, hexagonal, and custom grids.
 */
export function collectGridBoundaryEdges(offsets = [], getVertices = () => []) {
  const edges = new Map();
  for (const offset of offsets) {
    const vertices = getVertices(offset) ?? [];
    for (let index = 0; index < vertices.length; index += 1) {
      const start = normalizeVertex(vertices[index]);
      const end = normalizeVertex(vertices[(index + 1) % vertices.length]);
      if (!start || !end) continue;
      const key = getEdgeKey(start, end);
      const existing = edges.get(key);
      if (existing) existing.count += 1;
      else edges.set(key, { start, end, count: 1 });
    }
  }
  return [...edges.values()]
    .filter(edge => edge.count === 1)
    .map(({ start, end }) => ({ start, end }));
}

function getEdgeKey(start, end) {
  const startKey = `${Math.round(start.x * 1000)}:${Math.round(start.y * 1000)}`;
  const endKey = `${Math.round(end.x * 1000)}:${Math.round(end.y * 1000)}`;
  return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
}

function normalizeVertex(vertex) {
  const x = Number(vertex?.x);
  const y = Number(vertex?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}
