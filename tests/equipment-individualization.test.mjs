import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEquipmentIndividualization,
  buildEquipmentIndividualizationPlan,
  equipmentCloneSignature,
  restoreEquipmentIndividualization
} from "../scripts/rebalance/equipment-individualization.mjs";

function effectEntry(changes) {
  return {
    id: "effect-entry",
    type: "effectChanges",
    changes: changes.map(([key, value], index) => ({
      id: `change-${index}`,
      key,
      type: "add",
      value: String(value),
      phase: "initial",
      priority: null
    })),
    conditions: [{
      id: "energy",
      type: "energyConsumption",
      amountPerHour: 40
    }],
    penalties: []
  };
}

function armor({
  id,
  name,
  weight = 50,
  changes = [
    ["system.characteristics.endurance", 3],
    ["system.characteristics.dexterity", 4],
    ["system.characteristics.strength", 3],
    ["system.skills.resilience.bonus", 35]
  ]
}) {
  const types = {
    piercing: { value: 143 },
    slashing: { value: 132 },
    bludgeoning: { value: 126 },
    firearm: { value: 165 },
    energy: { value: 149 },
    fire: { value: 138 },
    cryo: { value: 138 },
    electric: { value: 116 },
    acid: { value: 149 },
    poison: { value: 126 },
    radiation: { value: 0 }
  };
  return {
    _id: id,
    name,
    flags: {},
    system: {
      weight,
      functions: {
        damageMitigation: {
          enabled: true,
          mode: "defense",
          requirements: [{ type: "skill", key: "athletics", value: 80 }],
          entries: {
            torso: structuredClone(types),
            leftArm: structuredClone(types)
          }
        },
        condition: {
          enabled: true,
          value: 2400,
          max: 2400,
          weakeningThreshold: 10,
          recoveryMethods: []
        },
        freeSettings: {
          enabled: true,
          useConditionWeakening: false,
          entries: [effectEntry(changes)]
        }
      }
    }
  };
}

function row(item, family = "powerArmor") {
  return {
    item,
    itemClass: "B",
    family,
    assignment: {
      proposal: {
        specializationId: "power.balanced"
      }
    }
  };
}

test("T-51d and T-51e receive distinct lore profiles despite equal aggregate bonuses", () => {
  const d = armor({ id: "t51d", name: "Силовая броня T-51d", weight: 49.895 });
  const e = armor({
    id: "t51e",
    name: "Силовая броня T-51e",
    weight: 54.431,
    changes: [
      ["system.characteristics.endurance", 4],
      ["system.characteristics.dexterity", 3],
      ["system.characteristics.strength", 3],
      ["system.skills.resilience.bonus", 35]
    ]
  });
  const rows = [row(d), row(e)];
  assert.equal(equipmentCloneSignature(rows[0]), equipmentCloneSignature(rows[1]));

  const built = buildEquipmentIndividualizationPlan(rows);
  const dFlag = applyEquipmentIndividualization(d, built.plan.get(d._id));
  const eFlag = applyEquipmentIndividualization(e, built.plan.get(e._id));

  assert.match(dFlag.lineageId, /t51-d-energy/);
  assert.match(eFlag.lineageId, /t51-e-ceramic/);
  assert.notDeepEqual(
    d.system.functions.damageMitigation.entries,
    e.system.functions.damageMitigation.entries
  );
  assert.ok(
    d.system.functions.damageMitigation.entries.torso.energy.value
      > e.system.functions.damageMitigation.entries.torso.energy.value
  );
  assert.ok(
    e.system.functions.damageMitigation.entries.torso.firearm.value
      > d.system.functions.damageMitigation.entries.torso.firearm.value
  );
  assert.equal(d.system.functions.damageMitigation.entries.torso.radiation.value, 0);
  assert.equal(e.system.functions.damageMitigation.entries.torso.radiation.value, 0);
  assert.ok(dFlag.craftPackages.length > 0);
  assert.ok(eFlag.craftPackages.length > 0);
});

test("individualization is idempotent after restoring its recorded baseline", () => {
  const item = armor({ id: "repeat", name: "Силовая броня T-51d" });
  const rows = [row(item)];
  const built = buildEquipmentIndividualizationPlan(rows);
  const plan = built.plan.get(item._id);

  applyEquipmentIndividualization(item, plan);
  const first = JSON.stringify({
    mitigation: item.system.functions.damageMitigation,
    condition: item.system.functions.condition,
    freeSettings: item.system.functions.freeSettings,
    weight: item.system.weight
  });

  assert.equal(restoreEquipmentIndividualization(item), true);
  applyEquipmentIndividualization(item, plan);
  const second = JSON.stringify({
    mitigation: item.system.functions.damageMitigation,
    condition: item.system.functions.condition,
    freeSettings: item.system.functions.freeSettings,
    weight: item.system.weight
  });
  assert.equal(second, first);
});

test("every member of an ordinary clone group receives a distinct capability signature", () => {
  const rows = [
    row(armor({ id: "a", name: "Боевая броня" }), "mediumArmor"),
    row(armor({ id: "b", name: "Боевая броня Фельдшера" }), "mediumArmor"),
    row(armor({ id: "c", name: "Боевая броня рейнджера" }), "mediumArmor")
  ];
  const built = buildEquipmentIndividualizationPlan(rows);
  assert.equal(built.cloneGroups.length, 1);

  for (const current of rows) {
    applyEquipmentIndividualization(current.item, built.plan.get(current.item._id));
  }
  const signatures = new Set(rows.map(equipmentCloneSignature));
  assert.equal(signatures.size, rows.length);
});

