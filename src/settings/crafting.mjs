export const CRAFTING_RESOLUTION_MODES = Object.freeze({
  skillChecks: "skillChecks",
  skillThreshold: "skillThreshold"
});

export const DEFAULT_CRAFTING_SETTINGS = Object.freeze({
  craft: Object.freeze({
    mode: CRAFTING_RESOLUTION_MODES.skillChecks,
    failureRefundPercent: 80,
    criticalFailureRefundPercent: 20
  }),
  repair: Object.freeze({
    mode: CRAFTING_RESOLUTION_MODES.skillChecks,
    failureToolCostIncreasePercent: 100,
    criticalFailureToolCostIncreasePercent: 0
  })
});

const VALID_RESOLUTION_MODES = new Set(Object.values(CRAFTING_RESOLUTION_MODES));
const MAX_TOOL_COST_INCREASE_PERCENT = 1000;

export function createDefaultCraftingSettings() {
  return {
    craft: { ...DEFAULT_CRAFTING_SETTINGS.craft },
    repair: { ...DEFAULT_CRAFTING_SETTINGS.repair }
  };
}

export function normalizeCraftingSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const craft = source.craft && typeof source.craft === "object" ? source.craft : {};
  const repair = source.repair && typeof source.repair === "object" ? source.repair : {};
  return {
    craft: {
      mode: normalizeResolutionMode(craft.mode, DEFAULT_CRAFTING_SETTINGS.craft.mode),
      failureRefundPercent: clampPercent(
        craft.failureRefundPercent,
        DEFAULT_CRAFTING_SETTINGS.craft.failureRefundPercent
      ),
      criticalFailureRefundPercent: clampPercent(
        craft.criticalFailureRefundPercent,
        DEFAULT_CRAFTING_SETTINGS.craft.criticalFailureRefundPercent
      )
    },
    repair: {
      mode: normalizeResolutionMode(repair.mode, DEFAULT_CRAFTING_SETTINGS.repair.mode),
      failureToolCostIncreasePercent: clampInteger(
        repair.failureToolCostIncreasePercent,
        0,
        MAX_TOOL_COST_INCREASE_PERCENT,
        DEFAULT_CRAFTING_SETTINGS.repair.failureToolCostIncreasePercent
      ),
      criticalFailureToolCostIncreasePercent: clampInteger(
        repair.criticalFailureToolCostIncreasePercent,
        0,
        MAX_TOOL_COST_INCREASE_PERCENT,
        DEFAULT_CRAFTING_SETTINGS.repair.criticalFailureToolCostIncreasePercent
      )
    }
  };
}

export function isSkillThresholdMode(mode) {
  return mode === CRAFTING_RESOLUTION_MODES.skillThreshold;
}

export function getCraftFailureRefundPercent(settings = DEFAULT_CRAFTING_SETTINGS, resultKeys = []) {
  const normalized = normalizeCraftingSettings(settings);
  const results = Array.from(resultKeys ?? [], result => String(result ?? ""));
  return results.includes("criticalFailure")
    ? normalized.craft.criticalFailureRefundPercent
    : normalized.craft.failureRefundPercent;
}

export function calculateCraftConsumedQuantity(quantity, refundPercent) {
  const available = Math.max(0, toInteger(quantity));
  const returned = Math.round(available * (clampPercent(refundPercent, 0) / 100));
  return Math.max(0, available - returned);
}

export function getRepairToolCostMultiplier(settings = DEFAULT_CRAFTING_SETTINGS, resultKey = "success") {
  const normalized = normalizeCraftingSettings(settings);
  let increasePercent = 0;
  if (resultKey === "criticalFailure") {
    increasePercent = normalized.repair.criticalFailureToolCostIncreasePercent;
  } else if (resultKey === "failure") {
    increasePercent = normalized.repair.failureToolCostIncreasePercent;
  }
  return 1 + (increasePercent / 100);
}

function normalizeResolutionMode(value, fallback) {
  return VALID_RESOLUTION_MODES.has(value) ? value : fallback;
}

function clampPercent(value, fallback) {
  return clampInteger(value, 0, 100, fallback);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
