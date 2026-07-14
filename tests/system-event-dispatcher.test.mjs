import assert from "node:assert/strict";
import test from "node:test";

import { createSystemEventDispatcher } from "../src/events/dispatcher.mjs";

const EVENT = "fallout-maw.test.event";
const CHILD_EVENT = "fallout-maw.test.child";

function descriptor(key, {
  phase = "pre",
  capabilities = ["observe", "patch", "cancelCurrent", "cancelRemaining"],
  allowedPatchPaths = ["/data/value", "/data/items/*"],
  selectable = true
} = {}) {
  return Object.freeze({
    key,
    catalogVersion: 1,
    group: "test",
    phase,
    capabilities: Object.freeze(capabilities),
    allowedPatchPaths: Object.freeze(allowedPatchPaths),
    selectable
  });
}

function createHarness({
  descriptors = [descriptor(EVENT), descriptor(CHILD_EVENT)],
  limits = {},
  runtime = {}
} = {}) {
  const byKey = new Map(descriptors.map(entry => [entry.key, entry]));
  const selectable = descriptors.filter(entry => entry.selectable);
  const warnings = [];
  const errors = [];
  let id = 0;
  let now = 1_000;
  const gmRuntime = {
    getCurrentUserId: () => "gm",
    getActiveGMId: () => "gm",
    isActiveGM: () => true,
    getWorldTime: () => 42,
    randomId: () => `id-${++id}`,
    now: () => ++now,
    logger: {
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args)
    },
    ...runtime
  };
  const dispatcher = createSystemEventDispatcher({
    catalog: {
      getDescriptor: key => byKey.get(key) ?? null,
      getSelectable: () => Object.freeze(selectable)
    },
    runtime: gmRuntime,
    limits
  });
  return { dispatcher, warnings, errors };
}

