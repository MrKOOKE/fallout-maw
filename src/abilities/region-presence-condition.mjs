import { SYSTEM_ID } from "../constants.mjs";
import { toInteger, toOptionalFiniteNumber } from "../utils/numbers.mjs";

export const PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
export const PERIODIC_DAMAGE_REGION_CLOCK_FLAG_KEY = "periodicDamage";

/** Test the engine-maintained regions currently intersecting a TokenDocument. */
export function tokenMatchesRegionPresenceCondition(token = null, condition = {}, {
  worldTime = Number(globalThis.game?.time?.worldTime) || 0
} = {}) {
  const tokenDocument = token?.document ?? token;
  const damageTypeKeys = new Set(normalizeKeyList(condition?.damageTypeKeys));
  const specialPropertyTypes = new Set(normalizeKeyList(condition?.regionSpecialPropertyTypes));
  if (!damageTypeKeys.size && !specialPropertyTypes.size) return false;

  for (const region of tokenDocument?.regions ?? []) {
    for (const behavior of region?.behaviors ?? []) {
      if (!isPeriodicDamageRegionBehaviorActive(region, behavior, { worldTime })) continue;
      if (damageTypeKeys.size && getBehaviorDamageTypeKeys(behavior).some(key => damageTypeKeys.has(key))) {
        return true;
      }
      if (
        specialPropertyTypes.size
        && getBehaviorSpecialPropertyTypes(behavior).some(type => specialPropertyTypes.has(type))
      ) return true;
    }
  }
  return false;
}

export function isPeriodicDamageRegionBehaviorActive(region = null, behavior = null, {
  worldTime = Number(globalThis.game?.time?.worldTime) || 0
} = {}) {
  if (
    !region
    || region.hidden
    || !behavior
    || behavior.disabled
    || behavior.type !== PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE
  ) return false;
  const system = behavior.system ?? {};
  const state = behavior.getFlag?.(SYSTEM_ID, PERIODIC_DAMAGE_REGION_CLOCK_FLAG_KEY)
    ?? behavior.flags?.[SYSTEM_ID]?.[PERIODIC_DAMAGE_REGION_CLOCK_FLAG_KEY]
    ?? {};
  if (Math.max(0, toInteger(system.delaySeconds)) > 0) {
    const activateAt = toOptionalFiniteNumber(state?.activateAt);
    if (!Number.isFinite(activateAt) || worldTime < activateAt) return false;
  }
  const expiresAt = toOptionalFiniteNumber(state?.expiresAt);
  return !Number.isFinite(expiresAt) || worldTime < expiresAt;
}

function getBehaviorDamageTypeKeys(behavior = {}) {
  return asArray(behavior?.system?.damageEntries)
    .map(entry => String(entry?.damageTypeKey ?? "").trim())
    .filter(Boolean);
}

function getBehaviorSpecialPropertyTypes(behavior = {}) {
  return asArray(behavior?.system?.regionSpecialProperties)
    .map(entry => String(entry?.type ?? "").trim())
    .filter(Boolean);
}

function normalizeKeyList(value = []) {
  return Array.from(new Set(asArray(value).map(entry => String(entry ?? "").trim()).filter(Boolean)));
}

function asArray(value = []) {
  return Array.isArray(value) ? value : Object.values(value ?? {});
}
