import test from "node:test";
import assert from "node:assert/strict";
import { registerConstructRotationLimits } from "../src/canvas/construct-rotation-limits.mjs";
import { registerConstructRotationTurns, purchaseConstructRotation } from "../src/constructs/rotation-actions.mjs";
import { callActorTurnStartPreparedHandlers } from "../src/combat/turn-events.mjs";

test("crew guides follow the actual turret reference, switch to the driver, and never duplicate during aiming", async t => {
  const names = ["Hooks", "PIXI", "canvas", "game"];
  const globals = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  const hooks = new Map();
  const emit = (name, ...args) => { for (const callback of hooks.get(name) ?? []) callback(...args); };
  globalThis.Hooks = { on(name, callback) { hooks.set(name, [...hooks.get(name) ?? [], callback]); } };
  class Container {
    children = [];
    addChild(child) { this.children.push(child); child.parent = this; return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
    destroy() { this.destroyed = true; }
  }
  class Graphics extends Container {
    rays = [];
    clears = 0;
    clear() { this.rays = []; this.clears++; }
    lineStyle() {}
    moveTo(x, y) { this.start = { x, y }; }
    lineTo(x, y) { this.rays.push({ start: this.start, end: { x, y } }); }
  }
  class Text extends Container {
    constructor(text) { super(); this.text = text; }
    anchor = { set() {} };
    position = { set(x, y) { this.x = x; this.y = y; } };
  }
  globalThis.PIXI = { Graphics, Text };
  const actor = { uuid: "Actor.tank", type: "construct", items: { contents: [] }, effects: [],
    flags: { "fallout-maw": { constructVisual: { enabled: true, hullRotationCost: { points: 2, degrees: 15 },
      parts: [{ id: "turret", slotId: "turret", rotates: true, rotationCost: { points: 2, degrees: 30 } }] } } },
    system: { resources: { movementPoints: { value: 40, max: 40, min: 0, once: 0 } } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async update(updates) {
      for (const [path, value] of Object.entries(updates)) {
        const keys = path.split("."); let target = this;
        for (const key of keys.slice(0, -1)) target = target[key] ??= {};
        target[keys.at(-1)] = structuredClone(value);
      }
      return this;
    } };
  const doc = { id: "tank", actor, parent: { id: "scene" }, rotation: 180, _source: { rotation: 180 },
    flags: { "fallout-maw": { constructVisualState: { rotations: { turret: -40 } } } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; } };
  const token = { controlled: true, actor, document: doc, w: 300, h: 500, center: { x: 400, y: 400 } };
  doc.object = token; actor.getActiveTokens = () => [doc];
  const combat = { id: "battle", started: true, round: 1, turn: 0, combatant: { actor }, combatants: [{ actor }] };
  globalThis.game = { user: { isGM: true }, combats: [combat], settings: { get: () => true } };
  globalThis.canvas = { controls: new Container(), tokens: { controlled: [token] } };
  let aiming = "";
  let selection = { available: true, seat: { role: "gunner", functions: ["aim"] }, partSlotId: "turret" };
  // Both negative texture axes rotate the north-facing art 180 degrees, matching this tank.
  const pose = { origin: { x: 420, y: 415 }, toWorldAngle: angle => doc.rotation + angle + 180 };
  registerConstructRotationLimits({ getSelectedContext: () => selection, getAimingSlot: () => aiming, getPartPose: () => pose });
  registerConstructRotationTurns();
  t.after(() => {
    emit("canvasTearDown");
    for (const name of names) if (globals[name] === undefined) delete globalThis[name]; else globalThis[name] = globals[name];
  });
  await callActorTurnStartPreparedHandlers({ actor, combat });
  emit("controlToken", token);
  const graphic = canvas.controls.children[0];
  const headings = () => graphic.rays.map(ray => Math.atan2(ray.end.x - ray.start.x, ray.start.y - ray.end.y) * 180 / Math.PI);
  const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-7, `${value} != ${expected}`);
  assert.equal(canvas.controls.children.length, 1);
  assert.deepEqual(graphic.children.map(label => label.text), ["2 ОП", "2 ОП"]);
  headings().forEach((value, i) => near(value, [-55, -25][i]));
  assert.deepEqual(graphic.rays[0].start, pose.origin);
  const redraws = graphic.clears;
  emit("refreshToken", token);
  assert.equal(graphic.clears, redraws, "stable guides retain their graphics without redraws");
  const paid = await purchaseConstructRotation(doc, "turret", -25, { notify: false });
  assert.equal(paid.cost, 0);
  assert.equal(actor.system.resources.movementPoints.value, 40);
  emit("updateActor", actor);
  headings().forEach((value, i) => near(value, [-55, -25][i]));
  assert.equal((await purchaseConstructRotation(doc, "turret", -54, { notify: false })).cost, 0,
    "the initial cone is free on both sides of the original barrel");
  doc.flags["fallout-maw"].constructVisualState.rotations.turret = -25;
  doc.rotation = doc._source.rotation = 270;
  emit("updateToken", doc);
  headings().forEach((value, i) => near(value, [35, 65][i]));
  assert.equal(canvas.controls.children.length, 1, "hull rotation carries the paid turret sector without changing its reference");
  selection = { available: true, seat: { role: "driver", functions: ["rotate"] } };
  emit("falloutMawConstructCrewSelection", token);
  assert.deepEqual(graphic.children.map(label => label.text), ["2 ОП", "2 ОП"]);
  assert.deepEqual(graphic.rays[0].start, token.center);
  aiming = "turret";
  emit("refreshToken", token);
  assert.deepEqual(graphic.children.map(label => label.text), ["2 ОП", "2 ОП"]);
  assert.deepEqual(graphic.rays[0].start, pose.origin);
  assert.equal(canvas.controls.children.length, 1, "direct aiming replaces the hull guides");
  aiming = ""; selection = { available: true, seat: { role: "passenger", functions: [] } };
  emit("falloutMawConstructCrewSelection", token);
  assert.equal(canvas.controls.children.length, 0);
  selection = { available: true, seat: { role: "gunner", functions: ["aim"] }, partSlotId: "turret" };
  game.combats = [];
  emit("falloutMawConstructCrewSelection", token);
  assert.equal(canvas.controls.children.length, 0, "cost guides are absent outside combat");
});
