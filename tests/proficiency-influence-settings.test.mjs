import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  normalizeProficiencySettings,
  resolveProficiencyInfluenceSettings
} = await import("../src/formulas/normalization.mjs");

const BASE_INFLUENCE = Object.freeze({
  accuracy: Object.freeze({ min: 1, max: 40 }),
  damage: Object.freeze({ min: 2, max: 20 }),
  criticalChance: Object.freeze({ min: 0, max: 5 }),
  criticalDamage: Object.freeze({ min: 0, max: 30 })
});

test("proficiencies inherit the base influence until an individual override is enabled", () => {
  const settings = {
    entries: [{ key: "rifle", abbr: "rif", label: "Винтовка", max: 1000 }],
    influence: BASE_INFLUENCE
  };
  const [rifle] = normalizeProficiencySettings(settings);

  assert.equal(rifle.influence.enabled, false);
  assert.deepEqual(resolveProficiencyInfluenceSettings(settings, rifle), BASE_INFLUENCE);
});

test("enabled proficiency influence overrides every base range and resolves by key", () => {
  const settings = {
    entries: [{
      key: "rifle",
      abbr: "rif",
      label: "Винтовка",
      max: 1000,
      influence: {
        enabled: true,
        accuracy: { min: -5, max: 70 },
        damage: { min: 3, max: 35 },
        criticalChance: { min: 1, max: 12 },
        criticalDamage: { min: 10, max: 80 }
      }
    }],
    influence: BASE_INFLUENCE
  };

  assert.deepEqual(resolveProficiencyInfluenceSettings(settings, "rifle"), {
    accuracy: { min: -5, max: 70 },
    damage: { min: 3, max: 35 },
    criticalChance: { min: 1, max: 12 },
    criticalDamage: { min: 10, max: 80 }
  });
});

test("disabled individual values remain stored but gameplay falls back to the base", () => {
  const settings = {
    entries: [{
      key: "rifle",
      abbr: "rif",
      label: "Винтовка",
      max: 1000,
      influence: { enabled: false, accuracy: { min: 9, max: 99 } }
    }],
    influence: BASE_INFLUENCE
  };
  const [rifle] = normalizeProficiencySettings(settings);

  assert.deepEqual(rifle.influence.accuracy, { min: 9, max: 99 });
  assert.deepEqual(resolveProficiencyInfluenceSettings(settings, rifle), BASE_INFLUENCE);
});

test("settings UI and all weapon previews use proficiency-specific influence", async () => {
  const [template, actorSheet, actionHud, attackController, weaponProficiencies] = await Promise.all([
    readFile(new URL("../templates/settings/proficiency-settings-config.hbs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/utils/weapon-proficiencies.mjs", import.meta.url), "utf8")
  ]);

  assert.match(template, /<details[^>]+data-proficiency-row/);
  assert.match(template, /data-individual-influence-enabled/);
  for (const key of ["accuracy", "damage", "criticalChance", "criticalDamage"]) {
    assert.match(template, new RegExp(`data-individual-influence-field="${key}"`));
  }
  for (const source of [actorSheet, actionHud, attackController]) {
    assert.match(source, /weapon-proficiencies\.mjs/);
  }
  assert.match(weaponProficiencies, /getInfluenceSettings:\s*getProficiencyInfluenceSettings/);
});
