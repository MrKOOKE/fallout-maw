import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CRAFTING_RESOLUTION_MODES,
  calculateCraftConsumedQuantity,
  createDefaultCraftingSettings,
  getCraftFailureRefundPercent,
  getRepairToolCostMultiplier,
  isGuaranteedResolutionMode,
  isSkillThresholdMode,
  normalizeCraftingSettings
} from "../src/settings/crafting.mjs";

const craftSource = await readFile(
  new URL("../src/apps/craft-window.mjs", import.meta.url),
  "utf8"
);
const repairSource = await readFile(
  new URL("../src/apps/repair-dialog.mjs", import.meta.url),
  "utf8"
);
const medicineSource = await readFile(
  new URL("../src/apps/medicine-dialog.mjs", import.meta.url),
  "utf8"
);
const butcheringSource = await readFile(
  new URL("../src/apps/search-inventory.mjs", import.meta.url),
  "utf8"
);
const butcheringConfigSource = await readFile(
  new URL("../src/apps/butchering-config.mjs", import.meta.url),
  "utf8"
);
const butcheringTemplate = await readFile(
  new URL("../templates/actor/butchering-config.hbs", import.meta.url),
  "utf8"
);
const settingsTemplate = await readFile(
  new URL("../templates/settings/crafting-settings-config.hbs", import.meta.url),
  "utf8"
);

test("crafting settings defaults preserve skill checks and requested failure refunds", () => {
  assert.deepEqual(createDefaultCraftingSettings(), {
    craft: {
      mode: CRAFTING_RESOLUTION_MODES.skillChecks,
      failureRefundPercent: 80,
      criticalFailureRefundPercent: 20
    },
    repair: {
      mode: CRAFTING_RESOLUTION_MODES.skillChecks,
      failureToolCostIncreasePercent: 100,
      criticalFailureToolCostIncreasePercent: 0
    },
    medicine: {
      mode: CRAFTING_RESOLUTION_MODES.skillChecks
    },
    butchering: {
      mode: CRAFTING_RESOLUTION_MODES.skillChecks
    }
  });
});

test("crafting settings normalization accepts both modes and clamps percentages", () => {
  assert.deepEqual(normalizeCraftingSettings({
    craft: {
      mode: CRAFTING_RESOLUTION_MODES.skillThreshold,
      failureRefundPercent: 140,
      criticalFailureRefundPercent: -5
    },
    repair: {
      mode: CRAFTING_RESOLUTION_MODES.skillThreshold,
      failureToolCostIncreasePercent: 1200,
      criticalFailureToolCostIncreasePercent: "250"
    },
    medicine: {
      mode: CRAFTING_RESOLUTION_MODES.skillThreshold
    },
    butchering: {
      mode: CRAFTING_RESOLUTION_MODES.guaranteed
    }
  }), {
    craft: {
      mode: CRAFTING_RESOLUTION_MODES.skillThreshold,
      failureRefundPercent: 100,
      criticalFailureRefundPercent: 0
    },
    repair: {
      mode: CRAFTING_RESOLUTION_MODES.skillThreshold,
      failureToolCostIncreasePercent: 1000,
      criticalFailureToolCostIncreasePercent: 250
    },
    medicine: {
      mode: CRAFTING_RESOLUTION_MODES.skillThreshold
    },
    butchering: {
      mode: CRAFTING_RESOLUTION_MODES.guaranteed
    }
  });

  assert.equal(isSkillThresholdMode(CRAFTING_RESOLUTION_MODES.skillThreshold), true);
  assert.equal(isSkillThresholdMode("unknown"), false);
  assert.equal(isGuaranteedResolutionMode(CRAFTING_RESOLUTION_MODES.guaranteed), true);
  assert.equal(isGuaranteedResolutionMode("unknown"), false);
});

test("legacy craft and repair settings gain the default medicine mode", () => {
  const normalized = normalizeCraftingSettings({
    craft: { mode: CRAFTING_RESOLUTION_MODES.skillThreshold },
    repair: { mode: CRAFTING_RESOLUTION_MODES.skillThreshold }
  });

  assert.deepEqual(normalized.medicine, {
    mode: CRAFTING_RESOLUTION_MODES.skillChecks
  });
  assert.deepEqual(normalized.butchering, {
    mode: CRAFTING_RESOLUTION_MODES.skillChecks
  });
});

