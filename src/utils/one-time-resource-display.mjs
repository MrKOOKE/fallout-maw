import { getOneTimeResourceValue } from "../combat/one-time-resources.mjs";
import { toInteger } from "./numbers.mjs";

export function supportsOneTimeResourceDisplay(key) {
  return typeof key === "string" && key.trim() !== "" && key !== "consciousness";
}

/** Decorate after the AP/RP turn-context switch so every field uses the shown key. */
export function decorateOneTimeResourceDisplay(actor, entry) {
  if (!supportsOneTimeResourceDisplay(entry?.key)) return entry;
  if (entry.oneTimeCounterDisplay) return entry;
  const min = toInteger(entry.min);
  const value = Math.max(min, toInteger(entry.value));
  const max = Math.max(min, toInteger(entry.max));
  const onceValue = getOneTimeResourceValue(actor, entry.key);
  const meterValue = value + onceValue;
  const meterMax = Math.max(max, Math.max(0, value) + onceValue);
  const positiveFloor = Math.max(0, min);
  const range = Math.max(1, meterMax - positiveFloor);
  const normalPercent = Math.min(100, Math.max(0, ((value - positiveFloor) / range) * 100));
  const oncePercent = Math.min(100, (onceValue / range) * 100);
  return {
    ...entry,
    inputName: `system.resources.${entry.key}.value`,
    oneTimeResource: true,
    oneTimeCounterDisplay: true,
    onceValue,
    valueLabel: onceValue > 0 ? `${onceValue} + ${value}` : value,
    maxLabel: max,
    meterValue,
    meterMax,
    meterStyle: onceValue > 0
      ? `${entry.meterStyle ?? ""}; --meter-sections: ${Math.max(1, Math.min(24, meterMax))}`
      : entry.meterStyle,
    fillStyle: onceValue > 0 && !entry.isNegative
      ? `${entry.fillStyle ?? ""}; width: ${normalPercent.toFixed(2)}%`
      : entry.fillStyle,
    oneTimeFillStyle: [
      `left: ${normalPercent.toFixed(2)}%`,
      `width: ${oncePercent.toFixed(2)}%`,
      "background: linear-gradient(180deg, #b9d9ff, #78aee8)",
      "box-shadow: inset 0 1px 0 rgba(255,255,255,0.28), 0 0 14px rgba(118,185,255,0.48)"
    ].join("; ")
  };
}
