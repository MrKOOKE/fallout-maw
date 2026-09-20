import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { applyWeaponModuleActionModifiers, getWeaponModuleActionTooltipRows, MODULE_ACTION_LABELS, getModuleActionNumericFields } from "../src/utils/weapon-module-actions.mjs";
import { applyWeaponModuleModifiers } from "../src/utils/weapon-modules.mjs";

globalThis.foundry = { utils: {
  deepClone: structuredClone,
  getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
  setProperty: (object, path, value) => {
    const parts = path.split("."); const key = parts.pop();
    parts.reduce((entry, part) => (entry[part] ??= {}), object)[key] = value;
  }
} };

const weapon = () => ({
  availableActions: { burst: true, aimedShot: true },
  burst: { name: "Burst", actionPointCost: 5, count: 3, difficultyPerShot: 10, attackConeDegrees: 3 },
  meleeAttack: { thrust: { enabled: true, accuracyModifier: 5 }, swing: { enabled: true, damagePercentModifier: 20 } },
  volley: { damageRadius: "@strength", regionRadius: "4", regionDurationSeconds: "8", regionDamageEntries: [{ damageTypeKey: "fire", amount: "1d6" }], regionSpecialProperties: [] }
});
const slot = (actions, costs = {}) => ({ itemData: { type: "gear", system: { functions: {
  module: { enabled: true, targetFunction: "weapon", weapon: { actions, actionPointCosts: costs } }
} } } });

test("installed modules add action changes, preserve old AP discounts and leave source data untouched", () => {
  const base = weapon();
  const result = applyWeaponModuleModifiers(base, { moduleSlots: [
    slot({ burst: { count: 2, difficultyPerShot: -4, attackConeDegrees: 6 } }, { burst: -1 }),
    slot({ burst: { count: 1 } }, { burst: -1 })
  ] });
  assert.deepEqual(result.burst, { name: "Burst", actionPointCost: 3, count: 6, difficultyPerShot: 6, attackConeDegrees: 9 });
  assert.equal(base.burst.count, 3);
  assert.equal(base.burst.actionPointCost, 5);
});

test("negative changes respect action bounds and optional weakening scales deltas", () => {
  const base = weapon();
  applyWeaponModuleActionModifiers(base, { burst: { count: -20, difficultyPerShot: -30, attackConeDegrees: -9 } });
  assert.equal(base.burst.count, 1);
  assert.equal(base.burst.difficultyPerShot, 0);
  assert.equal(base.burst.attackConeDegrees, 0);
  const scaled = weapon();
  applyWeaponModuleActionModifiers(scaled, { burst: { count: 4, attackConeDegrees: 5 } }, 0.5);
  assert.equal(scaled.burst.count, 5);
  assert.equal(scaled.burst.attackConeDegrees, 5.5);
});

test("empty/default action changes do not disable actions or replace existing names", () => {
  const base = weapon(), original = structuredClone(base);
  applyWeaponModuleActionModifiers(base, { burst: { name: "", availability: "unchanged", count: 0, attackConeDegrees: 0, criticalFailureConsequences: [] } });
  assert.deepEqual(base, original);
  applyWeaponModuleActionModifiers(base, { burst: { name: "New burst", availability: "disable" }, snapshot: { availability: "enable" } });
  assert.equal(base.burst.name, "New burst");
  assert.equal(base.availableActions.burst, false);
  assert.equal(base.availableActions.snapshot, true);
});

test("melee direction states, push parameters and damage modifiers are applied independently", () => {
  const base = weapon();
  applyWeaponModuleActionModifiers(base, {
    meleeAttack: { thrust: { enabled: "disable", accuracyModifier: 2 }, swing: { damagePercentModifier: 15, criticalChanceModifier: -5 } },
    push: { maxRangeMeters: 2, accuracyModifier: 10, pushDifficultyModifier: -20 }
  });
  assert.deepEqual(base.meleeAttack.thrust, { enabled: false, accuracyModifier: 7 });
  assert.deepEqual(base.meleeAttack.swing, { enabled: true, damagePercentModifier: 35, criticalChanceModifier: -5 });
  assert.equal(base.push.pushDifficultyModifier, -20);
});

