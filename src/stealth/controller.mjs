import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { notifyDangerSenseWarning } from "../abilities/danger-sense.mjs";
import {
  deferStealthActorRefresh,
  deferStealthedTokenVisibilityRefresh,
  registerBulkOperationFlusher
} from "../utils/bulk-operation.mjs";
import { isPointInsideObserverZone, invalidateStealthDetectionCache } from "./detection.mjs";
import { invalidateLightingAnalysisCache } from "./lighting.mjs";
import { registerStealthMovementProvider } from "./movement.mjs";
import { invalidateStealthRelationCache, isValidStealthObserver } from "./observers.mjs";
import {
  calculateStealthRadius,
  canControlStealth,
  computeStealthDifficulty,
  getActorSkillValue,
  getRuntimeStealthSettings,
  getStealthStatusId,
  getTokenCenter,
  getTokenLightingAnalysis,
  invalidateStealthRuleCache,
  isActorStealthed
} from "./rules.mjs";
import {
  canVisionSourceDetectStealthedAlly,
  refreshStealthedTokenVisibility,
  registerStealthAllyVisibilityPatch
} from "./visibility-adapter.mjs";
import {
  cleanupAllStealthVisualizations,
  cleanupTokenStealthVisualization,
  configureStealthVisualization,
  onTokenHoverForDetectionZone,
  queueDetectionVisualizationRefresh,
  removeDetectionVisualization,
  trackDetectionVisualizationMovement,
  updateDetectionVisualization
} from "./visualization.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const STEALTH_SOCKET = `system.${SYSTEM_ID}`;
const STEALTH_SOCKET_SCOPE = "fallout-maw.stealth";
const STEALTH_TARGET_TOOLTIP_ID = "fallout-maw-stealth-target-tooltip";
// This delay only batches local UI work. It never gates gameplay state.
const UI_REFRESH_BATCH_MS = 50;
// Runtime perception can change on every animation frame. Cache correctness is
// immediate, while expensive local window/zone redraws wait for a quiet tail.
const RUNTIME_PERCEPTION_UI_SETTLE_MS = 150;

const stealthWindows = new Map();
const windowRenderStates = new WeakMap();
const pendingActorRefreshes = new Map();
const tokenAnimationTasks = new Map();
const runtimeSignatureObjectIds = new WeakMap();

let targetMode = null;
let hooksRegistered = false;
let stealthSocketRegistered = false;
let refreshTimeout = null;
let runtimePerceptionUiTimeout = null;
let runtimePerceptionSignature = null;
let nextRuntimeSignatureObjectId = 1;
let refreshAllWindowsPending = false;
let visibilityRefreshPending = false;
let visualizationRefreshPending = false;

export function registerStealthHooks() {
  if (hooksRegistered) return;
  registerBulkOperationFlusher(flushDeferredStealthRefreshes);
  registerStealthAllyVisibilityPatch();
  configureStealthVisualization({ refreshWindows: () => queueStealthRefresh({ allWindows: true }) });
  registerStealthMovementProvider({
    rollStealthCheck,
    pauseGame: pauseGameForStealthDetection
  });
  if (game.ready) registerStealthSocket();
  else Hooks.once("ready", registerStealthSocket);

  Hooks.on("updateActor", onActorUpdated);
  Hooks.on("createActiveEffect", effect => onActiveEffectChanged(effect, null, "create"));
  Hooks.on("updateActiveEffect", (effect, changes) => onActiveEffectChanged(effect, changes, "update"));
  Hooks.on("deleteActiveEffect", effect => onActiveEffectChanged(effect, null, "delete"));
  Hooks.on("createToken", onTokenCreated);
  Hooks.on("updateToken", onTokenUpdated);
  Hooks.on("deleteToken", onTokenDeleted);
  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("canvasTearDown", cleanupAllStealthUi);
  Hooks.on("updateScene", onSceneUpdated);
  Hooks.on("createAmbientLight", onSceneGeometryChanged);
  Hooks.on("updateAmbientLight", onSceneGeometryChanged);
  Hooks.on("deleteAmbientLight", onSceneGeometryChanged);
  Hooks.on("createWall", onSceneGeometryChanged);
  Hooks.on("updateWall", onSceneGeometryChanged);
  Hooks.on("deleteWall", onSceneGeometryChanged);
  Hooks.on("createRegion", onSceneGeometryChanged);
  Hooks.on("updateRegion", onSceneGeometryChanged);
  Hooks.on("deleteRegion", onSceneGeometryChanged);
  Hooks.on("createRegionBehavior", onSceneGeometryChanged);
  Hooks.on("updateRegionBehavior", onSceneGeometryChanged);
  Hooks.on("deleteRegionBehavior", onSceneGeometryChanged);
  // V14 also changes lighting at runtime without a Document update: darkness
  // animation and Region viewed/animated state are examples. The signature
  // filters the render-frame hooks before any cache or UI work is performed.
  Hooks.on("lightingRefresh", onRuntimePerceptionRefresh);
  Hooks.on("sightRefresh", onRuntimePerceptionRefresh);
  Hooks.on("hoverToken", onTokenHoverForDetectionZone);
  Hooks.on("moveToken", onTokenMoved);
  Hooks.on(`${SYSTEM_ID}.stealthSettingsChanged`, onStealthSettingsChanged);
  Hooks.on(`${SYSTEM_ID}.factionSettingsChanged`, onFactionSettingsChanged);
  hooksRegistered = true;
}

