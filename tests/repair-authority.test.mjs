import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/apps/repair-dialog.mjs", import.meta.url), "utf8");
const template = await readFile(
  new URL("../templates/actor/repair-dialog.hbs", import.meta.url),
  "utf8"
);

function sliceFunction(name) {
  const match = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m").exec(source);
  assert.ok(match, `${name} source was not found`);
  const next = /^(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/gm;
  next.lastIndex = match.index + match[0].length;
  const end = next.exec(source)?.index ?? source.length;
  return source.slice(match.index, end);
}

test("repair clients send intent while the authority re-resolves and calculates the operation", () => {
  const client = sliceFunction("performRepair");
  const authority = sliceFunction("resolveRepairOnAuthorityOperation");
  const socket = sliceFunction("handleRepairSocketRequest");

  assert.match(client, /requestRepairResolution\("performRepair"/);
  assert.match(client, /itemId,[\s\S]*instrumentId,[\s\S]*methodIndex/);
  assert.doesNotMatch(client, /runRepairChecks|calculateRepairResult|finalValue|remainingSupply/);
  assert.match(authority, /normalizeRecoveryMethods\(condition\.recoveryMethods/);
  assert.match(authority, /hasItemFunction\(instrument, createToolFunctionKey\(method\.toolKey\)\)/);
  assert.match(authority, /runRepairChecks\(\{/);
  assert.match(authority, /commitRepairToActors\(\{/);
  assert.match(socket, /resolveRepairOnAuthority\(\{/);
  assert.doesNotMatch(socket, /payload\.(?:finalValue|remainingSupply|expectedCondition|expectedSupply)/);
});

test("repair delegates to the same active GM used by Foundry system-event authority", () => {
  const responsible = sliceFunction("getResponsibleGM");
  const request = sliceFunction("requestRepairResolution");

  assert.match(responsible, /game\.users\?\.activeGM/);
  assert.doesNotMatch(responsible, /\.sort\(/);
  assert.match(request, /game\.user\?\.isGM && game\.user\.id === gm\.id/);
});

test("repair authority serializes actors, deduplicates sockets and gives every check a unique operation identity", () => {
  const resolver = sliceFunction("resolveRepairOnAuthority");
  const once = sliceFunction("handleRepairSocketRequestOnce");
  const checks = sliceFunction("runRepairChecks");

  assert.match(source, /const REPAIR_SOCKET_TIMEOUT = 12 \* 60 \* 1000/);
  assert.match(resolver, /runWithRepairAuthorityLocks/);
  assert.match(once, /handledRepairSocketRequests\.get\(key\)/);
  assert.match(once, /handledRepairSocketRequests\.set\(key, entry\)/);
  assert.match(checks, /`\$\{operationId\}:check:\$\{index\}`/);
  assert.match(checks, /chanceOperationId:\s*checkOperationId/);
  assert.match(checks, /systemEventOperationId:\s*operationId/);
  assert.match(checks, /chainRef,/);
  assert.match(checks, /options:\s*\{ operationId: checkOperationId \}/);
});

test("repair commit revalidates both live leaves before one exact atomic update", () => {
  const commit = sliceFunction("commitRepairToActors");

  assert.match(commit, /getConditionFunction\(targetItem\)\.value/);
  assert.match(commit, /getToolFunction\(instrument, instrumentToolKey\)\.supply\?\.value/);
  assert.match(commit, /currentCondition !== Math\.max\(0, toInteger\(expectedCondition\)\)/);
  assert.match(commit, /currentSupply !== Math\.max\(0, toInteger\(expectedSupply\)\)/);
  assert.match(commit, /hasItemFunction\(instrument, createToolFunctionKey\(instrumentToolKey\)\)/);
  assert.match(commit, /createRepairInputFingerprint/);
  assert.match(commit, /currentInputFingerprint !== expectedInputFingerprint/);
  assert.equal((commit.match(/executeAtomicActorItemUpdates\(/g) ?? []).length, 1);
});

test("mass repair selects tool groups and policies, then runs as one sequential authority intent", () => {
  const prompt = sliceFunction("promptMassRepairOptions");
  const client = sliceFunction("performMassRepair");
  const authority = sliceFunction("resolveMassRepairOnAuthorityOperation");
  const resolver = sliceFunction("resolveMassRepairOnAuthority");
  const emitter = sliceFunction("emitMassRepairResolved");

  assert.match(prompt, /groupToolSelectionOptions/);
  assert.match(prompt, /name="toolGroup"/);
  assert.match(prompt, /name="qualityMode"[\s\S]*value="matched"[\s\S]*value="best"/);
  assert.match(prompt, /name="supplyMode"[\s\S]*value="depleted"[\s\S]*value="balanced"/);
  assert.match(prompt, /modal:\s*true/);
  assert.match(prompt, /render:\s*\(_event,\s*dialog\)\s*=>\s*bindMassOperationDialogSubmitState/);
  assert.match(prompt, /getMassOperationDialogSelectionState\(form/);
  assert.doesNotMatch(prompt, /return false/);
  assert.match(client, /requestRepairResolution\("performMassRepair"/);
  assert.doesNotMatch(client, /performRepair\(/);
  assert.match(authority, /chooseBestRepairOption/);
  assert.match(authority, /const currentAvailability = getMassRepairAvailability\(/);
  assert.match(authority, /if\s*\(\s*!currentAvailability\.ok\s*\)\s*throw new Error\(currentAvailability\.message\)/);
  assert.match(authority, /resolveRepairOnAuthority/);
  assert.doesNotMatch(authority, /runRepairLifecycle|withSystemEventRoot/);
  assert.doesNotMatch(resolver, /runWithRepairAuthorityLocks/);
  assert.match(authority, /buildTargetContext\(targetActor, targetToken, contextToolKey\)/);
  assert.match(emitter, /fallout-maw\.repair\.batch\.resolved/);
  assert.doesNotMatch(authority, /postRepairResultChat|postRepairChat/);
});

test("mass repair remains selectable for damaged targets and explains unavailable tools", () => {
  const prompt = sliceFunction("promptMassRepairOptions");
  const availability = sliceFunction("getMassRepairAvailability");

  assert.match(source, /hasRepairableItems:\s*items\.length\s*>\s*0/);
  assert.doesNotMatch(source, /hasRepairableItems:\s*items\.some\([^)]*usableInstrumentCount/);
  assert.match(prompt, /const availability = getMassRepairAvailability\(/);
  assert.match(prompt, /if\s*\(\s*!availability\.ok\s*\)/);
  assert.match(prompt, /ui\.notifications\.warn\(availability\.message\)/);
  assert.match(availability, /analyzeMassRepairToolAvailability\(\{/);
  assert.match(availability, /getRepairSkillThreshold\(/);
});

test("repair target opens tool selection while the selected instrument says choose", () => {
  assert.match(
    template,
    /data-action="startRepair"[\s\S]*?\{\{#if active\}\}Скрыть\{\{else\}\}Ремонт\{\{\/if\}\}/
  );
  assert.match(
    template,
    /data-action="repairWithInstrument"[\s\S]*?>\s*Выбрать\s*<\/button>/
  );
});

test("broken tool functions never enter repair selection", () => {
  const instruments = sliceFunction("prepareRepairInstruments");
  assert.match(instruments, /hasItemFunction\(item, createToolFunctionKey\(toolKey\)\)/);
});

test("repair authority pins the configured action tool and exact token actors", () => {
  const validator = sliceFunction("validateRepairToolKey");
  const singleResolver = sliceFunction("resolveRepairOnAuthority");
  const massResolver = sliceFunction("resolveMassRepairOnAuthority");

  assert.match(validator, /entry\.key === "repair"/);
  assert.match(validator, /requested !== configured/);
  assert.equal(singleResolver.match(/assertRepairTokenMatchesActor\(/g)?.length, 2);
  assert.equal(massResolver.match(/assertRepairTokenMatchesActor\(/g)?.length, 2);
});

test("repair socket authenticates the Foundry sender rather than its claimed user id", () => {
  const handler = sliceFunction("handleRepairSocketMessage");

  assert.match(handler, /senderUserId/);
  assert.match(handler, /authenticatedSenderId !== pending\.gmUserId/);
  assert.match(handler, /authenticatedSenderId !== String\(message\.requesterUserId/);
});

test("mass repair retries wait for the same authority request after a timeout", () => {
  const request = sliceFunction("requestRepairSocket");
  const authority = sliceFunction("requestRepairResolution");

  assert.match(source, /#pendingMassRepair/);
  assert.match(source, /requestId:\s*pending\.requestId/);
  assert.match(request, /resolvedRequestId/);
  assert.match(request, /error\.code = "authority-timeout"/);
  assert.match(authority, /return \{ pending: true, requestId: stableRequestId \}/);
});
