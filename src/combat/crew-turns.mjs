import { SYSTEM_ID } from "../constants.mjs";
import { getActorContainerPassengerMetadata } from "../utils/actor-containers.mjs";
import { getConstructCrewSeats, resolvePassengerActorSync } from "../utils/construct-crew.mjs";
import { actorHasIncapacitatingStatus } from "./incapacitation.mjs";

export const CREW_TURN_STATE_FLAG = "crewTurnState";
export const CREW_INITIATIVES_FLAG = "crewInitiatives";

/** Configured operators distinguish a crew-controlled vehicle from an autonomous construct. */
export function isCrewControlledActor(actor) {
  return getConstructCrewSeats(actor).some(seat => seat.functions.length > 0);
}

export function getCombatCrew(actor) {
  if (!isCrewControlledActor(actor)) return [];
  const seats = getConstructCrewSeats(actor);
  const seen = new Set();
  return getActorContainerPassengerMetadata(actor).flatMap(passenger => {
    const member = resolvePassengerActorSync(passenger);
    if (!member?.uuid || member.uuid === actor.uuid || seen.has(member.uuid)) return [];
    seen.add(member.uuid);
    const seat = seats.find(row => row.slotId === passenger.slotId && row.slotIndex === passenger.slotIndex);
    return [{ actor: member, passengerId: passenger.id, seat, role: seat?.name || seat?.role || "" }];
  }).sort((left, right) => (seats.indexOf(left.seat) < 0 ? seats.length : seats.indexOf(left.seat)) - (seats.indexOf(right.seat) < 0 ? seats.length : seats.indexOf(right.seat)));
}

export function combatantIncludesActor(combatant, actorUuid) {
  return combatant?.actor?.uuid === actorUuid || getCombatCrew(combatant?.actor).some(row => row.actor.uuid === actorUuid);
}

export function findCrewCombatant(actor, combat) {
  return Array.from(combat?.combatants ?? []).find(row => row.actor?.uuid === actor?.uuid)
    ?? Array.from(combat?.combatants ?? []).find(row => combatantIncludesActor(row, actor?.uuid)) ?? null;
}

export function getCrewTurnProgress(combatant, combat = combatant?.combat, { round = combat?.round } = {}) {
  if (!isCrewControlledActor(combatant?.actor)) return null;
  const state = combatant.getFlag?.(SYSTEM_ID, CREW_TURN_STATE_FLAG) ?? combatant.flags?.[SYSTEM_ID]?.[CREW_TURN_STATE_FLAG] ?? {};
  const completed = new Set(state.round === round ? state.completedActorUuids ?? [] : []);
  const members = getCombatCrew(combatant.actor).map(row => {
    const unable = actorHasIncapacitatingStatus(row.actor);
    return { ...row, unable, completed: completed.has(row.actor.uuid) || unable || Boolean(combatant.isDefeated) };
  });
  const pending = members.filter(row => !row.completed);
  const total = members.length;
  const completedCount = total - pending.length;
  return { members, pending, total, completedCount, complete: pending.length === 0, percentage: total ? completedCount / total * 100 : 0 };
}

export function isCrewActorPending(actor, combat) {
  const combatant = findCrewCombatant(actor, combat);
  const progress = getCrewTurnProgress(combatant, combat);
  if (!progress) return true;
  if (combatant.actor.uuid === actor.uuid) return !progress.complete;
  return progress.pending.some(row => row.actor.uuid === actor.uuid);
}

export async function resetCrewTurn(combatant, combat) {
  if (!combatant) return;
  await combat.updateEmbeddedDocuments("Combatant", [{ _id: combatant.id,
    [`flags.${SYSTEM_ID}.${CREW_TURN_STATE_FLAG}`]: { round: combat.round, completedActorUuids: [] }
  }], { turnEvents: false });
}

