import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENCOURAGING_SPEECH_ABILITY_ID,
  buildEncouragingSpeechAbilityFunction,
  migrateEncouragingSpeechCatalog,
  normalizeActiveApplicationSettings,
  normalizeAbilityFunctions,
  preserveMissingActiveApplicationTargetSettings
} from "../src/settings/abilities.mjs";
import { computePresetRevision } from "../src/settings/presets/schema.mjs";

const SKILLS = [
  { key: "rangedCombat", abbr: "ran", label: "Ranged", formula: "0" },
  { key: "speech", abbr: "spe", label: "Speech", formula: "0" },
  { key: "science", abbr: "sci", label: "Science", formula: "0" }
];

test("Encouraging Speech constructor derives every bonus row from configured skills", () => {
  const built = buildEncouragingSpeechAbilityFunction({
    id: "function-id",
    type: "activeApplication",
    activeSettings: {
      costs: [{ id: "power-id", resourceKey: "power", formula: "1" }],
      excludeSelf: false
    },
    changes: [{
      id: "existing-ranged",
      key: "system.skills.rangedCombat.bonus",
      type: "add",
      value: "1"
    }],
    conditions: [{ id: "limited-id", type: "limitedChanges", limit: 1 }]
  }, SKILLS);

  assert.equal(built.type, "activeApplication");
  assert.deepEqual(built.changes.map(change => change.key), [
    "system.skills.rangedCombat.bonus",
    "system.skills.speech.bonus",
    "system.skills.science.bonus"
  ]);
  assert.equal(built.changes[0].id, "existing-ranged");
  assert.ok(built.changes.every(change => change.value === "10+spe/10"));
  assert.deepEqual(built.activeSettings.costs.map(cost => [
    cost.resourceKey,
    cost.formula,
    cost.overloadAmount,
    cost.overloadDurationSeconds
  ]), [
    ["power", "30", 60, 14400],
    ["actionPoints", "5", 0, 0]
  ]);
  assert.equal(built.activeSettings.targetSelectionMode, "all");
  assert.deepEqual(built.activeSettings.targetGroups, ["ally"]);
  assert.equal(built.activeSettings.radiusFormula, "10+spe/10");
  assert.equal(built.activeSettings.changeEvaluation, "source");
  assert.equal(built.conditions.find(condition => condition.type === "limitedChanges")?.limitFormula, "1+spe/50");
  assert.equal(built.conditions.find(condition => condition.type === "duration")?.durationSeconds, 3600);
});

test("limitedChanges normalization preserves formula and legacy numeric fallback", () => {
  const [normalized] = normalizeAbilityFunctions([{
    id: "function-id",
    type: "activeApplication",
    changes: [],
    conditions: [
      { id: "formula", type: "limitedChanges", limit: 1, limitFormula: "1+spe/50" },
      { id: "legacy", type: "limitedChanges", limit: 2 }
    ]
  }]);
  assert.equal(normalized.conditions[0].limit, 1);
  assert.equal(normalized.conditions[0].limitFormula, "1+spe/50");
  assert.equal(normalized.conditions[1].limitFormula, "2");
});

test("active application preserves an explicit empty target relation selection", () => {
  assert.deepEqual(normalizeActiveApplicationSettings({}).targetGroups, ["ally"]);
  assert.deepEqual(normalizeActiveApplicationSettings({ targetGroups: [] }).targetGroups, []);
  assert.deepEqual(
    normalizeActiveApplicationSettings({ targetGroups: { 0: null, 1: null, 2: null } }).targetGroups,
    []
  );
  assert.deepEqual(normalizeActiveApplicationSettings({ targetGroups: ["invalid"] }).targetGroups, []);

  const [first] = normalizeAbilityFunctions([{
    id: "active",
    type: "activeApplication",
    activeSettings: {
      targetMode: "others",
      targetGroups: []
    }
  }]);
  const [second] = normalizeAbilityFunctions([first]);
  assert.deepEqual(first.activeSettings.targetGroups, []);
  assert.deepEqual(second.activeSettings.targetGroups, []);
});

test("active application targetLimit preserves formulas and legacy numbers", () => {
  assert.equal(normalizeActiveApplicationSettings({ targetLimit: "2+spe/50" }).targetLimit, "2+spe/50");
  assert.equal(normalizeActiveApplicationSettings({ targetLimit: 5 }).targetLimit, "5");
  assert.equal(normalizeActiveApplicationSettings({}).targetLimit, "1");
});

