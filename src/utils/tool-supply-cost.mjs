import { getContextualAbilityChangeValue } from "../abilities/evaluation.mjs";
import { getActorEffectChangeEntries } from "../documents/actor-effect-preparation-index.mjs";
import { evaluateActorEffectChangeBaseNumber } from "./active-effect-changes.mjs";
import { toInteger } from "./numbers.mjs";
import {
  ALL_TOOL_SUPPLY_COST_EFFECT_KEY,
  getToolSupplyCostEffectKey
} from "./tool-supply-effect-keys.mjs";

export {
  ALL_TOOL_SUPPLY_COST_EFFECT_KEY,
  getToolKeyFromSupplyCostEffectKey,
  getToolSupplyCostEffectKey,
  isToolSupplyCostEffectKey,
  TOOL_SUPPLY_COST_EFFECT_KEY_PREFIX
} from "./tool-supply-effect-keys.mjs";

/** Apply a percentage modifier to a positive, indivisible tool-supply cost. */
export function applyToolSupplyCostPercent(baseCost = 0, percent = 0) {
  const base = Math.max(0, toInteger(baseCost));
  if (!base) return 0;
  const modifier = Number(percent);
  const multiplier = Math.max(0, 1 + ((Number.isFinite(modifier) ? modifier : 0) / 100));
  return Math.max(1, Math.round(base * multiplier));
}

/**
 * Resolve the combined all-tools and per-tool percentage for one actor.
 * Persistent ActiveEffects use the preparation index; only truly contextual
 * ability changes require the additional contextual scan.
 */
export function getActorToolSupplyCostPercent(actor, toolKey = "", context = {}) {
  const specificKey = getToolSupplyCostEffectKey(toolKey);
  if (!actor || !specificKey) return 0;

  const acceptedKeys = new Set([ALL_TOOL_SUPPLY_COST_EFFECT_KEY, specificKey]);
  const changes = [];
  let order = 0;
  for (const { effect, change } of getActorEffectChangeEntries(actor, acceptedKeys, {
    snapshot: context?.effectSnapshot
  })) {
    if (effect?.disabled || effect?.active === false) continue;
    const value = evaluateActorEffectChangeBaseNumber(actor, { ...change, effect });
    if (!Number.isFinite(value)) continue;
    changes.push({
      type: String(change?.type ?? "add"),
      value,
      priority: toInteger(change?.priority),
      order: order++
    });
  }

  changes.sort((left, right) => left.priority - right.priority || left.order - right.order);
  let percent = applyToolSupplyPercentChanges(0, changes);
  if (!hasToolSupplyContext(context)) return percent;
  percent = getContextualAbilityChangeValue(actor, specificKey, {
    ...context,
    baseValue: percent,
    alternateKeys: [ALL_TOOL_SUPPLY_COST_EFFECT_KEY]
  });
  return Number.isFinite(Number(percent)) ? Number(percent) : 0;
}

export function getActorToolSupplyCost(actor, toolKey = "", baseCost = 0, context = {}) {
  return applyToolSupplyCostPercent(
    baseCost,
    getActorToolSupplyCostPercent(actor, toolKey, context)
  );
}

function hasToolSupplyContext(context = {}) {
  return Boolean(
    context?.actorToken
    || context?.targetActor
    || context?.targetToken
    || context?.weaponData
    || context?.chanceOperationId
    || context?.systemEventOperationId
  );
}

function applyToolSupplyPercentChanges(baseValue = 0, changes = []) {
  let value = Number(baseValue) || 0;
  for (const change of changes ?? []) {
    const amount = Number(change?.value);
    if (!Number.isFinite(amount)) continue;
    if (change.type === "multiply") value *= amount;
    else if (change.type === "subtract") value -= amount;
    else if (change.type === "override") value = amount;
    else if (change.type === "upgrade") value = Math.max(value, amount);
    else if (change.type === "downgrade") value = Math.min(value, amount);
    else value += amount;
  }
  return value;
}
