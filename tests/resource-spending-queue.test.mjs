import assert from "node:assert/strict";
import test from "node:test";

import { createCombatResourceSpendingRuntime } from "../src/combat/resource-spending.mjs";

function createDeferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(onEmit) {
  const actor = {
    uuid: "Actor.Queue",
    token: { uuid: "Scene.Queue.Token.Actor" }
  };
  const combat = {
    uuid: "Combat.Queue",
    started: true,
    combatants: [{ actor }]
  };
  let generatedRootSequence = 0;

  const withRoot = async (meta, operation) => {
    const inheritedRootId = String(meta?.chainRef?.rootId ?? "").trim();
    const rootId = inheritedRootId || `generated-root-${++generatedRootSequence}`;
    const chainRef = meta?.chainRef ?? { rootId };
    return operation({
      rootId,
      chainRef,
      emit: (eventKey, payload, options) => onEmit({
        rootId,
        chainRef,
        eventKey,
        payload,
        options
      })
    });
  };

  const runtime = createCombatResourceSpendingRuntime({
    withRoot,
    getActorCombat: candidate => candidate === actor ? combat : null,
    randomId: () => "operation",
    getSceneUuid: () => "Scene.Queue"
  });

  return { actor, runtime };
}

test("nested spending for the same actor and root bypasses the actor queue", async () => {
  const emitted = [];
  let runtime;
  let actor;

  ({ actor, runtime } = createHarness(async event => {
    emitted.push({
      rootId: event.rootId,
      resources: event.payload.data.resources
    });
    if (event.payload.data.resources.actionPoints) {
      await runtime.notify(actor, { reactionPoints: 1 }, {
        chainRef: event.chainRef
      });
    }
    return [];
  }));

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("nested notify deadlocked")), 250);
  });

  try {
    await Promise.race([
      runtime.notify(actor, { actionPoints: 1 }),
      timeout
    ]);
  } finally {
    clearTimeout(timeoutId);
  }

  assert.deepEqual(emitted, [
    {
      rootId: "generated-root-1",
      resources: { actionPoints: 1 }
    },
    {
      rootId: "generated-root-1",
      resources: { reactionPoints: 1 }
    }
  ]);
});

test("different roots and unscoped external calls remain serialized per actor", async () => {
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const order = [];
  const { actor, runtime } = createHarness(async event => {
    order.push(`start:${event.rootId}`);
    if (event.rootId === "root-a") {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    order.push(`end:${event.rootId}`);
    return [];
  });

  const first = runtime.notify(actor, { actionPoints: 1 }, {
    chainRef: { rootId: "root-a" }
  });
  await firstStarted.promise;

  const second = runtime.notify(actor, { reactionPoints: 1 }, {
    chainRef: { rootId: "root-b" }
  });
  const third = runtime.notify(actor, { dodge: 1 });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["start:root-a"]);

  releaseFirst.resolve();
  await Promise.all([first, second, third]);
  await runtime.wait(actor);

  assert.deepEqual(order, [
    "start:root-a",
    "end:root-a",
    "start:root-b",
    "end:root-b",
    "start:generated-root-1",
    "end:generated-root-1"
  ]);
});
