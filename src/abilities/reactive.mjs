import { SYSTEM_ID } from "../constants.mjs";
import {
  canActorSpendEnergy,
  ENERGY_RESOURCE_KEY,
  getActorEnergy,
  restoreActorEnergy,
  runActorEnergyMutation
} from "../combat/energy-resource.mjs";
import { MOVEMENT_RESOURCE_KEY } from "../combat/movement-resources.mjs";
import { ONE_TIME_ACTION_POINTS_KEY } from "../combat/reaction-resources.mjs";
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
  if (!(await spendReactiveEnergy(actor, energyCost))) {
    ui.notifications.warn(`${abilityItem.name || "Реактивный"}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
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
      await restoreActorEnergy(actor, energyCost, { falloutMawAbilityResourceRefund: true });
    }
    console.error(`${SYSTEM_ID} | Failed to activate Reactive`, error);
    ui.notifications.error(`${abilityItem.name || "Реактивный"}: не удалось активировать способность.`);
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

  const threshold = Math.max(1, toInteger(data.movementPointsPerActionPoint ?? 4));
  const total = Math.max(0, toInteger(data.movementPointProgress)) + Math.max(0, toInteger(movementSpent));
  const gainedActionPoints = Math.floor(total / threshold);
  const movementPointProgress = total % threshold;
  await currentEffect.update({
    [`flags.${SYSTEM_ID}.${REACTIVE_EFFECT_FLAG_KEY}.movementPointProgress`]: movementPointProgress
  }, { animate: false });

  if (gainedActionPoints <= 0) {
    return { actorUuid: actor.uuid, movementSpent, gainedActionPoints: 0, movementPointProgress };
  }

  try {
    await actor.createEmbeddedDocuments("ActiveEffect", [
      buildOneTimeActionPointEffectData(actor, gainedActionPoints)
    ], { animate: false });
  } catch (error) {
    await currentEffect.update({
      [`flags.${SYSTEM_ID}.${REACTIVE_EFFECT_FLAG_KEY}.movementPointProgress`]: total
    }, { animate: false });
    throw error;
  }

  return { actorUuid: actor.uuid, movementSpent, gainedActionPoints, movementPointProgress };
}

function buildReactiveEffectData(actor, abilityItem, abilityFunction, settings) {
  const startTime = getWorldTime();
  return {
    type: "base",
    name: abilityItem.name || "Реактивный",
    img: abilityItem.img || "icons/svg/upgrade.svg",
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
          movementPointProgress: 0,
          expiresAt: startTime + settings.durationSeconds
        }
      }
    }
  };
}

function buildOneTimeActionPointEffectData(actor, value) {
  return {
    type: "base",
    name: "Одноразовые ОД",
    img: "icons/svg/upgrade.svg",
    origin: actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: {
      changes: [{
        key: ONE_TIME_ACTION_POINTS_KEY,
        type: "add",
        value: String(Math.max(0, toInteger(value))),
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        oneTimeActionPoints: { source: REACTIVE_EFFECT_FLAG_KEY }
      }
    }
  };
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

function spendReactiveEnergy(actor, requestedCost = 0) {
  const cost = Math.max(0, toInteger(requestedCost));
  return runActorEnergyMutation(actor, async () => {
    if (!canActorSpendEnergy(actor, cost)) return false;
    if (cost <= 0) return true;
    const resource = actor.system?.resources?.[ENERGY_RESOURCE_KEY];
    if (!resource) return false;
    const value = Math.max(toInteger(resource.min), getActorEnergy(actor) - cost);
    const changes = { [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: value };
    if (Object.hasOwn(resource, "spent")) {
      changes[`system.resources.${ENERGY_RESOURCE_KEY}.spent`] = Math.max(0, toInteger(resource.max) - value);
    }
    await actor.update(changes);
    return true;
  });
}

function getWorldTime() {
  return Math.max(0, Number(globalThis.game?.time?.worldTime) || 0);
}
