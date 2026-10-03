import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { carryConstructDamageRequests, getConstructContinuationDamageAmount } from "../src/utils/construct-damage-continuation.mjs";

const controllerSource = await readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8");
const methods = controllerSource.slice(controllerSource.indexOf("  stampAttackDamageSources(requests = []) {"),
  controllerSource.indexOf("  createWeaponActionModifierContext(extra = {}) {"));

function fixture(estimate, { nativeEstimate = null, nativePenetrate = null } = {}) {
  let ids = 0;
  const target = { actor: { uuid: "Actor.tank", type: "construct" }, document: { uuid: "Scene.scene.Token.tank" } };
  const context = { foundry: { utils: { deepClone: structuredClone, randomID: () => `fallback-${++ids}` } },
    canvas: { tokens: { placeables: [target] } }, normalizeConstructInteriorTarget: structuredClone,
    estimateConstructInteriorAttackGroup: estimate,
    estimateDamageApplicationsBatch: nativeEstimate ?? (() => { throw new Error("Unexpected ordinary target fallback"); }),
    doesDamageRequestGroupPenetratePart: nativePenetrate,
    getDamageRequestGroupPenetrationPower: packet => Math.min(...packet.map(request => request.source.penetrationPower)),
    getSingleDamageRequestLimbKey: packet => packet[0].limbKey };
  const Controller = vm.runInNewContext(`class Controller { ${methods} }; Controller`, context);
  const controller = new Controller();
  Object.assign(controller, { attackId: "attack", token: { actor: { uuid: "Actor.gunner" }, document: { uuid: "Scene.scene.Token.gunner" } },
    weapon: { uuid: "Actor.tank.Item.cannon" }, selectedTarget: target, getEffectiveWeaponData: () => ({ damage: "60" }),
    getAttackOrigin: () => ({ x: 24, y: 32 }) });
  return { controller, target };
}

const partRequest = (target, id, damageTypeKey = "physical") => ({ actor: target.actor, limbKey: "constructPart:hull", amount: 30,
  scope: "healthAndLimb", damageTypeKey, source: id ? { damagePacketId: id, conditionWearPacketId: id } : {} });

test("separate physical hits are estimated independently while the damage types of one hit stay together", async () => {
  const groups = [];
  const { controller, target } = fixture(async packet => {
    groups.push(packet);
    const passed = packet.length > 1;
    const components = passed ? packet.map((request, index) => ({ amount: 27, damageTypeKey: request.damageTypeKey,
      source: { ...request.source, constructInteriorBaseAmount: 30, constructInteriorPacketIndex: index,
        penetrationPower: 1, penetrationStep: 1 } })) : [];
    return { constructInteriorContinuation: { allowed: passed, amount: passed ? 54 : 0,
      penetrationPower: 1, penetrationStep: 1, components } };
  });
  const separate = await controller.getConstructInteriorContinuation([partRequest(target, "bullet-a"), partRequest(target, "bullet-b")], target.actor);
  assert.equal(separate.allowed, false);
  assert.deepEqual(groups.map(group => group.length), [1, 1]);
  groups.length = 0;
  const sameHit = await controller.getConstructInteriorContinuation([partRequest(target, "bullet-c"), partRequest(target, "bullet-c", "energy")], target.actor);
  assert.equal(sameHit.allowed, true);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
  assert.equal(sameHit.components.length, 2);
  assert.equal(sameHit.amount, 54);
});

test("missing hit identity is assigned separately and remains on the actual requests", async () => {
  const groups = [];
  const { controller, target } = fixture(async packet => { groups.push(packet); return { constructInteriorContinuation: { allowed: false, amount: 0 } }; });
  const requests = [partRequest(target), partRequest(target)];
  await controller.getConstructInteriorContinuation(requests, target.actor);
  assert.equal(groups.length, 2);
  assert.notEqual(requests[0].source.damagePacketId, requests[1].source.damagePacketId);
  assert.equal(groups[0][0].source.damagePacketId, requests[0].source.damagePacketId);
});

