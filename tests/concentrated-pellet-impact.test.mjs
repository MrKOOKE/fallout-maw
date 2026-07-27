import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.foundry = {
  utils: {
    randomID: () => "generated-id"
  }
};

const {
  createPelletImpactProjectiles,
  distributePelletImpactDamage,
  getPelletProjectileCount
} = await import("../src/combat/pellet-impact.mjs");
const {
  WEAPON_SPECIAL_PROPERTIES,
  createDefaultWeaponSpecialPropertyData,
  hasWeaponSpecialPropertyData,
  normalizeWeaponSpecialPropertyType
} = await import("../src/utils/item-functions.mjs");

const [controllerSource, modelSource, itemSheetSource, ru] = await Promise.all([
  readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../lang/ru.json", import.meta.url), "utf8").then(JSON.parse)
]);

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `Missing start marker: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing end marker: ${endText}`);
  return source.slice(start, end);
}

test("concentrated pellet impact keeps one projectile carrying every pellet share", () => {
  const ordinary = createPelletImpactProjectiles({
    damageAmount: 23,
    pelletCount: 5
  });
  const concentrated = createPelletImpactProjectiles({
    damageAmount: 23,
    pelletCount: 5,
    concentrated: true
  });

  assert.equal(ordinary.length, 5);
  assert.deepEqual(ordinary.map(entry => entry.damageAmount), [5, 5, 5, 4, 4]);
  assert.ok(ordinary.every(entry => entry.pelletImpactCount === 1));
  assert.deepEqual(concentrated, [{
    damageAmount: 23,
    pelletImpactCount: 5,
    pelletImpactIndex: 0
  }]);
  assert.equal(getPelletProjectileCount(5), 5);
  assert.equal(getPelletProjectileCount(5, { concentrated: true }), 1);
});

test("a five-shot burst stays five projectiles and each hit expands to five damage shares", () => {
  const burstCount = 5;
  const pellets = 5;
  const ordinaryProjectileCount = burstCount * getPelletProjectileCount(pellets);
  const concentratedProjectileCount = burstCount * getPelletProjectileCount(
    pellets,
    { concentrated: true }
  );

  assert.equal(ordinaryProjectileCount, 25);
  assert.equal(concentratedProjectileCount, 5);
  assert.deepEqual(distributePelletImpactDamage(23, pellets), [5, 5, 5, 4, 4]);
  assert.equal(distributePelletImpactDamage(23, pellets).reduce((sum, value) => sum + value, 0), 23);
});

test("the special property is stable in normalization, schema, and the weapon editor", () => {
  const type = WEAPON_SPECIAL_PROPERTIES.concentratedPelletImpact;
  assert.equal(type, "concentratedPelletImpact");
  assert.equal(normalizeWeaponSpecialPropertyType(type), type);
  assert.deepEqual(createDefaultWeaponSpecialPropertyData(type), { type });
  assert.equal(hasWeaponSpecialPropertyData({
    specialProperties: [{ type }]
  }, type), true);
  assert.equal(
    ru.FALLOUTMAW.Item.WeaponSpecialConcentratedPelletImpact,
    "Дробное воздействие"
  );
  assert.match(
    modelSource,
    /\[WEAPON_SPECIAL_PROPERTY_CONCENTRATED_PELLET_IMPACT\]:\s*\{\}/
  );

  const weaponChoices = sliceBetween(
    itemSheetSource,
    "function buildWeaponSpecialPropertyChoices",
    "function buildWeaponAttackPowerSettingsForData"
  );
  assert.match(weaponChoices, /WEAPON_SPECIAL_PROPERTIES\.concentratedPelletImpact/);
  assert.match(weaponChoices, /WeaponSpecialConcentratedPelletImpact/);
});

test("weapon runtime collapses trajectories and burst bullets before expanding one successful impact", () => {
  const burst = sliceBetween(
    controllerSource,
    "async performBurstAttack",
    "onAimedConfirm"
  );
  assert.match(burst, /getWeaponProjectileCountPerAttack\(this\.weapon, this\.weaponFunctionId\)/);
  assert.match(burst, /createWeaponPelletImpactProjectiles\(/);
  assert.match(burst, /pelletImpactCount:\s*projectile\?\.pelletImpactCount/);

  const ordinary = sliceBetween(
    controllerSource,
    "async resolveAttackPellets",
    "async resolveAttackTrajectory"
  );
  assert.match(ordinary, /createWeaponPelletImpactProjectiles\(/);
  assert.match(ordinary, /projectiles\.length/);
  assert.match(ordinary, /pelletImpactCount:\s*projectile\?\.pelletImpactCount/);

  const hit = sliceBetween(
    controllerSource,
    "async resolveAttackAgainstTarget",
    "async performVolleyAttack"
  );
  assert.match(hit, /distributePelletImpactDamage\(damageAmount, impactCount\)/);
  assert.match(hit, /limbKey,/);
  assert.match(hit, /pelletImpactIndex:\s*impactIndex/);
});
