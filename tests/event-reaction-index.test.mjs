import assert from "node:assert/strict";
import test from "node:test";

import {
  activeEffectInvalidatesEventReactionIndex,
  actorUpdateInvalidatesEventReactionIndex,
  collectIndexedEventReactionReactorActors,
  createEventReactionSubscriptionIndex,
  eventParticipantHasReactionKey,
  itemUpdateInvalidatesEventReactionIndex,
  registerEventReactionSubscriptionIndexHooks,
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

test("a local update rescans one inventory and preserves subscription counts and scene order", async () => {
  const key = "fallout-maw.damage.resolved";
  const actors = Array.from({ length: 155 }, (_, i) => ({
    uuid: `Actor.${i}`, items: { contents: [makeAbility([key, key])] }
  }));
  const reads = [];
  const index = createEventReactionSubscriptionIndex({
    getReactors: () => actors,
    getItems: actor => { reads.push(actor); return actor.items.contents; },
    canReuseActorItems: () => true,
    setTimer: () => 1, clearTimer() {}
  });
  await index.ensureFresh();
  assert.equal(index.snapshot().totalSubscriptions, 310);
  reads.length = 0;
  actors[73].items.contents = [makeAbility(["fallout-maw.actor.effect.applied"])];
  index.markDirty(actors[73]);
  assert.equal(index.hasActorEventKey(actors[0], key), null, "dirty reads remain conservative");
  await index.ensureFresh();
  assert.deepEqual(reads, [actors[73]]);
  assert.equal(index.snapshot().totalSubscriptions, 309);
  assert.deepEqual(index.getActorsForEventKey(key), actors.filter((_, i) => i !== 73));
  assert.deepEqual(index.getActorsForEventKey("fallout-maw.actor.effect.applied"), [actors[73]]);
  assert.equal(index.hasActorEventKey(actors[73], key), false);

  reads.length = 0;
  index.markDirty();
  await index.ensureFresh();
  assert.deepEqual(reads, actors, "unspecified invalidation always refreshes every Actor");
});

test("partial rebuild removes departed actors and scans replacement Documents with the same UUID", async () => {
  const key = "fallout-maw.damage.resolved";
  const original = { uuid: "Actor.same", items: [makeAbility([key])] };
  const removed = { uuid: "Actor.removed", items: [makeAbility([key])] };
  let actors = [original, removed];
  const index = createEventReactionSubscriptionIndex({
    getReactors: () => actors, setTimer: () => 1, clearTimer() {}
  });
  await index.ensureFresh();
  const replacement = { uuid: original.uuid, items: [] };
  actors = [replacement];
  index.markDirty(original);
  await index.ensureFresh();
  assert.equal(index.empty, true);
  assert.equal(index.hasActorEventKey(original, key), null);
  assert.equal(index.hasActorEventKey(removed, key), null);
  assert.equal(index.hasActorEventKey(replacement, key), false);
});

test("invalidation during a partial scan cannot publish stale records or lose the newly dirty Actor", async () => {
  const key = "fallout-maw.damage.resolved";
  const actors = [{ items: [] }, { items: [] }];
  let invalidate = false, index;
  const reads = [];
  index = createEventReactionSubscriptionIndex({
    getReactors: () => actors,
    getItems: actor => {
      reads.push(actor);
      if (invalidate && actor === actors[1]) {
        invalidate = false;
        actors[0].items = [makeAbility([key])];
        index.markDirty(actors[0]);
      }
      return actor.items;
    },
    canReuseActorItems: () => true, setTimer: () => 1, clearTimer() {}
  });
  await index.ensureFresh();
  const generation = index.snapshot().generation;
  invalidate = true;
  index.markDirty(actors[1]);
  await index.ensureFresh();
  assert.equal(index.isDirty, true);
  assert.equal(index.snapshot().generation, generation);
  reads.length = 0;
  await index.ensureFresh();
  assert.deepEqual(reads, actors);
  assert.equal(index.hasActorEventKey(actors[0], key), true);
});

test("an injected provider with unspecified dependencies still refreshes every Actor", async () => {
  const actors = [{ items: [] }, { items: [] }], reads = [];
  const index = createEventReactionSubscriptionIndex({
    getReactors: () => actors,
    getItems: actor => { reads.push(actor); return actor.items; },
    setTimer: () => 1, clearTimer() {}
  });
  await index.ensureFresh();
  reads.length = 0;
  index.markDirty(actors[0]);
  await index.ensureFresh();
  assert.deepEqual(reads, actors);
});

test("hooks localize synthetic ownership but retain full world, scene and settings invalidation", () => {
  const handlers = new Map(), invalidations = [];
  const cleanup = registerEventReactionSubscriptionIndexHooks({
    hooks: { on(name, callback) { handlers.set(name, callback); return name; }, off(name) { handlers.delete(name); } },
    getIndex: () => ({ markDirty: actor => invalidations.push(actor), reset() {} })
  });
  const synthetic = { documentName: "Actor", isToken: true, token: { actorLink: false } };
  const item = { documentName: "Item", parent: synthetic };
  const effect = { documentName: "ActiveEffect", parent: item, changes: [{ key: "system.limbs.arm.max" }] };
  try {
    handlers.get("createItem")(item);
    handlers.get("updateItem")(item, { "system.quantity": 2 });
    handlers.get("deleteItem")(item);
    handlers.get("updateActor")(synthetic, { "system.limbs.arm.missing": true });
    handlers.get("createActiveEffect")(effect);
    handlers.get("updateActiveEffect")(effect, { "system.changes": [] });
    handlers.get("deleteActiveEffect")(effect);
    assert.deepEqual(invalidations, Array(7).fill(synthetic));

    invalidations.length = 0;
    handlers.get("updateItem")({ parent: { documentName: "Actor", isToken: false } }, { "system.quantity": 2 });
    handlers.get("updateActor")(synthetic, { "flags.fallout-maw.travelGroup.units": [] });
    handlers.get("updateActor")(synthetic, { "flags.fallout-maw.actorContainer.passengers": [] });
    handlers.get("updateSetting")({ key: "fallout-maw.creatureOptions" });
    handlers.get("createToken")({});
    assert.deepEqual(invalidations, Array(5).fill(undefined));
  } finally { cleanup(); }
  assert.equal(handlers.size, 0);
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

test("non-subscribing scene participants reuse the completed inventory scan", async () => {
  let itemReads = 0;
  const actor = {
    uuid: "Actor.inventory",
    items: { contents: Array.from({ length: 1000 }, (_, id) => ({
      uuid: `Actor.inventory.Item.${id}`,
      type: "gear",
      system: { functions: {} }
    })) }
  };
  const getItems = candidate => {
    itemReads += 1;
    return candidate.items.contents;
  };
  const index = createEventReactionSubscriptionIndex({ getReactors: () => [actor], getItems });
  await index.ensureFresh();
  assert.equal(index.empty, true);
  assert.equal(index.hasActorEventKey(actor, "fallout-maw.movement.token.completed"), false);

  for (const eventKey of ["fallout-maw.movement.token.completed", "fallout-maw.damage.resolved"]) {
    for (let occurrence = 0; occurrence < 50; occurrence += 1) {
      assert.equal(await eventParticipantHasReactionKey({
        key: eventKey,
        source: { actorUuid: actor.uuid },
        target: { actorUuid: actor.uuid }
      }, { getIndex: () => index, resolveUuid: () => actor, getItems }), false);
    }
  }
  assert.equal(itemReads, 1, "movement and damage participants must not rescan a covered inventory");
});

test("participant lookup scans actors omitted from the scene provider and uses the configured item source", async () => {
  const sceneActor = { uuid: "Actor.scene", items: { contents: [] } };
  const offSceneActor = { uuid: "Actor.off-scene", items: { contents: [] } };
  const eventKey = "fallout-maw.damage.resolved";
  const moduleSource = makeAbility([eventKey]);
  const index = createEventReactionSubscriptionIndex({ getReactors: () => [sceneActor] });
  await index.ensureFresh();
  let sourceReads = 0;
  const found = await eventParticipantHasReactionKey({
    key: eventKey,
    source: { actorUuid: sceneActor.uuid },
    target: { actorUuid: offSceneActor.uuid }
  }, {
    getIndex: () => index,
    resolveUuid: uuid => uuid === sceneActor.uuid ? sceneActor : offSceneActor,
    getItems: actor => {
      assert.equal(actor, offSceneActor);
      sourceReads += 1;
      return [moduleSource];
    }
  });
  assert.equal(found, true);
  assert.equal(sourceReads, 1);
  assert.equal(index.hasActorEventKey(offSceneActor, eventKey), null);
});

test("a replacement synthetic actor with the same UUID is not covered by the old scan", async () => {
  const original = { uuid: "Scene.test.Token.test.Actor.base", items: { contents: [] } };
  const eventKey = "fallout-maw.damage.resolved";
  const replacement = { uuid: original.uuid, items: { contents: [makeAbility([eventKey])] } };
  const index = createEventReactionSubscriptionIndex({ getReactors: () => [original] });
  await index.ensureFresh();
  assert.equal(index.hasActorEventKey(original, eventKey), false);
  assert.equal(index.hasActorEventKey(replacement, eventKey), null);
  assert.equal(await eventParticipantHasReactionKey({
    key: eventKey,
    source: { actorUuid: replacement.uuid }
  }, { getIndex: () => index, resolveUuid: () => replacement }), true);
});

test("participant lookup falls back if the index is invalidated while resolving an actor", async () => {
  const actor = { uuid: "Actor.changing", items: { contents: [] } };
  const eventKey = "fallout-maw.damage.resolved";
  const index = createEventReactionSubscriptionIndex({
    getReactors: () => [actor], setTimer: () => 1, clearTimer: () => undefined
  });
  await index.ensureFresh();
  assert.equal(await eventParticipantHasReactionKey({
    key: eventKey,
    source: { actorUuid: actor.uuid }
  }, {
    getIndex: () => index,
    resolveUuid: () => {
      actor.items.contents = [makeAbility([eventKey])];
      index.markDirty();
      return actor;
    }
  }), true);
  assert.equal(index.hasActorEventKey(actor, eventKey), null);
  await index.ensureFresh();
  assert.equal(index.hasActorEventKey(actor, eventKey), true);
  index.reset();
  assert.equal(index.hasActorEventKey(actor, eventKey), null);
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
