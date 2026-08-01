import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const abilityActionsSource = await readFile(
  new URL("../src/abilities/ability-actions.mjs", import.meta.url),
  "utf8"
);
const fixedFunctionsSource = await readFile(
  new URL("../src/abilities/fixed-functions.mjs", import.meta.url),
  "utf8"
);

test("ability-action preflights route ranged aimed attacks through the effective-range validator", () => {
  const optionReach = sliceSource(
    abilityActionsSource,
    "export function abilityWeaponAttackOptionCanReach",
    "export function getConfiguredActionPointCost"
  );
  const randomTarget = sliceSource(
    abilityActionsSource,
    "export async function pickRandomAbilityFreeAttackTarget",
    "function findFreshOption"
  );

  assert.match(
    optionReach,
    /option\.actionKey === "aimedShot"[\s\S]*canPerformAimedAttackAgainstToken\(/
  );
  assert.match(
    randomTarget,
    /freshOption\.actionKey === "aimedShot"[\s\S]*canPerformAimedAttackAgainstToken\(/
  );
  assert.match(randomTarget, /:\s*collectValidWeaponAttackTargets\(/);
});

test("Oversight uses the aimed effective-range preflight both for offers and final revalidation", () => {
  const oversight = sliceSource(
    fixedFunctionsSource,
    "async function executeOversightReaction",
    "async function queryOversightAttackOwner"
  );
  const routedCalls = oversight.match(/canPerformOversightAttackAgainstToken\(/g) ?? [];

  assert.equal(routedCalls.length, 3, "helper definition plus candidate and final preflight calls");
  assert.match(
    oversight,
    /options\.actionKey === "aimedShot"[\s\S]*canPerformAimedAttackAgainstToken\(options\)[\s\S]*canPerformWeaponActionAgainstToken\(options\)/
  );
});

function sliceSource(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
