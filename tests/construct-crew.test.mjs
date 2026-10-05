import assert from "node:assert/strict";
import test from "node:test";
import {
  canUserControlConstruct, findAvailableConstructCrewSeat, getConstructCrewSeatOptions,
  getConstructCrewSeatState, getConstructCrewSeats, moveConstructCrewPassengerData,
  removeConstructPassengerOwnershipGrants, syncConstructPassengerOwnershipGrants,
  canUserRearrangeConstructCrew, normalizeConstructCrewPersonalWeapons
} from "../src/utils/construct-crew.mjs";
import { getConstructCrewContexts, getConstructCrewContext, canUserUseConstructCrewPersonalWeapon, resolveConstructCrewWeaponSetItem } from "../src/utils/construct-crew-context.mjs";
import { ACTOR_CONTAINER_CREW_TESTING, queueActorContainerOperation, openActorContainerPassengerSheet } from "../src/canvas/actor-containers.mjs";
import { CONSTRUCT_CREW_TESTING, configureConstructCrewActions, requestConstructCrewControl } from "../src/canvas/construct-crew.mjs";
import { getCombatCrew } from "../src/combat/crew-turns.mjs";
import { getActorContainerFlag } from "../src/utils/actor-containers.mjs";

const gm = { id: "gm", isGM: true, active: true };
const driverUser = { id: "driver-user", active: true };
const gunnerUser = { id: "gunner-user", active: true };
const passengerUser = { id: "passenger-user", active: true };
const outsider = { id: "outsider", active: true };

test("reload assignments grant native crew reload access to two mounts only", () => {
  const { actor } = fixture();
  const seat = actor.flags["fallout-maw"].constructVisual.seats.find(row => row.id === "passenger-seat");
  Object.assign(seat, { role: "loader", functions: ["reload"], partSlotId: "", reloadPartSlotIds: ["turret", "remote-mg"] });
  for (const partSlotId of ["turret", "remote-mg"]) {
    assert.equal(canUserControlConstruct(actor, passengerUser, "reload", { partSlotId }), true);
    assert.equal(canUserControlConstruct(actor, passengerUser, "aim", { partSlotId }), false);
    assert.equal(canUserControlConstruct(actor, passengerUser, "fire", { partSlotId }), false);
  }
  assert.equal(canUserControlConstruct(actor, passengerUser, "reload", { partSlotId: "hull" }), false);
  assert.equal(canUserControlConstruct(actor, outsider, "reload", { partSlotId: "remote-mg" }), false);
});

