import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalGlobals = Object.fromEntries(
  ["CONFIG", "Hooks", "canvas", "foundry", "game", "window"].map(key => [key, globalThis[key]])
);
const hookCallbacks = new Map();
const scheduledTimers = new Map();
let nextTimerId = 1;

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class ApplicationV2 {},
      DialogV2: {},
      HandlebarsApplicationMixin: Base => class extends Base {}
    },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    flattenObject: value => value,
    mergeObject: (target, source) => ({ ...target, ...source }),
    randomID: () => "test-id"
  }
};
globalThis.CONFIG = {
  Canvas: { detectionModes: {} },
  Token: { movement: null },
  specialStatusEffects: { DEFEATED: "defeated", INVISIBLE: "invisible" }
};
globalThis.Hooks = {
  on(name, callback) {
    const callbacks = hookCallbacks.get(name) ?? [];
    callbacks.push(callback);
    hookCallbacks.set(name, callbacks);
    return callbacks.length;
  },
  once(name, callback) {
    return this.on(name, callback);
  }
};
globalThis.game = {
  ready: false,
  socket: {},
  user: { id: "user", isGM: false },
  users: { contents: [] }
};
globalThis.window = {
  clearTimeout(id) {
    scheduledTimers.delete(id);
  },
  setTimeout(callback, delay) {
    const id = nextTimerId;
    nextTimerId += 1;
    scheduledTimers.set(id, { callback, delay });
    return id;
  }
};

const { registerStealthHooks } = await import("../src/stealth/controller.mjs");
const {
  analyzeLightingPoint,
  getLightingAnalysisCacheStats,
  invalidateLightingAnalysisCache
} = await import("../src/stealth/lighting.mjs");

after(() => {
  hookCallbacks.get("canvasTearDown")?.at(0)?.();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

test("runtime perception hooks invalidate immediately only when their logical signature changes", () => {
  registerStealthHooks();
  const lightingRefresh = hookCallbacks.get("lightingRefresh")?.at(0);
  const sightRefresh = hookCallbacks.get("sightRefresh")?.at(0);
  assert.equal(typeof lightingRefresh, "function");
  assert.equal(typeof sightRefresh, "function");

  const source = {
    sourceId: "Token.light",
    updateId: 1,
    active: true,
    shape: {},
    origin: { x: 0, y: 0, elevation: 0 },
    data: { bright: 0, dim: 100, radius: 100, priority: 0, darkness: { min: 0, max: 1 } },
    testPoint: () => true
  };
  const mesh = {
    name: "Region.darkness",
    geometry: {},
    region: {
      animationState: { shapes: {}, elevation: { bottom: 0, top: 10 } }
    },
    shader: {
      mode: 0,
      modifier: 0.2,
      darknessLevel: 0.2,
      uniforms: { darknessLevel: 0.2, time: 0 }
    }
  };
  let lightSurfaces = Object.freeze([]);
  let sightSurfaces = Object.freeze([]);
  globalThis.canvas = {
    ready: true,
    level: { id: "ground" },
    scene: {
      id: "scene",
      getSurfaces: ({ type }) => type === "light" ? lightSurfaces : sightSurfaces
    },
    grid: { size: 100 },
    tokens: { placeables: [] },
    environment: {
      darknessLevel: 1,
      globalLightSource: { sourceId: "GlobalLight", updateId: 1, active: false, data: { darkness: { min: 0, max: 1 } } }
    },
    effects: {
      lightSources: new Map([[source.sourceId, source]]),
      darknessSources: new Map(),
      illumination: { darknessLevelMeshes: { children: [mesh] } },
      getDarknessLevel: () => 1,
      testInsideDarkness: () => false
    }
  };

  lightingRefresh();
  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  assert.equal(getLightingAnalysisCacheStats().point.entries, 1);
  const baselineTimerId = [...scheduledTimers.keys()].at(0);

  source.animationTime = 1;
  mesh.shader.uniforms.time = 1;
  sightRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 1);
  assert.deepEqual([...scheduledTimers.keys()], [baselineTimerId]);

  source.updateId += 1;
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 0);
  assert.equal(scheduledTimers.size, 1);

  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  sightRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 1);
  sightSurfaces = Object.freeze([...sightSurfaces]);
  sightRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 0);

  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  mesh.shader.modifier = 0.4;
  mesh.shader.darknessLevel = 0.4;
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 0);
  assert.equal(scheduledTimers.size, 1);

  // Keep references live so accidental optimizer-like rewrites cannot erase
  // either surface branch from the fixture.
  assert.equal(lightSurfaces.length, 0);
  invalidateLightingAnalysisCache();
});
