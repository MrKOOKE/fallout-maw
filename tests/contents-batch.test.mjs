import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { createContentsBatchRuntime } from "./helpers/contents-batch-runtime.mjs";

let nextId = 0;
const setProperty = (object, path, value) => {
  const keys = path.split("."), last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[last] = value;
};
const mergeObject = (a, b, { inplace = true } = {}) => {
  const target = inplace ? a : structuredClone(a);
  for (const [key, value] of Object.entries(b)) {
    if (key.includes(".")) setProperty(target, key, structuredClone(value));
    else if (value && typeof value === "object" && !Array.isArray(value)) target[key] = mergeObject(target[key] ?? {}, value);
    else target[key] = structuredClone(value);
  }
  return target;
};
globalThis.foundry = {
  applications: { api: { DialogV2: class {} }, ux: { FormDataExtended: class {} }, handlebars: { renderTemplate: async () => "" } },
  utils: { deepClone: structuredClone, setProperty, mergeObject, randomID: () => `generated-${++nextId}`,
    diffObject: (a, b) => isDeepStrictEqual(a, b) ? {} : structuredClone(b),
    getProperty: (o, p) => p.split(".").reduce((v, k) => v?.[k], o),
    hasProperty: (o, p) => p.split(".").reduce((v, k) => v?.[k], o) !== undefined }
};
const actors = new Map();
globalThis.Actor = class {};
globalThis.window = { setTimeout, clearTimeout };
const gm = { id: "gm", isGM: true, active: true }, player = { id: "player", isGM: false, active: true };
globalThis.game = { user: gm, actors: { get: id => actors.get(`Actor.${id}`) },
  users: { get: id => [gm, player].find(u => u.id === id), contents: [gm, player] },
  settings: { get: () => { throw new Error("use defaults"); } }, i18n: { localize: key => key } };
globalThis.fromUuidSync = uuid => actors.get(uuid);
globalThis.fromUuid = async uuid => actors.get(uuid);
const runtime = await createContentsBatchRuntime();
const { transferInventoryContentsBatch } = await import("../src/inventory/contents-batch.mjs");
const { executeInventoryMutation } = await import("../src/inventory/mutation.mjs");

function item(id, x = 1, extra = {}) {
  return { _id: id, type: "gear", name: id, img: `${id}.webp`, system: {
    quantity: 1, maxStack: 1, weight: 0, price: 0, container: { parentId: "" }, functions: {},
    placement: { mode: "inventory", x, y: 1, width: 1, height: 1, rotated: false }, ...extra
  } };
}
function actor(id, data = [], dimensions = {}) {
  const owner = { id, uuid: `Actor.${id}`, documentName: "Actor", type: "character", isOwner: true,
    system: { creature: { raceId: "" }, inventory: { columns: 8, rows: 8, ...dimensions },
      load: { limit: 0, max: 0 }, trade: {}, currencies: {} },
    testUserPermission: () => true, getFlag: () => undefined };
  Object.setPrototypeOf(owner, Actor.prototype);
  const contents = data.map(d => document(d, owner));
  owner.items = { contents, get: id => contents.find(i => i.id === id) };
  actors.set(owner.uuid, owner);
  return owner;
}
function document(data, owner) {
  const doc = structuredClone(data);
  Object.defineProperties(doc, { id: { get: () => doc._id }, parent: { value: owner },
    toObject: { value: () => structuredClone({ ...doc }) },
    getFlag: { value: (scope, key) => doc.flags?.[scope]?.[key] } });
  return doc;
}
let writes;
function installBatch() {
  writes = [];
  foundry.documents = { modifyBatch: async operations => {
    writes.push(operations);
    return operations.map(op => {
      const contents = op.parent.items.contents;
      if (op.action === "delete") return op.ids.map(id => contents.splice(contents.findIndex(i => i.id === id), 1)[0]);
      if (op.action === "create") return op.data.map(data => { const doc = document(data, op.parent); contents.push(doc); return doc; });
      if (op.action === "update") return op.updates.map(update => mergeObject(op.parent.items.get(update._id), update));
      throw new Error(`Unexpected ${op.action}`);
    });
  } };
}
const zone = (actor, parentId = "") => ({ actor, parentId, kind: "inventory" });
const move = (payload, { source, target, executeMutation }) => runtime.transferItemBetweenActors({ ...payload,
  sourceActor: source.actor, targetActor: target.actor, sourceItem: source.actor.items.get(payload.itemId),
  allowLocked: true, allowEquipmentSwap: false, executeMutation });
function transfer(source, target, options = {}) {
  return transferInventoryContentsBatch({ source, target, canTransfer: () => true, move, ...options });
}