function fixture() {
  let nextId = 0;
  globalThis.foundry = { utils: { deepClone: structuredClone, randomID: () => `id-${++nextId}` } };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2, OWNER: 3 } };
  globalThis.Hooks = { callAll() {} };
  const makeCharacter = (id, owner) => ({ id, uuid: `Actor.${id}`, name: id, img: "icons/svg/mystery-man.svg", type: "character",
    testUserPermission: user => user?.isGM || user?.id === owner, getFlag: () => null });
  const characters = [makeCharacter("driver", driverUser.id), makeCharacter("gunner", gunnerUser.id),
    makeCharacter("passenger", passengerUser.id), makeCharacter("other", outsider.id)];
  const actor = { id: "tank", uuid: "Actor.tank", type: "construct", name: "Tank", ownership: { default: 0 },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    testUserPermission: user => user?.isGM || user?.id === outsider.id,
    async update(data) { if (data.ownership) this.ownership = data.ownership;
      if (data["flags.fallout-maw.actorContainer.passengers"]) this.flags["fallout-maw"].actorContainer.passengers = data["flags.fallout-maw.actorContainer.passengers"]; return this; },
    flags: { "fallout-maw": { constructVisual: { seats: [
      { id: "driver-seat", name: "Driver", role: "driver", slotId: "cabin:crew", slotIndex: 0, partSlotId: "hull" },
      { id: "gunner-seat", name: "Gunner", role: "gunner", slotId: "cabin:crew", slotIndex: 1, partSlotId: "turret" },
      { id: "passenger-seat", name: "Passenger 1", role: "passenger", slotId: "cabin:crew", slotIndex: 2 },
      { id: "free-seat", name: "Passenger 2", role: "passenger", slotId: "cabin:crew", slotIndex: 3 }
    ] }, actorContainer: { passengers: characters.slice(0, 3).map((character, slotIndex) => ({ id: character.id,
      actorUuid: character.uuid, actorName: character.name, slotId: "cabin:crew", slotIndex, width: 1, height: 1 })) } } } };
  const cabin = { id: "cabin", name: "Cabin", type: "gear", actor, system: { functions: {
    actorContainer: { enabled: true, slots: [{ id: "crew", width: 2, height: 2, quantity: 4 }] }
  } } };
  const makePart = id => ({ id, name: id, type: "gear", actor, system: { placement: { mode: "constructPart", limbKey: id }, functions: {
    constructPart: { enabled: true, partType: id }, condition: { enabled: true, value: 100, max: 100 }
  } } });
  const hull = makePart("hull"), turret = makePart("turret");
  actor.items = { contents: [cabin, hull, turret], get: id => actor.items.contents.find(item => item.id === id) };
  const actors = new Map([actor, ...characters].map(row => [row.id, row])); actors.contents = [actor, ...characters];
  const documents = new Map([actor, ...characters].map(row => [row.uuid, row]));
  globalThis.fromUuidSync = uuid => documents.get(uuid) ?? null;
  globalThis.fromUuid = async uuid => documents.get(uuid) ?? null;
  const users = new Map([gm, driverUser, gunnerUser, passengerUser, outsider].map(user => [user.id, user])); users.contents = [...users.values()]; users.activeGM = gm;
  const emissions = [];
  globalThis.game = { user: gm, users, actors, time: { worldTime: 0 }, paused: false,
    socket: { emit: (...args) => emissions.push(args) }, scenes: new Map() };
  const scene = { id: "scene", uuid: "Scene.scene", dimensions: { sceneRect: { x: 0, y: 0, width: 1000, height: 1000 } }, tokens: new Map() };
  game.scenes.set(scene.id, scene);
  const token = { id: "tank-token", uuid: "Scene.scene.Token.tank-token", documentName: "Token", actor,
    parent: scene, x: 100, y: 100, width: 1, height: 1, elevation: 0, rotation: 0,
    object: { center: { x: 150, y: 150 }, checkCollision: () => false },
    async move(waypoints, options) { this.lastMove = { waypoints, options }; Object.assign(this, waypoints.at(-1)); },
    async update(data) { this.lastUpdate = data; Object.assign(this, data); return this; } };
  token._source = { x: token.x, y: token.y, elevation: token.elevation };
  token.object._getShiftedPosition = (dx, dy, dz) => ({ x: token._source.x + dx * 100,
    y: token._source.y + dy * 100, elevation: token._source.elevation + dz * 5 });
  scene.updateEmbeddedDocuments = async (name, updates, options = {}) => {
    assert.equal(name, "Token");
    const instruction = options.movement?.[token.id];
    if (token.object.checkCollision()) throw new Error("стена");
    token.lastMove = { waypoints: instruction.waypoints, options, instruction, updates };
    Object.assign(token._source, instruction.waypoints.at(-1));
    Object.assign(token, token._source);
    return [token];
  };
  documents.set(token.uuid, token);
  globalThis.canvas = { ready: true, scene, tokens: { placeables: [],
    _prepareKeyboardMovementUpdates(_objects, dx, dy, dz) { return [[{ _id: token.id }], { movement: {
      [token.id]: { method: "keyboard", waypoints: [{ ...token.object._getShiftedPosition(dx, dy, dz),
        explicit: false, checkpoint: true, snapped: true }] } } }]; }
  }, grid: { size: 100, sizeX: 100, sizeY: 100 } };
  return { actor, cabin, hull, turret, characters, documents, token, scene, emissions };
}

test("crew movement belongs to the seated driver; passenger and vehicle owner have no controls", () => {
  const { actor } = fixture();
  assert.equal(canUserControlConstruct(actor, driverUser, "move"), true);
  assert.equal(canUserControlConstruct(actor, driverUser, "rotate"), true);
  assert.equal(canUserControlConstruct(actor, passengerUser, "move"), false);
  assert.equal(canUserControlConstruct(actor, outsider, "move"), false);
  assert.equal(canUserControlConstruct(actor, gunnerUser, "aim", { partSlotId: "turret" }), true);
  assert.equal(canUserControlConstruct(actor, gunnerUser, "aim", { partSlotId: "hull" }), false);
  assert.equal(canUserControlConstruct(actor, gm, "move"), true);
  assert.equal(getConstructCrewSeatOptions(actor).length, 4);
});

test("combat and crew permissions never clone parked token restore data, while editable reads remain isolated", () => {
  const { actor } = fixture();
  const payload = { delta: { system: { inventory: { preserved: true } } } };
  actor.flags["fallout-maw"].actorContainer.passengers[0].tokenData = payload;
  const clone = foundry.utils.deepClone;
  foundry.utils.deepClone = value => {
    assert.notEqual(value, payload, "read-only crew checks must not copy a parked actor");
    return clone(value);
  };
  assert.equal(getCombatCrew(actor).length, 3);
  assert.equal(canUserControlConstruct(actor, driverUser, "move"), true);
  assert.equal(canUserControlConstruct(actor, gunnerUser, "aim", { partSlotId: "turret" }), true);
  foundry.utils.deepClone = clone;
  const draft = getActorContainerFlag(actor);
  draft.passengers[0].tokenData.delta.system.inventory.preserved = false;
  assert.equal(payload.delta.system.inventory.preserved, true);
});

test("native no-op rotation acknowledges the existing angle without a document write", async () => {
  const { token } = fixture();
  token.update = () => { assert.fail("equivalent yaw must not write"); };
  const result = await requestConstructCrewControl({ tokenUuid: token.uuid, action: "rotate", rotation: 360 });
  assert.deepEqual(result, { ok: true, rotation: 0, changed: false });
});

