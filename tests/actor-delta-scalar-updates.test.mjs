import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

class NativeActorDelta {
  constructor() {
    this._source = { _id: "token", system: {}, items: [], effects: [] };
    this.events = [];
    this.syntheticActor = {
      id: "actor",
      updateSource: (_changes, options) => {
        this.events.push("validate-and-update-actor");
        options.beforeCommit?.(this);
        if (options.failValidation) throw new Error("invalid update");
      }
    };
    this.parent = {
      actorId: "actor",
      baseActor: { id: "actor" },
      delta: this,
      _source: { delta: this._source },
      isLinked: false
    };
  }

  get id() { return this._source._id; }

  updateSource(changes, options) {
    // Match the relevant Foundry 14 lifecycle: validation on the Actor happens
    // before the delta commit invokes ActorDeltaField's reconstruction callback.
    this.syntheticActor.updateSource(changes, options);
    if (!options.dryRun) this._updateCommit({}, options.cleanedDiff ?? changes, options, {});
    return changes;
  }

  _updateCommit(_copy, _diff, options) {
    this.events.push("commit-delta");
    this.updateSyntheticActor();
    if (options.failCommit) throw new Error("failed commit");
    this.events.push("initialize-delta");
  }

  updateSyntheticActor() {
    this.events.push("rebuild-actor-and-inventory");
  }
}

class NativeReplacement {
  constructor(value) { this.value = value; }
  static get(value) { return value.value; }
}

