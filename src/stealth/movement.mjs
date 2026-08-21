import { SYSTEM_ID } from "../constants.mjs";
import { evaluateFormula } from "../formulas/evaluation.mjs";
import {
  ACTION_RESOURCE_KEY,
  MOVEMENT_RESOURCE_KEY,
  calculateCombatMovementCostTrancheDelta,
  getCombatMovementCostProfile
} from "../combat/movement-resources.mjs";
import {
  createMovementOptions,
  getMovementRouteSamples,
  getMovementSegmentSamples,
  registerMovementInterruptionProvider
} from "../canvas/movement-interruptions.mjs";
import {
  INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION,
  withMovementResumeContext
} from "../canvas/movement-resume-context.mjs";
import { isPointInsideObserverZone } from "./detection.mjs";
import { isValidStealthObserver } from "./observers.mjs";
import {
  getRuntimeStealthSettings,
  getTokenCenter,
  isActorStealthed,
  normalizePoint,
  pixelsToSceneDistance
} from "./rules.mjs";

const STEALTH_DETECTION_PROVIDER_ID = "stealthDetection";
const STEALTH_DETECTION_PRIORITY = 3;
export const STEALTH_MOVEMENT_STATE_FLAG = "stealthMovementState";
const STEALTH_MOVEMENT_STATE_VERSION = 2;
const STEALTH_MOVEMENT_STATE_ENTRY_LIMIT = 250;

const movementThresholdFormulaData = {
  variables: ["actionPointsMax", "movementPointsMax", "ОД", "ОП"],
  formulaVariables: {
    actionPointsMax: 0,
    movementPointsMax: 0,
    "ОД": 0,
    "ОП": 0
  }
};

let rollStealthCheckCallback = async () => undefined;
let rollStealthChecksCallback = null;
let pauseGameCallback = () => undefined;
let providerRegistered = false;

export function registerStealthMovementProvider({ rollStealthCheck, rollStealthChecks, pauseGame } = {}) {
  if (typeof rollStealthCheck === "function") rollStealthCheckCallback = rollStealthCheck;
  if (typeof rollStealthChecks === "function") rollStealthChecksCallback = rollStealthChecks;
  if (typeof pauseGame === "function") pauseGameCallback = pauseGame;
  if (providerRegistered) return;
  registerMovementInterruptionProvider({
    id: STEALTH_DETECTION_PROVIDER_ID,
    collect: collectStealthMovementInterruptions,
    commit: commitStealthMovementCollection,
    buildAtomicMovementUpdate: buildStealthMovementAtomicUpdate,
    hasCommitWork: collection => Boolean(collection?.stateUpdates?.size),
    commitOnInterruption: true,
    execute: executeStealthMovementInterruption
  });
  providerRegistered = true;
}

/**
 * Pure collection pass. Proposed pair-state changes are committed by the
 * shared interruption coordinator only if this movement (or this provider's
 * selected interruption) is actually accepted.
 */
