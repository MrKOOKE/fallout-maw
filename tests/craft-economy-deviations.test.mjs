import test from "node:test";
import assert from "node:assert/strict";
import {
  equipmentSignals,
  measuredDeviationRank,
  namedVariantBase,
  namedVariantPriceDominance
} from "../scripts/rebalance/apply-craft-economy.mjs";

test("measuredDeviationRank prices a plateau cohort instead of disabling deviations", () => {
  const thresholds = {
    min: 100,
    q10: 100,
    q25: 100,
    q50: 100,
    q75: 100,
    q90: 120,
    max: 130
  };

  assert.equal(measuredDeviationRank(100, thresholds, { meaningfulStep: 5 }), 0);
  assert.equal(measuredDeviationRank(104, thresholds, { meaningfulStep: 5 }), 0);
  assert.equal(measuredDeviationRank(110, thresholds, { meaningfulStep: 5 }), 1);
  assert.equal(measuredDeviationRank(125, thresholds, { meaningfulStep: 5 }), 3);
});

test("measuredDeviationRank supports useful lower values such as noise or weight", () => {
  const thresholds = {
    min: 30,
    q10: 35,
    q25: 40,
    q50: 50,
    q75: 60,
    q90: 65,
    max: 70
  };

  assert.equal(measuredDeviationRank(50, thresholds, {
    direction: "lower",
    meaningfulStep: 5
  }), 0);
  assert.equal(measuredDeviationRank(40, thresholds, {
    direction: "lower",
    meaningfulStep: 5
  }), 1);
  assert.equal(measuredDeviationRank(30, thresholds, {
    direction: "lower",
    meaningfulStep: 5
  }), 2);
});

test("equipmentSignals includes protection channels, bonuses, weight and requirements", () => {
  const item = {
    system: {
      weight: 40,
      occupiedSlots: {
        armor: true,
        mask: false
      },
      functions: {
        condition: {
          max: 2400
        },
        damageMitigation: {
          requirements: [
            { type: "skill", key: "athletics", value: 50 }
          ],
          entries: {
            torso: {
              piercing: { value: 100 },
              slashing: { value: 90 },
              bludgeoning: { value: 80 },
              firearm: { value: 110 },
              energy: { value: 120 },
              electric: { value: 130 },
              fire: { value: 70 },
              cryo: { value: 60 },
              acid: { value: 50 },
              poison: { value: 40 },
              radiation: { value: 30 }
            }
          }
        },
        freeSettings: {
          enabled: true,
          entries: [{
            changes: [
              {
                key: "system.characteristics.strength",
                type: "add",
                value: "3"
              },
              {
                key: "system.skills.resilience.bonus",
                type: "add",
                value: "10"
              },
              {
                key: "system.characteristics.perception",
                type: "add",
                value: "-1"
              }
            ],
            conditions: [{
              type: "energyConsumption",
              amountPerHour: 40
            }]
          }]
        }
      }
    }
  };

  const signals = equipmentSignals(item);
  assert.equal(signals.kineticProtection, 380);
  assert.equal(signals.energyProtection, 250);
  assert.equal(signals.thermalProtection, 130);
  assert.equal(signals.environmentalProtection, 120);
  assert.equal(signals.characteristicBonus, 3);
  assert.equal(signals.skillBonus, 10);
  assert.equal(signals.skillBonusEquivalent, 2);
  assert.equal(signals.effectBonusScore, 5);
  assert.equal(signals.weight, 40);
  assert.equal(signals.wearRequirementBurden, 10);
  assert.equal(signals.energyConsumptionPerHour, 40);
  assert.equal(signals.conditionMax, 2400);
});

test("named variants cannot keep the same price when one strictly dominates the other", () => {
  const makeRow = ({
    id,
    name,
    price,
    protectionAverage,
    energyProtection,
    characteristicBonus,
    weight
  }) => ({
    group: "equipment",
    itemClass: "B",
    item: { _id: id, name },
    recipe: {
      family: "powerArmor",
      price: { final: price },
      signals: {
        protectionAverage,
        kineticProtection: 300,
        energyProtection,
        thermalProtection: 200,
        environmentalProtection: 100,
        conditionMax: 2400,
        characteristicBonus,
        skillBonusEquivalent: 7,
        otherPositiveChanges: 0,
        weight,
        coveredLimbs: 6,
        occupiedSlotCount: 1,
        wearRequirementBurden: 0,
        energyConsumptionPerHour: 40
      }
    }
  });
  const base = makeRow({
    id: "base",
    name: "Power Armor Mk.I",
    price: 1000,
    protectionAverage: 150,
    energyProtection: 300,
    characteristicBonus: 10,
    weight: 45
  });
  const tesla = makeRow({
    id: "tesla",
    name: "Power Armor Mk.I «Tesla»",
    price: 1000,
    protectionAverage: 156,
    energyProtection: 400,
    characteristicBonus: 13,
    weight: 40
  });

  assert.equal(namedVariantBase(base.item.name), namedVariantBase(tesla.item.name));
  assert.equal(namedVariantPriceDominance([base, tesla]).length, 1);
  tesla.recipe.price.final = 1001;
  assert.equal(namedVariantPriceDominance([base, tesla]).length, 0);
});
