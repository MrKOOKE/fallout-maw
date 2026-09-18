import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import {
  QUALITY_SERVICE_GRANT_FLAG_KEY,
  QUALITY_SERVICE_MAINTAINED_EFFECTS,
  buildQualityServiceGrantEffectData,
  getQualityServiceSelfTier,
  isQualityServiceSelfPassive
} from "./quality-service.mjs";

/** Flag key of the passive bonus a quality-service owner keeps on themselves. */
export const QUALITY_SERVICE_SELF_FLAG_KEY = "qualityServiceSelf";
/** Grant kind used to tell the passive owner bonus apart from an ordinary target hold. */
export const QUALITY_SERVICE_PASSIVE_GRANT_KIND = "passive";
/** Grant kind of the ordinary, energy-maintained bonus handed to another actor. */
export const QUALITY_SERVICE_HOLD_GRANT_KIND = "hold";

const ACTIVE_EFFECT_SHOW_ICON_NEVER = 0;

/** The authoring switch on the fixed function that makes the owner bonus passive. */
export function getQualityServiceSelfPassiveFunctions(abilityItem = null) {
  if (abilityItem?.type !== "ability") return [];
  return normalizeAbilityFunctions(abilityItem.system?.functions ?? []).filter(entry => (
    entry.type === ABILITY_FUNCTION_TYPES.fixed
    && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.qualityService
    && isQualityServiceSelfPassive(entry.fixedSettings)
  ));
}

export function qualityServiceFunctionIsSelfPassive(abilityFunction = null) {
  return Boolean(
    abilityFunction
    && abilityFunction.type === ABILITY_FUNCTION_TYPES.fixed
    && abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.qualityService
    && isQualityServiceSelfPassive(abilityFunction.fixedSettings)
  );
}

export function buildQualityServiceSelfGrantEffectData({
  sourceActor = null,
  abilityItem = null,
  abilityFunction = null,
  tier = null
} = {}) {
  const profile = tier ?? getQualityServiceSelfTier(abilityFunction?.fixedSettings);
  const targetActor = sourceActor;
  return buildQualityServiceGrantEffectData({
    sourceActor,
    abilityItem,
    abilityFunction,
    targetActor,
    tier: profile,
    metadata: { kind: QUALITY_SERVICE_PASSIVE_GRANT_KIND }
  });
}

export function findQualityServiceSelfGrant(actor = null, {
  abilityItemId = "",
  functionId = "",
  includeInactive = false
} = {}) {
  const itemId = String(abilityItemId ?? "").trim();
  const requestedFunctionId = String(functionId ?? "").trim();
  return Array.from(actor?.effects ?? []).find(effect => {
    if (!includeInactive && !isActiveEffect(effect)) return false;
    const data = getQualityServiceSelfGrantData(effect);
    if (!data) return false;
    if (itemId && String(data.abilityItemId ?? "") !== itemId) return false;
    return !requestedFunctionId || String(data.functionId ?? "") === requestedFunctionId;
  }) ?? null;
}

