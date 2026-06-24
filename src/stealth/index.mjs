import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getStealthSettings } from "../settings/accessors.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { notifyDangerSenseWarning } from "../abilities/danger-sense.mjs";
import { STEALTH_LIGHT_LEVELS } from "./settings.mjs";
import { evaluateFormula, evaluateFormulaVariables } from "../formulas/evaluation.mjs";
import {
  ACTION_RESOURCE_KEY,
  MOVEMENT_RESOURCE_KEY,
  applyCombatMovementCostModifier
} from "../combat/movement-resources.mjs";
import {
  CONTROLLED_MOVEMENT_INTERRUPTION_OPTION,
  createSnappedWaypointAtTokenCenter,
  getMovementRouteSamples,
  getMovementSegmentSamples,
  getTokenCenterAt,
  registerMovementInterruptionProvider
} from "../canvas/movement-interruptions.mjs";
import { canTokenPhysicallySeeTarget } from "../combat/weapon-attack-controller.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorFactionBelongs,
  getFactionScore,
  getRelationFromScore,
  getRelationTo
} from "../settings/factions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const STEALTH_SOCKET = `system.${SYSTEM_ID}`;
const STEALTH_SOCKET_SCOPE = "fallout-maw.stealth";
const STEALTH_STATUS_ID = "invisible";
const STEALTH_TARGET_TOOLTIP_ID = "fallout-maw-stealth-target-tooltip";
const STEALTH_DETECTION_PROVIDER_ID = "stealthDetection";
const STEALTH_DETECTION_LAYER = "falloutMawStealthDetectionZones";
const STEALTH_DETECTION_HOVER_LAYER = "falloutMawStealthDetectionHoverZone";
const STEALTH_DETECTION_PRIORITY = 3;
const STEALTH_HIDDEN_OBSERVER_DIFFICULTY_MODIFIER = -50;
const STEALTH_DETECTION_CACHE_LIMIT = 750;
const STEALTH_DETECTION_SKIP_UNTIL_OPTION = "falloutMawSkipStealthDetectionUntil";
const STEALTH_RANGE_FORMULA_VARIABLES = Object.freeze(["skill", "навык"]);

const stealthWindows = new Map();
const detectionVisualizations = new Map();
const detectionMovementState = new Map();
const detectionZoneCache = new Map();
const detectionPointCache = new Map();
const stealthAllyVisibilityCache = new Map();
const detectionVisualizationMovementKeys = new Map();
const detectionVisualizationMovementTrackers = new Map();
let detectionHoverTokenId = null;
let targetMode = null;
let hooksRegistered = false;
let stealthSocketRegistered = false;
let stealthAllyVisibilityPatchRegistered = false;
let refreshAllStealthWindowsTimeout = null;
let refreshDetectionVisualizationsTimeout = null;
let refreshStealthedTokenVisibilityTimeout = null;
let pendingAllStealthRefreshAfterMovement = false;
let pendingDetectionVisualizationRefreshAfterMovement = false;

export function registerStealthHooks() {
  if (hooksRegistered) return;
  patchStealthAllyVisibilityDetection();
  if (game.ready) registerStealthSocket();
  else Hooks.once("ready", registerStealthSocket);
  registerMovementInterruptionProvider({
    id: STEALTH_DETECTION_PROVIDER_ID,
    collect: collectStealthMovementInterruptions,
    execute: executeStealthMovementInterruption
  });
  Hooks.on("updateActor", actor => {
    stealthAllyVisibilityCache.clear();
    refreshStealthWindowsForActor(actor);
    queueStealthedTokenVisibilityRefresh();
  });
  Hooks.on("updateActiveEffect", effect => {
    stealthAllyVisibilityCache.clear();
    refreshStealthWindowsForActor(effect?.parent);
    queueStealthedTokenVisibilityRefresh();
  });
  Hooks.on("updateToken", onTokenUpdated);
  Hooks.on("deleteToken", tokenDocument => cleanupTokenStealth(tokenDocument?.id));
  Hooks.on("canvasReady", () => {
    refreshAllStealthWindowsWithInvalidation();
    queueStealthedTokenVisibilityRefresh();
  });
  Hooks.on("canvasTearDown", cleanupAllStealthUi);
  Hooks.on("updateScene", refreshAllStealthWindowsWithInvalidation);
  Hooks.on("createAmbientLight", refreshAllStealthWindowsWithInvalidation);
  Hooks.on("updateAmbientLight", refreshAllStealthWindowsWithInvalidation);
  Hooks.on("deleteAmbientLight", refreshAllStealthWindowsWithInvalidation);
  Hooks.on("createWall", refreshAllStealthWindowsWithInvalidation);
  Hooks.on("updateWall", refreshAllStealthWindowsWithInvalidation);
  Hooks.on("deleteWall", refreshAllStealthWindowsWithInvalidation);
  Hooks.on("lightingRefresh", refreshAllStealthWindowsWithInvalidation);
  Hooks.on("sightRefresh", queueSightStealthVisualizationRefresh);
  Hooks.on("hoverToken", onTokenHoverForDetectionZone);
  Hooks.on("moveToken", onTokenMoved);
  Hooks.on(`${SYSTEM_ID}.stealthSettingsChanged`, refreshAllStealthWindowsWithInvalidation);
  hooksRegistered = true;
}

function registerStealthSocket() {
  if (stealthSocketRegistered) return;
  game.socket?.on?.(STEALTH_SOCKET, handleStealthSocketMessage);
  stealthSocketRegistered = true;
}

function handleStealthSocketMessage(message = {}) {
  if (message?.scope !== STEALTH_SOCKET_SCOPE) return;
  if (message.action !== "pauseDetection") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
  pauseGameForStealthDetection({ localOnly: true });
}

function patchStealthAllyVisibilityDetection() {
  if (stealthAllyVisibilityPatchRegistered) return;
  const detectionModes = CONFIG?.Canvas?.detectionModes;
  patchStealthAllyVisibilityDetectionMode(detectionModes?.basicSight);
  patchStealthAllyVisibilityDetectionMode(detectionModes?.lightPerception);
  stealthAllyVisibilityPatchRegistered = true;
}

function patchStealthAllyVisibilityDetectionMode(mode) {
  if (!mode || mode._falloutMawStealthAllyVisibilityPatched) return;
  const originalCanDetect = mode._canDetect;
  if (typeof originalCanDetect !== "function") return;

  Object.defineProperty(mode, "_canDetect", {
    value(visionSource, target, level) {
      if (originalCanDetect.call(this, visionSource, target, level)) return true;
      return canVisionSourceDetectStealthedAlly(visionSource, target, this);
    },
    configurable: true,
    writable: true
  });
  Object.defineProperty(mode, "_falloutMawStealthAllyVisibilityPatched", {
    value: true,
    configurable: true
  });
}

function canVisionSourceDetectStealthedAlly(visionSource, target, mode) {
  const targetDocument = target?.document;
  const targetActor = target?.actor ?? targetDocument?.actor;
  const sourceDocument = visionSource?.object?.document;
  const sourceActor = visionSource?.object?.actor ?? sourceDocument?.actor;
  if (!targetDocument || !targetActor || !sourceDocument || !sourceActor) return false;

  const invisible = CONFIG?.specialStatusEffects?.INVISIBLE ?? STEALTH_STATUS_ID;
  if (!targetDocument.hasStatusEffect?.(invisible) || !isActorStealthed(targetActor)) return false;

  const burrow = CONFIG?.specialStatusEffects?.BURROW;
  const blind = CONFIG?.specialStatusEffects?.BLIND;
  if (burrow && (targetDocument.hasStatusEffect?.(burrow) || sourceDocument.hasStatusEffect?.(burrow))) return false;
  if (blind && sourceDocument.hasStatusEffect?.(blind)) return false;
  if (mode?.walls && visionSource?.blinded?.darkness) return false;

  if (sourceActor.uuid === targetActor.uuid) return true;
  return areActorsStealthAlliesCached(targetActor, sourceActor);
}