export function openStealthWindow(token) {
  const resolvedToken = token ?? globalThis.canvas?.tokens?.controlled?.at(0) ?? null;
  if (!resolvedToken?.actor) {
    ui.notifications.warn("Для скрытности выберите токен с актёром.");
    return undefined;
  }
  if (!canControlStealth(resolvedToken.actor)) {
    ui.notifications.warn(`Нет прав на управление скрытностью актёра ${resolvedToken.actor.name}.`);
    return undefined;
  }

  const existing = stealthWindows.get(resolvedToken.id);
  if (existing) {
    existing.token = resolvedToken;
    return requestWindowRender(existing);
  }

  const app = new StealthWindow(resolvedToken);
  stealthWindows.set(resolvedToken.id, app);
  return requestWindowRender(app);
}

export async function toggleActorStealth(actor, active = !isActorStealthed(actor)) {
  if (!actor) return false;
  if (!canControlStealth(actor)) {
    ui.notifications.warn(`Нет прав на управление скрытностью актёра ${actor.name}.`);
    return false;
  }
  if (isActorStealthed(actor) === Boolean(active)) return true;
  await actor.toggleStatusEffect(getStealthStatusId(), { active: Boolean(active) });
  if (active) await resolveStealthEntryDetection(actor);
  synchronizeActorStealthState(actor);
  queueStealthedTokenVisibilityRefresh();
  queueStealthRefresh({ actor });
  return true;
}

export async function revealActorFromStealth(actor) {
  if (!isActorStealthed(actor)) return false;
  return toggleActorStealth(actor, false);
}

export { canVisionSourceDetectStealthedAlly };

class StealthWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(token, options = {}) {
    super({
      id: `fallout-maw-stealth-window-${token?.id ?? foundry.utils.randomID()}`,
      ...options
    });
    this.token = token;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-stealth-window",
    classes: ["fallout-maw", "fallout-maw-stealth-window"],
    position: { width: 360, height: "auto" },
    window: { title: "Скрытность", resizable: true },
    actions: {
      toggleStealth: this.#onToggleStealth,
      startTargeting: this.#onStartTargeting
    }
  };

  static PARTS = {
    window: { template: TEMPLATES.stealthWindow }
  };

  get actor() {
    return this.token?.actor ?? null;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const settings = getRuntimeStealthSettings();
    const lighting = getTokenLightingAnalysis(this.token, settings);
    return {
      ...context,
      actor: this.actor,
      token: this.token,
      stealthed: isActorStealthed(this.actor),
      stealthValue: getActorSkillValue(this.actor, "stealth"),
      radius: calculateStealthRadius(lighting.effectiveDarkness, settings, this.actor),
      lighting
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (context.stealthed) updateDetectionVisualization(this.token);
    else removeDetectionVisualization(this.token?.id);
  }

  async _onClose(options) {
    await super._onClose(options);
    if (targetMode?.sourceTokenId === this.token?.id) stopTargetingMode();
    removeDetectionVisualization(this.token?.id);
    stealthWindows.delete(this.token?.id);
  }

  static async #onToggleStealth(event) {
    event.preventDefault();
    await toggleActorStealth(this.actor);
  }

  static #onStartTargeting(event) {
    event.preventDefault();
    if (isActorStealthed(this.actor)) startTargetingMode(this.token, this);
  }
}

async function rollStealthCheck(sourceToken, targetToken, app = null, { animate = true } = {}) {
  const difficulty = computeStealthDifficulty(sourceToken, targetToken);
  if (!difficulty) return undefined;
  const outcome = await requestSkillCheck({
    actor: sourceToken.actor,
    skillKey: "stealth",
    requester: "stealth",
    animate,
    data: {
      difficulty: difficulty.difficulty,
      situationalModifier: 0,
      advantage: difficulty.advantageCount > 0,
      advantageCount: difficulty.advantageCount,
      actorToken: sourceToken,
      targetToken,
      targetActor: targetToken?.actor ?? null
    },
    messageData: result => isStealthCheckSuccess(result) ? createStealthSuccessMessageData(sourceToken.actor) : {}
  });
  if (isStealthCheckFailure(outcome)) await toggleActorStealth(sourceToken.actor, false);
  else if (isStealthCheckSuccess(outcome)) notifyDangerSenseWarning(targetToken.actor);
  if (app) queueStealthRefresh({ actor: sourceToken.actor });
  return outcome;
}

