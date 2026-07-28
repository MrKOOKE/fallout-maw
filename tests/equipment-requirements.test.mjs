import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEquipmentRequirementMovementPointChange,
  calculateEquipmentRequirementMovementPointPenalty,
  getDamageMitigationRequirements,
  hasDamageMitigationRequirements,
  isActiveDamageMitigationRequirementItem
} from "../src/items/equipment-requirements.mjs";

function createArmor({
  equipped = true,
  placementMode = "equipment",
  enabled = true,
  requirements = []
} = {}) {
  return {
    type: "gear",
    system: {
      equipped,
      placement: { mode: placementMode },
      functions: {
        damageMitigation: {
          enabled,
          requirements
        }
      }
    }
  };
}

test("damage-mitigation requirements produce the normal movement-point bonus change", () => {
  const actor = {
    system: {
      characteristics: { strength: 5 },
      skills: { athletics: { value: 42 } }
    }
  };
  const armor = createArmor({
    requirements: [
      { type: "characteristic", key: "strength", value: 8 },
      { type: "skill", key: "athletics", value: 60 }
    ]
  });

  assert.equal(calculateEquipmentRequirementMovementPointPenalty(actor, armor), 6);
  assert.deepEqual(buildEquipmentRequirementMovementPointChange(actor, armor), {
    key: "system.resources.movementPoints.bonus",
    type: "add",
    value: "-6",
    phase: "initial",
    priority: null
  });
});

test("skill shortages consume one movement point per complete five missing points", () => {
  const actor = {
    system: {
      characteristics: {},
      skills: { athletics: { value: 46 } }
    }
  };
  const armor = createArmor({
    requirements: [{ type: "skill", key: "athletics", value: 50 }]
  });

  assert.equal(calculateEquipmentRequirementMovementPointPenalty(actor, armor), 0);
  actor.system.skills.athletics.value = 45;
  assert.equal(calculateEquipmentRequirementMovementPointPenalty(actor, armor), 1);
});

test("requirements belong only to an enabled damage-mitigation function", () => {
  const requirement = { type: "skill", key: "athletics", value: 40 };
  const disabled = createArmor({ enabled: false, requirements: [requirement] });
  const legacyTopLevel = {
    type: "gear",
    system: {
      equipped: true,
      requirements: [requirement],
      functions: {}
    }
  };

  assert.deepEqual(getDamageMitigationRequirements(disabled), []);
  assert.equal(hasDamageMitigationRequirements(disabled), false);
  assert.equal(hasDamageMitigationRequirements(legacyTopLevel), false);
});

test("only worn protective gear projects requirement penalties", () => {
  const requirement = { type: "skill", key: "athletics", value: 40 };
  assert.equal(isActiveDamageMitigationRequirementItem(createArmor({
    equipped: false,
    placementMode: "inventory",
    requirements: [requirement]
  })), false);
  assert.equal(isActiveDamageMitigationRequirementItem(createArmor({
    equipped: true,
    placementMode: "equipment",
    requirements: [requirement]
  })), true);
});
