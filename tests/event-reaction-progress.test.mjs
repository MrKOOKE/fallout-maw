import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  }
};

const {
  EVENT_REACTION_PROGRESS_FLAG_KEY,
  EVENT_REACTION_PROGRESS_HISTORY_LIMIT,
  createEventReactionProgressManager,
  getEventReactionProgressKey
} = await import("../src/events/event-reaction-progress.mjs");
const {
  createGenericEventReactionProvider
} = await import("../src/events/event-reaction-provider.mjs");
const { SYSTEM_ID } = await import("../src/constants.mjs");

const TRACKED_EVENT_KEY = "fallout-maw.research.progressed";

test("capped and zero-value progress events stay in one bounded history-only flush", async () => {
  const { item, writes, updateItem } = createItemHarness({ current: 10 });
  const { abilityFunction, condition } = createProgressFunction({ required: 10 });
  const manager = createEventReactionProgressManager({ updateItem });

  for (let index = 0; index < 70; index += 1) {
    await manager.advance({
      item,
      abilityFunction,
      conditionIds: [condition.id],
      envelope: createEnvelope({
        rootId: "root-cap",
        eventId: `event-${index}`,
        increment: index % 2 ? 0 : 3
      })
    });
  }

  assert.equal(writes.length, 0, "history-only changes must not reset the parent Actor");
  assert.equal(await manager.flushRoot("root-cap"), 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.render, false);

  const progress = getStoredProgress(item, abilityFunction, condition);
  assert.equal(progress.current, 10);
  assert.equal(progress.recentEventIds.length, EVENT_REACTION_PROGRESS_HISTORY_LIMIT);
  assert.deepEqual(
    progress.recentEventIds,
    Array.from({ length: EVENT_REACTION_PROGRESS_HISTORY_LIMIT }, (_, index) => `event-${index + 6}`)
  );
  assert.equal(progress.lastEventId, "event-69");
});

test("numeric reset merges pending history and keeps duplicate protection", async () => {
  const { item, writes, updateItem } = createItemHarness();
  const { abilityFunction, condition } = createProgressFunction({ required: 10 });
  const manager = createEventReactionProgressManager({ updateItem });
  const firstEnvelope = createEnvelope({ rootId: "root-reset", eventId: "event-first", increment: 5 });

  await manager.advance({
    item,
    abilityFunction,
    conditionIds: [condition.id],
    envelope: firstEnvelope
  });
  assert.equal(writes.length, 1);
  assert.equal(getStoredProgress(item, abilityFunction, condition).current, 5);

  await manager.advance({
    item,
    abilityFunction,
    conditionIds: [condition.id],
    envelope: firstEnvelope
  });
  assert.equal(writes.length, 1, "the same event must not increment twice");

  await manager.advance({
    item,
    abilityFunction,
    conditionIds: [condition.id],
    envelope: createEnvelope({ rootId: "root-reset", eventId: "event-zero", increment: 0 })
  });
  assert.equal(writes.length, 1);

  assert.equal(await manager.reset({
    item,
    abilityFunction,
    conditionIds: [condition.id]
  }), 1);
  assert.equal(writes.length, 2);
  assert.equal(getStoredProgress(item, abilityFunction, condition).current, 0);
  assert.deepEqual(
    getStoredProgress(item, abilityFunction, condition).recentEventIds,
    ["event-first", "event-zero"]
  );

  await manager.advance({
    item,
    abilityFunction,
    conditionIds: [condition.id],
    envelope: createEnvelope({ rootId: "root-reset", eventId: "event-zero", increment: 5 })
  });
  assert.equal(writes.length, 2);
  assert.equal(getStoredProgress(item, abilityFunction, condition).current, 0);
});

