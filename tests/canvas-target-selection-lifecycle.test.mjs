import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;

test("canvas target selection has one owner and canvas teardown releases it", async () => {
  const restore = installGlobals({
    foundry: {
      utils: {
        randomID: createIdFactory()
      }
    }
  });
  const hooks = createHookHarness();
  globalThis.Hooks = hooks.api;
  try {
    const lifecycle = await importFresh("../src/canvas/target-selection-lifecycle.mjs");
    lifecycle.registerCanvasTargetSelectionLifecycleHooks();

    let firstCleanupCount = 0;
    let secondCleanupCount = 0;
    const first = lifecycle.startCanvasTargetSelectionSession(
      { kind: "first" },
      { onCancel: () => { firstCleanupCount += 1; } }
    );
    const second = lifecycle.startCanvasTargetSelectionSession(
      { kind: "second" },
      { onCancel: () => { secondCleanupCount += 1; } }
    );

    assert.equal(first.finished, true);
    assert.equal(first.outcome.cancelled, true);
    assert.equal(first.outcome.reason, "superseded");
    assert.equal(firstCleanupCount, 1);
    assert.equal(second.active, true);
    assert.equal(lifecycle.getActiveCanvasTargetSelectionSession(), second);

    hooks.fire("canvasTearDown");
    assert.equal(second.finished, true);
    assert.equal(second.outcome.cancelled, true);
    assert.equal(second.outcome.reason, "canvasTearDown");
    assert.equal(secondCleanupCount, 1);
    assert.equal(lifecycle.getActiveCanvasTargetSelectionSession(), null);
    assert.equal(second.cancel(), false);
  } finally {
    restore();
  }
});

test("nested starts from cancellation hooks cannot be clobbered by an outer start", async () => {
  const restore = installGlobals({
    foundry: {
      utils: {
        randomID: createIdFactory()
      }
    }
  });
  const events = [];
  let lifecycle = null;
  let nestedFromOwner = null;
  let nestedFromFinishedHook = null;
  let outerCleanupCount = 0;
  globalThis.Hooks = {
    callAll(hook, context) {
      events.push({ hook, context });
      if (
        lifecycle
        && hook === lifecycle.CANVAS_TARGET_SELECTION_FINISHED_HOOK
        && context.kind === "previous"
      ) {
        nestedFromFinishedHook = lifecycle.startCanvasTargetSelectionSession({
          kind: "nestedFromFinishedHook"
        });
      }
    }
  };
  try {
    lifecycle = await importFresh("../src/canvas/target-selection-lifecycle.mjs");
    const previous = lifecycle.startCanvasTargetSelectionSession(
      { kind: "previous" },
      {
        onCancel: () => {
          nestedFromOwner = lifecycle.startCanvasTargetSelectionSession({
            kind: "nestedFromOwner"
          });
        }
      }
    );
    const outer = lifecycle.startCanvasTargetSelectionSession(
      { kind: "outer" },
      { onCancel: () => { outerCleanupCount += 1; } }
    );

    assert.equal(previous.finished, true);
    assert.equal(nestedFromOwner.finished, true);
    assert.equal(nestedFromFinishedHook.active, true);
    assert.equal(outer.started, false);
    assert.equal(outer.finished, true);
    assert.equal(outer.outcome.reason, "supersededDuringStart");
    assert.equal(outerCleanupCount, 1);
    assert.equal(lifecycle.getActiveCanvasTargetSelectionSession(), nestedFromFinishedHook);
    assert.equal(
      events.some(event => (
        event.hook === lifecycle.CANVAS_TARGET_SELECTION_STARTED_HOOK
        && event.context.kind === "outer"
      )),
      false
    );
    assert.equal(
      events.some(event => (
        event.hook === lifecycle.CANVAS_TARGET_SELECTION_FINISHED_HOOK
        && event.context.kind === "outer"
      )),
      false
    );
    nestedFromFinishedHook.finish();
  } finally {
    restore();
  }
});

test("a nested start from STARTED synchronously cancels the caller session", async () => {
  const restore = installGlobals({
    foundry: {
      utils: {
        randomID: createIdFactory()
      }
    }
  });
  let lifecycle = null;
  let nested = null;
  let ownerCleanupCount = 0;
  globalThis.Hooks = {
    callAll(hook, context) {
      if (
        lifecycle
        && hook === lifecycle.CANVAS_TARGET_SELECTION_STARTED_HOOK
        && context.kind === "outer"
      ) {
        nested = lifecycle.startCanvasTargetSelectionSession({ kind: "nested" });
      }
    }
  };
  try {
    lifecycle = await importFresh("../src/canvas/target-selection-lifecycle.mjs");
    const outer = lifecycle.startCanvasTargetSelectionSession(
      { kind: "outer" },
      { onCancel: () => { ownerCleanupCount += 1; } }
    );
    assert.equal(outer.started, true);
    assert.equal(outer.finished, true);
    assert.equal(ownerCleanupCount, 1);
    assert.equal(nested.active, true);
    assert.equal(lifecycle.getActiveCanvasTargetSelectionSession(), nested);
    nested.finish();
  } finally {
    restore();
  }
});

