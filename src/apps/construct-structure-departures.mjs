export function planConstructStructureDepartures(previousEntries, currentEntries) {
  const currentBySlotId = new Map(currentEntries.map(entry => [entry.slot.id, entry]));
  const removedSlotIds = [];
  const deletedItemIds = [];
  const detachedEntries = [];

  for (const entry of previousEntries) {
    const current = currentBySlotId.get(entry.slot.id);
    if (!current) {
      removedSlotIds.push(entry.slot.id);
      if (entry.item?.id) deletedItemIds.push(entry.item.id);
    } else if (entry.item && (!current.installed || current.itemId !== entry.item.id)) {
      detachedEntries.push({ entry, item: entry.item });
    }
  }

  return { removedSlotIds, deletedItemIds, detachedEntries };
}
