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

test("runtime perception hooks invalidate immediately only when their logical signature changes", async () => {
  registerStealthHooks();
  const lightingRefresh = hookCallbacks.get("lightingRefresh")?.at(0);
  const sightRefresh = hookCallbacks.get("sightRefresh")?.at(0);
  const updateScene = hookCallbacks.get("updateScene")?.at(0);
  const smokeRegionAnimation = hookCallbacks.get("fallout-maw.smokeRegionAnimation")?.at(0);
  const smokeNativePerceptionRefresh = hookCallbacks.get("fallout-maw.smokeNativePerceptionRefresh")?.at(0);
  assert.equal(typeof lightingRefresh, "function");
  assert.equal(typeof sightRefresh, "function");
  assert.equal(typeof updateScene, "function");
  assert.equal(typeof smokeRegionAnimation, "function");
  assert.equal(typeof smokeNativePerceptionRefresh, "function");

  const source = {
    sourceId: "Token.light",
    updateId: 1,
    active: true,
    shape: {},
    origin: { x: 0, y: 0, elevation: 0 },
    data: { bright: 0, dim: 100, radius: 100, priority: 0, darkness: { min: 0, max: 1 } },
    testPoint: () => true
  };
  const visionSource = {
    sourceId: "Token.vision",
    updateId: 1,
    active: true,
    suppressed: false,
    shape: {},
    origin: { x: 0, y: 0, elevation: 0 },
    data: { radius: 100, priority: 0 }
  };
  const attachedToken = { x: 0, y: 0, elevation: 0, rotation: 0 };
  const mesh = {
    name: "Region.darkness",
    geometry: {},
    region: {
      isAnimating: false,
      document: { attachment: { token: attachedToken } },
      animationState: {
        shapes: {},
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        elevation: { bottom: 0, top: 10 }
      }
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
  let surfaceReads = 0;
  let lightSourceIterations = 0;
  const lightSources = new Map([[source.sourceId, source]]);
  const iterateLightSources = lightSources.values.bind(lightSources);
  lightSources.values = function values() {
    lightSourceIterations += 1;
    return iterateLightSources();
  };
  globalThis.canvas = {
    ready: true,
    level: { id: "ground" },
    scene: {
      id: "scene",
      documentName: "Scene",
      getSurfaces: ({ type }) => {
        surfaceReads += 1;
        return type === "light" ? lightSurfaces : sightSurfaces;
      }
    },
    grid: { size: 100 },
    tokens: { placeables: [] },
    environment: {
      darknessLevel: 1,
      globalLightSource: { sourceId: "GlobalLight", updateId: 1, active: false, data: { darkness: { min: 0, max: 1 } } }
    },
    effects: {
      lightSources,
      darknessSources: new Map(),
      visionSources: new Map([[visionSource.sourceId, visionSource]]),
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
  lightingRefresh();
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

  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  mesh.region.isAnimating = true;
  attachedToken.x = 25;
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 0);

  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 1);
  attachedToken.rotation = 15;
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 0);

  const surfaceToken = { x: 0, y: 0, elevation: 0, rotation: 0 };
  const surfaceRegion = {
    attachment: { token: surfaceToken },
    object: {
      isAnimating: false,
      animationState: { bounds: { x: 0, y: 0, width: 100, height: 100 }, elevation: { bottom: 0, top: 0 } }
    }
  };
  const notifySmokeNativeRefresh = ({
    sources = [source],
    expectLighting = true,
    expectSight = true
  } = {}) => smokeNativePerceptionRefresh({
    scene: globalThis.canvas.scene,
    revision: 0,
    sources: sources.map(entry => ({
      source: entry,
      collectionName: entry === visionSource ? "visionSources" : "lightSources",
      sourceId: entry.sourceId,
      updateId: entry.updateId,
      active: Boolean(entry.active),
      suppressed: Boolean(entry.suppressed)
    })),
    expectLighting,
    expectSight
  });
  surfaceRegion.object.document = surfaceRegion;
  lightSurfaces = Object.freeze([{ region: surfaceRegion }]);
  lightingRefresh();
  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  surfaceRegion.object.isAnimating = true;
  surfaceToken.y = 25;
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 0);

  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().point.entries, 1);

  // Keep references live so accidental optimizer-like rewrites cannot erase
  // either surface branch from the fixture.
  assert.equal(lightSurfaces.length, 1);

  const smokeRegion = { documentName: "Region", parent: globalThis.canvas.scene };
  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  let invalidations = getLightingAnalysisCacheStats().invalidations;
  smokeRegionAnimation(smokeRegion);
  assert.equal(getLightingAnalysisCacheStats().invalidations, invalidations + 1);
  source.updateId += 1;
  lightSourceIterations = 0;
  surfaceReads = 0;
  notifySmokeNativeRefresh({ expectSight: false });
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().invalidations, invalidations + 1);
  assert.equal(lightSourceIterations, 0);
  assert.equal(surfaceReads, 0);

  // Both native phases may share one guard; consuming lighting must preserve
  // the exact sight phase until it runs later in the same ticker frame.
  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  invalidations = getLightingAnalysisCacheStats().invalidations;
  smokeRegionAnimation(smokeRegion);
  source.updateId += 1;
  visionSource.updateId += 1;
  notifySmokeNativeRefresh({ sources: [source, visionSource] });
  lightSourceIterations = 0;
  surfaceReads = 0;
  lightingRefresh();
  sightRefresh();
  assert.equal(getLightingAnalysisCacheStats().invalidations, invalidations + 1);
  assert.equal(lightSourceIterations, 0);
  assert.equal(surfaceReads, 0);

  // A smoke carrier without an active light source can yield sightRefresh
  // without a preceding lightingRefresh. The smoke-only guard must settle in
  // that same frame instead of swallowing an unrelated future light change.
  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  invalidations = getLightingAnalysisCacheStats().invalidations;
  smokeRegionAnimation(smokeRegion);
  lightSourceIterations = 0;
  surfaceReads = 0;
  notifySmokeNativeRefresh({ sources: [], expectLighting: false });
  sightRefresh();
  assert.equal(getLightingAnalysisCacheStats().invalidations, invalidations + 1);
  assert.equal(lightSourceIterations, 0);
  assert.equal(surfaceReads, 0);
  source.updateId += 1;
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().invalidations, invalidations + 2);

  analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });
  invalidations = getLightingAnalysisCacheStats().invalidations;
  smokeRegionAnimation(smokeRegion);
  source.updateId += 1;
  notifySmokeNativeRefresh({ expectSight: false });
  source.data.dim += 25;
  lightSourceIterations = 0;
  lightingRefresh();
  assert.equal(getLightingAnalysisCacheStats().invalidations, invalidations + 2);
  assert.ok(lightSourceIterations > 0);

  // A relevant Canvas/Document hook cancels the guard before the native hook.
  notifySmokeNativeRefresh({ expectSight: false });
  updateScene(globalThis.canvas.scene, { unrelated: true });
  lightSourceIterations = 0;
  lightingRefresh();
  assert.ok(lightSourceIterations > 0);

  // The guard is strictly same-turn and cannot consume a later native frame.
  notifySmokeNativeRefresh({ expectSight: false });
  await Promise.resolve();
  lightSourceIterations = 0;
  lightingRefresh();
  assert.ok(lightSourceIterations > 0);
  invalidateLightingAnalysisCache();
});

