import assert from "node:assert/strict";
import test from "node:test";

import {
  COMBAT_END_SESSION_REGISTRY_DEFAULTS,
  createCombatEndSessionRegistry
} from "../src/combat/combat-end-session-registry.mjs";

function createClock(initial = 0) {
  let current = initial;
  return {
    clock: () => current,
    set(value) {
      current = value;
    }
  };
}

function createSession(id, {
  createdAt = 0,
  updatedAt,
  expiresAt,
  revision,
  operationPending = false,
  actorUuid = `Actor.${id}`,
  actorUuids
} = {}) {
  const entryActorUuids = actorUuids ?? [actorUuid];
  return {
    id,
    createdAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(revision === undefined ? {} : { revision }),
    ...(operationPending ? { operationPending: true } : {}),
    entries: entryActorUuids.map(entryActorUuid => ({
      id: entryActorUuid,
      actorUuid: entryActorUuid
    }))
  };
}

function sessionIds(registry) {
  return Array.from(registry.values(), session => session.id).sort();
}

test("registry defaults are finite bounds", () => {
  assert.deepEqual(COMBAT_END_SESSION_REGISTRY_DEFAULTS, {
    sessionTtlMs: 6 * 60 * 60 * 1000,
    dismissalTtlMs: 24 * 60 * 60 * 1000,
    terminalTtlMs: 24 * 60 * 60 * 1000,
    maxSessions: 32,
    maxDismissals: 128,
    maxTerminals: 128
  });
  for (const value of Object.values(COMBAT_END_SESSION_REGISTRY_DEFAULTS)) {
    assert.equal(Number.isSafeInteger(value), true);
    assert.ok(value > 0);
  }
});

test("empty replicated state removes its session immediately", () => {
  const registry = createCombatEndSessionRegistry({ clock: () => 100 });
  assert.equal(registry.upsert(createSession("combat-a")).stored, true);
  assert.equal(registry.has("combat-a"), true);

  const result = registry.upsert({ id: "combat-a", entries: [] });
  assert.equal(result.stored, false);
  assert.equal(result.reason, "empty");
  assert.deepEqual(result.removedSessions, [{ id: "combat-a", reason: "empty", revision: 0 }]);
  assert.equal(registry.has("combat-a"), false);
  assert.equal(registry.getTerminalRevision("combat-a"), 0);
  assert.deepEqual(registry.sessionsForActor("Actor.combat-a"), []);
});

test("terminal revision rejects stale and equal state but permits a newer state", () => {
  const registry = createCombatEndSessionRegistry({ clock: () => 100 });
  registry.upsert(createSession("combat-a", { revision: 5 }));
  registry.dismiss("combat-a");

  const staleTerminal = registry.upsert({
    id: "combat-a",
    revision: 4,
    entries: []
  });
  assert.equal(staleTerminal.accepted, false);
  assert.equal(registry.get("combat-a").revision, 5);
  assert.equal(registry.isDismissed("combat-a"), true);

  const terminal = registry.upsert({
    id: "combat-a",
    revision: 5,
    updatedAt: 100,
    entries: []
  });
  assert.equal(terminal.accepted, true);
  assert.equal(registry.has("combat-a"), false);
  assert.equal(registry.getTerminalRevision("combat-a"), 5);
  assert.equal(registry.isDismissed("combat-a"), false);

  for (const revision of [4, 5]) {
    const rejected = registry.upsert(createSession("combat-a", { revision }));
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, "stale-terminal");
    assert.equal(registry.has("combat-a"), false);
  }

  const newer = registry.upsert(createSession("combat-a", { revision: 6 }));
  assert.equal(newer.accepted, true);
  assert.equal(newer.stored, true);
  assert.equal(registry.get("combat-a").revision, 6);
  assert.equal(registry.hasTerminal("combat-a"), false);
  assert.deepEqual(newer.removedTerminals, [
    { id: "combat-a", reason: "superseded" }
  ]);
});

