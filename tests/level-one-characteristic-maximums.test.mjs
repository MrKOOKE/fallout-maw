import assert from "node:assert/strict";
import test from "node:test";

import { canInvestCharacteristicPoint } from "../src/advancement/storage.mjs";

test("level-one characteristic investment stops at base plus invested points", () => {
  assert.equal(canInvestCharacteristicPoint({
    level: 1,
    baseValue: 1,
    investedPoints: 8,
    levelOneMaximum: 10
  }), true);
  assert.equal(canInvestCharacteristicPoint({
    level: 1,
    baseValue: 1,
    investedPoints: 9,
    levelOneMaximum: 10
  }), false);
});

test("configured maximum applies only while the actor is level one", () => {
  assert.equal(canInvestCharacteristicPoint({
    level: 1,
    baseValue: 3,
    investedPoints: 4,
    levelOneMaximum: 7
  }), false);
  assert.equal(canInvestCharacteristicPoint({
    level: 2,
    baseValue: 3,
    investedPoints: 40,
    levelOneMaximum: 7
  }), true);
});

test("external effective values do not participate in the investment limit", () => {
  assert.equal(canInvestCharacteristicPoint({
    level: 1,
    baseValue: 1,
    investedPoints: 8,
    levelOneMaximum: 10,
    effectiveValue: 100
  }), true);
});
