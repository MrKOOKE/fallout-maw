import test from "node:test";
import assert from "node:assert/strict";
import { aggregateCrewInitiatives, getCombatCrew, getCombatInitiativeParticipants, getCrewTurnProgress,
  isCrewControlledActor, isCrewActorPending, resetCrewTurn, completeCrewTurnMember, combatantIncludesActor } from "../src/combat/crew-turns.mjs";
import { createCoalescingOperationQueue } from "../src/combat/coalescing-operation-queue.mjs";
import { classifyCombatUpdate, classifyCombatantUpdate } from "../src/events/foundry-document-events.mjs";

function fixture() {
  const members = Array.from({ length: 4 }, (_, i) => ({ uuid: `Actor.crew${i}`, name: `Crew ${i}`, statuses: new Set(), getRollData: () => ({ initiative: i + 2 }) }));
  const flags = { "fallout-maw": { constructVisual: { seats: members.map((_, i) => ({ id: `seat${i}`, name: `Role ${i}`, role: i ? "gunner" : "driver", slotId: "seats", slotIndex: i })) },
    actorContainer: { passengers: members.map((actor, i) => ({ id: `p${i}`, actorUuid: actor.uuid, slotId: "seats", slotIndex: i })) } } };
  const actor = { uuid: "Actor.tank", type: "construct", flags, getFlag: (ns, key) => flags[ns]?.[key] };
  const combatant = { id: "tank", actor, isOwner: true, flags: { "fallout-maw": {} }, getFlag(ns, key) { return this.flags[ns]?.[key]; } };
  const combat = { round: 1, combatants: [combatant], async updateEmbeddedDocuments(type, updates) {
    assert.equal(type, "Combatant");
    for (const update of updates) for (const [key, value] of Object.entries(update)) {
      if (key.startsWith("flags.fallout-maw.")) combatant.flags["fallout-maw"][key.slice(18)] = value;
    }
  } };
  globalThis.fromUuidSync = uuid => uuid === actor.uuid ? actor : members.find(row => row.uuid === uuid);
  return { members, actor, combatant, combat };
}

test("only configured operators make a construct crew-controlled; all real occupants participate once", () => {
  const { actor, members } = fixture();
  actor.flags["fallout-maw"].actorContainer.passengers.push({ id: "duplicate", actorUuid: members[0].uuid, slotId: "seats", slotIndex: 5 });
  assert.equal(getCombatCrew(actor).length, 4);
  assert.equal(isCrewControlledActor({ ...actor, type: "character" }), false);
  assert.equal(isCrewControlledActor({ type: "construct" }), false);
  actor.flags["fallout-maw"].constructVisual.seats.forEach(row => row.role = "passenger");
  assert.equal(isCrewControlledActor(actor), false);
});

test("initiative participants have their own data and identities, while autonomous constructs retain their roll", () => {
  const { combat, members } = fixture();
  const autonomous = { id: "robot", actor: { type: "construct", uuid: "Actor.robot" } };
  combat.combatants.push(autonomous);
  const participants = getCombatInitiativeParticipants(combat);
  assert.equal(participants.length, 5);
  assert.deepEqual(participants.slice(0, 4).map(row => row.actor), members);
  assert.equal(participants[4], autonomous);
  assert.equal(new Set(participants.map(row => row.id)).size, 5);
  assert.ok(participants[2].name.includes("Role 2"));
});

test("aggregate initiative is the mean of final individual totals rounded down, with no hull roll or partial average", () => {
  const { combat } = fixture();
  const participants = getCombatInitiativeParticipants(combat);
  const updates = participants.map((row, i) => ({ _id: row.id, initiative: [4, 8, 11, 18][i] }));
  const result = aggregateCrewInitiatives(combat, updates, participants);
  assert.equal(result[0].initiative, 10);
  const negative = participants.map((row, i) => ({ _id: row.id, initiative: [-20, -10, -5, -2][i] }));
  assert.equal(aggregateCrewInitiatives(combat, negative, participants)[0].initiative, -10);
  assert.equal(result[0]["flags.fallout-maw.crewInitiatives"].length, 4);
  assert.deepEqual(aggregateCrewInitiatives(combat, updates.slice(1), participants), []);
});

test("each completion fills its share; duplicates cannot finish another actor; next round resets readiness", async () => {
  const { combatant, combat, members } = fixture();
  const ended = [];
  const endMember = async actor => ended.push(actor.uuid);
  await resetCrewTurn(combatant, combat);
  for (let i = 0; i < 4; i++) {
    const result = await completeCrewTurnMember(combatant, combat, { actorUuid: members[i].uuid, endMember });
    assert.equal(result.advance, i === 3);
    assert.equal(getCrewTurnProgress(combatant, combat).percentage, (i + 1) * 25);
    assert.equal(isCrewActorPending(members[i], combat), false);
    const repeated = await completeCrewTurnMember(combatant, combat, { actorUuid: members[i].uuid, endMember });
    assert.equal(repeated.advance, false);
  }
  assert.equal(ended.length, 4);
  combat.round++;
  assert.equal(getCrewTurnProgress(combatant, combat).completedCount, 0);
  await resetCrewTurn(combatant, combat);
  assert.equal(getCrewTurnProgress(combatant, combat).pending.length, 4);
});

