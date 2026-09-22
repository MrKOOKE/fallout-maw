import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { getCraftDisassemblyYield, scaleCraftDisassemblyOutputs, getCraftEmbeddedItems, getCraftEmbeddedReturns, planCraftEmbeddedCreation } from "../src/utils/craft-item-resources.mjs";

const gear = (id, functions = {}, quantity = 1) => ({ id, name: id, uuid: `Item.${id}`, type: "gear", img: `${id}.png`, system: { quantity, functions } });
const ammo = gear("ammo");
const weapon = (rounds = 30, extra = {}) => gear("gun", { weapon: { enabled: true, magazine: { value: rounds, max: 30, sourceItemUuid: ammo.uuid }, ...extra } });
const options = { resolve: uuid => uuid === ammo.uuid ? ammo : null, matches: (item, uuid) => item.uuid === uuid };

test("disassembly uses supply and a linear 20–100% condition yield, rounded down", () => {
  const material = quantity => [{ sourceUuid: "Item.metal", quantity }];
  const item = gear("tool", { tools: { repair: { enabled: true, supply: { value: 0, max: 10 } } } });
  assert.equal(getCraftDisassemblyYield(item), 0);
  assert.equal(scaleCraftDisassemblyOutputs(material(9), [{ item, quantity: 1 }])[0].quantity, 0);
  item.system.functions.tools.repair.supply.value = 5;
  assert.equal(scaleCraftDisassemblyOutputs(material(9), [{ item, quantity: 1 }])[0].quantity, 4);
  item.system.functions.condition = { enabled: true, value: 0, max: 100 };
  assert.equal(scaleCraftDisassemblyOutputs(material(19), [{ item, quantity: 1 }])[0].quantity, 1);
  item.system.functions.tools.repair.supply.value = 10;
  assert.equal(scaleCraftDisassemblyOutputs(material(9), [{ item, quantity: 1 }])[0].quantity, 1);
  item.system.functions.condition.value = 50;
  assert.equal(scaleCraftDisassemblyOutputs(material(9), [{ item, quantity: 1 }])[0].quantity, 5);
  assert.equal(getCraftDisassemblyYield(gear("plain")), 1);
});

test("condition-powered tools do not apply condition twice; charges and energy keep zero", () => {
  const item = gear("tool", { condition: { enabled: true, value: 0, max: 100 }, tools: { repair: { enabled: true, consumptionMode: "condition", supply: { value: 0, max: 10 } } } });
  assert.equal(getCraftDisassemblyYield(item), 0.2);
  for (const functions of [
    { firstAid: { enabled: true, charges: { value: 0, max: 5 } } },
    { energySource: { enabled: true, reserve: { value: 0, max: 100 } } },
    { tool: { enabled: true, toolKey: "doctor" }, tools: { doctor: { enabled: false, supply: { value: 0, max: 5 } } } }
  ]) assert.equal(getCraftDisassemblyYield(gear("empty", functions)), 0);
});

test("bulk rounding matches separate attempts and mixed copies use their actual condition", () => {
  const broken = gear("broken", { condition: { enabled: true, value: 0, max: 100 } });
  const outputs = scaleCraftDisassemblyOutputs([{ quantity: 40 }], [{ item: broken, quantity: 10 }], 10);
  assert.equal(outputs[0].quantity, 0);
  assert.equal(outputs[0].fullQuantity, 40);
  const mixed = scaleCraftDisassemblyOutputs([{ quantity: 10 }], [{ item: broken, quantity: 1 }, { item: gear("intact"), quantity: 1 }]);
  assert.equal(mixed[0].quantity, 6);
  assert.equal(mixed[0].fullQuantity, 10);
});

test("crafting reserves actual ammunition after recipe materials and fills a partial magazine", () => {
  const supply = gear("ammo", {}, 17);
  const recipe = weapon();
  const before = structuredClone({ supply, recipe });
  const plan = planCraftEmbeddedCreation(recipe, [supply], { ...options, consumed: new Map([["ammo", 5]]) });
  assert.equal(plan.specs[0].data.system.functions.weapon.magazine.value, 12);
  assert.equal(plan.requirements[0].quantity, 12);
  assert.equal(plan.requirements[0].itemId, "ammo");
  assert.deepEqual(plan.chips.map(chip => [chip.quantity, chip.requested]), [[12, 30]]);
  assert.deepEqual({ supply, recipe }, before);
});

