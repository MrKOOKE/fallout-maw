export function getNeedGrowthMultiplier(resistancePercent = 0) {
  return Math.max(0, 1 - (toFiniteNumber(resistancePercent) / 100));
}

export function getNeedSatisfactionMultiplier(effectivenessPercent = 0) {
  return Math.max(0, 1 + (toFiniteNumber(effectivenessPercent) / 100));
}

export function scaleNeedChangeExact(value = 0, {
  growthResistancePercent = 0,
  satisfactionEffectivenessPercent = 0
} = {}) {
  const amount = toFiniteNumber(value);
  if (amount > 0) return (amount * getNeedGrowthMultiplier(growthResistancePercent)) || 0;
  if (amount < 0) return (amount * getNeedSatisfactionMultiplier(satisfactionEffectivenessPercent)) || 0;
  return 0;
}

export function scaleNeedChange(value = 0, modifiers = {}) {
  const scaled = scaleNeedChangeExact(value, modifiers);
  if (!scaled) return 0;
  const magnitude = Math.floor(Math.abs(scaled));
  if (!magnitude) return 0;
  return scaled < 0 ? -magnitude : magnitude;
}

export function scaleGroupedNeedChanges(values = [], modifiers = {}) {
  let requestedGrowth = 0;
  let requestedSatisfaction = 0;
  for (const value of Array.isArray(values) ? values : [values]) {
    const amount = toFiniteNumber(value);
    if (amount > 0) requestedGrowth += amount;
    else if (amount < 0) requestedSatisfaction += amount;
  }
  const scaledGrowth = scaleNeedChange(requestedGrowth, modifiers);
  const scaledSatisfaction = scaleNeedChange(requestedSatisfaction, modifiers);
  return {
    requestedDelta: requestedGrowth + requestedSatisfaction,
    requestedGrowth,
    requestedSatisfaction,
    scaledGrowth,
    scaledSatisfaction,
    scaledDelta: scaledGrowth + scaledSatisfaction
  };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
