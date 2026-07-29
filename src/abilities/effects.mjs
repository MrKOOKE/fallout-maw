import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_AURA_MODES,
  ABILITY_FUNCTION_TYPES,
  getAbilityFunctionTriggerCostRows,
  getAbilitySourceId,
  isAccumulatingAbilityFunction,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import {
  abilityConditionsApply,
  getAbilityEffectProjectionFromNormalizedFunctions,
  getAbilityFunctionChangesForSatisfiedAuraCondition,
  hasAbilityWeaponContextCondition
} from "./evaluation.mjs";
import { getActorItemsWithActiveHudModules } from "../utils/hud-active-items.mjs";
import {
  AURA_GENERATED_EFFECT_FLAG_KEY,
  findAuraDistributionConditions,
  getAuraGeneratedEffectFlag,
  getAuraGeneratedTargetTokens
} from "./aura-conditions.mjs";
import { prepareEffectChangeForApplication } from "../utils/effect-change-values.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import { deferAbilityEffectSync, deferAuraStateSync, registerBulkOperationFlusher } from "../utils/bulk-operation.mjs";
import { hasEventReactionCondition } from "../events/event-reaction-schema.mjs";
import {
  clearManagedBarrierProjectionDepletion,
  getActorBarrierDepletions,
  isManagedBarrierProjectionDepleted,
  pruneManagedBarrierProjectionDepletions
} from "./barrier-depletion.mjs";
import {
  syncNormalizedTimedTriggerCostEffects
} from "./trigger-cost-effects.mjs";
import {
  ABILITY_EFFECT_FLAG_KEY,
  EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY,
  ITEM_EFFECT_FLAG_KEY,
  abilityFunctionsMayContainAuraCondition,
  buildAbilityEffectSourceDescriptor,
  buildActorAbilityEffectSyncIndex,
  getLiveIndexedEffects,
  getLiveStaleIndexedEffects
} from "./effect-sync-context.mjs";
import { getAbilityEffectOriginUuid } from "../utils/ability-effect-origin.mjs";
import {
  buildEquipmentRequirementMovementPointChange,
  hasDamageMitigationRequirements,
  isActiveDamageMitigationRequirementItem
} from "../items/equipment-requirements.mjs";
import {
  EFFECT_LIFECYCLE_FLAG_KEY,
  EFFECT_LIFECYCLE_KINDS,
  buildNormalizedEffectFunctionSnapshot
} from "./effect-lifecycle.mjs";
import {
  ADVANCEMENT_PURE_EFFECT_FLAG_KEY,
  buildAdvancementPureEffectFlag
} from "../advancement/pure-value-effects.mjs";
import {
  LIMITED_EFFECT_COPY_FLAG_KEY,
  buildLimitedEffectCopyFlag,
  effectCountsAsCopy,
  getManagedEffectCopyLimit,
  getManagedEffectSourceFunctionIdentity,
  getPendingLimitedEffectCopyState,
  sourceFunctionIdentitiesMatch
} from "./limited-effect-copies.mjs";
import {
  getActorIlluminationLevel,
  getWorldTimeMinuteOfDay,
  illuminationLevelConditionApplies,
  invalidateAbilityConditionLightingCache,
  timeOfDayConditionApplies
} from "./environment-conditions.mjs";
const ACTIVE_APPLICATION_EFFECT_FLAG_KEY = "activeApplication";
const ACTIVE_EFFECT_SHOW_ICON_CONDITIONAL = 1;
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const ACTOR_EFFECT_SYNC_DELAY_MS = 40;
const AURA_STATE_SYNC_DELAY_MS = 40;
const ILLUMINATION_CONDITION_SYNC_DELAY_MS = 120;
const processingActors = new Set();
const actorSyncTimers = new Map();
const queuedActorSyncs = new Map();
const coverSyncTimers = new Map();
const tokenMovementSyncVersions = new Map();
const actorIlluminationLevelCache = new Map();
const pendingIlluminationActors = new Map();
const environmentConditionActorIndex = new Map();
const environmentConditionCache = new Map();
let auraStateSyncTimer = null;
let illuminationConditionSyncTimer = null;
let illuminationConditionSyncAll = false;
let processingAuraEffects = false;
let auraStateSyncRequested = false;
let environmentConditionIndexInitialized = false;

