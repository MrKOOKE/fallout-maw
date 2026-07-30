import assert from "node:assert/strict";
import test from "node:test";

import { enforceStandardMagazineSource } from "../scripts/rebalance/weapon-default-ammo.mjs";

function source(id, name, itemClass) {
  return {
    _id: id,
    name,
    flags: {
      "fallout-maw": {
        craftRebalance: { class: itemClass }
      }
    }
  };
}

function weapon(id, itemClass, active, sources, { damageMode = "source" } = {}) {
  return {
    _id: id,
    flags: { "fallout-maw": { weaponClass: itemClass } },
    system: {
      functions: {
        weapon: {
          enabled: true,
          damageMode,
          magazine: {
            sourceItemUuid: active,
            sourceItemUuids: sources
          }
        },
        constructPart: { enabled: false }
      }
    }
  };
}

test("C 9 mm defaults to enhanced ammunition instead of lethal ammunition", () => {
  const item = weapon("pistol", "C", "Item.b5912100b99a7601", [
    "Item.e0c991b58285bab5",
    "Item.b5912100b99a7601"
  ]);
  const itemById = new Map([
    ["e0c991b58285bab5", source("e0c991b58285bab5", "9 mm enhanced", "C")],
    ["b5912100b99a7601", source("b5912100b99a7601", "9 mm lethal", "C")]
  ]);

  const result = enforceStandardMagazineSource(item, "C", itemById);
  assert.equal(result.blocked, false);
  assert.equal(result.changed, true);
  assert.equal(item.system.functions.weapon.magazine.sourceItemUuid, "Item.e0c991b58285bab5");
});

test("B shotgun defaults to flechette instead of explosive shells", () => {
  const item = weapon("shotgun", "B", "Item.628a73d1b5768f8d", [
    "Item.628a73d1b5768f8d",
    "Item.6cac3831b05413b8"
  ]);
  const itemById = new Map([
    ["628a73d1b5768f8d", source("628a73d1b5768f8d", "12 gauge explosive", "B")],
    ["6cac3831b05413b8", source("6cac3831b05413b8", "12 gauge flechette", "B")]
  ]);

  const result = enforceStandardMagazineSource(item, "B", itemById);
  assert.equal(result.blocked, false);
  assert.equal(item.system.functions.weapon.magazine.sourceItemUuid, "Item.6cac3831b05413b8");
});

test("source-mode weapon without own-class ammunition is blocked", () => {
  const item = weapon("broken", "B", "Item.c", ["Item.c"]);
  const itemById = new Map([["c", source("c", "C source", "C")]]);
  const result = enforceStandardMagazineSource(item, "B", itemById);

  assert.equal(result.blocked, true);
  assert.equal(result.blockedReason, "no-own-class-source");
  assert.equal(item.system.functions.weapon.magazine.sourceItemUuid, "Item.c");
});

test("manual-damage resource consumers are outside ammunition defaulting", () => {
  const item = weapon("manual", "B", "Item.d", ["Item.d"], { damageMode: "manual" });
  const result = enforceStandardMagazineSource(item, "B", new Map());

  assert.equal(result.applicable, false);
  assert.equal(result.changed, false);
});

test("alien blaster receives the existing A and S alien-cell ladder", () => {
  const item = weapon("oNfladLGHp7UcXlB", "S", "Item.old", ["Item.old"]);
  const itemById = new Map([
    ["JPqvZoxIrKjibqve", source("JPqvZoxIrKjibqve", "Alien cell A", "A")],
    ["cf28a28d37ccbf1d", source("cf28a28d37ccbf1d", "Alien cell S", "S")]
  ]);
  const result = enforceStandardMagazineSource(item, "S", itemById);

  assert.equal(result.blocked, false);
  assert.equal(result.compatibilityOverridden, true);
  assert.deepEqual(item.system.functions.weapon.magazine.sourceItemUuids, [
    "Item.JPqvZoxIrKjibqve",
    "Item.cf28a28d37ccbf1d"
  ]);
  assert.equal(item.system.functions.weapon.magazine.sourceItemUuid, "Item.cf28a28d37ccbf1d");
});
