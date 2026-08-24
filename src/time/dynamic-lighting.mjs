const DEFAULT_HOURS_PER_DAY = 24;
const DEFAULT_MINUTES_PER_HOUR = 60;
const DEFAULT_SECONDS_PER_MINUTE = 60;
const DEFAULT_TWILIGHT_HOURS = 2;
const DARKNESS_UPDATE_EPSILON = 0.005;
const MIN_DARKNESS_ANIMATION_MS = 250;
const MAX_DARKNESS_ANIMATION_MS = 1500;
const CALENDAR_CONFIGURATION_SETTING = "fallout-maw.calendar.configuration";
const ACTIVE_CALENDAR_SETTING = "fallout-maw.calendar.active";

const DEFAULT_PHASE_ILLUMINATION = Object.freeze({
  "new": 0,
  "waxing-crescent": 0.25,
  "first-quarter": 0.5,
  "waxing-gibbous": 0.75,
  "full": 1,
  "waning-gibbous": 0.75,
  "last-quarter": 0.5,
  "waning-crescent": 0.25
});
const DEFAULT_MOON_MAX_LIGHT_CONTRIBUTION = 0.5;

let hooksRegistered = false;
let cachedCalendarApi = null;
let cachedCalendarConfiguration = null;
let cachedTimeConfiguration = null;
let cachedTargetDarkness = null;
let pendingTransition = null;
let transitionScheduled = false;
let transitionRunning = false;
let transitionGeneration = 0;
let activeLocalAnimations = 0;
let fallbackRefreshScheduled = false;
let settingRefreshScheduled = false;
let lastPayloadTimestamp = null;

export function registerDynamicLightingHooks() {
  if (hooksRegistered) return;
  Hooks.on("fallout-maw.calendar.ready", () => {
    invalidateCalendarLightingCache();
    refreshDynamicLighting();
  });
  Hooks.on("fallout-maw.calendar.configuration-change", () => {
    invalidateCalendarLightingCache();
    refreshDynamicLighting();
  });
  Hooks.on("fallout-maw.calendar.date-time-change", payload => {
    const timestamp = Number(payload?.timestamp);
    lastPayloadTimestamp = Number.isFinite(timestamp) ? timestamp : null;
    refreshDynamicLighting({ payload });
  });
  Hooks.on("updateWorldTime", worldTime => {
    const timestamp = Number(worldTime);
    if (Number.isFinite(timestamp) && timestamp === lastPayloadTimestamp) {
      lastPayloadTimestamp = null;
      return;
    }
    lastPayloadTimestamp = null;
    scheduleWorldTimeFallbackRefresh(worldTime);
  });
  Hooks.on("updateSetting", scheduleCalendarSettingLightingRefresh);
  Hooks.on("configureCanvasEnvironment", configureDerivedCanvasEnvironment);
  Hooks.on("canvasReady", () => {
    resetDynamicLightingState({ keepTarget: false });
    refreshDynamicLighting();
  });
  Hooks.on("canvasTearDown", () => resetDynamicLightingState({ keepTarget: false }));
  Hooks.on("updateScene", (scene, changes) => {
    if (scene?.id !== globalThis.canvas?.scene?.id) return;
    if (!hasProperty(changes, "environment.darknessLock")) return;
    if (scene.environment?.darknessLock) cancelLocalDarknessTransitions();
    else refreshDynamicLighting();
  });
  hooksRegistered = true;
}

/** Recalculate and animate only the active canvas' locally-derived darkness. */
export function refreshDynamicLighting({ payload = null, worldTime = globalThis.game?.time?.worldTime } = {}) {
  const scene = globalThis.canvas?.scene;
  if (!scene || scene.environment?.darknessLock) return false;
  const api = resolveCalendarApi();
  if (!api) return false;
  const state = resolveCalendarLightingState(api, payload, worldTime);
  if (!state) return false;

  const target = calculateCalendarDarkness(state);
  const previousTarget = cachedTargetDarkness;
  cachedTargetDarkness = target;
  if (previousTarget !== null && Math.abs(target - previousTarget) <= DARKNESS_UPDATE_EPSILON) return true;
  const displayed = displayedDarkness(scene);
  if (Math.abs(target - displayed) <= DARKNESS_UPDATE_EPSILON
    && (previousTarget === null || Math.abs(target - previousTarget) <= DARKNESS_UPDATE_EPSILON)) return true;
  queueLatestDarknessTransition(scene.id, target);
  return true;
}

