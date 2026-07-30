import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const medicineSource = await readFile(
  new URL("../src/apps/medicine-dialog.mjs", import.meta.url),
  "utf8"
);

function slicePrivateMethod(source, name) {
  const marker = new RegExp(`\\n\\s{2}(?:static\\s+)?(?:async\\s+)?#${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `#${name} source was not found`);
  const start = match.index + 1;
  const remainder = source.slice(start + 1);
  const next = /\n\s{2}(?:static\s+)?(?:async\s+)?#\w+\s*\(/.exec(remainder);
  return next ? source.slice(start, start + 1 + next.index) : source.slice(start);
}

function slicePrepareContext(source) {
  const start = source.indexOf("  async _prepareContext(");
  assert.ok(start >= 0, "_prepareContext source was not found");
  const end = source.indexOf("\n  async _onRender(", start);
  assert.ok(end > start, "_prepareContext end was not found");
  return source.slice(start, end);
}

function countMatches(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

test("medicine uses one shared mutation guard for every state-changing action", () => {
  assert.equal(countMatches(medicineSource, /#mutationInFlight\s*=\s*false/g), 2);
  assert.doesNotMatch(medicineSource, /#treatmentInFlight/);

  const runMutation = slicePrivateMethod(medicineSource, "runMutation");
  assert.match(runMutation, /if\s*\(\s*this\.#mutationInFlight\s*\)\s*return/);
  assert.match(runMutation, /this\.#mutationInFlight\s*=\s*true/);
  assert.match(runMutation, /try\s*\{/);
  assert.match(runMutation, /await\s+(?:callback|operation|mutation)\s*\(/);
  assert.match(runMutation, /finally\s*\{[\s\S]*?this\.#mutationInFlight\s*=\s*false/);

  for (const methodName of [
    "onTreatWithInstrument",
    "onTreatAll",
    "onInstallImplant",
    "onInstallProsthesis",
    "onRemoveImplant",
    "onRemoveProsthesis"
  ]) {
    const method = slicePrivateMethod(medicineSource, methodName);
    assert.match(method, /this\.#runMutation\(/, `#${methodName} must use the shared mutation guard`);
    assert.doesNotMatch(
      method,
      /this\.#mutationInFlight\s*=/,
      `#${methodName} must not manage the shared flag independently`
    );
  }
});

test("medicine selection and tab actions cannot change state during a mutation", () => {
  for (const methodName of [
    "onStartTreatment",
    "onSetMedicineTab",
    "onSetImplantLimb",
    "onSetProsthesisLimb"
  ]) {
    const method = slicePrivateMethod(medicineSource, methodName);
    assert.match(
      method,
      /if\s*\(\s*this\.#mutationInFlight\s*\)\s*return/,
      `#${methodName} must preserve the current selection while a mutation is pending`
    );
  }
});

test("a completed treatment clears only the treatment selection it originally captured", () => {
  const treat = slicePrivateMethod(medicineSource, "onTreatWithInstrument");
  const activeTypeCheck = treat.search(/this\.#activeTreatmentType\s*===\s*treatmentType/);
  const activeIdCheck = treat.search(/this\.#activeTreatmentId\s*===\s*treatmentId/);
  const clear = treat.search(/this\.#activeTreatmentId\s*=\s*["']["']/);

  assert.ok(activeTypeCheck >= 0, "the completed operation must compare its captured treatment type");
  assert.ok(activeIdCheck >= 0, "the completed operation must compare its captured treatment id");
  assert.ok(clear > activeTypeCheck && clear > activeIdCheck, "selection may clear only after both identity checks");
});

test("medicine render prepares only the currently active heavy tab", () => {
  const prepare = slicePrepareContext(medicineSource);
  const firstTabBranch = prepare.search(
    /switch\s*\(\s*this\.#activeTab\s*\)|if\s*\([^)]*this\.#activeTab|case\s+["'](?:trauma|disease|implant|prosthesis)["']/
  );
  assert.ok(firstTabBranch >= 0, "tab preparation must branch on #activeTab before doing heavy work");

  const calls = [
    ["prepareLimbTreatmentGroups(", "trauma"],
    ["prepareTargetTreatments(", "disease"],
    ["prepareImplantMedicineContext(", "implant"],
    ["prepareProsthesisMedicineContext(", "prosthesis"]
  ];
  for (const [call, tab] of calls) {
    assert.equal(countMatches(prepare, new RegExp(call.replace("(", "\\("), "g")), 1, `${call} must have one lazy call site`);
    const callIndex = prepare.indexOf(call);
    assert.ok(callIndex > firstTabBranch, `${call} must not execute before the active-tab branch`);
    const precedingBranch = prepare.slice(firstTabBranch, callIndex);
    assert.match(
      precedingBranch,
      new RegExp(`(?:case\\s+["']${tab}["']|this\\.#activeTab\\s*===\\s*["']${tab}["'])`),
      `${call} must belong only to the ${tab} branch`
    );
  }

  const instrumentsCall = prepare.indexOf("prepareMedicalInstruments(");
  assert.ok(instrumentsCall > firstTabBranch, "medical instruments must not be scanned for implant/prosthesis renders");
  assert.match(
    prepare.slice(firstTabBranch, instrumentsCall),
    /(?:case\s+["'](?:trauma|disease)["']|this\.#activeTab\s*===\s*["'](?:trauma|disease)["'])/
  );
});
