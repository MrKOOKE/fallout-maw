import { SYSTEM_ID } from "../constants.mjs";
import {
  REACTION_RESULT,
  registerReactionProvider,
  requestReactionEvent
} from "../combat/reaction-hub.mjs";
import { getEventParticipantActorUuid } from "../events/event-reaction-schema.mjs";
import { getSystemEventNumericValue } from "../events/event-values.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import {
  ABILITY_ACCUMULATION_VALUE_SOURCES,
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizeExplosiveResilienceSettings
} from "../settings/abilities.mjs";
import { isPhantomEntity } from "./phantom-entity.mjs";

export const EXPLOSIVE_RESILIENCE_REACTION_PROVIDER_ID = "fallout-maw.fixed.explosiveResilience";
export const EXPLOSIVE_RESILIENCE_EVENT_OBSERVER_ID = "fallout-maw.fixed.explosiveResilience.damage";
export const EXPLOSIVE_RESILIENCE_CHOICE_EVENT_KEY = "fallout-maw.fixed.explosiveResilience.ready";
export const EXPLOSIVE_RESILIENCE_EFFECT_FLAG_KEY = "explosiveResilience";

const DAMAGE_EVENT_KEY = "fallout-maw.damage.resolved";
const PACKAGE_OFFENSE = "offense";
const PACKAGE_DEFENSE = "defense";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;

/** Register both halves: unconditional damage observation and the owner-routed choice. */
export function registerExplosiveResilienceRuntime() {
  registerExplosiveResilienceReactionProvider();
  return registerExplosiveResilienceEventObserver();
}

export function registerExplosiveResilienceReactionProvider() {
  return registerReactionProvider({
    id: EXPLOSIVE_RESILIENCE_REACTION_PROVIDER_ID,
    collect: collectExplosiveResilienceOffers,
    execute: executeExplosiveResilienceOffer
  });
}

export function registerExplosiveResilienceEventObserver() {
  return registerSystemEventObserver({
    id: EXPLOSIVE_RESILIENCE_EVENT_OBSERVER_ID,
    eventKeys: [DAMAGE_EVENT_KEY],
    priority: 200,
    observe: observeExplosiveResilienceDamage
  });
}

/**
 * Count damage after Defense but before Resistance, barriers,
 * final-damage interception, and health clamping.
 */
export async function observeExplosiveResilienceDamage({ event } = {}, {
  requestChoice = requestReactionEvent
} = {}) {
  if (String(event?.key ?? "") !== DAMAGE_EVENT_KEY) return [];
  if (event?.outcome?.cancelled === true || event?.outcome?.success === false) return [];
  const actorUuid = getEventParticipantActorUuid(event?.target);
  const incomingDamage = Math.max(0, Number(getSystemEventNumericValue(
    ABILITY_ACCUMULATION_VALUE_SOURCES.damageBeforeResistance,
    event
  )) || 0);
  if (!actorUuid || incomingDamage <= 0) return [];

  const actor = await resolveUuid(actorUuid);
  if (!actor || isPhantomEntity(actor)) return [];
  const rootId = String(event?.rootId ?? event?.eventId ?? "").trim();
  const results = [];
  for (const entry of getActorExplosiveResilienceEntries(actor)) {
    if (findExplosiveResilienceEffect(actor, entry)) continue;
    const state = getEntryState(entry);
    const previous = getExplosiveResilienceProgress(entry);
    const progress = Math.min(entry.settings.damageRequired, previous + incomingDamage);
    const alreadyOfferedForRoot = progress >= entry.settings.damageRequired
      && rootId
      && String(state.offeredRootId ?? "") === rootId;
    if (progress !== previous || (progress >= entry.settings.damageRequired && !alreadyOfferedForRoot)) {
      await setExplosiveResilienceProgress(entry, progress, {
        offeredRootId: progress >= entry.settings.damageRequired ? rootId : ""
      });
    }
    if (progress < entry.settings.damageRequired || alreadyOfferedForRoot) {
      results.push({ progress, choiceRequested: false });
      continue;
    }

    const activationId = String(event?.eventId ?? foundry.utils.randomID());
    await requestChoice(
      EXPLOSIVE_RESILIENCE_CHOICE_EVENT_KEY,
      buildChoiceRequestContext(entry, event, activationId)
    );
    results.push({ progress, choiceRequested: true });
  }
  return results;
}

export async function collectExplosiveResilienceOffers({
  eventKey = "",
  context = {}
} = {}) {
  if (String(eventKey ?? "") !== EXPLOSIVE_RESILIENCE_CHOICE_EVENT_KEY) return [];
  const actorUuid = String(context?.actorUuid ?? "").trim();
  if (!actorUuid) return [];
  const actor = await resolveUuid(actorUuid);
  if (!actor || isPhantomEntity(actor)) return [];
  const entry = findExplosiveResilienceEntry(actor, context);
  if (!entry || findExplosiveResilienceEffect(actor, entry)) return [];
  if (getExplosiveResilienceProgress(entry) < entry.settings.damageRequired) return [];
  return [
    buildPackageOffer(entry, PACKAGE_OFFENSE, context),
    buildPackageOffer(entry, PACKAGE_DEFENSE, context)
  ];
}

