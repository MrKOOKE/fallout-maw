/**
 * A small client-local queue for document operations.
 *
 * Operations with the same key share one Promise while pending. Operations
 * with different keys run strictly in submission order. A rejection is still
 * returned to the original caller, but it never poisons the queue tail.
 */
export function createCoalescingOperationQueue({ onError = null } = {}) {
  return new CoalescingOperationQueue({ onError });
}

export class CoalescingOperationQueue {
  #onError;
  #tail = Promise.resolve();
  #pending = new Map();
  #generation = 0;

  constructor({ onError = null } = {}) {
    if (onError !== null && typeof onError !== "function") {
      throw new TypeError("onError must be a function or null");
    }
    this.#onError = onError;
  }

  get busy() {
    return this.#pending.size > 0;
  }

  get pendingCount() {
    return this.#pending.size;
  }

  run(key, operation) {
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    const pending = this.#pending.get(key);
    if (pending) return pending;

    this.#generation += 1;
    const result = this.#tail.then(() => operation());
    const tracked = result.finally(() => {
      if (this.#pending.get(key) === tracked) this.#pending.delete(key);
    });
    this.#pending.set(key, tracked);
    this.#tail = tracked.catch(error => {
      try {
        this.#onError?.(error);
      } catch {
        // Reporting must not poison later document operations.
      }
    });
    return tracked;
  }

  async wait() {
    let observedGeneration = -1;
    while (this.#generation > observedGeneration) {
      observedGeneration = this.#generation;
      await this.#tail;
    }
  }
}
