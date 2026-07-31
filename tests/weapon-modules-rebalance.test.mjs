import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    getProperty: (object, propertyPath) => String(propertyPath ?? "")
      .split(".")
      .reduce((value, key) => value?.[key], object),
    setProperty(object, propertyPath, value) {
      const parts = String(propertyPath ?? "").split(".");
      const key = parts.pop();
      const target = parts.reduce((entry, part) => (entry[part] ??= {}), object);
      target[key] = value;
      return true;
    }
  }
};

globalThis.game = {
  items: {
    contents: [],
    get: () => null
  },
  settings: {
    get: () => null
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");

const {
  DEFERRED_MODULE_IMAGES,
  MODULE_CATALOG,
  MODULE_SLOT_KEYS,
  MODULE_TRADEOFF_POLICY_V3,
  analyzeModuleValue,
  buildModuleRecipeSpec,
  validateModuleCatalog
} = await import("../scripts/rebalance/module-catalog.mjs");
const {
  allocateWeaponSlotKeys,
  validateSlotAllocation
} = await import("../scripts/rebalance/module-slot-allocation.mjs");
const {
  applyWeaponModuleModifiers,
  createWeaponModuleSlotItemData
} = await import("../src/utils/weapon-modules.mjs");

const auditPath = path.join(
  dataRoot,
  "catalogs",
  "fallout-maw-world",
  "weapon-platform-audit",
  "redistribution-v0.3",
  "platform-redistribution-v0.3-items.ndjson"
);

function auditRecords() {
  return fs.readFileSync(auditPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
}

function moduleItem(modifiers, current = 100, maximum = 100, hasAttack = false) {
  return {
    name: "Test module",
    system: {
      functions: {
        module: {
          enabled: true,
          targetFunction: "weapon",
          weapon: modifiers
        },
        condition: {
          enabled: hasAttack,
          value: current,
          max: maximum,
          weakeningThreshold: hasAttack ? 20 : 0
        },
        freeSettings: {
          enabled: false,
          useConditionWeakening: hasAttack,
          entries: []
        }
      }
    }
  };
}

test("installed module snapshots retain gameplay data without embedded Document bookkeeping", () => {
  const source = {
    _id: "owned-module",
    name: "Scope",
    type: "gear",
    img: "scope.webp",
    folder: "inventory-folder",
    sort: 100000,
    ownership: { default: 0, owner: 3 },
    _stats: { modifiedTime: 1234, lastModifiedBy: "owner" },
    flags: { "fallout-maw": { prototypeUuid: "Item.prototype" } },
    effects: [{ _id: "effect", name: "Module effect" }],
    system: {
      quantity: 7,
      functions: {
        module: { enabled: true, targetFunction: "weapon" }
      }
    }
  };
  const item = { toObject: () => structuredClone(source) };

  const snapshot = createWeaponModuleSlotItemData(item);

  assert.deepEqual(Object.keys(snapshot).sort(), ["effects", "flags", "img", "name", "system", "type"]);
  assert.equal(snapshot.system.quantity, 1);
  assert.equal(snapshot.system.functions.module.enabled, true);
  assert.equal(snapshot.effects[0].name, "Module effect");
  assert.equal(source.system.quantity, 7, "snapshot preparation must not mutate the inventory Item");
});

test("module catalogue is complete, source-first, and respects AP limits", () => {
  const validation = validateModuleCatalog();
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(MODULE_CATALOG.length, 172);
  assert.equal(validation.counts.additionalWeapons, 16);
  assert.equal(validation.counts.lightSources, 3);

  for (const slotKey of Object.values(MODULE_SLOT_KEYS)) {
    assert.doesNotMatch(slotKey, /\b[DCBAS]\b|класс/i, slotKey);
  }

  for (const definition of MODULE_CATALOG) {
    assert.equal(definition.modifiers.damage, 0, definition.name);
    const actionPointChanges = Object.values(definition.modifiers.actionPointCosts)
      .filter(value => value !== 0);
    for (const value of actionPointChanges) {
      assert.ok(Math.abs(value) <= 1, `${definition.name}: ${value}`);
      assert.equal(value, -1, `${definition.name}: ${value}`);
    }
    if (definition.class !== "S") assert.equal(actionPointChanges.length, 0, definition.name);
    assert.ok(actionPointChanges.length <= 1, definition.name);
    const imagePath = path.join(dataRoot, definition.img);
    assert.equal(fs.existsSync(imagePath), true, imagePath);
    const recipe = buildModuleRecipeSpec(definition);
    assert.ok(recipe.ingredients.length >= 2, definition.name);
    assert.ok(recipe.difficulty >= 40, definition.name);
  }

  for (const image of DEFERRED_MODULE_IMAGES) {
    assert.equal(fs.existsSync(path.join(dataRoot, image)), true, image);
  }
});

test("module value scale is material and Gauss keeps the penetration extreme", () => {
  const originalBlade = MODULE_CATALOG.find(module => module.id === "blade-original-d");
  const reinforcedChain = MODULE_CATALOG.find(module => module.id === "blade-chain-c");
  const corkCore = MODULE_CATALOG.find(module => module.id === "impact-cork-d");
  const gaussB = MODULE_CATALOG.find(module => module.id === "gauss-accelerator-b");
  const gaussA = MODULE_CATALOG.find(module => module.id === "gauss-accelerator-a");
  const gaussS = MODULE_CATALOG.find(module => module.id === "gauss-accelerator-s");

  assert.deepEqual(
    {
      accuracy: originalBlade.modifiers.accuracyBonus,
      penetration: originalBlade.modifiers.penetration
    },
    { accuracy: 6, penetration: 7 }
  );
  assert.deepEqual(
    {
      accuracy: reinforcedChain.modifiers.accuracyBonus,
      penetration: reinforcedChain.modifiers.penetration
    },
    { accuracy: 8, penetration: 14 }
  );
  assert.equal(corkCore.modifiers.accuracyBonus, 10);
  assert.equal(corkCore.modifiers.criticalDamagePercent, 0);
  assert.equal(corkCore.modifiers.actionPointCosts.meleeAttack, 0);
  assert.ok(gaussB.modifiers.penetration >= 40);
  assert.ok(gaussA.modifiers.penetration >= 90);
  assert.ok(gaussS.modifiers.penetration >= 200);
});

test("ordinary modules are pure upgrades and every rare tradeoff is strongly favorable", () => {
  for (const definition of MODULE_CATALOG) {
    const analysis = analyzeModuleValue(definition);
    const benefitUnits = analysis.channels.reduce(
      (sum, channel) => sum + channel.benefitUnits,
      0
    );
    const penaltyUnits = analysis.channels.reduce(
      (sum, channel) => sum + channel.penaltyUnits,
      0
    );
    if (!penaltyUnits) {
      assert.equal(
        Object.hasOwn(MODULE_TRADEOFF_POLICY_V3, definition.id),
        false,
        `${definition.name}: unused tradeoff policy`
      );
      continue;
    }
    const policy = MODULE_TRADEOFF_POLICY_V3[definition.id];
    assert.ok(policy, `${definition.name}: penalty without explicit policy`);
    assert.ok(benefitUnits >= 1, `${definition.name}: weak module received a penalty`);
    assert.ok(
      benefitUnits >= penaltyUnits * policy.minimumBenefitToPenaltyRatio,
      `${definition.name}: benefit ${benefitUnits} / penalty ${penaltyUnits}`
    );
    for (const channel of analysis.channels) {
      assert.equal(
        channel.paidUnits,
        channel.benefitUnits,
        `${definition.name}/${channel.id}: penalty discounted the recipe`
      );
    }
  }
});

test("module recipes pay separately for each real benefit channel", () => {
  const reinforcedChain = MODULE_CATALOG.find(module => module.id === "blade-chain-c");
  const recipe = buildModuleRecipeSpec(reinforcedChain);
  const channels = new Set(recipe.deviationPayments.map(payment => payment.channel));
  assert.ok(channels.has("accuracy"));
  assert.ok(channels.has("penetration"));
  assert.ok(recipe.ingredients.some(ingredient => (
    ingredient.kind === "properties" && ingredient.class === "D"
  )));
  assert.ok(recipe.ingredients.some(ingredient => (
    ingredient.kind === "armor" && ingredient.class === "D"
  )));
});

test("high-class module recipes mix component classes instead of becoming solid S blocks", () => {
  const smartMuzzle = MODULE_CATALOG.find(module => module.id === "muzzle-standard-smart-s");
  const recipe = buildModuleRecipeSpec(smartMuzzle);
  const classes = new Set(recipe.ingredients.map(ingredient => ingredient.class));
  const ownClassCount = recipe.ingredients
    .filter(ingredient => ingredient.class === "S")
    .reduce((sum, ingredient) => sum + ingredient.quantity, 0);
  const totalCount = recipe.ingredients.reduce(
    (sum, ingredient) => sum + ingredient.quantity,
    0
  );

  assert.ok(classes.has("B"));
  assert.ok(classes.has("A"));
  assert.ok(classes.has("S"));
  assert.ok(ownClassCount > 0);
  assert.ok(ownClassCount < totalCount / 2);
});

test("suppressors have material C-S ladders and top variants can approach two-cell noise", () => {
  const byId = new Map(MODULE_CATALOG.map(module => [module.id, module]));
  const ladders = [
    [
      "muzzle-compact-suppressor-c",
      "muzzle-compact-suppressor-b",
      "muzzle-compact-adaptive-a",
      "muzzle-compact-smart-s"
    ],
    [
      "muzzle-standard-suppressor-c",
      "muzzle-standard-suppressor-b",
      "muzzle-standard-adaptive-a",
      "muzzle-standard-smart-s"
    ],
    [
      "muzzle-shotgun-suppressor-c",
      "muzzle-shotgun-suppressor-b",
      "muzzle-shotgun-suppressor-a",
      "muzzle-shotgun-suppressor-s"
    ]
  ];

  for (const ids of ladders) {
    const suppression = ids.map(id => -byId.get(id).modifiers.noiseLevel);
    for (let index = 1; index < suppression.length; index += 1) {
      assert.ok(suppression[index] > suppression[index - 1], ids.join(", "));
    }
  }
  assert.equal(
    25 + byId.get("muzzle-shotgun-suppressor-s").modifiers.noiseLevel,
    2
  );
  assert.ok(byId.get("muzzle-standard-smart-s").modifiers.accuracyBonus >= 40);
});

test("module effect fingerprints are distinct within the same technical slot", () => {
  const seen = new Map();
  for (const module of MODULE_CATALOG) {
    const fingerprint = JSON.stringify({
      slotKey: module.slotKey,
      modifiers: module.modifiers,
      light: module.light,
      attack: module.attack
    });
    assert.equal(
      seen.has(fingerprint),
      false,
      `${module.name} duplicates ${seen.get(fingerprint) ?? "another module"}`
    );
    seen.set(fingerprint, module.name);
  }
});

test("S-class action discounts cannot stack on one action through different slots", () => {
  const discountedModules = MODULE_CATALOG.flatMap(module => (
    Object.entries(module.modifiers.actionPointCosts)
      .filter(([, value]) => value < 0)
      .map(([action]) => ({
        action,
        slotKey: module.slotKey,
        name: module.name
      }))
  ));
  for (const record of auditRecords()) {
    const slotKeys = allocateWeaponSlotKeys(record);
    for (const action of new Set(discountedModules.map(module => module.action))) {
      const compatibleSlotKeys = new Set(
        discountedModules
          .filter(module => module.action === action && slotKeys.includes(module.slotKey))
          .map(module => module.slotKey)
      );
      assert.ok(
        compatibleSlotKeys.size <= 1,
        `${record.itemName}: ${action} through ${[...compatibleSlotKeys].join(", ")}`
      );
    }
  }
});

test("fixed and variable optics implement different close-range behavior", () => {
  const fixed4 = MODULE_CATALOG.find(module => module.id === "optic-standard-fixed4-b");
  const variable14 = MODULE_CATALOG.find(module => module.id === "optic-standard-variable14-b");
  const fixed8 = MODULE_CATALOG.find(module => module.id === "optic-standard-fixed8-a");
  const variable18 = MODULE_CATALOG.find(module => module.id === "optic-standard-variable28-a");

  assert.ok(fixed4.modifiers.effectiveRange.value > 0);
  assert.equal(variable14.modifiers.effectiveRange.value, 0);
  assert.ok(fixed8.modifiers.effectiveRange.value > variable18.modifiers.effectiveRange.value);
  assert.ok(variable14.complexity > fixed4.complexity);
  assert.ok(variable18.complexity > fixed8.complexity);
});

test("every audited platform receives valid slots and ballistic fist stays a shotgun", () => {
  const records = auditRecords();
  const validation = validateSlotAllocation(records, MODULE_CATALOG);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(records.length, 779);
  assert.ok(validation.hostCounts[MODULE_SLOT_KEYS.underbarrel] >= 100);

  const ballisticFist = records.find(record => record.modulePlatformProfileId === "hybrid.gauntletLauncher");
  const slotKeys = allocateWeaponSlotKeys(ballisticFist);
  assert.ok(slotKeys.includes(MODULE_SLOT_KEYS.impactHead));
  assert.ok(slotKeys.includes(MODULE_SLOT_KEYS.shotgunBarrel));
  assert.ok(slotKeys.includes(MODULE_SLOT_KEYS.shotgunMuzzle));
  assert.ok(!slotKeys.includes(MODULE_SLOT_KEYS.specialFeed));
});

test("weapon module bonuses do not depend on condition", () => {
  const modifiers = {
    damage: 0,
    accuracyBonus: 10,
    criticalChanceModifier: 5,
    criticalDamagePercent: 20,
    attackConeDegrees: 10,
    maxRangeMeters: 20,
    effectiveRange: { value: 5, max: 10 },
    penetration: 10,
    noiseLevel: -5,
    magazineMax: 10,
    actionPointCosts: {
      aimedShot: -1,
      snapshot: 0,
      burst: 0,
      volley: 0,
      meleeAttack: 0,
      aimedMeleeAttack: 0,
      push: 0,
      reload: 0
    }
  };
  const base = {
    accuracyBonus: "0",
    criticalChanceModifier: "0",
    criticalDamagePercent: "150",
    attackConeDegrees: 3,
    maxRangeMeters: "40",
    effectiveRange: { value: "1", max: "10" },
    penetration: "0",
    noiseLevel: 10,
    magazine: { value: 5, max: 5 },
    aimedShot: { actionPointCost: 5 }
  };
  const used = applyWeaponModuleModifiers(base, {
    moduleSlots: [{ id: "test", itemData: moduleItem(modifiers, 60, 100) }]
  });
  assert.equal(used.accuracyBonus, 10);
  assert.equal(used.maxRangeMeters, 60);
  assert.equal(used.penetration, 10);
  assert.equal(used.magazine.max, 15);
  assert.equal(used.noiseLevel, 5);
  assert.equal(used.aimedShot.actionPointCost, 4);

  const zeroCondition = applyWeaponModuleModifiers(base, {
    moduleSlots: [{ id: "test", itemData: moduleItem(modifiers, 0, 100) }]
  });
  assert.deepEqual(zeroCondition, used);
});

test("attacking module bonuses weaken with their condition", () => {
  const modifiers = {
    damage: 0,
    accuracyBonus: 10,
    criticalChanceModifier: 5,
    criticalDamagePercent: 20,
    attackConeDegrees: 10,
    maxRangeMeters: 20,
    effectiveRange: { value: 5, max: 10 },
    penetration: 10,
    noiseLevel: -5,
    magazineMax: 10,
    actionPointCosts: {
      aimedShot: -1,
      snapshot: 0,
      burst: 0,
      volley: 0,
      meleeAttack: 0,
      aimedMeleeAttack: 0,
      push: 0,
      reload: 0
    }
  };
  const base = {
    accuracyBonus: "0",
    criticalChanceModifier: "0",
    criticalDamagePercent: "150",
    attackConeDegrees: 3,
    maxRangeMeters: "40",
    effectiveRange: { value: "1", max: "10" },
    penetration: "0",
    noiseLevel: 10,
    magazine: { value: 5, max: 5 },
    aimedShot: { actionPointCost: 5 }
  };
  const weakened = applyWeaponModuleModifiers(base, {
    moduleSlots: [{ id: "test", itemData: moduleItem(modifiers, 60, 100, true) }]
  });
  assert.equal(weakened.accuracyBonus, 8);
  assert.equal(weakened.maxRangeMeters, 56);
  assert.equal(weakened.penetration, 8);
  assert.equal(weakened.magazine.max, 13);
  assert.equal(weakened.noiseLevel, 6);
  assert.equal(weakened.aimedShot.actionPointCost, 4);

  const broken = applyWeaponModuleModifiers(base, {
    moduleSlots: [{ id: "test", itemData: moduleItem(modifiers, 0, 100, true) }]
  });
  assert.deepEqual(broken, base);
});
