import { registerQueuedWorldTimeProcessor } from "./world-time-queue.mjs";

const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
const MAX_DARKNESS_ANIMATION_MS = 1500;
const MIN_DARKNESS_ANIMATION_MS = 500;
const DARKNESS_UPDATE_EPSILON = 0.01;
const NIGHT_DARKNESS_SCHEDULE = Object.freeze([
  Object.freeze({ hour: 0, darkness: 1 }),
  Object.freeze({ hour: 4, darkness: 1 }),
  Object.freeze({ hour: 6, darkness: 0.7 }),
  Object.freeze({ hour: 12, darkness: 0 }),
  Object.freeze({ hour: 16, darkness: 0 }),
  Object.freeze({ hour: 24, darkness: 1 })
]);

let hooksRegistered = false;

export function registerDynamicLightingHooks() {
  if (hooksRegistered) return;
  registerQueuedWorldTimeProcessor(processDynamicLightingWorldTime, { priority: -50 });
  Hooks.on("canvasReady", () => void syncCurrentSceneDarkness());
  hooksRegistered = true;
}

async function processDynamicLightingWorldTime(worldTime) {
  await syncCurrentSceneDarkness(worldTime);
}

async function syncCurrentSceneDarkness(worldTime = Number(game.time?.worldTime) || 0) {
  if (!game.user?.isActiveGM) return;
  const scene = getCurrentScene();
  if (!scene) return;
  if (scene.environment?.darknessLock) return;
  if (!scene.canUserModify?.(game.user, "update")) return;

  const targetDarkness = calculateWorldTimeDarkness(worldTime);
  const currentDarkness = clampAlpha(scene.environment?.darknessLevel);
  const difference = Math.abs(targetDarkness - currentDarkness);
  if (difference <= DARKNESS_UPDATE_EPSILON) return;

  await scene.update(
    { environment: { darknessLevel: targetDarkness } },
    {
      animateDarkness: getDarknessAnimationDuration(difference),
      falloutMawDynamicLighting: true
    }
  );
}

function getCurrentScene() {
  return canvas?.scene ?? game.scenes?.active ?? null;
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

function lerp(start, end, progress) {
  return (Number(start) || 0) + (((Number(end) || 0) - (Number(start) || 0)) * clampAlpha(progress));
}

function clampAlpha(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}