test("builds a frozen JSON-safe canonical envelope with reserved top-level fields", async () => {
  const { dispatcher } = createHarness();
  let observed;
  dispatcher.registerSystemEventObserver({
    id: "capture",
    eventKeys: EVENT,
    observe: ({ event }) => {
      observed = event;
      assert.equal(Object.isFrozen(event), true);
      assert.equal(Object.isFrozen(event.data), true);
    }
  });

  const result = await dispatcher.dispatchSystemEvent(EVENT, {
    data: { value: 1 },
    before: { value: 0 },
    after: { value: 1 },
    delta: { value: 1 },
    outcome: { status: "ok" },
    reason: "test",
    source: { actorUuid: "Actor.source", tokenUuid: "Scene.scene.Token.source" },
    related: [{ itemUuid: "Actor.source.Item.item" }]
  }, {
    operationId: "canonical",
    occurrenceKey: "canonical:event",
    sceneUuid: "Scene.scene",
    combatUuid: "Combat.combat",
    participants: {
      target: { actorUuid: "Actor.target", tokenUuid: "Scene.scene.Token.target" }
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { value: 1 });
  assert.deepEqual(observed.before, { value: 0 });
  assert.deepEqual(observed.after, { value: 1 });
  assert.deepEqual(observed.delta, { value: 1 });
  assert.deepEqual(observed.outcome, { status: "ok" });
  assert.equal(observed.reason, "test");
  assert.deepEqual(observed.source, observed.participants.source);
  assert.deepEqual(observed.target, observed.participants.target);
  assert.deepEqual(observed.related, observed.participants.related);
  assert.equal(observed.sceneUuid, "Scene.scene");
  assert.equal(observed.combatUuid, "Combat.combat");
  assert.equal(observed.occurredAt.worldTime, 42);
  assert.equal(dispatcher.getSelectableSystemEvents().length, 2);
});

test("orders interceptors before observers and applies only allowed JSON Patch paths", async () => {
  const { dispatcher } = createHarness();
  const calls = [];

  dispatcher.registerSystemEventInterceptor({
    id: "late",
    eventKeys: EVENT,
    priority: 20,
    intercept: ({ data }) => {
      calls.push(`late:${data.value}`);
      return {
        patches: [
          { op: "replace", path: "/data/value", value: 3 },
          { op: "replace", path: "/data/denied", value: 99 }
        ],
        cancel: { scope: "remaining", reason: "late" }
      };
    }
  });
  dispatcher.registerSystemEventInterceptor({
    id: "early",
    eventKeys: EVENT,
    priority: 10,
    intercept: ({ data }) => {
      calls.push(`early:${data.value}`);
      return {
        patches: [{ op: "replace", path: "/data/value", value: 2 }],
        cancel: { scope: "current", reason: "early" }
      };
    }
  });
  dispatcher.registerSystemEventObserver({
    id: "observer",
    eventKeys: EVENT,
    priority: -100,
    observe: ({ data, control }) => calls.push(`observer:${data.value}:${control.current}:${control.remaining}`)
  });

  const result = await dispatcher.dispatchSystemEvent(EVENT, { value: 1, denied: 0 }, {
    operationId: "patch-order",
    occurrenceKey: "patch-order:event"
  });

  assert.deepEqual(calls, ["early:1", "late:2", "observer:3:true:true"]);
  assert.deepEqual(result.data, { value: 3, denied: 0 });
  assert.equal(result.control.current, true);
  assert.equal(result.control.remaining, true);
  assert.equal(result.appliedPatches.length, 2);
  assert.equal(result.errors.some(error => error.code === "patchRejected"), true);
});

test("enforces cancellation capabilities per scope and keeps cancellation monotonic", async () => {
  const restricted = descriptor(EVENT, {
    capabilities: ["observe", "cancelCurrent"],
    allowedPatchPaths: []
  });
  const { dispatcher } = createHarness({ descriptors: [restricted] });
  dispatcher.registerSystemEventInterceptor({
    id: "current",
    eventKeys: EVENT,
    intercept: () => ({ cancel: { scope: "current", reason: "allowed" } })
  });
  dispatcher.registerSystemEventInterceptor({
    id: "remaining",
    eventKeys: EVENT,
    intercept: () => ({ cancel: { scope: "remaining", reason: "denied" } })
  });
  dispatcher.registerSystemEventInterceptor({
    id: "noop",
    eventKeys: EVENT,
    intercept: () => ({ cancel: null })
  });

  const result = await dispatcher.dispatchSystemEvent(EVENT, {}, {
    operationId: "cancel-capabilities",
    occurrenceKey: "cancel-capabilities:event"
  });

  assert.equal(result.control.current, true);
  assert.equal(result.control.remaining, false);
  assert.equal(result.control.reasons.length, 1);
  assert.equal(result.errors.some(error => error.code === "cancelUnsupported"), true);
});

test("deduplicates concurrent and completed occurrences for the full root lifetime", async () => {
  const { dispatcher } = createHarness({ limits: { completedCacheTtlMs: 1 } });
  let executions = 0;
  let release;
  const barrier = new Promise(resolve => {
    release = resolve;
  });
  dispatcher.registerSystemEventInterceptor({
    id: "slow",
    eventKeys: EVENT,
    intercept: async () => {
      executions += 1;
      await barrier;
    }
  });

  await dispatcher.withSystemEventRoot({ kind: "test", operationId: "dedupe" }, async scope => {
    const first = scope.emit(EVENT, { value: 1 }, { occurrenceKey: "same" });
    const second = scope.emit(EVENT, { value: 1 }, { occurrenceKey: "same" });
    release();
    const [left, right] = await Promise.all([first, second]);
    await new Promise(resolve => setTimeout(resolve, 5));
    const cached = await scope.emit(EVENT, { value: 999 }, { occurrenceKey: "same" });
    assert.equal(left.event.eventId, right.event.eventId);
    assert.equal(cached.event.eventId, left.event.eventId);
    assert.deepEqual(cached.data, { value: 1 });
  });

  assert.equal(executions, 1);
});

test("allows a handler with a finer external recursion guard to opt out of the coarse guard", async () => {
  const { dispatcher } = createHarness();
  let executions = 0;
  dispatcher.registerSystemEventInterceptor({
    id: "fine-grained",
    eventKeys: EVENT,
    guardRecursion: false,
    intercept: async ({ data, scope }) => {
      executions += 1;
      if (data.generation === 0) {
        await scope.emit(EVENT, { generation: 1 }, { occurrenceKey: "fine-child" });
      }
    }
  });

  await dispatcher.dispatchSystemEvent(EVENT, { generation: 0 }, {
    operationId: "fine-recursion",
    occurrenceKey: "fine-parent"
  });
  assert.equal(executions, 2);
});

test("nested roots preserve rootId, parent lineage and finalize once", async () => {
  const { dispatcher } = createHarness();
  const events = [];
  const finalized = [];
  dispatcher.registerSystemEventRootFinalizer({
    id: "capture-finalize",
    finalize: data => finalized.push(data)
  });
  dispatcher.registerSystemEventObserver({
    id: "capture-events",
    eventKeys: [EVENT, CHILD_EVENT],
    observe: ({ event }) => events.push(event)
  });
  dispatcher.registerSystemEventInterceptor({
    id: "nested-workflow",
    eventKeys: EVENT,
    intercept: async ({ scope }) => dispatcher.withSystemEventRoot({
      kind: "child",
      operationId: "nested-child",
      chainRef: scope.chainRef
    }, childScope => childScope.emit(CHILD_EVENT, { value: 2 }, { occurrenceKey: "child" }))
  });

  await dispatcher.withSystemEventRoot({ kind: "parent", operationId: "nested-parent" }, scope => (
    scope.emit(EVENT, { value: 1 }, { occurrenceKey: "parent" })
  ));

  const parent = events.find(event => event.key === EVENT);
  const child = events.find(event => event.key === CHILD_EVENT);
  assert.ok(parent);
  assert.ok(child);
  assert.equal(child.rootId, parent.rootId);
  assert.equal(child.parentEventId, parent.eventId);
  assert.equal(child.depth, 1);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].rootId, parent.rootId);
  assert.equal(finalized[0].eventCount, 2);
});

