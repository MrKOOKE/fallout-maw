import {
  ABILITY_ACCUMULATION_GROUP_SOURCES,
  ABILITY_ACCUMULATION_VALUE_SOURCES,
  normalizeAbilityAccumulation
} from "../settings/abilities.mjs";

/**
 * Resolve a constructor-safe numeric value from a semantic event.
 *
 * The registry deliberately exposes named values instead of arbitrary paths.
 * This keeps progress counters, accumulators and future formula bindings on
 * the same definition of concepts such as "damage actually received".
 */
export function getSystemEventNumericValue(valueSource = "", envelope = {}) {
  const source = String(valueSource ?? "").trim();
  const data = objectValue(envelope?.data);
  const result = objectValue(data.result);
  const delta = objectValue(envelope?.delta);

  if (source === ABILITY_ACCUMULATION_VALUE_SOURCES.damageIncoming) {
    return positiveNumber(data.amount);
  }
  if (source === ABILITY_ACCUMULATION_VALUE_SOURCES.damageAfterMitigation) {
    return positiveNumber(result.amount);
  }
  if (source === ABILITY_ACCUMULATION_VALUE_SOURCES.damageActualHealthLoss) {
    if (Object.hasOwn(delta, "health")) return positiveNumber(-finiteNumber(delta.health));
    if (Object.hasOwn(result, "healthDelta")) return Math.abs(finiteNumber(result.healthDelta));
    return positiveNumber(result.amount);
  }
  if (source === ABILITY_ACCUMULATION_VALUE_SOURCES.damageLimbLoss) {
    if (Object.hasOwn(delta, "limb")) return positiveNumber(-finiteNumber(delta.limb));
    return Math.abs(finiteNumber(result.limbDelta));
  }
  if (source === ABILITY_ACCUMULATION_VALUE_SOURCES.damageItemConditionLoss) {
    if (Object.hasOwn(delta, "itemCondition")) return positiveNumber(-finiteNumber(delta.itemCondition));
    return Math.abs(finiteNumber(result.itemConditionDelta));
  }
  return 0;
}

/** Resolve the safe grouping key selected by an accumulating effect. */
export function getSystemEventGroupKey(groupSource = "", envelope = {}) {
  if (groupSource === ABILITY_ACCUMULATION_GROUP_SOURCES.none) return "all";
  if (groupSource !== ABILITY_ACCUMULATION_GROUP_SOURCES.damageType) return "";
  const data = objectValue(envelope?.data);
  const result = objectValue(data.result);
  return normalizeEffectPathSegment(data.damageTypeKey ?? result.damageTypeKey);
}

export function getAbilityAccumulatorInput(condition = {}, envelope = {}) {
  const settings = normalizeAbilityAccumulation(condition?.accumulation);
  if (envelope?.outcome?.cancelled === true || envelope?.outcome?.success === false) {
    return { settings, value: 0, contribution: 0, groupKey: "" };
  }
  const value = getSystemEventNumericValue(settings.valueSource, envelope);
  const contribution = roundEventValue(value * settings.percent / 100);
  const groupKey = getSystemEventGroupKey(settings.groupBy, envelope);
  return {
    settings,
    value,
    contribution: Math.max(0, contribution),
    groupKey
  };
}

export function normalizeEffectPathSegment(value = "") {
  const key = String(value ?? "").trim();
  return key && !/[.[\]]/.test(key) ? key : "";
}

export function roundEventValue(value) {
  return Math.round((finiteNumber(value) + Number.EPSILON) * 10000) / 10000;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function positiveNumber(value) {
  return Math.max(0, finiteNumber(value));
}
