import { dispatchSystemEvent, withSystemEventRoot } from "../events/dispatcher.mjs";

const queuedWorldTimeProcessors = new Map();
const queuedWorldTimeFinalizers = new Set();
const pendingWorldTimeUpdates = [];
let worldTimeHookRegistered = false;
let processingWorldTimeQueue = false;
let worldTimeAdvanceQueue = Promise.resolve();
let worldTimeQueueIdlePromise = Promise.resolve();
let resolveWorldTimeQueueIdle = null;
const SYSTEM_TIME_ADVANCE_OPTION = "falloutMawSystemTimeAdvance";

export async function advanceWorldTime(seconds, {
  restMode = false,
  campRest = null,
  forceTimeMechanics = false,
  chainRef = null,
  source = "system"
} = {}) {
  const amount = Math.trunc(Number(seconds) || 0);
  if (!amount || !game.user?.isGM) return false;
  return enqueueWorldTimeMutation(() => amount, {
    restMode,
    campRest,
    forceTimeMechanics,
    chainRef,
    source
  });
}

/**
 * Set an absolute world-time target through the same serialized pipeline as
 * relative advances. The delta is intentionally calculated only when this
 * operation reaches the head of the shared queue, so an earlier time mutation
 * cannot make a precomputed delta overshoot the requested target.
 */
export async function setWorldTime(targetSeconds, {
  restMode = false,
  campRest = null,
  forceTimeMechanics = false,
  chainRef = null,
  source = "system"
} = {}) {
  const numericTarget = Number(targetSeconds);
  if (!Number.isFinite(numericTarget) || !game.user?.isGM) return false;
  const target = Math.trunc(numericTarget);
  return enqueueWorldTimeMutation(before => target - before, {
    restMode,
    campRest,
    forceTimeMechanics,
    chainRef,
    source,
    zeroResult: true,
    absoluteTarget: target
  });
}

function enqueueWorldTimeMutation(resolveAmount, {
  restMode = false,
  campRest = null,
  forceTimeMechanics = false,
  chainRef = null,
  source = "system",
  zeroResult = false,
  absoluteTarget = null
} = {}) {
  const advance = worldTimeAdvanceQueue.then(async () => {
    const before = Number(game.time?.worldTime) || 0;
    const amount = Math.trunc(Number(resolveAmount(before)) || 0);
    if (!amount) return zeroResult;
    return withSystemEventRoot({
      kind: "worldTimeAdvance",
      operationId: `world-time:${foundry.utils.randomID()}`,
      sceneUuid: String(canvas?.scene?.uuid ?? ""),
      combatUuid: String(game.combat?.uuid ?? ""),
      chainRef
    }, async scope => {
      const requested = await scope.emit("fallout-maw.world.time.beforeAdvance", {
        data: { seconds: amount, source: String(source ?? "system") },
        before: { worldTime: before },
        after: { worldTime: before + amount },
        delta: { worldTime: amount }
      }, {
        occurrenceKey: `world-time-before:${scope.rootId}:${before}:${amount}`,
        participants: { source: null, target: null, related: [] }
      });
      if (requested?.control?.current || requested?.control?.remaining || requested?.control?.root) return false;
      const timeOptions = {
        [SYSTEM_TIME_ADVANCE_OPTION]: true,
        falloutMawWorldTimeSource: String(source ?? "system"),
        falloutMawSystemEventChainRef: scope.chainRef,
        chainRef: scope.chainRef,
        falloutMaw: {
          restMode: Boolean(restMode),
          forceTimeMechanics: Boolean(forceTimeMechanics),
          ...(campRest ? { campRest } : {})
        }
      };
      if (Number.isFinite(absoluteTarget)) await game.time.set(absoluteTarget, timeOptions);
      else await game.time.advance(amount, timeOptions);
      await waitForWorldTimeQueueIdle();
      const after = Number(game.time?.worldTime) || (before + amount);
      await scope.emit("fallout-maw.world.time.advanced", {
        data: { seconds: after - before, source: String(source ?? "system") },
        before: { worldTime: before },
        after: { worldTime: after },
        delta: { worldTime: after - before },
        outcome: { advanced: true }
      }, {
        occurrenceKey: `world-time-advanced:${scope.rootId}:${after}`,
        participants: { source: null, target: null, related: [] }
      });
      return true;
    });
  });
  worldTimeAdvanceQueue = advance.catch(error => {
    console.error("Fallout MaW | Queued world time mutation failed", error);
    return false;
  });
  return advance;
}

export function waitForWorldTimeQueueIdle() {
  return worldTimeQueueIdlePromise;
}

export function registerQueuedWorldTimeProcessor(processor, { priority = 0 } = {}) {
  if (typeof processor !== "function") return () => {};
  registerWorldTimeQueueHook();
  queuedWorldTimeProcessors.set(processor, Number(priority) || 0);
  return () => queuedWorldTimeProcessors.delete(processor);
}

/**
 * Register work which must observe the completed result of every queued
 * world-time processor, regardless of their current or future priorities.
 */
