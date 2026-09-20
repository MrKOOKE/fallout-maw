import assert from "node:assert/strict";
import test from "node:test";
import { planItemClasses } from "../scripts/rebalance/item-class-assignment.mjs";
import { getCraftItemClass, craftRecipeExpansionKeys } from "../src/utils/craft-recipe-groups.mjs";

const item = (id, name, refs = [], extra = {}) => ({
  _id: id, name, type: "gear", system: {
    craft: { recipes: [{
      nodes: [{ id: "root", root: true }, ...refs.map((ref, index) => ({ id: `n${index}`, itemUuid: `Item.${ref}`, blockId: "materials" }))],
      links: refs.length ? [{ fromNodeId: "n0", toNodeId: "root" }] : []
    }] }, ...extra
  }
});

test("manual item class is independent of repair tools and recipe contents", () => {
  const document = item("result", "Result", ["expensive"], {
    itemClass: "C", functions: { condition: { enabled: true, recoveryMethods: [{ type: "tools", toolClass: "S" }] } }
  });
  assert.equal(getCraftItemClass(document), "C");
  delete document.system.itemClass;
  assert.equal(getCraftItemClass(document), "D");
  assert.deepEqual(craftRecipeExpansionKeys(document), ["f:__no_category__:__no_subcategory__:D"]);
});

test("one-off assignment follows the best component, including blocks and nested recipes", () => {
  const items = [item("final", "Final", ["mid"]), item("mid", "Mid", ["low", "high"]),
    item("high", "Компонент электроники A класса", ["raw"]), item("low", "Компонент каркаса D класса"), item("raw", "Raw")];
  items[3].system.price = 10000;
  items[2].system.price = 1;
  const plan = planItemClasses(items);
  const classes = Object.fromEntries(plan.records.map(record => [record.id, record.itemClass]));
  assert.deepEqual(classes, { final: "A", mid: "A", high: "A", low: "D", raw: "D" });
  assert.deepEqual(plan.unresolved, []);
  assert.equal(items[0].system.itemClass, undefined, "dry run must not mutate input");
});

test("cycles converge, unused graph nodes and disassembly do not raise classes", () => {
  const a = item("a", "A", ["b"]);
  const b = item("b", "B", ["a", "low"]);
  const high = item("high", "Компонент электроники S класса");
  a.system.craft.recipes[0].nodes.push({ id: "unused", itemUuid: "Item.high" });
  a.system.craft.recipes[0].disassembly = { nodes: [{ itemUuid: "Item.high" }] };
  const plan = planItemClasses([a, b, high, item("low", "Компонент каркаса C класса")]);
  assert.equal(plan.records.find(record => record.id === "a").itemClass, "C");
  assert.equal(plan.records.find(record => record.id === "b").itemClass, "C");
});

test("manual classes are preserved and missing references are reported", () => {
  const plan = planItemClasses([item("a", "A", ["absent"], { itemClass: "B" })]);
  assert.equal(plan.records[0].itemClass, "B");
  assert.equal(plan.unresolved[0].component, "Item.absent");
});
