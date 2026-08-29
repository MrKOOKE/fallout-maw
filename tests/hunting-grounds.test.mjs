import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeHuntingGroundsSettings
} from "../src/settings/abilities.mjs";
import { toInteger } from "../src/utils/numbers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => fs.readFileSync(path.join(ROOT, relative), "utf8");
const RUNTIME = read("src/abilities/hunting-grounds.mjs");
const FIXED = read("src/abilities/fixed-functions.mjs");
const ACTIVE_USE_KEYS = read("src/abilities/active-use-keys.mjs");
const ACTOR_MODEL = read("src/data/models/actor-data-models.mjs");
const SKILL_CHECK = read("src/rolls/skill-check.mjs");
const EFFECT_KEY_TOKENS = read("src/utils/effect-key-tokens.mjs");

test("Hunting Grounds defaults match the fixed ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.huntingGrounds, "huntingGrounds");
  assert.deepEqual(normalizeHuntingGroundsSettings(), {
    activationEnergyCost: 100,
    overloadEnergyCost: 200,
    overloadDurationSeconds: 6 * 60 * 60,
    zoneSizeMeters: 20,
    durationSeconds: 30,
    checkIntervalSeconds: 6,
    difficultyBase: 50,
    sourceSkillKey: "naturalist",
    targetSkillKey: "stealth",
    initialMarks: 1,
    actionPointThreshold: 4,
    movementPointThreshold: 6,
    maxMarks: 4,
    incomingDamagePercentPerMark: 20,
    accuracyPerMark: 40
  });
});

test("attack-only critical-failure disabling is a selectable contextual effect key", () => {
  assert.match(ACTOR_MODEL, /attackCriticalFailureDisabled:[\s\S]*?persisted: false/);
  assert.match(EFFECT_KEY_TOKENS, /path: ATTACK_CRITICAL_FAILURE_DISABLED_EFFECT_KEY/);
  assert.match(ACTIVE_USE_KEYS, /keys\.add\(ATTACK_CRITICAL_FAILURE_DISABLED_EFFECT_KEY\)/);
  assert.match(SKILL_CHECK, /isAttackingSkillCheckContext[\s\S]*isAttackingWeaponAction\(actionKey\)/);
  assert.match(SKILL_CHECK, /buildAttackCriticalFailureDisabledContextSpec[\s\S]*attackCriticalFailureDisabled/);
  assert.match(SKILL_CHECK, /values\.criticalFailure[\s\S]*contextual\.attackCriticalFailureDisabled/);
  assert.equal(JSON.parse(read("lang/ru.json")).FALLOUTMAW.Effects.AttackCriticalFailureDisabled,
    "Критический провал на атаки (в мою сторону)");
  assert.equal(JSON.parse(read("lang/en.json")).FALLOUTMAW.Effects.AttackCriticalFailureDisabled,
    "Critical failure on attacks (against me)");
});

test("Hunting Grounds accumulates AP and MP independently and caps Target marks", () => {
  const match = RUNTIME.match(
    /export function advanceHuntingGroundsMarks\(state = \{\}, resources = \{\}\) \{([\s\S]*?)\n\}/
  );
  assert.ok(match, "advanceHuntingGroundsMarks production helper is missing");
  const advance = Function(
    "toInteger",
    `return function advanceHuntingGroundsMarks(state = {}, resources = {}) {${match[1]}\n};`
  )(toInteger);

  let state = {
    marks: 1,
    maxMarks: 4,
    actionPointThreshold: 4,
    movementPointThreshold: 6,
    actionPointProgress: 0,
    movementPointProgress: 0
  };
  state = { ...state, ...advance(state, { actionPoints: 3, movementPoints: 5 }) };
  assert.equal(state.marks, 1);
  assert.equal(state.actionPointProgress, 3);
  assert.equal(state.movementPointProgress, 5);

  state = { ...state, ...advance(state, { actionPoints: 1, movementPoints: 1 }) };
  assert.equal(state.marks, 3);
  assert.equal(state.actionPointProgress, 0);
  assert.equal(state.movementPointProgress, 0);

  state = { ...state, ...advance(state, { actionPoints: 8, movementPoints: 12 }) };
  assert.equal(state.marks, 4);
  assert.equal(state.gainedMarks, 1);
});

