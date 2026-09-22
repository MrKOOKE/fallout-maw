import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filterCompatibleCraftRecipes, getCraftCompatibilityActions } from "../src/utils/craft-recipe-compatibility.mjs";
import { isAmmoCompatibleItem } from "../src/utils/item-ammo-compatibility.mjs";
import { hasCraftKnowledgeLayoutData } from "../src/items/recipe-knowledge.mjs";
import { createCraftMenuRuntime } from "./helpers/craft-menu-runtime.mjs";

globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.game = { items: { contents: [], get(id) { return this.contents.find(item => item.id === id); } }, settings: { get: () => null } };

const gear = (id, functions) => ({ id, uuid: `Item.${id}`, type: "gear", name: id, system: { functions } });
const ammo = id => gear(id, { damageSource: { enabled: true, damage: "5" } });
const moduleItem = (id, key, targetFunction = "weapon") => gear(id, { module: { enabled: true, name: key, targetFunction } });
const weapon = () => gear("weapon", {
  weapon: { enabled: true, magazine: { sourceItemUuids: ["Item.round"] }, moduleSlots: [{ moduleKey: "optic" }] },
  additionalWeapons: { launcher: { enabled: true, magazine: { sourceItemUuid: "Item.grenade" } } }
});
const summaries = items => items.map(item => ({ itemUuid: item.uuid, uuid: `${item.uuid}::recipe:recipe1` }));

test("craft ammo results include all supported weapon functions and every recipe variant", () => {
  const items = [ammo("round"), ammo("grenade"), ammo("wrong-caliber")];
  game.items.contents = items;
  const recipes = summaries(items);
  recipes.push({ itemUuid: items[0].uuid, uuid: `${items[0].uuid}::recipe:alternate` });
  assert.deepEqual(filterCompatibleCraftRecipes(weapon(), "ammo", recipes).map(recipe => recipe.uuid), [
    "Item.round::recipe:recipe1", "Item.grenade::recipe:recipe1", "Item.round::recipe:alternate"
  ]);
  const disabled = weapon();
  disabled.system.functions.additionalWeapons.launcher.enabled = false;
  assert.deepEqual(filterCompatibleCraftRecipes(disabled, "ammo", recipes).map(recipe => recipe.itemUuid), ["Item.round", "Item.round"]);
});

test("ammo matching recognizes prototype copies but excludes different damage and disabled sources", () => {
  const prototype = ammo("round");
  game.items.contents = [prototype];
  const copy = ammo("copy");
  copy.name = prototype.name;
  assert.equal(isAmmoCompatibleItem(weapon(), copy), true);
  copy.system.functions.damageSource.damage = "99";
  assert.equal(isAmmoCompatibleItem(weapon(), copy), false);
  copy.getFlag = (scope, key) => key === "damageSourcePrototypeUuid" ? prototype.uuid : undefined;
  assert.equal(isAmmoCompatibleItem(weapon(), copy), true);
  copy.system.functions.damageSource.enabled = false;
  assert.equal(isAmmoCompatibleItem(weapon(), copy), false);
  assert.equal(isAmmoCompatibleItem(weapon(), weapon()), false);
});

test("module recipes use the same slot compatibility as trading", () => {
  const items = [moduleItem("scope", "optic"), moduleItem("suppressor", "barrel"), moduleItem("armor", "optic", "damageMitigation")];
  game.items.contents = items;
  assert.deepEqual(filterCompatibleCraftRecipes(weapon(), "modules", summaries(items)).map(recipe => recipe.itemUuid), ["Item.scope"]);
  const occupied = weapon();
  occupied.system.functions.weapon.moduleSlots[0].itemUuid = "Item.installed";
  assert.deepEqual(filterCompatibleCraftRecipes(occupied, "modules", summaries(items)), []);
  assert.deepEqual(filterCompatibleCraftRecipes(weapon(), "unknown", summaries(items)), []);
});

test("context actions are available on weapons, not plain components", () => {
  assert.deepEqual(getCraftCompatibilityActions(weapon()).map(action => action.kind), ["ammo", "modules"]);
  assert.deepEqual(getCraftCompatibilityActions(gear("component", {})), []);
  assert.deepEqual(getCraftCompatibilityActions(ammo("round")), []);
});

const source = readFileSync(new URL("../src/apps/craft-window.mjs", import.meta.url), "utf8");
function productionFunction(name) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

