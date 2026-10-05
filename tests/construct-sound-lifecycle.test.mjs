import test from "node:test";
import assert from "node:assert/strict";
import { registerConstructSystemSoundHooks, setConstructMotionSound } from "../src/constructs/system-sounds.mjs";

test("start, travel, turn, idle, shutdown and immediate restart keep loop phase and honor startup gating", async () => {
  const originalTimers = [globalThis.setTimeout, globalThis.clearTimeout], timers = new Map(), sounds = [], singletons = new Map(), hooks = new Map();
  let clock = 0, timerId = 0;
  globalThis.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { at: clock + ms, fn }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const tick = ms => { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  class Sound {
    loaded = true; playing = false; duration = 3; plays = []; stops = 0; listeners = new Map();
    context = { get currentTime() { return clock / 1000; } };
    gain = { value: 0, cancelAndHoldAtTime() {}, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; } };
    get volume() { return this.gain.value; }
    constructor(path) { this.src = path; sounds.push(this); }
    async load() { return this; }
    async play(options) { this.plays.push(options); this.playing = true; this.gain.value = options.volume; }
    async stop() { if (this.playing) this.stops++; this.playing = false; }
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    end() { this.playing = false; this.listeners.get("end")?.(); }
  }
  class Source {
    data = {};
    constructor({ sourceId, object }) { this.sourceId = sourceId; this.object = object; }
    initialize(data) { this.data = data; }
    add() { canvas.sounds.sources.set(this.sourceId, this); }
    destroy() { canvas.sounds.sources.delete(this.sourceId); }
  }
  globalThis.foundry = { audio: { Sound }, utils: { randomID: () => String(++timerId), flattenObject: obj => obj } };
  globalThis.CONFIG = { Canvas: { soundSourceClass: Source } };
  globalThis.Hooks = { on: (key, callback) => hooks.set(key, callback) };
  globalThis.game = { audio: { locked: false, environment: {}, create({ src }) {
    if (!singletons.has(src)) singletons.set(src, new Sound(src)); return singletons.get(src);
  } } };
  const system = { id: "drive", enabled: true, active: false, requiresActivation: true, resourceKey: "power", soundResumeWindow: 250,
    sounds: Object.fromEntries(["start", "stop", "idle", "move", "rotate"].map(key => [key, { paths: [`${key}.ogg`], volume: 0.5 }])) };
  const part = { type: "gear", system: { placement: { mode: "constructPart", limbKey: "engine" }, functions: {
    constructPart: { enabled: true, systems: [{ systemId: "drive", capacity: 1000, activationProvider: true }] },
    condition: { enabled: true, value: 100, max: 100 }
  } } };
  const actor = { uuid: "Actor.tank", type: "construct", system: { constructSystems: [system], resources: { power: { value: 1000 } } }, items: { contents: [part] } };
  const token = { actor, document: { uuid: "Scene.scene.Token.tank", parent: { id: "scene" }, getSoundOrigin: () => ({ x: 0, y: 0, elevation: 0 }) } };
  globalThis.canvas = { scene: { id: "scene" }, tokens: { placeables: [token] }, sounds: { sources: new Map() }, dimensions: { distancePixels: 100 },
    inferLevelFromElevation: () => ({ id: "level" }), perception: { update() {
      for (const source of canvas.sounds.sources.values()) source.object.sync(source.object.document.volume > 0, source.object.document.volume);
    } } };
  const update = () => hooks.get("updateActor")(actor, { "system.constructSystems": actor.system.constructSystems });
  try {
    registerConstructSystemSoundHooks(); hooks.get("canvasReady")();
    system.active = true; update(); await settle();
    setConstructMotionSound(token, "move", true); await settle();
    assert.equal(singletons.get("move.ogg").plays.length, 0, "motion cannot start the stock loop before startup ends");
    sounds.find(sound => sound.src === "start.ogg").end(); await settle();
    const move = singletons.get("move.ogg"), idle = singletons.get("idle.ogg");
    assert.equal(move.plays.length, 1); assert.equal(idle.plays.length, 1);
    setConstructMotionSound(token, "move", false); tick(100); setConstructMotionSound(token, "hullRotate", true);
    tick(1000); await settle(); assert.equal(move.plays.length, 1); assert.equal(move.stops, 0);
    setConstructMotionSound(token, "hullRotate", false); tick(1000); await settle();
    assert.equal(move.stops, 0, "silent travel retains its phase while the engine runs");
    setConstructMotionSound(token, "rotate", true); await settle();
    const servo = singletons.get("rotate.ogg");
    setConstructMotionSound(token, "rotate", false); tick(1000); setConstructMotionSound(token, "rotate", true); await settle();
    assert.equal(servo.plays.length, 1);
    system.active = false; update(); await settle();
    assert.equal(servo.playing, true, "turret remains available with the engine off");
    system.active = true; update(); await settle();
    const latestStart = sounds.filter(sound => sound.src === "start.ogg").at(-1);
    latestStart.end(); await settle(); tick(1000); await settle();
    assert.equal(idle.plays.length, 1, "a restart before release must not leave a stale stop timer");
    actor.flags = { "fallout-maw": { constructVisual: { enabled: true, parts: [
      { id: "turret", slotId: "turret", rotates: true, rotationSystemIds: ["drive"] },
      { id: "mg", slotId: "remote-mg", rotates: true, rotationSystemIds: ["drive"], rotationSoundPath: "mg-servo.ogg", rotationSoundVolume: 0.25 }
    ] } } };
    setConstructMotionSound(token, "rotate", true, { slotIds: ["remote-mg"] }); await settle();
    const mg = singletons.get("mg-servo.ogg");
    assert.equal(mg.plays.length, 1);
    assert.equal(servo.gain.value, 0, "the machine gun must silence the generic turret motor");
    setConstructMotionSound(token, "rotate", true, { slotIds: ["turret", "remote-mg"] }); await settle();
    assert.ok(servo.gain.value > 0 && mg.gain.value > 0, "concurrent mount motions have independent sounds");
    setConstructMotionSound(token, "rotate", true, { slotIds: ["turret"] }); await settle();
    assert.equal(mg.gain.value, 0);
    assert.ok(servo.gain.value > 0);
    setConstructMotionSound(token, "rotate", true, { slotIds: ["remote-mg"] }); await settle();
    update(); await settle();
    assert.equal(servo.gain.value, 0, "resource updates cannot restore the turret motor during MG motion");
    assert.ok(mg.gain.value > 0);
    setConstructMotionSound(token, "rotate", false); await settle();
    assert.equal(mg.gain.value, 0, "a stopped mount must go silent");
    hooks.get("canvasTearDown")(); tick(10000); await settle();
    assert.equal(canvas.sounds.sources.size, 0);
  } finally {
    [globalThis.setTimeout, globalThis.clearTimeout] = originalTimers;
  }
});
