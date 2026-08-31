import { SYSTEM_ID } from "../constants.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { trackSystemMovementOperation } from "./movement-settlement.mjs";

export const CONTROLLED_MOVEMENT_INTERRUPTION_OPTION = "falloutMawControlledMovementInterruption";
export const SYSTEM_RELOCATION_OPTION = "falloutMawSystemRelocation";

const providers = new Map();
const pendingMovementKeys = new Set();
const pendingAcceptedCollections = new Map();
const controlledMovementContexts = new Map();
const movementEpochs = new Map();
const ATOMIC_MOVEMENT_UPDATES = Symbol("falloutMawAtomicMovementUpdates");
const movementRouteSampleCache = new WeakMap();
const movementSegmentSampleCache = new WeakMap();
let hooksRegistered = false;

export function registerMovementInterruptionHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("preMoveToken", onPreMoveToken);
  Hooks.on("preUpdateToken", onPreUpdateToken);
  Hooks.on("moveToken", onMoveToken);
  Hooks.on("deleteToken", tokenDocument => {
    const key = getTokenDocumentKey(tokenDocument);
    pendingAcceptedCollections.delete(key);
    controlledMovementContexts.delete(key);
    movementEpochs.delete(key);
  });
  Hooks.on("canvasTearDown", () => {
    pendingAcceptedCollections.clear();
    controlledMovementContexts.clear();
    movementEpochs.clear();
  });
}

/**
 * Register one deterministic movement-interruption source.
 *
 * `collect` must be side-effect free. Optional `commit` runs only after an
 * accepted movement (or when the selected provider explicitly confirms its
 * own deferred movement). A synchronous `buildAtomicMovementUpdate` may
 * instead contribute fields to the same Token update which Foundry already
 * performs for the accepted movement. `commitOnInterruption` lets a stateful
 * provider persist each actually accepted controlled-movement chunk when some
 * other provider wins.
 */
export function registerMovementInterruptionProvider(provider = {}) {
  const id = String(provider?.id ?? "").trim();
  if (!id || typeof provider.collect !== "function" || typeof provider.execute !== "function") return false;
  providers.set(id, provider);
  return true;
}

export function getMovementRouteSamples(tokenDocument, movement = {}) {
  const cached = readNestedWeakCache(movementRouteSampleCache, tokenDocument, movement);
  const immutableRoute = isImmutableMovementRoute(movement);
  const inputSignature = immutableRoute ? "" : getMovementRouteInputSignature(movement);
  if (cached && (immutableRoute || cached.inputSignature === inputSignature)) return cached.samples;
  const waypoints = [
    movement.origin ?? {},
    ...(movement.passed?.waypoints ?? [])
  ].filter(Boolean);
  if (
    movement.destination
    && (!waypoints.length || getPhysicalPositionKey(waypoints.at(-1)) !== getPhysicalPositionKey(movement.destination))
  ) waypoints.push(movement.destination);
  const samples = waypoints
    .map(waypoint => ({ waypoint, point: getTokenCenterAt(tokenDocument, waypoint) }))
    .filter(sample => sample.point);
  const unique = [];
  let previousKey = null;
  for (const sample of samples) {
    const key = getMovementSampleKey(sample);
    if (key === previousKey) continue;
    previousKey = key;
    unique.push(sample);
  }
  writeNestedWeakCache(movementRouteSampleCache, tokenDocument, movement, {
    inputSignature,
    samples: unique
  });
  return unique;
}

/**
 * V14 seals the preMoveToken operation and deep-freezes every route-bearing
 * property before hooks run; only autoRotate/showRuler remain writable. Check
 * both layers so synthetic shallow-frozen fixtures still receive signatures.
 */
function isImmutableMovementRoute(movement) {
  if (!movement || !Object.isSealed(movement)) return false;
  const passed = movement.passed;
  return Object.isFrozen(movement.origin)
    && Object.isFrozen(movement.destination)
    && Object.isFrozen(passed)
    && Object.isFrozen(passed?.waypoints);
}

