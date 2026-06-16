export const DODGE_LOSS_MODIFIER_EFFECT_KEY = "fallout-maw.dodge.loss";
export const DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY = "fallout-maw.dodge.roundRecovery";

export function isDodgeAmountModifierEffectKey(key = "") {
  const path = String(key ?? "").trim();
  return path === DODGE_LOSS_MODIFIER_EFFECT_KEY
    || path === DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY;
}
