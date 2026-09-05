import assert from "node:assert/strict";
import test from "node:test";

import {
  getMovementResumeWaypoints,
  isMovementOperationCompleted,
  registerFoundryMovementSystemEventHooks
} from "../src/events/foundry-movement-events.mjs";
import { waitForSystemMovementSettlement } from "../src/canvas/movement-settlement.mjs";
import { getEventReactionSubscriptionIndex } from "../src/events/event-reaction-index.mjs";
import { ABILITY_CONDITION_TYPES, ABILITY_FUNCTION_TYPES } from "../src/settings/abilities.mjs";

test("system-event movement resume drops generated terrain points but preserves route loops", () => {
  const waypoints = getMovementResumeWaypoints({
    passed: {
      waypoints: [
        { x: 25, y: 0, intermediate: true },
        { x: 100, y: 0, checkpoint: true }
      ]
    },
    pending: {
      waypoints: [
        { x: 75, y: 0, intermediate: true },
        { x: 0, y: 0, checkpoint: true },
        { x: 100, y: 0, checkpoint: true }
      ]
    }
  });

  assert.deepEqual(waypoints.map(waypoint => waypoint.x), [100, 0, 100]);
});

test("system-event movement resume falls back to the destination", () => {
  assert.deepEqual(getMovementResumeWaypoints({
    destination: { x: 200, y: 300, elevation: 7.5 },
    passed: { waypoints: [{ x: 50, y: 50, intermediate: true }] },
    pending: { waypoints: [] }
  }), [{ x: 200, y: 300, elevation: 7.5 }]);
});

test("movement completion is emitted only for the final unconstrained chunk", () => {
  assert.equal(isMovementOperationCompleted({ pending: { waypoints: [] }, constrained: false }), true);
  assert.equal(isMovementOperationCompleted({ pending: { waypoints: [{ x: 1, y: 1 }] }, constrained: false }), false);
  assert.equal(isMovementOperationCompleted({ pending: { waypoints: [] }, constrained: true }), false);
});

test("system-event movement gate rejects stale async resumes without timing assumptions", async () => {
  const previous = {
    Hooks: globalThis.Hooks,
    game: globalThis.game,
    canvas: globalThis.canvas
  };
  const callbacks = new Map();
  globalThis.Hooks = {
    on: (name, callback) => {
      callbacks.set(name, callback);
      return callback;
    }
  };
  globalThis.game = {
    paused: false,
    combat: null,
    time: { worldTime: 1 },
    user: { id: "gm", isActiveGM: true },
    users: { activeGM: { id: "gm" } }
  };
  const reactor = {
    uuid: "Actor.reactor",
    items: {
      contents: [{
        type: "ability",
        uuid: "Actor.reactor.Item.movement-gate",
        system: {
          functions: [{
            id: "movement-gate",
            type: ABILITY_FUNCTION_TYPES.effectChanges,
            conditions: [{
              type: ABILITY_CONDITION_TYPES.eventReaction,
              eventKey: "fallout-maw.movement.token.beforeStart"
            }],
            changes: []
          }]
        }
      }]
    }
  };
  const reactorToken = {
    id: "reactor-token",
    uuid: "Scene.scene.Token.reactor-token",
    actor: reactor
  };
  globalThis.canvas = {
    scene: { id: "scene", uuid: "Scene.scene", tokens: { contents: [reactorToken] } },
    tokens: { placeables: [{ document: reactorToken, actor: reactor }] }
  };
  reactorToken.parent = globalThis.canvas.scene;

  try {
    const subscriptionIndex = getEventReactionSubscriptionIndex();
    await subscriptionIndex.ensureFresh();
    assert.equal(subscriptionIndex.hasAnyOf(["fallout-maw.movement.token.beforeStart"]), true);
    // Keep the subscription's Actor on the scene: removing it must invalidate
    // membership. This fixture registers only movement hooks, so no reaction
    // executor or reaction UI is installed while the async gate is exercised.
    registerFoundryMovementSystemEventHooks();
    const preMoveToken = callbacks.get("preMoveToken");
    assert.equal(typeof preMoveToken, "function");

    const moves = [];
    const token = {
      id: "mover",
      uuid: "Scene.scene.Token.mover",
      actor: { uuid: "Actor.mover" },
      parent: globalThis.canvas.scene,
      _source: position(0),
      async move(waypoints) {
        moves.push(waypoints.map(waypoint => waypoint.x));
        Object.assign(this._source, waypoints.at(-1));
        return true;
      }
    };

    assert.equal(preMoveToken(token, movement("old", 100), {}), false);
    assert.equal(preMoveToken(token, movement("new", 200), {}), false);
    assert.equal((await waitForSystemMovementSettlement(token)).settled, true);
    assert.deepEqual(moves, [[200]]);

    assert.equal(preMoveToken(token, movement("undo", 0, 200), { isUndo: true }), true);
    assert.equal(preMoveToken(token, { ...movement("continuation", 300, 200), chain: ["new"] }, {}), true);

    token._source = position(0);
    assert.equal(preMoveToken(token, movement("stale-origin", 400), {}), false);
    token._source.x = 50;
    assert.equal((await waitForSystemMovementSettlement(token)).settled, true);
    assert.deepEqual(moves, [[200]]);
  } finally {
    callbacks.get("canvasTearDown")?.();
    globalThis.Hooks = previous.Hooks;
    globalThis.game = previous.game;
    globalThis.canvas = previous.canvas;
  }
});

function movement(id, destinationX, originX = 0) {
  const destination = position(destinationX);
  return {
    id,
    chain: [],
    origin: position(originX),
    destination,
    passed: { waypoints: [{ ...destination, checkpoint: true }] },
    pending: { waypoints: [] },
    method: "api",
    split: false,
    autoRotate: false,
    showRuler: false
  };
}

function position(x) {
  return {
    x,
    y: 0,
    elevation: 0,
    width: 1,
    height: 1,
    depth: 0,
    shape: 0,
    level: ""
  };
}
