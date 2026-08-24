import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizeLivingSteelSettings
} from "../settings/abilities.mjs";
import {
  getActiveSceneWorldTimeActors,
  registerWorldTimeActorCandidateIndex
} from "../time/world-time-actor-index.mjs";
import { registerQueuedWorldTimeFinalizer } from "../time/world-time-queue.mjs";
import { composePreparedSkillValue } from "../utils/skill-value.mjs";

export const LIVING_STEEL_EFFECT_FLAG_KEY = "livingSteel";
export const LIVING_STEEL_RESILIENCE_EFFECT_FLAG_KEY = "livingSteelResilience";
export const LIVING_STEEL_DAMAGE_INTERCEPTOR_ID = "fallout-maw.fixed.livingSteel";
export const LIVING_STEEL_EXPIRY_EVENT = "fallout-maw.livingSteelInactivity";

const LIVING_STEEL_EFFECT_NAME = "Живая сталь";
const LIVING_STEEL_RESILIENCE_EFFECT_NAME = "Живая сталь: Стойкость";
const ACTIVE_EFFECT_SHOW_ICON_NEVER = 0;
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
export const LIVING_STEEL_RESILIENCE_BONUS_KEY = "system.skills.resilience.bonus";

let livingSteelEffectLifecycleRegistered = false;
let livingSteelEffectActorIndex = null;
const pendingLivingSteelBonusSyncs = new Map();

/**
 * Keep the one visible tracker effect alive while queued historical damage is
 * replayed. Core refreshes ordinary time-based effects before system
 * updateWorldTime hooks, so this dedicated event is refreshed only after every
 * queued world-time processor has finished.
 */