test("result cards preserve recipe selection and availability, excluding disassembly-only recipes", () => {
  game.items.contents = [ammo("round")];
  const runtime = createCraftMenuRuntime();
  const create = new Function("filterCompatibleCraftRecipes", "hasCraftKnowledgeLayoutData", "getCraftRecipeCategory", `
    const CRAFT_MODE_CREATE = "craft", CRAFT_MODE_DISASSEMBLY = "disassembly", FALLBACK_ICON = "bag.svg";
    const normalizeCraftMode = mode => mode;
    const normalizeImagePath = (img, fallback) => img || fallback;
    const toInteger = value => Math.trunc(Number(value) || 0);
    const isCraftRecipeMissing = (recipe, actor, mode, availability) => availability.has(recipe.uuid);
    ${productionFunction("hasCraftRecipeDataForMode")}
    ${productionFunction("getCraftRecipeDisplayName")}
    ${productionFunction("buildCompatibleCraftEntries")}
    ${productionFunction("prepareCraftRecipeDisplay")}
    return buildCompatibleCraftEntries;
  `)(filterCompatibleCraftRecipes, hasCraftKnowledgeLayoutData, runtime.getCraftRecipeCategory);
  const recipe = id => ({
    uuid: `Item.round::recipe:${id}`, itemUuid: "Item.round", name: "Round", recipeName: id,
    system: { quantity: 10, craft: { nodes: [{ id: "ingredient", itemUuid: "Item.material" }], links: [{ from: "ingredient", to: "root" }] } }
  });
  const first = recipe("recipe1"), alternate = recipe("alternate"), dismantle = recipe("dismantle");
  dismantle.system.craft = { disassembly: first.system.craft };
  const cards = create(weapon(), "ammo", [first, alternate, dismantle], {}, new Set([alternate.uuid]));
  assert.deepEqual(cards.map(card => [card.recipeSelectionUuid, card.mode, card.available]), [
    [first.uuid, "craft", true], [alternate.uuid, "craft", false]
  ]);
  assert.equal(cards[0].name, "Round (10х)");
  assert.equal(cards[1].recipeName, "alternate");
  const unknown = { ...recipe("unknown"), known: false };
  const concealed = create(weapon(), "ammo", [unknown], {}, new Set());
  assert.equal(concealed.length, 1);
  assert.equal(concealed[0].unknown, true);
  assert.equal(concealed[0].available, false);
  assert.equal(concealed[0].recipeSelectionUuid, "");
  assert.equal(concealed[0].tooltipUuid, "");
  assert.notEqual(concealed[0].name, unknown.name);
});

test("catalog includes unknown world recipes and learning changes their visibility without granting other recipes", async () => {
  const items = ["first", "second"].map(id => ({
    ...gear(id, {}), documentName: "Item",
    system: { craft: { nodes: [{ id: "root", root: true }, { id: "material", itemUuid: "Item.material" }],
      links: [{ from: "material", to: "root" }] } }
  }));
  game.items.contents = items;
  const actor = { uuid: "Actor.learning", known: [], getFlag() { return this.known; } };
  const runtime = createCraftMenuRuntime();
  const hidden = await runtime.getCraftRecipeSummaries(actor);
  assert.equal(hidden.length, 2);
  assert.ok(hidden.every(recipe => recipe.known === false));
  assert.deepEqual(await runtime.getCraftWindowOpenOptionsForItem(items[0], actor), []);
  actor.known = [items[0].uuid];
  const learned = await runtime.getCraftRecipeSummaries(actor);
  assert.equal(learned.find(recipe => recipe.itemUuid === items[0].uuid).known, true);
  assert.equal(learned.find(recipe => recipe.itemUuid === items[1].uuid).known, false);
  assert.equal((await runtime.getCraftWindowOpenOptionsForItem(items[0], actor)).length, 1);
  assert.deepEqual(await runtime.getCraftWindowOpenOptionsForItem(items[1], actor), []);
});

