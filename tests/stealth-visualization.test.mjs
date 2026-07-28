import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cleanupAllStealthVisualizations,
  clearWeaponNoisePreview,
  collectGridBoundaryEdges,
  collectUniqueGridOffsets,
  getStealthVisualizationStats,
  onTokenHoverForDetectionZone,
  refreshDetectionVisualizations,
  removeDetectionVisualization,
  setPersistentDetectionVisualization,
  setWeaponNoisePreview,
  updateDetectionVisualization
} from "../src/stealth/visualization.mjs";
import { configureStealthRuleSettingsProvider } from "../src/stealth/rules.mjs";

function edgeKey({ start, end }) {
  const left = `${start.x},${start.y}`;
  const right = `${end.x},${end.y}`;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

test("two adjacent square cells omit their shared edge", () => {
  const vertices = new Map([
    ["left", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]],
    ["right", [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 }
    ]]
  ]);

  const edges = collectGridBoundaryEdges(["left", "right"], offset => vertices.get(offset));
  const keys = new Set(edges.map(edgeKey));

  assert.equal(edges.length, 6);
  assert.equal(keys.has("10,0|10,10"), false);
  assert.deepEqual(keys, new Set([
    "0,0|10,0",
    "0,10|10,10",
    "0,0|0,10",
    "10,0|20,0",
    "20,0|20,10",
    "10,10|20,10"
  ]));
});

test("arbitrary polygons omit a shared edge regardless of winding", () => {
  const polygons = new Map([
    ["lower", [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 2, y: 3 }
    ]],
    ["upper", [
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 2, y: 3 }
    ]]
  ]);

  const edges = collectGridBoundaryEdges(["lower", "upper"], offset => polygons.get(offset));
  const keys = new Set(edges.map(edgeKey));

  assert.equal(edges.length, 4);
  assert.equal(keys.has("2,3|4,0"), false);
  assert.deepEqual(keys, new Set([
    "0,0|4,0",
    "0,0|2,3",
    "4,0|4,4",
    "2,3|4,4"
  ]));
});

test("overlapping grid zones form one stable union before fill and outline", () => {
  const left = { i: 0, j: 0 };
  const right = { i: 0, j: 1 };
  const lowerRight = { i: 1, j: 1 };
  const offsets = collectUniqueGridOffsets([
    [left, right],
    [right, lowerRight],
    [{ i: 0, j: 0 }]
  ]);

  assert.deepEqual(
    offsets.map(offset => `${offset.i}:${offset.j}`),
    ["0:0", "0:1", "1:1"]
  );

  const vertices = new Map([
    ["0:0", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]],
    ["0:1", [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 }
    ]],
    ["1:1", [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 }
    ]]
  ]);
  const edges = collectGridBoundaryEdges(
    offsets,
    offset => vertices.get(`${offset.i}:${offset.j}`)
  );
  const keys = new Set(edges.map(edgeKey));

  assert.equal(edges.length, 8);
  assert.equal(keys.has("10,0|10,10"), false);
  assert.equal(keys.has("10,10|20,10"), false);
});

test("persistent, stealth-window, and weapon previews own independent visualization sources", () => {
  const token = { id: "hidden-token" };
  try {
    setPersistentDetectionVisualization(token);
    updateDetectionVisualization(token);
    setWeaponNoisePreview(token, "attack-a", 2);
    setWeaponNoisePreview(token, "attack-b", 5);
    setWeaponNoisePreview(token, "attack-b", 5);
    assert.deepEqual(
      pickSourceStats(getStealthVisualizationStats()),
      { active: 1, sources: 4, maximumNoiseLevel: 5 }
    );

    clearWeaponNoisePreview(token.id, "attack-b");
    removeDetectionVisualization(token.id);
    assert.deepEqual(
      pickSourceStats(getStealthVisualizationStats()),
      { active: 1, sources: 2, maximumNoiseLevel: 2 }
    );

    clearWeaponNoisePreview(token.id, "attack-a");
    assert.deepEqual(
      pickSourceStats(getStealthVisualizationStats()),
      { active: 1, sources: 1, maximumNoiseLevel: 0 }
    );

    setPersistentDetectionVisualization(token, false);
    assert.deepEqual(
      pickSourceStats(getStealthVisualizationStats()),
      { active: 0, sources: 0, maximumNoiseLevel: 0 }
    );
  } finally {
    cleanupAllStealthVisualizations();
  }
});

