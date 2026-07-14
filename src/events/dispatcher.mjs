import { SYSTEM_ID } from "../constants.mjs";
import {
  getSelectableSystemEvents as getCatalogSelectableSystemEvents,
  getSystemEventDescriptor
} from "./catalog.mjs";

export const SYSTEM_EVENT_DISPATCHER_LIMITS = Object.freeze({
  maxDepth: 12,
  maxEventsPerRoot: 256,
  maxReactionsPerRoot: 64,
  rootWatchdogMs: 10 * 60 * 1000,
  requestTimeoutMs: 11 * 60 * 1000,
  completedCacheSize: 2048,
  completedCacheTtlMs: 5 * 60 * 1000
});

export const SYSTEM_EVENT_SOCKET_SCOPE = "fallout-maw.systemEvents";
export const SYSTEM_EVENT_CHAIN_VERSION = 1;

const SYSTEM_EVENT_SOCKET = `system.${SYSTEM_ID}`;
const JSON_PATCH_OPERATIONS = new Set(["add", "remove", "replace"]);
const CANCEL_SCOPES = new Set(["current", "remaining", "root"]);
const PATCH_CAPABILITIES = new Set(["modify", "modifySync", "patch"]);
const LEGACY_CANCEL_CAPABILITIES = new Set(["cancel", "cancelSync", "interrupt"]);
const CANCEL_CAPABILITIES_BY_SCOPE = Object.freeze({
  current: new Set(["cancelCurrent", "cancel", "cancelSync", "interrupt"]),
  remaining: new Set(["cancelRemaining", "cancel", "cancelSync", "interrupt"]),
  root: new Set(["cancelRoot", "cancel", "cancelSync"])
});

/**
 * Create an isolated system-event dispatcher. All Foundry access is supplied by the runtime adapter so the core can
 * be exercised in plain Node tests.
 */
