import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    getProperty,
    hasProperty,
    mergeObject,
    randomID: () => "fallback-id",
    setProperty
  }
};
globalThis.Actor = class Actor {};

const { DROPPED_ITEMS_TESTING } = await import("../src/items/dropped-items.mjs");
const { validateActorInventoryState } = await import("../src/inventory/mutation.mjs");
const { getItemFootprint } = await import("../src/utils/inventory-containers.mjs");

test("a filled dropped container is placed by its expanded footprint and keeps its item tree", () => {
  const randomIds = ["dropped-backpack", "dropped-child"];
  foundry.utils.randomID = () => randomIds.shift() ?? "unexpected-id";
  const actor = createActor([
    createItem({ id: "existing-loot", x: 3 })
  ]);
  const backpack = createContainer({ id: "source-backpack" });
  const child = createItem({
    id: "source-child",
    parentId: "source-backpack",
    x: 3,
    quantity: 3,
    maxStack: 5
  });

  const creates = DROPPED_ITEMS_TESTING.buildDroppedContainerCreateData(
    actor,
    backpack,
    [child]
  );

  assert.equal(creates.length, 2);
  assert.equal(creates[0]._id, "dropped-backpack");
  assert.equal(creates[0].system.placement.x, 4);
  assert.equal(creates[0].system.placement.y, 1);
  assert.deepEqual(getItemFootprint(creates[0], creates), {
    width: 3,
    height: 1
  });
  assert.equal(creates[1]._id, "dropped-child");
  assert.equal(creates[1].system.container.parentId, "dropped-backpack");
  assert.equal(creates[1].system.placement.x, 3);
  assert.deepEqual(creates[1].system.stackParts, [{
    quantity: 3,
    x: 3,
    y: 1,
    rotated: false
  }]);
  assert.doesNotThrow(() => validateActorInventoryState(
    actor,
    [...actor.items.contents, ...creates],
    { validateLoad: false }
  ));
});

function createActor(items = []) {
  return {
    id: "dropped-loot-actor",
    uuid: "Actor.dropped-loot-actor",
    documentName: "Actor",
    type: "construct",
    system: {
      creature: { raceId: "" },
      inventory: { columns: 6, rows: 2 },
      trade: { infiniteInventory: true },
      load: { limit: 0, limitPercent: 0, max: 0, value: 0 }
    },
    items: {
      contents: structuredClone(items)
    }
  };
}

function createItem({
  id,
  parentId = "",
  x = 1,
  y = 1,
  quantity = 1,
  maxStack = 1
} = {}) {
  return {
    _id: id,
    id,
    type: "gear",
    name: id,
    system: {
      quantity,
      maxStack,
      stackParts: maxStack > 1 ? [{ quantity, x, y, rotated: false }] : [],
      itemFunction: "",
      functions: {},
      container: { parentId },
      placement: {
        mode: "inventory",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        limbKey: "",
        x,
        y,
        width: 1,
        height: 1,
        rotated: false
      }
    }
  };
}

function createContainer({ id } = {}) {
  const item = createItem({ id });
  item.system.itemFunction = "container";
  item.system.functions.container = { enabled: true };
  item.system.container = {
    parentId: "",
    columns: 3,
    rows: 1,
    maxLoad: 100
  };
  return item;
}

function getProperty(object, path) {
  return String(path).split(".").reduce((entry, key) => entry?.[key], object);
}

function hasProperty(object, path) {
  return getProperty(object, path) !== undefined;
}

function setProperty(object, path, value) {
  const parts = String(path).split(".");
  const key = parts.pop();
  const target = parts.reduce((entry, part) => (entry[part] ??= {}), object);
  target[key] = value;
  return true;
}

function mergeObject(target, source, { inplace = true } = {}) {
  return merge(inplace ? target : structuredClone(target), structuredClone(source));
}

function merge(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (isPlainObject(value) && isPlainObject(target[key])) merge(target[key], value);
    else target[key] = value;
  }
  return target;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