export function registerLivingSteelEffectLifecycle() {
  if (livingSteelEffectLifecycleRegistered) return;
  CONFIG.ActiveEffect.expiryEvents[LIVING_STEEL_EXPIRY_EVENT] = "Живая сталь: без повреждений";
  livingSteelEffectActorIndex ??= registerWorldTimeActorCandidateIndex(actorHasLivingSteelTrackerEffect);
  registerQueuedWorldTimeFinalizer(expireInactiveLivingSteelEffects);
  Hooks.on("updateActor", requestLivingSteelBonusSyncFromActorUpdate);
  for (const hookName of ["createItem", "updateItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(hookName, (document, ...args) => requestLivingSteelBonusSyncFromEmbeddedDocument(hookName, document, ...args));
  }
  Hooks.once("ready", synchronizeActiveLivingSteelBonuses);
  livingSteelEffectLifecycleRegistered = true;
}

export function calculateLivingSteelThreshold(actor, settings = {}, { weakened = false, health = null } = {}) {
  return calculateLivingSteelThresholdFromNormalizedSettings(
    actor,
    normalizeLivingSteelSettings(settings),
    { weakened, health }
  );
}

function calculateLivingSteelThresholdFromNormalizedSettings(actor, settings, { weakened = false, health = null } = {}) {
  const skill = actor?.system?.skills?.resilience ?? {};
  const bonusEffect = findLivingSteelResilienceEffect(actor);
  const hasPreparedComponents = Object.hasOwn(skill, "base") && Object.hasOwn(skill, "bonus");
  const appliedBonus = hasPreparedComponents ? getLivingSteelResilienceEffectBonus(bonusEffect) : 0;
  const baseResilience = calculateResilienceWithLivingSteelBonus(skill, -appliedBonus);
  const healthState = health ?? actor?.system?.resources?.health ?? {};
  const missingHealthBonus = calculateLivingSteelResilienceBonus(settings, { weakened, health: healthState });
  const boostedResilience = calculateResilienceWithLivingSteelBonus(
    skill,
    missingHealthBonus - appliedBonus
  );
  const displayedBonus = Math.max(0, boostedResilience - baseResilience);
  const baseThreshold = weakened
    ? baseResilience / settings.weakenedResilienceDivisor
    : baseResilience;
  return Math.max(0, baseThreshold + displayedBonus);
}

export function calculateLivingSteelResilienceBonus(settings = {}, { weakened = false, health = null } = {}) {
  const normalizedSettings = normalizeLivingSteelSettings(settings);
  const healthState = health ?? {};
  const maximumHealth = Math.max(0, Number(healthState.max) || 0);
  const currentHealth = Math.min(maximumHealth, Math.max(0, Number(healthState.value) || 0));
  const stepPercent = weakened
    ? normalizedSettings.weakenedMissingHealthStepPercent
    : normalizedSettings.normalMissingHealthStepPercent;
  const missingHealthSteps = maximumHealth > 0
    ? Math.floor((((maximumHealth - currentHealth) * 100) / (maximumHealth * stepPercent)) + 1e-9)
    : 0;
  return Math.max(0, Math.trunc(missingHealthSteps * normalizedSettings.resilienceBonusPerStep));
}

function calculateResilienceWithLivingSteelBonus(skill = {}, bonusDelta = 0) {
  const delta = Number(bonusDelta) || 0;
  if (!Object.hasOwn(skill, "base") || !Object.hasOwn(skill, "bonus")) {
    return Math.max(0, (Number(skill?.value) || 0) + delta);
  }
  return Math.max(0, composePreparedSkillValue({
    ...skill,
    bonus: (Number(skill.bonus) || 0) + delta
  }).value);
}

export function resolveLivingSteelFinalDamage({
  actor = null,
  applications = [],
  settings = {},
  state = {},
  worldTime = 0
} = {}) {
  const normalizedSettings = normalizeLivingSteelSettings(settings);
  const fallbackWorldTime = getWorldTime(worldTime);
  const previous = normalizeLivingSteelState(state);
  let annulledDamage = previous.annulledDamage;
  let weakenedUntil = previous.weakenedUntil;
  let lastDamageAt = previous.lastDamageAt;
  let hasActivity = previous.hasActivity;
  let sequence = { requests: [], healthDamage: 0 };

  const blockedApplications = [];
  let touched = false;
  for (const application of applications) {
    const eventTime = getWorldTime(application?.worldTime ?? fallbackWorldTime);
    const inactive = hasActivity
      && (eventTime - lastDamageAt) >= normalizedSettings.resetAfterSeconds;
    if (inactive || (weakenedUntil > 0 && weakenedUntil <= eventTime)) {
      annulledDamage = 0;
      weakenedUntil = 0;
    }

    const sequentialEstimate = typeof application?.resolveSequentialEstimate === "function"
      ? application.resolveSequentialEstimate(sequence)
      : null;
    if (sequentialEstimate) {
      application.healthDamage = Math.max(0, Number(sequentialEstimate.healthDamage) || 0);
      application.estimate = sequentialEstimate.estimate ?? application.estimate;
      application.health = sequentialEstimate.health ?? application.health;
    }
    const healthDamage = Math.max(0, Number(application?.healthDamage) || 0);
    if (healthDamage <= 0) {
      if (sequentialEstimate?.nextSequence) sequence = sequentialEstimate.nextSequence;
      continue;
    }
    touched = true;
    hasActivity = true;
    lastDamageAt = eventTime;
    const weakened = weakenedUntil > eventTime;
    const threshold = calculateLivingSteelThresholdFromNormalizedSettings(actor, normalizedSettings, {
      weakened,
      health: application?.health
    });
    if (!(healthDamage < threshold)) {
      if (sequentialEstimate?.nextSequence) sequence = sequentialEstimate.nextSequence;
      continue;
    }

    blockedApplications.push(application);
    if (weakened) continue;
    annulledDamage = Math.min(normalizedSettings.annulledDamageLimit, annulledDamage + healthDamage);
    if (annulledDamage >= normalizedSettings.annulledDamageLimit) {
      weakenedUntil = eventTime + normalizedSettings.weakenedDurationSeconds;
    }
  }

  return {
    blockedApplications,
    touched,
    state: {
      annulledDamage,
      weakenedUntil,
      lastDamageAt: touched ? lastDamageAt : previous.lastDamageAt,
      settings: normalizedSettings
    }
  };
}

export function estimateLivingSteelFinalHealthDamage({ actor = null, applications = [], worldTime = 0 } = {}) {
  const context = findLivingSteelAbilityContext(actor);
  if (!context) return null;
  const effect = findLivingSteelEffect(actor);
  return resolveLivingSteelFinalDamage({
    actor,
    applications,
    settings: context.settings,
    state: getLivingSteelEffectState(effect),
    worldTime
  });
}

export function actorHasLivingSteel(actor) {
  return Boolean(findLivingSteelAbilityContext(actor));
}

export async function applyLivingSteelFinalHealthDamage({ actor = null, applications = [], worldTime = 0 } = {}) {
  const context = findLivingSteelAbilityContext(actor);
  if (!context) return null;
  const effect = findLivingSteelEffect(actor);
  const resolved = resolveLivingSteelFinalDamage({
    actor,
    applications,
    settings: context.settings,
    state: getLivingSteelEffectState(effect),
    worldTime
  });
  if (!resolved.touched) return resolved;

  const state = {
    ...resolved.state,
    abilityItemId: String(context.abilityItem.id ?? ""),
    abilityItemUuid: String(context.abilityItem.uuid ?? ""),
    functionId: String(context.abilityFunction.id ?? ""),
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.livingSteel
  };
  await upsertLivingSteelEffect(actor, effect, context, state, state.lastDamageAt);
  await synchronizeLivingSteelEffectBonuses(actor, { worldTime: state.lastDamageAt });
  return { ...resolved, data: { state } };
}

export function getLivingSteelAbilityProgressEntry(abilityItem, abilityFunction, { worldTime = undefined } = {}) {
  const actor = abilityItem?.parent;
  const settings = normalizeLivingSteelSettings(abilityFunction?.fixedSettings);
  const effect = findLivingSteelEffect(actor, {
    abilityItemId: abilityItem?.id,
    functionId: abilityFunction?.id
  });
  const presentation = getLivingSteelPresentation(actor, getLivingSteelEffectState(effect), settings, { worldTime });
  return {
    key: `${String(abilityFunction?.id ?? "")}:${ABILITY_FIXED_FUNCTION_KEYS.livingSteel}`,
    label: "Аннулировано",
    value: `${presentation.progress} / ${presentation.limit} · порог: урон < ${presentation.threshold} · ${presentation.modeLabel}`
  };
}

export function getLivingSteelEffectTooltipRows(effect, actor = effect?.parent, { worldTime = undefined } = {}) {
  const state = getLivingSteelEffectState(effect);
  if (!state) return [];
  const settings = getLivingSteelSettingsForEffect(actor, state) ?? state.settings;
  const presentation = getLivingSteelPresentation(actor, state, settings, { worldTime });
  return [
    { label: "Аннулировано", value: `${presentation.progress} / ${presentation.limit}` },
    { label: "Порог", value: `урон < ${presentation.threshold}` },
    { label: "Режим", value: presentation.modeLabel }
  ];
}

export function getLivingSteelPresentation(actor, state = {}, settings = {}, { worldTime = undefined } = {}) {
  const normalizedSettings = normalizeLivingSteelSettings(settings);
  const now = getWorldTime(worldTime);
  const normalizedState = normalizeLivingSteelState(state);
  const inactive = normalizedState.hasActivity
    && (now - normalizedState.lastDamageAt) >= normalizedSettings.resetAfterSeconds;
  const weakened = !inactive && normalizedState.weakenedUntil > now;
  const recovered = !weakened && normalizedState.weakenedUntil > 0;
  const progress = inactive || recovered ? 0 : Math.min(
    normalizedSettings.annulledDamageLimit,
    normalizedState.annulledDamage
  );
  const threshold = calculateLivingSteelThresholdFromNormalizedSettings(actor, normalizedSettings, { weakened });
  const weakenedSecondsRemaining = weakened
    ? Math.max(0, Math.ceil(normalizedState.weakenedUntil - now))
    : 0;
  return {
    progress: formatNumber(progress),
    limit: formatNumber(normalizedSettings.annulledDamageLimit),
    threshold: formatNumber(threshold),
    weakened,
    weakenedSecondsRemaining,
    modeLabel: weakened ? `ослабление · ${weakenedSecondsRemaining} сек.` : "полная сила"
  };
}

export function findLivingSteelEffect(actor, { abilityItemId = "", functionId = "" } = {}) {
  const itemId = String(abilityItemId ?? "");
  const fixedFunctionId = String(functionId ?? "");
  return Array.from(actor?.effects ?? []).find(effect => {
    const state = getLivingSteelEffectState(effect);
    if (!state) return false;
    if (itemId && String(state.abilityItemId ?? "") !== itemId) return false;
    if (fixedFunctionId && String(state.functionId ?? "") !== fixedFunctionId) return false;
    return true;
  }) ?? null;
}

export function findLivingSteelResilienceEffect(actor, { abilityItemId = "", functionId = "" } = {}) {
  const itemId = String(abilityItemId ?? "");
  const fixedFunctionId = String(functionId ?? "");
  return Array.from(actor?.effects ?? []).find(effect => {
    const data = getLivingSteelResilienceEffectData(effect);
    if (!data) return false;
    if (itemId && String(data.abilityItemId ?? "") !== itemId) return false;
    if (fixedFunctionId && String(data.functionId ?? "") !== fixedFunctionId) return false;
    return true;
  }) ?? null;
}

function actorNeedsLivingSteelEffectRuntime(actor) {
  if (findLivingSteelAbilityContext(actor)) return true;
  return Array.from(actor?.effects ?? []).some(effect => (
    Boolean(getLivingSteelEffectState(effect))
    || Boolean(getLivingSteelResilienceEffectData(effect))
  ));
}

function actorHasLivingSteelTrackerEffect(actor) {
  return Array.from(actor?.effects ?? []).some(effect => Boolean(getLivingSteelEffectState(effect)));
}

async function expireInactiveLivingSteelEffects(worldTime, deltaTime) {
  if (!game.user?.isActiveGM || !(Number(deltaTime) > 0)) return;
  const actors = new Set(await livingSteelEffectActorIndex.values());
  if (!actors.size) return;
  for (const actor of actors) {
    await synchronizeLivingSteelEffectBonuses(actor, { worldTime });
  }
  const ActiveEffectClass = foundry.documents?.ActiveEffect?.implementation ?? globalThis.ActiveEffect;
  if (!ActiveEffectClass?.registry?.refresh) return;
  await ActiveEffectClass.registry.refresh(LIVING_STEEL_EXPIRY_EVENT, {
    actors,
    worldTime: Number(worldTime) || Number(game.time?.worldTime) || 0,
    deltaTime: Number(deltaTime) || 0
  });
}

async function synchronizeActiveLivingSteelBonuses() {
  if (!game.user?.isActiveGM) return;
  for (const actor of await getActiveSceneWorldTimeActors()) {
    if (!actorNeedsLivingSteelEffectRuntime(actor)) continue;
    await synchronizeLivingSteelEffectBonuses(actor);
  }
}

export async function cleanupLivingSteelEffectsForAbilityItem(item) {
  if (item?.type !== "ability" || !item.parent) return;
  const effectIds = Array.from(item.parent.effects ?? [])
    .filter(effect => {
      const data = getLivingSteelEffectState(effect) ?? getLivingSteelResilienceEffectData(effect);
      return String(data?.abilityItemId ?? "") === String(item.id ?? "");
    })
    .map(effect => effect.id)
    .filter(Boolean);
  if (effectIds.length) {
    try {
      await item.parent.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
    } catch (error) {
      if (!isMissingLivingSteelEffectError(error)) throw error;
    }
  }
}

export async function reconcileLivingSteelEffectsForAbilityItem(item) {
  if (item?.type !== "ability" || !item.parent) return;
  const functions = normalizeAbilityFunctions(item.system?.functions ?? [])
    .filter(entry => (
      entry.type === ABILITY_FUNCTION_TYPES.fixed
      && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.livingSteel
  ));
  const functionsById = new Map(functions.map(entry => [String(entry.id ?? ""), entry]));
  const trackerEffects = Array.from(item.parent.effects ?? [])
    .filter(effect => String(getLivingSteelEffectState(effect)?.abilityItemId ?? "") === String(item.id ?? ""));
  const resilienceEffects = Array.from(item.parent.effects ?? [])
    .filter(effect => String(getLivingSteelResilienceEffectData(effect)?.abilityItemId ?? "") === String(item.id ?? ""));
  const obsoleteIds = [];
  for (const effect of trackerEffects) {
    const state = getLivingSteelEffectState(effect);
    const abilityFunction = functionsById.get(String(state?.functionId ?? ""));
    if (!abilityFunction) {
      if (effect.id) obsoleteIds.push(effect.id);
      continue;
    }
    const settings = normalizeLivingSteelSettings(abilityFunction.fixedSettings);
    try {
      await effect.update({
        name: LIVING_STEEL_EFFECT_NAME,
        img: item.img || item.parent.img || "icons/svg/shield.svg",
        origin: item.uuid ?? item.parent.uuid,
        "duration.value": settings.resetAfterSeconds,
        "duration.units": "seconds",
        "duration.expiry": LIVING_STEEL_EXPIRY_EVENT,
        "duration.expired": false,
        "system.changes": [],
        [`flags.${SYSTEM_ID}.${LIVING_STEEL_EFFECT_FLAG_KEY}.settings`]: settings
      }, { animate: false });
    } catch (error) {
      if (!isMissingLivingSteelEffectError(error)) throw error;
    }
  }
  const now = getWorldTime();
  for (const abilityFunction of functions) {
    const functionId = String(abilityFunction.id ?? "");
    const matchingEffects = resilienceEffects.filter(effect => (
      String(getLivingSteelResilienceEffectData(effect)?.functionId ?? "") === functionId
    ));
    for (const duplicate of matchingEffects.slice(1)) {
      if (duplicate.id) obsoleteIds.push(duplicate.id);
    }
    const context = {
      abilityItem: item,
      abilityFunction,
      settings: normalizeLivingSteelSettings(abilityFunction.fixedSettings)
    };
    const tracker = findLivingSteelEffect(item.parent, { abilityItemId: item.id, functionId });
    await upsertLivingSteelResilienceEffect(item.parent, matchingEffects[0] ?? null, context, {
      trackerState: getLivingSteelEffectState(tracker),
      worldTime: now
    });
  }
  for (const effect of resilienceEffects) {
    const data = getLivingSteelResilienceEffectData(effect);
    if (!functionsById.has(String(data?.functionId ?? "")) && effect.id) obsoleteIds.push(effect.id);
  }
  if (obsoleteIds.length) {
    try {
      await item.parent.deleteEmbeddedDocuments("ActiveEffect", [...new Set(obsoleteIds)], { animate: false });
    } catch (error) {
      if (!isMissingLivingSteelEffectError(error)) throw error;
    }
  }
}

export function abilityItemHasLivingSteel(item) {
  if (item?.type !== "ability") return false;
  return normalizeAbilityFunctions(item.system?.functions ?? []).some(abilityFunction => (
    abilityFunction.type === ABILITY_FUNCTION_TYPES.fixed
    && abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.livingSteel
  ));
}

function findLivingSteelAbilityContext(actor) {
  return findLivingSteelAbilityContexts(actor)[0] ?? null;
}

function findLivingSteelAbilityContexts(actor) {
  const contexts = [];
  for (const abilityItem of Array.from(actor?.items ?? [])) {
    if (abilityItem?.type !== "ability") continue;
    const abilityFunctions = normalizeAbilityFunctions(abilityItem.system?.functions ?? []).filter(entry => (
      entry.type === ABILITY_FUNCTION_TYPES.fixed
      && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.livingSteel
    ));
    for (const abilityFunction of abilityFunctions) {
      contexts.push({
        abilityItem,
        abilityFunction,
        settings: normalizeLivingSteelSettings(abilityFunction.fixedSettings)
      });
    }
  }
  return contexts;
}

function getLivingSteelSettingsForEffect(actor, state = {}) {
  const abilityItemId = String(state?.abilityItemId ?? "");
  const functionId = String(state?.functionId ?? "");
  const abilityItem = actor?.items?.get?.(abilityItemId)
    ?? Array.from(actor?.items ?? []).find(item => String(item?.id ?? "") === abilityItemId);
  if (abilityItem?.type !== "ability") return null;
  const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? []).find(entry => (
    entry.type === ABILITY_FUNCTION_TYPES.fixed
    && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.livingSteel
    && (!functionId || String(entry.id ?? "") === functionId)
  ));
  return abilityFunction ? normalizeLivingSteelSettings(abilityFunction.fixedSettings) : null;
}