test("independent vehicles do not block each other; consecutive commands for one token retain order", async () => {
  const { token, documents, actor } = fixture();
  const other = { ...token, uuid: "Scene.scene.Token.other", actor: { ...actor, uuid: "Actor.other-tank" } };
  documents.set(other.uuid, other);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const writes = [];
  token.update = async data => {
    writes.push(data.rotation);
    if (writes.length === 1) { entered(); await gate; }
    token.rotation = data.rotation;
    return token;
  };
  const first = requestConstructCrewControl({ tokenUuid: token.uuid, action: "rotate", rotation: 15 });
  await started;
  const next = requestConstructCrewControl({ tokenUuid: token.uuid, action: "rotate", rotation: 30 });
  let independentDone = false;
  const independent = requestConstructCrewControl({ tokenUuid: other.uuid, action: "rotate", rotation: 15 })
    .then(result => { independentDone = true; return result; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(independentDone, true);
    assert.deepEqual(writes, [15]);
  } finally {
    release();
    await Promise.all([first, next, independent]);
  }
  assert.deepEqual(writes, [15, 30]);
});

test("same user may own several occupied roles and permissions change immediately on transfer", () => {
  const { actor, characters } = fixture();
  characters[1].testUserPermission = user => user.id === driverUser.id;
  assert.equal(canUserControlConstruct(actor, driverUser, "aim", { partSlotId: "turret" }), true);
  const passengers = actor.getFlag("fallout-maw", "actorContainer").passengers;
  const moved = moveConstructCrewPassengerData(actor, passengers, "driver", "free-seat");
  assert.ok(moved);
  actor.flags["fallout-maw"].actorContainer.passengers = moved;
  assert.equal(canUserControlConstruct(actor, driverUser, "move"), false);
  assert.equal(canUserControlConstruct(actor, driverUser, "aim", { partSlotId: "turret" }), true);
});

test("crew positions allow one character even when the physical grid has extra cells", () => {
  const { actor, characters } = fixture();
  assert.equal(findAvailableConstructCrewSeat(actor, characters[3], { width: 1, height: 1 }, { seatId: "driver-seat" }), null);
  assert.equal(findAvailableConstructCrewSeat(actor, characters[3], { width: 1, height: 1 })?.crewSeatId, "free-seat");
  assert.equal(moveConstructCrewPassengerData(actor, actor.getFlag("fallout-maw", "actorContainer").passengers, "passenger", "driver-seat"), null);
});

test("destroyed or removed controlled parts and seat items revoke access while retaining occupants", () => {
  const { actor, hull, cabin } = fixture();
  hull.system.functions.condition.value = 0;
  assert.equal(canUserControlConstruct(actor, driverUser, "move"), false);
  assert.equal(getConstructCrewSeatState(actor, getConstructCrewSeats(actor)[0]).occupant.id, "driver");
  hull.system.functions.condition.value = 100;
  hull.system.placement.mode = "inventory";
  assert.equal(canUserControlConstruct(actor, driverUser, "move"), false);
  hull.system.placement.mode = "constructPart";
  actor.items.contents = actor.items.contents.filter(item => item !== cabin);
  assert.equal(canUserControlConstruct(actor, gunnerUser, "aim", { partSlotId: "turret" }), false);
});

test("an unconscious driver retains their position but cannot move or rotate the construct", () => {
  const { actor, characters } = fixture();
  characters[0].statuses = new Set(["unconscious"]);
  assert.equal(canUserControlConstruct(actor, driverUser, "move"), false);
  assert.equal(canUserControlConstruct(actor, driverUser, "rotate"), false);
  assert.equal(getConstructCrewSeatState(actor, getConstructCrewSeats(actor)[0]).occupant.id, "driver");
  characters[0].statuses.clear();
  assert.equal(canUserControlConstruct(actor, driverUser, "move"), true);
});

test("concurrent transfers are serialized and cannot put two occupants into one position", async () => {
  const { actor } = fixture();
  const results = await Promise.allSettled([
    queueActorContainerOperation(() => ACTOR_CONTAINER_CREW_TESTING.transfer({ vehicleActorUuid: actor.uuid, passengerId: "driver", seatId: "free-seat" }, driverUser.id)),
    queueActorContainerOperation(() => ACTOR_CONTAINER_CREW_TESTING.transfer({ vehicleActorUuid: actor.uuid, passengerId: "gunner", seatId: "free-seat" }, gunnerUser.id))
  ]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
  assert.equal(actor.getFlag("fallout-maw", "actorContainer").passengers.filter(row => row.slotIndex === 3).length, 1);
});

test("boarding uses the requested crew seat and temporarily grants carrier ownership", async () => {
  const { actor, scene, characters } = fixture();
  actor.flags["fallout-maw"].actorContainer.passengers = [];
  const passenger = characters[0];
  const passengerToken = { id: "driver-token", actor: passenger, actorLink: true,
    width: 1, height: 1, toObject: () => ({ _id: "driver-token", actorId: passenger.id, actorLink: true, width: 1, height: 1 }) };
  scene.tokens.set(passengerToken.id, passengerToken);
  const operations = [];
  foundry.documents = { modifyBatch: async batch => {
    operations.push(...batch);
    return Promise.all(batch.map(async operation => {
      if (operation.documentName === "Actor") { await actor.update(operation.updates[0]); return [{ id: actor.id }]; }
      for (const id of operation.ids) scene.tokens.delete(id);
      return operation.ids.map(id => ({ id }));
    }));
  } };
  await ACTOR_CONTAINER_CREW_TESTING.board({ sceneId: scene.id, passengerActorUuid: passenger.uuid,
    passengerTokenId: passengerToken.id, vehicleActorUuid: actor.uuid, seatId: "gunner-seat" }, driverUser.id);
  assert.deepEqual(actor.ownership, { default: 0, [driverUser.id]: 3 });
  assert.equal(actor.getFlag("fallout-maw", "actorContainer").passengers[0].slotIndex, 1);
  assert.deepEqual(actor.getFlag("fallout-maw", "actorContainer").passengers[0].temporaryOwnerUserIds, [driverUser.id]);
  assert.equal(operations.some(operation => Object.hasOwn(operation.updates?.[0] ?? {}, "ownership")), true);
});

test("temporary carrier ownership survives another owned occupant and restores the original level", async () => {
  const { actor, characters } = fixture();
  actor.ownership = { default: 0, [driverUser.id]: 2, "existing-owner": 3 };
  const originalCharacterPermissions = characters.map(character => character.testUserPermission);
  characters[1].testUserPermission = user => user?.isGM || user?.id === driverUser.id;

  assert.equal(await syncConstructPassengerOwnershipGrants(actor), true);
  assert.equal(actor.ownership[driverUser.id], 3);
  let passengers = actor.getFlag("fallout-maw", "actorContainer").passengers;
  for (const row of passengers.slice(0, 2)) {
    assert.deepEqual(row.temporaryOwnerUserIds, [driverUser.id]);
    assert.equal(row.temporaryOwnerLevels[driverUser.id], 2);
  }
  assert.equal(actor.ownership["existing-owner"], 3);
  assert.equal(await syncConstructPassengerOwnershipGrants(actor), false);

  characters[0].testUserPermission = user => user?.isGM;
  assert.equal(await syncConstructPassengerOwnershipGrants(actor), true);
  assert.equal(actor.ownership[driverUser.id], 3);
  passengers = actor.getFlag("fallout-maw", "actorContainer").passengers;
  assert.deepEqual(passengers[0].temporaryOwnerUserIds, []);
  assert.equal(passengers[1].temporaryOwnerLevels[driverUser.id], 2);

  characters[1].testUserPermission = user => user?.isGM;
  assert.equal(await syncConstructPassengerOwnershipGrants(actor), true);
  assert.equal(actor.ownership[driverUser.id], 2);
  assert.equal(actor.ownership["existing-owner"], 3);
  assert.equal(characters[2].testUserPermission, originalCharacterPermissions[2]);
  assert.equal(await syncConstructPassengerOwnershipGrants(actor), false);
});

test("legacy temporary vehicle ownership is retired without deleting genuine preexisting permissions", async () => {
  const { actor } = fixture();
  actor.ownership = { default: 0, "driver-user": 3, "gunner-user": 3, "existing-owner": 3 };
  const passengers = actor.getFlag("fallout-maw", "actorContainer").passengers;
  passengers[0].temporaryOwnerUserIds = [driverUser.id];
  passengers[0].temporaryOwnerLevels = { [driverUser.id]: 2 };
  passengers[1].temporaryOwnerUserIds = [gunnerUser.id];
  passengers[1].temporaryOwnerLevels = {};
  assert.equal(await removeConstructPassengerOwnershipGrants(actor), true);
  assert.deepEqual(actor.ownership, { default: 0, "driver-user": 2, "existing-owner": 3 });
  assert.ok(actor.getFlag("fallout-maw", "actorContainer").passengers.every(row => !row.temporaryOwnerUserIds.length));
  assert.equal(await removeConstructPassengerOwnershipGrants(actor), false);
});

test("crew hull turns report rejected native updates instead of acknowledging an unperformed turn", async () => {
  const { token } = fixture();
  assert.equal((await CONSTRUCT_CREW_TESTING.performControl({ tokenUuid: token.uuid, action: "rotate", delta: 15 }, driverUser)).rotation, 15);
  token.update = async () => undefined;
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl({ tokenUuid: token.uuid, action: "rotate", delta: 15 }, driverUser), /Поворот корпуса не выполнен/);
  assert.equal(token.rotation, 15);
});

test("gunner purchases and aims the parent turret of a separately mounted cannon, with the same operator checks as firing", async () => {
  const { actor, turret, token, documents } = fixture();
  const cannon = { id: "cannon", uuid: `${actor.uuid}.Item.cannon`, actor, type: "gear", system: {
    placement: { mode: "constructPart", limbKey: "cannons" },
    functions: { constructPart: { enabled: true }, condition: { enabled: true, value: 100, max: 100 },
      weapon: { enabled: true, requiresOperator: true, operatorPartSlotId: "turret" } } } };
  actor.items.contents.push(cannon); documents.set(cannon.uuid, cannon);
  const calls = [];
  configureConstructCrewActions({ aim: async request => { calls.push(request); return { ok: true, rotation: request.rotation }; } });
  const payload = { tokenUuid: token.uuid, action: "rotationBudget", partSlotId: "turret", rotation: 10,
    passengerId: "gunner", weaponUuid: cannon.uuid, weaponFunctionId: "weapon" };
  assert.equal((await CONSTRUCT_CREW_TESTING.performControl(payload, gunnerUser)).ok, true);
  assert.equal(calls.at(-1).buyOnly, true);
  assert.equal(calls.at(-1).partSlotId, "turret");
  assert.equal((await CONSTRUCT_CREW_TESTING.performControl({ ...payload, action: "aim" }, gunnerUser)).ok, true);
  assert.equal(calls.at(-1).buyOnly, false);
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl({ ...payload, passengerId: "driver" }, driverUser), /не даёт/);
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl({ ...payload, partSlotId: "cannons" }, gunnerUser), /не даёт/);
  const seat = actor.flags["fallout-maw"].constructVisual.seats[1];
  seat.functions = ["fire", "reload"];
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl(payload, gunnerUser), /не даёт/);
  seat.functions.push("aim");
  turret.system.functions.condition.value = 0;
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl(payload, gunnerUser), /не даёт/);
  turret.system.functions.condition.value = 100;
  cannon.system.functions.condition.value = 0;
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl(payload, gunnerUser), /не даёт/);
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl({ ...payload, weaponUuid: "Item.missing" }, gunnerUser), /не найдено/);
});

