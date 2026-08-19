import { GRAPPLE_MODIFIER_HOOK, GRAPPLE_MODIFIER_KINDS } from "../combat/grapple-modifiers.mjs";
import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getCurrencySettings,
  getDamageTypeSettings,
  getNeedSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { getActiveRulesProfile } from "../settings/rules-profiles.mjs";
import {
  ABILITY_ACTIVE_APPLICATION_COST_PAYERS,
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  createAbilityFunction,
  getAbilityFunctionEffectDurationSeconds,
  getAbilitySourceId,
  normalizeActiveApplicationSettings,
  normalizeAbilityConstructs,
  normalizeAbilityFunctions,
  normalizeAllOrNothingSettings,
  normalizeAimingSettings,
  normalizeAtRandomSettings,
  normalizeCommandBasicsSettings,
  normalizeCounterAttackSettings,
  normalizeOversightSettings,
  normalizeWatchOutSettings,
  normalizeCounterSniperSettings,
  normalizeCurseAndBlessingSettings,
  normalizeDeusExMachinaSettings,
  normalizeDefensiveTacticsSettings,
  normalizeDisarmSettings,
  normalizeDoubleAttackSettings,
  normalizeFourLeafCloverSettings,
  normalizeFullControlSettings,
  normalizeFullForceSettings,
  normalizeGrapplingMasterSettings,
  normalizeGoodEnoughSettings,
  normalizeAnatomyStudySettings,
  normalizeSpecialMixSettings,
  normalizeHeightenedConcentrationSettings,
  normalizeLastChanceSettings,
  normalizeLethalAttackSettings,
  normalizeKeepAwaySettings,
  normalizeKnockOffBalanceSettings,
  normalizeLookSettings,
  normalizeLuckyCoinSettings,
  normalizeLungeSettings,
  normalizeReaperSettings,
  normalizeToTheEndSettings,
  normalizeVirtuosoSettings,
  normalizeVersatileDevelopmentSettings,
  normalizeRageSettings,
  normalizeRicochetSettings,
  normalizeTwoHandsSettings,
  normalizeWhirlwindSettings,
  normalizeWhereAreYouGoingSettings
} from "../settings/abilities.mjs";
import { openAnatomyStudyApplication } from "../apps/anatomy-study.mjs";
import {
  ANATOMY_STUDY_BONUS_KEYS,
  buildAnatomyStudyKnowledgeUpdate,
  getActorAnatomyStudyRaceBonuses,
  getActorRaceId,
  getAnatomyStudyBonusDefinitions,
  getAnatomyStudyFunctionState,
  getAnatomyStudyMemoryCapacity,
  getAnatomyStudyMemoryUsage,
  isActorDeadForAnatomyStudy
} from "./anatomy-study.mjs";
import { abilityConditionsApply } from "./evaluation.mjs";
import { buildActiveApplicationCostPlanEntries } from "./active-application-costs.mjs";
import {
  executePreparedAbilityFunctionActions,
  getAbilityTargetExecutorAvailability,
  prepareAbilityFunctionActions
} from "./ability-actions.mjs";
import { executeAbilityTrials } from "./trial-runtime.mjs";
import {
  ATTACKING_WEAPON_ACTION_KEYS,
  getActionBlockEffectKey,
  getWeaponActionBlockState
} from "./runtime-state.mjs";
import {
  applyDestroyedLimbConsequences,
  isCriticalLimb,
  isLimbDestroyed,
  registerDamageAppliedHandler,
  registerLethalDamagePreventionHandler,
  requestDamageApplications,
  restoreActorHealthCost,
  restoreDestroyedLimb,
  setLimbMissingState
} from "../combat/damage-hub.mjs";
import {
  getMissingWeaponResourceCost,
  hasWeaponAction,
  hasRequiredWeaponResources,
  isWeaponAttackModeEnabled,
  canPerformAimedAttackAgainstToken,
  canPerformWeaponActionAgainstToken,
  canTokenPhysicallySeeTarget,
  executeWeaponAttackAgainstToken,
  getActionAttackCount,
  getWeaponActionModifierEnergyCost,
  startAbilityAttackActionAndWait,
  startCommandedWeaponAttacks,
  startForcedAimedAttackSelection,
  startWeaponAttack,
  WEAPON_ACTION_MODIFIER_REQUEST_HOOK,
  WEAPON_ATTACK_CHECK_RESOLVED_HOOK,
  WEAPON_ATTACK_DAMAGE_RESOLVED_HOOK,
  WEAPON_ATTACK_DUPLICATE_REQUEST_HOOK,
  WEAPON_ATTACK_RESOLVED_HOOK,
  registerWeaponAttackResolvedHandler,
  requestWeaponAttackCompletion
} from "../combat/weapon-attack-controller.mjs";
import {
  DEUS_EX_MACHINA_PROGRESS_FLAG_ROOT,
  DEUS_EX_MACHINA_PROGRESS_OPTION
} from "./deus-ex-machina-progress-runtime.mjs";
import { createLungeAttackModifier, createWhirlwindAttackModifier } from "../combat/weapon-attack-modifiers.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { changedDataIntersectsPaths } from "../utils/document-change-paths.mjs";
import {
  ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
  ALL_SKILLS_BONUS_EFFECT_KEY,
  ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
  ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
  ONE_TIME_SKILL_MODIFIER_EFFECT_KEY,
  SMART_FUDGE_RESULT_EFFECT_KEYS,
  TRAUMA_SUPPRESSION_ALL_EFFECT_KEY,
  evaluateActorEffectChangeNumber
} from "../utils/active-effect-changes.mjs";
import { prepareEffectChangeForApplication } from "../utils/effect-change-values.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import {
  ABILITY_FREE_MOVEMENT_OPTION,
  ACTION_RESOURCE_KEY,
  MOVEMENT_RESOURCE_KEY,
  applyCombatMovementCostModifier,
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
import { requestSkillCheck, requestSkillCheckBatch } from "../rolls/skill-check.mjs";
import { REACTION_EVENT_KEYS, REACTION_RESULT, isActorUnableToAct, isReactionSystemLocked, registerReactionProvider, requestReactionEvent } from "../combat/reaction-hub.mjs";
import {
  canSpendCombatActionPoints,
  isActorInActiveCombat,
  refundCombatActionPointReceipt,
  spendCombatActionPoints,
  spendCombatActionPointsWithReceipt
} from "../combat/reaction-resources.mjs";
import { notifyCombatResourcesSpent, waitForCombatResourceSpending } from "../combat/resource-spending.mjs";
import {
  OVERSIGHT_RESOURCE_SPENT_EVENT_KEY,
  advanceOversightResourceThreshold
} from "../events/oversight-resource-event.mjs";
import {
  ENERGY_RESOURCE_KEY,
  canActorSpendEnergy,
  getActorEnergy
} from "../combat/energy-resource.mjs";
import { areTokensAdjacent, areTokensAdjacentAt, resolveKnockback } from "../combat/active-actions.mjs";
import {
  createMovementOptions,
  getMovementRouteSamples,
  getMovementRouteWaypointProgress,
  getMovementSegmentSamples,
  registerMovementInterruptionProvider
} from "../canvas/movement-interruptions.mjs";
import {
  getMovementResumeContext,
  INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION,
  withMovementResumeContext
} from "../canvas/movement-resume-context.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorFactionBelongs,
  getRelationTo
} from "../settings/factions.mjs";
import { dropActorInventoryItem } from "../items/dropped-items.mjs";
import {
  getActorInventoryGridDimensions,
  getActorRootInventoryGridOptions,
  prepareInventoryContext,
  normalizeImagePath
} from "../utils/actor-display-data.mjs";
import {
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableResolvedInventoryPlacement,
  getContainerInventoryGridOptions,
  getContextInventoryItems,
  getItemContainerParentId
} from "../utils/inventory-containers.mjs";
import {
  executeInventoryMutation,
  expandInventoryDeleteIds,
  projectActorInventoryState
} from "../inventory/mutation.mjs";
import { transferItemBetweenActors } from "../apps/search-inventory.mjs";
import {
  getDeployedWeaponSetKey,
  ITEM_FUNCTIONS,
  getEnabledWeaponFunctions,
  getFirstAidChargesData,
  hasItemFunction
} from "../utils/item-functions.mjs";
import { planInventoryItemConsumption } from "../inventory/consume.mjs";
import {
  areDistinctSpecialMixMedicines,
  buildSpecialMixItemData,
  getSpecialMixFirstAidDetails,
  getSpecialMixMedicineDetails,
  isSpecialMixMedicineEligible,
  mergeSpecialMixFirstAid
} from "./special-mix.mjs";
import { resolveActiveHudWeaponSet } from "../utils/hud-active-items.mjs";
import { isNaturalRaceItem, isNaturalRaceWeapon } from "../races/natural-items.mjs";
import {
  requestCustomActorTokenSelection,
  requestCustomTokenSelection
} from "../canvas/custom-token-selection.mjs";
import { createRightClickPanGuard } from "../canvas/right-click-pan-guard.mjs";
import { startCanvasTargetSelectionSession } from "../canvas/target-selection-lifecycle.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import {
  getSystemEventCancellationReason,
  isSystemEventCancelled,
  runTerminalSystemEventWorkflow,
  serializeSystemWorkflowError
} from "../utils/system-event-workflow.mjs";
import {
  ABILITY_OVERLOAD_EFFECT_FLAG_KEY,
  applyAbilityOverloadEffect,
  getAbilityOverloadEnergyCost,
  getAbilityOverloadName
} from "./overload.mjs";
import {
  notifyAbilityTriggerCostFailure,
  payAbilityFunctionResourceCosts,
  quoteAbilityFunctionResourceCosts
} from "./trigger-cost-runtime.mjs";
import { requestLimitedChangeSelection } from "./purchase.mjs";
import {
  getSelectableAbilityChanges,
  resolveLimitedChangeLimit,
  resolveLimitedChangeSet
} from "./limited-changes.mjs";
import {
  LIMITED_EFFECT_COPY_FLAG_KEY,
  buildLimitedEffectCopyFlag,
  hasLimitedEffectCopyCapacity,
  releaseLimitedEffectCopyReservation,
  reserveLimitedEffectCopySlot
} from "./limited-effect-copies.mjs";
import {
  EFFECT_LIFECYCLE_FLAG_KEY,
  EFFECT_LIFECYCLE_KINDS
} from "./effect-lifecycle.mjs";
import {
  getAuraRelation as getSharedAbilityTargetRelation,
  hasAuraLineOfSight as hasActiveApplicationLineOfSight,
  measureTokenDistanceMeters as measureActiveApplicationTokenDistance
} from "./aura-conditions.mjs";
import {
  ACTIVE_APPLICATION_EFFECT_FLAG_KEY,
  activeApplicationFunctionHasDistributionAura,
  activeApplicationFunctionHasRuntimeAura,
  activeApplicationFunctionHasTriggerAura,
  buildActiveApplicationMarkerChangeUpdate,
  prepareActiveApplicationAuraFunctionData,
  resolveActiveApplicationMarkerChanges
} from "./active-application-effects.mjs";
import {
  applyActiveApplicationItemMutations,
  hasActiveApplicationItemMutations,
  rollbackActiveApplicationItemMutations
} from "./active-application-item-mutations.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const { renderTemplate } = foundry.applications.handlebars;
export const ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY = "abilityFixedFunctionState";
const DEUS_EX_MACHINA_INSIGHT_EFFECT_FLAG_KEY = "deusExMachinaInsight";
const CURSE_AND_BLESSING_EFFECT_FLAG_KEY = "curseAndBlessing";
const ALL_OR_NOTHING_EFFECT_FLAG_KEY = "allOrNothing";
const LETHAL_ATTACK_EFFECT_FLAG_KEY = "lethalAttack";
const AT_RANDOM_ACTION_BLOCK_EFFECT_FLAG_KEY = "atRandomActionBlock";
const LUCKY_COIN_EFFECT_SOURCE = "luckyCoin";
const HEIGHTENED_CONCENTRATION_EFFECT_SOURCE = "heightenedConcentration";
const DEFENSIVE_TACTICS_EFFECT_FLAG_KEY = "defensiveTactics";
const COMMAND_BASICS_DODGE_EFFECT_FLAG_KEY = "commandBasicsDodge";
const KNOCK_OFF_BALANCE_EFFECT_FLAG_KEY = "knockOffBalance";
const TO_THE_END_EFFECT_FLAG_KEY = "toTheEnd";
const RAGE_EFFECT_FLAG_KEY = "rage";
const DISARM_REACTION_PROVIDER_ID = "disarm";
const COUNTER_ATTACK_REACTION_PROVIDER_ID = "counterAttack";
const OVERSIGHT_REACTION_PROVIDER_ID = "oversight";
const OVERSIGHT_MOVEMENT_PROVIDER_ID = "oversightMovement";
const OVERSIGHT_QUERY_NAME = "falloutMawOversightAttack";
const OVERSIGHT_EFFECT_FLAG_KEY = "oversight";
const WATCH_OUT_REACTION_PROVIDER_ID = "watchOut";
const FULL_CONTROL_EFFECT_FLAG_KEY = "fullControl";
const COUNTER_SNIPER_REACTION_PROVIDER_ID = "counterSniper";
const COUNTER_SNIPER_AIM_QUERY_NAME = "falloutMawCounterSniperAim";
const WHERE_ARE_YOU_GOING_REACTION_PROVIDER_ID = "whereAreYouGoing";
const WHERE_ARE_YOU_GOING_MOVEMENT_PROVIDER_ID = "whereAreYouGoingMovement";
const WHERE_ARE_YOU_GOING_WEAPON_QUERY_NAME = "falloutMawWhereAreYouGoingWeapon";
const DISARM_QUERY_NAME = "falloutMawDisarm";
const ACTIVE_APPLICATION_QUERY_NAME = "falloutMawActiveApplication";
const DISARM_SOCKET_TIMEOUT_MS = 60000;
const DEUS_EX_MACHINA_SOCKET_TIMEOUT_MS = 60000;
const ACTIVE_APPLICATION_AUTHORITY_CACHE_MS = 5 * 60 * 1000;
const FIXED_ABILITY_SOCKET = `system.${SYSTEM_ID}`;
const FIXED_ABILITY_SOCKET_SCOPE = "fallout-maw.fixedAbilityFunctions";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const STATUS_EFFECTS = Object.freeze({
  dead: "dead"
});
const pendingFixedAbilitySocketRequests = new Map();
const activeApplicationAuthorityOperations = new Map();
const activeApplicationAuthorityRequestsByUse = new Map();
const activeApplicationAuthorityRequestsById = new Map();
const actorEnergyMutationQueue = new Map();
const activeApplicationEffectSyncTimers = new Map();
const whereAreYouGoingSuppressedReactors = new Map();

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
    key: ABILITY_FIXED_FUNCTION_KEYS.virtuoso,
    label: "Виртуоз",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.virtuoso
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.versatileDevelopment,
    label: "Всестороннее развитие",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.versatileDevelopment,
      fixedSettings: normalizeVersatileDevelopmentSettings()
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.aiming,
    label: "Выцеливание",
    active: true,
    toggleable: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.aiming
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.keepAway,
    label: "Держись подальше",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.keepAway
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.ricochet,
    label: "Рикошет",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.ricochet
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.lethalShot,
    label: "Смертельный выстрел",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.lethalShot
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.lethalStrike,
    label: "Смертельный удар",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.lethalStrike
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.hawkEye,
    label: "Соколиный глаз",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.hawkEye
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
    key: ABILITY_FIXED_FUNCTION_KEYS.oversight,
    label: "Надзор",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.oversight
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.watchOut,
    label: "Берегись!",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.watchOut
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.dangerSense,
    label: "Чутье",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.dangerSense
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.fullControl,
    label: "Полный контроль",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.fullControl
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.counterSniper,
    label: "Контр-снайпер",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.counterSniper
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
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.twoHands,
    label: "С двух рук",
    active: true,
    toggleable: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.twoHands
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.commandBasics,
    label: "Основы командования",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.commandBasics,
      fixedSettings: normalizeCommandBasicsSettings()
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance,
    label: "Выбить из колеи",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance,
      fixedSettings: normalizeKnockOffBalanceSettings()
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.look,
    label: "Смотри!",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.look,
      fixedSettings: normalizeLookSettings()
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.toTheEnd,
    label: "До конца!!!",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.toTheEnd,
      fixedSettings: normalizeToTheEndSettings()
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration,
    label: "Повышенная концентрация",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration,
      fixedSettings: normalizeHeightenedConcentrationSettings()
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.grapplingMaster,
    label: "Мастер по скручиванию",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.grapplingMaster,
      fixedSettings: normalizeGrapplingMasterSettings()
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.goodEnough,
    label: "И так сойдет",
    passive: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.goodEnough,
      fixedSettings: normalizeGoodEnoughSettings()
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy,
    label: "Изучение анатомии",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy,
      fixedSettings: normalizeAnatomyStudySettings()
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.specialMix,
    label: "Особый намес",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.specialMix,
      fixedSettings: normalizeSpecialMixSettings()
    })
  })
]);

let fixedAbilityRuntimeHooksRegistered = false;
let fixedAbilitySocketRegistered = false;
let fixedAbilitySocketLifecycleRegistered = false;

export function registerFixedAbilityFunctionHooks() {
  Hooks.on("updateActor", (actor, _changes, options = {}) => {
    if (
      !options?.falloutMawDocumentMigration
      && !options?.falloutMawConsciousnessStateSync
      && !options?.falloutMawActiveAuraRuntime
      && !options?.falloutMawTrialRuntime
    ) queueActiveApplicationEffectSync(actor);
  });
  CONFIG.queries[ACTIVE_APPLICATION_QUERY_NAME] = handleActiveApplicationEffectQuery;
  Hooks.on(`${SYSTEM_ID}.settingsPresetApplied`, registerFixedAbilityRuntimeHooks);
  registerFixedAbilityRuntimeHooks();
}

function registerFixedAbilityRuntimeHooks() {
  if (fixedAbilityRuntimeHooksRegistered || !areFixedAbilityFunctionsEnabled()) return;
  fixedAbilityRuntimeHooksRegistered = true;

  registerDisarmReactionProvider();
  registerCounterAttackReactionProvider();
  registerWeaponAttackResolvedHandler(
    "fallout-maw.fixed.counterAttack",
    runFixedAbilityRuntimeHandler(requestCounterAttackReaction)
  );
  registerOversightReactionProvider();
  registerWatchOutReactionProvider();
  registerCounterSniperReactionProvider();
  registerWhereAreYouGoingReactionProvider();
  registerWhereAreYouGoingMovementProvider();
  registerOversightMovementProvider();
  CONFIG.queries[OVERSIGHT_QUERY_NAME] = runFixedAbilityRuntimeHandler(handleOversightAttackQuery);
  Hooks.on("sightRefresh", runFixedAbilityRuntimeHandler(() => scheduleOversightVisibilityRefresh()));
  Hooks.on("canvasReady", runFixedAbilityRuntimeHandler(() => scheduleOversightVisibilityRefresh()));
  Hooks.on("deleteToken", runFixedAbilityRuntimeHandler(token => {
    void cleanupOversightToken(token);
  }));
  registerActorTurnEndHandler(runFixedAbilityRuntimeHandler(context => applyDefensiveTacticsAtTurnEnd(context)));
  registerActorTurnStartPreparedHandler(runFixedAbilityRuntimeHandler(context => deleteDefensiveTacticsEffects(context?.actor)));
  registerLethalDamagePreventionHandler(runFixedAbilityRuntimeHandler(context => processLastChanceLethalDamage(context)));
  registerDamageAppliedHandler(
    "fallout-maw.fixed.deusExMachinaProgress",
    runFixedAbilityRuntimeHandler(context => advanceDeusExMachinaProgressFromDamage(context?.results ?? []))
  );
  Hooks.on(WEAPON_ATTACK_DAMAGE_RESOLVED_HOOK, runFixedAbilityRuntimeHandler(context => {
    void requestCurseAndBlessingAttackResolution(context);
  }));
  Hooks.on(WEAPON_ATTACK_RESOLVED_HOOK, runFixedAbilityRuntimeHandler(context => {
    void consumeAllOrNothingResultEffects(context);
    void consumeLethalAttackPreparationEffects(context);
    void processReaperAttackResolution(context);
    void updateVirtuosoLastWeapon(context);
    void processKeepAwayAttackResolution(context);
  }));
  Hooks.on(WEAPON_ATTACK_CHECK_RESOLVED_HOOK, runFixedAbilityRuntimeHandler(context => {
    void consumeVirtuosoAttackBonus(context);
  }));
  Hooks.on(WEAPON_ATTACK_DUPLICATE_REQUEST_HOOK, runFixedAbilityRuntimeHandler(context => {
    requestDoubleAttackDuplicate(context);
  }));
  Hooks.on(WEAPON_ACTION_MODIFIER_REQUEST_HOOK, runFixedAbilityRuntimeHandler(context => {
    requestAnatomyStudyWeaponActionModifiers(context);
    requestFullForceWeaponActionModifiers(context);
    requestVirtuosoWeaponActionModifiers(context);
    requestAimingWeaponActionModifiers(context);
    requestRicochetWeaponActionModifiers(context);
    requestKeepAwayWeaponActionModifiers(context);
    requestLethalAttackWeaponActionModifiers(context);
  }));
  Hooks.on("fallout-maw.weaponActionResolved", runFixedAbilityRuntimeHandler(context => {
    void processAtRandomAttackResolution(context);
  }));
  Hooks.on("fallout-maw.modifySkillCheck", runFixedAbilityRuntimeHandler(check => {
    applyFourLeafCloverCriticalBonus(check);
  }));
  Hooks.on("fallout-maw.skillCheckResolved", runFixedAbilityRuntimeHandler(outcome => {
    void updateFourLeafCloverCharges(outcome);
  }));
  Hooks.on(GRAPPLE_MODIFIER_HOOK, runFixedAbilityRuntimeHandler(state => {
    applyGrapplingMasterGrappleModifiers(state);
  }));
}

export function registerFixedAbilityFunctionSocket() {
  if (!fixedAbilitySocketLifecycleRegistered) {
    fixedAbilitySocketLifecycleRegistered = true;
    Hooks.on(`${SYSTEM_ID}.settingsPresetApplied`, ensureFixedAbilityFunctionSocket);
  }
  ensureFixedAbilityFunctionSocket();
}

function ensureFixedAbilityFunctionSocket() {
  if (fixedAbilitySocketRegistered || !areFixedAbilityFunctionsEnabled()) return;
  fixedAbilitySocketRegistered = true;
  game.socket.on(FIXED_ABILITY_SOCKET, runFixedAbilityRuntimeHandler(handleFixedAbilitySocketMessage));
}

export function getFixedAbilityFunctionDefinitions() {
  if (!areFixedAbilityFunctionsEnabled()) return [];
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
  if (!areFixedAbilityFunctionsEnabled()) return null;
  const definition = getFixedAbilityFunctionDefinition(fixedKey);
  return definition?.create?.() ?? null;
}

export function getFixedAbilityFunctionLabel(fixedKey = "") {
  return getFixedAbilityFunctionDefinition(fixedKey)?.label ?? String(fixedKey ?? "");
}

export function isFixedAbilityFunctionActive(abilityFunction = {}) {
  if (!areFixedAbilityFunctionsEnabled()) return false;
  if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.fixed) return false;
  return Boolean(getFixedAbilityFunctionDefinition(abilityFunction.fixedKey)?.active);
}

export function isActiveApplicationAbilityFunction(abilityFunction = {}) {
  return abilityFunction?.type === ABILITY_FUNCTION_TYPES.activeApplication;
}

export function isAttackActionAbilityFunction(abilityFunction = {}) {
  return abilityFunction?.type === ABILITY_FUNCTION_TYPES.attackAction;
}

export function isActiveAbilityFunction(abilityFunction = {}) {
  return isFixedAbilityFunctionActive(abilityFunction)
    || isActiveApplicationAbilityFunction(abilityFunction)
    || isAttackActionAbilityFunction(abilityFunction);
}

export function isFixedAbilityFunctionToggleable(abilityFunction = {}) {
  if (!areFixedAbilityFunctionsEnabled()) return false;
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

export function hasActiveAbilityFunction(item) {
  if (item?.type !== "ability") return false;
  return normalizeAbilityFunctions(item.system?.functions ?? []).some(isActiveAbilityFunction);
}

export function getFixedAbilityFunctionProgressEntries(abilityItem) {
  if (!areFixedAbilityFunctionsEnabled()) return [];
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
      if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso) {
        const stateKey = getFixedFunctionStateKey(entry);
        return {
          key: stateKey,
          label: "Последнее оружие",
          value: String(state[stateKey]?.weaponName ?? "").trim() || "Нету"
        };
      }
      if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.keepAway) {
        const stateKey = getFixedFunctionStateKey(entry);
        return {
          key: stateKey,
          label: "Следующий выстрел",
          value: state[stateKey]?.pending ? "Готов" : "Не подготовлен"
        };
      }
      if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.ricochet) {
        const stateKey = getFixedFunctionStateKey(entry);
        return {
          key: stateKey,
          label: "Следующий выстрел",
          value: state[stateKey]?.pending ? "Готов" : "Не подготовлен"
        };
      }
      if ([ABILITY_FIXED_FUNCTION_KEYS.lethalShot, ABILITY_FIXED_FUNCTION_KEYS.lethalStrike].includes(entry.fixedKey)) {
        return {
          key: getFixedFunctionStateKey(entry),
          label: "Следующая атака",
          value: findLethalAttackPreparationEffect(abilityItem.parent, abilityItem, entry) ? "Готова" : "Не подготовлена"
        };
      }
      if (entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy) {
        const knowledge = getAnatomyStudyFunctionState(abilityItem, entry);
        return {
          key: getFixedFunctionStateKey(entry),
          label: "Память",
          value: `${getAnatomyStudyMemoryUsage(knowledge)} / ${getAnatomyStudyMemoryCapacity(abilityItem.parent, entry.fixedSettings)}`
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

export function getFixedWeaponPreviewModifiers(actor, weapon, weaponData = {}) {
  const combatValues = { accuracy: 0, damagePercent: 0 };
  const resourceCostMultipliers = { condition: 1 };
  const sources = [];
  if (!areFixedAbilityFunctionsEnabled()) return { combatValues, resourceCostMultipliers, sources };
  const weaponName = String(weapon?.name ?? "").trim();
  const weaponSkillKey = String(weaponData?.skillKey ?? "").trim();
  if (!actor || !weaponName) return { combatValues, resourceCostMultipliers, sources };

  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      const stateKey = getFixedFunctionStateKey(abilityFunction);
      if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso) {
        const previousWeaponName = String(state[stateKey]?.weaponName ?? "").trim();
        if (previousWeaponName && previousWeaponName === weaponName) continue;
        const settings = normalizeVirtuosoSettings(abilityFunction.fixedSettings);
        combatValues.accuracy += settings.accuracyBonus;
        combatValues.damagePercent += settings.damagePercentBonus;
        sources.push({
          kind: "fixedAbility",
          itemId: String(abilityItem.id ?? ""),
          itemUuid: String(abilityItem.uuid ?? ""),
          name: String(abilityItem.name ?? ""),
          img: String(abilityItem.img ?? ""),
          functionId: String(abilityFunction.id ?? ""),
          combatValues: {
            accuracy: settings.accuracyBonus,
            damagePercent: settings.damagePercentBonus
          },
          resourceCostMultipliers: {}
        });
        continue;
      }
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.fullForce) continue;
      if (!state[stateKey]?.active) continue;
      const settings = normalizeFullForceSettings(abilityFunction.fixedSettings);
      if (!weaponSkillKey || weaponSkillKey !== settings.requiredSkillKey) continue;
      combatValues.damagePercent += settings.damagePercentBonus;
      resourceCostMultipliers.condition *= settings.conditionCostMultiplier;
      sources.push({
        kind: "fixedAbility",
        itemId: String(abilityItem.id ?? ""),
        itemUuid: String(abilityItem.uuid ?? ""),
        name: String(abilityItem.name ?? ""),
        img: String(abilityItem.img ?? ""),
        functionId: String(abilityFunction.id ?? ""),
        combatValues: { damagePercent: settings.damagePercentBonus },
        resourceCostMultipliers: { condition: settings.conditionCostMultiplier }
      });
    }
  }

  return { combatValues, resourceCostMultipliers, sources };
}

export function getActorTwoHandsEntry(actor) {
  if (!areFixedAbilityFunctionsEnabled()) return null;
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.twoHands) continue;
      if (!state[getFixedFunctionStateKey(abilityFunction)]?.active) continue;
      const settings = normalizeTwoHandsSettings(abilityFunction.fixedSettings);
      return {
        abilityItem,
        abilityFunction,
        settings,
        label: getAbilityDisplayName(abilityItem),
        energyCost: getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost)
      };
    }
  }
  return null;
}

export function hasActorTwoHandsActive(actor) {
  return Boolean(getActorTwoHandsEntry(actor));
}

export function canSpendActorTwoHandsEnergy(actor, entry = getActorTwoHandsEntry(actor)) {
  const cost = Math.max(0, toInteger(entry?.energyCost ?? 0));
  if (hasEnergy(actor, cost)) return true;
  ui.notifications.warn(`${entry?.label ?? "С двух рук"}: недостаточно энергии (${getActorEnergy(actor)} / ${cost}).`);
  return false;
}

export async function spendActorTwoHandsEnergy(actor, entry = getActorTwoHandsEntry(actor)) {
  if (!entry?.abilityItem || !entry?.abilityFunction) return false;
  const cost = Math.max(0, toInteger(entry.energyCost));
  if (!hasEnergy(actor, cost)) {
    await deactivateFixedAbilityFunction(entry.abilityItem, entry.abilityFunction);
    await createAbilityChatMessage(actor, entry.abilityItem, `Выключено: недостаточно энергии (${getActorEnergy(actor)} / ${cost}).`);
    return false;
  }
  return spendEnergy(actor, cost);
}

