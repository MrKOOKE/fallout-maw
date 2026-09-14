import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createItemValueAttributionStep } from "../src/utils/item-value-attribution.mjs";
import {
  applyWeaponEffectiveRangeBonuses,
  resolveBaseWeaponEffectiveRange
} from "../src/utils/weapon-range.mjs";

// Run the sheet's actual attribution and HTML functions without booting Foundry.
const sheetSource = await readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8");
function extractFunction(name) {
  const start = sheetSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing function: ${name}`);
  const end = sheetSource.indexOf("\nfunction ", start + 1);
  assert.notEqual(end, -1, `Missing end of function: ${name}`);
  return sheetSource.slice(start, end);
}

const functions = [
  "buildWeaponTooltipValueBreakdowns",
  "appendAttributionDeltaSources",
  "appendBreakdownStep",
  "reconcileBreakdownTotal",
  "renderItemValueBreakdownTooltipHTML",
  "renderItemValueBreakdownSource",
  "formatItemValueBreakdownOperation",
  "formatSignedBreakdownValue",
  "localizeTooltipSourceName"
];
const noop = () => {};
const dependencies = {
  createItemValueAttributionStep,
  resolveBaseWeaponEffectiveRange,
  formatNumber: String,
  formatSignedNumber: value => value > 0 ? `+${value}` : String(value),
  localizeOrFallback: (_key, fallback) => fallback,
  game: { i18n: { has: () => false, localize: key => key } },
  escapeHTML: String,
  escapeAttribute: String,
  evaluateTooltipFormula: value => Number(value) || 0,
  buildWeaponDataFieldAttribution: ({ title, item, actor, total, formatValue }) => ({
    title,
    actorName: actor?.name,
    base: { name: item?.name, img: item?.img, value: total },
    sources: [],
    total,
    formatValue
  }),
  appendWeaponDamagePercentSources: noop,
  appendParallelPercentSources: noop,
  appendStealthAttackDamageAttribution: noop,
  appendProficiencyAttribution: noop,
  appendFixedCombatAttribution: noop,
  appendStealthAttackAttribution: noop,
  buildWeaponRecoilAttribution: noop,
  buildWeaponResourceCostAttributions: noop
};
const {
  buildWeaponTooltipValueBreakdowns,
  appendAttributionDeltaSources,
  reconcileBreakdownTotal,
  renderItemValueBreakdownTooltipHTML
} = new Function(...Object.keys(dependencies), `${functions.map(extractFunction).join("\n")}
  return { ${functions.join(", ")} };
`)(...Object.values(dependencies));

function buildRangeBreakdowns(nearSources = [], farSources = [], attackSources = []) {
  const empty = { value: 0, sources: [] };
  const attribution = sources => ({
    value: sources.reduce((sum, source) => sum + source.value, 0), sources
  });
  const data = { effectiveRange: { value: 15, max: 100 }, maxRangeMeters: 150 };
  const range = applyWeaponEffectiveRangeBonuses(resolveBaseWeaponEffectiveRange(data.effectiveRange), {
    nearBonusMeters: attribution(nearSources).value,
    farBonusMeters: attribution(farSources).value
  });
  return buildWeaponTooltipValueBreakdowns({
    item: { name: "Снайперская винтовка Mk.II", img: "rifle.webp" },
    actor: { name: "Новобранец НКР" },
    data,
    rawData: data,
    baseData: data,
    moduleSlots: [],
    result: {
      damage: 0,
      accuracyBonus: 0,
      criticalChanceModifier: 0,
      criticalDamagePercent: 0,
      penetration: 0,
      noiseLevel: 0,
      maxRangeMeters: Math.max(0, data.maxRangeMeters + attribution(attackSources).value),
      effectiveRange: { value: range?.min ?? 0, max: range?.max ?? 0 }
    },
    formulaDamage: 0,
    damagePercent: 0,
    skillDamageBonuses: { flat: 0 },
    fixedModifiers: {},
    damageFlatAttribution: empty,
    damagePercentAttribution: empty,
    accuracyAttribution: empty,
    criticalChanceAttribution: empty,
    criticalDamageAttribution: empty,
    effectiveRangeNearAttribution: attribution(nearSources),
    effectiveRangeFarAttribution: attribution(farSources),
    attackRangeAttribution: attribution(attackSources)
  });
}

test("stabilization shows 15 m to zero directly, with no negative distance or compensating source", () => {
  const source = { name: "Стабилизация II", img: "effect.webp", value: -999, valueLabel: "-999 м" };
  const { effectiveRange } = buildRangeBreakdowns([source]);
  const breakdown = effectiveRange.value;
  assert.equal(breakdown.total, 0);
  assert.equal(breakdown.sources.length, 1);
  assert.equal(breakdown.sources[0].name, source.name);
  assert.equal(breakdown.sources[0].img, source.img);
  assert.equal(breakdown.sources[0].valueLabel, "→ 0 м");
  assert.equal(breakdown.sources[0].before, 15);
  assert.equal(breakdown.sources[0].after, 0);
  const html = renderItemValueBreakdownTooltipHTML(breakdown);
  assert.match(html, /База: 15 м/);
  assert.match(html, /<b>→ 0 м<\/b>/);
  assert.match(html, /<small>15 м → 0 м<\/small>/);
  assert.match(html, /<span>0 м<\/span>/);
  assert.doesNotMatch(html, /999|984|Итоговый расчёт/);
  assert.deepEqual(source, { name: "Стабилизация II", img: "effect.webp", value: -999, valueLabel: "-999 м" });
});

test("range limits apply to the combined effects, even when a later bonus follows a large penalty", () => {
  for (const values of [[-999, 10], [10, -999], [-999, 1000], [1000, -999]]) {
    const { effectiveRange } = buildRangeBreakdowns(values.map((value, index) => ({ name: `Effect ${index}`, value })));
    assert.equal(effectiveRange.value.total, Math.max(0, 15 + values.reduce((sum, value) => sum + value, 0)));
    assert.equal(effectiveRange.value.sources.length, values.length);
    assert.ok(effectiveRange.value.sources.every(source => source.before >= 0 && source.after >= 0));
    assert.doesNotMatch(renderItemValueBreakdownTooltipHTML(effectiveRange.value), /Итоговый расчёт/);
  }
});

test("ordinary range bonuses keep their source labels and exact fractional values", () => {
  const { effectiveRange } = buildRangeBreakdowns([
    { name: "Adjustment", value: -2.5, valueLabel: "−2.5 м" },
    { name: "Bonus", value: 1 }
  ]);
  assert.equal(effectiveRange.value.total, 13.5);
  assert.deepEqual(effectiveRange.value.sources.map(source => [source.valueLabel, source.before, source.after]), [
    ["−2.5 м", 15, 12.5], ["+1 м", 12.5, 13.5]
  ]);
});

test("maximum and attack range tooltips also show zero without a compensating positive effect", () => {
  const sources = [{ name: "Range penalty", value: -999 }];
  const { effectiveRange, maxRangeMeters } = buildRangeBreakdowns([], sources, sources);
  for (const breakdown of [effectiveRange.max, maxRangeMeters]) {
    assert.equal(breakdown.total, 0);
    assert.equal(breakdown.sources.length, 1);
    assert.equal(breakdown.sources[0].valueLabel, "→ 0 м");
    assert.doesNotMatch(renderItemValueBreakdownTooltipHTML(breakdown), /999|Итоговый расчёт/);
  }
});

test("attribution for stats that allow negative values stays unbounded", () => {
  const breakdown = { total: 15, sources: [] };
  appendAttributionDeltaSources(breakdown, [{ name: "Accuracy penalty", value: -30 }]);
  assert.equal(breakdown.total, -15);
  assert.equal(breakdown.sources[0].valueLabel, "-30");
  assert.equal(breakdown.sources[0].operation, "add");
});

test("reconciliation still reports actual differences unrelated to distance limits", () => {
  const breakdown = { total: 15, sources: [] };
  appendAttributionDeltaSources(breakdown, [{ value: -2 }], { minimum: 0 });
  reconcileBreakdownTotal(breakdown, 10);
  assert.equal(breakdown.total, 10);
  assert.equal(breakdown.sources[1].name, "Итоговый расчёт");
  assert.equal(breakdown.sources[1].value, -3);
});