test("authorized driver commits native scene movement, enforces constraints and rejects revoked driver", async () => {
  const { token, actor } = fixture();
  await CONSTRUCT_CREW_TESTING.performControl({ tokenUuid: token.uuid, action: "move", dx: 1, dy: 0 }, driverUser);
  assert.equal(token.x, 200);
  assert.equal(token.lastMove.waypoints.length, 1);
  assert.deepEqual(token.lastMove.updates, [{ _id: token.id }]);
  assert.equal(token.lastMove.instruction.constrainOptions.ignoreWalls, false);
  assert.equal(token.lastMove.instruction.constrainOptions.ignoreCost, false);
  assert.equal(token.lastUpdate, undefined);
  token.object.checkCollision = () => true;
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl({ tokenUuid: token.uuid, action: "move", dx: 1, dy: 0 }, driverUser), /стена/);
  token.object.checkCollision = () => false;
  actor.flags["fallout-maw"].actorContainer.passengers = actor.getFlag("fallout-maw", "actorContainer").passengers.filter(row => row.id !== "driver");
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl({ tokenUuid: token.uuid, action: "move", dx: 1, dy: 0 }, driverUser), /не даёт/);
});

test("native commit releases the shared authority queue before animation and rebases repeated keyboard inputs", async () => {
  const { token } = fixture();
  token.object.movementAnimationPromise = new Promise(() => {});
  const payload = { tokenUuid: token.uuid, action: "move", passengerId: "driver",
    keyboard: { dx: 1, dy: 0, dz: 0 }, waypoints: [{ x: 200, y: 100 }],
    movementOptions: { method: "keyboard", autoRotate: true, showRuler: false,
      constrainOptions: { ignoreWalls: true, ignoreCost: true } } };
  await Promise.all([queueActorContainerOperation(() => CONSTRUCT_CREW_TESTING.performControl(payload, driverUser)),
    queueActorContainerOperation(() => CONSTRUCT_CREW_TESTING.performControl(payload, driverUser))]);
  assert.equal(token._source.x, 300);
  assert.equal(token.lastMove.instruction.autoRotate, true);
  assert.equal(token.lastMove.instruction.showRuler, false);
  assert.equal(token.lastMove.instruction.method, "keyboard");
  assert.equal(token.lastMove.instruction.constrainOptions.ignoreWalls, false);
  assert.equal(token.lastMove.instruction.constrainOptions.ignoreCost, false);
  await assert.rejects(CONSTRUCT_CREW_TESTING.performControl({ ...payload, keyboard: { dx: 2 } }, driverUser), /одним шагом/);
});

