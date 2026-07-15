import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  getAbilityFunctionEffectDurationSeconds,
  getAbilitySourceId,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { abilityConditionApplies } from "./evaluation.mjs";
import { requestLimitedChangeSelection } from "./purchase.mjs";
import {
  ABILITY_ITEM_USE_COUNTERS_FLAG_KEY,
  getAbilityItemUseCounterKey,
  normalizeAbilityItemUseCategories
} from "./runtime-state.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { hasEventReactionCondition } from "../events/event-reaction-schema.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import { getActorItemsWithActiveHudModules } from "../utils/hud-active-items.mjs";
import { getAbilityEffectOriginUuid } from "../utils/ability-effect-origin.mjs";
import {
  notifyAbilityTriggerCostFailure,
  payAbilityFunctionTriggerCost
} from "./trigger-cost-runtime.mjs";
import { getCurrentDamageHubOperationRef } from "../combat/damage-hub.mjs";

const ABILITY_ITEM_USE_EFFECT_FLAG_KEY = "abilityItemUseEffect";
const ABILITY_ITEM_USE_COMMITTED_COSTS_FLAG_KEY = "abilityItemUseCommittedTriggerCosts";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const committedItemUseCosts = new Map();
let itemUseObserverRegistered = false;

export function registerAbilityItemUseHooks() {
  if (itemUseObserverRegistered) return;
  itemUseObserverRegistered = true;
  registerSystemEventObserver({
    id: "fallout-maw.abilityItemUseTriggers",
    eventKeys: ["fallout-maw.item.use.resolved"],
    priority: 200,
    observe: observeResolvedItemUse
  });
}

async function observeResolvedItemUse({ event, scope } = {}) {
  if (!event?.outcome?.success) return;
  if (event?.data?.action === "lightSource" && event?.data?.active !== true) return;
  const actorUuid = String(event?.source?.actorUuid ?? event?.data?.sourceActorUuid ?? "").trim();
  if (!actorUuid) return;
  let actor;
  try {
    actor = await fromUuid(actorUuid);
  } catch (_error) {
    return;
  }
  if (!actor) return;

  const itemData = event?.data?.item ?? {};
  const itemUuid = String(event?.source?.itemUuid ?? itemData.uuid ?? "").trim();
  let item = null;
  try {
    item = itemUuid ? await fromUuid(itemUuid) : null;
  } catch (_error) {
    item = null;
  }
  item ??= createUsedItemSnapshot(itemData);
  if (!item) return;
  const damageHubOperationRef = String(
    event?.data?.damageHubOperationRef
    ?? event?.data?.request?.damageHubOperationRef
    ?? getCurrentDamageHubOperationRef()
    ?? ""
  ).trim();
  await applyAbilityItemUseTriggers({ actor, item }, {
    chainRef: scope?.chainRef ?? null,
    rootId: scope?.rootId ?? event?.rootId ?? "",
    eventId: event?.eventId ?? "",
    damageHubOperationRef
  });
}

function createUsedItemSnapshot(data = {}) {
  const itemCategory = String(data?.itemCategory ?? "").trim();
  if (!itemCategory) return null;
  return {
    id: String(data?.id ?? ""),
    uuid: String(data?.uuid ?? ""),
    name: String(data?.name ?? ""),
    type: String(data?.type ?? ""),
    system: { itemCategory }
  };
}

async function applyAbilityItemUseTriggers({ actor = null, item = null } = {}, {
  chainRef = null,
  rootId = "",
  eventId = "",
  damageHubOperationRef = ""
} = {}) {
  if (!actor?.isOwner || !item) return [];

  const entries = findTriggeredItemUseEntries(actor, item);
  const results = [];
  for (const entry of entries) {
    const result = await advanceItemUseCounter(actor, entry, {
      chainRef,
      rootId,
      eventId,
      damageHubOperationRef
    });
    if (result) results.push(result);
  }
  return results;
}

function findTriggeredItemUseEntries(actor, usedItem) {
  const entries = [];
  for (const abilityItem of getActorItemsWithActiveHudModules(actor)) {
    const sourceFunctions = abilityItem?.type === "ability"
      ? abilityItem.system?.functions ?? []
      : isActiveFreeSettingsGear(abilityItem)
        ? abilityItem.system?.functions?.freeSettings?.entries ?? []
        : [];

    for (const abilityFunction of normalizeAbilityFunctions(sourceFunctions)) {
      if (abilityFunction.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
      if (hasEventReactionCondition(abilityFunction.conditions)) continue;

      const matchingConditions = (abilityFunction.conditions ?? [])
        .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.itemUse)
        .filter(condition => itemUseConditionMatches(condition, usedItem));
      if (!matchingConditions.length) continue;

      const context = {
        abilityItemId: abilityItem.id,
        functionId: abilityFunction.id,
        usedItem
      };
      if (!triggerConditionsApply(actor, abilityFunction.conditions, context)) continue;

      for (const condition of matchingConditions) {
        entries.push({ abilityItem, abilityFunction, condition, usedItem });
      }
    }
  }
  return entries;
}

