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
});

test("compatibility opens the usage list without changing recipe search or expanded folders", () => {
  const method = source.match(/  #showUsageCraftsForItem\([^]*?\n  \}/)?.[0];
  assert.ok(method);
  const TestWindow = new Function(`return class {
    #usageTargetUuid = ""; #usageKind = "usage"; #acquisitionTargetUuid = "old";
    #craftToolPickerNodeId = "old"; #craftViewportOverride = {};
    #recipeSearch = "laser"; #expandedRecipeNodes = new Set(["c:Weapons"]);
    #clearCraftContextOverlays() {} #saveActiveCraftTabState() {} #renderPreservingWindowStack() { return true; }
    ${method}
    open(item, kind) { return this.#showUsageCraftsForItem(item, kind); }
    state() { return [this.#usageTargetUuid, this.#usageKind, this.#acquisitionTargetUuid, this.#recipeSearch, [...this.#expandedRecipeNodes]]; }
  }`)();
  const window = new TestWindow();
  for (const kind of ["ammo", "modules", undefined]) {
    assert.equal(window.open(weapon(), kind), true);
    assert.deepEqual(window.state(), ["Item.weapon", kind ?? "usage", "", "laser", ["c:Weapons"]]);
  }
});
