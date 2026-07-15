/** The actor's started combat, independent of which tracker a client is viewing. */
export function getActorActiveCombat(actor, preferredCombat = null) {
  if (!actor?.uuid) return null;
  const candidates = [];
  if (preferredCombat) candidates.push(preferredCombat);
  for (const combat of globalThis.game?.combats ?? []) {
    if (!candidates.includes(combat)) candidates.push(combat);
  }
  const viewedCombat = globalThis.game?.combat ?? null;
  if (viewedCombat && !candidates.includes(viewedCombat)) candidates.push(viewedCombat);
  return candidates.find(combat => combatHasActor(combat, actor)) ?? null;
}

/** Whether this actor is a participant in a started combat. */
export function isActorInActiveCombat(actor, combat = null) {
  return combat ? combatHasActor(combat, actor) : Boolean(getActorActiveCombat(actor));
}

function combatHasActor(combat, actor) {
  if (!combat?.started || !actor?.uuid) return false;
  try {
    const matches = combat.getCombatantsByActor?.(actor);
    if (matches?.length) return true;
  } catch (_error) {
    // Fall back to UUID comparison for partial documents and test doubles.
  }
  return Array.from(combat.combatants ?? [])
    .some(combatant => combatant?.actor?.uuid === actor.uuid);
}
