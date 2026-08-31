import {
  buildWeaponNoiseZone,
  doGridZonesOverlap,
  getGridOffsetKey,
  getStealthObserverZones,
  getTokenVisualizationGridKey,
  invalidateStealthDetectionCache
} from "./detection.mjs";
import { isValidStealthObserver } from "./observers.mjs";
import {
  canControlStealth,
  getRuntimeStealthSettings,
  isActorStealthed
} from "./rules.mjs";
import { getActorAdjustedNoiseLevel } from "./noise.mjs";

const STEALTH_DETECTION_LAYER = "falloutMawStealthDetectionZones";
const STEALTH_DETECTION_HOVER_LAYER = "falloutMawStealthDetectionHoverZone";
const STEALTH_PERSISTENT_SOURCE_ID = "stealth-persistent";
const STEALTH_WINDOW_SOURCE_ID = "stealth-window";
const WEAPON_SOURCE_PREFIX = "weapon:";
const VISUALIZATION_COALESCE_MS = 50;
const BASE_ZONE_COLOR = 0xff3b3b;
const WEAPON_NOISE_ZONE_COLOR = 0xff3b3b;
const STEALTH_VISION_MASK_FILTER = Symbol("falloutMawStealthVisionMaskFilter");

const visualizationSources = new Map();
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
  setDetectionVisualizationSource(token.id, STEALTH_WINDOW_SOURCE_ID, 0);
}

export function removeDetectionVisualization(tokenId, { refreshHover = true } = {}) {
  if (!tokenId) return;
  clearDetectionVisualizationSource(tokenId, STEALTH_WINDOW_SOURCE_ID, { refreshHover });
}

export function setPersistentDetectionVisualization(token, active = true) {
  if (!token?.id) return;
  if (active) setDetectionVisualizationSource(token.id, STEALTH_PERSISTENT_SOURCE_ID, 0);
  else clearDetectionVisualizationSource(token.id, STEALTH_PERSISTENT_SOURCE_ID);
}

/**
 * Apply one role-independent local privacy gate to persistent, window, and
 * weapon sources. Administrative hiding never exposes a visualization merely
 * because the current user is a GM.
 */
export function canRenderDetectionVisualizationForLocalUser(token) {
  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.ready || !token?.actor || !isActorStealthed(token.actor)) return false;
  const parentScene = token.document?.parent;
  if (parentScene?.documentName === "Scene" && parentScene.id !== activeCanvas.scene?.id) return false;
  if (token.document?.hidden === true || token.hidden === true) return false;
  const controlled = activeCanvas.tokens?.controlled ?? [];
  if (controlled.length !== 1 || controlled[0]?.id !== token.id) return false;
  if (!canControlStealth(token.actor)) return false;
  if (token.visible === false || token.renderable === false) return false;
  // Foundry's rendered Token always exposes `visible`. Only fall back to the
  // expensive isVisible getter for document-like test doubles/compatibility.
  if (token.visible === undefined && token.isVisible === false) return false;
  return true;
}

export function setWeaponNoisePreview(token, sourceId, noiseLevel) {
  const normalizedSourceId = String(sourceId ?? "").trim();
  if (!token?.id || !normalizedSourceId) return;
  setDetectionVisualizationSource(
    token.id,
    `${WEAPON_SOURCE_PREFIX}${normalizedSourceId}`,
    normalizeNoiseLevel(getActorAdjustedNoiseLevel(token.actor, noiseLevel))
  );
}

export function clearWeaponNoisePreview(tokenId, sourceId) {
  const normalizedSourceId = String(sourceId ?? "").trim();
  if (!tokenId || !normalizedSourceId) return;
  clearDetectionVisualizationSource(tokenId, `${WEAPON_SOURCE_PREFIX}${normalizedSourceId}`);
}

function setDetectionVisualizationSource(tokenId, sourceId, noiseLevel) {
  let sources = visualizationSources.get(tokenId);
  if (!sources) {
    sources = new Map();
    visualizationSources.set(tokenId, sources);
  }
  const normalizedNoise = normalizeNoiseLevel(noiseLevel);
  if (sources.get(sourceId) === normalizedNoise) return;
  sources.set(sourceId, normalizedNoise);
  queueDetectionVisualizationRefresh();
}

