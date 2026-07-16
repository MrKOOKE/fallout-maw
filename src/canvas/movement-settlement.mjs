const pendingMovementOperations = new Map();

/**
 * Register asynchronous work spawned by a synchronous Foundry movement hook.
 *
 * Foundry v14 preMoveToken hooks cannot return a Promise. The system therefore
 * rejects the first move and resumes it asynchronously after reactions or an
 * interruption. Callers which need strict sequencing can wait for this shared
 * registry to become quiescent.
 */
export function trackSystemMovementOperation(tokenDocument, operation, {
  contributesToCompletion = false
} = {}) {
  const promise = Promise.resolve(operation);
  const key = getMovementTokenKey(tokenDocument);
  if (!key) return promise;
  const pending = pendingMovementOperations.get(key) ?? new Set();
  const record = { promise, contributesToCompletion: Boolean(contributesToCompletion) };
  pending.add(record);
  pendingMovementOperations.set(key, pending);
  const cleanup = () => {
    pending.delete(record);
    if (!pending.size && pendingMovementOperations.get(key) === pending) {
      pendingMovementOperations.delete(key);
    }
  };
  promise.then(cleanup, cleanup);
  return promise;
}

/** Wait until every currently or transitively spawned system movement job settles. */
export async function waitForSystemMovementSettlement(tokenDocument, { timeoutMs = 120000 } = {}) {
  const key = getMovementTokenKey(tokenDocument);
  if (!key) return { settled: true, handled: false };
  const timeout = Math.max(1000, Number(timeoutMs) || 120000);
  const deadline = Date.now() + timeout;
  let handled = false;
  let completed = false;
  const outcomes = [];

  while (true) {
    // Give synchronous hooks and promise continuations a chance to register a
    // resume/interruption job before declaring the movement quiescent.
    await Promise.resolve();
    const batch = Array.from(pendingMovementOperations.get(key) ?? []);
    if (!batch.length) {
      await Promise.resolve();
      if (!(pendingMovementOperations.get(key)?.size > 0)) {
        return {
          settled: true,
          handled,
          outcomes,
          completed
        };
      }
      continue;
    }
    handled = true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { settled: false, handled, outcomes, completed };
    const settled = await waitWithTimeout(Promise.allSettled(batch.map(record => record.promise)), remaining);
    if (!settled.completed) return { settled: false, handled, outcomes, completed };
    settled.values.forEach((result, index) => {
      const outcome = result.status === "fulfilled" ? result.value : false;
      outcomes.push(outcome);
      if (batch[index]?.contributesToCompletion && outcome === true) completed = true;
    });
  }
}

function getMovementTokenKey(tokenDocument) {
  return String(tokenDocument?.uuid ?? tokenDocument?.id ?? "").trim();
}

function waitWithTimeout(promise, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ completed: false, values: [] });
    }, Math.max(1, timeoutMs));
    Promise.resolve(promise).then(
      values => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ completed: true, values });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ completed: true, values: [] });
      }
    );
  });
}
