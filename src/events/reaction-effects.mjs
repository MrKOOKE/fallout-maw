import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_ACCUMULATION_DURATION_POLICIES,
  ABILITY_ACCUMULATION_ROUNDING_MODES,
  ABILITY_CHANGE_VALUE_SOURCES,
  getAbilityAccumulationConditions,
  getAbilityFunctionEffectDurationSeconds,
  getAbilitySourceId,
  isAccumulatingAbilityFunction,
  normalizeAbilityAccumulation
} from "../settings/abilities.mjs";
import { getAbilityEffectOriginUuid } from "../utils/ability-effect-origin.mjs";
import {
  EFFECT_LIFECYCLE_FLAG_KEY,
  EFFECT_LIFECYCLE_KINDS,
  buildEffectFunctionSnapshot
} from "../abilities/effect-lifecycle.mjs";
import {
  LIMITED_EFFECT_COPY_FLAG_KEY,
  buildLimitedEffectCopyFlag,
  isLimitedEffectCopyReservationFor,
  releaseLimitedEffectCopyReservation,
  reserveLimitedEffectCopySlot
} from "../abilities/limited-effect-copies.mjs";
import { createActorOperationLock } from "../utils/actor-operation-lock.mjs";
import {
  getAbilityAccumulatorInput,
  normalizeEffectPathSegment,
  roundEventValue
} from "./event-values.mjs";

export const EVENT_REACTION_EFFECT_FLAG_KEY = "eventReaction";
export const EVENT_REACTION_EFFECT_KIND = "eventReaction";
export const EVENT_REACTION_ACCUMULATOR_SCOPE = "accumulator";