function clearDetectionVisualizationSource(tokenId, sourceId, { refreshHover = true } = {}) {
  const sources = visualizationSources.get(tokenId);
  if (!sources?.delete(sourceId)) return;
  if (!sources.size) {
    removeAllDetectionVisualizationSources(tokenId, { refreshHover });
    queueDetectionVisualizationRefresh();
    return;
  }
  queueDetectionVisualizationRefresh();
}

function getEffectiveVisualizationRequest(sources, settings) {
  const hasPersistentSource = sources?.has(STEALTH_PERSISTENT_SOURCE_ID);
  const hasStealthWindow = sources?.has(STEALTH_WINDOW_SOURCE_ID);
  const autoDetectionEnabled = settings?.autoDetection?.enabled === true;
  const hasWeaponSource = hasWeaponVisualizationSource(sources);
  const noiseLevel = autoDetectionEnabled ? getMaximumWeaponNoiseSource(sources) : 0;
  return {
    active: Boolean(
      hasPersistentSource
      || hasStealthWindow
      || (autoDetectionEnabled && hasWeaponSource)
    ),
    noiseLevel,
    showNoiseZone: autoDetectionEnabled && hasWeaponSource
  };
}

function getMaximumWeaponNoiseSource(sources) {
  let noiseLevel = 0;
  for (const [sourceId, sourceNoise] of sources ?? []) {
    if (!sourceId.startsWith(WEAPON_SOURCE_PREFIX)) continue;
    noiseLevel = Math.max(noiseLevel, normalizeNoiseLevel(sourceNoise));
  }
  return noiseLevel;
}

function hasWeaponVisualizationSource(sources) {
  for (const sourceId of sources?.keys?.() ?? []) {
    if (sourceId.startsWith(WEAPON_SOURCE_PREFIX)) return true;
  }
  return false;
}

function normalizeNoiseLevel(value) {
  return Math.max(0, Number(value) || 0);
}

function removeAllDetectionVisualizationSources(tokenId, {
  refreshHover = true
} = {}) {
  if (!tokenId) return;
  visualizationSources.delete(tokenId);
  destroyRenderedDetectionVisualization(tokenId);
  movementKeys.delete(tokenId);
  stopDetectionVisualizationMovementTracking(tokenId);
  if (refreshHover) refreshDetectionHoverFill();
  destroyUnusedDetectionLayers();
}

function destroyRenderedDetectionVisualization(tokenId) {
  const visualization = detectionVisualizations.get(tokenId);
  if (visualization) visualization.container?.destroy?.({ children: true });
  detectionVisualizations.delete(tokenId);
}

export function refreshDetectionVisualizations({ invalidate = false } = {}) {
  if (invalidate) invalidateStealthDetectionCache();
  const activeCanvas = globalThis.canvas;
  refreshDetectionVisualizationMaskState();
  const settings = getRuntimeStealthSettings();
  for (const [tokenId, sources] of [...visualizationSources]) {
    const token = activeCanvas?.tokens?.get(tokenId);
    if (!token?.actor || !isActorStealthed(token.actor)) {
      removeAllDetectionVisualizationSources(tokenId, {
        refreshHover: false
      });
      continue;
    }
    if (!canRenderDetectionVisualizationForLocalUser(token)) {
      destroyRenderedDetectionVisualization(tokenId);
      continue;
    }
    const request = getEffectiveVisualizationRequest(sources, settings);
    if (!request.active) {
      destroyRenderedDetectionVisualization(tokenId);
      continue;
    }
    rebuildDetectionVisualization(token, request, settings);
  }
  refreshDetectionHoverFill();
  destroyUnusedDetectionLayers();
}

/**
 * Fail closed synchronously when Foundry changes the active point of view.
 * VisionMaskFilter disables itself when no VisionSource is active, so keeping
 * a stale renderable layer for even one frame would expose its full geometry.
 */
