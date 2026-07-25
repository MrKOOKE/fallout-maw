import assert from "node:assert/strict";
import test from "node:test";

import {
  SHOCK_SUCCESS_CONSCIOUSNESS_LOSS_PERCENT,
  buildConsciousnessUpdateData,
  buildConsciousnessValueData,
  calculateConsciousnessRecoveryValue,
  calculateCriticalLimbAverageMaximum,
  calculateShockConsciousnessValue,
  getConsciousnessState,
  hasConsciousnessDepletionTransition,
  isConsciousnessDepleted,
  isConsciousnessUnconscious,
  resolveConsciousnessMaximum
} from "../src/combat/consciousness.mjs";
import { normalizeResourceSettings } from "../src/formulas/normalization.mjs";
import { migrateActorData } from "../src/migrations/documents.mjs";
import { migrateWorldConsciousnessData } from "../src/migrations/world.mjs";

test("consciousness capacity is the rounded average maximum of critical limbs", () => {
  const limbs = {
    head: { critical: true, value: 1, max: 45 },
    torso: { critical: true, value: 0, max: 56 },
    leftArm: { critical: false, value: 100, max: 100 },
    invalid: null
  };

  assert.equal(calculateCriticalLimbAverageMaximum(limbs), 51);
  assert.equal(calculateCriticalLimbAverageMaximum({ arm: { critical: false, max: 30 } }), 0);
  assert.equal(calculateCriticalLimbAverageMaximum({}), 0);
});

test("consciousness state is clamped and only a non-empty depleted scale causes unconsciousness", () => {
  assert.deepEqual(
    getConsciousnessState({ min: 10, value: 999, max: 110 }),
    { min: 0, value: 110, max: 110, capacity: 110, spent: 0 }
  );
  assert.equal(isConsciousnessDepleted({ min: 0, value: 0, max: 100 }), true);
  assert.equal(isConsciousnessDepleted({ min: 0, value: 1, max: 100 }), false);
  assert.equal(isConsciousnessDepleted({ min: 0, value: 0, max: 0 }), false);
  assert.equal(isConsciousnessDepleted(null), false);
  assert.equal(
    hasConsciousnessDepletionTransition({ min: 0, value: 1, max: 100 }, 0),
    true
  );
  assert.equal(
    hasConsciousnessDepletionTransition({ min: 0, value: 100, max: 100 }, 75),
    false
  );
});

test("successful shock checks remove 25 percent of the full consciousness scale", () => {
  assert.equal(SHOCK_SUCCESS_CONSCIOUSNESS_LOSS_PERCENT, 25);
  assert.equal(
    calculateShockConsciousnessValue({ min: 0, value: 100, max: 100 }, "success"),
    75
  );
  assert.equal(
    calculateShockConsciousnessValue({ min: 0, value: 75, max: 100 }, "criticalSuccess"),
    50
  );
  assert.equal(
    calculateShockConsciousnessValue({ min: 10, value: 100, max: 110 }, "success"),
    72
  );
});

test("failed shock checks fully deplete consciousness", () => {
  for (const resultKey of ["failure", "criticalFailure"]) {
    assert.equal(
      calculateShockConsciousnessValue({ min: 10, value: 90, max: 110 }, resultKey),
      0
    );
  }
  assert.equal(
    calculateShockConsciousnessValue({ min: 0, value: 80, max: 100 }, "cancelled"),
    80
  );
});

test("actual restored health replenishes consciousness one-for-one up to maximum", () => {
  const resource = { min: 0, value: 12, max: 50 };
  assert.equal(calculateConsciousnessRecoveryValue(resource, 7), 19);
  assert.equal(calculateConsciousnessRecoveryValue(resource, 100), 50);
  assert.equal(calculateConsciousnessRecoveryValue(resource, -5), 12);
});

test("persisted consciousness value and spent fields remain coherent", () => {
  assert.deepEqual(
    buildConsciousnessValueData({ min: 0, value: 75, max: 100 }, 40),
    { value: 40, spent: 60 }
  );
  assert.deepEqual(
    buildConsciousnessValueData({ min: 10, value: 75, max: 100 }, -1),
    { value: 0, spent: 100 }
  );
});

test("loss of consciousness captures a fixed numeric wake-up threshold", () => {
  assert.equal(resolveConsciousnessMaximum(60, 100), 100);
  assert.equal(resolveConsciousnessMaximum(120, 100), 100);

  const lost = buildConsciousnessUpdateData({
    min: 0,
    value: 80,
    max: 100,
    recoveryTarget: 0
  }, 0);
  assert.deepEqual(lost, {
    value: 0,
    spent: 100,
    recoveryTarget: 100
  });

  const partial = buildConsciousnessUpdateData({
    min: 0,
    value: 0,
    max: 60,
    recoveryTarget: 100
  }, 60);
  assert.deepEqual(partial, {
    value: 60,
    spent: 40,
    recoveryTarget: 100
  });
  assert.equal(isConsciousnessUnconscious({ max: 60, value: 60, recoveryTarget: 100 }), true);

  const recovered = buildConsciousnessUpdateData({
    min: 0,
    value: 60,
    max: 120,
    recoveryTarget: 100
  }, 100);
  assert.deepEqual(recovered, {
    value: 100,
    spent: 0,
    recoveryTarget: 0
  });
  assert.equal(isConsciousnessUnconscious({ max: 100, value: 100, recoveryTarget: 0 }), false);
});

