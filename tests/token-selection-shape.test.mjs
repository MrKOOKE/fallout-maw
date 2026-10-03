import test from "node:test";
import assert from "node:assert/strict";
import { getTokenSelectionShape, isPointInTokenSelectionShape } from "../src/canvas/token-selection-shape.mjs";
import { getTokenHitboxGeometry } from "../src/utils/token-hitbox.mjs";

test("selection follows the native rotating footprint, including clicks outside the original frame", () => {
  const document = { x: 1000, y: 1000, rotation: 0, getSize: () => ({ width: 300, height: 500 }),
    flags: { "fallout-maw": { tokenHitbox: { enabled: true } } },
    getGridSpacePolygon() { return getTokenHitboxGeometry(this).points; } };
  const token = { document }, original = getTokenSelectionShape(token);
  document.rotation = 90;
  const rotated = getTokenSelectionShape(token);
  assert.notEqual(rotated.signature, original.signature);
  assert.deepEqual(rotated.points, document.getGridSpacePolygon());
  assert.equal(isPointInTokenSelectionShape({ x: 950, y: 1250 }, token), true);
  assert.equal(isPointInTokenSelectionShape({ x: 1150, y: 1050 }, token), false);
  document.rotation = 45;
  const shape = getTokenSelectionShape(token);
  const corner = { x: shape.x + Math.min(...shape.points.map(p => p.x)) + 1,
    y: shape.y + Math.min(...shape.points.map(p => p.y)) + 1 };
  assert.equal(isPointInTokenSelectionShape(corner, token), false, "Empty bounding-box corners are not selectable");
  assert.equal(isPointInTokenSelectionShape({ x: 1150, y: 1250 }, token), true);
  assert.equal(isPointInTokenSelectionShape({ x: shape.x + shape.points[0].x, y: shape.y + shape.points[0].y }, token), true);
});

test("ordinary native polygons keep their shape, independent of image bounds", () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }];
  const token = { document: { x: 25, y: 50, getGridSpacePolygon: () => points },
    bounds: { x: 0, y: 0, width: 1000, height: 1000 } };
  assert.equal(getTokenSelectionShape(token).points, points);
  assert.equal(isPointInTokenSelectionShape({ x: 75, y: 95 }, token), true);
  assert.equal(isPointInTokenSelectionShape({ x: 120, y: 145 }, token), false);
});
