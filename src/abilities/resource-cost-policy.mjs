import { isCombatResourceCostActive } from "../combat/resource-cost-policy.mjs";

/** Resource rows which are meaningful for this actor in the current world state. */
export function isAbilityResourceCostActive(actor, resourceKey = "") {
  return isCombatResourceCostActive(actor, resourceKey);
}
