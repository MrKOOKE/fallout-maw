export const ALL_TOOL_SUPPLY_COST_EFFECT_KEY = "fallout-maw.tools.supplyCost.all";
export const TOOL_SUPPLY_COST_EFFECT_KEY_PREFIX = "fallout-maw.tools.supplyCost.";

export function getToolSupplyCostEffectKey(toolKey = "") {
  const key = String(toolKey ?? "").trim();
  return key ? `${TOOL_SUPPLY_COST_EFFECT_KEY_PREFIX}${key}` : "";
}

export function getToolKeyFromSupplyCostEffectKey(effectKey = "") {
  const key = String(effectKey ?? "").trim();
  if (!key.startsWith(TOOL_SUPPLY_COST_EFFECT_KEY_PREFIX)) return "";
  return key.slice(TOOL_SUPPLY_COST_EFFECT_KEY_PREFIX.length).trim();
}

export function isToolSupplyCostEffectKey(effectKey = "") {
  return Boolean(getToolKeyFromSupplyCostEffectKey(effectKey));
}
