import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultRegionSpecialPropertyData,
  normalizeRegionSpecialProperties,
  resolveRegionSpecialProperties
} from "../src/utils/region-special-properties.mjs";
import {
  calculateSmokePathCost,
  getSmokeLightBandAtPoint,
  getSmokeRegionIndex,
  getSmokeRegionRevision,
  invalidateSmokeRegionIndex,
  measureSmokePath,
  notifySmokeRegionAnimation,
  peekSmokeRegionRevision,
  registerSmokeVisionHooks,
  syncSmokeDarknessMeshes
} from "../src/canvas/smoke-vision.mjs";
import {
  getMaximumCircleRadiusPixels,
  getSphericalRegionCenterElevation,
  getSphericalRegionElevation,
  getSphericalRegionFlags
} from "../src/utils/region-elevation.mjs";
import {
  getActorSmokeDensityAdjustment,
  getActorSmokePerceptionPercent,
  invalidateActorSmokePerception,
  SMOKE_PERCEPTION_PERCENT_EFFECT_KEY
} from "../src/canvas/smoke-perception.mjs";
import { createObserverOrdinaryVisionMask } from "../src/canvas/physical-los.mjs";

test("automatic blast Regions use radius-sized vertical elevation bounds", () => {
  const scene = { grid: { distance: 1, size: 100 } };
  assert.deepEqual(getSphericalRegionElevation(12, 400, scene), {
    bottom: 8,
    top: 16
  });
  const flags = getSphericalRegionFlags(12);
  const region = {
    getFlag: (scope, key) => flags[scope]?.[key]
  };
  assert.equal(getSphericalRegionCenterElevation(region), 12);
  assert.equal(getMaximumCircleRadiusPixels([
    { type: "rectangle", width: 900 },
    { type: "circle", radius: 250 },
    { type: "circle", radius: 400 }
  ]), 400);
});

test("area special properties keep one selectable row and do not duplicate smoke", () => {
  assert.deepEqual(normalizeRegionSpecialProperties([
    { type: "smoke", smoke: { thickness: "", densityPercent: "" } },
    { type: "smoke", smoke: { thickness: "0.2", densityPercent: "90" } }
  ]), [{
    type: "smoke",
    smoke: { thickness: "1", densityPercent: "50" }
  }]);
  assert.deepEqual(normalizeRegionSpecialProperties([{ type: "unknown" }]), [{
    type: "pending",
    smoke: { thickness: "1", densityPercent: "50" }
  }]);
  assert.deepEqual(createDefaultRegionSpecialPropertyData(), {
    type: "pending",
    smoke: { thickness: "1", densityPercent: "50" }
  });
  assert.deepEqual(resolveRegionSpecialProperties([{ type: "pending" }]), []);
});

test("smoke runtime values clamp thickness and density", () => {
  assert.deepEqual(resolveRegionSpecialProperties([
    { type: "smoke", smoke: { thickness: "2", densityPercent: "125" } }
  ]), [{
    type: "smoke",
    smoke: { thickness: 1, density: 1, densityPercent: 100 }
  }]);
});

