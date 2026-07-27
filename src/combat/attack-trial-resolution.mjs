import { evaluateFormula as evaluateSystemFormula } from "../formulas/evaluation.mjs";
import { ENERGY_RESOURCE_KEY } from "./energy-resource.mjs";

const TRIAL_SUBJECT_SOURCE = "source";
const TRIAL_SUBJECT_TARGETS = "targets";
const SOURCE_MODE_ONCE = "once";
const SOURCE_MODE_PER_TARGET = "perTarget";
const SELECTION_MODE_WORST = "worst";
const FLOW_CONTINUE = "continue";
const FLOW_STOP_SUBJECT = "stopSubject";
const FLOW_STOP_ALL = "stopAll";
const RESULT_KEYS = new Set([
  "criticalFailure",
  "failure",
  "success",
  "criticalSuccess"
]);

let generatedResolutionId = 0;

/**
 * Create mutable state shared by every resolution pass of one attack
 * activation. It prevents source and target trials from being rolled again
 * when the controller resolves pellets or damage shares independently.
 */
export function createAttackTrialResolutionState() {
  return {
    stoppedAll: false,
    sourceOnceOutcomes: new Map(),
    targetLanes: new Map()
  };
}

/**
 * Resolve the configured hit trials without applying their linked constructs.
 *
 * `targets` accepts `{ actor, token, laneKey }` entries. By default a lane is
 * identified by token UUID and then actor UUID. Supplying a distinct laneKey
 * deliberately starts a separate trial sequence for another attack against
 * the same target.
 */
export async function resolveAttackTrialResolution({
  attackSettings = {},
  sourceActor = null,
  sourceToken = null,
  targets = [],
  state = null,
  session = null,
  title = "",
  operationId = "",
  chainRef = null,
  source = {},
  requester = "abilityAttackTrial",
  animate = false,
  createMessage = true
} = {}, dependencies = {}) {
  const resolutionState = prepareResolutionState(state ?? session);
  const normalizedTargets = normalizeTargets(targets);
  const result = createResolutionResult(resolutionState, normalizedTargets);
  if (!sourceActor || resolutionState.stoppedAll) {
    result.stoppedAll = Boolean(resolutionState.stoppedAll);
    return result;
  }

  const trials = Array.isArray(attackSettings?.hitResolution?.trials)
    ? attackSettings.hitResolution.trials
    : [];
  if (!trials.length) return result;

  const requestSkillCheckBatch = dependencies.requestSkillCheckBatch
    ?? defaultRequestSkillCheckBatch;
  const baseOperationId = String(operationId ?? "").trim() || createResolutionId();

  for (const [trialIndex, trial] of trials.entries()) {
    if (resolutionState.stoppedAll) break;

    const trialId = String(trial?.id ?? "").trim() || `trial-${trialIndex}`;
    const candidates = buildTrialCandidates({
      trial,
      trialId,
      sourceActor,
      sourceToken,
      targets: normalizedTargets,
      state: resolutionState
    });
    if (!candidates.length) continue;

    const pending = [];
    for (const candidate of candidates) {
      const cached = getCachedOutcome(resolutionState, candidate);
      if (cached) {
        appendResolvedOutcome(result, {
          ...cached,
          cached: true
        });
        result.reused += 1;
        continue;
      }

      const selected = selectTrialSkill(trial, candidate.actor);
      if (!selected) continue;
      const difficulty = await evaluateAttackTrialDifficulty({
        formula: trial?.difficultyFormula,
        sourceActor,
        targetActor: candidate.target?.actor ?? null,
        subjectActor: candidate.actor
      }, dependencies);
      const chanceOperationId = [
        baseOperationId,
        trialId,
        candidate.cacheKind,
        candidate.laneKey || "source"
      ].join(":");
      pending.push({
        ...candidate,
        trial,
        trialId,
        skillKey: selected.skillKey,
        difficulty,
        chanceOperationId
      });
    }

    if (pending.length) {
      result.attempted += pending.length;
      const batch = await requestSkillCheckBatch({
        entries: pending.map(entry => ({
          actor: entry.actor,
          skillKey: entry.skillKey,
          data: buildSkillCheckData(entry, {
            sourceActor,
            sourceToken,
            operationId: baseOperationId
          })
        })),
        animate,
        createMessage,
        requester,
        title,
        chainRef,
        options: {
          operationId: `${baseOperationId}:${trialId}:${trialIndex}`
        },
        source: {
          ...(source && typeof source === "object" ? source : {}),
          operationId: baseOperationId
        }
      });

      const matched = matchBatchOutcomes(pending, batch?.outcomes ?? []);
      for (const { entry, check } of matched) {
        const resultKey = String(check?.result?.key ?? "");
        if (!RESULT_KEYS.has(resultKey)) continue;
        const branch = trial?.outcomes?.[resultKey];
        if (!branch || typeof branch !== "object") continue;

        const configuredFlow = normalizeFlow(branch.flow);
        const flow = entry.cacheKind === "sourceOnce" && configuredFlow === FLOW_STOP_SUBJECT
          ? FLOW_STOP_ALL
          : configuredFlow;
        const resolved = {
          trialId,
          subject: entry.subject,
          sourceMode: entry.sourceMode,
          actor: entry.actor,
          token: entry.token,
          target: entry.target,
          laneKey: entry.laneKey,
          skillKey: entry.skillKey,
          difficulty: entry.difficulty,
          resultKey,
          outcomeId: String(branch.id ?? ""),
          outcome: branch,
          links: Array.isArray(branch.links) ? branch.links : [],
          configuredFlow,
          flow,
          check,
          cached: false
        };

        cacheResolvedOutcome(resolutionState, entry, resolved);
        applyResolvedFlow(resolutionState, entry, flow);
        appendResolvedOutcome(result, resolved);
        result.resolved += 1;
      }
    }

    if (resolutionState.stoppedAll) break;
  }

  result.stoppedAll = Boolean(resolutionState.stoppedAll);
  for (const targetResult of result.targetOutcomes) {
    targetResult.stopped = Boolean(
      resolutionState.targetLanes.get(targetResult.laneKey)?.stopped
    );
  }
  return result;
}

