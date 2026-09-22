import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getItemContainerParentId, getItemQuantity, isItemLocked, isItemInButcheringStorage, LOCKED_STORAGE_PLACEMENT_MODE } from "../src/utils/inventory-containers.mjs";

const source = fs.readFileSync(new URL("../src/apps/craft-window.mjs", import.meta.url), "utf8");
function fn(name, deps, text = source) {
  const match = text.match(new RegExp(`(?:export )?((?:async )?function ${name}\\([^]*?\\n\\})`));
  assert.ok(match, name);
  return new Function(...Object.keys(deps), `${match[1]}; return ${name};`)(...Object.values(deps));
}
const item = (id, system = {}) => ({ id, name: id, type: "gear", system: { quantity: 1, ...system }, toObject() { return { _id: id, system: structuredClone(this.system) }; } });
const actor = (id, items = []) => ({ uuid: `Actor.${id}`, isOwner: true, items: { contents: items, get: id => items.find(i => i.id === id) } });

test("quick eligibility checks every recipe variant, knowledge, locked ancestors and filled containers", async () => {
  const items = [item("junk"), item("craft"), item("unknown"), item("known"), item("locked", { locked: true }),
    item("inside", { container: { parentId: "locked" } }), item("empty", { quantity: 0 }), item("natural"),
    item("butcher", { placement: { mode: "butcheringStorage" } }), item("box"), item("child", { container: { parentId: "box" } })];
  const sourceActor = actor("source", items), skillActor = actor("searcher");
  const run = fn("getQuickDisassemblyItems", {
    getItemContainerParentId, getItemQuantity, isItemLocked, isItemInButcheringStorage, LOCKED_STORAGE_PLACEMENT_MODE,
    CRAFT_MODE_CREATE: "create", CRAFT_MODE_DISASSEMBLY: "disassembly", isNaturalRaceItem: item => item.id === "natural",
    getCraftRecipeSummaries: async a => assert.equal(a, skillActor),
    findCraftRecipesForItem: item => [
      { uuid: item.id, system: { craft: { disassembly: true, disassemblyRequiresRecipe: ["unknown", "known"].includes(item.id) } } },
      ...(item.id === "craft" ? [{ system: { craft: { create: true } } }] : [])
    ],
    hasCraftRecipeDataForMode: (craft, mode) => craft[mode],
    resolveCraftRecipeSelection: id => ({ item: { id } }),
    actorKnowsCraftItem: (a, recipe) => { assert.equal(a, skillActor); return recipe.id === "known"; }
  });
  assert.deepEqual((await run(sourceActor, skillActor)).map(i => i.id), ["junk", "known", "child"]);
});

function quickFixture({ threshold = true, random = false, failedCommit = false } = {}) {
  const sourceActor = actor("source", [item("junk", { quantity: 4 }), item("unavailable")]);
  const skillActor = actor("searcher", [item("tool")]);
  const calls = { checks: 0, commits: [], validations: 0, aborts: 0 };
  class App {
    async resolveCraftLinkResults(a) { assert.equal(a, skillActor); calls.checks++; return [{ success: true }]; }
    buildCraftOperation(a, recipe, validation) { assert.equal(a, sourceActor); return { ...validation, recipeUuid: recipe.uuid, mode: this.craftMode }; }
  }
  const deps = {
    CraftWindowApplication: App, CRAFT_MODE_DISASSEMBLY: "disassembly",
    getQuickDisassemblyItems: async () => sourceActor.items.contents,
    findCraftRecipesForItem: i => [{ uuid: i.id, system: { craft: {} } }], hasCraftRecipeDataForMode: () => true,
    resolveCraftRecipeSelection: uuid => ({ item: { uuid }, recipeId: "variant" }),
    validateCraftRequest: async (a, recipe, mode, tools, id, options) => {
      assert.equal(a, sourceActor); assert.equal(options.skillActor, skillActor); assert.equal(options.sourceItemId, recipe.uuid);
      calls.validations++;
      return recipe.uuid === "unavailable" ? { valid: false, message: "Недостаточный навык" } : {
        valid: true, requirements: [{ itemId: recipe.uuid, quantity: 1 }], outputs: [{ sourceUuid: "Item.output", quantity: 2 }],
        links: [], toolRequirements: [{ key: "tool", quantity: 1 }], toolSelections: { tool: "tool" }
      };
    },
    createCraftToolRequirementSpendPlan: (a, tools) => { assert.equal(a, skillActor); assert.equal(tools[0].quantity, 4); return { valid: true }; },
    getItemQuantity, getCraftNodesWithRootLite: () => random ? [{ blockLimit: 1 }] : [],
    isSkillThresholdMode: () => threshold, getCraftingSettings: () => ({ craft: { mode: "threshold" } }),
    createSkillCheckBatchCollector: () => ({ size: 0, abort: async () => calls.aborts++ }),
    applyBulkCraftOperations: async (...args) => { calls.commits.push(args); if (failedCommit) throw new Error("commit failed"); return { dropped: true }; },
    invalidateCraftRecipeAvailabilityCaches() {}
  };
  const text = source.match(/  static async runQuickDisassembly\([^]*?\n  \}/)[0].replace("static ", "").replaceAll("#", "");
  const run = new Function(...Object.keys(deps), `return ({ ${text} }).runQuickDisassembly;`)(...Object.values(deps));
  return { run: () => run({ actor: sourceActor, skillActor, itemIds: null }), calls, sourceActor, skillActor };
}

