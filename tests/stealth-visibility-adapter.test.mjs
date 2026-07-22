import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  registerStealthAllyVisibilityPatch,
  unregisterStealthAllyVisibilityPatch
} from "../src/stealth/visibility-adapter.mjs";

const originalConfig = globalThis.CONFIG;

afterEach(() => {
  unregisterStealthAllyVisibilityPatch();
  if (originalConfig === undefined) delete globalThis.CONFIG;
  else globalThis.CONFIG = originalConfig;
});

function createToken({ actorUuid, hidden = false, blind = false } = {}) {
  const effects = new Set();
  if (hidden) effects.add("stealth-hidden");
  if (blind) effects.add("blind");
  const actor = {
    uuid: actorUuid,
    statuses: new Set(hidden ? ["stealth-hidden"] : []),
    getFlag: () => []
  };
  const document = {
    actor,
    hasStatusEffect: status => effects.has(status)
  };
  return { actor, document };
}

test("visibility adapter is idempotent, preserves native detection and is reversible", () => {
  let nativeCalls = 0;
  const nativeCanDetect = function (_visionSource, target) {
    nativeCalls += 1;
    return Boolean(target?.nativelyVisible);
  };
  const basicSight = { walls: true, _canDetect: nativeCanDetect };
  const lightPerception = { walls: false, _canDetect: nativeCanDetect };
  globalThis.CONFIG = {
    Canvas: { detectionModes: { basicSight, lightPerception } },
    specialStatusEffects: {
      INVISIBLE: "stealth-hidden",
      BLIND: "blind",
      BURROW: "burrow"
    }
  };

  registerStealthAllyVisibilityPatch();
  const patchedBasicSight = basicSight._canDetect;
  const patchedLightPerception = lightPerception._canDetect;
  assert.notStrictEqual(patchedBasicSight, nativeCanDetect);
  assert.notStrictEqual(patchedLightPerception, nativeCanDetect);

  registerStealthAllyVisibilityPatch();
  assert.strictEqual(basicSight._canDetect, patchedBasicSight);
  assert.strictEqual(lightPerception._canDetect, patchedLightPerception);

  const sourceToken = createToken({ actorUuid: "Actor.same" });
  const ownHiddenToken = createToken({ actorUuid: "Actor.same", hidden: true });
  const visionSource = { object: sourceToken, blinded: { darkness: false } };

  assert.equal(basicSight._canDetect(visionSource, { nativelyVisible: true }, 0), true);
  assert.equal(nativeCalls, 1);
  assert.equal(basicSight._canDetect(visionSource, ownHiddenToken, 0), true);
  assert.equal(nativeCalls, 2);

  const blindSource = createToken({ actorUuid: "Actor.same", blind: true });
  assert.equal(basicSight._canDetect({ object: blindSource, blinded: { darkness: false } }, ownHiddenToken, 0), false);
  assert.equal(basicSight._canDetect({ object: sourceToken, blinded: { darkness: true } }, ownHiddenToken, 0), false);

  unregisterStealthAllyVisibilityPatch();
  assert.strictEqual(basicSight._canDetect, nativeCanDetect);
  assert.strictEqual(lightPerception._canDetect, nativeCanDetect);
});