export function createSystemEventDispatcher({
  catalog = {},
  runtime = {},
  limits = {}
} = {}) {
  const resolvedCatalog = {
    getDescriptor: typeof catalog.getDescriptor === "function"
      ? catalog.getDescriptor
      : getSystemEventDescriptor,
    getSelectable: typeof catalog.getSelectable === "function"
      ? catalog.getSelectable
      : getCatalogSelectableSystemEvents
  };
  const resolvedRuntime = normalizeRuntime(runtime);
  const resolvedLimits = normalizeLimits(limits);

  const interceptors = new Map();
  const observers = new Map();
  const rootFinalizers = new Map();
  const roots = new Map();
  const operationRoots = new Map();
  const closedRoots = new Map();
  const inFlightEvents = new Map();
  const completedEvents = new Map();
  const pendingSocketRequests = new Map();
  const authorityRpcInFlight = new Map();
  const authorityRpcCompleted = new Map();
  let registrationSequence = 0;
  let socketRegistered = false;

  function registerInterceptor(registration = {}) {
    return registerHandler(interceptors, "interceptor", registration, "intercept");
  }

  function registerObserver(registration = {}) {
    return registerHandler(observers, "observer", registration, "observe");
  }

  function registerRootFinalizer(registration = {}) {
    const id = normalizeRequiredId(registration.id, "Root finalizer");
    const finalize = registration.finalize;
    if (typeof finalize !== "function") throw new TypeError(`Root finalizer '${id}' requires a finalize function.`);
    const entry = Object.freeze({
      id,
      priority: toInteger(registration.priority),
      sequence: registrationSequence++,
      finalize
    });
    rootFinalizers.set(id, entry);
    return () => {
      if (rootFinalizers.get(id) === entry) rootFinalizers.delete(id);
    };
  }

  function registerHandler(registry, kind, registration, callbackKey) {
    const id = normalizeRequiredId(registration.id, capitalize(kind));
    const callback = registration[callbackKey] ?? registration.handle;
    if (typeof callback !== "function") throw new TypeError(`${capitalize(kind)} '${id}' requires a ${callbackKey} function.`);
    const entry = Object.freeze({
      id,
      kind,
      eventKeys: normalizeEventKeys(registration.eventKeys),
      priority: toInteger(registration.priority),
      sequence: registrationSequence++,
      guardRecursion: registration.guardRecursion !== false,
      callback
    });
    registry.set(id, entry);
    return () => {
      if (registry.get(id) === entry) registry.delete(id);
    };
  }

  const activeRootMetaStack = [];

  function getActiveSystemEventOperationId() {
    for (let index = activeRootMetaStack.length - 1; index >= 0; index -= 1) {
      const operationId = String(activeRootMetaStack[index]?.data?.systemEventOperationId ?? "").trim();
      if (operationId) return operationId;
    }
    return "";
  }

  async function withRoot(meta = {}, operation) {
    if (typeof operation !== "function") throw new TypeError("withSystemEventRoot requires an operation function.");
    const normalizedMeta = normalizeRootMeta(meta, resolvedRuntime.randomId);
    activeRootMetaStack.push(normalizedMeta);
    try {
      let opened;
      try {
        opened = normalizedMeta.chainRef
          ? await requestAuthority("acquireRoot", { chainRef: normalizedMeta.chainRef, meta: normalizedMeta })
          : await requestAuthority("openRoot", { meta: normalizedMeta });
      } catch (error) {
        const code = String(error?.code ?? "");
        const canRetryFresh = Boolean(normalizedMeta.chainRef)
          && ["invalidLease", "expiredLineage", "unknownRoot", "rootClosed", "rootClosing"].includes(code);
        if (canRetryFresh) {
          try {
            opened = await requestAuthority("openRoot", {
              meta: { ...normalizedMeta, chainRef: null }
            });
          } catch (retryError) {
            logFailOpen("System event root could not be opened", retryError);
            return operation(createDetachedScope(normalizedMeta, retryError));
          }
        } else {
          logFailOpen("System event root could not be opened", error);
          return operation(createDetachedScope(normalizedMeta, error));
        }
      }

      const scope = createClientScope(opened.chainRef, normalizedMeta);
      try {
        return await operation(scope);
      } finally {
        try {
          await requestAuthority("releaseRoot", {
            chainRef: opened.chainRef,
            requestClose: Boolean(opened.owner)
          });
        } catch (error) {
          logFailOpen(`System event root '${opened.rootId}' could not be closed`, error);
        }
      }
    } finally {
      activeRootMetaStack.pop();
    }
  }

  async function dispatch(eventKey, payload = {}, options = {}) {
    const normalizedOptions = normalizeDispatchOptions(options, resolvedRuntime.randomId);
    return withRoot({
      kind: normalizedOptions.kind || String(eventKey ?? ""),
      operationId: normalizedOptions.operationId,
      sceneUuid: normalizedOptions.sceneUuid,
      combatUuid: normalizedOptions.combatUuid,
      chainRef: normalizedOptions.chainRef,
      data: normalizedOptions.rootData
    }, scope => scope.emit(eventKey, payload, normalizedOptions));
  }

  function getSelectable() {
    return resolvedCatalog.getSelectable();
  }

  function createClientScope(chainRef, meta) {
    const frozenChainRef = deepFreeze(jsonSafeClone(chainRef));
    return Object.freeze({
      active: true,
      rootId: frozenChainRef.rootId,
      chainRef: frozenChainRef,
      meta: deepFreeze(jsonSafeClone(meta)),
      emit: async (eventKey, payload = {}, options = {}) => {
        try {
          return await requestAuthority("emit", {
            chainRef: frozenChainRef,
            eventKey: String(eventKey ?? "").trim(),
            payload: jsonSafeClone(payload),
            options: normalizeEmitOptions(options, resolvedRuntime.randomId)
          });
        } catch (error) {
          logFailOpen(`System event '${String(eventKey ?? "")}' failed`, error);
          return createFailOpenOutcome(eventKey, payload, errorReason(error));
        }
      }
    });
  }

  function createDetachedScope(meta, error) {
    const reason = errorReason(error) || "noAuthority";
    return Object.freeze({
      active: false,
      rootId: "",
      chainRef: null,
      meta: deepFreeze(safeJsonClone(meta) ?? {}),
      emit: async (eventKey, payload = {}) => createFailOpenOutcome(eventKey, payload, reason)
    });
  }

  async function requestAuthority(action, payload = {}) {
    const requesterUserId = resolvedRuntime.getCurrentUserId();
    if (isCurrentAuthority()) return processAuthorityAction(action, payload, requesterUserId);

    const activeGMId = resolvedRuntime.getActiveGMId();
    if (!activeGMId) throw createDispatcherError("noAuthority", "No active GM is available for system events.");
    if (!registerSocket()) throw createDispatcherError("socketUnavailable", "The system-event socket is unavailable.");

    const requestId = resolvedRuntime.randomId();
    const request = {
      scope: SYSTEM_EVENT_SOCKET_SCOPE,
      action: "request",
      requestId,
      targetUserId: activeGMId,
      requesterUserId,
      operation: action,
      payload: jsonSafeClone(payload)
    };

    return new Promise((resolve, reject) => {
      const timeoutId = resolvedRuntime.setTimeout(() => {
        pendingSocketRequests.delete(requestId);
        reject(createDispatcherError("authorityTimeout", `System-event authority request '${action}' timed out.`));
      }, resolvedLimits.requestTimeoutMs);
      unrefTimer(timeoutId);
      pendingSocketRequests.set(requestId, { resolve, reject, timeoutId });
      try {
        resolvedRuntime.emitSocket(SYSTEM_EVENT_SOCKET, request);
      } catch (error) {
        resolvedRuntime.clearTimeout(timeoutId);
        pendingSocketRequests.delete(requestId);
        reject(error);
      }
    });
  }

  function registerSocket() {
    if (socketRegistered) return true;
    if (!resolvedRuntime.onSocket) return false;
    try {
      resolvedRuntime.onSocket(SYSTEM_EVENT_SOCKET, message => {
        void handleSocketMessage(message);
      });
      socketRegistered = true;
      return true;
    } catch (error) {
      resolvedRuntime.logger.error(`${SYSTEM_ID} | Failed to register system-event socket`, error);
      return false;
    }
  }

  async function handleSocketMessage(message = {}) {
    if (message?.scope !== SYSTEM_EVENT_SOCKET_SCOPE) return;
    const currentUserId = resolvedRuntime.getCurrentUserId();
    if (message.action === "response") {
      if (message.targetUserId !== currentUserId) return;
      const pending = pendingSocketRequests.get(String(message.requestId ?? ""));
      if (!pending) return;
      pendingSocketRequests.delete(message.requestId);
      resolvedRuntime.clearTimeout(pending.timeoutId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(createDispatcherError(message.error?.code || "authorityError", message.error?.message || "System-event authority request failed."));
      return;
    }

    if (message.action !== "request") return;
    if (!isCurrentAuthority() || message.targetUserId !== currentUserId) return;
    const requestId = String(message.requestId ?? "").trim();
    if (!requestId) return;
    const requesterUserId = String(message.requesterUserId ?? "").trim();
    const operation = String(message.operation ?? "").trim();
    const cacheKey = `${requesterUserId}:${requestId}`;
    pruneTimedCache(authorityRpcCompleted, resolvedLimits.completedCacheTtlMs, resolvedLimits.completedCacheSize);

    let promise = authorityRpcInFlight.get(cacheKey);
    const completed = getTimedCache(authorityRpcCompleted, cacheKey, resolvedLimits.completedCacheTtlMs);
    if (completed) promise = Promise.resolve(completed.value);
    if (!promise) {
      promise = Promise.resolve()
        .then(() => processAuthorityAction(operation, message.payload ?? {}, requesterUserId))
        .then(result => ({ ok: true, result: jsonSafeClone(result) }))
        .catch(error => ({
          ok: false,
          error: { code: error?.code || "authorityError", message: String(error?.message ?? error ?? "Unknown authority error") }
        }))
        .then(response => {
          setTimedCache(authorityRpcCompleted, cacheKey, response, resolvedLimits.completedCacheSize);
          return response;
        })
        .finally(() => authorityRpcInFlight.delete(cacheKey));
      authorityRpcInFlight.set(cacheKey, promise);
    }

    const response = await promise;
    resolvedRuntime.emitSocket(SYSTEM_EVENT_SOCKET, {
      scope: SYSTEM_EVENT_SOCKET_SCOPE,
      action: "response",
      requestId,
      targetUserId: requesterUserId,
      ...response
    });
  }

  function processAuthorityAction(action, payload, requesterUserId) {
    if (!isCurrentAuthority()) throw createDispatcherError("notAuthority", "Only the active GM may process system events.");
    switch (action) {
      case "openRoot": return authorityOpenRoot(payload, requesterUserId);
      case "acquireRoot": return authorityAcquireRoot(payload, requesterUserId);
      case "releaseRoot": return authorityReleaseRoot(payload, requesterUserId);
      case "emit": return authorityEmit(payload, requesterUserId);
      default: throw createDispatcherError("unsupportedOperation", `Unsupported system-event authority operation '${action}'.`);
    }
  }

  function authorityOpenRoot({ meta = {} } = {}, requesterUserId) {
    const normalizedMeta = normalizeRootMeta(meta, resolvedRuntime.randomId);
    const operationKey = buildOperationKey(requesterUserId, normalizedMeta.operationId);
    const knownRootId = operationRoots.get(operationKey);
    if (knownRootId) {
      const knownRoot = roots.get(knownRootId);
      if (knownRoot && !knownRoot.closeRequested) {
        const leaseId = resolvedRuntime.randomId();
        knownRoot.leases.set(leaseId, {
          id: leaseId,
          userId: requesterUserId,
          owner: false,
          parentEventId: null,
          lineage: new Set()
        });
        touchRoot(knownRoot);
        return buildOpenedRootResult(knownRoot, leaseId, false);
      }
      throw createDispatcherError("rootClosed", `System event operation '${normalizedMeta.operationId}' is already closed.`);
    }

    const rootId = resolvedRuntime.randomId();
    const ownerLeaseId = resolvedRuntime.randomId();
    const finalized = promiseWithResolvers();
    const root = {
      id: rootId,
      operationKey,
      ownerUserId: requesterUserId,
      ownerLeaseId,
      meta: normalizedMeta,
      createdAt: resolvedRuntime.now(),
      touchedAt: resolvedRuntime.now(),
      closeRequested: false,
      closeReason: "",
      finalizing: false,
      finalized,
      watchdogId: null,
      sequence: 0,
      eventCount: 0,
      reactionCount: 0,
      reactionsDisabled: false,
      inflight: 0,
      rootCancelled: false,
      rootCancelReasons: [],
      warnedLimits: new Set(),
      leases: new Map([[ownerLeaseId, {
        id: ownerLeaseId,
        userId: requesterUserId,
        owner: true,
        parentEventId: null,
        lineage: new Set()
      }]]),
      events: new Map(),
      executionTokens: new Map(),
      completedEvents: new Map(),
      finalizerErrors: []
    };
    roots.set(rootId, root);
    operationRoots.set(operationKey, rootId);
    scheduleRootWatchdog(root);
    return buildOpenedRootResult(root, ownerLeaseId, true);
  }

  function authorityAcquireRoot({ chainRef, meta = {} } = {}, requesterUserId) {
    const validated = validateChainRef(chainRef, requesterUserId, {
      allowClosing: false,
      allowAuthorityLeaseAcquisition: true
    });
    const leaseId = resolvedRuntime.randomId();
    validated.root.leases.set(leaseId, {
      id: leaseId,
      userId: requesterUserId,
      owner: false,
      parentEventId: validated.parentEventId,
      lineage: new Set(validated.lineage)
    });
    touchRoot(validated.root);
    return {
      ...buildOpenedRootResult(validated.root, leaseId, false),
      chainRef: buildChainRef(validated.root.id, leaseId, validated.parentEventId, "")
    };
  }

  async function authorityReleaseRoot({ chainRef, requestClose = false } = {}, requesterUserId) {
    const validated = validateChainRef(chainRef, requesterUserId, { allowClosing: true, requireLease: true });
    const lease = validated.root.leases.get(validated.leaseId);
    if (!lease) return { closed: Boolean(closedRoots.has(validated.root.id)) };
    validated.root.leases.delete(validated.leaseId);
    if (requestClose) {
      if (!lease.owner) throw createDispatcherError("notRootOwner", "Only the owner lease may request root closure.");
      validated.root.closeRequested = true;
      validated.root.closeReason ||= "ownerFinally";
    }
    touchRoot(validated.root, { reschedule: false });
    maybeFinalizeRoot(validated.root);
    if (requestClose) return validated.root.finalized.promise;
    return { closed: false, released: true };
  }

  function authorityEmit(payload = {}, requesterUserId, { internal = false } = {}) {
    const eventKey = String(payload.eventKey ?? "").trim();
    const occurrenceKey = String(payload.options?.occurrenceKey ?? "").trim() || resolvedRuntime.randomId();
    const rootId = String(payload.chainRef?.rootId ?? "").trim();
    const dedupeKey = `${rootId}:${eventKey}:${occurrenceKey}`;
    pruneTimedCache(completedEvents, resolvedLimits.completedCacheTtlMs, resolvedLimits.completedCacheSize);
    const completed = getTimedCache(completedEvents, dedupeKey, resolvedLimits.completedCacheTtlMs);
    if (completed && completed.ownerUserId === requesterUserId) return Promise.resolve(jsonSafeClone(completed.value));
    const inflight = inFlightEvents.get(dedupeKey);
    if (inflight && inflight.ownerUserId === requesterUserId) return inflight.promise;

    let validated;
    try {
      // A lease acquired before the owner requested closure is a registered post-hook task. It must be able to
      // finish emitting while the root waits for that lease; no new leases can be acquired once closure begins.
      validated = validateChainRef(payload.chainRef, requesterUserId, { allowClosing: true, internal });
    } catch (error) {
      return Promise.resolve(createFailOpenOutcome(eventKey, payload.payload, errorReason(error)));
    }
    const rootCompleted = validated.root.completedEvents.get(dedupeKey);
    if (rootCompleted) return Promise.resolve(jsonSafeClone(rootCompleted));

    const operation = dispatchAuthorityEvent({
      root: validated.root,
      parentEventId: validated.parentEventId,
      lineage: validated.lineage,
      eventKey,
      occurrenceKey,
      payload: payload.payload,
      options: payload.options ?? {},
      requesterUserId
    }).then(outcome => {
      validated.root.completedEvents.set(dedupeKey, jsonSafeClone(outcome));
      setTimedCache(completedEvents, dedupeKey, outcome, resolvedLimits.completedCacheSize, { ownerUserId: requesterUserId });
      return jsonSafeClone(outcome);
    }).finally(() => inFlightEvents.delete(dedupeKey));
    inFlightEvents.set(dedupeKey, { ownerUserId: requesterUserId, promise: operation });
    return operation;
  }

  async function dispatchAuthorityEvent({
    root,
    parentEventId,
    lineage,
    eventKey,
    occurrenceKey,
    payload,
    options,
    requesterUserId
  }) {
    root.inflight += 1;
    touchRoot(root);
    try {
      const descriptor = resolvedCatalog.getDescriptor(eventKey);
      if (!descriptor) return createFailOpenOutcome(eventKey, payload, "unknownEvent");

      const parent = parentEventId ? root.events.get(parentEventId) : null;
      const depth = parent ? parent.depth + 1 : 0;
      if (depth > resolvedLimits.maxDepth) {
        root.reactionsDisabled = true;
        warnRootLimit(root, "depth", `System-event root '${root.id}' exceeded maximum depth ${resolvedLimits.maxDepth}.`);
        return createFailOpenOutcome(eventKey, payload, "depthLimit", root);
      }
      if (root.eventCount >= resolvedLimits.maxEventsPerRoot) {
        root.reactionsDisabled = true;
        warnRootLimit(root, "events", `System-event root '${root.id}' exceeded ${resolvedLimits.maxEventsPerRoot} events.`);
        return createFailOpenOutcome(eventKey, payload, "eventLimit", root);
      }

      let eventPayload;
      let data;
      let participants;
      try {
        const serialized = typeof descriptor.serialize === "function" ? descriptor.serialize(payload) : payload;
        eventPayload = normalizeCanonicalEventPayload(serialized, options);
        data = eventPayload.data;
        participants = eventPayload.participants;
        if (typeof descriptor.validate === "function" && descriptor.validate(data) === false) {
          throw createDispatcherError("invalidPayload", `Payload validation failed for '${eventKey}'.`);
        }
      } catch (error) {
        return createFailOpenOutcome(eventKey, payload, errorReason(error) || "invalidPayload", root);
      }

      root.eventCount += 1;
      root.sequence += 1;
      const eventId = resolvedRuntime.randomId();
      const eventNode = {
        id: eventId,
        parentEventId: parentEventId || null,
        depth,
        lineage: new Set(lineage ?? [])
      };
      root.events.set(eventId, eventNode);
      const baseEnvelope = {
        schemaVersion: 1,
        catalogVersion: toInteger(descriptor.catalogVersion),
        eventId,
        rootId: root.id,
        operationId: String(root.meta?.operationId ?? ""),
        parentEventId: eventNode.parentEventId,
        sequence: root.sequence,
        depth,
        key: eventKey,
        group: String(descriptor.group ?? ""),
        phase: String(descriptor.phase ?? ""),
        subject: String(descriptor.subject ?? ""),
        roles: normalizeStringArray(descriptor.roles),
        selectable: Boolean(descriptor.selectable),
        occurrenceKey,
        requesterUserId,
        authorityUserId: resolvedRuntime.getCurrentUserId(),
        sceneUuid: root.meta.sceneUuid,
        combatUuid: root.meta.combatUuid,
        occurredAt: {
          worldTime: resolvedRuntime.getWorldTime(),
          realTime: resolvedRuntime.now()
        },
        source: participants.source,
        target: participants.target,
        related: participants.related,
        participants,
        before: eventPayload.before,
        after: eventPayload.after,
        delta: eventPayload.delta,
        outcome: eventPayload.outcome,
        reason: eventPayload.reason,
        capabilities: normalizeStringArray(descriptor.capabilities),
        data
      };

      const state = {
        data,
        control: createControlState(root),
        appliedPatches: [],
        errors: [],
        skippedHandlers: []
      };
      const descriptorCapabilities = new Set(baseEnvelope.capabilities);
      const allowedPatchPaths = normalizeStringArray(descriptor.allowedPatchPaths);

      for (const entry of getMatchingHandlers(interceptors, eventKey)) {
        await runHandler(entry, {
          root,
          eventNode,
          baseEnvelope,
          state,
          descriptorCapabilities,
          allowedPatchPaths
        });
      }
      for (const entry of getMatchingHandlers(observers, eventKey)) {
        await runHandler(entry, {
          root,
          eventNode,
          baseEnvelope,
          state,
          descriptorCapabilities,
          allowedPatchPaths
        });
      }

      const finalEnvelope = createEnvelopeView(baseEnvelope, state.data);
      return deepFreeze(jsonSafeClone({
        ok: true,
        reason: "",
        event: finalEnvelope,
        data: state.data,
        control: state.control,
        appliedPatches: state.appliedPatches,
        errors: state.errors,
        skippedHandlers: state.skippedHandlers
      }));
    } finally {
      root.inflight = Math.max(0, root.inflight - 1);
      touchRoot(root, { reschedule: false });
      maybeFinalizeRoot(root);
    }
  }

  async function runHandler(entry, context) {
    const { root, eventNode, baseEnvelope, state, descriptorCapabilities, allowedPatchPaths } = context;
    const recursionKey = `${entry.kind}:${entry.id}:${baseEnvelope.key}`;
    if (entry.guardRecursion && eventNode.lineage.has(recursionKey)) {
      state.skippedHandlers.push({ id: entry.id, kind: entry.kind, reason: "recursion" });
      return;
    }

    const executionToken = resolvedRuntime.randomId();
    const childLineage = new Set(eventNode.lineage);
    if (entry.guardRecursion) childLineage.add(recursionKey);
    root.executionTokens.set(executionToken, {
      eventId: baseEnvelope.eventId,
      lineage: childLineage,
      active: true
    });
    const handlerScope = createHandlerScope(root, baseEnvelope, executionToken);
    const envelope = createEnvelopeView(baseEnvelope, state.data);
    let response;
    try {
      response = await entry.callback({
        event: envelope,
        data: envelope.data,
        control: deepFreeze(jsonSafeClone(state.control)),
        scope: handlerScope
      });
    } catch (error) {
      recordHandlerError(state, entry, "handlerError", error);
      resolvedRuntime.logger.error(`${SYSTEM_ID} | System-event ${entry.kind} '${entry.id}' failed`, error);
      return;
    } finally {
      const token = root.executionTokens.get(executionToken);
      if (token) token.active = false;
      root.executionTokens.delete(executionToken);
    }

    if (entry.kind !== "interceptor" || response === undefined || response === null) return;
    if (!isPlainObject(response)) {
      recordHandlerError(state, entry, "invalidDirective", new TypeError("Interceptor result must be a plain object."));
      return;
    }

    const patches = Array.isArray(response.patches) ? response.patches : [];
    if (patches.length && !setIntersects(descriptorCapabilities, PATCH_CAPABILITIES)) {
      recordHandlerError(state, entry, "patchUnsupported", new Error(`Event '${baseEnvelope.key}' does not allow patches.`));
    } else {
      for (const patch of patches) {
        try {
          const result = applyAllowedPatch(state.data, patch, allowedPatchPaths);
          state.data = result.data;
          state.appliedPatches.push({ handlerId: entry.id, ...result.patch });
        } catch (error) {
          recordHandlerError(state, entry, "patchRejected", error);
        }
      }
    }

    if (response.cancel !== undefined && response.cancel !== null) {
      try {
        const cancelScope = normalizeCancelScope(response.cancel);
        const allowedCapabilities = CANCEL_CAPABILITIES_BY_SCOPE[cancelScope] ?? LEGACY_CANCEL_CAPABILITIES;
        if (!setIntersects(descriptorCapabilities, allowedCapabilities)) {
          recordHandlerError(state, entry, "cancelUnsupported", new Error(
            `Event '${baseEnvelope.key}' does not allow '${cancelScope}' cancellation.`
          ));
        } else {
          applyCancellation(state.control, response.cancel, entry.id);
          if (state.control.root) {
            root.rootCancelled = true;
            root.rootCancelReasons = state.control.reasons.filter(reason => reason.scope === "root");
          }
        }
      } catch (error) {
        recordHandlerError(state, entry, "cancelRejected", error);
      }
    }
  }

  function createHandlerScope(root, envelope, executionToken) {
    const chainRef = deepFreeze(buildChainRef(root.id, "", envelope.eventId, executionToken));
    return Object.freeze({
      active: true,
      rootId: root.id,
      eventId: envelope.eventId,
      chainRef,
      emit: async (eventKey, payload = {}, options = {}) => authorityEmit({
        chainRef,
        eventKey: String(eventKey ?? "").trim(),
        payload: jsonSafeClone(payload),
        options: normalizeEmitOptions(options, resolvedRuntime.randomId)
      }, envelope.requesterUserId, { internal: true }),
      consumeReactionBudget: (amount = 1) => consumeReactionBudget(root, amount)
    });
  }

  function consumeReactionBudget(root, amount = 1) {
    const count = Math.max(1, toInteger(amount));
    if (root.reactionsDisabled || root.reactionCount + count > resolvedLimits.maxReactionsPerRoot) {
      root.reactionsDisabled = true;
      warnRootLimit(root, "reactions", `System-event root '${root.id}' exceeded ${resolvedLimits.maxReactionsPerRoot} reaction executions.`);
      return false;
    }
    root.reactionCount += count;
    touchRoot(root);
    return true;
  }

  function validateChainRef(chainRef, requesterUserId, {
    allowClosing = false,
    requireLease = false,
    internal = false,
    allowAuthorityLeaseAcquisition = false
  } = {}) {
    const ref = normalizeChainRef(chainRef);
    const root = roots.get(ref.rootId);
    if (!root) throw createDispatcherError(closedRoots.has(ref.rootId) ? "rootClosed" : "unknownRoot", `Unknown system-event root '${ref.rootId}'.`);
    if (root.closeRequested && !allowClosing) throw createDispatcherError("rootClosing", `System-event root '${root.id}' is closing.`);

    const token = ref.executionToken ? root.executionTokens.get(ref.executionToken) : null;
    if (token?.active) {
      if (ref.parentEventId && ref.parentEventId !== token.eventId) throw createDispatcherError("invalidLineage", "Execution token parent does not match.");
      return {
        root,
        leaseId: "",
        parentEventId: token.eventId,
        lineage: new Set(token.lineage)
      };
    }
    if (ref.executionToken) throw createDispatcherError("expiredLineage", "System-event execution token is no longer active.");

    const lease = ref.leaseId ? root.leases.get(ref.leaseId) : null;
    if (!lease || (requireLease && !ref.leaseId)) throw createDispatcherError("invalidLease", "System-event root lease is invalid.");
    const authorityMayAcquire = allowAuthorityLeaseAcquisition
      && requesterUserId === resolvedRuntime.getCurrentUserId()
      && requesterUserId === resolvedRuntime.getActiveGMId();
    if (!internal && lease.userId !== requesterUserId && !authorityMayAcquire) {
      throw createDispatcherError("leaseOwnerMismatch", "System-event root lease belongs to another user.");
    }
    if (ref.parentEventId && !root.events.has(ref.parentEventId)) throw createDispatcherError("invalidParent", "Parent event does not belong to this root.");
    if ((ref.parentEventId || null) !== (lease.parentEventId || null)) {
      throw createDispatcherError("invalidParent", "Parent event does not match the acquired root lease.");
    }
    return {
      root,
      leaseId: ref.leaseId,
      parentEventId: ref.parentEventId || null,
      lineage: new Set(lease.lineage ?? [])
    };
  }

  function maybeFinalizeRoot(root) {
    if (!root.closeRequested || root.leases.size || root.inflight || root.finalizing) return;
    root.finalizing = true;
    if (root.watchdogId !== null) resolvedRuntime.clearTimeout(root.watchdogId);
    root.watchdogId = null;
    void (async () => {
      try {
        for (const entry of sortRegistrations(rootFinalizers.values())) {
          try {
            await entry.finalize({
              rootId: root.id,
              reason: root.closeReason || "closed",
              meta: deepFreeze(jsonSafeClone(root.meta)),
              eventCount: root.eventCount,
              reactionCount: root.reactionCount,
              cancelled: root.rootCancelled
            });
          } catch (error) {
            root.finalizerErrors.push({ id: entry.id, message: String(error?.message ?? error ?? "Unknown finalizer error") });
            resolvedRuntime.logger.error(`${SYSTEM_ID} | System-event root finalizer '${entry.id}' failed`, error);
          }
        }
      } finally {
        roots.delete(root.id);
        closedRoots.set(root.id, { closedAt: resolvedRuntime.now(), ownerUserId: root.ownerUserId });
        pruneClosedRoots();
        root.finalized.resolve(deepFreeze(jsonSafeClone({
          closed: true,
          rootId: root.id,
          reason: root.closeReason || "closed",
          errors: root.finalizerErrors
        })));
      }
    })();
  }

  function scheduleRootWatchdog(root) {
    if (root.watchdogId !== null) resolvedRuntime.clearTimeout(root.watchdogId);
    root.watchdogId = resolvedRuntime.setTimeout(() => {
      if (!roots.has(root.id) || root.finalizing) return;
      if (root.inflight > 0) {
        scheduleRootWatchdog(root);
        return;
      }
      root.closeRequested = true;
      root.closeReason = "watchdog";
      root.leases.clear();
      warnRootLimit(root, "watchdog", `System-event root '${root.id}' was closed by its watchdog.`);
      maybeFinalizeRoot(root);
    }, resolvedLimits.rootWatchdogMs);
    unrefTimer(root.watchdogId);
  }

  function touchRoot(root, { reschedule = true } = {}) {
    root.touchedAt = resolvedRuntime.now();
    if (reschedule && !root.closeRequested && !root.finalizing) scheduleRootWatchdog(root);
  }

  function pruneClosedRoots() {
    const cutoff = resolvedRuntime.now() - resolvedLimits.completedCacheTtlMs;
    for (const [rootId, entry] of closedRoots) {
      if (entry.closedAt >= cutoff) continue;
      closedRoots.delete(rootId);
      const operationKey = Array.from(operationRoots.entries()).find(([, value]) => value === rootId)?.[0];
      if (operationKey) operationRoots.delete(operationKey);
    }
  }

  function buildOpenedRootResult(root, leaseId, owner) {
    return deepFreeze(jsonSafeClone({
      rootId: root.id,
      owner,
      chainRef: buildChainRef(root.id, leaseId, null, "")
    }));
  }

  function warnRootLimit(root, key, message) {
    const warningKey = key === "watchdog" ? "watchdog" : "safetyLimit";
    if (root.warnedLimits.has(warningKey)) return;
    root.warnedLimits.add(warningKey);
    resolvedRuntime.logger.warn(`${SYSTEM_ID} | ${message}`);
  }

  function logFailOpen(message, error) {
    resolvedRuntime.logger.warn(`${SYSTEM_ID} | ${message}; continuing fail-open.`, error);
  }

  function isCurrentAuthority() {
    const currentUserId = String(resolvedRuntime.getCurrentUserId() ?? "").trim();
    const activeGMId = String(resolvedRuntime.getActiveGMId() ?? "").trim();
    return Boolean(activeGMId && currentUserId === activeGMId);
  }

  return Object.freeze({
    withSystemEventRoot: withRoot,
    dispatchSystemEvent: dispatch,
    getActiveSystemEventOperationId,
    registerSystemEventInterceptor: registerInterceptor,
    registerSystemEventObserver: registerObserver,
    registerSystemEventRootFinalizer: registerRootFinalizer,
    registerSystemEventDispatcherSocket: registerSocket,
    getSelectableSystemEvents: getSelectable
  });
}

const defaultDispatcher = createSystemEventDispatcher();

export const withSystemEventRoot = defaultDispatcher.withSystemEventRoot;
export const dispatchSystemEvent = defaultDispatcher.dispatchSystemEvent;
export const getActiveSystemEventOperationId = defaultDispatcher.getActiveSystemEventOperationId;
export const registerSystemEventInterceptor = defaultDispatcher.registerSystemEventInterceptor;
export const registerSystemEventObserver = defaultDispatcher.registerSystemEventObserver;
export const registerSystemEventRootFinalizer = defaultDispatcher.registerSystemEventRootFinalizer;
export const registerSystemEventDispatcherSocket = defaultDispatcher.registerSystemEventDispatcherSocket;
export const getSelectableSystemEvents = defaultDispatcher.getSelectableSystemEvents;

function normalizeRuntime(runtime = {}) {
  const logger = runtime.logger ?? globalThis.console ?? { warn: () => undefined, error: () => undefined };
  return {
    getCurrentUserId: runtime.getCurrentUserId ?? (() => String(globalThis.game?.user?.id ?? "")),
    getActiveGMId: runtime.getActiveGMId ?? (() => String(globalThis.game?.users?.activeGM?.id ?? "")),
    isActiveGM: runtime.isActiveGM ?? (() => Boolean(
      globalThis.game?.user?.isActiveGM
      || (globalThis.game?.user?.id && globalThis.game?.users?.activeGM?.id === globalThis.game.user.id)
    )),
    getWorldTime: runtime.getWorldTime ?? (() => finiteNumber(globalThis.game?.time?.worldTime, 0)),
    randomId: runtime.randomId ?? defaultRandomId,
    now: runtime.now ?? (() => Date.now()),
    setTimeout: runtime.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay)),
    clearTimeout: runtime.clearTimeout ?? (timer => globalThis.clearTimeout(timer)),
    onSocket: runtime.onSocket ?? ((channel, callback) => globalThis.game?.socket?.on?.(channel, callback)),
    emitSocket: runtime.emitSocket ?? ((channel, message) => globalThis.game?.socket?.emit?.(channel, message)),
    logger: {
      warn: typeof logger.warn === "function" ? logger.warn.bind(logger) : () => undefined,
      error: typeof logger.error === "function" ? logger.error.bind(logger) : () => undefined
    }
  };
}

