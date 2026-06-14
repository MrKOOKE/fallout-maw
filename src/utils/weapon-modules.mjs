import { ITEM_FUNCTIONS, getModuleFunction, hasItemFunction } from "./item-functions.mjs";
import { toInteger } from "./numbers.mjs";
import { resolveWorldItemSync } from "./world-items.mjs";

export const WEAPON_MODULE_ACTION_KEYS = Object.freeze([
  "aimedShot",
  "snapshot",
  "burst",
  "volley",
  "meleeAttack",
  "aimedMeleeAttack",
  "push",
  "reload"
]);

export function isWeaponModuleItem(itemOrData = null) {
  return hasItemFunction(itemOrData, ITEM_FUNCTIONS.module)
    && String(getModuleFunction(itemOrData).targetFunction ?? "weapon") === "weapon";
}

export function getWeaponModuleTechnicalName(itemOrData = null) {
  const name = String(getModuleFunction(itemOrData).name ?? "").trim();
  return name || String(itemOrData?.name ?? "").trim();
}

export function getWeaponModuleDisplayName(itemOrData = null) {
  const name = String(itemOrData?.name ?? "").trim();
  return name || getWeaponModuleTechnicalName(itemOrData);
}

export function getWeaponModuleSlots(weaponData = {}) {
  const slots = Array.isArray(weaponData?.moduleSlots) ? weaponData.moduleSlots : [];
  return slots.map((slot, index) => ({
    id: String(slot?.id ?? "") || `slot-${index + 1}`,
    moduleKey: String(slot?.moduleKey ?? "").trim(),
    itemUuid: String(slot?.itemUuid ?? "").trim(),
    itemData: slot?.itemData && typeof slot.itemData === "object" ? slot.itemData : {}
  }));
}

export function getWeaponModuleSlotItemData(slot = {}) {
  if (slot?.itemData?.system) return slot.itemData;
  const item = getWeaponModuleSlotItem(slot);
  return item?.toObject?.() ?? null;
}

export function getWeaponModuleSlotItem(slot = {}) {
  const uuid = String(slot?.itemUuid ?? "").trim();
  if (!uuid) return null;
  return resolveWorldItemSync(uuid);
}

export function isModuleItemCompatibleWithSlot(itemOrData = null, slot = {}) {
  if (!isWeaponModuleItem(itemOrData)) return false;
  const slotKey = String(slot?.moduleKey ?? "").trim();
  if (!slotKey) return true;
  return getWeaponModuleTechnicalName(itemOrData) === slotKey;
}

export function getInstalledWeaponModuleItems(weaponData = {}, { moduleSlots = null } = {}) {
  const slots = Array.isArray(moduleSlots) ? moduleSlots : getWeaponModuleSlots(weaponData);
  return slots
    .map(slot => getWeaponModuleSlotItemData(slot))
    .filter(itemData => itemData?.system && isWeaponModuleItem(itemData));
}

export function applyWeaponModuleModifiers(weaponData = {}, options = {}) {
  const modules = getInstalledWeaponModuleItems(weaponData, options);
  if (!modules.length) return weaponData;

  const result = foundry.utils.deepClone(weaponData);
  for (const itemData of modules) applySingleWeaponModule(result, getModuleFunction(itemData).weapon ?? {});
  return result;
}

function applySingleWeaponModule(weaponData, modifiers = {}) {
  addFormulaNumber(weaponData, "damage", modifiers.damage, { integer: true, min: 0 });
  addFormulaNumber(weaponData, "accuracyBonus", modifiers.accuracyBonus, { integer: true });
  addFormulaNumber(weaponData, "criticalChanceModifier", modifiers.criticalChanceModifier, { integer: true });
  addFormulaNumber(weaponData, "criticalDamagePercent", modifiers.criticalDamagePercent, { integer: true, min: 0 });
  addNumber(weaponData, "attackConeDegrees", modifiers.attackConeDegrees, { min: 0 });
  addFormulaNumber(weaponData, "maxRangeMeters", modifiers.maxRangeMeters, { min: 0 });
  addFormulaNumber(weaponData, "effectiveRange.value", modifiers.effectiveRange?.value, { min: 0 });
  addFormulaNumber(weaponData, "effectiveRange.max", modifiers.effectiveRange?.max, { min: 0 });
  addFormulaNumber(weaponData, "penetration", modifiers.penetration, { integer: true, min: 0 });
  addNumber(weaponData, "magazine.max", modifiers.magazineMax, { integer: true, min: 0 });

  for (const actionKey of WEAPON_MODULE_ACTION_KEYS) {
    addNumber(weaponData, `${actionKey}.actionPointCost`, modifiers.actionPointCosts?.[actionKey], { integer: true, min: 0 });
  }
}

function addFormulaNumber(target, path, delta, { integer = false, min = null } = {}) {
  const change = integer ? toInteger(delta) : Number(delta);
  if (!Number.isFinite(change) || change === 0) return;
  const currentRaw = foundry.utils.getProperty(target, path);
  const current = Number(currentRaw);
  if (Number.isFinite(current)) {
    const next = Number.isFinite(Number(min)) ? Math.max(Number(min), current + change) : current + change;
    foundry.utils.setProperty(target, path, integer ? Math.trunc(next) : next);
    return;
  }
  const currentText = normalizeFormulaText(currentRaw);
  const changeText = String(integer ? Math.trunc(change) : change);
  foundry.utils.setProperty(target, path, currentText === "0" ? changeText : `(${currentText}) + (${changeText})`);
}

function addNumber(target, path, delta, { integer = false, min = null } = {}) {
  const change = integer ? toInteger(delta) : Number(delta);
  if (!Number.isFinite(change) || change === 0) return;
  const currentRaw = foundry.utils.getProperty(target, path);
  const current = integer ? toInteger(currentRaw) : Number(currentRaw);
  const fallback = Number.isFinite(current) ? current : 0;
  let next = fallback + change;
  if (Number.isFinite(Number(min))) next = Math.max(Number(min), next);
  foundry.utils.setProperty(target, path, integer ? Math.trunc(next) : next);
}

function normalizeFormulaText(value, fallback = "0") {
  const text = String(value ?? "").trim();
  return text || fallback;
}
