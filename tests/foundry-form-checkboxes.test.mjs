import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const NATIVE_BOOLEAN_FIELDS = [
  ["templates/effects/active-effect-sheet.hbs", "disabled"],
  ["templates/global-map/location-editor.hbs", "location.alwaysDiscovered"],
  ["templates/global-map/location-exit-editor.hbs", "exit.alwaysDiscovered"],
  ["templates/global-map/transition-editor.hbs", "transition.hidden"],
  ["templates/item/item-sheet.hbs", "{{functionPath}}.{{functionIndex}}.activeSettings.wallsBlock"],
  ["templates/item/item-sheet.hbs", "{{functionPath}}.{{functionIndex}}.activeSettings.excludeSelf"],
  ["templates/item/item-sheet.hbs", "system.functions.constructPart.critical"],
  ["templates/item/item-sheet.hbs", "system.functions.firstAid.healingIsPercentage"],
  ["templates/settings/damage-type-settings-config.hbs", "settings.bleeding.enabled"],
  ["templates/settings/damage-type-settings-config.hbs", "settings.equipmentConditionDamage.enabled"],
  ["templates/settings/damage-type-settings-config.hbs", "settings.needIncrease.enabled"],
  ["templates/settings/damage-type-settings-config.hbs", "settings.needIncrease.preventHealthDamage"],
  ["templates/settings/damage-type-settings-config.hbs", "settings.periodic.enabled"],
  ["templates/settings/damage-type-settings-config.hbs", "settings.resourceLimit.enabled"],
  ["templates/settings/limb-settings-config.hbs", "limb.critical"],
  ["templates/settings/stealth-settings-config.hbs", "autoDetection.enabled"]
];

function collectFiles(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(filePath, extension);
    return entry.isFile() && filePath.endsWith(extension) ? [filePath] : [];
  });
}

function readAttribute(tag, attribute) {
  const expression = new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return tag.match(expression)?.[2] ?? "";
}

test("Foundry templates never pair a hidden fallback with a checkbox of the same name", () => {
  const violations = [];
  for (const filePath of collectFiles(path.join(ROOT, "templates"), ".hbs")) {
    const fields = new Map();
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/<input\b[^>]*>/gi)) {
      const tag = match[0];
      const name = readAttribute(tag, "name");
      const type = readAttribute(tag, "type").toLowerCase();
      if (!name || !["hidden", "checkbox"].includes(type)) continue;
      if (!fields.has(name)) fields.set(name, new Set());
      fields.get(name).add(type);
    }
    for (const [name, types] of fields) {
      if (!types.has("hidden") || !types.has("checkbox")) continue;
      violations.push(`${path.relative(ROOT, filePath)}: ${name}`);
    }
  }

  assert.deepEqual(violations, []);
});

test("native Foundry boolean fields stay single value-less checkboxes", () => {
  for (const [relativePath, name] of NATIVE_BOOLEAN_FIELDS) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    const tags = Array.from(source.matchAll(/<input\b[^>]*>/gi), match => match[0])
      .filter(tag => readAttribute(tag, "name") === name);
    assert.equal(tags.length, 1, `${relativePath}: expected one ${name} input`);
    const [tag] = tags;
    assert.equal(readAttribute(tag, "type").toLowerCase(), "checkbox");
    assert.doesNotMatch(tag, /\bvalue\s*=/i, `${relativePath}: ${name} must not define value`);
    assert.match(tag, /\bchecked\b/i, `${relativePath}: ${name} must render its saved state`);
  }
});

