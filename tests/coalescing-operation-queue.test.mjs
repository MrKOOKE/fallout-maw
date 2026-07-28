import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoalescingOperationQueue
} from "../src/combat/coalescing-operation-queue.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("same-key operations share one pending execution", async () => {
  const gate = deferred();
  const queue = createCoalescingOperationQueue();
  let calls = 0;
  const first = queue.run("turn:1", async () => {
    calls += 1;
    await gate.promise;
    return 42;
  });
  const second = queue.run("turn:1", () => {
    calls += 1;
    return 7;
  });

  assert.strictEqual(second, first);
  assert.equal(queue.pendingCount, 1);
  gate.resolve();
  assert.equal(await second, 42);
  assert.equal(calls, 1);
  assert.equal(queue.busy, false);
});

test("different keys execute serially in submission order", async () => {
  const gate = deferred();
  const queue = createCoalescingOperationQueue();
  const order = [];
  const first = queue.run("first", async () => {
    order.push("first:start");
    await gate.promise;
    order.push("first:end");
  });
  const second = queue.run("second", async () => {
    order.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("a rejected operation does not poison later work", async () => {
  const reported = [];
  const queue = createCoalescingOperationQueue({
    onError: error => reported.push(error.message)
  });
  const failed = queue.run("failed", async () => {
    throw new Error("expected");
  });
  const recovered = queue.run("recovered", async () => "ok");

  await assert.rejects(failed, /expected/);
  assert.equal(await recovered, "ok");
  await queue.wait();
  assert.deepEqual(reported, ["expected"]);
});

test("wait resolves only after the current queue tail", async () => {
  const gate = deferred();
  const queue = createCoalescingOperationQueue();
  let waited = false;
  queue.run(Symbol("lifecycle"), () => gate.promise);
  const waiting = queue.wait().then(() => {
    waited = true;
  });

  await Promise.resolve();
  assert.equal(waited, false);
  gate.resolve();
  await waiting;
  assert.equal(waited, true);
});

test("wait includes work appended while it is awaiting an older tail", async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  const queue = createCoalescingOperationQueue();
  queue.run("first", () => firstGate.promise);
  let waited = false;
  const waiting = queue.wait().then(() => {
    waited = true;
  });

  await Promise.resolve();
  queue.run("second", () => secondGate.promise);
  firstGate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(waited, false);

  secondGate.resolve();
  await waiting;
  assert.equal(waited, true);
});
