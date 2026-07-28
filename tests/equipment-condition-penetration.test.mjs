import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFormulaVariables } from "../src/formulas/evaluation.mjs";
import { normalizeDamageTypeSettings } from "../src/formulas/normalization.mjs";
import {
  ITEM_FUNCTIONS,
  hasItemFunction,
  isItemBrokenByCondition
} from "../src/utils/item-functions.mjs";

const previousFoundry = globalThis.foundry;
globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    hasProperty: () => false,
    mergeObject: (target, source, { inplace = true } = {}) => {
      const output = inplace ? target : structuredClone(target);
      mergeValues(output, source);
      return output;
    },
    setProperty: (object, path, value) => {
      object[path] = value;
      return true;
    }
  }
};

test.after(() => {
  if (previousFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = previousFoundry;
});

test("default equipment wear includes protection bypassed by penetration", () => {
  const [damageType] = normalizeDamageTypeSettings([{
    key: "test",
    label: "Test",
    settings: {
      equipmentConditionDamage: { enabled: true }
    }
  }]);
  const formula = damageType.settings.equipmentConditionDamage.formula;

  assert.equal(formula, "protected");
  assert.equal(evaluateFormulaVariables(formula, {
    blocked: 4,
    penetrated: 6,
    protected: 10
  }), 10);
});

test("persisted blocked-only wear formulas migrate to penetration-aware formulas", () => {
  const damageTypes = normalizeDamageTypeSettings([
    {
      key: "ordinary",
      label: "Ordinary",
      settings: {
        equipmentConditionDamage: {
          enabled: true,
          formula: "blocked"
        }
      }
    },
    {
      key: "acid",
      label: "Acid",
      settings: {
        equipmentConditionDamage: {
          enabled: true,
          formula: "blocked * 3"
        }
      }
    }
  ]);

  assert.equal(
    damageTypes.find(entry => entry.key === "ordinary").settings.equipmentConditionDamage.formula,
    "protected"
  );
  assert.equal(
    damageTypes.find(entry => entry.key === "acid").settings.equipmentConditionDamage.formula,
    "protected * 3"
  );
});

test("penetration wear can reduce equipment to zero and suppress its protection", async () => {
  const {
    applyEquipmentConditionDamage,
    calculateDamageMitigation
  } = await import("../src/combat/damage-hub.mjs");
  const armor = {
    id: "armor",
    type: "gear",
    system: {
      equipped: true,
      functions: {
        condition: {
          enabled: true,
          value: 10,
          max: 10,
          weakeningThreshold: 10
        },
        damageMitigation: {
          enabled: true,
          mode: "defense",
          entries: {
            torso: {
              piercing: { value: 10 }
            }
          }
        }
      }
    }
  };
  const items = [armor];
  items.contents = items;
  items.get = id => items.find(item => item.id === id);
  const actor = {
    items,
    effects: [],
    getDamageDefense: () => 10,
    getDamageResistance: () => 0,
    allApplicableEffects: () => [],
    async updateEmbeddedDocuments(documentName, updates) {
      assert.equal(documentName, "Item");
      for (const update of updates) {
        const item = items.get(update._id);
        item.system.functions.condition.value = update["system.functions.condition.value"];
      }
      return updates;
    }
  };
  const damageType = {
    settings: {
      equipmentConditionDamage: {
        enabled: true,
        formula: "protected"
      }
    }
  };

  const result = calculateDamageMitigation(
    actor,
    10,
    "piercing",
    "torso",
    { penetrationPower: 6 },
    {
      damageType,
      includeEquipmentConditionDamage: true,
      itemOnlyMitigation: true
    }
  );

  assert.equal(result.amount, 6);
  assert.equal(result.penetrationSpent, 6);
  assert.deepEqual(result.equipmentConditionDamage, [{
    itemId: "armor",
    amount: 10
  }]);

  await applyEquipmentConditionDamage(actor, result.equipmentConditionDamage);

  assert.equal(armor.system.functions.condition.value, 0);
  assert.equal(isItemBrokenByCondition(armor), true);
  assert.equal(hasItemFunction(armor, ITEM_FUNCTIONS.damageMitigation), false);
});

function mergeValues(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && target[key]
      && typeof target[key] === "object"
      && !Array.isArray(target[key])
    ) {
      mergeValues(target[key], value);
    } else {
      target[key] = structuredClone(value);
    }
  }
  return target;
}
