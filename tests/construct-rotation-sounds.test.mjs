import test from "node:test";
import assert from "node:assert/strict";
import { getConstructRotationSoundProfiles } from "../src/utils/construct-rotation-sounds.mjs";
import { normalizeConstructVisual } from "../src/utils/construct-visual-model.mjs";

function fixture() {
  return { type: "construct", system: { constructSystems: [{ id: "drive", enabled: true,
    soundRadius: 30, sounds: { rotate: { paths: ["turret.ogg"], volume: 0.4 } } }] },
    flags: { "fallout-maw": { constructVisual: { enabled: true, parts: [
      { id: "turret", slotId: "turret", rotates: true, rotationSystemIds: ["drive"] },
      { id: "mg", slotId: "remote-mg", rotates: true, rotationSystemIds: ["drive"],
        rotationSoundPath: "mg-servo.ogg", rotationSoundVolume: 0.25 }
    ] } } } };
}

test("a moving machine gun plays only its small servo, while turret and simultaneous rotations retain their own sound", () => {
  const actor = fixture();
  const mg = getConstructRotationSoundProfiles(actor, ["remote-mg"]);
  assert.deepEqual(mg.map(profile => profile.sounds.rotate.paths), [["mg-servo.ogg"]]);
  assert.equal(mg[0].sounds.rotate.volume, 0.25);
  assert.equal(mg[0].soundRadius, 30);
  assert.deepEqual(getConstructRotationSoundProfiles(actor, ["turret"]).map(p => p.sounds.rotate.paths), [["turret.ogg"]]);
  assert.deepEqual(getConstructRotationSoundProfiles(actor, ["turret", "remote-mg"]).map(p => p.sounds.rotate.paths), [["turret.ogg"], ["mg-servo.ogg"]]);
  assert.equal(getConstructRotationSoundProfiles(actor, ["turret", "turret"]).length, 1);
  assert.deepEqual(getConstructRotationSoundProfiles(actor, ["missing"]), []);
  assert.deepEqual(getConstructRotationSoundProfiles(actor, []), []);
});

test("audio overrides survive editor normalization, clamp volume and fall back to systems after clearing", () => {
  const actor = fixture(), config = normalizeConstructVisual(actor.flags["fallout-maw"].constructVisual);
  assert.equal(config.parts[1].rotationSoundPath, "mg-servo.ogg");
  assert.equal(config.parts[1].rotationSoundVolume, 0.25);
  config.parts[1].rotationSoundVolume = 8;
  assert.equal(normalizeConstructVisual(config).parts[1].rotationSoundVolume, 1);
  config.parts[1].rotationSoundPath = "";
  actor.flags["fallout-maw"].constructVisual = config;
  assert.deepEqual(getConstructRotationSoundProfiles(actor, ["remote-mg"]).map(p => p.sounds.rotate.paths), [["turret.ogg"]]);
  assert.deepEqual(getConstructRotationSoundProfiles(actor), actor.system.constructSystems);
});
