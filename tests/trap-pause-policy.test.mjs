import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldPauseAfterTrapDetection } from "../src/canvas/trap-pause-policy.mjs";

const TRAPS_SOURCE = readFileSync(new URL("../src/canvas/traps.mjs", import.meta.url), "utf8");

test("trap detection pauses outside combat and does not pause during started combat", () => {
  assert.equal(shouldPauseAfterTrapDetection(null), true);
  assert.equal(shouldPauseAfterTrapDetection({ started: false }), true);
  assert.equal(shouldPauseAfterTrapDetection({ started: true }), false);
});

test("only successful detection uses the combat pause guard; trap activation still pauses", () => {
  const detection = getFunctionBody("handleTrapDetectionForToken", "handleTrapActivationForToken");
  const activationNotice = getFunctionBody("announceTrapTriggerEnterNow", "activateTrapTileNow");

  assert.match(
    detection,
    /if \(shouldPauseAfterTrapDetection\(game\.combat\)\) pauseGameForTrap\(\);/
  );
  assert.match(activationNotice, /pauseGameForTrap\(\);/);
  assert.doesNotMatch(activationNotice, /shouldPauseAfterTrapDetection/);
});

function getFunctionBody(name, nextName) {
  const start = TRAPS_SOURCE.indexOf(`function ${name}`);
  const end = TRAPS_SOURCE.indexOf(`function ${nextName}`, start);
  assert.notEqual(start, -1, `Function ${name} must exist`);
  assert.notEqual(end, -1, `Function ${nextName} must exist after ${name}`);
  return TRAPS_SOURCE.slice(start, end);
}
