import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
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

const ABILITY_ITEM_USE_EFFECT_FLAG_KEY = "abilityItemUseEffect";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;

export function registerAbilityItemUseHooks() {
  Hooks.on("fallout-maw.itemUsed", context => {
    void applyAbilityItemUseTriggers(context);
  });
}

async function applyAbilityItemUseTriggers({ actor = null, item = null } = {}) {
  if (!actor?.isOwner || !item) return [];

  const entries = findTriggeredItemUseEntries(actor, item);
  const results = [];
  for (const entry of entries) {
    const result = await advanceItemUseCounter(actor, entry);
    if (result) results.push(result);
  }
  return results;
}

function findTriggeredItemUseEntries(actor, usedItem) {
  const entries = [];
  for (const abilityItem of actor.items ?? []) {
    if (abilityItem?.type !== "ability") continue;

    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;

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
  if (condition.type === ABILITY_CONDITION_TYPES.itemUse) return itemUseConditionMatches(condition, context.usedItem);
  return abilityConditionApplies(actor, condition, context);
}

function itemUseConditionMatches(condition = {}, item = null) {
  const itemCategory = String(item?.system?.itemCategory ?? "").trim();
  if (!itemCategory) return false;
  const categories = new Set(normalizeAbilityItemUseCategories(condition.itemCategories));
  return categories.has(itemCategory);
}

async function advanceItemUseCounter(actor, entry) {
  const key = getAbilityItemUseCounterKey(entry);
  if (!key) return null;

  const requiredCount = Math.max(1, toInteger(entry.condition?.requiredCount ?? entry.condition?.limit ?? 1));
  const counters = foundry.utils.deepClone(entry.abilityItem.getFlag(SYSTEM_ID, ABILITY_ITEM_USE_COUNTERS_FLAG_KEY) ?? {});
  const nextCount = Math.max(0, toInteger(counters[key])) + 1;
  counters[key] = nextCount;

  if (nextCount < requiredCount) {
    await entry.abilityItem.setFlag(SYSTEM_ID, ABILITY_ITEM_USE_COUNTERS_FLAG_KEY, counters);
    return null;
  }

  if (Object.keys(counters).length <= 1) await entry.abilityItem.unsetFlag(SYSTEM_ID, ABILITY_ITEM_USE_COUNTERS_FLAG_KEY);
  else await entry.abilityItem.update({ [`flags.${SYSTEM_ID}.${ABILITY_ITEM_USE_COUNTERS_FLAG_KEY}.-=${key}`]: null });
  return createTriggeredAbilityEffect(actor, entry);
}

async function createTriggeredAbilityEffect(actor, { abilityItem, abilityFunction, condition, usedItem } = {}) {
  const changes = await selectRuntimeChanges(abilityItem, abilityFunction);
  if (!changes?.length) return null;

  const durationSeconds = Math.max(0, toInteger(condition?.durationSeconds));
  const startTime = Number(game.time?.worldTime) || 0;
  const effectData = {
    type: "base",
    name: abilityItem.name,
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
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

  const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
  return created ?? null;
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
