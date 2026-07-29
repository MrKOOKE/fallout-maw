import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getNeedGrowthResistanceEffectKey,
  getNeedSatisfactionEffectivenessEffectKey,
  isNeedChangeModifierEffectKey
} from "../src/needs/need-change-effect-keys.mjs";
import { buildNeedChangeModifierEffectKeyTokens } from "../src/needs/need-change-effect-key-tokens.mjs";
import {
  getNeedGrowthMultiplier,
  getNeedSatisfactionMultiplier,
  scaleGroupedNeedChanges,
  scaleNeedChange,
  scaleNeedChangeExact
} from "../src/needs/need-change-scaling.mjs";
import { isActiveUseEffectKey } from "../src/abilities/active-use-keys.mjs";

test("need modifier keys are derived from the current need key", () => {
  assert.equal(
    getNeedGrowthResistanceEffectKey("addiction"),
    "system.needs.addiction.growthResistancePercent"
  );
  assert.equal(
    getNeedSatisfactionEffectivenessEffectKey("hunger"),
    "system.needs.hunger.satisfactionEffectivenessPercent"
  );
  assert.equal(getNeedGrowthResistanceEffectKey("invalid.key"), "");
  assert.equal(
    isNeedChangeModifierEffectKey("system.needs.customNeed.growthResistancePercent"),
    true
  );
  assert.equal(
    isNeedChangeModifierEffectKey("system.needs.customNeed.satisfactionEffectivenessPercent"),
    true
  );
  assert.equal(isNeedChangeModifierEffectKey("system.needs.customNeed.bonus"), false);
});

test("dynamic tokens use each need's current key and name without a fixed need list", () => {
  const tokens = buildNeedChangeModifierEffectKeyTokens([
    { key: "addiction", abbr: "Зав", label: "Зависимость" },
    { key: "customNeed", abbr: "НП", label: "Новая потребность" }
  ], { group: "Потребности" });

  assert.deepEqual(
    tokens.map(token => [token.label, token.path]),
    [
      [
        "Сопротивление росту (Зависимость)",
        "system.needs.addiction.growthResistancePercent"
      ],
      [
        "Эффективность утоления (Зависимость)",
        "system.needs.addiction.satisfactionEffectivenessPercent"
      ],
      [
        "Сопротивление росту (Новая потребность)",
        "system.needs.customNeed.growthResistancePercent"
      ],
      [
        "Эффективность утоления (Новая потребность)",
        "system.needs.customNeed.satisfactionEffectivenessPercent"
      ]
    ]
  );
});

test("growth resistance affects only positive changes", () => {
  assert.equal(getNeedGrowthMultiplier(50), 0.5);
  assert.equal(getNeedGrowthMultiplier(-50), 1.5);
  assert.equal(scaleNeedChangeExact(20, { growthResistancePercent: 50 }), 10);
  assert.equal(scaleNeedChangeExact(20, { growthResistancePercent: -50 }), 30);
  assert.equal(
    scaleNeedChangeExact(-10, {
      growthResistancePercent: 50,
      satisfactionEffectivenessPercent: 0
    }),
    -10
  );
});

test("satisfaction effectiveness affects only negative changes", () => {
  assert.equal(getNeedSatisfactionMultiplier(-50), 0.5);
  assert.equal(getNeedSatisfactionMultiplier(50), 1.5);
  assert.equal(scaleNeedChangeExact(-10, { satisfactionEffectivenessPercent: -50 }), -5);
  assert.equal(scaleNeedChangeExact(-10, { satisfactionEffectivenessPercent: 50 }), -15);
  assert.equal(
    scaleNeedChangeExact(20, {
      growthResistancePercent: 0,
      satisfactionEffectivenessPercent: -50
    }),
    20
  );
});

test("zero multipliers block only their own direction and exact scaling preserves time fractions", () => {
  assert.equal(scaleNeedChangeExact(20, { growthResistancePercent: 100 }), 0);
  assert.equal(scaleNeedChangeExact(-10, { satisfactionEffectivenessPercent: -100 }), 0);
  assert.equal(scaleNeedChangeExact(1, { growthResistancePercent: 50 }), 0.5);
  assert.equal(scaleNeedChangeExact(-1, { satisfactionEffectivenessPercent: -50 }), -0.5);
  assert.equal(scaleNeedChange(1, { growthResistancePercent: 50 }), 0);
  assert.equal(scaleNeedChange(-1, { satisfactionEffectivenessPercent: -50 }), 0);
});

test("instant changes group each direction before rounding and never cross-apply modifiers", () => {
  assert.deepEqual(
    scaleGroupedNeedChanges([1, 1, -10], {
      growthResistancePercent: 50,
      satisfactionEffectivenessPercent: -50
    }),
    {
      requestedDelta: -8,
      requestedGrowth: 2,
      requestedSatisfaction: -10,
      scaledGrowth: 1,
      scaledSatisfaction: -5,
      scaledDelta: -4
    }
  );
});

test("dynamic need modifier keys participate in active-use accounting", () => {
  assert.equal(
    isActiveUseEffectKey("system.needs.addiction.growthResistancePercent"),
    true
  );
  assert.equal(
    isActiveUseEffectKey("system.needs.hunger.satisfactionEffectivenessPercent"),
    true
  );
});

test("all gameplay need-change routes use the shared runtime", async () => {
  const [damageHub, firstAid, needItem, thresholds] = await Promise.all([
    readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/items/first-aid.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/items/need-change.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/needs/need-thresholds.mjs", import.meta.url), "utf8")
  ]);

  assert.match(damageHub, /applyActorNeedChanges/);
  assert.match(firstAid, /requestNeedChanges/);
  assert.match(needItem, /requestNeedChanges/);
  assert.match(thresholds, /scaleNeedChangeExact/);
});

test("need modifier labels are localized with the final wording", async () => {
  const locale = JSON.parse(await readFile(
    new URL("../lang/ru.json", import.meta.url),
    "utf8"
  ));
  assert.equal(
    locale.FALLOUTMAW.Effects.NeedGrowthResistance,
    "Сопротивление росту ({need})"
  );
  assert.equal(
    locale.FALLOUTMAW.Effects.NeedSatisfactionEffectiveness,
    "Эффективность утоления ({need})"
  );
});
