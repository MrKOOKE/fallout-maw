import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EDITORS = {
  catalog: await readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8"),
  item: await readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8")
};
const FALLOUT_PRESET = JSON.parse(await readFile(
  new URL("../storage/settings-presets/fallout-maw.json", import.meta.url),
  "utf8"
));

const SETTINGS = [
  ["cascade", "fixedCascadeSettings", ["accuracyPerStack", "damagePercentPerStack", "maxStacks", "initialStacks", "periodicGain", "periodicIntervalSeconds", "weaponSwitchGain", "resetOnRepeatedWeapon"]],
  ["bullseye", "fixedBullseyeSettings", ["energyCost", "innateDifficultyIgnorePercent", "penetrationBonusFormula", "maxStacks"]],
  ["keepAwayKnockdown", "fixedKeepAwayKnockdownSettings", ["activationEnergyCost", "overloadEnergyCost", "overloadDurationSeconds", "baseDifficulty", "lostHealthPercentMultiplier"]],
  ["counterSniperGuaranteed", "fixedCounterSniperGuaranteedSettings", ["reactionEnergyCost", "reactionOverloadEnergyCost", "reactionOverloadDurationSeconds", "guaranteedHitChanceThreshold"]],
  ["guardianAngel", "fixedGuardianAngelSettings", ["reactionEnergyCost", "guaranteedHitChanceThreshold"]],
  ["hunterRace", "fixedHunterRaceSettings", ["energyCost", "overloadEnergyCost", "overloadDurationSeconds", "durationSeconds", "accuracyBonus", "damagePercentBonus", "criticalChanceBonus"]],
  ["trophyCollector", "fixedTrophyCollectorSettings", ["markDurationSeconds", "maximumStrength", "accuracyPerStack", "incomingDamagePercentPerStack", "criticalChancePerStack", "resilienceSkillKey", "resilienceDifficultyFormula", "stunPercent", "stunDurationSeconds"]],
  ["ricochetMastery", "fixedRicochetMasterySettings", ["activationEnergyCost", "overloadEnergyCost", "overloadDurationSeconds", "maxReflections", "maximumConeDegrees", "accuracyBonusPerReflection", "damagePercentBonusPerReflection", "penetrationBonusPerReflection"]],
  ["corpseAfterCorpse", "fixedCorpseAfterCorpseSettings", ["activationEnergyCost", "overloadEnergyCost", "overloadDurationSeconds", "damagePercentBonus", "attackWaitDurationSeconds"]],
  ["hawkEyePiercing", "fixedHawkEyePiercingSettings", ["defenseIgnorePercent", "resistanceIgnorePercent"]],
  ["trueBullet", "fixedTrueBulletSettings", ["activationEnergyCost", "overloadEnergyCost", "overloadDurationSeconds", "criticalSuccessChanceThreshold"]]
];

