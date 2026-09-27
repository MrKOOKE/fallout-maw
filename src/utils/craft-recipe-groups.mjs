/**
 * Shared grouping rules for the craft-window recipe browser.
 *
 * The browser renders a folder tree:
 *   category -> subcategory -> class folder (S/A/B/C/D) -> recipes
 *
 * Class is an editable item property, independent of recipes and repair tools.
 * Empty category/subcategory levels are transparent in the browser.
 */

export const CRAFT_ITEM_CLASS_ORDER = Object.freeze(["S", "A", "B", "C", "D"]);

const ITEM_CLASS_RANK = new Map(CRAFT_ITEM_CLASS_ORDER.map((itemClass, index) => [itemClass, index]));

export const CRAFT_GROUP_KEY_PREFIX = Object.freeze({
  category: "c",
  subcategory: "s",
  classFolder: "f"
});

export const CRAFT_NO_CATEGORY_TOKEN = "__no_category__";
export const CRAFT_NO_SUBCATEGORY_TOKEN = "__no_subcategory__";

/** A class folder label is language-neutral: "S класс" / "S class". */
export function getCraftClassLabel(itemClass = "") {
  const normalized = normalizeCraftItemClass(itemClass);
  if (!normalized) return "";
  return game.i18n.format("FALLOUTMAW.Craft.ClassFolder", { class: normalized });
}

export function normalizeCraftItemClass(value = "") {
  const normalized = String(value ?? "").trim().toUpperCase();
  return ITEM_CLASS_RANK.has(normalized) ? normalized : "";
}

/**
 * Class = the most demanding tool class among the item's tool recovery
 * methods. Items without an enabled condition function, or without tool
 * methods, are classless.
 */
export function getCraftItemClassFromCondition(condition = null) {
  if (condition?.enabled !== true) return "";
  let best = "";
  let bestRank = Number.POSITIVE_INFINITY;
  for (const method of condition.recoveryMethods ?? []) {
    if (String(method?.type ?? "tools") !== "tools") continue;
    const itemClass = normalizeCraftItemClass(method?.toolClass);
    if (!itemClass) continue;
    const rank = ITEM_CLASS_RANK.get(itemClass);
    if (rank < bestRank) {
      bestRank = rank;
      best = itemClass;
    }
  }
  return best;
}

export function getCraftItemClass(item = null) {
  return normalizeCraftItemClass(item?.system?.itemClass)
    || normalizeCraftItemClass(item?.itemClass)
    || "D";
}

/**
 * Category/subcategory/class values used for grouping.
 *
 * Accepts either a raw item (values live in `system`) or a prepared recipe
 * summary, which keeps the class it was resolved with on the object itself.
 */
export function getCraftRecipeGrouping(recipe = null) {
  return {
    category: String(recipe?.system?.itemCategory ?? "").trim(),
    subcategory: String(recipe?.system?.itemCategory ?? "").trim()
      ? String(recipe?.system?.itemSubcategory ?? "").trim() : "",
    itemClass: getCraftItemClass(recipe)
  };
}

export function craftGroupKey(prefix = "", ...parts) {
  return [prefix, ...parts.map(part => String(part ?? ""))].join(":");
}

export function craftCategoryExpansionKey(category = "") {
  return craftGroupKey(CRAFT_GROUP_KEY_PREFIX.category, String(category ?? "").trim());
}

export function craftSubcategoryExpansionKey(category = "", subcategory = "") {
  return craftGroupKey(CRAFT_GROUP_KEY_PREFIX.subcategory, String(category ?? "").trim(), String(subcategory ?? "").trim());
}

export function craftClassFolderExpansionKey(category = "", subcategory = "", itemClass = "") {
  return craftGroupKey(
    CRAFT_GROUP_KEY_PREFIX.classFolder,
    String(category ?? "").trim(),
    String(subcategory ?? "").trim(),
    String(itemClass ?? "").trim()
  );
}

/**
 * Expansion keys that reveal a recipe: its category, its subcategory and its
 * class folder. A legacy bare entry equal to the raw category is honored too.
 */
export function craftRecipeExpansionKeys(recipe = null) {
  const grouping = getCraftRecipeGrouping(recipe);
  const categoryKey = grouping.category || CRAFT_NO_CATEGORY_TOKEN;
  return [
    grouping.category ? craftCategoryExpansionKey(categoryKey) : "",
    grouping.subcategory ? craftSubcategoryExpansionKey(categoryKey, grouping.subcategory) : "",
    grouping.itemClass
      ? craftClassFolderExpansionKey(categoryKey, grouping.subcategory || CRAFT_NO_SUBCATEGORY_TOKEN, grouping.itemClass)
      : ""
  ].filter(Boolean);
}

function resolveCategoryOrder(categories = []) {
  const order = new Map();
  for (const category of categories ?? []) {
    const label = String(category?.label ?? category ?? "").trim();
    if (label && !order.has(label)) order.set(label, order.size);
  }
  return order;
}

function resolveSubcategoryOrder(categories = []) {
  const order = new Map();
  for (const category of categories ?? []) {
    const label = String(category?.label ?? category ?? "").trim();
    if (!label) continue;
    const entries = new Map();
    for (const subcategory of category?.subcategories ?? []) {
      const subLabel = String(subcategory?.label ?? subcategory ?? "").trim();
      if (subLabel && !entries.has(subLabel)) entries.set(subLabel, entries.size);
    }
    order.set(label, entries);
  }
  return order;
}

