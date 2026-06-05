export const ITEM_FUNCTIONS = {
  container: "container",
  damageMitigation: "damageMitigation",
  damageSource: "damageSource",
  freeSettings: "freeSettings",
  condition: "condition",
  constructPart: "constructPart",
  firstAid: "firstAid",
  weapon: "weapon",
  module: "module",
  prosthesis: "prosthesis",
  tool: "tool",
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
  if (functionKey === ITEM_FUNCTIONS.tool) return hasUnifiedToolFunction(system) || hasLegacyToolFunction(system);
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

export function getConstructPartFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.constructPart] ?? {};
}

export function getDamageSourceFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.damageSource] ?? {};
}

export function getFirstAidFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.firstAid] ?? {};
}

export function getFirstAidChargesData(itemOrSystem = null) {
  const firstAid = getFirstAidFunction(itemOrSystem);
  const max = Math.max(1, toWholeNumber(firstAid?.charges?.max, 1));
  const rawValue = firstAid?.charges?.value;
  const value = rawValue === undefined || rawValue === null || rawValue === ""
    ? max
    : Math.max(0, Math.min(max, toWholeNumber(rawValue, max)));
  return { value, max };
}

export function getModuleFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.module] ?? {};
}

export function getProsthesisFunction(itemOrSystem = null) {
  return getItemSystem(itemOrSystem).functions?.[ITEM_FUNCTIONS.prosthesis] ?? {};
}

export function getProsthesisLimbKeys(itemOrSystem = null) {
  return new Set(
    (getProsthesisFunction(itemOrSystem).limbKeys ?? [])
      .map(key => String(key ?? "").trim())
      .filter(Boolean)
  );
}

export function isProsthesisForLimb(itemOrSystem = null, limbKey = "") {
  const key = String(limbKey ?? "").trim();
  if (!key || !hasItemFunction(itemOrSystem, ITEM_FUNCTIONS.prosthesis)) return false;
  return getProsthesisLimbKeys(itemOrSystem).has(key);
}

export function isInstalledProsthesis(itemOrSystem = null, limbKey = "") {
  const system = getItemSystem(itemOrSystem);
  if (!hasItemFunction(system, ITEM_FUNCTIONS.prosthesis)) return false;
  if (String(system.placement?.mode ?? "") !== "prosthesis") return false;
  const key = String(limbKey ?? "").trim();
  return !key || String(system.placement?.limbKey ?? "").trim() === key;
}

export function isActiveItem(itemOrSystem = null) {
  return hasItemFunction(itemOrSystem, ITEM_FUNCTIONS.firstAid);
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
  if (parseModuleWeaponFunctionId(id)) return "";
  return `system.functions.additionalWeapons.${id}`;
}

export function createWeaponFunctionUpdateData(itemOrSystem = null, functionId = "", relativeUpdates = {}) {
  const id = String(functionId || ITEM_FUNCTIONS.weapon);
  const moduleId = parseModuleWeaponFunctionId(id);
  if (!moduleId) {
    const path = getWeaponFunctionUpdatePath(itemOrSystem, id);
    if (!path) return {};
    return Object.fromEntries(
      Object.entries(relativeUpdates ?? {}).map(([key, value]) => [`${path}.${key}`, value])
    );
  }

  const slotIndex = findWeaponModuleSlotIndex(itemOrSystem, moduleId.slotId);
  if (slotIndex < 0) return {};
  const primary = getWeaponFunction(itemOrSystem);
  const slots = foundry.utils.deepClone(Array.isArray(primary?.moduleSlots) ? primary.moduleSlots : []);
  const slot = slots[slotIndex];
  const sourceItemData = slot?.itemData?.system ? slot.itemData : getWeaponModuleSlotItemData(slot);
  if (!sourceItemData?.system) return {};
  const itemData = foundry.utils.deepClone(sourceItemData);

  if (!applyModuleWeaponFunctionRelativeUpdates(itemData, moduleId.actionId, relativeUpdates)) return {};
  slots[slotIndex] = { ...slot, itemData };
  return {
    "system.functions.weapon.moduleSlots": slots
  };
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
  const selectedKey = getSelectedToolFunctionKey(system);
  if (hasUnifiedToolFunction(system)) return selectedKey === String(toolKey ?? "");
  return Boolean(system.functions?.tools?.[toolKey]?.enabled);
}

export function getToolFunction(itemOrSystem = null, toolKey = "") {
  return getItemSystem(itemOrSystem).functions?.tools?.[toolKey] ?? {};
}

export function getEnabledToolFunctions(itemOrSystem = null) {
  const system = getItemSystem(itemOrSystem);
  const tools = system.functions?.tools;
  if (!tools || typeof tools !== "object") return [];

  const selectedKey = getSelectedToolFunctionKey(system);
  if ((hasUnifiedToolFunction(system) || hasLegacyToolFunction(system)) && selectedKey) {
    return [{ ...(tools[selectedKey] ?? {}), enabled: true, toolKey: selectedKey }];
  }

  return Object.entries(tools)
    .filter(([, data]) => data?.enabled)
    .map(([toolKey, data]) => ({ ...data, toolKey }));
}

export function getSelectedToolFunctionKey(itemOrSystem = null) {
  const system = getItemSystem(itemOrSystem);
  const configured = String(system.functions?.tool?.toolKey ?? "").trim();
  if (configured) return configured;
  const legacyEnabled = Object.entries(system.functions?.tools ?? {})
    .find(([, data]) => data?.enabled)?.[0];
  return String(legacyEnabled ?? "");
}

function hasUnifiedToolFunction(system = {}) {
  return Boolean(system.functions?.tool?.enabled);
}

function hasLegacyToolFunction(system = {}) {
  return Object.values(system.functions?.tools ?? {}).some(data => data?.enabled);
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

function applyModuleWeaponFunctionRelativeUpdates(itemData = {}, actionId = "", relativeUpdates = {}) {
  const id = String(actionId ?? "").trim();
  if (!id) return false;
  const containerPath = "system.functions.module.additionalWeapons";
  const additionalWeapons = foundry.utils.getProperty(itemData, containerPath);
  if (Array.isArray(additionalWeapons)) {
    const entries = foundry.utils.deepClone(additionalWeapons);
    const index = entries.findIndex((entry, entryIndex) => String(entry?.id || `legacy${entryIndex}`) === id);
    if (index < 0) return false;
    applyRelativeUpdates(entries[index], relativeUpdates);
    foundry.utils.setProperty(itemData, containerPath, entries);
    return true;
  }
  if (!additionalWeapons || typeof additionalWeapons !== "object") return false;
  const actionData = foundry.utils.deepClone(additionalWeapons[id] ?? {});
  if (!actionData || typeof actionData !== "object") return false;
  applyRelativeUpdates(actionData, relativeUpdates);
  foundry.utils.setProperty(itemData, `${containerPath}.${id}`, actionData);
  return true;
}

function applyRelativeUpdates(target = {}, relativeUpdates = {}) {
  for (const [path, value] of Object.entries(relativeUpdates ?? {})) {
    foundry.utils.setProperty(target, path, foundry.utils.deepClone(value));
  }
}

function getWeaponModuleSlotItemData(slot = {}) {
  if (slot?.itemData?.system) return slot.itemData;
  const uuid = String(slot?.itemUuid ?? "").trim();
  if (!uuid) return null;
  const item = globalThis.fromUuidSync?.(uuid) ?? foundry.utils.fromUuidSync?.(uuid) ?? null;
  return item?.toObject?.() ?? null;
}

function toWholeNumber(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}
