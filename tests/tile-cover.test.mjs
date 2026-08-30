import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  clearCoverContours,
  getCoverKeysIntersectingPolygon,
  getCoverSampleMasksIntersectingSegments,
  polygonsIntersect,
  removeCoverContour,
  replaceCoverContours,
  resolveCoverFromSampleMasks,
  upsertCoverContour
} from "../src/canvas/cover-contours.mjs";
import {
  TILE_SPECIAL_PROPERTIES_FLAG,
  TILE_SPECIAL_PROPERTY_COVER,
  createDefaultTileSpecialPropertyData,
  hydrateTileCoverContours,
  normalizeTileSpecialProperties,
  registerTileCoverContourHooks
} from "../src/canvas/tile-cover.mjs";
import {
  TILE_HITBOX_FLAG,
  applyTileHitboxHitArea,
  drawTileHitboxOnCanvas,
  getTileHitbox,
  getTileHitboxWorldPoints,
  normalizeTileHitbox,
  tileHitboxContainsCanvasPoint,
  worldPointsToTileHitbox
} from "../src/canvas/tile-hitbox.mjs";
import {
  clearTileHitboxOverlays,
  syncTileHitboxOverlay
} from "../src/canvas/tile-hitbox-overlay.mjs";

function polygon(points) {
  return { points: points.flatMap(point => [point.x, point.y]) };
}

function rectangle(left, top, right, bottom) {
  return polygon([
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom }
  ]);
}

function getCoverMaskKeys(...args) {
  return [...getCoverSampleMasksIntersectingSegments(...args).keys()];
}

function getCoverMask(scene, origin, destinations, coverKey, levelId = "") {
  return [...(getCoverSampleMasksIntersectingSegments(scene, origin, destinations, levelId).get(coverKey) ?? [])];
}

const FULL_TILE_HITBOX = {
  version: 1,
  points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
};

let nextTileId = 0;

function createTile({
  id = `tile-${++nextTileId}`,
  coverKey = "half",
  x = 0,
  y = 0,
  width = 100,
  height = 100,
  rotation = 0,
  anchorX = 0.5,
  anchorY = 0.5,
  levels = [],
  manualHitbox = null,
  rimworldHitbox = null
} = {}) {
  return {
    id,
    uuid: `Scene.test.Tile.${id}`,
    x,
    y,
    width,
    height,
    rotation,
    texture: { anchorX, anchorY },
    levels: new Set(levels),
    getFlag(scope, key) {
      if (scope === "fallout-maw" && key === TILE_SPECIAL_PROPERTIES_FLAG) {
        return coverKey ? [{ type: TILE_SPECIAL_PROPERTY_COVER, coverKey }] : [];
      }
      if (scope === "fallout-maw" && key === TILE_HITBOX_FLAG) return manualHitbox;
      if (scope === "rimworld-map-bridge" && key === "hitbox") return rimworldHitbox;
      return undefined;
    }
  };
}

function createScene(tiles = []) {
  const scene = { tiles: { contents: tiles } };
  for (const tile of tiles) tile.parent = scene;
  return scene;
}

function createHydratedScene(tiles = []) {
  const scene = createScene(tiles);
  hydrateTileCoverContours(scene);
  return scene;
}

test("Tile special-property rows normalize to one future-extensible cover row", () => {
  assert.deepEqual(createDefaultTileSpecialPropertyData(), {
    type: "pending",
    coverKey: ""
  });
  assert.deepEqual(normalizeTileSpecialProperties({
    0: { type: "pending" },
    1: { type: "cover", coverKey: " half " },
    2: { type: "cover", coverKey: "full" }
  }), [{
    type: "cover",
    coverKey: "half"
  }]);
  assert.deepEqual(normalizeTileSpecialProperties(null), []);
});

test("polygon overlap includes containment, crossed edges, rotation contact, and rejects separation", () => {
  const horizontal = rectangle(-4, -1, 4, 1);
  const vertical = rectangle(-1, -4, 1, 4);
  assert.equal(polygonsIntersect(horizontal, vertical), true, "crossed edges without contained vertices");
  assert.equal(polygonsIntersect(rectangle(-5, -5, 5, 5), rectangle(-1, -1, 1, 1)), true, "containment");
  assert.equal(polygonsIntersect(rectangle(0, 0, 1, 1), rectangle(1, 0, 2, 1)), true, "boundary contact");
  assert.equal(polygonsIntersect(rectangle(0, 0, 1, 1), rectangle(2, 2, 3, 3)), false, "separation");
});

