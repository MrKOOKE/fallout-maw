export const HEALTH_REGENERATION_EFFECT_KEY = "fallout-maw.regeneration.health";
export const ENERGY_REGENERATION_EFFECT_KEY = "fallout-maw.regeneration.energy";

export function isRegenerationEffectKey(key = "") {
  const path = String(key ?? "").trim();
  return path === HEALTH_REGENERATION_EFFECT_KEY || path === ENERGY_REGENERATION_EFFECT_KEY;
}