function normalizeLimits(limits = {}) {
  return Object.freeze({
    maxDepth: positiveInteger(limits.maxDepth, SYSTEM_EVENT_DISPATCHER_LIMITS.maxDepth),
    maxEventsPerRoot: positiveInteger(limits.maxEventsPerRoot, SYSTEM_EVENT_DISPATCHER_LIMITS.maxEventsPerRoot),
    maxReactionsPerRoot: positiveInteger(limits.maxReactionsPerRoot, SYSTEM_EVENT_DISPATCHER_LIMITS.maxReactionsPerRoot),
    rootWatchdogMs: positiveInteger(limits.rootWatchdogMs, SYSTEM_EVENT_DISPATCHER_LIMITS.rootWatchdogMs),
    requestTimeoutMs: positiveInteger(limits.requestTimeoutMs, SYSTEM_EVENT_DISPATCHER_LIMITS.requestTimeoutMs),
    completedCacheSize: positiveInteger(limits.completedCacheSize, SYSTEM_EVENT_DISPATCHER_LIMITS.completedCacheSize),
    completedCacheTtlMs: positiveInteger(limits.completedCacheTtlMs, SYSTEM_EVENT_DISPATCHER_LIMITS.completedCacheTtlMs)
  });
}

function normalizeRootMeta(meta = {}, randomId = defaultRandomId) {
  const source = isPlainObject(meta) ? meta : {};
  return deepFreeze(jsonSafeClone({
    kind: String(source.kind ?? "systemEvent").trim() || "systemEvent",
    operationId: String(source.operationId ?? "").trim() || randomId(),
    sceneUuid: String(source.sceneUuid ?? "").trim(),
    combatUuid: String(source.combatUuid ?? "").trim(),
    chainRef: source.chainRef ? normalizeChainRef(source.chainRef) : null,
    data: safeJsonClone(source.data) ?? {}
  }));
}

