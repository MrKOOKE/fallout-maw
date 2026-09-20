import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createCraftMenuRuntime } from "./helpers/craft-menu-runtime.mjs";

const ITEM_CATEGORIES = [
  { label: "Оружие", subcategories: [{ label: "Пистолет" }, { label: "Винтовка" }] },
  { label: "Снаряжение", subcategories: [{ label: "Лёгкая броня" }] }
];

function condition(toolClasses = []) {
  return {
    enabled: true,
    recoveryMethods: toolClasses.map(toolClass => ({ type: "tools", toolKey: "repair", toolClass, difficulty: 10 }))
  };
}

/** A recipe summary as produced by prepareRecipeSummary (already categorized). */
function summary({ name, category, subcategory, itemClass = "", quantity = 1 }) {
  const recipe = {
    uuid: `Item.${name}::recipe:recipe1`,
    itemUuid: `Item.${name}`,
    name,
    displayName: quantity > 1 ? `${name} (${quantity}х)` : name,
    img: "icon.png",
    itemClass,
    type: "gear",
    system: {
      quantity,
      itemCategory: category,
      itemSubcategory: subcategory,
      // A craft layout is what makes a summary eligible for the recipe browser:
      // the shared predicate needs at least one link and one non-root node.
      craft: {
        nodes: [
          { id: "root", root: true, x: 0, y: 0, width: 1, height: 1 },
          { id: "material", x: 1, y: 0, width: 1, height: 1 }
        ],
        links: [{ id: "link", from: "material", to: "root" }]
      }
    },
    searchText: `${name} ${category} ${subcategory} ${itemClass}`.toLowerCase()
  };
  return recipe;
}

function createRuntime({ categories = ITEM_CATEGORIES } = {}) {
  const runtime = createCraftMenuRuntime();
  runtime.setItemCategories(categories);
  return runtime;
}

/**
 * Regression guard: the sandbox supplies the module's imports itself, so a
 * production function calling something that was never imported used to run
 * fine here and explode in Foundry. Every free call target used by the
 * extracted functions must exist in the production module.
 */
test("extracted recipe functions only call names the module really has", () => {
  const source = readFileSync(new URL("../src/apps/craft-window.mjs", import.meta.url), "utf8");
  const extracted = ["prepareCraftRecipeCategories", "getCraftHiddenRecipesLabel", "prepareRecipeSummary"];
  const implementation = extracted
    .map(name => source.match(new RegExp(`(?:export )?((?:async )?function ${name}\\([^]*?\\r?\\n\\})`))?.[1] ?? "")
    .join("\n");
  assert.ok(implementation.length > 0, "extracted implementations must be found");

  // Names the production file provides: its own declarations plus its imports.
  const available = new Set();
  for (const match of source.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) available.add(match[1]);
  for (const match of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) available.add(match[1]);
  for (const block of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]+";/g)) {
    for (const name of block[1].split(",")) {
      const bare = name.trim().split(/\s+as\s+/).pop();
      if (bare) available.add(bare);
    }
  }
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) available.add(match[1]);

  const globals = new Set([
    "game", "foundry", "canvas", "CONFIG", "Hooks", "ui", "window", "document", "globalThis",
    "console", "Math", "Number", "String", "Boolean", "Array", "Object", "Map", "Set", "Intl",
    "JSON", "Promise", "Error", "Date", "RegExp", "structuredClone", "require", "isNaN", "parseInt", "parseFloat"
  ]);
  const keywords = new Set([
    "if", "else", "for", "of", "in", "return", "const", "let", "var", "new", "typeof", "await",
    "async", "function", "class", "try", "catch", "finally", "throw", "switch", "case", "break",
    "continue", "default", "while", "do", "delete", "void", "yield", "this", "super", "import", "export"
  ]);
  const declared = new Set();
  for (const match of implementation.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  for (const match of implementation.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);
  for (const match of implementation.matchAll(/(?:function\s*[A-Za-z_$\w]*\s*)?\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const param of match[1].split(",")) {
      const bare = param.trim().replace(/^\.\.\./, "").split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(bare)) declared.add(bare);
    }
  }

  const references = new Set();
  for (const match of implementation.matchAll(/(?<![.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)) references.add(match[1]);

  const missing = [...references].filter(name => (
    !available.has(name) && !globals.has(name) && !keywords.has(name) && !declared.has(name)
  ));
  assert.deepEqual(missing, [], `production names missing from craft-window.mjs: ${missing.join(", ")}`);
});

