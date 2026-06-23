import { SYSTEM_ID } from "../constants.mjs";

export const CONTROLLED_MOVEMENT_INTERRUPTION_OPTION = "falloutMawControlledMovementInterruption";

const providers = new Map();
const pendingMovementKeys = new Set();
let hooksRegistered = false;

export function registerMovementInterruptionHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("preMoveToken", onPreMoveToken);
}

export function registerMovementInterruptionProvider(provider = {}) {
  const id = String(provider?.id ?? "").trim();
  if (!id || typeof provider.collect !== "function" || typeof provider.execute !== "function") return false;
  providers.set(id, provider);
  return true;
}

export function getMovementRouteSamples(tokenDocument, movement = {}) {
  const waypoints = [
    {},
    ...(movement.passed?.waypoints ?? []),
    movement.destination
  ].filter(Boolean);
  const samples = waypoints
    .map(waypoint => ({ waypoint, point: getTokenCenterAt(tokenDocument, waypoint) }))
    .filter(sample => sample.point);
  const unique = [];
  const seen = new Set();
  for (const sample of samples) {
    const key = `${Math.round(sample.point.x)}:${Math.round(sample.point.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sample);
  }
  return unique;
}

export function getMovementSegmentSamples(tokenDocument, previous, current) {
  const start = previous?.point;
  const end = current?.point;
  if (!start || !end) return [previous, current].filter(Boolean);

  const gridSize = getSceneGridSize(tokenDocument?.parent ?? canvas.scene);
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, gridSize / 3)));
  const samples = [previous];
  const seen = new Set([getMovementSampleKey(previous)]);

  for (let step = 1; step < steps; step += 1) {
    const point = {
      x: start.x + ((end.x - start.x) * (step / steps)),
      y: start.y + ((end.y - start.y) * (step / steps))
    };
    const waypoint = createSnappedWaypointAtTokenCenter(tokenDocument, point, current.waypoint);
    const key = getPositionKey(waypoint);
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({ waypoint, point: getTokenCenterAt(tokenDocument, waypoint) });
  }

  const currentWaypoint = createSnappedWaypointAtTokenCenter(tokenDocument, current.point, current.waypoint);
  const currentKey = getPositionKey(currentWaypoint);
  if (!seen.has(currentKey)) {
    samples.push({ waypoint: currentWaypoint, point: getTokenCenterAt(tokenDocument, currentWaypoint) });
  }
  return samples.filter(sample => sample?.point);
}

function onPreMoveToken(tokenDocument, movement, options = {}) {
  if (options?.[CONTROLLED_MOVEMENT_INTERRUPTION_OPTION]) return true;
  if (game.paused) return false;
  if (!tokenDocument?.actor || !movement) return true;

  const candidates = [];
  for (const provider of providers.values()) {
    try {
      const entries = provider.collect({ tokenDocument, movement, options }) ?? [];
      for (const entry of entries) {
        if (!entry?.waypoint) continue;
        candidates.push({
          ...entry,
          providerId: provider.id,
          routeOrder: Math.max(0, Number(entry.routeOrder) || 0),
          priority: Number(entry.priority) || 0
        });
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Movement interruption provider failed: ${provider.id}`, error);
    }
  }
  if (!candidates.length) return true;

  candidates.sort((left, right) => (
    (left.routeOrder - right.routeOrder)
    || (left.priority - right.priority)
    || left.providerId.localeCompare(right.providerId)
  ));
  void runMovementInterruption(tokenDocument, movement, candidates[0]);
  return false;
}

