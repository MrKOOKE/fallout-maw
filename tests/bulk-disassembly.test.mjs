import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { formatCraftYieldQuantity } from "../src/utils/craft-embedded-layout.mjs";
const source = fs.readFileSync(new URL("../src/apps/craft-window.mjs", import.meta.url), "utf8");
function method(name, deps) {
  const match = source.match(new RegExp(`  ((?:async )?#${name}\\([^]*?\\n  \\})`));
  assert.ok(match, name);
  const text = match[1].replaceAll("#", "");
  return new Function(...Object.keys(deps), `return ({ ${text} }).${name};`)(...Object.values(deps));
}
function fn(name, deps) {
  const match = source.match(new RegExp(`(?:export )?((?:async )?function ${name}\\([^]*?\\n\\})`));
  assert.ok(match, name);
  return new Function(...Object.keys(deps), `${match[1]}; return ${name};`)(...Object.values(deps));
}
function fixture(specs = [{ id: "a", quantity: 4, batch: 2, output: 3 }]) {
  const items = specs.map(s => ({ id: s.id, name: s.id, system: { quantity: s.quantity, locked: s.locked, container: { parentId: s.parentId } }, toObject() { return { _id: this.id, system: structuredClone(this.system) }; } }));
  const actor = { uuid: "Actor.a", isOwner: true, items: { contents: items, get: id => items.find(x => x.id === id) } };
  for (const item of items) item.parent = actor;
  const recipes = new Map(specs.map(s => [s.id, { uuid: `Item.${s.id}`, system: { craft: { disassemblyRequiresRecipe: s.requires } }, spec: s }]));
  const deps = {
    formatCraftYieldQuantity,
    CRAFT_MODE_DISASSEMBLY: "disassembly", SYSTEM_ID: "test",
    getCraftRecipeSummaries: async () => [],
    findCraftRecipesForItem: item => [{ uuid: item.id, recipeName: "Разбор", system: { craft: {} } }],
    hasCraftRecipeDataForMode: () => true,
    resolveCraftRecipeSelection: id => ({ item: recipes.get(id), recipeId: "recipe1" }),
    actorKnowsCraftItem: (_a, recipe) => Boolean(recipe.spec.known),
    isNaturalRaceItem: () => false,
    getItemQuantity: item => item.system.quantity,
    getItemContainerParentId: item => item.system.container?.parentId,
    getCraftRenderData: recipe => ({
      links: [{ skillKey: "doctor", difficulty: recipe.spec.difficulty ?? 30 }], nodes: [],
      requirements: [{ key: recipe.spec.id, sourceKeys: [recipe.spec.id], quantity: recipe.spec.batch ?? 1 }],
      toolRequirements: recipe.spec.tool ? [{ key: "tool", quantity: recipe.spec.tool }] : [],
      outputs: [{ sourceUuid: "Item.output", quantity: recipe.spec.output ?? 1 }]
    }),
    prepareCraftDisassemblyResources: (_actor, _requirements, outputs) => ({ outputs, embedded: [] }),
    prepareCraftOperationLinks: links => links,
    craftItemMatchesRequirement: (item, req) => req.sourceKeys.includes(item.id),
    getUnmetCraftSkillThreshold: (_a, links) => links.some(l => l.difficulty > 100) ? { difficulty: 120 } : null,
    getCraftSkillThresholdMessage: () => "Недостаточный навык",
    createCraftRequirementSpendPlan: (_a, reqs) => {
      const totals = new Map();
      for (const req of reqs) { const id = req.itemId ?? req.sourceKeys[0]; totals.set(id, (totals.get(id) ?? 0) + req.quantity); }
      for (const [id, amount] of totals) if ((actor.items.get(id)?.system.quantity ?? 0) < amount) throw new Error("Недостаточно предметов");
      return {};
    },
    createCraftToolRequirementSpendPlan: (_a, reqs) => ({
      valid: reqs.reduce((sum, x) => sum + x.quantity, 0) <= 5,
      message: "Недостаточно зарядов", selectedByRequirement: new Map(reqs.map(r => [r.key, { id: "instrument" }]))
    }),
    resolveWorldItemSync: uuid => ({ uuid, name: "Компонент", img: "component.webp" }),
    isSkillThresholdMode: () => true, getCraftingSettings: () => ({ craft: { mode: "threshold" } }),
  };
  const app = { actor, busy: false, bulkEntries: new Map(items.filter(i => !specs.find(s => s.id === i.id).notSelected).map(i => [i.id, { itemId: i.id, name: i.name, quantity: i.system.quantity }])) };
  app.prepareBulkContext = method("prepareBulkContext", deps);
  return { app, deps, items, recipes };
}

