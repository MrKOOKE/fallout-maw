import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cleanupAllStealthVisualizations,
  clearWeaponNoisePreview,
  collectGridBoundaryEdges,
  collectUniqueGridOffsets,
  getStealthVisualizationStats,
  removeDetectionVisualization,
  setPersistentDetectionVisualization,
  setWeaponNoisePreview,
  updateDetectionVisualization
} from "../src/stealth/visualization.mjs";

function edgeKey({ start, end }) {
  const left = `${start.x},${start.y}`;
  const right = `${end.x},${end.y}`;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

test("two adjacent square cells omit their shared edge", () => {
  const vertices = new Map([
    ["left", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]],
    ["right", [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 }
    ]]
  ]);

  const edges = collectGridBoundaryEdges(["left", "right"], offset => vertices.get(offset));
  const keys = new Set(edges.map(edgeKey));

  assert.equal(edges.length, 6);
  assert.equal(keys.has("10,0|10,10"), false);
  assert.deepEqual(keys, new Set([
    "0,0|10,0",
    "0,10|10,10",
    "0,0|0,10",
    "10,0|20,0",
    "20,0|20,10",
    "10,10|20,10"
  ]));
});

test("arbitrary polygons omit a shared edge regardless of winding", () => {
  const polygons = new Map([
    ["lower", [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 3 }
    ]],
    ["upper", [
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 2, y: 3 }
    ]]
  ]);

  const edges = collectGridBoundaryEdges(["lower", "upper"], offset => polygons.get(offset));
  const keys = new Set(edges.map(edgeKey));

  assert.equal(edges.length, 4);
  assert.equal(keys.has("2,3|4,0"), false);
  assert.deepEqual(keys, new Set([
    "0,0|4,0",
    "0,0|2,3",
    "4,0|4,4",
    "2,3|4,4"
  ]));
});

test("noise cells from overlapping zones form one union before fill and outline", () => {
  const left = { i: 0, j: 0 };
  const right = { i: 0, j: 1 };
  const lowerRight = { i: 1, j: 1 };
  const offsets = collectUniqueGridOffsets([
    [left, right],
    [right, lowerRight],
    [{ i: 0, j: 0 }]
  ]);

  assert.deepEqual(
    offsets.map(offset => `${offset.i}:${offset.j}`),
    ["0:0", "0:1", "1:1"]
  );

  const vertices = new Map([
    ["0:0", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]],
    ["0:1", [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 }
    ]],
    ["1:1", [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 }
    ]]
  ]);
  const edges = collectGridBoundaryEdges(
    offsets,
    offset => vertices.get(`${offset.i}:${offset.j}`)
  );
  const keys = new Set(edges.map(edgeKey));

  assert.equal(edges.length, 8);
  assert.equal(keys.has("10,0|10,10"), false);
  assert.equal(keys.has("10,10|20,10"), false);
});

test("persistent, stealth-window, and weapon previews own independent visualization sources", () => {
  const token = { id: "hidden-token" };
  try {
    setPersistentDetectionVisualization(token);
    updateDetectionVisualization(token);
    setWeaponNoisePreview(token, "attack-a", 2);
    setWeaponNoisePreview(token, "attack-b", 5);
    setWeaponNoisePreview(token, "attack-b", 5);
    assert.deepEqual(
      pickSourceStats(getStealthVisualizationStats()),
      { active: 1, sources: 4, maximumNoiseLevel: 5 }
    );

    clearWeaponNoisePreview(token.id, "attack-b");
    removeDetectionVisualization(token.id);
    assert.deepEqual(
      pickSourceStats(getStealthVisualizationStats()),
      { active: 1, sources: 2, maximumNoiseLevel: 2 }
    );

    clearWeaponNoisePreview(token.id, "attack-a");
    assert.deepEqual(
      pickSourceStats(getStealthVisualizationStats()),
      { active: 1, sources: 1, maximumNoiseLevel: 0 }
    );

    setPersistentDetectionVisualization(token, false);
    assert.deepEqual(
      pickSourceStats(getStealthVisualizationStats()),
      { active: 0, sources: 0, maximumNoiseLevel: 0 }
    );
  } finally {
    cleanupAllStealthVisualizations();
  }
});

function pickSourceStats(stats) {
  return {
    active: stats.active,
    sources: stats.sources,
    maximumNoiseLevel: stats.maximumNoiseLevel
  };
}
