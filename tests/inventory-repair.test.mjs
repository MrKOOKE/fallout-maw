import assert from "node:assert/strict";
import test from "node:test";

import {
  planActorInventoryRepair,
  planInventoryRepair,
  validateActorNonInventoryPlacementState
} from "../src/inventory/repair.mjs";
import {
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  validateInventoryTree
} from "../src/utils/inventory-containers.mjs";
import { getEquipmentSlotSelectionKey } from "../src/utils/equipment-slots.mjs";

test("a valid plain-object inventory is already repaired", () => {
  const items = [
    createItem({ id: "left", x: 1, y: 1 }),
    createItem({ id: "right", x: 2, y: 1 })
  ];

  const plan = planInventoryRepair(items, { columns: 2, rows: 1 });

  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.repairs, []);
});

test("manual locks on valid active placements remain untouched", () => {
  const weapon = createItem({
    id: "released-weapon",
    mode: "weapon",
    locked: true,
    weaponSet: "primary",
    weaponSlot: "right"
  });

  const plan = planInventoryRepair([weapon], { columns: 2, rows: 1 });

  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.repairs, []);
  assert.equal(weapon.system.locked, true);
  assert.equal(weapon.system.placement.mode, "weapon");
});

test("manual locks in ordinary inventory remain untouched", () => {
  const plan = planInventoryRepair([
    createItem({ id: "manual-lock", locked: true })
  ], { columns: 1, rows: 1 });

  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.repairs, []);
});

test("a missing container parent is recovered to root and slot state is cleared", () => {
  const items = [createItem({
    id: "orphan",
    parentId: "deleted-container",
    mode: "weapon",
    equipped: true,
    equipmentSlot: "body",
    weaponSet: "primary",
    weaponSlot: "right",
    limbKey: "arm",
    constructPartOrder: 7,
    x: 8,
    y: 9
  })];
  const sourceSnapshot = structuredClone(items);

  const plan = planInventoryRepair(items, { columns: 2, rows: 1 });
  assert.deepEqual(items, sourceSnapshot, "planning must not mutate source documents");
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.repairs, [{
    itemId: "orphan",
    reasons: ["missing-parent"],
    targetParentId: "",
    placementMode: "inventory"
  }]);
  assert.deepEqual(plan.updates[0], {
    _id: "orphan",
    "system.equipped": false,
    "system.container.parentId": "",
    "system.placement.mode": "inventory",
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": "",
    "system.placement.constructPartOrder": 0,
    "system.placement.x": 1,
    "system.placement.y": 1,
    "system.placement.width": 1,
    "system.placement.height": 1,
    "system.placement.rotated": false
  });

  const repaired = applyUpdates(items, plan.updates);
  assert.deepEqual(
    planInventoryRepair(repaired, { columns: 2, rows: 1 }).updates,
    [],
    "running repair again must be a no-op"
  );
});

test("self-links and every member of a container cycle are detached deterministically", () => {
  const items = [
    createContainer({ id: "self", parentId: "self", x: 4 }),
    createContainer({ id: "cycle-a", parentId: "cycle-b", x: 4 }),
    createContainer({ id: "cycle-b", parentId: "cycle-a", x: 4 })
  ];

  const plan = planInventoryRepair(items, { columns: 3, rows: 1 });
  assert.deepEqual(plan.updates.map(update => update._id), [
    "self",
    "cycle-a",
    "cycle-b"
  ]);
  assert.deepEqual(plan.repairs.map(repair => [repair.itemId, repair.reasons]), [
    ["self", ["self-parent", "cycle"]],
    ["cycle-a", ["cycle"]],
    ["cycle-b", ["cycle"]]
  ]);
  assert.deepEqual(plan.updates.map(update => [
    update["system.container.parentId"],
    update["system.placement.x"],
    update["system.placement.y"]
  ]), [
    ["", 1, 1],
    ["", 2, 1],
    ["", 3, 1]
  ]);

  const repaired = applyUpdates(items, plan.updates);
  assert.deepEqual(validateInventoryTree(repaired, { columns: 3, rows: 1 }), { valid: true });
  assert.deepEqual(planInventoryRepair(repaired, { columns: 3, rows: 1 }).updates, []);
});

test("an overlapping root placement is moved while an earlier valid item stays untouched", () => {
  const items = [
    createItem({ id: "kept", x: 1, y: 1 }),
    createItem({ id: "overlap", x: 1, y: 1 })
  ];

  const plan = planInventoryRepair(items, { columns: 2, rows: 1 });

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0]._id, "overlap");
  assert.equal(plan.updates[0]["system.placement.x"], 2);
  assert.equal(plan.updates[0]["system.placement.y"], 1);
  assert.deepEqual(plan.repairs[0].reasons, ["invalid-placement"]);
  assert.deepEqual(
    planInventoryRepair(applyUpdates(items, plan.updates), { columns: 2, rows: 1 }).updates,
    []
  );
});

