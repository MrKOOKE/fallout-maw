import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = { applications: { api: { ApplicationV2: class {}, DialogV2: class {} },
  ux: { FormDataExtended: class {} }, handlebars: { HandlebarsApplicationMixin: Base => Base } },
  utils: { deepClone: structuredClone } };
const { getActorInventoryGridDimensions, getActorRootInventoryGridOptions } =
  await import("../src/utils/actor-inventory-size.mjs");
const { createInventoryPlacementPlanner, findFirstAvailableResolvedInventoryPlacement,
  validateInventoryTree, prepareInventoryGridContext } = await import("../src/utils/inventory-containers.mjs");

test("trade inventory accepts stacked loot when a construct starts with no grid", () => {
  const actor = { type: "construct", system: { trade: { infiniteInventory: true } } };
  const dimensions = getActorInventoryGridDimensions(actor);
  const options = getActorRootInventoryGridOptions(actor);
  assert.deepEqual(dimensions, { columns: 10, rows: 1 });
  const item = { _id: "loot", type: "gear", system: { quantity: 1,
    container: { parentId: "" }, placement: { mode: "inventory", x: 1, y: 1, width: 2, height: 3 } } };
  const placement = findFirstAvailableResolvedInventoryPlacement([], dimensions.columns, dimensions.rows,
    item, [], [], [], options);
  assert.ok(placement);
  item.system.placement = placement;
  assert.equal(validateInventoryTree([item], dimensions, { rootOptions: options }).valid, true);
  const planner = createInventoryPlacementPlanner([item], dimensions.columns, dimensions.rows, [item], [], options);
  const second = planner.findAndReserve(item);
  assert.ok(second);
  assert.notDeepEqual(second, placement);
  const grid = prepareInventoryGridContext([item], dimensions.columns, dimensions.rows, [item], entry => entry, options);
  assert.equal(grid.columns, 10);
  assert.equal(grid.hasPhantomItems, false);
});

test("trade width respects the lower limit and preserves larger actor and race grids", () => {
  for (const type of ["construct", "character"]) {
    for (const columns of [0, 5, 10, 16]) {
      const actor = { type, system: { inventory: { columns, rows: 0 }, trade: { infiniteInventory: true } } };
      assert.deepEqual(getActorInventoryGridDimensions(actor), { columns: Math.max(10, columns), rows: 1 });
    }
  }
  const actor = { type: "character", system: { trade: { infiniteInventory: true } } };
  assert.deepEqual(getActorInventoryGridDimensions(actor, { inventorySize: { columns: 15, rows: 8 } }), { columns: 15, rows: 8 });
  assert.deepEqual(getActorRootInventoryGridOptions(actor, "backpack"), { allowOverflowRows: false, extraRows: 0 });
});

test("finite inventories retain zero dimensions and race defaults", () => {
  assert.deepEqual(getActorInventoryGridDimensions({ type: "construct", system: {} }), { columns: 0, rows: 0 });
  assert.deepEqual(getActorInventoryGridDimensions({ type: "construct", system: { inventory: { columns: 0, rows: 0 } } }), { columns: 0, rows: 0 });
  assert.deepEqual(getActorInventoryGridDimensions({ type: "character", system: {} }, { inventorySize: { columns: 6, rows: 3 } }), { columns: 6, rows: 3 });
});