test("active application defensively normalizes legacy duplicate checkbox values", () => {
  const unchecked = normalizeActiveApplicationSettings({
    wallsBlock: ["false", null],
    excludeSelf: ["false", null]
  });
  const checked = normalizeActiveApplicationSettings({
    wallsBlock: ["false", "true"],
    excludeSelf: ["false", "true"]
  });

  assert.equal(unchecked.wallsBlock, false);
  assert.equal(unchecked.excludeSelf, false);
  assert.equal(checked.wallsBlock, true);
  assert.equal(checked.excludeSelf, true);
});

test("hidden active-application target controls retain their previous configuration", () => {
  const previous = {
    targetSelectionMode: "all",
    targetLimit: "2+spe/50",
    targetGroups: [],
    excludeSelf: false,
    radiusFormula: "10+spe/10",
    wallsBlock: true,
    changeEvaluation: "source"
  };
  const selfModeSubmit = preserveMissingActiveApplicationTargetSettings({
    name: "Speech",
    costs: [],
    targetMode: "self"
  }, previous);

  assert.equal(selfModeSubmit.targetSelectionMode, "all");
  assert.equal(selfModeSubmit.targetLimit, "2+spe/50");
  assert.deepEqual(selfModeSubmit.targetGroups, []);
  assert.equal(selfModeSubmit.excludeSelf, false);
  assert.equal(selfModeSubmit.radiusFormula, "10+spe/10");
  assert.equal(selfModeSubmit.wallsBlock, true);
  assert.equal(selfModeSubmit.changeEvaluation, "source");

  const explicitOthersSubmit = preserveMissingActiveApplicationTargetSettings({
    targetMode: "others",
    targetGroups: ["enemy", "neutral"],
    excludeSelf: true,
    wallsBlock: false
  }, previous);
  assert.deepEqual(explicitOthersSubmit.targetGroups, ["enemy", "neutral"]);
  assert.equal(explicitOthersSubmit.excludeSelf, true);
  assert.equal(explicitOthersSubmit.wallsBlock, false);
});

test("catalog migration targets one source id, preserves metadata, and is idempotent", () => {
  const original = {
    categories: [{
      id: "speech",
      abilities: [{
        id: ENCOURAGING_SPEECH_ABILITY_ID,
        name: "Renamed by user",
        description: "keep me",
        custom: { preserved: true },
        system: {
          acquisition: { difficulty: 150 },
          functions: [{ id: "function-id", type: "activeApplication", changes: [], conditions: [] }]
        }
      }]
    }]
  };
  const first = migrateEncouragingSpeechCatalog(original, SKILLS);
  assert.equal(first.changed, true);
  assert.equal(first.matchCount, 1);
  const migrated = first.catalog.categories[0].abilities[0];
  assert.equal(migrated.name, "Renamed by user");
  assert.equal(migrated.description, "keep me");
  assert.deepEqual(migrated.custom, { preserved: true });
  assert.deepEqual(migrated.system.acquisition, { difficulty: 150 });

  const second = migrateEncouragingSpeechCatalog(first.catalog, SKILLS);
  assert.equal(second.changed, false);
  assert.equal(second.catalog, first.catalog);
});

test("bundled main preset contains the fully assembled ability and a valid revision", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const presetPath = path.resolve(here, "../storage/settings-presets/fallout-maw.json");
  const preset = JSON.parse(fs.readFileSync(presetPath, "utf8"));
  const catalog = preset.settings.find(setting => setting.id === "fallout-maw.abilitiesCatalog")?.value;
  const skillSettings = preset.settings.find(setting => setting.id === "fallout-maw.skillSettings")?.value?.entries ?? [];
  const abilities = (catalog?.categories ?? []).flatMap(category => category.abilities ?? []);
  const ability = abilities.find(entry => entry.id === ENCOURAGING_SPEECH_ABILITY_ID);
  const active = ability?.system?.functions?.find(entry => entry.type === "activeApplication");

  assert.ok(ability);
  assert.equal(active.changes.length, skillSettings.length);
  assert.ok(active.changes.every(change => change.key && change.value === "10+spe/10"));
  assert.deepEqual(active.activeSettings.targetGroups, ["ally"]);
  assert.equal(active.activeSettings.targetSelectionMode, "all");
  assert.equal(active.activeSettings.radiusFormula, "10+spe/10");
  assert.equal(active.conditions.find(condition => condition.type === "duration")?.durationSeconds, 3600);
  assert.equal(await computePresetRevision(preset), preset.revision);
});
