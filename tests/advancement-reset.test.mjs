import assert from "node:assert/strict";
import test from "node:test";

import { BATCH_EXPECTED_IDS_OPTION } from "../src/utils/document-batch-integrity.mjs";
import { commitAdvancementReset } from "../src/advancement/reset-commit.mjs";

test("advancement reset deletes abilities and updates the Actor in one guarded batch", async () => {
  const actor = { id: "actor-1" };
  let operations;
  globalThis.foundry = {
    documents: {
      modifyBatch: async value => {
        operations = value;
        return [[{ id: "ability-1" }, { id: "ability-2" }], [actor]];
      }
    }
  };

  const result = await commitAdvancementReset(actor, { "system.attributes.level": 1 }, ["ability-1", "ability-2"], "app-1");

  assert.equal(result, actor);
  assert.equal(operations.length, 2);
  assert.equal(operations[0].action, "delete");
  assert.equal(operations[0].documentName, "Item");
  assert.deepEqual(operations[0].ids, ["ability-1", "ability-2"]);
  assert.deepEqual(operations[0][BATCH_EXPECTED_IDS_OPTION], operations[0].ids);
  assert.equal(operations[1].action, "update");
  assert.equal(operations[1].documentName, "Actor");
  assert.deepEqual(operations[1][BATCH_EXPECTED_IDS_OPTION], ["actor-1"]);
  assert.equal(operations[1].updates[0]["system.attributes.level"], 1);
});

test("a canceled reset batch leaves the source Actor and ability list untouched", async () => {
  const actor = { id: "actor-1", level: 4 };
  const abilityIds = ["ability-1", "ability-2"];
  const before = structuredClone({ actor, abilityIds });
  globalThis.foundry = {
    documents: {
      modifyBatch: async operations => {
        assert.equal(operations.length, 2);
        throw new Error("A pre-delete hook canceled the batch.");
      }
    }
  };

  await assert.rejects(
    commitAdvancementReset(actor, { "system.attributes.level": 1 }, abilityIds, "app-1"),
    /canceled the batch/
  );
  assert.deepEqual({ actor, abilityIds }, before);
});

test("a reset is rejected if Foundry reports a missing ability delete", async () => {
  globalThis.foundry = {
    documents: {
      modifyBatch: async () => [[{ id: "ability-1" }], [{ id: "actor-1" }]]
    }
  };

  await assert.rejects(
    commitAdvancementReset({ id: "actor-1" }, {}, ["ability-1", "ability-2"], "app-1"),
    /did not delete every ability Item/
  );
});
