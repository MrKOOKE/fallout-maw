import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = { applications: { ux: { DragDrop: class {
  constructor(config) { Object.assign(this, config); }
} } } };
globalThis.game = { user: { isGM: true } };

const { getTooltipItemDragData, registerTooltipItemDrag } = await import("../src/utils/tooltip-item-drag.mjs");
const { FalloutMaWDragDrop } = await import("../src/utils/drag-drop.mjs");

test("world item references retain the standard Item UUID without mutating the source", () => {
  const item = {
    name: "Малая ракета", type: "item", system: { quantity: 10 },
    toDragData: () => ({ type: "Item", uuid: "Item.rocket" })
  };
  assert.deepEqual(getTooltipItemDragData(item), { type: "Item", uuid: "Item.rocket" });
  assert.equal(item.system.quantity, 10);
  assert.equal(getTooltipItemDragData(item, { isGM: false }), null);
  assert.equal(getTooltipItemDragData(null), null);
});

test("installed snapshots are independent copies with no original document ID", () => {
  const item = { _id: "installed", name: "Модуль", type: "item", system: { quantity: 1 } };
  const payload = getTooltipItemDragData(item);
  assert.equal(payload.type, "Item");
  assert.equal(payload.data._id, undefined);
  payload.data.system.quantity = 2;
  assert.equal(item.system.quantity, 1);
  assert.equal(item._id, "installed");
});

test("delegated tooltip drags work after refresh, enforce GM access, and keep both drop formats", () => {
  const handlers = new Map();
  const scheduled = [];
  const bodyClasses = new Set();
  const document = {
    body: { classList: { add: value => bodyClasses.add(value), remove: value => bodyClasses.delete(value) } },
    addEventListener: (type, handler) => handlers.set(type, handler),
    defaultView: { setTimeout: callback => scheduled.push(callback) }
  };
  let controller;
  let capturedSource;
  const original = FalloutMaWDragDrop.prototype.startPointerDrag;
  FalloutMaWDragDrop.prototype.startPointerDrag = function (_event, source) {
    controller = this;
    capturedSource = source;
  };
  try {
    registerTooltipItemDrag(document);
    const downHandler = handlers.get("pointerdown");
    registerTooltipItemDrag(document);
    assert.equal(handlers.get("pointerdown"), downHandler);
    const source = { dataset: { tooltipDragItem: JSON.stringify({ type: "Item", uuid: "Item.rocket" }) } };
    let stopped = false;
    const event = {
      button: 0, target: { closest: () => source },
      stopImmediatePropagation: () => { stopped = true; }
    };
    game.user.isGM = false;
    downHandler(event);
    assert.equal(controller, undefined);
    assert.equal(stopped, false);
    game.user.isGM = true;
    downHandler(event);
    assert.equal(capturedSource, source);
    assert.equal(stopped, true);
    const data = new Map();
    const transfer = { setData: (type, payload) => data.set(type, payload) };
    controller.callbacks.dragstart({ currentTarget: source, dataTransfer: transfer });
    assert.deepEqual(JSON.parse(data.get("application/json")), { type: "Item", uuid: "Item.rocket" });
    assert.equal(data.get("text/plain"), data.get("application/json"));
    assert.equal(transfer.effectAllowed, "copy");
    assert.equal(bodyClasses.has("fallout-maw-tooltip-item-dragging"), true);
    let prevented = false;
    handlers.get("click")({ preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} });
    assert.equal(prevented, true);
    controller.callbacks.dragend();
    assert.equal(bodyClasses.size, 0);
    scheduled.forEach(callback => callback());
    prevented = false;
    handlers.get("click")({ preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} });
    assert.equal(prevented, false);
  } finally {
    FalloutMaWDragDrop.prototype.startPointerDrag = original;
    game.user.isGM = true;
  }
});
