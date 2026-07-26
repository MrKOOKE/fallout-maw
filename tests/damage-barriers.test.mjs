import test from "node:test";
import assert from "node:assert/strict";

import {
  DAMAGE_BARRIER_ALL_EFFECT_KEY,
  absorbDamageWithBarrier,
  buildDamageBarrierCommitPlan,
  commitDamageBarrierLedger,
  createDamageBarrierLedger,
  getDamageBarrierEffectKey,
  isDamageBarrierEffectKey,
  parseDamageBarrierEffectKey
} from "../src/combat/damage-barriers.mjs";
import {
  getDamageResolutionActiveUseKeys,
  isActiveUseEffectKey
} from "../src/abilities/active-use-keys.mjs";

test("barrier keys accept the universal key and exactly one damage-type segment", () => {
  assert.deepEqual(parseDamageBarrierEffectKey(DAMAGE_BARRIER_ALL_EFFECT_KEY), {
    key: DAMAGE_BARRIER_ALL_EFFECT_KEY,
    kind: "all",
    damageTypeKey: "all"
  });
  assert.equal(getDamageBarrierEffectKey("fire"), "system.damageBarriers.fire");
  assert.equal(isDamageBarrierEffectKey("system.damageBarriers.bleeding"), true);
  assert.equal(isDamageBarrierEffectKey("system.damageBarriers.fire.periodic"), false);
  assert.equal(isDamageBarrierEffectKey("system.damageResistances.fire"), false);
});

test("barrier keys participate in active-use accounting even when mitigation is bypassed", () => {
  const keys = getDamageResolutionActiveUseKeys({
    damageTypeKey: "fire",
    includeMitigation: false
  });
  assert.deepEqual(Array.from(keys), [
    DAMAGE_BARRIER_ALL_EFFECT_KEY,
    "system.damageBarriers.fire"
  ]);
  assert.equal(isActiveUseEffectKey(DAMAGE_BARRIER_ALL_EFFECT_KEY), true);
  assert.equal(getDamageResolutionActiveUseKeys({
    damageTypeKey: "fire",
    includeMitigation: false,
    includeBarriers: false
  }).size, 0);
});

test("type-specific barriers are spent before the universal barrier", () => {
  const specific = effect("specific", [
    change("system.damageBarriers.fire", 10),
    change("system.combat.accuracy", 2)
  ], { createdTime: 20 });
  const universal = effect("universal", [
    change(DAMAGE_BARRIER_ALL_EFFECT_KEY, 20)
  ], { createdTime: 10 });
  const actor = actorWithEffects([universal, specific]);
  const ledger = createDamageBarrierLedger(actor);

  const result = absorbDamageWithBarrier(ledger, {
    amount: 15,
    damageTypeKey: "fire"
  });

  assert.equal(result.absorbed, 15);
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.spent.map(entry => [entry.effectId, entry.amount]), [
    ["specific", 10],
    ["universal", 5]
  ]);
  assert.deepEqual(buildDamageBarrierCommitPlan(ledger), {
    updates: [
      {
        _id: "universal",
        "system.changes": [change(DAMAGE_BARRIER_ALL_EFFECT_KEY, "15")]
      },
      {
        _id: "specific",
        "system.changes": [change("system.combat.accuracy", 2)]
      }
    ],
    deleteIds: []
  });
});

test("one ledger prevents a multi-component packet from spending the same points twice", async () => {
  const actor = actorWithEffects([
    effect("shield", [change(DAMAGE_BARRIER_ALL_EFFECT_KEY, 10)])
  ]);
  const ledger = createDamageBarrierLedger(actor);

  const first = absorbDamageWithBarrier(ledger, { amount: 6, damageTypeKey: "fire" });
  const second = absorbDamageWithBarrier(ledger, { amount: 8, damageTypeKey: "poison" });
  assert.deepEqual([first.absorbed, first.remaining], [6, 0]);
  assert.deepEqual([second.absorbed, second.remaining], [4, 4]);

  await commitDamageBarrierLedger(actor, ledger);
  assert.equal(actor.calls.actorUpdates.length, 0);
  assert.equal(actor.calls.effectUpdates.length, 0);
  assert.deepEqual(actor.calls.effectDeletions, [["shield"]]);
});

test("a packet without barriers performs no document writes", async () => {
  const actor = actorWithEffects([
    effect("ordinary", [change("system.combat.accuracy", 3)])
  ]);
  const ledger = createDamageBarrierLedger(actor);
  const result = absorbDamageWithBarrier(ledger, { amount: 12, damageTypeKey: "fire" });

  assert.equal(result.absorbed, 0);
  assert.equal(result.remaining, 12);
  await commitDamageBarrierLedger(actor, ledger);
  assert.deepEqual(actor.calls, {
    actorUpdates: [],
    effectUpdates: [],
    effectDeletions: []
  });
});

