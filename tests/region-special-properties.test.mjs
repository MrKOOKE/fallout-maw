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
  measureSmokePath
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

test("single-circle smoke uses the analytic intersection interval", () => {
  const region = createSmokeRegion("circle", 50);
  region.shapes[0].radius = 2;
  region.object.bounds = { x: 3, y: -2, width: 4, height: 4 };
  const scene = createScene([region]);
  assert.equal(
    calculateSmokePathCost({ x: 0, y: 0, elevation: 0 }, { x: 10, y: 0, elevation: 0 }, { scene, elevation: 0 }),
    14
  );
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
    segmentizeMovementPath: () => {
      throw new Error("single-circle smoke must use the analytic path");
    },
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
  return region;
}
