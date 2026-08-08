import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRegionSpecialProperties,
  resolveRegionSpecialProperties
} from "../src/utils/region-special-properties.mjs";
import {
  calculateSmokePathCost,
  invalidateSmokeRegionIndex
} from "../src/canvas/smoke-vision.mjs";

test("area special properties keep one normalized smoke row", () => {
  assert.deepEqual(normalizeRegionSpecialProperties([
    { type: "smoke", smoke: { thickness: "", densityPercent: "" } },
    { type: "smoke", smoke: { thickness: "0.2", densityPercent: "90" } }
  ]), [{
    type: "smoke",
    smoke: { thickness: "1", densityPercent: "50" }
  }]);
  assert.deepEqual(normalizeRegionSpecialProperties([{ type: "unknown" }]), []);
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

function createScene(regions) {
  return { regions: { contents: regions } };
}

function createSmokeRegion(id, densityPercent) {
  const region = {
    id,
    hidden: false,
    elevation: { bottom: null, top: null },
    object: { bounds: { x: 0, y: 0, width: 10, height: 10 } },
    segmentizeMovementPath: (waypoints) => [{
      from: waypoints[0],
      to: waypoints[1]
    }],
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
        getFlag: () => ({ activateAt: 0 })
      }]
    }
  };
  return region;
}