test("semantic vision effects refresh stealth only when their document changes", () => {
  registerStealthHooks();
  const createActiveEffect = hookCallbacks.get("createActiveEffect")?.at(0);
  const deleteActiveEffect = hookCallbacks.get("deleteActiveEffect")?.at(0);
  const canvasTearDown = hookCallbacks.get("canvasTearDown")?.at(0);
  assert.equal(typeof createActiveEffect, "function");
  assert.equal(typeof deleteActiveEffect, "function");

  canvasTearDown();
  scheduledTimers.clear();
  globalThis.canvas = {
    ready: true,
    tokens: { placeables: [], get: () => null }
  };
  const actor = { uuid: "Actor.observer", statuses: new Set() };
  const ordinaryEffect = {
    parent: actor,
    statuses: new Set(),
    system: { changes: [{ key: "system.unrelated" }] }
  };
  const visionEffect = {
    parent: actor,
    statuses: new Set(),
    system: {
      changes: [{ key: "fallout-maw.vision.detectionModes.basicSight.range" }]
    }
  };

  createActiveEffect(ordinaryEffect);
  assert.equal(scheduledTimers.size, 0);
  createActiveEffect({
    parent: actor,
    statuses: new Set(["prone"]),
    system: { changes: [] }
  });
  assert.equal(scheduledTimers.size, 0);
  createActiveEffect(visionEffect);
  assert.equal(scheduledTimers.size, 1);

  canvasTearDown();
  scheduledTimers.clear();
  deleteActiveEffect(visionEffect);
  assert.equal(scheduledTimers.size, 1);
  canvasTearDown();
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
  let ownedIsVisibleReads = 0;
  Object.defineProperty(ownedToken, "isVisible", {
    configurable: true,
    get() {
      ownedIsVisibleReads += 1;
      return ownedToken.visible;
    }
  });
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
      controlled: [ownedToken],
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
  assert.equal(ownedIsVisibleReads, 0);

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
  assert.equal(canRenderDetectionVisualizationForLocalUser(ownedToken), false);
  refreshToken(ownedToken);
  assert.deepEqual(pickVisualizationSourceStats(), { active: 0, sources: 0 });
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
  assert.equal(ownedIsVisibleReads, 0);
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
