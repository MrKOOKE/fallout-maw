import { ABILITY_ATTACKING_WEAPON_ACTION_KEYS } from "../settings/abilities.mjs";
import {
  ALL_COMBAT_ADVANTAGE_EFFECT_KEY,
  ALL_COMBAT_DISADVANTAGE_EFFECT_KEY,
  ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
  ALL_SKILLS_BONUS_EFFECT_KEY,
  ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY,
  ALL_SKILLS_CRITICAL_FAILURE_CHANCE_EFFECT_KEY,
  ALL_SKILLS_CRITICAL_SUCCESS_CHANCE_EFFECT_KEY,
  ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_FAR_RESTRICTION_DISABLED_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_NEAR_RESTRICTION_DISABLED_EFFECT_KEY,
  ATTACK_ACTION_POINT_MOVEMENT_LOSS_DISABLED_EFFECT_KEY,
  ATTACK_ACTION_POINT_MOVEMENT_LOSS_PERCENT_BONUS_EFFECT_KEY,
  ATTACK_RANGE_BONUS_EFFECT_KEY,
  CONDITION_LOSS_MULTIPLIER_EFFECT_KEY,
  CRITICAL_DAMAGE_PERCENT_EFFECT_KEY,
  EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY,
  EFFECTIVE_RANGE_FAR_PENALTY_PERCENT_EFFECT_KEY,
  EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY,
  EFFECTIVE_RANGE_NEAR_PENALTY_PERCENT_EFFECT_KEY,
  getOriginalEffectKeyFromReverse,
  INITIATIVE_ADVANTAGE_EFFECT_KEY,
  INITIATIVE_DISADVANTAGE_EFFECT_KEY,
  SKILL_CHECK_DISABLED_RESULT_EFFECT_KEYS,
  SMART_FUDGE_RESULT_EFFECT_KEYS
} from "../utils/active-effect-keys.mjs";
import { getActorPostureAction } from "../canvas/posture-state.mjs";
import { getEffectiveRangeDistanceState } from "../utils/attack-distance.mjs";
import {
  getSkillCheckActionEffectKeys,
  isSkillCheckActionEffectKey
} from "../rolls/skill-check-action-effects.mjs";
import {
  DAMAGE_BARRIER_ALL_EFFECT_KEY,
  getDamageBarrierEffectKey
} from "../combat/damage-barriers.mjs";
import {
  FIRST_AID_ACTION_POINT_COST_EFFECT_KEY,
  FIRST_AID_EFFECT_KEYS
} from "../items/first-aid-effect-keys.mjs";
import { isNeedChangeModifierEffectKey } from "../needs/need-change-effect-keys.mjs";
import { getConfiguredWeaponProficiencyKeys } from "../utils/item-functions.mjs";
import { getActiveRulesProfile } from "../settings/rules-profiles.mjs";
import { STEALTH_ILLUMINATION_PENALTY_PERCENT_EFFECT_KEY } from "../stealth/effect-keys.mjs";

