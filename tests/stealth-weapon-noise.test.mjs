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

test("the first failed observer reveals, pauses, and stops later checks", async () => {
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
  assert.deepEqual(observerIds, [fixture.observers[0].id]);
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
