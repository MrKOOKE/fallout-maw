function getActiveEffectRegistry() {
  const implementation = globalThis.foundry?.documents?.ActiveEffect?.implementation ?? globalThis.ActiveEffect;
  return implementation?.registry;
}

/** Remove a deleted document immediately instead of waiting for weak-reference collection. */
export function unregisterDeletedActiveEffect(effect) {
  getActiveEffectRegistry()?.delete(effect);
}

/** Reconcile document identity and restore live effects dropped by a failed expiry batch. */
export function reconcileActiveEffectRegistry(registry, actors) {
  let removed = 0;
  for (const effect of registry) {
    const parent = effect.parent;
    const actor = effect.actor;
    const detachedItem = parent?.documentName === "Item" && actor?.documentName === "Actor"
      && actor.items?.get(parent.id) !== parent;
    if (parent?.effects?.get(effect.id) !== effect || detachedItem) {
      registry.delete(effect);
      removed += 1;
    }
  }
  for (const actor of actors) registry.addFromParent(actor);
  return removed;
}

/** Keep system expiry events within Foundry's registry while making failed batches retryable. */
export async function refreshActorEffectExpiration(event, context) {
  const registry = getActiveEffectRegistry();
  if (!registry?.refresh || !context.actors?.size) return;
  reconcileActiveEffectRegistry(registry, context.actors);
  try {
    await registry.refresh(event, context);
  } catch (error) {
    // Foundry unregisters an expired effect before its database modification succeeds.
    reconcileActiveEffectRegistry(registry, context.actors);
    throw error;
  }
}
