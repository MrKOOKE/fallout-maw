import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { toInteger } from "../src/utils/numbers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "src/combat/weapon-attack-controller.mjs"), "utf8");

function sliceBetween(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing start marker: ${startMarker}`);
  assert.ok(end > start, `Missing end marker: ${endMarker}`);
  return SOURCE.slice(start, end);
}

const WHIRLWIND = sliceBetween(
  "async performWhirlwindAttack()",
  "async performConeTargetsAttack"
);

function compileAttacksPerTarget() {
  const match = WHIRLWIND.match(
    /const attacksPerTarget\s*=\s*([\s\S]*?)\s*;\s*\n\s*const plannedAttackCount/
  );
  assert.ok(match, "Whirlwind attacks-per-target expression is missing");
  return Function(
    "toInteger",
    "getActorSkillValue",
    `return function computeAttacksPerTarget() { return ${match[1]}; };`
  )(
    toInteger,
    (actor, skillKey) => toInteger(actor?.system?.skills?.[skillKey]?.value)
  );
}

test("Whirlwind attacks each target 1 + Athletics / 80 times with formula truncation", () => {
  const computeAttacksPerTarget = compileAttacksPerTarget();
  const actor = { system: { skills: { athletics: { value: 0 } } } };
  const controller = { token: { actor } };

  for (const [athletics, expected] of [
    [0, 1],
    [79, 1],
    [80, 2],
    [159, 2],
    [160, 3],
    [240, 4]
  ]) {
    actor.system.skills.athletics.value = athletics;
    assert.equal(computeAttacksPerTarget.call(controller), expected, `Athletics ${athletics}`);
  }
});

test("Whirlwind uses the scaled count for preflight, execution cycles, and final spending", () => {
  assert.match(WHIRLWIND, /const plannedAttackCount\s*=\s*targets\.length \* attacksPerTarget;/);
  assert.match(WHIRLWIND, /this\.hasRequiredWeaponResources\(plannedAttackCount\)/);
  assert.match(
    WHIRLWIND,
    /prepareDuplicateAttackPlan\(\{ attackCount: plannedAttackCount \}\)/
  );
  assert.match(WHIRLWIND, /const totalCycles\s*=\s*attacksPerTarget \* duplicatePlan\.cycles;/);
  assert.match(WHIRLWIND, /cycleIndex < totalCycles/);
  assert.match(WHIRLWIND, /attemptedAttackCount \+= 1;/);
  assert.match(WHIRLWIND, /attackCount:\s*Math\.max\(1, attemptedAttackCount\)/);
  assert.match(WHIRLWIND, /forceBatch:\s*targets\.length > 1 \|\| totalCycles > 1/);

  const preflight = WHIRLWIND.indexOf("this.hasRequiredWeaponResources(plannedAttackCount)");
  const activationCost = WHIRLWIND.indexOf("this.attackModifier.onBeforeAttack");
  assert.ok(preflight >= 0 && preflight < activationCost, "resource preflight must precede ability spending");
});

test("Whirlwind keeps attacking after misses and animates every attack cycle", () => {
  assert.match(
    WHIRLWIND,
    /buildSwingAnimationTrajectory\(this\.token, \[target\], "rightToLeft", this\.geometry\)[\s\S]*delayGroup: cycleIndex/
  );
  assert.match(
    WHIRLWIND,
    /resolveDirectedAttackAgainstTarget\(target,[\s\S]*?if \(this\.attackCanceledByReaction\) break;[\s\S]*?if \(!request\?\.length\) continue;/
  );
  assert.doesNotMatch(WHIRLWIND, /if \(!request\) break;/);
  assert.doesNotMatch(WHIRLWIND, /delayGroup: 0/);
});
