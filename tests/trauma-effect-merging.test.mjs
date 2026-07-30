import assert from "node:assert/strict";
import test from "node:test";

import { mergeMatchingTraumaEffectChanges } from "../src/combat/trauma-effect-merging.mjs";

test("matching additive trauma effects become one summed row", () => {
  assert.deepEqual(mergeMatchingTraumaEffectChanges([
    {
      key: "system.skills.athletics.bonusPercent",
      type: "add",
      value: "-5",
      phase: "initial",
      priority: 0
    },
    {
      key: "system.skills.athletics.bonusPercent",
      type: "add",
      value: "-12",
      phase: "initial",
      priority: 0
    }
  ]), [{
    key: "system.skills.athletics.bonusPercent",
    type: "add",
    value: "-17",
    phase: "initial",
    priority: 0
  }]);
});

test("phase and priority boundaries prevent unsafe trauma effect merging", () => {
  const changes = mergeMatchingTraumaEffectChanges([
    { key: "system.skills.science.bonusPercent", type: "add", value: "-5", phase: "initial" },
    { key: "system.skills.science.bonusPercent", type: "add", value: "-10", phase: "final" },
    { key: "system.skills.science.bonusPercent", type: "add", value: "-15", phase: "initial", priority: 10 }
  ]);

  assert.equal(changes.length, 3);
});

test("non-numeric additive trauma expressions remain separate", () => {
  const changes = mergeMatchingTraumaEffectChanges([
    { key: "system.example", type: "add", value: "@value", phase: "initial" },
    { key: "system.example", type: "add", value: "2", phase: "initial" }
  ]);

  assert.equal(changes.length, 2);
});

test("matching overrides and statuses retain one effective row", () => {
  assert.deepEqual(mergeMatchingTraumaEffectChanges([
    { key: "system.example", type: "override", value: "1", phase: "initial" },
    { key: "system.example", type: "override", value: "2", phase: "initial" },
    { key: "status.blind", type: "add", value: "0", phase: "initial" },
    { key: "status.blind", type: "add", value: "1", phase: "initial" }
  ]), [
    { key: "system.example", type: "override", value: "2", phase: "initial" },
    { key: "status.blind", type: "add", value: "1", phase: "initial" }
  ]);
});
