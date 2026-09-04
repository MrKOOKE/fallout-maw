// Temporary evidence-only runtime profiler. Remove after the smoke performance
// regression is proven and the user confirms the real-world result.
const SESSION_ID = "dbg-20260904T172844Z-7107f782";
const SERVER_ENDPOINT = "http://127.0.0.1:52930/ingest/61c0c86ecdeb41059dfa71b13930d98a";
const HEALTH_ENDPOINT = "http://127.0.0.1:52930/health/61c0c86ecdeb41059dfa71b13930d98a";
const HEADER_NAME = "X-Codex-Debug-Session";
const HEADER_VALUE = SESSION_ID;
const GLOBAL_KEY = Symbol.for(`fallout-maw.smoke-runtime-debug.${SESSION_ID}`);

function createRuntimeProfiler() {
  const buckets = new Map();
  const wrappers = new WeakMap();
  const profileStack = [];
  const acknowledgedDrains = new Set();
  const pendingGpuQueries = [];
  const headers = { "Content-Type": "application/json", [HEADER_NAME]: HEADER_VALUE };
  let pendingBatch = null;
  let runId = null;
  let readyRunId = null;
  let drainingRunId = null;
  let transportReady = false;
  let transportWarned = false;
  let tickInFlight = false;
  let gpuQueryActive = false;
  let gpuCapabilityRecorded = false;
  const maxBuckets = 300;

  async function post(payload) {
    try {
      const response = await fetch(SERVER_ENDPOINT, {
        method: "POST",
        mode: "cors",
        headers,
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (error) {
      if (!transportWarned) {
        transportWarned = true;
        console.warn("codex-runtime-debug transport failed", error);
      }
      return false;
    }
  }

  function accumulate(message, hypothesisId, durationMs = 0, data = {}, count = 1) {
    if (!runId || drainingRunId === runId) return;
    let key = `${hypothesisId}\u001f${message}`;
    if (!buckets.has(key) && buckets.size >= maxBuckets - 1) {
      hypothesisId = "TRANSPORT";
      message = "probe bucket overflow";
      key = `${hypothesisId}\u001f${message}`;
      durationMs = 0;
      data = {};
    }
    const value = buckets.get(key) ?? {
      hypothesisId,
      message,
      calls: 0,
      totalMs: 0,
      maxMs: 0,
      metrics: Object.create(null)
    };
    value.calls += count;
    value.totalMs += Number(durationMs) || 0;
    value.maxMs = Math.max(value.maxMs, Number(durationMs) || 0);
    for (const [name, raw] of Object.entries(data ?? {})) {
      const number = typeof raw === "boolean" ? Number(raw) : Number(raw);
      if (!Number.isFinite(number)) continue;
      const metric = value.metrics[name] ?? { total: 0, max: -Infinity, min: Infinity, last: 0 };
      metric.total += number * count;
      metric.max = Math.max(metric.max, number);
      metric.min = Math.min(metric.min, number);
      metric.last = number;
      value.metrics[name] = metric;
    }
    buckets.set(key, value);
  }

  function snapshotBatch() {
    if (!buckets.size) return null;
    const snapshot = [...buckets.values()];
    buckets.clear();
    return snapshot.map(value => {
      const data = { calls: value.calls, totalMs: value.totalMs, maxMs: value.maxMs };
      for (const [name, metric] of Object.entries(value.metrics)) {
        data[`${name}Total`] = metric.total;
        data[`${name}Max`] = metric.max;
        data[`${name}Min`] = metric.min;
        data[`${name}Last`] = metric.last;
      }
      return {
        runId,
        hypothesisId: value.hypothesisId,
        location: "src/canvas/smoke-runtime-debug.mjs",
        message: value.message,
        kind: "timing",
        data,
        timestamp: Date.now()
      };
    });
  }

  async function syncRun() {
    const response = await fetch(HEALTH_ENDPOINT, {
      mode: "cors",
      headers: { [HEADER_NAME]: HEADER_VALUE }
    });
    if (!response.ok) throw new Error(`health HTTP ${response.status}`);
    const health = await response.json();
    const nextRunId = health.activeRunId ?? null;
    if (nextRunId !== runId) {
      buckets.clear();
      pendingBatch = null;
      readyRunId = null;
      drainingRunId = null;
    }
    runId = nextRunId;
    if (!transportReady) {
      transportReady = await post({
        hypothesisId: "TRANSPORT",
        location: "src/canvas/smoke-runtime-debug.mjs",
        message: "actual Foundry origin reached full-path profiler",
        kind: "transport-ready",
        data: {},
        timestamp: Date.now()
      });
    }
    if (runId && readyRunId !== runId) {
      const ready = await post({
        runId,
        hypothesisId: "TRANSPORT",
        location: "src/canvas/smoke-runtime-debug.mjs",
        message: "full-path probes ready for run",
        kind: "transport-ready",
        data: {},
        timestamp: Date.now()
      });
      if (ready) readyRunId = runId;
    }
    return health;
  }

  function getGpuContext() {
    const gl = globalThis.canvas?.app?.renderer?.gl;
    if (!gl) return null;
    const extension = gl.getExtension?.("EXT_disjoint_timer_query_webgl2");
    if (!gpuCapabilityRecorded) {
      gpuCapabilityRecorded = true;
      accumulate("WebGL GPU timer capability", "H17", 0, {
        webgl2: Number(typeof gl.createQuery === "function"),
        timerQuery: Number(Boolean(extension))
      });
    }
    if (!extension || typeof gl.createQuery !== "function") return null;
    return { gl, extension };
  }

  function pollGpuQueries() {
    for (let index = pendingGpuQueries.length - 1; index >= 0; index -= 1) {
      const pending = pendingGpuQueries[index];
      const { gl, extension, query } = pending;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      pendingGpuQueries.splice(index, 1);
      const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT);
      const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT);
      gl.deleteQuery(query);
      if (disjoint || !Number.isFinite(nanoseconds)) continue;
      accumulate(`${pending.message} GPU`, pending.hypothesisId, nanoseconds / 1e6, pending.data);
    }
  }

  async function flushPending() {
    if (!pendingBatch) return true;
    if (!(await post(pendingBatch))) return false;
    pendingBatch = null;
    return true;
  }

  async function tick() {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      pollGpuQueries();
      const health = await syncRun();
      if (!runId) return;
      const drain = health.drainRequest;
      if (drain?.runId === runId) drainingRunId = runId;
      if (!(await flushPending())) return;
      pendingBatch = snapshotBatch();
      if (!(await flushPending())) return;
      if (drain?.runId === runId && !health.drainAcknowledged && !acknowledgedDrains.has(drain.requestId)) {
        const acknowledged = await post({
          runId,
          hypothesisId: null,
          location: "src/canvas/smoke-runtime-debug.mjs",
          message: "full-path probe batches flushed",
          kind: "drain-ack",
          data: { requestId: drain.requestId },
          timestamp: Date.now()
        });
        if (acknowledged) acknowledgedDrains.add(drain.requestId);
      }
    } catch (error) {
      if (!transportWarned) {
        transportWarned = true;
        console.warn("codex-runtime-debug health sync failed", error);
      }
    } finally {
      tickInFlight = false;
    }
  }

  function wrapMethod(target, methodName, {
    hypothesisId,
    message,
    capture = null,
    data = null,
    gpuSampleRate = 0
  }) {
    if (!target || typeof target[methodName] !== "function") return false;
    let targetWrappers = wrappers.get(target);
    if (!targetWrappers) wrappers.set(target, targetWrappers = new Set());
    const wrapperKey = `${methodName}:${hypothesisId}:${message}`;
    if (targetWrappers.has(wrapperKey)) return true;
    const original = target[methodName];
    let calls = 0;
    target[methodName] = function(...args) {
      const before = capture?.call(this, args) ?? {};
      const parent = profileStack.at(-1);
      const frame = { childMs: 0 };
      profileStack.push(frame);
      const startedAt = performance.now();
      const gpu = gpuSampleRate > 0 && (++calls % gpuSampleRate === 0) && !gpuQueryActive
        ? getGpuContext()
        : null;
      let query = null;
      if (gpu) {
        try {
          query = gpu.gl.createQuery();
          gpu.gl.beginQuery(gpu.extension.TIME_ELAPSED_EXT, query);
          gpuQueryActive = true;
        } catch {
          query = null;
        }
      }
      let result;
      let thrown;
      try {
        result = original.apply(this, args);
        return result;
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        if (query) {
          try {
            gpu.gl.endQuery(gpu.extension.TIME_ELAPSED_EXT);
            gpuQueryActive = false;
            pendingGpuQueries.push({
              ...gpu,
              query,
              hypothesisId,
              message,
              data: before
            });
          } catch {
            gpuQueryActive = false;
            gpu.gl.deleteQuery(query);
          }
        }
        const durationMs = performance.now() - startedAt;
        profileStack.pop();
        if (parent) parent.childMs += durationMs;
        const metrics = {
          ...before,
          ...(data?.call(this, { args, result, thrown, before, durationMs }) ?? {}),
          selfMs: Math.max(0, durationMs - frame.childMs),
          threw: Number(Boolean(thrown))
        };
        accumulate(message, hypothesisId, durationMs, metrics);
      }
    };
    targetWrappers.add(wrapperKey);
    return true;
  }

  const timer = setInterval(() => void tick(), 1000);
  void tick();
  return {
    record({ hypothesisId, message, durationMs = 0, data = {}, count = 1 }) {
      accumulate(message, hypothesisId, durationMs, data, count);
    },
    start: () => performance.now(),
    wrapMethod,
    stop() {
      clearInterval(timer);
    }
  };
}

const profiler = globalThis[GLOBAL_KEY] ??= (
  typeof globalThis.window !== "undefined" && typeof globalThis.fetch === "function"
    ? createRuntimeProfiler()
    : {
        record() {},
        start: () => performance.now(),
        wrapMethod: () => false,
        stop() {}
      }
);
export const smokeDebugRecord = profiler.record;
export const smokeDebugStart = profiler.start;
export const smokeDebugWrapMethod = profiler.wrapMethod;
