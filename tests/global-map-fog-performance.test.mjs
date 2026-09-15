import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ---- PIXI / Foundry stubs -------------------------------------------------
class FakeGraphics {
  constructor() { this.children = []; this.destroyed = false; }
  addChild(child) { this.children.push(child); return child; }
  addChildAt(child, index) { this.children.splice(index, 0, child); return child; }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }
  removeChildren() {
    const removed = this.children;
    this.children = [];
    return removed;
  }
  beginFill() { return this; }
  endFill() { return this; }
  drawPolygon() { return this; }
  clear() { return this; }
  destroy() {
    this.destroyed = true;
    this.parent?.removeChild?.(this);
    this.parent = null;
    for (const child of this.children) child?.destroy?.();
    this.children = [];
  }
}
globalThis.PIXI = {
  LegacyGraphics: FakeGraphics,
  Filter: class {
    constructor() { this.uniforms = {}; }
    apply() {}
  },
  BLEND_MODES: { NORMAL: 0 },
  Texture: { EMPTY: {} }
};
globalThis.window = { setTimeout, clearTimeout };
globalThis.CONST = {
  FOG_EXPLORATION_MODES: { DISABLED: 0, INDIVIDUAL: 1 },
  DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
  GRID_TYPES: { SQUARE: 1, HEXODDR: 2, HEXEVENQ: 5 }
};
globalThis.foundry = {
  applications: { api: { DialogV2: { confirm: async () => false } } },
  utils: {
    deepClone: value => value === undefined ? undefined : structuredClone(value),
    mergeObject: (original, other, { inplace = true } = {}) => {
      const target = inplace ? original : structuredClone(original);
      return mergeInto(target, other);
    },
    randomID: () => "id"
  }
};
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.Hooks = { on() {}, off() {}, once() {} };

const sceneWrites = [];
const socketEmits = [];
let resetExplorationCalls = 0;

const sz = 100;
globalThis.canvas = {
  scene: null,
  ready: true,
  loading: false,
  tokens: { placeables: [], controlled: [] },
  visibility: {
    explored: new FakeGraphics(),
    filter: null,
    filters: [],
    // Foundry's VisibilityGroup.resetExploration() destroys the container and
    // replaces it with a brand new (empty) one.
    resetExploration() {
      resetExplorationCalls += 1;
      this.explored.destroy();
      this.explored = new FakeGraphics();
    }
  },
  masks: { vision: { renderTexture: {} } },
  fog: { sprite: { visible: true } },
  perception: { update() {}, initialize() {} }
};
globalThis.game = {
  user: { isGM: true, id: "gm" },
  users: { activeGM: { id: "gm" }, contents: [] },
  settings: { get: () => null },
  socket: { emit: (channel, payload) => socketEmits.push(payload), on() {} }
};

function makeScene(id, exploredKeys) {
  let flag = {
    version: 3,
    mapId: "map",
    role: "rootScene",
    nodeId: "map",
    state: { fog: { mode: "cells", cellRadius: 1, exploredCellKeys: [...exploredKeys] } }
  };
  return {
    id,
    grid: {
      type: 1,
      size: sz,
      sizeX: sz,
      sizeY: sz,
      getOffset: point => ({ i: Math.floor(point.x / sz), j: Math.floor(point.y / sz) }),
      getCenterPoint: cell => ({ x: cell.i * sz + sz / 2, y: cell.j * sz + sz / 2 }),
      getVertices: cell => {
        const x = cell.i * sz;
        const y = cell.j * sz;
        return [{ x, y }, { x: x + sz, y }, { x: x + sz, y: y + sz }, { x, y: y + sz }];
      }
    },
    tokens: { contents: [] },
    fog: { mode: 0 },
    getFlag: (namespace, key) => namespace === "fallout-maw" && key === "globalMap" ? flag : null,
    setFlag: async (namespace, key, value) => {
      if (namespace !== "fallout-maw" || key !== "globalMap") return;
      sceneWrites.push({ flag: value, via: "setFlag" });
      flag = value;
    },
    update: async changes => {
      const flagPath = "flags.fallout-maw.globalMap";
      if (changes && Object.hasOwn(changes, flagPath)) {
        sceneWrites.push({ flag: changes[flagPath], via: "update" });
        flag = changes[flagPath];
      }
    }
  };
}

const fog = await import(new URL("../src/global-map/fog.mjs", import.meta.url));
const { getSceneState } = await import(new URL("../src/global-map/storage.mjs", import.meta.url));