export function refreshDetectionVisualizationMaskState() {
  const activeCanvas = globalThis.canvas;
  const renderable = visualizationSources.size > 0 && canRenderLocalStealthOverlay();
  const layer = activeCanvas?.controls?.[STEALTH_DETECTION_LAYER];
  if (layer) layer.renderable = renderable;
  const highlightLayer = activeCanvas?.interface?.grid
    ?.getHighlightLayer?.(STEALTH_DETECTION_HOVER_LAYER);
  if (highlightLayer) highlightLayer.renderable = renderable;
  return renderable;
}

function destroyUnusedDetectionLayers() {
  if (detectionVisualizations.size) return;
  const activeCanvas = globalThis.canvas;
  const gridLayer = activeCanvas?.interface?.grid;
  const highlightLayer = gridLayer?.getHighlightLayer?.(STEALTH_DETECTION_HOVER_LAYER);
  destroyNativeVisionMask(highlightLayer);
  gridLayer?.destroyHighlightLayer?.(STEALTH_DETECTION_HOVER_LAYER);

  const layer = activeCanvas?.controls?.[STEALTH_DETECTION_LAYER];
  if (!layer) return;
  destroyNativeVisionMask(layer);
  layer.parent?.removeChild?.(layer);
  layer.destroy?.({ children: true });
  delete activeCanvas.controls[STEALTH_DETECTION_LAYER];
}

export function hasDetectionVisualizationSources() {
  return visualizationSources.size > 0;
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
  removeAllDetectionVisualizationSources(tokenId);
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
  visualizationSources.clear();
  detectionVisualizations.clear();
  movementKeys.clear();
  movementTrackers.clear();
  pendingRefreshAfterMovement = false;
  pendingInvalidation = false;
  hoverTokenId = null;
  const gridLayer = globalThis.canvas?.interface?.grid;
  destroyNativeVisionMask(gridLayer?.getHighlightLayer?.(STEALTH_DETECTION_HOVER_LAYER));
  gridLayer?.destroyHighlightLayer?.(STEALTH_DETECTION_HOVER_LAYER);
  const layer = globalThis.canvas?.controls?.[STEALTH_DETECTION_LAYER];
  destroyNativeVisionMask(layer);
  layer?.destroy?.({ children: true });
  if (globalThis.canvas?.controls) delete canvas.controls[STEALTH_DETECTION_LAYER];
}

export function getStealthVisualizationStats() {
  let sourceCount = 0;
  let maximumNoiseLevel = 0;
  for (const sources of visualizationSources.values()) {
    sourceCount += sources.size;
    maximumNoiseLevel = Math.max(maximumNoiseLevel, getMaximumWeaponNoiseSource(sources));
  }
  return Object.freeze({
    active: visualizationSources.size,
    sources: sourceCount,
    maximumNoiseLevel,
    rendered: detectionVisualizations.size,
    movements: movementTrackers.size,
    queued: Boolean(refreshTimeout)
  });
}

function rebuildDetectionVisualization(token, request, settings) {
  if (!token?.id || !globalThis.canvas?.controls) return;
  const previous = detectionVisualizations.get(token.id);
  const zones = getStealthObserverZones(token, {
    visibleOnly: true,
    settings
  });
  const noiseZone = request.showNoiseZone
    ? buildWeaponNoiseVisualizationZone(token, request.noiseLevel)
    : null;
  if (!zones.length && !noiseZone) {
    previous?.container?.destroy?.({ children: true });
    detectionVisualizations.delete(token.id);
    return;
  }

  const layer = getDetectionLayer();
  const renderSignature = getDetectionVisualizationRenderSignature(zones, noiseZone);
  if (previous?.renderSignature === renderSignature) {
    previous.zones = zones;
    previous.noiseZone = noiseZone;
    refreshDetectionHoverFill();
    return;
  }

  const container = new PIXI.Container();
  container.eventMode = "none";
  container.interactiveChildren = false;
  if (noiseZone) {
    const graphics = new PIXI.Graphics();
    graphics.eventMode = "none";
    graphics.interactiveChildren = false;
    drawWeaponNoiseZone(graphics, noiseZone);
    container.addChild(graphics);
  }
  if (zones.length) {
    const graphics = new PIXI.Graphics();
    graphics.eventMode = "none";
    graphics.interactiveChildren = false;
    for (const zone of zones) drawBaseGridZone(graphics, zone);
    container.addChild(graphics);
  }
  layer.addChild(container);
  detectionVisualizations.set(token.id, { container, zones, noiseZone, renderSignature });
  previous?.container?.destroy?.({ children: true });
}