test("manual ItemSheet change handlers cannot fall through to Foundry autosubmit", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/sheets/item-sheet.mjs"), "utf8");
  const start = source.indexOf("export class FalloutMaWItemSheet");
  const end = source.indexOf("class ContainerSpecialGridApplication");
  assert.ok(start >= 0 && end > start, "Could not isolate FalloutMaWItemSheet source");
  const itemSheetSource = source.slice(start, end);
  const directChangeListeners = Array.from(itemSheetSource.matchAll(/\.addEventListener\(\s*["']change["']/g));

  // One registration belongs to the wrapper itself; the other four only
  // synchronize local UI before Foundry performs its one native autosubmit.
  assert.equal(directChangeListeners.length, 5);
  for (const allowedListener of [
    "element?.addEventListener(\"change\", event => {",
    "select.addEventListener(\"change\", () => syncFixedRescueCountVisibility(select));",
    "select.addEventListener(\"change\", () => syncItemAbilityActionCostVisibility(select));",
    "select.addEventListener(\"change\", () => syncItemAbilityAttackChoiceControls(select));",
    "input.addEventListener(\"change\", markDirty);"
  ]) {
    assert.equal(
      itemSheetSource.split(allowedListener).length - 1,
      1,
      `Unexpected direct change-listener set: ${allowedListener}`
    );
  }
  assert.match(
    itemSheetSource,
    /#addHandledFormChangeListener\(element, listener\)[\s\S]*?#handledFormChangeEvents\.add\(event\)[\s\S]*?listener\(event\)/
  );
  assert.match(
    itemSheetSource,
    /_onChangeForm\(formConfig, event\)[\s\S]*?#handledFormChangeEvents\.has\(event\)[\s\S]*?super\._onChangeForm\(formConfig, event\)/
  );
  assert.match(
    itemSheetSource,
    /const pending = this\.#submitQueue\.then\(process, process\)[\s\S]*?this\.#submitQueue = pending\.catch/
  );
});

test("catalog checkbox readers use checked state instead of the string value", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/apps/ability-catalog-item-editor.mjs"), "utf8");
  const body = source.match(/function readBooleanField\(element, fallback = false\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(body, /element\.type[\s\S]*?checkbox[\s\S]*?element\.checked/);
});

test("both ability editors preserve target controls hidden by self mode", () => {
  const itemSheetSource = fs.readFileSync(path.join(ROOT, "src/sheets/item-sheet.mjs"), "utf8");
  const catalogSource = fs.readFileSync(path.join(ROOT, "src/apps/ability-catalog-item-editor.mjs"), "utf8");

  assert.match(
    itemSheetSource,
    /normalizeSubmittedActiveApplicationFunctions\(form, submitData, this\.item\)/
  );
  assert.match(
    itemSheetSource,
    /getProperty\(currentItem, functionPath\)[\s\S]*?preserveMissingActiveApplicationTargetSettings\(submittedSettings, currentFunction\?\.activeSettings\)/
  );
  assert.match(
    catalogSource,
    /readAbilityFunctions\(this\.form, this\.ability\.system\?\.functions\)/
  );
  assert.match(
    catalogSource,
    /readActiveApplicationSettings\(row, previousFunction\?\.activeSettings\)[\s\S]*?preserveMissingActiveApplicationTargetSettings\(settings, previousValue\)/
  );
});

test("movement-route checkboxes are read from their checked state in both ability editors", () => {
  const itemSheetSource = fs.readFileSync(path.join(ROOT, "src/sheets/item-sheet.mjs"), "utf8");
  const catalogSource = fs.readFileSync(path.join(ROOT, "src/apps/ability-catalog-item-editor.mjs"), "utf8");

  const itemReader = itemSheetSource.match(/function normalizeSubmittedAbilityActionCheckboxes[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(itemReader, /routeAutoRotate/);
  assert.match(itemReader, /routeShowRuler/);
  assert.match(itemReader, /Boolean\(input\.checked\)/);
  assert.equal(itemSheetSource.split("normalizeSubmittedAbilityActionCheckboxes(form, submitData);").length - 1, 2);

  assert.match(catalogSource, /routeAutoRotate:\s*actionRow\.querySelector\([^\n]+\)\?\.checked/);
  assert.match(catalogSource, /routeShowRuler:\s*actionRow\.querySelector\([^\n]+\)\?\.checked/);
});
