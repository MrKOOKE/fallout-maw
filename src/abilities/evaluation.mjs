import { getCreatureOptions } from "../settings/accessors.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { DEFAULT_FACTION_NAME, getActorFactionBelongs } from "../settings/factions.mjs";
import {
  ABILITY_ATTACK_DISTANCE_MODES,
  ABILITY_ATTACK_DISTANCE_SIDES,
  ABILITY_CONDITION_TYPES,
  ABILITY_EQUIPMENT_OPERATORS,
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  ABILITY_HEALTH_LIMB_ALL,
  ABILITY_HEALTH_TARGETS,
  ABILITY_POSTURE_SUBJECTS,
  normalizeAbilityFunctions,
  normalizeVersatileDevelopmentSettings
} from "../settings/abilities.mjs";
import { getEquipmentSlotSelectionKey, getValidSelectedEquipmentSlotKeys } from "../utils/equipment-slots.mjs";
import { isAbilityAcquisitionChangeKey } from "../utils/ability-acquisition-change-keys.mjs";
import { evaluateEffectChangeNumber, tryEvaluateEffectChangeValue } from "../utils/effect-change-values.mjs";
import {
  applyPreparedActorReverseEffectChanges,
  collectActorReverseEffectChanges,
  evaluateActorEffectChangeBaseNumber,
  getActorReverseEffectChangeValue,
  getActorSuppressedTraumaDiseaseIds,
  isActorTraumaDiseaseEffectSuppressed
} from "../utils/active-effect-changes.mjs";
import { buildActorFormulaData, evaluateActorFormula } from "../utils/actor-formulas.mjs";
import {
  getEffectiveRangeDistanceState,
  normalizeAttackDistanceMeters,
  normalizeAttackEffectiveRange
} from "../utils/attack-distance.mjs";
import { getActorItemsWithActiveHudModules } from "../utils/hud-active-items.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  ALL_SKILL_ADVANCEMENT_MULTIPLIERS_TARGET,
  getSkillAdvancementMultiplierEffectTarget,
  SIGNATURE_SKILL_ADVANCEMENT_MULTIPLIERS_TARGET
} from "../advancement/skill-multiplier-effects.mjs";
import { hasAbilityFunctionCooldown } from "./runtime-state.mjs";
import {
  abilityAuraConditionApplies,
  getAuraGeneratedEffectFlag,
  isAuraTriggerCondition,
  isAuraDistributionCondition
} from "./aura-conditions.mjs";
import { energyConsumptionConditionApplies } from "../items/energy-consumption.mjs";
import { hasEventReactionCondition } from "../events/event-reaction-schema.mjs";
import { isAbilityToggleConditionActive } from "./toggleable-conditions.mjs";
import {
  illuminationConditionApplies,
  timeOfDayConditionApplies
} from "./environment-conditions.mjs";
import { filterChangesForLimitedUses } from "./limited-uses-state.mjs";
import { isActiveUseEffectKey } from "./active-use-keys.mjs";
import { getActiveUseOperationId } from "./active-use-runtime.mjs";
import {
  EFFECT_LIFECYCLE_KINDS,
  getEffectSourceFunctionContext
} from "./effect-lifecycle.mjs";
import { isAdvancementPureValueEffectKey } from "../advancement/pure-value-keys.mjs";

const TRIGGER_CHANCE_DECISION_LIMIT = 512;
const triggerChanceDecisions = new Map();

export function getAbilityEffectChanges(actor, item, context = {}) {
  return getAbilityEffectChangesFromFunctions(actor, item?.system?.functions ?? [], {
    ...context,
    abilityItemId: item?.id ?? ""
  });
}

export function getAbilityEffectChangesFromFunctions(actor, functions = [], context = {}) {
  return getAbilityEffectProjectionFromFunctions(actor, functions, context).changes;
}

export function getAbilityEffectProjectionFromFunctions(actor, functions = [], context = {}) {
  return getAbilityEffectProjectionFromNormalizedFunctions(
    actor,
    normalizeAbilityFunctions(functions),
    context
  );
}

export function getAbilityEffectProjectionFromNormalizedFunctions(
  actor,
  normalizedFunctions = [],
  context = {}
) {
  const changes = [];
  const pureChangeIndexes = [];
  for (const entry of normalizedFunctions ?? []) {
    if (entry.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
    for (const change of getConditionalFunctionChanges(actor, entry, context)) {
      if (!change.key || change.value === "") continue;
      const index = changes.length;
      changes.push(change);
      if (entry.includeInPureValues && isAdvancementPureValueEffectKey(change.key)) {
        pureChangeIndexes.push(index);
      }
    }
  }
  return { changes, pureChangeIndexes };
}

export function getAbilityAcquisitionChanges(itemOrData) {
  return normalizeAbilityFunctions(itemOrData?.system?.functions ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.acquisitionChanges)
    .flatMap(entry => entry.changes)
    .filter(change => change.key && change.value !== "" && isAbilityAcquisitionChangeKey(change.key));
}

export function getSkillAdvancementMultiplierChanges(actor, skillSettings = []) {
  if (!actor) return { changes: [], versatileDevelopmentRules: [], signatureSkillsDisabled: false };
  const skillKeys = new Set((skillSettings ?? []).map(skill => String(skill?.key ?? "").trim()).filter(Boolean));
  const changes = [];
  const versatileDevelopmentRules = [];
  let signatureSkillsDisabled = false;
  let order = 0;
  let formulaData = null;
  const getFormulaData = () => {
    formulaData ??= buildActorFormulaData(actor, { stage: "prepared" });
    return formulaData;
  };
  const appendChange = (change, source = {}, { effect = null } = {}) => {
    const key = String(change?.key ?? "").trim();
    const target = getSkillAdvancementMultiplierEffectTarget(key);
    if (!target) return;
    if (
      target !== ALL_SKILL_ADVANCEMENT_MULTIPLIERS_TARGET
      && target !== SIGNATURE_SKILL_ADVANCEMENT_MULTIPLIERS_TARGET
      && !skillKeys.has(target)
    ) return;

    const value = effect
      ? evaluateActorEffectChangeBaseNumber(actor, { ...change, effect }, {
        fallback: Number.NaN,
        formulaData: getFormulaData
      })
      : evaluateEffectChangeNumber(actor, change?.value, {
        fallback: Number.NaN,
        formulaData: getFormulaData
      });
    if (!Number.isFinite(value)) return;
    changes.push({
      key,
      target,
      type: String(change?.type ?? "add").trim() || "add",
      value,
      priority: getSkillAdvancementChangePriority(change),
      order: order++,
      sourceName: String(source?.name ?? "").trim(),
      sourceImg: String(source?.img ?? "").trim(),
      sourceUuid: String(source?.uuid ?? "").trim()
    });
  };

  const suppressedIds = getActorSuppressedTraumaDiseaseIds(actor);
  for (const effect of actor?.allApplicableEffects?.() ?? actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    if (isActorTraumaDiseaseEffectSuppressed(actor, effect, suppressedIds)) continue;
    for (const change of effect?.system?.changes ?? []) appendChange(change, effect, { effect });
  }

  const abilityItems = actor?.itemTypes?.ability
    ?? actor?.items?.filter(item => item?.type === "ability")
    ?? [];
  for (const abilityItem of abilityItems) {
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (
        abilityFunction.type !== ABILITY_FUNCTION_TYPES.fixed
        || abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.versatileDevelopment
      ) continue;
      signatureSkillsDisabled = true;
      const settings = normalizeVersatileDevelopmentSettings(abilityFunction.fixedSettings);
      if (!(settings.developmentMultiplierBonus > 0)) continue;
      versatileDevelopmentRules.push({
        id: `${String(abilityItem.id ?? "")}:${String(abilityFunction.id ?? "")}`,
        functionId: String(abilityFunction.id ?? ""),
        minimumPureValueGapPercent: settings.minimumPureValueGapPercent,
        developmentMultiplierBonus: settings.developmentMultiplierBonus,
        sourceName: String(abilityItem.name ?? "").trim(),
        sourceImg: String(abilityItem.img ?? "").trim(),
        sourceUuid: String(abilityItem.uuid ?? "").trim()
      });
    }
  }

  changes.sort((left, right) => left.priority - right.priority || left.order - right.order);
  return { changes, versatileDevelopmentRules, signatureSkillsDisabled };
}