export async function useFixedAbilityFunctionItem({
  actor = null,
  item = null,
  application = null,
  functionId = "",
  onInteractionCancelled = null
} = {}) {
  if (!areFixedAbilityFunctionsEnabled()) return false;
  if (isReactionSystemLocked()) {
    ui.notifications.warn("Ожидание реакций: способность временно заблокирована.");
    return false;
  }
  if (!actor?.isOwner || item?.type !== "ability") return false;
  const abilityFunction = normalizeAbilityFunctions(item.system?.functions ?? [])
    .find(entry => isFixedAbilityFunctionActive(entry) && (!functionId || entry.id === functionId));
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

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.twoHands) {
    await toggleTwoHands(actor, item, abilityFunction);
    await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.aiming) {
    await toggleAiming(actor, item, abilityFunction);
    await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.keepAway) {
    const used = await useKeepAway(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.oversight) {
    const used = await useOversight(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.watchOut) {
    const used = await configureWatchOut(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.fullControl) {
    const used = await useFullControl(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.ricochet) {
    const used = await useRicochet(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.commandBasics) {
    const used = await useCommandBasics(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance) {
    const used = await useKnockOffBalance(actor, item, abilityFunction, { onInteractionCancelled });
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.look) {
    const used = await useLook(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.toTheEnd) {
    const used = await useToTheEnd(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.heightenedConcentration) {
    const used = await useHeightenedConcentration(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.anatomyStudy) {
    const used = await useAnatomyStudy(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.specialMix) {
    const used = await useSpecialMix(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if ([ABILITY_FIXED_FUNCTION_KEYS.lethalShot, ABILITY_FIXED_FUNCTION_KEYS.lethalStrike].includes(abilityFunction.fixedKey)) {
    const used = await useLethalAttack(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  ui.notifications.warn("Фиксированная функция пока не имеет обработчика применения.");
  return true;
}

async function useSpecialMix(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeSpecialMixSettings(abilityFunction.fixedSettings);
  const medicines = (actor.items?.contents ?? [])
    .filter(isSpecialMixMedicineEligible)
    .sort((left, right) => String(left.name).localeCompare(String(right.name), "ru"));
  if (medicines.length < 2 || !hasDistinctSpecialMixPair(medicines)) {
    ui.notifications.warn(`${abilityName}: нужны два разных доступных препарата.`);
    return false;
  }

  const selectedIds = await promptSpecialMixMedicines(abilityName, medicines, settings);
  if (!Array.isArray(selectedIds) || selectedIds.length !== 2) return false;
  const [firstItem, secondItem] = selectedIds.map(id => actor.items.get(String(id)));
  if (
    !isSpecialMixMedicineEligible(firstItem)
    || !isSpecialMixMedicineEligible(secondItem)
    || !areDistinctSpecialMixMedicines(firstItem, secondItem)
  ) {
    ui.notifications.warn(`${abilityName}: выбранные препараты уже недоступны или совпадают.`);
    return false;
  }

  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  if (!canSpendCombatActionPoints(actor, settings.actionPointCost, { label: "особого намеса" })) return false;

  let inventoryPlan;
  try {
    inventoryPlan = prepareSpecialMixInventoryPlan(actor, firstItem, secondItem, abilityItem, settings);
  } catch (error) {
    console.error(`${SYSTEM_ID} | Failed to prepare special mix`, error);
    ui.notifications.warn(`${abilityName}: ${formatSpecialMixInventoryError(error)}`);
    return false;
  }

  if (!(await spendEnergy(actor, energyCost))) return false;
  const actionPointTransaction = settings.actionPointCost > 0
    ? await spendCombatActionPointsWithReceipt(actor, settings.actionPointCost, {
      suppressResourceNotification: true,
      label: "особого намеса"
    })
    : { spent: 0, receipt: null };
  if (isActorInActiveCombat(actor) && actionPointTransaction.spent !== settings.actionPointCost) {
    await refundEnergy(actor, energyCost);
    ui.notifications.warn(`${abilityName}: не удалось потратить ${settings.actionPointCost} ОД.`);
    return false;
  }

  let mutation;
  try {
    mutation = await executeInventoryMutation({ actor, ...inventoryPlan }, {
      reason: "special-mix",
      render: true
    });
  } catch (error) {
    await Promise.allSettled([
      refundEnergy(actor, energyCost),
      refundCombatActionPointReceipt(actor, actionPointTransaction.receipt, { label: "особого намеса" })
    ]);
    console.error(`${SYSTEM_ID} | Failed to create special mix`, error);
    ui.notifications.error(`${abilityName}: не удалось создать препарат; энергия и ОД возвращены.`);
    return false;
  }

  if (actionPointTransaction.spent > 0 && actionPointTransaction.receipt?.resourceKey) {
    await notifyCombatResourcesSpent(actor, {
      [actionPointTransaction.receipt.resourceKey]: actionPointTransaction.spent
    }, { label: "особого намеса" });
  }

  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.overloadEnergyCost,
    durationSeconds: settings.overloadDurationSeconds
  });
  const createdItem = mutation.createdDocuments?.[0];
  await createAbilityChatMessage(
    actor,
    abilityItem,
    `Создан «${createdItem?.name ?? inventoryPlan.creates[0].name}»: 1/1 заряд, срок годности ${formatDuration(settings.spoilDurationSeconds)}.`
  );
  return true;
}

function hasDistinctSpecialMixPair(medicines) {
  for (let index = 0; index < medicines.length - 1; index += 1) {
    if (medicines.slice(index + 1).some(item => areDistinctSpecialMixMedicines(medicines[index], item))) return true;
  }
  return false;
}

async function promptSpecialMixMedicines(abilityName, medicines, settings) {
  const labels = getSpecialMixDetailLabels();
  const medicineById = new Map(medicines.map(item => [String(item.id), item]));
  const rows = medicines.map(item => {
    const details = getSpecialMixMedicineDetails(item, labels);
    return `
    <label class="fallout-maw-special-mix-card" data-special-mix-card data-special-mix-identity="${escapeAttribute(String(item.name ?? "").trim().toLocaleLowerCase("ru-RU"))}">
      <input type="checkbox" name="medicineIds" value="${escapeAttribute(item.id)}">
      <img src="${escapeAttribute(item.img)}" alt="">
      <span class="fallout-maw-special-mix-card-content">
        <span class="fallout-maw-special-mix-card-heading">
          <strong>${escapeHTML(item.name)}</strong>
          <small>${escapeHTML(details.durationLabel)} · ${escapeHTML(details.chargesLabel)}</small>
        </span>
        ${buildSpecialMixDetailRows(details.rows, "Нет числовых эффектов")}
      </span>
    </label>
  `;
  }).join("");
  const result = await DialogV2.input({
    modal: true,
    window: { title: `${abilityName}: смешивание` },
    content: `
      <div class="fallout-maw-special-mix-dialog">
        <header>
          <p>Выберите ровно два разных препарата. Будет потрачено по одному заряду каждого.</p>
          <strong data-special-mix-counter>Выбрано: 0 / 2</strong>
        </header>
        <div class="fallout-maw-special-mix-workspace">
          <div class="fallout-maw-special-mix-list">${rows}</div>
          <section class="fallout-maw-special-mix-preview" data-special-mix-preview>
            <strong>Итоговый препарат</strong>
            <span>Выберите два препарата — здесь сразу появятся записываемые в предмет значения.</span>
          </section>
        </div>
        <footer><span>Итог эффектов: сумма +${settings.effectivenessPercentBonus}%</span><span>Длительность: целое среднее +${settings.durationPercentBonus}%</span><span>Срок годности ${escapeHTML(formatDuration(settings.spoilDurationSeconds))}</span></footer>
      </div>
    `,
    render: (_event, dialog) => bindSpecialMixSelection(
      dialog.element?.querySelector?.("form") ?? dialog.element,
      { medicineById, settings, labels }
    ),
    ok: {
      label: "Смешать",
      icon: "fa-solid fa-flask-vial",
      callback: (_event, button) => {
        const selected = [...button.form.querySelectorAll("input[name='medicineIds']:checked")];
        if (selected.length !== 2) {
          ui.notifications.warn("Выберите ровно два препарата.");
          return "cancel";
        }
        return selected.map(input => String(input.value));
      }
    },
    buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
    position: { width: 1060 },
    rejectClose: false
  });
  return Array.isArray(result) ? result : null;
}

function bindSpecialMixSelection(form, { medicineById, settings, labels }) {
  if (!form) return;
  const inputs = [...form.querySelectorAll("input[name='medicineIds']")];
  const counter = form.querySelector("[data-special-mix-counter]");
  const preview = form.querySelector("[data-special-mix-preview]");
  const sync = changed => {
    let selected = inputs.filter(input => input.checked);
    if (selected.length > 2 && changed) {
      changed.checked = false;
      selected = inputs.filter(input => input.checked);
    }
    const selectedNames = new Set(selected.map(input => input.closest("[data-special-mix-card]")?.dataset.specialMixIdentity));
    for (const input of inputs) {
      const card = input.closest("[data-special-mix-card]");
      card?.classList.toggle("selected", input.checked);
      const name = card?.dataset.specialMixIdentity;
      input.disabled = !input.checked && (selected.length >= 2 || selectedNames.has(name));
    }
    if (counter) counter.textContent = `Выбрано: ${selected.length} / 2`;
    if (preview) updateSpecialMixPreview(preview, selected, medicineById, settings, labels);
  };
  for (const input of inputs) input.addEventListener("change", () => sync(input));
  sync(null);
}

function updateSpecialMixPreview(preview, selected, medicineById, settings, labels) {
  if (selected.length !== 2) {
    preview.innerHTML = `
      <strong>Итоговый препарат</strong>
      <span>Выберите два препарата — здесь сразу появятся записываемые в предмет значения.</span>
    `;
    return;
  }
  const first = medicineById.get(String(selected[0].value));
  const second = medicineById.get(String(selected[1].value));
  if (!first || !second) return;
  const firstAid = getSpecialMixFirstAidDetails(
    mergeSpecialMixFirstAid(first.system.functions.firstAid, second.system.functions.firstAid, settings),
    labels
  );
  preview.innerHTML = `
    <span class="fallout-maw-special-mix-preview-heading">
      <strong>Итоговый препарат</strong>
      <small>${escapeHTML(firstAid.durationLabel)} · ${escapeHTML(firstAid.chargesLabel)}</small>
    </span>
    ${buildSpecialMixDetailRows(firstAid.rows, "Нет числовых эффектов")}
  `;
}

function buildSpecialMixDetailRows(rows, emptyText) {
  if (!rows.length) return `<small class="fallout-maw-special-mix-empty">${escapeHTML(emptyText)}</small>`;
  return `<ul class="fallout-maw-special-mix-effects">${rows.map(row => `
    ${row.kind === "section"
      ? `<li class="fallout-maw-special-mix-effect-section"><strong>${escapeHTML(row.label)}</strong></li>`
      : `<li><span>${escapeHTML(row.label)}</span><b>${escapeHTML(row.value)}</b></li>`}
  `).join("")}</ul>`;
}

function getSpecialMixDetailLabels() {
  return {
    pathLabels: new Map(buildEffectKeyTokens({ includePeriodicHealing: true })
      .filter(token => token?.path)
      .map(token => [token.path, token.label || token.path])),
    needLabels: new Map(getNeedSettings().map(need => [need.key, need.label || need.key])),
    damageTypeLabels: new Map(getDamageTypeSettings().map(type => [type.key, type.label || type.key]))
  };
}

function prepareSpecialMixInventoryPlan(actor, firstItem, secondItem, abilityItem, settings) {
  const consumptions = [firstItem, secondItem].map(item => planInventoryItemConsumption({
    item,
    amount: 1,
    charges: getFirstAidChargesData(item),
    chargePath: "system.functions.firstAid.charges.value"
  }));
  const updates = consumptions.flatMap(plan => plan.updates);
  const deletes = consumptions.flatMap(plan => plan.deletes);
  const projectedItems = projectActorInventoryState(actor, { updates, deletes });
  const createData = buildSpecialMixItemData({
    firstItem,
    secondItem,
    abilityItem,
    settings,
    startTime: Number(game.time?.worldTime) || 0
  });
  const commonParentId = getItemContainerParentId(firstItem) === getItemContainerParentId(secondItem)
    ? getItemContainerParentId(firstItem)
    : ROOT_CONTAINER_ID;
  const parentIds = [...new Set([commonParentId, ROOT_CONTAINER_ID])];
  let destination = null;

  for (const parentId of parentIds) {
    const context = getSpecialMixInventoryContext(actor, projectedItems, parentId);
    if (!context) continue;
    const placement = findFirstAvailableResolvedInventoryPlacement(
      getContextInventoryItems(parentId, projectedItems),
      context.columns,
      context.rows,
      createData,
      projectedItems,
      [],
      [],
      context.options
    );
    if (placement) {
      destination = { parentId, placement };
      break;
    }
  }
  if (!destination) {
    const error = new Error("No inventory space for the mixed medicine.");
    error.code = "inventory-no-space";
    throw error;
  }
  createData.system.container.parentId = destination.parentId;
  createData.system.placement = createStoredPlacement(destination.placement, createData);
  return { updates, deletes, creates: [createData] };
}

function getSpecialMixInventoryContext(actor, projectedItems, parentId) {
  if (parentId) {
    const container = projectedItems.find(item => String(item?._id ?? item?.id ?? "") === String(parentId));
    if (!container) return null;
    const options = getContainerInventoryGridOptions(container);
    return { columns: options.columns, rows: options.rows, options };
  }
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId) ?? null;
  const dimensions = getActorInventoryGridDimensions(actor, race);
  return {
    columns: dimensions.columns,
    rows: dimensions.rows,
    options: getActorRootInventoryGridOptions(actor, ROOT_CONTAINER_ID)
  };
}

function formatSpecialMixInventoryError(error) {
  if (error?.code === "inventory-no-space" || error?.code === "actor-load-limit") {
    return "в инвентаре недостаточно места или грузоподъёмности для нового препарата.";
  }
  return "не удалось подготовить смешивание выбранных препаратов.";
}

async function useAnatomyStudy(actor, abilityItem, abilityFunction) {
  const settings = normalizeAnatomyStudySettings(abilityFunction.fixedSettings);
  openAnatomyStudyApplication({
    actor,
    abilityItem,
    abilityFunction,
    sourceToken: getActorSceneToken(actor),
    getActivationState: () => ({
      energyCost: getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost),
      actionPointCost: settings.actionPointCost,
      overloadEnergyCost: settings.overloadEnergyCost,
      overloadDurationLabel: formatDuration(settings.overloadDurationSeconds)
    }),
    onResearch: selection => completeAnatomyStudyResearch(actor, abilityItem, abilityFunction, selection),
    onForget: selection => forgetAnatomyStudyKnowledge(actor, abilityItem, abilityFunction, selection)
  });
  return true;
}

async function completeAnatomyStudyResearch(actor, abilityItem, abilityFunction, {
  targetActor = null,
  raceId = "",
  bonusKey = ""
} = {}) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const targetRaceId = getActorRaceId(targetActor);
  if (!actor?.isOwner || abilityItem?.parent?.uuid !== actor.uuid) return false;
  if (!isActorDeadForAnatomyStudy(targetActor)) {
    ui.notifications.warn(`${abilityName}: выбранная цель больше не мертва.`);
    return false;
  }
  if (!targetRaceId || targetRaceId !== String(raceId ?? "").trim()) {
    ui.notifications.warn(`${abilityName}: раса выбранной цели изменилась или не указана.`);
    return false;
  }

  const pendingUpdate = buildAnatomyStudyKnowledgeUpdate({
    abilityItem,
    abilityFunction,
    actor,
    raceId: targetRaceId,
    bonusKey
  });
  if (!pendingUpdate.ok) {
    ui.notifications.warn(`${abilityName}: ${pendingUpdate.reason}`);
    return false;
  }

  const settings = normalizeAnatomyStudySettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  if (!canSpendCombatActionPoints(actor, settings.actionPointCost, { label: "изучения анатомии" })) return false;
  if (!(await spendEnergy(actor, energyCost))) return false;
  if (settings.actionPointCost > 0) await spendCombatActionPoints(actor, settings.actionPointCost);
  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.overloadEnergyCost,
    durationSeconds: settings.overloadDurationSeconds
  });
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, pendingUpdate.state);

  const bonus = getAnatomyStudyBonusDefinitions(settings).find(entry => entry.key === bonusKey);
  const race = getCreatureOptions().races.find(entry => entry.id === targetRaceId);
  const raceName = race?.label ?? race?.name ?? targetRaceId;
  await createAbilityChatMessage(
    actor,
    abilityItem,
    `${raceName}: изучено «${bonus?.label ?? bonusKey}» (${bonus?.valueLabel ?? ""}).`
  );
  return true;
}

async function forgetAnatomyStudyKnowledge(actor, abilityItem, abilityFunction, {
  raceId = "",
  bonusKey = ""
} = {}) {
  if (!actor?.isOwner || abilityItem?.parent?.uuid !== actor.uuid) return false;
  const update = buildAnatomyStudyKnowledgeUpdate({
    abilityItem,
    abilityFunction,
    actor,
    raceId,
    bonusKey,
    remove: true
  });
  if (!update.ok) {
    ui.notifications.warn(`${getAbilityDisplayName(abilityItem)}: ${update.reason}`);
    return false;
  }
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, update.state);
  return true;
}

async function useHeightenedConcentration(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeHeightenedConcentrationSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (hasActiveHeightenedConcentrationEffect(actor, abilityItem, abilityFunction)) {
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
  await applyHeightenedConcentrationEffect(actor, abilityItem, abilityFunction, settings);
  await createAbilityChatMessage(actor, abilityItem, `Следующие проверки: ${settings.checkCount}.`);
  return true;
}

async function useCommandBasics(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.warn(`${abilityName}: сцена не готова.`);
    return false;
  }

  const settings = normalizeCommandBasicsSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }

  const limit = Math.max(1, Math.floor(evaluateActorFormula(settings.targetLimitFormula, actor, {
    fallback: 2,
    minimum: 1,
    context: "command basics target limit"
  })));
  const command = await requestCommandBasicsChoice({ abilityName, commander: actor, limit });
  if (!command) return false;

  const selection = await selectCommandBasicsTargets({
    commander: actor,
    command,
    limit,
    abilityName
  });
  if (!selection?.length) return false;

  if (command === "duck") {
    if (!game.user?.isGM && !getResponsibleGM()) {
      ui.notifications.warn(`${abilityName}: нет активного GM для выполнения команды.`);
      return false;
    }
    if (!(await spendEnergy(actor, energyCost))) return false;
    await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
      name: getAbilityOverloadName(abilityItem),
      energyCost: settings.overloadEnergyCost,
      durationSeconds: settings.overloadDurationSeconds
    });
    const dodgeBonus = Math.max(0, Math.floor(evaluateActorFormula(settings.dodgeBonusFormula, actor, {
      fallback: 10,
      minimum: 0,
      context: "command basics dodge bonus"
    })));
    const applied = await requestCommandBasicsDodgeOperation({
      actorUuid: actor.uuid,
      abilityItemId: abilityItem.id,
      abilityFunctionId: abilityFunction.id,
      targetActorUuids: selection.map(entry => entry.token?.actor?.uuid).filter(Boolean),
      dodgeBonus,
      durationSeconds: settings.dodgeDurationSeconds,
      senderUserId: game.user?.id ?? ""
    });
    if (!applied) return false;
    await createAbilityChatMessage(actor, abilityItem, `Ложись: ${selection.length} целей, +${dodgeBonus} к уклонению на ${formatDuration(settings.dodgeDurationSeconds)}.`);
    return true;
  }

  const attacks = selection
    .map(entry => entry.attack)
    .filter(Boolean);
  if (!attacks.length) return false;
  if (!game.user?.isGM && !getResponsibleGM()) {
    ui.notifications.warn(`${abilityName}: нет активного GM для выполнения команды.`);
    return false;
  }
  const controller = startCommandedWeaponAttacks({
    attacks,
    label: `${abilityName}: ${getCommandBasicsCommandLabel(command)}`,
    onBeforeExecute: async () => {
      if (!(await spendEnergy(actor, energyCost))) return false;
      await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
        name: getAbilityOverloadName(abilityItem),
        energyCost: settings.overloadEnergyCost,
        durationSeconds: settings.overloadDurationSeconds
      });
      await createAbilityChatMessage(actor, abilityItem, `${getCommandBasicsCommandLabel(command)}: ${attacks.length} исполнителей.`);
      return true;
    }
  });
  if (!controller) {
    ui.notifications.warn(`${abilityName}: не удалось начать командную атаку.`);
    return false;
  }
  return true;
}

async function requestCommandBasicsChoice({ abilityName = "Основы командования", commander = null, limit = 1 } = {}) {
  const rows = ["shoot", "strike", "duck"].map(command => {
    const available = collectCommandBasicsTargetRows(commander, command).filter(row => row.selectable).length;
    return {
      command,
      label: getCommandBasicsCommandLabel(command),
      available,
      selectable: available > 0,
      checked: false
    };
  });
  const firstSelectable = rows.find(row => row.selectable);
  if (firstSelectable) firstSelectable.checked = true;

  const content = `
    <fieldset class="form-group stacked">
      ${rows.map(row => `
        <label class="checkbox">
          <input type="radio" name="command" value="${escapeAttribute(row.command)}" ${row.checked ? "checked" : ""} ${row.selectable ? "" : "disabled"}>
          ${escapeHTML(row.label)} (${Math.min(row.available, limit)})
        </label>
      `).join("")}
    </fieldset>
  `;
  const result = await DialogV2.input({
    window: { title: abilityName },
    content,
    ok: {
      label: "Выбрать",
      icon: "fa-solid fa-check",
      callback: (_event, button) => String(button.form?.querySelector?.("input[name='command']:checked")?.value ?? "")
    },
    buttons: [{
      action: "cancel",
      label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
    }],
    rejectClose: false,
    modal: true,
    position: { width: 420 }
  });
  return ["shoot", "strike", "duck"].includes(result) ? result : "";
}

function selectCommandBasicsTargets({ commander = null, command = "", limit = 1, abilityName = "Основы командования" } = {}) {
  const collectRows = () => collectCommandBasicsTargetRows(commander, command);
  const sourceToken = getActorSceneToken(commander);
  return requestCustomTokenSelection({
    rows: collectRows(),
    limit,
    title: abilityName,
    noneWarning: `${abilityName}: нет подходящих исполнителей.`,
    instructions: `${abilityName}: выберите до ${limit} целей. ЛКМ на последней цели сразу подтверждает, Enter тоже, ПКМ снимает последнюю цель, Esc отменяет.`,
    sourceToken,
    refreshRows: collectRows
  });
}

export async function useAbilityFunctionItem({
  actor = null,
  item = null,
  token = null,
  application = null,
  functionId = "",
  chainRef = null,
  options = {},
  source = {},
  onInteractionCancelled = null
} = {}) {
  if (isReactionSystemLocked()) {
    ui.notifications.warn("Ожидание реакций: способность временно заблокирована.");
    return false;
  }
  if (!actor?.isOwner || item?.type !== "ability") return false;
  const abilityFunction = normalizeAbilityFunctions(item.system?.functions ?? [])
    .find(entry => isActiveAbilityFunction(entry) && (!functionId || entry.id === functionId));
  if (!abilityFunction) return false;
  const inheritedChainRef = chainRef
    ?? options?.falloutMawSystemEventChainRef
    ?? options?.chainRef
    ?? source?.chainRef
    ?? null;
  const operationId = String(options?.operationId ?? source?.operationId ?? "").trim() || foundry.utils.randomID();
  const activationOccurrenceId = String(options?.occurrenceId ?? source?.occurrenceId ?? "").trim() || foundry.utils.randomID();
  const requestedToken = token?.object ?? token ?? options?.token?.object ?? options?.token ?? source?.token?.object ?? source?.token ?? null;
  const sourceToken = requestedToken?.actor?.uuid === actor?.uuid
    ? requestedToken
    : getPrimaryActorToken(actor);
  const sourceParticipant = createAbilityEventParticipant(actor, sourceToken, item);

  return withSystemEventRoot({
    kind: "abilityUse",
    operationId: `ability-use:${operationId}`,
    sceneUuid: String((sourceToken?.document ?? sourceToken)?.parent?.uuid ?? canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: inheritedChainRef
  }, async scope => {
    if (isActiveApplicationAbilityFunction(abilityFunction)) {
      return useActiveApplicationAbilityFunction(scope, actor, item, abilityFunction, {
        application,
        sourceParticipant,
        sourceToken,
        occurrenceId: activationOccurrenceId,
        onInteractionCancelled
      });
    }
    const workflow = await runTerminalSystemEventWorkflow({
      scope,
      beforeEventKey: "fallout-maw.ability.use.before",
      resolvedEventKey: "fallout-maw.ability.use.resolved",
      occurrenceBase: `ability-use:${scope.rootId}:${activationOccurrenceId}:${item.id}:${abilityFunction.id}`,
      participants: { source: sourceParticipant, target: null, related: [] },
      beforeData: buildAbilityUseEventData(actor, item, abilityFunction),
      resolvedData: ({ status }) => ({
        ...buildAbilityUseEventData(actor, item, abilityFunction),
        status
      }),
      operation: () => isAttackActionAbilityFunction(abilityFunction)
        ? startAbilityAttackActionAndWait({
          token: sourceToken,
          item,
          functionId: abilityFunction.id,
          chainRef: scope.chainRef,
          onInteractionCancelled
        })
        : useFixedAbilityFunctionItem({
          actor,
          item,
          application,
          functionId: abilityFunction.id,
          onInteractionCancelled
        })
    });
    return workflow.success && Boolean(workflow.value);
  });
}

async function useActiveApplicationAbilityFunction(scope, actor, abilityItem, abilityFunction, {
  application = null,
  sourceParticipant = null,
  sourceToken = null,
  occurrenceId = "activation",
  onInteractionCancelled = null
} = {}) {
  const settings = normalizeActiveApplicationSettings(abilityFunction.activeSettings);
  const activationCosts = settings.costs;
  const sourceActivationCosts = activationCosts.filter(cost => (
    cost.payer === ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source
  ));
  const durationSeconds = getAbilityFunctionEffectDurationSeconds(abilityFunction);
  const occurrenceBase = `ability-use:${scope.rootId}:${occurrenceId}:${abilityItem.id}:${abilityFunction.id}`;
  const sourceEventParticipant = sourceParticipant
    ?? createAbilityEventParticipant(actor, sourceToken ?? getPrimaryActorToken(actor), abilityItem);
  const paymentContext = {
    rootId: scope.rootId,
    chainRef: scope.chainRef,
    occurrenceId: `active-application:${occurrenceId}:${abilityItem.id}:${abilityFunction.id}`
  };
  // Re-configuration application ("Изменить рекомендации"): re-pick a persistent
  // selectedChanges subset and store it without applying effects to targets.
  const selectedChangesRef = findSelectedChangesConditionRef(abilityItem);
  if (selectedChangesRef) {
    return useSelectedChangesApplication(scope, actor, abilityItem, abilityFunction, selectedChangesRef, {
      application,
      sourceEventParticipant,
      occurrenceBase,
      paymentContext,
      activationCosts: sourceActivationCosts,
      onInteractionCancelled
    });
  }
  if (activeApplicationFunctionHasRuntimeAura(abilityFunction) && durationSeconds <= 0) {
    ui.notifications.warn("Для ауры активного применения задайте длительность больше 0 секунд.");
    await runTerminalSystemEventWorkflow({
      scope,
      resolvedEventKey: "fallout-maw.ability.use.resolved",
      occurrenceBase,
      participants: { source: sourceEventParticipant, target: null, related: [] },
      resolvedData: ({ status }) => ({
        ...buildAbilityUseEventData(actor, abilityItem, abilityFunction, {
          activationCosts,
          durationSeconds,
          targetCount: 0
        }),
        status
      }),
      forcedResult: {
        status: "failed",
        reason: "auraDurationRequired",
        value: false
      }
    });
    return false;
  }
  let costPreflight;
  try {
    costPreflight = await quoteAbilityFunctionResourceCosts({
      actor,
      sourceItem: abilityItem,
      abilityFunction,
      costRows: sourceActivationCosts,
      context: paymentContext
    });
  } catch (error) {
    console.error("Fallout MaW | Active application cost preflight failed", error);
    costPreflight = { ok: false, reason: "spendFailed", error };
  }
  if (!costPreflight.ok) {
    notifyAbilityTriggerCostFailure(costPreflight);
    await runTerminalSystemEventWorkflow({
      scope,
      resolvedEventKey: "fallout-maw.ability.use.resolved",
      occurrenceBase,
      participants: { source: sourceEventParticipant, target: null, related: [] },
      resolvedData: ({ status }) => ({
        ...buildAbilityUseEventData(actor, abilityItem, abilityFunction, {
          activationCosts,
          durationSeconds,
          targetCount: 0
        }),
        status
      }),
      forcedResult: { status: "failed", reason: "resourcePreflightFailed", value: false }
    });
    return false;
  }
  let targets;
  try {
    targets = await resolveActiveApplicationTargets(actor, abilityItem, abilityFunction, settings, sourceToken);
  } catch (error) {
    await runTerminalSystemEventWorkflow({
      scope,
      resolvedEventKey: "fallout-maw.ability.use.resolved",
      occurrenceBase,
      participants: {
        source: sourceEventParticipant,
        target: null,
        related: []
      },
      resolvedData: ({ status }) => ({
        ...buildAbilityUseEventData(actor, abilityItem, abilityFunction, { activationCosts, durationSeconds, targetCount: 0 }),
        status
      }),
      forcedResult: { status: "error", reason: "targetSelectionError", value: false, error }
    });
    return false;
  }
  const participants = {
    source: sourceEventParticipant,
    target: null,
    related: createActiveApplicationRelatedParticipants(targets)
  };
  if (!targets.length) {
    await runTerminalSystemEventWorkflow({
      scope,
      resolvedEventKey: "fallout-maw.ability.use.resolved",
      occurrenceBase,
      participants,
      resolvedData: ({ status }) => ({
        ...buildAbilityUseEventData(actor, abilityItem, abilityFunction, { activationCosts, durationSeconds, targetCount: 0 }),
        status
      }),
      forcedResult: { status: "cancelled", reason: "targetSelectionCancelled", value: false }
    });
    notifyAbilityInteractionCancelled(onInteractionCancelled, {
      reason: "targetSelectionCancelled"
    });
    return false;
  }

  const workflow = await runTerminalSystemEventWorkflow({
    scope,
    beforeEventKey: "fallout-maw.ability.use.before",
    resolvedEventKey: "fallout-maw.ability.use.resolved",
    occurrenceBase,
    participants,
    beforeData: buildAbilityUseEventData(actor, abilityItem, abilityFunction, {
      activationCosts,
      durationSeconds,
      targetCount: targets.length
    }),
    resolvedData: ({ value, status }) => ({
      ...buildAbilityUseEventData(actor, abilityItem, abilityFunction, {
        activationCosts,
        durationSeconds,
        targetCount: targets.length,
        appliedCount: Math.max(0, toInteger(value?.appliedCount))
      }),
      status
    }),
    operation: () => executeActiveApplicationUse(scope, {
      actor,
      abilityItem,
      abilityFunction,
      settings,
      activationCosts,
      durationSeconds,
      targets,
      sourceToken,
      occurrenceId
    }),
    isSuccess: value => Boolean(value?.used),
    getResultStatus: value => value?.cancelled ? "cancelled" : (value?.used ? "success" : "failed"),
    getResultReason: value => String(value?.reason ?? "")
  });
  const used = workflow.success && Boolean(workflow.value?.used);
  if (workflow.cancelled || workflow.value?.cancelled) {
    notifyAbilityInteractionCancelled(onInteractionCancelled, {
      reason: workflow.reason || workflow.value?.reason || "cancelled"
    });
  }
  if (used) await application?.render?.({ force: true });
  return used;
}

function findSelectedChangesConditionRef(abilityItem = null) {
  const functions = abilityItem?.system?.functions ?? [];
  for (let functionIndex = 0; functionIndex < functions.length; functionIndex += 1) {
    const conditions = Array.isArray(functions[functionIndex]?.conditions)
      ? functions[functionIndex].conditions
      : [];
    for (let conditionIndex = 0; conditionIndex < conditions.length; conditionIndex += 1) {
      if (conditions[conditionIndex]?.type === ABILITY_CONDITION_TYPES.selectedChanges) {
        return { functionIndex, conditionIndex, condition: conditions[conditionIndex] };
      }
    }
  }
  return null;
}

async function useSelectedChangesApplication(scope, actor, abilityItem, abilityFunction, selectionRef, {
  application = null,
  sourceEventParticipant = null,
  occurrenceBase = "",
  paymentContext = {},
  activationCosts = [],
  onInteractionCancelled = null
} = {}) {
  const emitTerminal = (data, { status, reason = "", value = false } = {}) => (
    runTerminalSystemEventWorkflow({
      scope,
      resolvedEventKey: "fallout-maw.ability.use.resolved",
      occurrenceBase,
      participants: { source: sourceEventParticipant, target: null, related: [] },
      resolvedData: ({ status: resolvedStatus }) => ({
        ...buildAbilityUseEventData(actor, abilityItem, abilityFunction, {
          activationCosts,
          targetCount: 0,
          ...data
        }),
        status: resolvedStatus
      }),
      forcedResult: { status, reason, value }
    })
  );

  // 1. Re-pick the subset of the active-application function's changes.
  let selection;
  try {
    selection = await resolveLimitedChangeSet({
      changes: abilityFunction?.changes ?? [],
      conditions: [selectionRef.condition],
      actor,
      evaluateLimit: formula => evaluateActorFormula(formula, actor, {
        fallback: 1,
        minimum: 1,
        context: "selected changes limit"
      }),
      choose: ({ changes, selectionIds, limit, actor: evaluationActor }) => requestLimitedChangeSelection({
        abilityName: getAbilityDisplayName(abilityItem),
        changes,
        selectionIds,
        limit,
        evaluationActors: [evaluationActor]
      })
    });
  } catch (error) {
    console.warn("Fallout MaW | Selected-changes application failed", error);
    await emitTerminal({}, { status: "failed", reason: "changeSelectionFailed" });
    return false;
  }
  if (selection.cancelled) {
    await emitTerminal({}, { status: "cancelled", reason: "changeSelectionCancelled" });
    notifyAbilityInteractionCancelled(onInteractionCancelled, { reason: "changeSelectionCancelled" });
    return false;
  }
  if (!selection.changes.length) {
    await emitTerminal({}, { status: "failed", reason: "noSelectableChanges" });
    return false;
  }

  // 2. Pay the activation cost.
  let costPreflight;
  try {
    costPreflight = await quoteAbilityFunctionResourceCosts({
      actor,
      sourceItem: abilityItem,
      abilityFunction,
      costRows: activationCosts,
      context: paymentContext
    });
  } catch (error) {
    console.error("Fallout MaW | Selected-changes cost preflight failed", error);
    costPreflight = { ok: false, reason: "spendFailed", error };
  }
  if (!costPreflight.ok) {
    notifyAbilityTriggerCostFailure(costPreflight);
    await emitTerminal({}, { status: "failed", reason: "resourcePreflightFailed" });
    return false;
  }
  const payment = await payAbilityFunctionResourceCosts({
    actor,
    sourceItem: abilityItem,
    abilityFunction,
    costRows: activationCosts,
    expectedFingerprint: String(costPreflight?.fingerprint ?? ""),
    context: paymentContext
  });
  if (!payment.ok) {
    notifyAbilityTriggerCostFailure(payment);
    await emitTerminal({}, { status: "failed", reason: "resourceSpendFailed" });
    return false;
  }

  // 3. Persist the selected change keys on the selectedChanges condition.
  const selectedKeys = selection.changes
    .map(change => String(change?.key ?? "").trim())
    .filter(Boolean);
  try {
    const functions = foundry.utils.deepClone(abilityItem.system?.functions ?? []);
    const conditions = Array.isArray(functions[selectionRef.functionIndex]?.conditions)
      ? functions[selectionRef.functionIndex].conditions
      : [];
    if (conditions[selectionRef.conditionIndex]) {
      conditions[selectionRef.conditionIndex] = {
        ...conditions[selectionRef.conditionIndex],
        selectedKeys
      };
    }
    await abilityItem.update({ "system.functions": functions }, scope.chainRef ? { chainRef: scope.chainRef } : {});
    console.warn("fallout-maw | selectedChanges stored", JSON.stringify({ selectedKeys, functionIndex: selectionRef.functionIndex, conditionIndex: selectionRef.conditionIndex, after: abilityItem.system?.functions?.[selectionRef.functionIndex]?.conditions?.[selectionRef.conditionIndex]?.selectedKeys }));
  } catch (error) {
    console.error("Fallout MaW | Failed to persist selected changes", error);
    await emitTerminal({}, { status: "failed", reason: "selectionPersistFailed" });
    return false;
  }

  await emitTerminal({}, { status: "success", value: true });
  await application?.render?.({ force: true });
  return true;
}

function notifyAbilityInteractionCancelled(callback, context = {}) {
  if (typeof callback !== "function") return false;
  try {
    callback(context);
    return true;
  } catch (error) {
    console.error("Fallout MaW | Ability interaction cancellation callback failed", error);
    return false;
  }
}

async function executeActiveApplicationUse(scope, {
  actor,
  abilityItem,
  abilityFunction,
  settings,
  activationCosts = [],
  durationSeconds = 0,
  targets = [],
  sourceToken = null,
  occurrenceId = "activation"
} = {}) {
  const createsApplicationEffect = durationSeconds > 0 || settings.persistent;
  const hasItemMutations = hasActiveApplicationItemMutations(settings);
  const hasApplicationOperation = createsApplicationEffect || hasItemMutations;
  const { allowed, terminalTargets } = await gateActiveApplicationTargets(scope, {
    actor,
    abilityItem,
    abilityFunction,
    settings,
    activationCosts,
    durationSeconds,
    targets,
    sourceToken,
    occurrenceId
  });
  if (!allowed.length) return { used: false, appliedCount: 0, cancelled: true, reason: "applicationCancelled" };

  let costPlanQuote;
  try {
    costPlanQuote = await quoteActiveApplicationCostPlan({
      sourceActor: actor,
      abilityItem,
      abilityFunction,
      activationCosts,
      targets: allowed.map(entry => entry.target),
      context: {
        rootId: scope.rootId,
        chainRef: scope.chainRef,
        occurrenceId: `active-application:${occurrenceId}:${abilityItem.id}:${abilityFunction.id}`
      }
    });
  } catch (error) {
    console.error("Fallout MaW | Active application payer preflight failed", error);
    costPlanQuote = { ok: false, reason: "spendFailed", error };
  }
  if (!costPlanQuote.ok) {
    notifyActiveApplicationCostPlanFailure(costPlanQuote, abilityItem);
    for (const entry of allowed) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "failed",
        reason: "resourcePreflightFailed",
        terminalTargets
      });
    }
    return { used: false, appliedCount: 0, cancelled: false, reason: "resourcePreflightFailed" };
  }

  const hasLimitedChanges = (abilityFunction?.conditions ?? [])
    .some(condition => condition?.type === ABILITY_CONDITION_TYPES.limitedChanges);
  let changeSelection;
  try {
    changeSelection = await resolveLimitedChangeSet({
      changes: abilityFunction?.changes ?? [],
      conditions: abilityFunction?.conditions ?? [],
      actor,
      evaluateLimit: formula => evaluateActorFormula(formula, actor, {
        fallback: 1,
        minimum: 1,
        context: "active application change limit"
      }),
      choose: ({ changes, selectionIds, limit, actor: sourceActor }) => requestLimitedChangeSelection({
        abilityName: getAbilityDisplayName(abilityItem),
        changes,
        selectionIds,
        limit,
        evaluationActors: settings.changeEvaluation === "source"
          ? [sourceActor]
          : allowed.map(entry => entry.target?.actor).filter(Boolean)
      })
    });
  } catch (error) {
    console.warn("Fallout MaW | Active application change selection failed", error);
    changeSelection = { changes: [], ids: [], cancelled: false, failed: true };
  }
  if (changeSelection.failed) {
    for (const entry of allowed) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "failed",
        reason: "changeSelectionFailed",
        terminalTargets
      });
    }
    return { used: false, appliedCount: 0, cancelled: false, reason: "changeSelectionFailed" };
  }
  if (hasLimitedChanges && !changeSelection.cancelled && !changeSelection.changes.length) {
    for (const entry of allowed) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "failed",
        reason: "noSelectableChanges",
        terminalTargets
      });
    }
    return { used: false, appliedCount: 0, cancelled: false, reason: "noSelectableChanges" };
  }
  if (changeSelection.cancelled) {
    for (const entry of allowed) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "cancelled",
        reason: "changeSelectionCancelled",
        terminalTargets
      });
    }
    return { used: false, appliedCount: 0, cancelled: true, reason: "changeSelectionCancelled" };
  }
  const requiresRemoteEffectAuthority = hasApplicationOperation
    && allowed.some(entry => !entry.target?.actor?.isOwner);
  const requiresRemoteTrialAuthority = abilityFunctionHasTrialConsequences(abilityFunction)
    && allowed.some(entry => !entry.target?.actor?.isOwner);
  const requiresRemoteCostAuthority = costPlanQuote.entries
    .some(entry => !entry.actor?.isOwner);
  const requiresRemoteAuthority = !game.user?.isGM
    && (requiresRemoteEffectAuthority || requiresRemoteTrialAuthority || requiresRemoteCostAuthority);
  const remoteAuthority = requiresRemoteAuthority
    ? getActiveApplicationAuthorityGM({
      actorUuid: actor?.uuid ?? "",
      sourceTokenUuid: String((sourceToken?.document ?? sourceToken)?.uuid ?? ""),
      abilityItemId: abilityItem?.id ?? "",
      abilityFunctionId: abilityFunction?.id ?? "",
      targetTokenUuids: allowed
        .map(entry => String((entry.target?.token?.document ?? entry.target?.token)?.uuid ?? ""))
        .filter(Boolean)
    })
    : null;
  if (
    requiresRemoteAuthority
    && !remoteAuthority
  ) {
    ui.notifications.warn(`${getAbilityDisplayName(abilityItem)}: нет активного GM для применения эффекта к чужим актёрам.`);
    for (const entry of allowed) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "failed",
        reason: "missingAuthority",
        terminalTargets
      });
    }
    return { used: false, appliedCount: 0, reason: "missingAuthority" };
  }

  const preparedActions = await prepareAbilityFunctionActions({
    actor,
    abilityItem,
    abilityFunction,
    triggerTargets: allowed.map(entry => entry.target),
    title: getAbilityDisplayName(abilityItem),
    sourceToken,
    resourceReservations: costPlanQuote.resourceReservations
  });
  if (preparedActions.failed) {
    const reason = preparedActions.reason || "actionPreparationFailed";
    for (const entry of allowed) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "failed",
        reason,
        terminalTargets
      });
    }
    return { used: false, appliedCount: 0, cancelled: false, reason };
  }
  if (preparedActions.cancelled) {
    for (const entry of allowed) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "cancelled",
        reason: "actionSelectionCancelled",
        terminalTargets
      });
    }
    return { used: false, appliedCount: 0, cancelled: true, reason: "actionSelectionCancelled" };
  }

  const paymentContext = {
    rootId: scope.rootId,
    chainRef: scope.chainRef,
    occurrenceId: `active-application:${occurrenceId}:${abilityItem.id}:${abilityFunction.id}`
  };
  let commitPromise = null;
  let commitFailureReason = "";
  let commitError = null;
  let committedPayment = null;
  const commitApplication = async () => {
    commitPromise ??= (async () => {
      try {
        if (requiresRemoteAuthority) {
          const effectsApplied = await applyActiveApplicationEffects(actor, abilityItem, abilityFunction, durationSeconds, allowed.map(entry => entry.target), {
            chainRef: scope.chainRef,
            sourceToken,
            selectedChanges: changeSelection.changes,
            payCostsRemotely: true,
            costContext: paymentContext,
            costFingerprints: costPlanQuote.fingerprints
          });
          if (!effectsApplied) {
            commitFailureReason = "authorityOperationFailed";
            ui.notifications.warn(`${getAbilityDisplayName(abilityItem)}: операция GM не подтверждена; при задержке ответа не запускайте её повторно.`);
            return false;
          }
          return true;
        }

        const payment = await payActiveApplicationCostPlan({
          entries: costPlanQuote.entries,
          abilityItem,
          abilityFunction,
          expectedFingerprints: costPlanQuote.fingerprints,
          context: paymentContext
        });
        if (!payment.ok) {
          commitFailureReason = "resourceSpendFailed";
          notifyActiveApplicationCostPlanFailure(payment, abilityItem);
          return false;
        }
        committedPayment = payment;
        if (hasApplicationOperation) {
          try {
            const effectsApplied = await applyActiveApplicationEffects(actor, abilityItem, abilityFunction, durationSeconds, allowed.map(entry => entry.target), {
              chainRef: scope.chainRef,
              sourceToken,
              selectedChanges: changeSelection.changes,
              costContext: paymentContext
            });
            if (!effectsApplied) throw new Error("Active application effects could not be created.");
          } catch (error) {
            await rollbackActiveApplicationPaymentPlan({
              abilityItem,
              abilityFunction,
              paymentPlan: payment,
              chainRef: scope.chainRef
            });
            throw error;
          }
        }
        return true;
      } catch (error) {
        commitError = error;
        return false;
      }
    })();
    return commitPromise;
  };
  try {
    const actionResult = await executePreparedAbilityFunctionActions({
      actor,
      abilityItem,
      abilityFunction,
      sourceToken,
      executions: preparedActions.executions,
      chainRef: scope.chainRef,
      onBeforeFirstExecute: commitApplication
    });
    if (commitError) throw commitError;
    if (actionResult.cancelled && !actionResult.committed) {
      for (const entry of allowed) {
        await emitActiveApplicationResolved(scope, entry, {
          actor,
          abilityItem,
          abilityFunction,
          settings,
          activationCosts,
          durationSeconds,
          status: "cancelled",
          reason: "actionExecutionCancelled",
          terminalTargets
        });
      }
      return { used: false, appliedCount: 0, cancelled: true, reason: "actionExecutionCancelled" };
    }
    if (commitFailureReason) {
      for (const entry of allowed) {
        await emitActiveApplicationResolved(scope, entry, {
          actor,
          abilityItem,
          abilityFunction,
          settings,
          activationCosts,
          durationSeconds,
          status: "failed",
          reason: commitFailureReason,
          terminalTargets
        });
      }
      return { used: false, appliedCount: 0, reason: commitFailureReason };
    }
    if (actionResult.executed !== actionResult.attempted) {
      if (
        actionResult.committed
        && actionResult.attempted > 0
        && actionResult.executed === 0
        && !hasApplicationOperation
        && committedPayment?.ok
      ) {
        await rollbackActiveApplicationPaymentPlan({
          abilityItem,
          abilityFunction,
          paymentPlan: committedPayment,
          chainRef: scope.chainRef
        });
      }
      for (const entry of allowed) {
        await emitActiveApplicationResolved(scope, entry, {
          actor,
          abilityItem,
          abilityFunction,
          settings,
          activationCosts,
          durationSeconds,
          status: "failed",
          reason: "actionFailed",
          terminalTargets
        });
      }
      return { used: false, appliedCount: actionResult.executed, reason: "actionFailed" };
    }
    const trialsAreDrivenByAura = activeApplicationFunctionHasTriggerAura(abilityFunction);
    if (!trialsAreDrivenByAura && !requiresRemoteAuthority) {
      await executeAbilityTrials({
        abilityFunction: {
          ...abilityFunction,
          changes: changeSelection.changes
        },
        constructs: normalizeAbilityConstructs(abilityItem.system?.constructs),
        sourceActor: actor,
        sourceToken,
        targets: allowed.map(entry => entry.target),
        sourceItemUuid: String(abilityItem.uuid ?? ""),
        title: getAbilityDisplayName(abilityItem),
        operationId: `${scope.rootId}:${paymentContext.occurrenceId}`
      });
    }
    await createAbilityChatMessage(actor, abilityItem, "Применено.");
    for (const entry of allowed) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "success",
        reason: "resolved",
        terminalTargets
      });
    }
    return { used: true, appliedCount: allowed.length };
  } catch (error) {
    for (const entry of allowed) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "error",
        reason: "error",
        error,
        terminalTargets
      });
    }
    throw error;
  }
}

