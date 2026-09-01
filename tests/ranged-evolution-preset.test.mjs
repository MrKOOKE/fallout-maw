import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizePresetDocument } from "../src/settings/presets/schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preset = JSON.parse(fs.readFileSync(
  path.join(ROOT, "storage/settings-presets/fallout-maw.json"),
  "utf8"
));
const worldPresetPath = path.resolve(ROOT, "../../worlds/fallout/settings-presets/fallout-maw.json");
const worldPreset = fs.existsSync(worldPresetPath)
  ? JSON.parse(fs.readFileSync(worldPresetPath, "utf8"))
  : null;
const catalog = preset.settings.find(entry => entry.id === "fallout-maw.abilitiesCatalog")?.value;
const abilities = catalog.categories.flatMap(category => category.abilities ?? []);

const rangedEvolutionAssignments = new Map([
  ["XErYKzyMMPv11VRI", ["hunterRace", { energyCost: 20, overloadEnergyCost: 40, overloadDurationSeconds: 60, durationSeconds: 60, accuracyBonus: 10, damagePercentBonus: 5, criticalChanceBonus: 2 }, 3]],
  ["lVhHvoN4s6w7dI22", ["bullseye", { energyCost: 10, innateDifficultyIgnorePercent: 100, penetrationBonusFormula: "10+rangedCombat/20", maxStacks: 3 }, 1]],
  ["nCYDZEIvb0F6gZtU", ["keepAwayKnockdown", { activationEnergyCost: 10, overloadEnergyCost: 10, overloadDurationSeconds: 6, baseDifficulty: 50, lostHealthPercentMultiplier: 10 }, 1]],
  ["4yvW5gMoJ84YtRuV", ["counterSniperGuaranteed", { reactionEnergyCost: 20, reactionOverloadEnergyCost: 40, reactionOverloadDurationSeconds: 12, guaranteedHitChanceThreshold: 10 }, 1]],
  ["WyPhcBQilTc0EgTb", ["guardianAngel", { reactionEnergyCost: 20, guaranteedHitChanceThreshold: 10 }, 1]],
  ["XnW13VmEec3Mccd6", ["hunterRace", { energyCost: 20, overloadEnergyCost: 40, overloadDurationSeconds: 60, durationSeconds: 60, accuracyBonus: 20, damagePercentBonus: 10, criticalChanceBonus: 4 }, 1]],
  ["7fwgkm1f623xq51t", ["trophyCollector", { markDurationSeconds: 3600, maximumStrength: 5, accuracyPerStack: 10, incomingDamagePercentPerStack: 5, criticalChancePerStack: 1, resilienceSkillKey: "resilience", resilienceDifficultyFormula: "50+rangedCombat", stunPercent: 50, stunDurationSeconds: 12 }, 1]],
  ["Sv3UnJWkoF2FAbdl", ["ricochetMastery", { activationEnergyCost: 10, overloadEnergyCost: 20, overloadDurationSeconds: 12, maxReflections: 4, maximumConeDegrees: 3, accuracyBonusPerReflection: 20, damagePercentBonusPerReflection: 10, penetrationBonusPerReflection: 10 }, 1]],
  ["EgYwFmAGHeMK82Hr", ["corpseAfterCorpse", { activationEnergyCost: 30, overloadEnergyCost: 100, overloadDurationSeconds: 3600, damagePercentBonus: 200, attackWaitDurationSeconds: 12 }, 1]],
  ["1Uupp8dCzRlumLdp", ["hawkEyePiercing", { defenseIgnorePercent: 25, resistanceIgnorePercent: 25 }, 1]],
  ["a57xtXErqr6B5YoA", ["trueBullet", { activationEnergyCost: 20, overloadEnergyCost: 80, overloadDurationSeconds: 12, criticalSuccessChanceThreshold: 90 }, 1]],
  ["nucy8lWdJSjiAc8m", ["cascade", { accuracyPerStack: 25, damagePercentPerStack: 15, maxStacks: 4, initialStacks: 1, periodicGain: 1, periodicIntervalSeconds: 6, weaponSwitchGain: 1, resetOnRepeatedWeapon: true }, 1]]
]);

function collectAbilityCopies(root, wantedIds) {
  const found = new Map([...wantedIds].map(id => [id, []]));
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (found.has(value.id) && value.system && Array.isArray(value.system.functions)) {
      found.get(value.id).push(value);
    }
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(root);
  return found;
}