function normalizeDispatchOptions(options = {}, randomId = defaultRandomId) {
  const source = isPlainObject(options) ? options : {};
  return {
    ...normalizeEmitOptions(source, randomId),
    kind: String(source.kind ?? "").trim(),
    operationId: String(source.operationId ?? "").trim() || randomId(),
    sceneUuid: String(source.sceneUuid ?? "").trim(),
    combatUuid: String(source.combatUuid ?? "").trim(),
    chainRef: source.chainRef ? normalizeChainRef(source.chainRef) : null,
    rootData: safeJsonClone(source.rootData) ?? {}
  };
}

function normalizeEmitOptions(options = {}, randomId = defaultRandomId) {
  const source = isPlainObject(options) ? options : {};
  return deepFreeze(jsonSafeClone({
    occurrenceKey: String(source.occurrenceKey ?? "").trim() || randomId(),
    participants: normalizeParticipants(source.participants),
    source: normalizeParticipant(source.source),
    target: normalizeParticipant(source.target),
    related: (Array.isArray(source.related) ? source.related : []).map(normalizeParticipant).filter(Boolean),
    before: safeJsonClone(source.before),
    after: safeJsonClone(source.after),
    delta: safeJsonClone(source.delta),
    outcome: safeJsonClone(source.outcome),
    reason: String(source.reason ?? "").trim()
  }));
}

