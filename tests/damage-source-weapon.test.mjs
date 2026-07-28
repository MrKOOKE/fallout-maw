import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getDamageSourceAdjustedNoiseLevel,
  resolveDamageSourceAnimationKey
} from "../src/utils/damage-source-weapon.mjs";

const [modelSource, attackSource, actorSheetSource, itemSheetSource, itemSheetTemplate] = await Promise.all([
  readFile(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8")
]);

test("weapon animation takes priority over the installed damage source animation", () => {
  assert.equal(resolveDamageSourceAnimationKey("weapon.shot", "source.shot"), "weapon.shot");
  assert.equal(resolveDamageSourceAnimationKey("", "source.shot"), "source.shot");
  assert.equal(resolveDamageSourceAnimationKey("   ", " source.shot "), "source.shot");
});

test("damage source noise is an additive modifier clamped at zero", () => {
  assert.equal(getDamageSourceAdjustedNoiseLevel({ noiseLevel: 4 }, { noiseLevel: 2 }), 6);
  assert.equal(getDamageSourceAdjustedNoiseLevel({ noiseLevel: 4 }, { noiseLevel: -9 }), 0);
  assert.equal(getDamageSourceAdjustedNoiseLevel({}, { noiseLevel: 2 }), 3);
});

test("damage source animation fallback and noise modifier are wired through schema, editor, runtime, and tooltip", () => {
  assert.match(modelSource, /noiseLevel: new NumberField\(\{ required: true, integer: true, initial: 0 \}\)/);
  assert.match(itemSheetTemplate, /name="system\.functions\.damageSource\.noiseLevel"/);
  assert.match(itemSheetTemplate, /name="\{\{path\}\}\.attackAnimationKey" value="\{\{weaponData\.attackAnimationKey\}\}" placeholder="\{\{effectiveWeaponData\.attackAnimationKey\}\}"/);
  assert.match(itemSheetTemplate, /name="\{\{path\}\}\.volley\.explosionAnimationKey" value="\{\{weaponData\.volley\.explosionAnimationKey\}\}" placeholder="\{\{effectiveWeaponData\.volley\.explosionAnimationKey\}\}"/);
  for (const source of [attackSource, actorSheetSource, itemSheetSource]) {
    assert.match(source, /resolveDamageSourceAnimationKey\(/);
    assert.match(source, /getDamageSourceAdjustedNoiseLevel\(/);
  }
  assert.match(actorSheetSource, /DamageSourceNoiseLevelModifier/);
});
