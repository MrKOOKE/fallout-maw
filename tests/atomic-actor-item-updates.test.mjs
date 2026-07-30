import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  documents: { modifyBatch: async () => [] },
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => "initial-id"
  }
};

const { executeAtomicActorItemUpdates } = await import(
  "../src/utils/atomic-actor-item-updates.mjs"
);

test("Actor and Item dotted paths commit in one batch with isolated options and chainRef", async () => {
  const patient = createActor("patient", { health: 20, untouched: 11 });
  const healer = createActor("healer", { health: 50 });
  const tool = addItem(healer, "doctor-bag", { supply: 12, label: "bag" });
  const calls = [];
  installFoundryMock([patient, healer], async operations => {
    calls.push(cloneOperations(operations));
    return applyBatchOperations(operations, [patient, healer]);
  });
  const chainRef = { rootId: "medicine-root", leaseId: "lease" };

  const result = await executeAtomicActorItemUpdates([
    {
      document: patient,
      updates: { "system.resources.health.value": 35 },
      documentOptions: { falloutMawSkipDamageStatusSync: true }
    },
    {
      document: tool,
      updates: { "system.functions.medical.supply": 7 },
      documentOptions: { falloutMawLimitedUses: true }
    }
  ], {
    reason: "medicine-step",
    chainRef,
    documentOptions: {
      sharedOption: "shared",
      action: "delete",
      diff: true,
      render: false
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map(operation => operation.documentName), ["Actor", "Item"]);
  for (const operation of calls[0]) {
    assert.equal(operation.action, "update");
    assert.equal(operation.diff, false);
    assert.equal(operation.sharedOption, "shared");
    assert.deepEqual(operation.chainRef, chainRef);
    assert.deepEqual(operation.falloutMawSystemEventChainRef, chainRef);
    assert.equal(operation.falloutMawAtomicLeafReason, "medicine-step");
  }
  assert.deepEqual(calls[0].map(operation => operation.render), [true, true]);
  assert.equal(calls[0][0].falloutMawSkipDamageStatusSync, true);
  assert.equal(calls[0][0].falloutMawLimitedUses, undefined);
  assert.equal(calls[0][1].falloutMawLimitedUses, true);
  assert.equal(calls[0][1].falloutMawSkipDamageStatusSync, undefined);
  assert.equal(patient.system.resources.health.value, 35);
  assert.equal(patient.system.resources.untouched, 11);
  assert.equal(tool.system.functions.medical.supply, 7);
  assert.equal(tool.system.functions.medical.label, "bag");
  assert.equal(result.operationId, "atomic-leaf-operation-success");
});

test("self-treatment renders only the final Actor-owned operation", async () => {
  const actor = createActor("self", { health: 20 });
  const tool = addItem(actor, "self-tool", { supply: 5 });
  const calls = [];
  installFoundryMock([actor], async operations => {
    calls.push(cloneOperations(operations));
    return applyBatchOperations(operations, [actor]);
  });

  await executeAtomicActorItemUpdates([
    {
      document: actor,
      updates: { "system.resources.health.value": 25 }
    },
    {
      document: tool,
      updates: { "system.functions.medical.supply": 4 }
    }
  ]);

  assert.deepEqual(calls[0].map(operation => operation.render), [false, true]);
  assert.equal(actor.system.resources.health.value, 25);
  assert.equal(tool.system.functions.medical.supply, 4);
});

test("a queued plan rejects stale touched leaves but ignores unrelated Actor fields", async () => {
  const actor = createActor("queued", { health: 10, untouched: 1 });
  let releaseFirst;
  let announceFirst;
  const firstStarted = new Promise(resolve => { announceFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let calls = 0;
  installFoundryMock([actor], async operations => {
    calls += 1;
    if (calls === 1) {
      announceFirst();
      await firstGate;
    }
    return applyBatchOperations(operations, [actor]);
  }, ["first", "stale"]);

  const first = executeAtomicActorItemUpdates({
    document: actor,
    updates: { "system.resources.health.value": 15 }
  });
  await firstStarted;
  const stale = executeAtomicActorItemUpdates({
    document: actor,
    updates: { "system.resources.health.value": 20 }
  });
  actor.system.resources.untouched = 9;
  releaseFirst();

  await first;
  await assert.rejects(stale, error => error?.code === "atomic-leaf-stale");
  assert.equal(calls, 1);
  assert.equal(actor.system.resources.health.value, 15);
  assert.equal(actor.system.resources.untouched, 9);
});

test("a partial commit restores only written leaves and preserves unrelated state", async () => {
  const patient = createActor("partial-patient", { health: 20, untouched: 1 });
  const healer = createActor("partial-healer", { health: 50 });
  const tool = addItem(healer, "partial-tool", { supply: 8, label: "original" });
  const calls = [];
  let callIndex = 0;
  installFoundryMock([patient, healer], async operations => {
    calls.push(cloneOperations(operations));
    callIndex += 1;
    if (callIndex === 1) {
      const result = applyBatchOperations([operations[0]], [patient, healer]);
      patient.system.resources.untouched = 99;
      return [result[0], []];
    }
    return applyBatchOperations(operations, [patient, healer]);
  });

  await assert.rejects(
    executeAtomicActorItemUpdates([
      {
        document: patient,
        updates: { "system.resources.health.value": 30 }
      },
      {
        document: tool,
        updates: { "system.functions.medical.supply": 3 }
      }
    ]),
    error => error?.code === "atomic-leaf-partial-batch"
  );

  assert.equal(callIndex, 2);
  assert.equal(patient.system.resources.health.value, 20);
  assert.equal(patient.system.resources.untouched, 99);
  assert.equal(tool.system.functions.medical.supply, 8);
  assert.equal(calls[1].length, 1, "only the committed Actor leaf needs compensation");
  assert.deepEqual(Object.keys(calls[1][0].updates[0]).sort(), [
    "_id",
    "system.resources.health.value"
  ]);
  assert.equal(calls[1][0].falloutMawAtomicLeafRecovery, true);
});

test("a short Foundry response is accepted when every exact target path was committed", async () => {
  const actor = createActor("short", { health: 10, untouched: 2 });
  installFoundryMock([actor], async operations => {
    applyBatchOperations(operations, [actor]);
    return [];
  });

  await executeAtomicActorItemUpdates({
    document: actor,
    updates: { "system.resources.health.value": 12 }
  });

  assert.equal(actor.system.resources.health.value, 12);
});

test("whole branches, deletion operators and overlapping paths are rejected before Foundry", async () => {
  const actor = createActor("invalid", { health: 10 });
  let calls = 0;
  installFoundryMock([actor], async operations => {
    calls += 1;
    return applyBatchOperations(operations, [actor]);
  });

  await assert.rejects(
    executeAtomicActorItemUpdates({ document: actor, updates: { system: {} } }),
    /safe dotted path/
  );
  await assert.rejects(
    executeAtomicActorItemUpdates({ document: actor, updates: { "system.resources.-=health": null } }),
    /safe dotted path/
  );
  await assert.rejects(
    executeAtomicActorItemUpdates({
      document: actor,
      updates: {
        "system.resources.health": { value: 12 },
        "system.resources.health.value": 12
      }
    }),
    /overlap/
  );
  assert.equal(calls, 0);
});

function installFoundryMock(actors, modifyBatch, randomIds = ["operation-success"]) {
  const ids = [...randomIds];
  globalThis.foundry = {
    documents: { modifyBatch },
    utils: {
      deepClone: value => structuredClone(value),
      randomID: () => ids.shift() ?? "fallback-id"
    }
  };
}

function createActor(id, { health = 0, untouched = 0 } = {}) {
  const contents = [];
  return {
    id,
    uuid: `Actor.${id}`,
    documentName: "Actor",
    system: {
      resources: {
        health: { value: health },
        untouched
      }
    },
    items: {
      contents,
      get(itemId) {
        return contents.find(item => String(item.id ?? item._id) === String(itemId));
      }
    }
  };
}

function addItem(actor, id, { supply = 0, label = "" } = {}) {
  const item = {
    id,
    _id: id,
    uuid: `${actor.uuid}.Item.${id}`,
    documentName: "Item",
    parent: actor,
    system: {
      functions: {
        medical: { supply, label }
      }
    }
  };
  actor.items.contents.push(item);
  return item;
}

function applyBatchOperations(operations, actors) {
  return operations.map(operation => operation.updates.map(update => {
    const document = operation.documentName === "Actor"
      ? actors.find(actor => actor.id === update._id)
      : operation.parent.items.get(update._id);
    assert.ok(document, `missing ${operation.documentName} ${update._id}`);
    applyUpdate(document, update);
    return document;
  }));
}

function applyUpdate(document, update) {
  for (const [path, value] of Object.entries(update)) {
    if (path === "_id") continue;
    const deletionPath = parseDeletionPath(path);
    if (deletionPath) unsetProperty(document, deletionPath);
    else setProperty(document, path, structuredClone(value));
  }
}

function setProperty(object, path, value) {
  const parts = String(path).split(".");
  const key = parts.pop();
  const target = parts.reduce((entry, part) => (entry[part] ??= {}), object);
  target[key] = value;
}

function unsetProperty(object, path) {
  const parts = String(path).split(".");
  const key = parts.pop();
  const target = parts.reduce((entry, part) => entry?.[part], object);
  if (target && key) delete target[key];
}

function parseDeletionPath(path) {
  const parts = String(path).split(".");
  const index = parts.findIndex(part => part.startsWith("-="));
  if (index < 0) return "";
  return [...parts.slice(0, index), parts[index].slice(2)].join(".");
}

function cloneOperations(operations) {
  return operations.map(operation => {
    const clone = { ...operation, updates: structuredClone(operation.updates) };
    delete clone.parent;
    return clone;
  });
}
