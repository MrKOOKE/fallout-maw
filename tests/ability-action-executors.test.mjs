import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  utils: {
    randomID: () => "test-id"
  }
};

const {
  ABILITY_ACTION_EXECUTOR_MODES,
  ABILITY_ACTION_TYPES,
  createAbilityAction,
  normalizeAbilityAction
} = await import("../src/settings/abilities.mjs");

test("legacy actions default to the source actor executor", () => {
  const action = normalizeAbilityAction({ type: ABILITY_ACTION_TYPES.weaponAttack });
  assert.equal(action.executorMode, ABILITY_ACTION_EXECUTOR_MODES.source);
});

test("constructor preserves target actors as weapon-action executors", () => {
  const action = normalizeAbilityAction({
    ...createAbilityAction(ABILITY_ACTION_TYPES.weaponAttack),
    executorMode: ABILITY_ACTION_EXECUTOR_MODES.targets
  });
  assert.equal(action.executorMode, ABILITY_ACTION_EXECUTOR_MODES.targets);
});
