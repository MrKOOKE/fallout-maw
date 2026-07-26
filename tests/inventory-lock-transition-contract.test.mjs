import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sources = await Promise.all([
  "../src/apps/search-inventory.mjs",
  "../src/sheets/actor-sheet.mjs",
  "../src/sheets/container-sheet.mjs",
  "../src/inventory/repair.mjs"
].map(async path => [
  path,
  await readFile(new URL(path, import.meta.url), "utf8")
]));

test("every inventory surface applies the shared locked-storage exit transition", () => {
  for (const [path, source] of sources) {
    assert.match(
      source,
      /getItemLockedStateForPlacementTransition/,
      `${path} does not apply the shared locked-storage transition`
    );
  }
});

test("inventory placement builders persist both lock and unlock transition values", () => {
  const searchSource = sources.find(([path]) => path.endsWith("search-inventory.mjs"))?.[1] ?? "";
  const actorSource = sources.find(([path]) => path.endsWith("actor-sheet.mjs"))?.[1] ?? "";
  const containerSource = sources.find(([path]) => path.endsWith("container-sheet.mjs"))?.[1] ?? "";

  assert.match(searchSource, /\{ "system\.locked": lockedState \}/);
  assert.match(actorSource, /\{ "system\.locked": lockedState \}/);
  assert.match(containerSource, /\{ "system\.locked": lockedState \}/);
});
