import { localize, format } from "../utils/i18n.mjs";
import { findAvailableConstructCrewSeat, getConstructCrewSeats } from "../utils/construct-crew.mjs";
import { chooseWithChips } from "./choice-chips.mjs";

export async function chooseConstructCrewBoardingSeat(actor, passengerActor, passengerToken) {
  const seats = getConstructCrewSeats(actor).filter(seat => findAvailableConstructCrewSeat(actor, passengerActor, passengerToken, { seatId: seat.id }));
  if (!seats.length) throw new Error(localize("FALLOUTMAW.ConstructCrew.NoAvailableSeat", "В конструкте нет подходящего свободного места экипажа."));
  return chooseWithChips({
    title: format("FALLOUTMAW.ConstructCrew.BoardingTitle", { vehicle: actor.name }, "Посадка: {vehicle}"),
    prompt: passengerActor.name,
    choices: seats.map(seat => ({ value: seat.id, label: seat.name,
      detail: localize(`FALLOUTMAW.ConstructCrew.Roles.${seat.role}`, seat.role), img: passengerActor.img }))
  });
}
