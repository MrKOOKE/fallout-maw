import { SYSTEM_ID } from "../constants.mjs";
import {
  registerLethalDamagePreventionHandler,
  registerUnconsciousnessPreventionHandler
} from "../combat/damage-hub.mjs";
import {
  canActorSpendEnergy,
  ENERGY_RESOURCE_KEY,
  getActorEnergy,
  restoreActorEnergy,
  runActorEnergyMutation
} from "../combat/energy-resource.mjs";
import { getCharacteristicSettings } from "../settings/accessors.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizeLastDropSettings
} from "../settings/abilities.mjs";
import { UNCONSCIOUSNESS_IMMUNITY_EFFECT_KEY } from "../utils/active-effect-keys.mjs";
import { isLimbPhysicallyMissing } from "../utils/limb-state.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  applyAbilityOverloadEffect,
  getAbilityOverloadEnergyCost,
  getAbilityOverloadName
} from "./overload.mjs";
import { isPhantomEntity } from "./phantom-entity.mjs";

export const LAST_DROP_EFFECT_FLAG_KEY = "lastDrop";

const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const ALL_DAMAGE_RESISTANCE_EFFECT_KEY = "system.damageResistanceBonuses.all.all";
const pendingLastDropActivations = new Map();
let lastDropRuntimeRegistered = false;

/** Register before ordinary last-chance handlers so the emergency state can redirect lethal damage. */
export function registerLastDropRuntime() {
  if (lastDropRuntimeRegistered) return;
  lastDropRuntimeRegistered = true;
  registerLethalDamagePreventionHandler(preventLastDropLethalDamage);
  registerUnconsciousnessPreventionHandler(preventLastDropUnconsciousness);
}

/** An active HUD toggle intentionally disables only the unconsciousness trigger. */
export async function toggleLastDropUnconsciousnessTrigger(abilityItem, abilityFunction) {
  if (!abilityItem || !abilityFunction) return false;
  const state = cloneAbilityState(abilityItem);
  const key = getLastDropStateKey(abilityFunction);
  const previous = state[key] && typeof state[key] === "object" ? state[key] : {};
  state[key] = {
    ...previous,
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.lastDrop,
    active: previous.active !== true
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  return true;
}

export function getLastDropAbilityProgressEntry(abilityItem, abilityFunction) {
  const disabled = isLastDropUnconsciousnessTriggerDisabled(abilityItem, abilityFunction);
  return {
    key: getLastDropStateKey(abilityFunction),
    label: "Потеря сознания",
    value: disabled ? "не активирует" : "активирует"
  };
}

export function isLastDropUnconsciousnessTriggerDisabled(abilityItem, abilityFunction) {
  return getLastDropAbilityState(abilityItem)?.[getLastDropStateKey(abilityFunction)]?.active === true;
}

export async function preventLastDropUnconsciousness({ actor = null } = {}) {
  if (!canManageActor(actor) || isPhantomEntity(actor)) {
    return { handled: false, prevented: false };
  }
  if (findLastDropEffect(actor)) return { handled: true, prevented: true };
  const entry = getActorLastDropEntries(actor).find(candidate => (
    !isLastDropUnconsciousnessTriggerDisabled(candidate.abilityItem, candidate.abilityFunction)
  ));
  if (!entry || !(await activateLastDrop(entry))) return { handled: false, prevented: false };
  return { handled: true, prevented: true };
}

export async function preventLastDropLethalDamage({
  actor = null,
  estimate = {},
  requests = [],
  amount = 0
} = {}) {
  if (!canManageActor(actor) || isPhantomEntity(actor)) {
    return { handled: false, prevented: false };
  }
  const existingEffect = findLastDropEffect(actor);
  const entry = existingEffect
    ? getActorLastDropEntryForEffect(actor, existingEffect)
    : getActorLastDropEntries(actor).at(0);
  if (!entry) return { handled: false, prevented: false };
  if (!existingEffect && !(await activateLastDrop(entry))) {
    return { handled: false, prevented: false };
  }

  const plan = buildLastDropRedistributionPlan({
    actor,
    estimate,
    requests,
    amount,
    minimumPercent: entry.settings.redistributionMinimumPercent
  });
  if (!plan.complete) return { handled: false, prevented: false };
  await actor.update(plan.updates, {
    falloutMawSkipDamageStatusSync: true,
    falloutMawLastDropRedistribution: true
  });
  return {
    handled: true,
    prevented: true,
    redirectedAmount: plan.amount,
    redirectedLimbs: plan.limbs
  };
}

/** Distribute one lethal, already-mitigated packet across eligible other limbs. */
export function buildLastDropRedistributionPlan({
  actor = null,
  estimate = {},
  requests = [],
  amount = 0,
  minimumPercent = -50
} = {}) {
  const damage = Math.max(0, Math.round(Number(amount) || 0));
  if (!actor || damage <= 0) return createRedistributionPlan(damage);

  const excluded = new Set(Array.from(requests ?? [], request => (
    String(request?.limbKey ?? "").trim()
  )).filter(Boolean));
  for (const [key, state] of estimate?.limbStates ?? []) {
    const limb = actor.system?.limbs?.[key];
    if (!limb?.critical) continue;
    if (toInteger(state?.nextValue) <= toInteger(state?.min ?? limb.min)) excluded.add(key);
  }

  const thresholdPercent = Math.max(-100, Math.min(100, Number(minimumPercent) || 0));
  const candidates = [];
  for (const [key, limb] of Object.entries(actor.system?.limbs ?? {})) {
    if (excluded.has(key) || !limb || isLimbPhysicallyMissing(actor, key)) continue;
    const maximum = Math.max(0, toInteger(limb.max));
    if (maximum <= 0) continue;
    const value = toInteger(limb.value);
    const boundary = Math.max(toInteger(limb.min), Math.ceil((maximum * thresholdPercent) / 100));
    const capacity = Math.max(0, value - boundary);
    if (capacity <= 0) continue;
    candidates.push({ key, value, boundary, capacity });
  }
  candidates.sort((left, right) => right.capacity - left.capacity);
  const totalCapacity = candidates.reduce((total, candidate) => total + candidate.capacity, 0);
  if (totalCapacity < damage) return createRedistributionPlan(damage, { capacity: totalCapacity });

  let remaining = damage;
  let capacity = totalCapacity;
  const updates = {};
  const limbs = [];
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    const share = Math.min(
      candidate.capacity,
      remaining,
      Math.max(1, Math.ceil((remaining * candidate.capacity) / capacity))
    );
    if (share <= 0) continue;
    updates[`system.limbs.${candidate.key}.value`] = candidate.value - share;
    limbs.push({ key: candidate.key, amount: share });
    remaining -= share;
    capacity -= candidate.capacity;
  }
  return createRedistributionPlan(damage, {
    complete: remaining === 0,
    capacity: totalCapacity,
    updates,
    limbs
  });
}

