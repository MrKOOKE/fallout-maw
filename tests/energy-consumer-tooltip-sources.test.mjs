import assert from "node:assert/strict";
import test from "node:test";

import { getEnergyConsumerTooltipSourceEntries } from "../src/utils/energy-consumer-tooltip-sources.mjs";

test("energy consumer tooltip sources preserve configured order and mark the installed source", () => {
  const items = new Map([
    ["Item.a1", { name: "Батарея A1", img: "a1.webp" }],
    ["Item.a3", { name: "Батарея A3", img: "a3.webp" }]
  ]);
  const entries = getEnergyConsumerTooltipSourceEntries({
    sourceItemUuids: ["Item.a1", "Item.a3"],
    sourceItemUuid: "Item.a1",
    installedSource: {
      sourceItemUuid: "Item.a3",
      name: "A3",
      img: "cached-a3.webp"
    }
  }, {
    resolveItem: uuid => items.get(uuid) ?? null
  });

  assert.deepEqual(entries.map(entry => entry.uuid), ["Item.a1", "Item.a3"]);
  assert.deepEqual(entries.map(entry => entry.active), [false, true]);
  assert.equal(entries[1].img, "a3.webp");
});

test("energy consumer tooltip sources include an installed source missing from configured sources", () => {
  const entries = getEnergyConsumerTooltipSourceEntries({
    sourceItemUuids: ["Item.a1", "Item.a1", ""],
    installedSource: {
      sourceItemUuid: "Item.a3",
      name: "A3",
      img: "cached-a3.webp"
    }
  });

  assert.deepEqual(entries.map(entry => entry.uuid), ["Item.a1", "Item.a3"]);
  assert.deepEqual(entries.map(entry => entry.active), [false, true]);
  assert.equal(entries[1].label, "A3");
  assert.equal(entries[1].img, "cached-a3.webp");
});

test("energy consumer tooltip sources support legacy active source data", () => {
  const entries = getEnergyConsumerTooltipSourceEntries({
    activeSourceUuid: "Item.legacy",
    installedSource: {}
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].uuid, "Item.legacy");
  assert.equal(entries[0].active, true);
});
