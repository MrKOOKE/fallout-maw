/** Keep only weapon fields used by contextual condition filters and event mirrors. */
export function serializeWeaponContextData(weaponData = null) {
  if (!weaponData || typeof weaponData !== "object") return null;
  return {
    id: String(weaponData.id ?? weaponData._id ?? ""),
    uuid: String(weaponData.uuid ?? ""),
    skillKey: String(weaponData.skillKey ?? ""),
    proficiencyKey: String(weaponData.proficiencyKey ?? "")
  };
}
