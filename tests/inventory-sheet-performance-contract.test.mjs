import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [sheetSource, actorSource, searchSource] = await Promise.all([
  readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/documents/actor.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/apps/search-inventory.mjs", import.meta.url), "utf8")
]);

test("actor-sheet cell moves use the shared one-update movement path", () => {
  const start = sheetSource.indexOf("async #moveOwnedItem");
  const end = sheetSource.indexOf("async #installConstructPart", start);
  const implementation = sheetSource.slice(start, end);
  assert.match(implementation, /moveOwnedInventoryItemInInventoryFast/);
  assert.match(implementation, /renderParts:\s*sameInventoryContext \? \["inventory"\] : \[\]/);
  assert.ok(implementation.indexOf("moveOwnedInventoryItemInInventoryFast") < implementation.indexOf("#insertItemIntoInventory"));
});

test("inventory-only renders stop before preparing unrelated actor tabs", () => {
  const start = sheetSource.indexOf("async _prepareContext(options)");
  const end = sheetSource.indexOf("async _onRender", start);
  const implementation = sheetSource.slice(start, end);
  const fastReturn = implementation.indexOf('options.parts?.length === 1 && options.parts[0] === "inventory"');
  assert.ok(fastReturn >= 0);
  assert.ok(fastReturn < implementation.indexOf("getCharacteristicSettings()"));
  assert.ok(fastReturn < implementation.indexOf("prepareEffectCategories"));
});

test("the Actor document forwards partial render intent instead of suppressing remote renders", () => {
  const start = actorSource.indexOf("_onUpdateDescendantDocuments");
  const end = actorSource.indexOf("_onUpdate(changes", start);
  const implementation = actorSource.slice(start, end);
  assert.match(implementation, /INVENTORY_RENDER_PARTS_OPTION/);
  assert.match(implementation, /super\._onUpdateDescendantDocuments[\s\S]*?render:\s*false/);
  assert.match(implementation, /this\.render\(false/);
});

test("search inventory imports the shared movement implementation", () => {
  assert.match(searchSource, /import \{ moveOwnedInventoryItemInInventoryFast \} from "\.\.\/inventory\/movement\.mjs"/);
  assert.doesNotMatch(searchSource, /async function moveOwnedInventoryItemInInventoryFast/);
});
