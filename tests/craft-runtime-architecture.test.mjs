import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const craftSource = fs.readFileSync(new URL("../src/apps/craft-window.mjs", import.meta.url), "utf8");
const knowledgeSource = fs.readFileSync(new URL("../src/items/recipe-knowledge.mjs", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
const craftTemplate = fs.readFileSync(new URL("../templates/actor/craft-window.hbs", import.meta.url), "utf8");

test("craft catalog is actor-local and never builds a world-wide idle index", () => {
  assert.doesNotMatch(mainSource, /initializeCraftRecipeWorldIndex/);
  assert.doesNotMatch(craftSource, /requestIdleCallback|scheduleWorldRecipeIndexBuild/);
  assert.match(craftSource, /const knownUuids = getKnownCraftItemUuids\(actor\)/);
  assert.match(craftSource, /for \(const itemUuid of knownUuids\)/);
  assert.match(craftSource, /resolveWorldItemSync\(itemUuid\)/);
});

test("recipe browser materializes a bounded list and uses delegated controls", () => {
  assert.match(craftSource, /const CRAFT_RECIPE_DOM_LIMIT = 120/);
  assert.match(craftSource, /remaining = CRAFT_RECIPE_DOM_LIMIT/);
  assert.match(craftSource, /sidebar\?\.addEventListener\("click"/);
  assert.match(craftSource, /current\.replaceWith\(replacement\)/);
  assert.doesNotMatch(craftSource, /#filterRecipeList/);
  assert.match(craftTemplate, /craft-window-recipe-list\.hbs/);
});

test("known recipe membership reuses one Set until the actor flag changes", () => {
  assert.match(knowledgeSource, /const knownCraftItemUuidCache = new WeakMap\(\)/);
  assert.match(knowledgeSource, /cached\?\.stored === stored/);
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
  assert.match(application, /createCraftOutputPlan/);
  assert.match(application, /createCraftFailureOutputPlan/);
});
