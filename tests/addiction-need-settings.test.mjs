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

const { normalizeNeedSettings } = await import("../src/formulas/normalization.mjs");

const EXPECTED_THRESHOLDS = Object.freeze([
  {
    percent: 40,
    effects: {
      "system.firstAid.incomingEffectivenessPercent": "-30"
    }
  },
  {
    percent: 60,
    effects: {
      "system.firstAid.incomingEffectivenessPercent": "-40",
      "system.firstAid.durationPercent": "-25"
    }
  },
  {
    percent: 80,
    effects: {
      "system.firstAid.incomingEffectivenessPercent": "-70",
      "system.firstAid.durationPercent": "-50",
      "system.characteristics.strength": "-1",
      "system.characteristics.dexterity": "-1",
      "system.characteristics.endurance": "-1",
      "system.characteristics.perception": "-1",
      "system.characteristics.intelligence": "-1",
      "system.characteristics.charisma": "-1",
      "system.characteristics.luck": "-1"
    }
  },
  {
    percent: 100,
    effects: {
      "system.firstAid.incomingEffectivenessPercent": "-100",
      "system.firstAid.durationPercent": "-100",
      "system.characteristics.strength": "-2",
      "system.characteristics.dexterity": "-2",
      "system.characteristics.endurance": "-2",
      "system.characteristics.perception": "-2",
      "system.characteristics.intelligence": "-2",
      "system.characteristics.charisma": "-2",
      "system.characteristics.luck": "-2"
    }
  }
]);

test("addiction defaults recover by 10 per hour and apply the configured penalties", () => {
  const [addiction] = normalizeNeedSettings([{
    key: "addiction",
    abbr: "add",
    label: "Зависимость",
    formula: "1000"
  }]);

  assert.equal(addiction.settings.accumulation.perHour, -10);
  assert.deepEqual(summarizeThresholds(addiction.settings.thresholds), EXPECTED_THRESHOLDS);
});

test("need normalization preserves custom negative hourly changes", () => {
  const [addiction] = normalizeNeedSettings([{
    key: "addiction",
    label: "Зависимость",
    formula: "1000",
    settings: {
      accumulation: { perHour: -7.5 },
      thresholds: [],
      diseases: []
    }
  }]);

  assert.equal(addiction.settings.accumulation.perHour, -7.5);
});

test("active Lost preset configures addiction for human and ghoul without rewriting its save", async () => {
  const preset = JSON.parse(await readFile(
    new URL("../storage/settings-presets/preset-29RLMkIuBBuzp9eClV99Sxcj.json", import.meta.url),
    "utf8"
  ));
  const creatureOptions = preset.settings.find(entry => entry.id === "fallout-maw.creatureOptions")?.value;
  const currentAddictions = creatureOptions.races
    .filter(race => ["haGXisDaATsuiumk", "newRace2"].includes(race.id))
    .flatMap(race => race.needSettings ?? [])
    .filter(need => need.key === "addiction");
  const savedAddictions = preset.saves
    .flatMap(save => save.settings ?? [])
    .filter(entry => entry.id === "fallout-maw.creatureOptions")
    .flatMap(entry => entry.value.races ?? [])
    .flatMap(race => race.needSettings ?? [])
    .filter(need => need.key === "addiction");

  assert.equal(currentAddictions.length, 2);
  for (const addiction of currentAddictions) {
    assert.equal(addiction.settings.accumulation.perHour, -10);
    assert.deepEqual(summarizeThresholds(addiction.settings.thresholds), EXPECTED_THRESHOLDS);
  }
  assert.equal(savedAddictions.length, 2);
  assert.equal(savedAddictions.every(need => need.settings.accumulation.perHour === 0), true);
  assert.equal(savedAddictions.every(need => need.settings.thresholds.length === 0), true);
});

test("advanced need form labels an unrestricted signed hourly change", async () => {
  const template = await readFile(
    new URL("../templates/settings/need-advanced-settings-config.hbs", import.meta.url),
    "utf8"
  );

  assert.match(template, /<span>Изменение в час<\/span>/);
  assert.match(template, /name="settings\.accumulation\.perHour"[^>]*step="0\.1"/);
  assert.doesNotMatch(template, /name="settings\.accumulation\.perHour"[^>]*min="0"/);
});

function summarizeThresholds(thresholds = []) {
  return thresholds.map(threshold => ({
    percent: threshold.percent,
    effects: Object.fromEntries(threshold.effects.map(effect => [effect.key, effect.value]))
  }));
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
