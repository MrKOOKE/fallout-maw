import test from "node:test";
import assert from "node:assert/strict";
import { playWeaponAttackAnimations, playWeaponExplosionAnimation } from "../src/combat/attack-animations.mjs";

function mockLockedAudio(t) {
  const originalGame = globalThis.game;
  const originalCanvas = globalThis.canvas;
  const messages = [];
  const sounds = [];
  let releaseAudio;
  const waitingForGesture = new Promise(resolve => { releaseAudio = resolve; });
  globalThis.game = {
    user: { id: "gunner" },
    socket: { emit: (channel, payload) => messages.push({ channel, payload }) },
    audio: {
      locked: true,
      interface: undefined,
      play: (path, options) => {
        sounds.push({ path, options });
        return waitingForGesture;
      }
    }
  };
  globalThis.canvas = { scene: { id: "scene" }, level: { id: "level" } };
  t.after(() => {
    releaseAudio();
    globalThis.game = originalGame;
    globalThis.canvas = originalCanvas;
  });
  return { messages, sounds };
}

test("a shot completes while native audio waits for the first gesture and still broadcasts its sound", { timeout: 1000 }, async t => {
  const { messages, sounds } = mockLockedAudio(t);
  await playWeaponAttackAnimations({
    weaponData: { attackSoundPath: "test/cannon.mp3", attackSoundVolume: 0.4 },
    trajectories: []
  });
  assert.equal(game.audio.locked, true);
  assert.deepEqual(sounds, [{ path: "test/cannon.mp3", options: { context: undefined, volume: 0.4 } }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.action, "play");
  assert.equal(messages[0].payload.soundPath, "test/cannon.mp3");
});

test("an explosion completes independently of locked audio and broadcasts its sound", { timeout: 1000 }, async t => {
  const { messages, sounds } = mockLockedAudio(t);
  await playWeaponExplosionAnimation({
    weaponData: { volley: { explosionSoundPath: "test/explosion.mp3" } },
    center: { x: 100, y: 200 },
    radiusPixels: 20
  });
  assert.equal(game.audio.locked, true);
  assert.equal(sounds[0]?.path, "test/explosion.mp3");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.action, "playExplosion");
  assert.equal(messages[0].payload.soundPath, "test/explosion.mp3");
});
