import {
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizeAttackActionSettings
} from "../settings/abilities.mjs";
import {
  ITEM_FUNCTIONS,
  getWeaponFunctionById,
  getWeaponFunctionModuleSlots,
  hasItemFunction
} from "../utils/item-functions.mjs";

/**
 * Resolve the source behind one attack without fabricating a temporary Item.
 *
 * Legacy weapons keep their existing storage shape. Ability attack functions
 * are projected to the legacy combat-data shape only for the duration of the
 * attack so the established damage, region, reaction and animation runtime can
 * be shared without persisting a synthetic `availableActions` object.
 */
export function resolveAttackSource(item = null, functionId = "") {
  if (!item) return null;
  const abilityFunction = getAbilityAttackFunction(item, functionId);
  if (abilityFunction) {
    const settings = normalizeAttackActionSettings(abilityFunction.attackSettings);
    return {
      kind: "abilityAttack",
      item,
      functionId: abilityFunction.id,
      abilityFunction,
      settings,
      actionKey: getAbilityAttackActionKey(settings),
      data: projectAbilityAttackData(settings)
    };
  }

  if (!hasItemFunction(item, ITEM_FUNCTIONS.weapon)) return null;
  const id = String(functionId || ITEM_FUNCTIONS.weapon);
  const data = getWeaponFunctionById(item, id);
  if (!data) return null;
  return {
    kind: "weapon",
    item,
    functionId: id,
    abilityFunction: null,
    settings: null,
    actionKey: "",
    data
  };
}

export function isAttackSource(item = null, functionId = "") {
  return Boolean(resolveAttackSource(item, functionId));
}

export function isAbilityAttackSource(item = null, functionId = "") {
  return resolveAttackSource(item, functionId)?.kind === "abilityAttack";
}

export function getAbilityAttackFunction(item = null, functionId = "") {
  if (item?.type !== "ability") return null;
  const id = String(functionId ?? "").trim();
  return normalizeAbilityFunctions(item.system?.functions ?? [])
    .find(entry => (
      entry.type === ABILITY_FUNCTION_TYPES.attackAction
      && (!id || String(entry.id ?? "") === id)
    )) ?? null;
}

export function getAbilityAttackSettings(item = null, functionId = "") {
  const abilityFunction = getAbilityAttackFunction(item, functionId);
  return abilityFunction ? normalizeAttackActionSettings(abilityFunction.attackSettings) : null;
}

export function getAbilityAttackActionKey(settings = {}) {
  const normalized = normalizeAttackActionSettings(settings);
  const count = Math.max(1, Math.trunc(Number(normalized.sequence?.count) || 1));
  if (normalized.targeting.mode === "area") return "volley";
  if (normalized.targeting.mode === "selectedTargets") {
    return normalized.targeting.aimed ? "aimedShot" : "snapshot";
  }
  return count > 1 ? "burst" : "snapshot";
}

export function getAttackSourceModuleSlots(item = null, functionId = "") {
  if (isAbilityAttackSource(item, functionId)) return [];
  return getWeaponFunctionModuleSlots(item, functionId);
}

export function getAttackSourceRawData(item = null, functionId = "") {
  const source = resolveAttackSource(item, functionId);
  if (!source) return {};
  if (source.kind === "abilityAttack") return projectAbilityAttackData(source.settings);

  const id = String(functionId || ITEM_FUNCTIONS.weapon);
  if (!id || id === ITEM_FUNCTIONS.weapon) return item.system?._source?.functions?.weapon ?? {};
  const additional = item.system?._source?.functions?.additionalWeapons ?? [];
  if (Array.isArray(additional)) {
    return additional.find(entry => String(entry?.id ?? "") === id) ?? {};
  }
  return additional?.[id] ?? {};
}

export function getAttackSourceUpdatePath(item = null, functionId = "") {
  if (item?.type !== "ability") return "";
  const id = String(functionId ?? "").trim();
  const functions = Array.from(item.system?.functions ?? []);
  const index = functions.findIndex(entry => (
    String(entry?.id ?? "") === id
    && String(entry?.type ?? "") === ABILITY_FUNCTION_TYPES.attackAction
  ));
  return index >= 0 ? `system.functions.${index}.attackSettings` : "";
}

