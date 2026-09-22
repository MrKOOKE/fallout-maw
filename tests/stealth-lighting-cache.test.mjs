import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  analyzeLightingPoint,
  analyzeTokenLighting,
  getLightingAnalysisCacheStats,
  invalidateLightingAnalysisCache
} from "../src/stealth/lighting.mjs";

const originalCanvas = globalThis.canvas;

afterEach(() => {
  invalidateLightingAnalysisCache();
  if (originalCanvas === undefined) delete globalThis.canvas;
  else globalThis.canvas = originalCanvas;
});

function createLightingCanvas({ scene = {}, testPoint = () => true } = {}) {
  const calls = { testPoint: 0 };
  const source = {
    active: true,
    origin: { x: 0, y: 0 },
    data: { bright: 0, dim: 100 },
    testPoint(point) {
      calls.testPoint += 1;
      return testPoint(point);
    }
  };
  return {
    calls,
    canvas: {
      scene,
      environment: {
        darknessLevel: 1,
        globalLightSource: { active: false }
      },
      effects: {
        lightSources: new Map([["local", source]]),
        getDarknessLevel: () => 1,
        testInsideDarkness: () => false
      }
    }
  };
}

function createLevelCanvas() {
  const region = {
    hidden: false,
    includedInLevel: level => level === "basement",
    testPoint: point => point.x < 100 && point.elevation < 5,
    behaviors: [{ type: "adjustDarknessLevel", active: true, system: { mode: 0, modifier: 1 } }]
  };
  return {
    level: { id: "surface" },
    scene: { regions: [region] },
    environment: { darknessLevel: 0, globalLightSource: { active: false } },
    effects: {
      // Foundry's native query reads only viewed meshes and their last-rendered uniforms.
      getDarknessLevel: () => 0,
      testInsideDarkness: () => false,
      lightSources: new Map()
    }
  };
}

test("a basement darkness override applies without a rendered mesh or a change of viewed level", () => {
  globalThis.canvas = createLevelCanvas();
  const document = {
    level: "basement", elevation: 0,
    // V14 supplies elevation but no level in these points.
    getVisibilityTestPoints: () => [{ x: 20, y: 20, elevation: 0 }]
  };
  assert.equal(analyzeTokenLighting({ document }).effectiveDarkness, 1);
  assert.equal(analyzeLightingPoint({ x: 20, y: 20, elevation: 0, level: "surface" }).effectiveDarkness, 0);
  assert.equal(canvas.level.id, "surface");
});

test("same-position token and route caches distinguish level-only transitions", () => {
  globalThis.canvas = createLevelCanvas();
  const document = { level: "surface", getVisibilityTestPoints: () => [{ x: 20, y: 20, elevation: 0 }] };
  const token = { document };
  assert.equal(analyzeTokenLighting(token).effectiveDarkness, 0);
  assert.equal(analyzeTokenLighting(token, { position: { level: "basement" } }).effectiveDarkness, 1);
  assert.equal(document.level, "surface");
  document.level = "basement";
  assert.equal(analyzeTokenLighting(token).effectiveDarkness, 1);
  assert.equal(analyzeTokenLighting(token, { position: { level: "surface" } }).effectiveDarkness, 0);
});

test("region darkness follows V14 modes and overlapping regions choose the lowest adjusted darkness", () => {
  globalThis.canvas = createLevelCanvas();
  canvas.environment.darknessLevel = 0.4;
  const region = canvas.scene.regions[0];
  const point = { x: 20, y: 20, elevation: 0, level: "basement" };
  for (const [mode, expected] of [[0, 0.5], [1, 0.2], [2, 0.7]]) {
    region.behaviors[0].system = { mode, modifier: 0.5 };
    invalidateLightingAnalysisCache();
    assert.equal(analyzeLightingPoint(point).baseDarkness, expected);
  }
  region.behaviors.push({ type: "adjustDarknessLevel", active: true, system: { mode: 0, modifier: 0.3 } });
  invalidateLightingAnalysisCache();
  assert.equal(analyzeLightingPoint(point).baseDarkness, 0.3);
});