/**
 * Calculate solar darkness on a circular day. Sunrise-to-sunset is daylight;
 * both edges of the night use a smooth twilight ramp.
 */
export function calculateSolarDarkness({
  secondOfDay = 0,
  sunriseSeconds = 6 * 60 * 60,
  sunsetSeconds = 18 * 60 * 60,
  secondsPerDay = 24 * 60 * 60,
  twilightSeconds = 2 * 60 * 60
} = {}) {
  const dayLength = positiveNumber(secondsPerDay, 24 * 60 * 60);
  const sunrise = modulo(Number(sunriseSeconds) || 0, dayLength);
  const sunset = modulo(Number(sunsetSeconds) || 0, dayLength);
  const now = modulo(Number(secondOfDay) || 0, dayLength);
  const daylightLength = modulo(sunset - sunrise, dayLength);
  if (daylightLength <= 0) return 1;

  const fromSunrise = modulo(now - sunrise, dayLength);
  if (fromSunrise <= daylightLength) return 0;

  const nightLength = dayLength - daylightLength;
  const fromSunset = fromSunrise - daylightLength;
  const twilight = Math.min(Math.max(0, Number(twilightSeconds) || 0), nightLength / 2);
  if (twilight <= 0) return 1;
  if (fromSunset < twilight) return smoothstep(fromSunset / twilight);
  const untilSunrise = nightLength - fromSunset;
  if (untilSunrise < twilight) return smoothstep(untilSunrise / twilight);
  return 1;
}

/** Return a phase's configured 0..1 light contribution, with useful defaults. */
export function getMoonPhaseIllumination(phase = {}) {
  const configured = firstFiniteNumber(
    phase?.illumination,
    phase?.illuminationLevel,
    phase?.darknessReduction,
    phase?.illuminationPercent
  );
  if (configured !== null) return clampAlpha(configured > 1 ? configured / 100 : configured);

  const icon = normalizePhaseName(phase?.icon);
  if (Object.hasOwn(DEFAULT_PHASE_ILLUMINATION, icon)) return DEFAULT_PHASE_ILLUMINATION[icon];
  const name = normalizePhaseName(phase?.name);
  for (const [key, value] of Object.entries(DEFAULT_PHASE_ILLUMINATION)) {
    if (name.includes(key)) return value;
  }
  return 0;
}

/** Scale a phase's 0..1 illumination by this moon's configured maximum. */
export function getMoonLightContribution(moon = {}) {
  if (moon?.affectsLighting === false) return 0;
  const configuredMaximum = firstFiniteNumber(moon?.maxLightContribution);
  const maximum = configuredMaximum === null
    ? DEFAULT_MOON_MAX_LIGHT_CONTRIBUTION
    : clampAlpha(configuredMaximum > 1 ? configuredMaximum / 100 : configuredMaximum);
  return clampAlpha(getMoonPhaseIllumination(moon?.currentPhase ?? moon?.phase ?? moon) * maximum);
}

/** Combine moons in O(moons), without intermediate arrays or values over one. */
export function combineMoonIllumination(moons = []) {
  if (!Array.isArray(moons) || !moons.length) return 0;
  let remainingDarkness = 1;
  for (const moon of moons) {
    remainingDarkness *= 1 - getMoonLightContribution(moon);
    if (remainingDarkness <= 0) return 1;
  }
  return clampAlpha(1 - remainingDarkness);
}

/** Solar darkness reduced by the current configured lunar phases. */
export function calculateCalendarDarkness({ moons = [], ...solar } = {}) {
  const solarDarkness = calculateSolarDarkness(solar);
  if (solarDarkness <= 0) return 0;
  return clampAlpha(solarDarkness * (1 - combineMoonIllumination(moons)));
}

/** Compatibility helper for callers which only have a world-time timestamp. */
export function calculateWorldTimeDarkness(worldTime = 0) {
  const secondsPerDay = DEFAULT_HOURS_PER_DAY * DEFAULT_MINUTES_PER_HOUR * DEFAULT_SECONDS_PER_MINUTE;
  return calculateSolarDarkness({
    secondOfDay: modulo(Number(worldTime) || 0, secondsPerDay),
    sunriseSeconds: secondsPerDay * 0.25,
    sunsetSeconds: secondsPerDay * 0.75,
    secondsPerDay,
    twilightSeconds: DEFAULT_TWILIGHT_HOURS * DEFAULT_MINUTES_PER_HOUR * DEFAULT_SECONDS_PER_MINUTE
  });
}