function triggerConditionsApply(actor, conditions = [], context = {}) {
  const standalone = [];
  const groups = new Map();
  for (const condition of conditions ?? []) {
    if (!condition?.type) continue;
    const groupId = String(condition?.groupId ?? "").trim();
    if (!groupId) {
      standalone.push(condition);
      continue;
    }
    const entries = groups.get(groupId) ?? [];
    entries.push(condition);
    groups.set(groupId, entries);
  }

  return standalone.every(condition => triggerConditionApplies(actor, condition, context))
    && Array.from(groups.values()).every(group => group.some(condition => triggerConditionApplies(actor, condition, context)));
}

function triggerConditionApplies(actor, condition = {}, context = {}) {
  if (condition.type === ABILITY_CONDITION_TYPES.limitedChanges) return true;
  if (condition.type === ABILITY_CONDITION_TYPES.triggerCost) return true;
  if (condition.type === ABILITY_CONDITION_TYPES.itemUse) return itemUseConditionMatches(condition, context.usedItem);
  return abilityConditionApplies(actor, condition, context);
}

function itemUseConditionMatches(condition = {}, item = null) {
  const itemCategory = String(item?.system?.itemCategory ?? "").trim();
  if (!itemCategory) return false;
  const categories = new Set(normalizeAbilityItemUseCategories(condition.itemCategories));
  return categories.has(itemCategory);
}

async function advanceItemUseCounter(actor, entry, {
  chainRef = null,
  rootId = "",
  eventId = "",
  damageHubOperationRef = ""
} = {}) {
  const key = getAbilityItemUseCounterKey(entry);
  if (!key) return null;

  const requiredCount = Math.max(1, toInteger(entry.condition?.requiredCount ?? entry.condition?.limit ?? 1));
  const counters = foundry.utils.deepClone(entry.abilityItem.getFlag(SYSTEM_ID, ABILITY_ITEM_USE_COUNTERS_FLAG_KEY) ?? {});
  const nextCount = Math.min(requiredCount, Math.max(0, toInteger(counters[key])) + 1);
  counters[key] = nextCount;
  const updateOptions = createItemUseTriggerDocumentOptions(chainRef);

  // Persist the reached threshold before any awaited picker/payment. The
  // current attempt then either commits an effect or consumes and resets it.
  await entry.abilityItem.update({
    [`flags.${SYSTEM_ID}.${ABILITY_ITEM_USE_COUNTERS_FLAG_KEY}`]: counters
  }, updateOptions);
  if (nextCount < requiredCount) return null;

  const committedKey = getCommittedItemUseCostKey(entry.abilityItem, key);
  let committedCost = getCommittedItemUseCost(entry.abilityItem, key, committedKey);
  const committedEffect = findActorEffect(actor, committedCost?.effectId);
  if (committedEffect) {
    await resetItemUseTriggerState(entry.abilityItem, counters, key, committedKey, updateOptions, {
      clearCommittedCost: true
    });
    return committedEffect;
  }

  const changes = await selectRuntimeChanges(entry.abilityItem, entry.abilityFunction);
  if (!changes?.length) {
    if (!committedCost) {
      await resetItemUseTriggerState(entry.abilityItem, counters, key, committedKey, updateOptions);
    }
    return null;
  }

  if (!committedCost) {
    const payment = await payAbilityFunctionTriggerCost({
      actor,
      sourceItem: entry.abilityItem,
      abilityFunction: entry.abilityFunction,
      context: {
        rootId,
        eventId,
        chainRef,
        occurrenceId: `item-use:${entry.abilityItem.uuid}:${key}`,
        inDamageHubOperation: Boolean(damageHubOperationRef),
        damageHubOperation: damageHubOperationRef ? "current" : null
      }
    });
    if (!payment.ok) {
      notifyAbilityTriggerCostFailure(payment);
      await resetItemUseTriggerState(entry.abilityItem, counters, key, committedKey, updateOptions);
      return null;
    }
    if (payment.execution) {
      committedCost = {
        rootId: String(rootId ?? ""),
        eventId: String(eventId ?? ""),
        effectId: "",
        committedAt: Number(game.time?.worldTime) || 0
      };
      committedItemUseCosts.set(committedKey, committedCost);
      await persistCommittedItemUseCost(entry.abilityItem, key, committedCost, updateOptions);
    }
  }

  const createdEffect = await createTriggeredAbilityEffect(actor, entry, { chainRef, changes });
  if (!createdEffect) return null;
  if (committedCost) {
    committedCost = { ...committedCost, effectId: String(createdEffect.id ?? createdEffect._id ?? "") };
    committedItemUseCosts.set(committedKey, committedCost);
    await persistCommittedItemUseCost(entry.abilityItem, key, committedCost, updateOptions);
  }
  await resetItemUseTriggerState(entry.abilityItem, counters, key, committedKey, updateOptions, {
    clearCommittedCost: Boolean(committedCost)
  });
  return createdEffect;
}