test("bulk preview totals all attempts without moving inventory and shows maximum difficulty", async () => {
  const { app, items } = fixture([{ id: "a", quantity: 4, batch: 2, output: 3, difficulty: 30 }, { id: "b", quantity: 3, output: 2, difficulty: 90 }]);
  const before = items.map(x => x.system.quantity);
  const result = await app.prepareBulkContext();
  assert.equal(result.canRun, true); assert.equal(result.outputs[0].quantity, 12); assert.equal(result.difficulty, 90);
  assert.deepEqual(items.map(x => x.system.quantity), before);
  assert.deepEqual(result.rows.map(r => r.requirements[0].itemId), ["a", "b"]);
});
test("unknown recipe allows owned disassembly unless author requires knowledge", async () => {
  for (const [requires, known, valid] of [[false,false,true],[true,false,false],[true,true,true]]) {
    const { app } = fixture([{ id: "a", quantity: 1, requires, known }]);
    const result = await app.prepareBulkContext(); assert.equal(result.canRun, valid);
    if (!valid) { assert.match(result.rows[0].error, /знание/); assert.equal(result.outputs.length, 0); }
  }
});
test("insufficient quantity, remainder, skill, missing item and locked item block the entire basket", async () => {
  for (const spec of [{ batch: 3 }, { batch: 5 }, { difficulty: 120 }, { locked: true }]) {
    const { app } = fixture([{ id: "a", quantity: 4, ...spec }]);
    const result = await app.prepareBulkContext(); assert.equal(result.canRun, false); assert.ok(result.rows[0].error);
  }
  const { app, items } = fixture(); items.length = 0;
  assert.equal((await app.prepareBulkContext()).canRun, false);
});
test("tool supply is reserved across all items and repetitions", async () => {
  const { app } = fixture([{ id: "a", quantity: 2, tool: 2 }, { id: "b", quantity: 1, tool: 2 }]);
  const result = await app.prepareBulkContext();
  assert.equal(result.canRun, false); assert.ok(result.rows.every(r => /зарядов/.test(r.error)));
});
test("container with contents cannot be consumed", async () => {
  const { app } = fixture([{ id: "a", quantity: 1 }, { id: "inside", quantity: 1, parentId: "a", notSelected: true }]);
  assert.match((await app.prepareBulkContext()).rows[0].error, /контейнер/);
});
test("spending selected copy never substitutes another matching copy", () => {
  const match = fn("craftIndexedItemMatchesRequirement", { setsIntersect: (a,b) => [...a].some(x => b.has(x)) });
  const req = { itemId: "selected", sourceKeys: ["Item.same"] };
  assert.equal(match({ item: { id: "other" }, quantity: 5, sourceKeys: new Set(req.sourceKeys) }, req), false);
  assert.equal(match({ item: { id: "selected" }, quantity: 5, sourceKeys: new Set(req.sourceKeys) }, req), true);
});
test("shift queues the stack, ctrl uses quantity prompt, and neither moves the items", async () => {
  const { app, deps, items } = fixture(); app.bulkEntries.clear(); app.actorUuid = app.actor.uuid;
  Object.assign(app, { _canDragDrop: () => true, clearInventoryTooltip() {}, openBulk: async () => {}, renderPreservingWindowStack: async () => {} });
  let prompts = 0;
  app.addBulkItem = method("addBulkItem", { ...deps, usesVirtualInventoryStacks: () => false, toInteger: Number,
    promptSearchItemStackQuantity: async opts => { prompts++; assert.equal(opts.max, 2); return 1; } });
  await app.addBulkItem(items[0], { shiftKey: true }, { stackQuantity: 2 });
  assert.equal(app.bulkEntries.get("a").quantity, 2); assert.equal(prompts, 0);
  await app.addBulkItem(items[0], { ctrlKey: true }, { stackQuantity: 2 });
  assert.equal(app.bulkEntries.get("a").quantity, 3); assert.equal(prompts, 1); assert.equal(items[0].system.quantity, 4);
});
test("bulk execution runs one check per attempt but commits the entire basket once", async () => {
  const { app, deps, items } = fixture([{ id: "a", quantity: 4, batch: 2 }, { id: "b", quantity: 2 }]);
  deps.isSkillThresholdMode = () => false;
  app.prepareBulkContext = method("prepareBulkContext", deps);
  let checks = 0, mutations = 0, publishes = 0;
  Object.assign(app, { updateCraftPanel: async () => {}, renderPreservingWindowStack: async () => {},
    resolveCraftLinkResults: async (_actor, _links, opts) => { assert.equal(opts.mode, "disassembly"); checks++; return [{ success: true }]; },
    buildCraftOperation: (_actor, recipe, validation, results) => ({ ...validation, recipe, success: results.every(x => x.success) }) });
  app.runBulk = method("runBulk", { ...deps,
    createSkillCheckBatchCollector: () => ({ size: 1, publish: async () => { publishes++; }, abort: async () => {} }),
    validateCraftRequest: async (_actor, recipe) => ({ valid: true, links: [], requirements: [{ sourceKeys: [recipe.spec.id], quantity: recipe.spec.batch ?? 1 }] }),
    applyBulkCraftOperations: async (_actor, operations, expectedItems) => { mutations++; assert.equal(expectedItems.length, 2); for (const operation of operations) for (const req of operation.requirements) { assert.ok(req.itemId); app.actor.items.get(req.itemId).system.quantity -= req.quantity; } },
    invalidateCraftRecipeAvailabilityCaches() {}, ui: { notifications: { info() {}, warn(message) { assert.fail(message); } } } });
  await app.runBulk();
  assert.equal(checks, 4); assert.equal(mutations, 1); assert.equal(publishes, 1);
  assert.equal(app.bulkEntries.size, 0); assert.equal(app.busy, false); assert.deepEqual(items.map(x=>x.system.quantity), [0,0]);
});


