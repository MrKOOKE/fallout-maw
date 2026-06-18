import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getCreatureOptions, getCurrencySettings, getSkillSettings } from "../settings/accessors.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  createAbilityFunction,
  getAbilitySourceId,
  normalizeAbilityFunctions,
  normalizeAllOrNothingSettings,
  normalizeAtRandomSettings,
  normalizeCounterAttackSettings,
  normalizeCurseAndBlessingSettings,
  normalizeDeusExMachinaSettings,
  normalizeDefensiveTacticsSettings,
  normalizeDisarmSettings,
  normalizeDoubleAttackSettings,
  normalizeFourLeafCloverSettings,
  normalizeFullForceSettings,
  normalizeLastChanceSettings,
  normalizeLuckyCoinSettings,
  normalizeLungeSettings,
  normalizeReaperSettings,
  normalizeRageSettings,
  normalizeWhirlwindSettings,
  normalizeWhereAreYouGoingSettings
} from "../settings/abilities.mjs";
import {
  ATTACKING_WEAPON_ACTION_KEYS,
  getActionBlockEffectKey
} from "./runtime-state.mjs";
import {
  DAMAGE_APPLIED_HOOK,
  applyDestroyedLimbConsequences,
  isCriticalLimb,
  isLimbDestroyed,
  registerLethalDamagePreventionHandler,
  restoreDestroyedLimb,
  setLimbMissingState
} from "../combat/damage-hub.mjs";
import {
  getMissingWeaponResourceCost,
  hasWeaponAction,
  hasRequiredWeaponResources,
  isWeaponAttackModeEnabled,
  executeWeaponAttackAgainstToken,
  startWeaponAttack,
  WEAPON_ACTION_MODIFIER_REQUEST_HOOK,
  WEAPON_ATTACK_DAMAGE_RESOLVED_HOOK,
  WEAPON_ATTACK_DUPLICATE_REQUEST_HOOK,
  WEAPON_ATTACK_RESOLVED_HOOK,
  requestWeaponAttackCompletion
} from "../combat/weapon-attack-controller.mjs";
import { createLungeAttackModifier, createWhirlwindAttackModifier } from "../combat/weapon-attack-modifiers.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
  ALL_SKILLS_BONUS_EFFECT_KEY,
  ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
  ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
  ONE_TIME_SKILL_MODIFIER_EFFECT_KEY,
  SMART_FUDGE_RESULT_EFFECT_KEYS,
  evaluateActorEffectChangeNumber
} from "../utils/active-effect-changes.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import {
  ABILITY_FREE_MOVEMENT_OPTION,
  ACTION_RESOURCE_KEY,
  hasActorCombatMovementInCurrentTurn
} from "../combat/movement-resources.mjs";
import {
  DODGE_LOSS_MODIFIER_EFFECT_KEY,
  DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY
} from "../combat/dodge-effect-keys.mjs";
import {
  registerActorTurnEndHandler,
  registerActorTurnStartPreparedHandler
} from "../combat/turn-events.mjs";
import {
  ONE_TIME_SKILL_MODIFIER_FLAG_KEY,
  getPendingOneTimeSkillModifierEffects
} from "../rolls/one-time-skill-modifiers.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { REACTION_EVENT_KEYS, REACTION_RESULT, isReactionSystemLocked, registerReactionProvider, requestReactionEvent } from "../combat/reaction-hub.mjs";
import { canSpendCombatActionPoints, spendCombatActionPoints } from "../combat/reaction-resources.mjs";
import { areTokensAdjacent, areTokensAdjacentAt } from "../combat/active-actions.mjs";
import {
  getMovementRouteSamples,
  getMovementSegmentSamples,
  registerMovementInterruptionProvider
} from "../canvas/movement-interruptions.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorFactionBelongs,
  getRelationTo
} from "../settings/factions.mjs";
import { createThrownItemTile } from "../canvas/thrown-items.mjs";
import { prepareInventoryContext, normalizeImagePath } from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement
} from "../utils/inventory-containers.mjs";
import { transferItemBetweenActors } from "../apps/search-inventory.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "../utils/item-functions.mjs";
import { isNaturalRaceWeapon } from "../races/natural-items.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
export const ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY = "abilityFixedFunctionState";
const DEUS_EX_MACHINA_INSIGHT_EFFECT_FLAG_KEY = "deusExMachinaInsight";
const CURSE_AND_BLESSING_EFFECT_FLAG_KEY = "curseAndBlessing";
const ABILITY_OVERLOAD_EFFECT_FLAG_KEY = "abilityOverload";
const ALL_OR_NOTHING_EFFECT_FLAG_KEY = "allOrNothing";
const AT_RANDOM_ACTION_BLOCK_EFFECT_FLAG_KEY = "atRandomActionBlock";
const LUCKY_COIN_EFFECT_SOURCE = "luckyCoin";
const DEFENSIVE_TACTICS_EFFECT_FLAG_KEY = "defensiveTactics";
const RAGE_EFFECT_FLAG_KEY = "rage";
const DISARM_REACTION_PROVIDER_ID = "disarm";
const COUNTER_ATTACK_REACTION_PROVIDER_ID = "counterAttack";
const WHERE_ARE_YOU_GOING_REACTION_PROVIDER_ID = "whereAreYouGoing";
const WHERE_ARE_YOU_GOING_MOVEMENT_PROVIDER_ID = "whereAreYouGoingMovement";
const WHERE_ARE_YOU_GOING_WEAPON_QUERY_NAME = "falloutMawWhereAreYouGoingWeapon";
const WHERE_ARE_YOU_GOING_RESUME_OPTION = "falloutMawWhereAreYouGoingResume";
const DISARM_QUERY_NAME = "falloutMawDisarm";
const DISARM_SOCKET_TIMEOUT_MS = 60000;
const FIXED_ABILITY_SOCKET = `system.${SYSTEM_ID}`;
const FIXED_ABILITY_SOCKET_SCOPE = "fallout-maw.fixedAbilityFunctions";
const ENERGY_RESOURCE_KEY = "power";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const STATUS_EFFECTS = Object.freeze({
  dead: "dead"
});
const pendingFixedAbilitySocketRequests = new Map();

const FIXED_ABILITY_FUNCTIONS = Object.freeze([
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.deusExMachina,
    label: "Бог из машины",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.deusExMachina
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing,
    label: "Порча и благословение",
    active: true,
    toggleable: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.allOrNothing,
    label: "Все или ничего",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.allOrNothing
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.reaper,
    label: "Жнец",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.reaper
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.fourLeafClover,
    label: "Клевер-четырёхлистник",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.fourLeafClover
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.atRandom,
    label: "На обум",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.atRandom
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.lastChance,
    label: "Последний шанс",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.lastChance
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.luckyCoin,
    label: "Счастливая монетка",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.luckyCoin
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.disarm,
    label: "Обезоруживание",
    active: true,
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.disarm
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.defensiveTactics,
    label: "Оборонительная тактика",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.defensiveTactics
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.rage,
    label: "Ярость",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.rage
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.whirlwind,
    label: "Вихрь",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.whirlwind
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.lunge,
    label: "Выпад",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.lunge
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.doubleAttack,
    label: "Двоечка",
    active: true,
    toggleable: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.doubleAttack
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.counterAttack,
    label: "Контр атака",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.counterAttack
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing,
    label: "Ты куда собрался?",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.fullForce,
    label: "Со всей мощи",
    active: true,
    toggleable: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.fullForce
    })
  })
]);

export function registerFixedAbilityFunctionHooks() {
  registerDisarmReactionProvider();
  registerCounterAttackReactionProvider();
  registerWhereAreYouGoingReactionProvider();
  registerWhereAreYouGoingMovementProvider();
  registerActorTurnEndHandler(context => applyDefensiveTacticsAtTurnEnd(context));
  registerActorTurnStartPreparedHandler(context => deleteDefensiveTacticsEffects(context?.actor));
  registerLethalDamagePreventionHandler(context => processLastChanceLethalDamage(context));
  Hooks.on(DAMAGE_APPLIED_HOOK, context => {
    void advanceDeusExMachinaProgressFromDamage(context?.results ?? []);
  });
  Hooks.on(WEAPON_ATTACK_DAMAGE_RESOLVED_HOOK, context => {
    void requestCurseAndBlessingAttackResolution(context);
  });
  Hooks.on(WEAPON_ATTACK_RESOLVED_HOOK, context => {
    void consumeAllOrNothingResultEffects(context);
    void processReaperAttackResolution(context);
    void requestCounterAttackReaction(context);
  });
  Hooks.on(WEAPON_ATTACK_DUPLICATE_REQUEST_HOOK, context => {
    requestDoubleAttackDuplicate(context);
  });
  Hooks.on(WEAPON_ACTION_MODIFIER_REQUEST_HOOK, context => {
    requestFullForceWeaponActionModifiers(context);
  });
  Hooks.on("fallout-maw.weaponActionResolved", context => {
    void processAtRandomAttackResolution(context);
  });
  Hooks.on("fallout-maw.modifySkillCheck", check => {
    applyFourLeafCloverCriticalBonus(check);
  });
  Hooks.on("fallout-maw.skillCheckResolved", outcome => {
    void updateFourLeafCloverCharges(outcome);
  });
}

export function registerFixedAbilityFunctionSocket() {
  game.socket.on(FIXED_ABILITY_SOCKET, handleFixedAbilitySocketMessage);
}

export function getFixedAbilityFunctionDefinitions() {
  return [...FIXED_ABILITY_FUNCTIONS].sort((left, right) => left.label.localeCompare(right.label, game.i18n.lang));
}

export function getFixedAbilityFunctionDefinition(fixedKey = "") {
  const key = String(fixedKey ?? "").trim();
  return FIXED_ABILITY_FUNCTIONS.find(entry => entry.key === key) ?? null;
}

export function getFixedAbilityFunctionChoices() {
  return [
    { value: "", label: "Выберите фиксированную функцию", disabled: true, selected: true },
    ...getFixedAbilityFunctionDefinitions().map(entry => ({
      value: entry.key,
      label: entry.label
    }))
  ];
}

export function createFixedAbilityFunction(fixedKey = "") {
  const definition = getFixedAbilityFunctionDefinition(fixedKey);
  return definition?.create?.() ?? null;
}

export function getFixedAbilityFunctionLabel(fixedKey = "") {
  return getFixedAbilityFunctionDefinition(fixedKey)?.label ?? String(fixedKey ?? "");
}

export function isFixedAbilityFunctionActive(abilityFunction = {}) {
  if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.fixed) return false;
  return Boolean(getFixedAbilityFunctionDefinition(abilityFunction.fixedKey)?.active);
}

export function isFixedAbilityFunctionToggleable(abilityFunction = {}) {
  if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.fixed) return false;
  return Boolean(getFixedAbilityFunctionDefinition(abilityFunction.fixedKey)?.toggleable);
}

export function getFixedAbilityToggleState(item) {
  if (item?.type !== "ability") return { toggleable: false, active: false };
  const state = getFixedAbilityState(item);
  const functions = normalizeAbilityFunctions(item.system?.functions ?? []).filter(isFixedAbilityFunctionToggleable);
  return {
    toggleable: functions.length > 0,
    active: functions.some(entry => Boolean(state[getFixedFunctionStateKey(entry)]?.active))
  };
}

export function hasActiveFixedAbilityFunction(item) {
  if (item?.type !== "ability") return false;
  return normalizeAbilityFunctions(item.system?.functions ?? []).some(isFixedAbilityFunctionActive);
}

export function getFixedAbilityFunctionProgressEntries(abilityItem) {
  if (abilityItem?.type !== "ability") return [];
  const state = getFixedAbilityState(abilityItem);
  return normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.fixed)
    .map(entry => {
      if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fourLeafClover) {
        const settings = normalizeFourLeafCloverSettings(entry.fixedSettings);
        return {
          key: getFixedFunctionStateKey(entry),
          label: "Заряд",
          value: String(settings.currentCharges)
        };
      }
      if (entry.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.deusExMachina) return null;
      const settings = normalizeDeusExMachinaSettings(entry.fixedSettings);
      const stateKey = getFixedFunctionStateKey(entry);
      return {
        key: stateKey,
        label: "Урон",
        current: Math.max(0, Math.min(settings.damageRequired, toInteger(state[stateKey]?.damage))),
        required: settings.damageRequired
      };
    })
    .filter(Boolean);
}

export async function useFixedAbilityFunctionItem({ actor = null, item = null, application = null } = {}) {
  if (isReactionSystemLocked()) {
    ui.notifications.warn("Ожидание реакций: способность временно заблокирована.");
    return false;
  }
  if (!actor?.isOwner || item?.type !== "ability") return false;
  const abilityFunction = normalizeAbilityFunctions(item.system?.functions ?? [])
    .find(entry => isFixedAbilityFunctionActive(entry));
  if (!abilityFunction) return false;

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.allOrNothing) {
    const used = await useAllOrNothing(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.luckyCoin) {
    const used = await useLuckyCoin(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm) {
    const used = await useDisarm(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.rage) {
    const used = await useRage(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.whirlwind) {
    const used = await useWhirlwind(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lunge) {
    const used = await useLunge(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.deusExMachina) {
    const used = await useDeusExMachina(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing) {
    await toggleCurseAndBlessing(actor, item, abilityFunction);
    await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.doubleAttack) {
    await toggleDoubleAttack(actor, item, abilityFunction);
    await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullForce) {
    await toggleFullForce(actor, item, abilityFunction);
    await application?.render?.({ force: true });
    return true;
  }

  ui.notifications.warn("Фиксированная функция пока не имеет обработчика применения.");
  return true;
}

async function useAllOrNothing(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeAllOrNothingSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (hasPendingAllOrNothingResultEffect(actor, abilityItem, abilityFunction)) {
    ui.notifications.warn(`${abilityName}: результат первой активации еще не потрачен.`);
    return false;
  }
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  if (!(await spendEnergy(actor, energyCost))) return false;
  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.overloadEnergyCost,
    durationSeconds: settings.overloadDurationSeconds
  });
  await applyAllOrNothingResultEffect(actor, abilityItem, abilityFunction, settings);
  await createAbilityChatMessage(actor, abilityItem, "Способность успешно применена.");
  return true;
}

async function useLuckyCoin(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeLuckyCoinSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (hasPendingLuckyCoinEffect(actor)) {
    ui.notifications.warn(`${abilityName}: предыдущий эффект ещё не потрачен.`);
    return false;
  }
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }

  const skill = await promptLuckyCoinSkill(actor, abilityItem);
  if (!skill) return false;
  if (hasPendingLuckyCoinEffect(actor)) {
    ui.notifications.warn(`${abilityName}: предыдущий эффект ещё не потрачен.`);
    return false;
  }
  if (!(await spendEnergy(actor, energyCost))) return false;

  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.overloadEnergyCost,
    durationSeconds: settings.overloadDurationSeconds
  });

  const chance = Math.min(100, Math.max(0, evaluateActorFormula(settings.chanceFormula, actor, {
    fallback: 0,
    minimum: 0,
    context: abilityName
  })));
  const lucky = (Math.floor(Math.random() * 100) + 1) <= chance;
  const magnitude = Math.max(0, toInteger(evaluateActorFormula(
    lucky ? settings.successBonusFormula : settings.failurePenaltyFormula,
    actor,
    {
      fallback: 0,
      minimum: 0,
      context: `${abilityName}: ${lucky ? "удача" : "неудача"}`
    }
  )));
  const modifier = lucky ? magnitude : -magnitude;

  await createLuckyCoinEffect(actor, abilityItem, abilityFunction, skill, modifier);
  await createAbilityChatMessage(
    actor,
    abilityItem,
    `${lucky ? "Удача улыбнулась вам." : "Удача отвернулась от вас."} ${skill.label}: ${modifier >= 0 ? "+" : ""}${modifier} к следующей проверке.`
  );
  return true;
}

async function useRage(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeRageSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (hasActiveRageEffect(actor, abilityItem, abilityFunction)) {
    ui.notifications.warn(`${abilityName}: эффект уже активен.`);
    return false;
  }
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  if (!(await spendEnergy(actor, energyCost))) return false;
  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.overloadEnergyCost,
    durationSeconds: settings.overloadDurationSeconds
  });
  await applyRageEffect(actor, abilityItem, abilityFunction, settings);
  await createAbilityChatMessage(actor, abilityItem, `Эффект активен на ${formatDuration(settings.durationSeconds)}.`);
  return true;
}

