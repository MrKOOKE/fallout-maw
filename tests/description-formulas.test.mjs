import assert from "node:assert/strict";
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

const { buildDescriptionFormulaData } = await import("../src/formulas/description-formulas.mjs");
const { formatFormulaForDisplay } = await import("../src/utils/formula-display.mjs");
const { formatActorFormulaForDisplay } = await import("../src/utils/actor-formulas.mjs");

function createFormulaSystem(strength, medicine) {
  return {
    characteristics: { strength },
    skills: { medicine: { value: medicine } }
  };
}

test("description formula data uses relative actor when roll data is absent", () => {
  const actor = {
    documentName: "Actor",
    system: createFormulaSystem(3, 12)
  };

  const data = buildDescriptionFormulaData({ relativeTo: actor });

  assert.equal(data.characteristics.strength, 3);
  assert.equal(data.skills.medicine, 12);
});

test("explicit roll data takes priority over the relative item's actor", () => {
  const actor = {
    documentName: "Actor",
    system: createFormulaSystem(3, 12)
  };
  const item = { parent: actor };

  const data = buildDescriptionFormulaData({
    relativeTo: item,
    rollData: () => ({ system: createFormulaSystem(9, 37) })
  });

  assert.equal(data.characteristics.strength, 9);
  assert.equal(data.skills.medicine, 37);
});

test("formula display replaces characteristic and skill keys and abbreviations with labels and values", () => {
  const result = formatFormulaForDisplay("wis+dex/2+rangedCombat", {
    characteristics: [
      { key: "perception", abbr: "wis", label: "Восприятие" },
      { key: "dexterity", abbr: "dex", label: "Ловкость" }
    ],
    skills: [{ key: "rangedCombat", abbr: "ran", label: "Дальний бой" }],
    characteristicValues: { perception: 12, dexterity: 14 },
    skillValues: { rangedCombat: 63 }
  });

  assert.equal(result, "Восприятие (12) + Ловкость (14) / 2 + Дальний бой (63)");
  assert.doesNotMatch(result, /\b(?:wis|dex|rangedCombat)\b/);
});

test("formula display does not treat punctuation inside configured labels as operators", () => {
  const result = formatFormulaForDisplay("sci/2", {
    skills: [{ key: "science", abbr: "sci", label: "Научно-технический навык" }],
    skillValues: { science: 40 }
  });

  assert.equal(result, "Научно-технический навык (40) / 2");
});

test("actor formula display uses the actor's prepared characteristic and skill values", () => {
  const actor = {
    system: {
      characteristics: { perception: 11, dexterity: 9 },
      skills: { rangedCombat: { value: 58 } }
    }
  };

  const result = formatActorFormulaForDisplay("wis+dex/2+ran", actor);

  assert.equal(result, "Восприятие (11) + Ловкость (9) / 2 + Дальний бой (58)");
  assert.doesNotMatch(result, /\b(?:wis|dex|ran)\b/);
});
