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
  buildModuleRecipeSpec,
  validateModuleCatalog
} = await import("../scripts/rebalance/module-catalog.mjs");
const {
  allocateWeaponSlotKeys,
  validateSlotAllocation
} = await import("../scripts/rebalance/module-slot-allocation.mjs");
const {
  applyWeaponModuleModifiers
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

function moduleItem(modifiers, current = 100, maximum = 100) {
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
          enabled: true,
          value: current,
          max: maximum,
          weakeningThreshold: 20
        },
        freeSettings: {
          enabled: false,
          useConditionWeakening: true,
          entries: []
        }
      }
    }
  };
}

test("module catalogue is complete, source-first, and respects AP limits", () => {
  const validation = validateModuleCatalog();
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(MODULE_CATALOG.length, 168);
  assert.equal(validation.counts.additionalWeapons, 16);
  assert.equal(validation.counts.lightSources, 3);

  for (const slotKey of Object.values(MODULE_SLOT_KEYS)) {
    assert.doesNotMatch(slotKey, /\b[DCBAS]\b|класс/i, slotKey);
  }

  for (const definition of MODULE_CATALOG) {
    assert.equal(definition.modifiers.damage, 0, definition.name);
    for (const value of Object.values(definition.modifiers.actionPointCosts)) {
      assert.ok(Math.abs(value) <= 1, `${definition.name}: ${value}`);
    }
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

test("module bonuses weaken with module condition", () => {
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
    moduleSlots: [{ id: "test", itemData: moduleItem(modifiers, 60, 100) }]
  });
  assert.equal(weakened.accuracyBonus, 8);
  assert.equal(weakened.maxRangeMeters, 56);
  assert.equal(weakened.penetration, 8);
  assert.equal(weakened.magazine.max, 13);
  assert.equal(weakened.noiseLevel, 6);
  assert.equal(weakened.aimedShot.actionPointCost, 4);

  const broken = applyWeaponModuleModifiers(base, {
    moduleSlots: [{ id: "test", itemData: moduleItem(modifiers, 0, 100) }]
  });
  assert.deepEqual(broken, base);
});
