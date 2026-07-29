function requestBrowserFrame(callback) {
  const browserWindow = globalThis.window;
  if (typeof browserWindow?.requestAnimationFrame === "function") {
    return browserWindow.requestAnimationFrame(callback);
  }
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(globalThis.performance?.now?.() ?? Date.now()), 0);
}

function cancelBrowserFrame(frameId) {
  const browserWindow = globalThis.window;
  if (typeof browserWindow?.cancelAnimationFrame === "function") {
    browserWindow.cancelAnimationFrame(frameId);
    return;
  }
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(frameId);
    return;
  }
  globalThis.clearTimeout(frameId);
}

/**
 * Coalesce repeated work requests into one callback on the next browser frame.
 * Only the newest value is retained. A pending callback can be flushed
 * synchronously before an interaction is committed.
 */
export function createLatestFrameScheduler(callback, {
  requestFrame = requestBrowserFrame,
  cancelFrame = cancelBrowserFrame
} = {}) {
  if (typeof callback !== "function") {
    throw new TypeError("Latest-frame scheduler requires a callback.");
  }

  let frameId = null;
  let latestValue;
  let destroyed = false;

  const run = time => {
    if (destroyed || frameId === null) return false;
    frameId = null;
    const value = latestValue;
    latestValue = undefined;
    callback(value, time);
    return true;
  };

  return {
    request(value) {
      if (destroyed) return false;
      latestValue = value;
      if (frameId !== null) return false;
      frameId = requestFrame(run);
      return true;
    },

    flush(time = globalThis.performance?.now?.() ?? Date.now()) {
      if (destroyed || frameId === null) return false;
      const pendingFrameId = frameId;
      frameId = null;
      cancelFrame(pendingFrameId);
      const value = latestValue;
      latestValue = undefined;
      callback(value, time);
      return true;
    },

    cancel() {
      if (frameId === null) {
        latestValue = undefined;
        return false;
      }
      const pendingFrameId = frameId;
      frameId = null;
      latestValue = undefined;
      cancelFrame(pendingFrameId);
      return true;
    },

    destroy() {
      if (destroyed) return;
      this.cancel();
      destroyed = true;
    },

    get pending() {
      return frameId !== null;
    }
  };
}
