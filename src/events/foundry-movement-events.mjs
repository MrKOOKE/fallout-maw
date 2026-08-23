import { SYSTEM_ID } from "../constants.mjs";
import {
  CONTROLLED_MOVEMENT_INTERRUPTION_OPTION,
  createMovementOptions,
  isControlledMovementInterruption,
  SYSTEM_RELOCATION_OPTION
} from "../canvas/movement-interruptions.mjs";
import { trackSystemMovementOperation } from "../canvas/movement-settlement.mjs";
import {
  clearMovementResumeContexts,
  getMovementResumeContext,
  INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION,
  withMovementResumeContext
} from "../canvas/movement-resume-context.mjs";
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

const pendingMovementGates = new Set();
const movementGateEpochs = new Map();
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
  Hooks.on("deleteToken", tokenDocument => {
    movementGateEpochs.delete(getMovementGateTokenKey(tokenDocument));
    clearMovementResumeContexts(tokenDocument);
  });
  Hooks.on("canvasTearDown", () => {
    pendingMovementGates.clear();
    movementGateEpochs.clear();
    clearMovementResumeContexts();
  });
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
  if (operation?.[SYSTEM_RELOCATION_OPTION]) {
    beginMovementGateEpoch(tokenDocument);
    return true;
  }
  const gateResumeContext = getMovementResumeContext(
    tokenDocument,
    movement,
    operation,
    SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION
  );
  const internalResumeContext = getMovementResumeContext(
    tokenDocument,
    movement,
    operation,
    INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION
  );
  if (gateResumeContext) {
    const gateEpoch = Number(gateResumeContext.data?.movementGateEpoch) || 0;
    const valid = movement?.chain?.length
      ? movementGateEpochs.get(getMovementGateTokenKey(tokenDocument)) === gateEpoch
      : isMovementGateCurrent(tokenDocument, movement, gateEpoch);
    if (!valid) return false;
  }
  const resumeChainRef = gateResumeContext?.data?.chainRef ?? internalResumeContext?.data?.chainRef ?? null;
  if (resumeChainRef) {
    operation[SYSTEM_EVENT_CHAIN_OPTION] = resumeChainRef;
    operation.falloutMawSystemEventChainRef = resumeChainRef;
    operation.chainRef = resumeChainRef;
  }
  if (
    operation?.[SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION]
    || gateResumeContext
    || operation?.[INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION]
    || internalResumeContext
  ) return true;

  // Every other movement attempt supersedes an older asynchronous gate for
  // this Token. This is causal ordering, not a time-based assumption.
  const movementGateEpoch = beginMovementGateEpoch(tokenDocument);
  if (
    operation?.[CONTROLLED_MOVEMENT_INTERRUPTION_OPTION]
    || isControlledMovementInterruption(tokenDocument, movement, operation)
    || movement?.chain?.length
    || operation?.isUndo
    || operation?.isPaste
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
      gateAndResumeMovement(tokenDocument, movement, operation, key, movementGateEpoch),
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

async function gateAndResumeMovement(tokenDocument, movement, operation, pendingKey, movementGateEpoch) {
  const movementData = serializeMovementOperation(movement);
  const participant = tokenParticipant(tokenDocument);
  const operationId = `movement:${createMovementOccurrenceKey(tokenDocument, movement, "root")}`;
  const inheritedChainRef = operation?.[SYSTEM_EVENT_CHAIN_OPTION]
    ?? operation?.falloutMawSystemEventChainRef
    ?? operation?.chainRef
    ?? null;
  try {
    if (!isMovementGateCurrent(tokenDocument, movement, movementGateEpoch)) return false;
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
      if (!isMovementGateCurrent(tokenDocument, movement, movementGateEpoch)) return false;
      const gate = await scope.emit("fallout-maw.movement.token.beforeStart", { data: movementData }, {
        occurrenceKey: createMovementOccurrenceKey(tokenDocument, movement, "beforeStart"),
        participants: { source: participant, target: null, related: [] }
      });
      if (!isMovementGateCurrent(tokenDocument, movement, movementGateEpoch)) return false;
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
      if (!isMovementGateCurrent(tokenDocument, movement, movementGateEpoch)) return false;
      const completed = await withMovementResumeContext(
        tokenDocument,
        SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION,
        { chainRef: scope.chainRef, movementGateEpoch },
        () => tokenDocument.move(waypoints, {
          ...createMovementOptions(movement, operation, {
            chainRef: scope.chainRef,
            showRuler: movement?.showRuler
          }),
          [SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION]: true,
          [SYSTEM_EVENT_CHAIN_OPTION]: scope.chainRef,
          chainRef: scope.chainRef
        })
      );
      await waitForTokenMovementAnimation(tokenDocument);
      return completed !== false;
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Token movement system-event gate failed`, error);
    try {
      if (!isMovementGateCurrent(tokenDocument, movement, movementGateEpoch)) return false;
      const waypoints = getMovementResumeWaypoints(movement);
      if (!waypoints.length) return false;
      const completed = await withMovementResumeContext(
        tokenDocument,
        SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION,
        { chainRef: inheritedChainRef, movementGateEpoch },
        () => tokenDocument.move(waypoints, {
          ...createMovementOptions(movement, operation, {
            chainRef: inheritedChainRef,
            showRuler: movement?.showRuler
          }),
          [SYSTEM_EVENT_MOVEMENT_BYPASS_OPTION]: true,
          ...(inheritedChainRef ? {
            [SYSTEM_EVENT_CHAIN_OPTION]: inheritedChainRef,
            falloutMawSystemEventChainRef: inheritedChainRef,
            chainRef: inheritedChainRef
          } : {})
        })
      );
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

function beginMovementGateEpoch(tokenDocument) {
  const key = getMovementGateTokenKey(tokenDocument);
  const epoch = (movementGateEpochs.get(key) ?? 0) + 1;
  movementGateEpochs.set(key, epoch);
  return epoch;
}

function isMovementGateCurrent(tokenDocument, movement = {}, epoch = 0) {
  if (movementGateEpochs.get(getMovementGateTokenKey(tokenDocument)) !== epoch) return false;
  return isTokenAtMovementOrigin(tokenDocument, movement?.origin);
}

function getMovementGateTokenKey(tokenDocument) {
  return String(tokenDocument?.uuid ?? [tokenDocument?.parent?.id ?? "", tokenDocument?.id ?? ""].join(":"));
}

function isTokenAtMovementOrigin(tokenDocument, origin = null) {
  if (!origin) return true;
  const source = tokenDocument?._source ?? tokenDocument ?? {};
  for (const field of ["x", "y", "elevation", "width", "height", "depth"]) {
    const actual = Number(source[field] ?? origin[field] ?? 0);
    const expected = Number(origin[field] ?? source[field] ?? 0);
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || actual !== expected) return false;
  }
  for (const field of ["shape", "level"]) {
    if (String(source[field] ?? origin[field] ?? "") !== String(origin[field] ?? source[field] ?? "")) return false;
  }
  return true;
}

async function waitForTokenMovementAnimation(tokenDocument) {
  const animation = tokenDocument?.movement?.animation?.ended;
  if (animation?.then) await animation.catch(() => undefined);
}

function onMoveToken(tokenDocument, movement, operation = {}, user = null) {
  clearAbilityRoutePreviewStop(tokenDocument, movement?.id);
  if (!user?.isSelf || !tokenDocument?.actor || !movement) return;
  if (
    !isMovementOperationCompleted(movement)
    || operation?.[SYSTEM_RELOCATION_OPTION]
    || operation?.[CONTROLLED_MOVEMENT_INTERRUPTION_OPTION]
    || isControlledMovementInterruption(tokenDocument, movement, operation)
  ) return;
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

export function isMovementOperationCompleted(movement = {}) {
  return !movement?.constrained && !(movement?.pending?.waypoints?.length > 0);
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

export function getMovementResumeWaypoints(movement = {}) {
  const values = [
    ...(movement?.passed?.waypoints ?? []),
    ...(movement?.pending?.waypoints ?? [])
  ].filter(waypoint => !waypoint?.intermediate);
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
