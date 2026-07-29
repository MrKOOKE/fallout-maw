import assert from "node:assert/strict";
import test from "node:test";

import {
  createPeriodicDamageEffectSyncScheduler
} from "../src/canvas/periodic-damage-effect-sync-scheduler.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createManualTimers() {
  let nextId = 1;
  const pending = new Map();
  const cleared = [];

  return {
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      cleared.push(id);
      pending.delete(id);
    },
    fireNext() {
      const entry = pending.entries().next().value;
      assert.ok(entry, "expected a pending timer");
      const [id, timer] = entry;
      pending.delete(id);
      timer.callback();
      return timer.delay;
    },
    get pendingCount() {
      return pending.size;
    },
    get cleared() {
      return cleared;
    }
  };
}

function createScheduler(sync, timers, options = {}) {
  return createPeriodicDamageEffectSyncScheduler({
    sync,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    debounceMs: 25,
    ...options
  });
}

test("Actor and Scene requests coalesce by stable key into one debounced scope", async () => {
  const timers = createManualTimers();
  const scopes = [];
  const scheduler = createScheduler(scope => scopes.push(scope), timers);
  const originalActor = { uuid: "Actor.a", revision: 1 };
  const newestActor = { uuid: "Actor.a", revision: 2 };
  const otherActor = { uuid: "Actor.b" };
  const originalScene = { id: "scene-a", revision: 1 };
  const newestScene = { id: "scene-a", revision: 2 };

  assert.equal(scheduler.requestActors([originalActor, otherActor]), true);
  assert.equal(scheduler.request({ actors: newestActor, scenes: originalScene }), true);
  assert.equal(scheduler.requestScenes(newestScene), true);
  assert.equal(scheduler.pendingActorCount, 2);
  assert.equal(scheduler.pendingSceneCount, 1);
  assert.equal(timers.pendingCount, 1);

  assert.equal(timers.fireNext(), 25);
  await scheduler.wait();

  assert.deepEqual(scopes, [{
    actors: [newestActor, otherActor],
    scenes: [newestScene]
  }]);
  assert.equal(scheduler.busy, false);
});

test("a request made during a running pass executes afterward without overlap", async () => {
  const timers = createManualTimers();
  const firstGate = deferred();
  const secondGate = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const calls = [];
  let active = 0;
  let maximumActive = 0;

  const scheduler = createScheduler(async scope => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls.push(scope);
    if (scope.actors[0]?.uuid === "Actor.first") {
      firstStarted.resolve();
      await firstGate.promise;
    } else {
      secondStarted.resolve();
      await secondGate.promise;
    }
    active -= 1;
  }, timers);

  scheduler.requestActors({ uuid: "Actor.first" });
  timers.fireNext();
  await firstStarted.promise;

  scheduler.requestActors({ uuid: "Actor.second" });
  assert.equal(timers.pendingCount, 1);
  timers.fireNext();
  assert.equal(calls.length, 1);

  firstGate.resolve();
  await secondStarted.promise;
  assert.equal(maximumActive, 1);
  assert.deepEqual(calls.map(scope => scope.actors[0].uuid), [
    "Actor.first",
    "Actor.second"
  ]);

  secondGate.resolve();
  await scheduler.wait();
  assert.equal(scheduler.busy, false);
});

test("a failed sync and a failed error reporter do not poison later passes", async () => {
  const timers = createManualTimers();
  const calls = [];
  const reported = [];
  const scheduler = createScheduler(async scope => {
    const actorUuid = scope.actors[0].uuid;
    calls.push(actorUuid);
    if (actorUuid === "Actor.failed") throw new Error("expected sync failure");
  }, timers, {
    onError(error, scope) {
      reported.push([error.message, scope.actors[0].uuid]);
      throw new Error("expected reporter failure");
    }
  });

  scheduler.requestActors({ uuid: "Actor.failed" });
  timers.fireNext();
  await scheduler.wait();
  scheduler.requestActors({ uuid: "Actor.recovered" });
  timers.fireNext();
  await scheduler.wait();

  assert.deepEqual(calls, ["Actor.failed", "Actor.recovered"]);
  assert.deepEqual(reported, [[
    "expected sync failure",
    "Actor.failed"
  ]]);
  assert.equal(scheduler.busy, false);
});

test("flushNow bypasses the debounce timer and waits for the pass", async () => {
  const timers = createManualTimers();
  const gate = deferred();
  let started = false;
  const scheduler = createScheduler(async () => {
    started = true;
    await gate.promise;
  }, timers);

  scheduler.requestScenes({ uuid: "Scene.a" });
  assert.equal(timers.pendingCount, 1);
  const flushed = scheduler.flushNow();
  await Promise.resolve();

  assert.equal(started, true);
  assert.equal(timers.pendingCount, 0);
  assert.deepEqual(timers.cleared, [1]);

  let settled = false;
  void flushed.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  gate.resolve();
  await flushed;
  assert.equal(scheduler.busy, false);
});

test("wait includes a successor accepted while the current pass is running", async () => {
  const timers = createManualTimers();
  const firstGate = deferred();
  const secondGate = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const scheduler = createScheduler(async scope => {
    if (scope.actors[0].uuid === "Actor.first") {
      firstStarted.resolve();
      await firstGate.promise;
    } else {
      secondStarted.resolve();
      await secondGate.promise;
    }
  }, timers);

  scheduler.requestActors({ uuid: "Actor.first" });
  timers.fireNext();
  await firstStarted.promise;
  let waitSettled = false;
  const waiting = scheduler.wait().then(() => {
    waitSettled = true;
  });

  scheduler.requestActors({ uuid: "Actor.second" });
  timers.fireNext();
  firstGate.resolve();
  await secondStarted.promise;
  assert.equal(waitSettled, false);

  secondGate.resolve();
  await waiting;
  assert.equal(waitSettled, true);
});

test("close discards pending successors but lets an in-flight sync finish", async () => {
  const timers = createManualTimers();
  const gate = deferred();
  const started = deferred();
  const calls = [];
  const scheduler = createScheduler(async scope => {
    calls.push(scope.actors[0].uuid);
    started.resolve();
    await gate.promise;
  }, timers);

  scheduler.requestActors({ uuid: "Actor.running" });
  timers.fireNext();
  await started.promise;
  scheduler.requestActors({ uuid: "Actor.cancelled" });
  assert.equal(timers.pendingCount, 1);

  let closed = false;
  const closing = scheduler.close().then(() => {
    closed = true;
  });
  assert.equal(scheduler.closed, true);
  assert.equal(scheduler.pendingActorCount, 0);
  assert.equal(timers.pendingCount, 0);
  assert.equal(scheduler.requestActors({ uuid: "Actor.ignored" }), false);
  await Promise.resolve();
  assert.equal(closed, false);

  gate.resolve();
  await closing;
  assert.deepEqual(calls, ["Actor.running"]);
  assert.equal(scheduler.busy, false);
});

test("empty requests are ignored and malformed targets fail immediately", () => {
  const timers = createManualTimers();
  const scheduler = createScheduler(() => {}, timers);

  assert.equal(scheduler.request(), false);
  assert.equal(scheduler.requestActors([null, undefined]), false);
  assert.equal(timers.pendingCount, 0);
  assert.throws(
    () => scheduler.request({
      actors: { uuid: "Actor.must-not-be-stranded" },
      scenes: { name: "missing stable key" }
    }),
    /stable uuid or id/
  );
  assert.equal(scheduler.pendingActorCount, 0);
  assert.equal(timers.pendingCount, 0);
});