function createTabRuntime() {
  const methods = ["createCraftTab", "ensureCraftTabs", "getActiveCraftTab", "saveActiveCraftTabState",
    "loadCraftTabState", "addCraftTab", "selectCraftTab", "closeCraftTab", "getCraftReturnTab",
    "returnFromCraftTab", "showUsageCraftsForItem", "showAcquisitionWaysForItem", "openSelection"];
  const implementations = methods.map(name => {
    const match = source.match(new RegExp(`  #?${name}\\([^]*?\\n  \\}`));
    assert.ok(match, name);
    return match[0].replaceAll("#", "");
  }).join("\n");
  let id = 0;
  return new Function("foundry", `
    const DEFAULT_CRAFT_RECIPE_ID = "recipe1", DEFAULT_CRAFT_TAB_NAME = "Craft";
    const toInteger = value => Math.trunc(Number(value) || 0);
    const normalizeCraftMode = value => value === "disassembly" ? value : "craft";
    const parseCraftRecipeSelectionUuid = () => ({ recipeId: "recipe1" });
    return new class {
      craftTabs = []; activeCraftTabId = ""; busy = false;
      updateCraftTabTitle() {} updateActiveCraftTabTitle() {}
      clearCraftContextOverlays() {} clearInventoryTooltip() {}
      renderPreservingWindowStack() { return true; }
      ${implementations}
    };
  `)({ utils: { deepClone: structuredClone, randomID: () => `tab-${++id}` } });
}

test("every related-craft search opens a separate tab and return restores the original state", () => {
  for (const kind of ["ammo", "modules", "usage", "acquisition"]) {
    const window = createTabRuntime();
    window.ensureCraftTabs();
    const origin = window.activeCraftTabId;
    window.selectedRecipeUuid = "Item.original::recipe:recipe1";
    window.craftMode = "disassembly";
    window.recipeSearch = "laser";
    window.expandedRecipeNodes = new Set(["c:Weapons"]);
    window.craftViewportOverride = { x: 25, y: 40, zoom: 2 };
    window.craftRepeatCount = 3;
    const open = kind === "acquisition" ? window.showAcquisitionWaysForItem : window.showUsageCraftsForItem;
    assert.equal(open.call(window, weapon(), kind), true);
    assert.equal(window.craftTabs.length, 2);
    assert.notEqual(window.activeCraftTabId, origin);
    assert.equal(window.getCraftReturnTab().id, origin);
    assert.equal(kind === "acquisition" ? window.acquisitionTargetUuid : window.usageTargetUuid, "Item.weapon");
    assert.equal(window.selectedRecipeUuid, "");
    assert.equal(window.returnFromCraftTab(), true);
    assert.equal(window.craftTabs.length, 1);
    assert.equal(window.activeCraftTabId, origin);
    assert.equal(window.selectedRecipeUuid, "Item.original::recipe:recipe1");
    assert.equal(window.craftMode, "disassembly");
    assert.equal(window.recipeSearch, "laser");
    assert.deepEqual([...window.expandedRecipeNodes], ["c:Weapons"]);
    assert.deepEqual(window.craftViewportOverride, { x: 25, y: 40, zoom: 2 });
    assert.equal(window.craftRepeatCount, 3);
  }
});

test("nested search returns to its exact origin and missing origins disable return", () => {
  const window = createTabRuntime();
  window.ensureCraftTabs();
  const root = window.activeCraftTabId;
  window.showUsageCraftsForItem(weapon(), "ammo");
  const ammoTab = window.activeCraftTabId;
  window.showUsageCraftsForItem(weapon(), "modules");
  assert.equal(window.getCraftReturnTab().id, ammoTab);
  window.returnFromCraftTab();
  assert.equal(window.activeCraftTabId, ammoTab);
  assert.equal(window.usageKind, "ammo");
  window.addCraftTab();
  const unrelated = window.activeCraftTabId;
  window.selectCraftTab(ammoTab);
  window.closeCraftTab(root);
  assert.equal(window.getCraftReturnTab(), null);
  assert.equal(window.returnFromCraftTab(), undefined);
  assert.equal(window.activeCraftTabId, ammoTab);
  assert.deepEqual(window.craftTabs.map(tab => tab.id), [ammoTab, unrelated]);
});

test("opening a result recipe preserves its search tab", () => {
  const window = createTabRuntime();
  window.showUsageCraftsForItem(weapon(), "ammo");
  const searchTab = window.activeCraftTabId;
  window.openSelection({ recipeSelectionUuid: "Item.round::recipe:recipe1" });
  assert.equal(window.craftTabs.length, 3);
  assert.notEqual(window.activeCraftTabId, searchTab);
  window.selectCraftTab(searchTab);
  assert.equal(window.usageKind, "ammo");
  assert.equal(window.usageTargetUuid, "Item.weapon");
});
