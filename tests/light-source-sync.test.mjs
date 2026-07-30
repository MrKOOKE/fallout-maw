import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value)
  },
  applications: {
    api: {
      DialogV2: class {}
    },
    ux: {
      FormDataExtended: class {}
    },
    handlebars: {
      renderTemplate: async () => ""
    }
  }
};
globalThis._del = Symbol("DELETE");

const {
  createActorLightSourceSyncQueue,
  createLightSourceItemRuntimeSignature,
  getActorLightSourceTokenDocuments,
  isLightSourceItemUpdateRelevant,
  registerLightSourceHooks,
  syncActorLightSourceTokens,
  syncTokenLightSources
} = await import("../src/items/light-source.mjs");

function createLightItem({
  id = "light",
  bright = 10,
  dim = 20,
  conditionValue = 10,
  conditionMax = 10
} = {}) {
  return {
    id,
    _id: id,
    uuid: `Actor.actor.Item.${id}`,
    name: "Light",
    system: {
      functions: {
        lightSource: {
          enabled: true,
          bright,
          dim,
          angle: 360,
          color: "#ffaa00",
          resourceCosts: []
        },
        condition: {
          enabled: true,
          value: conditionValue,
          max: conditionMax
        }
      }
    }
  };
}

function createActor(items = []) {
  const collection = new Map(items.map(item => [item.id, item]));
  collection.contents = items;
  const actor = {
    id: "actor",
    uuid: "Actor.actor",
    items: collection
  };
  for (const item of items) {
    item.actor = actor;
    item.parent = actor;
  }
  return actor;
}

function createManagedToken(actor, {
  activeEntries = [],
  baseLight = undefined,
  light = { dim: 0, bright: 0, angle: 360, color: null }
} = {}) {
  const flags = {
    activeLightSources: activeEntries,
    lightSourceBaseLight: baseLight
  };
  const updates = [];
  return {
    id: "token",
    uuid: "Scene.scene.Token.token",
    actor,
    light: { ...light },
    updates,
    getFlag(_scope, key) {
      return flags[key];
    },
    async update(changes, options) {
      updates.push({ changes, options });
    }
  };
}

test("canvas light reconciliation ignores Tokens never managed by the light runtime", async () => {
  let updates = 0;
  const token = {
    actor: {},
    light: {
      dim: 30,
      bright: 10,
      angle: 180,
      color: "#ffcc88"
    },
    getFlag() {
      return undefined;
    },
    async update() {
      updates += 1;
    }
  };

  await syncTokenLightSources(token);

  assert.equal(updates, 0);
  assert.deepEqual(token.light, {
    dim: 30,
    bright: 10,
    angle: 180,
    color: "#ffcc88"
  });
});

test("registered preUpdateItem hook carries the exact before signature into update options", () => {
  const callbacks = new Map();
  globalThis.Hooks = {
    on(name, callback) {
      const entries = callbacks.get(name) ?? [];
      entries.push(callback);
      callbacks.set(name, entries);
      return entries.length;
    }
  };
  registerLightSourceHooks();
  const item = createLightItem({ conditionValue: 5 });
  createActor([item]);
  const options = {};
  callbacks.get("preUpdateItem")[0](item, {
    "system.functions.condition.value": 4
  }, options);

  assert.equal(
    typeof options.falloutMawLightSourceBeforeSignatures?.[item.uuid],
    "string"
  );
});

test("light Item delta ignores cosmetic and standalone energy-source changes", () => {
  const item = createLightItem();
  createActor([item]);
  const energyOnly = {
    id: "battery",
    uuid: "Actor.actor.Item.battery",
    system: {
      functions: {
        energySource: {
          enabled: true,
          reserve: { value: 5, max: 10 }
        }
      }
    }
  };
  createActor([energyOnly]);

  assert.equal(isLightSourceItemUpdateRelevant(item, { name: "Renamed" }), false);
  assert.equal(isLightSourceItemUpdateRelevant(item, { system: { quantity: 2 } }), false);
  assert.equal(isLightSourceItemUpdateRelevant(energyOnly, {
    system: { functions: { energySource: { reserve: { value: 2 } } } }
  }), false);
  assert.equal(isLightSourceItemUpdateRelevant(item, {
    system: { functions: { lightSource: { bright: 25 } } }
  }), true);
});

test("condition resource exhaustion changes light availability even without condition breakage", () => {
  const item = createLightItem({ conditionValue: 1 });
  item.system.functions.condition.enabled = false;
  item.system.functions.lightSource.resourceCosts = [{
    type: "condition",
    amountPerHour: 1
  }];
  createActor([item]);
  const before = createLightSourceItemRuntimeSignature(item);
  item.system.functions.condition.value = 0;

  assert.equal(isLightSourceItemUpdateRelevant(item, {
    "system.functions.condition.value": 0
  }, {
    falloutMawLightSourceBeforeSignatures: { [item.uuid]: before }
  }), true);
});

test("light Item delta only reconciles condition when availability crosses the broken boundary", () => {
  const item = createLightItem({ conditionValue: 5 });
  createActor([item]);
  const before = createLightSourceItemRuntimeSignature(item);
  item.system.functions.condition.value = 4;
  const options = {
    falloutMawLightSourceBeforeSignatures: {
      [item.uuid]: before
    }
  };
  assert.equal(isLightSourceItemUpdateRelevant(item, {
    system: { functions: { condition: { value: 4 } } }
  }, options), false);

  const available = createLightSourceItemRuntimeSignature(item);
  item.system.functions.condition.value = 0;
  options.falloutMawLightSourceBeforeSignatures[item.uuid] = available;
  assert.equal(isLightSourceItemUpdateRelevant(item, {
    "system.functions.condition.value": 0
  }, options), true);
});