test("variant picker is present only for multiple disassembly variants", async () => {
  const { app, deps } = fixture();
  assert.equal((await app.prepareBulkContext()).rows[0].hasVariants, false);
  deps.findCraftRecipesForItem = () => [1,2].map(n => ({ uuid: "a", recipeName: String(n), system: { craft: {} } }));
  app.prepareBulkContext = method("prepareBulkContext", deps);
  assert.equal((await app.prepareBulkContext()).rows[0].hasVariants, true);
});

test("inventory shading follows the selected stack, partially selected stacks and removal", () => {
  const elements = [0,1].map(index => ({ dataset: { itemId: "a", stackIndex: String(index), stackQuantity: "4" },
    overlay: null, querySelector() { return this.overlay ? { remove: () => { this.overlay = null; } } : null; },
    ownerDocument: { createElement: () => ({ setAttribute() {} }) }, append(shade) { this.overlay = shade; } }));
  const app = { element: { querySelectorAll: () => elements }, bulkEntries: new Map([["a", { quantity: 2, stackOrder: [1] }]]) };
  const sync = method("syncBulkInventorySelection", { getItemQuantity: () => 8 });
  sync.call(app); assert.equal(elements[0].overlay, null); assert.match(elements[1].overlay.className, /partial/);
  app.bulkEntries.get("a").quantity = 4; sync.call(app);
  assert.equal(elements[0].overlay, null); assert.doesNotMatch(elements[1].overlay.className, /partial/);
  app.bulkEntries.get("a").quantity = 8; sync.call(app);
  assert.ok(elements.every(el => el.overlay && !el.overlay.className.includes("partial")));
  app.bulkEntries.clear(); sync.call(app); assert.ok(elements.every(el => !el.overlay));
});

test("overflow placement keeps every fitting unit and drops only the remainder, including later smaller outputs", () => {
  const plan = fn("planCraftDisassemblyPlacement", {
    planCraftOutputPlacement: (_a, specs) => ({ valid: specs.reduce((s,x)=>s+x.quantity*x.data.size,0)<=7, updates: [], creates: specs }),
    projectCraftInventoryState: (_a, state) => state.creates,
    validateActorInventoryState: (_a, specs) => { if(specs.reduce((s,x)=>s+x.quantity*x.data.weight,0)>6) throw new Error("weight"); }
  });
  const specs = [{ data:{ size:2, weight:2 }, quantity:5 }, { data:{ size:1, weight:0 }, quantity:3 }];
  const result = plan({}, specs, [], {});
  assert.equal(result.valid,true);
  assert.deepEqual(result.creates.map(x=>x.quantity), [3,1]);
  assert.deepEqual(result.overflow.map(x=>x.quantity), [2,2]);
  assert.equal(result.creates.reduce((s,x)=>s+x.quantity,0)+result.overflow.reduce((s,x)=>s+x.quantity,0),8);
});