/**
 * Evaluate a trial difficulty against the source actor's normal formula aliases.
 * Explicit nested references are also available as `@source...`, `@target...`
 * and `@subject...`.
 */
export async function evaluateAttackTrialDifficulty({
  formula = "0",
  sourceActor = null,
  targetActor = null,
  subjectActor = null,
  fallback = 0,
  minimum = 0
} = {}, dependencies = {}) {
  if (typeof dependencies.evaluateDifficulty === "function") {
    const value = await dependencies.evaluateDifficulty({
      formula,
      sourceActor,
      targetActor,
      subjectActor,
      fallback,
      minimum
    });
    return normalizeDifficulty(value, { fallback, minimum });
  }

  const buildActorFormulaData = dependencies.buildActorFormulaData
    ?? defaultBuildActorFormulaData;
  const evaluateFormula = dependencies.evaluateFormula ?? evaluateSystemFormula;
  try {
    const baseData = await buildActorFormulaData(sourceActor);
    const data = buildAttackTrialFormulaData({
      baseData,
      sourceActor,
      targetActor,
      subjectActor
    });
    return normalizeDifficulty(evaluateFormula(String(formula ?? "0"), data), {
      fallback,
      minimum
    });
  } catch (error) {
    const warn = dependencies.warn ?? console.warn;
    warn?.(`Fallout MaW | Attack trial difficulty formula failed: ${error.message}`);
    return normalizeDifficulty(fallback, { fallback, minimum });
  }
}

/**
 * Extend actor formula data with explicit source/target/subject references.
 */
