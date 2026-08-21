import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizePhantomSettings
} from "../src/settings/abilities.mjs";
import {
  registerTokenTargetAlphaProvider,
  resolveTokenTargetAlpha,
  unregisterTokenTargetAlphaProvider
} from "../src/canvas/token-target-alpha.mjs";

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
  const [source, token, fixedSource] = await Promise.all([
    readFile(new URL("../src/abilities/phantom.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/token.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8")
  ]);
  assert.match(source, /const PHANTOM_ALLY_ALPHA = 0\.4/);
  assert.match(source, /sourceActor\?\._source\?\.system/);
  assert.match(source, /type: String\(sourceActor\?\.type \?\? "character"\)/);
  assert.match(source, /items: \[\]/);
  assert.match(source, /effects: \[\]/);
  assert.match(source, /sourceSystem\.currencies = \{\}/);
  assert.match(source, /ownership: \{ default: CONST\.DOCUMENT_OWNERSHIP_LEVELS\.NONE \}/);
  assert.match(source, /detectionModes: \{\}/);
  assert.match(source, /actor\?\.parent\?\.baseActor/);
  assert.match(source, /registerTokenTargetAlphaProvider\(PHANTOM_ALPHA_PROVIDER_ID, getPhantomTokenTargetAlpha\)/);
  assert.match(source, /for \(const visionSource of canvas\?\.effects\?\.visionSources \?\? \[\]\)/);
  assert.match(source, /if \(!visionSource\?\.active\) continue/);
  assert.match(source, /actorsArePhantomAllies\(sourceActor, observerActor\)/);
  assert.match(source, /if \(game\.user\?\.isGM\) return true/);
  assert.match(source, /hasExplicitActorObservation\(observerToken\?\.actor, game\.user\)/);
  assert.match(source, /CONST\.DOCUMENT_OWNERSHIP_LEVELS\.OBSERVER/);
  assert.match(source, /Hooks\.on\("initializeVisionSources", requestPhantomTargetAlphaRefresh\)/);
  assert.match(source, /token\?\.renderFlags\?\.set\?\.\(\{ refreshState: true \}\)/);
  assert.doesNotMatch(source, /Hooks\.on\("refreshToken"/);
  assert.doesNotMatch(source, /token\.mesh\.alpha/);
  assert.match(token, /_getTargetAlpha\(\) \{[\s\S]*?resolveTokenTargetAlpha\(this, super\._getTargetAlpha\(\)\)/);
  assert.match(source, /alpha: 1,/);
  assert.doesNotMatch(source, /alpha: Number\.isFinite\(Number\(sourceToken/);
  assert.match(source, /displayBars: sourceToken\?\.displayBars/);
  assert.doesNotMatch(source, /activatorUserId/);
  assert.doesNotMatch(source, /allyUserIds/);
  assert.doesNotMatch(source, /testUserPermission/);
  assert.doesNotMatch(source, /canvas\?\.tokens\?\.controlled/);
  assert.doesNotMatch(fixedSource, /activatorUserId: sender\.id/);
});

test("token target alpha providers compose on the native local render path", () => {
  const id = "test.phantom-alpha";
  assert.equal(registerTokenTargetAlphaProvider(id, (_token, alpha) => Math.min(alpha, 0.4)), true);
  assert.equal(registerTokenTargetAlphaProvider(id, () => 0), false);
  assert.equal(resolveTokenTargetAlpha({}, 1), 0.4);
  assert.equal(resolveTokenTargetAlpha({}, 0.2), 0.2);
  assert.equal(unregisterTokenTargetAlphaProvider(id), true);
  assert.equal(resolveTokenTargetAlpha({}, 1), 1);
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
  assert.doesNotMatch(fixed, /Создан фантом на/);
});
