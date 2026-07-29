import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url),
  "utf8"
);

function sliceBetween(startText, endText, fromIndex = 0) {
  const start = source.indexOf(startText, fromIndex);
  assert.notEqual(start, -1, `Missing start marker: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing end marker: ${endText}`);
  return source.slice(start, end);
}

function sliceSection(value, startText, endText, fromIndex = 0) {
  const start = value.indexOf(startText, fromIndex);
  assert.notEqual(start, -1, `Missing section start: ${startText}`);
  const end = value.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing section end: ${endText}`);
  return value.slice(start, end);
}

test("ordinary and commanded mouse movement queue one latest-frame refresh", () => {
  const commanded = sliceBetween(
    "class CommandedWeaponAttackController",
    "function serializeCommandedAttackSelection"
  );
  const ordinary = sliceBetween(
    "class WeaponAttackController",
    "function normalizeAttackOriginOverride"
  );

  for (const controller of [commanded, ordinary]) {
    const onMove = sliceSection(
      controller,
      "\n  onMove(event) {",
      "\n  onPointerDown(event) {"
    );
    assert.match(onMove, /previewFrameScheduler\.request\(\)/);
    assert.doesNotMatch(onMove, /this\.refresh\(/);
    assert.match(controller, /previewFrameScheduler\.destroy\(\)/);
  }
});

test("pointer confirmation flushes the newest frame before attack resolution", () => {
  const ordinary = sliceBetween(
    "class WeaponAttackController",
    "function normalizeAttackOriginOverride"
  );
  const updatePointer = sliceSection(
    ordinary,
    "\n  updatePointerFromClientEvent(event) {",
    "\n  unlockAimedTarget() {"
  );

  assert.match(updatePointer, /previewFrameScheduler\.request\(\)/);
  assert.match(updatePointer, /previewFrameScheduler\.flush\(\)/);
});

test("both interactive burst previews explicitly use the bounded preview policy", () => {
  const previewCalls = [...source.matchAll(
    /buildBurstTargetRanges\([\s\S]*?\{\s*purpose:\s*"preview"\s*\}\s*\)/g
  )];
  assert.ok(previewCalls.length >= 2);
});

test("burst resolution computes one exact distribution and reuses it", () => {
  const burst = sliceBetween(
    "async performBurstAttack",
    "onAimedConfirm"
  );

  assert.match(
    burst,
    /const exactDistribution = getBurstTargetHitDistribution\([\s\S]*?purpose:\s*"resolution"/
  );
  assert.match(
    burst,
    /buildBurstTargetRanges\([\s\S]*?distribution:\s*exactDistribution/
  );
  assert.match(
    burst,
    /buildBurstPrimaryShotsForRanges\([\s\S]*?distribution:\s*exactDistribution/
  );
  assert.equal(
    (burst.match(/getBurstTargetHitDistribution\(/g) ?? []).length,
    1
  );
});
