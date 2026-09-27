import { SYSTEM_ID } from "../constants.mjs";

export const ACTOR_CONTAINER_PASSENGER_FLAG = "actorContainerPassenger";

/** Keep parked passengers attached to their vehicle when its synthetic UUID changes. */
export async function prepareActorContainerPassengerRebindings(actor, destinationActorUuid) {
  if (!actor?.uuid || actor.uuid === destinationActorUuid) return [];
  const passengers = actor.getFlag?.(SYSTEM_ID, "actorContainer")?.passengers ?? [];
  const updates = [];
  for (const passenger of passengers) {
    if (!passenger.parkedActorId) continue;
    const parked = await fromUuid(passenger.actorUuid);
    const metadata = parked?.getFlag?.(SYSTEM_ID, ACTOR_CONTAINER_PASSENGER_FLAG);
    if (!parked || parked.id !== passenger.parkedActorId || metadata?.vehicleActorUuid !== actor.uuid
      || metadata?.passengerId !== passenger.id) throw new Error("Не удалось подтвердить пассажира перемещаемого транспорта.");
    updates.push({ _id: parked.id,
      [`flags.${SYSTEM_ID}.${ACTOR_CONTAINER_PASSENGER_FLAG}.vehicleActorUuid`]: destinationActorUuid });
  }
  return updates;
}
