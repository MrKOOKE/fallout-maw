import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { notifyDangerSenseWarning } from "../abilities/danger-sense.mjs";
import {
  deferStealthActorRefresh,
  deferStealthedTokenVisibilityRefresh,
  registerBulkOperationFlusher
} from "../utils/bulk-operation.mjs";
import {
  isPointInsideObserverZone,
  invalidateStealthDetectionCache,
  invalidateStealthDetectionObserver
} from "./detection.mjs";
import { invalidateLightingAnalysisCache } from "./lighting.mjs";
import { registerStealthMovementProvider } from "./movement.mjs";
import {
  invalidateStealthRelationCache,
  isStealthObserverIncapacitated,
  isValidStealthObserver
} from "./observers.mjs";
import {
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
  clearWeaponNoiseDetectionQueues,
  configureWeaponNoiseDetection
} from "./weapon-noise.mjs";
import { startCanvasTargetSelectionSession } from "../canvas/target-selection-lifecycle.mjs";
import { SMOKE_PERCEPTION_PERCENT_EFFECT_KEY } from "../canvas/smoke-perception.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { peekSmokeRegionRevision } from "../canvas/smoke-vision.mjs";
import { getDetectionModeIdFromRangeEffectKey } from "../canvas/vision-effect-keys.mjs";
import { isPhantomEntity } from "../abilities/phantom-entity.mjs";
import {
  canRenderDetectionVisualizationForLocalUser,
  cleanupAllStealthVisualizations,
  cleanupTokenStealthVisualization,
  configureStealthVisualization,
  hasDetectionVisualizationSources,
  onTokenHoverForDetectionZone,
  queueDetectionVisualizationRefresh,
  refreshDetectionVisualizationMaskState,
  removeDetectionVisualization,
  setPersistentDetectionVisualization,
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
const runtimeRegionSurfaceSignatures = new WeakMap();
const persistentVisualizationRenderStates = new Map();
const stealthedCanvasTokenIds = new Set();

let targetMode = null;
let hooksRegistered = false;
let stealthSocketRegistered = false;
let refreshTimeout = null;
let runtimePerceptionUiTimeout = null;
let runtimePerceptionUiDeadline = 0;
let runtimeLightingSignature = null;
let runtimeSightSignature = null;
let smokeNativePerceptionGuard = null;
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
    rollStealthChecks,
    pauseGame: pauseGameForStealthDetection,
    hasStealthedCanvasTokens: () => stealthedCanvasTokenIds.size > 0
  });
  configureWeaponNoiseDetection({
    rollStealthCheck,
    rollStealthChecks,
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
  Hooks.on("drawToken", onTokenDrawn);
  Hooks.on("refreshToken", onTokenRefreshed);
  Hooks.on("controlToken", onControlledTokenChanged);
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
  Hooks.on("sightRefresh", onRuntimeSightRefresh);
  Hooks.on("hoverToken", onTokenHoverForDetectionZone);
  Hooks.on("moveToken", onTokenMoved);
  Hooks.on(`${SYSTEM_ID}.stealthSettingsChanged`, onStealthSettingsChanged);
  Hooks.on(`${SYSTEM_ID}.factionSettingsChanged`, onFactionSettingsChanged);
  Hooks.on(`${SYSTEM_ID}.smokePerceptionChanged`, onSmokePerceptionChanged);
  Hooks.on(`${SYSTEM_ID}.smokeRegionAnimation`, onSmokeRegionAnimation);
  Hooks.on(`${SYSTEM_ID}.smokeNativePerceptionRefresh`, onSmokeNativePerceptionRefresh);
  hooksRegistered = true;
}

export function openStealthWindow(token) {
  const resolvedToken = token ?? globalThis.canvas?.tokens?.controlled?.at(0) ?? null;
  if (!resolvedToken?.actor || isPhantomEntity(resolvedToken)) {
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

export async function toggleActorStealth(actor, active = !isActorStealthed(actor), {
  skipEntryDetection = false
} = {}) {
  if (!actor || isPhantomEntity(actor)) return false;
  if (!canControlStealth(actor)) {
    ui.notifications.warn(`Нет прав на управление скрытностью актёра ${actor.name}.`);
    return false;
  }
  if (isActorStealthed(actor) === Boolean(active)) return true;
  await actor.toggleStatusEffect(getStealthStatusId(), { active: Boolean(active) });
  if (active && !skipEntryDetection) await resolveStealthEntryDetection(actor);
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

async function rollStealthCheck(sourceToken, targetToken, app = null, {
  animate = true,
  skillBonus = 0
} = {}) {
  return (await rollStealthChecks([{ sourceToken, targetToken, app, skillBonus }], { animate }))[0];
}

async function rollStealthChecks(checks = [], { animate = false } = {}) {
  const prepared = [];
  for (const check of checks) {
    const sourceToken = check?.sourceToken ?? null;
    const targetToken = check?.targetToken ?? null;
    if (!sourceToken?.actor || isStealthObserverIncapacitated(targetToken)) continue;
    const difficulty = computeStealthDifficulty(sourceToken, targetToken);
    if (!difficulty) continue;
    prepared.push({
      ...check,
      sourceToken,
      targetToken,
      difficulty,
      skillBonus: Math.trunc(Number(check?.skillBonus) || 0)
    });
  }
  if (!prepared.length) return [];

  const resolved = [];
  for (const check of prepared) {
    const outcome = await requestSkillCheck({
      actor: check.sourceToken.actor,
      skillKey: "stealth",
      requester: "stealth",
      animate,
      data: {
        difficulty: check.difficulty.difficulty,
        situationalModifier: check.skillBonus,
        advantage: check.difficulty.advantageCount > 0,
        advantageCount: check.difficulty.advantageCount,
        actorToken: check.sourceToken,
        targetToken: check.targetToken,
        targetActor: check.targetToken?.actor ?? null
      },
      messageData: result => isStealthCheckSuccess(result)
        ? createStealthSuccessMessageData(check.sourceToken.actor)
        : {}
    });
    resolved.push({ ...check, outcome });
  }

  const failures = resolved.filter(check => isStealthCheckFailure(check.outcome));
  const revealPrevented = failures.length
    ? await resolveStealthDetectionFailures(failures)
    : false;
  const outcomes = resolved.map(check => {
    const preventedFailure = revealPrevented && isStealthCheckFailure(check.outcome);
    if (isStealthCheckSuccess(check.outcome) || preventedFailure) {
      notifyDangerSenseWarning(check.targetToken.actor);
    }
    if (check.app) queueStealthRefresh({ actor: check.sourceToken.actor });
    return preventedFailure
      ? { ...check.outcome, falloutMawRevealPrevented: true }
      : check.outcome;
  });
  return outcomes;
}

async function resolveStealthDetectionFailures(failures = []) {
  const first = failures[0];
  const hiddenToken = first?.sourceToken ?? null;
  const actor = hiddenToken?.actor ?? null;
  if (!actor || !isActorStealthed(actor)) return false;
  const participant = token => ({
    actorUuid: String(token?.actor?.uuid ?? ""),
    tokenUuid: String(token?.document?.uuid ?? token?.uuid ?? "")
  });
  const participants = {
    source: participant(hiddenToken),
    target: participant(first.targetToken),
    related: failures.slice(1).map(check => participant(check.targetToken))
  };
  const skillChecks = failures.map(check => ({
    skillKey: "stealth",
    difficulty: Math.max(0, Math.trunc(Number(check.difficulty?.difficulty) || 0)),
    situationalModifier: Math.trunc(Number(check.skillBonus) || 0),
    advantageCount: Math.max(0, Math.trunc(Number(check.difficulty?.advantageCount) || 0)),
    disadvantageCount: 0,
    targetActorUuid: String(check.targetToken?.actor?.uuid ?? ""),
    targetTokenUuid: String(check.targetToken?.document?.uuid ?? check.targetToken?.uuid ?? "")
  }));
  const eventData = {
    skillKey: "stealth",
    difficulty: skillChecks[0]?.difficulty ?? 0,
    situationalModifier: skillChecks[0]?.situationalModifier ?? 0,
    advantageCount: skillChecks[0]?.advantageCount ?? 0,
    disadvantageCount: 0,
    skillChecks,
    request: {
      skillKey: "stealth",
      difficulty: skillChecks[0]?.difficulty ?? 0,
      situationalModifier: skillChecks[0]?.situationalModifier ?? 0,
      advantageCount: skillChecks[0]?.advantageCount ?? 0,
      disadvantageCount: 0
    }
  };
  try {
    return await withSystemEventRoot({
      kind: "stealthReveal",
      operationId: `stealth-reveal:${foundry.utils.randomID()}`,
      sceneUuid: String(hiddenToken?.document?.parent?.uuid ?? canvas?.scene?.uuid ?? ""),
      combatUuid: String(game.combat?.uuid ?? "")
    }, async scope => {
      const gate = await scope.emit("fallout-maw.stealth.reveal.before", {
        data: eventData,
        before: { stealthed: true },
        reason: "detectionCheckFailed"
      }, {
        occurrenceKey: `stealth:${actor.uuid}:reveal:before`,
        participants
      });
      if (gate?.control?.current || gate?.control?.root) return true;

      await toggleActorStealth(actor, false);
      if (!isActorStealthed(actor)) {
        await scope.emit("fallout-maw.stealth.reveal.revealed", {
          data: eventData,
          before: { stealthed: true },
          after: { stealthed: false },
          reason: "detectionCheckFailed"
        }, {
          occurrenceKey: `stealth:${actor.uuid}:reveal:revealed`,
          participants
        });
      }
      return false;
    });
  } catch (error) {
    console.error("Fallout MaW | Stealth reveal event failed; revealing actor fail-open.", error);
    await toggleActorStealth(actor, false);
    return false;
  }
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
  const checks = [];
  for (const observerToken of globalThis.canvas?.tokens?.placeables ?? []) {
    if (!isValidStealthObserver(hiddenToken, observerToken)) continue;
    const observerOrigin = getTokenCenter(observerToken);
    if (!isPointInsideObserverZone(hiddenPoint, observerToken, observerOrigin, settings)) continue;
    checks.push({ sourceToken: hiddenToken, targetToken: observerToken });
  }
  const outcomes = await rollStealthChecks(checks, { animate: false });
  if (!isActorStealthed(hiddenToken.actor) || outcomes.some(isStealthCheckFailure)) {
    pauseGameForStealthDetection();
    return true;
  }
  return false;
}

function startTargetingMode(sourceToken, app) {
  stopTargetingMode();
  const view = globalThis.canvas?.app?.view;
  if (!sourceToken?.actor || !view) return;
  const tooltip = getTargetTooltip();
  const mode = {
    sourceTokenId: sourceToken.id,
    app,
    tooltip,
    hoveredToken: null,
    hoverKey: "",
    hoverHtml: "",
    checking: false,
    pointerFrame: null,
    latestPointer: null,
    targetSelectionSession: null,
    pointerMove: event => queueTargetPointerMove(event),
    pointerDown: event => onTargetPointerDown(event),
    contextMenu: event => {
      event.preventDefault();
      stopTargetingMode({ mode });
    },
    keyDown: event => {
      if (event.key === "Escape") stopTargetingMode({ mode });
    }
  };
  targetMode = mode;
  mode.targetSelectionSession = startCanvasTargetSelectionSession({
    kind: "stealthTarget",
    sourceTokenUuid: String(sourceToken?.document?.uuid ?? sourceToken?.uuid ?? "")
  }, {
    onCancel: () => stopTargetingMode({
      mode,
      fromLifecycle: true
    })
  });
  if (mode.targetSelectionSession.finished || targetMode !== mode) {
    mode.targetSelectionSession = null;
    return;
  }
  view.addEventListener("pointermove", mode.pointerMove, { capture: true, passive: true });
  view.addEventListener("pointerdown", mode.pointerDown, { capture: true });
  view.addEventListener("contextmenu", mode.contextMenu, { capture: true });
  document.addEventListener("keydown", mode.keyDown);
  view.classList.add("fallout-maw-stealth-targeting");
  ui.notifications.info("Выберите цель проверки скрытности.");
}

function stopTargetingMode({
  mode = targetMode,
  fromLifecycle = false,
  cancelled = true
} = {}) {
  if (!mode) return;
  const ownsActiveMode = targetMode === mode;
  if (ownsActiveMode) targetMode = null;
  const view = globalThis.canvas?.app?.view;
  view?.removeEventListener("pointermove", mode.pointerMove, { capture: true });
  view?.removeEventListener("pointerdown", mode.pointerDown, { capture: true });
  view?.removeEventListener("contextmenu", mode.contextMenu, { capture: true });
  if (ownsActiveMode) view?.classList.remove("fallout-maw-stealth-targeting");
  document.removeEventListener("keydown", mode.keyDown);
  if (mode.pointerFrame !== null) cancelFrame(mode.pointerFrame);
  mode.pointerFrame = null;
  mode.tooltip?.remove();
  if (!fromLifecycle) {
    mode.targetSelectionSession?.finish({
      cancelled: Boolean(cancelled)
    });
  }
  mode.targetSelectionSession = null;
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
  if (!hovered || !sourceToken || isStealthObserverIncapacitated(hovered)) {
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
      if (!event.shiftKey) stopTargetingMode({ mode, cancelled: false });
    }
  }
}

function onActorUpdated(actor, changes = {}) {
  resetSmokeNativePerceptionGuard();
  if (isPhantomEntity(actor)) return;
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
  const permissionChanged = hasChangedPath(changes, ["ownership"]);
  if (!factionChanged && !skillChanged && !statusChanged && !permissionChanged) return;

  if (factionChanged) {
    invalidateStealthRelationCache(actor);
    queueStealthedTokenVisibilityRefresh();
  }
  if (skillChanged) invalidateStealthDetectionCache();
  if (skillChanged || statusChanged || factionChanged || permissionChanged) {
    queueStealthRefresh({ actor, visualization: true });
  }
  if (statusChanged || permissionChanged) synchronizeActorStealthState(actor);
}

function onActiveEffectChanged(effect, changes = null, operation = "update") {
  resetSmokeNativePerceptionGuard();
  const actor = effect?.parent;
  if (!actor || isPhantomEntity(actor) || !effectAffectsStealth(effect, changes, operation)) return;
  synchronizeActorStealthState(actor);
  invalidateStealthDetectionCache();
  queueStealthedTokenVisibilityRefresh();
  queueStealthRefresh({ actor, visualization: true });
}

function onTokenCreated(tokenDocument) {
  resetSmokeNativePerceptionGuard();
  if (!isDocumentInActiveScene(tokenDocument) || isPhantomEntity(tokenDocument)) return;
  updateStealthedCanvasTokenIndex(tokenDocument?.object);
  if (tokenDocument?.actor && isActorStealthed(tokenDocument.actor)) queueStealthedTokenVisibilityRefresh();
  synchronizePersistentDetectionVisualization(tokenDocument?.object);
  const emitsLight = tokenEmitsLight(tokenDocument);
  if (emitsLight) {
    invalidateLightingAnalysisCache();
    invalidateStealthDetectionCache();
    invalidateTargetDifficultyPreview();
    captureRuntimePerceptionSignature();
  }
  queueStealthRefresh({ allWindows: emitsLight, visualization: true });
}

function onTokenDrawn(token) {
  invalidateStealthDetectionObserver(token);
  updateStealthedCanvasTokenIndex(token);
  synchronizePersistentDetectionVisualization(token);
}

function onTokenRefreshed(token, flags = {}) {
  if (isPhantomEntity(token)) return;
  const controlled = globalThis.canvas?.tokens?.controlled ?? [];
  if (
    controlled.length === 1
    && controlled[0]?.id === token?.id
    && persistentVisualizationRenderStates.get(token.id) !== getPersistentVisualizationRenderState(token)
  ) {
    synchronizePersistentDetectionVisualization(token);
  }
  if (
    flags.refreshPosition
    || flags.refreshSize
    || flags.refreshShape
    || flags.refreshVisibility
  ) {
    invalidateTargetDifficultyPreview();
  }
}

function onTokenUpdated(tokenDocument, changes = {}) {
  resetSmokeNativePerceptionGuard();
  if (!isDocumentInActiveScene(tokenDocument) || isPhantomEntity(tokenDocument)) return;
  const localVisibilityChanged = hasChangedPath(changes, ["hidden"]);
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
    "actorLink",
    "elevation"
  ]);
  if (!geometryChanged && !localVisibilityChanged) return;
  if (localVisibilityChanged || hasChangedPath(changes, ["actorId", "actorLink"])) {
    updateStealthedCanvasTokenIndex(tokenDocument?.object);
    synchronizePersistentDetectionVisualization(tokenDocument?.object);
  }
  if (localVisibilityChanged) queueStealthRefresh({ visualization: true });
  if (!geometryChanged) return;
  const lightingChanged = hasChangedPath(changes, ["light"])
    || (tokenEmitsLight(tokenDocument) && hasChangedPath(changes, [
      "rotation", "width", "height", "depth", "shape", "level", "elevation"
    ]));
  if (lightingChanged) invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  captureRuntimePerceptionSignature();
  queueStealthRefresh({ allWindows: true, visualization: true });
}

function onTokenMoved(tokenDocument, movement = {}) {
  resetSmokeNativePerceptionGuard();
  if (!isDocumentInActiveScene(tokenDocument) || isPhantomEntity(tokenDocument)) return;
  const token = tokenDocument?.object;
  const emitsLight = tokenEmitsLight(tokenDocument);
  invalidateTargetDifficultyPreview();
  // Cache keys already include exact token positions. Ordinary movement can
  // therefore reuse every unaffected observer zone; a moving light source is
  // the one case which changes lighting for arbitrary points in the scene.
  if (emitsLight) {
    invalidateLightingAnalysisCache();
    invalidateStealthDetectionCache();
  }
  trackDetectionVisualizationMovement(token, movement?.animation?.ended);
  runAfterTokenAnimation(token, () => {
    // The document already contains the destination during animation while
    // its native VisionSource can still carry an intermediate rotation/shape.
    // Advance only this observer's key instead of evicting every scene zone.
    invalidateStealthDetectionObserver(token);
    if (!emitsLight) return;
    // moveToken is emitted before V14's animation promise settles. A final
    // invalidation prevents an intermediate light-source position from being
    // retained if a consumer repopulated the cache during the animation.
    invalidateLightingAnalysisCache();
    invalidateStealthDetectionCache();
    invalidateTargetDifficultyPreview();
    captureRuntimePerceptionSignature();
    queueStealthRefresh({ allWindows: true, visualization: true });
  }, movement?.animation?.ended);
}

function onControlledTokenChanged() {
  synchronizePersistentStealthVisualizations();
  refreshDetectionVisualizationMaskState();
  queueStealthRefresh({ visualization: true });
}

function onTokenDeleted(tokenDocument) {
  resetSmokeNativePerceptionGuard();
  const tokenId = tokenDocument?.id;
  stealthedCanvasTokenIds.delete(tokenId);
  if (isPhantomEntity(tokenDocument)) {
    cleanupTokenStealth(tokenId);
    return;
  }
  const emittedLight = tokenEmitsLight(tokenDocument);
  cleanupTokenStealth(tokenId);
  if (isDocumentInActiveScene(tokenDocument)) {
    if (emittedLight) {
      invalidateLightingAnalysisCache();
      invalidateStealthDetectionCache();
    }
    captureRuntimePerceptionSignature();
    queueStealthRefresh({ allWindows: emittedLight, visualization: true });
  }
}

function onCanvasReady() {
  resetSmokeNativePerceptionGuard();
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  invalidateStealthRelationCache();
  rebuildStealthedCanvasTokenIndex();
  captureRuntimePerceptionSignature();
  synchronizePersistentStealthVisualizations();
  queueStealthRefresh({ allWindows: true, visibility: true, visualization: true });
}

/** Foundry also emits lightingRefresh for an ordinary moving VisionSource. */
function onRuntimePerceptionRefresh() {
  if (consumeSmokeNativePerceptionGuard("lighting")) return;
  const nextSignature = getRuntimeLightingSignature();
  if (nextSignature === null) return;
  if (runtimeLightingSignature === null) {
    runtimeLightingSignature = nextSignature;
  } else {
    if (nextSignature === runtimeLightingSignature) return;
    runtimeLightingSignature = nextSignature;
  }
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  queueRuntimePerceptionUiRefresh();
}

/**
 * Sight refreshes occur throughout token movement. The native vision mask
 * already animates the overlay on the GPU, so this hot hook only watches the
 * two semantic inputs which can change without a Document update.
 */
function onRuntimeSightRefresh() {
  if (hasDetectionVisualizationSources()) refreshDetectionVisualizationMaskState();
  if (consumeSmokeNativePerceptionGuard("sight")) return;
  const nextSignature = getRuntimeSightSignature();
  if (nextSignature === null) return;
  if (runtimeSightSignature === null) {
    runtimeSightSignature = nextSignature;
    return;
  }
  if (nextSignature === runtimeSightSignature) return;
  runtimeSightSignature = nextSignature;
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  queueRuntimePerceptionUiRefresh();
}

function queueRuntimePerceptionUiRefresh() {
  const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
  runtimePerceptionUiDeadline = Date.now() + RUNTIME_PERCEPTION_UI_SETTLE_MS;
  if (runtimePerceptionUiTimeout) return;
  runtimePerceptionUiTimeout = schedule(flushRuntimePerceptionUiRefresh, RUNTIME_PERCEPTION_UI_SETTLE_MS);
}

function flushRuntimePerceptionUiRefresh() {
  runtimePerceptionUiTimeout = null;
  const remaining = runtimePerceptionUiDeadline - Date.now();
  if (remaining > 0) {
    const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
    runtimePerceptionUiTimeout = schedule(flushRuntimePerceptionUiRefresh, remaining);
    return;
  }
  runtimePerceptionUiDeadline = 0;
  queueStealthRefresh({ allWindows: true, visualization: true });
}

function captureRuntimePerceptionSignature() {
  runtimeLightingSignature = getRuntimeLightingSignature();
  runtimeSightSignature = getRuntimeSightSignature();
}

function getRuntimeLightingSignature({ stable = false } = {}) {
  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.ready) return null;
  const scene = activeCanvas.scene;
  const environment = activeCanvas.environment;
  const effects = activeCanvas.effects;
  return JSON.stringify([
    scene?.id ?? "",
    activeCanvas.level?.id ?? "",
    normalizeRuntimeSignatureNumber(environment?.darknessLevel),
    getEffectSourceRuntimeSignature(environment?.globalLightSource, { stable }),
    getEffectCollectionRuntimeSignature(effects?.lightSources, { stable }),
    getEffectCollectionRuntimeSignature(effects?.darknessSources, { stable }),
    getDarknessMeshRuntimeSignature(effects?.illumination?.darknessLevelMeshes?.children, { stable }),
    getRegionSurfaceRuntimeSignature(scene, "light")
  ]);
}