test("resource normalization always restores the fixed consciousness definition", () => {
  const settings = normalizeResourceSettings([{
    key: "consciousness",
    abbr: "custom",
    label: "Mind",
    formula: "999",
    color: "#123456"
  }]);
  const consciousness = settings.find(entry => entry.key === "consciousness");

  assert.deepEqual(consciousness, {
    key: "consciousness",
    abbr: "con",
    label: "Mind",
    formula: "criticalLimbs",
    color: "#123456"
  });
  assert.equal(settings.filter(entry => entry.key === "consciousness").length, 1);
});

test("legacy hidden shock state preserves accumulated recovery for the visible resource", () => {
  const source = {
    type: "character",
    system: { resources: {} },
    flags: {
      "fallout-maw": {
        shockUnconscious: { target: 30, progress: 4 },
        keep: true
      }
    }
  };

  migrateActorData(source);

  assert.deepEqual(source.system.resources.consciousness, {
    min: 0,
    value: 0,
    spent: Number.MAX_SAFE_INTEGER
  });
  assert.deepEqual(source.flags["fallout-maw"], {
    keep: true,
    legacyConsciousnessMigrationPending: { progress: 4 }
  });
});

test("ready migration persists cleaned legacy data for world and unlinked-token actors", async () => {
  const originalGame = globalThis.game;
  const updates = [];
  const settingWrites = [];
  const createPendingActor = uuid => {
    const source = {
      type: "character",
      system: {
        resources: {
          consciousness: { min: 0, value: 0, spent: Number.MAX_SAFE_INTEGER }
        }
      },
      flags: {
        "fallout-maw": {
          legacyConsciousnessMigrationPending: { progress: 4 }
        }
      }
    };
    return {
      uuid,
      type: "character",
      _source: source,
      system: {
        resources: {
          consciousness: { min: 0, value: 0, spent: 50, max: 50, recoveryTarget: 50 }
        }
      },
      update: async (data, options) => updates.push({ uuid, data, options })
    };
  };
  const worldActor = createPendingActor("Actor.world");
  const tokenActor = createPendingActor("Scene.scene.Token.token.Actor.base");

  globalThis.game = {
    user: { isActiveGM: true },
    settings: {
      get: () => 0,
      set: async (...args) => settingWrites.push(args)
    },
    actors: { contents: [worldActor] },
    scenes: {
      contents: [{
        name: "Scene",
        tokens: [{ actorLink: false, actor: tokenActor }]
      }]
    }
  };

  try {
    assert.deepEqual(
      await migrateWorldConsciousnessData(),
      { migrated: 2, failed: 0 }
    );
  } finally {
    globalThis.game = originalGame;
  }

  assert.equal(updates.length, 2);
  for (const update of updates) {
    assert.deepEqual(update.data, {
      "flags.fallout-maw.-=shockUnconscious": null,
      "flags.fallout-maw.-=legacyConsciousnessMigrationPending": null,
      "system.resources.consciousness.min": 0,
      "system.resources.consciousness.value": 4,
      "system.resources.consciousness.spent": 46,
      "system.combat.consciousnessRecoveryTarget": 50
    });
    assert.equal(update.options.diff, false);
    assert.equal(update.options.recursive, true);
    assert.equal(update.options.falloutMawDocumentMigration, true);
  }
  assert.deepEqual(settingWrites, [["fallout-maw", "documentMigrationVersion", 1]]);
});

test("ready migration preserves imported legacy health-based unconsciousness after the schema version is current", async () => {
  const originalGame = globalThis.game;
  const updates = [];
  const actor = {
    uuid: "Actor.health-unconscious",
    type: "character",
    _source: { type: "character", system: { resources: {} }, flags: {} },
    system: {
      resources: {
        health: { min: 0, value: 0, max: 100 },
        consciousness: { min: 0, value: 50, max: 50, recoveryTarget: 0 }
      }
    },
    statuses: new Set(["unconscious"]),
    update: async (data, options) => updates.push({ data, options })
  };

  globalThis.game = {
    user: { isActiveGM: true },
    settings: {
      get: () => 1,
      set: async () => undefined
    },
    actors: { contents: [actor] },
    scenes: { contents: [] }
  };

  try {
    assert.deepEqual(
      await migrateWorldConsciousnessData(),
      { migrated: 1, failed: 0 }
    );
  } finally {
    globalThis.game = originalGame;
  }

  assert.deepEqual(updates[0].data, {
    "system.resources.consciousness.min": 0,
    "system.resources.consciousness.value": 0,
    "system.resources.consciousness.spent": 50,
    "system.combat.consciousnessRecoveryTarget": 50
  });
  assert.equal(updates[0].options.diff, false);
  assert.equal(updates[0].options.recursive, true);
  assert.equal(updates[0].options.falloutMawDocumentMigration, true);
});
