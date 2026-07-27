import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { groupSkillCheckOutcomesByActor } from "../src/rolls/skill-check-presentation.mjs";

function outcome(actor, result = "success") {
  return { actor, result: { key: result } };
}

test("checks by the same actor remain one presentation group", () => {
  const actor = { id: "same", uuid: "Actor.same" };
  const first = outcome(actor, "failure");
  const second = outcome(actor, "success");

  assert.deepEqual(groupSkillCheckOutcomesByActor([first, second]), [[first, second]]);
});

test("checks by different actors become separate presentation groups", () => {
  const first = outcome({ id: "first", uuid: "Actor.first" });
  const second = outcome({ id: "second", uuid: "Actor.second" });

  assert.deepEqual(groupSkillCheckOutcomesByActor([first, second]), [[first], [second]]);
});

test("mixed checks are grouped by actor UUID in first-seen order", () => {
  const firstActor = { id: "first", uuid: "Actor.first" };
  const secondActor = { id: "second", uuid: "Actor.second" };
  const first = outcome(firstActor, "failure");
  const second = outcome(secondActor, "success");
  const third = outcome({ id: "first-copy", uuid: "Actor.first" }, "criticalSuccess");

  assert.deepEqual(groupSkillCheckOutcomesByActor([first, second, third]), [
    [first, third],
    [second]
  ]);
});

test("skill-check publishers choose serial cards only inside one actor group", () => {
  const source = fs.readFileSync(new URL("../src/rolls/skill-check.mjs", import.meta.url), "utf8");

  assert.match(source, /groupSkillCheckOutcomesByActor\(outcomes\)/);
  assert.match(source, /actorOutcomes\.length > 1\s*\?\s*await publishSkillCheckBatchMessage/);
  assert.match(source, /:\s*await publishSkillCheckMessage\(actorOutcomes\[0\]/);
});
