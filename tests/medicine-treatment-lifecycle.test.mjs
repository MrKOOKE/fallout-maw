import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const medicineSource = await readFile(
  new URL("../src/apps/medicine-dialog.mjs", import.meta.url),
  "utf8"
);
const limitedUsesSource = await readFile(
  new URL("../src/abilities/limited-uses.mjs", import.meta.url),
  "utf8"
);
const damageHubSource = await readFile(
  new URL("../src/combat/damage-hub.mjs", import.meta.url),
  "utf8"
);

function collectNamedFunctions(source) {
  const matches = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)];
  return new Map(matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? source.length;
    return [match[1], source.slice(match.index, end)];
  }));
}

const medicineFunctions = collectNamedFunctions(medicineSource);
const limitedUseFunctions = collectNamedFunctions(limitedUsesSource);
const damageHubFunctions = collectNamedFunctions(damageHubSource);

function sliceFunction(functions, name) {
  const source = functions.get(name);
  assert.ok(source, `${name} source was not found`);
  return source;
}

function collectCallClosure(fragment, functions = medicineFunctions) {
  const visited = new Set();
  const queue = [fragment];
  const sources = [fragment];
  while (queue.length) {
    const current = queue.shift();
    for (const [name, source] of functions) {
      if (visited.has(name) || !new RegExp(`\\b${name}\\s*\\(`).test(current)) continue;
      visited.add(name);
      sources.push(source);
      queue.push(source);
    }
  }
  return sources;
}

function findFunctionContaining(functions, requiredTokens) {
  const entry = [...functions].find(([, source]) => (
    requiredTokens.every(token => source.includes(token))
  ));
  assert.ok(entry, `function containing ${requiredTokens.join(", ")} was not found`);
  return entry;
}

function countMatches(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

function extractBalancedObject(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex >= 0, `${marker} call was not found`);
  const start = source.indexOf("{", markerIndex + marker.length);
  assert.ok(start >= 0, `${marker} options object was not found`);
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
  assert.fail(`${marker} options object was not closed`);
}

