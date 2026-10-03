import assert from "node:assert/strict";
import test from "node:test";
import { planTankTokenFootprint } from "../src/apps/modular-tank-token-footprint.mjs";

test("migration retains an owner's already-corrected native size and artwork placement", () => {
  const document = { width: 3, height: 5, x: 3200, y: 1300, rotation: 315,
    texture: { scaleX: 1.3, scaleY: 1.3, anchorY: 0.6 },
    flags: { "fallout-maw": { tokenHitbox: { enabled: true, x: 11, y: 30, width: 78, height: 65 } } } };
  const before = structuredClone(document);
  assert.deepEqual(planTankTokenFootprint(document, { sceneToken: true }),
    { "flags.fallout-maw.tokenHitbox": { enabled: true, "-=x": null, "-=y": null, "-=width": null, "-=height": null } });
  assert.deepEqual(document, before);
});
