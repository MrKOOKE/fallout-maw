import assert from "node:assert/strict";
import test from "node:test";

let sequence = 0;
const mergeObject = (target, source, { inplace = true } = {}) => {
  const result = inplace ? target : structuredClone(target);
  for (const [key, value] of Object.entries(source ?? {})) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeObject(result[key] ?? {}, value) : structuredClone(value);
  }
  return result;
};
const setProperty = (object, key, value) => {
  const parts = key.split("."); const last = parts.pop();
  for (const part of parts) object = object[part] ??= {};
  object[last] = value;
};
globalThis.foundry = { applications: { api: { ApplicationV2: class {}, DialogV2: class {} },
  ux: { FormDataExtended: class {} }, handlebars: { HandlebarsApplicationMixin: Base => Base } },
  utils: { deepClone: structuredClone, mergeObject, setProperty, randomID: () => String(++sequence).padStart(16, "0") } };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2, OWNER: 3 } };
const actors = new Map(); const folders = [];
const user = { id: "gm", isGM: true };
globalThis.game = { user, users: new Map([[user.id, user]]), actors, folders,
  settings: { get: () => undefined }, i18n: { localize: key => key } };
globalThis.Folder = { async create(data) {
  await Promise.resolve(); const folder = { ...data, id: foundry.utils.randomID() };
  folders.push(folder); return folder;
} };
globalThis.Actor = class {
  static async create(data) {
    const actor = Object.assign(new Actor(), structuredClone(data));
    actor.id = foundry.utils.randomID(); actor.uuid = `Actor.${actor.id}`;
    actor.items = Object.assign([], { contents: [] });
    actor.getFlag = (scope, key) => actor.flags?.[scope]?.[key];
    actors.set(actor.id, actor); return actor;
  }
};
globalThis.fromUuid = async uuid => actors.get(uuid.split(".").at(-1));
const { DROPPED_ITEMS_TESTING } = await import("../src/items/dropped-items.mjs");
const { getActorInventoryGridDimensions, getActorRootInventoryGridOptions } = await import("../src/utils/actor-inventory-size.mjs");
const { validateInventoryTree } = await import("../src/utils/inventory-containers.mjs");
function tile(id, entries = []) {
  const result = { id, parent: { id: "scene" }, flags: { "fallout-maw": { droppedItems: { items: entries, actorUuid: "" } } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; }, async update(data) {
      for (const [key, value] of Object.entries(data)) setProperty(this, key, structuredClone(value));
    } };
  return result;
}
const entry = (id, quantity = 1, width = 1, height = 1) => ({ entryId: id, quantity, containedItems: [],
  itemData: { _id: id, name: id, type: "gear", system: { quantity, maxStack: 10,
    container: { parentId: "", columns: width, rows: height }, placement: { mode: "inventory", x: 1, y: 1, width, height }, functions: {} } } });

test("simultaneous loot piles share the Actor folder hierarchy", async () => {
  folders.push({ id: "unrelated", type: "Item", name: "Предметы на земле", folder: null });
  const created = await Promise.all([1, 2].map(id => DROPPED_ITEMS_TESTING.createDroppedItemsActor(tile(String(id)), user.id)));
  const parent = folders.find(folder => folder.type === "Actor" && folder.name === "Предметы на земле");
  const logs = folders.find(folder => folder.name === "логи" && folder.folder === parent.id);
  assert.equal(folders.filter(folder => folder.type === "Actor").length, 2);
  assert.ok(created.every(actor => actor.folder === logs.id && actor.system.trade.infiniteInventory));
  await DROPPED_ITEMS_TESTING.createDroppedItemsActor(tile("third"), user.id);
  assert.equal(folders.length, 3);
});

test("loot materialization packs stacks and filled containers into a zero-size construct", async () => {
  const actor = await DROPPED_ITEMS_TESTING.createDroppedItemsActor(tile("packing"), user.id);
  const entries = [entry("stack", 25, 2, 3), entry("bag", 1, 2, 2)];
  entries[1].itemData.system.functions.container = { enabled: true };
  entries[1].itemData.system.container.maxLoad = 100;
  entries[1].containedItems = [{ ...entry("child", 1).itemData,
    system: { ...entry("child", 1).itemData.system, container: { parentId: "bag", columns: 1, rows: 1 } } }];
  const creates = DROPPED_ITEMS_TESTING.buildDroppedItemCreateData(actor, entries);
  assert.equal(creates.length, 3);
  const stack = creates.find(item => item.name === "stack");
  assert.deepEqual(stack.system.stackParts.map(part => part.quantity), [10, 10, 5]);
  const bag = creates.find(item => item.name === "bag");
  const child = creates.find(item => item.name === "child");
  assert.equal(child.system.container.parentId, bag._id);
  assert.notEqual(bag._id, "bag");
  assert.equal(validateInventoryTree(creates, getActorInventoryGridDimensions(actor),
    { rootOptions: getActorRootInventoryGridOptions(actor) }).valid, true);
});

test("failed materialization retains entries and reuses the linked loot actor on retry", async () => {
  const pile = tile("oversized", [entry("large", 1, 11, 11)]);
  const actorCount = actors.size;
  const originalItems = structuredClone(pile.getFlag("fallout-maw", "droppedItems").items);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(DROPPED_ITEMS_TESTING.ensureDroppedItemsActorForTile(pile, user.id), /нет места/);
    assert.equal(actors.size, actorCount + 1);
    assert.deepEqual(pile.getFlag("fallout-maw", "droppedItems").items, originalItems);
    assert.ok(pile.getFlag("fallout-maw", "droppedItems").actorUuid);
  }
});