function normalizeCanonicalEventPayload(serialized, options = {}) {
  const wrapped = isPlainObject(serialized) && [
    "data", "source", "target", "related", "participants", "before", "after", "delta", "outcome", "reason"
  ]
    .some(key => Object.hasOwn(serialized, key));
  const source = wrapped ? serialized : {};
  const data = wrapped ? source.data ?? {} : serialized;
  const optionParticipants = normalizeParticipants({
    ...(isPlainObject(options.participants) ? options.participants : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.target ? { target: options.target } : {}),
    ...(Array.isArray(options.related) && options.related.length ? { related: options.related } : {})
  });
  const payloadParticipants = normalizeParticipants({
    ...(isPlainObject(source.participants) ? source.participants : {}),
    ...(source.source ? { source: source.source } : {}),
    ...(source.target ? { target: source.target } : {}),
    ...(Array.isArray(source.related) ? { related: source.related } : {})
  });
  return {
    data: jsonSafeClone(data),
    participants: {
      source: optionParticipants.source ?? payloadParticipants.source,
      target: optionParticipants.target ?? payloadParticipants.target,
      related: optionParticipants.related.length ? optionParticipants.related : payloadParticipants.related
    },
    before: jsonSafeClone(options.before ?? source.before ?? null),
    after: jsonSafeClone(options.after ?? source.after ?? null),
    delta: jsonSafeClone(options.delta ?? source.delta ?? null),
    outcome: jsonSafeClone(options.outcome ?? source.outcome ?? null),
    reason: String(options.reason || source.reason || "").trim()
  };
}

