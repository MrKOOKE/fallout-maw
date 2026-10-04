import { SYSTEM_ID } from "../constants.mjs";
import { getEnabledWeaponFunctions, getWeaponFunctionById, isItemBrokenByCondition } from "./item-functions.mjs";
import { getConstructPartSlots, getInstalledConstructPartForSlot } from "./construct-parts.mjs";
import { getConstructCrewContexts } from "./construct-crew-context.mjs";
import { resolveConstructVisualAnchors, getConstructVisualRuntimeConfig } from "./construct-visual-model.mjs";
import {
  canUserManageConstructPassenger,
  getConstructCrewSeats,
  getConstructCrewSeatState,
  getConstructWeaponPartSlotId,
  isConstructCrewSeatAssignedToPart
} from "./construct-crew.mjs";

const WEAPON_CREW_ACTIONS = new Set(["aim", "fire", "reload"]);

/** Each weapon function has its own operator requirement, including module functions. */
export function getConstructWeaponOperatorConfig(weapon, weaponFunctionId = "") {
  const functionId = String(weaponFunctionId || "weapon");
  const fn = getEnabledWeaponFunctions(weapon, { ignoreBroken: true }).find(row => row.id === functionId)?.data
    ?? getWeaponFunctionById(weapon, functionId)
    ?? (functionId === "weapon" ? weapon?.system?.functions?.weapon : null)
    ?? {};
  const flags = weapon?.getFlag?.(SYSTEM_ID, "constructWeaponOperators")
    ?? weapon?.flags?.[SYSTEM_ID]?.constructWeaponOperators
    ?? {};
  const legacy = flags?.[functionId] ?? {};
  return {
    required: fn.requiresOperator === true || legacy.required === true,
    partSlotId: String(fn.operatorPartSlotId || legacy.partSlotId || "").trim(),
    muzzleAnchorId: String(fn.muzzleAnchorId || legacy.muzzleAnchorId || "").trim()
  };
}

/** Named choices preserve a removed binding instead of silently assigning a new part. */
export function getConstructWeaponOperatorPartChoices(weapon, selectedPartSlotId = "") {
  const selected = String(selectedPartSlotId ?? "").trim();
  const actor = weapon?.actor ?? weapon?.parent;
  const choices = [{ value: "", label: "Деталь, на которой установлено оружие", selected: !selected }];
  for (const slot of getConstructPartSlots(actor)) choices.push({
    value: slot.id,
    label: String(slot.profile?.name || getInstalledConstructPartForSlot(actor, slot.id)?.name || "Безымянная деталь"),
    selected: slot.id === selected
  });
  if (selected && !choices.some(row => row.value === selected)) {
    choices.push({ value: selected, label: "Ранее назначенная деталь (недоступна)", selected: true });
  }
  return choices;
}

/** Any configured anchor can be the origin of an individual weapon function. */
export function getConstructWeaponMuzzleAnchorChoices(weapon, selectedAnchorId = "") {
  const selected = String(selectedAnchorId ?? "").trim();
  const actor = weapon?.actor ?? weapon?.parent;
  const choices = [{ value: "", label: "Точка выстрела управляемой детали", selected: !selected }];
  for (const anchor of getConstructVisualRuntimeConfig(actor).anchors) choices.push({
    value: anchor.id, label: anchor.name, selected: anchor.id === selected
  });
  if (selected && !choices.some(row => row.value === selected))
    choices.push({ value: selected, label: "Ранее назначенная точка (недоступна)", selected: true });
  return choices;
}

