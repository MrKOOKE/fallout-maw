import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getCachedActorLoadPreparation,
  invalidateActorLoadPreparation,
  itemUpdateAffectsActorLoad,
  setCachedActorLoadPreparation
} from "../src/documents/actor-load-preparation-cache.mjs";

test("load cache is reused only for the same Actor inputs and settings snapshot", () => {
  const actor = {};
  const settings = {};
  const load = { value: 17.5, max: 50 };

  setCachedActorLoadPreparation(actor, "signature-a", settings, load);

  assert.deepEqual(
    getCachedActorLoadPreparation(actor, "signature-a", settings),
    load
  );
  assert.equal(
    getCachedActorLoadPreparation(actor, "signature-b", settings),
    null
  );
  assert.equal(
    getCachedActorLoadPreparation(actor, "signature-a", {}),
    null
  );

  invalidateActorLoadPreparation(actor);
  assert.equal(
    getCachedActorLoadPreparation(actor, "signature-a", settings),
    null
  );
});

test("load invalidation recognizes every Item input used by carried weight", () => {
  const relevant = [
    { type: "ability" },
    { "system.quantity": 2 },
    { system: { weight: 3 } },
    { system: { container: { parentId: "container" } } },
    { "system.placement.mode": "constructPart" },
    { system: { equipped: true } },
    { "system.itemFunction": "container" },
    { "system.functions.container.loadReduction": 50 },
    { system: { functions: { "-=container": null } } },
    { "flags.fallout-maw.naturalRaceItem.kind": "weapon" },
    { flags: { "fallout-maw": { "-=naturalRaceItem": null } } }
  ];

  for (const changes of relevant) {
    assert.equal(
      itemUpdateAffectsActorLoad(changes),
      true,
      JSON.stringify(changes)
    );
  }
});

test("combat resource and weapon-state updates do not invalidate carried load", () => {
  const unrelated = [
    { name: "Renamed" },
    { "system.functions.weapon.magazine.value": 4 },
    { system: { functions: { condition: { value: 80 } } } },
    { "system.functions.energySource.reserve.value": 12 },
    { "system.price": 25 },
    { "flags.fallout-maw.eventReaction": { progress: 1 } }
  ];

  for (const changes of unrelated) {
    assert.equal(
      itemUpdateAffectsActorLoad(changes),
      false,
      JSON.stringify(changes)
    );
  }
});

test("Actor load preparation uses Foundry descendant invalidation instead of scanning Items for a signature", async () => {
  const source = await readFile(
    new URL("../src/documents/actor.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("function getActorLoadPreparationSignature");
  const end = source.indexOf("\nfunction clearCreatureSelection", start);
  assert.ok(start >= 0 && end > start);
  const signature = source.slice(start, end);

  assert.doesNotMatch(signature, /actor\.items|itemSignature/);
  assert.match(source, /_preCreateDescendantDocuments[\s\S]*?invalidateActorLoadPreparation/);
  assert.match(source, /_preUpdateDescendantDocuments[\s\S]*?itemUpdateAffectsActorLoad/);
  assert.match(source, /_preDeleteDescendantDocuments[\s\S]*?invalidateActorLoadPreparation/);
});
