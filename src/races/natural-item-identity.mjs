import { SYSTEM_ID } from "../constants.mjs";

export const NATURAL_RACE_ITEM_FLAG = "naturalRaceItem";
export const NATURAL_RACE_WEAPON_SET_KEY = "naturalRaceWeapons";
export const NATURAL_RACE_ITEM_KINDS = Object.freeze({
  weapon: "weapon",
  feature: "feature"
});

export function getNaturalRaceItemFlag(itemOrData) {
  if (!itemOrData) return null;
  return itemOrData.getFlag?.(SYSTEM_ID, NATURAL_RACE_ITEM_FLAG)
    ?? itemOrData.flags?.[SYSTEM_ID]?.[NATURAL_RACE_ITEM_FLAG]
    ?? null;
}

export function isNaturalRaceItem(itemOrData, kind = "") {
  const flag = getNaturalRaceItemFlag(itemOrData);
  if (!flag?.kind) return false;
  return kind ? flag.kind === kind : true;
}

export function isNaturalRaceWeapon(itemOrData) {
  return isNaturalRaceItem(itemOrData, NATURAL_RACE_ITEM_KINDS.weapon);
}

/**
 * Natural weapons occupy immutable system-owned pseudo-slots. They do not use
 * the configurable hand/weapon-slot requirement schema used by carried gear.
 */
export function isCanonicalNaturalRaceWeaponPlacement(actor, itemOrData) {
  const system = itemOrData?.system ?? itemOrData ?? {};
  const placement = system.placement ?? {};
  const flag = getNaturalRaceItemFlag(itemOrData);
  const sourceId = String(flag?.sourceId ?? "");

  return Boolean(
    actor?.type === "character"
    && itemOrData?.type === "gear"
    && flag?.kind === NATURAL_RACE_ITEM_KINDS.weapon
    && sourceId
    && String(system.container?.parentId ?? "") === ""
    && !system.equipped
    && String(placement.mode ?? "") === "weapon"
    && String(placement.weaponSet ?? "") === NATURAL_RACE_WEAPON_SET_KEY
    && String(placement.weaponSlot ?? "") === sourceId
    && !String(placement.equipmentSlot ?? "")
    && !String(placement.limbKey ?? "")
    && (Number(placement.constructPartOrder) || 0) === 0
  );
}