const ATTACKING_WEAPON_ACTION_KEYS = new Set(ABILITY_ATTACKING_WEAPON_ACTION_KEYS);
const WEAPON_CONTEXT_SKILL_CHECK_REQUESTERS = new Set(["weaponAttack", "weaponPush"]);
const ATTACKING_SKILL_CHECK_REQUESTERS = new Set(["weaponAttack", "weaponPush", "activePush"]);
const SKILL_CHANGE_SUFFIXES = Object.freeze([
  "bonus",
  "bonusPercent",
  "advantage",
  "disadvantage",
  "criticalSuccessChance",
  "criticalFailureChance"
]);
const WEAPON_CHECK_COMBAT_KEYS = Object.freeze([
  "system.combat.accuracy",
  "system.combat.criticalChance",
  "system.combat.burstStability"
]);
const WEAPON_DAMAGE_COMBAT_KEYS = Object.freeze([
  "system.combat.damageFlat",
  "system.combat.damagePercent",
  "system.combat.finishingBlow",
  "system.combat.finishingBlowChance"
]);
const SKILL_CHECK_DISABLED_RESULT_KEYS = Object.freeze(Object.values(SKILL_CHECK_DISABLED_RESULT_EFFECT_KEYS));
const SMART_FUDGE_RESULT_KEYS = Object.freeze(Object.values(SMART_FUDGE_RESULT_EFFECT_KEYS));
const STATIC_ACTIVE_USE_KEYS = new Set([
  ...WEAPON_CHECK_COMBAT_KEYS,
  ...WEAPON_DAMAGE_COMBAT_KEYS,
  CRITICAL_DAMAGE_PERCENT_EFFECT_KEY,
  ATTACK_RANGE_BONUS_EFFECT_KEY,
  CONDITION_LOSS_MULTIPLIER_EFFECT_KEY,
  EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY,
  EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY,
  EFFECTIVE_RANGE_NEAR_PENALTY_PERCENT_EFFECT_KEY,
  EFFECTIVE_RANGE_FAR_PENALTY_PERCENT_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_NEAR_RESTRICTION_DISABLED_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_FAR_RESTRICTION_DISABLED_EFFECT_KEY,
  ATTACK_ACTION_POINT_MOVEMENT_LOSS_PERCENT_BONUS_EFFECT_KEY,
  ATTACK_ACTION_POINT_MOVEMENT_LOSS_DISABLED_EFFECT_KEY,
  ...SKILL_CHECK_DISABLED_RESULT_KEYS,
  ...SMART_FUDGE_RESULT_KEYS,
  ALL_COMBAT_ADVANTAGE_EFFECT_KEY,
  ALL_COMBAT_DISADVANTAGE_EFFECT_KEY,
  ALL_SKILLS_CRITICAL_SUCCESS_CHANCE_EFFECT_KEY,
  ALL_SKILLS_CRITICAL_FAILURE_CHANCE_EFFECT_KEY,
  "system.attributes.initiativeBonus",
  INITIATIVE_ADVANTAGE_EFFECT_KEY,
  INITIATIVE_DISADVANTAGE_EFFECT_KEY,
  "system.combat.unconsciousnessResistance",
  "system.costs.action",
  "system.costs.movement",
  "system.costs.weaponSwitch",
  "fallout-maw.dodge.loss",
  "fallout-maw.dodge.roundRecovery",
  "system.healing.incomingPercent",
  "system.healing.outgoingPercent",
  STEALTH_ILLUMINATION_PENALTY_PERCENT_EFFECT_KEY,
  ...Object.values(FIRST_AID_EFFECT_KEYS)
]);

const SKILL_CHANGE_KEY_PATTERN = /^system\.skills\.[^.]+\.(?:bonus|bonusPercent|advantage|disadvantage|criticalSuccessChance|criticalFailureChance)$/;
const PROFICIENCY_BONUS_KEY_PATTERN = /^system\.proficiencies\.[^.]+\.bonus$/;
const ACTION_COST_KEY_PATTERN = /^system\.costs\.actions\.[^.]+$/;
const ACTION_PENETRATION_KEY_PATTERN = /^system\.penetration\.actions\.[^.]+$/;
const COMBAT_ACTION_EDGE_KEY_PATTERN = /^system\.combat\.actions\.[^.]+\.(?:advantage|disadvantage)$/;
const DAMAGE_MITIGATION_KEY_PATTERN = /^system\.damage(?:Defense|Resistance)Bonuses\.[^.]+\.[^.]+$/;
const DAMAGE_BARRIER_KEY_PATTERN = /^system\.damageBarriers\.[^.]+$/;
const POSTURE_WEAPON_ACTION_COST_KEY_PATTERN = /^system\.postures\.[^.]+\.weaponActionCost$/;
const POSTURE_MOVEMENT_COST_KEY_PATTERN = /^system\.postures\.[^.]+\.movementMultiplier$/;

