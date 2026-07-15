import test from "node:test";
import assert from "node:assert/strict";

import {
  formatLimitedChangeDisplayValue,
  getSelectableAbilityChanges,
  resolveLimitedChangeLimit,
  resolveLimitedChangeSet
} from "../src/abilities/limited-changes.mjs";

const CHANGES = [
  { id: "a", key: "system.skills.a.bonus", value: "10" },
  { id: "blank", key: "", value: "0" },
  { id: "b", key: "system.skills.b.bonus", value: "10" },
  { id: "c", key: "system.skills.c.bonus", value: "10" }
];

test("limited changes filter incomplete rows and evaluate a source formula", () => {
  assert.deepEqual(getSelectableAbilityChanges(CHANGES).map(entry => entry.id), ["a", "b", "c"]);
  const actor = { uuid: "Actor.source" };
  const seen = [];
  const limit = resolveLimitedChangeLimit([
    { type: "limitedChanges", limit: 1, limitFormula: "1+spe/50" }
  ], actor, {
    evaluateLimit: (formula, evaluatedActor) => {
      seen.push({ formula, actor: evaluatedActor });
      return 3;
    }
  });
  assert.equal(limit, 3);
  assert.deepEqual(seen, [{ formula: "1+spe/50", actor }]);
});

test("limited changes open one exact-count selection and preserve source order", async () => {
  const actor = { uuid: "Actor.source" };
  let chooseCalls = 0;
  const result = await resolveLimitedChangeSet({
    changes: CHANGES,
    conditions: [{ type: "limitedChanges", limitFormula: "1+spe/50" }],
    actor,
    evaluateLimit: (_formula, evaluatedActor) => {
      assert.equal(evaluatedActor, actor);
      return 2;
    },
    choose: async ({ changes, selectionIds, limit }) => {
      chooseCalls += 1;
      assert.equal(limit, 2);
      assert.deepEqual(changes.map(change => change.id), ["a", "b", "c"]);
      assert.deepEqual(selectionIds, ["a", "b", "c"]);
      return ["c", "a"];
    }
  });
  assert.equal(chooseCalls, 1);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.ids, ["a", "c"]);
});

test("limited changes cancel safely when the picker is closed or unavailable", async () => {
  const cancelled = await resolveLimitedChangeSet({
    changes: CHANGES,
    conditions: [{ type: "limitedChanges", limit: 1 }],
    choose: async () => null
  });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(cancelled.changes, []);

  const unavailable = await resolveLimitedChangeSet({
    changes: CHANGES,
    conditions: [{ type: "limitedChanges", limit: 1 }]
  });
  assert.equal(unavailable.cancelled, true);
});

test("legacy numeric limits still work and limits above the available set skip the picker", async () => {
  let chooseCalls = 0;
  const result = await resolveLimitedChangeSet({
    changes: CHANGES,
    conditions: [{ type: "limitedChanges", limit: 99 }],
    choose: async () => {
      chooseCalls += 1;
      return [];
    }
  });
  assert.equal(chooseCalls, 0);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.ids, ["a", "b", "c"]);
});

test("limited-change previews show evaluated bonuses and target-dependent ranges", () => {
  const formulaChange = { type: "add", value: "10+spe/10" };
  assert.equal(formatLimitedChangeDisplayValue(formulaChange, [30]), "+30");
  assert.equal(formatLimitedChangeDisplayValue(formulaChange, [20, 30, 20]), "+20…+30");
  assert.equal(formatLimitedChangeDisplayValue({ type: "multiply", value: "mult" }, [1.25]), "× 1.25");
  assert.equal(formatLimitedChangeDisplayValue({ type: "override", value: "score" }, [10, 12]), "= 10…12");
});

test("fallback selection ids survive filtering incomplete rows", async () => {
  const changes = [
    { key: "system.skills.a.bonus", value: "10" },
    { key: "", value: "0" },
    { key: "system.skills.b.bonus", value: "10" }
  ];
  const result = await resolveLimitedChangeSet({
    changes,
    conditions: [{ type: "limitedChanges", limit: 1 }],
    choose: async ({ selectionIds }) => {
      assert.deepEqual(selectionIds, ["change-0", "change-2"]);
      return ["change-2"];
    }
  });
  assert.equal(result.cancelled, false);
  assert.equal(result.changes[0], changes[2]);
});
