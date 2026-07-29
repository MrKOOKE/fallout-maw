import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCivilianRecord,
  applyConditionWeakeningToBonuses,
  applyUnifiedCombatThreshold,
  buildCivilianFreeSettings,
  buildCivilianRecipe
} from "../scripts/rebalance/apply-civilian-clothing.mjs";

function component(itemClass, price) {
  return {
    _id: `textile-${itemClass}`,
    name: `Компонент текстиля ${itemClass} класс`,
    img: `${itemClass}.webp`,
    system: {
      price,
      placement: { width: 2, height: 2 }
    }
  };
}

function components() {
  return new Map([
    ["textile:D", component("D", 31)],
    ["textile:C", component("C", 148)],
    ["textile:B", component("B", 426)],
    ["textile:A", component("A", 840)],
    ["textile:S", component("S", 1560)]
  ]);
}

function record(overrides = {}) {
  return {
    itemId: "example-item",
    name: "Пример",
    type: "clothing",
    class: "C",
    skillBudget: 30,
    provisionalTextileRecipe: { C: 3 },
    proposedSkillBonuses: [
      {
        skillKey: "speech",
        effectKey: "system.skills.speech.bonus",
        value: 20
      },
      {
        skillKey: "repair",
        effectKey: "system.skills.repair.bonus",
        value: 10
      }
    ],
    loreReviewStatus: "test",
    semanticReason: "test",
    semanticEvidence: "test",
    semanticTags: [],
    loreSourceKeys: [],
    protectiveReview: null,
    specialFeature: null,
    ...overrides
  };
}

function item() {
  return {
    _id: "example-item",
    name: "Пример",
    img: "example.webp",
    folder: "old",
    system: {
      price: 1,
      occupiedSlots: {},
      placement: { width: 2, height: 2 },
      functions: {
        condition: {
          enabled: true,
          value: 100,
          max: 100,
          weakeningThreshold: 100
        },
        freeSettings: {
          enabled: true,
          entries: [
            {
              type: "effectChanges",
              changes: [
                {
                  key: "system.skills.gambling.bonus",
                  value: "99"
                }
              ]
            }
          ]
        },
        lightSource: { enabled: false }
      },
      craft: { recipes: [] }
    },
    flags: {},
    _stats: {}
  };
}

test("civilian free settings replace old effects with deterministic prepared bonuses", () => {
  const first = buildCivilianFreeSettings("example-item", record().proposedSkillBonuses);
  const second = buildCivilianFreeSettings("example-item", record().proposedSkillBonuses);
  assert.deepEqual(first, second);
  assert.equal(first.enabled, true);
  assert.equal(first.useConditionWeakening, true);
  assert.deepEqual(
    first.entries[0].changes.map(change => [change.key, change.value]),
    [
      ["system.skills.speech.bonus", "20"],
      ["system.skills.repair.bonus", "10"]
    ]
  );
});

test("civilian recipe uses only the prepared textile budget", () => {
  const recipe = buildCivilianRecipe(record(), components());
  assert.equal(recipe.difficulty, 70);
  assert.deepEqual(
    recipe.resolvedIngredients.map(ingredient => [
      ingredient.kind,
      ingredient.class,
      ingredient.quantity,
      ingredient.unitPrice
    ]),
    [["textile", "C", 3, 148]]
  );
});

test("applying civilian record sets folder class, threshold, paid craft and price", () => {
  const applied = applyCivilianRecord(item(), record(), components(), 1234);
  assert.equal(applied.item.system.functions.condition.weakeningThreshold, 20);
  assert.equal(applied.item.system.functions.freeSettings.useConditionWeakening, true);
  assert.equal(applied.item.system.occupiedSlots.slotxyifmb, true);
  assert.equal(applied.item.system.price, applied.price.final);
  assert.equal(applied.item.system.craft.recipes.length, 1);
  assert.deepEqual(
    applied.item.system.functions.freeSettings.entries[0].changes.map(change => change.key),
    ["system.skills.speech.bonus", "system.skills.repair.bonus"]
  );
  assert.equal(
    applied.item.flags["fallout-maw"].civilianClothingRebalance.pendingVision,
    null
  );
});

test("night vision stays deferred and adds no electronics or properties", () => {
  const nightVisionRecord = record({
    type: "headwear",
    class: "A",
    skillBudget: 55,
    provisionalTextileRecipe: { A: 2, B: 1 },
    proposedSkillBonuses: [
      {
        skillKey: "energy",
        effectKey: "system.skills.energy.bonus",
        value: 30
      },
      {
        skillKey: "rangedCombat",
        effectKey: "system.skills.rangedCombat.bonus",
        value: 25
      }
    ],
    specialFeature: {
      kind: "nightVision",
      payment: ["electronics", "properties"]
    }
  });
  const applied = applyCivilianRecord(item(), nightVisionRecord, components(), 1234);
  assert.deepEqual(
    applied.recipe.resolvedIngredients.map(ingredient => ingredient.kind),
    ["textile", "textile"]
  );
  const pending = applied.item.flags["fallout-maw"]
    .civilianClothingRebalance.pendingVision;
  assert.equal(pending.implemented, false);
  assert.equal(pending.chargedInCurrentRecipe, false);
  assert.equal(applied.item.system.functions.lightSource.enabled, false);
});

test("weapons and protected equipment receive the shared threshold 20", () => {
  const weapon = item();
  weapon.system.functions.weapon = { enabled: true };
  const updatedWeapon = applyUnifiedCombatThreshold(weapon, 1234);
  assert.equal(updatedWeapon.system.functions.condition.weakeningThreshold, 20);

  const armor = item();
  armor.system.functions.damageMitigation = { enabled: true };
  const updatedArmor = applyUnifiedCombatThreshold(armor, 1234);
  assert.equal(updatedArmor.system.functions.condition.weakeningThreshold, 20);
  assert.equal(updatedArmor.system.functions.freeSettings.useConditionWeakening, true);

  assert.equal(applyUnifiedCombatThreshold(item(), 1234), null);
});

test("any active free settings tied to condition use condition weakening", () => {
  const conditionedItem = item();
  const updated = applyConditionWeakeningToBonuses(conditionedItem, 1234);
  assert.equal(updated.system.functions.freeSettings.useConditionWeakening, true);

  const withoutCondition = item();
  withoutCondition.system.functions.condition.enabled = false;
  assert.equal(applyConditionWeakeningToBonuses(withoutCondition, 1234), null);
});
