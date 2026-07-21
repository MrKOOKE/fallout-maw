import { getCombatSettings } from "../settings/accessors.mjs";
import { evaluateActorEffectChangeNumber } from "../utils/active-effect-changes.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  commitPreparedActiveUseOperations,
  prepareActiveUseOperation
} from "../abilities/active-use-runtime.mjs";
import { isActorInActiveCombat } from "./combat-membership.mjs";
import {
  canSpendCombatActionPoints,
  getCombatActionPointState,
  spendCombatActionPoints
} from "./reaction-resources.mjs";

export const WEAPON_SWITCH_COST_KEY = "system.costs.weaponSwitch";

export function getWeaponSwitchActionPointCost(actor) {
  const baseCost = Math.max(0, toInteger(getCombatSettings()?.weaponSwitch?.actionPointCost));
  return Math.max(0, Math.ceil(baseCost + getWeaponSwitchActionPointCostBonus(actor)));
}

export function canSpendWeaponSwitchActionPoints(actor) {
  const cost = getWeaponSwitchActionPointCost(actor);
  if (cost <= 0) return true;
  return canSpendCombatActionPoints(actor, cost, { label: "смены оружия" });
}

export async function spendWeaponSwitchActionPoints(actor) {
  const cost = getWeaponSwitchActionPointCost(actor);
  if (cost <= 0) return;
  const stateBefore = getCombatActionPointState(actor);
  if (!actor?.isOwner || !isActorInActiveCombat(actor) || !stateBefore || cost > stateBefore.value) return;

  const activeUsePreparation = prepareActiveUseOperation({
    kind: "weaponSwitchCost",
    actor,
    keys: new Set([WEAPON_SWITCH_COST_KEY]),
    conditionContexts: [{ actorToken: actor?.token?.object ?? actor?.token ?? null }],
    reverseOnly: false
  });
  const activeUseOperationId = `weapon-switch:${String(actor.uuid ?? actor.id ?? "")}:${foundry.utils.randomID()}`;
  await spendCombatActionPoints(actor, cost);
  const stateAfter = getCombatActionPointState(actor);
  if (!stateAfter || stateAfter.value >= stateBefore.value || !activeUsePreparation) return;
  try {
    await commitPreparedActiveUseOperations([activeUsePreparation], {
      operationId: activeUseOperationId
    });
  } catch (error) {
    console.error("fallout-maw | Weapon-switch active-use commit failed", error);
  }
}

function getWeaponSwitchActionPointCostBonus(actor) {
  let total = 0;
  for (const effect of getActorApplicableEffects(actor)) {
    if (effect.disabled) continue;
    for (const change of effect.system?.changes ?? effect.changes ?? []) {
      if (String(change?.key ?? "").trim() !== WEAPON_SWITCH_COST_KEY) continue;
      const value = evaluateActorEffectChangeNumber(actor, { ...change, effect });
      if (Number.isFinite(value)) total += value;
    }
  }
  return total;
}

function getActorApplicableEffects(actor) {
  if (typeof actor?.allApplicableEffects === "function") return Array.from(actor.allApplicableEffects());
  return Array.from(actor?.effects ?? []);
}