test("a failed numeric write does not poison the event id for a retry", async () => {
  const { item, writes, updateItem } = createItemHarness({ failWrites: 1 });
  const { abilityFunction, condition } = createProgressFunction({ required: 10 });
  const manager = createEventReactionProgressManager({
    updateItem,
    logger: { warn: () => undefined }
  });
  const request = {
    item,
    abilityFunction,
    conditionIds: [condition.id],
    envelope: createEnvelope({ rootId: "root-numeric-retry", eventId: "event-retry", increment: 4 })
  };

  await assert.rejects(manager.advance(request), /planned write failure/);
  await manager.advance(request);

  assert.equal(writes.length, 2);
  assert.equal(getStoredProgress(item, abilityFunction, condition).current, 4);
  assert.deepEqual(
    getStoredProgress(item, abilityFunction, condition).recentEventIds,
    ["event-retry"]
  );
});

test("a failed root flush retains only unfinished history and successful retry is idempotent", async () => {
  const { item, writes, updateItem } = createItemHarness({ failWrites: 1 });
  const { abilityFunction, condition } = createProgressFunction({ required: 10 });
  const manager = createEventReactionProgressManager({
    updateItem,
    logger: { warn: () => undefined }
  });

  await manager.advance({
    item,
    abilityFunction,
    conditionIds: [condition.id],
    envelope: createEnvelope({ rootId: "root-flush-retry", eventId: "event-zero", increment: 0 })
  });
  await assert.rejects(manager.flushRoot("root-flush-retry"), AggregateError);
  assert.equal(await manager.flushRoot("root-flush-retry"), 1);
  assert.equal(await manager.flushRoot("root-flush-retry"), 0);

  assert.equal(writes.length, 2);
  assert.equal(writes.every(write => write.options.render === false), true);
  assert.deepEqual(
    getStoredProgress(item, abilityFunction, condition).recentEventIds,
    ["event-zero"]
  );
});

test("a partial root flush retries only the Item whose durable write failed", async () => {
  const left = createItemHarness({ uuid: "Actor.Test.Item.left" });
  const right = createItemHarness({ uuid: "Actor.Test.Item.right" });
  const writes = [];
  let failRight = true;
  const updateItem = async (item, state, options) => {
    writes.push(item.uuid);
    if (item === right.item && failRight) {
      failRight = false;
      throw new Error("right Item failed");
    }
    item.flags[SYSTEM_ID][EVENT_REACTION_PROGRESS_FLAG_KEY] = structuredClone(state);
    return item;
  };
  const { abilityFunction, condition } = createProgressFunction({ required: 10 });
  const manager = createEventReactionProgressManager({
    updateItem,
    logger: { warn: () => undefined }
  });
  for (const [item, eventId] of [
    [left.item, "event-left"],
    [right.item, "event-right"]
  ]) {
    await manager.advance({
      item,
      abilityFunction,
      conditionIds: [condition.id],
      envelope: createEnvelope({ rootId: "root-partial", eventId, increment: 0 })
    });
  }

  await assert.rejects(manager.flushRoot("root-partial"), AggregateError);
  assert.equal(await manager.flushRoot("root-partial"), 1);
  assert.deepEqual(writes, [
    "Actor.Test.Item.left",
    "Actor.Test.Item.right",
    "Actor.Test.Item.right"
  ]);
});

test("parallel roots serialize per Item without losing either history window", async () => {
  const { item, writes, updateItem } = createItemHarness({ delayWrites: true });
  const { abilityFunction, condition } = createProgressFunction({ required: 10 });
  const manager = createEventReactionProgressManager({ updateItem });

  await manager.advance({
    item,
    abilityFunction,
    conditionIds: [condition.id],
    envelope: createEnvelope({ rootId: "root-left", eventId: "event-left", increment: 0 })
  });
  await manager.advance({
    item,
    abilityFunction,
    conditionIds: [condition.id],
    envelope: createEnvelope({ rootId: "root-right", eventId: "event-right", increment: 0 })
  });

  assert.deepEqual(
    await Promise.all([
      manager.flushRoot("root-left"),
      manager.flushRoot("root-right")
    ]),
    [1, 1]
  );
  assert.equal(writes.length, 2);
  assert.deepEqual(
    getStoredProgress(item, abilityFunction, condition).recentEventIds,
    ["event-left", "event-right"]
  );
});

