import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const craftSource = fs.readFileSync(new URL("../src/apps/craft-window.mjs", import.meta.url), "utf8");
const knowledgeSource = fs.readFileSync(new URL("../src/items/recipe-knowledge.mjs", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
const craftTemplate = fs.readFileSync(new URL("../templates/actor/craft-window.hbs", import.meta.url), "utf8");

test("craft catalog annotates world recipes with actor knowledge only when opened", () => {
  assert.doesNotMatch(mainSource, /initializeCraftRecipeWorldIndex/);
  assert.doesNotMatch(craftSource, /requestIdleCallback|scheduleWorldRecipeIndexBuild/);
  assert.match(craftSource, /const knownUuids = getKnownCraftItemUuids\(actor\)/);
  assert.match(craftSource, /globalThis\.game\?\.items\?\.contents/);
  assert.match(craftSource, /summary\.known = knownUuids\.has\(item\.uuid\)/);
  assert.match(craftSource, /resolveWorldItemSync\(itemUuid\)/);
});

test("recipe browser uses delegated controls and never caps the recipe list", () => {
  assert.doesNotMatch(craftSource, /CRAFT_RECIPE_DOM_LIMIT/);
  assert.doesNotMatch(craftSource, /recipeListTruncated|recipeListShown|limitHidden|getCraftHiddenRecipesLabel/);
  assert.doesNotMatch(craftTemplate, /recipeListTruncated|recipeListShown|limitHidden/);
  assert.match(craftSource, /sidebar\?\.addEventListener\("click"/);
  assert.match(craftSource, /current\.replaceWith\(replacement\)/);
  assert.doesNotMatch(craftSource, /#filterRecipeList/);
  assert.match(craftTemplate, /craft-window-recipe-list\.hbs/);
});

test("opening a recipe never unfolds the folder tree by itself", () => {
  const prepareContext = craftSource.match(/async #prepareCraftPanelContext\([^]*?\n  \}/)?.[0] ?? "";
  assert.ok(prepareContext.length > 0, "prepare context must be found");
  assert.doesNotMatch(prepareContext, /craftRecipeExpansionKeys/);
  assert.doesNotMatch(prepareContext, /#expandedRecipeNodes\.add/);
});

test("all three folder levels share one explicit expansion state", () => {
  const recipeListTemplate = fs.readFileSync(
    new URL("../templates/actor/parts/craft-window-recipe-list.hbs", import.meta.url),
    "utf8"
  );
  assert.match(craftSource, /#expandedRecipeNodes = new Set\(\)/);
  assert.doesNotMatch(craftSource, /collapsedRecipeSubcategories|collapsedSubcategories/);
  // Subcategories default to folded exactly like categories and class folders.
  assert.match(craftSource, /const subcategoryExpanded = expandedKeys\.has\(subcategoryKey\)/);
  assert.match(craftSource, /const isExpanded = expandedKeys\.has\(folderKey\)/);
  assert.match(craftSource, /entry\.startsWith\(`\$\{key\}:`\)/);
  assert.match(recipeListTemplate, /has-class-folders/);
});

test("the rebuilt recipe list re-anchors its scroll position", () => {
  // Replacing the scroll container discards its scrollTop (a detached node has
  // no scrollHeight), so the list must restore its position by anchor.
  assert.match(craftSource, /#captureRecipeListAnchor\(current\)/);
  assert.match(craftSource, /#restoreRecipeListAnchor\(replacement, anchor\)/);
  assert.doesNotMatch(craftSource, /replacement\.scrollTop = /);
  const capture = craftSource.match(/#captureRecipeListAnchor\(scroller\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(capture.length > 0, "anchor capture must be found");
  assert.match(capture, /scrollTop/);
  assert.match(capture, /getBoundingClientRect/);
  const restore = craftSource.match(/#restoreRecipeListAnchor\(scroller, anchor\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.ok(restore.length > 0, "anchor restore must be found");
  assert.match(restore, /scroller\.scrollTop \+= drift/);
  assert.match(restore, /requestAnimationFrame/);
});

test("recipe browser nests category, subcategory and condition-derived class folders", () => {
  const recipeListTemplate = fs.readFileSync(
    new URL("../templates/actor/parts/craft-window-recipe-list.hbs", import.meta.url),
    "utf8"
  );
  // The tree is assembled from the shared grouping module, not ad hoc here.
  assert.match(craftSource, /createCraftRecipeGrouping\(\{/);
  assert.match(craftSource, /itemCategories: getItemCategorySettings\(\)/);
  assert.doesNotMatch(craftSource, /expandedCategories:/);
  assert.match(craftSource, /expandedKeys: this\.#expandedRecipeNodes/);
  // Class folders come from the condition recovery methods only.
  assert.match(craftSource, /summary\.itemClass = getCraftItemClass\(item\)/);
  assert.match(craftSource, /getCraftClassLabel\(folder\.key\)/);
  // Folder headers are separate toggle kinds and share one keyboard hook.
  assert.match(recipeListTemplate, /data-craft-recipe-category-toggle=/);
  assert.match(recipeListTemplate, /data-craft-recipe-subcategory-toggle=/);
  assert.match(recipeListTemplate, /data-craft-recipe-class-toggle=/);
  assert.match(recipeListTemplate, /data-craft-recipe-toggle/);
  assert.match(craftSource, /\[data-craft-recipe-toggle\], \[data-recipe-uuid\]/);
  // Classless recipes render as a plain list after the class folders.
  assert.match(recipeListTemplate, /\{\{#each classFolders\}\}/);
  assert.match(recipeListTemplate, /fallout-maw-craft-window-recipe-empty/);
});

test("sidebar gains 10% of the inventory column for the deeper folder tree", () => {
  const styles = fs.readFileSync(new URL("../styles/fallout-maw.css", import.meta.url), "utf8");
  assert.match(styles, /--fallout-maw-craft-window-sidebar-width: 20\.9rem/);
  assert.match(styles, /--fallout-maw-craft-window-folder-indent:/);
  assert.match(styles, /\.fallout-maw-craft-window-recipe-subcategory \{/);
  assert.match(styles, /\.fallout-maw-craft-window-recipe-class \{/);
  assert.match(styles, /margin-left: var\(--fallout-maw-craft-window-folder-indent\)/);
});

test("known recipe membership reuses one Set until the actor flag changes", () => {
  assert.match(knowledgeSource, /const knownCraftItemUuidCache = new WeakMap\(\)/);
  assert.match(knowledgeSource, /cached && cached\.stored === stored/);
  assert.match(knowledgeSource, /knownCraftItemUuidCache\.set\(actor, \{ stored, uuids \}\)/);
});

test("selected graph shares normalized nodes with its link pass", () => {
  assert.match(craftSource, /getCraftLinks\(recipe, mode, recipeId, nodes\)/);
  assert.match(craftSource, /nodes \?\?= getCraftNodesWithRoot\(item, mode, recipeId\)/);
  assert.match(craftSource, /let craftRecipeEntryCache = new WeakMap\(\)/);
});

test("craft requirements match only stable source UUID keys", () => {
  const indexedMatcher = craftSource.match(/function craftIndexedItemMatchesRequirement[\s\S]*?\n\}/)?.[0] ?? "";
  const directMatcher = craftSource.match(/function craftItemMatchesRequirement[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(indexedMatcher, /setsIntersect\(requirementKeys, itemKeys\)/);
  assert.match(directMatcher, /setsIntersect\(requirementKeys, itemKeys\)/);
  assert.doesNotMatch(indexedMatcher, /fingerprint|identity/);
  assert.doesNotMatch(directMatcher, /fingerprint|identity/);
});

test("craft spending and output stacking use direct candidate indexes", () => {
  const spendPlanner = craftSource.match(/function createCraftRequirementSpendPlan[\s\S]*?\n\}/)?.[0] ?? "";
  const outputPlanner = craftSource.match(/function planCraftOutputPlacement[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(craftSource, /itemsBySourceKey/);
  assert.match(spendPlanner, /getIndexedCraftRequirementCandidates\(index, requirement\)/);
  assert.match(outputPlanner, /createInventoryStackCandidateIndex/);
  assert.match(outputPlanner, /const outputContexts = getCraftOutputContexts\(actor, planningItems\)/);
  assert.equal((outputPlanner.match(/getCraftOutputContexts\(actor, planningItems\)/g) ?? []).length, 1);
  assert.match(outputPlanner, /getCraftOutputStackTargets\(actor, spec\.data, planningItems, stackCandidateIndex, contextOrder\)/);
  assert.match(outputPlanner, /findCraftOutputTarget\(actor, createData, planningItems, outputContexts\)/);
  assert.match(outputPlanner, /createCraftOutputStackParts\([\s\S]*?planningItems,[\s\S]*?outputContexts\s*\)/);
});

test("click validation does not duplicate authoritative output placement", () => {
  const validation = craftSource.match(/async function validateCraftRequest[\s\S]*?\n\}\n\nasync function applyCraftOperation/)?.[0] ?? "";
  const application = craftSource.match(/async function applyCraftOperation[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(validation, /createCraftOutputPlan|createCraftFailureOutputPlan/);
  assert.match(application, /planCraftOutputPlacement/);
  assert.match(application, /createCraftFailureOutputPlan/);
});
