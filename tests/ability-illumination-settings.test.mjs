import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { invalidateLightingAnalysisCache } from "../src/stealth/lighting.mjs";

const originalCanvas = globalThis.canvas;
afterEach(() => {
  invalidateLightingAnalysisCache();
  invalidateAbilityConditionLightingCache();
  if (originalCanvas === undefined) delete globalThis.canvas;
  else globalThis.canvas = originalCanvas;
});

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject: (target, source) => ({ ...target, ...source })
  }
};
globalThis.game = {
  settings: {
    get: () => ({
      difficultyLevels: [
        { label: "Ночь", threshold: 1, difficultyBonus: 0 },
        { label: "Лампа", threshold: 0.4, difficultyBonus: 50 },
        { label: "Прожектор", threshold: 0, difficultyBonus: 100 }
      ]
    })
  }
};

const {
  getIlluminationLevelChoices,
  normalizeIlluminationLevel,
  getActorIlluminationPercent,
  illuminationConditionApplies,
  invalidateAbilityConditionLightingCache
} = await import("../src/abilities/environment-conditions.mjs");

test("ability conditions follow level-only moves and shared region invalidation without retaining stale light", () => {
  const behavior = { type: "adjustDarknessLevel", active: true, system: { mode: 0, modifier: 1 } };
  globalThis.canvas = {
    level: { id: "surface" },
    scene: { regions: [{ includedInLevel: level => level === "basement", testPoint: () => true, behaviors: [behavior] }] },
    environment: { darknessLevel: 0 },
    effects: { getDarknessLevel: () => 0 }
  };
  const actor = { uuid: "Actor.level-test" };
  const token = { actor, document: { level: "surface", getVisibilityTestPoints: () => [{ x: 20, y: 20, elevation: 0 }] } };
  const context = { actorToken: token };
  assert.equal(getActorIlluminationPercent(actor, context), 100);
  assert.equal(illuminationConditionApplies(actor, { illuminationLevel: "1" }, context), false);
  token.document.level = "basement";
  assert.equal(getActorIlluminationPercent(actor, context), 0);
  assert.equal(illuminationConditionApplies(actor, { illuminationLevel: "1" }, context), true);
  behavior.system.modifier = 0;
  invalidateLightingAnalysisCache();
  assert.equal(getActorIlluminationPercent(actor, context), 100);
  assert.equal(illuminationConditionApplies(actor, { illuminationLevel: "1" }, context), false);
});

test("ability illumination choices come directly from current stealth difficulty rows", () => {
  assert.deepEqual(getIlluminationLevelChoices("0.4"), [
    { value: "1", label: "Ночь", selected: false },
    { value: "0.4", label: "Лампа", selected: true },
    { value: "0", label: "Прожектор", selected: false }
  ]);
  assert.equal(normalizeIlluminationLevel("unconfigured"), "0");
});

test("ability Item schema accepts dynamic configured illumination thresholds", async () => {
  const source = await readFile(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8");
  const field = source.match(/illuminationLevel: new StringField\(\{(?<body>[\s\S]*?)\}\),\s*damageTypeKeys:/)?.groups?.body ?? "";
  assert.match(field, /initial: "0"/);
  assert.doesNotMatch(field, /choices:/);
  assert.doesNotMatch(source, /\["normal", "shadow", "dim", "dark", "blackout"\]/);
});