test("completely full inventory drops all outputs without failing the operation", () => {
  const plan = fn("planCraftDisassemblyPlacement", {
    planCraftOutputPlacement: (_a, specs) => ({ valid: specs.length===0, updates: [], creates: [] }),
    projectCraftInventoryState: () => [], validateActorInventoryState() {}
  });
  const result = plan({}, [{data:{name:"A"},quantity:10},{data:{name:"B"},quantity:3}], [], {});
  assert.equal(result.valid,true); assert.deepEqual(result.overflow.map(x=>x.quantity),[10,3]); assert.deepEqual(result.creates,[]);
});
test("bulk preview preserves zero yields and sums actual/full quantities across stacks", async () => {
  const { app, deps } = fixture([{ id: "a", quantity: 2, output: 3 }, { id: "b", quantity: 3, output: 3 }]);
  deps.prepareCraftDisassemblyResources = (_actor, requirements, outputs) => ({
    outputs: outputs.map(output => ({ ...output, fullQuantity: output.quantity, quantity: requirements[0].itemId === "a" ? 0 : 1 })), embedded: []
  });
  app.prepareBulkContext = method("prepareBulkContext", deps);
  assert.equal((await app.prepareBulkContext()).outputs[0].quantityLabel, "3/15×");
  app.bulkEntries.delete("b");
  const preview = await app.prepareBulkContext();
  assert.equal(preview.outputs.length, 1);
  assert.equal(preview.outputs[0].quantityLabel, "0/6×");
  assert.equal(preview.canRun, true);
});

test("automatic fill adds full quantities of disassembly-only items and excludes all crafting variants", async () => {
  const { app, deps, items } = fixture([{ id: "junk", quantity: 8 }, { id: "craftable", quantity: 2 },
    { id: "empty", quantity: 1 }, { id: "restricted", quantity: 3, requires: true }, { id: "zero", quantity: 0 }]);
  app.bulkEntries = new Map([["junk", { itemId: "junk", quantity: 2, selectionUuid: "chosen" }], ["manual", { quantity: 1 }]]);
  let renders = 0;
  Object.assign(app, { _canDragDrop: () => true, clearInventoryTooltip() {}, updateCraftPanel: async () => { renders++; } });
  deps.findCraftRecipesForItem = item => item.id === "empty" ? [] : [
    { system: { craft: { disassembly: true } } }, ...(item.id === "craftable" ? [{ system: { craft: { craft: true } } }] : [])
  ];
  deps.CRAFT_MODE_CREATE = "craft";
  deps.hasCraftRecipeDataForMode = (craft, mode) => Boolean(craft[mode]);
  app.autoFillBulk = method("autoFillBulk", deps);
  await app.autoFillBulk();
  assert.deepEqual([...app.bulkEntries.keys()], ["junk", "manual", "restricted"]);
  assert.equal(app.bulkEntries.get("junk").quantity, 8); assert.equal(app.bulkEntries.get("junk").selectionUuid, "chosen");
  assert.equal(app.bulkEntries.get("restricted").quantity, 3); assert.equal(renders, 1);
  await app.autoFillBulk(); assert.equal(app.bulkEntries.get("junk").quantity, 8); assert.equal(renders, 2);
  assert.deepEqual(items.map(item => item.system.quantity), [8, 2, 1, 3, 0]);
  app.busy = true; await app.autoFillBulk(); assert.equal(renders, 2);
});

