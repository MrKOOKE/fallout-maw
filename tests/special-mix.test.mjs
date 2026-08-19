import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => "generated-id"
  }
};

const { normalizeSpecialMixSettings } = await import("../src/settings/abilities.mjs");
const {
  areDistinctSpecialMixMedicines,
  buildSpecialMixItemData,
  getSpecialMixFirstAidDetails,
  isSpecialMixMedicineEligible,
  mergeSpecialMixFirstAid
} = await import("../src/abilities/special-mix.mjs");
const {
  EFFECT_EXPIRATION_ACTIONS,
  buildBearerExpirationEffectData,
  getEffectExpirationAction,
  isEffectActuallyExpired
} = await import("../src/effects/expiration-actions.mjs");

test("special mix settings preserve the requested defaults", () => {
  assert.deepEqual(normalizeSpecialMixSettings(), {
    energyCost: 30,
    actionPointCost: 2,
    overloadEnergyCost: 50,
    overloadDurationSeconds: 6 * 60 * 60,
    effectivenessPercentBonus: 100,
    durationPercentBonus: 50,
    spoilDurationSeconds: 30 * 60
  });
});

test("special mix accepts two different usable flat-healing medicines", () => {
  const first = createMedicine("a", "Стимулятор");
  const second = createMedicine("b", "Баффаут");
  assert.equal(isSpecialMixMedicineEligible(first), true);
  assert.equal(areDistinctSpecialMixMedicines(first, second), true);
  assert.equal(areDistinctSpecialMixMedicines(first, createMedicine("c", " стимулятор ")), false);
  assert.equal(isSpecialMixMedicineEligible(createMedicine("d", "Процент", { healingIsPercentage: true })), false);
  assert.equal(isSpecialMixMedicineEligible(createMedicine("e", "Пустой", { charges: { value: 0, max: 1 } })), false);
});

test("special mix bakes effectiveness into summed effects and forces exactly one charge", () => {
  const first = createMedicine("a", "А", {
    healing: 20,
    durationSeconds: 12,
    needs: [{ needKey: "hunger", value: -5 }],
    changes: [{ key: "system.skills.doctor.bonus", type: "add", value: "2" }]
  });
  const second = createMedicine("b", "Б", {
    healing: 30,
    durationSeconds: 20,
    needs: [{ needKey: "hunger", value: -7 }],
    changes: [{ key: "system.characteristics.endurance.value", type: "add", value: "1" }]
  });
  const merged = mergeSpecialMixFirstAid(
    first.system.functions.firstAid,
    second.system.functions.firstAid
  );
  assert.equal(merged.healing, 100);
  assert.equal(merged.durationSeconds, 24);
  assert.equal("effectivenessPercentBonus" in merged, false);
  assert.equal("durationPercentBonus" in merged, false);
  assert.deepEqual(merged.charges, { value: 1, max: 1 });
  assert.deepEqual(merged.needs, [{ needKey: "hunger", value: -24 }]);
  assert.equal(merged.changes.length, 2);
  assert.deepEqual(merged.changes.map(change => change.value), ["4", "2"]);
});

test("special mix follows sum-then-double and integer-average-then-half formulas", () => {
  const first = createMedicine("a", "А", {
    healing: 40,
    durationSeconds: 11,
    limbSelection: { count: 1, value: 10 },
    changes: [{ key: "system.characteristics.agility", type: "add", value: "0" }]
  });
  const second = createMedicine("b", "Б", {
    healing: 50,
    durationSeconds: 20,
    limbSelection: { count: 1, value: 5 },
    changes: [{ key: "system.characteristics.agility", type: "add", value: "2" }]
  });
  const merged = mergeSpecialMixFirstAid(
    first.system.functions.firstAid,
    second.system.functions.firstAid
  );
  assert.equal(merged.healing, 180);
  assert.equal(merged.durationSeconds, 22);
  assert.deepEqual(merged.limbSelection, { count: 1, value: 30 });
  assert.deepEqual(merged.changes, [{
    key: "system.characteristics.agility",
    type: "add",
    value: "4",
    phase: "initial",
    priority: null
  }]);
});

test("medicine details group withdrawal under one localized payoff heading", () => {
  const details = getSpecialMixFirstAidDetails({
    charges: { value: 1, max: 1 },
    withdrawalDurationSeconds: 600,
    withdrawal: [
      { key: "system.characteristics.agility", type: "add", value: "-2" },
      { key: "system.resources.actionPoints.bonus", type: "add", value: "-2" }
    ]
  }, {
    pathLabels: new Map([
      ["system.characteristics.agility", "Ловкость"],
      ["system.resources.actionPoints.bonus", "Очки действия"]
    ])
  });
  assert.deepEqual(details.rows, [
    { kind: "section", label: "Отдача:" },
    { label: "Длительность", value: "10 мин" },
    { label: "Ловкость", value: "-2" },
    { label: "Очки действия", value: "-2" }
  ]);
});

test("created dose carries its own delete-bearer expiration action", () => {
  const data = buildSpecialMixItemData({
    firstItem: createMedicine("a", "А"),
    secondItem: createMedicine("b", "Б"),
    abilityItem: { uuid: "Actor.actor.Item.ability", img: "ability.webp" },
    settings: normalizeSpecialMixSettings(),
    startTime: 100
  });
  assert.equal(data.system.quantity, 1);
  assert.equal(data.system.maxStack, 1);
  assert.deepEqual(data.system.functions.firstAid.charges, { value: 1, max: 1 });
  assert.equal(data.effects.length, 1);
  assert.equal(data.effects[0].duration.value, 1800);
  assert.equal(getEffectExpirationAction(data.effects[0]), EFFECT_EXPIRATION_ACTIONS.deleteBearer);
});

test("delete-bearer action runs only for an actually expired Item effect", () => {
  const source = buildBearerExpirationEffectData({ durationSeconds: 1800 });
  const parent = { documentName: "Item" };
  assert.equal(isEffectActuallyExpired({ ...source, parent, duration: { remaining: 0 } }), true);
  assert.equal(isEffectActuallyExpired({ ...source, parent, duration: { remaining: 1 } }), false);
  assert.equal(isEffectActuallyExpired({ ...source, parent: { documentName: "Actor" }, duration: { remaining: 0 } }), false);
});

function createMedicine(id, name, firstAidOverrides = {}) {
  const firstAid = {
    enabled: true,
    healing: 10,
    healingIsPercentage: false,
    durationSeconds: 6,
    actionPointCost: 0,
    maxDistance: 1,
    difficulty: 0,
    skillKey: "doctor",
    criticalSuccessHealingBonus: 20,
    criticalFailureDamageMin: 1,
    criticalFailureDamageMax: 10,
    charges: { value: 1, max: 1 },
    needs: [],
    limbSelection: { count: 0, value: 0 },
    removeEffects: [],
    changes: [],
    withdrawalDurationSeconds: 0,
    withdrawal: [],
    ...firstAidOverrides
  };
  return {
    id,
    name,
    type: "gear",
    img: `${id}.webp`,
    system: {
      description: "",
      quantity: 1,
      maxStack: 1,
      weight: 0.1,
      price: 10,
      placement: { mode: "inventory", x: 1, y: 1, width: 1, height: 1, rotated: false },
      functions: { firstAid }
    }
  };
}
