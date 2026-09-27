import { format as auditFormat } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  getActorActiveCombat,
  isActorInActiveCombat
} from "./combat-membership.mjs";
import { notifyCombatResourcesSpent } from "./resource-spending.mjs";
import { getActorResourceLimitAmount } from "./resource-limits.mjs";
import { getOneTimeResourceValue, runOneTimeResourceMutation } from "./one-time-resources.mjs";

export const ACTION_RESOURCE_KEY = "actionPoints";
export { getActorActiveCombat, isActorInActiveCombat };

export function getStrictActionPointState(actor) {
  const resource = actor?.system?.resources?.[ACTION_RESOURCE_KEY];
  if (!resource) return null;
  const current = Math.max(0, toInteger(resource.value));
  const once = getOneTimeResourceValue(actor, ACTION_RESOURCE_KEY);
  const limited = Math.min(current + once, getActorResourceLimitAmount(actor, ACTION_RESOURCE_KEY));
  return {
    key: ACTION_RESOURCE_KEY,
    current,
    once,
    limited,
    value: Math.max(0, current + once - limited),
    max: Math.max(0, toInteger(resource.max))
  };
}

export function canSpendStrictActionPoints(actor, amount = 0, { label = "" } = {}) {
  if (!isActorInActiveCombat(actor)) return true;
  const cost = Math.max(0, toInteger(amount));
  const state = getStrictActionPointState(actor);
  if (state && cost <= state.value) return true;
  globalThis.ui?.notifications?.warn?.(
    auditFormat("FALLOUTMAW.AuditRuntime.R0788", { p0: (actor?.name ?? ""), p1: (label ? auditFormat("FALLOUTMAW.AuditRuntime.R0784", { p0: (label) }, " для {p0}") : ""), p2: (cost), p3: (state?.value ?? 0) }, "{p0}: не хватает доступных ОД{p1} ({p2} > {p3}).")
  );
  return false;
}

export async function spendStrictActionPoints(actor, amount = 0, context = {}) {
  const transaction = await spendStrictActionPointsWithReceipt(actor, amount, context);
  return transaction.events;
}

/** Spend strict action points and return a delta receipt which can be safely refunded. */
export async function spendStrictActionPointsWithReceipt(actor, amount = 0, context = {}) {
  const transaction = await runOneTimeResourceMutation(actor, () => spendStrictActionPointsNow(actor, amount, context));
  if (transaction.receipt && !context?.suppressResourceNotification) {
    transaction.events = await notifyCombatResourcesSpent(actor, { [ACTION_RESOURCE_KEY]: transaction.spent }, context);
  }
  return transaction;
}

async function spendStrictActionPointsNow(actor, amount = 0, context = {}) {
  const empty = () => ({ spent: 0, receipt: null, events: [] });
  if (!isActorInActiveCombat(actor)) return empty();
  const cost = Math.max(0, toInteger(amount));
  const state = getStrictActionPointState(actor);
  if (!actor?.isOwner || cost <= 0 || !state || cost > state.value) return empty();
  const onceSpent = Math.min(cost, state.once);
  const normalSpent = cost - onceSpent;
  const next = state.current - normalSpent;
  const createReceipt = (normal, once) => Object.freeze({
    actorUuid: String(actor.uuid ?? ""),
    resourceKey: ACTION_RESOURCE_KEY,
    amount: normal + once,
    normalSpent: normal,
    onceSpent: once
  });
  try {
    await actor.update({
      ...(normalSpent ? {
        [`system.resources.${ACTION_RESOURCE_KEY}.value`]: next,
        [`system.resources.${ACTION_RESOURCE_KEY}.spent`]: Math.max(0, state.max - next)
      } : {}),
      ...(onceSpent ? { [`system.resources.${ACTION_RESOURCE_KEY}.once`]: state.once - onceSpent } : {})
    }, createStrictActionPointUpdateOptions(context));
    const applied = getStrictActionPointState(actor);
    if (!applied || applied.current !== next || applied.once !== state.once - onceSpent) {
      const error = new Error("Strict action-point Actor update was cancelled or altered.");
      error.cancelled = true;
      throw error;
    }
  } catch (error) {
    const applied = getStrictActionPointState(actor);
    const normal = Math.min(normalSpent, Math.max(0, state.current - (applied?.current ?? state.current)));
    const once = Math.min(onceSpent, Math.max(0, state.once - (applied?.once ?? state.once)));
    if (normal + once > 0) {
      try {
        const restored = await refundStrictActionPointReceiptNow(actor, createReceipt(normal, once), context);
        if (restored < normal + once) throw new Error(`Only ${restored} of ${normal + once} strict action points were rolled back.`);
      } catch (rollbackError) {
        error.rollbackError ??= rollbackError;
      }
    }
    if (error.cancelled && !error.rollbackError) return empty();
    throw error;
  }
  return { spent: cost, receipt: createReceipt(normalSpent, onceSpent), events: [] };
}

/** Refund only this receipt's normal/once split, preserving later changes. */
export async function refundStrictActionPointReceipt(actor, receipt = null, context = {}) {
  return runOneTimeResourceMutation(actor, () => refundStrictActionPointReceiptNow(actor, receipt, context));
}

async function refundStrictActionPointReceiptNow(actor, receipt = null, context = {}) {
  const amount = Math.max(0, toInteger(receipt?.amount));
  if (!actor?.isOwner || !amount || receipt?.resourceKey !== ACTION_RESOURCE_KEY
    || String(receipt?.actorUuid ?? "") !== String(actor?.uuid ?? "")) return 0;
  const state = getStrictActionPointState(actor);
  if (!state) return 0;
  const onceAmount = Math.max(0, toInteger(receipt.onceSpent));
  // Older receipts contain only amount and therefore represent ordinary AP.
  const normalAmount = Math.max(0, toInteger(receipt.normalSpent ?? (amount - onceAmount)));
  const normalRestored = Math.max(0, Math.min(normalAmount, state.max - state.current));
  const updates = {
    ...(normalRestored ? {
      [`system.resources.${ACTION_RESOURCE_KEY}.value`]: state.current + normalRestored,
      [`system.resources.${ACTION_RESOURCE_KEY}.spent`]: Math.max(0, state.max - state.current - normalRestored)
    } : {}),
    ...(onceAmount ? { [`system.resources.${ACTION_RESOURCE_KEY}.once`]: state.once + onceAmount } : {})
  };
  if (!Object.keys(updates).length) return 0;
  await actor.update(updates, createStrictActionPointUpdateOptions(context, { falloutMawStrictActionPointRefund: true }));
  const applied = getStrictActionPointState(actor);
  if (!applied) return 0;
  return Math.min(amount,
    Math.min(normalRestored, Math.max(0, applied.current - state.current))
    + Math.min(onceAmount, Math.max(0, applied.once - state.once))
  );
}

function createStrictActionPointUpdateOptions(context = {}, extra = {}) {
  return {
    ...context?.documentOptions,
    ...extra,
    ...(context?.chainRef ? {
      chainRef: context.chainRef,
      falloutMawSystemEventChainRef: context.chainRef
    } : {})
  };
}