async function useWhirlwind(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeWhirlwindSettings(abilityFunction.fixedSettings);
  const token = getActorSceneToken(actor);
  if (!token) {
    ui.notifications.warn(`${abilityName}: выберите токен актера на сцене.`);
    return false;
  }

  const candidate = getWhirlwindWeaponCandidate(actor);
  if (!candidate) {
    ui.notifications.warn(`${abilityName}: нет оружия в оружейном наборе с неприцельной атакой и рубящим ударом.`);
    return false;
  }

  await actor.setFlag(SYSTEM_ID, "selectedHudWeaponSetKey", candidate.weaponSet);
  await actor.setFlag(SYSTEM_ID, "selectedHudWeaponItemId", candidate.weapon.id);

  const controller = startWeaponAttack({
    token,
    weapon: candidate.weapon,
    actionKey: "meleeAttack",
    weaponFunctionId: candidate.weaponFunctionId,
    attackModifier: createWhirlwindAttackModifier({
      label: abilityName,
      accuracyModifier: settings.accuracyModifier,
      onBeforeAttack: async () => {
        const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
        if (!hasEnergy(actor, energyCost)) {
          ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
          return false;
        }
        if (!(await spendEnergy(actor, energyCost))) return false;
        await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
          name: getAbilityOverloadName(abilityItem),
          energyCost: settings.overloadEnergyCost,
          durationSeconds: settings.overloadDurationSeconds
        });
        await createAbilityChatMessage(actor, abilityItem, "Атака началась.");
        return true;
      }
    })
  });

  if (!controller) {
    ui.notifications.warn(`${abilityName}: не удалось начать атаку выбранным оружием.`);
    return false;
  }
  return true;
}

function getWhirlwindWeaponCandidate(actor) {
  const candidates = getWhirlwindWeaponCandidates(actor);
  const selectedId = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponItemId") ?? "");
  const selectedSet = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponSetKey") ?? "");
  return candidates.find(candidate => candidate.weapon.id === selectedId)
    ?? candidates.find(candidate => candidate.weaponSet && candidate.weaponSet === selectedSet)
    ?? candidates.at(0)
    ?? null;
}

function getWhirlwindWeaponCandidates(actor) {
  const rows = [];
  for (const weapon of actor?.items?.contents ?? []) {
    const placement = weapon.system?.placement ?? {};
    if (weapon.type !== "gear" || String(placement.mode ?? "") !== "weapon") continue;
    const weaponSet = String(placement.weaponSet ?? "");
    if (!weaponSet) continue;
    if (!hasItemFunction(weapon, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })) continue;
    for (const weaponFunctionId of getWhirlwindWeaponFunctionIds(weapon)) {
      if (!hasWeaponAction(weapon, "meleeAttack", weaponFunctionId)) continue;
      if (!isWeaponAttackModeEnabled(weapon, "meleeAttack", "swing", weaponFunctionId)) continue;
      rows.push({
        weapon,
        weaponSet,
        weaponFunctionId
      });
    }
  }
  return rows;
}

function getWhirlwindWeaponFunctionIds(weapon) {
  const ids = [ITEM_FUNCTIONS.weapon];
  const additional = weapon?.system?.functions?.additionalWeapons;
  const entries = Array.isArray(additional)
    ? additional
    : additional && typeof additional === "object" ? Object.values(additional) : [];
  for (const entry of entries) {
    const id = String(entry?.id ?? "").trim();
    if (id) ids.push(id);
  }
  return Array.from(new Set(ids));
}

async function useLunge(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeLungeSettings(abilityFunction.fixedSettings);
  const token = getActorSceneToken(actor);
  if (!token) {
    ui.notifications.warn(`${abilityName}: выберите токен актера на сцене.`);
    return false;
  }

  const candidate = getLungeWeaponCandidate(actor);
  if (!candidate) {
    ui.notifications.warn(`${abilityName}: нет оружия в оружейном наборе с ближней атакой.`);
    return false;
  }

  const destination = await selectLungeDestination(token, settings, abilityName);
  if (!destination) return false;
  const origin = getTokenDocumentPosition(token.document);

  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }

  await actor.setFlag(SYSTEM_ID, "selectedHudWeaponSetKey", candidate.weaponSet);
  await actor.setFlag(SYSTEM_ID, "selectedHudWeaponItemId", candidate.weapon.id);

  const phantom = createLungePhantom(token, destination);
  let moved = false;
  let completionHandled = false;
  const handleCompletion = async () => {
    phantom?.destroy();
    if (!moved || completionHandled) return;
    completionHandled = true;
    const stay = await promptLungeReturnChoice(abilityName);
    if (stay) return;
    await moveTokenDocumentAndWait(token.document, origin);
  };

  const controller = startWeaponAttack({
    token: token.document?.object ?? token,
    weapon: candidate.weapon,
    actionKey: candidate.actionKey,
    weaponFunctionId: candidate.weaponFunctionId,
    originOverride: getTokenMovementOrigin(token.document, destination),
    onBeforeExecute: async () => {
      if (!isLungeDestinationAvailable(token, destination, {
        width: Math.max(1, Number(token?.w) || Number(canvas.grid?.size) || 100),
        height: Math.max(1, Number(token?.h) || Number(canvas.grid?.size) || 100)
      })) {
        ui.notifications.warn(`${abilityName}: выбранная клетка больше недоступна.`);
        return false;
      }
      if (!hasEnergy(actor, energyCost)) {
        ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
        return false;
      }
      if (!(await spendEnergy(actor, energyCost))) return false;
      await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
        name: getAbilityOverloadName(abilityItem),
        energyCost: settings.overloadEnergyCost,
        durationSeconds: settings.overloadDurationSeconds
      });
      phantom?.destroy();
      await moveTokenDocumentAndWait(token.document, destination);
      moved = true;
      return true;
    },
    attackModifier: createLungeAttackModifier({
      label: abilityName,
      onDestroy: handleCompletion
    })
  });

  if (!controller) {
    phantom?.destroy();
    ui.notifications.warn(`${abilityName}: не удалось начать ближнюю атаку выбранным оружием.`);
    return false;
  }

  await createAbilityChatMessage(actor, abilityItem, "Позиция выбрана, атака началась.");
  return true;
}

function getLungeWeaponCandidate(actor) {
  const candidates = getLungeWeaponCandidates(actor);
  const selectedId = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponItemId") ?? "");
  const selectedSet = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponSetKey") ?? "");
  return candidates.find(candidate => candidate.weapon.id === selectedId)
    ?? candidates.find(candidate => candidate.weaponSet && candidate.weaponSet === selectedSet)
    ?? candidates.at(0)
    ?? null;
}

function getLungeWeaponCandidates(actor) {
  const rows = [];
  for (const weapon of actor?.items?.contents ?? []) {
    const placement = weapon.system?.placement ?? {};
    if (weapon.type !== "gear" || String(placement.mode ?? "") !== "weapon") continue;
    const weaponSet = String(placement.weaponSet ?? "");
    if (!weaponSet) continue;
    if (!hasItemFunction(weapon, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })) continue;
    for (const weaponFunctionId of getWhirlwindWeaponFunctionIds(weapon)) {
      const actionKey = getLungeWeaponActionKey(weapon, weaponFunctionId);
      if (!actionKey) continue;
      rows.push({ weapon, weaponSet, weaponFunctionId, actionKey });
    }
  }
  return rows;
}

function getLungeWeaponActionKey(weapon, weaponFunctionId = "") {
  if (hasWeaponAction(weapon, "meleeAttack", weaponFunctionId)) return "meleeAttack";
  if (hasWeaponAction(weapon, "aimedMeleeAttack", weaponFunctionId)) return "aimedMeleeAttack";
  return "";
}

async function selectLungeDestination(token, settings, abilityName = "Способность") {
  let candidates = buildLungeDestinationCandidates(token, settings);
  if (!candidates.length) {
    ui.notifications.warn(`${abilityName}: нет доступных клеток для перемещения.`);
    return null;
  }

  return new Promise(resolve => {
    const graphics = new PIXI.Graphics();
    let tokenPositionSignature = getLungeTokenPositionSignature(token);
    const layer = canvas.controls?._rulerPaths;
    if (!layer) {
      graphics.destroy();
      ui.notifications.warn(`${abilityName}: слой предпросмотра атаки недоступен.`);
      resolve(null);
      return;
    }
    layer.addChild(graphics);
    drawLungeDestinationCandidates(graphics, candidates);
    ui.notifications.info(`${abilityName}: выберите клетку перемещения. Правая кнопка отменяет выбор.`);

    const refreshCandidates = () => {
      const nextSignature = getLungeTokenPositionSignature(token);
      if (nextSignature === tokenPositionSignature) return;
      tokenPositionSignature = nextSignature;
      candidates = buildLungeDestinationCandidates(token, settings);
      drawLungeDestinationCandidates(graphics, candidates);
    };
    const cleanup = () => {
      canvas.app?.ticker?.remove?.(refreshCandidates);
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      graphics.destroy();
    };
    const finish = value => {
      cleanup();
      resolve(value);
    };
    const onPointerDown = event => {
      if (![0, 2].includes(event.button)) return;
      if (event.button === 2) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        finish(null);
        return;
      }
      const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
      const candidate = candidates.find(entry => (
        point.x >= entry.x && point.x <= entry.x + entry.width
        && point.y >= entry.y && point.y <= entry.y + entry.height
      ));
      if (!candidate) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      finish({ x: candidate.x, y: candidate.y });
    };
    canvas.app?.ticker?.add?.(refreshCandidates);
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
  });
}

function buildLungeDestinationCandidates(token, settings) {
  const document = token?.document ?? token;
  const origin = getLungeTokenCurrentPosition(token);
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const maxCells = Math.max(1, toInteger(settings?.maxCells ?? 2));
  const width = Math.max(gridSize, Number(token?.w ?? gridSize));
  const height = Math.max(gridSize, Number(token?.h ?? gridSize));
  const candidates = [];
  for (let dx = -maxCells; dx <= maxCells; dx += 1) {
    for (let dy = -maxCells; dy <= maxCells; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > maxCells) continue;
      const position = getSnappedTokenPosition(document, {
        x: origin.x + dx * gridSize,
        y: origin.y + dy * gridSize
      });
      if (!isLungeDestinationAvailable(token, position, { width, height })) continue;
      candidates.push({
        x: position.x,
        y: position.y,
        width,
        height
      });
    }
  }
  return deduplicateLungeDestinationCandidates(candidates);
}

function getLungeTokenCurrentPosition(token) {
  const document = token?.document ?? token;
  const object = document?.object ?? token;
  return {
    x: Number(object?.x ?? document?.x ?? document?._source?.x ?? 0),
    y: Number(object?.y ?? document?.y ?? document?._source?.y ?? 0)
  };
}

function getLungeTokenPositionSignature(token) {
  const position = getLungeTokenCurrentPosition(token);
  return `${Math.round(position.x * 100) / 100}:${Math.round(position.y * 100) / 100}`;
}

function isLungeDestinationAvailable(token, position, { width = 0, height = 0 } = {}) {
  const document = token?.document ?? token;
  if (!document?.object) return false;
  if (isLungeDestinationOccupied(token, position, { width, height })) return false;

  const origin = getTokenMovementOrigin(document, getTokenDocumentPosition(document));
  const destination = getTokenMovementOrigin(document, position);
  return !document.object.checkCollision(destination, {
    origin,
    type: "move",
    mode: "any"
  });
}

function isLungeDestinationOccupied(token, position, { width = 0, height = 0 } = {}) {
  const tokenId = String((token?.document ?? token)?.id ?? "");
  const rect = new PIXI.Rectangle(
    Number(position?.x) || 0,
    Number(position?.y) || 0,
    Math.max(1, Number(width) || 0),
    Math.max(1, Number(height) || 0)
  );
  for (const other of canvas.tokens?.placeables ?? []) {
    if (!other?.actor || String(other.document?.id ?? "") === tokenId) continue;
    const otherRect = new PIXI.Rectangle(
      Number(other.document?.x ?? other.x) || 0,
      Number(other.document?.y ?? other.y) || 0,
      Math.max(1, Number(other.w) || Number(canvas.grid?.size) || 100),
      Math.max(1, Number(other.h) || Number(canvas.grid?.size) || 100)
    );
    if (rectanglesOverlap(rect, otherRect)) return true;
  }
  return false;
}

