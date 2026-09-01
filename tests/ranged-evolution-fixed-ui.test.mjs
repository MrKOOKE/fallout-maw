import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EDITORS = {
  catalog: await readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8"),
  item: await readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8")
};

const SETTINGS = [
  ["cascade", "fixedCascadeSettings", ["accuracyPerStack", "damagePercentPerStack", "maxStacks", "initialStacks", "periodicGain", "periodicIntervalSeconds", "weaponSwitchGain", "resetOnRepeatedWeapon"]],
  ["bullseye", "fixedBullseyeSettings", ["energyCost", "innateDifficultyIgnorePercent", "penetrationBonusFormula", "maxStacks"]],
  ["keepAwayKnockdown", "fixedKeepAwayKnockdownSettings", ["activationEnergyCost", "overloadEnergyCost", "overloadDurationSeconds", "baseDifficulty", "lostHealthPercentMultiplier"]],
  ["counterSniperGuaranteed", "fixedCounterSniperGuaranteedSettings", ["reactionEnergyCost", "reactionOverloadEnergyCost", "reactionOverloadDurationSeconds", "guaranteedHitChanceThreshold"]],
  ["guardianAngel", "fixedGuardianAngelSettings", ["reactionEnergyCost", "guaranteedHitChanceThreshold"]],
  ["hunterRace", "fixedHunterRaceSettings", ["energyCost", "overloadEnergyCost", "overloadDurationSeconds", "durationSeconds", "accuracyBonus", "damagePercentBonus", "criticalChanceBonus"]],
  ["trophyCollector", "fixedTrophyCollectorSettings", ["markDurationSeconds", "maximumStrength", "accuracyPerStack", "incomingDamagePercentPerStack", "criticalChancePerStack", "resilienceSkillKey", "resilienceDifficultyFormula", "stunPercent", "stunDurationSeconds"]],
  ["ricochetMastery", "fixedRicochetMasterySettings", ["activationEnergyCost", "overloadEnergyCost", "overloadDurationSeconds", "maxReflections", "maximumConeDegrees", "accuracyBonusPerReflection", "damagePercentBonusPerReflection", "penetrationBonusPerReflection"]],
  ["corpseAfterCorpse", "fixedCorpseAfterCorpseSettings", ["activationEnergyCost", "overloadEnergyCost", "overloadDurationSeconds", "damagePercentBonus", "attackWaitDurationSeconds"]],
  ["hawkEyePiercing", "fixedHawkEyePiercingSettings", ["defenseIgnorePercent", "resistanceIgnorePercent"]],
  ["trueBullet", "fixedTrueBulletSettings", ["activationEnergyCost", "overloadEnergyCost", "overloadDurationSeconds", "criticalSuccessChanceThreshold"]]
];

test("all ranged evolution fixed settings are editable in both ability editors", () => {
  for (const [fixedKey, contextKey, fields] of SETTINGS) {
    assert.match(EDITORS.catalog, new RegExp(`\\{\\{#if ${contextKey}\\}\\}`));
    assert.match(EDITORS.item, new RegExp(`\\{\\{#if ${contextKey}\\}\\}`));
    for (const field of fields) {
      assert.match(EDITORS.catalog, new RegExp(`data-field="fixed\\.${fixedKey}\\.${field}"`));
      const itemBlockStart = EDITORS.item.indexOf(`{{#if ${contextKey}}}`);
      const itemBlockEnd = EDITORS.item.indexOf("\n    {{#if fixed", itemBlockStart + 1);
      const itemBlock = EDITORS.item.slice(itemBlockStart, itemBlockEnd < 0 ? undefined : itemBlockEnd);
      assert.match(itemBlock, new RegExp(`fixedSettings\\.${field}"`));
    }
  }
});

test("catalog reader covers every ranged evolution fixed settings contract", async () => {
  const source = await readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8");
  for (const [fixedKey, contextKey, fields] of SETTINGS) {
    assert.match(source, new RegExp(`ABILITY_FIXED_FUNCTION_KEYS\\.${fixedKey}`));
    assert.match(source, new RegExp(`"${contextKey}"`));
    for (const field of fields) assert.match(source, new RegExp(`"${field}"`));
  }
});

test("Cascade is edited only through its own fixed function", async () => {
  for (const template of Object.values(EDITORS)) {
    assert.doesNotMatch(template, /cascadeMaxStacks|cascadeIntervalSeconds/u);
  }
  assert.match(EDITORS.catalog, /data-field="fixed\.cascade\.maxStacks"/u);
  assert.match(EDITORS.catalog, /data-field="fixed\.cascade\.periodicIntervalSeconds"/u);
  const itemBlockStart = EDITORS.item.indexOf("{{#if fixedCascadeSettings}}");
  const itemBlockEnd = EDITORS.item.indexOf("\n    {{#if fixed", itemBlockStart + 1);
  const itemBlock = EDITORS.item.slice(itemBlockStart, itemBlockEnd < 0 ? undefined : itemBlockEnd);
  assert.match(itemBlock, /fixedSettings\.maxStacks/u);
  assert.match(itemBlock, /fixedSettings\.periodicIntervalSeconds/u);

  const source = await readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"cascadeMaxStacks"|"cascadeIntervalSeconds"/u);
});