async function resolveStealthEntryDetection(actor) {
  const settings = getRuntimeStealthSettings();
  if (!settings.autoDetection?.enabled || !globalThis.canvas?.ready || !isActorStealthed(actor)) return false;
  for (const token of getSceneTokensForActor(actor)) {
    if (!isActorStealthed(actor)) return true;
    if (await resolveStealthEntryDetectionForToken(token, settings)) return true;
  }
  return false;
}

async function resolveStealthEntryDetectionForToken(hiddenToken, settings) {
  if (!hiddenToken?.actor || !isActorStealthed(hiddenToken.actor)) return false;
  const hiddenPoint = getTokenCenter(hiddenToken);
  for (const observerToken of globalThis.canvas?.tokens?.placeables ?? []) {
    if (!isActorStealthed(hiddenToken.actor)) return true;
    if (!isValidStealthObserver(hiddenToken, observerToken)) continue;
    const observerOrigin = getTokenCenter(observerToken);
    if (!isPointInsideObserverZone(hiddenPoint, observerToken, observerOrigin, settings)) continue;
    const outcome = await rollStealthCheck(hiddenToken, observerToken, null, { animate: false });
    if (!isActorStealthed(hiddenToken.actor) || isStealthCheckFailure(outcome)) {
      pauseGameForStealthDetection();
      return true;
    }
  }
  return false;
}

function startTargetingMode(sourceToken, app) {
  stopTargetingMode();
  const view = globalThis.canvas?.app?.view;
  if (!sourceToken?.actor || !view) return;
  const tooltip = getTargetTooltip();
  targetMode = {
    sourceTokenId: sourceToken.id,
    app,
    tooltip,
    hoveredToken: null,
    hoverKey: "",
    hoverHtml: "",
    checking: false,
    pointerFrame: null,
    latestPointer: null,
    pointerMove: event => queueTargetPointerMove(event),
    pointerDown: event => onTargetPointerDown(event),
    contextMenu: event => {
      event.preventDefault();
      stopTargetingMode();
    },
    keyDown: event => {
      if (event.key === "Escape") stopTargetingMode();
    }
  };
  view.addEventListener("pointermove", targetMode.pointerMove, { capture: true, passive: true });
  view.addEventListener("pointerdown", targetMode.pointerDown, { capture: true });
  view.addEventListener("contextmenu", targetMode.contextMenu, { capture: true });
  document.addEventListener("keydown", targetMode.keyDown);
  view.classList.add("fallout-maw-stealth-targeting");
  ui.notifications.info("Выберите цель проверки скрытности.");
}

function stopTargetingMode() {
  if (!targetMode) return;
  const view = globalThis.canvas?.app?.view;
  view?.removeEventListener("pointermove", targetMode.pointerMove, { capture: true });
  view?.removeEventListener("pointerdown", targetMode.pointerDown, { capture: true });
  view?.removeEventListener("contextmenu", targetMode.contextMenu, { capture: true });
  view?.classList.remove("fallout-maw-stealth-targeting");
  document.removeEventListener("keydown", targetMode.keyDown);
  if (targetMode.pointerFrame !== null) cancelFrame(targetMode.pointerFrame);
  targetMode.tooltip?.remove();
  targetMode = null;
}

function queueTargetPointerMove(event) {
  if (!targetMode) return;
  targetMode.latestPointer = { clientX: event.clientX, clientY: event.clientY };
  scheduleTargetPointerUpdate();
}

function scheduleTargetPointerUpdate() {
  if (!targetMode?.latestPointer) return;
  if (targetMode.pointerFrame !== null) return;
  targetMode.pointerFrame = requestFrame(() => {
    if (!targetMode) return;
    targetMode.pointerFrame = null;
    updateTargetPointer(targetMode.latestPointer);
  });
}

function updateTargetPointer(pointer) {
  if (!targetMode || !pointer) return;
  const sourceToken = globalThis.canvas?.tokens?.get(targetMode.sourceTokenId);
  const hovered = getTokenAtClientPoint(pointer, sourceToken?.id);
  targetMode.hoveredToken = hovered;
  if (!hovered || !sourceToken) {
    targetMode.tooltip.hidden = true;
    return;
  }

  const hoverKey = getTargetDifficultyKey(sourceToken, hovered);
  if (targetMode.hoverKey !== hoverKey) {
    const difficulty = computeStealthDifficulty(sourceToken, hovered);
    if (!difficulty) {
      targetMode.tooltip.hidden = true;
      return;
    }
    targetMode.hoverKey = hoverKey;
    targetMode.hoverHtml = `
      <strong>${escapeHtml(hovered.name)}</strong>
      <span>СЛ ${difficulty.difficulty}</span>
      <small>${escapeHtml(difficulty.lighting.modifiers.condition)} · ${Math.round(difficulty.distance)}</small>
    `;
  }
  targetMode.tooltip.hidden = false;
  if (targetMode.tooltip.innerHTML !== targetMode.hoverHtml) targetMode.tooltip.innerHTML = targetMode.hoverHtml;
  positionTooltip(targetMode.tooltip, pointer);
}