export async function executeExplosiveResilienceOffer({ offer = {} } = {}) {
  const actor = await resolveUuid(offer.actorUuid);
  const entry = getActorExplosiveResilienceEntries(actor).find(candidate => (
    String(candidate.abilityItem?.id ?? "") === String(offer.abilityItemId ?? "")
    && String(candidate.abilityFunction?.id ?? "") === String(offer.abilityFunctionId ?? "")
  ));
  if (!actor || !entry || findExplosiveResilienceEffect(actor, entry)) return { handled: false };
  if (getExplosiveResilienceProgress(entry) < entry.settings.damageRequired) return { handled: false };
  const packageKey = [PACKAGE_OFFENSE, PACKAGE_DEFENSE].includes(offer.packageKey)
    ? offer.packageKey
    : "";
  if (!packageKey) return { handled: false };

  const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [
    buildExplosiveResilienceEffectData(entry, packageKey)
  ], { animate: false });
  if (!effect) return { handled: false };
  try {
    await setExplosiveResilienceProgress(entry, 0, { offeredRootId: "" });
  } catch (error) {
    await actor.deleteEmbeddedDocuments?.("ActiveEffect", [effect.id], { animate: false });
    throw error;
  }
  return {
    handled: true,
    status: REACTION_RESULT.success,
    reason: `explosiveResilience:${packageKey}`
  };
}

export function getExplosiveResilienceProgressEntry(abilityItem, abilityFunction) {
  const settings = normalizeExplosiveResilienceSettings(abilityFunction?.fixedSettings);
  const entry = { abilityItem, abilityFunction, settings };
  return {
    key: getStateKey(abilityFunction),
    label: "Получено урона",
    current: Math.min(settings.damageRequired, getExplosiveResilienceProgress(entry)),
    required: settings.damageRequired
  };
}

export function buildExplosiveResilienceEffectChanges(settings = {}, packageKey = "") {
  const normalized = normalizeExplosiveResilienceSettings(settings);
  if (packageKey === PACKAGE_OFFENSE) {
    return [
      change("system.combat.damagePercent", normalized.offenseDamagePercent),
      change("system.combat.accuracy", normalized.offenseAccuracy),
      change("system.resources.actionPoints.bonus", normalized.offenseActionPoints)
    ].filter(entry => Number(entry.value) !== 0);
  }
  if (packageKey === PACKAGE_DEFENSE) {
    return [
      change("system.damageResistanceBonuses.all.all", normalized.defenseResistanceFormula),
      change("system.resources.dodge.bonus", normalized.defenseDodge),
      change("system.resources.movementPoints.bonus", normalized.defenseMovementPoints)
    ].filter(entry => String(entry.value).trim() && Number(entry.value) !== 0);
  }
  return [];
}

function getActorExplosiveResilienceEntries(actor) {
  if (!actor) return [];
  const abilityItems = actor.itemTypes?.ability
    ?? Array.from(actor.items ?? []).filter(item => item?.type === "ability");
  return abilityItems.flatMap(abilityItem => normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .filter(abilityFunction => (
      abilityFunction.type === ABILITY_FUNCTION_TYPES.fixed
      && abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.explosiveResilience
    ))
    .map(abilityFunction => ({
      actor,
      abilityItem,
      abilityFunction,
      settings: normalizeExplosiveResilienceSettings(abilityFunction.fixedSettings)
    })));
}

function findExplosiveResilienceEntry(actor, identity = {}) {
  return getActorExplosiveResilienceEntries(actor).find(candidate => (
    String(candidate.abilityItem?.id ?? "") === String(identity?.abilityItemId ?? "")
    && String(candidate.abilityFunction?.id ?? "") === String(identity?.abilityFunctionId ?? "")
  )) ?? null;
}

async function setExplosiveResilienceProgress(entry, damage = 0, { offeredRootId = "" } = {}) {
  const state = foundry.utils.deepClone(getAbilityState(entry.abilityItem));
  state[getStateKey(entry.abilityFunction)] = {
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.explosiveResilience,
    damage: Math.max(0, Number(damage) || 0),
    offeredRootId: String(offeredRootId ?? "").trim()
  };
  await entry.abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
}

function getExplosiveResilienceProgress(entry) {
  return Math.max(0, Number(getEntryState(entry)?.damage) || 0);
}

function getEntryState(entry) {
  return getAbilityState(entry?.abilityItem)?.[getStateKey(entry?.abilityFunction)] ?? {};
}