test("twenty real item transfers make one document batch, with no intermediate writes", async () => {
  installBatch();
  const a = actor("many-a", Array.from({ length: 20 }, (_, i) => item(`item-${i}`, i % 8 + 1,
    { placement: { mode: "inventory", x: i % 8 + 1, y: Math.floor(i / 8) + 1, width: 1, height: 1 } }))), b = actor("many-b");
  const result = await transfer(zone(a), zone(b), { execute: async (plans, options) => {
    assert.equal(writes.length, 0);
    assert.equal(a.items.contents.length, 20);
    assert.equal(b.items.contents.length, 0);
    return executeInventoryMutation(plans, options);
  } });
  assert.deepEqual(result, { moved: 20, failed: 0, errors: [] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 2);
  assert.equal(a.items.contents.length, 0);
  assert.equal(b.items.contents.length, 20);
  assert.ok(writes[0].every(op => op.falloutMawContentsOperationCount === 2));
});

test("all virtual parts merge in one batch without duplication or loss", async () => {
  installBatch();
  const stack = item("ammo", 1, { quantity: 25, maxStack: 10,
    stackParts: [{ quantity: 10, x: 1, y: 1 }, { quantity: 10, x: 2, y: 1 }, { quantity: 5, x: 3, y: 1 }] });
  const a = actor("stack-a", [stack]), b = actor("stack-b");
  const result = await transfer(zone(a), zone(b));
  assert.deepEqual(result, { moved: 3, failed: 0, errors: [] });
  assert.equal(writes.length, 1);
  assert.equal(a.items.contents.length, 0);
  assert.equal(b.items.contents.length, 1);
  assert.equal(b.items.contents[0].system.quantity, 25);
  assert.equal(b.items.contents[0].system.stackParts.reduce((n, p) => n + p.quantity, 0), 25);
});

test("rejected large item stays at source while later small items commit together", async () => {
  installBatch();
  const a = actor("fit-a", [item("large", 1, { placement: { mode: "inventory", x: 1, y: 1, width: 3, height: 3 } }), item("small", 4)]);
  const b = actor("fit-b", [], { columns: 2, rows: 2 });
  const result = await transfer(zone(a), zone(b));
  assert.equal(result.moved, 1, result.errors.join("; "));
  assert.equal(result.failed, 1);
  assert.deepEqual(a.items.contents.map(i => i.name), ["large"]);
  assert.deepEqual(b.items.contents.map(i => i.name), ["small"]);
  assert.equal(writes.length, 1);
});

test("same-actor contents transfer uses preview state and rejects moving a bag into itself", async () => {
  installBatch();
  const bag = item("bag", 1, { functions: { container: { enabled: true } }, container: { parentId: "", columns: 2, rows: 2, maxLoad: 100 } });
  const a = actor("same", [bag, item("one", 2), item("two", 3)]);
  const result = await transfer(zone(a), zone(a, "bag"));
  assert.equal(result.moved, 2, result.errors.join("; "));
  assert.equal(result.failed, 1);
  assert.equal(writes.length, 1);
  assert.equal(a.items.get("one").system.container.parentId, "bag");
  assert.equal(a.items.get("two").system.container.parentId, "bag");
});

test("stale preview aborts before any write and preserves the intervening user change", async () => {
  installBatch();
  const a = actor("stale-a", [item("one")]), b = actor("stale-b");
  await assert.rejects(transfer(zone(a), zone(b), { execute: (plans, options) => {
    a.items.get("one").system.placement.x = 3;
    return executeInventoryMutation(plans, options);
  } }), error => error.code === "inventory-stale");
  assert.equal(writes.length, 0);
  assert.equal(a.items.get("one").system.placement.x, 3);
  assert.equal(b.items.contents.length, 0);
});

test("filled nested bags travel with their complete tree in the same commit", async () => {
  installBatch();
  const container = (id, parentId = "") => item(id, 1, { functions: { container: { enabled: true } },
    container: { parentId, columns: 4, rows: 4, maxLoad: 100 } });
  const a = actor("tree-a", [container("outer"), container("inner", "outer"),
    item("child", 1, { container: { parentId: "inner" } })]), b = actor("tree-b");
  const result = await transfer(zone(a), zone(b));
  assert.deepEqual(result, { moved: 1, failed: 0, errors: [] });
  assert.equal(writes.length, 1);
  assert.equal(a.items.contents.length, 0);
  const byName = Object.fromEntries(b.items.contents.map(i => [i.name, i]));
  assert.equal(byName.inner.system.container.parentId, byName.outer.id);
  assert.equal(byName.child.system.container.parentId, byName.inner.id);
});

test("load rejection leaves heavy items untouched and still transfers a lighter item", async () => {
  installBatch();
  const a = actor("load-a", [item("heavy", 1, { weight: 20 }), item("light", 2, { weight: 1 })]);
  const b = actor("load-b");
  b.system.load.limit = 5;
  const result = await transfer(zone(a), zone(b));
  assert.equal(result.moved, 1, result.errors.join("; "));
  assert.equal(result.failed, 1);
  assert.equal(a.items.contents[0].name, "heavy");
  assert.equal(b.items.contents[0].name, "light");
  assert.equal(writes.length, 1);
});

test("offering all contents builds a single state without document writes or duplicate quantities", async () => {
  installBatch();
  const a = actor("offer", [item("first"), item("ammo", 2, { quantity: 15, maxStack: 10,
    stackParts: [{ quantity: 10, x: 2, y: 1 }, { quantity: 5, x: 3, y: 1 }] })]);
  const first = await runtime.addContentsToTradeOffer({}, "searcher", a, "");
  assert.deepEqual(first.result, { moved: 3, failed: 0, errors: [] });
  assert.equal(first.offers.searcher.items.reduce((n, e) => n + e.quantity, 0), 16);
  const again = await runtime.addContentsToTradeOffer(first.offers, "searcher", a, "");
  assert.equal(again.result.moved, 0);
  assert.equal(again.offers.searcher.items.reduce((n, e) => n + e.quantity, 0), 16);
  assert.equal(writes.length, 0);
});

test("bulk planning rotates an incoming rifle to fit without changing its base dimensions", async () => {
  installBatch();
  const a = actor("rotation-a", [item("rifle", 1, { placement: { mode: "inventory", x: 1, y: 1, width: 4, height: 2, rotated: false } })]);
  const b = actor("rotation-b", [], { columns: 3, rows: 4 });
  const result = await transfer(zone(a), zone(b));
  assert.equal(result.moved, 1, result.errors.join("; "));
  assert.equal(b.items.contents[0].system.placement.rotated, true);
  assert.equal(b.items.contents[0].system.placement.width, 4);
  assert.equal(b.items.contents[0].system.placement.height, 2);
});

test("player search sends one request to the GM and receives one result for the entire contents", async () => {
  installBatch();
  const a = actor("network-a", [item("one"), item("two", 2), item("three", 3)]), b = actor("network-b");
  a.testUserPermission = user => user.isGM;
  const messages = [];
  game.socket = { emit: (_channel, message) => messages.push(message) };
  const client = await createContentsBatchRuntime(), authority = await createContentsBatchRuntime();
  game.user = player;
  try {
    const pending = client.requestInventoryContentsTransfer({ sourceActorUuid: a.uuid, targetActorUuid: b.uuid,
      searcherActorUuid: b.uuid, searchedActorUuid: a.uuid, sourceParentId: "", targetParentId: "" });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].action, "transferContents");
    assert.equal(writes.length, 0);
    game.user = gm;
    await authority.handleSearchInventorySocketMessage(messages[0]);
    assert.equal(messages.length, 2);
    game.user = player;
    await client.handleSearchInventorySocketMessage(messages[1]);
    const result = await pending;
    assert.deepEqual(result, { moved: 3, failed: 0, errors: [] });
    assert.equal(writes.length, 1);
    assert.equal(a.items.contents.length, 0);
    assert.equal(b.items.contents.length, 3);
  } finally { game.user = gm; }
});

