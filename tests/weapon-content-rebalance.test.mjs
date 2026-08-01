import assert from "node:assert/strict";
import test from "node:test";
import { UNIFIED_WEAKENING_THRESHOLD } from "../scripts/rebalance/condition-state.mjs";
import {
  armoredEffectiveDamage,
  damagePacketAmounts,
  desiredBurstCount,
  isArrowOrBolt,
  isCompactExplosiveRound,
  isLaunchedGrenade,
  rebalanceDamageSourceArea,
  rebalanceWeaponContent,
  shotgunActionPreset,
  shotgunRangePreset,
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
  assert.equal(
    item.system.functions.condition.weakeningThreshold,
    UNIFIED_WEAKENING_THRESHOLD
  );
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
  assert.equal(weapon.burst.attackConeDegrees, 40);
  assert.equal(weapon.availableActions.snapshot, true);
  assert.equal(weapon.snapshot.name, "Выстрел на вскидку");
  assert.equal(weapon.snapshot.attackConeDegrees, 40);
  assert.equal(weapon.aimedShot.name, "Прицельный выстрел");
  assert.equal(weapon.aimedShot.attackConeDegrees, 15);
});

test("ordinary shotguns receive both aimed and snapshot actions with platform spread", () => {
  const item = weaponItem("shotgun-standard", "Полицейский дробовик", {
    proficiencyKey: "shotgun",
    aimedShot: {
      name: "Прицельный выстрел дробью",
      actionPointCost: 6,
      attackConeDegrees: 3,
      criticalFailureConsequences: []
    }
  });
  rebalanceWeaponContent(item, { modulePlatformProfileId: "shotshell.tubularShotgun" });
  const weapon = item.system.functions.weapon;

  assert.equal(weapon.availableActions.aimedShot, true);
  assert.equal(weapon.availableActions.snapshot, true);
  assert.equal(weapon.availableActions.burst, false);
  assert.equal(weapon.aimedShot.name, "Прицельный выстрел");
  assert.equal(weapon.aimedShot.attackConeDegrees, 15);
  assert.equal(weapon.snapshot.name, "Выстрел на вскидку");
  assert.equal(weapon.snapshot.attackConeDegrees, 40);
  assert.equal(weapon.attackConeDegrees, 40);
});

test("sawed-off and advanced shotguns keep meaningful spread deviations", () => {
  const sawedOff = weaponItem("shotgun-sawed", "Обрез 12 кал.", {
    proficiencyKey: "shotgun"
  });
  const gauss = weaponItem("shotgun-gauss", "Гаусс-Дробовик", {
    proficiencyKey: "shotgun"
  });

  assert.deepEqual(
    shotgunActionPreset(sawedOff, { modulePlatformProfileId: "shotshell.tubularShotgun" }),
    {
      automatic: false,
      variant: "sawedOff",
      aimedConeDegrees: 25,
      snapshotConeDegrees: 55,
      burstConeDegrees: 50
    }
  );
  assert.deepEqual(
    shotgunActionPreset(gauss, { modulePlatformProfileId: "gauss.long" }),
    {
      automatic: false,
      variant: "advanced",
      aimedConeDegrees: 10,
      snapshotConeDegrees: 35,
      burstConeDegrees: 35
    }
  );
});

test("shotgun effective range starts at one meter and follows class, platform, and paid deviations", () => {
  const junk = weaponItem("shotgun-junk", "Обычный дробовик", {
    proficiencyKey: "shotgun",
    effectiveRange: { value: "2", max: "12" },
    maxRangeMeters: "40"
  });
  const sawedOff = weaponItem("shotgun-sawed", "Обрез 12 кал.", {
    proficiencyKey: "shotgun"
  });
  const neostead = weaponItem("ERkjv4ei6Iq21I1C", "Дробовик Неостед-Комбат", {
    proficiencyKey: "shotgun"
  });
  const gauss = weaponItem("o35D4Wga0qc9fU09", "Гаусс-Дробовик", {
    proficiencyKey: "shotgun"
  });

  assert.deepEqual(
    shotgunRangePreset(junk, {
      redistributedClass: "D",
      modulePlatformProfileId: "shotshell.tubularShotgun"
    }),
    { itemClass: "D", effectiveNear: 1, effectiveFar: 4, maximum: 20, deviationRank: 0 }
  );
  assert.deepEqual(
    shotgunRangePreset(sawedOff, {
      redistributedClass: "C",
      modulePlatformProfileId: "shotshell.tubularShotgun"
    }),
    { itemClass: "C", effectiveNear: 1, effectiveFar: 3, maximum: 20, deviationRank: 0 }
  );
  assert.deepEqual(
    shotgunRangePreset(neostead, {
      redistributedClass: "B",
      modulePlatformProfileId: "shotshell.magazineShotgun"
    }),
    { itemClass: "B", effectiveNear: 1, effectiveFar: 7, maximum: 40, deviationRank: 1 }
  );
  assert.deepEqual(
    shotgunRangePreset(gauss, {
      redistributedClass: "B",
      modulePlatformProfileId: "gauss.long"
    }),
    { itemClass: "B", effectiveNear: 1, effectiveFar: 8, maximum: 45, deviationRank: 2 }
  );

  rebalanceWeaponContent(junk, {
    redistributedClass: "D",
    modulePlatformProfileId: "shotshell.tubularShotgun"
  });
  assert.deepEqual(junk.system.functions.weapon.effectiveRange, { value: "1", max: "4" });
  assert.equal(junk.system.functions.weapon.maxRangeMeters, "20");
});

test("ballistic fist is rebuilt as a short-range shotgun platform", () => {
  const item = weaponItem("1n4FxyJUj46cJ0IV", "Баллистический кулак", {
    proficiencyKey: "shotgun",
    effectiveRange: { value: "0", max: "3" },
    maxRangeMeters: "10"
  });
  const platform = {
    redistributedClass: "B",
    modulePlatformProfileId: "hybrid.gauntletLauncher"
  };

  assert.equal(shotgunActionPreset(item, platform).variant, "gauntlet");
  assert.deepEqual(
    shotgunRangePreset(item, platform),
    { itemClass: "B", effectiveNear: 1, effectiveFar: 2, maximum: 10, deviationRank: 0 }
  );

  rebalanceWeaponContent(item, platform);
  assert.equal(item.system.functions.weapon.aimedShot.attackConeDegrees, 25);
  assert.equal(item.system.functions.weapon.snapshot.attackConeDegrees, 45);
  assert.deepEqual(item.system.functions.weapon.effectiveRange, { value: "1", max: "2" });

  const hornet = weaponItem("c718abdd8e1606d3", "Перчатка-дробовик «Шершень»", {
    proficiencyKey: "shotgun",
    effectiveRange: { value: "0", max: "3" },
    maxRangeMeters: "10"
  });
  assert.equal(shotgunActionPreset(hornet)?.variant, "gauntlet");
  assert.deepEqual(
    shotgunRangePreset(hornet),
    { itemClass: "C", effectiveNear: 1, effectiveFar: 2, maximum: 10, deviationRank: 0 }
  );
});

test("single-projectile break-action ballistic weapons do not inherit pellet spread", () => {
  const item = weaponItem("slug-rifle", "Ружьё кал. 45-70", {
    proficiencyKey: "shotgun",
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

  assert.equal(
    shotgunActionPreset(item, { modulePlatformProfileId: "ballistic.shotgun" }),
    null
  );
  assert.equal(
    rebalanceWeaponContent(item, { modulePlatformProfileId: "ballistic.shotgun" }),
    null
  );
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
