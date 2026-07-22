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