export function createAbilityAttackUpdateData(item = null, functionId = "", relativeUpdates = {}) {
  const path = getAttackSourceUpdatePath(item, functionId);
  if (!path) return {};
  return Object.fromEntries(
    Object.entries(relativeUpdates ?? {}).map(([key, value]) => [`${path}.${key}`, value])
  );
}

export function projectAbilityAttackData(settings = {}) {
  const normalized = normalizeAttackActionSettings(settings);
  const actionKey = getAbilityAttackActionKey(normalized);
  const count = Math.max(1, Math.trunc(Number(normalized.sequence?.count) || 1));
  const consequences = foundry.utils.deepClone(normalized.criticalFailureConsequences ?? []);
  const action = {
    name: normalized.name,
    actionPointCost: 0,
    attackConeDegrees: normalized.targeting.attackConeDegrees,
    criticalFailureConsequences: consequences
  };
  const burst = {
    ...action,
    count,
    difficultyPerShot: Math.max(0, Math.trunc(Number(normalized.sequence?.difficultyPerAttack) || 0))
  };
  const volley = {
    ...action,
    ...foundry.utils.deepClone(normalized.area)
  };
  const availableActions = {
    aimedShot: actionKey === "aimedShot",
    snapshot: actionKey === "snapshot",
    burst: actionKey === "burst",
    volley: actionKey === "volley",
    meleeAttack: false,
    aimedMeleeAttack: false,
    push: false,
    reload: false
  };

  return {
    enabled: true,
    damageMode: "manual",
    damage: normalized.damage,
    pellets: normalized.pellets,
    damageTypeKey: normalized.damageTypeKey,
    damageTypes: foundry.utils.deepClone(normalized.damageTypes),
    attackAnimationKey: normalized.attackAnimationKey,
    attackSoundPath: normalized.attackSoundPath,
    attackSoundVolume: normalized.attackSoundVolume,
    attackAnimationDelayMs: normalized.attackAnimationDelayMs,
    proficiencyKey: normalized.proficiencyKey,
    skillKey: normalized.skillKey,
    accuracyBonus: normalized.accuracyBonus,
    criticalChanceModifier: normalized.criticalChanceModifier,
    criticalDamagePercent: normalized.criticalDamagePercent,
    attackConeDegrees: normalized.targeting.attackConeDegrees,
    maxRangeMeters: normalized.maxRangeMeters,
    effectiveRange: foundry.utils.deepClone(normalized.effectiveRange),
    penetration: normalized.penetration,
    noiseLevel: normalized.noiseLevel,
    magazine: { value: 0, max: 0, sourceItemUuid: "", sourceItemUuids: [] },
    resourceCosts: normalized.resourceCosts.map(cost => ({
      id: cost.id,
      type: "actorResource",
      resourceKey: cost.resourceKey,
      formula: cost.formula,
      amount: 0,
      overloadAmount: cost.overloadAmount,
      overloadDurationSeconds: cost.overloadDurationSeconds
    })),
    moduleSlots: [],
    specialProperties: foundry.utils.deepClone(normalized.specialProperties),
    requirements: foundry.utils.deepClone(normalized.requirements),
    availableActions,
    aimedShot: { ...action },
    snapshot: { ...action },
    burst,
    volley,
    meleeAttack: createDisabledMeleeAction(),
    aimedMeleeAttack: createDisabledMeleeAction(),
    push: {
      ...action,
      maxRangeMeters: 0,
      difficultyModifier: 0
    },
    reload: { name: "", actionPointCost: 0 }
  };
}

function createDisabledMeleeAction() {
  const mode = {
    enabled: false,
    accuracyModifier: 0,
    criticalChanceModifier: 0,
    damagePercentModifier: 0
  };
  return {
    name: "",
    actionPointCost: 0,
    attackConeDegrees: 0,
    thrust: { ...mode },
    swing: { ...mode },
    criticalFailureConsequences: []
  };
}
