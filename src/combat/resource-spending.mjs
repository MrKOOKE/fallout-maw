import { toInteger } from "../utils/numbers.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { getActorActiveCombat } from "./combat-membership.mjs";

export const COMBAT_RESOURCE_KEYS = Object.freeze({
  movement: "movementPoints",
  action: "actionPoints",
  reaction: "reactionPoints",
  dodge: "dodge"
});

const defaultRuntime = createCombatResourceSpendingRuntime();

export function beginCombatResourceSpending(actor) {
  return defaultRuntime.begin(actor);
}

export function notifyCombatResourcesSpent(actor, resources = {}, context = {}) {
  return defaultRuntime.notify(actor, resources, context);
}

function serializeResourceSpendingContext(context = {}) {
  if (!context || typeof context !== "object") return {};
  return Object.fromEntries(Object.entries(context).filter(([_key, value]) => (
    ["string", "boolean"].includes(typeof value)
    || (typeof value === "number" && Number.isFinite(value))
  )));
}

export async function waitForCombatResourceSpending(actor) {
  return defaultRuntime.wait(actor);
}

/**
 * Build an isolated resource-spending dispatcher. The factory keeps the
 * actor/root queue independently testable without a running Foundry client.
 */
export function createCombatResourceSpendingRuntime({
  withRoot = withSystemEventRoot,
  getActorCombat = getActorActiveCombat,
  randomId = () => globalThis.foundry?.utils?.randomID?.() ?? `${Date.now()}-${Math.random()}`,
  getSceneUuid = () => String(globalThis.canvas?.scene?.uuid ?? "")
} = {}) {
  const pendingByActor = new Map();
  const activeRootsByActor = new Map();
  const activeSpendingBarriers = new Map();

  function begin(actor) {
    const actorKey = getActorKey(actor);
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

  function notify(actor, resources = {}, context = {}) {
    const combat = getActorCombat(actor);
    if (!combat) return [];
    const normalized = normalizeCombatResourceVector(resources);
    if (!Object.keys(normalized).length) return [];

    const actorKey = getActorKey(actor);
    if (!actorKey) return [];
    const chainRef = context?.chainRef ?? context?.falloutMawSystemEventChainRef ?? null;
    const requestedRootId = getContextRootId(context);
    const dispatch = () => {
      const eventOptions = {
        kind: "combatResourceSpent",
        operationId: `resource-spent:${actorKey}:${randomId()}`,
        sceneUuid: String(getSceneUuid(actor, combat, context) ?? ""),
        combatUuid: String(combat.uuid ?? ""),
        chainRef,
        participants: {
          source: { actorUuid: String(actor.uuid ?? ""), tokenUuid: String(actor.token?.uuid ?? ""), itemUuid: "" },
          target: null,
          related: []
        }
      };
      return withRoot(eventOptions, scope => withActiveRoot(actorKey, scope?.rootId ?? requestedRootId, () => (
        scope.emit("fallout-maw.combat.resource.spent", {
          data: {
            actorUuid: String(actor.uuid ?? ""),
            resources: normalized,
            context: serializeResourceSpendingContext(context)
          },
          delta: { resources: Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, -value])) },
          outcome: { spent: true }
        }, eventOptions)
      )));
    };

    if (requestedRootId && isRootActive(actorKey, requestedRootId)) {
      return Promise.resolve().then(dispatch);
    }
    const previous = pendingByActor.get(actorKey) ?? Promise.resolve([]);
    const operation = previous
      .catch(() => undefined)
      .then(dispatch)
      .finally(() => {
        if (pendingByActor.get(actorKey) === operation) pendingByActor.delete(actorKey);
      });
    pendingByActor.set(actorKey, operation);
    return operation;
  }

  async function wait(actor) {
    const actorKey = getActorKey(actor);
    await Promise.all([...(activeSpendingBarriers.get(actorKey) ?? [])]);
    await (pendingByActor.get(actorKey) ?? Promise.resolve());
  }

  function isRootActive(actorKey, rootId) {
    return (activeRootsByActor.get(actorKey)?.get(rootId) ?? 0) > 0;
  }

  async function withActiveRoot(actorKey, rawRootId, operation) {
    const rootId = String(rawRootId ?? "").trim();
    if (!rootId) return operation();
    const roots = activeRootsByActor.get(actorKey) ?? new Map();
    roots.set(rootId, (roots.get(rootId) ?? 0) + 1);
    activeRootsByActor.set(actorKey, roots);
    try {
      return await operation();
    } finally {
      const depth = (roots.get(rootId) ?? 1) - 1;
      if (depth > 0) roots.set(rootId, depth);
      else roots.delete(rootId);
      if (!roots.size) activeRootsByActor.delete(actorKey);
    }
  }

  return Object.freeze({ begin, notify, wait });
}

function getActorKey(actor) {
  return String(actor?.uuid ?? actor?.id ?? "");
}

function getContextRootId(context = {}) {
  return String(
    context?.chainRef?.rootId
    ?? context?.falloutMawSystemEventChainRef?.rootId
    ?? context?.rootId
    ?? ""
  ).trim();
}

function normalizeCombatResourceVector(resources = {}) {
  return Object.fromEntries(Object.values(COMBAT_RESOURCE_KEYS)
    .map(key => [key, Math.max(0, toInteger(resources?.[key]))])
    .filter(([, amount]) => amount > 0));
}