async function gateActiveApplicationTargets(scope, {
  actor,
  abilityItem,
  abilityFunction,
  settings,
  activationCosts = [],
  durationSeconds = 0,
  targets = [],
  sourceToken = null,
  occurrenceId = "activation"
} = {}) {
  const allowed = [];
  const terminalTargets = new Set();
  let cancelRemaining = false;
  for (const [index, target] of targets.entries()) {
    const entry = {
      target,
      sourceToken,
      index,
      occurrenceBase: `ability-application:${scope.rootId}:${occurrenceId}:${abilityItem.id}:${abilityFunction.id}:${index}:${target.actor?.uuid ?? "target"}`
    };
    if (cancelRemaining) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "cancelled",
        reason: "cancelRemaining",
        terminalTargets
      });
      continue;
    }
    if (
      (durationSeconds > 0 || settings.persistent)
      && (
        !abilityFunctionRoutesPrimaryChangesThroughTrials(abilityFunction)
        || activeApplicationFunctionHasRuntimeAura(abilityFunction)
      )
      && !activeApplicationTargetsHaveEffectCopyCapacity(actor, abilityItem, abilityFunction, [target])
    ) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "cancelled",
        reason: "effectCopyLimitReached",
        terminalTargets
      });
      continue;
    }
    const participants = createActiveApplicationParticipants(actor, abilityItem, target, sourceToken);
    const gate = await scope.emit("fallout-maw.ability.application.before", {
      data: buildActiveApplicationEventData({
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        target,
        index
      })
    }, {
      occurrenceKey: `${entry.occurrenceBase}:before`,
      participants
    });
    if (isSystemEventCancelled(gate)) {
      await emitActiveApplicationResolved(scope, entry, {
        actor,
        abilityItem,
        abilityFunction,
        settings,
        activationCosts,
        durationSeconds,
        status: "cancelled",
        reason: getSystemEventCancellationReason(gate) || "cancelled",
        terminalTargets
      });
      if (gate?.control?.remaining || gate?.control?.root) cancelRemaining = true;
      continue;
    }
    allowed.push(entry);
  }
  return { allowed, terminalTargets };
}

async function emitActiveApplicationResolved(scope, entry, {
  actor,
  abilityItem,
  abilityFunction,
  settings,
  activationCosts = [],
  durationSeconds = 0,
  status = "failed",
  reason = "failed",
  error = null,
  terminalTargets = new Set()
} = {}) {
  const terminalKey = entry?.occurrenceBase;
  if (!terminalKey || terminalTargets.has(terminalKey)) return;
  terminalTargets.add(terminalKey);
  const target = entry.target;
  await scope.emit("fallout-maw.ability.application.resolved", {
    data: buildActiveApplicationEventData({
      actor,
      abilityItem,
      abilityFunction,
      settings,
      activationCosts,
      durationSeconds,
      target,
      index: entry.index
    }),
    outcome: {
      success: status === "success",
      cancelled: status === "cancelled",
      failed: status === "failed" || status === "error",
      status,
      ...(error ? { error: serializeSystemWorkflowError(error) } : {})
    },
    reason
  }, {
    occurrenceKey: `${entry.occurrenceBase}:resolved`,
    participants: createActiveApplicationParticipants(actor, abilityItem, target, entry?.sourceToken)
  });
}

function buildAbilityUseEventData(actor, abilityItem, abilityFunction, extra = {}) {
  return {
    actorUuid: String(actor?.uuid ?? ""),
    abilityItemUuid: String(abilityItem?.uuid ?? ""),
    abilityItemId: String(abilityItem?.id ?? ""),
    abilityName: String(getAbilityDisplayName(abilityItem)),
    functionId: String(abilityFunction?.id ?? ""),
    functionType: String(abilityFunction?.type ?? ""),
    fixedKey: String(abilityFunction?.fixedKey ?? ""),
    ...extra
  };
}

function buildActiveApplicationEventData({
  actor,
  abilityItem,
  abilityFunction,
  settings,
  activationCosts = [],
  durationSeconds = 0,
  target = null,
  index = 0
} = {}) {
  return {
    ...buildAbilityUseEventData(actor, abilityItem, abilityFunction),
    targetIndex: Math.max(0, toInteger(index)),
    targetActorUuid: String(target?.actor?.uuid ?? ""),
    targetTokenUuid: String((target?.token?.document ?? target?.token)?.uuid ?? ""),
    activationCosts: (Array.isArray(activationCosts) ? activationCosts : Object.values(activationCosts ?? {})).map(row => ({
      id: String(row?.id ?? ""),
      resourceKey: String(row?.resourceKey ?? ""),
      formula: String(row?.formula ?? "0"),
      payer: row?.payer === ABILITY_ACTIVE_APPLICATION_COST_PAYERS.targets
        ? ABILITY_ACTIVE_APPLICATION_COST_PAYERS.targets
        : ABILITY_ACTIVE_APPLICATION_COST_PAYERS.source,
      overloadAmount: Math.max(0, toInteger(row?.overloadAmount)),
      overloadDurationSeconds: Math.max(0, toInteger(row?.overloadDurationSeconds))
    })),
    durationSeconds: Math.max(0, toInteger(durationSeconds))
  };
}

function createActiveApplicationParticipants(actor, abilityItem, target = null, sourceToken = null) {
  return {
    source: createAbilityEventParticipant(actor, sourceToken ?? getPrimaryActorToken(actor), abilityItem),
    target: createAbilityEventParticipant(target?.actor, target?.token),
    related: []
  };
}

function createAbilityEventParticipant(actor = null, token = null, item = null) {
  const tokenDocument = token?.document ?? token ?? null;
  const participant = {
    actorUuid: String(actor?.uuid ?? tokenDocument?.actor?.uuid ?? "").trim(),
    tokenUuid: String(tokenDocument?.uuid ?? "").trim(),
    itemUuid: String(item?.uuid ?? "").trim()
  };
  return Object.values(participant).some(Boolean) ? participant : null;
}

