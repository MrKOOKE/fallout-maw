export const ITEM_FUNCTIONS = {
  container: "container",
  damageMitigation: "damageMitigation",
  damageSource: "damageSource",
  condition: "condition",
  weapon: "weapon",
  module: "module",
  toolPrefix: "tool:"
};
export const MODULE_WEAPON_FUNCTION_ID_PREFIX = "module:";

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

export function getDamageSourceFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.damageSource] ?? {};
}

export function getModuleFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.module] ?? {};
}

export function getConditionWeakeningData(itemOrSystem = null, { minimumRatio = 0 } = {}) {
  if (!hasItemFunction(itemOrSystem, ITEM_FUNCTIONS.condition)) {
    return { current: 0, max: 0, threshold: 20, steps: 0, ratio: 1, active: false };
  }
  const condition = getConditionFunction(itemOrSystem);
  const current = Math.max(0, Math.trunc(Number(condition.value) || 0));
  const max = Math.max(0, Math.trunc(Number(condition.max) || 0));
  const threshold = Math.max(1, Math.trunc(Number(condition.weakeningThreshold) || 20));
  if (max <= 0) return { current, max, threshold, steps: 0, ratio: 1, active: true };

  const lostPercent = Math.max(0, (1 - (current / max)) * 100);
  const steps = Math.max(0, Math.floor(lostPercent / threshold));
  const floor = Math.max(0, Math.min(1, Number(minimumRatio) || 0));
  const ratio = Math.max(floor, 1 - (steps * 0.1));
  return { current, max, threshold, steps, ratio, active: true };
}

export function getWeaponFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.weapon] ?? {};
}

export function getAdditionalWeaponFunctions(itemOrSystem = null) {
  const functions = getItemSystem(itemOrSystem).functions?.additionalWeapons;
  return normalizeWeaponFunctionEntries(functions).map(({ id, data }) => ({ ...data, id }));
}

export function getWeaponFunctionById(itemOrSystem = null, functionId = "") {
  const id = String(functionId ?? "");
  if (!id || id === ITEM_FUNCTIONS.weapon) return getWeaponFunction(itemOrSystem);
  const additional = getAdditionalWeaponFunctions(itemOrSystem).find(entry => String(entry?.id ?? "") === id);
  if (additional) return additional;
  return getInstalledModuleWeaponFunctions(itemOrSystem).find(entry => String(entry?.id ?? "") === id)?.data ?? null;
}

export function getEnabledWeaponFunctions(itemOrSystem = null) {
  const primary = getWeaponFunction(itemOrSystem);
  if (!primary?.enabled) return [];
  const additional = getAdditionalWeaponFunctions(itemOrSystem)
    .filter(entry => entry?.enabled)
    .map((entry, index) => ({
      id: String(entry.id ?? ""),
      isPrimary: false,
      canHaveModuleSlots: false,
      index,
      name: String(entry.name ?? ""),
      data: entry
    }))
    .filter(entry => entry.id);
  const moduleWeapons = getInstalledModuleWeaponFunctions(itemOrSystem)
    .filter(entry => entry?.data?.enabled)
    .map((entry, index) => ({
      ...entry,
      isPrimary: false,
      isModuleWeapon: true,
      canHaveModuleSlots: false,
      index: additional.length + index
    }))
    .filter(entry => entry.id);
  return [
    {
      id: ITEM_FUNCTIONS.weapon,
      isPrimary: true,
      canHaveModuleSlots: true,
      name: "",
      data: primary
    },
    ...additional,
    ...moduleWeapons
  ];
}

export function createModuleWeaponFunctionId(slotId = "", actionId = "") {
  const slotKey = String(slotId ?? "").trim();
  const actionKey = String(actionId ?? "").trim();
  if (!slotKey || !actionKey) return "";
  return `${MODULE_WEAPON_FUNCTION_ID_PREFIX}${slotKey}:${actionKey}`;
}

