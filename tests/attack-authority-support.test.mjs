import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const coverSource = await readFile(
  new URL("../src/canvas/cover.mjs", import.meta.url),
  "utf8"
);
const skillCheckSource = await readFile(
  new URL("../src/rolls/skill-check.mjs", import.meta.url),
  "utf8"
);

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test("immediate auto-cover sync cancels its debounce and awaits the authority path", () => {
  const body = sourceBetween(
    coverSource,
    "export async function syncAttackAutoCoverNow",
    "export function clearAttackAutoCoverSync"
  );

  assert.match(body, /window\.clearTimeout\(autoCoverFlushTimers\.get\(id\)\)/);
  assert.match(body, /autoCoverFlushTimers\.delete\(id\)/);
  assert.match(body, /const stateByActor = pendingAutoCoverStates\.get\(id\)/);
  assert.match(body, /pendingAutoCoverStates\.delete\(id\)/);
  assert.match(body, /coverStates === undefined[\s\S]*?Array\.from\(stateByActor\?\.values\(\) \?\? \[\]\)/);
  assert.match(body, /await syncAttackAutoCoverState\(id, states\)/);

  const cancellation = sourceBetween(
    coverSource,
    "export function cancelPendingAttackAutoCoverSync",
    "export function clearAttackAutoCoverSync"
  );
  assert.match(cancellation, /window\.clearTimeout\(autoCoverFlushTimers\.get\(id\)\)/);
  assert.match(cancellation, /pendingAutoCoverStates\.delete\(id\)/);
  assert.doesNotMatch(cancellation, /syncAttackAutoCoverState/);
});

test("skill-check single and batch publication preserve optional message author data", () => {
  const requestBatch = sourceBetween(
    skillCheckSource,
    "export async function requestSkillCheckBatch",
    "function createDeferredSkillCheckBarrier"
  );
  const collector = sourceBetween(
    skillCheckSource,
    "export function createSkillCheckBatchCollector",
    "async function publishSkillCheckMessageSafely"
  );
  const outcomePublisher = sourceBetween(
    skillCheckSource,
    "async function publishSkillCheckOutcomeMessages",
    "function buildSkillCheckBatchViewContext"
  );
  const singlePublisher = sourceBetween(
    skillCheckSource,
    "async function publishSkillCheckMessage",
    "function buildSkillCheckViewContext"
  );

  assert.match(requestBatch, /messageData = \{\}/);
  assert.match(requestBatch, /publishSkillCheckOutcomeMessages\(presentableOutcomes, \{[\s\S]*?messageData/);
  assert.match(collector, /createSkillCheckBatchCollector\(\{ requester = "", title = "", messageData = \{\} \}/);
  assert.match(collector, /publishSkillCheckOutcomeMessages\(normalizedOutcomes, \{[\s\S]*?messageData/);
  assert.match(outcomePublisher, /publishSkillCheckBatchMessage\(actorOutcomes, \{ requester, title, messageData \}\)/);
  assert.match(outcomePublisher, /publishSkillCheckMessage\(actorOutcomes\[0\], \{ requester, messageData \}\)/);
  assert.match(outcomePublisher, /\.\.\.normalizeSkillCheckMessageData\(messageData\)/);
  assert.match(singlePublisher, /\.\.\.normalizeSkillCheckMessageData\(messageData\)/);
  assert.match(
    skillCheckSource,
    /messageData\.author !== undefined \? \{ author: messageData\.author \} : \{\}/
  );
});