test("an outer start stays abandoned when its nested winner already finished synchronously", async () => {
  const restore = installGlobals({
    foundry: {
      utils: {
        randomID: createIdFactory()
      }
    }
  });
  let lifecycle = null;
  let nested = null;
  globalThis.Hooks = {
    callAll(hook, context) {
      if (
        lifecycle
        && hook === lifecycle.CANVAS_TARGET_SELECTION_FINISHED_HOOK
        && context.kind === "previous"
      ) {
        nested = lifecycle.startCanvasTargetSelectionSession({ kind: "nested" });
        nested.finish();
      }
    }
  };
  try {
    lifecycle = await importFresh("../src/canvas/target-selection-lifecycle.mjs");
    lifecycle.startCanvasTargetSelectionSession({ kind: "previous" });
    const outer = lifecycle.startCanvasTargetSelectionSession({ kind: "outer" });
    assert.equal(nested.finished, true);
    assert.equal(outer.started, false);
    assert.equal(outer.finished, true);
    assert.equal(outer.outcome.reason, "supersededDuringStart");
    assert.equal(lifecycle.getActiveCanvasTargetSelectionSession(), null);
  } finally {
    restore();
  }
});

test("an unavailable custom selection still cancels and releases the previous owner", async () => {
  const restore = installGlobals({
    foundry: {
      canvas: {
        interaction: {
          MouseInteractionManager: {
            DEFAULT_DRAG_RESISTANCE_PX: 10
          }
        }
      },
      utils: {
        randomID: createIdFactory()
      }
    },
    Hooks: createHookHarness().api,
    ui: {
      notifications: {
        warn() {}
      }
    }
  });
  try {
    const lifecycle = await import("../src/canvas/target-selection-lifecycle.mjs");
    const { requestCustomTokenSelection } = await import("../src/canvas/custom-token-selection.mjs");
    let cleanupCount = 0;
    lifecycle.startCanvasTargetSelectionSession(
      { kind: "previous" },
      { onCancel: () => { cleanupCount += 1; } }
    );

    assert.deepEqual(await requestCustomTokenSelection({ rows: [] }), []);
    assert.equal(cleanupCount, 1);
    assert.equal(lifecycle.getActiveCanvasTargetSelectionSession(), null);
  } finally {
    restore();
  }
});

test("actor target selection batches physical LOS through one temporary VisionSource", async () => {
  const windowTarget = new MockEventTarget();
  const documentTarget = new MockEventTarget();
  const view = new MockEventTarget();
  const interfaceLayer = new MockContainer();
  const hooks = createHookHarness();
  let sourcesCreated = 0;
  let sourcesDestroyed = 0;
  class MockVisionSource {
    constructor() {
      sourcesCreated += 1;
      this.blinded = {};
      this.isBlinded = false;
    }

    initialize() {}

    destroy() {
      sourcesDestroyed += 1;
    }
  }
  const sourceActor = { uuid: "Actor.source" };
  const sourceToken = createVisionToken("source", sourceActor, 0, 0);
  sourceToken.hasSight = true;
  sourceToken.sourceId = "source";
  sourceToken._getVisionSourceData = () => ({ x: 50, y: 50, elevation: 0 });
  sourceToken._getVisionBlindedStates = () => ({});
  sourceToken.document.detectionModes = {
    basicSight: {},
    lightPerception: {}
  };
  const targets = [
    createVisionToken("one", { uuid: "Actor.one" }, 100, 0),
    createVisionToken("two", { uuid: "Actor.two" }, 200, 0)
  ];
  const restore = installGlobals({
    foundry: {
      canvas: {
        interaction: {
          MouseInteractionManager: {
            DEFAULT_DRAG_RESISTANCE_PX: 10
          }
        }
      },
      utils: {
        randomID: createIdFactory()
      }
    },
    Hooks: hooks.api,
    CONFIG: {
      Canvas: {
        visionSourceClass: MockVisionSource,
        detectionModes: {
          basicSight: {
            testVisibility: () => true
          },
          lightPerception: {
            testVisibility: () => false
          }
        }
      }
    },
    PIXI: {
      Container: MockContainer,
      Graphics: MockGraphics
    },
    window: windowTarget,
    document: documentTarget,
    ui: {
      notifications: {
        info() {},
        warn() {}
      }
    },
    canvas: {
      ready: true,
      interface: interfaceLayer,
      tokens: {
        placeables: [sourceToken, ...targets]
      },
      visibility: {
        tokenVision: true,
        _createVisibilityTestConfig: () => ({})
      },
      grid: {
        size: 100
      },
      scene: { id: "scene" },
      app: {
        view
      },
      stage: {
        on() {},
        off() {}
      },
      mouseInteractionManager: {},
      canvasCoordinatesFromClient({ x, y }) {
        return { x, y };
      }
    }
  });
  try {
    const lifecycle = await import("../src/canvas/target-selection-lifecycle.mjs");
    const { requestCustomActorTokenSelection } = await import("../src/canvas/custom-token-selection.mjs");
    const selectionPromise = requestCustomActorTokenSelection({
      sourceActor,
      sourceToken,
      includeSelf: false
    });
    assert.equal(sourcesCreated, 1);
    assert.equal(sourcesDestroyed, 1);
    assert.equal(interfaceLayer.children[0].children.length, 3);
    lifecycle.cancelActiveCanvasTargetSelection({ reason: "testCleanup" });
    assert.equal(await selectionPromise, null);
  } finally {
    restore();
  }
});

