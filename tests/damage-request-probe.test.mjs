import assert from "node:assert/strict";
import test from "node:test";
import { captureDamageRequestProbe, recordDamageRequestProbe, summarizeDamageRequests, DAMAGE_REQUEST_PROBE_DISTINCT_CAPACITY } from "../src/debug/damage-request-probe.mjs";

test("request fan-out probe reports composition without document or source payloads", () => {
  const actor = Object.freeze({ uuid: "PRIVATE_ACTOR", name: "PRIVATE_NAME" });
  const requests = [];
  for (let cycle = 0; cycle < 4; cycle += 1) {
    for (let pellet = 0; pellet < 16; pellet += 1) {
      for (const damageTypeKey of ["PRIVATE_TYPE_A", "PRIVATE_TYPE_B"]) {
        requests.push(Object.freeze({
          actor, damageTypeKey, limbKey: pellet % 2 ? "PRIVATE_LIMB_A" : "PRIVATE_LIMB_B",
          source: Object.freeze({ damagePacketId: `PRIVATE_PACKET_${cycle}_${pellet}`, pelletIndex: pellet,
            chainRef: Object.freeze({ rootId: "PRIVATE_ROOT" }), weaponData: Object.freeze({ name: "PRIVATE_WEAPON" }) })
        }));
      }
    }
  }
  Object.freeze(requests);
  const summary = summarizeDamageRequests(requests);
  assert.deepEqual(summary, {
    requestCount: 128, compositionTruncated: 0, distinctActorCount: 1, minRequestsPerActor: 128, maxRequestsPerActor: 128,
    distinctDamageTypeCount: 2, minRequestsPerDamageType: 64, maxRequestsPerDamageType: 64,
    distinctLimbCount: 2, distinctPacketCount: 64, minRequestsPerPacket: 2, maxRequestsPerPacket: 2,
    requestsWithPacketId: 128, distinctPelletIndexCount: 16, requestsWithPelletIndex: 128,
    requestsWithInheritedChain: 128
  });
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE/);
  assert.ok(Object.values(summary).every(value => typeof value === "number" && Number.isFinite(value)));
  assert.deepEqual(Object.keys(requests[0]), ["actor", "damageTypeKey", "limbKey", "source"]);
});

test("request probe caps all composition storage and marks partial cardinalities while counting every request", () => {
  const requests = Array.from({ length: 10000 }, (_, i) => ({ actorUuid: `private-${i}`, damageTypeKey: `type-${i}`,
    limbKey: `limb-${i}`, source: { damagePacketId: `packet-${i}`, pelletIndex: i } }));
  const summary = summarizeDamageRequests(requests);
  assert.equal(summary.requestCount, 10000);
  assert.equal(summary.requestsWithPacketId, 10000);
  assert.equal(summary.requestsWithPelletIndex, 10000);
  assert.equal(summary.compositionTruncated, 1);
  for (const key of ["distinctActorCount", "distinctDamageTypeCount", "distinctLimbCount", "distinctPacketCount", "distinctPelletIndexCount"]) {
    assert.equal(summary[key], DAMAGE_REQUEST_PROBE_DISTINCT_CAPACITY);
  }
  assert.equal(summary.minRequestsPerActor, 1);
  assert.equal(summary.maxRequestsPerActor, 1);
  assert.deepEqual(Object.keys(summary), Object.keys(summarizeDamageRequests([])));
  assert.ok(JSON.stringify(summary).length < 600);
});

test("inactive and changed-run request probes do not traverse requests", () => {
  const previous = globalThis.__falloutMawGameplayProbe;
  let runId = null;
  const emitted = [];
  globalThis.__falloutMawGameplayProbe = { activeRunId: () => runId, event: (...args) => emitted.push(args) };
  const requests = [{ get source() { throw new Error("must not inspect inactive work"); } }];
  try {
    assert.equal(captureDamageRequestProbe(), null);
    assert.equal(recordDamageRequestProbe(null, "damage.normalizedRequests", requests), false);
    runId = "first";
    const captured = captureDamageRequestProbe();
    runId = "second";
    assert.equal(recordDamageRequestProbe(captured, "damage.normalizedRequests", requests), false);
    assert.deepEqual(emitted, []);
  } finally { globalThis.__falloutMawGameplayProbe = previous; }
});

test("request probe emits one finite numeric summary and rejects unbounded dimensions", () => {
  const previous = globalThis.__falloutMawGameplayProbe;
  const emitted = [];
  globalThis.__falloutMawGameplayProbe = { activeRunId: () => "run", event: (...args) => emitted.push(args) };
  try {
    const capture = captureDamageRequestProbe();
    assert.equal(recordDamageRequestProbe(capture, "private-label", []), false);
    assert.equal(recordDamageRequestProbe(capture, "weapon.volleyDamageRequests", [], {
      attackCycles: 4, configuredPellets: Infinity, configuredDamageTypes: "PRIVATE_VALUE", weaponData: { private: true }
    }), true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0][1], "H21");
    assert.equal(emitted[0][2].attackCycles, 4);
    assert.doesNotMatch(JSON.stringify(emitted), /PRIVATE|private|Infinity/);
    assert.equal("configuredPellets" in emitted[0][2], false);
    assert.equal("configuredDamageTypes" in emitted[0][2], false);
    assert.equal("weaponData" in emitted[0][2], false);
  } finally { globalThis.__falloutMawGameplayProbe = previous; }
});

test("request probe failures cannot escape into gameplay", () => {
  const previous = globalThis.__falloutMawGameplayProbe;
  try {
    globalThis.__falloutMawGameplayProbe = { get activeRunId() { throw new Error("getter failed"); } };
    assert.equal(captureDamageRequestProbe(), null);
    globalThis.__falloutMawGameplayProbe = { activeRunId() { throw new Error("method failed"); } };
    assert.equal(captureDamageRequestProbe(), null);
    globalThis.__falloutMawGameplayProbe = { activeRunId: () => "run", event() { throw new Error("event failed"); } };
    assert.equal(recordDamageRequestProbe(captureDamageRequestProbe(), "damage.normalizedRequests", []), false);
  } finally { globalThis.__falloutMawGameplayProbe = previous; }
});
