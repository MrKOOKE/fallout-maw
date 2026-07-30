function normalizeUuid(value) {
  return String(value ?? "").trim();
}

export function getEnergyConsumerTooltipSourceEntries(consumer = {}, {
  resolveItem = () => null,
  getLabel = item => item?.name
} = {}) {
  const installed = consumer?.installedSource ?? {};
  const installedUuid = normalizeUuid(installed?.sourceItemUuid);
  const activeUuid = installedUuid || normalizeUuid(consumer?.activeSourceUuid);
  const uuids = Array.from(new Set([
    ...(Array.isArray(consumer?.sourceItemUuids) ? consumer.sourceItemUuids : []),
    consumer?.sourceItemUuid,
    consumer?.activeSourceUuid,
    installedUuid
  ].map(normalizeUuid).filter(Boolean)));

  return uuids.map(uuid => {
    const item = resolveItem(uuid);
    const active = uuid === activeUuid;
    const installedFallback = active ? installed : {};
    return {
      active,
      img: String(item?.img ?? installedFallback?.img ?? "").trim(),
      item,
      label: String(
        (item ? getLabel(item, uuid) : "")
        ?? installedFallback?.name
        ?? ""
      ).trim() || String(installedFallback?.name ?? "").trim() || item?.name || uuid,
      uuid
    };
  });
}
