import assert from "node:assert/strict";
import test from "node:test";
import { applyTokenMovementAutoRotateOverride, getTokenRotationSpeedMultiplier } from "../src/utils/token-movement-auto-rotate.mjs";

const document = value => ({ id: "token", flags: { "fallout-maw": { movementAutoRotate: value } } });

test("rotation speed multiplier defaults to native and rejects invalid rates", () => {
  const doc = document("on");
  assert.equal(getTokenRotationSpeedMultiplier(doc), 1);
  doc.flags["fallout-maw"].rotationSpeedMultiplier = 1 / 3;
  assert.equal(getTokenRotationSpeedMultiplier(doc), 1 / 3);
  for (const value of [0, -1, "bad", Infinity]) {
    doc.flags["fallout-maw"].rotationSpeedMultiplier = value;
    assert.equal(getTokenRotationSpeedMultiplier(doc), 1);
  }
});

test("per-token rotation overrides keyboard and drag while retaining native route and constraints", () => {
  const route = [{ x: 100, y: 200 }];
  const keyboard = { movement: { token: { method: "keyboard", autoRotate: false, waypoints: route } } };
  applyTokenMovementAutoRotateOverride(document("on"), keyboard);
  assert.equal(keyboard.movement.token.autoRotate, true);
  assert.equal(keyboard.movement.token.waypoints, route);
  const drag = { method: "dragging", movement: { token: { waypoints: route, constrainOptions: { ignoreWalls: false } } } };
  applyTokenMovementAutoRotateOverride(document("off"), drag);
  assert.equal(drag.movement.token.autoRotate, false);
  assert.equal(drag.movement.token.constrainOptions.ignoreWalls, false);
});

test("inherit, API, manual rotation, paste and undo leave explicit core behavior intact", () => {
  for (const [value, options] of [["inherit", { movement: { token: { method: "keyboard", autoRotate: false } } }],
    ["on", { movement: { token: { method: "api", autoRotate: false } } }],
    ["off", { movement: { token: { method: "api", autoRotate: true } } }],
    ["on", {}], ["on", { isUndo: true, method: "keyboard" }], ["on", { isPaste: true, method: "dragging" }]]) {
    const before = structuredClone(options);
    applyTokenMovementAutoRotateOverride(document(value), options);
    assert.deepEqual(options, before);
  }
});
