import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  getAbilityFunctionTriggerCostRows,
  getAbilitySourceId,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { abilityConditionsApply, getAbilityEffectChangesFromFunctions, getAbilityFunctionChangesForSatisfiedAuraCondition } from "./evaluation.mjs";
import { getActorItemsWithActiveHudModules } from "../utils/hud-active-items.mjs";
import {
  AURA_GENERATED_EFFECT_FLAG_KEY,
  findAuraDistributionConditions,
  getAuraGeneratedEffectFlag,
  getAuraGeneratedTargetTokens
} from "./aura-conditions.mjs";
import { prepareEffectChangeForApplication } from "../utils/effect-change-values.mjs";
import { deferAbilityEffectSync, deferAuraStateSync, registerBulkOperationFlusher } from "../utils/bulk-operation.mjs";
import { hasEventReactionCondition } from "../events/event-reaction-schema.mjs";
import {
  syncTimedTriggerCostEffects,
  withoutTimedTriggerCostFunctions
} from "./trigger-cost-effects.mjs";
import { getAbilityEffectOriginUuid } from "../utils/ability-effect-origin.mjs";
const ABILITY_EFFECT_FLAG_KEY = "abilityEffect";
const ITEM_EFFECT_FLAG_KEY = "itemEffect";
const ACTIVE_EFFECT_SHOW_ICON_CONDITIONAL = 1;
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const ACTOR_EFFECT_SYNC_DELAY_MS = 40;
const AURA_STATE_SYNC_DELAY_MS = 40;
const processingActors = new Set();
const actorSyncTimers = new Map();
const queuedActorSyncs = new Map();
const coverSyncTimers = new Map();
const tokenMovementSyncVersions = new Map();
let auraStateSyncTimer = null;
let processingAuraEffects = false;
let auraStateSyncRequested = false;

