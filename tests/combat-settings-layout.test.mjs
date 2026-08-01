import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [template, styles, applicationSource, ru, en] = await Promise.all([
  readFile(new URL("../templates/settings/combat-settings-config.hbs", import.meta.url), "utf8"),
  readFile(new URL("../styles/fallout-maw.css", import.meta.url), "utf8"),
  readFile(new URL("../src/apps/combat-settings-config.mjs", import.meta.url), "utf8"),
  readFile(new URL("../lang/ru.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../lang/en.json", import.meta.url), "utf8").then(JSON.parse)
]);

const EXPECTED_FIELDS = [
  "turnOrder.scheme",
  "weaponSwitch.actionPointCost",
  "reactions.timeoutSeconds",
  "dodge.attackCostPercent",
  "dodge.burstMultiplier",
  "dodge.volleyMultiplier",
  "dodge.areaDamageMultiplier",
  "dodge.roundRecoveryPercent",
  "limbDestruction.nonPlayerMode",
  "limbDestruction.playerOwnedMode",
  "knockback.repeatDifficultyThreshold",
  "knockback.repeatDifficultyStep",
  "areas.movementDamageThresholdFormula",
  "weaponSkillDamage.meleeCombat.flat",
  "weaponSkillDamage.meleeCombat.percent",
  "weaponSkillDamage.rangedCombat.flat",
  "weaponSkillDamage.rangedCombat.percent",
  "weaponSkillDamage.throwing.flat",
  "weaponSkillDamage.throwing.percent",
  "unconsciousness.normalDamageFormula",
  "unconsciousness.negativeDamageFormula",
  "unconsciousness.criticalDamageFormula",
  "unconsciousness.stateMultiplierFormula"
];

test("combat settings redesign preserves every submitted setting exactly once", () => {
  const names = Array.from(template.matchAll(/\bname="([^"]+)"/g), match => match[1]).sort();
  assert.deepEqual(names, [...EXPECTED_FIELDS].sort());
});

test("combat settings use distinct semantic cards and a footer outside the scroll surface", () => {
  const sections = Array.from(
    template.matchAll(/data-combat-settings-section="([^"]+)"/g),
    match => match[1]
  );

  assert.deepEqual(sections, [
    "general",
    "dodge",
    "limbs",
    "knockback",
    "areas",
    "skill-damage",
    "unconsciousness"
  ]);
  assert.match(template, /class="fallout-maw-combat-settings-scroll"/);
  assert.match(template, /  <\/div>\r?\n\r?\n  <footer class="sheet-footer fallout-maw-combat-settings-footer">/);
  assert.doesNotMatch(template, /<section class="fallout-maw-panel">/);
});

test("combat settings layout owns scrolling, responsive grids, and a non-overlaying footer", () => {
  assert.match(styles, /\.application\.fallout-maw-combat-settings \.window-content \{[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.fallout-maw-combat-settings-scroll \{[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.fallout-maw-combat-settings-sections \{[\s\S]*?repeat\(auto-fit,/);
  assert.match(styles, /\.fallout-maw-combat-settings-section \{[\s\S]*?border-left:/);
  assert.match(styles, /\.application\.fallout-maw-combat-settings \.fallout-maw-combat-settings-footer \{[\s\S]*?position: static;/);
  assert.match(styles, /@container combat-settings \(max-width: 38rem\)/);
  assert.match(applicationSource, /width:\s*840,[\s\S]*height:\s*820/);
  assert.match(applicationSource, /scrollable:\s*\["\.fallout-maw-combat-settings-scroll"\]/);
});

test("combat settings section headings are localized in both bundled languages", () => {
  const keys = [
    "ConfigurationHint",
    "GeneralTitle",
    "DodgeTitle",
    "KnockbackTitle",
    "WeaponSkillDamageTitle",
    "UnconsciousnessTitle"
  ];

  for (const key of keys) {
    assert.equal(typeof ru.FALLOUTMAW.Settings.Combat[key], "string");
    assert.equal(typeof en.FALLOUTMAW.Settings.Combat[key], "string");
    assert.ok(ru.FALLOUTMAW.Settings.Combat[key].trim());
    assert.ok(en.FALLOUTMAW.Settings.Combat[key].trim());
  }
});
