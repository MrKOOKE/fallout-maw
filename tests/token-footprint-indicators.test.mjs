import assert from "node:assert/strict";
import test from "node:test";
import { getTokenHitboxGeometry } from "../src/utils/token-hitbox.mjs";
import { getFootprintBarEdge, getFootprintBarPath, mapFootprintBarRect } from "../src/utils/token-footprint-indicators.mjs";

function geometry(rotation) {
  return getTokenHitboxGeometry({ rotation, getSize: () => ({ width: 300, height: 500 }),
    flags: { "fallout-maw": { tokenHitbox: { enabled: true } } } });
}
const inside = (polygon, point) => polygon.every((a, i) => {
  const b = polygon[(i + 1) % polygon.length];
  return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) >= -1e-6;
});

test("a stationary health strip occupies one complete lower edge, including diagonal orientations", () => {
  const zero = getFootprintBarPath(geometry(0), 0);
  assert.deepEqual(zero.points, [{ x: 0, y: 500 }, { x: 300, y: 500 }]);
  const turned = getFootprintBarPath(geometry(90), 90);
  assert.equal(turned.length, 500);
  for (const rotation of [1, 30, 45, 90, 135, 180, 225, 270, 315, 360]) {
    const g = geometry(rotation), path = getFootprintBarPath(g, rotation);
    assert.equal(path.points.length, 2);
    const edge = getFootprintBarEdge(g);
    assert.deepEqual(path.points, [g.points[(edge + 1) % 4], g.points[edge]]);
    assert.ok([300, 500].some(length => Math.abs(path.length - length) < 1e-6));
  }
  const diagonal = getFootprintBarPath(geometry(45), 45);
  assert.ok(Math.abs(diagonal.length - 500) < 1e-6, "Uses the full long lower edge, not half of each adjoining edge");
  assert.equal(getFootprintBarPath(geometry(45), 45, { edgePosition: 1.5 }).points.length, 3,
    "Only the temporary transfer may run around the corner");
});

test("native bar fills remain inside the rotating footprint throughout edge transfers", () => {
  for (const rotation of [0, 1, 30, 45, 89, 90, 135, 179, 180, 225, 270, 315, 359]) {
    const g = geometry(rotation);
    for (const upper of [false, true]) for (const edgePosition of [getFootprintBarEdge(g), getFootprintBarEdge(g) - 0.5]) {
      const path = getFootprintBarPath(g, rotation, { upper, edgePosition });
      const fill = mapFootprintBarRect(g, path, { x: 0, y: 0, width: 225, height: 12 }, { width: 300, height: 12 });
      assert.ok(fill.length >= 3);
      assert.ok(fill.every(point => inside(g.points, point)), `Bar at ${rotation} degrees`);
    }
  }
});

test("corner transfers have simple contours and bounded outline joins, including almost vanished legs", () => {
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (const rotation of [0, 31, 45, 90, 135, 270]) {
    const g = geometry(rotation);
    for (const upper of [false, true]) for (const edgePosition of [2, 1.99999999, 1.9999, 1.99, 1.5, 1.05, 1.0001, 1]) {
      const path = getFootprintBarPath(g, rotation, { upper, edgePosition });
      for (const percent of [0.001, 0.01, 0.5, 0.89, 1]) {
        const polygon = mapFootprintBarRect(g, path, { x: 0, y: 0, width: 300 * percent, height: 12 }, { width: 300, height: 12 });
        assert.ok(polygon.length >= 3);
        assert.ok(polygon.every(point => inside(g.points, point)));
        for (let i = 0; i < polygon.length; i++) {
          const a = polygon[(i + polygon.length - 1) % polygon.length], b = polygon[i], c = polygon[(i + 1) % polygon.length];
          const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y);
          assert.ok(ab > 1e-5 && bc > 1e-5, "No degenerate stroke segments");
          const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (ab * bc);
          assert.ok(1 / Math.sqrt((1 + dot) / 2) < 1.415, "Outline cannot generate a long miter spike");
          for (let j = i + 2; j < polygon.length; j++) {
            if (i === 0 && j === polygon.length - 1) continue;
            const d = polygon[j], e = polygon[(j + 1) % polygon.length];
            assert.ok(!(cross(b, c, d) * cross(b, c, e) < -1e-10 && cross(d, e, b) * cross(d, e, c) < -1e-10),
              "Native fill triangulation receives a simple polygon");
          }
        }
      }
    }
  }
});