export function resolveCalendarLightingState(api, payload = null, worldTime = 0) {
  if (!api || typeof api.timestampToDate !== "function") return null;
  const time = getCalendarTimeConfiguration(api);
  const hoursPerDay = positiveNumber(time?.hoursInDay, DEFAULT_HOURS_PER_DAY);
  const minutesPerHour = positiveNumber(time?.minutesInHour, DEFAULT_MINUTES_PER_HOUR);
  const secondsPerMinute = positiveNumber(time?.secondsInMinute, DEFAULT_SECONDS_PER_MINUTE);
  const secondsPerHour = minutesPerHour * secondsPerMinute;
  const secondsPerDay = hoursPerDay * secondsPerHour;
  const date = payload?.date ?? safeCall(api.timestampToDate, worldTime);
  if (!date) return null;

  const secondOfDay = (Number(date.hour) || 0) * secondsPerHour
    + (Number(date.minute) || 0) * secondsPerMinute
    + (Number(date.second ?? date.seconds) || 0);
  const season = date.currentSeason ?? safeCall(api.getCurrentSeason);
  const configuration = getCalendarConfiguration(api);
  const hasSeasons = Array.isArray(configuration?.seasons) && configuration.seasons.length > 0;
  const sunriseSeconds = hasSeasons
    ? resolveSolarSecond(date.sunrise, season?.sunriseTime, secondsPerDay * 0.25, secondsPerDay)
    : secondsPerDay * 0.25;
  const sunsetSeconds = hasSeasons
    ? resolveSolarSecond(date.sunset, season?.sunsetTime, secondsPerDay * 0.75, secondsPerDay)
    : secondsPerDay * 0.75;
  const moons = Array.isArray(payload?.moons)
    ? payload.moons
    : (safeCall(api.getMoonLightingState) ?? safeCall(api.getAllMoons) ?? []);

  return {
    secondOfDay,
    sunriseSeconds,
    sunsetSeconds,
    secondsPerDay,
    twilightSeconds: Math.min(DEFAULT_TWILIGHT_HOURS * secondsPerHour, secondsPerDay / 4),
    moons: Array.isArray(moons) ? moons : []
  };
}

function configureDerivedCanvasEnvironment(config = {}) {
  if (activeLocalAnimations) return;
  const scene = globalThis.canvas?.scene;
  if (!scene || scene.environment?.darknessLock || !Number.isFinite(cachedTargetDarkness)) return;
  config.environment ??= {};
  config.environment.darknessLevel = cachedTargetDarkness;
}

function scheduleWorldTimeFallbackRefresh(worldTime) {
  if (fallbackRefreshScheduled) return;
  fallbackRefreshScheduled = true;
  globalThis.queueMicrotask(() => {
    fallbackRefreshScheduled = false;
    refreshDynamicLighting({ worldTime });
  });
}

function scheduleCalendarSettingLightingRefresh(setting) {
  const key = String(setting?.key ?? "");
  if (key !== CALENDAR_CONFIGURATION_SETTING && key !== ACTIVE_CALENDAR_SETTING) return;
  if (settingRefreshScheduled) return;
  settingRefreshScheduled = true;
  globalThis.queueMicrotask(() => {
    settingRefreshScheduled = false;
    invalidateCalendarLightingCache();
    refreshDynamicLighting();
  });
}

function queueLatestDarknessTransition(sceneId, target) {
  pendingTransition = { sceneId, target: clampAlpha(target) };
  if (transitionRunning || transitionScheduled) return;
  transitionScheduled = true;
  globalThis.queueMicrotask(flushLatestDarknessTransition);
}

async function flushLatestDarknessTransition() {
  if (transitionRunning) return;
  transitionScheduled = false;
  const transition = pendingTransition;
  pendingTransition = null;
  if (!transition) return;
  const scene = globalThis.canvas?.scene;
  if (!scene || scene.id !== transition.sceneId || scene.environment?.darknessLock) return;
  const difference = Math.abs(transition.target - displayedDarkness(scene));
  if (difference <= DARKNESS_UPDATE_EPSILON) return;

  const generation = ++transitionGeneration;
  const duration = animationDuration(difference);
  transitionRunning = true;
  activeLocalAnimations += 1;
  try {
    if (typeof globalThis.canvas?.effects?.animateDarkness === "function") {
      await globalThis.canvas.effects.animateDarkness(transition.target, { duration });
    } else {
      globalThis.canvas?.environment?.initialize?.({ environment: { darknessLevel: transition.target } });
    }
  } catch (error) {
    if (generation === transitionGeneration) {
      console.error("Fallout MaW | Local calendar darkness transition failed", error);
    }
  } finally {
    activeLocalAnimations = Math.max(0, activeLocalAnimations - 1);
    transitionRunning = false;
  }
  if (pendingTransition && !transitionScheduled) {
    transitionScheduled = true;
    globalThis.queueMicrotask(flushLatestDarknessTransition);
  }
}