export function buildAttackTrialFormulaData({
  baseData = {},
  sourceActor = null,
  targetActor = null,
  subjectActor = null
} = {}) {
  const source = baseData && typeof baseData === "object" ? baseData : {};
  const formulaVariables = {
    ...(source.formulaVariables && typeof source.formulaVariables === "object"
      ? source.formulaVariables
      : {})
  };
  addBareSourceResourceAliases(formulaVariables, sourceActor);
  const reservedResourceAliases = new Set(
    Object.keys(sourceActor?.system?.resources ?? {})
      .map(key => String(key).trim().toLowerCase())
      .filter(Boolean)
  );

  const formulaReferences = {
    ...(source.formulaReferences && typeof source.formulaReferences === "object"
      ? source.formulaReferences
      : {})
  };
  addActorReferences(formulaReferences, "source", sourceActor);
  addActorReferences(formulaReferences, "target", targetActor);
  addActorReferences(formulaReferences, "subject", subjectActor);

  return {
    ...source,
    // Real resource keys win collisions, while configured skill aliases retain
    // their normal meaning. In the stock configuration `energy`/`ene` are the
    // Контроль энергии skill and the energy resource is `power`/`pow`.
    characteristicSettings: excludeCollidingFormulaSettings(
      source.characteristicSettings,
      reservedResourceAliases
    ),
    skillSettings: excludeCollidingFormulaSettings(
      source.skillSettings,
      reservedResourceAliases
    ),
    formulaVariables,
    variables: mergeFormulaVariables(source.variables, Object.keys(formulaVariables)),
    formulaReferences,
    references: formulaReferences
  };
}

function excludeCollidingFormulaSettings(settings, reservedAliases) {
  const source = Array.isArray(settings) ? settings : [];
  if (!reservedAliases.size) return source;
  return source.filter(entry => {
    const aliases = [
      entry?.key,
      entry?.abbr,
      ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
    ]
      .map(value => String(value ?? "").trim().toLowerCase())
      .filter(Boolean);
    return !aliases.some(alias => reservedAliases.has(alias));
  });
}

function createResolutionResult(state, targets) {
  return {
    attempted: 0,
    resolved: 0,
    reused: 0,
    stoppedAll: Boolean(state.stoppedAll),
    sourceOutcomes: [],
    targetOutcomes: targets.map(target => ({
      actor: target.actor,
      token: target.token,
      laneKey: target.laneKey,
      stopped: Boolean(state.targetLanes.get(target.laneKey)?.stopped),
      sourceOutcomes: [],
      outcomes: []
    })),
    outcomes: [],
    state
  };
}

function buildTrialCandidates({
  trial,
  trialId,
  sourceActor,
  sourceToken,
  targets,
  state
}) {
  const subject = trial?.subject === TRIAL_SUBJECT_SOURCE
    ? TRIAL_SUBJECT_SOURCE
    : TRIAL_SUBJECT_TARGETS;
  if (subject === TRIAL_SUBJECT_SOURCE) {
    const sourceMode = trial?.sourceMode === SOURCE_MODE_PER_TARGET
      ? SOURCE_MODE_PER_TARGET
      : SOURCE_MODE_ONCE;
    if (sourceMode === SOURCE_MODE_ONCE) {
      return [{
        actor: sourceActor,
        token: sourceToken,
        target: null,
        laneKey: "",
        subject,
        sourceMode,
        trialId,
        cacheKind: "sourceOnce"
      }];
    }
    return targets
      .filter(target => !state.targetLanes.get(target.laneKey)?.stopped)
      .map(target => ({
        actor: sourceActor,
        token: sourceToken,
        target,
        laneKey: target.laneKey,
        subject,
        sourceMode,
        trialId,
        cacheKind: "targetLane"
      }));
  }

  return targets
    .filter(target => !state.targetLanes.get(target.laneKey)?.stopped)
    .map(target => ({
      actor: target.actor,
      token: target.token,
      target,
      laneKey: target.laneKey,
      subject,
      sourceMode: SOURCE_MODE_ONCE,
      trialId,
      cacheKind: "targetLane"
    }));
}

function selectTrialSkill(trial, actor) {
  const configured = (Array.isArray(trial?.entries) ? trial.entries : [])
    .filter(entry => entry?.kind === "skill" && String(entry?.key ?? "").trim())
    .map((entry, order) => ({
      skillKey: String(entry.key).trim(),
      order,
      value: Number(actor?.system?.skills?.[entry.key]?.value)
    }))
    .filter(entry => Number.isFinite(entry.value));
  configured.sort((left, right) => (
    trial?.selectionMode === SELECTION_MODE_WORST
      ? left.value - right.value || left.order - right.order
      : right.value - left.value || left.order - right.order
  ));
  return configured[0] ?? null;
}

function buildSkillCheckData(entry, {
  sourceActor,
  sourceToken,
  operationId
}) {
  const checksSource = entry.subject === TRIAL_SUBJECT_TARGETS;
  return {
    difficulty: entry.difficulty,
    actorToken: entry.token,
    targetActor: checksSource ? sourceActor : entry.target?.actor ?? null,
    targetToken: checksSource ? sourceToken : entry.target?.token ?? null,
    allowImplicitTarget: false,
    chanceOperationId: entry.chanceOperationId,
    weaponAttackId: operationId
  };
}