function rectanglesOverlap(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function deduplicateLungeDestinationCandidates(candidates = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = `${Math.round(candidate.x)}:${Math.round(candidate.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function drawLungeDestinationCandidates(graphics, candidates = []) {
  graphics.clear();
  graphics.lineStyle(2, 0xf4d06f, 0.95);
  graphics.beginFill(0xf4d06f, 0.18);
  for (const candidate of candidates) {
    graphics.drawRect(candidate.x, candidate.y, candidate.width, candidate.height);
  }
  graphics.endFill();
}

function createLungePhantom(token, position) {
  const layer = canvas.controls?._rulerPaths;
  const texture = token?.texture ?? token?.mesh?.texture;
  if (!layer || !texture) return null;

  const container = new PIXI.Container();
  container.eventMode = "none";
  container.alpha = 0.45;
  container.x = Number(position?.x) || 0;
  container.y = Number(position?.y) || 0;

  const width = Math.max(1, Number(token?.w) || Number(canvas.grid?.size) || 100);
  const height = Math.max(1, Number(token?.h) || Number(canvas.grid?.size) || 100);
  const sprite = new PIXI.Sprite(texture);
  sprite.width = width;
  sprite.height = height;

  const frame = new PIXI.Graphics();
  frame.lineStyle(3, 0xf4d06f, 0.9);
  frame.drawRect(0, 0, width, height);

  container.addChild(sprite, frame);
  layer.addChild(container);
  return container;
}

async function promptLungeReturnChoice(abilityName = "Способность") {
  const action = await DialogV2.wait({
    window: { title: abilityName },
    content: "",
    buttons: [
      {
        action: "return",
        label: "Вернуться назад",
        icon: "fa-solid fa-arrow-rotate-left",
        default: true
      },
      {
        action: "stay",
        label: "Остаться на месте",
        icon: "fa-solid fa-location-dot",
        type: "button"
      }
    ],
    rejectClose: false,
    modal: true,
    position: { width: 360 }
  });
  return action === "stay";
}

function getTokenDocumentPosition(tokenDocument) {
  return {
    x: Number(tokenDocument?.x ?? tokenDocument?._source?.x ?? 0),
    y: Number(tokenDocument?.y ?? tokenDocument?._source?.y ?? 0)
  };
}

function getTokenMovementOrigin(tokenDocument, position) {
  return tokenDocument.getMovementOrigin({
    x: position.x,
    y: position.y,
    elevation: tokenDocument.elevation,
    width: tokenDocument.width,
    height: tokenDocument.height,
    depth: tokenDocument.depth,
    shape: tokenDocument.shape
  });
}

function getSnappedTokenPosition(tokenDocument, position) {
  return tokenDocument.getSnappedPosition(position);
}

async function moveTokenDocumentAndWait(tokenDocument, position) {
  await tokenDocument?.update?.({ x: position.x, y: position.y }, {
    animate: true,
    [ABILITY_FREE_MOVEMENT_OPTION]: { [tokenDocument.id]: true }
  });
  await tokenDocument?.movement?.animation?.ended;
}

async function useDisarm(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const token = getActorSceneToken(actor);
  const targetToken = getSingleUserTarget();
  if (!token || !targetToken?.actor) {
    ui.notifications.warn(`${abilityName}: выберите одну цель.`);
    return false;
  }
  if (targetToken.actor.uuid === actor.uuid) {
    ui.notifications.warn(`${abilityName}: цель не может быть вами.`);
    return false;
  }
  if (!areTokensAdjacent(token.document, targetToken.document)) {
    ui.notifications.warn(`${abilityName}: цель должна быть на соседней клетке.`);
    return false;
  }

  return requestDisarmOperation({
    mode: "active",
    actorUuid: actor.uuid,
    abilityItemId: abilityItem.id,
    abilityFunctionId: abilityFunction.id,
    actorTokenUuid: token.document.uuid,
    targetTokenUuid: targetToken.document.uuid,
    senderUserId: game.user?.id ?? ""
  });
}

function registerDisarmReactionProvider() {
  CONFIG.queries[DISARM_QUERY_NAME] = handleDisarmQuery;
  registerReactionProvider({
    id: DISARM_REACTION_PROVIDER_ID,
    collect: collectDisarmReactionOffers,
    execute: executeDisarmReaction
  });
}

function registerCounterAttackReactionProvider() {
  registerReactionProvider({
    id: COUNTER_ATTACK_REACTION_PROVIDER_ID,
    collect: collectCounterAttackReactionOffers,
    execute: executeCounterAttackReaction
  });
}

function registerWhereAreYouGoingReactionProvider() {
  CONFIG.queries[WHERE_ARE_YOU_GOING_WEAPON_QUERY_NAME] = handleWhereAreYouGoingWeaponQuery;
  registerReactionProvider({
    id: WHERE_ARE_YOU_GOING_REACTION_PROVIDER_ID,
    collect: collectWhereAreYouGoingReactionOffers,
    execute: executeWhereAreYouGoingReaction
  });
}

function registerWhereAreYouGoingMovementProvider() {
  registerMovementInterruptionProvider({
    id: WHERE_ARE_YOU_GOING_MOVEMENT_PROVIDER_ID,
    collect: collectWhereAreYouGoingMovementInterruptions,
    execute: executeWhereAreYouGoingMovementInterruption
  });
}

function collectWhereAreYouGoingMovementInterruptions({ tokenDocument, movement, options = {} } = {}) {
  const mover = tokenDocument?.actor;
  const combat = getActiveSceneCombat(tokenDocument?.parent);
  if (!mover || !combat || !isTokenActiveCombatant(combat, tokenDocument)) return [];
  const skippedReactorTokenUuids = new Set(
    (options?.[WHERE_ARE_YOU_GOING_RESUME_OPTION]?.reactorTokenUuids ?? [])
      .map(uuid => String(uuid ?? "").trim())
      .filter(Boolean)
  );

  const reactors = (tokenDocument.parent?.tokens?.contents ?? [])
    .filter(other => other?.actor && other.id !== tokenDocument.id)
    .filter(other => isTokenActiveCombatant(combat, other))
    .filter(other => canUseWhereAreYouGoingReaction(other.actor))
    .filter(other => isWhereAreYouGoingOpponent(other.actor, mover))
    .filter(other => getActorWhereAreYouGoingEntries(other.actor).some(entry => (
      hasEnergy(other.actor, getAbilityEnergyCost(
        other.actor,
        entry.abilityItem,
        entry.abilityFunction,
        entry.settings.reactionEnergyCost
      ))
      && getWhereAreYouGoingWeaponCandidates(other.actor)
        .some(candidate => hasRequiredWeaponResources(candidate.weapon, 1, candidate.weaponFunctionId))
    )));
  if (!reactors.length) return [];

  const samples = getMovementRouteSamples(tokenDocument, movement);
  let routeOrder = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const segmentSamples = getMovementSegmentSamples(tokenDocument, samples[index - 1], samples[index]);
    for (let segmentIndex = 1; segmentIndex < segmentSamples.length; segmentIndex += 1) {
      routeOrder += 1;
      const previous = segmentSamples[segmentIndex - 1];
      const current = segmentSamples[segmentIndex];
      const leavingReactors = reactors.filter(reactor => {
        const wasAdjacent = areTokensAdjacentAt(tokenDocument, previous.waypoint, reactor, null);
        const isAdjacent = areTokensAdjacentAt(tokenDocument, current.waypoint, reactor, null);
        if (skippedReactorTokenUuids.has(reactor.uuid)) {
          if (!isAdjacent) skippedReactorTokenUuids.delete(reactor.uuid);
          return false;
        }
        return wasAdjacent && !isAdjacent;
      });
      if (!leavingReactors.length) continue;
      return [{
        type: REACTION_EVENT_KEYS.tokenLeavingAdjacency,
        eventId: `${movement?.id ?? foundry.utils.randomID()}:${routeOrder}`,
        routeOrder,
        priority: -100,
        waypoint: previous.waypoint,
        reactorTokenUuids: leavingReactors.map(reactor => reactor.uuid),
        remainingWaypoints: buildRemainingMovementWaypoints(segmentSamples, segmentIndex, samples, index)
      }];
    }
  }
  return [];
}

async function executeWhereAreYouGoingMovementInterruption({ tokenDocument, movement, event } = {}) {
  const mover = tokenDocument?.actor;
  if (!mover) return;
  const result = await requestReactionEvent(REACTION_EVENT_KEYS.tokenLeavingAdjacency, {
    movementId: movement?.id ?? "",
    moverActorUuid: mover.uuid,
    moverTokenUuid: tokenDocument.uuid,
    reactorTokenUuids: event?.reactorTokenUuids ?? [],
    title: "Реакция на перемещение",
    message: `${mover.name} пытается покинуть соседнюю клетку. Шаг отменён.`
  });
  if (result?.status === REACTION_RESULT.success) return;
  await resumeWhereAreYouGoingMovement(tokenDocument, movement, event);
}

async function collectWhereAreYouGoingReactionOffers({ eventKey = "", context = {} } = {}) {
  if (eventKey !== REACTION_EVENT_KEYS.tokenLeavingAdjacency) return [];
  const mover = await fromUuid(String(context.moverActorUuid ?? ""));
  const moverToken = await fromUuid(String(context.moverTokenUuid ?? ""));
  if (!mover || !moverToken) return [];

  const offers = [];
  for (const reactorTokenUuid of context.reactorTokenUuids ?? []) {
    const reactorToken = await fromUuid(String(reactorTokenUuid ?? ""));
    const reactor = reactorToken?.actor;
    if (
      !reactor
      || !canUseWhereAreYouGoingReaction(reactor)
      || !areTokensAdjacent(reactorToken, moverToken)
      || !isWhereAreYouGoingOpponent(reactor, mover)
    ) continue;
    const entry = getActorWhereAreYouGoingEntries(reactor).find(candidateEntry => {
      const candidateEnergyCost = getAbilityEnergyCost(
        reactor,
        candidateEntry.abilityItem,
        candidateEntry.abilityFunction,
        candidateEntry.settings.reactionEnergyCost
      );
      return hasEnergy(reactor, candidateEnergyCost)
        && getAvailableWhereAreYouGoingWeaponCandidates(reactor).length > 0;
    });
    if (!entry) continue;
    const energyCost = getAbilityEnergyCost(
      reactor,
      entry.abilityItem,
      entry.abilityFunction,
      entry.settings.reactionEnergyCost
    );
    offers.push({
      actorUuid: reactor.uuid,
      reactionId: WHERE_ARE_YOU_GOING_REACTION_PROVIDER_ID,
      offerId: [
        WHERE_ARE_YOU_GOING_REACTION_PROVIDER_ID,
        reactor.uuid,
        entry.abilityFunction.id,
        context.movementId ?? foundry.utils.randomID()
      ].join(":"),
      label: getAbilityDisplayName(entry.abilityItem),
      description: `Остановить ${mover.name} и нанести неприцельный удар.`,
      img: entry.abilityItem.img || "icons/svg/sword.svg",
      costLines: [
        `Энергия: ${entry.settings.reactionEnergyCost} базовая / ${energyCost} итоговая`
      ],
      abilityItemId: entry.abilityItem.id,
      abilityFunctionId: entry.abilityFunction.id,
      reactorTokenUuid: reactorToken.uuid,
      moverTokenUuid: moverToken.uuid,
      energyCost
    });
  }
  return offers;
}

async function executeWhereAreYouGoingReaction({ offer = {} } = {}) {
  const reactor = await fromUuid(String(offer.actorUuid ?? ""));
  const reactorToken = await fromUuid(String(offer.reactorTokenUuid ?? ""));
  const moverToken = await fromUuid(String(offer.moverTokenUuid ?? ""));
  const entry = getActorWhereAreYouGoingEntry(reactor, offer);
  if (!reactor || !reactorToken || !moverToken || !entry || !canUseWhereAreYouGoingReaction(reactor)) {
    return { handled: false };
  }
  if (!areTokensAdjacent(reactorToken, moverToken)) return { handled: false };

  const energyCost = getAbilityEnergyCost(
    reactor,
    entry.abilityItem,
    entry.abilityFunction,
    entry.settings.reactionEnergyCost
  );
  if (!hasEnergy(reactor, energyCost)) {
    return { handled: false };
  }

  const candidates = getAvailableWhereAreYouGoingWeaponCandidates(reactor);
  if (!candidates.length) return { handled: true, status: REACTION_RESULT.failed };
  const selectedCandidate = candidates.length === 1
    ? candidates[0]
    : await queryWhereAreYouGoingWeaponOwner(reactor, candidates, {
      targetName: moverToken.actor?.name ?? "",
      abilityName: getAbilityDisplayName(entry.abilityItem)
    });
  if (!selectedCandidate) return { handled: true, status: REACTION_RESULT.declined };
  const { weapon, weaponFunctionId } = selectedCandidate;
  if (!hasRequiredWeaponResources(weapon, 1, weaponFunctionId)) {
    return { handled: true, status: REACTION_RESULT.failed };
  }

  await spendEnergy(reactor, energyCost);
  await applyAbilityOverloadEffect(reactor, entry.abilityItem, entry.abilityFunction, {
    name: getAbilityOverloadName(entry.abilityItem),
    energyCost: entry.settings.reactionOverloadEnergyCost,
    durationSeconds: entry.settings.reactionOverloadDurationSeconds
  });

  const used = await executeWeaponAttackAgainstToken({
    attackerToken: reactorToken.object ?? reactorToken,
    targetToken: moverToken.object ?? moverToken,
    weapon,
    actionKey: "meleeAttack",
    weaponFunctionId,
    skipActionPointCost: true,
    ignoreReactionLock: true
  });
  if (used) await createWhereAreYouGoingChatMessage(reactor, entry.abilityItem);
  return {
    handled: true,
    status: used ? REACTION_RESULT.success : REACTION_RESULT.failed,
    cancelCurrent: used
  };
}

async function queryWhereAreYouGoingWeaponOwner(actor, candidates = [], { targetName = "", abilityName = "Способность" } = {}) {
  const userId = getActorResponsibleUserId(actor);
  const user = game.users?.get(userId);
  if (!user) return null;
  const data = {
    actorName: actor.name,
    targetName,
    abilityName,
    candidates: candidates.map(candidate => ({
      candidateId: getWhereAreYouGoingWeaponCandidateId(candidate),
      weaponName: candidate.weapon.name,
      img: normalizeImagePath(candidate.weapon.img, "icons/svg/sword.svg")
    }))
  };
  try {
    const response = user.isSelf
      ? await handleWhereAreYouGoingWeaponQuery(data)
      : await user.query(WHERE_ARE_YOU_GOING_WEAPON_QUERY_NAME, data, { timeout: 30000 });
    const candidateId = String(response?.candidateId ?? "").trim();
    return candidates.find(candidate => getWhereAreYouGoingWeaponCandidateId(candidate) === candidateId) ?? null;
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Where are you going weapon query failed`, error);
    return null;
  }
}

async function handleWhereAreYouGoingWeaponQuery(data = {}) {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  if (!candidates.length) return null;
  const options = candidates.map((candidate, index) => `
    <label class="fallout-maw-radio-card fallout-maw-weapon-choice-card">
      <input type="radio" name="candidateId" value="${escapeAttribute(candidate.candidateId)}" ${index === 0 ? "checked" : ""}>
      <img src="${escapeAttribute(candidate.img)}" alt="">
      <span>
        <strong>${escapeHTML(candidate.weaponName)}</strong>
      </span>
    </label>
  `).join("");
  const formData = await DialogV2.input({
    window: { title: `${String(data.abilityName ?? "Способность")}: выбор оружия` },
    content: `
      <div class="fallout-maw-disarm-choice-grid">
        ${data.targetName ? `<p>Цель: <strong>${escapeHTML(data.targetName)}</strong></p>` : ""}
        ${options}
      </div>
    `,
    ok: {
      label: "Атаковать",
      icon: "fa-solid fa-sword",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
    position: { width: 480 },
    rejectClose: false
  });
  const candidateId = String(formData?.candidateId ?? "").trim();
  return candidateId ? { candidateId } : null;
}

function buildRemainingMovementWaypoints(segmentSamples = [], segmentIndex = 0, routeSamples = [], routeIndex = 0) {
  const waypoints = [
    ...segmentSamples.slice(segmentIndex).map(sample => sample?.waypoint),
    ...routeSamples.slice(routeIndex + 1).map(sample => sample?.waypoint)
  ].filter(Boolean);
  const result = [];
  const seen = new Set();
  for (const waypoint of waypoints) {
    const key = [
      Math.round(Number(waypoint.x) || 0),
      Math.round(Number(waypoint.y) || 0),
      Math.round(Number(waypoint.elevation) || 0)
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...waypoint, checkpoint: true });
  }
  return result;
}

async function resumeWhereAreYouGoingMovement(tokenDocument, movement, event = {}) {
  const waypoints = Array.isArray(event.remainingWaypoints) ? event.remainingWaypoints : [];
  if (!tokenDocument || !waypoints.length) return false;
  return tokenDocument.move(waypoints, {
    [WHERE_ARE_YOU_GOING_RESUME_OPTION]: {
      reactorTokenUuids: event.reactorTokenUuids ?? []
    },
    method: movement?.method,
    autoRotate: Boolean(movement?.autoRotate),
    showRuler: Boolean(movement?.showRuler),
    terrainOptions: movement?.terrainOptions,
    constrainOptions: movement?.constrainOptions,
    measureOptions: movement?.measureOptions
  });
}

