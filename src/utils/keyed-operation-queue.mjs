/** Serialize commands for the same document without blocking unrelated documents. */
export function createKeyedOperationQueue() {
  const pending = new Map();
  return function queue(key, operation) {
    const previous = pending.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    pending.set(key, task);
    return task.finally(() => {
      if (pending.get(key) === task) pending.delete(key);
    });
  };
}
