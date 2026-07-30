import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actorContainerSource = await readFile(
  new URL("../src/canvas/actor-containers.mjs", import.meta.url),
  "utf8"
);
const lightNetworkSource = await readFile(
  new URL("../src/canvas/light-networks.mjs", import.meta.url),
  "utf8"
);

test("actor-container placement modes join the shared target-selection lifecycle", () => {
  const boardingStart = getSourceSection(
    actorContainerSource,
    "export function startActorContainerBoardingMode",
    "export function startActorContainerPassengerExitPlacement"
  );
  const exitStart = getSourceSection(
    actorContainerSource,
    "export function startActorContainerPassengerExitPlacement",
    "export function prepareHudActorContainerPassengers"
  );
  const boardingFinish = getSourceSection(
    actorContainerSource,
    "async function onBoardingPointerDown",
    "function onBoardingCanvasEvent"
  );
  const exitFinish = getSourceSection(
    actorContainerSource,
    "function onExitPlacementCanvasEvent",
    "function onExitPlacementKeyDown"
  );

  assertBefore(boardingStart, "cancelActiveCanvasTargetSelection", "const passengerActor");
  assertBefore(exitStart, "cancelActiveCanvasTargetSelection", "const passenger");
  assert.match(boardingStart, /cancelActorContainerExitPlacement\(\)/);
  assert.match(exitStart, /cancelActorContainerBoardingMode\(\)/);
  assert.match(boardingStart, /kind:\s*"actorContainerBoarding"/);
  assert.match(exitStart, /kind:\s*"actorContainerExitPlacement"/);
  assert.match(boardingStart, /onCancel:[\s\S]*?cancelActorContainerBoardingMode\([\s\S]*?fromLifecycle:\s*true/);
  assert.match(exitStart, /onCancel:[\s\S]*?cancelActorContainerExitPlacement\([\s\S]*?fromLifecycle:\s*true/);
  assert.match(boardingStart, /targetSelectionSession\.finished\s*\|\|\s*activeBoardingMode !== mode/);
  assert.match(exitStart, /targetSelectionSession\.finished\s*\|\|\s*activeExitPlacement !== placement/);
  assert.match(boardingFinish, /cancelActorContainerBoardingMode\(\{\s*mode,\s*cancelled:\s*false\s*\}\)/);
  assert.match(exitFinish, /cancelActorContainerExitPlacement\(\{\s*placement:\s*session,\s*cancelled:\s*false\s*\}\)/);
});

test("actor-container placement cleanup is immediate, idempotent, and uses public canvas layers", () => {
  const boardingCancel = getSourceSection(
    actorContainerSource,
    "function cancelActorContainerBoardingMode",
    "function onExitPlacementCanvasEvent"
  );
  const exitCancel = getSourceSection(
    actorContainerSource,
    "function cancelActorContainerExitPlacement",
    "function refreshActorContainerHighlights"
  );
  const unbind = getSourceSection(
    actorContainerSource,
    "function unbindCanvasInput",
    "function stopCanvasInputEvent"
  );

  assert.match(boardingCancel, /if \(mode\.cleaned\)/);
  assert.match(boardingCancel, /mode\.cleaned = true/);
  assert.match(boardingCancel, /clearActorContainerHighlightRefresh\(mode\)/);
  assert.match(boardingCancel, /window\.removeEventListener\("keydown", onBoardingKeyDown/);
  assert.match(boardingCancel, /targetSelectionSession\?\.finish/);
  assert.match(exitCancel, /if \(placement\.cleaned\)/);
  assert.match(exitCancel, /placement\.cleaned = true/);
  assert.match(exitCancel, /destroyActorContainerExitPreview\(placement\)/);
  assert.match(exitCancel, /window\.removeEventListener\("keydown", onExitPlacementKeyDown/);
  assert.match(exitCancel, /targetSelectionSession\?\.finish/);
  assert.match(unbind, /removeEventListener\(type, binding\.listener, true\)/);
  assert.match(unbind, /shield\?\.remove\?\.\(\)/);
  assert.doesNotMatch(unbind, /setTimeout/);
  assert.doesNotMatch(actorContainerSource, /_rulerPaths/);
  assert.match(actorContainerSource, /canvas\?\.interface\?\.addChild \? canvas\.interface : canvas\?\.stage/);
});

test("boarding highlight refresh is addressed, coalesced, and follows live token bounds", async () => {
  const hookCallbacks = new Map();
  const view = new MockEventTarget();
  const windowTarget = new MockEventTarget();
  const shields = [];
  const highlightLayer = new MockHighlightLayer();
  const gridInterface = {
    getHighlightLayer: () => highlightLayer,
    addHighlightLayer: () => highlightLayer
  };
  const passengerActor = {
    uuid: "Actor.passenger",
    isOwner: true,
    system: {},
    getFlag: () => ({})
  };
  const passengerToken = {
    id: "passenger-token",
    uuid: "Scene.scene.Token.passenger-token",
    width: 1,
    height: 1
  };
  const vehicleActor = {
    uuid: "Actor.vehicle",
    items: {
      contents: [{
        id: "vehicle-seats",
        name: "Seats",
        type: "gear",
        system: {
          functions: {
            actorContainer: {
              enabled: true,
              slots: [{
                id: "seat",
                width: 2,
                height: 2,
                quantity: 1
              }]
            }
          }
        }
      }]
    },
    getFlag: () => ({})
  };
  const vehicleToken = {
    actor: vehicleActor,
    visible: true,
    renderable: true,
    bounds: { x: 10, y: 20, width: 100, height: 100 }
  };
  const ordinaryToken = {
    actor: {
      uuid: "Actor.ordinary",
      items: { contents: [] },
      getFlag: () => ({})
    },
    visible: true,
    renderable: true,
    bounds: { x: 0, y: 0, width: 100, height: 100 }
  };
  const restoreGlobals = installGlobals({
    Hooks: {
      on(hook, callback) {
        const callbacks = hookCallbacks.get(hook) ?? [];
        callbacks.push(callback);
        hookCallbacks.set(hook, callbacks);
      },
      callAll() {}
    },
    CONFIG: {
      Canvas: {
        objectBorderThickness: 2
      }
    },
    canvas: {
      ready: true,
      scene: {
        id: "scene",
        tokens: {
          get: () => null
        }
      },
      tokens: {
        placeables: [vehicleToken],
        get: () => null
      },
      app: { view },
      interface: { grid: gridInterface },
      dimensions: { uiScale: 1 },
      grid: {
        size: 100,
        sizeX: 100,
        sizeY: 100
      }
    },
    document: {
      createElement() {
        const shield = new MockEventTarget();
        shield.style = {};
        shield.dataset = {};
        shield.remove = () => {
          shield.removed = true;
        };
        shields.push(shield);
        return shield;
      },
      body: {
        appendChild() {}
      }
    },
    foundry: {
      utils: {
        deepClone: value => structuredClone(value),
        randomID: createIdFactory()
      }
    },
    game: {
      user: { id: "gm", isGM: true },
      actors: { contents: [] },
      users: []
    },
    ui: {
      notifications: {
        info() {},
        warn() {}
      }
    },
    window: windowTarget
  });
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  const allTimerCallbacks = new Map();
  const clearedTimerIds = [];
  let nextTimerId = 1;
  let lifecycle = null;

  try {
    globalThis.setTimeout = (callback, delay) => {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, delay });
      allTimerCallbacks.set(timerId, callback);
      return timerId;
    };
    globalThis.clearTimeout = timerId => {
      clearedTimerIds.push(timerId);
      timers.delete(timerId);
    };

    const actorContainers = await import(
      new URL(`../src/canvas/actor-containers.mjs?boarding-refresh=${Date.now()}`, import.meta.url)
    );
    lifecycle = await import("../src/canvas/target-selection-lifecycle.mjs");
    actorContainers.registerActorContainerHooks();

    assert.equal(
      actorContainers.startActorContainerBoardingMode({
        actor: passengerActor,
        token: passengerToken
      }),
      true
    );
    assert.equal(highlightLayer.rects.at(-1)?.x, 10);

    const refreshToken = hookCallbacks.get("refreshToken")?.[0];
    assert.equal(typeof refreshToken, "function");
    refreshToken(vehicleToken, { refreshPosition: true });
    refreshToken(vehicleToken, { refreshPosition: true });
    refreshToken(ordinaryToken, { refreshPosition: true });
    assert.equal(timers.size, 1);
    const [firstTimerId, firstTimer] = [...timers.entries()][0];
    assert.equal(firstTimer.delay, 50);

    vehicleToken.bounds = { x: 75, y: 90, width: 110, height: 120 };
    timers.delete(firstTimerId);
    firstTimer.callback();
    assert.deepEqual(highlightLayer.rects.at(-1), {
      x: 75,
      y: 90,
      width: 110,
      height: 120
    });

    refreshToken(vehicleToken, { refreshPosition: true });
    const [pendingTimerId] = timers.keys();
    assert.ok(pendingTimerId);
    lifecycle.cancelActiveCanvasTargetSelection({ reason: "testCleanup" });
    assert.ok(clearedTimerIds.includes(pendingTimerId));
    assert.equal(shields[0]?.removed, true);
    assert.ok(view.removeCount > 0);
    assert.ok(windowTarget.removeCount > 0);

    const clearsAfterCleanup = highlightLayer.clearCount;
    allTimerCallbacks.get(pendingTimerId)?.();
    assert.equal(highlightLayer.clearCount, clearsAfterCleanup);
  } finally {
    lifecycle?.cancelActiveCanvasTargetSelection({ reason: "testCleanup" });
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
    restoreGlobals();
  }
});

test("boarding clicks still recalculate current eligibility", () => {
  const hitTest = getSourceSection(
    actorContainerSource,
    "function getActorContainerTokenAtPoint",
    "function pointInToken"
  );
  assert.match(hitTest, /isTokenAvailableForBoarding\(token, session\)/);
  assert.match(hitTest, /pointInToken\(point, token\)/);
});

test("light placement joins the lifecycle and cleans every input resource immediately", () => {
  const start = getSourceSection(
    lightNetworkSource,
    "async function startLightNetworkInteractionPlacement",
    "function cancelLightNetworkInteractionPlacement"
  );
  const cancel = getSourceSection(
    lightNetworkSource,
    "function cancelLightNetworkInteractionPlacement",
    "function bindPlacementInput"
  );
  const unbind = getSourceSection(
    lightNetworkSource,
    "function unbindPlacementInput",
    "function createPlacementInputShield"
  );
  const keydown = getSourceSection(
    lightNetworkSource,
    "function onPlacementKeyDown",
    "async function finishLightNetworkInteractionPlacement"
  );
  const finish = getSourceSection(
    lightNetworkSource,
    "async function finishLightNetworkInteractionPlacement",
    "async function reopenLightNetworkConfigWindows"
  );

  assertBefore(start, "cancelActiveCanvasTargetSelection", "if (!game.user?.isGM)");
  assert.match(start, /kind:\s*"lightNetworkInteractionPlacement"/);
  assert.match(start, /onCancel:[\s\S]*?cancelLightNetworkInteractionPlacement\([\s\S]*?fromLifecycle:\s*true/);
  assert.match(start, /targetSelectionSession\.finished\s*\|\|\s*activePlacement !== placement/);
  assert.match(start, /!targetSelectionSession\.active\s*\|\|\s*activePlacement !== placement\s*\|\|\s*placement\.cleaned/);
  assert.match(cancel, /if \(placement\.cleaned\)/);
  assert.match(cancel, /placement\.cleaned = true/);
  assert.match(cancel, /window\.removeEventListener\("keydown", onPlacementKeyDown/);
  assert.match(cancel, /destroyLightNetworkPlacementPreview\(placement\)/);
  assert.match(cancel, /targetSelectionSession\?\.finish/);
  assert.match(unbind, /removeEventListener\(type, onPlacementCanvasEvent, true\)/);
  assert.match(unbind, /placement\.inputShield\?\.remove\?\.\(\)/);
  assert.doesNotMatch(unbind, /setTimeout/);
  assertBefore(keydown, 'event.key !== "Escape"', "event.preventDefault");
  assert.match(finish, /cancelLightNetworkInteractionPlacement\(\{\s*placement,\s*cancelled:\s*false\s*\}\)/);
  assert.doesNotMatch(lightNetworkSource, /_rulerPaths/);
  assert.match(lightNetworkSource, /canvas\?\.interface\?\.addChild \? canvas\.interface : canvas\?\.stage/);
});

function getSourceSection(source, startMarker, endMarker) {
  const startIndex = source.indexOf(startMarker);
  assert.notEqual(startIndex, -1, `Missing source marker: ${startMarker}`);
  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  assert.notEqual(endIndex, -1, `Missing source marker: ${endMarker}`);
  return source.slice(startIndex, endIndex);
}

function assertBefore(source, firstMarker, secondMarker) {
  const firstIndex = source.indexOf(firstMarker);
  const secondIndex = source.indexOf(secondMarker);
  assert.notEqual(firstIndex, -1, `Missing source marker: ${firstMarker}`);
  assert.notEqual(secondIndex, -1, `Missing source marker: ${secondMarker}`);
  assert.ok(firstIndex < secondIndex, `${firstMarker} must occur before ${secondMarker}`);
}

function createIdFactory() {
  let index = 0;
  return () => `test-id-${++index}`;
}

function installGlobals(values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }
  return () => {
    for (const [key, descriptor] of previous.entries()) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

class MockEventTarget {
  constructor() {
    this.listeners = new Map();
    this.removeCount = 0;
    this.removed = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
    this.removeCount += 1;
  }
}

class MockHighlightLayer {
  constructor() {
    this.clearCount = 0;
    this.rects = [];
  }

  clear() {
    this.clearCount += 1;
    this.rects = [];
  }

  lineStyle() {}

  beginFill() {}

  drawRect(x, y, width, height) {
    this.rects.push({ x, y, width, height });
  }

  endFill() {}
}
