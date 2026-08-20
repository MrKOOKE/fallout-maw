import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateExperimentalSurgeryPatientDamage,
  calculateExperimentalSurgerySupplyCost,
  getExperimentalSurgeryEffectiveToolClass,
  isExperimentalSurgeryTreatmentType,
  rollExperimentalSurgeryChance
} from "../src/apps/medicine-experimental-surgery.mjs";
import { normalizeExperimentalSurgerySettings } from "../src/settings/abilities.mjs";
import { selectToolByPolicy } from "../src/utils/tool-selection-policy.mjs";

test("experimental surgery defaults match the fixed ability design", () => {
  assert.deepEqual(normalizeExperimentalSurgerySettings(), {
    treatmentEnergyCost: 10,
    allowedToolClassDeficit: 1,
    extraSupplyChancePercent: 25,
    supplyCostMultiplier: 2,
    patientDamageChancePercent: 5,
    patientHealthDamagePercent: 5
  });
  assert.equal(isExperimentalSurgeryTreatmentType("trauma"), true);
  assert.equal(isExperimentalSurgeryTreatmentType("disease"), true);
  assert.equal(isExperimentalSurgeryTreatmentType("limb"), false);
});

test("experimental surgery presents the effective lowered tool class", () => {
  assert.equal(getExperimentalSurgeryEffectiveToolClass("S", 1), "A");
  assert.equal(getExperimentalSurgeryEffectiveToolClass("C", 1), "D");
  assert.equal(getExperimentalSurgeryEffectiveToolClass("D", 1), "D");
});

test("experimental surgery rolls bounded percentage chances", () => {
  assert.equal(rollExperimentalSurgeryChance(25, () => 0.2499), true);
  assert.equal(rollExperimentalSurgeryChance(25, () => 0.25), false);
  assert.equal(rollExperimentalSurgeryChance(0, () => 0), false);
  assert.equal(rollExperimentalSurgeryChance(100, () => 1), true);
});

test("experimental surgery doubles actual supply cost without a negative reserve", () => {
  assert.deepEqual(calculateExperimentalSurgerySupplyCost({
    normalSpent: 4,
    currentSupply: 20,
    multiplier: 2,
    triggered: true
  }), {
    spent: 8,
    remaining: 12,
    extraSpent: 4,
    multiplier: 2,
    triggered: true
  });
  assert.deepEqual(calculateExperimentalSurgerySupplyCost({
    normalSpent: 4,
    currentSupply: 6,
    multiplier: 2,
    triggered: true
  }), {
    spent: 6,
    remaining: 0,
    extraSpent: 2,
    multiplier: 2,
    triggered: true
  });
});

test("experimental surgery damage is a rounded-up percentage of maximum health", () => {
  assert.equal(calculateExperimentalSurgeryPatientDamage(100, 5), 5);
  assert.equal(calculateExperimentalSurgeryPatientDamage(101, 5), 6);
  assert.equal(calculateExperimentalSurgeryPatientDamage(0, 5), 0);
});

test("automatic medicine selection honors the allowed class deficit", () => {
  const selected = selectToolByPolicy([
    createInstrument("class-d", "D"),
    createInstrument("class-c", "C")
  ], {
    requiredToolKey: "medical",
    requiredToolClass: "B",
    allowedToolClassDeficit: 1
  });
  assert.equal(selected?.id, "class-c");
});

function createInstrument(id, toolClass) {
  return {
    id,
    name: id,
    toolKey: "medical",
    toolClass,
    requirementMet: true,
    supplyValue: 10,
    supplyMax: 10
  };
}