test("one medicine treatment owns one cancellable terminal system-event lifecycle", () => {
  const authorityEntry = sliceFunction(medicineFunctions, "resolveTreatmentOnAuthority");
  const authorityClosure = collectCallClosure(authorityEntry);
  const authoritySource = authorityClosure.join("\n");
  const [, lifecycle] = findFunctionContaining(medicineFunctions, [
    "fallout-maw.medicine.treatment.before",
    "fallout-maw.medicine.treatment.resolved",
    "runTerminalSystemEventWorkflow("
  ]);
  const lifecycleClosure = collectCallClosure(lifecycle).join("\n");

  assert.match(authoritySource, /withSystemEventRoot\s*\(/);
  assert.ok(authoritySource.includes(lifecycle), "the authority entrypoint must own the treatment lifecycle");
  assert.equal(countMatches(lifecycle, /runTerminalSystemEventWorkflow\s*\(/g), 1);
  assert.equal(countMatches(lifecycle, /fallout-maw\.medicine\.treatment\.before/g), 1);
  assert.equal(countMatches(lifecycle, /fallout-maw\.medicine\.treatment\.resolved/g), 1);
  assert.match(lifecycle, /beforeEventKey:\s*["']fallout-maw\.medicine\.treatment\.before["']/);
  assert.match(lifecycle, /resolvedEventKey:\s*["']fallout-maw\.medicine\.treatment\.resolved["']/);
  assert.match(lifecycle, /occurrenceBase/);
  assert.match(lifecycle, /participants/);
  assert.match(lifecycle, /operation\s*:/);
  assert.match(lifecycle, /getResultStatus\s*:/);

  for (const status of ["committed", "alreadyComplete", "failed", "cancelled"]) {
    assert.match(lifecycleClosure, new RegExp(`["']${status}["']`));
  }
  for (const field of [
    "operationId",
    "sourceActorUuid",
    "targetActorUuid",
    "sourceTokenUuid",
    "targetTokenUuid",
    "treatmentType",
    "treatmentId",
    "instrumentId",
    "toolKey"
  ]) {
    assert.match(lifecycleClosure, new RegExp(`\\b${field}\\b`), `medicine event data must include ${field}`);
  }

  assert.match(lifecycleClosure, /source:\s*[^,\n]*(?:sourceActor|healer)/);
  assert.match(lifecycleClosure, /target:\s*[^,\n]*(?:targetActor|patient)/);
  assert.doesNotMatch(lifecycle, /\.toObject\s*\(/, "event envelopes must contain plain receipts, not Documents");
});

test("limb treatment delegates its complete atomic commit to the damage-hub healing lifecycle", () => {
  const healingAdapter = sliceFunction(damageHubFunctions, "runExternalHealingSystemEventWorkflow");
  const damageWorkflow = sliceFunction(damageHubFunctions, "executeDamageSystemEventWorkflow");
  const damageWorkflowClosure = collectCallClosure(damageWorkflow, damageHubFunctions).join("\n");
  const authorityClosure = collectCallClosure(
    sliceFunction(medicineFunctions, "resolveTreatmentOnAuthority")
  ).join("\n");
  const treatmentOperation = sliceFunction(medicineFunctions, "resolveTreatmentOnAuthorityOperation");
  const treatmentOperationClosure = collectCallClosure(treatmentOperation).join("\n");
  const commit = sliceFunction(medicineFunctions, "commitTreatmentToActors");

  assert.match(healingAdapter, /^export\s+async\s+function\s+runExternalHealingSystemEventWorkflow\s*\(/);
  assert.match(healingAdapter, /executeDamageSystemEventWorkflow\s*\(/);
  assert.match(healingAdapter, /\boperation\b/);
  assert.match(healingAdapter, /actorUuid/);
  assert.match(healingAdapter, /limbKey/);
  assert.match(healingAdapter, /amount/);
  assert.match(healingAdapter, /(?:mode:\s*["']healing["']|MODE_HEALING)/);
  assert.match(healingAdapter, /single:\s*true/);
  assert.match(damageWorkflow, /fallout-maw\.healing\.beforeApply/);
  assert.match(damageWorkflowClosure, /fallout-maw\.healing\.resolved/);
  assert.match(damageWorkflow, /allowed\.length\s*\?\s*await\s+operation\s*\(/);
  assert.match(damageWorkflowClosure, /\bbefore\b/);
  assert.match(damageWorkflowClosure, /\bafter\b/);
  assert.match(damageWorkflowClosure, /\bdelta\b/);
  assert.doesNotMatch(medicineSource, /fallout-maw\.healing\.(?:beforeApply|resolved)/);

  assert.match(treatmentOperation, /treatmentType\s*===\s*["']limb["']/);
  assert.match(treatmentOperationClosure, /runExternalHealingSystemEventWorkflow\s*\(/);
  assert.ok(
    authorityClosure.includes(treatmentOperation)
      && authorityClosure.includes(commit)
      && authorityClosure.includes("runExternalHealingSystemEventWorkflow("),
    "limb healing must remain inside the treatment authority root"
  );
  const lifecycleOptions = extractBalancedObject(
    treatmentOperationClosure,
    "runExternalHealingSystemEventWorkflow("
  );
  assert.match(treatmentOperationClosure, /runExternalHealingSystemEventWorkflow\s*\([\s\S]*?async\s*\([^)]*\)\s*=>/);
  assert.match(treatmentOperationClosure, /async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?await\s+commitTreatmentToActors\s*\(/);
  assert.match(lifecycleOptions, /actorUuid/);
  assert.match(lifecycleOptions, /limbKey/);
  assert.match(lifecycleOptions, /amount/);
  assert.equal(countMatches(commit, /executeInventoryMutation\s*\(/g), 1);
  assert.match(commit, /synchronizeActorDamageStatusesAfterInventoryMutation\s*\(\s*targetActor\s*\)/);
  assert.ok(
    commit.indexOf("executeInventoryMutation(")
      < commit.indexOf("synchronizeActorDamageStatusesAfterInventoryMutation("),
    "healing.resolved may be emitted only after the batch and its damage-status barrier"
  );
});

test("manual medicine healing consumption skips both generic limited-use lanes", () => {
  const treatmentOperationClosure = collectCallClosure(
    sliceFunction(medicineFunctions, "resolveTreatmentOnAuthorityOperation")
  ).join("\n");
  const healingRequest = extractBalancedObject(
    treatmentOperationClosure,
    "runExternalHealingSystemEventWorkflow("
  );
  const capture = sliceFunction(limitedUseFunctions, "captureLimitedUsesBeforeDamage");

  assert.match(healingRequest, /limitedUseSkipOutgoing:\s*true/);
  assert.match(healingRequest, /limitedUseSkipIncoming:\s*true/);
  assert.match(
    capture,
    /if\s*\(\s*sourceData\?\.limitedUseSkipIncoming\s*!==\s*true\s*\)\s*\{[\s\S]*?captureActorLimitedUseCandidates\(\s*targetActor/,
    "incoming healing uses must not be captured after medicine consumed them manually"
  );
  assert.match(
    capture,
    /if\s*\(\s*sourceActor\s*&&\s*sourceData\?\.limitedUseSkipOutgoing\s*!==\s*true\s*\)\s*\{[\s\S]*?captureActorLimitedUseCandidates\(\s*sourceActor/,
    "outgoing healing uses must not be captured after medicine consumed them manually"
  );

  const consume = sliceFunction(limitedUseFunctions, "consumeLimitedUsesForDamageEvent");
  const capturedBranch = consume.indexOf("captured !== null");
  const healingFallback = consume.indexOf(
    'event?.key ?? "") === "fallout-maw.healing.resolved"'
  );
  assert.ok(
    capturedBranch >= 0 && healingFallback >= 0 && capturedBranch < healingFallback,
    "an intentionally empty before-event capture must suppress resolved-event fallback consumption"
  );
});

test("blocked healing exits before checks and is revalidated before the atomic commit callback", () => {
  const treatmentOperation = sliceFunction(medicineFunctions, "resolveTreatmentOnAuthorityOperation");
  const initialGate = treatmentOperation.indexOf("!canActorReceiveHealing(targetActor)");
  const checks = treatmentOperation.indexOf("await runTreatmentChecks(");
  const adapterCall = treatmentOperation.indexOf("runExternalHealingSystemEventWorkflow(");
  const commitCall = treatmentOperation.indexOf("await commitTreatmentToActors(");

  assert.ok(initialGate >= 0, "authority must reject an actor that cannot receive healing");
  assert.ok(checks >= 0 && initialGate < checks, "the healing gate must run before any treatment check");
  assert.match(
    treatmentOperation.slice(initialGate, checks),
    /return\s*\{[\s\S]*?status:\s*["']failed["'][\s\S]*?\}/,
    "the initial blocked-healing branch must terminate without rolling"
  );
  assert.ok(
    adapterCall >= 0 && commitCall > adapterCall,
    "the medicine commit must remain inside the damage-hub adapter callback"
  );

  const adapter = sliceFunction(damageHubFunctions, "runExternalHealingSystemEventWorkflow");
  const serializedMutation = adapter.indexOf("queueActorDamageMutation(");
  const revalidation = adapter.indexOf("isHealingBlocked(freshActor)", serializedMutation);
  const externalCallback = adapter.indexOf("await operation(", revalidation);
  assert.ok(serializedMutation >= 0, "external healing must be serialized per actor");
  assert.ok(
    revalidation > serializedMutation && externalCallback > revalidation,
    "the fresh authoritative Actor must be revalidated before the external mutation callback"
  );
  assert.match(
    adapter.slice(revalidation, externalCallback),
    /return\s+createFailedExternalHealingResult\s*\([^;]*["']healing-blocked["'][^;]*\);/,
    "a newly blocked Actor must return before the medicine commit callback"
  );

  const checksFunction = sliceFunction(medicineFunctions, "runTreatmentChecks");
  const commit = sliceFunction(medicineFunctions, "commitTreatmentToActors");
  assert.doesNotMatch(
    checksFunction,
    /executeInventoryMutation\s*\(|system\.functions\.tools\.[^\s]*supply\.value/,
    "treatment checks must not spend the medical tool before the guarded commit"
  );
  assert.match(commit, /system\.functions\.tools\.\$\{normalizedToolKey\}\.supply\.value/);
});
