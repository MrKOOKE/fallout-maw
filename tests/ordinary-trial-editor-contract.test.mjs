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
const stylesheet = fs.readFileSync(new URL(
  "../styles/fallout-maw.css",
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
  assert.match(branchField, /choices: \["", "construct", "primaryChanges", "primaryChangesPercent"\]/);
  assert.match(branchField, /percentFormula: new StringField/);
  assert.match(branchField, /durationPercentFormula: new StringField/);
});

test("both ordinary Trial editors expose persistent branch panels without the flat accepted-result block", () => {
  for (const template of [catalogTemplate, itemTemplate]) {
    assert.match(template, /Ветки результатов/);
    assert.match(template, /data-sync="ability-trial-branch-\{\{id\}\}"/);
    assert.match(template, /После этой ветки/);
    assert.match(template, /data-construct-type="damage"/);
    assert.match(template, /damageTypeKey|constructDamageTypeKey/);
    assert.match(template, /Добавить последствие/);
    assert.match(template, /conditionTrialLinkType|data-ability-trial-link-type/);
    assert.match(template, /typeChoices/);
    assert.match(template, /isPrimaryChangesPercent/);
    assert.match(template, /Процент основной длительности/);
    assert.doesNotMatch(template, /Длительность эффекта, сек/);
    assert.doesNotMatch(template, /Последствия при подходящем результате/);
  }
  assert.match(catalogTemplate, /data-field="conditionTrialBranchResultKey"/);
  assert.match(catalogTemplate, /data-field="constructDurationAmount"/);
  assert.match(catalogTemplate, /data-field="constructDurationUnit"/);
  assert.match(itemTemplate, /data-ability-trial-branch-result-key/);
  assert.match(itemTemplate, /data-ability-construct-duration-amount/);
  assert.match(itemTemplate, /data-ability-construct-duration-unit/);
});

test("issued abilities and free-settings functions both render the complete ordinary Trial editor", () => {
  for (const marker of [
    "{{#if isTrial}}",
    "data-add-ability-trial-entry",
    "data-add-ability-trial-branch",
    "data-add-ability-trial-link",
    "data-ability-trial-link-type"
  ]) {
    assert.equal(
      itemTemplate.split(marker).length - 1,
      2,
      `Expected the Item sheet marker in both function render paths: ${marker}`
    );
  }
});

test("both editor pipelines read, mutate and clean nested ordinary Trial branches", () => {
  assert.match(catalogEditor, /trialBranches: Array\.from\(row\.querySelectorAll\("\[data-trial-branch-row\]"\)/);
  assert.match(catalogEditor, /branch\.links \?\?= \[\]/);
  assert.match(catalogEditor, /condition\.trialRoutesPrimaryChanges = true/);
  assert.match(catalogEditor, /conditionTrialLinkPercentFormula/);
  assert.match(catalogEditor, /conditionTrialLinkDurationPercentFormula/);
  assert.match(catalogEditor, /conditionTrialLinkType/);
  assert.match(catalogEditor, /const selectedType = String\([\s\S]*conditionTrialLinkType/);
  assert.doesNotMatch(catalogTemplate, /conditionTrialLinkKind/);
  assert.match(catalogEditor, /condition\?\.trialBranches \?\? \[\]\)\.some\(branch/);
  assert.match(itemSheet, /buildItemTrialBranchRows\(condition\?\.trialBranches/);
  assert.match(itemSheet, /branch\.links \?\?= \[\]/);
  assert.match(itemSheet, /condition\.trialRoutesPrimaryChanges = true/);
  assert.match(itemSheet, /ABILITY_TRIAL_LINK_KINDS\.primaryChangesPercent/);
  assert.match(itemSheet, /data-ability-trial-link-type/);
  assert.match(itemSheet, /percentFormula/);
  assert.match(itemSheet, /durationPercentFormula/);
  assert.match(itemSheet, /data-ability-trial-branch-result-key/);
  assert.match(itemSheet, /condition\?\.trialBranches \?\? \[\]\)\.some\(branch/);
});

test("the catalog consequence selector calls an instance handler that can access editor state", () => {
  assert.match(
    catalogEditor,
    /select\.addEventListener\("change", event => this\.#onConditionTrialLinkTypeChange\(event\)\)/
  );
  assert.match(catalogEditor, /\n  #onConditionTrialLinkTypeChange\(event\) \{/);
  assert.doesNotMatch(catalogEditor, /static #onConditionTrialLinkTypeChange/);
});

test("issued abilities rerender after choosing a consequence and keep its delete control on the same row", () => {
  const handler = sourceBetween(
    itemSheet,
    "async #onAbilityTrialLinkTypeChange",
    "#onDeleteAbilityTrialLink"
  );
  assert.match(handler, /await this\.#submitCurrentForm/);
  assert.match(handler, /return this\.render\(\)/);
  assert.equal(
    itemTemplate.split("fallout-maw-trial-link-type-row").length - 1,
    2,
    "Expected the dedicated consequence header row in both Item sheet function render paths"
  );
  assert.equal(
    catalogTemplate.split("fallout-maw-trial-link-type-row").length - 1,
    1
  );
  assert.match(
    stylesheet,
    /\.fallout-maw-trial-link-type-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+2\.5rem;/s
  );
});

test("both display builders expose the selected consequence type to their templates", () => {
  const catalogLinks = sourceBetween(
    catalogEditor,
    "function buildTrialLinkRows",
    "function isAbilityConstructLinked"
  );
  const itemLinks = sourceBetween(
    itemSheet,
    "function buildItemTrialLinkRows",
    "function prepareNewItemOrdinaryTrialConstruct"
  );
  for (const builder of [catalogLinks, itemLinks]) {
    assert.match(builder, /const typeKey =/);
    assert.match(builder, /Выберите последствие/);
    assert.match(builder, /Процент от основных изменений/);
    assert.match(builder, /Самостоятельное: урон/);
    assert.match(builder, /typeChoices,/);
    assert.match(builder, /isPending: !typeKey/);
  }
});

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