test("a lease acquired before owner closure can finish post-hook events before finalization", async () => {
  const { dispatcher } = createHarness();
  let releaseChild;
  let childReady;
  let childResult;
  let finalized = 0;
  const barrier = new Promise(resolve => {
    releaseChild = resolve;
  });
  const ready = new Promise(resolve => {
    childReady = resolve;
  });
  dispatcher.registerSystemEventRootFinalizer({ id: "leased-finalizer", finalize: () => { finalized += 1; } });

  const ownerResult = dispatcher.withSystemEventRoot({ kind: "owner", operationId: "leased-post-hook" }, async ownerScope => {
    void dispatcher.withSystemEventRoot({
      kind: "postHook",
      operationId: "leased-post-hook-child",
      chainRef: ownerScope.chainRef
    }, async childScope => {
      childReady();
      await barrier;
      childResult = await childScope.emit(CHILD_EVENT, { value: 2 }, { occurrenceKey: "leased-child" });
    });
    await ready;
    return "owner-complete";
  });

  await ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finalized, 0);
  releaseChild();
  assert.equal(await ownerResult, "owner-complete");
  assert.equal(childResult?.ok, true);
  assert.equal(finalized, 1);
});

test("recursion guard skips the same handler and event in a descendant branch", async () => {
  const { dispatcher } = createHarness();
  let executions = 0;
  let childResult;
  dispatcher.registerSystemEventInterceptor({
    id: "recursive",
    eventKeys: EVENT,
    intercept: async ({ scope }) => {
      executions += 1;
      childResult = await scope.emit(EVENT, { value: 2 }, { occurrenceKey: "recursive-child" });
    }
  });

  await dispatcher.dispatchSystemEvent(EVENT, { value: 1 }, {
    operationId: "recursive",
    occurrenceKey: "recursive-parent"
  });

  assert.equal(executions, 1);
  assert.equal(childResult.ok, true);
  assert.deepEqual(childResult.skippedHandlers, [{ id: "recursive", kind: "interceptor", reason: "recursion" }]);
});