function getDetectionVisualizationRenderSignature(zones, noiseZone) {
  const zoneParts = zones.map(zone => [
    zone.observerToken?.document?.uuid ?? zone.observerToken?.id ?? "",
    zone.cacheSignature ?? getGridZoneOffsetSignature(zone)
  ].join("@"));
  return `${zoneParts.join("|")}::${getGridZoneOffsetSignature(noiseZone)}`;
}

function getGridZoneOffsetSignature(zone) {
  if (!zone) return "";
  return [
    Number(zone.noiseLevel) || 0,
    ...(zone.offsets ?? []).map(getGridOffsetKey)
  ].join(":");
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
  if (!token?.actor || !visualizationSources.size) return false;
  if (visualizationSources.has(token.id)) return true;
  for (const hiddenTokenId of visualizationSources.keys()) {
    const hiddenToken = globalThis.canvas?.tokens?.get(hiddenTokenId);
    if (hiddenToken && isValidStealthObserver(hiddenToken, token)) return true;
  }
  return false;
}

function getDetectionLayer() {
  const activeCanvas = globalThis.canvas;
  activeCanvas.controls[STEALTH_DETECTION_LAYER] ??= activeCanvas.controls.addChild(new PIXI.Container());
  const layer = activeCanvas.controls[STEALTH_DETECTION_LAYER];
  layer.eventMode = "none";
  layer.interactiveChildren = false;
  layer.renderable = canRenderLocalStealthOverlay();
  if (activeCanvas.masks?.canvas) {
    layer.mask = activeCanvas.masks.canvas;
  }
  applyNativeVisionMask(layer);
  return layer;
}

/**
 * Reuse Foundry's cached vision texture. The filter follows the engine's
 * continuously-updated mask on the GPU, so movement does not trigger a JS
 * rebuild of every detection cell. Unlike the core Region editor, this
 * gameplay overlay deliberately applies the same filter to GMs.
 */
function applyNativeVisionMask(displayObject) {
  if (!displayObject || displayObject[STEALTH_VISION_MASK_FILTER]) return;
  const Filter = globalThis.foundry?.canvas?.rendering?.filters?.VisionMaskFilter
    ?? globalThis.VisionMaskFilter;
  if (typeof Filter?.create !== "function") return;
  const filter = Filter.create();
  if (!filter) return;
  displayObject.filters = [...(displayObject.filters ?? []), filter];
  displayObject.filterArea = globalThis.canvas?.app?.screen ?? displayObject.filterArea;
  displayObject[STEALTH_VISION_MASK_FILTER] = filter;
}

function destroyNativeVisionMask(displayObject) {
  const filter = displayObject?.[STEALTH_VISION_MASK_FILTER];
  if (!filter) return;
  displayObject.filters = (displayObject.filters ?? []).filter(candidate => candidate !== filter);
  filter.destroy?.();
  delete displayObject[STEALTH_VISION_MASK_FILTER];
}