export function createEventReactionEffectManager({
  resolveActor = defaultResolveActor,
  listActors = defaultListActors,
  getEffects = actor => Array.from(actor?.effects ?? []),
  createEffects = (actor, data, options) => actor.createEmbeddedDocuments("ActiveEffect", data, options),
  updateEffect = (effect, data, options) => effect.update(data, options),
  deleteEffects = (actor, ids, options) => actor.deleteEmbeddedDocuments("ActiveEffect", ids, options),
  prepareChanges = (_actor, changes) => changes,
  evaluateEffectCopyLimit = undefined,
  worldTime = () => Number(globalThis.game?.time?.worldTime) || 0,
  logger = console
} = {}) {
  const trackedRoots = new Map();
  const operationLock = createActorOperationLock();

  async function apply(options = {}) {
    const reactor = options.actor ?? await resolveActor(options.actorUuid);
    if (!reactor) throw new Error("Event Reaction reactor Actor is unavailable.");
    const execute = () => applyUnlocked({ ...options, reactor });
    return isAccumulatingAbilityFunction(options.abilityFunction)
      ? operationLock.run(reactor, options.chainRef, execute)
      : execute();
  }

  async function applyUnlocked({
    reactor = null,
    actor = null,
    actorUuid = "",
    sourceItem = null,
    sourceItemUuid = "",
    abilityFunction = {},
    functionId = "",
    envelope = {},
    chainRef = null,
    copyReservation = null,
    durationSeconds = null,
    changes = null
  } = {}) {
    const reactorActorUuid = String(reactor.uuid ?? actorUuid ?? "").trim();
    const itemUuid = String(sourceItem?.uuid ?? sourceItemUuid ?? "").trim();
    const id = String(abilityFunction?.id ?? functionId ?? "").trim();
    const rootId = String(envelope?.rootId ?? envelope?.eventId ?? "").trim();
    if (!reactorActorUuid || !itemUuid || !id || !rootId) {
      throw new Error("Event Reaction effect provenance is incomplete.");
    }
    const seconds = Math.max(0, Math.trunc(Number(
      durationSeconds ?? getAbilityFunctionEffectDurationSeconds(abilityFunction)
    ) || 0));
    const accumulationConditions = getAbilityAccumulationConditions(abilityFunction);
    const accumulating = accumulationConditions.length > 0;
    const operationOptions = {
      animate: false,
      falloutMawEventReactionEffect: true,
      ...(chainRef ? { chainRef } : {})
    };
    const scope = accumulating
      ? EVENT_REACTION_ACCUMULATOR_SCOPE
      : seconds > 0 ? "timed" : "root";
    const identity = { reactorActorUuid, sourceItemUuid: itemUuid, functionId: id, rootId, scope };
    const matching = getEffects(reactor).filter(effect => managedEffectMatches(effect, identity));
    const now = worldTime();
    const activeMatches = matching.filter(effect => !isEventReactionEffectExpired(effect, now));
    const existing = activeMatches[0] ?? null;
    const obsoleteIds = matching
      .filter(effect => effect !== existing)
      .map(effect => String(effect?.id ?? effect?._id ?? "").trim())
      .filter(Boolean);
    if (obsoleteIds.length) {
      await deleteEffects(reactor, obsoleteIds, {
        ...operationOptions,
        falloutMawEventReactionCleanup: true
      });
    }

    const preparedFunctionChanges = normalizeManagedChanges(await prepareChanges(
      reactor,
      changes ?? abilityFunction?.changes ?? []
    ));
    const preparedBaseChanges = preparedFunctionChanges
      .filter(change => change?.valueSource !== ABILITY_CHANGE_VALUE_SOURCES.accumulation);
    let preparedChanges = preparedBaseChanges;
    let accumulatorStates = null;
    if (accumulating) {
      const previousStates = normalizeAccumulatorStateMap(
        getEventReactionEffectFlag(existing)?.accumulators
      );
      const nextStates = { ...previousStates };
      let changed = false;
      for (const condition of accumulationConditions) {
        const input = getAbilityAccumulatorInput(condition, envelope);
        if (!input.groupKey || input.contribution <= 0) continue;
        const next = buildNextAccumulatorState(previousStates[condition.id], input, envelope);
        nextStates[condition.id] = next.state;
        changed ||= next.changed;
      }
      if (!changed) {
        if (existing?.disabled) {
          const restored = await updateEffect(existing, { disabled: false }, operationOptions);
          return restored ?? existing;
        }
        return existing;
      }
      accumulatorStates = normalizeAccumulatorStateMap(nextStates);
      preparedChanges = [
        ...preparedBaseChanges,
        ...buildAccumulatorEffectChanges(accumulatorStates, preparedFunctionChanges)
      ];
    }
    const effectCopyContext = {
      recipientActor: reactor,
      sourceActor: reactor,
      sourceItem: sourceItem ?? { uuid: itemUuid },
      abilityFunction
    };
    const effectCopyOptions = evaluateEffectCopyLimit ? { evaluateLimit: evaluateEffectCopyLimit } : {};
    let reservation = null;
    if (!existing) {
      reservation = isLimitedEffectCopyReservationFor(copyReservation, effectCopyContext)
        ? copyReservation
        : reserveLimitedEffectCopySlot(effectCopyContext, effectCopyOptions);
      if (!reservation.allowed) return null;
    }
    const effectCopyFlag = buildLimitedEffectCopyFlag(effectCopyContext, effectCopyOptions);
    const preserveDuration = accumulating
      && existing
      && accumulationConditions.every(condition => (
        normalizeAbilityAccumulation(condition?.accumulation).durationPolicy
          === ABILITY_ACCUMULATION_DURATION_POLICIES.fromFirst
      ));
    const existingFlag = getEventReactionEffectFlag(existing);
    const effectSeconds = preserveDuration
      ? Math.max(0, Math.trunc(Number(existingFlag?.durationSeconds) || 0))
      : seconds;
    const effectData = buildEventReactionEffectData({
      reactor,
      sourceItem,
      itemUuid,
      originUuid: getAbilityEffectOriginUuid(reactor, sourceItem, itemUuid),
      abilityFunction,
      functionId: id,
      envelope,
      durationSeconds: effectSeconds,
      changes: preparedChanges,
      worldTime: now,
      effectCopyFlag,
      scope,
      accumulators: accumulatorStates
    });

    let effect;
    try {
      if (existing) {
        effect = await updateEffect(existing, buildEventReactionEffectUpdate(effectData, {
          preserveDuration
        }), operationOptions);
        effect ??= existing;
      } else {
        const created = await createEffects(reactor, [effectData], operationOptions);
        effect = Array.isArray(created) ? created[0] : created;
      }
      if (!effect) throw new Error("Event Reaction ActiveEffect was not created.");
      if (scope === "root") trackRootEffect(rootId, reactorActorUuid, effect);
      return effect;
    } finally {
      releaseLimitedEffectCopyReservation(reservation);
    }
  }

  async function cleanupRoot(rootId = "") {
    const id = String(rootId ?? "").trim();
    if (!id) return 0;
    const tracked = trackedRoots.get(id);
    if (!tracked) return 0;

    let deleted = 0;
    try {
      for (const [actorUuid, trackedEffectIds] of tracked) {
        let actor;
        try {
          actor = await resolveActor(actorUuid);
        } catch (error) {
          logger?.error?.(`fallout-maw | Failed to resolve Event Reaction actor '${actorUuid}'.`, error);
          continue;
        }
        if (!actor) continue;
        const ids = getEffects(actor)
          .filter(effect => {
            const effectId = String(effect?.id ?? effect?._id ?? "").trim();
            const flag = getEventReactionEffectFlag(effect);
            return trackedEffectIds.has(effectId)
              && flag?.scope === "root"
              && flag.rootId === id;
          })
          .map(effect => String(effect?.id ?? effect?._id ?? ""))
          .filter(Boolean);
        if (!ids.length) continue;
        try {
          await deleteEffects(actor, ids, { animate: false, falloutMawEventReactionCleanup: true });
          deleted += ids.length;
        } catch (error) {
          logger?.error?.(`fallout-maw | Failed to clean Event Reaction root '${id}'.`, error);
        }
      }
      return deleted;
    } finally {
      trackedRoots.delete(id);
    }
  }

  async function cleanupOrphans(activeRootIds = []) {
    const active = new Set(Array.from(activeRootIds ?? []).map(value => String(value ?? "").trim()).filter(Boolean));
    const orphanRoots = new Set();
    for (const actor of await listActors()) {
      for (const effect of getEffects(actor)) {
        const flag = getEventReactionEffectFlag(effect);
        if (flag?.scope !== "root" || !flag.rootId) continue;
        trackRootEffect(flag.rootId, actor?.uuid, effect);
        if (!active.has(flag.rootId)) orphanRoots.add(flag.rootId);
      }
    }
    let deleted = 0;
    for (const rootId of orphanRoots) deleted += await cleanupRoot(rootId);
    return deleted;
  }

  function trackRootEffect(rootId, actorUuid, effect) {
    const normalizedRootId = String(rootId ?? "").trim();
    const normalizedActorUuid = String(actorUuid ?? "").trim();
    const effectId = String(effect?.id ?? effect?._id ?? "").trim();
    if (!normalizedRootId || !normalizedActorUuid || !effectId) return;
    const actors = trackedRoots.get(normalizedRootId) ?? new Map();
    const ids = actors.get(normalizedActorUuid) ?? new Set();
    ids.add(effectId);
    actors.set(normalizedActorUuid, ids);
    trackedRoots.set(normalizedRootId, actors);
  }

  return Object.freeze({
    apply,
    cleanupRoot,
    cleanupOrphans,
    getTrackedRootIds: () => Array.from(trackedRoots.keys())
  });
}

