export const PERIODIC_HEALING_EFFECT_KEY = "fallout-maw.healing";
export const LEGACY_PERIODIC_HEALING_EFFECT_KEY = "healing";
export const PERIODIC_HEALING_INTERVAL_SECONDS = 6;

const PERIODIC_HEALING_EFFECT_KEYS = new Set([
  PERIODIC_HEALING_EFFECT_KEY,
  LEGACY_PERIODIC_HEALING_EFFECT_KEY
]);

export function isPeriodicHealingEffectKey(key = "") {
  return PERIODIC_HEALING_EFFECT_KEYS.has(String(key ?? "").trim().toLocaleLowerCase());
}

export function getPeriodicHealingEffectChanges(effect = null) {
  const changes = effect?.system?.changes ?? effect?.changes ?? [];
  return (Array.isArray(changes) ? changes : [])
    .filter(change => isPeriodicHealingEffectKey(change?.key));
}

/**
 * Count fixed six-second ticks crossed by one world-time update.
 *
 * The schedule is derived from Foundry's persisted ActiveEffect start time, so
 * ordinary ticks require no bookkeeping update to the effect itself.
 */
export function countPeriodicHealingTicks({
  startTime = 0,
  previousTime = 0,
  currentTime = 0,
  durationSeconds = Number.POSITIVE_INFINITY
} = {}) {
  const start = Number(startTime);
  const previous = Number(previousTime);
  const current = Number(currentTime);
  if (!Number.isFinite(start) || !Number.isFinite(previous) || !Number.isFinite(current)) return 0;
  if (current <= previous || current < start + PERIODIC_HEALING_INTERVAL_SECONDS) return 0;

  const duration = Number(durationSeconds);
  const end = Number.isFinite(duration)
    ? start + Math.max(0, duration)
    : Number.POSITIVE_INFINITY;
  const cappedCurrent = Math.min(current, end);
  if (cappedCurrent < start + PERIODIC_HEALING_INTERVAL_SECONDS) return 0;

  const ticksAtCurrent = Math.floor((cappedCurrent - start) / PERIODIC_HEALING_INTERVAL_SECONDS);
  const ticksAtPrevious = previous < start
    ? 0
    : Math.max(0, Math.floor((Math.min(previous, end) - start) / PERIODIC_HEALING_INTERVAL_SECONDS));
  return Math.max(0, ticksAtCurrent - ticksAtPrevious);
}

/**
 * Apply standard Active Effect arithmetic to all healing rows of one effect.
 */
export function evaluatePeriodicHealingPerTick(changes = [], evaluate = change => Number(change?.value)) {
  const prepared = (Array.isArray(changes) ? changes : [])
    .filter(change => isPeriodicHealingEffectKey(change?.key))
    .map((change, index) => ({
      change,
      index,
      priority: Number.isFinite(Number(change?.priority)) ? Number(change.priority) : 0
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);

  let value = 0;
  for (const { change } of prepared) {
    const amount = Number(evaluate(change));
    if (!Number.isFinite(amount)) continue;
    switch (String(change?.type ?? "add")) {
      case "multiply":
        value *= amount;
        break;
      case "override":
        value = amount;
        break;
      case "upgrade":
        value = Math.max(value, amount);
        break;
      case "downgrade":
        value = Math.min(value, amount);
        break;
      default:
        value += amount;
        break;
    }
  }
  return Math.max(0, Math.floor(value));
}
