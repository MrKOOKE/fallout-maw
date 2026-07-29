import { toInteger } from "./numbers.mjs";
import { getWeaponNoiseLevel } from "./weapon-modules.mjs";
import {
  WEAPON_SPECIAL_PROPERTIES,
  getWeaponSpecialPropertyType,
  normalizeWeaponSpecialProperties
} from "./item-functions.mjs";

export function resolveDamageSourceAnimationKey(weaponAnimationKey = "", sourceAnimationKey = "") {
  const weaponKey = String(weaponAnimationKey ?? "").trim();
  return weaponKey || String(sourceAnimationKey ?? "").trim();
}

export function getDamageSourceAdjustedNoiseLevel(weaponData = {}, damageSource = {}) {
  return Math.max(0, getWeaponNoiseLevel(weaponData) + toInteger(damageSource?.noiseLevel));
}

/**
 * Add properties supplied by ammunition or another damage source without
 * replacing an explicitly configured property of the same type on the weapon.
 */
export function mergeDamageSourceSpecialProperties(weaponData = {}, damageSource = {}) {
  const weaponProperties = normalizeWeaponSpecialProperties(weaponData?.specialProperties);
  const inheritedTypes = new Set(
    weaponProperties
      .map(property => getWeaponSpecialPropertyType(property))
      .filter(type => type && type !== WEAPON_SPECIAL_PROPERTIES.pending)
  );
  const inheritedProperties = [];

  for (const property of normalizeWeaponSpecialProperties(damageSource?.specialProperties)) {
    const type = getWeaponSpecialPropertyType(property);
    if (!type || type === WEAPON_SPECIAL_PROPERTIES.pending || inheritedTypes.has(type)) continue;
    inheritedTypes.add(type);
    inheritedProperties.push(property);
  }

  return [...weaponProperties, ...inheritedProperties];
}