export function registerAbilityEffectHooks() {
  registerBulkOperationFlusher(flushDeferredAbilityEffectSyncs);
  Hooks.on("createItem", item => {
    if (shouldRefreshEnvironmentConditionIndex(item)) refreshEnvironmentConditionActorIndex(item?.parent);
    if (
      item?.type === "ability"
      || isEquipmentItem(item)
      || hasItemFreeSettingsFunction(item)
      || hasDamageMitigationRequirements(item)
    ) {
      queueActorAbilityEffectSync(item.parent, {}, {
        aura: item?.type === "ability" || hasItemFreeSettingsFunction(item)
      });
    }
  });
  Hooks.on("updateItem", (item, changes, options = {}) => {
    if (options?.falloutMawEventReactionProgress === true) return;
    if (options?.falloutMawTriggerTransitionState === true) return;
    // The limited-use authority performs an awaited sync only at exhaustion.
    // Intermediate counter updates must not enqueue actor/aura rebuilds.
    if (options?.falloutMawLimitedUses === true) return;
    if (shouldRefreshEnvironmentConditionIndex(item, changes)) refreshEnvironmentConditionActorIndex(item?.parent);
    if (
      item?.type === "ability"
      || isEquipmentItem(item)
      || isEquipmentItemUpdate(changes)
      || isItemFreeSettingsUpdate(item, changes)
      || isDamageMitigationRequirementsUpdate(item, changes)
    ) {
      queueActorAbilityEffectSync(item.parent, {}, {
        aura: item?.type === "ability" || isItemFreeSettingsUpdate(item, changes)
      });
    }
    if (item?.type === "ability" || item?.type === "gear") {
      void reconcileEventReactionAccumulatorEffects(item);
    }
  });
  Hooks.on("deleteItem", item => {
    if (shouldRefreshEnvironmentConditionIndex(item)) refreshEnvironmentConditionActorIndex(item?.parent);
    if (item?.type === "ability") {
      void deleteAbilityEffects(item.parent, item.id, item.uuid);
      queueAuraStateSync();
      return;
    }
    if (item?.type === "gear") {
      void deleteManagedItemEffects(item.parent, item.id, item.uuid);
    }
    if (isEquipmentItem(item)) queueActorAbilityEffectSync(item.parent, {}, { aura: item?.type === "gear" });
    else if (item?.type === "gear") queueAuraStateSync();
  });
  Hooks.on("deleteActor", actor => {
    const actorUuid = String(actor?.uuid ?? "");
    if (!actorUuid) return;
    environmentConditionActorIndex.delete(actorUuid);
    environmentConditionCache.delete(actorUuid);
    actorIlluminationLevelCache.delete(actorUuid);
    pendingIlluminationActors.delete(actorUuid);
  });
  Hooks.on("updateActor", (actor, changes, options = {}) => {
    if (options?.falloutMawDamageBarrierDepletion === true) return;
    if (options?.falloutMawActiveAuraRuntime === true) return;
    if (options?.falloutMawTrialRuntime === true) return;
    if (!isAbilityEffectSyncRelevant(changes)) return;
    queueActorAbilityEffectSync(actor, {}, { aura: true });
  });
  Hooks.on("updateToken", (tokenDocument, changes) => {
    const relevant = isAuraTokenUpdateRelevant(changes);
    const movementActionChanged = foundry.utils.hasProperty(changes, "movementAction");
    const positionChanged = isAuraTokenPositionUpdate(changes);
    if (positionChanged) {
      invalidateAbilityConditionLightingCache();
      queueAuraSyncAfterTokenMovement(tokenDocument, { syncMovingActor: movementActionChanged });
      return;
    }
    if (movementActionChanged) {
      queueActorAbilityEffectSync(tokenDocument?.actor, { actorToken: tokenDocument }, { aura: relevant });
    }
    if (relevant && !movementActionChanged) queueAuraStateSync();
  });
  Hooks.on("createToken", tokenDocument => {
    invalidateAbilityConditionLightingCache();
    queueIlluminationConditionEffectSync(tokenDocument);
    queueAuraStateSync();
  });
  Hooks.on("deleteToken", tokenDocument => {
    invalidateAbilityConditionLightingCache();
    queueIlluminationConditionEffectSync(tokenDocument);
    queueAuraStateSync();
  });
  Hooks.on("createActiveEffect", (effect, options = {}) => {
    if (effectMayChangeEquipmentRequirementValues(effect)) queueActorAbilityEffectSync(effect?.parent);
    if (
      options?.falloutMawActiveAuraRuntime === true
      || options?.falloutMawTrialRuntime === true
      || effect?.getFlag?.(SYSTEM_ID, "trialConstructEffect")
      || isExecutingActiveApplicationAuraEffect(effect)
    ) return;
    if (isCoverEffect(effect)) queueCoverAbilityEffectSync(effect.parent);
    if (!getAuraGeneratedEffectFlag(effect)) queueAuraStateSync();
  });
  Hooks.on("updateActiveEffect", (effect, _changes, options = {}) => {
    if (effectMayChangeEquipmentRequirementValues(effect)) queueActorAbilityEffectSync(effect?.parent);
    if (options?.falloutMawLimitedUses === true) return;
    if (options?.falloutMawDamageBarrierCommit === true) return;
    if (
      options?.falloutMawActiveAuraRuntime === true
      || options?.falloutMawTrialRuntime === true
      || effect?.getFlag?.(SYSTEM_ID, "trialConstructEffect")
      || isExecutingActiveApplicationAuraEffect(effect)
    ) return;
    if (isCoverEffect(effect)) queueCoverAbilityEffectSync(effect.parent);
    const managed = isManagedProjectionEffect(effect);
    const expiredLimitedCopy = Boolean(
      effect?.getFlag?.(SYSTEM_ID, LIMITED_EFFECT_COPY_FLAG_KEY)
      && effect?.duration?.expired === true
    );
    if (!getAuraGeneratedEffectFlag(effect) && !managed) queueAuraStateSync();
    if (!managed && !expiredLimitedCopy) return;
    queueActorAbilityEffectSync(effect.parent, {}, { aura: true });
  });
  Hooks.on("deleteActiveEffect", (effect, options = {}) => {
    if (effectMayChangeEquipmentRequirementValues(effect)) queueActorAbilityEffectSync(effect?.parent);
    if (isCoverEffect(effect)) queueCoverAbilityEffectSync(effect.parent);
    if (options?.falloutMawDamageBarrierCommit === true) return;
    if (
      options?.falloutMawActiveAuraRuntime === true
      || options?.falloutMawTrialRuntime === true
      || effect?.getFlag?.(SYSTEM_ID, "trialConstructEffect")
      || isExecutingActiveApplicationAuraEffect(effect)
    ) return;
    const managed = isManagedProjectionEffect(effect);
    const limitedCopy = Boolean(effect?.getFlag?.(SYSTEM_ID, LIMITED_EFFECT_COPY_FLAG_KEY));
    if (!getAuraGeneratedEffectFlag(effect) && !managed) queueAuraStateSync();
    if (!managed && !limitedCopy) return;
    queueActorAbilityEffectSync(effect.parent, {}, { aura: true });
  });
  Hooks.on("fallout-maw.energyConsumptionChanged", actor => {
    queueActorAbilityEffectSync(actor, {}, { aura: true });
  });
  Hooks.on("canvasReady", () => {
    invalidateAbilityConditionLightingCache();
    actorIlluminationLevelCache.clear();
    globalThis.clearTimeout(illuminationConditionSyncTimer);
    illuminationConditionSyncTimer = null;
    pendingIlluminationActors.clear();
    illuminationConditionSyncAll = false;
    environmentConditionActorIndex.clear();
    environmentConditionCache.clear();
    environmentConditionIndexInitialized = false;
    // Ready already runs a full sync; avoid overlapping ~300ms work during preset startup.
    if (!game.ready) return;
    void syncLoadedActorAbilityEffects();
  });
  Hooks.on("lightingRefresh", () => {
    invalidateAbilityConditionLightingCache();
    queueIlluminationConditionEffectSync();
  });
  Hooks.on(`${SYSTEM_ID}.stealthSettingsChanged`, () => {
    invalidateAbilityConditionLightingCache();
    actorIlluminationLevelCache.clear();
    queueIlluminationConditionEffectSync();
  });
  Hooks.on("updateWorldTime", syncTimeOfDayConditionEffects);
  Hooks.on("createCombat", () => queueAuraStateSync());
  Hooks.on("updateCombat", () => queueAuraStateSync());
  Hooks.on("deleteCombat", () => queueAuraStateSync());
  Hooks.on("createCombatant", () => queueAuraStateSync());
  Hooks.on("updateCombatant", () => queueAuraStateSync());
  Hooks.on("deleteCombatant", () => queueAuraStateSync());
}

function queueAuraSyncAfterTokenMovement(tokenDocument, { syncMovingActor = false } = {}) {
  const tokenKey = String(tokenDocument?.uuid ?? tokenDocument?.id ?? "");
  if (!tokenKey) {
    queueAuraDependentStateSync(tokenDocument, { syncMovingActor });
    return;
  }

  const version = (tokenMovementSyncVersions.get(tokenKey) ?? 0) + 1;
  tokenMovementSyncVersions.set(tokenKey, version);
  const movementPromise = tokenDocument?.object?.movementAnimationPromise;
  if (!movementPromise?.then) {
    queueAuraDependentStateSync(tokenDocument, { syncMovingActor });
    tokenMovementSyncVersions.delete(tokenKey);
    return;
  }

  void Promise.resolve(movementPromise)
    .catch(() => undefined)
    .then(() => {
      if (tokenMovementSyncVersions.get(tokenKey) !== version) return;
      tokenMovementSyncVersions.delete(tokenKey);
      queueAuraDependentStateSync(tokenDocument, { syncMovingActor });
    });
}

function queueAuraDependentStateSync(tokenDocument, { syncMovingActor = false } = {}) {
  queueIlluminationConditionEffectSync(tokenDocument);
  if (syncMovingActor) {
    queueActorAbilityEffectSync(tokenDocument?.actor, { actorToken: tokenDocument }, { aura: true });
  }

  const actors = new Map();
  for (const token of canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (!actor?.uuid || actors.has(actor.uuid)) continue;
    if (!getAuraSourceFunctionSets(actor).some(source => hasAuraPresenceConditionFunction(source.functions))) continue;
    actors.set(actor.uuid, actor);
  }
  for (const actor of actors.values()) queueActorAbilityEffectSync(actor);
  queueAuraStateSync();
}

function syncTimeOfDayConditionEffects(worldTime, deltaTime) {
  if (!game.ready || !game.user?.isActiveGM) return;
  const current = Number(worldTime) || 0;
  const previous = current - (Number(deltaTime) || 0);
  if (getWorldTimeMinuteOfDay(current) === getWorldTimeMinuteOfDay(previous)) return;

  for (const { actor, context } of collectEnvironmentActorContexts()) {
    const conditions = getActorPassiveEnvironmentConditions(actor, ABILITY_CONDITION_TYPES.timeOfDay);
    if (!conditions.some(condition => (
      timeOfDayConditionApplies(condition, { worldTime: previous })
      !== timeOfDayConditionApplies(condition, { worldTime: current })
    ))) continue;
    queueActorAbilityEffectSync(actor, context, { aura: true });
  }
}

function queueIlluminationConditionEffectSync(tokenDocument = null) {
  if (!game.ready || !game.user?.isActiveGM) return;
  const actor = tokenDocument?.actor ?? null;
  if (!actor?.uuid) {
    illuminationConditionSyncAll = true;
    pendingIlluminationActors.clear();
  } else if (!illuminationConditionSyncAll) {
    pendingIlluminationActors.set(actor.uuid, actor);
  }

  globalThis.clearTimeout(illuminationConditionSyncTimer);
  illuminationConditionSyncTimer = globalThis.setTimeout(() => {
    illuminationConditionSyncTimer = null;
    const all = illuminationConditionSyncAll;
    illuminationConditionSyncAll = false;
    const pendingActors = new Map(pendingIlluminationActors);
    pendingIlluminationActors.clear();
    syncIlluminationConditionEffects(all ? null : pendingActors);
  }, ILLUMINATION_CONDITION_SYNC_DELAY_MS);
}

