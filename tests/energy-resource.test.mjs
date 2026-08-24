import assert from "node:assert/strict";
import test from "node:test";

import {
  restoreActorEnergy,
  runActorEnergyMutation
} from "../src/combat/energy-resource.mjs";

test("energy restoration persists value and spent atomically", async () => {
  const actor = createActor({ value: 25, max: 100, spent: 75 });
  const options = { falloutMawTest: true };

  const result = await restoreActorEnergy(actor, 30, options);

  assert.deepEqual(result, {
    requested: 30,
    restored: 30,
    overflow: 0,
    before: 25,
    after: 55,
    max: 100
  });
  assert.equal(actor.updateCalls.length, 1);
  assert.deepEqual(actor.updateCalls[0], {
    updates: {
      "system.resources.power.value": 55,
      "system.resources.power.spent": 45
    },
    options
  });
  assert.equal(actor.system.resources.power.value, 55);
  assert.equal(actor.system.resources.power.spent, 45);
});

test("energy restoration reports overflow after filling the prepared maximum", async () => {
  const actor = createActor({ value: 90, max: 100, spent: 10 });

  const result = await restoreActorEnergy(actor, 35);

  assert.deepEqual(result, {
    requested: 35,
    restored: 10,
    overflow: 25,
    before: 90,
    after: 100,
    max: 100
  });
  assert.equal(actor.system.resources.power.value, 100);
  assert.equal(actor.system.resources.power.spent, 0);
});

test("a full energy resource returns overflow without a redundant Actor update", async () => {
  const actor = createActor({ value: 100, max: 100, spent: 0 });

  const result = await restoreActorEnergy(actor, 20);

  assert.deepEqual(result, {
    requested: 20,
    restored: 0,
    overflow: 20,
    before: 100,
    after: 100,
    max: 100
  });
  assert.equal(actor.updateCalls.length, 0);
});

test("concurrent restorations for one Actor are serialized against fresh resource state", async () => {
  const actor = createActor({ value: 0, max: 100, spent: 100 }, { updateDelay: true });

  const [first, second] = await Promise.all([
    restoreActorEnergy(actor, 40),
    restoreActorEnergy(actor, 70)
  ]);

  assert.deepEqual(first, {
    requested: 40,
    restored: 40,
    overflow: 0,
    before: 0,
    after: 40,
    max: 100
  });
  assert.deepEqual(second, {
    requested: 70,
    restored: 60,
    overflow: 10,
    before: 40,
    after: 100,
    max: 100
  });
  assert.equal(actor.system.resources.power.value, 100);
  assert.equal(actor.system.resources.power.spent, 0);
});

test("a failed energy mutation does not poison the Actor queue", async () => {
  const actor = createActor({ value: 10, max: 100, spent: 90 });
  const order = [];
  const failed = runActorEnergyMutation(actor, async () => {
    order.push("failed");
    throw new Error("expected failure");
  });
  const recovered = runActorEnergyMutation(actor, async () => {
    order.push("recovered");
    return 42;
  });

  await assert.rejects(failed, /expected failure/);
  assert.equal(await recovered, 42);
  assert.deepEqual(order, ["failed", "recovered"]);
});

test("an Energy mutation for one Actor never blocks another Actor", async () => {
  const firstActor = createActor({ value: 0, max: 100, spent: 100 });
  const secondActor = createActor({ value: 0, max: 100, spent: 100 });
  const order = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => {
    releaseFirst = resolve;
  });

  const first = runActorEnergyMutation(firstActor, async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
  });
  const second = runActorEnergyMutation(secondActor, () => {
    order.push("second");
    releaseFirst();
  });

  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "second", "first-end"]);
});

test("missing Energy preserves the full request as unapplied overflow", async () => {
  const actor = {
    uuid: "Actor.no-energy",
    system: { resources: {} },
    async update() {
      throw new Error("missing Energy must not be updated");
    }
  };

  assert.deepEqual(await restoreActorEnergy(actor, 15), {
    requested: 15,
    restored: 0,
    overflow: 15,
    before: 0,
    after: 0,
    max: 0
  });
});

function createActor(resource, { updateDelay = false } = {}) {
  const actor = {
    uuid: `Actor.${Math.random()}`,
    system: {
      resources: {
        power: { min: 0, ...resource }
      }
    },
    updateCalls: [],
    async update(updates, options = {}) {
      this.updateCalls.push({ updates: { ...updates }, options });
      if (updateDelay) await new Promise(resolve => setImmediate(resolve));
      for (const [path, value] of Object.entries(updates)) {
        const key = path.split(".").at(-1);
        this.system.resources.power[key] = value;
      }
      return this;
    }
  };
  return actor;
}
