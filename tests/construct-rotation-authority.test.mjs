import test from "node:test";
import assert from "node:assert/strict";
import { performConstructPartRotation, CONSTRUCT_VISUAL_TESTING } from "../src/canvas/construct-visuals.mjs";
import { registerConstructVisualPreviewSocket, publishConstructVisualPreview, clearConstructVisualPreview,
  CONSTRUCT_VISUAL_PREVIEW_TESTING as preview } from "../src/canvas/construct-visual-preview-socket.mjs";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);

function fixture(t, { rotation = 0, minRotation = -180, maxRotation = 180 } = {}) {
  const names = ["game", "canvas", "foundry", "Hooks", "fromUuidSync"];
  const originals = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  const originalNow = Date.now;
  let now = 1000, ids = 0, writes = 0;
  const sent = [], received = [], cleared = [];
  const gm = { id: "gm", isGM: true, active: true };
  const gunner = { id: "gunner", active: true };
  const users = new Map([[gm.id, gm], [gunner.id, gunner]]);
  const performer = { uuid: "Actor.gunnerActor", type: "character", system: {}, statuses: new Set(),
    testUserPermission: user => user.id === gunner.id };
  const actor = { uuid: "Actor.tank", type: "construct", system: { limbs: {} }, flags: {
    "fallout-maw": {
      constructVisual: { enabled: true, anchors: [{ id: "pivot", x: 0.5, y: 0.5 }],
        parts: [{ id: "turret-art", slotId: "turret", anchorId: "pivot", img: "turret.webp",
          rotates: true, rotationSpeed: 90, minRotation, maxRotation }],
        seats: [{ id: "gunner-seat", slotId: "cabin:crew", slotIndex: 0, role: "gunner",
          functions: ["aim", "fire"], partSlotId: "turret" }] },
      actorContainer: { passengers: [{ id: "gunner-passenger", actorUuid: performer.uuid,
        slotId: "cabin:crew", slotIndex: 0, width: 1, height: 1 }] }
    }
  }, getFlag(scope, key) { return this.flags[scope]?.[key]; } };
  const turret = { id: "turret-item", type: "gear", actor, system: {
    placement: { mode: "constructPart", limbKey: "turret" },
    functions: { constructPart: { enabled: true }, condition: { enabled: true, max: 100, value: 100 } }
  } };
  const cabin = { id: "cabin", type: "gear", actor, system: {
    functions: { actorContainer: { enabled: true, slots: [{ id: "crew", quantity: 1, width: 1, height: 1 }] } }
  } };
  actor.items = { contents: [turret, cabin], get: id => actor.items.contents.find(item => item.id === id) };
  const document = { uuid: "Scene.scene.Token.tank", documentName: "Token", actor, parent: { id: "scene" }, texture: {},
    flags: { "fallout-maw": { constructVisualState: { rotations: { turret: rotation } } } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, data) { writes++; this.flags[scope][key] = data; }
  };
  const token = document.object = { document, actor, w: 100, h: 175 };
  globalThis.game = { user: gm, users, socket: { on() {}, emit: (channel, payload) => sent.push({ channel, payload }) } };
  globalThis.canvas = { scene: { id: "scene" } };
  globalThis.foundry = { utils: { randomID: () => `session-${++ids}` } };
  globalThis.Hooks = { on() {} };
  globalThis.fromUuidSync = uuid => uuid === document.uuid ? document : uuid === performer.uuid ? performer : null;
  Date.now = () => now;
  for (const map of [preview.outgoing, preview.incoming, preview.pendingVersions, preview.rotationRates]) map.clear();
  registerConstructVisualPreviewSocket({ getRotations: () => ({}),
    onPreview: data => received.push(data), onClear: data => cleared.push(data) });
  t.after(() => {
    for (const state of preview.incoming.values()) clearTimeout(state.timeout);
    for (const map of [preview.outgoing, preview.incoming, preview.pendingVersions, preview.rotationRates]) map.clear();
    CONSTRUCT_VISUAL_TESTING.previews.delete(token);
    Date.now = originalNow;
    for (const name of names) {
      if (originals[name] === undefined) delete globalThis[name]; else globalThis[name] = originals[name];
    }
  });
  const message = (yaw, sessionId = "remote-session", sequence = 1, type = "preview") => ({
    scope: "fallout-maw.constructVisualPreview", tokenUuid: document.uuid, slotId: "turret",
    rotation: yaw, sessionId, sequence, type
  });
  return { gm, gunner, actor, turret, token, document, sent, received, cleared, message,
    setTime: value => { now = value; }, saved: () => document.getFlag("fallout-maw", "constructVisualState").rotations.turret,
    writes: () => writes,
    commit: (yaw, user = gunner) => performConstructPartRotation(document, { slotId: "turret", rotation: yaw }, { user }) };
}

