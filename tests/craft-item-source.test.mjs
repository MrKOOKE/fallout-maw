import assert from "node:assert/strict";
import test from "node:test";
import {
  getCraftItemSourceUuid, getCraftItemSourceKeys, createSourcedInventoryItemData
} from "../src/utils/craft-item-source.mjs";
import { actorKnowsCraftItem, grantCraftItemKnowledge } from "../src/items/recipe-knowledge.mjs";
import { createCraftMenuRuntime } from "./helpers/craft-menu-runtime.mjs";

function worldItem(id, name, duplicateSource = "Item.template") {
  const layout = { nodes: [{ root: true, itemUuid: `Item.${id}` }, { itemUuid: "Item.material" }], links: [{}] };
  const data = { _id: id, name, type: "gear", img: "bag.webp", _stats: { duplicateSource },
    system: { craft: { recipes: [{ id: "recipe1", name: "Рецепт 1", ...layout, disassembly: layout }] } } };
  return { ...data, documentName: "Item", uuid: `Item.${id}`, toObject: () => structuredClone(data) };
}

function setWorldItems(items) {
  const map = new Map(items.map(item => [item._id, item]));
  globalThis.game = { items: { contents: items, get: id => map.get(id) }, i18n: { lang: "ru" } };
}

function actor(known = []) {
  return { documentName: "Actor", uuid: "Actor.diego", known,
    getFlag() { return this.known; }, async setFlag(_scope, _key, value) { this.known = value; } };
}

test("world copies have separate identities despite shared or cyclic duplication history", () => {
  const first = worldItem("first", "Военный рюкзак", "Item.second");
  const second = worldItem("second", "Разгрузка", "Item.first");
  setWorldItems([first, second]);
  assert.deepEqual([...getCraftItemSourceKeys(first)], [first.uuid]);
  assert.deepEqual([...getCraftItemSourceKeys(second)], [second.uuid]);
  assert.deepEqual([...getCraftItemSourceKeys(null, first.uuid)], [first.uuid]);
});

test("new inventory copies record their immediate catalog source and retain it across actors", () => {
  const source = worldItem("raid", "Военный рейдовый рюкзак");
  const before = source.toObject();
  const copy = createSourcedInventoryItemData(source);
  const owner = actor();
  assert.equal(copy.flags["fallout-maw"].sourceId, source.uuid);
  assert.deepEqual(source.toObject(), before);
  const embedded = { ...copy, uuid: "Actor.diego.Item.bag", parent: owner,
    toObject: () => structuredClone(copy) };
  assert.equal(getCraftItemSourceUuid(embedded), source.uuid);
  const transferred = createSourcedInventoryItemData(embedded);
  assert.equal(getCraftItemSourceUuid({ ...transferred, uuid: "Actor.other.Item.bag" }), source.uuid);
});

test("legacy source flags and immediate duplicate references work without widening to ancestors", () => {
  for (const item of [
    { flags: { core: { sourceId: "Item.raid" } } },
    { _stats: { duplicateSource: "Item.raid" } },
    { _source: { _stats: { duplicateSource: "Item.raid" } } }
  ]) assert.deepEqual([...getCraftItemSourceKeys(item)], ["Item.raid"]);
  assert.deepEqual([...getCraftItemSourceKeys({ _stats: { duplicateSource: "Compendium.pack.Item.raid" } })], []);
  assert.deepEqual([...getCraftItemSourceKeys({ name: "Военный рюкзак", img: "bag.webp" })], []);
});

test("knowing one backpack never grants knowledge of a sibling copy", async () => {
  const bag = worldItem("bag", "Рюкзак"), rig = worldItem("rig", "Разгрузка");
  setWorldItems([bag, rig]);
  const owner = actor();
  const embedded = { documentName: "Item", parent: owner, _stats: { duplicateSource: bag.uuid } };
  assert.deepEqual(await grantCraftItemKnowledge(owner, [embedded]), [bag.uuid]);
  assert.equal(actorKnowsCraftItem(owner, embedded), true);
  assert.equal(actorKnowsCraftItem(owner, rig), false);
});

