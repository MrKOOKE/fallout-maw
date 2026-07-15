/**
 * Synthetic installed modules retain their pseudo UUID in provenance, but an
 * ActiveEffect origin must point at the real host Item document.
 */
export function getAbilityEffectOriginUuid(actor = null, sourceItem = null, sourceItemUuid = "") {
  const uuid = String(sourceItemUuid || sourceItem?.uuid || "").trim();
  const placementMode = String(sourceItem?.system?.placement?.mode ?? "").trim();
  const moduleSeparator = uuid.lastIndexOf(".Module.");
  if (placementMode !== "module" && moduleSeparator < 0) return uuid;

  const parentItemId = String(sourceItem?.system?.placement?.parentItemId ?? "").trim();
  const parentItem = parentItemId
    ? actor?.items?.get?.(parentItemId)
      ?? Array.from(actor?.items ?? []).find(item => String(item?.id ?? "") === parentItemId)
    : null;
  if (parentItem?.uuid) return String(parentItem.uuid);
  return moduleSeparator > 0 ? uuid.slice(0, moduleSeparator) : uuid;
}
