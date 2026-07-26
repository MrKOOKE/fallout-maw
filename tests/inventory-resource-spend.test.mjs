import assert from "node:assert/strict";
import test from "node:test";

import {
  planContinuousResourceSpend,
  planIntegerResourceSpend
} from "../src/inventory/resource-spend.mjs";

test("integer resource costs share one pool instead of overwriting each other", () => {
  const plan = planIntegerResourceSpend({
    current: 10,
    costs: [
      { key: "condition.0", amount: 6 },
      { key: "condition.1", amount: 6 }
    ]
  });

  assert.equal(plan.available, false);
  assert.equal(plan.spent, 0);
  assert.equal(plan.remaining, 10);
});

test("integer resource costs retain independent fractional remainders", () => {
  const plan = planIntegerResourceSpend({
    current: 4,
    costs: [
      { key: "condition.0", amount: 0.75 },
      { key: "condition.1", amount: 0.6 }
    ],
    remainders: {
      "condition.0": 0.5,
      "condition.1": 0.5
    }
  });

  assert.equal(plan.available, true);
  assert.equal(plan.spent, 2);
  assert.equal(plan.remaining, 2);
  assert.deepEqual(plan.remainders, {
    "condition.0": 0.25,
    "condition.1": 0.1
  });
});

test("continuous resource costs are summed before checking availability", () => {
  const allOrNothing = planContinuousResourceSpend({
    current: 10,
    costs: [{ amount: 6 }, { amount: 6 }]
  });
  const partial = planContinuousResourceSpend({
    current: 10,
    costs: [{ amount: 6 }, { amount: 6 }],
    allowPartial: true
  });

  assert.equal(allOrNothing.available, false);
  assert.equal(allOrNothing.spent, 0);
  assert.equal(allOrNothing.remaining, 10);
  assert.equal(partial.available, false);
  assert.equal(partial.spent, 10);
  assert.equal(partial.remaining, 0);
});
