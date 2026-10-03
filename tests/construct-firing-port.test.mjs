import test from "node:test";
import assert from "node:assert/strict";
import { isConstructFiringPortPointInSector, constrainConstructFiringPortRangeProfile, constrainConstructFiringPortAimPoint }
  from "../src/utils/construct-firing-port-model.mjs";

test("window cone follows the anchor's world rotation and rejects the old side after turning", () => {
  const rightWindow = { origin: { x: 996, y: 1004 }, rotation: 90, minRotation: -55, maxRotation: 55 };
  assert.equal(isConstructFiringPortPointInSector(rightWindow, { x: 1446, y: 1004 }), true);
  assert.equal(isConstructFiringPortPointInSector(rightWindow, { x: 996, y: 450 }), false);
  const turnedWindow = { ...rightWindow, origin: { x: 746, y: 946 }, rotation: 180 };
  assert.equal(isConstructFiringPortPointInSector(turnedWindow, { x: 746, y: 1446 }), true);
  assert.equal(isConstructFiringPortPointInSector(turnedWindow, { x: 1246, y: 946 }), false);
  assert.equal(isConstructFiringPortPointInSector(turnedWindow, turnedWindow.origin), false);
});

test("seat range can only shorten a weapon range, including an otherwise unlimited weapon", () => {
  const weapon = { maxRangeUnlimited: false, maxRangeMeters: 40 };
  assert.equal(constrainConstructFiringPortRangeProfile(weapon, { maxRangeMeters: null }), weapon);
  assert.equal(constrainConstructFiringPortRangeProfile(weapon, { maxRangeMeters: 10 }).maxRangeMeters, 10);
  assert.equal(constrainConstructFiringPortRangeProfile(weapon, { maxRangeMeters: 80 }).maxRangeMeters, 40);
  assert.deepEqual(constrainConstructFiringPortRangeProfile({ maxRangeUnlimited: true, maxRangeMeters: 0 },
    { maxRangeMeters: 12 }), { maxRangeUnlimited: false, maxRangeMeters: 12 });
});

test("cursor beyond a window stops the mechanical ray at the boundary and preserves aiming distance", () => {
  const port = { origin: { x: 996, y: 1004 }, rotation: 90, minRotation: -55, maxRotation: 55 };
  const cursor = { x: 996, y: 450 };
  const aim = constrainConstructFiringPortAimPoint(port, cursor);
  assert.ok(Math.abs(Math.atan2(aim.y - port.origin.y, aim.x - port.origin.x) * 180 / Math.PI + 55) < .000001);
  assert.equal(isConstructFiringPortPointInSector(port, aim), true);
  assert.ok(Math.abs(Math.hypot(aim.x - port.origin.x, aim.y - port.origin.y) - 554) < .000001);
  const inside = { x: 1446, y: 1004 };
  assert.equal(constrainConstructFiringPortAimPoint(port, inside), inside);
  assert.equal(constrainConstructFiringPortAimPoint(port, port.origin), null);
});