test("authoritative terminal tombstones have their own capacity and TTL", () => {
  const time = createClock(100);
  const registry = createCombatEndSessionRegistry({
    clock: time.clock,
    maxTerminals: 2,
    terminalTtlMs: 10
  });

  registry.upsert({ id: "combat-a", revision: 1, updatedAt: 10, entries: [] });
  registry.upsert({ id: "combat-b", revision: 1, updatedAt: 20, entries: [] });
  const capacity = registry.upsert({
    id: "combat-c",
    revision: 1,
    updatedAt: 30,
    entries: []
  });
  assert.equal(registry.hasTerminal("combat-a"), false);
  assert.equal(registry.hasTerminal("combat-b"), true);
  assert.equal(registry.hasTerminal("combat-c"), true);
  assert.deepEqual(capacity.removedTerminals, [
    { id: "combat-a", reason: "capacity" }
  ]);

  time.set(110);
  const expired = registry.prune();
  assert.deepEqual(expired.removedTerminals, [
    { id: "combat-b", reason: "expired" },
    { id: "combat-c", reason: "expired" }
  ]);
  assert.equal(registry.terminalSize, 0);
});

test("a mutated session which becomes empty is removed during pruning", () => {
  const registry = createCombatEndSessionRegistry({ clock: () => 100 });
  const session = createSession("combat-a");
  registry.upsert(session);
  session.entries.length = 0;

  assert.deepEqual(registry.prune().removedSessions, [
    { id: "combat-a", reason: "empty", revision: 0 }
  ]);
  assert.equal(registry.size, 0);
});

test("dismissal hides local UI without discarding failover state", () => {
  const gmReplica = createCombatEndSessionRegistry({ clock: () => 100 });
  const playerReplica = createCombatEndSessionRegistry({ clock: () => 100 });
  const state = createSession("combat-a", { createdAt: 90 });

  gmReplica.upsert(state);
  playerReplica.upsert(structuredClone(state));
  playerReplica.dismiss("combat-a");

  assert.equal(playerReplica.isDismissed("combat-a"), true);
  assert.equal(playerReplica.has("combat-a"), true);
  assert.deepEqual(sessionIds(playerReplica), sessionIds(gmReplica));

  const failoverSession = playerReplica.get("combat-a");
  assert.equal(failoverSession.entries[0].actorUuid, "Actor.combat-a");
});

test("actor index replaces links even when a stored session object was mutated in place", () => {
  const registry = createCombatEndSessionRegistry({ clock: () => 100 });
  const session = createSession("combat-a", {
    actorUuids: ["Actor.alpha", "Actor.shared"]
  });
  registry.upsert(session);

  session.entries = createSession("ignored", {
    actorUuids: ["Actor.shared", "Actor.beta", "Actor.beta"]
  }).entries;
  session.revision = 1;
  registry.upsert(session);

  assert.deepEqual(registry.sessionIdsForActor("Actor.alpha"), []);
  assert.deepEqual(registry.sessionIdsForActor("Actor.shared"), ["combat-a"]);
  assert.deepEqual(registry.sessionIdsForActor("Actor.beta"), ["combat-a"]);
  assert.deepEqual(registry.sessionsForActor("Actor.beta"), [session]);
});

test("actor index is cleared by capacity eviction, expiry, delete, and clear", () => {
  const time = createClock(100);
  const registry = createCombatEndSessionRegistry({
    clock: time.clock,
    maxSessions: 2,
    sessionTtlMs: 20
  });

  registry.upsert(createSession("combat-a", {
    createdAt: 10,
    actorUuid: "Actor.capacity"
  }));
  registry.upsert(createSession("combat-b", {
    createdAt: 20,
    expiresAt: 110,
    actorUuid: "Actor.expiry"
  }));
  registry.upsert(createSession("combat-c", {
    createdAt: 30,
    expiresAt: 120,
    actorUuid: "Actor.delete"
  }));
  assert.deepEqual(registry.sessionIdsForActor("Actor.capacity"), []);

  time.set(105);
  registry.upsert(createSession("combat-c", {
    createdAt: 30,
    updatedAt: 105,
    expiresAt: 120,
    actorUuid: "Actor.delete",
    revision: 1
  }));
  time.set(110);
  registry.prune();
  assert.deepEqual(registry.sessionIdsForActor("Actor.expiry"), []);
  assert.deepEqual(registry.sessionIdsForActor("Actor.delete"), ["combat-c"]);

  registry.delete("combat-c");
  assert.deepEqual(registry.sessionIdsForActor("Actor.delete"), []);

  registry.upsert(createSession("combat-d", { actorUuid: "Actor.clear-a" }));
  registry.upsert(createSession("combat-e", { actorUuid: "Actor.clear-b" }));
  registry.clear();
  assert.deepEqual(registry.sessionIdsForActor("Actor.clear-a"), []);
  assert.deepEqual(registry.sessionIdsForActor("Actor.clear-b"), []);
});