export function buildEventReactionEffectData({
  reactor = null,
  sourceItem = null,
  itemUuid = "",
  originUuid = "",
  abilityFunction = {},
  functionId = "",
  envelope = {},
  durationSeconds = 0,
  changes = [],
  worldTime = 0,
  effectCopyFlag = null,
  scope = "",
  accumulators = null
} = {}) {
  const seconds = Math.max(0, Math.trunc(Number(durationSeconds) || 0));
  const rootId = String(envelope?.rootId ?? envelope?.eventId ?? "").trim();
  const sourceItemUuid = String(sourceItem?.uuid ?? itemUuid ?? "").trim();
  const effectOriginUuid = String(originUuid || getAbilityEffectOriginUuid(reactor, sourceItem, sourceItemUuid));
  const id = String(abilityFunction?.id ?? functionId ?? "").trim();
  const functionData = buildEffectFunctionSnapshot({ ...abilityFunction, id });
  const effectScope = String(scope ?? "").trim() || (seconds > 0 ? "timed" : "root");
  const flag = {
    rootId,
    eventId: String(envelope?.eventId ?? ""),
    eventKey: String(envelope?.key ?? ""),
    sourceItemUuid,
    abilitySourceId: getAbilitySourceId(sourceItem),
    functionId: id,
    functionData,
    reactorActorUuid: String(reactor?.uuid ?? ""),
    scope: effectScope,
    durationSeconds: seconds,
    ...(effectScope === EVENT_REACTION_ACCUMULATOR_SCOPE && accumulators ? {
      accumulators: normalizeAccumulatorStateMap(accumulators)
    } : {})
  };
  const data = {
    type: "base",
    name: String(sourceItem?.name ?? "Event Reaction"),
    img: String(sourceItem?.img ?? "icons/svg/aura.svg"),
    origin: effectOriginUuid,
    transfer: false,
    disabled: false,
    showIcon: 2,
    system: { changes: normalizeManagedChanges(changes) },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [EFFECT_LIFECYCLE_FLAG_KEY]: {
          kind: EFFECT_LIFECYCLE_KINDS.disposableInstance
        },
        [EVENT_REACTION_EFFECT_FLAG_KEY]: flag,
        ...(effectCopyFlag ? {
          [LIMITED_EFFECT_COPY_FLAG_KEY]: effectCopyFlag
        } : {})
      }
    }
  };
  if (seconds > 0) {
    data.start = { time: Math.trunc(Number(worldTime) || 0) };
    data.duration = { value: seconds, units: "seconds", expiry: null, expired: false };
  } else {
    data.duration = { value: null, units: "seconds", expiry: null, expired: false };
  }
  return data;
}