test("Tile hitboxes normalize bounded simple polygons and prefer a manual outline over RimWorld", () => {
  const manual = {
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0, y: 0.5 }, { x: 0, y: 0 }]
  };
  const imported = {
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  };
  assert.deepEqual(normalizeTileHitbox(manual), {
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0, y: 0.5 }]
  });
  assert.equal(normalizeTileHitbox({
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }]
  }), null, "self-intersection is rejected");
  assert.equal(normalizeTileHitbox({ version: 2, points: imported.points }), null, "unknown versions are rejected");
  assert.deepEqual(getTileHitbox(createTile({ manualHitbox: manual, rimworldHitbox: imported })), {
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0, y: 0.5 }],
    source: "manual"
  });
  assert.equal(getTileHitbox(createTile({ rimworldHitbox: imported }))?.source, "rimworld");
});

test("Tile-local hitbox coordinates round-trip through anchor, size, and rotation", () => {
  const hitbox = {
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  };
  const tile = createTile({
    x: 100,
    y: 100,
    width: 40,
    height: 20,
    rotation: 90,
    anchorX: 0,
    anchorY: 1,
    manualHitbox: hitbox
  });
  const world = getTileHitboxWorldPoints(tile);
  assert.deepEqual(world.map(point => ({ x: Math.round(point.x), y: Math.round(point.y) })), [
    { x: 120, y: 100 },
    { x: 120, y: 140 },
    { x: 100, y: 140 },
    { x: 100, y: 100 }
  ]);
  assert.deepEqual(worldPointsToTileHitbox(tile, world), hitbox);
  assert.equal(tileHitboxContainsCanvasPoint(tile, { x: 110, y: 120 }), true);
  assert.equal(tileHitboxContainsCanvasPoint(tile, { x: 130, y: 120 }), false);
});

test("Foundry Tile selection uses the custom polygon and restores the core hit area when cleared", () => {
  let manualHitbox = {
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }]
  };
  const document = createTile({ x: 50, y: 50, manualHitbox });
  document.getFlag = function(scope, key) {
    if (scope === "fallout-maw" && key === TILE_HITBOX_FLAG) return manualHitbox;
    return undefined;
  };
  const placeable = {
    document,
    frame: { hitArea: { contains: () => "core" } }
  };
  applyTileHitboxHitArea(placeable);
  assert.equal(placeable.frame.hitArea.contains(10, 50), true);
  assert.equal(placeable.frame.hitArea.contains(90, 50), false);
  manualHitbox = null;
  applyTileHitboxHitArea(placeable);
  assert.equal(placeable.frame.hitArea.contains(90, 50), "core");
});

