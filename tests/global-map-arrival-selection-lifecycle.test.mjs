import assert from "node:assert/strict";
import test from "node:test";

const hookCallbacks = new Map();
globalThis.Hooks = {
  on(name, callback) {
    const callbacks = hookCallbacks.get(name) ?? new Set();
    callbacks.add(callback);
    hookCallbacks.set(name, callbacks);
    return callback;
  },
  off(name, callback) {
    hookCallbacks.get(name)?.delete(callback);
  },
  callAll(name, ...args) {
    for (const callback of hookCallbacks.get(name) ?? []) callback(...args);
  }
};

class FakeApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: [],
    actions: {},
    form: {},
    position: {},
    window: {}
  };

  async _onRender() {}
  _onClose() {}
}

class FakeInteractionLayer {
  static layerOptions = { name: "", zIndex: 0 };

  activate() {
    this.activated = true;
    return this;
  }

  async _tearDown() {
    this.baseTornDown = true;
    return this;
  }
}

let randomId = 0;
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: FakeApplicationV2,
      DialogV2: class {},
      HandlebarsApplicationMixin: Base => class extends Base {}
    },
    ux: {
      TextEditor: { implementation: class {} }
    }
  },
  canvas: {
    layers: { InteractionLayer: FakeInteractionLayer }
  },
  utils: {
    deepClone: value => value === undefined ? undefined : structuredClone(value),
    expandObject: value => value,
    mergeObject: (target, source) => ({ ...(target ?? {}), ...(source ?? {}) }),
    randomID: () => `selection-${++randomId}`
  }
};
globalThis.PIXI = {
  BLEND_MODES: { NORMAL: 0 },
  Container: class {},
  Filter: class {
    constructor(_vertex, _fragment, uniforms = {}) {
      this.uniforms = uniforms;
    }
  },
  LegacyGraphics: class {},
  Texture: { EMPTY: {} }
};
globalThis.CONFIG = {
  Canvas: {
    groups: {
      interface: { zIndexDrawings: 500 }
    }
  }
};
globalThis.game = {
  folders: [],
  scenes: {
    contents: [],
    get: () => null
  },
  settings: {
    get: () => null,
    set: async () => null
  },
  user: {
    id: "user",
    isGM: true
  }
};
globalThis.canvas = {
  scene: { id: "target-scene" }
};

const {
  getActiveCanvasTargetSelectionSession,
  startCanvasTargetSelectionSession
} = await import("../src/canvas/target-selection-lifecycle.mjs");
const { FalloutMaWGlobalMapLayer } = await import("../src/global-map/layer.mjs");

function createLayer() {
  const layer = new FalloutMaWGlobalMapLayer();
  layer.refreshCount = 0;
  layer.refresh = async () => {
    layer.refreshCount += 1;
  };
  return layer;
}

function arrivalPayload(overrides = {}) {
  return {
    groupId: "group-a",
    transferId: "transfer-a",
    targetSceneId: "target-scene",
    originSceneId: "origin-scene",
    tokenId: "token-a",
    ...overrides
  };
}

test("arrivalSelect replaces the previous global selection owner", async () => {
  const previous = startCanvasTargetSelectionSession({ kind: "weaponAttack" });
  const layer = createLayer();

  assert.equal(await layer.startArrivalSelection(arrivalPayload()), true);
  assert.equal(previous.finished, true);
  assert.equal(previous.outcome.cancelled, true);
  assert.equal(previous.outcome.reason, "superseded");
  assert.equal(getActiveCanvasTargetSelectionSession()?.outcome, null);
  assert.equal(getActiveCanvasTargetSelectionSession()?.active, true);
  assert.equal(layer.arrivalSelection?.transferId, "transfer-a");
  assert.equal(layer.mode, "arrivalSelect");
  assert.equal(layer.activated, true);
});

test("superseding arrivalSelect synchronously clears its state and overlay mode", async () => {
  const layer = createLayer();
  assert.equal(await layer.startArrivalSelection(arrivalPayload()), true);
  const refreshesBeforeSupersession = layer.refreshCount;

  const next = startCanvasTargetSelectionSession({ kind: "tokens" });
  assert.equal(next.active, true);
  assert.equal(layer.arrivalSelection, null);
  assert.equal(layer.mode, "select");
  assert.equal(layer.refreshCount, refreshesBeforeSupersession + 1);
  next.finish();
});

test("layer teardown cancels arrivalSelect without reactivating or refreshing the layer", async () => {
  const layer = createLayer();
  assert.equal(await layer.startArrivalSelection(arrivalPayload()), true);
  const refreshesBeforeTearDown = layer.refreshCount;

  await layer._tearDown({});
  assert.equal(layer.arrivalSelection, null);
  assert.equal(layer.mode, "select");
  assert.equal(layer.refreshCount, refreshesBeforeTearDown);
  assert.equal(layer.baseTornDown, true);
  assert.equal(getActiveCanvasTargetSelectionSession(), null);
});
