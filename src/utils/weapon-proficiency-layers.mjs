import { getConfiguredWeaponProficiencyKeys } from "./item-functions.mjs";
import { toInteger } from "./numbers.mjs";

export function resolveWeaponProficiencySettings(weaponData = {}, proficiencies = []) {
  const available = Array.isArray(proficiencies) ? proficiencies : [];
  if (!available.length) return [];
  const byKey = new Map(available.map(proficiency => [String(proficiency?.key ?? ""), proficiency]));
  const configuredKeys = getConfiguredWeaponProficiencyKeys(weaponData);
  const primaryKey = String(weaponData?.proficiencyKey ?? "").trim();
  const primary = byKey.get(primaryKey) ?? available[0] ?? null;
  const resolved = [];
  const seen = new Set();
  if (primary?.key) {
    resolved.push(primary);
    seen.add(String(primary.key));
  }
  for (const key of configuredKeys) {
    const proficiency = byKey.get(key);
    if (!proficiency || seen.has(key)) continue;
    resolved.push(proficiency);
    seen.add(key);
  }
  return resolved;
}

export function calculateWeaponProficiencyInfluenceLayers(
  actor,
  weaponData = {},
  influenceKey = "",
  { proficiencies = [], getInfluenceSettings = () => ({}) } = {}
) {
  if (!actor) return [];
  return resolveWeaponProficiencySettings(weaponData, proficiencies).map(proficiency => {
    const range = getInfluenceSettings(proficiency)?.[influenceKey] ?? { min: 0, max: 0 };
    const minimum = toInteger(range.min);
    const maximum = toInteger(range.max);
    const key = String(proficiency.key ?? "");
    const actorValue = toInteger(actor.system?.proficiencies?.[key]?.value);
    const settingMax = Math.max(0, toInteger(proficiency.max));
    const ratio = settingMax > 0 ? Math.max(0, Math.min(1, actorValue / settingMax)) : 0;
    return {
      key,
      label: String(proficiency.label ?? key),
      value: Math.round(minimum + ((maximum - minimum) * ratio))
    };
  });
}

export function calculateWeaponProficiencyInfluenceBonus(actor, weaponData = {}, influenceKey = "", options = {}) {
  return calculateWeaponProficiencyInfluenceLayers(actor, weaponData, influenceKey, options)
    .reduce((total, layer) => total + layer.value, 0);
}
