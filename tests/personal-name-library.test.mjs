import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_PERSONAL_NAME_BLOCKS } from "../src/data/personal-name-library.mjs";
import { normalizePresetDocument } from "../src/settings/presets/schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(here, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");
const expectedCounts = {
  "default-male-names": 332,
  "default-female-names": 326,
  "default-surnames-common": 351,
  "default-surnames-noble": 121
};
const parseNames = text => Array.from(new Set(String(text ?? "").split(/[,|;\n]+/u).map(value => value.trim()).filter(Boolean)));

test("restored personal name library retains the complete legacy blocks", () => {
  assert.equal(DEFAULT_PERSONAL_NAME_BLOCKS.length, 4);
  for (const block of DEFAULT_PERSONAL_NAME_BLOCKS) {
    assert.equal(parseNames(block.namesText).length, expectedCounts[block.id]);
  }
  assert.equal(DEFAULT_PERSONAL_NAME_BLOCKS.some(block => /Даниил|Илья|Максим|Роман/u.test(block.namesText)), false);
});

test("system and world preset copies contain the restored library and valid revisions", async () => {
  const files = [
    path.join(systemRoot, "storage", "settings-presets", "fallout-maw-migration-seed.json"),
    path.join(systemRoot, "storage", "settings-presets", "fallout-maw.json"),
    path.join(systemRoot, "storage", "settings-presets", "preset-29RLMkIuBBuzp9eClV99Sxcj.json"),
    path.join(dataRoot, "worlds", "fallout", "settings-presets", "fallout-maw.json"),
    path.join(dataRoot, "worlds", "fallout", "settings-presets", "preset-29RLMkIuBBuzp9eClV99Sxcj.json")
  ];
  for (const file of files) {
    const preset = normalizePresetDocument(JSON.parse(await fs.readFile(file, "utf8")));
    const snapshots = [preset.settings, ...(preset.saves ?? []).map(save => save.settings)];
    for (const settings of snapshots) {
      const value = settings.find(setting => setting.id === "fallout-maw.personalNameRandomizer")?.value;
      assert.deepEqual(value?.blocks, DEFAULT_PERSONAL_NAME_BLOCKS, file);
    }
  }
});
