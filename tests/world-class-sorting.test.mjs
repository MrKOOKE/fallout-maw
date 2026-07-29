import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASS_FOLDER_ORDER,
  applyDescendingPriceSort,
  classFolderSort,
  compareItemsByDescendingPrice,
  isClassFolder
} from "../scripts/rebalance/class-folder-sorting.mjs";

test("class folders use manual S-A-B-C-D order", () => {
  assert.deepEqual(CLASS_FOLDER_ORDER, ["S", "A", "B", "C", "D"]);
  assert.deepEqual(
    CLASS_FOLDER_ORDER.map(itemClass => classFolderSort(itemClass)),
    [100000, 200000, 300000, 400000, 500000]
  );
  assert.equal(isClassFolder({ type: "Item", name: "S" }), true);
  assert.equal(isClassFolder({ type: "Item", name: "S класс" }), false);
  assert.equal(isClassFolder({ type: "Actor", name: "S" }), false);
});

test("items are manually ordered by descending price and then name", () => {
  const items = [
    { _id: "3", name: "Бета", system: { price: 100 }, sort: 0 },
    { _id: "2", name: "Альфа", system: { price: 100 }, sort: 0 },
    { _id: "1", name: "Дорого", system: { price: 500 }, sort: 0 },
    { _id: "4", name: "Дёшево", system: { price: 10 }, sort: 0 }
  ];
  const ordered = applyDescendingPriceSort(items);
  assert.deepEqual(ordered.map(item => item.name), ["Дорого", "Альфа", "Бета", "Дёшево"]);
  assert.deepEqual(ordered.map(item => item.sort), [100000, 200000, 300000, 400000]);
  assert.ok(compareItemsByDescendingPrice(ordered[0], ordered[1]) < 0);
});
