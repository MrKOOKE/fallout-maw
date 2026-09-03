import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  applyIndependentHealthChange,
  calculateIndependentLimbDamage,
  calculateIntegratedProsthesisHealthLoss,
  createIndependentHealthState,
  usesIndependentHealthModel
} from "../src/combat/independent-health.mjs";
import { normalizePresetDocument } from "../src/settings/presets/schema.mjs";
import { evaluateFormula } from "../src/formulas/evaluation.mjs";
import { normalizeResourceSettings } from "../src/formulas/normalization.mjs";
import {
  RULES_PROFILE_TESTING,
  getActiveRulesProfile,
  registerRulesProfile,
  syncActiveRulesProfile
} from "../src/settings/rules-profiles.mjs";

test("independent health converts actual health loss into percentage limb damage", () => {
  const state = createIndependentHealthState({ min: 0, value: 40, max: 40 });
  const lost = applyIndependentHealthChange(state, 20, "damage");

  assert.equal(lost, 20);
  assert.equal(state.value, 20);
  assert.equal(calculateIndependentLimbDamage(lost, state.max, 2), 100);
  assert.equal(calculateIndependentLimbDamage(50, 40, 2), 250);
});

test("prosthesis integration is the percentage of condition damage transferred to health", () => {
  assert.equal(calculateIntegratedProsthesisHealthLoss(100, 80, 50), 10);
  assert.equal(calculateIntegratedProsthesisHealthLoss(80, 60, 25), 5);
  assert.equal(calculateIntegratedProsthesisHealthLoss(10, 0, 0), 0);
});

test("independent health requires both the active rules profile and race-backed health", () => {
  const actor = { type: "character" };
  const runtime = {
    rulesProfile: { healthFormulaSource: "race" },
    resourceSettings: [{ key: "health", formulaSource: "race" }]
  };
  assert.equal(usesIndependentHealthModel(actor, runtime), true);
  assert.equal(usesIndependentHealthModel({ type: "construct" }, runtime), false);
  assert.equal(usesIndependentHealthModel(actor, {
    ...runtime,
    rulesProfile: { healthFormulaSource: "formula" }
  }), false);
});

test("only the matching active Foundry module may grant its rules profile", () => {
  const originalGame = globalThis.game;
  const module = { id: "fallout-wetton", active: true };
  globalThis.game = {
    modules: new Map([[module.id, module]]),
    settings: { get: () => ({ activePresetId: module.id }) }
  };
  RULES_PROFILE_TESTING.clear();
  try {
    assert.throws(
      () => registerRulesProfile({ id: module.id, active: true }, { id: module.id }),
      /active Foundry module/
    );
    const profile = registerRulesProfile(module, {
      id: module.id,
      healthFormulaSource: "race",
      optionalResourceKeys: ["consciousness", "power"],
      disableConsciousness: true
    });
    syncActiveRulesProfile({ activePresetId: module.id });
    assert.equal(getActiveRulesProfile(), profile);
    module.active = false;
    assert.equal(getActiveRulesProfile(), RULES_PROFILE_TESTING.standard);
  } finally {
    RULES_PROFILE_TESTING.clear();
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
  }
});

test("Fallout-Wetton preset keeps its race and independent-health resource profile", () => {
  const main = JSON.parse(fs.readFileSync(
    new URL("../storage/settings-presets/fallout-maw.json", import.meta.url),
    "utf8"
  ));
  const raceSource = JSON.parse(fs.readFileSync(
    new URL("../../../worlds/fallout/settings-presets/fallout-wetton.json", import.meta.url),
    "utf8"
  ));
  const wetton = normalizePresetDocument(JSON.parse(fs.readFileSync(
    new URL("../../../modules/fallout-wetton/presets/fallout-wetton.json", import.meta.url),
    "utf8"
  )));
  const mainSettings = new Map(main.settings.map(entry => [entry.id, entry.value]));
  const raceSourceSettings = new Map(raceSource.settings.map(entry => [entry.id, entry.value]));
  const settings = new Map(wetton.settings.map(entry => [entry.id, entry.value]));
  const sourceRaces = raceSourceSettings.get("fallout-maw.creatureOptions").races;
  const races = settings.get("fallout-maw.creatureOptions").races;
  const resources = settings.get("fallout-maw.resourceSettings");
  const combat = settings.get("fallout-maw.combatSettings");
  const normalizedResources = normalizeResourceSettings(resources, {
    optionalFixedResourceKeys: ["consciousness", "power"],
    healthFormulaSource: "race"
  });

  assert.equal(races.length, sourceRaces.length);
  assert.deepEqual(races.map(race => race.id), sourceRaces.map(race => race.id));
  assert.ok(races.every(race => race.baseParameters.healthFormula === "20 + str + con * 2"));
  assert.ok(races.every(race => race.progression.healthPerLevel === "1 + con / 3"));
  assert.ok(races.every(race => !Object.hasOwn(race.regeneration, "energyFormula")));
  assert.equal(resources.some(resource => resource.key === "power"), false);
  assert.equal(resources.some(resource => resource.key === "consciousness"), false);
  assert.equal(resources.find(resource => resource.key === "health").formulaSource, "race");
  assert.equal(normalizedResources.some(resource => resource.key === "consciousness"), false);
  assert.equal(combat.limbDestruction.nonPlayerMode, "disabled");
  assert.equal(combat.limbDestruction.playerOwnedMode, "disabled");
  assert.equal(settings.has("fallout-maw.rulesProfile"), false);
  assert.equal(evaluateFormula(races[0].progression.healthPerLevel, {
    characteristicSettings: mainSettings.get("fallout-maw.characteristics"),
    characteristics: { endurance: 9 }
  }) * 10, 40);
});

test("the disabled proficiency profile removes and restores its Foundry settings menu live", () => {
  const registration = fs.readFileSync(
    new URL("../src/settings/registration.mjs", import.meta.url),
    "utf8"
  );

  assert.match(registration, /function onSettingsPresetStateChanged\(state\)[\s\S]*?syncProficiencySettingsMenu\(\);/);
  assert.match(registration, /if \(enabled\) \{[\s\S]*?game\.settings\.registerMenu\(FALLOUT_MAW\.id, "proficiencySettingsMenu"/);
  assert.match(registration, /game\.settings\.menus\.delete\(key\);/);
  assert.match(registration, /instances\.get\("fallout-maw-proficiency-settings"\)\?\.close\(\)/);
  assert.match(registration, /instances\.get\("settings-config"\)\?\.render\(\)/);
});
