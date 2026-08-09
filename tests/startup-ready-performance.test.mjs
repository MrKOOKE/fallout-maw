import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const mainSource = fs.readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
const registrationSource = fs.readFileSync(
  new URL("../src/settings/registration.mjs", import.meta.url),
  "utf8"
);
const presetManagerSource = fs.readFileSync(
  new URL("../src/settings/presets/manager.mjs", import.meta.url),
  "utf8"
);

test("ordinary ready startup never audits every inventory or resets every world Actor", () => {
  const readyBody = mainSource.match(
    /async function initializeFalloutMawReadyState\(\) \{([\s\S]*?)\n\}/
  )?.[1] ?? "";

  assert.ok(readyBody);
  assert.doesNotMatch(readyBody, /repairWorldInventories|finalizeSystemSettings|refreshPreparedActors/);
  assert.match(mainSource, /registerInventoryRepairHooks\(\);/);
});

test("world settings reach CONFIG before Foundry performs initial Document preparation", () => {
  const registrationBody = registrationSource.match(
    /export function registerSystemSettings\(\) \{([\s\S]*?)\n\}/
  )?.[1] ?? "";

  assert.ok(registrationBody);
  const toolsIndex = registrationBody.indexOf("registerSettingsPresetTools();");
  const configIndex = registrationBody.indexOf("syncSettingsIntoSystemConfig();");
  const factionIndex = registrationBody.indexOf("registerFactionApi();");
  assert.ok(toolsIndex >= 0 && toolsIndex < configIndex && configIndex < factionIndex);
  assert.doesNotMatch(registrationSource, /refreshPreparedActorsAfterConfig\(\{ worldOnly: true \}\)/);
});

test("a real startup preset application still performs its deferred core refresh", () => {
  const finalizeBody = presetManagerSource.match(
    /export async function finalizeSettingsPresetStartup\(\) \{([\s\S]*?)\n\}/
  )?.[1] ?? "";

  assert.ok(finalizeBody);
  assert.match(finalizeBody, /await enqueuePresetApplyEffects\(\);/);
  assert.doesNotMatch(finalizeBody, /skipCoreEffects:\s*true/);
});

test("ordinary migrated startup performs no preset file I/O or preset application", () => {
  const initializeBody = presetManagerSource.match(
    /export async function initializeSettingsPresets\(\) \{([\s\S]*?)\n\}/
  )?.[1] ?? "";
  const primaryBody = presetManagerSource.match(
    /async function initializePrimaryGM\(\) \{([\s\S]*?)\n\}/
  )?.[1] ?? "";

  assert.ok(initializeBody && primaryBody);
  assert.match(initializeBody, /migrationVersion[\s\S]*?< MIGRATION_VERSION/);
  assert.match(initializeBody, /await loadPresetSources\(\);/);
  assert.doesNotMatch(primaryBody, /applyActiveRevisionIfNeeded/);
});

test("preset autosave is armed only after all ready maintenance has finished", () => {
  const readyBody = mainSource.match(
    /async function initializeFalloutMawReadyState\(\) \{([\s\S]*?)\n\}/
  )?.[1] ?? "";
  const finalizeIndex = readyBody.indexOf("await finalizeSettingsPresetStartup();");

  assert.ok(finalizeIndex > readyBody.indexOf("initializeCraftRecipeWorldIndex();"));
  const afterFinalize = readyBody.slice(
    finalizeIndex + "await finalizeSettingsPresetStartup();".length
  );
  assert.doesNotMatch(afterFinalize, /\bawait\b/);
});
