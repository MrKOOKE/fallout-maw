import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SYSTEM_ID } from "../src/constants.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizeQualityServiceSettings
} from "../src/settings/abilities.mjs";
import {
  QUALITY_SERVICE_GRANT_FLAG_KEY,
  QUALITY_SERVICE_HOLD_FLAG_KEY,
  buildQualityServiceGrantEffectData,
  buildQualityServiceHoldEffectData,
  findQualityServiceGrant,
  getQualityServiceTier,
  getQualityServiceTiers
} from "../src/abilities/quality-service.mjs";
import {
  EQUIPMENT_BONUS_EFFECTIVENESS_PERCENT_EFFECT_KEY,
  PROTECTION_EFFECTIVENESS_PERCENT_EFFECT_KEY,
  scaleEquipmentProtectionValue,
  scaleEquippedItemEffectChange
} from "../src/items/equipment-effectiveness.mjs";
import {
  buildEquippedItemDamageMitigation,
  expandLimbDamageMapSelectors,
  prepareEquipmentDamageMitigationValue
} from "../src/items/damage-mitigation-preparation.mjs";

test("quality service defines the exact 10, 20 and 40 energy profiles", () => {
  const tiers = getQualityServiceTiers(normalizeQualityServiceSettings());
  assert.deepEqual(tiers.map(({ id, holdEnergy, damagePercent, criticalChance, criticalDamagePercent, accuracy, protectionPercent, equipmentBonusPercent }) => ({
    id,
    holdEnergy,
    damagePercent,
    criticalChance,
    criticalDamagePercent,
    accuracy,
    protectionPercent,
    equipmentBonusPercent
  })), [
    { id: "10", holdEnergy: 10, damagePercent: 5, criticalChance: 0, criticalDamagePercent: 0, accuracy: 10, protectionPercent: 5, equipmentBonusPercent: 0 },
    { id: "20", holdEnergy: 20, damagePercent: 10, criticalChance: 3, criticalDamagePercent: 0, accuracy: 20, protectionPercent: 10, equipmentBonusPercent: 0 },
    { id: "40", holdEnergy: 40, damagePercent: 15, criticalChance: 5, criticalDamagePercent: 20, accuracy: 30, protectionPercent: 15, equipmentBonusPercent: 15 }
  ]);
});

test("quality service keeps every tier configurable without losing the other defaults", () => {
  const settings = normalizeQualityServiceSettings({
    tiers: [{
      id: "20",
      holdEnergy: 25,
      damagePercent: 12,
      criticalChance: 4,
      criticalDamagePercent: 8,
      accuracy: 22,
      protectionPercent: 11,
      equipmentBonusPercent: 6
    }]
  });
  assert.equal(settings.tiers[0].holdEnergy, 10);
  assert.deepEqual(settings.tiers[1], {
    id: "20",
    holdEnergy: 25,
    damagePercent: 12,
    criticalChance: 4,
    criticalDamagePercent: 8,
    accuracy: 22,
    protectionPercent: 11,
    equipmentBonusPercent: 6
  });
  assert.equal(settings.tiers[2].holdEnergy, 40);
});

test("quality service grant uses ordinary combat and equipment-effectiveness keys", () => {
  const fixture = createEffectFixture();
  const tier = getQualityServiceTier({}, "40");
  const grant = buildQualityServiceGrantEffectData({ ...fixture, tier });
  const hold = buildQualityServiceHoldEffectData({ ...fixture, tier, targetEffectId: "grant" });

  assert.equal(grant.showIcon, 0);
  assert.equal(hold.showIcon, 0);
  assert.equal(grant.name, "Качественное обслуживание");
  assert.equal("sourceActorName" in grant.flags[SYSTEM_ID][QUALITY_SERVICE_GRANT_FLAG_KEY], false);
  assert.deepEqual(grant.system.changes.map(change => [change.key, change.value]), [
    ["system.combat.damagePercent", "15"],
    ["system.combat.criticalChance", "5"],
    ["system.combat.criticalDamagePercent", "20"],
    ["system.combat.accuracy", "30"],
    [PROTECTION_EFFECTIVENESS_PERCENT_EFFECT_KEY, "15"],
    [EQUIPMENT_BONUS_EFFECTIVENESS_PERCENT_EFFECT_KEY, "15"]
  ]);
  assert.equal(grant.flags[SYSTEM_ID][QUALITY_SERVICE_GRANT_FLAG_KEY].tierId, "40");
  assert.equal(hold.flags[SYSTEM_ID][QUALITY_SERVICE_HOLD_FLAG_KEY].tierId, "40");
  assert.equal(hold.flags[SYSTEM_ID].damageEffect.resources.power, 40);
  assert.equal(hold.flags[SYSTEM_ID].damageEffect.color, "#8fd3ff");
  assert.equal(findQualityServiceGrant({ effects: [{ id: "grant", active: true, disabled: false, ...grant }] })?.id, "grant");
});

