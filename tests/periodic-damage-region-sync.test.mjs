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
    escapeHTML: value => String(value),
    flattenObject: object => flattenObject(object),
    mergeObject: (base, update, { inplace = true } = {}) => mergeObject(base, update, { inplace })
  }
};

globalThis.canvas = {};
globalThis.FALLOUT_MAW = { id: "fallout-maw" };
globalThis.CONST = {
  ACTIVE_EFFECT_SHOW_ICON: { ALWAYS: 1 }
};
globalThis.game = {
  user: { isActiveGM: true },
  actors: createCollection([]),
  scenes: createCollection([]),
  time: { worldTime: 0 },
  settings: { get: () => undefined },
  i18n: {
    localize: key => key,
    format: (key, data) => `${key}:${data.seconds}`
  }
};

const actorRegistry = new Map();
globalThis.fromUuidSync = uuid => actorRegistry.get(uuid) ?? null;

const {
  flushPeriodicDamageRegionEffectSync,
  registerPeriodicDamageRegionHooks,
  syncPeriodicDamageRegionEffects,
  syncPeriodicDamageRegionEffectScopes,
  syncPeriodicDamageRegionEffectsForActors
} = await import("../src/canvas/periodic-damage-regions.mjs");

function flattenObject(value, prefix = "", result = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) result[prefix] = value;
    return result;
  }
  const entries = Object.entries(value);
  if (!entries.length && prefix) result[prefix] = value;
  for (const [key, entry] of entries) {
    flattenObject(entry, prefix ? `${prefix}.${key}` : key, result);
  }
  return result;
}

function mergeObject(base, update, { inplace = true } = {}) {
  const result = inplace ? base : structuredClone(base);
  for (const [key, value] of Object.entries(update ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = mergeObject(result[key] ?? {}, value);
    } else result[key] = value;
  }
  return result;
}

function createCollection(contents) {
  return {
    contents,
    get(id) {
      return this.contents.find(entry => entry.id === id || entry._id === id) ?? null;
    },
    [Symbol.iterator]() {
      return this.contents[Symbol.iterator]();
    }
  };
}

function setWorld({ actors = [], scenes = [] } = {}) {
  game.actors = createCollection(actors);
  game.scenes = createCollection(scenes);
  actorRegistry.clear();
  for (const actor of actors) actorRegistry.set(actor.uuid, actor);
  for (const scene of scenes) {
    if (scene.uuid) actorRegistry.set(scene.uuid, scene);
  }
}

function createManagedRegionEffect(
  id,
  behaviorUuid = "RegionBehavior.behavior-1",
  regionUuid = "Region.region-1"
) {
  return {
    id,
    name: "existing",
    img: "icons/svg/fire.svg",
    description: "",
    origin: behaviorUuid,
    disabled: false,
    showIcon: 1,
    getFlag(_scope, key) {
      return key === "periodicDamageRegion"
        ? { regionUuid, behaviorUuid }
        : undefined;
    }
  };
}

function createActor(uuid, {
  effects = [],
  dependentTokens = [],
  isToken = false,
  token = null
} = {}) {
  const operations = [];
  const actor = {
    uuid,
    id: uuid.split(".").at(-1),
    isOwner: true,
    isToken,
    token,
    effects,
    getDependentTokens: () => dependentTokens,
    async createEmbeddedDocuments(type, documents, options) {
      operations.push({ action: "create", type, documents, options });
      return documents;
    },
    async updateEmbeddedDocuments(type, documents, options) {
      operations.push({ action: "update", type, documents, options });
      return documents;
    },
    async deleteEmbeddedDocuments(type, ids, options) {
      operations.push({ action: "delete", type, ids, options });
      return ids;
    }
  };
  return { actor, operations };
}

function createPeriodicBehavior(id, {
  type = "fallout-maw.periodicDamage",
  disabled = false,
  damageEntries = [{ damageTypeKey: "firearm", amount: "1" }]
} = {}) {
  const behavior = {
    id,
    uuid: `RegionBehavior.${id}`,
    type,
    disabled,
    system: {
      damageEntries,
      intervalSeconds: 6,
      delaySeconds: 0,
      durationSeconds: 0
    },
    getFlag() {
      return null;
    }
  };
  return behavior;
}