function getRuntimeSightSignature() {
  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.ready) return null;
  const scene = activeCanvas.scene;
  return JSON.stringify([
    scene?.id ?? "",
    activeCanvas.level?.id ?? "",
    peekSmokeRegionRevision(scene),
    getRegionSurfaceRuntimeSignature(scene, "sight")
  ]);
}

function getEffectCollectionRuntimeSignature(collection, { stable = false } = {}) {
  if (!collection || typeof collection.values !== "function") {
    throw new Error("Foundry effect-source Collection is required for the stealth runtime signature");
  }
  return Array.from(collection.values(), source => getEffectSourceRuntimeSignature(source, { stable }));
}

function getEffectSourceRuntimeSignature(source, { stable = false } = {}) {
  if (!source) return null;
  const identity = source.sourceId ?? source.name ?? getRuntimeSignatureObjectId(source);
  if (!stable && source.updateId !== undefined && source.updateId !== null) {
    // Foundry itself keys effect-source caches by (sourceId, updateId). Every
    // native initialize, including shape/origin/data changes, advances it.
    return [
      identity,
      getRuntimeSignatureObjectId(source),
      normalizeRuntimeSignatureNumber(source.updateId),
      Boolean(source.active),
      Boolean(source.suppressed)
    ];
  }
  const data = source.data ?? {};
  const origin = source.origin ?? source;
  return [
    identity,
    getRuntimeSignatureObjectId(source),
    stable ? "" : normalizeRuntimeSignatureNumber(source.updateId),
    Boolean(source.active),
    Boolean(source.suppressed),
    stable ? "" : getRuntimeSignatureObjectId(source.shape),
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

function getDarknessMeshRuntimeSignature(children, { stable = false } = {}) {
  if (!Array.isArray(children)) {
    throw new Error("Foundry darkness-level mesh children are required for the stealth runtime signature");
  }
  return children.map(mesh => {
    const shader = mesh?.shader ?? {};
    const region = mesh?.region;
    const elevation = region?.animationState?.elevation ?? region?.document?.elevation ?? {};
    return [
      mesh?.name ?? "",
      getRuntimeSignatureObjectId(mesh),
      stable ? "" : getRuntimeSignatureObjectId(mesh?.geometry),
      stable ? "" : getRuntimeSignatureObjectId(region?.animationState?.shapes),
      getAnimatedRegionRuntimeSignature(region),
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
  if (typeof scene?.getSurfaces !== "function") {
    throw new Error("Foundry Scene.getSurfaces is required for the stealth runtime signature");
  }
  const surfaces = scene.getSurfaces({ type });
  if (!surfaces || typeof surfaces[Symbol.iterator] !== "function") {
    throw new Error(`Foundry Scene.getSurfaces returned invalid ${type} surfaces`);
  }
  let state = runtimeRegionSurfaceSignatures.get(surfaces);
  if (!state) {
    const attachedRegions = [];
    const visited = new Set();
    for (const surface of surfaces) {
      const regionDocument = surface?.region?.document ?? surface?.region;
      if (!regionDocument?.attachment?.token || visited.has(regionDocument)) continue;
      visited.add(regionDocument);
      attachedRegions.push(regionDocument);
    }
    state = {
      identity: getRuntimeSignatureObjectId(surfaces),
      attachedRegions
    };
    runtimeRegionSurfaceSignatures.set(surfaces, state);
  }
  if (!state.attachedRegions.length) return state.identity;
  const animated = [];
  for (const regionDocument of state.attachedRegions) {
    const signature = getAnimatedRegionRuntimeSignature(regionDocument);
    if (signature) animated.push(signature);
  }
  return animated.length ? [state.identity, animated] : state.identity;
}

function getAnimatedRegionRuntimeSignature(region) {
  const object = region?.object ?? region;
  if (!object?.isAnimating) return "";
  const document = object.document ?? region?.document ?? region;
  const token = document?.attachment?.token;
  return [
    getRuntimeSignatureObjectId(object),
    normalizeRuntimeSignatureNumber(token?.x),
    normalizeRuntimeSignatureNumber(token?.y),
    normalizeRuntimeSignatureNumber(token?.elevation),
    normalizeRuntimeSignatureNumber(token?.rotation)
  ];
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
  resetSmokeNativePerceptionGuard();
  if (scene?.id !== globalThis.canvas?.scene?.id) return;
  if (!hasChangedPath(changes, ["darkness", "environment", "globalLight", "tokenVision", "grid", "dimensions"])) return;
  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  captureRuntimePerceptionSignature();
  queueStealthRefresh({ allWindows: true, visibility: true, visualization: true });
}

function onSceneGeometryChanged(document) {
  resetSmokeNativePerceptionGuard();
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

function onSmokePerceptionChanged() {
  invalidateStealthDetectionCache();
  queueStealthRefresh({ visualization: true });
}

function onSmokeRegionAnimation(regionDocument) {
  if (!isDocumentInActiveScene(regionDocument)) return;
  // The smoke index revision changes synchronously in smoke-vision. Keep
  // lighting queries correct now, while detection cache keys naturally move to
  // the new revision. Preserve the prior generic signature so that a later
  // unknown native refresh remains conservative after the exact frame guard.
  invalidateLightingAnalysisCache();
  queueRuntimePerceptionUiRefresh();
}

function onSmokeNativePerceptionRefresh({
  scene,
  revision,
  sources: sourceEntries = [],
  expectLighting = false,
  expectSight = false
} = {}) {
  resetSmokeNativePerceptionGuard();
  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.ready || scene !== activeCanvas.scene) return;
  if (!Number.isSafeInteger(revision) || revision < 0 || peekSmokeRegionRevision(scene) !== revision) return;
  if (typeof expectLighting !== "boolean" || typeof expectSight !== "boolean") return;
  if (!expectLighting && !expectSight) return;
  if (!Array.isArray(sourceEntries)) return;

  const sources = [];
  const visited = new Set();
  for (const entry of sourceEntries) {
    const source = entry?.source;
    const collectionName = entry?.collectionName;
    if (!source || visited.has(source)
      || !["lightSources", "darknessSources", "visionSources"].includes(collectionName)) return;
    const collection = activeCanvas.effects?.[collectionName];
    if (!collection || typeof collection.get !== "function") return;
    if (!Number.isSafeInteger(entry.updateId) || entry.updateId < 0) return;
    if (typeof entry.active !== "boolean" || typeof entry.suppressed !== "boolean") return;
    if (entry.sourceId !== source.sourceId || collection.get(entry.sourceId) !== source) return;
    if (entry.updateId !== source.updateId) return;
    if (Boolean(entry.active) !== Boolean(source.active)) return;
    if (Boolean(entry.suppressed) !== Boolean(source.suppressed)) return;
    visited.add(source);
    sources.push({
      source,
      collection,
      collectionName,
      sourceId: entry.sourceId,
      updateId: entry.updateId,
      active: Boolean(entry.active),
      suppressed: Boolean(entry.suppressed),
      stableState: getEffectSourceRuntimeSignature(source, { stable: true })
    });
  }

  const token = {};
  smokeNativePerceptionGuard = {
    token,
    scene,
    levelId: activeCanvas.level?.id ?? "",
    revision,
    sources,
    lightingPending: Boolean(expectLighting),
    sightPending: Boolean(expectSight)
  };
  globalThis.queueMicrotask(() => {
    if (smokeNativePerceptionGuard?.token === token) smokeNativePerceptionGuard = null;
  });
}

function consumeSmokeNativePerceptionGuard(phase) {
  const guard = smokeNativePerceptionGuard;
  if (!guard) return false;
  const pendingKey = phase === "lighting" ? "lightingPending" : "sightPending";
  if (!guard[pendingKey] || !matchesSmokeNativePerceptionGuard(guard)) {
    smokeNativePerceptionGuard = null;
    return false;
  }
  guard[pendingKey] = false;
  if (!guard.lightingPending && !guard.sightPending) smokeNativePerceptionGuard = null;
  return true;
}

function matchesSmokeNativePerceptionGuard(guard) {
  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.ready || activeCanvas.scene !== guard.scene) return false;
  if ((activeCanvas.level?.id ?? "") !== guard.levelId) return false;
  if (peekSmokeRegionRevision(guard.scene) !== guard.revision) return false;
  for (const entry of guard.sources) {
    const source = entry.source;
    if (activeCanvas.effects?.[entry.collectionName] !== entry.collection) return false;
    if (entry.collection.get(entry.sourceId) !== source) return false;
    if (source.sourceId !== entry.sourceId || source.updateId !== entry.updateId) return false;
    if (Boolean(source.active) !== entry.active || Boolean(source.suppressed) !== entry.suppressed) return false;
    if (!areRuntimeSignatureArraysEqual(
      getEffectSourceRuntimeSignature(source, { stable: true }),
      entry.stableState
    )) return false;
  }
  return true;
}

function areRuntimeSignatureArraysEqual(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

function resetSmokeNativePerceptionGuard() {
  smokeNativePerceptionGuard = null;
}

function synchronizeActorStealthState(actor) {
  if (!actor) return;
  const stealthed = isActorStealthed(actor);
  if (!stealthed && targetMode) {
    const source = globalThis.canvas?.tokens?.get(targetMode.sourceTokenId);
    if (source?.actor?.uuid === actor.uuid) stopTargetingMode();
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token.actor?.uuid !== actor.uuid) continue;
    updateStealthedCanvasTokenIndex(token);
    if (stealthed) synchronizePersistentDetectionVisualization(token);
    else cleanupTokenStealthVisualization(token.id);
  }
}

function rebuildStealthedCanvasTokenIndex() {
  stealthedCanvasTokenIds.clear();
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    updateStealthedCanvasTokenIndex(token);
  }
}

function updateStealthedCanvasTokenIndex(token) {
  const tokenId = token?.id;
  if (!tokenId) return;
  if (token?.actor && isActorStealthed(token.actor) && !isPhantomEntity(token)) {
    stealthedCanvasTokenIds.add(tokenId);
  } else {
    stealthedCanvasTokenIds.delete(tokenId);
  }
}

function synchronizePersistentStealthVisualizations() {
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    synchronizePersistentDetectionVisualization(token);
  }
}

function synchronizePersistentDetectionVisualization(token) {
  if (!token?.id || isPhantomEntity(token)) return false;
  persistentVisualizationRenderStates.set(token.id, getPersistentVisualizationRenderState(token));
  const controlled = globalThis.canvas?.tokens?.controlled ?? [];
  const active = controlled.length === 1
    && controlled[0]?.id === token.id
    && canRenderDetectionVisualizationForLocalUser(token);
  setPersistentDetectionVisualization(token, active);
  return active;
}

function getPersistentVisualizationRenderState(token) {
  let state = 0;
  if (token?.visible !== false) state |= 1;
  if (token?.renderable !== false) state |= 2;
  if (token?.hidden === true || token?.document?.hidden === true) state |= 4;
  return state;
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
  persistentVisualizationRenderStates.delete(tokenId);
  if (targetMode?.sourceTokenId === tokenId) stopTargetingMode();
}

function cleanupAllStealthUi() {
  resetSmokeNativePerceptionGuard();
  clearRuntimeTimers();
  stopTargetingMode();
  for (const app of [...stealthWindows.values()]) void app.close();
  stealthWindows.clear();
  cleanupAllStealthVisualizations();
  tokenAnimationTasks.clear();
  persistentVisualizationRenderStates.clear();
  clearWeaponNoiseDetectionQueues();
  pendingActorRefreshes.clear();
  refreshAllWindowsPending = false;
  visibilityRefreshPending = false;
  visualizationRefreshPending = false;
  stealthedCanvasTokenIds.clear();
  runtimeLightingSignature = null;
  runtimeSightSignature = null;
  invalidateStealthDetectionCache();
  invalidateLightingAnalysisCache();
}

function clearRuntimeTimers() {
  const clear = globalThis.window?.clearTimeout ?? globalThis.clearTimeout;
  if (refreshTimeout) clear(refreshTimeout);
  if (runtimePerceptionUiTimeout) clear(runtimePerceptionUiTimeout);
  refreshTimeout = null;
  runtimePerceptionUiTimeout = null;
  runtimePerceptionUiDeadline = 0;
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
  if (game.paused || game.combat?.started) return;
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
  for (const statusId of effect?.statuses ?? []) {
    if (isStealthRelevantStatus(statusId)) return true;
  }
  const effectChanges = effect?.system?.changes ?? effect?.changes ?? [];
  for (const change of effectChanges) {
    const key = String(change?.key ?? "").trim();
    if (
      key.startsWith("system.skills.")
      || key === SMOKE_PERCEPTION_PERCENT_EFFECT_KEY
      || getDetectionModeIdFromRangeEffectKey(key)
    ) return true;
  }
  if (operation !== "update") return false;
  return hasChangedPath(changes, ["statuses", "changes", "system.changes", "disabled", "transfer"]);
}

function isStealthRelevantStatus(statusId) {
  const id = String(statusId ?? "").trim();
  if (!id) return false;
  const special = globalThis.CONFIG?.specialStatusEffects ?? {};
  return id === getStealthStatusId()
    || id === special.BLIND
    || id === special.DEFEATED
    || id === special.BURROW
    || id === "blind"
    || id === "blinded"
    || id === "dead"
    || id === "unconscious";
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
  if (outcome?.falloutMawRevealPrevented) return false;
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
    && !isPhantomEntity(token)
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
