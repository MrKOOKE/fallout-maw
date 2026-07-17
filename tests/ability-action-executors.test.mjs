import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    randomID: () => "test-id"
  }
};

const {
  ABILITY_ACTION_EXECUTOR_MODES,
  ABILITY_ACTION_ROUTE_BUDGET_MODES,
  ABILITY_ACTION_TYPES,
  createAbilityAction,
  normalizeAbilityAction
} = await import("../src/settings/abilities.mjs");
const {
  resolveNativeMovementPath,
  stopAbilityMovementRoutePreviews
} = await import("../src/canvas/ability-movement-route.mjs");
const {
  applyCombatMovementCostModifier,
  getRawMovementCostLimit
} = await import("../src/combat/movement-resources.mjs");
const {
  clearAbilityRoutePreviewStop,
  consumeAbilityRoutePreviewStop,
  markAbilityRoutePreviewStop
} = await import("../src/canvas/ability-route-preview-state.mjs");
const { createActorOperationLock } = await import("../src/utils/actor-operation-lock.mjs");
const {
  trackSystemMovementOperation,
  waitForSystemMovementSettlement
} = await import("../src/canvas/movement-settlement.mjs");

function movementSource(overrides = {}) {
  return {
    x: 0,
    y: 0,
    elevation: 0,
    width: 1,
    height: 1,
    depth: 1,
    shape: 0,
    level: "ground",
    ...overrides
  };
}

function explicitMovementWaypoint(overrides = {}) {
  return {
    ...movementSource(),
    action: "walk",
    snapped: false,
    explicit: true,
    checkpoint: true,
    ...overrides
  };
}

test("legacy actions default to the source actor executor", () => {
  const action = normalizeAbilityAction({ type: ABILITY_ACTION_TYPES.weaponAttack });
  assert.equal(action.executorMode, ABILITY_ACTION_EXECUTOR_MODES.source);
});

test("constructor preserves target actors as weapon-action executors", () => {
  const action = normalizeAbilityAction({
    ...createAbilityAction(ABILITY_ACTION_TYPES.weaponAttack),
    executorMode: ABILITY_ACTION_EXECUTOR_MODES.targets
  });
  assert.equal(action.executorMode, ABILITY_ACTION_EXECUTOR_MODES.targets);
});

test("movement routes use Foundry pathfinding and measure from the token origin", async () => {
  const tokenDocument = {
    _source: movementSource({
      x: 100,
      y: 200,
      elevation: 0
    }),
    movementAction: "walk"
  };
  let pathfindingCall = null;
  let measuredWaypoints = null;
  const tokenObject = {
    findMovementPath: (waypoints, options) => {
      pathfindingCall = { waypoints, options };
      return { result: waypoints.map(waypoint => ({ ...waypoint })) };
    },
    measureMovementPath: (waypoints, options) => {
      measuredWaypoints = { waypoints, options };
      return { distance: 12, cost: 12 };
    }
  };

  const result = await resolveNativeMovementPath(
    tokenObject,
    tokenDocument,
    [explicitMovementWaypoint({ x: 300, y: 400 })],
    "walk",
    { preview: true }
  );

  assert.equal(result.ok, true);
  assert.equal(result.distance, 12);
  assert.deepEqual(
    pathfindingCall.waypoints.map(({ x, y }) => ({ x, y })),
    [{ x: 100, y: 200 }, { x: 300, y: 400 }]
  );
  assert.equal(pathfindingCall.options.preview, true);
  assert.deepEqual(measuredWaypoints.waypoints.map(({ x, y }) => ({ x, y })), [
    { x: 100, y: 200 },
    { x: 300, y: 400 }
  ]);
  assert.equal(measuredWaypoints.options.preview, true);
});

