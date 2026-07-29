export const NEED_GROWTH_RESISTANCE_FIELD = "growthResistancePercent";
export const NEED_SATISFACTION_EFFECTIVENESS_FIELD = "satisfactionEffectivenessPercent";

const NEED_CHANGE_MODIFIER_KEY_PATTERN = new RegExp(
  `^system\\.needs\\.[^.]+\\.(?:${NEED_GROWTH_RESISTANCE_FIELD}|${NEED_SATISFACTION_EFFECTIVENESS_FIELD})$`
);

export function getNeedGrowthResistanceEffectKey(needKey = "") {
  return getNeedChangeModifierEffectKey(needKey, NEED_GROWTH_RESISTANCE_FIELD);
}

export function getNeedSatisfactionEffectivenessEffectKey(needKey = "") {
  return getNeedChangeModifierEffectKey(needKey, NEED_SATISFACTION_EFFECTIVENESS_FIELD);
}

export function getNeedChangeModifierEffectKeys(needKey = "") {
  const growthResistance = getNeedGrowthResistanceEffectKey(needKey);
  const satisfactionEffectiveness = getNeedSatisfactionEffectivenessEffectKey(needKey);
  return new Set([growthResistance, satisfactionEffectiveness].filter(Boolean));
}

export function isNeedChangeModifierEffectKey(key = "") {
  return NEED_CHANGE_MODIFIER_KEY_PATTERN.test(String(key ?? "").trim());
}

function getNeedChangeModifierEffectKey(needKey = "", field = "") {
  const key = String(needKey ?? "").trim();
  return key && !key.includes(".") ? `system.needs.${key}.${field}` : "";
}
