import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [containerSource, searchSource, actorSheetSource] = await Promise.all([
  readFile(new URL("../src/sheets/container-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/apps/search-inventory.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8")
]);

test("ground container operations retain the authoritative search transfer route", () => {
  assert.match(searchSource, /searchTransferHandler:\s*payload => this\.#executeContainerSheetTransfer\(payload\)/);
  assert.match(containerSource, /dragData\.sourceActorUuid = this\.actor\.uuid/);
  assert.match(containerSource, /falloutMawSearchContainerTransferId/);
  assert.match(actorSheetSource, /executeSearchContainerTransfer\(searchContainerTransferId/);
  assert.match(containerSource, /event\.shiftKey[\s\S]*?#searchTransferHandler\(\{/);
});

test("container validation honors infinite actor root inventory", () => {
  assert.match(containerSource, /rootOptions:\s*getActorRootInventoryGridOptions\(this\.actor, ""\)/);
});

test("container sheet restores foreground priority after inventory interaction", () => {
  assert.match(containerSource, /\.fallout-maw-actor-sheet, \.fallout-maw-search-inventory/);
  assert.match(containerSource, /requestAnimationFrame\(\(\) => \{[\s\S]*?this\.bringToFront\(\)/);
});
