import test from "node:test";
import assert from "node:assert/strict";
import { planRotationSector, rotationSectorBounds } from "../src/utils/construct-rotation-cost.mjs";
import { planConstructRotation, purchaseConstructRotation, refundConstructRotation, getConstructRouteRotationCost,
  registerConstructRotationTurns, recordConstructRotationProgress } from "../src/constructs/rotation-actions.mjs";
import { callActorTurnStartPreparedHandlers } from "../src/combat/turn-events.mjs";

const empty = origin => ({ origin, last: origin, min: null, max: null });
const hull = { points: 2, degrees: 15 }, turret = { points: 5, degrees: 30 };

test("first turn opens one direction's sector; exact boundaries and returning through paid angles are free", () => {
  const right = planRotationSector(empty(0), 15, hull);
  assert.equal(right.cost, 2); assert.deepEqual(rotationSectorBounds(right.state, hull), { min: 0, max: 15 });
  assert.equal(planRotationSector(right.state, 0, hull).cost, 0);
  const left = planRotationSector(empty(0), -30, turret);
  assert.equal(left.cost, 5); assert.equal(planRotationSector(left.state, 0, turret).cost, 0);
  const blocked = planRotationSector(right.state, 30, hull, 0);
  assert.equal(blocked.rotation, 15); assert.equal(blocked.reached, false);
  assert.equal(planRotationSector(right.state, 30, hull, 2).cost, 2);
});

test("crossing zero retains the turn's reference without recharging the same interval", () => {
  const first = planRotationSector(empty(350), 5, hull);
  assert.equal(first.rotation, 365); assert.equal(first.cost, 2);
  const second = planRotationSector(first.state, 20, hull);
  assert.equal(second.rotation, 380); assert.equal(second.cost, 2);
  assert.equal(planRotationSector(second.state, 355, hull).cost, 0);
  assert.equal(planRotationSector(empty(350), 355, hull, 1).rotation, 350);
});

