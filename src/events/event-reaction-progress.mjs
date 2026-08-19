import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizeEventReactionProgressRequired
} from "../settings/abilities.mjs";
import {
  getSystemEventNumericValue
} from "./event-values.mjs";

export { normalizeEventReactionProgressRequired } from "../settings/abilities.mjs";

export const EVENT_REACTION_PROGRESS_FLAG_KEY = "eventReactionProgress";
export const EVENT_REACTION_PROGRESS_HISTORY_LIMIT = 64;

const PROGRESS_LABELS = Object.freeze({
  "fallout-maw.research.progressed": ["FALLOUTMAW.Events.Reaction.Progress.Research", "Research progress"],
  "fallout-maw.damage.resolved": ["FALLOUTMAW.Events.Reaction.Progress.Damage", "Damage received"],
  "fallout-maw.healing.resolved": ["FALLOUTMAW.Events.Reaction.Progress.Healing", "Health restored"],
  "fallout-maw.combat.resource.spent": ["FALLOUTMAW.Events.Reaction.Progress.ResourceSpent", "Resource spent"],
  "fallout-maw.world.time.advanced": ["FALLOUTMAW.Events.Reaction.Progress.WorldTime", "Elapsed time (seconds)"],
  "fallout-maw.travel.movement.completed": ["FALLOUTMAW.Events.Reaction.Progress.TravelDistance", "Distance travelled (km)"],
  "fallout-maw.actor.need.thresholdEntered": ["FALLOUTMAW.Events.Reaction.Progress.NeedPercent", "Need change (%)"],
  "fallout-maw.actor.need.thresholdLeft": ["FALLOUTMAW.Events.Reaction.Progress.NeedPercent", "Need change (%)"]
});

/** Whether this event carries a meaningful numeric amount that can accumulate. */
export function isEventReactionProgressTracked(eventKey = "") {
  return Object.hasOwn(PROGRESS_LABELS, String(eventKey ?? "").trim());
}

export function getEventReactionProgressKey({
  abilityFunction = null,
  functionId = "",
  condition = null,
  conditionId = ""
} = {}) {
  const resolvedFunctionId = String(functionId || abilityFunction?.id || "").trim();
  const resolvedConditionId = String(conditionId || condition?.id || "").trim();
  return resolvedFunctionId && resolvedConditionId
    ? `${resolvedFunctionId}_${resolvedConditionId}`
    : "";
}

