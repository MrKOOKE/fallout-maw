import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  normalizeIlluminationLevel
} = await import("../src/abilities/environment-conditions.mjs");

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