export function getEventReactionEffectFlag(effect = null) {
  return effect?.getFlag?.(SYSTEM_ID, EVENT_REACTION_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[EVENT_REACTION_EFFECT_FLAG_KEY]
    ?? null;
}

export function hasEventReactionEffectInstance({
  actor = null,
  sourceItem = null,
  abilityFunction = null,
  envelope = {},
  worldTime = Number(globalThis.game?.time?.worldTime) || 0
} = {}) {
  const accumulating = isAccumulatingAbilityFunction(abilityFunction);
  const durationSeconds = Math.max(0, Math.trunc(Number(
    getAbilityFunctionEffectDurationSeconds(abilityFunction)
  ) || 0));
  const identity = {
    reactorActorUuid: String(actor?.uuid ?? "").trim(),
    sourceItemUuid: String(sourceItem?.uuid ?? "").trim(),
    functionId: String(abilityFunction?.id ?? "").trim(),
    rootId: String(envelope?.rootId ?? envelope?.eventId ?? "").trim(),
    scope: accumulating
      ? EVENT_REACTION_ACCUMULATOR_SCOPE
      : durationSeconds > 0 ? "timed" : "root"
  };
  if (Object.values(identity).some(value => !value)) return false;
  return Array.from(actor?.effects ?? [])
    .some(effect => managedEffectMatches(effect, identity) && !isEventReactionEffectExpired(effect, worldTime));
}

export function isEventReactionManagedEffect(effect = null) {
  return Boolean(getEventReactionEffectFlag(effect));
}

function managedEffectMatches(effect, identity) {
  const flag = getEventReactionEffectFlag(effect);
  if (!flag || flag.scope !== identity.scope) return false;
  if (flag.reactorActorUuid !== identity.reactorActorUuid) return false;
  if (flag.sourceItemUuid !== identity.sourceItemUuid || flag.functionId !== identity.functionId) return false;
  return identity.scope === EVENT_REACTION_ACCUMULATOR_SCOPE
    || flag.rootId === identity.rootId;
}

function buildEventReactionEffectUpdate(data, { preserveDuration = false } = {}) {
  return {
    name: data.name,
    img: data.img,
    origin: data.origin,
    transfer: false,
    disabled: false,
    showIcon: data.showIcon,
    system: data.system,
    flags: data.flags,
    ...(!preserveDuration && data.start ? { start: data.start } : {}),
    ...(!preserveDuration ? { duration: data.duration } : {})
  };
}

export function hasAbilityFunctionEventEffectOutput(abilityFunction = {}) {
  if (isAccumulatingAbilityFunction(abilityFunction)) return true;
  return (abilityFunction?.changes ?? [])
    .some(change => String(change?.key ?? "").trim() && String(change?.value ?? "") !== "");
}

export function canAccumulateEventReactionEffect({
  actor = null,
  sourceItem = null,
  abilityFunction = null,
  envelope = {},
  worldTime = Number(globalThis.game?.time?.worldTime) || 0
} = {}) {
  const conditions = getAbilityAccumulationConditions(abilityFunction);
  if (!conditions.length) return true;
  const identity = {
    reactorActorUuid: String(actor?.uuid ?? "").trim(),
    sourceItemUuid: String(sourceItem?.uuid ?? "").trim(),
    functionId: String(abilityFunction?.id ?? "").trim(),
    rootId: String(envelope?.rootId ?? envelope?.eventId ?? "").trim(),
    scope: EVENT_REACTION_ACCUMULATOR_SCOPE
  };
  const existing = Array.from(actor?.effects ?? [])
    .find(effect => managedEffectMatches(effect, identity) && !isEventReactionEffectExpired(effect, worldTime));
  if (existing?.disabled) return true;
  const states = normalizeAccumulatorStateMap(getEventReactionEffectFlag(existing)?.accumulators);
  return conditions.some(condition => {
    const input = getAbilityAccumulatorInput(condition, envelope);
    if (!input.groupKey || input.contribution <= 0) return false;
    if (!existing) return true;
    const settings = normalizeAbilityAccumulation(condition?.accumulation);
    const state = normalizeAccumulatorState(states[condition.id]);
    if (settings.totalCap > 0 && state.total >= settings.totalCap) return false;
    if (settings.bucketCap > 0 && Number(state.buckets?.[input.groupKey]) >= settings.bucketCap) return false;
    return true;
  });
}

export function buildNextAccumulatorState(previousState = {}, input = {}, envelope = {}) {
  const settings = normalizeAbilityAccumulation(input?.settings);
  const previous = normalizeAccumulatorState(previousState);
  const groupKey = normalizeEffectPathSegment(input?.groupKey);
  const contribution = Math.max(0, roundEventValue(input?.contribution));
  const eventId = String(envelope?.eventId ?? "").trim();
  if (!groupKey || contribution <= 0 || (eventId && previous.recentEventIds.includes(eventId))) {
    return { changed: false, state: previous };
  }

  const rawBuckets = { ...previous.rawBuckets };
  const currentRaw = Math.max(0, Number(rawBuckets[groupKey]) || 0);
  const currentBuckets = materializeAccumulatorBuckets(rawBuckets, settings);
  const currentValue = Math.max(0, Number(currentBuckets[groupKey]) || 0);
  const currentOtherTotal = Object.entries(currentBuckets)
    .filter(([key]) => key !== groupKey)
    .reduce((total, [, value]) => total + Math.max(0, Number(value) || 0), 0);
  const desiredRaw = roundEventValue(currentRaw + contribution);
  const desiredValue = materializeAccumulatorValue(desiredRaw, settings.rounding);
  const sharedMaximum = settings.totalCap > 0
    ? Math.max(0, settings.totalCap - currentOtherTotal)
    : Number.POSITIVE_INFINITY;
  const bucketMaximum = settings.bucketCap > 0
    ? settings.bucketCap
    : Number.POSITIVE_INFINITY;
  const acceptedValue = Math.max(0, Math.min(desiredValue, sharedMaximum, bucketMaximum));
  if (acceptedValue <= currentValue && desiredValue > currentValue) {
    return { changed: false, state: previous };
  }

  rawBuckets[groupKey] = acceptedValue < desiredValue
    ? rawValueForMaterializedAccumulatorValue(acceptedValue)
    : desiredRaw;
  const buckets = materializeAccumulatorBuckets(rawBuckets, settings);
  const total = Object.values(buckets).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  const recentEventIds = eventId
    ? [...previous.recentEventIds.filter(id => id !== eventId), eventId].slice(-64)
    : previous.recentEventIds;
  return {
    changed: rawBuckets[groupKey] !== currentRaw || recentEventIds.length !== previous.recentEventIds.length,
    state: normalizeAccumulatorState({
      version: 1,
      valueSource: settings.valueSource,
      percent: settings.percent,
      groupBy: settings.groupBy,
      totalCap: settings.totalCap,
      bucketCap: settings.bucketCap,
      rounding: settings.rounding,
      rawBuckets,
      buckets,
      total,
      lastEventId: eventId,
      recentEventIds
    })
  };
}

export function buildAccumulatorEffectChanges(states = {}, changes = []) {
  const accumulatorStates = normalizeAccumulatorStateMap(states);
  const output = [];
  for (const change of Array.isArray(changes) ? changes : Object.values(changes ?? {})) {
    if (change?.valueSource !== ABILITY_CHANGE_VALUE_SOURCES.accumulation) continue;
    const conditionId = String(change?.accumulatorExchange?.conditionId ?? "").trim();
    const keyTemplate = String(change?.key ?? "").trim();
    const rate = Number(change?.value);
    const state = accumulatorStates[conditionId];
    if (!conditionId || !keyTemplate || !state || !Number.isFinite(rate) || rate === 0) continue;
    if (keyTemplate.includes("{group}")) {
      for (const [rawGroupKey, points] of Object.entries(state.buckets)) {
        const groupKey = normalizeEffectPathSegment(rawGroupKey);
        const value = roundEventValue((Number(points) || 0) * rate);
        if (!groupKey || value === 0) continue;
        output.push(buildAccumulatorChange(change, keyTemplate.replaceAll("{group}", groupKey), value));
      }
      continue;
    }
    const value = roundEventValue((Number(state.total) || 0) * rate);
    if (value !== 0) output.push(buildAccumulatorChange(change, keyTemplate, value));
  }
  return output.sort((left, right) => (
    String(left.key).localeCompare(String(right.key))
      || Number(left.priority ?? 0) - Number(right.priority ?? 0)
  ));
}

export function isEventReactionEffectExpired(effect = null, worldTime = 0) {
  if (!effect) return false;
  if (effect.isExpired === true || effect?.duration?.expired === true) return true;
  const flag = getEventReactionEffectFlag(effect);
  const seconds = Math.max(0, Number(flag?.durationSeconds) || 0);
  if (!seconds) return false;
  const start = Number(
    effect?.start?.time
    ?? effect?._source?.start?.time
    ?? effect?.duration?.startTime
    ?? effect?._source?.duration?.startTime
  );
  return Number.isFinite(start) && Number(worldTime) >= start + seconds;
}

function normalizeAccumulatorState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawBuckets = normalizeAccumulatorBuckets(source.rawBuckets ?? source.buckets, { decimals: true });
  const buckets = normalizeAccumulatorBuckets(source.buckets);
  const normalizedBuckets = Object.keys(buckets).length
    ? buckets
    : materializeAccumulatorBuckets(rawBuckets, source);
  return {
    version: Math.max(1, Math.trunc(Number(source.version) || 1)),
    valueSource: String(source.valueSource ?? ""),
    percent: Math.max(0, Number(source.percent) || 0),
    groupBy: String(source.groupBy ?? ""),
    totalCap: Math.max(0, Math.trunc(Number(source.totalCap) || 0)),
    bucketCap: Math.max(0, Math.trunc(Number(source.bucketCap) || 0)),
    rounding: String(source.rounding ?? ""),
    rawBuckets,
    buckets: normalizedBuckets,
    total: Object.values(normalizedBuckets)
      .reduce((sum, entry) => sum + Math.max(0, Math.trunc(Number(entry) || 0)), 0),
    lastEventId: String(source.lastEventId ?? ""),
    recentEventIds: normalizeRecentEventIds(source)
  };
}

