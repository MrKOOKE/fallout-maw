import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

globalThis.foundry = { applications: { api: { DialogV2: {} }, ux: {}, handlebars: {} }, utils: {} };
globalThis.CONFIG = { Token: { movement: null }, specialStatusEffects: { INVISIBLE: "invisible" } };
const { createStealthRoutePlanner, projectStealthRoutePlan } = await import("../src/stealth/route-plan.mjs");
const { createStealthCheckBatch } = await import("../src/stealth/check-batch.mjs");
const { STEALTH_ROUTE_PLAN_OPTION } = await import("../src/canvas/movement-resume-context.mjs");
afterEach(() => { delete globalThis.canvas; });

const waypoint = (x, y = 0) => ({ x, y, elevation: 1.25, width: 1, height: 1, action: "walk" });
function fixture({ failure = false, prevent = false, prepareGate = null } = {}) {
  globalThis.canvas = { scene: { grid: { size: 300, distance: 5 } }, grid: { size: 300, distance: 5, isGridless: true } };
  const actor = { uuid: "Actor.hidden", statuses: new Set(["invisible"]) };
  const source = { actor, document: { uuid: "Token.hidden" } };
  const target = { actor: { uuid: "Actor.observer" }, document: { uuid: "Token.observer" } };
  const events = [100, 200].map((x, index) => ({
    waypoint: waypoint(x), routeOrder: index + 1, priority: 3,
    checks: [{ mode: "hiddenMoving", hiddenTokenUuid: "Token.hidden", observerTokenUuid: "Token.observer" }],
    remainingWaypoints: x === 100 ? [waypoint(200)] : []
  }));
  const collection = {
    events,
    routeSteps: [0, 100, 200].map(x => ({ waypoint: waypoint(x), point: { x: x + 150, y: 150, elevation: 1.25 } })),
    stateBaselines: new Map([["pair", { value: 0, revision: 0, pair: { hiddenToken: source, observerToken: target } }]]),
    stateTransitions: [{ key: "pair", value: 10, routeOrder: 1 }, { key: "pair", value: 20, routeOrder: 2 }],
    stateUpdates: new Map([["pair", 20]])
  };
  const calls = { collect: [], prepare: [], resolve: [], move: [], pauses: 0 };
  const token = { uuid: "Token.hidden", actor, parent: canvas.scene, x: 0, y: 0, elevation: 1.25,
    async move(waypoints, options) { calls.move.push({ waypoints, options }); return false; } };
  const planner = createStealthRoutePlanner({
    collect: context => { calls.collect.push(context); return collection; },
    prepareChecks: async checks => {
      calls.prepare.push(checks);
      if (prepareGate) await prepareGate;
      return (failure ? checks.slice(0, 1) : checks).map(check => ({ ...check, outcome: {
        actor, result: { key: failure ? "failure" : "success" }
      } }));
    },
    resolveChecks: async checks => {
      calls.resolve.push(checks);
      return checks.map(check => ({ ...check.outcome, falloutMawRevealPrevented: prevent }));
    },
    pauseGame: () => { calls.pauses++; }
  });
  const movement = { id: "root", origin: waypoint(0), destination: waypoint(100),
    passed: { waypoints: [waypoint(100)] }, pending: { waypoints: [waypoint(200)] } };
  return { planner, token, movement, calls, collection };
}

test("all pending-route checks finish before movement; successful chunks reuse geometry", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ prepareGate: gate });
  const preflight = f.planner.collect({ tokenDocument: f.token, movement: f.movement, options: {} }).events[0];
  assert.equal(preflight.moveToWaypoint, false);
  assert.equal(f.calls.collect[0].collectAll, true);
  assert.deepEqual(f.calls.collect[0].movement.passed.waypoints.map(p => p.x), [100, 200]);
  const execution = f.planner.execute({ tokenDocument: f.token, movement: f.movement, event: preflight, isCurrent: () => true });
  await Promise.resolve();
  assert.equal(f.calls.move.length, 0);
  assert.deepEqual(f.calls.prepare[0].map(c => c.sourcePosition.x), [100, 200]);
  release();
  await execution;
  assert.equal(f.calls.move.length, 1);
  assert.equal(f.calls.resolve.length, 0, "detection effects have not run at the origin");
  const options = f.calls.move[0].options;
  const first = { ...f.movement, id: "first" };
  const firstResult = f.planner.collect({ tokenDocument: f.token, movement: first, options });
  assert.equal(firstResult.events.length, 0);
  assert.equal(firstResult.stateUpdates.get("pair"), 10);
  await f.planner.synchronize({ tokenDocument: f.token, movement: first, options });
  const second = { id: "second", chain: ["first"], origin: waypoint(100), destination: waypoint(200),
    passed: { waypoints: [waypoint(200)] }, pending: { waypoints: [] } };
  const secondOptions = {};
  const secondResult = f.planner.collect({ tokenDocument: f.token, movement: second, options: secondOptions });
  assert.equal(secondResult.stateUpdates.get("pair"), 20);
  assert.equal(secondOptions[STEALTH_ROUTE_PLAN_OPTION], options[STEALTH_ROUTE_PLAN_OPTION]);
  assert.equal(f.calls.collect.length, 1);
  assert.equal(f.calls.prepare.length, 1);
  await f.planner.synchronize({ tokenDocument: f.token, movement: second, options: secondOptions });
  assert.equal(f.calls.resolve.flat().length, 2);
});

