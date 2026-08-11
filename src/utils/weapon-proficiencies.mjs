import {
  getProficiencyInfluenceSettings,
  getProficiencySettings
} from "../settings/accessors.mjs";
import {
  calculateWeaponProficiencyInfluenceBonus,
  calculateWeaponProficiencyInfluenceLayers,
  resolveWeaponProficiencySettings
} from "./weapon-proficiency-layers.mjs";

/**
 * Resolve the primary and every unique additional proficiency used by a weapon.
 * The legacy fallback to the first configured proficiency applies only to a missing
 * or obsolete primary key; invalid additional keys never create hidden layers.
 */
export function getWeaponProficiencySettings(
  weaponData = {},
  proficiencies = getProficiencySettings()
) {
  return resolveWeaponProficiencySettings(weaponData, proficiencies);
}

export function getWeaponProficiencyInfluenceLayers(
  actor,
  weaponData = {},
  influenceKey = "",
  {
    proficiencies = getProficiencySettings(),
    getInfluenceSettings = getProficiencyInfluenceSettings
  } = {}
) {
  if (!hasPreparedProficiencies(actor)) return [];
  return calculateWeaponProficiencyInfluenceLayers(actor, weaponData, influenceKey, {
    proficiencies,
    getInfluenceSettings
  });
}

export function getWeaponProficiencyInfluenceBonus(actor, weaponData = {}, influenceKey = "") {
  if (!hasPreparedProficiencies(actor)) return 0;
  return calculateWeaponProficiencyInfluenceBonus(actor, weaponData, influenceKey, {
    proficiencies: getProficiencySettings(),
    getInfluenceSettings: getProficiencyInfluenceSettings
  });
}

function hasPreparedProficiencies(actor) {
  const proficiencies = actor?.system?.proficiencies;
  if (!proficiencies) return false;
  for (const _key in proficiencies) return true;
  return false;
}
