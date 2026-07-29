import assert from "node:assert/strict";
import test from "node:test";

import { changedDataIntersectsPaths } from "../src/utils/document-change-paths.mjs";

const actorVisionPaths = [
  "statuses",
  "system.statuses",
  "system.conditions",
  "system.vision"
];

test("vision invalidation intersects exact changed leaves instead of the system root", () => {
  assert.equal(changedDataIntersectsPaths({
    system: {
      resources: {
        health: { value: 7 }
      }
    }
  }, actorVisionPaths), false);
  assert.equal(changedDataIntersectsPaths({
    "system.limbs.arm.value": 3
  }, actorVisionPaths), false);
  assert.equal(changedDataIntersectsPaths({
    system: {
      vision: {
        range: 12
      }
    }
  }, actorVisionPaths), true);
  assert.equal(changedDataIntersectsPaths({
    "system.conditions.blinded": true
  }, actorVisionPaths), true);
  assert.equal(changedDataIntersectsPaths({
    statuses: ["invisible"]
  }, actorVisionPaths), true);
});

test("path intersection preserves parent replacement and deletion updates", () => {
  assert.equal(changedDataIntersectsPaths({
    system: {}
  }, actorVisionPaths), true);
  assert.equal(changedDataIntersectsPaths({
    system: {
      "-=vision": null
    }
  }, actorVisionPaths), true);
  assert.equal(changedDataIntersectsPaths({
    texture: {
      src: "token.webp"
    }
  }, ["texture.scaleX", "texture.scaleY"]), false);
  assert.equal(changedDataIntersectsPaths({
    "texture.scaleX": 1.2
  }, ["texture.scaleX", "texture.scaleY"]), true);
});