test("Tile hitboxes draw a non-interactive green diagnostic outline and clean it up", () => {
  const previousPIXI = globalThis.PIXI;
  class FakeGraphics {
    constructor() {
      this.lines = [];
      this.polygons = [];
      this.parent = null;
      this.destroyed = false;
      this.visible = true;
    }

    clear() {
      this.lines = [];
      this.polygons = [];
      return this;
    }

    lineStyle(...args) {
      this.lines.push(args);
      return this;
    }

    drawPolygon(points) {
      this.polygons.push(points);
      return this;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  globalThis.PIXI = { ...(previousPIXI ?? {}), Graphics: FakeGraphics };
  const document = createTile({
    x: 50,
    y: 50,
    manualHitbox: {
      version: 1,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
    }
  });
  const tile = {
    document,
    layer: { active: true },
    controlled: false,
    hover: true,
    isVisible: true,
    children: [],
    addChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter(entry => entry !== child);
      child.parent = null;
      return child;
    }
  };

  try {
    syncTileHitboxOverlay(tile);
    assert.equal(tile.children.length, 1);
    const overlay = tile.children[0];
    assert.equal(overlay.eventMode, "none");
    assert.equal(overlay.interactive, false);
    assert.ok(overlay.lines.some(([_width, color]) => color === 0x39ff88));
    assert.deepEqual(overlay.polygons.at(-1), [0, 0, 100, 0, 100, 100, 0, 100]);

    tile.hover = false;
    syncTileHitboxOverlay(tile, { redraw: false });
    assert.equal(overlay.visible, false);
    tile.controlled = true;
    syncTileHitboxOverlay(tile, { redraw: false });
    assert.equal(overlay.visible, true, "the selected Tile keeps its own hitbox visible");
    tile.controlled = false;
    tile.hover = true;
    syncTileHitboxOverlay(tile, { redraw: false });
    assert.equal(overlay.visible, true);

    clearTileHitboxOverlays();
    assert.equal(tile.children.length, 0);
    assert.equal(overlay.destroyed, true);
  } finally {
    clearTileHitboxOverlays();
    if (previousPIXI === undefined) delete globalThis.PIXI;
    else globalThis.PIXI = previousPIXI;
  }
});

test("the transient Region workflow collects vertices without creating a Scene document", async () => {
  const tile = createTile({ x: 50, y: 50, width: 100, height: 100 });
  const scene = { id: "scene" };
  tile.parent = scene;
  let placementOptions;
  let placementData;
  const shape = {
    points: [],
    updateSource(changes) {
      this.points = changes.points;
    }
  };
  const regionDocument = {
    shapes: [shape],
    updateSource(changes) {
      this.shapes = changes.shapes;
    },
    object: { renderFlags: { set() {} } }
  };
  const canvasObject = {
    ready: true,
    scene,
    level: { id: "ground" },
    stage: { scale: { x: 1 } },
    activeLayer: { active: true },
    regions: {
      async placeRegion(data, options) {
        placementData = data;
        placementOptions = options;
        const move = (x, y) => options.onMove({ position: { x, y }, shape });
        const click = (x, y, detail = 1) => options.preConfirm({
          event: { detail, getLocalPosition: () => ({ x, y }) },
          document: regionDocument,
          shape
        });
        move(0, 0);
        assert.equal(click(0, 0), false);
        move(100, 0);
        assert.equal(click(100, 0), false);
        move(100, 100);
        assert.equal(click(100, 100), false);
        move(0, 0);
        assert.equal(click(0, 0), true, "clicking the first vertex closes the polygon");
        return regionDocument;
      }
    }
  };

  const result = await drawTileHitboxOnCanvas(tile, {
    canvasObject,
    notifications: { info() {}, warn() {} },
    i18n: { localize: key => key }
  });
  assert.equal(placementOptions.create, false);
  assert.equal(placementOptions.allowRotation, false);
  assert.equal(placementData.shapes[0].type, "polygon");
  assert.deepEqual(result, {
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]
  });
});

test("rotated green contours grant cover only to crossed aim segments on an included Level", () => {
  const restricted = createTile({
    coverKey: "half",
    x: 100,
    y: 100,
    width: 100,
    height: 20,
    rotation: 90,
    levels: ["ground"],
    manualHitbox: FULL_TILE_HITBOX
  });
  const unrestricted = createTile({
    coverKey: "partial",
    x: 100,
    y: 100,
    width: 20,
    height: 20,
    manualHitbox: FULL_TILE_HITBOX
  });
  const scene = createHydratedScene([restricted, unrestricted]);
  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 0, y: 145 }, [{ x: 100, y: 145 }], "ground"),
    ["half"]
  );
  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 0, y: 145 }, [{ x: 100, y: 145 }], "upper"),
    []
  );
  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 0, y: 100 }, [{ x: 100, y: 100 }], "upper"),
    ["partial"]
  );
});

test("Tile geometry treats x/y as Foundry's texture anchor instead of the upper-left corner", () => {
  const tile = createTile({
    coverKey: "half",
    x: 100,
    y: 100,
    width: 40,
    height: 20,
    anchorX: 0,
    anchorY: 1,
    manualHitbox: FULL_TILE_HITBOX
  });
  const scene = createHydratedScene([tile]);

  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 90, y: 87 }, [{ x: 110, y: 87 }]),
    ["half"]
  );
  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 80, y: 87 }, [{ x: 90, y: 87 }]),
    []
  );
});

test("aim cover uses only the green contour instead of transparent Tile rectangle space", () => {
  const tile = createTile({
    coverKey: "half",
    x: 50,
    y: 50,
    width: 100,
    height: 100,
    manualHitbox: {
      version: 1,
      points: [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }]
    }
  });
  const scene = createHydratedScene([tile]);
  assert.deepEqual(getCoverMaskKeys(scene, { x: 0, y: 15 }, [{ x: 100, y: 15 }]), []);
  assert.deepEqual(getCoverMaskKeys(scene, { x: 0, y: 50 }, [{ x: 100, y: 50 }]), ["half"]);
});

