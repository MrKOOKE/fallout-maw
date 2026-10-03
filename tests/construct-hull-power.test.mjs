import test from "node:test";
import assert from "node:assert/strict";
globalThis.foundry = { applications: { api: { DialogV2: class {} }, ux: { FormDataExtended: class {} },
  handlebars: { renderTemplate: () => "" } }, utils: { deepClone: structuredClone } };
const { registerCombatMovementHooks } = await import("../src/combat/movement-resources.mjs");

function fixture() {
  const hooks = new Map(), warnings = [];
  globalThis.Hooks = { on: (name, callback) => hooks.set(name, callback) };
  globalThis.game = { user: { isGM: true }, keyboard: { downKeys: new Set() } };
  globalThis.ui = { notifications: { warn: message => warnings.push(message) } };
  registerCombatMovementHooks();
  const system = { id: "drive", enabled: true, active: false, requiresActivation: true, movement: true,
    resourceKey: "energy", energyPerMovementPoint: 1 };
  const part = (id, contribution) => ({ id, type: "gear", system: {
    placement: { mode: "constructPart", limbKey: id }, functions: { constructPart: { enabled: true, systems: [contribution] },
      condition: { enabled: true, value: 100, max: 100 } }
  } });
  const engine = part("engine", { systemId: "drive", capacity: 1000, activationProvider: true });
  const chassis = part("chassis", { systemId: "drive", movementPoints: 40 });
  const actor = { type: "construct", items: { contents: [engine, chassis] },
    system: { constructSystems: [system], resources: { energy: { value: 500, max: 1000 }, movementPoints: { value: 40, max: 40 } } } };
  const document = { actor, rotation: 5, _source: { rotation: 0 } };
  return { actor, system, engine, document, warnings, guard: hooks.get("preUpdateToken") };
}

test("native hull rotation requires a running, intact drive with usable energy, including for GM", () => {
  const f = fixture(), reserve = f.actor.system.resources.energy.value;
  assert.equal(f.guard(f.document, { rotation: 15 }), false);
  assert.equal(f.actor.system.resources.energy.value, reserve, "Shutdown keeps the bank");
  f.system.active = true;
  assert.equal(f.guard(f.document, { rotation: 15 }), true);
  f.actor.system.resources.energy.value = 0;
  assert.equal(f.guard(f.document, { rotation: 15 }), false);
  f.actor.system.resources.energy.value = reserve;
  f.engine.system.functions.condition.value = 0;
  assert.equal(f.guard(f.document, { rotation: 15 }), false);
  assert.equal(f.warnings.length, 3);
});

test("resize, visual-part aiming, equivalent angles and ordinary actors stay independent of the drive", () => {
  const f = fixture();
  assert.equal(f.guard(f.document, { width: 4, height: 6 }), true);
  assert.equal(f.guard(f.document, { flags: { "fallout-maw": { constructVisualState: { rotations: { turret: 90 } } } } }), true);
  assert.equal(f.guard(f.document, { rotation: 360 }), true, "Compare committed rotation, not an in-flight rendered frame");
  assert.equal(f.guard({ actor: { type: "character" } }, { rotation: 90 }), true);
  assert.deepEqual(f.warnings, []);
});

test("native undo and explicit GM Alt bypass retain their purpose, without leaking to crew commands", () => {
  const f = fixture();
  assert.equal(f.guard(f.document, { rotation: 15 }, { isUndo: true }), true);
  game.keyboard.downKeys.add("AltLeft");
  assert.equal(f.guard(f.document, { rotation: 15 }), true);
  assert.equal(f.guard(f.document, { rotation: 15 }, { falloutMawConstructCrewMovement: true }), false);
  game.user.isGM = false;
  assert.equal(f.guard(f.document, { rotation: 15 }), false);
});