// The lifecycle double supplies already committed sources. The real Foundry
// utility contract merges plain records and replaces scalar values.
function mergeRecords(base, delta) {
  for (const [key, value] of Object.entries(delta)) {
    base[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeRecords(base[key] && typeof base[key] === "object" ? base[key] : {}, value)
      : value;
  }
  return base;
}
globalThis.foundry = {
  documents: { ActorDelta: NativeActorDelta },
  data: { operators: { ForcedReplacement: NativeReplacement } },
  utils: { deepClone: structuredClone, mergeObject: mergeRecords, equals: isDeepStrictEqual }
};
globalThis.game = { release: { generation: 14 } };
const { FalloutMaWActorDelta } = await import("../src/documents/actor-delta.mjs");
const scalar = { "system.resources.health.spent": 8 };
const rebuildCount = delta => delta.events.filter(event => event === "rebuild-actor-and-inventory").length;

test("ordinary health/AP patches preserve native validation, commit and initialization without rebuilding inventory", () => {
  for (const changes of [
    scalar,
    { system: { resources: { actionPoints: { spent: 4 } } } },
    { _id: "token", flags: { "fallout-maw": { resourcesCommitted: true } } },
    { name: "Changed name" },
    { "ownership.player": 3 }
  ]) {
    const delta = new FalloutMaWActorDelta();
    assert.equal(delta.updateSource(changes), changes);
    assert.deepEqual(delta.events, [
      "validate-and-update-actor", "commit-delta", "initialize-delta"
    ]);
  }
});

test("base Actor changes and other external rebuild requests are never suppressed", () => {
  const delta = new FalloutMaWActorDelta();
  delta.updateSource(scalar);
  delta.updateSyntheticActor();
  // A commit reached through a TokenDocument update has no preceding Actor
  // update on this delta and must also keep its reconstruction callback.
  delta._updateCommit({}, scalar, {}, {});
  assert.equal(rebuildCount(delta), 2);
});

test("rebuilds requested before Actor validation completes remain active", () => {
  const delta = new FalloutMaWActorDelta();
  delta.updateSource(scalar, { beforeCommit: current => current.updateSyntheticActor() });
  assert.equal(rebuildCount(delta), 1);
});

test("embedded changes, type changes, override resets and deletion/replacement operators use the native merge", () => {
  class ForcedReplacement { constructor(value) { this.value = value; } }
  for (const changes of [
    { items: [{ _id: "item", system: { quantity: 2 } }] },
    { "items.item.system.quantity": 2 },
    { effects: [] },
    { type: "construct" },
    { name: null },
    { img: null },
    { ownership: null },
    { _id: "different-token" },
    { "system.resources.-=health": null },
    { system: { resources: { "-=health": null } } },
    { system: { resources: new ForcedReplacement({}) } },
    { system: { resources: { "__$OPERATOR$__": "ForcedDeletion" } } },
    { system: { resource: undefined } },
    { system: { entries: [] } }
  ]) {
    const delta = new FalloutMaWActorDelta();
    delta.updateSource(changes);
    assert.equal(rebuildCount(delta), 1, JSON.stringify(changes));
  }
});

test("cleaning that introduces an embedded update disables scalar reuse", () => {
  const delta = new FalloutMaWActorDelta();
  delta.updateSource(scalar, { cleanedDiff: { items: [] } });
  assert.equal(rebuildCount(delta), 1);
});

test("replacement/restoration options preserve native behavior and dry runs never leave suppression active", () => {
  for (const options of [{ recursive: false }, { restoreDelta: true }]) {
    const delta = new FalloutMaWActorDelta();
    delta.updateSource(scalar, options);
    assert.equal(rebuildCount(delta), 1);
  }
  const delta = new FalloutMaWActorDelta();
  delta.updateSource(scalar, { dryRun: true });
  assert.deepEqual(delta.events, ["validate-and-update-actor"]);
  delta.updateSyntheticActor();
  assert.equal(rebuildCount(delta), 1);
});

test("null, detached and replaced delta models retain reconstruction", () => {
  for (const mutate of [
    delta => { delta.parent._source.delta = null; },
    delta => { delta.parent._source.delta = { ...delta._source }; },
    delta => { delta.parent.delta = {}; },
    delta => { delta.parent.actorId = "another-actor"; }
  ]) {
    const delta = new FalloutMaWActorDelta();
    mutate(delta);
    delta.updateSource(scalar);
    assert.equal(rebuildCount(delta), 1);
  }
});

test("changing Actor identity during the update disables the pending optimization", () => {
  for (const beforeCommit of [
    delta => { delta.syntheticActor = { id: "actor" }; },
    delta => { delta.parent.baseActor = { id: "actor" }; },
    delta => { delta.parent.delta = {}; },
    delta => { delta.parent._source.delta = null; }
  ]) {
    const delta = new FalloutMaWActorDelta();
    delta.updateSource(scalar, { beforeCommit });
    assert.equal(rebuildCount(delta), 1);
  }
});

test("validation and commit errors always clear scoped suppression", () => {
  for (const options of [{ failValidation: true }, { failCommit: true }]) {
    const delta = new FalloutMaWActorDelta();
    assert.throws(() => delta.updateSource(scalar, options));
    delta.updateSyntheticActor();
    assert.equal(rebuildCount(delta), 1);
  }
});

test("future Foundry generations retain their complete native update workflow", () => {
  game.release.generation = 15;
  try {
    const delta = new FalloutMaWActorDelta();
    delta.updateSource(scalar);
    assert.equal(rebuildCount(delta), 1);
  } finally {
    game.release.generation = 14;
  }
});

function replacementFixture(baseAccumulation, deltaAccumulation, actorAccumulation) {
  const delta = new FalloutMaWActorDelta();
  const system = accumulation => ({ limbs: { torso: { damageAccumulation: accumulation, value: 12 } } });
  delta.parent.baseActor._source = { system: system(baseAccumulation) };
  delta._source.system = system(deltaAccumulation);
  delta.syntheticActor._source = { system: system(actorAccumulation) };
  return delta;
}
const replacementPatch = value => ({ "system.limbs.torso.damageAccumulation": new NativeReplacement(value) });

test("native system replacement skips reconstruction only when committed base merge equals the updated Actor", () => {
  for (const [base, value] of [[{}, { radiation: 8 }], [{ radiation: 4 }, { radiation: 8 }]]) {
    const delta = replacementFixture(base, value, value);
    const before = structuredClone([delta._source, delta.syntheticActor._source, delta.parent.baseActor._source]);
    delta.updateSource(replacementPatch(value));
    assert.equal(rebuildCount(delta), 0);
    assert.deepEqual([delta._source, delta.syntheticActor._source, delta.parent.baseActor._source], before,
      "equivalence comparison must not mutate any source");
    delta.updateSyntheticActor();
    assert.equal(rebuildCount(delta), 1, "external rebuild remains native after replacement commit");
  }
});

test("replacement removing an inherited base key retains native merge semantics", () => {
  for (const value of [{ radiation: 8 }, {}]) {
    const delta = replacementFixture({ inheritedDamage: 3 }, value, value);
    delta.updateSource(replacementPatch(value));
    assert.equal(rebuildCount(delta), 1, "native merge must restore inheritedDamage from the base");
  }
});

test("replacement introduced by cleaning still requires the committed-system equivalence check", () => {
  const delta = replacementFixture({ inheritedDamage: 3 }, {}, {});
  delta.updateSource(scalar, { cleanedDiff: replacementPatch({}) });
  assert.equal(rebuildCount(delta), 1);
});

test("unsupported mixed replacement updates never bypass native reconstruction", () => {
  for (const changes of [
    { ...replacementPatch({}), effects: [] },
    { ...replacementPatch({}), type: "construct" },
    { "flags.example": new NativeReplacement({}) },
    replacementPatch([1, 2]),
    { system: new NativeReplacement({}) }
  ]) {
    const delta = replacementFixture({}, {}, {});
    delta.updateSource(changes);
    assert.equal(rebuildCount(delta), 1);
  }
});

test("missing replacement comparison APIs or sources falls back to native", () => {
  const delta = replacementFixture({}, {}, {});
  delete delta.parent.baseActor._source.system;
  delta.updateSource(replacementPatch({}));
  assert.equal(rebuildCount(delta), 1);
  const other = replacementFixture({}, {}, {});
  const utils = foundry.utils;
  try {
    foundry.utils = {};
    other.updateSource(replacementPatch({}));
    assert.equal(rebuildCount(other), 1);
  } finally { foundry.utils = utils; }
});
