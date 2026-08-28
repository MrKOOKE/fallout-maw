import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDamageApplicationBreakdownIndex,
  buildDamageApplicationDeltaIndex,
  getDamageEventIndexEntry
} from "../src/combat/damage-batch-index.mjs";

test("damage application deltas are aggregated once by coercive event index", () => {
  const index = buildDamageApplicationDeltaIndex([
    { damageEventIndex: 0, healthDelta: 3, limbDelta: 2 },
    { damageEventIndex: "0", healthDelta: 4, limbDelta: -5 },
    { damageEventIndex: null, healthDelta: 1, limbDelta: 1 },
    { damageEventIndex: 1, healthDelta: -1, limbDelta: 6 },
    { damageEventIndex: undefined, healthDelta: 100, limbDelta: 100 },
    { damageEventIndex: "invalid", healthDelta: 100, limbDelta: 100 }
  ]);

  assert.deepEqual(getDamageEventIndexEntry(index, "0"), {
    healthDelta: 8,
    limbDelta: 3
  });
  assert.deepEqual(getDamageEventIndexEntry(index, 1), {
    healthDelta: 0,
    limbDelta: 6
  });
  assert.equal(getDamageEventIndexEntry(index, "invalid"), null);
  assert.equal(getDamageEventIndexEntry(index, undefined), null);
});

test("barrier breakdown aggregation preserves totals, fallbacks, and depletion order", () => {
  const firstDepletion = { id: "first" };
  const secondDepletion = { id: "second" };
  const index = buildDamageApplicationBreakdownIndex([
    {
      damageEventIndex: 2,
      incomingAmount: 20,
      amountBeforeResistance: 14,
      mitigationBlocked: 12,
      preBarrierAmount: 8,
      barrierAbsorbed: 3,
      amountAfterBarrier: 5,
      actualHealthDelta: 4,
      actualLimbDelta: 2,
      barrierDepleted: [firstDepletion]
    },
    {
      damageEventIndex: "2",
      incomingAmount: 10,
      amountBeforeResistance: 9,
      mitigationBlocked: 4,
      preBarrierAmount: 7,
      barrierAbsorbed: 1,
      amount: 6,
      actualHealthDelta: 5,
      actualLimbDelta: 3,
      barrierDepleted: [secondDepletion]
    },
    {
      damageEventIndex: 3,
      preBarrierAmount: -20,
      amountAfterBarrier: 0,
      amount: 99
    }
  ]);

  assert.deepEqual(getDamageEventIndexEntry(index, 2), {
    incomingAmount: 30,
    amountBeforeResistance: 23,
    mitigationBlocked: 16,
    preBarrierAmount: 15,
    barrierAbsorbed: 4,
    amountAfterBarrier: 11,
    actualHealthDelta: 9,
    actualLimbDelta: 5,
    depleted: [firstDepletion, secondDepletion]
  });
  assert.deepEqual(getDamageEventIndexEntry(index, "3"), {
    incomingAmount: 0,
    amountBeforeResistance: 0,
    mitigationBlocked: 0,
    preBarrierAmount: 0,
    barrierAbsorbed: 0,
    amountAfterBarrier: 0,
    actualHealthDelta: 0,
    actualLimbDelta: 0,
    depleted: []
  });
});
