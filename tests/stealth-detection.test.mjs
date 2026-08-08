import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildObserverDetectionZone,
  buildWeaponNoiseZone,
  computeDetectionPathCost,
  doGridZonesOverlap,
  getStealthObserverZones,
  getStealthDetectionCacheStats,
  invalidateStealthDetectionCache,
  testStealthDetectionPoint,
  testWeaponNoiseZoneContact,
  weaponNoiseToRangeBonus
} from "../src/stealth/detection.mjs";
import { invalidateLightingAnalysisCache } from "../src/stealth/lighting.mjs";
import { invalidateSmokeRegionIndex } from "../src/canvas/smoke-vision.mjs";

const originalCanvas = globalThis.canvas;
const originalConfig = globalThis.CONFIG;
const originalGame = globalThis.game;
const originalPIXI = globalThis.PIXI;

afterEach(() => {
  invalidateStealthDetectionCache();
  invalidateLightingAnalysisCache();
  if (originalCanvas === undefined) delete globalThis.canvas;
  else globalThis.canvas = originalCanvas;
  if (originalConfig === undefined) delete globalThis.CONFIG;
  else globalThis.CONFIG = originalConfig;
  if (originalGame === undefined) delete globalThis.game;
  else globalThis.game = originalGame;
  if (originalPIXI === undefined) delete globalThis.PIXI;
  else globalThis.PIXI = originalPIXI;
});

test("gameplay detection samples the complete path while preview sampling is capped", () => {
  installRectangleMock();
  globalThis.canvas = createLinearCanvas({ cells: 33, cellSize: 100, darknessBand: [75, 125] });
  const observer = createObserver("observer-exact");
  const settings = createSettings("32");
  const origin = { x: 0, y: 0, elevation: 0 };
  const destination = { x: 3_200, y: 0, elevation: 0 };

  assert.equal(computeDetectionPathCost(observer, origin, destination, settings), 33);
  assert.equal(computeDetectionPathCost(observer, origin, destination, settings, { sampleLimit: 16 }), 32);
  assert.equal(
    computeDetectionPathCost(observer, origin, { x: 1_600, y: 0, elevation: 0 }, settings),
    computeDetectionPathCost(observer, origin, { x: 1_600, y: 0, elevation: 0 }, settings, { sampleLimit: 16 })
  );

  invalidateLightingAnalysisCache();
  invalidateStealthDetectionCache();
  assert.equal(testStealthDetectionPoint(observer, origin, destination, { settings }), false);

  const preview = buildObserverDetectionZone(observer, { origin, settings });
  assert.equal(preview.offsets.some(({ i, j }) => i === 0 && j === 32), true);
  assert.equal(preview.truncated, false);
});

test("preview construction and its LRU cache both obey cell budgets", () => {
  installRectangleMock();
  const initialStats = getStealthDetectionCacheStats();
  const cellsPerZone = initialStats.maxPreviewCells;
  globalThis.canvas = createLinearCanvas({ cells: cellsPerZone, cellSize: 1 });
  const settings = createSettings(String(cellsPerZone - 1));
  const observers = ["a", "b", "c", "d", "e"].map(createObserverWithUnlimitedSight);

  const zones = observers.slice(0, 4).map(observer => buildObserverDetectionZone(observer, { settings }));
  assert.equal(getStealthDetectionCacheStats().zoneCells, cellsPerZone * 4);
  assert.strictEqual(buildObserverDetectionZone(observers[0], { settings }), zones[0]);

  buildObserverDetectionZone(observers[4], { settings });
  const bounded = getStealthDetectionCacheStats();
  assert.equal(bounded.zones, 4);
  assert.equal(bounded.zoneCells, cellsPerZone * 4);
  assert.ok(bounded.zoneCells <= bounded.maxZoneCells);
  assert.notStrictEqual(buildObserverDetectionZone(observers[1], { settings }), zones[1]);

  invalidateStealthDetectionCache();
  assert.deepEqual(
    pickCacheUsage(getStealthDetectionCacheStats()),
    { zones: 0, points: 0, zoneCells: 0 }
  );

  const oversizedCells = bounded.maxPreviewCells * 3;
  globalThis.canvas = createLinearCanvas({ cells: oversizedCells, cellSize: 1 });
  const oversized = buildObserverDetectionZone(createObserverWithUnlimitedSight("oversized"), {
    settings: createSettings(String(oversizedCells - 1))
  });
  assert.equal(oversized.truncated, true);
  assert.ok(oversized.offsets.length <= bounded.maxPreviewCells);
});

