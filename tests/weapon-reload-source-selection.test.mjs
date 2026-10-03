import assert from "node:assert/strict";
import test from "node:test";
import { canSelectWeaponMagazineSource } from "../src/utils/weapon-reload-source-selection.mjs";

test("loaded rounds retain their source until extraction empties the magazine", () => {
  const weaponData = { magazine: { value: 5, sourceItemUuid: "Item.base-ammo" } };
  const before = structuredClone(weaponData);
  assert.equal(canSelectWeaponMagazineSource(weaponData, "Item.other-ammo"), false);
  assert.equal(canSelectWeaponMagazineSource(weaponData, "Item.base-ammo"), true);
  assert.deepEqual(weaponData, before);

  // The native extraction operation refunds the old rounds and leaves an empty magazine.
  weaponData.magazine.value = 0;
  assert.equal(canSelectWeaponMagazineSource(weaponData, "Item.other-ammo"), true);
  weaponData.magazine.sourceItemUuid = "Item.other-ammo";
  weaponData.magazine.value = 2;
  assert.equal(canSelectWeaponMagazineSource(weaponData, "Item.base-ammo"), false);
});

test("loaded rounds with an unknown origin cannot be relabeled as a newly selected source", () => {
  const weaponData = { magazine: { value: 5, sourceItemUuid: "" } };
  assert.equal(canSelectWeaponMagazineSource(weaponData, "Item.other-ammo"), false);
  delete weaponData.magazine.sourceItemUuid;
  assert.equal(canSelectWeaponMagazineSource(weaponData, "Item.other-ammo"), false);
  weaponData.magazine.value = 0;
  assert.equal(canSelectWeaponMagazineSource(weaponData, "Item.other-ammo"), true);
});

test("an absent source never becomes a valid selection, including an empty magazine", () => {
  assert.equal(canSelectWeaponMagazineSource({ magazine: { value: 0 } }, ""), false);
  assert.equal(canSelectWeaponMagazineSource({ magazine: { value: 5, sourceItemUuid: "" } }, " "), false);
  assert.equal(canSelectWeaponMagazineSource({ magazine: { value: 5, sourceItemUuid: "Item.base-ammo" } }, "Item.base-ammo"), true);
});
