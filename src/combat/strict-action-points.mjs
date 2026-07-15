import { toInteger } from "../utils/numbers.mjs";
import {
  getActorActiveCombat,
  isActorInActiveCombat
} from "./combat-membership.mjs";
import { notifyCombatResourcesSpent } from "./resource-spending.mjs";

export const ACTION_RESOURCE_KEY = "actionPoints";
export { getActorActiveCombat, isActorInActiveCombat };

export function getStrictActionPointState(actor) {
  const resource = actor?.system?.resources?.[ACTION_RESOURCE_KEY];
  if (!resource) return null;
  return {
    key: ACTION_RESOURCE_KEY,
    current: Math.max(0, toInteger(resource.value)),
    max: Math.max(0, toInteger(resource.max))
  };
}

export function canSpendStrictActionPoints(actor, amount = 0, { label = "" } = {}) {
  if (!isActorInActiveCombat(actor)) return true;
  const cost = Math.max(0, toInteger(amount));
  const state = getStrictActionPointState(actor);
  if (state && cost <= state.current) return true;
  globalThis.ui?.notifications?.warn?.(
    `${actor?.name ?? ""}: не хватает ОД${label ? ` для ${label}` : ""} (${cost} > ${state?.current ?? 0}).`
  );
  return false;
}

export async function spendStrictActionPoints(actor, amount = 0, context = {}) {
  if (!isActorInActiveCombat(actor)) return [];
  const cost = Math.max(0, toInteger(amount));
  const state = getStrictActionPointState(actor);
  if (!actor?.isOwner || cost <= 0 || !state || cost > state.current) return [];
  const next = state.current - cost;
  await actor.update({
    [`system.resources.${ACTION_RESOURCE_KEY}.value`]: next,
    [`system.resources.${ACTION_RESOURCE_KEY}.spent`]: Math.max(0, state.max - next)
  }, context?.chainRef ? {
    chainRef: context.chainRef,
    falloutMawSystemEventChainRef: context.chainRef
  } : {});
  if (context?.suppressResourceNotification) return [];
  return notifyCombatResourcesSpent(actor, { [ACTION_RESOURCE_KEY]: cost }, context);
}
