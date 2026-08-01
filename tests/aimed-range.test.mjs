import assert from "node:assert/strict";
import test from "node:test";

import { getAimedRangeSelectionState } from "../src/utils/aimed-range.mjs";

const EFFECTIVE_RANGE = Object.freeze({ min: 5, max: 10 });

test("aimed effective-range boundaries are inclusive", () => {
  for (const attackDistanceMeters of [5, 10]) {
    const state = getAimedRangeSelectionState({
      attackDistanceMeters,
      effectiveRange: EFFECTIVE_RANGE
    });

    assert.equal(state.resolved, true);
    assert.equal(state.side, "inside");
    assert.equal(state.allowed, true);
    assert.equal(state.limitDisabled, false);
  }
});

test("aimed targets below and above the effective range are rejected", () => {
  const near = getAimedRangeSelectionState({
    attackDistanceMeters: 4.99,
    effectiveRange: EFFECTIVE_RANGE
  });
  const far = getAimedRangeSelectionState({
    attackDistanceMeters: 10.01,
    effectiveRange: EFFECTIVE_RANGE
  });

  assert.equal(near.side, "near");
  assert.equal(near.allowed, false);
  assert.equal(far.side, "far");
  assert.equal(far.allowed, false);
});

test("near and far aimed-range bonuses change only their own boundary", () => {
  const extendedNear = getAimedRangeSelectionState({
    attackDistanceMeters: 4,
    effectiveRange: EFFECTIVE_RANGE,
    nearBonusMeters: -2
  });
  const extendedFar = getAimedRangeSelectionState({
    attackDistanceMeters: 13,
    effectiveRange: EFFECTIVE_RANGE,
    farBonusMeters: 5
  });

  assert.deepEqual(extendedNear.effectiveRange, { min: 3, max: 10 });
  assert.equal(extendedNear.side, "inside");
  assert.equal(extendedNear.allowed, true);

  assert.deepEqual(extendedFar.effectiveRange, { min: 5, max: 15 });
  assert.equal(extendedFar.side, "inside");
  assert.equal(extendedFar.allowed, true);
});

test("near and far aimed-range limit switches are independent", () => {
  const nearDisabled = getAimedRangeSelectionState({
    attackDistanceMeters: 4,
    effectiveRange: EFFECTIVE_RANGE,
    nearLimitDisabled: 1
  });
  const nearWithWrongSwitch = getAimedRangeSelectionState({
    attackDistanceMeters: 4,
    effectiveRange: EFFECTIVE_RANGE,
    farLimitDisabled: 1
  });
  const farDisabled = getAimedRangeSelectionState({
    attackDistanceMeters: 11,
    effectiveRange: EFFECTIVE_RANGE,
    farLimitDisabled: 1
  });
  const farWithWrongSwitch = getAimedRangeSelectionState({
    attackDistanceMeters: 11,
    effectiveRange: EFFECTIVE_RANGE,
    nearLimitDisabled: 1
  });

  assert.equal(nearDisabled.allowed, true);
  assert.equal(nearDisabled.limitDisabled, true);
  assert.equal(nearWithWrongSwitch.allowed, false);
  assert.equal(nearWithWrongSwitch.limitDisabled, false);

  assert.equal(farDisabled.allowed, true);
  assert.equal(farDisabled.limitDisabled, true);
  assert.equal(farWithWrongSwitch.allowed, false);
  assert.equal(farWithWrongSwitch.limitDisabled, false);
});

test("aimed range restriction fails open when no effective range is available", () => {
  for (const effectiveRange of [null, undefined, { min: "invalid", max: 10 }]) {
    const state = getAimedRangeSelectionState({
      attackDistanceMeters: 1_000,
      effectiveRange
    });

    assert.equal(state.resolved, false);
    assert.equal(state.baseEffectiveRange, null);
    assert.equal(state.allowed, true);
    assert.equal(state.limitDisabled, false);
  }
});

test("reducing an existing far boundary to zero collapses rather than removes the restriction", () => {
  const blocked = getAimedRangeSelectionState({
    attackDistanceMeters: 1,
    effectiveRange: EFFECTIVE_RANGE,
    farBonusMeters: -100
  });
  const bypassed = getAimedRangeSelectionState({
    attackDistanceMeters: 1,
    effectiveRange: EFFECTIVE_RANGE,
    farBonusMeters: -100,
    farLimitDisabled: 1
  });

  assert.deepEqual(blocked.effectiveRange, { min: 0, max: 0 });
  assert.equal(blocked.side, "far");
  assert.equal(blocked.allowed, false);
  assert.equal(bypassed.allowed, true);
});
