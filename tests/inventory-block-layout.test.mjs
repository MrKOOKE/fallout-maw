import assert from "node:assert/strict";
import test from "node:test";
import { InventoryBlockLayout, packInventoryBlockRows } from "../src/utils/inventory-block-layout.mjs";

test("a small later block fills an earlier row without splitting either block", () => {
  assert.deepEqual(packInventoryBlockRows([600, 500, 280, 390], 1000, 10), [
    { row: 0, width: 600 }, { row: 1, width: 500 },
    { row: 0, width: 280 }, { row: 1, width: 390 }
  ]);
});

test("exact fits include gaps and fractional widths never overflow", () => {
  assert.deepEqual(packInventoryBlockRows([300, 390, 300], 1000, 10).map(p => p.row), [0, 0, 1]);
  assert.deepEqual(packInventoryBlockRows([300, 390, 290], 1000, 10).map(p => p.row), [0, 0, 0]);
  assert.deepEqual(packInventoryBlockRows([100.2, 100.2], 210.3, 10).map(p => p.row), [0, 1]);
  assert.deepEqual(packInventoryBlockRows([100.2, 100.2], 210.4, 10).map(p => p.row), [0, 0]);
});

test("wide blocks use the available width and reclaim it after expansion", () => {
  const widths = [1200, 200, 300];
  assert.deepEqual(packInventoryBlockRows(widths, 600, 10), [
    { row: 0, width: 600 }, { row: 1, width: 200 }, { row: 1, width: 300 }
  ]);
  assert.deepEqual(packInventoryBlockRows(widths, 1800, 10).map(p => p.row), [0, 0, 0]);
  assert.deepEqual(widths, [1200, 200, 300]);
  assert.deepEqual(packInventoryBlockRows([], 600, 10), []);
});

test("mixed inventories preserve all blocks and never overfill a row", () => {
  for (const capacity of [160, 320, 768, 1024, 1600]) {
    const widths = Array.from({ length: 80 }, (_, i) => 80 + ((i * 137) % 1100));
    const result = packInventoryBlockRows(widths, capacity, 14);
    assert.equal(result.length, widths.length);
    const used = new Map();
    for (const { row, width } of result) {
      used.set(row, (used.has(row) ? used.get(row) + 14 : 0) + width);
      assert.ok(used.get(row) <= capacity);
    }
  }
});

test("resize work is coalesced, hidden tabs wait, and rebind/close release observers", () => {
  const frames = new Map();
  const observers = [];
  const events = new Set();
  let serial = 0;
  const layoutElement = { clientWidth: 500 };
  const fonts = {
    addEventListener: (name, fn) => events.add(fn),
    removeEventListener: (name, fn) => events.delete(fn)
  };
  const view = {
    requestAnimationFrame: fn => { frames.set(++serial, fn); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    }
  };
  const root = {
    isConnected: true, clientWidth: 0,
    ownerDocument: { defaultView: view, fonts },
    querySelectorAll: () => [layoutElement],
    addEventListener() {}, removeEventListener() {}
  };
  const controller = new InventoryBlockLayout();
  controller.bind(root);
  assert.equal(frames.size, 0);
  layoutElement.clientWidth = 600;
  observers[0].callback([{ target: layoutElement }]);
  observers[0].callback([{ target: layoutElement }]);
  assert.equal(frames.size, 1);
  controller.bind(root);
  assert.equal(observers[0].disconnected, true);
  assert.equal(frames.size, 0);
  assert.equal(events.size, 1);
  controller.destroy();
  assert.equal(observers[1].disconnected, true);
  assert.equal(events.size, 0);
});
