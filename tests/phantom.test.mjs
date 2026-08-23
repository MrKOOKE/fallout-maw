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
import {
  PHANTOM_ENTITY_FLAG_KEY,
  buildPhantomEntityData,
  getPhantomEntityData,
  isPhantomEntity
} from "../src/abilities/phantom-entity.mjs";

test("phantom defaults match the fixed ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.phantom, "phantom");
  assert.deepEqual(normalizePhantomSettings(), {
    activationEnergyCost: 40,
    overloadEnergyCost: 100,
    overloadDurationSeconds: 60,
    phantomDurationSeconds: 12
  });
});

test("phantom is an empty marked actor and uses native local alpha and vision", async () => {
  const [source, token, vision, fixedSource] = await Promise.all([
    readFile(new URL("../src/abilities/phantom.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/token.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/phantom-vision.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8")
  ]);
  assert.match(source, /const PHANTOM_ALLY_ALPHA = 0\.4/);
  assert.match(source, /sourceActor\?\._source\?\.system/);
  assert.match(source, /type: String\(sourceActor\?\.type \?\? "character"\)/);
  assert.match(source, /items: \[\]/);
  assert.match(source, /effects: \[\]/);
  assert.match(source, /sourceSystem\.currencies = \{\}/);
  assert.match(source, /ownership: \{ default: CONST\.DOCUMENT_OWNERSHIP_LEVELS\.NONE \}/);
  assert.match(source, /sourceToken\?\._source\?\.sight/);
  assert.match(source, /sourceToken\?\._source\?\.detectionModes/);
  assert.match(source, /\[PHANTOM_VISION_FLAG_KEY\]/);
  assert.equal((source.match(/\[PHANTOM_ENTITY_FLAG_KEY\]: buildPhantomEntityData\(\)/g) ?? []).length, 2);
  assert.match(vision, /actor\?\.parent\?\.baseActor/);
  assert.match(source, /registerTokenTargetAlphaProvider\(PHANTOM_ALPHA_PROVIDER_ID, getPhantomTokenTargetAlpha\)/);
  assert.match(source, /for \(const visionSource of canvas\?\.effects\?\.visionSources \?\? \[\]\)/);
  assert.match(source, /if \(!visionSource\?\.active\) continue/);
  assert.match(source, /actorsArePhantomAllies\(sourceActor, observerActor\)/);
  assert.match(source, /if \(game\.user\?\.isGM\) return true/);
  assert.match(source, /hasExplicitActorObservation\(observerToken\?\.actor, game\.user\)/);
  assert.match(vision, /CONST\.DOCUMENT_OWNERSHIP_LEVELS\.OBSERVER/);
  assert.match(source, /Hooks\.on\("initializeVisionSources", requestPhantomTargetAlphaRefresh\)/);
  assert.match(source, /token\?\.renderFlags\?\.set\?\.\(\{ refreshState: true \}\)/);
  assert.doesNotMatch(source, /Hooks\.on\("refreshToken"/);
  assert.doesNotMatch(source, /token\.mesh\.alpha/);
  assert.match(token, /_getTargetAlpha\(\) \{[\s\S]*?resolveTokenTargetAlpha\(this, super\._getTargetAlpha\(\)\)/);
  assert.match(token, /_isVisionSource\(\) \{[\s\S]*?super\._isVisionSource\(\)/);
  assert.match(token, /localViewReceivesPhantomVision\(this\.document\)/);
  assert.match(source, /alpha: 1,/);
  assert.doesNotMatch(source, /alpha: Number\.isFinite\(Number\(sourceToken/);
  assert.match(source, /displayBars: sourceToken\?\.displayBars/);
  assert.doesNotMatch(source, /activatorUserId/);
  assert.doesNotMatch(source, /allyUserIds/);
  assert.doesNotMatch(source, /testUserPermission/);
  assert.match(vision, /canvas\?\.tokens\?\.controlled/);
  assert.doesNotMatch(fixedSource, /activatorUserId: sender\.id/);
});

test("phantom entity data is a single actor and token marker for mechanical exclusion", () => {
  assert.equal(PHANTOM_ENTITY_FLAG_KEY, "phantomEntity");
  assert.deepEqual(buildPhantomEntityData(), {
    excludeFromMechanics: true,
    acceptsDirectDamage: true,
    providesVision: true
  });
  const actor = {
    flags: {
      "fallout-maw": {
        [PHANTOM_ENTITY_FLAG_KEY]: buildPhantomEntityData()
      }
    }
  };
  const token = { actor };
  assert.deepEqual(getPhantomEntityData(token), buildPhantomEntityData());
  assert.equal(isPhantomEntity(token), true);
  assert.equal(isPhantomEntity({ actor: {} }), false);
});

test("phantom token documents never join Foundry Region membership", async () => {
  const [tokenDocument, main] = await Promise.all([
    readFile(new URL("../src/documents/token.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/main.mjs", import.meta.url), "utf8")
  ]);
  assert.match(tokenDocument, /class FalloutMaWTokenDocument extends TokenDocument/);
  assert.match(tokenDocument, /if \(!isPhantomEntity\(this\) \|\| !this\.regions\?\.size\) return/);
  assert.match(tokenDocument, /region\.tokens\?\.delete\?\.\(this\)/);
  assert.match(tokenDocument, /if \(isPhantomEntity\(this\)\) return \[\]/);
  assert.match(tokenDocument, /return super\._identifyRegions\(changes\)/);
  assert.match(main, /CONFIG\.Token\.documentClass = FalloutMaWTokenDocument/);
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

test("phantom integrates expiry, direct damage cleanup and central mechanical exclusion", async () => {
  const [phantom, entity, observers, aura, damage, controller, fixed, visionEvents, naturalItems] = await Promise.all([
    readFile(new URL("../src/abilities/phantom.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/phantom-entity.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/stealth/observers.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/aura-conditions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/stealth/controller.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/events/foundry-vision-events.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/races/natural-items.mjs", import.meta.url), "utf8")
  ]);
  assert.match(phantom, /registerDamageAppliedHandler\(PHANTOM_DAMAGE_HANDLER_ID, onDamageApplied\)/);
  assert.match(phantom, /registerWeaponAttackTerminalHandler\(PHANTOM_WEAPON_TERMINAL_HANDLER_ID, onWeaponAttackTerminal\)/);
  assert.match(phantom, /deletePhantomActor\(actor\)/);
  assert.doesNotMatch(phantom, /deletePhantomsLinkedTo/);
  assert.doesNotMatch(phantom, /defer\(removePhantoms/);
  assert.match(phantom, /result\.phantomDestroyed !== true/);
  assert.match(phantom, /if \(isWeaponAttackDamageResult\(result\)\) continue/);
  assert.match(phantom, /registerStealthObserverExclusionProvider\(PHANTOM_OBSERVER_PROVIDER_ID, observerSeesActivePhantom\)/);
  assert.match(phantom, /duration: \{ seconds: duration, startTime \}/);
  assert.match(entity, /excludeFromMechanics: true/);
  assert.match(entity, /acceptsDirectDamage: true/);
  assert.match(observers, /isPhantomEntity\(hiddenToken\) \|\| isPhantomEntity\(observerToken\)/);
  assert.match(observers, /provider\(hiddenToken, observerToken\) === true/);
  assert.match(aura, /!targetToken\?\.actor \|\| isPhantomEntity\(targetToken\)/);
  assert.match(damage, /function createPhantomDamageResult/);
  assert.match(damage, /healthDelta: 0/);
  assert.match(damage, /phantomDestroyed: amount > 0/);
  assert.match(damage, /weaponAttackDamage: result\.source\?\.weaponAttackDamage === true/);
  assert.match(damage, /if \(isPhantomEntity\(actor\)\)/);
  assert.match(damage, /const actorResults = isPhantomEntity\(actor\)[\s\S]*?\? await applyActorRequests\(\)[\s\S]*?: await queueActorDamageMutation\(actorUuid, applyActorRequests\)/);
  assert.match(damage, /beforeSnapshots\.set\(request, \{ skipEvents: true, index \}\)/);
  assert.match(controller, /active && !skipEntryDetection/);
  assert.match(fixed, /createPhantomForActor\(/);
  assert.doesNotMatch(fixed, /Создан фантом на/);
  assert.match(visionEvents, /&& !isPhantomEntity\(token\)/);
  assert.match(visionEvents, /if \(!isCurrentActiveGM\(\) \|\| isPhantomEntity\(token\)\) return null/);
  assert.match(visionEvents, /physicalLosCache\.removeToken\(sceneKey, tokenUuid, \{ silent: true \}\)/);
  assert.match(naturalItems, /if \(isPhantomEntity\(actor\)\) return;/);
});
