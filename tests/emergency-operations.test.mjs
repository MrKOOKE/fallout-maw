import assert from "node:assert/strict";
import test from "node:test";

import { applyEmergencyOperationsToolEfficiency } from "../src/apps/medicine-emergency-operations.mjs";
import { normalizeEmergencyOperationsSettings } from "../src/settings/abilities.mjs";

test("emergency operations defaults match the fixed ability design", () => {
  assert.deepEqual(normalizeEmergencyOperationsSettings(), {
    combatActionPointCost: 3,
    activationEnergyCost: 20,
    overloadEnergyCost: 20,
    overloadDurationSeconds: 60 * 60,
    toolEfficiencyPercentBonus: 500
  });
});

test("emergency operations adds 500 percentage points to tool efficiency", () => {
  assert.equal(applyEmergencyOperationsToolEfficiency(100, 500), 600);
  assert.equal(applyEmergencyOperationsToolEfficiency(150, 500), 650);
});

test("emergency operations efficiency inputs cannot reduce the result", () => {
  assert.equal(applyEmergencyOperationsToolEfficiency(100, -500), 100);
  assert.equal(applyEmergencyOperationsToolEfficiency(-100, 500), 500);
});
