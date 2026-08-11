import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATURE_RACE_SPECS,
  CREATURE_TYPE_SPECS,
  RETIRED_ROBOT_CREATURE_RACE_IDS,
  RETIRED_ROBOT_CREATURE_TYPE_IDS,
  NATURAL_WEAPON_STOCK_IMG,
  deterministicCreatureCatalogId,
  resolveCreatureCatalogStorageId,
  validateCreatureCatalog
} from "../scripts/rebalance/creature-fauna-catalog.mjs";
import {
  getCreatureSubtypeCombatProfile,
  getThreatClassBenchmark
} from "../scripts/rebalance/creature-combat-balance.mjs";

const RETIRED_ROBOT_RACE_KEYS = Object.freeze([
  "mister-handy",
  "protectron",
  "eyebot",
  "robobrain",
  "sentry-bot",
  "assaultron",
  "securitron",
  "synth"
]);

function getRace(key) {
  return CREATURE_RACE_SPECS.find(race => race.key === key);
}

function getSubtype(raceKey, subtypeKey) {
  return getRace(raceKey)?.subtypes.find(subtype => subtype.key === subtypeKey);
}

test("creature fauna catalog is internally valid and covers the practical seed", () => {
  const validation = validateCreatureCatalog();
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);
  assert.equal(validation.summary.typeCount, 6);
  assert.ok(validation.summary.raceCount >= 27);
  assert.ok(validation.summary.subtypeCount >= 47);
  assert.ok(validation.summary.naturalAttackCount >= 61);

  const typeKeys = new Set(CREATURE_TYPE_SPECS.map(type => type.key));
  for (const key of ["humanoid", "animal", "arthropod", "mutant", "flora", "alien-anomaly"]) {
    assert.ok(typeKeys.has(key), `missing type ${key}`);
  }

  const raceKeys = new Set(CREATURE_RACE_SPECS.map(race => race.key));
  for (const key of [
    "brahmin", "canine", "yao-guai", "gecko", "night-stalker",
    "radroach", "ant", "bloatfly", "mantis", "cazador", "radscorpion",
    "deathclaw", "mutant-hound", "centaur", "mirelurk", "lakelurk",
    "spore-plant", "strangler-heart", "overgrown", "overgrown-pollinator",
    "ghoul", "super-mutant", "zetan"
  ]) {
    assert.ok(raceKeys.has(key), `missing race ${key}`);
  }
});

test("robots are retired from creatureOptions and retain stable cleanup IDs", () => {
  assert.equal(CREATURE_TYPE_SPECS.some(type => type.key === "robot"), false);
  assert.equal(CREATURE_RACE_SPECS.some(race => race.typeKey === "robot"), false);

  const raceKeys = new Set(CREATURE_RACE_SPECS.map(race => race.key));
  for (const key of RETIRED_ROBOT_RACE_KEYS) {
    assert.equal(raceKeys.has(key), false, `retired robot race ${key} remains active`);
  }

  assert.deepEqual(RETIRED_ROBOT_CREATURE_TYPE_IDS, [
    "39ea50c59d8d2d0b"
  ]);
  assert.deepEqual(RETIRED_ROBOT_CREATURE_RACE_IDS, [
    "52a4f782a7027dd0",
    "d4af7b169ec74ec7",
    "2aea9cce6d7694fc",
    "81915ef9349e040f",
    "c01a11f4f3511556",
    "596f192aa5c8867e",
    "74eed3e0d5cff93c",
    "baf6917da1881314"
  ]);

  const activeTypeIds = new Set(CREATURE_TYPE_SPECS.map(resolveCreatureCatalogStorageId));
  const activeRaceIds = new Set(CREATURE_RACE_SPECS.map(resolveCreatureCatalogStorageId));
  assert.ok(RETIRED_ROBOT_CREATURE_TYPE_IDS.every(id => !activeTypeIds.has(id)));
  assert.ok(RETIRED_ROBOT_CREATURE_RACE_IDS.every(id => !activeRaceIds.has(id)));
});

test("flora uses separate anatomical families and functional subtypes", () => {
  const floraRaces = CREATURE_RACE_SPECS.filter(race => race.typeKey === "flora");
  assert.ok(floraRaces.length >= 4);
  assert.deepEqual(
    new Set(floraRaces.map(race => race.key)),
    new Set(["spore-plant", "strangler-heart", "overgrown", "overgrown-pollinator"])
  );

  assert.deepEqual(
    getRace("spore-plant").subtypes.map(entry => entry.key),
    ["ordinary", "acid-spitter"]
  );
  assert.deepEqual(
    getRace("overgrown").subtypes.map(entry => entry.key),
    ["thorn", "elder"]
  );
  assert.notEqual(getRace("overgrown").anatomy, getRace("overgrown-pollinator").anatomy);

  const stranglerAttacks = getSubtype("strangler-heart", "colony-heart").naturalAttacks;
  assert.deepEqual(stranglerAttacks.map(attack => attack.key), ["strangler-tendrils", "toxic-cloud"]);
  assert.equal(stranglerAttacks.find(attack => attack.key === "strangler-tendrils").skill, "meleeCombat");
  const toxicCloud = stranglerAttacks.find(attack => attack.key === "toxic-cloud");
  assert.equal(toxicCloud.skill, "rangedCombat");
  assert.equal(toxicCloud.actions.some(action => action.key === "volley" && action.damageRadius === "3"), true);
});

