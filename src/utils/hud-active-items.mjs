import { SYSTEM_ID } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { prepareHudWeaponSetsContext } from "./actor-display-data.mjs";
import { isTraumaDiseaseSuppressionEffectKey } from "./active-effect-changes.mjs";
import { getItemContainerParentId } from "./inventory-containers.mjs";
import { getActorInstalledModuleItems } from "./item-functions.mjs";
import { isNaturalRaceItem } from "../races/natural-items.mjs";

const SELECTED_HUD_WEAPON_FLAG = "selectedHudWeaponItemId";
const SELECTED_HUD_WEAPON_SET_FLAG = "selectedHudWeaponSetKey";
const hudWeaponSetsCache = new WeakMap();

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

export function getHudWeaponSetsForActor(actor = null) {
  if (!actor) return [];

  const signature = getHudWeaponSetsCacheSignature(actor);
  const cached = hudWeaponSetsCache.get(actor);
  if (cached?.signature === signature) {
    return cached.sets;
  }

  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId);
  const inventory = prepareHudWeaponSetsContext(actor, race);
  const sets = [
    ...(inventory.naturalWeaponSet ? [inventory.naturalWeaponSet] : []),
    ...(inventory.weaponSets ?? [])
  ];
  hudWeaponSetsCache.set(actor, { signature, sets });
  return sets;
}

function getHudWeaponSetsCacheSignature(actor) {
  const parts = [
    String(actor.system?.creature?.raceId ?? ""),
    String(actor.getFlag?.(SYSTEM_ID, SELECTED_HUD_WEAPON_SET_FLAG) ?? ""),
    String(actor.getFlag?.(SYSTEM_ID, SELECTED_HUD_WEAPON_FLAG) ?? "")
  ];
  for (const [limbKey, limb] of Object.entries(actor.system?.limbs ?? {})) {
    parts.push([
      "limb",
      limbKey,
      limb?.max ?? "",
      limb?.missing ? 1 : 0
    ].join(":"));
  }
  for (const item of getActorItemDocuments(actor)) {
    if (item.type === "trauma") {
      parts.push([
        "trauma",
        item.id,
        item.system?.limbKey ?? "",
        item.system?.thresholdPercent ?? ""
      ].join(":"));
      continue;
    }
    if (item.type === "disease" || item.type === "ability" || isNaturalRaceItem(item)) continue;
    if (getItemContainerParentId(item)) continue;
    const system = item.system ?? {};
    const placement = system.placement ?? {};
    const container = system.functions?.container ?? {};
    parts.push([
      item.id,
      placement.mode,
      placement.weaponSet,
      placement.weaponSlot,
      placement.limbKey,
      placement.constructPartOrder,
      system.equipped ? 1 : 0,
      container.extraWeaponSlots ?? 0
    ].join(":"));
  }
  for (const effect of actor?.allApplicableEffects?.() ?? actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    const changes = (effect?.system?.changes ?? [])
      .filter(change => isTraumaDiseaseSuppressionEffectKey(change?.key))
      .map(change => [
        change.key,
        change.type ?? "",
        change.value ?? "",
        change.phase ?? "",
        change.priority ?? ""
      ].join(","));
    if (!changes.length) continue;
    parts.push([
      "suppression",
      effect.uuid ?? effect.id ?? "",
      ...changes
    ].join(":"));
  }
  return parts.join("|");
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
