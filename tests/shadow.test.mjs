import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeShadowSettings
} from "../src/settings/abilities.mjs";
import {
  SHADOW_EFFECT_FLAG_KEY,
  getShadowStealthBonus
} from "../src/stealth/shadow.mjs";

test("shadow defaults match the fixed ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.shadow, "shadow");
  assert.deepEqual(normalizeShadowSettings(), {
    activationEnergyCost: 20,
    overloadEnergyCost: 40,
    overloadDurationSeconds: 3600,
    durationSeconds: 12,
    stealthBonus: 100
  });
});

test("shadow stealth bonus applies only to the effect target", () => {
  const makeEffect = ({ targetActorUuid, bonus, disabled = false, expired = false }) => ({
    disabled,
    isExpired: expired,
    getFlag: (_scope, key) => key === SHADOW_EFFECT_FLAG_KEY
      ? { targetActorUuid, stealthBonus: bonus }
      : null
  });
  const actor = {
    effects: [
      makeEffect({ targetActorUuid: "Actor.Target", bonus: 60 }),
      makeEffect({ targetActorUuid: "Actor.Target", bonus: 40 }),
      makeEffect({ targetActorUuid: "Actor.Other", bonus: 500 }),
      makeEffect({ targetActorUuid: "Actor.Target", bonus: 500, disabled: true }),
      makeEffect({ targetActorUuid: "Actor.Target", bonus: 500, expired: true })
    ]
  };

  assert.equal(getShadowStealthBonus(actor, { uuid: "Actor.Target" }), 100);
  assert.equal(getShadowStealthBonus(actor, { uuid: "Actor.Other" }), 500);
  assert.equal(getShadowStealthBonus(actor, { uuid: "Actor.Missing" }), 0);
});

test("shadow is exposed by both editors and wired to skill and resource hooks", async () => {
  const [fixedSource, effectsSource, catalogTemplate, itemTemplate] = await Promise.all([
    fs.readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/abilities/effects.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8"),
    fs.readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8")
  ]);

  assert.match(fixedSource, /key:\s*ABILITY_FIXED_FUNCTION_KEYS\.shadow/);
  assert.match(fixedSource, /requestCustomActorTokenSelection\([\s\S]*isShadowTargetAllowed/);
  assert.match(fixedSource, /getActiveApplicationTargetRelation\(sourceActor, targetActor\) !== "ally"/);
  assert.match(fixedSource, /fallout-maw\.combat\.resource\.spent/);
  assert.match(fixedSource, /applyShadowStealthBonus\(check\)/);
  assert.match(effectsSource, /SHADOW_EFFECT_FLAG_KEY/);
  assert.match(catalogTemplate, /fixedShadowSettings/);
  assert.match(itemTemplate, /data-fixed-shadow-duration-amount/);
});
