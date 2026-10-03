/** Loaded rounds keep their source until the ordinary extraction step empties the magazine. */
export function canSelectWeaponMagazineSource(weaponData = {}, sourceUuid = "") {
  const selected = String(sourceUuid ?? "").trim();
  if (!selected) return false;
  const loaded = Math.max(0, Number(weaponData?.magazine?.value) || 0);
  const current = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  return loaded === 0 || selected === current;
}
