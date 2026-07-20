import { toInteger } from "./numbers.mjs";

/**
 * Resolve the numeric state used by the actor-sheet indicator meters.
 * Keeping this calculation independent from the sheet lets formulas use the
 * exact same percentage which is shown to the player.
 */
export function getIndicatorValueState(data = {}, { integer = true } = {}) {
  const normalize = integer ? toInteger : toFiniteNumber;
  const min = normalize(data?.min);
  const max = Math.max(min, normalize(data?.max));
  const scaleMax = Math.max(min, normalize(data?.scaleMax ?? data?.max));
  const fallbackValue = Number.isFinite(Number(data?.value))
    ? data.value
    : max - Math.max(0, normalize(data?.spent));
  const value = Math.min(Math.max(normalize(fallbackValue), min), Math.max(max, scaleMax));
  const negativeRange = min < 0 ? Math.abs(min) : 0;
  const positiveFloor = Math.max(0, min);
  const positiveRange = Math.max(0, scaleMax - positiveFloor);
  const isNegative = value < 0 && negativeRange > 0;
  const percent = isNegative
    ? ((Math.abs(value) / negativeRange) * 100)
    : (positiveRange > 0 ? (((Math.max(value, positiveFloor) - positiveFloor) / positiveRange) * 100) : 0);

  return {
    min,
    max,
    scaleMax,
    value,
    negativeRange,
    positiveFloor,
    positiveRange,
    isNegative,
    percent: Math.max(0, Math.min(100, percent))
  };
}

export function getIndicatorPercent(data = {}) {
  return getIndicatorValueState(data).percent;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