export function getMovementSegmentSamples(tokenDocument, previous, current) {
  const cached = readTripleWeakCache(
    movementSegmentSampleCache,
    tokenDocument,
    previous,
    current
  );
  const inputSignature = `${getMovementSegmentInputSignature(previous)}>${getMovementSegmentInputSignature(current)}`;
  if (cached?.inputSignature === inputSignature) return cached.samples;
  const start = previous?.point;
  const end = current?.point;
  if (!start || !end) {
    const samples = [previous, current].filter(Boolean);
    writeTripleWeakCache(movementSegmentSampleCache, tokenDocument, previous, current, {
      inputSignature,
      samples
    });
    return samples;
  }

  const gridSize = getSceneGridSize(tokenDocument?.parent ?? globalThis.canvas?.scene);
  const startElevation = Number(start.elevation ?? previous?.waypoint?.elevation ?? tokenDocument?.elevation) || 0;
  const endElevation = Number(end.elevation ?? current?.waypoint?.elevation ?? tokenDocument?.elevation) || 0;
  const elevationPixels = sceneElevationToPixels(endElevation - startElevation, tokenDocument?.parent);
  const distance = Math.hypot(end.x - start.x, end.y - start.y, elevationPixels);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, gridSize / 3)));
  const samples = [previous];
  // Use the same top-left waypoint coordinate space for every de-duplication
  // key. Mixing the previous center with snapped waypoint positions creates a
  // false zero-length first segment on a square grid.
  const seen = new Set([getPhysicalPositionKey(previous.waypoint)]);

  for (let step = 1; step < steps; step += 1) {
    const point = {
      x: start.x + ((end.x - start.x) * (step / steps)),
      y: start.y + ((end.y - start.y) * (step / steps)),
      elevation: startElevation + ((endElevation - startElevation) * (step / steps))
    };
    const waypoint = createSnappedWaypointAtTokenCenter(tokenDocument, point, {
      ...current.waypoint,
      elevation: point.elevation
    });
    const key = getPhysicalPositionKey(waypoint);
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({ waypoint, point: getTokenCenterAt(tokenDocument, waypoint) });
  }

  const currentWaypoint = createSnappedWaypointAtTokenCenter(tokenDocument, current.point, current.waypoint);
  const currentKey = getPhysicalPositionKey(currentWaypoint);
  if (!seen.has(currentKey)) {
    samples.push({ waypoint: currentWaypoint, point: getTokenCenterAt(tokenDocument, currentWaypoint) });
  }
  const result = samples.filter(sample => sample?.point);
  writeTripleWeakCache(movementSegmentSampleCache, tokenDocument, previous, current, {
    inputSignature,
    samples: result
  });
  return result;
}

function getMovementRouteInputSignature(movement = {}) {
  const waypoints = [movement.origin, ...(movement.passed?.waypoints ?? []), movement.destination]
    .filter(Boolean);
  return waypoints.map(waypoint => [
    getExactNumberKey(waypoint.x),
    getExactNumberKey(waypoint.y),
    getExactNumberKey(waypoint.elevation),
    getExactNumberKey(waypoint.width),
    getExactNumberKey(waypoint.height),
    getExactNumberKey(waypoint.depth),
    String(waypoint.shape ?? ""),
    String(waypoint.level ?? ""),
    String(waypoint.action ?? ""),
    Boolean(waypoint.intermediate),
    Boolean(waypoint.checkpoint),
    Boolean(waypoint.explicit)
  ].join(":"))
    .join("|");
}

function getMovementSegmentInputSignature(sample = {}) {
  const point = sample?.point ?? {};
  return [
    getExactNumberKey(point.x),
    getExactNumberKey(point.y),
    getExactNumberKey(point.elevation),
    getPositionKey(sample?.waypoint),
    Boolean(sample?.waypoint?.intermediate),
    Boolean(sample?.waypoint?.checkpoint),
    Boolean(sample?.waypoint?.explicit)
  ].join(":");
}

function readNestedWeakCache(cache, first, second) {
  if (!isWeakCacheKey(first) || !isWeakCacheKey(second)) return null;
  return cache.get(first)?.get(second) ?? null;
}

function writeNestedWeakCache(cache, first, second, value) {
  if (!isWeakCacheKey(first) || !isWeakCacheKey(second)) return;
  let nested = cache.get(first);
  if (!nested) {
    nested = new WeakMap();
    cache.set(first, nested);
  }
  nested.set(second, value);
}

function readTripleWeakCache(cache, first, second, third) {
  if (!isWeakCacheKey(first) || !isWeakCacheKey(second) || !isWeakCacheKey(third)) return null;
  return cache.get(first)?.get(second)?.get(third) ?? null;
}

function writeTripleWeakCache(cache, first, second, third, value) {
  if (!isWeakCacheKey(first) || !isWeakCacheKey(second) || !isWeakCacheKey(third)) return;
  let bySecond = cache.get(first);
  if (!bySecond) {
    bySecond = new WeakMap();
    cache.set(first, bySecond);
  }
  let byThird = bySecond.get(second);
  if (!byThird) {
    byThird = new WeakMap();
    bySecond.set(second, byThird);
  }
  byThird.set(third, value);
}