function createRegion(id, behaviors = []) {
  const region = {
    id,
    uuid: `Region.${id}`,
    hidden: false,
    behaviors: createCollection(behaviors)
  };
  for (const behavior of behaviors) {
    behavior.parent = region;
    Object.defineProperty(behavior, "scene", {
      configurable: true,
      get: () => region.parent ?? null
    });
  }
  return region;
}

function createScene(id, { tokens = [], regions = [] } = {}) {
  const scene = {
    id,
    uuid: `Scene.${id}`,
    tokens: createCollection(tokens),
    regions: createCollection(regions)
  };
  for (const token of tokens) token.parent = scene;
  for (const region of regions) region.parent = scene;
  return scene;
}

function createToken(id, actor, { inside = () => false, actorLink = true, baseActor = actor } = {}) {
  return {
    id,
    uuid: `Token.${id}`,
    actor,
    actorId: baseActor?.id ?? null,
    actorLink,
    baseActor,
    testInsideRegion: inside
  };
}

test("Actor-triggered periodic effect sync reconciles only the changed Actor", async () => {
  actorRegistry.clear();
  const first = createActor("Actor.first", {
    effects: [createManagedRegionEffect("effect-first")]
  });
  const second = createActor("Actor.second", {
    effects: [createManagedRegionEffect("effect-second")]
  });
  actorRegistry.set(first.actor.uuid, first.actor);
  actorRegistry.set(second.actor.uuid, second.actor);
  game.actors.contents = [first.actor, second.actor];

  let unrelatedRegionProbeCount = 0;
  let unrelatedActorReadCount = 0;
  game.scenes.contents = [{
    tokens: {
      contents: [{
        get actor() {
          unrelatedActorReadCount += 1;
          return second.actor;
        },
        testInsideRegion() {
          unrelatedRegionProbeCount += 1;
          return true;
        }
      }]
    },
    regions: {
      contents: [{
        hidden: false,
        behaviors: { contents: [] }
      }]
    }
  }];

  await syncPeriodicDamageRegionEffectsForActors([first.actor]);

  assert.deepEqual(first.operations, [{
    action: "delete",
    type: "ActiveEffect",
    ids: ["effect-first"],
    options: { animate: false }
  }]);
  assert.deepEqual(second.operations, []);
  assert.equal(unrelatedRegionProbeCount, 0);
  assert.equal(unrelatedActorReadCount, 0);
});

test("base Actor sync includes official dependent synthetic token Actors", async () => {
  actorRegistry.clear();
  const synthetic = createActor("Scene.scene-1.Token.token-1.Actor.synthetic", {
    effects: [createManagedRegionEffect("effect-synthetic")],
    isToken: true
  });
  const base = createActor("Actor.base");
  const token = createToken("token-1", synthetic.actor, {
    actorLink: false,
    baseActor: base.actor
  });
  const scene = createScene("scene-1", { tokens: [token] });
  synthetic.actor.token = token;
  base.actor.getDependentTokens = () => [token];
  actorRegistry.set(base.actor.uuid, base.actor);
  actorRegistry.set(synthetic.actor.uuid, synthetic.actor);
  actorRegistry.set(scene.uuid, scene);
  game.actors.contents = [base.actor];
  game.scenes.contents = [scene];

  await syncPeriodicDamageRegionEffectsForActors([base.actor]);

  assert.deepEqual(base.operations, []);
  assert.deepEqual(synthetic.operations, [{
    action: "delete",
    type: "ActiveEffect",
    ids: ["effect-synthetic"],
    options: { animate: false }
  }]);
});

test("reconciliation removes duplicate managed effects left by an older overlapping sync", async () => {
  const behavior = createPeriodicBehavior("duplicate-managed-effect");
  const region = createRegion("duplicate-managed-effect-region", [behavior]);
  const target = createActor("Actor.duplicate-managed-effect", {
    effects: [
      createManagedRegionEffect("duplicate-managed-effect-a", behavior.uuid, region.uuid),
      createManagedRegionEffect("duplicate-managed-effect-b", behavior.uuid, region.uuid)
    ]
  });
  const token = createToken("duplicate-managed-effect-token", target.actor, {
    inside: candidate => candidate === region
  });
  const scene = createScene("duplicate-managed-effect-scene", {
    tokens: [token],
    regions: [region]
  });
  target.actor.getDependentTokens = () => [token];
  setWorld({ actors: [target.actor], scenes: [scene] });

  await syncPeriodicDamageRegionEffectsForActors([target.actor]);

  assert.deepEqual(
    target.operations.find(operation => operation.action === "delete"),
    {
      action: "delete",
      type: "ActiveEffect",
      ids: ["duplicate-managed-effect-b"],
      options: { animate: false }
    }
  );
});

