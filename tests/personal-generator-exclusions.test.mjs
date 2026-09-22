import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/apps/personal-generator.mjs", import.meta.url), "utf8");
const extract = (name, deps = {}) => new Function(...Object.keys(deps), `return (${source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]});`)(...Object.values(deps));

test("every independent block runs even when imported data contains old exclusion IDs", async () => {
  const blocks = [
    { id: "armor", pick: "1", exclusions: ["old1", "old2", "old3", "old4", "old5", "old6"], entries: [{ uuid: "armor" }] },
    { id: "helmet", pick: "1", exclusions: ["armor", "deleted"], entries: [{ uuid: "helmet" }] },
    { id: "weapon", pick: "1", exclusions: [], entries: [{ uuid: "weapon" }] }
  ];
  const roll = extract("rollPersonalItemBlocks", { normalizeItemEntries: entries => entries,
    normalizePickMode: () => "count", parsePickValue: Number,
    rollCountBlock: async entries => entries, mergeStackableItemData: entries => entries });
  assert.deepEqual((await roll({ blocks })).map(entry => entry.uuid), ["armor", "helmet", "weapon"]);
});

test("config normalization removes obsolete exclusion fields without changing modern links", () => {
  const normalize = extract("normalizeItemBlock", { getCurrencySettings: () => [], normalizePickMode: () => "count",
    getDefaultCurrencyKey: () => "caps", normalizeItemEntries: entries => entries });
  const entries = [{ uuid: "armor", chain: "set" }, { uuid: "helmet", chain: "set" }];
  const result = normalize({ id: "block", name: "Броня", pick: "1", exclusions: ["old"], entries });
  assert.equal(Object.hasOwn(result, "exclusions"), false);
  assert.deepEqual(result.entries, entries);
});
