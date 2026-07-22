import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  getAbilityFunctionEffectDurationSeconds,
  getAbilitySourceId,
  isAbilityFunctionTimedTriggerCost,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import { getAbilityEffectOriginUuid } from "../utils/ability-effect-origin.mjs";
import { abilityConditionsApply } from "./evaluation.mjs";
import {
  notifyAbilityTriggerCostFailure,
  payAbilityFunctionTriggerCost
} from "./trigger-cost-runtime.mjs";
import {
  EFFECT_LIFECYCLE_FLAG_KEY,
  EFFECT_LIFECYCLE_KINDS,
  buildEffectFunctionSnapshot
} from "./effect-lifecycle.mjs";
import {
  LIMITED_EFFECT_COPY_FLAG_KEY,
  buildLimitedEffectCopyFlag,
  isLimitedEffectCopyReservationFor,
  releaseLimitedEffectCopyReservation,
  reserveLimitedEffectCopySlot
} from "./limited-effect-copies.mjs";

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
    const conditionContext = {
      ...context,
      abilityItemId: sourceItem.id ?? "",
      functionId
    };
    const conditions = abilityFunction.conditions ?? [];
    const nonChanceConditions = conditions.filter(condition => condition?.type !== ABILITY_CONDITION_TYPES.triggerChance);
    if (!abilityConditionsApply(actor, nonChanceConditions, conditionContext)) {
      if (states[functionId] !== undefined) {
        delete states[functionId];
        statesChanged = true;
      }
      continue;
    }
    let state = normalizeTransitionState(states[functionId]);
    if (conditions.some(condition => condition?.type === ABILITY_CONDITION_TYPES.triggerChance) && !state.chanceOperationId) {
      state = {
        ...state,
        chanceOperationId: `timed-trigger:${sourceItem.uuid ?? sourceItem.id}:${functionId}:${getWorldTime()}:${foundry.utils.randomID()}`
      };
      states[functionId] = state;
      statesChanged = true;
    }
    const applies = abilityConditionsApply(actor, conditions, {
      ...conditionContext,
      chanceOperationId: state.chanceOperationId
    });
    if (!applies) continue;

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

    const effectCopyOptions = getTimedTriggerEffectCopyOptions(actor);
    const existing = findTimedTriggerEffect(actor, sourceItem, functionId);
    const reservation = existing ? null : reserveLimitedEffectCopySlot({
      recipientActor: actor,
      sourceActor: actor,
      sourceItem,
      abilityFunction
    }, effectCopyOptions);
    if (reservation && !reservation.allowed) continue;

    try {
      states[functionId] = {
        ...state,
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
      const created = await createTimedTriggerEffect(actor, sourceItem, abilityFunction, {
        copyReservation: reservation,
        effectCopyOptions
      });
      if (!created) continue;
      states[functionId] = {
        ...states[functionId],
        effectCreated: true,
        effectId: String(created.id ?? created._id ?? "")
      };
      statesChanged = true;
    } finally {
      releaseLimitedEffectCopyReservation(reservation);
    }
  }

  if (statesChanged) await persistTransitionStates(sourceItem, states);
}

export function getTimedTriggerEffectFlag(effect = null) {
  return effect?.getFlag?.(SYSTEM_ID, ABILITY_TIMED_TRIGGER_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[ABILITY_TIMED_TRIGGER_EFFECT_FLAG_KEY]
    ?? null;
}

async function createTimedTriggerEffect(actor, sourceItem, abilityFunction, {
  copyReservation = null,
  effectCopyOptions = getTimedTriggerEffectCopyOptions(actor)
} = {}) {
  const durationSeconds = getAbilityFunctionEffectDurationSeconds(abilityFunction);
  const changes = (abilityFunction?.changes ?? [])
    .filter(change => String(change?.key ?? "").trim() && String(change?.value ?? "") !== "")
    .map(change => ({ ...change }));
  if (durationSeconds <= 0 || !changes.length) return null;
  const functionId = String(abilityFunction?.id ?? "").trim();
  const startTime = getWorldTime();
  const existing = findTimedTriggerEffect(actor, sourceItem, functionId);
  const effectCopyContext = {
    recipientActor: actor,
    sourceActor: actor,
    sourceItem,
    abilityFunction
  };
  let reservation = null;
  if (!existing) {
    reservation = isLimitedEffectCopyReservationFor(copyReservation, effectCopyContext)
      ? copyReservation
      : reserveLimitedEffectCopySlot(effectCopyContext, effectCopyOptions);
    if (!reservation.allowed) return null;
  }
  const effectCopyFlag = buildLimitedEffectCopyFlag(effectCopyContext, effectCopyOptions);
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
        [EFFECT_LIFECYCLE_FLAG_KEY]: {
          kind: EFFECT_LIFECYCLE_KINDS.disposableInstance
        },
        [ABILITY_TIMED_TRIGGER_EFFECT_FLAG_KEY]: {
          sourceItemUuid: String(sourceItem?.uuid ?? ""),
          sourceItemId: String(sourceItem?.id ?? ""),
          abilitySourceId: getAbilitySourceId(sourceItem),
          functionId,
          functionData: buildEffectFunctionSnapshot(abilityFunction),
          durationSeconds,
          triggeredAt: startTime
        },
        ...(effectCopyFlag ? {
          [LIMITED_EFFECT_COPY_FLAG_KEY]: effectCopyFlag
        } : {})
      }
    }
  };
  try {
    if (existing) {
      await existing.update(effectData, { animate: false, falloutMawTriggerCostEffect: true });
      return existing;
    }
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effectData], {
      animate: false,
      falloutMawTriggerCostEffect: true
    });
    return created ?? null;
  } finally {
    releaseLimitedEffectCopyReservation(reservation);
  }
}

function getTimedTriggerEffectCopyOptions(actor) {
  return {
    evaluateLimit: formula => evaluateActorFormula(formula, actor, {
      fallback: 1,
      minimum: 1,
      context: "timed trigger effect copy limit"
    })
  };
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
    changedAt: Number(value?.changedAt) || 0,
    chanceOperationId: String(value?.chanceOperationId ?? "")
  };
}

function hasUsableChanges(abilityFunction = {}) {
  return (abilityFunction?.changes ?? [])
    .some(change => String(change?.key ?? "").trim() && String(change?.value ?? "") !== "");
}

function getWorldTime() {
  return Math.max(0, Math.trunc(Number(game.time?.worldTime) || 0));
}
