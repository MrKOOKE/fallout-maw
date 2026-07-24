import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject(original, other) {
      return mergeRecords(structuredClone(original), other);
    }
  }
};

const {
  DEFAULT_STEALTH_SETTINGS,
  createDefaultStealthSettings,
  normalizeStealthSettings
} = await import("../src/stealth/settings.mjs");

const EXPECTED_ATTACK_BONUSES = Object.freeze({
  accuracyFormula: "0",
  criticalChanceFormula: "luck",
  damagePercentFormula: "stealth / 5",
  criticalDamagePercentFormula: "0"
});

test("stealth settings define the four attack bonus formulas", () => {
  assert.deepEqual(DEFAULT_STEALTH_SETTINGS.attackBonuses, EXPECTED_ATTACK_BONUSES);
  assert.deepEqual(createDefaultStealthSettings().attackBonuses, EXPECTED_ATTACK_BONUSES);
});

test("old stealth settings receive attack bonus defaults without stacking legacy values", () => {
  const normalized = normalizeStealthSettings({
    difficulty: { skillKey: "survival" },
    detection: { skillKey: "perception", rangeFormula: "12" }
  });

  assert.deepEqual(normalized.attackBonuses, EXPECTED_ATTACK_BONUSES);
  assert.equal(normalized.difficulty.skillKey, "survival");
  assert.equal(normalized.detection.rangeFormula, "12");
});

test("custom attack bonus formulas are preserved and blank formulas use their defaults", () => {
  const normalized = normalizeStealthSettings({
    attackBonuses: {
      accuracyFormula: " dex / 2 ",
      criticalChanceFormula: "  ",
      damagePercentFormula: "stealth / 3",
      criticalDamagePercentFormula: "luck * 2"
    }
  });

  assert.deepEqual(normalized.attackBonuses, {
    accuracyFormula: "dex / 2",
    criticalChanceFormula: "luck",
    damagePercentFormula: "stealth / 3",
    criticalDamagePercentFormula: "luck * 2"
  });
});

test("stealth settings template exposes all attack formula fields with autocomplete", async () => {
  const template = await readFile(new URL("../templates/settings/stealth-settings-config.hbs", import.meta.url), "utf8");
  for (const key of Object.keys(EXPECTED_ATTACK_BONUSES)) {
    assert.match(template, new RegExp(`name="attackBonuses\\.${key}"[^>]*data-formula-autocomplete="all"`));
  }
});

test("stealth attack settings and tooltip attribution are localized in Russian and English", async () => {
  const [russian, english] = await Promise.all([
    readLocale("../lang/ru.json"),
    readLocale("../lang/en.json")
  ]);

  for (const locale of [russian, english]) {
    assert.ok(locale.FALLOUTMAW.Settings.Stealth.AttackBonusesTitle);
    assert.ok(locale.FALLOUTMAW.Settings.Stealth.AccuracyFormula);
    assert.ok(locale.FALLOUTMAW.Settings.Stealth.CriticalChanceFormula);
    assert.ok(locale.FALLOUTMAW.Settings.Stealth.DamagePercentFormula);
    assert.ok(locale.FALLOUTMAW.Settings.Stealth.CriticalDamagePercentFormula);
    assert.ok(locale.FALLOUTMAW.Item.TooltipBreakdownStealthAttack);
  }
});

async function readLocale(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

function mergeRecords(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const base = target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
        ? target[key]
        : {};
      target[key] = mergeRecords(base, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
  return target;
}
