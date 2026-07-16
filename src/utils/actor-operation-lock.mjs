/**
 * Create a per-actor async operation lock with system-event-root reentrancy.
 *
 * Independent operations for one actor are serialized. An operation started
 * from a nested branch of the same system-event root bypasses the queue,
 * matching the resource-spending runtime's deadlock-avoidance contract.
 */
export function createActorOperationLock() {
  const pendingByActor = new Map();
  const activeRootsByActor = new Map();

  function run(actor, chainRef, operation) {
    const actorKey = String(actor?.uuid ?? actor?.id ?? "").trim();
    if (!actorKey) return Promise.resolve().then(operation);

    const rootId = getOperationRootId(chainRef);
    if (rootId && isRootActive(actorKey, rootId)) {
      // A reentrant branch must hold its own depth while it is running.  The
      // branch is intentionally allowed to bypass the actor queue (otherwise
      // a nested operation could deadlock on its parent), but dropping the
      // depth here would make the parent look idle while a fire-and-forget
      // child is still mutating the actor.
      enterRoot(actorKey, rootId);
      return Promise.resolve()
        .then(operation)
        .finally(() => leaveRoot(actorKey, rootId));
    }

    const previous = pendingByActor.get(actorKey) ?? Promise.resolve();
    let next;
    next = previous
      .catch(() => undefined)
      .then(async () => {
        enterRoot(actorKey, rootId);
        try {
          return await operation();
        } finally {
          leaveRoot(actorKey, rootId);
        }
      })
      .finally(() => {
        if (pendingByActor.get(actorKey) === next) pendingByActor.delete(actorKey);
      });
    pendingByActor.set(actorKey, next);
    return next;
  }

  function isRootActive(actorKey, rootId) {
    return (activeRootsByActor.get(actorKey)?.get(rootId) ?? 0) > 0;
  }

  function enterRoot(actorKey, rootId) {
    if (!rootId) return;
    const roots = activeRootsByActor.get(actorKey) ?? new Map();
    roots.set(rootId, (roots.get(rootId) ?? 0) + 1);
    activeRootsByActor.set(actorKey, roots);
  }

  function leaveRoot(actorKey, rootId) {
    if (!rootId) return;
    const roots = activeRootsByActor.get(actorKey);
    if (!roots) return;
    const depth = (roots.get(rootId) ?? 1) - 1;
    if (depth > 0) roots.set(rootId, depth);
    else roots.delete(rootId);
    if (!roots.size) activeRootsByActor.delete(actorKey);
  }

  return Object.freeze({ run });
}

function getOperationRootId(chainRef) {
  if (typeof chainRef === "string") return chainRef.trim();
  return String(chainRef?.rootId ?? "").trim();
}
