import assert from "node:assert/strict";
import test from "node:test";
import {
  getUnchangedItemSystemField,
  withUnchangedActorItemSources
} from "../src/documents/item-model-initialization.mjs";

class ItemModel {
  static schema = {};
  static constructions = 0;
  static validations = 0;

  constructor(source, { parent } = {}) {
    ItemModel.constructions += 1;
    this._source = source;
    this.parent = parent;
    this.schema = this.constructor.schema;
    this.invalid = false;
    ItemModel.validations += 1;
    if (source.quantity < 0) throw new Error("quantity must be non-negative");
    this.reset();
  }

  reset() {
    this.quantity = this._source.quantity;
    this.functions = structuredClone(this._source.functions);
    this.tags = new Set(this._source.tags);
  }

  prepareBaseData() {
    this.quantity += this.parent.parent.resourceBonus;
  }
}

class TypeDataField {
  persisted = true;
  readonly = false;

  getModelForType(type) {
    return CONFIG.Item.dataModels[type];
  }

  initialize(source, item) {
    const Model = this.getModelForType(item._source.type);
    return new Model(source, { parent: item });
  }
}

globalThis.foundry = {
  data: { fields: { TypeDataField } },
  utils: { deepClone: value => structuredClone(value) }
};
globalThis.CONFIG = { Item: { dataModels: { gear: ItemModel } } };
const supportedModels = new Set([ItemModel]);
const field = new TypeDataField();
const resourceDiff = { system: { resources: { health: { spent: 5 } } } };

function createItem(actor = { items: { _initialized: true }, resourceBonus: 0 }) {
  const item = {
    parent: actor,
    _source: {
      type: "gear",
      system: { quantity: 2, functions: { condition: { value: 100 } }, tags: ["source"] }
    },
    effectSource: { expired: false, change: 3 },
    effectInitializations: 0,
    preparations: 0
  };
  item.system = getUnchangedItemSystemField(item, field, supportedModels).initialize(item._source.system, item);
  return item;
}

function initializeAndPrepare(item, { useAdapter = true, systemField = field } = {}) {
  const selected = useAdapter ? getUnchangedItemSystemField(item, systemField, supportedModels) : systemField;
  item.system = selected.initialize(item._source.system, item, {});
  // Like Foundry, the Item's effect field is initialized independently and
  // its preparation runs after the Item's system preparation.
  item.effect = structuredClone(item.effectSource);
  item.effectInitializations += 1;
  item.system.prepareBaseData();
  if (!item.effect.expired) item.system.quantity += item.effect.change;
  item.preparations += 1;
  return item.system;
}

function initializeParentItems(items, options) {
  const actor = items[0].parent;
  const initialized = actor.items._initialized;
  actor.items._initialized = false;
  try {
    for (const item of items) initializeAndPrepare(item, options);
  } finally {
    actor.items._initialized = initialized;
  }
}

function preparedData(item) {
  return {
    quantity: item.system.quantity,
    functions: item.system.functions,
    tags: Array.from(item.system.tags),
    effect: item.effect
  };
}

test("Actor commit and parent resets preserve native preparation/effect results", () => {
  const optimized = createItem();
  const reference = createItem();
  const prior = optimized.system;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    optimized.parent.resourceBonus = reference.parent.resourceBonus = iteration;
    optimized.system.functions.condition.value = -999;
    optimized.system.tags.add("prepared-only");
    optimized.effectSource.expired = reference.effectSource.expired = iteration === 2;
    const reset = () => initializeParentItems([optimized]);
    if (iteration % 2) reset(); // Item/Effect CRUD takes this parent-reset path.
    else withUnchangedActorItemSources(optimized.parent, resourceDiff, reset);
    initializeParentItems([reference], { useAdapter: false });
    assert.deepEqual(preparedData(optimized), preparedData(reference));
    assert.equal(optimized.system, prior);
    assert.equal(optimized._source.system.functions.condition.value, 100);
  }
  assert.equal(optimized.effectInitializations, 4);
  assert.equal(optimized.preparations, 4);
});