test("prepareCraftRecipeCategories nests subcategory then class folder", () => {
  const runtime = createRuntime();
  const recipes = [
    summary({ name: "Пистолет S", category: "Оружие", subcategory: "Пистолет", itemClass: "S" }),
    summary({ name: "Пистолет D", category: "Оружие", subcategory: "Пистолет", itemClass: "D" }),
    summary({ name: "Граната", category: "Оружие", subcategory: "Пистолет" }),
    summary({ name: "Броня", category: "Снаряжение", subcategory: "Лёгкая броня", itemClass: "C" })
  ];
  const expanded = new Set([
    "c:Оружие", "s:Оружие:Пистолет", "f:Оружие:Пистолет:S", "f:Оружие:Пистолет:D"
  ]);
  const result = runtime.prepareCraftRecipeCategories(recipes, { expandedKeys: expanded });

  assert.deepEqual(result.categories.map(category => category.label), ["Оружие", "Снаряжение"]);
  const weapons = result.categories[0];
  assert.equal(weapons.collapsed, false);
  const pistol = weapons.subcategories.find(entry => entry.label === "Пистолет");
  assert.equal(pistol.hasClassFolders, true);
  assert.deepEqual(pistol.classFolders.map(folder => folder.itemClass), ["S", "D"]);
  assert.deepEqual(pistol.classFolders[0].recipes.map(recipe => recipe.name), ["Пистолет S"]);
  // Classless recipes live directly under the subcategory, after the folders.
  assert.deepEqual(pistol.recipes, []);
  assert.deepEqual(pistol.classFolders[1].recipes.map(recipe => recipe.name), ["Граната", "Пистолет D"]);
  assert.equal(pistol.count, 3);
  // A collapsed category materializes nothing but still reports the full count.
  assert.equal(result.categories[1].collapsed, true);
  assert.equal(result.categories[1].count, 1);
  assert.equal(result.categories[0].count, 3);
});

test("unexpanded class folders stay collapsed and hide their recipes", () => {
  const runtime = createRuntime();
  const recipes = [
    summary({ name: "Пистолет S", category: "Оружие", subcategory: "Пистолет", itemClass: "S" })
  ];
  const result = runtime.prepareCraftRecipeCategories(recipes, {
    expandedKeys: new Set(["c:Оружие", "s:Оружие:Пистолет"])
  });
  const pistol = result.categories[0].subcategories.find(entry => entry.label === "Пистолет");
  assert.equal(pistol.hasClassFolders, true);
  assert.equal(pistol.collapsed, false);
  assert.equal(pistol.classFolders[0].collapsed, true);
  assert.deepEqual(pistol.classFolders[0].recipes, []);
  assert.equal(result.categories[0].count, 1);
});

test("items without a declared class use a D folder", () => {
  const runtime = createRuntime();
  const recipes = [
    summary({ name: "Граната", category: "Оружие", subcategory: "Пистолет" }),
    summary({ name: "Мина", category: "Оружие", subcategory: "Пистолет" })
  ];
  const collapsed = runtime.prepareCraftRecipeCategories(recipes, { expandedKeys: new Set(["c:Оружие"]) });
  const collapsedPistol = collapsed.categories[0].subcategories.find(entry => entry.label === "Пистолет");
  assert.equal(collapsedPistol.hasClassFolders, true);
  assert.equal(collapsedPistol.collapsed, true);
  assert.deepEqual(collapsedPistol.recipes, []);

  const expanded = runtime.prepareCraftRecipeCategories(recipes, {
    expandedKeys: new Set(["c:Оружие", "s:Оружие:Пистолет"])
  });
  const expandedPistol = expanded.categories[0].subcategories.find(entry => entry.label === "Пистолет");
  assert.deepEqual(expandedPistol.recipes, []);
  assert.equal(expandedPistol.classFolders[0].itemClass, "D");
  assert.equal(expandedPistol.classFolders[0].count, 2);
});

