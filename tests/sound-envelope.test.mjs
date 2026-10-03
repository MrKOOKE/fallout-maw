import test from "node:test";
import assert from "node:assert/strict";
import { transitionSoundGain } from "../src/constructs/sound-envelope.mjs";

test("both an interrupted ramp and a settled volume start the next ramp at the current audio time", () => {
  const calls = [], gain = {
    value: 0.37,
    cancelAndHoldAtTime: t => calls.push(["hold", t]),
    setValueAtTime: (v, t) => calls.push(["anchor", v, t]),
    linearRampToValueAtTime: (v, t) => calls.push(["ramp", v, t])
  };
  transitionSoundGain({ gain, context: { currentTime: 12 } }, 0, 300);
  assert.deepEqual(calls, [["hold", 12], ["anchor", 0.37, 12], ["ramp", 0, 12.3]]);
});

test("the fallback captures the current gain before cancellation can reset it", () => {
  const calls = [], gain = {
    value: 0.12,
    cancelScheduledValues: () => { gain.value = 0.9; },
    setValueAtTime: (v, t) => calls.push([v, t]),
    linearRampToValueAtTime: (v, t) => calls.push([v, t])
  };
  transitionSoundGain({ gain, context: { currentTime: 4 } }, 0.5, 180);
  assert.deepEqual(calls, [[0.12, 4], [0.5, 4.18]]);
});
