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
import {
  getSmokeRegionIndex,
  getSmokeRegionsInBounds
} from "../canvas/smoke-vision.mjs";
import {
  createStealthDetectionPointTester,
  isPointInsideObserverZone
} from "./detection.mjs";
import { isValidStealthObserver } from "./observers.mjs";
import {
  evaluateStealthDetectionRange,
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
let hasStealthedCanvasTokensCallback = null;
let providerRegistered = false;

export function registerStealthMovementProvider({
  rollStealthCheck,
  rollStealthChecks,
  pauseGame,
  hasStealthedCanvasTokens
} = {}) {
  if (typeof rollStealthCheck === "function") rollStealthCheckCallback = rollStealthCheck;
  if (typeof rollStealthChecks === "function") rollStealthChecksCallback = rollStealthChecks;
  if (typeof pauseGame === "function") pauseGameCallback = pauseGame;
  if (typeof hasStealthedCanvasTokens === "function") {
    hasStealthedCanvasTokensCallback = hasStealthedCanvasTokens;
  }
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
  if (!tokenDocument?.actor || !movement || !globalThis.canvas?.ready) {
    return createEmptyMovementCollection();
  }
  // The overwhelmingly common move has no hidden participant. The controller
  // maintains this scene-local bit so preMoveToken avoids scanning every token.
  if (
    !isActorStealthed(tokenDocument.actor)
    && hasStealthedCanvasTokensCallback?.() === false
  ) return createEmptyMovementCollection();

  const settings = getRuntimeStealthSettings();
  if (!settings.autoDetection?.enabled) return createEmptyMovementCollection();

  const samples = getMovementRouteSamples(tokenDocument, movement);
  if (samples.length < 2) return createEmptyMovementCollection();
  const pairDescriptors = getMovementStealthPairDescriptors(tokenDocument);
  if (!pairDescriptors.length) return createEmptyMovementCollection();
  const pointTesters = [];
  const hiddenMovingDescriptors = pairDescriptors.filter(descriptor => descriptor.mode === "hiddenMoving");
  const hasVisionSmoke = getSmokeRegionIndex(globalThis.canvas?.scene)?.hasVisionSmoke === true;
  const hiddenObserverBaseRanges = new Map();
  const hiddenSmokeConstraints = new Map();
  for (const descriptor of hiddenMovingDescriptors) {
    const baseRange = evaluateStealthDetectionRange(descriptor.observerToken.actor, settings);
    hiddenObserverBaseRanges.set(descriptor, baseRange);
    if (!hasVisionSmoke || !(baseRange > 0)) continue;
    const constraint = getNativeObserverSmokeConstraint(descriptor.observerToken);
    if (hasObserverSmokeConstraintCandidates(descriptor.observerToken, constraint)) {
      hiddenSmokeConstraints.set(descriptor, constraint);
    }
  }
  const hiddenMovementPoints = hiddenSmokeConstraints.size
    ? collectUniqueStealthMovementPoints(tokenDocument, samples)
    : [];
  const hasObserverMovingDescriptors = pairDescriptors.some(descriptor => descriptor.mode === "observerMoving");
  const movingObserverBaseRange = hasObserverMovingDescriptors
    ? evaluateStealthDetectionRange(tokenDocument.actor, settings)
    : 0;
  for (const descriptor of pairDescriptors) {
    if (descriptor.mode !== "hiddenMoving") continue;
    const observerBaseRange = hiddenObserverBaseRanges.get(descriptor) ?? 0;
    const smokeConstraint = hiddenSmokeConstraints.get(descriptor);
    const expectedHiddenPointTests = smokeConstraint
      ? countPotentialObserverVisionPointTests(
        descriptor.observerOrigin,
        hiddenMovementPoints,
        observerBaseRange
      )
      : 0;
    descriptor.pointTester = createStealthDetectionPointTester(
      descriptor.observerToken,
      descriptor.observerOrigin,
      {
        settings,
        preparedBaseRange: observerBaseRange,
        skipObserverValidation: true,
        pointOnlySmokeVision: Boolean(smokeConstraint) && shouldUsePointOnlySmokeVisionForMovement(
          descriptor.observerToken,
          expectedHiddenPointTests,
          smokeConstraint
        )
      }
    );
    pointTesters.push(descriptor.pointTester);
  }
  const movingObserverTester = hasObserverMovingDescriptors
    ? createStealthDetectionPointTester(tokenDocument.object, samples[0]?.point, {
      settings,
      preparedBaseRange: movingObserverBaseRange,
      skipObserverValidation: true,
      pointOnlySmokeVision: hasVisionSmoke
    })
    : null;
  if (movingObserverTester) pointTesters.push(movingObserverTester);
  const movementStateFlagCache = new Map();
  try {
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
      if (!stateBaselines.has(key)) {
        stateBaselines.set(key, readPersistentPairState(pair, key, movementStateFlagCache));
      }
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

    if (movingObserverTester) {
      for (const descriptor of pairDescriptors) {
        if (descriptor.mode !== "observerMoving") continue;
        routeInsideState.set(
          descriptor.stateKey,
          testMovementDescriptorPoint(descriptor, samples[0].point, settings, movingObserverTester)
        );
      }
    }

    for (let index = 1; index < samples.length; index += 1) {
      const segmentSamples = getMovementSegmentSamples(tokenDocument, samples[index - 1], samples[index]);
      for (let segmentIndex = 1; segmentIndex < segmentSamples.length; segmentIndex += 1) {
        routeOrder += 1;
        const previous = segmentSamples[segmentIndex - 1];
        const current = segmentSamples[segmentIndex];
        const previousPoint = normalizePoint(previous?.point, tokenDocument.elevation);
        const currentPoint = normalizePoint(current?.point, tokenDocument.elevation);
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
        movingObserverTester?.setOrigin(currentPoint);
        for (const descriptor of pairDescriptors) {
          const stateKey = descriptor.stateKey;
          const wasInside = routeInsideState.has(stateKey)
            ? routeInsideState.get(stateKey)
            : testMovementDescriptorPoint(descriptor, previousPoint, settings);
          const isInside = testMovementDescriptorPoint(descriptor, currentPoint, settings, movingObserverTester);
          routeInsideState.set(stateKey, isInside);
          const hadState = hasState(stateKey, descriptor);

          if (!isInside) {
            if (hadState) writeState(stateKey, null, current.waypoint);
            continue;
          }

          if (!wasInside && !hadState) {
            writeState(stateKey, 0, current.waypoint);
            triggeredChecks.push({ pair: descriptor, type: "enter" });
            continue;
          }

          const accumulated = Math.max(0, Number(readState(stateKey, descriptor)) || 0) + movementCost;
          if (accumulated >= movementThreshold) {
            writeState(stateKey, accumulated % movementThreshold, current.waypoint);
            triggeredChecks.push({ pair: descriptor, type: "inside" });
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
  } finally {
    for (const tester of pointTesters) tester.destroy();
  }
}

/**
 * Choose the cheaper native smoke mask for a fixed observer along one route.
 * A point-only source pays one directed smoke trace per unique target point;
 * a radial source pays at least Foundry's regular-circle vertex density once.
 * Region and light topology only add radial traces, so switching strictly
 * above this native lower bound conservatively favors short, common moves.
 */
export function shouldUsePointOnlySmokeVisionForMovement(
  observerToken,
  expectedPointTests,
  preparedConstraint = null
) {
  const pointTests = Math.max(0, Math.floor(Number(expectedPointTests) || 0));
  if (!pointTests) return true;
  const constraint = preparedConstraint ?? getNativeObserverSmokeConstraint(observerToken);
  return pointTests <= getNativeSmokeConstraintDensity(constraint);
}

function collectUniqueStealthMovementPoints(tokenDocument, routeSamples) {
  const points = new Map();
  for (let index = 1; index < routeSamples.length; index += 1) {
    const segmentSamples = getMovementSegmentSamples(
      tokenDocument,
      routeSamples[index - 1],
      routeSamples[index]
    );
    for (const sample of segmentSamples) {
      if (!sample?.point) continue;
      const point = normalizeStealthDetectionTargetPoint(sample.point, tokenDocument?.elevation);
      points.set(`${point.x}:${point.y}:${point.elevation}`, point);
    }
  }
  return [...points.values()];
}

function countPotentialObserverVisionPointTests(origin, points, baseRange) {
  const normalizedOrigin = normalizePoint(origin);
  const normalizedBaseRange = Math.max(0, Number(baseRange) || 0);
  if (!(normalizedBaseRange > 0)) return 0;
  const maximumRange = normalizedBaseRange
    + pixelsToSceneDistance(Number(globalThis.canvas?.grid?.size) || 0);
  let count = 0;
  for (const point of points) {
    const horizontal = pixelsToSceneDistance(Math.hypot(
      point.x - normalizedOrigin.x,
      point.y - normalizedOrigin.y
    ));
    const vertical = Math.abs(point.elevation - normalizedOrigin.elevation);
    if (Math.hypot(horizontal, vertical) <= maximumRange + 1e-6) count += 1;
  }
  return count;
}

function normalizeStealthDetectionTargetPoint(point, elevation) {
  let normalized = normalizePoint(point, elevation);
  const grid = globalThis.canvas?.grid;
  if (
    !grid?.isGridless
    && typeof grid?.getOffset === "function"
    && typeof grid?.getCenterPoint === "function"
  ) {
    normalized = normalizePoint(grid.getCenterPoint(grid.getOffset(normalized)), normalized.elevation);
  }
  return normalized;
}

function getNativeObserverSmokeConstraint(observerToken) {
  const sourceData = observerToken?._getVisionSourceData?.();
  if (!sourceData || typeof sourceData !== "object") {
    throw new Error("A native Token vision source data contract is required for smoke movement analysis");
  }
  const maximumRadius = Number(globalThis.canvas?.dimensions?.maxR);
  const rawLightRadius = sourceData?.lightRadius ?? maximumRadius;
  const numericSightRadius = Number(sourceData?.radius);
  const rawSightRadius = numericSightRadius > 0
    ? numericSightRadius
    : sourceData?.externalRadius;
  let radius = Math.max(
    0,
    Number(rawLightRadius) || 0,
    Number(rawSightRadius) || 0
  );
  if (!Number.isFinite(radius)) radius = maximumRadius;
  return {
    sourceData,
    radius: Number.isFinite(radius) && radius > 0 ? radius : 0,
    density: null
  };
}

function getNativeSmokeConstraintDensity(constraint) {
  if (constraint.density !== null) return constraint.density;
  if (!(constraint.radius > 0)) return constraint.density = 0;
  const nativeDensity = globalThis.PIXI?.Circle?.approximateVertexDensity;
  if (typeof nativeDensity !== "function") {
    throw new Error("PIXI.Circle.approximateVertexDensity is required for smoke movement analysis");
  }
  const density = Number(nativeDensity.call(globalThis.PIXI.Circle, constraint.radius));
  if (!(Number.isFinite(density) && density > 0)) {
    throw new Error("PIXI.Circle.approximateVertexDensity returned an invalid smoke trace density");
  }
  return constraint.density = Math.max(3, Math.ceil(density));
}

function hasObserverSmokeConstraintCandidates(observerToken, constraint) {
  const { sourceData, radius } = constraint;
  if (!(radius > 0)) return false;
  return getSmokeRegionsInBounds({
    x: Number(sourceData.x) - radius,
    y: Number(sourceData.y) - radius,
    width: radius * 2,
    height: radius * 2
  }, {
    elevation: sourceData.elevation,
    targetActor: observerToken?.actor ?? null
  }).length > 0;
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
      sessionId: baseline.pair.sessionId ?? getStealthSessionId(baseline.pair.hiddenToken?.actor),
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

/**
 * Seed the ordinary per-observer movement state after an instantaneous
 * relocation. This skips only the entry check: later movement continues from
 * the existing accumulator, or zero for a newly entered zone, through the
 * regular interruption provider.
 */
export async function synchronizeStealthMovementStateAfterRelocation(
  tokenDocument,
  { skipEntryDetection = false } = {}
) {
  const hiddenToken = tokenDocument?.object;
  if (!skipEntryDetection || !hiddenToken?.actor || !isActorStealthed(hiddenToken.actor)) return false;

  const settings = getRuntimeStealthSettings();
  if (!settings.autoDetection?.enabled || !globalThis.canvas?.ready) return false;
  const descriptors = getMovementStealthPairDescriptors(tokenDocument)
    .filter(descriptor => descriptor.mode === "hiddenMoving");
  if (!descriptors.length) return false;

  const stateUpdates = new Map();
  const stateBaselines = new Map();
  const movementStateFlagCache = new Map();
  for (const descriptor of descriptors) {
    const hiddenPoint = getTokenCenter(descriptor.hiddenToken);
    const observerOrigin = getTokenCenter(descriptor.observerToken);
    const key = descriptor.stateKey;
    const baseline = readPersistentPairState(descriptor, key, movementStateFlagCache);
    stateBaselines.set(key, baseline);
    const isInside = isPointInsideObserverZone(hiddenPoint, descriptor.observerToken, observerOrigin, settings);
    stateUpdates.set(
      key,
      isInside ? (baseline.value ?? 0) : null
    );
  }

  await commitStealthMovementCollection({
    tokenDocument,
    collection: { stateUpdates, stateBaselines, stateTransitions: [] },
    selectedEvent: null
  });
  return true;
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

function readPersistentPairState(pair, key, flagCache = null) {
  const candidates = [pair.hiddenToken?.document, pair.observerToken?.document]
    .filter(Boolean)
    .flatMap((document, sourceIndex) => getCachedMovementStateEntries(document, sourceIndex, flagCache))
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

function getCachedMovementStateEntries(document, sourceIndex, flagCache) {
  const cached = flagCache?.get(document);
  if (cached) return cached;
  const entries = normalizeMovementStateFlag(readMovementStateFlag(document)).entries.map(entry => ({
    ...entry,
    _sourceKey: String(document.uuid ?? sourceIndex)
  }));
  flagCache?.set(document, entries);
  return entries;
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
      descriptors.push(createMovementPairDescriptor("hiddenMoving", movingToken, observerToken));
    }
  }

  for (const hiddenToken of globalThis.canvas?.tokens?.placeables ?? []) {
    if (hiddenToken.id === movingToken.id || !isActorStealthed(hiddenToken.actor)) continue;
    if (!isValidStealthObserver(hiddenToken, movingToken)) continue;
    descriptors.push(createMovementPairDescriptor("observerMoving", hiddenToken, movingToken));
  }
  return descriptors;
}

function createMovementPairDescriptor(mode, hiddenToken, observerToken) {
  const sessionId = getStealthSessionId(hiddenToken?.actor);
  return {
    mode,
    hiddenToken,
    observerToken,
    sessionId,
    stateKey: [
      globalThis.canvas?.scene?.id ?? "",
      hiddenToken?.id ?? "",
      observerToken?.id ?? "",
      sessionId
    ].join(":"),
    hiddenPoint: mode === "observerMoving" ? getTokenCenter(hiddenToken) : null,
    observerOrigin: mode === "hiddenMoving" ? getTokenCenter(observerToken) : null,
    pointTester: null
  };
}

function testMovementDescriptorPoint(descriptor, movingPoint, settings, observerMovingTester = null) {
  if (descriptor.mode === "hiddenMoving" && descriptor.pointTester) {
    return descriptor.pointTester.test(movingPoint);
  }
  if (descriptor.mode === "observerMoving" && observerMovingTester) {
    return observerMovingTester.test(descriptor.hiddenPoint);
  }
  return isPointInsideObserverZone(
    descriptor.mode === "hiddenMoving" ? movingPoint : descriptor.hiddenPoint,
    descriptor.observerToken,
    descriptor.mode === "hiddenMoving" ? descriptor.observerOrigin : movingPoint,
    settings
  );
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