test("weapon noise contact wrapper retains darkness, LOS, and blindness rules", () => {
  installRectangleMock();
  globalThis.CONFIG = {
    specialStatusEffects: { BLIND: "blind" }
  };
  globalThis.canvas = createLinearCanvas({
    cells: 7,
    cellSize: 100,
    darknessBand: [-1, 10_000]
  });
  const observer = createObserver("observer-noise-contact");
  const settings = createSettings("2");
  const observerOrigin = { x: 0, y: 0, elevation: 0 };
  const insideNoiseContact = { x: 200, y: 0, elevation: 0 };
  const outsideDarknessShapedContact = { x: 300, y: 0, elevation: 0 };
  assert.equal(
    testWeaponNoiseZoneContact(observer, observerOrigin, insideNoiseContact, {
      noiseLevel: 1,
      settings
    }),
    true
  );
  assert.equal(
    testWeaponNoiseZoneContact(observer, observerOrigin, outsideDarknessShapedContact, {
      noiseLevel: 1,
      settings
    }),
    false
  );

  observer.checkCollision = point => point.x >= insideNoiseContact.x;
  invalidateStealthDetectionCache();
  assert.equal(
    testStealthDetectionPoint(observer, observerOrigin, insideNoiseContact, {
      rangeBonus: weaponNoiseToRangeBonus(1),
      settings
    }),
    false
  );
  assert.equal(
    testWeaponNoiseZoneContact(observer, observerOrigin, insideNoiseContact, {
      noiseLevel: 1,
      settings
    }),
    true,
    "noise may reach a different visible cell instead of testing only the attacker's center ray"
  );

  observer.checkCollision = () => true;
  invalidateStealthDetectionCache();
  assert.equal(
    testWeaponNoiseZoneContact(observer, observerOrigin, insideNoiseContact, {
      noiseLevel: 1,
      settings
    }),
    false
  );

  observer.checkCollision = () => false;
  observer.actor.statuses = new Set(["blind"]);
  invalidateStealthDetectionCache();
  assert.equal(
    testWeaponNoiseZoneContact(observer, observerOrigin, insideNoiseContact, {
      noiseLevel: 1,
      settings
    }),
    false
  );
});

test("weapon noise builds one source-owned cell zone instead of expanding observers", () => {
  installRectangleMock();
  globalThis.canvas = createLinearCanvas({ cells: 9, cellSize: 100 });

  const quiet = buildWeaponNoiseZone({ x: 400, y: 0, elevation: 7 }, { noiseLevel: 0 });
  assert.deepEqual(quiet.offsets, [{ i: 0, j: 4 }]);
  assert.equal(quiet.origin.elevation, 7);

  const loud = buildWeaponNoiseZone({ x: 400, y: 0, elevation: 7 }, { noiseLevel: 2 });
  assert.deepEqual(loud.offsets.map(({ j }) => j), [2, 3, 4, 5, 6]);
  assert.deepEqual([...loud.offsetKeys], ["0:2", "0:3", "0:4", "0:5", "0:6"]);

  globalThis.canvas.grid.isGridless = true;
  assert.equal(
    buildWeaponNoiseZone({ x: 400, y: 0, elevation: 7 }, { noiseLevel: 2 }),
    null
  );
});

test("weapon noise starts from the token footprint and contact requires a shared cell", () => {
  installRectangleMock();
  globalThis.canvas = createLinearCanvas({ cells: 9, cellSize: 100 });
  const sourceToken = {
    document: {
      elevation: 0,
      getCenterPoint: () => ({ x: 350, y: 0, elevation: 0 }),
      getOccupiedGridSpaceOffsets: () => [
        { i: 0, j: 3, k: 0 },
        { i: 0, j: 4, k: 0 },
        { i: 0, j: 4, k: 1 }
      ]
    }
  };

  const quiet = buildWeaponNoiseZone(sourceToken, { noiseLevel: 0 });
  assert.deepEqual(quiet.offsets, [{ i: 0, j: 3 }, { i: 0, j: 4 }]);

  const loud = buildWeaponNoiseZone(sourceToken, { noiseLevel: 1 });
  assert.deepEqual(loud.offsets.map(({ j }) => j), [2, 3, 4, 5]);
  assert.equal(
    doGridZonesOverlap({ contactKeys: new Set(["0:1:0"]) }, loud),
    false,
    "adjacent boundaries alone must not add a free noise cell"
  );
  assert.equal(
    doGridZonesOverlap({ contactKeys: new Set(["0:2:0"]) }, loud),
    true
  );
});

