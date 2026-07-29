import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getActorGearItems,
  getConstructPartSlots,
  getConstructPartSlotId,
  getInstalledConstructPartsBySlot,
  isInstalledConstructPartItem
} from "../src/utils/construct-parts.mjs";

function createConstructPart(id, slotId, { installed = true } = {}) {
  return {
    id,
    type: "gear",
    system: {
      placement: {
        mode: installed ? "constructPart" : "",
        limbKey: slotId
      },
      functions: {
        constructPart: {
          enabled: true,
          partType: "arm"
        }
      }
    }
  };
}

function buildReferenceIndex(items) {
  const slotIds = Array.from(new Set(
    items
      .filter(isInstalledConstructPartItem)
      .map(getConstructPartSlotId)
      .filter(Boolean)
  ));
  return new Map(slotIds.map(slotId => [
    slotId,
    items.find(item => (
      isInstalledConstructPartItem(item)
      && getConstructPartSlotId(item) === slotId
    ))
  ]));
}

test("construct-part slot index preserves repeated find semantics including first duplicate wins", () => {
  const firstArm = createConstructPart("first-arm", "arm");
  const duplicateArm = createConstructPart("duplicate-arm", "constructPart:arm");
  const legacyLeg = createConstructPart("legacy-leg", "constructPart.leg");
  const stored = createConstructPart("stored", "storage", { installed: false });
  const unrelated = { id: "weapon", type: "weapon", system: {} };
  const items = [unrelated, firstArm, duplicateArm, stored, legacyLeg];
  const actor = {
    itemTypes: { gear: [firstArm, duplicateArm, stored, legacyLeg] },
    items
  };

  const expected = buildReferenceIndex(items);
  const actual = getInstalledConstructPartsBySlot(actor);

  assert.deepEqual(Array.from(actual.keys()), Array.from(expected.keys()));
  for (const [slotId, item] of expected) {
    assert.equal(actual.get(slotId), item);
  }
  assert.equal(actual.get("arm"), firstArm);
  assert.equal(actual.get("leg"), legacyLeg);
  assert.equal(actual.has("storage"), false);
});

test("construct preparation shares one official gear pass across slot building and lookup", () => {
  const gear = [
    createConstructPart("arm", "arm"),
    createConstructPart("leg", "leg")
  ];
  let gearPasses = 0;
  let fallbackPasses = 0;
  Object.defineProperty(gear, Symbol.iterator, {
    configurable: true,
    value: function* iterateGear() {
      gearPasses += 1;
      yield this[0];
      yield this[1];
    }
  });
  const actor = {
    type: "construct",
    itemTypes: { gear },
    items: {
      *[Symbol.iterator]() {
        fallbackPasses += 1;
        throw new Error("Actor items fallback must not be traversed");
      }
    }
  };

  const index = getInstalledConstructPartsBySlot(actor);
  const slots = getConstructPartSlots(actor, { installedPartsBySlot: index });
  for (const slot of slots) assert.ok(index.get(slot.id));

  assert.equal(index.size, 2);
  assert.equal(slots.length, 2);
  assert.equal(gearPasses, 1);
  assert.equal(fallbackPasses, 0);
});

test("gear selection keeps fallback parity while preferring Foundry itemTypes", () => {
  const gear = createConstructPart("gear", "arm");
  const weapon = { id: "weapon", type: "weapon", system: {} };

  assert.deepEqual(
    getActorGearItems({ items: [weapon, gear] }),
    [gear]
  );

  let fallbackPasses = 0;
  const actor = {
    itemTypes: { gear: [gear] },
    items: {
      *[Symbol.iterator]() {
        fallbackPasses += 1;
        yield weapon;
      }
    }
  };
  assert.equal(getActorGearItems(actor), actor.itemTypes.gear);
  assert.equal(fallbackPasses, 0);
});

test("Actor mitigation and construct limb preparation consume the shared typed indexes", async () => {
  const source = await readFile(
    new URL("../src/data/models/actor-data-models.mjs", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /buildEquippedItemDamageMitigation\(\s*getActorGearItems\(this\.parent\)/
  );
  assert.match(
    source,
    /const installedPartsBySlot = getInstalledConstructPartsBySlot\(actor\);[\s\S]*?installedPartsBySlot\.get\(slot\.id\)/
  );
  assert.doesNotMatch(
    source,
    /function getConstructPartLimbData\(actor\)[\s\S]*?getInstalledConstructPartForSlot\(actor,\s*slot\.id\)/
  );
});