test("provider cleanup awaits progress persistence before effects and still attempts effects on failure", async () => {
  const order = [];
  const provider = createProviderForCleanup({
    flushRoot: async rootId => {
      order.push(`progress-start:${rootId}`);
      await Promise.resolve();
      order.push(`progress-end:${rootId}`);
    },
    cleanupEffects: async rootId => {
      order.push(`effects:${rootId}`);
      return 3;
    }
  });

  assert.equal(await provider.cleanupRoot("root-cleanup"), 3);
  assert.deepEqual(order, [
    "progress-start:root-cleanup",
    "progress-end:root-cleanup",
    "effects:root-cleanup"
  ]);

  let effectCleanupAttempted = false;
  const failingProvider = createProviderForCleanup({
    flushRoot: async () => {
      throw new Error("progress flush failed");
    },
    cleanupEffects: async () => {
      effectCleanupAttempted = true;
      return 0;
    }
  });
  await assert.rejects(failingProvider.cleanupRoot("root-failure"), /progress flush failed/);
  assert.equal(effectCleanupAttempted, true);
});

function createProgressFunction({ required = 10 } = {}) {
  const condition = {
    id: "condition-progress",
    groupId: "",
    type: "eventReaction",
    eventKey: TRACKED_EVENT_KEY,
    progressRequired: required
  };
  return {
    condition,
    abilityFunction: {
      id: "function-progress",
      type: "effectChanges",
      conditions: [condition]
    }
  };
}

function createEnvelope({ rootId, eventId, increment }) {
  return {
    key: TRACKED_EVENT_KEY,
    rootId,
    eventId,
    delta: { progress: increment }
  };
}

function createItemHarness({
  uuid = "Actor.Test.Item.ability",
  current = null,
  failWrites = 0,
  delayWrites = false
} = {}) {
  const { abilityFunction, condition } = createProgressFunction();
  const progressKey = getEventReactionProgressKey({ abilityFunction, condition });
  const state = current === null
    ? {}
    : {
      [progressKey]: {
        functionId: abilityFunction.id,
        conditionId: condition.id,
        eventKey: condition.eventKey,
        current,
        lastEventId: "",
        recentEventIds: []
      }
    };
  const item = {
    id: "ability",
    uuid,
    type: "ability",
    flags: {
      [SYSTEM_ID]: {
        [EVENT_REACTION_PROGRESS_FLAG_KEY]: structuredClone(state)
      }
    },
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    }
  };
  const writes = [];
  let remainingFailures = failWrites;
  const updateItem = async (subject, nextState, options) => {
    writes.push({
      state: structuredClone(nextState),
      options: { ...options }
    });
    if (delayWrites) await new Promise(resolve => setImmediate(resolve));
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error("planned write failure");
    }
    subject.flags[SYSTEM_ID][EVENT_REACTION_PROGRESS_FLAG_KEY] = structuredClone(nextState);
    return subject;
  };
  return { item, writes, updateItem };
}

function getStoredProgress(item, abilityFunction, condition) {
  const key = getEventReactionProgressKey({ abilityFunction, condition });
  return item.flags[SYSTEM_ID][EVENT_REACTION_PROGRESS_FLAG_KEY][key];
}

function createProviderForCleanup({ flushRoot, cleanupEffects }) {
  return createGenericEventReactionProvider({
    costRegistry: {
      quote: async () => ({ valid: true, affordable: true }),
      execute: async () => ({ ok: true }),
      withActorLock: async (_actor, operation) => operation()
    },
    effectManager: {
      apply: async () => null,
      cleanupRoot: cleanupEffects,
      cleanupOrphans: async () => 0
    },
    progressManager: {
      advance: async () => ({ ready: false, readyConditionIds: [], advancedConditionIds: [] }),
      isReady: async () => false,
      reset: async () => 0,
      flushRoot
    }
  });
}