function syncIlluminationConditionEffects(targetActors = null) {
  if (!game.ready || !game.user?.isActiveGM) return;
  const contexts = targetActors
    ? collectEnvironmentActorContexts({ actors: targetActors })
    : collectEnvironmentActorContexts({ canvasOnly: true });

  for (const { actor, context } of contexts) {
    const conditions = getActorPassiveEnvironmentConditions(actor, ABILITY_CONDITION_TYPES.illumination);
    if (!conditions.length) continue;
    const current = getActorIlluminationLevel(actor, context);
    const hadPrevious = actorIlluminationLevelCache.has(actor.uuid);
    const previous = actorIlluminationLevelCache.get(actor.uuid) ?? null;
    actorIlluminationLevelCache.set(actor.uuid, current);
    const changed = !hadPrevious || conditions.some(condition => (
      illuminationLevelConditionApplies(condition, previous)
      !== illuminationLevelConditionApplies(condition, current)
    ));
    if (changed) queueActorAbilityEffectSync(actor, context, { aura: true });
  }
}

function collectEnvironmentActorContexts({ canvasOnly = false, actors = null } = {}) {
  const contexts = new Map();
  if (!actors) ensureEnvironmentConditionActorIndex();
  if (actors) {
    for (const actor of actors.values()) {
      if (actor?.uuid) contexts.set(actor.uuid, { actor, context: {} });
    }
  } else if (!canvasOnly) {
    ensureEnvironmentConditionActorIndex();
    for (const actor of environmentConditionActorIndex.values()) {
      if (actor?.uuid) contexts.set(actor.uuid, { actor, context: {} });
    }
  }
  for (const token of canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (!actor?.uuid) continue;
    if (actors && !actors.has(actor.uuid)) continue;
    if (!actors && !environmentConditionActorIndex.has(actor.uuid)) continue;
    contexts.set(actor.uuid, { actor, context: { actorToken: token } });
  }
  return contexts.values();
}

function getActorPassiveEnvironmentConditions(actor, type) {
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid) return [];
  if (!environmentConditionCache.has(actorUuid)) refreshEnvironmentConditionActorIndex(actor);
  return environmentConditionCache.get(actorUuid)?.[type] ?? [];
}

function ensureEnvironmentConditionActorIndex() {
  if (environmentConditionIndexInitialized) return;
  environmentConditionIndexInitialized = true;
  for (const actor of game.actors ?? []) refreshEnvironmentConditionActorIndex(actor);
  // Unlinked token actors are not present in game.actors, but their passive
  // abilities still need to react to world-time and lighting changes.
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token?.actor?.uuid && !environmentConditionCache.has(token.actor.uuid)) {
      refreshEnvironmentConditionActorIndex(token.actor);
    }
  }
}

function refreshEnvironmentConditionActorIndex(actor) {
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid) return;
  const conditionsByType = collectActorPassiveEnvironmentConditions(actor);
  environmentConditionCache.set(actorUuid, conditionsByType);
  if (conditionsByType.timeOfDay.length || conditionsByType.illumination.length) {
    environmentConditionActorIndex.set(actorUuid, actor);
  } else {
    environmentConditionActorIndex.delete(actorUuid);
  }
}

function shouldRefreshEnvironmentConditionIndex(item, changes = {}) {
  const actorUuid = String(item?.parent?.uuid ?? "");
  if (!actorUuid) return false;
  if (item?.type === "ability") return true;
  if (item?.type !== "gear") return false;
  return hasItemFreeSettingsFunction(item)
    || isItemFreeSettingsUpdate(item, changes)
    || environmentConditionActorIndex.has(actorUuid);
}

function collectActorPassiveEnvironmentConditions(actor) {
  const conditionsByType = {
    [ABILITY_CONDITION_TYPES.timeOfDay]: [],
    [ABILITY_CONDITION_TYPES.illumination]: []
  };
  for (const item of getActorItemsWithActiveHudModules(actor)) {
    const functions = item?.type === "ability"
      ? item.system?.functions ?? []
      : isActiveItemFreeSettingsItem(item)
        ? item.system?.functions?.freeSettings?.entries ?? []
        : [];
    const entries = Array.isArray(functions) ? functions : Object.values(functions ?? {});
    for (const entry of entries) {
      if (entry?.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
      const rawConditions = entry?.conditions ?? (entry?.condition ? [entry.condition] : []);
      const entryConditions = Array.isArray(rawConditions) ? rawConditions : Object.values(rawConditions ?? {});
      if (entryConditions.some(condition => [
        ABILITY_CONDITION_TYPES.eventReaction,
        ABILITY_CONDITION_TYPES.itemUse
      ].includes(condition?.type))) continue;
      for (const condition of entryConditions) {
        if (Object.hasOwn(conditionsByType, condition?.type)) conditionsByType[condition.type].push(condition);
      }
    }
  }
  return conditionsByType;
}

export async function syncLoadedActorAbilityEffects() {
  if (!game.user?.isActiveGM) return;
  ensureEnvironmentConditionActorIndex();
  const actors = new Map();
  for (const actor of game.actors ?? []) actors.set(actor.uuid, { actor, context: {} });
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.set(token.actor.uuid, { actor: token.actor, context: { actorToken: token.document } });
  }
  for (const { actor, context } of actors.values()) await syncActorAbilityEffects(actor, context);
  await syncAuraGeneratedEffects();
}