function cluster(center, radius = 1) {
  const cells = [];
  for (let i = -radius; i <= radius; i += 1) {
    for (let j = -radius; j <= radius; j += 1) cells.push({ i: center + i, j: center + j });
  }
  return cells;
}

function resetWorld(exploredKeys = []) {
  sceneWrites.length = 0;
  socketEmits.length = 0;
  resetExplorationCalls = 0;
  const scene = makeScene("scene-1", exploredKeys);
  canvas.scene = scene;
  canvas.visibility.explored = new FakeGraphics();
  canvas.visibility.explored.children = [];
  fog.__test.resetCaches();
  return scene;
}

function sizeOf(value) {
  return JSON.stringify(value ?? null).length;
}

test("exploring an already known cluster never touches the document", async () => {
  const explored = [];
  for (let i = 0; i < 80; i += 1) {
    for (let j = 0; j < 80; j += 1) explored.push(`${i},${j}`);
  }
  const scene = resetWorld(explored);

  // 200 steps across explored ground: the old code scanned the whole explored array
  // (6400 entries) on every step before deciding there was nothing to do.
  for (let step = 0; step < 200; step += 1) {
    fog.__test.queueExploration(cluster(10 + (step % 20)));
    await Promise.resolve();
  }
  await fog.__test.flushExploration();

  assert.equal(sceneWrites.length, 0, "no document write for already explored cells");
  assert.equal(socketEmits.filter(entry => entry.action === "globalMap.cellFog.changed").length, 0);
});

test("a long walk is persisted by a single serialized write", async () => {
  const scene = resetWorld(["0,0"]);
  const before = getSceneState(scene).fog.exploredCellKeys.length;

  for (let step = 0; step < 40; step += 1) {
    fog.__test.queueExploration(cluster(30 + step));
  }
  const writesBeforeFlush = sceneWrites.length;
  await fog.__test.flushExploration();

  const after = getSceneState(scene).fog.exploredCellKeys;
  assert.equal(writesBeforeFlush, 0, "queueing cells must not write the scene flag");
  assert.ok(after.length > before + 20, "all walked cells end up explored");
  assert.equal(sceneWrites.length, 1, "the whole walk collapses into one write");
  assert.equal(fog.__test.dirtyCount(), 0, "the dirty buffer is drained");
});

test("cells discovered during a write are persisted by the next pass, never lost", async () => {
  const scene = resetWorld(["0,0"]);
  let releaseWrite = null;
  const gate = new Promise(resolve => { releaseWrite = resolve; });

  // Slow the first document write down and queue more cells while it is in flight.
  const originalSetFlag = scene.setFlag;
  scene.setFlag = async (namespace, key, value) => {
    await gate;
    return originalSetFlag(namespace, key, value);
  };

  fog.__test.queueExploration(cluster(50));
  const flushing = fog.__test.flushExploration();
  await Promise.resolve();
  fog.__test.queueExploration(cluster(70));
  releaseWrite();
  await flushing;
  await fog.__test.flushExploration();

  const explored = getSceneState(scene).fog.exploredCellKeys;
  assert.ok(explored.includes("70,70"), "cells found mid-write must still be persisted");
  assert.ok(explored.includes("50,50"));
  assert.equal(fog.__test.dirtyCount(), 0);
  assert.equal(sceneWrites.length, 2, "one write per pass, no rewrite of the earlier pass");
});

