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

function collectNamedFunctions(source) {
  const matches = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)];
  return new Map(matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? source.length;
    return [match[1], source.slice(match.index, end)];
  }));
}

const functions = collectNamedFunctions(medicineSource);

function sliceFunction(name) {
  const source = functions.get(name);
  assert.ok(source, `${name} source was not found`);
  return source;
}

function slicePrivateMethod(name) {
  const marker = new RegExp(`\\n\\s{2}(?:static\\s+)?(?:async\\s+)?#${name}\\s*\\(`);
  const match = marker.exec(medicineSource);
  assert.ok(match, `#${name} source was not found`);
  const start = match.index + 1;
  const remainder = medicineSource.slice(start + 1);
  const next = /\n\s{2}(?:static\s+)?(?:async\s+)?#\w+\s*\(/.exec(remainder);
  return next ? medicineSource.slice(start, start + 1 + next.index) : medicineSource.slice(start);
}

function sliceActionBranch(handler, action) {
  const marker = new RegExp(`if\\s*\\(\\s*action\\s*===\\s*["']${action}["']\\s*\\)\\s*\\{`);
  const match = marker.exec(handler);
  assert.ok(match, `${action} socket branch was not found`);
  const remainder = handler.slice(match.index + match[0].length);
  const next = /\n\s*if\s*\(\s*action\s*===/.exec(remainder);
  const end = next?.index ?? remainder.length;
  return handler.slice(match.index, match.index + match[0].length + end);
}

test("medicine exposes one guarded mass-treatment action only on the limb and trauma tab", () => {
  assert.match(medicineSource, /treatAll:\s*this\.#onTreatAll/);
  const action = slicePrivateMethod("onTreatAll");
  assert.match(action, /promptMassTreatmentOptions\s*\(/);
  assert.match(action, /this\.#runMutation\s*\(/);
  assert.match(action, /performMassTreatment\s*\(/);
  assert.equal(action.match(/render\s*\(\s*\{\s*force:\s*true\s*\}\s*\)/g)?.length, 1);

  assert.match(medicineTemplate, /data-action="treatAll"/);
  assert.match(medicineTemplate, /#if tabs\.trauma\.active[\s\S]*?data-action="treatAll"/);
  assert.match(medicineTemplate, /#unless hasMassTreatments/);
});

test("mass-treatment prompt selects categories and tool policies, never concrete item instances", () => {
  const prompt = sliceFunction("promptMassTreatmentOptions");
  assert.match(prompt, /name="includeTraumas"/);
  assert.match(prompt, /name="includeLimbHealth"/);
  assert.match(prompt, /name="toolGroup"/);
  assert.match(prompt, /name="qualityMode"\s+value="matched"/);
  assert.match(prompt, /name="qualityMode"\s+value="best"/);
  assert.match(prompt, /name="supplyMode"\s+value="depleted"/);
  assert.match(prompt, /name="supplyMode"\s+value="balanced"/);
  assert.doesNotMatch(prompt, /name="instrument"/);
  assert.doesNotMatch(prompt, /selectedInstrumentIds/);
  assert.match(prompt, /render:\s*\(_event,\s*dialog\)\s*=>\s*bindMassOperationDialogSubmitState/);
  assert.match(prompt, /getMassOperationDialogSelectionState\(form/);
  assert.doesNotMatch(prompt, /return false/);
});

test("mass medicine stays clickable for real targets and explains unavailable tools", () => {
  const targetGate = sliceFunction("hasMassTreatmentTargets");
  const prompt = sliceFunction("promptMassTreatmentOptions");
  const availability = sliceFunction("getMassTreatmentAvailability");
  const authority = sliceFunction("resolveMassTreatmentOnAuthorityOperation");

  assert.match(targetGate, /counts\.traumas\s*\+\s*counts\.limbHealth\s*>\s*0/);
  assert.doesNotMatch(targetGate, /instrument/);
  assert.match(prompt, /const availability = getMassTreatmentAvailability\(/);
  assert.match(prompt, /ui\.notifications\.warn\(availability\.message\)/);
  assert.match(availability, /analyzeMedicineToolAvailability\(\{/);
  assert.match(authority, /if\s*\(\s*!availability\.ok\s*\)\s*throw new Error\(availability\.message\)/);
});

test("a medical target opens selection while the instrument action says choose", () => {
  assert.match(
    treatmentRowTemplate,
    /data-action="startTreatment"[\s\S]*?\{\{#if active\}\}Скрыть\{\{else\}\}Лечение\{\{\/if\}\}/
  );
  assert.match(
    treatmentRowTemplate,
    /data-action="treatWithInstrument"[\s\S]*?>\s*Выбрать\s*<\/button>/
  );
});

test("medicine threshold mode covers treatment, implant and prosthesis authority paths", () => {
  const checks = sliceFunction("runTreatmentChecks");
  const implant = sliceFunction("resolveImplantInstallationOnAuthorityLocked");
  const prosthesis = sliceFunction("resolveProsthesisInstallationOnAuthorityLocked");
  const commit = sliceFunction("commitTreatmentToActors");

  assert.match(checks, /resolveMedicineSkillAction\(/);
  assert.match(checks, /resolvedSkill\.resultLabel/);
  assert.match(implant, /resolveMedicineSkillAction\(/);
  assert.match(implant, /skillResolution\.outcome/);
  assert.match(prosthesis, /resolveMedicineSkillAction\(/);
  assert.match(prosthesis, /skillResolution\.outcome/);
  assert.match(commit, /getMedicineResolutionMode\(\)\s*!==\s*expectedMedicineMode/);
  assert.match(commit, /const authoritativeSkill = getMedicineSkillResolution\(/);
});

test("mass-treatment socket sends one intent and the GM rebuilds every outcome", () => {
  const apply = sliceFunction("applyMassTreatmentToTarget");
  const handler = sliceFunction("handleMedicineSocketRequest");
  const branch = sliceActionBranch(handler, "performMassTreatment");

  assert.match(apply, /requestMedicineSocket\(\s*"performMassTreatment"/);
  for (const forbidden of ["finalProgress", "remainingSupply", "completed", "spentCharges", "treatmentId"]) {
    assert.doesNotMatch(apply, new RegExp(`\\b${forbidden}\\s*:`));
    assert.doesNotMatch(branch, new RegExp(`payload\\.${forbidden}\\b`));
  }
  assert.match(branch, /getMedicineSocketSourceActor\s*\(/);
  assert.equal(branch.match(/resolveMedicineTokenForActor\s*\(/g)?.length, 2);
  assert.match(branch, /resolveMassTreatmentOnAuthority\s*\(/);
  assert.match(branch, /options:\s*payload\.options/);
});

test("authoritative mass treatment keeps sequential steps inside the ordinary treatment lifecycle", () => {
  const authority = sliceFunction("resolveMassTreatmentOnAuthorityOperation");
  const client = sliceFunction("performMassTreatment");

  assert.match(authority, /buildTargetContext\s*\(\s*targetActor\s*,\s*targetToken\s*\)/);
  const healingGate = authority.indexOf("!canActorReceiveHealing(targetActor)");
  const coordinator = authority.indexOf("runSequentialMassTreatment(");
  assert.ok(healingGate >= 0 && coordinator > healingGate, "blocked healing must stop before the mass coordinator");
  assert.match(authority, /runSequentialMassTreatment\s*\(/);
  assert.match(authority, /chooseBestTreatmentInstrument\s*\(/);
  assert.match(authority, /resolveTreatmentOnAuthority\s*\(/);
  assert.match(authority, /operationId:\s*`\$\{operationId\}:step:\$\{step\}`/);
  assert.doesNotMatch(authority, /chainRef/);
  assert.doesNotMatch(sliceFunction("resolveMassTreatmentOnAuthority"), /withSystemEventRoot|runWithMedicineAuthorityLocks/);
  assert.equal(client.match(/postMassTreatmentChat\s*\(/g)?.length, 1);
  assert.doesNotMatch(authority, /post(?:TreatmentResult|MassTreatment)Chat\s*\(/);
});

test("medicine authority pins the configured tool type and exact token actors", () => {
  const massResolver = sliceFunction("resolveMassTreatmentOnAuthority");
  const singleResolver = sliceFunction("resolveTreatmentOnAuthority");
  const massOperation = sliceFunction("resolveMassTreatmentOnAuthorityOperation");
  const singleOperation = sliceFunction("resolveTreatmentOnAuthorityOperation");
  const validator = sliceFunction("validateConfiguredMedicineToolKey");

  assert.match(validator, /entry\.key === "medicine"/);
  assert.match(validator, /requested !== configured/);
  assert.match(massOperation, /validateConfiguredMedicineToolKey\(toolKey\)/);
  assert.match(singleOperation, /validateConfiguredMedicineToolKey\(toolKey\)/);
  assert.equal(massResolver.match(/assertMedicineTokenMatchesActor\(/g)?.length, 2);
  assert.equal(singleResolver.match(/assertMedicineTokenMatchesActor\(/g)?.length, 2);
});

test("mass treatment retries keep one stable authority request", () => {
  const socket = sliceFunction("requestMedicineSocket");
  const apply = sliceFunction("applyMassTreatmentToTarget");

  assert.match(medicineSource, /#pendingMassTreatment/);
  assert.match(medicineSource, /requestId:\s*pending\.requestId/);
  assert.match(socket, /resolvedRequestId/);
  assert.match(socket, /error\.code = "authority-timeout"/);
  assert.match(apply, /return \{ pending: true, requestId: stableRequestId \}/);
});