test("equipment effectiveness scales only positive bonuses from equipped item effects", () => {
  const actor = { system: { equipmentEffectiveness: { protectionPercent: 15, bonusPercent: 15 } } };
  const equippedItem = {
    documentName: "Item",
    system: { equipped: true, placement: { mode: "equipment" } }
  };
  const unequippedItem = {
    documentName: "Item",
    system: { equipped: false, placement: { mode: "equipment" } }
  };

  assert.equal(scaleEquipmentProtectionValue(actor, 20), 23);
  assert.equal(scaleEquippedItemEffectChange(actor, {
    type: "add",
    value: 20,
    effect: { parent: equippedItem }
  }).value, 23);
  assert.equal(scaleEquippedItemEffectChange(actor, {
    type: "add",
    value: -20,
    effect: { parent: equippedItem }
  }).value, -20);
  assert.equal(scaleEquippedItemEffectChange(actor, {
    type: "add",
    value: 20,
    effect: { parent: unequippedItem }
  }).value, 20);
});

test("damage mitigation preparation exposes exact item and external-effect layers only on demand", () => {
  const limbs = { torso: { label: "Туловище" } };
  const damageTypes = [{ key: "physical", label: "Физический" }];
  const armor = {
    id: "armor",
    type: "gear",
    name: "Броня",
    img: "armor.webp",
    system: {
      equipped: true,
      functions: {
        condition: { enabled: true, value: 60, max: 100, weakeningThreshold: 20 },
        damageMitigation: {
          enabled: true,
          mode: "defense",
          entries: { torso: { physical: { value: 20 } } }
        }
      }
    }
  };
  const actor = { system: { equipmentEffectiveness: { protectionPercent: 25 } } };

  const prepared = buildEquippedItemDamageMitigation([armor], limbs, damageTypes, actor, { includeSources: true });
  assert.equal(prepared.defenses.torso.physical, 20);
  assert.deepEqual(prepared.defenseSources.torso.physical, [{
    itemId: "armor",
    name: "Броня",
    img: "armor.webp",
    baseValue: 20,
    weakenedValue: 16,
    value: 20,
    protectionPercent: 25
  }]);

  const lightweight = buildEquippedItemDamageMitigation([armor], limbs, damageTypes, actor);
  assert.equal(lightweight.defenses.torso.physical, 20);
  assert.equal(lightweight.defenseSources, null);
  assert.equal(lightweight.resistanceSources, null);

  assert.equal(prepareEquipmentDamageMitigationValue(armor, {
    system: { equipmentEffectiveness: { protectionPercent: 15 } }
  }, 97, {
    mitigationActive: true,
    weakening: { active: true, ratio: 1 }
  }).value, 111);

  assert.equal(expandLimbDamageMapSelectors({
    all: { all: 1, physical: 2 },
    torso: { all: 4, physical: 8 }
  }, limbs, damageTypes).torso.physical, 15);
});