test("Scene scope preserves a linked Actor effect supplied by its dependent Token in another Scene", async () => {
  const dependentTokens = [];
  const behavior = createPeriodicBehavior("behavior-b");
  const region = createRegion("region-b", [behavior]);
  const base = createActor("Actor.base-multiscene", {
    effects: [createManagedRegionEffect("effect-b", behavior.uuid, region.uuid)],
    dependentTokens
  });
  const tokenA = createToken("token-a", base.actor);
  const tokenB = createToken("token-b", base.actor, {
    inside: candidate => candidate === region
  });
  const sceneA = createScene("scene-a", { tokens: [tokenA] });
  const sceneB = createScene("scene-b", { tokens: [tokenB], regions: [region] });
  dependentTokens.push(tokenA, tokenB);
  setWorld({ actors: [base.actor], scenes: [sceneA, sceneB] });

  await syncPeriodicDamageRegionEffectScopes({ scenes: [sceneA] });

  assert.equal(
    base.operations.some(operation => (
      operation.action === "delete" && operation.ids.includes("effect-b")
    )),
    false
  );
  assert.equal(
    base.operations.some(operation => operation.action === "create"),
    false
  );
});

test("Scene scope does not read Token actors from unrelated Scenes", async () => {
  let unrelatedActorReads = 0;
  const affected = createActor("Actor.scene-target", {
    effects: [createManagedRegionEffect("effect-target")]
  });
  const targetToken = createToken("target-token", affected.actor);
  const targetScene = createScene("target-scene", { tokens: [targetToken] });
  affected.actor.getDependentTokens = () => [targetToken];
  const unrelatedScene = createScene("unrelated-scene", {
    tokens: [{
      id: "unrelated-token",
      uuid: "Token.unrelated-token",
      get actor() {
        unrelatedActorReads += 1;
        return null;
      }
    }]
  });
  setWorld({ actors: [affected.actor], scenes: [targetScene, unrelatedScene] });

  await syncPeriodicDamageRegionEffectScopes({ scenes: [targetScene] });

  assert.equal(unrelatedActorReads, 0);
  assert.deepEqual(affected.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["effect-target"],
    options: { animate: false }
  });
});

test("Scene scope expands linked dependents without materializing unrelated synthetic ActorDelta documents", async () => {
  let syntheticActorReads = 0;
  const base = createActor("Actor.linked-scope");
  const linkedToken = createToken("linked-scope-token", base.actor);
  const affectedScene = createScene("linked-scope-scene", { tokens: [linkedToken] });
  const syntheticScene = createScene("synthetic-scope-scene");
  const syntheticToken = {
    id: "synthetic-scope-token",
    uuid: "Token.synthetic-scope-token",
    actorLink: false,
    baseActor: base.actor,
    get actor() {
      syntheticActorReads += 1;
      return null;
    }
  };
  syntheticToken.parent = syntheticScene;
  syntheticScene.tokens.contents.push(syntheticToken);
  base.actor.getDependentTokens = ({ linked = false } = {}) => (
    linked ? [linkedToken] : [linkedToken, syntheticToken]
  );
  setWorld({ actors: [base.actor], scenes: [affectedScene, syntheticScene] });

  await syncPeriodicDamageRegionEffectScopes({ scenes: [affectedScene] });

  assert.equal(syntheticActorReads, 0);
});

const periodicHooks = new Map();
globalThis.Hooks = {
  on(name, callback) {
    periodicHooks.set(name, callback);
  }
};
registerPeriodicDamageRegionHooks();

async function primePeriodicScene(scene, actorsWithOperations = []) {
  periodicHooks.get("createScene")(scene);
  await flushPeriodicDamageRegionEffectSync();
  for (const entry of actorsWithOperations) entry.operations.length = 0;
}

