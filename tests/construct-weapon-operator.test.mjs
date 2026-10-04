import assert from "node:assert/strict";
import test from "node:test";
import {
  canUserUseConstructWeapon,
  getConstructWeaponExecutor,
  getConstructWeaponOperatorConfig,
  getConstructWeaponMuzzleAnchorChoices,
  getConstructWeaponOperatorPartChoices,
  resolveConstructWeaponOperatorActor
} from "../src/utils/construct-weapon-operator.mjs";

globalThis.foundry = { utils: { randomID: () => "id", deepClone: structuredClone } };
const users = { gunner: { id: "gunner" }, loader: { id: "loader" }, driver: { id: "driver" }, gm: { id: "gm", isGM: true } };

function fixture() {
  const actors = new Map(Object.keys(users).filter(id => id !== "gm").map(id => [id, {
    id, uuid: `Actor.${id}`, type: "character", system: { resources: { actionPoints: { value: 8 } } },
    testUserPermission: user => user.id === id
  }]));
  globalThis.game = { actors, time: { worldTime: 0 } };
  globalThis.fromUuidSync = uuid => actors.get(uuid.replace(/^Actor\./, "")) ?? null;
  const actor = {
    id: "tank", uuid: "Actor.tank", type: "construct", system: {}, effects: [],
    flags: { "fallout-maw": {
      constructVisual: { seats: [
        { id: "gunner-seat", slotId: "cabin:crew", slotIndex: 0, role: "gunner", functions: ["aim", "fire", "reload"], partSlotId: "turret" },
        { id: "loader-seat", slotId: "cabin:crew", slotIndex: 1, role: "custom", functions: ["reload"], partSlotId: "turret" },
        { id: "driver-seat", slotId: "cabin:crew", slotIndex: 2, role: "driver", functions: ["move", "rotate"], partSlotId: "hull" }
      ] },
      actorContainer: { passengers: ["gunner", "loader", "driver"].map((id, index) => ({ id, actorUuid: `Actor.${id}`, slotId: "cabin:crew", slotIndex: index, width: 1, height: 1 })) }
    } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    testUserPermission: user => user.id === "driver"
  };
  const cabin = { id: "cabin", name: "Crew compartment", type: "gear", actor, system: {
    functions: { actorContainer: { enabled: true, slots: [{ id: "crew", quantity: 3, width: 1, height: 1 }] } }
  } };
  const weapon = { id: "cannon", name: "Cannon", type: "gear", actor, system: {
    placement: { mode: "constructPart", limbKey: "turret" },
    functions: {
      constructPart: { enabled: true, partType: "turret" },
      condition: { enabled: true, value: 100, max: 100 },
      weapon: { enabled: true, requiresOperator: true, operatorPartSlotId: "", availableActions: { aimedShot: true, reload: true } },
      additionalWeapons: { coax: { id: "coax", enabled: true, requiresOperator: false } }
    }
  } };
  const hull = { id: "hull", name: "Hull", type: "gear", actor, system: { placement: { mode: "constructPart", limbKey: "hull" }, functions: { constructPart: { enabled: true, partType: "hull" } } } };
  actor.items = { contents: [weapon, cabin, hull], get: id => actor.items.contents.find(item => item.id === id) };
  return { actor, weapon, cabin, actors };
}

test("only occupied crew for the matching detail and action can fire; construct ownership is insufficient", () => {
  const { actor, weapon } = fixture();
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), true);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.loader), false);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.driver), false);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gm), true);
  actor.flags["fallout-maw"].actorContainer.passengers = [];
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gm), false);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gm, "fire", "weapon", { gmOverride: true }), true);
});

test("loader can reload only; gunner reload permission can be removed independently", () => {
  const { actor, weapon } = fixture();
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.loader, "reload"), true);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.loader, "aim"), false);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner, "reload"), true);
  actor.flags["fallout-maw"].constructVisual.seats[0].functions = ["aim", "fire"];
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner, "reload"), false);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner, "fire"), true);
});

test("one occupied loader can reload two independent mounts without aiming or firing either", () => {
  const { actor, weapon } = fixture();
  const loader = actor.flags["fallout-maw"].constructVisual.seats.find(seat => seat.id === "loader-seat");
  loader.partSlotId = "";
  loader.reloadPartSlotIds = ["turret", "remote-mg"];
  const mg = { ...weapon, id: "mg", name: "MG", system: structuredClone(weapon.system) };
  mg.system.placement.limbKey = "remote-mg";
  actor.items.contents.push(mg);
  for (const mounted of [weapon, mg]) {
    assert.equal(canUserUseConstructWeapon(actor, mounted, users.loader, "reload"), true);
    assert.equal(canUserUseConstructWeapon(actor, mounted, users.loader, "aim"), false);
    assert.equal(canUserUseConstructWeapon(actor, mounted, users.loader, "fire"), false);
    assert.equal(getConstructWeaponExecutor(actor, mounted, users.loader, "reload")?.actor.id, "loader");
    assert.equal(canUserUseConstructWeapon(actor, mounted, users.driver, "reload"), false);
  }
  weapon.system.placement.mode = "inventory";
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.loader, "reload"), false);
  assert.equal(canUserUseConstructWeapon(actor, mg, users.loader, "reload"), true);
  mg.system.functions.condition.value = 0;
  assert.equal(canUserUseConstructWeapon(actor, mg, users.loader, "reload"), false);
  mg.system.functions.condition.value = 100;
  loader.functions = [];
  assert.equal(canUserUseConstructWeapon(actor, mg, users.loader, "reload"), false);
});