test("craft failure refunds use critical failure priority and whole-item rounding", () => {
  const settings = createDefaultCraftingSettings();
  assert.equal(getCraftFailureRefundPercent(settings, ["failure"]), 80);
  assert.equal(getCraftFailureRefundPercent(settings, ["failure", "criticalFailure"]), 20);

  assert.equal(calculateCraftConsumedQuantity(1, 80), 0);
  assert.equal(calculateCraftConsumedQuantity(3, 80), 1);
  assert.equal(calculateCraftConsumedQuantity(3, 20), 2);
  assert.equal(calculateCraftConsumedQuantity(5, 0), 5);
  assert.equal(calculateCraftConsumedQuantity(5, 100), 0);
});

test("repair failure settings increase total tool cost", () => {
  const settings = createDefaultCraftingSettings();
  assert.equal(getRepairToolCostMultiplier(settings, "success"), 1);
  assert.equal(getRepairToolCostMultiplier(settings, "criticalSuccess"), 1);
  assert.equal(getRepairToolCostMultiplier(settings, "failure"), 2);
  assert.equal(getRepairToolCostMultiplier(settings, "criticalFailure"), 1);
});

test("craft, repair and medicine runtime contracts include threshold mode", () => {
  assert.match(craftSource, /getUnmetCraftSkillThreshold/);
  assert.match(craftSource, /resultKey:\s*"skillThreshold"/);
  assert.match(craftSource, /calculateCraftConsumedQuantity/);
  assert.match(craftSource, /hasFailureOutput/);
  assert.match(craftSource, /operation\.failureOutputs\?\.length > 0/);

  assert.match(repairSource, /isSkillThresholdMode\(craftingSettings\.repair\.mode\)/);
  assert.match(repairSource, /навык соответствует порогу/);
  assert.match(repairSource, /getRepairToolCostMultiplier/);

  assert.match(medicineSource, /getMedicineSkillResolution/);
  assert.match(medicineSource, /resolveMedicineSkillAction/);
  assert.match(medicineSource, /resolveImplantInstallationOnAuthorityLocked/);
  assert.match(medicineSource, /resolveProsthesisInstallationOnAuthorityLocked/);
  assert.match(medicineSource, /expectedMedicineMode/);

  assert.match(butcheringSource, /getCraftingSettings\(\)\.butchering\.mode/);
  assert.match(butcheringSource, /resultKey:\s*"skillThreshold"/);
  assert.match(butcheringSource, /resultKey:\s*"guaranteed"/);
  assert.match(butcheringSource, /createButcheringToolSpendPlan/);
  assert.match(butcheringSource, /reason:\s*"butchering-complete"/);
  assert.match(butcheringConfigSource, /normalizeButcheringToolRequirement/);
  assert.match(butcheringConfigSource, /skill\.key === "naturalist"/);
});

test("crafting settings template conditionally groups skill-check-only options", () => {
  assert.match(settingsTemplate, /name="craft\.mode"/);
  assert.match(settingsTemplate, /name="repair\.mode"/);
  assert.match(settingsTemplate, /name="medicine\.mode"/);
  assert.match(settingsTemplate, /name="butchering\.mode"/);
  assert.match(settingsTemplate, /data-crafting-check-options="craft"/);
  assert.match(settingsTemplate, /data-crafting-check-options="repair"/);
  assert.match(settingsTemplate, /craft\.failureRefundPercent/);
  assert.match(settingsTemplate, /repair\.criticalFailureToolCostIncreasePercent/);
  assert.match(butcheringTemplate, /data-stage-tool-enabled/);
  assert.match(butcheringTemplate, /data-stage-tool-key/);
  assert.match(butcheringTemplate, /data-stage-tool-class/);
  assert.match(butcheringTemplate, /data-stage-tool-cost/);
});