function getSkillAdvancementChangePriority(change = {}) {
  const configured = change?.priority;
  const numeric = Number(configured);
  if (configured !== null && configured !== undefined && configured !== "" && Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }
  const ActiveEffect = foundry.documents?.ActiveEffect?.implementation ?? globalThis.ActiveEffect;
  return toInteger(ActiveEffect?.CHANGE_TYPES?.[change?.type]?.defaultPriority);
}

export function abilityConditionsApply(actor, conditions = [], context = {}) {
  const standalone = [];
  const groups = new Map();
  for (const condition of conditions ?? []) {
    if (!condition?.type) continue;
    // These rows describe what happens after a function is actually used;
    // they are metadata and never participate in AND/OR condition truth.
    if (
      isAuraTriggerCondition(condition)
      || condition.type === ABILITY_CONDITION_TYPES.trial
    ) continue;
    if ([
      ABILITY_CONDITION_TYPES.triggerCost,
      ABILITY_CONDITION_TYPES.accumulation,
      ABILITY_CONDITION_TYPES.limitedChanges,
      ABILITY_CONDITION_TYPES.limitedEffectCopies,
      ABILITY_CONDITION_TYPES.limitedUses
    ].includes(condition.type)) continue;
    const groupId = String(condition?.groupId ?? "").trim();
    if (!groupId) {
      standalone.push(condition);
      continue;
    }
    const entries = groups.get(groupId) ?? [];
    entries.push(condition);
    groups.set(groupId, entries);
  }

  return standalone.every(condition => abilityConditionApplies(actor, condition, context))
    && Array.from(groups.values()).every(group => group.some(condition => abilityConditionApplies(actor, condition, context)));
}

