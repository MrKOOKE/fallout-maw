import assert from "node:assert/strict";
import test from "node:test";
import { collectHudGmTargets, selectHudGmActors } from "../src/utils/hud-gm-targets.mjs";

const gm = { isGM: true };
function fixture() {
  const people = ["driver", "gunner", "loader"].map(id => ({ id, uuid: `Actor.${id}`, name: "Same name", type: "character",
    statuses: new Set(id === "loader" ? ["unconscious"] : id === "gunner" ? ["dead"] : []),
    testUserPermission: user => user?.isGM }));
  const carrier = { uuid: "Actor.tank", name: "Tank", type: "construct", testUserPermission: user => user?.isGM,
    flags: { "fallout-maw": { constructVisual: { seats: people.map((person, slotIndex) => ({
      id: person.id, name: person.id, role: "passenger", slotId: "cabin:crew", slotIndex
    })) }, actorContainer: { passengers: people.map((person, slotIndex) => ({
      id: person.id, actorUuid: person.uuid, slotId: "cabin:crew", slotIndex
    })) } } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    items: { contents: [{ id: "cabin", name: "Cabin", type: "gear", system: { functions: {
      actorContainer: { enabled: true, slots: [{ id: "crew", width: 1, height: 1, quantity: 4 }] }
    } } }] }
  };
  globalThis.fromUuidSync = uuid => people.find(person => person.uuid === uuid);
  return { carrier, people, token: { actor: carrier } };
}

test("administrative targets include the carrier and incapacitated parked crew", () => {
  const { token, carrier, people } = fixture();
  const targets = collectHudGmTargets([token], { user: gm });
  assert.deepEqual(targets.map(target => target.actor), [carrier, ...people]);
  assert.deepEqual(targets.slice(1).map(target => target.detail), ["driver — Tank", "gunner — Tank", "loader — Tank"]);
});

test("linked tokens and separately selected crew are not awarded twice; equal names stay distinct", () => {
  const { token, people } = fixture();
  const targets = collectHudGmTargets([token, { actor: token.actor }, { actor: people[0] }], { user: gm });
  assert.equal(targets.length, 4);
  assert.equal(new Set(targets.map(target => target.actor.uuid)).size, 4);
});

test("synthetic actor UUIDs remain separate from their world source", () => {
  const { people } = fixture();
  const synthetic = { ...people[0], uuid: "Scene.scene.Token.token.Actor.driver" };
  assert.equal(collectHudGmTargets([{ actor: people[0] }, { actor: synthetic }], { user: gm }).length, 2);
});

test("empty selection may use the HUD carrier, but inaccessible actors remain excluded", () => {
  const { carrier } = fixture();
  assert.equal(collectHudGmTargets([], { user: gm, fallbackActor: carrier }).length, 4);
  assert.deepEqual(collectHudGmTargets([], { user: {}, fallbackActor: carrier }), []);
});

test("submitting checked fields applies only to those actors, including none", () => {
  const { token, people } = fixture();
  const targets = collectHudGmTargets([token], { user: gm });
  assert.deepEqual(selectHudGmActors(targets, { hudTarget0: false, hudTarget2: "true", hudTarget3: true }), [people[1], people[2]]);
  assert.deepEqual(selectHudGmActors(targets, {}), []);
  assert.deepEqual(selectHudGmActors(targets, { hudTarget0: "false", hudTarget1: false }), []);
  assert.deepEqual(selectHudGmActors(targets, Object.fromEntries(targets.map(target => [target.field, true]))), targets.map(target => target.actor));
});
