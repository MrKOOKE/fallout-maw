import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const medicineSource = await readFile(
  new URL("../src/apps/medicine-dialog.mjs", import.meta.url),
  "utf8"
);
const repairSource = await readFile(
  new URL("../src/apps/repair-dialog.mjs", import.meta.url),
  "utf8"
);
const hackingSource = await readFile(
  new URL("../src/apps/hacking-dialog.mjs", import.meta.url),
  "utf8"
);

function sliceFunction(source, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
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

function findFunctionContaining(source, requiredTokens) {
  const matches = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? source.length;
    const candidate = source.slice(start, end);
    if (requiredTokens.every(token => candidate.includes(token))) return candidate;
  }
  assert.fail(`function containing ${requiredTokens.join(", ")} was not found`);
}

test("repair target condition and tool supply share one exact atomic leaf update", () => {
  const perform = sliceFunction(repairSource, "performRepair");
  const commit = sliceFunction(repairSource, "commitRepairToActors");
  const socket = sliceFunction(repairSource, "handleRepairSocketRequest");

  assert.doesNotMatch(perform, /instrument\.update\(/);
  assert.match(commit, /currentCondition !== Math\.max\(0, toInteger\(expectedCondition\)\)/);
  assert.match(commit, /currentSupply !== Math\.max\(0, toInteger\(expectedSupply\)\)/);
  assert.equal((commit.match(/executeAtomicActorItemUpdates\(/g) ?? []).length, 1);
  assert.match(commit, /document:\s*targetItem[\s\S]*?document:\s*instrument/);
  assert.match(commit, /hasItemFunction\(instrument, createToolFunctionKey\(instrumentToolKey\)\)/);
  assert.match(socket, /sourceActorUuid/);
  assert.match(socket, /resolveRepairOnAuthority\(\{/);
});

test("medicine progress or deletion and tool supply share one recoverable inventory mutation", () => {
  const perform = sliceFunction(medicineSource, "performTreatment");
  const commit = sliceFunction(medicineSource, "commitTreatmentToActors");
  const limbCommit = sliceFunction(medicineSource, "prepareLimbTreatmentCommit");
  const itemCommit = sliceFunction(medicineSource, "prepareItemTreatmentCommit");
  const socket = sliceFunction(medicineSource, "handleMedicineSocketRequest");
  const authoritativeTreatment = findFunctionContaining(
    medicineSource,
    ["runTreatmentChecks(", "commitTreatmentToActors("]
  );

  assert.doesNotMatch(perform, /instrument\.update\(/);
  assert.doesNotMatch(commit, /treatment\.update\(|treatment\.delete\(|deleteHealedTraumas\(/);
  assert.match(commit, /prepareLimbTreatmentCommit\(targetActor/);
  assert.match(commit, /prepareItemTreatmentCommit\(targetActor/);
  assert.match(limbCommit, /assertTreatmentProgressIsCurrent\(currentProgress,\s*expectedProgress\)/);
  assert.match(limbCommit, /targetPlan\.actorUpdates\.push\(healing\.updateData\)/);
  assert.match(itemCommit, /assertTreatmentProgressIsCurrent\(currentProgress,\s*expectedProgress\)/);
  assert.match(commit, /currentSupply !== expected/);
  assert.match(itemCommit, /targetPlan\.deletes\.push\(treatment\.id\)/);
  assert.match(itemCommit, /actorUpdates/);
  assert.equal((commit.match(/executeInventoryMutation\(/g) ?? []).length, 1);
  assert.match(commit, /actor:\s*sourceActor/);
  assert.match(commit, /falloutMawSkipDamageStatusSync:\s*true/);
  assert.match(commit, /falloutMawLimbCapSync:\s*true/);
  assert.match(socket, /sourceActorUuid/);
  assert.match(socket, /action\s*===\s*["'](?:applyTreatment|performTreatment)["']/);
  assert.match(authoritativeTreatment, /commitTreatmentToActors\(\{/);
});

test("hacking never spends a tool through a separate Item update", () => {
  const apply = sliceFunction(hackingSource, "applyHackingResultLocked");
  const entry = sliceFunction(hackingSource, "applyHackingResultNow");
  const wallCommit = sliceFunction(hackingSource, "commitWallHackingBatch");
  const wallRecovery = sliceFunction(hackingSource, "recoverWallHackingBatch");

  assert.match(entry, /runWithHackingMutationLocks/);
  assert.doesNotMatch(apply, /toolItem\.update\(|target\.update\(/);
  assert.match(apply, /executeInventoryMutation\(\[/);
  assert.match(apply, /commitWallHackingBatch\(\[/);
  assert.match(wallCommit, /foundry\.documents\.modifyBatch\(operations\)/);
  assert.match(wallCommit, /recoverWallHackingBatch\(state\)/);
  assert.match(wallRecovery, /previousSupply/);
  assert.match(wallRecovery, /previousDoorState/);
  assert.match(wallRecovery, /previousMethods/);
  assert.match(wallRecovery, /foundry\.documents\.modifyBatch\(operations\)/);
});
