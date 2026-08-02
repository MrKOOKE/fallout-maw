import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATURE_DAMAGE_TYPES,
  CREATURE_LIMB_KEYS,
  NATURAL_ARMOR_SPECS,
  validateNaturalArmorCatalog
} from "../scripts/rebalance/creature-natural-armor-catalog.mjs";

test("every implemented biological actor has one complete natural-armor profile", () => {
  assert.equal(validateNaturalArmorCatalog(), true);
  assert.equal(NATURAL_ARMOR_SPECS.length, 8);
  assert.equal(new Set(NATURAL_ARMOR_SPECS.map(spec => spec.actorId)).size, 8);
  for (const spec of NATURAL_ARMOR_SPECS) {
    assert.deepEqual(Object.keys(spec.profile).sort(), [...CREATURE_LIMB_KEYS].sort());
    for (const profile of Object.values(spec.profile)) {
      assert.deepEqual(Object.keys(profile).sort(), [...CREATURE_DAMAGE_TYPES].sort());
    }
  }
});

test("each natural armor leaves eyes and a softer lower body as useful target choices", () => {
  for (const spec of NATURAL_ARMOR_SPECS) {
    for (const damageType of CREATURE_DAMAGE_TYPES) {
      assert.ok(spec.profile.eyes[damageType] <= spec.profile.torso[damageType], `${spec.name}/${damageType}/eyes`);
      assert.ok(spec.profile.groin[damageType] <= spec.profile.torso[damageType], `${spec.name}/${damageType}/groin`);
    }
  }
});
