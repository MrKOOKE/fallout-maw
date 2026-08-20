import { SYSTEM_ID } from "../constants.mjs";
import { toInteger } from "../utils/numbers.mjs";

/** Metadata stored on the short-lived Active Effect created by the fixed ability. */
export const SHADOW_EFFECT_FLAG_KEY = "shadow";

const shadowSourcesByTarget = new Map();
const indexedEffectTargets = new WeakMap();
let shadowIndexInitialized = false;
let shadowIndexHooksRegistered = false;

/**
 * Register the small effect index used by the resource observer. The index is
 * deliberately kept outside the Actor model: Shadow is target-specific and
 * must not add a prepared Active Effect change for every possible target.
 */
export function registerShadowEffectIndexHooks() {
  if (shadowIndexHooksRegistered) return;
  shadowIndexHooksRegistered = true;
  Hooks.on("createActiveEffect", effect => indexShadowEffect(effect));
  Hooks.on("updateActiveEffect", effect => indexShadowEffect(effect, { replace: true }));
  Hooks.on("deleteActiveEffect", effect => removeIndexedShadowEffect(effect));
  Hooks.on("deleteActor", actor => removeShadowSource(actor));
  Hooks.on("canvasReady", () => {
    shadowIndexInitialized = false;
    shadowSourcesByTarget.clear();
  });
}

/**
 * Return the active target-specific stealth bonus for one check. The caller
 * supplies the observer/target Actor, so ordinary stealth checks stay on the
 * existing `modifySkillCheck` path and no global scan is needed.
 */
export function getShadowStealthBonus(actor = null, targetActor = null) {
  const targetUuid = String(targetActor?.uuid ?? targetActor ?? "").trim();
  if (!actor || !targetUuid) return 0;
  let bonus = 0;
  for (const effect of actor.effects ?? []) {
    const data = getShadowEffectData(effect);
    if (!data || String(data.targetActorUuid ?? "").trim() !== targetUuid) continue;
    bonus += Math.max(0, toInteger(data.stealthBonus));
  }
  return bonus;
}

/** Return source Actors whose current Shadow effect points at a target Actor. */
export function getShadowSourcesForTarget(targetActorUuid = "") {
  ensureShadowIndex();
  const targetUuid = String(targetActorUuid ?? "").trim();
  if (!targetUuid) return [];
  const entries = shadowSourcesByTarget.get(targetUuid);
  if (!entries?.size) return [];
  const result = [];
  for (const [sourceUuid, actor] of entries) {
    if (!actor?.uuid || !hasActiveShadowTarget(actor, targetUuid)) {
      entries.delete(sourceUuid);
      continue;
    }
    result.push(actor);
  }
  if (!entries.size) shadowSourcesByTarget.delete(targetUuid);
  return result;
}

export function getShadowEffectData(effect = null) {
  if (
    !effect
    || effect.disabled
    || effect.isSuppressed
    || effect.isExpired === true
    || effect.duration?.expired === true
  ) return null;
  const data = effect.getFlag?.(SYSTEM_ID, SHADOW_EFFECT_FLAG_KEY)
    ?? effect.flags?.[SYSTEM_ID]?.[SHADOW_EFFECT_FLAG_KEY];
  if (!data || typeof data !== "object") return null;
  const targetActorUuid = String(data.targetActorUuid ?? "").trim();
  if (!targetActorUuid) return null;
  return data;
}

function ensureShadowIndex() {
  if (shadowIndexInitialized) return;
  shadowIndexInitialized = true;
  shadowSourcesByTarget.clear();
  const actors = new Map();
  for (const actor of globalThis.game?.actors?.contents ?? []) {
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }
  for (const actor of actors.values()) {
    for (const effect of actor.effects ?? []) indexShadowEffect(effect);
  }
}

function indexShadowEffect(effect, { replace = false } = {}) {
  if (replace) removeIndexedShadowEffect(effect);
  const actor = effect?.parent;
  const data = getShadowEffectData(effect);
  const targetUuid = String(data?.targetActorUuid ?? "").trim();
  const sourceUuid = String(actor?.uuid ?? "").trim();
  if (!data || !targetUuid || !sourceUuid) return;
  let targets = shadowSourcesByTarget.get(targetUuid);
  if (!targets) {
    targets = new Map();
    shadowSourcesByTarget.set(targetUuid, targets);
  }
  targets.set(sourceUuid, actor);
  indexedEffectTargets.set(effect, targetUuid);
}

function removeIndexedShadowEffect(effect) {
  const targetUuid = indexedEffectTargets.get(effect);
  indexedEffectTargets.delete(effect);
  if (!targetUuid) return;
  const targets = shadowSourcesByTarget.get(targetUuid);
  const sourceUuid = String(effect?.parent?.uuid ?? "").trim();
  if (targets && sourceUuid) {
    targets.delete(sourceUuid);
    if (!targets.size) shadowSourcesByTarget.delete(targetUuid);
  }
}

function removeShadowSource(actor) {
  const sourceUuid = String(actor?.uuid ?? "").trim();
  if (!sourceUuid) return;
  for (const [targetUuid, targets] of shadowSourcesByTarget) {
    targets.delete(sourceUuid);
    if (!targets.size) shadowSourcesByTarget.delete(targetUuid);
  }
}

function hasActiveShadowTarget(actor, targetUuid) {
  for (const effect of actor?.effects ?? []) {
    const data = getShadowEffectData(effect);
    if (String(data?.targetActorUuid ?? "").trim() === targetUuid) return true;
  }
  return false;
}
