import test from "node:test";
import assert from "node:assert/strict";
import { getAttackOriginDistanceMeters, getAttackTrajectoryAngleThroughPoint, isPointForwardOfAttackOrigin } from "../src/utils/attack-origin-geometry.mjs";

test("a long barrel measures target distance from its muzzle without a hull size allowance", () => {
  const hull = { x: 0, y: 0 }, muzzle = { x: 120, y: 0 }, target = { x: 180, y: 0 };
  assert.equal(getAttackOriginDistanceMeters(muzzle, target, { pixelsPerMeter: 10 }), 6);
  assert.equal(getAttackOriginDistanceMeters(hull, target, { pixelsPerMeter: 10, rangeBonusMeters: 3 }), 15);
});

test("a target between the hull and muzzle cannot turn an aimed trajectory backwards", () => {
  const geometry = { origin: { x: 120, y: 0 }, angle: 0, forwardOnly: true };
  const behind = { x: 60, y: 0 };
  assert.equal(isPointForwardOfAttackOrigin(behind, geometry), false);
  assert.equal(isPointForwardOfAttackOrigin({ x: 120, y: 20 }, geometry), false);
  assert.equal(isPointForwardOfAttackOrigin({ x: 180, y: 0 }, geometry), true);
  assert.equal(getAttackTrajectoryAngleThroughPoint(geometry, behind), 0);
});

test("the forward muzzle plane follows a rotated barrel instead of the hull position", () => {
  const geometry = { origin: { x: 100, y: -80 }, angle: -Math.PI / 2, forwardOnly: true };
  assert.equal(isPointForwardOfAttackOrigin({ x: 100, y: -40 }, geometry), false);
  assert.equal(isPointForwardOfAttackOrigin({ x: 100, y: -120 }, geometry), true);
  assert.equal(getAttackTrajectoryAngleThroughPoint(geometry, { x: 100, y: -40 }), -Math.PI / 2);
  assert.equal(getAttackTrajectoryAngleThroughPoint({ ...geometry, forwardOnly: false }, { x: 100, y: -40 }), Math.PI / 2);
});

test("invalid origins never become a zero-distance valid target", () => {
  assert.equal(getAttackOriginDistanceMeters(null, { x: 0, y: 0 }), Infinity);
  assert.equal(getAttackOriginDistanceMeters({ x: Number.NaN, y: 0 }, { x: 0, y: 0 }), Infinity);
});
