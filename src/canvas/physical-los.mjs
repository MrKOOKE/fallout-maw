import { SYSTEM_ID } from "../constants.mjs";

const DEFAULT_COALESCE_MS = 50;
const YIELD_EVERY_PAIRS = 64;

/**
 * A gameplay LOS predicate shared by fixed abilities and semantic vision events.
 * It intentionally ignores hidden/stealth state: those are separate gameplay layers.
 */
export function canTokenPhysicallySeeTarget(observerToken, targetToken) {
  if (!globalThis.canvas?.ready || !observerToken || !targetToken) return false;
  if (!canvas.visibility?.tokenVision) return true;
  const results = testObserverVisibilityBatch(observerToken, [targetToken]);
  return Boolean(results.get(tokenDocumentUuid(targetToken)));
}

/**
 * Reuse one VisionSource across many targets for the same observer.
 * @returns {Map<string, boolean>} targetUuid -> visible
 */
export function testObserverVisibilityBatch(observerToken, targetTokens = []) {
  const results = new Map();
  if (!globalThis.canvas?.ready || !observerToken) return results;
  if (!canvas.visibility?.tokenVision) {
    for (const targetToken of targetTokens) {
      const uuid = tokenDocumentUuid(targetToken);
      if (uuid) results.set(uuid, true);
    }
    return results;
  }

  const tokenDocument = observerToken.document ?? observerToken;
  const VisionSource = CONFIG.Canvas?.visionSourceClass;
  if (!observerToken.hasSight || !VisionSource || typeof observerToken._getVisionSourceData !== "function") {
    for (const targetToken of targetTokens) {
      const uuid = tokenDocumentUuid(targetToken);
      if (uuid) results.set(uuid, false);
    }
    return results;
  }
  if (typeof canvas.visibility?._createVisibilityTestConfig !== "function") {
    for (const targetToken of targetTokens) {
      const uuid = tokenDocumentUuid(targetToken);
      if (uuid) results.set(uuid, false);
    }
    return results;
  }

  const source = new VisionSource({
    sourceId: `${observerToken.sourceId ?? tokenDocument.id}.physical-los.${foundry.utils.randomID()}`,
    object: observerToken
  });
  try {
    Object.assign(source.blinded, observerToken._getVisionBlindedStates?.() ?? {});
    const sourceData = observerToken._getVisionSourceData();
    const origin = getTokenAimPoint(observerToken, sourceData);
    source.initialize({
      ...sourceData,
      x: origin.x,
      y: origin.y,
      elevation: origin.elevation,
      disabled: false,
      preview: false
    });
    if (source.isBlinded) {
      for (const targetToken of targetTokens) {
        const uuid = tokenDocumentUuid(targetToken);
        if (uuid) results.set(uuid, false);
      }
      return results;
    }

    for (const targetToken of targetTokens) {
      const uuid = tokenDocumentUuid(targetToken);
      if (!uuid) continue;
      try {
        const points = getTokenVisibilityTestPoints(targetToken, origin);
        const config = canvas.visibility._createVisibilityTestConfig(points, {
          tolerance: 0,
          object: targetToken
        });
        let visible = false;
        for (const modeId of ["basicSight", "lightPerception"]) {
          const mode = tokenDocument.detectionModes?.[modeId];
          const detectionMode = CONFIG.Canvas.detectionModes?.[modeId];
          if (mode && detectionMode?.testVisibility(source, mode, config) === true) {
            visible = true;
            break;
          }
        }
        results.set(uuid, visible);
      } catch (error) {
        console.warn(`${SYSTEM_ID} | Physical LOS test failed`, error);
        results.set(uuid, false);
      }
    }
    return results;
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Physical LOS observer batch failed`, error);
    for (const targetToken of targetTokens) {
      const uuid = tokenDocumentUuid(targetToken);
      if (uuid && !results.has(uuid)) results.set(uuid, false);
    }
    return results;
  } finally {
    source.destroy();
  }
}

function tokenDocumentUuid(token) {
  return String(token?.document?.uuid ?? token?.uuid ?? "").trim();
}

function getTokenAimPoint(token, sourceData = {}) {
  const document = token?.document ?? token;
  const origin = document?.getMovementOrigin?.() ?? token?.center ?? {};
  const elevation = getTokenAimElevation(token, sourceData?.elevation ?? document?.elevation);
  return {
    x: Number(origin?.x ?? sourceData?.x) || 0,
    y: Number(origin?.y ?? sourceData?.y) || 0,
    elevation
  };
}

function getTokenAimElevation(token, fallback = 0) {
  const document = token?.document ?? token;
  const bottom = Number(document?.elevation ?? fallback) || 0;
  const top = Number(token?.topZ ?? document?.elevationTop ?? bottom);
  return Number.isFinite(top) && top > bottom ? bottom + ((top - bottom) * 0.7) : bottom;
}

function getTokenVisibilityTestPoints(token, origin = {}) {
  const document = token?.document ?? token;
  const bounds = token?.bounds;
  const center = token?.center ?? document?.getMovementOrigin?.() ?? {
    x: Number(bounds?.x) + (Number(bounds?.width) / 2),
    y: Number(bounds?.y) + (Number(bounds?.height) / 2)
  };
  const elevation = getTokenAimElevation(token, document?.elevation);
  const points = [{ x: Number(center?.x) || 0, y: Number(center?.y) || 0, elevation }];
  if (bounds && Number(bounds.width) > 0 && Number(bounds.height) > 0) {
    const insetX = Math.max(1, Number(bounds.width) * 0.15);
    const insetY = Math.max(1, Number(bounds.height) * 0.15);
    points.push(
      { x: Number(bounds.left ?? bounds.x) + insetX, y: Number(bounds.top ?? bounds.y) + insetY, elevation },
      { x: Number(bounds.right ?? (bounds.x + bounds.width)) - insetX, y: Number(bounds.top ?? bounds.y) + insetY, elevation },
      { x: Number(bounds.left ?? bounds.x) + insetX, y: Number(bounds.bottom ?? (bounds.y + bounds.height)) - insetY, elevation },
      { x: Number(bounds.right ?? (bounds.x + bounds.width)) - insetX, y: Number(bounds.bottom ?? (bounds.y + bounds.height)) - insetY, elevation }
    );
  }
  return points.sort((left, right) => (
    Math.hypot(left.x - origin.x, left.y - origin.y)
    - Math.hypot(right.x - origin.x, right.y - origin.y)
  ));
}

/**
 * Lazy directed-pair transition cache.
 * - No launch-time O(n²) seed
 * - Token-scoped refresh is O(n) with one VisionSource per observer
 * - Full refresh only when the caller asks for it (walls/lights/scene)
 * - Invalidations coalesce across in-flight work via a dirty flag
 */
export function createPhysicalLosTransitionCache({
  collectSceneTokens,
  testObserverBatch = testObserverVisibilityBatch,
  emit,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  coalesceMs = DEFAULT_COALESCE_MS,
  yieldEvery = YIELD_EVERY_PAIRS
} = {}) {
  const sceneCaches = new Map();
  const pending = new Map();
  const inFlight = new Map();
  let armed = false;

  function isArmed() {
    return armed;
  }

  function setArmed(value) {
    armed = Boolean(value);
  }

  function getCache(sceneKey) {
    const key = String(sceneKey ?? "");
    let cache = sceneCaches.get(key);
    if (!cache) {
      cache = new Map();
      sceneCaches.set(key, cache);
    }
    return cache;
  }

  async function refreshTokens(sceneKey, tokenUuids = [], { silent = false } = {}) {
    const key = String(sceneKey ?? "");
    const focus = new Set((tokenUuids ?? []).map(uuid => String(uuid ?? "").trim()).filter(Boolean));
    if (!focus.size) return getCache(key);

    const tokens = await collectSceneTokens(key) ?? [];
    const byUuid = new Map();
    for (const token of tokens) {
      const uuid = tokenDocumentUuid(token);
      if (uuid) byUuid.set(uuid, token);
    }

    const cache = getCache(key);
    let tested = 0;
    let emitted = 0;
    let materialized = 0;

    // As observer: one batch per focused token against all other scene tokens.
    for (const observerUuid of focus) {
      const observerToken = byUuid.get(observerUuid);
      if (!observerToken) continue;
      const targets = tokens.filter(token => tokenDocumentUuid(token) !== observerUuid);
      const visibility = await testObserverBatch(observerToken, targets);
      for (const targetToken of targets) {
        const targetUuid = tokenDocumentUuid(targetToken);
        if (!targetUuid) continue;
        tested += 1;
        const changed = await writePair(cache, {
          sceneUuid: key,
          observerUuid,
          targetUuid,
          observerToken,
          targetToken,
          visible: Boolean(visibility.get(targetUuid)),
          silent
        });
        if (changed.materialized) materialized += 1;
        if (changed.emitted) emitted += 1;
        if (yieldEvery > 0 && tested % yieldEvery === 0) await yieldOnce();
      }
    }

    // As target: every other observer looks at each focused token.
    const focusedTargets = Array.from(focus).map(uuid => byUuid.get(uuid)).filter(Boolean);
    if (focusedTargets.length) {
      for (const [observerUuid, observerToken] of byUuid) {
        if (focus.has(observerUuid)) continue;
        const visibility = await testObserverBatch(observerToken, focusedTargets);
        for (const targetToken of focusedTargets) {
          const targetUuid = tokenDocumentUuid(targetToken);
          if (!targetUuid) continue;
          tested += 1;
          const changed = await writePair(cache, {
            sceneUuid: key,
            observerUuid,
            targetUuid,
            observerToken,
            targetToken,
            visible: Boolean(visibility.get(targetUuid)),
            silent
          });
          if (changed.materialized) materialized += 1;
          if (changed.emitted) emitted += 1;
          if (yieldEvery > 0 && tested % yieldEvery === 0) await yieldOnce();
        }
      }
    }

    return cache;
  }

  async function refreshAll(sceneKey, { silent = false } = {}) {
    const key = String(sceneKey ?? "");
    const tokens = await collectSceneTokens(key) ?? [];
    const uuids = tokens.map(token => tokenDocumentUuid(token)).filter(Boolean);
    if (!uuids.length) {
      sceneCaches.set(key, new Map());
      return getCache(key);
    }
    // Full scene rebuild: clear then materialize each token as observer only (covers all directed pairs once).
    const previous = sceneCaches.get(key) ?? new Map();
    sceneCaches.set(key, new Map());
    const cache = getCache(key);

    let tested = 0;
    let emitted = 0;
    let materialized = 0;

    for (const observerToken of tokens) {
      const observerUuid = tokenDocumentUuid(observerToken);
      if (!observerUuid) continue;
      const targets = tokens.filter(token => tokenDocumentUuid(token) !== observerUuid);
      const visibility = await testObserverBatch(observerToken, targets);
      for (const targetToken of targets) {
        const targetUuid = tokenDocumentUuid(targetToken);
        if (!targetUuid) continue;
        tested += 1;
        const pairKey = `${observerUuid}>${targetUuid}`;
        const visible = Boolean(visibility.get(targetUuid));
        const old = previous.get(pairKey);
        const pair = {
          sceneUuid: key,
          observerUuid,
          targetUuid,
          observerActorUuid: String(observerToken.actor?.uuid ?? ""),
          targetActorUuid: String(targetToken.actor?.uuid ?? ""),
          observerToken,
          targetToken
        };
        cache.set(pairKey, { visible, pair });
        if (!old) {
          materialized += 1;
          continue;
        }
        if (silent || old.visible === visible) continue;
        emitted += 1;
        await emit?.({ type: visible ? "gained" : "lost", pair });
      }
      if (yieldEvery > 0) await yieldOnce();
    }

    // Dropped tokens: previous pairs that no longer exist.
    if (!silent) {
      for (const [pairKey, old] of previous) {
        if (cache.has(pairKey)) continue;
        if (!old?.visible) continue;
        emitted += 1;
        await emit?.({ type: "lost", pair: old.pair });
      }
    }

    return cache;
  }

  async function writePair(cache, {
    sceneUuid,
    observerUuid,
    targetUuid,
    observerToken,
    targetToken,
    visible,
    silent
  }) {
    const pairKey = `${observerUuid}>${targetUuid}`;
    const old = cache.get(pairKey);
    const pair = {
      sceneUuid,
      observerUuid,
      targetUuid,
      observerActorUuid: String(observerToken?.actor?.uuid ?? old?.pair?.observerActorUuid ?? ""),
      targetActorUuid: String(targetToken?.actor?.uuid ?? old?.pair?.targetActorUuid ?? ""),
      observerToken,
      targetToken
    };
    cache.set(pairKey, { visible, pair });
    if (!old) return { materialized: true, emitted: false };
    if (silent || old.visible === visible) return { materialized: false, emitted: false };
    await emit?.({ type: visible ? "gained" : "lost", pair });
    return { materialized: false, emitted: true };
  }

  async function removeToken(sceneKey, tokenUuid, { silent = false } = {}) {
    const key = String(sceneKey ?? "");
    const uuid = String(tokenUuid ?? "").trim();
    if (!uuid) return getCache(key);
    const cache = getCache(key);
    for (const [pairKey, entry] of [...cache.entries()]) {
      const [observerUuid, targetUuid] = pairKey.split(">");
      if (observerUuid !== uuid && targetUuid !== uuid) continue;
      cache.delete(pairKey);
      if (!silent && entry?.visible) await emit?.({ type: "lost", pair: entry.pair });
    }
    return cache;
  }

  /**
   * Schedule work. Modes:
   * - { tokenUuids } incremental O(n)
   * - { full: true } full scene rebuild
   * - { removeTokenUuid } drop pairs for a deleted token
   * Coalesces across timers AND in-flight runs (dirty flag). While disarmed, no-ops.
   */
  function invalidate(sceneKey, {
    silent = false,
    full = false,
    tokenUuids = null,
    removeTokenUuid = ""
  } = {}) {
    if (!armed) return Promise.resolve(getCache(String(sceneKey ?? "")));
    const key = String(sceneKey ?? "");
    const request = {
      silent: Boolean(silent),
      full: Boolean(full),
      tokenUuids: new Set((tokenUuids ?? []).map(uuid => String(uuid ?? "").trim()).filter(Boolean)),
      removeTokenUuid: String(removeTokenUuid ?? "").trim()
    };

    const active = pending.get(key);
    if (active) {
      mergeRequest(active.request, request);
      return active.promise;
    }

    const flying = inFlight.get(key);
    if (flying) {
      flying.dirty = mergeRequest(flying.dirty ?? emptyRequest(), request);
      if (!flying.followUp) {
        flying.followUp = flying.promise.then(() => {
          const dirty = flying.dirty;
          flying.dirty = null;
          flying.followUp = null;
          if (!dirty) return getCache(key);
          return invalidate(key, {
            silent: dirty.silent,
            full: dirty.full,
            tokenUuids: Array.from(dirty.tokenUuids),
            removeTokenUuid: dirty.removeTokenUuid
          });
        });
      }
      return flying.followUp;
    }

    let resolvePending;
    const promise = new Promise(resolve => { resolvePending = resolve; });
    const state = { request, promise, timerId: null };
    state.timerId = setTimer(async () => {
      pending.delete(key);
      const flight = { dirty: null, followUp: null, promise: null };
      flight.promise = (async () => {
        inFlight.set(key, flight);
        try {
          return await runRequest(key, state.request);
        } catch (error) {
          console.error(`${SYSTEM_ID} | Physical LOS cache refresh failed`, error);
          return getCache(key);
        } finally {
          inFlight.delete(key);
        }
      })();
      try {
        resolvePending(await flight.promise);
      } catch (_error) {
        resolvePending(getCache(key));
      }
    }, Math.max(0, Number(coalesceMs) || 0));
    pending.set(key, state);
    return promise;
  }

  async function runRequest(sceneKey, request) {
    if (request.removeTokenUuid && !request.full && !request.tokenUuids.size) {
      return removeToken(sceneKey, request.removeTokenUuid, { silent: request.silent });
    }
    if (request.full || !request.tokenUuids.size) {
      return refreshAll(sceneKey, { silent: request.silent });
    }
    if (request.removeTokenUuid) {
      await removeToken(sceneKey, request.removeTokenUuid, { silent: request.silent });
    }
    return refreshTokens(sceneKey, Array.from(request.tokenUuids), { silent: request.silent });
  }

  function emptyRequest() {
    return { silent: true, full: false, tokenUuids: new Set(), removeTokenUuid: "" };
  }

  function mergeRequest(target, next) {
    target.silent = Boolean(target.silent) && Boolean(next.silent);
    target.full = Boolean(target.full) || Boolean(next.full);
    if (next.removeTokenUuid) target.removeTokenUuid = next.removeTokenUuid;
    for (const uuid of next.tokenUuids ?? []) target.tokenUuids.add(uuid);
    if (target.full) target.tokenUuids.clear();
    return target;
  }

  function reset(sceneKey = null) {
    const keys = sceneKey === null
      ? Array.from(new Set([...pending.keys(), ...sceneCaches.keys(), ...inFlight.keys()]))
      : [String(sceneKey ?? "")];
    for (const key of keys) {
      const active = pending.get(key);
      if (active) clearTimer(active.timerId);
      pending.delete(key);
      sceneCaches.delete(key);
    }
    if (sceneKey === null) sceneCaches.clear();
  }

  /** @deprecated Kept for callers/tests that still expect evaluate(); prefers full refresh. */
  async function evaluate(sceneKey, { silent = false } = {}) {
    return refreshAll(sceneKey, { silent });
  }

  return Object.freeze({
    evaluate,
    invalidate,
    reset,
    refreshTokens,
    refreshAll,
    removeToken,
    isArmed,
    setArmed,
    sceneCaches
  });
}

function yieldOnce() {
  return new Promise(resolve => setTimeout(resolve, 0));
}
