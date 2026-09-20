import assert from "node:assert/strict";
import test from "node:test";

import {
  CRAFT_ITEM_CLASS_ORDER,
  CRAFT_NO_CATEGORY_TOKEN,
  CRAFT_NO_SUBCATEGORY_TOKEN,
  craftCategoryExpansionKey,
  craftClassFolderExpansionKey,
  craftRecipeExpansionKeys,
  craftSubcategoryExpansionKey,
  createCraftRecipeGrouping,
  getCraftItemClass,
  getCraftItemClassFromCondition,
  getCraftRecipeGrouping,
  normalizeCraftItemClass
} from "../src/utils/craft-recipe-groups.mjs";

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

function condition(enabled, toolClasses = []) {
  return {
    enabled,
    recoveryMethods: toolClasses.map(toolClass => ({ type: "tools", toolKey: "repair", toolClass, difficulty: 10 }))
  };
}

function item({ name, category = "", subcategory = "", condition: conditionData = null }) {
  return {
    name,
    displayName: name,
    system: {
      itemClass: getCraftItemClassFromCondition(conditionData) || "D",
      itemCategory: category,
      itemSubcategory: subcategory,
      functions: conditionData ? { condition: conditionData } : {}
    }
  };
}

const ITEM_CATEGORIES = [
  { label: "Оружие", subcategories: [{ label: "Пистолет" }, { label: "Винтовка" }, { label: "Гранаты" }] },
  { label: "Снаряжение", subcategories: [{ label: "Лёгкая броня" }] }
];

test("class comes from enabled condition tool recovery methods only", () => {
  assert.equal(getCraftItemClassFromCondition(condition(true, ["D"])), "D");
  assert.equal(getCraftItemClassFromCondition(condition(true, ["D", "B", "C"])), "B");
  assert.equal(getCraftItemClassFromCondition(condition(true, ["C", "B", "A"])), "A");
  assert.equal(getCraftItemClassFromCondition(condition(true, ["c", "s"])), "S");
  // Disabled condition, missing condition and non-tool methods yield no class.
  assert.equal(getCraftItemClassFromCondition(condition(false, ["S"])), "");
  assert.equal(getCraftItemClassFromCondition(null), "");
  assert.equal(getCraftItemClassFromCondition({ enabled: true, recoveryMethods: [] }), "");
  assert.equal(
    getCraftItemClassFromCondition({ enabled: true, recoveryMethods: [{ type: "manual", toolClass: "S" }] }),
    ""
  );
  // Unknown class tokens are ignored instead of inventing a folder.
  assert.equal(getCraftItemClassFromCondition(condition(true, ["X", "D"])), "D");
});

test("class resolution is read from the item schema path", () => {
  assert.equal(getCraftItemClass(item({ name: "A", condition: condition(true, ["A"]) })), "A");
  assert.equal(getCraftItemClass(item({ name: "B" })), "D");
  assert.deepEqual(getCraftRecipeGrouping(item({
    name: "C",
    category: " Оружие ",
    subcategory: " Пистолет ",
    condition: condition(true, ["C"])
  })), { category: "Оружие", subcategory: "Пистолет", itemClass: "C" });
  assert.equal(normalizeCraftItemClass("s"), "S");
  assert.equal(normalizeCraftItemClass("Z"), "");
});

test("a prepared recipe summary declares its class on the summary itself", () => {
  // prepareRecipeSummary resolves the class once and stores it on the summary,
  // which has no `functions` payload to re-read later.
  const summary = {
    name: "Пистолет",
    itemClass: "S",
    system: { itemCategory: "Оружие", itemSubcategory: "Пистолет" }
  };
  assert.equal(getCraftItemClass(summary), "S");
  assert.deepEqual(getCraftRecipeGrouping(summary), {
    category: "Оружие",
    subcategory: "Пистолет",
    itemClass: "S"
  });
  // Re-reading a raw item still wins over any stale summary-shaped field.
  assert.equal(getCraftItemClass({
    itemClass: "S",
    system: { functions: { condition: condition(true, ["D"]) } }
  }), "S");
  assert.equal(getCraftItemClass({ itemClass: "", system: { functions: { condition: condition(true, ["D"]) } } }), "D");
});

test("expansion keys namespace every folder level", () => {
  assert.equal(craftCategoryExpansionKey("Оружие"), "c:Оружие");
  assert.equal(craftSubcategoryExpansionKey("Оружие", "Пистолет"), "s:Оружие:Пистолет");
  assert.equal(craftClassFolderExpansionKey("Оружие", "Пистолет", "S"), "f:Оружие:Пистолет:S");
  assert.deepEqual(
    craftRecipeExpansionKeys(item({ name: "A", category: "Оружие", subcategory: "Пистолет", condition: condition(true, ["S"]) })),
    ["c:Оружие", "s:Оружие:Пистолет", "f:Оружие:Пистолет:S"]
  );
  // Items without an explicit class use the baseline D folder.
  assert.deepEqual(
    craftRecipeExpansionKeys(item({ name: "B", category: "Оружие", subcategory: "Гранаты" })),
    ["c:Оружие", "s:Оружие:Гранаты", "f:Оружие:Гранаты:D"]
  );
  // Missing levels have no toggle; their class folder still has a stable token.
  assert.deepEqual(
    craftRecipeExpansionKeys(item({ name: "C" })),
    [`f:${CRAFT_NO_CATEGORY_TOKEN}:${CRAFT_NO_SUBCATEGORY_TOKEN}:D`]
  );
});