export function abilityConditionApplies(actor, condition = {}, context = {}) {
  if (
    isAuraTriggerCondition(condition)
    || condition.type === ABILITY_CONDITION_TYPES.trial
  ) return true;
  if ([
    ABILITY_CONDITION_TYPES.triggerCost,
    ABILITY_CONDITION_TYPES.accumulation,
    ABILITY_CONDITION_TYPES.limitedChanges,
    ABILITY_CONDITION_TYPES.limitedEffectCopies,
    ABILITY_CONDITION_TYPES.limitedUses
  ].includes(condition.type)) return true;
  if (condition.type === ABILITY_CONDITION_TYPES.triggerChance) {
    return triggerChanceConditionApplies(actor, condition, context);
  }
  if (condition.type === ABILITY_CONDITION_TYPES.toggleable) {
    return isAbilityToggleConditionActive(
      actor,
      context?.abilityItemId,
      context?.functionId,
      condition?.id
    );
  }
  if (condition.type === ABILITY_CONDITION_TYPES.eventReaction) return false;
  if (condition.type === ABILITY_CONDITION_TYPES.itemUse) return false;
  if (condition.type === ABILITY_CONDITION_TYPES.aura) return abilityAuraConditionApplies(actor, condition, context);
  if (condition.type === ABILITY_CONDITION_TYPES.energyConsumption) return energyConsumptionConditionApplies(actor, condition, context);
  if (condition.type === ABILITY_CONDITION_TYPES.timeOfDay) return timeOfDayConditionApplies(condition, context);
  if (condition.type === ABILITY_CONDITION_TYPES.illumination) return illuminationConditionApplies(actor, condition, context);

  const targetActor = context?.targetToken?.actor
    ?? context?.targetToken?.document?.actor
    ?? context?.targetActor
    ?? null;
  if (condition.type === ABILITY_CONDITION_TYPES.targetFaction) {
    if (!targetActor) return false;
    const accepted = new Set(condition?.targetFactionNames ?? []);
    const factions = getActorFactionBelongs(targetActor);
    return accepted.size > 0 && (factions.length ? factions : [DEFAULT_FACTION_NAME]).some(faction => accepted.has(faction));
  }

  if (condition.type === ABILITY_CONDITION_TYPES.targetRace) {
    const raceId = String(condition?.targetRaceId ?? "").trim();
    return Boolean(targetActor && raceId && targetActor.system?.creature?.raceId === raceId);
  }

  if (condition.type === ABILITY_CONDITION_TYPES.targetType) {
    const typeId = String(condition?.targetTypeId ?? "").trim();
    return Boolean(targetActor && typeId && targetActor.system?.creature?.typeId === typeId);
  }

  if (condition.type === ABILITY_CONDITION_TYPES.posture) {
    const useTarget = condition?.postureSubject === ABILITY_POSTURE_SUBJECTS.target;
    const subjectActor = useTarget ? targetActor : actor;
    const subjectToken = useTarget ? context?.targetToken : context?.actorToken;
    const accepted = new Set(condition?.postureActions ?? []);
    return Boolean(subjectActor && accepted.size && accepted.has(getContextPostureAction(subjectActor, subjectToken)));
  }

  if (condition.type === ABILITY_CONDITION_TYPES.occupiedCover) {
    const accepted = new Set(condition?.coverKeys ?? []);
    return accepted.size > 0 && getActorOccupiedCoverKeys(actor).some(key => accepted.has(key));
  }

  if (condition.type === ABILITY_CONDITION_TYPES.attackDistance) {
    return attackDistanceConditionApplies(actor, condition, context);
  }

  if (condition.type === ABILITY_CONDITION_TYPES.weaponAction) {
    const accepted = new Set(condition?.weaponActionKeys ?? []);
    const contextActionKey = String(context?.weaponActionKey ?? "").trim();
    return Boolean(accepted.size && contextActionKey && accepted.has(contextActionKey));
  }

  if (condition.type === ABILITY_CONDITION_TYPES.weaponSkill) {
    const accepted = new Set(condition?.skillKeys ?? []);
    const weaponSkillKey = String(context?.weaponData?.skillKey ?? "").trim();
    return Boolean(accepted.size && weaponSkillKey && accepted.has(weaponSkillKey));
  }

  if (condition.type === ABILITY_CONDITION_TYPES.engagedSkill) {
    const accepted = new Set(condition?.skillKeys ?? []);
    const skillKey = getContextSkillKey(context);
    return Boolean(accepted.size && skillKey && accepted.has(skillKey));
  }

  if (condition.type === ABILITY_CONDITION_TYPES.weaponProficiency) {
    const accepted = new Set(condition?.proficiencyKeys ?? []);
    const weaponProficiencyKey = String(context?.weaponData?.proficiencyKey ?? "").trim();
    return Boolean(accepted.size && weaponProficiencyKey && accepted.has(weaponProficiencyKey));
  }

  if (condition.type === ABILITY_CONDITION_TYPES.cooldown) {
    const abilityItemId = String(context?.abilityItemId ?? "").trim();
    const functionId = String(context?.functionId ?? "").trim();
    const conditionId = String(condition?.id ?? "").trim();
    if (!abilityItemId || !functionId || !conditionId) return true;
    return !hasAbilityFunctionCooldown(actor, { abilityItemId, functionId, conditionId });
  }

  if (condition.type === ABILITY_CONDITION_TYPES.duration) {
    return true;
  }

  if (condition.type === ABILITY_CONDITION_TYPES.equipmentSlotOccupied) {
    const occupied = isActorEquipmentSlotOccupied(actor, condition.equipmentSlotKey);
    return condition.operator === ABILITY_EQUIPMENT_OPERATORS.empty ? !occupied : occupied;
  }

  if (condition.type === ABILITY_CONDITION_TYPES.healthPercent) {
    const threshold = Math.max(0, Math.min(100, toInteger(condition.percent ?? 50)));
    const percentages = getHealthPercentages(actor, condition);
    if (!percentages.length) return false;
    return condition.operator === "gte"
      ? percentages.every(percent => percent >= threshold)
      : percentages.some(percent => percent <= threshold);
  }

  return true;
}

export function getConditionalFunctionChanges(actor, entry = {}, context = {}) {
  const conditions = entry.conditions ?? [];
  if (hasEventReactionCondition(conditions)) return [];
  if (!conditions.length) return entry.changes ?? [];
  // A persisted limitedChanges row means the grant-time selection was bypassed.
  // Fail closed instead of passively projecting every unselected bonus.
  if (conditions.some(condition => condition?.type === ABILITY_CONDITION_TYPES.limitedChanges)) return [];
  if ((hasAbilityTargetContextCondition(conditions) || hasAbilityWeaponContextCondition(conditions)) && !context?.allowContextual) return [];
  if (abilityConditionsRequireTarget(conditions) && !(context?.targetActor ?? context?.targetToken?.actor)) return [];
  if (hasItemUseCondition(conditions)) return [];
  if (hasAuraDistributionCondition(conditions) && !context?.auraTargetApplication) return [];
  const conditionContext = { ...context, functionId: entry.id ?? "" };
  const hasTriggerChance = hasTriggerChanceCondition(conditions);
  if (hasTriggerChance && !hasTriggerChanceResolutionScope(actor, conditionContext)) return [];
  if (hasAbilityWeaponContextCondition(conditions) && hasUnresolvedWeaponContextBranch(actor, conditions, conditionContext)) return [];
  const selectedChanges = abilityConditionsApply(actor, conditions, conditionContext)
    ? entry.changes ?? []
    : entry.penalties ?? [];
  const availableChanges = filterChangesForLimitedUses(selectedChanges, conditions);
  if (!hasTriggerChance) return availableChanges;
  if (context?.chanceActiveOnly) return availableChanges.filter(change => isActiveUseEffectKey(change?.key));
  return availableChanges;
}

export function getAbilityFunctionChangesForSatisfiedAuraCondition(actor, entry = {}, condition = {}, context = {}) {
  return getSatisfiedAuraFunctionSelection(actor, entry, condition, context).changes;
}

function getSatisfiedAuraFunctionSelection(actor, entry = {}, condition = {}, context = {}, {
  requireTriggerChanceScope = false
} = {}) {
  if (!entry || entry.type !== ABILITY_FUNCTION_TYPES.effectChanges) return { branch: "", changes: [] };
  if (hasEventReactionCondition(entry.conditions)) return { branch: "", changes: [] };
  if (hasItemUseCondition(entry.conditions)) return { branch: "", changes: [] };
  const conditionContext = {
    ...context,
    functionId: entry.id ?? "",
    satisfiedAuraConditionId: condition.id,
    auraTargetApplication: true
  };
  if (requireTriggerChanceScope
    && hasTriggerChanceCondition(entry.conditions)
    && !hasTriggerChanceResolutionScope(actor, conditionContext)) {
    return { branch: "", changes: [] };
  }
  if (hasAbilityWeaponContextCondition(entry.conditions)
    && hasUnresolvedWeaponContextBranch(actor, entry.conditions, conditionContext)) {
    return { branch: "", changes: [] };
  }
  const applies = abilityConditionsApply(actor, entry.conditions ?? [], conditionContext);
  const selectedChanges = applies ? entry.changes ?? [] : entry.penalties ?? [];
  return {
    branch: applies ? "changes" : "penalties",
    changes: filterChangesForLimitedUses(selectedChanges, entry.conditions ?? [])
  };
}

