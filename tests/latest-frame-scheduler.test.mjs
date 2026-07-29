import assert from "node:assert/strict";
import test from "node:test";

import { createLatestFrameScheduler } from "../src/canvas/latest-frame-scheduler.mjs";

function createFakeFrames() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    requestFrame(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      callbacks.delete(id);
    },
    runNext(time = 0) {
      const [id, callback] = callbacks.entries().next().value ?? [];
      if (!callback) return false;
      callbacks.delete(id);
      callback(time);
      return true;
    },
    get pendingCount() {
      return callbacks.size;
    }
  };
}

test("latest-frame scheduler coalesces repeated requests and keeps the newest value", () => {
  const frames = createFakeFrames();
  const received = [];
  const scheduler = createLatestFrameScheduler(
    (value, time) => received.push({ value, time }),
    frames
  );

  for (let index = 0; index < 1000; index += 1) scheduler.request(index);

  assert.equal(frames.pendingCount, 1);
  assert.equal(scheduler.pending, true);
  frames.runNext(42);
  assert.deepEqual(received, [{ value: 999, time: 42 }]);
  assert.equal(scheduler.pending, false);
});

test("flush commits the newest request once and cancels its queued frame", () => {
  const frames = createFakeFrames();
  const received = [];
  const scheduler = createLatestFrameScheduler(
    value => received.push(value),
    frames
  );

  scheduler.request("old");
  scheduler.request("latest");
  assert.equal(scheduler.flush(17), true);
  assert.deepEqual(received, ["latest"]);
  assert.equal(frames.pendingCount, 0);
  assert.equal(frames.runNext(18), false);
});

test("destroy cancels pending work and permanently ignores later requests", () => {
  const frames = createFakeFrames();
  let calls = 0;
  const scheduler = createLatestFrameScheduler(
    () => { calls += 1; },
    frames
  );

  scheduler.request();
  scheduler.destroy();
  assert.equal(frames.pendingCount, 0);
  assert.equal(scheduler.request(), false);
  assert.equal(scheduler.flush(), false);
  assert.equal(calls, 0);
});

test("a request made by the callback is scheduled for the following frame", () => {
  const frames = createFakeFrames();
  const received = [];
  let scheduler;
  scheduler = createLatestFrameScheduler(value => {
    received.push(value);
    if (value === "first") scheduler.request("second");
  }, frames);

  scheduler.request("first");
  frames.runNext(1);
  assert.deepEqual(received, ["first"]);
  assert.equal(frames.pendingCount, 1);
  frames.runNext(2);
  assert.deepEqual(received, ["first", "second"]);
});