/** Effect keys which can participate in one committed skill check. */
export function getSkillCheckActiveUseKeys(skillKey = "", context = {}) {
  const key = String(skillKey ?? "").trim();
  if (!key) return new Set();

  const keys = new Set([
    ALL_SKILLS_BONUS_EFFECT_KEY,
    ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY,
    ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
    ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
    ALL_SKILLS_CRITICAL_SUCCESS_CHANCE_EFFECT_KEY,
    ALL_SKILLS_CRITICAL_FAILURE_CHANCE_EFFECT_KEY,
    ...SKILL_CHECK_DISABLED_RESULT_KEYS
  ]);
  for (const suffix of SKILL_CHANGE_SUFFIXES) keys.add(`system.skills.${key}.${suffix}`);

  const requester = getContextText(context, "requester");
  if (key === "stealth" && requester === "stealth") {
    keys.add(STEALTH_ILLUMINATION_PENALTY_PERCENT_EFFECT_KEY);
  }
  for (const actionEffectKey of getSkillCheckActionEffectKeys(requester)) keys.add(actionEffectKey);
  if (requester === "weaponAttack") {
    for (const smartFudgeKey of SMART_FUDGE_RESULT_KEYS) keys.add(smartFudgeKey);
  }
  if (!ATTACKING_SKILL_CHECK_REQUESTERS.has(requester)) return keys;
  const actionKey = getContextText(context, "weaponActionKey", "actionKey");
  if (!ATTACKING_WEAPON_ACTION_KEYS.has(actionKey)) return keys;
  keys.add(ALL_COMBAT_ADVANTAGE_EFFECT_KEY);
  keys.add(ALL_COMBAT_DISADVANTAGE_EFFECT_KEY);
  keys.add(`system.combat.actions.${actionKey}.advantage`);
  keys.add(`system.combat.actions.${actionKey}.disadvantage`);
  return keys;
}

/** Whether a committed skill check carries a real weapon action context. */
export function isWeaponContextSkillCheckRequester(requester = "") {
  return WEAPON_CONTEXT_SKILL_CHECK_REQUESTERS.has(String(requester ?? "").trim());
}

/** Effect keys which can participate in one committed weapon action. */
export function getWeaponActionActiveUseKeys(context = {}) {
  const actionKey = getContextText(context, "actionKey", "weaponActionKey");
  if (!actionKey) return new Set();
  const stages = getContextObject(context, "activeUseStages");
  const staged = Boolean(stages);
  const includeAction = !staged || stages.action === true;
  const includeCheck = !staged || stages.check === true;
  const includeDamage = !staged || stages.damage === true;
  const weaponData = getContextObject(context, "weaponData");

  const keys = new Set();
  if (includeAction) {
    keys.add("system.costs.action");
    keys.add(`system.costs.actions.${actionKey}`);
    if (ATTACKING_WEAPON_ACTION_KEYS.has(actionKey)) {
      keys.add(ATTACK_RANGE_BONUS_EFFECT_KEY);
      const hasConditionCost = (weaponData?.resourceCosts ?? []).some(cost => (
        String(cost?.type ?? "").trim() === "condition"
        && Number(cost?.amount) > 0
      ));
      if (hasConditionCost) keys.add(CONDITION_LOSS_MULTIPLIER_EFFECT_KEY);
    }
    const actor = context?.actor ?? context?.actorToken?.actor ?? context?.token?.actor ?? null;
    const postureAction = String(context?.postureAction ?? getActorPostureAction(actor) ?? "").trim();
    if (postureAction) keys.add(`system.postures.${postureAction}.weaponActionCost`);
  }
  if (includeCheck) {
    for (const key of WEAPON_CHECK_COMBAT_KEYS) {
      if (key === "system.combat.burstStability" && actionKey !== "burst") continue;
      keys.add(key);
    }
    const rangePenaltyKey = getEffectiveRangePenaltyActiveUseKey(context);
    if (rangePenaltyKey) keys.add(rangePenaltyKey);
    for (const rangeBoundaryKey of getEffectiveRangeBoundaryActiveUseKeys(context)) keys.add(rangeBoundaryKey);
    if (usesAimedRangeLimits(context, actionKey)) {
      keys.add(AIMED_EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY);
      keys.add(AIMED_EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY);
      keys.add(AIMED_EFFECTIVE_RANGE_NEAR_RESTRICTION_DISABLED_EFFECT_KEY);
      keys.add(AIMED_EFFECTIVE_RANGE_FAR_RESTRICTION_DISABLED_EFFECT_KEY);
    }
  }
  if (includeDamage) {
    keys.add(`system.penetration.actions.${actionKey}`);
    keys.add("system.penetration.actions.all");
    for (const key of WEAPON_DAMAGE_COMBAT_KEYS) keys.add(key);
    if (isCriticalSuccessContext(context)) keys.add(CRITICAL_DAMAGE_PERCENT_EFFECT_KEY);
  }
  const skillKey = String(weaponData?.skillKey ?? "").trim();
  const proficiencyKeys = includeCheck && getActiveRulesProfile().weaponProficienciesEnabled !== false
    ? getConfiguredWeaponProficiencyKeys(weaponData)
    : [];
  if (includeCheck && skillKey) {
    for (const skillUseKey of getSkillCheckActiveUseKeys(skillKey, {
      ...context,
      requester: getContextText(context, "requester") || "weaponAttack",
      weaponActionKey: actionKey
    })) keys.add(skillUseKey);
  }
  if (includeCheck) {
    for (const proficiencyKey of proficiencyKeys) {
      keys.add(`system.proficiencies.${proficiencyKey}.bonus`);
    }
  }

  if (includeCheck && ATTACKING_WEAPON_ACTION_KEYS.has(actionKey)) {
    keys.add(ALL_COMBAT_ADVANTAGE_EFFECT_KEY);
    keys.add(ALL_COMBAT_DISADVANTAGE_EFFECT_KEY);
    keys.add(`system.combat.actions.${actionKey}.advantage`);
    keys.add(`system.combat.actions.${actionKey}.disadvantage`);
  }
  return keys;
}