test("green contours return per-sample masks and ignore boundary-only contact", () => {
  const hitbox = {
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  };
  const between = createTile({
    coverKey: "half",
    x: 100,
    y: 50,
    width: 40,
    height: 40,
    manualHitbox: hitbox
  });
  const behindTarget = createTile({
    coverKey: "behind",
    x: 260,
    y: 50,
    width: 40,
    height: 40,
    manualHitbox: hitbox
  });
  const besideShot = createTile({
    coverKey: "beside",
    x: 100,
    y: 130,
    width: 40,
    height: 40,
    manualHitbox: hitbox
  });
  const scene = createHydratedScene([between, behindTarget, besideShot]);
  const origin = { x: 0, y: 50 };
  const targetSamples = [{ x: 190, y: 40 }, { x: 200, y: 50 }, { x: 190, y: 60 }];

  assert.deepEqual(getCoverMask(scene, origin, targetSamples, "half"), [1, 1, 1]);
  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 0, y: 30 }, [{ x: 200, y: 30 }]),
    [],
    "a ray which only touches the green contour boundary is not blocked"
  );
  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 0, y: 70 }, [{ x: 200, y: -30 }]),
    [],
    "a tangent through one contour vertex is not blocked"
  );
  assert.deepEqual(
    getCoverMask(scene, { x: 0, y: -50 }, [{ x: 200, y: 150 }], "half"),
    [1],
    "a segment entering through a vertex and crossing the interior is blocked"
  );
  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 0, y: 50 }, [{ x: 80, y: 50 }]),
    [],
    "contact only at the target endpoint is not blocked"
  );
  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 0, y: 200 }, [{ x: 200, y: 200 }]),
    [],
    "moving the whole aim corridor away from the same contour removes cover"
  );
});

test("samples outside the current red aim sector cannot create Tile cover", () => {
  const tile = createTile({
    coverKey: "half",
    x: 50,
    y: 25,
    width: 20,
    height: 14,
    manualHitbox: FULL_TILE_HITBOX
  });
  const scene = createHydratedScene([tile]);
  const origin = { x: 0, y: 0 };

  assert.deepEqual(
    getCoverMask(scene, origin, [{ x: 100, y: 50 }], "half"),
    [1],
    "a hidden sample from the full Token silhouette would cross the hitbox"
  );
  assert.deepEqual(
    getCoverMaskKeys(scene, origin, [{ x: 100, y: -5 }, { x: 100, y: 0 }, { x: 100, y: 5 }]),
    [],
    "the samples inside the narrow visible aim sector do not cross that hitbox"
  );
});

test("cover thresholds use union masks, exact integer boundaries, and the Tile key as a strength cap", () => {
  const entries = [
    { key: "full", overlapPercent: 80 },
    { key: "half", overlapPercent: 50 },
    { key: "partial", overlapPercent: 25 }
  ];
  const mask = (...values) => Uint8Array.from(values);
  const filledMask = blocked => Uint8Array.from({ length: 100 }, (_value, index) => index < blocked ? 1 : 0);

  for (const [blocked, expected] of [[24, undefined], [25, "partial"], [49, "partial"], [50, "half"], [79, "half"], [80, "full"]]) {
    assert.equal(
      resolveCoverFromSampleMasks(entries, null, new Map([["full", filledMask(blocked)]]), 100).cover?.key,
      expected,
      `${blocked}% uses exact integer threshold comparison`
    );
  }

  assert.equal(resolveCoverFromSampleMasks(entries, null, new Map([
    ["half", mask(1, 0, 0, 0)]
  ]), 4).cover?.key, "partial", "25% from a half-cap Tile grants partial cover");
  assert.equal(resolveCoverFromSampleMasks(entries, null, new Map([
    ["half", mask(1, 1, 0, 0)]
  ]), 4).cover?.key, "half", "50% reaches half cover exactly");
  assert.equal(resolveCoverFromSampleMasks(entries, null, new Map([
    ["half", mask(1, 1, 1, 1)]
  ]), 4).cover?.key, "half", "a half-cap Tile cannot grant full cover");

  const disjoint = resolveCoverFromSampleMasks(entries, mask(1, 0, 0, 0), new Map([
    ["half", mask(0, 1, 0, 0)]
  ]), 4);
  assert.equal(disjoint.cover?.key, "half", "different wall and Tile samples combine to 50%");
  assert.equal(disjoint.obstructionPercent, 50);

  const duplicate = resolveCoverFromSampleMasks(entries, mask(1, 0, 0, 0), new Map([
    ["half", mask(1, 0, 0, 0)]
  ]), 4);
  assert.equal(duplicate.cover?.key, "partial", "the same sample blocked twice is counted once");
  assert.equal(duplicate.obstructionPercent, 25);

  assert.equal(resolveCoverFromSampleMasks(entries, mask(1, 1, 1, 0), new Map([
    ["half", mask(0, 0, 0, 1)]
  ]), 4).cover?.key, "half", "half-cap geometry cannot promote a 75% wall mask to full");
  assert.equal(resolveCoverFromSampleMasks(entries, mask(1, 1, 1, 0), new Map([
    ["full", mask(0, 0, 0, 1)]
  ]), 4).cover?.key, "full", "full-cap geometry can complete the 80% threshold");
});