test("catalog IDs are deterministic while legacy world IDs remain resolvable", () => {
  assert.equal(
    deterministicCreatureCatalogId("race", "deathclaw"),
    deterministicCreatureCatalogId("race", "deathclaw")
  );
  assert.match(getRace("deathclaw").id, /^[A-Za-z0-9]{16}$/);
  assert.equal(resolveCreatureCatalogStorageId(getRace("deathclaw")), "newRace3");
  assert.equal(resolveCreatureCatalogStorageId(getRace("radroach")), "newRace4");
  assert.equal(resolveCreatureCatalogStorageId(getRace("mirelurk")), getRace("mirelurk").id);
});

test("natural attacks follow hidden threat classes and use only the neutral stock icon", () => {
  const ratBite = getSubtype("rodent", "rat").naturalAttacks[0];
  const moleRatBite = getSubtype("rodent", "mole-rat").naturalAttacks[0];
  const feralClaw = getSubtype("ghoul", "feral").naturalAttacks[0];
  const reaverClaw = getSubtype("ghoul", "reaver").naturalAttacks[0];
  const radroach = getSubtype("radroach", "ordinary").naturalAttacks;
  const deathclawClaw = getSubtype("deathclaw", "ordinary").naturalAttacks[0];

  assert.deepEqual([ratBite.damage, ratBite.penetration], [13, 3]);
  assert.deepEqual([moleRatBite.damage, moleRatBite.penetration], [21, 4]);
  assert.deepEqual([feralClaw.damage, feralClaw.penetration], [40, 3]);
  assert.deepEqual([reaverClaw.damage, reaverClaw.penetration], [80, 8]);
  assert.deepEqual(radroach.map(attack => [attack.damage, attack.penetration]), [[4, 1], [18, 0]]);
  assert.deepEqual([deathclawClaw.damage, deathclawClaw.penetration], [180, 23]);

  for (const race of CREATURE_RACE_SPECS.filter(entry => entry.key !== "human")) {
    for (const subtype of race.subtypes) {
      const profile = getCreatureSubtypeCombatProfile(race.key, subtype.key);
      const benchmark = getThreatClassBenchmark(profile.threatClass);
      for (const attack of subtype.naturalAttacks) {
        const poisonPercent = Number(
          attack.damageTypes.find(entry => entry.key === "poison")?.percent
        ) || 0;
        const poisonFloor = poisonPercent > 0
          ? Math.ceil(18 * 100 / poisonPercent)
          : 0;
        assert.ok(attack.damage <= Math.max(profile.primaryDamage * 1.1 + 5, poisonFloor));
      }
      assert.ok(profile.level >= 1 && profile.level <= 100);
      assert.ok(profile.primaryDamage >= benchmark.damageRange[0] * 0.5);
      assert.ok(subtype.naturalAttacks.every(attack => attack.img === NATURAL_WEAPON_STOCK_IMG));
    }
  }
});

test("large natural damage is split into armor-facing shares and action costs enforce creature cadence", () => {
  const mythic = getSubtype("deathclaw", "mythic").naturalAttacks;
  const claw = mythic.find(attack => attack.key === "mythic-claws");
  assert.equal(claw.damage, 400);
  assert.equal(claw.pellets, 7);
  assert.equal(claw.actions.find(action => action.key === "meleeAttack").actionPointCost, 15);

  const heart = getSubtype("strangler-heart", "colony-heart").naturalAttacks;
  assert.equal(heart.find(attack => attack.key === "strangler-tendrils").pellets, 3);
  assert.equal(heart.find(attack => attack.key === "toxic-cloud").actions[0].actionPointCost, 6);

  const rat = getSubtype("rodent", "rat").naturalAttacks[0];
  assert.equal(rat.actions.find(action => action.key === "meleeAttack").actionPointCost, 2);

  const reaverBurst = getSubtype("ghoul", "reaver").naturalAttacks
    .find(attack => attack.key === "reaver-claw-burst");
  assert.equal(reaverBurst.actions[0].key, "burst");
  assert.equal(reaverBurst.actions[0].count, 3);
  assert.equal(reaverBurst.actions[0].actionPointCost, 9);
});