export function buildLastDropEffectChanges(actor, settings = {}, { characteristicKeys = null } = {}) {
  const normalized = normalizeLastDropSettings(settings);
  const keys = characteristicKeys ?? getLastDropCharacteristicKeys(actor);
  const changes = [{
    key: UNCONSCIOUSNESS_IMMUNITY_EFFECT_KEY,
    type: "add",
    value: "1",
    phase: "initial",
    priority: null
  }];
  for (const key of new Set(Array.from(keys ?? [], value => String(value ?? "").trim()).filter(Boolean))) {
    changes.push({
      key: `system.characteristics.${key}`,
      type: "add",
      value: normalized.characteristicBonusFormula,
      phase: "initial",
      priority: null
    });
  }
  changes.push({
    key: ALL_DAMAGE_RESISTANCE_EFFECT_KEY,
    type: "add",
    value: normalized.resistanceBonusFormula,
    phase: "initial",
    priority: null
  });
  return changes;
}

export function findLastDropEffect(actor, { abilityItemId = "", functionId = "" } = {}) {
  const now = Math.max(0, Number(globalThis.game?.time?.worldTime) || 0);
  return Array.from(actor?.effects ?? []).find(effect => {
    if (!effect || effect.disabled || effect.duration?.expired === true || effect.active === false) return false;
    const data = getLastDropEffectData(effect);
    if (!data) return false;
    if (abilityItemId && String(data.abilityItemId ?? "") !== String(abilityItemId)) return false;
    if (functionId && String(data.functionId ?? "") !== String(functionId)) return false;
    const duration = Number(effect.duration?.seconds ?? effect.duration?.value);
    const start = Number(effect.duration?.startTime ?? effect.start?.time ?? data.createdAt);
    return !Number.isFinite(duration)
      || duration <= 0
      || !Number.isFinite(start)
      || start + duration > now;
  }) ?? null;
}

function getActorLastDropEntries(actor) {
  const items = actor?.itemTypes?.ability
    ?? Array.from(actor?.items ?? []).filter(item => item?.type === "ability");
  return items.flatMap(abilityItem => normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .filter(abilityFunction => (
      abilityFunction.type === ABILITY_FUNCTION_TYPES.fixed
      && abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lastDrop
    ))
    .map(abilityFunction => ({
      actor,
      abilityItem,
      abilityFunction,
      settings: normalizeLastDropSettings(abilityFunction.fixedSettings)
    })));
}

