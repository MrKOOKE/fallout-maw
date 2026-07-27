import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let generatedId = 0;
globalThis.foundry = {
  utils: {
    randomID: () => `generated-${++generatedId}`,
    deepClone: value => structuredClone(value)
  }
};

const { normalizeAttackActionSettings } = await import(
  "../src/abilities/attack-action-settings.mjs"
);
const { getAbilityAttackActionKey } = await import("../src/combat/attack-source.mjs");

const [
  itemSheetSource,
  catalogEditorSource,
  controllerSource,
  modelSource,
  itemTemplateSource,
  catalogTemplateSource
] = await Promise.all([
  readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8"),
  readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
  readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8")
]);

test("selected-target mode survives normalization and the legacy alias migrates", () => {
  assert.equal(
    normalizeAttackActionSettings({ targeting: { mode: "selectedTargets" } }).targeting.mode,
    "selectedTargets"
  );
  assert.equal(
    normalizeAttackActionSettings({ targeting: { mode: "targets" } }).targeting.mode,
    "selectedTargets"
  );
  assert.equal(
    getAbilityAttackActionKey({ targeting: { mode: "selectedTargets", aimed: false } }),
    "snapshot"
  );
  assert.equal(
    getAbilityAttackActionKey({ targeting: { mode: "selectedTargets", aimed: true } }),
    "aimedShot"
  );
});

test("both editors, the data model, and runtime use the selectedTargets key", () => {
  for (const source of [itemSheetSource, catalogEditorSource]) {
    assert.match(source, /\{\s*value:\s*"selectedTargets",\s*label:\s*"Выбранные цели"/);
    assert.doesNotMatch(source, /\{\s*value:\s*"targets",\s*label:\s*"Выбранные цели"/);
  }
  assert.match(itemTemplateSource, /name="\{\{path}}\.targeting\.mode"/);
  assert.match(catalogTemplateSource, /data-field="attack\.targeting\.mode"/);
  assert.match(
    catalogEditorSource,
    /mode:\s*getValue\("attack\.targeting\.mode",\s*previous\.targeting\.mode\)/
  );
  assert.match(modelSource, /choices:\s*\[[^\]]*"selectedTargets"/);
  assert.match(controllerSource, /settings\.targeting\.mode === "selectedTargets"/);
});

test("attack editors render only fields used by the active targeting and damage modes", () => {
  assert.match(
    itemTemplateSource,
    /\{\{#if isTargetsMode\}\}[\s\S]*?targeting\.targetLimitFormula[\s\S]*?\{\{else\}\}[\s\S]*?sequence\.count[\s\S]*?\{\{\/if\}\}/
  );
  assert.match(
    catalogTemplateSource,
    /\{\{#if attackActionSettings\.isTargets\}\}[\s\S]*?targeting\.targetLimitFormula[\s\S]*?\{\{else\}\}[\s\S]*?sequence\.count[\s\S]*?\{\{\/if\}\}/
  );

  for (const source of [itemTemplateSource, catalogTemplateSource]) {
    assert.match(source, /\{\{#if damage\.isBase\}\}[\s\S]*?type="hidden"[\s\S]*?damage(?:\.formula|Formula)/);
    assert.match(source, /\{\{#if damage\.isFormula\}\}[\s\S]*?damage(?:\.formula|Formula)/);
    assert.match(source, /\{\{#if damage\.isPercent\}\}[\s\S]*?damage(?:\.formula|Formula)/);
    assert.doesNotMatch(source, /Формула \/ процент/);
  }

  assert.match(itemSheetSource, /data-attack-action-structure-change/);
  assert.match(catalogEditorSource, /\[data-field='constructDamageAmountMode'\]/);
});
