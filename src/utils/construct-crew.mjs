import { SYSTEM_ID } from "../constants.mjs";
import { actorHasIncapacitatingStatus } from "../combat/incapacitation.mjs";
import {
  getActorContainerFlag,
  getActorContainerPassengerSize,
  getActorContainerSeatDefinitions
} from "./actor-containers.mjs";
import {
  getConstructPartSlotId,
  getConstructPartSlotIdFromLimbKey,
  getInstalledConstructPartForSlot,
  isInstalledConstructPartItem
} from "./construct-parts.mjs";
import { getEnabledWeaponFunctions, isItemBrokenByCondition } from "./item-functions.mjs";
import { normalizeConstructPersonalWeapons } from "./construct-firing-port-model.mjs";

export const CONSTRUCT_CREW_FUNCTIONS = Object.freeze(["move", "rotate", "aim", "fire", "reload", "activate"]);
export const CONSTRUCT_CREW_ROLES = Object.freeze(["passenger", "driver", "gunner", "loader", "custom"]);
const ROLE_FUNCTIONS = Object.freeze({ passenger: [], driver: ["move", "rotate"], gunner: ["aim", "fire", "reload"], loader: ["reload"], custom: [] });

/** Crew positions reuse native actor-container placements; there is one occupant per position. */
export function getConstructCrewSeats(actor = null) {
  if (actor?.type !== "construct") return [];
  const config = actor.getFlag?.(SYSTEM_ID, "constructVisual") ?? actor.flags?.[SYSTEM_ID]?.constructVisual ?? {};
  const rows = Array.isArray(config.seats) ? config.seats : [];
  const seenIds = new Set();
  const seenPositions = new Set();
  return rows.map((row, index) => {
    const id = String(row?.id ?? `crew-${index}`).trim();
    const role = CONSTRUCT_CREW_ROLES.includes(row?.role) ? row.role : "passenger";
    const functions = Array.isArray(row?.functions)
      ? row.functions.filter(key => CONSTRUCT_CREW_FUNCTIONS.includes(key))
      : row?.permissions && typeof row.permissions === "object"
        ? CONSTRUCT_CREW_FUNCTIONS.filter(key => row.permissions[key] === true || (key === "rotate" && row.permissions.move === true))
        : ROLE_FUNCTIONS[role];
    const slotId = String(row?.slotId ?? "").trim();
    const slotIndex = Math.max(0, Math.trunc(Number(row?.slotIndex) || 0));
    const position = `${slotId}:${slotIndex}`;
    if (!id || !slotId || seenIds.has(id) || seenPositions.has(position)) return null;
    seenIds.add(id);
    seenPositions.add(position);
    return { id, name: String(row?.name ?? "").trim() || `Место ${index + 1}`, role,
      functions: [...new Set(functions)], slotId, slotIndex, partSlotId: String(row?.partSlotId ?? "").trim(),
      systemIds: Array.from(new Set(Array.isArray(row?.systemIds) ? row.systemIds.map(String) : [])),
      reloadPartSlotIds: Array.from(new Set((Array.isArray(row?.reloadPartSlotIds) ? row.reloadPartSlotIds.slice(0, 256) : [])
        .map(value => String(value ?? "").trim()).filter(Boolean))),
      personalWeapons: normalizeConstructCrewPersonalWeapons(row?.personalWeapons) };
  }).filter(Boolean);
}

export function normalizeConstructCrewPersonalWeapons(raw = {}) {
  return normalizeConstructPersonalWeapons(raw);
}

/** Extra detail assignments grant reload only; aiming and firing keep their primary binding. */
export function isConstructCrewSeatAssignedToPart(seat, partSlotId, action) {
  const id = String(partSlotId ?? "").trim();
  return Boolean(id && (seat?.partSlotId === id
    || action === "reload" && seat?.reloadPartSlotIds?.includes(id)));
}

export function hasConstructCrew(actor = null) {
  return getConstructCrewSeats(actor).length > 0;
}

