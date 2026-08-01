import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [actorSheetSource, tokenActionHudSource] = await Promise.all([
  readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8")
]);

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `Missing start marker: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing end marker: ${endText}`);
  return source.slice(start, end);
}

test("weapon tooltip stats apply all stealth bonuses outside base mode", () => {
  const stats = sliceBetween(
    actorSheetSource,
    "function getWeaponTooltipCalculatedStats",
    "function emptyCombatAttribution"
  );

  assert.match(stats, /const stealth = baseMode \? null : getStealthAttackModifiers\(actor\)/);
  const postCondition = stats.indexOf("const postConditionDamage");
  const stealthDamage = stats.indexOf("calculateStealthDamageBonusAmount");
  assert.ok(postCondition >= 0);
  assert.ok(stealthDamage > postCondition, "stealth damage must be based on post-condition damage");
  assert.match(stats, /damage: postConditionDamage \+ stealthDamageBonusAmount/);
  assert.match(stats, /accuracyBonus:[\s\S]*?\+ toInteger\(stealth\?\.accuracyBonus\)[\s\S]*?- conditionAccuracyPenalty/);
  assert.match(stats, /criticalChanceModifier:[\s\S]*?\+ toInteger\(stealth\?\.criticalChanceBonus\)[\s\S]*?- conditionCritPenalty/);
  assert.match(stats, /criticalDamagePercent:[\s\S]*?\+ toInteger\(stealth\?\.criticalDamageBonusPercent\)/);
});

test("weapon tooltip breakdown attributes formulas and actual stealth damage", () => {
  const breakdowns = sliceBetween(
    actorSheetSource,
    "function buildWeaponTooltipValueBreakdowns",
    "function buildWeaponResourceCostAttributions"
  );
  const helpers = sliceBetween(
    actorSheetSource,
    "function appendStealthAttackAttribution",
    "function appendBreakdownStep"
  );

  assert.ok(
    breakdowns.indexOf("appendStealthAttackDamageAttribution")
      > breakdowns.indexOf("round: Math.floor"),
    "stealth damage attribution must follow condition weakening"
  );
  assert.match(breakdowns, /formula: stealth\?\.accuracyFormula[\s\S]*?formulaValue: stealth\?\.formulaValues\?\.accuracy[\s\S]*?effectAttribution: stealthEffectAttributions\?\.accuracy[\s\S]*?finalValue: stealth\?\.accuracyBonus/);
  assert.match(breakdowns, /formula: stealth\?\.criticalChanceFormula[\s\S]*?formulaValue: stealth\?\.formulaValues\?\.criticalChance[\s\S]*?effectAttribution: stealthEffectAttributions\?\.criticalChance[\s\S]*?finalValue: stealth\?\.criticalChanceBonus/);
  assert.match(breakdowns, /formula: stealth\?\.criticalDamagePercentFormula[\s\S]*?formulaValue: stealth\?\.formulaValues\?\.criticalDamagePercent[\s\S]*?effectAttribution: stealthEffectAttributions\?\.criticalDamagePercent[\s\S]*?finalValue: stealth\?\.criticalDamageBonusPercent/);

  assert.match(actorSheetSource, /STEALTH_ATTACK_BONUS_EFFECT_KEYS\[field\]/);
  assert.match(helpers, /appendAttributionDeltaSources\(breakdown, effectAttribution\?\.sources/);
  assert.match(helpers, /FALLOUTMAW\.Item\.TooltipBreakdownStealthAttack/g);
  assert.match(helpers, /formatActorFormulaForDisplay/);
  assert.match(helpers, /stealth\.damagePercentFormula/);
  assert.match(helpers, /expectedPercent: Math\.max\(0, toInteger\(stealth\.damageBonusPercent\)\)/);
  assert.match(helpers, /contributionUnit: localizeOrFallback\("FALLOUTMAW\.Item\.TooltipBreakdownDamageUnit"/);
});

test("attack-power dialog preview mirrors post-condition stealth math", () => {
  const preview = sliceBetween(
    tokenActionHudSource,
    "function getWeaponAttackPowerPreviewStats",
    "function getWeaponAttackPowerPreviewResourceCosts"
  );

  const postCondition = preview.indexOf("const postConditionDamage");
  const stealthDamage = preview.indexOf("calculateStealthDamageBonusAmount");
  assert.ok(postCondition >= 0);
  assert.ok(stealthDamage > postCondition);
  assert.match(preview, /const stealth = getStealthAttackModifiers\(actor\)/);
  assert.match(preview, /damage: postConditionDamage \+ stealthDamageBonusAmount/);
  assert.match(preview, /\+ toInteger\(stealth\.accuracyBonus\)/);
  assert.match(preview, /\+ toInteger\(stealth\.criticalChanceBonus\)/);
  assert.match(preview, /\+ toInteger\(stealth\.criticalDamageBonusPercent\)/);
});

test("ordinary token HUD weapon tooltip keeps the shared actor-sheet renderer", () => {
  assert.match(
    tokenActionHudSource,
    /import \{ getWeaponTooltipModuleSlotsTabIndex, renderInventoryItemTooltipHTML \} from "\.\.\/sheets\/actor-sheet\.mjs"/
  );
  assert.match(tokenActionHudSource, /renderInventoryItemTooltipHTML\(item, this\.actor/);
});

test("installed weapon modules only receive standalone light panels", () => {
  const sections = sliceBetween(
    actorSheetSource,
    "function buildInstalledWeaponModuleTooltipSections",
    "function renderWeaponTooltipModuleSlots"
  );

  assert.match(sections, /getWeaponModuleTooltipCapabilities\(item\)/);
  assert.match(sections, /capabilities\.lightSource \? \[buildLightSourceTooltipSection\(item\)\]/);
  assert.doesNotMatch(sections, /buildModuleTooltipSection/);
  assert.doesNotMatch(sections, /buildConditionTooltipSection/);
});

test("weapon tooltip renders magazine sources after every ordinary weapon row", () => {
  const rows = sliceBetween(
    actorSheetSource,
    "function buildWeaponTooltipRows",
    "function getWeaponTooltipSectionTitle"
  );
  const sourceDefinition = rows.indexOf("const magazineSourceRow");
  const actions = rows.indexOf("const actions = getWeaponActionLabels");
  const sourceAppend = rows.indexOf("if (magazineSourceRow) rows.push(magazineSourceRow)");

  assert.ok(sourceDefinition >= 0);
  assert.ok(actions > sourceDefinition);
  assert.ok(sourceAppend > actions, "magazine source chips must be the final weapon row");
  assert.ok(sourceAppend < rows.indexOf("return rows"));
});
