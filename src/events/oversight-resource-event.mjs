export const OVERSIGHT_RESOURCE_SPENT_EVENT_KEY = "fallout-maw.combat.resource.spent";

export function advanceOversightResourceThreshold(data = {}, resources = {}) {
  const spent = Object.values(resources ?? {}).reduce((total, value) => (
    total + Math.max(0, toInteger(value))
  ), 0);
  const threshold = Math.max(1, toInteger(data?.resourceThreshold));
  const previous = Math.max(0, toInteger(data?.accumulatedSpend));
  const total = previous + spent;
  return Object.freeze({
    spent,
    threshold,
    triggerCount: Math.floor(total / threshold),
    accumulatedSpend: total % threshold
  });
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