/** Resolve the real occupied performer. The weapon stays on its owning construct. */
export function getConstructWeaponExecutor(actor, weapon, user, action = "fire", weaponFunctionId = "", options = {}) {
  if (!actor || !weapon || !user || !WEAPON_CREW_ACTIONS.has(action)) return null;
  if (!belongsToActor(actor, weapon)) {
    if (actor.type !== "construct" || isItemBrokenByCondition(weapon)) return null;
    const owner = weapon.actor ?? weapon.parent;
    const id = String(options.passengerId || options.operatorPassengerId || "");
    const context = getConstructCrewContexts(actor, user, { availableOnly: true }).find(row =>
      (!id || row.passenger.id === id) && (!options.seatId || row.seat.id === options.seatId)
      && (row.actor === owner || row.actor.uuid && row.actor.uuid === owner?.uuid));
    if (!context?.personalWeapons?.enabled || !context.personalWeapons.anchorId) return null;
    const anchor = resolveConstructVisualAnchors(actor).find(row => row.id === context.personalWeapons.anchorId && row.parentVisible);
    return anchor ? { actor: context.actor, seat: context.seat, passenger: context.passenger,
      partSlotId: "", personalWeapon: true, personalWeapons: context.personalWeapons } : null;
  }
  const config = getConstructWeaponOperatorConfig(weapon, weaponFunctionId);
  const hasCrew = actor.type === "construct" && getConstructCrewSeats(actor).length > 0;
  const ownsActor = canUserOwnActor(actor, user);
  const selectedPerformer = Boolean(options.passengerId || options.operatorPassengerId || options.seatId);
  const autonomous = !config.required && ownsActor;
  const autonomousPart = actor.type === "construct" ? config.partSlotId || getConstructWeaponPartSlotId(actor, weapon) : "";
  if (autonomous && (!hasCrew || !selectedPerformer)) return { actor, seat: null, passenger: null, partSlotId: autonomousPart };
  if (actor.type !== "construct" || isItemBrokenByCondition(weapon)) return null;
  const weaponPart = getConstructWeaponPartSlotId(actor, weapon);
  const weaponMount = weaponPart ? getInstalledConstructPartForSlot(actor, weaponPart) : null;
  if (!weaponMount || isItemBrokenByCondition(weaponMount)) return null;
  const targetPart = String(config.partSlotId || weaponPart || "").trim();
  if (!targetPart || (options.partSlotId && String(options.partSlotId).trim() !== targetPart)) return null;
  const part = getInstalledConstructPartForSlot(actor, targetPart);
  if (!part || isItemBrokenByCondition(part)) return null;
  const passengerId = String(options.passengerId || options.operatorPassengerId || "");
  const seatId = String(options.seatId || "");
  for (const seat of getConstructCrewSeats(actor)) {
    if (seatId && seat.id !== seatId) continue;
    if (!isConstructCrewSeatAssignedToPart(seat, targetPart, action) || !seat.functions.includes(action)) continue;
    const state = getConstructCrewSeatState(actor, seat);
    if (!state.available || !state.occupant) continue;
    if (passengerId && state.occupant.id !== passengerId) continue;
    if (!canUserManageConstructPassenger(actor, state.occupant, user)) continue;
    const performer = resolvePassengerActor(state.occupant);
    if (!performer) continue;
    return { actor: performer, seat, passenger: state.occupant, partSlotId: targetPart };
  }
  return null;
}

/** Required operators cannot be bypassed by an ordinary GM shot. Autonomous
 * weapons preserve OWNER/GM use while authorized crew can operate their detail.
 */
export function canUserUseConstructWeapon(actor, weapon, user, action = "fire", weaponFunctionId = "", options = {}) {
  if (!actor || !weapon || !user || !WEAPON_CREW_ACTIONS.has(action)) return false;
  const config = getConstructWeaponOperatorConfig(weapon, weaponFunctionId);
  if (options.gmOverride === true && user.isGM) return true;
  return Boolean(getConstructWeaponExecutor(actor, weapon, user, action, weaponFunctionId, options));
}

/** Async interface used by authoritative attacks and reload transactions. */
export async function resolveConstructWeaponOperatorActor(actor, weapon, user, action = "fire", weaponFunctionId = "", options = {}) {
  return getConstructWeaponExecutor(actor, weapon, user, action, weaponFunctionId, options)?.actor ?? null;
}

function belongsToActor(actor, weapon) {
  const owner = weapon.actor ?? weapon.parent;
  if (!owner) return true;
  if (owner === actor) return true;
  if (owner.uuid && actor.uuid) return owner.uuid === actor.uuid;
  return Boolean(owner.id && actor.id && owner.id === actor.id);
}

function canUserOwnActor(actor, user) {
  if (user.isGM) return true;
  if (typeof actor.testUserPermission === "function") return Boolean(actor.testUserPermission(user, "OWNER"));
  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return Number(actor.ownership?.[user.id] ?? actor.ownership?.default ?? 0) >= ownerLevel;
}

function resolvePassengerActor(passenger) {
  const uuid = String(passenger.actorUuid ?? "");
  const doc = globalThis.fromUuidSync?.(uuid)
    ?? globalThis.game?.actors?.get?.(passenger.parkedActorId)
    ?? (uuid.startsWith("Actor.") ? globalThis.game?.actors?.get?.(uuid.slice(6)) : null);
  return doc?.actor ?? doc ?? null;
}
