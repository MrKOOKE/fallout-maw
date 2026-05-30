export const STEALTH_LIGHT_LEVELS = Object.freeze([
  { key: "veryBright", label: "Очень яркий свет" },
  { key: "bright", label: "Яркий свет" },
  { key: "dim", label: "Тусклый свет" },
  { key: "dark", label: "Темнота" }
]);

export const DEFAULT_STEALTH_SETTINGS = Object.freeze({
  difficultyMode: "perception",
  thresholds: Object.freeze({
    veryBrightMax: 0.09,
    brightMax: 0.39,
    dimMax: 0.85
  }),
  veryBright: Object.freeze({ difficultyBonus: 100, perceptionMultiplier: 10, radius: 30 }),
  bright: Object.freeze({ difficultyBonus: 40, perceptionMultiplier: 8, radius: 20 }),
  dim: Object.freeze({ difficultyBonus: 20, perceptionMultiplier: 6, radius: 15 }),
  dark: Object.freeze({ difficultyBonus: 0, perceptionMultiplier: 5, radius: 10 })
});

const DIFFICULTY_MODES = new Set(["perception", "naturalist"]);

export function createDefaultStealthSettings() {
  return foundry.utils.deepClone(DEFAULT_STEALTH_SETTINGS);
}

export function normalizeStealthSettings(value = {}) {
  const source = foundry.utils.mergeObject(
    createDefaultStealthSettings(),
    value && typeof value === "object" ? value : {},
    { inplace: false }
  );

  const thresholds = normalizeThresholds(source.thresholds);
  return {
    difficultyMode: DIFFICULTY_MODES.has(source.difficultyMode) ? source.difficultyMode : DEFAULT_STEALTH_SETTINGS.difficultyMode,
    thresholds,
    veryBright: normalizeLightLevel(source.veryBright, DEFAULT_STEALTH_SETTINGS.veryBright),
    bright: normalizeLightLevel(source.bright, DEFAULT_STEALTH_SETTINGS.bright),
    dim: normalizeLightLevel(source.dim, DEFAULT_STEALTH_SETTINGS.dim),
    dark: normalizeLightLevel(source.dark, DEFAULT_STEALTH_SETTINGS.dark)
  };
}

function normalizeThresholds(value = {}) {
  const defaults = DEFAULT_STEALTH_SETTINGS.thresholds;
  const thresholds = {
    veryBrightMax: clampNumber(value.veryBrightMax, defaults.veryBrightMax, 0, 1),
    brightMax: clampNumber(value.brightMax, defaults.brightMax, 0, 1),
    dimMax: clampNumber(value.dimMax, defaults.dimMax, 0, 1)
  };
  thresholds.brightMax = Math.max(thresholds.veryBrightMax, thresholds.brightMax);
  thresholds.dimMax = Math.max(thresholds.brightMax, thresholds.dimMax);
  return thresholds;
}

function normalizeLightLevel(value = {}, defaults = {}) {
  return {
    difficultyBonus: toInteger(value.difficultyBonus, defaults.difficultyBonus),
    perceptionMultiplier: Math.max(1, toInteger(value.perceptionMultiplier, defaults.perceptionMultiplier)),
    radius: Math.max(0, toInteger(value.radius, defaults.radius))
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function toInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}