async function createWhereAreYouGoingChatMessage(actor, abilityItem) {
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p>${escapeHTML(actor.name)} применил реакцию: ${escapeHTML(getAbilityDisplayName(abilityItem))}</p>`,
    sound: null
  });
}

async function requestCounterAttackReaction(context = {}) {
  if (context?.attempted === false) return;
  const attackerActorUuid = String(context?.attackerUuid ?? context?.actorUuid ?? "").trim();
  const attackerTokenUuid = String(context?.tokenUuid ?? "").trim();
  const targetTokenUuids = Array.from(new Set((context?.targetTokenUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  if (!attackerActorUuid || !attackerTokenUuid || !targetTokenUuids.length) return;
  await requestReactionEvent(REACTION_EVENT_KEYS.weaponAttackResolved, {
    attackId: context?.attackId ?? "",
    attackerActorUuid,
    attackerTokenUuid,
    targetTokenUuids,
    weaponUuid: context?.weaponUuid ?? "",
    actionKey: context?.actionKey ?? "",
    weaponFunctionId: context?.weaponFunctionId ?? "",
    title: "Ответная реакция",
    message: "Атака завершена. Доступна реакция контратаки."
  });
}

async function collectCounterAttackReactionOffers({ eventKey = "", context = {} } = {}) {
  if (eventKey !== REACTION_EVENT_KEYS.weaponAttackResolved) return [];
  const attacker = await fromUuid(String(context.attackerActorUuid ?? ""));
  const attackerToken = await fromUuid(String(context.attackerTokenUuid ?? ""));
  if (!attacker || !attackerToken) return [];

  const offers = [];
  const targetTokenUuids = Array.from(new Set((context.targetTokenUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  for (const targetTokenUuid of targetTokenUuids) {
    const defenderToken = await fromUuid(targetTokenUuid);
    const defender = defenderToken?.actor ?? null;
    if (!defender || defender.uuid === attacker.uuid) continue;
    if (!areTokensAdjacent(defenderToken, attackerToken)) continue;
    const entry = getActorCounterAttackEntry(defender);
    if (!entry) continue;
    const settings = entry.settings;
    const energyCost = getAbilityEnergyCost(defender, entry.abilityItem, entry.abilityFunction, settings.reactionEnergyCost);
    if (!hasEnergy(defender, energyCost)) continue;
    if (getMissingWeaponResourceCost(entry.weapon, 1, entry.weaponFunctionId)) continue;
    offers.push({
      actorUuid: defender.uuid,
      reactionId: COUNTER_ATTACK_REACTION_PROVIDER_ID,
      offerId: `${COUNTER_ATTACK_REACTION_PROVIDER_ID}:${defender.uuid}:${context.attackId ?? foundry.utils.randomID()}`,
      label: getAbilityDisplayName(entry.abilityItem),
      description: `Ответить ${entry.weapon.name}: ${attacker.name}.`,
      img: entry.abilityItem.img || entry.weapon.img || "icons/svg/sword.svg",
      costLines: [
        `Энергия: ${settings.reactionEnergyCost} базовая / ${energyCost} итоговая`
      ],
      abilityItemId: entry.abilityItem.id,
      abilityFunctionId: entry.abilityFunction.id,
      weaponId: entry.weapon.id,
      weaponFunctionId: entry.weaponFunctionId,
      defenderTokenUuid: defenderToken.uuid,
      attackerTokenUuid: attackerToken.uuid,
      energyCost
    });
  }
  return offers;
}

async function executeCounterAttackReaction({ offer = {} } = {}) {
  const defender = await fromUuid(String(offer.actorUuid ?? ""));
  const defenderTokenDocument = await fromUuid(String(offer.defenderTokenUuid ?? ""));
  const attackerTokenDocument = await fromUuid(String(offer.attackerTokenUuid ?? ""));
  const entry = getActorCounterAttackEntry(defender, offer);
  if (!defender || !defenderTokenDocument || !attackerTokenDocument || !entry) return { handled: false };
  const settings = entry.settings;
  const energyCost = getAbilityEnergyCost(defender, entry.abilityItem, entry.abilityFunction, settings.reactionEnergyCost);
  if (!areTokensAdjacent(defenderTokenDocument, attackerTokenDocument)) return { handled: false };
  if (!hasEnergy(defender, energyCost)) return { handled: false };
  if (!hasRequiredWeaponResources(entry.weapon, 1, entry.weaponFunctionId)) return { handled: false };

  await spendEnergy(defender, energyCost);
  await applyAbilityOverloadEffect(defender, entry.abilityItem, entry.abilityFunction, {
    name: getAbilityOverloadName(entry.abilityItem),
    energyCost: settings.reactionOverloadEnergyCost,
    durationSeconds: settings.reactionOverloadDurationSeconds
  });

  const used = await executeWeaponAttackAgainstToken({
    attackerToken: defenderTokenDocument.object ?? defenderTokenDocument,
    targetToken: attackerTokenDocument.object ?? attackerTokenDocument,
    weapon: entry.weapon,
    actionKey: "meleeAttack",
    weaponFunctionId: entry.weaponFunctionId,
    skipActionPointCost: true,
    ignoreReactionLock: true
  });
  if (!used) {
    await createAbilityChatMessage(defender, entry.abilityItem, "Не удалось выполнить удар.");
    return { handled: true, status: REACTION_RESULT.failed };
  }
  await createAbilityChatMessage(defender, entry.abilityItem, "Ответная атака выполнена.");
  return { handled: true, status: REACTION_RESULT.success };
}

async function collectDisarmReactionOffers({ eventKey = "", context = {} } = {}) {
  if (eventKey !== REACTION_EVENT_KEYS.weaponAttackTargeted) return [];
  const defender = await fromUuid(String(context.targetActorUuid ?? ""));
  const attacker = await fromUuid(String(context.attackerActorUuid ?? ""));
  const defenderToken = await fromUuid(String(context.targetTokenUuid ?? ""));
  const attackerToken = await fromUuid(String(context.attackerTokenUuid ?? ""));
  const weapon = await fromUuid(String(context.weaponUuid ?? ""));
  if (!defender || !attacker || !defenderToken || !attackerToken || !weapon) return [];
  if (!areTokensAdjacent(defenderToken, attackerToken)) return [];
  if (!isDisarmableWeapon(weapon)) return [];

  const entry = getActorDisarmEntry(defender);
  if (!entry) return [];
  const settings = entry.settings;
  const energyCost = getAbilityEnergyCost(defender, entry.abilityItem, entry.abilityFunction, settings.reactionEnergyCost);
  if (!hasEnergy(defender, energyCost)) return [];
  if (!canSpendCombatActionPoints(defender, settings.reactionActionPointCost, { label: "реакции" })) return [];

  return [{
    actorUuid: defender.uuid,
    reactionId: DISARM_REACTION_PROVIDER_ID,
    offerId: `${DISARM_REACTION_PROVIDER_ID}:${defender.uuid}:${context.attackId ?? foundry.utils.randomID()}`,
    label: getAbilityDisplayName(entry.abilityItem),
    description: `Отнять ${weapon.name} до проверки атаки.`,
    img: entry.abilityItem.img || "icons/svg/combat.svg",
    costLines: [
      `Энергия: ${settings.reactionEnergyCost} базовая / ${energyCost} итоговая`,
      `ОР: ${settings.reactionActionPointCost}`
    ],
    abilityItemId: entry.abilityItem.id,
    abilityFunctionId: entry.abilityFunction.id,
    energyCost
  }];
}

async function executeDisarmReaction({ context = {}, offer = {} } = {}) {
  const defender = await fromUuid(String(offer.actorUuid ?? ""));
  const attacker = await fromUuid(String(context.attackerActorUuid ?? ""));
  const defenderToken = await fromUuid(String(context.targetTokenUuid ?? ""));
  const attackerToken = await fromUuid(String(context.attackerTokenUuid ?? ""));
  const weapon = await fromUuid(String(context.weaponUuid ?? ""));
  const entry = getActorDisarmEntry(defender, offer);
  if (!defender || !attacker || !defenderToken || !attackerToken || !weapon || !entry) return { handled: false };
  const settings = entry.settings;
  const energyCost = getAbilityEnergyCost(defender, entry.abilityItem, entry.abilityFunction, settings.reactionEnergyCost);
  if (!isDisarmableWeapon(weapon) || !areTokensAdjacent(defenderToken, attackerToken)) return { handled: false };
  if (!hasEnergy(defender, energyCost)) return { handled: false };
  if (!canSpendCombatActionPoints(defender, settings.reactionActionPointCost, { label: "реакции" })) return { handled: false };

  await spendEnergy(defender, energyCost);
  if (settings.reactionActionPointCost > 0) await spendCombatActionPoints(defender, settings.reactionActionPointCost);
  await applyAbilityOverloadEffect(defender, entry.abilityItem, entry.abilityFunction, {
    name: getAbilityOverloadName(entry.abilityItem),
    energyCost: settings.reactionOverloadEnergyCost,
    durationSeconds: settings.reactionOverloadDurationSeconds
  });

  const success = await rollDisarmCheck({
    actor: defender,
    targetActor: attacker,
    actorToken: defenderToken.object ?? defenderToken,
    targetToken: attackerToken.object ?? attackerToken,
    difficultyBase: settings.reactionDifficultyBase,
    label: `${getAbilityDisplayName(entry.abilityItem)}: реакция`
  });
  if (!success) {
    await createAbilityChatMessage(defender, entry.abilityItem, `${defender.name} не смог отнять ${weapon.name}.`);
    return { handled: true, status: REACTION_RESULT.failed };
  }
  requestWeaponAttackCompletion({ attackId: context.attackId });
  const moved = await moveDisarmedWeapon({
    sourceActor: attacker,
    targetActor: defender,
    sourceWeapon: weapon,
    targetToken: defenderToken,
    actingUserId: getActorResponsibleUserId(defender),
    abilityName: getAbilityDisplayName(entry.abilityItem)
  });
  await createAbilityChatMessage(
    defender,
    entry.abilityItem,
    moved
      ? `${defender.name} отнял ${weapon.name} у ${attacker.name}.`
      : `${defender.name} не смог разместить ${weapon.name}.`
  );
  return {
    handled: true,
    status: REACTION_RESULT.success,
    cancelCurrent: true,
    cancelRemaining: true
  };
}

async function requestDisarmOperation(payload = {}) {
  if (game.user?.isGM) return processDisarmOperation(payload);
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для выполнения способности.");
    return false;
  }
  const requestId = foundry.utils.randomID();
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      pendingFixedAbilitySocketRequests.delete(requestId);
      resolve(false);
    }, DISARM_SOCKET_TIMEOUT_MS);
    pendingFixedAbilitySocketRequests.set(requestId, { resolve, timeout });
    game.socket.emit(FIXED_ABILITY_SOCKET, {
      scope: FIXED_ABILITY_SOCKET_SCOPE,
      action: "performDisarm",
      requestId,
      gmUserId: gm.id,
      senderUserId: game.user?.id ?? "",
      payload
    });
  });
}

async function processDisarmSocketRequest(message = {}) {
  const result = await processDisarmOperation({
    ...(message.payload ?? {}),
    senderUserId: message.senderUserId ?? message.payload?.senderUserId ?? ""
  });
  game.socket.emit(FIXED_ABILITY_SOCKET, {
    scope: FIXED_ABILITY_SOCKET_SCOPE,
    action: "disarmResult",
    requestId: message.requestId,
    targetUserId: message.senderUserId ?? "",
    result: { used: Boolean(result) }
  });
}

async function processDisarmOperation(payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  const targetTokenDocument = await fromUuid(String(payload.targetTokenUuid ?? ""));
  const actorTokenDocument = await fromUuid(String(payload.actorTokenUuid ?? ""));
  const abilityItem = actor?.items?.get(String(payload.abilityItemId ?? ""));
  const abilityFunction = normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .find(entry => entry.id === payload.abilityFunctionId && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm);
  const sender = game.users?.get(String(payload.senderUserId ?? ""));
  if (!actor || !targetTokenDocument?.actor || !actorTokenDocument || !abilityItem || !abilityFunction) return false;
  const abilityName = getAbilityDisplayName(abilityItem);
  if (sender && !sender.isGM && !actor.testUserPermission(sender, "OWNER")) return false;
  if (!areTokensAdjacent(actorTokenDocument, targetTokenDocument)) return false;

  const settings = normalizeDisarmSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.activeEnergyCost);
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  if (!canSpendCombatActionPoints(actor, settings.activeActionPointCost, { label: "обезоруживания" })) return false;

  const sourceWeapon = await promptDisarmSourceWeapon(targetTokenDocument.actor, payload.senderUserId, abilityName);
  if (!sourceWeapon) return false;
  if (!isDisarmableWeapon(sourceWeapon)) return false;

  await spendEnergy(actor, energyCost);
  if (settings.activeActionPointCost > 0) await spendCombatActionPoints(actor, settings.activeActionPointCost);
  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.activeOverloadEnergyCost,
    durationSeconds: settings.activeOverloadDurationSeconds
  });

  const success = await rollDisarmCheck({
    actor,
    targetActor: targetTokenDocument.actor,
    actorToken: actorTokenDocument.object ?? actorTokenDocument,
    targetToken: targetTokenDocument.object ?? targetTokenDocument,
    difficultyBase: settings.activeDifficultyBase,
    label: abilityName
  });
  if (!success) {
    await createAbilityChatMessage(actor, abilityItem, `${actor.name} не смог отнять ${sourceWeapon.name}.`);
    return true;
  }

  const moved = await moveDisarmedWeapon({
    sourceActor: targetTokenDocument.actor,
    targetActor: actor,
    sourceWeapon,
    targetToken: actorTokenDocument,
    actingUserId: payload.senderUserId ?? getActorResponsibleUserId(actor),
    abilityName
  });
  await createAbilityChatMessage(
    actor,
    abilityItem,
    moved
      ? `${actor.name} отнял ${sourceWeapon.name} у ${targetTokenDocument.actor.name}.`
      : `${actor.name} не смог разместить ${sourceWeapon.name}.`
  );
  return true;
}

async function promptDisarmSourceWeapon(actor, userId = "", abilityName = "Способность") {
  const weapons = getDisarmableWeapons(actor);
  if (!weapons.length) {
    ui.notifications.warn(`${abilityName}: у цели нет оружия, которое можно отнять.`);
    return null;
  }
  if (weapons.length === 1) return weapons[0];
  const result = await queryDisarmUser(userId, {
    mode: "sourceWeapon",
    title: `${abilityName}: выбор оружия`,
    weapons: weapons.map(weapon => ({
      id: weapon.id,
      name: weapon.name,
      img: normalizeImagePath(weapon.img, "icons/svg/combat.svg")
    }))
  });
  return actor.items?.get(String(result?.weaponId ?? "")) ?? null;
}

async function promptDisarmDestination(actor, sourceWeapon, userId = "", abilityName = "Способность") {
  return queryDisarmUser(userId || getActorResponsibleUserId(actor), {
    mode: "destination",
    title: `${abilityName}: размещение оружия`,
    weaponName: sourceWeapon?.name ?? "",
    weaponImg: normalizeImagePath(sourceWeapon?.img, "icons/svg/combat.svg")
  });
}

async function queryDisarmUser(userId = "", data = {}) {
  const user = game.users?.get(String(userId ?? "")) ?? getResponsibleGM();
  if (!user) return null;
  try {
    if (user.isSelf) return handleDisarmQuery(data);
    return user.query(DISARM_QUERY_NAME, data, { timeout: 30000 });
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Disarm query failed`, error);
    return null;
  }
}