function getLivingSteelEffectState(effect) {
  if (!effect) return null;
  return effect.getFlag?.(SYSTEM_ID, LIVING_STEEL_EFFECT_FLAG_KEY)
    ?? effect.flags?.[SYSTEM_ID]?.[LIVING_STEEL_EFFECT_FLAG_KEY]
    ?? null;
}

function getLivingSteelResilienceEffectData(effect) {
  if (!effect) return null;
  return effect.getFlag?.(SYSTEM_ID, LIVING_STEEL_RESILIENCE_EFFECT_FLAG_KEY)
    ?? effect.flags?.[SYSTEM_ID]?.[LIVING_STEEL_RESILIENCE_EFFECT_FLAG_KEY]
    ?? null;
}

async function upsertLivingSteelEffect(actor, effect, context, state, worldTime) {
  const duration = {
    value: context.settings.resetAfterSeconds,
    units: "seconds",
    expiry: LIVING_STEEL_EXPIRY_EVENT,
    expired: false
  };
  const effectData = {
    type: "base",
    name: LIVING_STEEL_EFFECT_NAME,
    img: context.abilityItem.img || actor.img || "icons/svg/shield.svg",
    origin: context.abilityItem.uuid ?? actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    start: { time: worldTime },
    duration,
    system: { changes: [] },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [LIVING_STEEL_EFFECT_FLAG_KEY]: state
      }
    }
  };
  if (!effect) {
    await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
    return;
  }
  const updateData = {
    disabled: false,
    start: { time: worldTime },
    duration,
    system: { changes: [] },
    flags: {
      ...(effect.flags ?? {}),
      [SYSTEM_ID]: {
        ...(effect.flags?.[SYSTEM_ID] ?? {}),
        kind: "temporary",
        [LIVING_STEEL_EFFECT_FLAG_KEY]: state
      }
    }
  };
  try {
    await effect.update(updateData, { animate: false });
  } catch (error) {
    if (!isMissingLivingSteelEffectError(error)) throw error;
    const replacement = findLivingSteelEffect(actor, {
      abilityItemId: context.abilityItem.id,
      functionId: context.abilityFunction.id
    });
    if (replacement && replacement !== effect) {
      await replacement.update(updateData, { animate: false });
      return;
    }
    await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
  }
}

