const combatantCreateRefreshes = new WeakMap();

/**
 * Observe one synchronous core call into ActiveEffect.registry without adding
 * another registry traversal. Foundry invokes refresh synchronously from its
 * Combat document callbacks, although the returned work is asynchronous.
 */
export function captureActiveEffectRegistryRefresh(
  registry,
  { event = "", matchesContext = () => true } = {},
  operation,
  onCapture
) {
  const hadOwnRefresh = Object.hasOwn(registry, "refresh");
  const ownRefreshDescriptor = hadOwnRefresh
    ? Object.getOwnPropertyDescriptor(registry, "refresh")
    : null;
  const originalRefresh = registry.refresh;
  registry.refresh = function(refreshEvent, context) {
    const result = originalRefresh.call(this, refreshEvent, context);
    if (refreshEvent === event && matchesContext(context)) {
      const captured = Promise.resolve(result);
      void captured.catch(() => undefined);
      onCapture?.(captured);
    }
    return result;
  };
  try {
    return operation();
  } finally {
    if (hadOwnRefresh) Object.defineProperty(registry, "refresh", ownRefreshDescriptor);
    else delete registry.refresh;
  }
}

export function trackCombatantCreateActiveEffectRefresh(combatants = [], promise = Promise.resolve()) {
  for (const combatant of combatants ?? []) {
    if (combatant && typeof combatant === "object") {
      combatantCreateRefreshes.set(combatant, promise);
    }
  }
}

export async function waitForCombatantCreateActiveEffectRefresh(combatants = []) {
  const documents = Array.from(combatants ?? []);
  const promises = new Set(documents
    .map(combatant => combatantCreateRefreshes.get(combatant))
    .filter(Boolean));
  try {
    await Promise.all(promises);
  } finally {
    for (const combatant of documents) combatantCreateRefreshes.delete(combatant);
  }
}
