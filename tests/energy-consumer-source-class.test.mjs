import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceEnergyConsumerSourceClass,
  inspectEnergyConsumerSourceClasses
} from "../scripts/rebalance/energy-consumer-source-class.mjs";

function source(id, itemClass) {
  return {
    _id: id,
    name: `Source ${itemClass}`,
    system: {
      functions: {
        energySource: {
          enabled: true,
          class: itemClass
        }
      }
    }
  };
}

function weapon() {
  return {
    _id: "weapon",
    name: "Gauss A",
    system: {
      functions: {
        weapon: { enabled: true },
        energyConsumer: {
          enabled: true,
          sourceItemUuid: "Item.c",
          sourceItemUuids: ["Item.c", "Item.a"],
          activeSourceUuid: "Item.c",
          installedSource: {
            sourceItemUuid: "Item.c",
            name: "Source C",
            class: "C",
            img: "c.webp",
            itemData: {},
            reserve: { value: 50, max: 100 }
          }
        }
      }
    }
  };
}

test("energy consumer class audit distinguishes exact and lower-class sources", () => {
  const item = weapon();
  const itemById = new Map([
    ["c", source("c", "C")],
    ["a", source("a", "A")]
  ]);
  const audit = inspectEnergyConsumerSourceClasses(item, "A", itemById);

  assert.deepEqual(audit.compatible.map(entry => entry.uuid), ["Item.a"]);
  assert.deepEqual(audit.incompatible.map(entry => entry.uuid), ["Item.c"]);
});

test("energy consumer class enforcement keeps only exact-class sources", () => {
  const item = weapon();
  const itemById = new Map([
    ["c", source("c", "C")],
    ["a", source("a", "A")]
  ]);
  const result = enforceEnergyConsumerSourceClass(item, "A", itemById);
  const consumer = item.system.functions.energyConsumer;

  assert.equal(result.changed, true);
  assert.equal(result.blocked, false);
  assert.deepEqual(consumer.sourceItemUuids, ["Item.a"]);
  assert.equal(consumer.sourceItemUuid, "Item.a");
  assert.equal(consumer.activeSourceUuid, "");
  assert.equal(consumer.installedSource.sourceItemUuid, "");
});

test("energy consumer class enforcement refuses to create an unrestricted consumer", () => {
  const item = weapon();
  item.system.functions.energyConsumer.sourceItemUuids = ["Item.c"];
  const itemById = new Map([["c", source("c", "C")]]);
  const result = enforceEnergyConsumerSourceClass(item, "A", itemById);

  assert.equal(result.changed, false);
  assert.equal(result.blocked, true);
  assert.deepEqual(item.system.functions.energyConsumer.sourceItemUuids, ["Item.c"]);
});