function isExecutingActiveApplicationAuraEffect(effect = null) {
  const flag = effect?.getFlag?.(SYSTEM_ID, ACTIVE_APPLICATION_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[ACTIVE_APPLICATION_EFFECT_FLAG_KEY]
    ?? null;
  if (!flag?.functionData) return false;
  const abilityFunction = normalizeAbilityFunctions([flag?.functionData])[0];
  return Boolean(
    abilityFunction?.type === ABILITY_FUNCTION_TYPES.activeApplication
    && abilityFunction.conditions?.some(condition => (
      condition?.type === ABILITY_CONDITION_TYPES.aura
      && condition?.auraMode === ABILITY_AURA_MODES.triggerConditions
    ))
  );
}

function isCoverEffect(effect = null) {
  return Boolean(
    effect?.getFlag?.(SYSTEM_ID, "forcedCover")
    || effect?.getFlag?.(SYSTEM_ID, "autoCover")
    || effect?.flags?.[SYSTEM_ID]?.forcedCover
    || effect?.flags?.[SYSTEM_ID]?.autoCover
  );
}

function queueCoverAbilityEffectSync(actor) {
  if (!actor?.uuid) return;
  globalThis.clearTimeout(coverSyncTimers.get(actor.uuid));
  coverSyncTimers.set(actor.uuid, globalThis.setTimeout(() => {
    coverSyncTimers.delete(actor.uuid);
    queueActorAbilityEffectSync(actor);
  }, 20));
}

function queueActorAbilityEffectSync(actor, context = {}, { aura = false } = {}) {
  const actorUuid = actor?.uuid;
  if (!actorUuid || !game.user?.isActiveGM) return;
  if (deferAbilityEffectSync(actor, context, { aura })) return;

  const queued = queuedActorSyncs.get(actorUuid) ?? { actor, context: {}, aura: false };
  queued.actor = actor;
  queued.context = { ...queued.context, ...context };
  queued.aura = queued.aura || aura;
  queuedActorSyncs.set(actorUuid, queued);

  globalThis.clearTimeout(actorSyncTimers.get(actorUuid));
  actorSyncTimers.set(actorUuid, globalThis.setTimeout(async () => {
    actorSyncTimers.delete(actorUuid);
    const entry = queuedActorSyncs.get(actorUuid);
    queuedActorSyncs.delete(actorUuid);
    if (!entry) return;

    const freshActor = fromUuidSync(actorUuid) ?? entry.actor;
    if (processingActors.has(actorUuid)) {
      queueActorAbilityEffectSync(freshActor, entry.context, { aura: entry.aura });
      return;
    }
    await syncActorAbilityEffects(freshActor, entry.context);
    if (entry.aura) queueAuraStateSync();
  }, ACTOR_EFFECT_SYNC_DELAY_MS));
}

function flushDeferredAbilityEffectSyncs(context) {
  for (const entry of context?.abilityActors?.values?.() ?? []) {
    const freshActor = fromUuidSync(entry.actor?.uuid ?? "") ?? entry.actor;
    queueActorAbilityEffectSync(freshActor, entry.context, { aura: entry.aura });
  }
  if (context?.auraState) queueAuraStateSync();
}

export async function syncActorAbilityEffects(actor, context = {}) {
  if (!actor || !game.user?.isActiveGM) return;
  if (!["character", "construct"].includes(actor.type)) return;
  if (processingActors.has(actor.uuid)) return;

  processingActors.add(actor.uuid);
  try {
    const abilityItems = actor.itemTypes?.ability
      ?? actor.items?.filter(item => item.type === "ability")
      ?? [];
    const activeAbilityItemIds = new Set(abilityItems.map(item => item.id));
    const activeItemDocuments = getActorItemsWithActiveHudModules(actor);
    const itemFreeSettingsItems = activeItemDocuments.filter(item => isActiveItemFreeSettingsItem(item));
    const activeItemFreeSettingsItemIds = new Set(itemFreeSettingsItems.map(item => item.id));
    const equipmentRequirementItems = activeItemDocuments.filter(item => isActiveDamageMitigationRequirementItem(item));
    const activeEquipmentRequirementItemIds = new Set(equipmentRequirementItems.map(item => item.id));
    const effectIndex = buildActorAbilityEffectSyncIndex(actor);

    for (const item of abilityItems) {
      const descriptor = buildAbilityEffectSourceDescriptor(item.system?.functions ?? []);
      await syncSingleAbilityEffect(
        actor,
        item,
        descriptor,
        getLiveIndexedEffects(actor, effectIndex.abilityEffectsByItemId, item.id),
        context
      );
      await syncNormalizedTimedTriggerCostEffects(
        actor,
        item,
        descriptor.normalizedFunctions,
        context
      );
    }
    for (const item of itemFreeSettingsItems) {
      const descriptor = buildAbilityEffectSourceDescriptor(
        item.system?.functions?.freeSettings?.entries ?? []
      );
      await syncSingleItemFreeSettingsEffect(
        actor,
        item,
        descriptor,
        getLiveIndexedEffects(actor, effectIndex.itemEffectsByItemId, item.id),
        context
      );
      await syncNormalizedTimedTriggerCostEffects(
        actor,
        item,
        descriptor.normalizedFunctions,
        context
      );
    }
    for (const item of equipmentRequirementItems) {
      await syncSingleEquipmentRequirementEffect(
        actor,
        item,
        getLiveIndexedEffects(
          actor,
          effectIndex.equipmentRequirementEffectsByItemId,
          item.id
        )
      );
    }

    const stale = getLiveStaleIndexedEffects(
      actor,
      effectIndex.abilityEffectEntries,
      activeAbilityItemIds
    );
    await deleteAbilitySyncEffects(actor, stale, ABILITY_EFFECT_FLAG_KEY);

    const staleItemEffects = getLiveStaleIndexedEffects(
      actor,
      effectIndex.itemEffectEntries,
      activeItemFreeSettingsItemIds
    );
    await deleteAbilitySyncEffects(actor, staleItemEffects, ITEM_EFFECT_FLAG_KEY);
    const staleEquipmentRequirementEffects = getLiveStaleIndexedEffects(
      actor,
      effectIndex.equipmentRequirementEffectEntries,
      activeEquipmentRequirementItemIds
    );
    await deleteAbilitySyncEffects(
      actor,
      staleEquipmentRequirementEffects,
      EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY
    );
    await pruneManagedBarrierProjectionDepletions(actor, record => (
      (record?.kind === "ability" && !activeAbilityItemIds.has(String(record?.sourceId ?? "")))
      || (record?.kind === "item" && !activeItemFreeSettingsItemIds.has(String(record?.sourceId ?? "")))
    ));
  } finally {
    processingActors.delete(actor.uuid);
  }
}

async function syncSingleAbilityEffect(actor, item, descriptor, existing = [], context = {}) {
  const { changes, pureChangeIndexes } = buildAbilityEffectProjection(
    actor,
    item,
    descriptor,
    context
  );
  if (!changes.length) {
    await clearManagedBarrierProjectionDepletion(actor, `ability:${item.id}`);
    if (existing.length) {
      await actor.deleteEmbeddedDocuments(
        "ActiveEffect",
        existing.map(effect => effect.id),
        getAbilityEffectOperationOptions(descriptor)
      );
    }
    return;
  }

  const sourceId = getAbilitySourceId(item);
  const showIcon = getAbilityEffectShowIcon(actor, item, descriptor, context);
  const signature = JSON.stringify({
    itemId: item.id,
    sourceId,
    changes,
    showIcon,
    ...(pureChangeIndexes.length ? { pureChangeIndexes } : {})
  });
  if (isManagedBarrierProjectionDepleted(actor, `ability:${item.id}`, signature)) return;
  await clearManagedBarrierProjectionDepletion(actor, `ability:${item.id}`);
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  if (obsolete.length) {
    await actor.deleteEmbeddedDocuments(
      "ActiveEffect",
      obsolete,
      getAbilityEffectOperationOptions(descriptor)
    );
  }

  if (current) {
    const update = {};
    if (current.disabled) update.disabled = false;
    if (current.name !== item.name) update.name = item.name;
    if (current.img !== item.img) update.img = item.img;
    if (current.origin !== item.uuid) update.origin = item.uuid;
    if (current.showIcon !== showIcon) update.showIcon = showIcon;
    if (current.getFlag(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind !== EFFECT_LIFECYCLE_KINDS.sourceProjection) {
      update[`flags.${SYSTEM_ID}.${EFFECT_LIFECYCLE_FLAG_KEY}`] = {
        kind: EFFECT_LIFECYCLE_KINDS.sourceProjection
      };
    }
    const auraCondition = descriptor.hasAuraCondition;
    if (current.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.auraCondition !== auraCondition) {
      update[`flags.${SYSTEM_ID}.${ABILITY_EFFECT_FLAG_KEY}.auraCondition`] = auraCondition;
    }
    if (Object.keys(update).length) await current.update(update);
    return;
  }

  await actor.createEmbeddedDocuments(
    "ActiveEffect",
    [buildAbilityActiveEffectData(
      item,
      changes,
      signature,
      sourceId,
      showIcon,
      pureChangeIndexes,
      descriptor.hasAuraCondition
    )],
    getAbilityEffectOperationOptions(descriptor)
  );
}

async function syncSingleItemFreeSettingsEffect(actor, item, descriptor, existing = [], context = {}) {
  const { changes, pureChangeIndexes } = buildItemFreeSettingsEffectProjection(
    actor,
    item,
    descriptor,
    context
  );
  if (!changes.length) {
    await clearManagedBarrierProjectionDepletion(actor, `item:${item.id}`);
    if (existing.length) {
      await actor.deleteEmbeddedDocuments(
        "ActiveEffect",
        existing.map(effect => effect.id),
        getItemFreeSettingsEffectOperationOptions(descriptor)
      );
    }
    return;
  }

  const showIcon = getItemFreeSettingsEffectShowIcon(actor, item, descriptor, context);
  const signature = JSON.stringify({
    itemId: item.id,
    changes,
    showIcon,
    ...(pureChangeIndexes.length ? { pureChangeIndexes } : {})
  });
  if (isManagedBarrierProjectionDepleted(actor, `item:${item.id}`, signature)) return;
  await clearManagedBarrierProjectionDepletion(actor, `item:${item.id}`);
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  if (obsolete.length) {
    await actor.deleteEmbeddedDocuments(
      "ActiveEffect",
      obsolete,
      getItemFreeSettingsEffectOperationOptions(descriptor)
    );
  }

  if (current) {
    const update = {};
    if (current.disabled) update.disabled = false;
    if (current.name !== item.name) update.name = item.name;
    if (current.img !== item.img) update.img = item.img;
    if (current.origin !== item.uuid) update.origin = item.uuid;
    if (current.showIcon !== showIcon) update.showIcon = showIcon;
    if (current.getFlag(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind !== EFFECT_LIFECYCLE_KINDS.sourceProjection) {
      update[`flags.${SYSTEM_ID}.${EFFECT_LIFECYCLE_FLAG_KEY}`] = {
        kind: EFFECT_LIFECYCLE_KINDS.sourceProjection
      };
    }
    const auraCondition = descriptor.hasAuraCondition;
    if (current.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.auraCondition !== auraCondition) {
      update[`flags.${SYSTEM_ID}.${ITEM_EFFECT_FLAG_KEY}.auraCondition`] = auraCondition;
    }
    if (Object.keys(update).length) await current.update(update);
    return;
  }

  await actor.createEmbeddedDocuments(
    "ActiveEffect",
    [buildItemFreeSettingsActiveEffectData(
      item,
      changes,
      signature,
      showIcon,
      pureChangeIndexes,
      descriptor.hasAuraCondition
    )],
    getItemFreeSettingsEffectOperationOptions(descriptor)
  );
}

async function syncSingleEquipmentRequirementEffect(actor, item, existing = []) {
  const change = buildEquipmentRequirementMovementPointChange(actor, item);
  if (!change) {
    if (existing.length) {
      await deleteAbilitySyncEffects(
        actor,
        existing,
        EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY
      );
    }
    return;
  }

  const changes = [change];
  const signature = JSON.stringify({ itemId: item.id, changes });
  const current = existing.find(effect => (
    effect.getFlag(SYSTEM_ID, EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY)?.signature === signature
  ));
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  if (obsolete.length) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete);
  }

  if (current) {
    const update = {};
    if (current.disabled) update.disabled = false;
    if (current.name !== item.name) update.name = item.name;
    if (current.img !== item.img) update.img = item.img;
    if (current.origin !== item.uuid) update.origin = item.uuid;
    if (current.showIcon !== ACTIVE_EFFECT_SHOW_ICON_ALWAYS) {
      update.showIcon = ACTIVE_EFFECT_SHOW_ICON_ALWAYS;
    }
    if (current.getFlag(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind !== EFFECT_LIFECYCLE_KINDS.sourceProjection) {
      update[`flags.${SYSTEM_ID}.${EFFECT_LIFECYCLE_FLAG_KEY}`] = {
        kind: EFFECT_LIFECYCLE_KINDS.sourceProjection
      };
    }
    if (Object.keys(update).length) await current.update(update);
    return;
  }

  await actor.createEmbeddedDocuments(
    "ActiveEffect",
    [buildEquipmentRequirementActiveEffectData(item, changes, signature)]
  );
}

function queueAuraStateSync() {
  if (!game.user?.isActiveGM) return;
  if (deferAuraStateSync()) return;
  auraStateSyncRequested = true;
  globalThis.clearTimeout(auraStateSyncTimer);
  auraStateSyncTimer = globalThis.setTimeout(() => {
    auraStateSyncTimer = null;
    void syncAuraGeneratedEffects();
  }, AURA_STATE_SYNC_DELAY_MS);
}

export async function syncAuraGeneratedEffects() {
  if (!game.user?.isActiveGM) return;
  if (processingAuraEffects) {
    auraStateSyncRequested = true;
    return;
  }

  processingAuraEffects = true;
  try {
    do {
      auraStateSyncRequested = false;
      const desired = buildDesiredAuraGeneratedEffects();
      const actors = collectAuraEffectActors(desired);
      for (const actor of actors.values()) {
        await reconcileActorAuraGeneratedEffects(actor, desired.get(actor.uuid) ?? new Map());
      }
    } while (auraStateSyncRequested);
  } finally {
    processingAuraEffects = false;
  }
}

function buildDesiredAuraGeneratedEffects() {
  const desired = new Map();
  const targetActors = new Map();
  const preparedSourcesByActorUuid = new Map();
  for (const sourceToken of canvas?.tokens?.placeables ?? []) {
    const sourceActor = sourceToken?.actor;
    if (!sourceActor || !["character", "construct"].includes(sourceActor.type)) continue;
    let preparedSources = preparedSourcesByActorUuid.get(sourceActor.uuid);
    if (!preparedSources) {
      preparedSources = prepareAuraSourceFunctions(sourceActor);
      preparedSourcesByActorUuid.set(sourceActor.uuid, preparedSources);
    }
    for (const { source, entry, distributionConditions } of preparedSources) {
      const functionData = buildNormalizedEffectFunctionSnapshot(entry);
      const triggerCost = buildAuraTriggerCostData(sourceActor, source, entry);
      const effectCopyFlag = buildLimitedEffectCopyFlag({
        sourceActor,
        sourceItem: source.item,
        abilityFunction: entry
      }, {
        evaluateLimit: formula => evaluateActorFormula(formula, sourceActor, {
          fallback: 1,
          minimum: 1,
          context: "aura effect copy limit"
        })
      });
      const lateContextual = hasAbilityWeaponContextCondition(entry.conditions);
      if (lateContextual && !hasPotentialLateAuraChanges(entry)) continue;
      for (const condition of distributionConditions) {
        const targets = getAuraGeneratedTargetTokens(sourceActor, condition, { actorToken: sourceToken });
        if (!targets.length) continue;
        for (const targetToken of targets) {
          const targetActor = targetToken?.actor;
          if (!targetActor) continue;
          const changes = lateContextual
            ? []
            : prepareAuraGeneratedChanges(sourceActor, getAbilityFunctionChangesForSatisfiedAuraCondition(sourceActor, entry, condition, {
              abilityItemId: source.item.id,
              actorToken: sourceToken,
              targetActor,
              targetToken
            })).filter(isApplicableGeneratedAuraChange);
          if (!lateContextual && !changes.length) continue;
          const key = [
            source.kind,
            sourceActor.uuid,
            source.item.id,
            entry.id,
            condition.id
          ].join(".");
          // Runtime counters live on the source item. Keeping usesSpent out of
          // the signature prevents every spent charge from recreating every
          // projected aura effect on the scene.
          const limitedUseIds = (functionData?.conditions ?? [])
            .filter(candidate => candidate?.type === ABILITY_CONDITION_TYPES.limitedUses)
            .map(candidate => String(candidate.id ?? ""));
          const projectionContext = lateContextual ? {
            lateContextual: true,
            sourceItemUuid: String(source.item?.uuid ?? ""),
            sourceTokenUuid: getAuraProjectionTokenUuid(sourceToken),
            targetTokenUuid: getAuraProjectionTokenUuid(targetToken)
          } : {};
          const signature = JSON.stringify({
            key,
            changes,
            triggerCost,
            ...(entry.includeInPureValues ? { advancementPure: true } : {}),
            ...(effectCopyFlag ? { effectCopyFlag } : {}),
            limitedUseIds,
            ...projectionContext
          });
          const data = buildAuraGeneratedActiveEffectData(
            source,
            sourceActor,
            entry,
            condition,
            changes,
            key,
            signature,
            functionData,
            triggerCost,
            effectCopyFlag,
            projectionContext
          );
          const actorDesired = desired.get(targetActor.uuid) ?? new Map();
          actorDesired.set(key, data);
          desired.set(targetActor.uuid, actorDesired);
          targetActors.set(targetActor.uuid, targetActor);
        }
      }
    }
  }
  return applyAuraEffectCopyLimits(desired, targetActors);
}

function getAuraSourceFunctionSets(actor) {
  if (!actorHasPotentialAuraSource(actor)) return [];
  const sources = [];
  for (const item of getActorItemsWithActiveHudModules(actor)) {
    if (item?.type === "ability") {
      sources.push({ kind: "ability", item, functions: item.system?.functions ?? [] });
      continue;
    }
    if (isActiveItemFreeSettingsItem(item)) {
      sources.push({ kind: "itemFreeSettings", item, functions: item.system?.functions?.freeSettings?.entries ?? [] });
    }
  }
  return sources;
}

function prepareAuraSourceFunctions(actor) {
  const prepared = [];
  for (const source of getAuraSourceFunctionSets(actor)) {
    if (!abilityFunctionsMayContainAuraCondition(source.functions)) continue;
    const descriptor = buildAbilityEffectSourceDescriptor(source.functions);
    for (const entry of descriptor.passiveEffectFunctions) {
      const distributionConditions = findAuraDistributionConditions(entry.conditions);
      if (!distributionConditions.length) continue;
      prepared.push({ source, entry, distributionConditions });
    }
  }
  return prepared;
}

function actorHasPotentialAuraSource(actor) {
  const abilityItems = actor?.itemTypes?.ability
    ?? actor?.items?.filter?.(item => item?.type === "ability")
    ?? [];
  if (abilityItems.some(item => abilityFunctionsMayContainAuraCondition(item.system?.functions))) {
    return true;
  }

  const gearItems = actor?.itemTypes?.gear
    ?? actor?.items?.filter?.(item => item?.type === "gear")
    ?? [];
  for (const item of gearItems) {
    if (abilityFunctionsMayContainAuraCondition(item.system?.functions?.freeSettings?.entries)) {
      return true;
    }
  }

  const actorItems = Array.isArray(actor?.items?.contents)
    ? actor.items.contents
    : Array.from(actor?.items ?? []);
  for (const item of actorItems) {
    const moduleSlots = item.system?.functions?.weapon?.moduleSlots;
    if (!Array.isArray(moduleSlots)) continue;
    for (const slot of moduleSlots) {
      const moduleItem = getPotentialAuraModuleItem(slot);
      if (abilityFunctionsMayContainAuraCondition(moduleItem?.system?.functions?.freeSettings?.entries)) {
        return true;
      }
    }
  }
  return false;
}

function getPotentialAuraModuleItem(slot = {}) {
  if (slot?.itemData?.system) return slot.itemData;
  const uuid = String(slot?.itemUuid ?? "").trim();
  if (!uuid) return null;
  try {
    return globalThis.fromUuidSync?.(uuid)
      ?? globalThis.foundry?.utils?.fromUuidSync?.(uuid)
      ?? null;
  } catch (_error) {
    return null;
  }
}

function applyAuraEffectCopyLimits(desired = new Map(), targetActors = new Map()) {
  for (const [actorUuid, actorDesired] of desired.entries()) {
    const actor = targetActors.get(actorUuid);
    const actorEffects = Array.from(actor?.effects ?? []);
    const existingByKey = new Map();
    const effectsByIdentity = new Map();
    for (const effect of actorEffects) {
      if (!effectCountsAsCopy(effect)) continue;
      const key = String(getAuraGeneratedEffectFlag(effect)?.key ?? "");
      if (key) {
        const entries = existingByKey.get(key) ?? [];
        entries.push(effect);
        existingByKey.set(key, entries);
      }
      const identity = getManagedEffectSourceFunctionIdentity(effect, actor);
      if (!identity?.sourceKey || !identity?.functionId) continue;
      const identityKey = `${identity.sourceKey}:${identity.functionId}`;
      const entries = effectsByIdentity.get(identityKey) ?? [];
      entries.push(effect);
      effectsByIdentity.set(identityKey, entries);
    }
    const allDesiredKeys = new Set(actorDesired.keys());
    const groups = new Map();
    for (const [key, data] of actorDesired.entries()) {
      const copyFlag = data?.flags?.[SYSTEM_ID]?.[LIMITED_EFFECT_COPY_FLAG_KEY];
      const limit = Number(copyFlag?.limit);
      const identity = {
        sourceKey: String(copyFlag?.sourceKey ?? "").trim(),
        functionId: String(copyFlag?.functionId ?? "").trim()
      };
      if (!identity.sourceKey || !identity.functionId || !Number.isFinite(limit) || limit < 1) continue;
      const groupKey = `${identity.sourceKey}:${identity.functionId}`;
      const group = groups.get(groupKey) ?? [];
      group.push({
        key,
        identity,
        limit: Math.max(1, Math.trunc(limit)),
        existing: (existingByKey.get(key) ?? []).some(effect => sourceFunctionIdentitiesMatch(
          identity,
          getManagedEffectSourceFunctionIdentity(effect, actor)
        ))
      });
      groups.set(groupKey, group);
    }
    for (const group of groups.values()) {
      const identity = group[0].identity;
      const groupKeys = new Set(group.map(entry => entry.key));
      const limits = group.map(entry => entry.limit);
      let externalCount = 0;
      for (const effect of effectsByIdentity.get(`${identity.sourceKey}:${identity.functionId}`) ?? []) {
        const auraKey = String(getAuraGeneratedEffectFlag(effect)?.key ?? "");
        // An obsolete aura is deleted before new desired effects are created,
        // so it does not occupy a future slot in this reconciliation pass.
        if (auraKey && !allDesiredKeys.has(auraKey)) continue;
        if (!auraKey || !groupKeys.has(auraKey)) externalCount += 1;
        const storedLimit = getManagedEffectCopyLimit(effect);
        if (storedLimit !== null) limits.push(storedLimit);
      }
      const pending = getPendingLimitedEffectCopyState(actor, identity);
      externalCount += pending.count;
      limits.push(...pending.limits);
      const limit = Math.min(...limits);
      const available = Math.max(0, limit - externalCount);
      group.sort((left, right) => Number(right.existing) - Number(left.existing));
      for (const entry of group.slice(available)) actorDesired.delete(entry.key);
    }
  }
  return desired;
}

function buildAuraGeneratedActiveEffectData(
  source,
  sourceActor,
  entry,
  condition,
  changes,
  key,
  signature,
  functionData,
  triggerCost,
  effectCopyFlag,
  projectionContext = {}
) {
  return {
    type: "base",
    name: source.item.name,
    img: source.item.img || "icons/svg/aura.svg",
    origin: getAbilityEffectOriginUuid(sourceActor, source.item),
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [EFFECT_LIFECYCLE_FLAG_KEY]: {
          kind: EFFECT_LIFECYCLE_KINDS.reconciledInstance
        },
        [AURA_GENERATED_EFFECT_FLAG_KEY]: {
          key,
          signature,
          sourceKind: source.kind,
          sourceActorUuid: sourceActor.uuid,
          itemId: source.item.id,
          functionId: entry.id,
          conditionId: condition.id,
          functionData,
          ...(effectCopyFlag ? {
            sourceItemUuid: effectCopyFlag.sourceItemUuid,
            abilitySourceId: effectCopyFlag.abilitySourceId,
            effectCopyLimit: effectCopyFlag.limit
          } : {}),
          ...(projectionContext?.lateContextual ? projectionContext : {}),
          ...(triggerCost ? { triggerCost } : {})
        },
        ...(effectCopyFlag ? {
          [LIMITED_EFFECT_COPY_FLAG_KEY]: effectCopyFlag
        } : {})
      }
    }
  };
}

