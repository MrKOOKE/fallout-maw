// #region codex-runtime-debug smoke-fps-root-cause helper
const DEBUG_SERVER_ENDPOINT = "http://127.0.0.1:62322/ingest/04b6712b24b34d3ab8325a70798a4160";
const DEBUG_HEALTH_ENDPOINT = "http://127.0.0.1:62322/health/04b6712b24b34d3ab8325a70798a4160";
const DEBUG_SESSION_ID = "dbg-20260904T091624Z-206910be";
const DEBUG_HEADER_NAME = "X-Codex-Debug-Session";
const DEBUG_LOCATION = "src/canvas/smoke-runtime-debug.mjs";
const DEBUG_RUNTIME_KEY = Symbol.for("fallout-maw.codex-runtime-debug.smoke-fps-root-cause");
const DEBUG_MAX_BUCKETS = 80;

const debugEnabled = typeof globalThis.window !== "undefined"
  && typeof globalThis.document !== "undefined"
  && typeof globalThis.fetch === "function";

globalThis[DEBUG_RUNTIME_KEY]?.dispose?.();

let debugBuckets = new Map();
let debugPendingBatch = null;
let debugRunId = null;
let debugReadyRunId = null;
let debugDrainingRunId = null;
let debugTransportReady = false;
let debugTransportWarned = false;
let debugTickInFlight = false;
let debugDisposed = false;
let debugTimer = null;
const debugAcknowledgedDrains = new Set();

const debugHeaders = {
  "Content-Type": "application/json",
  [DEBUG_HEADER_NAME]: DEBUG_SESSION_ID
};

function debugWarnOnce(message, error) {
  if (debugTransportWarned) return;
  debugTransportWarned = true;
  console.warn(`codex-runtime-debug ${message}`, error);
}

