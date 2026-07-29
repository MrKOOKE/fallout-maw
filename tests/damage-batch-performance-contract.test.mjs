import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/combat/damage-hub.mjs", import.meta.url),
  "utf8"
);

function sliceBetween(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("resolved damage events reuse one indexed application breakdown", () => {
  const workflow = sliceBetween(
    "async function executeDamageSystemEventWorkflow",
    "async function emitDamageResolvedSystemEvent"
  );
  const requestResult = sliceBetween(
    "function getDamageRequestBarrierResult",
    "function getDamageEventActorSnapshot"
  );

  assert.match(workflow, /const applicationBreakdownIndexes = new WeakMap\(\)/);
  assert.match(workflow, /buildDamageApplicationBreakdownIndex\(applications\)/);
  assert.match(requestResult, /getDamageEventIndexEntry\(/);
  assert.doesNotMatch(requestResult, /\.filter\(/);
});

test("damage batch preparation remains synchronous and snapshot-local", () => {
  const application = sliceBetween(
    "async function applyDamageApplicationsNow",
    "function createDamageBatchPreparationContext"
  );
  const preparation = sliceBetween(
    "function prepareDamageBatchEntry",
    "async function applyDirectDamageApplication"
  );

  assert.match(application, /preparationContext \?\?= createDamageBatchPreparationContext\(actor\)/);
  assert.equal(application.match(/preparationContext = null/g)?.length, 3);
  assert.doesNotMatch(application, /await\s+prepareDamageBatchEntry/);
  assert.match(application, /buildDamageApplicationDeltaIndex\(/);
  assert.doesNotMatch(application, /applicationDeltas[\s\S]{0,180}?\.filter\(/);

  assert.doesNotMatch(preparation, /\bawait\b/);
  assert.match(preparation, /getDamageBatchProsthesisContext\(/);
  assert.match(preparation, /getDamageBatchMitigationEquipmentSnapshot\(/);
  assert.match(preparation, /preparationContext\s*\n\s*}\);/);
});