async function upsertLivingSteelResilienceEffect(actor, effect, context, {
  trackerState = null,
  worldTime = undefined
} = {}) {
  const now = getWorldTime(worldTime);
  const metadata = {
    abilityItemId: String(context.abilityItem.id ?? ""),
    abilityItemUuid: String(context.abilityItem.uuid ?? ""),
    functionId: String(context.abilityFunction.id ?? ""),
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.livingSteel
  };
  const duration = {
    value: null,
    units: "seconds",
    expiry: null,
    expired: false
  };
  const changes = buildLivingSteelResilienceChanges(actor, trackerState, context.settings, now);
  const effectData = {
    type: "base",
    name: LIVING_STEEL_RESILIENCE_EFFECT_NAME,
    img: context.abilityItem.img || actor.img || "icons/svg/shield.svg",
    origin: context.abilityItem.uuid ?? actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_NEVER,
    start: null,
    duration,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "passive",
        [LIVING_STEEL_RESILIENCE_EFFECT_FLAG_KEY]: metadata
      }
    }
  };
  if (!effect) {
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
    return created ?? null;
  }

  const currentMetadata = getLivingSteelResilienceEffectData(effect);
  const presentationMatches = String(effect.name ?? "") === effectData.name
    && String(effect.img ?? "") === String(effectData.img ?? "")
    && String(effect.origin ?? "") === String(effectData.origin ?? "")
    && effect.transfer === false
    && effect.disabled === false
    && Number(effect.showIcon) === ACTIVE_EFFECT_SHOW_ICON_NEVER
    && effect.start == null
    && effect.duration?.value == null
    && effect.duration?.expiry == null
    && effect.duration?.expired !== true;
  if (
    presentationMatches
    && livingSteelResilienceMetadataMatches(currentMetadata, metadata)
    && livingSteelChangesMatch(effect.system?.changes, changes)
  ) return effect;

  const updateData = {
    name: effectData.name,
    img: effectData.img,
    origin: effectData.origin,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_NEVER,
    start: null,
    duration,
    system: { changes },
    flags: {
      ...(effect.flags ?? {}),
      [SYSTEM_ID]: {
        ...(effect.flags?.[SYSTEM_ID] ?? {}),
        kind: "passive",
        [LIVING_STEEL_RESILIENCE_EFFECT_FLAG_KEY]: metadata
      }
    }
  };
  try {
    await effect.update(updateData, { animate: false });
    return effect;
  } catch (error) {
    if (!isMissingLivingSteelEffectError(error)) throw error;
    const replacement = findLivingSteelResilienceEffect(actor, {
      abilityItemId: context.abilityItem.id,
      functionId: context.abilityFunction.id
    });
    if (replacement && replacement !== effect) {
      await replacement.update(updateData, { animate: false });
      return replacement;
    }
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
    return created ?? null;
  }
}

