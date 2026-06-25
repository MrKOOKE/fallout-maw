const DEBUG_ENDPOINT = "http://127.0.0.1:7815/ingest/477c0bca-778e-4b72-9d68-e7f8bcefd8f5";
const DEBUG_SESSION = "f19a72";
const DEBUG_RUN = "post-bulk-1";
const CASCADE_TAIL_MS = 600;

/** @type {null | {
 *   id: string;
 *   kind: string;
 *   t0: number;
 *   meta: Record<string, unknown>;
 *   docs: Record<string, number>;
 *   subsystems: Record<string, number>;
 *   actorTimings: Map<string, { ms: number; updates: number; timings: Record<string, number>; subsystems: Record<string, number> }>;
 * }>} */
let activeCycle = null;

/** @type {null | {
 *   id: string;
 *   actorUuid: string;
 *   t0: number;
 *   docs: Record<string, number>;
 *   subsystems: Record<string, number>;
 *   timings: Record<string, number>;
 *   metrics: Record<string, number>;
 *   meta: Record<string, unknown>;
 * }} */
let activeActorOp = null;

/** @type {null | {
 *   cycleId: string;
 *   t0: number;
 *   docs: Record<string, number>;
 *   subsystems: Record<string, number>;
 * }} */
let cascadeTail = null;

let documentPatchesInstalled = false;
let subsystemHooksInstalled = false;
let cascadeTailTimer = null;

const DOC_TYPES = ["Actor", "ActiveEffect", "Item", "Token", "Scene", "Combat", "Combatant", "other"];

function emptyDocCounts() {
  return Object.fromEntries(DOC_TYPES.map(type => [type, 0]));
}

function emptyDetails() {
  return {};
}

function emptySubsystemCounts() {
  return {
    abilityEffectSync: 0,
    auraStateSync: 0,
    damageStatusSync: 0,
    stealthActorRefresh: 0,
    stealthVisibilityRefresh: 0,
    tokenActionHudRefresh: 0,
    needThresholdProcess: 0,
    naturalRaceItemSync: 0,
    reactionResourceSync: 0,
    actorContainerRefresh: 0,
    trapRefresh: 0,
    updateActorHookTotal: 0,
    updateTokenHookTotal: 0,
    updateActiveEffectHookTotal: 0,
    prepareDerivedData: 0
  };
}

function postDebugLog(location, message, data = {}, hypothesisId = "") {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": DEBUG_SESSION },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION,
      runId: DEBUG_RUN,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
}

function currentDocBucket() {
  if (activeActorOp) return activeActorOp.docs;
  if (activeCycle) return activeCycle.docs;
  if (cascadeTail) return cascadeTail.docs;
  return null;
}

function currentDocDetailsBucket() {
  if (activeActorOp) return activeActorOp.docDetails;
  if (activeCycle) return activeCycle.docDetails;
  if (cascadeTail) return cascadeTail.docDetails;
  return null;
}

function currentSubsystemBucket() {
  if (activeActorOp) return activeActorOp.subsystems;
  if (activeCycle) return activeCycle.subsystems;
  if (cascadeTail) return cascadeTail.subsystems;
  return null;
}

function currentTimingBucket() {
  if (activeActorOp) return activeActorOp.timings;
  return null;
}

function currentMetricBucket() {
  if (activeActorOp) return activeActorOp.metrics;
  return null;
}

export function isActorDamageOpActive() {
  return Boolean(activeActorOp);
}

export function recordDocumentUpdate(documentName = "other", source = "unknown", detail = {}) {
  const bucket = currentDocBucket();
  const type = DOC_TYPES.includes(documentName) ? documentName : "other";
  if (bucket) bucket[type] = (bucket[type] ?? 0) + 1;
  const details = currentDocDetailsBucket();
  if (!details) return;
  const key = buildDocumentDetailKey(type, source, detail);
  details[key] = (details[key] ?? 0) + 1;
}