function normalizeAccumulatorStateMap(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([rawConditionId, state]) => [String(rawConditionId ?? "").trim(), normalizeAccumulatorState(state)])
    .filter(([conditionId]) => Boolean(conditionId)));
}

function normalizeAccumulatorBuckets(value = {}, { decimals = false } = {}) {
  const buckets = {};
  for (const [rawKey, rawValue] of Object.entries(value && typeof value === "object" ? value : {})) {
    const key = normalizeEffectPathSegment(rawKey);
    const numeric = Math.max(0, Number(rawValue) || 0);
    if (!key || numeric <= 0) continue;
    buckets[key] = decimals ? roundEventValue(numeric) : Math.trunc(numeric);
  }
  return buckets;
}

function materializeAccumulatorBuckets(rawBuckets = {}, settings = {}) {
  const normalizedSettings = normalizeAbilityAccumulation(settings);
  return Object.fromEntries(Object.entries(normalizeAccumulatorBuckets(rawBuckets, { decimals: true }))
    .map(([key, value]) => [key, materializeAccumulatorValue(value, normalizedSettings.rounding)])
    .filter(([, value]) => value > 0));
}

function materializeAccumulatorValue(value, rounding) {
  const numeric = Math.max(0, Number(value) || 0);
  if (rounding === ABILITY_ACCUMULATION_ROUNDING_MODES.ceilTotal) return Math.ceil(numeric);
  if (rounding === ABILITY_ACCUMULATION_ROUNDING_MODES.roundTotal) return Math.round(numeric);
  return Math.floor(numeric);
}

