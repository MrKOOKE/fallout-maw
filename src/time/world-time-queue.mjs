import { dispatchSystemEvent, withSystemEventRoot } from "../events/dispatcher.mjs";

const queuedWorldTimeProcessors = new Map();
const pendingWorldTimeUpdates = [];
let worldTimeHookRegistered = false;
let processingWorldTimeQueue = false;
let worldTimeAdvanceQueue = Promise.resolve();
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
  const advance = worldTimeAdvanceQueue.then(() => withSystemEventRoot({
    kind: "worldTimeAdvance",
    operationId: `world-time:${foundry.utils.randomID()}`,
    sceneUuid: String(canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef
  }, async scope => {
    const before = Number(game.time?.worldTime) || 0;
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
    await game.time.advance(amount, {
      [SYSTEM_TIME_ADVANCE_OPTION]: true,
      falloutMawSystemEventChainRef: scope.chainRef,
      chainRef: scope.chainRef,
      falloutMaw: {
        restMode: Boolean(restMode),
        forceTimeMechanics: Boolean(forceTimeMechanics),
        ...(campRest ? { campRest } : {})
      }
    });
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
  }));
  worldTimeAdvanceQueue = advance.catch(error => {
    console.error("Fallout MaW | Queued world time advance failed", error);
    return false;
  });
  return advance;
}

export function registerQueuedWorldTimeProcessor(processor, { priority = 0 } = {}) {
  if (typeof processor !== "function") return () => {};
  registerWorldTimeQueueHook();
  queuedWorldTimeProcessors.set(processor, Number(priority) || 0);
  return () => queuedWorldTimeProcessors.delete(processor);
}

function registerWorldTimeQueueHook() {
  if (worldTimeHookRegistered) return;
  Hooks.on("updateWorldTime", enqueueWorldTimeUpdate);
  Hooks.on("updateWorldTime", emitExternalWorldTimeUpdate);
  worldTimeHookRegistered = true;
}

function emitExternalWorldTimeUpdate(worldTime, deltaTime, options = {}, userId = "") {
  if (options?.[SYSTEM_TIME_ADVANCE_OPTION] || !isCurrentActiveGM()) return;
  const after = Number(worldTime) || 0;
  const delta = Number(deltaTime) || 0;
  void dispatchSystemEvent("fallout-maw.world.time.advanced", {
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
  let worldTime = Number(first.worldTime) || 0;
  let deltaTime = Number(first.deltaTime) || 0;
  const current = Number(game.time?.worldTime) || 0;

  while (pendingWorldTimeUpdates.length) {
    const peek = pendingWorldTimeUpdates[0];
    const peekW = Number(peek.worldTime) || 0;
    if (peekW > current) break;
    const next = pendingWorldTimeUpdates.shift();
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
    userId: first.userId
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
    }
  } finally {
    processingWorldTimeQueue = false;
    if (pendingWorldTimeUpdates.length) void processWorldTimeQueue();
  }
}