test("no ammo or disabled chip produces an empty magazine without blocking the craft", () => {
  const recipe = weapon();
  const key = getCraftEmbeddedItems(recipe, options)[0].key;
  for (const [items, selections] of [[[], {}], [[gear("ammo", {}, 50)], { [key]: false }]]) {
    const plan = planCraftEmbeddedCreation(recipe, items, { ...options, selections });
    assert.equal(plan.specs[0].data.system.functions.weapon.magazine.value, 0);
    assert.equal(plan.requirements.length, 0);
  }
});

test("multiple weapons and additional functions share ammunition without duplication", () => {
  const recipe = weapon();
  recipe.system.functions.additionalWeapons = { second: { enabled: true, magazine: { value: 5, max: 5, sourceItemUuid: ammo.uuid } } };
  const plan = planCraftEmbeddedCreation(recipe, [gear("ammo", {}, 40)], { ...options, quantity: 2 });
  assert.deepEqual(plan.specs.map(spec => [spec.data.system.functions.weapon.magazine.value, spec.data.system.functions.additionalWeapons.second.magazine.value]), [[30, 5], [5, 0]]);
  assert.equal(plan.requirements[0].quantity, 40);
});

test("installed modules and batteries are consumed and returned with their actual state", () => {
  const module = gear("module", { condition: { enabled: true, value: 7, max: 100 } });
  const battery = gear("battery", { energySource: { enabled: true, class: "B", reserve: { value: 0, max: 80 } } });
  const recipe = weapon(0, { moduleSlots: [{ id: "slot", itemUuid: module.uuid, itemData: module }] });
  recipe.system.functions.energyConsumer = { enabled: true, activeSourceUuid: battery.uuid, installedSource: { sourceItemUuid: battery.uuid, itemData: battery, reserve: { value: 80, max: 80 } } };
  const resolve = uuid => [module, battery].find(item => item.uuid === uuid);
  const plan = planCraftEmbeddedCreation(recipe, [module, battery], { ...options, resolve });
  assert.equal(plan.requirements.length, 2);
  const built = plan.specs[0].data;
  assert.equal(built.system.functions.weapon.moduleSlots[0].itemData.system.functions.condition.value, 7);
  assert.equal(built.system.functions.energyConsumer.installedSource.reserve.value, 0);
  built.system.functions.energyConsumer.installedSource.reserve.value = 13;
  const returns = getCraftEmbeddedReturns([{ item: built, quantity: 2 }], { resolve });
  assert.deepEqual(returns.map(entry => entry.quantity), [2, 2]);
  assert.equal(returns[0].data.system.functions.condition.value, 7);
  assert.equal(returns[1].data.system.functions.energySource.reserve.value, 13);
});

test("broken gun returns remaining ammunition at full quantity separately from material yield", () => {
  const item = weapon(7);
  item.system.functions.condition = { enabled: true, value: 0, max: 100 };
  const input = [{ item, quantity: 1 }];
  assert.equal(scaleCraftDisassemblyOutputs([{ quantity: 10 }], input)[0].quantity, 2);
  const returns = getCraftEmbeddedReturns(input, options);
  assert.equal(returns[0].quantity, 7);
  assert.equal(returns[0].data.flags["fallout-maw"].sourceId, ammo.uuid);
  assert.equal(getCraftEmbeddedReturns([{ item: weapon(0), quantity: 1 }], options).length, 0);
});

test("unresolved contents remain visible as errors instead of silently being lost", () => {
  const entries = getCraftEmbeddedItems(weapon(8), { resolve: () => null });
  assert.equal(entries[0].quantity, 8);
  assert.equal(entries[0].data, null);
});

test("locked inventory stacks are never spent on optional contents", () => {
  const item = gear("ammo", {}, 99); item.system.locked = true;
  const result = planCraftEmbeddedCreation(weapon(), [item], options);
  assert.equal(result.requirements.length, 0);
  assert.equal(result.specs[0].data.system.functions.weapon.magazine.value, 0);
});

const source = fs.readFileSync(new URL("../src/apps/craft-window.mjs", import.meta.url), "utf8");
function fn(name, deps) {
  const match = source.match(new RegExp(`(?:export )?((?:async )?function ${name}\\([^]*?\\n\\})`));
  assert.ok(match, name);
  return new Function(...Object.keys(deps), `${match[1]}; return ${name};`)(...Object.values(deps));
}

