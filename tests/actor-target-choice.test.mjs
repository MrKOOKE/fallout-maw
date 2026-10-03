import test from "node:test";
import assert from "node:assert/strict";
import { getActorTokenRecipients, isActorAtPhysicalToken, getActorTargetName } from "../src/utils/actor-target-context.mjs";
import { chooseActorTargetRecipient } from "../src/apps/actor-target-choice.mjs";

function fixture() {
  globalThis.foundry = { utils: { deepClone: structuredClone }, applications: { api: { DialogV2: {} } } };
  const gunner = { uuid: "Actor.gunner", name: "Gunner", type: "character", img: "gunner.webp", getFlag: () => null };
  const passenger = { id: "occupant", actorUuid: gunner.uuid, slotId: "cabin:crew", slotIndex: 0 };
  const vehicle = { uuid: "Actor.vehicle", name: "Tank", type: "construct", img: "tank.webp", passengers: [passenger],
    getFlag(_scope, key) { return key === "actorContainer" ? { passengers: this.passengers }
      : key === "constructVisual" ? { seats: [{ id: "gunner-seat", name: "Turret", slotId: "cabin:crew", slotIndex: 0 }] } : null; } };
  const token = { actor: vehicle, document: { uuid: "Scene.scene.Token.tank", actor: vehicle }, name: "Tank token" };
  globalThis.fromUuidSync = uuid => uuid === gunner.uuid ? gunner : null;
  globalThis.game = { i18n: { localize: key => key, format: key => key } };
  return { token, vehicle, gunner };
}

test("a crew recipient retains its Actor identity and the carrier's real spatial token", async () => {
  const { token, gunner } = fixture();
  const rows = getActorTokenRecipients(token);
  assert.equal(rows[1].actor, gunner);
  assert.equal(rows[1].token, token);
  assert.equal(rows[1].label, "Turret");
  assert.equal(isActorAtPhysicalToken(gunner, token.document), true);
  assert.equal(getActorTargetName(gunner, token), "Gunner");
  foundry.applications.api.DialogV2.wait = options => options.buttons[1].callback();
  assert.equal((await chooseActorTargetRecipient(token)).actor, gunner);
});

test("cancel and a passenger leaving while chips are open never fall back to the vehicle", async () => {
  const { token, vehicle, gunner } = fixture();
  foundry.applications.api.DialogV2.wait = () => null;
  assert.equal(await chooseActorTargetRecipient(token), null);
  foundry.applications.api.DialogV2.wait = () => { vehicle.passengers = []; return gunner.uuid; };
  assert.equal(await chooseActorTargetRecipient(token), null);
});

test("recipient eligibility is evaluated for each crew Actor, including the source actor", async () => {
  const { token, gunner } = fixture();
  foundry.applications.api.DialogV2.wait = options => {
    assert.equal(options.buttons[0].disabled, false);
    assert.equal(options.buttons[1].disabled, true);
    return gunner.uuid;
  };
  assert.equal(await chooseActorTargetRecipient(token, { sourceActorUuid: gunner.uuid, includeSelf: false }), null);
});
