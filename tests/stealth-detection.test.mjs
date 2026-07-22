import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildObserverDetectionZone,
  computeDetectionPathCost,
  getStealthDetectionCacheStats,
  invalidateStealthDetectionCache,
  testStealthDetectionPoint
} from "../src/stealth/detection.mjs";
import { invalidateLightingAnalysisCache } from "../src/stealth/lighting.mjs";

const originalCanvas = globalThis.canvas;
const originalPIXI = globalThis.PIXI;

afterEach(() => {
  invalidateStealthDetectionCache();
  invalidateLightingAnalysisCache();
  if (originalCanvas === undefined) delete globalThis.canvas;
  else globalThis.canvas = originalCanvas;
  if (originalPIXI === undefined) delete globalThis.PIXI;
  else globalThis.PIXI = originalPIXI;
});

test("gameplay detection samples the complete path while preview sampling is capped", () => {
  installRectangleMock();
  globalThis.canvas = createLinearCanvas({ cells: 33, cellSize: 100, darknessBand: [75, 125] });
  const observer = createObserver("observer-exact");
  const settings = createSettings("32");
  const origin = { x: 0, y: 0, elevation: 0 };
  const destination = { x: 3_200, y: 0, elevation: 0 };

  assert.equal(computeDetectionPathCost(observer, origin, destination, settings), 33);
  assert.equal(computeDetectionPathCost(observer, origin, destination, settings, { sampleLimit: 16 }), 32);
  assert.equal(
    computeDetectionPathCost(observer, origin, { x: 1_600, y: 0, elevation: 0 }, settings),
    computeDetectionPathCost(observer, origin, { x: 1_600, y: 0, elevation: 0 }, settings, { sampleLimit: 16 })
  );

  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  assert.equal(testStealthDetectionPoint(observer, origin, destination, { settings }), false);

  const preview = buildObserverDetectionZone(observer, { origin, settings });
  assert.equal(preview.offsets.some(({ i, j }) => i === 0 && j === 32), true);
  assert.equal(preview.truncated, false);
});

test("preview construction and its LRU cache both obey cell budgets", () => {
  installRectangleMock();
  const initialStats = getStealthDetectionCacheStats();
  const cellsPerZone = initialStats.maxPreviewCells;
  globalThis.canvas = createLinearCanvas({ cells: cellsPerZone, cellSize: 1 });
  const settings = createSettings(String(cellsPerZone - 1));
  const observers = ["a", "b", "c", "d", "e"].map(createObserverWithUnlimitedSight);

  const zones = observers.slice(0, 4).map(observer => buildObserverDetectionZone(observer, { settings }));
  assert.equal(getStealthDetectionCacheStats().zoneCells, cellsPerZone * 4);
  assert.strictEqual(buildObserverDetectionZone(observers[0], { settings }), zones[0]);

  buildObserverDetectionZone(observers[4], { settings });
  const bounded = getStealthDetectionCacheStats();
  assert.equal(bounded.zones, 4);
  assert.equal(bounded.zoneCells, cellsPerZone * 4);
  assert.ok(bounded.zoneCells <= bounded.maxZoneCells);
  assert.notStrictEqual(buildObserverDetectionZone(observers[1], { settings }), zones[1]);

  invalidateStealthDetectionCache();
  assert.deepEqual(
    pickCacheUsage(getStealthDetectionCacheStats()),
    { zones: 0, points: 0, zoneCells: 0 }
  );

  const oversizedCells = bounded.maxPreviewCells * 3;
  globalThis.canvas = createLinearCanvas({ cells: oversizedCells, cellSize: 1 });
  const oversized = buildObserverDetectionZone(createObserverWithUnlimitedSight("oversized"), {
    settings: createSettings(String(oversizedCells - 1))
  });
  assert.equal(oversized.truncated, true);
  assert.ok(oversized.offsets.length <= bounded.maxPreviewCells);
});

function createLinearCanvas({ cells, cellSize, darknessBand = null }) {
  const scene = { id: `scene-${cells}-${cellSize}`, grid: { distance: 1 } };
  const grid = {
    distance: 1,
    isGridless: false,
    size: cellSize,
    getCenterPoint: ({ j }) => ({ x: j * cellSize, y: 0, elevation: 0 }),
    getOffset: point => ({ i: 0, j: Math.round((Number(point?.x) || 0) / cellSize) }),
    getOffsetRange: () => [0, 0, 1, cells]
  };
  return {
    ready: true,
    scene,
    grid,
    dimensions: { rect: { x: 0, y: 0, width: cells * cellSize, height: cellSize } },
    environment: { darknessLevel: 0, globalLightSource: { active: false } },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: point => darknessBand
        && point.x >= darknessBand[0]
        && point.x <= darknessBand[1] ? 1 : 0,
      testInsideDarkness: () => false
    }
  };
}

function createObserver(id) {
  return {
    id,
    actor: { system: { skills: { naturalist: { value: 0 } } } },
    hasSight: true,
    checkCollision: () => false,
    document: {
      elevation: 0,
      sight: { enabled: true, range: 0 },
      detectionModes: { basicSight: { enabled: true, range: 0 } }
    }
  };
}

function createObserverWithUnlimitedSight(id) {
  const observer = createObserver(id);
  observer.document.sight.range = null;
  observer.document.detectionModes.basicSight.range = null;
  return observer;
}

function createSettings(rangeFormula) {
  return Object.freeze({
    detection: Object.freeze({ skillKey: "naturalist", rangeFormula }),
    attenuationLevels: Object.freeze([
      Object.freeze({ threshold: 0.5, penaltyPercent: 50 }),
      Object.freeze({ threshold: 0, penaltyPercent: 0 })
    ])
  });
}

function installRectangleMock() {
  globalThis.PIXI = {
    Rectangle: class Rectangle {
      constructor(x, y, width, height) {
        Object.assign(this, { x, y, width, height });
      }

      fit() {
        return this;
      }
    }
  };
}

function pickCacheUsage(stats) {
  return { zones: stats.zones, points: stats.points, zoneCells: stats.zoneCells };
}