/** Preserve real ownership while retiring OWNER grants created by the old boarding stub. */
export async function removeConstructPassengerOwnershipGrants(actor = null) {
  if (!hasConstructCrew(actor)) return false;
  const passengers = getActorContainerFlag(actor).passengers;
  const sources = new Map();
  for (const passenger of passengers) for (const userId of passenger.temporaryOwnerUserIds) {
    const source = sources.get(userId);
    if (!source || (!Object.hasOwn(source.temporaryOwnerLevels, userId)
      && Object.hasOwn(passenger.temporaryOwnerLevels, userId))) sources.set(userId, passenger);
  }
  if (!sources.size) return false;
  const ownership = { ...(actor.ownership ?? {}) };
  for (const [userId, source] of sources) {
    if (Object.hasOwn(source.temporaryOwnerLevels, userId)) ownership[userId] = source.temporaryOwnerLevels[userId];
    else delete ownership[userId];
  }
  const replacement = globalThis.foundry?.data?.operators?.ForcedReplacement?.create?.(ownership)
    ?? globalThis._replace?.(ownership) ?? ownership;
  await actor.update({ ownership: replacement,
    [`flags.${SYSTEM_ID}.actorContainer.passengers`]: passengers.map(passenger => ({ ...passenger,
      temporaryOwnerUserIds: [], temporaryOwnerLevels: {} })) }, { diff: false });
  return true;
}

/** Reconcile temporary carrier OWNER rights while retaining each user's original level. */
export async function syncConstructPassengerOwnershipGrants(actor = null, users = globalThis.game?.users?.contents ?? []) {
  if (!hasConstructCrew(actor)) return false;
  const passengers = getActorContainerFlag(actor).passengers;
  const ownership = { ...(actor.ownership ?? {}) };
  const sources = new Map();
  for (const passenger of passengers) for (const userId of passenger.temporaryOwnerUserIds) {
    const source = sources.get(userId);
    if (!source || !Object.hasOwn(source.temporaryOwnerLevels, userId)
      && Object.hasOwn(passenger.temporaryOwnerLevels, userId)) sources.set(userId, passenger);
  }
  for (const [userId, source] of sources) {
    if (Object.hasOwn(source.temporaryOwnerLevels, userId)) ownership[userId] = source.temporaryOwnerLevels[userId];
    else delete ownership[userId];
  }
  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const updated = passengers.map(passenger => {
    const passengerActor = resolvePassengerActorSync(passenger);
    // A missing parked actor retains its existing grant until it can be recovered or exited.
    if (!passengerActor) return passenger;
    const temporaryOwnerUserIds = [], temporaryOwnerLevels = {};
    for (const user of users) {
      if (!user || user.isGM || !passengerActor.testUserPermission?.(user, "OWNER")) continue;
      const prior = ownership[user.id] ?? ownership.default ?? 0;
      if (prior >= ownerLevel) continue;
      temporaryOwnerUserIds.push(user.id);
      if (Object.hasOwn(ownership, user.id)) temporaryOwnerLevels[user.id] = ownership[user.id];
    }
    return { ...passenger, temporaryOwnerUserIds, temporaryOwnerLevels };
  });
  for (const passenger of updated) for (const userId of passenger.temporaryOwnerUserIds) ownership[userId] = ownerLevel;
  if (JSON.stringify(ownership) === JSON.stringify(actor.ownership ?? {})
    && JSON.stringify(updated) === JSON.stringify(passengers)) return false;
  const replacement = globalThis.foundry?.data?.operators?.ForcedReplacement?.create?.(ownership)
    ?? globalThis._replace?.(ownership) ?? ownership;
  await actor.update({ ownership: replacement,
    [`flags.${SYSTEM_ID}.actorContainer.passengers`]: updated }, { diff: false });
  return true;
}

/** Editor option shape intentionally includes the physical slot reference. */
export function getConstructCrewSeatOptions(actor = null) {
  return getActorContainerSeatDefinitions(actor).flatMap(seat => Array.from({ length: seat.quantity }, (_, slotIndex) => ({
    slotId: seat.slotId, slotIndex, value: `${seat.slotId}|${slotIndex}`,
    label: `${seat.itemName} · ${seat.baseSlotId} · ${slotIndex + 1}`,
    itemId: seat.itemId, width: seat.width, height: seat.height
  })));
}