function hasPotentialLateAuraChanges(entry = {}) {
  return [
    ...(entry?.changes ?? []),
    ...(entry?.penalties ?? [])
  ].some(isApplicableGeneratedAuraChange);
}

function getAuraProjectionTokenUuid(token = null) {
  return String(token?.document?.uuid ?? token?.uuid ?? "").trim();
}

function buildAuraTriggerCostData(sourceActor, source, entry) {
  if (!(entry?.conditions ?? []).some(condition => condition?.type === ABILITY_CONDITION_TYPES.triggerCost)) {
    return null;
  }
  const sourceActorUuid = String(sourceActor?.uuid ?? "").trim();
  const sourceItemUuid = String(source?.item?.uuid ?? "").trim();
  if (!sourceActorUuid || !sourceItemUuid) return null;
  // Aura ingress is passive. Carry the cost to the recipient effect so a
  // concrete consumer (for example, a skill check) charges that recipient.
  return {
    sourceIdentity: `${sourceActorUuid}:${sourceItemUuid}`,
    sourceItemUuid,
    sourceItemId: String(source?.item?.id ?? ""),
    sourceItemName: String(source?.item?.name ?? ""),
    sourceItemImg: String(source?.item?.img ?? ""),
    functionId: String(entry?.id ?? ""),
    costs: getAbilityFunctionTriggerCostRows(entry)
  };
}