test("movement routes reject a native path that cannot reach its requested endpoint", async () => {
  const tokenDocument = {
    _source: movementSource(),
    movementAction: "walk"
  };
  const tokenObject = {
    findMovementPath: waypoints => ({ result: [waypoints[0], { ...waypoints[1], x: 50 }] }),
    measureMovementPath: () => {
      throw new Error("An unreachable route must not be measured.");
    }
  };

  const result = await resolveNativeMovementPath(
    tokenObject,
    tokenDocument,
    [explicitMovementWaypoint({ x: 100, y: 0 })]
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
});

test("movement routes require every explicit waypoint in order", async () => {
  const tokenDocument = {
    _source: movementSource(),
    movementAction: "walk"
  };
  const tokenObject = {
    findMovementPath: waypoints => ({ result: [waypoints[0], waypoints.at(-1)] }),
    measureMovementPath: () => {
      throw new Error("A path which skipped an explicit waypoint must not be measured.");
    }
  };
  const result = await resolveNativeMovementPath(tokenObject, tokenDocument, [
    explicitMovementWaypoint({ x: 50, y: 50 }),
    explicitMovementWaypoint({ x: 100, y: 0 })
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
});

test("native movement planning converts an adjusted OP budget back to raw Foundry cost", () => {
  const actor = {
    effects: [{
      disabled: false,
      changes: [{ key: "system.costs.movement", type: "override", value: "2" }]
    }]
  };
  assert.equal(applyCombatMovementCostModifier(actor, 4), 8);
  assert.equal(getRawMovementCostLimit(actor, 8), 4);
  assert.equal(getRawMovementCostLimit(actor, 7), 3);
  assert.equal(getRawMovementCostLimit(actor, Infinity), Infinity);
});

test("movement routes reject waypoint fields which attempt an undeclared resize or action change", async () => {
  const tokenDocument = {
    _source: movementSource({
      x: 0,
      y: 0,
      elevation: 2,
      height: 2,
      level: "ground"
    }),
    movementAction: "walk"
  };
  let received;
  const tokenObject = {
    findMovementPath: waypoints => {
      received = waypoints;
      return { result: waypoints.map(waypoint => ({ ...waypoint })) };
    },
    measureMovementPath: () => ({ distance: 1, cost: 1 })
  };
  const result = await resolveNativeMovementPath(tokenObject, tokenDocument, [{
    ...explicitMovementWaypoint({ x: 100, y: 50 }),
    elevation: 999,
    width: 99,
    height: 99,
    depth: 99,
    level: "other",
    action: "displace",
    shape: 0
  }], "walk");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalidWaypoint");
  assert.equal(received, undefined);
});

test("movement routes preserve native elevation and checkpoint semantics", async () => {
  const source = movementSource({ elevation: 2, height: 2 });
  const tokenDocument = { _source: source, movementAction: "walk" };
  let received;
  const tokenObject = {
    findMovementPath: waypoints => {
      received = waypoints;
      return { result: waypoints.map(waypoint => ({ ...waypoint })) };
    },
    measureMovementPath: () => ({ distance: 5, cost: 5 })
  };
  const waypoint = explicitMovementWaypoint({ ...source, x: 100, y: 50, elevation: 7 });
  const result = await resolveNativeMovementPath(tokenObject, tokenDocument, [waypoint], "walk");
  assert.equal(result.ok, true);
  assert.equal(received[1].elevation, 7);
  assert.equal(received[1].checkpoint, true);
  assert.equal(received[1].explicit, true);
});

test("movement-route actions retain constructor defaults and use native path measurement", async () => {
  const action = normalizeAbilityAction({
    type: ABILITY_ACTION_TYPES.movementRoute,
    routeBudgetMode: ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost,
    routeBudgetFormula: "2+speech/25",
    routeBudgetEvaluation: "source",
    routeExecutionMode: "sequential",
    routeShowRuler: false
  });
  assert.equal(action.type, ABILITY_ACTION_TYPES.movementRoute);
  assert.equal(action.routeBudgetMode, ABILITY_ACTION_ROUTE_BUDGET_MODES.movementCost);
  assert.equal(action.routeBudgetFormula, "2+speech/25");
  assert.equal(action.routeBudgetEvaluation, "source");
  assert.equal(action.actionPointCostMode, "none");
  assert.equal(action.fixedActionPointCost, 0);
  assert.equal(action.routeExecutionMode, "sequential");
  assert.equal(action.routeShowRuler, false);

  const document = {
    _source: movementSource(),
    actor: { uuid: "Actor.route" }
  };
  const token = {
    findMovementPath: points => ({ result: points.map(point => ({ ...point })) }),
    measureMovementPath: points => ({
      distance: points.reduce((total, point, index) => {
        const previous = index ? points[index - 1] : { x: 0, y: 0 };
        return total + Math.hypot(point.x - previous.x, point.y - previous.y);
      }, 0),
      cost: 50
    })
  };
  document.rendered = true;
  document.object = token;
  const result = await resolveNativeMovementPath(
    token,
    document,
    [explicitMovementWaypoint({ x: 30, y: 40 })]
  );
  assert.equal(result.ok, true);
  assert.equal(result.distance, 50);
  assert.deepEqual(result.path.map(point => [point.x, point.y]), [[0, 0], [30, 40]]);
});

test("the Item data schema persists every movement-route constructor field", () => {
  const source = fs.readFileSync(new URL(
    "../src/data/models/item-data-models.mjs",
    import.meta.url
  ), "utf8");
  assert.match(source, /choices: \["", "weaponAttack", "movementRoute"\]/);
  for (const field of [
    "actionPointPayer",
    "routeBudgetMode",
    "routeBudgetFormula",
    "routeBudgetEvaluation",
    "routeDistanceFormula",
    "routeDistanceEvaluation",
    "routeExecutionMode",
    "routeMovementAction",
    "routeAutoRotate",
    "routeShowRuler"
  ]) {
    assert.match(source, new RegExp(`\\b${field}: new `));
  }
});

test("command abilities are delivered by a one-off builder macro, not a startup migration", () => {
  const macro = fs.readFileSync(new URL(
    "../scripts/ability-builders/01-command-orders.js",
    import.meta.url
  ), "utf8");
  const registration = fs.readFileSync(new URL("../src/settings/registration.mjs", import.meta.url), "utf8");
  assert.match(macro, /o0eHtaXDOfkfOP4M/);
  assert.match(macro, /hXDOkMGJjkPB7WBb/);
  assert.match(macro, /executorMode:\s*"targets"/);
  assert.match(macro, /attackActionKeys:\s*\[actionKey\]/);
  assert.doesNotMatch(registration, /migrateSystemSettings/);
  assert.equal(fs.existsSync(new URL("../src/migrations/settings.mjs", import.meta.url)), false);
});

test("command reposition is assembled by a one-off movement-route builder", () => {
  const macro = fs.readFileSync(new URL(
    "../scripts/ability-builders/02-command-reposition.js",
    import.meta.url
  ), "utf8");
  assert.match(macro, /u6NqPLJYeinNzWNF/);
  assert.match(macro, /type:\s*"movementRoute"/);
  assert.match(macro, /executorMode:\s*"targets"/);
  assert.match(macro, /resourceKey:\s*"actionPoints"[\s\S]*?payer:\s*"targets"/);
  assert.match(macro, /actionPointCostMode:\s*"none"/);
  assert.match(macro, /fixedActionPointCost:\s*0/);
  assert.match(macro, /routeExecutionMode:\s*"sequential"/);
  assert.match(macro, /routeBudgetMode:\s*"movementCost"/);
  assert.match(macro, /routeBudgetFormula:\s*`2\+\$\{speechVariable\}\/25`/);
  assert.match(macro, /targetGroups:\s*\["ally"\]/);
  assert.match(macro, /category\.abilities\.splice\(abilityIndex, 1, rebuilt\)/);
  assert.match(macro, /speechCategory\.abilities\.push\(rebuilt\)/);
});

test("movement routes use generic activation reservations and never spend an action-specific resource", () => {
  const source = fs.readFileSync(new URL(
    "../src/abilities/ability-actions.mjs",
    import.meta.url
  ), "utf8");
  const handlerStart = source.indexOf("async function handleAbilityActionMovementQuery");
  const handlerEnd = source.indexOf("function notifyMovementRouteExecutionFailure", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.match(handler, /!actor\.isOwner/);
  assert.match(handler, /!tokenDocument\?\.isOwner/);
  assert.match(handler, /movementRouteActorLock\.run\(actor, scope\.chainRef, async \(\) => \{/);
  assert.match(source, /resourceReservations = new Map\(\)/);
  assert.match(source, /getReservedResourceAmount\(vector, "movementPoints"\)/);
  assert.match(source, /getReservedResourceAmount\(vector, state\.action\?\.key\)/);
  assert.match(source, /preflightPreparedMovementRouteResources\(executions, resourceReservations\)/);
  assert.match(source, /function getPreparedWeaponActionPointCost/);
  assert.match(source, /function getPreparedActionPointAvailability/);
  assert.match(source, /movementPaidWithAction = Math\.max\(0, movementCost - availableMovement\)/);
  assert.match(source, /function preflightPreparedActionResources/);
  assert.match(source, /requiredAction = movementPaidWithAction \+ action/);
  assert.match(source, /preflightPreparedActionResources\(executions, resourceReservations\)/);
  const prepareStart = source.indexOf("export async function prepareAbilityFunctionActions");
  const prepareEnd = source.indexOf("function evaluateRouteBudget", prepareStart);
  const prepare = source.slice(prepareStart, prepareEnd);
  assert.ok(prepare.indexOf("availableMovementCost") < prepare.indexOf("requestAbilityMovementRoute"));
  assert.match(prepare, /Math\.min\(configuredMaxBudget, availableMovementCost\)/);
  assert.match(prepare, /resourceBudget:\s*availableMovementCost/);
  assert.match(prepare, /const routedTokenUuids = new Set\(\)/);
  assert.match(prepare, /reason:\s*"duplicateMovementRouteExecutor"/);
  assert.doesNotMatch(prepare, /preparedMovementRouteOrigins|preparedMovementRouteHistories/);
  assert.doesNotMatch(source, /spendMovementRouteActionPointCosts/);
  assert.doesNotMatch(source, /spendOwnedMovementRouteActionPoints/);
  assert.doesNotMatch(source, /source:\s*"abilityMovementRoute"/);
  assert.doesNotMatch(handler, /actionPointCost|actionPointPayer/);
  assert.match(source, /executorUnableToAct/);
});

test("movement route queries authenticate their sender, construct and scene authority", () => {
  const source = fs.readFileSync(new URL(
    "../src/abilities/ability-actions.mjs",
    import.meta.url
  ), "utf8");
  const prepareStart = source.indexOf("export async function prepareAbilityFunctionActions");
  const prepareEnd = source.indexOf("function evaluateRouteBudget", prepareStart);
  const executorStart = source.indexOf("async function executeAbilityMovementRouteExecution");
  const validatorStart = source.indexOf("async function validateMovementAbilityAuthority", executorStart);
  const handlerStart = source.indexOf("async function handleAbilityActionMovementQuery", validatorStart);
  const handlerEnd = source.indexOf("function notifyMovementRouteExecutionFailure", handlerStart);
  assert.ok(prepareStart >= 0 && executorStart >= 0 && validatorStart > executorStart && handlerStart > validatorStart);
  const prepare = source.slice(prepareStart, prepareEnd);
  const executor = source.slice(executorStart, validatorStart);
  const validator = source.slice(validatorStart, handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.match(source, /function getMovementRouteAuthority/);
  assert.match(source, /user\?\.active[\s\S]*?user\.viewedScene[\s\S]*?includedInLevel/);
  assert.match(source, /actor\.testUserPermission\?\.\(user, "OWNER"\)/);
  assert.ok(prepare.indexOf("getMovementRouteAuthority") < prepare.indexOf("requestAbilityMovementRoute"));
  assert.match(executor, /const owner = getMovementRouteAuthority\(actor, tokenDocument\)/);
  assert.doesNotMatch(executor, /getResponsibleOwner/);
  assert.match(executor, /actionId:[\s\S]*?authorityContext/);
  assert.match(executor, /handleAbilityActionMovementQuery\(data, \{ user: game\.user \}\)/);
  assert.match(source, /const executionPairs = executions\.map\([\s\S]*?targetTokenUuid/);

  assert.match(source, /async function handleAbilityActionMovementQuery\(data = \{\}, \{ user: sender = null \} = \{\}\)/);
  assert.match(handler, /validateMovementAbilityAuthority\(data, sender/);
  assert.ok(handler.indexOf("validateMovementAbilityAuthority") < handler.indexOf("movementRouteActorLock.run"));
  assert.match(handler, /!tokenDocument\.rendered/);
  assert.match(validator, /testUserPermission\?\.\(sender, "OWNER"\)/);
  assert.match(validator, /abilityItem\.type !== "ability"/);
  assert.match(validator, /JSON\.stringify\(abilityFunction\)/);
  assert.match(validator, /ABILITY_ACTION_TYPES\.movementRoute/);
  assert.match(validator, /normalizeActiveApplicationSettings/);
  assert.match(validator, /getAuraRelation/);
  assert.match(validator, /measureTokenDistanceMeters/);
  assert.match(validator, /hasAuraLineOfSight/);
  assert.match(validator, /evaluateRouteBudget/);
  assert.match(validator, /routeBudgetMode/);
  assert.match(validator, /expectedMaxBudget/);
  assert.doesNotMatch(validator, /getConfiguredRouteActionPointCost/);
  assert.match(validator, /pairKeys\.includes/);
});

test("actor operation locks re-enter the same root but serialize independent roots", async () => {
  const lock = createActorOperationLock();
  const actor = { uuid: "Actor.lock" };
  const order = [];
  let release;
  let markStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const first = lock.run(actor, { rootId: "root-1" }, async () => {
    order.push("first-start");
    markStarted();
    await gate;
    order.push("first-end");
  });
  await started;

  const reentrant = lock.run(actor, { rootId: "root-1" }, async () => {
    order.push("reentrant");
  });
  const independent = lock.run(actor, { rootId: "root-2" }, async () => {
    order.push("independent");
  });

  await reentrant;
  assert.deepEqual(order, ["first-start", "reentrant"]);
  release();
  await Promise.all([first, independent]);
  assert.deepEqual(order, ["first-start", "reentrant", "first-end", "independent"]);
});

test("movement settlement waits for transitively resumed hook operations", async () => {
  const token = { uuid: "Scene.test.Token.settlement" };
  let releaseFirst;
  let releaseSecond;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  const second = new Promise(resolve => { releaseSecond = resolve; });
  trackSystemMovementOperation(token, first.then(() => {
    trackSystemMovementOperation(token, second);
  }));
  const settled = waitForSystemMovementSettlement(token, { timeoutMs: 5000 });
  releaseFirst();
  await Promise.resolve();
  let finished = false;
  void settled.then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(finished, false);
  releaseSecond();
  assert.deepEqual(await settled, {
    settled: true,
    handled: true,
    outcomes: [undefined, undefined],
    completed: false
  });
});

test("movement settlement distinguishes wait-only events from a successful resume", async () => {
  const waitOnlyToken = { uuid: "Scene.test.Token.wait-only" };
  let releaseWaitOnly;
  trackSystemMovementOperation(waitOnlyToken, new Promise(resolve => { releaseWaitOnly = resolve; }));
  const waitOnlySettlement = waitForSystemMovementSettlement(waitOnlyToken, { timeoutMs: 5000 });
  await Promise.resolve();
  releaseWaitOnly({ status: "dispatched" });
  const waitOnly = await waitOnlySettlement;
  assert.equal(waitOnly.completed, false);

  const resumedToken = { uuid: "Scene.test.Token.resumed" };
  let releaseResume;
  trackSystemMovementOperation(
    resumedToken,
    new Promise(resolve => { releaseResume = resolve; }),
    { contributesToCompletion: true }
  );
  const resumedSettlement = waitForSystemMovementSettlement(resumedToken, { timeoutMs: 5000 });
  await Promise.resolve();
  releaseResume(true);
  const resumed = await resumedSettlement;
  assert.equal(resumed.completed, true);
});

test("commanded attacks use simultaneous rays and broadcast their previews", () => {
  const source = fs.readFileSync(new URL(
    "../src/combat/weapon-attack-controller.mjs",
    import.meta.url
  ), "utf8");
  assert.match(source, /entries\.every\(canUseCommandedMultiRayCapture\)/);
  assert.match(source, /startCommandedMultiRayAttacksAndWait/);
  assert.match(source, /onBeforeExecute\(selections\)/);
  assert.match(source, /broadcastPreviews\(force = false\)/);
  assert.match(source, /action:\s*"updatePreview"/);
  assert.match(source, /action:\s*"clearPreview"/);
  assert.match(source, /reportedActionPointCost:\s*authorityContext\s*\?\s*selection\.actionPointCost\s*:\s*null/);
});

test("right click unwinds canvas selections before cancelling their workflow", () => {
  const tokenSelection = fs.readFileSync(new URL(
    "../src/canvas/custom-token-selection.mjs",
    import.meta.url
  ), "utf8");
  const movementRoutes = fs.readFileSync(new URL(
    "../src/canvas/ability-movement-route.mjs",
    import.meta.url
  ), "utf8");
  const weaponAttacks = fs.readFileSync(new URL(
    "../src/combat/weapon-attack-controller.mjs",
    import.meta.url
  ), "utf8");

  assert.match(tokenSelection, /const undoLastSelection = \(\) => \{[\s\S]*?Array\.from\(selected\)\.at\(-1\)[\s\S]*?selected\.delete\(selectionId\)[\s\S]*?drawCustomTokenSelectionRows/);
  assert.match(tokenSelection, /rightClickCandidate = null;\s*if \(undoLastSelection\(\)\) return;\s*finish\(\[\]\)/);
  assert.match(tokenSelection, /else if \(selected\.size < selectionLimit\) selected\.add\(row\.selectionId\);/);
  assert.match(tokenSelection, /if \(selected\.size >= selectionLimit\) confirm\(\)/);
  assert.match(movementRoutes, /tokenObject\.planAbilityMovement\(\{/);
  assert.match(movementRoutes, /document\.addEventListener\("pointerdown", onPointerDown, \{ capture: true \}/);
  assert.match(movementRoutes, /tokenObject\._addDragWaypoint\(point/);
  assert.match(movementRoutes, /extractExplicitRouteCheckpoints\(/);
  assert.doesNotMatch(movementRoutes, /pendingWaypoints|onContextMenu/);

  const commandedStart = weaponAttacks.indexOf("class CommandedWeaponAttackController");
  const ordinaryStart = weaponAttacks.indexOf("class WeaponAttackController", commandedStart + 1);
  assert.ok(commandedStart >= 0 && ordinaryStart > commandedStart);
  const commanded = weaponAttacks.slice(commandedStart, ordinaryStart);
  const commandedPointerDown = commanded.slice(
    commanded.indexOf("  onPointerDown(event)"),
    commanded.indexOf("  onCancel(event)")
  );
  assert.match(commandedPointerDown, /lockEntry\(entry\)[\s\S]*?entries\.every\(candidate => candidate\.locked\)[\s\S]*?this\.execute\(\)/);
  assert.match(commanded, /onKeyDown\(event\)[\s\S]*?event\.key !== "Escape"[\s\S]*?return this\.cancel\(\)/);
  assert.doesNotMatch(commanded, /Enter подтверждает|event\.key === "Enter"/);
  assert.match(commanded, /unlockLastEntry\(\)[\s\S]*?entries\.findLast\(candidate => candidate\.locked\)[\s\S]*?entry\.locked = false[\s\S]*?broadcastPreviews\(true\)/);
  assert.match(commanded, /rightClickCancelCandidate = null;\s*if \(this\.unlockLastEntry\(\)\) return false;[\s\S]*?return false;/);
  assert.match(commanded, /this\.onCancelled = typeof onCancel === "function" \? onCancel : null/);
  assert.doesNotMatch(commanded, /this\.onCancel =/);
  const commandedCancel = commanded.slice(
    commanded.indexOf("  onCancel(event)"),
    commanded.indexOf("  startRightClickCancelCandidate(event)")
  );
  assert.doesNotMatch(commandedCancel, /this\.cancel\(\)/);
  assert.match(commanded, /rightClickCancelCandidate\?\.dragged \|\| \(manager\?\._dragRight && manager\?\.state >= 4\)/);

  const ordinary = weaponAttacks.slice(ordinaryStart);
  const ordinaryCancel = ordinary.slice(
    ordinary.indexOf("  onCancel(event)"),
    ordinary.indexOf("  startRightClickCancelCandidate(event)")
  );
  assert.match(ordinaryCancel, /pushStrengthMaximum[\s\S]*?cancelPushStrengthSelection\(\)[\s\S]*?targetedAction[\s\S]*?unlockAimedTarget\(\)[\s\S]*?cancelWeaponAttack/);
  assert.match(ordinary, /rightClickCancelCandidate\?\.dragged \|\| \(manager\?\._dragRight && manager\?\.state >= 4\)/);
});

test("movement route previews use native Token drag visuals, socket-retained plans and gated resumes", () => {
  const routeSource = fs.readFileSync(new URL(
    "../src/canvas/ability-movement-route.mjs",
    import.meta.url
  ), "utf8");
  const movementEvents = fs.readFileSync(new URL(
    "../src/events/foundry-movement-events.mjs",
    import.meta.url
  ), "utf8");
  const movementResources = fs.readFileSync(new URL(
    "../src/combat/movement-resources.mjs",
    import.meta.url
  ), "utf8");
  const abilityActions = fs.readFileSync(new URL(
    "../src/abilities/ability-actions.mjs",
    import.meta.url
  ), "utf8");
  const tokenRuler = fs.readFileSync(new URL(
    "../src/canvas/token-ruler.mjs",
    import.meta.url
  ), "utf8");
  const tokenSource = fs.readFileSync(new URL(
    "../src/canvas/token.mjs",
    import.meta.url
  ), "utf8");
  const main = fs.readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");

  const requestStart = routeSource.indexOf("export async function requestAbilityMovementRoute");
  const requestEnd = routeSource.indexOf("export async function resolveNativeMovementPath", requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  const requestRoute = routeSource.slice(requestStart, requestEnd);
  assert.match(requestRoute, /const planning = tokenObject\.planAbilityMovement\(\{/);
  assert.match(requestRoute, /tokenObject\.startMovementPlanningDrag\?\.\(\)/);
  assert.match(requestRoute, /allowedActions:\s*\[action\]/);
  assert.match(requestRoute, /maxCost:\s*Infinity/);
  assert.match(requestRoute, /maxDistance:\s*Infinity/);
  assert.match(requestRoute, /preventDrop:\s*false/);
  assert.match(requestRoute, /planAuthority\.retain\(\{/);
  assert.match(requestRoute, /if \(commitPromise && !\(await commitPromise\)\) nativePlan = null/);
  assert.match(requestRoute, /moveOptions:\s*\{[\s\S]*?showRuler/);
  assert.match(requestRoute, /\[ABILITY_ROUTE_PREVIEW_MOVEMENT_OPTION\]:\s*true/);
  assert.match(requestRoute, /nativePlanId:\s*String\(nativePlan\?\.id/);
  assert.match(requestRoute, /origin:\s*copyWaypoint\(nativePlan\.origin\)/);
  assert.match(requestRoute, /waypoints:\s*nativePlan\.waypoints/);
  assert.match(requestRoute, /destination:\s*copyWaypoint\(nativePlan\.destination\)/);
  assert.doesNotMatch(requestRoute, /canvas(?:\?\.|\.)controls(?:\?\.|\.)ruler|CanvasRuler|updateNativeCanvasRulerPreview/);
  const cleanupStart = routeSource.indexOf("export async function stopAbilityMovementRoutePreviews");
  const cleanupEnd = routeSource.indexOf("\nexport ", cleanupStart + 1);
  assert.ok(cleanupStart >= 0);
  const cleanupPreviews = routeSource.slice(cleanupStart, cleanupEnd >= 0 ? cleanupEnd : undefined);
  assert.match(cleanupPreviews, /tokenDocument\?*\.stopMovement\(\)/);
  assert.doesNotMatch(cleanupPreviews, /_cancelMovementPlanning|_plannedMovement|plannedMovements/);
  assert.doesNotMatch(main, /CONFIG\.Canvas\.rulerClass\s*=/);
  assert.doesNotMatch(routeSource, /_plannedMovement|plannedMovements|renderFlags/);
  assert.doesNotMatch(tokenRuler, /_plannedMovement/);
  assert.match(tokenRuler, /rulerData\?\.plannedMovement/);
  assert.match(tokenRuler, /getAbilityRoutePreviewBudget/);
  assert.match(tokenRuler, /getAbilityRoutePreviewBudget\(this\.token/);
  assert.match(tokenRuler, /context\.abilityRouteBudget\s*=\s*\{/);
  assert.match(tokenRuler, /context\.abilityRouteBudget\s*=\s*\{[\s\S]*?used:[\s\S]*?total:/);
  assert.match(tokenRuler, /unit:\s*preview\.mode\s*===\s*ABILITY_ROUTE_BUDGET_MODES\.distance[\s\S]*?:\s*"\u041e\u041f"/);
  assert.match(tokenRuler, /context\.abilityRouteResourceBudget\s*=\s*\{/);
  assert.match(tokenSource, /planAbilityMovement\(\{/);
  assert.doesNotMatch(tokenSource.slice(
    tokenSource.indexOf("  planAbilityMovement("),
    tokenSource.indexOf("  startMovementPlanningDrag(")
  ), /panCanvas\(|\.control\(/);
  assert.match(tokenSource, /this\.layer\.options\.controllableObjects = false/);
  assert.match(tokenSource, /softReleaseAbilityRouteDrag\(this\)/);
  assert.match(tokenSource, /syncAbilityRouteDragDestination\(this\)/);
  assert.match(tokenSource, /waitForAbilityRoutePathReady\(context\)/);
  assert.match(tokenSource, /_onClickLeft\(event\)[\s\S]*?isAbilityRoutePlanningInteractive\(this\)[\s\S]*?_addDragWaypoint[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(movementEvents, /Hooks\.on\("updateToken", onAbilityRoutePreviewPlanUpdate\)/);
  assert.match(movementEvents, /function onStopToken\(tokenDocument\) \{\s*if \(consumeAbilityRoutePreviewStop/);
  assert.doesNotMatch(routeSource, /new PIXI\.Graphics|drawRouteGraphics/);
  const resumeStart = movementEvents.indexOf("function getMovementResumeWaypoints");
  const resumeEnd = movementEvents.indexOf("function serializeWaypoint", resumeStart);
  assert.ok(resumeStart >= 0 && resumeEnd > resumeStart);
  assert.doesNotMatch(movementEvents.slice(resumeStart, resumeEnd), /new Set\(/);
  assert.match(movementResources, /tokenDocument\?\.movementHistory/);
  assert.match(movementResources, /total - prefixCost/);
  assert.match(abilityActions, /hasTokenDocumentPositionChanged\(tokenDocument, plannedOrigin\)/);
  assert.match(abilityActions, /resolveNativeMovementPath\([\s\S]*?explicitWaypoints[\s\S]*?preview: false/);
  assert.match(abilityActions, /isResolvedRouteWithinBudget\(revalidated, budgetMode, maxBudget\)/);
  assert.match(abilityActions, /finalValidation\.movementCost/);
  assert.match(abilityActions, /planned:\s*true/);
  assert.match(abilityActions, /tokenDocument\.startMovement\(movementId\)/);
  assert.doesNotMatch(abilityActions, /spendMovementRouteActionPointCosts/);
  assert.doesNotMatch(abilityActions, /rollbackOwnedMovementRouteActionPoints/);
  assert.doesNotMatch(abilityActions, /data\.waypoints/);
  assert.doesNotMatch(abilityActions, /"system\.resources\.actionPoints\.value": before\.current/);
});

test("movement route preview cleanup stops every retained native plan", async () => {
  const stopped = [];
  const previousGame = globalThis.game;
  globalThis.game = { user: { id: "self" } };
  const routes = ["alpha", "beta", "gamma"].map(id => ({
    nativePlanId: `plan-${id}`,
    tokenDocument: {
      uuid: `Scene.test.Token.${id}`,
      movement: {
        id: `plan-${id}`,
        state: "planned",
        userId: "self",
        user: { id: "self", isSelf: true }
      },
      async stopMovement() {
        stopped.push(id);
      }
    }
  }));
  routes.push({
    nativePlanId: "stale-plan",
    tokenDocument: {
      uuid: "Scene.test.Token.stale",
      movement: {
        id: "newer-plan",
        state: "planned",
        userId: "self",
        user: { id: "self", isSelf: true }
      },
      async stopMovement() {
        stopped.push("stale");
      }
    }
  });

  try {
    await stopAbilityMovementRoutePreviews(routes);
  } finally {
    globalThis.game = previousGame;
  }

  assert.deepEqual(stopped.sort(), ["alpha", "beta", "gamma"]);
});

test("disposing an unstarted ability plan marks exactly one semantic stop for suppression", () => {
  const tokenDocument = {};
  assert.equal(markAbilityRoutePreviewStop(tokenDocument, "plan-1"), true);
  assert.equal(consumeAbilityRoutePreviewStop(tokenDocument, "other-plan"), false);
  assert.equal(consumeAbilityRoutePreviewStop(tokenDocument, "plan-1"), true);
  assert.equal(consumeAbilityRoutePreviewStop(tokenDocument, "plan-1"), false);
  assert.equal(markAbilityRoutePreviewStop(tokenDocument, "plan-2"), true);
  assert.equal(clearAbilityRoutePreviewStop(tokenDocument, "plan-2"), true);
  assert.equal(consumeAbilityRoutePreviewStop(tokenDocument, "plan-2"), false);
});

test("every shared canvas target-selection mode collapses an open abilities tray and reports cancellation", () => {
  const lifecycle = fs.readFileSync(new URL(
    "../src/canvas/target-selection-lifecycle.mjs",
    import.meta.url
  ), "utf8");
  const tokenSelection = fs.readFileSync(new URL(
    "../src/canvas/custom-token-selection.mjs",
    import.meta.url
  ), "utf8");
  const weaponAttacks = fs.readFileSync(new URL(
    "../src/combat/weapon-attack-controller.mjs",
    import.meta.url
  ), "utf8");
  const fixedAbilities = fs.readFileSync(new URL(
    "../src/abilities/fixed-functions.mjs",
    import.meta.url
  ), "utf8");
  const abilityActions = fs.readFileSync(new URL(
    "../src/abilities/ability-actions.mjs",
    import.meta.url
  ), "utf8");
  const movementRoute = fs.readFileSync(new URL(
    "../src/canvas/ability-movement-route.mjs",
    import.meta.url
  ), "utf8");
  const hud = fs.readFileSync(new URL(
    "../src/apps/token-action-hud.mjs",
    import.meta.url
  ), "utf8");

  assert.match(lifecycle, /Hooks\.callAll\(CANVAS_TARGET_SELECTION_STARTED_HOOK, sessionContext\)/);
  assert.match(lifecycle, /Hooks\.callAll\(CANVAS_TARGET_SELECTION_FINISHED_HOOK,/);
  assert.match(tokenSelection, /startCanvasTargetSelectionSession\(\{\s*kind:\s*"tokens"/);
  assert.match(tokenSelection, /targetSelectionSession\.finish\(\{\s*cancelled:\s*!Array\.isArray\(value\) \|\| !value\.length/);
  assert.match(movementRoute, /startCanvasTargetSelectionSession\(\{\s*kind:\s*"movementRoute"/);
  assert.match(movementRoute, /targetSelectionSession\.finish\(\{\s*cancelled:\s*Boolean\(outcome\?\.cancelled\)/);
  assert.match(weaponAttacks, /startCanvasTargetSelectionSession\(\{\s*kind:\s*"weaponAttack"/);
  assert.match(weaponAttacks, /startCanvasTargetSelectionSession\(\{\s*kind:\s*"commandedWeaponAttacks"/);
  assert.match(weaponAttacks, /finishTargetSelection\(\{ cancelled: true \}\)/);
  assert.match(weaponAttacks, /const selection = capture\?\.selection \?\? null;[\s\S]*?cancelled: Boolean\(capture\?\.cancelled\)[\s\S]*?capture\?\.cancelled \? "captureCancelled" : "captureFailed"/);
  assert.match(weaponAttacks, /destroyed\?\.targetSelectionOutcome\?\.cancelled/);
  const destroySelectionFinishes = Array.from(weaponAttacks.matchAll(
    /destroy\(\) \{\s*if \(this\.destroyed\) return;\s*this\.finishTargetSelection\(([^)]*)\)/g
  ));
  assert.equal(destroySelectionFinishes.length, 2);
  assert.ok(destroySelectionFinishes.every(match => !match[1].includes("cancelled")));
  assert.match(fixedAbilities, /drawLungeDestinationCandidates\(graphics, candidates\);\s*const targetSelectionSession = startCanvasTargetSelectionSession\(\{\s*kind:\s*"destination"/);
  assert.match(fixedAbilities, /workflow\.cancelled \|\| workflow\.value\?\.cancelled[\s\S]*?notifyAbilityInteractionCancelled\(onInteractionCancelled/);
  assert.match(fixedAbilities, /changeSelection = \{ changes: \[\], ids: \[\], cancelled: false, failed: true \}/);
  assert.match(fixedAbilities, /if \(changeSelection\.failed\)[\s\S]*?status: "failed"[\s\S]*?cancelled: false, reason: "changeSelectionFailed"/);
  assert.match(fixedAbilities, /hasLimitedChanges && !changeSelection\.cancelled && !changeSelection\.changes\.length[\s\S]*?status: "failed"[\s\S]*?cancelled: false, reason: "noSelectableChanges"/);
  assert.match(abilityActions, /!options\.length[\s\S]*?cancelled: false, failed: true, reason: "attackOptionsUnavailable"/);
  assert.match(abilityActions, /if \(!option\) return \{ executions: \[\], cancelled: true, failed: false, reason: "actionSelectionCancelled" \}/);
  assert.match(fixedAbilities, /if \(preparedActions\.failed\)[\s\S]*?status: "failed"[\s\S]*?cancelled: false, reason/);
  assert.match(fixedAbilities, /if \(!selectedSkills\?\.length\) \{\s*notifyAbilityInteractionCancelled\(onInteractionCancelled/);
  assert.match(hud, /Hooks\.on\(CANVAS_TARGET_SELECTION_STARTED_HOOK,[\s\S]*?collapseTray\("abilities"\)/);
  assert.match(hud, /Hooks\.on\(CANVAS_TARGET_SELECTION_FINISHED_HOOK,[\s\S]*?handleCanvasTargetSelectionFinished/);
  assert.match(hud, /context\?\.cancelled[\s\S]*?#cancelAbilityTargetInteraction\(interaction\)/);
  assert.match(hud, /#cancelAbilityTargetInteraction\(interaction\)[\s\S]*?#restoreAbilitiesTray\(interaction\)[\s\S]*?#releaseAbilityTargetInteraction\(interaction\)/);
  assert.match(hud, /onInteractionCancelled:\s*\(\) => this\.#cancelAbilityTargetInteraction\(interaction\)/);
  assert.match(hud, /#beginAbilityTargetInteraction\(\) \{\s*if \(this\.#abilityTargetInteraction && !this\.#abilityTargetInteraction\.released\) return null/);
  assert.match(hud, /if \(!interaction\) \{\s*ui\.notifications\.warn\("Сначала завершите или отмените текущее применение способности\."\);\s*return false/);
  assert.match(hud, /collapseTray\(expectedTray = ""\)[\s\S]*?popup\.hidden = true[\s\S]*?this\.#activeTray = ""/);
  const finishInteractionStart = hud.indexOf("#finishAbilityTargetInteraction(interaction)");
  const finishInteractionEnd = hud.indexOf("#scheduleAbilityTargetInteractionRelease", finishInteractionStart);
  assert.ok(finishInteractionStart >= 0 && finishInteractionEnd > finishInteractionStart);
  assert.doesNotMatch(hud.slice(finishInteractionStart, finishInteractionEnd), /#restoreAbilitiesTray/);
});

test("canvas target-selection sessions finish once and preserve the cancellation outcome", async () => {
  const calls = [];
  const previousHooks = globalThis.Hooks;
  globalThis.Hooks = {
    callAll: (hook, context) => calls.push({ hook, context })
  };
  try {
    const {
      CANVAS_TARGET_SELECTION_FINISHED_HOOK,
      CANVAS_TARGET_SELECTION_STARTED_HOOK,
      startCanvasTargetSelectionSession
    } = await import("../src/canvas/target-selection-lifecycle.mjs");

    const session = startCanvasTargetSelectionSession({ kind: "tokens" });
    assert.equal(calls[0].hook, CANVAS_TARGET_SELECTION_STARTED_HOOK);
    assert.equal(calls[0].context.sessionId, session.sessionId);
    assert.equal(session.finish({ cancelled: true }), true);
    assert.equal(session.finish({ cancelled: false }), false);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].hook, CANVAS_TARGET_SELECTION_FINISHED_HOOK);
    assert.equal(calls[1].context.cancelled, true);
  } finally {
    globalThis.Hooks = previousHooks;
  }
});

test("ordinary constructor attacks use a signed scene authority instead of trusting executor ownership", () => {
  const source = fs.readFileSync(new URL(
    "../src/abilities/ability-actions.mjs",
    import.meta.url
  ), "utf8");
  const publicStart = source.indexOf("export async function executeAbilityWeaponAttackOption");
  const publicEnd = source.indexOf("export async function executeAbilityFunctionActions", publicStart);
  const validatorStart = source.indexOf("async function validateWeaponAttackAbilityAuthority");
  const validatorEnd = source.indexOf("async function validateWeaponAttackApplicationTargets", validatorStart);
  const handlerStart = source.indexOf("async function handleAbilityActionAttackQuery");
  const handlerEnd = source.indexOf("async function executeAbilityMovementRouteExecution", handlerStart);
  assert.ok(publicStart >= 0 && publicEnd > publicStart);
  assert.ok(handlerStart >= 0 && validatorStart > handlerStart && validatorEnd > validatorStart);

  const publicExecutor = source.slice(publicStart, publicEnd);
  const handler = source.slice(handlerStart, handlerEnd);
  const validator = source.slice(validatorStart, validatorEnd);
  assert.match(source, /function getAbilityActionSceneAuthority[\s\S]*?user\?\.active[\s\S]*?user\.viewedScene[\s\S]*?includedInLevel/);
  assert.match(source, /const preferred = eligible\.find\(user => user\.id === preferredUser\?\.id\)[\s\S]*?if \(preferred\) return preferred/);
  assert.match(publicExecutor, /getAbilityActionSceneAuthority\(actor, attackerTokenDocument/);
  assert.match(publicExecutor, /preferredUser:\s*game\.user/);
  assert.doesNotMatch(publicExecutor, /getResponsibleOwner/);
  assert.match(publicExecutor, /actionId:\s*normalizedActionId[\s\S]*?authorityContext/);
  assert.match(publicExecutor, /handleAbilityActionAttackQuery\(data, \{ user: game\.user \}\)/);
  assert.match(source, /ordinaryAttackAuthority[\s\S]*?buildAbilityActionAuthorityContext[\s\S]*?executeAbilityWeaponAttackOption/);
  assert.match(source, /executorTokenUuid[\s\S]*?attackTargetTokenUuid/);

  assert.match(handler, /async function handleAbilityActionAttackQuery\(data = \{\}, \{ user: sender = null \} = \{\}\)/);
  assert.ok(handler.indexOf("validateWeaponAttackAbilityAuthority") < handler.indexOf("withSystemEventRoot"));
  assert.match(validator, /testUserPermission\?\.\(sender, "OWNER"\)/);
  assert.match(validator, /abilityItem\.type !== "ability"/);
  assert.match(validator, /JSON\.stringify\(abilityFunction\)/);
  assert.match(validator, /ABILITY_ACTION_TYPES\.weaponAttack/);
  assert.match(validator, /requestedPair/);
  assert.match(validator, /ABILITY_ACTION_TARGET_MODES\.free[\s\S]*?data\.autoApply[\s\S]*?attackTargetTokenUuid/);
  assert.match(validator, /collectAbilityWeaponAttackOptions\(actor, action\)\.find/);
  assert.match(validator, /candidate\.actionPointCost === actionPointCost/);
});

test("commanded constructor attacks select a GM rendering every exact token scene and level", () => {
  const source = fs.readFileSync(new URL(
    "../src/combat/weapon-attack-controller.mjs",
    import.meta.url
  ), "utf8");
  const start = source.slice(
    source.indexOf("export async function startCommandedWeaponAttacksAndWait"),
    source.indexOf("function canUseCommandedMultiRayCapture")
  );
  const execute = source.slice(
    source.indexOf("async function executeCommandedWeaponAttackSelections"),
    source.indexOf("async function preflightCommandedWeaponAttackSelections")
  );
  const preflight = source.slice(
    source.indexOf("async function preflightCommandedWeaponAttackSelections"),
    source.indexOf("function requestCommandedWeaponAttackOperation")
  );
  const request = source.slice(
    source.indexOf("async function requestCommandedWeaponAttackOperation"),
    source.indexOf("async function handleCommandedWeaponAttackQuery")
  );
  const queryHandler = source.slice(
    source.indexOf("async function handleCommandedWeaponAttackQuery"),
    source.indexOf("async function processCommandedWeaponAttackSelections")
  );
  const authorityValidator = source.slice(
    source.indexOf("async function validateCommandedAbilityAuthority"),
    source.indexOf("function validateCommandedAttackSelectionMode")
  );
  const resolver = source.slice(
    source.indexOf("async function resolveCommandedAttackAuthorityTokenDocuments"),
    source.indexOf("async function getCommandedAttackSceneGM")
  );
  const selector = source.slice(
    source.indexOf("async function getCommandedAttackSceneGM"),
    source.indexOf("function serializeGeometry")
  );

  assert.match(start, /await getCommandedAttackSceneGM\(\{ entries, authorityContext \}\)/);
  assert.match(execute, /await getCommandedAttackSceneGM\(\{ selections: serialized, authorityContext \}\)/);
  assert.match(preflight, /await getCommandedAttackSceneGM\(\{ selections: serialized, authorityContext \}\)/);
  assert.match(execute, /requestCommandedWeaponAttackOperation\("execute",[\s\S]*?gm/);
  assert.match(preflight, /requestCommandedWeaponAttackOperation\("preflight",[\s\S]*?gm/);
  assert.doesNotMatch(execute, /processCommandedWeaponAttackSelections/);
  assert.doesNotMatch(preflight, /processCommandedWeaponAttackSelections/);
  assert.doesNotMatch(request, /getResponsibleGM\(/);
  assert.match(source, /CONFIG\.queries\[COMMANDED_ATTACK_QUERY\] = handleCommandedWeaponAttackQuery/);
  assert.match(request, /gm\.query\(COMMANDED_ATTACK_QUERY, data, \{ timeout: COMMANDED_ATTACK_QUERY_TIMEOUT_MS \}\)/);
  assert.doesNotMatch(request, /game\.socket\.emit|senderUserId/);
  assert.match(queryHandler, /async function handleCommandedWeaponAttackQuery\(data = \{\}, \{ user: sender = null \} = \{\}\)/);
  assert.match(queryHandler, /sender\?\.active/);
  assert.doesNotMatch(source, /pendingCommandedAttackRequests|commandedAttacksResult|executeCommandedAttacks|preflightCommandedAttacks/);

  assert.match(resolver, /authorityContext\?\.sourceTokenUuid/);
  assert.match(resolver, /entry\?\.token\?\.document/);
  assert.match(resolver, /selection\?\.tokenUuid/);
  assert.match(resolver, /selection\?\.targetUuid/);
  assert.match(selector, /filter\(user => isCommandedAttackSceneAuthority\(user, tokenDocuments\)\)/);
  assert.match(selector, /eligible\.some\(user => user\.id === activeGM\.id\)/);
  assert.match(selector, /user\.viewedScene/);
  assert.match(selector, /tokenDocument\.includedInLevel\(user\.viewedLevel \?\? null\)/);
  assert.match(selector, /requirePlaceables[\s\S]*?tokenDocument\.object/);

  assert.match(queryHandler, /resolveCommandedAttackAuthorityTokenDocuments\([\s\S]*?isCommandedAttackSceneAuthority\(game\.user, requiredTokenDocuments, \{ requirePlaceables: true \}\)/);
  assert.match(queryHandler, /if \(!isCommandedAttackSceneAuthority[\s\S]*?gmSceneUnavailable[\s\S]*?processCommandedWeaponAttackSelections/);
  assert.match(queryHandler, /sender,[\s\S]*?validateOnly: operation === "preflight"/);
  assert.match(authorityValidator, /sender\?\.active/);
  assert.doesNotMatch(authorityValidator, /game\.users\?\.get\(String\(senderUserId/);
  assert.match(authorityValidator, /attackTargetTokenUuids[\s\S]*?selection\?\.targetUuid/);
  assert.match(authorityValidator, /\[sourceTokenDocument, \.\.\.targetTokenDocuments, \.\.\.attackTargetTokenDocuments\][\s\S]*?requirePlaceables: true/);
});