test("quality service is an active fixed function on the shared maintained-target path", async () => {
  const [normalized] = normalizeAbilityFunctions([{
    id: "quality",
    type: ABILITY_FUNCTION_TYPES.fixed,
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.qualityService,
    fixedSettings: {}
  }]);
  assert.equal(normalized.fixedKey, ABILITY_FIXED_FUNCTION_KEYS.qualityService);
  assert.equal(normalized.changes.length, 0);

  const [
    fixed,
    app,
    template,
    compactTemplate,
    actorModel,
    damageMitigationPreparation,
    effectTokens,
    catalogTemplate,
    itemTemplate,
    actorSheet,
    indicatorsTemplate,
    styles
  ] = await Promise.all([
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/quality-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/actor/quality-service.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/actor/perfect-fit.hbs", import.meta.url), "utf8"),
    readFile(new URL("../src/data/models/actor-data-models.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/items/damage-mitigation-preparation.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/utils/effect-key-tokens.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/actor/parts/indicators-tab.hbs", import.meta.url), "utf8"),
    readFile(new URL("../styles/fallout-maw.css", import.meta.url), "utf8")
  ]);
  assert.match(fixed, /key:\s*ABILITY_FIXED_FUNCTION_KEYS\.qualityService[\s\S]*?active:\s*true/);
  assert.match(fixed, /MAINTAINED_TARGET_DEFINITIONS/);
  assert.match(fixed, /definition\.effects\.findGrant\(targetActor\)/);
  assert.match(fixed, /isActorInActiveCombat\(sourceActor\)/);
  assert.match(app, /getQualityServiceTiers/);
  assert.match(app, /findQualityServiceGrant\(actor\)/);
  assert.match(app, /tierId:\s*tier\.id/);
  assert.match(template, /data-action="tier"/);
  assert.match(template, /fallout-maw-maintained-target-row/);
  assert.match(compactTemplate, /fallout-maw-maintained-target-row/);
  assert.doesNotMatch(compactTemplate, /fallout-maw-anatomy-race/);
  assert.match(actorModel, /equipmentEffectiveness:[\s\S]*?protectionPercent:[\s\S]*?bonusPercent:/);
  assert.match(actorModel, /buildEquippedItemDamageMitigation/);
  assert.doesNotMatch(actorModel, /includeSources:\s*true/);
  assert.match(damageMitigationPreparation, /includeSources = false/);
  assert.match(damageMitigationPreparation, /scaleEquipmentProtectionValue\(actor,\s*weakenedValue\)/);
  assert.match(effectTokens, /PROTECTION_EFFECTIVENESS_PERCENT_EFFECT_KEY/);
  assert.match(effectTokens, /EQUIPMENT_BONUS_EFFECTIVENESS_PERCENT_EFFECT_KEY/);
  assert.match(catalogTemplate, /fixed\.qualityService\.tiers\.\{\{id\}\}\.holdEnergy/);
  assert.match(itemTemplate, /fixedSettings\.tiers\.\{\{@index\}\}\.equipmentBonusPercent/);
  assert.match(actorSheet, /includeSources:\s*true/);
  assert.match(actorSheet, /prepareActorDamageMitigationEntries/);
  assert.match(actorSheet, /prepareCell:\s*cell\s*=>/);
  assert.match(actorSheet, /data-item-value-breakdown/);
  assert.match(actorSheet, /renderItemValueBreakdownTooltipHTML\(breakdown\)/);
  assert.match(actorSheet, /effectSource:\s*"effect"/);
  assert.doesNotMatch(actorSheet, /Сторонняя эффективность защиты|Сторонние эффекты и способности/);
  assert.match(indicatorsTemplate, /fallout-maw-mitigation-current-value/);
  assert.match(indicatorsTemplate, /data-tooltip-html="\{\{tooltipHTML\}\}"/);
  assert.match(styles, /\.fallout-maw-quality-tier\s*\{[\s\S]*?height:\s*auto/);
});

function createEffectFixture() {
  return {
    sourceActor: { uuid: "Actor.source", name: "Source" },
    abilityItem: { id: "ability", uuid: "Actor.source.Item.ability", name: "Качественное обслуживание", img: "ability.webp" },
    abilityFunction: { id: "function" },
    targetActor: { uuid: "Actor.target", name: "Target", img: "target.webp" }
  };
}