async function handleDisarmQuery(data = {}) {
  const mode = String(data.mode ?? "");
  if (mode === "sourceWeapon") {
    const weapons = Array.isArray(data.weapons) ? data.weapons : [];
    const options = weapons.map((weapon, index) => `
      <label class="fallout-maw-radio-card">
        <input type="radio" name="weaponId" value="${escapeAttribute(weapon.id)}" ${index === 0 ? "checked" : ""}>
        <span><strong>${escapeHTML(weapon.name)}</strong></span>
      </label>
    `).join("");
    return DialogV2.input({
      window: { title: String(data.title ?? "Способность") },
      content: `<div class="fallout-maw-disarm-choice-grid">${options}</div>`,
      ok: {
        label: "Выбрать",
        icon: "fa-solid fa-hand",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
      position: { width: 460 },
      rejectClose: false
    });
  }
  if (mode === "destination") {
    return DialogV2.input({
      window: { title: String(data.title ?? "Способность") },
      content: `
        <div class="fallout-maw-disarm-destination">
          <p>Куда поместить <strong>${escapeHTML(data.weaponName)}</strong>?</p>
          <label class="fallout-maw-radio-card">
            <input type="radio" name="destination" value="replace" checked>
            <span><strong>Заменить текущее оружие</strong></span>
          </label>
          <label class="fallout-maw-radio-card">
            <input type="radio" name="destination" value="inventory">
            <span><strong>Убрать в инвентарь</strong></span>
          </label>
          <label class="fallout-maw-radio-card">
            <input type="radio" name="destination" value="drop">
            <span><strong>Бросить на землю</strong></span>
          </label>
        </div>
      `,
      ok: {
        label: "Разместить",
        icon: "fa-solid fa-check",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      position: { width: 440 },
      rejectClose: false,
      close: () => ({ destination: "drop" })
    });
  }
  return null;
}

async function rollDisarmCheck({ actor, targetActor, actorToken = null, targetToken = null, difficultyBase = 0, label = "Способность" } = {}) {
  const outcome = await requestSkillCheck({
    actor,
    skillKey: "athletics",
    data: {
      difficulty: Math.max(0, toInteger(difficultyBase)) + getActorSkillValue(targetActor, "resilience"),
      actorToken,
      targetToken,
      targetActor
    },
    animate: false,
    createMessage: true,
    prompt: false,
    requester: "disarm",
    messageData: { title: label }
  });
  return ["success", "criticalSuccess"].includes(String(outcome?.result?.key ?? ""));
}

async function moveDisarmedWeapon({ sourceActor, targetActor, sourceWeapon, targetToken = null, actingUserId = "", abilityName = "Способность" } = {}) {
  if (!sourceActor || !targetActor || !sourceWeapon) return false;
  const destination = await promptDisarmDestination(targetActor, sourceWeapon, actingUserId, abilityName);
  const requested = String(destination?.destination ?? "drop");
  if (requested === "drop") return dropDisarmedWeaponOnGround({ sourceActor, sourceWeapon, targetToken });
  const attempts = requested === "replace"
    ? [getSelectedWeaponPlacement(targetActor)]
    : [{ mode: "inventory" }];

  for (const placement of attempts.filter(Boolean)) {
    const moved = await tryTransferDisarmedWeapon({ sourceActor, targetActor, sourceWeapon, placement });
    if (moved) return true;
  }
  ui.notifications.warn(`${abilityName}: не удалось разместить ${sourceWeapon.name} у ${targetActor.name}.`);
  return false;
}

async function dropDisarmedWeaponOnGround({ sourceActor, sourceWeapon, targetToken = null } = {}) {
  const itemData = sourceWeapon?.toObject?.();
  if (!itemData || !sourceActor) return false;
  delete itemData._id;
  delete itemData.id;
  foundry.utils.setProperty(itemData, "system.equipped", false);
  foundry.utils.setProperty(itemData, "system.container.parentId", ROOT_CONTAINER_ID);
  foundry.utils.setProperty(itemData, "system.placement", createStoredPlacement({ mode: "inventory", x: 1, y: 1 }, itemData));
  const point = getTokenCenterPoint(targetToken) ?? { x: 0, y: 0 };
  const tile = await createThrownItemTile({
    sceneId: canvas.scene?.id ?? targetToken?.parent?.id ?? "",
    itemData,
    point,
    sourceActorUuid: sourceActor.uuid,
    sourceItemUuid: sourceWeapon.uuid,
    sourceUserId: game.user?.id ?? "",
    combatId: game.combat?.id ?? ""
  });
  if (!tile && game.user?.isGM) return false;
  await sourceActor.deleteEmbeddedDocuments("Item", [sourceWeapon.id]);
  return true;
}

async function tryTransferDisarmedWeapon({ sourceActor, targetActor, sourceWeapon, placement = {} } = {}) {
  const mode = String(placement.mode ?? "inventory");
  const parentIds = mode === "inventory"
    ? getDisarmInventoryParentIds(targetActor)
    : [ROOT_CONTAINER_ID];
  for (const parentId of parentIds) {
    try {
      await transferItemBetweenActors({
        sourceActor,
        targetActor,
        sourceItem: sourceWeapon,
        targetMode: mode,
        targetParentId: parentId,
        targetWeaponSet: placement.weaponSet ?? "",
        targetWeaponSlot: placement.weaponSlot ?? "",
        quantity: 1,
        allowLocked: true,
        spendWeaponSwitchCost: false
      });
      return true;
    } catch (_error) {
      continue;
    }
  }
  return false;
}

function getDisarmableWeapons(actor) {
  return (actor?.items?.contents ?? []).filter(isDisarmableWeapon);
}

function isDisarmableWeapon(item) {
  return Boolean(
    item
    && item.type === "gear"
    && String(item.system?.placement?.mode ?? "") === "weapon"
    && !isNaturalRaceWeapon(item)
    && hasItemFunction(item, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })
  );
}

function getActorDisarmEntry(actor, offer = null) {
  const abilityItemId = String(offer?.abilityItemId ?? "");
  const abilityFunctionId = String(offer?.abilityFunctionId ?? "");
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    if (abilityItemId && abilityItem.id !== abilityItemId) continue;
    const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .find(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.disarm && (!abilityFunctionId || entry.id === abilityFunctionId));
    if (!abilityFunction) continue;
    return {
      abilityItem,
      abilityFunction,
      settings: normalizeDisarmSettings(abilityFunction.fixedSettings)
    };
  }
  return null;
}

function getActorCounterAttackEntry(actor, offer = null) {
  const abilityItemId = String(offer?.abilityItemId ?? "");
  const abilityFunctionId = String(offer?.abilityFunctionId ?? "");
  const weaponId = String(offer?.weaponId ?? "").trim();
  const requestedWeaponFunctionId = String(offer?.weaponFunctionId ?? "").trim();
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    if (abilityItemId && abilityItem.id !== abilityItemId) continue;
    const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .find(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterAttack && (!abilityFunctionId || entry.id === abilityFunctionId));
    if (!abilityFunction) continue;
    const settings = normalizeCounterAttackSettings(abilityFunction.fixedSettings);
    const candidate = getCounterAttackWeaponCandidate(actor, settings, {
      weaponId,
      weaponFunctionId: requestedWeaponFunctionId
    });
    if (!candidate) continue;
    return {
      abilityItem,
      abilityFunction,
      settings,
      ...candidate
    };
  }
  return null;
}

function getActorWhereAreYouGoingEntries(actor) {
  const entries = [];
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.whereAreYouGoing) continue;
      entries.push({
        abilityItem,
        abilityFunction,
        settings: normalizeWhereAreYouGoingSettings(abilityFunction.fixedSettings)
      });
    }
  }
  return entries;
}

function getActorWhereAreYouGoingEntry(actor, offer = null) {
  const abilityItemId = String(offer?.abilityItemId ?? "");
  const abilityFunctionId = String(offer?.abilityFunctionId ?? "");
  return getActorWhereAreYouGoingEntries(actor).find(entry => (
    (!abilityItemId || entry.abilityItem.id === abilityItemId)
    && (!abilityFunctionId || entry.abilityFunction.id === abilityFunctionId)
  )) ?? null;
}

function getWhereAreYouGoingWeaponCandidates(actor) {
  const rows = [];
  for (const weapon of actor?.items?.contents ?? []) {
    const placement = weapon.system?.placement ?? {};
    if (weapon.type !== "gear" || String(placement.mode ?? "") !== "weapon") continue;
    const weaponSet = String(placement.weaponSet ?? "");
    if (!weaponSet || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) continue;
    for (const weaponFunctionId of getWhirlwindWeaponFunctionIds(weapon)) {
      if (!hasWeaponAction(weapon, "meleeAttack", weaponFunctionId)) continue;
      if (
        !isWeaponAttackModeEnabled(weapon, "meleeAttack", "thrust", weaponFunctionId)
        && !isWeaponAttackModeEnabled(weapon, "meleeAttack", "swing", weaponFunctionId)
      ) continue;
      rows.push({ weapon, weaponSet, weaponFunctionId });
    }
  }
  return rows;
}

function getAvailableWhereAreYouGoingWeaponCandidates(actor) {
  return getWhereAreYouGoingWeaponCandidates(actor)
    .filter(candidate => hasRequiredWeaponResources(candidate.weapon, 1, candidate.weaponFunctionId));
}

function getWhereAreYouGoingWeaponCandidateId(candidate = {}) {
  return `${candidate.weapon?.id ?? ""}:${candidate.weaponFunctionId ?? ""}`;
}

function getCounterAttackWeaponCandidate(actor, settings = {}, { weaponId = "", weaponFunctionId = "" } = {}) {
  const candidates = getCounterAttackWeaponCandidates(actor, settings);
  if (weaponId) {
    const exact = candidates.find(candidate => (
      candidate.weapon.id === weaponId
      && (!weaponFunctionId || candidate.weaponFunctionId === weaponFunctionId)
    ));
    if (exact) return exact;
  }
  const selectedId = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponItemId") ?? "");
  const selectedSet = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponSetKey") ?? "");
  return candidates.find(candidate => candidate.weapon.id === selectedId)
    ?? candidates.find(candidate => candidate.weaponSet && candidate.weaponSet === selectedSet)
    ?? candidates.at(0)
    ?? null;
}

function getCounterAttackWeaponCandidates(actor, settings = {}) {
  const rows = [];
  const selectedSet = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponSetKey") ?? "");
  for (const weapon of actor?.items?.contents ?? []) {
    const placement = weapon.system?.placement ?? {};
    if (weapon.type !== "gear" || String(placement.mode ?? "") !== "weapon") continue;
    const weaponSet = String(placement.weaponSet ?? "");
    if (!weaponSet || (selectedSet && weaponSet !== selectedSet)) continue;
    if (!hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) continue;
    for (const weaponFunctionId of getWhirlwindWeaponFunctionIds(weapon)) {
      const weaponData = weaponFunctionId === ITEM_FUNCTIONS.weapon
        ? weapon.system?.functions?.weapon
        : getAdditionalWeaponFunctionData(weapon, weaponFunctionId);
      if (String(weaponData?.skillKey ?? "").trim() !== settings.requiredSkillKey) continue;
      if (!hasWeaponAction(weapon, "meleeAttack", weaponFunctionId)) continue;
      if (
        !isWeaponAttackModeEnabled(weapon, "meleeAttack", "thrust", weaponFunctionId)
        && !isWeaponAttackModeEnabled(weapon, "meleeAttack", "swing", weaponFunctionId)
      ) continue;
      rows.push({ weapon, weaponSet, weaponFunctionId });
    }
  }
  return rows;
}

function getAdditionalWeaponFunctionData(weapon, weaponFunctionId = "") {
  const entries = weapon?.system?.functions?.additionalWeapons;
  const values = Array.isArray(entries)
    ? entries
    : entries && typeof entries === "object" ? Object.values(entries) : [];
  return values.find(entry => String(entry?.id ?? "").trim() === weaponFunctionId) ?? null;
}

function getActiveSceneCombat(scene = null) {
  const combat = game.combat;
  if (!combat?.started) return null;
  const sceneId = String(scene?.id ?? canvas.scene?.id ?? "");
  const combatSceneId = String(combat.scene?.id ?? combat.scene ?? combat.sceneId ?? "");
  if (!sceneId || (combatSceneId && combatSceneId !== sceneId)) return null;
  if (!combatSceneId) {
    const hasSceneCombatant = (combat.combatants?.contents ?? Array.from(combat.combatants ?? []))
      .some(combatant => !combatant?.sceneId || String(combatant.sceneId) === sceneId);
    if (!hasSceneCombatant) return null;
  }
  return combat;
}

function isTokenActiveCombatant(combat, tokenDocument) {
  const document = tokenDocument?.document ?? tokenDocument;
  const tokenId = String(document?.id ?? "");
  const sceneId = String(document?.parent?.id ?? "");
  if (!combat || !tokenId) return false;
  return (combat.combatants?.contents ?? Array.from(combat.combatants ?? []))
    .some(combatant => (
      String(combatant?.tokenId ?? combatant?.token?.id ?? "") === tokenId
      && (!combatant?.sceneId || String(combatant.sceneId) === sceneId)
      && !combatant?.isDefeated
    ));
}

function isWhereAreYouGoingOpponent(reactor, mover) {
  if (!reactor || !mover || reactor.uuid === mover.uuid) return false;
  const factions = getActorFactionBelongs(mover);
  return (factions.length ? factions : [DEFAULT_FACTION_NAME])
    .some(faction => getRelationTo(reactor, faction) !== "ally");
}

function canUseWhereAreYouGoingReaction(actor) {
  if (!actor) return false;
  const defeatedStatus = CONFIG.specialStatusEffects.DEFEATED;
  return !(
    actor.statuses?.has?.("dead")
    || actor.statuses?.has?.("unconscious")
    || (defeatedStatus && actor.statuses?.has?.(defeatedStatus))
  );
}

function getSelectedWeaponPlacement(actor) {
  const selectedId = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponItemId") ?? "");
  const selected = selectedId ? actor.items?.get(selectedId) : null;
  const placement = selected?.system?.placement ?? {};
  if (selected && placement.mode === "weapon") return {
    mode: "weapon",
    weaponSet: placement.weaponSet,
    weaponSlot: placement.weaponSlot
  };
  const first = getDisarmableWeapons(actor).at(0);
  const firstPlacement = first?.system?.placement ?? {};
  if (first && firstPlacement.mode === "weapon") return {
    mode: "weapon",
    weaponSet: firstPlacement.weaponSet,
    weaponSlot: firstPlacement.weaponSlot
  };
  return null;
}

function getDisarmInventoryParentIds(actor) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId) ?? null;
  const inventory = prepareInventoryContext(actor, race, { includeLocked: false });
  return [
    ROOT_CONTAINER_ID,
    ...(inventory.containers ?? []).map(container => String(container?.id ?? "")).filter(Boolean)
  ];
}

function getActorSkillValue(actor, skillKey = "") {
  return toInteger(actor?.system?.skills?.[skillKey]?.value);
}

function getActorSceneToken(actor) {
  return canvas.tokens?.placeables?.find(token => token?.actor?.uuid === actor?.uuid) ?? null;
}

function getSingleUserTarget() {
  const targets = Array.from(game.user?.targets ?? []);
  return targets.length === 1 ? targets[0] : null;
}

function getTokenCenterPoint(tokenDocument = null) {
  const document = tokenDocument?.document ?? tokenDocument;
  const center = document?.getCenterPoint?.();
  if (center) return center;
  const size = document?.getSize?.() ?? {};
  return document ? {
    x: (Number(document.x) || 0) + ((Number(size.width) || Number(document.width) || 1) / 2),
    y: (Number(document.y) || 0) + ((Number(size.height) || Number(document.height) || 1) / 2)
  } : null;
}

function getActorResponsibleUserId(actor) {
  return (game.users?.contents ?? [])
    .filter(user => user.active && !user.isGM && actor?.testUserPermission?.(user, "OWNER"))
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0)?.id
    ?? getResponsibleGM()?.id
    ?? game.user?.id
    ?? "";
}

function hasPendingLuckyCoinEffect(actor) {
  return getPendingOneTimeSkillModifierEffects(actor, data => (
    data.source === LUCKY_COIN_EFFECT_SOURCE
  )).length > 0;
}

async function promptLuckyCoinSkill(actor, abilityItem) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const skills = getSkillSettings()
    .filter(skill => actor.system?.skills?.[skill.key])
    .map(skill => ({
      key: String(skill.key ?? ""),
      label: String(skill.label ?? skill.key ?? "")
    }))
    .filter(skill => skill.key);
  if (!skills.length) {
    ui.notifications.warn(`${abilityName}: у персонажа нет доступных навыков.`);
    return null;
  }

  const options = skills.map((skill, index) => `
    <label class="fallout-maw-radio-card">
      <input type="radio" name="skillKey" value="${escapeAttribute(skill.key)}" ${index === 0 ? "checked" : ""}>
      <span><strong>${escapeHTML(skill.label)}</strong></span>
    </label>
  `).join("");
  const formData = await DialogV2.input({
    window: { title: `${abilityName}: выбор навыка` },
    content: `<div class="fallout-maw-lucky-coin-skill-grid">${options}</div>`,
    ok: {
      label: "Подбросить",
      icon: "fa-solid fa-coins",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
    position: { width: 560 },
    rejectClose: false
  });
  const skillKey = String(formData?.skillKey ?? "");
  return skills.find(skill => skill.key === skillKey) ?? null;
}

async function createLuckyCoinEffect(actor, abilityItem, abilityFunction, skill, modifier) {
  const createdAt = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: `${getAbilityDisplayName(abilityItem)}: ${skill.label}`,
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: {
      changes: [{
        key: ONE_TIME_SKILL_MODIFIER_EFFECT_KEY,
        type: "add",
        value: String(toInteger(modifier)),
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [ONE_TIME_SKILL_MODIFIER_FLAG_KEY]: {
          pending: true,
          source: LUCKY_COIN_EFFECT_SOURCE,
          skillKey: skill.key,
          skillLabel: skill.label,
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          fixedKey: abilityFunction.fixedKey,
          createdAt
        }
      }
    }
  }], { animate: false });
}

