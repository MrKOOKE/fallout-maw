import test from "node:test";
import assert from "node:assert/strict";
import { AimActivationGate, getAimActivationSector, registerAimActivationSectorProvider, getAimActivationUnlockSector } from "../src/utils/aim-activation-gate.mjs";

const point = (origin, angle, distance = 100) => ({
  x: origin.x + Math.sin(angle * Math.PI / 180) * distance,
  y: origin.y - Math.cos(angle * Math.PI / 180) * distance
});

test("only the visible central half unlocks aim; the original cone and its reference remain unchanged", () => {
  const sector = { origin: { x: 20, y: 30 }, rotation: 350, minRotation: -15, maxRotation: 15, radius: 100 };
  const original = structuredClone(sector);
  const gate = new AimActivationGate(() => sector);
  gate.initialize();
  assert.deepEqual(getAimActivationUnlockSector(sector), { ...sector, minRotation: -7.5, maxRotation: 7.5 });
  assert.equal(gate.accept(point(sector.origin, 350, 101)), false, "a ray beyond the painted wedge is not the green area");
  assert.equal(gate.accept(point(sector.origin, 340, 50)), false);
  assert.equal(gate.accept(point(sector.origin, 357.5, 50)), true);
  assert.equal(gate.getWaitingSector(), null);
  assert.deepEqual(sector, original);
  assert.equal(gate.accept(point(sector.origin, 170, 300)), true);
});

test("opening aim seeds the current barrel inside its cone; outside input cannot arm it, then travel is unrestricted", () => {
  const sector = { origin: { x: 100, y: 50 }, rotation: -40, minRotation: -15, maxRotation: 15, seedDistance: 100 };
  const gate = new AimActivationGate(() => sector);
  const seeded = gate.initialize(point(sector.origin, 140));
  assert.deepEqual(seeded, point(sector.origin, -40));
  assert.equal(gate.waiting, true);
  for (let i = 0; i < 100; i++) {
    assert.equal(gate.accept(point(sector.origin, 140)), false);
    assert.equal(gate.waiting, true);
    assert.deepEqual(gate.seedPoint(), seeded);
  }
  assert.equal(gate.accept(sector.origin), false);
  assert.equal(gate.accept(point(sector.origin, -30)), false, "outer half of the original cone remains locked");
  assert.equal(gate.accept(point(sector.origin, -32.5)), true);
  assert.equal(gate.waiting, false);
  assert.equal(gate.accept(point(sector.origin, 140)), true);
  assert.equal(gate.seedPoint(), null);
  gate.initialize();
  assert.equal(gate.waiting, true, "a fresh aiming session requires its own first entry");
});

test("the waiting cone follows a moving hull and handles 0/360, asymmetric paid sectors and mirrored headings", () => {
  let sector = { origin: { x: 0, y: 0 }, rotation: 350, minRotation: 0, maxRotation: 30,
    initialRotation: 355, seedDistance: 100 };
  const gate = new AimActivationGate(() => sector);
  assert.deepEqual(gate.initialize(), point(sector.origin, 355));
  assert.equal(gate.accept(point(sector.origin, 349)), false);
  sector = { ...sector, origin: { x: 400, y: 200 }, rotation: 80, initialRotation: 85 };
  assert.deepEqual(gate.seedPoint(), point(sector.origin, 85));
  assert.equal(gate.accept(point(sector.origin, 355)), false);
  assert.equal(gate.accept(point(sector.origin, 100)), true);
  sector = { ...sector, rotation: 260, minRotation: -30, maxRotation: 0, initialRotation: 250 };
  gate.initialize();
  assert.equal(gate.accept(point(sector.origin, 265)), false);
  assert.equal(gate.accept(point(sector.origin, 240)), true);
});

test("unpaid or unrestricted mechanics do not impose a gate; any new paid rotation mechanic can register the rule", () => {
  let sector = null;
  const remove = registerAimActivationSectorProvider("futureMechanic", controller => controller.paid ? sector : null);
  const controller = { paid: true };
  const gate = new AimActivationGate(() => getAimActivationSector(controller));
  const fallback = { x: 200, y: 300 };
  assert.equal(gate.initialize(fallback), fallback); assert.equal(gate.waiting, false);
  sector = { origin: { x: 0, y: 0 }, rotation: 0, minRotation: -15, maxRotation: 15 };
  gate.initialize(); assert.equal(gate.waiting, true);
  sector = { ...sector, minRotation: -180, maxRotation: 180 };
  assert.equal(gate.accept(fallback), true); assert.equal(gate.waiting, false);
  sector = { ...sector, minRotation: -15, maxRotation: 15 };
  gate.initialize(); remove();
  assert.equal(gate.accept(fallback), true);
  assert.equal(getAimActivationSector(controller), null);
});
