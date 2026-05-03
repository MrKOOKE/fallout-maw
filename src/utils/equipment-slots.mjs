export function getEquipmentSlotSelectionKey(label) {
  const normalized = String(label ?? "").trim().toLocaleLowerCase();
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
    hash |= 0;
  }
  return `slot${Math.abs(hash).toString(36)}`;
}

export function getSelectedEquipmentSlotKeys(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  const occupiedSlots = system.occupiedSlots ?? {};
  return new Set(
    Object.entries(occupiedSlots)
      .filter(([, selected]) => Boolean(selected))
      .map(([key]) => key)
  );
}

export function getRaceEquipmentSlotsForItem(race, itemOrSystem) {
  const selectedKeys = getSelectedEquipmentSlotKeys(itemOrSystem);
  if (!selectedKeys.size) return [];
  return (race?.equipmentSlots ?? []).filter(slot => selectedKeys.has(getEquipmentSlotSelectionKey(slot.label)));
}

export function groupRaceEquipmentSlotsBySet(creatureOptions) {
  const groups = new Map();

  for (const race of creatureOptions?.races ?? []) {
    const slots = race.equipmentSlots ?? [];
    const signature = slots
      .map(slot => getEquipmentSlotSelectionKey(slot.label))
      .sort()
      .join("|");
    const group = groups.get(signature) ?? {
      races: [],
      slots: slots.map(slot => ({
        label: slot.label,
        selectionKey: getEquipmentSlotSelectionKey(slot.label)
      }))
    };

    group.races.push(race.name);
    groups.set(signature, group);
  }

  return Array.from(groups.values());
}
