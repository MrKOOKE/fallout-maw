import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRectanglePacker, packInventoryRectangles } from "../src/inventory/packing.mjs";
import {
  createInventoryPlacementPlanner, createInventoryPackingCandidate, createStoredPlacement, normalizeInventoryPlacement, findFirstAvailableResolvedInventoryPlacement,
  prepareInventoryGridContext, isInventoryPlacementWithinBounds, inventoryPlacementsOverlap,
  createAnchoredItemStackPartsForQuantity
} from "../src/utils/inventory-containers.mjs";

globalThis.foundry = { utils: {
  deepClone: structuredClone,
  setProperty(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    for (const key of keys) object = object[key] ??= {};
    object[last] = value;
  }
} };

const screenshot = [[2, 2], [2, 1], [3, 3], [1, 1], [1, 1], [1, 1]]
  .map(([width, height]) => ({ width, height }));
const item = (id, width, height, x = 1, y = 1) => ({
  id, _id: id, type: "gear", system: { quantity: 1, maxStack: 1,
    container: { parentId: "" }, placement: { mode: "inventory", x, y, width, height, rotated: false }
  }
});
const extent = placements => ({
  width: Math.max(...placements.map(p => p.x + p.width - 1)),
  height: Math.max(...placements.map(p => p.y + p.height - 1))
});
function check(placements, columns, rows, options = {}) {
  placements.forEach((p, i) => {
    assert.ok(isInventoryPlacementWithinBounds(p, columns, rows, options));
    assert.ok(placements.slice(0, i).every(other => !inventoryPlacementsOverlap(p, other)));
  });
}

test("screenshot items fill a solid 6 by 3 block, preserving every footprint", () => {
  const result = packInventoryRectangles(screenshot, { columns: 10, rows: 3 });
  assert.equal(result.filter(Boolean).length, 6);
  assert.deepEqual(extent(result), { width: 6, height: 3 });
  assert.deepEqual(result.map(({ width, height }) => ({ width, height })), screenshot);
  check(result, 10, 3);
});

test("ordinary individual additions use compact placement, without a contents-transfer operation", () => {
  const existing = [];
  for (const [index, shape] of screenshot.entries()) {
    const candidate = item(String(index), shape.width, shape.height);
    const placement = findFirstAvailableResolvedInventoryPlacement(existing, 10, 3, candidate, existing);
    assert.ok(placement);
    candidate.system.placement = createStoredPlacement(placement, candidate);
    existing.push(candidate);
  }
  const placements = existing.map(i => normalizeInventoryPlacement(i.system.placement, i));
  assert.deepEqual(extent(placements), { width: 6, height: 3 });
  check(placements, 10, 3);
});

test("mixed heights fit completely with deterministic whole-group packing", () => {
  const shapes = [[2, 3], [3, 2], [1, 3], [4, 1], [3, 1], [1, 1]]
    .map(([width, height]) => ({ width, height }));
  const result = packInventoryRectangles(shapes, { columns: 6, rows: 4 });
  assert.ok(result.every(Boolean));
  check(result, 6, 4);
  assert.deepEqual(packInventoryRectangles(shapes, { columns: 6, rows: 4 }), result);
});

test("small pockets are used first, and items cannot bridge adjacent sections", () => {
  const zones = [
    { x: 1, y: 1, width: 4, height: 3, base: true },
    { x: 5, y: 1, width: 2, height: 1 },
    { x: 5, y: 2, width: 2, height: 2 }
  ];
  const packer = createRectanglePacker({ columns: 6, rows: 3, zones });
  assert.deepEqual(packer.findAndReserve({ width: 2, height: 1 }), { x: 5, y: 1, width: 2, height: 1 });
  assert.equal(packer.find({ width: 5, height: 1 }), null);
  const large = packer.findAndReserve({ width: 4, height: 3 });
  assert.deepEqual(large, { x: 1, y: 1, width: 4, height: 3 });
  assert.ok(packer.findAndReserve({ width: 2, height: 2 }));
  assert.equal(packer.find({ width: 1, height: 1 }), null);
});

test("a batch keeps existing manual placements fixed and honors their rotated footprints", () => {
  const rotated = item("fixed", 1, 3, 2, 2);
  rotated.system.placement.rotated = true;
  const before = structuredClone(rotated);
  const planner = createInventoryPlacementPlanner([rotated], 6, 4, [rotated]);
  const result = planner.packAndReserve([item("a", 2, 2), item("b", 1, 3)]);
  assert.ok(result.every(Boolean));
  check([{ x: 2, y: 2, width: 3, height: 1 }, ...result], 6, 4);
  assert.deepEqual(rotated, before);
});

test("long items go before shorter bulky items so free space is not cut into separate scraps", () => {
  const result = createInventoryPlacementPlanner([], 6, 4).packAndReserve([
    item("armor", 3, 3), item("rifle", 4, 2)
  ]);
  assert.deepEqual(result.map(p => [p.x, p.y, p.width, p.height, p.rotated]),
    [[3, 1, 3, 3, false], [1, 1, 2, 4, true]]);
  assert.deepEqual(createRectanglePacker({ columns: 6, rows: 4, occupied: result }).freeSpaceScore(), [0, 0]);
  const bad = [{ x: 1, y: 1, width: 3, height: 3 }, { x: 4, y: 1, width: 2, height: 4 }];
  assert.deepEqual(createRectanglePacker({ columns: 6, rows: 4, occupied: bad }).freeSpaceScore(), [1, 3]);
});