export function registerAbilityEffectHooks() {
  registerBulkOperationFlusher(flushDeferredAbilityEffectSyncs);
  Hooks.on("createItem", item => {
    if (item?.type === "ability" || isEquipmentItem(item) || hasItemFreeSettingsFunction(item)) {
      queueActorAbilityEffectSync(item.parent, {}, {
        aura: item?.type === "ability" || hasItemFreeSettingsFunction(item)
      });
    }
  });
  Hooks.on("updateItem", (item, changes, options = {}) => {
    if (options?.falloutMawEventReactionProgress === true) return;
    if (options?.falloutMawTriggerTransitionState === true) return;
    if (item?.type === "ability" || isEquipmentItem(item) || isEquipmentItemUpdate(changes) || isItemFreeSettingsUpdate(item, changes)) {
      queueActorAbilityEffectSync(item.parent, {}, {
        aura: item?.type === "ability" || isItemFreeSettingsUpdate(item, changes)
      });
    }
  });
  Hooks.on("deleteItem", item => {
    if (item?.type === "ability") {
      void deleteAbilityEffects(item.parent, item.id);
      queueAuraStateSync();
      return;
    }
    if (item?.type === "gear") void deleteItemFreeSettingsEffects(item.parent, item.id);
    if (isEquipmentItem(item)) queueActorAbilityEffectSync(item.parent, {}, { aura: item?.type === "gear" });
    else if (item?.type === "gear") queueAuraStateSync();
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (!isAbilityEffectSyncRelevant(changes)) return;
    queueActorAbilityEffectSync(actor, {}, { aura: true });
  });
  Hooks.on("updateToken", (tokenDocument, changes) => {
    const relevant = isAuraTokenUpdateRelevant(changes);
    const movementActionChanged = foundry.utils.hasProperty(changes, "movementAction");
    const positionChanged = isAuraTokenPositionUpdate(changes);
    if (positionChanged) {
      queueAuraSyncAfterTokenMovement(tokenDocument, { syncMovingActor: movementActionChanged });
      return;
    }
    if (movementActionChanged) {
      queueActorAbilityEffectSync(tokenDocument?.actor, { actorToken: tokenDocument }, { aura: relevant });
    }
    if (relevant && !movementActionChanged) queueAuraStateSync();
  });
  Hooks.on("createToken", () => queueAuraStateSync());
  Hooks.on("deleteToken", () => queueAuraStateSync());
  Hooks.on("createActiveEffect", effect => {
    if (isCoverEffect(effect)) queueCoverAbilityEffectSync(effect.parent);
    if (!getAuraGeneratedEffectFlag(effect)) queueAuraStateSync();
  });
  Hooks.on("updateActiveEffect", effect => {
    if (isCoverEffect(effect)) queueCoverAbilityEffectSync(effect.parent);
    const managed = Boolean(effect?.getFlag?.(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY) || effect?.getFlag?.(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY));
    if (!getAuraGeneratedEffectFlag(effect) && !managed) queueAuraStateSync();
    if (!managed) return;
    queueActorAbilityEffectSync(effect.parent, {}, { aura: true });
  });
  Hooks.on("deleteActiveEffect", effect => {
    if (isCoverEffect(effect)) queueCoverAbilityEffectSync(effect.parent);
    const managed = Boolean(effect?.getFlag?.(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY) || effect?.getFlag?.(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY));
    if (!getAuraGeneratedEffectFlag(effect) && !managed) queueAuraStateSync();
    if (!managed) return;
    queueActorAbilityEffectSync(effect.parent, {}, { aura: true });
  });
  Hooks.on("fallout-maw.energyConsumptionChanged", actor => {
    queueActorAbilityEffectSync(actor, {}, { aura: true });
  });
  Hooks.on("canvasReady", () => {
    // Ready already runs a full sync; avoid overlapping ~300ms work during preset startup.
    if (!game.ready) return;
    void syncLoadedActorAbilityEffects();
  });
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

export async function syncLoadedActorAbilityEffects() {
  if (!game.user?.isActiveGM) return;
  const actors = new Map();
  for (const actor of game.actors ?? []) actors.set(actor.uuid, { actor, context: {} });
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.set(token.actor.uuid, { actor: token.actor, context: { actorToken: token.document } });
  }
  for (const { actor, context } of actors.values()) await syncActorAbilityEffects(actor, context);
  await syncAuraGeneratedEffects();
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
    const abilityItems = actor.items?.filter(item => item.type === "ability") ?? [];
    const activeAbilityItemIds = new Set(abilityItems.map(item => item.id));
    const itemFreeSettingsItems = getActorItemsWithActiveHudModules(actor).filter(item => isActiveItemFreeSettingsItem(item));
    const activeItemFreeSettingsItemIds = new Set(itemFreeSettingsItems.map(item => item.id));

    for (const item of abilityItems) {
      await syncSingleAbilityEffect(actor, item, context);
      await syncTimedTriggerCostEffects(actor, item, item.system?.functions ?? [], context);
    }
    for (const item of itemFreeSettingsItems) {
      await syncSingleItemFreeSettingsEffect(actor, item, context);
      await syncTimedTriggerCostEffects(
        actor,
        item,
        item.system?.functions?.freeSettings?.entries ?? [],
        context
      );
    }

    const stale = actor.effects
      .filter(effect => {
        const data = effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY);
        return data?.abilityItemId && !activeAbilityItemIds.has(data.abilityItemId);
      });
    await deleteAbilitySyncEffects(actor, stale, ABILITY_EFFECT_FLAG_KEY);

    const staleItemEffects = actor.effects
      .filter(effect => {
        const data = effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY);
        return data?.itemId && !activeItemFreeSettingsItemIds.has(data.itemId);
      });
    await deleteAbilitySyncEffects(actor, staleItemEffects, ITEM_EFFECT_FLAG_KEY);
  } finally {
    processingActors.delete(actor.uuid);
  }
}

async function syncSingleAbilityEffect(actor, item, context = {}) {
  const existing = actor.effects.filter(effect => effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.abilityItemId === item.id);
  const operationOptions = getAbilityEffectOperationOptions(item);
  const changes = buildAbilityEffectChanges(actor, item, context);
  if (!changes.length) {
    if (existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(effect => effect.id), operationOptions);
    return;
  }

  const sourceId = getAbilitySourceId(item);
  const showIcon = getAbilityEffectShowIcon(actor, item, context);
  const signature = JSON.stringify({ itemId: item.id, sourceId, changes, showIcon });
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  if (obsolete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete, operationOptions);

  if (current) {
    const update = {};
    if (current.disabled) update.disabled = false;
    if (current.name !== item.name) update.name = item.name;
    if (current.img !== item.img) update.img = item.img;
    if (current.origin !== item.uuid) update.origin = item.uuid;
    if (current.showIcon !== showIcon) update.showIcon = showIcon;
    const auraCondition = hasAuraConditionFunction(item?.system?.functions ?? []);
    if (current.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.auraCondition !== auraCondition) {
      update[`flags.${SYSTEM_ID}.${ABILITY_EFFECT_FLAG_KEY}.auraCondition`] = auraCondition;
    }
    if (Object.keys(update).length) await current.update(update);
    return;
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [buildAbilityActiveEffectData(item, changes, signature, sourceId, showIcon)], operationOptions);
}