test("custom token selection follows movement, refreshes eligibility before clicks, and fully cleans up", async () => {
  const windowTarget = new MockEventTarget();
  const documentTarget = new MockEventTarget();
  const view = new MockEventTarget();
  const interfaceLayer = new MockContainer();
  const hooks = createHookHarness();
  const warnings = [];
  const tokenDocument = {
    uuid: "Scene.scene.Token.target",
    x: 10,
    y: 20,
    width: 1,
    height: 1,
    getSize() {
      return { width: 100, height: 100 };
    }
  };
  const token = {
    document: tokenDocument,
    visible: true,
    renderable: true,
    actor: {
      uuid: "Actor.target"
    }
  };
  const stage = {
    on() {},
    off() {}
  };
  const restore = installGlobals({
    foundry: {
      canvas: {
        interaction: {
          MouseInteractionManager: {
            DEFAULT_DRAG_RESISTANCE_PX: 10
          }
        }
      },
      utils: {
        randomID: createIdFactory()
      }
    },
    Hooks: hooks.api,
    PIXI: {
      Container: MockContainer,
      Graphics: MockGraphics
    },
    window: windowTarget,
    document: documentTarget,
    ui: {
      notifications: {
        info() {},
        warn(message) {
          warnings.push(String(message));
        }
      }
    },
    canvas: {
      ready: true,
      interface: interfaceLayer,
      tokens: {
        placeables: [token]
      },
      grid: {
        size: 100
      },
      scene: {},
      app: {
        view
      },
      stage,
      mouseInteractionManager: {},
      canvasCoordinatesFromClient({ x, y }) {
        return { x, y };
      }
    }
  });
  try {
    const lifecycle = await import("../src/canvas/target-selection-lifecycle.mjs");
    const { requestCustomTokenSelection } = await import("../src/canvas/custom-token-selection.mjs");
    let refreshCount = 0;
    const buildRows = () => {
      refreshCount += 1;
      if (!token.renderable) return [];
      const selectable = tokenDocument.x < 50;
      return [{
        token,
        actorUuid: token.actor.uuid,
        selectable,
        reason: selectable ? "" : "вне дальности"
      }];
    };
    const selectionPromise = requestCustomTokenSelection({
      rows: buildRows(),
      limit: 3,
      allowRepeated: true,
      sourceToken: token,
      refreshRows: buildRows
    });
    const overlay = interfaceLayer.children[0];
    const marker = overlay.children[0];
    assert.deepEqual([marker.position.x, marker.position.y], [10, 20]);

    const refreshesBeforeForeignScene = refreshCount;
    const foreignScene = { id: "foreign-scene" };
    const foreignToken = {
      uuid: "Scene.foreign-scene.Token.foreign",
      parent: foreignScene,
      x: 400,
      y: 400
    };
    hooks.fire("updateToken", foreignToken, { x: 450 });
    hooks.fire("moveToken", foreignToken);
    hooks.fire("createToken", foreignToken);
    hooks.fire("createWall", { parent: foreignScene });
    hooks.fire("updateScene", foreignScene, { darkness: 0.5 });
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(refreshCount, refreshesBeforeForeignScene);

    documentTarget.fire("pointerdown", pointerEvent(view, 0, 20, 30));
    documentTarget.fire("pointerdown", pointerEvent(view, 0, 20, 30));
    assert.equal(marker.lastLineWidth, 5);
    documentTarget.fire("pointerdown", pointerEvent(view, 2, 20, 30));
    view.fire("contextmenu", pointerEvent(view, 2, 20, 30));
    assert.equal(marker.lastLineWidth, 5);

    tokenDocument.x = 70;
    hooks.fire("refreshToken", token, { refreshPosition: true });
    assert.deepEqual([marker.position.x, marker.position.y], [70, 20]);
    const refreshesBeforeClick = refreshCount;
    documentTarget.fire("pointerdown", pointerEvent(view, 0, 80, 30));
    assert.equal(refreshCount, refreshesBeforeClick + 1);
    assert.equal(warnings.some(message => message.includes("вне дальности")), true);

    hooks.fire("refreshToken", token, { refreshPosition: true });
    hooks.fire("refreshToken", token, { refreshPosition: true });
    hooks.fire("refreshToken", token, { refreshPosition: true });
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(refreshCount, refreshesBeforeClick + 2);

    token.renderable = false;
    hooks.fire("refreshToken", token, { refreshVisibility: true });
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(overlay.children.length, 0);
    token.renderable = true;
    hooks.fire("refreshToken", token, { refreshVisibility: true });
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(overlay.children.length, 1);

    lifecycle.cancelActiveCanvasTargetSelection({ reason: "testCleanup" });
    assert.deepEqual(await selectionPromise, []);
    assert.equal(interfaceLayer.children.length, 0);
    assert.equal(windowTarget.listenerCount(), 0);
    assert.equal(documentTarget.listenerCount(), 0);
    assert.equal(view.listenerCount(), 0);
    assert.equal(hooks.listenerCount(), 0);
  } finally {
    restore();
  }
});

