import assert from "node:assert/strict";
import test from "node:test";

import {
  createPhysicalLosTransitionCache,
  testObserverVisibilityBatch
} from "../src/canvas/physical-los.mjs";

function makeToken(uuid, actorUuid = "") {
  return { uuid, document: { uuid }, actor: actorUuid ? { uuid: actorUuid } : null };
}

test("observer batch uses Foundry's native vision origin and target test points", () => {
  const previousCanvas = globalThis.canvas;
  const previousConfig = globalThis.CONFIG;
  const previousFoundry = globalThis.foundry;
  const nativePoints = [{ x: 50, y: 60, elevation: 7 }];
  let initializedData = null;
  let configuredPoints = null;
  let destroyed = false;

  class VisionSource {
    constructor() {
      this.blinded = {};
      this.isBlinded = false;
    }

    initialize(data) {
      initializedData = data;
    }

    destroy() {
      destroyed = true;
    }
  }

  globalThis.foundry = {
    ...(previousFoundry ?? {}),
    utils: {
      ...(previousFoundry?.utils ?? {}),
      randomID: () => "native-vision-test"
    }
  };
  globalThis.CONFIG = {
    ...(previousConfig ?? {}),
    Canvas: {
      ...(previousConfig?.Canvas ?? {}),
      visionSourceClass: VisionSource,
      detectionModes: {
        basicSight: {
          testVisibility: () => true
        }
      }
    }
  };
  globalThis.canvas = {
    ready: true,
    visibility: {
      tokenVision: true,
      _createVisibilityTestConfig(points) {
        configuredPoints = points;
        return { tests: [] };
      }
    }
  };

  const observer = {
    sourceId: "observer",
    hasSight: true,
    center: { x: 999, y: 999 },
    document: {
      id: "observer",
      uuid: "Scene.scene.Token.observer",
      detectionModes: {
        basicSight: { enabled: true, range: 30 }
      }
    },
    _getVisionBlindedStates: () => ({}),
    _getVisionSourceData: () => ({ x: 11, y: 22, elevation: 7, radius: 300 })
  };
  const target = {
    document: {
      uuid: "Scene.scene.Token.target",
      getVisibilityTestPoints: () => nativePoints
    }
  };

  try {
    const result = testObserverVisibilityBatch(observer, [target]);
    assert.equal(result.get(target.document.uuid), true);
    assert.equal(initializedData.x, 11);
    assert.equal(initializedData.y, 22);
    assert.equal(initializedData.elevation, 7);
    assert.equal(initializedData.disabled, false);
    assert.equal(configuredPoints, nativePoints);
    assert.equal(destroyed, true);
  } finally {
    globalThis.canvas = previousCanvas;
    globalThis.CONFIG = previousConfig;
    globalThis.foundry = previousFoundry;
  }
});

async function flushTimers(timers) {
  while (timers.length) {
    const callback = timers.shift();
    await callback();
  }
}

test("lazy LOS cache materializes token pairs silently then emits only real transitions", async () => {
  const tokens = [makeToken("A", "actorA"), makeToken("B", "actorB")];
  const visibility = new Map([
    ["A>B", false],
    ["B>A", true]
  ]);
  const emitted = [];
  const cache = createPhysicalLosTransitionCache({
    collectSceneTokens: () => tokens,
    testObserverBatch: (observer, targets) => {
      const results = new Map();
      for (const target of targets) {
        results.set(target.uuid, visibility.get(`${observer.uuid}>${target.uuid}`) === true);
      }
      return results;
    },
    emit: transition => emitted.push(transition),
    coalesceMs: 0,
    yieldEvery: 0
  });
  cache.setArmed(true);

  await cache.refreshTokens("scene", ["A"], { silent: false });
  assert.equal(emitted.length, 0);
  assert.equal(cache.sceneCaches.get("scene").get("A>B").visible, false);
  assert.equal(cache.sceneCaches.get("scene").get("B>A").visible, true);

  visibility.set("A>B", true);
  await cache.refreshTokens("scene", ["A"]);
  assert.deepEqual(emitted.map(entry => [entry.type, entry.pair.observerUuid, entry.pair.targetUuid]), [
    ["gained", "A", "B"]
  ]);
});

test("LOS invalidations coalesce while pending", async () => {
  const timers = [];
  let collects = 0;
  const tokens = [makeToken("A"), makeToken("B")];
  const cache = createPhysicalLosTransitionCache({
    collectSceneTokens: () => {
      collects += 1;
      return tokens;
    },
    testObserverBatch: (_observer, targets) => {
      const results = new Map();
      for (const target of targets) results.set(target.uuid, false);
      return results;
    },
    emit: () => undefined,
    setTimer: callback => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
    coalesceMs: 1,
    yieldEvery: 0
  });
  cache.setArmed(true);

  const first = cache.invalidate("scene", { tokenUuids: ["A"] });
  const second = cache.invalidate("scene", { tokenUuids: ["B"] });
  assert.equal(first, second);
  assert.equal(timers.length, 1);
  await flushTimers(timers);
  await first;
  assert.equal(collects, 1);
});

test("disarmed cache ignores invalidation storms", async () => {
  let collects = 0;
  const cache = createPhysicalLosTransitionCache({
    collectSceneTokens: () => {
      collects += 1;
      return [];
    },
    testObserverBatch: () => new Map(),
    emit: () => undefined,
    coalesceMs: 0,
    yieldEvery: 0
  });
  cache.setArmed(false);
  await cache.invalidate("scene", { full: true });
  await cache.invalidate("scene", { tokenUuids: ["A"] });
  assert.equal(collects, 0);
  cache.setArmed(true);
  await cache.invalidate("scene", { tokenUuids: ["A"] });
  assert.equal(collects, 1);
});

test("full refresh emits lost for pairs that disappear", async () => {
  let tokens = [makeToken("A"), makeToken("B")];
  const emitted = [];
  const cache = createPhysicalLosTransitionCache({
    collectSceneTokens: () => tokens,
    testObserverBatch: (_observer, targets) => {
      const results = new Map();
      for (const target of targets) results.set(target.uuid, true);
      return results;
    },
    emit: transition => emitted.push(transition),
    coalesceMs: 0,
    yieldEvery: 0
  });
  cache.setArmed(true);
  await cache.refreshAll("scene", { silent: true });
  tokens = [makeToken("A")];
  await cache.refreshAll("scene");
  assert.ok(emitted.some(entry => entry.type === "lost" && entry.pair.observerUuid === "A" && entry.pair.targetUuid === "B"));
});

test("in-flight dirty flag schedules a single follow-up refresh", async () => {
  const timers = [];
  let collects = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tokens = [makeToken("A"), makeToken("B")];
  const cache = createPhysicalLosTransitionCache({
    collectSceneTokens: async () => {
      collects += 1;
      if (collects === 1) await gate;
      return tokens;
    },
    testObserverBatch: (_observer, targets) => {
      const results = new Map();
      for (const target of targets) results.set(target.uuid, false);
      return results;
    },
    emit: () => undefined,
    setTimer: callback => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
    coalesceMs: 1,
    yieldEvery: 0
  });
  cache.setArmed(true);

  const first = cache.invalidate("scene", { tokenUuids: ["A"] });
  const running = timers.shift()();
  await Promise.resolve();
  const follow = cache.invalidate("scene", { full: true });
  release();
  await running;
  await flushTimers(timers);
  await first;
  await follow;
  assert.equal(collects, 2);
});
