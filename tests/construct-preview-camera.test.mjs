import test from "node:test";
import assert from "node:assert/strict";
import { ConstructPreviewCamera } from "../src/apps/construct-preview-camera.mjs";

function fixture(camera = new ConstructPreviewCamera(), options = {}) {
  const listeners = new Map(), classes = new Set(), captures = new Set();
  const frame = {
    clientHeight: 340,
    getBoundingClientRect: () => ({ left: 30, top: 100, width: 430, height: 340 }),
    addEventListener(name, callback, config) { listeners.set(name, { callback, config }); },
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id)
  };
  const preview = { style: {} }, output = {};
  camera.attach(frame, preview, { output, ...options });
  camera.fit(188, 314);
  function dispatch(name, fields = {}) {
    const event = { button: 0, pointerId: 1, clientX: 300, clientY: 200, deltaMode: 0, deltaY: 0,
      prevented: false, stopped: false, preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; }, ...fields };
    listeners.get(name).callback(event);
    return event;
  }
  function rect() {
    const width = parseFloat(preview.style.width), height = parseFloat(preview.style.height);
    const [x, y] = preview.style.transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g).map(Number);
    return { left: 245 + x - width / 2, top: 270 + y - height / 2, width, height };
  }
  function point(x, y) { const r = rect(); return { x: (x - r.left) / r.width, y: (y - r.top) / r.height }; }
  return { camera, frame, preview, output, classes, captures, listeners, dispatch, rect, point };
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`); }
function nearPoint(actual, expected) { near(actual.x, expected.x); near(actual.y, expected.y); }

test("wheel zoom keeps the exact model point under the cursor and consumes page scrolling", () => {
  const f = fixture(), before = f.point(300, 200);
  const event = f.dispatch("wheel", { deltaY: -300 });
  assert.ok(parseFloat(f.preview.style.width) > 188);
  nearPoint(f.point(300, 200), before);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(f.listeners.get("wheel").config.passive, false);
  f.dispatch("wheel", { deltaY: 300 });
  nearPoint(f.point(300, 200), before);
  near(f.rect().width, 188);
});

test("wheel bounds stay anchored at 25% and 800%, with line and page deltas supported", () => {
  const f = fixture(), before = f.point(300, 200);
  for (let i = 0; i < 8; i++) f.dispatch("wheel", { deltaY: -1000, deltaMode: 1 });
  assert.equal(f.output.textContent, "800%");
  nearPoint(f.point(300, 200), before);
  for (let i = 0; i < 12; i++) f.dispatch("wheel", { deltaY: 4, deltaMode: 2 });
  assert.equal(f.output.textContent, "25%");
  nearPoint(f.point(300, 200), before);
});

test("RMB pans the camera even outside the model and blocks anchor/aim handlers until release", () => {
  const f = fixture(), before = f.point(300, 200);
  const down = f.dispatch("pointerdown", { button: 2, clientX: 40, clientY: 110 });
  assert.equal(down.stopped, true);
  assert.equal(f.listeners.get("pointerdown").config.capture, true);
  assert.equal(f.camera.panning, true);
  assert.ok(f.captures.has(1));
  f.dispatch("pointermove", { clientX: 130, clientY: 175 });
  nearPoint(f.point(390, 265), before);
  assert.ok(f.classes.has("panning"));
  const zoom = f.camera.scaleLabel;
  f.dispatch("wheel", { deltaY: -200 });
  assert.equal(f.camera.scaleLabel, zoom);
  f.dispatch("pointerup", { button: 2 });
  assert.equal(f.camera.panning, false);
  assert.equal(f.captures.size, 0);
  assert.equal(f.classes.has("panning"), false);
});

test("LMB passes to anchor dragging, and camera navigation is suspended during that drag", () => {
  let anchorDragging = false;
  const f = fixture(undefined, { canNavigate: () => !anchorDragging });
  assert.equal(f.dispatch("pointerdown").stopped, false);
  assert.equal(f.camera.panning, false);
  anchorDragging = true;
  f.dispatch("wheel", { deltaY: -200 });
  f.dispatch("pointerdown", { button: 2 });
  assert.equal(f.camera.scaleLabel, "100%");
  assert.equal(f.camera.panning, false);
});

test("zoom after panning retains cursor coordinates; anchor movement uses the displayed model rectangle", () => {
  const f = fixture();
  f.dispatch("pointerdown", { button: 2 });
  f.dispatch("pointermove", { clientX: 360, clientY: 230 });
  f.dispatch("pointerup", { button: 2 });
  const before = f.point(290, 250);
  f.dispatch("wheel", { deltaY: -400, clientX: 290, clientY: 250 });
  nearPoint(f.point(290, 250), before);
  const moved = f.point(302, 243), r = f.rect();
  near(moved.x - before.x, 12 / r.width);
  near(moved.y - before.y, -7 / r.height);
});

test("rerender and resize preserve camera focus; fit reset restores centered 100% without a form render", () => {
  const f = fixture();
  f.dispatch("wheel", { deltaY: -400 });
  f.dispatch("pointerdown", { button: 2 });
  f.dispatch("pointermove", { clientX: 345, clientY: 230 });
  f.dispatch("pointerup", { button: 2 });
  const focus = f.point(245, 270), scale = f.camera.scaleLabel;
  const next = fixture(f.camera);
  nearPoint(next.point(245, 270), focus);
  assert.equal(next.camera.scaleLabel, scale);
  next.camera.fit(94, 157);
  nearPoint(next.point(245, 270), focus);
  next.camera.reset();
  assert.equal(next.output.textContent, "100%");
  nearPoint(next.point(245, 270), { x: .5, y: .5 });
  near(next.rect().width, 94);
});

test("cancel, lost capture, reset and dispose all release a captured pan without leaving the grabbing cursor", () => {
  for (const action of ["pointercancel", "lostpointercapture", "reset", "dispose"]) {
    const f = fixture();
    f.dispatch("pointerdown", { button: 2 });
    if (["reset", "dispose"].includes(action)) f.camera[action](); else f.dispatch(action);
    assert.equal(f.camera.panning, false);
    assert.equal(f.captures.size, 0);
    assert.equal(f.classes.has("panning"), false);
  }
});

test("the context menu is suppressed only in the preview frame", () => {
  const f = fixture(), event = f.dispatch("contextmenu");
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});
