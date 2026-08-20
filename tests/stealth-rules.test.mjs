import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { invalidateLightingAnalysisCache } from "../src/stealth/lighting.mjs";
import {
  STEALTH_HIDDEN_OBSERVER_DIFFICULTY_MODIFIER,
  calculateLightingModifiers,
  computeStealthDifficulty,
  configureStealthRuleSettingsProvider,
  getDetectionRangeFactor,
  getRuntimeStealthSettings,
  getStealthDifficultyLevel,
  invalidateStealthRuleCache
} from "../src/stealth/rules.mjs";

const originalCanvas = globalThis.canvas;
const originalConfig = globalThis.CONFIG;

const SETTINGS = Object.freeze({
  difficulty: Object.freeze({ skillKey: "naturalist" }),
  detection: Object.freeze({ skillKey: "naturalist", rangeFormula: "5 + skill / 10" }),
  attenuationLevels: Object.freeze([
    Object.freeze({ threshold: 0.75, penaltyPercent: 70 }),
    Object.freeze({ threshold: 0.5, penaltyPercent: 50 }),
    Object.freeze({ threshold: 0, penaltyPercent: 0 })
  ]),
  difficultyLevels: Object.freeze([
    Object.freeze({ label: "Тускло", threshold: 0.75, difficultyBonus: 20 }),
    Object.freeze({ label: "Светло", threshold: 0.5, difficultyBonus: 40 }),
    Object.freeze({ label: "Очень яркий свет", threshold: 0, difficultyBonus: 120 })
  ]),
  autoDetection: Object.freeze({ enabled: true, movementThresholdFormula: "0" })
});

afterEach(() => {
  configureStealthRuleSettingsProvider();
  invalidateStealthRuleCache();
  invalidateLightingAnalysisCache();
  if (originalCanvas === undefined) delete globalThis.canvas;
  else globalThis.canvas = originalCanvas;
  if (originalConfig === undefined) delete globalThis.CONFIG;
  else globalThis.CONFIG = originalConfig;
});

test("runtime stealth settings are read once until explicitly invalidated", () => {
  let reads = 0;
  configureStealthRuleSettingsProvider(() => {
    reads += 1;
    return SETTINGS;
  });

  assert.strictEqual(getRuntimeStealthSettings(), SETTINGS);
  assert.strictEqual(getRuntimeStealthSettings(), SETTINGS);
  assert.equal(reads, 1);

  invalidateStealthRuleCache();
  assert.strictEqual(getRuntimeStealthSettings(), SETTINGS);
  assert.equal(reads, 2);
});

test("lighting thresholds switch exactly at their configured boundaries", () => {
  assert.equal(getStealthDifficultyLevel(0.75, SETTINGS).difficultyBonus, 20);
  assert.equal(getStealthDifficultyLevel(0.749, SETTINGS).difficultyBonus, 40);
  assert.equal(getStealthDifficultyLevel(0.5, SETTINGS).difficultyBonus, 40);
  assert.equal(getStealthDifficultyLevel(0.499, SETTINGS).difficultyBonus, 120);

  assert.ok(Math.abs(getDetectionRangeFactor(0.75, SETTINGS) - 0.3) < Number.EPSILON);
  assert.equal(getDetectionRangeFactor(0.749, SETTINGS), 0.5);
  assert.equal(getDetectionRangeFactor(0.5, SETTINGS), 0.5);
  assert.equal(getDetectionRangeFactor(0.499, SETTINGS), 1);

  assert.deepEqual(calculateLightingModifiers(0.75, SETTINGS), {
    difficultyBonus: 20,
    levelLabel: "Тускло",
    perceptionMultiplier: 1,
    radius: 0,
    threshold: 0.75,
    condition: "Темнота 0.75"
  });
});

test("stealth window keeps only the configured lighting level and numeric values", async () => {
  const template = await readFile(new URL("../templates/actor/stealth-window.hbs", import.meta.url), "utf8");
  assert.match(template, /Освещение:<\/span>\s*<strong>\{\{lighting\.levelLabel\}\}<\/strong>/);
  assert.match(template, /<strong>\{\{stealthValue\}\}<\/strong>/);
  assert.doesNotMatch(template, /stealthValue\}\}%|lighting\.darknessLabel|\{\{radius\}\}|perceptionMultiplier/);
});

test("difficulty combines target skill, lighting and hidden-observer modifier", () => {
  globalThis.CONFIG = { specialStatusEffects: { INVISIBLE: "stealth-hidden" } };
  globalThis.canvas = {
    scene: { grid: { distance: 5 } },
    grid: { size: 100 },
    environment: { darknessLevel: 0.75, globalLightSource: { active: false } },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: () => 0.75,
      testInsideDarkness: () => false
    }
  };
  invalidateLightingAnalysisCache();

  const sourceToken = {
    actor: { statuses: new Set(["stealth-hidden"]) },
    document: {
      getVisibilityTestPoints: () => [{ x: 0, y: 0, elevation: 0 }],
      getCenterPoint: () => ({ x: 0, y: 0, elevation: 0 })
    }
  };
  const targetToken = {
    actor: {
      statuses: new Set(["stealth-hidden"]),
      system: { skills: { naturalist: { value: 31 } } }
    },
    document: {
      getCenterPoint: () => ({ x: 300, y: 400, elevation: 0 })
    }
  };

  const result = computeStealthDifficulty(sourceToken, targetToken, SETTINGS);

  assert.equal(result.baseDifficulty, 31);
  assert.equal(result.lighting.modifiers.difficultyBonus, 20);
  assert.equal(result.hiddenObserverModifier, STEALTH_HIDDEN_OBSERVER_DIFFICULTY_MODIFIER);
  assert.equal(result.difficulty, 1);
  assert.equal(result.advantageCount, 1);
  assert.equal(result.distance, 25);
});

test("negative illumination penalty percent reduces only the lighting difficulty bonus", () => {
  globalThis.CONFIG = { specialStatusEffects: { INVISIBLE: "stealth-hidden" } };
  globalThis.canvas = {
    scene: { grid: { distance: 5 } },
    grid: { size: 100 },
    environment: { darknessLevel: 0.75, globalLightSource: { active: false } },
    effects: {
      lightSources: new Map(),
      getDarknessLevel: () => 0.75,
      testInsideDarkness: () => false
    }
  };
  invalidateLightingAnalysisCache();

  const sourceToken = {
    actor: {
      statuses: new Set(),
      system: { stealth: { illuminationPenaltyPercent: -50 } }
    },
    document: {
      getVisibilityTestPoints: () => [{ x: 0, y: 0, elevation: 0 }],
      getCenterPoint: () => ({ x: 0, y: 0, elevation: 0 })
    }
  };
  const targetToken = {
    actor: {
      statuses: new Set(),
      system: { skills: { naturalist: { value: 31 } } }
    },
    document: {
      getCenterPoint: () => ({ x: 300, y: 400, elevation: 0 })
    }
  };

  const result = computeStealthDifficulty(sourceToken, targetToken, SETTINGS);

  assert.equal(result.baseDifficulty, 31);
  assert.equal(result.lighting.modifiers.baseDifficultyBonus, 20);
  assert.equal(result.lighting.modifiers.illuminationPenaltyPercent, -50);
  assert.equal(result.lighting.modifiers.difficultyBonus, 10);
  assert.equal(result.difficulty, 41);
});
