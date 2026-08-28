import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: structuredClone,
    getProperty: () => undefined,
    hasProperty: () => false,
    randomID: () => "test-id",
    setProperty: () => true
  }
};

const {
  calculateDamageMitigation,
  createDamageBatchPreparationContext,
  getDamageBatchMitigationEquipmentSnapshot
} = await import("../src/combat/damage-hub.mjs");

function createMitigationItem(id, mode, value) {
  return {
    id,
    type: "gear",
    system: {
      equipped: true,
      functions: {
        condition: {
          enabled: true,
          value: 100,
          max: 100,
          weakeningThreshold: 20
        },
        damageMitigation: {
          enabled: true,
          mode,
          entries: {
            torso: {
              piercing: { value }
            }
          }
        }
      }
    }
  };
}

test("one synchronous damage batch scans mitigation equipment once per limb/type", () => {
  const gear = [
    createMitigationItem("defense", "defense", 8),
    createMitigationItem("resistance", "resistance", 3)
  ];
  const itemSystemsBefore = structuredClone(gear.map(item => item.system));
  let itemCollectionReads = 0;
  const actor = {
    itemTypes: {
      ability: [],
      disease: [],
      gear,
      trauma: []
    },
    items: {
      get contents() {
        itemCollectionReads += 1;
        return gear;
      }
    }
  };

  const context = createDamageBatchPreparationContext(actor);
  const first = getDamageBatchMitigationEquipmentSnapshot(
    context,
    actor,
    "piercing",
    "torso"
  );
  for (let projectile = 1; projectile < 50; projectile += 1) {
    assert.equal(
      getDamageBatchMitigationEquipmentSnapshot(
        context,
        actor,
        "piercing",
        "torso"
      ),
      first
    );
  }
  assert.equal(itemCollectionReads, 1);
  assert.deepEqual(first.totals, { defense: 8, resistance: 3 });
  assert.deepEqual(first.sources.map(entry => entry.itemId), ["defense", "resistance"]);

  getDamageBatchMitigationEquipmentSnapshot(context, actor, "fire", "torso");
  assert.equal(itemCollectionReads, 2);
  assert.deepEqual(gear.map(item => item.system), itemSystemsBefore);
});

test("disabled equipment wear does not scan Items before mitigation", () => {
  const actor = {
    items: {
      get contents() {
        throw new Error("disabled equipment wear must not inspect Items");
      }
    }
  };

  const result = calculateDamageMitigation(actor, 5, "piercing", "torso", {}, {
    damageType: {
      settings: {
        equipmentConditionDamage: {
          enabled: false,
          formula: "protected"
        }
      }
    },
    includeEquipmentConditionDamage: true,
    itemOnlyMitigation: true,
    itemMitigationTotals: {
      defense: 2,
      resistance: 0
    }
  });

  assert.equal(result.amount, 3);
  assert.equal(result.amountBeforeResistance, 3);
  assert.deepEqual(result.equipmentConditionDamage, []);
});

test("percentage defense and resistance reduce the remaining damage in sequence", () => {
  const result = calculateDamageMitigation({}, 100, "piercing", "torso", {}, {
    damageMitigationCalculation: "percentage",
    itemOnlyMitigation: true,
    itemMitigationTotals: {
      defense: 50,
      resistance: 50
    }
  });

  assert.equal(result.amount, 25);
  assert.equal(result.amountBeforeResistance, 50);
  assert.equal(result.penetrationSpent, 0);
});

test("percentage vulnerabilities increase the remaining damage in sequence", () => {
  const result = calculateDamageMitigation({}, 100, "electric", "torso", {}, {
    damageMitigationCalculation: "percentage",
    itemOnlyMitigation: true,
    itemMitigationTotals: {
      defense: -50,
      resistance: -50
    }
  });

  assert.equal(result.amount, 225);
  assert.equal(result.penetrationSpent, 0);
});

test("installed construct parts use their canonical mitigation entry and condition source", () => {
  const part = {
    id: "arm-slot",
    type: "gear",
    system: {
      equipped: false,
      placement: { mode: "constructPart", limbKey: "arm-slot" },
      functions: {
        constructPart: { enabled: true },
        condition: { enabled: true, value: 100, max: 100, weakeningThreshold: 20 },
        damageMitigation: {
          enabled: true,
          mode: "resistance",
          entries: {
            constructPart: {
              electric: { value: 40 }
            }
          }
        }
      }
    }
  };
  const items = [part];
  items.contents = items;
  const actor = { items };

  const snapshot = getDamageBatchMitigationEquipmentSnapshot(
    createDamageBatchPreparationContext(actor),
    actor,
    "electric",
    "constructPart:arm-slot"
  );

  assert.deepEqual(snapshot.totals, { defense: 0, resistance: 40 });
  assert.deepEqual(snapshot.sources.map(entry => entry.itemId), ["arm-slot"]);
});
