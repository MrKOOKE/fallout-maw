import assert from "node:assert/strict";
import test from "node:test";
import {
  armoredEffectiveDamage,
  damagePacketAmounts,
  desiredBurstCount,
  isArrowOrBolt,
  isCompactExplosiveRound,
  isLaunchedGrenade,
  rebalanceDamageSourceArea,
  rebalanceWeaponContent,
  thrownGrenadeProfile
} from "../scripts/rebalance/weapon-content-rebalance.mjs";

function weaponItem(id, name, overrides = {}) {
  return {
    _id: id,
    name,
    flags: {},
    system: {
      functions: {
        weapon: {
          enabled: true,
          availableActions: {
            aimedShot: false,
            snapshot: false,
            burst: false,
            volley: false,
            meleeAttack: false,
            aimedMeleeAttack: false,
            push: false,
            reload: true
          },
          burst: {
            name: "",
            actionPointCost: 5,
            attackConeDegrees: 30,
            count: 6,
            difficultyPerShot: 10,
            criticalFailureConsequences: []
          },
          magazine: { value: 30, max: 30, sourceItemUuid: "", sourceItemUuids: [] },
          ...overrides
        }
      }
    }
  };
}

function sourceItem(id, name, itemClass = "B", overrides = {}) {
  return {
    _id: id,
    name,
    flags: {},
    itemClass,
    system: {
      functions: {
        damageSource: {
          enabled: true,
          damage: "720",
          pellets: "8",
          penetration: "7",
          damageTypes: [
            { key: "bludgeoning", percent: 50 },
            { key: "fire", percent: 50 }
          ],
          volley: {
            damageRadius: "3",
            regionRadius: "0",
            regionDamageEntries: [],
            regionDurationSeconds: "0",
            regionDelaySeconds: "0",
            regionRadiusDeltaMeters: "0"
          },
          ...overrides
        }
      }
    }
  };
}

test("Cryolator receives only the flamer-style stream attack and a full 25-charge magazine", () => {
  const item = weaponItem("crNRNjRDjlWrj30k", "Криолятор", {
    magazine: { value: 1, max: 1, sourceItemUuid: "Item.cryo", sourceItemUuids: ["Item.cryo"] }
  });
  const adjustment = rebalanceWeaponContent(item, { modulePlatformProfileId: "energy.heavy" });
  const weapon = item.system.functions.weapon;

  assert.ok(adjustment);
  assert.equal(weapon.availableActions.snapshot, true);
  assert.equal(weapon.availableActions.aimedShot, false);
  assert.equal(weapon.snapshot.name, "Криогенная струя");
  assert.equal(weapon.snapshot.actionPointCost, 6);
  assert.equal(weapon.snapshot.attackConeDegrees, 40);
  assert.equal(weapon.magazine.max, 25);
  assert.equal(weapon.magazine.value, 25);
  assert.deepEqual(weapon.magazine.sourceItemUuids, [
    "Item.cryo",
    "Item.inDYlZOyymgHIhIt",
    "Item.98296cdd3d3238ea",
    "Item.5690f6391f56f628"
  ]);
  assert.deepEqual(weapon.specialProperties, [{ type: "hitAllConeTargets" }]);
});

test("Cryogenic sources do not turn unrelated cryogenic weapons into flamethrowers", () => {
  const item = weaponItem("other-cryo", "Криогенный пистолет", {
    availableActions: {
      aimedShot: true,
      snapshot: true,
      burst: false,
      volley: false,
      meleeAttack: false,
      aimedMeleeAttack: false,
      push: false,
      reload: true
    }
  });
  assert.equal(rebalanceWeaponContent(item, { modulePlatformProfileId: "energy.compact" }), null);
});

test("throwable grenades become classed one-use volley weapons without condition or reload", () => {
  const item = weaponItem("R8YytctHLzE0WL4Q", "Криограната", {
    availableActions: {
      aimedShot: false,
      snapshot: false,
      burst: false,
      volley: true,
      meleeAttack: false,
      aimedMeleeAttack: false,
      push: false,
      reload: true
    },
    damage: "760",
    pellets: "8",
    penetration: "5",
    damageTypes: [
      { key: "bludgeoning", percent: 55 },
      { key: "cryo", percent: 45 }
    ],
    maxRangeMeters: "100",
    criticalChanceModifier: "20",
    criticalDamagePercent: "200",
    noiseLevel: 1,
    volley: {
      damageRadius: "4",
      regionRadius: "2",
      regionDamageEntries: [],
      regionDurationSeconds: "0",
      regionDelaySeconds: "0",
      regionRadiusDeltaMeters: "0"
    },
    resourceCosts: [{ type: "quantity", amount: 1 }]
  });
  item.system.functions.condition = {
    enabled: true,
    value: 1,
    max: 1,
    weakeningThreshold: 20
  };

  const adjustment = rebalanceWeaponContent(item);
  const weapon = item.system.functions.weapon;

  assert.ok(adjustment);
  assert.equal(thrownGrenadeProfile(item).class, "B");
  assert.equal(thrownGrenadeProfile(item).craftResultQuantity, 1);
  assert.deepEqual(
    Object.entries(weapon.availableActions)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key),
    ["volley"]
  );
  assert.equal(weapon.volley.name, "Метнуть");
  assert.equal(weapon.maxRangeMeters, "10");
  assert.deepEqual(weapon.damageTypes, [
    { key: "bludgeoning", percent: 35 },
    { key: "cryo", percent: 65 }
  ]);
  assert.equal(weapon.volley.regionRadius, "0");
  assert.deepEqual(weapon.resourceCosts, [{ type: "quantity", amount: 1 }]);
  assert.equal(weapon.criticalChanceModifier, "5");
  assert.equal(weapon.criticalDamagePercent, "150");
  assert.equal(weapon.noiseLevel, 38);
  assert.equal(item.system.functions.condition.enabled, false);
  assert.equal(item.system.functions.condition.value, 0);
  assert.equal(item.system.functions.condition.max, 0);
  assert.equal(item.system.functions.condition.weakeningThreshold, 10);
  assert.deepEqual(item.system.functions.condition.recoveryMethods, []);
});

