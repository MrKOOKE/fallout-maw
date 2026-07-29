import assert from "node:assert/strict";
import test from "node:test";

function getProperty(object, path) {
  let value = object;
  for (const key of String(path).split(".")) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value;
}

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  documents: {
    ActiveEffect: {
      implementation: {
        CHANGE_TYPES: {
          add: { defaultPriority: 20 },
          multiply: { defaultPriority: 10 },
          subtract: { defaultPriority: 20 },
          override: { defaultPriority: 30 },
          upgrade: { defaultPriority: 40 },
          downgrade: { defaultPriority: 40 }
        }
      }
    }
  },
  utils: {
    deepClone: structuredClone,
    getProperty,
    hasProperty: (object, path) => getProperty(object, path) !== undefined,
    mergeObject: (original, other) => ({ ...original, ...other }),
    randomID: () => "generated-id"
  }
};

globalThis.game = {
  settings: { get: () => undefined },
  i18n: { localize: key => key, format: key => key },
  user: { isActiveGM: true, id: "gm" },
  users: new Map(),
  actors: [],
  time: { worldTime: 100 },
  combat: null
};
globalThis.canvas = {
  tokens: { placeables: [] },
  scene: { id: "scene" }
};
globalThis.fromUuidSync = () => null;
globalThis._del = Symbol("delete");

const registeredHookCallbacks = new Map();
globalThis.Hooks = {
  on(name, callback) {
    const callbacks = registeredHookCallbacks.get(name) ?? [];
    callbacks.push(callback);
    registeredHookCallbacks.set(name, callbacks);
    return callback;
  }
};

const { SYSTEM_ID } = await import("../src/constants.mjs");
const {
  initializeActiveEffectAuras,
  registerActiveEffectAuraHooks
} = await import("../src/abilities/active-effect-auras.mjs");
const {
  beginBulkOperation,
  endBulkOperation
} = await import("../src/utils/bulk-operation.mjs");

function registerFreshAuraHooks() {
  const names = [
    "createActiveEffect",
    "updateActiveEffect",
    "deleteActiveEffect",
    "updateWorldTime",
    `${SYSTEM_ID}.factionSettingsChanged`,
    "createToken",
    "deleteToken",
    "updateToken",
    "updateActor"
  ];
  const previousCounts = Object.fromEntries(
    names.map(name => [name, registeredHookCallbacks.get(name)?.length ?? 0])
  );
  registerActiveEffectAuraHooks();
  return Object.fromEntries(names.map(name => {
    const callbacks = (registeredHookCallbacks.get(name) ?? []).slice(previousCounts[name]);
    assert.equal(callbacks.length, 1, name);
    return [name, callbacks[0]];
  }));
}