test("Quick Reload has two compact evolution branches without a timed free reload", () => {
  const ability = abilities.find(entry => entry.id === "6BRhRZ5jTvqm9pb9");
  assert.ok(ability);
  assert.equal(ability.system.cost, 1000);
  assert.equal(ability.system.acquisitionRequirements[0].value, 60);
  assert.equal(ability.system.evolution.nodes.length, 3);
  assert.equal(ability.system.evolution.links.length, 3);

  const nodes = new Map(ability.system.evolution.nodes.map(node => [node.id, node.ability]));
  const speed = nodes.get("qRldFast2OD00001");
  assert.equal(speed.system.cost, 1000);
  assert.equal(speed.system.acquisitionRequirements[0].value, 70);
  assert.equal(speed.system.functions[0].changes[0].value, "-2");
  assert.equal(speed.evolutionSummary, "<ul><li><p>Стоимость перезарядки -1 ОД</p></li></ul>");
  assert.doesNotMatch(speed.description, /6 секунд|0 ОД/);

  const arsenal = nodes.get("qRldArsenal20001");
  assert.deepEqual(arsenal.system.functions[0].changes.map(change => [change.key, change.value]), [
    ["system.costs.actions.reload", "-1"],
    ["system.costs.weaponSwitch", "-2"]
  ]);
  assert.equal(arsenal.evolutionSummary, "<ul><li><p>Стоимость смены оружия -1 ОД</p></li></ul>");
});

test("final ranged evolutions use their canonical fixed functions in both synchronized presets", () => {
  if (worldPreset) assert.deepEqual(worldPreset, preset);
  assert.doesNotThrow(() => normalizePresetDocument(preset));
  if (worldPreset) assert.doesNotThrow(() => normalizePresetDocument(worldPreset));

  const copies = collectAbilityCopies(preset, rangedEvolutionAssignments.keys());
  for (const [abilityId, [fixedKey, fixedSettings, expectedCopies]] of rangedEvolutionAssignments) {
    assert.equal(copies.get(abilityId).length, expectedCopies, `${abilityId} copy count`);
    for (const ability of copies.get(abilityId)) {
      const fixed = ability.system.functions.find(fn => fn.type === "fixed" && fn.fixedKey === fixedKey);
      assert.ok(fixed, `${abilityId} has ${fixedKey}`);
      assert.deepEqual(fixed.fixedSettings, fixedSettings, `${abilityId} canonical settings`);
      assert.doesNotMatch(ability.name, /НА РЕАЛИЗАЦИИ/u, `${abilityId} has its final name`);
    }
  }

  const hunterCopies = copies.get("XErYKzyMMPv11VRI");
  assert.equal(new Set(hunterCopies.map(ability => ability.description)).size, 1);
  for (const hunter of hunterCopies) {
    assert.equal(hunter.name, "Охотник");
    assert.equal(hunter.system.functions.length, 1);
    assert.equal(hunter.system.functions[0].fixedKey, "hunterRace");
  }

  const bullseye = copies.get("lVhHvoN4s6w7dI22")[0];
  assert.match(bullseye.evolutionSummary, /Максимум 3/u);
  assert.doesNotMatch(bullseye.evolutionSummary, /Максимум 5|потребление энергии/u);

  const trueBullet = copies.get("a57xtXErqr6B5YoA")[0];
  const trueBulletPassive = trueBullet.system.functions.find(fn =>
    fn.type === "effectChanges"
    && fn.changes?.some(change => change.key === "system.combat.accuracy" && change.value === "30")
  );
  assert.ok(trueBulletPassive);
  assert.deepEqual(trueBulletPassive.conditions, [{
    eventSubject: "reactor",
    groupId: "",
    id: "IbeKirYyCm3wameN",
    skillKeys: ["rangedCombat"],
    type: "weaponSkill"
  }]);

  const virtuosoCopies = collectAbilityCopies(preset, new Set(["g0uzSSoeayWsm2c3"]))
    .get("g0uzSSoeayWsm2c3");
  for (const virtuoso of virtuosoCopies) {
    const settings = virtuoso.system.functions.find(fn => fn.fixedKey === "virtuoso")?.fixedSettings;
    assert.ok(settings);
    assert.equal(Object.hasOwn(settings, "cascadeMaxStacks"), false);
    assert.equal(Object.hasOwn(settings, "cascadeIntervalSeconds"), false);
  }
});