function collectAuraEffectActors(desired = new Map()) {
  const actors = new Map();
  for (const actor of game.actors ?? []) {
    const hasAuraDepletion = Object.values(getActorBarrierDepletions(actor))
      .some(record => record?.kind === "aura");
    if (hasAuraDepletion || actor?.effects?.some(effect => getAuraGeneratedEffectFlag(effect))) {
      actors.set(actor.uuid, actor);
    }
  }
  for (const token of canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (!actor?.uuid) continue;
    const hasAuraDepletion = Object.values(getActorBarrierDepletions(actor))
      .some(record => record?.kind === "aura");
    if (
      desired.has(actor.uuid)
      || hasAuraDepletion
      || actor.effects?.some(effect => getAuraGeneratedEffectFlag(effect))
    ) actors.set(actor.uuid, actor);
  }
  return actors;
}

async function reconcileActorAuraGeneratedEffects(actor, desired = new Map()) {
  if (!actor) return;
  await pruneManagedBarrierProjectionDepletions(actor, (record, identity) => {
    if (record?.kind !== "aura") return false;
    const key = identity.slice("aura:".length);
    const signature = String(
      desired.get(key)?.flags?.[SYSTEM_ID]?.[AURA_GENERATED_EFFECT_FLAG_KEY]?.signature
      ?? ""
    );
    return !signature || signature !== String(record?.signature ?? "");
  });
  const existing = actor.effects.filter(effect => getAuraGeneratedEffectFlag(effect));
  const deletions = [];
  const existingByKey = new Map();
  for (const effect of existing) {
    const flag = getAuraGeneratedEffectFlag(effect);
    const key = String(flag?.key ?? "");
    const target = desired.get(key);
    if (!key || !target || flag?.signature !== target.flags?.[SYSTEM_ID]?.[AURA_GENERATED_EFFECT_FLAG_KEY]?.signature) {
      deletions.push(effect.id);
      continue;
    }
    if (existingByKey.has(key)) {
      deletions.push(effect.id);
      continue;
    }
    existingByKey.set(key, effect);
  }
  if (deletions.length) await actor.deleteEmbeddedDocuments("ActiveEffect", deletions, { animate: false });

  const creations = [];
  for (const [key, data] of desired.entries()) {
    const signature = String(data?.flags?.[SYSTEM_ID]?.[AURA_GENERATED_EFFECT_FLAG_KEY]?.signature ?? "");
    if (
      !existingByKey.has(key)
      && !isManagedBarrierProjectionDepleted(actor, `aura:${key}`, signature)
    ) creations.push(data);
  }
  if (creations.length) await actor.createEmbeddedDocuments("ActiveEffect", creations, { animate: false });
}

