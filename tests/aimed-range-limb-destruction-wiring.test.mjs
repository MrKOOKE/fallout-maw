import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [controllerSource, damageHubSource, combatEndSource, combatSettingsTemplate] = await Promise.all([
  readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/combat/combat-end-resolution.mjs", import.meta.url), "utf8"),
  readFile(new URL("../templates/settings/combat-settings-config.hbs", import.meta.url), "utf8")
]);

function sliceBetween(source, startText, endText, fromIndex = 0) {
  const start = source.indexOf(startText, fromIndex);
  assert.notEqual(start, -1, `Missing start marker: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing end marker: ${endText}`);
  return source.slice(start, end);
}

test("aimed ability target rows enforce effective range and revalidate before costs", () => {
  const sequence = sliceBetween(
    controllerSource,
    "async function executeAbilityAttackTargetSequence",
    "function collectAbilityAttackTargetSelectionRows"
  );
  const rows = sliceBetween(
    controllerSource,
    "function collectAbilityAttackTargetSelectionRows",
    "function getAbilityAttackTargetRowId"
  );

  assert.match(sequence, /const aimedTargeting = settings\.targeting\?\.aimed === true && !MELEE_ACTION_KEYS\.has\(actionKey\)/);
  assert.match(sequence, /aimed:\s*aimedTargeting/);
  assert.match(rows, /getAimedTargetRangeSelectionState\(\{/);
  assert.match(rows, /const insideAimedRange = aimedRangeState\?\.allowed !== false/);
  assert.match(rows, /const selectable = inRange && targetReachable && insideAimedRange/);
  assert.match(rows, /formatAimedRangeBlockReason\(aimedRangeState\)/);
  assert.match(rows, /contextualAbilitySnapshots:\s*new Map\(\)/);

  const refresh = sequence.indexOf("const refreshedRows = new Map(collectTargetRows()");
  const invalidation = sequence.indexOf("const invalidSelection = selections.find", refresh);
  const costCommit = sequence.indexOf("await payCosts()", invalidation);
  assert.ok(refresh >= 0, "selected target rows must be refreshed after limb selection");
  assert.ok(invalidation > refresh, "refreshed rows must invalidate stale selections");
  assert.ok(costCommit > invalidation, "aimed targets must be revalidated before ability costs are paid");
  assert.match(sequence, /aimedTargeting && !resolveAimedTargetSelection\(selection\.token\?\.actor, selection\.selectedLimbKey\)/);
  assert.match(sequence, /chanceOperationId:\s*String\(row\.chanceOperationId \?\? ""\)/);
  assert.match(sequence, /chanceOperationId:\s*selection\.chanceOperationId/);
  assert.match(rows, /chanceOperationId = aimed[\s\S]*`\$\{selectionOperationId\}:\$\{targetId\}`/);
});

test("all authoritative and constrained aimed-shot execution paths keep the range gate", () => {
  const commanded = sliceBetween(
    controllerSource,
    "async function validateCommandedAttackSelectionGeometry",
    "function isFiniteCommandedPoint"
  );
  const strictEntry = sliceBetween(
    controllerSource,
    "async executeStrictlyAgainstToken",
    "async performStrictSelectedTargetAttack"
  );
  const strictCommit = sliceBetween(
    controllerSource,
    "async performStrictSelectedTargetAttack",
    "  destroy() {"
  );
  const constrained = sliceBetween(
    controllerSource,
    "export async function startConstrainedAimedAttackSelection",
    "export function startForcedAimedAttackSelection"
  );
  const canPerform = sliceBetween(
    controllerSource,
    "export function canPerformAimedAttackAgainstToken",
    "export function getDelayedVolleyWeaponState"
  );

  assert.match(commanded, /actionKey === "aimedShot"[\s\S]*controller\.isAimedTargetInEffectiveRange\(selectedTarget\)/);
  assert.match(strictEntry, /if \(!this\.isAimedTargetInEffectiveRange\(targetToken\)\) return false/);
  assert.match(strictCommit, /if \(!this\.isAimedTargetInEffectiveRange\(targetToken\)\) return false/);
  assert.match(constrained, /!controller\.isAimedTargetInEffectiveRange\(targetToken\)/);
  assert.match(canPerform, /normalizedActionKey === "aimedShot"[\s\S]*getAimedTargetRangeSelectionState\(\{/);
  assert.match(canPerform, /isWeaponActionBlocked\(attacker\.actor, normalizedActionKey\)/);
  assert.match(canPerform, /if \(aimedRangeState\?\.allowed === false\) return false/);
  assert.match(canPerform, /rangeProfile:\s*aimedRangeState\?\.rangeProfile/);
});

test("an unavailable aimed limb menu stays visible with cover-aware chances but disables selection", () => {
  const confirm = sliceBetween(
    controllerSource,
    "  onAimedConfirm() {",
    "  async performAimedAttack(limbKey) {"
  );
  const perform = sliceBetween(
    controllerSource,
    "  async performAimedAttack(limbKey) {",
    "  async performDirectedAttack(directionKey) {"
  );
  const menu = sliceBetween(
    controllerSource,
    "  refreshAimedLimbMenu() {",
    "  getAimedLimbMenuContext(target) {"
  );
  const context = sliceBetween(
    controllerSource,
    "  getAimedLimbMenuContext(target) {",
    "  refreshPushStrengthMenu() {"
  );
  const rows = sliceBetween(
    controllerSource,
    "  prepareAimedLimbRows(target, menuContext = null) {",
    "  prepareAttackDirectionRows(target) {"
  );

  assert.doesNotMatch(confirm, /aimedRangeState\.allowed === false/);
  assert.match(confirm, /this\.selectedTarget = this\.hoveredTarget/);
  assert.match(confirm, /this\.refreshAimedLimbMenu\(\)/);
  assert.match(perform, /if \(aimedRangeState\.allowed === false\)/);
  assert.match(menu, /const warning = rangeBlocked/);
  assert.match(menu, /const unavailable = row\.destroyed \|\| rangeBlocked/);
  assert.match(menu, /\$\{unavailable \? "disabled" : ""\}/);
  assert.match(menu, /\$\{row\.destroyed \? "—" : `\$\{row\.chance\}%`\}/);
  assert.match(context, /getAimedTargetBlockers\(/);
  assert.match(context, /getEffectiveRangeDifficultyBonus\(/);
  assert.doesNotMatch(context, /if \(rangeBlocked\) return/);
  assert.match(rows, /buildAimedAttackChanceBasis\(/);
  assert.match(rows, /getAimedAttackHitChanceFromBasis\(chanceBasis, row\.limbKey, blockerBonus, chanceOptions\)/);
  assert.doesNotMatch(rows, /if \(context\.rangeBlocked\) return/);
});

test("stale destroyed aimed selections fail closed before costs and execution", () => {
  const resolveSelection = sliceBetween(
    controllerSource,
    "function resolveAimedTargetSelection",
    "function getHeldWeaponAimTargets"
  );

  assert.match(resolveSelection, /actor\?\.system\?\.limbs\?\.\[value\] && !isLimbDestroyed\(actor, value\)/);
  assert.match(resolveSelection, /!entry\.destroyed && !isLimbDestroyed\(actor, entry\.limbKey\)/);
});

test("automatic limb destruction policy covers consequences, recovery, and lethal estimates", () => {
  const recovery = sliceBetween(
    damageHubSource,
    "function hasDestroyedCriticalLimbAfterUpdate",
    "function isDamageStatusUpdateRelevant"
  );
  const consequences = sliceBetween(
    damageHubSource,
    "async function applyDestroyedLimbConsequencesNow",
    "async function deleteLimbTraumas"
  );
  const lethalEstimate = sliceBetween(
    damageHubSource,
    "function isDamageEstimateLethal",
    "function normalizeDamageRequest"
  );

  assert.match(recovery, /if \(missing\) return true/);
  assert.match(recovery, /isConstructPartLimb\(actor, key\)[\s\S]*\|\| canActorLimbBeAutomaticallyDestroyed\(/);

  assert.match(consequences, /const constructSlot = getConstructPartSlotForLimb\(actor, limbKey\)/);
  assert.match(consequences, /!missing[\s\S]*&& !constructSlot[\s\S]*&& !canActorLimbBeAutomaticallyDestroyed\(/);
  assert.match(consequences, /getActorLimbDestructionMode\(/);
  assert.match(consequences, /if \(!missing\) missingUpdates\[`system\.limbs\.\$\{limbKey\}\.missing`\] = true/);

  const constructBypass = lethalEstimate.indexOf("if (isConstructPartLimb(actor, limbKey)) return true");
  const policyGate = lethalEstimate.indexOf("canActorLimbBeAutomaticallyDestroyed(");
  assert.ok(constructBypass >= 0, "construct critical parts must remain lethal when destroyed");
  assert.ok(policyGate > constructBypass, "construct destruction must bypass the organic-limb policy");
  assert.match(lethalEstimate, /brokenProsthesisLimbKeys[\s\S]*\.some\(limbKey => isCriticalLimb\(actor, limbKey\)\)/);
});

test("finishing blows remain explicit and combat settings expose both ownership policies", () => {
  const finish = sliceBetween(
    combatEndSource,
    "async function handleCombatEndFinish",
    "function clearCombatEndFinishClaim"
  );

  assert.match(combatEndSource, /import \{[\s\S]*destroyActorLimbExplicitly,[\s\S]*\} from "\.\/damage-hub\.mjs"/);
  assert.match(finish, /await destroyActorLimbExplicitly\(targetActor, limb\.limbKey\)/);
  assert.doesNotMatch(finish, /system\.limbs\.[^\n]*\.missing|setLimbMissingState/);

  assert.equal(
    combatSettingsTemplate.match(/<select name="limbDestruction\.nonPlayerMode">/g)?.length,
    1
  );
  assert.equal(
    combatSettingsTemplate.match(/<select name="limbDestruction\.playerOwnedMode">/g)?.length,
    1
  );
});
