import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getActorContainerFlag, hasActorContainer } from "../utils/actor-containers.mjs";
import { TRAVEL_GROUP_FLAG } from "./constants.mjs";
import { evaluateTravelSpeed } from "./travel-speed.mjs";

export function isTravelGroupCarrierActor(actor = null) {
  return Boolean(actor?.getFlag?.(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG)?.groupId);
}

export function getTravelGroupData(actor = null) {
  return actor?.getFlag?.(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG) ?? null;
}

export function getTravelGroupUnits(actor = null) {
  const group = getTravelGroupData(actor) ?? {};
  const source = Array.isArray(group.units) && group.units.length
    ? group.units
    : getActorContainerFlag(actor).passengers;
  return (Array.isArray(source) ? source : []).map(normalizeTravelGroupUnit).filter(unit => unit.actorUuid || unit.tokenData);
}

export function normalizeTravelGroupUnit(unit = {}) {
  return {
    id: String(unit?.id ?? unit?.actorUuid ?? foundry.utils.randomID()),
    actorUuid: String(unit?.actorUuid ?? ""),
    actorName: String(unit?.actorName ?? unit?.name ?? ""),
    actorImg: String(unit?.actorImg ?? unit?.img ?? ""),
    tokenData: unit?.tokenData && typeof unit.tokenData === "object" ? foundry.utils.deepClone(unit.tokenData) : null,
    actorContainer: normalizeActorContainerSnapshot(unit?.actorContainer),
    travelFormulaData: normalizeTravelFormulaSnapshot(unit?.travelFormulaData),
    speedKmh: Math.max(0, Number(unit?.speedKmh) || 0)
  };
}

export async function resolveTravelGroupUnitActor(unit = {}) {
  return resolveTravelActorReference(unit.actorUuid, unit.tokenData, unit.actorName);
}

export async function resolveTravelPassengerActor(passenger = {}) {
  return resolveTravelActorReference(passenger.actorUuid, passenger.tokenData, passenger.actorName);
}

export function getTravelUnitPassengers(unit = {}, unitActor = null) {
  const snapshot = normalizeActorContainerSnapshot(unit.actorContainer);
  if (snapshot) return snapshot.passengers;
  return unitActor ? getActorContainerFlag(unitActor).passengers : [];
}

export function isTravelVehicleUnit(unit = {}, actor = null) {
  return Boolean(unit.actorContainer?.seats?.length || (actor && hasActorContainer(actor)));
}

export async function calculateTravelGroupSpeed(actor = null) {
  const group = getTravelGroupData(actor) ?? {};
  const speeds = [];
  for (const unit of getTravelGroupUnits(actor)) {
    const unitActor = await resolveTravelGroupUnitActor(unit);
    const speed = evaluateTravelSpeed(unitActor, unit.travelFormulaData, {
      fallback: unit.speedKmh || group.effectiveSpeedKmh
    });
    speeds.push(speed);
  }
  if (!speeds.length) return Math.max(0, Number(group.effectiveSpeedKmh) || 0);
  return Math.min(...speeds);
}

async function resolveTravelActorReference(actorUuid = "", tokenData = null, actorName = "") {
  const actorId = String(tokenData?.actorId ?? "").trim();
  if (actorId) {
    const actor = game.actors?.get(actorId);
    if (actor) return actor;
  }
  const uuid = String(actorUuid ?? "").trim();
  if (uuid) {
    if (uuid.startsWith("Actor.")) {
      const actor = game.actors?.get(uuid.slice("Actor.".length));
      if (actor) return actor;
    }
    const actor = await (globalThis.fromUuid ?? foundry.utils.fromUuid)?.(uuid);
    if (actor) return actor;
  }
  const name = String(actorName ?? tokenData?.name ?? "").trim();
  if (!name) return null;
  const matches = (game.actors?.contents ?? []).filter(actor => actor.name === name);
  return matches.length === 1 ? matches[0] : null;
}

function normalizeActorContainerSnapshot(value = null) {
  if (!value || typeof value !== "object") return null;
  const seats = Array.isArray(value.seats) ? foundry.utils.deepClone(value.seats) : [];
  const passengers = Array.isArray(value.passengers) ? foundry.utils.deepClone(value.passengers) : [];
  return seats.length || passengers.length ? { seats, passengers } : null;
}

function normalizeTravelFormulaSnapshot(value = null) {
  if (!value || typeof value !== "object") return null;
  return {
    characteristics: foundry.utils.deepClone(value.characteristics ?? {}),
    skills: foundry.utils.deepClone(value.skills ?? {}),
    movementPointsMax: Math.max(0, Number(value.movementPointsMax) || 0)
  };
}