function buildDocumentDetailKey(type, source, detail = {}) {
  const parent = detail.parentDocumentName ? ` parent=${detail.parentDocumentName}` : "";
  const count = Number(detail.count) > 1 ? ` count=${detail.count}` : "";
  const options = detail.options ? ` options=${detail.options}` : "";
  const paths = detail.paths ? ` paths=${detail.paths}` : "";
  const values = detail.values ? ` values=${detail.values}` : "";
  return `${source} ${type}${parent}${count}${options}${paths}${values}`;
}

function summarizeUpdatePaths(update) {
  const flattened = foundry.utils.flattenObject(update ?? {});
  const allPaths = Object.keys(flattened).filter(path => path !== "_id");
  const paths = allPaths.slice(0, 8);
  const suffix = allPaths.length > paths.length ? ",..." : "";
  return paths.length ? `${paths.join(",")}${suffix}` : "";
}

function summarizeOperationOptions(operation = {}) {
  return Object.keys(operation ?? {})
    .filter(key => !["parent", "pack"].includes(key))
    .sort()
    .slice(0, 8)
    .join(",");
}

function summarizeSpecialUpdateValues(update = {}) {
  const values = [];
  const flattened = foundry.utils.flattenObject(update ?? {});
  const postureValue = flattened["flags.fallout-maw.postureKnockdown"] ?? foundry.utils.getProperty(update, "flags.fallout-maw.postureKnockdown");
  const postureState = flattened["flags.fallout-maw.postureKnockdown.state"]
    ?? foundry.utils.getProperty(update, "flags.fallout-maw.postureKnockdown.state")
    ?? (postureValue && typeof postureValue === "object" ? postureValue.state : postureValue);
  if (postureState) values.push(`postureKnockdown.state:${postureState}`);
  const coreStatus = foundry.utils.getProperty(update, "statuses");
  if (coreStatus) values.push(`statuses:${String(coreStatus)}`);
  return values.join(",");
}

function isDamageSummaryMessageData(data = {}) {
  if (!data || typeof data !== "object") return false;
  if (foundry.utils.getProperty(data, "flags.fallout-maw.damageSummary")) return true;
  return String(data.content ?? "").includes("fallout-maw-damage-summary-card");
}

function summarizeEmbeddedUpdatePaths(updates = []) {
  const first = Array.isArray(updates) ? updates.find(Boolean) : null;
  return summarizeUpdatePaths(first);
}

export function recordSubsystemWork(name, _detail = {}) {
  const bucket = currentSubsystemBucket();
  if (bucket && name in bucket) bucket[name] += 1;
}

export function recordPerfTiming(name = "", ms = 0) {
  const bucket = currentTimingBucket();
  const key = String(name ?? "").trim();
  if (!bucket || !key) return;
  bucket[key] = Math.round((bucket[key] ?? 0) + Math.max(0, Number(ms) || 0));
}

export function recordPerfMetric(name = "", value = 0) {
  const bucket = currentMetricBucket();
  const key = String(name ?? "").trim();
  if (!bucket || !key) return;
  bucket[key] = Math.round(Number(value) || 0);
}

export function recordPerfEvent(location = "", message = "", data = {}, hypothesisId = "H-status-order") {
  postDebugLog(location, message, data, hypothesisId);
}

export async function measurePerfTiming(name = "", operation) {
  if (typeof operation !== "function") return undefined;
  const started = performance.now();
  try {
    return await operation();
  } finally {
    recordPerfTiming(name, performance.now() - started);
  }
}

function subsystemHypothesis(name) {
  if (name === "damageStatusSync") return "H-B";
  if (name === "abilityEffectSync" || name === "auraStateSync") return "H-C";
  if (name.startsWith("stealth") || name === "tokenActionHudRefresh") return "H-E";
  if (name.endsWith("HookTotal") || name === "prepareDerivedData") return "H-E";
  return "H-D";
}

