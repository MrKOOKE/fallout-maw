import test from "node:test";
import assert from "node:assert/strict";
import { isTokenMovementTravel } from "../src/utils/token-movement-kind.mjs";

const origin = { x: 100, y: 200, elevation: 0, level: "ground", width: 3, height: 5, depth: 2, shape: 1 };

test("native resize, shape, depth and rotation updates are not translation and do not spend travel resources", () => {
  for (const change of [{ width: 5, height: 7 }, { shape: 2 }, { depth: 3 }, { rotation: 90 }]) {
    const destination = { ...origin, ...change };
    assert.equal(isTokenMovementTravel({ origin, destination, passed: { waypoints: [origin, destination] } }), false);
  }
});

test("travel stays gated when combined with resizing or when a path returns to its origin", () => {
  const moved = { ...origin, x: 200, width: 5 };
  assert.equal(isTokenMovementTravel({ origin, destination: moved }), true);
  assert.equal(isTokenMovementTravel({ origin, destination: origin, passed: { waypoints: [origin, moved, origin] } }), true);
  assert.equal(isTokenMovementTravel({ origin, destination: { ...origin, elevation: 1 } }), true);
});
