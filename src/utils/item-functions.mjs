export const ITEM_FUNCTIONS = {
  container: "container",
  damageMitigation: "damageMitigation",
  toolPrefix: "tool:"
};

export const DAMAGE_MITIGATION_MODES = {
  defense: "defense",
  resistance: "resistance"
};

export function getItemSystem(itemOrSystem = null) {
  return itemOrSystem?.system ?? itemOrSystem ?? {};
}

export function hasItemFunction(itemOrSystem = null, functionKey = "") {
  const system = getItemSystem(itemOrSystem);
  if (functionKey === ITEM_FUNCTIONS.container && String(system.itemFunction ?? "") === ITEM_FUNCTIONS.container) {
    return true;
  }
  const toolKey = getToolKeyFromFunctionKey(functionKey);
  if (toolKey) return hasToolFunction(system, toolKey);
  return Boolean(system.functions?.[functionKey]?.enabled);
}

export function getDamageMitigationFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.damageMitigation] ?? {};
}

export function createToolFunctionKey(toolKey = "") {
  return `${ITEM_FUNCTIONS.toolPrefix}${toolKey}`;
}

export function getToolKeyFromFunctionKey(functionKey = "") {
  const key = String(functionKey ?? "");
  if (!key.startsWith(ITEM_FUNCTIONS.toolPrefix)) return "";
  return key.slice(ITEM_FUNCTIONS.toolPrefix.length);
}

export function hasToolFunction(itemOrSystem = null, toolKey = "") {
  const system = getItemSystem(itemOrSystem);
  return Boolean(system.functions?.tools?.[toolKey]?.enabled);
}

export function getToolFunction(itemOrSystem = null, toolKey = "") {
  return getItemSystem(itemOrSystem).functions?.tools?.[toolKey] ?? {};
}
