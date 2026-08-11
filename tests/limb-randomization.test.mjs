import test from "node:test";
import assert from "node:assert/strict";

import { selectRandomWeightedLimbKey } from "../src/utils/limb-randomization.mjs";

test("critical-only limb distribution excludes ordinary limbs", () => {
  const actor = {
    system: {
      limbs: {
        arm: { value: 10, min: 0, critical: false, aimedDifficultyPercent: 0 },
        head: { value: 10, min: 0, critical: true, aimedDifficultyPercent: 100 }
      }
    }
  };

  assert.equal(selectRandomWeightedLimbKey(actor, { criticalOnly: true }), "head");
});

test("critical-only limb distribution returns empty when no eligible limb exists", () => {
  const actor = {
    type: "character",
    items: [],
    system: {
      limbs: {
        arm: { value: 10, min: 0, critical: false, aimedDifficultyPercent: 0 },
        head: { value: 0, min: 0, missing: true, critical: true, aimedDifficultyPercent: 0 }
      }
    }
  };

  assert.equal(selectRandomWeightedLimbKey(actor, { criticalOnly: true }), "");
});

test("critical-only limb distribution keeps a saturated present limb eligible", () => {
  const actor = {
    type: "character",
    items: [],
    system: {
      limbs: {
        head: { value: -10, min: -10, missing: false, critical: true, aimedDifficultyPercent: 0 }
      }
    }
  };

  assert.equal(selectRandomWeightedLimbKey(actor, { criticalOnly: true }), "head");
});
