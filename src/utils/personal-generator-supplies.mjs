import { getItemMagazineSourceUuids } from "./item-ammo-compatibility.mjs";
import { resolveWorldItemSync } from "./world-items.mjs";

export function getPersonalGeneratorSupplies(items, existingEntries = [], resolveItem = resolveWorldItemSync) {
  const seen = new Set([...items, ...existingEntries].map(entry => entry.uuid).filter(Boolean));
  const supplies = [];
  const add = (uuid, functionKey) => {
    const item = resolveItem(String(uuid ?? "").trim());
    if (!item?.uuid || seen.has(item.uuid) || !item.system?.functions?.[functionKey]?.enabled) return;
    seen.add(item.uuid);
    supplies.push(item);
  };
  for (const item of items) {
    for (const uuid of getItemMagazineSourceUuids(item)) add(uuid, "damageSource");
    const consumer = item.system?.functions?.energyConsumer;
    if (!consumer?.enabled) continue;
    for (const uuid of [
      ...(Array.isArray(consumer.sourceItemUuids) ? consumer.sourceItemUuids : []),
      consumer.sourceItemUuid,
      consumer.activeSourceUuid,
      consumer.installedSource?.sourceItemUuid
    ]) {
      if (uuid) add(uuid, "energySource");
    }
  }
  return supplies;
}