test("an in-flight local pin defers TTL and rejects a capacity newcomer", () => {
  const time = createClock(100);
  const registry = createCombatEndSessionRegistry({
    clock: time.clock,
    maxSessions: 1,
    sessionTtlMs: 10
  });
  registry.upsert(createSession("combat-a", {
    createdAt: 10,
    actorUuid: "Actor.pinned"
  }));
  assert.equal(registry.pin("combat-a"), 1);
  assert.equal(registry.pin("combat-a"), 2);

  const newcomer = registry.upsert(createSession("combat-b", {
    createdAt: 20,
    actorUuid: "Actor.new"
  }));
  assert.equal(newcomer.stored, false);
  assert.equal(newcomer.reason, "capacity");
  assert.deepEqual(sessionIds(registry), ["combat-a"]);
  assert.equal(registry.getStats().sessions.overCapacity, 0);

  time.set(110);
  assert.deepEqual(registry.prune().removedSessions, []);
  assert.equal(registry.has("combat-a"), true);
  assert.equal(registry.unpin("combat-a").pinCount, 1);
  const release = registry.unpin("combat-a");
  assert.equal(release.unpinned, true);
  assert.deepEqual(release.removedSessions, [{ id: "combat-a", reason: "expired", revision: 0 }]);
  assert.equal(registry.has("combat-a"), false);
  assert.equal(registry.has("combat-b"), false);
  assert.deepEqual(registry.sessionIdsForActor("Actor.pinned"), []);
});

test("a protected session consumes its bounded capacity slot", () => {
  const registry = createCombatEndSessionRegistry({
    clock: () => 100,
    maxSessions: 1,
    sessionTtlMs: 1000
  });
  registry.upsert(createSession("combat-protected", {
    createdAt: 1,
    operationPending: true
  }));

  for (let index = 0; index < 20; index += 1) {
    registry.upsert(createSession(`combat-${index}`, {
      createdAt: 10 + index
    }));
  }

  assert.equal(registry.size, 1);
  assert.equal(registry.has("combat-protected"), true);
  assert.equal(registry.has("combat-19"), false);
  assert.equal(registry.getStats().sessions.overCapacity, 0);
});

test("replicated pending states cannot grow the registry past its hard limit", () => {
  const registry = createCombatEndSessionRegistry({
    clock: () => 100,
    maxSessions: 1,
    sessionTtlMs: 1000
  });

  for (let index = 0; index < 20; index += 1) {
    registry.upsert(createSession(`combat-${index}`, {
      createdAt: 10 + index,
      operationPending: true
    }));
    assert.equal(registry.size, 1);
  }

  assert.deepEqual(sessionIds(registry), ["combat-19"]);
  assert.equal(registry.getStats().sessions.overCapacity, 0);
});

test("a stale replicated pending state expires while a local pin does not", () => {
  const time = createClock(100);
  const registry = createCombatEndSessionRegistry({
    clock: time.clock,
    maxSessions: 2,
    sessionTtlMs: 10
  });
  registry.upsert(createSession("combat-replicated", {
    operationPending: true
  }));
  registry.upsert(createSession("combat-local", {
    operationPending: true
  }));
  registry.pin("combat-local");

  time.set(110);
  const pruned = registry.prune();

  assert.deepEqual(pruned.removedSessions, [{
    id: "combat-replicated",
    reason: "expired",
    revision: 0
  }]);
  assert.equal(registry.has("combat-local"), true);
});

