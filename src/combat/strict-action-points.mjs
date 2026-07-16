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
  const transaction = await spendStrictActionPointsWithReceipt(actor, amount, context);
  return transaction.events;
}

/** Spend strict action points and return a delta receipt which can be safely refunded. */
export async function spendStrictActionPointsWithReceipt(actor, amount = 0, context = {}) {
  if (!isActorInActiveCombat(actor)) return { spent: 0, receipt: null, events: [] };
  const cost = Math.max(0, toInteger(amount));
  const state = getStrictActionPointState(actor);
  if (!actor?.isOwner || cost <= 0 || !state || cost > state.current) {
    return { spent: 0, receipt: null, events: [] };
  }
  const next = state.current - cost;
  await actor.update({
    [`system.resources.${ACTION_RESOURCE_KEY}.value`]: next,
    [`system.resources.${ACTION_RESOURCE_KEY}.spent`]: Math.max(0, state.max - next)
  }, createStrictActionPointUpdateOptions(context));
  const applied = getStrictActionPointState(actor);
  if (!applied || applied.current !== next) {
    // A preUpdate hook may cancel or alter the document update.  Never issue a
    // receipt (and therefore never permit the protected operation) unless the
    // exact requested delta reached the document.  If part of our delta did
    // land, undo no more than that delta while preserving later changes.
    const observedSpend = applied
      ? Math.min(cost, Math.max(0, state.current - applied.current))
      : 0;
    if (observedSpend > 0) {
      await refundStrictActionPointReceipt(actor, {
        actorUuid: String(actor.uuid ?? ""),
        resourceKey: ACTION_RESOURCE_KEY,
        amount: observedSpend
      }, context);
    }
    return { spent: 0, receipt: null, events: [] };
  }
  const receipt = Object.freeze({
    actorUuid: String(actor.uuid ?? ""),
    resourceKey: ACTION_RESOURCE_KEY,
    amount: cost
  });
  const events = context?.suppressResourceNotification
    ? []
    : await notifyCombatResourcesSpent(actor, { [ACTION_RESOURCE_KEY]: cost }, context);
  return { spent: cost, receipt, events };
}

/** Refund only the delta represented by a receipt, preserving later resource changes. */
export async function refundStrictActionPointReceipt(actor, receipt = null, context = {}) {
  const amount = Math.max(0, toInteger(receipt?.amount));
  if (
    !actor?.isOwner
    || !amount
    || receipt?.resourceKey !== ACTION_RESOURCE_KEY
    || String(receipt?.actorUuid ?? "") !== String(actor?.uuid ?? "")
  ) return 0;
  const state = getStrictActionPointState(actor);
  if (!state) return 0;
  const next = Math.min(state.max, state.current + amount);
  const restored = next - state.current;
  if (restored <= 0) return 0;
  await actor.update({
    [`system.resources.${ACTION_RESOURCE_KEY}.value`]: next,
    [`system.resources.${ACTION_RESOURCE_KEY}.spent`]: Math.max(0, state.max - next)
  }, createStrictActionPointUpdateOptions(context, { falloutMawStrictActionPointRefund: true }));
  const applied = getStrictActionPointState(actor);
  if (!applied) return 0;
  return Math.min(restored, Math.max(0, applied.current - state.current));
}

function createStrictActionPointUpdateOptions(context = {}, extra = {}) {
  return {
    ...extra,
    ...(context?.chainRef ? {
      chainRef: context.chainRef,
      falloutMawSystemEventChainRef: context.chainRef
    } : {})
  };
}
