import { SYSTEM_ID } from "../constants.mjs";
import {
  getAbilityFunctionEffectDurationSeconds,
  isAbilityFunctionTimedTriggerCost,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { getAbilityEffectOriginUuid } from "../utils/ability-effect-origin.mjs";
import { abilityConditionsApply } from "./evaluation.mjs";
import {
  notifyAbilityTriggerCostFailure,
  payAbilityFunctionTriggerCost
} from "./trigger-cost-runtime.mjs";

export const ABILITY_TIMED_TRIGGER_EFFECT_FLAG_KEY = "abilityTimedTriggerEffect";
export const ABILITY_TIMED_TRIGGER_STATE_FLAG_KEY = "abilityTimedTriggerStates";

const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;

export function withoutTimedTriggerCostFunctions(functions = []) {
  return normalizeAbilityFunctions(functions)
    .filter(abilityFunction => !isAbilityFunctionTimedTriggerCost(abilityFunction));
}

export async function syncTimedTriggerCostEffects(actor, sourceItem, functions = [], context = {}) {
  if (!actor || !sourceItem || !game.user?.isActiveGM) return;
  const timedFunctions = normalizeAbilityFunctions(functions)
    .filter(isAbilityFunctionTimedTriggerCost)
    .filter(hasUsableChanges);
  const states = foundry.utils.deepClone(
    sourceItem.getFlag?.(SYSTEM_ID, ABILITY_TIMED_TRIGGER_STATE_FLAG_KEY)
      ?? sourceItem.flags?.[SYSTEM_ID]?.[ABILITY_TIMED_TRIGGER_STATE_FLAG_KEY]
      ?? {}
  );
  const validIds = new Set(timedFunctions.map(abilityFunction => String(abilityFunction.id)));
  let statesChanged = false;
  for (const key of Object.keys(states)) {
    if (validIds.has(key)) continue;
    delete states[key];
    statesChanged = true;
  }

  for (const abilityFunction of timedFunctions) {
    const functionId = String(abilityFunction.id ?? "").trim();
    if (!functionId) continue;
    const applies = abilityConditionsApply(actor, abilityFunction.conditions ?? [], {
      ...context,
      abilityItemId: sourceItem.id ?? "",
      functionId
    });
    const state = normalizeTransitionState(states[functionId]);
    if (!applies) {
      if (states[functionId] !== undefined) {
        delete states[functionId];
        statesChanged = true;
      }
      continue;
    }

    if (state.latched) {
      if (state.paymentCommitted && !state.effectCreated) {
        const existing = findTimedTriggerEffect(actor, sourceItem, functionId);
        if (existing) {
          states[functionId] = { ...state, effectCreated: true, effectId: existing.id ?? "" };
          statesChanged = true;
        } else {
          const created = await createTimedTriggerEffect(actor, sourceItem, abilityFunction);
          if (created) {
            states[functionId] = { ...state, effectCreated: true, effectId: created.id ?? "" };
            statesChanged = true;
          }
        }
      }
      continue;
    }

    states[functionId] = {
      latched: true,
      paymentCommitted: false,
      effectCreated: false,
      effectId: "",
      changedAt: getWorldTime()
    };
    await persistTransitionStates(sourceItem, states);
    statesChanged = false;

    const payment = await payAbilityFunctionTriggerCost({
      actor,
      sourceItem,
      abilityFunction,
      context: {
        occurrenceId: `timed-trigger:${sourceItem.uuid ?? sourceItem.id}:${functionId}:${getWorldTime()}`,
        actorLockScope: `timed-trigger:${actor.uuid ?? actor.id}:${sourceItem.uuid ?? sourceItem.id}:${functionId}`,
        logicalWorldTime: getWorldTime()
      }
    });
    if (!payment.ok) {
      notifyAbilityTriggerCostFailure(payment);
      continue;
    }

    states[functionId] = {
      ...states[functionId],
      paymentCommitted: true
    };
    await persistTransitionStates(sourceItem, states);
    const created = await createTimedTriggerEffect(actor, sourceItem, abilityFunction);
    if (!created) continue;
    states[functionId] = {
      ...states[functionId],
      effectCreated: true,
      effectId: String(created.id ?? created._id ?? "")
    };
    statesChanged = true;
  }

  if (statesChanged) await persistTransitionStates(sourceItem, states);
}

export function getTimedTriggerEffectFlag(effect = null) {
  return effect?.getFlag?.(SYSTEM_ID, ABILITY_TIMED_TRIGGER_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[ABILITY_TIMED_TRIGGER_EFFECT_FLAG_KEY]
    ?? null;
}

async function createTimedTriggerEffect(actor, sourceItem, abilityFunction) {
  const durationSeconds = getAbilityFunctionEffectDurationSeconds(abilityFunction);
  const changes = (abilityFunction?.changes ?? [])
    .filter(change => String(change?.key ?? "").trim() && String(change?.value ?? "") !== "")
    .map(change => ({ ...change }));
  if (durationSeconds <= 0 || !changes.length) return null;
  const functionId = String(abilityFunction?.id ?? "").trim();
  const startTime = getWorldTime();
  const effectData = {
    type: "base",
    name: String(sourceItem?.name ?? ""),
    img: String(sourceItem?.img ?? "icons/svg/aura.svg"),
    origin: getAbilityEffectOriginUuid(actor, sourceItem),
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    start: { time: startTime },
    duration: { value: durationSeconds, units: "seconds", expiry: null, expired: false },
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [ABILITY_TIMED_TRIGGER_EFFECT_FLAG_KEY]: {
          sourceItemUuid: String(sourceItem?.uuid ?? ""),
          sourceItemId: String(sourceItem?.id ?? ""),
          functionId,
          durationSeconds,
          triggeredAt: startTime
        }
      }
    }
  };
  const existing = findTimedTriggerEffect(actor, sourceItem, functionId);
  if (existing) {
    await existing.update(effectData, { animate: false, falloutMawTriggerCostEffect: true });
    return existing;
  }
  const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effectData], {
    animate: false,
    falloutMawTriggerCostEffect: true
  });
  return created ?? null;
}

function findTimedTriggerEffect(actor, sourceItem, functionId) {
  const sourceItemUuid = String(sourceItem?.uuid ?? "");
  return Array.from(actor?.effects ?? []).find(effect => {
    const flag = getTimedTriggerEffectFlag(effect);
    return flag
      && String(flag.sourceItemUuid ?? "") === sourceItemUuid
      && String(flag.functionId ?? "") === functionId;
  }) ?? null;
}

async function persistTransitionStates(sourceItem, states) {
  const value = Object.keys(states).length ? states : globalThis._del;
  await sourceItem.update({
    [`flags.${SYSTEM_ID}.${ABILITY_TIMED_TRIGGER_STATE_FLAG_KEY}`]: value
  }, { falloutMawTriggerTransitionState: true });
}

function normalizeTransitionState(value = {}) {
  return {
    latched: Boolean(value?.latched),
    paymentCommitted: Boolean(value?.paymentCommitted),
    effectCreated: Boolean(value?.effectCreated),
    effectId: String(value?.effectId ?? ""),
    changedAt: Number(value?.changedAt) || 0
  };
}

function hasUsableChanges(abilityFunction = {}) {
  return (abilityFunction?.changes ?? [])
    .some(change => String(change?.key ?? "").trim() && String(change?.value ?? "") !== "");
}

function getWorldTime() {
  return Math.max(0, Math.trunc(Number(game.time?.worldTime) || 0));
}