test("movement-history-only RegionBehavior updates do not invalidate the effect projection", async () => {
  const behavior = createPeriodicBehavior("movement-only");
  const region = createRegion("movement-region", [behavior]);
  const target = createActor("Actor.movement-target", {
    effects: [createManagedRegionEffect("movement-effect", behavior.uuid, region.uuid)]
  });
  const token = createToken("movement-token", target.actor);
  target.actor.getDependentTokens = () => [token];
  const scene = createScene("movement-scene", { tokens: [token], regions: [region] });
  setWorld({ actors: [target.actor], scenes: [scene] });
  await primePeriodicScene(scene, [target]);

  periodicHooks.get("updateRegionBehavior")(behavior, {
    flags: {
      "fallout-maw": {
        periodicDamageMovement: {
          actors: [{ actorUuid: target.actor.uuid, progress: 1 }]
        }
      }
    },
    _stats: {
      modifiedTime: 123,
      lastModifiedBy: "gm"
    }
  });
  await flushPeriodicDamageRegionEffectSync();
  assert.deepEqual(target.operations, []);

  periodicHooks.get("updateRegionBehavior")(behavior, {
    system: { intervalSeconds: 7 },
    _stats: { modifiedTime: 124 }
  });
  await flushPeriodicDamageRegionEffectSync();
  assert.deepEqual(target.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["movement-effect"],
    options: { animate: false }
  });
});

test("Region hooks ignore visual changes but reconcile boundary changes", async () => {
  const behavior = createPeriodicBehavior("region-boundary");
  const region = createRegion("region-boundary", [behavior]);
  const target = createActor("Actor.region-boundary", {
    effects: [createManagedRegionEffect("region-effect", behavior.uuid, region.uuid)]
  });
  const token = createToken("region-token", target.actor);
  target.actor.getDependentTokens = () => [token];
  const scene = createScene("region-scene", { tokens: [token], regions: [region] });
  setWorld({ actors: [target.actor], scenes: [scene] });
  await primePeriodicScene(scene, [target]);

  periodicHooks.get("updateRegion")(region, { name: "visual only", color: "#ff0000" });
  await flushPeriodicDamageRegionEffectSync();
  assert.deepEqual(target.operations, []);

  periodicHooks.get("updateRegion")(region, {
    restriction: { enabled: true, type: "light" },
    _shapeConstraints: []
  });
  await flushPeriodicDamageRegionEffectSync();
  assert.deepEqual(target.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["region-effect"],
    options: { animate: false }
  });
});

test("direct Region behaviors replacement invalidates cached periodic behavior documents", async () => {
  const behavior = createPeriodicBehavior("direct-behavior");
  const region = createRegion("direct-behavior-region", [behavior]);
  const target = createActor("Actor.direct-behavior", {
    effects: [createManagedRegionEffect("direct-behavior-effect", behavior.uuid, region.uuid)]
  });
  const token = createToken("direct-behavior-token", target.actor);
  target.actor.getDependentTokens = () => [token];
  const scene = createScene("direct-behavior-scene", { tokens: [token], regions: [region] });
  setWorld({ actors: [target.actor], scenes: [scene] });
  await primePeriodicScene(scene, [target]);

  region.behaviors = createCollection([]);
  periodicHooks.get("updateRegion")(region, {
    behaviors: [],
    _stats: { modifiedTime: 126 }
  });
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(target.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["direct-behavior-effect"],
    options: { animate: false }
  });
});

test("periodic-to-nonperiodic behavior type transition reconciles its Scene", async () => {
  const behavior = createPeriodicBehavior("changed-type", { type: "other.behavior" });
  const region = createRegion("changed-type-region", [behavior]);
  const target = createActor("Actor.changed-type", {
    effects: [createManagedRegionEffect("changed-type-effect", behavior.uuid, region.uuid)]
  });
  const token = createToken("changed-type-token", target.actor);
  target.actor.getDependentTokens = () => [token];
  const scene = createScene("changed-type-scene", { tokens: [token], regions: [region] });
  setWorld({ actors: [target.actor], scenes: [scene] });

  periodicHooks.get("updateRegionBehavior")(behavior, {
    type: "other.behavior",
    _stats: { modifiedTime: 125 }
  });
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(target.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["changed-type-effect"],
    options: { animate: false }
  });
});

