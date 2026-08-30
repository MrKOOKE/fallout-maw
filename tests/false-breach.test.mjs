import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeFalseBreachSettings
} from "../src/settings/abilities.mjs";
import {
  FALSE_BREACH_EFFECT_FLAG_KEY,
  buildFalseBreachEffectChanges,
  buildFalseBreachMarkChanges,
  getFalseBreachDisplayedDodgeDifficulty
} from "../src/abilities/false-breach.mjs";
import {
  ALL_COMBAT_ADVANTAGE_EFFECT_KEY,
  getReverseEffectKey
} from "../src/utils/active-effect-keys.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => fs.readFileSync(path.join(ROOT, relative), "utf8");
const RUNTIME = read("src/abilities/false-breach.mjs");
const FIXED = read("src/abilities/fixed-functions.mjs");
const WEAPON_ATTACK_CONTROLLER = read("src/combat/weapon-attack-controller.mjs");

test("False Breach defaults match the fixed ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.falseBreach, "falseBreach");
  assert.deepEqual(normalizeFalseBreachSettings(), {
    activationEnergyCost: 10,
    overloadEnergyCost: 40,
    overloadDurationSeconds: 18,
    durationSeconds: 12,
    dodgeBonus: 30,
    markDurationSeconds: 12,
    incomingDamagePercent: 10,
    attackAdvantage: 1
  });
});

test("False Breach uses ordinary Dodge and reverse target-owned mark keys", () => {
  assert.deepEqual(
    buildFalseBreachEffectChanges().map(change => [change.key, change.value]),
    [["system.resources.dodge.bonus", "30"]]
  );
  assert.deepEqual(
    buildFalseBreachMarkChanges().map(change => [change.key, change.value]),
    [
      [getReverseEffectKey("system.combat.damagePercent"), "10"],
      [getReverseEffectKey(ALL_COMBAT_ADVANTAGE_EFFECT_KEY), "1"]
    ]
  );
});

test("only a live False Breach hides Dodge from displayed hit chance", () => {
  const previousGame = globalThis.game;
  globalThis.game = { time: { worldTime: 5 } };
  try {
    const effect = {
      disabled: false,
      active: true,
      duration: { expired: false },
      flags: {
        "fallout-maw": {
          [FALSE_BREACH_EFFECT_FLAG_KEY]: {
            sourceActorUuid: "Actor.defender",
            functionId: "function.falseBreach",
            expiresAt: 17,
            settings: {}
          }
        }
      }
    };
    assert.equal(getFalseBreachDisplayedDodgeDifficulty({ effects: [effect] }, 73), 0);
    effect.disabled = true;
    assert.equal(getFalseBreachDisplayedDodgeDifficulty({ effects: [effect] }, 73), 73);
    effect.disabled = false;
    globalThis.game.time.worldTime = 17;
    assert.equal(getFalseBreachDisplayedDodgeDifficulty({ effects: [effect] }, 73), 73);
  } finally {
    globalThis.game = previousGame;
  }
});

test("False Breach marks only a completely missed defender after the aggregate attack cycle", () => {
  assert.match(RUNTIME, /ATTACK_EVENT_KEY = "fallout-maw\.weapon\.attack\.resolved"/);
  assert.match(RUNTIME, /attackCycleAggregate !== true/);
  assert.match(RUNTIME, /attackCheckCount[\s\S]*?<= 0/);
  assert.match(RUNTIME, /successfulAttackTargetActorUuids/);
  assert.match(RUNTIME, /attackCheckTargetActorUuids/);
  assert.match(RUNTIME, /successfulTargets\.has\(defenderUuid\)/);
  assert.doesNotMatch(RUNTIME, /weapon\.attack\.checkResolved/);
  assert.doesNotMatch(RUNTIME, /setInterval\s*\(/);
  assert.match(RUNTIME, /applyOrRefreshFalseBreachMark/);
  assert.match(RUNTIME, /existing\.update\(effectData/);
});

test("false hit chance changes preview Dodge but never the real attack difficulty fallback", () => {
  assert.match(WEAPON_ATTACK_CONTROLLER, /function getDisplayedAttackDodgeDifficulty[\s\S]*getFalseBreachDisplayedDodgeDifficulty/);
  assert.match(WEAPON_ATTACK_CONTROLLER, /function getGeneralAttackHitChance[\s\S]*?getDisplayedAttackDodgeDifficulty\(targetActor\)/);
  assert.match(WEAPON_ATTACK_CONTROLLER, /function getAimedAttackHitChanceFromBasis[\s\S]*?dodgeDifficulty = getDisplayedAttackDodgeDifficulty/);
  assert.match(WEAPON_ATTACK_CONTROLLER, /function getDirectedAttackHitChance[\s\S]*?dodgeDifficulty: getDisplayedAttackDodgeDifficulty\(targetActor\)/);
  assert.match(
    WEAPON_ATTACK_CONTROLLER,
    /function getAimedAttackDifficulty[\s\S]*?Number\.isFinite\(dodgeDifficulty\)[\s\S]*?: getDodgeDifficulty\(targetActor, \{ ignoreCover \}\)/
  );
  assert.match(
    WEAPON_ATTACK_CONTROLLER,
    /difficulty: getAimedAttackDifficulty\([\s\S]*?target\.actor,[\s\S]*?innateDifficultyIgnorePercent:[\s\S]*?ignoreCover: this\.ignoreAimedObstructions/
  );
});

test("False Breach is active and editable in both ability constructors", () => {
  assert.match(FIXED, /key: ABILITY_FIXED_FUNCTION_KEYS\.falseBreach[\s\S]*?active: true/);
  assert.match(FIXED, /registerFalseBreachRuntime\(\)/);
  assert.match(FIXED, /async function useFalseBreach/);
  for (const source of [
    read("templates/item/item-sheet.hbs"),
    read("templates/settings/ability-catalog-item-editor.hbs")
  ]) {
    assert.match(source, /fixedFalseBreachSettings/);
    assert.match(source, /activationEnergyCost/);
    assert.match(source, /durationAmount/);
    assert.match(source, /dodgeBonus/);
    assert.match(source, /markDurationAmount/);
    assert.match(source, /incomingDamagePercent/);
    assert.match(source, /attackAdvantage/);
    assert.match(source, /overloadDurationAmount/);
  }
});
