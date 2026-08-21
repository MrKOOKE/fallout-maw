import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizePhantomSettings
} from "../src/settings/abilities.mjs";

test("phantom defaults match the fixed ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.phantom, "phantom");
  assert.deepEqual(normalizePhantomSettings(), {
    activationEnergyCost: 40,
    overloadEnergyCost: 100,
    overloadDurationSeconds: 60,
    phantomDurationSeconds: 12
  });
});

test("phantom is a full combat actor without duplicable contents and uses the native drag-origin alpha", async () => {
  const source = await readFile(new URL("../src/abilities/phantom.mjs", import.meta.url), "utf8");
  assert.match(source, /const PHANTOM_ALLY_ALPHA = 0\.4/);
  assert.match(source, /sourceActor\?\._source\?\.system/);
  assert.match(source, /type: String\(sourceActor\?\.type \?\? "character"\)/);
  assert.match(source, /items: \[\]/);
  assert.match(source, /effects: \[\]/);
  assert.match(source, /sourceSystem\.currencies = \{\}/);
  assert.match(source, /ownership: \{ default: CONST\.DOCUMENT_OWNERSHIP_LEVELS\.NONE \}/);
  assert.match(source, /detectionModes: \{\}/);
  assert.match(source, /actor\?\.parent\?\.baseActor/);
  assert.match(source, /token\.mesh\.alpha = alpha \*/);
  assert.match(source, /displayBars: sourceToken\?\.displayBars/);
  assert.match(source, /const controlledActors = \(canvas\?\.tokens\?\.controlled \?\? \[\]\)/);
  assert.match(source, /hasExplicitActorOwnership\(sourceActor, user\)/);
  assert.match(source, /phantomTokensBySourceActor\.size && actorPerspectiveChanged\(changes\)/);
  assert.doesNotMatch(source, /if \(user\.isGM/);
  assert.doesNotMatch(source, /canvas\?\.tokens\?\.placeables[\s\S]*?testUserPermission/);
});

test("phantom integrates expiry, damage cleanup and observer exclusion", async () => {
  const [phantom, observers, controller, fixed] = await Promise.all([
    readFile(new URL("../src/abilities/phantom.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/stealth/observers.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/stealth/controller.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8")
  ]);
  assert.match(phantom, /registerDamageAppliedHandler\(PHANTOM_DAMAGE_HANDLER_ID, onDamageApplied\)/);
  assert.doesNotMatch(phantom, /if \(!received\) continue/);
  assert.match(phantom, /registerStealthObserverExclusionProvider\(PHANTOM_OBSERVER_PROVIDER_ID, observerSeesActivePhantom\)/);
  assert.match(phantom, /duration: \{ seconds: duration, startTime \}/);
  assert.match(observers, /provider\(hiddenToken, observerToken\) === true/);
  assert.match(controller, /active && !skipEntryDetection/);
  assert.match(fixed, /createPhantomForActor\(/);
});
