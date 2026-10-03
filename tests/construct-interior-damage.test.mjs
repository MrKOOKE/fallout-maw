import assert from "node:assert/strict";
import test from "node:test";
import { applyConstructInteriorAttack, resolveConstructInteriorAttackTarget,
  isConstructExteriorWeaponDamage } from "../src/combat/construct-interior-damage.mjs";
import { selectRandomWeightedLimbKey } from "../src/utils/limb-randomization.mjs";

function fixture(rows = [{ slotId: "hull", parentSlotId: "" }, { slotId: "engine", parentSlotId: "hull" }]) {
  globalThis.foundry = { utils: { deepClone: structuredClone, randomID: () => "id" } };
  globalThis.game = { actors: new Map(), time: { worldTime: 0 } };
  const actor = { id: "tank", uuid: "Actor.tank", type: "construct", system: { limbs: {}, constructPartSlots: [] },
    flags: { "fallout-maw": { constructInterior: { version: 1, parts: rows }, actorContainer: { passengers: [] }, constructVisual: {} } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; } };
  const items = rows.map(({ slotId }) => ({ id: slotId, name: slotId, type: "gear", actor,
    system: { placement: { mode: "constructPart", limbKey: slotId }, functions: {
      constructPart: { enabled: true, partType: slotId }, condition: { enabled: true, value: 100, max: 100 }
    } } }));
  for (const item of items) {
    actor.system.limbs[`constructPart:${item.id}`] = { value: 100, min: 0, max: 100, aimedDifficultyPercent: 0 };
    actor.system.constructPartSlots.push({ id: item.id, partType: item.id, profile: { conditionMax: 100 } });
  }
  actor.items = { contents: items, get: id => actor.items.contents.find(item => item.id === id) };
  const documents = new Map([[actor.uuid, actor]]);
  globalThis.fromUuidSync = uuid => documents.get(uuid) ?? null;
  globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
  game.actors.set(actor.id, actor);
  return { actor, items, documents };
}

function request(actor, amount = 60, penetrationPower = 10, target = { kind: "part", shellSlotId: "hull", slotId: "engine" }) {
  return { actorUuid: actor.uuid, amount, limbKey: "constructPart:hull", mode: "damage", scope: "healthAndLimb",
    damageTypeKey: "physical", damageEventIndex: 1, source: { damagePacketId: "hit-1", penetrationPower, penetrationStep: 0,
      ...(target ? { constructInteriorTarget: target } : {}) } };
}

function normalLayer(calls, transform = entry => ({ amount: entry.amount, remainder:
  Math.max(0, Number(entry.source.penetrationPower) - Number(entry.source.penetrationStep)) })) {
  return async (entries, layer) => {
    calls.push({ entries, layer });
    const applications = entries.map(entry => {
      const result = transform(entry, layer);
      return { ...entry, incomingAmount: entry.amount, amountAfterBarrier: result.amount,
        penetrationRemainder: result.remainder, actualLimbDelta: layer.protectionOnly ? 0 : result.amount };
    });
    const sum = key => applications.reduce((total, row) => total + Number(row[key] || 0), 0);
    return { actor: layer.actor, limbKey: entries[0].limbKey, source: entries[0].source,
      incomingAmount: sum("incomingAmount"), amountAfterBarrier: sum("amountAfterBarrier"),
      limbDelta: sum("actualLimbDelta"), penetrationRemainder: Math.min(...applications.map(row => row.penetrationRemainder)),
      damageApplications: applications };
  };
}

test("random construct hits select exterior shells, including broken installed shells; removal exposes contents", () => {
  const { actor, items } = fixture();
  assert.equal(selectRandomWeightedLimbKey(actor, { random: () => .99999 }), "constructPart:hull");
  actor.system.limbs["constructPart:hull"].value = 0;
  items[0].system.functions.condition.value = 0;
  assert.equal(selectRandomWeightedLimbKey(actor, { random: () => .99999 }), "constructPart:hull");
  items[0].system.placement.mode = "inventory";
  assert.equal(selectRandomWeightedLimbKey(actor, { random: () => .99999 }), "constructPart:engine");
});

