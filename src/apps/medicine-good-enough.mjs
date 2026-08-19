import { toInteger } from "../utils/numbers.mjs";

export const GOOD_ENOUGH_NO_TOOL_ID = "__goodEnough__";

export function getLimbConditionPercent(limb) {
  const max = Math.max(1, toInteger(limb?.max));
  const value = Math.min(max, Math.max(0, toInteger(limb?.value)));
  return (value / max) * 100;
}

export function isGoodEnoughHealingFree(limb, settings = {}) {
  return getLimbConditionPercent(limb) > Number(settings.freeConditionThreshold ?? 90);
}

export function getGoodEnoughEnergyCost(limb, healedAmount, settings = {}) {
  const healing = Math.max(0, toInteger(healedAmount));
  if (!healing || isGoodEnoughHealingFree(limb, settings)) return 0;
  return Math.ceil(healing / getHealthPerEnergy(settings));
}

export function getGoodEnoughHealingCapacity(energy, settings = {}) {
  return Math.floor(Math.max(0, toInteger(energy)) * getHealthPerEnergy(settings));
}

function getHealthPerEnergy(settings) {
  return Math.max(1, Number(settings?.healthPerEnergy) || 10);
}