function isMissingLivingSteelEffectError(error) {
  return /does not exist|not found|deleted/i.test(String(error?.message ?? error ?? ""));
}

function buildLivingSteelResilienceChanges(actor, state = {}, settings = {}, worldTime = undefined) {
  const normalizedState = normalizeLivingSteelState(state);
  const now = getWorldTime(worldTime);
  const inactive = normalizedState.hasActivity
    && (now - normalizedState.lastDamageAt) >= normalizeLivingSteelSettings(settings).resetAfterSeconds;
  const weakened = !inactive && normalizedState.weakenedUntil > now;
  const bonus = calculateLivingSteelResilienceBonus(settings, {
    weakened,
    health: actor?.system?.resources?.health
  });
  return bonus > 0
    ? [{
      key: LIVING_STEEL_RESILIENCE_BONUS_KEY,
      type: "add",
      value: String(bonus),
      phase: "initial",
      priority: null
    }]
    : [];
}

function getLivingSteelResilienceEffectBonus(effect) {
  const change = Array.from(effect?.system?.changes ?? [])
    .find(entry => String(entry?.key ?? "") === LIVING_STEEL_RESILIENCE_BONUS_KEY);
  return Math.max(0, Number(change?.value) || 0);
}

function livingSteelResilienceMetadataMatches(current, desired) {
  return Boolean(current && Object.entries(desired).every(([key, value]) => String(current[key] ?? "") === String(value ?? "")));
}