function fixture() {
  const drive = { id: "drive", enabled: true, active: true, requiresActivation: true, movement: true, resourceKey: "power", energyPerMovementPoint: 1 };
  const part = (id, systems) => ({ id, type: "gear", system: { placement: { mode: "constructPart", limbKey: id },
    functions: { condition: { enabled: true, value: 100, max: 100 }, constructPart: { enabled: true, systems } } } });
  const engine = part("engine", [{ systemId: "drive", capacity: 1000, activationProvider: true }]);
  const chassis = part("chassis", [{ systemId: "drive", movementPoints: 40 }]);
  const gun = part("turret", []);
  const actor = { uuid: "Actor.tank", type: "construct", items: { contents: [engine, chassis, gun] }, effects: [],
    flags: { "fallout-maw": { constructVisual: { enabled: true, hullRotationCost: hull,
      parts: [{ id: "turret", slotId: "turret", rotates: true, rotationCost: turret, rotationSystemIds: ["drive"] }] } } },
    system: { constructSystems: [drive], resources: { movementPoints: { value: 40, max: 40, min: 0, once: 0 }, power: { value: 1000, max: 1000, min: 0, once: 0 } } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async update(updates) {
      for (const [path, value] of Object.entries(updates)) {
        const keys = path.split("."); let target = this;
        for (const key of keys.slice(0, -1)) target = target[key] ??= {};
        target[keys.at(-1)] = structuredClone(value);
      }
      return this;
    } };
  const doc = { uuid: "Scene.scene.Token.tank", id: "tank", parent: { id: "scene" }, actor, rotation: 0, _source: { rotation: 0 }, flags: { "fallout-maw": {} },
    getFlag(scope, key) { return this.flags[scope]?.[key]; }, getCenterPoint: point => ({ x: point.x, y: point.y }) };
  actor.getActiveTokens = () => [doc];
  const combat = { id: "battle", started: true, round: 1, turn: 0, combatant: { actor }, combatants: [{ actor }] };
  globalThis.game = { user: { isGM: true }, combats: [combat], settings: { get: () => true } };
  globalThis.CONFIG = { Token: { movement: { actions: { walk: {} } } } };
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : uuid === doc.uuid ? doc : null;
  return { actor, doc, drive, engine, combat };
}

test("authoritative sectors debit strict MP and energy once; hull yaw is independent of turret yaw", async () => {
  const f = fixture();
  const first = await purchaseConstructRotation(f.doc, "turret", 10, { notify: false });
  assert.equal(first.cost, 0); assert.equal(f.actor.system.resources.movementPoints.value, 40); assert.equal(f.actor.system.resources.power.value, 1000);
  recordConstructRotationProgress(f.doc, "turret", 10);
  f.doc._source.rotation = 90;
  const paid = await purchaseConstructRotation(f.doc, "turret", 15, { notify: false });
  assert.equal(paid.cost, 0); assert.equal(f.actor.system.resources.movementPoints.value, 40);
  assert.equal((await purchaseConstructRotation(f.doc, "hull", 105, { notify: false })).cost, 2);
  assert.equal((await purchaseConstructRotation(f.doc, "turret", 16, { notify: false })).cost, 5);
  assert.equal(f.actor.system.resources.power.value, 993);
});

test("engine dependence applies out of combat, broken engine blocks rotation, shutdown retains the bank", async () => {
  const f = fixture(); game.combats = [];
  f.drive.active = false;
  assert.equal(planConstructRotation(f.doc, "turret", 10).powered, false);
  await assert.rejects(purchaseConstructRotation(f.doc, "turret", 10, { notify: false }), /включите/);
  assert.equal(f.actor.system.resources.power.value, 1000);
  f.drive.active = true;
  assert.equal((await purchaseConstructRotation(f.doc, "turret", 60, { notify: false })).cost, 0);
  f.engine.system.functions.condition.value = 0;
  assert.equal(planConstructRotation(f.doc, "turret", 10).powered, false);
});

test("multi-leg native route pays every entered hull sector; cancellation refunds resources and allocation", async () => {
  const f = fixture(), path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: -10 }];
  assert.equal(getConstructRouteRotationCost(f.doc, path, { autoRotate: true }), 24);
  const paid = await purchaseConstructRotation(f.doc, "hull", 180, { path, notify: false });
  assert.equal(paid.cost, 24); assert.equal(f.actor.system.resources.movementPoints.value, 16); assert.equal(f.actor.system.resources.power.value, 976);
  await refundConstructRotation(paid.receipt);
  assert.equal(f.actor.system.resources.movementPoints.value, 40); assert.equal(f.actor.system.resources.power.value, 1000);
  assert.equal(planConstructRotation(f.doc, "hull", 15).cost, 2);
});

test("turn start captures the real initial pose and resets all purchased sectors", async () => {
  const f = fixture(); registerConstructRotationTurns();
  await callActorTurnStartPreparedHandlers({ actor: f.actor, combat: f.combat });
  await purchaseConstructRotation(f.doc, "turret", 5, { notify: false });
  f.doc.flags["fallout-maw"].constructVisualState = { rotations: { turret: 30 } };
  f.doc._source.rotation = 90; f.combat.turn = 1;
  await callActorTurnStartPreparedHandlers({ actor: f.actor, combat: f.combat });
  assert.equal(planConstructRotation(f.doc, "turret", 35).state.origin, 30);
  assert.equal(planConstructRotation(f.doc, "turret", 35).cost, 0);
  assert.equal(planConstructRotation(f.doc, "turret", 46).cost, 5);
  assert.equal(planConstructRotation(f.doc, "hull", 105).state.origin, 90);
});