test("aim cover ignores a contour containing the attacker and includes one reached at the target", () => {
  const hitbox = {
    version: 1,
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  };
  const aroundAttacker = createTile({
    coverKey: "source",
    x: 0,
    y: 0,
    width: 40,
    height: 40,
    manualHitbox: hitbox
  });
  const aroundTarget = createTile({
    coverKey: "target",
    x: 100,
    y: 0,
    width: 40,
    height: 40,
    manualHitbox: hitbox
  });
  const scene = createHydratedScene([aroundAttacker, aroundTarget]);

  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 0, y: 0 }, [{ x: 100, y: 0 }]),
    ["target"]
  );
  assert.deepEqual(
    getCoverMaskKeys(scene, { x: 0, y: 100 }, [{ x: 100, y: 100 }]),
    []
  );
});

test("the generic contour registry owns copied geometry and supports atomic producer updates", () => {
  const scene = {};
  const sourcePoints = [
    { x: 40, y: 40 },
    { x: 60, y: 40 },
    { x: 60, y: 60 },
    { x: 40, y: 60 }
  ];
  const target = rectangle(45, 45, 55, 55);

  replaceCoverContours(scene, "test", [{
    sourceId: "first",
    coverKey: "half",
    levelIds: [],
    points: sourcePoints
  }]);
  sourcePoints[0].x = 500;
  assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], ["half"], "registry copied source geometry");

  upsertCoverContour(scene, "test", "first", {
    coverKey: "half",
    levelIds: [],
    points: [{ x: 400, y: 400 }, { x: 420, y: 400 }, { x: 420, y: 420 }, { x: 400, y: 420 }]
  });
  assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], []);

  upsertCoverContour(scene, "test", "second", {
    coverKey: "partial",
    levelIds: [],
    points: [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }]
  });
  assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], ["partial"]);
  removeCoverContour(scene, "test", "second");
  assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], []);
  clearCoverContours(scene);
});

test("a configured Tile without a green contour never creates invisible cover geometry", () => {
  const tile = createTile({ coverKey: "half", x: 50, y: 50, width: 100, height: 100 });
  const scene = createHydratedScene([tile]);
  assert.deepEqual(getCoverMaskKeys(scene, { x: -50, y: 50 }, [{ x: 150, y: 50 }]), []);
});

test("Tile lifecycle hooks publish only prepared green contours into the generic registry", () => {
  const previousHooks = globalThis.Hooks;
  const callbacks = new Map();
  globalThis.Hooks = {
    on(name, callback) {
      const entries = callbacks.get(name) ?? [];
      entries.push(callback);
      callbacks.set(name, entries);
    }
  };
  const emit = (name, ...args) => {
    for (const callback of callbacks.get(name) ?? []) callback(...args);
  };

  try {
    registerTileCoverContourHooks();
    assert.deepEqual([...callbacks.keys()].sort(), ["canvasReady", "createTile", "deleteTile", "drawTile", "updateTile"]);
    const tile = createTile({
      x: 50,
      y: 50,
      width: 20,
      height: 20,
      manualHitbox: FULL_TILE_HITBOX
    });
    const scene = createScene([tile]);
    const target = rectangle(45, 45, 55, 55);
    assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], [], "Scene is not read by the runtime query");
    emit("canvasReady", { scene });
    assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], ["half"]);
    tile.x = 500;
    emit("updateTile", tile, { alpha: 0.5 });
    assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], ["half"], "unrelated updates retain prepared geometry");
    emit("updateTile", tile, { x: 500 });
    assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], []);
    tile.x = 50;
    emit("updateTile", tile, { x: 50 });
    assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], ["half"]);
    emit("deleteTile", tile);
    assert.deepEqual([...getCoverKeysIntersectingPolygon(scene, target)], []);
  } finally {
    if (previousHooks === undefined) delete globalThis.Hooks;
    else globalThis.Hooks = previousHooks;
  }
});