export function getConstructCrewSeatState(actor = null, seat = null, { ignoreOccupantStatus = false } = {}) {
  if (!seat) return { available: false, reason: "Место не найдено", occupant: null };
  const occupant = getActorContainerFlag(actor).passengers.find(passenger => passenger.slotId === seat.slotId
    && passenger.slotIndex === seat.slotIndex) ?? null;
  const physical = getActorContainerSeatDefinitions(actor).find(row => row.slotId === seat.slotId);
  if (!physical || seat.slotIndex >= physical.quantity) return { available: false, reason: "Место демонтировано", occupant };
  const item = getActorItem(actor, physical.itemId);
  if (!item || isItemBrokenByCondition(item)) return { available: false, reason: "Место повреждено", occupant };
  if (item.system?.functions?.constructPart?.enabled && !isInstalledConstructPartItem(item)) {
    return { available: false, reason: "Деталь места не установлена", occupant };
  }
  if (seat.partSlotId) {
    const part = getInstalledConstructPartForSlot(actor, seat.partSlotId);
    if (!part) return { available: false, reason: "Управляемая деталь демонтирована", occupant };
    if (isItemBrokenByCondition(part)) return { available: false, reason: "Управляемая деталь разрушена", occupant };
  }
  if (!ignoreOccupantStatus && occupant && actorHasIncapacitatingStatus(resolvePassengerActorSync(occupant))) {
    return { available: false, reason: "Персонаж не может действовать", occupant, physical };
  }
  return { available: true, reason: "", occupant, physical };
}

export function canUserManageConstructPassenger(actor, passenger, user = globalThis.game?.user) {
  if (!actor || !passenger || !user) return false;
  if (user.isGM) return true;
  const passengerActor = resolvePassengerActorSync(passenger);
  return Boolean(passengerActor?.testUserPermission?.(user, "OWNER"));
}

export function getUserConstructCrewSeats(actor, user = globalThis.game?.user, { availableOnly = true } = {}) {
  return getConstructCrewSeats(actor).filter(seat => {
    const state = getConstructCrewSeatState(actor, seat);
    return (!availableOnly || state.available) && state.occupant
      && canUserManageConstructPassenger(actor, state.occupant, user);
  });
}

/** Rearranging occupants grants no ownership or access to their combat/inventory. */
export function canUserRearrangeConstructCrew(actor, user = globalThis.game?.user) {
  return Boolean(hasConstructCrew(actor) && user && (user.isGM
    || getActorContainerFlag(actor).passengers.some(passenger => canUserManageConstructPassenger(actor, passenger, user))));
}

/** This is also called by the GM attack handler, after resolving the actual embedded weapon. */
export function canUserControlConstruct(actor, user, action, { partSlotId = "", weapon = null, passengerId = "", seatId = "" } = {}) {
  if (actor?.type !== "construct" || !user || !CONSTRUCT_CREW_FUNCTIONS.includes(action)) return false;
  if (user.isGM && !passengerId && !seatId) return true;
  let targetPart = String(partSlotId ?? "").trim();
  if (weapon) {
    const ownerUuid = weapon.actor?.uuid ?? weapon.parent?.uuid;
    if (ownerUuid !== actor.uuid) return false;
    const weaponPart = getConstructWeaponPartSlotId(actor, weapon);
    if (!weaponPart || (targetPart && targetPart !== weaponPart)) return false;
    targetPart = weaponPart;
  }
  if (["aim", "fire", "reload"].includes(action) && !targetPart) return false;
  return getUserConstructCrewSeats(actor, user).some(seat => (!seatId || seat.id === seatId)
    && (!passengerId || getConstructCrewSeatState(actor, seat).occupant?.id === passengerId) && seat.functions.includes(action)
    && (!["aim", "fire", "reload"].includes(action) || isConstructCrewSeatAssignedToPart(seat, targetPart, action)));
}

export function getConstructWeaponPartSlotId(actor, weapon = null) {
  if (!weapon || actor?.type !== "construct") return "";
  if (isInstalledConstructPartItem(weapon)) return getConstructPartSlotId(weapon);
  const placement = weapon.system?.placement ?? {};
  if (placement.mode !== "weapon") return "";
  const match = String(placement.weaponSet ?? "").match(/^container:constructPart:([^:]+):/);
  if (match && getInstalledConstructPartForSlot(actor, match[1])) return match[1];
  const slotId = getConstructPartSlotIdFromLimbKey(placement.limbKey);
  return slotId && getInstalledConstructPartForSlot(actor, slotId) ? slotId : "";
}