function createActiveApplicationRelatedParticipants(targets = []) {
  const related = [];
  const seen = new Set();
  for (const target of targets) {
    const participant = createAbilityEventParticipant(target?.actor, target?.token);
    if (!participant) continue;
    const key = `${participant.actorUuid}:${participant.tokenUuid}:${participant.itemUuid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    related.push(participant);
  }
  return related;
}

function createAbilitySystemEventOptions(chainRef = null) {
  return chainRef
    ? { chainRef, falloutMawSystemEventChainRef: chainRef }
    : {};
}

async function resolveActiveApplicationTargets(actor, abilityItem, abilityFunction, settings, sourceToken = null) {
  const sourcePlaceable = sourceToken?.object ?? sourceToken ?? getPrimaryActorToken(actor);
  if (settings.targetMode !== "others") {
    const availability = getAbilityTargetExecutorAvailability(actor, abilityFunction, sourcePlaceable);
    if (!availability.available) {
      ui.notifications.warn(`${getAbilityDisplayName(abilityItem)}: ${availability.reason}.`);
      return [];
    }
    return [{ actor, token: sourcePlaceable, selected: true }];
  }
  const collectRows = () => collectActiveApplicationTargetRows(
    actor,
    abilityFunction,
    settings,
    sourcePlaceable
  );
  const rows = collectRows();
  if (settings.targetSelectionMode === "all") {
    const seen = new Set();
    const targets = rows
      .filter(row => row.selectable)
      .map(row => ({ actor: row.token.actor, token: row.token }))
      .filter(row => {
        const actorUuid = String(row.actor?.uuid ?? "").trim();
        if (!actorUuid || seen.has(actorUuid)) return false;
        seen.add(actorUuid);
        return true;
      });
    if (!targets.length) {
      ui.notifications.warn(`${getAbilityDisplayName(abilityItem)}: нет подходящих целей.`);
    }
    return targets;
  }
  const targetLimit = evaluateActiveApplicationTargetLimit(settings, actor);
  const selection = await requestCustomTokenSelection({
    rows,
    limit: targetLimit,
    title: getAbilityDisplayName(abilityItem),
    noneWarning: `${getAbilityDisplayName(abilityItem)}: нет подходящих целей.`,
    instructions: `${getAbilityDisplayName(abilityItem)}: выберите до ${targetLimit} целей. ЛКМ на последней цели сразу подтверждает, Enter тоже, ПКМ снимает последнюю цель, Esc отменяет.`,
    sourceToken: sourcePlaceable,
    refreshRows: collectRows,
    getRowId: row => String(row?.token?.document?.uuid ?? row?.token?.uuid ?? row?.token?.id ?? row?.actorUuid ?? "")
  });
  const seen = new Set();
  return selection
    .map(row => ({ actor: row.token.actor, token: row.token }))
    .filter(row => {
      const actorUuid = String(row.actor?.uuid ?? "").trim();
      if (!actorUuid || seen.has(actorUuid)) return false;
      seen.add(actorUuid);
      return true;
    });
}

function evaluateActiveApplicationTargetLimit(settings = {}, actor = null) {
  return Math.max(1, Math.floor(evaluateActorFormula(settings?.targetLimit, actor, {
    fallback: 1,
    minimum: 1,
    context: "active application target limit"
  })));
}

function collectActiveApplicationTargetRows(sourceActor, abilityFunction, settings, sourceToken = null) {
  const accepted = new Set(settings.targetGroups ?? []);
  const radiusFormula = String(settings?.radiusFormula ?? "").trim();
  const radiusMeters = radiusFormula
    ? Math.max(0, evaluateActorFormula(radiusFormula, sourceActor, {
      fallback: 0,
      minimum: 0,
      context: "active application radius"
    }))
    : null;
  const sourcePlaceable = sourceToken?.object ?? sourceToken ?? null;
  return (canvas?.tokens?.placeables ?? [])
    .filter(token => token?.actor && token.visible !== false && token.renderable !== false)
    .map(token => {
      const isSelf = token.actor.uuid === sourceActor?.uuid;
      const relation = getActiveApplicationTargetRelation(sourceActor, token.actor);
      const relationAllowed = accepted.has(relation);
      const selfAllowed = !settings.excludeSelf || !isSelf;
      const distanceAllowed = radiusMeters === null
        ? true
        : Boolean(sourcePlaceable) && (isSelf || measureActiveApplicationTokenDistance(sourcePlaceable, token) <= radiusMeters);
      const lineOfSightAllowed = !settings.wallsBlock
        || isSelf
        || (Boolean(sourcePlaceable) && hasActiveApplicationLineOfSight(sourcePlaceable, token));
      const executorAvailability = getAbilityTargetExecutorAvailability(token.actor, abilityFunction, token);
      const selectable = relationAllowed
        && selfAllowed
        && distanceAllowed
        && lineOfSightAllowed
        && executorAvailability.available;
      let reason = "";
      if (!selfAllowed) reason = "активатор исключён";
      else if (!relationAllowed) reason = "тип цели не подходит";
      else if (!distanceAllowed) reason = sourcePlaceable ? "вне радиуса" : "нет токена активатора";
      else if (!lineOfSightAllowed) reason = "цель закрыта стеной";
      else if (!executorAvailability.available) reason = executorAvailability.reason;
      return {
        token,
        actorUuid: token.actor.uuid,
        selectable,
        reason
      };
    });
}

function getActiveApplicationTargetRelation(sourceActor, targetActor) {
  if (!sourceActor || !targetActor) return "neutral";
  if (sourceActor.uuid === targetActor.uuid) return "ally";
  return getSharedAbilityTargetRelation(sourceActor, targetActor);
}

function getPrimaryActorToken(actor) {
  return canvas?.tokens?.placeables?.find(token => token?.actor?.uuid === actor?.uuid) ?? actor?.getActiveTokens?.()?.[0] ?? null;
}

function activeApplicationTargetsHaveEffectCopyCapacity(sourceActor, abilityItem, abilityFunction, targets = []) {
  return targets.every(target => hasLimitedEffectCopyCapacity({
    recipientActor: target?.actor,
    sourceActor,
    sourceItem: abilityItem,
    abilityFunction
  }, getActiveApplicationEffectCopyOptions(sourceActor)));
}

function getActiveApplicationEffectCopyOptions(sourceActor) {
  return {
    evaluateLimit: formula => evaluateActorFormula(formula, sourceActor, {
      fallback: 1,
      minimum: 1,
      context: "active application effect copy limit"
    })
  };
}

async function applyActiveApplicationEffects(sourceActor, abilityItem, abilityFunction, durationSeconds, targets = [], options = {}) {
  const requiresAuthority = !game.user?.isGM && targets.some(target => !target?.actor?.isOwner);
  if (!requiresAuthority) {
    return applyActiveApplicationEffectsDirect(sourceActor, abilityItem, abilityFunction, durationSeconds, targets, options);
  }
  const sourceTokenDocument = options?.sourceToken?.document ?? options?.sourceToken ?? null;
  const targetTokenUuids = targets
    .map(target => String((target?.token?.document ?? target?.token)?.uuid ?? "").trim())
    .filter(Boolean);
  if (!sourceTokenDocument?.uuid || targetTokenUuids.length !== targets.length) return false;
  return requestActiveApplicationEffectOperation({
    actorUuid: sourceActor?.uuid ?? "",
    sourceTokenUuid: sourceTokenDocument?.uuid ?? "",
    abilityItemId: abilityItem?.id ?? "",
    abilityFunctionId: abilityFunction?.id ?? "",
    chainRef: options?.chainRef ?? null,
    authorityOperationId: [
      String(options?.costContext?.rootId ?? "").trim(),
      String(options?.costContext?.occurrenceId ?? "").trim()
    ].filter(Boolean).join(":"),
    payCostsRemotely: options?.payCostsRemotely === true,
    costContext: {
      rootId: String(options?.costContext?.rootId ?? "").trim(),
      occurrenceId: String(options?.costContext?.occurrenceId ?? "").trim(),
      chainRef: options?.costContext?.chainRef ?? options?.chainRef ?? null
    },
    costFingerprints: Object.fromEntries(Object.entries(options?.costFingerprints ?? {})
      .map(([actorUuid, fingerprint]) => [String(actorUuid), String(fingerprint)])),
    targetTokenUuids,
    selectedChangeIds: (options?.selectedChanges ?? [])
      .map(change => String(change?.id ?? "").trim())
      .filter(Boolean)
  });
}

async function applyActiveApplicationEffectsDirect(sourceActor, abilityItem, abilityFunction, durationSeconds, targets = [], {
  chainRef = null,
  sourceToken = null,
  selectedChanges = null,
  costContext = null
} = {}) {
  const settings = normalizeActiveApplicationSettings(abilityFunction?.activeSettings);
  const hasItemMutations = hasActiveApplicationItemMutations(settings);
  const createsApplicationEffect = durationSeconds > 0 || settings.persistent;
  if (!createsApplicationEffect && !hasItemMutations) return true;
  const startTime = Number(game.time?.worldTime) || 0;
  const selectedFunction = Array.isArray(selectedChanges)
    ? { ...abilityFunction, changes: selectedChanges }
    : abilityFunction;
  const storedFunction = prepareActiveApplicationAuraFunctionData(selectedFunction, {
    changeEvaluation: settings.changeEvaluation,
    prepareChange: change => prepareEffectChangeForApplication(sourceActor, change)
  });
  const routesPrimaryChanges = abilityFunctionRoutesPrimaryChangesThroughTrials(selectedFunction)
    || activeApplicationFunctionHasDistributionAura(selectedFunction);
  const chanceOperationId = [
    String(costContext?.rootId ?? chainRef?.rootId ?? "").trim(),
    String(costContext?.occurrenceId ?? "").trim()
  ].filter(Boolean).join(":") || `active-application:${String(sourceActor?.uuid ?? "")}:${String(
    abilityItem?.id ?? ""
  )}:${String(abilityFunction?.id ?? "")}:${startTime}`;
  const plans = targets
    .filter(target => target?.actor)
    .map(target => ({
      target,
      rawChanges: routesPrimaryChanges
        ? []
        : getActiveApplicationEffectChanges(
          sourceActor,
          abilityItem,
          selectedFunction,
          target,
          sourceToken,
          chanceOperationId
        )
          .filter(change => change?.key && String(change?.value ?? "") !== "")
    }));
  if (settings.changeEvaluation === "source") {
    const snapshots = new Map();
    for (const plan of plans) {
      const rawSignature = JSON.stringify(plan.rawChanges);
      if (!snapshots.has(rawSignature)) {
        snapshots.set(rawSignature, plan.rawChanges
          .map(change => prepareEffectChangeForApplication(sourceActor, change))
          .filter(change => change.key && change.value !== ""));
      }
      plan.preparedChanges = foundry.utils.deepClone(snapshots.get(rawSignature));
    }
  }
  for (const plan of plans) {
    const targetActor = plan.target.actor;
    plan.changes = settings.changeEvaluation === "source"
      ? plan.preparedChanges
      : plan.rawChanges
        .map(change => prepareEffectChangeForApplication(targetActor, change))
        .filter(change => change.key && change.value !== "");
  }
  const createsRuntimeAuraEffect = activeApplicationFunctionHasRuntimeAura(abilityFunction);
  const effectPlans = createsApplicationEffect
    ? plans.filter(plan => plan.changes?.length || createsRuntimeAuraEffect)
    : [];
  if (
    effectPlans.length
    && !activeApplicationTargetsHaveEffectCopyCapacity(sourceActor, abilityItem, abilityFunction, targets)
  ) {
    throw new Error("Active application effect copy limit reached.");
  }
  const effectCopyOptions = getActiveApplicationEffectCopyOptions(sourceActor);
  const effectCopyFlag = buildLimitedEffectCopyFlag({
    sourceActor,
    sourceItem: abilityItem,
    abilityFunction
  }, effectCopyOptions);
  const reservations = [];
  // The Active Effect is also the runtime document for executing auras. An
  // aura-only application therefore still reserves a copy and creates an
  // effect even when it has no ordinary change rows.
  for (const plan of effectPlans) {
    const reservation = reserveLimitedEffectCopySlot({
      recipientActor: plan.target.actor,
      sourceActor,
      sourceItem: abilityItem,
      abilityFunction
    }, effectCopyOptions);
    if (!reservation.allowed) {
      reservations.forEach(releaseLimitedEffectCopyReservation);
      throw new Error("Active application effect copy limit reached.");
    }
    reservations.push(reservation);
  }
  const createdEffects = [];
  const itemMutationResults = [];
  try {
    for (const plan of effectPlans) {
      const target = plan.target;
      const targetActor = target.actor;
      const changes = plan.changes;
      const signature = JSON.stringify(changes);
      const created = await targetActor.createEmbeddedDocuments("ActiveEffect", [{
        type: "base",
        name: getAbilityDisplayName(abilityItem),
        img: abilityItem.img || "icons/svg/aura.svg",
        origin: abilityItem.uuid,
        transfer: false,
        disabled: false,
        showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
        start: { time: startTime },
        ...(durationSeconds > 0 ? {
          duration: { value: durationSeconds, units: "seconds", expiry: null, expired: false }
        } : {}),
        system: { changes },
        flags: {
          [SYSTEM_ID]: {
            kind: durationSeconds > 0 ? "temporary" : "active",
            [EFFECT_LIFECYCLE_FLAG_KEY]: {
              kind: EFFECT_LIFECYCLE_KINDS.disposableInstance
            },
            [ACTIVE_APPLICATION_EFFECT_FLAG_KEY]: {
              abilityItemId: abilityItem.id,
              abilitySourceId: getAbilitySourceId(abilityItem),
              sourceItemUuid: String(abilityItem?.uuid ?? ""),
              sourceActorUuid: sourceActor.uuid,
              sourceTokenUuid: String((sourceToken?.document ?? sourceToken)?.uuid ?? ""),
              targetTokenUuid: String((target?.token?.document ?? target?.token)?.uuid ?? ""),
              functionData: foundry.utils.deepClone(storedFunction),
              constructData: foundry.utils.deepClone(abilityItem.system?.constructs ?? []),
              signature,
              changeEvaluation: settings.changeEvaluation,
              changeSnapshot: settings.changeEvaluation === "source"
                ? foundry.utils.deepClone(changes)
                : null,
              functionId: abilityFunction.id,
              chanceOperationId,
              createdAt: startTime
            },
            ...(effectCopyFlag ? {
              [LIMITED_EFFECT_COPY_FLAG_KEY]: effectCopyFlag
            } : {})
          }
        }
      }], {
        animate: false,
        ...createAbilitySystemEventOptions(chainRef)
      });
      createdEffects.push(...(created ?? []));
    }
    if (hasItemMutations) {
      const actors = new Map(targets
        .filter(target => target?.actor)
        .map(target => [String(target.actor.uuid ?? target.actor.id), target.actor]));
      for (const targetActor of actors.values()) {
        itemMutationResults.push(await applyActiveApplicationItemMutations(
          targetActor,
          settings,
          createAbilitySystemEventOptions(chainRef)
        ));
      }
    }
  } catch (error) {
    await rollbackActiveApplicationItemMutations(itemMutationResults);
    await deleteActiveApplicationEffectsSafely(createdEffects, chainRef);
    throw error;
  } finally {
    reservations.forEach(releaseLimitedEffectCopyReservation);
  }
  return true;
}

async function deleteActiveApplicationEffectsSafely(effects = [], chainRef = null) {
  for (const effect of [...effects].reverse()) {
    try {
      await effect?.delete?.({
        animate: false,
        ...createAbilitySystemEventOptions(chainRef)
      });
    } catch (error) {
      console.error("Fallout MaW | Failed to roll back a partial active application effect", error);
    }
  }
}

function getActorEffectIdSet(actor = null) {
  return new Set(Array.from(actor?.effects ?? [])
    .map(effect => String(effect?.id ?? "").trim())
    .filter(Boolean));
}

async function quoteActiveApplicationCostPlan({
  sourceActor = null,
  abilityItem = null,
  abilityFunction = null,
  activationCosts = [],
  targets = [],
  context = {}
} = {}) {
  const entries = buildActiveApplicationCostPlanEntries(sourceActor, activationCosts, targets);
  const fingerprints = {};
  const resourceReservations = new Map();
  for (const entry of entries) {
    const result = await quoteAbilityFunctionResourceCosts({
      actor: entry.actor,
      sourceItem: abilityItem,
      abilityFunction,
      costRows: entry.costRows,
      context
    });
    if (!result.ok) return { ...result, actor: entry.actor, entries, fingerprints, resourceReservations };
    const actorUuid = String(entry.actor?.uuid ?? "").trim();
    fingerprints[actorUuid] = String(result.fingerprint ?? "");
    resourceReservations.set(actorUuid, Object.fromEntries((result.quote?.costs ?? [])
      .map(cost => [
        String(cost?.resourceKey ?? "").trim(),
        Math.max(0, toInteger(cost?.amount))
      ])
      .filter(([resourceKey, amount]) => resourceKey && amount > 0)));
  }
  return { ok: true, entries, fingerprints, resourceReservations };
}

async function payActiveApplicationCostPlan({
  entries = [],
  abilityItem = null,
  abilityFunction = null,
  expectedFingerprints = {},
  context = {}
} = {}) {
  const payments = [];
  for (const entry of entries ?? []) {
    const actor = entry?.actor ?? null;
    const actorUuid = String(actor?.uuid ?? "").trim();
    if (!actorUuid || !Object.hasOwn(expectedFingerprints ?? {}, actorUuid)) {
      await rollbackActiveApplicationPaymentPlan({
        abilityItem,
        abilityFunction,
        paymentPlan: { ok: true, payments },
        chainRef: context?.chainRef ?? null
      });
      return { ok: false, reason: "staleQuote", actor, payments: [] };
    }
    const previousEffectIds = getActorEffectIdSet(actor);
    const payment = await payAbilityFunctionResourceCosts({
      actor,
      sourceItem: abilityItem,
      abilityFunction,
      costRows: entry?.costRows ?? [],
      expectedFingerprint: String(expectedFingerprints?.[actorUuid] ?? ""),
      context
    });
    if (!payment.ok) {
      await rollbackActiveApplicationPaymentPlan({
        abilityItem,
        abilityFunction,
        paymentPlan: { ok: true, payments },
        chainRef: context?.chainRef ?? null
      });
      return { ...payment, actor, payments: [] };
    }
    payments.push({ actor, payment, previousEffectIds });
  }
  return { ok: true, payments };
}

async function rollbackActiveApplicationPaymentPlan({
  abilityItem = null,
  abilityFunction = null,
  paymentPlan = null,
  chainRef = null
} = {}) {
  if (!paymentPlan?.ok) return false;
  let complete = true;
  for (const entry of [...(paymentPlan.payments ?? [])].reverse()) {
    const rolledBack = await rollbackActiveApplicationPayment({
      actor: entry?.actor,
      abilityItem,
      abilityFunction,
      payment: entry?.payment,
      previousEffectIds: entry?.previousEffectIds ?? new Set(),
      chainRef
    });
    if (!rolledBack) complete = false;
  }
  return complete;
}

function notifyActiveApplicationCostPlanFailure(result = {}, abilityItem = null) {
  const shortages = (result?.quote?.costs ?? result?.execution?.quote?.costs ?? [])
    .filter(cost => Number(cost?.amount) > Number(cost?.available));
  if (result?.actor && shortages.length) {
    const details = shortages.map(cost => (
      `${String(cost?.label ?? cost?.resourceKey ?? "").trim()}: ${cost.amount} > ${cost.available}`
    )).join("; ");
    ui?.notifications?.warn?.(
      `${getAbilityDisplayName(abilityItem)}: ${result.actor.name ?? result.actor.uuid} — недостаточно ресурсов. ${details}`
    );
  } else {
    notifyAbilityTriggerCostFailure(result);
  }
  if (!result?.actor) return;
  console.warn(
    `Fallout MaW | ${getAbilityDisplayName(abilityItem)} activation cost failed for ${result.actor.name ?? result.actor.uuid}.`,
    result
  );
}

async function rollbackActiveApplicationPayment({
  actor = null,
  abilityItem = null,
  abilityFunction = null,
  payment = null,
  previousEffectIds = new Set(),
  chainRef = null
} = {}) {
  if (!actor || !payment?.ok) return false;
  let complete = true;
  const abilitySourceId = getAbilitySourceId(abilityItem);
  const overloadEffectIds = Array.from(actor.effects ?? [])
    .filter(effect => !previousEffectIds.has(String(effect?.id ?? "")))
    .filter(effect => {
      const overload = effect?.getFlag?.(SYSTEM_ID, ABILITY_OVERLOAD_EFFECT_FLAG_KEY)
        ?? effect?.flags?.[SYSTEM_ID]?.[ABILITY_OVERLOAD_EFFECT_FLAG_KEY];
      if (!overload) return false;
      if (String(overload?.functionId ?? "") !== String(abilityFunction?.id ?? "")) return false;
      const sourceMatches = abilitySourceId && overload?.abilitySourceId
        ? String(overload.abilitySourceId) === abilitySourceId
        : String(overload?.abilityItemId ?? "") === String(abilityItem?.id ?? "");
      return sourceMatches;
    })
    .map(effect => String(effect?.id ?? "").trim())
    .filter(Boolean);
  if (overloadEffectIds.length) {
    try {
      await actor.deleteEmbeddedDocuments("ActiveEffect", overloadEffectIds, {
        animate: false,
        falloutMawTriggerCostRollback: true,
        ...createAbilitySystemEventOptions(chainRef)
      });
    } catch (error) {
      complete = false;
      console.error("Fallout MaW | Failed to roll back active application overload", error);
    }
  }

  const updates = {};
  let healthRefund = 0;
  const receiptCosts = payment?.execution?.spendReceipt?.costs;
  const paidCosts = Array.isArray(receiptCosts)
    ? receiptCosts
    : payment?.execution?.quote?.costs ?? [];
  for (const cost of paidCosts) {
    const resourceKey = String(cost?.resourceKey ?? "").trim();
    const amount = Math.max(0, toInteger(cost?.amount));
    if (!resourceKey || amount <= 0) continue;
    if (resourceKey === HEALTH_RESOURCE_KEY) {
      healthRefund += amount;
      continue;
    }
    const resource = actor.system?.resources?.[resourceKey];
    if (!resource) {
      complete = false;
      console.error(`Fallout MaW | Cannot roll back missing active application resource '${resourceKey}'.`);
      continue;
    }
    const current = toInteger(resource.value);
    const maximum = Number(resource.max);
    const next = Number.isFinite(maximum)
      ? Math.min(toInteger(maximum), current + amount)
      : current + amount;
    updates[`system.resources.${resourceKey}.value`] = next;
    if (Number.isFinite(maximum)) {
      updates[`system.resources.${resourceKey}.spent`] = Math.max(0, toInteger(maximum) - next);
    }
  }
  if (Object.keys(updates).length) {
    try {
      await actor.update(updates, {
        falloutMawTriggerCostRollback: true,
        ...createAbilitySystemEventOptions(chainRef)
      });
    } catch (error) {
      complete = false;
      console.error("Fallout MaW | Failed to refund active application resources", error);
    }
  }
  if (healthRefund > 0) {
    try {
      const result = await restoreActorHealthCost(actor, healthRefund, { chainRef });
      if (Math.max(0, toInteger(result?.healthDelta)) !== healthRefund) {
        complete = false;
        console.error(
          `Fallout MaW | Active application health refund was incomplete (${result?.healthDelta ?? 0} != ${healthRefund}).`
        );
      }
    } catch (error) {
      complete = false;
      console.error("Fallout MaW | Failed to refund active application health cost", error);
    }
  }
  return complete;
}

async function requestActiveApplicationEffectOperation(payload = {}) {
  const gm = getActiveApplicationAuthorityGM(payload);
  if (!gm) return false;
  if (gm.id === game.user?.id) {
    return handleActiveApplicationEffectQuery(payload, { user: game.user });
  }
  const useKey = [payload?.actorUuid, payload?.abilityItemId, payload?.abilityFunctionId]
    .map(value => String(value ?? "").trim())
    .join(":");
  if (activeApplicationAuthorityRequestsByUse.has(useKey)) {
    ui.notifications.warn("Предыдущее применение этой способности ещё ожидает подтверждения GM.");
    return false;
  }
  const requestId = foundry.utils.randomID();
  const tracking = { requestId, useKey, state: "pending", cleanupTimeout: null };
  activeApplicationAuthorityRequestsByUse.set(useKey, tracking);
  activeApplicationAuthorityRequestsById.set(requestId, tracking);
  try {
    const applied = await gm.query(ACTIVE_APPLICATION_QUERY_NAME, payload, {
      timeout: DISARM_SOCKET_TIMEOUT_MS
    });
    clearActiveApplicationAuthorityRequest(requestId);
    return Boolean(applied);
  } catch (error) {
    tracking.state = "uncertain";
    ui.notifications.warn("Ответ GM на применение способности задерживается. Не повторяйте применение до снятия ожидания.");
    tracking.cleanupTimeout = window.setTimeout(
      () => clearActiveApplicationAuthorityRequest(requestId),
      ACTIVE_APPLICATION_AUTHORITY_CACHE_MS
    );
    console.warn("Fallout MaW | Active application authority query failed", error);
    return false;
  }
}

function clearActiveApplicationAuthorityRequest(requestId = "") {
  const tracking = activeApplicationAuthorityRequestsById.get(String(requestId ?? ""));
  if (!tracking) return null;
  if (tracking.cleanupTimeout) window.clearTimeout(tracking.cleanupTimeout);
  activeApplicationAuthorityRequestsById.delete(tracking.requestId);
  if (activeApplicationAuthorityRequestsByUse.get(tracking.useKey) === tracking) {
    activeApplicationAuthorityRequestsByUse.delete(tracking.useKey);
  }
  return tracking;
}

async function handleActiveApplicationEffectQuery(payload = {}, { user: sender = null } = {}) {
  if (!game.user?.isGM || !sender?.active) return false;
  const authority = getActiveApplicationAuthorityGM(payload);
  if (authority?.id !== game.user.id) return false;
  try {
    return Boolean(await processActiveApplicationEffectOperationOnce({
      ...payload,
      senderUserId: sender.id
    }));
  } catch (error) {
    console.error("Fallout MaW | Active application authority operation failed", error);
    return false;
  }
}

function processActiveApplicationEffectOperationOnce(payload = {}) {
  const operationId = String(payload?.authorityOperationId ?? "").trim();
  if (!operationId) return processActiveApplicationEffectOperation(payload);
  const operationKey = [
    payload?.senderUserId,
    payload?.actorUuid,
    payload?.abilityItemId,
    payload?.abilityFunctionId,
    operationId
  ].map(value => String(value ?? "").trim()).join(":");
  const cached = activeApplicationAuthorityOperations.get(operationKey);
  if (cached) return cached;

  const operation = Promise.resolve().then(() => processActiveApplicationEffectOperation(payload));
  activeApplicationAuthorityOperations.set(operationKey, operation);
  const scheduleCleanup = () => globalThis.setTimeout(() => {
    if (activeApplicationAuthorityOperations.get(operationKey) === operation) {
      activeApplicationAuthorityOperations.delete(operationKey);
    }
  }, ACTIVE_APPLICATION_AUTHORITY_CACHE_MS);
  operation.then(scheduleCleanup, scheduleCleanup);
  return operation;
}

async function processActiveApplicationEffectOperation(payload = {}) {
  const sourceActor = await fromUuid(String(payload?.actorUuid ?? ""));
  const sourceTokenDocument = await fromUuid(String(payload?.sourceTokenUuid ?? ""));
  const abilityItem = sourceActor?.items?.get(String(payload?.abilityItemId ?? ""));
  const abilityFunction = normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .find(entry => entry.id === String(payload?.abilityFunctionId ?? "") && isActiveApplicationAbilityFunction(entry));
  const sender = game.users?.get(String(payload?.senderUserId ?? ""));
  if (
    !sourceActor
    || sourceTokenDocument?.documentName !== "Token"
    || !sourceTokenDocument.actor
    || !abilityItem
    || !abilityFunction
  ) return false;
  if (sourceTokenDocument.actor.uuid !== sourceActor.uuid) return false;
  if (!sender || (!sender.isGM && !sourceActor.testUserPermission(sender, "OWNER"))) return false;

  const settings = normalizeActiveApplicationSettings(abilityFunction.activeSettings);
  const requestedTokenUuids = Array.from(new Set((payload?.targetTokenUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  if (!requestedTokenUuids.length) return false;
  if (
    settings.targetSelectionMode !== "all"
    && requestedTokenUuids.length > evaluateActiveApplicationTargetLimit(settings, sourceActor)
  ) return false;

  const targetTokenDocuments = await Promise.all(requestedTokenUuids.map(uuid => fromUuid(uuid)));
  const sourceSceneUuid = String(sourceTokenDocument.parent?.uuid ?? "").trim();
  if (!sourceSceneUuid || targetTokenDocuments.some(tokenDocument => (
    !tokenDocument?.actor
    || tokenDocument.documentName !== "Token"
    || String(tokenDocument.parent?.uuid ?? "") !== sourceSceneUuid
  ))) return false;
  if (
    settings.wallsBlock
    && [sourceTokenDocument, ...targetTokenDocuments]
      .some(tokenDocument => !isTokenDocumentIncludedForUserLevel(tokenDocument, game.user))
  ) return false;
  if (targetTokenDocuments.some(targetTokenDocument => !isActiveApplicationTokenDocumentAllowed({
    sourceActor,
    sourceTokenDocument,
    targetTokenDocument,
    settings,
    sender
  }))) return false;
  if (new Set(targetTokenDocuments.map(tokenDocument => tokenDocument.actor?.uuid).filter(Boolean)).size
    !== targetTokenDocuments.length) return false;

  const available = getSelectableAbilityChanges(abilityFunction.changes ?? []);
  const configuredLimit = resolveLimitedChangeLimit(abilityFunction.conditions ?? [], sourceActor, {
    evaluateLimit: formula => evaluateActorFormula(formula, sourceActor, {
      fallback: 1,
      minimum: 1,
      context: "active application authority limit"
    })
  });
  const expectedCount = configuredLimit === null
    ? available.length
    : Math.min(available.length, configuredLimit);
  const selectedIds = Array.from(new Set((payload?.selectedChangeIds ?? [])
    .map(id => String(id ?? "").trim())
    .filter(Boolean)));
  if (selectedIds.length !== expectedCount) return false;
  const selected = new Set(selectedIds);
  const selectedChanges = available.filter(entry => selected.has(entry.id)).map(entry => entry.change);
  if (selectedChanges.length !== expectedCount) return false;
  const selectedFunction = {
    ...abilityFunction,
    changes: selectedChanges
  };

  const durationSeconds = getAbilityFunctionEffectDurationSeconds(abilityFunction);
  const createsApplicationEffect = durationSeconds > 0
    || normalizeActiveApplicationSettings(abilityFunction?.activeSettings).persistent;
  const hasItemMutations = hasActiveApplicationItemMutations(settings);
  const hasApplicationOperation = createsApplicationEffect || hasItemMutations;
  const resolvedTargets = targetTokenDocuments.map(tokenDocument => ({
    token: tokenDocument.object ?? tokenDocument,
    actor: tokenDocument.actor
  }));
  const createsRuntimeAuraEffect = activeApplicationFunctionHasRuntimeAura(abilityFunction);
  if (createsRuntimeAuraEffect && durationSeconds <= 0) return false;
  if (
    createsApplicationEffect
    && (!abilityFunctionRoutesPrimaryChangesThroughTrials(abilityFunction) || createsRuntimeAuraEffect)
    && !activeApplicationTargetsHaveEffectCopyCapacity(sourceActor, abilityItem, abilityFunction, resolvedTargets)
  ) return false;
  let payment = null;
  if (payload?.payCostsRemotely === true || !sender.isGM) {
    const planEntries = buildActiveApplicationCostPlanEntries(sourceActor, settings.costs, resolvedTargets);
    const expectedActorUuids = planEntries
      .map(entry => String(entry.actor?.uuid ?? "").trim())
      .filter(Boolean)
      .sort();
    const suppliedFingerprints = Object.fromEntries(Object.entries(payload?.costFingerprints ?? {})
      .map(([actorUuid, fingerprint]) => [String(actorUuid).trim(), String(fingerprint)]));
    const suppliedActorUuids = Object.keys(suppliedFingerprints).filter(Boolean).sort();
    if (JSON.stringify(expectedActorUuids) !== JSON.stringify(suppliedActorUuids)) return false;
    payment = await payActiveApplicationCostPlan({
      entries: planEntries,
      abilityItem,
      abilityFunction,
      expectedFingerprints: suppliedFingerprints,
      context: {
        rootId: String(payload?.costContext?.rootId ?? "").trim(),
        occurrenceId: String(payload?.costContext?.occurrenceId ?? "").trim(),
        chainRef: payload?.costContext?.chainRef ?? payload?.chainRef ?? null
      }
    });
    if (!payment.ok) return false;
  }

  const sourceToken = sourceTokenDocument.object ?? sourceTokenDocument;
  try {
    const applied = !hasApplicationOperation || await applyActiveApplicationEffectsDirect(
        sourceActor,
        abilityItem,
        abilityFunction,
        durationSeconds,
        resolvedTargets,
        {
          chainRef: payload?.chainRef ?? null,
          sourceToken,
          selectedChanges,
          costContext: payload?.costContext ?? null
        }
      );
    if (!applied) return false;
    const trialsAreDrivenByAura = activeApplicationFunctionHasTriggerAura(abilityFunction);
    if (!trialsAreDrivenByAura) {
      await executeAbilityTrials({
        abilityFunction: selectedFunction,
        constructs: normalizeAbilityConstructs(abilityItem.system?.constructs),
        sourceActor,
        sourceToken,
        targets: resolvedTargets,
        sourceItemUuid: String(abilityItem.uuid ?? ""),
        title: getAbilityDisplayName(abilityItem),
        operationId: [
          String(payload?.costContext?.rootId ?? payload?.chainRef?.rootId ?? "").trim(),
          String(payload?.costContext?.occurrenceId ?? "").trim()
        ].filter(Boolean).join(":")
      });
    }
    return true;
  } catch (error) {
    if (payment?.ok) {
      await rollbackActiveApplicationPaymentPlan({
        abilityItem,
        abilityFunction,
        paymentPlan: payment,
        chainRef: payload?.chainRef ?? null
      });
    }
    throw error;
  }
}

function isActiveApplicationTokenDocumentAllowed({
  sourceActor = null,
  sourceTokenDocument = null,
  targetTokenDocument = null,
  settings = {},
  sender = null
} = {}) {
  const targetActor = targetTokenDocument?.actor;
  if (!sourceActor || !sourceTokenDocument?.actor || !targetActor) return false;
  const isSelf = targetActor.uuid === sourceActor.uuid;
  if (settings.targetMode !== "others") {
    return isSelf && targetTokenDocument.uuid === sourceTokenDocument.uuid;
  }
  if (!sender?.isGM && targetTokenDocument.hidden) return false;
  if (settings.excludeSelf && isSelf) return false;
  if (!new Set(settings.targetGroups ?? []).has(getActiveApplicationTargetRelation(sourceActor, targetActor))) return false;

  const radiusFormula = String(settings.radiusFormula ?? "").trim();
  if (radiusFormula && !isSelf) {
    const radiusMeters = Math.max(0, evaluateActorFormula(radiusFormula, sourceActor, {
      fallback: 0,
      minimum: 0,
      context: "active application authority radius"
    }));
    if (measureActiveApplicationTokenDocumentDistance(sourceTokenDocument, targetTokenDocument) > radiusMeters) {
      return false;
    }
  }
  if (settings.wallsBlock && !isSelf) {
    if (String(canvas?.scene?.uuid ?? "") !== String(sourceTokenDocument.parent?.uuid ?? "")) return false;
    const sourceToken = sourceTokenDocument.object ?? null;
    const targetToken = targetTokenDocument.object ?? null;
    if (!sourceToken || !targetToken || !hasActiveApplicationLineOfSight(sourceToken, targetToken)) return false;
  }
  return true;
}

function measureActiveApplicationTokenDocumentDistance(sourceTokenDocument, targetTokenDocument) {
  const scene = sourceTokenDocument?.parent ?? null;
  if (!scene || String(scene.uuid ?? "") !== String(targetTokenDocument?.parent?.uuid ?? "")) {
    return Number.POSITIVE_INFINITY;
  }
  const sourceCenter = getActiveApplicationTokenDocumentCenter(sourceTokenDocument, scene);
  const targetCenter = getActiveApplicationTokenDocumentCenter(targetTokenDocument, scene);
  const measured = scene.grid?.measurePath?.([sourceCenter, targetCenter])?.distance;
  if (Number.isFinite(Number(measured))) return Math.max(0, Number(measured));

  const distancePixels = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y);
  const gridSize = Math.max(1, Number(scene.grid?.size ?? scene.grid?.sizeX) || 100);
  const gridDistance = Math.max(0.0001, Number(scene.grid?.distance) || 1);
  return (distancePixels / gridSize) * gridDistance;
}

function getActiveApplicationTokenDocumentCenter(tokenDocument, scene = null) {
  const center = tokenDocument?.getCenterPoint?.();
  if (Number.isFinite(Number(center?.x)) && Number.isFinite(Number(center?.y))) {
    return { x: Number(center.x), y: Number(center.y) };
  }
  const gridSize = Math.max(1, Number(scene?.grid?.size ?? scene?.grid?.sizeX) || 100);
  return {
    x: Number(tokenDocument?.x ?? 0) + (Math.max(0.01, Number(tokenDocument?.width) || 1) * gridSize / 2),
    y: Number(tokenDocument?.y ?? 0) + (Math.max(0.01, Number(tokenDocument?.height) || 1) * gridSize / 2)
  };
}

function getActiveApplicationEffectChanges(
  sourceActor,
  abilityItem,
  abilityFunction,
  target = {},
  sourceToken = null,
  chanceOperationId = ""
) {
  if (abilityFunctionRoutesPrimaryChangesThroughTrials(abilityFunction)) return [];
  const subjectActor = target.actor ?? sourceActor;
  const context = {
    abilityItemId: abilityItem.id,
    functionId: abilityFunction.id,
    actorToken: sourceToken ?? getPrimaryActorToken(sourceActor),
    targetActor: target.actor,
    targetToken: target.token,
    allowContextual: true,
    chanceOperationId
  };
  if (!abilityFunction.conditions?.length) return abilityFunction.changes ?? [];
  return abilityConditionsApply(subjectActor, abilityFunction.conditions, context)
    ? abilityFunction.changes ?? []
    : abilityFunction.penalties ?? [];
}

function abilityFunctionRoutesPrimaryChangesThroughTrials(abilityFunction = {}) {
  return (abilityFunction?.conditions ?? []).some(condition => (
    condition?.type === ABILITY_CONDITION_TYPES.trial
    && condition?.trialRoutesPrimaryChanges === true
  ));
}

function abilityFunctionHasTrialConsequences(abilityFunction = {}) {
  return (abilityFunction?.conditions ?? []).some(condition => (
    condition?.type === ABILITY_CONDITION_TYPES.trial
    && (condition?.trialBranches ?? []).some(branch => (branch?.links ?? []).length)
  ));
}

function queueActiveApplicationEffectSync(actor) {
  const actorUuid = actor?.uuid;
  if (!actorUuid || !game.user?.isActiveGM || !hasActiveApplicationEffects(actor)) return;
  globalThis.clearTimeout(activeApplicationEffectSyncTimers.get(actorUuid));
  activeApplicationEffectSyncTimers.set(actorUuid, globalThis.setTimeout(() => {
    activeApplicationEffectSyncTimers.delete(actorUuid);
    const currentActor = fromUuidSync(actorUuid) ?? actor;
    if (!hasActiveApplicationEffects(currentActor)) return;
    void syncActorActiveApplicationEffects(currentActor);
  }, 40));
}

async function syncActorActiveApplicationEffects(actor) {
  if (!actor || !game.user?.isActiveGM) return;
  const effects = actor.effects?.filter(effect => effect.getFlag?.(SYSTEM_ID, ACTIVE_APPLICATION_EFFECT_FLAG_KEY)) ?? [];
  for (const effect of effects) {
    const flag = effect.getFlag(SYSTEM_ID, ACTIVE_APPLICATION_EFFECT_FLAG_KEY);
    const abilityFunction = normalizeAbilityFunctions([flag?.functionData])[0];
    if (!abilityFunction) continue;
    if (activeApplicationFunctionHasDistributionAura(abilityFunction)) {
      const update = buildActiveApplicationMarkerChangeUpdate(effect, flag, []);
      if (effect.getFlag(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind !== EFFECT_LIFECYCLE_KINDS.disposableInstance) {
        update[`flags.${SYSTEM_ID}.${EFFECT_LIFECYCLE_FLAG_KEY}`] = {
          kind: EFFECT_LIFECYCLE_KINDS.disposableInstance
        };
      }
      if (Object.keys(update).length) await effect.update(update);
      continue;
    }
    const sourceActor = await fromUuid(String(flag?.sourceActorUuid ?? "")) ?? actor;
    const abilityItem = {
      id: String(flag?.abilityItemId ?? ""),
      name: effect.name,
      img: effect.img,
      uuid: effect.origin,
      flags: {
        [SYSTEM_ID]: {
          abilitySource: {
            id: String(flag?.abilitySourceId ?? "")
          }
        }
      }
    };
    const snapshot = Array.isArray(flag?.changeSnapshot) ? flag.changeSnapshot : null;
    const changes = resolveActiveApplicationMarkerChanges(abilityFunction, {
      changeSnapshot: snapshot,
      evaluateChanges: () => getActiveApplicationEffectChanges(sourceActor, abilityItem, abilityFunction, {
        actor,
        token: getPrimaryActorToken(actor)
      }, null, String(flag?.chanceOperationId ?? ""))
        .map(change => prepareEffectChangeForApplication(actor, change))
        .filter(change => change.key && change.value !== "")
    });
    const update = buildActiveApplicationMarkerChangeUpdate(effect, flag, changes);
    if (effect.getFlag(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind !== EFFECT_LIFECYCLE_KINDS.disposableInstance) {
      update[`flags.${SYSTEM_ID}.${EFFECT_LIFECYCLE_FLAG_KEY}`] = {
        kind: EFFECT_LIFECYCLE_KINDS.disposableInstance
      };
    }
    if (Object.keys(update).length) await effect.update(update);
  }
}

function hasActiveApplicationEffects(actor = null) {
  for (const effect of actor?.effects ?? []) {
    const flag = effect?.getFlag?.(SYSTEM_ID, ACTIVE_APPLICATION_EFFECT_FLAG_KEY);
    if (!flag) continue;
    if (activeApplicationFunctionHasDistributionAura(flag.functionData)) {
      if (Object.keys(buildActiveApplicationMarkerChangeUpdate(effect, flag, [])).length) return true;
      if (
        effect.getFlag(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind
        !== EFFECT_LIFECYCLE_KINDS.disposableInstance
      ) return true;
      continue;
    }
    const abilityFunction = normalizeAbilityFunctions([flag.functionData])[0];
    if (!abilityFunction) continue;
    return true;
  }
  return false;
}

function collectCommandBasicsTargetRows(commander, command = "") {
  return (canvas.tokens?.placeables ?? [])
    .filter(token => token?.actor && token.visible !== false && token.renderable !== false)
    .filter(token => token.actor.uuid !== commander?.uuid)
    .filter(token => isCommandBasicsAlly(commander, token.actor))
    .map(token => createCommandBasicsTargetRow(commander, token, command));
}

function createCommandBasicsTargetRow(commander, token, command = "") {
  const actor = token?.actor ?? null;
  const row = {
    token,
    actorUuid: actor?.uuid ?? "",
    selectable: false,
    reason: "",
    attack: null
  };
  if (isActorUnableToAct(actor)) {
    row.reason = "актёр не может действовать.";
    return row;
  }
  if (command === "duck") {
    row.selectable = true;
    return row;
  }

  const actionKey = command === "strike" ? "meleeAttack" : "snapshot";
  const candidate = getCommandBasicsWeaponCandidate(actor, actionKey);
  if (!candidate) {
    row.reason = actionKey === "snapshot" ? "нет неприцельного выстрела." : "нет неприцельной атаки.";
    return row;
  }
  const block = getWeaponActionBlockState(actor, actionKey);
  if (block.blocked) {
    row.reason = `действие заблокировано${block.effect?.name ? ` (${block.effect.name})` : ""}.`;
    return row;
  }
  const attackCount = getActionAttackCount(candidate.weapon, actionKey, candidate.weaponFunctionId);
  const missing = getMissingWeaponResourceCost(candidate.weapon, attackCount, candidate.weaponFunctionId);
  if (missing) {
    row.reason = `не хватает ${missing.label} (${missing.current} / ${missing.required}).`;
    return row;
  }
  row.selectable = true;
  row.attack = {
    token,
    weapon: candidate.weapon,
    actionKey,
    weaponFunctionId: candidate.weaponFunctionId
  };
  return row;
}

function getCommandBasicsWeaponCandidate(actor, actionKey = "") {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId) ?? null;
  const inventory = prepareInventoryContext(actor, race, { includeLocked: false });
  const sets = [
    ...(inventory.naturalWeaponSet ? [inventory.naturalWeaponSet] : []),
    ...(inventory.weaponSets ?? [])
  ].filter(set => set?.key);
  const activeSet = resolveActiveHudWeaponSet(actor, sets);
  const orderedSets = [
    ...(activeSet ? [activeSet] : []),
    ...sets.filter(set => set !== activeSet)
  ];
  for (const set of orderedSets) {
    const candidate = getCommandBasicsWeaponCandidateFromSet(actor, set, actionKey);
    if (candidate) return candidate;
  }
  return null;
}

function getCommandBasicsWeaponCandidateFromSet(actor, set = null, actionKey = "") {
  const seen = new Set();
  for (const slot of set?.slots ?? []) {
    const itemId = String(slot.item?.id ?? "");
    if (!itemId || seen.has(itemId) || slot.phantom || slot.item?.phantom || slot.useDisabled || slot.item?.useDisabled) continue;
    seen.add(itemId);
    const weapon = actor.items?.get(itemId);
    if (!weapon || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon, { ignoreBroken: false })) continue;
    const weaponFunctionId = getCommandBasicsWeaponFunctionId(weapon, actionKey);
    if (weaponFunctionId) return { weapon, weaponFunctionId, weaponSet: set.key };
  }
  return null;
}

function getCommandBasicsWeaponFunctionId(weapon, actionKey = "") {
  for (const weaponFunction of getEnabledWeaponFunctions(weapon)) {
    const weaponFunctionId = weaponFunction.isPrimary ? ITEM_FUNCTIONS.weapon : weaponFunction.id;
    if (hasWeaponAction(weapon, actionKey, weaponFunctionId)) return weaponFunctionId;
  }
  return "";
}

function isCommandBasicsAlly(left, right) {
  const leftFactions = getActorFactionBelongs(left);
  const rightFactions = getActorFactionBelongs(right);
  const normalizedLeft = leftFactions.length ? leftFactions : [DEFAULT_FACTION_NAME];
  const normalizedRight = rightFactions.length ? rightFactions : [DEFAULT_FACTION_NAME];
  if (normalizedLeft.some(faction => normalizedRight.includes(faction))) return true;
  return normalizedRight.some(faction => getRelationTo(left, faction) === "ally")
    || normalizedLeft.some(faction => getRelationTo(right, faction) === "ally");
}

function getCommandBasicsCommandLabel(command = "") {
  if (command === "shoot") return "Цельсь, пли";
  if (command === "strike") return "Коли";
  if (command === "duck") return "Ложись";
  return "Команда";
}

async function useKnockOffBalance(actor, abilityItem, abilityFunction, { onInteractionCancelled = null } = {}) {
  const abilityName = getAbilityDisplayName(abilityItem);
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.warn(`${abilityName}: сцена не готова.`);
    return false;
  }

  const settings = normalizeKnockOffBalanceSettings(abilityFunction.fixedSettings);
  if (!getSkillSettings().some(skill => skill.key === settings.targetSkillKey)) {
    ui.notifications.warn(`${abilityName}: навык проверки цели не настроен.`);
    return false;
  }
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  if (!game.user?.isGM && !getResponsibleGM()) {
    ui.notifications.warn(`${abilityName}: нет активного GM для применения дебафа.`);
    return false;
  }

  const limit = Math.max(1, Math.floor(evaluateActorFormula(settings.targetLimitFormula, actor, {
    fallback: 2,
    minimum: 1,
    context: "knock off balance target limit"
  })));
  const selection = await selectKnockOffBalanceTargets({ actor, limit, abilityName });
  if (!selection?.length) return false;

  const skillLimit = Math.max(1, Math.floor(evaluateActorFormula(settings.skillLimitFormula, actor, {
    fallback: 1,
    minimum: 1,
    context: "knock off balance skill limit"
  })));
  const selectedSkills = await selectKnockOffBalanceSkills({ limit: skillLimit, abilityName });
  if (!selectedSkills?.length) {
    notifyAbilityInteractionCancelled(onInteractionCancelled, {
      reason: "skillSelectionCancelled"
    });
    return false;
  }

  if (!(await spendEnergy(actor, energyCost))) return false;
  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.overloadEnergyCost,
    durationSeconds: settings.overloadDurationSeconds
  });

  const difficulty = Math.max(0, Math.floor(evaluateActorFormula(settings.difficultyFormula, actor, {
    fallback: 50,
    minimum: 0,
    context: "knock off balance difficulty"
  })));
  const sourceToken = getActorSceneToken(actor);
  const checks = await requestSkillCheckBatch({
    skillKey: settings.targetSkillKey,
    entries: selection.map(entry => ({
      actor: entry.token?.actor,
      data: {
        difficulty,
        actorToken: entry.token,
        targetToken: sourceToken,
        targetActor: actor
      }
    })),
    requester: "knockOffBalance",
    title: `${abilityName}: проверка`
  });
  const outcomes = checks?.outcomes ?? [];
  const failed = outcomes.filter(outcome => !["success", "criticalSuccess"].includes(String(outcome?.result?.key ?? "")));
  if (!failed.length) {
    await createAbilityChatMessage(actor, abilityItem, "Все цели устояли.");
    return true;
  }

  const applied = await requestKnockOffBalanceDebuffOperation({
    actorUuid: actor.uuid,
    abilityItemId: abilityItem.id,
    abilityFunctionId: abilityFunction.id,
    targetActorUuids: failed.map(outcome => outcome.actor?.uuid).filter(Boolean),
    selectedSkillKeys: selectedSkills.map(skill => skill.key),
    skillDisadvantageCount: settings.skillDisadvantageCount,
    durationSeconds: settings.debuffDurationSeconds,
    senderUserId: game.user?.id ?? ""
  });
  if (!applied) {
    ui.notifications.warn(`${abilityName}: не удалось применить дебаф.`);
    return false;
  }

  await createAbilityChatMessage(
    actor,
    abilityItem,
    `${failed.length} целей выбито из колеи: ${settings.skillDisadvantageCount} помехи к навыкам (${selectedSkills.map(skill => skill.label).join(", ")}) на ${formatDuration(settings.debuffDurationSeconds)}.`
  );
  return true;
}

function selectKnockOffBalanceTargets({ actor = null, limit = 1, abilityName = "Выбить из колеи" } = {}) {
  const collectRows = () => collectKnockOffBalanceTargetRows(actor);
  return requestCustomTokenSelection({
    rows: collectRows(),
    limit,
    title: abilityName,
    noneWarning: `${abilityName}: нет подходящих целей.`,
    instructions: `${abilityName}: выберите до ${limit} целей. ЛКМ на последней цели сразу подтверждает, Enter тоже, Esc/ПКМ отменяет.`,
    sourceToken: getActorSceneToken(actor),
    refreshRows: collectRows
  });
}

function collectKnockOffBalanceTargetRows(actor) {
  return (canvas.tokens?.placeables ?? [])
    .filter(token => token?.actor && token.visible !== false && token.renderable !== false)
    .filter(token => token.actor.uuid !== actor?.uuid)
    .map(token => createKnockOffBalanceTargetRow(token));
}

function createKnockOffBalanceTargetRow(token) {
  const actor = token?.actor ?? null;
  const row = {
    token,
    actorUuid: actor?.uuid ?? "",
    selectable: false,
    reason: ""
  };
  if (getActorIntelligence(actor) <= 0) {
    row.reason = "интеллект 0 или ниже.";
    return row;
  }
  row.selectable = true;
  return row;
}

function getActorIntelligence(actor) {
  return toInteger(actor?.system?.characteristics?.intelligence);
}

async function selectKnockOffBalanceSkills({ limit = 1, abilityName = "Выбить из колеи" } = {}) {
  const skills = getSkillSettings()
    .map(skill => ({
      key: String(skill?.key ?? "").trim(),
      label: String(skill?.label ?? skill?.key ?? "").trim()
    }))
    .filter(skill => skill.key);
  if (!skills.length) {
    ui.notifications.warn(`${abilityName}: навыки не настроены.`);
    return null;
  }

  const options = skills.map(skill => `
    <label class="fallout-maw-radio-card" data-knock-off-balance-skill-choice>
      <input type="checkbox" name="skillKeys" value="${escapeAttribute(skill.key)}">
      <span><strong>${escapeHTML(skill.label)}</strong></span>
    </label>
  `).join("");
  const formData = await DialogV2.input({
    window: { title: `${abilityName}: выбор навыков` },
    content: `
      <div class="fallout-maw-knock-off-balance-skill-dialog" data-knock-off-balance-skill-limit="${Math.max(1, toInteger(limit))}">
        <p class="hint">Выберите до ${Math.max(1, toInteger(limit))} навыков. Цели при провале получат двойную помеху к выбранным навыкам.</p>
        <div class="fallout-maw-knock-off-balance-skill-grid">${options}</div>
      </div>
    `,
    render: (_event, dialog) => {
      const root = dialog?.element?.querySelector?.(".fallout-maw-knock-off-balance-skill-dialog");
      root?.addEventListener?.("change", event => {
        const input = event.target?.matches?.('input[name="skillKeys"]') ? event.target : null;
        if (input) syncKnockOffBalanceSkillChoices(dialog, input);
      });
      syncKnockOffBalanceSkillChoices(dialog);
    },
    ok: {
      label: "Выбрать",
      icon: "fa-solid fa-check",
      callback: (_event, button) => ({
        skillKeys: Array.from(button.form?.querySelectorAll?.('input[name="skillKeys"]:checked') ?? [])
          .map(input => String(input.value ?? "").trim())
          .filter(Boolean)
      })
    },
    buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
    position: { width: 620 },
    rejectClose: false
  });
  const selected = new Set((formData?.skillKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean));
  const result = skills.filter(skill => selected.has(skill.key)).slice(0, Math.max(1, toInteger(limit)));
  if (!result.length) ui.notifications.warn(`${abilityName}: не выбраны навыки.`);
  return result.length ? result : null;
}

function syncKnockOffBalanceSkillChoices(dialog, changedInput = null) {
  const root = dialog?.element?.querySelector?.(".fallout-maw-knock-off-balance-skill-dialog");
  if (!root) return;
  const limit = Math.max(1, toInteger(root.dataset.knockOffBalanceSkillLimit));
  const inputs = Array.from(root.querySelectorAll('input[name="skillKeys"]') ?? []);
  let selectedCount = inputs.filter(input => input.checked).length;
  if (selectedCount > limit) {
    if (changedInput?.checked) changedInput.checked = false;
    else inputs.filter(input => input.checked).slice(limit).forEach(input => {
      input.checked = false;
    });
    selectedCount = inputs.filter(input => input.checked).length;
  }
  for (const input of inputs) {
    input.disabled = !input.checked && selectedCount >= limit;
    input.closest("[data-knock-off-balance-skill-choice]")?.classList.toggle("disabled", input.disabled);
  }
}

async function requestKnockOffBalanceDebuffOperation(payload = {}) {
  if (game.user?.isGM) return processKnockOffBalanceDebuffOperation(payload);
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
      action: "performKnockOffBalanceDebuff",
      requestId,
      gmUserId: gm.id,
      senderUserId: game.user?.id ?? "",
      payload
    });
  });
}

async function processKnockOffBalanceDebuffSocketRequest(message = {}) {
  const applied = await processKnockOffBalanceDebuffOperation({
    ...(message.payload ?? {}),
    senderUserId: message.senderUserId ?? message.payload?.senderUserId ?? ""
  });
  game.socket.emit(FIXED_ABILITY_SOCKET, {
    scope: FIXED_ABILITY_SOCKET_SCOPE,
    action: "knockOffBalanceDebuffResult",
    requestId: message.requestId,
    targetUserId: message.senderUserId ?? "",
    result: { applied: Boolean(applied) }
  });
}

async function processKnockOffBalanceDebuffOperation(payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  const abilityItem = actor?.items?.get(String(payload.abilityItemId ?? ""));
  const abilityFunction = normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .find(entry => entry.id === payload.abilityFunctionId && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.knockOffBalance);
  const sender = game.users?.get(String(payload.senderUserId ?? ""));
  if (!actor || !abilityItem || !abilityFunction) return false;
  if (sender && !sender.isGM && !actor.testUserPermission(sender, "OWNER")) return false;

  const targetActorUuids = Array.from(new Set((payload.targetActorUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  const targets = (await Promise.all(targetActorUuids.map(uuid => fromUuid(uuid))))
    .filter(target => target && getActorIntelligence(target) > 0);
  if (!targets.length) return false;

  const skillDisadvantageCount = Math.max(1, toInteger(payload.skillDisadvantageCount ?? 2));
  const validSkillKeys = new Set(getSkillSettings().map(skill => String(skill?.key ?? "").trim()).filter(Boolean));
  const selectedSkillKeys = Array.from(new Set((payload.selectedSkillKeys ?? [])
    .map(key => String(key ?? "").trim())
    .filter(key => validSkillKeys.has(key))));
  if (!selectedSkillKeys.length) return false;
  const durationSeconds = Math.max(0, toInteger(payload.durationSeconds));
  const startTime = Number(game.time?.worldTime) || 0;
  const changes = selectedSkillKeys.map(skillKey => ({
      key: `system.skills.${skillKey}.disadvantage`,
      type: "add",
      value: String(skillDisadvantageCount),
      phase: "initial",
      priority: null
    }));
  const effectData = {
    type: "base",
    name: getAbilityDisplayName(abilityItem),
    img: abilityItem.img || "icons/svg/daze.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: durationSeconds,
      startTime
    },
    system: {
      changes
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [KNOCK_OFF_BALANCE_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          createdAt: startTime
        }
      }
    }
  };
  for (const target of targets) {
    await target.createEmbeddedDocuments("ActiveEffect", [foundry.utils.deepClone(effectData)], { animate: false });
  }
  return true;
}

async function useLook(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.warn(`${abilityName}: сцена не готова.`);
    return false;
  }

  const settings = normalizeLookSettings(abilityFunction.fixedSettings);
  if (!getSkillSettings().some(skill => skill.key === settings.targetSkillKey)) {
    ui.notifications.warn(`${abilityName}: навык проверки цели не настроен.`);
    return false;
  }
  const sourceToken = getActorSceneToken(actor);
  if (!sourceToken) {
    ui.notifications.warn(`${abilityName}: токен персонажа не найден на сцене.`);
    return false;
  }
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  if (!game.user?.isGM && !getResponsibleGM()) {
    ui.notifications.warn(`${abilityName}: нет активного GM для списания ресурсов цели.`);
    return false;
  }

  const selection = await selectLookTarget({ actor, sourceToken, abilityName });
  const targetToken = selection?.[0]?.token ?? null;
  if (!targetToken?.actor) return false;
  if (!targetToken.actor.system?.skills?.[settings.targetSkillKey]) {
    ui.notifications.warn(`${abilityName}: у цели нет навыка проверки.`);
    return false;
  }
  if (!isActorInActiveCombat(targetToken.actor)) {
    ui.notifications.warn(`${abilityName}: цель не участвует в активном бою.`);
    return false;
  }

  if (!(await spendEnergy(actor, energyCost))) return false;
  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.overloadEnergyCost,
    durationSeconds: settings.overloadDurationSeconds
  });

  const difficulty = Math.max(0, Math.floor(evaluateActorFormula(settings.difficultyFormula, actor, {
    fallback: 50,
    minimum: 0,
    context: "look difficulty"
  })));
  const outcome = await requestSkillCheck({
    actor: targetToken.actor,
    skillKey: settings.targetSkillKey,
    animate: false,
    data: {
      difficulty,
      actorToken: targetToken.object ?? targetToken,
      targetToken: sourceToken.document ?? sourceToken,
      targetActor: actor
    },
    requester: "look",
    messageData: { title: `${abilityName}: проверка` }
  });
  if (!outcome) {
    ui.notifications.warn(`${abilityName}: проверка цели не выполнена.`);
    return false;
  }
  const resultKey = String(outcome?.result?.key ?? "");
  if (["success", "criticalSuccess"].includes(resultKey)) {
    await createAbilityChatMessage(actor, abilityItem, `${targetToken.actor.name} устоял.`);
    return true;
  }

  const resourceLoss = resultKey === "criticalFailure"
    ? settings.criticalFailureResourceLoss
    : settings.failureResourceLoss;
  const applied = await requestLookResourceLossOperation({
    actorUuid: actor.uuid,
    actorTokenUuid: sourceToken.document?.uuid ?? sourceToken.uuid,
    abilityItemId: abilityItem.id,
    abilityFunctionId: abilityFunction.id,
    targetTokenUuid: targetToken.document?.uuid ?? targetToken.uuid,
    resourceLoss,
    senderUserId: game.user?.id ?? ""
  });
  if (!applied) {
    ui.notifications.warn(`${abilityName}: не удалось списать ресурсы цели.`);
    return false;
  }

  await createAbilityChatMessage(
    actor,
    abilityItem,
    `${targetToken.actor.name} теряет до ${resourceLoss} ОД и до ${resourceLoss} ОП.`
  );
  return true;
}

function selectLookTarget({ actor = null, sourceToken = null, abilityName = "Смотри!" } = {}) {
  return requestCustomActorTokenSelection({
    sourceActor: actor,
    sourceToken,
    includeSelf: false,
    title: abilityName,
    noneWarning: `${abilityName}: нет видимых целей.`,
    instructions: `${abilityName}: выберите одну цель в пределах видимости. ЛКМ сразу подтверждает, Enter тоже, Esc/ПКМ отменяет.`
  }).then(selection => selection ? [selection] : []);
}

async function useToTheEnd(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.warn(`${abilityName}: сцена не готова.`);
    return false;
  }

  const settings = normalizeToTheEndSettings(abilityFunction.fixedSettings);
  const sourceToken = getActorSceneToken(actor);
  if (!sourceToken) {
    ui.notifications.warn(`${abilityName}: токен персонажа не найден на сцене.`);
    return false;
  }
  if (!game.user?.isGM && !getResponsibleGM()) {
    ui.notifications.warn(`${abilityName}: нет активного GM для применения эффекта.`);
    return false;
  }

  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }

  const radiusMeters = Math.max(0, evaluateActorFormula(settings.radiusFormula, actor, {
    fallback: 20,
    minimum: 0,
    context: "to the end radius"
  }));
  const targets = collectToTheEndTargets(actor, sourceToken, radiusMeters);
  if (!targets.length) {
    ui.notifications.warn(`${abilityName}: нет союзников в радиусе ${Math.floor(radiusMeters)} м.`);
    return false;
  }

  const healingAmount = Math.max(0, Math.floor(evaluateActorFormula(settings.healingFormula, actor, {
    fallback: 50,
    minimum: 0,
    context: "to the end healing"
  })));
  const characteristicBonus = Math.max(0, Math.floor(evaluateActorFormula(settings.characteristicBonusFormula, actor, {
    fallback: 1,
    minimum: 0,
    context: "to the end characteristic bonus"
  })));

  if (!(await spendEnergy(actor, energyCost))) return false;
  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.overloadEnergyCost,
    durationSeconds: settings.overloadDurationSeconds
  });

  const applied = await requestToTheEndOperation({
    actorUuid: actor.uuid,
    abilityItemId: abilityItem.id,
    abilityFunctionId: abilityFunction.id,
    targetActorUuids: targets.map(entry => entry.actor.uuid),
    healingAmount,
    durationSeconds: settings.durationSeconds,
    characteristicBonus,
    advantageSkills: settings.advantageSkills,
    suppressTraumas: settings.suppressTraumas,
    senderUserId: game.user?.id ?? ""
  });
  if (!applied) {
    ui.notifications.warn(`${abilityName}: не удалось применить эффект.`);
    return false;
  }

  await createAbilityChatMessage(
    actor,
    abilityItem,
    `${targets.length} союзников в радиусе ${Math.floor(radiusMeters)} м: восстановлено ${healingAmount} ОЗ, эффект на ${formatDuration(settings.durationSeconds)}.`
  );
  return true;
}

function collectToTheEndTargets(actor, sourceToken, radiusMeters = 0) {
  const seen = new Set();
  return (canvas.tokens?.placeables ?? [])
    .filter(token => token?.actor && token.visible !== false && token.renderable !== false)
    .filter(token => token.actor.uuid !== actor?.uuid)
    .filter(token => isCommandBasicsAlly(actor, token.actor))
    .filter(token => measureTokenDistanceMeters(sourceToken, token) <= radiusMeters)
    .map(token => ({ token, actor: token.actor }))
    .filter(entry => {
      if (!entry.actor?.uuid || seen.has(entry.actor.uuid)) return false;
      seen.add(entry.actor.uuid);
      return true;
    });
}

function measureTokenDistanceMeters(leftToken, rightToken) {
  const left = getToTheEndTokenCenterPoint(leftToken);
  const right = getToTheEndTokenCenterPoint(rightToken);
  const measured = canvas?.grid?.measurePath?.([left, right]);
  const measuredDistance = Number(measured?.distance);
  if (Number.isFinite(measuredDistance)) return measuredDistance;

  const distancePixels = Number(canvas?.dimensions?.distancePixels)
    || ((Number(canvas?.dimensions?.size) || Number(canvas?.grid?.size) || 100) / (Number(canvas?.dimensions?.distance) || Number(canvas?.grid?.distance) || 1));
  return Math.hypot(left.x - right.x, left.y - right.y) / Math.max(1, distancePixels);
}

function getToTheEndTokenCenterPoint(token) {
  const object = token?.object ?? token;
  if (object?.center) {
    return {
      x: Number(object.center.x) || 0,
      y: Number(object.center.y) || 0
    };
  }
  const document = token?.document ?? token;
  const width = Number(object?.w ?? document?.width ?? 0) || 0;
  const height = Number(object?.h ?? document?.height ?? 0) || 0;
  return {
    x: (Number(object?.x ?? document?.x) || 0) + (width / 2),
    y: (Number(object?.y ?? document?.y) || 0) + (height / 2)
  };
}

async function requestToTheEndOperation(payload = {}) {
  if (game.user?.isGM) return processToTheEndOperation(payload);
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
      action: "performToTheEnd",
      requestId,
      gmUserId: gm.id,
      senderUserId: game.user?.id ?? "",
      payload
    });
  });
}

async function processToTheEndSocketRequest(message = {}) {
  const applied = await processToTheEndOperation({
    ...(message.payload ?? {}),
    senderUserId: message.senderUserId ?? message.payload?.senderUserId ?? ""
  });
  game.socket.emit(FIXED_ABILITY_SOCKET, {
    scope: FIXED_ABILITY_SOCKET_SCOPE,
    action: "toTheEndResult",
    requestId: message.requestId,
    targetUserId: message.senderUserId ?? "",
    result: { applied: Boolean(applied) }
  });
}

async function processToTheEndOperation(payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  const abilityItem = actor?.items?.get(String(payload.abilityItemId ?? ""));
  const abilityFunction = normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .find(entry => entry.id === payload.abilityFunctionId && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.toTheEnd);
  const sender = game.users?.get(String(payload.senderUserId ?? ""));
  if (!actor || !abilityItem || !abilityFunction) return false;
  if (sender && !sender.isGM && !actor.testUserPermission(sender, "OWNER")) return false;

  const targetActorUuids = Array.from(new Set((payload.targetActorUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  const targets = (await Promise.all(targetActorUuids.map(uuid => fromUuid(uuid))))
    .filter(target => target && target.uuid !== actor.uuid && isCommandBasicsAlly(actor, target));
  if (!targets.length) return false;

  const healingAmount = Math.max(0, toInteger(payload.healingAmount));
  if (healingAmount > 0) {
    await requestDamageApplications(targets.map(target => ({
      actor: target,
      amount: healingAmount,
      damageTypeKey: "healing",
      mode: "healing",
      scope: "health",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source: {
        ability: true,
        abilityItemUuid: abilityItem.uuid,
        abilityFunctionId: abilityFunction.id,
        fixedKey: ABILITY_FIXED_FUNCTION_KEYS.toTheEnd
      }
    })));
  }

  const durationSeconds = Math.max(0, toInteger(payload.durationSeconds));
  const characteristicBonus = Math.max(0, toInteger(payload.characteristicBonus));
  const advantageSkills = normalizeToTheEndSettings({ advantageSkills: payload.advantageSkills }).advantageSkills;
  const suppressTraumas = payload.suppressTraumas !== false;
  const startTime = Number(game.time?.worldTime) || 0;

  for (const target of targets) {
    const changes = buildToTheEndEffectChanges(target, {
      characteristicBonus,
      advantageSkills,
      suppressTraumas
    });
    if (!changes.length) continue;
    await target.createEmbeddedDocuments("ActiveEffect", [{
      type: "base",
      name: getAbilityDisplayName(abilityItem),
      img: abilityItem.img || "icons/svg/aura.svg",
      origin: abilityItem.uuid,
      transfer: false,
      disabled: false,
      showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
      duration: {
        seconds: durationSeconds,
        startTime
      },
      system: { changes },
      flags: {
        [SYSTEM_ID]: {
          kind: "temporary",
          [TO_THE_END_EFFECT_FLAG_KEY]: {
            abilityItemId: abilityItem.id,
            abilitySourceId: getAbilitySourceId(abilityItem),
            functionId: abilityFunction.id,
            fixedKey: ABILITY_FIXED_FUNCTION_KEYS.toTheEnd,
            createdAt: startTime
          }
        }
      }
    }], { animate: false });
  }
  return true;
}

function buildToTheEndEffectChanges(actor, {
  characteristicBonus = 0,
  advantageSkills = [],
  suppressTraumas = true
} = {}) {
  const changes = [];
  if (suppressTraumas) {
    changes.push({
      key: TRAUMA_SUPPRESSION_ALL_EFFECT_KEY,
      type: "add",
      value: "1",
      phase: "initial",
      priority: null
    });
  }
  const bonus = Math.max(0, toInteger(characteristicBonus));
  if (bonus > 0) {
    for (const key of getActorCharacteristicKeys(actor)) {
      changes.push({
        key: `system.characteristics.${key}`,
        type: "add",
        value: String(bonus),
        phase: "initial",
        priority: null
      });
    }
  }
  for (const entry of advantageSkills) {
    const skillKey = String(entry?.skillKey ?? "").trim();
    const advantageCount = Math.max(0, toInteger(entry?.advantageCount));
    if (!skillKey || advantageCount <= 0) continue;
    changes.push({
      key: `system.skills.${skillKey}.advantage`,
      type: "add",
      value: String(advantageCount),
      phase: "initial",
      priority: null
    });
  }
  return changes;
}

function getActorCharacteristicKeys(actor) {
  const configured = getCharacteristicSettings()
    .map(entry => String(entry?.key ?? "").trim())
    .filter(Boolean);
  const keys = new Set(configured);
  for (const key of Object.keys(actor?.system?.characteristics ?? {})) {
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

async function requestLookResourceLossOperation(payload = {}) {
  if (game.user?.isGM) return processLookResourceLossOperation(payload);
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
      action: "performLookResourceLoss",
      requestId,
      gmUserId: gm.id,
      senderUserId: game.user?.id ?? "",
      payload
    });
  });
}

async function processLookResourceLossSocketRequest(message = {}) {
  const applied = await processLookResourceLossOperation({
    ...(message.payload ?? {}),
    senderUserId: message.senderUserId ?? message.payload?.senderUserId ?? ""
  });
  game.socket.emit(FIXED_ABILITY_SOCKET, {
    scope: FIXED_ABILITY_SOCKET_SCOPE,
    action: "lookResourceLossResult",
    requestId: message.requestId,
    targetUserId: message.senderUserId ?? "",
    result: { applied: Boolean(applied) }
  });
}

async function processLookResourceLossOperation(payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  const actorToken = await fromUuid(String(payload.actorTokenUuid ?? ""));
  const targetToken = await fromUuid(String(payload.targetTokenUuid ?? ""));
  const abilityItem = actor?.items?.get(String(payload.abilityItemId ?? ""));
  const abilityFunction = normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .find(entry => entry.id === payload.abilityFunctionId && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.look);
  const sender = game.users?.get(String(payload.senderUserId ?? ""));
  if (!actor || !actorToken || !targetToken?.actor || !abilityItem || !abilityFunction) return false;
  if (sender && !sender.isGM && !actor.testUserPermission(sender, "OWNER")) return false;
  if (actorToken.actor?.uuid !== actor.uuid || targetToken.actor.uuid === actor.uuid) return false;
  if (!canTokenPhysicallySeeTarget(actorToken.object ?? actorToken, targetToken.object ?? targetToken)) return false;

  const resourceLoss = Math.max(0, toInteger(payload.resourceLoss));
  await spendActorActionAndMovement(targetToken.actor, resourceLoss);
  return true;
}

async function spendActorActionAndMovement(actor, amount = 0) {
  const cost = Math.max(0, toInteger(amount));
  if (!actor || cost <= 0 || !isActorInActiveCombat(actor)) {
    return { actionSpent: 0, movementSpent: 0 };
  }
  const action = actor.system?.resources?.[ACTION_RESOURCE_KEY];
  const movement = actor.system?.resources?.[MOVEMENT_RESOURCE_KEY];
  const actionCurrent = Math.max(0, toInteger(action?.value));
  const movementCurrent = Math.max(0, toInteger(movement?.value));
  const actionSpent = Math.min(cost, actionCurrent);
  const movementSpent = Math.min(cost, movementCurrent);
  const updates = {};
  if (actionSpent > 0) {
    const nextAction = Math.max(0, actionCurrent - actionSpent);
    updates[`system.resources.${ACTION_RESOURCE_KEY}.value`] = nextAction;
    if (action && Object.hasOwn(action, "spent")) {
      updates[`system.resources.${ACTION_RESOURCE_KEY}.spent`] = Math.max(0, toInteger(action.max) - nextAction);
    }
  }
  if (movementSpent > 0) {
    const nextMovement = Math.max(0, movementCurrent - movementSpent);
    updates[`system.resources.${MOVEMENT_RESOURCE_KEY}.value`] = nextMovement;
    if (movement && Object.hasOwn(movement, "spent")) {
      updates[`system.resources.${MOVEMENT_RESOURCE_KEY}.spent`] = Math.max(0, toInteger(movement.max) - nextMovement);
    }
  }
  if (Object.keys(updates).length) await actor.update(updates);
  await notifyCombatResourcesSpent(actor, {
    [ACTION_RESOURCE_KEY]: actionSpent,
    [MOVEMENT_RESOURCE_KEY]: movementSpent
  }, { type: "ability" });
  return { actionSpent, movementSpent };
}

async function requestCommandBasicsDodgeOperation(payload = {}) {
  if (game.user?.isGM) return processCommandBasicsDodgeOperation(payload);
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для выполнения команды.");
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
      action: "performCommandBasicsDodge",
      requestId,
      gmUserId: gm.id,
      senderUserId: game.user?.id ?? "",
      payload
    });
  });
}

async function processCommandBasicsDodgeSocketRequest(message = {}) {
  const applied = await processCommandBasicsDodgeOperation({
    ...(message.payload ?? {}),
    senderUserId: message.senderUserId ?? message.payload?.senderUserId ?? ""
  });
  game.socket.emit(FIXED_ABILITY_SOCKET, {
    scope: FIXED_ABILITY_SOCKET_SCOPE,
    action: "commandBasicsDodgeResult",
    requestId: message.requestId,
    targetUserId: message.senderUserId ?? "",
    result: { applied: Boolean(applied) }
  });
}

async function processCommandBasicsDodgeOperation(payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  const abilityItem = actor?.items?.get(String(payload.abilityItemId ?? ""));
  const abilityFunction = normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .find(entry => entry.id === payload.abilityFunctionId && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.commandBasics);
  const sender = game.users?.get(String(payload.senderUserId ?? ""));
  if (!actor || !abilityItem || !abilityFunction) return false;
  if (sender && !sender.isGM && !actor.testUserPermission(sender, "OWNER")) return false;

  const targetActorUuids = Array.from(new Set((payload.targetActorUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  const targets = (await Promise.all(targetActorUuids.map(uuid => fromUuid(uuid))))
    .filter(target => target && isCommandBasicsAlly(actor, target));
  if (!targets.length) return false;

  const dodgeBonus = Math.max(0, toInteger(payload.dodgeBonus));
  const durationSeconds = Math.max(0, toInteger(payload.durationSeconds));
  const startTime = Number(game.time?.worldTime) || 0;
  for (const target of targets) {
    await target.createEmbeddedDocuments("ActiveEffect", [{
      type: "base",
      name: `${getAbilityDisplayName(abilityItem)}: ${getCommandBasicsCommandLabel("duck")}`,
      img: abilityItem.img || "icons/svg/shield.svg",
      origin: abilityItem.uuid,
      transfer: false,
      disabled: false,
      showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
      duration: {
        seconds: durationSeconds,
        startTime
      },
      system: {
        changes: [{
          key: "system.resources.dodge.bonus",
          type: "add",
          value: String(dodgeBonus),
          phase: "initial",
          priority: null
        }]
      },
      flags: {
        [SYSTEM_ID]: {
          kind: "temporary",
          [COMMAND_BASICS_DODGE_EFFECT_FLAG_KEY]: {
            abilityItemId: abilityItem.id,
            abilitySourceId: getAbilitySourceId(abilityItem),
            functionId: abilityFunction.id,
            createdAt: startTime
          }
        }
      }
    }], { animate: false });
  }
  return true;
}

async function configureWatchOut(actor, abilityItem, abilityFunction) {
  const settings = normalizeWatchOutSettings(abilityFunction.fixedSettings);
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  const current = Math.max(1, Math.min(100, toInteger(
    state[stateKey]?.minimumHitChancePercent ?? settings.defaultMinimumHitChancePercent
  )));
  const formData = await DialogV2.input({
    window: { title: `${getAbilityDisplayName(abilityItem)}: настройка` },
    content: `
      <form>
        <div class="form-group stacked">
          <label>Минимальный исходный шанс попадания, %</label>
          <div class="form-fields">
            <input type="number" name="minimumHitChancePercent" value="${current}" min="1" max="100" step="1">
          </div>
        </div>
      </form>
    `,
    ok: {
      label: "Сохранить",
      icon: "fa-solid fa-floppy-disk",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{ action: "cancel", label: "Отмена" }],
    rejectClose: false
  });
  if (!formData) return false;
  const minimumHitChancePercent = Math.max(1, Math.min(100, toInteger(formData.minimumHitChancePercent)));
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    minimumHitChancePercent
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  ui.notifications.info(`${getAbilityDisplayName(abilityItem)}: порог реакции ${minimumHitChancePercent}%.`);
  return true;
}

async function useFullControl(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeFullControlSettings(abilityFunction.fixedSettings);
  if (findFullControlEffect(actor, abilityItem, abilityFunction)) {
    ui.notifications.warn(`${abilityName}: эффект уже активен.`);
    return false;
  }

  const distribution = await promptFullControlDistribution(actor, abilityItem, settings);
  if (!distribution) return false;
  if (findFullControlEffect(actor, abilityItem, abilityFunction)) {
    ui.notifications.warn(`${abilityName}: эффект уже активен.`);
    return false;
  }

  const applied = await applyFullControlEffect(actor, abilityItem, abilityFunction, settings, distribution);
  if (!applied) return false;
  await createAbilityChatMessage(actor, abilityItem, `Эффект активен на ${formatDuration(settings.durationSeconds)}.`);
  return true;
}

async function promptFullControlDistribution(actor, abilityItem, settings) {
  const rows = getFullControlCharacteristicRows(actor);
  if (!rows.length) {
    ui.notifications.warn(`${getAbilityDisplayName(abilityItem)}: не настроены характеристики.`);
    return null;
  }

  const currentEnergyMax = getActorEnergyMax(actor);
  const skillValue = getActorSkillValue(actor, settings.limitSkillKey);
  const maxChanges = Math.max(0, toInteger(settings.baseChangeLimit) + Math.floor(skillValue / Math.max(1, toInteger(settings.skillDivisor))));
  const deltas = Object.fromEntries(rows.map(row => [row.key, 0]));
  const content = `
    <div class="fallout-maw-full-control-dialog">
      <p><strong>Энергия: <span data-full-control-energy>${currentEnergyMax}</span> <span class="fallout-maw-full-control-base">(базовое: ${currentEnergyMax})</span></strong></p>
      <p>Изменения: <span data-full-control-used>0</span> / <span>${maxChanges}</span></p>
      <div class="fallout-maw-full-control-rows">
        ${rows.map(row => `
          <div class="fallout-maw-full-control-row" data-full-control-row="${escapeAttribute(row.key)}">
            <span class="fallout-maw-full-control-label">${escapeHTML(row.label)} <small>(${row.current})</small></span>
            <div class="fallout-maw-full-control-controls">
              <button type="button" data-full-control-minus="${escapeAttribute(row.key)}"><i class="fa-solid fa-minus"></i></button>
              <strong data-full-control-delta="${escapeAttribute(row.key)}">0</strong>
              <button type="button" data-full-control-plus="${escapeAttribute(row.key)}"><i class="fa-solid fa-plus"></i></button>
            </div>
          </div>
        `).join("")}
      </div>
      <p class="notes" data-full-control-message></p>
    </div>
  `;

  const result = await DialogV2.wait({
    window: { title: getAbilityDisplayName(abilityItem) },
    content,
    buttons: [
      {
        action: "apply",
        label: "Применить",
        icon: "fa-solid fa-check",
        default: true,
        disabled: true,
        callback: () => {
          const validation = validateFullControlDistribution(rows, deltas, currentEnergyMax, settings, maxChanges);
          if (!validation.valid) {
            ui.notifications.warn(validation.reason || `${getAbilityDisplayName(abilityItem)}: распределение недопустимо.`);
            return null;
          }
          return {
            deltas: Object.fromEntries(Object.entries(deltas).filter(([, value]) => toInteger(value) !== 0)),
            energyDelta: validation.energyDelta
          };
        }
      },
      {
        action: "cancel",
        label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
      }
    ],
    position: { width: 520 },
    rejectClose: false,
    render: (_event, dialog) => activateFullControlDialog(dialog, {
      rows,
      deltas,
      currentEnergyMax,
      settings,
      maxChanges
    })
  });

  return result && typeof result === "object" ? result : null;
}

function activateFullControlDialog(dialog, state) {
  const form = dialog?.element?.querySelector?.("form");
  if (!form) return;
  const update = () => syncFullControlDialog(form, state);

  for (const button of form.querySelectorAll("[data-full-control-minus]")) {
    button.addEventListener("click", event => {
      const key = String(event.currentTarget?.dataset?.fullControlMinus ?? "");
      if (!key || !Object.hasOwn(state.deltas, key)) return;
      state.deltas[key] = toInteger(state.deltas[key]) - 1;
      update();
    });
  }

  for (const button of form.querySelectorAll("[data-full-control-plus]")) {
    button.addEventListener("click", event => {
      const key = String(event.currentTarget?.dataset?.fullControlPlus ?? "");
      if (!key || !Object.hasOwn(state.deltas, key)) return;
      state.deltas[key] = toInteger(state.deltas[key]) + 1;
      update();
    });
  }

  update();
}

function syncFullControlDialog(form, state) {
  const validation = validateFullControlDistribution(
    state.rows,
    state.deltas,
    state.currentEnergyMax,
    state.settings,
    state.maxChanges
  );
  const energy = form.querySelector("[data-full-control-energy]");
  const used = form.querySelector("[data-full-control-used]");
  const message = form.querySelector("[data-full-control-message]");
  const applyButton = form.querySelector('button[data-action="apply"]');
  if (energy) energy.textContent = String(validation.finalEnergyMax);
  if (used) used.textContent = String(validation.usedChanges);
  if (message) message.textContent = validation.valid ? "" : validation.reason;
  if (applyButton) applyButton.disabled = !validation.valid;

  for (const row of state.rows) {
    const delta = toInteger(state.deltas[row.key]);
    const escapedKey = CSS.escape(row.key);
    const deltaElement = form.querySelector(`[data-full-control-delta="${escapedKey}"]`);
    if (deltaElement) deltaElement.textContent = String(delta);

    const minusButton = form.querySelector(`[data-full-control-minus="${escapedKey}"]`);
    const plusButton = form.querySelector(`[data-full-control-plus="${escapedKey}"]`);
    const canSpendMoreMinus = delta > 0 || validation.usedChanges < state.maxChanges;
    const canSpendMorePlus = delta < 0 || validation.usedChanges < state.maxChanges;
    if (minusButton) minusButton.disabled = row.current + delta <= 0 || !canSpendMoreMinus;
    if (plusButton) plusButton.disabled = validation.finalEnergyMax - state.settings.energyPerCharacteristicPoint < 0 || !canSpendMorePlus;
  }
}

function validateFullControlDistribution(rows, deltas, currentEnergyMax, settings, maxChanges) {
  const usedChanges = Object.values(deltas).reduce((total, value) => total + Math.abs(toInteger(value)), 0);
  const totalCharacteristicDelta = Object.values(deltas).reduce((total, value) => total + toInteger(value), 0);
  const energyDelta = -totalCharacteristicDelta * Math.max(0, toInteger(settings.energyPerCharacteristicPoint));
  const finalEnergyMax = currentEnergyMax + energyDelta;
  if (usedChanges <= 0) return { valid: false, reason: "Выберите хотя бы одно изменение.", usedChanges, energyDelta, finalEnergyMax };
  if (usedChanges > maxChanges) return { valid: false, reason: `Превышен лимит изменений: ${usedChanges} / ${maxChanges}.`, usedChanges, energyDelta, finalEnergyMax };
  for (const row of rows) {
    const finalValue = row.current + toInteger(deltas[row.key]);
    if (finalValue < 0) return { valid: false, reason: `${row.label}: итоговая характеристика ниже 0.`, usedChanges, energyDelta, finalEnergyMax };
  }
  if (finalEnergyMax < 0) return { valid: false, reason: "Итоговый максимум энергии ниже 0.", usedChanges, energyDelta, finalEnergyMax };
  return { valid: true, reason: "", usedChanges, energyDelta, finalEnergyMax };
}

function getFullControlCharacteristicRows(actor) {
  const configured = getCharacteristicSettings()
    .map(entry => ({
      key: String(entry?.key ?? "").trim(),
      label: String(entry?.label || entry?.key || "").trim()
    }))
    .filter(entry => entry.key);
  const configuredKeys = new Set(configured.map(entry => entry.key));
  const fallback = Object.keys(actor?.system?.characteristics ?? {})
    .filter(key => !configuredKeys.has(key))
    .map(key => ({ key, label: key }));
  return [...configured, ...fallback].map(entry => ({
    ...entry,
    current: Math.max(0, toInteger(actor?.system?.characteristics?.[entry.key]))
  }));
}

function getActorEnergyMax(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.max));
}

async function applyFullControlEffect(actor, abilityItem, abilityFunction, settings, distribution) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const deltas = distribution?.deltas && typeof distribution.deltas === "object" ? distribution.deltas : {};
  const changes = Object.entries(deltas)
    .map(([key, value]) => [String(key ?? "").trim(), toInteger(value)])
    .filter(([key, value]) => key && value !== 0)
    .map(([key, value]) => ({
      key: `system.characteristics.${key}`,
      type: "add",
      value: String(value),
      phase: "initial",
      priority: null
    }));
  const energyDelta = toInteger(distribution?.energyDelta);
  if (energyDelta !== 0) {
    changes.push({
      key: `system.resources.${ENERGY_RESOURCE_KEY}.bonus`,
      type: "add",
      value: String(energyDelta),
      phase: "initial",
      priority: null
    });
  }
  if (!changes.length) return false;

  const startTime = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: getAbilityDisplayName(abilityItem),
    img: abilityItem.img || "icons/svg/upgrade.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: Math.max(0, toInteger(settings.durationSeconds)),
      startTime
    },
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [FULL_CONTROL_EFFECT_FLAG_KEY]: {
          fixedKey: ABILITY_FIXED_FUNCTION_KEYS.fullControl,
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          deltas: foundry.utils.deepClone(deltas),
          energyDelta,
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  return true;
}

function findFullControlEffect(actor, abilityItem, abilityFunction) {
  if (!actor || !abilityItem || !abilityFunction) return null;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const functionId = String(abilityFunction.id ?? "").trim();
  return Array.from(actor.effects ?? []).find(effect => {
    if (effect?.disabled || effect?.isExpired) return false;
    const data = effect.getFlag?.(SYSTEM_ID, FULL_CONTROL_EFFECT_FLAG_KEY);
    if (!data || data.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.fullControl) return false;
    return String(data.abilityItemId ?? "").trim() === abilityItemId
      && String(data.functionId ?? "").trim() === functionId;
  }) ?? null;
}

function registerWatchOutReactionProvider() {
  registerReactionProvider({
    id: WATCH_OUT_REACTION_PROVIDER_ID,
    collect: runFixedAbilityRuntimeHandler(collectWatchOutReactionOffers),
    execute: runFixedAbilityRuntimeHandler(executeWatchOutReaction)
  });
}

async function collectWatchOutReactionOffers({ eventKey = "", context = {} } = {}) {
  if (eventKey !== REACTION_EVENT_KEYS.weaponAttackCommitted) return [];
  const attacker = await fromUuid(String(context.attackerActorUuid ?? ""));
  const attackerToken = await fromUuid(String(context.attackerTokenUuid ?? ""));
  const target = await fromUuid(String(context.targetActorUuid ?? ""));
  const targetToken = await fromUuid(String(context.targetTokenUuid ?? ""));
  const originalHitChance = Math.max(0, Math.min(100, toInteger(context.originalHitChance)));
  if (!attacker || !attackerToken || !target || !targetToken || attacker.uuid === target.uuid) return [];

  const offers = [];
  const seenActors = new Set();
  for (const reactorToken of attackerToken.parent?.tokens?.contents ?? []) {
    const reactor = reactorToken?.actor;
    if (!reactor || seenActors.has(reactor.uuid)) continue;
    if ([attacker.uuid, target.uuid].includes(reactor.uuid)) continue;
    if (!areCounterSniperActorsAllied(reactor, target)) continue;
    const entry = getActorWatchOutEntry(reactor);
    if (!entry || entry.minimumHitChancePercent > originalHitChance) continue;
    const reactorTokenObject = reactorToken.object ?? reactorToken;
    if (!canTokenPhysicallySeeTarget(reactorTokenObject, attackerToken.object ?? attackerToken)) continue;
    if (!canTokenPhysicallySeeTarget(reactorTokenObject, targetToken.object ?? targetToken)) continue;
    const energyCost = getAbilityEnergyCost(reactor, entry.abilityItem, entry.abilityFunction, entry.settings.reactionEnergyCost);
    if (!hasEnergy(reactor, energyCost)) continue;
    seenActors.add(reactor.uuid);
    offers.push({
      actorUuid: reactor.uuid,
      offerId: `${WATCH_OUT_REACTION_PROVIDER_ID}:${reactor.uuid}:${context.attackId ?? foundry.utils.randomID()}`,
      label: getAbilityDisplayName(entry.abilityItem),
      description: `Предупредить ${target.name} об атаке ${attacker.name}. Исходный шанс: ${originalHitChance}%.`,
      img: entry.abilityItem.img || "icons/svg/shield.svg",
      costLines: [`Энергия: ${entry.settings.reactionEnergyCost} базовая / ${energyCost} итоговая`],
      abilityItemId: entry.abilityItem.id,
      abilityFunctionId: entry.abilityFunction.id,
      reactorTokenUuid: reactorToken.uuid,
      attackerTokenUuid: attackerToken.uuid,
      targetTokenUuid: targetToken.uuid,
      originalHitChance,
      energyCost
    });
  }
  return offers;
}

async function executeWatchOutReaction({ context = {}, offer = {} } = {}) {
  const reactor = await fromUuid(String(offer.actorUuid ?? ""));
  const reactorToken = await fromUuid(String(offer.reactorTokenUuid ?? ""));
  const attackerToken = await fromUuid(String(offer.attackerTokenUuid ?? context.attackerTokenUuid ?? ""));
  const targetToken = await fromUuid(String(offer.targetTokenUuid ?? context.targetTokenUuid ?? ""));
  const entry = getActorWatchOutEntry(reactor, offer);
  const originalHitChance = Math.max(0, Math.min(100, toInteger(context.originalHitChance ?? offer.originalHitChance)));
  if (!reactor || !reactorToken || !attackerToken || !targetToken || !entry) return { handled: false };
  if (entry.minimumHitChancePercent > originalHitChance) return { handled: false };
  if (!areCounterSniperActorsAllied(reactor, targetToken.actor)) return { handled: false };
  if (!canTokenPhysicallySeeTarget(reactorToken.object ?? reactorToken, attackerToken.object ?? attackerToken)) return { handled: false };
  if (!canTokenPhysicallySeeTarget(reactorToken.object ?? reactorToken, targetToken.object ?? targetToken)) return { handled: false };
  const energyCost = getAbilityEnergyCost(reactor, entry.abilityItem, entry.abilityFunction, entry.settings.reactionEnergyCost);
  if (!hasEnergy(reactor, energyCost)) return { handled: false };

  await spendEnergy(reactor, energyCost);
  await applyAbilityOverloadEffect(reactor, entry.abilityItem, entry.abilityFunction, {
    name: getAbilityOverloadName(entry.abilityItem),
    energyCost: entry.settings.reactionOverloadEnergyCost,
    durationSeconds: entry.settings.reactionOverloadDurationSeconds
  });
  const difficultyBonus = entry.settings.difficultyBase
    + Math.floor(getActorSkillValue(reactor, entry.settings.sourceSkillKey) / entry.settings.skillDivisor);
  await createAbilityChatMessage(reactor, entry.abilityItem, `Сложность текущей атаки увеличена на ${difficultyBonus}.`);
  return { handled: true, status: REACTION_RESULT.success, difficultyBonus };
}

function getActorWatchOutEntry(actor, offer = null) {
  const abilityItemId = String(offer?.abilityItemId ?? "");
  const abilityFunctionId = String(offer?.abilityFunctionId ?? "");
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    if (abilityItemId && abilityItem.id !== abilityItemId) continue;
    const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .find(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.watchOut && (!abilityFunctionId || entry.id === abilityFunctionId));
    if (!abilityFunction) continue;
    const settings = normalizeWatchOutSettings(abilityFunction.fixedSettings);
    const state = getFixedAbilityState(abilityItem);
    const minimumHitChancePercent = Math.max(1, Math.min(100, toInteger(
      state[getFixedFunctionStateKey(abilityFunction)]?.minimumHitChancePercent ?? settings.defaultMinimumHitChancePercent
    )));
    return { abilityItem, abilityFunction, settings, minimumHitChancePercent };
  }
  return null;
}

const OVERSIGHT_ACTIONS = Object.freeze([
  { key: "aimedShot", label: "Прицельный выстрел" },
  { key: "snapshot", label: "Неприцельный выстрел" },
  { key: "aimedMeleeAttack", label: "Прицельный удар" },
  { key: "meleeAttack", label: "Неприцельный удар" }
]);
let oversightVisibilityRefreshTimeout = 0;
const pendingOversightVisibilityChecks = new Set();

async function useOversight(actor, abilityItem, abilityFunction) {
  const settings = normalizeOversightSettings(abilityFunction.fixedSettings);
  const combat = game.combat;
  const sourceToken = getActorSceneToken(actor);
  const targetToken = getSingleUserTarget();
  const abilityName = getAbilityDisplayName(abilityItem);
  if (!combat?.started || !sourceToken || !isTokenActiveCombatant(combat, sourceToken.document)) {
    ui.notifications.warn(`${abilityName}: способность применяется только участником активного боя.`);
    return false;
  }
  if (!targetToken || !isTokenActiveCombatant(combat, targetToken.document)) {
    ui.notifications.warn(`${abilityName}: выберите одну цель — участника боя.`);
    return false;
  }
  if (targetToken.actor?.uuid === actor.uuid) {
    ui.notifications.warn(`${abilityName}: нельзя выбрать себя.`);
    return false;
  }
  if (!canTokenPhysicallySeeTarget(sourceToken, targetToken)) {
    ui.notifications.warn(`${abilityName}: цель не видна.`);
    return false;
  }
  if (findOversightTrackingEffects(targetToken.actor).some(effect => {
    const data = effect.getFlag(SYSTEM_ID, OVERSIGHT_EFFECT_FLAG_KEY) ?? {};
    return data.sourceActorUuid === actor.uuid;
  })) {
    ui.notifications.warn(`${abilityName}: эта цель уже находится под вашим Надзором.`);
    return false;
  }

  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`${abilityName}: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  await spendEnergy(actor, energyCost);
  await applyAbilityOverloadEffect(actor, abilityItem, abilityFunction, {
    name: getAbilityOverloadName(abilityItem),
    energyCost: settings.overloadEnergyCost,
    durationSeconds: settings.overloadDurationSeconds
  });

  const sourceSkillValue = getActorSkillValue(actor, settings.sourceSkillKey);
  const difficulty = settings.difficultyBase + sourceSkillValue;
  const recoveryPenalty = Math.max(0, Math.floor(sourceSkillValue / settings.dodgeRecoveryDivisor));
  const outcome = await requestOversightStealthCheck(targetToken.actor, settings.targetSkillKey, difficulty, abilityName, {
    actorToken: targetToken,
    targetActor: actor,
    targetToken: sourceToken
  });
  if (isSuccessfulSkillCheck(outcome)) {
    await createAbilityChatMessage(actor, abilityItem, `${targetToken.actor.name} избежал Надзора.`);
    return true;
  }

  const activationId = foundry.utils.randomID();
  await createOversightTrackingEffect(targetToken.actor, {
    activationId,
    combatId: combat.id,
    sourceActorUuid: actor.uuid,
    sourceTokenUuid: sourceToken.document.uuid,
    targetTokenUuid: targetToken.document.uuid,
    abilityItemUuid: abilityItem.uuid,
    abilityItemId: abilityItem.id,
    abilityFunctionId: abilityFunction.id,
    abilityName,
    abilityImg: abilityItem.img,
    targetSkillKey: settings.targetSkillKey,
    difficulty,
    recoveryPenalty,
    resourceThreshold: settings.resourceThreshold,
    accumulatedSpend: 0
  });
  await createAbilityChatMessage(actor, abilityItem, `${targetToken.actor.name} отмечен Надзором.`);
  return true;
}

async function requestOversightStealthCheck(actor, skillKey, difficulty, abilityName, {
  actorToken = null,
  targetActor = null,
  targetToken = null
} = {}) {
  return requestSkillCheck({
    actor,
    skillKey,
    data: { difficulty, actorToken, targetActor, targetToken },
    animate: false,
    prompt: false,
    requester: "oversight",
    messageData: { flavor: abilityName }
  });
}

function isSuccessfulSkillCheck(outcome) {
  return ["success", "criticalSuccess"].includes(String(outcome?.result?.key ?? outcome?.result ?? ""));
}

async function createOversightTrackingEffect(actor, data) {
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: `${data.abilityName}: метка`,
    img: data.abilityImg || "icons/svg/eye.svg",
    origin: data.abilityItemUuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: { expiry: "combatEnd" },
    system: {
      changes: data.recoveryPenalty > 0 ? [{
        key: DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY,
        type: "add",
        value: String(-data.recoveryPenalty),
        phase: "initial",
        priority: null
      }] : []
    },
    flags: { [SYSTEM_ID]: { kind: "temporary", [OVERSIGHT_EFFECT_FLAG_KEY]: data } }
  }], { animate: false });
}

