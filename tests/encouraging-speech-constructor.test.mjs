import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENCOURAGING_SPEECH_ABILITY_ID,
  buildEncouragingSpeechAbilityFunction,
  migrateEncouragingSpeechCatalog,
  normalizeAbilityFunctions
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