test("threshold mode with fixed outputs prepares an entire stack once", async () => {
  const { app, deps } = fixture([{ id: "a", quantity: 1000, batch: 1 }]);
  let validations = 0, commits = 0;
  Object.assign(app, { updateCraftPanel: async () => {}, renderPreservingWindowStack: async () => {},
    resolveCraftLinkResults: async () => [{ success: true }],
    buildCraftOperation: (_actor, _recipe, validation) => ({ ...validation, success: true }) });
  app.runBulk = method("runBulk", { ...deps,
    createSkillCheckBatchCollector: () => ({ size: 0, abort: async () => {} }),
    validateCraftRequest: async () => { validations++; return { valid: true, links: [],
      requirements: [{ sourceKeys: ["a"], quantity: 1 }], toolRequirements: [{ key: "tool", quantity: 2 }], outputs: [{ sourceUuid: "output", quantity: 3 }] }; },
    applyBulkCraftOperations: async (_actor, operations) => { commits++; assert.equal(operations.length, 1);
      assert.equal(operations[0].requirements[0].quantity, 1000); assert.equal(operations[0].toolRequirements[0].quantity, 2000);
      assert.equal(operations[0].outputs[0].quantity, 3000); },
    invalidateCraftRecipeAvailabilityCaches() {}, ui: { notifications: { info(message) { assert.match(message, /1000/); }, warn(message) { assert.fail(message); } } }
  });
  await app.runBulk();
  assert.equal(validations, 1); assert.equal(commits, 1); assert.equal(app.bulkEntries.size, 0);
});

test("random outputs still select results separately for every item in threshold mode", async () => {
  const { app, deps } = fixture([{ id: "a", quantity: 3 }]);
  const prepare = app.prepareBulkContext;
  app.prepareBulkContext = async () => { const preview = await prepare.call(app); preview.rows[0].randomOutputs = true; return preview; };
  let validations = 0;
  Object.assign(app, { updateCraftPanel: async () => {}, renderPreservingWindowStack: async () => {},
    resolveCraftLinkResults: async () => [{ success: true }],
    buildCraftOperation: (_actor, _recipe, validation) => ({ ...validation, success: true }) });
  app.runBulk = method("runBulk", { ...deps,
    createSkillCheckBatchCollector: () => ({ size: 0, abort: async () => {} }),
    validateCraftRequest: async () => ({ valid: true, links: [], requirements: [{ sourceKeys: ["a"], quantity: 1 }], outputs: [{ sourceUuid: `random${++validations}`, quantity: 1 }] }),
    applyBulkCraftOperations: async (_actor, operations) => { assert.deepEqual(operations.map(op => op.outputs[0].sourceUuid), ["random1", "random2", "random3"]); },
    invalidateCraftRecipeAvailabilityCaches() {}, ui: { notifications: { info() {}, warn(message) { assert.fail(message); } } }
  });
  await app.runBulk(); assert.equal(validations, 3);
});

function bulkCommitFixture({ overflow = false, failedCommit = false, requires = false } = {}) {
  const actor = { uuid: "Actor.a", isOwner: true, items: { contents: [], get: () => null } };
  const calls = { requirements: [], tools: [], outputs: [], plans: 0, writes: 0, recipes: 0 };
  const run = fn("applyBulkCraftOperations", {
    CRAFT_MODE_DISASSEMBLY: "disassembly",
    getCraftingSettings: () => ({}), resolveWorldItemSync: () => { calls.recipes++; return {}; },
    prepareCraftDisassemblyResources: (_actor, _requirements, outputs) => ({ outputs, embedded: [] }),
    actorKnowsCraftItem: () => false, canUseOwnedDisassembly: () => !requires,
    getCraftFailureRefundPercent: () => 50, calculateCraftConsumedQuantity: (q, refund) => Math.ceil(q * (100-refund) / 100),
    isNaturalRaceItem: () => false, getItemContainerParentId: () => "",
    createCraftRequirementSpendPlan: (_actor, reqs) => { calls.sourceActor = _actor; calls.requirements = reqs; return { updates: [{ _id: "input", quantity: 0 }], deletes: [] }; },
    createCraftToolRequirementSpendPlan: (_actor, reqs, selected) => { calls.skillActor = _actor; calls.tools = reqs; calls.selections = selected; return { valid: true, updates: [{ _id: "tool", "system.supply.value": 2 }], deletes: [] }; },
    getCraftOutputSpecs: async (_recipe, _mode, outputs) => { calls.outputs = outputs; return outputs; },
    projectCraftInventoryState: () => [],
    planCraftDisassemblyPlacement: (_actor, outputs) => { calls.plans++; return { valid: true, updates: [], creates: overflow ? [] : outputs, overflow: overflow ? outputs : [] }; },
    executeInventoryMutation: async mutation => { calls.writes++; calls.mutation = mutation; if (failedCommit) throw new Error("commit failed"); },
    commitInventoryWithDroppedItems: async (_actor, mutation, drops, options) => { calls.dropOptions = options; calls.writes++; calls.mutation = mutation; calls.drops = drops; if (failedCommit) throw new Error("commit failed"); }
  });
  const operation = (extra = {}) => ({ actorUuid: actor.uuid, recipeUuid: "Item.recipe", mode: "disassembly", success: true,
    requirements: [{ itemId: "input", sourceUuid: "Item.input", key: "root", quantity: 3 }],
    toolRequirements: [{ key: "tool", toolKey: "repair", toolClass: "D", quantity: 2 }], toolSelections: { tool: "instrument" },
    outputs: [{ sourceUuid: "Item.output", quantity: 4 }], failureOutputs: [], ...extra });
  return { actor, calls, operation, run };
}

