import assert from "node:assert/strict";
import fs from "node:fs";
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

test("command abilities are delivered by a one-off builder macro, not a startup migration", () => {
  const macro = fs.readFileSync(new URL(
    "../scripts/ability-builders/01-command-orders.js",
    import.meta.url
  ), "utf8");
  const registration = fs.readFileSync(new URL("../src/settings/registration.mjs", import.meta.url), "utf8");
  assert.match(macro, /o0eHtaXDOfkfOP4M/);
  assert.match(macro, /hXDOkMGJjkPB7WBb/);
  assert.match(macro, /executorMode:\s*"targets"/);
  assert.match(macro, /attackActionKeys:\s*\[actionKey\]/);
  assert.doesNotMatch(registration, /migrateSystemSettings/);
  assert.equal(fs.existsSync(new URL("../src/migrations/settings.mjs", import.meta.url)), false);
});

test("commanded attacks use simultaneous rays and broadcast their previews", () => {
  const source = fs.readFileSync(new URL(
    "../src/combat/weapon-attack-controller.mjs",
    import.meta.url
  ), "utf8");
  assert.match(source, /entries\.every\(canUseCommandedMultiRayCapture\)/);
  assert.match(source, /startCommandedMultiRayAttacksAndWait/);
  assert.match(source, /onBeforeExecute\(selections\)/);
  assert.match(source, /broadcastPreviews\(force = false\)/);
  assert.match(source, /action:\s*"updatePreview"/);
  assert.match(source, /action:\s*"clearPreview"/);
  assert.match(source, /reportedActionPointCost:\s*authorityContext\s*\?\s*selection\.actionPointCost\s*:\s*null/);
});
