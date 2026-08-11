import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  WEAPON_SPECIAL_PROPERTIES,
  createDefaultWeaponSpecialPropertyData,
  getConfiguredWeaponProficiencyKeys,
  normalizeWeaponSpecialProperty
} = await import("../src/utils/item-functions.mjs");
const {
  calculateWeaponProficiencyInfluenceBonus,
  calculateWeaponProficiencyInfluenceLayers
} = await import("../src/utils/weapon-proficiency-layers.mjs");

const proficiencies = [
  { key: "pistol", label: "Пистолеты", max: 100 },
  { key: "rifle", label: "Винтовки", max: 50 },
  { key: "energy", label: "Энергооружие", max: 80 }
];
const influences = {
  pistol: { accuracy: { min: 0, max: 20 } },
  rifle: { accuracy: { min: 2, max: 6 } },
  energy: { accuracy: { min: -2, max: 10 } }
};
const actor = {
  system: {
    proficiencies: {
      pistol: { value: 50 },
      rifle: { value: 25 },
      energy: { value: 80 }
    }
  }
};
const getInfluenceSettings = proficiency => influences[proficiency.key];

test("additional proficiency property normalizes unique keys and keeps its typed payload", () => {
  const type = WEAPON_SPECIAL_PROPERTIES.additionalProficiencies;
  assert.deepEqual(createDefaultWeaponSpecialPropertyData(type), {
    type,
    proficiencyKeys: []
  });
  assert.deepEqual(normalizeWeaponSpecialProperty({
    type,
    proficiencyKeys: [" rifle ", "pistol", "rifle", "", null]
  }), {
    type,
    proficiencyKeys: ["rifle", "pistol"]
  });
  assert.deepEqual(getConfiguredWeaponProficiencyKeys({
    proficiencyKey: "pistol",
    specialProperties: [{ type, proficiencyKeys: ["rifle", "pistol", "energy"] }]
  }), ["pistol", "rifle", "energy"]);
});

test("primary and every unique valid additional proficiency produce separate additive layers", () => {
  const weaponData = {
    proficiencyKey: "pistol",
    specialProperties: [{
      type: "additionalProficiencies",
      proficiencyKeys: ["rifle", "pistol", "unknown", "energy", "rifle"]
    }]
  };
  const options = { proficiencies, getInfluenceSettings };
  const layers = calculateWeaponProficiencyInfluenceLayers(actor, weaponData, "accuracy", options);

  assert.deepEqual(layers, [
    { key: "pistol", label: "Пистолеты", value: 10 },
    { key: "rifle", label: "Винтовки", value: 4 },
    { key: "energy", label: "Энергооружие", value: 10 }
  ]);
  assert.equal(calculateWeaponProficiencyInfluenceBonus(actor, weaponData, "accuracy", options), 24);
});

test("additional proficiencies are wired through normalization, schema, and every weapon property editor", async () => {
  const [attackSettings, model, itemSource, catalogSource, itemTemplate, catalogTemplate] = await Promise.all([
    readFile(new URL("../src/abilities/attack-action-settings.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8")
  ]);

  assert.match(model, /WEAPON_SPECIAL_PROPERTY_ADDITIONAL_PROFICIENCIES/);
  assert.match(model, /proficiencyKeys:\s*new ArrayField\(new StringField/);
  assert.match(attackSettings, /ATTACK_ACTION_SPECIAL_PROPERTY_TYPES[\s\S]*?"additionalProficiencies"/);
  assert.match(attackSettings, /type === "additionalProficiencies"[\s\S]*?proficiencyKeys:/);
  assert.equal((itemTemplate.match(/data-add-weapon-additional-proficiency/g) ?? []).length, 3);
  assert.equal((itemTemplate.match(/\.specialProperties\.\{\{\.\.\/index\}\}\.proficiencyKeys\.\{\{index\}\}/g) ?? []).length, 3);
  assert.equal((itemTemplate.match(/data-delete-weapon-additional-proficiency/g) ?? []).length, 3);
  assert.match(catalogTemplate, /data-action="addAttackAdditionalProficiency"/);
  assert.match(catalogTemplate, /data-field="attack\.specialProperty\.additionalProficiency"/);
  assert.match(catalogTemplate, /data-action="deleteAttackAdditionalProficiency"/);
  for (const source of [itemSource, catalogSource]) {
    assert.match(source, /isAdditionalProficiencies/);
    assert.match(source, /normalizeWeaponAdditionalProficiencyKeys/);
  }
  assert.match(itemSource, /#onWeaponSpecialPropertyTypeChange[\s\S]*?createDefaultWeaponSpecialPropertyData/);
  assert.doesNotMatch(itemSource, /createFoundryForcedReplacement/);
});
