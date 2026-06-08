import { toInteger } from "../utils/numbers.mjs";

export const DEFAULT_SKILL_DEVELOPMENT_COST_THRESHOLDS = Object.freeze([
  { threshold: 80, cost: 2 },
  { threshold: 120, cost: 4 },
  { threshold: 160, cost: 6 },
  { threshold: 200, cost: 8 },
  { threshold: 240, cost: 10 },
  { threshold: 280, cost: 12 }
]);

export function createDefaultSkillDevelopmentCostSettings() {
  return {
    thresholds: DEFAULT_SKILL_DEVELOPMENT_COST_THRESHOLDS.map(entry => ({ ...entry }))
  };
}

export function normalizeSkillDevelopmentCostSettings(settings = {}) {
  const source = Array.isArray(settings?.thresholds)
    ? settings.thresholds
    : Array.isArray(settings)
      ? settings
      : DEFAULT_SKILL_DEVELOPMENT_COST_THRESHOLDS;

  const rows = source
    .map(entry => ({
      threshold: Math.max(0, toInteger(entry?.threshold ?? entry?.min)),
      cost: Math.max(1, toInteger(entry?.cost))
    }))
    .filter(entry => Number.isFinite(entry.threshold) && Number.isFinite(entry.cost))
    .sort((left, right) => left.threshold - right.threshold);

  const uniqueRows = [];
  const usedThresholds = new Set();
  for (const row of rows) {
    if (usedThresholds.has(row.threshold)) continue;
    usedThresholds.add(row.threshold);
    uniqueRows.push(row);
  }

  if (!uniqueRows.length) return createDefaultSkillDevelopmentCostSettings();
  if (uniqueRows.length === 1 && uniqueRows[0].threshold === 0 && uniqueRows[0].cost === 1) return createDefaultSkillDevelopmentCostSettings();

  return { thresholds: uniqueRows };
}

export function getSkillDevelopmentCostForValue(value = 0, settings = {}) {
  const thresholds = normalizeSkillDevelopmentCostSettings(settings).thresholds;
  const currentValue = Math.max(0, toInteger(value));
  let cost = 1;

  for (const threshold of thresholds) {
    if (threshold.threshold > currentValue) break;
    cost = Math.max(1, toInteger(threshold.cost));
  }

  return cost;
}

export function getNextSkillDevelopmentCostThreshold(value = 0, settings = {}) {
  const thresholds = normalizeSkillDevelopmentCostSettings(settings).thresholds;
  const currentValue = Math.max(0, toInteger(value));
  const next = thresholds.find(threshold => threshold.threshold > currentValue);
  if (!next) return null;

  return {
    threshold: next.threshold,
    cost: next.cost,
    remaining: Math.max(0, next.threshold - currentValue)
  };
}
