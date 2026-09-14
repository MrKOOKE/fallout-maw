import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InventoryRenderBatch, runInventoryRenderBatch, registerInventoryRenderView,
  unregisterInventoryRenderView, beginInventoryContentsRender, completeInventoryContentsRender } from "../src/utils/inventory-render-batch.mjs";

function scrollElement(key, top, left = 0) {
  return { dataset: { searchScrollKey: key }, scrollTop: top, scrollLeft: left };
}

function windowFixture() {
  const batch = new InventoryRenderBatch();
  let scrolls = [scrollElement("searcher:inventory-stack", 540), scrollElement("searched:inventory-stack", 270),
    scrollElement("searcher:inventory-grid", 0, 180), scrollElement("searched:inventory-grid", 0, 80)];
  const application = {
    rendered: true,
    element: { isConnected: true, querySelectorAll: () => scrolls,
      ownerDocument: { defaultView: { requestAnimationFrame: callback => queueMicrotask(callback) } } },
    renders: [],
    async render(...args) {
      if (batch.defer(args)) return this;
      this.renders.push(args[0]);
      // Foundry replaces the DOM and restores focus during the async render.
      scrolls = scrolls.map(element => scrollElement(element.dataset.searchScrollKey, 0));
      await Promise.resolve();
      return this;
    }
  };
  return { batch, application, positions: () => scrolls.map(element => [element.scrollTop, element.scrollLeft]) };
}

test("a receiving client holds both actors until the complete document batch arrives and preserves scroll", async () => {
  const source = windowFixture(), target = windowFixture(), unrelated = windowFixture();
  const entries = [source, target, unrelated];
  const views = entries.map((entry, i) => ({ renderBatch: entry.batch,
    options: { application: entry.application }, zones: [{ actor: { uuid: `Actor.${i}` } }] }));
  views.forEach(registerInventoryRenderView);
  try {
    for (let index = 0; index < 4; index++) {
      const options = { falloutMawInventoryOperationId: "remote", falloutMawContentsActorUuids: ["Actor.0", "Actor.1"],
        falloutMawContentsOperationIndex: index, falloutMawContentsOperationCount: 4 };
      beginInventoryContentsRender(options);
      for (let i = 0; i < 10; i++) {
        await source.application.render({ parts: ["inventory"] });
        await target.application.render({ parts: ["inventory"] });
      }
      completeInventoryContentsRender(options);
      if (index < 3) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(source.application.renders.length, 0);
      assert.equal(target.application.renders.length, 0);
    }
    await new Promise(resolve => setTimeout(resolve, 15));
    for (const entry of [source, target]) {
      assert.equal(entry.application.renders.length, 1);
      assert.equal(entry.batch.active, false);
      assert.deepEqual(entry.positions(), [[540, 0], [270, 0], [0, 180], [0, 80]]);
    }
    assert.equal(unrelated.application.renders.length, 0);
  } finally { views.forEach(unregisterInventoryRenderView); }
});

test("received metadata never finishes the initiating client's existing render batch", async () => {
  const entry = windowFixture();
  const view = { renderBatch: entry.batch, options: { application: entry.application }, zones: [{ actor: { uuid: "Actor.local" } }] };
  registerInventoryRenderView(view);
  try {
    await runInventoryRenderBatch([entry], async () => {
      const options = { falloutMawInventoryOperationId: "local", falloutMawContentsActorUuids: ["Actor.local"],
        falloutMawContentsOperationIndex: 0, falloutMawContentsOperationCount: 1 };
      beginInventoryContentsRender(options);
      await entry.application.render({});
      completeInventoryContentsRender(options);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(entry.batch.active, true);
      assert.equal(entry.application.renders.length, 0);
    });
    assert.equal(entry.application.renders.length, 1);
  } finally { unregisterInventoryRenderView(view); }
});