export function openStealthWindow(token) {
  const resolvedToken = token ?? canvas?.tokens?.controlled?.at(0) ?? null;
  if (!resolvedToken?.actor) {
    ui.notifications.warn("Для скрытности выберите токен с актером.");
    return undefined;
  }
  if (!canControlStealth(resolvedToken.actor)) {
    ui.notifications.warn(`Нет прав на управление скрытностью актера ${resolvedToken.actor.name}.`);
    return undefined;
  }

  const tokenId = resolvedToken.id;
  const existing = stealthWindows.get(tokenId);
  if (existing) {
    existing.token = resolvedToken;
    return existing.render({ force: true });
  }

  const app = new StealthWindow(resolvedToken);
  stealthWindows.set(tokenId, app);
  return app.render({ force: true });
}

export function isActorStealthed(actor) {
  return Boolean(actor?.statuses?.has(STEALTH_STATUS_ID));
}

export async function toggleActorStealth(actor, active = !isActorStealthed(actor)) {
  if (!actor) return false;
  if (!canControlStealth(actor)) {
    ui.notifications.warn(`Нет прав на управление скрытностью актера ${actor.name}.`);
    return false;
  }
  if (isActorStealthed(actor) === Boolean(active)) return true;
  await actor.toggleStatusEffect(STEALTH_STATUS_ID, { active: Boolean(active) });
  if (active) {
    await resolveStealthEntryDetection(actor);
  } else {
    stopTargetingMode();
    clearDetectionMovementStateForActor(actor);
    for (const token of canvas?.tokens?.placeables ?? []) {
      if (token.actor?.uuid === actor.uuid) removeDetectionVisualization(token.id);
    }
  }
  queueStealthedTokenVisibilityRefresh();
  refreshStealthWindowsForActor(actor);
  return true;
}

export function computeStealthDifficulty(sourceToken, targetToken) {
  const sourceActor = sourceToken?.actor;
  const targetActor = targetToken?.actor;
  if (!sourceActor || !targetActor) return null;

  const settings = getStealthSettings();
  const lighting = analyzeTokenLighting(sourceToken);
  const modifiers = lighting.modifiers;
  const difficultySkillKey = String(settings.difficulty?.skillKey ?? "naturalist");
  const targetBase = Math.max(0, getActorSkillValue(targetActor, difficultySkillKey));
  const distance = measureTokenDistance(sourceToken, targetToken);
  const baseDifficulty = Math.round(targetBase);
  const hiddenObserver = isActorStealthed(targetActor);
  const hiddenObserverModifier = hiddenObserver ? STEALTH_HIDDEN_OBSERVER_DIFFICULTY_MODIFIER : 0;
  const difficulty = Math.round(baseDifficulty + modifiers.difficultyBonus + hiddenObserverModifier);

  return {
    difficulty,
    baseDifficulty,
    targetBase,
    difficultySkillKey,
    distance,
    hiddenObserver,
    hiddenObserverModifier,
    advantageCount: hiddenObserver ? 1 : 0,
    lighting: {
      ...lighting,
      modifiers
    }
  };
}

export function getStealthAttackModifiers(actor) {
  if (!isActorStealthed(actor)) return {
    criticalChanceBonus: 0,
    damageBonusPercent: 0
  };
  return {
    criticalChanceBonus: getActorCharacteristicValue(actor, "luck"),
    damageBonusPercent: Math.max(0, Math.floor(getActorSkillValue(actor, "stealth") / 5))
  };
}

export async function revealActorFromStealth(actor) {
  if (!isActorStealthed(actor)) return false;
  return toggleActorStealth(actor, false);
}

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
    position: {
      width: 360,
      height: "auto"
    },
    window: {
      title: "Скрытность",
      resizable: true
    },
    actions: {
      toggleStealth: this.#onToggleStealth,
      startTargeting: this.#onStartTargeting
    }
  };

  static PARTS = {
    window: {
      template: TEMPLATES.stealthWindow
    }
  };

  get actor() {
    return this.token?.actor ?? null;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const lighting = analyzeTokenLighting(this.token);
    const radius = calculateStealthRadius(lighting.effectiveDarkness, getStealthSettings(), this.actor);
    return {
      ...context,
      actor: this.actor,
      token: this.token,
      stealthed: isActorStealthed(this.actor),
      stealthValue: getActorSkillValue(this.actor, "stealth"),
      radius,
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
    return this.render({ force: true });
  }

  static #onStartTargeting(event) {
    event.preventDefault();
    if (!isActorStealthed(this.actor)) return undefined;
    startTargetingMode(this.token, this);
    return undefined;
  }
}

function startTargetingMode(sourceToken, app) {
  stopTargetingMode();
  if (!sourceToken?.actor) return;
  const view = canvas?.app?.view;
  if (!view) return;

  const tooltip = getTargetTooltip();
  targetMode = {
    sourceTokenId: sourceToken.id,
    app,
    tooltip,
    hoveredToken: null,
    pointerMove: event => onTargetPointerMove(event),
    pointerDown: event => onTargetPointerDown(event),
    contextMenu: event => {
      event.preventDefault();
      stopTargetingMode();
    },
    keyDown: event => {
      if (event.key === "Escape") stopTargetingMode();
    }
  };
  view.addEventListener("pointermove", targetMode.pointerMove, { capture: true });
  view.addEventListener("pointerdown", targetMode.pointerDown, { capture: true });
  view.addEventListener("contextmenu", targetMode.contextMenu, { capture: true });
  document.addEventListener("keydown", targetMode.keyDown);
  view.classList.add("fallout-maw-stealth-targeting");
  ui.notifications.info("Выберите цель проверки скрытности.");
}

function stopTargetingMode() {
  if (!targetMode) return;
  const view = canvas?.app?.view;
  view?.removeEventListener("pointermove", targetMode.pointerMove, { capture: true });
  view?.removeEventListener("pointerdown", targetMode.pointerDown, { capture: true });
  view?.removeEventListener("contextmenu", targetMode.contextMenu, { capture: true });
  view?.classList.remove("fallout-maw-stealth-targeting");
  document.removeEventListener("keydown", targetMode.keyDown);
  targetMode.tooltip?.remove();
  targetMode = null;
}

function onTargetPointerMove(event) {
  if (!targetMode) return;
  const sourceToken = canvas.tokens?.get(targetMode.sourceTokenId);
  const hovered = getTokenAtClientPoint(event, sourceToken?.id);
  targetMode.hoveredToken = hovered;
  if (!hovered || !sourceToken) {
    targetMode.tooltip.hidden = true;
    return;
  }
  const difficulty = computeStealthDifficulty(sourceToken, hovered);
  if (!difficulty) {
    targetMode.tooltip.hidden = true;
    return;
  }
  targetMode.tooltip.hidden = false;
  targetMode.tooltip.innerHTML = `
    <strong>${escapeHtml(hovered.name)}</strong>
    <span>СЛ ${difficulty.difficulty}</span>
    <small>${escapeHtml(difficulty.lighting.modifiers.condition)} · ${Math.round(difficulty.distance)}</small>
  `;
  positionTooltip(targetMode.tooltip, event);
}

async function onTargetPointerDown(event) {
  if (!targetMode || event.button !== 0) return;
  const sourceToken = canvas.tokens?.get(targetMode.sourceTokenId);
  const targetToken = targetMode.hoveredToken ?? getTokenAtClientPoint(event, sourceToken?.id);
  if (!sourceToken?.actor || !targetToken?.actor) return;

  event.preventDefault();
  event.stopPropagation();
  await rollStealthCheck(sourceToken, targetToken, targetMode.app);
  if (!event.shiftKey) stopTargetingMode();
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
      advantageCount: difficulty.advantageCount
    },
    messageData: result => isStealthCheckSuccess(result) ? createStealthSuccessMessageData(sourceToken.actor) : {}
  });
  if (isStealthCheckFailure(outcome)) {
    await toggleActorStealth(sourceToken.actor, false);
  } else if (isStealthCheckSuccess(outcome)) {
    notifyDangerSenseWarning(targetToken.actor);
  }
  await app?.render({ force: true });
  return outcome;
}

async function resolveStealthEntryDetection(actor) {
  const settings = getStealthSettings();
  if (!settings.autoDetection?.enabled || !canvas?.ready || !isActorStealthed(actor)) return false;
  for (const token of getSceneTokensForActor(actor)) {
    if (!isActorStealthed(actor)) return true;
    if (await resolveStealthEntryDetectionForToken(token)) return true;
  }
  return false;
}

