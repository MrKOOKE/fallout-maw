import { getCombatSettings } from "../settings/accessors.mjs";

const ATTACK_ACTIONS = new Set(["aimedShot", "snapshot", "burst", "volley", "meleeAttack", "aimedMeleeAttack", "push"]);

export function finalizeAttackActionPointCost(cost, actionKey) {
  const minimum = ATTACK_ACTIONS.has(actionKey) ? getCombatSettings().minimumAttackActionPointCost : 0;
  return Math.max(minimum, Math.ceil(Number(cost) || 0));
}

export function finalizeActiveItemActionPointCost(cost) {
  return Math.max(getCombatSettings().minimumActiveItemActionPointCost, Math.ceil(Number(cost) || 0));
}
