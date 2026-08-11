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

test("weapon costs no longer reveal stealth unconditionally", () => {
  assert.doesNotMatch(source, /revealActorFromStealth/);
  const spend = sliceBetween(
    "async function spendWeaponActionPoints",
    "async function spendWeaponResources"
  );
  assert.doesNotMatch(spend, /reveal|toggleActorStealth/u);
});

test("aim preview has source-owned activation, processing, resume, and teardown", () => {
  const controller = sliceBetween("class WeaponAttackController", "export function getWeaponAttackData");
  assert.match(controller, /activate\(\)[\s\S]*?syncWeaponNoisePreview\(\)/);
  assert.match(controller, /beginProcessingCycle\(\)[\s\S]*?clearWeaponNoisePreview\(\)/);
  assert.match(controller, /completeProcessingCycle\([\s\S]*?syncWeaponNoisePreview\(\)[\s\S]*?refresh\(true\)/);
  assert.match(controller, /suppressPreview\(\)[\s\S]*?clearWeaponNoisePreview\(\)/);
  assert.match(controller, /resumePreview\(\)[\s\S]*?syncWeaponNoisePreview\(\)/);
  assert.match(controller, /destroy\(\)[\s\S]*?clearWeaponNoisePreview\(\)/);
});

test("an attempt is recorded only after the resource and action-cost path completes", () => {
  const spend = sliceBetween(
    "async spendCurrentAttackCosts",
    "async executeAgainstToken"
  );
  const spendResources = spend.indexOf("await spendWeaponResources");
  const finalizeAction = spend.indexOf("await finalizeCommittedWeaponActionPointSpend");
  const attempted = spend.indexOf("this.weaponNoiseAttempted = weaponAttempted");
  assert.ok(spendResources >= 0);
  assert.ok(finalizeAction > spendResources);
  assert.ok(attempted > finalizeAction);
  assert.match(spend, /const weaponAttempted = this\.shouldSpendWeaponResourcesForAttempt\(\)/);
});

test("weapon Item resources commit through one shared inventory transaction", () => {
  const spend = sliceBetween(
    "async function spendWeaponResources",
    "function collectWeaponResourceSpendTotals"
  );
  assert.match(spend, /planInventoryItemConsumption\(/);
  assert.match(spend, /createActorItemOrInstalledModuleUpdate\(/);
  assert.equal((spend.match(/executeInventoryMutation\(/g) ?? []).length, 1);
  assert.doesNotMatch(spend, /\.update\(|\.delete\(|EmbeddedDocuments\("Item"/);
  assert.match(spend, /reason:\s*"weapon-resource-spend"/);
});

test("delayed volley arming compensates its world documents when the Item transaction fails", () => {
  const arm = sliceBetween(
    "export async function armDelayedVolleyWeapon",
    "export function buildWeaponExplosionDamageRequests"
  );
  assert.match(arm, /executeInventoryMutation\(/);
  assert.match(arm, /rollbackDelayedThrownItemWorldDocuments\(delayedThrownItemId\)/);
  assert.doesNotMatch(arm, /weapon\.update\(/);
});

test("a rejected or stale weapon resource spend cancels the attack before damage", () => {
  const spend = sliceBetween(
    "async spendCurrentAttackCosts",
    "async executeAgainstToken"
  );
  assert.match(spend, /const resourcesSpent = await spendWeaponResources/);
  assert.match(spend, /if \(!resourcesSpent\)[\s\S]*?this\.attackCanceledByReaction = true;[\s\S]*?return false;/);
});

test("quantity projectiles exist before Item spend and are tombstoned on rejection", () => {
  const spend = sliceBetween(
    "async spendCurrentAttackCosts",
    "async executeAgainstToken"
  );
  const createTile = spend.indexOf("await createSpentQuantityItemTile");
  const spendItems = spend.indexOf("await spendWeaponResources");
  assert.ok(createTile >= 0 && spendItems > createTile);
  assert.match(spend, /catch \(error\)[\s\S]*?rollbackSpentQuantityItemTile\(spentQuantityTileOperationId\)[\s\S]*?throw error;/);
  assert.match(source, /deleteThrownItemTileByOperation\(id\)/);
});

test("late delayed-Region creation observes the shared world tombstone", () => {
  const createRegion = sliceBetween(
    "async function createDelayedVolleyExplosionRegionNow",
    "function createDelayedVolleySourceContextSnapshot"
  );
  assert.match(createRegion, /registerDelayedThrownItemWorldOperation\(/);
  assert.ok((createRegion.match(/isDelayedThrownItemWorldOperationCancelled\(/g) ?? []).length >= 3);
  assert.match(createRegion, /deleteDelayedVolleyRegionIfMatching\(/);
});

test("ordinary detection resolves after outcome publication and completed damage", () => {
  const notify = sliceBetween(
    "async notifyAttackResolved",
    "async notifyAttackCheckResolved"
  );
  assert.ok(
    notify.indexOf("await this.finalizeWeaponNoiseDetection()")
      > notify.indexOf("await publishWeaponAttackResolved(outcome)")
  );

  const ordinary = sliceBetween(
    "async performCurrentAttack",
    "async performWhirlwindAttack"
  );
  assert.ok(
    ordinary.indexOf("await this.notifyAttackResolved")
      > ordinary.indexOf("applyQueuedDamageRequests")
  );
});

test("push and delayed placement resolve noise only after their final effects", () => {
  const push = sliceBetween("async performPushAttack", "async resolvePushHit");
  assert.ok(
    push.indexOf("await this.finalizeWeaponNoiseDetection()")
      > push.indexOf("await this.playAttackAnimationsIfNeeded")
  );

  const volley = sliceBetween("async performVolleyAttack", "async resolveVolleyBlastPoint");
  const delayedPlacement = volley.indexOf("requestCreateDelayedVolleyExplosionRegion(delayedRegionRequest)");
  const delayedDetection = volley.indexOf("await this.finalizeWeaponNoiseDetection()", delayedPlacement);
  assert.ok(delayedPlacement >= 0);
  assert.ok(delayedDetection > delayedPlacement);
});

test("dual attacks defer child detection and resolve the attempted maximum once", () => {
  const dual = sliceBetween("export function startDualWeaponAttack", "export function startCommandedWeaponAttacks");
  assert.match(dual, /deferWeaponNoiseDetection:\s*true/);
  assert.match(dual, /returnWeaponNoiseMetadata:\s*true/);
  assert.match(dual, /result\.value\?\.weaponNoiseAttempted/);
  assert.match(dual, /noiseLevel:\s*Math\.max\(\.\.\.attemptedNoiseLevels\)/);
  assert.match(source, /suppressNoisePreview\(\)\s*\{\s*this\.suppressed = true;/);
  assert.ok(
    dual.indexOf("await resolveWeaponNoiseDetection")
      > dual.indexOf("await reactionCoordinator.drain()")
  );
  assert.match(dual, /new DualWeaponAttackPreview\(token,\s*entries\)/);
});

test("commanded attacks keep per-attacker preview sources and independent resolution", () => {
  const commanded = sliceBetween(
    "class CommandedWeaponAttackController",
    "function serializeCommandedAttackSelection"
  );
  assert.match(commanded, /noisePreviewSourceId/);
  assert.match(commanded, /setWeaponNoisePreview\(entry\.token/);
  assert.match(commanded, /clearWeaponNoisePreview\(/);

  const execution = sliceBetween(
    "async function processCommandedWeaponAttackSelections",
    "async function spendCommandedActionPointCosts"
  );
  assert.doesNotMatch(execution, /deferWeaponNoiseDetection:\s*true/);
});
