import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OVERSIGHT_RESOURCE_SPENT_EVENT_KEY,
  advanceOversightResourceThreshold
} from "../src/events/oversight-resource-event.mjs";

test("oversight consumes the canonical combat.resource.spent event threshold once", () => {
  assert.equal(OVERSIGHT_RESOURCE_SPENT_EVENT_KEY, "fallout-maw.combat.resource.spent");
  assert.deepEqual(
    advanceOversightResourceThreshold(
      { resourceThreshold: 5, accumulatedSpend: 3 },
      { actionPoints: 4, movementPoints: 2, reactionPoints: -100 }
    ),
    { spent: 6, threshold: 5, triggerCount: 1, accumulatedSpend: 4 }
  );
  assert.deepEqual(
    advanceOversightResourceThreshold(
      { resourceThreshold: 5, accumulatedSpend: 4 },
      { actionPoints: 11 }
    ),
    { spent: 11, threshold: 5, triggerCount: 3, accumulatedSpend: 0 }
  );
});

test("oversight fixed provider no longer opens a second legacy semantic event", async () => {
  const [fixedSource, spendingSource] = await Promise.all([
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/combat/resource-spending.mjs", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(
    fixedSource,
    /requestReactionEvent\(REACTION_EVENT_KEYS\.oversightThreshold/u
  );
  assert.doesNotMatch(
    fixedSource,
    /registerCombatResourceSpendingProvider/u
  );
  assert.match(
    fixedSource,
    /collectOversightReactionOffers\(\{ eventKey, context = \{\}, semanticEvent = null \}/u
  );
  assert.equal(
    spendingSource.match(/scope\.emit\("fallout-maw\.combat\.resource\.spent"/gu)?.length,
    1
  );
});