export function collectStealthMovementInterruptions({ tokenDocument, movement, options } = {}) {
  const settings = getRuntimeStealthSettings();
  if (!settings.autoDetection?.enabled || !tokenDocument?.actor || !movement || !globalThis.canvas?.ready) {
    return createEmptyMovementCollection();
  }

  const samples = getMovementRouteSamples(tokenDocument, movement);
  if (samples.length < 2) return createEmptyMovementCollection();
  const pairDescriptors = getMovementStealthPairDescriptors(tokenDocument);
  if (!pairDescriptors.length) return createEmptyMovementCollection();
  const movementThreshold = evaluateAutoDetectionMovementThreshold(tokenDocument.actor, settings);
  const movementCostProfile = getCombatMovementCostProfile(tokenDocument.actor);

  let routeOrder = 0;
  const routeInsideState = new Map();
  const stateUpdates = new Map();
  const stateBaselines = new Map();
  const stateTransitions = [];
  let rawMovementCost = 0;
  let adjustedMovementCost = 0;
  const getBaseline = (key, pair) => {
    if (!stateBaselines.has(key)) stateBaselines.set(key, readPersistentPairState(pair, key));
    return stateBaselines.get(key);
  };
  const readState = (key, pair) => stateUpdates.has(key) ? stateUpdates.get(key) : getBaseline(key, pair).value;
  const hasState = (key, pair) => stateUpdates.has(key)
    ? stateUpdates.get(key) !== null
    : getBaseline(key, pair).value !== null;
  const writeState = (key, value, waypoint) => {
    stateUpdates.set(key, value);
    stateTransitions.push({
      routeOrder,
      waypointKey: getMovementWaypointKey(waypoint),
      key,
      value
    });
  };

  for (let index = 1; index < samples.length; index += 1) {
    const segmentSamples = getMovementSegmentSamples(tokenDocument, samples[index - 1], samples[index]);
    for (let segmentIndex = 1; segmentIndex < segmentSamples.length; segmentIndex += 1) {
      routeOrder += 1;
      const previous = segmentSamples[segmentIndex - 1];
      const current = segmentSamples[segmentIndex];
      const pairs = getMovementStealthPairs(tokenDocument, previous, current, pairDescriptors);
      const rawSegmentCost = getStealthMovementSegmentDistance(previous, current);
      const movementCost = calculateCombatMovementCostTrancheDelta(
        movementCostProfile,
        rawMovementCost,
        adjustedMovementCost,
        rawSegmentCost
      );
      rawMovementCost += rawSegmentCost;
      adjustedMovementCost += movementCost;
      const triggeredChecks = [];

      for (const pair of pairs) {
        const stateKey = getDetectionMovementStateKey(pair);
        const wasInside = routeInsideState.has(stateKey)
          ? routeInsideState.get(stateKey)
          : isPointInsideObserverZone(pair.previous.hiddenPoint, pair.observerToken, pair.previous.observerOrigin, settings);
        const isInside = isPointInsideObserverZone(pair.current.hiddenPoint, pair.observerToken, pair.current.observerOrigin, settings);
        routeInsideState.set(stateKey, isInside);
        const hadState = hasState(stateKey, pair);

        if (!isInside) {
          if (hadState) writeState(stateKey, null, current.waypoint);
          continue;
        }

        if (!wasInside && !hadState) {
          writeState(stateKey, 0, current.waypoint);
          triggeredChecks.push({ pair, type: "enter" });
          continue;
        }

        const accumulated = Math.max(0, Number(readState(stateKey, pair)) || 0) + movementCost;
        if (accumulated >= movementThreshold) {
          writeState(stateKey, accumulated % movementThreshold, current.waypoint);
          triggeredChecks.push({ pair, type: "inside" });
          continue;
        }
        writeState(stateKey, accumulated, current.waypoint);
      }
      if (triggeredChecks.length) {
        return {
          events: [createStealthMovementEvent(
            triggeredChecks,
            current,
            segmentSamples,
            segmentIndex,
            samples,
            index,
            routeOrder,
            movement
          )],
          stateUpdates,
          stateBaselines,
          stateTransitions
        };
      }
    }
  }
  return { events: [], stateUpdates, stateBaselines, stateTransitions };
}

