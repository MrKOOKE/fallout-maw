import assert from "node:assert/strict";
import test from "node:test";

import {
  getWeaponDamageSourceTooltipDirection,
  getWeaponTooltipDamageSourceEntries
} from "../src/utils/weapon-tooltip-damage-sources.mjs";

test("weapon tooltip damage sources preserve configured order and mark the loaded source active", () => {
  const items = new Map([
    ["Item.556", { name: "5.56-mm" }],
    ["Item.ap", { name: "5.56-mm AP" }]
  ]);

  const entries = getWeaponTooltipDamageSourceEntries({
    sourceItemUuids: ["Item.556", "Item.ap"],
    sourceItemUuid: "Item.ap"
  }, {
    resolveItem: uuid => items.get(uuid),
    getLabel: item => item.name
  });

  assert.deepEqual(entries.map(({ uuid, label, active }) => ({ uuid, label, active })), [
    { uuid: "Item.556", label: "5.56-mm", active: false },
    { uuid: "Item.ap", label: "5.56-mm AP", active: true }
  ]);
});

test("weapon tooltip damage sources deduplicate references and include legacy active-only data", () => {
  const entries = getWeaponTooltipDamageSourceEntries({
    sourceItemUuids: ["Item.556", "Item.556", ""],
    sourceItemUuid: "Item.active"
  }, {
    resolveItem: uuid => ({ name: uuid }),
    getLabel: item => item.name
  });

  assert.deepEqual(entries.map(({ uuid, active }) => ({ uuid, active })), [
    { uuid: "Item.556", active: false },
    { uuid: "Item.active", active: true }
  ]);
});

test("weapon tooltip damage sources retain a readable fallback for missing world items", () => {
  const entries = getWeaponTooltipDamageSourceEntries({
    sourceItemUuids: ["Item.missing"],
    sourceItemUuid: ""
  });

  assert.equal(entries[0].label, "Item.missing");
  assert.equal(entries[0].item, null);
  assert.equal(entries[0].active, false);
});

test("weapon damage source tooltip opens right only when the full tooltip fits before the Foundry UI boundary", () => {
  assert.equal(getWeaponDamageSourceTooltipDirection({
    anchorRight: 300,
    margin: 5,
    rightBoundary: 1000,
    tooltipWidth: 660
  }), "RIGHT");

  assert.equal(getWeaponDamageSourceTooltipDirection({
    anchorRight: 400,
    margin: 5,
    rightBoundary: 1000,
    tooltipWidth: 660
  }), "LEFT");

  assert.equal(getWeaponDamageSourceTooltipDirection({
    anchorRight: 300,
    margin: 5,
    rightBoundary: 900,
    tooltipWidth: 660
  }), "LEFT");
});
