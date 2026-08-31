import assert from "node:assert/strict";
import test from "node:test";

test("coordinator commits only the selected collection and skips cancelled selections", async () => {
  let preMoveToken;
  let preUpdateToken;
  let moveToken;
  globalThis.Hooks = {
    on: (hook, callback) => {
      if (hook === "preMoveToken") preMoveToken = callback;
      if (hook === "preUpdateToken") preUpdateToken = callback;
      if (hook === "moveToken") moveToken = callback;
    }
  };
  globalThis.game = {
    paused: false,
    combat: null,
    time: { worldTime: 1 },
    user: { id: "gm", isActiveGM: true },
    users: { activeGM: { id: "gm" } }
  };

  const interruptions = await import("../src/canvas/movement-interruptions.mjs");
  const { waitForSystemMovementSettlement } = await import("../src/canvas/movement-settlement.mjs");
  const { registerSystemEventInterceptor } = await import("../src/events/dispatcher.mjs");
  interruptions.registerMovementInterruptionHooks();
  assert.equal(typeof preMoveToken, "function");
  assert.equal(typeof preUpdateToken, "function");
  assert.equal(typeof moveToken, "function");

  const pathToken = makeMovableToken("path");
  const origin = movementWaypoint({ x: 0, elevation: 7.5 });
  const turn = movementWaypoint({ x: 100, elevation: 7.5 });
  const loop = movementWaypoint({ x: 0, elevation: 7.5 });
  const finish = movementWaypoint({ x: 200, elevation: 7.5 });
  const loopMovement = {
    origin,
    destination: finish,
    passed: { waypoints: [turn, loop, finish] }
  };
  assert.deepEqual(
    interruptions.getMovementRouteSamples(pathToken, loopMovement).map(sample => sample.waypoint.x),
    [0, 100, 0, 200]
  );
  const mutableMovement = {
    origin,
    destination: turn,
    passed: { waypoints: [turn] }
  };
  assert.deepEqual(
    interruptions.getMovementRouteSamples(pathToken, mutableMovement).map(sample => sample.waypoint.x),
    [0, 100]
  );
  mutableMovement.destination = finish;
  mutableMovement.passed.waypoints = [finish];
  assert.deepEqual(
    interruptions.getMovementRouteSamples(pathToken, mutableMovement).map(sample => sample.waypoint.x),
    [0, 200]
  );
  const shallowFrozenDestination = movementWaypoint({ x: 100, elevation: 7.5 });
  const shallowFrozenMovement = Object.freeze({
    origin: movementWaypoint({ x: 0, elevation: 7.5 }),
    destination: shallowFrozenDestination,
    passed: { waypoints: [shallowFrozenDestination] }
  });
  assert.deepEqual(
    interruptions.getMovementRouteSamples(pathToken, shallowFrozenMovement).map(sample => sample.waypoint.x),
    [0, 100]
  );
  shallowFrozenDestination.x = 200;
  assert.deepEqual(
    interruptions.getMovementRouteSamples(pathToken, shallowFrozenMovement).map(sample => sample.waypoint.x),
    [0, 200]
  );
  assert.deepEqual(
    interruptions.getMovementPrefixWaypoints(pathToken, loopMovement, { waypoint: loop, routeOrder: 6 })
      .map(waypoint => waypoint.x),
    [100, 0]
  );
  assert.equal(
    interruptions.createSnappedWaypointAtTokenCenter(pathToken, { x: 50, y: 50, elevation: 7.5 }, origin).elevation,
    7.5
  );
  assert.ok(interruptions.getMovementSegmentSamples(pathToken, {
    waypoint: origin,
    point: { x: 50, y: 50, elevation: 0 }
  }, {
    waypoint: { ...origin, elevation: 5 },
    point: { x: 50, y: 50, elevation: 5 }
  }).length > 2);
  const snappingToken = makeMovableToken("snapping-path");
  snappingToken.getSnappedPosition = data => ({
    ...data,
    x: Math.round(Number(data.x) / 100) * 100,
    y: Math.round(Number(data.y) / 100) * 100
  });
  assert.deepEqual(interruptions.getMovementSegmentSamples(snappingToken, {
    waypoint: { ...movementWaypoint({ x: 0 }), action: undefined },
    point: { x: 50, y: 50, elevation: 0 }
  }, {
    waypoint: movementWaypoint({ x: 100 }),
    point: { x: 150, y: 50, elevation: 0 }
  }).map(sample => sample.waypoint.x), [0, 100]);
  const terrainIntermediate = { ...movementWaypoint({ x: 50 }), intermediate: true };
  assert.deepEqual(interruptions.getMovementPrefixWaypoints(pathToken, {
    origin,
    destination: turn,
    passed: { waypoints: [terrainIntermediate, turn] }
  }, { waypoint: turn, routeOrder: 0 }).map(waypoint => waypoint.x), [100]);
  assert.equal(interruptions.getMovementRouteSamples(pathToken, {
    origin,
    destination: turn,
    passed: {
      waypoints: [
        { ...turn, checkpoint: false },
        { ...turn, checkpoint: true }
      ]
    }
  }).length, 3);
  assert.deepEqual(interruptions.createMovementOptions({
    method: "walk",
    split: 2,
    autoRotate: true,
    showRuler: true
  }, {
    pan: false,
    animate: false,
    animation: { duration: 0 },
    render: false,
    renderSheet: false,
    noHook: false,
    diff: false
  }, { showRuler: true }), {
    method: "walk",
    autoRotate: true,
    showRuler: true,
    terrainOptions: undefined,
    constrainOptions: undefined,
    measureOptions: undefined,
    split: 2,
    pan: false,
    animate: false,
    animation: { duration: 0 },
    render: false,
    renderSheet: false,
    noHook: false,
    diff: false
  });
  assert.equal(interruptions.createMovementOptions({ split: true }, {}, { split: false }).split, false);

  const nativeHistoryBypassCalls = [];
  interruptions.registerMovementInterruptionProvider({
    id: "test-native-history-bypass",
    collect: ({ tokenDocument }) => {
      if (!tokenDocument.id.startsWith("native-history-")) return [];
      nativeHistoryBypassCalls.push(tokenDocument.id);
      return [{
        eventId: "must-not-run",
        type: "test",
        routeOrder: 0,
        waypoint: { x: 0, y: 0, elevation: 0 }
      }];
    },
    execute: () => nativeHistoryBypassCalls.push("execute")
  });
  assert.equal(preMoveToken(
    makeToken("native-history-paste"),
    { id: "native-history-paste-movement" },
    { isPaste: true }
  ), true);
  assert.equal(preMoveToken(
    makeToken("native-history-undo"),
    { id: "native-history-undo-movement" },
    { isUndo: true }
  ), true);
  assert.deepEqual(nativeHistoryBypassCalls, []);

  const relocationCalls = [];
  interruptions.registerMovementInterruptionProvider({
    id: "test-system-relocation-bypass",
    collect: ({ tokenDocument }) => {
      if (tokenDocument.id !== "system-relocation") return [];
      relocationCalls.push("collect");
      return [{
        eventId: "must-not-run",
        type: "test",
        routeOrder: 0,
        waypoint: { x: 100, y: 0, elevation: 0 }
      }];
    },
    synchronizeOnMove: true,
    synchronize: () => relocationCalls.push("synchronize"),
    execute: () => relocationCalls.push("execute")
  });
  const relocationToken = makeToken("system-relocation");
  const relocationMovement = { id: "system-relocation-movement" };
  const relocationOptions = { [interruptions.SYSTEM_RELOCATION_OPTION]: true };
  assert.equal(preMoveToken(relocationToken, relocationMovement, relocationOptions), true);
  moveToken(relocationToken, relocationMovement, relocationOptions);
  assert.deepEqual(relocationCalls, []);

  const selectedCalls = [];
  const selectedCollection = {
    events: [{
      eventId: "selected-event",
      type: "test",
      routeOrder: 2,
      priority: 1,
      moveToWaypoint: false,
      waypoint: { x: 10, y: 20, elevation: 0 }
    }],
    stateUpdates: new Map([["pair", 7]])
  };
  interruptions.registerMovementInterruptionProvider({
    id: "test-selected-commit",
    collect: ({ tokenDocument }) => tokenDocument.id === "selected" ? selectedCollection : [],
    commit: args => selectedCalls.push({ type: "commit", args }),
    execute: async args => {
      await args.commit();
      selectedCalls.push({ type: "execute", args });
    }
  });
  const laterCalls = [];
  interruptions.registerMovementInterruptionProvider({
    id: "test-later-candidate",
    collect: ({ tokenDocument }) => tokenDocument.id === "selected" ? {
      events: [{
        eventId: "later-event",
        type: "test",
        routeOrder: 5,
        moveToWaypoint: false,
        waypoint: { x: 50, y: 60, elevation: 0 }
      }]
    } : [],
    commit: () => laterCalls.push("commit"),
    execute: () => laterCalls.push("execute")
  });

  const selectedToken = makeToken("selected");
  const selectedMovement = { id: "movement-selected" };
  assert.equal(preMoveToken(selectedToken, selectedMovement, {}), false);
  assert.equal((await waitForSystemMovementSettlement(selectedToken)).settled, true);
  assert.deepEqual(selectedCalls.map(call => call.type), ["commit", "execute"]);
  assert.equal(selectedCalls[0].args.collection, selectedCollection);
  assert.equal(selectedCalls[0].args.selectedEvent.eventId, "selected-event");
  assert.deepEqual(laterCalls, []);

  const currentStates = [];
  interruptions.registerMovementInterruptionProvider({
    id: "test-current-guard",
    collect: ({ tokenDocument, movement }) => tokenDocument.id === "current-guard"
      && movement.id === "movement-current-guard" ? [{
        eventId: "current-guard-event",
        type: "test",
        routeOrder: 0,
        moveToWaypoint: false,
        waypoint: { x: 0, y: 0, elevation: 0 }
      }] : [],
    execute: ({ tokenDocument, isCurrent }) => {
      currentStates.push(isCurrent());
      assert.equal(preMoveToken(tokenDocument, { id: "newer-movement" }, {}), true);
      currentStates.push(isCurrent());
    }
  });
  const currentGuardToken = makeToken("current-guard");
  assert.equal(preMoveToken(currentGuardToken, { id: "movement-current-guard" }, {}), false);
  assert.equal((await waitForSystemMovementSettlement(currentGuardToken)).settled, true);
  assert.deepEqual(currentStates, [true, false]);

  const acceptedCalls = [];
  interruptions.registerMovementInterruptionProvider({
    id: "test-accepted-commit",
    collect: ({ tokenDocument }) => tokenDocument.id === "accepted" ? { events: [], value: 9 } : [],
    commit: args => acceptedCalls.push(args),
    execute: () => undefined
  });
  const acceptedToken = makeToken("accepted");
  const acceptedMovement = { id: "movement-accepted" };
  assert.equal(preMoveToken(acceptedToken, acceptedMovement, {}), true);
  assert.equal(acceptedCalls.length, 0);
  moveToken(acceptedToken, acceptedMovement);
  await Promise.resolve();
  assert.equal(acceptedCalls.length, 1);
  assert.equal(acceptedCalls[0].selectedEvent, null);

  interruptions.registerMovementInterruptionProvider({
    id: "test-atomic-commit",
    collect: ({ tokenDocument }) => tokenDocument.id.startsWith("atomic")
      ? { events: [], stateUpdates: new Map([["pair", 3]]) }
      : [],
    hasCommitWork: collection => Boolean(collection?.stateUpdates?.size),
    buildAtomicMovementUpdate: ({ tokenDocument }) => ({
      [`flags.test.atomic.${tokenDocument.id}`]: 3
    }),
    execute: () => undefined
  });
  const atomicTokenA = makeToken("atomic-a");
  const atomicTokenB = makeToken("atomic-b");
  const atomicMovementA = { id: "movement-atomic-a" };
  const atomicMovementB = { id: "movement-atomic-b" };
  const atomicOptions = {};
  assert.equal(preMoveToken(atomicTokenA, atomicMovementA, atomicOptions), true);
  assert.equal(preMoveToken(atomicTokenB, atomicMovementB, atomicOptions), true);
  atomicOptions._movement = {
    [atomicTokenA.id]: atomicMovementA,
    [atomicTokenB.id]: atomicMovementB
  };
  const atomicChangesA = {};
  const atomicChangesB = {};
  preUpdateToken(atomicTokenA, atomicChangesA, atomicOptions);
  preUpdateToken(atomicTokenB, atomicChangesB, atomicOptions);
  assert.equal(atomicChangesA.flags.test.atomic[atomicTokenA.id], 3);
  assert.equal(atomicChangesB.flags.test.atomic[atomicTokenB.id], 3);
  moveToken(atomicTokenA, atomicMovementA);
  moveToken(atomicTokenB, atomicMovementB);
  await Promise.resolve();

  const cancelledCalls = [];
  interruptions.registerMovementInterruptionProvider({
    id: "test-cancelled-commit",
    collect: ({ tokenDocument }) => tokenDocument.id === "cancelled" ? {
      events: [{
        eventId: "cancelled-event",
        type: "test",
        routeOrder: 1,
        moveToWaypoint: false,
        waypoint: { x: 30, y: 40, elevation: 0 }
      }]
    } : [],
    commit: () => cancelledCalls.push("commit"),
    execute: () => cancelledCalls.push("execute")
  });
  const unregisterCancellation = registerSystemEventInterceptor({
    id: "test-cancel-movement-interruption",
    eventKeys: "fallout-maw.movement.token.interruptionRequested",
    intercept: () => ({ cancel: { scope: "current", reason: "test" } })
  });

  try {
    const cancelledToken = makeToken("cancelled");
    assert.equal(preMoveToken(cancelledToken, { id: "movement-cancelled" }, {}), false);
    assert.equal((await waitForSystemMovementSettlement(cancelledToken)).settled, true);
    assert.deepEqual(cancelledCalls, []);
  } finally {
    unregisterCancellation();
  }

  const controlledAtomicCalls = [];
  interruptions.registerMovementInterruptionProvider({
    id: "test-controlled-atomic",
    collect: ({ tokenDocument, movement }) => {
      if (tokenDocument.id !== "controlled-atomic") return [];
      controlledAtomicCalls.push(`collect:${movement.id}`);
      return {
        events: movement.id === "movement-controlled-atomic" ? [{
          eventId: "controlled-atomic-event",
          type: "test",
          routeOrder: 1,
          waypoint: movement.destination
        }] : [],
        stateUpdates: new Map([["pair", movement.id]])
      };
    },
    hasCommitWork: collection => Boolean(collection?.stateUpdates?.size),
    buildAtomicMovementUpdate: ({ movement }) => ({
      "flags.test.controlledAtomic": movement.id
    }),
    commitOnInterruption: true,
    commit: () => controlledAtomicCalls.push("commit"),
    execute: () => controlledAtomicCalls.push("execute")
  });
  const controlledAtomicChanges = [];
  const controlledAtomicToken = makeMovableToken("controlled-atomic", {
    onMove: async ({ token, options }) => {
      const middle = movementWaypoint({ x: 50 });
      const destination = movementWaypoint({ x: 100 });
      const firstChunk = {
        id: "controlled-chunk-1",
        chain: [],
        origin: { ...token._source },
        destination: middle,
        passed: { waypoints: [middle] }
      };
      assert.equal(preMoveToken(token, firstChunk, options), true);
      options._movement = { [token.id]: firstChunk };
      const firstChanges = {};
      preUpdateToken(token, firstChanges, options);
      controlledAtomicChanges.push(firstChanges.flags.test.controlledAtomic);
      Object.assign(token._source, middle);

      const secondOptions = {};
      const secondChunk = {
        id: "controlled-chunk-2",
        chain: [firstChunk.id],
        origin: { ...token._source },
        destination,
        passed: { waypoints: [destination] }
      };
      assert.equal(preMoveToken(token, secondChunk, secondOptions), true);
      secondOptions._movement = { [token.id]: secondChunk };
      const secondChanges = {};
      preUpdateToken(token, secondChanges, secondOptions);
      controlledAtomicChanges.push(secondChanges.flags.test.controlledAtomic);
      Object.assign(token._source, destination);
      return true;
    }
  });
  const controlledDestination = movementWaypoint({ x: 100 });
  assert.equal(preMoveToken(controlledAtomicToken, {
    id: "movement-controlled-atomic",
    origin: { ...controlledAtomicToken._source },
    destination: controlledDestination,
    passed: { waypoints: [controlledDestination] }
  }, {}), false);
  assert.equal((await waitForSystemMovementSettlement(controlledAtomicToken)).settled, true);
  assert.deepEqual(controlledAtomicChanges, ["controlled-chunk-1", "controlled-chunk-2"]);
  assert.ok(controlledAtomicCalls.includes("collect:controlled-chunk-1"));
  assert.ok(controlledAtomicCalls.includes("collect:controlled-chunk-2"));
  assert.equal(controlledAtomicCalls.includes("commit"), false);
  assert.equal(controlledAtomicCalls.at(-1), "execute");

  const rejectedCalls = [];
  interruptions.registerMovementInterruptionProvider({
    id: "test-rejected-controlled-move",
    collect: ({ tokenDocument }) => tokenDocument.id === "rejected" ? [{
      eventId: "rejected-event",
      type: "test",
      routeOrder: 1,
      waypoint: { x: 100, y: 0, elevation: 0, width: 1, height: 1, depth: 0, shape: 0, level: "" }
    }] : [],
    commit: () => rejectedCalls.push("commit"),
    execute: () => rejectedCalls.push("execute")
  });
  const rejectedToken = {
    ...makeToken("rejected"),
    _source: { x: 0, y: 0, elevation: 0, width: 1, height: 1, depth: 0, shape: 0, level: "" },
    move: async () => false
  };
  const rejectedDestination = { x: 100, y: 0, elevation: 0, width: 1, height: 1, depth: 0, shape: 0, level: "" };
  assert.equal(preMoveToken(rejectedToken, {
    id: "movement-rejected",
    origin: rejectedToken._source,
    destination: rejectedDestination,
    passed: { waypoints: [rejectedDestination] }
  }, {}), false);
  assert.equal((await waitForSystemMovementSettlement(rejectedToken)).settled, true);
  assert.deepEqual(rejectedCalls, []);
});

function makeToken(id) {
  return {
    id,
    uuid: `Scene.scene.Token.${id}`,
    actor: { uuid: `Actor.${id}` },
    parent: { id: "scene", uuid: "Scene.scene" }
  };
}

function makeMovableToken(id, { onMove = null } = {}) {
  const token = makeToken(id);
  token._source = movementWaypoint();
  token.parent.grid = { size: 100, distance: 5 };
  token.getCenterPoint = data => ({
    x: Number(data?.x ?? token._source.x) + 50,
    y: Number(data?.y ?? token._source.y) + 50,
    elevation: Number(data?.elevation ?? token._source.elevation)
  });
  token.getSnappedPosition = data => ({ ...data, elevation: 10 });
  token.move = async (waypoints, options) => {
    if (onMove) return onMove({ token, waypoints, options });
    Object.assign(token._source, waypoints.at(-1));
    return true;
  };
  return token;
}

function movementWaypoint(overrides = {}) {
  return {
    x: 0,
    y: 0,
    elevation: 0,
    width: 1,
    height: 1,
    depth: 0,
    shape: 0,
    level: "",
    action: "walk",
    ...overrides
  };
}
