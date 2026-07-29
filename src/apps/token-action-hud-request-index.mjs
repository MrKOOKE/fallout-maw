/**
 * Materialize the document collections used repeatedly while preparing one
 * Token Action HUD render. The index is deliberately request-local: Foundry
 * document updates prepare a new render with a new index.
 */
export function createTokenActionHudRequestIndex(actor = null, {
  getWeaponSets = () => [],
  getInstalledModuleItems = () => [],
  resolveActiveWeaponSetKey = (_actor, weaponSets) => weaponSets.at(0)?.key ?? ""
} = {}) {
  const actorItems = getActorItemDocuments(actor);
  const hudWeaponSets = Array.from(getWeaponSets(actor) ?? []);
  const activeWeaponSetKey = String(resolveActiveWeaponSetKey(actor, hudWeaponSets) ?? "");
  const activeWeaponSet = hudWeaponSets.find(set => set?.key === activeWeaponSetKey)
    ?? hudWeaponSets.at(0)
    ?? null;
  const hasHudWeaponHost = (activeWeaponSet?.slots ?? [])
    .some(slot => slot?.item?.id && !slot.phantom);
  const installedModuleItems = hasHudWeaponHost
    ? Array.from(getInstalledModuleItems(actor) ?? [])
    : [];
  const activeHostItemIds = new Set((activeWeaponSet?.slots ?? [])
    .filter(slot => slot?.item?.id && !slot.phantom && !slot.useDisabled)
    .map(slot => String(slot.item.id)));
  const activeHudInstalledModuleItems = installedModuleItems
    .filter(item => activeHostItemIds.has(String(item?.system?.placement?.parentItemId ?? "")));

  return {
    actorItems,
    actorItemById: new Map(actorItems.map(item => [String(item?.id ?? ""), item])),
    actorItemsByType: indexItemsByType(actorItems),
    hudWeaponSets,
    hudWeaponSetByKey: new Map(hudWeaponSets.map(set => [String(set?.key ?? ""), set])),
    activeWeaponSetKey,
    installedModuleItems,
    installedModulesByParentItemId: indexItemsByParentItemId(installedModuleItems),
    activeHudInstalledModuleItems,
    activeHudInstalledModulesByParentItemId: indexItemsByParentItemId(activeHudInstalledModuleItems),
    itemsWithActiveHudModules: [...actorItems, ...activeHudInstalledModuleItems],
    activeHudItemIds: new Set([
      ...actorItems.map(item => String(item?.id ?? "")),
      ...activeHudInstalledModuleItems.map(item => String(item?.id ?? ""))
    ].filter(Boolean)),
    weaponFitByTargetAndItemId: new Map()
  };
}

function getActorItemDocuments(actor = null) {
  const collection = actor?.items;
  const contents = collection?.contents;
  if (Array.isArray(contents)) return Array.from(contents);
  if (typeof collection?.values === "function") return Array.from(collection.values());
  return Array.from(collection ?? []);
}

function indexItemsByType(items = []) {
  const index = new Map();
  for (const item of items) {
    const type = String(item?.type ?? "");
    const entries = index.get(type) ?? [];
    entries.push(item);
    index.set(type, entries);
  }
  return index;
}

function indexItemsByParentItemId(items = []) {
  const index = new Map();
  for (const item of items) {
    const parentItemId = String(item?.system?.placement?.parentItemId ?? "");
    const entries = index.get(parentItemId) ?? [];
    entries.push(item);
    index.set(parentItemId, entries);
  }
  return index;
}