export function buildStealthMovementAtomicUpdate({ tokenDocument, collection, selectedEvent } = {}) {
  const updates = getCommittableStateUpdates(collection, selectedEvent);
  if (!updates.size) return null;
  const rawFlag = readMovementStateFlag(tokenDocument);
  const flag = normalizeMovementStateFlag(rawFlag);
  const byKey = new Map(flag.entries.map(entry => [entry.key, entry]));
  const writerTokenUuid = String(tokenDocument.uuid ?? "");
  const updatedAt = Date.now();
  const changedEntries = [];

  for (const [key, value] of updates) {
    const baseline = collection?.stateBaselines?.get(key);
    if (!baseline?.pair) continue;
    const existingRevision = Math.max(0, Number(byKey.get(key)?.revision) || 0);
    const entry = {
      key,
      value: value === null ? null : Math.max(0, Number(value) || 0),
      revision: Math.max(existingRevision, baseline.revision) + 1,
      baseRevision: Math.max(0, Number(baseline.revision) || 0),
      baseValue: baseline.value === null ? null : Math.max(0, Number(baseline.value) || 0),
      writerTokenUuid,
      hiddenTokenUuid: getTokenUuid(baseline.pair.hiddenToken),
      observerTokenUuid: getTokenUuid(baseline.pair.observerToken),
      hiddenActorUuid: String(baseline.pair.hiddenToken?.actor?.uuid ?? ""),
      sessionId: getStealthSessionId(baseline.pair.hiddenToken?.actor),
      updatedAt
    };
    byKey.set(key, entry);
    changedEntries.push(entry);
  }
  if (!changedEntries.length) return null;

  const entries = [...byKey.values()].sort(compareMovementStateRecency);
  const retainedByKey = new Map(changedEntries
    .slice(0, STEALTH_MOVEMENT_STATE_ENTRY_LIMIT)
    .map(entry => [entry.key, entry]));
  for (const entry of entries) {
    if (retainedByKey.size >= STEALTH_MOVEMENT_STATE_ENTRY_LIMIT) break;
    if (!retainedByKey.has(entry.key)) retainedByKey.set(entry.key, entry);
  }
  const retainedEntries = [...retainedByKey.values()];
  const flagPath = `flags.${SYSTEM_ID}.${STEALTH_MOVEMENT_STATE_FLAG}`;
  const requiresFullReplacement = Array.isArray(rawFlag?.entries)
    || entries.length > STEALTH_MOVEMENT_STATE_ENTRY_LIMIT;
  if (requiresFullReplacement) {
    return {
      [flagPath]: createForcedReplacement({
        version: STEALTH_MOVEMENT_STATE_VERSION,
        entries: serializeMovementStateEntries(retainedEntries)
      })
    };
  }

  const patch = { [`${flagPath}.version`]: STEALTH_MOVEMENT_STATE_VERSION };
  for (const entry of changedEntries) {
    patch[`${flagPath}.entries.${encodeMovementStateEntryKey(entry.key)}`] = serializeMovementStateEntry(entry);
  }
  return patch;
}

export async function commitStealthMovementCollection(context = {}) {
  if (!context.tokenDocument?.update) return;
  const patch = buildStealthMovementAtomicUpdate(context);
  if (!patch) return;
  await context.tokenDocument.update(patch, {
    render: false,
    falloutMawStealthMovementStateCommit: true
  });
}

function serializeMovementStateEntries(entries = []) {
  return Object.fromEntries(entries.map(entry => [
    encodeMovementStateEntryKey(entry.key),
    serializeMovementStateEntry(entry)
  ]));
}

function createForcedReplacement(value) {
  return globalThis.foundry?.data?.operators?.ForcedReplacement?.create?.(value)
    ?? globalThis._replace?.(value)
    ?? value;
}

function serializeMovementStateEntry(entry = {}) {
  return {
    value: entry.value,
    revision: entry.revision,
    baseRevision: entry.baseRevision,
    baseValue: entry.baseValue,
    writerTokenUuid: entry.writerTokenUuid,
    hiddenTokenUuid: entry.hiddenTokenUuid,
    observerTokenUuid: entry.observerTokenUuid,
    hiddenActorUuid: entry.hiddenActorUuid,
    sessionId: entry.sessionId,
    updatedAt: entry.updatedAt
  };
}

function compareMovementStateRecency(left, right) {
  return ((Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0))
    || compareMovementStateEntries(left, right)
    || String(left.key ?? "").localeCompare(String(right.key ?? ""));
}

