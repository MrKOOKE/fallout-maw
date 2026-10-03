import assert from "node:assert/strict";
import test from "node:test";
import { ConstructSpatialSound } from "../src/constructs/spatial-system-sound.mjs";

class Source {
  data = {};
  constructor({ sourceId, object }) { this.sourceId = sourceId; this.object = object; }
  initialize(data) { this.data = data; }
  add() { canvas.sounds.sources.set(this.sourceId, this); }
  destroy() { canvas.sounds.sources.delete(this.sourceId); }
}

function fixture({ load } = {}) {
  const sound = { loaded: !load, playing: false, volume: 0, duration: 10, context: { currentTime: 12 },
    plays: [], fades: [],
    load: async () => { await load; sound.loaded = true; },
    play: async options => { sound.plays.push(options); sound.playing = true; sound.volume = options.volume; },
    // A pending release must not delay a subsequent turn or listener update.
    fade: (target, options) => { sound.fades.push({ target, ...options }); return new Promise(() => {}); },
    stop: async () => { sound.playing = false; }
  };
  sound.gain = {
    value: 0,
    cancelAndHoldAtTime() {},
    setValueAtTime(value) { this.value = value; sound.volume = value; },
    linearRampToValueAtTime(target, time) {
      sound.fades.push({ target, duration: Math.round((time - sound.context.currentTime) * 1000) });
    }
  };
  globalThis.CONFIG = { Canvas: { soundSourceClass: Source } };
  globalThis.game = { audio: { environment: {}, create: () => sound } };
  globalThis.canvas = { scene: { id: "scene" }, sounds: { sources: new Map() }, dimensions: { distancePixels: 100 },
    inferLevelFromElevation: () => ({ id: "level" }), perception: { update() {} } };
  const token = { document: { parent: { id: "scene" }, getSoundOrigin: () => ({ x: 100, y: 100, elevation: 1 }) } };
  const spatial = new ConstructSpatialSound(token,
    { path: "servo.ogg", volume: 0.2, radius: 30, walls: true, fadeIn: 180, fadeOut: 300 }, { sourceId: "servo" });
  return { spatial, sound };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test("short pauses redirect pending native fades without restarting the sound", async () => {
  const { spatial, sound } = fixture();
  spatial.sync(true, 0.2);
  await settle();
  assert.deepEqual(sound.plays, [{ loop: true, volume: 0, offset: 2 }]);
  spatial.setEnabled(false);
  assert.equal(spatial.document.volume, 0, "Retained silence cannot mask another native source using the same path");
  assert.deepEqual(sound.fades.at(-1), { target: 0, duration: 300 });
  spatial.setEnabled(true);
  spatial.sync(true, 0.1);
  assert.equal(spatial.document.volume, 0.2);
  assert.deepEqual(sound.fades.at(-1), { target: 0.1, duration: 180 });
  assert.equal(sound.plays.length, 1, "Resume keeps the same playback phase");
  spatial.destroy();
  assert.equal(canvas.sounds.sources.size, 0);
});

test("an old spatial owner cannot stop a singleton adopted by another vehicle during release", async () => {
  const { spatial, sound } = fixture();
  spatial.sync(true, 0.2);
  await settle();
  sound.volume = sound.gain.value = 0.1;
  const timers = [], originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length; };
  try { spatial.destroy(); } finally { globalThis.setTimeout = originalTimer; }
  sound._manager = { vehicle: "new-owner" };
  timers.forEach(callback => callback());
  assert.equal(sound.playing, true);
  assert.equal(sound._manager.vehicle, "new-owner");
});

test("a turn cancelled while loading does not start a stale full-volume loop", async () => {
  let finishLoad;
  const load = new Promise(resolve => { finishLoad = resolve; });
  const { spatial, sound } = fixture({ load });
  spatial.sync(true, 0.2);
  spatial.setEnabled(false);
  finishLoad();
  await settle();
  assert.equal(sound.plays.length, 0);
  spatial.setEnabled(true);
  await settle();
  assert.equal(sound.plays.length, 1);
  assert.equal(sound.plays[0].volume, 0);
  spatial.destroy();
});