function abilityConditionsRequireTarget(conditions = []) {
  const groups = new Map();
  for (const condition of conditions ?? []) {
    const groupId = String(condition?.groupId ?? "").trim();
    if (!groupId) {
      if (isTargetActorCondition(condition)) return true;
      continue;
    }
    const entries = groups.get(groupId) ?? [];
    entries.push(condition);
    groups.set(groupId, entries);
  }
  return Array.from(groups.values()).some(group => group.length > 0 && group.every(isTargetActorCondition));
}

function isTargetActorCondition(condition = {}) {
  return [
    ABILITY_CONDITION_TYPES.targetFaction,
    ABILITY_CONDITION_TYPES.targetRace,
    ABILITY_CONDITION_TYPES.targetType
  ].includes(condition?.type)
    || (condition?.type === ABILITY_CONDITION_TYPES.posture && condition?.postureSubject === ABILITY_POSTURE_SUBJECTS.target);
}

export function hasAbilityWeaponContextCondition(conditions = []) {
  return (conditions ?? []).some(isWeaponContextCondition);
}

function hasAuraDistributionCondition(conditions = []) {
  return (conditions ?? []).some(isAuraDistributionCondition);
}

function isWeaponContextCondition(condition = {}) {
  return [
    ABILITY_CONDITION_TYPES.attackDistance,
    ABILITY_CONDITION_TYPES.weaponAction,
    ABILITY_CONDITION_TYPES.weaponSkill,
    ABILITY_CONDITION_TYPES.engagedSkill,
    ABILITY_CONDITION_TYPES.weaponProficiency
  ].includes(condition?.type);
}

function isAttackDistanceConditionResolved(actor, condition = {}, context = {}) {
  if (normalizeAttackDistanceMeters(context?.attackDistanceMeters) === null) return false;
  const mode = Object.values(ABILITY_ATTACK_DISTANCE_MODES).includes(condition?.attackDistanceMode)
    ? condition.attackDistanceMode
    : ABILITY_ATTACK_DISTANCE_MODES.effective;
  return mode === ABILITY_ATTACK_DISTANCE_MODES.free || Boolean(resolveAttackEffectiveRange(actor, context));
}

function isWeaponContextConditionResolved(actor, condition = {}, context = {}) {
  if (condition?.type === ABILITY_CONDITION_TYPES.attackDistance) {
    return isAttackDistanceConditionResolved(actor, condition, context);
  }
  if (condition?.type === ABILITY_CONDITION_TYPES.weaponAction) {
    return Boolean(String(context?.weaponActionKey ?? "").trim());
  }
  if (condition?.type === ABILITY_CONDITION_TYPES.weaponSkill) {
    return Boolean(context?.weaponData && Object.hasOwn(context.weaponData, "skillKey"));
  }
  if (condition?.type === ABILITY_CONDITION_TYPES.engagedSkill) {
    return Boolean(getContextSkillKey(context));
  }
  if (condition?.type === ABILITY_CONDITION_TYPES.weaponProficiency) {
    return Boolean(context?.weaponData && Object.hasOwn(context.weaponData, "proficiencyKey"));
  }
  return true;
}

function getContextSkillKey(context = {}) {
  return String(
    context?.skillKey
    ?? context?.skill?.key
    ?? context?.check?.skill?.key
    ?? context?.weaponData?.skillKey
    ?? ""
  ).trim();
}

function hasUnresolvedWeaponContextBranch(actor, conditions = [], context = {}) {
  const groups = new Map();
  for (const condition of conditions ?? []) {
    if ([
      ABILITY_CONDITION_TYPES.triggerCost,
      ABILITY_CONDITION_TYPES.accumulation,
      ABILITY_CONDITION_TYPES.limitedEffectCopies,
      ABILITY_CONDITION_TYPES.limitedUses
    ].includes(condition?.type)) continue;
    if (!isWeaponContextCondition(condition) && !condition?.groupId) continue;
    const groupId = String(condition?.groupId ?? "").trim();
    if (!groupId) {
      if (isWeaponContextCondition(condition)
        && !isWeaponContextConditionResolved(actor, condition, context)) return true;
      continue;
    }
    const group = groups.get(groupId) ?? [];
    group.push(condition);
    groups.set(groupId, group);
  }

  for (const group of groups.values()) {
    if (!group.some(condition => isWeaponContextCondition(condition)
      && !isWeaponContextConditionResolved(actor, condition, context))) continue;
    const hasResolvedMatch = group.some(condition => {
      if (isWeaponContextCondition(condition)
        && !isWeaponContextConditionResolved(actor, condition, context)) return false;
      return abilityConditionApplies(actor, condition, context);
    });
    if (!hasResolvedMatch) return true;
  }
  return false;
}

function attackDistanceConditionApplies(actor, condition = {}, context = {}) {
  const distance = normalizeAttackDistanceMeters(context?.attackDistanceMeters);
  if (distance === null) return false;

  const mode = Object.values(ABILITY_ATTACK_DISTANCE_MODES).includes(condition?.attackDistanceMode)
    ? condition.attackDistanceMode
    : ABILITY_ATTACK_DISTANCE_MODES.effective;
  if (mode === ABILITY_ATTACK_DISTANCE_MODES.free) {
    const minimum = getOptionalNonNegativeNumber(condition?.attackDistanceMinMeters) ?? 0;
    const maximum = getOptionalNonNegativeNumber(condition?.attackDistanceMaxMeters) ?? Infinity;
    return minimum <= maximum && distance >= minimum && distance <= maximum;
  }

  const rangeState = getEffectiveRangeDistanceState({
    attackDistanceMeters: distance,
    effectiveRange: resolveAttackEffectiveRange(actor, context)
  });
  if (!rangeState.resolved) return false;
  if (mode === ABILITY_ATTACK_DISTANCE_MODES.effective) {
    return rangeState.side === "inside";
  }

  const side = Object.values(ABILITY_ATTACK_DISTANCE_SIDES).includes(condition?.attackDistanceSide)
    ? condition.attackDistanceSide
    : ABILITY_ATTACK_DISTANCE_SIDES.both;
  if (side === ABILITY_ATTACK_DISTANCE_SIDES.near) return rangeState.side === "near";
  if (side === ABILITY_ATTACK_DISTANCE_SIDES.far) return rangeState.side === "far";
  return rangeState.side === "near" || rangeState.side === "far";
}

