import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  itemSheetSource,
  catalogEditorSource,
  modelSource,
  itemTemplate,
  catalogTemplate
] = await Promise.all([
  readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8"),
  readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
  readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8")
]);

test("both attack-action editors expose outcome-bound critical damage only", () => {
  const itemAttackTemplate = itemTemplate.slice(
    itemTemplate.indexOf("data-attack-action-settings"),
    itemTemplate.indexOf(
      "</section>\n    {{/with}}\n    {{/if}}",
      itemTemplate.indexOf("data-attack-action-settings")
    )
  );
  const catalogAttackTemplate = catalogTemplate.slice(
    catalogTemplate.indexOf("{{#if attackActionSettings}}"),
    catalogTemplate.indexOf(
      "{{#if activeApplicationSettings}}",
      catalogTemplate.indexOf("{{#if attackActionSettings}}")
    )
  );

  for (const template of [itemAttackTemplate, catalogAttackTemplate]) {
    assert.match(template, /criticalDamage\.outcomeId/);
    assert.match(template, /criticalDamage\.percentFormula/);
    assert.doesNotMatch(template, /criticalDamagePercent/);
  }
  for (const source of [itemSheetSource, catalogEditorSource]) {
    assert.match(source, /Испытание \$\{trialIndex \+ 1} — \$\{labels\[resultKey]/);
    assert.match(source, /choice\.value !== WEAPON_SPECIAL_PROPERTIES\.criticalDamage/);
  }
});

test("critical damage has a typed schema and preserves missing outcome references", () => {
  assert.match(
    modelSource,
    /\[WEAPON_SPECIAL_PROPERTY_CRITICAL_DAMAGE\]:\s*\{\s*criticalDamage:\s*weaponCriticalDamageField\(\)/
  );
  assert.match(modelSource, /outcomeId:\s*new StringField/);
  assert.match(modelSource, /percentFormula:\s*new StringField/);
  for (const source of [itemSheetSource, catalogEditorSource]) {
    assert.match(source, /ветка не найдена/);
  }
});

test("item-sheet special-property mutations submit the live full attack settings", () => {
  const mutationStart = itemSheetSource.indexOf("  #onAddWeaponSpecialProperty(event)");
  const mutationBlock = itemSheetSource.slice(
    mutationStart,
    itemSheetSource.indexOf("  #onAddWeaponRequirement(event)", mutationStart)
  );
  assert.match(
    itemSheetSource,
    /#getSubmittedAttackActionSettings\(path = ""\)[\s\S]*?new FormDataExtended\(this\.form\)[\s\S]*?this\._processFormData/
  );
  assert.equal(
    (mutationBlock.match(/if \(isAttackActionSettingsSection\(section\)\)/g) ?? []).length,
    3
  );
  assert.equal(
    (mutationBlock.match(/#getSubmittedAttackActionSettings\(path\)/g) ?? []).length,
    3
  );
  assert.equal(
    (mutationBlock.match(/#submitCurrentForm\(\{ \[path\]: settings \}\)/g) ?? []).length,
    3
  );
});

test("damage amount and targeting controls only render fields used by their mode", () => {
  for (const template of [itemTemplate, catalogTemplate]) {
    assert.match(template, /\{\{#if damage\.isBase}}[\s\S]*?type="hidden"[^>]+damage\.formula|constructDamageFormula/);
    assert.match(template, /\{\{#if damage\.isFormula}}[\s\S]*?Формула урона/);
    assert.match(template, /\{\{#if damage\.isPercent}}[\s\S]*?Процент базового урона/);
    assert.doesNotMatch(template, /Формула \/ процент/);
  }
  assert.match(
    itemTemplate,
    /\{\{#if isTargetsMode}}[\s\S]*?targetLimitFormula[\s\S]*?\{\{else}}[\s\S]*?sequence\.count/
  );
  assert.match(
    catalogTemplate,
    /\{\{#if attackActionSettings\.isTargets}}[\s\S]*?targetLimitFormula[\s\S]*?\{\{else}}[\s\S]*?sequence\.count/
  );
});