test("all throwable explosive grenades begin with bludgeoning damage and retain batch craft evidence", () => {
  const cases = [
    ["5EKMxOH4Do99lOcs", "Плазменная граната", 1],
    ["74ksE0B8rnp2Xeup", "Импульсная граната", 3],
    ["wf4UfHv2ib1M20X1", "ЭМИ-Граната", 1],
    ["a3sTRTCi6kVFheDq", "Молотов", 2],
    ["b3r21sq3ztYvFeRQ", "Осколочная граната", 3]
  ];
  for (const [id, name, resultQuantity] of cases) {
    const item = weaponItem(id, name, {
      damageTypes: [{ key: "firearm", percent: 100 }],
      criticalChanceModifier: "0",
      criticalDamagePercent: "120",
      noiseLevel: 1
    });
    item.system.functions.condition = {
      enabled: true,
      value: 1,
      max: 1,
      recoveryMethods: [{ type: "tools" }]
    };
    rebalanceWeaponContent(item);
    assert.equal(item.system.functions.weapon.damageTypes[0].key, "bludgeoning");
    assert.equal(thrownGrenadeProfile(item).craftResultQuantity, resultQuantity);
    assert.equal(item.system.functions.condition.max, 0);
  }
});

test("Curated automatic shotguns receive a three-shell burst", () => {
  const item = weaponItem("GRFiXPNPHI7czKAS", "Панкор Джекхаммер", {
    magazine: { value: 10, max: 10, sourceItemUuid: "", sourceItemUuids: [] }
  });
  rebalanceWeaponContent(item, { modulePlatformProfileId: "shotshell.magazineShotgun" });
  const weapon = item.system.functions.weapon;

  assert.equal(weapon.availableActions.burst, true);
  assert.equal(weapon.burst.name, "Очередь");
  assert.equal(weapon.burst.count, 3);
  assert.equal(weapon.burst.difficultyPerShot, 10);
});

test("Burst lengths distinguish rifles, SMGs, machine guns, and rotary weapons", () => {
  const cases = [
    ["Автомат", "ballistic.assaultRifle", 5],
    ["Пистолет-пулемёт", "ballistic.smg", 8],
    ["Лёгкий пулемёт", "ballistic.machineGun", 10],
    ["Миниган", "ballistic.machineGun", 15],
    ["Энергетическая винтовка", "energy.long", 5],
    ["Автоматический гранатомёт", "launcher", 4]
  ];
  for (const [name, profileId, expected] of cases) {
    const item = weaponItem("test-id", name);
    assert.equal(desiredBurstCount(item, { modulePlatformProfileId: profileId }), expected);
  }
});

test("Explosion damage is valued as independently mitigated pellet/type/fire packets", () => {
  const source = sourceItem("source", "25-мм граната «Зажигательная»")
    .system.functions.damageSource;
  const packets = damagePacketAmounts(source);
  const value = armoredEffectiveDamage(source, "B");

  assert.equal(packets.length, 24);
  assert.equal(packets.reduce((sum, packet) => sum + packet, 0), 720);
  assert.equal(value.scenarios[0].damage, 720);
  assert.ok(value.score < 720);
  assert.ok(value.scenarios.find(row => row.protection === 78).damage < 720);
});

test("Persistent areas are added only to fitting explosive variants", () => {
  const incendiary = sourceItem("incendiary", "25-мм граната «Зажигательная»");
  const smoke = sourceItem("smoke", "40-мм граната «Дымовая»");
  const fragmentation = sourceItem("frag", "40-мм граната «Осколочная»");

  assert.ok(rebalanceDamageSourceArea(incendiary, "B"));
  assert.deepEqual(
    incendiary.system.functions.damageSource.volley.regionDamageEntries,
    [{ damageTypeKey: "fire", amount: "100" }]
  );
  assert.ok(rebalanceDamageSourceArea(smoke, "C"));
  assert.deepEqual(
    smoke.system.functions.damageSource.volley.regionDamageEntries,
    [{ damageTypeKey: "poison", amount: "45" }]
  );
  assert.equal(rebalanceDamageSourceArea(fragmentation, "C"), null);
});

test("Explosive recipe routing keeps small rounds, arrows, and launched grenades distinct", () => {
  assert.equal(isCompactExplosiveRound(".50 MG «Разрывной»"), true);
  assert.equal(isCompactExplosiveRound("25-мм граната «Фугасная»"), false);
  assert.equal(isArrowOrBolt("Стрела/болт «Взрывная»"), true);
  assert.equal(isLaunchedGrenade("25-мм граната «Зажигательная»"), true);
  assert.equal(isLaunchedGrenade("Малая ракета «Зажигательная»"), false);
});
