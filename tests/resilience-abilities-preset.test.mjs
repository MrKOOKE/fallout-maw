import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { computePresetRevision } from "../src/settings/presets/schema.mjs";

test("Fallout-MaW preset contains all completed resilience abilities", async () => {
  const preset = JSON.parse(readFileSync(new URL("../storage/settings-presets/fallout-maw.json", import.meta.url), "utf8"));
  assert.equal(preset.revision, await computePresetRevision(preset));

  const category = preset.settings.find(setting => setting.id === "fallout-maw.abilitiesCatalog")
    .value.categories.find(entry => entry.id === "skill-resilience");
  const findAbility = id => category.abilities.find(ability => ability.id === id);
  const targets = [
    ["8znCekEJNK49lv0s", "Взрывная стойкость"],
    ["Lc52Qeo4C8tc2QBP", "До последней капли"],
    ["zC5SsGZg3BBNE107", "Скала"],
    ["kRw63cXXi8ZItL5o", "Текучая стойка"]
  ];
  for (const [id, name] of targets) assert.equal(findAbility(id)?.name, name);

  const explosive = findAbility(targets[0][0]).system.functions[0];
  assert.equal(explosive.fixedKey, "explosiveResilience");
  assert.equal(explosive.fixedSettings.damageRequired, 200);

  const lastDrop = findAbility(targets[1][0]).system.functions[0];
  assert.equal(lastDrop.fixedKey, "lastDrop");
  assert.equal(lastDrop.fixedSettings.energyCost, 50);
  assert.equal(lastDrop.fixedSettings.redistributionMinimumPercent, -50);

  const rock = findAbility(targets[2][0]).system.functions[0];
  assert.deepEqual(rock.changes.map(change => [change.key, change.value]), [
    ["system.combat.unconsciousnessResistance", "50"],
    ["system.skillCheck.actions.grappleResistance.bonus", "50"],
    ["system.skillCheck.actions.knockdownResistance.bonus", "50"],
    ["system.skillCheck.actions.knockbackResistance.bonus", "50"]
  ]);

  const fluid = findAbility(targets[3][0]).system.functions[0];
  const damageTypeKeys = preset.settings.find(setting => setting.id === "fallout-maw.damageTypes").value
    .filter(entry => !entry.locked && !entry.system)
    .map(entry => entry.key);
  assert.equal(fluid.type, "activeApplication");
  assert.equal(fluid.activeSettings.persistent, true);
  assert.deepEqual(fluid.activeSettings.costs.map(cost => [cost.resourceKey, cost.formula]), [
    ["power", "10"],
    ["actionOrReactionPoints", "1"]
  ]);
  assert.deepEqual(fluid.changes.map(change => change.key), damageTypeKeys.map(key => (
    `system.damageResistanceBonuses.all.${key}`
  )));
  assert.equal(fluid.changes.every(change => change.value === "10+resilience/10"), true);
  const selection = fluid.conditions.find(condition => condition.type === "limitedChanges");
  assert.equal(selection.limitFormula, "1+resilience/100");
  assert.equal(selection.selectionMode, "upTo");
  const copies = fluid.conditions.find(condition => condition.type === "limitedEffectCopies");
  assert.equal(copies.limit, 1);
  assert.equal(copies.refresh, true);

  const painLord = category.abilities.find(ability => ability.name === "Владыка боли")
    .system.functions.find(entry => entry.fixedKey === "painLord");
  assert.equal(painLord.fixedSettings.useIncomingDamageBeforeResistance, true);
});

test("both ability editors expose and preserve existing-effect refresh", () => {
  const editor = readFileSync(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8");
  const catalogTemplate = readFileSync(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8");
  const itemTemplate = readFileSync(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8");

  assert.match(editor, /refresh:\s*readBooleanField\(row\.querySelector\("\[data-field='conditionRefresh'\]"\),\s*false\)/);
  assert.match(catalogTemplate, /data-field="conditionRefresh"\s+\{\{#if refresh\}\}checked\{\{\/if\}\}/);
  assert.equal((itemTemplate.match(/name="\{\{functionPath\}\}\.\{\{functionIndex\}\}\.conditions\.\{\{index\}\}\.refresh"/g) ?? []).length, 2);
});