test("every level starts folded and opens only on an explicit click", () => {
  const runtime = createRuntime();
  const recipes = [
    summary({ name: "Пистолет S", category: "Оружие", subcategory: "Пистолет", itemClass: "S" }),
    summary({ name: "Пистолет B", category: "Оружие", subcategory: "Пистолет", itemClass: "B" }),
    summary({ name: "Граната", category: "Оружие", subcategory: "Пистолет" })
  ];

  // Nothing expanded: the whole tree is folded.
  const closed = runtime.prepareCraftRecipeCategories(recipes, { expandedKeys: new Set() });
  assert.equal(closed.categories[0].collapsed, true);
  const closedPistol = closed.categories[0].subcategories.find(entry => entry.label === "Пистолет");
  assert.equal(closedPistol.collapsed, true);
  assert.equal(closedPistol.hasClassFolders, true);

  // Opening the category alone must NOT unfold its subcategories.
  const categoryOnly = runtime.prepareCraftRecipeCategories(recipes, { expandedKeys: new Set(["c:Оружие"]) });
  assert.equal(categoryOnly.categories[0].collapsed, false);
  const stillFolded = categoryOnly.categories[0].subcategories.find(entry => entry.label === "Пистолет");
  assert.equal(stillFolded.collapsed, true, "opening a category must not unfold its subcategories");
  assert.deepEqual(stillFolded.classFolders.map(folder => folder.recipes), [[], [], []]);

  // Opening the subcategory reveals its class folders, still folded, and lists
  // the classless recipe directly under it.
  const subOpen = runtime.prepareCraftRecipeCategories(recipes, {
    expandedKeys: new Set(["c:Оружие", "s:Оружие:Пистолет"])
  });
  const subPistol = subOpen.categories[0].subcategories.find(entry => entry.label === "Пистолет");
  assert.equal(subPistol.collapsed, false);
  assert.deepEqual(subPistol.classFolders.map(folder => folder.itemClass), ["S", "B", "D"]);
  assert.deepEqual(subPistol.classFolders.map(folder => folder.collapsed), [true, true, true]);
  assert.deepEqual(subPistol.recipes, []);
  assert.equal(subPistol.classFolders[2].count, 1);

  // Opening a class folder shows its recipes.
  const classOpen = runtime.prepareCraftRecipeCategories(recipes, {
    expandedKeys: new Set(["c:Оружие", "s:Оружие:Пистолет", "f:Оружие:Пистолет:S"])
  });
  const classPistol = classOpen.categories[0].subcategories.find(entry => entry.label === "Пистолет");
  assert.deepEqual(classPistol.classFolders[0].recipes.map(recipe => recipe.name), ["Пистолет S"]);
  assert.deepEqual(classPistol.classFolders[1].recipes, []);
});

test("D recipes become reachable when their class folder is opened", () => {
  const runtime = createRuntime();
  const recipes = [
    summary({ name: "Граната", category: "Оружие", subcategory: "Пистолет" }),
    summary({ name: "Мина", category: "Оружие", subcategory: "Пистолет" })
  ];
  const result = runtime.prepareCraftRecipeCategories(recipes, {
    expandedKeys: new Set(["c:Оружие", "s:Оружие:Пистолет"])
  });
  const pistol = result.categories[0].subcategories.find(entry => entry.label === "Пистолет");
  assert.equal(pistol.hasClassFolders, true);
  const opened = runtime.prepareCraftRecipeCategories(recipes, { expandedKeys: new Set(["c:Оружие", "s:Оружие:Пистолет", "f:Оружие:Пистолет:D"]) });
  assert.deepEqual(opened.categories[0].subcategories[0].classFolders[0].recipes.map(recipe => recipe.name), ["Граната", "Мина"]);
});

