import { toInteger } from "../utils/numbers.mjs";

export const HAWK_EYE_PIERCING_DEFAULT_SETTINGS = Object.freeze({
  defenseIgnorePercent: 25,
  resistanceIgnorePercent: 25
});

export function normalizeHawkEyePiercingSettings(settings = {}) {
  return {
    defenseIgnorePercent: clampPercent(
      settings.defenseIgnorePercent,
      HAWK_EYE_PIERCING_DEFAULT_SETTINGS.defenseIgnorePercent
    ),
    resistanceIgnorePercent: clampPercent(
      settings.resistanceIgnorePercent,
      HAWK_EYE_PIERCING_DEFAULT_SETTINGS.resistanceIgnorePercent
    )
  };
}

/** Payload snapshotted onto an aimed attack and its damage requests. */
export function buildHawkEyePiercingModifier(actionKey = "", settings = {}) {
  if (String(actionKey ?? "").trim() !== "aimedShot") return null;
  return Object.freeze({
    ignoreAimedObstructions: true,
    ...normalizeHawkEyePiercingSettings(settings)
  });
}

/** Ignore a percentage of a positive mitigation layer before flat penetration. */
export function applyHawkEyeMitigationIgnore(rawMitigation = 0, ignorePercent = 0) {
  const mitigation = Number(rawMitigation) || 0;
  if (mitigation <= 0) return mitigation;
  const percent = clampPercent(ignorePercent, 0);
  return mitigation * (100 - percent) / 100;
}

export function applyHawkEyePiercingMitigation(raw = {}, settings = {}) {
  const normalized = normalizeHawkEyePiercingSettings(settings);
  return {
    defense: applyHawkEyeMitigationIgnore(raw?.defense, normalized.defenseIgnorePercent),
    resistance: applyHawkEyeMitigationIgnore(raw?.resistance, normalized.resistanceIgnorePercent)
  };
}

function clampPercent(value, fallback = 0) {
  const number = Number(value);
  return Math.max(0, Math.min(100, toInteger(Number.isFinite(number) ? number : fallback)));
}