async function toggleCurseAndBlessing(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeCurseAndBlessingSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  settings.energyCost = energyCost;
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  const nextActive = !Boolean(state[stateKey]?.active);
  if (nextActive && !hasCurseAndBlessingEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${settings.energyCost}).`);
    return false;
  }
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    active: nextActive
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  ui.notifications.info(`${abilityName}: ${nextActive ? "включено" : "выключено"}.`);
  return true;
}

async function toggleDoubleAttack(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeDoubleAttackSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost) * Math.max(1, toInteger(settings.duplicateCount));
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  const nextActive = !Boolean(state[stateKey]?.active);
  if (nextActive && !hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    active: nextActive
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  ui.notifications.info(`${abilityName}: ${nextActive ? "включено" : "выключено"}.`);
  return true;
}

async function toggleFullForce(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeFullForceSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  const nextActive = !Boolean(state[stateKey]?.active);
  if (nextActive && !hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    active: nextActive
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  ui.notifications.info(`${abilityName}: ${nextActive ? "включено" : "выключено"}.`);
  return true;
}

function requestDoubleAttackDuplicate(context = {}) {
  const actor = context?.actor ?? null;
  const weaponSkillKey = String(context?.weaponData?.skillKey ?? "").trim();
  if (!actor || !weaponSkillKey || typeof context?.addDuplicateRequest !== "function") return;

  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    const functions = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.doubleAttack)
      .filter(entry => Boolean(state[getFixedFunctionStateKey(entry)]?.active));
    for (const abilityFunction of functions) {
      const settings = normalizeDoubleAttackSettings(abilityFunction.fixedSettings);
      if (weaponSkillKey !== settings.requiredSkillKey) continue;
      const duplicateCount = Math.max(1, toInteger(settings.duplicateCount));
      const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost) * duplicateCount;
      context.addDuplicateRequest({
        source: "doubleAttack",
        label: getAbilityDisplayName(abilityItem),
        count: duplicateCount,
        onBeforeDuplicate: async () => spendDoubleAttackEnergy(actor, abilityItem, abilityFunction, energyCost)
      });
    }
  }
}

function requestFullForceWeaponActionModifiers(context = {}) {
  const actor = context?.actor ?? null;
  const weaponSkillKey = String(context?.weaponData?.skillKey ?? "").trim();
  if (!actor || !weaponSkillKey || !context?.modifierState) return;

  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    const functions = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullForce)
      .filter(entry => Boolean(state[getFixedFunctionStateKey(entry)]?.active));
    for (const abilityFunction of functions) {
      const settings = normalizeFullForceSettings(abilityFunction.fixedSettings);
      if (weaponSkillKey !== settings.requiredSkillKey) continue;
      context.modifierState.addCombatValue("damagePercent", settings.damagePercentBonus);
      context.modifierState.multiplyResourceCost("condition", settings.conditionCostMultiplier);
      context.modifierState.addSpendRequirement({
        source: "fullForce",
        label: getAbilityDisplayName(abilityItem),
        canSpend: ({ attackCount = 1 } = {}) => {
          const cost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost) * Math.max(1, toInteger(attackCount));
          if (hasEnergy(actor, cost)) return true;
          ui.notifications.warn(`${getAbilityDisplayName(abilityItem)}: недостаточно энергии (${getActorEnergy(actor)} / ${cost}).`);
          return false;
        },
        spend: async ({ attackCount = 1 } = {}) => {
          const cost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost) * Math.max(1, toInteger(attackCount));
          return spendFullForceEnergy(actor, abilityItem, abilityFunction, cost);
        }
      });
    }
  }
}

async function requestCurseAndBlessingAttackResolution(context = {}) {
  const attackerUuid = String(context?.attackerUuid ?? "").trim();
  const targetUuids = Array.from(new Set((context?.targetUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  if (!attackerUuid || !targetUuids.length) return;
  const payload = {
    attackerUuid,
    targetUuids,
    senderUserId: context?.senderUserId ?? game.user?.id ?? ""
  };
  if (game.user?.isActiveGM) {
    await processCurseAndBlessingAttackResolution(payload);
    return;
  }
  const gm = getResponsibleGM();
  if (gm) {
    game.socket.emit(FIXED_ABILITY_SOCKET, {
      scope: FIXED_ABILITY_SOCKET_SCOPE,
      action: "resolveCurseAndBlessingAttack",
      gmUserId: gm.id,
      senderUserId: game.user?.id ?? "",
      payload
    });
    return;
  }
  await processCurseAndBlessingAttackResolution(payload);
}

function handleFixedAbilitySocketMessage(message = {}) {
  if (message?.scope !== FIXED_ABILITY_SOCKET_SCOPE) return;
  if (message.action === "resolveCurseAndBlessingAttack") {
    if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
    void processCurseAndBlessingAttackResolution({
      ...(message.payload ?? {}),
      senderUserId: message.senderUserId ?? message.payload?.senderUserId ?? ""
    });
    return;
  }
  if (message.action === "performDisarm") {
    if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
    void processDisarmSocketRequest(message);
    return;
  }
  if (message.action === "disarmResult") {
    if (message.targetUserId !== game.user?.id) return;
    const pending = pendingFixedAbilitySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingFixedAbilitySocketRequests.delete(message.requestId);
    pending.resolve(Boolean(message.result?.used));
  }
}

async function processCurseAndBlessingAttackResolution({ attackerUuid = "", targetUuids = [], senderUserId = "" } = {}) {
  const attacker = await fromUuid(String(attackerUuid ?? ""));
  const targets = (await Promise.all(Array.from(new Set(targetUuids))
    .map(uuid => fromUuid(String(uuid ?? "")))))
    .filter(Boolean);
  if (!attacker || !targets.length) return;
  const sender = game.users?.get(String(senderUserId ?? ""));
  if (sender && !sender.isGM && !attacker.testUserPermission(sender, "OWNER")) return;
  await processCurseAndBlessingActorFunctions({
    owner: attacker,
    effectTargets: targets,
    effectKey: ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
    effectName: "Порча"
  });
  for (const target of targets) {
    await processCurseAndBlessingActorFunctions({
      owner: target,
      effectTargets: [target],
      effectKey: ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
      effectName: "Благословение"
    });
  }
}

async function processCurseAndBlessingActorFunctions({ owner = null, effectTargets = [], effectKey = "", effectName = "" } = {}) {
  const targets = (Array.isArray(effectTargets) ? effectTargets : [effectTargets]).filter(Boolean);
  if (!owner || !targets.length || (!game.user?.isGM && !owner.isOwner)) return;
  for (const abilityItem of owner.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    const functions = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing)
      .filter(entry => Boolean(state[getFixedFunctionStateKey(entry)]?.active));
    for (const abilityFunction of functions) {
      const settings = normalizeCurseAndBlessingSettings(abilityFunction.fixedSettings);
      const spent = await spendCurseAndBlessingEnergy(owner, abilityItem, abilityFunction, getAbilityEnergyCost(owner, abilityItem, abilityFunction, settings.energyCost));
      if (!spent) continue;
      const chance = Math.min(100, evaluateActorFormula(settings.triggerFormula, owner, {
        fallback: 0,
        minimum: 0,
        context: getAbilityDisplayName(abilityItem)
      }));
      for (const target of targets) {
        if ((Math.floor(Math.random() * 100) + 1) > chance) continue;
        await applyCurseAndBlessingEffect(target, abilityItem, abilityFunction, {
          effectKey,
          effectName,
          durationSeconds: settings.durationSeconds
        });
      }
    }
  }
}

async function spendCurseAndBlessingEnergy(actor, abilityItem, abilityFunction, energyCost = 0) {
  const cost = Math.max(0, toInteger(energyCost));
  if (!hasCurseAndBlessingEnergy(actor, cost)) {
    await deactivateFixedAbilityFunction(abilityItem, abilityFunction);
    await createAbilityChatMessage(actor, abilityItem, `Выключено: недостаточно энергии (${getActorEnergy(actor)} / ${cost}).`);
    return false;
  }
  if (!cost) return true;
  const resource = actor.system?.resources?.[ENERGY_RESOURCE_KEY];
  const nextValue = Math.max(toInteger(resource?.min), getActorEnergy(actor) - cost);
  const update = {
    [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: nextValue
  };
  if (resource && Object.hasOwn(resource, "spent")) {
    update[`system.resources.${ENERGY_RESOURCE_KEY}.spent`] = Math.max(0, toInteger(resource.max) - nextValue);
  }
  await actor.update(update);
  return true;
}

async function spendDoubleAttackEnergy(actor, abilityItem, abilityFunction, energyCost = 0) {
  const cost = Math.max(0, toInteger(energyCost));
  if (!hasEnergy(actor, cost)) {
    await deactivateFixedAbilityFunction(abilityItem, abilityFunction);
    await createAbilityChatMessage(actor, abilityItem, `Выключено: недостаточно энергии (${getActorEnergy(actor)} / ${cost}).`);
    return false;
  }
  if (!cost) return true;
  const resource = actor.system?.resources?.[ENERGY_RESOURCE_KEY];
  const nextValue = Math.max(toInteger(resource?.min), getActorEnergy(actor) - cost);
  const update = {
    [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: nextValue
  };
  if (resource && Object.hasOwn(resource, "spent")) {
    update[`system.resources.${ENERGY_RESOURCE_KEY}.spent`] = Math.max(0, toInteger(resource.max) - nextValue);
  }
  await actor.update(update);
  return true;
}

async function spendFullForceEnergy(actor, abilityItem, abilityFunction, energyCost = 0) {
  const cost = Math.max(0, toInteger(energyCost));
  if (!hasEnergy(actor, cost)) {
    await deactivateFixedAbilityFunction(abilityItem, abilityFunction);
    await createAbilityChatMessage(actor, abilityItem, `Выключено: недостаточно энергии (${getActorEnergy(actor)} / ${cost}).`);
    return false;
  }
  return spendEnergy(actor, cost);
}

async function spendEnergy(actor, energyCost = 0) {
  const cost = Math.max(0, toInteger(energyCost));
  if (!hasEnergy(actor, cost)) return false;
  if (!cost) return true;
  const resource = actor.system?.resources?.[ENERGY_RESOURCE_KEY];
  const nextValue = Math.max(toInteger(resource?.min), getActorEnergy(actor) - cost);
  const update = {
    [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: nextValue
  };
  if (resource && Object.hasOwn(resource, "spent")) {
    update[`system.resources.${ENERGY_RESOURCE_KEY}.spent`] = Math.max(0, toInteger(resource.max) - nextValue);
  }
  await actor.update(update);
  return true;
}

function getAbilityEnergyCost(actor, abilityItem, abilityFunction, baseCost = 0) {
  return Math.max(0, toInteger(baseCost)) + getAbilityOverloadEnergyCost(actor, abilityItem, abilityFunction);
}

export function getFixedAbilityEnergyCost(actor, abilityItem, abilityFunction, baseCost = 0) {
  return getAbilityEnergyCost(actor, abilityItem, abilityFunction, baseCost);
}

function getAbilityOverloadEnergyCost(actor, abilityItem, abilityFunction) {
  if (!actor || !abilityItem) return 0;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const abilitySourceId = getAbilitySourceId(abilityItem);
  let total = 0;
  for (const effect of actor.allApplicableEffects?.() ?? actor.effects ?? []) {
    if (effect?.disabled) continue;
    const overload = effect.getFlag?.(SYSTEM_ID, ABILITY_OVERLOAD_EFFECT_FLAG_KEY);
    if (!abilityOverloadApplies(overload, { abilityItemId, abilitySourceId })) continue;
    for (const change of effect.system?.changes ?? []) {
      if (String(change?.key ?? "") !== ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY) continue;
      total += Math.max(0, evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: 0 }));
    }
  }
  return Math.max(0, Math.trunc(total));
}

function abilityOverloadApplies(overload = {}, { abilityItemId = "", abilitySourceId = "" } = {}) {
  if (!overload || typeof overload !== "object") return false;
  const overloadSourceId = String(overload.abilitySourceId ?? "").trim();
  if (overloadSourceId && abilitySourceId) return overloadSourceId === abilitySourceId;
  return String(overload.abilityItemId ?? "").trim() === abilityItemId;
}

async function deactivateFixedAbilityFunction(abilityItem, abilityFunction) {
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    active: false
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
}

async function applyCurseAndBlessingEffect(actor, abilityItem, abilityFunction, { effectKey = "", effectName = "", durationSeconds = 0 } = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const startTime = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: effectName,
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: Math.max(0, toInteger(durationSeconds)),
      startTime
    },
    system: {
      changes: [{
        key: effectKey,
        type: "add",
        value: "1",
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [CURSE_AND_BLESSING_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          functionId: abilityFunction.id,
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  await createAbilityChatMessage(actor, abilityItem, `${effectName}: ${formatDuration(durationSeconds)}.`);
  return true;
}

async function applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
  name = "Перегрузка",
  energyCost = 0,
  durationSeconds = 0
} = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const startTime = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name,
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: Math.max(0, toInteger(durationSeconds)),
      startTime
    },
    system: {
      changes: [{
        key: ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
        type: "add",
        value: String(Math.max(0, toInteger(energyCost))),
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [ABILITY_OVERLOAD_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          fixedKey: abilityFunction.fixedKey,
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  return true;
}

async function applyRageEffect(actor, abilityItem, abilityFunction, settings = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const normalized = normalizeRageSettings(settings);
  const startTime = Number(game.time?.worldTime) || 0;
  const changes = [];
  if (normalized.movementPointBonus > 0) {
    changes.push({
      key: "system.resources.movementPoints.bonus",
      type: "add",
      value: String(normalized.movementPointBonus),
      phase: "initial",
      priority: null
    });
  }
  if (normalized.actionPointBonus > 0) {
    changes.push({
      key: "system.resources.actionPoints.bonus",
      type: "add",
      value: String(normalized.actionPointBonus),
      phase: "initial",
      priority: null
    });
  }
  if (normalized.advantageCount > 0 && normalized.advantageSkillKey) {
    changes.push({
      key: `system.skills.${normalized.advantageSkillKey}.advantage`,
      type: "add",
      value: String(normalized.advantageCount),
      phase: "initial",
      priority: null
    });
  }
  if (normalized.disadvantageCount > 0 && normalized.disadvantageSkillKey) {
    changes.push({
      key: `system.skills.${normalized.disadvantageSkillKey}.disadvantage`,
      type: "add",
      value: String(normalized.disadvantageCount),
      phase: "initial",
      priority: null
    });
  }
  if (!changes.length) return false;

  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: getAbilityDisplayName(abilityItem),
    img: abilityItem.img || "icons/svg/explosion.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: Math.max(0, toInteger(normalized.durationSeconds)),
      startTime
    },
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [RAGE_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          fixedKey: abilityFunction.fixedKey,
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  return true;
}

function hasActiveRageEffect(actor, abilityItem, abilityFunction) {
  if (!actor || !abilityItem) return false;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const abilitySourceId = getAbilitySourceId(abilityItem);
  const functionId = String(abilityFunction?.id ?? "").trim();
  return Array.from(actor.effects ?? []).some(effect => {
    if (effect?.disabled) return false;
    const data = effect.getFlag?.(SYSTEM_ID, RAGE_EFFECT_FLAG_KEY);
    if (!data || typeof data !== "object") return false;
    const dataFunctionId = String(data.functionId ?? "").trim();
    if (functionId && dataFunctionId && functionId !== dataFunctionId) return false;
    const dataSourceId = String(data.abilitySourceId ?? "").trim();
    if (dataSourceId && abilitySourceId) return dataSourceId === abilitySourceId;
    return String(data.abilityItemId ?? "").trim() === abilityItemId;
  });
}

async function applyAllOrNothingResultEffect(actor, abilityItem, abilityFunction, settings) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const startTime = Number(game.time?.worldTime) || 0;
  const chance = Math.min(100, Math.max(0, evaluateActorFormula(settings.chanceFormula ?? "50 + gambling/10", actor, {
    fallback: 0,
    minimum: 0,
    context: getAbilityDisplayName(abilityItem)
  })));
  const result = (Math.floor(Math.random() * 100) + 1) <= chance
    ? "criticalSuccess"
    : "criticalFailure";
  const effectKey = SMART_FUDGE_RESULT_EFFECT_KEYS[result];
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: getAbilityDisplayName(abilityItem),
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: 0,
    system: {
      changes: [{
        key: effectKey,
        type: "add",
        value: "1",
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [ALL_OR_NOTHING_EFFECT_FLAG_KEY]: {
          pending: true,
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          fixedKey: abilityFunction.fixedKey,
          result,
          pelletCoveragePercent: Math.max(0, Math.min(100, toInteger(settings.pelletCoveragePercent))),
          burstCoveragePercent: Math.max(0, Math.min(100, toInteger(settings.burstCoveragePercent))),
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  return true;
}

async function consumeAllOrNothingResultEffects(context = {}) {
  if (context?.canceledByReaction && toInteger(context?.attackCheckCount) <= 0) return;
  const actorUuid = String(context?.attackerUuid ?? context?.actorUuid ?? "").trim();
  const actor = actorUuid ? fromUuidSync(actorUuid) : null;
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  const effectIds = Array.from(actor.effects ?? [])
    .filter(effect => !effect.disabled && Boolean(effect.getFlag?.(SYSTEM_ID, ALL_OR_NOTHING_EFFECT_FLAG_KEY)?.pending))
    .map(effect => effect.id)
    .filter(Boolean);
  if (!effectIds.length) return;
  await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
}

async function processReaperAttackResolution(context = {}) {
  if (context?.canceledByReaction) return;
  const actorUuid = String(context?.attackerUuid ?? context?.actorUuid ?? "").trim();
  const actor = actorUuid ? fromUuidSync(actorUuid) : null;
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  const actionPointCost = Math.max(0, toInteger(context?.actionPointCost));
  if (actionPointCost <= 0) return;

  const killed = (context?.killedTargetUuids ?? []).some(uuid => String(uuid ?? "").trim());
  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .find(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.reaper);
    if (!abilityFunction) continue;
    const settings = normalizeReaperSettings(abilityFunction.fixedSettings);
    const restored = killed && rollReaperChance(actor, settings.killChanceFormula, `${getAbilityDisplayName(abilityItem)}: убийство`)
      ? await restoreReaperActionPoints(actor, actionPointCost)
      : 0;
    if (restored > 0) {
      await createAbilityChatMessage(actor, abilityItem, `Восстановлено ${restored} ОД за убийство.`);
      return;
    }
    if (!rollReaperChance(actor, settings.attackChanceFormula, `${getAbilityDisplayName(abilityItem)}: атака`)) continue;
    const attackRestored = await restoreReaperActionPoints(actor, actionPointCost);
    if (attackRestored > 0) {
      await createAbilityChatMessage(actor, abilityItem, `Восстановлено ${attackRestored} ОД за атаку.`);
      return;
    }
  }
}

async function processAtRandomAttackResolution(context = {}) {
  const actorUuid = String(context?.attackerUuid ?? context?.actorUuid ?? "").trim();
  const actor = context?.actor ?? (actorUuid ? fromUuidSync(actorUuid) : null);
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;

  const entry = getActorAtRandomEntry(actor);
  if (!entry) return;

  const actionKey = String(context?.actionKey ?? "").trim();
  if (!ATTACKING_WEAPON_ACTION_KEYS.includes(actionKey)) return;

  const blockedActionKeys = new Set();
  if (rollAtRandomChance(actor, entry.settings.blockChanceFormula, `${getAbilityDisplayName(entry.abilityItem)}: текущее действие`)) {
    blockedActionKeys.add(actionKey);
  }

  if (rollAtRandomChance(actor, entry.settings.extraBlockChanceFormula, `${getAbilityDisplayName(entry.abilityItem)}: случайное действие`)) {
    const candidates = getAtRandomExtraActionCandidates(actionKey);
    if (candidates.length) {
      blockedActionKeys.add(candidates[Math.floor(Math.random() * candidates.length)]);
    }
  }

  await replaceAtRandomActionBlockEffect(actor, entry.abilityItem, entry.abilityFunction, [...blockedActionKeys]);
}

async function applyDefensiveTacticsAtTurnEnd({ actor = null } = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  if (!game.combat?.started) return;
  if (hasActorCombatMovementInCurrentTurn(actor)) return;

  const entries = getActorDefensiveTacticsEntries(actor);
  if (!entries.length) return;

  await deleteDefensiveTacticsEffects(actor);
  for (const entry of entries) {
    await createDefensiveTacticsEffect(actor, entry.abilityItem, entry.abilityFunction, entry.settings);
  }
}

async function deleteDefensiveTacticsEffects(actor) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  const effectIds = Array.from(actor.effects ?? [])
    .filter(effect => Boolean(effect.getFlag?.(SYSTEM_ID, DEFENSIVE_TACTICS_EFFECT_FLAG_KEY)))
    .map(effect => effect.id)
    .filter(Boolean);
  if (effectIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
}

async function createDefensiveTacticsEffect(actor, abilityItem, abilityFunction, settings = {}) {
  const normalized = normalizeDefensiveTacticsSettings(settings);
  const changes = [];
  const lossReduction = Math.max(0, toInteger(normalized.dodgeLossReductionPercent));
  const recoveryBonus = Math.max(0, toInteger(normalized.dodgeRoundRecoveryBonusPercent));
  if (lossReduction > 0) {
    changes.push({
      key: DODGE_LOSS_MODIFIER_EFFECT_KEY,
      type: "add",
      value: String(-lossReduction),
      phase: "initial",
      priority: null
    });
  }
  if (recoveryBonus > 0) {
    changes.push({
      key: DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY,
      type: "add",
      value: String(recoveryBonus),
      phase: "initial",
      priority: null
    });
  }
  if (!changes.length) return false;

  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: getAbilityDisplayName(abilityItem),
    img: abilityItem?.img || "icons/svg/shield.svg",
    origin: abilityItem?.uuid ?? actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [DEFENSIVE_TACTICS_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem?.id ?? "",
          functionId: abilityFunction?.id ?? "",
          fixedKey: ABILITY_FIXED_FUNCTION_KEYS.defensiveTactics,
          round: game.combat?.round ?? 0,
          createdAt: game.time?.worldTime ?? 0
        }
      }
    }
  }], { animate: false });
  return true;
}

function getActorDefensiveTacticsEntries(actor) {
  const entries = [];
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.defensiveTactics) continue;
      entries.push({
        abilityItem,
        abilityFunction,
        settings: normalizeDefensiveTacticsSettings(abilityFunction.fixedSettings)
      });
    }
  }
  return entries;
}

async function processLastChanceLethalDamage({ actor = null, amount = 0 } = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return { handled: false, prevented: false };
  const entry = getActorLastChanceEntry(actor);
  if (!entry) return { handled: false, prevented: false };

  const energyCost = getAbilityEnergyCost(actor, entry.abilityItem, entry.abilityFunction, entry.settings.energyCost);
  if (!hasEnergy(actor, energyCost)) return { handled: false, prevented: false };
  if (!(await spendEnergy(actor, energyCost))) return { handled: false, prevented: false };

  try {
    await applyAbilityOverloadEffect(actor, entry.abilityItem, entry.abilityFunction, {
      name: getAbilityOverloadName(entry.abilityItem),
      energyCost: entry.settings.overloadEnergyCost,
      durationSeconds: entry.settings.overloadDurationSeconds
    });
  } catch (error) {
    console.error("Fallout MaW | Failed to apply Last Chance overload", error);
  }
  const chance = Math.min(100, Math.max(0, evaluateActorFormula(entry.settings.chanceFormula, actor, {
    fallback: 0,
    minimum: 0,
    context: getAbilityDisplayName(entry.abilityItem)
  })));
  const prevented = (Math.floor(Math.random() * 100) + 1) <= chance;
  try {
    await createLastChanceChatMessage(actor, entry.abilityItem, {
      prevented,
      damage: Math.max(0, toInteger(amount)),
      energyCost
    });
  } catch (error) {
    console.error("Fallout MaW | Failed to publish Last Chance result", error);
  }
  return { handled: true, prevented };
}

function getActorLastChanceEntry(actor) {
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .find(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lastChance);
    if (!abilityFunction) continue;
    return {
      abilityItem,
      abilityFunction,
      settings: normalizeLastChanceSettings(abilityFunction.fixedSettings)
    };
  }
  return null;
}

async function createLastChanceChatMessage(actor, abilityItem, { prevented = false, damage = 0, energyCost = 0 } = {}) {
  const context = {
    stateClass: prevented ? "success" : "failure",
    actor: {
      name: actor.name,
      img: actor.img || "icons/svg/mystery-man.svg"
    },
    ability: {
      name: getAbilityDisplayName(abilityItem),
      img: abilityItem?.img || "icons/svg/aura.svg"
    },
    prevented,
    damage: Math.max(0, toInteger(damage)),
    energyCost: Math.max(0, toInteger(energyCost)),
    labels: {
      title: getAbilityDisplayName(abilityItem),
      success: "Смертельный урон отменён",
      failure: `${getAbilityDisplayName(abilityItem)} не сработал`,
      energy: "Потрачено энергии",
      damage: prevented ? "Отменено урона" : "Смертельный урон"
    }
  };
  const content = await renderTemplate(TEMPLATES.lastChanceChatCard, context);
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    sound: null,
    flags: {
      [SYSTEM_ID]: {
        lastChance: {
          actorUuid: actor.uuid,
          abilityItemId: abilityItem?.id ?? "",
          prevented,
          damage: context.damage,
          energyCost: context.energyCost
        }
      }
    }
  });
}

function getActorAtRandomEntry(actor) {
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .find(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.atRandom);
    if (!abilityFunction) continue;
    return {
      abilityItem,
      abilityFunction,
      settings: normalizeAtRandomSettings(abilityFunction.fixedSettings)
    };
  }
  return null;
}

function getAtRandomExtraActionCandidates(currentActionKey = "") {
  const current = String(currentActionKey ?? "").trim();
  return ATTACKING_WEAPON_ACTION_KEYS.filter(actionKey => actionKey !== current);
}

function rollAtRandomChance(actor, formula = "", context = "Способность") {
  const chance = Math.min(100, Math.max(0, evaluateActorFormula(formula, actor, {
    fallback: 0,
    minimum: 0,
    context
  })));
  return (Math.floor(Math.random() * 100) + 1) <= chance;
}

async function replaceAtRandomActionBlockEffect(actor, abilityItem, abilityFunction, actionKeys = []) {
  const previousEffectIds = Array.from(actor.effects ?? [])
    .filter(effect => Boolean(effect.getFlag?.(SYSTEM_ID, AT_RANDOM_ACTION_BLOCK_EFFECT_FLAG_KEY)))
    .map(effect => effect.id)
    .filter(Boolean);
  if (previousEffectIds.length) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", previousEffectIds, { animate: false });
  }

  const uniqueActionKeys = Array.from(new Set(actionKeys
    .map(actionKey => String(actionKey ?? "").trim())
    .filter(actionKey => ATTACKING_WEAPON_ACTION_KEYS.includes(actionKey))));
  if (!uniqueActionKeys.length) return;

  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: getAbilityDisplayName(abilityItem),
    img: abilityItem.img,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: {
      changes: uniqueActionKeys.map(actionKey => ({
        key: getActionBlockEffectKey(actionKey),
        type: "add",
        value: "1",
        phase: "initial",
        priority: null
      }))
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [AT_RANDOM_ACTION_BLOCK_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          functionId: abilityFunction.id,
          actionKeys: uniqueActionKeys
        }
      }
    }
  }], { animate: false });
}

function rollReaperChance(actor, formula = "", context = "Способность") {
  const chance = Math.min(100, Math.max(0, evaluateActorFormula(formula, actor, {
    fallback: 0,
    minimum: 0,
    context
  })));
  return (Math.floor(Math.random() * 100) + 1) <= chance;
}

async function restoreReaperActionPoints(actor, amount = 0) {
  const resource = actor?.system?.resources?.[ACTION_RESOURCE_KEY];
  if (!resource) return 0;
  const current = Math.max(0, toInteger(resource.value));
  const max = Math.max(current, toInteger(resource.max));
  const restored = Math.min(Math.max(0, toInteger(amount)), Math.max(0, max - current));
  if (restored <= 0) return 0;
  await actor.update({
    [`system.resources.${ACTION_RESOURCE_KEY}.value`]: current + restored
  });
  return restored;
}

function applyFourLeafCloverCriticalBonus(check = {}) {
  const actor = check.actor;
  if (!actor) return;
  const charges = getActorFourLeafCloverCharges(actor);
  if (charges <= 0) return;
  check.criticalSuccessBonus = Math.max(0, toInteger(check.criticalSuccessBonus)) + charges;
}

async function updateFourLeafCloverCharges(outcome = {}) {
  const actor = outcome?.actor;
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  const resultKey = String(outcome?.result?.key ?? "");
  if (!["failure", "criticalFailure", "criticalSuccess"].includes(resultKey)) return;

  for (const { abilityItem, abilityFunction, settings } of getActorFourLeafCloverEntries(actor)) {
    let nextCharges = settings.currentCharges;
    if (resultKey === "criticalSuccess") nextCharges = 0;
    else if (resultKey === "criticalFailure") nextCharges += settings.criticalFailureCharges;
    else nextCharges += settings.failureCharges;
    if (nextCharges === settings.currentCharges) continue;
    await updateFixedAbilityFunctionSettings(abilityItem, abilityFunction, {
      ...abilityFunction.fixedSettings,
      currentCharges: nextCharges
    });
  }
}

function getActorFourLeafCloverCharges(actor) {
  return getActorFourLeafCloverEntries(actor)
    .reduce((sum, entry) => sum + Math.max(0, toInteger(entry.settings.currentCharges)), 0);
}

function getActorFourLeafCloverEntries(actor) {
  const entries = [];
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.fourLeafClover) continue;
      entries.push({
        abilityItem,
        abilityFunction,
        settings: normalizeFourLeafCloverSettings(abilityFunction.fixedSettings)
      });
    }
  }
  return entries;
}

async function updateFixedAbilityFunctionSettings(abilityItem, abilityFunction, fixedSettings = {}) {
  if (!abilityItem || !abilityFunction) return false;
  const functions = foundry.utils.deepClone(abilityItem.system?.functions ?? []);
  const index = functions.findIndex(entry => String(entry?.id ?? "") === String(abilityFunction.id ?? ""));
  if (index < 0) return false;
  functions[index].fixedSettings = fixedSettings;
  await abilityItem.update({ "system.functions": functions });
  return true;
}

function hasPendingAllOrNothingResultEffect(actor, abilityItem, abilityFunction) {
  if (!actor || !abilityItem) return false;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const abilitySourceId = getAbilitySourceId(abilityItem);
  return Array.from(actor.effects ?? []).some(effect => (
    !effect.disabled
    && allOrNothingResultApplies(effect.getFlag?.(SYSTEM_ID, ALL_OR_NOTHING_EFFECT_FLAG_KEY), {
      abilityItemId,
      abilitySourceId,
      functionId: abilityFunction?.id ?? ""
    })
  ));
}

function allOrNothingResultApplies(data = {}, { abilityItemId = "", abilitySourceId = "", functionId = "" } = {}) {
  if (!data || typeof data !== "object" || !data.pending) return false;
  const dataFunctionId = String(data.functionId ?? "").trim();
  if (dataFunctionId && functionId && dataFunctionId !== String(functionId).trim()) return false;
  const dataSourceId = String(data.abilitySourceId ?? "").trim();
  if (dataSourceId && abilitySourceId) return dataSourceId === abilitySourceId;
  return String(data.abilityItemId ?? "").trim() === abilityItemId;
}

function hasCurseAndBlessingEnergy(actor, cost = 0) {
  return hasEnergy(actor, cost);
}

function hasEnergy(actor, cost = 0) {
  return getActorEnergy(actor) - Math.max(0, toInteger(cost)) >= toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.min);
}

function getActorEnergy(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.value));
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

async function advanceDeusExMachinaProgressFromDamage(results = []) {
  const damageByActorUuid = new Map();
  for (const result of results.flat(Infinity).filter(Boolean)) {
    if (result.mode && result.mode !== "damage") continue;
    const targetActor = result.actor ?? (result.actorUuid ? fromUuidSync(result.actorUuid) : null);
    const targetActorUuid = targetActor?.uuid ?? String(result.actorUuid ?? "");
    const damage = Math.max(0, toInteger(result.healthDelta));
    if (!damage) continue;
    addActorDamageProgress(damageByActorUuid, targetActorUuid, damage);
    const sourceEntries = Array.isArray(result.sourceDamageEntries) && result.sourceDamageEntries.length
      ? result.sourceDamageEntries
      : [{ source: result.source, damage }];
    for (const entry of sourceEntries) {
      const attackerUuid = String(entry.source?.attackerUuid ?? "").trim();
      addActorDamageProgress(damageByActorUuid, attackerUuid, Math.max(0, toInteger(entry.damage)));
    }
  }

  for (const [actorUuid, damage] of damageByActorUuid) {
    const actor = fromUuidSync(actorUuid);
    if (!actor || (!game.user?.isGM && !actor.isOwner)) continue;
    for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
      await advanceDeusExMachinaProgress(actor, abilityItem, damage);
    }
  }
}

function addActorDamageProgress(progressMap, actorUuid = "", damage = 0) {
  const key = String(actorUuid ?? "").trim();
  if (!key || damage <= 0) return;
  progressMap.set(key, (progressMap.get(key) ?? 0) + damage);
}

async function advanceDeusExMachinaProgress(actor, abilityItem, damage = 0) {
  const entries = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.deusExMachina);
  if (!entries.length || damage <= 0) return;

  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  let changed = false;
  const readyMessages = [];
  for (const entry of entries) {
    const settings = normalizeDeusExMachinaSettings(entry.fixedSettings);
    const stateKey = getFixedFunctionStateKey(entry);
    const current = state[stateKey] ?? {};
    const nextDamage = Math.max(0, toInteger(current.damage)) + damage;
    const ready = nextDamage >= settings.damageRequired;
    state[stateKey] = {
      ...current,
      fixedKey: entry.fixedKey,
      damage: nextDamage,
      readyNotified: Boolean(current.readyNotified) || ready
    };
    changed = true;
    if (ready && !current.readyNotified) readyMessages.push(getAbilityDisplayName(abilityItem));
  }

  if (changed) await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  for (const _label of readyMessages) {
    await createAbilityChatMessage(actor, abilityItem, "Накопление завершено. Способность готова к применению.");
  }
}

async function useDeusExMachina(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeDeusExMachinaSettings(abilityFunction.fixedSettings);
  const state = getFixedAbilityState(abilityItem);
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  const progress = Math.max(0, toInteger(state[stateKey]?.damage));
  if (progress < settings.damageRequired) {
    ui.notifications.warn(`${abilityName}: накоплено ${progress} / ${settings.damageRequired}.`);
    return false;
  }

  const choice = await requestDeusExMachinaChoice(actor, settings, abilityItem);
  if (!choice) return false;

  let applied = false;
  if (choice === "insight") applied = await applyDeusExMachinaInsight(actor, abilityItem, abilityFunction, settings);
  else if (choice === "disintegrate") applied = await applyDeusExMachinaDisintegrate(actor, settings, abilityItem);
  else if (choice === "luckyFind") applied = await applyDeusExMachinaLuckyFind(actor, settings, abilityItem);
  else if (choice === "rescue") applied = await applyDeusExMachinaRescue(actor, settings, abilityItem);

  if (!applied) return false;
  await resetFixedFunctionProgress(abilityItem, abilityFunction);
  return true;
}

async function requestDeusExMachinaChoice(actor, settings, abilityItem) {
  const insightActive = hasDeusExMachinaInsightEffect(actor);
  const targets = Array.from(game.user?.targets ?? []).filter(token => token?.actor);
  const canDisintegrate = targets.length === 1;
  const canRescue = isActorDeadForDeusExMachina(actor);
  const choices = [
    {
      value: "insight",
      label: "Прозрение",
      description: `+${settings.insight.skillBonus} ко всем навыкам на ${formatDuration(settings.insight.durationSeconds)}.`,
      disabledReason: insightActive ? "Бонус уже активен." : ""
    },
    {
      value: "disintegrate",
      label: "Забавный случай",
      description: `Уничтожить ключевые конечности цели и ${settings.disintegrate.destroyPercent}% предметов/валюты.`,
      disabledReason: canDisintegrate ? "" : "Нужна ровно одна цель в таргете."
    },
    {
      value: "luckyFind",
      label: "Удачная находка",
      description: `Найти валюту общей ценностью ${settings.luckyFind.valueMin}-${settings.luckyFind.valueMax}.`,
      disabledReason: ""
    },
    {
      value: "rescue",
      label: "Чудесное спасение",
      description: getRescueChoiceDescription(settings),
      disabledReason: canRescue ? "" : "Доступно только если владелец мертв."
    }
  ];
  const defaultChoice = choices.find(choice => !choice.disabledReason)?.value ?? "";
  const content = `
    <div class="fallout-maw-fixed-function-dialog">
      ${choices.map(choice => renderDeusExMachinaChoice(
        choice.value,
        choice.label,
        choice.description,
        choice.disabledReason,
        choice.value === defaultChoice
      )).join("")}
    </div>
  `;
  let activeDialog = null;
  const onTargetToken = user => {
    if (user?.id !== game.user?.id || !activeDialog) return;
    queueMicrotask(() => syncDeusExMachinaTargetChoice(activeDialog));
  };
  Hooks.on("targetToken", onTargetToken);
  let formData;
  try {
    formData = await DialogV2.input({
      window: { title: getAbilityDisplayName(abilityItem) },
      content,
      ok: {
        label: "Применить",
        icon: "fa-solid fa-check",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
      position: { width: 520 },
      rejectClose: false,
      render: (_event, dialog) => {
        activeDialog = dialog;
        syncDeusExMachinaTargetChoice(dialog);
      }
    });
  } finally {
    Hooks.off("targetToken", onTargetToken);
    activeDialog = null;
  }
  const effect = String(formData?.effect ?? "");
  return ["insight", "disintegrate", "luckyFind", "rescue"].includes(effect) ? effect : "";
}

function renderDeusExMachinaChoice(value, label, description, disabledReason = "", checked = false) {
  const disabled = Boolean(disabledReason);
  return `
    <label class="fallout-maw-radio-card ${disabled ? "disabled" : ""}" data-deus-ex-machina-choice="${escapeAttribute(value)}">
      <input type="radio" name="effect" value="${escapeAttribute(value)}" ${disabled ? "disabled" : ""} ${checked && !disabled ? "checked" : ""}>
      <span>
        <strong>${escapeHTML(label)}</strong>
        <em>${escapeHTML(description)}</em>
        <small data-deus-ex-machina-disabled-reason ${disabled ? "" : "hidden"}>${escapeHTML(disabledReason)}</small>
      </span>
    </label>
  `;
}

function syncDeusExMachinaTargetChoice(dialog) {
  const root = dialog?.element?.querySelector?.(".fallout-maw-fixed-function-dialog");
  const choice = root?.querySelector?.('[data-deus-ex-machina-choice="disintegrate"]');
  const input = choice?.querySelector?.('input[name="effect"]');
  const reason = choice?.querySelector?.("[data-deus-ex-machina-disabled-reason]");
  if (!choice || !input || !reason) return;

  const canDisintegrate = Array.from(game.user?.targets ?? []).filter(token => token?.actor).length === 1;
  input.disabled = !canDisintegrate;
  choice.classList.toggle("disabled", !canDisintegrate);
  reason.hidden = canDisintegrate;
  reason.textContent = canDisintegrate ? "" : "Нужна ровно одна цель в таргете.";

  if (!canDisintegrate && input.checked) {
    input.checked = false;
    root.querySelector('input[name="effect"]:not(:disabled)')?.click();
  }
}

async function applyDeusExMachinaInsight(actor, abilityItem, abilityFunction, settings) {
  if (hasDeusExMachinaInsightEffect(actor)) {
    ui.notifications.warn("Прозрение уже активно.");
    return false;
  }
  if (!getSkillSettings().length) {
    ui.notifications.warn("Навыки не настроены.");
    return false;
  }
  const changes = [{
    key: ALL_SKILLS_BONUS_EFFECT_KEY,
    type: "add",
    value: String(settings.insight.skillBonus),
    phase: "initial",
    priority: null
  }];

  const startTime = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: getAbilityDisplayName(abilityItem),
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: Math.max(0, toInteger(settings.insight.durationSeconds)),
      startTime
    },
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [DEUS_EX_MACHINA_INSIGHT_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  await createAbilityChatMessage(actor, abilityItem, "Прозрение применено.");
  return true;
}

async function applyDeusExMachinaDisintegrate(actor, settings, abilityItem) {
  const targets = Array.from(game.user?.targets ?? []).filter(token => token?.actor);
  if (targets.length !== 1) {
    ui.notifications.warn("Для Забавного случая нужна ровно одна цель.");
    return false;
  }
  const targetActor = targets[0].actor;
  if (!targetActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на изменение цели ${targetActor?.name ?? ""}.`);
    return false;
  }

  const criticalLimbKeys = getCriticalLimbKeys(targetActor);
  for (const limbKey of criticalLimbKeys) await setLimbMissingState(targetActor, limbKey, { syncStatus: false });
  await applyDestroyedLimbConsequences(targetActor, criticalLimbKeys);
  await destroyTargetPossessions(targetActor, settings.disintegrate.destroyPercent);
  await createAbilityChatMessage(actor, abilityItem, `Цель ${targetActor.name} постиг забавный случай.`);
  return true;
}