function getActorLastDropEntryForEffect(actor, effect) {
  const data = getLastDropEffectData(effect);
  return getActorLastDropEntries(actor).find(entry => (
    String(entry.abilityItem.id ?? "") === String(data?.abilityItemId ?? "")
    && String(entry.abilityFunction.id ?? "") === String(data?.functionId ?? "")
  )) ?? null;
}

function activateLastDrop(entry) {
  const actorKey = String(entry?.actor?.uuid ?? entry?.actor?.id ?? "").trim();
  if (!actorKey) return Promise.resolve(false);
  const previous = pendingLastDropActivations.get(actorKey);
  if (previous) return previous;
  const operation = activateLastDropNow(entry).finally(() => {
    if (pendingLastDropActivations.get(actorKey) === operation) {
      pendingLastDropActivations.delete(actorKey);
    }
  });
  pendingLastDropActivations.set(actorKey, operation);
  return operation;
}

async function activateLastDropNow(entry) {
  const { actor, abilityItem, abilityFunction, settings } = entry;
  if (findLastDropEffect(actor)) return true;
  const energyCost = settings.energyCost + getAbilityOverloadEnergyCost(actor, abilityItem, abilityFunction);
  if (!(await spendLastDropEnergy(actor, energyCost))) return false;

  let createdEffect = null;
  try {
    [createdEffect] = await actor.createEmbeddedDocuments("ActiveEffect", [
      buildLastDropEffectData(entry)
    ], { animate: false });
    if (!createdEffect) throw new Error("Emergency effect was not created.");
    if (settings.overloadEnergyCost > 0 && settings.overloadDurationSeconds > 0) {
      const overloaded = await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
        name: getAbilityOverloadName(abilityItem),
        energyCost: settings.overloadEnergyCost,
        durationSeconds: settings.overloadDurationSeconds
      });
      if (!overloaded) throw new Error("Ability overload was not created.");
    }
    return true;
  } catch (error) {
    if (createdEffect?.id) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", [createdEffect.id], { animate: false });
    }
    if (energyCost > 0) {
      await restoreActorEnergy(actor, energyCost, { falloutMawAbilityResourceRefund: true });
    }
    console.error("Fallout MaW | Failed to activate Last Drop", error);
    return false;
  }
}

function spendLastDropEnergy(actor, requestedCost = 0) {
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

function buildLastDropEffectData(entry) {
  const startTime = Math.max(0, Number(globalThis.game?.time?.worldTime) || 0);
  return {
    type: "base",
    name: entry.abilityItem.name || "До последней капли",
    img: entry.abilityItem.img || "icons/svg/shield.svg",
    origin: entry.abilityItem.uuid || entry.actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: entry.settings.durationSeconds,
      startTime
    },
    system: { changes: buildLastDropEffectChanges(entry.actor, entry.settings) },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [LAST_DROP_EFFECT_FLAG_KEY]: {
          abilityItemId: String(entry.abilityItem.id ?? ""),
          functionId: String(entry.abilityFunction.id ?? ""),
          fixedKey: ABILITY_FIXED_FUNCTION_KEYS.lastDrop,
          createdAt: startTime
        }
      }
    }
  };
}

function getLastDropCharacteristicKeys(actor) {
  const configured = getCharacteristicSettings().map(entry => String(entry?.key ?? "").trim()).filter(Boolean);
  return Array.from(new Set([
    ...configured,
    ...Object.keys(actor?.system?.characteristics ?? {}).filter(Boolean)
  ]));
}

function getLastDropEffectData(effect) {
  return effect?.getFlag?.(SYSTEM_ID, LAST_DROP_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[LAST_DROP_EFFECT_FLAG_KEY]
    ?? null;
}

function getLastDropAbilityState(abilityItem) {
  const state = abilityItem?.getFlag?.(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? abilityItem?.flags?.[SYSTEM_ID]?.[ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY];
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

function cloneAbilityState(abilityItem) {
  const state = getLastDropAbilityState(abilityItem);
  return globalThis.foundry?.utils?.deepClone?.(state) ?? structuredClone(state);
}

function getLastDropStateKey(abilityFunction = {}) {
  return [abilityFunction?.id, abilityFunction?.fixedKey]
    .map(value => String(value ?? "").trim())
    .filter(Boolean)
    .join(":");
}

function createRedistributionPlan(amount, {
  complete = false,
  capacity = 0,
  updates = {},
  limbs = []
} = {}) {
  return {
    amount,
    complete,
    capacity,
    updates,
    limbs
  };
}

function canManageActor(actor) {
  return Boolean(actor && (globalThis.game?.user?.isGM || actor.isOwner));
}
