import assert from "node:assert/strict";
import test from "node:test";
import {
  getNextPeriodicDamageAmount,
  getPeriodicDamageVisualState
} from "../src/canvas/periodic-damage-visual-state.mjs";

const periodic = (amount, extra = {}) => ({
  kind: "periodicDamage", damageTypeKey: "fire", amountPerTick: amount,
  totalTicks: 3, remainingTicks: 3, nextTickTime: 6, ...extra
});
const change = data => ({ key: "system.damageEffects.periodic.test", value: JSON.stringify(data) });
const effect = (...entries) => ({ disabled: false, showIcon: 0, system: { changes: entries.map(change) } });
const actor = (...effects) => ({ system: { resources: { health: { value: 40, max: 100 } } }, effects });

test("noise stays visible for small ticks and saturates at a 20-percent next tick", () => {
  for (const [damage, intensity] of [[1, 0.6675], [5, 0.7375], [10, 0.825], [20, 1], [80, 1]]) {
    const state = getPeriodicDamageVisualState(actor(effect(periodic(damage))));
    assert.ok(Math.abs(state.intensity - intensity) < 1e-12);
    assert.equal(state.healthMax, 100);
  }
});

test("a one-HP tick on a high-health actor remains visible and ending it removes the mask", () => {
  const target = actor(effect(periodic(1)));
  target.system.resources.health.max = 100000;
  const state = getPeriodicDamageVisualState(target);
  assert.ok(state.intensity >= 0.65 && state.intensity < 0.66);
  target.effects[0].system.changes[0].value = JSON.stringify(periodic(1, { remainingTicks: 0 }));
  assert.equal(getPeriodicDamageVisualState(target), null);
});

test("dominance follows the strongest next tick, not duration or remaining total damage", () => {
  const target = actor(
    effect(periodic(8, { damageTypeKey: "fire", totalTicks: 100, remainingTicks: 100 })),
    effect(periodic(12, { damageTypeKey: "poison", totalTicks: 1, remainingTicks: 1 }))
  );
  assert.equal(getPeriodicDamageVisualState(target).damageTypeKey, "poison");
  assert.equal(getPeriodicDamageVisualState(target).intensity, 0.86);
});

test("fragments of one effect tick add across packet identities without merging colors or times", () => {
  const target = actor(effect(
    periodic(6, { limbKey: "arm", sourceIdentity: "first" }),
    periodic(6, { limbKey: "leg", sourceIdentity: "second" }),
    periodic(9, { damageTypeKey: "poison" }),
    periodic(10, { sourceIdentity: "first", nextTickTime: 12 })
  ));
  assert.equal(getPeriodicDamageVisualState(target).amount, 12);
  assert.equal(getPeriodicDamageVisualState(actor(effect(periodic(8)), effect(periodic(7)))).amount, 8);
});

test("burning spread across eight damage packets reaches full noise for a 232 HP tick out of 860 HP", () => {
  const limbs = ["rightArm", "leftArm", "leftLeg", "rightLeg", "leftArm", "leftLeg", "eyes", "rightLeg"];
  const target = actor(effect(...limbs.map((limbKey, index) => periodic(29, {
    limbKey, scope: "healthAndLimb", sourceIdentity: `packet-${index}`,
    totalTicks: 1, remainingTicks: 1, nextTickTime: 2466481
  }))));
  target.system.resources.health.max = 860;
  const state = getPeriodicDamageVisualState(target);
  assert.equal(state.amount, 232);
  assert.equal(state.intensity, 1);
  target.effects.push(effect(periodic(100, { damageTypeKey: "poison" })));
  assert.equal(getPeriodicDamageVisualState(target).damageTypeKey, "fire");
});

test("bleeding reads the next scheduled entry and uses its own damage color", () => {
  const data = {
    kind: "bleedingDamage", damageTypeKey: "bleeding", sourceDamageTypeKey: "cutting",
    tickAmounts: [10, 4, 1], totalTicks: 3, remainingTicks: 2
  };
  assert.equal(getNextPeriodicDamageAmount(data), 4);
  const state = getPeriodicDamageVisualState(actor(effect(data)));
  assert.equal(state.amount, 4);
  assert.equal(state.damageTypeKey, "bleeding");
  assert.equal(getNextPeriodicDamageAmount({ ...data, remainingTicks: 1 }), 1);
  assert.equal(getNextPeriodicDamageAmount({ ...data, remainingTicks: 0 }), 0);
});

test("bleeding from different wounds combines into one blood-colored next tick", () => {
  const target = actor(effect(...["firearm", "cutting"].map(sourceDamageTypeKey => ({
    kind: "bleedingDamage", damageTypeKey: "bleeding", sourceDamageTypeKey,
    tickAmounts: [12, 10, 10, 10], totalTicks: 4, remainingTicks: 4, nextTickTime: 6
  }))));
  const state = getPeriodicDamageVisualState(target);
  assert.equal(state.amount, 24);
  assert.equal(state.damageTypeKey, "bleeding");
  assert.equal(state.intensity, 1);
});

test("inactive, exhausted, healing, equipment-only and zero next ticks create no mask", () => {
  const disabled = { ...effect(periodic(100)), disabled: true };
  const suppressed = { ...effect(periodic(100)), isSuppressed: true };
  const target = actor(disabled, suppressed, effect(
    periodic(100, { remainingTicks: 0 }), periodic(100, { kind: "periodicHealing" }),
    periodic(100, { scope: "itemCondition" }), periodic(-5),
    { kind: "bleedingDamage", remainingTicks: 2, tickAmounts: [0, 100] }
  ));
  assert.equal(getPeriodicDamageVisualState(target), null);
  for (const max of [0, -1, NaN, Infinity, undefined]) {
    target.system.resources.health.max = max;
    assert.equal(getPeriodicDamageVisualState(target), null);
  }
});

test("limb destruction is checked once per limb and removes that limb's forecast", () => {
  const target = actor(effect(periodic(10, { limbKey: "arm" }), periodic(5, { limbKey: "arm" }), periodic(2)));
  let checks = 0;
  const state = getPeriodicDamageVisualState(target, { isLimbDestroyed: () => { checks++; return true; } });
  assert.equal(state.amount, 2);
  assert.equal(checks, 1);
});

test("equal ticks stay stable and invisible effect icons still contribute", () => {
  const state = getPeriodicDamageVisualState(actor(effect(periodic(5)), effect(periodic(5, { damageTypeKey: "cold" }))));
  assert.equal(state.damageTypeKey, "fire");
});

test("updated serialized changes invalidate the parse cache and malformed data is ignored", () => {
  const entry = change(periodic(5));
  const target = actor({ system: { changes: [entry, { key: entry.key, value: "{broken" }] } });
  assert.equal(getPeriodicDamageVisualState(target).amount, 5);
  entry.value = JSON.stringify(periodic(12));
  assert.equal(getPeriodicDamageVisualState(target).amount, 12);
  entry.value = periodic(3);
  assert.equal(getPeriodicDamageVisualState(target).amount, 3);
  entry.value.amountPerTick = 4;
  assert.equal(getPeriodicDamageVisualState(target).amount, 4);
  entry.key = "system.unrelated";
  assert.equal(getPeriodicDamageVisualState(target), null);
});