test("natural attack specializations create useful choices against armor", () => {
  const dog = getSubtype("canine", "dog").naturalAttacks;
  const dogBite = dog.find(attack => attack.key === "bite");
  const dogPounce = dog.find(attack => attack.key.includes("pounce"));
  assert.ok(dogBite.damage > dogPounce.damage);
  assert.ok(dogBite.penetration > dogPounce.penetration);
  assert.equal(dogBite.damageTypes[0].key, "piercing");

  const yaoGuai = getSubtype("yao-guai", "ordinary").naturalAttacks;
  const yaoClaws = yaoGuai.find(attack => attack.key === "claws");
  const yaoBite = yaoGuai.find(attack => attack.key === "bite");
  assert.ok(yaoClaws.damage > yaoBite.damage);
  assert.ok(yaoClaws.penetration * 5 < yaoBite.penetration);
  assert.equal(yaoClaws.specialization, "rend");
  assert.equal(yaoBite.specialization, "puncture");

  const radscorpion = getSubtype("radscorpion", "ordinary").naturalAttacks;
  const pincers = radscorpion.find(attack => attack.key === "pincers");
  const sting = radscorpion.find(attack => attack.key === "sting");
  assert.ok(pincers.damage > sting.damage);
  assert.ok(sting.penetration > pincers.penetration * 5);
  assert.equal(sting.damageTypes.some(entry => entry.key === "poison"), true);

  const deathclaw = getSubtype("deathclaw", "ordinary").naturalAttacks;
  const claws = deathclaw.find(attack => attack.key === "claws");
  const bite = deathclaw.find(attack => attack.key === "bite");
  const tail = deathclaw.find(attack => attack.key.includes("tail"));
  assert.ok(claws.damage > bite.damage);
  assert.ok(bite.penetration > claws.penetration * 4);
  assert.ok(tail.penetration < claws.penetration);
  assert.ok(tail.pellets > 1);

  const queen = getSubtype("mirelurk", "queen").naturalAttacks;
  const acid = queen.find(attack => attack.key === "acid-brood");
  assert.equal(acid.specialization, "corrosion");
  assert.equal(acid.actions[0].key, "volley");
  assert.equal(acid.actions[0].damageRadius, "2");
  assert.equal(acid.actions[0].regionRadius, "2");

  const larvaVolley = getSubtype("bloatfly", "queen").naturalAttacks
    .find(attack => attack.key === "larva-volley");
  assert.equal(larvaVolley.actions[0].key, "burst");
  assert.equal(larvaVolley.actions[0].count, 3);

  for (const race of CREATURE_RACE_SPECS.filter(entry => entry.key !== "human")) {
    for (const subtype of race.subtypes) {
      assert.ok(subtype.naturalAttacks.every(attack => attack.specialization));
      assert.ok(subtype.naturalAttacks.every(attack => attack.specializationLabel));
    }
  }
});

test("natural attacks use the editor default icon and action-only concise names", () => {
  assert.equal(NATURAL_WEAPON_STOCK_IMG, "icons/svg/combat.svg");
  const attacks = CREATURE_RACE_SPECS.flatMap(race => race.subtypes.flatMap(subtype => subtype.naturalAttacks));
  assert.ok(attacks.every(attack => attack.img === "icons/svg/combat.svg"));
  assert.equal(getSubtype("ghoul", "reaver").naturalAttacks
    .find(attack => attack.key === "reaver-claw-burst").name, "Потрошение");
  assert.equal(getSubtype("ghoul", "reaver").naturalAttacks
    .find(attack => attack.key === "reaver-bite").name, "Укус");
  assert.equal(getSubtype("deathclaw", "mythic").naturalAttacks
    .find(attack => attack.key === "mythic-bite").name, "Укус");
  assert.deepEqual(
    getSubtype("radroach", "glowing").naturalAttacks.map(attack => attack.name),
    ["Укус", "Плевок"]
  );
  assert.deepEqual(
    getSubtype("deathclaw", "glowing").naturalAttacks.map(attack => attack.name),
    ["Когти", "Укус", "Хвост"]
  );
  assert.deepEqual(
    getSubtype("mirelurk", "queen").naturalAttacks.map(attack => attack.name),
    ["Клешни", "Плевок", "Таран"]
  );
  assert.ok(attacks.every(attack => !/радио|ядов|зараз|кислот|огнен|квант|засад|токсич|гигант|мощн|тяж[её]л|сокруш|гуля|когтя смерти|геккон|медоед|касадор|богомол|кротокрыс|гонч|водян|мерзост|бегемот/u.test(attack.name.toLowerCase())));
  assert.ok(attacks.every(attack => (attack.actions ?? []).every(action => !action.name || action.name === attack.name)));
});