export async function markCrewMemberCompleted(combatant, actor, combat, { round = combat.round } = {}) {
  const state = combatant.getFlag?.(SYSTEM_ID, CREW_TURN_STATE_FLAG) ?? combatant.flags?.[SYSTEM_ID]?.[CREW_TURN_STATE_FLAG] ?? {};
  const completed = state.round === round ? state.completedActorUuids ?? [] : [];
  await combat.updateEmbeddedDocuments("Combatant", [{ _id: combatant.id,
    [`flags.${SYSTEM_ID}.${CREW_TURN_STATE_FLAG}`]: { round, completedActorUuids: [...new Set([...completed, actor.uuid])] }
  }], { turnEvents: false });
}

/** Called inside the combat's serialized turn queue, so concurrent crew requests cannot advance twice. */
export async function completeCrewTurnMember(combatant, combat, { actorUuid = "", endMember } = {}) {
  const progress = getCrewTurnProgress(combatant, combat);
  if (!progress) return { handled: false, advance: true };
  const explicitMember = actorUuid && actorUuid !== combatant.actor.uuid;
  const member = explicitMember ? progress.pending.find(row => row.actor.uuid === actorUuid) : progress.pending[0];
  if (!member) return { handled: true, advance: !explicitMember && progress.complete };
  await endMember(member.actor);
  await markCrewMemberCompleted(combatant, member.actor, combat);
  return { handled: true, advance: getCrewTurnProgress(combatant, combat).complete };
}

/** Virtual participants retain individual roll data, abilities, surprise, and faction. */
export function getCombatInitiativeParticipants(combat) {
  return Array.from(combat?.combatants ?? []).flatMap(combatant => {
    if (!isCrewControlledActor(combatant.actor)) return [combatant];
    const values = combatant.getFlag?.(SYSTEM_ID, CREW_INITIATIVES_FLAG) ?? [];
    return getCombatCrew(combatant.actor).map(({ actor, role }) => ({
      id: `${combatant.id}:${actor.uuid}`, uuid: combatant.uuid, carrierId: combatant.id,
      actor, role, token: null, scene: combatant.scene, hidden: combatant.hidden,
      name: role ? `${actor.name} \u2014 ${role}` : actor.name,
      isOwner: combatant.isOwner, initiative: values.find(row => row.actorUuid === actor.uuid)?.total ?? null,
      _getInitiativeFormula: () => actor.system?.initiative?.formula || CONFIG.Combat.initiative.formula || game.system.initiative,
      getInitiativeRoll: formula => new (globalThis.Roll ?? foundry.dice.Roll)(formula, actor.getRollData())
    }));
  });
}

export function aggregateCrewInitiatives(combat, updates, participants) {
  const results = [];
  for (const combatant of combat.combatants ?? []) {
    if (!isCrewControlledActor(combatant.actor)) {
      const update = updates.find(row => row._id === combatant.id);
      if (update) results.push(update);
      continue;
    }
    const crew = participants.filter(row => row.carrierId === combatant.id);
    const rolls = crew.map(row => ({ actorUuid: row.actor.uuid, value: updates.find(update => update._id === row.id)?.initiative }));
    // A cancelled participant roll cannot leave a misleading partial average.
    if (!rolls.length || rolls.some(row => !Number.isFinite(row.value))) continue;
    results.push({ _id: combatant.id, initiative: Math.floor(rolls.reduce((sum, row) => sum + row.value, 0) / rolls.length),
      [`flags.${SYSTEM_ID}.${CREW_INITIATIVES_FLAG}`]: rolls.map(row => ({ actorUuid: row.actorUuid, total: row.value })) });
  }
  return results;
}

export function getCombatantTurnActors(combatant) {
  return isCrewControlledActor(combatant?.actor) ? getCombatCrew(combatant.actor).map(row => row.actor) : [combatant?.actor].filter(Boolean);
}

/** The carrier spends movement resources even when only its crew has personal turns. */
export function getCombatantResourceActors(combatant) {
  return [...new Set([combatant?.actor, ...getCombatantTurnActors(combatant)].filter(Boolean))];
}