export function getEventReactionProgressState(item = null) {
  const state = item?.getFlag?.(SYSTEM_ID, EVENT_REACTION_PROGRESS_FLAG_KEY)
    ?? item?.flags?.[SYSTEM_ID]?.[EVENT_REACTION_PROGRESS_FLAG_KEY]
    ?? {};
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

export function getEventReactionProgressCurrent(item = null, abilityFunction = null, condition = null) {
  const key = getEventReactionProgressKey({ abilityFunction, condition });
  if (!key) return 0;
  const required = normalizeEventReactionProgressRequired(condition?.progressRequired);
  return Math.max(0, Math.min(required, finiteNumber(getEventReactionProgressState(item)?.[key]?.current)));
}

/** Rows consumed by ability and linked-effect progress renderers. */
export function getEventReactionProgressEntries(item = null, {
  trackingTarget = ""
} = {}) {
  if (item?.type !== "ability") return [];
  const requiredTrackingTarget = String(trackingTarget ?? "").trim();
  const state = getEventReactionProgressState(item);
  const rows = [];
  for (const abilityFunction of normalizeAbilityFunctions(item.system?.functions ?? [])) {
    if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
    for (const condition of abilityFunction.conditions ?? []) {
      if (condition?.type !== ABILITY_CONDITION_TYPES.eventReaction) continue;
      if (
        requiredTrackingTarget
        && !normalizeStrings(condition?.trackingTargets).includes(requiredTrackingTarget)
      ) continue;
      if (!isEventReactionProgressTracked(condition.eventKey)) continue;
      const required = normalizeEventReactionProgressRequired(condition.progressRequired);
      const key = getEventReactionProgressKey({ abilityFunction, condition });
      if (!key) continue;
      const current = Math.max(0, Math.min(required, finiteNumber(state?.[key]?.current)));
      if (required <= 1 && current <= 0) continue;
      rows.push({
        key,
        label: getEventReactionProgressLabel(condition.eventKey),
        current,
        required
      });
    }
  }
  return rows;
}

/**
 * Resolve the natural numeric amount represented by a tracked semantic event.
 */
export function getEventReactionProgressIncrement(condition = {}, envelope = {}) {
  const key = String(condition?.eventKey ?? envelope?.key ?? "").trim();
  if (!isEventReactionProgressTracked(key)) return 0;
  const data = objectValue(envelope?.data);
  const result = objectValue(data.result);
  const delta = objectValue(envelope?.delta);
  let amount = 0;

  if (key === "fallout-maw.research.progressed") {
    amount = positiveNumber(delta.progress);
  } else if (key === "fallout-maw.damage.resolved") {
    amount = getSystemEventNumericValue("damageActualHealthLoss", envelope);
  } else if (key === "fallout-maw.healing.resolved") {
    amount = firstPositive(delta.health, Math.abs(finiteNumber(result.healthDelta)), result.amount);
  } else if (key === "fallout-maw.combat.resource.spent") {
    const selected = new Set(normalizeStrings(condition?.eventFilters?.resourceKeys));
    amount = Object.entries(objectValue(data.resources))
      .filter(([resourceKey]) => !selected.size || selected.has(resourceKey))
      .reduce((total, [, value]) => total + positiveNumber(value), 0);
  } else if (key === "fallout-maw.world.time.advanced") {
    amount = firstPositive(delta.worldTime, data.seconds);
  } else if (key === "fallout-maw.travel.movement.completed") {
    amount = positiveNumber(data.distanceKm);
  } else if ([
    "fallout-maw.actor.need.thresholdEntered",
    "fallout-maw.actor.need.thresholdLeft"
  ].includes(key)) {
    amount = Math.abs(finiteNumber(delta.percent));
  }

  return roundProgress(Math.max(0, amount));
}

export function createEventReactionProgressManager({
  updateItem = defaultUpdateItem,
  logger = console
} = {}) {
  const queues = new Map();
  // Event ids are needed only for de-duplication. Keeping history-only changes
  // here avoids resetting and preparing the parent Actor for every zero-value
  // event or every event received while the counter is already full.
  //
  // The ledger is bounded to the same window as the persisted flag and is
  // indexed both by Item and root so a root finalizer can durably flush it.
  const pendingHistoryByItem = new Map();
  const pendingItemKeysByRoot = new Map();
  const rootFlushes = new Map();
  let historySequence = 0;

  async function advance({
    item = null,
    abilityFunction = null,
    conditionIds = [],
    envelope = {},
    chainRef = null
  } = {}) {
    return withItemLock(item, async () => {
      const selected = selectConditions(abilityFunction, conditionIds);
      if (!item || !selected.length) return emptyResult();
      const state = cloneState(getEventReactionProgressState(item));
      const itemKey = getItemLockKey(item);
      const rootId = String(envelope?.rootId ?? "").trim();
      const eventId = String(envelope?.eventId ?? "").trim();
      const readyConditionIds = [];
      const advancedConditionIds = [];
      const acceptedChanges = [];
      let numericChanged = false;

      for (const condition of selected) {
        if (!isEventReactionProgressTracked(condition.eventKey)) {
          readyConditionIds.push(String(condition.id));
          continue;
        }
        const key = getEventReactionProgressKey({ abilityFunction, condition });
        if (!key) continue;
        const required = normalizeEventReactionProgressRequired(condition.progressRequired);
        const previous = objectValue(state[key]);
        const persistedCurrent = finiteNumber(previous.current);
        let current = Math.max(0, Math.min(required, persistedCurrent));
        const recentEventIds = mergeRecentEventIds(
          normalizeRecentEventIds(previous),
          getPendingEventIds(itemKey, key)
        );
        if (!eventId || !recentEventIds.includes(eventId)) {
          const increment = getEventReactionProgressIncrement(condition, envelope);
          current = roundProgress(Math.min(required, current + increment));
          acceptedChanges.push({
            key,
            functionId: String(abilityFunction?.id ?? ""),
            conditionId: String(condition?.id ?? ""),
            eventKey: String(condition?.eventKey ?? envelope?.key ?? ""),
            current,
            eventId
          });
          if (current !== persistedCurrent) numericChanged = true;
          if (increment > 0) advancedConditionIds.push(String(condition.id));
        }
        if (current >= required) readyConditionIds.push(String(condition.id));
      }

      if (numericChanged) {
        mergePendingHistoryIntoState(state, itemKey);
        mergeAcceptedChangesIntoState(state, acceptedChanges);
        await writeState(item, state, chainRef);
        clearPendingItemHistory(itemKey);
      } else if (acceptedChanges.some(change => change.eventId)) {
        if (rootId && itemKey) {
          for (const change of acceptedChanges) {
            if (!change.eventId) continue;
            recordPendingHistory({
              item,
              itemKey,
              rootId,
              chainRef,
              ...change
            });
          }
        } else {
          // A root-less event has no lifecycle finalizer. Preserve the previous
          // durable behaviour, but suppress an unnecessary sheet render.
          mergeAcceptedChangesIntoState(state, acceptedChanges);
          await writeState(item, state, chainRef, { render: false });
        }
      }
      return {
        ready: readyConditionIds.length > 0,
        readyConditionIds,
        advancedConditionIds
      };
    });
  }

  async function isReady({ item = null, abilityFunction = null, conditionIds = [] } = {}) {
    const selected = selectConditions(abilityFunction, conditionIds);
    const state = getEventReactionProgressState(item);
    return selected.some(condition => {
      if (!isEventReactionProgressTracked(condition.eventKey)) return true;
      const key = getEventReactionProgressKey({ abilityFunction, condition });
      const required = normalizeEventReactionProgressRequired(condition.progressRequired);
      return key && finiteNumber(state?.[key]?.current) >= required;
    });
  }

  async function consume({
    item = null,
    abilityFunction = null,
    conditionIds = [],
    chainRef = null
  } = {}) {
    return withItemLock(item, async () => {
      const selected = selectConditions(abilityFunction, conditionIds);
      if (!item || !selected.length) return 0;
      const state = cloneState(getEventReactionProgressState(item));
      let consumed = 0;
      for (const condition of selected) {
        if (!isEventReactionProgressTracked(condition.eventKey)) continue;
        const key = getEventReactionProgressKey({ abilityFunction, condition });
        if (!key || !Object.hasOwn(state, key)) continue;
        const required = normalizeEventReactionProgressRequired(condition.progressRequired);
        const current = Math.max(0, Math.min(required, finiteNumber(state[key]?.current)));
        if (current < required) continue;
        state[key] = {
          ...state[key],
          current: roundProgress(Math.max(0, current - required))
        };
        consumed += 1;
      }
      if (consumed) {
        const itemKey = getItemLockKey(item);
        mergePendingHistoryIntoState(state, itemKey);
        await writeState(item, state, chainRef);
        clearPendingItemHistory(itemKey);
      }
      return consumed;
    });
  }

  async function reset({
    item = null,
    abilityFunction = null,
    conditionIds = [],
    chainRef = null
  } = {}) {
    return withItemLock(item, async () => {
      const selected = selectConditions(abilityFunction, conditionIds);
      if (!item || !selected.length) return 0;
      const state = cloneState(getEventReactionProgressState(item));
      let resetCount = 0;
      for (const condition of selected) {
        if (!isEventReactionProgressTracked(condition.eventKey)) continue;
        const key = getEventReactionProgressKey({ abilityFunction, condition });
        if (!key || !Object.hasOwn(state, key)) continue;
        if (finiteNumber(state[key]?.current) <= 0) continue;
        state[key] = {
          ...state[key],
          current: 0
        };
        resetCount += 1;
      }
      if (resetCount) {
        const itemKey = getItemLockKey(item);
        mergePendingHistoryIntoState(state, itemKey);
        await writeState(item, state, chainRef);
        clearPendingItemHistory(itemKey);
      }
      return resetCount;
    });
  }

  /**
   * Persist history-only event ids for one completed semantic-event root.
   *
   * Each Item is serialized through the same lock as advance/reset. Successful
   * Item writes are removed immediately; failed ones stay in the ledger so a
   * later cleanup attempt retries only unfinished work. Concurrent calls for
   * the same root share one promise and therefore cannot double-write.
   */
  function flushRoot(rootId = "") {
    const normalized = String(rootId ?? "").trim();
    if (!normalized) return Promise.resolve(0);
    const current = rootFlushes.get(normalized);
    if (current) return current;
    const flush = flushRootNow(normalized);
    rootFlushes.set(normalized, flush);
    void flush.finally(() => {
      if (rootFlushes.get(normalized) === flush) rootFlushes.delete(normalized);
    }).catch(() => undefined);
    return flush;
  }

  async function flushRootNow(rootId) {
    const itemKeys = Array.from(pendingItemKeysByRoot.get(rootId) ?? []);
    let flushed = 0;
    const failures = [];
    for (const itemKey of itemKeys) {
      try {
        flushed += await withItemLock(
          pendingHistoryByItem.get(itemKey)?.item,
          async () => {
            const pending = pendingHistoryByItem.get(itemKey);
            if (!pending || !hasPendingRootHistory(pending, rootId)) {
              unlinkRootItem(rootId, itemKey);
              return 0;
            }
            const state = cloneState(getEventReactionProgressState(pending.item));
            const chainRef = mergePendingHistoryIntoState(state, itemKey, { rootId });
            await writeState(pending.item, state, chainRef, { render: false });
            clearPendingItemHistory(itemKey, { rootId });
            return 1;
          },
          itemKey
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        `Event Reaction progress history flush failed for root "${rootId}".`
      );
    }
    pendingItemKeysByRoot.delete(rootId);
    return flushed;
  }

  function withItemLock(item, operation, explicitKey = "") {
    const key = String(explicitKey || getItemLockKey(item)).trim();
    if (!key) return operation();
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(key, current);
    void current.finally(() => {
      if (queues.get(key) === current) queues.delete(key);
    }).catch(error => logger?.warn?.("fallout-maw | Event Reaction progress operation failed.", error));
    return current;
  }

  function writeState(item, state, chainRef, options = {}) {
    return updateItem(item, state, {
      falloutMawEventReactionProgress: true,
      ...options,
      ...(chainRef ? { chainRef, falloutMawSystemEventChainRef: chainRef } : {})
    });
  }

  function recordPendingHistory({
    item,
    itemKey,
    rootId,
    chainRef,
    key,
    functionId,
    conditionId,
    eventKey,
    eventId
  }) {
    let pending = pendingHistoryByItem.get(itemKey);
    if (!pending) {
      pending = { item, byProgressKey: new Map() };
      pendingHistoryByItem.set(itemKey, pending);
    } else {
      pending.item = item;
    }
    let events = pending.byProgressKey.get(key);
    if (!events) {
      events = [];
      pending.byProgressKey.set(key, events);
    }
    if (events.some(entry => entry.eventId === eventId)) return;
    events.push({
      rootId,
      chainRef,
      functionId,
      conditionId,
      eventKey,
      eventId,
      sequence: ++historySequence
    });
    while (events.length > EVENT_REACTION_PROGRESS_HISTORY_LIMIT) {
      const [removed] = events.splice(0, 1);
      if (removed) unlinkRootItemIfUnused(removed.rootId, itemKey, pending);
    }
    let rootItems = pendingItemKeysByRoot.get(rootId);
    if (!rootItems) {
      rootItems = new Set();
      pendingItemKeysByRoot.set(rootId, rootItems);
    }
    rootItems.add(itemKey);
  }

  function getPendingEventIds(itemKey, progressKey) {
    if (!itemKey || !progressKey) return [];
    return (pendingHistoryByItem.get(itemKey)?.byProgressKey.get(progressKey) ?? [])
      .map(entry => entry.eventId);
  }

  function mergePendingHistoryIntoState(state, itemKey, { rootId = "" } = {}) {
    const pending = pendingHistoryByItem.get(itemKey);
    if (!pending) return null;
    let latestChainRef = null;
    for (const [key, allEvents] of pending.byProgressKey) {
      const events = rootId
        ? allEvents.filter(entry => entry.rootId === rootId)
        : allEvents;
      if (!events.length) continue;
      const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
      const latest = ordered.at(-1);
      const previous = objectValue(state[key]);
      const recentEventIds = mergeRecentEventIds(
        normalizeRecentEventIds(previous),
        ordered.map(entry => entry.eventId)
      );
      state[key] = {
        ...previous,
        functionId: latest.functionId,
        conditionId: latest.conditionId,
        eventKey: latest.eventKey,
        current: finiteNumber(previous.current),
        lastEventId: recentEventIds.at(-1) ?? "",
        recentEventIds
      };
      if (latest.chainRef) latestChainRef = latest.chainRef;
    }
    return latestChainRef;
  }

  function mergeAcceptedChangesIntoState(state, changes) {
    for (const change of changes) {
      const previous = objectValue(state[change.key]);
      const recentEventIds = change.eventId
        ? mergeRecentEventIds(normalizeRecentEventIds(previous), [change.eventId])
        : normalizeRecentEventIds(previous);
      state[change.key] = {
        ...previous,
        functionId: change.functionId,
        conditionId: change.conditionId,
        eventKey: change.eventKey,
        current: change.current,
        lastEventId: change.eventId || previous.lastEventId || "",
        recentEventIds
      };
    }
  }

  function clearPendingItemHistory(itemKey, { rootId = "" } = {}) {
    const pending = pendingHistoryByItem.get(itemKey);
    if (!pending) return;
    const affectedRoots = new Set();
    for (const [key, events] of pending.byProgressKey) {
      for (const entry of events) {
        if (!rootId || entry.rootId === rootId) affectedRoots.add(entry.rootId);
      }
      const remaining = rootId
        ? events.filter(entry => entry.rootId !== rootId)
        : [];
      if (remaining.length) pending.byProgressKey.set(key, remaining);
      else pending.byProgressKey.delete(key);
    }
    if (!pending.byProgressKey.size) pendingHistoryByItem.delete(itemKey);
    for (const affectedRoot of affectedRoots) {
      unlinkRootItemIfUnused(affectedRoot, itemKey, pendingHistoryByItem.get(itemKey));
    }
  }

  function hasPendingRootHistory(pending, rootId) {
    return Array.from(pending?.byProgressKey?.values?.() ?? [])
      .some(events => events.some(entry => entry.rootId === rootId));
  }

  function unlinkRootItemIfUnused(rootId, itemKey, pending) {
    if (!rootId) return;
    if (pending && hasPendingRootHistory(pending, rootId)) return;
    unlinkRootItem(rootId, itemKey);
  }

  function unlinkRootItem(rootId, itemKey) {
    const rootItems = pendingItemKeysByRoot.get(rootId);
    if (!rootItems) return;
    rootItems.delete(itemKey);
    if (!rootItems.size) pendingItemKeysByRoot.delete(rootId);
  }

  return Object.freeze({ advance, isReady, consume, reset, flushRoot });
}

export function getEventReactionProgressLabel(eventKey = "") {
  const [labelKey, fallback] = PROGRESS_LABELS[String(eventKey ?? "").trim()]
    ?? ["FALLOUTMAW.Events.Reaction.Progress.Occurrences", "Event occurrences"];
  return localize(labelKey, fallback);
}

function selectConditions(abilityFunction, conditionIds) {
  const accepted = new Set(normalizeStrings(conditionIds));
  return (abilityFunction?.conditions ?? []).filter(condition => (
    condition?.type === ABILITY_CONDITION_TYPES.eventReaction
    && accepted.has(String(condition?.id ?? ""))
  ));
}

function defaultUpdateItem(item, state, options) {
  return item?.update?.({
    [`flags.${SYSTEM_ID}.${EVENT_REACTION_PROGRESS_FLAG_KEY}`]: state
  }, options);
}

function cloneState(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value ?? {});
  return JSON.parse(JSON.stringify(value ?? {}));
}

function emptyResult() {
  return { ready: false, readyConditionIds: [], advancedConditionIds: [] };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStrings(value) {
  const source = Array.isArray(value) ? value : Object.values(value ?? {});
  return Array.from(new Set(source.map(entry => String(entry ?? "").trim()).filter(Boolean)));
}

function normalizeRecentEventIds(state = {}) {
  const values = normalizeStrings(state?.recentEventIds);
  const legacy = String(state?.lastEventId ?? "").trim();
  if (legacy && !values.includes(legacy)) values.push(legacy);
  return values.slice(-EVENT_REACTION_PROGRESS_HISTORY_LIMIT);
}

function mergeRecentEventIds(previous = [], additions = []) {
  return normalizeStrings([...previous, ...additions])
    .slice(-EVENT_REACTION_PROGRESS_HISTORY_LIMIT);
}

function getItemLockKey(item = null) {
  return String(item?.uuid ?? item?.id ?? "").trim();
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function positiveNumber(value) {
  return Math.max(0, finiteNumber(value));
}

function firstPositive(...values) {
  return values.map(positiveNumber).find(value => value > 0) ?? 0;
}

function roundProgress(value) {
  return Math.round((finiteNumber(value) + Number.EPSILON) * 10000) / 10000;
}

function localize(key, fallback) {
  const localized = globalThis.game?.i18n?.localize?.(key);
  return localized && localized !== key ? localized : fallback;
}
