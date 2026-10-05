import { getConstructCrewSeats, getConstructCrewSeatState } from "../utils/construct-crew.mjs";
import { getConstructCrewContexts, canUserUseConstructCrewPersonalWeapon } from "../utils/construct-crew-context.mjs";
import { resolveConstructVisualAnchors, getConstructVisualRuntimeRevision } from "../utils/construct-visual-model.mjs";
import { constructLocalToWorld } from "../utils/construct-aim-geometry.mjs";
import { resolveConstructJointRotations } from "../utils/construct-joint-rotations.mjs";
import { normalizeConstructPersonalWeapons, isConstructFiringPortPointInSector } from "../utils/construct-firing-port-model.mjs";

const personalWeaponSeats = new WeakMap();
let readPartRotations = token => {
  const document = token?.document ?? token;
  return resolveConstructJointRotations(document?.actor, document?.getFlag?.("fallout-maw", "constructVisualState") ?? {});
};

export function configureConstructFiringPortTransforms({ getRotations } = {}) {
  if (typeof getRotations === "function") readPartRotations = getRotations;
}

export function isConstructPersonalWeapon(token, weapon) {
  const owner = weapon?.actor ?? weapon?.parent;
  return Boolean(token?.actor?.type === "construct" && owner?.uuid && owner.uuid !== token.actor.uuid);
}

/** Identity lookup is also used for geometry, independently of the viewer's ownership. */
export function getConstructPersonalWeaponSeat(token, weapon, { passengerId = "" } = {}) {
  if (!isConstructPersonalWeapon(token, weapon)) return null;
  const owner = weapon.actor ?? weapon.parent;
  const revision = getConstructVisualRuntimeRevision();
  const key = `${owner.uuid}:${passengerId}`;
  let cache = personalWeaponSeats.get(token);
  if (revision !== null && cache?.actor === token.actor && cache.revision === revision && cache.seats.has(key))
    return cache.seats.get(key);
  if (revision !== null && (!cache || cache.actor !== token.actor || cache.revision !== revision)) {
    cache = { actor: token.actor, revision, seats: new Map() };
    personalWeaponSeats.set(token, cache);
  }
  for (const seat of getConstructCrewSeats(token.actor)) {
    const state = getConstructCrewSeatState(token.actor, seat);
    if (!state.available || !state.occupant || passengerId && state.occupant.id !== passengerId) continue;
    if (state.occupant.actorUuid === owner.uuid || state.occupant.parkedActorId === owner.id) {
      if (revision !== null) cache.seats.set(key, seat);
      return seat;
    }
  }
  if (revision !== null) cache.seats.set(key, null);
  return null;
}

export function getConstructPersonalWeaponPortContext(token, weapon, { passengerId = "", operatorPassengerId = "", user = globalThis.game?.user } = {}) {
  const id = String(passengerId || operatorPassengerId || "");
  const owner = weapon?.actor ?? weapon?.parent;
  const context = getConstructCrewContexts(token?.actor, user, { availableOnly: true }).find(row =>
    (!id || row.passenger.id === id) && (row.actor === owner || row.actor.uuid && row.actor.uuid === owner?.uuid));
  if (!context || !canUserUseConstructCrewPersonalWeapon(token.actor, weapon, user, { passengerId: context.passenger.id })) return null;
  const port = getConstructFiringPortWorldTransform(token, context.seat);
  return port ? { ...context, port, personalWeapon: true } : null;
}

/** The same transform is used by outgoing rays and incoming window protection. */
export function getConstructFiringPortWorldTransform(tokenOrDocument, seatOrPersonalWeapons) {
  const token = tokenOrDocument?.object ?? tokenOrDocument;
  const document = token?.document ?? tokenOrDocument;
  const actor = document?.actor ?? token?.actor;
  const profile = normalizeConstructPersonalWeapons(seatOrPersonalWeapons?.personalWeapons ?? seatOrPersonalWeapons);
  if (!actor || !profile.enabled || !profile.anchorId) return null;
  const grid = Number(globalThis.canvas?.grid?.size) || 100;
  const width = Number(token?.w) || Number(document?.width) * grid;
  const height = Number(token?.h) || Number(document?.height) * grid;
  if (!(width > 0 && height > 0)) return null;
  const mesh = token?.mesh;
  const sx = Math.sign(Number(mesh?.scale?.x ?? document?.texture?.scaleX) || 1);
  const sy = Math.sign(Number(mesh?.scale?.y ?? document?.texture?.scaleY) || 1);
  const artWidth = Math.abs(Number(mesh?.width)) || width * Math.abs(Number(document?.texture?.scaleX) || 1);
  const artHeight = Math.abs(Number(mesh?.height)) || height * Math.abs(Number(document?.texture?.scaleY) || 1);
  const ax = Number(mesh?.anchor?.x ?? document?.texture?.anchorX ?? 0.5);
  const ay = Number(mesh?.anchor?.y ?? document?.texture?.anchorY ?? 0.5);
  const rotations = readPartRotations(token);
  const anchor = resolveConstructVisualAnchors(actor, { rotations, width: artWidth, height: artHeight })
    .find(row => row.id === profile.anchorId && row.parentVisible);
  if (!anchor) return null;
  const bodyRotation = document?.lockRotation ? 0 : Number(token?.mesh?.angle ?? document?.rotation) || 0;
  const center = token?.mesh?.position ?? token?.center
    ?? { x: Number(document?.x) + width / 2, y: Number(document?.y) + height / 2 };
  const origin = constructLocalToWorld({ x: 0.5 + (anchor.x - ax) * sx, y: 0.5 + (anchor.y - ay) * sy },
    { x: center.x - artWidth / 2, y: center.y - artHeight / 2,
      width: artWidth, height: artHeight, rotation: bodyRotation });
  const radians = anchor.rotation * Math.PI / 180;
  const localDirection = Math.atan2(sx * Math.sin(radians), sy * Math.cos(radians)) * 180 / Math.PI;
  return { ...profile, origin, rotation: bodyRotation + localDirection,
    minRotation: sx * sy < 0 ? -profile.maxRotation : profile.minRotation,
    maxRotation: sx * sy < 0 ? -profile.minRotation : profile.maxRotation };
}

export function getConstructPersonalWeaponAimOrigin(token, weapon) {
  const seat = getConstructPersonalWeaponSeat(token, weapon);
  return seat ? getConstructFiringPortWorldTransform(token, seat)?.origin ?? null : null;
}

export function validateConstructPersonalWeaponAim(token, weapon, point, options = {}) {
  const context = getConstructPersonalWeaponPortContext(token, weapon, options);
  if (!context) return { allowed: false, reason: "У места нет доступной точки для стрельбы личным оружием." };
  if (!isConstructFiringPortPointInSector(context.port, point))
    return { allowed: false, reason: "Направление выходит за конус атаки этого места." };
  if (context.port.maxRangeMeters !== null) {
    const pixelsPerMeter = (Number(globalThis.canvas?.grid?.size) || 100) / (Number(globalThis.canvas?.scene?.grid?.distance) || 1);
    if (Math.hypot(point.x - context.port.origin.x, point.y - context.port.origin.y) > context.port.maxRangeMeters * pixelsPerMeter + 0.001)
      return { allowed: false, reason: "Цель дальше допустимого радиуса атаки этого места." };
  }
  return { allowed: true, context };
}
