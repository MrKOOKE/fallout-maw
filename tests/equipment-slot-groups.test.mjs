import assert from "node:assert/strict";
import test from "node:test";

import { groupRaceWeaponSlotsBySet } from "../src/utils/equipment-slots.mjs";

test("weapon requirement groups omit races without ordinary weapon slots", () => {
  const groups = groupRaceWeaponSlotsBySet({
    races: [{
      name: "Human",
      limbs: [{ key: "rightArm", label: "Right hand" }],
      weaponSets: [{ key: "hands", slots: [{ key: "rightHand", limbKey: "rightArm" }] }]
    }, {
      name: "Wolf",
      limbs: [{ key: "head", label: "Head" }],
      weaponSets: []
    }, {
      name: "Plant",
      limbs: [{ key: "crown", label: "Crown" }],
      weaponSets: [{ key: "empty", slots: [] }]
    }]
  });

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].races, ["Human"]);
  assert.deepEqual(groups[0].slots, [{ label: "Right hand", selectionKey: "limb:rightArm" }]);
});