test("enforces event and reaction budgets without blocking the root workflow", async () => {
  const { dispatcher, warnings } = createHarness({
    limits: { maxEventsPerRoot: 2, maxReactionsPerRoot: 2 }
  });
  const reactionBudget = [];
  dispatcher.registerSystemEventObserver({
    id: "budget",
    eventKeys: EVENT,
    observe: ({ scope }) => {
      reactionBudget.push(scope.consumeReactionBudget());
      reactionBudget.push(scope.consumeReactionBudget());
      reactionBudget.push(scope.consumeReactionBudget());
    }
  });

  await dispatcher.withSystemEventRoot({ kind: "budget", operationId: "budget" }, async scope => {
    assert.equal((await scope.emit(EVENT, {}, { occurrenceKey: "one" })).ok, true);
    assert.equal((await scope.emit(EVENT, {}, { occurrenceKey: "two" })).ok, true);
    const limited = await scope.emit(EVENT, {}, { occurrenceKey: "three" });
    assert.equal(limited.ok, false);
    assert.equal(limited.reason, "eventLimit");
  });

  assert.deepEqual(reactionBudget, [true, true, false, false, false, false]);
  assert.equal(warnings.length, 1);
});

test("exceeding the depth limit disables later reactions for the whole root", async () => {
  const { dispatcher, warnings } = createHarness({ limits: { maxDepth: 1 } });
  let limited;
  let reactionAllowedAfterLimit = true;
  dispatcher.registerSystemEventInterceptor({
    id: "depth-parent",
    eventKeys: EVENT,
    intercept: async ({ scope }) => {
      await scope.emit(CHILD_EVENT, {}, { occurrenceKey: "depth-child" });
      reactionAllowedAfterLimit = scope.consumeReactionBudget();
    }
  });
  dispatcher.registerSystemEventInterceptor({
    id: "depth-child",
    eventKeys: CHILD_EVENT,
    intercept: async ({ scope }) => {
      limited = await scope.emit(EVENT, {}, { occurrenceKey: "depth-grandchild" });
    }
  });

  const result = await dispatcher.dispatchSystemEvent(EVENT, {}, {
    operationId: "depth-disables-reactions",
    occurrenceKey: "depth-parent"
  });
  assert.equal(result.ok, true);
  assert.equal(limited?.ok, false);
  assert.equal(limited?.reason, "depthLimit");
  assert.equal(reactionAllowedAfterLimit, false);
  assert.equal(warnings.length, 1);
});

test("closes roots in finally and treats non-JSON payloads as fail-open", async () => {
  const { dispatcher } = createHarness();
  let finalized = 0;
  let handled = 0;
  dispatcher.registerSystemEventRootFinalizer({ id: "finally", finalize: () => { finalized += 1; } });
  dispatcher.registerSystemEventObserver({ id: "handled", eventKeys: EVENT, observe: () => { handled += 1; } });

  const invalid = await dispatcher.dispatchSystemEvent(EVENT, { date: new Date() }, {
    operationId: "invalid-json",
    occurrenceKey: "invalid-json:event"
  });
  assert.equal(invalid.ok, false);
  assert.equal(handled, 0);

  await assert.rejects(
    dispatcher.withSystemEventRoot({ kind: "throw", operationId: "throw" }, async () => {
      throw new Error("operation failed");
    }),
    /operation failed/
  );
  assert.equal(finalized, 2);
});

