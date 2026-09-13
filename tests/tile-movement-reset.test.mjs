import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";

class NativeTile {
  constructor(parent) {
    this.parent = parent;
    this._source = { _id: "tile", x: 12, flags: { core: { value: 1 } } };
    this.initializations = 0;
    this.preparations = 0;
  }
  _initialize() { this.initializations++; }
  prepareData() { this.preparations++; }
  prepareBaseData() {}
  prepareEmbeddedDocuments() {}
  prepareDerivedData() {}
}
globalThis.foundry = {
  documents: { TileDocument: NativeTile },
  utils: { equals: isDeepStrictEqual, deepClone: structuredClone }
};
globalThis.game = { release: { version: "14.361" } };
const { FalloutMaWTileDocument, markMovementSceneReset, withMovementTileReuse } =
  await import("../src/documents/tile-reset-cache.mjs");

function setup() {
  const scene = { dimensions: { width: 100, height: 100 } };
  const tile = new FalloutMaWTileDocument(scene);
  tile._initialize({});
  tile.prepareData();
  return { scene, tile };
}
function reset(scene, tile, changes = [{ _id: "token", x: 20, _movementHistory: [] }]) {
  markMovementSceneReset(scene, scene, "tokens", changes);
  return withMovementTileReuse(scene, () => {
    tile._initialize({ sceneReset: true });
    tile.prepareData();
    return "native-reset-result";
  });
}

test("coordinate updates keep native Scene reset but reuse unchanged Tile preparation", () => {
  const { scene, tile } = setup();
  assert.equal(reset(scene, tile), "native-reset-result");
  assert.equal(tile.initializations, 1);
  assert.equal(tile.preparations, 1);
  reset(scene, tile);
  assert.equal(tile.preparations, 1);
});

test("in-place source edits, including nested flags, invalidate the Tile certificate", () => {
  const { scene, tile } = setup();
  tile._source.flags.core.value = 2;
  reset(scene, tile);
  assert.equal(tile.initializations, 2);
  assert.equal(tile.preparations, 2);
  reset(scene, tile);
  assert.equal(tile.preparations, 2);
});

test("changed Scene dimensions require native Tile initialization and clamping", () => {
  const { scene, tile } = setup();
  scene.dimensions.width = 200;
  reset(scene, tile);
  assert.equal(tile.initializations, 2);
  assert.equal(tile.preparations, 2);
});

test("explicit resets and Token actor changes preserve the full native path", () => {
  const { scene, tile } = setup();
  withMovementTileReuse(scene, () => { tile._initialize({ sceneReset: true }); tile.prepareData(); });
  reset(scene, tile, [{ _id: "token", x: 30, actorId: "actor" }]);
  assert.equal(tile.initializations, 3);
  assert.equal(tile.preparations, 3);
});

test("unrelated embedded updates cancel a pending movement reset", () => {
  const { scene, tile } = setup();
  markMovementSceneReset(scene, scene, "tokens", [{ _id: "token", x: 20 }]);
  markMovementSceneReset(scene, scene, "tiles", [{ _id: "tile", x: 30 }]);
  withMovementTileReuse(scene, () => { tile._initialize({ sceneReset: true }); tile.prepareData(); });
  assert.equal(tile.initializations, 2);
});

test("tickets expire at the microtask boundary when the response aborts", async () => {
  const { scene, tile } = setup();
  markMovementSceneReset(scene, scene, "tokens", [{ _id: "token", x: 20 }]);
  await Promise.resolve();
  withMovementTileReuse(scene, () => { tile._initialize({ sceneReset: true }); tile.prepareData(); });
  assert.equal(tile.initializations, 2);
});

test("unsupported versions and modified native Tile methods retain normal preparation", () => {
  const { scene, tile } = setup();
  game.release.version = "14.362";
  try { reset(scene, tile); } finally { game.release.version = "14.361"; }
  const original = NativeTile.prototype.prepareDerivedData;
  NativeTile.prototype.prepareDerivedData = () => {};
  try { reset(scene, tile); } finally { NativeTile.prototype.prepareDerivedData = original; }
  assert.equal(tile.initializations, 3);
});

test("reuse context always closes if the native reset throws", () => {
  const { scene, tile } = setup();
  markMovementSceneReset(scene, scene, "tokens", [{ _id: "token", x: 20 }]);
  assert.throws(() => withMovementTileReuse(scene, () => {
    tile._initialize({ sceneReset: true });
    throw new Error("reset failed");
  }));
  tile.prepareData();
  assert.equal(tile.preparations, 2);
});
