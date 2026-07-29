import assert from "node:assert/strict";
import test from "node:test";

import {
  beginActorEffectPreparation,
  endActorEffectPreparation,
  getActorApplicableEffects,
  getActorEffectChangeEntries,
  getActorEffectPreparationStats,
  markActorEmbeddedEffectsPrepared
} from "../src/documents/actor-effect-preparation-index.mjs";

function createActor(effects) {
  let applicableEffectReads = 0;
  return {
    actor: {
      *allApplicableEffects() {
        applicableEffectReads += 1;
        yield* effects;
      }
    },
    get applicableEffectReads() {
      return applicableEffectReads;
    }
  };
}

test("effect documents are cached only after Foundry prepares embedded documents", () => {
  const effects = [
    {
      id: "actor-effect",
      system: {
        changes: [
          { key: "system.alpha", value: "1" },
          { key: "system.beta", value: "2" }
        ]
      }
    },
    {
      id: "item-effect",
      system: {
        changes: [
          { key: "system.alpha", value: "3" }
        ]
      }
    }
  ];
  const fixture = createActor(effects);
  const context = beginActorEffectPreparation(fixture.actor);

  assert.deepEqual(Array.from(getActorApplicableEffects(fixture.actor)), effects);
  assert.deepEqual(Array.from(getActorApplicableEffects(fixture.actor)), effects);
  assert.equal(fixture.applicableEffectReads, 2);

  markActorEmbeddedEffectsPrepared(fixture.actor);
  assert.deepEqual(Array.from(getActorApplicableEffects(fixture.actor)), effects);
  assert.deepEqual(Array.from(getActorApplicableEffects(fixture.actor)), effects);
  assert.equal(fixture.applicableEffectReads, 3);

  assert.deepEqual(
    getActorEffectChangeEntries(fixture.actor, "system.alpha")
      .map(entry => [entry.effect.id, entry.change.value]),
    [
      ["actor-effect", "1"],
      ["item-effect", "3"]
    ]
  );
  assert.deepEqual(
    getActorEffectChangeEntries(fixture.actor, ["system.beta", "system.alpha"])
      .map(entry => entry.change.value),
    ["1", "2", "3"]
  );
  assert.equal(fixture.applicableEffectReads, 3);
  assert.deepEqual(getActorEffectPreparationStats(fixture.actor), {
    active: true,
    embeddedEffectsPrepared: true,
    effectCount: 2,
    changeCount: 3
  });

  endActorEffectPreparation(fixture.actor, context);
  assert.deepEqual(Array.from(getActorApplicableEffects(fixture.actor)), effects);
  assert.equal(fixture.applicableEffectReads, 4);
});

test("nested preparation restores the outer scope and invalidates its document snapshot", () => {
  const fixture = createActor([{ id: "effect", system: { changes: [] } }]);
  const outer = beginActorEffectPreparation(fixture.actor);
  markActorEmbeddedEffectsPrepared(fixture.actor);
  Array.from(getActorApplicableEffects(fixture.actor));
  assert.equal(fixture.applicableEffectReads, 1);

  const inner = beginActorEffectPreparation(fixture.actor);
  markActorEmbeddedEffectsPrepared(fixture.actor);
  Array.from(getActorApplicableEffects(fixture.actor));
  assert.equal(fixture.applicableEffectReads, 2);
  endActorEffectPreparation(fixture.actor, inner);

  Array.from(getActorApplicableEffects(fixture.actor));
  assert.equal(fixture.applicableEffectReads, 3);
  endActorEffectPreparation(fixture.actor, outer);
});