export function beginDamageCycle(kind = "damageCycle", meta = {}) {
  if (cascadeTailTimer) {
    globalThis.clearTimeout(cascadeTailTimer);
    cascadeTailTimer = null;
  }
  cascadeTail = null;

  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  activeCycle = {
    id,
    kind,
    t0: performance.now(),
    meta,
    docs: emptyDocCounts(),
    docDetails: emptyDetails(),
    subsystems: emptySubsystemCounts(),
    actorTimings: new Map()
  };
  postDebugLog("perf-log.mjs:beginDamageCycle", "damage cycle begin", { id, kind, ...meta }, "H-A");
  return id;
}

function beginCascadeTail(cycleId) {
  cascadeTail = {
    cycleId,
    t0: performance.now(),
    docs: emptyDocCounts(),
    docDetails: emptyDetails(),
    subsystems: emptySubsystemCounts()
  };
}

function endCascadeTail() {
  if (!cascadeTail) return;
  const tail = cascadeTail;
  cascadeTail = null;
  cascadeTailTimer = null;
  const ms = Math.round(performance.now() - tail.t0);
  postDebugLog("perf-log.mjs:endCascadeTail", "damage cycle cascade tail", {
    cycleId: tail.cycleId,
    ms,
    docs: tail.docs,
    docDetails: tail.docDetails,
    subsystems: tail.subsystems
  }, "H-C");
}

export function endDamageCycle(extra = {}) {
  if (!activeCycle) return;
  const cycle = activeCycle;
  activeCycle = null;
  const ms = Math.round(performance.now() - cycle.t0);
  const actorTimings = Object.fromEntries(cycle.actorTimings);
  postDebugLog("perf-log.mjs:endDamageCycle", "damage cycle end", {
    id: cycle.id,
    kind: cycle.kind,
    ms,
    docs: cycle.docs,
    docDetails: cycle.docDetails,
    subsystems: cycle.subsystems,
    actorTimings,
    ...extra
  }, "H-A");

  beginCascadeTail(cycle.id);
  cascadeTailTimer = globalThis.setTimeout(endCascadeTail, CASCADE_TAIL_MS);
}

