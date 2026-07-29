import assert from "node:assert/strict";
import test from "node:test";

import {
  activeEffectInvalidatesEventReactionIndex,
  actorUpdateInvalidatesEventReactionIndex,
  collectIndexedEventReactionReactorActors,
  createEventReactionSubscriptionIndex,
  itemUpdateInvalidatesEventReactionIndex,
  tokenUpdateInvalidatesEventReactionIndex
} from "../src/events/event-reaction-index.mjs";
import { ABILITY_CONDITION_TYPES, ABILITY_FUNCTION_TYPES } from "../src/settings/abilities.mjs";

function makeAbility(eventKeys = []) {
  return {
    type: "ability",
    uuid: `Item.${eventKeys.join(".") || "none"}`,
    system: {
      functions: eventKeys.map((eventKey, index) => ({
        id: `fn${index}`,
        type: ABILITY_FUNCTION_TYPES.effectChanges,
        conditions: [{ type: ABILITY_CONDITION_TYPES.eventReaction, eventKey }],
        changes: []
      }))
    }
  };
}

test("subscription index stays empty until rebuilt and answers O(1) lookups", async () => {
  const actor = {
    uuid: "Actor.1",
    items: { contents: [makeAbility(["fallout-maw.movement.token.beforeStart", "fallout-maw.vision.target.gained"])] }
  };
  const nonSubscriber = {
    uuid: "Actor.2",
    items: { contents: [makeAbility([])] }
  };
  const index = createEventReactionSubscriptionIndex({
    getReactors: () => [actor, nonSubscriber],
    coalesceMs: 0
  });

  assert.equal(index.hasEventKey("fallout-maw.movement.token.beforeStart"), null);
  const snap = await index.ensureFresh();
  assert.equal(snap.totalSubscriptions, 2);
  assert.equal(index.hasEventKey("fallout-maw.movement.token.beforeStart"), true);
  assert.equal(index.hasEventKey("fallout-maw.damage.resolved"), false);
  assert.equal(index.hasAnyOf(["fallout-maw.vision.target.lost", "fallout-maw.vision.target.gained"]), true);
  assert.deepEqual(index.getActorsForEventKey("fallout-maw.movement.token.beforeStart"), [actor]);
  assert.deepEqual(index.getActorsForEventKey("fallout-maw.damage.resolved"), []);
});

test("subscription index rebuilds after markDirty", async () => {
  let abilities = [];
  const actor = {
    uuid: "Actor.1",
    get items() {
      return { contents: abilities };
    }
  };
  const index = createEventReactionSubscriptionIndex({
    getReactors: () => [actor],
    coalesceMs: 0
  });
  await index.ensureFresh();
  assert.equal(index.empty, true);

  abilities = [makeAbility(["fallout-maw.actor.effect.applied"])];
  index.markDirty();
  await index.ensureFresh();
  assert.equal(index.hasEventKey("fallout-maw.actor.effect.applied"), true);
});

test("warm actor-by-key lookups do not rescan non-subscribing scene actors", async () => {
  let reactorReads = 0;
  const subscribers = Array.from({ length: 100 }, (_, index) => ({
    uuid: `Actor.${index}`,
    items: {
      contents: index === 73
        ? [makeAbility(["fallout-maw.damage.resolved"])]
        : [makeAbility([])]
    }
  }));
  const index = createEventReactionSubscriptionIndex({
    getReactors: () => {
      reactorReads += 1;
      return subscribers;
    },
    coalesceMs: 0
  });

  await index.ensureFresh();
  for (let lookup = 0; lookup < 100; lookup += 1) {
    assert.deepEqual(
      index.getActorsForEventKey("fallout-maw.damage.resolved"),
      [subscribers[73]]
    );
  }
  assert.equal(reactorReads, 1);
});

test("a rebuild cannot publish a snapshot invalidated while it is being collected", async () => {
  let abilities = [makeAbility(["fallout-maw.damage.beforeApply"])];
  let invalidateDuringFirstRead = true;
  let index;
  const actor = {
    uuid: "Actor.race",
    get items() {
      if (invalidateDuringFirstRead) {
        invalidateDuringFirstRead = false;
        index.markDirty();
      }
      return { contents: abilities };
    }
  };
  index = createEventReactionSubscriptionIndex({
    getReactors: () => [actor],
    setTimer: () => 1,
    clearTimer: () => undefined
  });

  await index.ensureFresh();
  assert.equal(index.isDirty, true);
  assert.equal(index.hasEventKey("fallout-maw.damage.beforeApply"), null);

  abilities = [makeAbility(["fallout-maw.damage.resolved"])];
  await index.ensureFresh();
  assert.equal(index.isDirty, false);
  assert.equal(index.hasEventKey("fallout-maw.damage.beforeApply"), false);
  assert.equal(index.hasEventKey("fallout-maw.damage.resolved"), true);
});