async function onTargetPointerDown(event) {
  if (!targetMode || event.button !== 0) return;
  const mode = targetMode;
  // Targeting owns every primary click, including empty canvas and clicks
  // received while the preceding roll is still pending.
  event.preventDefault();
  event.stopImmediatePropagation?.();
  event.stopPropagation();
  if (mode.checking) return;
  const sourceToken = globalThis.canvas?.tokens?.get(mode.sourceTokenId);
  const targetToken = getTokenAtClientPoint(event, sourceToken?.id);
  if (!sourceToken?.actor || !targetToken?.actor) return;
  mode.checking = true;
  try {
    await rollStealthCheck(sourceToken, targetToken, mode.app);
  } finally {
    if (targetMode === mode) {
      mode.checking = false;
      if (!event.shiftKey) stopTargetingMode();
    }
  }
}

function onActorUpdated(actor, changes = {}) {
  const settings = getRuntimeStealthSettings();
  const factionRoots = [`flags.${SYSTEM_ID}.factionBelongs`, `flags.${SYSTEM_ID}.factionRelations`];
  const skillRoots = [
    "system.skills.stealth",
    `system.skills.${settings.detection?.skillKey ?? "naturalist"}`,
    `system.skills.${settings.difficulty?.skillKey ?? "naturalist"}`
  ];
  const factionChanged = hasChangedPath(changes, factionRoots);
  const skillChanged = hasChangedPath(changes, skillRoots);
  const statusChanged = hasChangedPath(changes, ["statuses", "system.statuses", "system.conditions"]);
  if (!factionChanged && !skillChanged && !statusChanged) return;

  if (factionChanged) {
    invalidateStealthRelationCache(actor);
    queueStealthedTokenVisibilityRefresh();
  }
  if (skillChanged) invalidateStealthDetectionCache();
  if (skillChanged || statusChanged || factionChanged) {
    queueStealthRefresh({ actor, visualization: true });
  }
  if (statusChanged) synchronizeActorStealthState(actor);
}

function onActiveEffectChanged(effect, changes = null, operation = "update") {
  const actor = effect?.parent;
  if (!actor || !effectAffectsStealth(effect, changes, operation)) return;
  synchronizeActorStealthState(actor);
  invalidateStealthDetectionCache();
  queueStealthedTokenVisibilityRefresh();
  queueStealthRefresh({ actor, visualization: true });
}

function onTokenCreated(tokenDocument) {
  if (!isDocumentInActiveScene(tokenDocument)) return;
  if (tokenDocument?.actor && isActorStealthed(tokenDocument.actor)) queueStealthedTokenVisibilityRefresh();
  const emitsLight = tokenEmitsLight(tokenDocument);
  if (emitsLight) {
    invalidateLightingAnalysisCache();
    invalidateStealthDetectionCache();
    invalidateTargetDifficultyPreview();
    captureRuntimePerceptionSignature();
  }
  queueStealthRefresh({ allWindows: emitsLight, visualization: true });
}

function onTokenUpdated(tokenDocument, changes = {}) {
  if (!isDocumentInActiveScene(tokenDocument)) return;
  const geometryChanged = hasChangedPath(changes, [
    "sight",
    "detectionModes",
    "light",
    "rotation",
    "width",
    "height",
    "depth",
    "shape",
    "level",
    "actorId",
    "actorLink"
  ]);
  if (!geometryChanged) return;
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  captureRuntimePerceptionSignature();
  queueStealthRefresh({ allWindows: true, visualization: true });
}

function onTokenMoved(tokenDocument, movement = {}) {
  if (!isDocumentInActiveScene(tokenDocument)) return;
  const token = tokenDocument?.object;
  const emitsLight = tokenEmitsLight(tokenDocument);
  // Cache keys already include exact token positions. Ordinary movement can
  // therefore reuse every unaffected observer zone; a moving light source is
  // the one case which changes lighting for arbitrary points in the scene.
  if (emitsLight) {
    invalidateLightingAnalysisCache();
    invalidateStealthDetectionCache();
    invalidateTargetDifficultyPreview();
  }
  trackDetectionVisualizationMovement(token, movement?.animation?.ended);
  runAfterTokenAnimation(token, () => {
    // Position is part of the point/zone keys, but animated rotation and
    // collision geometry can repopulate the same key at an intermediate frame.
    invalidateStealthDetectionCache();
    if (!emitsLight) return;
    // moveToken is emitted before V14's animation promise settles. A final
    // invalidation prevents an intermediate light-source position from being
    // retained if a consumer repopulated the cache during the animation.
    invalidateLightingAnalysisCache();
    invalidateTargetDifficultyPreview();
    captureRuntimePerceptionSignature();
    queueStealthRefresh({ allWindows: true, visualization: true });
  }, movement?.animation?.ended);
}

