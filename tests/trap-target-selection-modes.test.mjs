import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { changedDataIntersectsPaths } from "../src/utils/document-change-paths.mjs";

const TRAPS_SOURCE = readFileSync(
  new URL("../src/canvas/traps.mjs", import.meta.url),
  "utf8"
);

test("every trap canvas mode releases the previous lifecycle owner before validation", () => {
  assertBefore(
    sourceBetween("export async function startTrapPlacement", "export async function startWorldTrapPlacement"),
    "cancelActiveCanvasTargetSelection(",
    "const sourceActor"
  );
  assertBefore(
    sourceBetween("export async function startWorldTrapPlacement", "export function getWorldTrapPlacementState"),
    "cancelActiveCanvasTargetSelection(",
    "if (!game.user?.isGM"
  );
  assertBefore(
    sourceBetween("export function startTrapInteractionMode", "function collectTrapMovementInterruptions"),
    "cancelActiveCanvasTargetSelection(",
    "const sourceActor"
  );
  assertBefore(
    sourceBetween("function waitForTrapLinkedActorSelection", "function onTrapLinkedActorCanvasEvent"),
    "cancelActiveCanvasTargetSelection(",
    "if (!canvas?.ready"
  );

  assert.match(TRAPS_SOURCE, /kind:\s*placement\.mode === "world" \? "trapWorldPlacement" : "trapPlacement"/);
  assert.match(TRAPS_SOURCE, /kind:\s*"trapInteraction"/);
  assert.match(TRAPS_SOURCE, /kind:\s*"trapLinkedActorSelection"/);
});

test("trap mode owner cancellation is immediate and each cleanup is idempotent", () => {
  const unbindInput = sourceBetween("function unbindTrapCanvasInput", "function stopTrapCanvasInputEvent");
  assert.doesNotMatch(unbindInput, /setTimeout|delay\s*=/);
  assert.match(unbindInput, /removeEventListener\(type, binding\.listener, true\)/);
  assert.match(unbindInput, /shield\?\.remove\?\.\(\)/);

  const placementCleanup = sourceBetween("function cancelActiveTrapPlacement", "function createTrapCanvasInputShield");
  assert.match(placementCleanup, /if \(!placement \|\| placement\.cleaned\) return false/);
  assert.match(placementCleanup, /placement\.cleaned = true/);
  assert.match(placementCleanup, /destroyTrapPlacementPreview\(placement\)/);
  assert.match(placementCleanup, /placement\.targetSelectionSession\?\.finish/);

  const interactionCleanup = sourceBetween("function cancelTrapInteractionMode", "function getActiveTrapInteractionActor");
  assert.match(interactionCleanup, /if \(!interaction \|\| interaction\.cleaned\)/);
  assert.match(interactionCleanup, /interaction\.cleaned = true/);
  assert.match(interactionCleanup, /interaction\.targetSelectionSession\?\.finish/);

  const linkedCleanup = sourceBetween("function cleanupTrapLinkedActorSelection", "function getTrapLinkedActorTokenAtEvent");
  assert.match(linkedCleanup, /if \(!selection \|\| selection\.cleaned\) return false/);
  assert.match(linkedCleanup, /globalThis\.clearTimeout/);
  assert.match(linkedCleanup, /Hooks\.off/);
  assert.match(linkedCleanup, /selection\.overlay\.destroy\(\{ children: true \}\)/);

  const preview = sourceBetween("async function createTrapPlacementPreview", "function updateTrapPlacementPreview");
  assert.match(preview, /if \(placement\.cleaned \|\| activeTrapPlacement !== placement\)/);
  assertBefore(preview, "if (placement.cleaned || activeTrapPlacement !== placement)", "layer.addChild(container)");
});

