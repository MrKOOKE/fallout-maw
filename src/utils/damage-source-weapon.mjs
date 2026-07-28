import { toInteger } from "./numbers.mjs";
import { getWeaponNoiseLevel } from "./weapon-modules.mjs";

export function resolveDamageSourceAnimationKey(weaponAnimationKey = "", sourceAnimationKey = "") {
  const weaponKey = String(weaponAnimationKey ?? "").trim();
  return weaponKey || String(sourceAnimationKey ?? "").trim();
}

export function getDamageSourceAdjustedNoiseLevel(weaponData = {}, damageSource = {}) {
  return Math.max(0, getWeaponNoiseLevel(weaponData) + toInteger(damageSource?.noiseLevel));
}