test("many Item and hook requests produce one final render per window and preserve both scroll axes", async () => {
  const source = windowFixture(), target = windowFixture(), unrelated = windowFixture();
  let locks = 0;
  const entries = [source, target].map(entry => ({ ...entry, before: () => locks++, after: () => locks-- }));
  await runInventoryRenderBatch(entries, async () => {
    assert.equal(locks, 2);
    for (let index = 0; index < 20; index++) {
      await source.application.render({ parts: ["inventory"], renderContext: "updateItem" });
      await source.application.render({ parts: ["indicators"] });
      await target.application.render({ force: true });
    }
    assert.equal(source.application.renders.length, 0);
    assert.equal(target.application.renders.length, 0);
    await unrelated.application.render({ parts: ["inventory"] });
    assert.equal(unrelated.application.renders.length, 1);
  });
  assert.equal(locks, 0);
  assert.equal(source.application.renders.length, 1);
  assert.deepEqual(source.application.renders[0].parts, ["inventory", "indicators"]);
  assert.equal(target.application.renders.length, 1);
  assert.equal(target.application.renders[0].force, false, "automatic refresh must not bring the window to front");
  assert.deepEqual(source.positions(), [[540, 0], [270, 0], [0, 180], [0, 80]]);
  assert.deepEqual(target.positions(), source.positions());
});

test("full refresh is not narrowed by a later partial request", async () => {
  const entry = windowFixture();
  await runInventoryRenderBatch([entry], async () => {
    await entry.application.render({ parts: ["inventory"] });
    await entry.application.render(false, { renderContext: "updateActor" });
    await entry.application.render({ parts: ["indicators"] });
  });
  assert.equal(entry.application.renders[0].parts, undefined);
  assert.equal(entry.application.renders[0].renderContext, "updateActor");
});

test("partial transfer failure still restores windows and releases every lock", async () => {
  const source = windowFixture(), target = windowFixture();
  let ends = 0;
  await assert.rejects(runInventoryRenderBatch([source, target].map(entry => ({ ...entry, after: () => ends++ })), async () => {
    await source.application.render({ parts: ["inventory"] });
    throw new Error("transfer failed after an earlier item moved");
  }), /transfer failed/);
  assert.equal(ends, 2);
  assert.equal(source.batch.active, false);
  assert.equal(target.batch.active, false);
  assert.deepEqual(source.positions(), [[540, 0], [270, 0], [0, 180], [0, 80]]);
  await source.application.render({ parts: ["inventory"] });
  assert.equal(source.application.renders.length, 2, "normal updates resume after failure");
});

test("a closed loot window is not reopened by final refresh", async () => {
  const entry = windowFixture();
  let ended = false;
  await runInventoryRenderBatch([{ ...entry, after: () => { ended = true; } }], async () => {
    await entry.application.render({});
    entry.application.rendered = false;
    entry.application.element.isConnected = false;
  });
  assert.equal(entry.application.renders.length, 0);
  assert.equal(entry.batch.active, false);
  assert.equal(ended, true);
});

test("scroll positions follow stable container keys when a container disappears", async () => {
  const entry = windowFixture();
  const first = { dataset: { scrollKey: "container:first" }, scrollTop: 0, scrollLeft: 150, closest: () => null };
  const second = { dataset: { scrollKey: "container:second" }, scrollTop: 0, scrollLeft: 300, closest: () => null };
  let elements = [first, second];
  entry.application.element.querySelectorAll = () => elements;
  entry.application.render = async (...args) => {
    if (entry.batch.defer(args)) return entry.application;
    elements = [{ ...second, scrollLeft: 0 }];
    return entry.application;
  };
  await runInventoryRenderBatch([entry], async () => {});
  assert.equal(elements[0].scrollLeft, 300);
});

test("scrolling a nested grid cannot reset the actor's inventory tab position", async () => {
  const source = await readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8");
  const start = source.indexOf("\n  #onTabScroll(event)");
  const end = source.indexOf("\n  #restoreActiveTabScroll()", start);
  assert.ok(start >= 0 && end > start);
  const onScroll = Function(`return function ${source.slice(start, end).trim()
    .replace("#onTabScroll", "onTabScroll").replaceAll("this.#", "this.")}`)();
  const host = { tabScrollPositions: new Map() };
  const tab = { dataset: { tab: "inventory" }, scrollTop: 540, scrollLeft: 0, matches: () => false };
  tab.closest = () => tab;
  onScroll.call(host, { target: tab });
  onScroll.call(host, { target: { dataset: { scrollKey: "container:backpack" }, scrollTop: 0,
    scrollLeft: 180, closest: () => tab, matches: () => true } });
  onScroll.call(host, { target: { dataset: {}, scrollTop: 0,
    scrollLeft: 10, closest: () => tab, matches: () => false } });
  assert.deepEqual(host.tabScrollPositions.get("inventory"), { top: 540, left: 0 });
  assert.deepEqual(host.tabScrollPositions.get("inventory:container:backpack"), { top: 0, left: 180 });
});
