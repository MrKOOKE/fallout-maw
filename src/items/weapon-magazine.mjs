import { SYSTEM_ID } from "../constants.mjs";
import { planActorInventoryGrant } from "../utils/inventory-grants.mjs";
import { getWeaponMagazineCapacityTransition } from "../utils/weapon-modules.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";

/**
 * Plan the inventory half of a module change which shrinks a loaded
 * magazine. The caller combines this with its module and weapon updates in
 * one atomic inventory mutation.
 */
export function planWeaponMagazineCapacityTransition(actor, weaponData = {}, moduleSlots = [], {
  reservedCreates = []
} = {}) {
  const transition = getWeaponMagazineCapacityTransition(weaponData, moduleSlots);
  if (!transition.overflow) return { ...transition, updates: [], creates: [] };

  const sourceUuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  const sourceItem = sourceUuid ? resolveWorldItemSync(sourceUuid) : null;
  if (!sourceItem) {
    throw new Error(game.i18n.localize("FALLOUTMAW.Item.WeaponReloadNoSource"));
  }

  const sourceData = sourceItem.toObject();
  foundry.utils.setProperty(sourceData, `flags.${SYSTEM_ID}.damageSourcePrototypeUuid`, sourceItem.uuid);
  const returnPlan = planActorInventoryGrant(actor, sourceData, {
    quantity: transition.overflow,
    merge: true,
    reservedCreates
  });
  if (!returnPlan) throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryNoSpace"));
  return {
    ...transition,
    updates: returnPlan.updates,
    creates: returnPlan.creates
  };
}
