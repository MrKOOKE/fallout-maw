import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { invalidateStealthDetectionCache } from "../src/stealth/detection.mjs";
import { invalidateLightingAnalysisCache } from "../src/stealth/lighting.mjs";
import { invalidateStealthRelationCache } from "../src/stealth/observers.mjs";
import {
  clearWeaponNoiseDetectionQueues,
  configureWeaponNoiseDetection,
  resolveWeaponNoiseDetection
} from "../src/stealth/weapon-noise.mjs";

const originalCanvas = globalThis.canvas;
const originalConfig = globalThis.CONFIG;
const originalGame = globalThis.game;
const originalPIXI = globalThis.PIXI;

afterEach(() => {
  configureWeaponNoiseDetection();
  clearWeaponNoiseDetectionQueues();
  invalidateStealthDetectionCache();
  invalidateLightingAnalysisCache();
  invalidateStealthRelationCache();
  if (originalCanvas === undefined) delete globalThis.canvas;
  else globalThis.canvas = originalCanvas;
  if (originalConfig === undefined) delete globalThis.CONFIG;
  else globalThis.CONFIG = originalConfig;
  if (originalGame === undefined) delete globalThis.game;
  else globalThis.game = originalGame;
  if (originalPIXI === undefined) delete globalThis.PIXI;
  else globalThis.PIXI = originalPIXI;
});

test("weapon noise detection is disabled with the world auto-detection setting", async () => {
  const fixture = createNoiseFixture({ observerCount: 1 });
  let rolls = 0;
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(false),
    rollStealthCheck: async () => {
      rolls += 1;
      return successOutcome();
    }
  });

  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 5 }), false);
  assert.equal(rolls, 0);
  assert.equal(fixture.actor.statuses.has("invisible"), true);
});

test("gridded resolver rolls only for a shared source-noise and observer cell", async () => {
  const fixture = createGriddedNoiseFixture({
    attackerOffset: { i: 1, j: 3, k: 0 },
    observerOffsets: [
      { i: 1, j: 2, k: 0 },
      { i: 1, j: 1, k: 0 }
    ]
  });
  const rolledObserverIds = [];
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(true),
    rollStealthCheck: async (_source, observer) => {
      rolledObserverIds.push(observer.id);
      return successOutcome();
    }
  });

  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 1 }), false);
  assert.deepEqual(rolledObserverIds, [fixture.observers[0].id]);
});

test("gridded resolver does not treat the same horizontal cell on another elevation as contact", async () => {
  const fixture = createGriddedNoiseFixture({
    attackerOffset: { i: 1, j: 3, k: 0 },
    observerOffsets: [
      { i: 1, j: 3, k: 4 }
    ]
  });
  let rolls = 0;
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(true),
    rollStealthCheck: async () => {
      rolls += 1;
      return successOutcome();
    }
  });

  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 1 }), false);
  assert.equal(rolls, 0);
});

test("resolver uses the current post-effect token and includes non-visible observers", async () => {
  const fixture = createNoiseFixture({
    currentAttackerX: 200,
    staleAttackerX: 2_000,
    observerCount: 1,
    observerVisible: false
  });
  let rolledSource = null;
  let rolledObserver = null;
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(true),
    rollStealthCheck: async (source, observer) => {
      rolledSource = source;
      rolledObserver = observer;
      return successOutcome();
    }
  });

  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 2 }), false);
  assert.strictEqual(rolledSource, fixture.currentAttacker);
  assert.strictEqual(rolledObserver, fixture.observers[0]);
  assert.equal(rolledObserver.visible, false);
  assert.equal(fixture.actor.statuses.has("invisible"), true);
});

test("resolver adds five physical cells even when darkness makes each cell cost five", async () => {
  const fixture = createNoiseFixture({
    currentAttackerX: 500,
    observerCount: 1,
    darknessLevel: 1
  });
  let rolls = 0;
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(true, { penaltyPercent: 80 }),
    rollStealthCheck: async () => {
      rolls += 1;
      return successOutcome();
    }
  });

  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 4 }), false);
  assert.equal(rolls, 0);
  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 5 }), false);
  assert.equal(rolls, 1);
});

test("weapon noise never checks blind or zero-perception observers", async () => {
  const fixture = createNoiseFixture({
    currentAttackerX: 100,
    observerCount: 2
  });
  globalThis.CONFIG.specialStatusEffects.BLIND = "blind";
  fixture.observers[0].actor.statuses.add("blind");
  fixture.observers[1].document.sight.range = 0;
  fixture.observers[1].document.detectionModes = {
    basicSight: { enabled: true, range: 0 },
    lightPerception: { enabled: true, range: 0 }
  };
  let rolls = 0;
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(true),
    rollStealthCheck: async () => {
      rolls += 1;
      return successOutcome();
    }
  });

  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 100 }), false);
  assert.equal(rolls, 0);
  assert.equal(fixture.actor.statuses.has("invisible"), true);
});

