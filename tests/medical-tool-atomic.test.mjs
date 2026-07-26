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
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} source was not found`);
  const asyncEnd = source.indexOf("\nasync function ", start + name.length + 15);
  const plainEnd = source.indexOf("\nfunction ", start + name.length + 15);
  const candidates = [asyncEnd, plainEnd].filter(index => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test("repair target condition and tool supply share one recoverable inventory mutation", () => {
  const perform = sliceFunction(repairSource, "performRepair");
  const commit = sliceFunction(repairSource, "commitRepairToActors");
  const socket = sliceFunction(repairSource, "handleRepairSocketRequest");

  assert.doesNotMatch(perform, /instrument\.update\(/);
  assert.match(commit, /currentValue !== toInteger\(expectedCondition\)/);
  assert.match(commit, /currentSupply !== expected/);
  assert.equal((commit.match(/executeInventoryMutation\(/g) ?? []).length, 1);
  assert.match(commit, /actor:\s*targetActor[\s\S]*?actor:\s*sourceActor/);
  assert.match(socket, /sourceActorUuid/);
  assert.match(socket, /commitRepairToActors\(\{/);
});

test("medicine progress or deletion and tool supply share one recoverable inventory mutation", () => {
  const perform = sliceFunction(medicineSource, "performTreatment");
  const commit = sliceFunction(medicineSource, "commitTreatmentToActors");
  const socket = sliceFunction(medicineSource, "handleMedicineSocketRequest");

  assert.doesNotMatch(perform, /instrument\.update\(/);
  assert.doesNotMatch(commit, /trauma\.update\(|trauma\.delete\(|deleteHealedTraumas\(/);
  assert.match(commit, /currentProgress !== toInteger\(expectedProgress\)/);
  assert.match(commit, /currentSupply !== expected/);
  assert.match(commit, /targetPlan\.deletes\.push\(trauma\.id\)/);
  assert.match(commit, /actorUpdates/);
  assert.equal((commit.match(/executeInventoryMutation\(/g) ?? []).length, 1);
  assert.match(commit, /actor:\s*sourceActor/);
  assert.match(socket, /sourceActorUuid/);
  assert.match(socket, /commitTreatmentToActors\(\{/);
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
