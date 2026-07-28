export function hasWeaponTooltipDamageSourceReferences(magazine = {}) {
  return [
    ...(Array.isArray(magazine?.sourceItemUuids) ? magazine.sourceItemUuids : []),
    magazine?.sourceItemUuid
  ].some(value => String(value ?? "").trim());
}

export function getWeaponTooltipDamageSourceEntries(magazine = {}, {
  resolveItem = () => null,
  getLabel = item => item?.name
} = {}) {
  const activeUuid = String(magazine?.sourceItemUuid ?? "").trim();
  const uuids = Array.from(new Set([
    ...(Array.isArray(magazine?.sourceItemUuids) ? magazine.sourceItemUuids : []),
    activeUuid
  ].map(value => String(value ?? "").trim()).filter(Boolean)));

  return uuids.map(uuid => {
    const item = resolveItem(uuid);
    return {
      active: uuid === activeUuid,
      item,
      label: String(getLabel(item, uuid) ?? "").trim() || item?.name || uuid,
      uuid
    };
  });
}

export function getWeaponDamageSourceTooltipDirection({
  anchorRight = 0,
  margin = 5,
  rightBoundary = 0,
  tooltipWidth = 660
} = {}) {
  const availableRight = Math.max(0, Number(rightBoundary) - Number(anchorRight) - Math.max(0, Number(margin)));
  return availableRight >= Math.max(0, Number(tooltipWidth)) ? "RIGHT" : "LEFT";
}