/**
 * Build the folder tree.
 *
 * `options.collator` is required; `game.i18n.lang` drives it in the app and
 * tests pass an explicit `Intl.Collator` so the module stays Foundry-free for
 * everything except `getCraftClassLabel`.
 */
export function createCraftRecipeGrouping({
  recipes = [],
  itemCategories = [],
  collator = new Intl.Collator(globalThis.game?.i18n?.lang || "en", { numeric: true, sensitivity: "base" })
} = {}) {
  const categoryOrder = resolveCategoryOrder(itemCategories);
  const subcategoryOrder = resolveSubcategoryOrder(itemCategories);
  const categoryNodes = new Map();

  const ensureCategory = rawCategory => {
    const token = rawCategory || CRAFT_NO_CATEGORY_TOKEN;
    if (categoryNodes.has(token)) return categoryNodes.get(token);
    const node = {
      key: token,
      rawCategory,
      isUncategorized: !rawCategory,
      subcategoryNodes: new Map(),
      recipes: []
    };
    categoryNodes.set(token, node);
    return node;
  };

  for (const recipe of recipes) {
    const grouping = getCraftRecipeGrouping(recipe);
    const category = ensureCategory(grouping.category);
    const subcategoryToken = grouping.subcategory || CRAFT_NO_SUBCATEGORY_TOKEN;
    if (!category.subcategoryNodes.has(subcategoryToken)) {
      category.subcategoryNodes.set(subcategoryToken, {
        key: subcategoryToken,
        rawSubcategory: grouping.subcategory,
        hasRecipes: false,
        classlessRecipes: [],
        classRecipeBuckets: new Map()
      });
    }
    const subcategory = category.subcategoryNodes.get(subcategoryToken);
    subcategory.hasRecipes = true;
    if (!grouping.itemClass) {
      subcategory.classlessRecipes.push(recipe);
      continue;
    }
    if (!subcategory.classRecipeBuckets.has(grouping.itemClass)) {
      subcategory.classRecipeBuckets.set(grouping.itemClass, []);
    }
    subcategory.classRecipeBuckets.get(grouping.itemClass).push(recipe);
  }

  const byName = (left, right) => collator.compare(String(left?.displayName ?? left?.name ?? ""), String(right?.displayName ?? right?.name ?? ""));
  const sortRecipes = list => list.sort(byName);

  const subcategoryNodes = [];
  for (const category of categoryNodes.values()) {
    const configured = subcategoryOrder.get(category.rawCategory) ?? new Map();
    const tokens = new Set([...configured.keys(), ...category.subcategoryNodes.keys()]);
    const subcategories = [];
    for (const token of tokens) {
      const node = category.subcategoryNodes.get(token) ?? {
        key: token,
        rawSubcategory: token === CRAFT_NO_SUBCATEGORY_TOKEN ? "" : token,
        hasRecipes: false,
        classlessRecipes: [],
        classRecipeBuckets: new Map()
      };
      const isUnconfigured = token !== CRAFT_NO_SUBCATEGORY_TOKEN && !configured.has(token);
      subcategories.push({
        key: token,
        rawSubcategory: node.rawSubcategory,
        isUnconfigured,
        hasRecipes: node.hasRecipes,
        classlessRecipes: sortRecipes(node.classlessRecipes),
        classFolders: CRAFT_ITEM_CLASS_ORDER
          .filter(itemClass => node.classRecipeBuckets.has(itemClass))
          .map(itemClass => ({
            key: itemClass,
            itemClass,
            recipes: sortRecipes(node.classRecipeBuckets.get(itemClass) ?? [])
          }))
      });
    }
    subcategories.sort((left, right) => {
      const leftOrder = configured.has(left.key) ? configured.get(left.key) : Number.POSITIVE_INFINITY;
      const rightOrder = configured.has(right.key) ? configured.get(right.key) : Number.POSITIVE_INFINITY;
      if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
      if (left.key === CRAFT_NO_SUBCATEGORY_TOKEN) return 1;
      if (right.key === CRAFT_NO_SUBCATEGORY_TOKEN) return -1;
      return collator.compare(left.rawSubcategory, right.rawSubcategory);
    });
    subcategoryNodes.push({ category, subcategories });
  }

  subcategoryNodes.sort((left, right) => {
    const leftToken = left.category.key;
    const rightToken = right.category.key;
    if (left.category.isUncategorized !== right.category.isUncategorized) return left.category.isUncategorized ? 1 : -1;
    const leftOrder = categoryOrder.has(leftToken) ? categoryOrder.get(leftToken) : Number.POSITIVE_INFINITY;
    const rightOrder = categoryOrder.has(rightToken) ? categoryOrder.get(rightToken) : Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
    return collator.compare(left.category.rawCategory, right.category.rawCategory);
  });

  return subcategoryNodes.map(entry => ({
    key: entry.category.key,
    rawCategory: entry.category.rawCategory,
    isUncategorized: entry.category.isUncategorized,
    subcategories: entry.subcategories
  }));
}