async function syncSingleItemFreeSettingsEffect(actor, item, context = {}) {
  const existing = actor.effects.filter(effect => effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.itemId === item.id);
  const operationOptions = getItemFreeSettingsEffectOperationOptions(item);
  const changes = buildItemFreeSettingsEffectChanges(actor, item, context);
  if (!changes.length) {
    if (existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(effect => effect.id), operationOptions);
    return;
  }

  const showIcon = getItemFreeSettingsEffectShowIcon(actor, item, context);
  const signature = JSON.stringify({ itemId: item.id, changes, showIcon });
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  if (obsolete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete, operationOptions);

  if (current) {
    const update = {};
    if (current.disabled) update.disabled = false;
    if (current.name !== item.name) update.name = item.name;
    if (current.img !== item.img) update.img = item.img;
    if (current.origin !== item.uuid) update.origin = item.uuid;
    if (current.showIcon !== showIcon) update.showIcon = showIcon;
    const auraCondition = hasAuraConditionFunction(item?.system?.functions?.freeSettings?.entries ?? []);
    if (current.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.auraCondition !== auraCondition) {
      update[`flags.${SYSTEM_ID}.${ITEM_EFFECT_FLAG_KEY}.auraCondition`] = auraCondition;
    }
    if (Object.keys(update).length) await current.update(update);
    return;
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [buildItemFreeSettingsActiveEffectData(item, changes, signature, showIcon)], operationOptions);
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
  for (const sourceToken of canvas?.tokens?.placeables ?? []) {
    const sourceActor = sourceToken?.actor;
    if (!sourceActor || !["character", "construct"].includes(sourceActor.type)) continue;
    for (const source of getAuraSourceFunctionSets(sourceActor)) {
      for (const entry of normalizeAbilityFunctions(source.functions)) {
        if (entry.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
        if (hasEventReactionCondition(entry.conditions)) continue;
        for (const condition of findAuraDistributionConditions(entry.conditions)) {
          const targets = getAuraGeneratedTargetTokens(sourceActor, condition, { actorToken: sourceToken });
          if (!targets.length) continue;
          for (const targetToken of targets) {
            const targetActor = targetToken?.actor;
            if (!targetActor) continue;
            const changes = prepareAuraGeneratedChanges(sourceActor, getAbilityFunctionChangesForSatisfiedAuraCondition(sourceActor, entry, condition, {
              abilityItemId: source.item.id,
              actorToken: sourceToken,
              targetActor,
              targetToken
            })).filter(isApplicableGeneratedAuraChange);
            if (!changes.length) continue;
            const key = [
              source.kind,
              sourceActor.uuid,
              source.item.id,
              entry.id,
              condition.id
            ].join(".");
            const triggerCost = buildAuraTriggerCostData(sourceActor, source, entry);
            const signature = JSON.stringify({ key, changes, triggerCost });
            const data = buildAuraGeneratedActiveEffectData(source, sourceActor, entry, condition, changes, key, signature);
            const actorDesired = desired.get(targetActor.uuid) ?? new Map();
            actorDesired.set(key, data);
            desired.set(targetActor.uuid, actorDesired);
          }
        }
      }
    }
  }
  return desired;
}

function getAuraSourceFunctionSets(actor) {
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

function buildAuraGeneratedActiveEffectData(source, sourceActor, entry, condition, changes, key, signature) {
  const triggerCost = buildAuraTriggerCostData(sourceActor, source, entry);
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
        [AURA_GENERATED_EFFECT_FLAG_KEY]: {
          key,
          signature,
          sourceKind: source.kind,
          sourceActorUuid: sourceActor.uuid,
          itemId: source.item.id,
          functionId: entry.id,
          conditionId: condition.id,
          ...(triggerCost ? { triggerCost } : {})
        }
      }
    }
  };
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
    if (actor?.effects?.some(effect => getAuraGeneratedEffectFlag(effect))) actors.set(actor.uuid, actor);
  }
  for (const token of canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (!actor?.uuid) continue;
    if (desired.has(actor.uuid) || actor.effects?.some(effect => getAuraGeneratedEffectFlag(effect))) actors.set(actor.uuid, actor);
  }
  return actors;
}

async function reconcileActorAuraGeneratedEffects(actor, desired = new Map()) {
  if (!actor) return;
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
    existingByKey.set(key, effect);
  }
  if (deletions.length) await actor.deleteEmbeddedDocuments("ActiveEffect", deletions, { animate: false });

  const creations = [];
  for (const [key, data] of desired.entries()) {
    if (!existingByKey.has(key)) creations.push(data);
  }
  if (creations.length) await actor.createEmbeddedDocuments("ActiveEffect", creations, { animate: false });
}

function prepareAuraGeneratedChanges(sourceActor, changes = []) {
  return (changes ?? []).map(change => prepareEffectChangeForApplication(sourceActor, change));
}

