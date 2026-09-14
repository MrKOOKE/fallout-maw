import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: { api: { DialogV2: class {} }, ux: { FormDataExtended: class {} }, handlebars: { renderTemplate: async () => "" } },
  utils: { deepClone: structuredClone, mergeObject: (a, b) => Object.assign(a, b),
    hasProperty: (object, path) => path.split(".").reduce((v, key) => v?.[key], object) !== undefined,
    setProperty(object, path, value) {
      const keys = path.split(".");
      const last = keys.pop();
      for (const key of keys) object = object[key] ??= {};
      object[last] = value;
    }
  }
};
globalThis.game = { settings: { get: () => { throw new Error("defaults"); } } };
const { getContentsTransferEntries, transferInventoryContents, canTransferOwnedContents } = await import("../src/inventory/contents-transfer.mjs");
const { planContentsPlacements } = await import("../src/inventory/contents-packing.mjs");
const { getItemFootprint, createStoredPlacement, normalizeInventoryPlacement, getContainerInventoryGridOptions, getContextInventoryItems, isInventoryPlacementAvailable } = await import("../src/utils/inventory-containers.mjs");

function item(id, parentId = "", extra = {}) {
  return { id, name: id, type: "gear", img: "item.webp", system: {
    quantity: 1, maxStack: 1, container: { parentId }, placement: { mode: "inventory" }, ...extra
  } };
}
function actor(id, items) {
  const map = new Map(items.map(i => [i.id, i]));
  Object.defineProperty(map, "contents", { get: () => [...map.values()] });
  return { uuid: id, isOwner: true, items: map };
}
const zone = (actor, parentId = "") => ({ actor, parentId, kind: "inventory" });
const bag = id => item(id, "", { functions: { container: { enabled: true } } });

test("direct contents exclude equipped items and descendants and snapshot virtual parts in safe removal order", () => {
  const source = actor("a", [bag("bag"), item("child", "bag"), item("helmet", "", { placement: { mode: "equipment" } }),
    item("ammo", "", { quantity: 25, maxStack: 10, stackParts: [{ quantity: 10 }, { quantity: 10 }, { quantity: 5 }] })]);
  const entries = getContentsTransferEntries(source);
  assert.equal(entries.some(e => e.itemId === "child" || e.itemId === "helmet"), false);
  assert.equal(entries.filter(e => e.itemId === "bag").length, 1);
  assert.deepEqual(entries.filter(e => e.itemId === "ammo").map(e => e.sourceStackIndex), [2, 1, 0]);
});

test("a rejected item stays at source while later items still move, without retrying new destination items", async () => {
  const source = zone(actor("a", [item("large"), item("small")]));
  const target = zone(actor("b", []));
  const calls = [];
  const result = await transferInventoryContents({ source, target, canTransfer: canTransferOwnedContents,
    move: async payload => {
      calls.push(payload.itemId);
      if (payload.itemId === "large") throw new Error("No space");
      target.actor.items.set(payload.itemId, source.actor.items.get(payload.itemId));
      source.actor.items.delete(payload.itemId);
    }
  });
  assert.deepEqual(calls, ["large", "small"]);
  assert.deepEqual([result.moved, result.failed], [1, 1]);
  assert.deepEqual([...source.actor.items.keys()], ["large"]);
});

test("root to its own bag skips the bag and still packs other contents", async () => {
  const owner = actor("a", [bag("bag"), item("small")]);
  const calls = [];
  const result = await transferInventoryContents({ source: zone(owner), target: zone(owner, "bag"),
    canTransfer: canTransferOwnedContents, move: async p => { calls.push(p.itemId); } });
  assert.deepEqual(calls, ["small"]);
  assert.deepEqual([result.moved, result.failed], [1, 1]);
});

test("a bag cannot be moved into its descendant, even through a different zone", async () => {
  const outer = bag("outer"), inner = bag("inner");
  inner.system.container.parentId = "outer";
  const owner = actor("a", [outer, inner]);
  let writes = 0;
  const result = await transferInventoryContents({ source: zone(owner), target: zone(owner, "inner"),
    canTransfer: canTransferOwnedContents, move: async () => { writes++; } });
  assert.equal(writes, 0);
  assert.equal(result.failed, 1);
});

