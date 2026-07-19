const OPERATIONS = new Set(["add", "subtract", "multiply", "override", "upgrade", "downgrade"]);

export const PARALLEL_PERCENT_CALCULATION = "parallel-percent";

export function normalizeItemValueOperation(operation = "add") {
  const normalized = String(operation ?? "add").trim();
  return OPERATIONS.has(normalized) ? normalized : "add";
}

export function applyItemValueOperation(before = 0, amount = 0, operation = "add") {
  const current = Number(before) || 0;
  const value = Number(amount);
  if (!Number.isFinite(value)) return current;
  switch (normalizeItemValueOperation(operation)) {
    case "subtract": return current - value;
    case "multiply": return current * value;
    case "override": return value;
    case "upgrade": return Math.max(current, value);
    case "downgrade": return Math.min(current, value);
    default: return current + value;
  }
}

export function createItemValueAttributionStep(before = 0, source = {}, {
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
  round = null
} = {}) {
  const operation = normalizeItemValueOperation(source.operation ?? source.type);
  const amount = Number(source.value);
  let after = applyItemValueOperation(before, amount, operation);
  if (typeof round === "function") after = round(after);
  if (Number.isFinite(Number(minimum))) after = Math.max(Number(minimum), after);
  if (Number.isFinite(Number(maximum))) after = Math.min(Number(maximum), after);
  return {
    ...source,
    operation,
    value: Number.isFinite(amount) ? amount : 0,
    before: Number(before) || 0,
    after,
    delta: after - (Number(before) || 0)
  };
}

export function replayItemValueAttribution(baseValue = 0, sources = [], options = {}) {
  let value = Number(baseValue) || 0;
  const steps = [];
  for (const source of sources ?? []) {
    const step = createItemValueAttributionStep(value, source, options);
    steps.push(step);
    value = step.after;
  }
  return { baseValue: Number(baseValue) || 0, sources: steps, total: value };
}

/**
 * Attribute additive percentage-point sources without applying them one by one.
 *
 * Every returned source is calculated from the same base. The combined percent
 * is then clamped and rounded once, matching runtimes where percentage bonuses
 * form one stage instead of compounding sequentially.
 */
export function buildParallelPercentAttribution(baseValue = 0, sources = [], {
  direction = 1,
  minimumFactor = 0,
  maximumFactor = Number.POSITIVE_INFINITY,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
  round = null
} = {}) {
  const base = finiteNumber(baseValue);
  const normalizedDirection = Number(direction) < 0 ? -1 : 1;
  const inputSources = Array.isArray(sources) ? sources : [];
  const attributedSources = inputSources.map(source => {
    const entry = source && typeof source === "object" ? source : { value: source };
    const percent = finiteNumber(entry.percent ?? entry.value);
    const contribution = normalizeZero((base * normalizedDirection * percent) / 100);
    const {
      before: _before,
      after: _after,
      delta: _delta,
      contribution: _contribution,
      percentBase: _percentBase,
      calculation: _calculation,
      percent: _percent,
      ...metadata
    } = entry;
    return {
      ...metadata,
      calculation: PARALLEL_PERCENT_CALCULATION,
      operation: "percent",
      value: percent,
      percent,
      percentBase: base,
      contribution
    };
  });
  const totalPercent = normalizeZero(attributedSources.reduce((total, source) => total + source.percent, 0));
  const combinedContribution = normalizeZero(attributedSources.reduce((total, source) => total + source.contribution, 0));
  const unclampedFactor = normalizeZero(1 + ((normalizedDirection * totalPercent) / 100));
  const factorBounds = normalizeBounds(minimumFactor, maximumFactor, 0, Number.POSITIVE_INFINITY);
  const factor = normalizeZero(clamp(unclampedFactor, factorBounds.minimum, factorBounds.maximum));
  const unclampedTotal = normalizeZero(base + combinedContribution);
  const unroundedTotal = normalizeZero(base * factor);
  let roundedTotal = unroundedTotal;
  if (typeof round === "function") {
    const rounded = Number(round(unroundedTotal));
    if (Number.isFinite(rounded)) roundedTotal = normalizeZero(rounded);
  }
  const totalBounds = normalizeBounds(minimum, maximum, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
  const total = normalizeZero(clamp(roundedTotal, totalBounds.minimum, totalBounds.maximum));

  return {
    calculation: PARALLEL_PERCENT_CALCULATION,
    baseValue: base,
    direction: normalizedDirection,
    sources: attributedSources,
    totalPercent,
    combinedContribution,
    unclampedFactor,
    factor,
    unclampedTotal,
    unroundedTotal,
    roundedTotal,
    total,
    delta: normalizeZero(total - base)
  };
}

function finiteNumber(value = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeBounds(minimum, maximum, fallbackMinimum, fallbackMaximum) {
  const lowerValue = Number(minimum);
  const upperValue = Number(maximum);
  const lower = Number.isFinite(lowerValue) ? lowerValue : fallbackMinimum;
  const configuredUpper = Number.isFinite(upperValue) ? upperValue : fallbackMaximum;
  return { minimum: lower, maximum: Math.max(lower, configuredUpper) };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeZero(value = 0) {
  return Object.is(value, -0) ? 0 : value;
}
