import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import {
  getActorAvailableEnergy,
  spendActorEnergyWithReceipt,
  refundActorEnergyReceipt
} from "../combat/energy-resource.mjs";
import { MOVEMENT_RESOURCE_KEY } from "../combat/movement-resources.mjs";
import { addOneTimeResourcePoints } from "../combat/one-time-resources.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import { normalizeReactiveSettings } from "../settings/abilities.mjs";
import { ATTACK_ACTION_POINT_MOVEMENT_LOSS_DISABLED_EFFECT_KEY } from "../utils/active-effect-keys.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  applyAbilityOverloadEffect,
  getAbilityOverloadEnergyCost,
  getAbilityOverloadName
} from "./overload.mjs";

export const REACTIVE_EFFECT_FLAG_KEY = "reactive";
export const REACTIVE_RESOURCE_OBSERVER_ID = "fallout-maw.fixed.reactive.resourceSpent";

const RESOURCE_EVENT_KEY = "fallout-maw.combat.resource.spent";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const reactiveEffectMutationQueues = new Map();
let reactiveRuntimeRegistered = false;

export function registerReactiveRuntime() {
  if (reactiveRuntimeRegistered) return false;
  reactiveRuntimeRegistered = true;
  registerSystemEventObserver({
    id: REACTIVE_RESOURCE_OBSERVER_ID,
    eventKeys: [RESOURCE_EVENT_KEY],
    priority: 150,
    observe: observeReactiveResourceSpent
  });
  return true;
}

export async function useReactiveAbility(actor, abilityItem, abilityFunction) {
  if (!actor || !abilityItem || !abilityFunction || (!game.user?.isGM && !actor.isOwner)) return false;

  const settings = normalizeReactiveSettings(abilityFunction.fixedSettings);
  const energyCost = settings.energyCost + getAbilityOverloadEnergyCost(actor, abilityItem, abilityFunction);
  const energyTransaction = await spendActorEnergyWithReceipt(actor, energyCost);
  if (energyTransaction.spent !== energyCost) {
    ui.notifications.warn(auditFormat("FALLOUTMAW.AuditRuntime.R0166", { p0: (abilityItem.name || auditLocalize("FALLOUTMAW.AuditRuntime.R0100", "Реактивный")), p1: (getActorAvailableEnergy(actor)), p2: (energyCost) }, "{p0}: недостаточно энергии ({p1} / {p2})."));
    return false;
  }

  let createdEffect = null;
  try {
    const previousEffects = getMatchingReactiveEffects(actor, abilityItem, abilityFunction);
    [createdEffect] = await actor.createEmbeddedDocuments("ActiveEffect", [
      buildReactiveEffectData(actor, abilityItem, abilityFunction, settings)
    ], { animate: false });
    if (!createdEffect) throw new Error("Reactive effect was not created.");

    if (settings.overloadEnergyCost > 0 && settings.overloadDurationSeconds > 0) {
      const overloaded = await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
        name: getAbilityOverloadName(abilityItem),
        energyCost: settings.overloadEnergyCost,
        durationSeconds: settings.overloadDurationSeconds
      });
      if (!overloaded) throw new Error("Reactive overload was not created.");
    }

    const previousIds = previousEffects.map(effect => effect.id).filter(Boolean);
    if (previousIds.length) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", previousIds, { animate: false });
    }
    return true;
  } catch (error) {
    if (createdEffect?.id) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", [createdEffect.id], { animate: false });
    }
    if (energyCost > 0) {
      await refundActorEnergyReceipt(actor, energyTransaction.receipt);
    }
    console.error(`${SYSTEM_ID} | Failed to activate Reactive`, error);
    ui.notifications.error(auditFormat("FALLOUTMAW.AuditRuntime.R0518", { p0: (abilityItem.name || auditLocalize("FALLOUTMAW.AuditRuntime.R0100", "Реактивный")) }, "{p0}: не удалось активировать способность."));
    return false;
  }
}

async function observeReactiveResourceSpent({ event } = {}) {
  if (String(event?.key ?? "") !== RESOURCE_EVENT_KEY) return [];
  const movementSpent = Math.max(0, toInteger(event?.data?.resources?.[MOVEMENT_RESOURCE_KEY]));
  if (movementSpent <= 0) return [];

  const actorUuid = String(event?.data?.actorUuid ?? "").trim();
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  if (!actor || !isReactiveAuthority(actor)) return [];

  const now = getWorldTime();
  const effects = Array.from(actor.effects ?? []).filter(effect => isLiveReactiveEffect(effect, now));
  if (!effects.length) return [];

  const results = [];
  for (const effect of effects) {
    const result = await queueReactiveEffectMutation(effect, movementSpent);
    if (result) results.push(result);
  }
  return results;
}

function queueReactiveEffectMutation(effect, movementSpent) {
  const key = String(effect?.uuid ?? effect?.id ?? "");
  const previous = reactiveEffectMutationQueues.get(key) ?? Promise.resolve(null);
  const operation = previous.then(
    () => advanceReactiveEffect(effect, movementSpent),
    () => advanceReactiveEffect(effect, movementSpent)
  );
  reactiveEffectMutationQueues.set(key, operation);
  return operation.finally(() => {
    if (reactiveEffectMutationQueues.get(key) === operation) reactiveEffectMutationQueues.delete(key);
  });
}

