import assert from "node:assert/strict";
import test from "node:test";

import {
  createItemStackPartAdditionUpdate,
  getItemStackParts
} from "../src/utils/inventory-containers.mjs";

function createStackItem({ quantity, maxStack, stackParts }) {
  return {
    _id: "stack-item",
    type: "gear",
    system: {
      quantity,
      maxStack,
      stackParts,
      placement: {
        x: stackParts[0]?.x ?? 1,
        y: stackParts[0]?.y ?? 1,
        rotated: stackParts[0]?.rotated ?? false
      }
    }
  };
}

test("quantity increase within maxStack fills the existing stack part", () => {
  const item = createStackItem({
    quantity: 5,
    maxStack: 10,
    stackParts: [{ quantity: 1, x: 3, y: 4, rotated: true }]
  });

  assert.deepEqual(getItemStackParts(item), [
    { quantity: 5, x: 3, y: 4, rotated: true }
  ]);
});

test("an unpositioned legacy part is folded into a positioned stack when capacity allows", () => {
  const item = createStackItem({
    quantity: 5,
    maxStack: 10,
    stackParts: [
      { quantity: 1, x: 3, y: 4, rotated: false },
      { quantity: 4 }
    ]
  });

  assert.deepEqual(getItemStackParts(item), [
    { quantity: 5, x: 3, y: 4, rotated: false }
  ]);
});

test("addition without a target fills partial parts before creating overflow", () => {
  const item = createStackItem({
    quantity: 14,
    maxStack: 10,
    stackParts: [
      { quantity: 8, x: 1, y: 1, rotated: false },
      { quantity: 6, x: 2, y: 1, rotated: true }
    ]
  });

  const update = createItemStackPartAdditionUpdate(
    item,
    12,
    null,
    [{ x: 3, y: 1, rotated: false }]
  );

  assert.equal(update["system.quantity"], 26);
  assert.deepEqual(update["system.stackParts"], [
    { quantity: 10, x: 1, y: 1, rotated: false },
    { quantity: 10, x: 2, y: 1, rotated: true },
    { quantity: 6, x: 3, y: 1, rotated: false }
  ]);
});