test("attached smoke animation invalidates once per native transform and follows animated elevation", async () => {
  const previous = {
    Hooks: globalThis.Hooks,
    canvas: globalThis.canvas,
    game: globalThis.game,
    PIXI: globalThis.PIXI
  };
  const region = createSmokeRegion("animated", 100);
  const scene = createScene([region]);
  const attachedToken = { x: 0, y: 0, elevation: 10, rotation: 0 };
  region.parent = scene;
  region.attachment = { token: attachedToken };
  region.object.document = region;
  region.object.isAnimating = true;
  region.object.animationState = {
    elevation: { bottom: 10, top: 20 },
    polygonTree: {
      polygons: region.polygons,
      testPoint: ({ x, y }) => Math.hypot(x - 5, y) <= 20
    }
  };
  let notifications = 0;
  let nativeRefreshHooks = 0;
  let lightingRefreshHooks = 0;
  const tickerCallbacks = [];
  globalThis.Hooks = {
    callAll(name, document, context) {
      if (name === "fallout-maw.smokeNativePerceptionRefresh") {
        nativeRefreshHooks += 1;
        return;
      }
      if (name === "lightingRefresh") {
        assert.equal(context.source, "fallout-maw");
        assert.equal(context.smokeSelective, true);
        lightingRefreshHooks += 1;
        return;
      }
      assert.equal(name, "fallout-maw.smokeRegionAnimation");
      assert.equal(document, region);
      notifications += 1;
    }
  };
  globalThis.game = { time: { worldTime: 0 } };
  globalThis.PIXI = {
    Circle: { approximateVertexDensity: () => 32 },
    UPDATE_PRIORITY: { OBJECTS: 50, PERCEPTION: 2 }
  };
  globalThis.canvas = {
    ready: true,
    scene,
    app: {
      ticker: {
        add(callback, context, priority) {
          tickerCallbacks.push({ callback, context, priority });
        },
        remove() {}
      }
    },
    effects: {
      lightSources: new Set(),
      darknessSources: new Set(),
      visionSources: new Set(),
      illumination: { invalidateDarknessLevelContainer() {} }
    },
    fog: { sharedExploration: false },
    perception: { update() {} },
    dimensions: { maxR: 10_000 }
  };

  try {
    const baselineRevision = getSmokeRegionRevision(scene);
    assert.equal(notifySmokeRegionAnimation(region.object), true);
    assert.equal(notifySmokeRegionAnimation(region.object), false);
    assert.equal(getSmokeRegionRevision(scene), baselineRevision);
    assert.deepEqual(tickerCallbacks.map(({ priority }) => priority), [50.5, 2.5]);
    tickerCallbacks[0].callback.call(tickerCallbacks[0].context);
    const firstRevision = getSmokeRegionRevision(scene);
    assert.ok(firstRevision > baselineRevision);
    tickerCallbacks[1].callback.call(tickerCallbacks[1].context);
    assert.equal(nativeRefreshHooks, 1);
    assert.equal(lightingRefreshHooks, 1);

    // Native animation frames are separate tasks. Allow the scene-level
    // coalescer to close this frame before simulating the next one.
    await Promise.resolve();
    attachedToken.x = 25;
    assert.equal(notifySmokeRegionAnimation(region.object), true);
    tickerCallbacks[0].callback.call(tickerCallbacks[0].context);
    assert.ok(getSmokeRegionRevision(scene) > firstRevision);
    assert.equal(notifications, 2);
    tickerCallbacks[1].callback.call(tickerCallbacks[1].context);
    assert.equal(nativeRefreshHooks, 2);
    assert.equal(lightingRefreshHooks, 2);

    assert.equal(calculateSmokePathCost(
      { x: 0, y: 0, elevation: 0 },
      { x: 10, y: 0, elevation: 0 },
      { scene, elevation: 0 }
    ), 10);
    assert.equal(calculateSmokePathCost(
      { x: 0, y: 0, elevation: 15 },
      { x: 10, y: 0, elevation: 15 },
      { scene, elevation: 15 }
    ), Infinity);
  } finally {
    invalidateSmokeRegionIndex(scene);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("smoke index reuses PolygonTree geometry and prepares each active Region once", () => {
  const createCountingPolygonTree = (points, onPoints) => {
    const polygon = {};
    Object.defineProperty(polygon, "points", {
      configurable: true,
      get() {
        onPoints();
        return points;
      }
    });
    return { polygons: [polygon], testPoint: () => true };
  };
  const squareAt = x => [x, 0, x + 10, 0, x + 10, 10, x, 10];
  const staticRegion = createSmokeRegion("geometry-static", 50);
  const animatedRegion = createSmokeRegion("geometry-animated", 50);
  const firstBehavior = staticRegion.behaviors.contents[0];
  staticRegion.behaviors.contents.push({
    ...firstBehavior,
    uuid: "Behavior.geometry-static-second"
  });

  let staticBoundsReads = 0;
  let staticPointReads = 0;
  let firstAnimatedPointReads = 0;
  let secondAnimatedPointReads = 0;
  let replacementStaticPointReads = 0;
  Object.defineProperty(staticRegion.object, "bounds", {
    configurable: true,
    get() {
      staticBoundsReads += 1;
      return { x: 0, y: 0, width: 10, height: 10 };
    }
  });
  staticRegion.polygonTree = createCountingPolygonTree(squareAt(0), () => { staticPointReads += 1; });
  animatedRegion.object.animationState = {
    polygonTree: createCountingPolygonTree(squareAt(20), () => { firstAnimatedPointReads += 1; })
  };
  const scene = createScene([staticRegion, animatedRegion]);

  try {
    const firstIndex = getSmokeRegionIndex(scene);
    const firstStaticEntries = firstIndex.entries.filter(entry => entry.region === staticRegion);
    assert.equal(firstStaticEntries.length, 2);
    assert.equal(firstStaticEntries[0].bounds, firstStaticEntries[1].bounds);
    assert.equal(firstStaticEntries[0].geometry, firstStaticEntries[1].geometry);
    assert.equal(staticBoundsReads, 1, "one Region bounds read serves all active smoke behaviors");
    assert.equal(staticPointReads, 1);
    assert.equal(firstAnimatedPointReads, 1);

    animatedRegion.object.animationState = {
      polygonTree: createCountingPolygonTree(squareAt(30), () => { secondAnimatedPointReads += 1; })
    };
    invalidateSmokeRegionIndex(scene);
    getSmokeRegionIndex(scene);
    assert.equal(staticBoundsReads, 2, "a full index rebuild still reads static bounds only once per Region");
    assert.equal(staticPointReads, 1, "unchanged static PolygonTree segments are reused");
    assert.equal(firstAnimatedPointReads, 1);
    assert.equal(secondAnimatedPointReads, 1, "a new animated PolygonTree rebuilds its geometry");

    staticRegion.polygonTree = createCountingPolygonTree(squareAt(5), () => { replacementStaticPointReads += 1; });
    invalidateSmokeRegionIndex(scene);
    getSmokeRegionIndex(scene);
    assert.equal(staticPointReads, 1);
    assert.equal(replacementStaticPointReads, 1, "a replaced static PolygonTree cannot reuse stale geometry");
    assert.equal(secondAnimatedPointReads, 1, "the unchanged animated PolygonTree is reused too");
  } finally {
    invalidateSmokeRegionIndex(scene);
  }
});

test("native attached smoke frames coalesce on the required Canvas ticker", () => {
  const previous = {
    canvas: globalThis.canvas,
    game: globalThis.game,
    foundry: globalThis.foundry,
    CONST: globalThis.CONST,
    CONFIG: globalThis.CONFIG,
    Hooks: globalThis.Hooks,
    PIXI: globalThis.PIXI
  };
  const firstRegion = createSmokeRegion("animated-native-a", 100);
  const secondRegion = createSmokeRegion("animated-native-b", 50);
  const scene = createScene([firstRegion, secondRegion]);
  const attachedToken = { x: 25, y: 10, elevation: 5, rotation: 0 };
  let nativeFrames = 0;
  let hookCalls = 0;
  let nativeRefreshHooks = 0;
  let lightingRefreshHooks = 0;
  let darknessInvalidations = 0;
  let visibilityRefreshes = 0;
  const perceptionUpdates = [];
  const tickerCallbacks = [];
  const meshes = { addChild() {} };

  class NativeRegion {
    constructor(document) {
      this.document = document;
      this.bounds = document.object.bounds;
      this.isAnimating = true;
      document.object = this;
    }

    _onTokenAnimationFrame() {
      nativeFrames += 1;
      return "native-result";
    }
  }

  class RegionMesh {
    constructor() { this.shader = {}; }
    destroy() {}
  }

  for (const region of scene.regions.contents) {
    region.parent = scene;
    region.attachment = { token: attachedToken };
    new NativeRegion(region);
  }

  try {
    globalThis.game = { time: { worldTime: 0 } };
    globalThis.CONST = { CANVAS_PERFORMANCE_MODES: { LOW: 1 } };
    globalThis.CONFIG = { Canvas: { detectionModes: {} } };
    globalThis.PIXI = {
      Circle: { approximateVertexDensity: () => 32 },
      UPDATE_PRIORITY: { OBJECTS: 50, PERCEPTION: 2 }
    };
    globalThis.foundry = {
      canvas: {
        placeables: { Region: NativeRegion, regions: { RegionMesh } },
        rendering: {
          shaders: {
            AdjustDarknessLevelRegionShader: class {},
            IlluminationDarknessLevelRegionShader: class {}
          }
        }
      }
    };
    globalThis.Hooks = {
      on() {},
      callAll(name) {
        if (name === "fallout-maw.smokeNativePerceptionRefresh") {
          nativeRefreshHooks += 1;
          return;
        }
        if (name === "lightingRefresh") {
          lightingRefreshHooks += 1;
          return;
        }
        assert.equal(name, "fallout-maw.smokeRegionAnimation");
        hookCalls += 1;
      }
    };
    globalThis.canvas = {
      ready: true,
      scene,
      app: {
        ticker: {
          add(callback, context, priority) {
            tickerCallbacks.push({ callback, context, priority });
          },
          remove(callback) {
            const index = tickerCallbacks.findIndex(entry => entry.callback === callback);
            if (index >= 0) tickerCallbacks.splice(index, 1);
          }
        }
      },
      effects: {
        lightSources: new Set(),
        darknessSources: new Set(),
        visionSources: new Set(),
        illumination: {
          darknessLevelMeshes: meshes,
          invalidateDarknessLevelContainer(force) {
            assert.equal(force, true);
            darknessInvalidations += 1;
          }
        }
      },
      visibility: {
        vision: { light: { global: { meshes } } },
        refresh() { visibilityRefreshes += 1; }
      },
      performance: { mode: 0 },
      fog: { sharedExploration: false },
      environment: { globalLightSource: { active: true } },
      perception: { update: flags => perceptionUpdates.push(flags) }
    };

    registerSmokeVisionHooks();
    const baselineRevision = peekSmokeRegionRevision(scene);
    assert.equal(firstRegion.object._onTokenAnimationFrame(), "native-result");
    assert.equal(secondRegion.object._onTokenAnimationFrame(), "native-result");
    assert.equal(nativeFrames, 2);
    assert.equal(peekSmokeRegionRevision(scene), baselineRevision + 1);
    assert.equal(hookCalls, 0);
    assert.deepEqual(tickerCallbacks.map(({ priority }) => priority), [50.5, 2.5]);

    tickerCallbacks[0].callback.call(tickerCallbacks[0].context);
    tickerCallbacks[1].callback.call(tickerCallbacks[1].context);
    assert.equal(hookCalls, 2);
    assert.equal(darknessInvalidations, 1);
    assert.equal(nativeRefreshHooks, 1);
    assert.equal(lightingRefreshHooks, 1);
    assert.equal(visibilityRefreshes, 0, "thickness-only movement uses the native darkness texture invalidation");
    assert.deepEqual(perceptionUpdates, []);
  } finally {
    if (globalThis.canvas?.scene === scene) {
      globalThis.canvas.scene = createScene([]);
      syncSmokeDarknessMeshes({ forceRendering: true, forceVision: true });
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("same-frame attached smoke refresh initializes endpoint and scene-wide sources only", () => {
  const previous = {
    canvas: globalThis.canvas,
    game: globalThis.game,
    foundry: globalThis.foundry,
    CONFIG: globalThis.CONFIG,
    Hooks: globalThis.Hooks,
    PIXI: globalThis.PIXI
  };
  const region = createSmokeRegion("animated-selective", 50);
  const scene = createScene([region]);
  const attachedToken = { x: 1_000, y: 1_000, elevation: 0, rotation: 0 };
  const tickerCallbacks = [];
  const hookCallbacks = new Map();
  const perceptionUpdates = [];
  let darknessInvalidations = 0;
  let nativeRefreshHooks = 0;
  let lightingRefreshHooks = 0;
  let refreshLightingCalls = 0;
  let initializeLightSourcesCalls = 0;

  class SmokeVisionSource {
    static __falloutMawSmokeVisionSource = true;
    static effectsCollection = "visionSources";

    constructor(x, y = 0, { radius = 100, lightRadius = radius } = {}) {
      this.active = true;
      this.attached = true;
      this.data = { x, y, elevation: 0, externalRadius: radius };
      this.radius = radius;
      this.lightRadius = lightRadius;
      this.los = { config: { radius } };
      this.shape = { config: { radius } };
      this.sourceId = `Vision.${x}.${y}.${lightRadius}`;
      this.updateId = 0;
      this.suppressed = false;
      this.preferred = false;
      this.visionMode = null;
      this.initializeCalls = 0;
      this.refreshCalls = 0;
      installNativeSourceRenderMock(this, ["background", "illumination", "coloration"]);
    }

    initialize() {
      this.initializeCalls += 1;
      this.updateId += 1;
      this.shape = { config: { radius: this.radius } };
    }

    refresh() { this.refreshCalls += 1; }
  }

  class SmokeLightSource {
    static __falloutMawSmokeLightSource = true;
    static effectsCollection = "lightSources";

    constructor(x, y = 0, radius = 100) {
      this.active = true;
      this.attached = true;
      this.data = { x, y, elevation: 0, bright: radius, dim: radius, priority: 0 };
      this.radius = radius;
      this.shape = { config: { radius } };
      this.sourceId = `Light.${x}.${y}`;
      this.updateId = 0;
      this.suppressed = false;
      this.initializeCalls = 0;
      this.refreshCalls = 0;
      installNativeSourceRenderMock(this, ["background", "illumination", "coloration"]);
    }

    initialize() {
      this.initializeCalls += 1;
      this.updateId += 1;
      this.shape = { config: { radius: this.radius } };
    }

    refresh() { this.refreshCalls += 1; }
  }

  const oldVision = new SmokeVisionSource(0, 0);
  const newVision = new SmokeVisionSource(1_000, 1_000);
  const midVision = new SmokeVisionSource(500, 500);
  const farVision = new SmokeVisionSource(2_000, 2_000);
  const sceneWideVision = new SmokeVisionSource(2_000, 0, { lightRadius: Infinity });
  const oldLight = new SmokeLightSource(0, 0);
  const newLight = new SmokeLightSource(1_000, 1_000);
  const midLight = new SmokeLightSource(500, 500);
  const farLight = new SmokeLightSource(2_000, 2_000);
  region.parent = scene;
  region.attachment = { token: attachedToken };
  region.object.isAnimating = true;
  region.object.bounds = { x: 980, y: 980, width: 40, height: 40 };

  try {
    globalThis.game = { time: { worldTime: 0 } };
    globalThis.CONFIG = {
      Canvas: {
        detectionModes: {},
        visionSourceClass: SmokeVisionSource,
        lightSourceClass: SmokeLightSource
      }
    };
    globalThis.foundry = {};
    globalThis.PIXI = {
      Circle: { approximateVertexDensity: () => 32 },
      UPDATE_PRIORITY: { OBJECTS: 50, PERCEPTION: 2 }
    };
    globalThis.Hooks = {
      on(name, callback) {
        const callbacks = hookCallbacks.get(name) ?? [];
        callbacks.push(callback);
        hookCallbacks.set(name, callbacks);
      },
      callAll(name) {
        if (name === "fallout-maw.smokeNativePerceptionRefresh") nativeRefreshHooks += 1;
        if (name === "lightingRefresh") lightingRefreshHooks += 1;
      }
    };
    globalThis.canvas = {
      ready: true,
      scene,
      app: {
        ticker: {
          add(callback, context, priority) {
            tickerCallbacks.push({ callback, context, priority });
          },
          remove(callback) {
            const index = tickerCallbacks.findIndex(entry => entry.callback === callback);
            if (index >= 0) tickerCallbacks.splice(index, 1);
          }
        }
      },
      effects: {
        lightSources: createSourceCollection([oldLight, newLight, midLight, farLight]),
        darknessSources: createSourceCollection([]),
        visionSources: createSourceCollection([oldVision, newVision, midVision, farVision, sceneWideVision]),
        background: {
          vision: createNativeEffectsContainer(),
          visionPreferred: createNativeEffectsContainer(),
          lighting: createNativeEffectsContainer()
        },
        illumination: Object.assign(createNativeEffectsContainer(), {
          lights: createNativeEffectsContainer(),
          invalidateDarknessLevelContainer(force) {
            assert.equal(force, true);
            darknessInvalidations += 1;
          }
        }),
        coloration: createNativeEffectsContainer(),
        darkness: createNativeEffectsContainer(),
        refreshLighting() { refreshLightingCalls += 1; },
        initializeLightSources() { initializeLightSourcesCalls += 1; }
      },
      visibility: {
        visionModeData: { activeLightingOptions: {} },
        refresh() {}
      },
      masks: { occlusion: { _updateOcclusionMask() {} } },
      fog: { sharedExploration: false },
      perception: {
        renderFlags: new Set(),
        update: flags => perceptionUpdates.push(flags)
      },
      dimensions: { maxR: 10_000 }
    };
    oldLight.active = false;
    const staleInactiveMesh = oldLight.layers.background.mesh;
    globalThis.canvas.effects.background.lighting.addChild(staleInactiveMesh);

    registerSmokeVisionHooks();
    getSmokeRegionRevision(scene);
    assert.equal(notifySmokeRegionAnimation(region, {
      previousState: {
        known: true,
        bounds: { x: -20, y: -20, width: 40, height: 40 }
      }
    }), true);
    assert.deepEqual(tickerCallbacks.map(({ priority }) => priority), [50.5, 2.5]);

    tickerCallbacks[0].callback.call(tickerCallbacks[0].context);

    assert.equal(oldLight.initializeCalls, 0);
    assert.equal(newLight.initializeCalls, 0);
    assert.equal(oldVision.initializeCalls, 0);
    assert.equal(newVision.initializeCalls, 0);
    // Foundry's Token OBJECTS phase runs between the two system ticker phases.
    // A carrier source completed there must not be initialized a second time.
    newLight.initialize();
    newVision.initialize();
    tickerCallbacks[1].callback.call(tickerCallbacks[1].context);

    assert.equal(oldLight.initializeCalls, 1);
    assert.equal(newLight.initializeCalls, 1);
    assert.equal(midLight.initializeCalls, 0, "the empty swept area is not a dependency");
    assert.equal(farLight.initializeCalls, 0);
    assert.equal(oldVision.initializeCalls, 1);
    assert.equal(newVision.initializeCalls, 1);
    assert.equal(midVision.initializeCalls, 0, "the empty swept area is not a dependency");
    assert.equal(farVision.initializeCalls, 0);
    assert.equal(sceneWideVision.initializeCalls, 1, "unlimited light perception remains scene-wide");
    assert.equal(darknessInvalidations, 1);
    assert.equal(nativeRefreshHooks, 1);
    assert.deepEqual(perceptionUpdates, []);
    assert.equal(refreshLightingCalls, 0);
    assert.equal(initializeLightSourcesCalls, 0);
    assert.equal(staleInactiveMesh.parent, null, "inactive native sources cannot re-enter effects containers");
  } finally {
    for (const callback of hookCallbacks.get("canvasTearDown") ?? []) callback();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("shared fog advances only affected native Token source versions", () => {
  const previous = {
    canvas: globalThis.canvas,
    game: globalThis.game,
    foundry: globalThis.foundry,
    CONFIG: globalThis.CONFIG,
    Hooks: globalThis.Hooks,
    PIXI: globalThis.PIXI
  };
  const region = createSmokeRegion("animated-shared-fog", 50);
  const scene = createScene([region]);
  const tickerCallbacks = [];
  const hookCallbacks = new Map();
  const perceptionUpdates = [];
  let refreshLightingCalls = 0;
  let initializeLightSourcesCalls = 0;
  let visibilityRefreshes = 0;
  let occlusionRefreshes = 0;
  const createFogToken = (id, x) => ({
    id,
    sourceId: `Token.${id}`,
    _visionSourceVersion: 4,
    _isFogExplorationSource: () => true,
    _getVisionSourceData: () => ({
      x,
      y: 0,
      radius: 100,
      lightRadius: 100,
      externalRadius: 100
    })
  });
  const nearToken = createFogToken("near", 0);
  const farToken = createFogToken("far", 2_000);
  region.parent = scene;
  region.attachment = { token: { x: 100, y: 0, elevation: 0, rotation: 0 } };
  region.object.isAnimating = true;
  region.object.bounds = { x: 80, y: -20, width: 40, height: 40 };

  try {
    globalThis.game = { time: { worldTime: 0 } };
    globalThis.CONFIG = { Canvas: { detectionModes: {} } };
    globalThis.foundry = {};
    globalThis.PIXI = {
      Circle: { approximateVertexDensity: () => 32 },
      UPDATE_PRIORITY: { OBJECTS: 50, PERCEPTION: 2 }
    };
    globalThis.Hooks = {
      on(name, callback) {
        const callbacks = hookCallbacks.get(name) ?? [];
        callbacks.push(callback);
        hookCallbacks.set(name, callbacks);
      },
      callAll() {}
    };
    globalThis.canvas = {
      ready: true,
      scene,
      app: {
        ticker: {
          add(callback, context, priority) {
            tickerCallbacks.push({ callback, context, priority });
          },
          remove() {}
        }
      },
      tokens: { placeables: [nearToken, farToken] },
      effects: {
        lightSources: new Set(),
        darknessSources: new Set(),
        visionSources: new Set(),
        illumination: { invalidateDarknessLevelContainer() {} },
        refreshLighting() { refreshLightingCalls += 1; },
        initializeLightSources() { initializeLightSourcesCalls += 1; }
      },
      visibility: { refresh() { visibilityRefreshes += 1; } },
      masks: { occlusion: { _updateOcclusionMask() { occlusionRefreshes += 1; } } },
      fog: { sharedExploration: true },
      perception: {
        renderFlags: new Set(),
        update: flags => perceptionUpdates.push(flags)
      },
      dimensions: { maxR: 10_000 }
    };

    registerSmokeVisionHooks();
    assert.equal(notifySmokeRegionAnimation(region, {
      previousState: {
        known: true,
        bounds: { x: -20, y: -20, width: 40, height: 40 }
      }
    }), true);
    tickerCallbacks[0].callback.call(tickerCallbacks[0].context);
    tickerCallbacks[1].callback.call(tickerCallbacks[1].context);

    assert.equal(nearToken._visionSourceVersion, 5);
    assert.equal(farToken._visionSourceVersion, 4);
    assert.equal(visibilityRefreshes, 1);
    assert.equal(occlusionRefreshes, 1);
    assert.deepEqual(perceptionUpdates, []);
    assert.equal(refreshLightingCalls, 0);
    assert.equal(initializeLightSourcesCalls, 0);
  } finally {
    for (const callback of hookCallbacks.get("canvasTearDown") ?? []) callback();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("same-frame smoke ticker reports malformed geometry and retries only the exact path", () => {
  const previous = {
    canvas: globalThis.canvas,
    game: globalThis.game,
    foundry: globalThis.foundry,
    CONFIG: globalThis.CONFIG,
    Hooks: globalThis.Hooks,
    PIXI: globalThis.PIXI
  };
  const region = createSmokeRegion("animated-invalid-geometry", 50);
  const scene = createScene([region]);
  const tickerCallbacks = [];
  const hookCallbacks = new Map();
  const perceptionUpdates = [];
  let darknessInvalidations = 0;
  let nativeRefreshHooks = 0;
  let lightingRefreshHooks = 0;
  let reportedErrors = 0;
  region.parent = scene;
  region.attachment = { token: { x: 10, y: 0, elevation: 0, rotation: 0 } };
  region.object.isAnimating = true;

  try {
    globalThis.game = { time: { worldTime: 0 } };
    globalThis.CONFIG = { Canvas: { detectionModes: {} } };
    globalThis.foundry = {};
    globalThis.PIXI = {
      Circle: { approximateVertexDensity: () => 32 },
      UPDATE_PRIORITY: { OBJECTS: 50, PERCEPTION: 2 }
    };
    globalThis.Hooks = {
      on(name, callback) {
        const callbacks = hookCallbacks.get(name) ?? [];
        callbacks.push(callback);
        hookCallbacks.set(name, callbacks);
      },
      callAll(name) {
        if (name === "fallout-maw.smokeNativePerceptionRefresh") nativeRefreshHooks += 1;
        if (name === "lightingRefresh") lightingRefreshHooks += 1;
      },
      onError(location, error) {
        assert.equal(location, "fallout-maw.attachedSmokeAnimation");
        assert.match(error.message, /transient PolygonTree failure/);
        reportedErrors += 1;
      }
    };
    globalThis.canvas = {
      ready: true,
      scene,
      app: {
        ticker: {
          add(callback, context, priority) {
            tickerCallbacks.push({ callback, context, priority });
          },
          remove() {}
        }
      },
      effects: {
        lightSources: new Set(),
        darknessSources: new Set(),
        visionSources: new Set(),
        illumination: {
          invalidateDarknessLevelContainer() { darknessInvalidations += 1; }
        }
      },
      fog: { sharedExploration: false },
      perception: { update: flags => perceptionUpdates.push(flags) },
      dimensions: { maxR: 10_000 }
    };
    registerSmokeVisionHooks();
    assert.equal(notifySmokeRegionAnimation(region, {
      previousState: {
        known: true,
        bounds: { x: -20, y: -20, width: 40, height: 40 }
      }
    }), true);
    Object.defineProperty(region.object, "bounds", {
      configurable: true,
      get() { throw new Error("transient PolygonTree failure"); }
    });

    assert.deepEqual(tickerCallbacks.map(({ priority }) => priority), [50.5, 2.5]);
    assert.doesNotThrow(() => tickerCallbacks[0].callback.call(tickerCallbacks[0].context));
    assert.equal(reportedErrors, 1);
    assert.equal(darknessInvalidations, 0);
    assert.equal(nativeRefreshHooks, 0);
    assert.equal(lightingRefreshHooks, 0);
    assert.deepEqual(perceptionUpdates, []);

    Object.defineProperty(region.object, "bounds", {
      configurable: true,
      value: { x: 0, y: 0, width: 10, height: 10 }
    });
    assert.doesNotThrow(() => tickerCallbacks[0].callback.call(tickerCallbacks[0].context));
    assert.doesNotThrow(() => tickerCallbacks[1].callback.call(tickerCallbacks[1].context));
    assert.equal(darknessInvalidations, 1);
    assert.equal(nativeRefreshHooks, 1);
    assert.equal(lightingRefreshHooks, 1);
    assert.deepEqual(perceptionUpdates, []);
  } finally {
    for (const callback of hookCallbacks.get("canvasTearDown") ?? []) callback();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("smoke path cost attenuates intersecting and overlapping regions", () => {
  const scene = createScene([
    createSmokeRegion("a", 50),
    createSmokeRegion("b", 50)
  ]);
  assert.equal(calculateSmokePathCost({ x: 0, y: 0, elevation: 0 }, { x: 10, y: 0, elevation: 0 }, { scene, elevation: 0 }), 40);
  invalidateSmokeRegionIndex(scene);
  scene.regions.contents = [createSmokeRegion("opaque", 100)];
  assert.equal(calculateSmokePathCost({ x: 0, y: 0, elevation: 0 }, { x: 10, y: 0, elevation: 0 }, { scene, elevation: 0 }), Infinity);
});

test("smoke recipient relations use the Region source actor factions", () => {
  const sourceActor = createFactionActor("Actor.source", "Исследователи");
  const allyActor = createFactionActor("Actor.ally", "Исследователи");
  const neutralActor = createFactionActor("Actor.neutral", "Поселенцы");
  const region = createSmokeRegion("relations", 100);
  const behavior = region.behaviors.contents[0];
  behavior.system.targetRelations = ["neutral", "enemy"];
  region.attachment = { token: "source-token" };
  region.parent = {
    tokens: {
      get: tokenId => tokenId === "source-token" ? { actor: sourceActor } : null
    }
  };
  const scene = createScene([region]);
  const from = { x: 0, y: 0, elevation: 0 };
  const to = { x: 10, y: 0, elevation: 0 };

  assert.equal(calculateSmokePathCost(from, to, { scene, elevation: 0, targetActor: sourceActor }), 10);
  assert.equal(calculateSmokePathCost(from, to, { scene, elevation: 0, targetActor: allyActor }), 10);
  assert.equal(calculateSmokePathCost(from, to, { scene, elevation: 0, targetActor: neutralActor }), Infinity);
  assert.equal(calculateSmokePathCost(from, to, { scene, elevation: 0 }), Infinity);
});

test("smoke path intervals use the native Region segmentizer", () => {
  const region = createSmokeRegion("circle", 50);
  region.shapes[0].radius = 2;
  region.object.bounds = { x: 3, y: -2, width: 4, height: 4 };
  let segmentizerCalls = 0;
  const nativeSegmentizer = region.segmentizeMovementPath;
  region.segmentizeMovementPath = (...args) => {
    segmentizerCalls++;
    return nativeSegmentizer(...args);
  };
  const scene = createScene([region]);
  assert.equal(
    calculateSmokePathCost({ x: 0, y: 0, elevation: 0 }, { x: 10, y: 0, elevation: 1 }, { scene, elevation: null }),
    14
  );
  assert.equal(segmentizerCalls, 1);
});

test("smoke visibility budget is reciprocal inside the same density", () => {
  const region = createSmokeRegion("reciprocal", 50);
  region.shapes[0] = { type: "circle", x: 100, y: 0, radius: 200 };
  region.object.bounds = { x: -100, y: -200, width: 400, height: 400 };
  const scene = createScene([region]);
  const forward = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 200, y: 0, elevation: 0 },
    { scene, elevation: 0, budget: 200 }
  );
  const reverse = measureSmokePath(
    { x: 200, y: 0, elevation: 0 },
    { x: 0, y: 0, elevation: 0 },
    { scene, elevation: 0, budget: 200 }
  );

  assert.equal(forward.cost, 400);
  assert.equal(forward.visibleDistance, 100);
  assert.equal(reverse.cost, forward.cost);
  assert.equal(reverse.visibleDistance, forward.visibleDistance);
});

test("opaque smoke attenuates an observer starting inside the Region", () => {
  const region = createSmokeRegion("opaque-inside", 100);
  region.shapes[0] = { type: "circle", x: 0, y: 0, radius: 100 };
  region.object.bounds = { x: -100, y: -100, width: 200, height: 200 };
  const measurement = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 200, y: 0, elevation: 0 },
    { scene: createScene([region]), elevation: 0, budget: 200 }
  );
  assert.equal(measurement.cost, Infinity);
  assert.equal(measurement.visibleDistance, 0);
});

test("actor smoke perception changes retained vision without changing smoke data", () => {
  const actor = {
    effects: [{
      active: true,
      disabled: false,
      system: {
        changes: [{
          key: SMOKE_PERCEPTION_PERCENT_EFFECT_KEY,
          type: "add",
          value: "-30"
        }]
      }
    }]
  };
  assert.equal(getActorSmokePerceptionPercent(actor), -30);
  assert.equal(getActorSmokeDensityAdjustment(actor), -0.3);

  const region = createSmokeRegion("perception", 70);
  const measurement = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 10, y: 0, elevation: 0 },
    {
      scene: createScene([region]),
      elevation: 0,
      densityAdjustment: getActorSmokeDensityAdjustment(actor)
    }
  );
  assert.ok(Math.abs(measurement.cost - (10 / 0.6)) < 1e-6);

  const opaque = createSmokeRegion("perception-opaque", 100);
  const opaqueMeasurement = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 10, y: 0, elevation: 0 },
    {
      scene: createScene([opaque]),
      elevation: 0,
      densityAdjustment: getActorSmokeDensityAdjustment(actor)
    }
  );
  assert.ok(Math.abs(opaqueMeasurement.cost - (10 / 0.3)) < 1e-6);

  actor.effects[0].system.changes[0].value = "-170";
  invalidateActorSmokePerception(actor);
  const enhancedMeasurement = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 20, y: 0, elevation: 0 },
    {
      scene: createScene([region]),
      elevation: 0,
      budget: 10,
      densityAdjustment: getActorSmokeDensityAdjustment(actor)
    }
  );
  assert.equal(getActorSmokeDensityAdjustment(actor), -1.7);
  assert.ok(Math.abs(enhancedMeasurement.cost - 10) < 1e-6);
  assert.equal(enhancedMeasurement.visibleDistance, 20);

  const transitRegion = createSmokeRegion("perception-transit", 70);
  transitRegion.shapes[0] = { type: "circle", x: 100, y: 0, radius: 50 };
  transitRegion.object.bounds = { x: 50, y: -50, width: 100, height: 100 };
  const transitScene = createScene([transitRegion]);
  const enhancedSmokeOnlyTransit = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 200, y: 0, elevation: 0 },
    {
      scene: transitScene,
      elevation: 0,
      budget: 50,
      chargeClearDistance: false,
      densityAdjustment: getActorSmokeDensityAdjustment(actor)
    }
  );
  assert.equal(enhancedSmokeOnlyTransit.cost, 50);
  assert.equal(enhancedSmokeOnlyTransit.visibleDistance, 200);
  const improvedInside = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 140, y: 0, elevation: 0 },
    {
      scene: transitScene,
      elevation: 0,
      densityAdjustment: getActorSmokeDensityAdjustment(actor)
    }
  );
  const blockedBehind = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 200, y: 0, elevation: 0 },
    {
      scene: transitScene,
      elevation: 0,
      budget: 150,
      densityAdjustment: getActorSmokeDensityAdjustment(actor)
    }
  );
  assert.ok(Math.abs(improvedInside.cost - 95) < 1e-6);
  assert.ok(Math.abs(blockedBehind.cost - 150) < 1e-6);
  assert.equal(blockedBehind.visibleDistance, 200);

  const fromInsideToOutside = measureSmokePath(
    { x: 100, y: 0, elevation: 0 },
    { x: 200, y: 0, elevation: 0 },
    {
      scene: transitScene,
      elevation: 0,
      budget: 75,
      densityAdjustment: getActorSmokeDensityAdjustment(actor)
    }
  );
  const unmodifiedFromInside = measureSmokePath(
    { x: 100, y: 0, elevation: 0 },
    { x: 200, y: 0, elevation: 0 },
    { scene: transitScene, elevation: 0, budget: 75 }
  );
  assert.equal(fromInsideToOutside.cost, 75);
  assert.equal(fromInsideToOutside.visibleDistance, 100);
  assert.ok(unmodifiedFromInside.visibleDistance < 25);

  transitRegion.behaviors.contents[0].system.regionSpecialProperties[0].smoke.densityPercent = "100";
  invalidateSmokeRegionIndex(transitScene);
  const opaqueInside = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 140, y: 0, elevation: 0 },
    {
      scene: transitScene,
      elevation: 0,
      densityAdjustment: getActorSmokeDensityAdjustment(actor)
    }
  );
  const opaqueBehind = measureSmokePath(
    { x: 0, y: 0, elevation: 0 },
    { x: 200, y: 0, elevation: 0 },
    {
      scene: transitScene,
      elevation: 0,
      densityAdjustment: getActorSmokeDensityAdjustment(actor)
    }
  );
  assert.ok(Number.isFinite(opaqueInside.cost));
  assert.ok(Math.abs(opaqueBehind.cost - (100 + (100 / 1.7))) < 1e-6);
});

