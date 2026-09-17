import { createMovementOptions, getMovementRouteSamples, getMovementSegmentSamples } from "../canvas/movement-interruptions.mjs";
import { INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION, STEALTH_ROUTE_PLAN_OPTION, withMovementResumeContext } from "../canvas/movement-resume-context.mjs";
import { isActorStealthed } from "./rules.mjs";

const PREFLIGHT = "stealthRoutePreflight";
const PREPARED = "stealthRouteDetection";
const EPSILON = 0.00001;
let nextPlanId = 1;

/** A plan belongs to one native movement chain; unrelated moves always collect afresh. */
export function createStealthRoutePlanner({ collect, prepareChecks, resolveChecks, pauseGame }) {
  const activePlans = new Map();
  const keyOf = token => String(token?.uuid ?? token?.id ?? "");
  const currentPlan = ({ tokenDocument, movement, options = {} }) => {
    const plan = activePlans.get(keyOf(tokenDocument));
    if (!plan || plan.invalid) return null;
    if (options[STEALTH_ROUTE_PLAN_OPTION] !== plan.id
      && !(movement?.chain ?? []).some(id => plan.movementIds.has(String(id)))) return null;
    if (movement?.id) plan.movementIds.add(String(movement.id));
    // Carry the causal marker into controlled moves made by other providers.
    options[STEALTH_ROUTE_PLAN_OPTION] = plan.id;
    return plan;
  };

  async function resume(tokenDocument, movement, event, options, chainRef) {
    const waypoints = event.remainingWaypoints ?? [];
    if (!waypoints.length) return true;
    const moveOptions = createMovementOptions(movement, options, {
      chainRef, split: false, showRuler: movement?.showRuler
    });
    return withMovementResumeContext(tokenDocument, INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION, { chainRef }, () => (
      tokenDocument.move(waypoints, {
        ...moveOptions,
        [INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION]: true,
        [STEALTH_ROUTE_PLAN_OPTION]: activePlans.get(keyOf(tokenDocument))?.id
      })
    ));
  }

  return {
    clear(tokenDocument = null) {
      if (tokenDocument) activePlans.delete(keyOf(tokenDocument));
      else activePlans.clear();
    },
    owns(event) { return event?.type === PREFLIGHT || event?.type === PREPARED; },
    collect(context = {}) {
      const { tokenDocument, movement, options = {} } = context;
      if (!tokenDocument || !movement) return emptyCollection();
      const plan = currentPlan(context);
      if (plan) {
        const projection = projectStealthRoutePlan(plan, tokenDocument, movement);
        if (projection) return projection;
        // A constrained or reaction-modified route no longer matches the snapshot.
        plan.invalid = true;
      }
      const waypoints = fullWaypoints(movement);
      const fullMovement = {
        ...movement,
        passed: { ...movement.passed, waypoints },
        pending: { waypoints: [] },
        destination: waypoints.at(-1) ?? movement.destination
      };
      const collection = collect({ tokenDocument, movement: fullMovement, options, collectAll: true });
      if (!collection.events?.length) {
        // With no checks there is no asynchronous preflight. Commit only this
        // native chunk, even if the collector inspected its pending continuation.
        if (collection.routeSteps?.length) {
          const noCheckPlan = makePlan(collection);
          return projectStealthRoutePlan(noCheckPlan, tokenDocument, movement) ?? emptyCollection();
        }
        return collection;
      }
      const preparedPlan = makePlan(collection);
      return {
        ...emptyCollection(),
        events: [{
          type: PREFLIGHT,
          eventId: `stealth-preflight:${movement.id ?? ""}`,
          priority: 3,
          routeOrder: 0,
          moveToWaypoint: false,
          waypoint: movement.origin,
          remainingWaypoints: waypoints.filter(waypoint => !waypoint.intermediate),
          plan: preparedPlan
        }]
      };
    },
    synchronize(context = {}) {
      const plan = currentPlan(context);
      if (!plan) return;
      const projection = plan.projections.get(context.movement)
        ?? projectStealthRoutePlan(plan, context.tokenDocument, context.movement);
      if (!projection) { plan.invalid = true; return; }
      plan.cursor = Math.max(plan.cursor, projection.planEnd);
      const reached = [];
      for (const event of plan.collection.events) {
        if (event.routeOrder > plan.cursor + EPSILON || plan.notified.has(event)) continue;
        if (event.preparedChecks?.some(check => failed(check.outcome))) continue;
        plan.notified.add(event);
        reached.push(...(event.preparedChecks ?? []));
      }
      if (plan.cursor >= plan.collection.routeSteps.length - 1 - EPSILON && !plan.failureEvent) {
        activePlans.delete(keyOf(context.tokenDocument));
      }
      if (reached.length) return resolveChecks(reached);
    },
    async execute(context = {}) {
      const { tokenDocument, movement, event, options = {}, chainRef, isCurrent, nativeMovementPaused } = context;
      if (event.type === PREFLIGHT) {
        const plan = event.plan;
        const checks = [];
        const tokens = new Map();
        for (const baseline of plan.collection.stateBaselines.values()) {
          const pair = baseline.pair;
          for (const token of [pair?.hiddenToken, pair?.observerToken]) {
            if (token) tokens.set(String(token.document?.uuid ?? token.uuid), token);
          }
        }
        for (const checkpoint of plan.collection.events) {
          for (const check of checkpoint.checks) {
            const sourceToken = tokens.get(check.hiddenTokenUuid);
            const targetToken = tokens.get(check.observerTokenUuid);
            if (!sourceToken?.actor || !targetToken?.actor || !isActorStealthed(sourceToken.actor)) continue;
            checks.push({
              sourceToken, targetToken, checkpoint: checkpoint.routeOrder,
              sourcePosition: check.mode === "hiddenMoving" ? checkpoint.waypoint : undefined
            });
          }
        }
        const resolved = await prepareChecks(checks);
        if (isCurrent && !isCurrent()) return false;
        const byCheckpoint = new Map();
        for (const check of resolved) {
          const entries = byCheckpoint.get(check.checkpoint) ?? [];
          entries.push(check);
          byCheckpoint.set(check.checkpoint, entries);
        }
        for (const checkpoint of plan.collection.events) {
          checkpoint.preparedChecks = byCheckpoint.get(checkpoint.routeOrder) ?? [];
          if (!plan.failureEvent && checkpoint.preparedChecks.some(check => failed(check.outcome))) {
            plan.failureEvent = checkpoint;
          }
        }
        activePlans.set(keyOf(tokenDocument), plan);
        return resume(tokenDocument, movement, event, options, chainRef);
      }

      const plan = event.plan;
      const checks = (event.preparedChecks ?? []).filter(check => isActorStealthed(check.sourceToken.actor));
      const outcomes = await resolveChecks(checks);
      plan.notified.add(event.originalEvent);
      if (outcomes.some(failed) || checks.some(check => !isActorStealthed(check.sourceToken.actor))) {
        activePlans.delete(keyOf(tokenDocument));
        pauseGame();
        return false;
      }
      if (isCurrent && !isCurrent()) return false;
      // A reveal-prevention reaction may change the scene or actor. Roll the
      // remaining checks against that new state before its continuation starts.
      plan.invalid = true;
      if (nativeMovementPaused) return true;
      return resume(tokenDocument, movement, event, options, chainRef);
    }
  };
}

