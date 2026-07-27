import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  STUN_EFFECT_KEY,
  getActorStunDegree,
  getResourceLimitState
} from "../src/combat/resource-limits.mjs";

function actor(stun = 0, maximum = 10) {
  return {
    effects: [],
    system: {
      combat: { stun },
      resources: {
        actionPoints: { value: maximum, min: 0, max: maximum },
        reactionPoints: { value: maximum, min: 0, max: maximum },
        movementPoints: { value: maximum, min: 0, max: maximum },
        power: { value: maximum, min: 0, max: maximum }
      }
    }
  };
}

test("stun is a clamped 0-100 effect value with its own key", async () => {
  assert.equal(STUN_EFFECT_KEY, "system.combat.stun");
  assert.equal(getActorStunDegree(actor(-10)), 0);
  assert.equal(getActorStunDegree(actor(37)), 37);
  assert.equal(getActorStunDegree(actor(999)), 100);

  const model = await readFile(new URL("../src/data/models/actor-data-models.mjs", import.meta.url), "utf8");
  const keys = await readFile(new URL("../src/utils/effect-key-tokens.mjs", import.meta.url), "utf8");
  assert.match(model, /stun: new NumberField\(\{[^}]*min: 0, max: 100[^}]*persisted: false/);
  assert.match(keys, /label: "Оглушение, %"/);
  assert.match(keys, /path: STUN_EFFECT_KEY/);
});

test("stun blocks the same resource pools without changing their stored values", () => {
  const target = actor(50, 10);
  const state = getResourceLimitState(target);
  assert.equal(state.stun, 50);
  assert.equal(state.resources.actionPoints.amount, 5);
  assert.equal(state.resources.reactionPoints.amount, 5);
  assert.equal(state.resources.movementPoints.amount, 5);
  assert.equal(state.resources.actionPoints.color, "#d94b4b");
  assert.equal(state.resources.reactionPoints.color, "#d94b4b");
  assert.equal(state.resources.movementPoints.color, "#d94b4b");
  assert.equal(state.resources.power, undefined);
  assert.equal(target.system.resources.actionPoints.value, 10);
  assert.equal(target.system.resources.reactionPoints.value, 10);
  assert.equal(target.system.resources.movementPoints.value, 10);
});

test("one point of stun blocks at least one point and stacks with cryogenic limits", () => {
  const target = actor(1, 10);
  target.effects.push({
    disabled: false,
    getFlag: () => ({
      kind: "resourceLimit",
      resources: { actionPoints: 2 },
      color: "#3f8cff"
    })
  });
  const state = getResourceLimitState(target);
  assert.equal(state.resources.actionPoints.amount, 3);
  assert.equal(state.resources.reactionPoints.amount, 1);
  assert.equal(state.resources.movementPoints.amount, 1);
});
