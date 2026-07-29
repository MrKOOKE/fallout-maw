import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_AURA_MODES,
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import {
  findAuraDistributionConditions,
  findAuraTriggerConditions
} from "./aura-conditions.mjs";

export const ACTIVE_APPLICATION_EFFECT_FLAG_KEY = "activeApplication";

export function getActiveApplicationEffectFlag(effect = null) {
  return effect?.getFlag?.(SYSTEM_ID, ACTIVE_APPLICATION_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[ACTIVE_APPLICATION_EFFECT_FLAG_KEY]
    ?? null;
}

export function normalizeActiveApplicationFunction(functionData = null) {
  if (!functionData || typeof functionData !== "object") return null;
  const abilityFunction = normalizeAbilityFunctions([functionData])[0] ?? null;
  return abilityFunction?.type === ABILITY_FUNCTION_TYPES.activeApplication
    ? abilityFunction
    : null;
}

export function getActiveApplicationEffectAuraDescriptor(effect = null) {
  const flag = getActiveApplicationEffectFlag(effect);
  const abilityFunction = normalizeActiveApplicationFunction(flag?.functionData);
  if (!flag || !abilityFunction) return null;
  return {
    flag,
    abilityFunction,
    distributionConditions: findAuraDistributionConditions(abilityFunction.conditions),
    triggerConditions: findAuraTriggerConditions(abilityFunction.conditions)
  };
}

export function getActiveApplicationEffectAuraProjectionDescriptor(effect = null) {
  const descriptor = getActiveApplicationEffectAuraDescriptor(effect);
  if (!descriptor) return null;
  const routesPrimaryChangesThroughTrials = activeApplicationFunctionRoutesPrimaryChangesThroughTrials(
    descriptor.abilityFunction
  );
  return {
    ...descriptor,
    routesPrimaryChangesThroughTrials,
    projectionFunction: {
      ...descriptor.abilityFunction,
      // The ActiveEffect owns lifetime and location. Its payload follows the
      // same target-projection contract as an effectChanges function.
      type: ABILITY_FUNCTION_TYPES.effectChanges,
      ...(routesPrimaryChangesThroughTrials ? { changes: [], penalties: [] } : {})
    }
  };
}

export function activeApplicationFunctionHasAuraMode(functionData = null, mode = "") {
  if (
    functionData?.type === ABILITY_FUNCTION_TYPES.activeApplication
    && Object.values(ABILITY_AURA_MODES).includes(mode)
    && Array.isArray(functionData?.conditions)
    && functionData.conditions.some(condition => (
      condition?.type === ABILITY_CONDITION_TYPES.aura
      && condition?.auraMode === mode
    ))
  ) return true;
  const abilityFunction = normalizeActiveApplicationFunction(functionData);
  return Boolean(
    abilityFunction
    && Object.values(ABILITY_AURA_MODES).includes(mode)
    && (abilityFunction.conditions ?? []).some(condition => (
      condition?.type === ABILITY_CONDITION_TYPES.aura && condition?.auraMode === mode
    ))
  );
}

export function activeApplicationFunctionHasDistributionAura(functionData = null) {
  return activeApplicationFunctionHasAuraMode(functionData, ABILITY_AURA_MODES.applyToTargets);
}

export function activeApplicationFunctionHasTriggerAura(functionData = null) {
  return activeApplicationFunctionHasAuraMode(functionData, ABILITY_AURA_MODES.triggerConditions);
}

export function activeApplicationFunctionHasRuntimeAura(functionData = null) {
  return activeApplicationFunctionHasDistributionAura(functionData)
    || activeApplicationFunctionHasTriggerAura(functionData);
}

export function activeApplicationFunctionRoutesPrimaryChangesThroughTrials(functionData = null) {
  const abilityFunction = normalizeActiveApplicationFunction(functionData);
  return Boolean(abilityFunction?.conditions?.some(condition => (
    condition?.type === ABILITY_CONDITION_TYPES.trial
    && condition?.trialRoutesPrimaryChanges === true
  )));
}

export function prepareActiveApplicationAuraFunctionData(functionData = null, {
  changeEvaluation = "target",
  prepareChange = change => change
} = {}) {
  if (
    changeEvaluation !== "source"
    || !activeApplicationFunctionHasDistributionAura(functionData)
  ) return functionData;
  const prepareRows = rows => (rows ?? []).map(change => prepareChange(change));
  return {
    ...functionData,
    changes: prepareRows(functionData?.changes),
    penalties: prepareRows(functionData?.penalties)
  };
}

export function resolveActiveApplicationMarkerChanges(functionData = null, {
  changeSnapshot = null,
  evaluateChanges = () => []
} = {}) {
  if (activeApplicationFunctionHasDistributionAura(functionData)) return [];
  if (Array.isArray(changeSnapshot)) return cloneActiveApplicationData(changeSnapshot);
  const changes = evaluateChanges();
  return Array.isArray(changes) ? changes : [];
}

export function buildActiveApplicationMarkerChangeUpdate(effect = null, flag = null, changes = []) {
  const desiredChanges = Array.isArray(changes) ? changes : [];
  const signature = JSON.stringify(desiredChanges);
  const currentSignature = JSON.stringify(Array.from(effect?.system?.changes ?? []));
  if (
    signature === String(flag?.signature ?? "")
    && currentSignature === signature
  ) return {};
  return {
    "system.changes": desiredChanges,
    [`flags.${SYSTEM_ID}.${ACTIVE_APPLICATION_EFFECT_FLAG_KEY}.signature`]: signature
  };
}

function cloneActiveApplicationData(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