test("an aimed internal part cannot bypass the native structural gate and penetration step budget", async () => {
  const { actor } = fixture(), calls = [];
  const result = await applyConstructInteriorAttack({ actor, request: request(actor, 40, 0), applyLayer: normalLayer(calls) });
  assert.deepEqual(calls.map(row => row.entries[0].limbKey), ["constructPart:hull"]);
  assert.equal(result.constructInteriorContinuation.allowed, false);
});

test("mixed damage types share one structural threshold and retain independent source identities", async () => {
  const { actor } = fixture(), calls = [];
  const first = request(actor, 30, 1), second = { ...request(actor, 30, 1), damageTypeKey: "energy", damageEventIndex: 2 };
  const result = await applyConstructInteriorAttack({ actor, requests: [first, second], applyLayer: normalLayer(calls) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].entries.map(row => row.amount), [27, 27]);
  assert.deepEqual(calls[1].entries.map(row => row.damageEventIndex), [1, 2]);
  assert.deepEqual(calls[1].entries.map(row => row.source.damagePacketId), ["hit-1", "hit-1"]);
  assert.equal(result.constructInteriorContinuation.allowed, false);
});

test("independent bullets cannot be combined to pass a shell, even when passed as one router call", async () => {
  const { actor } = fixture(), calls = [];
  const first = request(actor, 30, 1), second = { ...request(actor, 30, 1),
    source: { ...first.source, damagePacketId: "other-bullet" } };
  const result = await applyConstructInteriorAttack({ actor, requests: [first, second], applyLayer: normalLayer(calls) });
  assert.equal(result.cancelled, true);
  assert.equal(result.reason, "mixedDamagePackets");
  assert.equal(calls.length, 0);
});

test("a fully absorbed damage component does not exhaust the surviving component's later penetration budget", async () => {
  const { actor } = fixture(), calls = [];
  const physical = request(actor, 100, 100), energy = { ...request(actor, 20, 100), damageTypeKey: "energy", damageEventIndex: 2 };
  const result = await applyConstructInteriorAttack({ actor, requests: [physical, energy],
    applyLayer: normalLayer(calls, entry => entry.damageTypeKey === "energy" ? { amount: 0, remainder: 0 }
      : { amount: entry.amount, remainder: Math.max(0, entry.source.penetrationPower - entry.source.penetrationStep) }) });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].entries.length, 1);
  assert.equal(calls[1].entries[0].damageTypeKey, "physical");
  assert.equal(result.constructInteriorContinuation.allowed, true);
  assert.equal(result.constructInteriorContinuation.amount, 80);
  assert.equal(result.constructInteriorContinuation.penetrationPower, 100);
});

test("three solid nested layers reuse the actual remaining packet with linear ten percent costs", async () => {
  const { actor } = fixture([{ slotId: "hull", parentSlotId: "" }, { slotId: "cabin", parentSlotId: "hull" },
    { slotId: "engine", parentSlotId: "cabin" }]), calls = [];
  await applyConstructInteriorAttack({ actor, request: request(actor, 100, 100), applyLayer: normalLayer(calls) });
  assert.deepEqual(calls.map(row => row.entries[0].amount), [100, 90, 80]);
  assert.deepEqual(calls.map(row => row.entries[0].source.penetrationStep), [0, 1, 2]);
});

test("a contained construct continues through its own physical shells once with the original packet base", async () => {
  const outer = fixture([{ slotId: "hull", parentSlotId: "" }]);
  const inner = fixture([{ slotId: "innerHull", parentSlotId: "" }, { slotId: "core", parentSlotId: "innerHull" }]);
  inner.actor.id = "robot";
  inner.actor.uuid = "Actor.robot";
  outer.items[0].system.functions.actorContainer = { enabled: true, slots: [{ id: "crew", quantity: 1 }] };
  outer.actor.flags["fallout-maw"].actorContainer.passengers = [{ id: "robot-passenger", actorUuid: inner.actor.uuid,
    slotId: "hull:crew", slotIndex: 0 }];
  const documents = new Map([[outer.actor.uuid, outer.actor], [inner.actor.uuid, inner.actor]]);
  globalThis.fromUuidSync = uuid => documents.get(uuid) ?? null;
  globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
  const calls = [], native = normalLayer(calls);
  const applyLayer = (entries, layer) => layer.actor === inner.actor && !layer.ancestry.includes(inner.actor.uuid)
    ? applyConstructInteriorAttack({ actor: inner.actor, requests: entries, ancestry: layer.ancestry, applyLayer })
    : native(entries, layer);
  const result = await applyConstructInteriorAttack({ actor: outer.actor, request: request(outer.actor, 100, 100,
    { kind: "passenger", shellSlotId: "hull", passengerId: "robot-passenger", actorUuid: inner.actor.uuid,
      limbKey: "constructPart:innerHull" }), applyLayer });
  assert.deepEqual(calls.map(row => row.entries[0].amount), [100, 90, 80]);
  assert.deepEqual(result.constructInteriorTrace.map(row => row.slotId), ["hull", "innerHull", "core"]);
  assert.equal(result.constructInteriorContinuation.amount, 70);
  assert.equal(result.constructInteriorContinuation.penetrationStep, 3);
});

