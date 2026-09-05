// #region codex-runtime-debug H1 H2 H3 H4 H5 H6a H6b H6c temporary actual-client probes
// Remove this entire file and its marked main.mjs import after verification.
const ENDPOINT = "http://127.0.0.1:63703/ingest/989007a1f1b94a64b113c3834fa65097";
const HEALTH = "http://127.0.0.1:63703/health/989007a1f1b94a64b113c3834fa65097";
const HEADERS = { "Content-Type": "application/json", "X-Codex-Debug-Session": "dbg-20260905T074135Z-ec182afe" };
const LOCATION = "src/debug/actual-gameplay.mjs";

Hooks.once("ready", () => {
  globalThis.__falloutMawGameplayProbe?.stop?.();
  const clientId = crypto.randomUUID();
  const client = {
    clientId, origin: location.origin, userId: game.user?.id,
    isGM: game.user?.isGM, isActiveGM: game.users?.activeGM === game.user,
    electron: navigator.userAgent.includes("Electron/"), generation: game.release?.generation, probeRevision: 19,
    systemCandidate: "replacement-equivalence,validated-item-snapshots,coordinate-history,preview-clean-source-ancestor-validation,single-delta-copy,identity-preserving-history-probe,server-snapshot-r2,prepared-formula-settings,reaction-source-filter,single-repair-copy,preview-snapshot-deferral,automatic-repair-placement-projection,actor-local-reaction-index,shared-inventory-settings,formula-group-plans,full-effect-tail-and-frame-probes,shared-immutable-event-completion,faction-cell-lookup,event-fail-open-reasons,event-fanout-counts"
  };
  let stopped = false, warned = false, busy = false, transportReady = false;
  let runId = null, readyRunId = null, drainingRunId = null, pending = null, traceRequestAt = 0;
  let buckets = new Map(), events = [], eventOverflow = 0, stack = [], eventSequence = 0;
  const openOperations = new Set();
  let lastFlush = performance.now(), lastFrame = null, frameHandle, observer, animationFrameObserver;
  let readyStartedAt = Infinity;
  let frames = freshFrames(), longTasks = { calls: 0, totalMs: 0, maxMs: 0 };
  const restorers = [], hookIds = [], acknowledgements = new Set(), installed = [], skipped = [];
  const active = () => !stopped && runId !== null && readyRunId === runId && drainingRunId !== runId;

  function warn(error) {
    if (warned || stopped) return;
    warned = true;
    console.warn("codex-runtime-debug transport failed", error);
  }
  async function post(payload) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST", mode: "cors", headers: HEADERS, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error(`ingest HTTP ${response.status}`);
      return true;
    } catch (error) { warn(error); return false; }
  }
  function envelope(message, hypothesisId, kind, data, id = runId) {
    return { id: `${clientId}:${++eventSequence}`, runId: id, hypothesisId, location: LOCATION, message, kind,
      data: { ...data, clientId }, timestamp: Date.now() };
  }
  function accumulate(label, hypothesisId, ms = 0, selfMs = 0, calls = 1, data = null, dimension = "") {
    let key = `${hypothesisId}|${label}|${dimension}`;
    if (!buckets.has(key) && buckets.size >= 600) {
      key = "overflow"; label = "probe.bucketOverflow"; hypothesisId = "TRANSPORT";
      data = null; ms = 0; selfMs = 0;
    }
    let value = buckets.get(key);
    if (!value) {
      value = { label, hypothesisId, calls: 0, totalMs: 0, maxMs: 0,
        exclusiveOfMeasuredChildrenMs: 0, data };
      buckets.set(key, value);
    }
    value.calls += calls;
    value.totalMs += ms;
    value.maxMs = Math.max(value.maxMs, ms);
    value.exclusiveOfMeasuredChildrenMs += selfMs;
  }
  function event(label, hypothesisId, data, kind = "event") {
    if (!active()) return;
    // A measured crowd-update burst produced 214 events between timer ticks.
    // Keep a bounded margin without adding network work to the synchronous path.
    if (events.length >= 512) { eventOverflow++; return; }
    events.push(envelope(label, hypothesisId, kind, data));
  }
  function span(label, hypothesisId, data = {}) {
    if (!active()) return undefined;
    const started = performance.now(), startedAt = Date.now(), id = runId;
    const operation = { label, runId: id };
    openOperations.add(operation);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      openOperations.delete(operation);
      if (!active() || id !== runId) return;
      const elapsed = performance.now() - started;
      accumulate(label, hypothesisId, elapsed, 0, 1, data, dimension(data));
      event(label, hypothesisId, { ...data, durationMs: elapsed, startedAt }, "span");
    };
  }
  function count(label, hypothesisId, n = 1) {
    if (active()) accumulate(label, hypothesisId, 0, 0, n);
  }
  const syncSamples = new Map();
  function sampledSync(label, hypothesisId, actor) {
    if (!active()) return undefined;
    const n = (syncSamples.get(label) ?? 0) + 1;
    syncSamples.set(label, n);
    count(`${label}.allCalls`, hypothesisId);
    if (n % 32 !== 1) return undefined;
    const data = { ...actorMeta(actor), samplingEvery: 32 }, started = performance.now();
    const frame = {childMs: 0};
    stack.push(frame);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const elapsed = performance.now() - started;
      stack.pop();
      if (stack.length) stack[stack.length - 1].childMs += elapsed;
      accumulate(label, hypothesisId, elapsed, Math.max(0, elapsed - frame.childMs), 1, data, dimension(data));
    };
  }
  // Inline entry point: a toObject prototype wrapper disables Scene's serializer
  // identity guard and changes the workload that the probe is meant to measure.
  function tokenSerialization(document, source) {
    if (!active()) return undefined;
    const data = { ...tokenMeta(document), source: source !== false, samplingEvery: 1 };
    const started = performance.now(), id = runId, frame = { childMs: 0 };
    stack.push(frame);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const elapsed = performance.now() - started;
      stack.pop();
      if (stack.length) stack[stack.length - 1].childMs += elapsed;
      if (active() && id === runId) accumulate("tokenDocument.toObject", "H7a", elapsed,
        Math.max(0, elapsed - frame.childMs), 1, data, `${dimension(data)}/${data.source}`);
    };
  }
  function actorMeta(doc) {
    const actor = doc.documentName === "ActorDelta" ? doc.syntheticActor : doc;
    const token = doc.documentName === "ActorDelta" ? doc.parent : actor?.token;
    return { actorId: actor?.id ?? token?.actorId ?? null, tokenId: token?.id ?? null,
      itemCount: actor?.items?.size ?? 0, effectCount: actor?.effects?.size ?? 0,
      baseItemCount: doc.documentName === "ActorDelta" ? doc.parent?.baseActor?.items?.size : undefined,
      synthetic: !!actor?.isToken };
  }
  function patchMeta(args, commit = false) {
    const changed = args[commit ? 1 : 0], options = args[2] ?? args[1] ?? {};
    return { changeRoots: changed && typeof changed === "object" ? Object.keys(changed).slice(0, 16) : [],
      systemRoots: changed?.system && typeof changed.system === "object" ? Object.keys(changed.system).slice(0, 16) : [],
      recursive: options.recursive, diff: options.diff, dryRun: options.dryRun };
  }
  function dimension(data) {
    return `${data?.actorId ?? ""}/${data?.tokenId ?? ""}/${data?.itemCount ?? ""}/${data?.documentType ?? ""}/${data?.applicationClass ?? ""}/${data?.query ?? ""}`;
  }
  function tokenMeta(doc) {
    // Reading the delta getter would create lazy actors and perturb movement.
    const delta = Object.getOwnPropertyDescriptor(doc, "delta")?.value;
    const actor = doc.actorLink ? game.actors.get(doc.actorId) : delta?.syntheticActor;
    return { tokenId: doc.id, actorId: doc.actorId, itemCount: actor?.items?.size ?? null,
      deltaItemCount: doc._source?.delta?.items?.length ?? 0,
      preview: !!doc._object?.isPreview };
  }
  function operationMeta(operation = {}) {
    const updates = operation.updates ?? operation.data ?? operation.ids;
    return { count: updates?.length ?? 0, isUndo: !!operation.isUndo,
      parentUuid: operation.parentUuid, hasMovement: !!operation.movement,
      documentIds: Array.isArray(updates) ? updates.slice(0, 16).map(value => typeof value === "string" ? value : value?._id) : [],
      changeRoots: updates?.[0] && typeof updates[0] === "object" ? Object.keys(updates[0]).slice(0, 12) : [] };
  }

  // Prototype wrappers preserve the original returned value/Promise and use only
  // the synchronous call stack for exclusive CPU. Async settlement is separate.
  function wrap(target, name, label, hypothesisId, metadata, { sample = 1, settle = false, filter, enter = false, settledMetadata } = {}) {
    if (!target || typeof target[name] !== "function") { skipped.push(label); return; }
    const own = Object.getOwnPropertyDescriptor(target, name), original = target[name];
    let sequence = 0;
    function wrapped(...args) {
      if (!active() || (filter && !filter.call(this, args))) return original.apply(this, args);
      if (sample > 1) {
        count(`${label}.allCalls`, hypothesisId);
        if (++sequence % sample !== 1) return original.apply(this, args);
      }
      let data;
      try { data = metadata?.call(this, args) ?? {}; } catch { data = {}; }
      const key = dimension(data), id = runId, started = performance.now(), startedAt = Date.now();
      if (enter) {
        data = { ...data, operationId: `${clientId}:${++eventSequence}` };
        event(`${label}.entered`, hypothesisId, { ...data, startedAt });
      }
      const frame = { childMs: 0 };
      stack.push(frame);
      let result;
      try { result = original.apply(this, args); }
      finally {
        const elapsed = performance.now() - started;
        stack.pop();
        if (stack.length) stack[stack.length - 1].childMs += elapsed;
        if (active() && id === runId) {
          accumulate(label, hypothesisId, elapsed, Math.max(0, elapsed - frame.childMs), 1,
            { ...data, samplingEvery: sample }, key);
          if (elapsed >= 50) event(`${label}.slow`, hypothesisId, { ...data, durationMs: elapsed, startedAt });
        }
      }
      if (settle && result instanceof Promise) {
        const operation = { label, runId: id };
        openOperations.add(operation);
        const finish = (rejected, value) => {
          openOperations.delete(operation);
          if (!active() || id !== runId) return;
          const durationMs = performance.now() - started;
          let extra = {};
          if (!rejected && settledMetadata) {
            try { extra = settledMetadata(value); } catch { /* Diagnostic metadata must not affect settlement. */ }
          }
          accumulate(`${label}.settled`, hypothesisId, durationMs, 0, 1, data, key);
          if (durationMs >= 50 || !label.startsWith("application.") && !label.startsWith("token.")) {
            event(`${label}.settled`, hypothesisId, { ...data, ...extra, durationMs, startedAt, rejected }, "span");
          }
        };
        void result.then(value => finish(false, value), () => finish(true));
      }
      return result;
    }
    Object.defineProperty(target, name, { configurable: true, writable: true, value: wrapped });
    restorers.push(() => {
      if (target[name] !== wrapped) return;
      if (own) Object.defineProperty(target, name, own);
      else delete target[name];
    });
    installed.push(label);
  }
  const actorPrototype = CONFIG.Actor.documentClass.prototype;
  for (const name of ["reset", "prepareData", "_updateCommit", "updateSource"]) {
    wrap(actorPrototype, name, `actor.${name}`, "H1", function (args) {
      return { ...actorMeta(this), ...(name === "updateSource" || name === "_updateCommit" ? patchMeta(args, name === "_updateCommit") : {}) };
    });
  }
  for (const name of ["updateSource", "updateSyntheticActor", "toObject"]) {
    wrap(CONFIG.ActorDelta?.documentClass?.prototype, name, `delta.${name}`, "H1", function (args) {
      return { ...actorMeta(this), ...(name === "updateSource" ? patchMeta(args) : {}) };
    });
  }
  // The same probes and Item sampling rate apply to every Actor. Inventory size
  // is recorded as a measurement dimension and never selects an execution path.
  for (const name of ["_initialize", "prepareEmbeddedDocuments", "prepareDerivedData", "applyActiveEffects"]) {
    wrap(actorPrototype, name, `actor.${name}`, name === "_initialize" ? "H6b" : "H6c", function (args) {
      return { ...actorMeta(this), phase: typeof args[0] === "string" ? args[0] : undefined };
    });
  }
  for (const [type, Model] of Object.entries(CONFIG.Actor.dataModels ?? {})) {
    for (const name of ["prepareBaseData", "prepareDerivedData"]) {
      wrap(Model.prototype, name, `actorSystem.${type}.${name}`, "H6c", function () {
        return actorMeta(this.parent);
      });
    }
  }
  wrap(foundry.abstract?.EmbeddedCollection?.prototype, "initialize", "actor.items.initialize", "H6b",
    function (args) { return { ...actorMeta(this.model), sourceItemCount: this._source.length, full: !!args[0]?.full }; },
    { filter: function () { return this.name === "items" && this.model?.documentName === "Actor"; } });
  wrap(CONFIG.Item.documentClass.prototype, "_initialize", "actor.itemInitializeSample", "H6b",
    function () { return actorMeta(this.parent); },
    { sample: 32, filter: function () { return this.parent?.documentName === "Actor"; } });
  for (const [type, Model] of Object.entries(CONFIG.Item.dataModels ?? {})) {
    wrap(Model.prototype, "reset", `itemSystem.${type}.resetSample`, "H6b", function () {
      return actorMeta(this.parent.parent);
    }, { sample: 32, filter: function () { return this.parent?.parent?.documentName === "Actor"; } });
  }
  wrap(CONFIG.ActorDelta?.documentClass?.prototype, "_createSyntheticActor", "delta.createActor", "H6a",
    function () { return tokenMeta(this.parent); });
  for (const name of ["_initializeDragLeft", "clone", "_onDragStart", "draw"]) {
    wrap(CONFIG.Token.objectClass.prototype, name, `drag.${name}`, "H6a",
      function () { return { ...tokenMeta(this.document), controlledCount: this.layer?.controlled?.length }; },
      { enter: name === "_initializeDragLeft", settle: name === "draw",
        filter: function () { return name !== "draw" || this.isPreview; } });
  }
  installed.push("tokenDocument.toObject.inline");
  for (const name of ["clone", "_initializeSource", "prepareData"]) {
    wrap(CONFIG.Token.documentClass.prototype, name, `tokenDocument.${name}`, "H6a", function (args) {
      if (name === "_initializeSource") {
        const source = args[0] ?? {};
        return { tokenId: source._id, actorId: source.actorId, deltaItemCount: source.delta?.items?.length ?? 0 };
      }
      return tokenMeta(this);
    });
  }
  for (const name of ["_createDocuments", "_updateDocuments", "_deleteDocuments"]) {
    wrap(CONFIG.DatabaseBackend, name, `backend.${name}`, "H5", function (args) {
      const operation = args[1] ?? {}, parent = operation.parent;
      return { documentType: args[0]?.documentName, ...operationMeta(operation),
        parentType: parent?.documentName, parentId: parent?.id, render: operation.render,
        ...(parent?.documentName === "Actor" || parent?.documentName === "ActorDelta" ? actorMeta(parent) : {}) };
    }, { settle: true });
  }
  wrap(CONFIG.User.documentClass.prototype, "query", "user.query", "H5",
    function (args) { return { query: String(args[0]), recipientId: this.id }; }, { settle: true });
  wrap(foundry.helpers?.SocketInterface, "dispatch", "socket.modifyDocument", "H5", function (args) {
    const request = args[1] ?? {};
    return { documentType: request.type, action: request.action, ...operationMeta(request.operation) };
  }, { filter: args => args[0] === "modifyDocument", settle: true, enter: true,
    settledMetadata: response => {
      const results = response?.results ?? [response];
      const timestamps = results.slice(0, 20).map(result => result?.timestamp).filter(Number.isFinite);
      return { serverResponseTimestamps: timestamps, receivedAt: Date.now() };
    } });
  wrap(CONFIG.Token.objectClass.prototype, "_onDragLeftDrop", "movement.drop", "H5",
    function () { return tokenMeta(this.document); }, { enter: true });
  wrap(CONFIG.Scene?.documentClass?.prototype, "updateEmbeddedDocuments", "movement.updateRequest", "H5",
    function (args) {
      return { ...operationMeta({ ...args[2], updates: args[1] }), sceneId: this.id,
        tokens: args[1]?.slice(0, 16).map(update => this.tokens.get(update._id)).filter(Boolean).map(tokenMeta) };
    }, { filter: args => args[0] === "Token", enter: true, settle: true });
  wrap(CONFIG.Scene?.documentClass?.prototype, "moveTokens", "movement.moveTokens", "H5",
    function (args) { return { sceneId: this.id, tokenIds: Object.keys(args[0] ?? {}).slice(0, 16) }; },
    { enter: true, settle: true });
  wrap(CONFIG.Token.documentClass.prototype, "_onUpdate", "movement.documentApplied", "H5",
    function (args) { return { ...tokenMeta(this), ...patchMeta(args), isUndo: !!args[1]?.isUndo }; }, { enter: true });
  wrap(CONFIG.Token.objectClass.prototype, "animate", "movement.animation", "H4",
    function (args) { return { ...tokenMeta(this.document), changeRoots: Object.keys(args[0] ?? {}).slice(0, 12),
      requestedDurationMs: args[1]?.duration, chain: args[1]?.chain }; },
    { filter: args => ["x", "y", "elevation", "rotation"].some(key => key in (args[0] ?? {})), enter: true, settle: true });
  for (const name of ["updateToken"]) {
    const hookId = Hooks.on(name, (doc, changed, options) => {
      if (!active()) return;
      const parent = doc.parent;
      event(`document.${name}`, "H1", { documentId: doc.id, documentType: doc.documentName,
        parentId: parent?.id, parentType: parent?.documentName,
        changeRoots: changed && typeof changed === "object" ? Object.keys(changed).slice(0, 12) : [],
        isUndo: name.startsWith("update") ? !!options?.isUndo : undefined,
        ...(doc.documentName === "Actor" ? actorMeta(doc) : parent?.documentName === "Actor" ? actorMeta(parent) : {}) });
    });
    hookIds.push([name, hookId]);
  }

  function freshFrames() {
    return { calls: 0, totalMs: 0, maxMs: 0, over33: 0, over50: 0, over100: 0, over500: 0, over1000: 0, hiddenFrames: 0 };
  }
  function visibilityChanged() {
    lastFrame = null;
    event("runtime.visibility", "H4", { hidden: document.hidden, focused: document.hasFocus() });
  }
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("focus", visibilityChanged);
  window.addEventListener("blur", visibilityChanged);
  // codex-runtime-debug H15 measure native input/paint boundaries without reading coordinates or typed text.
  function inputObserved(input) {
    if (!active() || input.type === "keydown" && input.repeat) return;
    const tag = input.target?.tagName;
    if (tag !== "CANVAS" && !(input.type === "keydown" && tag === "BODY")) return;
    const observedAt = performance.now();
    const timestamp = Number(input.timeStamp);
    const queuedMs = timestamp > 0 && timestamp <= observedAt ? observedAt - timestamp : null;
    event("input.observed", "H15", { kind: input.type, queuedMs, startedAt: Date.now(), hidden: document.hidden });
  }
  window.addEventListener("pointerdown", inputObserved, { capture: true, passive: true });
  window.addEventListener("keydown", inputObserved, { capture: true, passive: true });
  function frame(now) {
    if (stopped) return;
    if (active() && lastFrame !== null) {
      const elapsed = now - lastFrame;
      frames.calls++; frames.totalMs += elapsed; frames.maxMs = Math.max(frames.maxMs, elapsed);
      for (const threshold of [33, 50, 100, 500, 1000]) if (elapsed > threshold) frames[`over${threshold}`]++;
      if (document.hidden) frames.hiddenFrames++;
    }
    lastFrame = now;
    frameHandle = requestAnimationFrame(frame);
  }
  try {
    observer = new PerformanceObserver(list => {
      if (!active()) return;
      for (const task of list.getEntries()) {
        longTasks.calls++; longTasks.totalMs += task.duration; longTasks.maxMs = Math.max(longTasks.maxMs, task.duration);
      }
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch { skipped.push("PerformanceObserver.longtask"); }
  // #region codex-runtime-debug H15 long frames include script, microtask and layout cost across multiple short tasks.
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) throw new Error("unsupported");
    animationFrameObserver = new PerformanceObserver(list => {
      if (!active()) return;
      for (const entry of list.getEntries()) {
        if (entry.startTime < readyStartedAt) continue;
        const scripts = Array.from(entry.scripts ?? []).sort((a, b) => b.duration - a.duration).slice(0, 6).map(script => {
          let source = "";
          try { source = new URL(script.sourceURL, location.origin).pathname; } catch { /* No URL is also useful. */ }
          return { source, functionName: String(script.sourceFunctionName ?? "").slice(0, 140),
            durationMs: script.duration, forcedLayoutMs: script.forcedStyleAndLayoutDuration,
            pauseMs: script.pauseDuration, invokerType: script.invokerType };
        });
        event("runtime.longAnimationFrame", "H15", {
          startedAt: performance.timeOrigin + entry.startTime, durationMs: entry.duration,
          blockingMs: entry.blockingDuration,
          renderMs: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0,
          layoutMs: entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0,
          firstInputAt: entry.firstUIEventTimestamp ? performance.timeOrigin + entry.firstUIEventTimestamp : null,
          hidden: document.hidden, focused: document.hasFocus(), scripts
        });
      }
    });
    animationFrameObserver.observe({ type: "long-animation-frame", buffered: false });
    installed.push("PerformanceObserver.long-animation-frame");
  } catch { skipped.push("PerformanceObserver.long-animation-frame"); }
  // #endregion codex-runtime-debug

  function sceneSnapshot() {
    // Once per run, before reproduction; never serialize Documents or inventories.
    return { ...client, sceneId: canvas.scene?.id, sceneClass: canvas.scene?.constructor?.name,
      tokenCount: canvas.tokens?.placeables?.length,
      activeUserCount: game.users?.filter(user => user.active).length,
      selected: canvas.tokens?.controlled?.map(token => token.id),
      targets: Array.from(game.user?.targets ?? [], token => token.id),
      zoom: canvas.stage?.scale?.x, hidden: document.hidden,
      viewport: { width: innerWidth, height: innerHeight },
      tokens: (canvas.tokens?.placeables ?? []).slice(0, 80).map(token => {
        const doc = token.document;
        const delta = Object.getOwnPropertyDescriptor(doc, "delta")?.value;
        const actor = doc.actorLink ? game.actors.get(doc.actorId) : delta?.syntheticActor;
        return { tokenId: token.id, actorId: doc.actorId, linked: doc.actorLink,
          lazyDelta: !doc.actorLink && !delta, itemCount: actor?.items?.size ?? null,
          effectCount: actor?.effects?.size ?? null };
      }),
      installed, skipped };
  }
  async function readTraceState() {
    const response = await fetch(new URL(`./electron-trace-state.json?t=${Date.now()}`, import.meta.url), { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return response.ok ? response.json() : null;
  }
  async function syncRun() {
    const response = await fetch(HEALTH, { mode: "cors", headers: { "X-Codex-Debug-Session": HEADERS["X-Codex-Debug-Session"] },
      signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`health HTTP ${response.status}`);
    const health = await response.json(), next = health.activeRunId ?? null;
    if (next !== runId) {
      buckets.clear(); events = []; pending = null; eventOverflow = 0;
      frames = freshFrames(); longTasks = { calls: 0, totalMs: 0, maxMs: 0 };
      lastFrame = null; lastFlush = performance.now(); readyRunId = null; drainingRunId = null;
      readyStartedAt = Infinity;
      openOperations.clear();
      runId = next;
      traceRequestAt = 0;
    }
    if (!transportReady) transportReady = await post(envelope("actual application origin reached collector", "TRANSPORT", "transport-ready", client, null));
    if (runId && readyRunId !== runId) {
      if (runId.includes("renderer-profile")) {
        const trace = await readTraceState();
        if (!trace || trace.sessionId !== HEADERS["X-Codex-Debug-Session"] || trace.runId !== runId) return health;
        if (trace.state === "awaiting-client" && Date.now() - traceRequestAt > 3000 && client.electron && client.isActiveGM && canvas.scene?.id) {
          if (await post(envelope("loaded game client requests CPU recording", "TRANSPORT", "renderer-profile-request",
            { ...client, instanceId: trace.instanceId, sceneId: canvas.scene.id }))) traceRequestAt = Date.now();
        }
        if (trace.state !== "recording" || trace.clientId !== clientId || Date.now() - trace.startedAt >= (trace.limitMs ?? 180000)) return health;
      }
      if (await post(envelope("run-aware probes ready", "TRANSPORT", "transport-ready", sceneSnapshot()))) {
        readyRunId = runId;
        readyStartedAt = performance.now();
        if (runId.includes("renderer-profile")) performance.mark(`codex-runtime-debug:${runId}:${clientId}:wall=${Date.now()}`);
        // User requested one reload/reproduction step: announce only after the
        // actual application has delivered this run's readiness to the collector.
        globalThis.ui?.notifications?.info?.("Запись производительности включена — можно проверять.");
      }
    }
    return health;
  }
  function snapshotBatch() {
    const now = performance.now(), intervalMs = now - lastFlush;
    lastFlush = now;
    const batch = [...buckets.values()].map(value => envelope(value.label, value.hypothesisId, "timing", {
      ...value.data, calls: value.calls, totalMs: value.totalMs, maxMs: value.maxMs,
      exclusiveOfMeasuredChildrenMs: value.exclusiveOfMeasuredChildrenMs, intervalMs
    }));
    buckets = new Map();
    batch.push(...events); events = [];
    batch.push(envelope("runtime.frames", "H4", "timing", { ...frames, intervalMs, hidden: document.hidden, focused: document.hasFocus() }));
    batch.push(envelope("runtime.longTasks", "H4", "timing", { ...longTasks, intervalMs }));
    if (eventOverflow) batch.push(envelope("probe.eventOverflow", "TRANSPORT", "event", { count: eventOverflow }));
    frames = freshFrames(); longTasks = { calls: 0, totalMs: 0, maxMs: 0 }; eventOverflow = 0;
    return batch;
  }
  async function flushPending() {
    if (!pending) return true;
    while (pending.length) {
      if (!await post(pending.slice(0, 120))) return false;
      pending.splice(0, 120);
    }
    pending = null; return true;
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const health = await syncRun();
      if (!runId || readyRunId !== runId) return;
      const drain = health.drainRequest;
      if (drain?.runId === runId && !openOperations.size) drainingRunId = runId;
      if (!await flushPending()) return;
      pending = snapshotBatch();
      if (!await flushPending()) return;
      if (drainingRunId === runId && drain?.runId === runId && !acknowledgements.has(drain.requestId)) {
        if (runId.includes("renderer-profile")) {
          const trace = await readTraceState();
          if (trace?.state !== "flushed" || trace.runId !== runId || trace.clientId !== clientId || trace.sessionId !== HEADERS["X-Codex-Debug-Session"]) return;
        }
        if (await post(envelope("run batches flushed", null, "drain-ack", { requestId: drain.requestId, openOperations: openOperations.size }))) acknowledgements.add(drain.requestId);
      }
    } catch (error) { warn(error); }
    finally { busy = false; }
  }
  const timer = setInterval(() => void tick(), 1000);
  globalThis.__falloutMawGameplayProbe = {
    activeRunId: () => active() ? runId : null,
    span, count, event, sampledSync, tokenSerialization,
    stop() {
      stopped = true; clearInterval(timer); cancelAnimationFrame(frameHandle); observer?.disconnect();
      animationFrameObserver?.disconnect();
      window.removeEventListener("pointerdown", inputObserved, true);
      window.removeEventListener("keydown", inputObserved, true);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("focus", visibilityChanged);
      window.removeEventListener("blur", visibilityChanged);
      for (const [name, hookId] of hookIds) Hooks.off(name, hookId);
      for (const restore of restorers.reverse()) restore();
      delete globalThis.__falloutMawGameplayProbe;
    }
  };
  frameHandle = requestAnimationFrame(frame);
  void tick();
});
// #endregion codex-runtime-debug
