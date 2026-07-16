import { SYSTEM_ID } from "../constants.mjs";
import { trackSystemMovementOperation } from "../canvas/movement-settlement.mjs";
import {
  ABILITY_ROUTE_PREVIEW_MOVEMENT_OPTION,
  clearAbilityRoutePreviewStop,
  consumeAbilityRoutePreviewStop,
  markAbilityRoutePreviewStop
} from "../canvas/ability-route-preview-state.mjs";
import { dispatchSystemEvent, withSystemEventRoot } from "./dispatcher.mjs";
import {
  eventReactionIndexHasAny,
  getEventReactionSubscriptionIndex,
  MOVEMENT_GATE_EVENT_KEYS
} from "./event-reaction-index.mjs";

export const SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION = "falloutMawSystemEventMovementBypass";
export const SYSTEM_EVENT_CHAIN_OPTION = "falloutMawSystemEventChainRef";

const CONTROLLED_INTERRUPTION_OPTION = "falloutMawControlledMovementInterruption";
const WHERE_ARE_YOU_GOING_RESUME_OPTION = "falloutMawWhereAreYouGoingResume";
const pendingMovementGates = new Set();
let hooksRegistered = false;

/**
 * Foundry v14 calls preMoveToken synchronously. We reject that invocation, await the GM gate, then resume once with
 * a controlled bypass instead of returning a Promise from the hook.
 */
export function registerFoundryMovementSystemEventHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("preMoveToken", onPreMoveToken);
  Hooks.on("moveToken", onMoveToken);
  Hooks.on("stopToken", onStopToken);
  Hooks.on("updateToken", onAbilityRoutePreviewPlanUpdate);
}

export function createMovementOccurrenceKey(tokenDocument, movement = {}, phase = "", subpath = "") {
  return [
    tokenDocument?.parent?.uuid ?? tokenDocument?.parent?.id ?? "",
    tokenDocument?.uuid ?? tokenDocument?.id ?? "",
    movement?.id ?? "",
    subpath || movementSubpath(movement),
    phase
  ].join(":");
}

export function serializeMovementOperation(movement = {}) {
  return {
    id: String(movement?.id ?? ""),
    method: String(movement?.method ?? ""),
    constrained: Boolean(movement?.constrained),
    recorded: Boolean(movement?.recorded),
    split: Boolean(movement?.split),
    autoRotate: Boolean(movement?.autoRotate),
    showRuler: Boolean(movement?.showRuler),
    destination: serializeWaypoint(movement?.destination),
    passedWaypoints: (movement?.passed?.waypoints ?? []).map(serializeWaypoint),
    pendingWaypoints: (movement?.pending?.waypoints ?? []).map(serializeWaypoint)
  };
}

function onPreMoveToken(tokenDocument, movement, operation = {}) {
  if (
    operation?.[SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION]
    || operation?.[CONTROLLED_INTERRUPTION_OPTION]
    || operation?.[WHERE_ARE_YOU_GOING_RESUME_OPTION]
  ) return true;
  if (game.paused || !tokenDocument?.actor || !movement) return true;

  // Only reject+resume when a fresh index says a movement-gate Event Reaction exists.
  // Dirty/unknown => fail-open to native movement (never stall the token for index rebuild).
  const gateNeeded = movementGateNeededSync();
  if (gateNeeded !== true) {
    if (gateNeeded === null) void eventReactionIndexHasAny(MOVEMENT_GATE_EVENT_KEYS);
    return true;
  }

  const key = createMovementOccurrenceKey(tokenDocument, movement, "gate");
  if (!pendingMovementGates.has(key)) {
    pendingMovementGates.add(key);
    trackSystemMovementOperation(
      tokenDocument,
      gateAndResumeMovement(tokenDocument, movement, operation, key),
      { contributesToCompletion: true }
    );
  }
  return false;
}

function movementGateNeededSync() {
  const current = getEventReactionSubscriptionIndex();
  if (current.isDirty) return null;
  return Boolean(current.hasAnyOf(MOVEMENT_GATE_EVENT_KEYS));
}

