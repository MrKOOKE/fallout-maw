import { SYSTEM_ID } from "../constants.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "./item-functions.mjs";
import { toInteger } from "./numbers.mjs";

export const ACTOR_CONTAINER_FLAG = "actorContainer";

export function getActorContainerFlag(actor = null) {
  const flag = actor?.getFlag?.(SYSTEM_ID, ACTOR_CONTAINER_FLAG) ?? {};
  return {
    passengers: normalizeActorContainerPassengers(flag.passengers)
  };
}

export function normalizeActorContainerPassengers(passengers = []) {
  return (Array.isArray(passengers) ? passengers : [])
    .map(passenger => ({
      id: String(passenger?.id ?? passenger?.actorUuid ?? foundry.utils.randomID()),
      actorUuid: String(passenger?.actorUuid ?? ""),
      actorName: String(passenger?.actorName ?? ""),
      actorImg: String(passenger?.actorImg ?? ""),
      sceneId: String(passenger?.sceneId ?? ""),
      tokenData: passenger?.tokenData && typeof passenger.tokenData === "object"
        ? foundry.utils.deepClone(passenger.tokenData)
        : null,
      slotId: String(passenger?.slotId ?? ""),
      slotIndex: Math.max(0, toInteger(passenger?.slotIndex)),
      x: Math.max(1, toInteger(passenger?.x) || 1),
      y: Math.max(1, toInteger(passenger?.y) || 1),
      width: Math.max(1, toInteger(passenger?.width) || 1),
      height: Math.max(1, toInteger(passenger?.height) || 1),
      temporaryOwnerUserIds: normalizeStringArray(passenger?.temporaryOwnerUserIds),
      temporaryOwnerLevels: normalizeOwnerLevels(passenger?.temporaryOwnerLevels)
    }))
    .filter(passenger => passenger.actorUuid && passenger.slotId);
}

export function hasActorContainer(actor = null, { requireSlots = true } = {}) {
  return getActorContainerSeatDefinitions(actor).some(seat => !requireSlots || seat.quantity > 0);
}

export function getActorContainerSeatDefinitions(actor = null) {
  const seats = [];
  for (const item of actor?.items?.contents ?? []) {
    if (item?.type !== "gear") continue;
    if (!hasItemFunction(item, ITEM_FUNCTIONS.actorContainer, { ignoreBroken: true })) continue;
    const slots = Array.isArray(item.system?.functions?.actorContainer?.slots)
      ? item.system.functions.actorContainer.slots
      : [];
    for (const slot of slots) {
      const baseId = String(slot?.id ?? "").trim() || foundry.utils.randomID();
      const width = Math.max(1, toInteger(slot?.width) || 1);
      const height = Math.max(1, toInteger(slot?.height) || 1);
      const quantity = Math.max(0, toInteger(slot?.quantity));
      if (!quantity) continue;
      seats.push({
        itemId: item.id,
        itemName: item.name,
        baseSlotId: baseId,
        slotId: `${item.id}:${baseId}`,
        width,
        height,
        quantity
      });
    }
  }
  return seats;
}

export function getActorContainerPassengerSize(actor = null, token = null) {
  const tokenDocument = token?.document ?? token;
  return {
    width: Math.max(1, Math.ceil(Number(tokenDocument?.width) || toInteger(actor?.system?.inventory?.columns) || 1)),
    height: Math.max(1, Math.ceil(Number(tokenDocument?.height) || toInteger(actor?.system?.inventory?.rows) || 1))
  };
}

export function findFirstAvailableActorContainerSeat(containerActor = null, passengerActor = null, passengerToken = null) {
  const size = getActorContainerPassengerSize(passengerActor, passengerToken);
  const passengers = getActorContainerFlag(containerActor).passengers;
  for (const seat of getActorContainerSeatDefinitions(containerActor)) {
    if (size.width > seat.width || size.height > seat.height) continue;
    for (let slotIndex = 0; slotIndex < seat.quantity; slotIndex += 1) {
      const occupants = passengers.filter(passenger => passenger.slotId === seat.slotId && passenger.slotIndex === slotIndex);
      const placement = findFirstActorPlacement(seat.width, seat.height, size, occupants);
      if (placement) return {
        ...seat,
        slotIndex,
        passengerWidth: size.width,
        passengerHeight: size.height,
        passengerX: placement.x,
        passengerY: placement.y
      };
    }
  }
  return null;
}

export function isActorInActorContainer(actor = null) {
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid) return false;
  for (const candidate of getActorContainerCandidateActors()) {
    if (getActorContainerFlag(candidate).passengers.some(passenger => passenger.actorUuid === actorUuid)) return true;
  }
  return false;
}

export function prepareActorContainerInventoryContext(actor = null) {
  const seats = getActorContainerSeatDefinitions(actor);
  const passengers = getActorContainerFlag(actor).passengers;
  return prepareActorContainerGridContext(seats, passengers);
}