test("volley modifiers compose formulas and typed area damage without losing ammunition values", () => {
  const base = weapon();
  applyWeaponModuleActionModifiers(base, { volley: {
    damageRadius: "2", regionRadius: "-1", regionDurationSeconds: "4",
    regionDelaySeconds: "3", regionRadiusDeltaMeters: "-2",
    explosionAnimationKey: "explosion", explosionSoundPath: "sound.ogg",
    regionDamageEntries: [{ damageTypeKey: "fire", amount: "2" }, { damageTypeKey: "poison", amount: "3" }],
    regionSpecialProperties: [{ type: "smoke", smoke: { thickness: "2", densityPercent: "50" } }]
  } });
  assert.equal(base.volley.damageRadius, "(@strength) + (2)");
  assert.equal(base.volley.regionRadius, "3");
  assert.equal(base.volley.regionDurationSeconds, "12");
  assert.equal(base.volley.regionRadiusDeltaMeters, "-2");
  assert.equal(base.volley.regionDamageEntries[0].amount, "(1d6) + (2)");
  assert.equal(base.volley.regionDamageEntries[1].amount, "3");
  assert.equal(base.volley.explosionAnimationKey, "explosion");
  assert.equal(base.volley.regionSpecialProperties[0].smoke.thickness, "2");
});

test("list replacement explicitly clears data while append retains existing critical failures", () => {
  const base = weapon();
  base.burst.criticalFailureConsequences = [{ resourceType: "magazine", amount: 1 }];
  applyWeaponModuleActionModifiers(base, {
    burst: { criticalFailureConsequences: [{ resourceType: "condition", amount: 2 }] },
    volley: { regionDamageEntriesMode: "replace", regionDamageEntries: [] }
  });
  assert.equal(base.burst.criticalFailureConsequences.length, 2);
  assert.deepEqual(base.volley.regionDamageEntries, []);
});

test("module tooltips describe nonzero deltas with signs and omit unchanged fields", () => {
  const ru = JSON.parse(readFileSync(new URL("../lang/ru.json", import.meta.url), "utf8"));
  const localize = key => key.split(".").reduce((value, part) => value?.[part], ru) ?? key;
  const rows = getWeaponModuleActionTooltipRows({
    burst: { count: 2, difficultyPerShot: -3, attackConeDegrees: 0, name: "" },
    volley: { regionDurationSeconds: "5", explosionAnimationKey: "blast" },
    meleeAttack: { thrust: { accuracyModifier: 10, enabled: "disable" } }
  }, localize);
  assert.ok(rows.some(([label, value]) => label.endsWith("Выстрелов в очереди") && value === "+2"));
  assert.ok(rows.some(([, value]) => value === "-3"));
  assert.ok(rows.some(([, value]) => value === "Отключить"));
  assert.ok(rows.every(([label, value]) => !label.includes("FALLOUTMAW.") && value !== "0"));
});

test("typed modifier schema starts neutral and permits negative changes for every numeric action field", () => {
  const source = readFileSync(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8");
  const names = ["weaponModuleActionsField", "weaponCriticalFailureConsequenceField", "weaponDamageEntryField", "regionSpecialPropertyField"];
  const functions = names.map(name => {
    const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, name);
    return match[0];
  }).join("\n");
  class Field { constructor(options = {}) { this.options = options; } }
  class SchemaField extends Field { constructor(fields) { super(); this.fields = fields; } }
  class ArrayField extends Field { constructor(element, options) { super(options); this.element = element; } }
  const schema = new Function("MODULE_ACTION_LABELS", "getModuleActionNumericFields", "SchemaField", "ArrayField", "StringField", "NumberField", "BooleanField", `${functions}\nreturn weaponModuleActionsField();`)(MODULE_ACTION_LABELS, getModuleActionNumericFields, SchemaField, ArrayField, Field, Field, Field);
  for (const key of Object.keys(MODULE_ACTION_LABELS)) {
    const action = schema.fields[key];
    assert.equal(action.fields.availability.options.initial, "unchanged");
    for (const spec of getModuleActionNumericFields(key)) {
      const target = spec.path.split(".").reduce((field, part) => field.fields[part], action);
      assert.equal(Number(target.options.initial), 0);
      assert.equal(target.options.min, undefined, `${key}.${spec.path} must accept negative deltas`);
    }
  }
});