test("multiple local pins retain their existing slots while new states are evicted", () => {
  const registry = createCombatEndSessionRegistry({
    clock: () => 100,
    maxSessions: 2,
    sessionTtlMs: 1000
  });
  registry.upsert(createSession("combat-pinned-a", { createdAt: 1 }));
  registry.upsert(createSession("combat-pinned-b", { createdAt: 2 }));
  registry.pin("combat-pinned-a");
  registry.pin("combat-pinned-b");

  for (let index = 0; index < 20; index += 1) {
    registry.upsert(createSession(`combat-new-${index}`, {
      createdAt: 10 + index
    }));
    assert.equal(registry.size, 2);
  }

  assert.deepEqual(sessionIds(registry), ["combat-pinned-a", "combat-pinned-b"]);
  assert.equal(registry.getStats().sessions.overCapacity, 0);
});

test("session TTL is a hard deadline which repeated receipt cannot extend", () => {
  const time = createClock(100);
  const registry = createCombatEndSessionRegistry({
    clock: time.clock,
    sessionTtlMs: 50,
    dismissalTtlMs: 20
  });

  registry.upsert(createSession("combat-a"));
  registry.dismiss("combat-a");
  time.set(119);
  assert.equal(registry.has("combat-a"), true);
  assert.equal(registry.isDismissed("combat-a"), true);

  time.set(120);
  registry.prune();
  assert.equal(registry.isDismissed("combat-a"), false);
  assert.equal(registry.has("combat-a"), true);

  time.set(149);
  const refreshed = createSession("combat-a", { updatedAt: 149 });
  refreshed.revision = 1;
  assert.equal(registry.upsert(refreshed).stored, true);
  assert.equal(registry.has("combat-a"), true);
  time.set(150);
  registry.prune();
  assert.equal(registry.has("combat-a"), false);
});

test("an already expired replicated snapshot is rejected immediately", () => {
  const registry = createCombatEndSessionRegistry({
    clock: () => 100,
    sessionTtlMs: 50
  });
  const result = registry.upsert(createSession("combat-expired", {
    expiresAt: 100
  }));

  assert.equal(result.accepted, false);
  assert.equal(result.stored, false);
  assert.equal(result.reason, "expired");
  assert.equal(registry.has("combat-expired"), false);
});

test("a replicated expiry remains immutable across newer revisions", () => {
  const time = createClock(100);
  const registry = createCombatEndSessionRegistry({
    clock: time.clock,
    sessionTtlMs: 1_000
  });
  registry.upsert(createSession("combat-a", { expiresAt: 150 }));
  time.set(140);
  registry.upsert(createSession("combat-a", {
    expiresAt: 10_000,
    revision: 1,
    updatedAt: 140
  }));
  assert.equal(registry.get("combat-a")?.expiresAt, 150);
  time.set(150);
  registry.prune();
  assert.equal(registry.has("combat-a"), false);
});

test("a replicated expiry cannot exceed the local retention deadline", () => {
  const time = createClock(100);
  const registry = createCombatEndSessionRegistry({
    clock: time.clock,
    sessionTtlMs: 50
  });

  registry.upsert(createSession("combat-a", { expiresAt: 10_000 }));
  assert.equal(registry.get("combat-a")?.expiresAt, 150);
  time.set(150);
  registry.prune();
  assert.equal(registry.has("combat-a"), false);
});

test("high-volume combat replication stays bounded and cannot postpone cleanup", () => {
  const time = createClock(100);
  const registry = createCombatEndSessionRegistry({
    clock: time.clock,
    maxSessions: 32,
    sessionTtlMs: 50
  });

  for (let index = 0; index < 2_000; index += 1) {
    registry.upsert(createSession(`combat-${index}`, {
      createdAt: index,
      updatedAt: index,
      operationPending: true
    }));
    assert.ok(registry.size <= 32);
  }

  const survivors = [...registry.values()].map((session) => structuredClone(session));
  time.set(149);
  for (let revision = 1; revision <= 100; revision += 1) {
    for (const session of survivors) {
      registry.upsert({
        ...session,
        revision,
        updatedAt: 2_000 + revision,
        expiresAt: 10_000
      });
    }
    assert.equal(registry.size, 32);
  }

  time.set(150);
  registry.prune();
  assert.equal(registry.size, 0);
  assert.equal(registry.getStats().sessions.overCapacity, 0);
});