test("socket sender cannot impersonate a driver or another GM", async () => {
  const { token, emissions } = fixture();
  await CONSTRUCT_CREW_TESTING.handleSocketMessage({ scope: "fallout-maw.constructCrew", type: "request",
    requestId: "forged", requesterUserId: driverUser.id, gmUserId: gm.id,
    payload: { tokenUuid: token.uuid, action: "move", dx: 1, dy: 0 } }, outsider.id);
  assert.equal(emissions.length, 0);
  assert.equal(token.x, 100);
  await CONSTRUCT_CREW_TESTING.handleSocketMessage({ scope: "fallout-maw.constructCrew", type: "request",
    requestId: "authorized", requesterUserId: driverUser.id, gmUserId: gm.id,
    payload: { tokenUuid: token.uuid, action: "move", dx: 1, dy: 0 } }, driverUser.id);
  assert.equal(token.x, 200);
  assert.equal(emissions.at(-1)[1].ok, true);
});

test("duplicate socket deliveries share one native movement commit and preserve the original response", async () => {
  const { token, emissions } = fixture();
  const message = { scope: "fallout-maw.constructCrew", type: "request", requestId: "duplicate-movement",
    requesterUserId: driverUser.id, gmUserId: gm.id,
    payload: { tokenUuid: token.uuid, action: "move", dx: 1, dy: 0 } };
  await Promise.all([1, 2].map(() => CONSTRUCT_CREW_TESTING.handleSocketMessage(message, driverUser.id)));
  assert.equal(token.x, 200);
  assert.equal(emissions.length, 2);
  assert.deepEqual(emissions[0], emissions[1]);
  await CONSTRUCT_CREW_TESTING.handleSocketMessage(message, driverUser.id);
  assert.equal(token.x, 200);
  await CONSTRUCT_CREW_TESTING.handleSocketMessage({ ...message, requestId: "next-movement" }, driverUser.id);
  assert.equal(token.x, 300);
});

