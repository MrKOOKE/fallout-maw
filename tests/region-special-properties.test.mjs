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
  invalidateSmokeRegionIndex,
  measureSmokePath,
  registerSmokeVisionHooks,
  syncSmokeDarknessMeshes
} from "../src/canvas/smoke-vision.mjs";

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
    calculateSmokePathCost({ x: 0, y: 0, elevation: 0 }, { x: 10, y: 0, elevation: 0 }, { scene, elevation: 0 }),
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

test("partial smoke constrains global light while restoring observer smoke blocking", () => {
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
  class MockVisionSource {
    get lightRadius() { return 200; }
    get radius() { return 200; }
    _createShapes() {
      const origin = { x: this.data?.x ?? 0, y: this.data?.y ?? 0 };
      this.los = createMask("los", 200, origin);
      this.light = createMask("native-light", 200, origin);
      this.shape = createMask("native-sight", 200, origin);
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
        constrained.points = constraint.points;
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
      dimensions: { maxR: 1000 }
    };

    registerSmokeVisionHooks();

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
      "native-light",
      "native-sight"
    ]);
    assert.ok(lightSource.shape.contains(10, 0));
    assert.equal(lightSource.shape.config.radius, 200);
    assert.equal(getSmokeLightBandAtPoint(lightSource, { x: 10, y: 0 }), "bright");
    assert.equal(basicSight._testRange(visionSource, { range: 1 }, token, reachedByForeignLight), true);
    assert.equal(lightPerception._testRange(visionSource, { range: Infinity }, token, outside), false);
    assert.equal(lightPerception._testRange(visionSource, { range: Infinity }, token, reachedByForeignLight), true);
    assert.equal(lightPerception._testRange(visionSource, { range: Infinity }, { document: {} }, outside), true);
    assert.equal(differenceCalls, 1);
    lightSource._configure({});
    assert.equal(lightSource.nativeConfigured, true);
    assert.equal(lightSource._drawMesh("illumination"), "native-illumination");
    lightSource.animate();
    assert.equal(lightSource.nativeAnimated, true);
    lightSource._destroy();
    assert.equal(lightSource.nativeDestroyed, true);
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
    assert.equal(collisionConfig._falloutMawIncludeSmokeEdges, false);
  } finally {
    globalThis.CONFIG = previous.CONFIG;
    globalThis.Hooks = previous.Hooks;
    globalThis.canvas = previous.canvas;
    globalThis.game = previous.game;
    globalThis.foundry = previous.foundry;
  }
});

test("opaque Region polygon boundaries use Foundry CanvasEdges without Wall documents", () => {
  const previous = {
    canvas: globalThis.canvas,
    game: globalThis.game,
    foundry: globalThis.foundry,
    CONST: globalThis.CONST,
    CONFIG: globalThis.CONFIG,
    Hooks: globalThis.Hooks
  };
  const region = createSmokeRegion("native-edges", 100);
  region.shapes = [{ type: "polygon" }];
  region.object.bounds = { x: 0, y: 0, width: 100, height: 100 };
  Object.defineProperty(region, "polygons", {
    configurable: true,
    value: [{ points: [0, 0, 100, 0, 100, 100, 0, 100] }]
  });
  const scene = createScene([region]);
  const edges = new Map();
  const meshes = { addChild() {} };
  let sweepCalls = 0;
  const sweepTypes = [];
  const includedSmokeEdges = [];
  const perceptionUpdates = [];

  class MockSweep {
    static create(origin, config) {
      sweepCalls += 1;
      sweepTypes.push(config.type);
      const polygon = new this();
      polygon.origin = origin;
      polygon.config = config;
      includedSmokeEdges.push([...globalThis.canvas.edges.values()]
        .some(edge => polygon._testEdgeInclusion(edge, {})));
      return { origin, config, applyConstraint() { return this; } };
    }

    _testEdgeInclusion() { return false; }
  }

  class MockVisionSource {
    get lightRadius() { return 100; }
    get radius() { return 100; }
    _getPolygonConfiguration() { return { type: "sight", radius: 100, edgeTypes: { wall: true } }; }
    _createShapes() {
      this.shape = globalThis.CONFIG.Canvas.polygonBackends.sight.create(
        this.data,
        this._getPolygonConfiguration()
      );
      this.los = this.light = this.shape;
    }
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

    assert.equal(edges.size, 4);
    assert.equal([...edges.values()].every(edge => edge.type === "fallout-maw.smoke"), true);
    assert.equal([...edges.values()].every(edge => edge.sight === 20), true);
    assert.equal([...edges.values()].every(edge => edge.light === 20), true);
    assert.equal([...edges.values()].every(edge => edge.object === undefined), true);
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
    assert.equal(includedSmokeEdges[0], true);

    const lightSource = new globalThis.CONFIG.Canvas.lightSourceClass();
    Object.assign(lightSource, {
      data: { x: 50, y: 50, elevation: 0, bright: 100, dim: 100 }
    });
    lightSource._createShapes();
    assert.equal(sweepCalls, 2);
    assert.deepEqual(sweepTypes, ["sight", "light"]);
    assert.equal(includedSmokeEdges[1], true);

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
  }
});

function createScene(regions) {
  return { regions: { contents: regions } };
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