function onTokenDeleted(tokenDocument) {
  const tokenId = tokenDocument?.id;
  const emittedLight = tokenEmitsLight(tokenDocument);
  cleanupTokenStealth(tokenId);
  if (isDocumentInActiveScene(tokenDocument)) {
    invalidateLightingAnalysisCache();
    invalidateStealthDetectionCache();
    captureRuntimePerceptionSignature();
    queueStealthRefresh({ allWindows: emittedLight, visualization: true });
  }
}

function onCanvasReady() {
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  invalidateStealthRelationCache();
  captureRuntimePerceptionSignature();
  queueStealthRefresh({ allWindows: true, visibility: true, visualization: true });
}

/**
 * Handle V14 perception refreshes which do not necessarily originate from a
 * Document update. The hook itself may run every render frame, so only a
 * changed logical signature is allowed to invalidate caches.
 */
function onRuntimePerceptionRefresh() {
  const nextSignature = getRuntimePerceptionSignature();
  if (nextSignature === null || nextSignature === runtimePerceptionSignature) return;
  runtimePerceptionSignature = nextSignature;
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  queueRuntimePerceptionUiRefresh();
}

function queueRuntimePerceptionUiRefresh() {
  const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
  const clear = globalThis.window?.clearTimeout ?? globalThis.clearTimeout;
  if (runtimePerceptionUiTimeout) clear(runtimePerceptionUiTimeout);
  runtimePerceptionUiTimeout = schedule(() => {
    runtimePerceptionUiTimeout = null;
    queueStealthRefresh({ allWindows: true, visualization: true });
  }, RUNTIME_PERCEPTION_UI_SETTLE_MS);
}

function captureRuntimePerceptionSignature() {
  runtimePerceptionSignature = getRuntimePerceptionSignature();
}

function getRuntimePerceptionSignature() {
  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.ready) return null;
  const scene = activeCanvas.scene;
  const environment = activeCanvas.environment;
  const effects = activeCanvas.effects;
  return JSON.stringify([
    scene?.id ?? "",
    activeCanvas.level?.id ?? "",
    normalizeRuntimeSignatureNumber(environment?.darknessLevel),
    getEffectSourceRuntimeSignature(environment?.globalLightSource),
    getEffectCollectionRuntimeSignature(effects?.lightSources),
    getEffectCollectionRuntimeSignature(effects?.darknessSources),
    getDarknessMeshRuntimeSignature(effects?.illumination?.darknessLevelMeshes?.children),
    getRegionSurfaceRuntimeSignature(scene, "light"),
    getRegionSurfaceRuntimeSignature(scene, "sight")
  ]);
}

function getEffectCollectionRuntimeSignature(collection) {
  if (!collection) return [];
  const values = typeof collection.values === "function" ? collection.values() : collection;
  try {
    return Array.from(values, getEffectSourceRuntimeSignature);
  } catch (_error) {
    return [];
  }
}

function getEffectSourceRuntimeSignature(source) {
  if (!source) return null;
  const data = source.data ?? {};
  const origin = source.origin ?? source;
  return [
    source.sourceId ?? source.name ?? getRuntimeSignatureObjectId(source),
    getRuntimeSignatureObjectId(source),
    normalizeRuntimeSignatureNumber(source.updateId),
    Boolean(source.active),
    Boolean(source.suppressed),
    getRuntimeSignatureObjectId(source.shape),
    normalizeRuntimeSignatureNumber(origin.x),
    normalizeRuntimeSignatureNumber(origin.y),
    normalizeRuntimeSignatureNumber(origin.elevation),
    normalizeRuntimeSignatureNumber(data.bright),
    normalizeRuntimeSignatureNumber(data.dim),
    normalizeRuntimeSignatureNumber(data.radius),
    normalizeRuntimeSignatureNumber(data.priority ?? source.priority),
    normalizeRuntimeSignatureNumber(data.darkness?.min),
    normalizeRuntimeSignatureNumber(data.darkness?.max),
    data.level ?? "",
    Boolean(data.disabled)
  ];
}

