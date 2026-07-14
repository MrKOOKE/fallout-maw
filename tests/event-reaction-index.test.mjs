import assert from "node:assert/strict";
import test from "node:test";

import { createEventReactionSubscriptionIndex } from "../src/events/event-reaction-index.mjs";
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
  const index = createEventReactionSubscriptionIndex({
    getReactors: () => [actor],
    coalesceMs: 0
  });

  assert.equal(index.hasEventKey("fallout-maw.movement.token.beforeStart"), null);
  const snap = await index.ensureFresh();
  assert.equal(snap.totalSubscriptions, 2);
  assert.equal(index.hasEventKey("fallout-maw.movement.token.beforeStart"), true);
  assert.equal(index.hasEventKey("fallout-maw.damage.resolved"), false);
  assert.equal(index.hasAnyOf(["fallout-maw.vision.target.lost", "fallout-maw.vision.target.gained"]), true);
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