test("virtual parts are removed from the end and preserve failed parts at source", async () => {
  const ammo = item("ammo", "", { quantity: 25, maxStack: 10, stackParts: [{ quantity: 10 }, { quantity: 10 }, { quantity: 5 }] });
  const source = zone(actor("a", [ammo])), target = zone(actor("b", []));
  const calls = [];
  const result = await transferInventoryContents({ source, target, canTransfer: canTransferOwnedContents,
    move: async p => {
      calls.push([p.sourceStackIndex, p.quantity]);
      if (p.sourceStackIndex === 1) return false;
      ammo.system.stackParts.splice(p.sourceStackIndex, 1);
      ammo.system.quantity -= p.quantity;
      return true;
    }
  });
  assert.deepEqual(calls, [[2, 5], [1, 10], [0, 10]]);
  assert.equal(ammo.system.quantity, 10);
  assert.deepEqual([result.moved, result.failed], [2, 1]);
});

test("same zone and missing permission never write, and permission is rechecked between items", async () => {
  const source = zone(actor("a", [item("one"), item("two")])), target = zone(actor("b", []));
  let writes = 0;
  const move = async () => { writes++; target.actor.isOwner = false; };
  await transferInventoryContents({ source, target: source, canTransfer: canTransferOwnedContents, move });
  const result = await transferInventoryContents({ source, target, canTransfer: canTransferOwnedContents, move });
  assert.equal(writes, 1);
  assert.deepEqual([result.moved, result.failed], [1, 1]);
});

function shapedItem(id, width, height, extra = {}) {
  return item(id, "", { placement: { mode: "inventory", x: 1, y: 1, width, height, rotated: false }, ...extra });
}
function applyMove(source, target, payload) {
  const moved = source.items.get(payload.itemId);
  const placement = normalizeInventoryPlacement({ ...moved.system.placement, x: payload.targetX, y: payload.targetY, rotated: payload.targetRotated }, moved, source.items);
  const dimensions = payload.targetParentId ? getContainerInventoryGridOptions(target.items.get(payload.targetParentId)) : target.system.inventory;
  assert.ok(isInventoryPlacementAvailable(placement, getContextInventoryItems(payload.targetParentId, target.items), dimensions.columns, dimensions.rows, target.items, [], [], dimensions));
  moved.system.placement = createStoredPlacement(placement, moved);
  moved.system.container.parentId = payload.targetParentId;
  target.items.set(moved.id, moved);
  source.items.delete(moved.id);
  return true;
}

test("bulk transfer applies a complete group layout even when a greedy order would reject a rectangle", async () => {
  const shapes = [[2, 3], [3, 2], [1, 3], [4, 1], [3, 1], [1, 1]];
  const source = actor("a", shapes.map(([w, h], i) => shapedItem(String(i), w, h)));
  const target = actor("b", []);
  target.system = { inventory: { columns: 6, rows: 4 } };
  const result = await transferInventoryContents({ source: zone(source), target: zone(target),
    canTransfer: canTransferOwnedContents, move: p => applyMove(source, target, p) });
  assert.equal(result.moved, 6);
  assert.equal(result.failed, 0);
  assert.equal(source.items.size, 0);
  assert.equal(target.items.size, 6);
});

test("a rejected large item releases its planned space for the remaining group", async () => {
  const source = actor("a", [shapedItem("rejected", 3, 3), shapedItem("helmet", 2, 2), shapedItem("rifle", 2, 1)]);
  const target = actor("b", []);
  target.system = { inventory: { columns: 10, rows: 3 } };
  const result = await transferInventoryContents({ source: zone(source), target: zone(target),
    canTransfer: canTransferOwnedContents,
    move: p => p.itemId === "rejected" ? false : applyMove(source, target, p)
  });
  assert.deepEqual([result.moved, result.failed], [2, 1]);
  const placements = [...target.items.values()].map(i => normalizeInventoryPlacement(i.system.placement, i));
  assert.equal(Math.max(...placements.map(p => p.x + p.width - 1)) * Math.max(...placements.map(p => p.y + p.height - 1)), 6);
  assert.ok(source.items.has("rejected"));
});