test("a real crew operator and GM cannot persist an instant 170-degree turn without measured history", async t => {
  const f = fixture(t);
  // Even an arbitrary renderer preview cannot become the trusted initial yaw.
  CONSTRUCT_VISUAL_TESTING.previews.set(f.token, { turret: 170 });
  await assert.rejects(f.commit(170), /ещё не достигла/);
  await assert.rejects(f.commit(170, f.gm), /ещё не достигла/);
  assert.equal(f.saved(), 0);
  assert.equal(f.writes(), 0);
  assert.equal((await f.commit(0)).ok, true);
});

test("authenticated packet spam cannot make the final changed yaw authoritative", async t => {
  const f = fixture(t);
  for (let sequence = 1; sequence <= 30; sequence++) {
    await preview.handleMessage(f.message(170, "spam", sequence), f.gunner.id);
  }
  near(f.received.at(-1).rotation, 13.5);
  await assert.rejects(f.commit(170), /ещё не достигла/);
  assert.equal(f.saved(), 0);
  f.setTime(1100);
  await preview.handleMessage(f.message(170, "spam", 31), f.gunner.id);
  near(f.received.at(-1).rotation, 22.5);
  assert.equal((await f.commit(22.5)).ok, true);
});

test("clear and fresh session spam cannot replenish the network allowance", async t => {
  const f = fixture(t);
  for (let index = 0; index < 30; index++) {
    await preview.handleMessage(f.message(170, `restart-${index}`, 1), f.gunner.id);
    await preview.handleMessage(f.message(170, `restart-${index}`, 2, "clear"), f.gunner.id);
  }
  near(f.received[0].rotation, 13.5);
  assert.ok(f.received.slice(1).every(data => data.rotation === 0));
  await assert.rejects(f.commit(170), /ещё не достигла/);
  assert.equal(f.saved(), 0);
});

test("GM local aiming shares the rate ledger and can confirm between 10 Hz publications", async t => {
  const f = fixture(t);
  assert.equal(publishConstructVisualPreview({ token: f.token, slotId: "turret", rotation: 9 }), true);
  f.setTime(1100);
  assert.equal(publishConstructVisualPreview({ token: f.token, slotId: "turret", rotation: 18 }), true);
  f.setTime(1150);
  assert.equal((await f.commit(22.5, f.gm)).ok, true);
  near(f.saved(), 22.5);
  clearConstructVisualPreview({ token: f.token, slotId: "turret" });
  publishConstructVisualPreview({ token: f.token, slotId: "turret", rotation: 40 });
  near(f.sent.at(-1).payload.rotation, 27); // The remaining 50 ms, not a fresh 150 ms.
  await assert.rejects(f.commit(40, f.gm), /ещё не достигла/);
});

test("a remote limited-sector turn travels through the legal arc and rejects angles beyond its stop", async t => {
  const f = fixture(t, { rotation: 150, minRotation: -160, maxRotation: 160 });
  await preview.handleMessage(f.message(-150), f.gunner.id);
  near(f.received.at(-1).rotation, 136.5);
  await assert.rejects(f.commit(-150), /ещё не достигла/);
  await assert.rejects(f.commit(170), /сектор/);
  assert.equal(f.saved(), 150);
});

test("breaking or replacing the controlled hardware discards its old aiming history", async t => {
  const f = fixture(t);
  await preview.handleMessage(f.message(9), f.gunner.id);
  f.turret.system.functions.condition.value = 0;
  await assert.rejects(f.commit(9), /Нет доступа/);
  assert.equal(preview.incoming.size, 0);
  assert.equal(f.cleared.length, 1);
  f.turret.system.functions.condition.value = 100;
  f.turret.id = "replacement-turret";
  await assert.rejects(f.commit(9), /ещё не достигла/);
  assert.equal(f.saved(), 0);
});