test("the V14 Tile sheet, native polygon editor, overlay, and aim-contour cover pipeline are wired", async () => {
  const [
    sheetSource,
    registrationSource,
    attackSource,
    coverSource,
    contourSource,
    adapterSource,
    templateSource,
    hitboxSource,
    mainSource,
    overlaySource
  ] = await Promise.all([
    readFile(new URL("../src/sheets/tile-config.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/registration.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/cover.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/cover-contours.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/tile-cover.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/scene/parts/tile-additional.hbs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/tile-hitbox.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/tile-hitbox-overlay.mjs", import.meta.url), "utf8")
  ]);

  assert.match(sheetSource, /class FalloutMaWTileConfig extends CoreTileConfig/);
  assert.match(sheetSource, /id: "additional"[\s\S]*FALLOUTMAW\.Tile\.Tabs\.Additional/);
  assert.match(sheetSource, /_onChangeForm\(formConfig, event\)/);
  assert.doesNotMatch(sheetSource, /addEventListener\("change"/);
  assert.match(registrationSource, /unregisterSheet\(CONFIG\.Tile\.documentClass, "core", foundry\.applications\.sheets\.TileConfig/);
  assert.match(registrationSource, /registerSheet\(CONFIG\.Tile\.documentClass, FALLOUT_MAW\.id, FalloutMaWTileConfig/);
  assert.match(templateSource, /flags\.fallout-maw\.tileSpecialProperties\.\{\{index\}\}\.coverKey/);
  assert.match(templateSource, /data-action="editTileHitbox"/);
  assert.match(templateSource, /data-action="clearTileHitbox"/);
  assert.match(sheetSource, /await this\.close\(\{ animate: false \}\)/);
  assert.match(sheetSource, /drawTileHitboxOnCanvas\(tile\)/);
  assert.match(hitboxSource, /canvasObject\.regions\.placeRegion\(/);
  assert.match(hitboxSource, /create: false/);
  assert.match(hitboxSource, /preConfirm:/);
  assert.match(hitboxSource, /preSkip:/);
  assert.match(mainSource, /registerTileCoverContourHooks\(\)/);
  assert.match(mainSource, /registerTileHitboxOverlayHooks\(\)/);
  assert.match(overlaySource, /Hooks\.on\("drawTile"/);
  assert.match(overlaySource, /HITBOX_GREEN = 0x39ff88/);
  assert.match(overlaySource, /eventMode = "none"/);
  assert.match(attackSource, /getTokenAttackCoverPolygon\(target, obstructionGeometry\)/);
  assert.match(attackSource, /getUnclippedAttackAreaPolygon\(geometry\)/);
  assert.match(attackSource, /getCoverSampleMasksIntersectingSegments\([\s\S]*obstructionGeometry\.origin,[\s\S]*coverSamplePoints/);
  assert.match(attackSource, /getTokenAttackObstructionMask\(attackerToken, obstructionGeometry, coverSamplePoints\)/);
  assert.match(attackSource, /resolveCoverFromSampleMasks\([\s\S]*wallMask,[\s\S]*contourMasks/);
  assert.match(attackSource, /function isAttackCoverSampleBlocked[\s\S]*return !hasLineOfSight/);
  assert.doesNotMatch(attackSource, /getCoverKeysIntersectingSegments|contourCoverKeys\.has/);
  assert.doesNotMatch(attackSource, /tile-cover|getIntersectingTile|tileCoverKeys|getAimedTileCoverKeys|getCoverKeysIntersectingPolygon/);
  assert.doesNotMatch(coverSource, /tile-cover|registerTileCover/);
  assert.doesNotMatch(contourSource, /scene\?\.tiles|scene\.tiles|getTile|TileDocument/);
  assert.match(contourSource, /blocked \* 100\) >= \(threshold \* total/);
  assert.match(contourSource, /segmentIntersectsPolygonInterior/);
  assert.match(adapterSource, /getTileHitboxWorldPoints\(tile\)/);
  assert.doesNotMatch(adapterSource, /getTileRectanglePoints|rectangle fallback/);
});