test("weapon preview renders one source-owned grid outline and never substitutes a circle", () => {
  const restore = installVisualizationFixture({ gridless: false });
  try {
    const token = globalThis.canvas.tokens.placeables[0];
    setWeaponNoisePreview(token, "attack", 2);
    refreshDetectionVisualizations();

    const layer = globalThis.canvas.controls.falloutMawStealthDetectionZones;
    assert.equal(getStealthVisualizationStats().rendered, 1);
    assert.equal(layer.children.length, 1);
    assert.equal(layer.children[0].children.length, 1);
    assert.strictEqual(layer.mask, globalThis.canvas.masks.canvas);
    const graphics = layer.children[0].children[0];
    assert.equal(graphics.calls.some(([method]) => method === "beginFill"), false);
    assert.equal(graphics.calls.filter(([method]) => method === "moveTo").length, 20);
    assert.equal(graphics.calls.filter(([method]) => method === "lineTo").length, 20);
    assert.equal(graphics.calls.some(([method]) => method === "drawCircle"), false);
  } finally {
    cleanupAllStealthVisualizations();
    restore();
  }
});

test("a zero-noise weapon preview still outlines its source cell", () => {
  const restore = installVisualizationFixture({ gridless: false });
  try {
    const token = globalThis.canvas.tokens.placeables[0];
    setWeaponNoisePreview(token, "quiet-attack", 0);
    refreshDetectionVisualizations();

    const layer = globalThis.canvas.controls.falloutMawStealthDetectionZones;
    assert.equal(getStealthVisualizationStats().rendered, 1);
    const graphics = layer.children[0].children[0];
    assert.equal(graphics.calls.filter(([method]) => method === "moveTo").length, 4);
    assert.equal(graphics.calls.filter(([method]) => method === "lineTo").length, 4);
  } finally {
    cleanupAllStealthVisualizations();
    restore();
  }
});

test("persistent visualization alone does not invent a zero-noise source zone", () => {
  const restore = installVisualizationFixture({ gridless: false });
  try {
    const token = globalThis.canvas.tokens.placeables[0];
    setPersistentDetectionVisualization(token, true);
    refreshDetectionVisualizations();

    assert.equal(getStealthVisualizationStats().rendered, 0);
    assert.equal(globalThis.canvas.controls.falloutMawStealthDetectionZones, undefined);
  } finally {
    cleanupAllStealthVisualizations();
    restore();
  }
});

test("gridless scenes do not invent a geometric noise shape for a cell-zone mechanic", () => {
  const restore = installVisualizationFixture({ gridless: true });
  try {
    const token = globalThis.canvas.tokens.placeables[0];
    setWeaponNoisePreview(token, "attack", 2);
    refreshDetectionVisualizations();

    assert.equal(getStealthVisualizationStats().rendered, 0);
    assert.equal(globalThis.canvas.controls.falloutMawStealthDetectionZones, undefined);
  } finally {
    cleanupAllStealthVisualizations();
    restore();
  }
});

test("hover fills the source noise zone only when it contacts the hovered observer", () => {
  for (const [observerCell, expectedHighlights] of [
    [{ i: 3, j: 5 }, 13],
    [{ i: 6, j: 6 }, 1]
  ]) {
    const restore = installVisualizationFixture({
      gridless: false,
      observerCell
    });
    try {
      const [token, observer] = globalThis.canvas.tokens.placeables;
      setWeaponNoisePreview(token, "attack", 2);
      refreshDetectionVisualizations();
      onTokenHoverForDetectionZone(observer, true);

      const highlights = globalThis.canvas.interface.grid.highlightCalls;
      assert.equal(highlights.length, expectedHighlights);
      assert.equal(highlights.every(call => call.alpha === 0.14), true);
    } finally {
      cleanupAllStealthVisualizations();
      restore();
    }
  }
});

function pickSourceStats(stats) {
  return {
    active: stats.active,
    sources: stats.sources,
    maximumNoiseLevel: stats.maximumNoiseLevel
  };
}

