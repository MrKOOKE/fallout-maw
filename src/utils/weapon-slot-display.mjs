/** Combine one weapon's occupied slots for display, retaining every drop target.
 * The original slots remain the authority for placement, limb use and combat.
 */
export function prepareWeaponSetDisplay(set) {
  return { ...set, displaySlots: prepareWeaponDisplaySlots(set.slots) };
}

export function prepareWeaponDisplaySlots(slots = []) {
  const groups = new Map();
  for (const slot of slots) {
    if (!slot.item?.id) continue;
    const group = groups.get(slot.item.id) ?? [];
    group.push(slot);
    groups.set(slot.item.id, group);
  }

  const displayed = new Set();
  return slots.flatMap(slot => {
    const group = groups.get(slot.item?.id) ?? [];
    const primary = group.find(entry => !entry.phantom);
    const shared = group.length > 1 && primary
      && group.every(entry => entry === primary || entry.phantom);
    if (!shared) return [slot];
    if (displayed.has(slot.item.id)) return [];
    displayed.add(slot.item.id);
    return [{
      ...primary,
      shared: true,
      label: group.map(entry => entry.label).join(" / "),
      sharedSlots: group.map(({ key, label }) => ({ key, label }))
    }];
  });
}
