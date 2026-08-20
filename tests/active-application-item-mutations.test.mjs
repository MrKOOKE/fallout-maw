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

const {
  ABILITY_ACTION_TYPES,
  normalizeAbilityFunctions,
  normalizeTreatmentClassShift
} = await import("../src/settings/abilities.mjs");
const {
  applyActiveApplicationItemMutations,
  buildActiveApplicationItemMutationUpdates,
  buildTreatmentClassShiftUpdates,
  hasActiveApplicationItemMutations,
  rollbackActiveApplicationItemMutations
} = await import("../src/abilities/active-application-item-mutations.mjs");

test("treatment class shift normalizes supported item types and bounded steps", () => {
  assert.deepEqual(normalizeTreatmentClassShift({
    itemTypes: ["trauma", "gear", "disease"],
    steps: -20
  }), {
    itemTypes: ["trauma", "disease"],
    steps: -4
  });
  assert.equal(hasActiveApplicationItemMutations({
    treatmentClassShift: { itemTypes: ["trauma"], steps: -2 }
  }), true);
  assert.equal(hasActiveApplicationItemMutations({
    treatmentClassShift: { itemTypes: ["trauma"], steps: 0 }
  }), false);
});

test("legacy active setting migrates into an ordinary treatment action", () => {
  const [abilityFunction] = normalizeAbilityFunctions([{
    id: "legacy-function",
    type: "activeApplication",
    activeSettings: {
      treatmentClassShift: { itemTypes: ["trauma", "disease"], steps: -2 }
    },
    actions: []
  }]);
  assert.equal(abilityFunction.activeSettings.treatmentClassShift, undefined);
  assert.equal(abilityFunction.actions.length, 1);
  assert.equal(abilityFunction.actions[0].type, ABILITY_ACTION_TYPES.treatmentClassShift);
  assert.deepEqual(abilityFunction.actions[0].treatmentClassShift, {
    itemTypes: ["trauma", "disease"],
    steps: -2
  });
});

test("multiple treatment actions are folded into one embedded-item update batch", () => {
  const actor = createActor([
    createItem("trauma-a", "trauma", "A"),
    createItem("disease-a", "disease", "A")
  ]);
  const abilityFunction = {
    actions: [
      {
        type: ABILITY_ACTION_TYPES.treatmentClassShift,
        treatmentClassShift: { itemTypes: ["trauma", "disease"], steps: -1 }
      },
      {
        type: ABILITY_ACTION_TYPES.treatmentClassShift,
        treatmentClassShift: { itemTypes: ["trauma"], steps: -1 }
      }
    ]
  };
  assert.deepEqual(buildActiveApplicationItemMutationUpdates(actor, abilityFunction), [
    { _id: "trauma-a", "system.healingToolClass": "C" },
    { _id: "disease-a", "system.healingToolClass": "B" }
  ]);
});

test("treatment class shift plans only current selected condition types and clamps ranks", () => {
  const actor = createActor([
    createItem("trauma-a", "trauma", "A"),
    createItem("trauma-c", "trauma", "C"),
    createItem("trauma-d", "trauma", "D"),
    createItem("disease-s", "disease", "S"),
    createItem("gear-a", "gear", "A")
  ]);

  assert.deepEqual(buildTreatmentClassShiftUpdates(actor, {
    itemTypes: ["trauma"],
    steps: -2
  }), [
    { _id: "trauma-a", "system.healingToolClass": "C" },
    { _id: "trauma-c", "system.healingToolClass": "D" }
  ]);

  assert.deepEqual(buildTreatmentClassShiftUpdates(actor, {
    itemTypes: ["disease"],
    steps: -2
  }), [
    { _id: "disease-s", "system.healingToolClass": "B" }
  ]);
});

test("active application changes embedded items in one batch and can roll it back", async () => {
  const actor = createActor([
    createItem("trauma-a", "trauma", "A"),
    createItem("trauma-b", "trauma", "B"),
    createItem("disease-s", "disease", "S")
  ]);
  const updateOptions = { falloutMawSystemEvent: { rootId: "ability-use" } };

  const result = await applyActiveApplicationItemMutations(actor, {
    treatmentClassShift: { itemTypes: ["trauma", "disease"], steps: -2 }
  }, updateOptions);

  assert.equal(result.changed, 3);
  assert.equal(actor.updateCalls.length, 1);
  assert.equal(actor.items.get("trauma-a").system.healingToolClass, "C");
  assert.equal(actor.items.get("trauma-b").system.healingToolClass, "D");
  assert.equal(actor.items.get("disease-s").system.healingToolClass, "B");
  assert.equal(actor.updateCalls[0].options, updateOptions);

  await rollbackActiveApplicationItemMutations([result]);
  assert.equal(actor.updateCalls.length, 2);
  assert.equal(actor.items.get("trauma-a").system.healingToolClass, "A");
  assert.equal(actor.items.get("trauma-b").system.healingToolClass, "B");
  assert.equal(actor.items.get("disease-s").system.healingToolClass, "S");
});

function createItem(id, type, healingToolClass) {
  return { id, type, system: { healingToolClass } };
}

function createActor(sourceItems) {
  const items = [...sourceItems];
  items.get = id => items.find(item => item.id === id);
  return {
    items,
    updateCalls: [],
    async updateEmbeddedDocuments(documentName, updates, options) {
      assert.equal(documentName, "Item");
      this.updateCalls.push({ updates: structuredClone(updates), options });
      for (const update of updates) {
        this.items.get(update._id).system.healingToolClass = update["system.healingToolClass"];
      }
    }
  };
}
