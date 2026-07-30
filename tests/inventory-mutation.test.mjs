import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  documents: {
    modifyBatch: async () => []
  },
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject: mergeObject,
    randomID: () => "initial-id",
    setProperty,
    unsetProperty
  }
};

const {
  executeInventoryMutation,
  expandInventoryDeleteIds,
  normalizeInventoryMutationPlans
} = await import("../src/inventory/mutation.mjs");
const {
  INVENTORY_ATOMIC_OPTION,
  INVENTORY_EXPECTED_IDS_OPTION
} = await import("../src/inventory/constants.mjs");

test("create-tree ids are allocated up front and descendant parent ids are remapped", () => {
  const actor = createActor("tree-target", [
    createItem({ id: "source-container", x: 1 })
  ]);
  const sourceCreates = [
    createContainer({ id: "source-container", x: 2 }),
    createItem({ id: "source-child", parentId: "source-container", x: 1 })
  ];
  installFoundryMock({ randomIds: ["destination-container", "destination-child"] });

  const [plan] = normalizeInventoryMutationPlans({
    actor,
    creates: sourceCreates
  });

  assert.deepEqual(
    plan.creates.map(item => item._id),
    ["destination-container", "destination-child"]
  );
  assert.equal(
    plan.creates[1].system.container.parentId,
    "destination-container"
  );
  assert.equal(plan.createIdMap.get("source-container"), "destination-container");
  assert.equal(plan.createIdMap.get("source-child"), "destination-child");
  assert.equal(
    sourceCreates[1].system.container.parentId,
    "source-container",
    "normalization must not mutate caller-owned create data"
  );
});

test("delete expansion includes the complete descendant closure", () => {
  const items = [
    createContainer({ id: "container" }),
    createItem({ id: "child", parentId: "container" }),
    createItem({ id: "grandchild", parentId: "child" }),
    createItem({ id: "unrelated", x: 2 })
  ];

  assert.deepEqual(
    expandInventoryDeleteIds(items, ["container"]),
    ["container", "child", "grandchild"]
  );
});

