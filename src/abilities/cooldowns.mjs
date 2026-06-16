import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  getAbilitySourceId,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { abilityConditionsApply } from "./evaluation.mjs";
import { syncActorAbilityEffects } from "./effects.mjs";
import { ALL_SKILLS_BONUS_EFFECT_KEY } from "../utils/active-effect-changes.mjs";
import {
  ABILITY_FUNCTION_COOLDOWN_FLAG_KEY,
  getAbilityFunctionCooldownEffect,
  getActionBlockEffectKey,
  isAbilityFunctionCooldownEffect
} from "./runtime-state.mjs";

const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const SKILL_BONUS_KEY_PREFIX = "system.skills.";
const SKILL_BONUS_KEY_SUFFIX = ".bonus";
const ACTION_COST_KEY_PREFIX = "system.costs.actions.";
const ACTION_PENETRATION_KEY_PREFIX = "system.penetration.actions.";
const WEAPON_ACTION_COMBAT_TRIGGER_KEYS = Object.freeze([
  "system.combat.accuracy",
  "system.combat.criticalChance",
  "system.combat.damageFlat",
  "system.combat.damagePercent",
  "system.combat.burstStability"
]);

export function registerAbilityCooldownHooks() {
  Hooks.on("fallout-maw.skillCheckResolved", outcome => {
    void applyAbilityCooldownsForSkillCheck(outcome);
  });
  Hooks.on("fallout-maw.weaponActionResolved", context => {
    void applyAbilityCooldownsForWeaponAction(context);
  });
  Hooks.on("createActiveEffect", effect => {
    if (isAbilityFunctionCooldownEffect(effect)) void syncActorAbilityEffects(effect.parent);
  });
  Hooks.on("updateActiveEffect", effect => {
    if (isAbilityFunctionCooldownEffect(effect)) void syncActorAbilityEffects(effect.parent);
  });
  Hooks.on("deleteActiveEffect", effect => {
    if (isAbilityFunctionCooldownEffect(effect)) void syncActorAbilityEffects(effect.parent);
  });
}

export async function applyAbilityCooldownsForSkillCheck(outcome = {}) {
  const actor = outcome?.actor;
  const skillKey = String(outcome?.skill?.key ?? outcome?.check?.skill?.key ?? "").trim();
  if (!actor || !skillKey) return [];

  const changeKey = `${SKILL_BONUS_KEY_PREFIX}${skillKey}${SKILL_BONUS_KEY_SUFFIX}`;
  return applyAbilityCooldownsForTriggeredKeys(actor, new Set([changeKey, ALL_SKILLS_BONUS_EFFECT_KEY]), {
    trigger: "skillCheck",
    conditionContext: getCooldownConditionContext(outcome)
  });
}

export async function applyAbilityCooldownsForWeaponAction(context = {}) {
  const { actor = null, actionKey = "" } = context;
  const normalizedActionKey = String(actionKey ?? "").trim();
  if (!actor || !normalizedActionKey || normalizedActionKey === "reload") return [];

  const weaponData = context?.weaponData && typeof context.weaponData === "object" ? context.weaponData : null;
  const skillKey = String(weaponData?.skillKey ?? "").trim();
  const proficiencyKey = String(weaponData?.proficiencyKey ?? "").trim();
  const changeKeys = new Set([
    `${ACTION_COST_KEY_PREFIX}${normalizedActionKey}`,
    `${ACTION_PENETRATION_KEY_PREFIX}${normalizedActionKey}`,
    ...WEAPON_ACTION_COMBAT_TRIGGER_KEYS
  ]);
  if (skillKey) changeKeys.add(`${SKILL_BONUS_KEY_PREFIX}${skillKey}${SKILL_BONUS_KEY_SUFFIX}`);
  if (proficiencyKey) changeKeys.add(`system.proficiencies.${proficiencyKey}.bonus`);
  return applyAbilityCooldownsForTriggeredKeys(actor, changeKeys, {
    trigger: "weaponAction",
    conditionContext: getCooldownConditionContext(context)
  });
}

async function applyAbilityCooldownsForTriggeredKeys(actor, changeKeys, { trigger = "", conditionContext = {} } = {}) {
  const entries = findTriggeredCooldownEntries(actor, changeKeys, conditionContext);
  const results = [];
  for (const entry of entries) {
    const result = await createOrRefreshAbilityFunctionCooldown(actor, entry, { trigger });
    if (result) results.push(result);
  }
  return results;
}

