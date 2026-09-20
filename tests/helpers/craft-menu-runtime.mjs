import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getCraftItemSourceKeys } from "../../src/utils/craft-item-source.mjs";
import { resolveWorldItemSync } from "../../src/utils/world-items.mjs";
import { getKnownCraftItemUuids, hasCraftKnowledgeLayoutData } from "../../src/items/recipe-knowledge.mjs";
// The tree builder is a pure function, so it is imported directly instead of
// being text-extracted (its destructured parameters would defeat the scanner).
import { createCraftRecipeGrouping } from "../../src/utils/craft-recipe-groups.mjs";

const source = readFileSync(new URL("../../src/apps/craft-window.mjs", import.meta.url), "utf8");

// Module-level matcher: a function body ends at the first closing brace that
// starts its own line, which also covers destructured parameters that spread
// across lines (`function name({\n ... \n}) {`).
const functionPattern = name => new RegExp(`(?:export )?((?:async )?function ${name}\\([^]*?\\r?\\n\\})`);

// Helpers the sandboxed craft-window functions rely on. They are pulled from
// the shared grouping module so this sandbox exercises the real production
// rules (subcategory + condition-derived class folders) instead of stubs.
const groupingSource = readFileSync(new URL("../../src/utils/craft-recipe-groups.mjs", import.meta.url), "utf8");
const groupingNames = [
  "getCraftClassLabel", "normalizeCraftItemClass", "getCraftItemClassFromCondition",
  "getCraftItemClass", "getCraftRecipeGrouping", "craftGroupKey",
  "craftCategoryExpansionKey", "craftSubcategoryExpansionKey", "craftClassFolderExpansionKey",
  "craftRecipeExpansionKeys"
];
const groupingImplementations = groupingNames.map(name => {
  const match = groupingSource.match(functionPattern(name));
  assert.ok(match, `Missing grouping function ${name}`);
  return match[1];
}).join("\n");

export function createCraftMenuRuntime() {
  const names = [
    "getCraftWindowOpenOptionsForItem", "getCraftRecipeSummaries", "findCraftRecipesForItem",
    "getCraftItemSourceProfile", "getCraftItemMatchProfile", "collectCraftCatalogCandidates",
    "buildCraftOpenOptionsForMode", "craftItemMatchesRecipeSource", "craftRequirementMatchesItem",
    "craftItemMatchesRequirement", "craftIndexedItemMatchesRequirement",
    "getCraftRecipeCatalogEntries", "isCraftRecipeItem", "hasCraftRecipeData",
    "hasCraftRecipeDataForMode", "hasCraftRecipeEntryData", "prepareRecipeSummary",
    "getCraftRecipeSelectionUuid", "indexCraftRecipeReferences", "getCraftNodeSourceUuid",
    "addRecipeToCraftSourceIndexBucket", "getCraftRecipeCategory", "getCraftRecipeDisplayName",
    "normalizeCraftSearchText", "normalizeCraftMode", "setsIntersect",
    "prepareCraftRecipeCategories"
  ];
  const implementations = names.map(name => {
    const match = source.match(functionPattern(name));
    assert.ok(match, `Missing production function ${name}`);
    return match[1];
  }).join("\n");
  return new Function(
    "getCraftItemSourceKeys",
    "resolveWorldItemSync",
    "getKnownCraftItemUuids",
    "hasCraftKnowledgeLayoutData",
    "getCraftRecipeMissingCacheKey",
    "createCraftRecipeGrouping",
    `
    const CRAFT_MODE_CREATE = "craft", CRAFT_MODE_DISASSEMBLY = "disassembly";
    const DEFAULT_CRAFT_RECIPE_ID = "recipe1", DEFAULT_CRAFT_RECIPE_NAME = "Рецепт_1";
    const CRAFT_RECIPE_SELECTION_SEPARATOR = "::recipe:", FALLBACK_ICON = "bag.svg";
    const CRAFT_RECIPE_DOM_LIMIT = 120;
    const CRAFT_ITEM_CLASS_ORDER = Object.freeze(["S", "A", "B", "C", "D"]);
    const ITEM_CLASS_RANK = new Map(CRAFT_ITEM_CLASS_ORDER.map((itemClass, index) => [itemClass, index]));
    const CRAFT_GROUP_KEY_PREFIX = Object.freeze({ category: "c", subcategory: "s", classFolder: "f" });
    const CRAFT_NO_CATEGORY_TOKEN = "__no_category__";
    const CRAFT_NO_SUBCATEGORY_TOKEN = "__no_subcategory__";
    const toInteger = value => Math.trunc(Number(value) || 0);
    const getItemQuantity = item => Number(item.system?.quantity ?? 1);
    const normalizeImagePath = (value, fallback) => value || fallback;
    const itemCategorySettings = { categories: [] };
    const getItemCategorySettings = () => itemCategorySettings.categories;
    const game = {
      i18n: {
        lang: "ru",
        localize: key => key,
        format: (key, data) => key + JSON.stringify(data ?? {})
      }
    };
    let craftRecipeCatalog = null;
    let craftRecipeMissingCache = new Map();
    let craftRecipeMissingCacheKey = "";
    const craftSourceProfileCache = new Map();
    ${groupingImplementations}
    ${implementations}
    return { getCraftWindowOpenOptionsForItem, craftRequirementMatchesItem,
      craftItemMatchesRequirement, craftIndexedItemMatchesRequirement, getCraftRecipeCategory,
      prepareCraftRecipeCategories, prepareRecipeSummary, getCraftRecipeSummaries, getCraftItemClass,
      craftRecipeExpansionKeys, setItemCategories: categories => { itemCategorySettings.categories = categories ?? []; } };
  `
  )(
    getCraftItemSourceKeys,
    resolveWorldItemSync,
    getKnownCraftItemUuids,
    hasCraftKnowledgeLayoutData,
    (mode, uuid) => `${mode}:${uuid}`,
    createCraftRecipeGrouping
  );
}