test("weapon noise contact requires a shared Foundry elevation grid space", () => {
  installRectangleMock();
  globalThis.canvas = createLinearCanvas({ cells: 9, cellSize: 100, gridDistance: 1 });
  const grid = globalThis.canvas.grid;
  grid.getOffset = point => ({
    i: 0,
    j: Math.round((Number(point?.x) || 0) / grid.size),
    k: Math.floor(((Number(point?.elevation) || 0) / grid.distance) + 1e-8)
  });

  const observer = createObserverWithUnlimitedSight("observer-elevation");
  const settings = createSettings("0");
  const observerOrigin = { x: 400, y: 0, elevation: 0 };
  const createSourceAtLevel = k => ({
    document: {
      elevation: k * grid.distance,
      getCenterPoint: () => ({
        x: 400,
        y: 0,
        elevation: k * grid.distance
      }),
      getOccupiedGridSpaceOffsets: () => [{ i: 0, j: 4, k }]
    }
  });

  assert.equal(
    testWeaponNoiseZoneContact(observer, observerOrigin, createSourceAtLevel(0), {
      noiseLevel: 0,
      settings
    }),
    true
  );
  assert.equal(
    testWeaponNoiseZoneContact(observer, observerOrigin, createSourceAtLevel(1), {
      noiseLevel: 0,
      settings
    }),
    false
  );
});

test("truncated gridded previews never fall back to a hidden center-ray contact", () => {
  installRectangleMock();
  const maxPreviewCells = getStealthDetectionCacheStats().maxPreviewCells;
  const cells = maxPreviewCells * 3;
  globalThis.canvas = createLinearCanvas({ cells, cellSize: 1 });
  const observer = createObserverWithUnlimitedSight("observer-truncated-contact");
  const settings = createSettings(String(cells - 1));
  const observerOrigin = { x: 0, y: 0, elevation: 0 };
  const noiseOrigin = { x: cells - 1, y: 0, elevation: 0 };

  const observerZone = buildObserverDetectionZone(observer, {
    origin: observerOrigin,
    settings
  });
  assert.equal(observerZone.truncated, true);
  assert.equal(observerZone.offsets.some(({ j }) => j === cells - 1), false);
  assert.equal(
    testStealthDetectionPoint(observer, observerOrigin, noiseOrigin, { settings }),
    true,
    "the old center-ray check would have reacted outside the displayed zone"
  );
  assert.equal(
    testWeaponNoiseZoneContact(observer, observerOrigin, noiseOrigin, {
      noiseLevel: 0,
      settings
    }),
    false,
    "gridded gameplay must use the same retained shared cells as hover"
  );
});

test("authoritative point checks apply weapon noise on gridded and gridless scenes", () => {
  installRectangleMock();
  globalThis.canvas = createLinearCanvas({ cells: 7, cellSize: 100 });
  const observer = createObserverWithUnlimitedSight("observer-noise-point");
  const settings = createSettings("2");
  const origin = { x: 0, y: 0, elevation: 0 };
  const target = { x: 400, y: 0, elevation: 0 };

  assert.equal(testStealthDetectionPoint(observer, origin, target, { settings }), false);
  assert.equal(
    testWeaponNoiseZoneContact(observer, origin, target, { noiseLevel: 2, settings }),
    true
  );

  globalThis.canvas.grid.isGridless = true;
  invalidateStealthDetectionCache();
  assert.equal(testStealthDetectionPoint(observer, origin, target, { settings }), false);
  assert.equal(
    testWeaponNoiseZoneContact(observer, origin, target, { noiseLevel: 2, settings }),
    true
  );
});

