import assert from "node:assert/strict";
import test from "node:test";

import { TRAUMA_CREATE_OPTION } from "../src/constants.mjs";
import { createdItemRequiresInventoryRepair } from "../src/inventory/repair-triggers.mjs";

const traumaCreateOptions = {
  [TRAUMA_CREATE_OPTION]: true
};

function traumaWithChanges(changes = [], effect = {}) {
  return {
    type: "trauma",
    effects: [{
      transfer: true,
      disabled: false,
      system: { changes },
      ...effect
    }]
  };
}

test("damage-created trauma skips inventory repair unless its transfer effect can change placement", () => {
  assert.equal(createdItemRequiresInventoryRepair({ type: "gear" }, traumaCreateOptions), true);
  assert.equal(createdItemRequiresInventoryRepair({ type: "trauma", effects: [] }, {}), true);
  assert.equal(createdItemRequiresInventoryRepair(
    traumaWithChanges([{ key: "system.resources.health.max" }]),
    traumaCreateOptions
  ), false);
  assert.equal(createdItemRequiresInventoryRepair(
    traumaWithChanges([{ key: "system.inventory.columns" }]),
    traumaCreateOptions
  ), true);
  assert.equal(createdItemRequiresInventoryRepair(
    traumaWithChanges([{ key: "system.limbs.all.maxBonus" }]),
    traumaCreateOptions
  ), true);
  assert.equal(createdItemRequiresInventoryRepair(
    traumaWithChanges([{ key: "system.inventory.columns" }], { disabled: true }),
    traumaCreateOptions
  ), false);
  assert.equal(createdItemRequiresInventoryRepair(
    traumaWithChanges([{ key: "system.inventory.columns" }], { transfer: false }),
    traumaCreateOptions
  ), false);
});
