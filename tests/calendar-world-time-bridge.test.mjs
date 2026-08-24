import test from "node:test";
import assert from "node:assert/strict";

function deepMerge(target, source) {
  const output = structuredClone(target ?? {});
  for (const [key, value] of Object.entries(source ?? {})) {
    output[key] = value && typeof value === "object" && !Array.isArray(value)
      ? deepMerge(output[key] ?? {}, value)
      : structuredClone(value);
  }
  return output;
}

test("calendar time changes use the exact system world-time pipeline", async () => {
  const previous = {
    Hooks: globalThis.Hooks,
    game: globalThis.game,
    canvas: globalThis.canvas,
    foundry: globalThis.foundry,
    CONFIG: globalThis.CONFIG,
    CONST: globalThis.CONST,
    ui: globalThis.ui,
    ActiveEffect: globalThis.ActiveEffect,
    fromUuid: globalThis.fromUuid,
    fromUuidSync: globalThis.fromUuidSync
  };
  const hooks = new Map();
  const settingValues = new Map([
    ["timeRestMode", true],
    ["timeMechanicsIgnored", false],
    ["timeNeedsPlayersOnly", true]
  ]);
  const setCalls = [];
  const processorCalls = [];
  let randomId = 0;

  globalThis.Hooks = {
    on(name, callback) {
      const callbacks = hooks.get(name) ?? [];
      callbacks.push(callback);
      hooks.set(name, callbacks);
      return callback;
    },
    once(name, callback) {
      return this.on(name, callback);
    },
    callAll(name, ...args) {
      for (const callback of hooks.get(name) ?? []) callback(...args);
    }
  };
  globalThis.canvas = { scene: { uuid: "Scene.test" } };
  globalThis.foundry = {
    applications: {
      api: { DialogV2: class {} },
      ux: { FormDataExtended: class {} },
      handlebars: { renderTemplate: async () => "" }
    },
    documents: {
      ActiveEffect: { implementation: class {} },
      ChatMessage: { implementation: { getSpeaker: () => ({}), create: async () => [] } }
    },
    dice: { Roll: { _mapLegacyRollMode: value => value } },
    utils: {
      deepClone: value => structuredClone(value),
      mergeObject: (target, source) => deepMerge(target, source),
      getProperty: (object, path) => String(path).split(".").reduce((value, key) => value?.[key], object),
      hasProperty: (object, path) => String(path).split(".").reduce((value, key) => value?.[key], object) !== undefined,
      randomID: () => `test-${++randomId}`,
      escapeHTML: value => String(value),
      logCompatibilityWarning: () => {}
    }
  };
  globalThis.CONFIG = {
    ActiveEffect: { expiryAction: "delete", documentClass: { createDocuments: async () => [] } },
    ChatMessage: { modes: {} },
    queries: {},
    time: { roundTime: 6, turnTime: 0 },
    debug: { combat: false }
  };
  globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 }, REGION_EVENTS: {} };
  globalThis.ui = { notifications: { warn: () => {}, error: () => {} } };
  globalThis.ActiveEffect = { registry: { refresh: () => {} } };
  globalThis.fromUuid = async () => null;
  globalThis.fromUuidSync = () => null;
  globalThis.game = {
    user: { id: "gm", isGM: true, isActiveGM: true },
    users: { activeGM: { id: "gm" } },
    combat: null,
    settings: {
      get(_namespace, key) {
        return settingValues.get(key);
      },
      async set(_namespace, key, value) {
        settingValues.set(key, value);
        return value;
      }
    },
    falloutMaW: { calendar: Object.freeze({ api: {} }) },
    time: {
      worldTime: 100,
      async set(target, options) {
        const before = this.worldTime;
        this.worldTime = target;
        setCalls.push({ target, options });
        globalThis.Hooks.callAll("updateWorldTime", target, target - before, options, "gm");
        return target;
      },
      async advance() {
        throw new Error("calendar absolute changes must not use game.time.advance");
      }
    }
  };

  try {
    const queue = await import("../src/time/world-time-queue.mjs");
    const runtime = await import("../src/calendar/runtime.mjs");
    const unregister = queue.registerQueuedWorldTimeProcessor((worldTime, delta, options) => {
      processorCalls.push({ worldTime, delta, options });
    });
    try {
      assert.equal(runtime.installCalendarAdvanceApi(), true);
      const applied = await globalThis.game.falloutMaW.calendar.setWorldTime(4_600);
      assert.equal(applied, true);
    } finally {
      unregister();
    }

    assert.equal(globalThis.game.time.worldTime, 4_600);
    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0].target, 4_600);
    assert.equal(setCalls[0].options.falloutMawSystemTimeAdvance, true);
    assert.equal(setCalls[0].options.falloutMawWorldTimeSource, "calendar");
    assert.equal(setCalls[0].options.falloutMaw.restMode, true);
    assert.deepEqual(processorCalls.map(({ worldTime, delta }) => ({ worldTime, delta })), [
      { worldTime: 4_600, delta: 4_500 }
    ]);

    assert.deepEqual(globalThis.game.falloutMaW.calendar.getTimeOptions(), {
      restMode: true,
      ignoreTimeMechanics: false,
      needsPlayersOnly: true
    });
    await globalThis.game.falloutMaW.calendar.setTimeOptions({
      restMode: false,
      ignoreTimeMechanics: true,
      needsPlayersOnly: false
    });
    assert.deepEqual(Object.fromEntries(settingValues), {
      timeRestMode: false,
      timeMechanicsIgnored: true,
      timeNeedsPlayersOnly: false
    });
  } finally {
    globalThis.Hooks = previous.Hooks;
    globalThis.game = previous.game;
    globalThis.canvas = previous.canvas;
    globalThis.foundry = previous.foundry;
    globalThis.CONFIG = previous.CONFIG;
    globalThis.CONST = previous.CONST;
    globalThis.ui = previous.ui;
    globalThis.ActiveEffect = previous.ActiveEffect;
    globalThis.fromUuid = previous.fromUuid;
    globalThis.fromUuidSync = previous.fromUuidSync;
  }
});