function findTriggeredCooldownEntries(actor, changeKeys, conditionContext = {}) {
  const entries = [];
  if (!actor || !(changeKeys instanceof Set) || !changeKeys.size) return entries;

  for (const item of actor.items ?? []) {
    if (item?.type !== "ability") continue;
    for (const abilityFunction of normalizeAbilityFunctions(item.system?.functions ?? [])) {
      if (abilityFunction.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
      const cooldownConditions = (abilityFunction.conditions ?? [])
        .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.cooldown)
        .filter(condition => getCooldownDurationSeconds(condition) > 0);
      if (!cooldownConditions.length) continue;
      if (!functionHasTriggeredChange(abilityFunction, changeKeys)) continue;
      if (!abilityConditionsApply(actor, abilityFunction.conditions, {
        ...conditionContext,
        abilityItemId: item.id,
        functionId: abilityFunction.id
      })) continue;

      for (const condition of cooldownConditions) {
        const existing = getAbilityFunctionCooldownEffect(actor, {
          abilityItemId: item.id,
          functionId: abilityFunction.id,
          conditionId: condition.id
        });
        if (!existing) entries.push({ item, abilityFunction, condition });
      }
    }
  }

  return entries;
}

function getCooldownConditionContext(context = {}) {
  const check = context?.check ?? {};
  return {
    actorToken: context?.actorToken ?? check?.actorToken ?? null,
    targetToken: context?.targetToken ?? check?.targetToken ?? null,
    targetActor: context?.targetActor ?? check?.targetActor ?? null,
    weaponData: context?.weaponData && typeof context.weaponData === "object"
      ? context.weaponData
      : check?.weaponData && typeof check.weaponData === "object" ? check.weaponData : null,
    weaponActionKey: String(context?.weaponActionKey ?? context?.actionKey ?? check?.weaponActionKey ?? "").trim()
  };
}

function functionHasTriggeredChange(abilityFunction, changeKeys) {
  return (abilityFunction.changes ?? []).some(change => {
    const key = String(change?.key ?? "").trim();
    return key && changeKeys.has(key) && String(change?.value ?? "") !== "";
  });
}

async function createOrRefreshAbilityFunctionCooldown(actor, { item, abilityFunction, condition } = {}, { trigger = "" } = {}) {
  if (!actor?.isOwner || !item || !abilityFunction || !condition) return null;

  const durationSeconds = getCooldownDurationSeconds(condition);
  if (durationSeconds <= 0) return null;

  const startTime = Number(game.time?.worldTime) || 0;
  const flagData = {
    abilityItemId: item.id,
    abilitySourceId: getAbilitySourceId(item),
    functionId: abilityFunction.id,
    conditionId: condition.id,
    trigger: String(trigger ?? ""),
    untilTime: startTime + durationSeconds
  };
  const existing = getAbilityFunctionCooldownEffect(actor, flagData);
  const effectData = buildCooldownEffectData(item, abilityFunction, condition, flagData, {
    startTime,
    durationSeconds
  });

  if (existing) {
    return existing.update({
      name: effectData.name,
      img: effectData.img,
      disabled: false,
      showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
      "duration.seconds": durationSeconds,
      "duration.startTime": startTime,
      [`flags.${SYSTEM_ID}.${ABILITY_FUNCTION_COOLDOWN_FLAG_KEY}`]: flagData
    });
  }

  const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
  return created ?? null;
}

function buildCooldownEffectData(item, abilityFunction, condition, flagData, { startTime = 0, durationSeconds = 0 } = {}) {
  return {
    type: "base",
    name: getCooldownEffectName(item, abilityFunction, condition),
    img: item.img || "icons/svg/clockwork.svg",
    origin: item.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: durationSeconds,
      startTime
    },
    system: { changes: [] },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [ABILITY_FUNCTION_COOLDOWN_FLAG_KEY]: flagData
      }
    }
  };
}

function getCooldownEffectName(item, abilityFunction, condition) {
  const label = String(condition?.label ?? "").trim();
  const functionLabel = String(abilityFunction?.name ?? "").trim();
  const suffix = label || functionLabel;
  return suffix
    ? `Перезарядка: ${item.name} (${suffix})`
    : `Перезарядка: ${item.name}`;
}

function getCooldownDurationSeconds(condition = {}) {
  return Math.max(0, toInteger(condition.durationSeconds ?? condition.duration ?? condition.seconds));
}

export function getAbilityActionBlockKey(actionKey = "") {
  return getActionBlockEffectKey(actionKey);
}