test("turn origin uses the reached barrel preview before its document commit, independently of hull yaw", async t => {
  const f = fixture();
  f.doc.flags["fallout-maw"].constructVisualState = { rotations: { turret: 10 } };
  f.doc._source.rotation = 90;
  let reached = 350;
  registerConstructRotationTurns({ partRotations: doc => ({ ...doc.getFlag("fallout-maw", "constructVisualState")?.rotations, turret: reached }) });
  t.after(() => registerConstructRotationTurns({ partRotations: doc => doc.getFlag("fallout-maw", "constructVisualState")?.rotations ?? {} }));
  await callActorTurnStartPreparedHandlers({ actor: f.actor, combat: f.combat });
  assert.equal(planConstructRotation(f.doc, "turret", 350).state.origin, -10);
  assert.equal(planConstructRotation(f.doc, "turret", 350).cost, 0);
  assert.equal(planConstructRotation(f.doc, "hull", 105).state.origin, 90);
  const paid = await purchaseConstructRotation(f.doc, "turret", 5, { notify: false });
  assert.equal(paid.cost, 0);
  reached = 5; f.doc._source.rotation = 180;
  assert.equal(planConstructRotation(f.doc, "turret", 20).state.origin, -10);
  assert.equal(planConstructRotation(f.doc, "turret", 5).cost, 0);
  assert.equal(planConstructRotation(f.doc, "turret", 6).cost, 5);
});

test("the last energy pays a usable sector, while engine shutdown still prevents rotation", async () => {
  const f = fixture(); f.actor.system.resources.power.value = 5;
  await purchaseConstructRotation(f.doc, "turret", 16, { notify: false });
  recordConstructRotationProgress(f.doc, "turret", 16);
  assert.equal(f.actor.system.resources.power.value, 0);
  assert.equal(planConstructRotation(f.doc, "turret", 15, { budget: 0 }).reached, true);
  assert.equal(planConstructRotation(f.doc, "turret", -15, { budget: 0 }).reached, true);
  assert.equal(planConstructRotation(f.doc, "turret", 45, { budget: 0 }).reached, true);
  assert.equal(planConstructRotation(f.doc, "turret", 46, { budget: 0 }).reached, false);
  f.drive.active = false;
  assert.equal(planConstructRotation(f.doc, "turret", 10).powered, false);
});

test("the initial centered cone is free; only extensions actually crossed are purchased", () => {
  const profile = { points: 2, degrees: 30 }, state = { ...empty(-40), offset: -15, min: 0, max: 0 };
  for (const entry of [-47.5, -32.5]) {
    const first = planRotationSector(state, entry, profile);
    assert.equal(first.cost, 0);
    assert.deepEqual(rotationSectorBounds(first.state, profile), { min: -55, max: -25 });
    for (const angle of [-55, -40, -25]) assert.equal(planRotationSector(first.state, angle, profile, 0).cost, 0);
    const extended = planRotationSector(first.state, -24, profile);
    assert.equal(extended.cost, 2);
    assert.deepEqual(rotationSectorBounds(extended.state, profile), { min: -55, max: 5 });
    assert.equal(planRotationSector(first.state, -24, profile, 0).rotation, -25);
  }
  const limited = planRotationSector(state, -90, profile, 2);
  assert.equal(limited.cost, 2); assert.equal(limited.rotation, -85);
  assert.equal(limited.reached, false);
  assert.deepEqual(rotationSectorBounds(limited.state, profile), { min: -85, max: -25 });
});

test("a missing turn ledger does not rebase the origin on the first live aiming preview", () => {
  const f = fixture();
  f.doc.flags["fallout-maw"].constructVisualState = { rotations: { turret: -40 } };
  const initial = planConstructRotation(f.doc, "turret", -40);
  assert.equal(initial.state.origin, -40);
  f.doc.flags["fallout-maw"].constructVisualState = { rotations: { turret: -35 } };
  const changed = planConstructRotation(f.doc, "turret", -34);
  assert.equal(changed.state.origin, -40);
  assert.equal(changed.cost, 0);
  assert.deepEqual(rotationSectorBounds(changed.state, changed.profile), { min: -55, max: -25 });
});

test("the initial cone works with zero MP, without spending energy or writing a ledger", async () => {
  const f = fixture(); f.actor.system.resources.movementPoints.value = 0;
  const before = structuredClone(f.actor.flags), resources = structuredClone(f.actor.system.resources);
  for (const angle of [-7.5, 7.5, -15, 15]) {
    const result = await purchaseConstructRotation(f.doc, "turret", angle, { notify: false });
    assert.equal(result.cost, 0); assert.equal(result.reached, true); assert.equal(result.receipt, undefined);
    recordConstructRotationProgress(f.doc, "turret", angle);
  }
  assert.deepEqual(f.actor.flags, before);
  assert.deepEqual(f.actor.system.resources, resources);
  for (const angle of [-15.01, 15.01]) {
    const result = planConstructRotation(f.doc, "turret", angle);
    assert.equal(result.reached, false); assert.equal(Math.abs(result.rotation), 15);
  }
});

