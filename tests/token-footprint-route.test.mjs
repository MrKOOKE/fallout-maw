import assert from "node:assert/strict";
import test from "node:test";
import { prepareFootprintRoute, getFootprintTurnRotations } from "../src/utils/token-footprint-route.mjs";

globalThis.CONFIG = { Token: { movement: { actions: { walk: {}, teleport: { teleport: true } } } } };
const document = { rotation: 270, flags: { "fallout-maw": { movementAutoRotate: "on", tokenHitbox: { enabled: true } } },
  getCenterPoint: ({ x = 0, y = 0 }) => ({ x: x + 150, y: y + 250 }) };

test("future legs follow native headings and record rotation only at the corner without mutating the route", () => {
  const path = [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 600 }], before = structuredClone(path);
  const prepared = prepareFootprintRoute(document, path);
  assert.deepEqual(path, before);
  assert.deepEqual(prepared.map(point => point.rotation), [270, 0, 0]);
  assert.equal(prepared[1]._footprintTurnFrom, 270);
  assert.equal(prepared[1]._footprintTravelRotation, 270, "Incoming terrain cost keeps the incoming leg direction");
  assert.equal(prepared[2]._footprintTravelRotation, 0);
  assert.deepEqual(getFootprintTurnRotations(270, 0), [270, 285, 300, 315, 330, 345, 360]);
});

test("native intermediate grid steps keep the true diagonal segment direction", () => {
  const prepared = prepareFootprintRoute(document, [{ x: 0, y: 0 },
    { x: 100, y: 0, intermediate: true }, { x: 100, y: 100, intermediate: true }, { x: 200, y: 100 }]);
  const expected = Math.atan2(100, 200) * 180 / Math.PI + 270;
  assert.ok(prepared.every(point => Math.abs(point.rotation - expected) < 1e-6));
});

test("disabled auto-rotation, locked tokens and teleport preserve native orientation", () => {
  const path = [{ x: 0, y: 0 }, { x: 800, y: 0, action: "teleport" }];
  assert.equal(prepareFootprintRoute({ ...document, lockRotation: true }, path), path);
  assert.equal(prepareFootprintRoute({ ...document, flags: { "fallout-maw": { movementAutoRotate: "off", tokenHitbox: { enabled: true } } } }, path), path);
  assert.deepEqual(prepareFootprintRoute(document, path), path);
});

test("passed and pending legs retain their own headings while the current hull is turning", () => {
  const path = [{ x: 2000, y: 2000, stage: "passed" },
    { x: 1900, y: 2000, stage: "passed", intermediate: true },
    { x: 1200, y: 2000, stage: "passed" },
    { x: 1200, y: 1000, stage: "pending" },
    { x: 2200, y: 1000, stage: "pending" }];
  const before = structuredClone(path);
  const turning = prepareFootprintRoute({ ...document, rotation: 135 }, path);
  const finished = prepareFootprintRoute({ ...document, rotation: 270 }, path);
  assert.deepEqual(path, before);
  assert.deepEqual(turning, finished, "Completed highlights must not swivel with the current token angle");
  assert.deepEqual(turning.map(point => point.rotation), [90, 90, 180, 270, 270]);
  assert.equal(turning[0]._footprintTurnFrom, undefined, "Do not invent an initial angle for old history");
  assert.equal(turning[2]._footprintTurnFrom, 90);
  assert.equal(turning[3]._footprintTurnFrom, 180);
  assert.equal(turning[3]._footprintTravelRotation, 180);
});