async function gateAndResumeMovement(tokenDocument, movement, operation, pendingKey) {
  const movementData = serializeMovementOperation(movement);
  const participant = tokenParticipant(tokenDocument);
  const operationId = `movement:${createMovementOccurrenceKey(tokenDocument, movement, "root")}`;
  const inheritedChainRef = operation?.[SYSTEM_EVENT_CHAIN_OPTION]
    ?? operation?.falloutMawSystemEventChainRef
    ?? operation?.chainRef
    ?? null;
  try {
    return await withSystemEventRoot({
      kind: "tokenMovement",
      operationId,
      sceneUuid: String(tokenDocument?.parent?.uuid ?? ""),
      combatUuid: String(game.combat?.uuid ?? ""),
      chainRef: inheritedChainRef
    }, async scope => {
      await scope.emit("fallout-maw.movement.token.before", { data: movementData }, {
        occurrenceKey: createMovementOccurrenceKey(tokenDocument, movement, "before"),
        participants: { source: participant, target: null, related: [] }
      });
      const gate = await scope.emit("fallout-maw.movement.token.beforeStart", { data: movementData }, {
        occurrenceKey: createMovementOccurrenceKey(tokenDocument, movement, "beforeStart"),
        participants: { source: participant, target: null, related: [] }
      });
      if (gate?.control?.current || gate?.control?.remaining || gate?.control?.root) {
        await scope.emit("fallout-maw.movement.token.stopped", {
          data: movementData,
          outcome: { completed: false, cancelled: true },
          reason: lastControlReason(gate.control) || "eventReaction"
        }, {
          occurrenceKey: createMovementOccurrenceKey(tokenDocument, movement, "stopped"),
          participants: { source: participant, target: null, related: [] }
        });
        return false;
      }

      const waypoints = getMovementResumeWaypoints(movement);
      if (!waypoints.length) return false;
      const completed = await tokenDocument.move(waypoints, {
        [SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION]: true,
        [SYSTEM_EVENT_CHAIN_OPTION]: scope.chainRef,
        chainRef: scope.chainRef,
        method: movement?.method,
        split: movement?.split,
        autoRotate: Boolean(movement?.autoRotate),
        showRuler: Boolean(movement?.showRuler),
        terrainOptions: movement?.terrainOptions,
        constrainOptions: movement?.constrainOptions,
        measureOptions: movement?.measureOptions
      });
      await waitForTokenMovementAnimation(tokenDocument);
      return completed !== false;
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Token movement system-event gate failed`, error);
    try {
      const waypoints = getMovementResumeWaypoints(movement);
      if (!waypoints.length) return false;
      const completed = await tokenDocument.move(waypoints, {
        [SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION]: true,
        ...(inheritedChainRef ? {
          [SYSTEM_EVENT_CHAIN_OPTION]: inheritedChainRef,
          falloutMawSystemEventChainRef: inheritedChainRef,
          chainRef: inheritedChainRef
        } : {})
      });
      await waitForTokenMovementAnimation(tokenDocument);
      return completed !== false;
    } catch (resumeError) {
      console.error(`${SYSTEM_ID} | Token movement fail-open resume failed`, resumeError);
      return false;
    }
  } finally {
    pendingMovementGates.delete(pendingKey);
  }
}

async function waitForTokenMovementAnimation(tokenDocument) {
  const animation = tokenDocument?.movement?.animation?.ended;
  if (animation?.then) await animation.catch(() => undefined);
}

function onMoveToken(tokenDocument, movement, operation = {}, user = null) {
  clearAbilityRoutePreviewStop(tokenDocument, movement?.id);
  if (!user?.isSelf || !tokenDocument?.actor || !movement) return;
  const participant = tokenParticipant(tokenDocument);
  const chainRef = operation?.[SYSTEM_EVENT_CHAIN_OPTION] ?? operation?.chainRef ?? null;
  const dispatched = dispatchSystemEvent("fallout-maw.movement.token.completed", {
    data: serializeMovementOperation(movement),
    outcome: { completed: !movement.constrained, constrained: Boolean(movement.constrained) }
  }, {
    chainRef,
    kind: "tokenMovementCommitted",
    operationId: `movement-post:${createMovementOccurrenceKey(tokenDocument, movement, "completed")}`,
    sceneUuid: String(tokenDocument?.parent?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    occurrenceKey: createMovementOccurrenceKey(tokenDocument, movement, "completed"),
    participants: { source: participant, target: null, related: [] }
  }).catch(error => {
    console.error(`${SYSTEM_ID} | Token movement completion event failed`, error);
  });
  trackSystemMovementOperation(tokenDocument, dispatched);
}

function onAbilityRoutePreviewPlanUpdate(tokenDocument, _changes = {}, operation = {}) {
  if (!operation?.[ABILITY_ROUTE_PREVIEW_MOVEMENT_OPTION]) return;
  const movement = operation?._movement?.[tokenDocument?.id];
  if (!movement?.id || movement?.passed?.waypoints?.length) return;
  markAbilityRoutePreviewStop(tokenDocument, movement.id);
}

function onStopToken(tokenDocument) {
  if (consumeAbilityRoutePreviewStop(tokenDocument, tokenDocument?.movement?.id)) return;
  if (!isCurrentActiveGM() || !tokenDocument?.actor) return;
  const movement = tokenDocument?.movement ?? {};
  const dispatched = dispatchSystemEvent("fallout-maw.movement.token.stopped", {
    data: serializeMovementOperation(movement),
    outcome: { completed: false, constrained: true }
  }, {
    kind: "tokenMovementStopped",
    operationId: `movement-stop:${createMovementOccurrenceKey(tokenDocument, movement, "stopped")}`,
    sceneUuid: String(tokenDocument?.parent?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    occurrenceKey: createMovementOccurrenceKey(tokenDocument, movement, "stopped"),
    participants: { source: tokenParticipant(tokenDocument), target: null, related: [] }
  }).catch(error => {
    console.error(`${SYSTEM_ID} | Token movement stopped event failed`, error);
  });
  trackSystemMovementOperation(tokenDocument, dispatched);
}

function getMovementResumeWaypoints(movement = {}) {
  const values = [
    ...(movement?.passed?.waypoints ?? []),
    ...(movement?.pending?.waypoints ?? [])
  ];
  if (!values.length && movement?.destination) values.push(movement.destination);
  // Foundry supports routes which deliberately revisit a position. Keep the
  // original order and repetitions (A -> B -> A) when an asynchronously gated
  // movement is resumed.
  return values.map(serializeWaypoint)
    .filter(waypoint => Number.isFinite(waypoint.x) && Number.isFinite(waypoint.y));
}

function serializeWaypoint(waypoint = null) {
  if (!waypoint) return null;
  const numericKeys = ["x", "y", "elevation", "width", "height", "depth", "cost", "spaces", "diagonals"];
  const result = {};
  for (const key of numericKeys) {
    const value = Number(waypoint[key]);
    if (Number.isFinite(value)) result[key] = value;
  }
  for (const key of ["action", "level", "shape"]) {
    if (waypoint[key] !== undefined && waypoint[key] !== null) result[key] = waypoint[key];
  }
  for (const key of ["snapped", "explicit", "checkpoint"]) {
    if (waypoint[key] !== undefined) result[key] = Boolean(waypoint[key]);
  }
  return result;
}

function movementSubpath(movement = {}) {
  return [...(movement?.passed?.waypoints ?? []), ...(movement?.pending?.waypoints ?? [])]
    .map(waypoint => `${Math.round(Number(waypoint?.x) || 0)},${Math.round(Number(waypoint?.y) || 0)}`)
    .join(";");
}

function tokenParticipant(tokenDocument) {
  return {
    actorUuid: String(tokenDocument?.actor?.uuid ?? ""),
    tokenUuid: String(tokenDocument?.uuid ?? ""),
    itemUuid: ""
  };
}

function lastControlReason(control = {}) {
  return String(control?.reasons?.at?.(-1)?.reason ?? "");
}

function isCurrentActiveGM() {
  return Boolean(game.users?.activeGM?.id && game.users.activeGM.id === game.user?.id);
}