test("failed preflight creates an interruption at the detection point and applies failure there", async () => {
  const f = fixture({ failure: true });
  const preflight = f.planner.collect({ tokenDocument: f.token, movement: f.movement }).events[0];
  await f.planner.execute({ tokenDocument: f.token, movement: f.movement, event: preflight, isCurrent: () => true });
  assert.equal(f.calls.pauses, 0);
  const options = f.calls.move[0].options;
  const chunk = { ...f.movement, id: "accepted" };
  const result = f.planner.collect({ tokenDocument: f.token, movement: chunk, options });
  assert.equal(result.events[0].waypoint.x, 100);
  assert.equal(result.stateUpdates.get("pair"), 10);
  assert.equal(await f.planner.execute({ tokenDocument: f.token, movement: chunk, event: result.events[0], options,
    isCurrent: () => true, nativeMovementPaused: true }), false);
  assert.equal(f.calls.pauses, 1);
  assert.equal(f.calls.prepare.length, 1, "failure is not rerolled");
});

test("reveal prevention invalidates the unrolled suffix before native continuation", async () => {
  const f = fixture({ failure: true, prevent: true });
  const preflight = f.planner.collect({ tokenDocument: f.token, movement: f.movement }).events[0];
  await f.planner.execute({ tokenDocument: f.token, movement: f.movement, event: preflight, isCurrent: () => true });
  const options = f.calls.move[0].options;
  const event = f.planner.collect({ tokenDocument: f.token, movement: f.movement, options }).events[0];
  assert.equal(await f.planner.execute({ tokenDocument: f.token, movement: f.movement, event, options,
    isCurrent: () => true, nativeMovementPaused: true }), true);
  assert.equal(f.calls.pauses, 0);
  f.planner.collect({ tokenDocument: f.token, movement: { ...f.movement, id: "resume", chain: ["root"] }, options: {} });
  assert.equal(f.calls.collect.length, 2);
});

test("superseded preparation never starts movement", async () => {
  const f = fixture();
  const event = f.planner.collect({ tokenDocument: f.token, movement: f.movement }).events[0];
  await f.planner.execute({ tokenDocument: f.token, movement: f.movement, event, isCurrent: () => false });
  assert.equal(f.calls.move.length, 0);
});

test("loop projections retain route order and reject geometry outside the plan", () => {
  const f = fixture();
  const points = [waypoint(0), waypoint(100), waypoint(0), waypoint(200)];
  const plan = { collection: { ...f.collection, events: [], stateTransitions: [
    { key: "pair", value: 1, routeOrder: 1 }, { key: "pair", value: 2, routeOrder: 2 }, { key: "pair", value: 3, routeOrder: 3 }
  ], routeSteps: points.map(waypoint => ({ waypoint })) }, cursor: 0, projections: new WeakMap() };
  const loop = { origin: points[0], destination: points[2], passed: { waypoints: [points[1], points[2]] } };
  const projected = projectStealthRoutePlan(plan, f.token, loop);
  assert.equal(projected.planEnd, 2);
  assert.equal(projected.stateUpdates.get("pair"), 2);
  const changed = { origin: points[0], destination: waypoint(0, 100), passed: { waypoints: [waypoint(0, 100)] } };
  assert.equal(projectStealthRoutePlan(plan, f.token, changed), null);
});

test("batch groups successful checks by audience and actor", async () => {
  const groups = [];
  const batch = createStealthCheckBatch({
    successMessageData: actor => ({ whisper: [actor.uuid], includeRolls: false }),
    isSuccess: outcome => outcome.result.key === "success",
    createCollector: options => {
      const group = { options, checks: [], published: false };
      groups.push(group);
      return {
        deferTerminal(outcome) { group.checks.push(outcome); },
        async publish() { group.published = true; }
      };
    }
  });
  for (const [id, key] of [["A", "success"], ["A", "success"], ["A", "failure"], ["B", "success"]]) {
    batch.deferTerminal({ actor: { uuid: id }, result: { key } }, () => Promise.resolve());
  }
  await batch.publish();
  assert.deepEqual(groups.map(g => g.checks.length), [2, 1, 1]);
  assert.deepEqual(groups.map(g => g.options.messageData), [
    { whisper: ["A"], includeRolls: false }, {}, { whisper: ["B"], includeRolls: false }
  ]);
  assert.ok(groups.every(g => g.published));
});