async function runMovementInterruption(tokenDocument, movement, event) {
  const key = [
    tokenDocument?.parent?.id ?? "",
    tokenDocument?.id ?? "",
    movement?.id ?? "",
    event?.providerId ?? "",
    event?.eventId ?? event?.type ?? ""
  ].join(":");
  if (!tokenDocument || pendingMovementKeys.has(key)) return;
  pendingMovementKeys.add(key);
  try {
    if (event.moveToWaypoint !== false) {
      const reached = await moveTokenToInterruption(tokenDocument, event.waypoint, movement);
      if (!reached) return;
    }
    const provider = providers.get(event.providerId);
    if (provider) await provider.execute({ tokenDocument, movement, event });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Movement interruption failed: ${event?.providerId ?? "unknown"}`, error);
  } finally {
    pendingMovementKeys.delete(key);
  }
}

async function moveTokenToInterruption(tokenDocument, waypoint = {}, movement = {}) {
  const destination = prepareMovementWaypoint(waypoint, tokenDocument);
  if (!hasPositionChanged(tokenDocument, destination)) return true;
  await tokenDocument.move([destination], {
    [CONTROLLED_MOVEMENT_INTERRUPTION_OPTION]: true,
    autoRotate: Boolean(movement?.autoRotate),
    showRuler: false
  });
  await waitForMovementAnimation(tokenDocument);
  return isAtDestination(tokenDocument, destination);
}

function prepareMovementWaypoint(waypoint = {}, tokenDocument = null) {
  return {
    x: waypoint.x ?? tokenDocument?._source?.x ?? tokenDocument?.x,
    y: waypoint.y ?? tokenDocument?._source?.y ?? tokenDocument?.y,
    elevation: waypoint.elevation ?? tokenDocument?._source?.elevation ?? tokenDocument?.elevation,
    width: waypoint.width ?? tokenDocument?._source?.width ?? tokenDocument?.width,
    height: waypoint.height ?? tokenDocument?._source?.height ?? tokenDocument?.height,
    depth: waypoint.depth ?? tokenDocument?._source?.depth ?? tokenDocument?.depth,
    shape: waypoint.shape ?? tokenDocument?._source?.shape ?? tokenDocument?.shape,
    level: waypoint.level ?? tokenDocument?._source?.level ?? tokenDocument?.level,
    action: waypoint.action,
    snapped: waypoint.snapped,
    explicit: waypoint.explicit,
    checkpoint: true
  };
}

function hasPositionChanged(tokenDocument, destination = {}) {
  return (
    Number(destination.x) !== Number(tokenDocument?._source?.x ?? tokenDocument?.x)
    || Number(destination.y) !== Number(tokenDocument?._source?.y ?? tokenDocument?.y)
    || Number(destination.elevation) !== Number(tokenDocument?._source?.elevation ?? tokenDocument?.elevation)
  );
}

function isAtDestination(tokenDocument, destination = {}) {
  const epsilon = 1;
  return (
    Math.abs(Number(tokenDocument?._source?.x ?? tokenDocument?.x) - Number(destination.x)) <= epsilon
    && Math.abs(Number(tokenDocument?._source?.y ?? tokenDocument?.y) - Number(destination.y)) <= epsilon
    && Math.abs(Number(tokenDocument?._source?.elevation ?? tokenDocument?.elevation) - Number(destination.elevation)) <= epsilon
  );
}

async function waitForMovementAnimation(tokenDocument) {
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    await (tokenDocument?.movement?.animation?.ended ?? tokenDocument?.object?.movementAnimationPromise);
  } catch (_error) {
    // A different movement controller may stop the animation at the interruption checkpoint.
  }
}

function createSnappedWaypointAtTokenCenter(tokenDocument, point, sourceWaypoint = {}) {
  const document = tokenDocument?.document ?? tokenDocument;
  const width = sourceWaypoint?.width ?? document?._source?.width ?? document?.width;
  const height = sourceWaypoint?.height ?? document?._source?.height ?? document?.height;
  const depth = sourceWaypoint?.depth ?? document?._source?.depth ?? document?.depth;
  const shape = sourceWaypoint?.shape ?? document?._source?.shape ?? document?.shape;
  const level = sourceWaypoint?.level ?? document?._source?.level ?? document?.level;
  let pivot = null;
  if (typeof document?.getCenterPoint === "function") {
    pivot = document.getCenterPoint({ x: 0, y: 0, elevation: 0, width, height, depth, shape, level });
  }
  const size = getSceneGridSize(document?.parent ?? canvas.scene);
  const rawPosition = {
    x: Math.round(point.x - (Number(pivot?.x) || ((Number(width) || 1) * size / 2))),
    y: Math.round(point.y - (Number(pivot?.y) || ((Number(height) || 1) * size / 2))),
    elevation: sourceWaypoint?.elevation ?? document?._source?.elevation ?? document?.elevation,
    width,
    height,
    depth,
    shape,
    level
  };
  const snapped = document?.getSnappedPosition?.(rawPosition) ?? rawPosition;
  return {
    ...sourceWaypoint,
    x: Math.round(Number(snapped.x ?? rawPosition.x) || 0),
    y: Math.round(Number(snapped.y ?? rawPosition.y) || 0),
    elevation: snapped.elevation ?? rawPosition.elevation,
    width,
    height,
    depth,
    shape,
    level,
    snapped: true,
    checkpoint: true
  };
}

function getTokenCenterAt(tokenDocument, data = {}) {
  const document = tokenDocument?.document ?? tokenDocument;
  if (typeof document?.getCenterPoint === "function") {
    const center = document.getCenterPoint(data);
    return { x: Number(center.x) || 0, y: Number(center.y) || 0 };
  }
  const size = getSceneGridSize(document?.parent ?? canvas.scene);
  return {
    x: (Number(data.x ?? document?.x) || 0) + ((Number(data.width ?? document?.width) || 1) * size / 2),
    y: (Number(data.y ?? document?.y) || 0) + ((Number(data.height ?? document?.height) || 1) * size / 2)
  };
}

function getSceneGridSize(scene) {
  return Math.max(1, Number(scene?.grid?.size) || Number(canvas?.grid?.size) || 100);
}

function getPositionKey(waypoint = {}) {
  return `${Math.round(Number(waypoint?.x) || 0)}:${Math.round(Number(waypoint?.y) || 0)}:${Math.round(Number(waypoint?.elevation) || 0)}`;
}

function getMovementSampleKey(sample = {}) {
  const waypoint = sample.waypoint ?? {};
  if (Number.isFinite(Number(waypoint.x)) && Number.isFinite(Number(waypoint.y))) return getPositionKey(waypoint);
  const point = sample.point ?? {};
  return `${Math.round(Number(point.x) || 0)}:${Math.round(Number(point.y) || 0)}:${Math.round(Number(waypoint.elevation) || 0)}`;
}
