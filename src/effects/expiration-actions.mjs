import { SYSTEM_ID } from "../constants.mjs";

export const EFFECT_EXPIRATION_ACTION_FLAG_KEY = "onExpire";
export const EFFECT_EXPIRATION_ACTIONS = Object.freeze({
  deleteBearer: "deleteBearer"
});

export function buildBearerExpirationEffectData({
  name = "Истечение срока",
  img = "icons/svg/clockwork.svg",
  durationSeconds = 1,
  startTime = 0,
  origin = ""
} = {}) {
  return {
    type: "base",
    name: String(name || "Истечение срока"),
    img: String(img || "icons/svg/clockwork.svg"),
    origin: String(origin || ""),
    transfer: false,
    disabled: false,
    showIcon: 0,
    start: { time: Number(startTime) || 0 },
    duration: {
      value: Math.max(1, Math.trunc(Number(durationSeconds) || 1)),
      units: "seconds",
      expiry: null,
      expired: false
    },
    system: { changes: [] },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [EFFECT_EXPIRATION_ACTION_FLAG_KEY]: EFFECT_EXPIRATION_ACTIONS.deleteBearer
      }
    }
  };
}

export function getEffectExpirationAction(effect = null) {
  return String(
    effect?.getFlag?.(SYSTEM_ID, EFFECT_EXPIRATION_ACTION_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[EFFECT_EXPIRATION_ACTION_FLAG_KEY]
    ?? effect?._source?.flags?.[SYSTEM_ID]?.[EFFECT_EXPIRATION_ACTION_FLAG_KEY]
    ?? ""
  );
}

export function isEffectActuallyExpired(effect = null) {
  if (!effect || effect.parent?.documentName !== "Item") return false;
  const remaining = Number(effect.duration?.remaining);
  if (Number.isFinite(remaining)) return remaining <= 0;
  return effect.duration?.expired === true || effect._source?.duration?.expired === true;
}
