import { isActorInActiveCombat } from "./combat-membership.mjs";

export const COMBAT_ONLY_RESOURCE_KEYS = Object.freeze([
  "actionPoints",
  "reactionPoints",
  "movementPoints",
  "dodge"
]);

const combatOnlyResourceKeySet = new Set(COMBAT_ONLY_RESOURCE_KEYS);

export function isCombatOnlyResourceKey(resourceKey = "") {
  return combatOnlyResourceKeySet.has(String(resourceKey ?? "").trim());
}

/** Combat resources are free/inactive unless this actor participates in the started combat. */
export function isCombatResourceCostActive(actor, resourceKey = "") {
  return !isCombatOnlyResourceKey(resourceKey) || isActorInActiveCombat(actor);
}