function livingSteelChangesMatch(current = [], desired = []) {
  const left = Array.from(current ?? []);
  const right = Array.from(desired ?? []);
  if (left.length !== right.length) return false;
  return left.every((change, index) => {
    const expected = right[index] ?? {};
    return ["key", "type", "value", "phase", "priority"].every(key => (
      (change?.[key] ?? null) === (expected?.[key] ?? null)
    ));
  });
}

function requestLivingSteelBonusSyncFromActorUpdate(actor, changes = {}, _options = {}, userId = "") {
  if (!isInitiatingDocumentUser(userId) || !livingSteelActorUpdateMayChangeHealth(changes)) return;
  queueLivingSteelBonusSync(actor);
}

function requestLivingSteelBonusSyncFromEmbeddedDocument(hookName, document, ...args) {
  const userId = typeof args.at(-1) === "string" ? args.at(-1) : "";
  if (!isInitiatingDocumentUser(userId)) return;
  const actor = document?.parent?.documentName === "Actor" ? document.parent : null;
  const managedEffect = getLivingSteelEffectState(document) || getLivingSteelResilienceEffectData(document);
  if (managedEffect) {
    if (hookName === "deleteActiveEffect" && actor) queueLivingSteelBonusSync(actor);
    return;
  }
  if (!actor || (document.documentName === "Item" && document.type !== "gear")) return;
  queueLivingSteelBonusSync(actor);
}