function getDarknessMeshRuntimeSignature(children) {
  if (!Array.isArray(children)) return [];
  return children.map(mesh => {
    const shader = mesh?.shader ?? {};
    const region = mesh?.region;
    const elevation = region?.animationState?.elevation ?? region?.document?.elevation ?? {};
    return [
      mesh?.name ?? "",
      getRuntimeSignatureObjectId(mesh),
      getRuntimeSignatureObjectId(mesh?.geometry),
      getRuntimeSignatureObjectId(region?.animationState?.shapes),
      normalizeRuntimeSignatureNumber(elevation.bottom),
      normalizeRuntimeSignatureNumber(elevation.top),
      normalizeRuntimeSignatureNumber(shader.mode),
      normalizeRuntimeSignatureNumber(shader.modifier),
      normalizeRuntimeSignatureNumber(shader.darknessLevel),
      normalizeRuntimeSignatureNumber(shader.uniforms?.darknessLevel)
    ];
  });
}

function getRegionSurfaceRuntimeSignature(scene, type) {
  if (typeof scene?.getSurfaces !== "function") return "";
  try {
    return getRuntimeSignatureObjectId(scene.getSurfaces({ type }));
  } catch (_error) {
    return "";
  }
}

function getRuntimeSignatureObjectId(value) {
  const type = typeof value;
  if ((type !== "object" || value === null) && type !== "function") return "";
  let id = runtimeSignatureObjectIds.get(value);
  if (!id) {
    id = nextRuntimeSignatureObjectId;
    nextRuntimeSignatureObjectId += 1;
    runtimeSignatureObjectIds.set(value, id);
  }
  return id;
}

function normalizeRuntimeSignatureNumber(value) {
  const number = Number(value);
  if (Number.isNaN(number)) return "NaN";
  if (number === Infinity) return "+Infinity";
  if (number === -Infinity) return "-Infinity";
  return number;
}

function onSceneUpdated(scene, changes = {}) {
  if (scene?.id !== globalThis.canvas?.scene?.id) return;
  if (!hasChangedPath(changes, ["darkness", "environment", "globalLight", "tokenVision", "grid", "dimensions"])) return;
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  captureRuntimePerceptionSignature();
  queueStealthRefresh({ allWindows: true, visibility: true, visualization: true });
}

function onSceneGeometryChanged(document) {
  if (!isDocumentInActiveScene(document)) return;
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  captureRuntimePerceptionSignature();
  queueStealthRefresh({ allWindows: true, visualization: true });
}

function onStealthSettingsChanged() {
  invalidateStealthRuleCache();
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  queueStealthRefresh({ allWindows: true, visualization: true });
}

function onFactionSettingsChanged() {
  invalidateStealthRelationCache();
  queueStealthedTokenVisibilityRefresh();
  queueStealthRefresh({ visualization: true });
}

function synchronizeActorStealthState(actor) {
  if (!actor || isActorStealthed(actor)) return;
  if (targetMode) {
    const source = globalThis.canvas?.tokens?.get(targetMode.sourceTokenId);
    if (source?.actor?.uuid === actor.uuid) stopTargetingMode();
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token.actor?.uuid === actor.uuid) removeDetectionVisualization(token.id);
  }
}

function queueStealthRefresh({
  actor = null,
  allWindows = false,
  visibility = false,
  visualization = false
} = {}) {
  invalidateTargetDifficultyPreview();
  if (actor?.uuid) pendingActorRefreshes.set(actor.uuid, actor);
  refreshAllWindowsPending ||= Boolean(allWindows);
  visibilityRefreshPending ||= Boolean(visibility);
  visualizationRefreshPending ||= Boolean(visualization);
  if (refreshTimeout) return;
  const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
  refreshTimeout = schedule(flushQueuedStealthRefresh, UI_REFRESH_BATCH_MS);
}

function flushQueuedStealthRefresh() {
  refreshTimeout = null;
  const refreshAll = refreshAllWindowsPending;
  const actors = [...pendingActorRefreshes.values()];
  const refreshVisibility = visibilityRefreshPending;
  const refreshVisualization = visualizationRefreshPending;
  refreshAllWindowsPending = false;
  visibilityRefreshPending = false;
  visualizationRefreshPending = false;
  pendingActorRefreshes.clear();

  if (refreshAll) refreshAllStealthWindows();
  else for (const actor of actors) refreshStealthWindowsForActor(actor);
  if (refreshVisibility) refreshStealthedTokenVisibility();
  if (refreshVisualization) queueDetectionVisualizationRefresh();
}

function queueStealthedTokenVisibilityRefresh() {
  if (!globalThis.canvas?.ready) return;
  if (deferStealthedTokenVisibilityRefresh()) return;
  queueStealthRefresh({ visibility: true });
}

function refreshStealthWindowsForActor(actor) {
  if (!actor || deferStealthActorRefresh(actor)) return;
  for (const [tokenId, app] of stealthWindows) {
    const token = globalThis.canvas?.tokens?.get(tokenId);
    if (!token || token.actor?.uuid !== actor.uuid) continue;
    app.token = token;
    requestWindowRender(app);
  }
}