test("blind observers and observers with zero sight modes have no zone even with weapon noise", () => {
  installRectangleMock();
  globalThis.CONFIG = {
    specialStatusEffects: { BLIND: "blind" },
    Canvas: {
      detectionModes: {
        basicSight: { type: 0 },
        lightPerception: { type: 0 },
        feelTremor: { type: 2 }
      }
    }
  };
  globalThis.canvas = createLinearCanvas({ cells: 7, cellSize: 100 });
  const settings = createSettings("10");
  const origin = { x: 0, y: 0, elevation: 0 };
  const target = { x: 100, y: 0, elevation: 0 };
  const zeroSight = createObserver("observer-zero-sight");
  zeroSight.document.detectionModes = {
    basicSight: { enabled: true, range: 0 },
    lightPerception: { enabled: true, range: 0 },
    feelTremor: { enabled: false, range: null }
  };
  assert.equal(buildObserverDetectionZone(zeroSight, { settings }), null);
  assert.equal(
    testWeaponNoiseZoneContact(zeroSight, origin, target, { noiseLevel: 100, settings }),
    false
  );

  const blind = createObserverWithUnlimitedSight("observer-blind");
  blind.actor.statuses = new Set(["blind"]);
  assert.equal(buildObserverDetectionZone(blind, { settings }), null);
  assert.equal(
    testWeaponNoiseZoneContact(blind, origin, target, { noiseLevel: 100, settings }),
    false
  );
});

test("positive Light Perception keeps a zero-range Basic Sight observer operational", () => {
  installRectangleMock();
  globalThis.CONFIG = {
    specialStatusEffects: { BLIND: "blind" },
    Canvas: {
      detectionModes: {
        basicSight: { type: 0 },
        lightPerception: { type: 0 }
      }
    }
  };
  globalThis.canvas = createLinearCanvas({ cells: 4, cellSize: 100 });
  const observer = createObserver("observer-light-perception");
  observer.document.detectionModes.lightPerception = { enabled: true, range: 10 };
  const settings = createSettings("2");

  assert.ok(buildObserverDetectionZone(observer, { settings })?.offsets?.length);
});

test("smoke density shapes stealth detection reciprocally from inside and outside", () => {
  installRectangleMock();
  globalThis.canvas = createLinearCanvas({ cells: 4, cellSize: 100, gridDistance: 1 });
  const smoke = createSmokeRegion("stealth-smoke", 50, {
    x: 0,
    y: 0,
    radius: 100,
    bounds: { x: -100, y: -100, width: 200, height: 200 }
  });
  globalThis.canvas.scene.regions = { contents: [smoke] };
  const observer = createObserver("observer-smoke");
  observer.document.sight.range = 2;
  observer.document.detectionModes.basicSight.range = 2;
  const settings = createSettings("2");
  const inside = { x: 0, y: 0, elevation: 0 };
  const outside = { x: 200, y: 0, elevation: 0 };

  assert.equal(computeDetectionPathCost(observer, inside, outside, settings), 3);
  assert.equal(computeDetectionPathCost(observer, outside, inside, settings), 3);
  assert.equal(testStealthDetectionPoint(observer, inside, outside, { settings }), false);
  assert.equal(testStealthDetectionPoint(observer, outside, inside, { settings }), false);

  const zone = buildObserverDetectionZone(observer, { origin: inside, settings });
  assert.equal(zone.offsets.some(({ j }) => j === 1), true);
  assert.equal(zone.offsets.some(({ j }) => j === 2), false);

  smoke.behaviors.contents[0].system.regionSpecialProperties[0].smoke.densityPercent = "100";
  invalidateSmokeRegionIndex(globalThis.canvas.scene);
  const opaqueZone = buildObserverDetectionZone(observer, { origin: inside, settings });
  assert.notStrictEqual(opaqueZone, zone);
  assert.equal(opaqueZone.offsets.some(({ j }) => j === 1), false);
});

test("weapon noise adds exact unattenuated distance beyond a darkness-shaped base zone", () => {
  installRectangleMock();
  globalThis.canvas = createLinearCanvas({
    cells: 8,
    cellSize: 100,
    gridDistance: 1,
    darknessBand: [-1, 10_000]
  });
  const observer = createObserver("observer-dark-noise");
  const settings = Object.freeze({
    detection: Object.freeze({ skillKey: "naturalist", rangeFormula: "0" }),
    attenuationLevels: Object.freeze([
      Object.freeze({ threshold: 0, penaltyPercent: 80 })
    ])
  });
  globalThis.canvas.grid.isGridless = true;
  invalidateStealthDetectionCache();
  const origin = { x: 0, y: 0, elevation: 0 };
  assert.equal(
    testWeaponNoiseZoneContact(
      observer,
      origin,
      { x: 500, y: 0 },
      { noiseLevel: 5, settings }
    ),
    true
  );
  assert.equal(
    testWeaponNoiseZoneContact(
      observer,
      origin,
      { x: 501, y: 0 },
      { noiseLevel: 5, settings }
    ),
    false
  );
});

