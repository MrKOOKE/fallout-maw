import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/apps/search-inventory.mjs", import.meta.url), "utf8");
const start = source.indexOf("\n  #bindInventoryTooltipKeyMode()");
const end = source.indexOf("\n  #clearInventoryTooltip(", start);
const methods = source.slice(start, end).replaceAll("this.#", "this.").replaceAll("#bind", "bind").replaceAll("#unbind", "unbind");
const Host = Function(`return class { ${methods} }`)();

function fixture() {
  const listeners = new Map(), windowListeners = new Map();
  const view = {
    document: { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) },
    addEventListener: (key, fn) => windowListeners.set(key, fn), removeEventListener: key => windowListeners.delete(key)
  };
  const host = new Host();
  const refreshes = [];
  Object.assign(host, { element: { ownerDocument: { defaultView: view } }, tooltipBaseMode: false,
    tooltipCompareMode: false, tooltipAnchorElement: {}, tooltipElement: {}, tooltipTimer: null,
    showInventoryTooltip: (_anchor, options) => refreshes.push([host.tooltipBaseMode, host.tooltipCompareMode, options.refresh]) });
  host.bindInventoryTooltipKeyMode();
  return { host, listeners, windowListeners, refreshes,
    key: (key, type = "keydown") => listeners.get(type)({ key, type }) };
}

test("trade Alt toggles base values, Ctrl comparison stays independent, repeated keys do not rerender", () => {
  const f = fixture();
  f.key("Alt"); f.key("Alt"); f.key("Control"); f.key("Alt", "keyup"); f.key("Control", "keyup");
  assert.deepEqual(f.refreshes, [[true, false, true], [true, true, true], [false, true, true], [false, false, true]]);
  f.key("Shift"); assert.equal(f.refreshes.length, 4);
});

test("Alt during the hover delay is remembered without opening early, and refreshes an in-flight render", () => {
  const f = fixture(); f.host.tooltipElement = null; f.host.tooltipTimer = 5;
  f.key("Alt"); assert.equal(f.host.tooltipBaseMode, true); assert.equal(f.refreshes.length, 0);
  f.host.tooltipTimer = null; f.key("Alt", "keyup");
  assert.deepEqual(f.refreshes, [[false, false, true]]);
});

test("window blur resets modifiers and closing removes key and blur listeners", () => {
  const f = fixture(); f.key("Alt"); f.key("Control");
  f.windowListeners.get("blur")();
  assert.deepEqual(f.refreshes.at(-1), [false, false, true]);
  f.host.unbindInventoryTooltipKeyMode();
  assert.equal(f.listeners.size, 0); assert.equal(f.windowListeners.size, 0);
});

test("hover and pinned trade tooltips pass Alt to the renderer and discard stale async generations", () => {
  const hover = source.slice(source.indexOf("\n  #onInventoryTooltipPointerOver("), source.indexOf("\n  #restoreInventoryTooltipAfterRender("));
  assert.match(hover, /baseMode: this\.#tooltipBaseMode/);
  assert.match(hover, /this\.#tooltipBaseMode = Boolean\(event\.altKey\)/);
  assert.match(hover, /generation !== this\.#tooltipRenderGeneration/);
});
