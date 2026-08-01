import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    getProperty: (object, path) => String(path ?? "").split(".").reduce((value, key) => value?.[key], object),
    setProperty(object, path, value) {
      const parts = String(path ?? "").split(".");
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

const {
  applyWeaponModuleModifiers,
  getWeaponNoiseLevel
} = await import("../src/utils/weapon-modules.mjs");

function createNoiseModule(name, noiseLevel) {
  return {
    _id: name.toLowerCase().replaceAll(" ", "-"),
    name,
    system: {
      functions: {
        module: {
          enabled: true,
          targetFunction: "weapon",
          weapon: { noiseLevel }
        }
      }
    }
  };
}

test("weapon and module schemas define noise immediately after penetration", () => {
  const source = readFileSync(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8");
  assert.match(source, /penetration: new StringField\(\{ required: true, blank: true, initial: "0" \}\),\r?\n\s+noiseLevel: new NumberField\(\{ required: true, integer: true, min: 0, initial: 1 \}\),\r?\n\s+magazine:/);
  assert.match(source, /penetration: new NumberField\(\{ required: true, integer: true, initial: 0 \}\),\r?\n\s+noiseLevel: new NumberField\(\{ required: true, integer: true, initial: 0 \}\),\r?\n\s+magazineMax:/);
});

test("weapon editors and locales expose noise after penetration", () => {
  const template = readFileSync(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8");
  const itemSheet = readFileSync(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8");
  const actorSheet = readFileSync(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8");
  const ru = JSON.parse(readFileSync(new URL("../lang/ru.json", import.meta.url), "utf8"));
  const en = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));

  const modulePenetration = template.indexOf('name="system.functions.module.weapon.penetration"');
  const moduleNoise = template.indexOf('name="system.functions.module.weapon.noiseLevel"');
  const moduleMagazine = template.indexOf('name="system.functions.module.weapon.magazineMax"');
  assert.ok(modulePenetration >= 0 && modulePenetration < moduleNoise && moduleNoise < moduleMagazine);

  const weaponPenetration = template.indexOf('name="{{path}}.penetration"');
  const weaponNoise = template.indexOf('name="{{path}}.noiseLevel"');
  const weaponMagazine = template.indexOf('name="{{path}}.magazine.value"');
  assert.ok(weaponPenetration >= 0 && weaponPenetration < weaponNoise && weaponNoise < weaponMagazine);
  assert.match(itemSheet, /penetration: 0,\r?\n\s+noiseLevel: 1,\r?\n\s+magazine:/);
  assert.match(
    actorSheet,
    /pushModuleChangeRow\([^\n]+WeaponPenetration[^\n]+\);\r?\n\s+pushModuleChangeRow\([^\n]+WeaponNoiseLevel[\s\S]*?higherIsBetter: false\r?\n\s+\}\);\r?\n\s+pushModuleChangeRow\([^\n]+WeaponMagazine/
  );
  assert.match(
    actorSheet,
    /WeaponPenetration[\s\S]*?stats\.breakdowns\?\.penetration[\s\S]*?WeaponNoiseLevel[\s\S]*?stats\.breakdowns\?\.noiseLevel[\s\S]*?getWeaponResourceCostRows/
  );

  assert.equal(ru.FALLOUTMAW.Item.WeaponNoiseLevel, "Уровень шума");
  assert.equal(en.FALLOUTMAW.Item.WeaponNoiseLevel, "Noise Level");
});

test("weapon noise normalization uses base 1 and clamps integers", () => {
  assert.equal(getWeaponNoiseLevel(), 1);
  assert.equal(getWeaponNoiseLevel({}), 1);
  assert.equal(getWeaponNoiseLevel({ noiseLevel: null }), 1);
  assert.equal(getWeaponNoiseLevel({ noiseLevel: "" }), 1);
  assert.equal(getWeaponNoiseLevel({ noiseLevel: "invalid" }), 1);
  assert.equal(getWeaponNoiseLevel({ noiseLevel: "5" }), 5);
  assert.equal(getWeaponNoiseLevel({ noiseLevel: 3.9 }), 3);
  assert.equal(getWeaponNoiseLevel({ noiseLevel: -4 }), 0);
});

test("weapon modules add noise from base 1 and clamp only the final total", () => {
  const loudModule = createNoiseModule("Loud Barrel", 4);
  const suppressor = createNoiseModule("Suppressor", -5);
  const compensator = createNoiseModule("Compensator", 5);

  const baseWeapon = { noiseLevel: 1 };
  const loudWeapon = applyWeaponModuleModifiers(baseWeapon, {
    moduleSlots: [{ id: "barrel", itemData: loudModule }]
  });
  assert.equal(loudWeapon.noiseLevel, 5);
  assert.deepEqual(baseWeapon, { noiseLevel: 1 });

  const quietWeapon = applyWeaponModuleModifiers({ noiseLevel: 2 }, {
    moduleSlots: [{ id: "muzzle", itemData: suppressor }]
  });
  assert.equal(quietWeapon.noiseLevel, 0);

  const orderedWeapon = applyWeaponModuleModifiers({ noiseLevel: 1 }, {
    moduleSlots: [
      { id: "muzzle", itemData: suppressor },
      { id: "barrel", itemData: compensator }
    ]
  });
  const reversedWeapon = applyWeaponModuleModifiers({ noiseLevel: 1 }, {
    moduleSlots: [
      { id: "barrel", itemData: compensator },
      { id: "muzzle", itemData: suppressor }
    ]
  });
  assert.equal(orderedWeapon.noiseLevel, 1);
  assert.equal(reversedWeapon.noiseLevel, 1);
});
