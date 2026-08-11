const DEFAULT_DEBOUNCE_MS = 50;

/**
 * Create a client-local invalidation scheduler for periodic region effects.
 *
 * The scheduler deliberately knows nothing about Foundry documents beyond their
 * stable keys. Callers can therefore route Actor and Scene hooks into one
 * debounced, strictly serialized projection without coupling hook registration
 * to the reconciliation implementation.
 */
export function createPeriodicDamageEffectSyncScheduler(options = {}) {
  return new PeriodicDamageEffectSyncScheduler(options);
}

export class PeriodicDamageEffectSyncScheduler {
  #sync;
  #onError;
  #setTimer;
  #clearTimer;
  #debounceMs;
  #getActorKey;
  #getSceneKey;
  #pendingActors = new Map();
  #pendingScenes = new Map();
  #timerId = null;
  #due = false;
  #running = null;
  #idle = null;
  #closed = false;

  constructor({
    sync,
    onError = null,
    setTimer = scheduleTimer,
    clearTimer = cancelTimer,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    getActorKey = getDocumentStableKey,
    getSceneKey = getDocumentStableKey
  } = {}) {
    if (typeof sync !== "function") throw new TypeError("sync must be a function");
    if (onError !== null && typeof onError !== "function") {
      throw new TypeError("onError must be a function or null");
    }
    if (typeof setTimer !== "function") throw new TypeError("setTimer must be a function");
    if (typeof clearTimer !== "function") throw new TypeError("clearTimer must be a function");
    if (typeof getActorKey !== "function") throw new TypeError("getActorKey must be a function");
    if (typeof getSceneKey !== "function") throw new TypeError("getSceneKey must be a function");

    const normalizedDebounceMs = Number(debounceMs);
    if (!Number.isFinite(normalizedDebounceMs) || normalizedDebounceMs < 0) {
      throw new TypeError("debounceMs must be a non-negative finite number");
    }

    this.#sync = sync;
    this.#onError = onError;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#debounceMs = normalizedDebounceMs;
    this.#getActorKey = getActorKey;
    this.#getSceneKey = getSceneKey;
  }

  get closed() {
    return this.#closed;
  }

  get busy() {
    return this.#hasWork();
  }

  get running() {
    return this.#running !== null;
  }

  get pendingActorCount() {
    return this.#pendingActors.size;
  }

  get pendingSceneCount() {
    return this.#pendingScenes.size;
  }

