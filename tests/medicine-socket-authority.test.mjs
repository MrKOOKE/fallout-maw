import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const medicineSource = await readFile(
  new URL("../src/apps/medicine-dialog.mjs", import.meta.url),
  "utf8"
);
const itemFunctionsSource = await readFile(
  new URL("../src/utils/item-functions.mjs", import.meta.url),
  "utf8"
);

function collectNamedFunctions(source) {
  const matches = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)];
  return new Map(matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? source.length;
    return [match[1], source.slice(match.index, end)];
  }));
}

const namedFunctions = collectNamedFunctions(medicineSource);
const treatmentSocketAction = medicineSource.includes('requestMedicineSocket("performTreatment"')
  ? "performTreatment"
  : "applyTreatment";

function sliceFunction(name) {
  const source = namedFunctions.get(name);
  assert.ok(source, `${name} source was not found`);
  return source;
}

function sliceNamedFunction(source, name) {
  const functions = collectNamedFunctions(source);
  const body = functions.get(name);
  assert.ok(body, `${name} source was not found`);
  return body;
}

function sliceActionBranch(handler, action) {
  const marker = new RegExp(`if\\s*\\(\\s*action\\s*===\\s*["']${action}["']\\s*\\)\\s*\\{`);
  const match = marker.exec(handler);
  assert.ok(match, `${action} socket branch was not found`);
  const start = match.index;
  const remainder = handler.slice(start + match[0].length);
  const nextBranch = /\n\s*if\s*\(\s*action\s*===/.exec(remainder);
  const unknownAction = /\n\s*throw\s+new\s+Error\(`неизвестное действие медицины/.exec(remainder);
  const ends = [nextBranch?.index, unknownAction?.index].filter(Number.isInteger);
  const end = ends.length ? Math.min(...ends) : remainder.length;
  return handler.slice(start, start + match[0].length + end);
}

function collectCallClosure(fragment) {
  const visited = new Set();
  const queue = [fragment];
  const sources = [fragment];
  while (queue.length) {
    const current = queue.shift();
    for (const [name, source] of namedFunctions) {
      if (visited.has(name) || !new RegExp(`\\b${name}\\s*\\(`).test(current)) continue;
      visited.add(name);
      sources.push(source);
      queue.push(source);
    }
  }
  return sources.join("\n");
}

function extractBalancedObject(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex >= 0, `${marker} call was not found`);
  const start = source.indexOf("{", markerIndex + marker.length);
  assert.ok(start >= 0, `${marker} inline intent object was not found`);

  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${marker} inline intent object was not closed`);
}

function assertIntentOnly(source, label) {
  for (const field of ["finalProgress", "completed", "remainingSupply"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`(?:^|[,\\{])\\s*${field}\\s*(?::|[,\\}])`, "m"),
      `${label} must not accept a client-authored ${field}`
    );
  }
}

test("treatment client sends intent, never an authored outcome", () => {
  const perform = sliceFunction("performTreatment");
  const apply = sliceFunction("applyTreatmentToTarget");
  const performIntent = extractBalancedObject(perform, "applyTreatmentToTarget(targetContext,");
  const socketIntent = extractBalancedObject(
    apply,
    `requestMedicineSocket("${treatmentSocketAction}",`
  );
  const applySignature = apply.slice(0, apply.indexOf(") {", apply.indexOf("function ")) + 3);

  assert.doesNotMatch(perform, /runTreatmentChecks\s*\(/);
  assertIntentOnly(performIntent, "performTreatment intent");
  assertIntentOnly(applySignature, "applyTreatmentToTarget parameters");
  assertIntentOnly(socketIntent, "applyTreatment socket payload");
});

test("treatment is resolved and rolled again on the GM authority before commit", () => {
  const handler = sliceFunction("handleMedicineSocketRequest");
  const branch = sliceActionBranch(handler, treatmentSocketAction);
  const authorityClosure = collectCallClosure(branch);

  assert.match(branch, /sourceActorUuid/);
  for (const field of ["finalProgress", "completed", "remainingSupply"]) {
    assert.doesNotMatch(branch, new RegExp(`payload\\.${field}`));
  }
  assert.match(authorityClosure, /buildTargetContext\s*\(\s*(?:targetActor|actor)(?:\s*,[^)]*)?\)/);
  assert.match(authorityClosure, /getTargetTreatments\s*\(/);
  assert.match(authorityClosure, /(?:sourceActor\?*\.items\?*\.get|sourceActor\?\.items\?\.get)\s*\(/);
  assert.match(authorityClosure, /getToolFunction\s*\(/);
  assert.match(authorityClosure, /runTreatmentChecks\s*\(/);
  assert.match(authorityClosure, /commitTreatmentToActors\s*\(/);

  const coordinator = [...namedFunctions.entries()].find(([name, source]) => (
    name !== "performTreatment"
    && authorityClosure.includes(source)
    && source.includes("runTreatmentChecks(")
    && source.includes("commitTreatmentToActors(")
  ));
  assert.ok(coordinator, "one authoritative coordinator must own both treatment checks and commit");
  const [, coordinatorSource] = coordinator;
  assert.ok(
    coordinatorSource.indexOf("runTreatmentChecks(") < coordinatorSource.indexOf("commitTreatmentToActors("),
    "the authority must roll before it commits the resulting mutation"
  );
});

test("authoritative treatment rejects a broken medical instrument", () => {
  const handler = sliceFunction("handleMedicineSocketRequest");
  const branch = sliceActionBranch(handler, treatmentSocketAction);
  const authorityClosure = collectCallClosure(branch);
  const hasItemFunction = sliceNamedFunction(itemFunctionsSource, "hasItemFunction");
  const brokenSuppression = sliceNamedFunction(
    itemFunctionsSource,
    "isItemFunctionSuppressedByBrokenCondition"
  );

  assert.match(
    authorityClosure,
    /hasItemFunction\s*\(\s*instrument\s*,\s*createToolFunctionKey\s*\(/
  );
  assert.match(hasItemFunction, /ignoreBroken\s*=\s*false/);
  assert.match(hasItemFunction, /!ignoreBroken\s*&&\s*isItemFunctionSuppressedByBrokenCondition\s*\(/);
  assert.match(brokenSuppression, /isItemBrokenByCondition\s*\(/);
});

test("every implant and prosthesis socket mutation requires an owned explicit source actor", () => {
  const handler = sliceFunction("handleMedicineSocketRequest");
  assert.doesNotMatch(handler, /fromUuid\s*\([^;\n]*sourceActorUuid[^;\n]*\)\s*\?\?\s*actor/);

  for (const action of [
    "performImplantInstallation",
    "removeImplant",
    "performProsthesisInstallation",
    "removeProsthesis"
  ]) {
    const branch = sliceActionBranch(handler, action);
    const authorityClosure = collectCallClosure(branch);
    assert.match(authorityClosure, /sourceActorUuid/, `${action} must resolve the requested source actor UUID`);
    assert.match(authorityClosure, /fromUuid\s*\(/, `${action} must resolve the source as a real document`);
    assert.match(authorityClosure, /throw\s+new\s+Error/, `${action} must reject a missing source actor`);
    assert.match(
      authorityClosure,
      /assertMedicineSocketActorOwner\s*\(/,
      `${action} must verify requester ownership of the source actor`
    );
    assert.doesNotMatch(authorityClosure, /fromUuid\s*\([^;\n]*sourceActorUuid[^;\n]*\)\s*\?\?\s*actor/);
  }
});

test("critical implant and prosthesis failures are outcomes, not callable socket actions", () => {
  const handler = sliceFunction("handleMedicineSocketRequest");
  for (const action of ["implantCriticalFailure", "prosthesisCriticalFailure"]) {
    assert.doesNotMatch(
      medicineSource,
      new RegExp(`requestMedicineSocket\\(\\s*["']${action}["']`),
      `${action} must not be client-callable`
    );

    const actionMarker = new RegExp(`action\\s*===\\s*["']${action}["']`);
    if (!actionMarker.test(handler)) continue;
    const branch = sliceActionBranch(handler, action);
    assert.match(branch, /throw\s+new\s+Error/, `${action} may only remain as an explicit rejection`);
    assert.doesNotMatch(branch, /apply(?:Implant|Prosthesis)CriticalFailureLocally\s*\(/);
  }
});

test("medicine socket authenticates the Foundry sender on requests and responses", () => {
  const handler = sliceFunction("handleMedicineSocketMessage");

  assert.match(medicineSource, /const MEDICINE_SOCKET_TIMEOUT = 12 \* 60 \* 1000/);
  assert.match(handler, /senderUserId/);
  assert.match(handler, /authenticatedSenderId !== pending\.gmUserId/);
  assert.match(handler, /authenticatedSenderId !== String\(message\.requesterUserId/);
});
