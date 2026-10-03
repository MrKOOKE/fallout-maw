import { canUserManageConstructPassenger, getConstructCrewSeats, getConstructCrewSeatState, resolvePassengerActorSync } from "./construct-crew.mjs";
import { resolveConstructVisualAnchors } from "./construct-visual-model.mjs";
import { resolveActorItemOrInstalledModule } from "./item-functions.mjs";

/** Real character contexts come from the carrier's authoritative occupied seats. */
export function getConstructCrewContexts(carrierActor, user = globalThis.game?.user, { availableOnly = false } = {}) {
  if (carrierActor?.type !== "construct" || !user) return [];
  return getConstructCrewSeats(carrierActor).flatMap(seat => {
    const state = getConstructCrewSeatState(carrierActor, seat);
    const passenger = state.occupant;
    if (!passenger || availableOnly && !state.available || !canUserManageConstructPassenger(carrierActor, passenger, user)) return [];
    const actor = resolvePassengerActorSync(passenger);
    if (!actor) return [];
    return [{ carrierActor, actor, operatorActor: actor, seat, passenger, occupant: passenger,
      partSlotId: seat.partSlotId, personalWeapons: seat.personalWeapons, available: state.available, reason: state.reason }];
  });
}

/** Explicit invalid selections never silently switch to a different performer. */
export function getConstructCrewContext(carrierActor, user = globalThis.game?.user, { passengerId = "", operatorPassengerId = "", seatId = "", availableOnly = false } = {}) {
  const contexts = getConstructCrewContexts(carrierActor, user, { availableOnly });
  const id = String(passengerId || operatorPassengerId || "");
  if (id || seatId) return contexts.find(row => (!id || row.passenger.id === id) && (!seatId || row.seat.id === seatId)) ?? null;
  return contexts.at(0) ?? null;
}

/** HUD slots contain display rows; controls must resolve the real document on its correct owner. */
export function resolveConstructCrewWeaponSetItem(carrierActor, crewActor, weaponSet, itemId) {
  const id = String(itemId ?? "");
  if (!id || !weaponSet?.slots?.some(slot => slot.item?.id === id)) return null;
  return resolveActorItemOrInstalledModule(weaponSet.crewMounted ? carrierActor : crewActor, id);
}

export function canUserUseConstructCrewPersonalWeapon(carrierActor, weapon, user = globalThis.game?.user, options = {}) {
  const owner = weapon?.actor ?? weapon?.parent;
  const belongs = context => Boolean(owner && (owner === context.actor || owner.uuid && owner.uuid === context.actor.uuid));
  const explicit = Boolean(options.passengerId || options.operatorPassengerId || options.seatId);
  const context = explicit ? getConstructCrewContext(carrierActor, user, { ...options, availableOnly: true })
    : getConstructCrewContexts(carrierActor, user, { availableOnly: true }).find(belongs);
  if (!context?.personalWeapons?.enabled || !context.personalWeapons.anchorId || !weapon) return false;
  if (!resolveConstructVisualAnchors(carrierActor).some(anchor => anchor.id === context.personalWeapons.anchorId && anchor.parentVisible)) return false;
  return belongs(context);
}