test("GM uses the same batch authority directly without per-item socket requests", async () => {
  installBatch();
  const a = actor("gm-a", [item("one"), item("two", 2)]), b = actor("gm-b");
  let messages = 0;
  game.socket = { emit: () => messages++ };
  const result = await runtime.requestInventoryContentsTransfer({ ownedContents: true, sourceActorUuid: a.uuid,
    targetActorUuid: b.uuid, sourceParentId: "", targetParentId: "" });
  assert.deepEqual(result, { moved: 2, failed: 0, errors: [] });
  assert.equal(writes.length, 1);
  assert.equal(messages, 0);
});

test("the authority rejects an unauthorized bulk request before planning or writing", async () => {
  installBatch();
  const a = actor("denied-a", [item("one")]), b = actor("denied-b");
  a.testUserPermission = user => user.isGM;
  await assert.rejects(runtime.performInventoryContentsTransfer({ ownedContents: true, sourceActorUuid: a.uuid,
    targetActorUuid: b.uuid }, player.id), /Нет прав/);
  assert.equal(writes.length, 0);
  assert.equal(a.items.contents.length, 1);
});

test("a full destination leaves the unplaced virtual part at source with exact quantities", async () => {
  installBatch();
  const a = actor("partial-a", [item("ammo", 1, { quantity: 25, maxStack: 10,
    stackParts: [{ quantity: 10, x: 1, y: 1 }, { quantity: 10, x: 2, y: 1 }, { quantity: 5, x: 3, y: 1 }] })]);
  const b = actor("partial-b", [], { columns: 2, rows: 1 });
  const result = await transfer(zone(a), zone(b));
  assert.equal(result.moved, 2, result.errors.join("; "));
  assert.equal(result.failed, 1);
  assert.equal(a.items.contents[0].system.quantity, 10);
  assert.equal(b.items.contents[0].system.quantity, 15);
  assert.equal(writes.length, 1);
});

test("owned locked-storage transfers preserve the usual lock-on-entry and unlock-on-exit rules", async () => {
  installBatch();
  const a = actor("locked", [item("one"), item("two", 2)]);
  const into = await transfer(zone(a), zone(a, "__lockedStorage"));
  assert.equal(into.moved, 2, into.errors.join("; "));
  assert.ok(a.items.contents.every(i => i.system.placement.mode === "lockedStorage" && i.system.locked));
  const out = await transfer(zone(a, "__lockedStorage"), zone(a));
  assert.equal(out.moved, 2, out.errors.join("; "));
  assert.ok(a.items.contents.every(i => i.system.placement.mode === "inventory" && !i.system.locked));
  assert.equal(writes.length, 2);
});