test("installed light modules participate in host Item exact delta", () => {
  const moduleData = {
    _id: "module-source",
    name: "Module light",
    system: {
      functions: {
        module: { enabled: true, targetFunction: "weapon" },
        lightSource: {
          enabled: true,
          bright: 10,
          dim: 20,
          angle: 360,
          color: "",
          resourceCosts: []
        },
        condition: { enabled: false, value: 0, max: 0 }
      }
    }
  };
  const host = {
    id: "host",
    uuid: "Actor.actor.Item.host",
    system: {
      equipped: true,
      functions: {
        weapon: {
          enabled: true,
          moduleSlots: [{ id: "lamp", itemData: moduleData }]
        }
      }
    }
  };
  createActor([host]);
  const before = createLightSourceItemRuntimeSignature(host);
  moduleData.system.functions.lightSource.bright = 15;
  assert.equal(isLightSourceItemUpdateRelevant(host, {
    "system.functions.weapon.moduleSlots": host.system.functions.weapon.moduleSlots
  }, {
    falloutMawLightSourceBeforeSignatures: { [host.uuid]: before }
  }), true);

  const installed = createLightSourceItemRuntimeSignature(host);
  host.system.functions.weapon.moduleSlots = [];
  assert.equal(isLightSourceItemUpdateRelevant(host, {
    "system.functions.weapon.moduleSlots": []
  }, {
    falloutMawLightSourceBeforeSignatures: { [host.uuid]: installed }
  }), true);
});

test("Actor light reconciliation uses official dependent Tokens and deduplicates them", async () => {
  const actor = createActor();
  const first = createManagedToken(actor);
  const second = { ...createManagedToken(actor), id: "token-2", uuid: "Scene.other.Token.token-2" };
  let calls = 0;
  actor.getDependentTokens = () => {
    calls += 1;
    return [first, first, second];
  };

  assert.deepEqual(getActorLightSourceTokenDocuments(actor), [first, second]);
  assert.equal(calls, 1);
  assert.equal(await syncActorLightSourceTokens(actor), 0);
  assert.equal(calls, 2);
  assert.equal(first.updates.length, 0);
  assert.equal(second.updates.length, 0);
});

test("synthetic Actor reconciliation keeps the exact represented Token", () => {
  const actor = createActor();
  const own = createManagedToken(actor);
  const sibling = { ...createManagedToken(actor), id: "sibling", uuid: "Scene.scene.Token.sibling" };
  actor.isToken = true;
  actor.token = own;
  actor.getDependentTokens = () => [own];

  assert.deepEqual(getActorLightSourceTokenDocuments(actor), [own]);
  assert.notEqual(getActorLightSourceTokenDocuments(actor)[0], sibling);
});

test("already correct managed Token produces no Document update", async () => {
  const item = createLightItem();
  const actor = createActor([item]);
  const token = createManagedToken(actor, {
    activeEntries: [{ itemId: item.id }],
    baseLight: { dim: 0, bright: 0, angle: 360, color: null },
    light: { dim: 20, bright: 10, angle: 360, color: "#ffaa00" }
  });

  assert.equal(await syncTokenLightSources(token), false);
  assert.equal(token.updates.length, 0);
});

test("managed Token writes one minimal update when light differs", async () => {
  const item = createLightItem();
  const actor = createActor([item]);
  const token = createManagedToken(actor, {
    activeEntries: [{ itemId: item.id }],
    baseLight: { dim: 0, bright: 0, angle: 360, color: null },
    light: { dim: 5, bright: 10, angle: 360, color: "#ffaa00" }
  });

  assert.equal(await syncTokenLightSources(token), true);
  assert.equal(token.updates.length, 1);
  assert.deepEqual(token.updates[0].changes, { "light.dim": 20 });
  assert.equal(token.updates[0].options.falloutMawLightSourceSync, true);
});

test("stale active source cleanup and base restoration share one Token update", async () => {
  const actor = createActor();
  const token = createManagedToken(actor, {
    activeEntries: [{ itemId: "deleted-light" }],
    baseLight: { dim: 2, bright: 1, angle: 180, color: "#ffffff" },
    light: { dim: 20, bright: 10, angle: 360, color: "#ffaa00" }
  });

  assert.equal(await syncTokenLightSources(token), true);
  assert.equal(token.updates.length, 1);
  assert.deepEqual(token.updates[0].changes, {
    "flags.fallout-maw.activeLightSources": globalThis._del,
    "light.dim": 2,
    "light.bright": 1,
    "light.angle": 180,
    "light.color": "#ffffff",
    "flags.fallout-maw.lightSourceBaseLight": globalThis._del
  });
});

test("Actor light queue coalesces pending work and serializes one trailing pass", async () => {
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let releaseFirst;
  let markStarted;
  const started = new Promise(resolve => {
    markStarted = resolve;
  });
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const queue = createActorLightSourceSyncQueue({
    resolveActor: actor => actor,
    syncActor: async () => {
      calls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (calls === 1) {
        markStarted();
        await firstGate;
      }
      concurrent -= 1;
    }
  });
  const actor = { uuid: "Actor.queue" };

  const first = queue.enqueue(actor);
  await started;
  const trailing = queue.enqueue(actor);
  assert.equal(first, trailing);
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(calls, 2);
  assert.equal(maxConcurrent, 1);
  assert.equal(queue.pendingCount, 0);
});
