import {
  commitPreparedActiveUseOperations,
  getActiveUseOperationId,
  prepareActiveUseOperation
} from "../abilities/active-use-runtime.mjs";
import { getContextualAbilityChangeValues } from "../abilities/evaluation.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  getNeedGrowthResistanceEffectKey,
  getNeedSatisfactionEffectivenessEffectKey
} from "./need-change-effect-keys.mjs";
import { scaleGroupedNeedChanges } from "./need-change-scaling.mjs";

export function resolveActorNeedChangeModifiers(actor = null, needKeys = [], context = {}) {
  const keys = normalizeNeedKeys(needKeys);
  if (!keys.length) return new Map();
  const specs = keys.flatMap(needKey => [
    {
      id: getModifierId(needKey, "growth"),
      key: getNeedGrowthResistanceEffectKey(needKey),
      baseValue: 0
    },
    {
      id: getModifierId(needKey, "satisfaction"),
      key: getNeedSatisfactionEffectivenessEffectKey(needKey),
      baseValue: 0
    }
  ]);
  const values = getContextualAbilityChangeValues(actor, specs, context);
  return new Map(keys.map(needKey => [
    needKey,
    {
      growthResistancePercent: toFiniteNumber(values[getModifierId(needKey, "growth")]),
      satisfactionEffectivenessPercent: toFiniteNumber(values[getModifierId(needKey, "satisfaction")])
    }
  ]));
}

export async function applyActorNeedChanges(actor = null, changes = [], {
  context = {},
  documentOptions = {}
} = {}) {
  if (!actor) return [];
  const entries = normalizeNeedChangeEntries(changes)
    .filter(entry => actor.system?.needs?.[entry.key]);
  if (!entries.length) return [];

  const needKeys = normalizeNeedKeys(entries.map(entry => entry.key));
  const activeUseKeys = new Set(entries.map(entry => (
    entry.value > 0
      ? getNeedGrowthResistanceEffectKey(entry.key)
      : getNeedSatisfactionEffectivenessEffectKey(entry.key)
  )).filter(Boolean));
  const preparation = prepareActiveUseOperation({
    kind: "needChange",
    actor,
    keys: activeUseKeys,
    conditionContexts: [context],
    reverseOnly: false
  });
  const modifiers = resolveActorNeedChangeModifiers(actor, needKeys, context);

  const grouped = new Map();
  for (const entry of entries) {
    const values = grouped.get(entry.key) ?? [];
    values.push(entry.value);
    grouped.set(entry.key, values);
  }

  const updates = {};
  const outcomes = [];
  for (const [key, values] of grouped) {
    const needModifiers = modifiers.get(key);
    const change = scaleGroupedNeedChanges(values, needModifiers);
    const need = actor.system.needs[key];
    const min = toInteger(need.min);
    const max = Math.max(min, toInteger(need.max));
    const previousValue = Math.min(max, Math.max(min, toInteger(need.value)));
    const value = Math.min(max, Math.max(min, previousValue + change.scaledDelta));
    const appliedDelta = value - previousValue;
    if (appliedDelta) updates[`system.needs.${key}.value`] = value;
    outcomes.push({
      key,
      needKey: key,
      requestedDelta: change.requestedDelta,
      requestedGrowth: change.requestedGrowth,
      requestedSatisfaction: change.requestedSatisfaction,
      scaledGrowth: change.scaledGrowth,
      scaledSatisfaction: change.scaledSatisfaction,
      scaledDelta: change.scaledDelta,
      appliedDelta,
      previousValue,
      value,
      modifiers: needModifiers ?? {
        growthResistancePercent: 0,
        satisfactionEffectivenessPercent: 0
      }
    });
  }

  if (Object.keys(updates).length) await actor.update(updates, documentOptions);
  if (preparation) {
    await commitPreparedActiveUseOperations([preparation], {
      operationId: getActiveUseOperationId(context, createNeedChangeOperationId(actor))
    });
  }
  return outcomes;
}

export function normalizeNeedChangeEntries(changes = []) {
  const source = Array.isArray(changes)
    ? changes
    : Object.entries(changes ?? {}).map(([needKey, value]) => ({ needKey, value }));
  return source
    .map(entry => ({
      key: String(entry?.key ?? entry?.needKey ?? "").trim(),
      value: toInteger(entry?.value)
    }))
    .filter(entry => entry.key && entry.value);
}

function normalizeNeedKeys(keys = []) {
  return Array.from(new Set((Array.isArray(keys) ? keys : [])
    .map(key => String(key ?? "").trim())
    .filter(key => key && !key.includes("."))));
}

function getModifierId(needKey, kind) {
  return `${kind}:${needKey}`;
}

function createNeedChangeOperationId(actor) {
  const actorId = String(actor?.uuid ?? actor?.id ?? "actor");
  return `need-change:${actorId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
