import { toInteger } from "../utils/numbers.mjs";
import { getOneTimeResourceValue, runOneTimeResourceMutation, prepareActorResourceSpend } from "./one-time-resources.mjs";

export const ENERGY_RESOURCE_KEY = "power";
const RESOURCE_BLOCK_FLAG_SCOPE = "fallout-maw";
const RESOURCE_BLOCK_FLAG_KEY = "damageEffect";
const RESOURCE_BLOCK_KINDS = new Set(["resourceLimit", "resourceBlock"]);

export function getActorEnergy(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.value));
}

export function getActorAvailableEnergy(actor) {
  const resource = actor?.system?.resources?.[ENERGY_RESOURCE_KEY];
  const min = Math.max(0, toInteger(resource?.min));
  return Math.max(min, getActorEnergy(actor) + getOneTimeResourceValue(actor, ENERGY_RESOURCE_KEY) - getActorBlockedEnergy(actor));
}

export function canActorSpendEnergy(actor, cost = 0) {
  const resource = actor?.system?.resources?.[ENERGY_RESOURCE_KEY];
  return getActorAvailableEnergy(actor) - Math.max(0, toInteger(cost)) >= Math.max(0, toInteger(resource?.min));
}

/** Serialize energy mutations for one Actor without blocking unrelated Actors. */
export function runActorEnergyMutation(actor, operation) {
  if (typeof operation !== "function") {
    throw new TypeError("Energy mutation operation must be a function.");
  }

  return runOneTimeResourceMutation(actor, operation);
}

export function prepareActorEnergySpend(actor, amount = 0) {
  const min = Math.max(0, toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.min));
  return prepareActorResourceSpend(actor, ENERGY_RESOURCE_KEY, amount, {
    available: Math.max(0, getActorAvailableEnergy(actor) - min)
  });
}

export function spendActorEnergyWithReceipt(actor, amount = 0, options = {}) {
  return runActorEnergyMutation(actor, async () => {
    const cost = Math.max(0, toInteger(amount));
    if (!cost) return { spent: 0, receipt: null };
    const plan = prepareActorEnergySpend(actor, cost);
    if (!actor?.isOwner || !plan) return { spent: 0, receipt: null };
    const before = getActorEnergy(actor);
    const onceBefore = getOneTimeResourceValue(actor, ENERGY_RESOURCE_KEY);
    const receipt = Object.freeze({ actorUuid: String(actor.uuid ?? ""), resourceKey: ENERGY_RESOURCE_KEY,
      amount: cost, normalSpent: plan.normalSpent, onceSpent: plan.onceSpent });
    try {
      await actor.update({ ...plan.updates }, options);
      if (getActorEnergy(actor) !== before - plan.normalSpent
        || getOneTimeResourceValue(actor, ENERGY_RESOURCE_KEY) !== onceBefore - plan.onceSpent) {
        const error = new Error("Energy update was cancelled or altered."); error.cancelled = true; throw error;
      }
    } catch (error) {
      const normalSpent = Math.min(plan.normalSpent, Math.max(0, before - getActorEnergy(actor)));
      const onceSpent = Math.min(plan.onceSpent, Math.max(0, onceBefore - getOneTimeResourceValue(actor, ENERGY_RESOURCE_KEY)));
      if (normalSpent + onceSpent > 0) {
        try {
          const restored = await refundActorEnergyReceiptNow(actor, { ...receipt, amount: normalSpent + onceSpent, normalSpent, onceSpent }, options);
          if (restored !== normalSpent + onceSpent) throw new Error("Energy compensation was incomplete.");
        } catch (rollbackError) { error.rollbackError ??= rollbackError; }
      }
      if (error.cancelled && !error.rollbackError) return { spent: 0, receipt: null };
      throw error;
    }
    return { spent: cost, receipt };
  });
}

export function refundActorEnergyReceipt(actor, receipt, options = {}) {
  return runActorEnergyMutation(actor, () => refundActorEnergyReceiptNow(actor, receipt, options));
}

async function refundActorEnergyReceiptNow(actor, receipt, options = {}) {
  if (!actor?.isOwner || receipt?.resourceKey !== ENERGY_RESOURCE_KEY
    || String(receipt.actorUuid ?? "") !== String(actor.uuid ?? "")) return 0;
  const before = getActorEnergy(actor);
  const onceBefore = getOneTimeResourceValue(actor, ENERGY_RESOURCE_KEY);
  const maximum = Math.max(0, toInteger(actor.system?.resources?.[ENERGY_RESOURCE_KEY]?.max));
  const normal = Math.max(0, Math.min(toInteger(receipt.normalSpent), maximum - before));
  const once = Math.max(0, toInteger(receipt.onceSpent));
  if (!normal && !once) return 0;
  await actor.update({
    ...(normal ? { [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: before + normal,
      [`system.resources.${ENERGY_RESOURCE_KEY}.spent`]: Math.max(0, maximum - before - normal) } : {}),
    ...(once ? { [`system.resources.${ENERGY_RESOURCE_KEY}.once`]: onceBefore + once } : {})
  }, { ...options, falloutMawAbilityResourceRefund: true });
  return Math.min(normal, Math.max(0, getActorEnergy(actor) - before))
    + Math.min(once, Math.max(0, getOneTimeResourceValue(actor, ENERGY_RESOURCE_KEY) - onceBefore));
}

/**
 * Restore Energy up to its prepared maximum and report the unapplied overflow.
 * The value and tracked-spent fields are persisted by one Actor update.
 */
export function restoreActorEnergy(actor, amount = 0, options = {}) {
  const requested = Math.max(0, toInteger(amount));
  return runActorEnergyMutation(actor, async () => {
    const resource = actor?.system?.resources?.[ENERGY_RESOURCE_KEY];
    if (!resource) {
      return createEnergyRestorationResult({ requested, overflow: requested });
    }

    const minimum = Math.max(0, toInteger(resource.min));
    const maximum = Math.max(minimum, toInteger(resource.max));
    const before = Math.min(maximum, Math.max(minimum, toInteger(resource.value)));
    const restored = Math.min(requested, Math.max(0, maximum - before));
    const after = before + restored;
    const overflow = requested - restored;

    if (restored > 0) {
      await actor.update({
        [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: after,
        [`system.resources.${ENERGY_RESOURCE_KEY}.spent`]: Math.max(0, maximum - after)
      }, options);
    }

    return createEnergyRestorationResult({
      requested,
      restored,
      overflow,
      before,
      after,
      maximum
    });
  });
}

function getActorBlockedEnergy(actor) {
  let total = 0;
  for (const effect of actor?.effects ?? []) {
    if (effect?.disabled) continue;
    const data = effect.getFlag?.(RESOURCE_BLOCK_FLAG_SCOPE, RESOURCE_BLOCK_FLAG_KEY);
    if (!RESOURCE_BLOCK_KINDS.has(String(data?.kind ?? ""))) continue;
    total += Math.max(0, toInteger(data?.resources?.[ENERGY_RESOURCE_KEY]));
  }
  return total;
}

function createEnergyRestorationResult({
  requested = 0,
  restored = 0,
  overflow = 0,
  before = 0,
  after = before,
  maximum = 0
} = {}) {
  return {
    requested: Math.max(0, toInteger(requested)),
    restored: Math.max(0, toInteger(restored)),
    overflow: Math.max(0, toInteger(overflow)),
    before: Math.max(0, toInteger(before)),
    after: Math.max(0, toInteger(after)),
    max: Math.max(0, toInteger(maximum))
  };
}