test("dead and unconscious occupants remain visible and auto-complete without resources or blocking the group", async () => {
  const { combatant, combat, members } = fixture();
  members[2].statuses.add("dead"); members[3].statuses.add("unconscious");
  assert.equal(getCrewTurnProgress(combatant, combat).percentage, 50);
  const ended = [];
  await completeCrewTurnMember(combatant, combat, { endMember: async actor => ended.push(actor.uuid) });
  assert.equal(getCrewTurnProgress(combatant, combat).percentage, 75);
  const result = await completeCrewTurnMember(combatant, combat, { endMember: async actor => ended.push(actor.uuid) });
  assert.equal(result.advance, true);
  assert.deepEqual(ended, members.slice(0, 2).map(row => row.uuid));
  assert.equal(getCrewTurnProgress(combatant, combat).members.length, 4);
});

test("serialized simultaneous crew completions advance only once and preserve all marks", async () => {
  const { combatant, combat, members } = fixture();
  const queue = createCoalescingOperationQueue();
  let advances = 0;
  await Promise.all(members.map(member => queue.run(member.uuid, async () => {
    const result = await completeCrewTurnMember(combatant, combat, { actorUuid: member.uuid, endMember: async () => {} });
    if (result.advance) advances++;
  })));
  assert.equal(advances, 1);
  assert.equal(getCrewTurnProgress(combatant, combat).completedCount, 4);
});

test("empty managed vehicles have no fabricated initiative participants; autonomous next-turn stays ordinary", async () => {
  const { actor, combat, combatant } = fixture();
  actor.flags["fallout-maw"].actorContainer.passengers = [];
  assert.deepEqual(getCombatInitiativeParticipants(combat), []);
  assert.equal(getCrewTurnProgress(combatant, combat).complete, true);
  assert.equal(combatantIncludesActor(combatant, "Actor.missing"), false);
  assert.deepEqual(await completeCrewTurnMember({ actor: { type: "construct" } }, combat), { handled: false, advance: true });
});

test("turn-start events target actual participants and each has a distinct occurrence suffix", () => {
  const { combat, actor, members } = fixture();
  combat.started = true;
  const events = classifyCombatUpdate(combat, { round: 1, turn: 0 }, {
    before: { source: { round: 0 }, meta: { started: false } },
    after: { source: { round: 1 }, meta: { started: true, currentCombatant: { actorUuid: actor.uuid } } }
  }).filter(row => row.key === "fallout-maw.combat.turn.started");
  assert.deepEqual(events.map(row => row.target.actorUuid), members.map(row => row.uuid));
  assert.equal(new Set(events.map(row => row.suffix)).size, 4);
});

test("a personal completion emits one turn-end event; reset and repeated marks emit none", () => {
  const { combatant, members } = fixture();
  const beforeState = { round: 1, completedActorUuids: [members[0].uuid] };
  const state = { round: 1, completedActorUuids: members.slice(0, 2).map(row => row.uuid) };
  const snapshot = value => ({ source: { flags: { "fallout-maw": { crewTurnState: value } } }, meta: {} });
  const changes = { "flags.fallout-maw.crewTurnState": state };
  const events = classifyCombatantUpdate(combatant, changes, { before: snapshot(beforeState), after: snapshot(state) });
  assert.equal(events.length, 1);
  assert.equal(events[0].key, "fallout-maw.combat.turn.ended");
  assert.equal(events[0].target.actorUuid, members[1].uuid);
  assert.equal(classifyCombatantUpdate(combatant, changes, { before: snapshot(state), after: snapshot(state) }).length, 0);
  const reset = { round: 2, completedActorUuids: [] };
  assert.equal(classifyCombatantUpdate(combatant, { "flags.fallout-maw.crewTurnState": reset }, { before: snapshot(state), after: snapshot(reset) }).length, 0);
});

test("aggregate initiative events carry each member's final total and never name the hull", () => {
  const { combatant, members } = fixture();
  const values = members.map((row, i) => ({ actorUuid: row.uuid, total: i + 10 }));
  const events = classifyCombatantUpdate(combatant, { initiative: 11, "flags.fallout-maw.crewInitiatives": values }, {
    before: { source: { initiative: null }, meta: {} }, after: { source: { initiative: 11, flags: { "fallout-maw": { crewInitiatives: values } } }, meta: {} }
  });
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(row => row.target.actorUuid), members.map(row => row.uuid));
  assert.deepEqual(events.map(row => row.data.total), [10, 11, 12, 13]);
  assert.equal(new Set(events.map(row => row.suffix)).size, 4);
});
