import assert from "node:assert/strict";
import test from "node:test";
import { getTokenHitboxGeometry, getTokenHitboxWorldBounds, getTokenHitboxTestPoints, getTokenHitboxGridCells } from "../src/utils/token-hitbox.mjs";

const grid = { sizeX: 100, sizeY: 100, distance: 1,
  getOffsetRange: b => [Math.floor(b.y / 100), Math.floor(b.x / 100), Math.ceil((b.y + b.height) / 100), Math.ceil((b.x + b.width) / 100)],
  getOffset: p => ({ i: Math.floor(p.y / 100), j: Math.floor(p.x / 100), k: Math.floor(p.elevation) }),
  getCenterPoint: p => ({ x: p.j * 100 + 50, y: p.i * 100 + 50, elevation: p.k }),
  getVertices: p => [{ x: p.j * 100, y: p.i * 100 }, { x: (p.j + 1) * 100, y: p.i * 100 },
    { x: (p.j + 1) * 100, y: (p.i + 1) * 100 }, { x: p.j * 100, y: (p.i + 1) * 100 }]
};
const token = () => ({ x: 1000, y: 1000, elevation: 0, depth: 2, rotation: 0, parent: { grid },
  getSize: () => ({ width: 300, height: 500 }),
  flags: { "fallout-maw": { tokenHitbox: { enabled: true } } } });

test("rotatable footprint fills the native three by five grid cells", () => {
  const document = token(), before = structuredClone(document.flags);
  assert.deepEqual(getTokenHitboxWorldBounds(document), { x: 1000, y: 1000, width: 300, height: 500 });
  assert.deepEqual(document.getSize(), { width: 300, height: 500 });
  assert.deepEqual(document.flags, before);
  const cells = getTokenHitboxGridCells(document);
  assert.equal(cells.length, 30, "Fifteen native cells at each of two elevation levels");
  assert.ok(cells.every(cell => cell.offset.i >= 10 && cell.offset.i < 15 && cell.offset.j >= 10 && cell.offset.j < 13));
  assert.ok(getTokenHitboxTestPoints(document).every(point => point.y >= 1000 && point.y <= 1500));
});

test("native rotation changes body bounds and occupied cells without changing the image frame", () => {
  const document = token(), zero = getTokenHitboxGeometry(document);
  assert.equal(getTokenHitboxGeometry(document), zero, "Unchanged geometry is cached");
  document.rotation = 90;
  const bounds = getTokenHitboxWorldBounds(document);
  assert.ok(Math.abs(bounds.width - 500) < 1e-6);
  assert.ok(Math.abs(bounds.height - 300) < 1e-6);
  assert.equal(bounds.x, 900);
  assert.equal(getTokenHitboxGridCells(document).length, 30, "Quarter turn still fills fifteen complete cells");
  assert.ok(getTokenHitboxGridCells(document).some(cell => cell.offset.j < 10), "Rotated body extends beyond the old frame");
  document.rotation = 45;
  const box = getTokenHitboxWorldBounds(document), cells = getTokenHitboxGridCells(document);
  const candidateCount = (Math.ceil((box.x + box.width) / 100) - Math.floor(box.x / 100))
    * (Math.ceil((box.y + box.height) / 100) - Math.floor(box.y / 100)) * 2;
  assert.ok(cells.length < candidateCount, "Empty corners of the broad-phase box do not occupy cells");
});

test("ordinary tokens opt out; locked rotation and prospective profile edits follow native fields", () => {
  const document = token();
  document.rotation = 90; document.lockRotation = true;
  assert.equal(getTokenHitboxWorldBounds(document).width, 300);
  assert.equal(getTokenHitboxWorldBounds(document, { lockRotation: false }).height, 300);
  assert.equal(getTokenHitboxGeometry(document, { flags: { "fallout-maw": { tokenHitbox: { enabled: false } } } }), null);
  assert.equal(getTokenHitboxWorldBounds(document, { flags: { "fallout-maw": { tokenHitbox: { y: 40, height: 50 } } } }).height, 500,
    "Legacy image crop settings cannot override native grid dimensions");
  delete document.flags["fallout-maw"].tokenHitbox;
  assert.equal(getTokenHitboxGeometry(document), null);
});
