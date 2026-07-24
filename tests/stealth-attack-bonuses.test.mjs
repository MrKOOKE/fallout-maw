import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: () => "" }
  },
  utils: {}
};
globalThis.game = {
  settings: {
    get() {
      throw new Error("settings are unavailable in this unit test");
    }
  }
};
globalThis.CONFIG = { specialStatusEffects: { INVISIBLE: "stealth-hidden" } };

const {
  calculateStealthDamageBonusAmount,
  getStealthAttackModifiers
} = await import("../src/stealth/attack-bonuses.mjs");

const source = readFileSync(
  new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url),
  "utf8"
);

test("stealth attack formulas are the base and dedicated effects are signed deltas", () => {
  const settings = {
    attackBonuses: {
      accuracyFormula: "luck + 2",
      criticalChanceFormula: "luck",
      damagePercentFormula: "stealth / 5",
      criticalDamagePercentFormula: "@system.resources.actionPoints.value / 2"
    }
  };
  const actor = {
    statuses: new Set(["stealth-hidden"]),
    system: {
      characteristics: { luck: 8 },
      skills: { stealth: { value: 47 } },
      resources: { actionPoints: { value: 9, min: 0, max: 10 } },
      stealth: {
        attackBonuses: {
          accuracy: 3,
          criticalChance: -2,
          damagePercent: 4,
          criticalDamagePercent: -20
        }
      }
    }
  };

  assert.deepEqual(getStealthAttackModifiers(actor, settings), {
    active: true,
    accuracyBonus: 13,
    criticalChanceBonus: 6,
    damageBonusPercent: 13,
    criticalDamageBonusPercent: 0,
    formulaValues: {
      accuracy: 10,
      criticalChance: 8,
      damagePercent: 9,
      criticalDamagePercent: 4
    },
    effectValues: {
      accuracy: 3,
      criticalChance: -2,
      damagePercent: 4,
      criticalDamagePercent: -20
    },
    accuracyFormula: "luck + 2",
    criticalChanceFormula: "luck",
    damagePercentFormula: "stealth / 5",
    criticalDamagePercentFormula: "@system.resources.actionPoints.value / 2"
  });
});

test("missing formula fields use the old stealth mechanic as their bases", () => {
  const actor = {
    statuses: new Set(["stealth-hidden"]),
    system: {
      characteristics: { luck: 8 },
      skills: { stealth: { value: 47 } }
    }
  };

  const modifiers = getStealthAttackModifiers(actor, {
    attackBonuses: { accuracyFormula: "2" }
  });
  assert.equal(modifiers.accuracyBonus, 2);
  assert.equal(modifiers.criticalChanceBonus, 8);
  assert.equal(modifiers.damageBonusPercent, 9);
  assert.equal(modifiers.criticalDamageBonusPercent, 0);
  assert.equal(modifiers.criticalChanceFormula, "luck");
  assert.equal(modifiers.damagePercentFormula, "stealth / 5");
});

test("visible actors keep formulas but ignore formula and effect bonuses", () => {
  const actor = {
    statuses: new Set(),
    system: {
      characteristics: { luck: 8 },
      skills: { stealth: { value: 47 } },
      stealth: { attackBonuses: { accuracy: 100 } }
    }
  };

  const modifiers = getStealthAttackModifiers(actor, {});
  assert.equal(modifiers.active, false);
  assert.equal(modifiers.accuracyBonus, 0);
  assert.equal(modifiers.criticalChanceBonus, 0);
  assert.equal(modifiers.damageBonusPercent, 0);
  assert.equal(modifiers.criticalDamageBonusPercent, 0);
  assert.deepEqual(modifiers.formulaValues, {
    accuracy: 0,
    criticalChance: 0,
    damagePercent: 0,
    criticalDamagePercent: 0
  });
  assert.deepEqual(modifiers.effectValues, modifiers.formulaValues);
});

test("stealth damage bonus uses the shared post-base floor calculation", () => {
  assert.equal(calculateStealthDamageBonusAmount(63, 19), 11);
  assert.equal(calculateStealthDamageBonusAmount(63, 19.9), 11);
  assert.equal(calculateStealthDamageBonusAmount(10, 20, { shareCount: 3 }), 0);
  assert.equal(calculateStealthDamageBonusAmount(20, 20, { shareCount: 3 }), 3);
  assert.equal(calculateStealthDamageBonusAmount(-10, 25), 0);
  assert.equal(calculateStealthDamageBonusAmount(100, -25), 0);
});

test("weapon attacks apply configured stealth accuracy to shared and aimed paths", () => {
  assert.match(
    source,
    /function getWeaponAccuracyModifier[\s\S]*?const stealth = getStealthAttackModifiers\(actor\);[\s\S]*?\+ stealth\.accuracyBonus[\s\S]*?- getWeaponConditionAccuracyPenalty/
  );
  assert.match(
    source,
    /function buildAimedAttackChanceBasis[\s\S]*?const stealth = getStealthAttackModifiers\(attackerActor\);[\s\S]*?const finalSkillValue[\s\S]*?\+ stealth\.accuracyBonus[\s\S]*?- getWeaponConditionAccuracyPenalty/
  );
});

test("weapon attacks apply configured stealth critical chance in both critical paths", () => {
  assert.match(
    source,
    /function getWeaponCriticalCheckModifiers[\s\S]*?\+ stealth\.criticalChanceBonus[\s\S]*?criticalSuccessBonus/
  );
  assert.match(
    source,
    /function getAttackModeCriticalCheckModifiers[\s\S]*?\+ stealth\.criticalChanceBonus[\s\S]*?criticalSuccessBonus/
  );
});

test("damage snapshot applies stealth damage once and adds critical damage before multiplying", () => {
  assert.match(
    source,
    /function getCriticalDamageSnapshot[\s\S]*?\+ stealth\.criticalDamageBonusPercent\)[\s\S]*?stealthDamageBonusPercent/
  );
  assert.match(
    source,
    /function applyCriticalDamageSnapshot[\s\S]*?calculateStealthDamageBonusAmount\([\s\S]*?const modifiedBaseAmount = baseAmount \+ stealthDamage;[\s\S]*?Math\.round\(modifiedBaseAmount \*/
  );
});