test("session capacity eviction is deterministic across insertion orders", () => {
  const options = {
    clock: () => 100,
    maxSessions: 2,
    sessionTtlMs: 1000
  };
  const first = createCombatEndSessionRegistry(options);
  const second = createCombatEndSessionRegistry(options);
  const states = [
    createSession("combat-a", { createdAt: 10 }),
    createSession("combat-b", { createdAt: 10 }),
    createSession("combat-c", { createdAt: 20 })
  ];

  for (const state of states) first.upsert(structuredClone(state));
  for (const state of states.toReversed()) second.upsert(structuredClone(state));

  assert.deepEqual(sessionIds(first), ["combat-b", "combat-c"]);
  assert.deepEqual(sessionIds(second), ["combat-b", "combat-c"]);
  assert.equal(first.size, 2);
  assert.equal(second.size, 2);
});

test("updatedAt determines deterministic capacity priority when present", () => {
  const registry = createCombatEndSessionRegistry({
    clock: () => 100,
    maxSessions: 2,
    sessionTtlMs: 1000
  });

  registry.upsert(createSession("combat-a", { createdAt: 90, updatedAt: 10 }));
  registry.upsert(createSession("combat-b", { createdAt: 20, updatedAt: 30 }));
  const result = registry.upsert(createSession("combat-c", { createdAt: 40, updatedAt: 20 }));

  assert.deepEqual(sessionIds(registry), ["combat-b", "combat-c"]);
  assert.deepEqual(result.removedSessions, [{ id: "combat-a", reason: "capacity", revision: 0 }]);
});

test("dismissal tombstones have deterministic finite capacity", () => {
  const registry = createCombatEndSessionRegistry({
    clock: () => 100,
    maxDismissals: 2,
    dismissalTtlMs: 1000
  });

  registry.dismiss("combat-c", { at: 30 });
  registry.dismiss("combat-b", { at: 10 });
  const result = registry.dismiss("combat-a", { at: 10 });

  assert.equal(registry.dismissalSize, 2);
  assert.equal(registry.isDismissed("combat-a", { at: 100 }), false);
  assert.equal(registry.isDismissed("combat-b", { at: 100 }), true);
  assert.equal(registry.isDismissed("combat-c", { at: 100 }), true);
  assert.deepEqual(result.removedDismissals, [{ id: "combat-a", reason: "capacity" }]);
});

test("stats expose bounded live counts and cumulative removal reasons", () => {
  const time = createClock(100);
  const registry = createCombatEndSessionRegistry({
    clock: time.clock,
    sessionTtlMs: 10,
    dismissalTtlMs: 10,
    terminalTtlMs: 10,
    maxSessions: 2,
    maxDismissals: 2
  });

  registry.upsert(createSession("combat-a"));
  registry.upsert({ id: "combat-a", entries: [] });
  registry.upsert(createSession("combat-b"));
  registry.dismiss("combat-b");
  time.set(110);
  registry.prune();

  assert.deepEqual(registry.getStats(), {
    sessions: {
      count: 0,
      limit: 2,
      ttlMs: 10,
      indexedActors: 0,
      actorLinks: 0,
      pinned: 0,
      pinCount: 0,
      overCapacity: 0,
      upserts: 3,
      emptyStates: 1,
      removals: {
        empty: 1,
        expired: 1,
        capacity: 0,
        explicit: 0,
        clear: 0
      }
    },
    dismissals: {
      count: 0,
      limit: 2,
      ttlMs: 10,
      upserts: 1,
      removals: {
        expired: 1,
        capacity: 0,
        explicit: 0,
        terminal: 0,
        clear: 0
      }
    },
    terminals: {
      count: 0,
      limit: 128,
      ttlMs: 10,
      upserts: 1,
      removals: {
        expired: 1,
        capacity: 0,
        superseded: 0,
        clear: 0
      }
    }
  });
});

test("invalid limits fail fast instead of silently disabling bounds", () => {
  assert.throws(
    () => createCombatEndSessionRegistry({ maxSessions: 0 }),
    /maxSessions must be a positive safe integer/
  );
  assert.throws(
    () => createCombatEndSessionRegistry({ dismissalTtlMs: Infinity }),
    /dismissalTtlMs must be a positive safe integer/
  );
});