test("a barrier stopping the packet stops all interior applications", async () => {
  const { actor } = fixture(), calls = [];
  await applyConstructInteriorAttack({ actor, request: request(actor, 100, 100),
    applyLayer: normalLayer(calls, () => ({ amount: 0, remainder: 100 })) });
  assert.equal(calls.length, 1);
});

test("destroyed and removed shells have no contact, wear, or penetration cost", async () => {
  const { actor, items } = fixture([{ slotId: "hull", parentSlotId: "" }, { slotId: "cabin", parentSlotId: "hull" },
    { slotId: "engine", parentSlotId: "cabin" }]), calls = [];
  items[0].system.functions.condition.value = 0;
  items[1].system.placement.mode = "inventory";
  await applyConstructInteriorAttack({ actor, request: request(actor, 20, 0), applyLayer: normalLayer(calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entries[0].limbKey, "constructPart:engine");
  assert.equal(calls[0].entries[0].amount, 20);
  assert.equal(calls[0].entries[0].source.penetrationStep, 0);
});

test("stale synthetic occupant references resolve the parked actual actor while forged actor identity is rejected", async () => {
  const { actor, items, documents } = fixture();
  items[0].system.functions.actorContainer = { enabled: true, slots: [{ id: "crew", quantity: 1 }] };
  const victim = { id: "crew", uuid: "Actor.crew", type: "character", system: { limbs: { head: { min: 0, max: 100, value: 100 } } } };
  game.actors.set(victim.id, victim);
  documents.set(victim.uuid, victim);
  const passenger = { id: "occupant", actorUuid: "Scene.old.Token.deleted.Actor.crew", parkedActorId: "crew", slotId: "hull:crew", slotIndex: 0 };
  actor.flags["fallout-maw"].actorContainer.passengers.push(passenger);
  const target = { kind: "passenger", shellSlotId: "hull", passengerId: passenger.id, actorUuid: victim.uuid, limbKey: "head" };
  const calls = [];
  await applyConstructInteriorAttack({ actor, request: request(actor, 100, 100, target), applyLayer: normalLayer(calls) });
  assert.deepEqual(calls.map(row => row.layer.actor.uuid), [actor.uuid, victim.uuid]);
  const forged = resolveConstructInteriorAttackTarget(actor, request(actor, 100, 100, { ...target, actorUuid: "Actor.stranger" }));
  assert.equal(forged.invalid, true);
});

test("forged outer shell and mixed internal destinations fail closed before any damage", async () => {
  const { actor } = fixture(), calls = [];
  const forged = request(actor, 100, 100, { kind: "part", shellSlotId: "engine", slotId: "engine" });
  const result = await applyConstructInteriorAttack({ actor, request: forged, applyLayer: normalLayer(calls) });
  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 0);
  const mixed = await applyConstructInteriorAttack({ actor, requests: [request(actor), request(actor, 100, 100,
    { kind: "part", shellSlotId: "hull", slotId: "hull" })], applyLayer: normalLayer(calls) });
  assert.equal(mixed.cancelled, true);
  assert.equal(calls.length, 0);
});

test("stable hit packet identity selects the same compartment target for prediction and application", async () => {
  const { actor } = fixture([{ slotId: "hull", parentSlotId: "" }, { slotId: "engine", parentSlotId: "hull" },
    { slotId: "battery", parentSlotId: "hull" }]);
  const predictions = [], applications = [];
  const data = request(actor, 100, 100, null);
  await applyConstructInteriorAttack({ actor, request: data, applyLayer: normalLayer(predictions) });
  await applyConstructInteriorAttack({ actor, request: data, applyLayer: normalLayer(applications) });
  assert.deepEqual(predictions.map(row => row.entries[0].limbKey), applications.map(row => row.entries[0].limbKey));
});

test("incoming firing-port coverage is passed into native mitigation before damage and does not spend a solid step", async () => {
  const { actor, items, documents } = fixture();
  items[0].system.functions.actorContainer = { enabled: true, slots: [{ id: "crew", quantity: 1 }] };
  const victim = { id: "crew", uuid: "Actor.crew", type: "character", system: { limbs: { head: { min: 0, max: 100, value: 100 } } } };
  documents.set(victim.uuid, victim);
  const passenger = { id: "occupant", actorUuid: victim.uuid, slotId: "hull:crew", slotIndex: 0 };
  actor.flags["fallout-maw"].actorContainer.passengers.push(passenger);
  actor.flags["fallout-maw"].constructVisual = {
    anchors: [{ id: "window", x: .5, y: .5, rotation: 0 }], seats: [{ id: "seat", slotId: "hull:crew", slotIndex: 0,
      personalWeapons: { enabled: true, anchorId: "window", minRotation: -45, maxRotation: 45, coverPercent: 70 } }]
  };
  globalThis.canvas = { grid: { size: 100 } };
  const token = { uuid: "Scene.scene.Token.tank", actor, x: 0, y: 0, width: 1, height: 1, rotation: 0 };
  documents.set(token.uuid, token);
  const data = request(actor, 20, 0, { kind: "passenger", shellSlotId: "hull", passengerId: passenger.id,
    actorUuid: victim.uuid, limbKey: "head" });
  data.source.targetTokenUuid = token.uuid;
  data.source.attackerOrigin = { x: 50, y: -100 };
  const calls = [];
  const nativeBatch = normalLayer(calls,
    (entry, layer) => ({ amount: Math.max(0, entry.amount - (layer.protectionOnly ? 20 * layer.mitigationScale : 0)), remainder: 0 }));
  const result = await applyConstructInteriorAttack({ actor, request: data,
    // The ordinary system-event workflow returns a batch result array.
    applyLayer: async (...args) => [await nativeBatch(...args)] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].layer.protectionOnly, true);
  assert.equal(calls[0].layer.mitigationScale, .7);
  assert.equal(calls[1].entries[0].amount, 6);
  assert.equal(calls[1].entries[0].source.penetrationStep, 0);
  assert.equal(result.constructInteriorTrace[1].amountAfterBarrier, 6);
  assert.equal(result.constructInteriorTrace[1].partDamage, 6);
  actor.flags["fallout-maw"].constructVisual.seats[0].personalWeapons.coverPercent = 0;
  const openCalls = [];
  await applyConstructInteriorAttack({ actor, request: data, applyLayer: normalLayer(openCalls) });
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].layer.actor, victim);
  assert.equal(openCalls[0].entries[0].amount, 20);
  data.source.attackerOrigin = { x: 50, y: 200 };
  const rearCalls = [];
  await applyConstructInteriorAttack({ actor, request: data, applyLayer: normalLayer(rearCalls) });
  assert.equal(rearCalls.length, 1);
  assert.equal(rearCalls[0].layer.actor, actor);
  assert.equal(rearCalls[0].layer.protectionOnly, false);
});

test("untargeted external weapon damage routes via shells while explicit resource edits and healing remain ordinary", () => {
  const { actor } = fixture();
  const area = { ...request(actor, 20, 0, null), limbKey: "", scope: "health" };
  area.source.weaponAttackDamage = true;
  assert.equal(isConstructExteriorWeaponDamage(actor, area), true);
  assert.equal(isConstructExteriorWeaponDamage(actor, { ...area, mode: "healing" }), false);
  assert.equal(isConstructExteriorWeaponDamage(actor, { ...area, applyMitigation: false }), false);
  assert.equal(isConstructExteriorWeaponDamage(actor, { ...area, scope: "itemCondition" }), false);
  assert.equal(isConstructExteriorWeaponDamage(actor, { ...area, source: {} }), false);
  assert.equal(isConstructExteriorWeaponDamage(actor, { ...area, source: { weaponData: {} } }), false);
  assert.equal(isConstructExteriorWeaponDamage(actor, { ...area, source: { weaponData: { damage: "20" } } }), true);
});
