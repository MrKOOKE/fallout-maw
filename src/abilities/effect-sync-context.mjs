import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_AURA_MODES,
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  isAbilityFunctionTimedTriggerCost,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { hasEventReactionCondition } from "../events/event-reaction-schema.mjs";

export const ABILITY_EFFECT_FLAG_KEY = "abilityEffect";
export const ITEM_EFFECT_FLAG_KEY = "itemEffect";
export const EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY = "equipmentRequirementEffect";

export function abilityFunctionsMayContainAuraCondition(functions = []) {
  const entries = Array.isArray(functions) ? functions : Object.values(functions ?? {});
  return entries.some(entry => {
    const rawConditions = entry?.conditions ?? (entry?.condition ? [entry.condition] : []);
    const conditions = Array.isArray(rawConditions)
      ? rawConditions
      : Object.values(rawConditions ?? {});
    return conditions.some(condition => condition?.type === ABILITY_CONDITION_TYPES.aura);
  });
}

/**
 * Build one preparation-scoped view of a source Item's ability functions.
 *
 * The normalized objects deliberately remain shared by every consumer in the
 * same synchronous/awaited reconciliation. Rebuild this descriptor after the
 * source Item changes; do not retain it as document state.
 */
export function buildAbilityEffectSourceDescriptor(functions = []) {
  const normalizedFunctions = normalizeAbilityFunctions(functions);
  const projectionFunctions = [];
  const timedFunctions = [];
  const passiveEffectFunctions = [];

  for (const abilityFunction of normalizedFunctions) {
    if (isAbilityFunctionTimedTriggerCost(abilityFunction)) {
      timedFunctions.push(abilityFunction);
      continue;
    }

    projectionFunctions.push(abilityFunction);
    if (
      abilityFunction?.type === ABILITY_FUNCTION_TYPES.effectChanges
      && !hasEventReactionCondition(abilityFunction.conditions)
    ) {
      passiveEffectFunctions.push(abilityFunction);
    }
  }

  const auraFunctions = passiveEffectFunctions.filter(abilityFunction => (
    (abilityFunction.conditions ?? [])
      .some(condition => condition?.type === ABILITY_CONDITION_TYPES.aura)
  ));

  return {
    normalizedFunctions,
    projectionFunctions,
    timedFunctions,
    passiveEffectFunctions,
    hasAuraCondition: auraFunctions.length > 0,
    hasAuraPresenceCondition: auraFunctions.some(abilityFunction => (
      (abilityFunction.conditions ?? []).some(condition => (
        condition?.type === ABILITY_CONDITION_TYPES.aura
        && condition?.auraMode !== ABILITY_AURA_MODES.applyToTargets
      ))
    ))
  };
}

/**
 * Index all managed source-projection effects with one Actor.effects pass.
 *
 * Map keys intentionally retain their stored type. This preserves the legacy
 * strict identity checks: a malformed numeric source id remains stale instead
 * of being silently matched to a string Item id.
 */
export function buildActorAbilityEffectSyncIndex(actor = null) {
  const index = {
    abilityEffectsByItemId: new Map(),
    abilityEffectEntries: [],
    itemEffectsByItemId: new Map(),
    itemEffectEntries: [],
    equipmentRequirementEffectsByItemId: new Map(),
    equipmentRequirementEffectEntries: []
  };

  for (const effect of actor?.effects ?? []) {
    const abilityData = getManagedEffectFlag(effect, ABILITY_EFFECT_FLAG_KEY);
    if (abilityData?.abilityItemId) {
      appendIndexedEffect(
        index.abilityEffectsByItemId,
        index.abilityEffectEntries,
        abilityData.abilityItemId,
        effect
      );
    }

    const itemData = getManagedEffectFlag(effect, ITEM_EFFECT_FLAG_KEY);
    if (itemData?.itemId) {
      appendIndexedEffect(
        index.itemEffectsByItemId,
        index.itemEffectEntries,
        itemData.itemId,
        effect
      );
    }

    const equipmentData = getManagedEffectFlag(effect, EQUIPMENT_REQUIREMENT_EFFECT_FLAG_KEY);
    if (equipmentData?.itemId) {
      appendIndexedEffect(
        index.equipmentRequirementEffectsByItemId,
        index.equipmentRequirementEffectEntries,
        equipmentData.itemId,
        effect
      );
    }
  }

  return index;
}

export function getLiveIndexedEffects(actor, index, sourceId) {
  return (index.get(sourceId) ?? [])
    .filter(effect => isEmbeddedEffectLive(actor, effect));
}

export function getLiveStaleIndexedEffects(actor, entries, activeSourceIds) {
  return entries
    .filter(({ sourceId, effect }) => (
      !activeSourceIds.has(sourceId)
      && isEmbeddedEffectLive(actor, effect)
    ))
    .map(({ effect }) => effect);
}

function appendIndexedEffect(index, entries, sourceId, effect) {
  const effects = index.get(sourceId) ?? [];
  effects.push(effect);
  index.set(sourceId, effects);
  entries.push({ sourceId, effect });
}

function isEmbeddedEffectLive(actor, effect) {
  if (typeof actor?.effects?.has === "function") return actor.effects.has(effect?.id);
  return Array.from(actor?.effects ?? []).some(candidate => (
    candidate === effect
    || (effect?.id && candidate?.id === effect.id)
  ));
}

function getManagedEffectFlag(effect, flagKey) {
  const systemFlags = effect?.flags?.[SYSTEM_ID];
  if (systemFlags && Object.hasOwn(systemFlags, flagKey)) return systemFlags[flagKey];
  return effect?.getFlag?.(SYSTEM_ID, flagKey) ?? null;
}