test("search expands only matching branches and ignores expansion state", () => {
  const runtime = createRuntime();
  const recipes = [
    summary({ name: "Пистолет S", category: "Оружие", subcategory: "Пистолет", itemClass: "S" }),
    summary({ name: "Лазерная винтовка", category: "Оружие", subcategory: "Винтовка", itemClass: "A" }),
    summary({ name: "Броня", category: "Снаряжение", subcategory: "Лёгкая броня", itemClass: "C" })
  ];
  const result = runtime.prepareCraftRecipeCategories(recipes, {
    search: "лазер",
    expandedKeys: new Set()
  });
  const weapons = result.categories.find(category => category.label === "Оружие");
  assert.equal(weapons.collapsed, false);
  const rifle = weapons.subcategories.find(entry => entry.label === "Винтовка");
  assert.equal(rifle.collapsed, false);
  assert.deepEqual(rifle.classFolders[0].recipes.map(recipe => recipe.name), ["Лазерная винтовка"]);
  const pistol = weapons.subcategories.find(entry => entry.label === "Пистолет");
  assert.equal(pistol, undefined);
  assert.equal(weapons.subcategories.length, 1);
  assert.equal(result.categories.length, 1);
  assert.deepEqual(runtime.prepareCraftRecipeCategories(recipes, { search: "несуществующее" }).categories, []);
  const cleared = runtime.prepareCraftRecipeCategories(recipes, { search: "" });
  assert.ok(cleared.categories.find(category => category.label === "Оружие").subcategories.some(entry => entry.label === "Пистолет"));
  assert.equal(result.categories[0].count, 1);
});

test("search matches a class label and folder counts stay consistent", () => {
  const runtime = createRuntime();
  const recipes = [
    summary({ name: "Пистолет S", category: "Оружие", subcategory: "Пистолет", itemClass: "S" }),
    summary({ name: "Пистолет D", category: "Оружие", subcategory: "Пистолет", itemClass: "D" })
  ];
  const byClass = runtime.prepareCraftRecipeCategories(recipes, { search: "s", expandedKeys: new Set() });
  assert.equal(byClass.categories[0].count, 1);
  const all = runtime.prepareCraftRecipeCategories(recipes, {
    expandedKeys: new Set(["c:Оружие", "s:Оружие:Пистолет", "f:Оружие:Пистолет:S", "f:Оружие:Пистолет:D"])
  });
  assert.equal(all.categories[0].count, 2);
  assert.equal(
    all.categories[0].subcategories.reduce((sum, entry) => sum + entry.count, 0),
    all.categories[0].count
  );
});

test("no recipe is dropped: every matched recipe stays reachable", () => {
  const runtime = createRuntime();
  const recipes = Array.from({ length: 1500 }, (_, index) => summary({
    name: `Пистолет ${String(index).padStart(4, "0")}`,
    category: "Оружие",
    subcategory: "Пистолет",
    itemClass: "B"
  }));
  const result = runtime.prepareCraftRecipeCategories(recipes, {
    expandedKeys: new Set(["c:Оружие", "s:Оружие:Пистолет", "f:Оружие:Пистолет:B"])
  });
  const folder = result.categories[0].subcategories
    .find(entry => entry.label === "Пистолет").classFolders[0];
  assert.equal(folder.recipes.length, 1500);
  assert.equal(result.categories[0].count, 1500);
  assert.equal(Object.hasOwn(folder, "limitHidden"), false);
  assert.equal(Object.hasOwn(result, "truncated"), false);
});

test("missing category and subcategory show class folders without extra toggles", () => {
  const runtime = createRuntime();
  const recipes = [
    summary({ name: "Loose", itemClass: "A" }),
    summary({ name: "Weapon", category: "Оружие", itemClass: "B" })
  ];
  const result = runtime.prepareCraftRecipeCategories(recipes);
  const loose = result.categories.find(category => category.uncategorized);
  assert.equal(loose.collapsed, false);
  assert.equal(loose.subcategories[0].transparent, true);
  assert.equal(loose.subcategories[0].collapsed, false);
  assert.equal(loose.subcategories[0].classFolders[0].collapsed, true);
  const weapon = result.categories.find(category => !category.uncategorized);
  assert.equal(weapon.collapsed, true);
  const direct = weapon.subcategories.find(subcategory => subcategory.transparent);
  assert.equal(direct.collapsed, false);
  assert.equal(direct.classFolders[0].itemClass, "B");
  const opened = runtime.prepareCraftRecipeCategories(recipes, {
    expandedKeys: new Set([loose.subcategories[0].classFolders[0].key])
  });
  assert.equal(opened.categories.find(category => category.uncategorized).subcategories[0].classFolders[0].recipes[0].name, "Loose");
});