test("free-space scoring respects separate pockets and does not connect diagonal gaps", () => {
  const zones = [{ x: 1, y: 1, width: 2, height: 2 }, { x: 3, y: 1, width: 2, height: 2 }];
  assert.deepEqual(createRectanglePacker({ columns: 4, rows: 2, zones }).freeSpaceScore(), [0, 0]);
  const diagonal = createRectanglePacker({ columns: 2, rows: 2, occupied: [
    { x: 1, y: 1, width: 1, height: 1 }, { x: 2, y: 2, width: 1, height: 1 }
  ] });
  assert.deepEqual(diagonal.freeSpaceScore(), [1, 1]);
});

test("ordinary placement avoids splitting the remaining free space without moving existing items", () => {
  const existing = [item("anchor", 1, 1, 3, 1)];
  const before = structuredClone(existing);
  const placement = findFirstAvailableResolvedInventoryPlacement(existing, 6, 4, item("rifle", 2, 4));
  assert.ok(placement);
  assert.deepEqual(createRectanglePacker({ columns: 6, rows: 4,
    occupied: [...existing.map(i => i.system.placement), placement] }).freeSpaceScore(), [0, 0]);
  assert.deepEqual(existing, before);
});

test("automatic single-item placement rotates a wide item into a narrow inventory and persists base dimensions", () => {
  const rifle = item("rifle", 4, 2);
  const before = structuredClone(rifle);
  const placement = findFirstAvailableResolvedInventoryPlacement([], 2, 4, rifle);
  assert.deepEqual([placement.width, placement.height, placement.rotated], [2, 4, true]);
  assert.equal("orientations" in placement, false);
  const stored = createStoredPlacement(placement, rifle);
  assert.deepEqual([stored.width, stored.height, stored.rotated], [4, 2, true]);
  const displayed = normalizeInventoryPlacement(stored, rifle);
  assert.deepEqual([displayed.width, displayed.height, displayed.rotated], [2, 4, true]);
  assert.deepEqual(rifle, before);
});

test("a long item rotates into a small pocket, leaving the main compartment free", () => {
  const zones = [{ x: 1, y: 1, width: 3, height: 4, base: true }, { x: 4, y: 1, width: 1, height: 3 }];
  const placement = findFirstAvailableResolvedInventoryPlacement([], 4, 4, item("long", 3, 1), [], [], [], { zones });
  assert.deepEqual([placement.x, placement.y, placement.width, placement.height, placement.rotated], [4, 1, 1, 3, true]);
});

test("filled-container rotation recomputes its footprint without rotating or moving its contents", () => {
  const bag = item("bag", 4, 1);
  bag.system.functions = { container: { enabled: true } };
  const child = item("child", 3, 2);
  child.system.container.parentId = "bag";
  const all = [bag, child];
  const before = structuredClone(all);
  const candidate = createInventoryPackingCandidate(bag, all);
  assert.deepEqual(candidate.orientations.map(p => [p.width, p.height]), [[4, 2], [3, 4]]);
  assert.equal(findFirstAvailableResolvedInventoryPlacement([], 2, 4, bag, all), null);
  const placement = findFirstAvailableResolvedInventoryPlacement([], 3, 4, bag, all);
  assert.deepEqual([placement.width, placement.height, placement.rotated], [3, 4, true]);
  assert.deepEqual(all, before);
});

test("each newly created virtual part records the orientation chosen for its own cell", () => {
  const stack = item("stack", 2, 1);
  stack.system.maxStack = 10;
  const parts = createAnchoredItemStackPartsForQuantity({ itemData: stack, quantity: 20, columns: 1, rows: 4 });
  assert.deepEqual(parts.map(p => [p.x, p.y, p.rotated, p.quantity]), [[1, 1, true, 10], [1, 3, true, 10]]);
  const stored = createStoredPlacement(parts[0], stack);
  stack.system.stackParts = parts;
  stack.system.quantity = 20;
  stack.system.placement = stored;
  const context = prepareInventoryGridContext([stack], 1, 4, [stack], (_item, placement) => ({ placement }));
  assert.ok(context.items.every(entry => !entry.phantom));
  check(context.items.map(entry => entry.placement), 1, 4);
});

test("new virtual stack parts fill gaps and retain their first explicitly selected cell", () => {
  const stack = item("stack", 1, 1);
  stack.system.maxStack = 10;
  stack.system.quantity = 30;
  const occupied = [item("armor", 3, 3), item("helmet", 2, 2, 4, 1), item("rifle", 2, 1, 4, 3)];
  const parts = createAnchoredItemStackPartsForQuantity({
    itemData: stack, quantity: 30,
    contextItems: occupied, columns: 10, rows: 3, allItems: occupied,
    preferredPlacement: { x: 6, y: 2, width: 1, height: 1, rotated: false }
  });
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map(p => [p.x, p.y]), [[6, 2], [6, 1], [6, 3]]);
  assert.equal(parts.reduce((sum, p) => sum + p.quantity, 0), 30);
});

