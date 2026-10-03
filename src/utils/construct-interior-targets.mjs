import { getConstructExteriorSlotIds, getConstructPartContainmentPath, getConstructCompartmentContents } from "./construct-interior.mjs";
import { getInstalledConstructPartForSlot } from "./construct-parts.mjs";
import { resolvePassengerActorSync } from "./construct-crew.mjs";
import { isLimbDestroyed } from "./limb-state.mjs";

export function normalizeConstructInteriorTarget(raw) {
  if (!raw || !["part", "passenger"].includes(raw.kind)) return null;
  const value = key => String(raw[key] ?? "").trim().slice(0, 1000);
  const target = { kind: raw.kind, shellSlotId: value("shellSlotId") };
  if (!target.shellSlotId) return null;
  if (raw.kind === "part") target.slotId = value("slotId");
  else Object.assign(target, { passengerId: value("passengerId"), actorUuid: value("actorUuid"), limbKey: value("limbKey") });
  return target;
}

/** Rebuild ancestry and occupants from documents. A submitted UUID never grants targeting access. */
export function resolveConstructInteriorTarget(actor, raw) {
  const target = normalizeConstructInteriorTarget(raw);
  if (actor?.type !== "construct" || !target || !getConstructExteriorSlotIds(actor).includes(target.shellSlotId)) return null;
  if (target.kind === "part") {
    const path = getConstructPartContainmentPath(actor, target.slotId);
    const item = getInstalledConstructPartForSlot(actor, target.slotId);
    if (!item || target.slotId === target.shellSlotId || !path.includes(target.shellSlotId)) return null;
    const limbKey = `constructPart:${target.slotId}`;
    if (!actor.system?.limbs?.[limbKey] || isLimbDestroyed(actor, limbKey)) return null;
    return { descriptor: target, actor, limbKey, item, path };
  }
  for (const slot of getConstructPartContainmentPathOptions(actor, target.shellSlotId)) {
    const passenger = getConstructCompartmentContents(actor, slot).passengers.find(row => row.id === target.passengerId);
    if (!passenger) continue;
    const passengerActor = resolvePassengerActorSync(passenger);
    const limbs = passengerActor?.system?.limbs ?? {};
    const limb = Object.hasOwn(limbs, target.limbKey) ? limbs[target.limbKey] : null;
    if (!passengerActor || passengerActor.uuid !== target.actorUuid || !limb || typeof limb !== "object"
      || isLimbDestroyed(passengerActor, target.limbKey)) return null;
    return { descriptor: target, actor: passengerActor, limbKey: target.limbKey, passenger,
      path: getConstructPartContainmentPath(actor, slot) };
  }
  return null;
}

function getConstructPartContainmentPathOptions(actor, shell) {
  const result = [], seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id); result.push(id);
    for (const part of getConstructCompartmentContents(actor, id).parts) visit(part.slotId);
  };
  visit(shell);
  return result;
}
