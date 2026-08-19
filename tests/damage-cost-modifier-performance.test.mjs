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
  getActionCostModifierState,
  getDamageCostModifierState
} = await import("../src/combat/damage-hub.mjs");
const { getFirstAidActionPointCost } = await import("../src/items/first-aid-action-cost.mjs");

test("damage cost state traverses applicable effects once for every cost key", () => {
  let applicableEffectReads = 0;
  const effects = [
    {
      disabled: false,
      changes: [
        { key: "system.costs.action", type: "add", value: "2" },
        { key: "system.costs.action", type: "multiply", value: "1.5" },
        { key: "system.costs.actions.aimedShot", type: "override", value: "7" },
        { key: "system.costs.movement", type: "add", value: "3" }
      ]
    },
    {
      disabled: true,
      changes: [
        { key: "system.costs.action", type: "add", value: "99" }
      ]
    }
  ];
  const actor = {
    system: {},
    items: { contents: [] },
    *allApplicableEffects() {
      applicableEffectReads += 1;
      yield* effects;
    }
  };

  assert.deepEqual(getDamageCostModifierState(actor, { actionKey: "aimedShot" }), {
    movement: { add: 3, multiplier: 1, override: null },
    action: { add: 2, multiplier: 1.5, override: 7 }
  });
  assert.equal(applicableEffectReads, 1);
});

test("first-aid cost uses the general and dedicated action keys with one effect traversal", () => {
  let applicableEffectReads = 0;
  const actor = {
    system: {},
    items: { contents: [] },
    *allApplicableEffects() {
      applicableEffectReads += 1;
      yield {
        disabled: false,
        changes: [
          { key: "system.costs.action", type: "add", value: "1" },
          { key: "system.costs.actions.firstAid", type: "add", value: "-3" }
        ]
      };
    }
  };

  assert.deepEqual(getActionCostModifierState(actor, { actionKey: "firstAid" }), {
    add: -2,
    multiplier: 1,
    override: null
  });
  assert.equal(applicableEffectReads, 1);

  applicableEffectReads = 0;
  assert.equal(getFirstAidActionPointCost(actor, { actionPointCost: 5 }), 3);
  assert.equal(applicableEffectReads, 1);
});
