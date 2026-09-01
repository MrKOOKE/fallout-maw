import { SYSTEM_ID } from "../constants.mjs";
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

export const EXPLOSIVE_RESILIENCE_EVENT_OBSERVER_ID = "fallout-maw.fixed.explosiveResilience.damage";
export const EXPLOSIVE_RESILIENCE_EFFECT_FLAG_KEY = "explosiveResilience";

const DAMAGE_EVENT_KEY = "fallout-maw.damage.resolved";
const PACKAGE_OFFENSE = "offense";
const PACKAGE_DEFENSE = "defense";
const PACKAGE_KEYS = new Set([PACKAGE_OFFENSE, PACKAGE_DEFENSE]);
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const pendingActivations = new Set();

/** Damage is observed continuously; choosing a bonus is an ordinary manual activation. */
export function registerExplosiveResilienceRuntime() {
  return registerExplosiveResilienceEventObserver();
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
export async function observeExplosiveResilienceDamage({ event } = {}) {
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
  const results = [];
  for (const entry of getActorExplosiveResilienceEntries(actor)) {
    if (findExplosiveResilienceEffect(actor, entry)) continue;
    const previous = getExplosiveResilienceProgress(entry);
    const progress = Math.min(entry.settings.damageRequired, previous + incomingDamage);
    if (progress !== previous) await setExplosiveResilienceProgress(entry, progress);
    results.push({ progress, ready: progress >= entry.settings.damageRequired });
  }
  return results;
}

/** Activate one of the two packages only when the stored damage threshold is full. */
export async function activateExplosiveResilience({
  actor = null,
  abilityItem = null,
  abilityFunction = null,
  selectPackage = promptExplosiveResiliencePackage
} = {}) {
  const entry = buildExplosiveResilienceEntry(actor, abilityItem, abilityFunction);
  if (!entry) return false;
  if (findExplosiveResilienceEffect(actor, entry)) {
    notifyWarning(`${entry.abilityItem.name}: бонус уже действует.`);
    return false;
  }
  const progress = getExplosiveResilienceProgress(entry);
  if (progress < entry.settings.damageRequired) {
    notifyWarning(`${entry.abilityItem.name}: накоплено ${progress} / ${entry.settings.damageRequired}.`);
    return false;
  }

  const activationKey = `${entry.abilityItem.uuid ?? entry.abilityItem.id}:${getStateKey(entry.abilityFunction)}`;
  if (pendingActivations.has(activationKey)) return false;
  pendingActivations.add(activationKey);
  try {
    const packageKey = await selectPackage(entry);
    if (!PACKAGE_KEYS.has(packageKey)) return false;
    return applyExplosiveResiliencePackage(entry, packageKey);
  } finally {
    pendingActivations.delete(activationKey);
  }
}

export async function applyExplosiveResiliencePackage(entry = null, packageKey = "") {
  if (!entry?.actor || !PACKAGE_KEYS.has(packageKey)) return false;
  if (findExplosiveResilienceEffect(entry.actor, entry)) return false;
  if (getExplosiveResilienceProgress(entry) < entry.settings.damageRequired) return false;

  const [effect] = await entry.actor.createEmbeddedDocuments("ActiveEffect", [
    buildExplosiveResilienceEffectData(entry, packageKey)
  ], { animate: false });
  if (!effect) return false;
  try {
    await setExplosiveResilienceProgress(entry, 0);
  } catch (error) {
    await entry.actor.deleteEmbeddedDocuments?.("ActiveEffect", [effect.id], { animate: false });
    throw error;
  }
  return true;
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
    .map(abilityFunction => buildExplosiveResilienceEntry(actor, abilityItem, abilityFunction)));
}

function buildExplosiveResilienceEntry(actor, abilityItem, abilityFunction) {
  if (
    !actor
    || !abilityItem
    || abilityItem.parent !== actor
    || abilityFunction?.type !== ABILITY_FUNCTION_TYPES.fixed
    || abilityFunction?.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.explosiveResilience
  ) return null;
  return {
    actor,
    abilityItem,
    abilityFunction,
    settings: normalizeExplosiveResilienceSettings(abilityFunction.fixedSettings)
  };
}

async function setExplosiveResilienceProgress(entry, damage = 0) {
  const state = foundry.utils.deepClone(getAbilityState(entry.abilityItem));
  state[getStateKey(entry.abilityFunction)] = {
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.explosiveResilience,
    damage: Math.max(0, Number(damage) || 0)
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

async function promptExplosiveResiliencePackage(entry) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return null;
  const { abilityItem, settings } = entry;
  return DialogV2.wait({
    window: { title: abilityItem.name, icon: "fa-solid fa-shield-halved" },
    classes: ["fallout-maw", "fallout-maw-explosive-resilience-dialog"],
    content: `
      <section class="fallout-maw-fixed-function-dialog">
        <p>Выберите бонус на ${settings.durationSeconds} сек.</p>
        <dl>
          <dt><strong>Натиск</strong></dt>
          <dd>Урон +${settings.offenseDamagePercent}%, точность +${settings.offenseAccuracy}, ОД +${settings.offenseActionPoints}.</dd>
          <dt><strong>Оборона</strong></dt>
          <dd>Сопротивления +${escapeHtml(settings.defenseResistanceFormula)}, уклонение +${settings.defenseDodge}, ОП +${settings.defenseMovementPoints}.</dd>
        </dl>
      </section>
    `,
    buttons: [
      {
        action: PACKAGE_OFFENSE,
        label: "Натиск",
        icon: "fa-solid fa-burst",
        callback: () => PACKAGE_OFFENSE
      },
      {
        action: PACKAGE_DEFENSE,
        label: "Оборона",
        icon: "fa-solid fa-shield",
        callback: () => PACKAGE_DEFENSE
      },
      {
        action: "cancel",
        label: globalThis.game?.i18n?.localize?.("FALLOUTMAW.Common.Cancel") || "Отмена",
        icon: "fa-solid fa-xmark",
        callback: () => null
      }
    ],
    rejectClose: false,
    modal: true,
    position: { width: 460 }
  });
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

function notifyWarning(message = "") {
  globalThis.ui?.notifications?.warn?.(message);
}

function escapeHtml(value = "") {
  const text = String(value ?? "");
  if (globalThis.foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(text);
  return text.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
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