test("1000 disassemblies plan and save once, merging output and tool quantities", async () => {
  for (const overflow of [false, true]) {
    const { actor, calls, operation, run } = bulkCommitFixture({ overflow });
    const snapshot = [{ _id: "input", system: { quantity: 3000 } }];
    assert.deepEqual(await run(actor, Array.from({ length: 1000 }, () => operation()), snapshot), { dropped: overflow });
    assert.equal(calls.plans, 1); assert.equal(calls.writes, 1); assert.equal(calls.recipes, 1);
    assert.equal(calls.requirements.length, 1); assert.equal(calls.requirements[0].quantity, 3000);
    assert.equal(calls.tools.length, 1); assert.equal(calls.tools[0].quantity, 2000);
    assert.equal(calls.selections[calls.tools[0].key], "instrument");
    assert.deepEqual(calls.outputs, [{ sourceUuid: "Item.output", quantity: 4000 }]);
    assert.equal(calls.mutation.expectedItems, snapshot);
    if (overflow) assert.deepEqual(calls.drops, calls.outputs);
  }
});

test("batch preserves individual failure rounding, failure outputs and distinct selected tools", async () => {
  const { actor, calls, operation, run } = bulkCommitFixture();
  await run(actor, [operation(), operation({ success: false }), operation({ success: false }),
    operation({ success: false, failureOutputs: [{ sourceUuid: "Item.failure", quantity: 7 }], toolSelections: { tool: "second" } })], []);
  assert.equal(calls.requirements[0].quantity, 10);
  assert.deepEqual(calls.outputs, [{ sourceUuid: "Item.output", quantity: 4 }, { sourceUuid: "Item.failure", quantity: 7 }]);
  assert.deepEqual(calls.tools.map(tool => [calls.selections[tool.key], tool.quantity]), [["instrument", 6], ["second", 2]]);
});

test("restricted recipes and failed commits never report successful batch completion", async () => {
  for (const options of [{ requires: true }, { failedCommit: true }, { failedCommit: true, overflow: true }]) {
    const { actor, calls, operation, run } = bulkCommitFixture(options);
    await assert.rejects(run(actor, [operation()], []), options.requires ? /знание/ : /commit failed/);
    if (options.requires) assert.equal(calls.writes, 0);
  }
});

test("search disassembly commits output to the source and spends the searcher's tools atomically", async () => {
  for (const overflow of [false, true]) {
    const { actor, calls, operation, run } = bulkCommitFixture({ overflow });
    const skillActor = { uuid: "Actor.searcher", isOwner: true };
    const expectedToolItems = [{ _id: "tool", system: { supply: { value: 4 } } }];
    const snapshot = [{ _id: "input" }];
    await run(actor, [operation()], snapshot, { skillActor, expectedToolItems });
    assert.equal(calls.sourceActor, actor); assert.equal(calls.skillActor, skillActor);
    const [sourcePlan, toolPlan] = overflow ? [calls.mutation, ...calls.dropOptions.additionalMutations] : calls.mutation;
    assert.equal(sourcePlan.actor, actor); assert.equal(sourcePlan.expectedItems, snapshot);
    assert.equal(sourcePlan.updates.some(u => u._id === "tool"), false);
    assert.equal(toolPlan.actor, skillActor); assert.equal(toolPlan.expectedItems, expectedToolItems);
    assert.deepEqual(toolPlan.updates, [{ _id: "tool", "system.supply.value": 2 }]);
    assert.equal(calls.writes, 1);
  }
});
