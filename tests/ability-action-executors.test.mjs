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

test("every shared canvas target-selection mode collapses an open abilities tray and reports cancellation", () => {
  const lifecycle = fs.readFileSync(new URL(
    "../src/canvas/target-selection-lifecycle.mjs",
    import.meta.url
  ), "utf8");
  const tokenSelection = fs.readFileSync(new URL(
    "../src/canvas/custom-token-selection.mjs",
    import.meta.url
  ), "utf8");
  const weaponAttacks = fs.readFileSync(new URL(
    "../src/combat/weapon-attack-controller.mjs",
    import.meta.url
  ), "utf8");
  const fixedAbilities = fs.readFileSync(new URL(
    "../src/abilities/fixed-functions.mjs",
    import.meta.url
  ), "utf8");
  const abilityActions = fs.readFileSync(new URL(
    "../src/abilities/ability-actions.mjs",
    import.meta.url
  ), "utf8");
  const hud = fs.readFileSync(new URL(
    "../src/apps/token-action-hud.mjs",
    import.meta.url
  ), "utf8");

  assert.match(lifecycle, /Hooks\.callAll\(CANVAS_TARGET_SELECTION_STARTED_HOOK, sessionContext\)/);
  assert.match(lifecycle, /Hooks\.callAll\(CANVAS_TARGET_SELECTION_FINISHED_HOOK,/);
  assert.match(tokenSelection, /startCanvasTargetSelectionSession\(\{\s*kind:\s*"tokens"/);
  assert.match(tokenSelection, /targetSelectionSession\.finish\(\{\s*cancelled:\s*!Array\.isArray\(value\) \|\| !value\.length/);
  assert.match(weaponAttacks, /startCanvasTargetSelectionSession\(\{\s*kind:\s*"weaponAttack"/);
  assert.match(weaponAttacks, /startCanvasTargetSelectionSession\(\{\s*kind:\s*"commandedWeaponAttacks"/);
  assert.match(weaponAttacks, /finishTargetSelection\(\{ cancelled: true \}\)/);
  assert.match(weaponAttacks, /const selection = capture\?\.selection \?\? null;[\s\S]*?cancelled: Boolean\(capture\?\.cancelled\)[\s\S]*?capture\?\.cancelled \? "captureCancelled" : "captureFailed"/);
  assert.match(weaponAttacks, /destroyed\?\.targetSelectionOutcome\?\.cancelled/);
  const destroySelectionFinishes = Array.from(weaponAttacks.matchAll(
    /destroy\(\) \{\s*if \(this\.destroyed\) return;\s*this\.finishTargetSelection\(([^)]*)\)/g
  ));
  assert.equal(destroySelectionFinishes.length, 2);
  assert.ok(destroySelectionFinishes.every(match => !match[1].includes("cancelled")));
  assert.match(fixedAbilities, /drawLungeDestinationCandidates\(graphics, candidates\);\s*const targetSelectionSession = startCanvasTargetSelectionSession\(\{\s*kind:\s*"destination"/);
  assert.match(fixedAbilities, /workflow\.cancelled \|\| workflow\.value\?\.cancelled[\s\S]*?notifyAbilityInteractionCancelled\(onInteractionCancelled/);
  assert.match(fixedAbilities, /changeSelection = \{ changes: \[\], ids: \[\], cancelled: false, failed: true \}/);
  assert.match(fixedAbilities, /if \(changeSelection\.failed\)[\s\S]*?status: "failed"[\s\S]*?cancelled: false, reason: "changeSelectionFailed"/);
  assert.match(fixedAbilities, /hasLimitedChanges && !changeSelection\.cancelled && !changeSelection\.changes\.length[\s\S]*?status: "failed"[\s\S]*?cancelled: false, reason: "noSelectableChanges"/);
  assert.match(abilityActions, /!options\.length[\s\S]*?cancelled: false, failed: true, reason: "attackOptionsUnavailable"/);
  assert.match(abilityActions, /if \(!option\) return \{ executions: \[\], cancelled: true, failed: false, reason: "actionSelectionCancelled" \}/);
  assert.match(fixedAbilities, /if \(preparedActions\.failed\)[\s\S]*?status: "failed"[\s\S]*?cancelled: false, reason/);
  assert.match(fixedAbilities, /if \(!selectedSkills\?\.length\) \{\s*notifyAbilityInteractionCancelled\(onInteractionCancelled/);
  assert.match(hud, /Hooks\.on\(CANVAS_TARGET_SELECTION_STARTED_HOOK,[\s\S]*?collapseTray\("abilities"\)/);
  assert.match(hud, /Hooks\.on\(CANVAS_TARGET_SELECTION_FINISHED_HOOK,[\s\S]*?handleCanvasTargetSelectionFinished/);
  assert.match(hud, /context\?\.cancelled[\s\S]*?#cancelAbilityTargetInteraction\(interaction\)/);
  assert.match(hud, /#cancelAbilityTargetInteraction\(interaction\)[\s\S]*?#restoreAbilitiesTray\(interaction\)[\s\S]*?#releaseAbilityTargetInteraction\(interaction\)/);
  assert.match(hud, /onInteractionCancelled:\s*\(\) => this\.#cancelAbilityTargetInteraction\(interaction\)/);
  assert.match(hud, /#beginAbilityTargetInteraction\(\) \{\s*if \(this\.#abilityTargetInteraction && !this\.#abilityTargetInteraction\.released\) return null/);
  assert.match(hud, /if \(!interaction\) \{\s*ui\.notifications\.warn\("Сначала завершите или отмените текущее применение способности\."\);\s*return false/);
  assert.match(hud, /collapseTray\(expectedTray = ""\)[\s\S]*?popup\.hidden = true[\s\S]*?this\.#activeTray = ""/);
  const finishInteractionStart = hud.indexOf("#finishAbilityTargetInteraction(interaction)");
  const finishInteractionEnd = hud.indexOf("#scheduleAbilityTargetInteractionRelease", finishInteractionStart);
  assert.ok(finishInteractionStart >= 0 && finishInteractionEnd > finishInteractionStart);
  assert.doesNotMatch(hud.slice(finishInteractionStart, finishInteractionEnd), /#restoreAbilitiesTray/);
});

test("canvas target-selection sessions finish once and preserve the cancellation outcome", async () => {
  const calls = [];
  const previousHooks = globalThis.Hooks;
  globalThis.Hooks = {
    callAll: (hook, context) => calls.push({ hook, context })
  };
  try {
    const {
      CANVAS_TARGET_SELECTION_FINISHED_HOOK,
      CANVAS_TARGET_SELECTION_STARTED_HOOK,
      startCanvasTargetSelectionSession
    } = await import("../src/canvas/target-selection-lifecycle.mjs");

    const session = startCanvasTargetSelectionSession({ kind: "tokens" });
    assert.equal(calls[0].hook, CANVAS_TARGET_SELECTION_STARTED_HOOK);
    assert.equal(calls[0].context.sessionId, session.sessionId);
    assert.equal(session.finish({ cancelled: true }), true);
    assert.equal(session.finish({ cancelled: false }), false);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].hook, CANVAS_TARGET_SELECTION_FINISHED_HOOK);
    assert.equal(calls[1].context.cancelled, true);
  } finally {
    globalThis.Hooks = previousHooks;
  }
});
