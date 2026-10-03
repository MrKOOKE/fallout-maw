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
  return candidates.find(combat => combatHasActor(combat, actor)
    || combatHasActor(combat, getActorCombatSubject(actor, combat))) ?? null;
}

/** Whether this actor is a participant in a started combat. */
export function isActorInActiveCombat(actor, combat = null) {
  return combat ? combatHasActor(combat, actor) || combatHasActor(combat, getActorCombatSubject(actor, combat))
    : Boolean(getActorActiveCombat(actor));
}

/** Crew shares its carrier's turn, while paying its own resources. */
export function getActorCombatSubject(actor, combat = null) {
  if (!actor?.uuid || combat && combatHasActor(combat, actor)) return actor;
  const seen = new Set();
  let current = actor;
  while (current?.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    const metadata = current.getFlag?.("fallout-maw", "actorContainerPassenger")
      ?? current.flags?.["fallout-maw"]?.actorContainerPassenger;
    // Linked passengers keep their original Actor; only parked synthetic copies
    // have passenger metadata. The vehicle's authoritative occupancy covers both.
    const vehicle = metadata?.vehicleActorUuid && metadata?.passengerId
      ? globalThis.fromUuidSync?.(metadata.vehicleActorUuid)
      : findOccupiedConstruct(current, combat);
    const passengers = vehicle?.getFlag?.("fallout-maw", "actorContainer")?.passengers
      ?? vehicle?.flags?.["fallout-maw"]?.actorContainer?.passengers ?? [];
    if (vehicle?.type !== "construct" || !passengers.some(passenger => (!metadata?.passengerId || passenger.id === metadata.passengerId)
      && passenger.actorUuid === current.uuid)) break;
    if (seen.has(vehicle.uuid)) return actor;
    current = vehicle;
    if (combat && combatHasActor(combat, current)) break;
  }
  return current;
}

function findOccupiedConstruct(actor, combat) {
  const candidates = [...Array.from(combat?.combatants ?? [], combatant => combatant.actor),
    ...Array.from(globalThis.game?.actors ?? [])];
  return candidates.find(vehicle => vehicle?.type === "construct"
    && (vehicle.getFlag?.("fallout-maw", "actorContainer")?.passengers
      ?? vehicle.flags?.["fallout-maw"]?.actorContainer?.passengers ?? [])
      .some(passenger => passenger.actorUuid === actor.uuid));
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