test("selected crew context exposes only owned real occupants and never substitutes an invalid selection", () => {
  const { actor, characters } = fixture();
  assert.deepEqual(getConstructCrewContexts(actor, driverUser).map(row => row.actor), [characters[0]]);
  assert.deepEqual(getConstructCrewContexts(actor, gm).map(row => row.actor), characters.slice(0, 3));
  assert.equal(getConstructCrewContext(actor, driverUser, { passengerId: "gunner" }), null);
  assert.equal(getConstructCrewContext(actor, gm, { passengerId: "missing" }), null);
  assert.equal(getConstructCrewContext(actor, driverUser, { passengerId: "driver", seatId: "gunner-seat" }), null);
  characters[0].statuses = new Set(["unconscious"]);
  assert.equal(getConstructCrewContext(actor, driverUser)?.actor, characters[0]);
  assert.equal(getConstructCrewContext(actor, driverUser)?.available, false);
  assert.equal(getConstructCrewContext(actor, driverUser, { availableOnly: true }), null);
});

test("personal weapons remain on the actual character and require that character's enabled visible port", () => {
  const { actor, characters, turret } = fixture();
  const visual = actor.flags["fallout-maw"].constructVisual;
  visual.anchors = [{ id: "base", x: 0.5, y: 0.5 }, { id: "window", parentSlotId: "turret", x: 0.2, y: 0 }];
  visual.parts = [{ slotId: "turret", anchorId: "base", img: "turret.webp", width: 1, height: 1 }];
  visual.seats[2].personalWeapons = { enabled: true, anchorId: "window", coverPercent: 70 };
  const weapon = { id: "pistol", actor: characters[2], parent: characters[2] };
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, weapon, passengerUser, { passengerId: "passenger" }), true);
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, weapon, driverUser), false);
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, weapon, gm, { passengerId: "driver" }), false);
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, { ...weapon, actor, parent: actor }, passengerUser), false);
  visual.seats[2].personalWeapons.enabled = false;
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, weapon, passengerUser), false);
  visual.seats[2].personalWeapons.enabled = true;
  turret.system.functions.condition.value = 0;
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, weapon, passengerUser), false);
  turret.system.functions.condition.value = 100;
  visual.anchors = visual.anchors.filter(anchor => anchor.id !== "window");
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, weapon, passengerUser), false);
});

test("one user with several real characters resolves the personal weapon owner without crossing selected seats", () => {
  const { actor, characters } = fixture();
  characters[1].testUserPermission = user => user.isGM || user.id === driverUser.id;
  const visual = actor.flags["fallout-maw"].constructVisual;
  visual.anchors = [{ id: "window", x: 0.5, y: 0.5 }];
  for (const seat of visual.seats.slice(0, 2)) seat.personalWeapons = { enabled: true, anchorId: "window" };
  const gunnerWeapon = { id: "pistol", parent: characters[1] };
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, gunnerWeapon, driverUser), true);
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, gunnerWeapon, driverUser, { operatorPassengerId: "gunner" }), true);
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, gunnerWeapon, driverUser, { operatorPassengerId: "driver" }), false);
  assert.equal(canUserUseConstructCrewPersonalWeapon(actor, gunnerWeapon, driverUser, { passengerId: "missing" }), false);
});

test("parked passenger fallback resolves the real surviving actor rather than a removed synthetic token actor", async () => {
  const { actor, characters } = fixture();
  const passenger = actor.flags["fallout-maw"].actorContainer.passengers[2];
  passenger.actorUuid = "Scene.old.Token.removed.Actor.old";
  passenger.originalActorUuid = passenger.actorUuid;
  passenger.parkedActorId = characters[2].id;
  assert.equal(getConstructCrewContext(actor, passengerUser, { passengerId: passenger.id })?.actor, characters[2]);
  assert.equal(getConstructCrewContexts(actor, outsider).length, 0);
  let rendered = 0;
  characters[2].sheet = { render: () => { rendered += 1; } };
  game.user = passengerUser;
  assert.equal(await openActorContainerPassengerSheet({ vehicleActor: actor, passengerId: passenger.id }), true);
  assert.equal(rendered, 1);
});