function refreshDetectionHoverFill() {
  clearDetectionHoverFill();
  const activeCanvas = globalThis.canvas;
  if (
    !canRenderLocalStealthOverlay()
    || !hoverTokenId
    || !detectionVisualizations.size
    || !activeCanvas?.interface?.grid
    || activeCanvas.grid?.isGridless
  ) return;

  const baseOffsetGroups = [];
  const contactingNoiseOffsetGroups = [];
  for (const visualization of detectionVisualizations.values()) {
    const hoveredZones = (visualization.zones ?? [])
      .filter(zone => zone.observerToken?.id === hoverTokenId);
    for (const zone of hoveredZones) {
      baseOffsetGroups.push(zone.offsets ?? []);
    }
    // The noise zone joins hover fill only after the exact same cell-overlap
    // predicate used by gameplay has established a reaction opportunity.
    if (
      visualization.noiseZone?.offsets?.length
      && hoveredZones.some(zone => doGridZonesOverlap(zone, visualization.noiseZone))
    ) {
      contactingNoiseOffsetGroups.push(visualization.noiseZone.offsets);
    }
  }
  if (!baseOffsetGroups.length) return;

  const gridLayer = activeCanvas.interface.grid;
  const highlightLayer = gridLayer.addHighlightLayer(STEALTH_DETECTION_HOVER_LAYER);
  if (highlightLayer) highlightLayer.renderable = canRenderLocalStealthOverlay();
  applyNativeVisionMask(highlightLayer);
  const highlightedOffsets = collectUniqueGridOffsets([
    ...baseOffsetGroups,
    ...contactingNoiseOffsetGroups
  ]);
  highlightGridOffsets(gridLayer, highlightedOffsets, {
    color: BASE_ZONE_COLOR,
    alpha: 0.14
  });
}

function clearDetectionHoverFill() {
  globalThis.canvas?.interface?.grid?.clearHighlightLayer?.(STEALTH_DETECTION_HOVER_LAYER);
}

function canRenderLocalStealthOverlay() {
  const activeCanvas = globalThis.canvas;
  const controlled = activeCanvas?.tokens?.controlled ?? [];
  if (controlled.length !== 1) return false;
  if (!activeCanvas.visibility?.tokenVision) return true;
  if (activeCanvas.visibility?.visible === false) return false;
  const pointOfView = controlled[0];
  const sources = activeCanvas.effects?.visionSources;
  if (sources) {
    const activeSources = [];
    for (const source of sources?.values?.() ?? sources ?? []) {
      if (!source?.active) continue;
      if (source?.data?.preview === true || source?.preview === true || source?.isPreview === true) return false;
      activeSources.push(source);
    }
    if (activeSources.length !== 1) return false;
    const [source] = activeSources;
    return source.object === pointOfView
      || Boolean(source.object?.id && source.object.id === pointOfView.id);
  }
  return pointOfView?.vision?.active === true;
}

function highlightGridOffsets(gridLayer, offsets, { color, alpha }) {
  for (const offset of offsets) {
    const { x, y } = globalThis.canvas.grid.getTopLeftPoint(offset);
    gridLayer.highlightPosition(STEALTH_DETECTION_HOVER_LAYER, {
      x,
      y,
      color,
      alpha
    });
  }
}

function drawBaseGridZone(graphics, zone) {
  drawGridZoneOutline(graphics, zone.offsets ?? [], {
    width: 2,
    color: BASE_ZONE_COLOR,
    alpha: 0.85
  });
}

/**
 * Weapon noise belongs to the attacker, not to every observer. A single
 * source-owned grid zone can overlap any ordinary observer zone without
 * repainting those zones at a larger radius.
 */
function buildWeaponNoiseVisualizationZone(token, noiseLevel) {
  return buildWeaponNoiseZone(token, { noiseLevel });
}

function drawWeaponNoiseZone(graphics, zone) {
  drawGridZoneOutline(graphics, zone.offsets ?? [], {
    width: 2,
    color: WEAPON_NOISE_ZONE_COLOR,
    alpha: 0.9
  });
}

function drawGridZoneOutline(graphics, offsets, { width, color, alpha }) {
  graphics.lineStyle(width, color, alpha);
  const edges = collectGridBoundaryEdges(
    offsets,
    offset => globalThis.canvas?.grid?.getVertices?.(offset)
  );
  for (const edge of edges) {
    graphics.moveTo(edge.start.x, edge.start.y);
    graphics.lineTo(edge.end.x, edge.end.y);
  }
}

/**
 * Build a stable scene-grid union without mutating cached zone offsets.
 */
export function collectUniqueGridOffsets(offsetGroups = []) {
  const uniqueOffsets = new Map();
  for (const offsets of offsetGroups ?? []) {
    for (const offset of offsets ?? []) {
      const key = getGridOffsetKey(offset);
      if (!uniqueOffsets.has(key)) uniqueOffsets.set(key, offset);
    }
  }
  return [...uniqueOffsets.values()];
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
