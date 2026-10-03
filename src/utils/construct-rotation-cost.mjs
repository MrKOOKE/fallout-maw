/** Turn-relative circular coverage. Unwrapped angles track travel, not new billable revolutions. */
export function normalizeRotationCost(raw = {}) {
  const points = Number(raw.points);
  return { points: Number.isFinite(points) ? Math.max(0, Math.trunc(points)) : 0,
    degrees: Math.min(360, Math.max(1, Number(raw.degrees) || 15)) };
}

export function rotationDelta(from, to) {
  return ((Number(to) - Number(from) + 540) % 360 + 360) % 360 - 180;
}

export function planRotationSector(raw, target, cost, budget = Infinity) {
  const profile = normalizeRotationCost(cost);
  const state = { origin: Number(raw.origin) || 0, last: Number(raw.last ?? raw.origin) || 0,
    offset: Number(raw.offset) || 0,
    min: Number.isInteger(raw.min) ? raw.min : null, max: Number.isInteger(raw.max) ? raw.max : null };
  const requested = state.last + rotationDelta(state.last, target);
  const circleCount = Math.ceil(360 / profile.degrees - 1e-8);
  const oldCount = state.min === null ? 0 : state.max - state.min + 1;
  if (oldCount >= circleCount) state.max = state.min + circleCount - 1;
  if (!profile.points || oldCount >= circleCount || Math.abs(requested - state.last) < 1e-6)
    return { state: { ...state, last: requested }, rotation: requested, cost: 0, reached: true };
  const base = state.origin + state.offset;
  const relative = (requested - base) / profile.degrees;
  const index = requested > state.last ? Math.ceil(relative - 1e-8) - 1 : Math.floor(relative + 1e-8);
  const initial = (state.origin - base) / profile.degrees;
  const firstIndex = requested >= state.origin ? Math.floor(initial + 1e-8) : Math.ceil(initial - 1e-8) - 1;
  let min = state.min === null ? Math.min(firstIndex, index) : Math.min(state.min, index);
  let max = state.max === null ? Math.max(firstIndex, index) : Math.max(state.max, index);
  // An extension can only open the remaining gap of this same circle. Its
  // overlapping tail belongs to existing coverage, even on another revolution.
  if (max - min + 1 > circleCount) {
    if (state.min !== null && index < state.min) min = max - circleCount + 1;
    else max = min + circleCount - 1;
  }
  const needed = Math.max(0, max - min + 1 - oldCount);
  const affordable = Math.max(0, Math.floor(budget / profile.points));
  if (needed > affordable) {
    if (state.min === null) {
      min = requested >= state.origin ? firstIndex : firstIndex - affordable + 1;
      max = requested >= state.origin ? firstIndex + affordable - 1 : firstIndex;
    } else if (index < state.min) min = state.min - affordable;
    else max = state.max + affordable;
  }
  const count = Math.max(0, max - min + 1);
  const rotation = count >= circleCount ? requested : count ? Math.min(base + (max + 1) * profile.degrees,
    Math.max(base + min * profile.degrees, requested)) : state.origin;
  return { state: { ...state, last: rotation, min: count ? min : null, max: count ? max : null },
    rotation, cost: Math.max(0, count - oldCount) * profile.points, reached: Math.abs(rotation - requested) < 1e-6 };
}

export function rotationSectorBounds(state, cost) {
  if (!state || state.min === null || state.min === undefined) return null;
  const { degrees } = normalizeRotationCost(cost);
  const base = state.origin + (Number(state.offset) || 0);
  const min = base + state.min * degrees;
  return { min, max: min + Math.min(360, (state.max - state.min + 1) * degrees) };
}