test("disabled, hidden, out-of-shape and out-of-elevation darkness regions do not apply", () => {
  globalThis.canvas = createLevelCanvas();
  const region = canvas.scene.regions[0];
  const point = { x: 20, y: 20, elevation: 0, level: "basement" };
  assert.equal(analyzeLightingPoint({ ...point, x: 150 }).baseDarkness, 0);
  assert.equal(analyzeLightingPoint({ ...point, elevation: 10 }).baseDarkness, 0);
  region.behaviors[0].disabled = true;
  assert.equal(analyzeLightingPoint(point).baseDarkness, 0);
  region.behaviors[0].disabled = false;
  region.hidden = true;
  invalidateLightingAnalysisCache();
  assert.equal(analyzeLightingPoint(point).baseDarkness, 0);
});

test("global light uses the token level's darkness threshold instead of the viewed level", () => {
  globalThis.canvas = createLevelCanvas();
  canvas.environment.globalLightSource = { active: true, data: { darkness: { min: 0, max: 0.5 } } };
  canvas.effects.testInsideLight = () => true;
  const point = { x: 20, y: 20, elevation: 0, level: "basement" };
  assert.equal(analyzeLightingPoint(point).effectiveDarkness, 1);
  assert.equal(analyzeLightingPoint({ ...point, level: "surface" }).effectiveDarkness, 0);
});

test("recorded basement override survives an active global source belonging to the surface level", () => {
  globalThis.canvas = createLevelCanvas();
  canvas.level = { id: "basement" };
  canvas.environment.globalLightSource = {
    active: true,
    level: { id: "surface" },
    data: { bright: 0, dim: 27662.017280017742, darkness: { min: 0, max: 1 } }
  };
  canvas.scene.levels = new Map([
    ["surface", { visibility: { levels: new Set() } }],
    ["basement", { visibility: { levels: new Set() } }]
  ]);
  const point = { x: 20, y: 20, elevation: -3.5, level: "basement" };
  const basement = analyzeLightingPoint(point);
  assert.equal(basement.baseDarkness, 1);
  assert.equal(basement.lightIntensity, 0);
  assert.equal(basement.effectiveDarkness, 1);

  // Keep configured global light when its own level is evaluated, including
  // a level whose visibility explicitly includes that source's level.
  canvas.environment.darknessLevel = 1;
  invalidateLightingAnalysisCache();
  assert.equal(analyzeLightingPoint({ ...point, level: "surface" }).effectiveDarkness, 0);
  canvas.scene.levels.get("basement").visibility.levels.add("surface");
  invalidateLightingAnalysisCache();
  assert.equal(analyzeLightingPoint(point).effectiveDarkness, 0);
});

test("a light on another level does not illuminate a basement at the same coordinates and elevation", () => {
  globalThis.canvas = createLevelCanvas();
  const source = {
    active: true, origin: { x: 20, y: 20 }, data: { bright: 100 },
    object: { document: { includedInLevel: level => level === "surface" } },
    testPoint: () => true
  };
  canvas.effects.lightSources.set("lamp", source);
  const point = { x: 20, y: 20, elevation: 0, level: "basement" };
  assert.equal(analyzeLightingPoint(point).effectiveDarkness, 1);
  source.object.document.includedInLevel = () => true;
  invalidateLightingAnalysisCache();
  assert.equal(analyzeLightingPoint(point).effectiveDarkness, 0);
});

test("repeated point analysis reuses its source traversal until invalidated", () => {
  const fixture = createLightingCanvas();
  globalThis.canvas = fixture.canvas;
  invalidateLightingAnalysisCache();

  const first = analyzeLightingPoint({ x: 20, y: 0, elevation: 3 });
  const second = analyzeLightingPoint({ x: 20, y: 0, elevation: 3 });

  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  assert.equal(fixture.calls.testPoint, 1);

  invalidateLightingAnalysisCache();
  assert.deepEqual(analyzeLightingPoint({ x: 20, y: 0, elevation: 3 }), first);
  assert.equal(fixture.calls.testPoint, 2);
});

test("route lighting samples a future token footprint without moving the document", () => {
  const fixture = createLightingCanvas();
  globalThis.canvas = fixture.canvas;
  canvas.effects.getDarknessLevel = point => point.x >= 100 ? 0 : 1;
  canvas.effects.lightSources.clear();
  const document = {
    x: 0, y: 0, elevation: 4,
    getVisibilityTestPoints(position = {}) {
      return [{ x: position.x ?? this.x, y: position.y ?? this.y, elevation: position.elevation ?? this.elevation }];
    }
  };
  assert.equal(analyzeTokenLighting({ document }).effectiveDarkness, 1);
  assert.equal(analyzeTokenLighting({ document }, { position: { x: 100, y: 0, elevation: 8 } }).effectiveDarkness, 0);
  assert.equal(document.x, 0);
  assert.equal(document.elevation, 4);
  assert.equal(analyzeTokenLighting({ document }).effectiveDarkness, 1);
});

