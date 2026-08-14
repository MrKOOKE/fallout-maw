import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const medicineSource = await readFile(
  new URL("../src/apps/medicine-dialog.mjs", import.meta.url),
  "utf8"
);
const medicineTemplate = await readFile(
  new URL("../templates/actor/medicine-dialog.hbs", import.meta.url),
  "utf8"
);
const treatmentRowTemplate = await readFile(
  new URL("../templates/actor/parts/medicine-treatment-row.hbs", import.meta.url),
  "utf8"
);
const damageHubSource = await readFile(
  new URL("../src/combat/damage-hub.mjs", import.meta.url),
  "utf8"
);

function sliceFunction(source, name) {
  const markers = [
    `async function ${name}(`,
    `function ${name}(`
  ];
  const start = markers
    .map(marker => source.indexOf(marker))
    .find(index => index >= 0);
  assert.ok(Number.isInteger(start) && start >= 0, `${name} source was not found`);

  const asyncEnd = source.indexOf("\nasync function ", start + 1);
  const plainEnd = source.indexOf("\nfunction ", start + 1);
  const candidates = [asyncEnd, plainEnd].filter(index => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test("medicine exposes limb health as an explicit treatment kind grouped with its traumas", () => {
  const getTreatments = sliceFunction(medicineSource, "getTargetTreatments");
  const buildContext = sliceFunction(medicineSource, "buildTargetContext");

  assert.match(getTreatments, /treatmentType\s*===\s*["']limb["']/);
  assert.match(getTreatments, /targetContext\?\.limbs/);
  assert.match(buildContext, /limbs:\s*snapshotActorLimbs\(actor(?:,\s*limbHealthContext)?\)/);
  assert.match(
    buildContext,
    /traumas:\s*(?:actor\.items|getActorItemsByType\(actor,\s*["']trauma["']\))/
  );

  assert.match(
    medicineTemplate,
    /{{#each\s+(?:limbs|limbGroups|limbTreatments)}}[\s\S]*?{{#each\s+traumas}}/,
    "the trauma tab must render traumas inside their owning limb block"
  );
  assert.match(medicineTemplate, /medicine-treatment-row\.hbs["']\s+limbTreatment/);
  assert.match(treatmentRowTemplate, /data-treatment-type=["']{{type}}["']/);
  assert.match(treatmentRowTemplate, /data-treatment-id=["']{{id}}["']/);
});

test("limb treatment availability is bounded by the authoritative trauma healing cap", () => {
  const snapshotLimbs = sliceFunction(medicineSource, "snapshotActorLimbs");

  assert.match(medicineSource, /getLimbHealingCap/);
  assert.match(snapshotLimbs, /getLimbHealingCap\(actor,\s*key/);
  assert.match(snapshotLimbs, /healingCap/);
  assert.match(snapshotLimbs, /healable/);
  assert.match(
    snapshotLimbs,
    /(?:!missing|missing\s*===\s*false)[\s\S]*?(?:!prosthesis|prosthesis\s*===\s*null)|(?:!prosthesis|prosthesis\s*===\s*null)[\s\S]*?(?:!missing|missing\s*===\s*false)/,
    "missing limbs and installed prostheses must not become medical limb-health targets"
  );
  assert.match(
    snapshotLimbs,
    /(?:healingCap\s*>\s*value|value\s*<\s*healingCap)/,
    "a limb is healable only while its current value is below its current cap"
  );
});

test("limb health and medical-tool supply commit as one optimistic inventory mutation", () => {
  const perform = sliceFunction(medicineSource, "performTreatment");
  const commit = sliceFunction(medicineSource, "commitTreatmentToActors");
  const limbAdapter = sliceFunction(medicineSource, "prepareLimbTreatmentCommit");
  const itemAdapter = sliceFunction(medicineSource, "prepareItemTreatmentCommit");
  const healingUpdate = sliceFunction(damageHubSource, "prepareTargetedLimbHealingActorUpdate");

  assert.match(commit, /treatmentType\s*===\s*["']limb["']/);
  assert.match(commit, /prepareLimbTreatmentCommit\(targetActor/);
  assert.match(commit, /prepareItemTreatmentCommit\(targetActor/);
  assert.doesNotMatch(commit, /targetActor\?\.items\?\.get/);

  assert.match(limbAdapter, /getLimbHealingCap\(targetActor,\s*limbKey(?:,\s*limbHealthContext)?\)/);
  assert.match(limbAdapter, /assertTreatmentProgressIsCurrent\(currentProgress,\s*expectedProgress\)/);
  assert.match(limbAdapter, /prepareTargetedLimbHealingActorUpdate\(/);
  assert.match(limbAdapter, /targetPlan\.actorUpdates\.push\(healing\.updateData\)/);
  assert.doesNotMatch(limbAdapter, /nextProgress\s*<=\s*currentProgress/);
  assert.match(itemAdapter, /targetActor\?\.items\?\.get/);
  assert.match(itemAdapter, /assertTreatmentProgressIsCurrent\(currentProgress,\s*expectedProgress\)/);

  assert.match(healingUpdate, /calculateTargetedLimbHealing\(actor,\s*key,\s*amount(?:,\s*\{\s*context\s*\})?\)/);
  assert.match(healingUpdate, /system\.limbs\.\$\{key\}\.damageAccumulation/);
  assert.match(healingUpdate, /mergeConsciousnessRecoveryUpdate\(/);
  assert.match(commit, /currentSupply\s*!==\s*expected/);
  assert.match(commit, /createToolResourceValueUpdate\(instrument, tool, remaining\)/);
  assert.equal((commit.match(/executeInventoryMutation\(/g) ?? []).length, 1);
  assert.match(commit, /falloutMawSkipDamageStatusSync:\s*true/);
  assert.match(commit, /falloutMawLimbCapSync:\s*true/);

  assert.doesNotMatch(perform, /requestDamageApplication\(/);
  assert.doesNotMatch(commit, /requestDamageApplication\(/);
  assert.match(commit, /synchronizeActorDamageStatusesAfterInventoryMutation\(targetActor\)/);
});

test("limb treatment identity survives the intent-only authoritative workflow", () => {
  const perform = sliceFunction(medicineSource, "performTreatment");
  const apply = sliceFunction(medicineSource, "applyTreatmentToTarget");
  const socket = sliceFunction(medicineSource, "handleMedicineSocketRequest");

  assert.match(perform, /applyTreatmentToTarget\(targetContext,\s*\{/);
  assert.match(perform, /treatmentType/);
  assert.doesNotMatch(perform, /runTreatmentChecks\(\{/);

  assert.match(apply, /treatmentType/);
  assert.match(socket, /treatmentType:\s*payload\.treatmentType/);
  assert.match(socket, /treatmentId:\s*payload\.treatmentId/);
});
