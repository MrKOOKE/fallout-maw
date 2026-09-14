import assert from "node:assert/strict";
import test from "node:test";

globalThis.game = {
  settings: {
    get() {
      throw new Error("use defaults");
    }
  }
};

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  documents: { modifyBatch: async () => [] },
  utils: {
    deepClone: value => structuredClone(value),
    getProperty,
    hasProperty: (object, path) => getProperty(object, path) !== undefined,
    mergeObject,
    randomID: () => "test-id",
    setProperty,
    unsetProperty
  }
};

const { planOwnedInventoryItemInInventoryFast } = await import("../src/inventory/movement.mjs");
const { planActorInventoryGrant } = await import("../src/utils/inventory-grants.mjs");
const { findFirstAvailableResolvedInventoryPlacement, normalizeInventoryPlacement } = await import("../src/utils/inventory-containers.mjs");

test("a simple owned Item reposition produces exactly one placement update", () => {
  const actor = createActor([createItem({ id: "moving", x: 1 })]);
  const item = actor.items.get("moving");
  const update = planOwnedInventoryItemInInventoryFast(actor, item, {
    mode: "inventory",
    x: 4,
    y: 2,
    width: 1,
    height: 1,
    rotated: false
  }, { quantity: 1 });

  assert.equal(update._id, "moving");
  assert.equal(update["system.placement.x"], 4);
  assert.equal(update["system.placement.y"], 2);
  assert.equal(update["system.container.parentId"], "");
  assert.equal(update["system.placement.mode"], "inventory");
});

test("a quick move validates the automatically chosen rotation and commits it in the same placement update", () => {
  const rifle = createItem({ id: "rifle" });
  rifle.system.placement.width = 4;
  rifle.system.placement.height = 2;
  const actor = createActor([rifle]);
  actor.system.inventory = { columns: 2, rows: 4 };
  const placement = findFirstAvailableResolvedInventoryPlacement([], 2, 4, rifle);
  const update = planOwnedInventoryItemInInventoryFast(actor, rifle, placement);
  assert.equal(update["system.placement.rotated"], true);
  assert.equal(update["system.placement.width"], 4);
  assert.equal(update["system.placement.height"], 2);
  assert.equal(rifle.system.placement.rotated, false);
});

test("ordinary grants persist the chosen rotation for individual items and virtual stacks", () => {
  for (const maxStack of [1, 10]) {
    const rifle = createItem({ id: "rifle", maxStack });
    rifle.system.placement.width = 4;
    rifle.system.placement.height = 2;
    const actor = createActor([]);
    actor.createEmbeddedDocuments = () => { throw new Error("planning must not write"); };
    actor.system.inventory = { columns: 2, rows: maxStack === 1 ? 4 : 8 };
    const plan = planActorInventoryGrant(actor, rifle, { quantity: maxStack === 1 ? 1 : 20, merge: false });
    const created = plan.creates[0];
    assert.deepEqual([created.system.placement.width, created.system.placement.height, created.system.placement.rotated], [4, 2, true]);
    const displayed = normalizeInventoryPlacement(created.system.placement, created);
    assert.deepEqual([displayed.width, displayed.height], [2, 4]);
    if (maxStack === 10) assert.deepEqual(created.system.stackParts.map(p => p.rotated), [true, true]);
    assert.equal(rifle.system.placement.rotated, false);
  }
});

test("the fast path refuses an occupied destination and leaves it to the generic planner", () => {
  const actor = createActor([
    createItem({ id: "moving", x: 1 }),
    createItem({ id: "blocker", x: 2 })
  ]);
  const update = planOwnedInventoryItemInInventoryFast(actor, actor.items.get("moving"), {
    mode: "inventory",
    x: 2,
    y: 1,
    width: 1,
    height: 1,
    rotated: false
  }, { quantity: 1 });

  assert.equal(update, null);
});

test("the fast path refuses partial moves and recursive container placement", () => {
  const stackActor = createActor([createItem({ id: "stack", x: 1, quantity: 3 })]);
  assert.equal(planOwnedInventoryItemInInventoryFast(stackActor, stackActor.items.get("stack"), {
    mode: "inventory",
    x: 2,
    y: 1,
    width: 1,
    height: 1,
    rotated: false
  }, { quantity: 1 }), null);

  const container = createContainer({ id: "outer", x: 1 });
  const child = createContainer({ id: "inner", parentId: "outer", x: 1 });
  const containerActor = createActor([container, child]);
  assert.equal(planOwnedInventoryItemInInventoryFast(containerActor, containerActor.items.get("outer"), {
    mode: "inventory",
    x: 2,
    y: 1,
    width: 1,
    height: 1,
    rotated: false
  }, { parentId: "inner", quantity: 1 }), null);
});

function createActor(items) {
  const actor = {
    id: "actor",
    uuid: "Actor.actor",
    documentName: "Actor",
    system: {
      creature: { raceId: "" },
      inventory: { columns: 8, rows: 8 },
      load: { limit: 0, limitPercent: 0, max: 0, value: 0 },
      trade: { infiniteInventory: false }
    }
  };
  const contents = items;
  actor.items = {
    contents,
    get(id) {
      return contents.find(item => item.id === String(id));
    }
  };
  for (const item of contents) item.parent = actor;
  return actor;
}

function createItem({ id, parentId = "", x = 1, y = 1, quantity = 1, maxStack = 1 } = {}) {
  const item = {
    _id: id,
    id,
    documentName: "Item",
    type: "gear",
    name: id,
    system: {
      quantity,
      maxStack,
      weight: 0,
      functions: {},
      container: { parentId },
      placement: {
        mode: "inventory",
        x,
        y,
        width: 1,
        height: 1,
        rotated: false
      }
    },
    toObject() {
      const { parent: _parent, toObject: _toObject, ...data } = this;
      return structuredClone(data);
    }
  };
  return item;
}

function createContainer(options = {}) {
  const item = createItem(options);
  item.system.functions.container = { enabled: true };
  item.system.container = {
    parentId: String(options.parentId ?? ""),
    columns: 4,
    rows: 4,
    maxLoad: 100
  };
  return item;
}

function getProperty(object, path) {
  return String(path).split(".").reduce((value, key) => value?.[key], object);
}

function setProperty(object, path, value) {
  const parts = String(path).split(".");
  const key = parts.pop();
  const target = parts.reduce((entry, part) => (entry[part] ??= {}), object);
  target[key] = value;
  return true;
}

function unsetProperty(object, path) {
  const parts = String(path).split(".");
  const key = parts.pop();
  const target = parts.reduce((entry, part) => entry?.[part], object);
  return target && key ? delete target[key] : false;
}

function mergeObject(target, source, { inplace = true } = {}) {
  const output = inplace ? target : structuredClone(target);
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = mergeObject(output[key] ?? {}, value);
    } else output[key] = structuredClone(value);
  }
  return output;
}
