import { toInteger } from "../utils/numbers.mjs";

export const COMBAT_RESOURCE_KEYS = Object.freeze({
  movement: "movementPoints",
  action: "actionPoints",
  reaction: "reactionPoints"
});

const providers = new Map();
const pendingByActor = new Map();
const activeSpendingBarriers = new Map();

export function beginCombatResourceSpending(actor) {
  const actorKey = String(actor?.uuid ?? actor?.id ?? "");
  if (!actorKey) return () => {};
  let resolveBarrier;
  const barrier = new Promise(resolve => {
    resolveBarrier = resolve;
  });
  const barriers = activeSpendingBarriers.get(actorKey) ?? new Set();
  barriers.add(barrier);
  activeSpendingBarriers.set(actorKey, barriers);
  return () => {
    barriers.delete(barrier);
    if (!barriers.size) activeSpendingBarriers.delete(actorKey);
    resolveBarrier();
  };
}

export function registerCombatResourceSpendingProvider(provider = {}) {
  const id = String(provider?.id ?? "").trim();
  if (!id || typeof provider.execute !== "function") return false;
  providers.set(id, provider);
  return true;
}

export function notifyCombatResourcesSpent(actor, resources = {}, context = {}) {
  if (!game.combat?.started || !actor) return [];
  const normalized = Object.fromEntries(Object.values(COMBAT_RESOURCE_KEYS)
    .map(key => [key, Math.max(0, toInteger(resources?.[key]))])
    .filter(([, amount]) => amount > 0));
  if (!Object.keys(normalized).length) return [];

  const actorKey = String(actor.uuid ?? actor.id ?? "");
  const previous = pendingByActor.get(actorKey) ?? Promise.resolve([]);
  const operation = previous.then(async () => {
    const results = [];
    for (const provider of providers.values()) {
      try {
        results.push(await provider.execute({ actor, resources: normalized, context }));
      } catch (error) {
        console.error(`Fallout MaW | Resource spending provider failed: ${provider.id}`, error);
      }
    }
    return results;
  });
  pendingByActor.set(actorKey, operation);
  void operation.finally(() => {
    if (pendingByActor.get(actorKey) === operation) pendingByActor.delete(actorKey);
  });
  return operation;
}

export async function waitForCombatResourceSpending(actor) {
  const actorKey = String(actor?.uuid ?? actor?.id ?? "");
  await Promise.all([...(activeSpendingBarriers.get(actorKey) ?? [])]);
  await (pendingByActor.get(actorKey) ?? Promise.resolve());
}