function findOversightTrackingEffects(actor) {
  return Array.from(actor?.effects ?? []).filter(effect => Boolean(effect.getFlag?.(SYSTEM_ID, OVERSIGHT_EFFECT_FLAG_KEY)));
}

function scheduleOversightVisibilityRefresh() {
  if (!game.user?.isActiveGM) return;
  window.clearTimeout(oversightVisibilityRefreshTimeout);
  oversightVisibilityRefreshTimeout = window.setTimeout(() => {
    void refreshOversightVisibility();
  }, 100);
}

async function refreshOversightVisibility() {
  if (!game.user?.isActiveGM || !canvas?.ready) return;
  for (const actor of getOversightActors()) {
    for (const effect of findOversightTrackingEffects(actor)) {
      if (pendingOversightVisibilityChecks.has(effect.uuid)) continue;
      pendingOversightVisibilityChecks.add(effect.uuid);
      try {
        await refreshOversightEffectVisibility(effect);
      } finally {
        pendingOversightVisibilityChecks.delete(effect.uuid);
      }
    }
  }
}

async function refreshOversightEffectVisibility(effect) {
  const data = effect.getFlag(SYSTEM_ID, OVERSIGHT_EFFECT_FLAG_KEY) ?? {};
  if (!game.combat?.started || data.combatId !== game.combat.id) return;
  const sourceDocument = await fromUuid(String(data.sourceTokenUuid ?? ""));
  const targetDocument = await fromUuid(String(data.targetTokenUuid ?? ""));
  if (!sourceDocument || !targetDocument) {
    await deleteOversightActivation(effect.parent, data.activationId);
    return;
  }
  const visible = canTokenPhysicallySeeTarget(sourceDocument.object ?? sourceDocument, targetDocument.object ?? targetDocument);
  const iconVisible = Number(effect.showIcon ?? effect._source?.showIcon) === ACTIVE_EFFECT_SHOW_ICON_ALWAYS;
  if (!visible) {
    if (iconVisible || effect.name !== `${data.abilityName}: метка`) {
      await effect.update({ name: `${data.abilityName}: метка`, showIcon: 0 });
    }
    return;
  }
  if (iconVisible) return;
  const outcome = await requestOversightStealthCheck(effect.parent, data.targetSkillKey, data.difficulty, data.abilityName, {
    actorToken: targetDocument.object ?? targetDocument,
    targetActor: sourceDocument.actor,
    targetToken: sourceDocument.object ?? sourceDocument
  });
  if (isSuccessfulSkillCheck(outcome)) {
    await deleteOversightActivation(effect.parent, data.activationId);
    return;
  }
  await effect.update({ name: `${data.abilityName}: метка`, showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS });
}