export function registerQueuedWorldTimeFinalizer(finalizer) {
  if (typeof finalizer !== "function") return () => {};
  registerWorldTimeQueueHook();
  queuedWorldTimeFinalizers.add(finalizer);
  return () => queuedWorldTimeFinalizers.delete(finalizer);
}

function registerWorldTimeQueueHook() {
  if (worldTimeHookRegistered) return;
  Hooks.on("updateWorldTime", enqueueWorldTimeUpdate);
  worldTimeHookRegistered = true;
}

async function emitExternalWorldTimeUpdate(worldTime, deltaTime, options = {}, userId = "") {
  if (options?.[SYSTEM_TIME_ADVANCE_OPTION] || !isCurrentActiveGM()) return;
  const after = Number(worldTime) || 0;
  const delta = Number(deltaTime) || 0;
  await dispatchSystemEvent("fallout-maw.world.time.advanced", {
    data: { seconds: delta, source: "external", userId: String(userId ?? "") },
    before: { worldTime: after - delta },
    after: { worldTime: after },
    delta: { worldTime: delta },
    outcome: { advanced: true, external: true }
  }, {
    kind: "externalWorldTimeUpdate",
    operationId: `world-time-external:${userId}:${after}:${delta}`,
    sceneUuid: String(canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    occurrenceKey: `world-time-external:${userId}:${after}:${delta}`,
    participants: { source: null, target: null, related: [] }
  });
}

function enqueueWorldTimeUpdate(worldTime, deltaTime, options, userId) {
  markWorldTimeQueueBusy();
  pendingWorldTimeUpdates.push({
    worldTime: Number(worldTime) || 0,
    deltaTime: Number(deltaTime) || 0,
    options,
    userId
  });
  void processWorldTimeQueue();
}

function isCurrentActiveGM() {
  return Boolean(game.users?.activeGM?.id && game.users.activeGM.id === game.user?.id);
}

function pullCoalescedWorldTimeUpdate() {
  if (!pendingWorldTimeUpdates.length) return null;
  const first = pendingWorldTimeUpdates.shift();
  const sourceUpdates = [first];
  let worldTime = Number(first.worldTime) || 0;
  let deltaTime = Number(first.deltaTime) || 0;
  const current = Number(game.time?.worldTime) || 0;

  while (pendingWorldTimeUpdates.length) {
    const peek = pendingWorldTimeUpdates[0];
    const peekW = Number(peek.worldTime) || 0;
    if (peekW > current) break;
    const next = pendingWorldTimeUpdates.shift();
    sourceUpdates.push(next);
    deltaTime += Number(next.deltaTime) || 0;
    worldTime = Number(next.worldTime) || worldTime;
  }

  if (current > worldTime) {
    deltaTime += current - worldTime;
    worldTime = current;
  }

  return {
    worldTime,
    deltaTime,
    options: first.options,
    userId: first.userId,
    sourceUpdates
  };
}

async function processWorldTimeQueue() {
  if (processingWorldTimeQueue) return;
  processingWorldTimeQueue = true;
  try {
    while (pendingWorldTimeUpdates.length) {
      const update = pullCoalescedWorldTimeUpdate();
      if (!update) break;
      const processors = Array.from(queuedWorldTimeProcessors.entries())
        .sort((left, right) => right[1] - left[1])
        .map(([processor]) => processor);
      let wt = update.worldTime;
      let dt = update.deltaTime;
      for (const processor of processors) {
        try {
          const clock = Number(game.time?.worldTime) || 0;
          if (clock > wt) {
            dt += clock - wt;
            wt = clock;
          }
          await processor(wt, dt, update.options, update.userId);
        } catch (error) {
          console.error("Fallout MaW | World time processor failed", error);
        }
      }
      for (const finalizer of Array.from(queuedWorldTimeFinalizers)) {
        try {
          const clock = Number(game.time?.worldTime) || 0;
          if (clock > wt) {
            dt += clock - wt;
            wt = clock;
          }
          await finalizer(wt, dt, update.options, update.userId);
        } catch (error) {
          console.error("Fallout MaW | World time finalizer failed", error);
        }
      }
      for (const sourceUpdate of update.sourceUpdates) {
        try {
          await emitExternalWorldTimeUpdate(
            sourceUpdate.worldTime,
            sourceUpdate.deltaTime,
            sourceUpdate.options,
            sourceUpdate.userId
          );
        } catch (error) {
          console.error("Fallout MaW | World time event dispatch failed", error);
        }
      }
    }
  } finally {
    processingWorldTimeQueue = false;
    if (pendingWorldTimeUpdates.length) {
      void processWorldTimeQueue();
    } else {
      markWorldTimeQueueIdle();
    }
  }
}

function markWorldTimeQueueBusy() {
  if (resolveWorldTimeQueueIdle) return;
  worldTimeQueueIdlePromise = new Promise(resolve => {
    resolveWorldTimeQueueIdle = resolve;
  });
}

function markWorldTimeQueueIdle() {
  const resolve = resolveWorldTimeQueueIdle;
  resolveWorldTimeQueueIdle = null;
  resolve?.();
}
