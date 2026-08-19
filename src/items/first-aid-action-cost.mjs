import {
  applyDamageCostModifier,
  getActionCostModifierState
} from "../combat/damage-hub.mjs";
import { getContextualAbilityChangeValue } from "../abilities/evaluation.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FIRST_AID_ACTION_POINT_COST_EFFECT_KEY } from "./first-aid-effect-keys.mjs";

const GENERAL_ACTION_POINT_COST_EFFECT_KEY = "system.costs.action";

/** Resolve the final combat AP cost of one first-aid item application. */
export function getFirstAidActionPointCost(actor = null, firstAid = {}, context = null) {
  const baseCost = Math.max(0, toInteger(firstAid?.actionPointCost));
  const preparedCost = applyDamageCostModifier(
    baseCost,
    getActionCostModifierState(actor, { actionKey: "firstAid" })
  );
  if (!actor || !context) return preparedCost;

  return Math.max(0, Math.ceil(getContextualAbilityChangeValue(
    actor,
    FIRST_AID_ACTION_POINT_COST_EFFECT_KEY,
    {
      ...context,
      baseValue: preparedCost,
      alternateKeys: [GENERAL_ACTION_POINT_COST_EFFECT_KEY]
    }
  )));
}