test("partial smoke keeps a point-only stealth mask on Basic Sight without a radial constraint", () => {
  const previous = {
    CONFIG: globalThis.CONFIG,
    Hooks: globalThis.Hooks,
    canvas: globalThis.canvas,
    game: globalThis.game,
    PIXI: globalThis.PIXI,
    foundry: globalThis.foundry,
    ClipperLib: globalThis.ClipperLib
  };
  const nativeRange = () => true;
  const basicSight = { _testRange: nativeRange };
  const lightPerception = { _testRange: nativeRange };
  const specialSense = { _testRange: nativeRange };
  const constrainedMasks = [];
  let emittedShapeShift = 0;
  let emittedSurfaceExposureShift = 0;
  class MockVisionSource {
    constructor({ object = null } = {}) {
      this.object = object;
      this.blinded = {};
      this.sourceId = "Vision.temporary";
      this.updateId = 0;
    }

    get lightRadius() { return 200; }
    get radius() { return 200; }
    initialize(data) {
      this.data = data;
      this.isBlinded = false;
      this._createShapes();
      this.updateId += 1;
    }
    destroy() {}
    _createShapes() {
      const origin = { x: this.data?.x ?? 0, y: this.data?.y ?? 0 };
      this.los = createMask("los", 200, origin);
      this.light = this._createLightPolygon();
      this.shape = this._createRestrictedPolygon();
    }
    _createLightPolygon() {
      const origin = { x: this.data?.x ?? 0, y: this.data?.y ?? 0 };
      return createMask("native-light", 200, origin);
    }
    _createRestrictedPolygon() {
      const origin = { x: this.data?.x ?? 0, y: this.data?.y ?? 0 };
      return createMask("native-sight", 200, origin);
    }
  }
  class MockLightSource {
    static sourceType = "light";
    get radius() { return 200; }
    _createShapes() {
      this.shape = createMask("emitted-light", 200, { x: this.data?.x ?? 0, y: this.data?.y ?? 0 });
    }
    testPoint(point) { return this.shape?.contains(point.x, point.y) ?? false; }
    _configure() { this.nativeConfigured = true; }
    _drawMesh() { return "native-illumination"; }
    animate() { this.nativeAnimated = true; }
    _destroy() { this.nativeDestroyed = true; }
  }
  function createMask(name, limit = 200, origin = { x: 0, y: 0 }) {
    return {
      points: [0, 0, 1, 0, 0, 1],
      origin,
      config: { radius: 200 },
      applyConstraint(constraint, options) {
        constrainedMasks.push({ name, constraint, options });
        const constrained = createMask(name, limit, origin);
        constrained.points = name === "emitted-light" && emittedShapeShift
          ? constraint.points.map((value, index) => index % 2 ? value : value + emittedShapeShift)
          : constraint.points;
        if (name === "emitted-light") {
          constrained.surfaceExposure = {
            polygons: [{
              points: constraint.points.map((value, index) => (
                index % 2 ? value : value + emittedSurfaceExposureShift
              ))
            }]
          };
        }
        return constrained;
      },
      intersectPolygon() { return this; },
      clone() {
        const clone = createMask(name, limit, origin);
        clone.points = [...this.points];
        return clone;
      },
      toClipperPoints() { return []; },
      getBounds() {
        if (this.points.length <= 6) {
          return { x: origin.x - limit, y: origin.y - limit, width: limit * 2, height: limit * 2 };
        }
        const xs = this.points.filter((_, index) => index % 2 === 0);
        const ys = this.points.filter((_, index) => index % 2 === 1);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
      },
      signedArea() {
        return this.points.length > 6 ? polygonArea(this.points) : limit * limit;
      },
      contains(x, y) {
        return this.points.length > 6
          ? pointInPolygon(this.points, x, y)
          : Math.hypot(x - origin.x, y - origin.y) <= limit + 1e-6;
      }
    };
  }
  function polygonArea(points) {
    let area = 0;
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      area += (points[j] * points[i + 1]) - (points[i] * points[j + 1]);
    }
    return area / 2;
  }
  function pointInPolygon(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      const xi = points[i];
      const yi = points[i + 1];
      const xj = points[j];
      const yj = points[j + 1];
      if (((yi > y) !== (yj > y)) && (x < (((xj - xi) * (y - yi)) / (yj - yi)) + xi)) inside = !inside;
    }
    return inside;
  }
  const region = createSmokeRegion("light-perception", 50);
  region.shapes[0] = { type: "circle", x: 0, y: 0, radius: 100 };
  region.object.bounds = { x: -100, y: -100, width: 200, height: 200 };
  let differenceCalls = 0;
  const dispersedPolygon = { points: [-100, -100, 0, -100, 0, 100, -100, 100] };
  const dispersedTree = {
    polygons: [dispersedPolygon],
    testPoint: ({ x, y }) => x >= -100 && x <= 0 && y >= -100 && y <= 100
  };
  region.polygonTree = {
    polygons: [{ points: createTestCirclePoints(region.shapes[0]) }],
    testPoint: ({ x, y }) => Math.hypot(x, y) <= 100,
    intersectPolygon() {
      differenceCalls += 1;
      return dispersedTree;
    }
  };
  const scene = createScene([region]);

  try {
    globalThis.CONFIG = {
      Canvas: {
        detectionModes: { basicSight, lightPerception, specialSense },
        visionSourceClass: MockVisionSource,
        lightSourceClass: MockLightSource
      }
    };
    globalThis.PIXI = {
      Circle: { approximateVertexDensity: () => 32 },
      Polygon: class {
        constructor(points) { this.points = points; }
        contains(x, y) { return pointInPolygon(this.points, x, y); }
      }
    };
    globalThis.foundry = {};
    globalThis.ClipperLib = { ClipType: { ctDifference: 1 } };
    globalThis.Hooks = { on() {} };
    globalThis.game = { time: { worldTime: 0 } };
    globalThis.canvas = {
      ready: false,
      scene,
      dimensions: { maxR: 1000, distancePixels: 100 }
    };

    registerSmokeVisionHooks();

    globalThis.canvas.ready = true;
    globalThis.canvas.visibility = { tokenVision: true };
    globalThis.canvas.effects = {
      lightSources: new Set(),
      testInsideLight: () => false
    };
    const temporaryObserver = {
      hasSight: true,
      sourceId: "Token.temporary-smoke-observer",
      actor: {},
      document: {
        id: "temporary-smoke-observer",
        actor: {},
        detectionModes: {
          basicSight: { id: "basicSight", enabled: true, range: 1 },
          lightPerception: { id: "lightPerception", enabled: false, range: 0 }
        }
      },
      getLightRadius: range => range * 100,
      _getVisionBlindedStates: () => ({}),
      _getVisionSourceData: () => ({ x: 0, y: 0, elevation: 0, externalRadius: 200 })
    };
    const constraintsBeforeTemporaryMask = constrainedMasks.length;
    const temporaryMask = createObserverOrdinaryVisionMask(temporaryObserver, {
      origin: { x: 0, y: 0, elevation: 0 },
      pointOnlySmoke: true
    });
    assert.ok(temporaryMask);
    assert.equal(
      constrainedMasks.length,
      constraintsBeforeTemporaryMask,
      "the temporary stealth source must skip the full radial smoke constraint"
    );
    assert.equal(temporaryMask.contains({ x: 40, y: 0, elevation: 0 }), true);
    assert.equal(
      temporaryMask.contains({ x: 75, y: 0, elevation: 0 }),
      false,
      "the point-only gate must still apply the Basic Sight smoke budget"
    );
    temporaryMask.destroy();

    const lightSource = new globalThis.CONFIG.Canvas.lightSourceClass();
    Object.assign(lightSource, {
      active: true,
      data: { x: 100, y: 0, elevation: 0, bright: 200, dim: 200 }
    });
    lightSource._createShapes();
    globalThis.canvas.effects = { lightSources: new Set([lightSource]) };
    const visionSource = new globalThis.CONFIG.Canvas.visionSourceClass();
    Object.assign(visionSource, {
      data: { x: 10, y: 0, elevation: 0, externalRadius: 0 },
      object: {
        document: {
          detectionModes: {
            basicSight: { id: "basicSight", enabled: true, range: 1 }
          }
        },
        getLightRadius: range => range * 100
      }
    });
    const token = {
      actor: {},
      document: { documentName: "Token", actor: {} }
    };
    const outside = { point: { x: -100, y: 0, elevation: 0 } };
    const reachedByForeignLight = { point: { x: 100, y: 0, elevation: 0 } };

    assert.notEqual(basicSight._testRange, nativeRange);
    assert.notEqual(lightPerception._testRange, nativeRange);
    assert.equal(specialSense._testRange, nativeRange);
    visionSource._createShapes();
    assert.deepEqual(constrainedMasks.map(mask => mask.name), [
      "emitted-light",
      "los"
    ]);
    assert.equal(visionSource.light, visionSource.los);
    assert.equal(visionSource.shape, visionSource.los);
    assert.ok(lightSource.shape.contains(10, 0));
    assert.equal(lightSource.shape.config.radius, 200);
    assert.equal(getSmokeLightBandAtPoint(lightSource, { x: 10, y: 0 }), "bright");
    assert.equal(basicSight._testRange(visionSource, { range: 1 }, token, reachedByForeignLight), true);
    assert.equal(lightPerception._testRange(visionSource, { range: Infinity }, token, outside), false);
    assert.equal(lightPerception._testRange(visionSource, { range: Infinity }, token, reachedByForeignLight), true);
    assert.equal(lightPerception._testRange(visionSource, { range: Infinity }, { document: {} }, outside), true);
    assert.equal(differenceCalls, 1);
    const initialVisionConstraint = constrainedMasks.findLast(mask => mask.name === "los")?.constraint;

    // Foundry may initialize every light source again even when no light geometry changed. That native no-op must not
    // invalidate either the observer constraint or the cached Region-minus-light geometry.
    lightSource._createShapes();
    visionSource._createShapes();
    assert.deepEqual(constrainedMasks.findLast(mask => mask.name === "los")?.constraint, initialVisionConstraint);
    assert.equal(differenceCalls, 1);

    // Foundry represents surface exposure as a PolygonTree. Recreating an equal tree is a native no-op, while an
    // actual exposure-ring change must receive a new semantic light version without recursive polygon comparison.
    emittedSurfaceExposureShift = 0.25;
    lightSource._createShapes();
    visionSource._createShapes();
    const surfaceExposureConstraint = constrainedMasks.findLast(mask => mask.name === "los")?.constraint;
    assert.deepEqual(surfaceExposureConstraint, initialVisionConstraint);
    assert.equal(differenceCalls, 2);

    // A semantically changed light outside this observer's bounds receives its own version without invalidating the
    // observer's local candidate signature.
    const distantLightSource = new globalThis.CONFIG.Canvas.lightSourceClass();
    Object.assign(distantLightSource, {
      active: true,
      data: { x: 2_000, y: 0, elevation: 0, bright: 200, dim: 200 }
    });
    distantLightSource._createShapes();
    globalThis.canvas.effects.lightSources.add(distantLightSource);
    visionSource._createShapes();
    assert.deepEqual(constrainedMasks.findLast(mask => mask.name === "los")?.constraint, surfaceExposureConstraint);
    assert.equal(differenceCalls, 2);
    globalThis.canvas.effects.lightSources.delete(distantLightSource);
    distantLightSource._destroy();

    // The same two-dimensional mask on another Foundry elevation cannot disperse smoke for this observer.
    const elevatedLightSource = new globalThis.CONFIG.Canvas.lightSourceClass();
    Object.assign(elevatedLightSource, {
      active: true,
      data: { x: 100, y: 0, elevation: 10, bright: 200, dim: 200 }
    });
    elevatedLightSource._createShapes();
    globalThis.canvas.effects.lightSources.add(elevatedLightSource);
    visionSource._createShapes();
    assert.deepEqual(constrainedMasks.findLast(mask => mask.name === "los")?.constraint, surfaceExposureConstraint);
    assert.equal(differenceCalls, 2);
    globalThis.canvas.effects.lightSources.delete(elevatedLightSource);
    elevatedLightSource._destroy();

    // The smoke bands can stay cached while a native wall changes the final emitted shape. Since physical smoke
    // dispersion consumes that final shape, this is a real semantic change and must invalidate the local geometry.
    emittedShapeShift = 0.5;
    lightSource._createShapes();
    visionSource._createShapes();
    assert.deepEqual(constrainedMasks.findLast(mask => mask.name === "los")?.constraint, surfaceExposureConstraint);
    assert.equal(differenceCalls, 3);

    lightSource._configure({});
    assert.equal(lightSource.nativeConfigured, true);
    assert.equal(lightSource._drawMesh("illumination"), "native-illumination");
    lightSource.animate();
    assert.equal(lightSource.nativeAnimated, true);
    lightSource._destroy();
    assert.equal(lightSource.nativeDestroyed, true);

    // A ray between different Foundry elevations must reach the native 3D Region segmentizer before elevation
    // filtering. Filtering only at the observer elevation would incorrectly discard this opaque middle floor.
    const elevatedSmoke = createSmokeRegion("sloped-ray-smoke", 100);
    elevatedSmoke.elevation = { bottom: 4, top: 6 };
    elevatedSmoke.shapes[0] = { type: "circle", x: 0, y: 0, radius: 100 };
    elevatedSmoke.object.bounds = { x: -100, y: -100, width: 200, height: 200 };
    globalThis.canvas.scene = createScene([elevatedSmoke]);
    globalThis.canvas.effects.lightSources = new Set();
    invalidateSmokeRegionIndex(globalThis.canvas.scene);
    assert.equal(basicSight._testRange(
      visionSource,
      { range: 1 },
      token,
      { point: { x: 100, y: 0, elevation: 10 } }
    ), false);
  } finally {
    globalThis.CONFIG = previous.CONFIG;
    globalThis.Hooks = previous.Hooks;
    globalThis.canvas = previous.canvas;
    globalThis.game = previous.game;
    globalThis.PIXI = previous.PIXI;
    globalThis.foundry = previous.foundry;
    globalThis.ClipperLib = previous.ClipperLib;
  }
});

