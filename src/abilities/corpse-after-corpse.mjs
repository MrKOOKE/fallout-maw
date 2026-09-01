import { SYSTEM_ID } from "../constants.mjs";
import { toInteger } from "../utils/numbers.mjs";

// Kept local so the attack-resolution helper stays importable without loading
// the UI-heavy overload module. This is the persisted public flag key.
const ABILITY_OVERLOAD_EFFECT_FLAG_KEY = "abilityOverload";

export const CORPSE_AFTER_CORPSE_DEFAULT_SETTINGS = Object.freeze({
  activationEnergyCost: 30,
  overloadEnergyCost: 100,
  overloadDurationSeconds: 3600,
  damagePercentBonus: 200,
  attackWaitDurationSeconds: 12
});

export function normalizeCorpseAfterCorpseSettings(settings = {}) {
  return {
    activationEnergyCost: nonNegativeInteger(settings.activationEnergyCost, 30),
    overloadEnergyCost: nonNegativeInteger(settings.overloadEnergyCost, 100),
    overloadDurationSeconds: nonNegativeInteger(settings.overloadDurationSeconds, 3600),
    damagePercentBonus: finiteInteger(settings.damagePercentBonus, 200),
    attackWaitDurationSeconds: nonNegativeInteger(settings.attackWaitDurationSeconds, 12)
  };
}

/** One kill-bearing attack cycle may clear overload once, regardless of checks. */
export function resolveCorpseAfterCorpseKill(state = {}, context = {}) {
  const current = { lastKillAttackId: String(state?.lastKillAttackId ?? "").trim() };
  const attackId = String(context?.attackId ?? "").trim();
  if (attackId && current.lastKillAttackId === attackId) {
    return { shouldClear: false, duplicate: true, nextState: current };
  }
  const killedTargetUuids = uniqueStrings(context?.killedTargetUuids);
  if (!attackId || !killedTargetUuids.length) {
    return { shouldClear: false, duplicate: false, nextState: current };
  }
  return {
    shouldClear: true,
    duplicate: false,
    killedTargetUuids,
    nextState: { lastKillAttackId: attackId }
  };
}

/**
 * Exact overload ownership matching. The function id is mandatory so another
 * function on the same ability item can never be removed accidentally.
 */
export function findCorpseAfterCorpseOverloadEffectIds(actor = null, identity = {}) {
  const functionId = String(identity?.functionId ?? "").trim();
  if (!actor || !functionId) return [];
  const abilityItemId = String(identity?.abilityItemId ?? "").trim();
  const abilitySourceId = String(identity?.abilitySourceId ?? "").trim();
  const fixedKey = String(identity?.fixedKey ?? "").trim();
  const effects = Array.from(actor?.effects?.contents ?? actor?.effects ?? []);
  return effects.filter(effect => {
    if (!effect || effect.disabled || effect.isExpired || effect.duration?.expired === true) return false;
    const overload = getOverloadData(effect);
    if (!overload || String(overload.functionId ?? "").trim() !== functionId) return false;
    if (fixedKey && String(overload.fixedKey ?? "").trim() !== fixedKey) return false;
    const sourceId = String(overload.abilitySourceId ?? "").trim();
    if (abilitySourceId && sourceId) return abilitySourceId === sourceId;
    return Boolean(abilityItemId) && String(overload.abilityItemId ?? "").trim() === abilityItemId;
  }).map(effect => String(effect.id ?? "").trim()).filter(Boolean);
}

export async function clearCorpseAfterCorpseOverload(actor = null, identity = {}) {
  const effectIds = findCorpseAfterCorpseOverloadEffectIds(actor, identity);
  if (!effectIds.length || typeof actor?.deleteEmbeddedDocuments !== "function") return [];
  await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
  return effectIds;
}

function getOverloadData(effect) {
  return effect?.getFlag?.(SYSTEM_ID, ABILITY_OVERLOAD_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[ABILITY_OVERLOAD_EFFECT_FLAG_KEY]
    ?? null;
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, finiteInteger(value, fallback));
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return toInteger(Number.isFinite(number) ? number : fallback);
}