function getAbilityState(abilityItem) {
  const state = abilityItem?.getFlag?.(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? abilityItem?.flags?.[SYSTEM_ID]?.[ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY];
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

function getStateKey(abilityFunction = {}) {
  return [abilityFunction?.id, abilityFunction?.fixedKey]
    .map(value => String(value ?? "").trim())
    .filter(Boolean)
    .join(":");
}

function buildChoiceRequestContext(entry, event = {}, activationId = "") {
  const id = String(activationId ?? "").trim() || foundry.utils.randomID();
  return {
    falloutMawSemanticReactionAdapted: true,
    actorUuid: entry.actor.uuid,
    abilityItemId: entry.abilityItem.id,
    abilityFunctionId: entry.abilityFunction.id,
    activationId: id,
    rootId: String(event?.rootId ?? ""),
    title: entry.abilityItem.name,
    message: "Выберите один бонус Взрывной стойкости.",
    semanticEvent: {
      key: EXPLOSIVE_RESILIENCE_CHOICE_EVENT_KEY,
      eventId: id,
      rootId: String(event?.rootId ?? id),
      source: { actorUuid: entry.actor.uuid },
      target: { actorUuid: entry.actor.uuid }
    }
  };
}

function buildPackageOffer(entry, packageKey, context = {}) {
  const offense = packageKey === PACKAGE_OFFENSE;
  const label = offense ? "Натиск" : "Оборона";
  const description = offense
    ? `Урон +${entry.settings.offenseDamagePercent}%, точность +${entry.settings.offenseAccuracy}, ОД +${entry.settings.offenseActionPoints}.`
    : `Сопротивления +${entry.settings.defenseResistanceFormula}, уклонение +${entry.settings.defenseDodge}, ОП +${entry.settings.defenseMovementPoints}.`;
  return {
    actorUuid: entry.actor.uuid,
    offerId: [
      EXPLOSIVE_RESILIENCE_REACTION_PROVIDER_ID,
      entry.abilityItem.id,
      entry.abilityFunction.id,
      String(context?.activationId ?? context?.rootId ?? ""),
      packageKey
    ].join(":"),
    label: `${entry.abilityItem.name}: ${label}`,
    description,
    img: entry.abilityItem.img || "icons/svg/shield.svg",
    costLines: [`Длительность: ${entry.settings.durationSeconds} сек.`],
    allowUnconscious: true,
    allowDead: false,
    abilityItemId: entry.abilityItem.id,
    abilityFunctionId: entry.abilityFunction.id,
    packageKey
  };
}

function buildExplosiveResilienceEffectData(entry, packageKey) {
  const packageLabel = packageKey === PACKAGE_OFFENSE ? "Натиск" : "Оборона";
  const worldTime = Math.max(0, Number(game.time?.worldTime) || 0);
  return {
    type: "base",
    name: `${entry.abilityItem.name}: ${packageLabel}`,
    img: entry.abilityItem.img || "icons/svg/shield.svg",
    origin: entry.abilityItem.uuid ?? entry.actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    start: { time: worldTime },
    duration: {
      value: entry.settings.durationSeconds,
      units: "seconds",
      expiry: null,
      expired: false
    },
    system: {
      changes: buildExplosiveResilienceEffectChanges(entry.settings, packageKey)
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [EXPLOSIVE_RESILIENCE_EFFECT_FLAG_KEY]: {
          abilityItemId: entry.abilityItem.id,
          functionId: entry.abilityFunction.id,
          packageKey
        }
      }
    }
  };
}

function findExplosiveResilienceEffect(actor, entry) {
  return Array.from(actor?.effects ?? []).find(effect => {
    if (!isEffectActive(effect)) return false;
    const data = effect?.getFlag?.(SYSTEM_ID, EXPLOSIVE_RESILIENCE_EFFECT_FLAG_KEY)
      ?? effect?.flags?.[SYSTEM_ID]?.[EXPLOSIVE_RESILIENCE_EFFECT_FLAG_KEY];
    return data
      && String(data.abilityItemId ?? "") === String(entry.abilityItem?.id ?? "")
      && String(data.functionId ?? "") === String(entry.abilityFunction?.id ?? "");
  }) ?? null;
}

function isEffectActive(effect) {
  if (!effect || effect.disabled || effect.active === false || effect.duration?.expired === true) return false;
  const duration = Number(effect.duration?.value ?? effect.duration?.seconds);
  const start = Number(effect.start?.time ?? effect.duration?.startTime);
  return !(duration > 0 && Number.isFinite(start) && Number(game.time?.worldTime) >= start + duration);
}

function change(key, value) {
  return {
    key,
    type: "add",
    value: String(value),
    phase: "initial",
    priority: null
  };
}

async function resolveUuid(uuid = "") {
  const value = String(uuid ?? "").trim();
  if (!value || typeof globalThis.fromUuid !== "function") return null;
  try {
    return await globalThis.fromUuid(value);
  } catch (_error) {
    return null;
  }
}