function prepareAuraGeneratedChanges(sourceActor, changes = []) {
  return (changes ?? []).map(change => prepareEffectChangeForApplication(sourceActor, change));
}

function isApplicableGeneratedAuraChange(change = {}) {
  return String(change?.key ?? "").trim()
    && String(change?.value ?? "") !== "";
}

function buildAbilityActiveEffectData(
  item,
  changes,
  signature,
  sourceId,
  showIcon,
  pureChangeIndexes = [],
  auraCondition = false
) {
  const advancementPureFlag = buildAdvancementPureEffectFlag(pureChangeIndexes);
  return {
    type: "base",
    name: item.name,
    img: item.img || "icons/svg/aura.svg",
    origin: item.uuid,
    transfer: false,
    disabled: false,
    showIcon,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [EFFECT_LIFECYCLE_FLAG_KEY]: {
          kind: EFFECT_LIFECYCLE_KINDS.sourceProjection
        },
        ...(advancementPureFlag ? {
          [ADVANCEMENT_PURE_EFFECT_FLAG_KEY]: advancementPureFlag
        } : {}),
        [ABILITY_EFFECT_FLAG_KEY]: {
          abilityItemId: item.id,
          abilitySourceId: sourceId,
          signature,
          auraCondition
        }
      }
    }
  };
}

function buildItemFreeSettingsActiveEffectData(
  item,
  changes,
  signature,
  showIcon,
  pureChangeIndexes = [],
  auraCondition = false
) {
  const advancementPureFlag = buildAdvancementPureEffectFlag(pureChangeIndexes);
  return {
    type: "base",
    name: item.name,
    img: item.img || "icons/svg/item-bag.svg",
    origin: item.uuid,
    transfer: false,
    disabled: false,
    showIcon,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [EFFECT_LIFECYCLE_FLAG_KEY]: {
          kind: EFFECT_LIFECYCLE_KINDS.sourceProjection
        },
        ...(advancementPureFlag ? {
          [ADVANCEMENT_PURE_EFFECT_FLAG_KEY]: advancementPureFlag
        } : {}),
        [ITEM_EFFECT_FLAG_KEY]: {
          itemId: item.id,
          signature,
          auraCondition
        }
      }
    }
  };
}

function buildEquipmentRequirementActiveEffectData(item, changes, signature) {
  return {
    type: "base",
    name: item.name,
    img: item.img || "icons/svg/item-bag.svg",
    origin: item.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [EFFECT_LIFECYCLE_FLAG_KEY]: {
          kind: EFFECT_LIFECYCLE_KINDS.sourceProjection
        },
        [EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY]: {
          itemId: item.id,
          signature
        }
      }
    }
  };
}

function buildAbilityEffectProjection(actor, item, descriptor, context = {}) {
  return getAbilityEffectProjectionFromNormalizedFunctions(
    actor,
    descriptor.projectionFunctions,
    { ...context, abilityItemId: item?.id ?? "" }
  );
}

function buildItemFreeSettingsEffectProjection(actor, item, descriptor, context = {}) {
  return getAbilityEffectProjectionFromNormalizedFunctions(actor, descriptor.projectionFunctions, {
    ...context,
    abilityItemId: item?.id ?? ""
  });
}

function getAbilityEffectShowIcon(actor, item, descriptor, context = {}) {
  return hasActiveRuntimeAbilityState(actor, item, descriptor, context)
    ? ACTIVE_EFFECT_SHOW_ICON_ALWAYS
    : ACTIVE_EFFECT_SHOW_ICON_CONDITIONAL;
}

function getItemFreeSettingsEffectShowIcon(actor, item, descriptor, context = {}) {
  return hasActiveRuntimeItemFreeSettingsState(actor, item, descriptor, context)
    ? ACTIVE_EFFECT_SHOW_ICON_ALWAYS
    : ACTIVE_EFFECT_SHOW_ICON_CONDITIONAL;
}

function hasActiveRuntimeAbilityState(actor, item, descriptor, context = {}) {
  return descriptor.passiveEffectFunctions
    .some(entry => {
      const conditions = entry.conditions ?? [];
      if (!hasRuntimeConditions(conditions)) return false;
      return abilityConditionsApply(actor, conditions, {
        ...context,
        abilityItemId: item.id,
        functionId: entry.id
      })
        ? hasApplicableAbilityChanges(entry.changes)
        : hasApplicableAbilityChanges(entry.penalties);
    });
}

function hasActiveRuntimeItemFreeSettingsState(actor, item, descriptor, context = {}) {
  return descriptor.passiveEffectFunctions
    .some(entry => {
      const conditions = entry.conditions ?? [];
      if (!hasRuntimeConditions(conditions)) return false;
      return abilityConditionsApply(actor, conditions, {
        ...context,
        abilityItemId: item.id,
        functionId: entry.id
      })
        ? hasApplicableAbilityChanges(entry.changes)
        : hasApplicableAbilityChanges(entry.penalties);
    });
}

function hasRuntimeConditions(conditions = []) {
  return conditions.some(condition => (
    condition?.type
    && condition.type !== ABILITY_CONDITION_TYPES.limitedChanges
    && condition.type !== ABILITY_CONDITION_TYPES.limitedEffectCopies
    && condition.type !== ABILITY_CONDITION_TYPES.limitedUses
    && condition.type !== ABILITY_CONDITION_TYPES.cooldown
    && condition.type !== ABILITY_CONDITION_TYPES.duration
    && condition.type !== ABILITY_CONDITION_TYPES.triggerCost
    && condition.type !== ABILITY_CONDITION_TYPES.accumulation
    && condition.type !== ABILITY_CONDITION_TYPES.trial
  ));
}

function getAbilityEffectOperationOptions(descriptor) {
  return descriptor.hasAuraCondition ? { animate: false } : {};
}

function getItemFreeSettingsEffectOperationOptions(descriptor) {
  return descriptor.hasAuraCondition ? { animate: false } : {};
}