function normalizeParticipants(participants = {}) {
  const source = isPlainObject(participants) ? participants : {};
  return {
    source: normalizeParticipant(source.source),
    target: normalizeParticipant(source.target),
    related: (Array.isArray(source.related) ? source.related : []).map(normalizeParticipant).filter(Boolean)
  };
}

function normalizeParticipant(participant) {
  if (!isPlainObject(participant)) return null;
  const normalized = {
    actorUuid: String(participant.actorUuid ?? "").trim(),
    tokenUuid: String(participant.tokenUuid ?? "").trim(),
    itemUuid: String(participant.itemUuid ?? "").trim()
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function normalizeChainRef(chainRef = {}) {
  if (!isPlainObject(chainRef)) throw createDispatcherError("invalidChain", "System-event chain reference must be an object.");
  const normalized = {
    version: toInteger(chainRef.version ?? SYSTEM_EVENT_CHAIN_VERSION),
    rootId: String(chainRef.rootId ?? "").trim(),
    leaseId: String(chainRef.leaseId ?? "").trim(),
    parentEventId: String(chainRef.parentEventId ?? "").trim() || null,
    executionToken: String(chainRef.executionToken ?? "").trim()
  };
  if (normalized.version !== SYSTEM_EVENT_CHAIN_VERSION || !normalized.rootId) {
    throw createDispatcherError("invalidChain", "System-event chain reference is invalid or unsupported.");
  }
  return normalized;
}

function buildChainRef(rootId, leaseId = "", parentEventId = null, executionToken = "") {
  return {
    version: SYSTEM_EVENT_CHAIN_VERSION,
    rootId,
    leaseId,
    parentEventId,
    executionToken
  };
}

function normalizeEventKeys(value) {
  const source = value === undefined || value === null
    ? ["*"]
    : Array.isArray(value) || value instanceof Set ? Array.from(value) : [value];
  const keys = new Set(source.map(key => String(key ?? "").trim()).filter(Boolean));
  if (!keys.size) keys.add("*");
  return keys;
}

function getMatchingHandlers(registry, eventKey) {
  return sortRegistrations(Array.from(registry.values()).filter(entry => (
    entry.eventKeys.has("*") || entry.eventKeys.has(eventKey)
  )));
}

function sortRegistrations(entries) {
  return Array.from(entries).sort((left, right) => (
    left.priority - right.priority
    || left.sequence - right.sequence
    || left.id.localeCompare(right.id)
  ));
}

function createEnvelopeView(baseEnvelope, data) {
  return deepFreeze(jsonSafeClone({ ...baseEnvelope, data }));
}

function createControlState(root = null) {
  return {
    current: false,
    remaining: false,
    root: Boolean(root?.rootCancelled),
    reasons: Array.isArray(root?.rootCancelReasons) ? jsonSafeClone(root.rootCancelReasons) : []
  };
}

function applyCancellation(control, directive, handlerId) {
  if (!isPlainObject(directive)) throw createDispatcherError("invalidCancellation", "Cancellation directive must be an object.");
  const scope = normalizeCancelScope(directive);
  control[scope] = true;
  control.reasons.push({
    scope,
    handlerId,
    reason: String(directive.reason ?? "").trim()
  });
}

function normalizeCancelScope(directive) {
  if (!isPlainObject(directive)) throw createDispatcherError("invalidCancellation", "Cancellation directive must be an object.");
  const scope = String(directive.scope ?? "").trim();
  if (!CANCEL_SCOPES.has(scope)) throw createDispatcherError("invalidCancellation", `Unsupported cancellation scope '${scope}'.`);
  return scope;
}

function applyAllowedPatch(data, rawPatch, allowedPaths) {
  if (!isPlainObject(rawPatch)) throw createDispatcherError("invalidPatch", "JSON Patch entry must be an object.");
  const op = String(rawPatch.op ?? "").trim();
  const path = String(rawPatch.path ?? "").trim();
  if (!JSON_PATCH_OPERATIONS.has(op)) throw createDispatcherError("invalidPatch", `Unsupported JSON Patch operation '${op}'.`);
  if (!isAllowedPatchPath(path, allowedPaths)) throw createDispatcherError("patchPathDenied", `JSON Patch path '${path}' is not allowed.`);

  const document = { data: jsonSafeClone(data) };
  const segments = parseJsonPointer(path);
  if (!segments.length) throw createDispatcherError("invalidPatch", "Replacing the event root is not allowed.");
  const leaf = segments.pop();
  let parent = document;
  for (const segment of segments) {
    if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, segment)) {
      throw createDispatcherError("invalidPatch", `JSON Patch parent for '${path}' does not exist.`);
    }
    parent = parent[segment];
  }

  if (Array.isArray(parent)) applyArrayPatch(parent, leaf, op, rawPatch.value, path);
  else if (isPlainObject(parent)) applyObjectPatch(parent, leaf, op, rawPatch.value, path);
  else throw createDispatcherError("invalidPatch", `JSON Patch parent for '${path}' is not a container.`);

  return {
    data: jsonSafeClone(document.data),
    patch: op === "remove" ? { op, path } : { op, path, value: jsonSafeClone(rawPatch.value) }
  };
}