function isApplicableGeneratedAuraChange(change = {}) {
  return String(change?.key ?? "").trim()
    && String(change?.value ?? "") !== ""
    && !String(change?.key ?? "").startsWith("system.skillAdvancementBase.");
}

function buildAbilityActiveEffectData(item, changes, signature, sourceId, showIcon) {
  const auraCondition = hasAuraConditionFunction(item?.system?.functions ?? []);
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

function buildItemFreeSettingsActiveEffectData(item, changes, signature, showIcon) {
  const auraCondition = hasAuraConditionFunction(item?.system?.functions?.freeSettings?.entries ?? []);
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
        [ITEM_EFFECT_FLAG_KEY]: {
          itemId: item.id,
          signature,
          auraCondition
        }
      }
    }
  };
}

function buildAbilityEffectChanges(actor, item, context = {}) {
  return getAbilityEffectChangesFromFunctions(
    actor,
    withoutTimedTriggerCostFunctions(item?.system?.functions ?? []),
    { ...context, abilityItemId: item?.id ?? "" }
  )
    .filter(change => !String(change?.key ?? "").startsWith("system.skillAdvancementBase."));
}

function buildItemFreeSettingsEffectChanges(actor, item, context = {}) {
  return getAbilityEffectChangesFromFunctions(actor, withoutTimedTriggerCostFunctions(
    item?.system?.functions?.freeSettings?.entries ?? []
  ), {
    ...context,
    abilityItemId: item?.id ?? ""
  })
    .filter(change => !String(change?.key ?? "").startsWith("system.skillAdvancementBase."));
}

function getAbilityEffectShowIcon(actor, item, context = {}) {
  return hasActiveRuntimeAbilityState(actor, item, context)
    ? ACTIVE_EFFECT_SHOW_ICON_ALWAYS
    : ACTIVE_EFFECT_SHOW_ICON_CONDITIONAL;
}

function getItemFreeSettingsEffectShowIcon(actor, item, context = {}) {
  return hasActiveRuntimeItemFreeSettingsState(actor, item, context)
    ? ACTIVE_EFFECT_SHOW_ICON_ALWAYS
    : ACTIVE_EFFECT_SHOW_ICON_CONDITIONAL;
}

function hasActiveRuntimeAbilityState(actor, item, context = {}) {
  return withoutTimedTriggerCostFunctions(item?.system?.functions ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .filter(entry => !hasEventReactionCondition(entry.conditions))
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

function hasActiveRuntimeItemFreeSettingsState(actor, item, context = {}) {
  return withoutTimedTriggerCostFunctions(item?.system?.functions?.freeSettings?.entries ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .filter(entry => !hasEventReactionCondition(entry.conditions))
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
    && condition.type !== ABILITY_CONDITION_TYPES.cooldown
    && condition.type !== ABILITY_CONDITION_TYPES.duration
    && condition.type !== ABILITY_CONDITION_TYPES.triggerCost
  ));
}

function getAbilityEffectOperationOptions(item) {
  return hasAuraConditionFunction(item?.system?.functions ?? []) ? { animate: false } : {};
}

function getItemFreeSettingsEffectOperationOptions(item) {
  return hasAuraConditionFunction(item?.system?.functions?.freeSettings?.entries ?? []) ? { animate: false } : {};
}

function hasAuraConditionFunction(functions = []) {
  return normalizeAbilityFunctions(functions)
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .filter(entry => !hasEventReactionCondition(entry.conditions))
    .some(entry => (entry.conditions ?? []).some(condition => condition?.type === ABILITY_CONDITION_TYPES.aura));
}

function hasAuraPresenceConditionFunction(functions = []) {
  return normalizeAbilityFunctions(functions)
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .filter(entry => !hasEventReactionCondition(entry.conditions))
    .some(entry => (entry.conditions ?? []).some(condition => (
      condition?.type === ABILITY_CONDITION_TYPES.aura
      && condition?.auraMode !== "applyToTargets"
    )));
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
    && !String(change?.key ?? "").startsWith("system.skillAdvancementBase.")
  ));
}

async function deleteAbilityEffects(actor, abilityItemId = "") {
  if (!actor || !game.user?.isActiveGM || !abilityItemId) return;
  const effects = actor.effects
    .filter(effect => effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.abilityItemId === abilityItemId);
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

async function deleteItemFreeSettingsEffects(actor, itemId = "") {
  if (!actor || !game.user?.isActiveGM || !itemId) return;
  const effects = actor.effects
    .filter(effect => effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.itemId === itemId);
  await deleteAbilitySyncEffects(actor, effects, ITEM_EFFECT_FLAG_KEY);
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