test("existing saved copies recover the exact recipe source instead of the inherited template", async () => {
  const template = worldItem("template", "Кожаный дорожный рюкзак");
  const raid = worldItem("raid", "Военный рейдовый рюкзак");
  setWorldItems([template, raid]);
  const owner = actor([template.uuid, raid.uuid]);
  const saved = raid.toObject();
  const before = structuredClone(saved);
  const embedded = { ...saved, documentName: "Item", uuid: "Actor.diego.Item.bag", parent: owner };
  assert.equal(getCraftItemSourceUuid(embedded), raid.uuid);
  assert.equal(actorKnowsCraftItem(owner, embedded), true);
  const options = await createCraftMenuRuntime().getCraftWindowOpenOptionsForItem(embedded);
  assert.equal(options.length, 2);
  assert.ok(options.every(option => option.recipeSelectionUuid.startsWith(`${raid.uuid}::`)));
  assert.deepEqual(saved, before);
  const copied = createSourcedInventoryItemData({ ...embedded, toObject: () => structuredClone(saved) });
  assert.equal(copied.flags["fallout-maw"].sourceId, raid.uuid);
});

test("legacy recovery needs one consistent recipe reference and matching catalog details", () => {
  const source = worldItem("raid", "Военный рейдовый рюкзак");
  setWorldItems([source]);
  const ambiguous = source.toObject();
  ambiguous.system.craft.nodes = [{ root: true, itemUuid: "Item.other" }];
  assert.equal(getCraftItemSourceUuid(ambiguous), "Item.template");
  for (const field of ["name", "img", "type"]) {
    const changed = source.toObject();
    changed[field] = "Other";
    assert.equal(getCraftItemSourceUuid(changed), "Item.template");
  }
  const explicit = source.toObject();
  explicit.flags = { "fallout-maw": { sourceId: "Item.explicit" } };
  assert.equal(getCraftItemSourceUuid(explicit), "Item.explicit");
  setWorldItems([]);
  assert.equal(getCraftItemSourceUuid(source.toObject()), "Item.template");
});

test("actual context menu shows only this item's craft and disassembly among sixty template copies", async () => {
  const items = Array.from({ length: 60 }, (_, n) => worldItem(`bag${n}`, `Рюкзак ${n}`));
  setWorldItems(items);
  const owner = actor(items.map(item => item.uuid));
  const copy = { ...createSourcedInventoryItemData(items[26]), uuid: "Actor.diego.Item.bag", parent: owner };
  const runtime = createCraftMenuRuntime();
  const options = await runtime.getCraftWindowOpenOptionsForItem(copy);
  assert.deepEqual(options.map(option => [option.mode, option.recipeSelectionUuid]), [
    ["craft", "Item.bag26::recipe:recipe1"], ["disassembly", "Item.bag26::recipe:recipe1"]
  ]);
  assert.deepEqual(options.map(option => option.label), ["Открыть крафт", "Открыть разбор"]);
  const otherActor = actor([items[0].uuid]);
  assert.deepEqual(await runtime.getCraftWindowOpenOptionsForItem(copy, otherActor), []);
});

test("material and disassembly matching reject sibling items with the same ancestor", () => {
  const bag = worldItem("bag", "Рюкзак"), rig = worldItem("rig", "Разгрузка");
  setWorldItems([bag, rig]);
  const runtime = createCraftMenuRuntime();
  const requirement = { sourceKeys: getCraftItemSourceKeys(bag), sourceUuid: bag.uuid };
  const bagCopy = createSourcedInventoryItemData(bag), rigCopy = createSourcedInventoryItemData(rig);
  assert.equal(runtime.craftRequirementMatchesItem(bagCopy, requirement), true);
  assert.equal(runtime.craftRequirementMatchesItem(rigCopy, requirement), false);
  assert.equal(runtime.craftItemMatchesRequirement(bagCopy, requirement), true);
  assert.equal(runtime.craftItemMatchesRequirement(rigCopy, requirement), false);
  assert.equal(runtime.craftIndexedItemMatchesRequirement({ sourceKeys: getCraftItemSourceKeys(bagCopy) }, requirement), true);
  assert.equal(runtime.craftIndexedItemMatchesRequirement({ sourceKeys: getCraftItemSourceKeys(rigCopy) }, requirement), false);
});