export function getQualityServiceSelfGrantData(effect = null) {
  return effect?.getFlag?.(SYSTEM_ID, QUALITY_SERVICE_SELF_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[QUALITY_SERVICE_SELF_FLAG_KEY]
    ?? null;
}

/**
 * Keep one passive owner bonus per switched-on quality-service function and drop
 * the energy-maintained hold the owner may still be paying for on themselves.
 */
export async function reconcileQualityServicePassiveEffects(abilityItem = null) {
  const actor = abilityItem?.parent ?? null;
  if (!actor || abilityItem?.type !== "ability") return false;
  const functions = getQualityServiceSelfPassiveFunctions(abilityItem);
  const effectIds = Array.from(actor.effects ?? [])
    .filter(effect => (
      String(getQualityServiceSelfGrantData(effect)?.abilityItemId ?? "") === String(abilityItem.id ?? "")
    ))
    .map(effect => effect.id)
    .filter(Boolean);
  if (!functions.length) {
    if (effectIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
    return false;
  }

  let changed = false;
  for (const abilityFunction of functions) {
    const existing = findQualityServiceSelfGrant(actor, {
      abilityItemId: abilityItem.id,
      functionId: abilityFunction.id,
      includeInactive: true
    });
    const effectData = buildQualityServiceSelfGrantEffectData({
      sourceActor: actor,
      abilityItem,
      abilityFunction
    });
    await upsertQualityServiceSelfGrant(actor, existing, effectData);
    changed = true;
  }
  if (await releaseQualityServiceSelfHolds(actor, abilityItem)) changed = true;
  return changed;
}

/**
 * The passive owner bonus replaces an active hold on the owner, which pays
 * energy for exactly the same bonuses the passive already grants.
 */
export async function releaseQualityServiceSelfHolds(actor = null, abilityItem = null) {
  if (!actor) return false;
  const obsoleteIds = Array.from(actor.effects ?? [])
    .filter(effect => {
      const data = effect?.getFlag?.(SYSTEM_ID, QUALITY_SERVICE_GRANT_FLAG_KEY)
        ?? effect?.flags?.[SYSTEM_ID]?.[QUALITY_SERVICE_GRANT_FLAG_KEY]
        ?? null;
      if (!data || String(data.kind ?? "") !== QUALITY_SERVICE_HOLD_GRANT_KIND) return false;
      if (String(data.targetActorUuid ?? "") !== String(actor.uuid ?? "")) return false;
      return !abilityItem || String(data.abilityItemId ?? "") === String(abilityItem.id ?? "");
    })
    .map(effect => effect.id)
    .filter(Boolean);
  if (!obsoleteIds.length) return false;
  const holds = obsoleteIds
    .map(effectId => actor.effects?.get?.(effectId))
    .filter(Boolean);
  await actor.deleteEmbeddedDocuments("ActiveEffect", obsoleteIds, { animate: false });
  for (const hold of holds) await deleteQualityServiceGrantForHold(hold);
  return true;
}

/**
 * Drop the visible bonus the released hold was maintaining on the owner, so the
 * passive effect stays the only source of the owner bonus.
 */
async function deleteQualityServiceGrantForHold(holdEffect = null) {
  const hold = QUALITY_SERVICE_MAINTAINED_EFFECTS.getHoldData(holdEffect);
  const targetActor = hold?.targetActorUuid
    ? await fromUuid(String(hold.targetActorUuid))
    : null;
  if (!targetActor) return false;
  const grant = QUALITY_SERVICE_MAINTAINED_EFFECTS.findGrant(targetActor, {
    sourceActorUuid: String(hold.sourceActorUuid ?? ""),
    abilityItemId: hold.abilityItemId,
    functionId: hold.functionId,
    kind: QUALITY_SERVICE_HOLD_GRANT_KIND,
    includeInactive: true
  });
  if (!grant) return false;
  await targetActor.deleteEmbeddedDocuments("ActiveEffect", [grant.id], { animate: false });
  return true;
}

export async function cleanupQualityServicePassiveEffects(abilityItem = null) {
  const actor = abilityItem?.parent ?? null;
  if (!actor || abilityItem?.type !== "ability") return false;
  const effectIds = Array.from(actor.effects ?? [])
    .filter(effect => (
      String(getQualityServiceSelfGrantData(effect)?.abilityItemId ?? "") === String(abilityItem.id ?? "")
    ))
    .map(effect => effect.id)
    .filter(Boolean);
  if (!effectIds.length) return false;
  await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
  return true;
}

export function abilityItemHasQualityService(item = null) {
  if (item?.type !== "ability") return false;
  return normalizeAbilityFunctions(item.system?.functions ?? []).some(entry => (
    entry.type === ABILITY_FUNCTION_TYPES.fixed
    && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.qualityService
  ));
}

async function upsertQualityServiceSelfGrant(actor, effect, effectData) {
  const updateData = {
    name: effectData.name,
    img: effectData.img,
    origin: effectData.origin,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_NEVER,
    start: null,
    duration: {
      value: null,
      units: "seconds",
      expiry: null,
      expired: false
    },
    system: { changes: effectData.system.changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "passive",
        [QUALITY_SERVICE_SELF_FLAG_KEY]: effectData.flags[SYSTEM_ID][QUALITY_SERVICE_GRANT_FLAG_KEY]
      }
    }
  };
  if (!effect) {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      type: "base",
      ...updateData
    }], { animate: false });
    return null;
  }
  if (qualityServiceSelfGrantMatches(effect, effectData)) return effect;
  await effect.update(updateData, { animate: false });
  return effect;
}

/** Reconciling on every ability edit must not rewrite an already correct effect. */
function qualityServiceSelfGrantMatches(effect, effectData) {
  const current = getQualityServiceSelfGrantData(effect);
  const desired = effectData.flags[SYSTEM_ID][QUALITY_SERVICE_GRANT_FLAG_KEY];
  if (!current) return false;
  if (String(effect.name ?? "") !== String(effectData.name ?? "")) return false;
  if (String(effect.img ?? "") !== String(effectData.img ?? "")) return false;
  if (String(effect.origin ?? "") !== String(effectData.origin ?? "")) return false;
  if (effect.disabled !== false || Number(effect.showIcon) !== ACTIVE_EFFECT_SHOW_ICON_NEVER) return false;
  if (effect.duration?.expired === true) return false;
  const metadataMatches = Object.entries(desired)
    .every(([key, value]) => String(current[key] ?? "") === String(value ?? ""));
  if (!metadataMatches) return false;
  return qualityServiceChangesMatch(effect.system?.changes, effectData.system.changes);
}

function qualityServiceChangesMatch(current = [], desired = []) {
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

function isActiveEffect(effect) {
  return Boolean(effect && !effect.disabled && effect.active !== false && effect.duration?.expired !== true);
}