function applyObjectPatch(parent, leaf, op, value, path) {
  const exists = Object.hasOwn(parent, leaf);
  if ((op === "replace" || op === "remove") && !exists) {
    throw createDispatcherError("invalidPatch", `JSON Patch target '${path}' does not exist.`);
  }
  if (op === "remove") delete parent[leaf];
  else parent[leaf] = jsonSafeClone(value);
}

function applyArrayPatch(parent, leaf, op, value, path) {
  const index = leaf === "-" ? parent.length : Number(leaf);
  if (!Number.isInteger(index) || index < 0) throw createDispatcherError("invalidPatch", `Invalid array index in '${path}'.`);
  if (op === "add") {
    if (index > parent.length) throw createDispatcherError("invalidPatch", `Array index in '${path}' is out of range.`);
    parent.splice(index, 0, jsonSafeClone(value));
    return;
  }
  if (index >= parent.length) throw createDispatcherError("invalidPatch", `Array index in '${path}' is out of range.`);
  if (op === "remove") parent.splice(index, 1);
  else parent[index] = jsonSafeClone(value);
}

function isAllowedPatchPath(path, allowedPaths) {
  if (!path.startsWith("/data/")) return false;
  return allowedPaths.some(allowed => (
    allowed === path
    || (allowed.endsWith("/*") && path.startsWith(allowed.slice(0, -1)))
  ));
}

