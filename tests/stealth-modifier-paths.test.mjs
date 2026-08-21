import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import {
  NOISE_LEVEL_FLAT_EFFECT_KEY,
  NOISE_LEVEL_PERCENT_EFFECT_KEY,
  STEALTH_MOVEMENT_THRESHOLD_PERCENT_EFFECT_KEY
} from "../src/stealth/effect-keys.mjs";
import { getActorAdjustedNoiseLevel } from "../src/stealth/noise.mjs";

const originalCanvas = globalThis.canvas;

afterEach(() => {
  globalThis.canvas = originalCanvas;
});

test("stealth movement and general noise effect keys have stable actor paths", () => {
  assert.equal(STEALTH_MOVEMENT_THRESHOLD_PERCENT_EFFECT_KEY, "system.stealth.movementThresholdPercent");
  assert.equal(NOISE_LEVEL_FLAT_EFFECT_KEY, "system.stealth.noiseLevelFlat");
  assert.equal(NOISE_LEVEL_PERCENT_EFFECT_KEY, "system.stealth.noiseLevelPercent");
});

test("all new stealth effect paths exist as ordinary derived Actor fields and autocomplete tokens", async () => {
  const [actorModel, tokens] = await Promise.all([
    readFile(new URL("../src/data/models/actor-data-models.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/utils/effect-key-tokens.mjs", import.meta.url), "utf8")
  ]);
  const autocompleteKeys = {
    movementThresholdPercent: "stealthMovementThresholdPercent",
    noiseLevelFlat: "noiseLevelFlat",
    noiseLevelPercent: "noiseLevelPercent"
  };
  for (const [key, autocompleteKey] of Object.entries(autocompleteKeys)) {
    assert.match(actorModel, new RegExp(`${key}: new NumberField\\(`));
    assert.match(tokens, new RegExp(`key: "${autocompleteKey}"`));
  }
});

test("noise adds flat scene meters before percent without changing authored integer cells", () => {
  globalThis.canvas = { scene: { grid: { distance: 2 } }, grid: { distance: 9 } };
  const actor = { system: { stealth: { noiseLevelFlat: 2, noiseLevelPercent: 50 } } };
  assert.equal(getActorAdjustedNoiseLevel(actor, 4), 7.5);
  assert.equal(getActorAdjustedNoiseLevel({ system: { stealth: { noiseLevelFlat: -20 } } }, 4), 0);
  assert.equal(getActorAdjustedNoiseLevel({ system: { stealth: { noiseLevelPercent: 50 } } }, 1), 1.5);
});

test("noise modifiers are applied at both detection and preview boundaries", async () => {
  const [weaponNoise, detection, preview] = await Promise.all([
    readFile(new URL("../src/stealth/weapon-noise.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/stealth/detection.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/stealth/visualization.mjs", import.meta.url), "utf8")
  ]);
  assert.match(weaponNoise, /getActorAdjustedNoiseLevel\(hiddenToken\.actor, noiseLevel\)/);
  assert.match(detection, /normalizeWeaponNoiseRadius\(noiseLevel\)/);
  assert.match(preview, /getActorAdjustedNoiseLevel\(token\.actor, noiseLevel\)/);
});