test("zero disassembly output never becomes one in the output planner", async () => {
  let resolved = 0;
  const getSpecs = fn("getCraftOutputSpecs", {
    CRAFT_MODE_CREATE: "craft", CRAFT_MODE_DISASSEMBLY: "disassembly", DEFAULT_CRAFT_RECIPE_ID: "recipe1",
    normalizeCraftMode: value => value, mergeCraftOutputSpecs: value => value,
    resolveWorldItemSync: () => { resolved++; return ammo; }, toInteger: Number,
    createCraftOutputItemData: item => item
  });
  assert.deepEqual(await getSpecs(null, "disassembly", [{ sourceUuid: ammo.uuid, quantity: 0 }]), []);
  assert.equal(resolved, 0);
});

function operationFixture(inventory, catalog) {
  const actor = { uuid: "Actor.test", isOwner: true, items: { contents: inventory, get: id => inventory.find(item => item.id === id) } };
  const calls = [];
  const deps = {
    CRAFT_MODE_CREATE: "craft", CRAFT_MODE_DISASSEMBLY: "disassembly", DEFAULT_CRAFT_RECIPE_ID: "recipe1", ROOT_CONTAINER_ID: "",
    resolveActor: async () => actor, resolveWorldItemSync: uuid => catalog.find(item => item.uuid === uuid),
    normalizeCraftMode: mode => mode, actorKnowsCraftItem: () => true, canUseOwnedDisassembly: () => true,
    getCraftingSettings: () => ({}), getCraftFailureRefundPercent: () => 50,
    calculateCraftConsumedQuantity: (quantity, percent) => Math.ceil(quantity * (1 - percent / 100)),
    toInteger: Number, getItemQuantity: item => item?.system.quantity ?? 0,
    getItemContainerParentId: item => item.system.container?.parentId ?? "",
    usesVirtualInventoryStacks: () => false, isNaturalRaceItem: () => false,
    getCraftAvailabilityIndex: () => ({ items: inventory.map(item => ({ item, quantity: item.system.quantity })) }),
    getIndexedCraftRequirementCandidates: (index, req) => index.items.filter(entry => req.itemId ? entry.item.id === req.itemId : entry.item.uuid === req.sourceUuid),
    createCraftToolRequirementSpendPlan: () => ({ valid: true, updates: [], deletes: [] }),
    getCraftRecipeOutputQuantity: () => 1,
    planCraftEmbeddedCreation: (recipe, items, config) => planCraftEmbeddedCreation(recipe, items, { ...options, ...config, resolve: uuid => catalog.find(item => item.uuid === uuid) }),
    getCraftEmbeddedReturns: inputs => getCraftEmbeddedReturns(inputs, { resolve: uuid => catalog.find(item => item.uuid === uuid) }),
    scaleCraftDisassemblyOutputs,
    createSourcedInventoryItemData: item => structuredClone(item.toObject?.() ?? item),
    getCraftItemFingerprint: data => JSON.stringify([data.name, data.system.functions]),
    foundry: { utils: { deepClone: structuredClone, setProperty(object, path, value) {
      const parts = path.split(".");const field = parts.pop();let target = object;
      for (const part of parts) target = target[part] ??= {};
      target[field] = value;
    } } },
    projectCraftInventoryState: () => [],
    planCraftOutputPlacement: (_actor, specs) => ({ valid: true, updates: [], creates: specs }),
    planCraftDisassemblyPlacement: (_actor, specs) => ({ valid: true, updates: [], creates: specs }),
    executeInventoryMutation: async mutation => { calls.push(mutation); },
    ui: { notifications: { warn: assert.fail } }
  };
  for (const name of ["createCraftRequirementSpendPlan", "getCraftConsumedInputs", "prepareCraftDisassemblyResources", "prepareCraftEmbeddedCreation", "createCraftOutputItemData", "mergeCraftOutputSpecs", "getCraftOutputSpecs", "createCraftFailureOutputPlan"]) deps[name] = fn(name, deps);
  return { actor, calls, run: fn("applyCraftOperation", deps), bulk: fn("applyBulkCraftOperations", deps) };
}