test("after leaving the construct, separate bullets still reach the native threshold as separate hits", async () => {
  const thresholdGroups = [];
  const { controller, target } = fixture(async () => null, {
    nativeEstimate: (_actor, packet) => ({ damageApplications: packet.map(request => ({ source: request.source, damageTypeKey: request.damageTypeKey,
      amountAfterBarrier: request.amount, penetrationRemainder: 1 })) }),
    nativePenetrate: packet => { thresholdGroups.push(packet); return packet.reduce((sum, request) => sum + request.amount, 0) >= 50; }
  });
  target.actor.type = "character";
  const make = (id, type = "physical") => ({ ...partRequest(target, id, type), source: {
    damagePacketId: id, conditionWearPacketId: id, constructInteriorBaseAmount: 30, penetrationPower: 1, penetrationStep: 0 } });
  const separate = await controller.getConstructInteriorContinuation([make("a"), make("b")], target.actor);
  assert.equal(separate.allowed, false);
  assert.deepEqual(thresholdGroups.map(packet => packet.length), [1, 1]);
  thresholdGroups.length = 0;
  const sameHit = await controller.getConstructInteriorContinuation([make("c"), make("c", "energy")], target.actor);
  assert.equal(sameHit.allowed, true);
  assert.deepEqual(thresholdGroups.map(packet => packet.length), [2]);
  assert.deepEqual(structuredClone(sameHit.components.map(component => component.amount)), [27, 27]);
  assert.deepEqual(structuredClone(sameHit.components.map(component => component.source.damagePacketId)), ["c", "c"]);
});

test("actor-document requests retain the aimed interior descriptor and actual target token stamp", () => {
  const { controller, target } = fixture();
  controller.selectedInteriorTarget = { kind: "part", shellSlotId: "hull", slotId: "engine" };
  const [stamped] = controller.stampAttackDamageSources([partRequest(target, "bullet")]);
  assert.deepEqual(structuredClone(stamped.source.constructInteriorTarget), controller.selectedInteriorTarget);
  assert.equal(stamped.source.targetTokenUuid, target.document.uuid);
  assert.deepEqual(structuredClone(stamped.source.attackerOrigin), { x: 24, y: 32 });
});

test("next external target keeps projectile identity, type-specific remainder and linear original-base costs", () => {
  const continuation = { allowed: true, penetrationStep: 3, components: [
    { amount: 30, damageTypeKey: "physical", source: { damagePacketId: "a", conditionWearPacketId: "a", penetrationPower: 20,
      penetrationStep: 3, constructInteriorBaseAmount: 50, constructInteriorPacketIndex: 0,
      constructInteriorTarget: { slotId: "old-engine" } } },
    { amount: 10, damageTypeKey: "energy", source: { damagePacketId: "b", conditionWearPacketId: "b", penetrationPower: 8,
      penetrationStep: 2, constructInteriorBaseAmount: 20, constructInteriorPacketIndex: 0 } }
  ] };
  const prototypes = ["physical", "energy"].map(damageTypeKey => ({ actorUuid: "Actor.next", limbKey: "torso", amount: 999,
    damageTypeKey, source: { damagePacketId: "fresh-hit", penetrationPower: 99, attackerOrigin: { x: 24, y: 32 },
      targetTokenUuid: "old-token", attackDistanceMeters: 12 } }));
  const carried = carryConstructDamageRequests(prototypes, continuation, { penetrationStep: 4, targetTokenUuid: "Scene.scene.Token.next" });
  assert.deepEqual(carried.map(request => request.amount), [25, 8]);
  assert.deepEqual(carried.map(request => request.source.damagePacketId), ["a", "b"]);
  assert.deepEqual(carried.map(request => request.source.constructInteriorBaseAmount), [50, 20]);
  assert.deepEqual(carried.map(request => request.source.penetrationStep), [4, 3]);
  assert.deepEqual(carried.map(request => request.source.penetrationPower), [20, 8]);
  assert.equal(carried[0].source.constructInteriorTarget, undefined);
  assert.equal(carried[0].source.targetTokenUuid, "Scene.scene.Token.next");
  assert.equal(carried[0].source.attackDistanceMeters, 12);
  assert.equal(getConstructContinuationDamageAmount(continuation, 4), 33);
});