export function parseModuleWeaponFunctionId(functionId = "") {
  const id = String(functionId ?? "");
  if (!id.startsWith(MODULE_WEAPON_FUNCTION_ID_PREFIX)) return null;
  const rest = id.slice(MODULE_WEAPON_FUNCTION_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator >= rest.length - 1) return null;
  return {
    slotId: rest.slice(0, separator),
    actionId: rest.slice(separator + 1)
  };
}

export function getWeaponFunctionModuleSlots(itemOrSystem = null, functionId = "") {
  const primary = getWeaponFunction(itemOrSystem);
  const id = String(functionId || ITEM_FUNCTIONS.weapon);
  if (!primary?.enabled) return [];
  return id === ITEM_FUNCTIONS.weapon && Array.isArray(primary.moduleSlots) ? primary.moduleSlots : [];
}

export function getWeaponFunctionUpdatePath(itemOrSystem = null, functionId = "") {
  const id = String(functionId || ITEM_FUNCTIONS.weapon);
  if (!id || id === ITEM_FUNCTIONS.weapon) return "system.functions.weapon";
  const moduleId = parseModuleWeaponFunctionId(id);
  if (moduleId) {
    const slotIndex = findWeaponModuleSlotIndex(itemOrSystem, moduleId.slotId);
    if (slotIndex < 0) return "";
    return `system.functions.weapon.moduleSlots.${slotIndex}.itemData.system.functions.module.additionalWeapons.${moduleId.actionId}`;
  }
  return `system.functions.additionalWeapons.${id}`;
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

function getInstalledModuleWeaponFunctions(itemOrSystem = null) {
  const primary = getWeaponFunction(itemOrSystem);
  const slots = Array.isArray(primary?.moduleSlots) ? primary.moduleSlots : [];
  return slots.flatMap((slot, slotIndex) => {
    const itemData = getWeaponModuleSlotItemData(slot);
    const module = getModuleFunction(itemData);
    if (!module?.enabled || String(module.targetFunction ?? "weapon") !== "weapon") return [];
    const slotId = String(slot?.id ?? "") || `slot-${slotIndex + 1}`;
    return normalizeWeaponFunctionEntries(module.additionalWeapons)
      .filter(({ id }) => id)
      .map(({ id, data }, index) => ({
        id: createModuleWeaponFunctionId(slotId, id),
        sourceId: id,
        moduleSlotId: slotId,
        moduleSlotIndex: slotIndex,
        moduleItemName: String(itemData?.name ?? "").trim(),
        index,
        name: String(data?.name ?? "").trim(),
        data: {
          ...data,
          id: createModuleWeaponFunctionId(slotId, id)
        }
      }));
  });
}

function normalizeWeaponFunctionEntries(functions = null) {
  if (Array.isArray(functions)) {
    return functions
      .map((data, index) => ({
        id: String(data?.id || `legacy${index}`),
        data: {
          ...data,
          id: String(data?.id || `legacy${index}`)
        }
      }))
      .filter(entry => entry.id);
  }
  if (!functions || typeof functions !== "object") return [];
  return Object.entries(functions)
    .map(([id, data]) => ({
      id: String(id),
      data: {
        ...data,
        id: String(data?.id || id)
      }
    }))
    .filter(entry => entry.id);
}

function findWeaponModuleSlotIndex(itemOrSystem = null, slotId = "") {
  const id = String(slotId ?? "");
  if (!id) return -1;
  const slots = Array.isArray(getWeaponFunction(itemOrSystem)?.moduleSlots)
    ? getWeaponFunction(itemOrSystem).moduleSlots
    : [];
  return slots.findIndex((slot, index) => (String(slot?.id ?? "") || `slot-${index + 1}`) === id);
}

function getWeaponModuleSlotItemData(slot = {}) {
  if (slot?.itemData?.system) return slot.itemData;
  const uuid = String(slot?.itemUuid ?? "").trim();
  if (!uuid) return null;
  const item = globalThis.fromUuidSync?.(uuid) ?? foundry.utils.fromUuidSync?.(uuid) ?? null;
  return item?.toObject?.() ?? null;
}