test("personal weapon normalization retains portable defaults and bounds malformed imported fields", () => {
  assert.deepEqual(normalizeConstructCrewPersonalWeapons(null), { enabled: false, anchorId: "", minRotation: -180,
    maxRotation: 180, maxRangeMeters: null, coverPercent: 100 });
  assert.deepEqual(normalizeConstructCrewPersonalWeapons({ enabled: "false", anchorId: " window ", minRotation: 999,
    maxRotation: -999, maxRangeMeters: 999999, coverPercent: -20 }), { enabled: false, anchorId: "window",
    minRotation: -180, maxRotation: 180, maxRangeMeters: 100000, coverPercent: 0 });
  assert.equal(normalizeConstructCrewPersonalWeapons({ exposed: true }).coverPercent, 0);
  assert.equal(normalizeConstructCrewPersonalWeapons({ maxRangeMeters: "" }).maxRangeMeters, null);
});

test("weapon display rows resolve real owner documents and identical item IDs never cross mounted and personal sets", () => {
  const { actor, characters } = fixture();
  const crew = characters[2];
  const personal = { id: "same-id", actor: crew, documentName: "Item", system: { functions: { weapon: { enabled: true } } } };
  const mounted = { id: "same-id", actor, documentName: "Item", system: { functions: { weapon: { enabled: true } } } };
  crew.items = { get: id => id === personal.id ? personal : null, contents: [personal] };
  actor.items.contents.push(mounted);
  const displayRow = { id: "same-id", name: "Display data", img: "pistol.webp" };
  const personalSet = { key: "personal", slots: [{ item: displayRow }] };
  const mountedSet = { key: "mounted", crewMounted: true, slots: [{ item: mounted }] };
  assert.equal(resolveConstructCrewWeaponSetItem(actor, crew, personalSet, personal.id), personal);
  assert.equal(resolveConstructCrewWeaponSetItem(actor, crew, mountedSet, mounted.id), mounted);
  assert.equal(resolveConstructCrewWeaponSetItem(actor, crew, personalSet, "not-in-set"), null);
  crew.items.get = () => null;
  crew.items.contents = [];
  assert.equal(resolveConstructCrewWeaponSetItem(actor, crew, personalSet, personal.id), null);
});

test("a seated player can move or swap another passenger without gaining ownership or changing real documents", async () => {
  const { actor, characters } = fixture();
  const beforeActors = characters.map(character => ({ uuid: character.uuid, ownerAllowed: character.testUserPermission(driverUser) }));
  assert.equal(canUserRearrangeConstructCrew(actor, driverUser), true);
  assert.equal(canUserRearrangeConstructCrew(actor, outsider), false);
  await assert.rejects(ACTOR_CONTAINER_CREW_TESTING.transfer({ vehicleActorUuid: actor.uuid,
    passengerId: "passenger", seatId: "free-seat" }, outsider.id), /Нет прав/);
  await ACTOR_CONTAINER_CREW_TESTING.transfer({ vehicleActorUuid: actor.uuid, passengerId: "passenger", seatId: "free-seat" }, driverUser.id);
  assert.equal(actor.getFlag("fallout-maw", "actorContainer").passengers.find(row => row.id === "passenger").slotIndex, 3);
  await ACTOR_CONTAINER_CREW_TESTING.transfer({ vehicleActorUuid: actor.uuid, passengerId: "passenger", seatId: "gunner-seat", swap: true }, driverUser.id);
  const rows = actor.getFlag("fallout-maw", "actorContainer").passengers;
  assert.equal(rows.find(row => row.id === "passenger").slotIndex, 1);
  assert.equal(rows.find(row => row.id === "gunner").slotIndex, 3);
  assert.deepEqual(actor.ownership, { default: 0 });
  assert.deepEqual(characters.map(character => ({ uuid: character.uuid, ownerAllowed: character.testUserPermission(driverUser) })), beforeActors);
  await assert.rejects(ACTOR_CONTAINER_CREW_TESTING.transfer({ vehicleActorUuid: actor.uuid,
    passengerId: "from-another-vehicle", seatId: "free-seat", swap: true }, driverUser.id), /Нет прав/);
});

test("owning a passenger in one construct never grants rearrangement authority in another", async () => {
  const { actor, documents } = fixture();
  const second = { ...actor, id: "second-tank", uuid: "Actor.second-tank", flags: structuredClone(actor.flags) };
  second.flags["fallout-maw"].actorContainer.passengers = second.flags["fallout-maw"].actorContainer.passengers.filter(row => row.id === "gunner");
  actor.flags["fallout-maw"].actorContainer.passengers = actor.flags["fallout-maw"].actorContainer.passengers.filter(row => row.id !== "gunner");
  documents.set(second.uuid, second);
  assert.equal(canUserRearrangeConstructCrew(actor, driverUser), true);
  assert.equal(canUserRearrangeConstructCrew(second, driverUser), false);
  await assert.rejects(ACTOR_CONTAINER_CREW_TESTING.transfer({ vehicleActorUuid: second.uuid,
    passengerId: "gunner", seatId: "free-seat", swap: true }, driverUser.id), /Нет прав/);
  assert.equal(second.flags["fallout-maw"].actorContainer.passengers[0].slotIndex, 1);
});

