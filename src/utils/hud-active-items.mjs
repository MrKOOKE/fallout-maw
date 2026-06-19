import { SYSTEM_ID } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { prepareInventoryContext } from "./actor-display-data.mjs";
import { getActorInstalledModuleItems } from "./item-functions.mjs";

const SELECTED_HUD_WEAPON_FLAG = "selectedHudWeaponItemId";
const SELECTED_HUD_WEAPON_SET_FLAG = "selectedHudWeaponSetKey";

export function getActorItemsWithActiveHudModules(actor = null, options = {}) {
  return [
    ...getActorItemDocuments(actor),
    ...getActorActiveHudInstalledModuleItems(actor, options)
  ];
}

export function getActorActiveHudInstalledModuleItems(actor = null, options = {}) {
  const activeHostIds = getActiveHudWeaponHostItemIds(actor, options);
  if (!activeHostIds.size) return [];
  return getActorInstalledModuleItems(actor)
    .filter(item => activeHostIds.has(String(item.system?.placement?.parentItemId ?? "")));
}

export function getActiveHudWeaponHostItemIds(actor = null, { weaponSet = null, weaponSets = null } = {}) {
  if (!actor) return new Set();
  const activeSet = weaponSet ?? resolveActiveHudWeaponSet(actor, weaponSets);
  return new Set((activeSet?.slots ?? [])
    .filter(slot => slot?.item?.id && !slot.phantom && !slot.useDisabled)
    .map(slot => String(slot.item.id)));
}

export function resolveActiveHudWeaponSet(actor = null, weaponSets = null) {
  if (!actor) return null;
  const sets = Array.isArray(weaponSets) ? weaponSets : getHudWeaponSetsForActor(actor);
  if (!sets.length) return null;
  const activeKey = getActiveHudWeaponSetKey(actor, sets);
  return sets.find(set => set.key === activeKey) ?? sets[0] ?? null;
}

function getHudWeaponSetsForActor(actor = null) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId);
  const inventory = actor ? prepareInventoryContext(actor, race) : { weaponSets: [] };
  return [
    ...(inventory.naturalWeaponSet ? [inventory.naturalWeaponSet] : []),
    ...(inventory.weaponSets ?? [])
  ];
}

function getActiveHudWeaponSetKey(actor = null, weaponSets = []) {
  if (!weaponSets.length) return "";
  const selectedSetKey = String(actor?.getFlag?.(SYSTEM_ID, SELECTED_HUD_WEAPON_SET_FLAG) ?? "");
  if (weaponSets.some(set => set.key === selectedSetKey)) return selectedSetKey;

  const selectedId = String(actor?.getFlag?.(SYSTEM_ID, SELECTED_HUD_WEAPON_FLAG) ?? "");
  const selectedSet = selectedId
    ? weaponSets.find(set => (set.slots ?? []).some(slot => slot.item?.id === selectedId && !slot.phantom && !slot.useDisabled))
    : null;
  return selectedSet?.key ?? weaponSets[0].key;
}

function getActorItemDocuments(actor = null) {
  if (Array.isArray(actor?.items?.contents)) return actor.items.contents;
  if (typeof actor?.items?.values === "function") return Array.from(actor.items.values());
  return Array.from(actor?.items ?? []);
}
