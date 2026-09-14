import { ITEM_FUNCTIONS, getDamageMitigationFunction, getEnabledWeaponFunctions, hasItemFunction } from "./item-functions.mjs";
import { getWeaponModuleSlots } from "./weapon-modules.mjs";

/** A module transfer needs one tooltip refresh after all document callbacks. */
export class ModuleTooltipMutation {
  active = false;

  async run(operation, refresh) {
    if (this.active) return;
    this.active = true;
    try {
      return await operation();
    } finally {
      try {
        // Also show the resulting state after a failed or rolled-back mutation.
        await refresh();
      } finally {
        this.active = false;
      }
    }
  }
}

export function getProtectionModuleTooltipEntry(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation, { ignoreBroken: true })) return null;
  return {
    id: ITEM_FUNCTIONS.damageMitigation,
    targetFunction: ITEM_FUNCTIONS.damageMitigation,
    canHaveModuleSlots: true,
    data: getDamageMitigationFunction(item)
  };
}

export function getModuleTooltipTargetFunction(entry = null) {
  return entry?.targetFunction === ITEM_FUNCTIONS.damageMitigation ? ITEM_FUNCTIONS.damageMitigation : ITEM_FUNCTIONS.weapon;
}

export function getModuleTooltipPickerKey(dataset = {}) {
  const target = dataset.tooltipModuleTarget === ITEM_FUNCTIONS.damageMitigation ? ITEM_FUNCTIONS.damageMitigation : ITEM_FUNCTIONS.weapon;
  return `${target}:${Math.max(0, Math.trunc(Number(dataset.tooltipWeaponIndex) || 0))}:${Math.max(0, Math.trunc(Number(dataset.tooltipModuleSlotIndex) || 0))}`;
}

/** Rendered controls identify a function as well as its slot, including on broken gear. */
export function getModuleTooltipSlotContext(item, dataset = {}) {
  const weaponIndex = Math.max(0, Math.trunc(Number(dataset.tooltipWeaponIndex) || 0));
  const slotIndex = Math.max(0, Math.trunc(Number(dataset.tooltipModuleSlotIndex) || 0));
  const entry = dataset.tooltipModuleTarget === ITEM_FUNCTIONS.damageMitigation
    ? getProtectionModuleTooltipEntry(item)
    : (item ? getEnabledWeaponFunctions(item, { ignoreBroken: true })[weaponIndex] : null);
  const slot = entry?.canHaveModuleSlots ? getWeaponModuleSlots(entry.data)[slotIndex] ?? null : null;
  return { entry, weaponIndex, slotIndex, slot };
}