function parseJsonPointer(path) {
  if (!path.startsWith("/")) throw createDispatcherError("invalidPatch", `Invalid JSON Pointer '${path}'.`);
  const segments = path.slice(1).split("/").map(segment => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (segments.some(segment => ["__proto__", "prototype", "constructor"].includes(segment))) {
    throw createDispatcherError("invalidPatch", `Unsafe JSON Pointer '${path}'.`);
  }
  return segments;
}

function recordHandlerError(state, entry, code, error) {
  state.errors.push({
    handlerId: entry.id,
    kind: entry.kind,
    code,
    message: String(error?.message ?? error ?? "Unknown handler error")
  });
}

function createFailOpenOutcome(eventKey, payload, reason = "failOpen", root = null) {
  return deepFreeze({
    ok: false,
    reason: String(reason ?? "failOpen"),
    event: null,
    data: safeJsonClone(payload),
    control: createControlState(root),
    appliedPatches: [],
    errors: [],
    skippedHandlers: []
  });
}

function jsonSafeClone(value) {
  assertJsonSafe(value);
  if (value === undefined) return null;
  return structuredClone(value);
}

function safeJsonClone(value) {
  try {
    return jsonSafeClone(value);
  } catch (_error) {
    return null;
  }
}

function assertJsonSafe(value, seen = new Set(), path = "$", { allowUndefined = true } = {}) {
  if (value === undefined) {
    if (allowUndefined) return;
    throw createDispatcherError("invalidPayload", `Undefined is not JSON-safe at '${path}'.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw createDispatcherError("invalidPayload", `Non-finite number is not JSON-safe at '${path}'.`);
  }
  if (typeof value !== "object") throw createDispatcherError("invalidPayload", `Unsupported JSON value at '${path}'.`);
  if (seen.has(value)) throw createDispatcherError("invalidPayload", `Cyclic value is not JSON-safe at '${path}'.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertJsonSafe(entry, seen, `${path}[${index}]`, { allowUndefined: false }));
      return;
    }
    if (!isPlainObject(value)) throw createDispatcherError("invalidPayload", `Non-plain object is not JSON-safe at '${path}'.`);
    for (const [key, entry] of Object.entries(value)) {
      assertJsonSafe(entry, seen, `${path}.${key}`, { allowUndefined: false });
    }
  } finally {
    seen.delete(value);
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeStringArray(value) {
  const source = Array.isArray(value) || value instanceof Set ? Array.from(value) : [];
  return Array.from(new Set(source.map(entry => String(entry ?? "").trim()).filter(Boolean)));
}

function setIntersects(left, right) {
  for (const value of right) if (left.has(value)) return true;
  return false;
}

function normalizeRequiredId(value, label) {
  const id = String(value ?? "").trim();
  if (!id) throw new TypeError(`${label} id is required.`);
  return id;
}

function buildOperationKey(userId, operationId) {
  return `${String(userId ?? "")}:${String(operationId ?? "")}`;
}

function promiseWithResolvers() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDispatcherError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorReason(error) {
  return String(error?.code ?? error?.message ?? error ?? "failOpen");
}

function defaultRandomId() {
  const foundryId = globalThis.foundry?.utils?.randomID?.();
  if (foundryId) return String(foundryId);
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replaceAll("-", "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function setTimedCache(cache, key, value, maximumSize, metadata = {}) {
  cache.delete(key);
  cache.set(key, { value: jsonSafeClone(value), storedAt: Date.now(), ...metadata });
  while (cache.size > maximumSize) cache.delete(cache.keys().next().value);
}

function getTimedCache(cache, key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function pruneTimedCache(cache, ttlMs, maximumSize) {
  const cutoff = Date.now() - ttlMs;
  for (const [key, entry] of cache) {
    if (entry.storedAt < cutoff) cache.delete(key);
  }
  while (cache.size > maximumSize) cache.delete(cache.keys().next().value);
}

function unrefTimer(timer) {
  timer?.unref?.();
}

function capitalize(value) {
  const text = String(value ?? "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function positiveInteger(value, fallback) {
  const number = toInteger(value);
  return number > 0 ? number : fallback;
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
