import test from "node:test";
import assert from "node:assert/strict";
import { getActorCombatSubject, isActorInActiveCombat } from "../src/combat/combat-membership.mjs";
test("crew inherits a carrier combat only with reciprocal passenger metadata", () => {
  const crew = {uuid:"Actor.crew",flags:{"fallout-maw":{actorContainerPassenger:{vehicleActorUuid:"Actor.tank",passengerId:"seat-1"}}}};
  const tank = {uuid:"Actor.tank",type:"construct",flags:{"fallout-maw":{actorContainer:{passengers:[{id:"seat-1",actorUuid:crew.uuid}]}}}};
  globalThis.fromUuidSync = id => id===tank.uuid ? tank : crew;
  const combat = {started:true,combatants:[{actor:tank}]};
  assert.equal(getActorCombatSubject(crew,combat),tank);
  assert.equal(isActorInActiveCombat(crew,combat),true);
  tank.flags["fallout-maw"].actorContainer.passengers=[];
  assert.equal(getActorCombatSubject(crew,combat),crew);
  assert.equal(isActorInActiveCombat(crew,combat),false);
});
test("an existing crew combatant retains its independent turn", () => {
  const crew={uuid:"Actor.crew"},combat={started:true,combatants:[{actor:crew}]};
  assert.equal(getActorCombatSubject(crew,combat),crew);
});
test("a linked passenger shares the vehicle turn without parked-copy metadata", () => {
  const crew = { uuid: "Actor.linked" };
  const tank = { uuid: "Actor.tank", type: "construct", flags: { "fallout-maw": {
    actorContainer: { passengers: [{ id: "linked-seat", actorUuid: crew.uuid }] }
  } } };
  const combat = { started: true, combatants: [{ actor: tank }] };
  assert.equal(getActorCombatSubject(crew, combat), tank);
  assert.equal(isActorInActiveCombat(crew, combat), true);
  tank.flags["fallout-maw"].actorContainer.passengers = [];
  assert.equal(isActorInActiveCombat(crew, combat), false);
});