test("a large unchanged inventory avoids repeated model construction and validation", () => {
  const actor = { items: { _initialized: true }, resourceBonus: 0 };
  const items = Array.from({ length: 1000 }, () => createItem(actor));
  const constructions = ItemModel.constructions;
  const validations = ItemModel.validations;
  withUnchangedActorItemSources(actor, resourceDiff, () => initializeParentItems(items));
  initializeParentItems(items);
  assert.equal(ItemModel.constructions, constructions);
  assert.equal(ItemModel.validations, validations);
  assert.ok(items.every(item => item.effectInitializations === 2 && item.preparations === 2));
});

test("system-only Actor arrays and native operator shapes preserve Item validation", () => {
  const item = createItem();
  const model = item.system;
  class Replacement { constructor(value) { this.value = value; } }
  for (const diff of [
    { ...resourceDiff, _stats: { modifiedTime: 10000, lastModifiedBy: "gm-id" } },
    { system: { researches: [{ id: "research", progress: 1 }] } },
    { system: { limbs: { arm: { damageAccumulation: new Replacement({ fire: 10 }) } } } },
    { system: new Replacement({ resources: {} }) },
    { system: { resources: { "-=health": null } } },
    { system: {} }
  ]) {
    withUnchangedActorItemSources(item.parent, diff, () => initializeParentItems([item]));
    assert.equal(item.system, model);
  }
});

test("direct Item updates and explicit resets retain full initialization and validation", () => {
  const item = createItem();
  const initial = item.system;
  initializeAndPrepare(item);
  assert.notEqual(item.system, initial);

  withUnchangedActorItemSources(item.parent, resourceDiff, () => {
    item.parent.items._initialized = true;
    const previous = item.system;
    item._source.system.quantity = 4;
    initializeAndPrepare(item);
    assert.notEqual(item.system, previous);
    assert.equal(item.system.quantity, 7);
    const updated = item.system;
    initializeParentItems([item]);
    assert.equal(item.system, updated, "a direct Item update refreshes the certified source");
    item._source.system.quantity = -1;
    assert.throws(() => initializeAndPrepare(item), /non-negative/);
  });
});

test("Actor item/effect commits reuse unchanged children and validate changed children", () => {
  const unchanged = createItem();
  const changed = createItem(unchanged.parent);
  const unchangedModel = unchanged.system;
  for (const diff of [
    { items: [{ _id: "item", system: { quantity: 4 } }] },
    { effects: [{ _id: "effect", disabled: true }] },
    { type: "construct", ...resourceDiff },
    { ...resourceDiff, items: [] },
    {}
  ]) {
    const changedModel = changed.system;
    changed._source.system.functions.condition.value -= 1;
    withUnchangedActorItemSources(unchanged.parent, diff, () => initializeParentItems([unchanged, changed]));
    assert.equal(unchanged.system, unchangedModel);
    assert.notEqual(changed.system, changedModel);
    assert.equal(changed.system.functions.condition.value, changed._source.system.functions.condition.value);
  }
});

test("in-place nested changes, additions, deletions and array edits invalidate snapshots", () => {
  const item = createItem();
  for (const mutate of [
    source => { source.functions.condition.value = 50; },
    source => { source.tags.push("new-tag"); },
    source => { source.tags[0] = "different-tag"; },
    source => { source.extra = undefined; },
    source => { delete source.extra; source.other = undefined; },
    source => { delete source.other; }
  ]) {
    const previous = item.system;
    mutate(item._source.system);
    withUnchangedActorItemSources(item.parent, resourceDiff, () => initializeParentItems([item]));
    assert.notEqual(item.system, previous);
    const refreshed = item.system;
    initializeParentItems([item]);
    assert.equal(item.system, refreshed);
  }
});

test("invalid source changes still fail validation and clear old snapshot certification", () => {
  const item = createItem();
  const previous = item.system;
  item._source.system.quantity = -1;
  assert.throws(() => initializeParentItems([item]), /non-negative/);
  item._source.system.quantity = 2;
  initializeParentItems([item]);
  assert.notEqual(item.system, previous, "repair after failed initialization requires native validation");
});

