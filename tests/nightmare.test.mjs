import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeNightmareSettings
} from "../src/settings/abilities.mjs";
import {
  buildNightmareFearChanges,
  hasMaximumNightmareFearDuration,
  selectNightmareWitnessSkill
} from "../src/abilities/nightmare.mjs";

test("nightmare defaults match the fixed ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.nightmare, "nightmare");
  assert.deepEqual(normalizeNightmareSettings(), {
    activationEnergyCost: 100,
    overloadEnergyCost: 200,
    overloadDurationSeconds: 12 * 60 * 60,
    witnessRadiusMeters: 20,
    witnessDifficultyFormula: "50+stealth",
    fearDurationSeconds: 24,
    incomingDamagePercent: 20,
    outgoingDamagePercentPenalty: 20,
    actionPointPenalty: 2,
    movementPointPenalty: 4,
    allSkillsPercentPenalty: 25,
    darknessRadiusMeters: 50,
    darknessAbsorptionPercent: 99,
    darknessDurationSeconds: 24
  });
});

test("nightmare fear uses reverse incoming damage and ordinary actor penalties", () => {
  assert.deepEqual(buildNightmareFearChanges(), [
    change("fallout-maw.reverse.system.combat.damagePercent", 20),
    change("system.combat.damagePercent", -20),
    change("system.resources.actionPoints.bonus", -2),
    change("system.resources.movementPoints.bonus", -4),
    change("system.skills.all.bonusPercent", -25)
  ]);
});

test("nightmare witnesses automatically use the higher of science and resilience", () => {
  const actor = (science, resilience) => ({
    system: { skills: { science: { value: science }, resilience: { value: resilience } } }
  });
  assert.equal(selectNightmareWitnessSkill(actor(80, 60)), "science");
  assert.equal(selectNightmareWitnessSkill(actor(50, 70)), "resilience");
  assert.equal(selectNightmareWitnessSkill(actor(50, 50)), "science");
});

test("nightmare skips witnesses whose fear already has the maximum duration", () => {
  const fearChanges = buildNightmareFearChanges();
  const actor = remaining => ({
    effects: [{ disabled: false, duration: { remaining }, system: { changes: fearChanges } }]
  });
  assert.equal(hasMaximumNightmareFearDuration(actor(24), 24, 100), true);
  assert.equal(hasMaximumNightmareFearDuration(actor(Infinity), 24, 100), true);
  assert.equal(hasMaximumNightmareFearDuration(actor(12), 24, 100), false);
});

test("nightmare uses native attached darkness and faction-filtered region effects", async () => {
  const [fixedSource, actorSheetSource, regionModel, regionRuntime] = await Promise.all([
    fs.readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/data/region-behavior/periodic-damage.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/canvas/periodic-damage-regions.mjs", import.meta.url), "utf8")
  ]);
  assert.match(fixedSource, /createTokenEmanation\(token, settings\.darknessRadiusMeters/);
  assert.match(fixedSource, /restriction: \{ enabled: true, type: "light", priority: 0 \}/);
  assert.match(fixedSource, /type: "adjustDarknessLevel"[\s\S]*mode: 0,[\s\S]*modifier: 1/);
  assert.match(fixedSource, /regionSpecialProperties: \[\{[\s\S]*type: "smoke"[\s\S]*thickness: "1"[\s\S]*densityPercent: String\(settings\.darknessAbsorptionPercent\)/);
  assert.match(fixedSource, /targetRelations: \["neutral", "enemy"\]/);
  assert.match(fixedSource, /canTokenPhysicallySeeTarget\(token, victim\.token\)/);
  assert.match(fixedSource, /requester: "nightmareWitness"/);
  assert.doesNotMatch(actorSheetSource, /ABILITY_FIXED_FUNCTION_KEYS\.nightmare/);
  assert.match(regionModel, /targetRelations:[\s\S]*effectChanges:/);
  assert.match(regionRuntime, /regionBehaviorTargetsActor\(region, behavior, actor\)/);
});

function change(key, value) {
  return { key, type: "add", value: String(value), phase: "initial", priority: null };
}