test("quick threshold disassembly aggregates stacks once and retains results at the searched actor", async () => {
  const { run, calls, sourceActor, skillActor } = quickFixture();
  const result = await run();
  assert.equal(result.completed, 4); assert.equal(result.dropped, true); assert.equal(result.skipped[0].name, "unavailable");
  assert.equal(calls.commits.length, 1); assert.equal(calls.checks, 1);
  const [target, operations, snapshot, options] = calls.commits[0];
  assert.equal(target, sourceActor); assert.equal(options.skillActor, skillActor); assert.equal(options.expectedToolItems[0]._id, "tool");
  assert.equal(snapshot[0].system.quantity, 4); assert.equal(operations[0].requirements[0].quantity, 4);
  assert.equal(operations[0].outputs[0].quantity, 8); assert.equal(operations[0].toolRequirements[0].quantity, 4);
  assert.equal(operations[0].recipeId, "variant"); assert.equal(calls.aborts, 1);
});

test("quick checks and random output selections run separately for each dismantled unit", async () => {
  for (const options of [{ threshold: false }, { random: true }]) {
    const { run, calls } = quickFixture(options); await run();
    assert.equal(calls.checks, 4); assert.equal(calls.validations, 5); assert.equal(calls.commits.length, 1);
    assert.equal(calls.commits[0][1].length, 4);
  }
});

test("failed quick mutation does not return success and releases the check collector", async () => {
  const { run, calls } = quickFixture({ failedCommit: true });
  await assert.rejects(run(), /commit failed/); assert.equal(calls.aborts, 1);
});

test("source inventory is spent separately from the searcher's skill and tool checks", async () => {
  const sourceActor = actor("source", [item("junk")]), skillActor = actor("searcher");
  const touched = [];
  const run = fn("validateCraftRequest", {
    CRAFT_MODE_CREATE: "create", CRAFT_MODE_DISASSEMBLY: "disassembly", DEFAULT_CRAFT_RECIPE_ID: "main",
    normalizeCraftMode: x => x, actorKnowsCraftItem: a => { assert.equal(a, skillActor); return true; },
    getCraftRenderData: (_recipe, a) => {
      assert.equal(a, skillActor);
      return { links: [{}], nodes: [], requirements: [{ key: "root", sourceUuid: "Item.junk", quantity: 1, owned: 0 }],
        outputs: [{ sourceUuid: "Item.output", quantity: 2 }], toolRequirements: [] };
    },
    getItemQuantity, createCraftRequirementSpendPlan: (a, reqs) => { assert.equal(a, sourceActor); touched.push(reqs[0].itemId); },
    prepareCraftOperationLinks: x => x, getUnmetCraftSkillThreshold: a => { assert.equal(a, skillActor); return null; },
    createCraftToolRequirementSpendPlan: a => { assert.equal(a, skillActor); return { valid: true, selectedByRequirement: new Map() }; },
    getCraftFailureOutputs: () => []
  });
  const result = await run(sourceActor, {}, "disassembly", {}, "main", { sourceItemId: "junk", skillActor });
  assert.equal(result.valid, true); assert.deepEqual(touched, ["junk"]); assert.equal(result.requirements[0].itemId, "junk");
});

test("search endpoint enforces ownership and filters the requested list using current eligibility", async () => {
  const searchSource = fs.readFileSync(new URL("../src/apps/search-inventory.mjs", import.meta.url), "utf8")
    .replace('await import("./craft-window.mjs");\n  if (payload.itemIds', 'craftModule;\n  if (payload.itemIds');
  const searcher = actor("searcher"), searched = actor("searched"), outsider = actor("outsider");
  const actors = [searcher, searched, outsider], calls = [];
  const run = fn("performSearchQuickDisassembly", {
    game: { users: { get: id => id === "player" ? {} : null } },
    resolveActor: async uuid => actors.find(a => a.uuid === uuid), isTradePayload: () => false,
    validateSearchOrTradeRequester: (_payload, _id, a) => { if (a !== searcher) throw new Error("permission"); },
    isSearchTransferableItem: () => true,
    craftModule: { getQuickDisassemblyItems: async (a, skill) => { assert.equal(a, searched); assert.equal(skill, searcher); return [item("junk")]; },
      quickDisassembleItems: async options => calls.push(options) }
  }, searchSource);
  const payload = { searcherActorUuid: searcher.uuid, searchedActorUuid: searched.uuid, actorUuid: searched.uuid, itemIds: ["junk", "locked"] };
  await run(payload, "player"); assert.deepEqual(calls[0], { actor: searched, skillActor: searcher, itemIds: ["junk"] });
  await assert.rejects(run(payload, "missing"), /Пользователь/);
  await assert.rejects(run({ ...payload, actorUuid: outsider.uuid }, "player"), /не относятся/);
  await assert.rejects(run({ ...payload, searcherActorUuid: outsider.uuid }, "player"), /permission/);
  assert.equal(calls.length, 1);
});