function encodeMovementStateEntryKey(key) {
  const bytes = new TextEncoder().encode(String(key ?? ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `k_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

function decodeMovementStateEntryKey(encoded) {
  const value = String(encoded ?? "");
  if (!value.startsWith("k_")) return "";
  const base64 = value.slice(2).replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch (_error) {
    return "";
  }
}

function getCommittableStateUpdates(collection = {}, selectedEvent = null) {
  if (!selectedEvent || selectedEvent.providerId === STEALTH_DETECTION_PROVIDER_ID) {
    return collection?.stateUpdates ?? new Map();
  }

  const updates = new Map();
  const transitions = collection?.stateTransitions ?? [];
  const cutoff = Math.max(0, Number(selectedEvent.routeOrder) || 0);
  for (const transition of transitions) {
    if (transition.routeOrder <= cutoff) updates.set(transition.key, transition.value);
  }
  return updates;
}

function createEmptyMovementCollection() {
  return {
    events: [],
    stateUpdates: new Map(),
    stateBaselines: new Map(),
    stateTransitions: []
  };
}

function readPersistentPairState(pair, key) {
  const candidates = [pair.hiddenToken?.document, pair.observerToken?.document]
    .filter(Boolean)
    .flatMap((document, sourceIndex) => normalizeMovementStateFlag(readMovementStateFlag(document)).entries
      .map(entry => ({
        ...entry,
        _sourceKey: String(document.uuid ?? sourceIndex)
      })))
    .filter(entry => entry.key === key);
  const latest = candidates.sort(compareMovementStateEntries).at(0) ?? null;
  const revision = Math.max(0, Number(latest?.revision) || 0);
  const siblingsByWriter = new Map();
  for (const candidate of candidates.filter(entry => entry.revision === revision)) {
    const writerKey = candidate.writerTokenUuid || candidate._sourceKey;
    const existing = siblingsByWriter.get(writerKey);
    if (!existing || compareMovementStateEntries(candidate, existing) < 0) {
      siblingsByWriter.set(writerKey, candidate);
    }
  }
  const siblings = [...siblingsByWriter.values()];
  let value = latest?.value === null || latest === null ? null : Math.max(0, Number(latest.value) || 0);
  if (canCausallyMergeMovementStateSiblings(siblings)) {
    const baseValue = siblings[0].baseValue;
    value = baseValue + siblings.reduce((sum, entry) => sum + (entry.value - baseValue), 0);
  }
  return {
    pair,
    revision,
    value
  };
}

function canCausallyMergeMovementStateSiblings(siblings = []) {
  if (siblings.length < 2) return false;
  const { baseRevision, baseValue } = siblings[0];
  if (!Number.isInteger(baseRevision) || !Number.isFinite(baseValue)) return false;
  return siblings.every(entry => (
    entry.baseRevision === baseRevision
    && entry.baseValue === baseValue
    && Number.isFinite(entry.value)
    && entry.value >= baseValue
  ));
}

function compareMovementStateEntries(left, right) {
  const revisionDifference = (Number(right.revision) || 0) - (Number(left.revision) || 0);
  if (revisionDifference) return revisionDifference;
  return String(right.writerTokenUuid ?? "").localeCompare(String(left.writerTokenUuid ?? ""));
}

function readMovementStateFlag(tokenDocument) {
  return tokenDocument?.getFlag?.(SYSTEM_ID, STEALTH_MOVEMENT_STATE_FLAG)
    ?? tokenDocument?.flags?.[SYSTEM_ID]?.[STEALTH_MOVEMENT_STATE_FLAG]
    ?? tokenDocument?._source?.flags?.[SYSTEM_ID]?.[STEALTH_MOVEMENT_STATE_FLAG]
    ?? null;
}

export function normalizeMovementStateFlag(value) {
  const byKey = new Map();
  const rawEntries = Array.isArray(value?.entries)
    ? value.entries.map(raw => ["", raw])
    : Object.entries(value?.entries && typeof value.entries === "object" ? value.entries : {});
  for (const [encodedKey, raw] of rawEntries) {
    const key = String(raw?.key ?? decodeMovementStateEntryKey(encodedKey)).trim();
    if (!key) continue;
    const numericValue = raw.value === null ? null : Number(raw.value);
    if (numericValue !== null && !Number.isFinite(numericValue)) continue;
    const numericBaseRevision = raw.baseRevision === null || raw.baseRevision === undefined
      ? null
      : Number(raw.baseRevision);
    const numericBaseValue = raw.baseValue === null || raw.baseValue === undefined
      ? null
      : Number(raw.baseValue);
    const entry = {
      key,
      value: numericValue === null ? null : Math.max(0, numericValue),
      revision: Math.max(0, Math.trunc(Number(raw.revision) || 0)),
      baseRevision: Number.isFinite(numericBaseRevision)
        ? Math.max(0, Math.trunc(numericBaseRevision))
        : null,
      baseValue: Number.isFinite(numericBaseValue) ? Math.max(0, numericBaseValue) : null,
      writerTokenUuid: String(raw.writerTokenUuid ?? ""),
      hiddenTokenUuid: String(raw.hiddenTokenUuid ?? ""),
      observerTokenUuid: String(raw.observerTokenUuid ?? ""),
      hiddenActorUuid: String(raw.hiddenActorUuid ?? ""),
      sessionId: String(raw.sessionId ?? ""),
      updatedAt: Math.max(0, Number(raw.updatedAt) || 0)
    };
    const existing = byKey.get(key);
    if (!existing || compareMovementStateEntries(entry, existing) < 0) byKey.set(key, entry);
  }
  return { version: STEALTH_MOVEMENT_STATE_VERSION, entries: [...byKey.values()] };
}

function getStealthSessionId(actor) {
  const statusId = globalThis.CONFIG?.specialStatusEffects?.INVISIBLE ?? "invisible";
  const effects = actor?.effects?.contents ?? actor?.effects ?? [];
  const ids = [];
  for (const effect of effects) {
    if (!effect?.statuses?.has?.(statusId)) continue;
    if (effect.id) {
      const revision = effect?._stats?.createdTime
        ?? effect?._source?.duration?.startTime
        ?? effect?.duration?.startTime
        ?? "";
      ids.push(revision === "" ? String(effect.id) : `${effect.id}:${revision}`);
    }
  }
  ids.sort();
  return ids.length ? ids.join(",") : `status:${statusId}`;
}

function getTokenUuid(token) {
  return String(token?.document?.uuid ?? token?.uuid ?? "");
}

async function executeStealthMovementInterruption({
  tokenDocument,
  movement,
  event,
  options,
  chainRef = null,
  isCurrent = null
} = {}) {
  let revealed = false;
  const checksByActor = new Map();
  for (const check of getStealthEventChecks(event)) {
    const hiddenTokenDocument = await fromUuid(String(check.hiddenTokenUuid ?? ""));
    const observerTokenDocument = await fromUuid(String(check.observerTokenUuid ?? ""));
    const hiddenToken = hiddenTokenDocument?.object ?? hiddenTokenDocument;
    const observerToken = observerTokenDocument?.object ?? observerTokenDocument;
    if (!hiddenToken?.actor || !observerToken?.actor || !isActorStealthed(hiddenToken.actor)) continue;
    const actorChecks = checksByActor.get(hiddenToken.actor.uuid) ?? [];
    actorChecks.push({ sourceToken: hiddenToken, targetToken: observerToken });
    checksByActor.set(hiddenToken.actor.uuid, actorChecks);
  }

  for (const actorChecks of checksByActor.values()) {
    const actor = actorChecks[0]?.sourceToken?.actor ?? null;
    const outcomes = rollStealthChecksCallback
      ? await rollStealthChecksCallback(actorChecks, { animate: false })
      : await Promise.all(actorChecks.map(check => rollStealthCheckCallback(
        check.sourceToken,
        check.targetToken,
        null,
        { animate: false }
    )));
    const checkRevealed = !isActorStealthed(actor) || outcomes.some(isStealthCheckFailure);
    revealed ||= checkRevealed;
  }

  if (revealed) {
    pauseGameCallback();
    return false;
  }

  if (typeof isCurrent === "function" ? !isCurrent() : !isTokenAtWaypoint(tokenDocument, event.waypoint)) return false;
  return resumeStealthInterruptedMovement(tokenDocument, movement, event, options, chainRef);
}

async function resumeStealthInterruptedMovement(
  tokenDocument,
  movement,
  event = {},
  operationOptions = {},
  chainRef = null
) {
  const waypoints = Array.isArray(event.remainingWaypoints) ? event.remainingWaypoints : [];
  if (!tokenDocument) return false;
  if (!waypoints.length) return true;
  const movementOptions = createMovementOptions(movement, operationOptions, {
    chainRef,
    split: false,
    showRuler: movement?.showRuler
  });
  return withMovementResumeContext(
    tokenDocument,
    INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION,
    { chainRef },
    () => tokenDocument.move(waypoints, {
      ...movementOptions,
      [INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION]: true
    })
  );
}

export function getOriginalMovementWaypoints(movement = {}) {
  const passed = movement.passed?.waypoints ?? [];
  const waypoints = [...passed, ...(movement.pending?.waypoints ?? [])];
  if (!waypoints.length && movement.destination) waypoints.push(movement.destination);
  const result = [];
  for (const waypoint of waypoints) {
    if (waypoint.intermediate) continue;
    appendConsecutiveWaypoint(result, waypoint);
  }
  return result;
}

function getMovementStealthPairDescriptors(tokenDocument) {
  const movingToken = tokenDocument?.object;
  if (!movingToken?.actor) return [];
  const descriptors = [];

  if (isActorStealthed(movingToken.actor)) {
    for (const observerToken of globalThis.canvas?.tokens?.placeables ?? []) {
      if (!isValidStealthObserver(movingToken, observerToken)) continue;
      descriptors.push({ mode: "hiddenMoving", hiddenToken: movingToken, observerToken });
    }
  }

  for (const hiddenToken of globalThis.canvas?.tokens?.placeables ?? []) {
    if (hiddenToken.id === movingToken.id || !isActorStealthed(hiddenToken.actor)) continue;
    if (!isValidStealthObserver(hiddenToken, movingToken)) continue;
    descriptors.push({ mode: "observerMoving", hiddenToken, observerToken: movingToken });
  }
  return descriptors;
}

function getMovementStealthPairs(tokenDocument, previous, current, descriptors = []) {
  const pairs = [];
  const previousPoint = normalizePoint(previous?.point, tokenDocument.elevation);
  const currentPoint = normalizePoint(current?.point, tokenDocument.elevation);

  for (const descriptor of descriptors) {
    if (descriptor.mode === "hiddenMoving") {
      const observerOrigin = getTokenCenter(descriptor.observerToken);
      pairs.push({
        ...descriptor,
        previous: { hiddenPoint: previousPoint, observerOrigin },
        current: { hiddenPoint: currentPoint, observerOrigin }
      });
    } else if (descriptor.mode === "observerMoving") {
      const hiddenPoint = getTokenCenter(descriptor.hiddenToken);
      pairs.push({
        ...descriptor,
        previous: { hiddenPoint, observerOrigin: previousPoint },
        current: { hiddenPoint, observerOrigin: currentPoint }
      });
    }
  }
  return pairs;
}

function createStealthMovementEvent(
  checks,
  current,
  segmentSamples,
  segmentIndex,
  routeSamples,
  routeIndex,
  routeOrder,
  movement
) {
  const serializedChecks = checks.map(({ pair, type }) => ({
    type,
    mode: pair.mode,
    hiddenTokenUuid: pair.hiddenToken.document?.uuid ?? pair.hiddenToken.uuid,
    observerTokenUuid: pair.observerToken.document?.uuid ?? pair.observerToken.uuid
  }));
  const primary = serializedChecks[0];
  return {
    type: primary.type,
    eventId: `${routeOrder}:${serializedChecks.map(check => `${check.type}:${check.hiddenTokenUuid}:${check.observerTokenUuid}`).join("|")}`,
    routeOrder,
    priority: STEALTH_DETECTION_PRIORITY,
    mode: primary.mode,
    waypoint: current.waypoint,
    hiddenTokenUuid: primary.hiddenTokenUuid,
    observerTokenUuid: primary.observerTokenUuid,
    checks: serializedChecks,
    reactorTokenUuids: [...new Set(serializedChecks.map(check => check.observerTokenUuid))],
    remainingWaypoints: buildRemainingMovementWaypoints(
      segmentSamples,
      segmentIndex,
      routeSamples,
      routeIndex,
      movement?.pending?.waypoints ?? []
    )
  };
}

function getStealthEventChecks(event = {}) {
  if (Array.isArray(event.checks) && event.checks.length) return event.checks;
  return [{
    type: event.type,
    mode: event.mode,
    hiddenTokenUuid: event.hiddenTokenUuid,
    observerTokenUuid: event.observerTokenUuid
  }];
}

function buildRemainingMovementWaypoints(
  segmentSamples = [],
  segmentIndex = 0,
  routeSamples = [],
  routeIndex = 0,
  pendingWaypoints = []
) {
  const waypoints = [
    ...segmentSamples.slice(segmentIndex + 1).map(sample => ({ ...sample?.waypoint, checkpoint: false })),
    ...routeSamples.slice(routeIndex + 1)
      .filter(sample => !sample?.waypoint?.intermediate)
      .map(sample => ({ ...sample?.waypoint })),
    ...pendingWaypoints.filter(waypoint => !waypoint?.intermediate)
  ].filter(Boolean);
  const result = [];
  for (const waypoint of waypoints) {
    appendConsecutiveWaypoint(result, waypoint);
  }
  if (result.length) result.at(-1).checkpoint = true;
  return result;
}

function appendConsecutiveWaypoint(waypoints, source = {}) {
  const waypoint = { ...source };
  if (waypoints.length && getMovementWaypointKey(waypoints.at(-1)) === getMovementWaypointKey(waypoint)) {
    waypoints[waypoints.length - 1] = waypoint;
  } else {
    waypoints.push(waypoint);
  }
}

export function getMovementWaypointKey(waypoint = {}) {
  return [
    Math.round(Number(waypoint.x) || 0),
    Math.round(Number(waypoint.y) || 0),
    getExactNumberKey(waypoint.elevation),
    Number(waypoint.width) || 0,
    Number(waypoint.height) || 0,
    Number(waypoint.depth) || 0,
    String(waypoint.shape ?? ""),
    String(waypoint.level ?? ""),
    String(waypoint.action ?? ""),
    String(Boolean(waypoint.checkpoint)),
    String(Boolean(waypoint.explicit)),
    String(Boolean(waypoint.snapped))
  ].join(":");
}

function getExactNumberKey(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "";
}

function getStealthMovementSegmentDistance(previous, current) {
  const start = previous?.point;
  const end = current?.point;
  if (!start || !end) return 0;
  const horizontal = pixelsToSceneDistance(Math.hypot(end.x - start.x, end.y - start.y));
  const vertical = Math.abs((Number(end.elevation) || 0) - (Number(start.elevation) || 0));
  return Math.hypot(horizontal, vertical);
}

export function evaluateAutoDetectionMovementThreshold(actor, settings = getRuntimeStealthSettings()) {
  const resources = actor?.system?.resources ?? {};
  const actionPointsMax = Math.max(0, Number(resources[ACTION_RESOURCE_KEY]?.max) || 0);
  const movementPointsMax = Math.max(0, Number(resources[MOVEMENT_RESOURCE_KEY]?.max) || 0);
  Object.assign(movementThresholdFormulaData.formulaVariables, {
    actionPointsMax,
    movementPointsMax,
    "ОД": actionPointsMax,
    "ОП": movementPointsMax
  });
  try {
    const base = Math.max(1, evaluateFormula(
      settings.autoDetection?.movementThresholdFormula ?? "1",
      movementThresholdFormulaData
    ));
    const percent = Number(actor?.system?.stealth?.movementThresholdPercent) || 0;
    return Math.max(1, base * Math.max(0, 1 + (percent / 100)));
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Stealth auto-detection movement threshold formula failed: ${error.message}`);
    return 1;
  }
}

function getDetectionMovementStateKey(pair) {
  return [
    globalThis.canvas?.scene?.id ?? "",
    pair.hiddenToken?.id ?? "",
    pair.observerToken?.id ?? "",
    getStealthSessionId(pair.hiddenToken?.actor)
  ].join(":");
}

function isTokenAtWaypoint(tokenDocument, waypoint = {}) {
  const source = tokenDocument?._source ?? tokenDocument ?? {};
  for (const field of ["x", "y", "elevation", "width", "height", "depth"]) {
    if (waypoint[field] === undefined) continue;
    if (Math.abs(Number(source[field]) - Number(waypoint[field])) > (field === "x" || field === "y" ? 1 : 0.000001)) {
      return false;
    }
  }
  if (waypoint.shape !== undefined && String(source.shape) !== String(waypoint.shape)) return false;
  if (waypoint.level !== undefined && String(source.level) !== String(waypoint.level)) return false;
  return true;
}

function isStealthCheckFailure(outcome) {
  if (outcome?.falloutMawRevealPrevented) return false;
  const resultKey = String(outcome?.result?.key ?? "");
  return ["failure", "criticalFailure"].includes(resultKey) || outcome?.result?.autoFailure;
}