async function deleteOversightActivation(actor, activationId) {
  const ids = findOversightTrackingEffects(actor)
    .filter(effect => effect.getFlag(SYSTEM_ID, OVERSIGHT_EFFECT_FLAG_KEY)?.activationId === activationId)
    .map(effect => effect.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { animate: false });
}

async function cleanupOversightToken(token) {
  if (!game.user?.isActiveGM) return;
  for (const actor of getOversightActors()) {
    for (const effect of findOversightTrackingEffects(actor)) {
      const data = effect.getFlag(SYSTEM_ID, OVERSIGHT_EFFECT_FLAG_KEY) ?? {};
      if ([data.sourceTokenUuid, data.targetTokenUuid].includes(token?.uuid)) {
        await deleteOversightActivation(actor, data.activationId);
      }
    }
  }
}

function getOversightActors() {
  const actors = new Map();
  for (const actor of game.actors?.contents ?? []) if (actor?.uuid) actors.set(actor.uuid, actor);
  for (const token of canvas?.tokens?.placeables ?? []) if (token.actor?.uuid) actors.set(token.actor.uuid, token.actor);
  return [...actors.values()];
}

function registerOversightMovementProvider() {
  registerMovementInterruptionProvider({
    id: OVERSIGHT_MOVEMENT_PROVIDER_ID,
    collect: runFixedAbilityRuntimeHandler(collectOversightMovementInterruptions),
    execute: runFixedAbilityRuntimeHandler(resumeOversightMovement)
  });
}

function collectOversightMovementInterruptions({ tokenDocument, movement } = {}) {
  const effects = findOversightTrackingEffects(tokenDocument?.actor);
  if (!effects.length || !movement) return [];
  const needed = Math.min(...effects.map(effect => {
    const data = effect.getFlag(SYSTEM_ID, OVERSIGHT_EFFECT_FLAG_KEY) ?? {};
    const threshold = Math.max(1, toInteger(data.resourceThreshold));
    return Math.max(1, threshold - Math.max(0, toInteger(data.accumulatedSpend)));
  }));
  const passedWaypoints = Array.from(movement.passed?.waypoints ?? []);
  if (!passedWaypoints.length) return [];
  const routeProgress = getMovementRouteWaypointProgress(tokenDocument, movement);
  let rawCost = 0;
  for (const [index, waypoint] of passedWaypoints.entries()) {
    rawCost += Math.max(0, Number(waypoint?.cost) || 0);
    const cost = applyCombatMovementCostModifier(tokenDocument.actor, Math.ceil(rawCost));
    if (cost < needed) continue;
    const remainingWaypoints = prepareFixedMovementWaypoints([
      ...passedWaypoints.slice(index + 1),
      ...(movement.pending?.waypoints ?? [])
    ]);
    return [{
      type: REACTION_EVENT_KEYS.oversightThreshold,
      eventId: `${movement.id ?? foundry.utils.randomID()}:${index}`,
      routeOrder: routeProgress[index + 1]?.routeOrder ?? (index + 1),
      priority: -90,
      waypoint,
      remainingWaypoints
    }];
  }
  return [];
}

async function resumeOversightMovement({
  tokenDocument,
  movement,
  event,
  options,
  chainRef = null,
  isCurrent = null
} = {}) {
  const waypoints = Array.isArray(event?.remainingWaypoints) ? event.remainingWaypoints : [];
  await waitForCombatResourceSpending(tokenDocument?.actor);
  if (typeof isCurrent === "function" && !isCurrent()) return false;
  if (!tokenDocument || !waypoints.length || isActorUnableToAct(tokenDocument.actor)) return false;
  return withMovementResumeContext(
    tokenDocument,
    INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION,
    { chainRef },
    () => tokenDocument.move(waypoints, {
      ...createMovementOptions(movement, options, {
        chainRef,
        split: false,
        showRuler: movement?.showRuler
      }),
      [INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION]: true
    })
  );
}

function registerOversightReactionProvider() {
  registerReactionProvider({
    id: OVERSIGHT_REACTION_PROVIDER_ID,
    collect: runFixedAbilityRuntimeHandler(collectOversightReactionOffers),
    execute: runFixedAbilityRuntimeHandler(executeOversightReaction)
  });
}

async function collectOversightReactionOffers({ eventKey, context = {}, semanticEvent = null } = {}) {
  if (![OVERSIGHT_RESOURCE_SPENT_EVENT_KEY, REACTION_EVENT_KEYS.oversightThreshold].includes(eventKey)) return [];
  const envelope = semanticEvent ?? context.semanticEvent ?? context.envelope ?? null;
  if (envelope?.key !== OVERSIGHT_RESOURCE_SPENT_EVENT_KEY) return [];
  const targetActorUuid = String(envelope?.data?.actorUuid ?? envelope?.source?.actorUuid ?? "").trim();
  const targetActor = targetActorUuid ? await fromUuid(targetActorUuid) : null;
  if (!targetActor) return [];

  const offers = [];
  for (const tracking of findOversightTrackingEffects(targetActor)) {
    const data = foundry.utils.deepClone(tracking.getFlag(SYSTEM_ID, OVERSIGHT_EFFECT_FLAG_KEY) ?? {});
    const threshold = advanceOversightResourceThreshold(data, envelope?.data?.resources ?? {});
    if (threshold.spent <= 0) continue;
    data.accumulatedSpend = threshold.accumulatedSpend;
    await tracking.update({ [`flags.${SYSTEM_ID}.${OVERSIGHT_EFFECT_FLAG_KEY}`]: data });
    if (threshold.triggerCount <= 0) continue;

    const sourceActor = await fromUuid(String(data.sourceActorUuid ?? ""));
    const sourceToken = await fromUuid(String(data.sourceTokenUuid ?? ""));
    const targetToken = await fromUuid(String(data.targetTokenUuid ?? ""));
    if (!sourceActor || !sourceToken || !targetToken || targetToken.actor?.uuid !== targetActor.uuid) continue;
    const candidates = getOversightAttackCandidates(sourceActor, sourceToken, targetToken);
    if (!candidates.length) continue;
    offers.push({
      actorUuid: sourceActor.uuid,
      reactionId: OVERSIGHT_REACTION_PROVIDER_ID,
      offerId: `${OVERSIGHT_REACTION_PROVIDER_ID}:${data.activationId}:${envelope.eventId}`,
      label: data.abilityName || "Надзор",
      description: `Атаковать ${targetActor.name}.`,
      img: data.abilityImg || "icons/svg/eye.svg",
      activationId: data.activationId,
      sourceTokenUuid: sourceToken.uuid,
      targetTokenUuid: targetToken.uuid
    });
  }
  return offers;
}

async function executeOversightReaction({ offer } = {}) {
  const sourceActor = await fromUuid(String(offer.actorUuid ?? ""));
  const sourceToken = await fromUuid(String(offer.sourceTokenUuid ?? ""));
  const targetToken = await fromUuid(String(offer.targetTokenUuid ?? ""));
  if (!sourceActor || !sourceToken || !targetToken) return { handled: false };
  const candidates = getOversightAttackCandidates(sourceActor, sourceToken, targetToken);
  if (!candidates.length) return { handled: false };
  const selected = candidates.length === 1 ? candidates[0] : await queryOversightAttackOwner(sourceActor, targetToken, candidates);
  if (!selected) return { handled: true, status: REACTION_RESULT.declined };
  if (!canPerformOversightAttackAgainstToken({
    attackerToken: sourceToken,
    targetToken,
    weapon: selected.weapon,
    actionKey: selected.actionKey,
    weaponFunctionId: selected.weaponFunctionId
  })) return { handled: true, status: REACTION_RESULT.failed };
  let used = false;
  if (["aimedShot", "aimedMeleeAttack"].includes(selected.actionKey)) {
    const owner = game.users?.get(getActorResponsibleUserId(sourceActor));
    if (!owner) return { handled: true, status: REACTION_RESULT.failed };
    used = await queryOversightOwner(owner, {
      mode: "aim",
      sourceTokenUuid: sourceToken.uuid,
      targetTokenUuid: targetToken.uuid,
      weaponUuid: selected.weapon.uuid,
      weaponFunctionId: selected.weaponFunctionId,
      actionKey: selected.actionKey
    }, 120000);
  } else {
    used = await executeWeaponAttackAgainstToken({
      attackerToken: sourceToken.object ?? sourceToken,
      targetToken: targetToken.object ?? targetToken,
      weapon: selected.weapon,
      actionKey: selected.actionKey,
      weaponFunctionId: selected.weaponFunctionId,
      skipActionPointCost: true,
      ignoreReactionLock: true
    });
  }
  return { handled: true, status: used ? REACTION_RESULT.success : REACTION_RESULT.failed };
}

function getOversightAttackCandidates(actor, sourceToken, targetToken) {
  const candidates = [];
  for (const weapon of actor?.items?.contents ?? []) {
    if (weapon.type !== "gear" || !getDeployedWeaponSetKey(weapon) || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) continue;
    for (const weaponFunctionId of getWhirlwindWeaponFunctionIds(weapon)) {
      for (const action of OVERSIGHT_ACTIONS) {
        if (!hasWeaponAction(weapon, action.key, weaponFunctionId)) continue;
        if (!canPerformOversightAttackAgainstToken({ attackerToken: sourceToken, targetToken, weapon, actionKey: action.key, weaponFunctionId })) continue;
        candidates.push({ weapon, weaponFunctionId, actionKey: action.key, actionLabel: action.label });
      }
    }
  }
  return candidates;
}

function canPerformOversightAttackAgainstToken(options = {}) {
  return options.actionKey === "aimedShot"
    ? canPerformAimedAttackAgainstToken(options)
    : canPerformWeaponActionAgainstToken(options);
}

