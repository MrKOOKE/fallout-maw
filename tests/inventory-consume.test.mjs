import assert from "node:assert/strict";
import test from "node:test";

import { planInventoryItemConsumption } from "../src/inventory/consume.mjs";

function createItem({
  id = "consumable",
  quantity = 1,
  maxStack = 1,
  stackParts = []
} = {}) {
  return {
    _id: id,
    type: "gear",
    system: {
      quantity,
      maxStack,
      stackParts,
      placement: {
        mode: "inventory",
        x: stackParts[0]?.x ?? 1,
        y: stackParts[0]?.y ?? 1,
        width: 1,
        height: 1,
        rotated: Boolean(stackParts[0]?.rotated)
      }
    }
  };
}

test("a single-use item consumes one quantity", () => {
  const plan = planInventoryItemConsumption({
    item: createItem({ quantity: 3 })
  });

  assert.deepEqual(plan.updates, [{
    _id: "consumable",
    "system.quantity": 2
  }]);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.consumedQuantity, 1);
  assert.equal(plan.remainingQuantity, 2);
});

test("ordinary consumption spends the requested quantity", () => {
  const plan = planInventoryItemConsumption({
    item: createItem({ quantity: 5 }),
    amount: 3
  });

  assert.deepEqual(plan.updates, [{
    _id: "consumable",
    "system.quantity": 2
  }]);
  assert.equal(plan.consumedQuantity, 3);
  assert.equal(plan.remainingQuantity, 2);
});

test("consuming the final item deletes its document", () => {
  const plan = planInventoryItemConsumption({
    item: createItem({ quantity: 1 })
  });

  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deletes, ["consumable"]);
  assert.equal(plan.remainingQuantity, 0);
});

test("a multi-charge item spends charges without consuming quantity", () => {
  const plan = planInventoryItemConsumption({
    item: createItem({ quantity: 2 }),
    amount: 2,
    charges: { value: 4, max: 5 },
    chargePath: "system.functions.firstAid.charges.value"
  });

  assert.deepEqual(plan.updates, [{
    _id: "consumable",
    "system.functions.firstAid.charges.value": 2
  }]);
  assert.equal(plan.consumedQuantity, 0);
  assert.equal(plan.remainingQuantity, 2);
  assert.equal(plan.remainingCharges, 2);
});

test("exhausting charges consumes one unit and resets the next unit", () => {
  const plan = planInventoryItemConsumption({
    item: createItem({ quantity: 2 }),
    amount: 2,
    charges: { value: 2, max: 5 },
    chargePath: "system.functions.needChange.charges.value"
  });

  assert.deepEqual(plan.updates, [{
    _id: "consumable",
    "system.quantity": 1,
    "system.functions.needChange.charges.value": 5
  }]);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.consumedQuantity, 1);
  assert.equal(plan.remainingCharges, 5);
});

test("multi-charge consumption crosses several item units", () => {
  const plan = planInventoryItemConsumption({
    item: createItem({ quantity: 3 }),
    amount: 8,
    charges: { value: 2, max: 5 },
    chargePath: "system.functions.firstAid.charges.value"
  });

  assert.deepEqual(plan.updates, [{
    _id: "consumable",
    "system.quantity": 1,
    "system.functions.firstAid.charges.value": 4
  }]);
  assert.equal(plan.consumedQuantity, 2);
  assert.equal(plan.remainingQuantity, 1);
  assert.equal(plan.remainingCharges, 4);
});

test("insufficient total charges consume and delete the entire stack", () => {
  const plan = planInventoryItemConsumption({
    item: createItem({ quantity: 2 }),
    amount: 20,
    charges: { value: 2, max: 5 },
    chargePath: "system.functions.firstAid.charges.value"
  });

  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deletes, ["consumable"]);
  assert.equal(plan.consumedQuantity, 2);
  assert.equal(plan.remainingQuantity, 0);
  assert.equal(plan.remainingCharges, 0);
});

test("virtual-stack consumption preserves each part placement", () => {
  const item = createItem({
    quantity: 12,
    maxStack: 10,
    stackParts: [
      { quantity: 10, x: 2, y: 3, rotated: true },
      { quantity: 2, x: 5, y: 6, rotated: false }
    ]
  });
  const original = structuredClone(item);
  const plan = planInventoryItemConsumption({
    item,
    charges: { value: 1, max: 4 },
    chargePath: "system.functions.firstAid.charges.value",
    stackIndex: 0
  });

  assert.equal(plan.updates[0]["system.quantity"], 11);
  assert.deepEqual(plan.updates[0]["system.stackParts"], [
    { quantity: 9, x: 2, y: 3, rotated: true },
    { quantity: 2, x: 5, y: 6, rotated: false }
  ]);
  assert.equal(plan.updates[0]["system.placement.x"], 2);
  assert.equal(plan.updates[0]["system.placement.y"], 3);
  assert.equal(plan.updates[0]["system.placement.rotated"], true);
  assert.equal(plan.updates[0]["system.functions.firstAid.charges.value"], 4);
  assert.deepEqual(item, original);
});

test("virtual stacks remove the requested quantity across stack parts", () => {
  const item = createItem({
    quantity: 12,
    maxStack: 10,
    stackParts: [
      { quantity: 4, x: 2, y: 3, rotated: true },
      { quantity: 8, x: 5, y: 6, rotated: false }
    ]
  });
  const plan = planInventoryItemConsumption({
    item,
    amount: 7,
    stackIndex: 0
  });

  assert.equal(plan.updates[0]["system.quantity"], 5);
  assert.deepEqual(plan.updates[0]["system.stackParts"], [
    { quantity: 5, x: 5, y: 6, rotated: false }
  ]);
  assert.equal(plan.updates[0]["system.placement.x"], 5);
  assert.equal(plan.updates[0]["system.placement.y"], 6);
  assert.equal(plan.consumedQuantity, 7);
});

test("an empty item produces no mutation", () => {
  const plan = planInventoryItemConsumption({
    item: createItem({ quantity: 0 })
  });

  assert.equal(plan.changed, false);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deletes, []);
});

test("multi-charge consumption requires a persisted charge path", () => {
  assert.throws(
    () => planInventoryItemConsumption({
      item: createItem({ quantity: 2 }),
      charges: { value: 3, max: 3 }
    }),
    /chargePath/
  );
});