test("removed or destroyed weapon parts and physical seats invalidate authorization immediately", () => {
  const { actor, weapon, cabin } = fixture();
  weapon.system.functions.condition.value = 0;
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), false);
  weapon.system.functions.condition.value = 100;
  weapon.system.placement.mode = "inventory";
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), false);
  weapon.system.placement.mode = "constructPart";
  cabin.system.functions.condition = { enabled: true, value: 0, max: 20 };
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), false);
  cabin.system.functions.condition.value = 20;
  actor.items.contents = actor.items.contents.filter(item => item !== cabin);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), false);
});

test("the real seated character is resolved and a forged passenger/part reference is rejected", async () => {
  const { actor, weapon, actors } = fixture();
  assert.equal(getConstructWeaponExecutor(actor, weapon, users.gunner)?.actor, actors.get("gunner"));
  assert.equal(await resolveConstructWeaponOperatorActor(actor, weapon, users.loader, "reload", "weapon", { passengerId: "loader" }), actors.get("loader"));
  assert.equal(getConstructWeaponExecutor(actor, weapon, users.gunner, "fire", "weapon", { operatorPassengerId: "driver" }), null);
  assert.equal(getConstructWeaponExecutor(actor, weapon, users.gunner, "fire", "weapon", { partSlotId: "hull" }), null);
  assert.equal(canUserUseConstructWeapon({ ...actor, uuid: "Actor.other" }, weapon, users.gm), false);
});

test("requirements are function-specific, legacy flags remain readable, and named part choices preserve removal", () => {
  const { weapon } = fixture();
  assert.deepEqual(getConstructWeaponOperatorConfig(weapon), { required: true, partSlotId: "", muzzleAnchorId: "" });
  assert.deepEqual(getConstructWeaponOperatorConfig(weapon, "coax"), { required: false, partSlotId: "", muzzleAnchorId: "" });
  weapon.flags = { "fallout-maw": { constructWeaponOperators: { coax: { required: true, partSlotId: "turret" } } } };
  assert.deepEqual(getConstructWeaponOperatorConfig(weapon, "coax"), { required: true, partSlotId: "turret", muzzleAnchorId: "" });
  assert.ok(getConstructWeaponOperatorPartChoices(weapon, "removed").some(row => row.value === "removed" && row.selected));
});

test("independent weapon functions keep separate muzzle bindings and unavailable choices", () => {
  const { actor, weapon } = fixture();
  actor.flags["fallout-maw"].constructVisual.anchors = [
    { id: "left-muzzle", name: "Левое дуло", x: 0.45, y: 0.1 },
    { id: "right-muzzle", name: "Правое дуло", x: 0.55, y: 0.1 }
  ];
  weapon.system.functions.weapon.muzzleAnchorId = "left-muzzle";
  weapon.system.functions.additionalWeapons.coax.muzzleAnchorId = "right-muzzle";
  assert.equal(getConstructWeaponOperatorConfig(weapon).muzzleAnchorId, "left-muzzle");
  assert.equal(getConstructWeaponOperatorConfig(weapon, "coax").muzzleAnchorId, "right-muzzle");
  const choices = getConstructWeaponMuzzleAnchorChoices(weapon, "left-muzzle");
  assert.equal(choices.find(row => row.value === "left-muzzle").label, "Левое дуло");
  assert.equal(choices.filter(row => row.selected).length, 1);
  assert.ok(getConstructWeaponMuzzleAnchorChoices(weapon, "removed-muzzle")
    .some(row => row.value === "removed-muzzle" && row.selected));
});

test("a separately installed cannon can bind its performer to its configured parent turret", () => {
  const { actor, weapon } = fixture();
  const turret = structuredClone({ id: "turret-parent", name: "Turret", type: "gear", system: {
    placement: { mode: "constructPart", limbKey: "turret" }, functions: { constructPart: { enabled: true } }
  } });
  turret.actor = actor;
  actor.items.contents.push(turret);
  weapon.system.placement.limbKey = "cannons";
  weapon.system.functions.weapon.operatorPartSlotId = "turret";
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), true);
  assert.equal(getConstructWeaponExecutor(actor, weapon, users.gunner)?.partSlotId, "turret");
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner, "fire", "weapon", { partSlotId: "hull" }), false);
  weapon.system.placement.mode = "inventory";
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner, "fire"), false);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner, "reload"), false);
  weapon.system.placement.mode = "constructPart";
  weapon.system.functions.condition.value = 0;
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner, "fire"), false);
});

test("ordinary weapons retain owner behavior and return the original actor as executor", () => {
  const { actors } = fixture();
  const actor = actors.get("gunner");
  const weapon = { actor, system: { functions: { weapon: { enabled: true } } } };
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), true);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.loader), false);
  assert.equal(getConstructWeaponExecutor(actor, weapon, users.gunner)?.actor, actor);
  weapon.system.functions.weapon.requiresOperator = true;
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), false);
});

test("an autonomous weapon on a crew construct retains OWNER fallback without granting unrelated crew access", () => {
  const { actor, weapon } = fixture();
  weapon.system.functions.weapon.requiresOperator = false;
  actor.flags["fallout-maw"].actorContainer.passengers = [];
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.driver), true);
  assert.equal(getConstructWeaponExecutor(actor, weapon, users.driver)?.actor, actor);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gm), true);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.loader), false);
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), false);
  actor.flags["fallout-maw"].actorContainer.passengers.push({ id: "gunner", actorUuid: "Actor.gunner", slotId: "cabin:crew", slotIndex: 0 });
  assert.equal(canUserUseConstructWeapon(actor, weapon, users.gunner), true);
  assert.equal(getConstructWeaponExecutor(actor, weapon, users.gunner)?.actor.id, "gunner");
});
