import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const controller = await readFile(
  new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url),
  "utf8"
);
const fixedFunctions = await readFile(
  new URL("../src/abilities/fixed-functions.mjs", import.meta.url),
  "utf8"
);
const skillCheck = await readFile(
  new URL("../src/rolls/skill-check.mjs", import.meta.url),
  "utf8"
);
const compatibilityEvents = await readFile(
  new URL("../src/events/foundry-compatibility-events.mjs", import.meta.url),
  "utf8"
);
const tempo = await readFile(
  new URL("../src/abilities/tempo.mjs", import.meta.url),
  "utf8"
);
const cascadeRuntime = await readFile(
  new URL("../src/abilities/cascade-runtime.mjs", import.meta.url),
  "utf8"
);
const damageHub = await readFile(
  new URL("../src/combat/damage-hub.mjs", import.meta.url),
  "utf8"
);

test("every completed attack cycle uses the awaited aggregate publication path", () => {
  assert.doesNotMatch(controller, /emitAttackCheckAggregateResolved/u);
  assert.match(controller, /await this\.notifyAttackResolved\(\);\s+this\.completeProcessingCycle\(\);/u);
  assert.match(
    controller,
    /await this\.notifyAttackResolved\(\{\s*deferredImpactPending: true,\s*deferNoiseDetection: resolveWeaponNoiseAtImpact\s*\}\)/u
  );
  assert.match(fixedFunctions, /registerWeaponAttackResolvedHandler\(\s*"fallout-maw\.fixed\.attackCycleState"/u);
  assert.doesNotMatch(fixedFunctions, /Hooks\.on\(WEAPON_ATTACK_RESOLVED_HOOK/u);
});

test("one interactive controller rotates aggregate state without rotating its preview session", () => {
  assert.match(controller, /this\.previewAttackId = this\.attackId/u);
  assert.match(controller, /prepareNextAttackCycle\(\) \{\s*this\.attackId = foundry\.utils\.randomID\(\)/u);
  assert.match(controller, /this\.successfulAttackCheckCount = 0/u);
  assert.match(controller, /attackId: this\.previewAttackId/u);
});

test("volley impact preserves Keep Away and Guardian Angel lifecycle", () => {
  assert.match(controller, /keepAwayDeferredEntries/u);
  assert.match(controller, /attackCheckAggregate: true,[\s\S]*?deferredImpactResolution: true/u);
  assert.match(controller, /successfulAttackTargetActorUuids: Array\.from\(impactedLivingActorUuids\)/u);
  assert.match(controller, /requestDelayedVolleyTargetReaction/u);
  assert.match(controller, /REACTION_EVENT_KEYS\.weaponAttackTargeted/u);
  assert.match(controller, /notifyAttackCheckResolved\(outcome, checkBatch, \{ recordAggregate: false \}\)/u);
  assert.match(fixedFunctions, /context\?\.keepAwayEntries/u);
  assert.match(fixedFunctions, /deferredImpactResolution/u);
});

test("delayed volley resolves kill and stealth transitions from persisted impact context", () => {
  assert.match(controller, /persistPendingData[\s\S]*?actionPointSpendReceipt/u);
  assert.match(controller, /preExistingUnconsciousTargetActorUuids: Array\.from\(preExistingUnconsciousTargetActorUuids\)/u);
  assert.match(controller, /actionPointSpendReceipt: source\.actionPointSpendReceipt/u);
  assert.match(controller, /stealthAttack: source\.stealthAttack === true/u);
  assert.match(
    fixedFunctions,
    /deferredImpactResolution === true[\s\S]*?processReaperAttackResolution[\s\S]*?processSandmanAttackResolution[\s\S]*?processNightmareAttackResolution/u
  );
  assert.match(
    fixedFunctions,
    /if \(context\?\.deferredImpactPending !== true\) \{[\s\S]*?processReaperAttackResolution/u
  );
});

test("delayed volley launch and impact have distinct semantic phases", () => {
  assert.match(compatibilityEvents, /attackPhase = deferredImpactResolution[\s\S]*?"deferredImpact"[\s\S]*?"deferredLaunch"/u);
  assert.match(compatibilityEvents, /operationId: `weapon-attack-cycle:[\s\S]*?\$\{attackPhase\}`/u);
  assert.match(compatibilityEvents, /deferredImpactPending,[\s\S]*?deferredImpactResolution,/u);
  assert.match(tempo, /if \(event\?\.data\?\.deferredImpactPending === true\) return;/u);
  assert.match(cascadeRuntime, /if \(event\?\.data\?\.deferredImpactResolution === true\) return false;/u);
});

test("result-policy thresholds match the displayed single-roll chance and skip ability trials", () => {
  assert.match(skillCheck, /calculateResultProfileSuccessChance\(displayedProfile\)/u);
  assert.ok(
    skillCheck.indexOf("calculateResultProfileSuccessChance(displayedProfile)")
      < skillCheck.indexOf("const edge = calculateEdge")
  );
  assert.match(fixedFunctions, /context\?\.controller\?\.usesAbilityTrialResolution\?\.\(\) === true/u);
});

test("ability trials publish raw checks without treating resistance as weapon accuracy", () => {
  assert.match(controller, /notifyAttackCheckResolved\(entry\.check, null, \{ recordAggregate: false \}\)/u);
  assert.match(controller, /const targetWasAffected =/u);
  assert.match(controller, /this\.successfulAttackTargetActorUuids\.size > 0/u);
});

test("reaction energy joins the weapon actor-resource vector instead of spending early", () => {
  assert.match(fixedFunctions, /function getReactionWeaponActionResourcePreview[\s\S]*?additionalActorResourceCosts/u);
  assert.match(fixedFunctions, /additionalActorResourceCosts:\s*resourcePreview\.additionalActorResourceCosts/u);
  assert.match(fixedFunctions, /requireResourceCommit:\s*true/u);
  assert.doesNotMatch(fixedFunctions, /spendEnergy\((?:reactor|defender),\s*reactionEnergyCost\)/u);
  assert.match(controller, /\.\.\.this\.additionalActorResourceCosts/u);
  assert.match(controller, /!requireResourceCommit \|\| controller\.attackCostsCommitted/u);
});

test("periodic damage keeps source mechanics isolated by packet through every timed tick", () => {
  assert.match(damageHub, /function getPeriodicDamageSourceIdentity[\s\S]*?damagePacketId[\s\S]*?conditionWearPacketId/u);
  assert.match(damageHub, /buildDamageEffectChangeKey\([\s\S]*?resolvedSourceIdentity/u);
  assert.match(damageHub, /damagePacketId:\s*getTimedDamageTickPacketId\(effect, worldTime, data\.sourceIdentity\)/u);
  assert.match(damageHub, /const sourceIdentity = getPeriodicDamageSourceIdentity\(entry\.source\)[\s\S]*?foundry\.utils\.randomID\(\)/u);
  const pendingCombine = damageHub.slice(
    damageHub.indexOf("function combinePendingPeriodicDamageEffects"),
    damageHub.indexOf("function combineDamageEffectSources")
  );
  assert.doesNotMatch(pendingCombine, /combineDamageEffectSources/u);
});

test("resolved attacks preserve the displayed weapon name after quantity deletion", () => {
  assert.match(controller, /weaponName:\s*String\(this\.weapon\?\.name/u);
  assert.match(compatibilityEvents, /weaponName:\s*String\(context\.weaponName/u);
  assert.match(cascadeRuntime, /weaponName:\s*event\?\.data\?\.weaponName/u);
  assert.match(fixedFunctions, /const weaponName = String\(context\?\.weaponName \?\? weapon\?\.name/u);
});
