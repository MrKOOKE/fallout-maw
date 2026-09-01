import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeTempoSettings
} from "../src/settings/abilities.mjs";
import {
  advanceTempo,
  advanceTempoPeriodicState,
  buildTempoEffectChanges,
  getTempoAttackDeltas
} from "../src/abilities/tempo-rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => fs.readFileSync(path.join(ROOT, relative), "utf8");
const RUNTIME = read("src/abilities/tempo.mjs");
const FIXED = read("src/abilities/fixed-functions.mjs");
const COMPATIBILITY_EVENTS = read("src/events/foundry-compatibility-events.mjs");
const WEAPON_ATTACK_CONTROLLER = read("src/combat/weapon-attack-controller.mjs");

test("Tempo defaults match the fixed ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.tempo, "tempo");
  assert.deepEqual(normalizeTempoSettings(), {
    maxTempo: 5,
    automaticGain: 2,
    automaticIntervalSeconds: 6,
    successfulAttackGain: 1,
    missedAttackLoss: 1,
    incomingMissGain: 1,
    incomingHitLoss: 1,
    actionPointsPerTempo: 1,
    movementPointsPerTempo: 1,
    accuracyPerTempo: 10,
    damagePercentPerTempo: 5,
    attackMovementLossReductionPercentPerTempo: 20
  });
});

test("Tempo clamps signed event changes and folds elapsed intervals into one state", () => {
  assert.equal(advanceTempo(4, 2, 5), 5);
  assert.equal(advanceTempo(1, -3, 5), 0);
  assert.deepEqual(
    advanceTempoPeriodicState({ tempo: 2, nextGainAt: 6 }, 5),
    { tempo: 2, nextGainAt: 6, elapsedIntervals: 0, gainedTempo: 0 }
  );
  assert.deepEqual(
    advanceTempoPeriodicState({ tempo: 2, nextGainAt: 6 }, 6),
    { tempo: 4, nextGainAt: 12, elapsedIntervals: 1, gainedTempo: 2 }
  );
  assert.deepEqual(
    advanceTempoPeriodicState({ tempo: 4, nextGainAt: 12 }, 24),
    { tempo: 5, nextGainAt: 30, elapsedIntervals: 3, gainedTempo: 1 }
  );
});

test("one attack result yields the attacker and defender Tempo changes", () => {
  assert.deepEqual(getTempoAttackDeltas(true), { attacker: 1, defender: -1 });
  assert.deepEqual(getTempoAttackDeltas(false), { attacker: -1, defender: 1 });
});

test("each Tempo point produces all five ordinary actor modifiers", () => {
  assert.deepEqual(
    buildTempoEffectChanges(3).map(change => [change.key, change.value]),
    [
      ["system.resources.actionPoints.bonus", "3"],
      ["system.resources.movementPoints.bonus", "3"],
      ["system.combat.accuracy", "30"],
      ["system.combat.damagePercent", "15"],
      ["system.combat.attackActionPointMovementLossPercentBonus", "-60"]
    ]
  );
});

test("Tempo runtime uses semantic combat and attack events without actor polling", () => {
  assert.match(FIXED, /key: ABILITY_FIXED_FUNCTION_KEYS\.tempo[\s\S]*?passive: true/);
  assert.match(FIXED, /registerTempoRuntime\(\)/);
  assert.match(RUNTIME, /registerQueuedWorldTimeProcessor\(processTempoWorldTime/);
  assert.match(RUNTIME, /eventKeys: \[ATTACK_EVENT_KEY\]/);
  assert.match(RUNTIME, /eventKeys: COMBAT_EVENT_KEYS/);
  assert.match(RUNTIME, /getActorActiveCombat\(actor\)/);
  assert.match(RUNTIME, /effectsByActorUuid/);
  assert.doesNotMatch(RUNTIME, /setInterval\s*\(/);
});

test("Tempo consumes one aggregate after the complete attack cycle", () => {
  assert.match(RUNTIME, /ATTACK_EVENT_KEY = "fallout-maw\.weapon\.attack\.resolved"/);
  assert.doesNotMatch(RUNTIME, /weapon\.attack\.checkResolved/);
  assert.match(RUNTIME, /attackCycleAggregate !== true/);
  assert.match(RUNTIME, /deferredImpactPending === true/);
  assert.match(RUNTIME, /attackCheckCount <= 0/);
  assert.match(COMPATIBILITY_EVENTS, /Hooks\.on\("fallout-maw\.weaponAttackResolved"/);
  assert.match(COMPATIBILITY_EVENTS, /attackCycleAggregate: true/);
  assert.match(COMPATIBILITY_EVENTS, /attackPhase/);
  assert.match(COMPATIBILITY_EVENTS, /deferredImpactResolution/);
  assert.match(COMPATIBILITY_EVENTS, /suppressGenericEventReactions: true/);
});

test("weapon attacks aggregate hits independently of damage and by defender", () => {
  assert.match(WEAPON_ATTACK_CONTROLLER, /this\.successfulAttackCheckCount = 0/);
  assert.match(WEAPON_ATTACK_CONTROLLER, /this\.recordAttackCheckOutcome\(outcome\)/);
  assert.match(WEAPON_ATTACK_CONTROLLER, /if \(!isSuccessfulAttack\(outcome\)\) return false/);
  assert.match(WEAPON_ATTACK_CONTROLLER, /this\.successfulAttackCheckCount > 0\s*\|\| this\.successfulAttackTargetActorUuids\.size > 0/);
  assert.match(WEAPON_ATTACK_CONTROLLER, /successfulAttackTargetActorUuids: Array\.from\(this\.successfulAttackTargetActorUuids\)/);
  assert.match(WEAPON_ATTACK_CONTROLLER, /await emitWeaponAttackResolved\(context\)/);
  assert.doesNotMatch(WEAPON_ATTACK_CONTROLLER, /emitAttackCheckAggregateResolved/);
  assert.match(
    WEAPON_ATTACK_CONTROLLER,
    /await this\.notifyAttackResolved\(\{\s*deferredImpactPending: true,\s*deferNoiseDetection: resolveWeaponNoiseAtImpact\s*\}\)/
  );
  assert.match(WEAPON_ATTACK_CONTROLLER, /attackCheckAggregate: true,[\s\S]*?deferredImpactResolution: true/);
  assert.match(WEAPON_ATTACK_CONTROLLER, /notifyAttackCheckResolved\(outcome, checkBatch, \{ recordAggregate: false \}\)/);
  assert.match(RUNTIME, /successfulDefenderUuids\.has\(defenderUuid\)/);
});

test("Tempo settings are editable in both ability constructors", () => {
  for (const source of [
    read("templates/item/item-sheet.hbs"),
    read("templates/settings/ability-catalog-item-editor.hbs")
  ]) {
    assert.match(source, /fixedTempoSettings/);
    assert.match(source, /automaticIntervalSeconds/);
    assert.match(source, /successfulAttackGain/);
    assert.match(source, /incomingMissGain/);
    assert.match(source, /actionPointsPerTempo/);
    assert.match(source, /attackMovementLossReductionPercentPerTempo/);
  }
});
