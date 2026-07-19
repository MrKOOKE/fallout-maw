import assert from "node:assert/strict";
import test from "node:test";

import {
  applyItemValueOperation,
  buildParallelPercentAttribution,
  createItemValueAttributionStep,
  PARALLEL_PERCENT_CALCULATION,
  replayItemValueAttribution
} from "../src/utils/item-value-attribution.mjs";
import { decomposePreparedSkillValue } from "../src/utils/skill-value-attribution.mjs";

test("item value attribution replays every supported operation in order", () => {
  const result = replayItemValueAttribution(10, [
    { operation: "add", value: 5 },
    { operation: "subtract", value: 2 },
    { operation: "multiply", value: 2 },
    { operation: "override", value: 40 },
    { operation: "upgrade", value: 50 },
    { operation: "downgrade", value: 45 }
  ]);

  assert.equal(result.total, 45);
  assert.deepEqual(result.sources.map(source => [source.before, source.after]), [
    [10, 15],
    [15, 13],
    [13, 26],
    [26, 40],
    [40, 50],
    [50, 45]
  ]);
});

test("item value attribution records the actual delta after rounding and limits", () => {
  const step = createItemValueAttributionStep(7, {
    operation: "multiply",
    value: 0.5,
    name: "Condition"
  }, {
    minimum: 4,
    round: Math.floor
  });

  assert.equal(step.before, 7);
  assert.equal(step.after, 4);
  assert.equal(step.delta, -3);
  assert.equal(step.name, "Condition");
});

test("unknown operations safely behave as addition", () => {
  assert.equal(applyItemValueOperation(3, 4, "unknown"), 7);
});

test("parallel percent attribution uses one base and rounds the combined damage once", () => {
  let roundCalls = 0;
  const result = buildParallelPercentAttribution(60, [
    { name: "Rifle proficiency", value: 25 },
    { name: "Base bonus", value: 19 }
  ], {
    round: value => {
      roundCalls += 1;
      return Math.round(value);
    }
  });

  assert.equal(result.calculation, PARALLEL_PERCENT_CALCULATION);
  assert.equal(result.totalPercent, 44);
  assert.equal(result.combinedContribution, 26.4);
  assert.ok(Math.abs(result.unroundedTotal - 86.4) < Number.EPSILON * 100);
  assert.equal(result.total, 86);
  assert.equal(roundCalls, 1);
  assert.deepEqual(result.sources.map(source => ({
    name: source.name,
    calculation: source.calculation,
    operation: source.operation,
    percentBase: source.percentBase,
    percent: source.percent,
    contribution: source.contribution
  })), [
    {
      name: "Rifle proficiency",
      calculation: PARALLEL_PERCENT_CALCULATION,
      operation: "percent",
      percentBase: 60,
      percent: 25,
      contribution: 15
    },
    {
      name: "Base bonus",
      calculation: PARALLEL_PERCENT_CALCULATION,
      operation: "percent",
      percentBase: 60,
      percent: 19,
      contribution: 11.4
    }
  ]);
  assert.equal("before" in result.sources[0], false);
  assert.equal("after" in result.sources[0], false);
  assert.equal(result.sources.length, 2);
});

test("parallel percent attribution reverses individual contributions for recoil", () => {
  const result = buildParallelPercentAttribution(10, [
    { name: "Stance", value: 25 },
    { name: "Ability", value: 15 }
  ], {
    direction: -1,
    round: Math.round
  });

  assert.equal(result.totalPercent, 40);
  assert.equal(result.factor, 0.6);
  assert.deepEqual(result.sources.map(source => source.contribution), [-2.5, -1.5]);
  assert.equal(result.total, 6);
});

test("parallel percent attribution cancels opposing sources without compounding", () => {
  const result = buildParallelPercentAttribution(80, [
    { value: 25 },
    { value: -25 }
  ], { round: Math.round });

  assert.equal(result.totalPercent, 0);
  assert.deepEqual(result.sources.map(source => source.contribution), [20, -20]);
  assert.equal(result.factor, 1);
  assert.equal(result.total, 80);
});

test("parallel percent attribution clamps only the aggregate factor", () => {
  const result = buildParallelPercentAttribution(60, [
    { value: -80 },
    { value: -40 }
  ], {
    minimumFactor: 0,
    round: Math.round
  });

  assert.deepEqual(result.sources.map(source => source.contribution), [-48, -24]);
  assert.ok(Math.abs(result.unclampedFactor - (-0.2)) < Number.EPSILON);
  assert.equal(result.unclampedTotal, -12);
  assert.equal(result.factor, 0);
  assert.equal(result.unroundedTotal, 0);
  assert.equal(result.total, 0);
});

test("parallel percent attribution preserves zero-base sources without negative zero", () => {
  const result = buildParallelPercentAttribution(0, [
    { id: "positive", value: 25 },
    { id: "negative", value: -25 },
    { id: "invalid", value: "not-a-number" }
  ], {
    direction: -1,
    round: Math.round
  });

  assert.equal(result.sources.length, 3);
  assert.deepEqual(result.sources.map(source => source.contribution), [0, 0, 0]);
  assert.equal(result.totalPercent, 0);
  assert.equal(result.total, 0);
  assert.equal(Object.is(result.delta, -0), false);
});

test("prepared skill attribution mirrors component composition and limits", () => {
  assert.deepEqual(decomposePreparedSkillValue({
    base: 70,
    bonus: 8,
    developmentBonus: 20,
    abilityBonus: 5,
    min: 0,
    max: 100
  }), {
    base: 70,
    bonus: 8,
    developmentBonus: 20,
    abilityBonus: 5,
    min: 0,
    max: 100,
    unclamped: 103,
    value: 100
  });

  assert.equal(decomposePreparedSkillValue({
    base: 10,
    bonus: -30,
    developmentBonus: 2,
    abilityBonus: 3,
    min: 0,
    max: 100
  }).value, 0);
});