test("recipes are nested under subcategory then class folder", () => {
  const tree = createCraftRecipeGrouping({
    collator,
    itemCategories: ITEM_CATEGORIES,
    recipes: [
      item({ name: "Пистолет S", category: "Оружие", subcategory: "Пистолет", condition: condition(true, ["S"]) }),
      item({ name: "Пистолет D", category: "Оружие", subcategory: "Пистолет", condition: condition(true, ["D"]) }),
      item({ name: "Граната", category: "Оружие", subcategory: "Гранаты" }),
      item({ name: "Броня", category: "Снаряжение", subcategory: "Лёгкая броня", condition: condition(true, ["C"]) })
    ]
  });

  assert.deepEqual(tree.map(category => category.rawCategory), ["Оружие", "Снаряжение"]);
  const weapons = tree[0];
  // Configured subcategories keep their settings order; Пистолет precedes Гранаты.
  assert.deepEqual(
    weapons.subcategories.filter(entry => entry.hasRecipes).map(entry => entry.rawSubcategory),
    ["Пистолет", "Гранаты"]
  );
  const pistol = weapons.subcategories.find(entry => entry.rawSubcategory === "Пистолет");
  assert.deepEqual(pistol.classFolders.map(folder => folder.itemClass), ["S", "D"]);
  assert.deepEqual(pistol.classFolders[0].recipes.map(recipe => recipe.name), ["Пистолет S"]);
  assert.deepEqual(pistol.classlessRecipes, []);
  const grenades = weapons.subcategories.find(entry => entry.rawSubcategory === "Гранаты");
  assert.deepEqual(grenades.classFolders.map(folder => folder.itemClass), ["D"]);
  assert.deepEqual(grenades.classFolders[0].recipes.map(recipe => recipe.name), ["Граната"]);
});

test("class folders follow the manual S-A-B-C-D order", () => {
  assert.deepEqual(CRAFT_ITEM_CLASS_ORDER, ["S", "A", "B", "C", "D"]);
  const tree = createCraftRecipeGrouping({
    collator,
    itemCategories: ITEM_CATEGORIES,
    recipes: ["D", "C", "B", "A", "S"].map(toolClass => item({
      name: `Пистолет ${toolClass}`,
      category: "Оружие",
      subcategory: "Пистолет",
      condition: condition(true, [toolClass])
    }))
  });
  assert.deepEqual(
    tree[0].subcategories.find(entry => entry.rawSubcategory === "Пистолет").classFolders.map(folder => folder.itemClass),
    ["S", "A", "B", "C", "D"]
  );
});

test("configured subcategories without recipes stay visible as empty folders", () => {
  const tree = createCraftRecipeGrouping({
    collator,
    itemCategories: ITEM_CATEGORIES,
    recipes: [item({ name: "Пистолет", category: "Оружие", subcategory: "Пистолет", condition: condition(true, ["D"]) })]
  });
  const weapons = tree[0];
  assert.deepEqual(
    weapons.subcategories.map(entry => entry.rawSubcategory),
    ["Пистолет", "Винтовка", "Гранаты"]
  );
  assert.equal(weapons.subcategories.find(entry => entry.rawSubcategory === "Винтовка").hasRecipes, false);
  assert.deepEqual(weapons.subcategories.find(entry => entry.rawSubcategory === "Винтовка").classFolders, []);
});

test("subcategories outside the settings list are marked and sorted after configured ones", () => {
  const tree = createCraftRecipeGrouping({
    collator,
    itemCategories: ITEM_CATEGORIES,
    recipes: [
      item({ name: "Чужой", category: "Оружие", subcategory: "Экзотика", condition: condition(true, ["A"]) }),
      item({ name: "Свой", category: "Оружие", subcategory: "Пистолет", condition: condition(true, ["A"]) })
    ]
  });
  const subcategories = tree[0].subcategories;
  const exotic = subcategories.find(entry => entry.rawSubcategory === "Экзотика");
  assert.equal(exotic.isUnconfigured, true);
  assert.ok(subcategories.indexOf(exotic) > subcategories.findIndex(entry => entry.rawSubcategory === "Пистолет"));
});

test("uncategorized recipes are collected last and keep a stable token", () => {
  const tree = createCraftRecipeGrouping({
    collator,
    itemCategories: ITEM_CATEGORIES,
    recipes: [
      item({ name: "Ничей" }),
      item({ name: "Пистолет", category: "Оружие", subcategory: "Пистолет", condition: condition(true, ["D"]) })
    ]
  });
  assert.equal(tree.at(-1).key, CRAFT_NO_CATEGORY_TOKEN);
  assert.equal(tree.at(-1).isUncategorized, true);
  assert.equal(tree.at(-1).subcategories[0].key, CRAFT_NO_SUBCATEGORY_TOKEN);
  assert.deepEqual(tree.at(-1).subcategories[0].classFolders[0].recipes.map(recipe => recipe.name), ["Ничей"]);
});

test("categories follow the configured order", () => {
  const tree = createCraftRecipeGrouping({
    collator,
    itemCategories: ITEM_CATEGORIES,
    recipes: [
      item({ name: "Броня", category: "Снаряжение", subcategory: "Лёгкая броня", condition: condition(true, ["C"]) }),
      item({ name: "Пистолет", category: "Оружие", subcategory: "Пистолет", condition: condition(true, ["D"]) })
    ]
  });
  assert.deepEqual(tree.map(category => category.rawCategory), ["Оружие", "Снаряжение"]);
});