test("rejects Documents, Rolls, Map, Set, functions and cycles at the dispatcher boundary", async () => {
  class FakeDocument {}
  class FakeRoll {}
  const cyclic = { value: 1 };
  cyclic.self = cyclic;
  const payloads = [
    { value: new FakeDocument() },
    { value: new FakeRoll() },
    { value: new Map([["key", 1]]) },
    { value: new Set([1]) },
    { value: () => 1 },
    { value: cyclic }
  ];
  const { dispatcher } = createHarness();
  let observed = 0;
  dispatcher.registerSystemEventObserver({ id: "json-boundary", eventKeys: EVENT, observe: () => { observed += 1; } });

  for (const [index, payload] of payloads.entries()) {
    const outcome = await dispatcher.dispatchSystemEvent(EVENT, payload, {
      operationId: `json-boundary-${index}`,
      occurrenceKey: `json-boundary-${index}:event`
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "invalidPayload");
    assert.equal(outcome.data, null);
  }
  assert.equal(observed, 0);
});

test("continues detached when no active GM is available", async () => {
  const { dispatcher, warnings } = createHarness({
    runtime: {
      getCurrentUserId: () => "player",
      getActiveGMId: () => "",
      isActiveGM: () => false,
      onSocket: null,
      emitSocket: null
    }
  });
  let operationRan = false;
  const outcome = await dispatcher.withSystemEventRoot({ kind: "offline", operationId: "offline" }, async scope => {
    operationRan = true;
    assert.equal(scope.active, false);
    return scope.emit(EVENT, { value: 1 });
  });
  assert.equal(operationRan, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "noAuthority");
  assert.equal(warnings.length, 1);
});

test("does not accept a stale isActiveGM flag when activeGM points at another user", async () => {
  const { dispatcher, warnings } = createHarness({
    runtime: {
      getCurrentUserId: () => "stale-gm",
      getActiveGMId: () => "active-gm",
      isActiveGM: () => true,
      onSocket: () => {
        throw new Error("no socket listener in this harness");
      }
    }
  });
  let observed = 0;
  dispatcher.registerSystemEventObserver({ id: "must-not-run", eventKeys: EVENT, observe: () => { observed += 1; } });

  const outcome = await dispatcher.dispatchSystemEvent(EVENT, { value: 1 }, {
    operationId: "stale-active-gm",
    occurrenceKey: "stale-active-gm:event"
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "socketUnavailable");
  assert.equal(observed, 0);
  assert.equal(warnings.length >= 1, true);
});

test("routes remote dispatch through the active-GM socket authority", async () => {
  const callbacks = new Map();
  const onSocket = (channel, callback) => {
    const entries = callbacks.get(channel) ?? [];
    entries.push(callback);
    callbacks.set(channel, entries);
  };
  const emitSocket = (channel, message) => {
    for (const callback of callbacks.get(channel) ?? []) queueMicrotask(() => callback(structuredClone(message)));
  };
  const descriptors = [descriptor(EVENT)];
  const sharedCatalog = {
    getDescriptor: key => descriptors.find(entry => entry.key === key) ?? null,
    getSelectable: () => descriptors
  };
  let id = 0;
  const common = {
    getActiveGMId: () => "gm",
    getWorldTime: () => 7,
    randomId: () => `socket-${++id}`,
    onSocket,
    emitSocket,
    requestTimeoutMs: 1_000,
    logger: { warn: () => undefined, error: () => undefined }
  };
  const gm = createSystemEventDispatcher({
    catalog: sharedCatalog,
    runtime: { ...common, getCurrentUserId: () => "gm", isActiveGM: () => true },
    limits: { requestTimeoutMs: 1_000 }
  });
  const player = createSystemEventDispatcher({
    catalog: sharedCatalog,
    runtime: { ...common, getCurrentUserId: () => "player", isActiveGM: () => false },
    limits: { requestTimeoutMs: 1_000 }
  });
  let executions = 0;
  gm.registerSystemEventObserver({ id: "gm-handler", eventKeys: EVENT, observe: () => { executions += 1; } });
  gm.registerSystemEventDispatcherSocket();
  player.registerSystemEventDispatcherSocket();

  const result = await player.dispatchSystemEvent(EVENT, { value: 5 }, {
    operationId: "remote",
    occurrenceKey: "remote:event"
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.authorityUserId, "gm");
  assert.equal(result.event.requesterUserId, "player");
  assert.equal(executions, 1);
});

test("active GM can acquire a player-owned root lease while another remote user cannot", async () => {
  const callbacks = new Map();
  const onSocket = (channel, callback) => {
    const entries = callbacks.get(channel) ?? [];
    entries.push(callback);
    callbacks.set(channel, entries);
  };
  const emitSocket = (channel, message) => {
    for (const callback of callbacks.get(channel) ?? []) queueMicrotask(() => callback(structuredClone(message)));
  };
  const descriptors = [descriptor(EVENT), descriptor(CHILD_EVENT)];
  const catalog = {
    getDescriptor: key => descriptors.find(entry => entry.key === key) ?? null,
    getSelectable: () => descriptors
  };
  let id = 0;
  const common = {
    getActiveGMId: () => "gm",
    getWorldTime: () => 7,
    randomId: () => `lease-socket-${++id}`,
    onSocket,
    emitSocket,
    logger: { warn: () => undefined, error: () => undefined }
  };
  const makeDispatcher = userId => createSystemEventDispatcher({
    catalog,
    runtime: {
      ...common,
      getCurrentUserId: () => userId,
      isActiveGM: () => userId === "gm"
    },
    limits: { requestTimeoutMs: 1_000 }
  });
  const gm = makeDispatcher("gm");
  const owner = makeDispatcher("owner");
  const attacker = makeDispatcher("attacker");
  const observed = [];
  let finalizations = 0;
  gm.registerSystemEventObserver({
    id: "lease-events",
    eventKeys: [EVENT, CHILD_EVENT],
    observe: ({ event }) => observed.push(event)
  });
  gm.registerSystemEventRootFinalizer({ id: "lease-finalizer", finalize: () => { finalizations += 1; } });
  gm.registerSystemEventDispatcherSocket();
  owner.registerSystemEventDispatcherSocket();
  attacker.registerSystemEventDispatcherSocket();

  await owner.withSystemEventRoot({ kind: "owner", operationId: "player-owned-root" }, async ownerScope => {
    const gmNested = await gm.withSystemEventRoot({
      kind: "damageHub",
      operationId: "gm-nested",
      chainRef: ownerScope.chainRef
    }, gmScope => gmScope.emit(CHILD_EVENT, { value: 2 }, { occurrenceKey: "gm-child" }));
    assert.equal(gmNested.ok, true);
    assert.equal(gmNested.event.rootId, ownerScope.rootId);

    const attackerAttempt = await attacker.withSystemEventRoot({
      kind: "foreign",
      operationId: "attacker-nested",
      chainRef: ownerScope.chainRef
    }, async attackerScope => ({
      active: attackerScope.active,
      outcome: await attackerScope.emit(CHILD_EVENT, { value: 999 }, { occurrenceKey: "attacker-child" })
    }));
    assert.equal(attackerAttempt.active, false);
    assert.equal(attackerAttempt.outcome.ok, false);
    assert.equal(attackerAttempt.outcome.reason, "leaseOwnerMismatch");

    const ownerEvent = await ownerScope.emit(EVENT, { value: 3 }, { occurrenceKey: "owner-event" });
    assert.equal(ownerEvent.ok, true);
    assert.equal(ownerEvent.event.rootId, ownerScope.rootId);
  });

  assert.deepEqual(observed.map(event => event.key), [CHILD_EVENT, EVENT]);
  assert.equal(finalizations, 1);
});

test("active systemEventOperationId is inherited from nested root meta.data", async () => {
  const harness = createHarness();
  const dispatcher = createSystemEventDispatcher({
    catalog: harness.catalog,
    limits: harness.limits,
    runtime: harness.runtime
  });

  assert.equal(dispatcher.getActiveSystemEventOperationId(), "");

  await dispatcher.withSystemEventRoot({
    kind: "damageHub",
    operationId: "damage:attack-1",
    data: { systemEventOperationId: "attack-1" }
  }, async () => {
    assert.equal(dispatcher.getActiveSystemEventOperationId(), "attack-1");
    await dispatcher.withSystemEventRoot({
      kind: "skillCheck",
      operationId: "skill:nested"
    }, async () => {
      assert.equal(dispatcher.getActiveSystemEventOperationId(), "attack-1");
    });
  });

  assert.equal(dispatcher.getActiveSystemEventOperationId(), "");
});