function hasAuraPresenceConditionFunction(functions = []) {
  return buildAbilityEffectSourceDescriptor(functions).hasAuraPresenceCondition;
}

async function deleteAbilitySyncEffects(actor, effects = [], flagKey = "") {
  if (!actor || !effects.length) return;
  const auraIds = [];
  const normalIds = [];
  for (const effect of effects) {
    const data = effect.getFlag(SYSTEM_ID, flagKey);
    if (data?.auraCondition) auraIds.push(effect.id);
    else normalIds.push(effect.id);
  }
  if (normalIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", normalIds);
  if (auraIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", auraIds, { animate: false });
}

function hasApplicableAbilityChanges(changes = []) {
  return (changes ?? []).some(change => (
    String(change?.key ?? "").trim()
    && String(change?.value ?? "") !== ""
  ));
}

async function deleteAbilityEffects(actor, abilityItemId = "", sourceItemUuid = "") {
  if (!actor || !game.user?.isActiveGM || !abilityItemId) return;
  const effects = actor.effects
    .filter(effect => (
      effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.abilityItemId === abilityItemId
      || eventReactionAccumulatorBelongsToSource(effect, sourceItemUuid)
    ));
  await deleteAbilitySyncEffects(actor, effects, ABILITY_EFFECT_FLAG_KEY);
}

function isAbilityEffectSyncRelevant(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return paths.some(path => path === "system.resources.health"
    || path.startsWith("system.resources.health.")
    || path === "system.characteristics"
    || path.startsWith("system.characteristics.")
    || path === "system.skills"
    || path.startsWith("system.skills.")
    || path === "system.development.characteristics"
    || path.startsWith("system.development.characteristics.")
    || path === "system.development.skills"
    || path.startsWith("system.development.skills.")
    || path === "system.limbs"
    || path.startsWith("system.limbs.")
    || path === "system.creature.raceId"
    || path === `flags.${SYSTEM_ID}.factionBelongs`
    || path.startsWith(`flags.${SYSTEM_ID}.factionBelongs.`)
    || path === `flags.${SYSTEM_ID}.factionRelations`
    || path.startsWith(`flags.${SYSTEM_ID}.factionRelations.`));
}

function isAuraTokenUpdateRelevant(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return paths.some(path => [
    "x",
    "y",
    "elevation",
    "hidden",
    "movementAction"
  ].includes(path));
}

function isAuraTokenPositionUpdate(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return paths.some(path => ["x", "y", "elevation"].includes(path));
}

async function deleteItemFreeSettingsEffects(actor, itemId = "", sourceItemUuid = "") {
  if (!actor || !game.user?.isActiveGM || !itemId) return;
  const effects = actor.effects
    .filter(effect => (
      effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.itemId === itemId
      || eventReactionAccumulatorBelongsToSource(effect, sourceItemUuid)
    ));
  await deleteAbilitySyncEffects(actor, effects, ITEM_EFFECT_FLAG_KEY);
}

async function deleteEquipmentRequirementEffects(actor, itemId = "") {
  if (!actor || !game.user?.isActiveGM || !itemId) return;
  const effects = actor.effects.filter(effect => (
    effect.getFlag(SYSTEM_ID, EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY)?.itemId === itemId
  ));
  await deleteAbilitySyncEffects(actor, effects, EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY);
}

async function deleteManagedItemEffects(actor, itemId = "", sourceItemUuid = "") {
  await deleteItemFreeSettingsEffects(actor, itemId, sourceItemUuid);
  await deleteEquipmentRequirementEffects(actor, itemId);
}

async function reconcileEventReactionAccumulatorEffects(item = null) {
  const actor = item?.parent;
  if (!actor || !game.user?.isActiveGM || !item?.uuid) return;
  const functions = item.type === "ability"
    ? item.system?.functions ?? []
    : item.type === "gear"
      ? item.system?.functions?.freeSettings?.entries ?? []
      : [];
  const currentFunctions = new Map(normalizeAbilityFunctions(functions)
    .filter(isAccumulatingAbilityFunction)
    .map(abilityFunction => [String(abilityFunction?.id ?? "").trim(), abilityFunction])
    .filter(([functionId]) => functionId));
  const obsoleteIds = Array.from(actor.effects ?? [])
    .filter(effect => eventReactionAccumulatorBelongsToSource(effect, item.uuid))
    .filter(effect => {
      const flag = effect.getFlag?.(SYSTEM_ID, "eventReaction")
        ?? effect?.flags?.[SYSTEM_ID]?.eventReaction;
      const functionId = String(flag?.functionId ?? "").trim();
      const current = currentFunctions.get(functionId);
      if (!current) return true;
      return JSON.stringify({
        changes: current.changes ?? [],
        conditions: current.conditions ?? []
      }) !== JSON.stringify({
        changes: flag?.functionData?.changes ?? [],
        conditions: flag?.functionData?.conditions ?? []
      });
    })
    .map(effect => String(effect?.id ?? "").trim())
    .filter(Boolean);
  if (obsoleteIds.length) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", obsoleteIds, {
      animate: false,
      falloutMawEventReactionCleanup: true
    });
  }
}

function eventReactionAccumulatorBelongsToSource(effect = null, sourceItemUuid = "") {
  const uuid = String(sourceItemUuid ?? "").trim();
  if (!uuid) return false;
  const flag = effect?.getFlag?.(SYSTEM_ID, "eventReaction")
    ?? effect?.flags?.[SYSTEM_ID]?.eventReaction;
  const effectSourceUuid = String(flag?.sourceItemUuid ?? "").trim();
  return flag?.scope === "accumulator"
    && (effectSourceUuid === uuid || effectSourceUuid.startsWith(`${uuid}.`));
}

function isEquipmentItem(item) {
  if (!item?.parent || item.type === "ability") return false;
  return item.system?.placement?.mode === "equipment"
    || item.system?.placement?.mode === "weapon"
    || Object.values(item.system?.occupiedSlots ?? {}).some(Boolean);
}

function isEquipmentItemUpdate(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return paths.some(path => path === "system.placement"
    || path.startsWith("system.placement.")
    || path === "system.equipped"
    || path === "system.occupiedSlots"
    || path.startsWith("system.occupiedSlots."));
}

function isDamageMitigationRequirementsUpdate(item, changes = {}) {
  if (item?.type !== "gear") return false;
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return hasDamageMitigationRequirements(item)
    || paths.some(path => (
      path === "system.functions.damageMitigation"
      || path.startsWith("system.functions.damageMitigation.")
    ));
}

function hasItemFreeSettingsFunction(item) {
  return item?.type === "gear" && Boolean(item.system?.functions?.freeSettings?.enabled);
}

function isActiveItemFreeSettingsItem(item) {
  if (!hasItemFreeSettingsFunction(item)) return false;
  return Boolean(item.system?.equipped)
    || item.system?.placement?.mode === "equipment"
    || item.system?.placement?.mode === "weapon"
    || item.system?.placement?.mode === "constructPart";
}

function isItemFreeSettingsUpdate(item, changes = {}) {
  if (item?.type !== "gear") return false;
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return hasItemFreeSettingsFunction(item)
    || paths.some(path => path === "system.functions.freeSettings"
      || path.startsWith("system.functions.freeSettings.")
      || path === "system.equipped"
      || path === "system.placement"
      || path.startsWith("system.placement.")
      || path === "system.functions.constructPart"
      || path.startsWith("system.functions.constructPart."));
}

function isManagedProjectionEffect(effect = null) {
  return Boolean(
    effect?.getFlag?.(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)
    || effect?.getFlag?.(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)
    || effect?.getFlag?.(SYSTEM_ID, EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY)
  );
}

function effectMayChangeEquipmentRequirementValues(effect = null) {
  return (effect?.system?.changes ?? []).some(change => {
    const key = String(change?.key ?? "").trim();
    return key === "system.characteristics"
      || key.startsWith("system.characteristics.")
      || key === "system.skills"
      || key.startsWith("system.skills.")
      || key === "system.development.characteristics"
      || key.startsWith("system.development.characteristics.")
      || key === "system.development.skills"
      || key.startsWith("system.development.skills.");
  });
}
