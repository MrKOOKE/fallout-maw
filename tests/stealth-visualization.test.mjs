import assert from "node:assert/strict";
import { test } from "node:test";

import { collectGridBoundaryEdges } from "../src/stealth/visualization.mjs";

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
