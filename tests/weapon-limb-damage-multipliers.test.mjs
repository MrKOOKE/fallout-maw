import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  WEAPON_SPECIAL_PROPERTIES,
  createDefaultWeaponSpecialPropertyData,
  getWeaponLimbDamageMultiplier,
  normalizeWeaponSpecialProperty
} = await import("../src/utils/item-functions.mjs");
const { normalizeAttackActionSettings } = await import("../src/abilities/attack-action-settings.mjs");

test("limb damage multiplier property keeps canonical keyed decimal values", () => {
  const type = WEAPON_SPECIAL_PROPERTIES.limbDamageMultipliers;
  assert.deepEqual(createDefaultWeaponSpecialPropertyData(type), {
    type,
    limbDamageMultipliers: {}
  });
  assert.deepEqual(normalizeWeaponSpecialProperty({
    type,
    limbMultipliers: { head: "1.5", leftArm: 0, rightArm: -2, invalid: "x" }
  }), {
    type,
    limbMultipliers: { head: "1.5", leftArm: 0, rightArm: -2, invalid: "x" },
    limbDamageMultipliers: { head: 1.5, leftArm: 0, rightArm: 0 }
  });

  const multipliers = { head: "1.5", leftArm: 0 };
  const weaponData = { specialProperties: [{ type, limbDamageMultipliers: multipliers }] };
  assert.equal(getWeaponLimbDamageMultiplier(weaponData, "head"), 1.5);
  assert.equal(getWeaponLimbDamageMultiplier(weaponData, "leftArm"), 0);
  assert.equal(getWeaponLimbDamageMultiplier(weaponData, "torso"), 1);
  multipliers.head = 2.25;
  assert.equal(getWeaponLimbDamageMultiplier(weaponData, "head"), 2.25);
  assert.doesNotMatch(getWeaponLimbDamageMultiplier.toString(), /normalizeWeaponSpecialProperties/);

  assert.deepEqual(normalizeAttackActionSettings({
    specialProperties: [{ type, limbDamageMultipliers: { head: "1.25", torso: -1 } }]
  }).specialProperties, [{
    type,
    limbDamageMultipliers: { head: 1.25, torso: 0 }
  }]);
});

test("limb multiplier is wired through the schema and all three weapon property editors", async () => {
  const [model, attackSettings, sheet, template, english, russian] = await Promise.all([
    readFile(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/attack-action-settings.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
    readFile(new URL("../lang/en.json", import.meta.url), "utf8"),
    readFile(new URL("../lang/ru.json", import.meta.url), "utf8")
  ]);

  assert.match(model, /WEAPON_SPECIAL_PROPERTY_LIMB_DAMAGE_MULTIPLIERS/);
  assert.match(model, /limbDamageMultipliers:\s*new TypedObjectField\([\s\S]*?min: 0, initial: 1/);
  assert.match(attackSettings, /ATTACK_ACTION_SPECIAL_PROPERTY_TYPES[\s\S]*?"limbDamageMultipliers"/);
  assert.match(sheet, /STANDARD_WEAPON_LIMB_KEYS/);
  assert.match(sheet, /buildWeaponLimbDamageMultiplierRows/);
  assert.equal((template.match(/\{\{#if isLimbDamageMultipliers\}\}/g) ?? []).length, 3);
  assert.equal((template.match(/\.limbDamageMultipliers\.\{\{key\}\}/g) ?? []).length, 3);
  for (const language of [JSON.parse(english), JSON.parse(russian)]) {
    const item = language.FALLOUTMAW.Item;
    assert.equal(typeof item.WeaponSpecialLimbDamageMultipliers, "string");
    assert.deepEqual(Object.keys(item.WeaponLimbKeys), [
      "head",
      "eyes",
      "torso",
      "groin",
      "leftArm",
      "rightArm",
      "leftLeg",
      "rightLeg"
    ]);
  }
});

test("standard and independent health routes keep the required multiplier boundary", async () => {
  const hub = await readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8");

  assert.equal((hub.match(/profileMultiplier:[^\n]+,\s*limbDamageMultiplier: getWeaponLimbDamageMultiplier/g) ?? []).length, 4);
  assert.match(hub, /function calculateIndependentOrganicLimbDamage[\s\S]*?const anatomicalMultiplier = Math\.max\(0, toOptionalFiniteNumber\(limb\.damageMultiplier\) \?\? 1\);[\s\S]*?\* anatomicalMultiplier \* limbDamageMultiplier/);
  assert.match(hub, /if \(independentHealthRules && targetedProsthesis\) \{\s*result = await calculateProsthesisLimbDamage\([\s\S]*?prosthesis: targetedProsthesis,\s*limbDamageMultiplier: getWeaponLimbDamageMultiplier/);
  assert.match(hub, /if \(independentHealthRules && installedProsthesis\) \{\s*result = await calculateProsthesisLimbDamage\([\s\S]*?prosthesis: installedProsthesis,\s*limbDamageMultiplier: getWeaponLimbDamageMultiplier/);
  assert.match(hub, /if \(installedProsthesis\) \{\s*result = estimateProsthesisLimbDamage\([\s\S]*?prosthesis: installedProsthesis,\s*limbDamageMultiplier: getWeaponLimbDamageMultiplier/);
  assert.match(hub, /function applyDamageEntryToEstimateLedger[\s\S]*?entry\.amount \* getWeaponLimbDamageMultiplier[\s\S]*?ledger\.independentHealthState/);

  assert.equal((hub.match(/prosthesis: (?:targetedProsthesis|installedProsthesis),\s*limbDamageMultiplier: getWeaponLimbDamageMultiplier/g) ?? []).length, 6);
  assert.match(hub, /async function calculateProsthesisLimbDamage[\s\S]*?const damage = roundDamageAmount\(amount \* limbDamageMultiplier\);/);
  assert.match(hub, /function estimateProsthesisLimbDamage[\s\S]*?const damage = roundDamageAmount\(amount \* limbDamageMultiplier\);/);
  assert.match(hub, /function estimateDamageEntriesBatch[\s\S]*?function applyDamageEntryToEstimateLedger[\s\S]*?entry\.amount \* getWeaponLimbDamageMultiplier/);
});

test("weapon explosions resolve a canonical limb key before creating damage requests", async () => {
  const source = await readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export function buildWeaponExplosionDamageRequests");
  const end = source.indexOf("export function isWeaponPlacementDisabled", start);
  const builder = source.slice(start, end);

  assert.match(builder, /const limbKey = concentratedPelletImpact[\s\S]*?: selectRandomLimbKey\(actor\);/);
  assert.match(builder, /if \(!limbKey\) continue;/);
  assert.match(builder, /const conditionWearPacketId = foundry\.utils\.randomID\(\);/);
  assert.match(builder, /source:\s*\{[\s\S]*?conditionWearPacketId,/);
  assert.match(builder, /requests\.push\(\{\s*actor,\s*limbKey,/);
});
