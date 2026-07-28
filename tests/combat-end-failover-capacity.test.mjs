import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCombatEndSessionRegistry
} from "../src/combat/combat-end-session-registry.mjs";

const resolutionSource = await readFile(
  new URL("../src/combat/combat-end-resolution.mjs", import.meta.url),
  "utf8"
);

function sliceFunction(name, nextName) {
  const start = resolutionSource.indexOf(`function ${name}(`);
  const end = resolutionSource.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} is missing`);
  assert.notEqual(end, -1, `${nextName} is missing`);
  return resolutionSource.slice(start, end);
}

function createSession(id, {
  updatedAt,
  revision = 1,
  operationPending = false
} = {}) {
  return {
    id,
    createdAt: updatedAt,
    updatedAt,
    revision,
    operationPending,
    entries: [{
      id: `Actor.${id}`,
      actorUuid: `Actor.${id}`
    }]
  };
}

function ids(registry) {
  return Array.from(registry.values(), session => session.id).sort();
}

test("failover replicas converge when replicated pending states exceed capacity", () => {
  const options = {
    clock: () => 1_000,
    maxSessions: 2,
    sessionTtlMs: 10_000
  };
  const states = [
    createSession("pending-old", { updatedAt: 10, operationPending: true }),
    createSession("ordinary-middle", { updatedAt: 20 }),
    createSession("pending-new", { updatedAt: 30, operationPending: true })
  ];
  const forward = createCombatEndSessionRegistry(options);
  const reverse = createCombatEndSessionRegistry(options);

  for (const state of states) forward.upsert(structuredClone(state));
  for (const state of states.toReversed()) reverse.upsert(structuredClone(state));

  assert.deepEqual(ids(forward), ["pending-new", "pending-old"]);
  assert.deepEqual(ids(reverse), ids(forward));
  assert.equal(forward.getStats().sessions.overCapacity, 0);
  assert.equal(reverse.getStats().sessions.overCapacity, 0);
});

test("replicated pending state remains evictable while a local failover operation pin does not", () => {
  const registry = createCombatEndSessionRegistry({
    clock: () => 1_000,
    maxSessions: 1,
    sessionTtlMs: 10_000
  });
  registry.upsert(createSession("local-operation", { updatedAt: 10 }));
  assert.equal(registry.pin("local-operation"), 1);

  const replicated = registry.upsert(createSession("replicated-operation", {
    updatedAt: 20,
    operationPending: true
  }));

  assert.equal(replicated.stored, false);
  assert.deepEqual(ids(registry), ["local-operation"]);
  assert.equal(registry.getStats().sessions.overCapacity, 0);
});

test("finish requests use authenticated Foundry user queries instead of spoofable socket envelopes", () => {
  const request = sliceFunction("requestCombatEndFinish", "runCombatEndFinish");
  const query = sliceFunction("handleCombatEndFinishQuery", "enqueueCombatEndOperation");

  assert.match(resolutionSource, /CONFIG\.queries\[COMBAT_END_FINISH_QUERY\]\s*=\s*handleCombatEndFinishQuery/);
  assert.match(request, /gm\.query\(\s*COMBAT_END_FINISH_QUERY/);
  assert.match(query, /\{\s*user:\s*requester\s*\}/);
  assert.match(query, /requesterUserId:\s*requester\.id/);
  assert.doesNotMatch(resolutionSource, /type:\s*"finish(?:Request|Response)"/);
  assert.doesNotMatch(resolutionSource, /pendingSocketRequests/);
});

test("per-target finishing is deduplicated and bounded before a session is pinned", () => {
  const enqueue = sliceFunction("enqueuePinnedCombatEndFinish", "handleCombatEndFinish");
  const pendingLookup = enqueue.indexOf("pendingFinishOperations.get(operationKey)");
  const capacityCheck = enqueue.indexOf(
    "pendingFinishOperations.size >= COMBAT_END_MAX_PENDING_FINISHES"
  );
  const pin = enqueue.indexOf("combatEndSessionRegistry.pin(sessionId)");

  assert.ok(pendingLookup >= 0 && pendingLookup < pin);
  assert.ok(capacityCheck >= 0 && capacityCheck < pin);
  assert.match(enqueue, /pendingFinishOperations\.set\(operationKey,\s*operation\)/);
  assert.match(enqueue, /pendingFinishOperations\.delete\(operationKey\)/);
  assert.match(enqueue, /getCombatEndFinishOperationKey\(sessionId,\s*actorUuid\)/);
});

test("an in-flight finishing claim survives authority reconstruction and gates damage", () => {
  const refresh = sliceFunction(
    "refreshAllCombatEndSessionsAsAuthority",
    "refreshCombatEndSessionsForActor"
  );
  const enqueue = sliceFunction("enqueuePinnedCombatEndFinish", "handleCombatEndFinish");
  const finish = sliceFunction("handleCombatEndFinish", "getCombatEndFinishOperationKey");

  assert.match(refresh, /getActiveCombatEndFinishClaim\(entry\)/);
  assert.doesNotMatch(refresh, /entry\.finishing\s*=\s*false/);
  assert.match(enqueue, /setCombatEndFinishClaim\(entry/);
  assert.match(enqueue, /isMatchingCombatEndFinishClaim\(currentEntry,\s*operationId,\s*authorityUserId\)/);
  assert.ok(
    finish.indexOf("isCombatEndAuthority(authorityUserId)")
      < finish.indexOf("await applyDamageApplication")
  );
  assert.match(finish, /combatEndOperationId:\s*operationId/);
});

test("ordinary disconnects no longer trigger a full authority registry exchange", () => {
  const connected = sliceFunction("handleCombatEndUserConnected", "sendCombatEndSessionSync");

  assert.match(connected, /authorityChanged/);
  assert.match(connected, /if \(authorityChanged\)/);
  assert.match(connected, /if \(connected && activeGM\.id === game\.user\?\.id/);
  assert.doesNotMatch(connected, /if \(!connected/);
});