function rawValueForMaterializedAccumulatorValue(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function buildAccumulatorChange(change = {}, key = "", value = 0) {
  return {
    key,
    type: String(change?.type ?? "add"),
    value: String(value),
    phase: String(change?.phase ?? "initial"),
    priority: change?.priority === null || change?.priority === undefined
      ? 0
      : Number(change.priority) || 0
  };
}

function normalizeRecentEventIds(state = {}) {
  const values = Array.from(new Set((Array.isArray(state?.recentEventIds)
    ? state.recentEventIds
    : Object.values(state?.recentEventIds ?? {}))
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
  const legacy = String(state?.lastEventId ?? "").trim();
  if (legacy && !values.includes(legacy)) values.push(legacy);
  return values.slice(-64);
}

function normalizeManagedChanges(changes = []) {
  return (Array.isArray(changes) ? changes : Object.values(changes ?? {}))
    .filter(change => String(change?.key ?? "").trim() && String(change?.value ?? "") !== "")
    .map(change => ({ ...change }));
}

function defaultResolveActor(uuid) {
  return globalThis.fromUuid?.(uuid) ?? null;
}

function defaultListActors() {
  const actors = new Map();
  for (const actor of globalThis.game?.actors ?? []) {
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }
  for (const scene of globalThis.game?.scenes ?? []) {
    for (const token of scene?.tokens?.contents ?? scene?.tokens ?? []) {
      if (token?.actor?.uuid) actors.set(token.actor.uuid, token.actor);
    }
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token?.actor?.uuid) actors.set(token.actor.uuid, token.actor);
  }
  return Array.from(actors.values());
}