function refreshAllStealthWindows() {
  for (const [tokenId, app] of stealthWindows) {
    const token = globalThis.canvas?.tokens?.get(tokenId);
    if (!token) continue;
    app.token = token;
    requestWindowRender(app);
  }
}

function requestWindowRender(app) {
  if (!app) return undefined;
  let state = windowRenderStates.get(app);
  if (!state) {
    state = { running: null, dirty: false };
    windowRenderStates.set(app, state);
  }
  if (state.running) {
    state.dirty = true;
    return state.running;
  }
  const run = () => Promise.resolve(app.render({ force: true }));
  state.running = run().finally(() => {
    state.running = null;
    if (!state.dirty || ![...stealthWindows.values()].includes(app)) return;
    state.dirty = false;
    requestWindowRender(app);
  });
  return state.running;
}

function flushDeferredStealthRefreshes(context) {
  for (const actor of context?.stealthActors?.values?.() ?? []) {
    const freshActor = fromUuidSync(actor?.uuid ?? "") ?? actor;
    queueStealthRefresh({ actor: freshActor });
  }
  if (context?.stealthVisibility) queueStealthRefresh({ visibility: true });
}

function cleanupTokenStealth(tokenId) {
  const app = stealthWindows.get(tokenId);
  if (app) void app.close();
  cleanupTokenStealthVisualization(tokenId);
  tokenAnimationTasks.delete(tokenId);
  if (targetMode?.sourceTokenId === tokenId) stopTargetingMode();
}

function cleanupAllStealthUi() {
  clearRuntimeTimers();
  stopTargetingMode();
  for (const app of [...stealthWindows.values()]) void app.close();
  stealthWindows.clear();
  cleanupAllStealthVisualizations();
  tokenAnimationTasks.clear();
  pendingActorRefreshes.clear();
  refreshAllWindowsPending = false;
  visibilityRefreshPending = false;
  visualizationRefreshPending = false;
  runtimePerceptionSignature = null;
  invalidateStealthDetectionCache();
  invalidateLightingAnalysisCache();
}

function clearRuntimeTimers() {
  const clear = globalThis.window?.clearTimeout ?? globalThis.clearTimeout;
  if (refreshTimeout) clear(refreshTimeout);
  if (runtimePerceptionUiTimeout) clear(runtimePerceptionUiTimeout);
  refreshTimeout = null;
  runtimePerceptionUiTimeout = null;
}

function registerStealthSocket() {
  if (stealthSocketRegistered) return;
  game.socket?.on?.(STEALTH_SOCKET, handleStealthSocketMessage);
  stealthSocketRegistered = true;
}

function handleStealthSocketMessage(message = {}, senderUserId = "") {
  if (message?.scope !== STEALTH_SOCKET_SCOPE || message.action !== "pauseDetection") return;
  if (message.senderUserId && senderUserId && message.senderUserId !== senderUserId) return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
  pauseGameForStealthDetection({ localOnly: true });
}

function pauseGameForStealthDetection({ localOnly = false } = {}) {
  if (game.paused) return;
  if (!game.user?.isGM) {
    if (!localOnly) requestStealthDetectionPause();
    return;
  }
  game.togglePause(true, { broadcast: true });
}

