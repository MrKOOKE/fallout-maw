const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
const MAX_DARKNESS_ANIMATION_MS = 1500;
const MIN_DARKNESS_ANIMATION_MS = 500;
const DARKNESS_UPDATE_EPSILON = 0.01;
const DARKNESS_ANIMATION_SETTLE_MS = 50;
const NIGHT_DARKNESS_SCHEDULE = Object.freeze([
  Object.freeze({ hour: 0, darkness: 1 }),
  Object.freeze({ hour: 4, darkness: 1 }),
  Object.freeze({ hour: 6, darkness: 0.7 }),
  Object.freeze({ hour: 12, darkness: 0 }),
  Object.freeze({ hour: 16, darkness: 0 }),
  Object.freeze({ hour: 24, darkness: 1 })
]);

let hooksRegistered = false;
let processingTransitions = false;
let lastQueuedSceneId = "";
let lastQueuedDarkness = null;
const pendingTransitions = [];

export function registerDynamicLightingHooks() {
  if (hooksRegistered) return;
  Hooks.on("updateWorldTime", enqueueDynamicLightingWorldTime);
  Hooks.on("canvasReady", () => {
    resetDynamicLightingTransitions();
    enqueueDynamicLightingWorldTime(Number(game.time?.worldTime) || 0);
  });
  Hooks.on("updateScene", (scene, changes, options) => {
    if (options?.falloutMawDynamicLighting) return;
    if (foundry.utils.hasProperty(changes ?? {}, "environment.darknessLevel")) resetDynamicLightingTransitions(scene?.id);
  });
  hooksRegistered = true;
}

function enqueueDynamicLightingWorldTime(worldTime) {
  if (!game.user?.isActiveGM) return;
  const scene = getCurrentScene();
  if (!canControlSceneDarkness(scene)) return;

  const targetDarkness = calculateWorldTimeDarkness(worldTime);
  const referenceDarkness = getQueuedReferenceDarkness(scene);
  if (Math.abs(targetDarkness - referenceDarkness) <= DARKNESS_UPDATE_EPSILON) return;

  pendingTransitions.push({
    sceneId: scene.id,
    targetDarkness
  });
  lastQueuedSceneId = scene.id;
  lastQueuedDarkness = targetDarkness;
  void processDynamicLightingTransitions();
}

async function processDynamicLightingTransitions() {
  if (processingTransitions) return;
  processingTransitions = true;
  try {
    while (pendingTransitions.length) {
      try {
        const transition = pendingTransitions.shift();
        const scene = getCurrentScene();
        if (!scene || scene.id !== transition.sceneId) continue;
        if (!canControlSceneDarkness(scene)) continue;

        const targetDarkness = clampAlpha(transition.targetDarkness);
        const currentDarkness = getDisplayedDarkness(scene);
        const difference = Math.abs(targetDarkness - currentDarkness);
        if (difference <= DARKNESS_UPDATE_EPSILON) continue;

        const duration = getDarknessAnimationDuration(difference);
        await scene.update(
          { environment: { darknessLevel: targetDarkness } },
          {
            animateDarkness: duration,
            falloutMawDynamicLighting: true
          }
        );
        await waitForDarknessAnimation(duration);
      } catch (error) {
        console.error("Fallout MaW | Dynamic lighting transition failed", error);
      }
    }
  } finally {
    processingTransitions = false;
    const scene = getCurrentScene();
    if (!pendingTransitions.length && scene) {
      lastQueuedSceneId = scene.id;
      lastQueuedDarkness = getDisplayedDarkness(scene);
    }
    if (pendingTransitions.length) void processDynamicLightingTransitions();
  }
}

function getCurrentScene() {
  return canvas?.scene ?? game.scenes?.active ?? null;
}

function canControlSceneDarkness(scene = null) {
  if (!scene) return false;
  if (scene.environment?.darknessLock) return false;
  return scene.canUserModify?.(game.user, "update") ?? false;
}

function getQueuedReferenceDarkness(scene = null) {
  if (lastQueuedSceneId === scene?.id && Number.isFinite(Number(lastQueuedDarkness))) return clampAlpha(lastQueuedDarkness);
  return getDisplayedDarkness(scene);
}

function getDisplayedDarkness(scene = null) {
  return clampAlpha(canvas?.scene?.id === scene?.id ? canvas?.environment?.darknessLevel : scene?.environment?.darknessLevel);
}

function resetDynamicLightingTransitions(sceneId = "") {
  if (!sceneId || sceneId === lastQueuedSceneId) {
    pendingTransitions.length = 0;
    lastQueuedSceneId = "";
    lastQueuedDarkness = null;
  }
}

export function calculateWorldTimeDarkness(worldTime = 0) {
  const hour = getWorldTimeDayHour(worldTime);
  for (let index = 0; index < NIGHT_DARKNESS_SCHEDULE.length - 1; index += 1) {
    const start = NIGHT_DARKNESS_SCHEDULE[index];
    const end = NIGHT_DARKNESS_SCHEDULE[index + 1];
    if (hour < start.hour || hour >= end.hour) continue;
    if (end.hour <= start.hour) return clampAlpha(end.darkness);
    const progress = (hour - start.hour) / (end.hour - start.hour);
    return clampAlpha(lerp(start.darkness, end.darkness, progress));
  }
  return clampAlpha(NIGHT_DARKNESS_SCHEDULE.at(-1)?.darkness);
}

function getWorldTimeDayHour(worldTime = 0) {
  const seconds = Number(worldTime) || 0;
  return modulo(seconds, DAY_SECONDS) / HOUR_SECONDS;
}

function getDarknessAnimationDuration(difference = 0) {
  const scaled = MIN_DARKNESS_ANIMATION_MS + Math.floor(clampAlpha(difference) * MAX_DARKNESS_ANIMATION_MS);
  return Math.min(scaled, MAX_DARKNESS_ANIMATION_MS);
}

function waitForDarknessAnimation(duration = 0) {
  return new Promise(resolve => globalThis.setTimeout(resolve, Math.max(0, Number(duration) || 0) + DARKNESS_ANIMATION_SETTLE_MS));
}

function lerp(start, end, progress) {
  return (Number(start) || 0) + (((Number(end) || 0) - (Number(start) || 0)) * clampAlpha(progress));
}

function clampAlpha(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}