test("merging into an existing stack reserves no extra cell for that incoming quantity", () => {
  const ammo = shapedItem("ammo", 1, 1, { quantity: 3, maxStack: 10, weight: 0, price: 0 });
  const destinationAmmo = structuredClone(ammo);
  destinationAmmo.id = "existing";
  destinationAmmo.system.quantity = 5;
  const source = actor("a", [ammo, shapedItem("other", 1, 1)]);
  const target = actor("b", [destinationAmmo]);
  target.system = { inventory: { columns: 2, rows: 1 } };
  const entries = getContentsTransferEntries(source);
  const placements = planContentsPlacements(zone(source), zone(target), entries);
  assert.equal(placements[entries.findIndex(e => e.itemId === "ammo")], undefined);
  assert.equal(placements[entries.findIndex(e => e.itemId === "other")].x, 2);
});

test("virtual parts carry their chosen rotations and a nested container reserves its full contents footprint", () => {
  const stack = shapedItem("stack", 1, 2, { quantity: 2, maxStack: 2,
    stackParts: [{ quantity: 1, x: 1, y: 1, rotated: false }, { quantity: 1, x: 2, y: 1, rotated: true }] });
  const source = actor("a", [stack]);
  const target = actor("b", []);
  target.system = { inventory: { columns: 3, rows: 2 } };
  const entries = getContentsTransferEntries(source);
  const placements = planContentsPlacements(zone(source), zone(target), entries);
  assert.deepEqual(entries.map(e => e.rotated), [true, false]);
  assert.deepEqual(placements.map(p => [p.width, p.height, p.rotated]), [[2, 1, true], [2, 1, true]]);
  const container = bag("outer");
  const child = shapedItem("child", 3, 2);
  child.system.container.parentId = container.id;
  const nestedSource = actor("c", [container, child]);
  const nested = planContentsPlacements(zone(nestedSource), zone(target), getContentsTransferEntries(nestedSource));
  assert.deepEqual([nested[0].width, nested[0].height], [3, 2]);
});

test("screenshot rifle goes first on the left, preserving connected free space, and rotates back on return", async () => {
  const shapes = [["armor", 3, 3], ["rifle", 4, 2], ["helmet", 2, 2], ["smg", 2, 1],
    ...Array.from({ length: 7 }, (_, i) => [`small-${i}`, 1, 1])];
  const source = actor("a", shapes.map(([id, w, h]) => shapedItem(id, w, h)));
  source.system = { inventory: { columns: 10, rows: 3 } };
  const backpack = bag("tactical");
  backpack.system.placement.mode = "equipment";
  backpack.system.container = { parentId: "", columns: 6, rows: 4, maxLoad: 75 };
  backpack.system.functions.container.specialGrids = {
    baseAnchor: { left: 0, top: 0 },
    blocks: [
      ...[1, 3, 5].map(x => ({ id: `top-${x}`, x, y: -1, width: 2, height: 2 })),
      ...[1.5, 4.5].map(x => ({ id: `bottom-${x}`, x, y: 4.5, width: 3, height: 1 }))
    ]
  };
  const target = actor("b", [backpack]);
  const result = await transferInventoryContents({ source: zone(source), target: zone(target, backpack.id),
    canTransfer: canTransferOwnedContents, move: p => applyMove(source, target, p) });
  assert.deepEqual([result.moved, result.failed, result.errors], [11, 0, []]);
  assert.equal(source.items.size, 0);
  const rifle = target.items.get("rifle");
  const stored = rifle.system.placement;
  assert.deepEqual([stored.width, stored.height, stored.rotated], [4, 2, true]);
  const displayed = normalizeInventoryPlacement(stored, rifle, target.items);
  assert.deepEqual([displayed.width, displayed.height, displayed.x, displayed.y], [2, 4, 1, 3]);
  const armor = target.items.get("armor").system.placement;
  assert.deepEqual([armor.x, armor.y], [3, 3]);
  const returned = await transferInventoryContents({ source: zone(target, backpack.id), target: zone(source),
    canTransfer: canTransferOwnedContents, move: p => applyMove(target, source, p) });
  assert.deepEqual([returned.moved, returned.failed, returned.errors], [11, 0, []]);
  assert.deepEqual([rifle.system.placement.width, rifle.system.placement.height, rifle.system.placement.rotated], [4, 2, false]);
});