export function beginActorDamageOp(actorUuid = "", meta = {}) {
  if (activeActorOp) return activeActorOp.id;
  const id = `actor-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  activeActorOp = {
    id,
    actorUuid,
    t0: performance.now(),
    docs: emptyDocCounts(),
    docDetails: emptyDetails(),
    subsystems: emptySubsystemCounts(),
    timings: {},
    metrics: {},
    meta
  };
  return id;
}

export function endActorDamageOp(actorUuid = "", extra = {}) {
  if (!activeActorOp) return;
  const op = activeActorOp;
  activeActorOp = null;
  const ms = Math.round(performance.now() - op.t0);
  if (activeCycle && actorUuid) {
    activeCycle.actorTimings.set(actorUuid, {
      ms,
      updates: op.docs.Actor ?? 0,
      docs: { ...op.docs },
      docDetails: { ...op.docDetails },
      timings: { ...op.timings },
      metrics: { ...op.metrics },
      subsystems: { ...op.subsystems }
    });
  }
  if (ms >= 8 || (op.docs.Actor ?? 0) > 1) {
    postDebugLog("perf-log.mjs:endActorDamageOp", "actor damage op end", {
      id: op.id,
      actorUuid,
      ms,
      docs: op.docs,
      docDetails: op.docDetails,
      timings: op.timings,
      metrics: op.metrics,
      subsystems: op.subsystems,
      ...extra
    }, "H-B");
  }
}

export function installDocumentUpdatePatches() {
  if (documentPatchesInstalled || !foundry?.abstract?.Document?.prototype) return;
  documentPatchesInstalled = true;

  const proto = foundry.abstract.Document.prototype;
  const originalUpdate = proto.update;
  proto.update = async function patchedDocumentUpdate(changes, ...rest) {
    const started = performance.now();
    if (this.documentName === "ChatMessage" && isDamageSummaryMessageData(changes)) {
      recordPerfEvent("perf-log.mjs:Document.update", "damage summary chat update", {
        messageId: this.id,
        paths: summarizeUpdatePaths(changes),
        options: summarizeOperationOptions(rest[0] ?? {}),
        contentLength: String(foundry.utils.getProperty(changes, "content") ?? "").length
      }, "H-card-chat-message");
    }
    recordDocumentUpdate(this.documentName, "Document.update", {
      parentDocumentName: this.parent?.documentName ?? "",
      options: summarizeOperationOptions(rest[0] ?? {}),
      paths: summarizeUpdatePaths(changes),
      values: summarizeSpecialUpdateValues(changes)
    });
    try {
      return await originalUpdate.call(this, changes, ...rest);
    } finally {
      recordPerfTiming(`doc:${this.documentName}.update`, performance.now() - started);
    }
  };

  const originalEmbedded = proto.updateEmbeddedDocuments;
  proto.updateEmbeddedDocuments = async function patchedEmbeddedUpdate(type, updates, ...rest) {
    const started = performance.now();
    recordDocumentUpdate(type, "Document.updateEmbeddedDocuments", {
      parentDocumentName: this.documentName ?? "",
      count: Array.isArray(updates) ? updates.length : 1,
      options: summarizeOperationOptions(rest[0] ?? {}),
      paths: summarizeEmbeddedUpdatePaths(updates)
    });
    try {
      return await originalEmbedded.call(this, type, updates, ...rest);
    } finally {
      recordPerfTiming(`doc:${type}.updateEmbedded`, performance.now() - started);
    }
  };

  const originalCreateEmbedded = proto.createEmbeddedDocuments;
  proto.createEmbeddedDocuments = async function patchedEmbeddedCreate(type, docs, ...rest) {
    const started = performance.now();
    recordDocumentUpdate(type, "Document.createEmbeddedDocuments", {
      parentDocumentName: this.documentName ?? "",
      count: Array.isArray(docs) ? docs.length : 1,
      options: summarizeOperationOptions(rest[0] ?? {})
    });
    try {
      return await originalCreateEmbedded.call(this, type, docs, ...rest);
    } finally {
      recordPerfTiming(`doc:${type}.createEmbedded`, performance.now() - started);
    }
  };

  const originalDeleteEmbedded = proto.deleteEmbeddedDocuments;
  proto.deleteEmbeddedDocuments = async function patchedEmbeddedDelete(type, ids, ...rest) {
    const started = performance.now();
    recordDocumentUpdate(type, "Document.deleteEmbeddedDocuments", {
      parentDocumentName: this.documentName ?? "",
      count: Array.isArray(ids) ? ids.length : 1,
      options: summarizeOperationOptions(rest[0] ?? {})
    });
    try {
      return await originalDeleteEmbedded.call(this, type, ids, ...rest);
    } finally {
      recordPerfTiming(`doc:${type}.deleteEmbedded`, performance.now() - started);
    }
  };

  if (foundry.documents?.Actor?.prototype?.prepareDerivedData) {
    const actorProto = foundry.documents.Actor.prototype;
    const originalPrepare = actorProto.prepareDerivedData;
    actorProto.prepareDerivedData = function patchedPrepareDerivedData() {
      const started = performance.now();
      recordSubsystemWork("prepareDerivedData");
      try {
        return originalPrepare.call(this);
      } finally {
        recordPerfTiming("prepareDerivedData", performance.now() - started);
      }
    };
  }

  if (foundry.documents?.ActorDelta?.prototype?.updateSource) {
    const deltaProto = foundry.documents.ActorDelta.prototype;
    const originalDeltaUpdateSource = deltaProto.updateSource;
    deltaProto.updateSource = function patchedActorDeltaUpdateSource(...args) {
      const started = performance.now();
      try {
        return originalDeltaUpdateSource.apply(this, args);
      } finally {
        recordPerfTiming("foundry:ActorDelta.updateSource", performance.now() - started);
      }
    };
  }

  if (foundry.documents?.ActorDelta?.prototype?.updateSyntheticActor) {
    const deltaProto = foundry.documents.ActorDelta.prototype;
    const originalUpdateSyntheticActor = deltaProto.updateSyntheticActor;
    deltaProto.updateSyntheticActor = function patchedActorDeltaUpdateSyntheticActor(...args) {
      const started = performance.now();
      try {
        return originalUpdateSyntheticActor.apply(this, args);
      } finally {
        recordPerfTiming("foundry:ActorDelta.updateSyntheticActor", performance.now() - started);
      }
    };
  }

  const ChatMessageClass = globalThis.ChatMessage ?? foundry.documents?.ChatMessage;
  if (ChatMessageClass?.create && !ChatMessageClass.create.__falloutMawPerfPatched) {
    const originalChatMessageCreate = ChatMessageClass.create;
    const patchedChatMessageCreate = async function patchedChatMessageCreate(data, ...rest) {
      if (isDamageSummaryMessageData(data)) {
        recordPerfEvent("perf-log.mjs:ChatMessage.create", "damage summary chat create", {
          hasDamageSummaryFlag: Boolean(foundry.utils.getProperty(data, "flags.fallout-maw.damageSummary")),
          contentLength: String(data?.content ?? "").length,
          options: summarizeOperationOptions(rest[0] ?? {})
        }, "H-card-chat-message");
      }
      return originalChatMessageCreate.call(this, data, ...rest);
    };
    patchedChatMessageCreate.__falloutMawPerfPatched = true;
    ChatMessageClass.create = patchedChatMessageCreate;
  }
}

export function installSubsystemCounterHooks() {
  if (subsystemHooksInstalled) return;
  subsystemHooksInstalled = true;

  if (globalThis.Hooks?.callAll) {
    const originalCallAll = Hooks.callAll;
    Hooks.callAll = function patchedHookCallAll(hook, ...args) {
      const started = performance.now();
      try {
        return originalCallAll.call(this, hook, ...args);
      } finally {
        if (["updateActor", "updateItem", "updateToken", "createItem", "deleteItem"].includes(hook)) {
          recordPerfTiming(`hook:${hook}`, performance.now() - started);
        }
      }
    };
  }

  if (globalThis.Hooks?.call) {
    const originalCall = Hooks.call;
    Hooks.call = function patchedHookCall(hook, ...args) {
      const started = performance.now();
      try {
        return originalCall.call(this, hook, ...args);
      } finally {
        if (["preUpdateActor", "preUpdateItem", "preUpdateToken", "preCreateItem", "preDeleteItem"].includes(hook)) {
          recordPerfTiming(`hook:${hook}`, performance.now() - started);
        }
      }
    };
  }

  Hooks.on("updateActor", () => recordSubsystemWork("updateActorHookTotal"));
  Hooks.on("updateToken", () => recordSubsystemWork("updateTokenHookTotal"));
  Hooks.on("updateActiveEffect", () => recordSubsystemWork("updateActiveEffectHookTotal"));
}

export function registerPerfProfiler() {
  installSubsystemCounterHooks();

  Hooks.once("ready", () => {
    installDocumentUpdatePatches();
    if (!CONFIG.FalloutMaW) CONFIG.FalloutMaW = {};
    CONFIG.FalloutMaW.perfProfiler = {
      snapshot: () => postDebugLog("perf-log.mjs:snapshot", "manual snapshot", {
        activeCycle: activeCycle?.id ?? null,
        activeActorOp: activeActorOp?.id ?? null,
        cascadeTail: cascadeTail?.cycleId ?? null
      }, "manual"),
      isActive: () => Boolean(activeCycle || cascadeTail)
    };
    console.log(`${game.system.id} | Perf profiler active (session ${DEBUG_SESSION})`);
  });
}