test("cached native PolygonTree boundaries avoid Region movement clipping for vision rays", () => {
  const region = createSmokeRegion("polygon-tree", 50);
  const polygon = { points: [0, 0, 10, 0, 10, 10, 0, 10] };
  let segmentizeCalls = 0;
  Object.defineProperty(region, "polygonTree", {
    configurable: true,
    value: {
      polygons: [polygon],
      testPoint: ({ x, y }) => x >= 0 && x <= 10 && y >= 0 && y <= 10
    }
  });
  region.segmentizeMovementPath = () => {
    segmentizeCalls += 1;
    return [];
  };
  const cost = calculateSmokePathCost(
    { x: -5, y: 5, elevation: 0 },
    { x: 15, y: 5, elevation: 0 },
    { scene: createScene([region]), elevation: 0 }
  );
  assert.equal(cost, 30);
  assert.equal(segmentizeCalls, 0);
});

test("opaque smoke keeps special senses on a cached native wall-only collision", () => {
  const previous = {
    CONFIG: globalThis.CONFIG,
    Hooks: globalThis.Hooks,
    canvas: globalThis.canvas,
    game: globalThis.game,
    foundry: globalThis.foundry
  };
  let collisionCalls = 0;
  let collisionConfig = null;
  class MockDetectionMode {
    constructor() {
      this.walls = true;
      this.angle = true;
    }

    _testLOS() { return false; }

    static _testCollision(_source, _test, config) {
      collisionCalls += 1;
      collisionConfig = config;
      return false;
    }
  }
  const specialSense = new MockDetectionMode();
  try {
    globalThis.CONFIG = {
      Canvas: {
        detectionModes: {
          basicSight: { _testRange: () => true },
          lightPerception: { _testRange: () => true },
          specialSense
        }
      }
    };
    globalThis.Hooks = { on() {} };
    globalThis.game = { time: { worldTime: 0 } };
    globalThis.canvas = {
      ready: false,
      scene: createScene([createSmokeRegion("special-sense", 100)])
    };
    globalThis.foundry = { canvas: { perception: { DetectionMode: MockDetectionMode } } };

    registerSmokeVisionHooks();
    const source = {
      data: { angle: 360 },
      los: { config: { type: "sight", _falloutMawIncludeSmokeEdges: true } }
    };
    const visibilityTest = { point: { x: 10, y: 10, elevation: 0 } };
    assert.equal(specialSense._testLOS(source, {}, null, visibilityTest), true);
    assert.equal(specialSense._testLOS(source, {}, null, visibilityTest), true);
    assert.equal(collisionCalls, 1);
    assert.equal(collisionConfig._falloutMawIncludeSmokeEdges, undefined);
  } finally {
    globalThis.CONFIG = previous.CONFIG;
    globalThis.Hooks = previous.Hooks;
    globalThis.canvas = previous.canvas;
    globalThis.game = previous.game;
    globalThis.foundry = previous.foundry;
  }
});