test("world-time invalidation visits only Scenes which contain periodic damage behaviors", async () => {
  let unrelatedActorReads = 0;
  const behavior = createPeriodicBehavior("world-time");
  const region = createRegion("world-time-region", [behavior]);
  const target = createActor("Actor.world-time", {
    effects: [createManagedRegionEffect("world-time-effect", behavior.uuid, region.uuid)]
  });
  const targetToken = createToken("world-time-token", target.actor);
  target.actor.getDependentTokens = () => [targetToken];
  const periodicScene = createScene("world-time-periodic", {
    tokens: [targetToken],
    regions: [region]
  });
  const unrelatedScene = createScene("world-time-unrelated", {
    tokens: [{
      id: "world-time-unrelated-token",
      uuid: "Token.world-time-unrelated-token",
      get actor() {
        unrelatedActorReads += 1;
        return null;
      }
    }]
  });
  setWorld({ actors: [target.actor], scenes: [periodicScene, unrelatedScene] });
  await primePeriodicScene(periodicScene, [target]);
  unrelatedActorReads = 0;

  periodicHooks.get("updateWorldTime")(100, -6, {}, "gm");
  await flushPeriodicDamageRegionEffectSync();

  assert.equal(unrelatedActorReads, 0);
  assert.deepEqual(target.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["world-time-effect"],
    options: { animate: false }
  });
});

test("Token actor reassociation reconciles the previous persistent Actor from a per-Token snapshot", async () => {
  const behavior = createPeriodicBehavior("reassociated-behavior");
  const region = createRegion("reassociated-region", [behavior]);
  const oldActor = createActor("Actor.old-token-owner", {
    effects: [createManagedRegionEffect("old-owner-effect")]
  });
  const newActor = createActor("Actor.new-token-owner");
  const token = createToken("reassociated-token", oldActor.actor);
  const scene = createScene("reassociated-scene", { tokens: [token], regions: [region] });
  oldActor.actor.getDependentTokens = () => [];
  newActor.actor.getDependentTokens = () => [token];
  setWorld({ actors: [oldActor.actor, newActor.actor], scenes: [scene] });

  const options = {};
  periodicHooks.get("preUpdateToken")(token, { actorId: newActor.actor.id }, options);
  token.actor = newActor.actor;
  token.baseActor = newActor.actor;
  token.actorId = newActor.actor.id;
  periodicHooks.get("updateToken")(token, { actorId: newActor.actor.id }, options);
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(oldActor.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["old-owner-effect"],
    options: { animate: false }
  });
});

test("batch Token reassociation keeps a distinct previous Actor snapshot for every Token", async () => {
  const behavior = createPeriodicBehavior("batch-reassociated-behavior");
  const region = createRegion("batch-reassociated-region", [behavior]);
  const oldA = createActor("Actor.batch-old-a", {
    effects: [createManagedRegionEffect("batch-old-effect-a")]
  });
  const oldB = createActor("Actor.batch-old-b", {
    effects: [createManagedRegionEffect("batch-old-effect-b")]
  });
  const newA = createActor("Actor.batch-new-a");
  const newB = createActor("Actor.batch-new-b");
  const tokenA = createToken("batch-token-a", oldA.actor);
  const tokenB = createToken("batch-token-b", oldB.actor);
  const scene = createScene("batch-reassociated-scene", {
    tokens: [tokenA, tokenB],
    regions: [region]
  });
  oldA.actor.getDependentTokens = () => [];
  oldB.actor.getDependentTokens = () => [];
  newA.actor.getDependentTokens = () => [tokenA];
  newB.actor.getDependentTokens = () => [tokenB];
  setWorld({
    actors: [oldA.actor, oldB.actor, newA.actor, newB.actor],
    scenes: [scene]
  });

  const options = {};
  periodicHooks.get("preUpdateToken")(tokenA, { actorId: newA.actor.id }, options);
  periodicHooks.get("preUpdateToken")(tokenB, { actorId: newB.actor.id }, options);
  tokenA.actor = tokenA.baseActor = newA.actor;
  tokenA.actorId = newA.actor.id;
  tokenB.actor = tokenB.baseActor = newB.actor;
  tokenB.actorId = newB.actor.id;
  periodicHooks.get("updateToken")(tokenA, { actorId: newA.actor.id }, options);
  periodicHooks.get("updateToken")(tokenB, { actorId: newB.actor.id }, options);
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(oldA.operations.at(-1)?.ids, ["batch-old-effect-a"]);
  assert.deepEqual(oldB.operations.at(-1)?.ids, ["batch-old-effect-b"]);
});

