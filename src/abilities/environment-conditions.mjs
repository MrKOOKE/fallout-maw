import { SYSTEM_ID } from "../constants.mjs";
import { STEALTH_SETTINGS_SETTING } from "../settings/constants.mjs";
import {
  createDefaultStealthSettings,
  normalizeStealthSettings,
  STEALTH_LIGHT_LEVELS
} from "../stealth/settings.mjs";
import { analyzeTokenLighting } from "../stealth/lighting.mjs";

const DAY_MINUTES = 24 * 60;
const MINUTE_SECONDS = 60;

let lightingRevision = 0;
const tokenLightingCache = new WeakMap();
let stealthSettingsRevision = -1;
let cachedStealthSettings = null;

export function normalizeTimeOfDayText(value = "", fallback = "00:00") {
  const minutes = parseTimeOfDayMinutes(value);
  if (minutes === null) return normalizeTimeOfDayText(fallback, "00:00");
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function getWorldTimeMinuteOfDay(worldTime = 0) {
  const totalMinutes = Math.floor((Number(worldTime) || 0) / MINUTE_SECONDS);
  return modulo(totalMinutes, DAY_MINUTES);
}

export function timeOfDayConditionApplies(condition = {}, context = {}) {
  const explicitWorldTime = context?.worldTime;
  const resolvedWorldTime = Number.isFinite(Number(explicitWorldTime))
    ? Number(explicitWorldTime)
    : Number(globalThis.game?.time?.worldTime) || 0;
  const minute = getWorldTimeMinuteOfDay(resolvedWorldTime);
  const from = parseTimeOfDayMinutes(condition?.timeFrom) ?? 0;
  const to = parseTimeOfDayMinutes(condition?.timeTo) ?? (DAY_MINUTES - 1);

  // Equal endpoints are useful as an explicit "all day" range.
  if (from === to) return true;
  if (from < to) return minute >= from && minute <= to;
  return minute >= from || minute <= to;
}

export function illuminationConditionApplies(actor, condition = {}, context = {}) {
  const illuminationLevel = getActorIlluminationLevel(actor, context);
  return illuminationLevel !== null
    && illuminationLevelConditionApplies(condition, illuminationLevel);
}

export function illuminationLevelConditionApplies(condition = {}, illuminationLevel = null) {
  const required = normalizeIlluminationLevel(condition?.illuminationLevel);
  return Boolean(illuminationLevel && required && illuminationLevel === required);
}

export function getActorIlluminationPercent(actor, context = {}) {
  return getActorLighting(actor, context)?.illuminationPercent ?? null;
}

export function getActorIlluminationLevel(actor, context = {}) {
  return getActorLighting(actor, context)?.illuminationLevel ?? null;
}

export function normalizeIlluminationLevel(value = "") {
  const key = String(value ?? "").trim();
  return STEALTH_LIGHT_LEVELS.some(level => level.key === key) ? key : "normal";
}

function getActorLighting(actor, context = {}) {
  const token = resolveActorToken(actor, [context?.actorToken, context?.targetToken]);
  if (!token) return null;
  const cached = tokenLightingCache.get(token);
  if (cached?.revision === lightingRevision) return cached.value;
  const measurement = analyzeTokenLighting(token);
  const value = {
    illuminationPercent: clampPercent(measurement.illuminationPercent),
    illuminationLevel: getStealthLightLevelKey(measurement.effectiveDarkness)
  };
  tokenLightingCache.set(token, { revision: lightingRevision, value });
  return value;
}

export function invalidateAbilityConditionLightingCache() {
  lightingRevision += 1;
  stealthSettingsRevision = -1;
  cachedStealthSettings = null;
}

function resolveActorToken(actor, explicitTokens = []) {
  const actorUuid = String(actor?.uuid ?? "");
  for (const candidateToken of explicitTokens) {
    const explicit = candidateToken?.object ?? candidateToken;
    if (!explicit?.document && !explicit?.actor) continue;
    const explicitActorUuid = String(explicit?.actor?.uuid ?? explicit?.document?.actor?.uuid ?? "");
    if (explicitActorUuid && explicitActorUuid === actorUuid) return explicit;
  }

  const canvasToken = globalThis.canvas?.tokens?.placeables
    ?.find(token => String(token?.actor?.uuid ?? "") === actorUuid);
  if (canvasToken) return canvasToken;
  return actor?.getActiveTokens?.()?.[0] ?? null;
}

function getStealthLightLevelKey(effectiveDarkness) {
  const settings = getCurrentStealthSettings();
  const levels = Array.isArray(settings.difficultyLevels) ? settings.difficultyLevels : [];
  const entry = levels.find(level => effectiveDarkness >= Number(level?.threshold))
    ?? levels.at(-1)
    ?? { threshold: 0 };
  const threshold = Number(entry.threshold) || 0;
  if (threshold >= 1) return "blackout";
  if (threshold >= 0.75) return "dark";
  if (threshold >= 0.5) return "dim";
  if (threshold >= 0.2) return "shadow";
  return "normal";
}

function getCurrentStealthSettings() {
  if (stealthSettingsRevision === lightingRevision && cachedStealthSettings) return cachedStealthSettings;
  try {
    cachedStealthSettings = normalizeStealthSettings(globalThis.game?.settings?.get(SYSTEM_ID, STEALTH_SETTINGS_SETTING));
  } catch (_error) {
    cachedStealthSettings = createDefaultStealthSettings();
  }
  stealthSettingsRevision = lightingRevision;
  return cachedStealthSettings;
}

function parseTimeOfDayMinutes(value) {
  if (typeof value === "number" && Number.isFinite(value)) return modulo(Math.trunc(value), DAY_MINUTES);
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes < 0 || minutes > 59 || hours < 0 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return modulo((hours * 60) + minutes, DAY_MINUTES);
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}
