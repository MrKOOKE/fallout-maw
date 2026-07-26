const EPSILON = 0.000001;

/**
 * Plan several integer resource costs against one shared pool.
 *
 * Fractional amounts are accumulated independently by key, while every whole
 * unit is deducted from the pool once. The plan is all-or-nothing.
 */
export function planIntegerResourceSpend({
  current = 0,
  costs = [],
  remainders = {}
} = {}) {
  const availableValue = Math.max(0, Math.trunc(Number(current) || 0));
  const previousRemainders = normalizeRemainders(remainders);
  const nextRemainders = { ...previousRemainders };
  let requested = 0;
  let hasDemand = false;

  for (const cost of costs ?? []) {
    const key = String(cost?.key ?? "").trim();
    const amount = Math.max(0, Number(cost?.amount) || 0);
    if (!key || amount <= 0) continue;
    hasDemand = true;
    const total = Math.max(0, Number(nextRemainders[key]) || 0) + amount;
    const spend = Math.floor(total + EPSILON);
    requested += spend;
    const remainder = normalizeResourceNumber(total - spend);
    nextRemainders[key] = remainder > EPSILON ? remainder : 0;
  }

  const available = (!hasDemand || availableValue > 0) && requested <= availableValue;
  return {
    available,
    current: availableValue,
    requested,
    spent: available ? requested : 0,
    remaining: available ? Math.max(0, availableValue - requested) : availableValue,
    remainders: available ? nextRemainders : previousRemainders
  };
}

/**
 * Plan several continuous costs against one shared pool.
 */
export function planContinuousResourceSpend({
  current = 0,
  costs = [],
  allowPartial = false
} = {}) {
  const availableValue = Math.max(0, normalizeResourceNumber(current));
  const requested = normalizeResourceNumber((costs ?? []).reduce(
    (sum, cost) => sum + Math.max(0, Number(cost?.amount ?? cost) || 0),
    0
  ));
  const available = requested <= availableValue + EPSILON;
  const spent = normalizeResourceNumber(available
    ? Math.min(availableValue, requested)
    : (allowPartial ? availableValue : 0));
  return {
    available,
    current: availableValue,
    requested,
    spent,
    remaining: Math.max(0, normalizeResourceNumber(availableValue - spent))
  };
}

function normalizeRemainders(remainders = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(remainders ?? {})) {
    const number = normalizeResourceNumber(value);
    normalized[key] = Math.abs(number) > EPSILON ? number : 0;
  }
  return normalized;
}

function normalizeResourceNumber(value = 0) {
  return Math.round((Number(value) || 0) * 1e12) / 1e12;
}