async function queryOversightAttackOwner(actor, targetToken, candidates) {
  const user = game.users?.get(getActorResponsibleUserId(actor));
  if (!user) return null;
  try {
    const weapons = Array.from(new Map(candidates.map(candidate => [candidate.weapon.id, {
      weaponId: candidate.weapon.id,
      weaponName: candidate.weapon.name,
      img: normalizeImagePath(candidate.weapon.img, "icons/svg/sword.svg")
    }])).values());
    const weaponResponse = await queryOversightOwner(user, {
      mode: "weapon",
      targetName: targetToken.actor?.name ?? "",
      weapons
    });
    const weaponId = String(weaponResponse?.weaponId ?? "");
    if (!weaponId) return null;

    const weaponCandidates = candidates.filter(candidate => candidate.weapon.id === weaponId);
    const actions = Array.from(new Map(weaponCandidates.map(candidate => [candidate.actionKey, {
      actionKey: candidate.actionKey,
      actionLabel: candidate.actionLabel
    }])).values());
    const actionResponse = await queryOversightOwner(user, {
      mode: "action",
      targetName: targetToken.actor?.name ?? "",
      weaponName: weapons.find(weapon => weapon.weaponId === weaponId)?.weaponName ?? "",
      actions
    });
    const actionKey = String(actionResponse?.actionKey ?? "");
    return weaponCandidates.find(candidate => candidate.actionKey === actionKey) ?? null;
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Oversight attack query failed`, error);
    return null;
  }
}

function queryOversightOwner(user, data, timeout = 30000) {
  return user.isSelf
    ? handleOversightAttackQuery(data)
    : user.query(OVERSIGHT_QUERY_NAME, data, { timeout });
}

async function handleOversightAttackQuery(data = {}) {
  if (data.mode === "aim") {
    const sourceTokenDocument = await fromUuid(String(data.sourceTokenUuid ?? ""));
    const targetTokenDocument = await fromUuid(String(data.targetTokenUuid ?? ""));
    const weapon = await fromUuid(String(data.weaponUuid ?? ""));
    if (!sourceTokenDocument?.actor?.isOwner || !targetTokenDocument?.actor || !weapon) return false;
    return startForcedAimedAttackSelection({
      attackerToken: sourceTokenDocument.object ?? sourceTokenDocument,
      targetToken: targetTokenDocument.object ?? targetTokenDocument,
      weapon,
      weaponFunctionId: String(data.weaponFunctionId ?? ""),
      actionKey: String(data.actionKey ?? ""),
      label: "Надзор"
    });
  }
  const weaponMode = data.mode === "weapon";
  const entries = weaponMode
    ? (Array.isArray(data.weapons) ? data.weapons : [])
    : (Array.isArray(data.actions) ? data.actions : []);
  if (!entries.length) return null;
  const options = entries.map((entry, index) => weaponMode ? `
    <label class="fallout-maw-radio-card fallout-maw-weapon-choice-card">
      <input type="radio" name="weaponId" value="${escapeAttribute(entry.weaponId)}" ${index === 0 ? "checked" : ""}>
      <img src="${escapeAttribute(entry.img)}" alt="">
      <span><strong>${escapeHTML(entry.weaponName)}</strong></span>
    </label>` : `
    <label class="fallout-maw-radio-card">
      <input type="radio" name="actionKey" value="${escapeAttribute(entry.actionKey)}" ${index === 0 ? "checked" : ""}>
      <span><strong>${escapeHTML(entry.actionLabel)}</strong></span>
    </label>`).join("");
  const formData = await DialogV2.input({
    window: { title: weaponMode ? "Надзор: выбор оружия" : "Надзор: выбор действия" },
    content: `<div class="fallout-maw-disarm-choice-grid"><p>Цель: <strong>${escapeHTML(data.targetName)}</strong></p>${weaponMode ? "" : `<p>Оружие: <strong>${escapeHTML(data.weaponName)}</strong></p>`}${options}</div>`,
    ok: { label: weaponMode ? "Далее" : "Атаковать", icon: weaponMode ? "fa-solid fa-arrow-right" : "fa-solid fa-crosshairs", callback: (_event, button) => new FormDataExtended(button.form).object },
    buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
    position: { width: 520 },
    rejectClose: false
  });
  if (weaponMode) return formData?.weaponId ? { weaponId: String(formData.weaponId) } : null;
  return formData?.actionKey ? { actionKey: String(formData.actionKey) } : null;
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
    if (weapon.type !== "gear") continue;
    const weaponSet = getDeployedWeaponSetKey(weapon);
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
    if (weapon.type !== "gear") continue;
    const weaponSet = getDeployedWeaponSetKey(weapon);
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
    graphics.eventMode = "none";
    graphics.interactive = false;
    graphics.zIndex = Number.MAX_SAFE_INTEGER;
    const layer = canvas.interface ?? canvas.tokens ?? null;
    if (!layer) {
      graphics.destroy();
      ui.notifications.warn(`${abilityName}: слой предпросмотра атаки недоступен.`);
      resolve(null);
      return;
    }
    let targetSelectionSession = null;
    let finished = false;
    let refreshTimerId = null;
    let refreshPending = false;
    const hookBindings = [];
    const sourceTokenUuid = String(token?.document?.uuid ?? token?.uuid ?? "");
    const isCanvasEvent = event => {
      const view = canvas.app?.view;
      if (!view || !event) return false;
      return event.target === view || Array.from(event.composedPath?.() ?? []).includes(view);
    };
    const refreshCandidates = () => {
      if (refreshTimerId !== null) globalThis.clearTimeout(refreshTimerId);
      refreshTimerId = null;
      refreshPending = false;
      if (finished) return;
      candidates = buildLungeDestinationCandidates(token, settings);
      drawLungeDestinationCandidates(graphics, candidates);
    };
    const scheduleCandidateRefresh = () => {
      if (finished) return;
      refreshPending = true;
      if (refreshTimerId === null) {
        refreshTimerId = globalThis.setTimeout(refreshCandidates, 50);
      }
    };
    const cleanup = () => {
      if (refreshTimerId !== null) globalThis.clearTimeout(refreshTimerId);
      refreshTimerId = null;
      refreshPending = false;
      for (const [hook, id] of hookBindings.splice(0)) Hooks.off(hook, id);
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      rightClickGuard.deactivate();
      graphics.parent?.removeChild?.(graphics);
      if (!graphics.destroyed) graphics.destroy();
    };
    const finish = (value, { fromLifecycle = false } = {}) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!fromLifecycle) targetSelectionSession?.finish({ cancelled: !value });
      resolve(value);
    };
    const rightClickGuard = createRightClickPanGuard({
      isCanvasEvent,
      onClick: () => finish(null)
    });
    const onPointerDown = event => {
      if (!isCanvasEvent(event)) return;
      if (![0, 2].includes(event.button)) return;
      if (event.button === 2) {
        rightClickGuard.onPointerDown(event);
        return;
      }
      if (refreshPending) refreshCandidates();
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
    const bindHook = (hook, callback) => {
      const id = Hooks.on(hook, callback);
      hookBindings.push([hook, id]);
    };

    layer.addChild(graphics);
    drawLungeDestinationCandidates(graphics, candidates);
    targetSelectionSession = startCanvasTargetSelectionSession({
      kind: "destination",
      token,
      abilityName
    }, {
      onCancel: () => finish(null, { fromLifecycle: true })
    });
    if (targetSelectionSession.finished || finished) return;

    bindHook("refreshToken", (_updatedToken, flags = {}) => {
      if (flags.refreshPosition || flags.refreshSize || flags.refreshShape) {
        scheduleCandidateRefresh();
      }
    });
    bindHook("updateToken", (_tokenDocument, changes = {}) => {
      if (changedDataIntersectsPaths(changes, [
        "x", "y", "elevation", "width", "height", "depth", "hidden", "shape"
      ])) scheduleCandidateRefresh();
    });
    for (const hook of ["createToken", "drawToken"]) {
      bindHook(hook, scheduleCandidateRefresh);
    }
    for (const hook of ["deleteToken", "destroyToken"]) {
      bindHook(hook, removedToken => {
        const removedUuid = String(removedToken?.document?.uuid ?? removedToken?.uuid ?? "");
        if (sourceTokenUuid && removedUuid === sourceTokenUuid) {
          targetSelectionSession?.cancel({ reason: "sourceTokenDeleted" });
          return;
        }
        scheduleCandidateRefresh();
      });
    }
    for (const operation of ["create", "update", "delete"]) {
      bindHook(`${operation}Wall`, scheduleCandidateRefresh);
    }
    bindHook("updateScene", (_scene, changes = {}) => {
      if (changedDataIntersectsPaths(changes, ["grid"])) scheduleCandidateRefresh();
    });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    rightClickGuard.activate();
    ui.notifications.info(`${abilityName}: выберите клетку перемещения. ПКМ отменяет, зажатие ПКМ двигает камеру.`);
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
  const layer = canvas.interface ?? canvas.tokens ?? null;
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
  CONFIG.queries[DISARM_QUERY_NAME] = runFixedAbilityRuntimeHandler(handleDisarmQuery);
  registerReactionProvider({
    id: DISARM_REACTION_PROVIDER_ID,
    collect: runFixedAbilityRuntimeHandler(collectDisarmReactionOffers),
    execute: runFixedAbilityRuntimeHandler(executeDisarmReaction)
  });
}

function registerCounterAttackReactionProvider() {
  registerReactionProvider({
    id: COUNTER_ATTACK_REACTION_PROVIDER_ID,
    collect: runFixedAbilityRuntimeHandler(collectCounterAttackReactionOffers),
    execute: runFixedAbilityRuntimeHandler(executeCounterAttackReaction)
  });
}

function registerWhereAreYouGoingReactionProvider() {
  CONFIG.queries[WHERE_ARE_YOU_GOING_WEAPON_QUERY_NAME] = runFixedAbilityRuntimeHandler(handleWhereAreYouGoingWeaponQuery);
  registerReactionProvider({
    id: WHERE_ARE_YOU_GOING_REACTION_PROVIDER_ID,
    collect: runFixedAbilityRuntimeHandler(collectWhereAreYouGoingReactionOffers),
    execute: runFixedAbilityRuntimeHandler(executeWhereAreYouGoingReaction)
  });
}

function registerWhereAreYouGoingMovementProvider() {
  registerMovementInterruptionProvider({
    id: WHERE_ARE_YOU_GOING_MOVEMENT_PROVIDER_ID,
    collect: runFixedAbilityRuntimeHandler(collectWhereAreYouGoingMovementInterruptions),
    execute: runFixedAbilityRuntimeHandler(executeWhereAreYouGoingMovementInterruption),
    synchronizeOnMove: true,
    synchronize: runFixedAbilityRuntimeHandler(synchronizeWhereAreYouGoingSuppression)
  });
}

function collectWhereAreYouGoingMovementInterruptions({ tokenDocument, movement, options = {} } = {}) {
  const mover = tokenDocument?.actor;
  const combat = getActiveSceneCombat(tokenDocument?.parent);
  if (!mover || !combat || !isTokenActiveCombatant(combat, tokenDocument)) return [];
  const resumeContext = getMovementResumeContext(
    tokenDocument,
    movement,
    options,
    INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION
  );
  const tokenKey = getWhereAreYouGoingTokenKey(tokenDocument);
  const skippedReactorTokenUuids = new Set([
    ...(whereAreYouGoingSuppressedReactors.get(tokenKey) ?? []),
    ...(resumeContext?.data?.skippedReactorTokenUuids ?? []),
    ...(options?.[INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION]?.reactorTokenUuids ?? [])
      .map(uuid => String(uuid ?? "").trim())
      .filter(Boolean)
  ]);

  const reactors = (tokenDocument.parent?.tokens?.contents ?? [])
    .filter(other => other?.actor && other.id !== tokenDocument.id)
    .filter(other => isTokenActiveCombatant(combat, other))
    .filter(other => canUseWhereAreYouGoingReaction(other.actor))
    .filter(other => isWhereAreYouGoingOpponent(other.actor, mover))
    .filter(other => getActorWhereAreYouGoingEntries(other.actor).some(entry => {
      const reactionEnergyCost = getAbilityEnergyCost(
        other.actor,
        entry.abilityItem,
        entry.abilityFunction,
        entry.settings.reactionEnergyCost
      );
      return getAvailableWhereAreYouGoingWeaponCandidates(other.actor, {
        token: other,
        reactionEnergyCost
      }).length > 0;
    }));
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
        if (skippedReactorTokenUuids.has(reactor.uuid)) return false;
        return wasAdjacent && !isAdjacent;
      });
      if (!leavingReactors.length) continue;
      return [{
        type: REACTION_EVENT_KEYS.tokenLeavingAdjacency,
        eventId: `${movement?.id ?? foundry.utils.randomID()}:${routeOrder}`,
        routeOrder: Math.max(0, routeOrder - 1),
        priority: -100,
        waypoint: previous.waypoint,
        reactorTokenUuids: leavingReactors.map(reactor => reactor.uuid),
        remainingWaypoints: buildRemainingMovementWaypoints(
          segmentSamples,
          segmentIndex,
          samples,
          index,
          movement.pending?.waypoints ?? []
        )
      }];
    }
  }
  return [];
}

async function executeWhereAreYouGoingMovementInterruption({
  tokenDocument,
  movement,
  event,
  options,
  chainRef = null,
  isCurrent = null
} = {}) {
  const mover = tokenDocument?.actor;
  if (!mover) return;
  const result = await requestReactionEvent(REACTION_EVENT_KEYS.tokenLeavingAdjacency, {
    movementId: movement?.id ?? "",
    moverActorUuid: mover.uuid,
    moverTokenUuid: tokenDocument.uuid,
    reactorTokenUuids: event?.reactorTokenUuids ?? [],
    chainRef,
    title: "Реакция на перемещение",
    message: `${mover.name} пытается покинуть соседнюю клетку. Шаг отменён.`
  });
  if (result?.status === REACTION_RESULT.success) return;
  if (typeof isCurrent === "function" && !isCurrent()) return false;
  await resumeWhereAreYouGoingMovement(tokenDocument, movement, event, options, chainRef);
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
      const reactionEnergyCost = getAbilityEnergyCost(
        reactor,
        candidateEntry.abilityItem,
        candidateEntry.abilityFunction,
        candidateEntry.settings.reactionEnergyCost
      );
      return getAvailableWhereAreYouGoingWeaponCandidates(reactor, {
        token: reactorToken,
        reactionEnergyCost
      }).length > 0;
    });
    if (!entry) continue;
    const reactionEnergyCost = getAbilityEnergyCost(
      reactor,
      entry.abilityItem,
      entry.abilityFunction,
      entry.settings.reactionEnergyCost
    );
    const candidates = getAvailableWhereAreYouGoingWeaponCandidates(reactor, {
      token: reactorToken,
      reactionEnergyCost
    });
    if (!candidates.length) continue;
    const attackEnergyCost = Math.min(...candidates.map(candidate => Math.max(0, toInteger(candidate.attackEnergyCost))));
    const energyCost = getCombinedReactionEnergyCost(reactionEnergyCost, attackEnergyCost);
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
      costLines: buildReactionEnergyCostLines(entry.settings.reactionEnergyCost, reactionEnergyCost, attackEnergyCost),
      abilityItemId: entry.abilityItem.id,
      abilityFunctionId: entry.abilityFunction.id,
      reactorTokenUuid: reactorToken.uuid,
      moverTokenUuid: moverToken.uuid,
      reactionEnergyCost,
      attackEnergyCost,
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

  const reactionEnergyCost = getAbilityEnergyCost(
    reactor,
    entry.abilityItem,
    entry.abilityFunction,
    entry.settings.reactionEnergyCost
  );

  const candidates = getAvailableWhereAreYouGoingWeaponCandidates(reactor, {
    token: reactorToken,
    reactionEnergyCost
  });
  if (!candidates.length) return { handled: true, status: REACTION_RESULT.failed };
  const selectedCandidate = candidates.length === 1
    ? candidates[0]
    : await queryWhereAreYouGoingWeaponOwner(reactor, candidates, {
      targetName: moverToken.actor?.name ?? "",
      abilityName: getAbilityDisplayName(entry.abilityItem)
    });
  if (!selectedCandidate) return { handled: true, status: REACTION_RESULT.declined };
  const { weapon, weaponFunctionId } = selectedCandidate;
  const attackEnergyCost = getReactionWeaponActionEnergyCost({
    actor: reactor,
    token: reactorToken,
    weapon,
    actionKey: "meleeAttack",
    weaponFunctionId
  });
  if (!hasEnergy(reactor, getCombinedReactionEnergyCost(reactionEnergyCost, attackEnergyCost))) {
    return { handled: false };
  }
  if (!hasRequiredWeaponResources(weapon, 1, weaponFunctionId)) {
    return { handled: true, status: REACTION_RESULT.failed };
  }

  await spendEnergy(reactor, reactionEnergyCost);
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

function buildRemainingMovementWaypoints(
  segmentSamples = [],
  segmentIndex = 0,
  routeSamples = [],
  routeIndex = 0,
  pendingWaypoints = []
) {
  const waypoints = [
    ...segmentSamples.slice(segmentIndex).map(sample => ({ ...sample?.waypoint, checkpoint: false })),
    ...routeSamples.slice(routeIndex + 1).map(sample => sample?.waypoint),
    ...pendingWaypoints.filter(waypoint => !waypoint?.intermediate)
  ].filter(Boolean);
  return prepareFixedMovementWaypoints(waypoints);
}

function prepareFixedMovementWaypoints(waypoints = []) {
  const result = [];
  for (const waypoint of waypoints.filter(waypoint => waypoint && !waypoint.intermediate)) {
    const prepared = { ...waypoint };
    if (result.length && getFixedMovementWaypointKey(result.at(-1)) === getFixedMovementWaypointKey(prepared)) {
      result[result.length - 1] = prepared;
    } else {
      result.push(prepared);
    }
  }
  if (result.length) result.at(-1).checkpoint = true;
  return result;
}

function getFixedMovementWaypointKey(waypoint = {}) {
  return [
    Math.round(Number(waypoint.x) || 0),
    Math.round(Number(waypoint.y) || 0),
    Number.isFinite(Number(waypoint.elevation)) ? String(Number(waypoint.elevation)) : "",
    Number.isFinite(Number(waypoint.width)) ? String(Number(waypoint.width)) : "",
    Number.isFinite(Number(waypoint.height)) ? String(Number(waypoint.height)) : "",
    Number.isFinite(Number(waypoint.depth)) ? String(Number(waypoint.depth)) : "",
    String(waypoint.shape ?? ""),
    String(waypoint.level ?? ""),
    String(waypoint.action ?? ""),
    String(Boolean(waypoint.checkpoint)),
    String(Boolean(waypoint.explicit)),
    String(Boolean(waypoint.snapped))
  ].join(":");
}

async function resumeWhereAreYouGoingMovement(
  tokenDocument,
  movement,
  event = {},
  operationOptions = {},
  chainRef = null
) {
  const waypoints = Array.isArray(event.remainingWaypoints) ? event.remainingWaypoints : [];
  if (!tokenDocument || !waypoints.length) return false;
  const reactorTokenUuids = (event.reactorTokenUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean);
  suppressWhereAreYouGoingReactors(tokenDocument, reactorTokenUuids);
  return withMovementResumeContext(
    tokenDocument,
    INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION,
    { chainRef, skippedReactorTokenUuids: new Set(reactorTokenUuids) },
    () => tokenDocument.move(waypoints, {
      ...createMovementOptions(movement, operationOptions, {
        chainRef,
        split: false,
        showRuler: movement?.showRuler
      }),
      [INTERNAL_SYSTEM_MOVEMENT_RESUME_OPTION]: { reactorTokenUuids }
    })
  );
}

function suppressWhereAreYouGoingReactors(tokenDocument, reactorTokenUuids = []) {
  const tokenKey = getWhereAreYouGoingTokenKey(tokenDocument);
  if (!tokenKey) return;
  const suppressed = whereAreYouGoingSuppressedReactors.get(tokenKey) ?? new Set();
  for (const uuid of reactorTokenUuids) if (uuid) suppressed.add(uuid);
  whereAreYouGoingSuppressedReactors.delete(tokenKey);
  whereAreYouGoingSuppressedReactors.set(tokenKey, suppressed);
  while (whereAreYouGoingSuppressedReactors.size > 512) {
    whereAreYouGoingSuppressedReactors.delete(whereAreYouGoingSuppressedReactors.keys().next().value);
  }
}

function synchronizeWhereAreYouGoingSuppression({ tokenDocument } = {}) {
  const tokenKey = getWhereAreYouGoingTokenKey(tokenDocument);
  const suppressed = whereAreYouGoingSuppressedReactors.get(tokenKey);
  if (!suppressed?.size) return;
  for (const reactorUuid of [...suppressed]) {
    const reactor = globalThis.fromUuidSync?.(reactorUuid)
      ?? (tokenDocument?.parent?.tokens?.contents ?? []).find(token => token?.uuid === reactorUuid);
    if (!reactor || !areTokensAdjacent(tokenDocument, reactor)) suppressed.delete(reactorUuid);
  }
  if (!suppressed.size) whereAreYouGoingSuppressedReactors.delete(tokenKey);
}

function getWhereAreYouGoingTokenKey(tokenDocument) {
  return String(tokenDocument?.uuid ?? tokenDocument?.id ?? "").trim();
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
  const operation = () => requestReactionEvent(REACTION_EVENT_KEYS.weaponAttackResolved, {
    attackId: context?.attackId ?? "",
    attackerActorUuid,
    attackerTokenUuid,
    targetTokenUuids,
    weaponUuid: context?.weaponUuid ?? "",
    actionKey: context?.actionKey ?? "",
    weaponFunctionId: context?.weaponFunctionId ?? "",
    chainRef: context?.chainRef ?? null,
    damageHubOperationRef: context?.damageHubOperationRef ?? "",
    title: "Ответная реакция",
    message: "Атака завершена. Доступна реакция контратаки."
  });
  await (context?.reactionCoordinator?.run
    ? context.reactionCoordinator.run(operation)
    : operation());
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
    const reactionEnergyCost = getAbilityEnergyCost(defender, entry.abilityItem, entry.abilityFunction, settings.reactionEnergyCost);
    const attackEnergyCost = getReactionWeaponActionEnergyCost({
      actor: defender,
      token: defenderToken,
      weapon: entry.weapon,
      actionKey: "meleeAttack",
      weaponFunctionId: entry.weaponFunctionId
    });
    const energyCost = getCombinedReactionEnergyCost(reactionEnergyCost, attackEnergyCost);
    if (!hasEnergy(defender, energyCost)) continue;
    if (getMissingWeaponResourceCost(entry.weapon, 1, entry.weaponFunctionId)) continue;
    offers.push({
      actorUuid: defender.uuid,
      reactionId: COUNTER_ATTACK_REACTION_PROVIDER_ID,
      offerId: `${COUNTER_ATTACK_REACTION_PROVIDER_ID}:${defender.uuid}:${context.attackId ?? foundry.utils.randomID()}`,
      label: getAbilityDisplayName(entry.abilityItem),
      description: `Ответить ${entry.weapon.name}: ${attacker.name}.`,
      img: entry.abilityItem.img || entry.weapon.img || "icons/svg/sword.svg",
      costLines: buildReactionEnergyCostLines(settings.reactionEnergyCost, reactionEnergyCost, attackEnergyCost),
      abilityItemId: entry.abilityItem.id,
      abilityFunctionId: entry.abilityFunction.id,
      weaponId: entry.weapon.id,
      weaponFunctionId: entry.weaponFunctionId,
      defenderTokenUuid: defenderToken.uuid,
      attackerTokenUuid: attackerToken.uuid,
      reactionEnergyCost,
      attackEnergyCost,
      energyCost
    });
  }
  return offers;
}

async function executeCounterAttackReaction({ context = {}, offer = {} } = {}) {
  const defender = await fromUuid(String(offer.actorUuid ?? ""));
  const defenderTokenDocument = await fromUuid(String(offer.defenderTokenUuid ?? ""));
  const attackerTokenDocument = await fromUuid(String(offer.attackerTokenUuid ?? ""));
  const entry = getActorCounterAttackEntry(defender, offer);
  if (!defender || !defenderTokenDocument || !attackerTokenDocument || !entry) return { handled: false };
  const settings = entry.settings;
  const reactionEnergyCost = getAbilityEnergyCost(defender, entry.abilityItem, entry.abilityFunction, settings.reactionEnergyCost);
  const attackEnergyCost = getReactionWeaponActionEnergyCost({
    actor: defender,
    token: defenderTokenDocument,
    weapon: entry.weapon,
    actionKey: "meleeAttack",
    weaponFunctionId: entry.weaponFunctionId
  });
  if (!areTokensAdjacent(defenderTokenDocument, attackerTokenDocument)) return { handled: false };
  if (!hasEnergy(defender, getCombinedReactionEnergyCost(reactionEnergyCost, attackEnergyCost))) return { handled: false };
  if (!hasRequiredWeaponResources(entry.weapon, 1, entry.weaponFunctionId)) return { handled: false };

  await spendEnergy(defender, reactionEnergyCost);
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
    chainRef: context?.chainRef ?? null,
    damageHubOperationRef: context?.damageHubOperationRef ?? "",
    skipActionPointCost: true,
    ignoreReactionLock: true,
    suspendActiveAttack: true
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

async function dropDisarmedWeaponOnGround({ sourceActor, sourceWeapon } = {}) {
  if (!sourceActor || !sourceWeapon) return false;
  // This shared transfer waits for the responsible GM, persists the complete
  // container subtree on the ground, and only then removes the source. If the
  // source mutation fails, the newly-created ground entry is compensated.
  const tile = await dropActorInventoryItem(sourceActor, sourceWeapon, { quantity: 1 });
  return Boolean(tile);
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
    if (weapon.type !== "gear") continue;
    const weaponSet = getDeployedWeaponSetKey(weapon);
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

function getAvailableWhereAreYouGoingWeaponCandidates(actor, { token = null, reactionEnergyCost = 0 } = {}) {
  return getWhereAreYouGoingWeaponCandidates(actor)
    .map(candidate => ({
      ...candidate,
      attackEnergyCost: getReactionWeaponActionEnergyCost({
        actor,
        token,
        weapon: candidate.weapon,
        actionKey: "meleeAttack",
        weaponFunctionId: candidate.weaponFunctionId
      })
    }))
    .filter(candidate => !getMissingWeaponResourceCost(candidate.weapon, 1, candidate.weaponFunctionId))
    .filter(candidate => hasEnergy(actor, getCombinedReactionEnergyCost(reactionEnergyCost, candidate.attackEnergyCost)));
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
    if (weapon.type !== "gear") continue;
    const weaponSet = getDeployedWeaponSetKey(weapon);
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
  return canvas.tokens?.controlled?.find(token => token?.actor?.uuid === actor?.uuid)
    ?? canvas.tokens?.placeables?.find(token => token?.actor?.uuid === actor?.uuid)
    ?? null;
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
          remainingUses: 1,
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

async function toggleTwoHands(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeTwoHandsSettings(abilityFunction.fixedSettings);
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

function getActorCounterSniperEntry(actor, offer = null) {
  const abilityItemId = String(offer?.abilityItemId ?? "");
  const abilityFunctionId = String(offer?.abilityFunctionId ?? "");
  const weaponId = String(offer?.weaponId ?? "");
  const weaponFunctionId = String(offer?.weaponFunctionId ?? "");
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    if (abilityItemId && abilityItem.id !== abilityItemId) continue;
    const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .find(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.counterSniper && (!abilityFunctionId || entry.id === abilityFunctionId));
    if (!abilityFunction) continue;
    const candidate = getCounterSniperWeaponCandidate(actor, { weaponId, weaponFunctionId });
    if (!candidate) continue;
    return {
      abilityItem,
      abilityFunction,
      settings: normalizeCounterSniperSettings(abilityFunction.fixedSettings),
      ...candidate
    };
  }
  return null;
}

function getCounterSniperWeaponCandidate(actor, { weaponId = "", weaponFunctionId = "" } = {}) {
  const candidates = [];
  for (const weapon of actor?.items?.contents ?? []) {
    if (weapon.type !== "gear") continue;
    const weaponSet = getDeployedWeaponSetKey(weapon);
    if (!weaponSet) continue;
    if (!hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) continue;
    for (const candidateFunctionId of getWhirlwindWeaponFunctionIds(weapon)) {
      if (!hasWeaponAction(weapon, "aimedShot", candidateFunctionId)) continue;
      candidates.push({ weapon, weaponSet, weaponFunctionId: candidateFunctionId });
    }
  }
  if (weaponId) {
    const exact = candidates.find(candidate => candidate.weapon.id === weaponId && (!weaponFunctionId || candidate.weaponFunctionId === weaponFunctionId));
    if (exact) return exact;
  }
  const selectedItemId = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponItemId") ?? "");
  const selectedSet = String(actor?.getFlag?.(SYSTEM_ID, "selectedHudWeaponSetKey") ?? "");
  return candidates.find(candidate => candidate.weapon.id === selectedItemId)
    ?? candidates.find(candidate => selectedSet && candidate.weaponSet === selectedSet)
    ?? candidates.at(0)
    ?? null;
}

function isCounterSniperAlly(reactor, defendedActor) {
  return areCounterSniperActorsAllied(reactor, defendedActor);
}

function isCounterSniperEnemy(reactor, attacker) {
  return !areCounterSniperActorsAllied(reactor, attacker);
}

function areCounterSniperActorsAllied(left, right) {
  if (!left || !right) return false;
  if (left.uuid === right.uuid) return true;
  const leftFactions = getActorFactionBelongs(left);
  const rightFactions = getActorFactionBelongs(right);
  const normalizedLeft = leftFactions.length ? leftFactions : [DEFAULT_FACTION_NAME];
  const normalizedRight = rightFactions.length ? rightFactions : [DEFAULT_FACTION_NAME];
  if (normalizedLeft.some(faction => normalizedRight.includes(faction))) return true;
  return normalizedRight.some(faction => getRelationTo(left, faction) === "ally")
    || normalizedLeft.some(faction => getRelationTo(right, faction) === "ally");
}

function registerCounterSniperReactionProvider() {
  CONFIG.queries[COUNTER_SNIPER_AIM_QUERY_NAME] = runFixedAbilityRuntimeHandler(handleCounterSniperAimQuery);
  registerReactionProvider({
    id: COUNTER_SNIPER_REACTION_PROVIDER_ID,
    collect: runFixedAbilityRuntimeHandler(collectCounterSniperReactionOffers),
    execute: runFixedAbilityRuntimeHandler(executeCounterSniperReaction)
  });
}

async function collectCounterSniperReactionOffers({ eventKey = "", context = {} } = {}) {
  if (eventKey !== REACTION_EVENT_KEYS.aimedAttackLimbSelected) return [];
  const attacker = await fromUuid(String(context.attackerActorUuid ?? ""));
  const attackerToken = await fromUuid(String(context.attackerTokenUuid ?? ""));
  const defendedActor = await fromUuid(String(context.targetActorUuid ?? ""));
  if (!attacker || !attackerToken || !defendedActor) return [];

  const offers = [];
  const seenActors = new Set();
  for (const reactorToken of attackerToken.parent?.tokens?.contents ?? []) {
    const reactor = reactorToken?.actor;
    if (!reactor || reactor.uuid === attacker.uuid || seenActors.has(reactor.uuid)) continue;
    if (reactor.uuid === defendedActor.uuid) continue;
    if (!isCounterSniperAlly(reactor, defendedActor) || !isCounterSniperEnemy(reactor, attacker)) continue;
    const entry = getActorCounterSniperEntry(reactor);
    if (!entry) continue;
    const reactionEnergyCost = getAbilityEnergyCost(reactor, entry.abilityItem, entry.abilityFunction, entry.settings.reactionEnergyCost);
    const attackEnergyCost = getReactionWeaponActionEnergyCost({
      actor: reactor,
      token: reactorToken,
      weapon: entry.weapon,
      actionKey: "aimedShot",
      weaponFunctionId: entry.weaponFunctionId
    });
    const energyCost = getCombinedReactionEnergyCost(reactionEnergyCost, attackEnergyCost);
    if (!hasEnergy(reactor, energyCost)) continue;
    if (!canPerformAimedAttackAgainstToken({
      attackerToken: reactorToken,
      targetToken: attackerToken,
      weapon: entry.weapon,
      weaponFunctionId: entry.weaponFunctionId
    })) continue;
    seenActors.add(reactor.uuid);
    offers.push({
      actorUuid: reactor.uuid,
      offerId: `${COUNTER_SNIPER_REACTION_PROVIDER_ID}:${reactor.uuid}:${context.attackId ?? foundry.utils.randomID()}`,
      label: getAbilityDisplayName(entry.abilityItem),
      description: `Прицельный выстрел по ${attacker.name}: ${entry.weapon.name}.`,
      img: entry.abilityItem.img || entry.weapon.img || "icons/svg/target.svg",
      costLines: buildReactionEnergyCostLines(entry.settings.reactionEnergyCost, reactionEnergyCost, attackEnergyCost),
      abilityItemId: entry.abilityItem.id,
      abilityFunctionId: entry.abilityFunction.id,
      weaponId: entry.weapon.id,
      weaponFunctionId: entry.weaponFunctionId,
      reactorTokenUuid: reactorToken.uuid,
      attackerTokenUuid: attackerToken.uuid,
      reactionEnergyCost,
      attackEnergyCost,
      energyCost
    });
  }
  return offers;
}

async function executeCounterSniperReaction({ context = {}, offer = {} } = {}) {
  const reactor = await fromUuid(String(offer.actorUuid ?? ""));
  const reactorToken = await fromUuid(String(offer.reactorTokenUuid ?? ""));
  const attackerToken = await fromUuid(String(offer.attackerTokenUuid ?? ""));
  const entry = getActorCounterSniperEntry(reactor, offer);
  if (!reactor || !reactorToken || !attackerToken || !entry) return { handled: false };
  if (reactor.uuid === String(context.targetActorUuid ?? "")) return { handled: false };
  const reactionEnergyCost = getAbilityEnergyCost(reactor, entry.abilityItem, entry.abilityFunction, entry.settings.reactionEnergyCost);
  const attackEnergyCost = getReactionWeaponActionEnergyCost({
    actor: reactor,
    token: reactorToken,
    weapon: entry.weapon,
    actionKey: "aimedShot",
    weaponFunctionId: entry.weaponFunctionId
  });
  if (!hasEnergy(reactor, getCombinedReactionEnergyCost(reactionEnergyCost, attackEnergyCost)) || !hasRequiredWeaponResources(entry.weapon, 1, entry.weaponFunctionId)) return { handled: false };

  await spendEnergy(reactor, reactionEnergyCost);
  await applyAbilityOverloadEffect(reactor, entry.abilityItem, entry.abilityFunction, {
    name: getAbilityOverloadName(entry.abilityItem),
    energyCost: entry.settings.reactionOverloadEnergyCost,
    durationSeconds: entry.settings.reactionOverloadDurationSeconds
  });

  const owner = getResponsibleActorOwner(reactor) ?? getResponsibleGM();
  if (!owner) return { handled: true, status: REACTION_RESULT.failed };
  const query = {
    reactorTokenUuid: reactorToken.uuid,
    attackerTokenUuid: attackerToken.uuid,
    weaponUuid: entry.weapon.uuid,
    weaponFunctionId: entry.weaponFunctionId,
    chainRef: context?.chainRef ?? null,
    damageHubOperationRef: context?.damageHubOperationRef ?? ""
  };
  let used = false;
  try {
    used = owner.isSelf
      ? await handleCounterSniperAimQuery(query)
      : await owner.query(COUNTER_SNIPER_AIM_QUERY_NAME, query, { timeout: 120000 });
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Counter sniper aim failed`, error);
  }
  await createAbilityChatMessage(reactor, entry.abilityItem, used
    ? "Ответный прицельный выстрел выполнен."
    : "Выбор части тела сорван; исходная атака продолжена.");
  return { handled: true, status: used ? REACTION_RESULT.success : REACTION_RESULT.failed };
}

async function handleCounterSniperAimQuery(data = {}) {
  const reactorTokenDocument = await fromUuid(String(data.reactorTokenUuid ?? ""));
  const attackerTokenDocument = await fromUuid(String(data.attackerTokenUuid ?? ""));
  const weapon = await fromUuid(String(data.weaponUuid ?? ""));
  if (!reactorTokenDocument?.actor?.isOwner || !attackerTokenDocument?.actor || !weapon) return false;
  return startForcedAimedAttackSelection({
    attackerToken: reactorTokenDocument.object ?? reactorTokenDocument,
    targetToken: attackerTokenDocument.object ?? attackerTokenDocument,
    weapon,
    weaponFunctionId: String(data.weaponFunctionId ?? ""),
    chainRef: data.chainRef ?? null,
    damageHubOperationRef: data.damageHubOperationRef ?? ""
  });
}

async function toggleAiming(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeAimingSettings(abilityFunction.fixedSettings);
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

async function useKeepAway(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeKeepAwaySettings(abilityFunction.fixedSettings);
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  if (state[stateKey]?.pending) {
    ui.notifications.warn(`${abilityName}: следующий выстрел уже подготовлен.`);
    return false;
  }
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.activationEnergyCost);
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
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    pending: true
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  ui.notifications.info(`${abilityName}: следующий выстрел подготовлен.`);
  return true;
}

async function useRicochet(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeRicochetSettings(abilityFunction.fixedSettings);
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  if (state[stateKey]?.pending) {
    ui.notifications.warn(`${abilityName}: следующий выстрел уже подготовлен.`);
    return false;
  }
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.activationEnergyCost);
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
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    pending: true
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  ui.notifications.info(`${abilityName}: следующий выстрел навскидку подготовлен.`);
  return true;
}

async function useLethalAttack(actor, abilityItem, abilityFunction) {
  const abilityName = getAbilityDisplayName(abilityItem);
  const settings = normalizeLethalAttackSettings(abilityFunction.fixedSettings);
  if (findLethalAttackPreparationEffect(actor, abilityItem, abilityFunction)) {
    ui.notifications.warn(`${abilityName}: следующая атака уже подготовлена.`);
    return false;
  }
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.activationEnergyCost);
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
  await applyLethalAttackPreparationEffect(actor, abilityItem, abilityFunction, settings);
  ui.notifications.info(`${abilityName}: следующая атака подготовлена на ${settings.attackWaitDurationSeconds} сек.`);
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

function requestAnatomyStudyWeaponActionModifiers(context = {}) {
  const actor = context?.actor ?? context?.actorToken?.actor ?? context?.token?.actor ?? null;
  if (!actor || !context?.modifierState) return;
  const bonusesByRace = getActorAnatomyStudyRaceBonuses(actor);
  if (!bonusesByRace.size) return;
  const availableBonusKeys = new Set();
  for (const bonuses of bonusesByRace.values()) {
    for (const [bonusKey, value] of Object.entries(bonuses)) {
      if (Number(value) > 0) availableBonusKeys.add(bonusKey);
    }
  }

  const addRaceBonus = (combatKey, bonusKey) => {
    if (!availableBonusKeys.has(bonusKey)) return;
    context.modifierState.addCombatValue(combatKey, runtimeContext => {
      const targetActor = runtimeContext?.targetActor ?? runtimeContext?.targetToken?.actor ?? null;
      return Math.max(0, Number(bonusesByRace.get(getActorRaceId(targetActor))?.[bonusKey]) || 0);
    });
  };
  addRaceBonus("damagePercent", ANATOMY_STUDY_BONUS_KEYS.damage);
  addRaceBonus("accuracy", ANATOMY_STUDY_BONUS_KEYS.accuracy);
  addRaceBonus("criticalChance", ANATOMY_STUDY_BONUS_KEYS.criticalChance);
  addRaceBonus("criticalDamagePercent", ANATOMY_STUDY_BONUS_KEYS.criticalDamage);
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
      const getEnergyCost = ({ attackCount = 1 } = {}) => (
        getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost) * Math.max(1, toInteger(attackCount))
      );
      context.modifierState.addSpendRequirement({
        source: "fullForce",
        label: getAbilityDisplayName(abilityItem),
        energyCost: getEnergyCost,
        canSpend: context => {
          const cost = getEnergyCost(context);
          if (hasEnergy(actor, cost)) return true;
          if (!context?.silent) ui.notifications.warn(`${getAbilityDisplayName(abilityItem)}: недостаточно энергии (${getActorEnergy(actor)} / ${cost}).`);
          return false;
        },
        spend: async context => {
          const cost = getEnergyCost(context);
          return spendFullForceEnergy(actor, abilityItem, abilityFunction, cost);
        }
      });
    }
  }
}

