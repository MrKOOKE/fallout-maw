const queuedWorldTimeProcessors = new Set();
const pendingWorldTimeUpdates = [];
let worldTimeHookRegistered = false;
let processingWorldTimeQueue = false;

export function registerQueuedWorldTimeProcessor(processor) {
  if (typeof processor !== "function") return () => {};
  registerWorldTimeQueueHook();
  queuedWorldTimeProcessors.add(processor);
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

async function processWorldTimeQueue() {
  if (processingWorldTimeQueue) return;
  processingWorldTimeQueue = true;
  try {
    while (pendingWorldTimeUpdates.length) {
      const update = pendingWorldTimeUpdates.shift();
      const processors = Array.from(queuedWorldTimeProcessors);
      for (const processor of processors) {
        try {
          await processor(update.worldTime, update.deltaTime, update.options, update.userId);
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