export function prepareActorContainerGridContext(seats = [], passengers = []) {
  if (!seats.length) return { visible: false, groups: [] };
  const groups = new Map();
  for (const seat of seats) {
    let group = groups.get(seat.itemId);
    if (!group) {
      group = { id: seat.itemId, name: seat.itemName, rows: [] };
      groups.set(seat.itemId, group);
    }
    const instances = [];
    for (let index = 0; index < seat.quantity; index += 1) {
      const occupants = passengers.filter(entry => entry.slotId === seat.slotId && entry.slotIndex === index);
      instances.push({
        id: `${seat.slotId}:${index}`,
        slotId: seat.slotId,
        slotIndex: index,
        columns: seat.width,
        rows: seat.height,
        cells: buildActorContainerCells(seat.width, seat.height, occupants).map(cell => ({
          ...cell,
          slotId: seat.slotId,
          slotIndex: index
        })),
        passengers: occupants.map(passenger => ({
          ...passenger,
          gridStyle: buildActorContainerPassengerStyle(passenger)
        }))
      });
    }
    group.rows.push({ id: seat.slotId, instances });
  }
  return {
    visible: true,
    groups: Array.from(groups.values()),
    occupied: passengers.length,
    totalCells: seats.reduce((total, seat) => total + (seat.width * seat.height * seat.quantity), 0)
  };
}

export async function moveActorContainerPassenger(actor = null, passengerId = "", target = {}) {
  if (!actor?.isOwner) return false;
  const passengers = getActorContainerFlag(actor).passengers;
  const updated = moveActorContainerPassengerData(
    getActorContainerSeatDefinitions(actor),
    passengers,
    passengerId,
    target
  );
  if (!updated) return false;
  await actor.update({ [`flags.${SYSTEM_ID}.${ACTOR_CONTAINER_FLAG}.passengers`]: updated });
  return true;
}

export function moveActorContainerPassengerData(seats = [], passengers = [], passengerId = "", target = {}) {
  const passenger = passengers.find(entry => entry.id === passengerId);
  if (!passenger) return null;
  const seat = seats.find(entry => entry.slotId === String(target.slotId ?? ""));
  const slotIndex = Math.max(0, toInteger(target.slotIndex));
  const placement = {
    x: Math.max(1, toInteger(target.x) || 1),
    y: Math.max(1, toInteger(target.y) || 1),
    width: passenger.width,
    height: passenger.height
  };
  if (!seat || slotIndex >= seat.quantity) return null;
  if ((placement.x + placement.width - 1) > seat.width || (placement.y + placement.height - 1) > seat.height) return null;
  const occupants = passengers.filter(entry => entry.id !== passenger.id && entry.slotId === seat.slotId && entry.slotIndex === slotIndex);
  if (occupants.some(occupant => actorPlacementsOverlap(placement, occupant))) return null;
  return passengers.map(entry => entry.id === passenger.id
    ? { ...entry, slotId: seat.slotId, slotIndex, x: placement.x, y: placement.y }
    : entry);
}

export async function resolveActorContainerPassengerActor(vehicleActor = null, passengerId = "") {
  const passenger = getActorContainerFlag(vehicleActor).passengers.find(entry => entry.id === passengerId);
  if (!passenger) return null;
  const actor = await globalThis.fromUuid?.(passenger.actorUuid);
  if (actor) return actor;
  return passenger.tokenData?.actorId ? game.actors?.get(passenger.tokenData.actorId) ?? null : null;
}

export function getActorContainerPassengerUsers(actor = null) {
  const userIds = new Set();
  for (const passenger of getActorContainerFlag(actor).passengers) {
    for (const userId of passenger.temporaryOwnerUserIds ?? []) userIds.add(userId);
  }
  return userIds;
}

function normalizeStringArray(values = []) {
  return (Array.isArray(values) ? values : [])
    .map(value => String(value ?? "").trim())
    .filter(Boolean);
}

function findFirstActorPlacement(columns, rows, size, occupants = []) {
  for (let y = 1; y <= rows - size.height + 1; y += 1) {
    for (let x = 1; x <= columns - size.width + 1; x += 1) {
      const candidate = { x, y, width: size.width, height: size.height };
      if (!occupants.some(occupant => actorPlacementsOverlap(candidate, occupant))) return candidate;
    }
  }
  return null;
}

function actorPlacementsOverlap(left, right) {
  return !(
    left.x + left.width <= right.x
    || right.x + right.width <= left.x
    || left.y + left.height <= right.y
    || right.y + right.height <= left.y
  );
}

function buildActorContainerCells(columns, rows, occupants = []) {
  const cells = [];
  for (let y = 1; y <= rows; y += 1) {
    for (let x = 1; x <= columns; x += 1) {
      cells.push({
        x,
        y,
        occupied: occupants.some(passenger => (
          x >= passenger.x
          && x < passenger.x + passenger.width
          && y >= passenger.y
          && y < passenger.y + passenger.height
        )),
        style: `grid-column: ${x}; grid-row: ${y};`
      });
    }
  }
  return cells;
}

function buildActorContainerPassengerStyle(passenger) {
  return [
    `grid-column: ${passenger.x} / span ${passenger.width};`,
    `grid-row: ${passenger.y} / span ${passenger.height};`
  ].join(" ");
}

function getActorContainerCandidateActors() {
  const actors = [];
  const seen = new Set();
  for (const actor of game.actors?.contents ?? []) {
    if (!actor?.uuid || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    actors.push(actor);
  }
  for (const token of canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (!actor?.uuid || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    actors.push(actor);
  }
  return actors;
}

function normalizeOwnerLevels(levels = {}) {
  return Object.fromEntries(Object.entries(levels ?? {})
    .map(([key, value]) => [String(key ?? "").trim(), toInteger(value)])
    .filter(([key]) => key));
}