function requestAimingWeaponActionModifiers(context = {}) {
  const actor = context?.actor ?? null;
  if (!actor || String(context?.actionKey ?? "") !== "aimedShot" || !context?.modifierState) return;

  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    const functions = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.aiming)
      .filter(entry => Boolean(state[getFixedFunctionStateKey(entry)]?.active));
    for (const abilityFunction of functions) {
      const settings = normalizeAimingSettings(abilityFunction.fixedSettings);
      context.modifierState.setOption(
        "innateAimedDifficultyIgnorePercent",
        Math.max(
          toInteger(context.modifierState.getOption("innateAimedDifficultyIgnorePercent")),
          settings.innateDifficultyIgnorePercent
        )
      );
      const getEnergyCost = ({ attackCount = 1 } = {}) => (
        getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost) * Math.max(1, toInteger(attackCount))
      );
      context.modifierState.addSpendRequirement({
        source: "aiming",
        label: getAbilityDisplayName(abilityItem),
        energyCost: getEnergyCost,
        canSpend: context => {
          const cost = getEnergyCost(context);
          if (hasEnergy(actor, cost)) return true;
          if (!context?.silent) ui.notifications.warn(`${getAbilityDisplayName(abilityItem)}: недостаточно энергии (${getActorEnergy(actor)} / ${cost}).`);
          return false;
        },
        spend: async context => {
          const cost = getEnergyCost(context);
          return spendEnergy(actor, cost);
        }
      });
    }
  }
}

function requestKeepAwayWeaponActionModifiers(context = {}) {
  const actor = context?.actor ?? null;
  const actionKey = String(context?.actionKey ?? "");
  if (!actor || !["snapshot", "aimedShot"].includes(actionKey) || !context?.modifierState) return;

  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.keepAway) continue;
      const stateKey = getFixedFunctionStateKey(abilityFunction);
      if (!state[stateKey]?.pending) continue;
      const entries = Array.isArray(context.modifierState.getOption("keepAwayEntries"))
        ? context.modifierState.getOption("keepAwayEntries")
        : [];
      entries.push({ abilityItem, abilityFunction, settings: normalizeKeepAwaySettings(abilityFunction.fixedSettings) });
      context.modifierState.setOption("keepAwayEntries", entries);
      context.modifierState.addSpendRequirement({
        source: "keepAway",
        label: getAbilityDisplayName(abilityItem),
        spend: () => consumeKeepAwayPreparation(abilityItem, abilityFunction)
      });
    }
  }
}

function requestLethalAttackWeaponActionModifiers(context = {}) {
  const actor = context?.actor ?? null;
  const actionKey = String(context?.actionKey ?? "").trim();
  if (!actor || !actionKey || !context?.modifierState) return;

  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      const requiredActionKey = getLethalAttackActionKey(abilityFunction.fixedKey);
      if (!requiredActionKey || actionKey !== requiredActionKey) continue;
      const effect = findLethalAttackPreparationEffect(actor, abilityItem, abilityFunction);
      if (!effect) continue;
      const settings = normalizeLethalAttackSettings(abilityFunction.fixedSettings);
      context.modifierState.addCombatValue("damagePercent", attackContext => {
        const targetActor = attackContext?.targetActor ?? attackContext?.targetToken?.actor ?? null;
        const limbKey = String(attackContext?.limbKey ?? "").trim();
        if (!targetActor || !limbKey || !isCriticalLimb(targetActor, limbKey)) return 0;
        return abilityConditionsApply(actor, abilityFunction.conditions ?? [], {
          ...attackContext,
          targetActor,
          weaponActionKey: requiredActionKey
        }) ? settings.damagePercentBonus : 0;
      });
    }
  }
}

function requestRicochetWeaponActionModifiers(context = {}) {
  const actor = context?.actor ?? null;
  if (!actor || String(context?.actionKey ?? "") !== "snapshot" || !context?.modifierState) return;

  const entries = [];
  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.ricochet) continue;
      if (!state[getFixedFunctionStateKey(abilityFunction)]?.pending) continue;
      entries.push({
        abilityItem,
        abilityFunction,
        settings: normalizeRicochetSettings(abilityFunction.fixedSettings)
      });
    }
  }
  if (!entries.length) return;

  context.modifierState.setOption("ricochetEntries", entries);
  context.modifierState.setOption("ricochet", {
    maxReflections: Math.max(...entries.map(entry => entry.settings.maxReflections)),
    accuracyBonusPerReflection: entries.reduce((sum, entry) => sum + entry.settings.accuracyBonusPerReflection, 0),
    damagePercentBonusPerReflection: entries.reduce((sum, entry) => sum + entry.settings.damagePercentBonusPerReflection, 0)
  });
  context.modifierState.addSpendRequirement({
    source: "ricochet",
    label: entries.map(entry => getAbilityDisplayName(entry.abilityItem)).join(", "),
    spend: async () => {
      for (const entry of entries) await consumeRicochetPreparation(entry.abilityItem, entry.abilityFunction);
      return true;
    }
  });
}

async function consumeRicochetPreparation(abilityItem, abilityFunction) {
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  if (!state[stateKey]?.pending) return true;
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    pending: false
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  return true;
}

function getLethalAttackActionKey(fixedKey = "") {
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lethalShot) return "aimedShot";
  if (fixedKey === ABILITY_FIXED_FUNCTION_KEYS.lethalStrike) return "aimedMeleeAttack";
  return "";
}

async function consumeLethalAttackPreparationEffects(context = {}) {
  const actionKey = String(context?.actionKey ?? "").trim();
  if (!["aimedShot", "aimedMeleeAttack"].includes(actionKey)) return;
  const limbKey = String(context?.selectedLimbKey ?? "").trim();
  const targetActorUuid = String(context?.selectedTargetActorUuid ?? "").trim();
  const targetActor = targetActorUuid ? fromUuidSync(targetActorUuid) : null;
  if (!targetActor || !limbKey || !isCriticalLimb(targetActor, limbKey)) return;
  const actorUuid = String(context?.attackerUuid ?? context?.actorUuid ?? "").trim();
  const actor = actorUuid ? fromUuidSync(actorUuid) : null;
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  const effectIds = Array.from(actor.effects ?? [])
    .filter(effect => !effect.disabled && !effect.isExpired)
    .filter(effect => {
      const data = effect.getFlag?.(SYSTEM_ID, LETHAL_ATTACK_EFFECT_FLAG_KEY);
      return data?.pending && String(data.actionKey ?? "").trim() === actionKey;
    })
    .map(effect => effect.id)
    .filter(Boolean);
  if (effectIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
}

async function consumeKeepAwayPreparation(abilityItem, abilityFunction) {
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  if (!state[stateKey]?.pending) return true;
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    pending: false
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  return true;
}

async function processKeepAwayAttackResolution(context = {}) {
  const entries = context?.modifierState?.getOption?.("keepAwayEntries");
  if (!Array.isArray(entries) || !entries.length) return;
  if (!context?.damageResults?.length) return;
  const attackerToken = fromUuidSync(String(context?.tokenUuid ?? ""));
  if (!attackerToken) return;

  const damageByActor = new Map();
  for (const result of context.damageResults) {
    if (result?.mode && result.mode !== "damage") continue;
    const actor = result?.actor ?? null;
    const actorUuid = String(actor?.uuid ?? result?.actorUuid ?? "").trim();
    if (!actorUuid) continue;
    const current = damageByActor.get(actorUuid) ?? { actor, healthDamage: 0 };
    current.actor ??= actor;
    current.healthDamage += Math.max(0, Number(result?.resourceHealthDelta) || 0);
    damageByActor.set(actorUuid, current);
  }
  if (!damageByActor.size) return;

  const targetTokens = (context?.targetTokenUuids ?? [])
    .map(uuid => fromUuidSync(String(uuid ?? "")))
    .filter(token => token?.actor);
  for (const entry of entries) {
    const settings = normalizeKeepAwaySettings(entry.settings);
    for (const [actorUuid, damage] of damageByActor) {
      const targetToken = targetTokens.find(token => token.actor?.uuid === actorUuid)
        ?? (canvas.tokens?.placeables ?? []).find(token => token.actor?.uuid === actorUuid)?.document
        ?? null;
      const actor = damage.actor ?? targetToken?.actor;
      if (!targetToken || !actor) continue;
      const healthMax = Math.max(1, Number(actor.system?.resources?.health?.max) || 1);
      const lostPercent = Math.max(0, Math.min(100, (damage.healthDamage / healthMax) * 100));
      const difficulty = Math.floor(settings.baseDifficulty + (lostPercent * settings.lostHealthPercentMultiplier));
      await resolveKnockback({
        attackerToken,
        targetToken,
        difficulty,
        reason: getAbilityDisplayName(entry.abilityItem),
        requester: "keepAwayResistance"
      });
    }
  }
}

function requestVirtuosoWeaponActionModifiers(context = {}) {
  const actor = context?.actor ?? null;
  const weaponName = String(context?.weapon?.name ?? "").trim();
  if (!actor || !weaponName || !ATTACKING_WEAPON_ACTION_KEYS.includes(String(context?.actionKey ?? ""))) return;

  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.virtuoso) continue;
      const previousWeaponName = String(state[getFixedFunctionStateKey(abilityFunction)]?.weaponName ?? "").trim();
      if (previousWeaponName && previousWeaponName === weaponName) continue;
      const settings = normalizeVirtuosoSettings(abilityFunction.fixedSettings);
      context.modifierState.addCombatValue("accuracy", settings.accuracyBonus);
      context.modifierState.addCombatValue("damagePercent", settings.damagePercentBonus);
    }
  }
}

async function updateVirtuosoLastWeapon(context = {}) {
  if (context?.canceledByReaction) return;
  const actionKey = String(context?.actionKey ?? "").trim();
  if (!ATTACKING_WEAPON_ACTION_KEYS.includes(actionKey)) return;
  const actorUuid = String(context?.attackerUuid ?? context?.actorUuid ?? "").trim();
  const actor = actorUuid ? fromUuidSync(actorUuid) : null;
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  const weaponUuid = String(context?.weaponUuid ?? "").trim();
  const weapon = weaponUuid ? fromUuidSync(weaponUuid) : null;
  const weaponName = String(weapon?.name ?? "").trim();
  if (!weaponName) return;

  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const functions = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso);
    if (!functions.length) continue;
    const state = getFixedAbilityState(abilityItem);
    let changed = false;
    for (const abilityFunction of functions) {
      const stateKey = getFixedFunctionStateKey(abilityFunction);
      if (String(state[stateKey]?.weaponName ?? "").trim() === weaponName) continue;
      state[stateKey] = {
        ...state[stateKey],
        fixedKey: abilityFunction.fixedKey,
        weaponName
      };
      changed = true;
    }
    if (changed) await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  }
}

async function consumeVirtuosoAttackBonus(context = {}) {
  const actor = context?.actor ?? null;
  const weaponName = String(context?.weapon?.name ?? "").trim();
  if (!actor || !weaponName || (!game.user?.isGM && !actor.isOwner)) return;

  for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
    const functions = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.virtuoso);
    if (!functions.length) continue;
    const state = getFixedAbilityState(abilityItem);
    let changed = false;
    for (const abilityFunction of functions) {
      const stateKey = getFixedFunctionStateKey(abilityFunction);
      if (String(state[stateKey]?.weaponName ?? "").trim() === weaponName) continue;
      const settings = normalizeVirtuosoSettings(abilityFunction.fixedSettings);
      context.modifierState?.addCombatValue?.("accuracy", -settings.accuracyBonus);
      context.modifierState?.addCombatValue?.("damagePercent", -settings.damagePercentBonus);
      state[stateKey] = {
        ...state[stateKey],
        fixedKey: abilityFunction.fixedKey,
        weaponName
      };
      changed = true;
    }
    if (changed) await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
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
  if (message.action === "performDeusExMachinaDisintegrate") {
    if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
    void processDeusExMachinaDisintegrateSocketRequest(message);
    return;
  }
  if (message.action === "performCommandBasicsDodge") {
    if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
    void processCommandBasicsDodgeSocketRequest(message);
    return;
  }
  if (message.action === "performKnockOffBalanceDebuff") {
    if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
    void processKnockOffBalanceDebuffSocketRequest(message);
    return;
  }
  if (message.action === "performLookResourceLoss") {
    if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
    void processLookResourceLossSocketRequest(message);
    return;
  }
  if (message.action === "performToTheEnd") {
    if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
    void processToTheEndSocketRequest(message);
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
  if (message.action === "deusExMachinaDisintegrateResult") {
    if (message.targetUserId !== game.user?.id) return;
    const pending = pendingFixedAbilitySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingFixedAbilitySocketRequests.delete(message.requestId);
    pending.resolve(Boolean(message.result?.applied));
  }
  if (message.action === "commandBasicsDodgeResult") {
    if (message.targetUserId !== game.user?.id) return;
    const pending = pendingFixedAbilitySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingFixedAbilitySocketRequests.delete(message.requestId);
    pending.resolve(Boolean(message.result?.applied));
  }
  if (message.action === "knockOffBalanceDebuffResult") {
    if (message.targetUserId !== game.user?.id) return;
    const pending = pendingFixedAbilitySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingFixedAbilitySocketRequests.delete(message.requestId);
    pending.resolve(Boolean(message.result?.applied));
  }
  if (message.action === "lookResourceLossResult") {
    if (message.targetUserId !== game.user?.id) return;
    const pending = pendingFixedAbilitySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingFixedAbilitySocketRequests.delete(message.requestId);
    pending.resolve(Boolean(message.result?.applied));
  }
  if (message.action === "toTheEndResult") {
    if (message.targetUserId !== game.user?.id) return;
    const pending = pendingFixedAbilitySocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingFixedAbilitySocketRequests.delete(message.requestId);
    pending.resolve(Boolean(message.result?.applied));
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
  return runActorEnergyMutation(actor, () => (
    spendCurseAndBlessingEnergyNow(actor, abilityItem, abilityFunction, energyCost)
  ));
}

async function spendCurseAndBlessingEnergyNow(actor, abilityItem, abilityFunction, energyCost = 0) {
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
  return runActorEnergyMutation(actor, () => (
    spendDoubleAttackEnergyNow(actor, abilityItem, abilityFunction, energyCost)
  ));
}

async function spendDoubleAttackEnergyNow(actor, abilityItem, abilityFunction, energyCost = 0) {
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

async function spendEnergy(actor, energyCost = 0, updateOptions = {}) {
  const cost = Math.max(0, toInteger(energyCost));
  return runActorEnergyMutation(actor, () => spendEnergyNow(actor, cost, updateOptions));
}

async function refundEnergy(actor, energyAmount = 0) {
  const amount = Math.max(0, toInteger(energyAmount));
  if (!amount) return true;
  return runActorEnergyMutation(actor, async () => {
    const resource = actor.system?.resources?.[ENERGY_RESOURCE_KEY];
    if (!resource) return false;
    const maximum = Math.max(0, toInteger(resource.max));
    const nextValue = Math.min(maximum, getActorEnergy(actor) + amount);
    const update = { [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: nextValue };
    if (Object.hasOwn(resource, "spent")) {
      update[`system.resources.${ENERGY_RESOURCE_KEY}.spent`] = Math.max(0, maximum - nextValue);
    }
    await actor.update(update, { falloutMawAbilityResourceRefund: true });
    return true;
  });
}

async function spendEnergyNow(actor, cost = 0, updateOptions = {}) {
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
  await actor.update(update, updateOptions);
  return true;
}

function runActorEnergyMutation(actor, operation) {
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid) return operation();
  const previous = actorEnergyMutationQueue.get(actorUuid) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (actorEnergyMutationQueue.get(actorUuid) === next) actorEnergyMutationQueue.delete(actorUuid);
    });
  actorEnergyMutationQueue.set(actorUuid, next);
  return next;
}

function getAbilityEnergyCost(actor, abilityItem, abilityFunction, baseCost = 0) {
  return Math.max(0, toInteger(baseCost)) + getAbilityOverloadEnergyCost(actor, abilityItem, abilityFunction);
}

export function getFixedAbilityEnergyCost(actor, abilityItem, abilityFunction, baseCost = 0) {
  return getAbilityEnergyCost(actor, abilityItem, abilityFunction, baseCost);
}

function areFixedAbilityFunctionsEnabled() {
  return getActiveRulesProfile().fixedAbilityFunctionsEnabled !== false;
}

function runFixedAbilityRuntimeHandler(handler) {
  return (...args) => areFixedAbilityFunctionsEnabled() ? handler(...args) : undefined;
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

async function applyHeightenedConcentrationEffect(actor, abilityItem, abilityFunction, settings = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const normalized = normalizeHeightenedConcentrationSettings(settings);
  const startTime = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: getAbilityDisplayName(abilityItem),
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {},
    system: {
      changes: [{
        key: `system.skills.${normalized.skillKey}.advantage`,
        type: "add",
        value: String(normalized.advantageCount),
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [ONE_TIME_SKILL_MODIFIER_FLAG_KEY]: {
          source: HEIGHTENED_CONCENTRATION_EFFECT_SOURCE,
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          fixedKey: abilityFunction.fixedKey,
          skillKey: normalized.skillKey,
          remainingUses: normalized.checkCount,
          advantageCount: normalized.advantageCount,
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  return true;
}

function hasActiveHeightenedConcentrationEffect(actor, abilityItem, abilityFunction) {
  if (!actor || !abilityItem) return false;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const abilitySourceId = getAbilitySourceId(abilityItem);
  const functionId = String(abilityFunction?.id ?? "").trim();
  return getPendingOneTimeSkillModifierEffects(actor, data => {
    if (data?.source !== HEIGHTENED_CONCENTRATION_EFFECT_SOURCE) return false;
    const dataFunctionId = String(data.functionId ?? "").trim();
    if (functionId && dataFunctionId && functionId !== dataFunctionId) return false;
    const dataSourceId = String(data.abilitySourceId ?? "").trim();
    if (dataSourceId && abilitySourceId) return dataSourceId === abilitySourceId;
    return String(data.abilityItemId ?? "").trim() === abilityItemId;
  }).length > 0;
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

async function applyLethalAttackPreparationEffect(actor, abilityItem, abilityFunction, settings = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const startTime = Number(game.time?.worldTime) || 0;
  const durationSeconds = Math.max(0, toInteger(settings.attackWaitDurationSeconds));
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: getAbilityDisplayName(abilityItem),
    img: abilityItem.img || "icons/svg/target.svg",
    origin: abilityItem.uuid,
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
        [LETHAL_ATTACK_EFFECT_FLAG_KEY]: {
          pending: true,
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          fixedKey: abilityFunction.fixedKey,
          actionKey: getLethalAttackActionKey(abilityFunction.fixedKey),
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  return true;
}

function findLethalAttackPreparationEffect(actor, abilityItem, abilityFunction) {
  if (!actor || !abilityItem || !abilityFunction) return null;
  const abilitySourceId = getAbilitySourceId(abilityItem);
  return Array.from(actor.effects ?? []).find(effect => {
    if (effect?.disabled || effect?.isExpired) return false;
    const data = effect.getFlag?.(SYSTEM_ID, LETHAL_ATTACK_EFFECT_FLAG_KEY);
    if (!data?.pending || String(data.functionId ?? "") !== String(abilityFunction.id ?? "")) return false;
    const sourceId = String(data.abilitySourceId ?? "").trim();
    return sourceId && abilitySourceId
      ? sourceId === abilitySourceId
      : String(data.abilityItemId ?? "") === String(abilityItem.id ?? "");
  }) ?? null;
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

async function applyDefensiveTacticsAtTurnEnd({
  actor = null,
  combat = null,
  turnContext = null
} = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  const actorWasInEndingCombat = Number(turnContext?.round) > 0
    && Array.from(combat?.combatants ?? [])
      .some(combatant => combatant?.actor?.uuid === actor.uuid);
  if (!isActorInActiveCombat(actor) && !actorWasInEndingCombat) return;
  if (hasActorCombatMovementInCurrentTurn(actor, {
    round: turnContext?.round
  })) return;

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
    duration: { expiry: "combatEnd" },
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

function getActorGrapplingMasterEntries(actor) {
  const entries = [];
  for (const abilityItem of actor?.items?.filter(item => item.type === "ability") ?? []) {
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.grapplingMaster) continue;
      entries.push({
        abilityItem,
        abilityFunction,
        settings: normalizeGrapplingMasterSettings(abilityFunction.fixedSettings)
      });
    }
  }
  return entries;
}

function applyGrapplingMasterGrappleModifiers(state = {}) {
  const grapplerActor = state?.grapplerActor ?? null;
  if (!grapplerActor) return;
  const kind = String(state.kind ?? "").trim();
  for (const entry of getActorGrapplingMasterEntries(grapplerActor)) {
    if (kind === GRAPPLE_MODIFIER_KINDS.resistance || kind === GRAPPLE_MODIFIER_KINDS.escape) {
      state.checkDifficultyBonus += Math.max(0, toInteger(entry.settings.checkDifficultyBonus));
    }
    if (kind === GRAPPLE_MODIFIER_KINDS.effect) {
      state.targetAttackDisadvantageBonus += Math.max(0, toInteger(entry.settings.targetAttackDisadvantageBonus));
    }
  }
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
  if (!isActorInActiveCombat(actor)) return 0;
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
  return canActorSpendEnergy(actor, cost);
}

function getReactionWeaponActionEnergyCost({ actor = null, token = null, weapon = null, actionKey = "", weaponFunctionId = "", attackCount = null } = {}) {
  return getWeaponActionModifierEnergyCost({
    actor,
    token: token?.object ?? token,
    weapon,
    actionKey,
    weaponFunctionId,
    attackCount
  });
}

function getCombinedReactionEnergyCost(reactionEnergyCost = 0, attackEnergyCost = 0) {
  return Math.max(0, toInteger(reactionEnergyCost)) + Math.max(0, toInteger(attackEnergyCost));
}

function buildReactionEnergyCostLines(baseReactionEnergyCost = 0, reactionEnergyCost = 0, attackEnergyCost = 0) {
  const reactionCost = Math.max(0, toInteger(reactionEnergyCost));
  const attackCost = Math.max(0, toInteger(attackEnergyCost));
  if (!attackCost) return [`Энергия: ${Math.max(0, toInteger(baseReactionEnergyCost))} базовая / ${reactionCost} итоговая`];
  return [
    `Энергия реакции: ${Math.max(0, toInteger(baseReactionEnergyCost))} базовая / ${reactionCost} итоговая`,
    `Энергия атаки: ${attackCost}`,
    `Энергия всего: ${reactionCost + attackCost}`
  ];
}

function getResponsibleGM({
  sceneId = "",
  tokenDocuments = [],
  requireScene = false,
  preferredUser = null
} = {}) {
  const activeGMs = (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM);
  const normalizedSceneId = String(sceneId ?? "").trim();
  const requiredDocuments = Array.from(tokenDocuments ?? []).filter(Boolean);
  const contextualGMs = normalizedSceneId
    ? activeGMs.filter(user => (
      String(user.viewedScene ?? "") === normalizedSceneId
      && requiredDocuments.every(document => (
        String(document?.parent?.id ?? "") === normalizedSceneId
        && isTokenDocumentIncludedForUserLevel(document, user)
      ))
    ))
    : [];
  const candidates = contextualGMs.length
    ? contextualGMs
    : requireScene
      ? []
      : activeGMs;
  const preferred = candidates.find(user => user.id === preferredUser?.id) ?? null;
  if (preferred) return preferred;
  const activeGM = game.users?.activeGM ?? null;
  if (activeGM && candidates.some(user => user.id === activeGM.id)) return activeGM;
  return candidates
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .at(0) ?? null;
}

function getActiveApplicationAuthorityGM(payload = {}) {
  const sourceActor = globalThis.fromUuidSync?.(String(payload?.actorUuid ?? "")) ?? null;
  const sourceTokenDocument = globalThis.fromUuidSync?.(String(payload?.sourceTokenUuid ?? "")) ?? null;
  const requestedTargetTokenUuids = Array.from(new Set((Array.isArray(payload?.targetTokenUuids)
    ? payload.targetTokenUuids
    : [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  const targetTokenDocuments = requestedTargetTokenUuids
    .map(uuid => globalThis.fromUuidSync?.(String(uuid ?? "")) ?? null);
  const abilityItem = sourceActor?.items?.get?.(String(payload?.abilityItemId ?? "")) ?? null;
  const abilityFunction = normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .find(entry => entry.id === String(payload?.abilityFunctionId ?? "") && isActiveApplicationAbilityFunction(entry));
  const settings = normalizeActiveApplicationSettings(abilityFunction?.activeSettings);
  const tokenDocuments = [sourceTokenDocument, ...targetTokenDocuments].filter(Boolean);
  const sceneId = String(sourceTokenDocument?.parent?.id ?? "").trim();
  const completeSceneContext = Boolean(
    sceneId
    && sourceTokenDocument?.documentName === "Token"
    && targetTokenDocuments.length === requestedTargetTokenUuids.length
    && targetTokenDocuments.every(document => (
      document?.documentName === "Token"
      && String(document.parent?.id ?? "") === sceneId
    ))
  );
  return getResponsibleGM({
    sceneId: completeSceneContext ? sceneId : "",
    tokenDocuments,
    requireScene: Boolean(settings.wallsBlock),
    preferredUser: game.user
  });
}

function isTokenDocumentIncludedForUserLevel(tokenDocument = null, user = null) {
  if (typeof tokenDocument?.includedInLevel !== "function") return true;
  try {
    return Boolean(tokenDocument.includedInLevel(user?.viewedLevel ?? null));
  } catch (_error) {
    return false;
  }
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
    const updates = [];
    const readyMessages = [];
    const abilityItems = actor.itemTypes?.ability
      ?? actor.items?.filter(item => item.type === "ability")
      ?? [];
    for (const abilityItem of abilityItems) {
      const plan = prepareDeusExMachinaProgressUpdate(abilityItem, damage);
      if (!plan.update) continue;
      updates.push(plan.update);
      for (let index = 0; index < plan.readyMessageCount; index += 1) {
        readyMessages.push(abilityItem);
      }
    }
    if (!updates.length) continue;
    await actor.updateEmbeddedDocuments("Item", updates, {
      [DEUS_EX_MACHINA_PROGRESS_OPTION]: true
    });
    for (const abilityItem of readyMessages) {
      await createAbilityChatMessage(actor, abilityItem, "Накопление завершено. Способность готова к применению.");
    }
  }
}

function addActorDamageProgress(progressMap, actorUuid = "", damage = 0) {
  const key = String(actorUuid ?? "").trim();
  if (!key || damage <= 0) return;
  progressMap.set(key, (progressMap.get(key) ?? 0) + damage);
}

function prepareDeusExMachinaProgressUpdate(abilityItem, damage = 0) {
  const entries = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.deusExMachina);
  if (!entries.length || damage <= 0 || !abilityItem?.id) {
    return { update: null, readyMessageCount: 0 };
  }

  const state = getFixedAbilityState(abilityItem);
  const update = { _id: abilityItem.id };
  let readyMessageCount = 0;
  for (const entry of entries) {
    const settings = normalizeDeusExMachinaSettings(entry.fixedSettings);
    const stateKey = getFixedFunctionStateKey(entry);
    const current = state[stateKey] ?? {};
    const nextDamage = Math.max(0, toInteger(current.damage)) + damage;
    const ready = nextDamage >= settings.damageRequired;
    update[`${DEUS_EX_MACHINA_PROGRESS_FLAG_ROOT}.${stateKey}`] = {
      ...current,
      fixedKey: entry.fixedKey,
      damage: nextDamage,
      readyNotified: Boolean(current.readyNotified) || ready
    };
    if (ready && !current.readyNotified) readyMessageCount += 1;
  }
  return { update, readyMessageCount };
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
  else if (choice === "disintegrate") applied = await applyDeusExMachinaDisintegrate(actor, abilityItem, abilityFunction);
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

async function applyDeusExMachinaDisintegrate(actor, abilityItem, abilityFunction) {
  const targets = Array.from(game.user?.targets ?? []).filter(token => token?.actor);
  if (targets.length !== 1) {
    ui.notifications.warn("Для Забавного случая нужна ровно одна цель.");
    return false;
  }
  const targetToken = targets[0];
  const applied = await requestDeusExMachinaDisintegrateOperation({
    actorUuid: actor?.uuid ?? "",
    abilityItemId: abilityItem?.id ?? "",
    abilityFunctionId: abilityFunction?.id ?? "",
    targetTokenUuid: targetToken?.document?.uuid ?? targetToken?.uuid ?? "",
    targetActorUuid: targetToken?.actor?.uuid ?? "",
    senderUserId: game.user?.id ?? ""
  });
  if (!applied) {
    ui.notifications.warn("Не удалось применить Забавный случай.");
    return false;
  }
  return true;
}

async function requestDeusExMachinaDisintegrateOperation(payload = {}) {
  if (game.user?.isGM) return processDeusExMachinaDisintegrateOperation(payload);
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
    }, DEUS_EX_MACHINA_SOCKET_TIMEOUT_MS);
    pendingFixedAbilitySocketRequests.set(requestId, { resolve, timeout });
    game.socket.emit(FIXED_ABILITY_SOCKET, {
      scope: FIXED_ABILITY_SOCKET_SCOPE,
      action: "performDeusExMachinaDisintegrate",
      requestId,
      gmUserId: gm.id,
      senderUserId: game.user?.id ?? "",
      payload
    });
  });
}

async function processDeusExMachinaDisintegrateSocketRequest(message = {}) {
  const result = await processDeusExMachinaDisintegrateOperation({
    ...(message.payload ?? {}),
    senderUserId: message.senderUserId ?? message.payload?.senderUserId ?? ""
  });
  game.socket.emit(FIXED_ABILITY_SOCKET, {
    scope: FIXED_ABILITY_SOCKET_SCOPE,
    action: "deusExMachinaDisintegrateResult",
    requestId: message.requestId,
    targetUserId: message.senderUserId ?? "",
    result: { applied: Boolean(result) }
  });
}

async function processDeusExMachinaDisintegrateOperation(payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  const targetTokenUuid = String(payload.targetTokenUuid ?? "").trim();
  const targetActorUuid = String(payload.targetActorUuid ?? "").trim();
  const targetTokenDocument = targetTokenUuid ? await fromUuid(targetTokenUuid) : null;
  const targetActor = targetTokenDocument?.actor ?? (targetActorUuid ? await fromUuid(targetActorUuid) : null);
  const abilityItem = actor?.items?.get(String(payload.abilityItemId ?? ""));
  const abilityFunction = normalizeAbilityFunctions(abilityItem?.system?.functions ?? [])
    .find(entry => entry.id === payload.abilityFunctionId && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.deusExMachina);
  const sender = game.users?.get(String(payload.senderUserId ?? ""));
  if (!actor || !targetActor || !abilityItem || !abilityFunction) return false;
  if (sender && !sender.isGM && !actor.testUserPermission(sender, "OWNER")) return false;

  const settings = normalizeDeusExMachinaSettings(abilityFunction.fixedSettings);
  const state = getFixedAbilityState(abilityItem);
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  if (Math.max(0, toInteger(state[stateKey]?.damage)) < settings.damageRequired) return false;

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
  const requestedDeletes = [];
  for (const item of actor.items ?? []) {
    if (!isDestroyablePossession(item)) continue;
    const quantity = Math.max(1, toInteger(item.system?.quantity ?? 1));
    const destroyQuantity = destroyPercent >= 100 ? quantity : Math.floor((quantity * destroyPercent) / 100);
    if (destroyQuantity <= 0) continue;
    if (destroyQuantity >= quantity) requestedDeletes.push(item.id);
    else itemUpdates.push({ _id: item.id, "system.quantity": quantity - destroyQuantity });
  }

  const initialDeleteClosure = new Set(expandInventoryDeleteIds(actor.items, requestedDeletes));
  const protectedUpdates = [];
  for (const itemId of initialDeleteClosure) {
    const item = actor.items?.get(itemId);
    if (!item || isDestroyablePossession(item)) continue;
    if (String(item.system?.container?.parentId ?? "") === ROOT_CONTAINER_ID) continue;
    protectedUpdates.push({
      _id: item.id,
      "system.container.parentId": ROOT_CONTAINER_ID
    });
  }
  const survivingUpdates = itemUpdates.filter(update => !initialDeleteClosure.has(String(update._id)));
  if (survivingUpdates.length || protectedUpdates.length || requestedDeletes.length) {
    await executeInventoryMutation({
      actor,
      updates: [...survivingUpdates, ...protectedUpdates],
      deletes: requestedDeletes
    }, { reason: "deus-ex-machina-disintegrate" });
  }

  const currencyUpdate = {};
  for (const key of Object.keys(actor.system?.currencies ?? {})) {
    const amount = Math.max(0, toInteger(actor.system.currencies[key]));
    const destroyed = destroyPercent >= 100 ? amount : Math.floor((amount * destroyPercent) / 100);
    currencyUpdate[`system.currencies.${key}`] = Math.max(0, amount - destroyed);
  }
  if (Object.keys(currencyUpdate).length) await actor.update(currencyUpdate);
}

function isDestroyablePossession(item) {
  return Boolean(item?.type === "gear" && !isNaturalRaceItem(item));
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

function getResponsibleActorOwner(actor) {
  return (game.users?.contents ?? [])
    .filter(user => user.active && !user.isGM && actor?.testUserPermission?.(user, "OWNER"))
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function getAbilityDisplayName(item) {
  return String(item?.name ?? "").trim() || "Способность";
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
