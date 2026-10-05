import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as cone from "../src/utils/attack-cone-geometry.mjs";
import { isPointForwardOfAttackOrigin } from "../src/utils/attack-origin-geometry.mjs";
import { getConstructVisualConfig, normalizeConstructVisualRotation, resolveConstructVisualAnchors, resolveConstructVisualLayers } from "../src/utils/construct-visual-model.mjs";

const radians = degrees => degrees * Math.PI / 180;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);
const point = (angle, distance = 100) => ({ x: Math.cos(angle) * distance, y: Math.sin(angle) * distance, elevation: 1.4 });
const controllerSource = await readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8");
const visualSource = await readFile(new URL("../src/canvas/construct-visuals.mjs", import.meta.url), "utf8");

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing production function ${name}`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `Missing closing brace for ${name}`);
  return source.slice(start, end + 2);
}

function controllerFixture(overrides = {}) {
  const names = ["getAttackGeometry", "getCircularAttackGeometry", "getVolleyAttackGeometry", "buildConePoints",
    "buildClippedConePoints", "buildClippedCirclePoints", "serializeGeometry", "deserializeGeometry",
    "getAttackPolygonPoints", "getAttackGeometryCandidateBounds", "getPointCollectionBounds",
    "isPointInsideAttackCone", "getUnclippedAttackAreaPolygon", "buildRandomTrajectory", "buildRicochetCone",
    "findRicochetTrajectoryForTarget", "buildBurstDistributionShots", "getBurstTargetAxisProfile",
    "getBurstAxisSegment", "buildConeAnimationTrajectory", "getWallClippedEndpoint", "getPointElevationAtDistance"];
  const context = { ...cone, GEOMETRY_EPSILON: 1e-6, VOLLEY_ACTION_KEY: "volley",
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    getConstructWeaponAimPoint: (_token, _weapon, pointer) => pointer,
    getConstructWeaponAimOrigin: () => null, getConstructWeaponAimSector: () => null,
    isVolleyAttackAction: (_weapon, action) => action === "volley",
    getWeaponRangeProfile: () => ({ maxRangeUnlimited: false, maxRangeMeters: 100 }),
    getWeaponAttackRangeBonusMeters: () => 0, getSizeScaledActionMaxRangeMeters: () => 100,
    getActionAttackConeRadians: () => radians(60), getVolleyDamageRadius: () => 6,
    metersToPixels: value => value, toInteger: value => Math.trunc(Number(value)),
    serializePoint: value => structuredClone(value), deserializePoint: value => structuredClone(value),
    serializeTrajectory: value => structuredClone(value), deserializeTrajectory: value => structuredClone(value),
    serializeRicochetCone: () => null, deserializeRicochetCone: () => null,
    normalizeAngle: angle => ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI,
    isPointForwardOfAttackOrigin,
    getBurstSampleCount: () => 17, getRandomBurstMissGeometry: (_token, geometry) => geometry,
    getEvenBurstSampleOffset: (index, count) => -1 + 2 * index / (count - 1),
    buildTrajectoryByAngle: (_token, geometry, angle) => ({ angle, origin: geometry.origin }),
    buildRicochetTrajectory: (_token, geometry, angle) => ({ angle, origin: geometry.origin }),
    buildRicochetRayStrip: () => [], getTrajectoryTargetEntries: () => [],
    getTokenWorldPolygon: token => token,
    getPolygonPointObjects: token => [token.point, { x: 10, y: 10 }, { x: 20, y: 10 }],
    getSegmentPolygonIntersectionRange: () => null,
    getClosestBurstAxisPolygonPoint: (_axis, points) => ({ tokenPoint: points[0], axisPoint: { x: points[0].x, y: 0 }, distance: Math.abs(points[0].y) }),
    getProjectedDistanceOnSegment: (_origin, _end, point) => point.x,
    withTokenAimElevation: (_token, point) => point,
    clamp: (value, low, high) => Math.min(high, Math.max(low, value)),
    PIXI: { Polygon: class { constructor(points) { this.points = points; } } }, ...overrides };
  return vm.runInNewContext(`${names.map(name => functionSource(controllerSource, name)).join("\n")}\n({${names.join(",")}})`, context);
}

test("each physical stop preserves the free half of a 60 degree weapon cone", () => {
  const sector = { rotation: -10, minRotation: -45, maxRotation: 45 };
  const leftStop = cone.clipAttackConeToSector({ angle: radians(-55 - 90), halfAngle: radians(30) }, sector);
  near(leftStop.angle, radians(-145));
  near(leftStop.leftHalfAngle, 0);
  near(leftStop.rightHalfAngle, radians(30));
  near(leftStop.width, radians(30));
  const rightStop = cone.clipAttackConeToSector({ angle: radians(35 - 90), halfAngle: radians(30) }, sector);
  near(rightStop.leftHalfAngle, radians(30));
  near(rightStop.rightHalfAngle, 0);
  near(rightStop.width, radians(30));
});

test("approaching a stop clips only its side, and a narrower physical opening takes priority", () => {
  const nearStop = cone.clipAttackConeToSector({ angle: radians(35 - 90), halfAngle: radians(30) },
    { rotation: 0, minRotation: -45, maxRotation: 45 });
  near(nearStop.leftHalfAngle, radians(30));
  near(nearStop.rightHalfAngle, radians(10));
  const narrow = cone.clipAttackConeToSector({ angle: -Math.PI / 2, halfAngle: radians(30) },
    { rotation: 0, minRotation: -10, maxRotation: 10 });
  near(narrow.width, radians(20));
  near(narrow.leftHalfAngle, radians(10));
  near(narrow.rightHalfAngle, radians(10));
});

test("an outside cursor clamps the axis and clipping survives world angle wrapping", () => {
  const geometry = cone.clipAttackConeToSector({ angle: radians(175 + 70 - 90), halfAngle: radians(30) },
    { rotation: 175, minRotation: -45, maxRotation: 45 });
  near(geometry.angle, radians(130));
  near(geometry.leftHalfAngle, radians(30));
  near(geometry.rightHalfAngle, 0);
  const wrappedStop = cone.clipAttackConeToSector({ angle: Math.PI / 2, halfAngle: radians(30) },
    { rotation: 0, minRotation: 150, maxRotation: 180 });
  near(wrappedStop.leftHalfAngle, radians(30));
  near(wrappedStop.rightHalfAngle, 0);
});

test("legacy symmetric cones, rays, full circles and explicit zero sides remain distinct", () => {
  near(cone.getAttackConeAngles({ halfAngle: radians(30) }).width, radians(60));
  near(cone.getAttackConeAngles({ halfAngle: radians(30), leftHalfAngle: 0 }).width, radians(30));
  assert.equal(cone.getAttackConeAngles({ halfAngle: 0 }).width, 0);
  const circle = cone.clipAttackConeToSector({ angle: 0, halfAngle: Math.PI },
    { rotation: 80, minRotation: -180, maxRotation: 180 });
  near(circle.width, Math.PI * 2);
  assert.equal(cone.isAttackConeOffsetAllowed(Math.PI, { leftHalfAngle: 0, rightHalfAngle: Math.PI }), true);
});

test("production polygons, candidate bounds, membership and socket roundtrip retain a one-sided cone", () => {
  const api = controllerFixture({ getConstructWeaponAimSector: () => ({ rotation: 90, minRotation: 0, maxRotation: 90 }) });
  const geometry = api.getAttackGeometry({}, "burst", {}, { x: 0, y: 0, elevation: 1.4 }, point(0));
  near(geometry.leftHalfAngle, 0);
  near(geometry.rightHalfAngle, radians(30));
  assert.ok(geometry.shapePoints.every(point => point.y >= -1e-8));
  assert.equal(api.isPointInsideAttackCone(point(radians(-10), 30), geometry), false);
  assert.equal(api.isPointInsideAttackCone(point(radians(10), 30), geometry), true);
  assert.equal(api.isPointInsideAttackCone(point(radians(31), 30), geometry), false);
  const restored = api.deserializeGeometry(api.serializeGeometry(geometry));
  near(restored.leftHalfAngle, 0);
  near(restored.rightHalfAngle, radians(30));
  const bounds = api.getAttackGeometryCandidateBounds(restored);
  near(bounds.left, -1); near(bounds.top, -1); near(bounds.width, 102); near(bounds.height, 52);
  const unclipped = api.getUnclippedAttackAreaPolygon(restored);
  assert.ok(unclipped.points.filter((_value, index) => index % 2).every(y => y >= -1e-8));
  const fallback = api.deserializeGeometry(api.serializeGeometry({ ...geometry, leftHalfAngle: undefined, rightHalfAngle: undefined }));
  near(fallback.leftHalfAngle, radians(30)); near(fallback.rightHalfAngle, radians(30));
});

test("random, burst and ricochet rays cannot enter the clipped half", () => {
  const sampled = [];
  const api = controllerFixture({ getTrajectoryTargetEntries: (_token, trajectory) => { sampled.push(trajectory.angle); return []; } });
  const geometry = { origin: { x: 0, y: 0 }, angle: 0, distance: 100,
    halfAngle: radians(30), leftHalfAngle: 0, rightHalfAngle: radians(30), ricochet: { maxReflections: 1 } };
  near(api.buildRandomTrajectory({}, geometry).angle, radians(15));
  const shots = api.buildBurstDistributionShots({}, geometry, 6);
  near(shots[0].trajectory.angle, 0); near(shots.at(-1).trajectory.angle, radians(30));
  const ricochet = api.buildRicochetCone({}, geometry);
  near(ricochet.rays[0].angle, 0); near(ricochet.rays.at(-1).angle, radians(30));
  api.findRicochetTrajectoryForTarget({}, {}, geometry);
  assert.ok([...sampled, ...ricochet.rays.map(ray => ray.angle)].every(angle => angle >= -1e-8 && angle <= radians(30) + 1e-8));
});

test("burst axis weighting grants no bonus to a target entirely on the clipped side", () => {
  const api = controllerFixture();
  const geometry = { origin: { x: 0, y: 0 }, angle: 0, distance: 100,
    halfAngle: radians(30), leftHalfAngle: 0, rightHalfAngle: radians(30) };
  assert.equal(api.getBurstTargetAxisProfile({ point: { x: 10, y: -2 } }, geometry, 17), null);
  assert.ok(api.getBurstTargetAxisProfile({ point: { x: 10, y: 2 } }, geometry, 17).weight > 0);
  const animation = api.buildConeAnimationTrajectory(geometry);
  near(animation.angle, radians(15)); near(animation.halfAngle, radians(15));
  near(Math.atan2(animation.end.y, animation.end.x), radians(15));
});

test("ordinary circular attacks and volley impact circles retain their native geometry", () => {
  const api = controllerFixture();
  const origin = { x: 0, y: 0, elevation: 1.4 };
  const circle = api.getCircularAttackGeometry({}, "circular", {}, origin);
  assert.equal(circle.shapePoints.length, 48);
  near(cone.getAttackConeAngles(api.deserializeGeometry(api.serializeGeometry(circle))).width, Math.PI * 2);
  const volley = api.getAttackGeometry({}, "volley", {}, origin, { x: 30, y: 40 });
  assert.equal(volley.type, "volley"); assert.equal(volley.halfAngle, 0);
  near(volley.distance, 50); near(volley.radiusPixels, 6);
  const volleyBounds = api.getAttackGeometryCandidateBounds(volley);
  near(volleyBounds.left, 23); near(volleyBounds.top, 33); near(volleyBounds.width, 14); near(volleyBounds.height, 14);
  near(volley.end.elevation, 1.4);
});

test("mounted sector follows the actual rotated parent anchor and live token body angle", () => {
  const config = { enabled: true, anchors: [
    { id: "pivot", x: 0.5, y: 0.5 }, { id: "mount", parentSlotId: "turret", x: 0, y: -0.2, rotation: 10 }
  ], parts: [
    { slotId: "turret", anchorId: "pivot", img: "turret.webp", rotates: true },
    { slotId: "gun", anchorId: "mount", img: "gun.webp", rotates: true, minRotation: -15, maxRotation: 35 }
  ] };
  const token = { actor: config, w: 200, h: 400, center: { x: 100, y: 200 },
    mesh: { position: { x: 100, y: 200 }, angle: 25 }, document: { rotation: 20, texture: {} } };
  const names = ["getConstructWeaponAimSector", "visualOptions", "tokenVisualScale", "tokenFrame", "mirrorConstructRotation"];
  const getSector = vm.runInNewContext(`${names.map(name => functionSource(visualSource, name)).join("\n")}\ngetConstructWeaponAimSector`, {
    getConstructVisualConfig, normalizeConstructVisualRotation, resolveConstructVisualAnchors, resolveConstructVisualLayers,
    isConstructPersonalWeapon: () => false, getConstructWeaponControlSlot: () => "gun",
    getConstructPartRotations: () => ({ turret: 70, gun: 100 })
  });
  const sector = getSector(token, {});
  near(sector.rotation, 105); assert.equal(sector.minRotation, -15); assert.equal(sector.maxRotation, 35);
  const geometry = cone.clipAttackConeToSector({ angle: radians(125 - 90), halfAngle: radians(30) }, sector);
  near(geometry.leftHalfAngle, radians(30)); near(geometry.rightHalfAngle, radians(15));
  token.document.lockRotation = true;
  near(getSector(token, {}).rotation, 80);
});

test("native wall clipping preserves scene-edge zero coordinates and uses the actual hit distance", () => {
  const api = controllerFixture();
  const origin = { x: 30, y: 40, elevation: 1.4 };
  const bothZero = api.getWallClippedEndpoint({ checkCollision: () => ({ x: 0, y: 0 }) }, origin, radians(200), 200);
  assert.deepEqual(structuredClone(bothZero.point), { x: 0, y: 0, elevation: 1.4 });
  near(bothZero.distance, 50);
  const zeroY = api.getWallClippedEndpoint({ checkCollision: () => ({ x: 30, y: 0 }) }, origin, -Math.PI / 2, 100, 0);
  near(zeroY.point.y, 0); near(zeroY.distance, 40); near(zeroY.point.elevation, 0.84);
  const explicitZeroHeight = api.getWallClippedEndpoint({ checkCollision: () => ({ x: 30, y: 0, elevation: 0 }) }, origin, -Math.PI / 2, 100);
  near(explicitZeroHeight.point.elevation, 0);
  const touching = api.getWallClippedEndpoint({ checkCollision: () => origin }, origin, 0, 100);
  near(touching.distance, 0);
});

test("an omitted target height keeps the native ray horizontal while an explicit zero remains valid", () => {
  const api = controllerFixture();
  const destinations = [];
  const token = { checkCollision: destination => { destinations.push(destination); return null; } };
  const origin = { x: 0, y: 0, elevation: 1.4 };
  near(api.getWallClippedEndpoint(token, origin, 0, 100).point.elevation, 1.4);
  near(api.getWallClippedEndpoint(token, origin, 0, 100, 0).point.elevation, 0);
  near(destinations[0].elevation, 1.4); near(destinations[1].elevation, 0);
});
