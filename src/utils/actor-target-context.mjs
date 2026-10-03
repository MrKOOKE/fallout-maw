import { getActorContainerFlag } from "./actor-containers.mjs";
import { getConstructCrewSeats, resolvePassengerActorSync } from "./construct-crew.mjs";

/** Recipients keep their own Actor identity and share the carrier's real spatial token. */
export function getActorTokenRecipients(token) {
  const physical = token?.object ?? token?.document?.object ?? token;
  const actor = token?.actor ?? token?.document?.actor;
  if (!actor) return [];
  const recipients = [], seen = new Set();
  const visit = (actor, label = "", passenger = null, carrierActor = null) => {
    if (!actor?.uuid || seen.has(actor.uuid)) return;
    seen.add(actor.uuid);
    recipients.push({ actor, actorUuid: actor.uuid, token: physical, label, passengerId: passenger?.id ?? "", carrierActor });
    const passengers = getActorContainerFlag(actor).passengers;
    if (!passengers.length) return;
    const seats = getConstructCrewSeats(actor);
    for (const passenger of passengers) {
      const child = resolvePassengerActorSync(passenger);
      const seat = seats.find(seat => seat.slotId === passenger.slotId && seat.slotIndex === passenger.slotIndex);
      visit(child, [label, seat?.name].filter(Boolean).join(" / "), passenger, actor);
    }
  };
  visit(actor);
  return recipients;
}

export function isActorAtPhysicalToken(actor, token) {
  return Boolean(actor?.uuid && getActorTokenRecipients(token).some(recipient => recipient.actorUuid === actor.uuid));
}

export function findActorPhysicalToken(actor) {
  const tokens = globalThis.canvas?.tokens;
  return [...(tokens?.controlled ?? []), ...(tokens?.placeables ?? [])]
    .find(token => isActorAtPhysicalToken(actor, token)) ?? null;
}

export function getActorTargetName(actor, token) {
  return (token?.actor ?? token?.document?.actor)?.uuid === actor?.uuid ? (token?.name ?? actor?.name ?? "") : actor?.name ?? "";
}