test("full circular coverage stays free through repeated revolutions in either direction", () => {
  const profile = { points: 2, degrees: 30 };
  for (const direction of [-1, 1]) {
    let state = { ...empty(350), offset: -15, min: 0, max: 0 }, total = 0;
    for (let i = 1; i <= 72; i++) {
      const step = planRotationSector(state, 350 + direction * i * 15, profile);
      total += step.cost; state = step.state;
      assert.equal(step.reached, true);
      if (i >= 24) assert.equal(step.cost, 0, "opening the whole circle must stop charging subsequent revolutions");
    }
    assert.equal(total, 22, "one free initial sector and eleven paid 30-degree extensions cover the circle");
    for (let i = 1; i <= 72; i++) {
      const step = planRotationSector(state, state.last - direction * 15, profile, 0);
      assert.equal(step.cost, 0); assert.equal(step.reached, true); state = step.state;
    }
  }
});

test("crossing the final gap buys only its missing coverage, even when the endpoint is in an overlapping revolution", () => {
  const profile = { points: 2, degrees: 30 };
  const state = { origin: 0, last: 0, offset: -15, min: 0, max: 10 };
  const completed = planRotationSector(state, -160, profile, 2);
  assert.equal(completed.cost, 2); assert.equal(completed.reached, true);
  assert.equal(completed.rotation, -160);
  assert.equal((completed.state.max - completed.state.min + 1) * profile.degrees, 360);
  assert.equal(planRotationSector(completed.state, 10, profile, 0).reached, true);
  const blocked = planRotationSector(state, -160, profile, 0);
  assert.equal(blocked.cost, 0); assert.equal(blocked.rotation, -15); assert.equal(blocked.reached, false);
  const uneven = planRotationSector({ origin: 0, last: 0, min: 0, max: 2 }, -170, { points: 3, degrees: 100 }, 3);
  assert.equal(uneven.cost, 3); assert.equal(uneven.reached, true);
  assert.equal(planRotationSector(uneven.state, 0, { points: 3, degrees: 100 }, 0).cost, 0);
  const bounds = rotationSectorBounds(uneven.state, { points: 3, degrees: 100 });
  assert.equal(bounds.max - bounds.min, 360);
});

test("authority spends only on unique extensions and never rewrites resources during later full revolutions", async () => {
  const f = fixture();
  f.actor.flags["fallout-maw"].constructVisual.parts[0].rotationCost = { points: 2, degrees: 30 };
  await callActorTurnStartPreparedHandlers({ actor: f.actor, combat: f.combat });
  let total = 0, writes = 0;
  const update = f.actor.update.bind(f.actor);
  f.actor.update = updates => { writes++; return update(updates); };
  for (let i = 1; i <= 72; i++) {
    const angle = i * 15;
    const result = await purchaseConstructRotation(f.doc, "turret", angle, { notify: false });
    total += result.cost;
    assert.equal(result.reached, true);
    if (i >= 24) assert.equal(result.cost, 0);
    recordConstructRotationProgress(f.doc, "turret", result.rotation);
    f.doc.flags["fallout-maw"].constructVisualState = { rotations: { turret: angle } };
  }
  assert.equal(total, 22); assert.equal(writes, 11);
  assert.equal(f.actor.system.resources.movementPoints.value, 18);
  assert.equal(f.actor.system.resources.power.value, 978);
  for (let i = 71; i >= 0; i--) {
    const result = await purchaseConstructRotation(f.doc, "turret", i * 15, { notify: false });
    assert.equal(result.cost, 0); assert.equal(result.reached, true);
    recordConstructRotationProgress(f.doc, "turret", result.rotation);
    f.doc.flags["fallout-maw"].constructVisualState = { rotations: { turret: i * 15 } };
  }
  assert.equal(writes, 11);
});
