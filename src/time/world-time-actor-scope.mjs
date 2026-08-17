import {
  getActorContainerFlag,
  resolveActorContainerPassengerActor
} from "../utils/actor-containers.mjs";
import {
  isTravelGroupCarrierActor,
  resolveTravelGroupParticipants
} from "../global-map/travel-group-data.mjs";

/**
 * Resolve the only Actors which world-time mechanics are allowed to touch:
 * Actors represented by Tokens on the active Scene, their recursively nested
 * actor-container passengers, and the real participants represented by a
 * travel-group carrier Actor.
 */
export async function collectActiveSceneWorldTimeActors({
  scene = globalThis.canvas?.scene ?? null,
  tokens = scene?.tokens?.contents ?? scene?.tokens ?? []
} = {}) {
  if (!scene) return [];

  const actors = new Map();
  const queue = [];
  const enqueue = actor => {
    const uuid = String(actor?.uuid ?? "");
    if (!uuid || actors.has(uuid)) return;
    actors.set(uuid, actor);
    queue.push(actor);
  };

  for (const candidate of tokens ?? []) {
    const token = candidate?.document ?? candidate;
    enqueue(candidate?.actor ?? token?.actor);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const actor = queue[cursor];
    const passengers = getActorContainerFlag(actor).passengers;
    if (passengers.length) {
      const resolved = await Promise.all(passengers.map(passenger => (
        resolveActorContainerPassengerActor(actor, passenger.id).catch(() => null)
      )));
      for (const passengerActor of resolved) enqueue(passengerActor);
    }

    if (!isTravelGroupCarrierActor(actor)) continue;
    const participants = await resolveTravelGroupParticipants(actor, {
      allowNameFallback: false
    }).catch(() => []);
    for (const participant of participants) enqueue(participant?.actor);
  }

  return Array.from(actors.values());
}
