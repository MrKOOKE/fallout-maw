import { toInteger } from "../utils/numbers.mjs";
import { dispatchSystemEvent } from "../events/dispatcher.mjs";

export const COMBAT_RESOURCE_KEYS = Object.freeze({
  movement: "movementPoints",
  action: "actionPoints",
  reaction: "reactionPoints"
});

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

export function notifyCombatResourcesSpent(actor, resources = {}, context = {}) {
  if (!game.combat?.started || !actor) return [];
  const normalized = Object.fromEntries(Object.values(COMBAT_RESOURCE_KEYS)
    .map(key => [key, Math.max(0, toInteger(resources?.[key]))])
    .filter(([, amount]) => amount > 0));
  if (!Object.keys(normalized).length) return [];

  const actorKey = String(actor.uuid ?? actor.id ?? "");
  const previous = pendingByActor.get(actorKey) ?? Promise.resolve([]);
  const operation = previous.then(async () => {
    return dispatchSystemEvent("fallout-maw.combat.resource.spent", {
      data: {
        actorUuid: String(actor.uuid ?? ""),
        resources: normalized,
        context: serializeResourceSpendingContext(context)
      },
      delta: { resources: Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, -value])) },
      outcome: { spent: true }
    }, {
      kind: "combatResourceSpent",
      operationId: `resource-spent:${actorKey}:${foundry.utils.randomID()}`,
      sceneUuid: String(canvas?.scene?.uuid ?? ""),
      combatUuid: String(game.combat?.uuid ?? ""),
      chainRef: context?.chainRef ?? context?.falloutMawSystemEventChainRef ?? null,
      participants: {
        source: { actorUuid: String(actor.uuid ?? ""), tokenUuid: String(actor.token?.uuid ?? ""), itemUuid: "" },
        target: null,
        related: []
      }
    });
  });
  pendingByActor.set(actorKey, operation);
  void operation.finally(() => {
    if (pendingByActor.get(actorKey) === operation) pendingByActor.delete(actorKey);
  });
  return operation;
}

function serializeResourceSpendingContext(context = {}) {
  if (!context || typeof context !== "object") return {};
  return Object.fromEntries(Object.entries(context).filter(([_key, value]) => (
    ["string", "boolean"].includes(typeof value)
    || (typeof value === "number" && Number.isFinite(value))
  )));
}

export async function waitForCombatResourceSpending(actor) {
  const actorKey = String(actor?.uuid ?? actor?.id ?? "");
  await Promise.all([...(activeSpendingBarriers.get(actorKey) ?? [])]);
  await (pendingByActor.get(actorKey) ?? Promise.resolve());
}