function getCalendarTimeConfiguration(api) {
  if (api !== cachedCalendarApi) {
    cachedCalendarApi = api;
    cachedCalendarConfiguration = null;
    cachedTimeConfiguration = null;
  }
  cachedTimeConfiguration ??= safeCall(api.getTimeConfiguration)
    ?? getCalendarConfiguration(api)?.time
    ?? {};
  return cachedTimeConfiguration;
}

function getCalendarConfiguration(api) {
  if (api !== cachedCalendarApi) {
    cachedCalendarApi = api;
    cachedCalendarConfiguration = null;
    cachedTimeConfiguration = null;
  }
  cachedCalendarConfiguration ??= safeCall(api.getCurrentCalendar) ?? {};
  return cachedCalendarConfiguration;
}

function invalidateCalendarLightingCache() {
  cachedCalendarApi = null;
  cachedCalendarConfiguration = null;
  cachedTimeConfiguration = null;
}

function resetDynamicLightingState({ keepTarget = true } = {}) {
  pendingTransition = null;
  transitionScheduled = false;
  transitionGeneration += 1;
  if (!keepTarget) cachedTargetDarkness = null;
}

function cancelLocalDarknessTransitions() {
  const scene = globalThis.canvas?.scene;
  const sceneId = scene?.id;
  const persistedDarkness = clampAlpha(
    scene?._source?.environment?.darknessLevel ?? scene?.environment?.darknessLevel
  );
  resetDynamicLightingState({ keepTarget: false });
  globalThis.foundry?.canvas?.animation?.CanvasAnimation
    ?.terminateAnimation?.("lighting.animateDarkness");
  // Foundry resolves a cancelled darkness animation by applying that
  // animation's old target. Restore the Scene-owned value one microtask later
  // so enabling darknessLock always wins without writing to the Scene document.
  globalThis.queueMicrotask(() => {
    const currentScene = globalThis.canvas?.scene;
    if (!sceneId || currentScene?.id !== sceneId || !currentScene.environment?.darknessLock) return;
    globalThis.canvas?.environment?.initialize?.({
      environment: { darknessLevel: persistedDarkness }
    });
  });
}

function resolveCalendarApi() {
  return globalThis.game?.falloutMaW?.calendar?.api ?? null;
}

function resolveSolarSecond(absoluteTimestamp, seasonValue, fallback, secondsPerDay) {
  if (absoluteTimestamp !== null && absoluteTimestamp !== "" && Number.isFinite(Number(absoluteTimestamp))) {
    return modulo(Number(absoluteTimestamp), secondsPerDay);
  }
  if (seasonValue !== null && seasonValue !== "" && Number.isFinite(Number(seasonValue))) {
    return modulo(Number(seasonValue), secondsPerDay);
  }
  return fallback;
}

function displayedDarkness(scene) {
  const value = globalThis.canvas?.scene?.id === scene?.id
    ? globalThis.canvas?.environment?.darknessLevel
    : scene?.environment?.darknessLevel;
  return clampAlpha(value);
}

function animationDuration(difference) {
  return Math.round(MIN_DARKNESS_ANIMATION_MS
    + ((MAX_DARKNESS_ANIMATION_MS - MIN_DARKNESS_ANIMATION_MS) * clampAlpha(difference)));
}

function hasProperty(object, path) {
  return globalThis.foundry?.utils?.hasProperty?.(object ?? {}, path)
    ?? Object.hasOwn(object?.environment ?? {}, "darknessLock");
}

function safeCall(fn, ...args) {
  if (typeof fn !== "function") return null;
  try {
    return fn(...args);
  } catch (_error) {
    return null;
  }
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (value !== null && value !== "" && Number.isFinite(number)) return number;
  }
  return null;
}

function normalizePhaseName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z-]/g, "");
}

function smoothstep(value) {
  const progress = clampAlpha(value);
  return progress * progress * (3 - (2 * progress));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampAlpha(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}