test("an invalid placement inside a container is made visible in root inventory", () => {
  const items = [
    createContainer({ id: "bag", x: 1, y: 1, columns: 1, rows: 1 }),
    createItem({ id: "child", parentId: "bag", x: 2, y: 1 })
  ];

  const plan = planInventoryRepair(items, { columns: 2, rows: 1 });

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0]._id, "child");
  assert.equal(plan.updates[0]["system.container.parentId"], "");
  assert.equal(plan.updates[0]["system.placement.x"], 2);
  assert.equal(plan.updates[0]["system.placement.mode"], "inventory");
  assert.deepEqual(
    planInventoryRepair(applyUpdates(items, plan.updates), { columns: 2, rows: 1 }).updates,
    []
  );
});

test("a broken but structurally retained container does not eject valid children", () => {
  const brokenContainer = createContainer({ id: "broken-bag", x: 1, y: 1 });
  brokenContainer.system.functions.condition = {
    enabled: true,
    max: 10,
    value: 0
  };
  const items = [
    brokenContainer,
    createItem({ id: "hidden-child", parentId: "broken-bag", x: 1, y: 1 })
  ];

  const plan = planInventoryRepair(items, { columns: 2, rows: 1 });

  assert.deepEqual(plan.repairs, []);
  assert.deepEqual(plan.updates, []);
});

test("plain-object special container grids use their extra zones without Foundry globals", () => {
  const container = createContainer({
    id: "modular-bag",
    x: 1,
    y: 1,
    columns: 1,
    rows: 1
  });
  container.system.functions.container = {
    enabled: true,
    specialGrids: {
      blocks: [{ x: 1, y: 0, width: 1, height: 1 }]
    }
  };
  const items = [
    container,
    createItem({ id: "extra-zone-item", parentId: "modular-bag", x: 2, y: 1 })
  ];

  assert.deepEqual(
    planInventoryRepair(items, { columns: 2, rows: 1 }).updates,
    []
  );
});

test("an overloaded container deterministically ejects later contents to visible root", () => {
  const items = [
    createContainer({
      id: "small-bag",
      x: 1,
      y: 1,
      columns: 2,
      rows: 1,
      maxLoad: 1
    }),
    createItem({ id: "kept-child", parentId: "small-bag", x: 1, y: 1, weight: 1 }),
    createItem({ id: "ejected-child", parentId: "small-bag", x: 2, y: 1, weight: 1 })
  ];

  const plan = planInventoryRepair(items, { columns: 2, rows: 1 });

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0]._id, "ejected-child");
  assert.equal(plan.updates[0]["system.container.parentId"], "");
  assert.equal(plan.updates[0]["system.placement.x"], 2);
  assert.deepEqual(plan.repairs[0].reasons, ["max-load"]);
  const repaired = applyUpdates(items, plan.updates);
  assert.deepEqual(validateInventoryTree(repaired, { columns: 2, rows: 1 }), { valid: true });
  assert.deepEqual(planInventoryRepair(repaired, { columns: 2, rows: 1 }).updates, []);
});

test("an unknown top-level placement mode is normalized before it can disappear from UI contexts", () => {
  const items = [createItem({
    id: "legacy",
    mode: "removed-slot-mode",
    equipped: true,
    x: 9,
    y: 9
  })];

  const plan = planInventoryRepair(items, { columns: 1, rows: 1 });

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0]["system.placement.mode"], "inventory");
  assert.equal(plan.updates[0]["system.equipped"], false);
  assert.deepEqual(plan.repairs[0].reasons, ["invalid-placement"]);
});

test("invalid virtual stack placements are rebuilt without changing quantity", () => {
  const items = [createItem({
    id: "stack",
    quantity: 9,
    maxStack: 5,
    x: 1,
    y: 1,
    stackParts: [
      { quantity: 5, x: 1, y: 1, rotated: false },
      { quantity: 4, x: 1, y: 1, rotated: false }
    ]
  })];

  const plan = planInventoryRepair(items, { columns: 2, rows: 1 });
  const update = plan.updates[0];

  assert.equal(update._id, "stack");
  assert.deepEqual(update["system.stackParts"], [
    { quantity: 5, x: 1, y: 1, rotated: false },
    { quantity: 4, x: 2, y: 1, rotated: false }
  ]);
  assert.equal(
    update["system.stackParts"].reduce((total, part) => total + part.quantity, 0),
    9
  );
  assert.deepEqual(
    planInventoryRepair(applyUpdates(items, plan.updates), { columns: 2, rows: 1 }).updates,
    []
  );
});