test("Hunting Grounds runtime is event-driven and Prey persists outside the zone", () => {
  assert.match(RUNTIME, /registerQueuedWorldTimeProcessor\(processHuntingGroundsWorldTime/);
  assert.doesNotMatch(RUNTIME, /setInterval\s*\(/);
  assert.match(RUNTIME, /Array\.from\(current\.tokens \?\? \[\]\)/);
  assert.match(RUNTIME, /movementPathEntersHuntingGroundsRegion\(tokenDocument, region, path\)/);
  assert.match(RUNTIME, /fromLevel === toLevel[\s\S]*segmentizeRegionMovementPath\(region, \[/);
  assert.match(RUNTIME, /!fromInside && toInside/);
  assert.match(RUNTIME, /preyCheckLocks/);
  assert.match(RUNTIME, /preyEffectMutationQueues/);
  assert.match(RUNTIME, /cleaningSessions\.has\(regionData\.sessionId\)[\s\S]*findLiveIndexedSessionEffect\(regionData\.sessionId/);
  assert.match(RUNTIME, /findSessionPreyEffect\(targetActor, regionData\.sessionId/);
  assert.match(RUNTIME, /getActorFactionRelation\(sourceActor, targetActor\) === "ally"/);
  assert.doesNotMatch(RUNTIME, /getActorFactionRelation\(sourceActor, targetActor\) !== "enemy"/);
  assert.match(RUNTIME, /requester: "huntingGrounds"/);
  assert.match(RUNTIME, /difficulty: difficultyBase \+ sourceSkillValue/);
  assert.match(RUNTIME, /getReverseEffectKey\("system\.combat\.damagePercent"\)/);
  assert.match(RUNTIME, /change\("system\.combat\.accuracy", count \* toInteger\(accuracyPerMark\)\)/);
  assert.match(RUNTIME, /change\(ATTACK_CRITICAL_FAILURE_DISABLED_EFFECT_KEY, 1\)/);
  assert.doesNotMatch(RUNTIME, /weaponActionModifierRequests|fallout-maw\.modifySkillCheck/);
  assert.doesNotMatch(RUNTIME, /applyHuntingGrounds(?:WeaponActionModifiers|CriticalFailureImmunity)/);
  assert.match(RUNTIME, /data\.marks >= data\.maxMarks/);
  assert.match(RUNTIME, /cleanupHuntingGroundsSession[\s\S]*deletePreyEffects/);
  assert.match(RUNTIME, /const inSessionCleanup[\s\S]*if \(cached && !inSessionCleanup\)/);
});

test("Hunting Grounds visibility bypasses obstacles only for its hunter-prey token pair", () => {
  assert.match(RUNTIME, /class HuntingGroundsDetectionMode extends DetectionModeAll/);
  assert.match(RUNTIME, /tokenConfig: false,[\s\S]*walls: false,[\s\S]*angle: false/);
  assert.match(RUNTIME, /detectableHuntersByTargetToken/);
  assert.match(RUNTIME, /const preyEffectsByTokenPair = new Map\(\)/);
  assert.match(RUNTIME, /const uuids = preyEffectsByTokenPair\.get\(tokenPairKey\(sourceUuid, targetUuid\)\)/);
  assert.match(RUNTIME, /get\(targetUuid\)\?\.get\(sourceUuid\)/);
  assert.match(RUNTIME, /_testRange\(\) \{\s*return true;/);
  assert.match(RUNTIME, /_testLOS\(\) \{\s*return true;/);
});

test("Hunting Grounds fixed use has native placement, authenticated authority queries, overload, and free aimed attacks", () => {
  assert.match(FIXED, /key: ABILITY_FIXED_FUNCTION_KEYS\.huntingGrounds/);
  assert.match(FIXED, /canvas\.regions\.placeRegion\([\s\S]*create: false,[\s\S]*allowRotation: false/);
  assert.match(FIXED, /elevationCenter - halfHeight[\s\S]*elevationCenter \+ halfHeight/);
  assert.match(RUNTIME, /const elevationBottom = elevationCenter - halfHeight[\s\S]*collectIntersectingLevelIds/);
  assert.match(FIXED, /CONFIG\.queries\[HUNTING_GROUNDS_ACTIVATION_QUERY_NAME\]/);
  assert.match(FIXED, /CONFIG\.queries\[HUNTING_GROUNDS_MARK_CONSUMPTION_QUERY_NAME\]/);
  assert.match(FIXED, /authority\.query\(queryName, payload/);
  assert.match(FIXED, /handleHuntingGroundsActivationQuery\(payload = \{\}, \{ user: sender = null \} = \{\}\)[\s\S]*processHuntingGroundsActivationOperation\(payload, sender\)/);
  assert.match(FIXED, /handleHuntingGroundsMarkConsumptionQuery\(payload = \{\}, \{ user: sender = null \} = \{\}\)[\s\S]*processHuntingGroundsMarkConsumptionOperation\(payload, sender\)/);
  assert.match(FIXED, /async function processHuntingGroundsActivationOperation[\s\S]*?if \(!game\.user\?\.isActiveGM\)[\s\S]*?if \(!sender \|\|/);
  assert.match(FIXED, /async function processHuntingGroundsMarkConsumptionOperation[\s\S]*?if \(!game\.user\?\.isActiveGM\)[\s\S]*?const amount = 2/);
  assert.doesNotMatch(FIXED, /requestFixedAbilitySocketOperation\("(?:activateHuntingGrounds|consumeHuntingGroundsMarks)"/);
  assert.doesNotMatch(FIXED, /message\.action === "(?:activateHuntingGrounds|consumeHuntingGroundsMarks)"/);
  assert.match(FIXED, /applyAbilityOverloadEffect\(actor, abilityItem, abilityFunction/);
  assert.match(FIXED, /startForcedAimedAttackSelection\(\{/);
  assert.match(FIXED, /requestHuntingGroundsMarkConsumption\(\{[\s\S]*sessionId: session\.sessionId/);
});

test("Hunting Grounds settings are available in both ability editors", () => {
  const templates = [
    read("templates/item/item-sheet.hbs"),
    read("templates/settings/ability-catalog-item-editor.hbs")
  ];
  for (const source of templates) {
    assert.match(source, /fixedHuntingGroundsSettings/);
    assert.match(source, /activationEnergyCost/);
    assert.match(source, /overloadDuration/);
    assert.match(source, /zoneSizeMeters/);
    assert.match(source, /sourceSkillKey/);
    assert.match(source, /targetSkillKey/);
    assert.match(source, /actionPointThreshold/);
    assert.match(source, /movementPointThreshold/);
    assert.match(source, /incomingDamagePercentPerMark/);
    assert.match(source, /accuracyPerMark/);
  }
});