function matchBatchOutcomes(entries, outcomes) {
  const indexed = outcomes.map((check, index) => ({
    check,
    index,
    chanceOperationId: String(
      check?.check?.chanceOperationId
      ?? check?.chanceOperationId
      ?? ""
    ),
    actorUuid: String(check?.actor?.uuid ?? "")
  }));
  const byChanceId = new Map(
    indexed
      .filter(item => item.chanceOperationId)
      .map(item => [item.chanceOperationId, item])
  );
  const used = new Set();
  const matched = [];

  for (const entry of entries) {
    let selected = byChanceId.get(entry.chanceOperationId);
    if (selected && used.has(selected.index)) selected = null;
    if (!selected) {
      const actorUuid = String(entry.actor?.uuid ?? "");
      selected = indexed.find(item => (
        !used.has(item.index)
        && (!actorUuid || item.actorUuid === actorUuid)
      )) ?? null;
    }
    if (!selected) continue;
    used.add(selected.index);
    matched.push({ entry, check: selected.check });
  }
  return matched;
}

function appendResolvedOutcome(result, resolved) {
  result.outcomes.push(resolved);
  if (resolved.subject === TRIAL_SUBJECT_SOURCE) {
    result.sourceOutcomes.push(resolved);
    if (resolved.laneKey) {
      const targetResult = result.targetOutcomes.find(entry => entry.laneKey === resolved.laneKey);
      if (targetResult) targetResult.sourceOutcomes.push(resolved);
    }
    return;
  }
  const targetResult = result.targetOutcomes.find(entry => entry.laneKey === resolved.laneKey);
  if (targetResult) targetResult.outcomes.push(resolved);
}

function getCachedOutcome(state, candidate) {
  if (candidate.cacheKind === "sourceOnce") {
    return state.sourceOnceOutcomes.get(candidate.trialId) ?? null;
  }
  return state.targetLanes
    .get(candidate.laneKey)
    ?.outcomes
    ?.get(candidate.trialId) ?? null;
}

function cacheResolvedOutcome(state, entry, resolved) {
  if (entry.cacheKind === "sourceOnce") {
    state.sourceOnceOutcomes.set(entry.trialId, resolved);
    return;
  }
  const lane = getTargetLaneState(state, entry.laneKey);
  lane.outcomes.set(entry.trialId, resolved);
}

function applyResolvedFlow(state, entry, flow) {
  if (flow === FLOW_STOP_ALL) {
    state.stoppedAll = true;
    return;
  }
  if (flow !== FLOW_STOP_SUBJECT) return;
  if (entry.cacheKind === "sourceOnce") {
    state.stoppedAll = true;
    return;
  }
  getTargetLaneState(state, entry.laneKey).stopped = true;
}

function prepareResolutionState(value) {
  const state = value && typeof value === "object"
    ? value
    : createAttackTrialResolutionState();
  if (!(state.sourceOnceOutcomes instanceof Map)) state.sourceOnceOutcomes = new Map();
  if (!(state.targetLanes instanceof Map)) state.targetLanes = new Map();
  state.stoppedAll = Boolean(state.stoppedAll);
  return state;
}

function getTargetLaneState(state, laneKey) {
  let lane = state.targetLanes.get(laneKey);
  if (!lane || typeof lane !== "object") {
    lane = { stopped: false, outcomes: new Map() };
    state.targetLanes.set(laneKey, lane);
  }
  if (!(lane.outcomes instanceof Map)) lane.outcomes = new Map();
  lane.stopped = Boolean(lane.stopped);
  return lane;
}

function normalizeTargets(targets) {
  const normalized = [];
  const seen = new Set();
  for (const entry of Array.isArray(targets) ? targets : []) {
    const actor = entry?.actor ?? null;
    if (!actor) continue;
    const token = entry?.token ?? null;
    const laneKey = String(
      entry?.laneKey
      ?? token?.document?.uuid
      ?? token?.uuid
      ?? actor?.uuid
      ?? ""
    ).trim();
    if (!laneKey || seen.has(laneKey)) continue;
    seen.add(laneKey);
    normalized.push({ actor, token, laneKey });
  }
  return normalized;
}

