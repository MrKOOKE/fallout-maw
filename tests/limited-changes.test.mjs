import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ABILITY_CHANGE_SELECTION_MODES,
  formatLimitedChangeDisplayValue,
  getSelectableAbilityChanges,
  isLimitedChangeSelectionCountValid,
  resolveLimitedChangeLimit,
  resolveLimitedChangeSelectionMode,
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

test("legacy and mixed selection modes remain exact", async () => {
  assert.equal(resolveLimitedChangeSelectionMode([
    { type: "limitedChanges", selectionMode: "upTo" },
    { type: "selectedChanges" }
  ]), ABILITY_CHANGE_SELECTION_MODES.exact);
  assert.equal(resolveLimitedChangeSelectionMode([
    { type: "limitedChanges", selectionMode: "upTo" },
    { type: "selectedChanges", selectionMode: "upTo" }
  ]), ABILITY_CHANGE_SELECTION_MODES.upTo);

  const result = await resolveLimitedChangeSet({
    changes: CHANGES,
    conditions: [{ type: "limitedChanges", limit: 2 }],
    choose: async () => ["a"]
  });
  assert.equal(result.selectionMode, ABILITY_CHANGE_SELECTION_MODES.exact);
  assert.equal(result.cancelled, true);
});

test("up-to selection accepts one through the evaluated maximum and preserves order", async () => {
  let seen;
  const result = await resolveLimitedChangeSet({
    changes: CHANGES,
    conditions: [{ type: "selectedChanges", limitFormula: "3", selectionMode: "upTo" }],
    choose: async options => {
      seen = options;
      return ["c", "a"];
    }
  });

  assert.equal(seen.minimum, 1);
  assert.equal(seen.limit, 3);
  assert.equal(seen.selectionMode, ABILITY_CHANGE_SELECTION_MODES.upTo);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.ids, ["a", "c"]);
  assert.equal(isLimitedChangeSelectionCountValid(1, 3, {
    selectionMode: ABILITY_CHANGE_SELECTION_MODES.upTo
  }), true);
  assert.equal(isLimitedChangeSelectionCountValid(3, 3, {
    selectionMode: ABILITY_CHANGE_SELECTION_MODES.upTo
  }), true);
});

test("up-to selection rejects zero and selections above the maximum", async () => {
  for (const selectedIds of [[], ["a", "b", "c"]]) {
    const result = await resolveLimitedChangeSet({
      changes: CHANGES,
      conditions: [{ type: "limitedChanges", limit: 2, selectionMode: "upTo" }],
      choose: async () => selectedIds
    });
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.changes, []);
  }
  assert.equal(isLimitedChangeSelectionCountValid(0, 2, {
    selectionMode: ABILITY_CHANGE_SELECTION_MODES.upTo
  }), false);
  assert.equal(isLimitedChangeSelectionCountValid(3, 2, {
    selectionMode: ABILITY_CHANGE_SELECTION_MODES.upTo
  }), false);
});

test("up-to mode still opens the picker when its maximum includes every change", async () => {
  let chooseCalls = 0;
  const result = await resolveLimitedChangeSet({
    changes: CHANGES,
    conditions: [{ type: "limitedChanges", limit: 99, selectionMode: "upTo" }],
    choose: async () => {
      chooseCalls += 1;
      return ["b"];
    }
  });
  assert.equal(chooseCalls, 1);
  assert.deepEqual(result.ids, ["b"]);
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

test("fixed active-application paths preserve the up-to contract through the picker and GM authority", async () => {
  const source = await readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8");
  const selectedStart = source.indexOf("async function useSelectedChangesApplication");
  const selectedEnd = source.indexOf("async function executeActiveApplicationUse", selectedStart);
  const activeEnd = source.indexOf("async function gateActiveApplicationTargets", selectedEnd);
  const authorityStart = source.indexOf("async function processActiveApplicationEffectOperation");
  const authorityEnd = source.indexOf("function isActiveApplicationTokenDocumentAllowed", authorityStart);
  assert.ok(selectedStart >= 0 && selectedEnd > selectedStart && activeEnd > selectedEnd);
  assert.ok(authorityStart >= 0 && authorityEnd > authorityStart);

  for (const flow of [
    source.slice(selectedStart, selectedEnd),
    source.slice(selectedEnd, activeEnd)
  ]) {
    assert.match(flow, /choose:\s*\(\{[\s\S]*?minimum,[\s\S]*?selectionMode,[\s\S]*?\}\)\s*=>\s*requestLimitedChangeSelection\(\{/);
    assert.match(flow, /requestLimitedChangeSelection\(\{[\s\S]*?minimum,[\s\S]*?selectionMode,/);
  }

  const authority = source.slice(authorityStart, authorityEnd);
  assert.match(authority, /resolveLimitedChangeSelectionMode\(abilityFunction\.conditions/);
  assert.match(authority, /isLimitedChangeSelectionCountValid\(selectedIds\.length, maximumCount/);
  assert.match(authority, /selectedChanges\.length !== selectedIds\.length/);
});

test("active applications refresh their existing limited copy without reserving or creating another", async () => {
  const source = await readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8");
  const capacityStart = source.indexOf("function activeApplicationTargetsHaveEffectCopyCapacity");
  const capacityEnd = source.indexOf("function getActiveApplicationEffectCopyOptions", capacityStart);
  const applyStart = source.indexOf("async function applyActiveApplicationEffectsDirect");
  const applyEnd = source.indexOf("async function restoreActiveApplicationEffectsSafely", applyStart);
  assert.ok(capacityStart >= 0 && capacityEnd > capacityStart);
  assert.ok(applyStart >= 0 && applyEnd > applyStart);

  const capacity = source.slice(capacityStart, capacityEnd);
  assert.match(capacity, /isLimitedEffectCopyRefresh\(abilityFunction\)/);
  assert.match(capacity, /findLimitedEffectCopyToRefresh\(target\?\.actor, abilityItem, abilityFunction\)/);

  const apply = source.slice(applyStart, applyEnd);
  assert.match(apply, /if \(plan\.existingEffect\) continue;[\s\S]*?reserveLimitedEffectCopySlot/);
  assert.match(apply, /await plan\.existingEffect\.update\(updateData, operationOptions\)/);
  assert.match(apply, /restoreActiveApplicationEffectsSafely\(refreshedEffects, chainRef\)/);
});
