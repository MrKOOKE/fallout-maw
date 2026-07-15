import { withSystemEventRoot } from "../events/dispatcher.mjs";

export const RESEARCH_EVENT_KEYS = Object.freeze({
  started: "fallout-maw.research.started",
  progressed: "fallout-maw.research.progressed",
  completed: "fallout-maw.research.completed",
  cancelled: "fallout-maw.research.cancelled"
});

/**
 * Commit one research mutation and then emit its semantic event in the same
 * system-event root. The mutation callback receives document-operation options
 * carrying the root lineage, so Foundry's committed document adapters join the
 * same chain instead of opening an unrelated root.
 */
export async function commitResearchEvent({
  actor = null,
  eventKey = "",
  beforeResearch = null,
  afterResearch = null,
  options = {},
  operation
} = {}) {
  if (!actor || typeof operation !== "function") return null;
  const normalizedEventKey = String(eventKey ?? "").trim();
  if (!Object.values(RESEARCH_EVENT_KEYS).includes(normalizedEventKey)) {
    throw new TypeError(`Unsupported research event '${normalizedEventKey}'.`);
  }

  const eventOptions = normalizeResearchEventOptions(options);
  const research = afterResearch ?? beforeResearch ?? {};
  const actorUuid = String(actor.uuid ?? "").trim();
  const researchId = String(research.id ?? "").trim();
  const occurrenceId = eventOptions.occurrenceId || randomId();
  const operationId = eventOptions.operationId
    || `research:${eventName(normalizedEventKey)}:${actorUuid}:${researchId}:${occurrenceId}`;

  return withSystemEventRoot({
    kind: `research.${eventName(normalizedEventKey)}`,
    operationId,
    sceneUuid: getActorSceneUuid(actor),
    combatUuid: String(globalThis.game?.combat?.uuid ?? ""),
    chainRef: eventOptions.chainRef,
    data: {
      researchId,
      progressSource: eventOptions.progressSource
    }
  }, async scope => {
    const result = await operation(createResearchDocumentOptions(scope.chainRef, eventOptions.documentOptions));
    const payload = buildResearchEventPayload({
      actorUuid,
      beforeResearch,
      afterResearch,
      gain: eventOptions.gain,
      progressSource: eventOptions.progressSource,
      reason: eventOptions.reason,
      checkSummary: eventOptions.checkSummary
    });
    const participant = createResearchActorParticipant(actor);
    await scope.emit(normalizedEventKey, payload, {
      occurrenceKey: `research:${eventName(normalizedEventKey)}:${actorUuid}:${researchId}:${occurrenceId}`,
      participants: { source: participant, target: null, related: [] },
      source: participant,
      target: null,
      related: []
    });
    return result;
  });
}

export function buildResearchEventPayload({
  actorUuid = "",
  beforeResearch = null,
  afterResearch = null,
  gain = null,
  progressSource = "",
  reason = "",
  checkSummary = null
} = {}) {
  const before = beforeResearch ? createResearchProgressSnapshot(beforeResearch) : null;
  const after = afterResearch ? createResearchProgressSnapshot(afterResearch) : null;
  const research = afterResearch ?? beforeResearch ?? {};
  const actualProgressDelta = before && after
    ? roundSignedResearchNumber(after.progress - before.progress)
    : 0;
  const targetDelta = before && after
    ? roundSignedResearchNumber(after.target - before.target)
    : 0;
  const normalizedGain = gain === null || gain === undefined
    ? Math.max(0, actualProgressDelta)
    : roundResearchNumber(gain);
  const normalizedChecks = normalizeResearchCheckSummary(checkSummary);

  return {
    data: {
      actorUuid: String(actorUuid ?? "").trim(),
      researchId: String(research.id ?? "").trim(),
      researchName: String(research.name ?? "").trim(),
      skillKey: String(research.skillKey ?? "").trim(),
      researchType: String(research.type ?? "").trim(),
      sourceId: String(research.sourceId ?? "").trim(),
      sourceCategoryId: String(research.sourceCategoryId ?? "").trim(),
      beforeProgress: before?.progress ?? null,
      afterProgress: after?.progress ?? null,
      beforeTarget: before?.target ?? null,
      afterTarget: after?.target ?? null,
      progress: after?.progress ?? before?.progress ?? 0,
      target: after?.target ?? before?.target ?? 1,
      gain: normalizedGain,
      progressDelta: actualProgressDelta,
      targetDelta,
      completionPercent: after?.completionPercent ?? before?.completionPercent ?? 0,
      completed: after?.completed ?? before?.completed ?? false,
      completionReached: Boolean(after?.completed && !before?.completed),
      progressSource: String(progressSource ?? "").trim(),
      reason: String(reason ?? "").trim(),
      ...(normalizedChecks ? { checkSummary: normalizedChecks } : {})
    },
    before,
    after,
    delta: {
      progress: actualProgressDelta,
      target: targetDelta,
      gain: normalizedGain
    },
    outcome: {
      success: true,
      completed: Boolean(after?.completed ?? before?.completed)
    },
    reason: String(reason ?? "").trim()
      || (after?.completed ? "completed" : "committed")
  };
}