async function resolveStealthEntryDetectionForToken(hiddenToken) {
  if (!hiddenToken?.actor || !isActorStealthed(hiddenToken.actor)) return false;
  const hiddenPoint = getTokenCenter(hiddenToken);
  for (const observerToken of canvas.tokens?.placeables ?? []) {
    if (!isActorStealthed(hiddenToken.actor)) return true;
    if (!isValidStealthObserver(hiddenToken, observerToken)) continue;
    const observerOrigin = getTokenCenter(observerToken);
    if (!isPointInsideObserverZone(hiddenPoint, observerToken, observerOrigin)) continue;

    const outcome = await rollStealthCheck(hiddenToken, observerToken, null, { animate: false });
    if (!isActorStealthed(hiddenToken.actor) || isStealthCheckFailure(outcome)) {
      pauseGameForStealthDetection();
      return true;
    }
  }
  return false;
}

function getSceneTokensForActor(actor) {
  if (!actor?.uuid) return [];
  return (canvas?.tokens?.placeables ?? []).filter(token => token.actor?.uuid === actor.uuid);
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
  return {
    whisper: Array.from(whisper),
    includeRolls: false
  };
}

function onTokenUpdated(tokenDocument, changes) {
  const token = tokenDocument?.object;
  const moved = Boolean(foundry.utils.hasProperty(changes, "x")
    || foundry.utils.hasProperty(changes, "y")
    || foundry.utils.hasProperty(changes, "elevation"));
  const visionChanged = Boolean(foundry.utils.hasProperty(changes, "sight")
    || foundry.utils.hasProperty(changes, "detectionModes")
    || foundry.utils.hasProperty(changes, "light"));
  if (visionChanged) {
    refreshAllStealthWindowsWithInvalidation();
    return;
  }
  if (moved) trackDetectionVisualizationMovement(token);
}

function onTokenMoved(tokenDocument, movement = {}) {
  trackDetectionVisualizationMovement(tokenDocument?.object, movement?.animation?.ended);
}

function refreshStealthWindowsForActor(actor) {
  if (!actor) return;
  for (const [tokenId, app] of stealthWindows) {
    const token = canvas?.tokens?.get(tokenId);
    if (!token || token.actor?.uuid !== actor.uuid) continue;
    app.token = token;
    void app.render({ force: true });
  }
}

function refreshAllStealthWindows() {
  for (const [tokenId, app] of stealthWindows) {
    const token = canvas?.tokens?.get(tokenId);
    if (!token) continue;
    app.token = token;
    void app.render({ force: true });
  }
}

function refreshDetectionVisualizations() {
  for (const tokenId of [...detectionVisualizations.keys()]) {
    const token = canvas?.tokens?.get(tokenId);
    if (!token?.actor || !isActorStealthed(token.actor)) removeDetectionVisualization(tokenId);
    else updateDetectionVisualization(token);
  }
}

function trackDetectionVisualizationMovement(token, animationOverride = null) {
  if (!token?.id || !isTokenRelevantToDetectionVisualization(token)) return;

  const animation = animationOverride ?? token.document?.movement?.animation?.ended ?? token.movementAnimationPromise;
  if (!animation || typeof animation.then !== "function") {
    updateDetectionVisualizationForTokenCell(token, { force: true, renderWindows: true });
    return;
  }

  const existing = detectionVisualizationMovementTrackers.get(token.id);
  if (existing?.animation === animation) return;
  stopDetectionVisualizationMovementTracking(token.id);

  detectionVisualizationMovementTrackers.set(token.id, { animation });
  void animation.finally(() => {
    stopDetectionVisualizationMovementTracking(token.id);
    updateDetectionVisualizationForTokenCell(token, { force: true, renderWindows: true });
    flushPendingStealthRefreshAfterMovement();
  }).catch(() => {});
}

function updateDetectionVisualizationForTokenCell(token, { force = false, renderWindows = false } = {}) {
  const key = getTokenVisualizationGridKey(token);
  if (!key) return false;
  if (!force && detectionVisualizationMovementKeys.get(token.id) === key) return false;
  detectionVisualizationMovementKeys.set(token.id, key);
  if (renderWindows) refreshAllStealthWindows();
  else refreshDetectionVisualizations();
  return true;
}

function stopDetectionVisualizationMovementTracking(tokenId) {
  const tracker = detectionVisualizationMovementTrackers.get(tokenId);
  if (!tracker) return;
  detectionVisualizationMovementTrackers.delete(tokenId);
}

function flushPendingStealthRefreshAfterMovement() {
  if (detectionVisualizationMovementTrackers.size) return;
  if (pendingAllStealthRefreshAfterMovement) {
    pendingAllStealthRefreshAfterMovement = false;
    pendingDetectionVisualizationRefreshAfterMovement = false;
    refreshAllStealthWindowsWithInvalidation();
    return;
  }
  if (pendingDetectionVisualizationRefreshAfterMovement) {
    pendingDetectionVisualizationRefreshAfterMovement = false;
    queueDetectionVisualizationRefresh();
  }
}

function isTokenRelevantToDetectionVisualization(token) {
  if (!token?.actor || !detectionVisualizations.size) return false;
  if (detectionVisualizations.has(token.id)) return true;
  for (const hiddenTokenId of detectionVisualizations.keys()) {
    const hiddenToken = canvas?.tokens?.get(hiddenTokenId);
    if (hiddenToken && isValidStealthObserver(hiddenToken, token)) return true;
  }
  return false;
}

function refreshAllStealthWindowsWithInvalidation() {
  if (detectionVisualizationMovementTrackers.size) {
    pendingAllStealthRefreshAfterMovement = true;
    return;
  }
  invalidateStealthDetectionCaches();
  refreshAllStealthWindows();
}

function queueRefreshAllStealthWindows() {
  if (refreshAllStealthWindowsTimeout) return;
  const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
  refreshAllStealthWindowsTimeout = schedule(() => {
    refreshAllStealthWindowsTimeout = null;
    refreshAllStealthWindows();
  }, 50);
}

function queueSightStealthVisualizationRefresh() {
  if (detectionVisualizationMovementTrackers.size) {
    pendingDetectionVisualizationRefreshAfterMovement = true;
    return;
  }
  queueDetectionVisualizationRefresh();
}

function queueDetectionVisualizationRefresh() {
  if (refreshDetectionVisualizationsTimeout) return;
  const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
  refreshDetectionVisualizationsTimeout = schedule(() => {
    refreshDetectionVisualizationsTimeout = null;
    refreshDetectionVisualizations();
  }, 50);
}

function queueStealthedTokenVisibilityRefresh() {
  if (!canvas?.ready || refreshStealthedTokenVisibilityTimeout) return;
  const schedule = globalThis.window?.setTimeout ?? globalThis.setTimeout;
  refreshStealthedTokenVisibilityTimeout = schedule(() => {
    refreshStealthedTokenVisibilityTimeout = null;
    refreshStealthedTokenVisibility();
  }, 25);
}

function refreshStealthedTokenVisibility() {
  const tokens = canvas?.tokens?.placeables ?? [];
  for (const token of tokens) {
    if (token?.actor && isActorStealthed(token.actor)) token.renderFlags?.set?.({ refreshVisibility: true });
  }
}

function invalidateStealthDetectionCaches() {
  detectionZoneCache.clear();
  detectionPointCache.clear();
  stealthAllyVisibilityCache.clear();
}

function cleanupTokenStealth(tokenId) {
  const app = stealthWindows.get(tokenId);
  if (app) void app.close();
  removeDetectionVisualization(tokenId);
  clearDetectionMovementStateForToken(tokenId);
  detectionVisualizationMovementKeys.delete(tokenId);
  stopDetectionVisualizationMovementTracking(tokenId);
  if (targetMode?.sourceTokenId === tokenId) stopTargetingMode();
}