function normalizeFlow(value) {
  const flow = String(value ?? "");
  if (flow === FLOW_STOP_SUBJECT || flow === FLOW_STOP_ALL) return flow;
  return FLOW_CONTINUE;
}

function normalizeDifficulty(value, { fallback = 0, minimum = 0 } = {}) {
  const fallbackValue = Number.isFinite(Number(fallback))
    ? Math.trunc(Number(fallback))
    : 0;
  const number = Number.isFinite(Number(value))
    ? Math.trunc(Number(value))
    : fallbackValue;
  return Math.max(Number(minimum) || 0, number);
}

function addBareSourceResourceAliases(target, actor) {
  for (const [key, resource] of Object.entries(actor?.system?.resources ?? {})) {
    const normalized = String(key ?? "").trim();
    const value = readIndicatorValue(resource);
    if (!normalized || value === null || Object.hasOwn(target, normalized)) continue;
    target[normalized] = value;
  }
}

function addActorReferences(target, prefix, actor) {
  if (!actor?.system || typeof actor.system !== "object") return;
  collectNumericReferences(actor.system, [], (path, value) => {
    target[`${prefix}.${path}`] = value;
    target[`${prefix}.system.${path}`] = value;
  });
  for (const group of ["resources", "skills", "needs", "proficiencies", "limbs"]) {
    for (const [key, indicator] of Object.entries(actor.system?.[group] ?? {})) {
      const value = readIndicatorValue(indicator);
      if (value === null) continue;
      target[`${prefix}.${group}.${key}`] = value;
      target[`${prefix}.system.${group}.${key}`] = value;
      if (group === "resources") target[`${prefix}.${key}`] = value;
    }
  }
  const energy = readIndicatorValue(actor.system?.resources?.[ENERGY_RESOURCE_KEY]);
  if (energy !== null) {
    target[`${prefix}.energy`] = energy;
    target[`${prefix}.ene`] = energy;
    target[`${prefix}.resources.energy`] = energy;
    target[`${prefix}.resources.energy.value`] = energy;
    target[`${prefix}.resources.ene`] = energy;
    target[`${prefix}.resources.ene.value`] = energy;
    target[`${prefix}.system.resources.energy`] = energy;
    target[`${prefix}.system.resources.energy.value`] = energy;
    target[`${prefix}.system.resources.ene`] = energy;
    target[`${prefix}.system.resources.ene.value`] = energy;
  }
}

function collectNumericReferences(value, segments, add, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return;
  const number = toFiniteNumber(value);
  if (number !== null) {
    if (segments.length) add(segments.join("."), number);
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (!isFormulaPathSegment(key)) continue;
    collectNumericReferences(child, [...segments, key], add, depth + 1);
  }
}

function readIndicatorValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return toFiniteNumber(value.value);
  }
  return toFiniteNumber(value);
}

function toFiniteNumber(value) {
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isFormulaPathSegment(value) {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(String(value ?? ""));
}

function mergeFormulaVariables(configured, keys) {
  const result = [];
  const seen = new Set();
  for (const entry of Array.isArray(configured) ? configured : []) {
    const identity = typeof entry === "object"
      ? String(entry?.key ?? "").trim()
      : String(entry ?? "").trim();
    if (!identity || seen.has(identity.toLowerCase())) continue;
    seen.add(identity.toLowerCase());
    result.push(entry);
  }
  for (const key of keys) {
    const normalized = String(key ?? "").trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}

async function defaultBuildActorFormulaData(actor) {
  const { buildActorFormulaData } = await import("../utils/actor-formulas.mjs");
  return buildActorFormulaData(actor);
}

async function defaultRequestSkillCheckBatch(options) {
  const { requestSkillCheckBatch } = await import("../rolls/skill-check.mjs");
  return requestSkillCheckBatch(options);
}

function createResolutionId() {
  const randomId = globalThis.foundry?.utils?.randomID?.();
  if (randomId) return `attack-trial:${randomId}`;
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `attack-trial:${uuid}`;
  generatedResolutionId += 1;
  return `attack-trial:${Date.now()}:${generatedResolutionId}`;
}