test("weapon noise converts integer cells independently of grid units and size", () => {
  globalThis.canvas = {
    scene: { grid: { distance: 2 } },
    grid: { distance: 9, size: 140 }
  };
  assert.equal(weaponNoiseToRangeBonus(5), 10);
  assert.equal(weaponNoiseToRangeBonus(5.9), 10);
  assert.equal(weaponNoiseToRangeBonus(-3), 0);
  assert.equal(weaponNoiseToRangeBonus("invalid"), 0);

  globalThis.canvas = {
    scene: { grid: { distance: 7 } },
    grid: { distance: 1, size: 60, isGridless: true }
  };
  assert.equal(weaponNoiseToRangeBonus(5), 35);
});

test("one noise level reaches every adjacent hex but not the second ring", () => {
  installRectangleMock();
  globalThis.canvas = createHexCanvas({ cellSize: 100, gridDistance: 3 });
  const observer = createObserver("observer-hex-noise");
  const settings = createSettings("0");

  const origin = { x: 0, y: 0, elevation: 0 };
  for (const point of globalThis.canvas.hexCenters.slice(1, 7)) {
    assert.equal(
      testWeaponNoiseZoneContact(observer, origin, point, { noiseLevel: 1, settings }),
      true
    );
  }
  assert.equal(
    testWeaponNoiseZoneContact(
      observer,
      origin,
      globalThis.canvas.hexCenters[7],
      { noiseLevel: 1, settings }
    ),
    false
  );
});

test("local previews exclude hidden observers for players but retain them for GMs", () => {
  installRectangleMock();
  globalThis.canvas = createLinearCanvas({ cells: 4, cellSize: 100 });
  globalThis.canvas.visibility = { tokenVision: false };
  globalThis.game = { user: { isGM: false } };

  const hiddenToken = {
    id: "hidden-source",
    actor: createActor("Actor.hidden-source")
  };
  const visibleObserver = createObserverWithUnlimitedSight("visible-observer");
  visibleObserver.actor = createActor("Actor.visible-observer");
  visibleObserver.document.uuid = "Scene.scene.Token.visible-observer";
  visibleObserver.visible = true;
  visibleObserver.renderable = true;
  const hiddenObserver = createObserverWithUnlimitedSight("gm-hidden-observer");
  hiddenObserver.actor = createActor("Actor.gm-hidden-observer");
  hiddenObserver.document.uuid = "Scene.scene.Token.gm-hidden-observer";
  hiddenObserver.document.hidden = true;
  hiddenObserver.visible = true;
  hiddenObserver.renderable = true;
  globalThis.canvas.tokens = {
    placeables: [hiddenToken, visibleObserver, hiddenObserver]
  };
  const settings = createSettings("1");

  assert.deepEqual(
    getStealthObserverZones(hiddenToken, { visibleOnly: true, settings })
      .map(zone => zone.observerToken.id),
    ["visible-observer"]
  );

  globalThis.game.user.isGM = true;
  assert.deepEqual(
    getStealthObserverZones(hiddenToken, { visibleOnly: true, settings })
      .map(zone => zone.observerToken.id),
    ["visible-observer", "gm-hidden-observer"]
  );
});

function createLinearCanvas({ cells, cellSize, gridDistance = 1, darknessBand = null }) {
  const scene = { id: `scene-${cells}-${cellSize}-${gridDistance}`, grid: { distance: gridDistance } };
  const grid = {
    distance: gridDistance,
    isGridless: false,
    size: cellSize,
    getCenterPoint: ({ j }) => ({ x: j * cellSize, y: 0, elevation: 0 }),
    getOffset: point => ({ i: 0, j: Math.round((Number(point?.x) || 0) / cellSize) }),
    getOffsetRange: () => [0, 0, 1, cells]
  };
  return {
    ready: true,
    scene,
    grid,
    dimensions: { rect: { x: 0, y: 0, width: cells * cellSize, height: cellSize } },
    environment: { darknessLevel: 0, globalLightSource: { active: false } },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: point => darknessBand
        && point.x >= darknessBand[0]
        && point.x <= darknessBand[1] ? 1 : 0,
      testInsideDarkness: () => false
    }
  };
}