test("grouped failed observers reveal once and pause once", async () => {
  const fixture = createNoiseFixture({
    currentAttackerX: 100,
    observerCount: 2
  });
  const observerIds = [];
  let pauses = 0;
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(true),
    pauseGame: () => {
      pauses += 1;
    },
    rollStealthCheck: async (source, observer) => {
      observerIds.push(observer.id);
      source.actor.statuses.delete("invisible");
      return failureOutcome();
    }
  });

  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 1 }), true);
  assert.deepEqual(observerIds, fixture.observers.map(observer => observer.id));
  assert.equal(pauses, 1);
  assert.equal(fixture.actor.statuses.has("invisible"), false);
});

test("successful checks leave the attacker hidden and visit observers sequentially", async () => {
  const fixture = createNoiseFixture({
    currentAttackerX: 100,
    observerCount: 2
  });
  const observerIds = [];
  let pauses = 0;
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(true),
    pauseGame: () => {
      pauses += 1;
    },
    rollStealthCheck: async (_source, observer) => {
      observerIds.push(observer.id);
      return successOutcome();
    }
  });

  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 1 }), false);
  assert.deepEqual(observerIds, fixture.observers.map(observer => observer.id));
  assert.equal(pauses, 0);
  assert.equal(fixture.actor.statuses.has("invisible"), true);
});

test("inconspicuous adds its skill bonus once to every weapon-noise check in combat", async () => {
  const fixture = createNoiseFixture({ currentAttackerX: 100, observerCount: 2 });
  fixture.actor.items = [{
    id: "inconspicuous-ability",
    type: "ability",
    system: {
      functions: [{
        id: "inconspicuous-main",
        type: "fixed",
        fixedKey: "inconspicuous",
        fixedSettings: {
          attackStealthBonus: 20,
          stealthBonus: 20,
          stealthBonusDurationSeconds: 6
        },
        changes: [],
        actions: [],
        conditions: [],
        penalties: []
      }]
    }
  }];
  const combat = {
    started: true,
    combatants: [{ actor: fixture.actor }],
    getCombatantsByActor: actor => actor === fixture.actor ? [{}] : []
  };
  globalThis.game = { combats: [combat], combat };
  const skillBonuses = [];
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(true),
    rollStealthCheck: async (_source, _observer, _app, options) => {
      skillBonuses.push(options.skillBonus);
      return successOutcome();
    }
  });

  assert.equal(await resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 1 }), false);
  assert.deepEqual(skillBonuses, [20, 20]);
});

test("same-actor weapon noise resolutions cannot roll concurrently", async () => {
  const fixture = createNoiseFixture({
    currentAttackerX: 100,
    observerCount: 1
  });
  const alternateAttacker = createToken("attacker-token-alt", fixture.actor, 100);
  globalThis.canvas.tokens.placeables.push(alternateAttacker);
  let rolls = 0;
  let releaseFirstRoll;
  configureWeaponNoiseDetection({
    getSettings: () => createSettings(true),
    rollStealthCheck: async () => {
      rolls += 1;
      if (rolls !== 1) return successOutcome();
      return new Promise(resolve => {
        releaseFirstRoll = () => resolve(successOutcome());
      });
    }
  });

  const first = resolveWeaponNoiseDetection(fixture.staleAttacker, { noiseLevel: 1 });
  const second = resolveWeaponNoiseDetection(alternateAttacker, { noiseLevel: 1 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rolls, 1);

  releaseFirstRoll();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(rolls, 2);
});

function createNoiseFixture({
  currentAttackerX = 500,
  staleAttackerX = currentAttackerX,
  observerCount = 0,
  observerVisible = true,
  gridDistance = 1,
  darknessLevel = 0
} = {}) {
  globalThis.CONFIG = {
    specialStatusEffects: {
      DEFEATED: "defeated",
      INVISIBLE: "invisible"
    }
  };

  const actor = createActor("attacker", { stealthed: true });
  const currentAttacker = createToken("attacker-token", actor, currentAttackerX);
  const staleAttacker = createToken("attacker-token", actor, staleAttackerX);
  const observers = Array.from({ length: observerCount }, (_entry, index) => {
    const observer = createToken(
      `observer-${index + 1}`,
      createActor(`observer-${index + 1}`),
      0
    );
    observer.visible = observerVisible;
    observer.renderable = observerVisible;
    return observer;
  });
  const placeables = [currentAttacker, ...observers];
  globalThis.canvas = {
    ready: true,
    scene: {
      id: "noise-scene",
      grid: { distance: gridDistance }
    },
    grid: {
      distance: gridDistance,
      isGridless: true,
      size: 100
    },
    tokens: {
      get: id => placeables.find(token => token.id === id) ?? null,
      placeables
    },
    dimensions: { width: 10_000, height: 10_000 },
    environment: {
      darknessLevel,
      globalLightSource: { active: false }
    },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: () => darknessLevel,
      testInsideDarkness: () => false
    }
  };
  return { actor, currentAttacker, staleAttacker, observers };
}