test("a successful mutation commits update, delete and create in one Foundry batch", async () => {
  const actor = createActor("success", [
    createItem({ id: "updated", x: 1 }),
    createItem({ id: "deleted", x: 2 })
  ]);
  const calls = [];
  installFoundryMock({
    randomIds: ["created-copy", "operation-success"],
    modifyBatch: async operations => {
      calls.push(structuredCloneBatch(operations));
      return applyBatchOperations(operations);
    }
  });

  const result = await executeInventoryMutation({
    actor,
    updates: [{
      _id: "updated",
      "system.placement.x": 2
    }],
    deletes: ["deleted"],
    creates: [createItem({ id: "created", x: 1 })]
  }, {
    reason: "mutation-test",
    documentOptions: {
      falloutMawSystemEventChainRef: "test-chain",
      action: "must-not-override",
      diff: true,
      render: false,
      [INVENTORY_ATOMIC_OPTION]: false
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map(operation => operation.action), [
    "update",
    "delete",
    "create"
  ]);
  for (const operation of calls[0]) {
    assert.equal(operation[INVENTORY_ATOMIC_OPTION], true);
    assert.equal(operation.falloutMawInventoryReason, "mutation-test");
    assert.equal(operation.falloutMawSystemEventChainRef, "test-chain");
  }
  assert.deepEqual(
    calls[0].map(operation => operation[INVENTORY_EXPECTED_IDS_OPTION]),
    [["updated"], ["deleted"], ["created-copy"]]
  );
  assert.equal(calls[0][0].diff, false, "callers cannot re-enable diff for atomic inventory updates");
  assert.deepEqual(
    actor.items.contents.map(item => [
      item._id,
      item.system.placement.x
    ]),
    [["updated", 2], ["created-copy", 1]]
  );
  assert.equal(result.operationId, "inventory-operation-success");
  assert.equal(result.createdDocuments[0], actor.items.get("created-copy"));
});

test("an incomplete batch result compensates a partially committed cross-actor transfer", async () => {
  const sourceSnapshot = createItem({ id: "transferred", x: 1 });
  const sourceActor = createActor("source", [sourceSnapshot]);
  const targetActor = createActor("target");
  const calls = [];
  let callIndex = 0;
  installFoundryMock({
    randomIds: ["transferred-copy", "operation-partial"],
    modifyBatch: async operations => {
      calls.push(structuredCloneBatch(operations));
      callIndex += 1;
      if (callIndex === 1) {
        assert.deepEqual(operations.map(operation => operation.action), [
          "delete",
          "create"
        ]);
        const [deleted] = applyBatchOperations([operations[0]]);
        assert.equal(sourceActor.items.get("transferred"), undefined);
        assert.equal(targetActor.items.get("transferred-copy"), undefined);
        return [deleted, []];
      }
      return applyBatchOperations(operations);
    }
  });

  await assert.rejects(
    executeInventoryMutation([
      {
        actor: sourceActor,
        deletes: ["transferred"]
      },
      {
        actor: targetActor,
        creates: [createItem({ id: "transferred", x: 1 })]
      }
    ], {
      reason: "partial-transfer-test"
    }),
    /did not fully persist the requested state: Foundry did not persist every created inventory Item/
  );

  assert.equal(calls.length, 2, "one recovery batch must follow the failed batch");
  assert.deepEqual(calls[1].map(operation => operation.action), [
    "create"
  ]);
  assert.equal(
    calls[1].every(operation => operation.falloutMawInventoryRecovery === true),
    true
  );
  assert.equal(
    calls[1].every(operation => operation[INVENTORY_ATOMIC_OPTION] === true),
    true
  );
  assert.deepEqual(sourceActor.items.get("transferred"), sourceSnapshot);
  assert.equal(targetActor.items.get("transferred-copy"), undefined);
});

test("a short batch response is accepted when the exact requested state was committed", async () => {
  const actor = createActor("short-committed", [
    createItem({ id: "moved", x: 1 })
  ]);
  let batchCalls = 0;
  installFoundryMock({
    randomIds: ["operation-short-committed"],
    modifyBatch: async operations => {
      batchCalls += 1;
      applyBatchOperations(operations);
      return [];
    }
  });

  await executeInventoryMutation({
    actor,
    updates: [{ _id: "moved", "system.placement.x": 2 }]
  }, { reason: "short-committed" });

  assert.equal(batchCalls, 1, "a committed operation must not run compensation");
  assert.equal(actor.items.get("moved").system.placement.x, 2);
});

test("a no-op Item update omitted by Foundry does not become a false inventory failure", async () => {
  const actor = createActor("omitted-no-op", [
    createItem({ id: "stationary", x: 1 })
  ]);
  let batchCalls = 0;
  installFoundryMock({
    randomIds: ["operation-omitted-no-op"],
    modifyBatch: async operations => {
      batchCalls += 1;
      assert.equal(operations[0].diff, false);
      return [];
    }
  });

  await executeInventoryMutation({
    actor,
    updates: [{ _id: "stationary", "system.placement.x": 1 }]
  }, { reason: "omitted-no-op" });

  assert.equal(batchCalls, 1);
  assert.equal(actor.items.get("stationary").system.placement.x, 1);
});

test("a nominally complete response is rejected when an explicit Item field was not persisted", async () => {
  const actor = createActor("wrong-update-state", [
    createItem({ id: "moved", x: 1 })
  ]);
  let batchCalls = 0;
  installFoundryMock({
    randomIds: ["operation-wrong-update-state"],
    modifyBatch: async operations => {
      batchCalls += 1;
      return operations.map(operation => operation.updates.map(update => actor.items.get(update._id)));
    }
  });

  await assert.rejects(
    executeInventoryMutation({
      actor,
      updates: [{ _id: "moved", "system.placement.x": 2 }]
    }, { reason: "wrong-update-state" }),
    /did not persist Item "moved" inventory field "system\.placement\.x"/
  );

  assert.equal(batchCalls, 1, "an unchanged Actor does not need compensation");
  assert.equal(actor.items.get("moved").system.placement.x, 1);
});

test("inventory Items and Actor currency fields commit in the same Foundry batch", async () => {
  const actor = createActor("actor-fields", [
    createItem({ id: "kept", x: 1 })
  ]);
  actor.system.currencies.caps = 10;
  actor.parent = { actor };
  const calls = [];
  installFoundryMock({
    randomIds: ["operation-actor-fields"],
    modifyBatch: async operations => {
      calls.push(structuredCloneBatch(operations));
      return applyBatchOperations(operations);
    }
  });

  await executeInventoryMutation({
    actor,
    updates: [{ _id: "kept", "system.placement.x": 2 }],
    actorUpdates: { "system.currencies.caps": 7 }
  }, { reason: "trade-payment" });

  assert.deepEqual(calls[0].map(operation => [
    operation.action,
    operation.documentName
  ]), [
    ["update", "Item"],
    ["update", "Actor"]
  ]);
  assert.equal(calls[0][1][INVENTORY_ATOMIC_OPTION], undefined);
  assert.equal(calls[0][1][INVENTORY_EXPECTED_IDS_OPTION], undefined);
  assert.equal(calls[0][0].diff, false);
  assert.equal(calls[0][1].diff, false);
  assert.equal(actor.system.currencies.caps, 7);
  assert.equal(actor.items.get("kept").system.placement.x, 2);
});

test("an incomplete Actor result restores both currency and inventory Items", async () => {
  const actor = createActor("actor-recovery", [
    createItem({ id: "spent", x: 1 })
  ]);
  actor.system.currencies.caps = 10;
  actor.parent = { actor };
  let callIndex = 0;
  installFoundryMock({
    randomIds: ["operation-actor-recovery"],
    modifyBatch: async operations => {
      callIndex += 1;
      if (callIndex === 1) {
        const [deleted] = applyBatchOperations([operations[0]]);
        return [deleted, []];
      }
      return applyBatchOperations(operations);
    }
  });

  await assert.rejects(
    executeInventoryMutation({
      actor,
      deletes: ["spent"],
      actorUpdates: { "system.currencies.caps": 5 }
    }, { reason: "trade-recovery" }),
    /did not fully persist the requested state: Foundry did not persist Actor inventory field/
  );

  assert.equal(callIndex, 2);
  assert.equal(actor.system.currencies.caps, 10);
  assert.ok(actor.items.get("spent"));
});

test("a partial medicine limb batch restores both patient state and medical-tool supply", async () => {
  const instrument = createItem({ id: "doctor-bag" });
  instrument.system.functions.tools = {
    medical: {
      enabled: true,
      supply: { value: 12, max: 20 }
    }
  };
  const healer = createActor("medicine-healer", [instrument]);
  const patient = createActor("medicine-patient");
  patient.system.limbs = {
    arm: {
      value: 20,
      min: 0,
      max: 80,
      spent: 60,
      damageAccumulation: { ballistic: 30, fire: 10 }
    }
  };
  patient.system.resources = {
    health: { value: 20, max: 80, spent: 60 },
    consciousness: { value: 0, max: 100 }
  };
  patient.parent = { actor: patient };
  const beforePatient = structuredClone(patient.system);
  const beforeInstrument = structuredClone(healer.items.get("doctor-bag").system);
  const batches = [];
  let callIndex = 0;
  installFoundryMock({
    randomIds: ["medicine-limb-operation"],
    modifyBatch: async operations => {
      batches.push(structuredCloneBatch(operations));
      callIndex += 1;
      const results = applyBatchOperations(operations);
      if (callIndex !== 1) return results;

      assert.equal(patient.system.limbs.arm.value, 45);
      assert.equal(healer.items.get("doctor-bag").system.functions.tools.medical.supply.value, 7);
      patient.system.resources.consciousness.value = 0;
      return results;
    }
  });

  await assert.rejects(
    executeInventoryMutation([
      {
        actor: patient,
        actorUpdates: [{
          "system.limbs.arm.value": 45,
          "system.limbs.arm.spent": 35,
          "system.limbs.arm.damageAccumulation": { ballistic: 5 },
          "system.resources.health.value": 45,
          "system.resources.health.spent": 35,
          "system.resources.consciousness.value": 25
        }]
      },
      {
        actor: healer,
        updates: [{
          _id: "doctor-bag",
          "system.functions.tools.medical.supply.value": 7
        }]
      }
    ], {
      reason: "medicine-treatment-with-tool",
      documentOptions: {
        falloutMawSkipDamageStatusSync: true,
        falloutMawLimbCapSync: true
      }
    }),
    /did not persist Actor inventory field/
  );

  assert.equal(callIndex, 2, "one compensation batch must follow the partial medicine commit");
  assert.deepEqual(patient.system, beforePatient);
  assert.deepEqual(healer.items.get("doctor-bag").system, beforeInstrument);
  assert.ok(
    batches[1].some(operation => operation.documentName === "Actor" && operation.falloutMawInventoryRecovery),
    "the complete coupled limb state must be restored as one Actor recovery update"
  );
  assert.ok(
    batches[1].some(operation => operation.documentName === "Item" && operation.falloutMawInventoryRecovery),
    "the spent medical supply must be restored in the same recovery batch"
  );
});

test("a queued stale plan is rejected without undoing the mutation ahead of it", async () => {
  const actor = createActor("serialized", [
    createItem({ id: "moving", x: 1 })
  ]);
  let releaseFirst;
  let announceFirst;
  const firstStarted = new Promise(resolve => {
    announceFirst = resolve;
  });
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let batchCalls = 0;
  installFoundryMock({
    randomIds: ["operation-first", "operation-stale"],
    modifyBatch: async operations => {
      batchCalls += 1;
      if (batchCalls === 1) {
        announceFirst();
        await firstGate;
      }
      return applyBatchOperations(operations);
    }
  });

  const first = executeInventoryMutation({
    actor,
    updates: [{ _id: "moving", "system.placement.x": 2 }]
  }, { reason: "first-move" });
  await firstStarted;
  const stale = executeInventoryMutation({
    actor,
    updates: [{ _id: "moving", "system.placement.x": 2 }]
  }, { reason: "stale-move" });
  releaseFirst();

  await first;
  await assert.rejects(stale, error => error?.code === "inventory-stale");
  assert.equal(batchCalls, 1, "the stale operation must not reach Foundry or recovery");
  assert.equal(actor.items.get("moving").system.placement.x, 2);
});

test("a missing source Item aborts a cross-actor transfer before any create", async () => {
  const sourceActor = createActor("missing-source");
  const targetActor = createActor("missing-target");
  let batchCalls = 0;
  installFoundryMock({
    randomIds: ["should-not-be-used"],
    modifyBatch: async operations => {
      batchCalls += 1;
      return applyBatchOperations(operations);
    }
  });

  await assert.rejects(
    executeInventoryMutation([
      {
        actor: sourceActor,
        deletes: ["already-removed"]
      },
      {
        actor: targetActor,
        creates: [createItem({ id: "already-removed", x: 1 })]
      }
    ], { reason: "stale-cross-actor-transfer" }),
    error => error?.code === "inventory-stale"
  );

  assert.equal(batchCalls, 0);
  assert.equal(targetActor.items.contents.length, 0);
});

test("updates for unknown Item ids are rejected instead of silently ignored", async () => {
  const actor = createActor("missing-update");
  let batchCalls = 0;
  installFoundryMock({
    modifyBatch: async operations => {
      batchCalls += 1;
      return applyBatchOperations(operations);
    }
  });

  await assert.rejects(
    executeInventoryMutation({
      actor,
      updates: [{ _id: "missing", "system.quantity": 2 }]
    }),
    error => error?.code === "inventory-stale"
  );
  assert.equal(batchCalls, 0);
});

test("duplicate source ids in one create tree are rejected as ambiguous", () => {
  const actor = createActor("duplicate-create-ids");
  installFoundryMock({ randomIds: ["first", "second"] });

  assert.throws(
    () => normalizeInventoryMutationPlans({
      actor,
      creates: [
        createContainer({ id: "duplicate" }),
        createItem({ id: "duplicate", parentId: "duplicate" })
      ]
    }),
    /duplicate source Item ID/
  );
});

test("the transaction core rejects an unknown placement mode before it can hide an Item", async () => {
  const actor = createActor("unknown-placement", [
    createItem({ id: "visible", x: 1 })
  ]);
  let batchCalls = 0;
  installFoundryMock({
    modifyBatch: async operations => {
      batchCalls += 1;
      return applyBatchOperations(operations);
    }
  });

  await assert.rejects(
    executeInventoryMutation({
      actor,
      updates: [{
        _id: "visible",
        "system.placement.mode": "removed-ui-mode"
      }]
    }),
    error => error?.code === "invalid-placement"
  );

  assert.equal(batchCalls, 0);
  assert.equal(actor.items.get("visible").system.placement.mode, "inventory");
});

test("a legacy Actor with a canonical natural weapon can still move ordinary inventory Items", async () => {
  const naturalWeapon = createItem({ id: "natural-weapon" });
  naturalWeapon.flags = {
    "fallout-maw": {
      naturalRaceItem: {
        kind: "weapon",
        sourceId: "natural-source"
      }
    }
  };
  naturalWeapon.system.equipped = false;
  naturalWeapon.system.placement = {
    mode: "weapon",
    equipmentSlot: "",
    weaponSet: "naturalRaceWeapons",
    weaponSlot: "natural-source",
    limbKey: "",
    constructPartOrder: 0,
    x: 1,
    y: 1,
    width: 1,
    height: 1,
    rotated: false
  };
  naturalWeapon.system.weaponSlotRequirement = {
    mode: "oneOf",
    slots: {}
  };
  const actor = createActor("legacy-natural-weapon", [
    naturalWeapon,
    createItem({ id: "moving", x: 1 })
  ]);
  actor.type = "character";
  installFoundryMock({
    randomIds: ["operation-natural-weapon"],
    modifyBatch: async operations => applyBatchOperations(operations)
  });

  await executeInventoryMutation({
    actor,
    updates: [{
      _id: "moving",
      "system.placement.x": 2
    }]
  }, { reason: "move" });

  assert.equal(actor.items.get("moving").system.placement.x, 2);
  assert.equal(actor.items.get("natural-weapon").system.placement.weaponSet, "naturalRaceWeapons");
});

test("an explicit repair snapshot prevents a stale plan from overwriting a user move", async () => {
  const actor = createActor("stale-repair", [
    createItem({ id: "moved-by-user", x: 1 })
  ]);
  const expectedItems = structuredClone(actor.items.contents);
  actor.items.get("moved-by-user").system.placement.x = 3;
  let batchCalls = 0;
  installFoundryMock({
    modifyBatch: async operations => {
      batchCalls += 1;
      return applyBatchOperations(operations);
    }
  });

  await assert.rejects(
    executeInventoryMutation({
      actor,
      expectedItems,
      updates: [{ _id: "moved-by-user", "system.placement.x": 2 }]
    }, { reason: "inventory-repair" }),
    error => error?.code === "inventory-stale"
  );

  assert.equal(batchCalls, 0);
  assert.equal(actor.items.get("moved-by-user").system.placement.x, 3);
});

function installFoundryMock({ randomIds = [], modifyBatch } = {}) {
  const ids = [...randomIds];
  globalThis.foundry = {
    documents: {
      modifyBatch: modifyBatch ?? (async operations => applyBatchOperations(operations))
    },
    utils: {
      deepClone: value => structuredClone(value),
      mergeObject,
      randomID: () => ids.shift() ?? "fallback-id",
      setProperty,
      unsetProperty
    }
  };
}

function createActor(id, items = []) {
  const contents = structuredClone(items);
  return {
    id,
    uuid: `Actor.${id}`,
    documentName: "Actor",
    system: {
      creature: { raceId: "" },
      inventory: { columns: 8, rows: 8 },
      load: { limit: 0, limitPercent: 0, max: 0, value: 0 },
      trade: { infiniteInventory: false },
      currencies: {}
    },
    items: {
      contents,
      get(itemId) {
        return contents.find(item => String(item.id ?? item._id) === String(itemId));
      }
    }
  };
}

function createItem({
  id,
  type = "gear",
  parentId = "",
  x = 1,
  y = 1
} = {}) {
  return {
    _id: id,
    type,
    name: id,
    system: {
      quantity: 1,
      maxStack: 1,
      stackParts: [],
      weight: 0,
      itemFunction: "",
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
    }
  };
}

function createContainer({
  id,
  parentId = "",
  x = 1,
  y = 1
} = {}) {
  const item = createItem({ id, parentId, x, y });
  item.system.itemFunction = "container";
  item.system.functions.container = { enabled: true };
  item.system.container = {
    parentId,
    columns: 2,
    rows: 2,
    maxLoad: 100
  };
  return item;
}

function applyBatchOperations(operations) {
  return operations.map(operation => {
    if (operation.documentName === "Actor") {
      const actor = operation.parent?.actor;
      assert.ok(actor, "missing synthetic Actor operation parent");
      return operation.updates.map(update => {
        applyUpdate(actor, update);
        return actor;
      });
    }
    const contents = operation.parent.items.contents;
    if (operation.action === "update") {
      return operation.updates.map(update => {
        const item = operation.parent.items.get(update._id);
        assert.ok(item, `missing update target ${update._id}`);
        applyUpdate(item, update);
        return item;
      });
    }
    if (operation.action === "delete") {
      return operation.ids.map(itemId => {
        const index = contents.findIndex(item => String(item.id ?? item._id) === String(itemId));
        assert.notEqual(index, -1, `missing delete target ${itemId}`);
        return contents.splice(index, 1)[0];
      });
    }
    if (operation.action === "create") {
      return operation.data.map(data => {
        const item = structuredClone(data);
        contents.push(item);
        return item;
      });
    }
    throw new Error(`unsupported batch action ${operation.action}`);
  });
}

function applyUpdate(item, update) {
  for (const [path, value] of Object.entries(update)) {
    if (path === "_id") continue;
    if (path.includes(".")) setProperty(item, path, structuredClone(value));
    else if (isPlainObject(value) && isPlainObject(item[path])) {
      merge(item[path], structuredClone(value));
    } else item[path] = structuredClone(value);
  }
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
  if (!target || !key) return false;
  return delete target[key];
}

function merge(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (isPlainObject(value) && isPlainObject(target[key])) merge(target[key], value);
    else target[key] = value;
  }
  return target;
}

function mergeObject(target, source, { inplace = true } = {}) {
  return merge(inplace ? target : structuredClone(target), structuredClone(source));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function structuredCloneBatch(operations) {
  return operations.map(operation => {
    const clone = { ...operation };
    delete clone.parent;
    if (operation.updates) clone.updates = structuredClone(operation.updates);
    if (operation.ids) clone.ids = [...operation.ids];
    if (operation.data) clone.data = structuredClone(operation.data);
    return clone;
  });
}