function createHexCanvas({ cellSize, gridDistance }) {
  const height = cellSize * (Math.sqrt(3) / 2);
  const hexCenters = [
    { x: 0, y: 0, elevation: 0 },
    { x: cellSize, y: 0, elevation: 0 },
    { x: cellSize / 2, y: height, elevation: 0 },
    { x: -cellSize / 2, y: height, elevation: 0 },
    { x: -cellSize, y: 0, elevation: 0 },
    { x: -cellSize / 2, y: -height, elevation: 0 },
    { x: cellSize / 2, y: -height, elevation: 0 },
    { x: cellSize * 2, y: 0, elevation: 0 }
  ];
  const grid = {
    distance: gridDistance,
    isGridless: false,
    size: cellSize,
    getCenterPoint: ({ j }) => hexCenters[j],
    getOffset: point => {
      let nearest = 0;
      let nearestDistance = Infinity;
      for (let index = 0; index < hexCenters.length; index += 1) {
        const center = hexCenters[index];
        const distance = Math.hypot(point.x - center.x, point.y - center.y);
        if (distance >= nearestDistance) continue;
        nearest = index;
        nearestDistance = distance;
      }
      return { i: 0, j: nearest };
    },
    getOffsetRange: () => [0, 0, 1, hexCenters.length]
  };
  return {
    ready: true,
    hexCenters,
    scene: {
      id: `scene-hex-${cellSize}-${gridDistance}`,
      grid: { distance: gridDistance }
    },
    grid,
    dimensions: {
      rect: {
        x: -cellSize * 3,
        y: -cellSize * 3,
        width: cellSize * 6,
        height: cellSize * 6
      }
    },
    environment: { darknessLevel: 0, globalLightSource: { active: false } },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: () => 0,
      testInsideDarkness: () => false
    }
  };
}

function createActor(uuid) {
  return {
    uuid,
    system: { skills: { naturalist: { value: 0 } } },
    getFlag: () => undefined
  };
}

function createObserver(id) {
  return {
    id,
    actor: { system: { skills: { naturalist: { value: 0 } } } },
    hasSight: true,
    checkCollision: () => false,
    document: {
      elevation: 0,
      sight: { enabled: true, range: 0 },
      detectionModes: {
        basicSight: { enabled: true, range: 0 },
        lightPerception: { enabled: true, range: null }
      }
    }
  };
}

function createObserverWithUnlimitedSight(id) {
  const observer = createObserver(id);
  observer.document.sight.range = null;
  observer.document.detectionModes.basicSight.range = null;
  return observer;
}

function createSettings(rangeFormula) {
  return Object.freeze({
    detection: Object.freeze({ skillKey: "naturalist", rangeFormula }),
    attenuationLevels: Object.freeze([
      Object.freeze({ threshold: 0.5, penaltyPercent: 50 }),
      Object.freeze({ threshold: 0, penaltyPercent: 0 })
    ])
  });
}

function createSmokeRegion(id, densityPercent, { x, y, radius, bounds }) {
  const region = {
    id,
    hidden: false,
    elevation: { bottom: null, top: null },
    shapes: [{ type: "circle", x, y, radius }],
    object: { bounds },
    segmentizeMovementPath: ([from, to]) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const fx = from.x - x;
      const fy = from.y - y;
      const a = (dx * dx) + (dy * dy);
      const b = 2 * ((fx * dx) + (fy * dy));
      const c = (fx * fx) + (fy * fy) - (radius * radius);
      const discriminant = (b * b) - (4 * a * c);
      if (!a || discriminant <= 0) return [];
      const root = Math.sqrt(discriminant);
      const start = Math.max(0, (-b - root) / (2 * a));
      const end = Math.min(1, (-b + root) / (2 * a));
      if (end <= start) return [];
      const pointAt = t => ({
        x: from.x + (dx * t),
        y: from.y + (dy * t),
        elevation: from.elevation ?? 0
      });
      return [{ from: pointAt(start), to: pointAt(end) }];
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

function installRectangleMock() {
  globalThis.PIXI = {
    Rectangle: class Rectangle {
      constructor(x, y, width, height) {
        Object.assign(this, { x, y, width, height });
      }

      fit() {
        return this;
      }
    }
  };
}

function pickCacheUsage(stats) {
  return { zones: stats.zones, points: stats.points, zoneCells: stats.zoneCells };
}
