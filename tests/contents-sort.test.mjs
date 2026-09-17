import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = { applications: { api: { DialogV2: class {} }, ux: { FormDataExtended: class {} },
  handlebars: { renderTemplate: async () => "" } }, utils: { deepClone: structuredClone,
    setProperty(object, path, value) {
      const keys = path.split("."); const last = keys.pop();
      for (const key of keys) object = object[key] ??= {};
      object[last] = value;
    } } };
globalThis.game = { settings: { get: () => { throw new Error("defaults"); } } };
const { getSortedContentsEntries, planInventoryContentsSort, sortInventoryContents } = await import("../src/inventory/contents-sort.mjs");
const { getItemStackParts } = await import("../src/utils/inventory-containers.mjs");

function item(id, name, width = 1, height = 1, category = "", extra = {}) {
  return { id, _id: id, name, type: "gear", system: {
    quantity: 1, maxStack: 1, itemCategory: category, container: { parentId: "" },
    placement: { mode: "inventory", x: 1, y: 1, width, height, rotated: false }, ...extra
  } };
}
function actor(items) {
  const collection = new Map(items.map(i => [i.id, i]));
  Object.defineProperty(collection, "contents", { get: () => [...collection.values()] });
  return { isOwner: true, items: collection };
}

test("Russian alphabet, categories and both size orders are deterministic", () => {
  const owner = actor([item("b", "Яблоко", 1, 1, "Пища"), item("a", "Аптечка", 2, 2, "Медицина"),
    item("d", "Дробовик", 4, 2, "Оружие"), item("c", "Бинт", 1, 1, "Медицина")]);
  const names = mode => getSortedContentsEntries(owner, "", mode).map(e => e.item.name);
  assert.deepEqual(names("nameAsc"), ["Аптечка", "Бинт", "Дробовик", "Яблоко"]);
  assert.deepEqual(names("nameDesc"), ["Яблоко", "Дробовик", "Бинт", "Аптечка"]);
  assert.deepEqual(names("category"), ["Аптечка", "Бинт", "Дробовик", "Яблоко"]);
  assert.deepEqual(names("sizeAsc"), ["Бинт", "Яблоко", "Аптечка", "Дробовик"]);
  assert.deepEqual(names("sizeDesc"), ["Дробовик", "Аптечка", "Бинт", "Яблоко"]);
  assert.throws(() => names("unknown"), /Неизвестный/);
});

test("sorting walks rows horizontally, excludes equipped items and other containers, and does not mutate inputs", () => {
  const items = [item("c", "Винтовка", 2, 1), item("b", "Бинт"), item("a", "Аптечка", 2, 2),
    item("worn", "Броня", 3, 3, "", { placement: { mode: "equipment" } }),
    item("child", "Деталь", 1, 1, "", { container: { parentId: "bag" } }),
    item("bag", "Рюкзак", 2, 2, "", { functions: { container: { enabled: true } } })];
  const owner = actor(items);
  const before = structuredClone(items);
  const updates = planInventoryContentsSort(owner, "", "nameAsc", { columns: 5, rows: 5 });
  assert.deepEqual(updates.map(u => u._id), ["a", "b", "c", "bag"]);
  assert.deepEqual(updates.slice(0, 3).map(u => [u["system.placement.x"], u["system.placement.y"]]), [[1, 1], [3, 1], [4, 1]]);
  assert.deepEqual(items, before);
  const nested = planInventoryContentsSort(owner, "bag", "nameAsc", { columns: 2, rows: 2 });
  assert.deepEqual(nested.map(u => u._id), ["child"]);
});

test("virtual stack quantities and rotations are preserved while all visible parts are sorted", () => {
  const ammo = item("ammo", "Боеприпасы", 2, 1, "", { quantity: 25, maxStack: 10,
    stackParts: [{ quantity: 10, x: 5, y: 3, rotated: false }, { quantity: 10, x: 4, y: 2, rotated: true },
      { quantity: 5, x: 2, y: 3, rotated: false }] });
  const owner = actor([ammo, item("a", "Аптечка")]);
  const before = getItemStackParts(ammo);
  const update = planInventoryContentsSort(owner, "", "sizeAsc", { columns: 5, rows: 4 }).find(u => u._id === "ammo");
  const parts = update["system.stackParts"];
  assert.deepEqual(parts.map(p => [p.quantity, p.rotated]), before.map(p => [p.quantity, p.rotated]));
  assert.equal(parts.reduce((sum, p) => sum + p.quantity, 0), 25);
  assert.equal(update["system.placement.x"], parts[0].x);
  assert.equal(update["system.placement.y"], parts[0].y);
});

test("finite layouts reject an impossible order without updates, infinite grids grow downwards", () => {
  const items = [item("a", "А", 2, 2), item("b", "Б", 2, 2)];
  const owner = actor(items); const before = structuredClone(items);
  assert.throws(() => planInventoryContentsSort(owner, "", "nameAsc", { columns: 2, rows: 2 }), /Недостаточно/);
  assert.deepEqual(items, before);
  const updates = planInventoryContentsSort(owner, "", "nameAsc", { columns: 2, rows: 2, allowOverflowRows: true });
  assert.deepEqual(updates.map(u => [u["system.placement.x"], u["system.placement.y"]]), [[1, 1], [1, 3]]);
});

test("items cannot bridge separate container pockets, and filled containers keep their complete footprint", () => {
  const bag = item("bag", "А", 1, 1, "", { functions: { container: { enabled: true } } });
  const child = item("child", "Б", 2, 2, "", { container: { parentId: "bag" },
    placement: { mode: "inventory", x: 2, y: 2, width: 2, height: 2 } });
  assert.equal(getSortedContentsEntries(actor([bag, child]), "", "sizeAsc")[0].width, 3);
  const owner = actor([item("large", "А", 2, 2)]);
  assert.throws(() => planInventoryContentsSort(owner, "", "nameAsc", { columns: 2, rows: 2,
    zones: [{ x: 1, y: 1, width: 1, height: 2 }, { x: 2, y: 1, width: 1, height: 2 }] }), /Недостаточно/);
});

test("sorting rejects actors without ownership before any mutation", async () => {
  const owner = actor([item("a", "Аптечка")]); owner.isOwner = false;
  await assert.rejects(sortInventoryContents({ actor: owner, mode: "nameAsc" }), /Нет прав/);
});