export function getConstructCrewWeapons(actor, user = globalThis.game?.user) {
  const rows = [];
  for (const weapon of actor?.items?.contents ?? []) {
    const installedSlotId = getConstructWeaponPartSlotId(actor, weapon);
    if (!installedSlotId) continue;
    for (const fn of getEnabledWeaponFunctions(weapon)) {
      const legacy = weapon.getFlag?.(SYSTEM_ID, "constructWeaponOperators")?.[fn.id]
        ?? weapon.flags?.[SYSTEM_ID]?.constructWeaponOperators?.[fn.id];
      const partSlotId = String(fn.data?.operatorPartSlotId || legacy?.partSlotId || installedSlotId);
      if (!canUserControlConstruct(actor, user, "fire", { partSlotId })
        && !canUserControlConstruct(actor, user, "reload", { partSlotId })) continue;
      rows.push({ weapon, weaponFunctionId: fn.id, partSlotId,
        label: fn.name ? `${weapon.name} — ${fn.name}` : weapon.name,
        actions: fn.data?.availableActions ?? {} });
    }
  }
  return rows;
}

export function findAvailableConstructCrewSeat(actor, passengerActor = null, passengerToken = null, { seatId = "" } = {}) {
  const size = getActorContainerPassengerSize(passengerActor, passengerToken);
  const seats = getConstructCrewSeats(actor);
  for (const seat of seats) {
    if (seatId && seat.id !== seatId) continue;
    const state = getConstructCrewSeatState(actor, seat);
    if (!state.available || state.occupant || size.width > state.physical.width || size.height > state.physical.height) continue;
    return { ...state.physical, crewSeatId: seat.id, slotIndex: seat.slotIndex,
      passengerWidth: size.width, passengerHeight: size.height, passengerX: 1, passengerY: 1 };
  }
  return null;
}

/** Pure seat transfer, intended to run under the same GM queue as boarding and exit. */
export function moveConstructCrewPassengerData(actor, passengers, passengerId, targetSeatId, { swap = false } = {}) {
  const passenger = passengers.find(row => row.id === passengerId);
  const seats = getConstructCrewSeats(actor);
  const seat = seats.find(row => row.id === targetSeatId);
  const source = seats.find(row => row.slotId === passenger?.slotId && row.slotIndex === passenger?.slotIndex);
  if (!passenger || !seat || !source) return null;
  const state = getConstructCrewSeatState(actor, seat, { ignoreOccupantStatus: true });
  const sourceState = getConstructCrewSeatState(actor, source, { ignoreOccupantStatus: true });
  if (!state.available || !sourceState.available || passenger.width > state.physical.width || passenger.height > state.physical.height) return null;
  const knownPositions = new Set(seats.map(row => `${row.slotId}:${row.slotIndex}`));
  const occupied = new Set(), ids = new Set();
  for (const row of passengers) {
    const position = `${row.slotId}:${row.slotIndex}`;
    if (ids.has(row.id) || knownPositions.has(position) && occupied.has(position)) return null;
    ids.add(row.id); occupied.add(position);
  }
  const target = passengers.find(row => row.id !== passengerId && row.slotId === seat.slotId && row.slotIndex === seat.slotIndex);
  if (target && (!swap || target.width > sourceState.physical.width || target.height > sourceState.physical.height)) return null;
  return passengers.map(row => row.id === passengerId ? { ...row, slotId: seat.slotId, slotIndex: seat.slotIndex, x: 1, y: 1 }
    : row.id === target?.id ? { ...row, slotId: source.slotId, slotIndex: source.slotIndex, x: 1, y: 1 } : row);
}

export function resolvePassengerActorSync(passenger) {
  const uuid = String(passenger?.actorUuid ?? "");
  const document = globalThis.fromUuidSync?.(uuid)
    ?? globalThis.game?.actors?.get?.(passenger?.parkedActorId)
    ?? (uuid.startsWith("Actor.") ? globalThis.game?.actors?.get?.(uuid.slice(6)) : null)
    ?? null;
  return document?.actor ?? document;
}

function getActorItem(actor, itemId) {
  return actor?.items?.get?.(itemId) ?? actor?.items?.contents?.find(item => item.id === itemId) ?? null;
}