test("Token reassociation still cleans the previous linked Actor after the periodic behavior is removed", async () => {
  const behavior = createPeriodicBehavior("removed-before-reassociation");
  const region = createRegion("removed-before-reassociation-region", [behavior]);
  const oldActor = createActor("Actor.removed-before-reassociation-old", {
    effects: [createManagedRegionEffect(
      "removed-before-reassociation-effect",
      behavior.uuid,
      region.uuid
    )]
  });
  const newActor = createActor("Actor.removed-before-reassociation-new");
  const token = createToken("removed-before-reassociation-token", oldActor.actor);
  const scene = createScene("removed-before-reassociation-scene", {
    tokens: [token],
    regions: [region]
  });
  oldActor.actor.getDependentTokens = () => [];
  newActor.actor.getDependentTokens = () => [token];
  setWorld({ actors: [oldActor.actor, newActor.actor], scenes: [scene] });

  behavior.type = "other.behavior";
  periodicHooks.get("updateRegionBehavior")(behavior, { type: "other.behavior" });
  const options = {};
  periodicHooks.get("preUpdateToken")(token, { actorId: newActor.actor.id }, options);
  token.actor = token.baseActor = newActor.actor;
  token.actorId = newActor.actor.id;
  periodicHooks.get("updateToken")(token, { actorId: newActor.actor.id }, options);
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(oldActor.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["removed-before-reassociation-effect"],
    options: { animate: false }
  });
});

test("Token deletion still cleans its linked Actor after the periodic behavior is removed", async () => {
  const behavior = createPeriodicBehavior("removed-before-token-delete");
  const region = createRegion("removed-before-token-delete-region", [behavior]);
  const target = createActor("Actor.removed-before-token-delete", {
    effects: [createManagedRegionEffect(
      "removed-before-token-delete-effect",
      behavior.uuid,
      region.uuid
    )]
  });
  const token = createToken("removed-before-token-delete-token", target.actor);
  const scene = createScene("removed-before-token-delete-scene", {
    tokens: [token],
    regions: [region]
  });
  target.actor.getDependentTokens = () => [];
  setWorld({ actors: [target.actor], scenes: [scene] });

  behavior.type = "other.behavior";
  periodicHooks.get("updateRegionBehavior")(behavior, { type: "other.behavior" });
  scene.tokens.contents = [];
  periodicHooks.get("deleteToken")(token);
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(target.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["removed-before-token-delete-effect"],
    options: { animate: false }
  });
});

test("Token updates in nonperiodic Scenes do not materialize their Actor", async () => {
  let actorReads = 0;
  const token = {
    id: "nonperiodic-token",
    uuid: "Token.nonperiodic-token",
    get actor() {
      actorReads += 1;
      return null;
    }
  };
  const scene = createScene("nonperiodic-scene", { tokens: [token] });
  setWorld({ scenes: [scene] });

  periodicHooks.get("updateToken")(token, { x: 100, y: 100 }, {});
  await flushPeriodicDamageRegionEffectSync();

  assert.equal(actorReads, 0);
});

test("deleting an unlinked Token never writes to its already-deleted synthetic Actor", async () => {
  const behavior = createPeriodicBehavior("delete-token");
  const region = createRegion("delete-token-region", [behavior]);
  const base = createActor("Actor.delete-token-base", {
    effects: [createManagedRegionEffect("delete-token-base-effect")]
  });
  const synthetic = createActor("Scene.delete-token.Token.deleted.Actor.synthetic", {
    effects: [createManagedRegionEffect("delete-token-synthetic-effect")],
    isToken: true
  });
  const token = createToken("deleted-token", synthetic.actor, {
    actorLink: false,
    baseActor: base.actor
  });
  const scene = createScene("delete-token-scene", { tokens: [token], regions: [region] });
  synthetic.actor.token = token;
  base.actor.getDependentTokens = () => [];
  setWorld({ actors: [base.actor], scenes: [scene] });
  actorRegistry.set(synthetic.actor.uuid, synthetic.actor);

  periodicHooks.get("updateToken")(token, { x: 1 }, {});
  scene.tokens.contents = [];
  actorRegistry.delete(synthetic.actor.uuid);
  periodicHooks.get("deleteToken")(token);
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(synthetic.operations, []);
  assert.deepEqual(base.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["delete-token-base-effect"],
    options: { animate: false }
  });
});