test("linked-actor selection follows Foundry token hooks and flushes before committing a click", () => {
  const hookBinding = sourceBetween("function bindTrapLinkedActorSelectionHooks", "function queueTrapLinkedActorHighlightRefresh");
  for (const hook of ["refreshToken", "updateToken", "moveToken", "createToken", "drawToken", "deleteToken", "destroyToken"]) {
    assert.match(hookBinding, new RegExp(`bindHook\\("${hook}"`));
  }
  assert.match(hookBinding, /changedDataIntersectsPaths\(changes, TRAP_LINKED_ACTOR_TOKEN_PATHS\)/);
  assert.match(TRAPS_SOURCE, /const TRAP_LINKED_ACTOR_REFRESH_DELAY_MS = 50/);

  const click = sourceBetween("function onTrapLinkedActorCanvasEvent", "function onTrapLinkedActorKeyDown");
  assertBefore(click, "selection.pendingFullRefresh = true", "flushTrapLinkedActorHighlights(selection)");
  assertBefore(click, "flushTrapLinkedActorHighlights(selection)", "getTrapLinkedActorTokenAtEvent(event, selection)");
});

test("world placement hands lifecycle ownership to linked-actor selection through its action dialog", () => {
  const suspension = sourceBetween("function suspendTrapPlacement", "function resumeTrapPlacement");
  assert.match(suspension, /Hooks\.on\(CANVAS_TARGET_SELECTION_STARTED_HOOK/);
  assert.match(suspension, /context\?\.parentPlacementHandoffId === placement\.linkedActorHandoffId/);
  assert.match(suspension, /reason:\s*"supersededDuringLinkedAction"/);

  const resume = sourceBetween("function resumeTrapPlacement", "function clearTrapPlacementLinkedActorHandoff");
  assertBefore(
    resume,
    "clearTrapPlacementLinkedActorHandoff(placement)",
    "startTrapPlacementTargetSelectionSession(placement)"
  );

  const linkedAction = sourceBetween("async function selectTrapLinkedAction", "function waitForTrapLinkedActorSelection");
  assertBefore(linkedAction, "linkedAction = await dialog.wait()", "finishTrapLinkedActorSelection(");
  const linkedClick = sourceBetween("function onTrapLinkedActorCanvasEvent", "function onTrapLinkedActorKeyDown");
  assert.match(linkedClick, /selectTrapLinkedActorToken\(token, selection\)/);
  assert.doesNotMatch(linkedClick, /finishTrapLinkedActorSelection\(token/);
});

test("linked-actor highlight runtime updates one Token, coalesces bursts, and removes deleted Tokens", () => {
  const callbacks = new Map();
  let hookSequence = 0;
  const Hooks = {
    on(name, callback) {
      callbacks.set(name, callback);
      hookSequence += 1;
      return hookSequence;
    }
  };
  const timers = new Map();
  let timerSequence = 0;
  const timerRuntime = {
    setTimeout(callback, delay) {
      timerSequence += 1;
      timers.set(timerSequence, { callback, delay });
      return timerSequence;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  };
  let legacyLayerClears = 0;
  const canvas = {
    scene: { id: "scene-a" },
    tokens: { placeables: [] },
    interface: {
      grid: {
        clearHighlightLayer() {
          legacyLayerClears += 1;
        }
      }
    },
    dimensions: { uiScale: 1 }
  };
  const CONFIG = {
    Canvas: { objectBorderThickness: 4 }
  };
  const PIXI = {
    Graphics: FakeGraphics
  };
  const helpers = compileLinkedActorHighlightHelpers({
    Hooks,
    changedDataIntersectsPaths,
    canvas,
    PIXI,
    CONFIG,
    timerRuntime
  });
  const first = createToken("Scene.scene-a.Token.first", 10, 20);
  const second = createToken("Scene.scene-a.Token.second", 100, 120);
  canvas.tokens.placeables.push(first, second);
  const selection = createSelection();

  helpers.refreshTrapLinkedActorHighlights(selection);
  assert.equal(selection.graphicsByTokenUuid.size, 2);
  assert.equal(selection.tokensByUuid.size, 2);
  assert.notEqual(
    selection.graphicsByTokenUuid.get(first.document.uuid),
    selection.graphicsByTokenUuid.get(second.document.uuid),
    "each Token must own an independently replaceable highlight"
  );
  assert.equal(legacyLayerClears, 1);

  helpers.bindTrapLinkedActorSelectionHooks(selection);
  const firstGraphic = selection.graphicsByTokenUuid.get(first.document.uuid);
  const firstDrawCount = firstGraphic.drawCount;
  first.bounds = createBounds(35, 45);
  callbacks.get("refreshToken")(first, { refreshPosition: true });
  assert.deepEqual(
    [firstGraphic.position.x, firstGraphic.position.y],
    [35, 45],
    "refreshToken must move the affected highlight immediately"
  );
  assert.deepEqual(firstGraphic.lastRect, [0, 0, 20, 30]);
  assert.equal(firstGraphic.drawCount, firstDrawCount, "position-only animation must not rebuild geometry");
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 50);

  callbacks.get("moveToken")(first.document);
  callbacks.get("moveToken")(first.document);
  assert.equal(timers.size, 1, "movement bursts must share one fixed coalescing window");
  runOnlyTimer(timers);
  assert.equal(selection.graphicsByTokenUuid.size, 2);

  callbacks.get("updateToken")(first.document, {
    system: { resources: { health: { value: 1 } } }
  });
  assert.equal(timers.size, 0, "unrelated Actor-style data must not queue a Token highlight refresh");
  callbacks.get("updateToken")(first.document, { x: 50 });
  assert.equal(timers.size, 1, "a relevant exact Token delta must queue reconciliation");
  runOnlyTimer(timers);

  callbacks.get("deleteToken")(second.document);
  assert.equal(
    selection.graphicsByTokenUuid.has(second.document.uuid),
    false,
    "deleteToken must remove the stale highlight before the coalesced pass"
  );
  runOnlyTimer(timers);

  const third = createToken("Scene.scene-a.Token.third", 200, 220);
  canvas.tokens.placeables = [first, third];
  callbacks.get("createToken")(third.document);
  callbacks.get("drawToken")(third);
  assert.equal(timers.size, 1);
  runOnlyTimer(timers);
  assert.equal(selection.graphicsByTokenUuid.has(third.document.uuid), true);
  assert.equal(selection.graphicsByTokenUuid.has(second.document.uuid), false);
});

test("linked-actor cleanup releases every resource once", () => {
  const cleanupSource = sourceBetween(
    "function cleanupTrapLinkedActorSelection",
    "function getTrapLinkedActorTokenAtEvent"
  );
  let unbindCalls = 0;
  let keydownRemovals = 0;
  let hookRemovals = 0;
  let timerClears = 0;
  let legacyClears = 0;
  const factory = new Function(
    "Hooks",
    "globalThis",
    "unbindTrapCanvasInput",
    "window",
    "clearLegacyTrapLinkedActorHighlightLayer",
    `
      let activeTrapLinkedActorSelection = null;
      function onTrapLinkedActorKeyDown() {}
      ${cleanupSource}
      return {
        setActive(value) { activeTrapLinkedActorSelection = value; },
        getActive() { return activeTrapLinkedActorSelection; },
        cleanupTrapLinkedActorSelection
      };
    `
  );
  const runtime = factory(
    { off: () => { hookRemovals += 1; } },
    { clearTimeout: () => { timerClears += 1; } },
    () => { unbindCalls += 1; },
    { removeEventListener: () => { keydownRemovals += 1; } },
    () => { legacyClears += 1; }
  );
  const overlayParent = new FakeContainer();
  const overlay = overlayParent.addChild(new FakeContainer());
  const selection = {
    cleaned: false,
    refreshTimerId: 9,
    pendingFullRefresh: true,
    pendingChangedTokens: new Map([["a", {}]]),
    pendingRemovedTokenUuids: new Set(["b"]),
    hookBindings: [["refreshToken", 1], ["moveToken", 2]],
    overlay,
    graphicsByTokenUuid: new Map([["a", {}]]),
    tokensByUuid: new Map([["a", {}]]),
    targetSelectionSession: {}
  };
  runtime.setActive(selection);

  assert.equal(runtime.cleanupTrapLinkedActorSelection(selection), true);
  assert.equal(runtime.cleanupTrapLinkedActorSelection(selection), false);
  assert.equal(timerClears, 1);
  assert.equal(hookRemovals, 2);
  assert.equal(unbindCalls, 1);
  assert.equal(keydownRemovals, 1);
  assert.equal(legacyClears, 1);
  assert.equal(overlay.destroyed, true);
  assert.equal(runtime.getActive(), null);
});

function compileLinkedActorHighlightHelpers({
  Hooks,
  changedDataIntersectsPaths,
  canvas,
  PIXI,
  CONFIG,
  timerRuntime
}) {
  const helperSource = sourceBetween(
    "function bindTrapLinkedActorSelectionHooks",
    "class TrapLinkedActionDialog"
  );
  const factory = new Function(
    "Hooks",
    "changedDataIntersectsPaths",
    "canvas",
    "PIXI",
    "CONFIG",
    "globalThis",
    `
      const TRAP_LINKED_ACTOR_REFRESH_DELAY_MS = 50;
      const TRAP_LINKED_ACTOR_TOKEN_PATHS = [
        "x", "y", "elevation", "width", "height", "depth", "hidden",
        "actorId", "actorLink", "texture.scaleX", "texture.scaleY"
      ];
      const TRAP_LINKED_ACTOR_HIGHLIGHT_LAYER = "fallout-maw-linked-actor-tokens";
      const TRAP_LINKED_ACTOR_HIGHLIGHT_COLOR = 0xe34fcb;
      let activeTrapLinkedActorSelection = null;
      ${helperSource}
      return {
        bindTrapLinkedActorSelectionHooks,
        flushTrapLinkedActorHighlights,
        refreshTrapLinkedActorHighlights
      };
    `
  );
  return factory(Hooks, changedDataIntersectsPaths, canvas, PIXI, CONFIG, timerRuntime);
}

function createSelection() {
  return {
    sceneId: "scene-a",
    overlay: new FakeContainer(),
    graphicsByTokenUuid: new Map(),
    tokensByUuid: new Map(),
    hookBindings: [],
    refreshTimerId: null,
    pendingFullRefresh: false,
    pendingChangedTokens: new Map(),
    pendingRemovedTokenUuids: new Set(),
    cleaned: false
  };
}

function createToken(uuid, x, y) {
  const document = {
    uuid,
    parent: { id: "scene-a" },
    object: null
  };
  const token = {
    document,
    actor: {},
    visible: true,
    renderable: true,
    bounds: createBounds(x, y),
    x,
    y,
    _lastSortedIndex: 0
  };
  document.object = token;
  return token;
}

function createBounds(x, y) {
  return {
    x,
    y,
    width: 20,
    height: 30,
    contains(px, py) {
      return px >= x && px <= x + 20 && py >= y && py <= y + 30;
    }
  };
}

function runOnlyTimer(timers) {
  assert.equal(timers.size, 1);
  const [id, entry] = [...timers.entries()][0];
  timers.delete(id);
  entry.callback();
}

function sourceBetween(startMarker, endMarker) {
  const start = TRAPS_SOURCE.indexOf(startMarker);
  const end = TRAPS_SOURCE.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source range: ${startMarker}`);
  return TRAPS_SOURCE.slice(start, end);
}

function assertBefore(source, first, second) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.ok(firstIndex >= 0, `missing marker: ${first}`);
  assert.ok(secondIndex >= 0, `missing marker: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must occur before ${second}`);
}

class FakeContainer {
  constructor() {
    this.children = [];
    this.parent = null;
    this.destroyed = false;
    this.position = {
      x: 0,
      y: 0,
      set: (x, y) => {
        this.position.x = x;
        this.position.y = y;
      }
    };
  }

  addChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    return child;
  }

  destroy({ children = false } = {}) {
    if (children) {
      for (const child of [...this.children]) child.destroy?.();
      this.children.length = 0;
    }
    this.destroyed = true;
  }
}

class FakeGraphics extends FakeContainer {
  constructor() {
    super();
    this.lastRect = null;
    this.drawCount = 0;
  }

  clear() {
    this.lastRect = null;
    return this;
  }

  lineStyle() {
    return this;
  }

  drawRect(...rect) {
    this.lastRect = rect;
    this.drawCount += 1;
    return this;
  }
}