function cleanupAllStealthUi() {
  if (refreshAllStealthWindowsTimeout) {
    const clear = globalThis.window?.clearTimeout ?? globalThis.clearTimeout;
    clear(refreshAllStealthWindowsTimeout);
    refreshAllStealthWindowsTimeout = null;
  }
  if (refreshDetectionVisualizationsTimeout) {
    const clear = globalThis.window?.clearTimeout ?? globalThis.clearTimeout;
    clear(refreshDetectionVisualizationsTimeout);
    refreshDetectionVisualizationsTimeout = null;
  }
  if (refreshStealthedTokenVisibilityTimeout) {
    const clear = globalThis.window?.clearTimeout ?? globalThis.clearTimeout;
    clear(refreshStealthedTokenVisibilityTimeout);
    refreshStealthedTokenVisibilityTimeout = null;
  }
  stopTargetingMode();
  for (const app of stealthWindows.values()) void app.close();
  stealthWindows.clear();
  for (const tokenId of detectionVisualizations.keys()) removeDetectionVisualization(tokenId);
  clearDetectionHoverFill();
  detectionHoverTokenId = null;
  detectionMovementState.clear();
  detectionVisualizationMovementKeys.clear();
  pendingAllStealthRefreshAfterMovement = false;
  pendingDetectionVisualizationRefreshAfterMovement = false;
  for (const tokenId of [...detectionVisualizationMovementTrackers.keys()]) {
    stopDetectionVisualizationMovementTracking(tokenId);
  }
  invalidateStealthDetectionCaches();
}

function collectStealthMovementInterruptions({ tokenDocument, movement, options } = {}) {
  const settings = getStealthSettings();
  if (!settings.autoDetection?.enabled || !tokenDocument?.actor || !movement || !canvas?.ready) return [];

  const samples = getMovementRouteSamples(tokenDocument, movement);
  if (samples.length < 2) return [];
  const pairDescriptors = getMovementStealthPairDescriptors(tokenDocument);
  if (!pairDescriptors.length) return [];
  const movementThreshold = evaluateAutoDetectionMovementThreshold(tokenDocument.actor, settings);

  let routeOrder = 0;
  let skipUntilKey = String(options?.[STEALTH_DETECTION_SKIP_UNTIL_OPTION] ?? "");
  const routeInsideState = new Map();
  for (let index = 1; index < samples.length; index += 1) {
    const segmentSamples = getStealthMovementSegmentSamples(tokenDocument, samples[index - 1], samples[index]);
    for (let segmentIndex = 1; segmentIndex < segmentSamples.length; segmentIndex += 1) {
      routeOrder += 1;
      const previous = segmentSamples[segmentIndex - 1];
      const current = segmentSamples[segmentIndex];
      if (skipUntilKey) {
        if (getMovementWaypointKey(current.waypoint) === skipUntilKey) skipUntilKey = "";
        continue;
      }
      const pairs = getMovementStealthPairs(tokenDocument, previous, current, pairDescriptors);
      const movementCost = getStealthMovementSegmentCost(tokenDocument, previous, current);

      for (const pair of pairs) {
        const stateKey = getDetectionMovementStateKey(pair);
        const wasInside = routeInsideState.has(stateKey)
          ? routeInsideState.get(stateKey)
          : isPointInsideObserverZone(pair.previous.hiddenPoint, pair.observerToken, pair.previous.observerOrigin);
        const isInside = isPointInsideObserverZone(pair.current.hiddenPoint, pair.observerToken, pair.current.observerOrigin);
        routeInsideState.set(stateKey, isInside);
        const hadState = detectionMovementState.has(stateKey);

        if (!isInside) {
          detectionMovementState.delete(stateKey);
          continue;
        }

        if (!wasInside && !hadState) {
          detectionMovementState.set(stateKey, 0);
          return [createStealthMovementEvent(pair, current, segmentSamples, segmentIndex, samples, index, routeOrder, "enter")];
        }

        const accumulated = Math.max(0, Number(detectionMovementState.get(stateKey)) || 0) + movementCost;
        if (accumulated >= movementThreshold) {
          detectionMovementState.set(stateKey, accumulated % movementThreshold);
          return [createStealthMovementEvent(pair, current, segmentSamples, segmentIndex, samples, index, routeOrder, "inside")];
        }
        detectionMovementState.set(stateKey, accumulated);
      }
    }
  }
  return [];
}

function getStealthMovementSegmentSamples(tokenDocument, previous, current) {
  const start = previous?.point;
  const end = current?.point;
  if (!start || !end || canvas.grid?.isGridless || typeof canvas.grid?.getDirectPath !== "function") {
    return getMovementSegmentSamples(tokenDocument, previous, current);
  }

  const path = canvas.grid.getDirectPath([start, end]);
  if (!Array.isArray(path) || path.length < 2) return [previous, current].filter(Boolean);

  const samples = [previous];
  const seen = new Set([getMovementWaypointKey(previous.waypoint)]);
  for (const offset of path.slice(1)) {
    const point = normalizePoint(canvas.grid.getCenterPoint(offset), tokenDocument.elevation);
    const waypoint = createSnappedWaypointAtTokenCenter(tokenDocument, point, current.waypoint);
    const key = getMovementWaypointKey(waypoint);
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({ waypoint, point: getTokenCenterAt(tokenDocument, waypoint) ?? point });
  }
  return samples.filter(sample => sample?.point);
}

async function executeStealthMovementInterruption({ tokenDocument, movement, event } = {}) {
  const hiddenTokenDocument = await fromUuid(String(event?.hiddenTokenUuid ?? ""));
  const observerTokenDocument = await fromUuid(String(event?.observerTokenUuid ?? ""));
  const hiddenToken = hiddenTokenDocument?.object ?? hiddenTokenDocument;
  const observerToken = observerTokenDocument?.object ?? observerTokenDocument;
  if (!hiddenToken?.actor || !observerToken?.actor || !isActorStealthed(hiddenToken.actor)) {
    return resumeUninterruptedStealthMovement(tokenDocument, movement, event);
  }

  const outcome = await rollStealthCheck(hiddenToken, observerToken, null, { animate: false });
  const revealed = !isActorStealthed(hiddenToken.actor) || isStealthCheckFailure(outcome);
  if (revealed) {
    await moveTokenToStealthInterruption(tokenDocument, event.waypoint, movement);
    pauseGameForStealthDetection();
    return false;
  }
  return resumeUninterruptedStealthMovement(tokenDocument, movement, event);
}

async function resumeStealthInterruptedMovement(tokenDocument, movement, event = {}) {
  const waypoints = Array.isArray(event.remainingWaypoints) ? event.remainingWaypoints : [];
  if (!tokenDocument || !waypoints.length) return false;
  const options = {
    method: movement?.method,
    autoRotate: Boolean(movement?.autoRotate),
    showRuler: Boolean(movement?.showRuler),
    terrainOptions: movement?.terrainOptions,
    constrainOptions: movement?.constrainOptions,
    measureOptions: movement?.measureOptions
  };
  if (event.skipStealthDetectionUntil) {
    options[STEALTH_DETECTION_SKIP_UNTIL_OPTION] = getMovementWaypointKey(event.skipStealthDetectionUntil);
  }
  return tokenDocument.move(waypoints, options);
}

async function resumeUninterruptedStealthMovement(tokenDocument, movement, event = {}) {
  const waypoints = getOriginalMovementWaypoints(movement);
  if (!waypoints.length) return false;
  return resumeStealthInterruptedMovement(tokenDocument, movement, {
    remainingWaypoints: waypoints,
    skipStealthDetectionUntil: event.waypoint
  });
}

function getOriginalMovementWaypoints(movement = {}) {
  const waypoints = [
    ...(movement.passed?.waypoints ?? []),
    movement.destination
  ].filter(Boolean);
  const result = [];
  const seen = new Set();
  for (const waypoint of waypoints) {
    if (waypoint.intermediate) continue;
    const key = getMovementWaypointKey(waypoint);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...waypoint });
  }
  return result;
}

