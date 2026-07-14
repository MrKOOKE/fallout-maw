import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { hasEventReactionCondition } from "../events/event-reaction-schema.mjs";
import {
  ITEM_FUNCTIONS,
  getEnergyConsumerFunction,
  hasItemFunction
} from "../utils/item-functions.mjs";

const ACTIVE_LIGHT_SOURCES_FLAG = "activeLightSources";

export function getItemEnergyConsumptionConditions(item = null) {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.energyConsumer, { ignoreBroken: true })) return [];
  const seen = new Set();
  const conditions = [];
  for (const entry of normalizeAbilityFunctions(item.system?.functions?.freeSettings?.entries ?? [])) {
    if (entry.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
    if (hasEventReactionCondition(entry.conditions)) continue;
    for (const condition of entry.conditions ?? []) {
      if (condition?.type !== ABILITY_CONDITION_TYPES.energyConsumption) continue;
      const id = String(condition?.id ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      conditions.push({
        id,
        name: String(condition?.name ?? "").trim() || item.name || "Потребление энергии",
        amountPerHour: Math.max(0, Number(condition?.amountPerHour) || 0)
      });
    }
  }
  return conditions;
}

export function hasItemEnergyConsumptionInteraction(item = null) {
  return getItemEnergyConsumptionConditions(item).length > 0;
}

export function isItemEnergyConsumptionConditionActive(item = null, conditionId = "") {
  const key = String(conditionId ?? "").trim();
  if (!key) return false;
  return Boolean(getEnergyConsumerFunction(item)?.activeConditions?.[key]);
}

export function isItemEnergyConsumptionInteractionActive(item = null) {
  return getItemEnergyConsumptionConditions(item)
    .some(condition => isItemEnergyConsumptionConditionActive(item, condition.id));
}

export function resolveActorInteractionToken(actor = null, token = null) {
  const tokenDocument = token?.document ?? token ?? null;
  if (!actor) return tokenDocument?.actor ? tokenDocument : null;
  if (tokenDocument?.actor?.uuid && tokenDocument.actor.uuid === actor?.uuid) return tokenDocument;
  if (actor?.isToken && actor.token) return actor.token;

  const controlled = (globalThis.canvas?.tokens?.controlled ?? [])
    .map(placeable => placeable?.document ?? placeable)
    .find(document => document?.actor?.uuid === actor?.uuid);
  if (controlled) return controlled;

  return (globalThis.canvas?.tokens?.placeables ?? [])
    .map(placeable => placeable?.document ?? placeable)
    .find(document => document?.actor?.uuid === actor?.uuid) ?? null;
}

export function isItemLightSourceInteractionActive(tokenOrDocument = null, item = null) {
  if (!item?.id) return false;
  const tokenDocument = tokenOrDocument?.document ?? tokenOrDocument ?? null;
  const entries = tokenDocument?.getFlag?.(SYSTEM_ID, ACTIVE_LIGHT_SOURCES_FLAG)
    ?? tokenDocument?.flags?.[SYSTEM_ID]?.[ACTIVE_LIGHT_SOURCES_FLAG]
    ?? [];
  if (!Array.isArray(entries)) return false;
  return entries.some(entry => String(entry?.itemId ?? entry ?? "").trim() === String(item.id));
}

export function getItemInteractionState(actor = null, item = null, { token = null } = {}) {
  const sourceActor = actor ?? item?.actor ?? token?.actor ?? token?.document?.actor ?? null;
  const energyConditions = getItemEnergyConsumptionConditions(item);
  const hasEnergyConsumption = energyConditions.length > 0;
  const hasLightSource = hasItemFunction(item, ITEM_FUNCTIONS.lightSource, { ignoreBroken: true });
  const resolvedToken = hasLightSource ? resolveActorInteractionToken(sourceActor, token) : null;
  const energyActive = energyConditions.some(condition => (
    isItemEnergyConsumptionConditionActive(item, condition.id)
  ));
  const lightSourceActive = hasLightSource && isItemLightSourceInteractionActive(resolvedToken, item);
  const hasInteraction = hasEnergyConsumption || hasLightSource;

  return {
    hasInteraction,
    toggleable: hasInteraction,
    toggled: energyActive || lightSourceActive,
    hasEnergyConsumption,
    hasLightSource,
    primaryEnergyConditionId: energyConditions.at(0)?.id ?? "",
    energyConditionIds: energyConditions.map(condition => condition.id),
    token: resolvedToken
  };
}

export function hasItemInteraction(actor = null, item = null, options = {}) {
  return getItemInteractionState(actor, item, options).hasInteraction;
}
