import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const TRAPS_SOURCE = readFileSync(
  new URL("../src/canvas/traps.mjs", import.meta.url),
  "utf8"
);
const THROWN_ITEMS_SOURCE = readFileSync(
  new URL("../src/canvas/thrown-items.mjs", import.meta.url),
  "utf8"
);

test("trap and thrown-item surfaces never mutate Actor Items directly", () => {
  for (const source of [TRAPS_SOURCE, THROWN_ITEMS_SOURCE]) {
    assert.doesNotMatch(source, /\bitem\.delete\s*\(/);
    assert.doesNotMatch(source, /\bitem\.update\s*\(/);
    assert.doesNotMatch(
      source,
      /\b(?:actor|sourceActor|targetActor)\.(?:create|update|delete)EmbeddedDocuments\s*\(\s*["']Item["']/
    );
  }
});

test("actor trap placement is committed by the GM before the caller reports success", () => {
  assert.match(TRAPS_SOURCE, /type:\s*"request"/);
  assert.match(TRAPS_SOURCE, /type:\s*"response"/);
  assert.match(TRAPS_SOURCE, /commitInventoryItemConsumption\s*\(/);
  assert.match(TRAPS_SOURCE, /placementOperationId/);
  assert.match(TRAPS_SOURCE, /placementCommitted/);
  assert.match(TRAPS_SOURCE, /deleteTrapDocumentsSafely\s*\(/);
  const transaction = sourceBetween(
    TRAPS_SOURCE,
    "async function createTrapDocumentsNow",
    "async function resolveTrapPlacementSource"
  );
  const markerIndex = transaction.indexOf("placementCommitted`]: true");
  const consumeIndex = transaction.indexOf("consumeTrapItem(");
  const placedEventIndex = transaction.indexOf("emitTrapPlaced(");
  assert.ok(markerIndex >= 0 && consumeIndex >= 0 && placedEventIndex >= 0);
  assert.ok(
    markerIndex < consumeIndex,
    "the world marker must be writable before Actor consumption becomes the final transaction step"
  );
  assert.ok(
    consumeIndex < placedEventIndex,
    "post-commit events must run after the Actor Item transaction"
  );
});

test("world item RPCs carry durable idempotency markers", () => {
  assert.match(THROWN_ITEMS_SOURCE, /operationId/);
  assert.match(THROWN_ITEMS_SOURCE, /thrownPickupTileUuid/);
  assert.match(TRAPS_SOURCE, /trapPickupTileUuid/);
  assert.match(
    THROWN_ITEMS_SOURCE,
    /export async function deleteDelayedThrownItemWorldDocuments\s*\(/
  );
  assert.match(
    THROWN_ITEMS_SOURCE,
    /export async function deleteThrownItemTileByOperation\s*\(/
  );
  assert.match(
    THROWN_ITEMS_SOURCE,
    /export function isDelayedThrownItemWorldOperationCancelled\s*\(/
  );
});

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source range: ${startMarker}`);
  return source.slice(start, end);
}