test("all smoke densities constrain one native LOS without synthetic CanvasEdges", () => {
  const previous = {
    canvas: globalThis.canvas,
    game: globalThis.game,
    foundry: globalThis.foundry,
    CONST: globalThis.CONST,
    CONFIG: globalThis.CONFIG,
    Hooks: globalThis.Hooks,
    PIXI: globalThis.PIXI
  };
  const region = createSmokeRegion("native-edges", 100);
  region.shapes = [{ type: "polygon" }];
  region.object.bounds = { x: 0, y: 0, width: 100, height: 100 };
  Object.defineProperty(region, "polygons", {
    configurable: true,
    value: [{ points: [0, 0, 100, 0, 100, 100, 0, 100] }]
  });
  let smokePointTests = 0;
  region.polygonTree = {
    polygons: region.polygons,
    testPoint: ({ x, y }) => {
      smokePointTests += 1;
      return x >= 0 && x <= 100 && y >= 0 && y <= 100;
    }
  };
  const scene = createScene([region]);
  const edges = new Map();
  const meshes = { addChild() {} };
  let sweepCalls = 0;
  const sweepTypes = [];
  const includedSmokeEdges = [];
  const perceptionUpdates = [];
  const appliedConstraints = [];
  let retessellateNativeLos = false;
  const countRadialTransitions = (points, originX, originY, minimumDistance = 1) => (
    points.reduce((count, _value, index) => {
      if (index % 2) return count;
      const next = (index + 2) % points.length;
      const ax = points[index] - originX;
      const ay = points[index + 1] - originY;
      const bx = points[next] - originX;
      const by = points[next + 1] - originY;
      const cross = Math.abs((ax * by) - (ay * bx));
      const lengthProduct = Math.max(1, Math.hypot(ax, ay) * Math.hypot(bx, by));
      return cross <= lengthProduct * 1e-8
        && ((ax * bx) + (ay * by)) > 0
        && Math.abs(Math.hypot(ax, ay) - Math.hypot(bx, by)) > minimumDistance
        ? count + 1
        : count;
    }, 0)
  );

  class MockSweep {
    static create(origin, config) {
      sweepCalls += 1;
      sweepTypes.push(config.type);
      config.density ??= 16;
      const polygon = new this();
      polygon.origin = origin;
      polygon.config = config;
      includedSmokeEdges.push([...globalThis.canvas.edges.values()]
        .some(edge => polygon._testEdgeInclusion(edge, {})));
      const points = Array.from({ length: config.density }, (_, index) => {
        const angle = (Math.PI * 2 * index) / config.density;
        return [
          origin.x + (Math.cos(angle) * config.radius),
          origin.y + (Math.sin(angle) * config.radius)
        ];
      }).flat();
      if (retessellateNativeLos) {
        points.splice(2, 0, (points[0] + points[2]) / 2, (points[1] + points[3]) / 2);
      }
      return {
        origin,
        config,
        points,
        applyConstraint(constraint) {
          appliedConstraints.push(constraint);
          return this;
        }
      };
    }

    _testEdgeInclusion() { return false; }
  }

  class MockVisionSource {
    get lightRadius() { return 100; }
    get radius() { return 100; }
    _getPolygonConfiguration() { return { type: "sight", radius: 100, edgeTypes: { wall: true } }; }
    _createShapes() {
      this.los = globalThis.CONFIG.Canvas.polygonBackends.sight.create(
        this.data,
        this._getPolygonConfiguration()
      );
      this.shape = this.los;
      this.light = this._createLightPolygon();
      this.shape = this._createRestrictedPolygon();
    }
    _createLightPolygon() { return this.los; }
    _createRestrictedPolygon() { return this.los; }
  }

  class MockLightSource {
    get radius() { return 100; }
    _getPolygonConfiguration() { return { type: "light", radius: 100, edgeTypes: { wall: true } }; }
    _createShapes() {
      this.shape = globalThis.CONFIG.Canvas.polygonBackends.light.create(
        this.data,
        this._getPolygonConfiguration()
      );
    }
  }

  try {
    globalThis.game = { time: { worldTime: 0 } };
    globalThis.CONST = {
      CANVAS_PERFORMANCE_MODES: { LOW: 1 },
      EDGE_SENSE_TYPES: { NORMAL: 20 }
    };
    globalThis.foundry = {
      canvas: {
        geometry: {
          edges: {
            Edge: class Edge {
              constructor(a, b, options) { Object.assign(this, options, { a, b }); }
            }
          }
        },
        placeables: {
          regions: {
            RegionMesh: class RegionMesh {
              constructor() { this.shader = {}; }
              destroy() {}
            }
          }
        },
        rendering: {
          shaders: {
            AdjustDarknessLevelRegionShader: class {},
            IlluminationDarknessLevelRegionShader: class {}
          }
        }
      }
    };
    globalThis.CONFIG = {
      Canvas: {
        detectionModes: {
          basicSight: { _testRange: () => true },
          lightPerception: { _testRange: () => true }
        },
        polygonBackends: { sight: MockSweep, light: MockSweep },
        visionSourceClass: MockVisionSource,
        lightSourceClass: MockLightSource
      }
    };
    globalThis.Hooks = { on() {} };
    globalThis.PIXI = {
      Circle: { approximateVertexDensity: () => 32 },
      Polygon: class Polygon { constructor(points) { this.points = points; } }
    };
    globalThis.canvas = {
      ready: true,
      scene,
      edges,
      effects: {
        illumination: {
          darknessLevelMeshes: meshes,
          invalidateDarknessLevelContainer() {}
        }
      },
      visibility: { vision: { light: { global: { meshes } } } },
      performance: { mode: 0 },
      environment: { globalLightSource: { active: false } },
      perception: { update(flags) { perceptionUpdates.push(flags); } }
    };

    registerSmokeVisionHooks();
    syncSmokeDarknessMeshes({ forceRendering: true, forceVision: true });

    assert.equal(edges.size, 0);
    assert.equal(perceptionUpdates.some(flags => (
      flags.initializeLightSources === true && flags.initializeVision === true
    )), true);

    const source = new globalThis.CONFIG.Canvas.visionSourceClass();
    Object.assign(source, {
      data: { x: 50, y: 50, elevation: 0, externalRadius: 0 },
      object: {
        document: { detectionModes: { basicSight: { enabled: true, range: 1 } } },
        getLightRadius: range => range * 100
      }
    });
    source._createShapes();
    assert.equal(sweepCalls, 1);
    assert.equal(includedSmokeEdges[0], false);
    assert.equal(appliedConstraints.length, 1);
    assert.equal(appliedConstraints[0].points.every(value => value === 50), true);
    assert.ok(smokePointTests > 0, "the first native smoke constraint traces its PolygonTree");

    Object.defineProperty(region, "polygons", {
      configurable: true,
      value: [{ points: [10, 0, 110, 0, 110, 100, 10, 100] }]
    });
    region.object.bounds = { x: 10, y: 0, width: 100, height: 100 };
    region.polygonTree = {
      polygons: region.polygons,
      testPoint: ({ x, y }) => {
        smokePointTests += 1;
        return x >= 10 && x <= 110 && y >= 0 && y <= 100;
      }
    };
    source.data.x = 60;
    smokePointTests = 0;
    invalidateSmokeRegionIndex(scene);
    source._createShapes();
    assert.equal(smokePointTests, 0, "coherent source/Region translation reuses exact source-local attenuation");
    assert.equal(appliedConstraints.at(-1).points.every((value, index) => value === (index % 2 ? 50 : 60)), true);
    Object.defineProperty(region, "polygons", {
      configurable: true,
      value: [{ points: [0, 0, 100, 0, 100, 100, 0, 100] }]
    });
    region.object.bounds = { x: 0, y: 0, width: 100, height: 100 };
    region.polygonTree = {
      polygons: region.polygons,
      testPoint: ({ x, y }) => x >= 0 && x <= 100 && y >= 0 && y <= 100
    };
    invalidateSmokeRegionIndex(scene);

    const lightSource = new globalThis.CONFIG.Canvas.lightSourceClass();
    Object.assign(lightSource, {
      data: { x: 50, y: 50, elevation: 0, bright: 100, dim: 100 }
    });
    lightSource._createShapes();
    assert.equal(sweepCalls, 3);
    assert.deepEqual(sweepTypes, ["sight", "sight", "light"]);
    assert.equal(includedSmokeEdges[2], false);
    assert.equal(appliedConstraints.length, 3);
    assert.equal(appliedConstraints[2].points.every(value => value === 50), true);

    const outsideLightSource = new globalThis.CONFIG.Canvas.lightSourceClass();
    Object.assign(outsideLightSource, {
      data: { x: 150, y: 50, elevation: 0, bright: 100, dim: 100 }
    });
    outsideLightSource._createShapes();
    assert.equal(sweepCalls, 4);
    assert.equal(includedSmokeEdges[3], false);
    assert.equal(appliedConstraints.length, 4);
    assert.ok(countRadialTransitions(
      appliedConstraints.at(-1).points,
      outsideLightSource.data.x,
      outsideLightSource.data.y
    ) >= 2);

    const modifiedActor = {
      effects: [{
        active: true,
        system: {
          changes: [{
            key: SMOKE_PERCEPTION_PERCENT_EFFECT_KEY,
            type: "add",
            value: "-30"
          }]
        }
      }]
    };
    const modifiedVisionSource = new globalThis.CONFIG.Canvas.visionSourceClass();
    Object.assign(modifiedVisionSource, {
      data: { x: 147, y: 53, elevation: 0, externalRadius: 0 },
      object: {
        actor: modifiedActor,
        document: {
          actor: modifiedActor,
          detectionModes: { basicSight: { enabled: true, range: 1 } }
        },
        getLightRadius: range => range * 100
      }
    });
    modifiedVisionSource._createShapes();
    assert.equal(sweepCalls, 5);
    assert.equal(includedSmokeEdges[4], false);
    assert.equal(appliedConstraints.length, 5);
    const boundaryAnchoredConstraint = appliedConstraints.at(-1).points;
    assert.equal(boundaryAnchoredConstraint.some((value, index) => (
      index % 2 === 0
      && Math.abs(value - (modifiedVisionSource.data.x + modifiedVisionSource.radius)) < 1e-6
      && Math.abs(boundaryAnchoredConstraint[index + 1] - modifiedVisionSource.data.y) < 1e-6
    )), true);
    for (const [x, y] of [[0, 0], [100, 0], [100, 100], [0, 100]]) {
      const boundaryDx = x - modifiedVisionSource.data.x;
      const boundaryDy = y - modifiedVisionSource.data.y;
      assert.equal(boundaryAnchoredConstraint.some((value, index, points) => {
        if (index % 2) return false;
        const rayDx = value - modifiedVisionSource.data.x;
        const rayDy = points[index + 1] - modifiedVisionSource.data.y;
        const scale = Math.max(1, Math.hypot(boundaryDx, boundaryDy) * Math.hypot(rayDx, rayDy));
        return ((boundaryDx * rayDx) + (boundaryDy * rayDy)) > 0
          && Math.abs((boundaryDx * rayDy) - (boundaryDy * rayDx)) <= scale * 1e-8;
      }), true);
    }
    const radialTransitionCount = countRadialTransitions(
      boundaryAnchoredConstraint,
      modifiedVisionSource.data.x,
      modifiedVisionSource.data.y
    );
    assert.ok(radialTransitionCount >= 2);

    // Native ClockwiseSweep may add or remove a redundant collinear point near a wall. That re-tessellation must not
    // alter the independently computed smoke medium constraint at the same source position.
    retessellateNativeLos = true;
    const retessellatedVisionSource = new globalThis.CONFIG.Canvas.visionSourceClass();
    Object.assign(retessellatedVisionSource, {
      data: { ...modifiedVisionSource.data },
      object: modifiedVisionSource.object
    });
    retessellatedVisionSource._createShapes();
    const retessellatedConstraint = appliedConstraints.at(-1).points;
    assert.deepEqual(retessellatedConstraint, boundaryAnchoredConstraint);

    // Sub-pixel source movement keeps the same event topology and moves every contour point continuously.
    const movedVisionSource = new globalThis.CONFIG.Canvas.visionSourceClass();
    Object.assign(movedVisionSource, {
      data: { ...modifiedVisionSource.data, x: modifiedVisionSource.data.x + 0.01 },
      object: modifiedVisionSource.object
    });
    movedVisionSource._createShapes();
    const movedConstraint = appliedConstraints.at(-1).points;
    const distanceToSegments = (x, y, polygon) => {
      let distance = Infinity;
      for (let index = 0, previous = polygon.length - 2; index < polygon.length; previous = index, index += 2) {
        const ax = polygon[previous];
        const ay = polygon[previous + 1];
        const dx = polygon[index] - ax;
        const dy = polygon[index + 1] - ay;
        const lengthSquared = (dx * dx) + (dy * dy);
        const t = lengthSquared
          ? Math.max(0, Math.min(1, (((x - ax) * dx) + ((y - ay) * dy)) / lengthSquared))
          : 0;
        distance = Math.min(distance, Math.hypot(x - (ax + (dx * t)), y - (ay + (dy * t))));
      }
      return distance;
    };
    const directedHausdorff = (from, to) => {
      let distance = 0;
      for (let index = 0; index < from.length; index += 2) {
        distance = Math.max(distance, distanceToSegments(from[index], from[index + 1], to));
      }
      return distance;
    };
    const contourShift = Math.max(
      directedHausdorff(boundaryAnchoredConstraint, movedConstraint),
      directedHausdorff(movedConstraint, boundaryAnchoredConstraint)
    );
    assert.ok(contourShift <= 0.25, `symmetric contour shift was ${contourShift}`);

    // A smoke-cost minimum can lie inside one regular Foundry angular slab. Both slab endpoints are then blocked
    // while its midpoint is visible, so the contour requires two ordered radial transitions. Exercise both an
    // ordinary slab and the final slab which wraps through 2π back to angle zero.
    const angularStep = (Math.PI * 2) / 32;
    const createRotatedStripRegion = (id, normalAngle) => {
      const stripRegion = createSmokeRegion(id, 50);
      const normal = { x: Math.cos(normalAngle), y: Math.sin(normalAngle) };
      const tangent = { x: -normal.y, y: normal.x };
      const near = 20;
      const far = 45;
      const halfLength = 200;
      const point = (normalDistance, tangentDistance) => ({
        x: (normal.x * normalDistance) + (tangent.x * tangentDistance),
        y: (normal.y * normalDistance) + (tangent.y * tangentDistance)
      });
      const corners = [
        point(near, -halfLength),
        point(far, -halfLength),
        point(far, halfLength),
        point(near, halfLength)
      ];
      const points = corners.flatMap(({ x, y }) => [x, y]);
      const xs = corners.map(({ x }) => x);
      const ys = corners.map(({ y }) => y);
      stripRegion.shapes = [{ type: "polygon" }];
      stripRegion.object.bounds = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys)
      };
      Object.defineProperty(stripRegion, "polygons", {
        configurable: true,
        value: [{ points }]
      });
      stripRegion.polygonTree = {
        polygons: stripRegion.polygons,
        testPoint: ({ x, y }) => {
          const normalDistance = (x * normal.x) + (y * normal.y);
          const tangentDistance = (x * tangent.x) + (y * tangent.y);
          return normalDistance >= near
            && normalDistance <= far
            && Math.abs(tangentDistance) <= halfLength;
        }
      };
      return stripRegion;
    };
    const getRadialTransitionAngles = (points, originX, originY) => {
      const result = [];
      for (let index = 0; index < points.length; index += 2) {
        const next = (index + 2) % points.length;
        const ax = points[index] - originX;
        const ay = points[index + 1] - originY;
        const bx = points[next] - originX;
        const by = points[next + 1] - originY;
        const radiusA = Math.hypot(ax, ay);
        const radiusB = Math.hypot(bx, by);
        const scale = Math.max(1, radiusA * radiusB);
        if (Math.abs((ax * by) - (ay * bx)) > scale * 1e-8) continue;
        if ((ax * bx) + (ay * by) <= 0 || Math.abs(radiusA - radiusB) <= 20) continue;
        result.push(((Math.atan2(ay, ax) % (Math.PI * 2)) + (Math.PI * 2)) % (Math.PI * 2));
      }
      return result;
    };
    for (const [id, normalAngle, containsAngle] of [
      ["two-roots", angularStep / 2, angle => angle > 0 && angle < angularStep],
      ["two-roots-wrap", -angularStep / 2, angle => angle > (Math.PI * 2) - angularStep]
    ]) {
      globalThis.canvas.scene = createScene([createRotatedStripRegion(id, normalAngle)]);
      const twoRootSource = new globalThis.CONFIG.Canvas.visionSourceClass();
      Object.assign(twoRootSource, {
        data: { x: 0, y: 0, elevation: 0, externalRadius: 0 },
        object: {
          document: { detectionModes: { basicSight: { enabled: true, range: 0.501 } } },
          getLightRadius: range => range * 100
        }
      });
      twoRootSource._createShapes();
      const slabTransitions = getRadialTransitionAngles(appliedConstraints.at(-1).points, 0, 0)
        .filter(containsAngle)
        .sort((left, right) => left - right);
      assert.equal(slabTransitions.length, 2, `${id} transition count`);
      assert.ok(slabTransitions[0] < slabTransitions[1], `${id} angular order`);
    }

    // When one opaque Region ends in front of another opaque Region, both one-sided rays remain blocked but the
    // active collision distance changes. Preserve that discontinuity as two consecutive points on the same ray.
    const nearRegion = createSmokeRegion("near-opaque", 100);
    const farRegion = createSmokeRegion("far-opaque", 100);
    const configureRectangle = (rectangleRegion, points, bounds, contains) => {
      rectangleRegion.shapes = [{ type: "polygon" }];
      rectangleRegion.object.bounds = bounds;
      Object.defineProperty(rectangleRegion, "polygons", {
        configurable: true,
        value: [{ points }]
      });
      rectangleRegion.polygonTree = {
        polygons: rectangleRegion.polygons,
        testPoint: contains
      };
    };
    configureRectangle(
      nearRegion,
      [20, 0, 40, 0, 40, 40, 20, 40],
      { x: 20, y: 0, width: 20, height: 40 },
      ({ x, y }) => x >= 20 && x <= 40 && y >= 0 && y <= 40
    );
    configureRectangle(
      farRegion,
      [60, -80, 80, -80, 80, 80, 60, 80],
      { x: 60, y: -80, width: 20, height: 160 },
      ({ x, y }) => x >= 60 && x <= 80 && y >= -80 && y <= 80
    );
    globalThis.canvas.scene = createScene([nearRegion, farRegion]);
    const sameStateVisionSource = new globalThis.CONFIG.Canvas.visionSourceClass();
    Object.assign(sameStateVisionSource, {
      data: { x: 0, y: 0, elevation: 0, externalRadius: 0 },
      object: {
        document: { detectionModes: { basicSight: { enabled: true, range: 1 } } },
        getLightRadius: range => range * 100
      }
    });
    sameStateVisionSource._createShapes();
    const sameStateConstraint = appliedConstraints.at(-1).points;
    assert.equal(sameStateConstraint.some((_value, index, points) => {
      if (index % 2) return false;
      const next = (index + 2) % points.length;
      const first = { x: points[index], y: points[index + 1] };
      const second = { x: points[next], y: points[next + 1] };
      return Math.abs(first.y) < 1e-6
        && Math.abs(second.y) < 1e-6
        && first.x > 0
        && second.x > 0
        && first.x < 100
        && second.x < 100
        && Math.abs(first.x - second.x) > 20;
    }), true);

    globalThis.canvas.scene = createScene([]);
    syncSmokeDarknessMeshes({ forceRendering: true, forceVision: true });
    assert.equal(edges.size, 0);
  } finally {
    globalThis.canvas = previous.canvas;
    globalThis.game = previous.game;
    globalThis.foundry = previous.foundry;
    globalThis.CONST = previous.CONST;
    globalThis.CONFIG = previous.CONFIG;
    globalThis.Hooks = previous.Hooks;
    globalThis.PIXI = previous.PIXI;
  }
});