async function debugPost(payload) {
  try {
    const response = await fetch(DEBUG_SERVER_ENDPOINT, {
      method: "POST",
      mode: "cors",
      headers: debugHeaders,
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } catch (error) {
    debugWarnOnce("transport failed", error);
    return false;
  }
}

async function syncDebugRun() {
  const response = await fetch(DEBUG_HEALTH_ENDPOINT, {
    mode: "cors",
    headers: { [DEBUG_HEADER_NAME]: DEBUG_SESSION_ID }
  });
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  const health = await response.json();
  const nextRunId = health.activeRunId ?? null;
  if (nextRunId !== debugRunId) {
    debugBuckets.clear();
    debugPendingBatch = null;
    debugReadyRunId = null;
    debugDrainingRunId = null;
    debugRunId = nextRunId;
  }

  if (!debugTransportReady) {
    debugTransportReady = await debugPost({
      hypothesisId: "TRANSPORT",
      location: DEBUG_LOCATION,
      message: "actual Foundry origin reached smoke collector",
      kind: "transport-ready",
      data: {},
      timestamp: Date.now()
    });
  }
  if (debugRunId && debugReadyRunId !== debugRunId) {
    const ready = await debugPost({
      runId: debugRunId,
      hypothesisId: "TRANSPORT",
      location: DEBUG_LOCATION,
      message: "smoke probes ready for run",
      kind: "transport-ready",
      data: {},
      timestamp: Date.now()
    });
    if (ready) debugReadyRunId = debugRunId;
  }
  return health;
}

function normalizeHypotheses(hypothesisId) {
  return (Array.isArray(hypothesisId) ? hypothesisId : [hypothesisId])
    .map(value => String(value ?? "").trim())
    .filter(Boolean);
}

export function smokeDebugStart() {
  if (!debugEnabled || !debugRunId || debugDrainingRunId === debugRunId) return null;
  return performance.now();
}

export function smokeDebugRecord({
  message,
  hypothesisId,
  location,
  startedAt = null,
  count = 1,
  values = {}
}) {
  if (!debugEnabled || !debugRunId || debugDrainingRunId === debugRunId) return;
  const hypotheses = normalizeHypotheses(hypothesisId);
  const normalizedMessage = String(message ?? "smoke metric");
  const normalizedLocation = String(location ?? DEBUG_LOCATION);
  let bucketKey = `${hypotheses.join(",")}\u001f${normalizedLocation}\u001f${normalizedMessage}`;
  let bucket = debugBuckets.get(bucketKey);
  if (!bucket && debugBuckets.size >= DEBUG_MAX_BUCKETS - 1) {
    bucketKey = "TRANSPORT\u001fdebug bucket overflow";
    bucket = debugBuckets.get(bucketKey);
    message = "debug bucket overflow";
    hypothesisId = "TRANSPORT";
    location = DEBUG_LOCATION;
    values = { droppedMetricKeys: 1 };
    startedAt = null;
  }
  if (!bucket) {
    bucket = {
      message: String(message ?? normalizedMessage),
      hypothesisId: normalizeHypotheses(hypothesisId),
      location: String(location ?? normalizedLocation),
      calls: 0,
      totalMs: 0,
      maxMs: 0,
      values: new Map()
    };
    debugBuckets.set(bucketKey, bucket);
  }
  const numericCount = Number(count);
  bucket.calls += Number.isFinite(numericCount) ? numericCount : 1;
  if (Number.isFinite(startedAt)) {
    const durationMs = Math.max(0, performance.now() - startedAt);
    bucket.totalMs += durationMs;
    bucket.maxMs = Math.max(bucket.maxMs, durationMs);
  }
  for (const [name, raw] of Object.entries(values ?? {}).slice(0, 20)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const aggregate = bucket.values.get(name) ?? { total: 0, max: -Infinity, last: 0 };
    aggregate.total += value;
    aggregate.max = Math.max(aggregate.max, value);
    aggregate.last = value;
    bucket.values.set(name, aggregate);
  }
}

function bucketEvent(bucket) {
  const data = {
    calls: bucket.calls,
    totalMs: bucket.totalMs,
    maxMs: bucket.maxMs
  };
  for (const [name, aggregate] of bucket.values) {
    data[`${name}Total`] = aggregate.total;
    data[`${name}Max`] = aggregate.max;
    data[`${name}Last`] = aggregate.last;
  }
  return {
    runId: debugRunId,
    hypothesisId: bucket.hypothesisId,
    location: bucket.location,
    message: bucket.message,
    kind: "timing",
    data,
    timestamp: Date.now()
  };
}

function snapshotBatch() {
  const events = [...debugBuckets.values()].map(bucketEvent);
  debugBuckets = new Map();
  return events.length ? events : null;
}

async function flushPendingBatch() {
  if (!debugPendingBatch) return true;
  if (!(await debugPost(debugPendingBatch))) return false;
  debugPendingBatch = null;
  return true;
}

async function debugTick() {
  if (!debugEnabled || debugDisposed || debugTickInFlight) return;
  debugTickInFlight = true;
  try {
    const health = await syncDebugRun();
    if (!debugRunId) return;
    const drain = health.drainRequest;
    if (drain?.runId === debugRunId) debugDrainingRunId = debugRunId;

    if (!(await flushPendingBatch())) return;
    debugPendingBatch = snapshotBatch();
    if (!(await flushPendingBatch())) return;

    if (
      drain?.runId === debugRunId
      && !health.drainAcknowledged
      && !debugAcknowledgedDrains.has(drain.requestId)
    ) {
      const acknowledged = await debugPost({
        runId: debugRunId,
        hypothesisId: null,
        location: DEBUG_LOCATION,
        message: "smoke probe batches flushed",
        kind: "drain-ack",
        data: { requestId: drain.requestId },
        timestamp: Date.now()
      });
      if (acknowledged) debugAcknowledgedDrains.add(drain.requestId);
    }
  } catch (error) {
    debugWarnOnce("health sync failed", error);
  } finally {
    debugTickInFlight = false;
  }
}

function disposeDebugRuntime() {
  debugDisposed = true;
  if (debugTimer !== null) clearInterval(debugTimer);
}

if (debugEnabled) {
  debugTimer = setInterval(() => void debugTick(), 1000);
  void debugTick();
}

globalThis[DEBUG_RUNTIME_KEY] = { dispose: disposeDebugRuntime };
// #endregion codex-runtime-debug
