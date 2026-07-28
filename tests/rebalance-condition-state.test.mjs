import assert from "node:assert/strict";
import test from "node:test";

import {
  rebalanceWeaponRecoveryMethods,
  rebalancedWeaponConditionCost,
  rebalancedWeaponConditionMax,
  resizedConditionState,
  UNIFIED_WEAKENING_THRESHOLD,
  weaponConditionSurplusComponentCount
} from "../scripts/rebalance/condition-state.mjs";
import {
  damageSourceRecipe,
  damageSourceSignals,
  rebalanceDamageSourceCombat
} from "../scripts/rebalance/apply-craft-economy.mjs";

function damageSourceItem(name, overrides = {}) {
  return {
    name,
    system: {
      functions: {
        damageSource: {
          enabled: true,
          damage: "149",
          pellets: "8",
          penetration: "3",
          accuracyBonus: "-5",
          criticalChanceModifier: "0",
          criticalDamagePercent: "0",
          maxRangeMeters: "-2",
          effectiveRange: { value: "0", max: "-1" },
          damageTypes: [{ key: "firearm", percent: 100 }],
          volley: {},
          ...overrides
        }
      }
    }
  };
}

test("weapon condition uses the new class base and preserves only old technical durability", () => {
  assert.equal(rebalancedWeaponConditionMax(700, "D", "Оружие / Уникальное / 10"), 200);
  assert.equal(rebalancedWeaponConditionMax(1400, "D", "Оружие / Уникальное / Миниган"), 400);
  assert.equal(rebalancedWeaponConditionMax(1200, "A", "Легендарное"), 1000);
  assert.equal(rebalancedWeaponConditionMax(40, "D", "Обычное"), 40);
  assert.equal(rebalancedWeaponConditionMax(800, "S", "Дикая Пустошь"), 600);
  assert.equal(
    rebalancedWeaponConditionMax(
      700,
      "D",
      "Уникальное",
      "Износостойкий дробовик караванщика"
    ),
    250
  );
  assert.equal(
    rebalancedWeaponConditionMax(
      400,
      "A",
      "Редкое",
      "Надежная Автоматическая Винтовка"
    ),
    625
  );
});

test("condition wear is remapped with class while surplus durability costs components", () => {
  assert.equal(rebalancedWeaponConditionCost(13, "D", "Уникальное"), 4);
  assert.equal(rebalancedWeaponConditionCost(20, "B", "Уникальное"), 11);
  assert.equal(rebalancedWeaponConditionCost(3, "D", "Обычное"), 3);
  assert.equal(weaponConditionSurplusComponentCount(200, "D"), 0);
  assert.equal(weaponConditionSurplusComponentCount(250, "D"), 1);
  assert.equal(weaponConditionSurplusComponentCount(300, "D"), 2);
  assert.equal(weaponConditionSurplusComponentCount(400, "D"), 4);
});

test("weapon repair class and difficulty follow the new weapon class", () => {
  assert.deepEqual(
    rebalanceWeaponRecoveryMethods([
      { type: "tools", toolKey: "repair", toolClass: "S", difficulty: 260 }
    ], "D"),
    [{ type: "tools", toolKey: "repair", toolClass: "D", difficulty: 60 }]
  );
});

test("condition resizing preserves wear percentage and standardizes weakening threshold", () => {
  const result = resizedConditionState(
    { value: 150, max: 300, weakeningThreshold: 20 },
    { targetMax: 400 }
  );
  assert.equal(result.value, 200);
  assert.equal(result.max, 400);
  assert.equal(result.weakeningThreshold, UNIFIED_WEAKENING_THRESHOLD);
  assert.equal(result.adjustment.maxChanged, true);
  assert.equal(result.adjustment.weakeningThresholdChanged, true);
});

