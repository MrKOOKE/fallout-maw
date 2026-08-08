export function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

export function toOptionalFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function clampNumber(value, min, max) {
  const numericValue = Number(value);
  const lower = Number.isFinite(Number(min)) ? Number(min) : 0;
  const upper = Math.max(Number(max) || lower, lower);
  return Math.min(Math.max(Number.isFinite(numericValue) ? numericValue : lower, lower), upper);
}