test("an infinite actor root is preferred over locked storage", () => {
  const items = [
    createItem({ id: "root-occupant", x: 1, y: 1 }),
    createItem({ id: "orphan", parentId: "gone", x: 9, y: 9 })
  ];

  const plan = planInventoryRepair(items, { columns: 1, rows: 1 }, {
    rootOptions: { allowOverflowRows: true }
  });

  assert.equal(plan.updates[0]["system.placement.mode"], "inventory");
  assert.equal(plan.updates[0]["system.placement.x"], 1);
  assert.equal(plan.updates[0]["system.placement.y"], 2);
  assert.equal(plan.repairs[0].targetParentId, "");
  assert.deepEqual(
    planInventoryRepair(applyUpdates(items, plan.updates), { columns: 1, rows: 1 }, {
      rootOptions: { allowOverflowRows: true }
    }).updates,
    []
  );
});

test("when finite root is full, repair uses visible infinite locked storage", () => {
  const items = [
    createItem({ id: "root-occupant", x: 1, y: 1 }),
    createItem({
      id: "orphan-stack",
      parentId: "gone",
      quantity: 12,
      maxStack: 5,
      x: 9,
      y: 9,
      stackParts: [
        { quantity: 5 },
        { quantity: 5 },
        { quantity: 2 }
      ]
    })
  ];

  const plan = planInventoryRepair(items, { columns: 1, rows: 1 });
  const update = plan.updates[0];

  assert.equal(plan.repairs[0].targetParentId, LOCKED_STORAGE_PARENT_ID);
  assert.equal(plan.repairs[0].placementMode, LOCKED_STORAGE_PLACEMENT_MODE);
  assert.equal(update["system.container.parentId"], "");
  assert.equal(update["system.placement.mode"], LOCKED_STORAGE_PLACEMENT_MODE);
  assert.equal(update["system.equipped"], false);
  assert.deepEqual(update["system.stackParts"], [
    { quantity: 5, x: 1, y: 1, rotated: false },
    { quantity: 5, x: 1, y: 2, rotated: false },
    { quantity: 2, x: 1, y: 3, rotated: false }
  ]);
  assert.equal(plan.lockedStorage.rows, 3);

  const repaired = applyUpdates(items, plan.updates);
  assert.deepEqual(
    planInventoryRepair(repaired, { columns: 1, rows: 1 }).updates,
    []
  );
});

test("the actor adapter accepts injected display utilities and plain actor data", async () => {
  const actor = {
    system: {
      inventory: { columns: 2, rows: 1 },
      trade: { infiniteInventory: false }
    },
    items: [
      createItem({ id: "orphan", parentId: "missing", x: 7, y: 7 })
    ]
  };
  const calls = [];
  const plan = await planActorInventoryRepair(actor, {}, {
    actorDisplayUtilities: {
      getActorInventoryGridDimensions(receivedActor) {
        calls.push(["dimensions", receivedActor]);
        return receivedActor.system.inventory;
      },
      getActorRootInventoryGridOptions(receivedActor, parentId) {
        calls.push(["options", receivedActor, parentId]);
        return { allowOverflowRows: Boolean(receivedActor.system.trade.infiniteInventory) };
      }
    }
  });

  assert.equal(plan.updates.length, 1);
  assert.deepEqual(calls.map(call => [call[0], call[2]]), [
    ["dimensions", undefined],
    ["options", ""]
  ]);
});

test("the actor adapter recovers stale and duplicate non-inventory slot assignments", async () => {
  const equipmentSelectionKey = getEquipmentSlotSelectionKey("Body");
  const equipped = createItem({
    id: "equipped",
    mode: "equipment",
    equipped: true,
    equipmentSlot: "body"
  });
  equipped.system.occupiedSlots = { [equipmentSelectionKey]: true };
  const duplicateEquipment = structuredClone(equipped);
  duplicateEquipment._id = "duplicate-equipment";
  const actor = {
    type: "character",
    system: {
      inventory: { columns: 4, rows: 1 },
      trade: { infiniteInventory: false },
      limbs: {
        arm: { label: "Arm" }
      }
    },
    items: [
      equipped,
      duplicateEquipment,
      createItem({ id: "prosthesis", mode: "prosthesis", limbKey: "arm", equipped: true }),
      createItem({ id: "duplicate-prosthesis", mode: "prosthesis", limbKey: "arm", equipped: true }),
      createItem({ id: "missing-limb-implant", mode: "implant", limbKey: "removed-limb", equipped: true }),
      createItem({ id: "removed-weapon-set", mode: "weapon", weaponSet: "removed", weaponSlot: "slot" })
    ]
  };
  const race = {
    equipmentSlots: [{ key: "body", label: "Body" }],
    weaponSets: []
  };

  const plan = await planActorInventoryRepair(actor, race, {
    actorDisplayUtilities: {
      getActorInventoryGridDimensions: () => actor.system.inventory,
      getActorRootInventoryGridOptions: () => ({ allowOverflowRows: false })
    }
  });

  assert.deepEqual(plan.updates.map(update => update._id), [
    "duplicate-equipment",
    "duplicate-prosthesis",
    "missing-limb-implant",
    "removed-weapon-set"
  ]);
  assert.equal(plan.updates.every(update => update["system.placement.mode"] === "inventory"), true);
  assert.equal(plan.updates.every(update => update["system.equipped"] === false), true);
});