async function advanceReactiveEffect(effect, movementSpent) {
  const actor = effect?.parent;
  const currentEffect = actor?.effects?.get?.(effect.id) ?? effect;
  const data = currentEffect?.getFlag?.(SYSTEM_ID, REACTIVE_EFFECT_FLAG_KEY);
  if (!actor || !data || !isLiveReactiveEffect(currentEffect, getWorldTime())) return null;

  const {
    movementPointTotal,
    gainedActionPoints,
    movementPointProgress
  } = calculateReactiveActionPointReward({
    movementPointProgress: data.movementPointProgress,
    movementSpent,
    movementPointsPerActionPoint: data.movementPointsPerActionPoint,
    actionPointsPerThreshold: data.actionPointsPerThreshold
  });
  await currentEffect.update({
    [`flags.${SYSTEM_ID}.${REACTIVE_EFFECT_FLAG_KEY}.movementPointProgress`]: movementPointProgress
  }, { animate: false });

  if (gainedActionPoints <= 0) {
    return { actorUuid: actor.uuid, movementSpent, gainedActionPoints: 0, movementPointProgress };
  }

  try {
    const added = await addOneTimeResourcePoints(actor, "actionPoints", gainedActionPoints, { animate: false });
    if (added !== gainedActionPoints) throw new Error("Reactive one-time points were not persisted.");
  } catch (error) {
    await currentEffect.update({
      [`flags.${SYSTEM_ID}.${REACTIVE_EFFECT_FLAG_KEY}.movementPointProgress`]: movementPointTotal
    }, { animate: false });
    throw error;
  }

  return { actorUuid: actor.uuid, movementSpent, gainedActionPoints, movementPointProgress };
}

function buildReactiveEffectData(actor, abilityItem, abilityFunction, settings) {
  const startTime = getWorldTime();
  return {
    type: "base",
    name: abilityItem.name || auditLocalize("FALLOUTMAW.AuditRuntime.R0100", "Реактивный"),
    img: abilityItem.img || "systems/fallout-maw/assets/System/TokenActionHud/weapon-action-reload-and-recharge.webp",
    origin: abilityItem.uuid || actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: settings.durationSeconds,
      startTime
    },
    system: {
      changes: [{
        key: ATTACK_ACTION_POINT_MOVEMENT_LOSS_DISABLED_EFFECT_KEY,
        type: "add",
        value: "1",
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [REACTIVE_EFFECT_FLAG_KEY]: {
          sourceItemUuid: String(abilityItem.uuid ?? ""),
          abilityFunctionId: String(abilityFunction.id ?? ""),
          movementPointsPerActionPoint: settings.movementPointsPerActionPoint,
          actionPointsPerThreshold: settings.actionPointsPerThreshold,
          movementPointProgress: 0,
          expiresAt: startTime + settings.durationSeconds
        }
      }
    }
  };
}

/**
 * Convert actually spent Movement Points into the configured one-time Action Point reward.
 * The reward defaults to one so effects created before the setting was introduced
 * keep their original behaviour.
 */
export function calculateReactiveActionPointReward({
  movementPointProgress = 0,
  movementSpent = 0,
  movementPointsPerActionPoint = 4,
  actionPointsPerThreshold = 1
} = {}) {
  const threshold = Math.max(1, toInteger(movementPointsPerActionPoint ?? 4));
  const multiplier = normalizeReactiveActionPointsPerThreshold(actionPointsPerThreshold);
  const movementPointTotal = Math.max(0, toInteger(movementPointProgress))
    + Math.max(0, toInteger(movementSpent));
  const completedThresholds = Math.floor(movementPointTotal / threshold);
  return {
    movementPointTotal,
    gainedActionPoints: completedThresholds * multiplier,
    movementPointProgress: movementPointTotal % threshold
  };
}

function normalizeReactiveActionPointsPerThreshold(value = 1) {
  return Math.max(1, toInteger(value ?? 1));
}

function getMatchingReactiveEffects(actor, abilityItem, abilityFunction) {
  const sourceItemUuid = String(abilityItem?.uuid ?? "");
  const abilityFunctionId = String(abilityFunction?.id ?? "");
  return Array.from(actor?.effects ?? []).filter(effect => {
    const data = effect.getFlag?.(SYSTEM_ID, REACTIVE_EFFECT_FLAG_KEY);
    return data
      && String(data.sourceItemUuid ?? "") === sourceItemUuid
      && String(data.abilityFunctionId ?? "") === abilityFunctionId;
  });
}

function isLiveReactiveEffect(effect, now) {
  if (!effect || effect.disabled || effect.isSuppressed) return false;
  const data = effect.getFlag?.(SYSTEM_ID, REACTIVE_EFFECT_FLAG_KEY);
  return Boolean(data) && Number(data.expiresAt) > now;
}

function isReactiveAuthority(actor) {
  const users = Array.from(game.users ?? []).filter(user => user.active);
  const activeGms = users.filter(user => user.isGM);
  const candidates = activeGms.length
    ? activeGms
    : users.filter(user => actor.testUserPermission?.(user, "OWNER"));
  candidates.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return candidates[0]?.id === game.user?.id;
}

function getWorldTime() {
  return Math.max(0, Number(globalThis.game?.time?.worldTime) || 0);
}
