import assert from "node:assert/strict";
import test from "node:test";

import {
  activeEffectChangesEqual,
  canonicalizeActiveEffectChanges,
  canonicalizeActiveEffectChangeValue
} from "../src/utils/active-effect-source.mjs";

test("ActiveEffect values follow Foundry's recursive JSON migration semantics", () => {
  assert.equal(canonicalizeActiveEffectChangeValue("60"), 60);
  assert.equal(canonicalizeActiveEffectChangeValue("-0.5"), -0.5);
  assert.equal(canonicalizeActiveEffectChangeValue("true"), true);
  assert.equal(canonicalizeActiveEffectChangeValue("null"), null);
  assert.deepEqual(canonicalizeActiveEffectChangeValue('{"n":1}'), { n: 1 });
  assert.equal(canonicalizeActiveEffectChangeValue('"60"'), 60);
  assert.equal(canonicalizeActiveEffectChangeValue("5+ath/10"), "5+ath/10");
});

test("ActiveEffect source rows discard runtime-only preparation data", () => {
  assert.deepEqual(canonicalizeActiveEffectChanges([{
    id: "source-row-id",
    key: "system.resources.actionPoints.bonus",
    type: "add",
    value: " 60 ",
    phase: "initial",
    priority: "20",
    effect: { id: "runtime-effect" }
  }]), [{
    key: "system.resources.actionPoints.bonus",
    type: "add",
    value: 60,
    phase: "initial",
    priority: 20
  }]);
});

test("typed runtime and serialized legacy ActiveEffect values compare equal", () => {
  const persisted = [{
    key: "system.resources.actionPoints.bonus",
    type: "add",
    value: "60",
    phase: "initial",
    priority: null
  }, {
    key: "system.resources.dodge.bonus",
    type: "add",
    value: "5+ath/10",
    phase: "initial",
    priority: null
  }];
  const prepared = [{
    ...persisted[0],
    value: 60,
    effect: { id: "prepared-effect" }
  }, {
    ...persisted[1],
    effect: { id: "prepared-effect" }
  }];

  assert.equal(activeEffectChangesEqual(persisted, prepared), true);
  assert.equal(activeEffectChangesEqual(persisted, [{
    ...prepared[0],
    value: 61
  }, prepared[1]]), false);
});