function collectFixedSettingsTemplateContracts(template) {
  const sectionPattern = /\{\{#if (fixed[A-Z][A-Za-z0-9]*Settings)\}\}/gu;
  const sections = [...template.matchAll(sectionPattern)];
  return new Map(sections.map((section, index) => {
    const contextKey = section[1];
    const start = section.index;
    const end = sections[index + 1]?.index ?? template.length;
    const block = template.slice(start, end);
    const propertyPattern = new RegExp(`${contextKey}\\.([A-Za-z0-9]+)`, "gu");
    return [contextKey, new Set([...block.matchAll(propertyPattern)].map(match => match[1]))];
  }));
}

test("every catalog fixed-settings display contract exists on granted abilities", () => {
  const catalogContracts = collectFixedSettingsTemplateContracts(EDITORS.catalog);
  const itemContracts = collectFixedSettingsTemplateContracts(EDITORS.item);
  for (const [contextKey, catalogFields] of catalogContracts) {
    assert.equal(itemContracts.has(contextKey), true, `${contextKey} is missing from the granted ability editor`);
    const itemFields = itemContracts.get(contextKey);
    for (const field of catalogFields) {
      assert.equal(itemFields.has(field), true, `${contextKey}.${field} is missing from the granted ability editor`);
    }
  }
});

test("all ranged evolution fixed settings are editable in both ability editors", () => {
  for (const [fixedKey, contextKey, fields] of SETTINGS) {
    assert.match(EDITORS.catalog, new RegExp(`\\{\\{#if ${contextKey}\\}\\}`));
    assert.match(EDITORS.item, new RegExp(`\\{\\{#if ${contextKey}\\}\\}`));
    for (const field of fields) {
      assert.match(EDITORS.catalog, new RegExp(`data-field="fixed\\.${fixedKey}\\.${field}"`));
      const itemBlockStart = EDITORS.item.indexOf(`{{#if ${contextKey}}}`);
      const itemBlockEnd = EDITORS.item.indexOf("\n    {{#if fixed", itemBlockStart + 1);
      const itemBlock = EDITORS.item.slice(itemBlockStart, itemBlockEnd < 0 ? undefined : itemBlockEnd);
      assert.match(itemBlock, new RegExp(`fixedSettings\\.${field}"`));
    }
  }
});

test("catalog reader covers every ranged evolution fixed settings contract", async () => {
  const source = await readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8");
  for (const [fixedKey, contextKey, fields] of SETTINGS) {
    assert.match(source, new RegExp(`ABILITY_FIXED_FUNCTION_KEYS\\.${fixedKey}`));
    assert.match(source, new RegExp(`"${contextKey}"`));
    for (const field of fields) assert.match(source, new RegExp(`"${field}"`));
  }
});

test("Cascade is edited only through its own fixed function", async () => {
  for (const template of Object.values(EDITORS)) {
    assert.doesNotMatch(template, /cascadeMaxStacks|cascadeIntervalSeconds/u);
  }
  assert.match(EDITORS.catalog, /data-field="fixed\.cascade\.maxStacks"/u);
  assert.match(EDITORS.catalog, /data-field="fixed\.cascade\.periodicIntervalSeconds"/u);
  const itemBlockStart = EDITORS.item.indexOf("{{#if fixedCascadeSettings}}");
  const itemBlockEnd = EDITORS.item.indexOf("\n    {{#if fixed", itemBlockStart + 1);
  const itemBlock = EDITORS.item.slice(itemBlockStart, itemBlockEnd < 0 ? undefined : itemBlockEnd);
  assert.match(itemBlock, /fixedSettings\.maxStacks/u);
  assert.match(itemBlock, /fixedSettings\.periodicIntervalSeconds/u);

  const source = await readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"cascadeMaxStacks"|"cascadeIntervalSeconds"/u);
});

test("melee evolutions with distinct behavior use distinct fixed functions", () => {
  const catalog = FALLOUT_PRESET.settings.find(entry => entry.id === "fallout-maw.abilitiesCatalog")?.value;
  const abilities = [];
  const visit = ability => {
    abilities.push(ability);
    for (const node of ability.system?.evolution?.nodes ?? []) visit(node.ability);
  };
  for (const category of catalog?.categories ?? []) for (const ability of category.abilities ?? []) visit(ability);
  const byName = new Map(abilities.map(ability => [ability.name, ability]));
  const expected = new Map([
    ["Головорезка", ["headChopper"]],
    ["Рассечение", ["cleave"]],
    ["Рассечение II", ["cleaveMastery"]],
    ["Глубокое проникновение II", ["deepPenetrationPiercing"]],
    ["До кости", ["toTheBone"]],
    ["Страховочка", ["insuranceAttack"]],
    ["Троечка", ["tripleAttack"]],
    ["Парирование", ["parry"]],
    ["Зашибу!", ["spinalStrike"]],
    ["Зашибу! II", ["spinalStrike"]],
    ["Идеальный удар", ["cleanStrike", "idealStrike"]]
  ]);
  for (const [name, keys] of expected) {
    const actual = byName.get(name)?.system?.functions
      ?.filter(entry => entry.type === "fixed")
      .map(entry => entry.fixedKey);
    assert.deepEqual(actual, keys, name);
  }
});

test("melee fixed-function presets retain the live world balance contract", () => {
  const catalog = FALLOUT_PRESET.settings.find(entry => entry.id === "fallout-maw.abilitiesCatalog")?.value;
  const abilities = [];
  const visit = ability => {
    abilities.push(ability);
    for (const node of ability.system?.evolution?.nodes ?? []) visit(node.ability);
  };
  for (const category of catalog?.categories ?? []) for (const ability of category.abilities ?? []) visit(ability);
  const byName = new Map(abilities.map(ability => [ability.name, ability]));
  const expected = [
    ["Вихрь", "whirlwind", { energyCost: 20, overloadEnergyCost: 40, overloadDurationSeconds: 12 }],
    ["Головорезка", "headChopper", { energyCost: 30, overloadEnergyCost: 80, overloadDurationSeconds: 24 }],
    ["Выпад", "lunge", { energyCost: 10, overloadEnergyCost: 40, overloadDurationSeconds: 12, maxCells: 2 }],
    ["Выпад II", "lunge", { energyCost: 10, overloadEnergyCost: 40, overloadDurationSeconds: 12, maxCells: 6 }],
    ["Рассечение", "cleave", { energyCost: 20, overloadEnergyCost: 80, overloadDurationSeconds: 12, maxCells: 6 }],
    ["Рассечение II", "cleaveMastery", { energyCost: 20, overloadEnergyCost: 80, overloadDurationSeconds: 12, maxCells: 6 }],
    ["Глубокое проникновение", "deepPenetration", { energyCost: 10, conversionLimitPercent: 40 }],
    ["Глубокое проникновение II", "deepPenetrationPiercing", { energyCost: 10, conversionLimitPercent: 70 }],
    ["До кости", "toTheBone", { energyCost: 10, conversionLimitPercent: 70 }],
    ["Двоечка", "doubleAttack", { energyCost: 40 }],
    ["Страховочка", "insuranceAttack", { energyCost: 5 }],
    ["Двоечка II", "doubleAttack", { energyCost: 20 }],
    ["Троечка", "tripleAttack", { energyCost: 20 }],
    ["Контр атака", "counterAttack", { reactionEnergyCost: 20, reactionOverloadEnergyCost: 20, reactionOverloadDurationSeconds: 18 }],
    ["Контр атака II", "counterAttack", { reactionEnergyCost: 20, reactionOverloadEnergyCost: 0, reactionOverloadDurationSeconds: 0 }],
    ["Парирование", "parry", { reactionEnergyCost: 20 }],
    ["По хребту", "whereAreYouGoing", { reactionEnergyCost: 20, reactionOverloadEnergyCost: 40, reactionOverloadDurationSeconds: 6 }],
    ["Зашибу!", "spinalStrike", { reactionEnergyCost: 20, reactionOverloadEnergyCost: 40, reactionOverloadDurationSeconds: 6 }],
    ["Зашибу! II", "spinalStrike", { reactionEnergyCost: 20, reactionOverloadEnergyCost: 0, reactionOverloadDurationSeconds: 0 }],
    ["Смертельный удар", "lethalStrike", { activationEnergyCost: 40, overloadEnergyCost: 100, overloadDurationSeconds: 3600, damagePercentBonus: 200, attackWaitDurationSeconds: 12 }],
    ["Резня", "slaughter", { activationEnergyCost: 30, overloadEnergyCost: 100, overloadDurationSeconds: 3600, damagePercentBonus: 200, attackWaitDurationSeconds: 12 }],
    ["Со всей мощи", "fullForce", { energyCost: 10, damagePercentBonus: 100, conditionCostMultiplier: 5, fractionalImpactBonus: 1 }],
    ["Сострясение", "concussion", { activationEnergyCost: 20, overloadEnergyCost: 40, overloadDurationSeconds: 12, advantageCount: 1, normalStunPercent: 25, criticalLimbStunPercent: 50, stunDurationSeconds: 12, highLimbDamagePercent: 50, highDamageDifficultyMultiplier: 1.5, unconsciousnessDifficultyMultiplier: 1.3 }],
    ["Чистый удар", "cleanStrike", { maximumCharges: 1, rechargeSeconds: 6, hitChanceThreshold: 90, penetrationBonus: 20, weaponConditionLossPercent: 50, targetEquipmentDamagePercent: 25, actionPointRestore: 1 }],
    ["Чистый удар II", "cleanStrike", { maximumCharges: 2, rechargeSeconds: 6, hitChanceThreshold: 90, penetrationBonus: 40, weaponConditionLossPercent: 100, targetEquipmentDamagePercent: 50, actionPointRestore: 1 }],
    ["Идеальный удар", "idealStrike", { activationEnergyCost: 20, overloadEnergyCost: 80, overloadDurationSeconds: 18, guaranteedHitChanceThreshold: 10, activeResistanceIgnorePercent: 100 }]
  ];
  for (const [name, fixedKey, settings] of expected) {
    const abilityFunction = byName.get(name)?.system?.functions?.find(entry => entry.fixedKey === fixedKey);
    assert.ok(abilityFunction, `${name}: отсутствует ${fixedKey}`);
    assert.deepEqual(
      Object.fromEntries(Object.keys(settings).map(key => [key, abilityFunction.fixedSettings?.[key]])),
      settings,
      name
    );
  }
});

test("melee evolution behavior is not serialized as switches on base functions", () => {
  const forbidden = [
    "targetLowestCriticalLimb", "cleavePath", "returnCleave", "guaranteedFirstPassHitChanceThreshold",
    "blockedDamageMultiplier", "penetrationMultiplier", "duplicateCount", "duplicateOnlyAfterMiss",
    "duplicateAdvantage", "forceFinalCriticalAfterHits", "preemptive", "disadvantageOnHit",
    "triggerOnApproach", "overloadOnMissOnly", "activeEnabled"
  ];
  const presetText = JSON.stringify(FALLOUT_PRESET.settings.find(entry => entry.id === "fallout-maw.abilitiesCatalog")?.value);
  for (const field of forbidden) assert.doesNotMatch(presetText, new RegExp(`"${field}"`, "u"));
  for (const template of Object.values(EDITORS)) {
    for (const field of forbidden) assert.doesNotMatch(template, new RegExp(`fixedSettings\\.${field}`, "u"));
  }
});

test("Crowd Fighter base discount remains a generic five-meter three-enemy aura", () => {
  const catalog = FALLOUT_PRESET.settings.find(entry => entry.id === "fallout-maw.abilitiesCatalog")?.value;
  const ability = catalog.categories.flatMap(category => category.abilities ?? [])
    .find(entry => entry.name === "Борец с толпой");
  const abilityFunction = ability?.system?.functions?.[0];
  assert.equal(abilityFunction?.type, "effectChanges");
  assert.deepEqual(
    abilityFunction.changes.map(change => [change.key, change.type, change.value]).sort(),
    [
      ["system.costs.actions.aimedMeleeAttack", "add", "-1"],
      ["system.costs.actions.meleeAttack", "add", "-1"]
    ]
  );
  assert.equal(abilityFunction.conditions[0].auraMode, "selfWhenPresent");
  assert.equal(abilityFunction.conditions[0].auraRadiusMeters, "5");
  assert.equal(abilityFunction.conditions[0].requiredCount, "3");
});
