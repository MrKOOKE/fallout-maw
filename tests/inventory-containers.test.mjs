import assert from "node:assert/strict";
import test from "node:test";

import {
  createItemStackPartAdditionUpdate,
  getContextInventoryItems,
  getItemDeletionClosureIds,
  getItemLockedStateForPlacementTransition,
  getItemStackParts,
  isContainerItem
} from "../src/utils/inventory-containers.mjs";

test("locked-storage transitions lock on entry and unlock on exit without erasing manual locks", () => {
  const lockedStorageItem = {
    system: {
      locked: true,
      placement: { mode: "lockedStorage" }
    }
  };
  const manuallyLockedInventoryItem = {
    system: {
      locked: true,
      placement: { mode: "inventory" }
    }
  };

  assert.equal(getItemLockedStateForPlacementTransition(lockedStorageItem, "inventory"), false);
  assert.equal(getItemLockedStateForPlacementTransition(lockedStorageItem, "equipment"), false);
  assert.equal(getItemLockedStateForPlacementTransition(manuallyLockedInventoryItem, "lockedStorage"), true);
  assert.equal(getItemLockedStateForPlacementTransition(manuallyLockedInventoryItem, "inventory"), undefined);
});

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

test("a broken container remains a structural container", () => {
  const container = {
    _id: "broken-container",
    type: "gear",
    system: {
      functions: {
        container: {
          enabled: true
        },
        condition: {
          enabled: true,
          max: 10,
          value: 0
        }
      }
    }
  };

  assert.equal(isContainerItem(container), true);
});

test("root inventory fails open for orphan and non-container parent references", () => {
  const inventoryItem = (id, parentId = "", itemFunction = "") => ({
    _id: id,
    type: "gear",
    system: {
      itemFunction,
      container: { parentId },
      placement: { mode: "inventory" }
    }
  });
  const items = [
    inventoryItem("container", "", "container"),
    inventoryItem("valid-child", "container"),
    inventoryItem("orphan", "missing-container"),
    inventoryItem("ordinary-parent"),
    inventoryItem("invalid-child", "ordinary-parent"),
    inventoryItem("root")
  ];

  assert.deepEqual(
    getContextInventoryItems("", items).map(item => item._id),
    ["container", "orphan", "ordinary-parent", "invalid-child", "root"]
  );
});

test("deletion closure follows corrupt descendants and terminates on cycles", () => {
  const item = (id, parentId) => ({
    _id: id,
    type: "gear",
    system: {
      container: { parentId }
    }
  });
  const items = [
    item("container", "grandchild"),
    item("corrupt-intermediary", "container"),
    item("grandchild", "corrupt-intermediary"),
    item("unrelated", "")
  ];

  assert.deepEqual(
    getItemDeletionClosureIds(["container"], items),
    ["container", "corrupt-intermediary", "grandchild"]
  );
});
