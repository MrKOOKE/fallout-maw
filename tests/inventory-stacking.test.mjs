import assert from "node:assert/strict";
import test from "node:test";

let settingsReads = 0;
globalThis.game = {
  settings: {
    get: () => {
      settingsReads += 1;
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

const {
  canStackInventoryItems,
  createInventoryStackCandidateIndex,
  getInventoryStackCandidates
} = await import("../src/inventory/stacking.mjs");

test("equipment with the same slots but different requirement modes does not stack", () => {
  const source = createGear("all");
  const target = createGear("oneOf");

  assert.equal(canStackInventoryItems(source, target), false);
  assert.equal(canStackInventoryItems(source, createGear("all")), true);
});

test("unrelated stack candidates are rejected before normalized settings are read", () => {
  const source = createGear("all");
  const unrelated = createGear("all");
  unrelated.name = "Unrelated";
  settingsReads = 0;

  assert.equal(canStackInventoryItems(source, unrelated), false);
  assert.equal(settingsReads, 0);
});

test("candidate index returns only items with matching cheap stack scalars", () => {
  const source = createGear("all");
  const compatibleCandidate = createGear("all");
  const unrelated = createGear("all");
  unrelated.img = "icons/svg/mystery-man.svg";
  const index = createInventoryStackCandidateIndex([compatibleCandidate, unrelated]);

  assert.deepEqual(getInventoryStackCandidates(index, source), [compatibleCandidate]);
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
