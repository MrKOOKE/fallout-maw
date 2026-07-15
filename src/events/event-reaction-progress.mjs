import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizeEventReactionProgressRequired
} from "../settings/abilities.mjs";

export { normalizeEventReactionProgressRequired } from "../settings/abilities.mjs";

export const EVENT_REACTION_PROGRESS_FLAG_KEY = "eventReactionProgress";

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

/** Rows consumed by the existing ability-hover progress renderer. */
export function getEventReactionProgressEntries(item = null) {
  if (item?.type !== "ability") return [];
  const state = getEventReactionProgressState(item);
  const rows = [];
  for (const abilityFunction of normalizeAbilityFunctions(item.system?.functions ?? [])) {
    if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
    for (const condition of abilityFunction.conditions ?? []) {
      if (condition?.type !== ABILITY_CONDITION_TYPES.eventReaction) continue;
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
    amount = firstPositive(-finiteNumber(delta.health), Math.abs(finiteNumber(result.healthDelta)), result.amount);
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
      const eventId = String(envelope?.eventId ?? "").trim();
      const readyConditionIds = [];
      const advancedConditionIds = [];
      let changed = false;

      for (const condition of selected) {
        if (!isEventReactionProgressTracked(condition.eventKey)) {
          readyConditionIds.push(String(condition.id));
          continue;
        }
        const key = getEventReactionProgressKey({ abilityFunction, condition });
        if (!key) continue;
        const required = normalizeEventReactionProgressRequired(condition.progressRequired);
        const previous = objectValue(state[key]);
        let current = Math.max(0, Math.min(required, finiteNumber(previous.current)));
        const recentEventIds = normalizeRecentEventIds(previous);
        if (!eventId || !recentEventIds.includes(eventId)) {
          const increment = getEventReactionProgressIncrement(condition, envelope);
          current = roundProgress(Math.min(required, current + increment));
          state[key] = {
            ...previous,
            functionId: String(abilityFunction?.id ?? ""),
            conditionId: String(condition?.id ?? ""),
            eventKey: String(condition?.eventKey ?? envelope?.key ?? ""),
            current,
            lastEventId: eventId,
            recentEventIds: eventId
              ? [...recentEventIds, eventId].slice(-64)
              : recentEventIds
          };
          changed = true;
          if (increment > 0) advancedConditionIds.push(String(condition.id));
        }
        if (current >= required) readyConditionIds.push(String(condition.id));
      }

      if (changed) await writeState(item, state, chainRef);
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
      if (consumed) await writeState(item, state, chainRef);
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
      if (resetCount) await writeState(item, state, chainRef);
      return resetCount;
    });
  }

  function withItemLock(item, operation) {
    const key = String(item?.uuid ?? item?.id ?? "").trim();
    if (!key) return operation();
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(key, current);
    void current.finally(() => {
      if (queues.get(key) === current) queues.delete(key);
    }).catch(error => logger?.warn?.("fallout-maw | Event Reaction progress operation failed.", error));
    return current;
  }

  function writeState(item, state, chainRef) {
    return updateItem(item, state, {
      falloutMawEventReactionProgress: true,
      ...(chainRef ? { chainRef, falloutMawSystemEventChainRef: chainRef } : {})
    });
  }

  return Object.freeze({ advance, isReady, consume, reset });
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
  return values.slice(-64);
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