async function applyDeusExMachinaLuckyFind(actor, settings, abilityItem) {
  const min = Math.min(settings.luckyFind.valueMin, settings.luckyFind.valueMax);
  const max = Math.max(settings.luckyFind.valueMin, settings.luckyFind.valueMax);
  const totalValue = min + Math.floor(Math.random() * ((max - min) + 1));
  const awards = createRandomCurrencyAwards(totalValue);
  if (!awards.length) {
    ui.notifications.warn("Валюты не настроены.");
    return false;
  }

  const update = {};
  for (const award of awards) {
    update[`system.currencies.${award.key}`] = Math.max(0, toInteger(actor.system?.currencies?.[award.key])) + award.amount;
  }
  await actor.update(update);
  await createAbilityChatMessage(actor, abilityItem, `Найдена валюта общей ценностью ${totalValue}.`);
  return true;
}

async function applyDeusExMachinaRescue(actor, settings, abilityItem) {
  if (!isActorDeadForDeusExMachina(actor)) {
    ui.notifications.warn("Чудесное спасение доступно только если владелец мертв.");
    return false;
  }

  const destroyed = getCriticalLimbKeys(actor).filter(limbKey => isLimbDestroyed(actor, limbKey));
  const restoreKeys = settings.rescue.restoreMode === "all"
    ? destroyed
    : destroyed.slice(0, Math.max(1, toInteger(settings.rescue.restoreCount)));
  for (const limbKey of restoreKeys) await restoreDeusExMachinaLimb(actor, limbKey);

  const health = actor.system?.resources?.health;
  const min = toInteger(health?.min);
  if (toInteger(health?.value) <= min) {
    await actor.update({ "system.resources.health.value": min + 1 });
  }
  await createAbilityChatMessage(actor, abilityItem, "Чудесное спасение применено.");
  return true;
}