test("ordinary buckshot is a stable same-class baseline without handling penalties", () => {
  const item = damageSourceItem("20 калибр «Картечь»");
  const adjustment = rebalanceDamageSourceCombat(
    item,
    "Боеприпасы / 20 калибр / C класс",
    "C",
    "shotgunShell"
  );
  const source = item.system.functions.damageSource;
  assert.equal(source.accuracyBonus, "0");
  assert.equal(source.maxRangeMeters, "0");
  assert.equal(source.effectiveRange.max, "0");
  assert.match(adjustment.reason, /стабильным вариантом/u);
});

test("deviant shotshells keep their intentional penalties and signed signals", () => {
  const item = damageSourceItem("20 калибр «Зажигательный»");
  assert.equal(
    rebalanceDamageSourceCombat(
      item,
      "Боеприпасы / 20 калибр / C класс",
      "C",
      "shotgunShell"
    ),
    null
  );
  assert.equal(item.system.functions.damageSource.accuracyBonus, "-5");
  assert.equal(damageSourceSignals(item).maxRange, -2);
  assert.equal(damageSourceSignals(item).effectiveFar, -1);
});

test("cryogenic charges use four stream packets with control-adjusted damage and technological recipes", () => {
  const expectedDamage = { C: "160", B: "240", A: "336" };
  for (const [itemClass, damage] of Object.entries(expectedDamage)) {
    const item = damageSourceItem("Криогенный заряд", {
      damage: "1",
      pellets: "1",
      damageTypes: [{ key: "cryo", percent: 100 }]
    });
    const adjustment = rebalanceDamageSourceCombat(
      item,
      `Боеприпасы / Криогенный заряд / ${itemClass} класс`,
      itemClass,
      "cryoCharge"
    );
    const source = item.system.functions.damageSource;
    assert.ok(adjustment);
    assert.equal(source.damage, damage);
    assert.equal(source.pellets, "4");
    assert.deepEqual(source.damageTypes, [{ key: "cryo", percent: 100 }]);
  }

  const recipeItem = damageSourceItem("Криогенный заряд");
  const recipe = damageSourceRecipe(
    recipeItem,
    "Боеприпасы / Прочее / C класс",
    "C"
  );
  assert.equal(recipe.family, "cryoCharge");
  assert.equal(recipe.resultQuantity, 20);
  assert.deepEqual(
    new Set(recipe.ingredients.map(ingredient => ingredient.kind)),
    new Set(["chemistry", "properties", "electronics"])
  );
});

test("high-discharge batteries are real damage sources even for manual-damage consumers", () => {
  const item = damageSourceItem("Высокоразрядная оружейная батарея (B)", {
    damage: "0",
    penetration: "0",
    damageTypes: [{ key: "energy", percent: 100 }]
  });
  const adjustment = rebalanceDamageSourceCombat(
    item,
    "Источники энергии / B класс",
    "B",
    "energyCell"
  );
  assert.ok(adjustment);
  assert.equal(item.system.functions.damageSource.damage, "86");
  assert.equal(item.system.functions.damageSource.penetration, "30");
  assert.deepEqual(
    item.system.functions.damageSource.damageTypes,
    [{ key: "energy", percent: 100 }]
  );
});

test("critical soft-target and weighted ammunition pay for their actual deviations", () => {
  const lethal = damageSourceRecipe(
    damageSourceItem(".22 LR «Убойный»"),
    "Боеприпасы / .22 LR / C",
    "C",
    "conventionalBallistic"
  );
  const enhanced = damageSourceRecipe(
    damageSourceItem(".22 LR «Усиленный»"),
    "Боеприпасы / .22 LR / C",
    "C",
    "conventionalBallistic"
  );
  const weighted = damageSourceRecipe(
    damageSourceItem("Шарик для пневматики «Утяжелённый»"),
    "Боеприпасы / Шарик для пневматики / C",
    "C",
    "conventionalBallistic"
  );

  const units = recipe => recipe.ingredients.reduce((sum, ingredient) => sum + ingredient.quantity, 0);
  assert.ok(units(lethal) > units(enhanced));
  assert.ok(weighted.ingredients.some(ingredient =>
    ingredient.kind === "frame" && ingredient.quantity >= 2
  ));
});