function resolveAttackEffectiveRange(actor, context = {}) {
  const prepared = normalizeAttackEffectiveRange(context?.effectiveRange ?? context?.effectiveRangeBounds);
  if (prepared) return prepared.max > 0 ? prepared : null;
  if (context?.requirePreparedEffectiveRange === true) return null;

  const configured = context?.weaponData?.effectiveRange ?? {};
  const first = evaluateActorFormula(configured?.value, actor, {
    minimum: 0,
    context: "attack distance effective range"
  });
  const second = evaluateActorFormula(configured?.max, actor, {
    minimum: 0,
    context: "attack distance effective range max"
  });
  if (first <= 0 && second <= 0) return null;
  if (second <= 0) return { min: 0, max: first };
  return { min: Math.min(first, second), max: Math.max(first, second) };
}

function getOptionalNonNegativeNumber(value) {
  if (value === "" || value === undefined || value === null) return null;
  const numeric = Number(String(value).replace(",", "."));
  return Number.isFinite(numeric) ? Math.max(0, numeric) : null;
}

function getContextPostureAction(actor, token = null) {
  const tokenDocument = token?.document ?? token ?? actor?.token ?? null;
  const direct = String(tokenDocument?.movementAction ?? tokenDocument?._source?.movementAction ?? "").trim();
  if (direct) return direct;
  for (const effect of actor?.effects ?? []) {
    const data = effect?.getFlag?.(SYSTEM_ID, "postureMovement")
      ?? effect?.flags?.[SYSTEM_ID]?.postureMovement;
    if (data?.action) return String(data.action);
  }
  return "walk";
}

function getActorOccupiedCoverKeys(actor) {
  const forced = [];
  const automatic = [];
  for (const effect of actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    const forcedKey = String(
      effect?.getFlag?.(SYSTEM_ID, "forcedCover")?.key
      ?? effect?.flags?.[SYSTEM_ID]?.forcedCover?.key
      ?? ""
    ).trim();
    if (forcedKey) forced.push(forcedKey);

    const automaticKey = String(
      effect?.getFlag?.(SYSTEM_ID, "autoCover")?.key
      ?? effect?.flags?.[SYSTEM_ID]?.autoCover?.key
      ?? ""
    ).trim();
    if (automaticKey) automatic.push(automaticKey);
  }
  return Array.from(new Set(forced.length ? forced : automatic));
}

function isActiveFreeSettingsItem(item) {
  if (item?.type !== "gear" || !item.system?.functions?.freeSettings?.enabled) return false;
  return Boolean(item.system?.equipped)
    || ["equipment", "weapon", "constructPart"].includes(item.system?.placement?.mode);
}

/**
 * Resolve one descriptor-only aura projection against the current weapon
 * operation. The source function remains authoritative; stale projections
 * fail closed instead of falling back to their stored descriptor snapshot.
 */
export function getLateAuraContextualChanges(hostActor, effect, runtimeContext = {}) {
  return getLateAuraContextualSelection(hostActor, effect, runtimeContext)?.changes ?? [];
}

function getLateAuraContextualSelection(hostActor, effect, runtimeContext = {}) {
  if (!hostActor || !effect || effect.disabled || effect.active === false) return null;
  const auraFlag = getAuraGeneratedEffectFlag(effect);
  if (auraFlag?.lateContextual !== true) return null;

  const sourceContext = getEffectSourceFunctionContext(effect, hostActor);
  if (sourceContext.lifecycleKind !== EFFECT_LIFECYCLE_KINDS.reconciledInstance) return null;
  const functionId = String(auraFlag.functionId ?? "").trim();
  const sourceFunction = sourceContext.applicableFunctions.find(entry => (
    String(entry?.id ?? "").trim() === functionId
  ));
  const sourceItem = sourceContext.sourceItem;
  const sourceActor = sourceItem?.actor ?? sourceItem?.parent ?? null;
  if (!sourceItem || !sourceActor || !sourceFunction) return null;
  if (sourceFunction.type !== ABILITY_FUNCTION_TYPES.effectChanges) return null;
  if (!hasAbilityWeaponContextCondition(sourceFunction.conditions)) return null;

  const conditionId = String(auraFlag.conditionId ?? "").trim();
  const auraCondition = (sourceFunction.conditions ?? []).find(condition => (
    String(condition?.id ?? "").trim() === conditionId
    && isAuraDistributionCondition(condition)
  ));
  if (!auraCondition) return null;

  const sourceToken = resolveLateAuraToken(auraFlag.sourceTokenUuid);
  if (!sourceToken || !isTokenForActor(sourceToken, sourceActor)) return null;
  const runtimeHostToken = isTokenForActor(runtimeContext?.actorToken, hostActor)
    ? runtimeContext.actorToken
    : null;
  const storedHostToken = resolveLateAuraToken(auraFlag.targetTokenUuid);
  const hostToken = runtimeHostToken
    ?? (isTokenForActor(storedHostToken, hostActor) ? storedHostToken : null);
  if (!hostToken) return null;

  const conditionContext = {
    ...runtimeContext,
    actorToken: sourceToken,
    targetActor: hostActor,
    targetToken: hostToken,
    abilityItemId: String(sourceItem.id ?? ""),
    functionId: String(sourceFunction.id ?? ""),
    allowContextual: true,
    requirePreparedEffectiveRange: true
  };
  const selection = getSatisfiedAuraFunctionSelection(
    sourceActor,
    sourceFunction,
    auraCondition,
    conditionContext,
    { requireTriggerChanceScope: true }
  );
  let formulaData = null;
  const changes = selection.changes.map(change => {
    const result = tryEvaluateEffectChangeValue(sourceActor, change?.value, {
      formulaData: () => (formulaData ??= buildActorFormulaData(sourceActor, { stage: "prepared" }))
    });
    if (!result.ok) return null;
    return { ...change, value: result.value };
  }).filter(change => change?.key && Number.isFinite(Number(change.value)));

  return {
    auraFlag,
    branch: selection.branch,
    changes,
    sourceActor,
    sourceFunction,
    sourceItem
  };
}

function resolveLateAuraToken(uuid = "") {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  try {
    const document = globalThis.fromUuidSync?.(value)
      ?? globalThis.foundry?.utils?.fromUuidSync?.(value)
      ?? null;
    const token = document?.object ?? document;
    return token?.actor ? token : null;
  } catch (_error) {
    return null;
  }
}

