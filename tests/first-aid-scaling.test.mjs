import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateFirstAidScalingMultipliers,
  getFirstAidEffectivenessMultiplier,
  getFirstAidWithdrawalResistanceMultiplier,
  scaleFirstAidDurationSeconds,
  scaleFirstAidSignedValue
} from "../src/utils/first-aid-scaling.mjs";
import { FIRST_AID_EFFECT_KEYS } from "../src/items/first-aid-effect-keys.mjs";
import {
  getFirstAidResolutionActiveUseKeys,
  isActiveUseEffectKey
} from "../src/abilities/active-use-keys.mjs";

test("first aid scaling preserves runtime floor, sign, and minimum magnitude", () => {
  assert.equal(scaleFirstAidSignedValue(5, 1.1), 5);
  assert.equal(scaleFirstAidSignedValue(5, 1.2), 6);
  assert.equal(scaleFirstAidSignedValue(-5, 0.5), -2);
  assert.equal(scaleFirstAidSignedValue(1, 0), 1);
  assert.equal(scaleFirstAidSignedValue(0, 2), 0);
});

test("first aid effectiveness and withdrawal resistance use clamped percent multipliers", () => {
  assert.equal(getFirstAidEffectivenessMultiplier(25.9), 1.25);
  assert.equal(getFirstAidEffectivenessMultiplier(-150), 0);
  assert.equal(getFirstAidWithdrawalResistanceMultiplier(40), 0.6);
  assert.equal(getFirstAidWithdrawalResistanceMultiplier(100), 0);
  assert.equal(getFirstAidWithdrawalResistanceMultiplier(150), 0);
});

test("first aid scaling combines result, source, recipient, duration, healing, and withdrawal", () => {
  const scaling = calculateFirstAidScalingMultipliers({
    resultMultiplier: 0.5,
    outgoingEffectivenessPercent: 20,
    incomingEffectivenessPercent: -25,
    outgoingHealingPercent: 10,
    durationPercent: 50,
    withdrawalResistancePercent: 40
  });

  assert.ok(Math.abs(scaling.effect - 0.45) < Number.EPSILON);
  assert.ok(Math.abs(scaling.healing - 0.495) < Number.EPSILON);
  assert.equal(scaling.duration, 1.5);
  assert.ok(Math.abs(scaling.withdrawalEffect - 0.27) < Number.EPSILON);
  assert.ok(Math.abs(scaling.withdrawalHealing - 0.297) < Number.EPSILON);
  assert.ok(Math.abs(scaling.withdrawalDuration - 0.6) < Number.EPSILON);
});

test("incoming effectiveness scales direct first aid healing and can fully block it", () => {
  const reduced = calculateFirstAidScalingMultipliers({
    incomingEffectivenessPercent: -30
  });
  const blocked = calculateFirstAidScalingMultipliers({
    incomingEffectivenessPercent: -100
  });

  assert.equal(reduced.healing, 0.7);
  assert.equal(blocked.healing, 0);
});

test("first aid duration rounds down, preserves a positive minimum, and can be fully resisted", () => {
  assert.equal(scaleFirstAidDurationSeconds(5, 1.5), 7);
  assert.equal(scaleFirstAidDurationSeconds(5, 0.1), 1);
  assert.equal(scaleFirstAidDurationSeconds(5, 0), 0);
  assert.equal(scaleFirstAidDurationSeconds(0, 2), 0);
});

test("first aid effect keys are exact and participate in active-use accounting", () => {
  assert.deepEqual(FIRST_AID_EFFECT_KEYS, {
    incomingEffectivenessPercent: "system.firstAid.incomingEffectivenessPercent",
    outgoingEffectivenessPercent: "system.firstAid.outgoingEffectivenessPercent",
    durationPercent: "system.firstAid.durationPercent",
    withdrawalResistancePercent: "system.firstAid.withdrawalResistancePercent"
  });

  assert.deepEqual(
    Array.from(getFirstAidResolutionActiveUseKeys({ direction: "outgoing" })),
    [FIRST_AID_EFFECT_KEYS.outgoingEffectivenessPercent]
  );
  assert.deepEqual(
    Array.from(getFirstAidResolutionActiveUseKeys({ direction: "incoming" })),
    [
      FIRST_AID_EFFECT_KEYS.incomingEffectivenessPercent,
      FIRST_AID_EFFECT_KEYS.durationPercent,
      FIRST_AID_EFFECT_KEYS.withdrawalResistancePercent
    ]
  );
  assert.equal(
    Object.values(FIRST_AID_EFFECT_KEYS).every(key => isActiveUseEffectKey(key)),
    true
  );
});