function livingSteelActorUpdateMayChangeHealth(changes = {}) {
  return Object.keys(foundry.utils.flattenObject(changes ?? {})).some(path => (
    path === "system.resources.health"
    || path.startsWith("system.resources.health.")
    || path === "system.limbs"
    || path.startsWith("system.limbs.")
    || path === "system.development.health"
    || path.startsWith("system.development.health.")
    || path === "system.creature"
    || path.startsWith("system.creature.")
  ));
}

function isInitiatingDocumentUser(userId = "") {
  const currentUserId = String(game.user?.id ?? "");
  const initiatingUserId = String(userId ?? "");
  return !currentUserId || !initiatingUserId || currentUserId === initiatingUserId;
}

function queueLivingSteelBonusSync(actor) {
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid || !actorNeedsLivingSteelEffectRuntime(actor)) return Promise.resolve();
  const pending = pendingLivingSteelBonusSyncs.get(actorUuid);
  if (pending) {
    pending.dirty = true;
    return pending.promise;
  }
  const entry = { dirty: true, promise: null };
  entry.promise = Promise.resolve().then(async () => {
    while (entry.dirty) {
      entry.dirty = false;
      await synchronizeLivingSteelEffectBonuses(actor);
    }
  }).catch(error => {
    console.error("Fallout MaW | Living Steel resilience bonus sync failed", error);
  }).finally(() => {
    if (pendingLivingSteelBonusSyncs.get(actorUuid) === entry) {
      pendingLivingSteelBonusSyncs.delete(actorUuid);
    }
  });
  pendingLivingSteelBonusSyncs.set(actorUuid, entry);
  return entry.promise;
}