test("deleting a Scene cleans its effect while preserving another Scene effect of the same Actor", async () => {
  const behaviorA = createPeriodicBehavior("deleted-scene-behavior");
  const behaviorB = createPeriodicBehavior("live-scene-behavior");
  const regionA = createRegion("deleted-scene-region", [behaviorA]);
  const regionB = createRegion("live-scene-region", [behaviorB]);
  const base = createActor("Actor.deleted-scene-base", {
    effects: [
      createManagedRegionEffect("deleted-scene-effect", behaviorA.uuid, regionA.uuid),
      createManagedRegionEffect("live-scene-effect", behaviorB.uuid, regionB.uuid)
    ]
  });
  const deletedToken = createToken("deleted-scene-token", base.actor);
  const liveToken = createToken("live-scene-token", base.actor, {
    inside: candidate => candidate === regionB
  });
  const deletedScene = createScene("deleted-scene", {
    tokens: [deletedToken],
    regions: [regionA]
  });
  const liveScene = createScene("live-scene", {
    tokens: [liveToken],
    regions: [regionB]
  });
  base.actor.getDependentTokens = () => [liveToken];
  setWorld({ actors: [base.actor], scenes: [liveScene] });

  periodicHooks.get("deleteScene")(deletedScene);
  await flushPeriodicDamageRegionEffectSync();

  const deletion = base.operations.find(operation => operation.action === "delete");
  assert.deepEqual(deletion?.ids, ["deleted-scene-effect"]);
  assert.equal(deletion?.ids.includes("live-scene-effect"), false);
});

test("a deleted Scene supersedes its stale debounced scope even after its periodic behavior changed type", async () => {
  const behavior = createPeriodicBehavior("stale-scene-behavior");
  const region = createRegion("stale-scene-region", [behavior]);
  const base = createActor("Actor.stale-scene", {
    effects: [createManagedRegionEffect("stale-scene-effect", behavior.uuid, region.uuid)]
  });
  const token = createToken("stale-scene-token", base.actor);
  const scene = createScene("stale-scene", { tokens: [token], regions: [region] });
  base.actor.getDependentTokens = () => [];
  setWorld({ actors: [base.actor], scenes: [scene] });

  behavior.type = "other.behavior";
  periodicHooks.get("updateRegionBehavior")(behavior, { type: "other.behavior" });
  game.scenes.contents = [];
  actorRegistry.delete(scene.uuid);
  periodicHooks.get("deleteScene")(scene);
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(base.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["stale-scene-effect"],
    options: { animate: false }
  });
});

test("Scene grid distance changes reconcile periodic containment", async () => {
  const behavior = createPeriodicBehavior("scene-grid");
  const region = createRegion("scene-grid-region", [behavior]);
  const target = createActor("Actor.scene-grid", {
    effects: [createManagedRegionEffect("scene-grid-effect", behavior.uuid, region.uuid)]
  });
  const token = createToken("scene-grid-token", target.actor);
  target.actor.getDependentTokens = () => [token];
  const scene = createScene("scene-grid", { tokens: [token], regions: [region] });
  setWorld({ actors: [target.actor], scenes: [scene] });
  await primePeriodicScene(scene, [target]);

  periodicHooks.get("updateScene")(scene, { grid: { distance: 2 } }, {});
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(target.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["scene-grid-effect"],
    options: { animate: false }
  });
});

test("compendium and detached preview Actors are excluded from world effect projection", async () => {
  const compendiumActor = createActor("Compendium.test.actors.Actor.preview", {
    effects: [createManagedRegionEffect("compendium-effect")]
  });
  compendiumActor.actor.pack = "test.actors";
  compendiumActor.actor.inCompendium = true;
  setWorld();
  actorRegistry.set(compendiumActor.actor.uuid, compendiumActor.actor);

  periodicHooks.get("updateActor")(compendiumActor.actor, {
    system: { health: { value: 1 } }
  });
  await flushPeriodicDamageRegionEffectSync();
  await syncPeriodicDamageRegionEffectScopes({ actors: [compendiumActor.actor] });

  assert.deepEqual(compendiumActor.operations, []);
});