test("token analysis is cached by its sampled positions and recomputed after invalidation", () => {
  const fixture = createLightingCanvas();
  globalThis.canvas = fixture.canvas;
  invalidateLightingAnalysisCache();
  let x = 10;
  const token = {
    document: {
      id: "token-1",
      getVisibilityTestPoints: () => [
        { x, y: 0, elevation: 4 },
        { x: x + 10, y: 0, elevation: 4 }
      ]
    }
  };

  const first = analyzeTokenLighting(token);
  assert.deepEqual(analyzeTokenLighting(token), first);
  assert.equal(fixture.calls.testPoint, 2);

  x = 60;
  const moved = analyzeTokenLighting(token);
  assert.notEqual(moved.effectiveDarkness, first.effectiveDarkness);
  assert.equal(fixture.calls.testPoint, 4);

  invalidateLightingAnalysisCache();
  assert.deepEqual(analyzeTokenLighting(token), moved);
  assert.equal(fixture.calls.testPoint, 6);
});

test("point cache separates positions and elevations", () => {
  const fixture = createLightingCanvas({ testPoint: point => point.elevation > 0 });
  globalThis.canvas = fixture.canvas;
  invalidateLightingAnalysisCache();

  const near = analyzeLightingPoint({ x: 10, y: 0, elevation: 1 });
  const far = analyzeLightingPoint({ x: 90, y: 0, elevation: 1 });
  const ground = analyzeLightingPoint({ x: 10, y: 0, elevation: 0 });

  assert.notEqual(near.effectiveDarkness, far.effectiveDarkness);
  assert.notEqual(near.effectiveDarkness, ground.effectiveDarkness);
  assert.equal(fixture.calls.testPoint, 3);
});

test("point cache separates scenes even at identical coordinates", () => {
  const firstScene = createLightingCanvas();
  const secondScene = createLightingCanvas();
  invalidateLightingAnalysisCache();

  globalThis.canvas = firstScene.canvas;
  analyzeLightingPoint({ x: 20, y: 0, elevation: 2 });
  globalThis.canvas = secondScene.canvas;
  analyzeLightingPoint({ x: 20, y: 0, elevation: 2 });

  assert.equal(firstScene.calls.testPoint, 1);
  assert.equal(secondScene.calls.testPoint, 1);
});

test("lighting analysis LRU caches stay within their configured bounds", () => {
  const fixture = createLightingCanvas();
  globalThis.canvas = fixture.canvas;
  invalidateLightingAnalysisCache();
  let stats = getLightingAnalysisCacheStats();

  for (let index = 0; index < stats.point.maxEntries; index += 1) {
    analyzeLightingPoint({ x: index, y: 0, elevation: 0 });
  }
  analyzeLightingPoint({ x: 0, y: 0, elevation: 0 });
  analyzeLightingPoint({ x: stats.point.maxEntries, y: 0, elevation: 0 });
  stats = getLightingAnalysisCacheStats();
  assert.equal(stats.point.entries, stats.point.maxEntries);
  const traversalsAfterEviction = fixture.calls.testPoint;
  analyzeLightingPoint({ x: 0, y: 0, elevation: 0 });
  assert.equal(fixture.calls.testPoint, traversalsAfterEviction);
  analyzeLightingPoint({ x: 1, y: 0, elevation: 0 });
  assert.equal(fixture.calls.testPoint, traversalsAfterEviction + 1);

  invalidateLightingAnalysisCache();
  stats = getLightingAnalysisCacheStats();
  for (let index = 0; index <= stats.token.maxEntries; index += 1) {
    analyzeTokenLighting({
      document: {
        id: `token-${index}`,
        getVisibilityTestPoints: () => [{ x: 10, y: 0, elevation: 0 }]
      }
    });
  }
  stats = getLightingAnalysisCacheStats();
  assert.equal(stats.token.entries, stats.token.maxEntries);
});