test("duplicate construct-part slots cannot leave an unreachable second Item", async () => {
  const first = createItem({
    id: "part-a",
    mode: "constructPart",
    limbKey: "part-slot"
  });
  first.system.functions.constructPart = { enabled: true, partType: "arm" };
  const duplicate = structuredClone(first);
  duplicate._id = "part-b";
  const actor = {
    type: "construct",
    system: {
      inventory: { columns: 2, rows: 1 },
      trade: { infiniteInventory: false }
    },
    items: [first, duplicate]
  };

  const plan = await planActorInventoryRepair(actor, {}, {
    actorDisplayUtilities: {
      getActorInventoryGridDimensions: () => actor.system.inventory,
      getActorRootInventoryGridOptions: () => ({ allowOverflowRows: false })
    }
  });

  assert.deepEqual(plan.updates.map(update => update._id), ["part-b"]);
  assert.equal(plan.updates[0]["system.placement.mode"], "inventory");
});

test("canonical natural race weapons use their system-owned pseudo-slots", () => {
  const naturalWeapon = createItem({
    id: "natural-weapon",
    mode: "weapon",
    weaponSet: "naturalRaceWeapons",
    weaponSlot: "natural-source"
  });
  naturalWeapon.system.weaponSlotRequirement = {
    mode: "oneOf",
    slots: {}
  };
  naturalWeapon.flags = {
    "fallout-maw": {
      naturalRaceItem: {
        kind: "weapon",
        sourceId: "natural-source"
      }
    }
  };
  const actor = {
    type: "character",
    system: {},
    items: [naturalWeapon]
  };

  assert.deepEqual(
    validateActorNonInventoryPlacementState(actor, actor.items),
    { valid: true }
  );
});

function createItem({
  id,
  type = "gear",
  parentId = "",
  mode = "inventory",
  equipped = false,
  locked = false,
  equipmentSlot = "",
  weaponSet = "",
  weaponSlot = "",
  limbKey = "",
  constructPartOrder = 0,
  x = 1,
  y = 1,
  width = 1,
  height = 1,
  rotated = false,
  quantity = 1,
  maxStack = 1,
  stackParts = [],
  weight = 0
} = {}) {
  return {
    _id: id,
    type,
    system: {
      quantity,
      maxStack,
      stackParts,
      weight,
      equipped,
      locked,
      itemFunction: "",
      functions: {},
      container: {
        parentId
      },
      placement: {
        mode,
        equipmentSlot,
        weaponSet,
        weaponSlot,
        limbKey,
        constructPartOrder,
        x,
        y,
        width,
        height,
        rotated
      }
    }
  };
}

function createContainer({
  id,
  parentId = "",
  x = 1,
  y = 1,
  width = 1,
  height = 1,
  columns = 1,
  rows = 1,
  maxLoad = 100
} = {}) {
  const item = createItem({ id, parentId, x, y, width, height });
  item.system.itemFunction = "container";
  item.system.container = {
    parentId,
    columns,
    rows,
    maxLoad
  };
  return item;
}

function applyUpdates(items, updates) {
  const result = structuredClone(items);
  const byId = new Map(result.map(item => [String(item._id ?? item.id), item]));
  for (const update of updates) {
    const item = byId.get(String(update._id));
    assert.ok(item, `missing item ${update._id}`);
    for (const [path, value] of Object.entries(update)) {
      if (path === "_id") continue;
      setProperty(item, path, structuredClone(value));
    }
  }
  return result;
}

function setProperty(object, path, value) {
  const parts = String(path).split(".");
  const property = parts.pop();
  const target = parts.reduce((entry, part) => (entry[part] ??= {}), object);
  target[property] = value;
}