test("transferred Item barriers are spent on their owning Item effect", async () => {
  const itemCalls = { updates: [], deletions: [] };
  const item = {
    id: "disease-item",
    uuid: "Actor.A.Item.disease-item",
    documentName: "Item",
    async updateEmbeddedDocuments(_documentName, updates) {
      itemCalls.updates.push(updates);
    },
    async deleteEmbeddedDocuments(_documentName, ids) {
      itemCalls.deletions.push(ids);
    }
  };
  const transferred = effect("disease-barrier", [
    change(DAMAGE_BARRIER_ALL_EFFECT_KEY, 8),
    change("system.characteristics.endurance", -1)
  ]);
  transferred.parent = item;
  transferred.transfer = true;
  const actor = actorWithEffects([transferred]);
  const ledger = createDamageBarrierLedger(actor);
  absorbDamageWithBarrier(ledger, { amount: 3, damageTypeKey: "poison" });

  await commitDamageBarrierLedger(actor, ledger);
  assert.equal(actor.calls.effectUpdates.length, 0);
  assert.equal(actor.calls.effectDeletions.length, 0);
  assert.deepEqual(itemCalls.updates, [[{
    _id: "disease-barrier",
    "system.changes": [
      change(DAMAGE_BARRIER_ALL_EFFECT_KEY, "5"),
      change("system.characteristics.endurance", -1)
    ]
  }]]);
  assert.deepEqual(itemCalls.deletions, []);
});

test("all changed rows are committed in one batch update", async () => {
  const actor = actorWithEffects([
    effect("first", [change(DAMAGE_BARRIER_ALL_EFFECT_KEY, 10)]),
    effect("second", [change(DAMAGE_BARRIER_ALL_EFFECT_KEY, 10)])
  ]);
  const ledger = createDamageBarrierLedger(actor);
  absorbDamageWithBarrier(ledger, { amount: 15, damageTypeKey: "fire" });

  await commitDamageBarrierLedger(actor, ledger);
  assert.equal(actor.calls.actorUpdates.length, 0);
  assert.equal(actor.calls.effectUpdates.length, 1);
  assert.equal(actor.calls.effectUpdates[0].length, 1);
  assert.deepEqual(actor.calls.effectDeletions, [["first"]]);
  assert.deepEqual(actor.calls.effectUpdates[0], [{
    _id: "second",
    "system.changes": [change(DAMAGE_BARRIER_ALL_EFFECT_KEY, "5")]
  }]);
});

test("explicit bypass leaves every barrier untouched", async () => {
  const actor = actorWithEffects([
    effect("shield", [change(DAMAGE_BARRIER_ALL_EFFECT_KEY, 10)])
  ]);
  const ledger = createDamageBarrierLedger(actor);
  const result = absorbDamageWithBarrier(ledger, {
    amount: 8,
    damageTypeKey: "fire",
    bypassBarrier: true
  });

  assert.deepEqual([result.absorbed, result.remaining], [0, 8]);
  await commitDamageBarrierLedger(actor, ledger);
  assert.equal(actor.calls.effectUpdates.length, 0);
  assert.equal(actor.calls.effectDeletions.length, 0);
});

test("a fully depleted managed projection records one persistent tombstone", async () => {
  const managed = effect("managed", [change(DAMAGE_BARRIER_ALL_EFFECT_KEY, 5)]);
  managed.flags = {
    "fallout-maw": {
      abilityEffect: {
        abilityItemId: "ability-1",
        signature: "signature-1"
      }
    }
  };
  const actor = actorWithEffects([managed]);
  const ledger = createDamageBarrierLedger(actor);
  absorbDamageWithBarrier(ledger, { amount: 5, damageTypeKey: "fire" });

  await commitDamageBarrierLedger(actor, ledger);
  assert.equal(actor.calls.actorUpdates.length, 1);
  assert.deepEqual(
    actor.calls.actorUpdates[0]["flags.fallout-maw.damageBarrierDepletions"],
    {
      "ability:ability-1": {
        kind: "ability",
        sourceId: "ability-1",
        signature: "signature-1"
      }
    }
  );
  assert.deepEqual(actor.calls.effectDeletions, [["managed"]]);
});

function actorWithEffects(effects) {
  const calls = {
    actorUpdates: [],
    effectUpdates: [],
    effectDeletions: []
  };
  return {
    flags: {},
    effects,
    calls,
    allApplicableEffects() {
      return effects.values();
    },
    async update(data) {
      calls.actorUpdates.push(data);
    },
    async updateEmbeddedDocuments(_documentName, updates) {
      calls.effectUpdates.push(updates);
    },
    async deleteEmbeddedDocuments(_documentName, ids) {
      calls.effectDeletions.push(ids);
    }
  };
}

function effect(id, changes, { createdTime = 0, sort = 0 } = {}) {
  return {
    id,
    sort,
    active: true,
    disabled: false,
    system: { changes },
    _stats: { createdTime }
  };
}

function change(key, value, priority = 0) {
  return {
    key,
    type: "add",
    value,
    priority
  };
}
