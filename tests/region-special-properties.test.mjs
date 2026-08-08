import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultRegionSpecialPropertyData,
  normalizeRegionSpecialProperties,
  resolveRegionSpecialProperties
} from "../src/utils/region-special-properties.mjs";
import {
  calculateSmokePathCost,
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

test("light perception spends its visibility budget only while crossing smoke", () => {
  const region = createSmokeRegion("lit-approach", 50);
  region.shapes[0] = { type: "circle", x: 500, y: 0, radius: 100 };
  region.object.bounds = { x: 400, y: -100, width: 200, height: 200 };
  const scene = createScene([region]);
  const from = { x: 0, y: 0, elevation: 0 };
  const to = { x: 1000, y: 0, elevation: 0 };

  const ordinary = measureSmokePath(from, to, { scene, elevation: 0, budget: 200 });
  const illuminated = measureSmokePath(from, to, {
    scene,
    elevation: 0,
    budget: 200,
    chargeClearDistance: false
  });

  assert.equal(ordinary.visibleDistance, 200);
  assert.ok(Math.abs(illuminated.cost - 400) < 1e-6);
  assert.ok(Math.abs(illuminated.visibleDistance - 500) < 1e-6);
});

test("light perception cannot reveal a token across smoke outside the basic sight budget", () => {
  const previous = {
    CONFIG: globalThis.CONFIG,
    Hooks: globalThis.Hooks,
    canvas: globalThis.canvas,
    game: globalThis.game,
    PIXI: globalThis.PIXI
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
      this.los = createMask("los");
      this.light = createMask("native-light");
      this.shape = createMask("native-sight");
    }
  }
  function createMask(name) {
    return {
      origin: { x: 0, y: 0 },
      config: { radius: 200 },
      applyConstraint(constraint, options) {
        constrainedMasks.push({ name, constraint, options });
        return this;
      }
    };
  }
  const region = createSmokeRegion("light-perception", 50);
  region.shapes[0] = { type: "circle", x: 0, y: 0, radius: 100 };
  region.object.bounds = { x: -100, y: -100, width: 200, height: 200 };
  const scene = createScene([region]);

  try {
    globalThis.CONFIG = {
      Canvas: {
        detectionModes: { basicSight, lightPerception, specialSense },
        visionSourceClass: MockVisionSource
      }
    };
    globalThis.PIXI = { Polygon: class { constructor(points) { this.points = points; } } };
    globalThis.Hooks = { on() {} };
    globalThis.game = { time: { worldTime: 0 } };
    globalThis.canvas = {
      ready: false,
      scene,
      dimensions: { maxR: 1000 }
    };

    registerSmokeVisionHooks();

    const visionSource = new globalThis.CONFIG.Canvas.visionSourceClass();
    Object.assign(visionSource, {
      data: { x: 0, y: 0, elevation: 0, externalRadius: 0 },
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
    const outside = { point: { x: 200, y: 0, elevation: 0 } };

    assert.notEqual(basicSight._testRange, nativeRange);
    assert.notEqual(lightPerception._testRange, nativeRange);
    assert.equal(specialSense._testRange, nativeRange);
    visionSource._createShapes();
    assert.deepEqual(constrainedMasks.map(mask => mask.name), ["native-light", "native-sight"]);
    assert.notEqual(constrainedMasks[0].constraint, constrainedMasks[1].constraint);
    assert.equal(lightPerception._testRange(visionSource, { range: Infinity }, token, outside), false);
    assert.equal(lightPerception._testRange(visionSource, { range: Infinity }, { document: {} }, outside), true);
  } finally {
    globalThis.CONFIG = previous.CONFIG;
    globalThis.Hooks = previous.Hooks;
    globalThis.canvas = previous.canvas;
    globalThis.game = previous.game;
    globalThis.PIXI = previous.PIXI;
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
  let includedSmokeEdge = false;

  class MockSweep {
    static create(origin, config) {
      sweepCalls += 1;
      const polygon = new this();
      polygon.origin = origin;
      polygon.config = config;
      includedSmokeEdge = [...globalThis.canvas.edges.values()]
        .some(edge => polygon._testEdgeInclusion(edge, {}));
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
        polygonBackends: { sight: MockSweep },
        visionSourceClass: MockVisionSource
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
      perception: { update() {} }
    };

    registerSmokeVisionHooks();
    syncSmokeDarknessMeshes({ forceRendering: true, forceVision: true });

    assert.equal(edges.size, 4);
    assert.equal([...edges.values()].every(edge => edge.type === "fallout-maw.smoke"), true);
    assert.equal([...edges.values()].every(edge => edge.sight === 20), true);
    assert.equal([...edges.values()].every(edge => edge.object === undefined), true);

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
    assert.equal(includedSmokeEdge, true);

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