function createScene(regions) {
  return { regions: { contents: regions } };
}

function createNativeEffectsContainer() {
  return {
    children: [],
    filter: { enabled: false },
    visible: true,
    addChild(mesh) {
      if (mesh.parent && mesh.parent !== this) mesh.parent.removeChild(mesh);
      if (!this.children.includes(mesh)) this.children.push(mesh);
      mesh.parent = this;
      return mesh;
    },
    removeChild(mesh) {
      const index = this.children.indexOf(mesh);
      if (index >= 0) this.children.splice(index, 1);
      if (mesh.parent === this) mesh.parent = null;
      return mesh;
    }
  };
}

function createSourceCollection(sources) {
  return new Map(sources.map(source => [source.sourceId, source]));
}

function installNativeSourceRenderMock(source, layerIds) {
  source.layers = Object.fromEntries(layerIds.map(layerId => [layerId, { mesh: { parent: null } }]));
  source.drawMeshes = () => Object.fromEntries(layerIds.map(layerId => [layerId, true]));
}

function createFactionActor(uuid, faction) {
  return {
    uuid,
    getFlag: (_scope, key) => key === "factionBelongs" ? [faction] : undefined
  };
}

function createSmokeRegion(id, densityPercent) {
  const region = {
    id,
    hidden: false,
    elevation: { bottom: null, top: null },
    shapes: [{ type: "circle", x: 5, y: 0, radius: 20 }],
    object: { bounds: { x: 0, y: 0, width: 10, height: 10 } },
    segmentizeMovementPath: waypoints => segmentizeTestCircle(waypoints, region.shapes[0]),
    behaviors: {
      contents: [{
        uuid: `Behavior.${id}`,
        type: "fallout-maw.periodicDamage",
        disabled: false,
        system: {
          regionSpecialProperties: [{
            type: "smoke",
            smoke: { thickness: "1", densityPercent: String(densityPercent) }
          }],
          durationSeconds: 0,
          delaySeconds: 0
        },
        getFlag: () => ({ activateAt: 0, expiresAt: null })
      }]
    }
  };
  Object.defineProperty(region, "polygons", {
    configurable: true,
    get: () => [{ points: createTestCirclePoints(region.shapes[0]) }]
  });
  const nativePolygon = {};
  Object.defineProperty(nativePolygon, "points", {
    configurable: true,
    get: () => createTestCirclePoints(region.shapes[0])
  });
  region.polygonTree = {
    polygons: [nativePolygon],
    testPoint: ({ x, y }) => {
      const circle = region.shapes[0];
      return Math.hypot(x - Number(circle.x), y - Number(circle.y)) <= Number(circle.radius);
    }
  };
  return region;
}

