import { SYSTEM_ID } from "../constants.mjs";
import { ENERGY_RESOURCE_KEY } from "../combat/energy-resource.mjs";

export const MAINTAINED_TARGET_EFFECT_SYNC_OPTION = "falloutMawMaintainedTargetSync";

const DAMAGE_EFFECT_FLAG_KEY = "damageEffect";

/** Build one isolated flag-backed effect API for an energy-maintained target ability. */
export function createMaintainedTargetEffectApi({
  holdFlagKey = "",
  grantFlagKey = "",
  color = "#8fd3ff"
} = {}) {
  const holdKey = String(holdFlagKey).trim();
  const grantKey = String(grantFlagKey).trim();
  if (!holdKey || !grantKey) throw new Error("Maintained target effects require both flag keys.");

  const getHoldData = effect => getSystemFlag(effect, holdKey);
  const getGrantData = effect => getSystemFlag(effect, grantKey);

  return Object.freeze({
    holdFlagKey: holdKey,
    grantFlagKey: grantKey,
    getHoldData,
    getGrantData,
    getHolds(actor = null, filters = {}) {
      return getMaintainedHolds(actor, getHoldData, filters);
    },
    findGrant(actor = null, filters = {}) {
      return findMaintainedGrant(actor, getGrantData, filters);
    },
    buildGrantEffectData(context = {}) {
      return buildMaintainedGrantEffectData(context, { grantFlagKey: grantKey });
    },
    buildHoldEffectData(context = {}) {
      return buildMaintainedHoldEffectData(context, { holdFlagKey: holdKey, color });
    }
  });
}

function getMaintainedHolds(actor, getHoldData, {
  abilityItemId = "",
  functionId = "",
  includeInactive = false
} = {}) {
  const requestedItemId = String(abilityItemId ?? "").trim();
  const requestedFunctionId = String(functionId ?? "").trim();
  return Array.from(actor?.effects ?? []).filter(effect => {
    if (!includeInactive && !isActiveEffect(effect)) return false;
    const data = getHoldData(effect);
    if (!data) return false;
    if (requestedItemId && String(data.abilityItemId ?? "") !== requestedItemId) return false;
    return !requestedFunctionId || String(data.functionId ?? "") === requestedFunctionId;
  });
}

function findMaintainedGrant(actor, getGrantData, {
  sourceActorUuid = "",
  abilityItemId = "",
  functionId = "",
  includeInactive = false
} = {}) {
  const sourceUuid = String(sourceActorUuid ?? "").trim();
  const itemId = String(abilityItemId ?? "").trim();
  const requestedFunctionId = String(functionId ?? "").trim();
  return Array.from(actor?.effects ?? []).find(effect => {
    if (!includeInactive && !isActiveEffect(effect)) return false;
    const data = getGrantData(effect);
    if (!data) return false;
    if (sourceUuid && String(data.sourceActorUuid ?? "") !== sourceUuid) return false;
    if (itemId && String(data.abilityItemId ?? "") !== itemId) return false;
    return !requestedFunctionId || String(data.functionId ?? "") === requestedFunctionId;
  }) ?? null;
}

function buildMaintainedGrantEffectData({
  sourceActor = null,
  abilityItem = null,
  abilityFunction = null,
  targetActor = null,
  changes = [],
  metadata = {},
  fallbackName = "Удерживаемый бонус"
} = {}, { grantFlagKey }) {
  return {
    type: "base",
    name: String(abilityItem?.name ?? fallbackName),
    img: String(abilityItem?.img ?? "") || "icons/svg/upgrade.svg",
    origin: String(abilityItem?.uuid ?? ""),
    transfer: false,
    disabled: false,
    showIcon: 0,
    system: { changes: cloneChanges(changes) },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [grantFlagKey]: {
          sourceActorUuid: String(sourceActor?.uuid ?? ""),
          abilityItemId: String(abilityItem?.id ?? ""),
          abilityItemUuid: String(abilityItem?.uuid ?? ""),
          functionId: String(abilityFunction?.id ?? ""),
          targetActorUuid: String(targetActor?.uuid ?? ""),
          ...metadata
        }
      }
    }
  };
}

function buildMaintainedHoldEffectData({
  sourceActor = null,
  abilityItem = null,
  abilityFunction = null,
  targetActor = null,
  targetEffectId = "",
  holdEnergy = 0,
  metadata = {},
  fallbackName = "Удерживаемый бонус"
} = {}, { holdFlagKey, color }) {
  const energy = Math.max(0, toInteger(holdEnergy));
  const functionId = String(abilityFunction?.id ?? "");
  const source = {
    sourceActorUuid: String(sourceActor?.uuid ?? ""),
    abilityItemUuid: String(abilityItem?.uuid ?? ""),
    abilityFunctionId: functionId,
    targetActorUuid: String(targetActor?.uuid ?? "")
  };
  return {
    type: "base",
    name: `${String(abilityItem?.name ?? fallbackName)}: ${String(targetActor?.name ?? "цель")}`,
    img: String(abilityItem?.img ?? "") || "icons/svg/upgrade.svg",
    origin: String(abilityItem?.uuid ?? ""),
    transfer: false,
    disabled: false,
    showIcon: 0,
    system: { changes: [] },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [DAMAGE_EFFECT_FLAG_KEY]: {
          kind: "resourceBlock",
          resources: { [ENERGY_RESOURCE_KEY]: energy },
          color,
          source
        },
        [holdFlagKey]: {
          ...source,
          abilityItemId: String(abilityItem?.id ?? ""),
          functionId,
          targetActorName: String(targetActor?.name ?? ""),
          targetActorImg: String(targetActor?.img ?? ""),
          targetEffectId: String(targetEffectId ?? ""),
          holdEnergy: energy,
          ...metadata
        }
      }
    }
  };
}

function getSystemFlag(effect, key) {
  return effect?.getFlag?.(SYSTEM_ID, key) ?? effect?.flags?.[SYSTEM_ID]?.[key] ?? null;
}

function isActiveEffect(effect) {
  return Boolean(effect && !effect.disabled && effect.active !== false && effect.duration?.expired !== true);
}

function cloneChanges(changes) {
  return (Array.isArray(changes) ? changes : []).map(change => ({ ...change }));
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