async function synchronizeLivingSteelEffectBonuses(actor, { worldTime = undefined } = {}) {
  const now = getWorldTime(worldTime);
  const contexts = findLivingSteelAbilityContexts(actor);
  const contextsByKey = new Map(contexts.map(context => [getLivingSteelContextKey(
    context.abilityItem.id,
    context.abilityFunction.id
  ), context]));
  const trackerByKey = new Map();
  const resilienceEffectsByKey = new Map();
  const obsoleteIds = [];

  for (const effect of Array.from(actor?.effects ?? [])) {
    const state = getLivingSteelEffectState(effect);
    if (state) {
      const key = getLivingSteelContextKey(state.abilityItemId, state.functionId);
      if (!contextsByKey.has(key)) {
        if (effect.id) obsoleteIds.push(effect.id);
        continue;
      }
      if (!trackerByKey.has(key)) trackerByKey.set(key, effect);
      else if (effect.id) obsoleteIds.push(effect.id);
      if (!Array.from(effect.system?.changes ?? []).length) continue;
      try {
        await effect.update({ "system.changes": [] }, { animate: false });
      } catch (error) {
        if (!isMissingLivingSteelEffectError(error)) throw error;
      }
      continue;
    }

    const data = getLivingSteelResilienceEffectData(effect);
    if (!data) continue;
    const key = getLivingSteelContextKey(data.abilityItemId, data.functionId);
    if (!contextsByKey.has(key)) {
      if (effect.id) obsoleteIds.push(effect.id);
      continue;
    }
    const matches = resilienceEffectsByKey.get(key) ?? [];
    matches.push(effect);
    resilienceEffectsByKey.set(key, matches);
  }

  for (const matches of resilienceEffectsByKey.values()) {
    for (const duplicate of matches.slice(1)) {
      if (duplicate.id) obsoleteIds.push(duplicate.id);
    }
  }
  if (obsoleteIds.length) {
    try {
      await actor.deleteEmbeddedDocuments("ActiveEffect", [...new Set(obsoleteIds)], { animate: false });
    } catch (error) {
      if (!isMissingLivingSteelEffectError(error)) throw error;
    }
  }

  for (const [key, context] of contextsByKey) {
    const tracker = trackerByKey.get(key) ?? null;
    await upsertLivingSteelResilienceEffect(actor, resilienceEffectsByKey.get(key)?.[0] ?? null, context, {
      trackerState: getLivingSteelEffectState(tracker),
      worldTime: now
    });
  }
}

function getLivingSteelContextKey(abilityItemId = "", functionId = "") {
  return `${String(abilityItemId ?? "")}\u0000${String(functionId ?? "")}`;
}

function normalizeLivingSteelState(state = {}) {
  const raw = state && typeof state === "object" ? state : {};
  const lastDamageAt = Math.max(0, Number(raw.lastDamageAt) || 0);
  return {
    annulledDamage: Math.max(0, Number(raw.annulledDamage) || 0),
    weakenedUntil: Math.max(0, Number(raw.weakenedUntil) || 0),
    lastDamageAt,
    hasActivity: Boolean(Object.hasOwn(raw, "lastDamageAt"))
  };
}

function getWorldTime(value = undefined) {
  const candidate = value ?? globalThis.game?.time?.worldTime ?? 0;
  return Math.max(0, Number(candidate) || 0);
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return String(Number.isInteger(numeric) ? numeric : Math.round(numeric * 100) / 100);
}