function isWeakCacheKey(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function getMovementRouteWaypointProgress(tokenDocument, movement = {}) {
  const samples = getMovementRouteSamples(tokenDocument, movement);
  if (!samples.length) return [];
  const progress = [{ waypoint: samples[0].waypoint, routeOrder: 0 }];
  let routeOrder = 0;
  for (let index = 1; index < samples.length; index += 1) {
    routeOrder += Math.max(0, getMovementSegmentSamples(
      tokenDocument,
      samples[index - 1],
      samples[index]
    ).length - 1);
    progress.push({ waypoint: samples[index].waypoint, routeOrder });
  }
  return progress;
}

function onPreMoveToken(tokenDocument, movement, options = {}) {
  const tokenKey = getTokenDocumentKey(tokenDocument);
  if (tokenKey) pendingAcceptedCollections.delete(tokenKey);
  // Forced relocations (blinks, swaps, scripted teleports) have no traversed
  // route. Let Foundry commit them atomically without collecting ordinary
  // movement interruptions along the line between both positions.
  if (options?.[SYSTEM_RELOCATION_OPTION]) {
    beginMovementEpoch(tokenDocument);
    return true;
  }
  const controlledContext = getControlledMovementContext(tokenDocument, movement, options);
  if (controlledContext) {
    prepareControlledAtomicUpdates(tokenDocument, movement, options, controlledContext);
    return true;
  }
  const movementEpoch = beginMovementEpoch(tokenDocument);
  // Foundry V14 applies paste/undo position changes together with
  // _movementHistory. Cancelling preMoveToken would leave the history update
  // detached from the position update, so these native operations must remain
  // fail-open and bypass interruption providers entirely.
  if (options?.isUndo || options?.isPaste) return true;
  if (game.paused) return false;
  if (!tokenDocument?.actor || !movement) return true;

  const candidates = [];
  const collections = [];
  for (const provider of providers.values()) {
    try {
      const collection = provider.collect({ tokenDocument, movement, options }) ?? [];
      const entries = Array.isArray(collection) ? collection : (collection?.events ?? []);
      collections.push({ provider, collection });
      for (const entry of entries) {
        if (!entry?.waypoint) continue;
        candidates.push({
          ...entry,
          _collection: collection,
          providerId: provider.id,
          routeOrder: Math.max(0, Number(entry.routeOrder) || 0),
          priority: Number(entry.priority) || 0
        });
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Movement interruption provider failed: ${provider.id}`, error);
    }
  }
  if (!candidates.length) {
    const committable = collections.filter(({ provider, collection }) => hasProviderCommitWork(provider, collection));
    const deferred = [];
    for (const entry of committable) {
      if (queueAtomicMovementUpdate(tokenDocument, movement, options, entry)) continue;
      if (typeof entry.provider?.commit === "function") deferred.push(entry);
    }
    if (tokenKey && deferred.length) {
      pendingAcceptedCollections.set(tokenKey, {
        movementId: String(movement?.id ?? ""),
        tokenDocument,
        movement,
        options,
        collections: deferred
      });
    }
    return true;
  }

  normalizeCandidateRouteOrders(tokenDocument, movement, candidates);
  candidates.sort((left, right) => (
    (left.routeOrder - right.routeOrder)
    || (left.priority - right.priority)
    || left.providerId.localeCompare(right.providerId)
  ));
  trackSystemMovementOperation(
    tokenDocument,
    runMovementInterruption(tokenDocument, movement, candidates[0], options, collections, movementEpoch)
  );
  return false;
}

function normalizeCandidateRouteOrders(tokenDocument, movement, candidates) {
  const samples = getMovementRouteSamples(tokenDocument, movement);
  const routeOrders = new Map();
  let routeOrder = 0;
  const addRouteOrder = (key, order) => {
    const orders = routeOrders.get(key) ?? [];
    orders.push(order);
    routeOrders.set(key, orders);
  };
  if (samples[0]?.waypoint) addRouteOrder(getPositionKey(samples[0].waypoint), 0);
  for (let index = 1; index < samples.length; index += 1) {
    const segmentSamples = getMovementSegmentSamples(tokenDocument, samples[index - 1], samples[index]);
    for (const sample of segmentSamples.slice(1)) {
      routeOrder += 1;
      const key = getPositionKey(sample.waypoint);
      addRouteOrder(key, routeOrder);
    }
  }
  for (const candidate of candidates) {
    const orders = routeOrders.get(getPositionKey(candidate.waypoint)) ?? [];
    if (!orders.length) continue;
    candidate.routeOrder = orders.reduce((closest, order) => (
      Math.abs(order - candidate.routeOrder) < Math.abs(closest - candidate.routeOrder) ? order : closest
    ), orders[0]);
  }
}

function onPreUpdateToken(tokenDocument, changes, options = {}) {
  const atomicUpdates = options?.[ATOMIC_MOVEMENT_UPDATES];
  if (!Array.isArray(atomicUpdates) || !atomicUpdates.length) return;
  const tokenId = String(tokenDocument?.id ?? "");
  const tokenKey = getTokenDocumentKey(tokenDocument);
  const matchingUpdates = atomicUpdates.filter(update => (
    update.tokenId === tokenId && update.tokenKey === tokenKey
  ));
  if (!matchingUpdates.length) return;
  const remainingUpdates = atomicUpdates.filter(update => !matchingUpdates.includes(update));
  atomicUpdates.splice(0, atomicUpdates.length, ...remainingUpdates);
  if (!atomicUpdates.length) delete options[ATOMIC_MOVEMENT_UPDATES];

  const acceptedMovement = options?._movement?.[tokenDocument?.id]
    ?? options?._movement?.get?.(tokenDocument?.id)
    ?? null;
  const acceptedMovementId = String(acceptedMovement?.id ?? "");
  if (!acceptedMovementId) return;

  for (const atomicUpdate of matchingUpdates) {
    if (atomicUpdate.movementId !== acceptedMovementId) continue;
    for (const [path, value] of Object.entries(atomicUpdate.patch)) {
      setPropertyPath(changes, path, value);
    }
    atomicUpdate.appliedProviderIds?.add(atomicUpdate.providerId);
  }
}

function queueAtomicMovementUpdate(
  tokenDocument,
  movement,
  options,
  { provider, collection },
  { selectedEvent = null, appliedProviderIds = null } = {}
) {
  if (typeof provider?.buildAtomicMovementUpdate !== "function") return false;
  let patch;
  try {
    patch = provider.buildAtomicMovementUpdate({
      tokenDocument,
      movement,
      options,
      collection,
      selectedEvent
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Movement interruption provider atomic update failed: ${provider.id}`, error);
    return false;
  }
  if (patch?.then) {
    console.error(`${SYSTEM_ID} | Movement interruption atomic builders must be synchronous: ${provider.id}`);
    return false;
  }
  if (!patch || typeof patch !== "object" || !Object.keys(patch).length) return false;

  let atomicUpdates = options?.[ATOMIC_MOVEMENT_UPDATES];
  if (!Array.isArray(atomicUpdates)) {
    atomicUpdates = [];
    try {
      Object.defineProperty(options, ATOMIC_MOVEMENT_UPDATES, {
        configurable: true,
        enumerable: false,
        value: atomicUpdates
      });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Unable to attach an atomic movement update`, error);
      return false;
    }
  }
  atomicUpdates.push({
    tokenId: String(tokenDocument?.id ?? ""),
    tokenKey: getTokenDocumentKey(tokenDocument),
    movementId: String(movement?.id ?? ""),
    providerId: provider.id,
    patch,
    appliedProviderIds
  });
  return true;
}

function prepareControlledAtomicUpdates(tokenDocument, movement, options, context) {
  for (const provider of context.atomicProviders) {
    try {
      const collection = provider.collect({ tokenDocument, movement, options }) ?? [];
      if (!hasProviderCommitWork(provider, collection)) continue;
      const queued = queueAtomicMovementUpdate(tokenDocument, movement, options, { provider, collection }, {
        appliedProviderIds: context.appliedProviderIds
      });
      if (!queued) context.failedProviderIds.add(provider.id);
    } catch (error) {
      context.failedProviderIds.add(provider.id);
      console.error(`${SYSTEM_ID} | Controlled movement atomic collection failed: ${provider.id}`, error);
    }
  }
}

function setPropertyPath(target, path, value) {
  const parts = String(path ?? "").split(".").filter(Boolean);
  if (!parts.length) return;
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    current = current[part] = existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {};
  }
  current[parts.at(-1)] = value;
}

function onMoveToken(tokenDocument, movement, options = {}) {
  if (options?.[SYSTEM_RELOCATION_OPTION]) return;
  const tokenKey = getTokenDocumentKey(tokenDocument);
  const pending = tokenKey ? pendingAcceptedCollections.get(tokenKey) : null;
  const committedProviderIds = new Set();
  if (pending && pending.movementId === String(movement?.id ?? "")) {
    pendingAcceptedCollections.delete(tokenKey);
    for (const { provider, collection } of pending.collections) {
      committedProviderIds.add(provider.id);
      void commitProviderCollection(provider, {
        tokenDocument,
        movement: pending.movement,
        options: pending.options,
        collection,
        selectedEvent: null
      }).catch(() => undefined);
    }
  }

  for (const provider of providers.values()) {
    if (provider.synchronizeOnMove !== true || committedProviderIds.has(provider.id)) continue;
    try {
      if (typeof provider.synchronize === "function") {
        const synchronized = provider.synchronize({ tokenDocument, movement, options });
        if (synchronized?.then) {
          void synchronized.catch(error => console.error(
            `${SYSTEM_ID} | Movement interruption provider synchronization failed: ${provider.id}`,
            error
          ));
        }
        continue;
      }
      const collection = provider.collect({ tokenDocument, movement, options }) ?? [];
      if (typeof provider.commit === "function") {
        void commitProviderCollection(provider, {
          tokenDocument,
          movement,
          options,
          collection,
          selectedEvent: null
        }).catch(() => undefined);
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Movement interruption provider synchronization failed: ${provider.id}`, error);
    }
  }
}

async function runMovementInterruption(
  tokenDocument,
  movement,
  event,
  options = {},
  collections = [],
  movementEpoch = 0
) {
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
    const inheritedChainRef = options?.falloutMawSystemEventChainRef ?? options?.chainRef ?? null;
    await withSystemEventRoot({
      kind: "movementInterruption",
      operationId: `movement-interruption:${key}`,
      sceneUuid: String(tokenDocument?.parent?.uuid ?? ""),
      combatUuid: String(game.combat?.uuid ?? ""),
      chainRef: inheritedChainRef
    }, async scope => {
      const participants = createMovementInterruptionParticipants(tokenDocument, event);
      const requested = await scope.emit("fallout-maw.movement.token.interruptionRequested", {
        data: createMovementInterruptionData(movement, event)
      }, {
        occurrenceKey: `${key}:requested`,
        participants
      });
      if (requested?.control?.current || requested?.control?.remaining || requested?.control?.root) return;
      if (!isMovementEpochCurrent(tokenDocument, movementEpoch) || !isAtMovementOrigin(tokenDocument, movement)) return;
      const provider = providers.get(event.providerId);
      const appliedProviderIds = new Set();
      const failedProviderIds = new Set();
      const atomicProviders = collections
        .filter(entry => (
          typeof entry.provider?.buildAtomicMovementUpdate === "function"
          && hasProviderCommitWork(entry.provider, entry.collection)
          && (entry.provider.id === event.providerId || entry.provider.commitOnInterruption === true)
        ))
        .map(entry => entry.provider);
      let committed = false;
      const commit = async () => {
        if (committed) return;
        committed = true;
        for (const entry of collections) {
          if (typeof entry.provider?.commit !== "function") continue;
          if (entry.provider.id !== event.providerId && entry.provider.commitOnInterruption !== true) continue;
          if (appliedProviderIds.has(entry.provider.id) && !failedProviderIds.has(entry.provider.id)) continue;
          await commitProviderCollection(entry.provider, {
            tokenDocument,
            movement,
            options,
            collection: entry.collection,
            selectedEvent: event
          });
        }
      };
      if (event.moveToWaypoint !== false) {
        const reached = await moveTokenToInterruption(tokenDocument, event, movement, options, scope.chainRef, {
          atomicProviders,
          appliedProviderIds,
          failedProviderIds
        });
        if (!reached) {
          if (!isMovementEpochCurrent(tokenDocument, movementEpoch)) return;
          await commitPhysicallyReachedPrefix(
            tokenDocument,
            movement,
            options,
            collections,
            event,
            appliedProviderIds,
            failedProviderIds
          );
          return;
        }
        if (!isMovementEpochCurrent(tokenDocument, movementEpoch)) return;
        await commit();
      }
      await scope.emit("fallout-maw.movement.token.interrupted", {
        data: createMovementInterruptionData(movement, event),
        outcome: { interrupted: true, providerId: event.providerId }
      }, {
        occurrenceKey: `${key}:interrupted`,
        participants
      });
      if (event.moveToWaypoint !== false && !isAtDestination(tokenDocument, event.waypoint)) return;
      if (provider) {
        await provider.execute({
          tokenDocument,
          movement,
          event,
          options,
          chainRef: scope.chainRef,
          collection: event._collection,
          commit,
          isCurrent: () => (
            isMovementEpochCurrent(tokenDocument, movementEpoch)
            && (event.moveToWaypoint === false || isAtDestination(tokenDocument, event.waypoint))
          )
        });
      }
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Movement interruption failed: ${event?.providerId ?? "unknown"}`, error);
  } finally {
    pendingMovementKeys.delete(key);
  }
}

async function commitProviderCollection(provider, context) {
  try {
    await provider.commit(context);
  } catch (error) {
    console.error(`${SYSTEM_ID} | Movement interruption provider commit failed: ${provider.id}`, error);
    throw error;
  }
}

function getTokenDocumentKey(tokenDocument) {
  return String(tokenDocument?.uuid ?? [tokenDocument?.parent?.id ?? "", tokenDocument?.id ?? ""].join(":"));
}

function hasProviderCommitWork(provider, collection) {
  if (typeof provider?.commit !== "function" && typeof provider?.buildAtomicMovementUpdate !== "function") return false;
  if (typeof provider.hasCommitWork !== "function") return true;
  try {
    return Boolean(provider.hasCommitWork(collection));
  } catch (error) {
    console.error(`${SYSTEM_ID} | Movement interruption provider commit probe failed: ${provider.id}`, error);
    return false;
  }
}

function beginMovementEpoch(tokenDocument) {
  const key = getTokenDocumentKey(tokenDocument);
  const epoch = (movementEpochs.get(key) ?? 0) + 1;
  movementEpochs.set(key, epoch);
  return epoch;
}

function isMovementEpochCurrent(tokenDocument, epoch) {
  return movementEpochs.get(getTokenDocumentKey(tokenDocument)) === epoch;
}

function isAtMovementOrigin(tokenDocument, movement = {}) {
  return positionsMatch(tokenDocument, prepareMovementWaypoint(movement.origin ?? {}, tokenDocument));
}

function getControlledMovementContext(tokenDocument, movement = {}, operation = {}) {
  const contexts = controlledMovementContexts.get(getTokenDocumentKey(tokenDocument)) ?? [];
  if (!contexts.length) return null;
  const chain = Array.isArray(movement.chain) ? movement.chain : [];
  let context = null;
  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    const candidate = contexts[index];
    if (chain.some(movementId => candidate.movementIds.has(String(movementId)))) {
      context = candidate;
      break;
    }
  }
  if (!context && operation?.[CONTROLLED_MOVEMENT_INTERRUPTION_OPTION]) context = contexts.at(-1);
  if (!context) return null;
  if (movement.id) context.movementIds.add(String(movement.id));
  return context;
}

/**
 * Return whether a Foundry movement chunk belongs to an active controlled
 * interruption. Foundry only carries its documented update options into an
 * automatic checkpoint continuation, so callers must also recognize the
 * native movement chain instead of relying on a private option alone.
 */
export function isControlledMovementInterruption(tokenDocument, movement = {}, operation = {}) {
  return Boolean(getControlledMovementContext(tokenDocument, movement, operation));
}

async function performControlledMovement(
  tokenDocument,
  waypoints,
  options = {},
  { atomicProviders = [], appliedProviderIds = new Set(), failedProviderIds = new Set() } = {}
) {
  const key = getTokenDocumentKey(tokenDocument);
  const contexts = controlledMovementContexts.get(key) ?? [];
  const context = { movementIds: new Set(), atomicProviders, appliedProviderIds, failedProviderIds };
  contexts.push(context);
  controlledMovementContexts.set(key, contexts);
  try {
    return await tokenDocument.move(waypoints, {
      ...options,
      [CONTROLLED_MOVEMENT_INTERRUPTION_OPTION]: true
    });
  } finally {
    const index = contexts.lastIndexOf(context);
    if (index >= 0) contexts.splice(index, 1);
    if (!contexts.length && controlledMovementContexts.get(key) === contexts) controlledMovementContexts.delete(key);
  }
}

async function commitPhysicallyReachedPrefix(
  tokenDocument,
  movement,
  options,
  collections,
  selectedEvent,
  appliedProviderIds = new Set(),
  failedProviderIds = new Set()
) {
  const reachedEvent = createPhysicallyReachedEvent(tokenDocument, movement, selectedEvent);
  if (reachedEvent.routeOrder <= 0) return;
  for (const { provider, collection } of collections) {
    if (provider.commitOnInterruption !== true || typeof provider.commit !== "function") continue;
    if (appliedProviderIds.has(provider.id) && !failedProviderIds.has(provider.id)) continue;
    await commitProviderCollection(provider, {
      tokenDocument,
      movement,
      options,
      collection,
      selectedEvent: reachedEvent
    });
  }
}

function createPhysicallyReachedEvent(tokenDocument, movement, selectedEvent = null) {
  const source = prepareMovementWaypoint(tokenDocument?._source ?? tokenDocument ?? {}, tokenDocument);
  const samples = getMovementRouteSamples(tokenDocument, movement);
  const targetKey = getPositionKey(source);
  let routeOrder = 0;
  let closest = { routeOrder: 0, distance: getWaypointDistanceSquared(movement.origin, source, tokenDocument?.parent) };
  for (let index = 1; index < samples.length; index += 1) {
    const segmentSamples = getMovementSegmentSamples(tokenDocument, samples[index - 1], samples[index]);
    for (const sample of segmentSamples.slice(1)) {
      routeOrder += 1;
      if (getPositionKey(sample.waypoint) === targetKey) {
        return {
          ...selectedEvent,
          providerId: "foundryMovement",
          interruptedProviderId: selectedEvent?.providerId ?? "",
          waypoint: source,
          routeOrder
        };
      }
      const distance = getWaypointDistanceSquared(sample.waypoint, source, tokenDocument?.parent);
      if (distance < closest.distance) closest = { routeOrder, distance };
    }
  }
  return {
    ...selectedEvent,
    providerId: "foundryMovement",
    interruptedProviderId: selectedEvent?.providerId ?? "",
    waypoint: source,
    routeOrder: closest.routeOrder
  };
}

function getWaypointDistanceSquared(left = {}, right = {}, scene = null) {
  const dx = (Number(left?.x) || 0) - (Number(right?.x) || 0);
  const dy = (Number(left?.y) || 0) - (Number(right?.y) || 0);
  const dz = sceneElevationToPixels((Number(left?.elevation) || 0) - (Number(right?.elevation) || 0), scene);
  return (dx * dx) + (dy * dy) + (dz * dz);
}

export function getMovementPrefixWaypoints(tokenDocument, movement = {}, event = {}) {
  const destination = prepareMovementWaypoint(event.waypoint ?? movement.destination ?? {}, tokenDocument);
  const targetOrder = Math.max(0, Number(event.routeOrder) || 0);
  const targetKey = getPositionKey(destination);
  const samples = getMovementRouteSamples(tokenDocument, movement);
  const prefix = [];
  let routeOrder = 0;

  for (let index = 1; index < samples.length; index += 1) {
    const segmentSamples = getMovementSegmentSamples(tokenDocument, samples[index - 1], samples[index]);
    let reached = false;
    for (const sample of segmentSamples.slice(1)) {
      routeOrder += 1;
      const exactTarget = getPositionKey(sample.waypoint) === targetKey;
      if ((targetOrder > 0 && routeOrder >= targetOrder) || (targetOrder === 0 && exactTarget)) {
        reached = true;
        break;
      }
    }
    if (reached) {
      appendRouteWaypoint(prefix, destination);
      return prepareRouteWaypoints(prefix);
    }
    if (!samples[index].waypoint?.intermediate) appendRouteWaypoint(prefix, samples[index].waypoint);
  }

  appendRouteWaypoint(prefix, destination);
  return prepareRouteWaypoints(prefix);
}

function prepareRouteWaypoints(waypoints = []) {
  const prepared = [];
  for (const waypoint of waypoints.filter(Boolean)) appendRouteWaypoint(prepared, waypoint);
  if (prepared.length) prepared.at(-1).checkpoint = true;
  return prepared;
}

function appendRouteWaypoint(waypoints, source = {}) {
  const waypoint = pickMovementWaypoint(source);
  const previous = waypoints.at(-1);
  if (previous && getPositionKey(previous) === getPositionKey(waypoint)) {
    waypoints[waypoints.length - 1] = waypoint;
  } else {
    waypoints.push(waypoint);
  }
}

function pickMovementWaypoint(source = {}) {
  const waypoint = {};
  for (const key of [
    "x", "y", "elevation", "width", "height", "depth", "shape", "level",
    "action", "snapped", "explicit", "checkpoint"
  ]) {
    if (source[key] !== undefined) waypoint[key] = source[key];
  }
  return waypoint;
}

export function createMovementOptions(
  movement = {},
  operation = {},
  { chainRef = null, showRuler = false, split: splitOverride } = {}
) {
  const method = movement.method ?? (operation?.isPaste ? "paste" : (operation?.isUndo ? "undo" : undefined));
  const options = {
    method,
    autoRotate: Boolean(movement.autoRotate),
    showRuler: Boolean(showRuler),
    terrainOptions: movement.terrainOptions,
    constrainOptions: movement.constrainOptions,
    measureOptions: movement.measureOptions
  };
  const split = splitOverride !== undefined ? splitOverride : (movement.split ?? operation?.split);
  if (split !== undefined) options.split = split;
  for (const key of ["pan", "animate", "animation", "render", "renderSheet", "noHook", "diff"]) {
    if (operation?.[key] !== undefined) options[key] = operation[key];
  }
  if (method === "paste" || operation?.isPaste) options.isPaste = true;
  if (method === "undo" || operation?.isUndo) options.isUndo = true;
  if (chainRef) {
    options.chainRef = chainRef;
    options.falloutMawSystemEventChainRef = chainRef;
  }
  return options;
}

async function moveTokenToInterruption(
  tokenDocument,
  event = {},
  movement = {},
  operation = {},
  chainRef = null,
  controlledOptions = {}
) {
  const destination = prepareMovementWaypoint(event.waypoint, tokenDocument);
  if (!hasPositionChanged(tokenDocument, destination)) return true;
  const waypoints = getMovementPrefixWaypoints(tokenDocument, movement, event);
  const completed = await performControlledMovement(tokenDocument, waypoints, createMovementOptions(
    movement,
    operation,
    { chainRef, showRuler: false }
  ), controlledOptions);
  // Foundry V14 resolves TokenDocument#move only after the movement workflow,
  // including its animation, has completed or been prevented.
  if (!completed) return false;
  return isAtDestination(tokenDocument, destination);
}

function createMovementInterruptionParticipants(tokenDocument, event = {}) {
  return {
    source: {
      actorUuid: String(tokenDocument?.actor?.uuid ?? ""),
      tokenUuid: String(tokenDocument?.uuid ?? ""),
      itemUuid: ""
    },
    target: null,
    related: Array.from(new Set(event?.reactorTokenUuids ?? [])).map(tokenUuid => ({
      actorUuid: "",
      tokenUuid: String(tokenUuid ?? ""),
      itemUuid: ""
    })).filter(participant => participant.tokenUuid)
  };
}

function createMovementInterruptionData(movement = {}, event = {}) {
  return {
    movementId: String(movement?.id ?? ""),
    providerId: String(event?.providerId ?? ""),
    type: String(event?.type ?? ""),
    eventId: String(event?.eventId ?? ""),
    routeOrder: Math.max(0, Number(event?.routeOrder) || 0),
    waypoint: event?.waypoint ? {
      x: Number(event.waypoint.x) || 0,
      y: Number(event.waypoint.y) || 0,
      elevation: Number(event.waypoint.elevation) || 0
    } : null
  };
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
  return !positionsMatch(tokenDocument, destination, { coordinateEpsilon: 0 });
}

function isAtDestination(tokenDocument, destination = {}) {
  return positionsMatch(tokenDocument, destination, { coordinateEpsilon: 1 });
}

function positionsMatch(tokenDocument, destination = {}, { coordinateEpsilon = 0 } = {}) {
  const source = tokenDocument?._source ?? tokenDocument ?? {};
  const numericFields = ["x", "y", "elevation", "width", "height", "depth"];
  for (const field of numericFields) {
    const sourceValue = Number(source[field] ?? destination[field] ?? 0);
    const destinationValue = Number(destination[field] ?? source[field] ?? 0);
    const difference = Math.abs(sourceValue - destinationValue);
    const epsilon = (field === "x" || field === "y") ? coordinateEpsilon : 0.000001;
    if (!Number.isFinite(difference) || difference > epsilon) return false;
  }
  const sourceShape = source.shape ?? destination.shape ?? "";
  const destinationShape = destination.shape ?? source.shape ?? "";
  const sourceLevel = source.level ?? destination.level ?? "";
  const destinationLevel = destination.level ?? source.level ?? "";
  return String(sourceShape) === String(destinationShape)
    && String(sourceLevel) === String(destinationLevel);
}

export function createSnappedWaypointAtTokenCenter(tokenDocument, point, sourceWaypoint = {}) {
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
  const size = getSceneGridSize(document?.parent ?? globalThis.canvas?.scene);
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
    // V14 getSnappedPosition also snaps elevation to grid.distance. Movement
    // waypoints explicitly allow fractional elevation, so only XY is adopted.
    elevation: rawPosition.elevation,
    width,
    height,
    depth,
    shape,
    level,
    snapped: true,
    checkpoint: true
  };
}

export function getTokenCenterAt(tokenDocument, data = {}) {
  const document = tokenDocument?.document ?? tokenDocument;
  if (typeof document?.getCenterPoint === "function") {
    const center = document.getCenterPoint(data);
    return {
      x: Number(center.x) || 0,
      y: Number(center.y) || 0,
      elevation: Number(center.elevation ?? data.elevation ?? document?.elevation) || 0
    };
  }
  const size = getSceneGridSize(document?.parent ?? globalThis.canvas?.scene);
  return {
    x: (Number(data.x ?? document?.x) || 0) + ((Number(data.width ?? document?.width) || 1) * size / 2),
    y: (Number(data.y ?? document?.y) || 0) + ((Number(data.height ?? document?.height) || 1) * size / 2),
    elevation: Number(data.elevation ?? document?.elevation) || 0
  };
}

function getSceneGridSize(scene) {
  return Math.max(1, Number(scene?.grid?.size) || Number(globalThis.canvas?.grid?.size) || 100);
}

function sceneElevationToPixels(elevation, scene = null) {
  const activeScene = scene ?? globalThis.canvas?.scene;
  const gridSize = getSceneGridSize(activeScene);
  const gridDistance = Math.max(0.0001, Number(activeScene?.grid?.distance ?? globalThis.canvas?.grid?.distance) || 1);
  return (Number(elevation) || 0) * (gridSize / gridDistance);
}

function getPositionKey(waypoint = {}) {
  return [
    Math.round(Number(waypoint?.x) || 0),
    Math.round(Number(waypoint?.y) || 0),
    getExactNumberKey(waypoint?.elevation),
    getExactNumberKey(waypoint?.width),
    getExactNumberKey(waypoint?.height),
    getExactNumberKey(waypoint?.depth),
    String(waypoint?.shape ?? ""),
    String(waypoint?.level ?? ""),
    String(waypoint?.action ?? "")
  ].join(":");
}

function getPhysicalPositionKey(waypoint = {}) {
  return [
    Math.round(Number(waypoint?.x) || 0),
    Math.round(Number(waypoint?.y) || 0),
    getExactNumberKey(waypoint?.elevation),
    getExactNumberKey(waypoint?.width),
    getExactNumberKey(waypoint?.height),
    getExactNumberKey(waypoint?.depth),
    String(waypoint?.shape ?? ""),
    String(waypoint?.level ?? "")
  ].join(":");
}

function getMovementSampleKey(sample = {}) {
  const waypoint = sample.waypoint ?? {};
  const point = sample.point ?? {};
  return [
    Math.round(Number(point.x ?? waypoint.x) || 0),
    Math.round(Number(point.y ?? waypoint.y) || 0),
    getExactNumberKey(point.elevation ?? waypoint.elevation),
    getExactNumberKey(waypoint.width),
    getExactNumberKey(waypoint.height),
    getExactNumberKey(waypoint.depth),
    String(waypoint.shape ?? ""),
    String(waypoint.level ?? ""),
    String(waypoint.action ?? ""),
    String(Boolean(waypoint.checkpoint)),
    String(Boolean(waypoint.explicit)),
    String(Boolean(waypoint.snapped))
  ].join(":");
}

function getExactNumberKey(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "";
}