test("a failed rebuild releases its promise so the next lookup can retry", async () => {
  let fail = true;
  const actor = {
    uuid: "Actor.retry",
    items: { contents: [makeAbility(["fallout-maw.damage.resolved"])] }
  };
  const index = createEventReactionSubscriptionIndex({
    getReactors: () => {
      if (fail) {
        fail = false;
        throw new Error("transient");
      }
      return [actor];
    },
    setTimer: () => 1,
    clearTimer: () => undefined
  });

  await assert.rejects(index.ensureFresh(), /transient/);
  assert.equal(index.isDirty, true);
  await index.ensureFresh();
  assert.equal(index.hasEventKey("fallout-maw.damage.resolved"), true);
});

test("runtime reaction progress does not invalidate the structural subscription index", () => {
  const progressChange = {
    _id: "ability-1",
    "flags.fallout-maw.eventReactionProgress.fn.current": 2
  };
  assert.equal(itemUpdateInvalidatesEventReactionIndex(progressChange, {
    falloutMawEventReactionProgress: true
  }), false);
  assert.equal(itemUpdateInvalidatesEventReactionIndex({
    ...progressChange,
    "system.functions": []
  }, {
    falloutMawEventReactionProgress: true
  }), true);
  assert.equal(itemUpdateInvalidatesEventReactionIndex(progressChange, {
    falloutMawEventReactionProgress: false
  }), true);
  assert.equal(itemUpdateInvalidatesEventReactionIndex({}, {}), true);
});

test("indexed reactors preserve participant priority and scene subscription order", async () => {
  const source = { uuid: "Actor.source" };
  const target = { uuid: "Actor.target" };
  const firstSceneSubscriber = { uuid: "Actor.scene-a" };
  const secondSceneSubscriber = { uuid: "Actor.scene-b" };
  const documents = new Map([
    [source.uuid, source],
    [target.uuid, target]
  ]);

  const actors = await collectIndexedEventReactionReactorActors({
    key: "fallout-maw.damage.resolved",
    source: { actorUuid: source.uuid },
    target: { actorUuid: target.uuid }
  }, {
    resolveUuid: uuid => documents.get(uuid) ?? null,
    getIndexedActors: async () => [firstSceneSubscriber, source, secondSceneSubscriber]
  });

  assert.deepEqual(actors, [source, target, firstSceneSubscriber, secondSceneSubscriber]);
});

test("structural invalidation ignores ordinary damage values but tracks HUD source membership", () => {
  assert.equal(actorUpdateInvalidatesEventReactionIndex({
    "system.resources.health.value": 10
  }), false);
  assert.equal(actorUpdateInvalidatesEventReactionIndex({
    "system.limbs.arm.missing": true
  }), true);
  assert.equal(actorUpdateInvalidatesEventReactionIndex({
    "system.limbs.arm.maxBonus": 2
  }), true);
  assert.equal(actorUpdateInvalidatesEventReactionIndex({
    "system.constructPartSlots.weapon.quantity": 2
  }), true);
  assert.equal(tokenUpdateInvalidatesEventReactionIndex({ x: 10 }), false);
  assert.equal(tokenUpdateInvalidatesEventReactionIndex({ actorId: "Actor.next" }), true);

  const suppressionEffect = {
    changes: [{ key: "fallout-maw.suppression.traumas.all", value: "1" }]
  };
  assert.equal(activeEffectInvalidatesEventReactionIndex(suppressionEffect, {
    disabled: true
  }), true);
  assert.equal(activeEffectInvalidatesEventReactionIndex(suppressionEffect, {
    "duration.startTime": 100
  }), true);
  assert.equal(activeEffectInvalidatesEventReactionIndex({
    changes: []
  }, {
    "system.changes": []
  }), true);
  assert.equal(activeEffectInvalidatesEventReactionIndex({
    changes: [{ key: "system.resources.health.max", value: "1" }]
  }), false);
});
