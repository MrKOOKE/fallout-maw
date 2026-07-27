import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const catalogEditor = fs.readFileSync(new URL(
  "../src/apps/ability-catalog-item-editor.mjs",
  import.meta.url
), "utf8");
const itemSheet = fs.readFileSync(new URL(
  "../src/sheets/item-sheet.mjs",
  import.meta.url
), "utf8");
const catalogTemplate = fs.readFileSync(new URL(
  "../templates/settings/ability-catalog-item-editor.hbs",
  import.meta.url
), "utf8");
const itemTemplate = fs.readFileSync(new URL(
  "../templates/item/item-sheet.hbs",
  import.meta.url
), "utf8");
const itemModels = fs.readFileSync(new URL(
  "../src/data/models/item-data-models.mjs",
  import.meta.url
), "utf8");

test("ordinary Trial schema persists grouped outcomes, flow and nested consequence links", () => {
  assert.match(itemModels, /trialBranches: new ArrayField\(abilityTrialBranchField\(\)/);
  assert.match(itemModels, /trialRoutesPrimaryChanges: new BooleanField/);
  const branchField = sourceBetween(
    itemModels,
    "function abilityTrialBranchField",
    "function weaponAttackPowerField"
  );
  for (const field of ["id", "name", "resultKeys", "flow", "links"]) {
    assert.match(branchField, new RegExp(`\\b${field}: new `));
  }
  assert.match(branchField, /choices: \["continue", "stopSubject", "stopAll"\]/);
  assert.match(branchField, /choices: \["construct", "primaryChanges", "primaryChangesPercent"\]/);
  assert.match(branchField, /percentFormula: new StringField/);
});

test("both ordinary Trial editors expose persistent branch panels without the flat accepted-result block", () => {
  for (const template of [catalogTemplate, itemTemplate]) {
    assert.match(template, /Ветки результатов/);
    assert.match(template, /data-sync="ability-trial-branch-\{\{id\}\}"/);
    assert.match(template, /После этой ветки/);
    assert.match(template, /data-construct-type="damage"/);
    assert.match(template, /damageTypeKey|constructDamageTypeKey/);
    assert.match(template, /data-trial-link-kind="primaryChanges"/);
    assert.match(template, /data-trial-link-kind="primaryChangesPercent"/);
    assert.match(template, /Основные изменения/);
    assert.match(template, /Самостоятельные:/);
    assert.match(template, /isPrimaryChangesPercent/);
    assert.doesNotMatch(template, /Последствия при подходящем результате/);
  }
  assert.match(catalogTemplate, /data-field="conditionTrialBranchResultKey"/);
  assert.match(itemTemplate, /data-ability-trial-branch-result-key/);
});

test("both editor pipelines read, mutate and clean nested ordinary Trial branches", () => {
  assert.match(catalogEditor, /trialBranches: Array\.from\(row\.querySelectorAll\("\[data-trial-branch-row\]"\)/);
  assert.match(catalogEditor, /branch\.links \?\?= \[\]/);
  assert.match(catalogEditor, /condition\.trialRoutesPrimaryChanges = true/);
  assert.match(catalogEditor, /conditionTrialLinkKind/);
  assert.match(catalogEditor, /conditionTrialLinkPercentFormula/);
  assert.match(catalogEditor, /condition\?\.trialBranches \?\? \[\]\)\.some\(branch/);
  assert.match(itemSheet, /buildItemTrialBranchRows\(condition\?\.trialBranches/);
  assert.match(itemSheet, /branch\.links \?\?= \[\]/);
  assert.match(itemSheet, /condition\.trialRoutesPrimaryChanges = true/);
  assert.match(itemSheet, /ABILITY_TRIAL_LINK_KINDS\.primaryChangesPercent/);
  assert.match(itemSheet, /percentFormula/);
  assert.match(itemSheet, /data-ability-trial-branch-result-key/);
  assert.match(itemSheet, /condition\?\.trialBranches \?\? \[\]\)\.some\(branch/);
});

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
