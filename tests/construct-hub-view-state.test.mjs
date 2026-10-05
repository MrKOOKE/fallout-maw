import test from "node:test";
import assert from "node:assert/strict";
import { captureConstructHubView, restoreConstructHubView } from "../src/apps/construct-hub-view-state.mjs";

function fixture({ open = true, top = 200, fieldY = 260, focus = true } = {}) {
  const detail = { dataset: { hubDetails: "advanced" }, open };
  const pane = {
    _top: top, scrollLeft: 0, style: { paddingBottom: "0px" }, clientHeight: 300,
    get scrollHeight() { return 300 + (detail.open ? 600 : 0) + parseFloat(this.style.paddingBottom); },
    get scrollTop() { return this._top; },
    set scrollTop(value) { this._top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    contains: element => element === field,
    getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
    querySelectorAll: () => [field]
  };
  const field = {
    tagName: "INPUT", attributes: [{ name: "data-visual-key", value: "x" }], selectionStart: 1, selectionEnd: 2,
    getClientRects: () => [1], getBoundingClientRect: () => ({ top: 100 + fieldY - pane.scrollTop, bottom: 130 + fieldY - pane.scrollTop }),
    focus: options => { field.focusOptions = options; },
    setSelectionRange: (...args) => { field.selection = args; }
  };
  const root = {
    ownerDocument: { activeElement: focus ? field : null }, contains: element => element === field,
    querySelector: selector => selector === ".construct-hub-inspector" ? pane : null,
    querySelectorAll: selector => selector === "details" ? [detail] : [field]
  };
  return { root, pane, field, detail };
}

test("restore disclosures before scroll ranges and preserve focused input without browser auto-scroll", () => {
  const old = fixture(), next = fixture({ open: false, top: 0 });
  restoreConstructHubView(next.root, captureConstructHubView(old.root));
  assert.equal(next.detail.open, true);
  assert.equal(next.pane.scrollTop, 200);
  assert.deepEqual(next.field.focusOptions, { preventScroll: true });
  assert.deepEqual(next.field.selection, [1, 2]);
});

test("a field stays in place when new content above it changes height", () => {
  const old = fixture(), next = fixture({ fieldY: 340, top: 0 });
  restoreConstructHubView(next.root, captureConstructHubView(old.root));
  assert.equal(next.pane.scrollTop, 280);
  assert.equal(next.field.getBoundingClientRect().top, old.field.getBoundingClientRect().top);
});

test("scroll is captured at the latest replacement and a pane at the top stays at the top", () => {
  const old = fixture({ top: 100 }), next = fixture({ top: 0 });
  old.pane.scrollTop = 260;
  restoreConstructHubView(next.root, captureConstructHubView(old.root));
  assert.equal(next.pane.scrollTop, 260);
  const fresh = fixture({ top: 0 });
  restoreConstructHubView(fresh.root, captureConstructHubView(fixture({ top: 0 }).root));
  assert.equal(fresh.pane.scrollTop, 0);
});

test("a requested disclosure override wins and an absent focused field does not break scrolling", () => {
  const old = fixture(), next = fixture({ focus: false, top: 0 });
  next.root.querySelectorAll = selector => selector === "details" ? [next.detail] : [];
  next.pane.querySelectorAll = () => [];
  restoreConstructHubView(next.root, captureConstructHubView(old.root), new Map([["advanced", false]]));
  assert.equal(next.detail.open, false);
  assert.equal(next.pane.scrollTop, 0);
});

test("collapsing content below a working field retains its position instead of clamping scroll to the new end", () => {
  const old = fixture(), next = fixture({ top: 0 });
  next.detail.open = false;
  restoreConstructHubView(next.root, captureConstructHubView(old.root), new Map([["advanced", false]]));
  assert.equal(next.detail.open, false);
  assert.equal(next.pane.scrollTop, 200);
  assert.equal(next.field.getBoundingClientRect().top, old.field.getBoundingClientRect().top);
  assert.equal(next.pane.style.paddingBottom, "200px");
});

test("controls inside closed disclosures cannot become scroll anchors even when the browser reports cached rectangles", () => {
  const old = fixture({ focus: false }), next = fixture({ fieldY: 340, top: 0, focus: false });
  old.field.parentElement = { tagName: "DETAILS", open: false, querySelector: () => ({ contains: () => false }) };
  const view = captureConstructHubView(old.root);
  assert.equal(view.scroll[0].anchor, undefined);
  restoreConstructHubView(next.root, view);
  assert.equal(next.pane.scrollTop, 200);
});