function createIdFactory() {
  let id = 0;
  return () => `selection-${++id}`;
}

async function importFresh(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  url.searchParams.set("test", `${Date.now()}-${++importSequence}`);
  return import(url.href);
}

function createHookHarness() {
  let nextId = 0;
  const listeners = new Map();
  const api = {
    on(hook, callback) {
      const id = ++nextId;
      const entries = listeners.get(hook) ?? new Map();
      entries.set(id, callback);
      listeners.set(hook, entries);
      return id;
    },
    off(hook, id) {
      listeners.get(hook)?.delete(id);
      if (!listeners.get(hook)?.size) listeners.delete(hook);
    },
    callAll(hook, ...args) {
      for (const callback of listeners.get(hook)?.values() ?? []) callback(...args);
    }
  };
  return {
    api,
    fire(hook, ...args) {
      api.callAll(hook, ...args);
    },
    listenerCount() {
      let count = 0;
      for (const entries of listeners.values()) count += entries.size;
      return count;
    }
  };
}

function installGlobals(values = {}) {
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
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

class MockEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
    if (!this.listeners.get(type)?.size) this.listeners.delete(type);
  }

  fire(type, event) {
    for (const callback of this.listeners.get(type) ?? []) callback(event);
  }

  listenerCount() {
    let count = 0;
    for (const callbacks of this.listeners.values()) count += callbacks.size;
    return count;
  }
}

class MockContainer {
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

  addChild(...children) {
    for (const child of children) {
      child.parent?.removeChild?.(child);
      child.parent = this;
      this.children.push(child);
    }
    return children.at(-1);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child?.parent === this) child.parent = null;
    return child;
  }

  destroy({ children = false } = {}) {
    if (children) {
      for (const child of [...this.children]) child.destroy?.({ children: true });
    }
    this.children.length = 0;
    this.parent?.removeChild?.(this);
    this.destroyed = true;
  }
}

class MockGraphics extends MockContainer {
  clear() {
    return this;
  }

  lineStyle(width) {
    this.lastLineWidth = width;
    return this;
  }

  beginFill() {
    return this;
  }

  drawRect(x, y, width, height) {
    this.lastRect = { x, y, width, height };
    return this;
  }

  endFill() {
    return this;
  }
}

function pointerEvent(target, button, clientX, clientY) {
  return {
    target,
    button,
    pointerId: 1,
    clientX,
    clientY,
    composedPath: () => [target],
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {}
  };
}

function createVisionToken(id, actor, x, y) {
  const document = {
    id,
    uuid: `Scene.scene.Token.${id}`,
    x,
    y,
    width: 1,
    height: 1,
    elevation: 0,
    actor,
    getSize() {
      return { width: 100, height: 100 };
    },
    getMovementOrigin() {
      return { x: x + 50, y: y + 50 };
    }
  };
  return {
    id,
    document,
    actor,
    visible: true,
    renderable: true,
    center: { x: x + 50, y: y + 50 },
    bounds: {
      x,
      y,
      width: 100,
      height: 100,
      left: x,
      top: y,
      right: x + 100,
      bottom: y + 100
    }
  };
}