async function createTriggeredAbilityEffect(actor, { abilityItem, abilityFunction, condition, usedItem } = {}, {
  chainRef = null,
  changes = []
} = {}) {
  if (!changes?.length) return null;
  const durationSeconds = resolveItemUseEffectDurationSeconds(abilityFunction, condition);
  const startTime = Number(game.time?.worldTime) || 0;
  const effectData = {
    type: "base",
    name: abilityItem.name,
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: getAbilityEffectOriginUuid(actor, abilityItem),
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: durationSeconds > 0 ? "temporary" : "active",
        [ABILITY_ITEM_USE_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          conditionId: condition.id,
          usedItemId: usedItem?.id ?? "",
          usedItemName: usedItem?.name ?? "",
          createdAt: startTime
        }
      }
    }
  };

  if (durationSeconds > 0) {
    effectData.duration = {
      seconds: durationSeconds,
      startTime
    };
  }

  const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effectData], {
    animate: false,
    ...createItemUseTriggerDocumentOptions(chainRef)
  });
  return created ?? null;
}

function createItemUseTriggerDocumentOptions(chainRef = null) {
  return chainRef
    ? { chainRef, falloutMawSystemEventChainRef: chainRef }
    : {};
}

async function selectRuntimeChanges(abilityItem, abilityFunction = {}) {
  const changes = (abilityFunction.changes ?? [])
    .filter(change => String(change?.key ?? "").trim() && String(change?.value ?? "") !== "");
  if (!changes.length) return [];

  const limitedConditions = (abilityFunction.conditions ?? [])
    .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.limitedChanges);
  if (!limitedConditions.length) return changes;

  const limit = Math.max(1, Math.min(
    changes.length,
    ...limitedConditions.map(condition => toInteger(condition.limit ?? 1))
  ));
  if (limit >= changes.length) return changes;

  const selectedIds = await requestLimitedChangeSelection({
    abilityName: abilityItem.name,
    changes,
    limit
  });
  if (!selectedIds) return null;

  const selected = new Set(selectedIds);
  return changes.filter((change, index) => selected.has(getChangeSelectionId(change, index)));
}

function getChangeSelectionId(change = {}, index = 0) {
  return String(change?.id ?? "").trim() || `change-${index}`;
}

function isActiveFreeSettingsGear(item = null) {
  if (item?.type !== "gear" || !item.system?.functions?.freeSettings?.enabled) return false;
  return Boolean(item.system?.equipped)
    || ["equipment", "weapon", "constructPart"].includes(item.system?.placement?.mode);
}

function resolveItemUseEffectDurationSeconds(abilityFunction = {}, itemUseCondition = {}) {
  const functionDuration = getAbilityFunctionEffectDurationSeconds(abilityFunction);
  if (functionDuration > 0) return functionDuration;
  return Math.max(0, toInteger(
    itemUseCondition?.durationSeconds
    ?? itemUseCondition?.duration
    ?? itemUseCondition?.seconds
  ));
}

function getCommittedItemUseCostKey(item = null, counterKey = "") {
  return `${String(item?.uuid ?? item?.id ?? "")}:${String(counterKey ?? "")}`;
}

function getCommittedItemUseCost(item = null, counterKey = "", committedKey = "") {
  const memory = committedItemUseCosts.get(committedKey);
  if (memory) return { ...memory };
  const stored = item?.getFlag?.(SYSTEM_ID, ABILITY_ITEM_USE_COMMITTED_COSTS_FLAG_KEY)?.[counterKey];
  return stored && typeof stored === "object" ? { ...stored } : null;
}

async function persistCommittedItemUseCost(item, counterKey, committedCost, updateOptions) {
  try {
    await item.update({
      [`flags.${SYSTEM_ID}.${ABILITY_ITEM_USE_COMMITTED_COSTS_FLAG_KEY}.${counterKey}`]: committedCost
    }, updateOptions);
  } catch (error) {
    // The in-memory marker still prevents a second charge during this session.
    console.error("fallout-maw | Item Use trigger-cost marker could not be persisted.", error);
  }
}

async function resetItemUseTriggerState(item, counters, counterKey, committedKey, updateOptions, {
  clearCommittedCost = false
} = {}) {
  const update = Object.keys(counters).length <= 1
    ? { [`flags.${SYSTEM_ID}.${ABILITY_ITEM_USE_COUNTERS_FLAG_KEY}`]: globalThis._del }
    : { [`flags.${SYSTEM_ID}.${ABILITY_ITEM_USE_COUNTERS_FLAG_KEY}.${counterKey}`]: globalThis._del };
  if (clearCommittedCost) {
    update[`flags.${SYSTEM_ID}.${ABILITY_ITEM_USE_COMMITTED_COSTS_FLAG_KEY}.${counterKey}`] = globalThis._del;
  }
  await item.update(update, updateOptions);
  committedItemUseCosts.delete(committedKey);
}

function findActorEffect(actor = null, effectId = "") {
  const id = String(effectId ?? "").trim();
  if (!id) return null;
  return actor?.effects?.get?.(id)
    ?? Array.from(actor?.effects ?? []).find(effect => String(effect?.id ?? effect?._id ?? "") === id)
    ?? null;
}