async function moveTokenToStealthInterruption(tokenDocument, waypoint = {}, movement = {}) {
  if (!tokenDocument || !waypoint) return false;
  await tokenDocument.move([{ ...waypoint, checkpoint: true }], {
    [CONTROLLED_MOVEMENT_INTERRUPTION_OPTION]: true,
    method: movement?.method,
    autoRotate: Boolean(movement?.autoRotate),
    showRuler: false
  });
  try {
    await (tokenDocument?.movement?.animation?.ended ?? tokenDocument?.object?.movementAnimationPromise);
  } catch (_error) {
    // Movement can be superseded by another controlled interruption.
  }
  return true;
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
  });
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function getMovementStealthPairDescriptors(tokenDocument) {
  const movingToken = tokenDocument?.object;
  if (!movingToken?.actor) return [];
  const descriptors = [];

  if (isActorStealthed(movingToken.actor)) {
    for (const observerToken of canvas.tokens?.placeables ?? []) {
      if (!isValidStealthObserver(movingToken, observerToken)) continue;
      descriptors.push({
        mode: "hiddenMoving",
        hiddenToken: movingToken,
        observerToken
      });
    }
  }

  for (const hiddenToken of canvas.tokens?.placeables ?? []) {
    if (hiddenToken.id === movingToken.id || !isActorStealthed(hiddenToken.actor)) continue;
    if (!isValidStealthObserver(hiddenToken, movingToken)) continue;
    descriptors.push({
      mode: "observerMoving",
      hiddenToken,
      observerToken: movingToken
    });
  }

  return descriptors;
}

function getMovementStealthPairs(tokenDocument, previous, current, descriptors = []) {
  const pairs = [];
  const previousPoint = normalizePoint(previous?.point, tokenDocument.elevation);
  const currentPoint = normalizePoint(current?.point, tokenDocument.elevation);

  for (const descriptor of descriptors) {
    if (descriptor.mode === "hiddenMoving") {
      const observerOrigin = getTokenCenter(descriptor.observerToken);
      pairs.push({
        ...descriptor,
        previous: { hiddenPoint: previousPoint, observerOrigin },
        current: { hiddenPoint: currentPoint, observerOrigin }
      });
    } else if (descriptor.mode === "observerMoving") {
      const hiddenPoint = getTokenCenter(descriptor.hiddenToken);
      pairs.push({
        ...descriptor,
        previous: { hiddenPoint, observerOrigin: previousPoint },
        current: { hiddenPoint, observerOrigin: currentPoint }
      });
    }
  }

  return pairs;
}

function createStealthMovementEvent(pair, current, segmentSamples, segmentIndex, routeSamples, routeIndex, routeOrder, type) {
  return {
    type,
    eventId: `${type}:${pair.hiddenToken.id}:${pair.observerToken.id}:${routeOrder}`,
    routeOrder,
    priority: STEALTH_DETECTION_PRIORITY,
    mode: pair.mode,
    moveToWaypoint: false,
    waypoint: current.waypoint,
    hiddenTokenUuid: pair.hiddenToken.document?.uuid ?? pair.hiddenToken.uuid,
    observerTokenUuid: pair.observerToken.document?.uuid ?? pair.observerToken.uuid,
    remainingWaypoints: buildRemainingMovementWaypoints(segmentSamples, segmentIndex, routeSamples, routeIndex)
  };
}

function buildRemainingMovementWaypoints(segmentSamples = [], segmentIndex = 0, routeSamples = [], routeIndex = 0) {
  const waypoints = [
    ...segmentSamples.slice(segmentIndex + 1).map(sample => sample?.waypoint),
    ...routeSamples.slice(routeIndex + 1).map(sample => sample?.waypoint)
  ].filter(Boolean);
  const result = [];
  const seen = new Set();
  for (const waypoint of waypoints) {
    const key = getMovementWaypointKey(waypoint);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...waypoint, checkpoint: true });
  }
  return result;
}

function getMovementWaypointKey(waypoint = {}) {
  return [
    Math.round(Number(waypoint.x) || 0),
    Math.round(Number(waypoint.y) || 0),
    Math.round(Number(waypoint.elevation) || 0)
  ].join(":");
}

function isPointInsideObserverZone(point, observerToken, observerOrigin) {
  return testStealthDetectionPoint(observerToken, observerOrigin, point);
}

function getStealthMovementSegmentCost(tokenDocument, previous, current) {
  const start = previous?.point;
  const end = current?.point;
  if (!start || !end) return 0;
  const distance = pixelsToSceneDistance(Math.hypot(end.x - start.x, end.y - start.y));
  return applyCombatMovementCostModifier(tokenDocument?.actor, Math.ceil(distance));
}