export function createResearchProgressSnapshot(research = {}) {
  const target = Math.max(1, roundResearchNumber(research.target) || 1);
  const progress = Math.min(target, roundResearchNumber(research.progress));
  return {
    progress,
    target,
    completionPercent: target > 0 ? roundResearchNumber((progress / target) * 100) : 0,
    completed: progress >= target
  };
}

export function normalizeResearchCheckSummary(summary = null) {
  if (!summary || typeof summary !== "object") return null;
  const counts = {};
  for (const key of ["criticalFailure", "failure", "success", "criticalSuccess", "autoFailure"]) {
    counts[key] = Math.max(0, toInteger(summary.counts?.[key]));
  }
  return {
    checks: Math.max(0, toInteger(summary.checks)),
    resolved: Math.max(0, toInteger(summary.resolved ?? Object.values(counts).slice(0, 4).reduce((sum, value) => sum + value, 0))),
    counts,
    totalGain: roundResearchNumber(summary.totalGain)
  };
}

export function resolveResearchChainRef(options = {}) {
  return options?.chainRef
    ?? options?.falloutMawSystemEventChainRef
    ?? options?.documentOptions?.chainRef
    ?? options?.documentOptions?.falloutMawSystemEventChainRef
    ?? null;
}

function normalizeResearchEventOptions(options = {}) {
  return {
    chainRef: resolveResearchChainRef(options),
    operationId: String(options?.operationId ?? "").trim(),
    occurrenceId: String(options?.occurrenceId ?? "").trim(),
    progressSource: String(options?.progressSource ?? options?.source ?? "").trim(),
    reason: String(options?.reason ?? "").trim(),
    gain: options?.gain,
    checkSummary: options?.checkSummary ?? null,
    documentOptions: options?.documentOptions && typeof options.documentOptions === "object"
      ? options.documentOptions
      : {}
  };
}

function createResearchDocumentOptions(chainRef, options = {}) {
  return {
    ...options,
    falloutMawSystemEventChainRef: chainRef,
    chainRef
  };
}

function createResearchActorParticipant(actor) {
  const token = actor?.token?.document ?? actor?.token ?? null;
  return {
    actorUuid: String(actor?.uuid ?? ""),
    tokenUuid: String(token?.uuid ?? ""),
    itemUuid: ""
  };
}

function getActorSceneUuid(actor) {
  const token = actor?.token?.document ?? actor?.token ?? null;
  return String(token?.parent?.uuid ?? token?.scene?.uuid ?? globalThis.canvas?.scene?.uuid ?? "");
}

function eventName(eventKey) {
  return String(eventKey ?? "").split(".").at(-1) || "changed";
}

function randomId() {
  return String(globalThis.foundry?.utils?.randomID?.() ?? `${Date.now()}-${Math.random()}`);
}

function roundResearchNumber(value) {
  return Math.round((Math.max(0, Number(value) || 0) + Number.EPSILON) * 100) / 100;
}

function roundSignedResearchNumber(value) {
  const numeric = Number(value) || 0;
  return Math.round((numeric + (Math.sign(numeric) * Number.EPSILON)) * 100) / 100;
}

function toInteger(value) {
  return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
}
