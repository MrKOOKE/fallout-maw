import { TEMPLATES } from "../constants.mjs";
import { getStealthSettings } from "../settings/accessors.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { STEALTH_LIGHT_LEVELS } from "./settings.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const STEALTH_STATUS_ID = "invisible";
const STEALTH_TARGET_TOOLTIP_ID = "fallout-maw-stealth-target-tooltip";

const stealthWindows = new Map();
const radiusVisualizations = new Map();
let targetMode = null;
let hooksRegistered = false;

export function registerStealthHooks() {
  if (hooksRegistered) return;
  Hooks.on("updateActor", actor => refreshStealthWindowsForActor(actor));
  Hooks.on("updateActiveEffect", effect => refreshStealthWindowsForActor(effect?.parent));
  Hooks.on("updateToken", onTokenUpdated);
  Hooks.on("deleteToken", tokenDocument => cleanupTokenStealth(tokenDocument?.id));
  Hooks.on("canvasReady", refreshAllStealthWindows);
  Hooks.on("canvasTearDown", cleanupAllStealthUi);
  Hooks.on("updateScene", refreshAllStealthWindows);
  Hooks.on("createAmbientLight", refreshAllStealthWindows);
  Hooks.on("updateAmbientLight", refreshAllStealthWindows);
  Hooks.on("deleteAmbientLight", refreshAllStealthWindows);
  Hooks.on("lightingRefresh", refreshAllStealthWindows);
  hooksRegistered = true;
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
  if (!active) {
    stopTargetingMode();
  }
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
  const rawTargetBase = settings.difficultyMode === "naturalist"
    ? Math.floor(getActorSkillValue(targetActor, "naturalist") / 10)
    : getActorCharacteristicValue(targetActor, "perception");
  const targetBase = Math.max(5, rawTargetBase);
  const distance = measureTokenDistance(sourceToken, targetToken);
  const blended = applyDistanceFalloff(modifiers, distance, settings);
  const baseDifficulty = Math.round(targetBase * blended.perceptionMultiplier);
  const difficulty = Math.round(baseDifficulty + blended.difficultyBonus);

  return {
    difficulty,
    baseDifficulty,
    targetBase,
    difficultyMode: settings.difficultyMode,
    distance,
    lighting: {
      ...lighting,
      modifiers: blended
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
    const radius = calculateStealthRadius(lighting.effectiveDarkness, getStealthSettings());
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
    if (context.stealthed) updateRadiusVisualization(this.token, context.radius);
    else removeRadiusVisualization(this.token?.id);
  }

  async _onClose(options) {
    await super._onClose(options);
    if (targetMode?.sourceTokenId === this.token?.id) stopTargetingMode();
    removeRadiusVisualization(this.token?.id);
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

async function rollStealthCheck(sourceToken, targetToken, app = null) {
  const difficulty = computeStealthDifficulty(sourceToken, targetToken);
  if (!difficulty) return undefined;
  const outcome = await requestSkillCheck({
    actor: sourceToken.actor,
    skillKey: "stealth",
    requester: "stealth",
    data: {
      difficulty: difficulty.difficulty,
      situationalModifier: 0
    }
  });
  const resultKey = String(outcome?.result?.key ?? "");
  if (["failure", "criticalFailure"].includes(resultKey) || outcome?.result?.autoFailure) {
    await toggleActorStealth(sourceToken.actor, false);
  }
  await app?.render({ force: true });
  return outcome;
}

function onTokenUpdated(tokenDocument, changes) {
  const token = tokenDocument?.object;
  const moved = Boolean(foundry.utils.hasProperty(changes, "x")
    || foundry.utils.hasProperty(changes, "y")
    || foundry.utils.hasProperty(changes, "elevation"));
  if (token && radiusVisualizations.has(token.id)) {
    const radius = radiusVisualizations.get(token.id)?.radius ?? calculateStealthRadius(analyzeTokenLighting(token).effectiveDarkness);
    updateRadiusVisualization(token, radius);
  }
  if (moved) refreshAllStealthWindows();
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

function cleanupTokenStealth(tokenId) {
  const app = stealthWindows.get(tokenId);
  if (app) void app.close();
  removeRadiusVisualization(tokenId);
  if (targetMode?.sourceTokenId === tokenId) stopTargetingMode();
}

function cleanupAllStealthUi() {
  stopTargetingMode();
  for (const app of stealthWindows.values()) void app.close();
  stealthWindows.clear();
  for (const tokenId of radiusVisualizations.keys()) removeRadiusVisualization(tokenId);
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

function analyzeLightingPoint(point) {
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

function calculateLightingModifiers(effectiveDarkness, settings = getStealthSettings()) {
  const level = getLightLevelKey(effectiveDarkness, settings);
  const entry = settings[level] ?? settings.dark;
  return {
    difficultyBonus: Number(entry?.difficultyBonus) || 0,
    perceptionMultiplier: Math.max(1, Number(entry?.perceptionMultiplier) || 1),
    radius: Math.max(0, Number(entry?.radius) || 0),
    condition: STEALTH_LIGHT_LEVELS.find(item => item.key === level)?.label ?? "Темнота"
  };
}

function calculateStealthRadius(effectiveDarkness, settings = getStealthSettings()) {
  const key = getLightLevelKey(effectiveDarkness, settings);
  return Math.max(0, Number(settings[key]?.radius) || 0);
}

function getLightLevelKey(effectiveDarkness, settings = getStealthSettings()) {
  const thresholds = settings.thresholds;
  if (effectiveDarkness <= thresholds.veryBrightMax) return "veryBright";
  if (effectiveDarkness <= thresholds.brightMax) return "bright";
  if (effectiveDarkness <= thresholds.dimMax) return "dim";
  return "dark";
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

function updateRadiusVisualization(token, radius) {
  if (!token?.id || !canvas?.controls) return;
  removeRadiusVisualization(token.id);
  const layer = getRadiusLayer();
  const graphics = new PIXI.Graphics();
  const radiusPixels = sceneDistanceToPixels(radius);
  graphics.lineStyle(2, 0xff3b3b, 0.85);
  graphics.beginFill(0xff3b3b, 0.08);
  graphics.drawCircle(0, 0, radiusPixels);
  graphics.endFill();
  graphics.position.set(token.center.x, token.center.y);
  layer.addChild(graphics);
  radiusVisualizations.set(token.id, { graphics, radius });
}

function removeRadiusVisualization(tokenId) {
  const visualization = radiusVisualizations.get(tokenId);
  if (!visualization) return;
  visualization.graphics?.destroy?.({ children: true });
  radiusVisualizations.delete(tokenId);
}

function getRadiusLayer() {
  canvas.controls.falloutMawStealthRadius ??= canvas.controls.addChild(new PIXI.Container());
  return canvas.controls.falloutMawStealthRadius;
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