test("the fog module keeps O(1) membership instead of rescanning growing arrays", async () => {
  const source = await readFile(new URL("../src/global-map/fog.mjs", import.meta.url), "utf8");

  assert.match(source, /let knownExploredKeys = null;/, "explored keys must be cached as a Set");
  assert.match(source, /function getKnownExploredKeys\(scene\)/);
  assert.match(source, /const fresh = requested\.filter\(key => key && !known\.has\(key\) && !dirtyCellKeys\.has\(key\)\)/);
  assert.doesNotMatch(source, /exploredCellKeys\.includes\(/, "no linear scan over explored cells");
  assert.doesNotMatch(source, /discoveredLocationIds\.includes\(/, "no linear scan over discovered locations");
  assert.doesNotMatch(source, /discoveredTransitionIds\.includes\(/);
  assert.doesNotMatch(source, /discoveredExitZoneIds\.includes\(/);
  assert.match(source, /const knownLocations = new Set\(state\.discoveredLocationIds\)/);
});

test("exploration is persisted without timers or debounce guessing", async () => {
  const source = await readFile(new URL("../src/global-map/fog.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /setTimeout|setInterval/, "no timer-based batching");
  assert.doesNotMatch(source, /FLUSH_DELAY|DEBOUNCE/, "no delay constant");
  assert.match(source, /function flushCellExploration\(\)/);
  assert.match(source, /function queueCellFogWrite\(run\)/);
  assert.match(source, /let fogWriteChain = Promise\.resolve\(\);/, "writes are serialized through a chain");
  assert.match(source, /const attempt = fogWriteChain\.then\(run, run\);/);
  assert.match(source, /while \(dirtyCellKeys\.size && canvas\?\.scene === scene\)/);
  assert.match(source, /queueCellFogWrite\(async \(\) => \{[\s\S]*?await updateSceneState\(scene, state => \{\n\s*state\.fog\.exploredCellKeys = \[\];/,
    "the reset must run on the same serialized chain");
});

test("resetting the exploration clears the fog that is already drawn", async () => {
  const scene = resetWorld(["0,0"]);
  game.user.isGM = true;
  game.users.activeGM = game.user;

  fog.__test.queueExploration(cluster(40));
  await fog.__test.flushExploration();
  assert.ok(fog.__test.drawnCellCount() > 0, "explored cells are drawn before the reset");
  assert.ok(explorationGraphics().length > 0, "the exploration overlay exists before the reset");

  const reset = await fog.__test.resetCellFog(scene);
  assert.equal(reset, true);
  assert.deepEqual(getSceneState(scene).fog.exploredCellKeys, [], "stored cells are cleared");
  assert.equal(fog.__test.drawnCellCount(), 0, "the drawn-cell cache is dropped");
  assert.equal(explorationGraphics().length, 0, "no overlay is left behind after the reset");
  assert.ok(resetExplorationCalls > 0, "Foundry's exploration texture must be reset too");
  assert.equal(fog.__test.dirtyCount(), 0, "no pending cells survive the reset");

  // Nothing may be redrawn from the stale cache, and new exploration starts from zero.
  fog.__test.syncDisplay();
  assert.equal(explorationGraphics().length, 0, "an empty exploration creates no overlay");
  assert.equal(fog.__test.drawnCellCount(), 0);
});

test("a reset during an in-flight write never resurrects cleared cells", async () => {
  const scene = resetWorld(["0,0"]);
  game.user.isGM = true;
  game.users.activeGM = game.user;

  // Hold back only the very first write, then let everything through.
  let released = false;
  let releaseWrite = null;
  const gate = new Promise(resolve => { releaseWrite = resolve; });
  const originalSetFlag = scene.setFlag;
  scene.setFlag = async (namespace, key, value) => {
    if (!released) await gate;
    return originalSetFlag(namespace, key, value);
  };

  fog.__test.queueExploration(cluster(40));
  const flushing = fog.__test.flushExploration();
  await Promise.resolve();

  const resetting = fog.__test.resetCellFog(scene);
  released = true;
  releaseWrite();
  await Promise.all([flushing, resetting]);
  await fog.__test.flushExploration();

  assert.deepEqual(getSceneState(scene).fog.exploredCellKeys, [], "the reset must win over the pending write");
  assert.equal(explorationGraphics().length, 0, "no fog is left drawn after the reset");
});

function explorationGraphics() {
  return canvas.visibility.explored.children.filter(child => !child.destroyed);
}

test("the explored overlay is drawn incrementally", async () => {
  const source = await readFile(new URL("../src/global-map/fog.mjs", import.meta.url), "utf8");
  const sync = source.match(/function syncCellExplorationDisplay\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.ok(sync, "expected the exploration display sync");
  assert.doesNotMatch(sync, /\.clear\(\)/, "the overlay must not be rebuilt from scratch every refresh");
  assert.match(sync, /if \(drawnCellFogKeys\.has\(key\)\) continue;/);
  assert.match(sync, /if \(!pending\.length\) return;/, "an empty overlay must not be created");
  assert.match(source, /let drawnCellFogKeys = new Set\(\);/);
  assert.match(source, /function ensureCellExplorationGraphic\(explored\)/);
  assert.doesNotMatch(source, /drawnCellFogGraphic/, "no leftover graphic bookkeeping");
});

function mergeInto(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) target[key] = structuredClone(value);
    else if (value && typeof value === "object") {
      const base = target[key] && typeof target[key] === "object" && !Array.isArray(target[key]) ? target[key] : {};
      target[key] = mergeInto(base, value);
    } else target[key] = value;
  }
  return target;
}
