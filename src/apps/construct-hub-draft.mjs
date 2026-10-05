import { createConstructPartSlotFromItem, isInstalledConstructPartItem } from "../utils/construct-parts.mjs";

/** Project the assembly before saving, so every editor sees the same parts and seats. */
export function createConstructHubDraftActor(actor, entries, systems, itemDrafts = new Map()) {
  const items = Array.from(actor.items?.contents ?? []).map(item => {
    const source = itemDrafts.get(item.id) ?? item;
    return source.toObject ? { ...source.toObject(), id: item.id } : structuredClone(source);
  });
  const installedIds = new Set(entries.filter(entry => entry.installed && entry.itemId).map(entry => entry.itemId));
  for (const item of items) if (isInstalledConstructPartItem(item) && !installedIds.has(item.id)) {
    item.system.placement = { ...item.system.placement, mode: "inventory", limbKey: "" };
  }
  const slots = entries.map((entry, order) => {
    let item = items.find(row => row.id === entry.itemId);
    if (!item && entry.installed && entry.itemData) {
      item = structuredClone(entry.itemData);
      item.id = item._id = entry.draftItemId;
      items.push(item);
    }
    if (item && entry.installed) item.system.placement = { ...item.system.placement,
      mode: "constructPart", limbKey: entry.slot.id, constructPartOrder: order };
    return item && entry.installed
      ? createConstructPartSlotFromItem(item, { id: entry.slot.id, order })
      : { ...structuredClone(entry.slot), order };
  }).filter(Boolean);
  const collection = { contents: items, get: id => items.find(item => item.id === id), [Symbol.iterator]: () => items[Symbol.iterator]() };
  return { type: actor.type, name: actor.name, uuid: actor.uuid, prototypeToken: actor.prototypeToken,
    flags: actor.flags, items: collection, itemTypes: { gear: items.filter(item => item.type === "gear") },
    system: { ...actor.system, constructPartSlots: slots, constructSystems: systems },
    getFlag: (scope, key) => actor.getFlag?.(scope, key) ?? actor.flags?.[scope]?.[key] };
}

/** Prune only references to removed records, never silently rebind them elsewhere. */
export function reconcileConstructHubReferences(config, slotIds, systemIds) {
  const slots = new Set(slotIds), systems = new Set(systemIds);
  config.parts = config.parts.filter(part => slots.has(part.slotId));
  for (const anchor of config.anchors) if (anchor.parentSlotId && !slots.has(anchor.parentSlotId)) anchor.parentSlotId = "";
  for (const part of config.parts) part.rotationSystemIds = (part.rotationSystemIds ?? []).filter(id => systems.has(id));
  for (const seat of config.seats) {
    if (seat.partSlotId && !slots.has(seat.partSlotId)) seat.partSlotId = "";
    seat.reloadPartSlotIds = (seat.reloadPartSlotIds ?? []).filter(id => slots.has(id));
    seat.systemIds = (seat.systemIds ?? []).filter(id => systems.has(id));
  }
  return config;
}