function isCriticalSuccessContext(context = {}) {
  if (context?.criticalSuccess === true || context?.criticalDamageUsed === true) return true;
  const resultKey = [
    context?.resultKey,
    context?.result?.key,
    context?.outcome?.result?.key,
    context?.check?.result?.key
  ].map(value => String(value ?? "").trim()).find(Boolean);
  return resultKey === "criticalSuccess";
}

/** Effect keys read while resolving one incoming damage application. */
export function getDamageResolutionActiveUseKeys({
  actor = null,
  limbKey = "",
  damageTypeKey = "",
  includeMitigation = true,
  includeBarriers = true
} = {}) {
  const limb = String(limbKey ?? "").trim()
    || Object.keys(actor?.system?.limbs ?? {}).find(key => key && key !== "all")
    || "";
  const damageType = String(damageTypeKey ?? "").trim();
  const keys = new Set();
  if (includeBarriers) {
    keys.add(DAMAGE_BARRIER_ALL_EFFECT_KEY);
    if (damageType) keys.add(getDamageBarrierEffectKey(damageType));
  }
  if (includeMitigation && limb && damageType) {
    for (const root of ["damageDefenseBonuses", "damageResistanceBonuses"]) {
      keys.add(`system.${root}.all.all`);
      keys.add(`system.${root}.all.${damageType}`);
      keys.add(`system.${root}.${limb}.all`);
      keys.add(`system.${root}.${limb}.${damageType}`);
    }
  }
  return keys;
}

/** Effect keys read while resolving one healing application. */
export function getHealingResolutionActiveUseKeys({ direction = "incoming" } = {}) {
  return new Set([
    direction === "outgoing"
      ? "system.healing.outgoingPercent"
      : "system.healing.incomingPercent"
  ]);
}

/** Effect keys read while resolving one first-aid application. */
export function getFirstAidResolutionActiveUseKeys({
  direction = "incoming",
  includeEffectiveness = true,
  includeDuration = true,
  includeWithdrawalResistance = true
} = {}) {
  if (direction === "outgoing") {
    const keys = new Set([
      "system.costs.action",
      FIRST_AID_ACTION_POINT_COST_EFFECT_KEY
    ]);
    if (includeEffectiveness) keys.add(FIRST_AID_EFFECT_KEYS.outgoingEffectivenessPercent);
    return keys;
  }
  const keys = new Set();
  if (includeEffectiveness) keys.add(FIRST_AID_EFFECT_KEYS.incomingEffectivenessPercent);
  if (includeDuration) keys.add(FIRST_AID_EFFECT_KEYS.durationPercent);
  if (includeWithdrawalResistance) keys.add(FIRST_AID_EFFECT_KEYS.withdrawalResistancePercent);
  return keys;
}

