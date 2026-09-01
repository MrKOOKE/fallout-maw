import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeSkillCheckResultPolicies,
  resolveSkillCheckResultPolicy
} from "../src/rolls/skill-check-result-policy.mjs";

test("guaranteed-hit policy only removes failed outcomes above its strict threshold", () => {
  const policy = {
    disabledResultsWhenSuccessChanceAbove: { criticalFailure: true, failure: true },
    successChanceThreshold: 10
  };
  assert.deepEqual(resolveSkillCheckResultPolicy(policy, 10).disabledResults, {
    criticalFailure: false,
    failure: false,
    success: false,
    criticalSuccess: false
  });
  assert.deepEqual(resolveSkillCheckResultPolicy(policy, 11).disabledResults, {
    criticalFailure: true,
    failure: true,
    success: false,
    criticalSuccess: false
  });
});

test("true bullet keeps guaranteed hits and forces critical success only above 90%", () => {
  const policy = {
    disabledResults: { criticalFailure: true, failure: true },
    forcedResultWhenSuccessChanceAbove: "criticalSuccess",
    successChanceThreshold: 90
  };
  assert.equal(resolveSkillCheckResultPolicy(policy, 90).forcedResult, "");
  assert.equal(resolveSkillCheckResultPolicy(policy, 90).disabledResults.failure, true);
  assert.equal(resolveSkillCheckResultPolicy(policy, 91).forcedResult, "criticalSuccess");
});

test("independent policies retain their own thresholds when merged", () => {
  const merged = mergeSkillCheckResultPolicies(
    {
      disabledResultsWhenSuccessChanceAbove: { failure: true },
      successChanceThreshold: 10
    },
    {
      disabledResults: { criticalFailure: true },
      forcedResultWhenSuccessChanceAbove: "criticalSuccess",
      successChanceThreshold: 90
    }
  );
  const mid = resolveSkillCheckResultPolicy(merged, 50);
  assert.equal(mid.disabledResults.failure, true);
  assert.equal(mid.disabledResults.criticalFailure, true);
  assert.equal(mid.forcedResult, "");
  assert.equal(resolveSkillCheckResultPolicy(merged, 91).forcedResult, "criticalSuccess");
});
