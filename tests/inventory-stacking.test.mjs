import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {
  settings: {
    get: () => {
      throw new Error("use defaults");
    }
  }
};
globalThis.foundry = {
  applications: {
    api: {
      DialogV2: class DialogV2 {}
    },
    ux: {
      FormDataExtended: class FormDataExtended {}
    },
    handlebars: {
      renderTemplate: async () => ""
    }
  },
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject: (target, source, { inplace = true } = {}) => Object.assign(
      inplace ? target : structuredClone(target),
      structuredClone(source)
    )
  }
};

const { canStackInventoryItems } = await import("../src/inventory/stacking.mjs");

test("equipment with the same slots but different requirement modes does not stack", () => {
  const source = createGear("all");
  const target = createGear("oneOf");

  assert.equal(canStackInventoryItems(source, target), false);
  assert.equal(canStackInventoryItems(source, createGear("all")), true);
});

function createGear(occupiedSlotMode) {
  return {
    type: "gear",
    name: "Harness",
    img: "icons/svg/item-bag.svg",
    system: {
      quantity: 1,
      maxStack: 10,
      weight: 1,
      price: 5,
      priceCurrency: "caps",
      locked: false,
      width: 1,
      height: 1,
      occupiedSlotMode,
      occupiedSlots: {
        torso: true
      },
      weaponSlotRequirement: {
        mode: "all",
        slots: {}
      },
      functions: {}
    }
  };
}