function createGriddedNoiseFixture({
  attackerOffset,
  observerOffsets,
  gridSize = 100,
  gridDistance = 1
}) {
  globalThis.CONFIG = {
    specialStatusEffects: {
      DEFEATED: "defeated",
      INVISIBLE: "invisible"
    }
  };
  globalThis.PIXI = {
    Rectangle: class Rectangle {
      constructor(x, y, width, height) {
        Object.assign(this, { x, y, width, height });
      }

      fit() {
        return this;
      }
    }
  };

  const actor = createActor("attacker-gridded", { stealthed: true });
  const currentAttacker = createTokenAtGridOffset(
    "attacker-token-gridded",
    actor,
    attackerOffset,
    { gridSize, gridDistance }
  );
  const staleAttacker = createTokenAtGridOffset(
    "attacker-token-gridded",
    actor,
    attackerOffset,
    { gridSize, gridDistance }
  );
  const observers = observerOffsets.map((offset, index) => createTokenAtGridOffset(
    `observer-gridded-${index + 1}`,
    createActor(`observer-gridded-${index + 1}`),
    offset,
    { gridSize, gridDistance }
  ));
  const placeables = [currentAttacker, ...observers];
  globalThis.canvas = {
    ready: true,
    scene: {
      id: "noise-scene-gridded",
      grid: { distance: gridDistance }
    },
    grid: {
      distance: gridDistance,
      isGridless: false,
      size: gridSize,
      getOffset: point => ({
        i: Math.floor((Number(point?.y) || 0) / gridSize),
        j: Math.floor((Number(point?.x) || 0) / gridSize),
        k: Math.floor(((Number(point?.elevation) || 0) / gridDistance) + 1e-8)
      }),
      getCenterPoint: ({ i, j, k = 0 }) => ({
        x: (j + 0.5) * gridSize,
        y: (i + 0.5) * gridSize,
        elevation: k * gridDistance
      }),
      getOffsetRange: ({ x, y, width, height }) => [
        Math.floor(y / gridSize),
        Math.floor(x / gridSize),
        Math.ceil((y + height) / gridSize),
        Math.ceil((x + width) / gridSize)
      ]
    },
    tokens: {
      get: id => placeables.find(token => token.id === id) ?? null,
      placeables
    },
    dimensions: {
      rect: new globalThis.PIXI.Rectangle(0, 0, gridSize * 8, gridSize * 4)
    },
    environment: {
      darknessLevel: 0,
      globalLightSource: { active: false }
    },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: () => 0,
      testInsideDarkness: () => false
    }
  };
  return { actor, currentAttacker, staleAttacker, observers };
}

function createActor(id, { stealthed = false } = {}) {
  return {
    uuid: `Actor.${id}`,
    statuses: new Set(stealthed ? ["invisible"] : []),
    system: {
      skills: {
        naturalist: { value: 0 }
      }
    }
  };
}

function createToken(id, actor, x) {
  const point = { x, y: 0, elevation: 0 };
  return {
    id,
    actor,
    hasSight: true,
    checkCollision: () => false,
    document: {
      uuid: `Scene.noise.Token.${id}`,
      elevation: 0,
      getCenterPoint: () => point,
      sight: { enabled: true, range: null },
      detectionModes: {
        basicSight: { enabled: true, range: null }
      },
      hasStatusEffect: () => false
    }
  };
}

function createTokenAtGridOffset(id, actor, offset, { gridSize, gridDistance }) {
  const point = {
    x: (offset.j + 0.5) * gridSize,
    y: (offset.i + 0.5) * gridSize,
    elevation: offset.k * gridDistance
  };
  const token = createToken(id, actor, point.x);
  token.document.elevation = point.elevation;
  token.document.getCenterPoint = () => point;
  token.document.getOccupiedGridSpaceOffsets = () => [{ ...offset }];
  return token;
}

function createSettings(enabled, { penaltyPercent = 0 } = {}) {
  return Object.freeze({
    detection: Object.freeze({
      skillKey: "naturalist",
      rangeFormula: "0"
    }),
    attenuationLevels: Object.freeze([
      Object.freeze({ threshold: 0, penaltyPercent })
    ]),
    autoDetection: Object.freeze({ enabled })
  });
}

function successOutcome() {
  return { result: { key: "success" } };
}

function failureOutcome() {
  return { result: { key: "failure" } };
}