/** Effect keys read by one evaluated initiative roll. */
export function getInitiativeActiveUseKeys({ formula = "" } = {}) {
  const source = String(formula ?? "");
  const keys = new Set();
  if (!source || /\b1d20\b/i.test(source)) {
    keys.add(INITIATIVE_ADVANTAGE_EFFECT_KEY);
    keys.add(INITIATIVE_DISADVANTAGE_EFFECT_KEY);
  }
  if (!source || /@(?:system\.)?attributes\.initiative(?:Bonus)?\b/.test(source)) {
    keys.add("system.attributes.initiativeBonus");
  }
  return keys;
}

/** Effect key read while calculating one final limb-shock difficulty. */
export function getUnconsciousnessResistanceActiveUseKeys() {
  return new Set(["system.combat.unconsciousnessResistance"]);
}

/** Whether a key belongs to a value with a discrete runtime use. */
export function isActiveUseEffectKey(key = "") {
  const path = String(key ?? "").trim();
  if (!path) return false;
  const sourcePath = getOriginalEffectKeyFromReverse(path) || path;
  return STATIC_ACTIVE_USE_KEYS.has(sourcePath)
    || isNeedChangeModifierEffectKey(sourcePath)
    || SKILL_CHANGE_KEY_PATTERN.test(sourcePath)
    || isSkillCheckActionEffectKey(sourcePath)
    || (PROFICIENCY_BONUS_KEY_PATTERN.test(sourcePath)
      && getActiveRulesProfile().weaponProficienciesEnabled !== false)
    || ACTION_COST_KEY_PATTERN.test(sourcePath)
    || ACTION_PENETRATION_KEY_PATTERN.test(sourcePath)
    || COMBAT_ACTION_EDGE_KEY_PATTERN.test(sourcePath)
    || DAMAGE_MITIGATION_KEY_PATTERN.test(sourcePath)
    || DAMAGE_BARRIER_KEY_PATTERN.test(sourcePath)
    || POSTURE_WEAPON_ACTION_COST_KEY_PATTERN.test(sourcePath)
    || POSTURE_MOVEMENT_COST_KEY_PATTERN.test(sourcePath);
}

function getContextText(context = {}, ...keys) {
  const check = context?.check && typeof context.check === "object" ? context.check : null;
  for (const key of keys) {
    const value = String(context?.[key] ?? check?.[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function getContextObject(context = {}, key = "") {
  const direct = context?.[key];
  if (direct && typeof direct === "object") return direct;
  const nested = context?.check?.[key];
  return nested && typeof nested === "object" ? nested : null;
}

function getEffectiveRangePenaltyActiveUseKey(context = {}) {
  const check = context?.check && typeof context.check === "object" ? context.check : {};
  const state = getEffectiveRangeDistanceState({
    attackDistanceMeters: context?.attackDistanceMeters ?? check.attackDistanceMeters,
    effectiveRange: context?.effectiveRange ?? check.effectiveRange
  });
  if (!state.basePenalty) return "";
  if (state.side === "near") return EFFECTIVE_RANGE_NEAR_PENALTY_PERCENT_EFFECT_KEY;
  if (state.side === "far") return EFFECTIVE_RANGE_FAR_PENALTY_PERCENT_EFFECT_KEY;
  return "";
}

function getEffectiveRangeBoundaryActiveUseKeys(context = {}) {
  const check = context?.check && typeof context.check === "object" ? context.check : {};
  const state = getEffectiveRangeDistanceState({
    attackDistanceMeters: context?.attackDistanceMeters ?? check.attackDistanceMeters,
    effectiveRange: context?.effectiveRange ?? check.effectiveRange
  });
  if (!state.resolved) return [];
  if (state.side === "near") return [EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY];
  if (state.side === "far") return [EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY];
  if (state.side === "inside") {
    return [
      EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY,
      EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY
    ];
  }
  return [];
}

function usesAimedRangeLimits(context = {}, actionKey = "") {
  if (actionKey === "aimedMeleeAttack" || actionKey === "meleeAttack") return false;
  if (actionKey === "aimedShot" || context?.aimed === true || context?.targeting?.aimed === true) return true;
  const attackModifier = getContextObject(context, "attackModifier");
  return attackModifier?.requiresLimbSelection === true;
}
