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

test("batch feedback waits for document commits, bulk flushers, chat, and resolved events", () => {
  const application = sliceBetween(
    "async function applyDamageApplicationsNow",
    "function createDamageBatchPreparationContext"
  );
  const commit = sliceBetween(
    "async function applyDamageEntriesBatch",
    "function selectBatchFinishingBlowSource"
  );
  const cycle = sliceBetween(
    "async function applyDamageCycleNow",
    "function stampDamageRequestsLogicalWorldTime"
  );
  const wrapper = sliceBetween(
    "async function applyDamageCycle(requests",
    "async function executeDamageSystemEventWorkflow"
  );

  assert.doesNotMatch(commit, /broadcastDamageNumbers\(/);
  const chatCommit = application.lastIndexOf("await publishDamageSummaryMessage(results)");
  const queuedFeedback = application.lastIndexOf("queueDamageFeedback(pendingFeedback");
  const exceptionBoundary = application.lastIndexOf("} finally {", queuedFeedback);
  assert.ok(chatCommit >= 0);
  assert.ok(queuedFeedback > chatCommit);
  assert.ok(exceptionBoundary >= 0);
  assert.ok(queuedFeedback > exceptionBoundary);
  assert.doesNotMatch(application, /broadcastDamage(?:Numbers|MitigationIcon)\(/);

  const bulkFlush = cycle.lastIndexOf("await endBulkOperation()");
  const directFeedback = cycle.lastIndexOf("flushDamageFeedback(pendingFeedback)");
  assert.ok(bulkFlush >= 0);
  assert.ok(directFeedback > bulkFlush);

  const resolvedWorkflow = wrapper.lastIndexOf("await executeDamageSystemEventWorkflow");
  const workflowFeedback = wrapper.lastIndexOf("flushDamageFeedback(feedbackQueue)");
  assert.ok(resolvedWorkflow >= 0);
  assert.ok(workflowFeedback > resolvedWorkflow);
  assert.match(wrapper, /try\s*\{[\s\S]*await executeDamageSystemEventWorkflow[\s\S]*\}\s*finally\s*\{[\s\S]*flushDamageFeedback/);
});

test("single-hit feedback also waits for barrier commits and resolved events", () => {
  const wrapper = sliceBetween(
    "export async function applyDamageApplication(request",
    "async function applyDamageApplicationNow"
  );
  const application = sliceBetween(
    "async function applyDamageApplicationNow",
    "async function applyItemConditionDamageApplicationNow"
  );

  assert.doesNotMatch(application, /broadcastDamage(?:Numbers|MitigationIcon)\(/);
  const barrierCommit = application.lastIndexOf("await commitOwnedDamageBarrier()");
  const queuedFeedback = application.lastIndexOf("queueDamageFeedback(pendingFeedback");
  const exceptionBoundary = application.lastIndexOf("} finally {", queuedFeedback);
  assert.ok(barrierCommit >= 0);
  assert.ok(queuedFeedback > barrierCommit);
  assert.ok(exceptionBoundary >= 0);
  assert.ok(queuedFeedback > exceptionBoundary);

  const resolvedWorkflow = wrapper.lastIndexOf("await executeDamageSystemEventWorkflow");
  const workflowFeedback = wrapper.lastIndexOf("flushDamageFeedback(feedbackQueue)");
  assert.ok(resolvedWorkflow >= 0);
  assert.ok(workflowFeedback > resolvedWorkflow);
  assert.match(wrapper, /try\s*\{[\s\S]*await executeDamageSystemEventWorkflow[\s\S]*\}\s*finally\s*\{[\s\S]*flushDamageFeedback/);
});