test("unknown models and custom fields are never certified for reuse", () => {
  class OtherModel extends ItemModel {}
  const unknownField = new (class extends TypeDataField {})();
  const customSelector = new TypeDataField();
  customSelector.getModelForType = () => OtherModel;
  for (const systemField of [unknownField, customSelector]) {
    const item = createItem();
    assert.equal(getUnchangedItemSystemField(item, systemField, supportedModels), systemField);
    const previous = item.system;
    initializeParentItems([item], { systemField });
    assert.notEqual(item.system, previous);
    const customModel = item.system;
    initializeParentItems([item]);
    assert.notEqual(item.system, customModel, "returning to the native field must establish new certification");
  }
  const item = createItem();
  CONFIG.Item.dataModels.gear = OtherModel;
  try {
    assert.equal(getUnchangedItemSystemField(item, field, supportedModels), field);
    const previous = item.system;
    initializeParentItems([item]);
    assert.ok(item.system instanceof OtherModel);
    assert.notEqual(item.system, previous);
  } finally {
    CONFIG.Item.dataModels.gear = ItemModel;
  }
});

test("changed schema/source/parent, invalid and externally replaced models fall back", () => {
  for (const mutate of [
    item => { item.system.invalid = true; },
    item => { item.system.schema = {}; },
    item => { item._source.system = structuredClone(item._source.system); },
    item => { item.system.parent = {}; },
    item => { item.system = new ItemModel(item._source.system, { parent: item }); }
  ]) {
    const item = createItem();
    mutate(item);
    const previous = item.system;
    initializeParentItems([item]);
    assert.notEqual(item.system, previous);
  }
});

test("changing between supported Item types reconstructs and certifies the new model", () => {
  class AbilityModel extends ItemModel { static schema = {}; }
  CONFIG.Item.dataModels.ability = AbilityModel;
  supportedModels.add(AbilityModel);
  try {
    const item = createItem();
    const gear = item.system;
    item._source.type = "ability";
    initializeParentItems([item]);
    assert.notEqual(item.system, gear);
    assert.ok(item.system instanceof AbilityModel);
    const ability = item.system;
    initializeParentItems([item]);
    assert.equal(item.system, ability);
  } finally {
    delete CONFIG.Item.dataModels.ability;
    supportedModels.delete(AbilityModel);
  }
});

test("snapshot cloning failure preserves native initialization and disables reuse", () => {
  const item = createItem();
  const deepClone = foundry.utils.deepClone;
  foundry.utils.deepClone = () => { throw new Error("unsupported source"); };
  try {
    initializeAndPrepare(item);
    const native = item.system;
    initializeParentItems([item]);
    assert.notEqual(item.system, native);
    assert.equal(item.system.quantity, 5);
  } finally {
    foundry.utils.deepClone = deepClone;
  }
});

test("callable source values cannot reuse native cloning's shared function references", () => {
  const item = createItem();
  const deepClone = foundry.utils.deepClone;
  // Native Foundry deepClone preserves functions by reference, even strict.
  foundry.utils.deepClone = value => {
    const { callback, ...data } = value;
    return { ...structuredClone(data), callback };
  };
  try {
    item._source.system.callback = Object.assign(() => {}, { value: 1 });
    initializeAndPrepare(item);
    const previous = item.system;
    item._source.system.callback.value = 2;
    initializeParentItems([item]);
    assert.notEqual(item.system, previous);
  } finally {
    foundry.utils.deepClone = deepClone;
  }
});

test("nested Actor scopes and exceptions do not suppress direct Item initialization", () => {
  const item = createItem();
  let initial = item.system;
  assert.throws(() => withUnchangedActorItemSources(item.parent, resourceDiff, () => {
    initializeAndPrepare(item);
    assert.notEqual(item.system, initial);
    initial = item.system;
    withUnchangedActorItemSources(item.parent, { items: [] }, () => initializeParentItems([item]));
    assert.equal(item.system, initial);
    throw new Error("outer failed");
  }), /outer failed/);
  initializeAndPrepare(item);
  assert.notEqual(item.system, initial);
});
