import assert from "node:assert/strict";
import test from "node:test";

import {
  getSelectedItemTransferQuantity,
  getStackTransferQuantity
} from "../src/inventory/transfer-quantity.mjs";

function stack(id, quantity, parts) {
  return {
    id,
    type: "consumable",
    system: {
      quantity,
      maxStack: 10,
      placement: { mode: "inventory", x: 1, y: 1 },
      stackParts: parts.map((partQuantity, index) => ({ quantity: partQuantity, x: index + 1, y: 1 }))
    }
  };
}

test("negative or nonnumeric quantities cannot transfer a whole stack", () => {
  const source = stack("source", 12, [2, 10]);

  assert.equal(getSelectedItemTransferQuantity(source, -1, 0), 0);
  assert.equal(getSelectedItemTransferQuantity(source, "invalid", 0), 0);
  assert.equal(getStackTransferQuantity(source, stack("target", 1, [1]), -1, 0, 0), 0);
});

test("zero keeps the existing default-to-all behavior while positive amounts stay bounded", () => {
  const source = stack("source", 12, [2, 10]);
  const target = stack("target", 1, [1]);

  assert.equal(getSelectedItemTransferQuantity(source, 0, 0), 2);
  assert.equal(getSelectedItemTransferQuantity(source, 1, 0), 1);
  assert.equal(getStackTransferQuantity(source, target, 0, 0, 0), 1);
});
