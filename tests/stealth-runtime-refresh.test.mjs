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
const {
  canRenderDetectionVisualizationForLocalUser,
  getStealthVisualizationStats
} = await import("../src/stealth/visualization.mjs");

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

test("persistent detection visualization follows local permission, visibility, reveal, delete, and teardown", () => {
  registerStealthHooks();
  const canvasReady = hookCallbacks.get("canvasReady")?.at(0);
  const refreshToken = hookCallbacks.get("refreshToken")?.at(0);
  const updateActor = hookCallbacks.get("updateActor")?.at(0);
  const deleteToken = hookCallbacks.get("deleteToken")?.at(0);
  const canvasTearDown = hookCallbacks.get("canvasTearDown")?.at(0);
  assert.equal(typeof canvasReady, "function");
  assert.equal(typeof refreshToken, "function");
  assert.equal(typeof updateActor, "function");
  assert.equal(typeof deleteToken, "function");
  assert.equal(typeof canvasTearDown, "function");

  canvasTearDown();
  scheduledTimers.clear();

  const ownedActor = {
    uuid: "Actor.owned",
    statuses: new Set(["invisible"]),
    testUserPermission: (_user, permission) => permission === "OWNER"
  };
  const foreignActor = {
    uuid: "Actor.foreign",
    statuses: new Set(["invisible"]),
    testUserPermission: () => false
  };
  const ownedToken = {
    id: "owned-hidden",
    actor: ownedActor,
    document: {
      hidden: false,
      parent: { id: "scene", documentName: "Scene" }
    },
    visible: true,
    renderable: true
  };
  const foreignToken = {
    id: "foreign-hidden",
    actor: foreignActor,
    document: {
      hidden: false,
      parent: { id: "scene", documentName: "Scene" }
    },
    visible: true,
    renderable: true
  };
  const tokenMap = new Map([
    [ownedToken.id, ownedToken],
    [foreignToken.id, foreignToken]
  ]);
  globalThis.canvas = {
    ready: true,
    level: { id: "ground" },
    scene: {
      id: "scene",
      getSurfaces: () => Object.freeze([])
    },
    grid: { size: 100 },
    tokens: {
      placeables: [...tokenMap.values()],
      get: tokenId => tokenMap.get(tokenId)
    },
    environment: {
      darknessLevel: 1,
      globalLightSource: { sourceId: "GlobalLight", active: false, data: { darkness: { min: 0, max: 1 } } }
    },
    effects: {
      lightSources: new Map(),
      darknessSources: new Map(),
      illumination: { darknessLevelMeshes: { children: [] } },
      getDarknessLevel: () => 1,
      testInsideDarkness: () => false
    }
  };

  canvasReady();
  assert.deepEqual(pickVisualizationSourceStats(), { active: 1, sources: 1 });

  ownedToken.visible = false;
  refreshToken(ownedToken);
  assert.deepEqual(pickVisualizationSourceStats(), { active: 0, sources: 0 });

  ownedToken.visible = true;
  refreshToken(ownedToken);
  assert.deepEqual(pickVisualizationSourceStats(), { active: 1, sources: 1 });

  ownedToken.document.hidden = true;
  assert.equal(canRenderDetectionVisualizationForLocalUser(ownedToken), false);
  refreshToken(ownedToken);
  assert.deepEqual(pickVisualizationSourceStats(), { active: 0, sources: 0 });

  globalThis.game.user.isGM = true;
  assert.equal(canRenderDetectionVisualizationForLocalUser(ownedToken), true);
  refreshToken(ownedToken);
  assert.deepEqual(pickVisualizationSourceStats(), { active: 1, sources: 1 });
  globalThis.game.user.isGM = false;
  ownedToken.document.hidden = false;

  ownedActor.statuses.delete("invisible");
  updateActor(ownedActor, { statuses: [] });
  assert.deepEqual(pickVisualizationSourceStats(), { active: 0, sources: 0 });

  ownedActor.statuses.add("invisible");
  updateActor(ownedActor, { statuses: ["invisible"] });
  assert.deepEqual(pickVisualizationSourceStats(), { active: 1, sources: 1 });

  deleteToken({ id: ownedToken.id });
  assert.deepEqual(pickVisualizationSourceStats(), { active: 0, sources: 0 });

  refreshToken(ownedToken);
  assert.deepEqual(pickVisualizationSourceStats(), { active: 1, sources: 1 });
  canvasTearDown();
  assert.deepEqual(pickVisualizationSourceStats(), { active: 0, sources: 0 });
});

test("stealth detection pauses outside combat but not while the current combat is started", () => {
  const socketHandlers = new Map();
  let pauses = 0;
  globalThis.game = {
    ready: true,
    paused: false,
    combat: null,
    combats: [],
    socket: {
      on(name, callback) {
        socketHandlers.set(name, callback);
      }
    },
    togglePause(paused, options) {
      pauses += 1;
      assert.equal(paused, true);
      assert.deepEqual(options, { broadcast: true });
    },
    user: { id: "gm", isGM: true },
    users: { contents: [] }
  };

  hookCallbacks.get("ready")?.at(0)?.();
  const handleSocketMessage = socketHandlers.get("system.fallout-maw");
  assert.equal(typeof handleSocketMessage, "function");
  const message = {
    scope: "fallout-maw.stealth",
    action: "pauseDetection",
    gmUserId: "gm",
    senderUserId: "player"
  };

  handleSocketMessage(message, "player");
  assert.equal(pauses, 1);

  globalThis.game.combat = { started: true };
  handleSocketMessage(message, "player");
  assert.equal(pauses, 1);
});

function pickVisualizationSourceStats() {
  const stats = getStealthVisualizationStats();
  return { active: stats.active, sources: stats.sources };
}
