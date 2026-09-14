import assert from "node:assert/strict";
import test from "node:test";
import { planEquippedItemSwap } from "../src/inventory/equipment-swap.mjs";

function item(id, slot = "bag") {
  const data = { _id: id, type: "gear", system: { quantity: 1, equipped: true, placement: { mode: "equipment", equipmentSlot: slot }, container: { parentId: "" } } };
  return { id, ...structuredClone(data), toObject: () => structuredClone(data) };
}
function fixtures() {
  const sourceItem = item("first"), targetItem = item("second");
  return { sourceItem, targetItem, sourceActor: { uuid: "a", items: { contents: [sourceItem] } },
    targetActor: { uuid: "b", items: { contents: [targetItem] } }, targetPlacement: { mode: "equipment", equipmentSlot: "bag" } };
}

test("equipment swap produces one pair of final-state plans without temporary unequipping", () => {
  const context = fixtures();
  const snapshot = context.sourceItem.toObject();
  const resolveCalls = [];
  const swap = planEquippedItemSwap({ ...context,
    resolvePlacement: (actor, data, placement, excludes) => {
      resolveCalls.push([actor.uuid, data._id, excludes]);
      return placement;
    },
    createTransferTree: (from, to, root, placement) => ({ rootId: root.id + "-new", creates: [
      { ...root.toObject(), _id: root.id + "-new", system: { ...root.system, placement } },
      { _id: root.id + "-child", system: { container: { parentId: root.id + "-new" } } }
    ] })
  });
  assert.deepEqual(resolveCalls, [["a", "second", ["first"]], ["b", "first", ["second"]]]);
  assert.equal(swap.plans.length, 2);
  for (const plan of swap.plans) {
    assert.equal(plan.updates, undefined);
    assert.equal(plan.deletes.length, 1);
    assert.equal(plan.creates[0].system.placement.mode, "equipment");
    assert.equal(plan.creates[1].system.container.parentId, plan.creates[0]._id);
    assert.equal(plan.expectedItems.length, 1);
  }
  assert.deepEqual(context.sourceItem.toObject(), snapshot);
});

for (const rejectedActor of ["a", "b"]) {
  test(`incompatibility or another occupied slot on ${rejectedActor} rejects the whole swap before cloning`, () => {
    let cloned = false;
    assert.throws(() => planEquippedItemSwap({ ...fixtures(),
      resolvePlacement: (actor, _data, placement) => actor.uuid === rejectedActor ? null : placement,
      createTransferTree: () => { cloned = true; }
    }), /Обмен невозможен/);
    assert.equal(cloned, false);
  });
}
