export const ITEM_FUNCTIONS = {
  container: "container",
  damageMitigation: "damageMitigation",
  condition: "condition",
  weapon: "weapon",
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

export function getConditionFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.condition] ?? {};
}

export function getWeaponFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.weapon] ?? {};
}

export function getAdditionalWeaponFunctions(itemOrSystem = null) {
  const functions = getItemSystem(itemOrSystem).functions?.additionalWeapons;
  if (Array.isArray(functions)) return functions;
  if (!functions || typeof functions !== "object") return [];
  return Object.entries(functions).map(([id, data]) => ({
    ...data,
    id: String(id)
  }));
}

export function getWeaponFunctionById(itemOrSystem = null, functionId = "") {
  const id = String(functionId ?? "");
  if (!id || id === ITEM_FUNCTIONS.weapon) return getWeaponFunction(itemOrSystem);
  return getAdditionalWeaponFunctions(itemOrSystem).find(entry => String(entry?.id ?? "") === id) ?? null;
}

export function getEnabledWeaponFunctions(itemOrSystem = null) {
  const primary = getWeaponFunction(itemOrSystem);
  if (!primary?.enabled) return [];
  return [
    {
      id: ITEM_FUNCTIONS.weapon,
      isPrimary: true,
      name: "",
      data: primary
    },
    ...getAdditionalWeaponFunctions(itemOrSystem)
      .filter(entry => entry?.enabled)
      .map((entry, index) => ({
        id: String(entry.id ?? ""),
        isPrimary: false,
        index,
        name: String(entry.name ?? ""),
        data: entry
      }))
      .filter(entry => entry.id)
  ];
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