test("atomic swaps preserve passenger identity, actor references and token metadata", () => {
  const { actor } = fixture();
  const passengers = actor.flags["fallout-maw"].actorContainer.passengers;
  passengers[0].originalActorUuid = "Scene.source.Token.original.Actor.driver";
  passengers[0].parkedActorId = "parked-driver";
  passengers[0].tokenData = { _id: "original-token", actorId: "source", actorLink: false, delta: { system: { resources: { actionPoints: { value: 7 } } } } };
  const before = structuredClone(passengers);
  const swapped = moveConstructCrewPassengerData(actor, passengers, "driver", "gunner-seat", { swap: true });
  assert.ok(swapped);
  assert.deepEqual(passengers, before);
  assert.equal(swapped.find(row => row.id === "driver").tokenData, passengers[0].tokenData);
  for (const row of swapped) {
    const original = before.find(entry => entry.id === row.id);
    for (const key of ["actorUuid", "originalActorUuid", "parkedActorId", "tokenData"]) assert.deepEqual(row[key], original[key]);
  }
  assert.equal(swapped.find(row => row.id === "driver").slotIndex, 1);
  assert.equal(swapped.find(row => row.id === "gunner").slotIndex, 0);
});

test("swaps check both occupants against the opposite physical seat and reject damaged hardware", () => {
  const { actor, cabin, hull, turret } = fixture();
  const passengers = actor.flags["fallout-maw"].actorContainer.passengers;
  cabin.system.functions.actorContainer.slots.push({ id: "small", width: 1, height: 1, quantity: 1 });
  actor.flags["fallout-maw"].constructVisual.seats[0].slotId = "cabin:small";
  passengers[0].slotId = "cabin:small";
  passengers[1].width = 2;
  assert.equal(moveConstructCrewPassengerData(actor, passengers, "driver", "gunner-seat", { swap: true }), null);
  assert.equal(moveConstructCrewPassengerData(actor, passengers, "gunner", "driver-seat", { swap: true }), null);
  passengers[1].width = 1;
  assert.ok(moveConstructCrewPassengerData(actor, passengers, "driver", "gunner-seat", { swap: true }));
  hull.system.functions.condition.value = 0;
  assert.equal(moveConstructCrewPassengerData(actor, passengers, "driver", "gunner-seat", { swap: true }), null);
  hull.system.functions.condition.value = 100;
  turret.system.placement.mode = "inventory";
  assert.equal(moveConstructCrewPassengerData(actor, passengers, "driver", "gunner-seat", { swap: true }), null);
});

test("duplicate occupancy is rejected and concurrent swaps read the latest authoritative placements", async () => {
  const { actor } = fixture();
  const passengers = actor.flags["fallout-maw"].actorContainer.passengers;
  assert.equal(moveConstructCrewPassengerData(actor, [...passengers, { ...passengers[2], id: "duplicate" }], "driver", "free-seat", { swap: true }), null);
  const operations = [];
  const update = actor.update.bind(actor);
  actor.update = async data => { operations.push(data); return update(data); };
  await Promise.all([
    queueActorContainerOperation(() => ACTOR_CONTAINER_CREW_TESTING.transfer({ vehicleActorUuid: actor.uuid, passengerId: "driver", seatId: "gunner-seat", swap: true }, driverUser.id)),
    queueActorContainerOperation(() => ACTOR_CONTAINER_CREW_TESTING.transfer({ vehicleActorUuid: actor.uuid, passengerId: "passenger", seatId: "gunner-seat", swap: true }, passengerUser.id))
  ]);
  const rows = actor.getFlag("fallout-maw", "actorContainer").passengers;
  assert.equal(rows.find(row => row.id === "driver").slotIndex, 2);
  assert.equal(rows.find(row => row.id === "gunner").slotIndex, 0);
  assert.equal(rows.find(row => row.id === "passenger").slotIndex, 1);
  assert.equal(new Set(rows.map(row => `${row.slotId}:${row.slotIndex}`)).size, 3);
  assert.equal(operations.length, 2);
  assert.ok(operations.every(data => Object.keys(data).length === 1 && !Object.hasOwn(data, "ownership")));
});

test("rearrangement authority cannot open the foreign passenger sheet even with observer access", async () => {
  const { actor, characters } = fixture();
  let rendered = 0;
  const gunner = characters[1];
  gunner.sheet = { render: () => { rendered += 1; } };
  gunner.testUserPermission = (user, permission) => user.isGM || user.id === gunnerUser.id
    || user.id === driverUser.id && permission === "OBSERVER";
  game.user = driverUser;
  assert.equal(canUserRearrangeConstructCrew(actor, driverUser), true);
  assert.equal(await openActorContainerPassengerSheet({ vehicleActor: actor, passengerId: "gunner" }), false);
  assert.equal(rendered, 0);
  game.user = gunnerUser;
  assert.equal(await openActorContainerPassengerSheet({ vehicleActor: actor, passengerId: "gunner" }), true);
  assert.equal(rendered, 1);
});
