import test from "node:test";
import assert from "node:assert/strict";
import { advanceConstructRotationRate, createConstructRotationRateState, getConstructRotationTravelDegrees } from "../src/utils/construct-rotation-rate.mjs";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);

test("packet frequency cannot add an allowance to every turn update", () => {
  let state = createConstructRotationRateState(0, 0);
  for (let timeMs = 0; timeMs <= 100; timeMs++) {
    state = advanceConstructRotationRate(state, 170, 90, timeMs).state;
  }
  near(state.rotation, 90 * (0.15 + 0.1));
  assert.equal(advanceConstructRotationRate(state, 170, 90, 100).reached, false);
});

test("hours of idle time do not bank a full instant turn", () => {
  const initial = advanceConstructRotationRate(createConstructRotationRateState(0, 0), 170, 90, 0).state;
  const delayed = advanceConstructRotationRate(initial, 170, 90, 3_600_000);
  near(delayed.state.rotation, 27);
  assert.equal(delayed.reached, false);
});

test("a final confirmation can use elapsed time between the last two network updates", () => {
  let state = advanceConstructRotationRate(createConstructRotationRateState(0, 0), 9, 90, 0).state;
  state = advanceConstructRotationRate(state, 18, 90, 100).state;
  const confirmed = advanceConstructRotationRate(state, 22.5, 90, 150);
  assert.equal(confirmed.reached, true);
  near(confirmed.state.rotation, 22.5);
});

test("a bounded turret pays for the legal arc through its sector, including the rear stop", () => {
  const sector = { minRotation: -160, maxRotation: 160, anchorRotation: 0 };
  near(getConstructRotationTravelDegrees(150, -150, sector), 300);
  const advanced = advanceConstructRotationRate(createConstructRotationRateState(150, 0), -150, 90, 0, sector);
  near(advanced.state.rotation, 136.5);
  assert.equal(advanced.reached, false);
});
