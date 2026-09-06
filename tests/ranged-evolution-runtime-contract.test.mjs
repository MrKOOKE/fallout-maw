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
const deepPenetration = await readFile(
  new URL("../src/abilities/deep-penetration.mjs", import.meta.url),
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

test("Bullseye resolves from the completed actor attack instead of transient preview entries", () => {
  const resolver = fixedFunctions.slice(
    fixedFunctions.indexOf("async function processBullseyeAttackResolution"),
    fixedFunctions.indexOf("function requestKeepAwayWeaponActionModifiers")
  );
  assert.match(resolver, /getActiveBullseyeEntries\(actor\)/u);
  assert.match(resolver, /selectedTargetActorUuid/u);
  assert.match(resolver, /selectedLimbKey/u);
  assert.match(resolver, /syncBullseyeStateEffect/u);
  assert.doesNotMatch(resolver, /modifierState/u);
  assert.doesNotMatch(fixedFunctions, /bullseyeEntries/u);
});

test("contextual penetration receives the resolved limb in every weapon damage request", () => {
  const contextualPenetrationCalls = controller.match(
    /weaponActionModifierState: modifierState,\s*limbKey,\s*reflectionCount:/gu
  ) ?? [];
  assert.equal(contextualPenetrationCalls.length, 2);
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

test("Deep Penetration is a paid attack toggle and preserves fractional-impact structure", () => {
  const resolution = fixedFunctions.slice(
    fixedFunctions.indexOf("async function processDeepPenetrationResolution"),
    fixedFunctions.indexOf("async function collectDisarmReactionOffers")
  );
  assert.match(fixedFunctions, /function requestDeepPenetrationWeaponActionModifiers/u);
  assert.match(fixedFunctions, /source:\s*"deepPenetration"[\s\S]*?energyCost:\s*getEnergyCost/u);
  assert.match(resolution, /extractDeepPenetrationDamageRows\(context\?\.damageResults\)/u);
  assert.match(resolution, /selectDeepPenetrationTargetRows/u);
  assert.match(deepPenetration, /pelletImpactCount:\s*Math\.max\(1, Math\.trunc\(finiteNumber\(source\.pelletImpactCount\)\)/u);
  assert.match(deepPenetration, /pelletImpactIndex:\s*Math\.max\(0, Math\.trunc\(finiteNumber\(source\.pelletImpactIndex\)\)/u);
  assert.match(resolution, /result\.pelletImpactCount > 1[\s\S]*?pelletImpactCount:\s*result\.pelletImpactCount[\s\S]*?pelletImpactIndex:/u);
  assert.doesNotMatch(fixedFunctions, /DEEP_PENETRATION_REACTION_PROVIDER_ID/u);
});

test("cleave constrained attacks use the ordinary weapon pipeline and one explicit target", () => {
  const strictExecution = controller.slice(
    controller.indexOf("async executeStrictlyAgainstToken"),
    controller.indexOf("async performStrictSelectedTargetAttack")
  );
  const scriptedExecution = controller.slice(
    controller.indexOf("export async function executeWeaponAttackAgainstToken"),
    controller.indexOf("export function collectValidWeaponAttackTargets")
  );
  const cleaveExecution = fixedFunctions.slice(
    fixedFunctions.indexOf("async function executeCleavePass"),
    fixedFunctions.indexOf("function collectCleavePathTargets")
  );

  assert.match(strictExecution, /if \(!this\.usesAbilityTrialResolution\(\)\)/u);
  assert.match(strictExecution, /await this\.performDirectedAttack\(direction\.key\)/u);
  assert.match(strictExecution, /await this\.performAimedAttack\(this\.selectedLimbKey\)/u);
  assert.match(scriptedExecution, /targetTokenUuidAllowlist/u);
  assert.match(scriptedExecution, /targetTokenUuidAllowlist\s*\n\s*\}\);/u);
  assert.match(cleaveExecution, /strictTargetResolution:\s*true/u);
  assert.match(cleaveExecution, /targetTokenUuidAllowlist:\s*\[String\(entry\.token\.document\?\.uuid/u);
});

test("Where Are You Going pauses native movement on the reached transition cell", () => {
  const provider = fixedFunctions.slice(
    fixedFunctions.indexOf("function registerWhereAreYouGoingMovementProvider"),
    fixedFunctions.indexOf("function collectWhereAreYouGoingMovementInterruptions")
  );
  const execution = fixedFunctions.slice(
    fixedFunctions.indexOf("async function executeWhereAreYouGoingMovementInterruption"),
    fixedFunctions.indexOf("async function collectWhereAreYouGoingReactionOffers")
  );
  assert.match(provider, /pauseNativeMovement:\s*true/u);
  assert.match(execution, /nativeMovementPaused\s*=\s*false/u);
  assert.match(execution, /REACTION_RESULT\.success\) return nativeMovementPaused \? false : undefined/u);
  assert.match(execution, /if \(nativeMovementPaused\)[\s\S]*?triggerMode !== "approach"[\s\S]*?suppressWhereAreYouGoingReactors[\s\S]*?return true/u);
  assert.match(fixedFunctions, /segmentIndex \+ \(approach \? 1 : 0\)/u);
  assert.match(fixedFunctions, /event\.triggerMode === "approach" \? \[\] : \(event\.reactorTokenUuids/u);
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

test("melee evolution runtime branches on fixed-function identity", () => {
  assert.match(fixedFunctions, /ABILITY_FIXED_FUNCTION_KEYS\.headChopper/u);
  assert.match(fixedFunctions, /ABILITY_FIXED_FUNCTION_KEYS\.cleaveMastery/u);
  assert.match(fixedFunctions, /function getDeepPenetrationRuntimeSettings/u);
  assert.match(fixedFunctions, /function getDoubleAttackRuntimeSettings/u);
  assert.match(fixedFunctions, /ABILITY_FIXED_FUNCTION_KEYS\.parry/u);
  assert.match(fixedFunctions, /ABILITY_FIXED_FUNCTION_KEYS\.spinalStrike/u);
  assert.match(fixedFunctions, /ABILITY_FIXED_FUNCTION_KEYS\.idealStrike/u);
  assert.doesNotMatch(fixedFunctions, /settings\.(?:cleavePath|returnCleave|preemptive|triggerOnApproach|overloadOnMissOnly|activeEnabled)/u);
});