function createActor(id = "source") {
  return {
    id,
    uuid: `Actor.${id}`,
    type: "character",
    effects: [],
    flags: {},
    statuses: new Set(),
    system: {
      characteristics: {},
      skills: {},
      resources: {}
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
}

function createToken(actor) {
  const document = {
    uuid: `Scene.scene.Token.${actor.id}`,
    hidden: false,
    x: 0,
    y: 0,
    parent: canvas.scene
  };
  return {
    id: `token-${actor.id}`,
    actor,
    document,
    center: { x: 50, y: 50 },
    checkCollision: () => false
  };
}

function createAuraEffect(actor, id = "source-aura") {
  const activeApplication = {
    sourceItemUuid: "",
    constructData: [],
    functionData: {
      id: "active-aura-function",
      type: "activeApplication",
      changes: [],
      actions: [],
      penalties: [],
      conditions: [
        {
          id: "trigger-aura",
          type: "aura",
          auraMode: "triggerConditions",
          auraTargetGroups: ["ally"],
          auraRadiusMeters: "0",
          requiredCount: "1",
          auraWallsBlock: false,
          auraTriggerOnCreate: true,
          auraTriggerOnEnter: true,
          auraRepeatSeconds: 6
        },
        {
          id: "trial",
          type: "trial",
          trialSubject: "targets",
          trialEntries: [],
          trialBranches: []
        }
      ]
    }
  };
  return {
    id,
    uuid: `${actor.uuid}.ActiveEffect.${id}`,
    parent: actor,
    disabled: false,
    duration: { expired: false, value: 0 },
    flags: {
      [SYSTEM_ID]: {
        activeApplication
      }
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
}

function createOrdinaryEffect(actor, id) {
  return {
    id,
    uuid: `${actor.uuid}.ActiveEffect.${id}`,
    parent: actor,
    disabled: false,
    duration: { expired: false, value: 0 },
    flags: {},
    getFlag() {
      return undefined;
    }
  };
}

async function settleAuraRuntime() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

async function clearAuraIndex() {
  const previousTokens = canvas.tokens;
  canvas.tokens = { placeables: [] };
  try {
    await initializeActiveEffectAuras();
  } finally {
    canvas.tokens = previousTokens;
  }
}

test("empty aura index rejects unrelated document hooks before canvas or movement work", async () => {
  await clearAuraIndex();
  const callbacks = registerFreshAuraHooks();
  const actor = createActor("empty-index");
  const effect = createOrdinaryEffect(actor, "ordinary");
  let placeableReads = 0;
  let movementReads = 0;
  const previousTokens = canvas.tokens;
  canvas.tokens = {
    get placeables() {
      placeableReads += 1;
      return [];
    }
  };
  const tokenDocument = {
    actor,
    get object() {
      return {
        actor,
        get movementAnimationPromise() {
          movementReads += 1;
          return Promise.resolve();
        }
      };
    }
  };

  try {
    callbacks.createActiveEffect(effect, {});
    callbacks.updateActiveEffect(effect, { disabled: true }, {});
    callbacks.deleteActiveEffect(effect, {});
    callbacks.updateWorldTime(101);
    callbacks[`${SYSTEM_ID}.factionSettingsChanged`]();
    callbacks.createToken(tokenDocument);
    callbacks.deleteToken(tokenDocument);
    callbacks.updateToken(tokenDocument, { x: 10 });
    callbacks.updateActor(actor, {
      flags: {
        [SYSTEM_ID]: { factionBelongs: ["test"] }
      }
    }, {});
    await settleAuraRuntime();

    assert.equal(placeableReads, 0);
    assert.equal(movementReads, 0);
  } finally {
    canvas.tokens = previousTokens;
  }
});

test("bulk source changes update the index immediately but defer and discard stale runtime work", async () => {
  await clearAuraIndex();
  const callbacks = registerFreshAuraHooks();
  const actor = createActor("bulk-source");
  const sourceEffect = createAuraEffect(actor);
  const token = createToken(actor);
  let placeableReads = 0;
  const previousTokens = canvas.tokens;
  canvas.tokens = {
    get placeables() {
      placeableReads += 1;
      return [token];
    }
  };

  try {
    beginBulkOperation();
    callbacks.createActiveEffect(sourceEffect, {});
    await Promise.resolve();
    assert.equal(placeableReads, 0);
    await endBulkOperation();
    await settleAuraRuntime();
    assert.ok(placeableReads > 0);

    placeableReads = 0;
    beginBulkOperation();
    callbacks.deleteActiveEffect(sourceEffect, {});
    await Promise.resolve();
    assert.equal(placeableReads, 0);
    await endBulkOperation();
    await settleAuraRuntime();
    assert.equal(placeableReads, 0);
  } finally {
    canvas.tokens = previousTokens;
    await clearAuraIndex();
  }
});

test("one bulk aura flush coalesces repeated target Actor changes by UUID", async () => {
  await clearAuraIndex();
  const callbacks = registerFreshAuraHooks();
  const actor = createActor("coalesced-target");
  const sourceEffect = createAuraEffect(actor);
  const token = createToken(actor);
  let placeableReads = 0;
  const previousTokens = canvas.tokens;
  canvas.tokens = {
    get placeables() {
      placeableReads += 1;
      return [token];
    }
  };

  try {
    beginBulkOperation();
    callbacks.createActiveEffect(sourceEffect, {});
    await endBulkOperation();
    await settleAuraRuntime();

    placeableReads = 0;
    beginBulkOperation();
    callbacks.createActiveEffect(createOrdinaryEffect(actor, "single"), {});
    await endBulkOperation();
    await settleAuraRuntime();
    const singleChangeReads = placeableReads;

    placeableReads = 0;
    beginBulkOperation();
    for (let index = 0; index < 20; index += 1) {
      callbacks.createActiveEffect(createOrdinaryEffect(actor, `bulk-${index}`), {});
    }
    await endBulkOperation();
    await settleAuraRuntime();

    assert.ok(singleChangeReads > 0);
    assert.equal(placeableReads, singleChangeReads);
  } finally {
    callbacks.deleteActiveEffect(sourceEffect, {});
    canvas.tokens = previousTokens;
    await clearAuraIndex();
  }
});

test("an unrelated Actor update does not scan indexed source aura documents", async () => {
  await clearAuraIndex();
  const callbacks = registerFreshAuraHooks();
  const sourceActor = createActor("indexed-source");
  let sourceUuidReads = 0;
  Object.defineProperty(sourceActor, "uuid", {
    configurable: true,
    get() {
      sourceUuidReads += 1;
      return "Actor.indexed-source";
    }
  });
  const sourceEffect = createAuraEffect(sourceActor);
  const token = createToken(sourceActor);
  const previousTokens = canvas.tokens;
  canvas.tokens = { placeables: [token] };

  try {
    callbacks.createActiveEffect(sourceEffect, {});
    await settleAuraRuntime();
    sourceUuidReads = 0;

    callbacks.updateActor(createActor("ordinary-damage-target"), {
      "system.resources.health.value": 7
    }, {});
    await settleAuraRuntime();

    assert.equal(sourceUuidReads, 0);
  } finally {
    callbacks.deleteActiveEffect(sourceEffect, {});
    canvas.tokens = previousTokens;
    await clearAuraIndex();
  }
});
