export const STEALTH_LIGHT_LEVELS = Object.freeze([
  { key: "normal", label: "Обычный свет" },
  { key: "shadow", label: "Тень" },
  { key: "dim", label: "Тускло" },
  { key: "dark", label: "Темно" },
  { key: "blackout", label: "Темнота" }
]);

export const DEFAULT_STEALTH_SETTINGS = Object.freeze({
  difficulty: Object.freeze({
    skillKey: "naturalist"
  }),
  detection: Object.freeze({
    skillKey: "naturalist",
    rangeFormula: "5 + навык / 10"
  }),
  attenuationLevels: Object.freeze([
    Object.freeze({ threshold: 1, penaltyPercent: 90 }),
    Object.freeze({ threshold: 0.75, penaltyPercent: 70 }),
    Object.freeze({ threshold: 0.5, penaltyPercent: 50 }),
    Object.freeze({ threshold: 0.2, penaltyPercent: 20 })
  ]),
  difficultyLevels: Object.freeze([
    Object.freeze({ threshold: 1, difficultyBonus: 0 }),
    Object.freeze({ threshold: 0.75, difficultyBonus: 20 }),
    Object.freeze({ threshold: 0.5, difficultyBonus: 40 }),
    Object.freeze({ threshold: 0.2, difficultyBonus: 80 }),
    Object.freeze({ threshold: 0, difficultyBonus: 120 })
  ]),
  autoDetection: Object.freeze({
    enabled: true,
    movementThresholdFormula: "(ОД + ОП) / 5"
  })
});

export function createDefaultStealthSettings() {
  return foundry.utils.deepClone(DEFAULT_STEALTH_SETTINGS);
}

export function normalizeStealthSettings(value = {}) {
  const source = foundry.utils.mergeObject(
    createDefaultStealthSettings(),
    value && typeof value === "object" ? value : {},
    { inplace: false }
  );

  return {
    difficulty: normalizeDifficultySettings(source.difficulty, source.difficultyMode),
    detection: normalizeDetectionSettings(source.detection),
    attenuationLevels: normalizeThresholdRows(source.attenuationLevels, DEFAULT_STEALTH_SETTINGS.attenuationLevels, "penaltyPercent", 0, 100),
    difficultyLevels: normalizeThresholdRows(source.difficultyLevels, DEFAULT_STEALTH_SETTINGS.difficultyLevels, "difficultyBonus", -999, 999),
    autoDetection: normalizeAutoDetection(source.autoDetection)
  };
}

function normalizeDifficultySettings(value = {}, legacyMode = "") {
  const defaults = DEFAULT_STEALTH_SETTINGS.difficulty;
  const legacySkillKey = legacyMode === "naturalist" ? "naturalist" : "";
  return {
    skillKey: String(value?.skillKey ?? legacySkillKey ?? defaults.skillKey).trim() || defaults.skillKey
  };
}

function normalizeDetectionSettings(value = {}) {
  const defaults = DEFAULT_STEALTH_SETTINGS.detection;
  return {
    skillKey: String(value?.skillKey ?? defaults.skillKey).trim() || defaults.skillKey,
    rangeFormula: normalizeFormula(value?.rangeFormula, defaults.rangeFormula)
  };
}

function normalizeThresholdRows(value = [], defaults = [], key = "", min = -Infinity, max = Infinity) {
  const source = Array.isArray(value)
    ? value
    : Object.values(value && typeof value === "object" ? value : {});
  const rows = source
    .map(entry => ({
      threshold: clampNumber(entry?.threshold, NaN, 0, 1),
      [key]: clampNumber(entry?.[key], NaN, min, max)
    }))
    .filter(entry => Number.isFinite(entry.threshold) && Number.isFinite(entry[key]));
  const normalized = rows.length ? rows : foundry.utils.deepClone(defaults);
  return normalized.sort((left, right) => right.threshold - left.threshold);
}

function normalizeAutoDetection(value = {}) {
  const defaults = DEFAULT_STEALTH_SETTINGS.autoDetection;
  const enabled = Array.isArray(value?.enabled) ? value.enabled.at(-1) : value?.enabled;
  return {
    enabled: enabled === true || enabled === "true" || enabled === "on",
    movementThresholdFormula: normalizeFormula(value?.movementThresholdFormula, defaults.movementThresholdFormula)
  };
}

function normalizeFormula(value, fallback = "0") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