function makePlan(collection) {
  return { id: `stealth-plan-${nextPlanId++}`, collection, cursor: 0, projections: new WeakMap(), movementIds: new Set(), notified: new Set(), failureEvent: null, invalid: false };
}

/** Project already calculated states onto a native chunk without detection tests. */
export function projectStealthRoutePlan(plan, tokenDocument, movement) {
  const cached = plan.projections.get(movement);
  if (cached) return cached;
  const routeSamples = getMovementRouteSamples(tokenDocument, movement);
  const localSteps = routeSamples.length ? [routeSamples[0]] : [];
  for (let i = 1; i < routeSamples.length; i++) {
    localSteps.push(...getMovementSegmentSamples(tokenDocument, routeSamples[i - 1], routeSamples[i]).slice(1));
  }
  if (localSteps.length < 2) return null;
  const positions = [];
  let progress = plan.cursor;
  for (const step of localSteps) {
    progress = locateRouteProgress(plan.collection.routeSteps, step.waypoint, progress);
    if (progress === null) return null;
    positions.push(progress);
  }
  const start = positions[0];
  const end = positions.at(-1);
  const localOrder = order => {
    let low = 0;
    let high = positions.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle] + EPSILON >= order) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  const stateTransitions = plan.collection.stateTransitions
    .filter(transition => transition.routeOrder > start + EPSILON && transition.routeOrder <= end + EPSILON)
    .map(transition => ({ ...transition, routeOrder: localOrder(transition.routeOrder) }));
  const stateUpdates = new Map(stateTransitions.map(transition => [transition.key, transition.value]));
  const failure = plan.failureEvent;
  const events = failure && failure.routeOrder > start + EPSILON && failure.routeOrder <= end + EPSILON
    ? [{
      ...failure,
      type: PREPARED,
      routeOrder: localOrder(failure.routeOrder),
      // Resume uses the original suffix, including native pending checkpoints.
      remainingWaypoints: failure.remainingWaypoints,
      plan,
      originalEvent: failure
    }]
    : [];
  const projection = { events, stateUpdates, stateBaselines: plan.collection.stateBaselines, stateTransitions, planEnd: end };
  plan.projections.set(movement, projection);
  return projection;
}

function locateRouteProgress(steps, waypoint, minimum) {
  const point = position(waypoint);
  for (let i = Math.max(0, Math.floor(minimum)); i < steps.length - 1; i++) {
    const a = position(steps[i].waypoint);
    const b = position(steps[i + 1].waypoint);
    const d = b.map((value, axis) => value - a[axis]);
    const length2 = d.reduce((sum, value) => sum + value * value, 0);
    const fraction = length2 ? d.reduce((sum, value, axis) => sum + value * (point[axis] - a[axis]), 0) / length2 : 0;
    if (fraction < -EPSILON || fraction > 1 + EPSILON || i + fraction < minimum - EPSILON) continue;
    if (point.some((value, axis) => Math.abs(value - a[axis] - fraction * d[axis]) > EPSILON)) continue;
    return i + Math.max(0, Math.min(1, fraction));
  }
  if (steps.length && position(steps.at(-1).waypoint).every((value, axis) => Math.abs(value - point[axis]) <= EPSILON)) {
    return steps.length - 1;
  }
  return null;
}

function position(waypoint = {}) {
  return [Number(waypoint.x) || 0, Number(waypoint.y) || 0, Number(waypoint.elevation) || 0];
}

function fullWaypoints(movement) {
  const passed = [...(movement.passed?.waypoints ?? [])];
  if (!passed.length && movement.destination) passed.push(movement.destination);
  return [...passed, ...(movement.pending?.waypoints ?? [])];
}

function failed(outcome) {
  return !outcome?.falloutMawRevealPrevented
    && (outcome?.result?.autoFailure || ["failure", "criticalFailure"].includes(outcome?.result?.key));
}

function emptyCollection() {
  return { events: [], stateUpdates: new Map(), stateBaselines: new Map(), stateTransitions: [] };
}