  /**
   * Request a scoped projection. A document repeated before the next pass is
   * retained once by stable key, with its newest object reference.
   *
   * @returns {boolean} Whether at least one target was accepted.
   */
  request({ actors = [], scenes = [] } = {}) {
    if (this.#closed) return false;

    // Resolve the entire request before mutating queue state. A malformed Scene
    // must not leave the valid Actor half of the same request stranded without
    // a scheduled flush.
    const actorEntries = collectTargets(
      actors,
      this.#getActorKey,
      "Actor"
    );
    const sceneEntries = collectTargets(
      scenes,
      this.#getSceneKey,
      "Scene"
    );
    if ((actorEntries.length + sceneEntries.length) === 0) return false;

    for (const [key, actor] of actorEntries) this.#pendingActors.set(key, actor);
    for (const [key, scene] of sceneEntries) this.#pendingScenes.set(key, scene);

    this.#ensureIdlePromise();
    this.#schedule();
    return true;
  }

  requestActors(actors) {
    return this.request({ actors });
  }

  requestScenes(scenes) {
    return this.request({ scenes });
  }

  /**
   * Cancel the debounce delay and drain all currently accepted work.
   * If a pass is already running, its successor starts immediately afterward.
   */
  flushNow() {
    if (!this.#closed && this.#hasPendingTargets()) {
      this.#cancelTimer();
      this.#due = true;
      this.#pump();
    }
    return this.wait();
  }

  /**
   * Resolve when the scheduler next becomes fully idle. Requests accepted while
   * that work is running are included in the same wait.
   */
  wait() {
    return this.#idle?.promise ?? Promise.resolve();
  }

  /**
   * Stop accepting work and discard every pass which has not started yet.
   * An already-running sync cannot be cancelled and is allowed to finish.
   */
  close() {
    if (this.#closed) return this.wait();
    this.#closed = true;
    this.#cancelTimer();
    this.#due = false;
    this.#pendingActors.clear();
    this.#pendingScenes.clear();
    this.#resolveIdleIfSettled();
    return this.wait();
  }

  #schedule() {
    if (this.#closed || this.#timerId !== null || this.#due) return;
    this.#timerId = this.#setTimer(() => {
      this.#timerId = null;
      if (this.#closed || !this.#hasPendingTargets()) {
        this.#resolveIdleIfSettled();
        return;
      }
      this.#due = true;
      this.#pump();
    }, this.#debounceMs);
  }

  #pump() {
    if (
      this.#closed
      || this.#running !== null
      || !this.#due
      || !this.#hasPendingTargets()
    ) return;

    this.#due = false;
    const scope = {
      actors: Array.from(this.#pendingActors.values()),
      scenes: Array.from(this.#pendingScenes.values())
    };
    this.#pendingActors.clear();
    this.#pendingScenes.clear();

    const operation = Promise.resolve()
      .then(() => this.#sync(scope))
      .catch(error => this.#reportError(error, scope));
    this.#running = operation;
    void operation.then(() => this.#finish(operation));
  }

  #finish(operation) {
    if (this.#running !== operation) return;
    this.#running = null;

    if (this.#closed) {
      this.#due = false;
      this.#pendingActors.clear();
      this.#pendingScenes.clear();
      this.#resolveIdleIfSettled();
      return;
    }

    // A timer may have elapsed while the previous pass was running. In that
    // case #due is already true and the successor can begin without a second
    // debounce. Otherwise preserve the outstanding timer and its remaining
    // debounce window.
    if (this.#due && this.#hasPendingTargets()) this.#pump();
    else if (this.#hasPendingTargets() && this.#timerId === null) this.#schedule();
    this.#resolveIdleIfSettled();
  }

  #reportError(error, scope) {
    if (!this.#onError) return;
    try {
      const result = this.#onError(error, scope);
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Error reporting must never poison later projection passes.
    }
  }

  #cancelTimer() {
    if (this.#timerId === null) return;
    this.#clearTimer(this.#timerId);
    this.#timerId = null;
  }

  #hasPendingTargets() {
    return this.#pendingActors.size > 0 || this.#pendingScenes.size > 0;
  }

  #hasWork() {
    return this.#running !== null
      || this.#timerId !== null
      || this.#due
      || this.#hasPendingTargets();
  }

  #ensureIdlePromise() {
    if (this.#idle !== null) return;
    let resolve;
    const promise = new Promise(resolvePromise => {
      resolve = resolvePromise;
    });
    this.#idle = { promise, resolve };
  }

  #resolveIdleIfSettled() {
    if (this.#hasWork() || this.#idle === null) return;
    const idle = this.#idle;
    this.#idle = null;
    idle.resolve();
  }
}

function collectTargets(targets, getKey, label) {
  const entries = [];
  for (const target of asIterable(targets)) {
    if (target === null || target === undefined) continue;
    const key = getKey(target);
    if (key === null || key === undefined || String(key).trim() === "") {
      throw new TypeError(`${label} invalidation targets must have a stable uuid or id`);
    }
    entries.push([String(key), target]);
  }
  return entries;
}

function asIterable(value) {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string" && typeof value[Symbol.iterator] === "function") return value;
  return [value];
}

function getDocumentStableKey(document) {
  if (typeof document === "string" || typeof document === "number" || typeof document === "bigint") {
    return String(document);
  }
  return document?.uuid ?? document?.id ?? document?._id ?? null;
}

function scheduleTimer(callback, delay) {
  return globalThis.setTimeout(callback, delay);
}

function cancelTimer(timerId) {
  globalThis.clearTimeout(timerId);
}