function isTokenForActor(token = null, actor = null) {
  const tokenActor = token?.actor ?? token?.document?.actor ?? null;
  if (!tokenActor || !actor) return false;
  if (tokenActor === actor) return true;
  const tokenActorUuid = String(tokenActor.uuid ?? "").trim();
  const actorUuid = String(actor.uuid ?? "").trim();
  return Boolean(tokenActorUuid && actorUuid && tokenActorUuid === actorUuid);
}

export function getContextualAbilityEffectChanges(actor, context = {}, { targetContextOnly = false } = {}) {
  if (!actor) return [];
  const changes = [];
  let contextualOrder = 0;
  for (const item of getActorItemsWithActiveHudModules(actor)) {
    const functions = item?.type === "ability"
      ? item.system?.functions ?? []
      : isActiveFreeSettingsItem(item) ? item.system?.functions?.freeSettings?.entries ?? [] : [];
    for (const [functionIndex, entry] of normalizeAbilityFunctions(functions).entries()) {
      if (entry.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
      // applyToTargets is represented by its reconciled projection, including
      // when that projection targets the source actor itself.
      if (hasAuraDistributionCondition(entry.conditions)) continue;
      const orderStart = contextualOrder;
      contextualOrder += Math.max(1, entry.changes?.length ?? 0, entry.penalties?.length ?? 0);
      const hasTargetContext = hasAbilityTargetContextCondition(entry.conditions);
      const hasWeaponContext = hasAbilityWeaponContextCondition(entry.conditions);
      const hasTriggerChance = hasTriggerChanceCondition(entry.conditions);
      if (!hasTargetContext && !hasWeaponContext && !hasTriggerChance) continue;
      if (targetContextOnly && !hasTargetContext) continue;
      const selectedChanges = getConditionalFunctionChanges(actor, entry, {
        ...context,
        abilityItemId: item.id ?? "",
        functionId: entry.id ?? "",
        allowContextual: true,
        chanceActiveOnly: hasTriggerChance
      });
      const selectedBranch = selectedChanges === entry.penalties ? "penalties" : "changes";
      changes.push(...selectedChanges.map((change, index) => ({
        ...change,
        contextualOrder: orderStart + index,
        contextualTargetContext: hasTargetContext,
        contextualIdentity: [item.id ?? "", entry.id ?? functionIndex, selectedBranch, index].join(":"),
        contextualSourceItemId: String(item.id ?? ""),
        contextualSourceItemUuid: String(item.uuid ?? ""),
        contextualSourceName: String(item.name ?? ""),
        contextualSourceImg: String(item.img ?? ""),
        contextualSourceFunctionId: String(entry.id ?? functionIndex)
      })));
    }
  }

  for (const effect of actor.effects ?? []) {
    const selection = getLateAuraContextualSelection(actor, effect, context);
    if (!selection) continue;
    const entry = selection.sourceFunction;
    const orderStart = contextualOrder;
    contextualOrder += Math.max(1, entry.changes?.length ?? 0, entry.penalties?.length ?? 0);
    const hasTargetContext = hasAbilityTargetContextCondition(entry.conditions);
    if (targetContextOnly && !hasTargetContext) continue;
    changes.push(...selection.changes.map((change, index) => ({
      ...change,
      effect,
      contextualOrder: orderStart + index,
      contextualTargetContext: hasTargetContext,
      contextualIdentity: [
        selection.auraFlag?.key ?? effect.uuid ?? effect.id ?? "",
        entry.id ?? "",
        selection.branch,
        index
      ].join(":"),
      contextualSourceItemId: String(selection.sourceItem?.id ?? ""),
      contextualSourceItemUuid: String(selection.sourceItem?.uuid ?? ""),
      contextualSourceName: String(selection.sourceItem?.name ?? effect.name ?? ""),
      contextualSourceImg: String(selection.sourceItem?.img ?? effect.img ?? ""),
      contextualSourceFunctionId: String(entry.id ?? "")
    })));
  }
  return changes.filter(change => change?.key && change.value !== "");
}

function hasTriggerChanceCondition(conditions = []) {
  return (conditions ?? []).some(condition => condition?.type === ABILITY_CONDITION_TYPES.triggerChance);
}

function triggerChanceConditionApplies(actor, condition = {}, context = {}) {
  const scope = getTriggerChanceResolutionScope(context);
  if (!scope) return false;
  const identity = [
    scope,
    String(actor?.uuid ?? actor?.id ?? ""),
    String(context?.abilityItemId ?? ""),
    String(context?.functionId ?? ""),
    String(condition?.id ?? "")
  ].join("|");
  const cached = triggerChanceDecisions.get(identity);
  if (cached) return cached.applies;

  const chance = Math.max(0, Math.min(100, evaluateEffectChangeNumber(actor, condition?.chanceFormula, {
    fallback: 0
  })));
  const roll = getStablePercentile(identity);
  const decision = {
    chance,
    roll,
    applies: chance >= 100 || (chance > 0 && roll < chance)
  };
  triggerChanceDecisions.set(identity, decision);
  trimTriggerChanceDecisions();
  return decision.applies;
}

function hasTriggerChanceResolutionScope(_actor, context = {}) {
  return Boolean(getTriggerChanceResolutionScope(context));
}

function getTriggerChanceResolutionScope(context = {}) {
  const operation = getActiveUseOperationId(context);
  if (operation) return `operation:${operation}`;
  return "";
}

function trimTriggerChanceDecisions() {
  while (triggerChanceDecisions.size > TRIGGER_CHANCE_DECISION_LIMIT) {
    const oldest = triggerChanceDecisions.keys().next().value;
    if (oldest === undefined) break;
    triggerChanceDecisions.delete(oldest);
  }
}

function getStablePercentile(value = "") {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  return ((hash >>> 0) / 0x100000000) * 100;
}

export function getContextualAbilityChangeValue(actor, key, { baseValue = 0, alternateKeys = [], ...context } = {}) {
  const sourceValue = getSourceContextualAbilityChangeValue(actor, key, {
    ...context,
    alternateKeys,
    baseValue
  });
  return getTargetReverseAbilityChangeValue(actor, key, {
    ...context,
    alternateKeys,
    baseValue: sourceValue
  });
}

/**
 * Resolve many contextual keys with one attacker scan + one target reverse scan.
 * Foundry-style: gather modifiers once for an attack context, then read scalars.
 */
export function getContextualAbilityChangeValues(actor, specs = [], context = {}) {
  const list = normalizeContextualAbilityValueSpecs(specs);

  if (!list.length) return {};
  if (!actor) {
    return Object.fromEntries(list.map(spec => [spec.id, spec.baseValue]));
  }

  const needsFullContext = list.some(spec => !spec.targetContextOnly);
  const needsTargetOnly = list.some(spec => spec.targetContextOnly);
  const fullSourceChanges = needsFullContext ? getContextualAbilityEffectChanges(actor, context) : [];
  const targetOnlySourceChanges = needsTargetOnly
    ? getContextualAbilityEffectChanges(actor, context, { targetContextOnly: true })
    : [];

  const targetActor = context?.targetToken?.actor
    ?? context?.targetToken?.document?.actor
    ?? context?.targetActor
    ?? null;
  const canReverse = Boolean(targetActor) && !isSameInteractionActor(actor, targetActor);
  const reverseChanges = canReverse
    ? getContextualAbilityEffectChanges(targetActor, {
      ...context,
      actorToken: context?.targetToken ?? null,
      targetToken: context?.actorToken ?? null,
      targetActor: actor
    })
    : [];
  const preparedReverseChanges = canReverse
    ? collectActorReverseEffectChanges(
      targetActor,
      new Set(list.flatMap(spec => Array.from(spec.acceptedKeys))),
      { additionalChanges: reverseChanges }
    )
    : [];

  const result = {};
  for (const spec of list) {
    const acceptedKeys = spec.acceptedKeys;
    const sourcePool = spec.targetContextOnly ? targetOnlySourceChanges : fullSourceChanges;
    const prepared = prepareContextualAbilityChangesForKeys(actor, sourcePool, acceptedKeys);
    let value = applyPreparedSourceContextualAbilityChanges(spec.baseValue, prepared);
    if (canReverse) {
      value = applyPreparedActorReverseEffectChanges(
        value,
        preparedReverseChanges.filter(change => acceptedKeys.has(change.key))
      );
    }
    result[spec.id] = value;
  }
  return result;
}

/** Resolve many source-owned contextual keys with one ability scan and no target reverse changes. */
export function getSourceContextualAbilityChangeValues(actor, specs = [], context = {}) {
  const list = normalizeContextualAbilityValueSpecs(specs);
  if (!list.length) return {};
  if (!actor) return Object.fromEntries(list.map(spec => [spec.id, spec.baseValue]));

  const needsFullContext = list.some(spec => !spec.targetContextOnly);
  const needsTargetOnly = list.some(spec => spec.targetContextOnly);
  const fullSourceChanges = needsFullContext ? getContextualAbilityEffectChanges(actor, context) : [];
  const targetOnlySourceChanges = needsTargetOnly
    ? getContextualAbilityEffectChanges(actor, context, { targetContextOnly: true })
    : [];

  return Object.fromEntries(list.map(spec => {
    const sourcePool = spec.targetContextOnly ? targetOnlySourceChanges : fullSourceChanges;
    const prepared = prepareContextualAbilityChangesForKeys(actor, sourcePool, spec.acceptedKeys);
    return [spec.id, applyPreparedSourceContextualAbilityChanges(spec.baseValue, prepared)];
  }));
}

function normalizeContextualAbilityValueSpecs(specs = []) {
  return (Array.isArray(specs) ? specs : [])
    .map(spec => {
      const key = String(spec?.key ?? "").trim();
      if (!key) return null;
      const alternateKeys = Array.isArray(spec?.alternateKeys) ? spec.alternateKeys : [];
      return {
        id: String(spec?.id ?? key),
        key,
        alternateKeys,
        acceptedKeys: new Set(
          [key, ...alternateKeys].map(value => String(value ?? "").trim()).filter(Boolean)
        ),
        baseValue: Number(spec?.baseValue) || 0,
        targetContextOnly: Boolean(spec?.targetContextOnly)
      };
    })
    .filter(Boolean);
}

function prepareContextualAbilityChangesForKeys(actor, changes = [], acceptedKeys = new Set()) {
  return (changes ?? [])
    .filter(change => acceptedKeys.has(String(change?.key ?? "").trim()))
    .map((change, index) => ({
      key: String(change?.key ?? "").trim(),
      type: String(change?.type ?? "add"),
      value: evaluateEffectChangeNumber(actor, change.value, { fallback: Number.NaN }),
      priority: toInteger(change?.priority),
      order: Number.isFinite(Number(change?.contextualOrder)) ? Number(change.contextualOrder) : index,
      targetContext: Boolean(change?.contextualTargetContext),
      identity: String(change?.contextualIdentity ?? ""),
      sourceItemId: String(change?.contextualSourceItemId ?? ""),
      sourceItemUuid: String(change?.contextualSourceItemUuid ?? ""),
      sourceName: String(change?.contextualSourceName ?? ""),
      sourceImg: String(change?.contextualSourceImg ?? ""),
      sourceFunctionId: String(change?.contextualSourceFunctionId ?? "")
    }))
    .filter(change => Number.isFinite(change.value))
    .sort(comparePreparedContextualAbilityChanges);
}

export function getSourceContextualAbilityChangeValue(actor, key, {
  baseValue = 0,
  alternateKeys = [],
  targetContextOnly = false,
  ...context
} = {}) {
  return applyPreparedSourceContextualAbilityChanges(baseValue, getPreparedSourceContextualAbilityChanges(actor, key, {
    ...context,
    alternateKeys,
    targetContextOnly
  }));
}

export function getPreparedSourceContextualAbilityChanges(actor, key, {
  alternateKeys = [],
  targetContextOnly = false,
  ...context
} = {}) {
  const acceptedKeys = new Set([key, ...alternateKeys].map(value => String(value ?? "").trim()).filter(Boolean));
  return getContextualAbilityEffectChanges(actor, context, { targetContextOnly })
    .filter(change => acceptedKeys.has(String(change?.key ?? "").trim()))
    .map((change, index) => ({
      key: String(change?.key ?? "").trim(),
      type: String(change?.type ?? "add"),
      value: evaluateEffectChangeNumber(actor, change.value, { fallback: Number.NaN }),
      priority: toInteger(change?.priority),
      order: Number.isFinite(Number(change?.contextualOrder)) ? Number(change.contextualOrder) : index,
      targetContext: Boolean(change?.contextualTargetContext),
      identity: String(change?.contextualIdentity ?? ""),
      sourceItemId: String(change?.contextualSourceItemId ?? ""),
      sourceItemUuid: String(change?.contextualSourceItemUuid ?? ""),
      sourceName: String(change?.contextualSourceName ?? ""),
      sourceImg: String(change?.contextualSourceImg ?? ""),
      sourceFunctionId: String(change?.contextualSourceFunctionId ?? "")
    }))
    .filter(change => Number.isFinite(change.value))
    .sort(comparePreparedContextualAbilityChanges);
}

export function applyPreparedSourceContextualAbilityChanges(baseValue = 0, changes = []) {
  let value = Number(baseValue) || 0;
  for (const change of [...(changes ?? [])].sort(comparePreparedContextualAbilityChanges)) {
    const amount = Number(change?.value);
    if (!Number.isFinite(amount)) continue;
    if (change.type === "multiply") value *= amount;
    else if (change.type === "subtract") value -= amount;
    else if (change.type === "override") value = amount;
    else if (change.type === "upgrade") value = Math.max(value, amount);
    else if (change.type === "downgrade") value = Math.min(value, amount);
    else value += amount;
  }
  return value;
}

export function mergePreparedSourceContextualAbilityChanges(snapshotChanges = [], targetContextChanges = []) {
  return [
    ...(snapshotChanges ?? []).filter(change => !change?.targetContext),
    ...(targetContextChanges ?? [])
  ];
}

function comparePreparedContextualAbilityChanges(left = {}, right = {}) {
  return toInteger(left?.priority) - toInteger(right?.priority)
    || (Number(left?.order) || 0) - (Number(right?.order) || 0);
}

export function getTargetReverseAbilityChangeValue(actor, key, { baseValue = 0, alternateKeys = [], ...context } = {}) {
  const acceptedKeys = new Set([key, ...alternateKeys].map(value => String(value ?? "").trim()).filter(Boolean));
  const value = Number(baseValue) || 0;
  const targetActor = context?.targetToken?.actor
    ?? context?.targetToken?.document?.actor
    ?? context?.targetActor
    ?? null;
  if (!targetActor || isSameInteractionActor(actor, targetActor)) return value;
  const reverseContext = {
    ...context,
    actorToken: context?.targetToken ?? null,
    targetToken: context?.actorToken ?? null,
    targetActor: actor
  };
  const contextualReverseChanges = getContextualAbilityEffectChanges(targetActor, reverseContext);
  return getActorReverseEffectChangeValue(targetActor, Array.from(acceptedKeys), {
    baseValue: value,
    additionalChanges: contextualReverseChanges
  });
}

function isSameInteractionActor(sourceActor, targetActor) {
  if (sourceActor === targetActor) return true;
  const sourceUuid = String(sourceActor?.uuid ?? "").trim();
  const targetUuid = String(targetActor?.uuid ?? "").trim();
  return Boolean(sourceUuid && targetUuid && sourceUuid === targetUuid);
}

export function hasAbilityTargetContextCondition(conditions = []) {
  return (conditions ?? []).some(isAbilityTargetContextCondition);
}

export function isAbilityTargetContextCondition(condition = {}) {
  return [
    ABILITY_CONDITION_TYPES.targetFaction,
    ABILITY_CONDITION_TYPES.targetRace,
    ABILITY_CONDITION_TYPES.targetType
  ].includes(condition?.type)
    || (condition?.type === ABILITY_CONDITION_TYPES.posture
      && condition?.postureSubject === ABILITY_POSTURE_SUBJECTS.target);
}

function hasItemUseCondition(conditions = []) {
  return (conditions ?? []).some(condition => condition?.type === ABILITY_CONDITION_TYPES.itemUse);
}

function isActorEquipmentSlotOccupied(actor, requestedSlotKey = "") {
  const slotKey = String(requestedSlotKey ?? "").trim();
  if (!actor || !slotKey) return false;

  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const slot = (race?.equipmentSlots ?? []).find(entry => {
    const selectionKey = getEquipmentSlotSelectionKey(entry.label);
    return entry.key === slotKey || selectionKey === slotKey || String(entry.label ?? "").trim() === slotKey;
  });
  const acceptedEquipmentKeys = new Set([slotKey]);
  const acceptedSelectionKeys = new Set([slotKey]);
  if (slot) {
    acceptedEquipmentKeys.add(slot.key);
    acceptedSelectionKeys.add(getEquipmentSlotSelectionKey(slot.label));
  }
  if (!slot) return false;

  for (const item of actor.items ?? []) {
    if (item?.type === "ability") continue;
    if (item.system?.placement?.mode !== "equipment") continue;
    if (acceptedEquipmentKeys.has(String(item.system?.placement?.equipmentSlot ?? ""))) return true;
    for (const selectedKey of getValidSelectedEquipmentSlotKeys(race, item)) {
      if (acceptedSelectionKeys.has(selectedKey)) return true;
    }
  }

  return false;
}

function getHealthPercent(sourceSystem = {}) {
  const health = sourceSystem?.resources?.health;
  return getResourcePercent(health);
}

function getHealthPercentages(actor, condition = {}) {
  const target = Object.values(ABILITY_HEALTH_TARGETS).includes(condition?.healthTarget)
    ? condition.healthTarget
    : ABILITY_HEALTH_TARGETS.general;
  if (target === ABILITY_HEALTH_TARGETS.general) return [getHealthPercent(actor?.system)];

  const requestedLimbKey = String(condition?.limbKey ?? ABILITY_HEALTH_LIMB_ALL).trim() || ABILITY_HEALTH_LIMB_ALL;
  const criticalOnly = target === ABILITY_HEALTH_TARGETS.criticalLimb;
  return Object.entries(actor?.system?.limbs ?? {})
    .filter(([key, limb]) => requestedLimbKey === ABILITY_HEALTH_LIMB_ALL || key === requestedLimbKey)
    .filter(([_key, limb]) => !criticalOnly || Boolean(limb?.critical))
    .map(([_key, limb]) => getResourcePercent(limb));
}

function getResourcePercent(health = {}) {
  const max = Math.max(0, Number(health?.max) || 0);
  if (max <= 0) return 100;

  const value = Number.isFinite(Number(health?.value))
    ? Number(health.value)
    : max - Math.max(0, Number(health?.spent) || 0);
  return Math.max(0, Math.min(100, (value / max) * 100));
}
