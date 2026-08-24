import { toInteger } from "../utils/numbers.mjs";

export const ENERGY_RESOURCE_KEY = "power";
const RESOURCE_BLOCK_FLAG_SCOPE = "fallout-maw";
const RESOURCE_BLOCK_FLAG_KEY = "damageEffect";
const RESOURCE_BLOCK_KINDS = new Set(["resourceLimit", "resourceBlock"]);
const actorEnergyMutationQueue = new Map();

export function getActorEnergy(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.value));
}

export function getActorAvailableEnergy(actor) {
  const resource = actor?.system?.resources?.[ENERGY_RESOURCE_KEY];
  const min = Math.max(0, toInteger(resource?.min));
  return Math.max(min, getActorEnergy(actor) - getActorBlockedEnergy(actor));
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

  const actorKey = String(actor?.uuid ?? actor?.id ?? "").trim();
  if (!actorKey) return Promise.resolve().then(operation);

  const previous = actorEnergyMutationQueue.get(actorKey) ?? Promise.resolve();
  let next;
  next = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (actorEnergyMutationQueue.get(actorKey) === next) actorEnergyMutationQueue.delete(actorKey);
    });
  actorEnergyMutationQueue.set(actorKey, next);
  return next;
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