function evaluateAutoDetectionMovementThreshold(actor, settings = getStealthSettings()) {
  const resources = actor?.system?.resources ?? {};
  const variables = {
    actionPointsMax: Math.max(0, Number(resources[ACTION_RESOURCE_KEY]?.max) || 0),
    movementPointsMax: Math.max(0, Number(resources[MOVEMENT_RESOURCE_KEY]?.max) || 0)
  };
  variables["ОД"] = variables.actionPointsMax;
  variables["ОП"] = variables.movementPointsMax;
  try {
    return Math.max(1, evaluateFormulaVariables(settings.autoDetection?.movementThresholdFormula ?? "1", variables));
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Stealth auto-detection movement threshold formula failed: ${error.message}`);
    return 1;
  }
}

function getDetectionMovementStateKey(pair) {
  return [
    canvas?.scene?.id ?? "",
    pair.hiddenToken?.id ?? "",
    pair.observerToken?.id ?? ""
  ].join(":");
}

function analyzeTokenLighting(token) {
  const settings = getStealthSettings();
  const samples = getTokenLightingPoints(token).map(point => analyzeLightingPoint(point));
  const brightest = samples.reduce(
    (best, sample) => sample.effectiveDarkness < best.effectiveDarkness ? sample : best,
    samples[0] ?? analyzeLightingPoint(getTokenCenter(token))
  );
  const effectiveDarkness = brightest.effectiveDarkness;
  const modifiers = calculateLightingModifiers(effectiveDarkness, settings);
  return {
    effectiveDarkness,
    darknessLabel: effectiveDarkness.toFixed(2),
    darknessPercent: Math.round(effectiveDarkness * 100),
    condition: modifiers.condition,
    modifiers
  };
}

export function analyzeLightingPoint(point) {
  const elevatedPoint = {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    elevation: Number(point?.elevation) || 0
  };
  const baseDarkness = clampNumber(
    canvas?.effects?.getDarknessLevel?.(elevatedPoint) ?? canvas?.environment?.darknessLevel ?? canvas?.scene?.environment?.darknessLevel ?? 0,
    0,
    1
  );
  const darknessSourcePenalty = canvas?.effects?.testInsideDarkness?.(elevatedPoint) ? 1 : baseDarkness;
  const lightIntensity = getPointLightIntensity(elevatedPoint, baseDarkness);
  return {
    baseDarkness,
    effectiveDarkness: clampNumber(Math.max(baseDarkness, darknessSourcePenalty) - lightIntensity, 0, 1),
    lightIntensity
  };
}

function calculateLightingModifiersLegacy(effectiveDarkness, settings = getStealthSettings()) {
  const entry = getStealthDifficultyLevel(effectiveDarkness, settings);
  const level = getLightLevelKeyLegacy(effectiveDarkness, settings);
  return {
    difficultyBonus: Number(entry?.difficultyBonus) || 0,
    perceptionMultiplier: Math.max(1, Number(entry?.perceptionMultiplier) || 1),
    radius: Math.max(0, Number(entry?.radius) || 0),
    condition: STEALTH_LIGHT_LEVELS.find(item => item.key === level)?.label ?? "Темнота"
  };
}

function calculateStealthRadiusLegacy(effectiveDarkness, settings = getStealthSettings()) {
  const key = getLightLevelKey(effectiveDarkness, settings);
  return Math.max(0, Number(settings[key]?.radius) || 0);
}

function getLightLevelKeyLegacy(effectiveDarkness, settings = getStealthSettings()) {
  const thresholds = settings.thresholds;
  if (effectiveDarkness <= thresholds.veryBrightMax) return "veryBright";
  if (effectiveDarkness <= thresholds.brightMax) return "bright";
  if (effectiveDarkness <= thresholds.dimMax) return "dim";
  return "dark";
}

function calculateLightingModifiers(effectiveDarkness, settings = getStealthSettings()) {
  const entry = getStealthDifficultyLevel(effectiveDarkness, settings);
  return {
    difficultyBonus: Number(entry?.difficultyBonus) || 0,
    perceptionMultiplier: 1,
    radius: 0,
    threshold: Number(entry?.threshold) || 0,
    condition: `Темнота ${Number(entry?.threshold ?? 0).toFixed(2)}`
  };
}

function calculateStealthRadius(_effectiveDarkness, settings = getStealthSettings(), actor = null) {
  return evaluateStealthDetectionRange(actor, settings);
}

function getLightLevelKey(effectiveDarkness, settings = getStealthSettings()) {
  const threshold = Number(getStealthDifficultyLevel(effectiveDarkness, settings)?.threshold) || 0;
  if (threshold >= 1) return "blackout";
  if (threshold >= 0.75) return "dark";
  if (threshold >= 0.5) return "dim";
  if (threshold >= 0.2) return "shadow";
  return "normal";
}

function applyDistanceFalloff(modifiers, distance, settings = getStealthSettings()) {
  if (!Number.isFinite(distance)) return modifiers;
  const levels = STEALTH_LIGHT_LEVELS.map(level => ({
    ...level,
    radius: Math.max(0, Number(settings[level.key]?.radius) || 0),
    modifiers: calculateLightingModifiers(getRepresentativeDarkness(level.key, settings), settings)
  }));
  const index = levels.findIndex(level => level.key === getLightLevelKeyFromCondition(modifiers.condition));
  if (index < 0 || index >= levels.length - 1) return modifiers;

  const current = levels[index];
  const next = levels[index + 1];
  const fadeStart = Math.min(current.radius, next.radius);
  const fadeEnd = current.radius;
  if (fadeEnd <= 0 || distance <= fadeStart) return modifiers;
  if (distance >= fadeEnd) return next.modifiers;
  const ratio = (distance - fadeStart) / Math.max(1, fadeEnd - fadeStart);
  return {
    ...modifiers,
    difficultyBonus: Math.round(lerp(current.modifiers.difficultyBonus, next.modifiers.difficultyBonus, ratio)),
    perceptionMultiplier: Math.round(lerp(current.modifiers.perceptionMultiplier, next.modifiers.perceptionMultiplier, ratio))
  };
}

function getLightLevelKeyFromCondition(condition) {
  return STEALTH_LIGHT_LEVELS.find(level => level.label === condition)?.key ?? "dark";
}

function getRepresentativeDarkness(key, settings) {
  if (key === "veryBright") return settings.thresholds.veryBrightMax / 2;
  if (key === "bright") return (settings.thresholds.veryBrightMax + settings.thresholds.brightMax) / 2;
  if (key === "dim") return (settings.thresholds.brightMax + settings.thresholds.dimMax) / 2;
  return (settings.thresholds.dimMax + 1) / 2;
}

function getPointLightIntensity(point, baseDarkness) {
  let intensity = getGlobalLightIntensity(point, baseDarkness);
  const lightSources = canvas?.effects?.lightSources;
  for (const source of lightSources?.values?.() ?? lightSources ?? []) {
    if (!source?.active || isGlobalLightSource(source)) continue;
    if (!source.testPoint?.(point)) continue;
    intensity = Math.max(intensity, getLocalLightIntensity(source, point));
  }
  return clampNumber(intensity, 0, 1);
}

function getGlobalLightIntensity(point, baseDarkness) {
  const globalLightSource = canvas?.environment?.globalLightSource;
  if (!globalLightSource?.active) return 0;
  const darkness = globalLightSource.data?.darkness ?? {};
  const minimum = Number(darkness.min) || 0;
  const maximum = Number.isFinite(Number(darkness.max)) ? Number(darkness.max) : 1;
  if (baseDarkness < minimum || baseDarkness > maximum) return 0;
  return canvas?.effects?.testInsideLight?.(point, { condition: source => isGlobalLightSource(source) }) ? 1 : 0;
}

function getLocalLightIntensity(source, point) {
  const origin = source.origin ?? source;
  const distance = Math.hypot(point.x - (Number(origin.x) || 0), point.y - (Number(origin.y) || 0));
  const brightRadius = Math.max(0, Number(source.data?.bright) || 0);
  const dimRadius = Math.max(brightRadius, Number(source.data?.dim) || Number(source.data?.radius) || 0);
  if (brightRadius > 0 && distance <= brightRadius) return 1;
  if (dimRadius <= 0 || distance > dimRadius) return 0;
  if (dimRadius <= brightRadius) return 0.5;
  const ratio = clampNumber((distance - brightRadius) / Math.max(1, dimRadius - brightRadius), 0, 1);
  return 0.5 + ((1 - ratio) * 0.5);
}

function isGlobalLightSource(source) {
  return source?.constructor?.name === "GlobalLightSource" || source?.name === "GlobalLight";
}

function updateDetectionVisualization(token) {
  if (!token?.id || !canvas?.controls) return;
  removeDetectionVisualization(token.id);
  const zones = getStealthObserverZones(token, { visibleOnly: true });
  if (!zones.length) return;

  const layer = getDetectionLayer();
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
  layer.addChild(container);
  detectionVisualizations.set(token.id, { container, zones });
  refreshDetectionHoverFill();
}

function removeDetectionVisualization(tokenId) {
  const visualization = detectionVisualizations.get(tokenId);
  if (!visualization) return;
  visualization.container?.destroy?.({ children: true });
  detectionVisualizations.delete(tokenId);
  refreshDetectionHoverFill();
}

function getDetectionLayer() {
  canvas.controls[STEALTH_DETECTION_LAYER] ??= canvas.controls.addChild(new PIXI.Container());
  canvas.controls[STEALTH_DETECTION_LAYER].eventMode = "none";
  canvas.controls[STEALTH_DETECTION_LAYER].interactiveChildren = false;
  return canvas.controls[STEALTH_DETECTION_LAYER];
}

function onTokenHoverForDetectionZone(token, hovered) {
  if (!token?.id) return;
  if (hovered) detectionHoverTokenId = token.id;
  else if (detectionHoverTokenId === token.id) detectionHoverTokenId = null;
  refreshDetectionHoverFill();
}

function refreshDetectionHoverFill() {
  clearDetectionHoverFill();
  if (!detectionHoverTokenId || !detectionVisualizations.size || !canvas?.interface?.grid || canvas.grid?.isGridless) return;

  const zones = [];
  for (const visualization of detectionVisualizations.values()) {
    for (const zone of visualization.zones ?? []) {
      if (zone.observerToken?.id === detectionHoverTokenId) zones.push(zone);
    }
  }
  if (!zones.length) return;

  const layer = canvas.interface.grid.addHighlightLayer(STEALTH_DETECTION_HOVER_LAYER);
  layer.eventMode = "none";
  layer.interactiveChildren = false;
  for (const zone of zones) {
    for (const offset of zone.offsets) drawGridCellHighlight(layer, offset);
  }
}

function clearDetectionHoverFill() {
  canvas?.interface?.grid?.clearHighlightLayer?.(STEALTH_DETECTION_HOVER_LAYER);
}

function drawGridCellHighlight(layer, offset) {
  const key = `${Math.round(Number(offset?.i) || 0)},${Math.round(Number(offset?.j) || 0)}`;
  if (layer.positions?.has(key)) return;
  const vertices = canvas.grid?.getVertices?.(offset) ?? [];
  if (vertices.length < 3) return;
  layer.beginTextureFill({
    texture: PIXI.Texture.WHITE,
    color: 0xff3b3b,
    alpha: 0.14,
    smooth: !canvas.grid?.isSquare
  });
  layer.drawPolygon(vertices);
  layer.endFill();
  layer.positions?.add(key);
}

function drawGridZoneOutline(graphics, zone) {
  graphics.lineStyle(2, 0xff3b3b, 0.85);
  for (const offset of zone.offsets) {
    for (const edge of getExposedGridCellEdges(offset, zone.cells)) {
      graphics.moveTo(edge.start.x, edge.start.y);
      graphics.lineTo(edge.end.x, edge.end.y);
    }
  }
}

function getExposedGridCellEdges(offset, cells) {
  const vertices = canvas.grid.getVertices(offset);
  if (vertices.length !== 4 || !canvas.grid?.isSquare) return getGenericExposedGridCellEdges(offset, vertices, cells);
  const { i, j } = offset;
  return [
    { key: getGridOffsetKey({ i: i - 1, j }), start: vertices[0], end: vertices[1] },
    { key: getGridOffsetKey({ i, j: j + 1 }), start: vertices[1], end: vertices[2] },
    { key: getGridOffsetKey({ i: i + 1, j }), start: vertices[2], end: vertices[3] },
    { key: getGridOffsetKey({ i, j: j - 1 }), start: vertices[3], end: vertices[0] }
  ].filter(edge => !cells.has(edge.key));
}

function getGenericExposedGridCellEdges(offset, vertices, cells) {
  const adjacent = new Set((canvas.grid?.getAdjacentOffsets?.(offset) ?? []).map(getGridOffsetKey));
  if ([...adjacent].some(key => cells.has(key))) return [];
  const edges = [];
  for (let index = 0; index < vertices.length; index += 1) {
    edges.push({
      start: vertices[index],
      end: vertices[(index + 1) % vertices.length]
    });
  }
  return edges;
}

function getStealthObserverZones(hiddenToken, { visibleOnly = false } = {}) {
  if (!hiddenToken?.actor || !canvas?.ready) return [];
  const zones = [];
  for (const observerToken of canvas.tokens?.placeables ?? []) {
    if (!isValidStealthObserver(hiddenToken, observerToken)) continue;
    if (visibleOnly && !canTokenPhysicallySeeTarget(hiddenToken, observerToken)) continue;
    const zone = buildObserverDetectionZone(observerToken);
    if (!zone?.cells?.size) continue;
    zones.push({ hiddenToken, observerToken, ...zone });
  }
  return zones;
}

function buildObserverDetectionZone(observerToken, { origin = null } = {}) {
  if (!observerToken?.actor || !canvas?.ready) return null;
  if (canvas.grid?.isGridless) return null;
  const settings = getStealthSettings();
  const maxRange = evaluateStealthDetectionRange(observerToken.actor, settings);
  const maxPixels = sceneDistanceToPixels(maxRange);
  if (maxPixels <= 0) return null;

  const center = normalizePoint(origin ?? getTokenCenter(observerToken), observerToken.document?.elevation);
  const cacheKey = getDetectionZoneCacheKey(observerToken, center, settings, maxRange);
  const cached = detectionZoneCache.get(cacheKey);
  if (cached) return cached;

  const bounds = new PIXI.Rectangle(center.x - maxPixels, center.y - maxPixels, maxPixels * 2, maxPixels * 2)
    .fit(canvas.dimensions?.rect ?? new PIXI.Rectangle(0, 0, canvas.dimensions?.width ?? Infinity, canvas.dimensions?.height ?? Infinity));
  const [i0, j0, i1, j1] = canvas.grid.getOffsetRange(bounds);
  const offsets = [];
  const cells = new Set();

  for (let i = i0; i < i1; i += 1) {
    for (let j = j0; j < j1; j += 1) {
      const offset = { i, j };
      const point = normalizePoint(canvas.grid.getCenterPoint(offset), center.elevation);
      if (Math.hypot(point.x - center.x, point.y - center.y) > maxPixels + (canvas.grid.size / 2)) continue;
      if (observerToken.checkCollision?.(point, { origin: center, type: "sight", mode: "any" })) continue;
      if (computeDetectionPathCost(observerToken, center, point, settings) > maxRange) continue;
      offsets.push(offset);
      cells.add(getGridOffsetKey(offset));
    }
  }

  const zone = { cells, offsets, origin: center, range: maxRange };
  detectionZoneCache.set(cacheKey, zone);
  trimCacheMap(detectionZoneCache, STEALTH_DETECTION_CACHE_LIMIT);
  return zone;
}

function computeDetectionPathCost(observerToken, origin, destination, settings) {
  const distancePixels = Math.hypot(destination.x - origin.x, destination.y - origin.y);
  if (distancePixels <= 0) return 0;
  const unaidedSightRange = getObserverUnaidedSightRange(observerToken);
  if (unaidedSightRange === Infinity) return pixelsToSceneDistance(distancePixels);
  const stepPixels = Math.max(1, Number(canvas.grid?.size) || 100);
  const steps = Math.max(1, Math.ceil(distancePixels / stepPixels));
  let consumed = 0;
  let last = origin;

  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    const point = {
      x: origin.x + ((destination.x - origin.x) * ratio),
      y: origin.y + ((destination.y - origin.y) * ratio),
      elevation: origin.elevation
    };
    const segmentPixels = Math.hypot(point.x - last.x, point.y - last.y);
    const startDistance = pixelsToSceneDistance(Math.hypot(last.x - origin.x, last.y - origin.y));
    const endDistance = pixelsToSceneDistance(Math.hypot(point.x - origin.x, point.y - origin.y));
    const distanceDelta = Math.max(0.0001, endDistance - startDistance);
    const unaidedRatio = clampNumber((unaidedSightRange - startDistance) / distanceDelta, 0, 1);
    const unaidedPixels = segmentPixels * unaidedRatio;
    const attenuatedPixels = Math.max(0, segmentPixels - unaidedPixels);
    consumed += pixelsToSceneDistance(unaidedPixels);
    if (attenuatedPixels > 0) {
      const factor = getDetectionRangeFactor(analyzeLightingPoint(point).effectiveDarkness, settings);
      consumed += pixelsToSceneDistance(attenuatedPixels) / Math.max(0.01, factor);
    }
    last = point;
  }
  return consumed;
}

function testStealthDetectionPoint(observerToken, observerOrigin, targetPoint) {
  if (!observerToken?.actor || !targetPoint || !canvas?.ready) return false;
  const settings = getStealthSettings();
  const origin = normalizePoint(observerOrigin ?? getTokenCenter(observerToken), observerToken.document?.elevation);
  let point = normalizePoint(targetPoint, origin.elevation);
  if (!canvas.grid?.isGridless && canvas.grid?.getOffset && canvas.grid?.getCenterPoint) {
    point = normalizePoint(canvas.grid.getCenterPoint(canvas.grid.getOffset(point)), origin.elevation);
  }
  const maxRange = evaluateStealthDetectionRange(observerToken.actor, settings);
  if (maxRange <= 0) return false;
  const cacheKey = getDetectionPointCacheKey(observerToken, origin, point, settings, maxRange);
  if (detectionPointCache.has(cacheKey)) return detectionPointCache.get(cacheKey);
  const maxPixels = sceneDistanceToPixels(maxRange);
  let result = true;
  if (Math.hypot(point.x - origin.x, point.y - origin.y) > maxPixels + (Number(canvas.grid?.size) || 0)) result = false;
  else if (observerToken.checkCollision?.(point, { origin, type: "sight", mode: "any" })) result = false;
  else result = computeDetectionPathCost(observerToken, origin, point, settings) <= maxRange;
  detectionPointCache.set(cacheKey, result);
  trimCacheMap(detectionPointCache, STEALTH_DETECTION_CACHE_LIMIT * 4);
  return result;
}

function getDetectionRangeFactor(effectiveDarkness, settings = getStealthSettings()) {
  const levels = Array.isArray(settings.attenuationLevels) ? settings.attenuationLevels : [];
  const level = levels.find(entry => effectiveDarkness >= Number(entry.threshold));
  const penalty = clampNumber(level?.penaltyPercent ?? 0, 0, 100);
  return Math.max(0.01, 1 - (penalty / 100));
}

function getStealthDifficultyLevel(effectiveDarkness, settings = getStealthSettings()) {
  const levels = Array.isArray(settings.difficultyLevels) ? settings.difficultyLevels : [];
  return levels.find(entry => effectiveDarkness >= Number(entry.threshold))
    ?? levels.at(-1)
    ?? { threshold: 0, difficultyBonus: 0 };
}

function getDetectionZoneCacheKey(observerToken, origin, settings, maxRange) {
  const offset = canvas.grid?.getOffset?.(origin) ?? { i: Math.round(origin.y), j: Math.round(origin.x) };
  return [
    canvas.scene?.id ?? "",
    observerToken.id ?? "",
    getGridOffsetKey(offset),
    Math.round(Number(origin.elevation) || 0),
    Math.round(maxRange * 100),
    normalizeRangeCachePart(getObserverUnaidedSightRange(observerToken)),
    JSON.stringify(settings.attenuationLevels ?? [])
  ].join(":");
}

function getDetectionPointCacheKey(observerToken, origin, point, settings, maxRange) {
  const originOffset = canvas.grid?.getOffset?.(origin) ?? { i: Math.round(origin.y), j: Math.round(origin.x) };
  const pointOffset = canvas.grid?.getOffset?.(point) ?? { i: Math.round(point.y), j: Math.round(point.x) };
  return [
    canvas.scene?.id ?? "",
    observerToken.id ?? "",
    getGridOffsetKey(originOffset),
    getGridOffsetKey(pointOffset),
    Math.round(Number(origin.elevation) || 0),
    Math.round(Number(point.elevation) || 0),
    Math.round(maxRange * 100),
    normalizeRangeCachePart(getObserverUnaidedSightRange(observerToken)),
    JSON.stringify(settings.attenuationLevels ?? [])
  ].join(":");
}

function getObserverUnaidedSightRange(observerToken) {
  const document = observerToken?.document ?? observerToken;
  if (!observerToken?.hasSight || document?.sight?.enabled === false) return 0;
  const basicSight = document?.detectionModes?.basicSight;
  if (basicSight?.enabled === false) return 0;
  return normalizeSceneRange(basicSight?.range, normalizeSceneRange(document?.sight?.range, 0));
}

function normalizeSceneRange(value, fallback = 0) {
  if (value === null) return Infinity;
  const number = Number(value);
  if (number === Infinity) return Infinity;
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, number);
}

function normalizeRangeCachePart(value) {
  return value === Infinity ? "inf" : Math.round((Number(value) || 0) * 100);
}

function trimCacheMap(map, limit) {
  while (map.size > limit) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
}

function getGridOffsetKey(offset = {}) {
  return `${Math.round(Number(offset.i) || 0)}:${Math.round(Number(offset.j) || 0)}`;
}

function getTokenVisualizationGridKey(token) {
  const center = getTokenCenter(token);
  const offset = canvas.grid?.getOffset?.(center) ?? { i: Math.round(center.y), j: Math.round(center.x) };
  return [
    canvas.scene?.id ?? "",
    token?.id ?? "",
    getGridOffsetKey(offset),
    Math.round(Number(center.elevation) || 0)
  ].join(":");
}

function evaluateStealthDetectionRange(actor, settings = getStealthSettings()) {
  const skillKey = String(settings.detection?.skillKey ?? "naturalist");
  const skill = getActorSkillValue(actor, skillKey);
  try {
    return Math.max(0, evaluateFormula(settings.detection?.rangeFormula ?? "0", {
      variables: STEALTH_RANGE_FORMULA_VARIABLES,
      formulaVariables: { skill, навык: skill }
    }));
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Stealth detection range formula failed: ${error.message}`);
    return 0;
  }
}

