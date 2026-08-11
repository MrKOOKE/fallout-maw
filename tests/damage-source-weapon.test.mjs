import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getDamageSourceAdjustedNoiseLevel,
  mergeDamageSourceSpecialProperties,
  resolveDamageSourceAnimationKey
} from "../src/utils/damage-source-weapon.mjs";

const [modelSource, attackSource, actorSheetSource, itemSheetSource, hudSource, itemSheetTemplate] = await Promise.all([
  readFile(new URL("../src/data/models/item-data-models.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8"),
  readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8")
]);

test("weapon animation takes priority over the installed damage source animation", () => {
  assert.equal(resolveDamageSourceAnimationKey("weapon.shot", "source.shot"), "weapon.shot");
  assert.equal(resolveDamageSourceAnimationKey("", "source.shot"), "source.shot");
  assert.equal(resolveDamageSourceAnimationKey("   ", " source.shot "), "source.shot");
});

test("damage source noise is an additive modifier clamped at zero", () => {
  assert.equal(getDamageSourceAdjustedNoiseLevel({ noiseLevel: 4 }, { noiseLevel: 2 }), 6);
  assert.equal(getDamageSourceAdjustedNoiseLevel({ noiseLevel: 4 }, { noiseLevel: -9 }), 0);
  assert.equal(getDamageSourceAdjustedNoiseLevel({}, { noiseLevel: 2 }), 3);
});

test("damage source properties fill missing types while weapon properties keep priority", () => {
  const properties = mergeDamageSourceSpecialProperties({
    specialProperties: [{
      type: "attackPower",
      attackPower: {
        level: { value: 2, max: 4 },
        perLevel: { damagePercent: 10 }
      }
    }]
  }, {
    specialProperties: [{
      type: "attackPower",
      attackPower: {
        level: { value: 4, max: 4 },
        perLevel: { damagePercent: 99 }
      }
    }, {
      type: "concentratedPelletImpact"
    }, {
      type: "concentratedPelletImpact"
    }, {
      type: "pending"
    }]
  });

  assert.deepEqual(properties.map(property => property.type), [
    "attackPower",
    "concentratedPelletImpact"
  ]);
  assert.equal(properties[0].attackPower.level.value, 2);
  assert.equal(properties[0].attackPower.perLevel.damagePercent, 10);
});

test("damage source additional proficiencies extend rather than replace weapon proficiencies", () => {
  const properties = mergeDamageSourceSpecialProperties({
    specialProperties: [{
      type: "additionalProficiencies",
      proficiencyKeys: ["pistol", "rifle"]
    }]
  }, {
    specialProperties: [{
      type: "additionalProficiencies",
      proficiencyKeys: ["rifle", "energy"]
    }]
  });

  assert.deepEqual(properties, [{
    type: "additionalProficiencies",
    proficiencyKeys: ["pistol", "rifle", "energy"]
  }]);
});

test("damage source animation fallback and noise modifier are wired through schema, editor, runtime, and tooltip", () => {
  assert.match(modelSource, /noiseLevel: new NumberField\(\{ required: true, integer: true, initial: 0 \}\)/);
  assert.match(itemSheetTemplate, /name="system\.functions\.damageSource\.noiseLevel"/);
  assert.match(itemSheetTemplate, /name="\{\{path\}\}\.attackAnimationKey" value="\{\{weaponData\.attackAnimationKey\}\}" placeholder="\{\{effectiveWeaponData\.attackAnimationKey\}\}"/);
  assert.match(itemSheetTemplate, /name="\{\{path\}\}\.volley\.explosionAnimationKey" value="\{\{weaponData\.volley\.explosionAnimationKey\}\}" placeholder="\{\{effectiveWeaponData\.volley\.explosionAnimationKey\}\}"/);
  for (const source of [attackSource, actorSheetSource, itemSheetSource]) {
    assert.match(source, /resolveDamageSourceAnimationKey\(/);
    assert.match(source, /getDamageSourceAdjustedNoiseLevel\(/);
  }
  assert.match(actorSheetSource, /DamageSourceNoiseLevelModifier/);
});

test("damage source special properties are wired through schema, editor, form normalization, and effective attack data", () => {
  const damageSourceSchema = modelSource.slice(
    modelSource.indexOf("function damageSourceFunctionField"),
    modelSource.indexOf("function damageSourceVolleyField")
  );
  assert.match(
    damageSourceSchema,
    /specialProperties: new ArrayField\(weaponSpecialPropertyField\(\), \{ required: true, initial: \[\] \}\)/
  );
  assert.match(itemSheetSource, /damageSourceSpecialPropertyEditor:\s*\{/);
  assert.match(
    itemSheetSource,
    /normalizeSubmittedWeaponFunctionData\(functions\.damageSource, currentFunctions\.damageSource\)/
  );
  assert.match(
    itemSheetTemplate,
    /data-weapon-function-path="system\.functions\.damageSource"/
  );
  assert.match(
    itemSheetTemplate,
    /damageSourceSpecialPropertyEditor[\s\S]*?\{\{\.\.\/path\}\}\.specialProperties\.\{\{index\}\}\.type/
  );
  for (const source of [attackSource, actorSheetSource, itemSheetSource, hudSource]) {
    assert.match(source, /specialProperties: mergeDamageSourceSpecialProperties\(/);
  }
});