test("active-GM failover schedules one full recovery for scopes accepted by the lost authority", async () => {
  const behavior = createPeriodicBehavior("authority-recovery");
  const region = createRegion("authority-recovery-region", [behavior]);
  const target = createActor("Actor.authority-recovery", {
    effects: [createManagedRegionEffect("authority-recovery-effect", behavior.uuid, region.uuid)]
  });
  const token = createToken("authority-recovery-token", target.actor);
  target.actor.getDependentTokens = () => [token];
  const scene = createScene("authority-recovery-scene", {
    tokens: [token],
    regions: [region]
  });
  setWorld({ actors: [target.actor], scenes: [scene] });

  game.user.id = "new-gm";
  game.user.isActiveGM = false;
  game.users = { activeGM: { id: "old-gm" } };
  await syncPeriodicDamageRegionEffects();
  assert.deepEqual(target.operations, []);

  game.user.isActiveGM = true;
  game.users.activeGM = { id: "new-gm" };
  periodicHooks.get("userConnected")({ id: "old-gm" }, false);
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(target.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["authority-recovery-effect"],
    options: { animate: false }
  });
});

test("an updateUser role change also recovers projection authority", async () => {
  const target = createActor("Actor.authority-role-change", {
    effects: [createManagedRegionEffect("authority-role-change-effect")]
  });
  setWorld({ actors: [target.actor] });

  game.user.id = "new-role-gm";
  game.user.isActiveGM = false;
  game.users = { activeGM: { id: "old-role-gm" } };
  await syncPeriodicDamageRegionEffects();
  assert.deepEqual(target.operations, []);

  game.user.isActiveGM = true;
  game.users.activeGM = { id: "new-role-gm" };
  periodicHooks.get("updateUser")({ id: "new-role-gm" }, { role: 4 }, {}, "new-role-gm");
  await flushPeriodicDamageRegionEffectSync();

  assert.deepEqual(target.operations.at(-1), {
    action: "delete",
    type: "ActiveEffect",
    ids: ["authority-role-change-effect"],
    options: { animate: false }
  });
});

test("a reconcile stops before the next Actor after losing active-GM authority", async () => {
  const first = createActor("Actor.authority-loss-first", {
    effects: [createManagedRegionEffect("authority-loss-first-effect")]
  });
  const second = createActor("Actor.authority-loss-second", {
    effects: [createManagedRegionEffect("authority-loss-second-effect")]
  });
  first.actor.deleteEmbeddedDocuments = async (type, ids, options) => {
    first.operations.push({ action: "delete", type, ids, options });
    game.user.isActiveGM = false;
    return ids;
  };
  setWorld({ actors: [first.actor, second.actor] });
  game.user.isActiveGM = true;

  try {
    await syncPeriodicDamageRegionEffectScopes({
      actors: [first.actor, second.actor]
    });
    assert.deepEqual(first.operations.at(-1)?.ids, ["authority-loss-first-effect"]);
    assert.deepEqual(second.operations, []);
  } finally {
    game.user.isActiveGM = true;
  }
});

test("inactive GM neither schedules nor writes periodic projection changes", async () => {
  const behavior = createPeriodicBehavior("inactive-gm");
  const region = createRegion("inactive-gm-region", [behavior]);
  const target = createActor("Actor.inactive-gm", {
    effects: [createManagedRegionEffect("inactive-gm-effect", behavior.uuid, region.uuid)]
  });
  const token = createToken("inactive-gm-token", target.actor);
  target.actor.getDependentTokens = () => [token];
  const scene = createScene("inactive-gm-scene", { tokens: [token], regions: [region] });
  setWorld({ actors: [target.actor], scenes: [scene] });
  await primePeriodicScene(scene, [target]);

  game.user.isActiveGM = false;
  try {
    periodicHooks.get("updateActor")(target.actor, { system: { health: { value: 0 } } });
    periodicHooks.get("updateWorldTime")(106, 6, {}, "gm");
    await flushPeriodicDamageRegionEffectSync();
    await syncPeriodicDamageRegionEffectScopes({ actors: [target.actor], scenes: [scene] });
    assert.deepEqual(target.operations, []);
  } finally {
    game.user.isActiveGM = true;
  }
});