function sceneDistanceToPixels(distance) {
  const gridDistance = Math.max(0.0001, Number(canvas?.scene?.grid?.distance ?? canvas?.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(canvas?.grid?.size) || 100);
  return Math.max(0, Number(distance) || 0) * (gridSize / gridDistance);
}

function measureTokenDistance(left, right) {
  const leftCenter = getTokenCenter(left);
  const rightCenter = getTokenCenter(right);
  return pixelsToSceneDistance(Math.hypot(rightCenter.x - leftCenter.x, rightCenter.y - leftCenter.y));
}

function pixelsToSceneDistance(pixels) {
  const gridDistance = Math.max(0.0001, Number(canvas?.scene?.grid?.distance ?? canvas?.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(canvas?.grid?.size) || 100);
  return Math.max(0, Number(pixels) || 0) * (gridDistance / gridSize);
}

function getTokenAtClientPoint(event, excludedTokenId = "") {
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  return [...(canvas.tokens?.placeables ?? [])]
    .filter(token => token.id !== excludedTokenId && token.actor && token.visible !== false && token.renderable !== false)
    .sort((left, right) => (right._lastSortedIndex ?? 0) - (left._lastSortedIndex ?? 0))
    .find(token => token.bounds?.contains?.(point.x, point.y) || token.hitArea?.contains?.(point.x - token.x, point.y - token.y)) ?? null;
}

function getTokenCenter(token) {
  const center = token?.document?.getCenterPoint?.() ?? token?.center ?? {
    x: Number(token?.document?.x) || 0,
    y: Number(token?.document?.y) || 0
  };
  return {
    x: center.x,
    y: center.y,
    elevation: Number(center.elevation ?? token?.document?.elevation) || 0
  };
}

function getTokenLightingPoints(token) {
  const points = token?.document?.getVisibilityTestPoints?.();
  if (Array.isArray(points) && points.length) return points;
  return [getTokenCenter(token)];
}

function isValidStealthObserver(hiddenToken, observerToken) {
  if (!hiddenToken?.actor || !observerToken?.actor) return false;
  if (hiddenToken.id === observerToken.id) return false;
  if (hiddenToken.actor.uuid === observerToken.actor.uuid) return false;
  return !areActorsStealthAlliesCached(hiddenToken.actor, observerToken.actor);
}

function areActorsStealthAlliesCached(hiddenActor, observerActor) {
  const key = `${hiddenActor?.uuid ?? ""}|${observerActor?.uuid ?? ""}`;
  if (stealthAllyVisibilityCache.has(key)) return stealthAllyVisibilityCache.get(key);
  const result = areActorsStealthAllies(hiddenActor, observerActor);
  stealthAllyVisibilityCache.set(key, result);
  trimCacheMap(stealthAllyVisibilityCache, STEALTH_DETECTION_CACHE_LIMIT * 4);
  return result;
}

function areActorsStealthAllies(hiddenActor, observerActor) {
  const hiddenFactions = getEffectiveActorFactions(hiddenActor);
  const observerFactions = getEffectiveActorFactions(observerActor);
  if (hiddenFactions.some(faction => observerFactions.includes(faction))) return true;

  for (const hiddenFaction of hiddenFactions) {
    if (hiddenFaction === DEFAULT_FACTION_NAME) continue;
    if (getRelationTo(observerActor, hiddenFaction) === "ally") return true;
    for (const observerFaction of observerFactions) {
      if (observerFaction === DEFAULT_FACTION_NAME) continue;
      if (getRelationFromScore(getFactionScore(observerFaction, hiddenFaction)) === "ally") return true;
    }
  }
  return false;
}

function getEffectiveActorFactions(actor) {
  return getActorFactionBelongs(actor).filter(faction => faction && faction !== DEFAULT_FACTION_NAME);
}

function clearDetectionMovementStateForActor(actor) {
  if (!actor?.uuid) return;
  const tokenIds = new Set((canvas?.tokens?.placeables ?? [])
    .filter(token => token.actor?.uuid === actor.uuid)
    .map(token => token.id));
  for (const tokenId of tokenIds) clearDetectionMovementStateForToken(tokenId);
}

function clearDetectionMovementStateForToken(tokenId) {
  if (!tokenId) return;
  for (const key of [...detectionMovementState.keys()]) {
    if (key.includes(`:${tokenId}:`) || key.endsWith(`:${tokenId}`)) detectionMovementState.delete(key);
  }
}

function normalizePoint(point, elevation = 0) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    elevation: Number(point?.elevation ?? elevation) || 0
  };
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

function getActorSkillValue(actor, key) {
  return Math.max(0, Number(actor?.system?.skills?.[key]?.value) || 0);
}

function getActorCharacteristicValue(actor, key) {
  return Number(actor?.system?.characteristics?.[key]) || 0;
}

function canControlStealth(actor) {
  return Boolean(game.user?.isGM || actor?.testUserPermission?.(game.user, "OWNER"));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function lerp(left, right, ratio) {
  const clamped = clampNumber(ratio, 0, 1);
  return left + ((right - left) * clamped);
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
