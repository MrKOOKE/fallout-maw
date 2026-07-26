import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PERIODIC_HEALING_EFFECT_KEY,
  PERIODIC_HEALING_INTERVAL_SECONDS,
  countPeriodicHealingTicks,
  evaluatePeriodicHealingPerTick,
  isPeriodicHealingEffectKey
} from "../src/combat/periodic-healing.mjs";

test("periodic healing has one canonical key and an immutable six-second interval", () => {
  assert.equal(PERIODIC_HEALING_EFFECT_KEY, "fallout-maw.healing");
  assert.equal(PERIODIC_HEALING_INTERVAL_SECONDS, 6);
  assert.equal(isPeriodicHealingEffectKey(PERIODIC_HEALING_EFFECT_KEY), true);
  assert.equal(isPeriodicHealingEffectKey("healing"), true);
  assert.equal(isPeriodicHealingEffectKey("system.healing.incomingPercent"), false);
});

test("periodic healing derives due ticks from Foundry effect time without state writes", () => {
  assert.equal(countPeriodicHealingTicks({
    startTime: 10,
    previousTime: 10,
    currentTime: 15
  }), 0);
  assert.equal(countPeriodicHealingTicks({
    startTime: 10,
    previousTime: 15,
    currentTime: 16
  }), 1);
  assert.equal(countPeriodicHealingTicks({
    startTime: 10,
    previousTime: 16,
    currentTime: 34
  }), 3);
  assert.equal(countPeriodicHealingTicks({
    startTime: 10,
    previousTime: 10,
    currentTime: 40,
    durationSeconds: 12
  }), 2);
});

test("multiple healing rows use standard Active Effect arithmetic and priority", () => {
  const changes = [
    { key: PERIODIC_HEALING_EFFECT_KEY, type: "override", value: 10, priority: 20 },
    { key: PERIODIC_HEALING_EFFECT_KEY, type: "add", value: 5, priority: 30 },
    { key: PERIODIC_HEALING_EFFECT_KEY, type: "multiply", value: 2, priority: 40 }
  ];
  assert.equal(evaluatePeriodicHealingPerTick(changes), 30);
});

test("first-aid constructor no longer stores or renders interval controls", () => {
  const model = readFileSync(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8");
  const firstAidModel = sourceBetween(model, "function firstAidFunctionField", "function needChangeFunctionField");
  const template = readFileSync(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8");
  const sheet = readFileSync(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../src/items/first-aid.mjs", import.meta.url), "utf8");
  const parser = readFileSync(new URL("../scripts/first-aid-description-parser.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(firstAidModel, /\bintervalSeconds\b|\bwithdrawalIntervalSeconds\b/);
  assert.doesNotMatch(template, /system\.functions\.firstAid\.(?:withdrawalIntervalSeconds|intervalSeconds)/);
  assert.doesNotMatch(sheet, /system\.functions\.firstAid\.(?:withdrawalIntervalSeconds|intervalSeconds)/);
  assert.doesNotMatch(runtime, /firstAid\.(?:withdrawalIntervalSeconds|intervalSeconds)/);
  assert.doesNotMatch(parser, /\bwithdrawalIntervalSeconds\b|\bintervalSeconds\b/);
  assert.match(runtime, /intervalSeconds:\s*PERIODIC_HEALING_INTERVAL_SECONDS/);
});

test("ability healing effects are processed before managed Foundry expiry without per-tick effect updates", () => {
  const damageHub = readFileSync(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");
  const catalogEditor = readFileSync(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8");
  const itemSheet = readFileSync(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8");
  const collector = sourceBetween(
    damageHub,
    "function collectAbilityPeriodicHealingEffectTicks",
    "function getPeriodicHealingEffectDurationSeconds"
  );

  assert.match(damageHub, /Hooks\.on\("preCreateActiveEffect", preparePeriodicHealingEffectCreate\)/);
  assert.match(damageHub, /update\["duration\.expiry"\] = MANAGED_TIMED_DAMAGE_EXPIRY/);
  assert.match(collector, /countPeriodicHealingTicks/);
  assert.match(collector, /update:\s*null/);
  assert.match(collector, /sourceActorUuid/);
  assert.match(catalogEditor, /buildEffectKeyTokens\(\{\s*includePeriodicHealing:\s*true\s*\}\)/);
  assert.match(itemSheet, /buildEffectKeyTokens\(\{\s*includePeriodicHealing:\s*true\s*\}\)/);
});

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
