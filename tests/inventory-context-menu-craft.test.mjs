import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getKnownCraftItemUuids,
  actorKnowsCraftItem,
  grantCraftItemKnowledge
} from "../src/items/recipe-knowledge.mjs";

function createActor(known) {
  return {
    documentName: "Actor", uuid: "Actor.menu-fixture", known,
    getFlag() { return this.known; },
    async setFlag(_scope, _key, value) { this.known = value; }
  };
}

test("first inventory menu lookup accepts an actor without a known-recipe flag", () => {
  const actor = createActor();
  const known = getKnownCraftItemUuids(actor);
  assert.deepEqual([...known], []);
  assert.equal(getKnownCraftItemUuids(actor), known);
  assert.equal(actorKnowsCraftItem(actor, { documentName: "Item", uuid: "Item.recipe" }), false);
});

test("learning the first recipe and clearing the flag invalidate the cached membership", async () => {
  const actor = createActor();
  const empty = getKnownCraftItemUuids(actor);
  const recipe = { documentName: "Item", uuid: "Item.recipe" };
  assert.deepEqual(await grantCraftItemKnowledge(actor, [recipe]), [recipe.uuid]);
  assert.equal(actorKnowsCraftItem(actor, recipe), true);
  assert.notEqual(getKnownCraftItemUuids(actor), empty);
  actor.known = undefined;
  assert.deepEqual([...getKnownCraftItemUuids(actor)], []);
});

test("recipe membership stays isolated between actors", () => {
  const first = createActor(["Item.recipe"]);
  const second = createActor();
  assert.deepEqual([...getKnownCraftItemUuids(first)], ["Item.recipe"]);
  assert.deepEqual([...getKnownCraftItemUuids(second)], []);
});

// Execute the production entry point and catalog lookup without starting
// Foundry or loading its application classes. Empty catalogs do no Item work.
const craftSource = readFileSync(new URL("../src/apps/craft-window.mjs", import.meta.url), "utf8");
function createCraftMenuLookup() {
  const names = ["getCraftWindowOpenOptionsForItem", "getCraftRecipeSummaries",
    "findCraftRecipesForItem", "getCraftItemMatchProfile", "collectCraftCatalogCandidates",
    "buildCraftOpenOptionsForMode"];
  const implementations = names.map(name => {
    const match = craftSource.match(new RegExp(`(?:export )?((?:async )?function ${name}\\([^]*?\\n\\})`));
    assert.ok(match, `Missing production function ${name}`);
    return match[1];
  }).join("\n");
  return new Function("getKnownCraftItemUuids", `
    let craftRecipeCatalog = null;
    const CRAFT_MODE_CREATE = "craft", CRAFT_MODE_DISASSEMBLY = "disassembly";
    const normalizeCraftMode = value => value;
    const getCraftItemSourceKeys = item => new Set([item.uuid]);
    ${implementations}
    return getCraftWindowOpenOptionsForItem;
  `)(getKnownCraftItemUuids);
}

test("the actual craft-menu entry point resolves empty options on the first right click", async () => {
  const lookup = createCraftMenuLookup();
  const item = { type: "gear", uuid: "Actor.menu-fixture.Item.gear", parent: createActor() };
  assert.deepEqual(await lookup(item), []);
  assert.deepEqual(await lookup(item), []);
});

test("the actual craft-menu entry point accepts an item without an Actor parent", async () => {
  const lookup = createCraftMenuLookup();
  assert.deepEqual(await lookup({ type: "gear", uuid: "Item.gear" }), []);
});