function installVisualizationFixture({ gridless, observerCell = null }) {
  const originals = {
    canvas: globalThis.canvas,
    game: globalThis.game,
    PIXI: globalThis.PIXI
  };
  class Container {
    constructor() {
      this.children = [];
      this.destroyed = false;
    }

    addChild(child) {
      this.children.push(child);
      return child;
    }

    destroy({ children = false } = {}) {
      if (children) {
        for (const child of this.children) child.destroy?.({ children: true });
      }
      this.children.length = 0;
      this.destroyed = true;
    }
  }
  class Rectangle {
    constructor(x, y, width, height) {
      Object.assign(this, { x, y, width, height });
    }

    fit() {
      return this;
    }
  }
  class Graphics extends Container {
    constructor() {
      super();
      this.calls = [];
    }

    record(method, ...args) {
      this.calls.push([method, ...args]);
      return this;
    }

    beginFill(...args) {
      return this.record("beginFill", ...args);
    }

    endFill(...args) {
      return this.record("endFill", ...args);
    }

    lineStyle(...args) {
      return this.record("lineStyle", ...args);
    }

    drawPolygon(...args) {
      return this.record("drawPolygon", ...args);
    }

    drawCircle(...args) {
      return this.record("drawCircle", ...args);
    }

    moveTo(...args) {
      return this.record("moveTo", ...args);
    }

    lineTo(...args) {
      return this.record("lineTo", ...args);
    }
  }
  globalThis.PIXI = { Container, Graphics, Rectangle };
  globalThis.game = { user: { isGM: true } };
  configureStealthRuleSettingsProvider(() => ({
    autoDetection: { enabled: true }
  }));

  const actor = {
    uuid: "Actor.hidden",
    statuses: new Set(["invisible"]),
    system: { skills: { naturalist: { value: 0 } } },
    getFlag: () => undefined
  };
  const token = {
    id: "hidden-token",
    actor,
    visible: true,
    renderable: true,
    document: {
      uuid: "Scene.preview.Token.hidden-token",
      elevation: 0,
      getCenterPoint: () => ({ x: 350, y: 350, elevation: 0 })
    }
  };
  const controls = new Container();
  const canvasMask = {};
  const gridSize = 100;
  const gridSpan = 7;
  const observer = observerCell ? {
    id: "observer-token",
    actor: {
      uuid: "Actor.observer",
      statuses: new Set(),
      system: { skills: { naturalist: { value: 0 } } },
      getFlag: () => undefined
    },
    hasSight: true,
    visible: true,
    renderable: true,
    checkCollision: () => false,
    document: {
      uuid: "Scene.preview.Token.observer-token",
      elevation: 0,
      sight: { enabled: true, range: null },
      detectionModes: {
        basicSight: { enabled: true, range: null }
      },
      getCenterPoint: () => ({
        x: (observerCell.j + 0.5) * gridSize,
        y: (observerCell.i + 0.5) * gridSize,
        elevation: 0
      })
    }
  } : null;
  const placeables = observer ? [token, observer] : [token];
  const highlightCalls = [];
  globalThis.canvas = {
    ready: true,
    scene: {
      id: "preview",
      grid: { distance: 1 }
    },
    dimensions: {
      rect: new Rectangle(0, 0, gridSize * gridSpan, gridSize * gridSpan)
    },
    masks: { canvas: canvasMask },
    visibility: { tokenVision: false },
    grid: {
      distance: 1,
      isGridless: gridless,
      size: gridSize,
      getOffset: point => ({
        i: Math.floor((Number(point?.y) || 0) / gridSize),
        j: Math.floor((Number(point?.x) || 0) / gridSize)
      }),
      getCenterPoint: ({ i, j }) => ({
        x: (j + 0.5) * gridSize,
        y: (i + 0.5) * gridSize,
        elevation: 0
      }),
      getOffsetRange: bounds => [
        Math.max(0, Math.floor(bounds.y / gridSize)),
        Math.max(0, Math.floor(bounds.x / gridSize)),
        Math.min(gridSpan, Math.ceil((bounds.y + bounds.height) / gridSize)),
        Math.min(gridSpan, Math.ceil((bounds.x + bounds.width) / gridSize))
      ],
      getVertices: ({ i, j }) => {
        const x = j * gridSize;
        const y = i * gridSize;
        return [
          { x, y },
          { x: x + gridSize, y },
          { x: x + gridSize, y: y + gridSize },
          { x, y: y + gridSize }
        ];
      },
      getTopLeftPoint: ({ i, j }) => ({
        x: j * gridSize,
        y: i * gridSize
      })
    },
    tokens: {
      get: id => placeables.find(candidate => candidate.id === id) ?? null,
      placeables
    },
    controls,
    interface: {
      grid: {
        highlightCalls,
        addHighlightLayer: () => undefined,
        clearHighlightLayer: () => {
          highlightCalls.length = 0;
        },
        destroyHighlightLayer: () => undefined,
        highlightPosition: (_name, options) => {
          highlightCalls.push(options);
        }
      }
    }
  };

  return () => {
    configureStealthRuleSettingsProvider();
    if (originals.canvas === undefined) delete globalThis.canvas;
    else globalThis.canvas = originals.canvas;
    if (originals.game === undefined) delete globalThis.game;
    else globalThis.game = originals.game;
    if (originals.PIXI === undefined) delete globalThis.PIXI;
    else globalThis.PIXI = originals.PIXI;
  };
}
