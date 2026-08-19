import { SYSTEM_ID } from "../constants.mjs";
import { normalizeAbilityFunctions } from "../settings/abilities.mjs";

export const EFFECT_LIFECYCLE_FLAG_KEY = "effectLifecycle";

export const EFFECT_LIFECYCLE_KINDS = Object.freeze({
  sourceProjection: "sourceProjection",
  disposableInstance: "disposableInstance",
  reconciledInstance: "reconciledInstance"
});

/** Locate the managed function snapshot stored on a generated ActiveEffect. */
export function getEffectFunctionDescriptor(effect = null) {
  const systemFlags = effect?.flags?.[SYSTEM_ID] ?? {};
  for (const [flagKey, data] of Object.entries(systemFlags)) {
    if (!data || typeof data !== "object" || !data.functionData || typeof data.functionData !== "object") continue;
    return { flagKey, data, functionData: data.functionData };
  }
  return null;
}

export function getEffectLifecycleKind(effect = null) {
  return String(effect?.flags?.[SYSTEM_ID]?.[EFFECT_LIFECYCLE_FLAG_KEY]?.kind ?? "");
}

/** Resolve the current source functions represented by a managed effect. */
export function getEffectSourceFunctionContext(effect = null, actor = null) {
  const systemFlags = effect?.flags?.[SYSTEM_ID] ?? {};
  const sourceItem = resolveEffectSourceItem(effect, actor, systemFlags);
  const functions = getEffectSourceFunctions(sourceItem);
  const functionIds = getEffectSourceFunctionIds(systemFlags);
  const effectChangeKeys = new Set(getEffectChanges(effect)
    .map(change => String(change?.key ?? "").trim())
    .filter(Boolean));
  const applicableFunctions = functionIds.size
    ? functions.filter(abilityFunction => functionIds.has(String(abilityFunction?.id ?? "")))
    : functions.filter(abilityFunction => abilityFunctionMatchesEffectChanges(abilityFunction, effectChangeKeys));
  return {
    systemFlags,
    sourceItem,
    functions,
    functionIds,
    effectChangeKeys,
    applicableFunctions,
    descriptor: getEffectFunctionDescriptor(effect),
    lifecycleKind: getEffectLifecycleKind(effect)
  };
}

/**
 * Keep only the function fields needed to attribute an applied change back to
 * its conditions. Generated effects must not retain the much larger action or
 * fixed-function configuration when they cannot execute it themselves.
 */
export function buildEffectFunctionSnapshot(abilityFunction = {}) {
  if (!String(abilityFunction?.id ?? "").trim()) return null;
  const normalized = normalizeAbilityFunctions([abilityFunction])[0];
  return buildNormalizedEffectFunctionSnapshot(normalized);
}

export function buildNormalizedEffectFunctionSnapshot(normalized = null) {
  if (!String(normalized?.id ?? "").trim()) return null;
  return clonePlainData({
    id: normalized.id,
    type: normalized.type,
    includeInPureValues: normalized.includeInPureValues === true,
    changes: normalized.changes ?? [],
    conditions: normalized.conditions ?? [],
    penalties: normalized.penalties ?? []
  });
}

function clonePlainData(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function resolveEffectSourceItem(effect = null, actor = null, systemFlags = {}) {
  const uuidCandidates = [
    systemFlags?.eventReaction?.sourceItemUuid,
    systemFlags?.abilityTimedTriggerEffect?.sourceItemUuid,
    systemFlags?.activeApplication?.sourceItemUuid,
    systemFlags?.auraGenerated?.sourceItemUuid,
    systemFlags?.auraGenerated?.triggerCost?.sourceItemUuid,
    effect?.origin
  ];
  for (const uuid of uuidCandidates) {
    const item = resolveDocumentUuidSync(uuid, "Item");
    if (item) return item;
  }

  const itemIds = [
    systemFlags?.abilityEffect?.abilityItemId,
    systemFlags?.itemEffect?.itemId,
    systemFlags?.abilityItemUseEffect?.abilityItemId,
    systemFlags?.abilityTimedTriggerEffect?.sourceItemId,
    systemFlags?.activeApplication?.abilityItemId,
    systemFlags?.auraGenerated?.itemId,
    systemFlags?.auraGenerated?.sourceItemId
  ].map(value => String(value ?? "").trim()).filter(Boolean);
  const sourceActors = [
    resolveDocumentUuidSync(systemFlags?.auraGenerated?.sourceActorUuid, "Actor"),
    resolveDocumentUuidSync(systemFlags?.activeApplication?.sourceActorUuid, "Actor"),
    actor,
    effect?.parent
  ].filter(Boolean);
  for (const sourceActor of sourceActors) {
    for (const itemId of itemIds) {
      const item = sourceActor?.items?.get?.(itemId)
        ?? Array.from(sourceActor?.items ?? []).find(entry => String(entry?.id ?? "") === itemId);
      if (item) return item;
    }
  }
  return null;
}

function resolveDocumentUuidSync(uuid = "", documentName = "") {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  try {
    const document = globalThis.fromUuidSync?.(value)
      ?? globalThis.foundry?.utils?.fromUuidSync?.(value)
      ?? null;
    const name = String(document?.documentName ?? document?.constructor?.metadata?.name ?? "");
    return name === documentName ? document : null;
  } catch (_error) {
    return null;
  }
}

function getEffectSourceFunctions(sourceItem = null) {
  const functions = sourceItem?.type === "ability"
    ? sourceItem.system?.functions ?? []
    : sourceItem?.type === "gear"
      ? sourceItem.system?.functions?.freeSettings?.entries ?? []
      : [];
  return normalizeAbilityFunctions(functions);
}

function getEffectSourceFunctionIds(systemFlags = {}) {
  return new Set([
    systemFlags?.eventReaction?.functionId,
    systemFlags?.abilityTimedTriggerEffect?.functionId,
    systemFlags?.abilityItemUseEffect?.functionId,
    systemFlags?.activeApplication?.functionId,
    systemFlags?.auraGenerated?.functionId
  ].map(value => String(value ?? "").trim()).filter(Boolean));
}

function getEffectChanges(effect = null) {
  const changes = effect?.system?.changes ?? effect?.changes ?? [];
  return Array.isArray(changes) ? changes : [];
}

function abilityFunctionMatchesEffectChanges(abilityFunction = {}, effectChangeKeys = new Set()) {
  if (!effectChangeKeys.size) return false;
  return [...(abilityFunction?.changes ?? []), ...(abilityFunction?.penalties ?? [])]
    .some(change => effectChangeKeys.has(String(change?.key ?? "").trim()));
}
