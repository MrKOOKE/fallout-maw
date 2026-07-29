import assert from "node:assert/strict";
import test from "node:test";

import {
  BURST_PREVIEW_SAMPLE_BUDGET,
  getBurstSampleCount,
  getEvenBurstSampleOffset
} from "../src/combat/burst-sampling-policy.mjs";

test("burst preview work stays bounded independently from bullets and pellets", () => {
  for (const projectileCount of [1, 5, 25, 50, 80, 160]) {
    assert.equal(
      getBurstSampleCount(projectileCount, { purpose: "preview" }),
      BURST_PREVIEW_SAMPLE_BUDGET
    );
  }
});

test("burst resolution preserves the previous projectile-scaled precision", () => {
  assert.deepEqual(
    [1, 5, 25, 50, 160].map(projectileCount => (
      getBurstSampleCount(projectileCount, { purpose: "resolution" })
    )),
    [64, 64, 300, 600, 1920]
  );
});

test("even burst samples retain symmetric cone endpoints", () => {
  const offsets = Array.from(
    { length: BURST_PREVIEW_SAMPLE_BUDGET },
    (_value, index) => getEvenBurstSampleOffset(index, BURST_PREVIEW_SAMPLE_BUDGET)
  );

  assert.equal(offsets.at(0), -1);
  assert.equal(offsets.at(-1), 1);
  assert.ok(offsets.every((value, index) => index === 0 || value > offsets[index - 1]));
  for (let index = 0; index < offsets.length; index += 1) {
    assert.ok(Math.abs(offsets[index] + offsets.at(-1 - index)) < 1e-12);
  }
});
