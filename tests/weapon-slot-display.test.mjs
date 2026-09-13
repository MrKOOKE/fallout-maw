import assert from "node:assert/strict";
import test from "node:test";
import { prepareWeaponDisplaySlots, prepareWeaponSetDisplay } from "../src/utils/weapon-slot-display.mjs";

const item = { id: "rifle", img: "rifle.webp", locked: true, brokenCondition: true };
const right = { key: "right", label: "Правая рука" };
const left = { key: "left", label: "Левая рука" };

test("a multi-slot weapon is displayed once, preserving both occupied drop targets and item state", () => {
  const slots = [
    { ...right, item, phantom: false, useDisabled: true },
    { ...left, item: { ...item, phantom: true }, phantom: true, useDisabled: true }
  ];
  const source = structuredClone(slots);
  const display = prepareWeaponDisplaySlots(slots);
  assert.equal(display.length, 1);
  assert.equal(display[0].key, "right");
  assert.equal(display[0].item, item);
  assert.equal(display[0].phantom, false);
  assert.equal(display[0].useDisabled, true);
  assert.equal(display[0].shared, true);
  assert.deepEqual(display[0].sharedSlots, [right, left]);
  assert.deepEqual(slots, source, "mechanical occupancy must remain unchanged");
});

test("a primary weapon in the second hand keeps its identity while labels remain in hand order", () => {
  const display = prepareWeaponDisplaySlots([
    { ...right, item, phantom: true },
    { ...left, item, phantom: false }
  ]);
  assert.equal(display[0].key, "left");
  assert.equal(display[0].phantom, false);
  assert.deepEqual(display[0].sharedSlots.map(slot => slot.key), ["right", "left"]);
});

test("removing or replacing a two-handed weapon restores independent hand slots", () => {
  assert.deepEqual(prepareWeaponDisplaySlots([right, left]), [right, left]);
  const pistols = [
    { ...right, item: { id: "pistol-a", img: "pistol.webp" } },
    { ...left, item: { id: "pistol-b", img: "pistol.webp" } }
  ];
  assert.deepEqual(prepareWeaponDisplaySlots(pistols), pistols);
  assert.equal(prepareWeaponDisplaySlots([{ ...right, item }, left]).length, 2);
});

test("custom sets combine all slots occupied by one item without hiding unrelated slots", () => {
  const empty = { key: "spare", label: "Запасной" };
  const display = prepareWeaponDisplaySlots([
    { ...right, item }, empty,
    { ...left, item, phantom: true },
    { key: "third", label: "Третья рука", item, phantom: true }
  ]);
  assert.equal(display.length, 2);
  assert.equal(display[1], empty);
  assert.deepEqual(display[0].sharedSlots.map(slot => slot.key), ["right", "left", "third"]);
});

test("incomplete phantom data or duplicate primary slots are not silently discarded", () => {
  const orphaned = [{ ...right, item, phantom: true }, { ...left, item, phantom: true }];
  const duplicate = [{ ...right, item }, { ...left, item }];
  assert.deepEqual(prepareWeaponDisplaySlots(orphaned), orphaned);
  assert.deepEqual(prepareWeaponDisplaySlots(duplicate), duplicate);
  assert.deepEqual(prepareWeaponDisplaySlots(), []);
});

test("shared views retain actor ownership, trade prices, permissions and HUD selection from the primary slot", () => {
  const primary = {
    ...left, phantom: false, actorUuid: "Actor.other", weaponSetKey: "set",
    selected: true, hudAspectStyle: "--fallout-maw-hud-image-aspect: 2.4;",
    item: { ...item, actorUuid: "Actor.other", draggableClass: "", tradePrice: "250" }
  };
  const slots = [{ ...right, phantom: true, item }, primary];
  const set = { key: "set", slots, active: true };
  const view = prepareWeaponSetDisplay(set);
  assert.equal(view.slots, slots);
  assert.equal(set.displaySlots, undefined);
  assert.equal(view.displaySlots.length, 1);
  for (const key of ["actorUuid", "weaponSetKey", "selected", "hudAspectStyle", "item"]) {
    assert.equal(view.displaySlots[0][key], primary[key]);
  }
});
