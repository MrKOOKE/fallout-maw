const queuedWorldTimeProcessors = new Map();
const pendingWorldTimeUpdates = [];
let worldTimeHookRegistered = false;
let processingWorldTimeQueue = false;

export function registerQueuedWorldTimeProcessor(processor, { priority = 0 } = {}) {
  if (typeof processor !== "function") return () => {};
  registerWorldTimeQueueHook();
  queuedWorldTimeProcessors.set(processor, Number(priority) || 0);
  return () => queuedWorldTimeProcessors.delete(processor);
}

function registerWorldTimeQueueHook() {
  if (worldTimeHookRegistered) return;
  Hooks.on("updateWorldTime", enqueueWorldTimeUpdate);
  worldTimeHookRegistered = true;
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
