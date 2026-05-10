export function getEquipmentSlotSelectionKey(label) {
  const normalized = String(label ?? "").trim().toLocaleLowerCase();
  return `slot${hashSelectionKey(normalized)}`;
}

export function getWeaponSlotSelectionKey(slot = {}) {
  const limbKey = String(slot?.limbKey ?? "").trim();
  if (limbKey) return `limb:${limbKey}`;
  const label = String(slot?.label ?? slot?.key ?? "").trim().toLocaleLowerCase();
  return `weapon:${hashSelectionKey(label)}`;
}

function hashSelectionKey(normalized) {
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
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

export function getWeaponSlotRequirement(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  const requirement = system.weaponSlotRequirement ?? {};
  const mode = requirement.mode === "all" ? "all" : "oneOf";
  const slots = requirement.slots ?? {};
  return {
    mode,
    selectedKeys: new Set(
      Object.entries(slots)
        .filter(([, selected]) => Boolean(selected))
        .map(([key]) => key)
    )
  };
}

export function getWeaponSlotRequirementSize(itemOrSystem) {
  const requirement = getWeaponSlotRequirement(itemOrSystem);
  return requirement.mode === "all" ? Math.max(1, requirement.selectedKeys.size) : 1;
}

export function getRaceEquipmentSlotsForItem(race, itemOrSystem) {
  const selectedKeys = getSelectedEquipmentSlotKeys(itemOrSystem);
  if (!selectedKeys.size) return [];
  return (race?.equipmentSlots ?? []).filter(slot => selectedKeys.has(getEquipmentSlotSelectionKey(slot.label)));
}

export function getWeaponSlotsForRequirement(race, itemOrSystem, setKey = "") {
  const set = (race?.weaponSets ?? []).find(entry => entry.key === setKey) ?? null;
  if (!set) return [];

  const requirement = getWeaponSlotRequirement(itemOrSystem);
  if (!requirement.selectedKeys.size) return set.slots ?? [];
  return (set.slots ?? []).filter(slot => requirement.selectedKeys.has(getWeaponSlotSelectionKey(slot)));
}

export function canUseWeaponSlotForItem(race, itemOrSystem, setKey = "", slotKey = "") {
  if (isContainerWeaponSetKey(setKey)) return true;
  const set = (race?.weaponSets ?? []).find(entry => entry.key === setKey) ?? null;
  const slot = (set?.slots ?? []).find(entry => entry.key === slotKey) ?? null;
  if (!slot) return false;
  const requirement = getWeaponSlotRequirement(itemOrSystem);
  if (!requirement.selectedKeys.size) return true;
  if (!requirement.selectedKeys.has(getWeaponSlotSelectionKey(slot))) return false;
  if (requirement.mode !== "all") return true;
  const setSlotKeys = new Set((set.slots ?? []).map(entry => getWeaponSlotSelectionKey(entry)));
  return Array.from(requirement.selectedKeys).every(key => setSlotKeys.has(key));
}

export function getRequiredWeaponSlotsForItem(race, itemOrSystem, setKey = "", primarySlotKey = "") {
  const set = (race?.weaponSets ?? []).find(entry => entry.key === setKey) ?? null;
  if (!set) return [];

  const slots = set.slots ?? [];
  const primarySlot = slots.find(slot => slot.key === primarySlotKey) ?? null;
  const requirement = getWeaponSlotRequirement(itemOrSystem);
  if (!requirement.selectedKeys.size) return primarySlot ? [primarySlot] : [];
  if (requirement.mode === "oneOf") {
    if (!primarySlot || !requirement.selectedKeys.has(getWeaponSlotSelectionKey(primarySlot))) return [];
    return [primarySlot];
  }
  const requiredSlots = slots.filter(slot => requirement.selectedKeys.has(getWeaponSlotSelectionKey(slot)));
  return requiredSlots.length === requirement.selectedKeys.size ? requiredSlots : [];
}

export function isContainerWeaponSetKey(setKey = "") {
  return String(setKey ?? "").startsWith("container:");
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

export function groupRaceWeaponSlotsBySet(creatureOptions) {
  const groups = new Map();

  for (const race of creatureOptions?.races ?? []) {
    const slots = [];
    for (const set of race.weaponSets ?? []) {
      for (const slot of set.slots ?? []) {
        const selectionKey = getWeaponSlotSelectionKey(slot);
        if (slots.some(entry => entry.selectionKey === selectionKey)) continue;
        const limb = (race.limbs ?? []).find(entry => entry.key === slot.limbKey);
        slots.push({
          label: limb?.label || slot.label || slot.limbKey || slot.key,
          selectionKey
        });
      }
    }
    const signature = slots.map(slot => slot.selectionKey).sort().join("|");
    const group = groups.get(signature) ?? { races: [], slots };
    group.races.push(race.name);
    groups.set(signature, group);
  }

  return Array.from(groups.values());
}
