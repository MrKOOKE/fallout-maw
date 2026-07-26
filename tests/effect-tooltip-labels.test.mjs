import assert from "node:assert/strict";
import test from "node:test";

import { stripEffectTooltipBonusWords } from "../src/utils/effect-tooltip-labels.mjs";

test("effect tooltip labels omit redundant bonus words", () => {
  assert.equal(
    stripEffectTooltipBonusWords("Бонус сопротивлений урону: Все конечности, Огнестрельный"),
    "Сопротивлений урону: Все конечности, Огнестрельный"
  );
  assert.equal(stripEffectTooltipBonusWords("Базовый бонус"), "Базовый");
  assert.equal(stripEffectTooltipBonusWords("Damage resistance bonus"), "Damage resistance");
  assert.equal(stripEffectTooltipBonusWords("Bonus: damage resistance"), "Damage resistance");
  assert.equal(stripEffectTooltipBonusWords("Изменение точности"), "Изменение точности");
});