test("craft commit consumes partial optional ammo and gives the same magazine quantity in one mutation", async () => {
  const supply = gear("ammo", {}, 17), metal = gear("metal", {}, 2), recipe = weapon(30);
  const fixture = operationFixture([supply, metal], [ammo, metal, recipe]);
  await fixture.run({ actorUuid: fixture.actor.uuid, recipeUuid: recipe.uuid, mode: "craft", success: true,
    requirements: [{ sourceUuid: metal.uuid, quantity: 2 }, { sourceUuid: ammo.uuid, quantity: 5 }], toolRequirements: [] });
  assert.equal(fixture.calls.length, 1);
  const mutation = fixture.calls[0];
  assert.deepEqual(new Set(mutation.deletes), new Set(["metal", "ammo"]));
  assert.equal(mutation.creates[0].data.system.functions.weapon.magazine.value, 12);
  assert.equal(mutation.creates[0].quantity, 1);
});

test("craft commit keeps ammunition when its chip is disabled", async () => {
  const metal = gear("metal"), recipe = weapon();
  const fixture = operationFixture([gear("ammo", {}, 50), metal], [ammo, metal, recipe]);
  await fixture.run({ actorUuid: fixture.actor.uuid, recipeUuid: recipe.uuid, mode: "craft", success: true,
    resourceOptions: { selections: { "system.functions.weapon.magazine": false } },
    requirements: [{ sourceUuid: metal.uuid, quantity: 1 }], toolRequirements: [] });
  assert.deepEqual(fixture.calls[0].deletes, ["metal"]);
  assert.equal(fixture.calls[0].creates[0].data.system.functions.weapon.magazine.value, 0);
});

test("disassembly commit uses the chosen damaged copy and returns its real magazine", async () => {
  const recipe = weapon(), owned = weapon(7), metal = gear("metal");
  owned.id = "damaged"; owned.system.functions.condition = { enabled: true, value: 0, max: 100 };
  const other = weapon(30);other.id = "intact";
  const fixture = operationFixture([other, owned], [ammo, metal, recipe]);
  await fixture.run({ actorUuid: fixture.actor.uuid, recipeUuid: recipe.uuid, mode: "disassembly", success: true,
    requirements: [{ itemId: owned.id, sourceUuid: recipe.uuid, quantity: 1 }], toolRequirements: [], outputs: [{ sourceUuid: metal.uuid, quantity: 9 }] });
  assert.deepEqual(fixture.calls[0].deletes, ["damaged"]);
  assert.deepEqual(fixture.calls[0].creates.map(spec => [spec.data.name, spec.quantity]), [["metal", 1], ["ammo", 7]]);
});

test("bulk commit preserves per-attempt flooring and aggregates real contents once", async () => {
  const recipe = weapon(), owned = weapon(7), metal = gear("metal");
  owned.system.quantity = 10;
  owned.system.functions.condition = { enabled: true, value: 0, max: 100 };
  const fixture = operationFixture([owned], [ammo, metal, recipe]);
  await fixture.bulk(fixture.actor, [{ actorUuid: fixture.actor.uuid, recipeUuid: recipe.uuid, mode: "disassembly", success: true, repetitions: 10,
    requirements: [{ itemId: owned.id, sourceUuid: recipe.uuid, quantity: 10 }], toolRequirements: [], outputs: [{ sourceUuid: metal.uuid, quantity: 90 }] }], []);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].creates.map(spec => [spec.data.name, spec.quantity]), [["metal", 10], ["ammo", 70]]);
});

test("failed disassembly returns only contents of items actually consumed after the refund", async () => {
  const recipe = weapon(), owned = weapon(7);owned.system.quantity = 3;
  const fixture = operationFixture([owned], [ammo, recipe]);
  await fixture.run({ actorUuid: fixture.actor.uuid, recipeUuid: recipe.uuid, mode: "disassembly", success: false,
    requirements: [{ itemId: owned.id, sourceUuid: recipe.uuid, quantity: 3 }], toolRequirements: [], failureOutputs: [] });
  assert.deepEqual(fixture.calls[0].updates, [{ _id: owned.id, "system.quantity": 1 }]);
  assert.deepEqual(fixture.calls[0].creates.map(spec => [spec.data.name, spec.quantity]), [["ammo", 14]]);
});

test("a returned installed inventory module keeps its world source identity", () => {
  const module = gear("module");
  module.uuid = "Actor.old.Item.module";
  module.flags = { "fallout-maw": { sourceId: "Item.original" } };
  const recipe = weapon(0, { moduleSlots: [{ itemUuid: module.uuid, itemData: module }] });
  const [entry] = getCraftEmbeddedItems(recipe, options);
  assert.equal(entry.sourceUuid, "Item.original");
  assert.equal(entry.data.flags["fallout-maw"].sourceId, "Item.original");
});