function segmentizeTestCircle([from, to], circle) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const fx = from.x - (Number(circle.x) || 0);
  const fy = from.y - (Number(circle.y) || 0);
  const radius = Math.max(0, Number(circle.radius) || 0);
  const a = (dx * dx) + (dy * dy);
  if (!a || !radius) return [];
  const b = 2 * ((fx * dx) + (fy * dy));
  const c = (fx * fx) + (fy * fy) - (radius * radius);
  const discriminant = (b * b) - (4 * a * c);
  if (discriminant <= 0) return [];
  const root = Math.sqrt(discriminant);
  const start = Math.max(0, (-b - root) / (2 * a));
  const end = Math.min(1, (-b + root) / (2 * a));
  if (end <= start) return [];
  const pointAt = t => ({
    x: from.x + (dx * t),
    y: from.y + (dy * t),
    elevation: from.elevation ?? 0
  });
  return [{ from: pointAt(start), to: pointAt(end) }];
}

function createTestCirclePoints(circle, density = 24) {
  const points = [];
  for (let i = 0; i < density; i++) {
    const angle = (i / density) * Math.PI * 2;
    points.push(
      (Number(circle.x) || 0) + (Math.cos(angle) * (Number(circle.radius) || 0)),
      (Number(circle.y) || 0) + (Math.sin(angle) * (Number(circle.radius) || 0))
    );
  }
  return points;
}