function requestStealthDetectionPause() {
  const gm = getResponsibleGM();
  if (!gm) return;
  game.socket?.emit?.(STEALTH_SOCKET, {
    scope: STEALTH_SOCKET_SCOPE,
    action: "pauseDetection",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? ""
  }, { recipients: [gm.id] });
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function effectAffectsStealth(effect, changes, operation) {
  const statuses = new Set(effect?.statuses ?? []);
  if (statuses.size) return true;
  const relevantSkill = (effect?.changes ?? []).some(change => String(change?.key ?? "").startsWith("system.skills."));
  if (relevantSkill) return true;
  if (operation !== "update") return false;
  return hasChangedPath(changes, ["statuses", "changes", "disabled", "transfer"]);
}

function hasChangedPath(changes, roots = []) {
  if (!changes || typeof changes !== "object") return false;
  const flattened = foundry.utils.flattenObject?.(changes) ?? changes;
  const paths = Object.keys(flattened);
  return paths.some(path => roots.some(root => (
    path === root
    || path.startsWith(`${root}.`)
    || root.startsWith(`${path}.`)
  )));
}

function isDocumentInActiveScene(document) {
  let ancestor = document;
  for (let depth = 0; ancestor && depth < 4; depth += 1) {
    if (ancestor.documentName === "Scene") {
      return Boolean(ancestor.id && ancestor.id === globalThis.canvas?.scene?.id);
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function tokenEmitsLight(tokenDocument) {
  const light = tokenDocument?.light ?? tokenDocument?.object?.document?.light;
  return Boolean(light && (Number(light.bright) > 0 || Number(light.dim) > 0 || light.negative));
}

function runAfterTokenAnimation(token, callback, animationOverride = null) {
  if (!token?.id) return callback();
  const animation = animationOverride ?? token.document?.movement?.animation?.ended ?? token.movementAnimationPromise;
  if (!animation || typeof animation.then !== "function") return callback();
  const task = { animation };
  tokenAnimationTasks.set(token.id, task);
  const settle = () => {
    if (tokenAnimationTasks.get(token.id) !== task) return;
    tokenAnimationTasks.delete(token.id);
    callback();
  };
  void Promise.resolve(animation).then(settle, settle);
}

function getSceneTokensForActor(actor) {
  if (!actor?.uuid) return [];
  return (globalThis.canvas?.tokens?.placeables ?? []).filter(token => token.actor?.uuid === actor.uuid);
}

function isStealthCheckSuccess(outcome) {
  const resultKey = String(outcome?.result?.key ?? "");
  return ["success", "criticalSuccess"].includes(resultKey) || outcome?.result?.autoSuccess;
}

function isStealthCheckFailure(outcome) {
  const resultKey = String(outcome?.result?.key ?? "");
  return ["failure", "criticalFailure"].includes(resultKey) || outcome?.result?.autoFailure;
}

function createStealthSuccessMessageData(actor = null) {
  const whisper = new Set(ChatMessage.getWhisperRecipients("GM").map(user => user.id));
  for (const user of game.users?.contents ?? []) {
    if (actor?.testUserPermission?.(user, "OWNER")) whisper.add(user.id);
  }
  if (!whisper.size && game.user?.id) whisper.add(game.user.id);
  return { whisper: Array.from(whisper), includeRolls: false };
}

function getTokenAtClientPoint(event, excludedTokenId = "") {
  const activeCanvas = globalThis.canvas;
  const point = activeCanvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  const collisionTest = ({ t: token }) => token.id !== excludedTokenId
    && token.actor
    && token.visible !== false
    && token.renderable !== false
    && (token.hitArea?.contains
      ? token.hitArea.contains(point.x - token.x, point.y - token.y)
      : token.bounds?.contains?.(point.x, point.y));
  const rectangle = new PIXI.Rectangle(point.x, point.y, 1, 1);
  const nearby = activeCanvas.tokens?.quadtree?.getObjects?.(rectangle, { collisionTest });
  const candidates = nearby ? [...nearby] : (activeCanvas.tokens?.placeables ?? []).filter(token => collisionTest({ t: token }));
  return candidates
    .sort((left, right) => (right._lastSortedIndex ?? 0) - (left._lastSortedIndex ?? 0))
    .at(0) ?? null;
}

function invalidateTargetDifficultyPreview() {
  if (!targetMode) return;
  targetMode.hoverKey = "";
  scheduleTargetPointerUpdate();
}

function getTargetDifficultyKey(sourceToken, targetToken) {
  const source = getTokenCenter(sourceToken);
  const target = getTokenCenter(targetToken);
  return [
    sourceToken?.id ?? "",
    Math.round(source.x),
    Math.round(source.y),
    Math.round(source.elevation),
    targetToken?.id ?? "",
    Math.round(target.x),
    Math.round(target.y),
    Math.round(target.elevation)
  ].join(":");
}

function getTargetTooltip() {
  document.getElementById(STEALTH_TARGET_TOOLTIP_ID)?.remove();
  const tooltip = document.createElement("div");
  tooltip.id = STEALTH_TARGET_TOOLTIP_ID;
  tooltip.className = "fallout-maw-stealth-target-tooltip";
  tooltip.hidden = true;
  document.body.append(tooltip);
  return tooltip;
}

function positionTooltip(tooltip, event) {
  const margin = 12;
  tooltip.style.left = `${Math.min(window.innerWidth - tooltip.offsetWidth - margin, event.clientX + margin)}px`;
  tooltip.style.top = `${Math.min(window.innerHeight - tooltip.offsetHeight - margin, event.clientY + margin)}px`;
}

function requestFrame(callback) {
  const browserWindow = globalThis.window;
  if (typeof browserWindow?.requestAnimationFrame === "function") {
    return browserWindow.requestAnimationFrame(callback);
  }
  if (typeof globalThis.requestAnimationFrame === "function") return globalThis.requestAnimationFrame(callback);
  return globalThis.setTimeout(callback, 0);
}

function cancelFrame(frameId) {
  const browserWindow = globalThis.window;
  if (typeof browserWindow?.cancelAnimationFrame === "function") {
    return browserWindow.cancelAnimationFrame(frameId);
  }
  if (typeof globalThis.cancelAnimationFrame === "function") return globalThis.cancelAnimationFrame(frameId);
  return globalThis.clearTimeout(frameId);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}