async function restoreDeusExMachinaLimb(actor, limbKey = "") {
  if (game.user?.isGM) return restoreDestroyedLimb(actor, limbKey);
  const limb = actor?.system?.limbs?.[limbKey];
  if (!actor?.isOwner || !limb) return undefined;
  const max = Math.max(0, toInteger(limb.max));
  return actor.update({
    [`system.limbs.${limbKey}.missing`]: false,
    [`system.limbs.${limbKey}.value`]: max,
    [`system.limbs.${limbKey}.spent`]: 0,
    [`system.limbs.${limbKey}.damageAccumulation`]: {}
  });
}

async function resetFixedFunctionProgress(abilityItem, abilityFunction) {
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  state[stateKey] = {
    fixedKey: abilityFunction.fixedKey,
    damage: 0,
    readyNotified: false
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
}

async function destroyTargetPossessions(actor, percent = 100) {
  const destroyPercent = Math.max(0, Math.min(100, toInteger(percent)));
  if (!destroyPercent) return;

  const itemUpdates = [];
  const itemDeletes = [];
  for (const item of actor.items ?? []) {
    if (item.type === "ability") continue;
    const quantity = Math.max(1, toInteger(item.system?.quantity ?? 1));
    const destroyQuantity = destroyPercent >= 100 ? quantity : Math.floor((quantity * destroyPercent) / 100);
    if (destroyQuantity <= 0) continue;
    if (destroyQuantity >= quantity) itemDeletes.push(item.id);
    else itemUpdates.push({ _id: item.id, "system.quantity": quantity - destroyQuantity });
  }
  if (itemDeletes.length) await actor.deleteEmbeddedDocuments("Item", itemDeletes, { animate: false });
  if (itemUpdates.length) await actor.updateEmbeddedDocuments("Item", itemUpdates);

  const currencyUpdate = {};
  for (const key of Object.keys(actor.system?.currencies ?? {})) {
    const amount = Math.max(0, toInteger(actor.system.currencies[key]));
    const destroyed = destroyPercent >= 100 ? amount : Math.floor((amount * destroyPercent) / 100);
    currencyUpdate[`system.currencies.${key}`] = Math.max(0, amount - destroyed);
  }
  if (Object.keys(currencyUpdate).length) await actor.update(currencyUpdate);
}

function createRandomCurrencyAwards(totalValue = 0) {
  const currencies = getCurrencySettings()
    .map(currency => ({
      key: String(currency.key ?? "").trim(),
      label: String(currency.label ?? currency.key ?? ""),
      value: Math.max(1, Number(currency.value) || 1)
    }))
    .filter(currency => currency.key);
  if (!currencies.length) return [];

  const awards = new Map();
  let remaining = Math.max(0, toInteger(totalValue));
  let guard = 0;
  while (remaining > 0 && guard < 10000) {
    guard += 1;
    const affordable = currencies.filter(currency => currency.value <= remaining);
    const pool = affordable.length ? affordable : currencies;
    const currency = pool[Math.floor(Math.random() * pool.length)];
    awards.set(currency.key, (awards.get(currency.key) ?? 0) + 1);
    remaining -= currency.value;
  }
  return Array.from(awards, ([key, amount]) => ({ key, amount }));
}

function getFixedAbilityState(abilityItem) {
  const state = abilityItem?.getFlag?.(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? abilityItem?.flags?.[SYSTEM_ID]?.[ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY];
  return state && typeof state === "object" ? state : {};
}

function getFixedFunctionStateKey(abilityFunction = {}) {
  return [String(abilityFunction.id ?? ""), String(abilityFunction.fixedKey ?? "")].filter(Boolean).join(":");
}

function getCriticalLimbKeys(actor) {
  return Object.keys(actor?.system?.limbs ?? {}).filter(limbKey => isCriticalLimb(actor, limbKey));
}

function isActorDeadForDeusExMachina(actor) {
  return Boolean(actor?.statuses?.has?.(STATUS_EFFECTS.dead))
    || getCriticalLimbKeys(actor).some(limbKey => isLimbDestroyed(actor, limbKey));
}

function hasDeusExMachinaInsightEffect(actor) {
  return Array.from(actor?.effects ?? []).some(effect => (
    !effect.disabled
    && Boolean(effect.getFlag?.(SYSTEM_ID, DEUS_EX_MACHINA_INSIGHT_EFFECT_FLAG_KEY))
  ));
}

function getRescueChoiceDescription(settings) {
  if (settings.rescue.restoreMode === "all") return "Восстановить все ключевые конечности и прийти в сознание.";
  return `Восстановить ключевые конечности: ${Math.max(1, toInteger(settings.rescue.restoreCount))}.`;
}

function formatDuration(seconds = 0) {
  const safeSeconds = Math.max(0, toInteger(seconds));
  if (!safeSeconds) return "без ограничения времени";
  if (safeSeconds % 3600 === 0) return `${safeSeconds / 3600} ч.`;
  if (safeSeconds % 60 === 0) return `${safeSeconds / 60} мин.`;
  return `${safeSeconds} сек.`;
}

async function createAbilityChatMessage(actor, item, message = "") {
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${escapeHTML(getAbilityDisplayName(item))}</strong></p><p>${escapeHTML(message)}</p>`,
    sound: null
  });
}

function getAbilityDisplayName(item) {
  return String(item?.name ?? "").trim() || "Способность";
}

function getAbilityOverloadName(item) {
  return `Перегрузка: ${getAbilityDisplayName(item)}`;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/`/g, "&#096;");
}
