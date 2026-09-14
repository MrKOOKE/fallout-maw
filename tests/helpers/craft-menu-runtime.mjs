import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getCraftItemSourceKeys } from "../../src/utils/craft-item-source.mjs";
import { resolveWorldItemSync } from "../../src/utils/world-items.mjs";
import { getKnownCraftItemUuids, hasCraftKnowledgeLayoutData } from "../../src/items/recipe-knowledge.mjs";

const source = readFileSync(new URL("../../src/apps/craft-window.mjs", import.meta.url), "utf8");

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
    "normalizeCraftSearchText", "normalizeCraftMode", "setsIntersect"
  ];
  const implementations = names.map(name => {
    const match = source.match(new RegExp(`(?:export )?((?:async )?function ${name}\\([^]*?\\n\\})`));
    assert.ok(match, `Missing production function ${name}`);
    return match[1];
  }).join("\n");
  return new Function("getCraftItemSourceKeys", "resolveWorldItemSync", "getKnownCraftItemUuids", "hasCraftKnowledgeLayoutData", `
    const CRAFT_MODE_CREATE = "craft", CRAFT_MODE_DISASSEMBLY = "disassembly";
    const DEFAULT_CRAFT_RECIPE_ID = "recipe1", DEFAULT_CRAFT_RECIPE_NAME = "Рецепт_1";
    const CRAFT_RECIPE_SELECTION_SEPARATOR = "::recipe:", FALLBACK_ICON = "bag.svg";
    const toInteger = value => Math.trunc(Number(value) || 0);
    const getItemQuantity = item => Number(item.system?.quantity ?? 1);
    const normalizeImagePath = (value, fallback) => value || fallback;
    let craftRecipeCatalog = null;
    const craftSourceProfileCache = new Map();
    ${implementations}
    return { getCraftWindowOpenOptionsForItem, craftRequirementMatchesItem,
      craftItemMatchesRequirement, craftIndexedItemMatchesRequirement };
  `)(getCraftItemSourceKeys, resolveWorldItemSync, getKnownCraftItemUuids, hasCraftKnowledgeLayoutData);
}