test("display repair packs unresolved items as a group while leaving valid stored coordinates alone", () => {
  const fixed = item("fixed", 1, 1, 10, 3);
  const pending = screenshot.map((r, i) => item(String(i), r.width, r.height));
  for (const entry of pending) entry.system.placement.mode = "unplaced";
  const all = [fixed, ...pending];
  const before = structuredClone(all);
  const context = prepareInventoryGridContext(all, 10, 3, all, (i, placement) => ({ id: i.id, placement }));
  const found = context.items.find(i => i.id === "fixed");
  assert.deepEqual([found.placement.x, found.placement.y], [10, 3]);
  assert.deepEqual(all, before);
  check(context.items.map(i => i.placement), 10, 3);
});

test("failed atomic reservations release every provisional rectangle", () => {
  const planner = createInventoryPlacementPlanner([], 2, 2);
  assert.equal(planner.reserveAll([{ x: 1, y: 1, width: 1, height: 1 }, { x: 1, y: 1, width: 2, height: 2 }]), false);
  assert.ok(planner.findAndReserve(item("whole", 2, 2)));
});

test("free rectangles never lose a legal fit or overlap during varied sequential additions", () => {
  let seed = 777;
  const random = n => (((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 12) % n);
  for (let run = 0; run < 80; run++) {
    const occupied = [];
    const packer = createRectanglePacker({ columns: 8, rows: 6 });
    for (let i = 0; i < 15; i++) {
      const shape = { width: 1 + random(5), height: 1 + random(4) };
      let fits = false;
      for (let y = 1; y <= 7 - shape.height; y++) for (let x = 1; x <= 9 - shape.width; x++) {
        if (occupied.every(r => !inventoryPlacementsOverlap({ x, y, ...shape }, r))) fits = true;
      }
      const result = packer.findAndReserve(shape);
      assert.equal(Boolean(result), fits);
      if (result) occupied.push(result);
    }
    check(occupied, 8, 6);
  }
});

const searchSource = readFileSync(new URL("../src/apps/search-inventory.mjs", import.meta.url), "utf8");
function searchFunction(name, end, bindings) {
  const source = searchSource.slice(searchSource.indexOf(`function ${name}(`), searchSource.indexOf(end, searchSource.indexOf(`function ${name}(`)));
  return Function(...Object.keys(bindings), `${source}\nreturn ${name};`)(...Object.values(bindings));
}

test("automatic search transfers do not bypass packing by treating null coordinates as cell 1,1", () => {
  let automatic = 0;
  let explicit = 0;
  const getPlacement = searchFunction("getRequestedTargetPlacement", "export function getSearchDropPlacementForPointer", {
    ITEM_FUNCTIONS: { constructPart: "constructPart" },
    getFirstAvailableActorInventoryPlacement: () => { automatic++; return { x: 4, y: 2 }; },
    createContextInventoryPlacement: p => p,
    createInventoryPlacement: (x, y) => { explicit++; return { x, y }; },
    isContainerItem: () => false, isActorInventoryPlacementAvailable: () => true,
    toInteger: Math.trunc
  });
  assert.deepEqual(getPlacement({ targetActor: { items: [] }, targetX: null, targetY: null }), { x: 4, y: 2 });
  assert.deepEqual([automatic, explicit], [1, 0]);
  assert.deepEqual(getPlacement({ targetActor: { items: [] }, targetX: 7, targetY: 3 }), { x: 7, y: 3 });
  assert.deepEqual([automatic, explicit], [1, 1]);
});

test("trade catalog sections use group packing and keep their section offset", () => {
  const place = searchFunction("placeTradeCatalogItems", "function getTradeCatalogCategoryLabels", {
    TRADE_OFFER_DEFAULT_COLUMNS: 10, packInventoryRectangles, getTradeCatalogItemFootprint: i => i
  });
  const result = place(screenshot, { columns: 10, startY: 7 });
  const placements = result.items.map(i => ({ ...i.placement, y: i.placement.y - 6 }));
  assert.deepEqual(extent(placements), { width: 6, height: 3 });
  assert.equal(result.nextY, 10);
  check(placements, 10, 3);
});

test("trade offers fill the gap below an item instead of extending the first row", () => {
  const find = searchFunction("findFirstAvailableTradeOfferPlacement", "function findNearestAvailableTradeOfferPlacement", {
    TRADE_OFFER_DEFAULT_COLUMNS: 10, TRADE_OFFER_MAX_ROWS: 100, createRectanglePacker,
    normalizeTradeOfferPlacement: p => p, toInteger: Math.trunc
  });
  assert.deepEqual(find([{ x: 1, y: 1, width: 2, height: 2 }], 10, 3, { width: 2, height: 1 }),
    { x: 1, y: 3, width: 2, height: 1 });
});
