import { calculateSkillCheckSuccessChance, createSkillCheckBatchCollector, requestSkillCheck } from "../rolls/skill-check.mjs";
import { SYSTEM_ID } from "../constants.mjs";
// #region codex-runtime-debug H21 temporary numeric request composition
import { captureDamageRequestProbe, recordDamageRequestProbe } from "../debug/damage-request-probe.mjs";
// #endregion codex-runtime-debug
import { mergeSkillCheckResultPolicies } from "../rolls/skill-check-result-policy.mjs";
import { isDeusExMachinaProgressItemUpdate } from "../abilities/deus-ex-machina-progress-runtime.mjs";
import { isPhantomEntity } from "../abilities/phantom-entity.mjs";
import { getFalseBreachDisplayedDodgeDifficulty } from "../abilities/false-breach.mjs";
import {
  getCombatVisualizationLayer,
  playWeaponAttackAnimations,
  playWeaponExplosionAnimation
} from "./attack-animations.mjs";
import { applyDamageCostModifier, applyDamageRequestsInCurrentHubOperation, estimateDamageApplicationsBatch, getDamageCostModifierState, getLimbHealingCap, isLimbDestroyed, requestDamageApplications, runDamageHubOperation } from "./damage-hub.mjs";
import { createDodgeAttackExposureTracker, getWeaponDodgeAttackMultiplier } from "./dodge-resource.mjs";
import {
  createPelletImpactProjectiles,
  distributePelletImpactDamage,
  getPelletProjectileCount
} from "./pellet-impact.mjs";
import {
  DELAYED_THROWN_ITEM_FLAG,
  DELAYED_THROWN_ITEM_REGION_FLAG,
  createThrownItemTile,
  deleteDelayedThrownItemDocuments,
  deleteDelayedThrownItemWorldDocuments,
  deleteThrownItemTileByOperation,
  isDelayedThrownItemWorldOperationCancelled,
  registerDelayedThrownItemWorldOperation
} from "../canvas/thrown-items.mjs";
import { getActorPostureAction, getActorPostureWeaponActionPointCostBonus } from "../canvas/posture-movement.mjs";
import {
  ITEM_FUNCTIONS,
  WEAPON_SPECIAL_PROPERTIES,
  createActorItemOrInstalledModuleUpdate,
  createWeaponFunctionUpdateData,
  getActorInstalledModuleItems,
  getConditionFunction,
  getConditionWeakeningData,
  getDamageSourceFunction,
  getDeployedWeaponSetKey,
  getEnergyConsumerFunction,
  getWeaponAttackPowerState,
  getWeaponFunctionById,
  hasItemFunction,
  hasWeaponSpecialPropertyData,
  parseModuleWeaponFunctionId
} from "../utils/item-functions.mjs";
import { getCoverSettings, getCombatSettings, getCreatureOptions, getDamageTypeSettings, getResourceSettings, getSkillSettings } from "../settings/accessors.mjs";
import {
  ABILITY_ACTION_EXECUTOR_MODES,
  ABILITY_ACTION_POINT_COST_MODES,
  ABILITY_ACTION_TARGET_MODES,
  ABILITY_ACTION_TYPES,
  ABILITY_ATTACK_ACTION_ALL,
  ABILITY_ATTACKING_WEAPON_ACTION_KEYS,
  ABILITY_CONSTRUCT_TYPES,
  ABILITY_DAMAGE_AMOUNT_MODES,
  ABILITY_DAMAGE_LIMB_MODES,
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityConstructs,
  normalizeAbilityFunctions,
  normalizeActiveApplicationSettings
} from "../settings/abilities.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  canSpendCombatActionPoints,
  canSpendStrictActionPoints,
  getCombatActionPointState,
  getStrictActionPointState,
  notifyCombatActionPointReceipt,
  refundCombatActionPointReceipt,
  refundStrictActionPointReceipt,
  spendCombatActionPointsWithReceipt,
  spendStrictActionPointsWithReceipt
} from "./reaction-resources.mjs";
import { applyAttackActionPointMovementLoss } from "./attack-action-point-movement-loss.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { getWeaponProficiencyInfluenceBonus as getWeaponProficiencyInfluenceBonusForData } from "../utils/weapon-proficiencies.mjs";
import { normalizeRegionSpecialProperties, resolveRegionSpecialProperties } from "../utils/region-special-properties.mjs";
import { getSphericalRegionElevation, getSphericalRegionFlags } from "../utils/region-elevation.mjs";
import {
  applySkillBonusPercent,
  getSkillValueBeforePercent
} from "../utils/skill-value.mjs";
import {
  getEffectiveRangeDistanceState,
  normalizeAttackDistanceContext
} from "../utils/attack-distance.mjs";
import { serializeWeaponContextData } from "../utils/weapon-context.mjs";
import {
  applyWeaponEffectiveRangeBonuses,
  resolveBaseWeaponEffectiveRange
} from "../utils/weapon-range.mjs";
import {
  AIMED_EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_FAR_RESTRICTION_DISABLED_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY,
  AIMED_EFFECTIVE_RANGE_NEAR_RESTRICTION_DISABLED_EFFECT_KEY,
  ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY,
  ALL_SKILLS_CRITICAL_FAILURE_CHANCE_EFFECT_KEY,
  ALL_SKILLS_CRITICAL_SUCCESS_CHANCE_EFFECT_KEY,
  ATTACK_RANGE_BONUS_EFFECT_KEY,
  CONDITION_LOSS_MULTIPLIER_EFFECT_KEY,
  CRITICAL_DAMAGE_PERCENT_EFFECT_KEY,
  EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY,
  EFFECTIVE_RANGE_FAR_PENALTY_PERCENT_EFFECT_KEY,
  EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY,
  EFFECTIVE_RANGE_NEAR_PENALTY_PERCENT_EFFECT_KEY,
  evaluateActorEffectChangeNumber,
  SKILL_CHECK_DISABLED_RESULT_EFFECT_KEYS
} from "../utils/active-effect-changes.mjs";
import { getAimedRangeSelectionState } from "../utils/aimed-range.mjs";
import { getRequiredWeaponSlotsForItem, getWeaponSlotRequirement, isContainerWeaponSetKey } from "../utils/equipment-slots.mjs";
import { selectRandomWeightedLimbKey } from "../utils/limb-randomization.mjs";
import { applyWeaponModuleModifiers, getWeaponNoiseLevel } from "../utils/weapon-modules.mjs";
import {
  getDamageSourceAdjustedNoiseLevel,
  mergeDamageSourceSpecialProperties,
  resolveDamageSourceAnimationKey
} from "../utils/damage-source-weapon.mjs";
import { NATURAL_RACE_WEAPON_SET_KEY, isNaturalRaceWeapon } from "../races/natural-items.mjs";
import {
  calculateStealthDamageBonusAmount,
  clearWeaponNoisePreview,
  getStealthAttackModifiers,
  isActorStealthed,
  resolveWeaponNoiseDetection,
  setWeaponNoisePreview
} from "../stealth/index.mjs";
import {
  getActorAtRandomActionPointCostReduction,
  getWeaponActionBlockState,
  hasActorFixedAbilityFunction
} from "../abilities/runtime-state.mjs";
import {
  applyPreparedSourceContextualAbilityChanges,
  getContextualAbilityChangeValue,
  getContextualAbilityChangeValues,
  getPreparedSourceContextualAbilityChanges,
  getSourceContextualAbilityChangeValues,
  getSourceContextualAbilityChangeValue,
  getTargetReverseAbilityChangeValue,
  mergePreparedSourceContextualAbilityChanges
} from "../abilities/evaluation.mjs";
import {
  getAuraRelation,
  hasAuraLineOfSight,
  measureTokenDistanceMeters
} from "../abilities/aura-conditions.mjs";
import { getKnockbackMaximumStrength, resolveKnockback } from "./active-actions.mjs";
import { getWeaponSkillDamageBonuses } from "./weapon-skill-damage.mjs";
import { buildActorFormulaData, evaluateActorFormula, isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { evaluateFormula } from "../formulas/evaluation.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";
import {
  cancelPendingAttackAutoCoverSync,
  clearAttackAutoCoverSync,
  getActorForcedCoverData,
  queueAttackAutoCoverSync,
  syncAttackAutoCoverNow
} from "../canvas/cover.mjs";
import {
  getCoverSampleMasksIntersectingSegments,
  resolveCoverFromSampleMasks
} from "../canvas/cover-contours.mjs";
import { REACTION_EVENT_KEYS, REACTION_RESULT, isActorUnableToAct, isReactionSystemLocked, requestReactionEvent } from "./reaction-hub.mjs";
import {
  createAttackActionDirectionModifier,
  createAttackActionTargetedModifier,
  createCounterSniperAttackModifier,
  getWeaponAttackModifierAccuracyModifier,
  getWeaponAttackModifierCriticalChanceModifier,
  getWeaponAttackModifierDamagePercentModifier,
  getWeaponAttackModifierDifficultyBonus,
  isWhirlwindAttackModifier,
  normalizeWeaponAttackModifier
} from "./weapon-attack-modifiers.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { energySourceMatchesConsumer, getActiveEnergySourceItem, getEnergySourceReserveState } from "../items/light-source.mjs";
import { getConstructPartLimbKey, getConstructPartSlotId } from "../utils/construct-parts.mjs";
import {
  canTokenPhysicallySeeTarget,
  testObserverVisibilityBatch
} from "../canvas/physical-los.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import {
  emitWeaponAttackCheckResolved,
  emitWeaponAttackResolved
} from "../events/foundry-compatibility-events.mjs";
import { isActorInActiveCombat } from "./combat-membership.mjs";
import { requestCustomTokenSelection } from "../canvas/custom-token-selection.mjs";
import {
  getActiveCanvasTargetSelectionSession,
  startCanvasTargetSelectionSession
} from "../canvas/target-selection-lifecycle.mjs";
import { createLatestFrameScheduler } from "../canvas/latest-frame-scheduler.mjs";
import { getActiveUseOperationId } from "../abilities/active-use-runtime.mjs";
import { planInventoryItemConsumption } from "../inventory/consume.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import { createActorOperationLock } from "../utils/actor-operation-lock.mjs";
import {
  ENERGY_RESOURCE_KEY,
  canActorSpendEnergy,
  getActorAvailableEnergy
} from "./energy-resource.mjs";
import { isCombatResourceCostActive } from "./resource-cost-policy.mjs";
import { getAdjustedWeaponRequirement } from "../items/requirement-modifiers.mjs";
import { getActorResourceLimitAmount } from "./resource-limits.mjs";
import {
  getAbilityAttackActionKey,
  getAbilityAttackFunction,
  getAbilityAttackSettings,
  getAttackSourceModuleSlots,
  getAttackSourceRawData,
  isAttackSource,
  projectAbilityAttackData,
  resolveAttackSource
} from "./attack-source.mjs";
import {
  notifyAbilityTriggerCostFailure,
  payActorResourceCosts,
  payAbilityFunctionResourceCosts,
  quoteActorResourceCosts,
  quoteAbilityFunctionResourceCosts
} from "../abilities/trigger-cost-runtime.mjs";
import {
  buildAttackTrialFormulaData,
  createAttackTrialResolutionState,
  resolveAttackTrialResolution
} from "./attack-trial-resolution.mjs";
import {
  applyAttackTrialOutcomeConsequences,
  resolveAttackTrialOutcomeCriticalDamage
} from "./attack-trial-consequences.mjs";
import {
  getBurstSampleCount,
  getEvenBurstSampleOffset
} from "./burst-sampling-policy.mjs";

export { canTokenPhysicallySeeTarget } from "../canvas/physical-los.mjs";

const { DialogV2 } = foundry.applications.api;
const WEAPON_ATTACK_SOCKET = `system.${SYSTEM_ID}`;
const WEAPON_ATTACK_SOCKET_SCOPE = "weaponAttackPreview";
export const WEAPON_ATTACK_DAMAGE_RESOLVED_HOOK = "fallout-maw.weaponAttackDamageResolved";
export const WEAPON_ATTACK_RESOLVED_HOOK = "fallout-maw.weaponAttackResolved";
export const WEAPON_ATTACK_CHECK_RESOLVED_HOOK = "fallout-maw.weaponAttackCheckResolved";
export const WEAPON_ATTACK_DUPLICATE_REQUEST_HOOK = "fallout-maw.weaponAttackDuplicateRequests";
export const WEAPON_ACTION_MODIFIER_REQUEST_HOOK = "fallout-maw.weaponActionModifierRequests";
const PREVIEW_BROADCAST_INTERVAL_MS = 16;
const PREVIEW_POSITION_EPSILON = 0.5;
const PREVIEW_ANGLE_EPSILON = 0.002;
const BURST_PREVIEW_STABILIZE_MS = 120;
const BURST_PREVIEW_FORCE_ANGLE_DELTA = 0.012;
const BURST_PREVIEW_FORCE_DISTANCE_DELTA = 24;
const AIMED_TARGET_BLOCKER_BONUS_STEP = 20;
const DEFAULT_WEAPON_ATTACK_CONE_DEGREES = 3;
const DEFAULT_WEAPON_ACTION_POINT_COST = 5;
const DEFAULT_WEAPON_PUSH_MAX_RANGE_METERS = 1;
const BASE_VOLLEY_DIFFICULTY = 60;
const VOLLEY_ACTION_KEY = "volley";
const PUSH_ACTION_KEY = "push";
const SKILL_ALIASES = Object.freeze({
  ath: "athletics",
  prc: "resilience"
});
const ACTION_PENETRATION_KEY_PREFIX = "system.penetration.actions.";
const ALL_ACTION_PENETRATION_KEY = `${ACTION_PENETRATION_KEY_PREFIX}all`;
const SELECTED_HUD_WEAPON_FLAG = "selectedHudWeaponItemId";
const SELECTED_HUD_WEAPON_SET_FLAG = "selectedHudWeaponSetKey";
const PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const DEFAULT_REGION_DAMAGE_INTERVAL_SECONDS = 6;
const REGION_SOCKET_REQUEST_TIMEOUT_MS = 60000;
const COMMANDED_ATTACK_QUERY = "fallout-maw.weaponAttack.commandedAbility";
const COMMANDED_ATTACK_QUERY_TIMEOUT_MS = 120000;
const ORDINARY_ATTACK_TICKET_QUERY = "fallout-maw.weaponAttack.ordinaryTicket";
const ORDINARY_ATTACK_TICKET_QUERY_TIMEOUT_MS = 3000;
const ORDINARY_ATTACK_TICKET_TTL_MS = 10000;
const ORDINARY_ATTACK_ACCEPT_TIMEOUT_MS = 5000;
const ORDINARY_ATTACK_COMPLETION_TIMEOUT_MS = 120000;
const ORDINARY_ATTACK_PROGRESS_INTERVAL_MS = 2000;
const ORDINARY_ATTACK_RECOVERY_TIMEOUT_MS = 10000;
const ORDINARY_ATTACK_HARD_TIMEOUT_MS = 150000;
const ORDINARY_ATTACK_COMPLETED_TTL_MS = 5 * 60 * 1000;
const ORDINARY_ATTACK_CACHE_LIMIT = 512;
const MELEE_ACTION_KEYS = new Set(["meleeAttack", "aimedMeleeAttack"]);
const UNAIMED_ATTACK_MODE = "unaimed";
const UNAIMED_ATTACK_DISADVANTAGE_COUNT = 3;
const MELEE_DIRECTIONS = Object.freeze([
  { key: "thrust", label: "Укол", mode: "thrust" },
  { key: "rightToLeft", label: "Справа налево", mode: "swing" },
  { key: "leftToRight", label: "Слева направо", mode: "swing" }
]);
const SWING_ARC_EPSILON = 0.0001;
const GEOMETRY_EPSILON = 0.0001;
const AUTO_COVER_GRID_STEPS = 4;
const remoteAttackPreviews = new Map();
const pendingRegionSocketRequests = new Map();
const pendingOrdinaryAttackRequests = new Map();
const ordinaryAttackTickets = new Map();
const ordinaryAttackOperationsInFlight = new Map();
const ordinaryAttackOperationsCompleted = new Map();
const ordinaryAttackActorQueues = new Map();
const ordinaryAttackAuthoritySockets = new Map();
const processingDelayedVolleyRegions = new Set();
const weaponAttackResolvedHandlers = new Map();
const weaponAttackTerminalHandlers = new Map();
const liveWeaponAttackTargetControllers = new Set();
const weaponResourceActorLock = createActorOperationLock();
let activeAttack = null;
let activeDualWeaponAttack = null;
let activeCommandedAttack = null;
let delayedVolleyProcessorRegistered = false;
let weaponAttackTokenLifecycleHooksRegistered = false;

function invalidateLiveWeaponAttackControllers(tokenOrDocument = null, options = {}) {
  if (!tokenOrDocument) return;
  for (const controller of Array.from(liveWeaponAttackTargetControllers)) {
    controller.handleTokenUnavailable?.(tokenOrDocument, options);
  }
}

function registerWeaponAttackTokenLifecycleHooks() {
  if (weaponAttackTokenLifecycleHooksRegistered) return;
  Hooks.on("deleteToken", tokenDocument => {
    invalidateLiveWeaponAttackControllers(tokenDocument, { matchUuid: true });
  });
  Hooks.on("destroyToken", token => {
    if (token?.isPreview || token?.document?.isPreview) return;
    invalidateLiveWeaponAttackControllers(token);
  });
  weaponAttackTokenLifecycleHooksRegistered = true;
}

export function registerWeaponAttackResolvedHandler(id = "", handler = null) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId || typeof handler !== "function") return () => undefined;
  weaponAttackResolvedHandlers.set(normalizedId, handler);
  return () => {
    if (weaponAttackResolvedHandlers.get(normalizedId) === handler) weaponAttackResolvedHandlers.delete(normalizedId);
  };
}

/**
 * Register destructive cleanup which runs only after the attack controller
 * has released its processing state. Terminal work must never hold the attack
 * UI open while Foundry waits for a Document deletion response.
 */
export function registerWeaponAttackTerminalHandler(id = "", handler = null) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId || typeof handler !== "function") return () => undefined;
  weaponAttackTerminalHandlers.set(normalizedId, handler);
  return () => {
    if (weaponAttackTerminalHandlers.get(normalizedId) === handler) weaponAttackTerminalHandlers.delete(normalizedId);
  };
}

async function publishWeaponAttackResolved(context = {}) {
  for (const [id, handler] of weaponAttackResolvedHandlers) {
    try {
      await handler(context);
    } catch (error) {
      console.error(`${SYSTEM_ID} | Weapon attack resolved handler '${id}' failed`, error);
    }
  }
  await emitWeaponAttackResolved(context);
  Hooks.callAll(WEAPON_ATTACK_RESOLVED_HOOK, {
    ...context,
    falloutMawSemanticMirror: true
  });
}

async function runWeaponAttackTerminalHandlers(context = {}) {
  await Promise.all(Array.from(weaponAttackTerminalHandlers, async ([id, handler]) => {
    try {
      await handler(context);
    } catch (error) {
      console.error(`${SYSTEM_ID} | Weapon attack terminal handler '${id}' failed`, error);
    }
  }));
}

function dispatchWeaponAttackTerminalHandlers(context = {}) {
  const damageResults = serializeWeaponAttackTerminalDamageResults(context?.damageResults);
  if (!damageResults.length) return false;
  const responsibleGM = getResponsibleGM();
  if (game.user?.isActiveGM || responsibleGM?.id === game.user?.id) {
    void runWeaponAttackTerminalHandlers(context);
    return true;
  }
  if (!responsibleGM?.id) return false;
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "weaponAttackTerminal",
    targetUserId: responsibleGM.id,
    senderUserId: game.user?.id ?? "",
    context: {
      attackId: String(context?.attackId ?? ""),
      attackerUuid: String(context?.attackerUuid ?? context?.actorUuid ?? ""),
      damageResults
    }
  });
  return true;
}

function serializeWeaponAttackTerminalDamageResults(results = []) {
  return (Array.isArray(results) ? results : [results]).flat(Infinity)
    .filter(result => (
      result?.phantomDestroyed === true
      && result?.source?.weaponAttackDamage === true
    ))
    .map(result => ({
      actorUuid: String(result?.actor?.uuid ?? result?.actorUuid ?? ""),
      mode: String(result?.mode ?? "damage"),
      phantomDestroyed: true,
      source: {
        attackId: String(result?.source?.attackId ?? ""),
        attackerActorUuid: String(
          result?.source?.attackerActorUuid
          ?? result?.source?.attackerUuid
          ?? ""
        ),
        targetTokenUuid: String(result?.source?.targetTokenUuid ?? ""),
        weaponAttackDamage: true
      }
    }));
}

function authorizeWeaponAttackTerminalContext(context = {}, sender = null) {
  if (!sender?.active) return null;
  const attackId = String(context?.attackId ?? "").trim();
  const attackerUuid = String(context?.attackerUuid ?? "").trim();
  const attacker = attackerUuid ? fromUuidSync(attackerUuid) : null;
  if (!attackId || !attacker || (!sender.isGM && !attacker.testUserPermission?.(sender, "OWNER"))) return null;

  const damageResults = [];
  for (const result of serializeWeaponAttackTerminalDamageResults(context?.damageResults)) {
    if (result.source.attackId !== attackId) continue;
    if (result.source.attackerActorUuid && result.source.attackerActorUuid !== attackerUuid) continue;
    const targetToken = fromUuidSync(result.source.targetTokenUuid);
    const targetActor = targetToken?.actor ?? fromUuidSync(result.actorUuid);
    if (!isPhantomEntity(targetToken) && !isPhantomEntity(targetActor)) continue;
    damageResults.push({ ...result, actor: targetActor ?? null });
  }
  if (!damageResults.length) return null;
  return { attackId, attackerUuid, actorUuid: attackerUuid, damageResults };
}

class WeaponActionModifierState {
  constructor(context = {}) {
    this.context = context;
    this.combatValueBonuses = new Map();
    this.resourceCostMultipliers = new Map();
    this.spendRequirements = [];
    this.options = new Map();
  }

  addCombatValue(key = "", value = 0) {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) return;
    const entry = this.combatValueBonuses.get(normalizedKey) ?? { value: 0, resolvers: [] };
    if (typeof value === "function") entry.resolvers.push(value);
    else entry.value += toInteger(value);
    this.combatValueBonuses.set(normalizedKey, entry);
  }

  getCombatValueBonus(key = "", context = {}) {
    const entry = this.combatValueBonuses.get(String(key ?? "").trim());
    if (!entry) return 0;
    let value = toInteger(entry.value);
    for (const resolver of entry.resolvers ?? []) value += toInteger(resolver({ ...this.context, ...context }));
    return value;
  }

  multiplyResourceCost(type = "", multiplier = 1) {
    const normalizedType = String(type ?? "").trim();
    if (!normalizedType) return;
    const normalizedMultiplier = Math.max(0, Number(multiplier) || 0);
    const currentMultiplier = Number(this.resourceCostMultipliers.get(normalizedType));
    this.resourceCostMultipliers.set(
      normalizedType,
      (Number.isFinite(currentMultiplier) ? currentMultiplier : 1) * normalizedMultiplier
    );
  }

  getResourceCostMultiplier(type = "") {
    const multiplier = Number(this.resourceCostMultipliers.get(String(type ?? "").trim()));
    return Number.isFinite(multiplier) ? multiplier : 1;
  }

  setOption(key = "", value = true) {
    const normalizedKey = String(key ?? "").trim();
    if (normalizedKey) this.options.set(normalizedKey, value);
  }

  getOption(key = "") {
    return this.options.get(String(key ?? "").trim());
  }

  addSpendRequirement(requirement = {}) {
    if (!requirement || typeof requirement !== "object") return;
    if (
      requirement.energyCost === undefined
      && typeof requirement.getEnergyCost !== "function"
      && typeof requirement.canSpend !== "function"
      && typeof requirement.spend !== "function"
    ) return;
    this.spendRequirements.push(requirement);
  }

  getEnergyCost(context = {}) {
    let total = 0;
    for (const requirement of this.spendRequirements) {
      const cost = requirement.energyCost ?? requirement.getEnergyCost;
      if (typeof cost === "function") total += Math.max(0, toInteger(cost({ ...this.context, ...context })));
      else total += Math.max(0, toInteger(cost));
    }
    return total;
  }

  canSpend(context = {}) {
    const resolvedContext = { ...this.context, ...context };
    const actor = resolvedContext.actor
      ?? resolvedContext.actorToken?.actor
      ?? resolvedContext.token?.actor
      ?? null;
    const energyCost = this.getEnergyCost(resolvedContext);
    if (energyCost > 0 && !canActorSpendEnergy(actor, energyCost)) {
      if (!resolvedContext.silent) {
        ui.notifications.warn(
          `Недостаточно энергии для модификаторов атаки (${getActorAvailableEnergy(actor)} / ${energyCost}).`
        );
      }
      return false;
    }
    for (const requirement of this.spendRequirements) {
      if (typeof requirement.canSpend !== "function") continue;
      if (requirement.canSpend(resolvedContext) === false) return false;
    }
    return true;
  }

  async spend(context = {}) {
    if (!this.canSpend(context)) return false;
    return this.commit(context);
  }

  async commit(context = {}) {
    const resolvedContext = { ...this.context, ...context };
    for (const requirement of this.spendRequirements) {
      if (typeof requirement.spend !== "function") continue;
      if ((await requirement.spend(resolvedContext)) === false) return false;
    }
    return true;
  }
}

function createWeaponReactionCoordinator() {
  let tail = Promise.resolve();
  return {
    run(operation) {
      const result = tail
        .catch(() => undefined)
        .then(() => operation());
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    drain() {
      return tail.catch(() => undefined);
    }
  };
}

function collectWeaponActionModifierState(context = {}) {
  const state = new WeaponActionModifierState(context);
  const hasConditionCost = (context?.weaponData?.resourceCosts ?? []).some(cost => (
    String(cost?.type ?? "").trim() === "condition"
    && Number(cost?.amount) > 0
  ));
  if (hasConditionCost) {
    const actor = context?.actor ?? context?.actorToken?.actor ?? context?.token?.actor ?? null;
    const preparedMultiplier = Number(actor?.system?.combat?.conditionLossMultiplier);
    const conditionLossMultiplier = actor
      ? getSourceContextualAbilityChangeValue(actor, CONDITION_LOSS_MULTIPLIER_EFFECT_KEY, {
        ...context,
        baseValue: Number.isFinite(preparedMultiplier) ? preparedMultiplier : 1
      })
      : 1;
    state.multiplyResourceCost(
      "condition",
      Number.isFinite(Number(conditionLossMultiplier)) ? Math.max(0, Number(conditionLossMultiplier)) : 1
    );
  }
  Hooks.callAll(WEAPON_ACTION_MODIFIER_REQUEST_HOOK, {
    ...context,
    modifierState: state,
    addCombatValue: (key, value) => state.addCombatValue(key, value),
    multiplyResourceCost: (type, multiplier) => state.multiplyResourceCost(type, multiplier),
    addSpendRequirement: requirement => state.addSpendRequirement(requirement)
  });
  return state;
}

function prepareWeaponActionResourcePreviewContext({
  attackerToken = null,
  token = null,
  actor = null,
  weapon = null,
  actionKey = "",
  weaponFunctionId = "",
  attackModifier = null,
  attackCount = null
} = {}) {
  const resolvedToken = token ?? attackerToken?.object ?? attackerToken ?? null;
  const resolvedActor = actor ?? resolvedToken?.actor ?? weapon?.actor ?? null;
  const normalizedActionKey = String(actionKey ?? "").trim();
  if (!resolvedActor || !weapon || !normalizedActionKey) return null;
  const normalizedAttackCount = attackCount === null || attackCount === undefined
    ? getActionAttackCount(weapon, normalizedActionKey, weaponFunctionId)
    : Math.max(1, toInteger(attackCount));
  const context = {
    actor: resolvedActor,
    actorToken: resolvedToken,
    token: resolvedToken,
    weapon,
    actionKey: normalizedActionKey,
    weaponActionKey: normalizedActionKey,
    weaponFunctionId,
    weaponData: getWeaponAttackData(weapon, weaponFunctionId),
    attackModifier,
    controller: null,
    attackCount: normalizedAttackCount
  };
  return {
    actor: resolvedActor,
    attackCount: normalizedAttackCount,
    context,
    modifierState: collectWeaponActionModifierState(context)
  };
}

function normalizeAdditionalActorResourceCosts(costs = []) {
  return (Array.isArray(costs) ? costs : [])
    .map((cost, index) => ({
      id: String(cost?.id ?? "").trim() || `weapon-additional-actor-cost-${index + 1}`,
      type: "actorResource",
      resourceKey: String(cost?.resourceKey ?? "").trim(),
      amount: Math.max(0, toInteger(cost?.amount))
    }))
    .filter(cost => cost.resourceKey && cost.amount > 0);
}

export function getWeaponActionModifierEnergyCost({
  attackerToken = null,
  token = null,
  actor = null,
  weapon = null,
  actionKey = "",
  weaponFunctionId = "",
  attackModifier = null,
  attackCount = null
} = {}) {
  const prepared = prepareWeaponActionResourcePreviewContext({
    attackerToken,
    token,
    actor,
    weapon,
    actionKey,
    weaponFunctionId,
    attackModifier,
    attackCount
  });
  return prepared?.modifierState?.getEnergyCost({ attackCount: prepared.attackCount }) ?? 0;
}

export function getWeaponActionResourcePreview({
  attackerToken = null,
  token = null,
  actor = null,
  weapon = null,
  actionKey = "",
  weaponFunctionId = "",
  attackModifier = null,
  attackCount = null,
  additionalActorResourceCosts = []
} = {}) {
  const prepared = prepareWeaponActionResourcePreviewContext({
    attackerToken,
    token,
    actor,
    weapon,
    actionKey,
    weaponFunctionId,
    attackModifier,
    attackCount
  });
  if (!prepared) {
    return {
      attackCount: 0,
      baseEnergyCost: 0,
      modifierEnergyCost: 0,
      energyCost: 0,
      missing: null
    };
  }
  const modifierEnergyCost = Math.max(
    0,
    toInteger(prepared.modifierState.getEnergyCost({ attackCount: prepared.attackCount }))
  );
  const baseEnergyCost = Math.max(0, toInteger(getWeaponActorResourceCostTotal(
    weapon,
    ENERGY_RESOURCE_KEY,
    { modifierState: prepared.modifierState, weaponFunctionId }
  )));
  return {
    attackCount: prepared.attackCount,
    baseEnergyCost,
    modifierEnergyCost,
    energyCost: baseEnergyCost + modifierEnergyCost,
    missing: getMissingWeaponResourceCost(weapon, prepared.attackCount, weaponFunctionId, {
      modifierState: prepared.modifierState,
      additionalActorResourceCosts
    })
  };
}

export function registerWeaponAttackSocket() {
  CONFIG.queries ??= {};
  CONFIG.queries[COMMANDED_ATTACK_QUERY] = handleCommandedWeaponAttackQuery;
  CONFIG.queries[ORDINARY_ATTACK_TICKET_QUERY] = handleOrdinaryWeaponAttackTicketQuery;
  game.socket.on(WEAPON_ATTACK_SOCKET, handleWeaponAttackSocketMessage);
  Hooks.on("canvasReady", clearRemoteAttackPreviews);
  Hooks.on("canvasTearDown", clearWeaponAttackCanvasState);
  registerWeaponAttackTokenLifecycleHooks();
  if (!delayedVolleyProcessorRegistered) {
    registerQueuedWorldTimeProcessor(processDelayedVolleyExplosions, { priority: 90 });
    Hooks.on("canvasReady", () => {
      void processDelayedVolleyExplosions(Number(game.time?.worldTime) || 0);
    });
    delayedVolleyProcessorRegistered = true;
  }
}

export function cancelWeaponAttack({ ignoreReactionLock = false } = {}) {
  if (!ignoreReactionLock && isReactionSystemLocked() && !activeAttack?.attackModifier?.preventCancel) return false;
  if (activeAttack?.processing || activeCommandedAttack?.processing) return false;
  const attack = activeAttack;
  activeAttack = null;
  attack?.finishTargetSelection({ cancelled: true });
  attack?.destroy();
  activeDualWeaponAttack?.destroy();
  activeDualWeaponAttack = null;
  activeCommandedAttack?.cancel();
  activeCommandedAttack = null;
  return true;
}

export function requestWeaponAttackCompletion({ attackId = "" } = {}) {
  const normalizedAttackId = String(attackId ?? "").trim();
  if (!normalizedAttackId) return false;
  requestActiveWeaponAttackFinish(normalizedAttackId);
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "completeAttack",
    attackId: normalizedAttackId,
    senderUserId: game.user?.id ?? ""
  });
  return true;
}

class DualWeaponAttackPreview {
  constructor(token = null, entries = []) {
    this.token = token;
    this.weaponEntries = Array.isArray(entries) ? entries : [];
    this.sourceId = `dual-weapon-attack:${foundry.utils.randomID()}`;
    this.noiseLevel = this.getCombinedNoiseLevel();
    this.destroyed = false;
    this.suppressed = false;
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    this.entries = [];
    getCombatVisualizationLayer().addChild(this.container);
    this.onItemUpdate = this.onItemUpdate.bind(this);
    Hooks.on("updateItem", this.onItemUpdate);
    setWeaponNoisePreview(this.token, this.sourceId, this.noiseLevel);
  }

  getCombinedNoiseLevel() {
    return Math.max(0, ...this.weaponEntries.map(entry => (
      getWeaponNoiseLevel(getWeaponAttackData(entry.weapon, entry.weaponFunctionId))
    )));
  }

  onItemUpdate(item = null, changes = {}, options = {}) {
    if (isDeusExMachinaProgressItemUpdate(changes, options)) return;
    if (item?.parent?.uuid !== this.token?.actor?.uuid || this.destroyed) return;
    this.noiseLevel = this.getCombinedNoiseLevel();
    if (!this.suppressed) setWeaponNoisePreview(this.token, this.sourceId, this.noiseLevel);
  }

  add(selection = {}) {
    const geometry = deserializeGeometry(selection.lockedGeometry) ?? deserializeGeometry(selection.geometry);
    if (!geometry) return;
    const shape = new PIXI.Graphics();
    const targetMarkers = new PIXI.Graphics();
    this.container.addChild(shape, targetMarkers);
    drawAttackShape(shape, geometry, {
      locked: true,
      hasTargets: Boolean(selection.targetUuid)
    });
    const target = resolveTokenObjectFromUuidSync(selection.targetUuid);
    drawTargetMarkerPositions(
      targetMarkers,
      target ? [getTargetMarkerPreviewData(target)].filter(Boolean) : [],
      target ? getTargetCenterMarkerPosition(target) : null
    );
    this.entries.push({ shape, targetMarkers });
    this.noiseLevel = Math.max(
      this.noiseLevel,
      getWeaponNoiseLevel(getWeaponAttackData(selection.weapon, selection.weaponFunctionId))
    );
    if (!this.suppressed) setWeaponNoisePreview(this.token, this.sourceId, this.noiseLevel);
  }

  suppressNoisePreview() {
    this.suppressed = true;
    clearWeaponNoisePreview(this.token?.id ?? this.token?.document?.id ?? "", this.sourceId);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    Hooks.off("updateItem", this.onItemUpdate);
    this.suppressNoisePreview();
    this.container.destroy({ children: true });
    this.entries = [];
  }
}

function resolveTokenObjectFromUuidSync(uuid = "") {
  const normalizedUuid = String(uuid ?? "").trim();
  if (!normalizedUuid || typeof fromUuidSync !== "function") return null;
  const document = fromUuidSync(normalizedUuid);
  return document?.object ?? null;
}

export function startWeaponAttack({
  token = null,
  weapon = null,
  actionKey = "",
  weaponFunctionId = "",
  attackModifier = null,
  originOverride = null,
  onBeforeExecute = null,
  onProcessingStarted = null,
  onDestroy = null,
  chainRef = null,
  damageHubOperationRef = "",
  abilityTrialSession = null,
  skipActionPointCost = false,
  skipBaseWeaponResourceCosts = false,
  ignoreReactionLock = false,
  finishAfterAttack = false,
  suppressGenericEventReactions = false,
  useGmAuthority = false
} = {}) {
  if (!ignoreReactionLock && isReactionSystemLocked()) return undefined;
  if (!token?.actor || !weapon || !isAttackSource(weapon, weaponFunctionId)) return undefined;
  if (
    useGmAuthority
    && !game.user?.isGM
    && game.user?.hasPermission?.("QUERY_USER") === false
  ) {
    ui.notifications.warn(
      "В правах роли отключён «Запрос к пользователям»: атака будет обработана старым локальным путём."
    );
  }
  if (isActorUnableToAct(token.actor)) return undefined;
  if (!getWeaponAttackData(weapon, weaponFunctionId)?.enabled) return undefined;
  if (!hasWeaponAction(weapon, actionKey, weaponFunctionId)) return undefined;
  if (isWeaponActionBlocked(token.actor, actionKey)) return undefined;
  if (isWeaponPlacementDisabled(token.actor, weapon)) return undefined;
  if (activeAttack && !cancelWeaponAttack({ ignoreReactionLock })) return undefined;
  const controller = new WeaponAttackController(token, weapon, actionKey, weaponFunctionId, attackModifier, {
    originOverride,
    onBeforeExecute,
    onProcessingStarted,
    onDestroy,
    chainRef,
    damageHubOperationRef,
    abilityTrialSession,
    skipActionPointCost,
    skipBaseWeaponResourceCosts,
    ignoreReactionLock,
    finishAfterAttack,
    suppressGenericEventReactions,
    useGmAuthority
  });
  if (!controller.hasRequiredWeaponResources(getActionAttackCount(weapon, actionKey, weaponFunctionId))) return undefined;
  activeAttack = controller;
  activeAttack.activate();
  return activeAttack;
}

export const ORDINARY_WEAPON_ATTACK_TESTING = Object.freeze({
  queryName: ORDINARY_ATTACK_TICKET_QUERY,
  queryTimeoutMs: ORDINARY_ATTACK_TICKET_QUERY_TIMEOUT_MS,
  handleTicketQuery: handleOrdinaryWeaponAttackTicketQuery,
  handleSocketRequest: handleOrdinaryWeaponAttackSocketRequest,
  executeSelection: executeOrdinaryWeaponAttackSelection,
  settleResponse: settlePendingOrdinaryAttackRequest,
  serializeSelection: serializeOrdinaryAttackSelection,
  reset() {
    for (const pending of pendingOrdinaryAttackRequests.values()) {
      globalThis.clearTimeout(pending.timeout);
      globalThis.clearTimeout(pending.completionTimeout);
      globalThis.clearTimeout(pending.hardTimeout);
    }
    pendingOrdinaryAttackRequests.clear();
    for (const ticket of ordinaryAttackTickets.keys()) deleteOrdinaryAttackTicket(ticket);
    ordinaryAttackOperationsInFlight.clear();
    ordinaryAttackOperationsCompleted.clear();
    ordinaryAttackActorQueues.clear();
    ordinaryAttackAuthoritySockets.clear();
  }
});

export const ATTACK_TARGETING_TESTING = Object.freeze({
  unaimedAttackDisadvantageCount: UNAIMED_ATTACK_DISADVANTAGE_COUNT,
  getAttackGeometryCandidateBounds,
  getCanvasTokenCandidates,
  getTokenElevationRange,
  getUnseenAttackEdgeModifiers,
  getTrajectoryTargetEntries,
  getTokenShapeOffset,
  isAttackImpactTarget,
  isTokenPlaceableAvailable,
  isAttackTargetVisible,
  selectRandomMeleeDirection,
  getEnabledMeleeDirectionsFromSettings
});

export const WEAPON_CONDITION_WEAR_TESTING = Object.freeze({
  applyImpactConditionWear: applyWeaponImpactConditionWear,
  calculateConditionLoss: calculateWeaponImpactConditionLoss,
  summarizeDamageResults: summarizeWeaponImpactDamageResults
});

export const WEAPON_ATTACK_LIFECYCLE_TESTING = Object.freeze({
  collectResourceSpendTotals: collectWeaponResourceSpendTotals,
  createModifierState: context => new WeaponActionModifierState(context),
  publishResolved: publishWeaponAttackResolved,
  runTerminal: runWeaponAttackTerminalHandlers
});

function suspendWeaponAttackForNestedSelection(controller = activeAttack) {
  if (!controller || controller.destroyed) return null;
  if (!controller.suspendForNestedTargetSelection()) return null;
  if (activeAttack === controller) activeAttack = null;
  return controller;
}

function restoreWeaponAttackAfterNestedSelection(controller = null) {
  if (!controller || controller.destroyed || activeAttack) return false;
  if (getActiveCanvasTargetSelectionSession()) {
    // A newer user interaction owns the canvas. The older attack must not
    // reclaim it after an asynchronous nested attack completes.
    if (!controller.processing) controller.destroy();
    return false;
  }
  activeAttack = controller;
  if (controller.resumeFromNestedTargetSelection()) return true;
  if (activeAttack === controller) activeAttack = null;
  if (!controller.processing && !controller.destroyed) controller.destroy();
  return false;
}

export function startWeaponAttackAndWait(options = {}) {
  const timeoutMs = Math.max(1000, Math.trunc(Number(options?.timeoutMs) || 120000));
  return new Promise(resolve => {
    let completed = false;
    let timeoutId = null;
    const suspendedAttack = options?.suspendActiveAttack
      ? suspendWeaponAttackForNestedSelection()
      : null;
    const restoreSuspendedAttack = () => {
      restoreWeaponAttackAfterNestedSelection(suspendedAttack);
    };
    const finish = value => {
      if (completed) return;
      completed = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      // WeaponAttackController invokes onDestroy before it detaches its canvas
      // handlers. Resume on the next microtask so the old controller never
      // captures the nested controller's context-menu callback.
      Promise.resolve().then(() => {
        restoreSuspendedAttack();
        resolve(Boolean(value));
      });
    };
    const onProcessingStarted = payload => {
      if (timeoutId) window.clearTimeout(timeoutId);
      timeoutId = null;
      options?.onProcessingStarted?.(payload);
    };
    const controller = startWeaponAttack({
      ...options,
      finishAfterAttack: true,
      onProcessingStarted,
      onDestroy: ({ controller: destroyed }) => finish(
        Boolean(destroyed?.lastResolvedAttackOutcome)
          || destroyed?.attackCheckCount > 0
          || Boolean(destroyed?.authorityExecutionSucceeded)
      )
    });
    if (!controller) {
      return finish(false);
    }
    timeoutId = window.setTimeout(() => {
      if (activeAttack === controller) activeAttack = null;
      controller.destroy();
      finish(false);
    }, timeoutMs);
  });
}

/**
 * Execute one top-level ability attack function.
 *
 * Resource rows are quoted before interactive targeting and committed exactly
 * once when the user confirms the attack. The weapon controller then skips the
 * already-paid base vector while still processing critical-failure surcharges.
 */
export async function startAbilityAttackActionAndWait({
  token = null,
  item = null,
  functionId = "",
  chainRef = null,
  onInteractionCancelled = null
} = {}) {
  const sourceToken = token?.object ?? token;
  const abilityFunction = getAbilityAttackFunction(item, functionId);
  const settings = getAbilityAttackSettings(item, functionId);
  if (!sourceToken?.actor || !abilityFunction || !settings) return false;
  if (item?.parent?.uuid !== sourceToken.actor.uuid || isActorUnableToAct(sourceToken.actor)) return false;

  const actionKey = getAbilityAttackActionKey(settings);
  const abilityTrialSession = createAbilityAttackTrialSession({
    abilityFunction,
    settings,
    sourceActor: sourceToken.actor,
    sourceToken
  });
  const costRows = getAbilityAttackResourceCostRows(item, abilityFunction.id);
  const costContext = {
    rootId: `ability-attack:${item.id}:${abilityFunction.id}:${foundry.utils.randomID()}`,
    occurrenceId: `ability-attack:${item.id}:${abilityFunction.id}`,
    chainRef
  };
  let quote;
  try {
    quote = await quoteAbilityFunctionResourceCosts({
      actor: sourceToken.actor,
      sourceItem: item,
      abilityFunction,
      costRows,
      context: costContext
    });
  } catch (error) {
    console.error("Fallout MaW | Ability attack cost preflight failed", error);
    quote = { ok: false, reason: "spendFailed", error };
  }
  if (!quote?.ok) {
    notifyAbilityTriggerCostFailure(quote);
    return false;
  }

  const payCosts = async () => {
    let payment;
    try {
      payment = await payAbilityFunctionResourceCosts({
        actor: sourceToken.actor,
        sourceItem: item,
        abilityFunction,
        costRows,
        expectedFingerprint: quote.fingerprint,
        context: costContext
      });
    } catch (error) {
      console.error("Fallout MaW | Ability attack resource payment failed", error);
      payment = { ok: false, reason: "spendFailed", error };
    }
    if (payment?.ok) {
      const spentActionPoints = getPaidActorResourceAmount(payment, "actionPoints");
      if (spentActionPoints > 0) {
        await applyAttackActionPointMovementLoss(sourceToken.actor, spentActionPoints, {
          actorToken: sourceToken,
          weapon: item,
          actionKey,
          weaponActionKey: actionKey,
          weaponFunctionId: abilityFunction.id,
          attackId: costContext.rootId,
          chanceOperationId: costContext.rootId,
          chainRef,
          requester: "weaponAttack",
          source: "abilityAttackCost"
        });
      }
      return true;
    }
    notifyAbilityTriggerCostFailure(payment);
    return false;
  };

  const label = String(settings.name ?? "").trim() || String(item.name ?? "Атакующее действие");
  if (settings.targeting.mode === "selectedTargets") {
    return executeAbilityAttackTargetSequence({
      token: sourceToken,
      item,
      abilityFunction,
      settings,
      actionKey,
      label,
      chainRef,
      abilityTrialSession,
      payCosts,
      onInteractionCancelled
    });
  }

  const attackModifier = settings.targeting.mode === "cone"
    ? await requestAbilityAttackDirectionModifier(settings, label)
    : null;
  if (attackModifier === false) {
    onInteractionCancelled?.();
    return false;
  }
  return startWeaponAttackAndWait({
    token: sourceToken,
    weapon: item,
    actionKey,
    weaponFunctionId: abilityFunction.id,
    attackModifier,
    chainRef,
    abilityTrialSession,
    skipActionPointCost: true,
    skipBaseWeaponResourceCosts: true,
    onBeforeExecute: payCosts
  });
}

async function executeAbilityAttackTargetSequence({
  token = null,
  item = null,
  abilityFunction = null,
  settings = {},
  actionKey = "",
  label = "Атакующее действие",
  chainRef = null,
  abilityTrialSession = null,
  payCosts = null,
  onInteractionCancelled = null
} = {}) {
  const limit = Math.max(1, Math.floor(evaluateAbilityAttackFormula(
    settings.targeting?.targetLimitFormula ?? settings.sequence?.count,
    token?.actor,
    {
      fallback: Math.max(1, toInteger(settings.sequence?.count) || 1),
      minimum: 1,
      context: "ability attack target limit"
    }
  )));
  const difficultyStep = Math.max(0, toInteger(settings.sequence?.difficultyPerAttack));
  const allowRepeatedTargets = settings.targeting?.allowRepeatedTargets !== false;
  const maxRangeMeters = Math.max(0, evaluateAbilityAttackFormula(
    settings.maxRangeMeters,
    token?.actor,
    {
      fallback: 0,
      minimum: 0,
      context: "ability attack selected-target range"
    }
  ));
  const aimedTargeting = settings.targeting?.aimed === true && !MELEE_ACTION_KEYS.has(actionKey);
  const selectionOperationId = foundry.utils.randomID();
  const selectionAttackModifier = aimedTargeting
    ? createAttackActionTargetedModifier({ aimed: true, label })
    : null;
  const collectTargetRows = () => collectAbilityAttackTargetSelectionRows({
    token,
    item,
    abilityFunction,
    actionKey,
    maxRangeMeters,
    aimed: aimedTargeting,
    attackModifier: selectionAttackModifier,
    selectionOperationId
  });
  const selectionRangeHint = aimedTargeting
    ? `внутри эффективной дистанции и в пределах ${formatAbilityAttackRange(maxRangeMeters)}`
    : `в пределах ${formatAbilityAttackRange(maxRangeMeters)}`;
  const selectedRows = await requestCustomTokenSelection({
    rows: collectTargetRows(),
    limit,
    allowRepeated: allowRepeatedTargets,
    title: label,
    noneWarning: `${label}: нет доступных целей ${selectionRangeHint}.`,
    instructions: `${label}: выберите до ${limit} целей ${selectionRangeHint}. Enter подтверждает неполный выбор, ПКМ снимает последнюю цель, Esc отменяет.`,
    sourceToken: token,
    refreshRows: collectTargetRows,
    getRowId: row => String(row?.token?.document?.uuid ?? row?.token?.uuid ?? row?.token?.id ?? ""),
    getRowLabel: row => String(row?.token?.name ?? row?.token?.actor?.name ?? "Цель")
  });
  if (!selectedRows.length) {
    onInteractionCancelled?.();
    return false;
  }

  const selections = [];
  for (const [index, row] of selectedRows.entries()) {
    const selectedLimbKey = settings.targeting?.aimed
      ? await requestAbilityAttackSelectedLimb(row.token, {
        label,
        index,
        count: selectedRows.length
      })
      : "";
    if (settings.targeting?.aimed && !selectedLimbKey) {
      onInteractionCancelled?.();
      return false;
    }
    selections.push({
      token: row.token,
      targetUuid: String(row.token?.document?.uuid ?? row.token?.uuid ?? ""),
      chanceOperationId: String(row.chanceOperationId ?? ""),
      selectedLimbKey,
      attackModifier: createAttackActionTargetedModifier({
        aimed: settings.targeting?.aimed,
        label,
        difficultyBonus: difficultyStep * index
      })
    });
  }

  if (!selections.length) {
    onInteractionCancelled?.();
    return false;
  }
  const refreshedRows = new Map(collectTargetRows().map(row => [getAbilityAttackTargetRowId(row), row]));
  const invalidSelection = selections.find(selection => {
    const row = refreshedRows.get(String(selection.targetUuid ?? ""));
    if (!row?.selectable) return true;
    return aimedTargeting && !resolveAimedTargetSelection(selection.token?.actor, selection.selectedLimbKey);
  });
  if (invalidSelection) {
    const row = refreshedRows.get(String(invalidSelection.targetUuid ?? ""));
    const targetName = invalidSelection.token?.name ?? invalidSelection.token?.actor?.name ?? "Цель";
    ui.notifications.warn(`${label}: ${targetName} — ${row?.reason || game.i18n.localize("FALLOUTMAW.Messages.AimedTargetChanged")}`);
    onInteractionCancelled?.();
    return false;
  }
  if (typeof payCosts !== "function" || !(await payCosts())) return false;
  prepareAbilityAttackTrialSessionTargets(abilityTrialSession, selections);

  const results = [];
  for (const [selectionIndex, selection] of selections.entries()) {
    results.push(await executeWeaponAttackAgainstToken({
      attackerToken: token,
      targetToken: selection.token,
      weapon: item,
      actionKey,
      weaponFunctionId: abilityFunction.id,
      attackModifier: selection.attackModifier,
      selectedLimbKey: selection.selectedLimbKey,
      strictTargetResolution: true,
      skipActionPointCost: true,
      skipBaseWeaponResourceCosts: true,
      abilityTrialSession: prepareAbilityAttackTrialSessionLane(
        abilityTrialSession,
        selection,
        selectionIndex
      ),
      chanceOperationId: selection.chanceOperationId,
      chainRef
    }));
  }
  return results.some(Boolean);
}

function collectAbilityAttackTargetSelectionRows({
  token = null,
  item = null,
  abilityFunction = null,
  actionKey = "",
  maxRangeMeters = 0,
  aimed = false,
  attackModifier = null,
  selectionOperationId = ""
} = {}) {
  const candidates = (canvas.tokens?.placeables ?? [])
    .filter(target => (
      target?.actor
      && target.visible !== false
      && target.renderable !== false
      && !isSameAttackToken(token, target)
    ));
  const reachable = aimed
    ? null
    : new Set(collectValidWeaponAttackTargets({
      attackerToken: token,
      weapon: item,
      actionKey,
      weaponFunctionId: abilityFunction?.id
    }));
  const weaponData = aimed ? getWeaponAttackData(item, abilityFunction?.id) : null;
  const rangeContext = aimed
    ? {
      aimed: true,
      targeting: { aimed: true },
      attackModifier,
      weaponData,
      contextualAbilitySnapshots: new Map()
    }
    : null;
  return candidates.map(target => {
    const targetId = getAbilityAttackTargetRowId(target);
    const chanceOperationId = aimed
      ? `${selectionOperationId}:${targetId}`
      : "";
    const distanceMeters = getTokenDistanceMeters(token, target);
    const inRange = distanceMeters <= maxRangeMeters + 1e-6;
    const aimedRangeState = aimed
      ? getAimedTargetRangeSelectionState({
        weapon: item,
        actionKey,
        attackerToken: token,
        targetToken: target,
        weaponFunctionId: abilityFunction?.id,
        context: {
          ...rangeContext,
          weaponAttackId: chanceOperationId,
          chanceOperationId
        }
      })
      : null;
    const targetReachable = aimed
      ? isAimedAttackGeometryTargetReachable({
        attackerToken: token,
        targetToken: target,
        weapon: item,
        actionKey,
        weaponFunctionId: abilityFunction?.id,
        rangeProfile: aimedRangeState?.rangeProfile
      })
      : reachable.has(target);
    const insideAimedRange = aimedRangeState?.allowed !== false;
    const selectable = inRange && targetReachable && insideAimedRange;
    return {
      token: target,
      actorUuid: String(target.actor?.uuid ?? ""),
      chanceOperationId,
      selectable,
      reason: selectable
        ? ""
        : (!inRange
          ? `вне дистанции ${formatAbilityAttackRange(maxRangeMeters)}`
          : (!insideAimedRange
            ? formatAimedRangeBlockReason(aimedRangeState)
            : "цель недоступна для атаки"))
    };
  });
}

function getAbilityAttackTargetRowId(row = null) {
  const token = row?.token ?? row;
  return String(token?.document?.uuid ?? token?.uuid ?? token?.id ?? "");
}

async function requestAbilityAttackSelectedLimb(targetToken = null, {
  label = "Атакующее действие",
  index = 0,
  count = 1
} = {}) {
  const limbs = Object.entries(targetToken?.actor?.system?.limbs ?? {})
    .filter(([key, limb]) => key && limb && typeof limb === "object" && !isLimbDestroyed(targetToken.actor, key))
    .map(([key, limb]) => ({
      key,
      label: String(limb.label ?? key)
    }));
  if (!limbs.length) {
    ui.notifications.warn(`${label}: у цели ${targetToken?.name ?? targetToken?.actor?.name ?? ""} нет доступных частей тела.`);
    return "";
  }
  const result = await DialogV2.input({
    window: { title: `${label}: цель ${index + 1} / ${count}` },
    content: `
      <label class="form-group">
        <span>Часть тела цели ${escapeAttackDialogText(targetToken?.name ?? targetToken?.actor?.name ?? "")}</span>
        <select name="limbKey">
          ${limbs.map(limb => `<option value="${escapeAttackDialogText(limb.key)}">${escapeAttackDialogText(limb.label)}</option>`).join("")}
        </select>
      </label>
    `,
    ok: {
      label: "Выбрать",
      icon: "fa-solid fa-crosshairs",
      callback: (_event, button) => String(button.form?.elements?.limbKey?.value ?? "")
    },
    buttons: [{
      action: "cancel",
      label: game.i18n.localize("FALLOUTMAW.Common.Cancel")
    }],
    rejectClose: false,
    modal: true,
    position: { width: 420 }
  });
  const limbKey = String(result ?? "");
  return limbs.some(limb => limb.key === limbKey) ? limbKey : "";
}

function formatAbilityAttackRange(value = 0) {
  const number = Math.max(0, Number(value) || 0);
  return `${Number.isInteger(number) ? number : number.toFixed(2)} м`;
}

function formatAimedRangeBlockReason(state = {}) {
  const unit = game.i18n.localize("FALLOUTMAW.Common.MeterShort");
  const distance = formatAimedRangeMeters(state.attackDistanceMeters);
  if (state.side === "near") {
    return game.i18n.format("FALLOUTMAW.Messages.AimedRangeTooNear", {
      distance,
      limit: formatAimedRangeMeters(state.effectiveRange?.min),
      unit
    });
  }
  if (state.side === "far") {
    return game.i18n.format("FALLOUTMAW.Messages.AimedRangeTooFar", {
      distance,
      limit: formatAimedRangeMeters(state.effectiveRange?.max),
      unit
    });
  }
  return game.i18n.localize("FALLOUTMAW.Messages.AimedRangeUnavailable");
}

function formatAimedRangeMeters(value = 0) {
  const number = Math.max(0, Number(value) || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

async function requestAbilityAttackDirectionModifier(settings = {}, label = "Атакующее действие") {
  const directions = [
    { key: "thrust", label: "Колющий", data: settings.targeting?.directions?.thrust },
    { key: "swing", label: "Рубящий", data: settings.targeting?.directions?.swing }
  ].filter(entry => entry.data?.enabled);
  if (!directions.length) return null;
  let selected = directions[0];
  if (directions.length > 1) {
    const choice = await DialogV2.wait({
      window: { title: label },
      content: "<p>Выберите вариант атаки.</p>",
      buttons: directions.map((entry, index) => ({
        action: entry.key,
        label: entry.label,
        default: index === 0
      })),
      rejectClose: false,
      modal: true,
      position: { width: 360 }
    });
    if (!choice) return false;
    selected = directions.find(entry => entry.key === choice);
    if (!selected) return false;
  }
  return createAttackActionDirectionModifier({
    label: `${label}: ${selected.label}`,
    accuracyModifier: selected.data.accuracyModifier,
    criticalChanceModifier: selected.data.criticalChanceModifier,
    damagePercentModifier: selected.data.damagePercentModifier
  });
}

function getAbilityAttackResourceCostRows(item = null, functionId = "") {
  return (getWeaponAttackData(item, functionId)?.resourceCosts ?? [])
    .filter(cost => String(cost?.type ?? "") === "actorResource")
    .map((cost, index) => ({
      id: String(cost?.id ?? "").trim() || `attack-cost-${index + 1}`,
      resourceKey: String(cost?.resourceKey ?? "").trim(),
      formula: String(cost?.formula ?? "0").trim() || "0",
      overloadAmount: Math.max(0, toInteger(cost?.overloadAmount)),
      overloadDurationSeconds: Math.max(0, toInteger(cost?.overloadDurationSeconds))
    }));
}

function createAbilityAttackTrialSession({
  abilityFunction = null,
  settings = {},
  sourceActor = null,
  sourceToken = null
} = {}) {
  return {
    abilityFunction,
    settings,
    sourceActor,
    sourceToken,
    operationId: `ability-attack-trials:${String(abilityFunction?.id ?? "")}:${foundry.utils.randomID()}`,
    state: createAttackTrialResolutionState(),
    appliedOutcomeKeys: new Set(),
    notifiedOutcomeKeys: new Set(),
    targetUuids: [],
    targetLaneKeys: new Map()
  };
}

function getSharedAbilityAttackTrialSession(session = null) {
  return session?.shared ?? session ?? null;
}

function prepareAbilityAttackTrialSessionTargets(session = null, selections = []) {
  const shared = getSharedAbilityAttackTrialSession(session);
  if (!shared) return null;
  shared.targetUuids = (selections ?? [])
    .map(selection => String(selection?.targetUuid ?? "").trim())
    .filter(Boolean);
  return shared;
}

function prepareAbilityAttackTrialSessionLane(session = null, selection = {}, index = 0) {
  const shared = getSharedAbilityAttackTrialSession(session);
  if (!shared) return null;
  const targetUuid = String(selection?.targetUuid ?? "").trim();
  return {
    shared,
    laneKey: `selection:${Math.max(0, toInteger(index))}:${targetUuid}`,
    targetUuid
  };
}

function escapeAttackDialogText(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function startDualWeaponAttack({
  token = null,
  attacks = [],
  label = "С двух рук",
  canSpendEnergy = null,
  spendEnergy = null
} = {}) {
  if (isReactionSystemLocked()) return undefined;
  const actor = token?.actor ?? null;
  const entries = (Array.isArray(attacks) ? attacks : []).slice(0, 2)
    .map(entry => ({
      weapon: entry?.weapon ?? null,
      actionKey: String(entry?.actionKey ?? ""),
      weaponFunctionId: String(entry?.weaponFunctionId || ITEM_FUNCTIONS.weapon)
    }));
  if (!actor || entries.length !== 2 || isActorUnableToAct(actor)) return undefined;
  if (new Set(entries.map(entry => entry.weapon?.id ?? "")).size !== 2) return undefined;

  for (const entry of entries) {
    if (!entry.weapon || !isAttackSource(entry.weapon, entry.weaponFunctionId)) return undefined;
    if (!getWeaponAttackData(entry.weapon, entry.weaponFunctionId)?.enabled) return undefined;
    if (!hasWeaponAction(entry.weapon, entry.actionKey, entry.weaponFunctionId)) return undefined;
    if (isWeaponActionBlocked(actor, entry.actionKey)) return undefined;
    if (isWeaponPlacementDisabled(actor, entry.weapon)) return undefined;
  }

  activeDualWeaponAttack?.destroy();
  activeDualWeaponAttack = null;
  const captured = [];
  const reactionCoordinator = createWeaponReactionCoordinator();
  const runCaptured = async () => {
    try {
      if (!validateDualWeaponAttackResources(actor, captured, label)) return false;
      if (typeof canSpendEnergy === "function" && canSpendEnergy() === false) return false;
      const sharedActionUseId = foundry.utils.randomID();
      const actionCosts = captured.map(entry => ({
        entry,
        value: getWeaponActionPointCost(actor, entry.weapon, entry.actionKey, entry.weaponFunctionId, {
          actorToken: token,
          chanceOperationId: sharedActionUseId
        })
      }));
      const actionPointCost = Math.max(0, ...actionCosts.map(entry => entry.value));
      if (isCombatActionPointSpendingActive(actor) && actionPointCost > 0 && !canSpendCombatActionPoints(actor, actionPointCost, { label: "действия" })) return false;
      if (typeof spendEnergy === "function" && (await spendEnergy()) === false) return false;
      const actionPointCostApplied = isCombatActionPointSpendingActive(actor);
      const sharedActionEntries = actionCosts.filter(entry => entry.value === actionPointCost);
      const primarySharedAction = sharedActionEntries[0]?.entry ?? captured[0];
      if (actionPointCostApplied) {
        for (const { entry } of sharedActionEntries) {
          Hooks.callAll("fallout-maw.weaponActionWillResolve", {
            actor,
            actorToken: token,
            token,
            weapon: entry.weapon,
            actionKey: entry.actionKey,
            weaponActionKey: entry.actionKey,
            weaponFunctionId: entry.weaponFunctionId,
            weaponData: getWeaponAttackData(entry.weapon, entry.weaponFunctionId),
            attackId: sharedActionUseId,
            chanceOperationId: sharedActionUseId,
            actionPointCostApplied: true
          });
        }
      }
      if (isCombatActionPointSpendingActive(actor) && actionPointCost > 0) {
        const transaction = await spendCombatActionPointsWithReceipt(actor, actionPointCost, {
          source: "weaponAction",
          actionKey: primarySharedAction?.actionKey ?? "",
          attackId: sharedActionUseId
        });
        if (transaction.spent !== actionPointCost || !transaction.receipt) return false;
        if (transaction.receipt.resourceKey === "actionPoints") {
          await applyAttackActionPointMovementLoss(actor, transaction.receipt.amount, {
            actorToken: token,
            weapon: primarySharedAction?.weapon ?? null,
            actionKey: primarySharedAction?.actionKey ?? "",
            weaponActionKey: primarySharedAction?.actionKey ?? "",
            weaponFunctionId: primarySharedAction?.weaponFunctionId ?? "",
            attackId: sharedActionUseId,
            chanceOperationId: sharedActionUseId,
            requester: "weaponAttack",
            source: "dualWeaponAttack"
          });
        }
      }
      activeDualWeaponAttack?.suppressNoisePreview();
      const results = await Promise.allSettled(captured.map(selection => executeCapturedWeaponAttack(selection, {
        skipActionPointCost: true,
        reactionCoordinator,
        deferWeaponNoiseDetection: true,
        returnWeaponNoiseMetadata: true
      })));
      for (const result of results) {
        if (result.status === "rejected") console.error("Fallout MaW | Dual weapon attack execution failed", result.reason);
      }
      await reactionCoordinator.drain();
      const attemptedNoiseLevels = results
        .filter(result => result.status === "fulfilled" && result.value?.weaponNoiseAttempted)
        .map(result => getWeaponNoiseLevel({ noiseLevel: result.value.noiseLevel }));
      if (actionPointCostApplied) {
        const primary = primarySharedAction;
        await publishWeaponAttackResolved({
          attackerUuid: actor.uuid,
          actorUuid: actor.uuid,
          tokenUuid: token?.document?.uuid ?? token?.uuid ?? "",
          weaponUuid: primary?.weapon?.uuid ?? "",
          actionKey: primary?.actionKey ?? "",
          weaponFunctionId: primary?.weaponFunctionId ?? "",
          attackId: sharedActionUseId,
          actionPointCost,
          actionPointCostApplied: true,
          targetActorUuids: [],
          targetTokenUuids: [],
          killedTargetUuids: [],
          canceledByReaction: false,
          attackCheckCount: 0,
          damageResults: [],
          senderUserId: game.user?.id ?? ""
        });
      }
      if (attemptedNoiseLevels.length) {
        await resolveWeaponNoiseDetection(token, {
          noiseLevel: Math.max(...attemptedNoiseLevels)
        });
      }
      return true;
    } finally {
      activeDualWeaponAttack?.destroy();
      activeDualWeaponAttack = null;
    }
  };

  const startCapture = index => {
    const entry = entries[index];
    const controller = new WeaponAttackController(token, entry.weapon, entry.actionKey, entry.weaponFunctionId, null, {
      skipActionPointCost: true,
      captureOnly: true,
      onCapture: async selection => {
        captured.push(selection);
        activeDualWeaponAttack?.add(selection);
        if (captured.length < entries.length) {
          if (!startCapture(captured.length)) {
            activeDualWeaponAttack?.destroy();
            activeDualWeaponAttack = null;
          }
          return;
        }
        activeAttack = null;
        await runCaptured();
      }
    });
    if (!controller.hasRequiredWeaponResources(getActionAttackCount(entry.weapon, entry.actionKey, entry.weaponFunctionId))) return undefined;
    if (activeAttack && !cancelWeaponAttack()) return undefined;
    if (index === 0 && !activeDualWeaponAttack) {
      activeDualWeaponAttack = new DualWeaponAttackPreview(token, entries);
    }
    activeAttack = controller;
    ui.notifications.info(`${label}: выберите траекторию ${index + 1} / ${entries.length}.`);
    controller.activate();
    return controller;
  };

  return startCapture(0);
}

export function startCommandedWeaponAttacks({
  attacks = [],
  label = "Команда",
  onCancel = null,
  onBeforeExecute = null,
  onComplete = null,
  chainRef = null,
  authorityContext = null
} = {}) {
  if (isReactionSystemLocked()) return undefined;
  const entries = (Array.isArray(attacks) ? attacks : [])
    .map(entry => ({
      token: entry?.token?.object ?? entry?.token ?? null,
      weapon: entry?.weapon ?? null,
      actionKey: String(entry?.actionKey ?? ""),
      weaponFunctionId: String(entry?.weaponFunctionId || ITEM_FUNCTIONS.weapon),
      actionPointCost: Math.max(0, toInteger(entry?.actionPointCost))
    }))
    .filter(entry => entry.token?.actor && entry.weapon && entry.actionKey);
  if (!entries.length) return undefined;

  for (const entry of entries) {
    if (!entry.weapon || !isAttackSource(entry.weapon, entry.weaponFunctionId)) return undefined;
    if (isActorUnableToAct(entry.token.actor)) return undefined;
    if (!getWeaponAttackData(entry.weapon, entry.weaponFunctionId)?.enabled) return undefined;
    if (!hasWeaponAction(entry.weapon, entry.actionKey, entry.weaponFunctionId)) return undefined;
    if (isWeaponActionBlocked(entry.token.actor, entry.actionKey)) return undefined;
    if (isWeaponPlacementDisabled(entry.token.actor, entry.weapon)) return undefined;
    const attackCount = getActionAttackCount(entry.weapon, entry.actionKey, entry.weaponFunctionId);
    if (!hasRequiredWeaponResources(entry.weapon, attackCount, entry.weaponFunctionId)) return undefined;
  }

  if (activeAttack && !cancelWeaponAttack()) return undefined;
  if (activeCommandedAttack?.processing) return undefined;
  activeCommandedAttack?.cancel();
  activeCommandedAttack = new CommandedWeaponAttackController(entries, {
    label,
    onCancel,
    onBeforeExecute,
    onComplete,
    chainRef,
    authorityContext
  });
  activeCommandedAttack.activate();
  return activeCommandedAttack;
}

export async function startCommandedWeaponAttacksAndWait({
  attacks = [],
  label = "Команда",
  onCancel = null,
  onBeforeExecute = null,
  chainRef = null,
  authorityContext = null
} = {}) {
  if (!authorityContext || String(authorityContext?.kind ?? "") !== "abilityAction") {
    return createCommandedAttackResult({ reason: "missingAuthorityContext" });
  }
  const entries = normalizeCommandedWeaponAttackEntries(attacks);
  if (!entries.length || !validateCommandedWeaponAttackEntries(entries)) {
    return createCommandedAttackResult({ reason: "invalidAttacks" });
  }
  const sceneAuthority = await getCommandedAttackSceneGM({ entries, authorityContext });
  if (!sceneAuthority) {
    ui.notifications.warn(`${label}: нет активного GM на сцене и уровне исполнителей.`);
    return createCommandedAttackResult({ reason: getCommandedAttackAuthorityFailureReason() });
  }

  if (entries.every(canUseCommandedMultiRayCapture)) {
    return startCommandedMultiRayAttacksAndWait(entries, {
      label,
      onCancel,
      onBeforeExecute,
      chainRef,
      authorityContext
    });
  }

  return captureCommandedWeaponAttacksSequentially(entries, {
    label,
    onCancel,
    onBeforeExecute,
    chainRef,
    authorityContext
  });
}

function canUseCommandedMultiRayCapture(entry = {}) {
  const actionKey = String(entry?.actionKey ?? "");
  if (MELEE_ACTION_KEYS.has(actionKey)) return actionKey === "meleeAttack";
  return actionKey !== "aimedShot" && actionKey !== PUSH_ACTION_KEY;
}

function startCommandedMultiRayAttacksAndWait(entries = [], {
  label = "Команда",
  onCancel = null,
  onBeforeExecute = null,
  chainRef = null,
  authorityContext = null
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    let failureResult = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(createCommandedAttackResult(result ?? {}));
    };
    const controller = startCommandedWeaponAttacks({
      attacks: entries,
      label,
      chainRef,
      authorityContext,
      onCancel: () => {
        onCancel?.();
        finish({ started: true, cancelled: true, reason: "captureCancelled" });
      },
      onBeforeExecute: async selections => {
        const preflight = await preflightCommandedWeaponAttackSelections(selections, {
          chainRef,
          authorityContext
        });
        if (!preflight.ok) {
          if (preflight.reason) ui.notifications.warn(`${label}: атаки больше недоступны (${preflight.reason}).`);
          failureResult = {
            started: true,
            attemptedCount: selections.length,
            reason: preflight.reason || "preflightFailed"
          };
          return false;
        }
        if (typeof onBeforeExecute === "function" && (await onBeforeExecute()) === false) {
          failureResult = {
            started: true,
            attemptedCount: selections.length,
            reason: "commitFailed"
          };
          return false;
        }
        return true;
      },
      onComplete: result => {
        if (failureResult) return finish(failureResult);
        finish({
          ...(result ?? {}),
          started: true,
          committed: true,
          attemptedCount: Math.max(entries.length, toInteger(result?.attemptedCount))
        });
      }
    });
    if (!controller) finish({ reason: "invalidAttacks" });
  });
}

async function captureCommandedWeaponAttacksSequentially(entries = [], {
  label = "Команда",
  onCancel = null,
  onBeforeExecute = null,
  chainRef = null,
  authorityContext = null
} = {}) {

  const selections = [];
  for (let index = 0; index < entries.length; index += 1) {
    const capture = await captureCommandedWeaponAttackSelection(entries[index], {
      label,
      index,
      count: entries.length
    });
    const selection = capture?.selection ?? null;
    if (!selection) {
      if (capture?.cancelled) onCancel?.();
      return createCommandedAttackResult({
        started: true,
        cancelled: Boolean(capture?.cancelled),
        reason: capture?.cancelled ? "captureCancelled" : "captureFailed"
      });
    }
    selections.push(serializeCommandedAttackSelection({
      ...selection,
      actionPointCost: entries[index].actionPointCost
    }));
  }

  const preflight = await preflightCommandedWeaponAttackSelections(selections, {
    chainRef,
    authorityContext
  });
  if (!preflight.ok) {
    if (preflight.reason) ui.notifications.warn(`${label}: атаки больше недоступны (${preflight.reason}).`);
    return createCommandedAttackResult({
      started: true,
      attemptedCount: selections.length,
      reason: preflight.reason || "preflightFailed"
    });
  }
  if (typeof onBeforeExecute === "function" && (await onBeforeExecute()) === false) {
    return createCommandedAttackResult({
      started: true,
      attemptedCount: selections.length,
      reason: "commitFailed"
    });
  }
  const result = await executeCommandedWeaponAttackSelections(selections, {
    chainRef,
    authorityContext
  });
  return createCommandedAttackResult({
    ...result,
    started: true,
    committed: true,
    attemptedCount: Math.max(selections.length, toInteger(result?.attemptedCount))
  });
}

function normalizeCommandedWeaponAttackEntries(attacks = []) {
  return (Array.isArray(attacks) ? attacks : [])
    .map(entry => ({
      token: entry?.token?.object ?? entry?.token ?? null,
      weapon: entry?.weapon ?? null,
      actionKey: String(entry?.actionKey ?? ""),
      weaponFunctionId: String(entry?.weaponFunctionId || ITEM_FUNCTIONS.weapon),
      actionPointCost: Math.max(0, toInteger(entry?.actionPointCost))
    }))
    .filter(entry => entry.token?.actor && entry.weapon && entry.actionKey);
}

function validateCommandedWeaponAttackEntries(entries = []) {
  for (const entry of entries) {
    if (!entry.weapon || !isAttackSource(entry.weapon, entry.weaponFunctionId)) return false;
    if (isActorUnableToAct(entry.token.actor)) return false;
    if (!getWeaponAttackData(entry.weapon, entry.weaponFunctionId)?.enabled) return false;
    if (!hasWeaponAction(entry.weapon, entry.actionKey, entry.weaponFunctionId)) return false;
    if (getWeaponActionBlockState(entry.token.actor, entry.actionKey).blocked) return false;
    if (isWeaponPlacementDisabled(entry.token.actor, entry.weapon)) return false;
    const attackCount = getActionAttackCount(entry.weapon, entry.actionKey, entry.weaponFunctionId);
    if (!hasRequiredWeaponResources(entry.weapon, attackCount, entry.weaponFunctionId)) return false;
  }
  return true;
}

function captureCommandedWeaponAttackSelection(entry = {}, {
  label = "Команда",
  index = 0,
  count = 1,
  attackModifier = null,
  skipBaseWeaponResourceCosts = false,
  treatDestroyAsCancelled = false
} = {}) {
  if (activeAttack && !cancelWeaponAttack()) {
    return Promise.resolve({ selection: null, cancelled: false });
  }
  return new Promise(resolve => {
    let settled = false;
    let captured = false;
    const finish = ({ selection = null, cancelled = false } = {}) => {
      if (settled) return;
      settled = true;
      resolve({ selection, cancelled: Boolean(cancelled) });
    };
    const controller = new WeaponAttackController(
      entry.token,
      entry.weapon,
      entry.actionKey,
      entry.weaponFunctionId,
      attackModifier,
      {
        skipActionPointCost: true,
        skipBaseWeaponResourceCosts,
        captureOnly: true,
        ignoreReactionLock: true,
        onCapture: selection => {
          captured = true;
          finish({ selection });
        },
        onDestroy: ({ controller: destroyed }) => queueMicrotask(() => {
          if (!captured) finish({
            cancelled: Boolean(treatDestroyAsCancelled || destroyed?.targetSelectionOutcome?.cancelled)
          });
        })
      }
    );
    const attackCount = getActionAttackCount(entry.weapon, entry.actionKey, entry.weaponFunctionId);
    if (!controller.hasRequiredWeaponResources(attackCount)) {
      controller.destroy();
      finish();
      return;
    }
    activeAttack = controller;
    controller.activate();
    ui.notifications.info(`${label}: наведение ${index + 1} / ${count} — ${entry.token?.name ?? entry.token?.actor?.name ?? "исполнитель"}.`);
  });
}

function createCommandedAttackResult({
  started = false,
  committed = false,
  cancelled = false,
  attemptedCount = 0,
  executedCount = 0,
  outcomes = [],
  reason = ""
} = {}) {
  return {
    started: Boolean(started),
    committed: Boolean(committed),
    cancelled: Boolean(cancelled),
    attemptedCount: Math.max(0, toInteger(attemptedCount)),
    executedCount: Math.max(0, toInteger(executedCount)),
    outcomes: Array.isArray(outcomes) ? outcomes : [],
    reason: String(reason ?? "")
  };
}

class CommandedWeaponAttackController {
  constructor(entries = [], {
    label = "Команда",
    onCancel = null,
    onBeforeExecute = null,
    onComplete = null,
    chainRef = null,
    authorityContext = null
  } = {}) {
    this.id = foundry.utils.randomID();
    this.label = String(label ?? "") || "Команда";
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    this.entries = entries.map((entry, index) => this.createEntry(entry, index));
    this.pointer = null;
    this.lastPreviewBroadcastAt = 0;
    this.processing = false;
    this.destroyed = false;
    this.previewFrameScheduler = createLatestFrameScheduler(() => {
      if (!this.processing && !this.destroyed) this.refresh();
    });
    this.onCancelled = typeof onCancel === "function" ? onCancel : null;
    this.onBeforeExecute = typeof onBeforeExecute === "function" ? onBeforeExecute : null;
    this.onComplete = typeof onComplete === "function" ? onComplete : null;
    this.chainRef = chainRef ?? null;
    this.authorityContext = authorityContext ?? null;
    this.targetSelectionSession = null;
    this.targetSelectionOutcome = null;
    this.rightClickCancelCandidate = null;
    this.previousViewContextMenu = null;
    this.events = {
      move: event => this.onMove(event),
      pointerDown: event => this.onPointerDown(event),
      cancel: event => this.onCancel(event),
      keyDown: event => this.onKeyDown(event),
      tick: () => this.onTick(),
      itemUpdate: (item, changes, options) => this.onItemUpdate(item, changes, options)
    };
  }

  createEntry(entry = {}, index = 0) {
    const shape = new PIXI.Graphics();
    const targetMarkers = new PIXI.Graphics();
    const focusedTargetMarker = new PIXI.Graphics();
    this.container.addChild(shape, targetMarkers, focusedTargetMarker);
    return {
      ...entry,
      rangeProfile: getWeaponRangeProfile(
        entry.weapon,
        entry.actionKey,
        entry.token,
        entry.weaponFunctionId,
        { chanceOperationId: `${this.id}:${index}` }
      ),
      index,
      previewId: `${this.id}:${index}`,
      noisePreviewSourceId: `commanded-weapon-attack:${this.id}:${index}`,
      noiseLevel: getWeaponNoiseLevel(getWeaponAttackData(entry.weapon, entry.weaponFunctionId)),
      previewBroadcasted: false,
      lastBroadcastPreviewState: null,
      lastTargetMarkerRenderState: null,
      pointer: null,
      geometry: null,
      lockedGeometry: null,
      targetUuid: "",
      selectedLimbKey: "",
      directionKey: "",
      mode: "current",
      locked: false,
      targetTokenUuidAllowlist: getAuthoritativeAttackPerceptionUuids(entry.token),
      targets: [],
      hoveredTarget: null,
      trajectoryAimTarget: null,
      burstRanges: new Map(),
      shape,
      targetMarkers,
      focusedTargetMarker
    };
  }

  activate() {
    getCombatVisualizationLayer().addChild(this.container);
    for (const entry of this.entries) {
      setWeaponNoisePreview(entry.token, entry.noisePreviewSourceId, entry.noiseLevel);
    }
    const session = startCanvasTargetSelectionSession({
      kind: "commandedWeaponAttacks",
      controller: this
    }, {
      onCancel: outcome => this.cancelFromTargetSelectionLifecycle(outcome)
    });
    this.targetSelectionSession = session;
    if (session.finished || this.destroyed) {
      this.targetSelectionSession = null;
      return;
    }
    liveWeaponAttackTargetControllers.add(this);
    canvas.stage.on("mousemove", this.events.move);
    document.addEventListener("pointerdown", this.events.pointerDown, { capture: true });
    document.addEventListener("keydown", this.events.keyDown, { capture: true });
    canvas.app?.ticker?.add?.(this.events.tick);
    Hooks.on("updateItem", this.events.itemUpdate);
    const canvasView = canvas.app?.view ?? null;
    this.previousViewContextMenu = canvasView?.oncontextmenu ?? null;
    if (canvasView) canvasView.oncontextmenu = this.events.cancel;
    ui.notifications.info(`${this.label}: ЛКМ фиксирует лучи; после последнего атака начнётся автоматически. ПКМ размораживает последний, Esc отменяет.`);
  }

  cancelFromTargetSelectionLifecycle(outcome = {}) {
    this.targetSelectionSession = null;
    this.targetSelectionOutcome = {
      ...outcome,
      cancelled: true
    };
    if (activeCommandedAttack === this) activeCommandedAttack = null;
    if (this.destroyed) return;
    this.destroy();
    this.onCancelled?.();
  }

  destroy() {
    if (this.destroyed) return;
    this.finishTargetSelection();
    liveWeaponAttackTargetControllers.delete(this);
    this.destroyed = true;
    this.previewFrameScheduler.destroy();
    canvas.stage.off("mousemove", this.events.move);
    document.removeEventListener("pointerdown", this.events.pointerDown, { capture: true });
    document.removeEventListener("keydown", this.events.keyDown, { capture: true });
    canvas.app?.ticker?.remove?.(this.events.tick);
    Hooks.off("updateItem", this.events.itemUpdate);
    const canvasView = canvas.app?.view ?? null;
    if (canvasView?.oncontextmenu === this.events.cancel) canvasView.oncontextmenu = this.previousViewContextMenu;
    this.rightClickCancelCandidate = null;
    this.previousViewContextMenu = null;
    this.clearNoisePreviews();
    this.clearBroadcastPreviews();
    this.container.destroy({ children: true });
    if (activeCommandedAttack === this) activeCommandedAttack = null;
  }

  handleTokenUnavailable(tokenOrDocument = null, { matchUuid = false } = {}) {
    if (this.destroyed || !tokenOrDocument) return false;
    const matches = candidate => tokenLifecycleMatches(candidate, tokenOrDocument, { matchUuid });
    if (this.entries.some(entry => matches(entry.token))) {
      this.destroy();
      return true;
    }

    const removedUuid = getTokenDocumentUuid(tokenOrDocument);
    let changed = false;
    for (const entry of this.entries) {
      const targetRemoved = entry.targets.some(matches);
      const hoveredRemoved = matches(entry.hoveredTarget);
      const trajectoryRemoved = matches(entry.trajectoryAimTarget);
      const lockedTargetRemoved = Boolean(removedUuid && entry.targetUuid === removedUuid);
      const burstTargetRemoved = Array.from(entry.burstRanges.keys()).some(matches);
      if (!targetRemoved && !hoveredRemoved && !trajectoryRemoved && !lockedTargetRemoved && !burstTargetRemoved) continue;

      changed = true;
      entry.targets = entry.targets.filter(target => !matches(target));
      if (hoveredRemoved) entry.hoveredTarget = null;
      if (trajectoryRemoved) entry.trajectoryAimTarget = null;
      entry.burstRanges = new Map(Array.from(entry.burstRanges).filter(([target]) => !matches(target)));
      if (lockedTargetRemoved) {
        entry.pointer = null;
        entry.geometry = null;
        entry.lockedGeometry = null;
        entry.targetUuid = "";
        entry.selectedLimbKey = "";
        entry.directionKey = "";
        entry.mode = "current";
        entry.locked = false;
      }
      entry.lastBroadcastPreviewState = null;
      entry.lastTargetMarkerRenderState = null;
      this.drawEntry(entry, performance.now());
    }
    if (changed && !this.processing && !this.destroyed) this.previewFrameScheduler.request();
    return changed;
  }

  onMove(event) {
    if (this.processing) return;
    this.updateRightClickCancelCandidate(event);
    event.stopPropagation();
    this.pointer = event.data.getLocalPosition(getCombatVisualizationLayer());
    this.previewFrameScheduler.request();
  }

  onTick() {
    if (this.processing || this.destroyed) return;
    for (const entry of this.entries) this.drawFocusedTargetMarkerForEntry(entry, performance.now());
  }

  onItemUpdate(item = null, changes = {}, options = {}) {
    if (isDeusExMachinaProgressItemUpdate(changes, options)) return;
    if (this.processing || this.destroyed) return;
    for (const entry of this.entries) {
      if (item?.parent?.uuid !== entry.token?.actor?.uuid) continue;
      entry.noiseLevel = getWeaponNoiseLevel(getWeaponAttackData(entry.weapon, entry.weaponFunctionId));
      setWeaponNoisePreview(entry.token, entry.noisePreviewSourceId, entry.noiseLevel);
    }
  }

  clearNoisePreviews() {
    for (const entry of this.entries) {
      clearWeaponNoisePreview(
        entry.token?.id ?? entry.token?.document?.id ?? "",
        entry.noisePreviewSourceId
      );
    }
  }

  onKeyDown(event) {
    if (event.key !== "Escape" || this.processing) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    return this.cancel();
  }

  onPointerDown(event) {
    if (![0, 2].includes(event.button) || this.processing || !isCanvasViewEvent(event)) return;
    if (event.button === 2) {
      this.startRightClickCancelCandidate(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    this.updatePointerFromClientEvent(event);
    const entry = this.entries.find(entry => !entry.locked);
    if (!entry) return;
    if (!this.lockEntry(entry)) return;
    if (this.entries.every(candidate => candidate.locked)) void this.execute();
  }

  onCancel(event) {
    if (this.processing || this.destroyed || !isCanvasViewEvent(event)) return false;
    if (this.isRightClickDragCancel(event)) {
      this.rightClickCancelCandidate = null;
      if (typeof this.previousViewContextMenu === "function") {
        return this.previousViewContextMenu.call(canvas.app?.view ?? null, event);
      }
      return false;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    this.rightClickCancelCandidate = null;
    if (this.unlockLastEntry()) return false;
    // Once simultaneous aiming has started, RMB is reserved exclusively for
    // undoing fixed rays. Esc remains the explicit whole-cycle cancellation.
    return false;
  }

  startRightClickCancelCandidate(event) {
    this.rightClickCancelCandidate = {
      pointerId: event.pointerId,
      x: Number(event.clientX) || 0,
      y: Number(event.clientY) || 0,
      dragged: false
    };
  }

  updateRightClickCancelCandidate(event) {
    const candidate = this.rightClickCancelCandidate;
    if (!candidate) return;
    const pointerId = event?.pointerId ?? event?.nativeEvent?.pointerId;
    if (pointerId !== undefined && candidate.pointerId !== undefined && pointerId !== candidate.pointerId) return;
    if (getPointerDistanceFromEvent(event, candidate) >= getFoundryDragResistance()) candidate.dragged = true;
  }

  isRightClickDragCancel(event) {
    this.updateRightClickCancelCandidate(event);
    const manager = canvas.mouseInteractionManager;
    return Boolean(this.rightClickCancelCandidate?.dragged || (manager?._dragRight && manager?.state >= 4));
  }

  updatePointerFromClientEvent(event) {
    if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return;
    this.pointer = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    this.previewFrameScheduler.request();
    this.previewFrameScheduler.flush();
  }

  lockEntry(entry) {
    entry.targetTokenUuidAllowlist = getAuthoritativeAttackPerceptionUuids(entry.token);
    this.refreshEntry(entry, this.pointer);
    const geometry = entry.geometry;
    if (!geometry || !this.pointer) return false;
    const selection = this.getEntrySelection(entry);
    if (!selection) return false;
    entry.pointer = serializePoint(this.pointer);
    entry.geometry = serializeGeometry(geometry);
    entry.lockedGeometry = entry.geometry;
    entry.mode = selection.mode;
    entry.targetUuid = selection.targetUuid;
    entry.selectedLimbKey = selection.selectedLimbKey;
    entry.directionKey = selection.directionKey;
    entry.locked = true;
    this.drawEntry(entry, performance.now());
    this.broadcastPreviews(true);
    const remaining = this.entries.filter(entry => !entry.locked).length;
    if (remaining > 0) ui.notifications.info(`${this.label}: осталось лучей ${remaining}.`);
    return true;
  }

  unlockLastEntry() {
    const entry = this.entries.findLast(candidate => candidate.locked);
    if (!entry) return false;
    entry.pointer = null;
    entry.lockedGeometry = null;
    entry.targetUuid = "";
    entry.selectedLimbKey = "";
    entry.directionKey = "";
    entry.mode = "current";
    entry.locked = false;
    if (this.pointer) this.refreshEntry(entry, this.pointer);
    else {
      entry.geometry = null;
      entry.targets = [];
      entry.hoveredTarget = null;
      entry.trajectoryAimTarget = null;
      entry.burstRanges = new Map();
      entry.shape.clear();
      this.clearEntryTargetMarkers(entry);
    }
    this.drawEntry(entry, performance.now());
    this.broadcastPreviews(true);
    ui.notifications.info(`${this.label}: последний луч разморожен.`);
    return true;
  }

  refresh() {
    if (!this.pointer) return;
    for (const entry of this.entries) {
      if (entry.locked) {
        continue;
      }
      this.refreshEntry(entry, this.pointer);
    }
    this.broadcastPreviews();
  }

  refreshEntry(entry, pointer) {
    if (!entry?.token?.actor || !entry.weapon || !pointer) return;
    const origin = getTokenAimPoint(entry.token);
    let geometry = getAttackGeometry(
      entry.weapon,
      entry.actionKey,
      entry.token,
      origin,
      pointer,
      entry.weaponFunctionId,
      entry.rangeProfile
    );
    if (!geometry) {
      entry.geometry = null;
      entry.targets = [];
      entry.hoveredTarget = null;
      entry.trajectoryAimTarget = null;
      entry.burstRanges = new Map();
      entry.shape.clear();
      this.clearEntryTargetMarkers(entry);
      return;
    }
    let potentialTargets = getPotentialTargets(entry.token, geometry, {
      includeAttacker: isVolleyAttackAction(entry.weapon, entry.actionKey, entry.weaponFunctionId),
      includeDead: isVolleyAttackAction(entry.weapon, entry.actionKey, entry.weaponFunctionId),
      targetTokenUuidAllowlist: entry.targetTokenUuidAllowlist
    });
    entry.hoveredTarget = MELEE_ACTION_KEYS.has(entry.actionKey)
      ? getAimedTargetUnderPointer(pointer, potentialTargets)
      : null;
    entry.trajectoryAimTarget = isVolleyAttackAction(entry.weapon, entry.actionKey, entry.weaponFunctionId)
      ? getVolleyTrajectoryAimTarget(entry.token, geometry, {
        includeAttacker: true,
        includeDead: true,
        candidates: potentialTargets
      })
      : (entry.hoveredTarget ?? potentialTargets.at(0) ?? null);
    geometry.aimPoint = entry.trajectoryAimTarget
      ? selectAttackGeometryAimPoint(entry.token, entry.trajectoryAimTarget, geometry)
      : null;
    if (isVolleyAttackAction(entry.weapon, entry.actionKey, entry.weaponFunctionId) && geometry.aimPoint) {
      geometry = aimVolleyGeometryAtPoint(entry.token, geometry, geometry.aimPoint);
      potentialTargets = getPotentialTargets(entry.token, geometry, {
        includeAttacker: true,
        includeDead: true,
        targetTokenUuidAllowlist: entry.targetTokenUuidAllowlist
      });
    } else if (geometry.aimPoint) {
      potentialTargets = getAimedElevationTargets(entry.token, geometry, potentialTargets);
    }
    entry.geometry = geometry;
    entry.targets = potentialTargets;
    entry.burstRanges = this.getEntryBurstTargetRanges(entry);
    this.drawEntry(entry, performance.now());
  }

  getEntrySelection(entry) {
    if (!entry?.geometry) return null;
    if (MELEE_ACTION_KEYS.has(entry.actionKey)) {
      const target = entry.hoveredTarget ?? entry.trajectoryAimTarget ?? entry.targets.find(target => target && target !== entry.token) ?? null;
      const directions = getEnabledMeleeDirections(entry.weapon, entry.actionKey, entry.weaponFunctionId);
      if (!target?.actor) {
        if (entry.actionKey !== "meleeAttack" || !directions.length) {
          ui.notifications.warn(`${entry.token?.name ?? entry.token?.actor?.name ?? this.label}: нет цели для удара.`);
          return null;
        }
        return {
          mode: UNAIMED_ATTACK_MODE,
          target: null,
          targetUuid: "",
          selectedLimbKey: "",
          directionKey: ""
        };
      }
      const direction = directions.find(direction => direction.mode === "thrust") ?? directions.at(0);
      if (!direction) return null;
      return {
        mode: "directed",
        target,
        targetUuid: target.document?.uuid ?? target.uuid ?? "",
        selectedLimbKey: "",
        directionKey: direction.key
      };
    }
    return {
      mode: "current",
      target: null,
      targetUuid: "",
      selectedLimbKey: "",
      directionKey: ""
    };
  }

  getEntryBurstTargetRanges(entry) {
    if (
      entry.actionKey !== "burst"
      || isVolleyAttackAction(entry.weapon, entry.actionKey, entry.weaponFunctionId)
      || !entry.geometry
      || hasWeaponSpecialProperty(entry.weapon, WEAPON_SPECIAL_PROPERTIES.hitAllConeTargets, entry.weaponFunctionId)
    ) return new Map();
    const attackCount = getActionAttackCount(entry.weapon, entry.actionKey, entry.weaponFunctionId);
    const projectileCount = getBurstProjectileCount(
      attackCount,
      getWeaponProjectileCountPerAttack(entry.weapon, entry.weaponFunctionId)
    );
    return buildBurstTargetRanges(
      entry.token,
      entry.geometry,
      entry.targets,
      projectileCount,
      { purpose: "preview" }
    );
  }

  getEntryFocusedTarget(entry) {
    return entry.hoveredTarget ?? entry.trajectoryAimTarget ?? null;
  }

  drawEntry(entry, time = performance.now()) {
    entry.shape.clear();
    if (!entry.geometry) {
      this.clearEntryTargetMarkers(entry);
      return;
    }
    drawAttackShape(entry.shape, entry.geometry, {
      locked: entry.locked,
      hasTargets: entry.targets.length > 0
    });
    const markerState = getTargetMarkerRenderState(entry.targets, null, entry.burstRanges);
    if (!isSameTargetMarkerRenderState(markerState, entry.lastTargetMarkerRenderState)) {
      entry.lastTargetMarkerRenderState = markerState;
      drawTargetMarkers(entry.targetMarkers, entry.targets, null, time, entry.burstRanges);
    }
    this.drawFocusedTargetMarkerForEntry(entry, time);
  }

  clearEntryTargetMarkers(entry) {
    clearTargetMarkerLayer(entry.targetMarkers);
    clearTargetMarkerLayer(entry.focusedTargetMarker);
    entry.lastTargetMarkerRenderState = null;
  }

  drawFocusedTargetMarkerForEntry(entry, time = performance.now()) {
    clearTargetMarkerLayer(entry.focusedTargetMarker);
    const marker = getTargetCenterMarkerPosition(this.getEntryFocusedTarget(entry));
    if (marker) drawFocusedTargetMarker(entry.focusedTargetMarker, marker, time);
  }

  broadcastPreviews(force = false) {
    if (this.destroyed) return;
    for (const entry of this.entries) {
      if (!entry.geometry && entry.previewBroadcasted) this.clearBroadcastPreview(entry);
    }
    const now = performance.now();
    if (!force && now - this.lastPreviewBroadcastAt < PREVIEW_BROADCAST_INTERVAL_MS) return;
    this.lastPreviewBroadcastAt = now;
    for (const entry of this.entries) {
      if (!entry.geometry) continue;
      const focusedTarget = this.getEntryFocusedTarget(entry);
      const previewState = {
        geometry: serializeGeometry(entry.geometry),
        targetMarkers: entry.targets
          .map(target => getTargetMarkerPreviewData(target, entry.burstRanges))
          .filter(Boolean),
        focusedTargetMarker: focusedTarget ? getTargetCenterMarkerPosition(focusedTarget) : null,
        processing: entry.locked
      };
      if (!force && isSamePreviewState(previewState, entry.lastBroadcastPreviewState)) continue;
      entry.lastBroadcastPreviewState = previewState;
      entry.previewBroadcasted = true;
      broadcastAttackPreview({
        action: "updatePreview",
        attackId: entry.previewId,
        sceneId: canvas.scene?.id ?? "",
        ...previewState
      });
    }
  }

  clearBroadcastPreview(entry = null) {
    if (!entry?.previewBroadcasted) return;
    broadcastAttackPreview({ action: "clearPreview", attackId: entry.previewId });
    entry.previewBroadcasted = false;
    entry.lastBroadcastPreviewState = null;
  }

  clearBroadcastPreviews() {
    for (const entry of this.entries) this.clearBroadcastPreview(entry);
  }

  cancel() {
    if (this.processing || this.destroyed) return false;
    this.finishTargetSelection({ cancelled: true });
    this.destroy();
    this.onCancelled?.();
    ui.notifications.info(`${this.label}: отменено.`);
    return true;
  }

  async execute() {
    if (this.processing) return false;
    this.finishTargetSelection();
    this.processing = true;
    this.clearNoisePreviews();
    try {
      const selections = this.entries.map(entry => serializeCommandedAttackSelection({
        token: entry.token,
        weapon: entry.weapon,
        actionKey: entry.actionKey,
        weaponFunctionId: entry.weaponFunctionId,
        actionPointCost: entry.actionPointCost,
        pointer: entry.pointer,
        geometry: entry.lockedGeometry,
        lockedGeometry: entry.lockedGeometry,
        targetUuid: entry.targetUuid,
        selectedLimbKey: entry.selectedLimbKey,
        directionKey: entry.directionKey,
        mode: entry.mode
      }));
      if (typeof this.onBeforeExecute === "function" && (await this.onBeforeExecute(selections)) === false) {
        this.destroy();
        this.onComplete?.(createCommandedAttackResult({
          started: true,
          attemptedCount: selections.length,
          reason: "beforeExecuteRejected"
        }));
        return false;
      }
      this.destroy();
      const executed = await executeCommandedWeaponAttackSelections(selections, {
        chainRef: this.chainRef,
        authorityContext: this.authorityContext
      });
      this.onComplete?.(executed);
      return executed;
    } catch (error) {
      console.error(`${SYSTEM_ID} | Commanded weapon attacks failed`, error);
      ui.notifications.error(`${this.label}: атака не выполнена.`);
      this.destroy();
      this.onComplete?.(createCommandedAttackResult({ started: true, reason: "executionError" }));
      return false;
    }
  }

  finishTargetSelection({ cancelled = false } = {}) {
    const session = this.targetSelectionSession;
    if (!session) return false;
    this.targetSelectionSession = null;
    this.targetSelectionOutcome = { cancelled: Boolean(cancelled) };
    return session.finish(this.targetSelectionOutcome);
  }
}

function serializeOrdinaryAttackSelection(selection = {}) {
  return {
    tokenUuid: selection.token?.document?.uuid ?? selection.token?.uuid ?? selection.tokenUuid ?? "",
    weaponUuid: selection.weapon?.uuid ?? selection.weaponUuid ?? "",
    actionKey: String(selection.actionKey ?? ""),
    weaponFunctionId: String(selection.weaponFunctionId || ITEM_FUNCTIONS.weapon),
    pointer: selection.pointer,
    geometry: selection.geometry,
    lockedGeometry: selection.lockedGeometry ?? selection.geometry,
    targetUuid: String(selection.targetUuid ?? ""),
    selectedLimbKey: String(selection.selectedLimbKey ?? ""),
    directionKey: String(selection.directionKey ?? ""),
    selectedStrength: Math.max(1, toInteger(selection.selectedStrength) || 1),
    mode: String(selection.mode ?? "current"),
    operationId: String(selection.operationId ?? "").trim(),
    previewAttackId: String(selection.previewAttackId ?? "").trim()
  };
}

async function requestOrdinaryWeaponAttackOperation(gm, selection = {}) {
  if (!gm?.active || typeof gm.query !== "function") {
    return { ok: false, executed: false, reason: "missingGM" };
  }
  if (game.user?.hasPermission?.("QUERY_USER") === false) {
    return { ok: false, executed: false, reason: "queryPermission" };
  }

  const preferredAuthoritySocketId = ordinaryAttackAuthoritySockets.get(gm.id) ?? "";
  const preferences = preferredAuthoritySocketId ? [preferredAuthoritySocketId, ""] : [""];
  let lastFailure = { ok: false, executed: false, reason: "authorityUnavailable" };

  for (const preferredSocketId of preferences) {
    let ticket;
    try {
      ticket = await gm.query(
        ORDINARY_ATTACK_TICKET_QUERY,
        {
          selection,
          preferredAuthoritySocketId: preferredSocketId
        },
        { timeout: ORDINARY_ATTACK_TICKET_QUERY_TIMEOUT_MS }
      );
    } catch (error) {
      console.warn("Fallout MaW | Ordinary weapon attack authority ticket failed", error);
      const reason = /permission|query users/iu.test(String(error?.message ?? error))
        ? "queryPermission"
        : "authorityUnavailable";
      if (reason === "queryPermission") return { ok: false, executed: false, reason };
      lastFailure = { ok: false, executed: false, reason };
      if (preferredSocketId) ordinaryAttackAuthoritySockets.delete(gm.id);
      continue;
    }
    if (
      !ticket?.ok
      || ticket.operationId !== selection.operationId
      || !ticket.ticket
      || !ticket.authoritySocketId
    ) {
      lastFailure = {
        ok: false,
        executed: false,
        reason: String(ticket?.reason ?? "authorityUnavailable")
      };
      if (preferredSocketId) ordinaryAttackAuthoritySockets.delete(gm.id);
      continue;
    }
    ordinaryAttackAuthoritySockets.set(gm.id, ticket.authoritySocketId);
    return dispatchOrdinaryWeaponAttackOperation(gm, selection, ticket);
  }
  return lastFailure;
}

async function handleOrdinaryWeaponAttackTicketQuery(data = {}, {
  user: sender = null,
  timeout = ORDINARY_ATTACK_TICKET_QUERY_TIMEOUT_MS
} = {}) {
  if (
    !sender?.active
    || !sender?.id
    || !game.user?.isGM
    || game.users?.activeGM?.id !== game.user.id
  ) return { ok: false, reason: "authorityRejected" };

  const selection = serializeOrdinaryAttackSelection(data?.selection ?? {});
  if (
    !selection.operationId
    || !selection.previewAttackId
    || !selection.tokenUuid
    || !selection.weaponUuid
    || !selection.actionKey
  ) return { ok: false, reason: "invalidSelection" };
  const authoritySocketId = String(game.socket?.id ?? "").trim();
  if (!authoritySocketId) return { ok: false, reason: "authorityUnavailable" };
  const preferredAuthoritySocketId = String(data?.preferredAuthoritySocketId ?? "").trim();
  if (preferredAuthoritySocketId && preferredAuthoritySocketId !== authoritySocketId) {
    await delayOrdinaryAttackTicketResponse(timeout);
    return { ok: false, reason: "authoritySocketUnavailable" };
  }
  const tokenDocument = await fromUuid(selection.tokenUuid);
  if (
    !tokenDocument?.object?.actor
    || !isAttackSceneClient([tokenDocument], { requirePlaceables: true })
  ) {
    await delayOrdinaryAttackTicketResponse(timeout);
    return { ok: false, reason: "gmSceneUnavailable" };
  }

  pruneOrdinaryAttackAuthorityState();
  const ticket = foundry.utils.randomID(32);
  const entry = {
    actorUuid: String(tokenDocument.object.actor.uuid ?? ""),
    authoritySocketId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ORDINARY_ATTACK_TICKET_TTL_MS,
    operationId: selection.operationId,
    selection,
    sender,
    senderUserId: sender.id
  };
  entry.expiryTimeout = globalThis.setTimeout(() => {
    deleteOrdinaryAttackTicket(ticket, entry);
  }, ORDINARY_ATTACK_TICKET_TTL_MS + 50);
  entry.expiryTimeout?.unref?.();
  ordinaryAttackTickets.set(ticket, entry);
  return {
    ok: true,
    authoritySocketId,
    operationId: selection.operationId,
    ticket
  };
}

function delayOrdinaryAttackTicketResponse(timeout = ORDINARY_ATTACK_TICKET_QUERY_TIMEOUT_MS) {
  return new Promise(resolve => {
    globalThis.setTimeout(
      resolve,
      Math.max(1, Number(timeout) || ORDINARY_ATTACK_TICKET_QUERY_TIMEOUT_MS) + 25
    );
  });
}

function dispatchOrdinaryWeaponAttackOperation(gm, selection, ticket) {
  const operationId = String(selection?.operationId ?? "").trim();
  const existing = pendingOrdinaryAttackRequests.get(operationId);
  if (existing) {
    if (
      existing.authorityUserId === gm.id
      && existing.authoritySocketId === ticket.authoritySocketId
    ) return existing.promise;
    return Promise.resolve({ ok: false, executed: false, reason: "operationCollision" });
  }

  let resolvePending;
  const promise = new Promise(resolve => {
    resolvePending = resolve;
  });
  const state = {
    accepted: false,
    authoritySocketId: ticket.authoritySocketId,
    authorityUserId: gm.id,
    completionTimeout: null,
    hardTimeout: null,
    operationId,
    promise,
    recoveryAttempts: 0,
    requestPayload: {
      scope: WEAPON_ATTACK_SOCKET_SCOPE,
      action: "ordinaryAttackRequest",
      authoritySocketId: ticket.authoritySocketId,
      gmUserId: gm.id,
      operationId,
      senderUserId: game.user?.id ?? "",
      ticket: ticket.ticket
    },
    resolve: resolvePending,
    timeout: null
  };
  state.timeout = globalThis.setTimeout(() => {
    recoverPendingOrdinaryAttackRequest(state);
  }, ORDINARY_ATTACK_ACCEPT_TIMEOUT_MS);
  state.timeout?.unref?.();
  pendingOrdinaryAttackRequests.set(operationId, state);
  emitPendingOrdinaryAttackRequest(state);
  return promise;
}

function emitPendingOrdinaryAttackRequest(pending) {
  game.socket.emit(
    WEAPON_ATTACK_SOCKET,
    pending.requestPayload,
    { recipients: [pending.authorityUserId] }
  );
}

function recoverPendingOrdinaryAttackRequest(pending) {
  if (pendingOrdinaryAttackRequests.get(pending.operationId) !== pending) return;
  globalThis.clearTimeout(pending.timeout);
  globalThis.clearTimeout(pending.completionTimeout);
  pending.timeout = null;
  pending.completionTimeout = null;
  if (pending.recoveryAttempts >= 1) {
    pendingOrdinaryAttackRequests.delete(pending.operationId);
    globalThis.clearTimeout(pending.hardTimeout);
    pending.resolve({
      ok: false,
      executed: false,
      reason: pending.accepted ? "authorityStateUnknown" : "authorityUnavailable"
    });
    return;
  }

  pending.recoveryAttempts += 1;
  emitPendingOrdinaryAttackRequest(pending);
  pending.timeout = globalThis.setTimeout(() => {
    recoverPendingOrdinaryAttackRequest(pending);
  }, ORDINARY_ATTACK_RECOVERY_TIMEOUT_MS);
  pending.timeout?.unref?.();
}

function armOrdinaryAttackHardTimeout(pending) {
  if (pending.hardTimeout) return;
  pending.hardTimeout = globalThis.setTimeout(() => {
    if (pendingOrdinaryAttackRequests.get(pending.operationId) !== pending) return;
    pendingOrdinaryAttackRequests.delete(pending.operationId);
    globalThis.clearTimeout(pending.timeout);
    globalThis.clearTimeout(pending.completionTimeout);
    pending.resolve({ ok: false, executed: false, reason: "authorityStateUnknown" });
  }, ORDINARY_ATTACK_HARD_TIMEOUT_MS);
  pending.hardTimeout?.unref?.();
}

function armOrdinaryAttackCompletionTimeout(pending) {
  if (pending.completionTimeout) return;
  pending.completionTimeout = globalThis.setTimeout(() => {
    pending.completionTimeout = null;
    recoverPendingOrdinaryAttackRequest(pending);
  }, ORDINARY_ATTACK_COMPLETION_TIMEOUT_MS);
  pending.completionTimeout?.unref?.();
}

function settlePendingOrdinaryAttackRequest(payload = {}, socketSenderUserId = "") {
  const authenticatedSenderUserId = String(socketSenderUserId ?? "").trim();
  if (
    !authenticatedSenderUserId
    || payload.senderUserId !== authenticatedSenderUserId
    || payload.targetUserId !== game.user?.id
  ) return false;
  const operationId = String(payload.operationId ?? "").trim();
  const pending = pendingOrdinaryAttackRequests.get(operationId);
  if (
    !pending
    || authenticatedSenderUserId !== pending.authorityUserId
    || payload.authoritySocketId !== pending.authoritySocketId
  ) return false;

  if (payload.action === "ordinaryAttackAccepted") {
    const firstAcceptance = !pending.accepted;
    pending.accepted = true;
    globalThis.clearTimeout(pending.timeout);
    pending.timeout = null;
    if (firstAcceptance) armOrdinaryAttackHardTimeout(pending);
    armOrdinaryAttackCompletionTimeout(pending);
    return true;
  }
  if (payload.action === "ordinaryAttackProgress") {
    const firstAcceptance = !pending.accepted;
    pending.accepted = true;
    globalThis.clearTimeout(pending.timeout);
    pending.timeout = null;
    if (firstAcceptance) armOrdinaryAttackHardTimeout(pending);
    armOrdinaryAttackCompletionTimeout(pending);
    return true;
  }
  if (payload.action !== "ordinaryAttackResult") return false;
  pendingOrdinaryAttackRequests.delete(operationId);
  globalThis.clearTimeout(pending.timeout);
  globalThis.clearTimeout(pending.completionTimeout);
  globalThis.clearTimeout(pending.hardTimeout);
  pending.resolve(payload.result ?? { ok: false, executed: false, reason: "authorityError" });
  return true;
}

function clearWeaponAttackCanvasState() {
  const attack = activeAttack;
  const dualAttack = activeDualWeaponAttack;
  const commandedAttack = activeCommandedAttack;
  activeAttack = null;
  activeDualWeaponAttack = null;
  activeCommandedAttack = null;
  if (attack && !attack.destroyed) attack.destroy();
  if (dualAttack && !dualAttack.destroyed) dualAttack.destroy();
  if (commandedAttack && !commandedAttack.destroyed) commandedAttack.destroy();
  for (const controller of Array.from(liveWeaponAttackTargetControllers)) {
    if (!controller.destroyed) controller.destroy();
  }
  liveWeaponAttackTargetControllers.clear();
  clearRemoteAttackPreviews();
}

async function handleOrdinaryWeaponAttackSocketRequest(payload = {}, socketSenderUserId = "") {
  const authenticatedSenderUserId = String(socketSenderUserId ?? "").trim();
  if (
    !authenticatedSenderUserId
    || payload.senderUserId !== authenticatedSenderUserId
    || !game.user?.isGM
    || game.users?.activeGM?.id !== game.user.id
    || payload.gmUserId !== game.user.id
    || payload.authoritySocketId !== String(game.socket?.id ?? "")
  ) return false;

  pruneOrdinaryAttackAuthorityState();
  const operationId = String(payload.operationId ?? "").trim();
  const senderUserId = authenticatedSenderUserId;
  const ticketValue = String(payload.ticket ?? "").trim();
  const operationKey = `${senderUserId}:${operationId}`;
  if (!operationId || !ticketValue) return false;

  const completed = ordinaryAttackOperationsCompleted.get(operationKey);
  if (completed?.ticket === ticketValue) {
    emitOrdinaryAttackResult(senderUserId, operationId, completed.result, payload.authoritySocketId);
    return true;
  }
  const inFlight = ordinaryAttackOperationsInFlight.get(operationKey);
  if (inFlight?.ticket === ticketValue) {
    emitOrdinaryAttackAccepted(senderUserId, operationId, payload.authoritySocketId);
    emitOrdinaryAttackResult(
      senderUserId,
      operationId,
      await inFlight.promise,
      payload.authoritySocketId
    );
    return true;
  }

  const ticket = ordinaryAttackTickets.get(ticketValue);
  if (
    !ticket
    || ticket.authoritySocketId !== payload.authoritySocketId
    || ticket.operationId !== operationId
    || ticket.senderUserId !== senderUserId
  ) return false;
  deleteOrdinaryAttackTicket(ticketValue, ticket);
  if (ticket.expiresAt < Date.now()) {
    emitOrdinaryAttackResult(senderUserId, operationId, {
      ok: false,
      executed: false,
      reason: "authorityUnavailable"
    }, payload.authoritySocketId);
    return true;
  }
  if (completed) {
    emitOrdinaryAttackResult(senderUserId, operationId, completed.result, payload.authoritySocketId);
    return true;
  }
  if (inFlight) {
    emitOrdinaryAttackAccepted(senderUserId, operationId, payload.authoritySocketId);
    emitOrdinaryAttackResult(
      senderUserId,
      operationId,
      await inFlight.promise,
      payload.authoritySocketId
    );
    return true;
  }

  emitOrdinaryAttackAccepted(senderUserId, operationId, payload.authoritySocketId);
  const progressInterval = globalThis.setInterval(() => {
    emitOrdinaryAttackProgress(senderUserId, operationId, payload.authoritySocketId);
  }, ORDINARY_ATTACK_PROGRESS_INTERVAL_MS);
  progressInterval?.unref?.();
  const promise = enqueueOrdinaryAttackActorOperation(ticket.actorUuid, () => (
    executeOrdinaryWeaponAttackSelection(ticket.selection, ticket.sender)
  ));
  ordinaryAttackOperationsInFlight.set(operationKey, { promise, ticket: ticketValue });
  const result = await promise.catch(error => {
    console.error("Fallout MaW | Ordinary weapon attack authority operation failed", error);
    return { ok: false, executed: false, reason: "authorityError" };
  }).finally(() => {
    globalThis.clearInterval(progressInterval);
  });
  ordinaryAttackOperationsInFlight.delete(operationKey);
  ordinaryAttackOperationsCompleted.set(operationKey, {
    completedAt: Date.now(),
    result,
    ticket: ticketValue
  });
  emitOrdinaryAttackResult(senderUserId, operationId, result, payload.authoritySocketId);
  return true;
}

function enqueueOrdinaryAttackActorOperation(tokenUuid = "", operation) {
  const key = String(tokenUuid ?? "").trim();
  const previous = ordinaryAttackActorQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (ordinaryAttackActorQueues.get(key) === next) ordinaryAttackActorQueues.delete(key);
    });
  ordinaryAttackActorQueues.set(key, next);
  return next;
}

function emitOrdinaryAttackAccepted(targetUserId, operationId, authoritySocketId) {
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "ordinaryAttackAccepted",
    authoritySocketId,
    operationId,
    senderUserId: game.user?.id ?? "",
    targetUserId
  }, { recipients: [targetUserId] });
}

function emitOrdinaryAttackProgress(targetUserId, operationId, authoritySocketId) {
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "ordinaryAttackProgress",
    authoritySocketId,
    operationId,
    senderUserId: game.user?.id ?? "",
    targetUserId
  }, { recipients: [targetUserId] });
}

function emitOrdinaryAttackResult(targetUserId, operationId, result, authoritySocketId) {
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "ordinaryAttackResult",
    authoritySocketId,
    operationId,
    result,
    senderUserId: game.user?.id ?? "",
    targetUserId
  }, { recipients: [targetUserId] });
}

function deleteOrdinaryAttackTicket(ticketValue, expectedEntry = null) {
  const value = String(ticketValue ?? "").trim();
  const entry = ordinaryAttackTickets.get(value);
  if (!entry || (expectedEntry && entry !== expectedEntry)) return false;
  globalThis.clearTimeout(entry.expiryTimeout);
  ordinaryAttackTickets.delete(value);
  return true;
}

function pruneOrdinaryAttackAuthorityState() {
  const now = Date.now();
  for (const [ticket, entry] of ordinaryAttackTickets) {
    if (entry.expiresAt < now) deleteOrdinaryAttackTicket(ticket, entry);
  }
  for (const [key, entry] of ordinaryAttackOperationsCompleted) {
    if (entry.completedAt < now - ORDINARY_ATTACK_COMPLETED_TTL_MS) {
      ordinaryAttackOperationsCompleted.delete(key);
    }
  }
  while (ordinaryAttackOperationsCompleted.size > ORDINARY_ATTACK_CACHE_LIMIT) {
    ordinaryAttackOperationsCompleted.delete(ordinaryAttackOperationsCompleted.keys().next().value);
  }
}

async function executeOrdinaryWeaponAttackSelection(selection, sender) {
  if (
    !sender?.active
    || !sender?.id
    || !game.user?.isGM
    || game.users?.activeGM?.id !== game.user.id
  ) return { ok: false, executed: false, reason: "authorityRejected" };

  try {
    if (!selection.operationId || !selection.tokenUuid || !selection.weaponUuid || !selection.actionKey) {
      return { ok: false, executed: false, reason: "invalidSelection" };
    }
    const [tokenDocument, weapon] = await Promise.all([
      fromUuid(selection.tokenUuid),
      fromUuid(selection.weaponUuid)
    ]);
    const token = tokenDocument?.object ?? null;
    if (!token?.actor || !weapon) return { ok: false, executed: false, reason: "missingDocument" };
    if (!isAttackSceneClient([tokenDocument], { requirePlaceables: true })) {
      return { ok: false, executed: false, reason: "gmSceneUnavailable" };
    }
    if (!sender.isGM && !token.actor.testUserPermission?.(sender, "OWNER")) {
      return { ok: false, executed: false, reason: "notOwner" };
    }
    if (weapon.parent?.uuid !== token.actor.uuid) {
      return { ok: false, executed: false, reason: "wrongWeaponOwner" };
    }
    if (!isAttackSource(weapon, selection.weaponFunctionId)) {
      return { ok: false, executed: false, reason: "invalidWeapon" };
    }
    if (isActorUnableToAct(token.actor)) {
      return { ok: false, executed: false, reason: "unableToAct" };
    }
    if (!getWeaponAttackData(weapon, selection.weaponFunctionId)?.enabled) {
      return { ok: false, executed: false, reason: "disabledWeapon" };
    }
    if (!hasWeaponAction(weapon, selection.actionKey, selection.weaponFunctionId)) {
      return { ok: false, executed: false, reason: "missingAction" };
    }
    if (isVolleyAttackAction(weapon, selection.actionKey, selection.weaponFunctionId)) {
      return { ok: false, executed: false, reason: "unsupportedAction" };
    }
    if (getWeaponActionBlockState(token.actor, selection.actionKey).blocked) {
      return { ok: false, executed: false, reason: "blockedAction" };
    }
    if (isWeaponPlacementDisabled(token.actor, weapon)) {
      return { ok: false, executed: false, reason: "disabledPlacement" };
    }
    if (isReactionSystemLocked()) {
      return { ok: false, executed: false, reason: "reactionLocked" };
    }
    const attackCount = getActionAttackCount(weapon, selection.actionKey, selection.weaponFunctionId);
    if (!hasRequiredWeaponResources(weapon, attackCount, selection.weaponFunctionId)) {
      return { ok: false, executed: false, reason: "weaponResources" };
    }
    if (!validateCommandedAttackSelectionMode(selection, weapon)) {
      return { ok: false, executed: false, reason: "invalidMode" };
    }

    const targetTokenUuidAllowlist = getAuthoritativeAttackPerceptionUuids(token);
    if (selection.targetUuid && !targetTokenUuidAllowlist.has(selection.targetUuid)) {
      return { ok: false, executed: false, reason: "invalidTarget" };
    }
    const controller = new WeaponAttackController(token, weapon, selection.actionKey, selection.weaponFunctionId, null, {
      skipActionPointCost: false,
      skipBaseWeaponResourceCosts: false,
      targetTokenUuidAllowlist,
      suppressAttackPreviewBroadcast: true,
      headlessExecution: true,
      attackId: selection.operationId,
      chanceOperationId: selection.previewAttackId,
      chatMessageAuthorId: sender.id,
      autoCoverAttackId: selection.previewAttackId,
      ownsAttackAutoCoverLifecycle: false,
      finishAfterAttack: true
    });
    try {
      if (!(await validateCommandedAttackSelectionGeometry(selection, token, weapon, {
        targetTokenUuidAllowlist,
        attackId: selection.operationId,
        controller
      }))) {
        return { ok: false, executed: false, reason: "invalidGeometry" };
      }

      const result = await executeCapturedWeaponAttack({
        ...selection,
        token,
        weapon
      }, {
        controller,
        returnAuthorityMetadata: true
      });
      return {
        ok: Boolean(result?.executed),
        executed: Boolean(result?.executed),
        attackCheckCount: Math.max(0, toInteger(result?.attackCheckCount)),
        canceledByReaction: Boolean(result?.canceledByReaction),
        selectionCommitted: Boolean(result?.selectionCommitted),
        shouldFinish: Boolean(result?.shouldFinish),
        reason: result?.executed ? "" : (result?.canceledByReaction ? "authorityCancelled" : "notExecuted")
      };
    } finally {
      controller.destroy();
    }
  } catch (error) {
    console.error("Fallout MaW | Ordinary weapon attack authority operation failed", error);
    return { ok: false, executed: false, reason: "authorityError" };
  }
}

function getOrdinaryAttackSceneGM(token = null) {
  const gm = game.users?.activeGM ?? null;
  return gm?.active && gm.isGM ? gm : null;
}

function getAuthoritativeAttackPerceptionUuids(attackerToken = null) {
  const attackerUuid = getTokenDocumentUuid(attackerToken);
  if (!attackerToken?.actor || !attackerUuid) return new Set();
  const candidates = (globalThis.canvas?.tokens?.placeables ?? []).filter(target => (
    target === attackerToken || isAttackImpactTarget(target)
  ));
  const perceived = new Set([attackerUuid]);
  if (attackerToken.vision?.active) {
    for (const target of candidates) {
      const uuid = getTokenDocumentUuid(target);
      if (uuid && isAttackTargetVisible(target, null, attackerToken)) perceived.add(uuid);
    }
    return perceived;
  }
  const visibility = testObserverVisibilityBatch(attackerToken, candidates);
  for (const target of candidates) {
    const uuid = getTokenDocumentUuid(target);
    if (uuid && visibility.get(uuid) === true) perceived.add(uuid);
  }
  return perceived;
}

function getOrdinaryAttackFailureMessage(reason = "") {
  const messages = {
    authorityUnavailable: "Активный GM не принял запрос атаки.",
    authorityStateUnknown: "GM принял атаку, но итоговый ответ потерян. Не повторяйте её до проверки ресурсов и цели.",
    operationCollision: "Локальный идентификатор атаки уже занят другой операцией.",
    authoritySocketUnavailable: "Выбранная вкладка GM больше недоступна.",
    queryPermission: "В правах роли отключён запрос к пользователю. Повторите атаку — будет использован локальный путь.",
    missingGM: "Нет активного GM для обработки атаки.",
    gmSceneUnavailable: "GM должен находиться на сцене и уровне атаки.",
    senderSceneUnavailable: "Сцена или уровень игрока изменились до подтверждения атаки.",
    notOwner: "Нет прав на атакующего актёра.",
    weaponResources: "Недостаточно боеприпасов или ресурса оружия.",
    unableToAct: "Актёр больше не может действовать.",
    reactionLocked: "Сейчас завершается другое боевое взаимодействие.",
    blockedAction: "Действие оружия заблокировано.",
    invalidGeometry: "Положение или траектория атаки успели измениться.",
    invalidTarget: "Выбранная цель больше недоступна."
  };
  return messages[String(reason ?? "")] ?? "GM отклонил выполнение атаки.";
}

function serializeCommandedAttackSelection(selection = {}) {
  return {
    tokenUuid: selection.token?.document?.uuid ?? selection.token?.uuid ?? "",
    weaponUuid: selection.weapon?.uuid ?? "",
    actionKey: String(selection.actionKey ?? ""),
    weaponFunctionId: String(selection.weaponFunctionId || ITEM_FUNCTIONS.weapon),
    actionPointCost: Math.max(0, toInteger(selection.actionPointCost)),
    pointer: selection.pointer,
    geometry: selection.geometry,
    lockedGeometry: selection.lockedGeometry ?? selection.geometry,
    targetUuid: String(selection.targetUuid ?? ""),
    selectedLimbKey: String(selection.selectedLimbKey ?? ""),
    directionKey: String(selection.directionKey ?? ""),
    selectedStrength: Math.max(1, toInteger(selection.selectedStrength) || 1),
    mode: String(selection.mode ?? "current")
  };
}

async function executeCommandedWeaponAttackSelections(selections = [], {
  chainRef = null,
  authorityContext = null
} = {}) {
  const serialized = (Array.isArray(selections) ? selections : []).filter(selection => selection?.tokenUuid && selection?.weaponUuid);
  if (!serialized.length) return createCommandedAttackResult({ reason: "emptySelections" });
  const gm = await getCommandedAttackSceneGM({ selections: serialized, authorityContext });
  if (!gm) {
    ui.notifications.warn("Нет активного GM на сцене и уровне командной атаки.");
    return createCommandedAttackResult({ reason: getCommandedAttackAuthorityFailureReason() });
  }
  return requestCommandedWeaponAttackOperation("execute", {
    selections: serialized,
    chainRef,
    authorityContext,
    gm
  });
}

async function preflightCommandedWeaponAttackSelections(selections = [], {
  chainRef = null,
  authorityContext = null
} = {}) {
  const serialized = (Array.isArray(selections) ? selections : []).filter(selection => selection?.tokenUuid && selection?.weaponUuid);
  if (!serialized.length || !authorityContext) return { ok: false, reason: "invalidPreflight" };
  const gm = await getCommandedAttackSceneGM({ selections: serialized, authorityContext });
  if (!gm) return { ok: false, reason: getCommandedAttackAuthorityFailureReason() };
  return requestCommandedWeaponAttackOperation("preflight", {
    selections: serialized,
    chainRef,
    authorityContext,
    gm
  });
}

async function requestCommandedWeaponAttackOperation(operation, {
  selections = [],
  chainRef = null,
  authorityContext = null,
  gm = null
} = {}) {
  if (!gm) return { ok: false, reason: "missingGM" };
  const data = {
    operation: String(operation ?? ""),
    chainRef,
    authorityContext,
    selections
  };
  try {
    return gm.id === game.user?.id
      ? await handleCommandedWeaponAttackQuery(data, { user: game.user })
      : await gm.query(COMMANDED_ATTACK_QUERY, data, { timeout: COMMANDED_ATTACK_QUERY_TIMEOUT_MS });
  } catch (error) {
    console.warn("Fallout MaW | Commanded weapon attack authority query failed", error);
    return { ok: false, reason: "authorityTimeout" };
  }
}

async function handleCommandedWeaponAttackQuery(data = {}, { user: sender = null } = {}) {
  const operation = String(data?.operation ?? "");
  if (!sender?.active || !["execute", "preflight"].includes(operation)) {
    return { ok: false, reason: "authorityRejected" };
  }
  try {
    const requiredTokenDocuments = await resolveCommandedAttackAuthorityTokenDocuments({
      selections: data.selections ?? [],
      authorityContext: data.authorityContext ?? null
    });
    if (!isCommandedAttackSceneAuthority(game.user, requiredTokenDocuments, { requirePlaceables: true })) {
      return { ok: false, reason: "gmSceneUnavailable" };
    }
    return await processCommandedWeaponAttackSelections(data.selections ?? [], {
      chainRef: data.chainRef ?? null,
      authorityContext: data.authorityContext ?? null,
      sender,
      validateOnly: operation === "preflight"
    });
  } catch (error) {
    console.error("Fallout MaW | Commanded weapon attack authority operation failed", error);
    return { ok: false, reason: "authorityError" };
  }
}

async function processCommandedWeaponAttackSelections(selections = [], {
  chainRef = null,
  authorityContext = null,
  sender = null,
  validateOnly = false
} = {}) {
  if (authorityContext && !(await validateCommandedAbilityAuthority({
    authorityContext,
    selections,
    sender
  }))) return { ok: false, reason: "authorityRejected" };
  const resolved = [];
  for (const selection of selections ?? []) {
    const tokenDocument = await fromUuid(String(selection.tokenUuid ?? ""));
    const token = tokenDocument?.object ?? (authorityContext ? null : tokenDocument) ?? null;
    const weapon = await fromUuid(String(selection.weaponUuid ?? ""));
    if (!token?.actor || !weapon) {
      return { ok: false, reason: authorityContext ? "gmSceneUnavailable" : "missingDocument" };
    }
    let target = null;
    if (selection.targetUuid) {
      const targetDocument = await fromUuid(String(selection.targetUuid));
      if (!targetDocument?.object && authorityContext) return { ok: false, reason: "gmSceneUnavailable" };
      target = targetDocument?.object ?? targetDocument ?? null;
    }
    resolved.push({
      token,
      target,
      weapon,
      actionKey: String(selection.actionKey ?? ""),
      weaponFunctionId: String(selection.weaponFunctionId || ITEM_FUNCTIONS.weapon),
      actionPointCost: Math.max(0, toInteger(selection.actionPointCost)),
      pointer: selection.pointer,
      geometry: selection.geometry,
      lockedGeometry: selection.lockedGeometry ?? selection.geometry,
      targetUuid: String(selection.targetUuid ?? ""),
      selectedLimbKey: String(selection.selectedLimbKey ?? ""),
      directionKey: String(selection.directionKey ?? ""),
      selectedStrength: Math.max(1, toInteger(selection.selectedStrength) || 1),
      mode: String(selection.mode ?? "current")
    });
  }
  if (!resolved.length || resolved.length !== selections.length) return { ok: false, reason: "missingSelection" };

  const actionPointCosts = new Map();
  for (const selection of resolved) {
    if (selection.weapon?.parent?.uuid !== selection.token.actor.uuid) return { ok: false, reason: "wrongWeaponOwner" };
    if (!isAttackSource(selection.weapon, selection.weaponFunctionId)) return { ok: false, reason: "invalidWeapon" };
    if (isActorUnableToAct(selection.token.actor)) return { ok: false, reason: "unableToAct" };
    if (!getWeaponAttackData(selection.weapon, selection.weaponFunctionId)?.enabled) return { ok: false, reason: "disabledWeapon" };
    if (!hasWeaponAction(selection.weapon, selection.actionKey, selection.weaponFunctionId)) return { ok: false, reason: "missingAction" };
    if (getWeaponActionBlockState(selection.token.actor, selection.actionKey).blocked) return { ok: false, reason: "blockedAction" };
    if (isWeaponPlacementDisabled(selection.token.actor, selection.weapon)) return { ok: false, reason: "disabledPlacement" };
    const attackCount = getActionAttackCount(selection.weapon, selection.actionKey, selection.weaponFunctionId);
    if (!hasRequiredWeaponResources(selection.weapon, attackCount, selection.weaponFunctionId)) return { ok: false, reason: "weaponResources" };
    selection.targetTokenUuidAllowlist = getAuthoritativeAttackPerceptionUuids(selection.token);
    if (
      selection.targetUuid
      && (
        !isAttackImpactTarget(selection.target)
        || !selection.targetTokenUuidAllowlist.has(selection.targetUuid)
      )
    ) return { ok: false, reason: "invalidTarget" };
    if (!validateCommandedAttackSelectionMode(selection, selection.weapon)) {
      return { ok: false, reason: "invalidMode" };
    }
    const current = actionPointCosts.get(selection.token.actor.uuid) ?? { actor: selection.token.actor, amount: 0 };
    current.amount += selection.actionPointCost;
    actionPointCosts.set(selection.token.actor.uuid, current);
  }
  for (const { actor, amount } of actionPointCosts.values()) {
    if (!canSpendStrictActionPoints(actor, amount, { label: "командная атака" })) return { ok: false, reason: "actionPoints" };
  }
  if (validateOnly) return { ok: true, reason: "" };

  const actionPointReceipts = await spendCommandedActionPointCosts(actionPointCosts, chainRef);
  if (!actionPointReceipts.ok) return { ok: false, reason: "actionPointSpendFailed" };

  const reactionCoordinator = createWeaponReactionCoordinator();
  const results = await Promise.allSettled(resolved.map(selection => executeCapturedWeaponAttack(selection, {
    skipActionPointCost: true,
    reportedActionPointCost: authorityContext ? selection.actionPointCost : null,
    reactionCoordinator,
    chainRef,
    targetTokenUuidAllowlist: selection.targetTokenUuidAllowlist,
    suppressAttackPreviewBroadcast: Boolean(authorityContext),
    headlessExecution: Boolean(authorityContext)
  })));
  for (const result of results) {
    if (result.status === "rejected") console.error("Fallout MaW | Commanded weapon attack execution failed", result.reason);
  }
  await reactionCoordinator.drain();
  const outcomes = results.map((result, index) => ({
    tokenUuid: String(selections[index]?.tokenUuid ?? ""),
    actorUuid: String(resolved[index]?.token?.actor?.uuid ?? ""),
    executed: result.status === "fulfilled" && Boolean(result.value),
    error: result.status === "rejected" ? String(result.reason?.message ?? result.reason ?? "") : ""
  }));
  const executedCount = outcomes.filter(outcome => outcome.executed).length;
  if (!executedCount) {
    await rollbackCommandedActionPointCosts(actionPointReceipts.receipts, chainRef);
  } else {
    await applyCommandedActionPointMovementLoss(actionPointReceipts.receipts, chainRef);
  }
  return createCommandedAttackResult({
    started: true,
    committed: true,
    attemptedCount: resolved.length,
    executedCount,
    outcomes,
    reason: executedCount === resolved.length ? "" : "partialExecution"
  });
}

async function spendCommandedActionPointCosts(actionPointCosts = new Map(), chainRef = null) {
  const receipts = [];
  try {
    for (const { actor, amount } of actionPointCosts.values()) {
      const cost = Math.max(0, toInteger(amount));
      if (cost <= 0 || !isActorInActiveCombat(actor)) continue;
      const transaction = await spendStrictActionPointsWithReceipt(actor, cost, {
        source: "abilityAction",
        actionKey: "commandedAttack",
        chainRef
      });
      if (transaction.spent !== cost || !transaction.receipt) {
        throw new Error("Action point spend was not applied exactly.");
      }
      receipts.push({ actor, receipt: transaction.receipt });
    }
    return { ok: true, receipts };
  } catch (error) {
    console.error("Fallout MaW | Commanded attack action point spend failed", error);
    await rollbackCommandedActionPointCosts(receipts, chainRef);
    return { ok: false, receipts: [] };
  }
}

async function rollbackCommandedActionPointCosts(receipts = [], chainRef = null) {
  for (const entry of [...receipts].reverse()) {
    const actor = entry?.actor;
    const receipt = entry?.receipt;
    if (!actor || !receipt) continue;
    try {
      const restored = await refundStrictActionPointReceipt(actor, receipt, { chainRef });
      if (restored < Math.max(0, toInteger(receipt.amount))) {
        throw new Error(`Only ${restored} of ${receipt.amount} commanded attack action points were rolled back.`);
      }
    } catch (error) {
      console.error("Fallout MaW | Failed to roll back commanded attack action points", error);
    }
  }
}

async function applyCommandedActionPointMovementLoss(receipts = [], chainRef = null) {
  const commandOperationId = String(
    chainRef?.rootId
    ?? chainRef?.operationId
    ?? foundry.utils.randomID()
  );
  for (const entry of receipts) {
    const actor = entry?.actor;
    const receipt = entry?.receipt;
    if (!actor || receipt?.resourceKey !== "actionPoints") continue;
    const operationId = [
      "commanded-attack-movement-loss",
      String(actor.uuid ?? actor.id ?? ""),
      commandOperationId
    ].join(":");
    await applyAttackActionPointMovementLoss(actor, receipt.amount, {
      actionKey: "commandedAttack",
      weaponActionKey: "commandedAttack",
      attackId: operationId,
      chanceOperationId: operationId,
      chainRef,
      requester: "weaponAttack",
      source: "commandedAttack"
    });
  }
}

async function validateCommandedAbilityAuthority({
  authorityContext = {},
  selections = [],
  sender = null
} = {}) {
  if (String(authorityContext?.kind ?? "") !== "abilityAction") return false;
  const sourceActor = await fromUuid(String(authorityContext?.actorUuid ?? ""));
  const sourceTokenDocument = await fromUuid(String(authorityContext?.sourceTokenUuid ?? ""));
  if (!sender?.active || !sourceActor || !sourceTokenDocument?.actor) return false;
  if (!sender.isGM && !sourceActor.testUserPermission?.(sender, "OWNER")) return false;
  if (sourceTokenDocument.actor.uuid !== sourceActor.uuid) return false;

  const abilityItem = sourceActor.items?.get(String(authorityContext?.abilityItemId ?? ""));
  if (!abilityItem || abilityItem.type !== "ability") return false;
  const abilityFunction = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .find(entry => entry.id === String(authorityContext?.abilityFunctionId ?? "")
      && entry.type === ABILITY_FUNCTION_TYPES.activeApplication);
  if (!abilityFunction) return false;
  if (
    !authorityContext?.abilityFunctionSignature
    || String(authorityContext.abilityFunctionSignature) !== JSON.stringify(abilityFunction)
  ) return false;
  const requestedActionIds = Array.isArray(authorityContext?.actionIds)
    ? authorityContext.actionIds.map(id => String(id ?? "").trim())
    : [];
  const legacyActionId = String(authorityContext?.actionId ?? "").trim();
  const actionIds = requestedActionIds.length
    ? requestedActionIds
    : Array(selections.length).fill(legacyActionId);
  if (actionIds.length !== selections.length || actionIds.some(id => !id)) return false;
  const actionsById = new Map((abilityFunction.actions ?? [])
    .map(action => [String(action?.id ?? "").trim(), action]));
  const actions = actionIds.map(id => actionsById.get(id) ?? null);
  if (actions.some(action => (
    !action
    || action.type !== ABILITY_ACTION_TYPES.weaponAttack
    || action.executorMode !== ABILITY_ACTION_EXECUTOR_MODES.targets
    || action.targetMode !== ABILITY_ACTION_TARGET_MODES.free
  ))) return false;

  const targetTokenUuids = Array.from(new Set((authorityContext?.targetTokenUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  const selectionTokenUuids = Array.from(new Set((selections ?? [])
    .map(selection => String(selection?.tokenUuid ?? "").trim())
    .filter(Boolean)));
  if (!targetTokenUuids.length || (selections ?? []).some(selection => !String(selection?.tokenUuid ?? "").trim())) {
    return false;
  }
  if (selectionTokenUuids.length !== targetTokenUuids.length) return false;
  if (targetTokenUuids.some(uuid => !selectionTokenUuids.includes(uuid))) return false;
  const requestedPairs = new Set((selections ?? []).map((selection, index) => (
    `${actionIds[index]}\u0000${String(selection?.tokenUuid ?? "").trim()}`
  )));
  if (requestedPairs.size !== selections.length) return false;
  for (const actionId of new Set(actionIds)) {
    for (const targetTokenUuid of targetTokenUuids) {
      if (!requestedPairs.has(`${actionId}\u0000${targetTokenUuid}`)) return false;
    }
  }

  const settings = normalizeActiveApplicationSettings(abilityFunction.activeSettings);
  if (settings.targetMode !== "others") return false;
  if (settings.targetSelectionMode !== "all") {
    const limit = Math.max(1, Math.floor(evaluateActorFormula(settings.targetLimit, sourceActor, {
      fallback: 1,
      minimum: 1,
      context: "commanded ability target limit"
    })));
    if (targetTokenUuids.length > limit) return false;
  }

  const targetTokenDocuments = await Promise.all(targetTokenUuids.map(uuid => fromUuid(uuid)));
  const attackTargetTokenUuids = Array.from(new Set((selections ?? [])
    .map(selection => String(selection?.targetUuid ?? "").trim())
    .filter(Boolean)));
  const attackTargetTokenDocuments = await Promise.all(attackTargetTokenUuids.map(uuid => fromUuid(uuid)));
  if (!isCommandedAttackSceneAuthority(
    game.user,
    [sourceTokenDocument, ...targetTokenDocuments, ...attackTargetTokenDocuments],
    { requirePlaceables: true }
  )) return false;
  if (
    !sender.isGM
    && [...targetTokenDocuments, ...attackTargetTokenDocuments]
      .some(document => !isAttackImpactTarget(document?.object))
  ) return false;
  const sourceSceneUuid = String(sourceTokenDocument.parent?.uuid ?? "");
  const seenActors = new Set();
  for (const targetTokenDocument of targetTokenDocuments) {
    const targetActor = targetTokenDocument?.actor;
    if (!targetActor || String(targetTokenDocument.parent?.uuid ?? "") !== sourceSceneUuid) return false;
    if (settings.excludeSelf && targetActor.uuid === sourceActor.uuid) return false;
    if (seenActors.has(targetActor.uuid)) return false;
    seenActors.add(targetActor.uuid);
    const relation = targetActor.uuid === sourceActor.uuid ? "ally" : getAuraRelation(sourceActor, targetActor);
    if (!new Set(settings.targetGroups ?? []).has(relation)) return false;

    const sourceToken = sourceTokenDocument.object ?? null;
    const targetToken = targetTokenDocument.object ?? null;
    const radiusFormula = String(settings.radiusFormula ?? "").trim();
    if (radiusFormula) {
      if (!sourceToken || !targetToken) return false;
      const radius = Math.max(0, evaluateActorFormula(radiusFormula, sourceActor, {
        fallback: 0,
        minimum: 0,
        context: "commanded ability radius"
      }));
      if (measureTokenDistanceMeters(sourceToken, targetToken) > radius) return false;
    }
    if (settings.wallsBlock && (!sourceToken || !targetToken || !hasAuraLineOfSight(sourceToken, targetToken))) {
      return false;
    }
  }

  const perceptionByExecutor = new Map();
  for (const [selectionIndex, selection] of (selections ?? []).entries()) {
    const action = actions[selectionIndex];
    const allowedActionKeys = new Set(action.attackActionKeys?.includes(ABILITY_ATTACK_ACTION_ALL)
      ? ABILITY_ATTACKING_WEAPON_ACTION_KEYS
      : action.attackActionKeys ?? []);
    const actionKey = String(selection?.actionKey ?? "");
    if (!allowedActionKeys.has(actionKey)) return false;
    const tokenDocument = targetTokenDocuments.find(document => document?.uuid === String(selection?.tokenUuid ?? ""));
    const weapon = await fromUuid(String(selection?.weaponUuid ?? ""));
    if (!tokenDocument?.actor || weapon?.parent?.uuid !== tokenDocument.actor.uuid) return false;
    if (!validateCommandedAttackSelectionMode(selection, weapon)) return false;
    let targetTokenUuidAllowlist = perceptionByExecutor.get(tokenDocument.uuid);
    if (!targetTokenUuidAllowlist) {
      targetTokenUuidAllowlist = getAuthoritativeAttackPerceptionUuids(tokenDocument.object);
      perceptionByExecutor.set(tokenDocument.uuid, targetTokenUuidAllowlist);
    }
    if (!(await validateCommandedAttackSelectionGeometry(selection, tokenDocument.object, weapon, {
      targetTokenUuidAllowlist
    }))) return false;
    let expectedActionPointCost = 0;
    if (isActorInActiveCombat(tokenDocument.actor)) {
      if (action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.fixed) {
        expectedActionPointCost = Math.max(0, toInteger(action.fixedActionPointCost));
      } else if (action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.actual) {
        const actual = getWeaponActionPointCost(
          tokenDocument.actor,
          weapon,
          actionKey,
          String(selection?.weaponFunctionId || ITEM_FUNCTIONS.weapon)
        );
        expectedActionPointCost = Math.max(0, Math.ceil(
          actual * Math.max(0, Number(action.actualActionPointCostPercent) || 0) / 100
        ));
      }
    }
    if (Math.max(0, toInteger(selection?.actionPointCost)) !== expectedActionPointCost) return false;
  }
  return true;
}

function validateCommandedAttackSelectionMode(selection = {}, weapon = null) {
  const actionKey = String(selection?.actionKey ?? "");
  const mode = String(selection?.mode ?? "current");
  const targetUuid = String(selection?.targetUuid ?? "");
  if (actionKey === "aimedShot") {
    return mode === "aimed" && Boolean(targetUuid) && Boolean(String(selection?.selectedLimbKey ?? ""));
  }
  if (MELEE_ACTION_KEYS.has(actionKey)) {
    const directions = getEnabledMeleeDirections(
      weapon,
      actionKey,
      String(selection?.weaponFunctionId || ITEM_FUNCTIONS.weapon)
    );
    if (actionKey === "meleeAttack" && mode === UNAIMED_ATTACK_MODE) {
      return directions.length > 0
        && !targetUuid
        && !String(selection?.selectedLimbKey ?? "")
        && !String(selection?.directionKey ?? "");
    }
    return mode === "directed"
      && Boolean(targetUuid)
      && directions.some(direction => direction.key === String(selection?.directionKey ?? ""))
      && (actionKey !== "aimedMeleeAttack" || Boolean(String(selection?.selectedLimbKey ?? "")));
  }
  if (actionKey === PUSH_ACTION_KEY) {
    return mode === "push" && Math.max(1, toInteger(selection?.selectedStrength) || 1) > 0;
  }
  return mode === "current" && !targetUuid;
}

async function validateCommandedAttackSelectionGeometry(selection = {}, token = null, weapon = null, {
  targetTokenUuidAllowlist = null,
  attackId = "",
  controller: suppliedController = null
} = {}) {
  if (!token?.actor || !weapon) return false;
  if (!isFiniteCommandedPoint(selection?.pointer)) return false;
  const submittedGeometry = deserializeGeometry(selection?.lockedGeometry ?? selection?.geometry);
  if (!submittedGeometry || !isFiniteCommandedPoint(submittedGeometry.origin) || !isFiniteCommandedPoint(submittedGeometry.end)) {
    return false;
  }

  const actionKey = String(selection?.actionKey ?? "");
  const weaponFunctionId = String(selection?.weaponFunctionId || ITEM_FUNCTIONS.weapon);
  const controller = suppliedController ?? new WeaponAttackController(
    token,
    weapon,
    actionKey,
    weaponFunctionId,
    null,
    {
      skipActionPointCost: true,
      ignoreReactionLock: true,
      targetTokenUuidAllowlist,
      attackId,
      headlessExecution: Boolean(attackId),
      ownsAttackAutoCoverLifecycle: false
    }
  );
  const ownsController = !suppliedController;
  try {
    controller.pointer = deserializePoint(selection.pointer);
    if (!controller.rebuildGeometryAndTargets()) return false;
    if (!isSameGeometry(controller.geometry, submittedGeometry)) return false;
    if (
      Math.abs(
        (Number(controller.geometry?.rangeBonusMeters) || 0)
        - (Number(submittedGeometry.rangeBonusMeters) || 0)
      ) > PREVIEW_POSITION_EPSILON
    ) return false;

    const targetDocument = selection?.targetUuid
      ? await fromUuid(String(selection.targetUuid))
      : null;
    const selectedTarget = targetDocument?.object ?? null;
    if (selection?.targetUuid) {
      if (!selectedTarget?.actor || targetDocument.parent?.uuid !== token.document?.parent?.uuid) return false;
      if (!controller.targets.includes(selectedTarget)) return false;
    }

    if (actionKey === "aimedShot") {
      return controller.isAimedTargetInEffectiveRange(selectedTarget)
        && Boolean(resolveAimedTargetSelection(selectedTarget?.actor, String(selection?.selectedLimbKey ?? "")));
    }
    if (MELEE_ACTION_KEYS.has(actionKey)) {
      if (
        actionKey === "aimedMeleeAttack"
        && !resolveAimedTargetSelection(selectedTarget?.actor, String(selection?.selectedLimbKey ?? ""))
      ) return false;
      return true;
    }
    if (actionKey === PUSH_ACTION_KEY) {
      const maximumStrength = getKnockbackMaximumStrength(controller.getPushDifficulty());
      const selectedStrength = Math.max(1, toInteger(selection?.selectedStrength) || 1);
      return controller.targets.length > 0 && selectedStrength <= maximumStrength;
    }
    return true;
  } finally {
    if (ownsController) {
      controller.clearBurstTargetPreviewTimer();
      controller.container.destroy({ children: true });
    }
  }
}

function isFiniteCommandedPoint(point = null) {
  return Boolean(point)
    && Number.isFinite(Number(point.x))
    && Number.isFinite(Number(point.y))
    && (point.elevation === undefined || Number.isFinite(Number(point.elevation)));
}

function validateDualWeaponAttackResources(actor, selections = [], label = "С двух рук") {
  if (!actor || selections.length !== 2) return false;
  for (const selection of selections) {
    const weapon = selection?.weapon ?? null;
    const actionKey = String(selection?.actionKey ?? "");
    const weaponFunctionId = String(selection?.weaponFunctionId || ITEM_FUNCTIONS.weapon);
    if (!weapon || !isAttackSource(weapon, weaponFunctionId)) return false;
    if (!getWeaponAttackData(weapon, weaponFunctionId)?.enabled) return false;
    if (!hasWeaponAction(weapon, actionKey, weaponFunctionId)) return false;
    if (isWeaponActionBlocked(actor, actionKey)) {
      ui.notifications.warn(`${label}: действие ${actionKey} заблокировано.`);
      return false;
    }
    if (isWeaponPlacementDisabled(actor, weapon)) return false;
    const attackCount = getActionAttackCount(weapon, actionKey, weaponFunctionId);
    if (!hasRequiredWeaponResources(weapon, attackCount, weaponFunctionId)) return false;
  }
  return true;
}

async function executeCapturedWeaponAttack(selection = {}, {
  skipActionPointCost = true,
  skipBaseWeaponResourceCosts = false,
  attackModifier = null,
  abilityTrialSession = null,
  reportedActionPointCost = null,
  reactionCoordinator = null,
  chainRef = null,
  deferWeaponNoiseDetection = false,
  returnWeaponNoiseMetadata = false,
  targetTokenUuidAllowlist = null,
  suppressAttackPreviewBroadcast = false,
  headlessExecution = false,
  attackId = "",
  chatMessageAuthorId = "",
  autoCoverAttackId = "",
  controller: suppliedController = null,
  returnAuthorityMetadata = false
} = {}) {
  const token = selection?.token ?? null;
  const weapon = selection?.weapon ?? null;
  const actionKey = String(selection?.actionKey ?? "");
  const weaponFunctionId = String(selection?.weaponFunctionId || ITEM_FUNCTIONS.weapon);
  if (!token?.actor || !weapon || !actionKey) return false;

  const controller = suppliedController ?? new WeaponAttackController(token, weapon, actionKey, weaponFunctionId, attackModifier, {
    skipActionPointCost,
    skipBaseWeaponResourceCosts,
    reportedActionPointCost,
    reactionCoordinator,
    chainRef,
    abilityTrialSession,
    deferWeaponNoiseDetection,
    targetTokenUuidAllowlist,
    suppressAttackPreviewBroadcast,
    headlessExecution,
    attackId,
    chatMessageAuthorId,
    autoCoverAttackId,
    ownsAttackAutoCoverLifecycle: !headlessExecution,
    finishAfterAttack: true
  });
  const ownsController = !suppliedController;
  controller.pointer = deserializePoint(selection.pointer);
  if (ownsController) controller.geometry = deserializeGeometry(selection.geometry);
  controller.lockedGeometry = ownsController
    ? (selection.lockedGeometry ?? serializeGeometry(controller.geometry))
    : serializeGeometry(controller.geometry);
  controller.selectedLimbKey = String(selection.selectedLimbKey ?? "");

  const targetDocument = selection.targetUuid ? await fromUuid(selection.targetUuid) : null;
  const selectedTarget = targetDocument?.object ?? targetDocument ?? null;
  try {
    if (selection.mode === UNAIMED_ATTACK_MODE) {
      if (ownsController) controller.refresh(true);
      await controller.syncAttackAutoCoverForExecution();
      controller.reuseValidatedGeometryOnce = !ownsController;
      await controller.performUnaimedMeleeAttack();
      return getCapturedWeaponAttackResult(controller, {
        includeWeaponNoiseMetadata: returnWeaponNoiseMetadata,
        includeAuthorityMetadata: returnAuthorityMetadata
      });
    }
    if (selection.mode === "aimed") {
      controller.selectedTarget = selectedTarget;
      controller.aimedMode = "limb";
      if (ownsController) controller.refresh(true);
      await controller.syncAttackAutoCoverForExecution();
      controller.reuseValidatedGeometryOnce = !ownsController;
      await controller.performAimedAttack(selection.selectedLimbKey);
      return getCapturedWeaponAttackResult(controller, {
        includeWeaponNoiseMetadata: returnWeaponNoiseMetadata,
        includeAuthorityMetadata: returnAuthorityMetadata
      });
    }
    if (selection.mode === "directed") {
      controller.selectedTarget = selectedTarget;
      controller.aimedMode = "direction";
      if (ownsController) controller.refresh(true);
      await controller.syncAttackAutoCoverForExecution();
      controller.reuseValidatedGeometryOnce = !ownsController;
      await controller.performDirectedAttack(selection.directionKey);
      return getCapturedWeaponAttackResult(controller, {
        includeWeaponNoiseMetadata: returnWeaponNoiseMetadata,
        includeAuthorityMetadata: returnAuthorityMetadata
      });
    }
    if (selection.mode === "push") {
      if (ownsController) controller.refresh(true);
      await controller.syncAttackAutoCoverForExecution();
      controller.reuseValidatedGeometryOnce = !ownsController;
      await controller.performPushAttack(selection.selectedStrength);
      return getCapturedWeaponAttackResult(controller, {
        includeWeaponNoiseMetadata: returnWeaponNoiseMetadata,
        includeAuthorityMetadata: returnAuthorityMetadata
      });
    }
    if (
      controller.targetedAction
      && !controller.requiresLimbSelection
      && !controller.requiresDirectionSelection
    ) {
      controller.selectedTarget = selectedTarget;
      controller.targetedAction = false;
    }
    if (ownsController) controller.refresh(true);
    await controller.syncAttackAutoCoverForExecution();
    controller.reuseValidatedGeometryOnce = !ownsController;
    await controller.performCurrentAttack();
    return getCapturedWeaponAttackResult(controller, {
      includeWeaponNoiseMetadata: returnWeaponNoiseMetadata,
      includeAuthorityMetadata: returnAuthorityMetadata
    });
  } finally {
    if (ownsController) controller.destroy();
  }
}

function didCapturedWeaponAttackExecute(controller = null) {
  return Boolean(controller?.lastResolvedAttackOutcome) || Number(controller?.attackCheckCount) > 0;
}

function getCapturedWeaponAttackResult(controller = null, {
  includeWeaponNoiseMetadata = false,
  includeAuthorityMetadata = false
} = {}) {
  const executed = didCapturedWeaponAttackExecute(controller) || Boolean(controller?.weaponNoiseAttempted);
  if (!includeWeaponNoiseMetadata && !includeAuthorityMetadata) return executed;
  const result = {
    executed,
    ...(includeWeaponNoiseMetadata ? {
      weaponNoiseAttempted: Boolean(controller?.weaponNoiseAttempted),
      noiseLevel: getWeaponNoiseLevel({ noiseLevel: controller?.weaponNoiseLevel })
    } : {}),
    ...(includeAuthorityMetadata ? {
      attackCheckCount: Math.max(0, toInteger(controller?.attackCheckCount)),
      canceledByReaction: Boolean(controller?.attackCanceledByReaction),
      selectionCommitted: Boolean(
        controller?.attackCommitted
        || controller?.attackCanceledByReaction
        || controller?.attackCheckCount > 0
        || controller?.weaponNoiseAttempted
      ),
      shouldFinish: Boolean(controller?.authorityShouldFinish)
    } : {})
  };
  return result;
}

export async function executeWeaponAttackAgainstToken({
  attackerToken = null,
  targetToken = null,
  weapon = null,
  actionKey = "",
  weaponFunctionId = "",
  attackModifier = null,
  chainRef = null,
  damageHubOperationRef = "",
  onBeforeExecute = null,
  abilityTrialSession = null,
  chanceOperationId = "",
  selectedLimbKey = "",
  skipActionPointCost = false,
  skipBaseWeaponResourceCosts = false,
  additionalActorResourceCosts = [],
  requireResourceCommit = false,
  strictTargetResolution = false,
  ignoreReactionLock = false,
  suspendActiveAttack = false,
  suppressGenericEventReactions = false
} = {}) {
  if (!ignoreReactionLock && isReactionSystemLocked()) return false;
  if (!attackerToken?.actor || !targetToken?.actor || !weapon || !isAttackSource(weapon, weaponFunctionId)) return false;
  if (isActorUnableToAct(attackerToken.actor)) return false;
  if (!getWeaponAttackData(weapon, weaponFunctionId)?.enabled) return false;
  if (!hasWeaponAction(weapon, actionKey, weaponFunctionId)) return false;
  if (isWeaponActionBlocked(attackerToken.actor, actionKey)) return false;
  if (isWeaponPlacementDisabled(attackerToken.actor, weapon)) return false;
  const suspendedAttack = suspendActiveAttack
    ? suspendWeaponAttackForNestedSelection()
    : null;
  if (!suspendedAttack && activeAttack && !cancelWeaponAttack({ ignoreReactionLock })) {
    return false;
  }
  const controller = new WeaponAttackController(attackerToken, weapon, actionKey, weaponFunctionId, attackModifier, {
    chainRef,
    damageHubOperationRef,
    onBeforeExecute,
    abilityTrialSession,
    chanceOperationId,
    skipActionPointCost,
    skipBaseWeaponResourceCosts,
    additionalActorResourceCosts,
    ignoreReactionLock,
    finishAfterAttack: true,
    suppressGenericEventReactions
  });
  if (!controller.hasRequiredWeaponResources(getActionAttackCount(weapon, actionKey, weaponFunctionId))) {
    restoreWeaponAttackAfterNestedSelection(suspendedAttack);
    return false;
  }
  try {
    activeAttack = controller;
    let executed = false;
    if (strictTargetResolution) {
      executed = await controller.executeStrictlyAgainstToken(targetToken, { selectedLimbKey });
    } else {
      controller.attachPreview();
      executed = await controller.executeAgainstToken(targetToken);
    }
    return Boolean(executed && (!requireResourceCommit || controller.attackCostsCommitted));
  } finally {
    if (activeAttack === controller) activeAttack = null;
    controller.destroy();
    restoreWeaponAttackAfterNestedSelection(suspendedAttack);
  }
}

/** Collect tokens the given weapon action can currently attack from attackerToken. */
export function collectValidWeaponAttackTargets({
  attackerToken = null,
  weapon = null,
  actionKey = "",
  weaponFunctionId = "",
  targetToken = null,
  stopOnFirst = false
} = {}) {
  if (!attackerToken?.actor || !weapon || !actionKey) return [];
  if (!isAttackSource(weapon, weaponFunctionId)) return [];
  if (!hasWeaponAction(weapon, actionKey, weaponFunctionId)) return [];
  const controller = new WeaponAttackController(attackerToken, weapon, actionKey, weaponFunctionId, null, {
    skipActionPointCost: true,
    ignoreReactionLock: true
  });
  try {
    const candidates = targetToken
      ? [targetToken]
      : (canvas.tokens?.placeables ?? []);
    const results = [];
    for (const token of candidates) {
      if (!token?.actor || token === attackerToken) continue;
      if (!controller.evaluateReachAgainstToken(token)) continue;
      results.push(token);
      if (stopOnFirst) break;
    }
    return results;
  } finally {
    controller.destroy();
  }
}

export function canWeaponAttackReachToken({
  attackerToken = null,
  weapon = null,
  actionKey = "",
  weaponFunctionId = "",
  targetToken = null
} = {}) {
  return collectValidWeaponAttackTargets({
    attackerToken,
    weapon,
    actionKey,
    weaponFunctionId,
    targetToken,
    stopOnFirst: true
  }).length > 0;
}

function isSameAttackToken(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftUuid = String(left.document?.uuid ?? left.uuid ?? "");
  const rightUuid = String(right.document?.uuid ?? right.uuid ?? "");
  if (leftUuid && rightUuid && leftUuid === rightUuid) return true;
  const leftId = String(left.id ?? left.document?.id ?? "");
  const rightId = String(right.id ?? right.document?.id ?? "");
  return Boolean(leftId && rightId && leftId === rightId);
}

function isAimedAttackGeometryTargetReachable({
  attackerToken = null,
  targetToken = null,
  weapon = null,
  actionKey = "aimedShot",
  weaponFunctionId = "",
  rangeProfile = null
} = {}) {
  const attacker = attackerToken?.object ?? attackerToken;
  const target = targetToken?.object ?? targetToken;
  if (!attacker?.actor || !target?.actor || !weapon || !isAttackTargetVisible(target, null, attacker)) return false;
  const origin = getTokenAimPoint(attacker);
  const targetPoint = getTokenAimPoint(target);
  const geometry = getAttackGeometry(
    weapon,
    actionKey,
    attacker,
    origin,
    targetPoint,
    weaponFunctionId,
    rangeProfile
  );
  if (!geometry) return false;
  const aimPoint = selectTargetTrajectoryAimPoint(attacker, target, geometry);
  if (!aimPoint) return false;
  geometry.aimPoint = selectAttackGeometryAimPoint(attacker, target, geometry) ?? aimPoint;
  if (!getAimedElevationTargets(attacker, geometry, [target]).includes(target)) return false;
  return canTokenPhysicallySeeTarget(attacker, target);
}

export async function startConstrainedAimedAttackSelection({
  attackerToken = null,
  targetToken = null,
  weapon = null,
  weaponFunctionId = "",
  actionKey = "aimedShot",
  attackModifier = null,
  chainRef = null,
  damageHubOperationRef = "",
  onBeforeExecute = null,
  onProcessingStarted = null,
  additionalActorResourceCosts = [],
  requireResourceCommit = false,
  timeoutMs = 120000,
  suppressGenericEventReactions = false
} = {}) {
  const normalizedActionKey = ["aimedShot", "aimedMeleeAttack"].includes(actionKey) ? actionKey : "";
  if (!attackerToken?.actor || !targetToken?.actor || !weapon || isActorUnableToAct(attackerToken.actor)) return false;
  if (!normalizedActionKey || !isAttackSource(weapon, weaponFunctionId) || !hasWeaponAction(weapon, normalizedActionKey, weaponFunctionId)) return false;
  if (isWeaponActionBlocked(attackerToken.actor, normalizedActionKey)) return false;
  if (isWeaponPlacementDisabled(attackerToken.actor, weapon)) return false;
  const suspendedAttack = suspendWeaponAttackForNestedSelection();

  return new Promise(resolve => {
    let completed = false;
    let timeoutId = null;
    const finish = value => {
      if (completed) return;
      completed = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      Promise.resolve().then(() => {
        if (!activeAttack || activeAttack === controller) {
          if (activeAttack === controller) activeAttack = null;
          restoreWeaponAttackAfterNestedSelection(suspendedAttack);
        }
        resolve(Boolean(value));
      });
    };
    const controller = new WeaponAttackController(attackerToken, weapon, normalizedActionKey, weaponFunctionId, attackModifier, {
      chainRef,
      damageHubOperationRef,
      onBeforeExecute,
      onProcessingStarted: payload => {
        if (timeoutId) window.clearTimeout(timeoutId);
        timeoutId = null;
        onProcessingStarted?.(payload);
      },
      onDestroy: ({ controller: destroyed }) => finish(
        (
          Boolean(destroyed?.lastResolvedAttackOutcome)
          || destroyed?.attackCheckCount > 0
        ) && (!requireResourceCommit || destroyed?.attackCostsCommitted)
      ),
      finishAfterAttack: true,
      constrainedTarget: true,
      skipActionPointCost: true,
      additionalActorResourceCosts,
      ignoreReactionLock: true,
      suppressGenericEventReactions
    });
    if (!controller.hasRequiredWeaponResources(getActionAttackCount(weapon, normalizedActionKey, weaponFunctionId))) {
      finish(false);
      return;
    }

    controller.pointer = getTokenAimPoint(targetToken);
    controller.refresh(true);
    if (
      !controller.geometry
      || !controller.targets.includes(targetToken)
      || !controller.isAimedTargetInEffectiveRange(targetToken)
    ) {
      controller.destroy();
      finish(false);
      return;
    }
    controller.selectedTarget = targetToken;
    controller.lockedGeometry = serializeGeometry(controller.geometry);
    controller.selectedLimbKey = "";
    controller.aimedMode = "limb";
    if (!controller.prepareAimedLimbRows(targetToken).length) {
      controller.destroy();
      finish(false);
      return;
    }
    activeAttack = controller;
    controller.activate();
    controller.refresh(true);
    controller.refreshAimedLimbMenu();
    timeoutId = window.setTimeout(() => {
      if (activeAttack === controller) activeAttack = null;
      controller.destroy();
      finish(false);
    }, Math.max(1000, Math.trunc(Number(timeoutMs) || 120000)));
  });
}

export function startForcedAimedAttackSelection({
  label = "Контр-снайпер",
  resultPolicy = null,
  suppressGuardianAngelReaction = true,
  ...options
} = {}) {
  return startConstrainedAimedAttackSelection({
    ...options,
    attackModifier: createCounterSniperAttackModifier({
      label,
      resultPolicy,
      suppressGuardianAngelReaction
    })
  });
}

export function canPerformAimedAttackAgainstToken({
  attackerToken = null,
  targetToken = null,
  weapon = null,
  weaponFunctionId = "",
  actionKey = "aimedShot"
} = {}) {
  const normalizedActionKey = ["aimedShot", "aimedMeleeAttack"].includes(actionKey) ? actionKey : "";
  const attacker = attackerToken?.object ?? attackerToken;
  const target = targetToken?.object ?? targetToken;
  if (!attacker?.actor || !target?.actor || !weapon || isActorUnableToAct(attacker.actor)) return false;
  if (!normalizedActionKey || !isAttackSource(weapon, weaponFunctionId) || !hasWeaponAction(weapon, normalizedActionKey, weaponFunctionId)) return false;
  if (
    isWeaponActionBlocked(attacker.actor, normalizedActionKey)
    || isWeaponPlacementDisabled(attacker.actor, weapon)
  ) return false;
  if (getMissingWeaponResourceCost(weapon, getActionAttackCount(weapon, normalizedActionKey, weaponFunctionId), weaponFunctionId)) return false;
  const aimedRangeState = normalizedActionKey === "aimedShot"
    ? getAimedTargetRangeSelectionState({
      weapon,
      actionKey: normalizedActionKey,
      attackerToken: attacker,
      targetToken: target,
      weaponFunctionId,
      context: { aimed: true, targeting: { aimed: true } }
    })
    : null;
  if (aimedRangeState?.allowed === false) return false;
  return isAimedAttackGeometryTargetReachable({
    attackerToken: attacker,
    targetToken: target,
    weapon,
    actionKey: normalizedActionKey,
    weaponFunctionId,
    rangeProfile: aimedRangeState?.rangeProfile
  });
}

export function getDelayedVolleyWeaponState(weapon = null, weaponFunctionId = "") {
  const flag = weapon?.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_FLAG) ?? {};
  const delaySeconds = weapon && isAttackSource(weapon, weaponFunctionId)
    ? getVolleyExplosionDelaySeconds(weapon, weaponFunctionId)
    : 0;
  const id = String(flag.id ?? "").trim();
  return {
    configured: delaySeconds > 0,
    armed: Boolean(id),
    id,
    delaySeconds,
    explodeAtWorldTime: Number(flag.explodeAtWorldTime) || 0
  };
}

export function canArmDelayedVolleyWeapon(weapon = null, weaponFunctionId = "") {
  const state = getDelayedVolleyWeaponState(weapon, weaponFunctionId);
  return state.configured && !state.armed;
}

export async function armDelayedVolleyWeapon({ token = null, weapon = null, weaponFunctionId = "" } = {}) {
  if (!token?.actor || !weapon?.isOwner || !canArmDelayedVolleyWeapon(weapon, weaponFunctionId)) return false;
  return weaponResourceActorLock.run(token.actor, null, async () => {
    weapon = token.actor.items?.get?.(weapon.id);
    if (!weapon || !canArmDelayedVolleyWeapon(weapon, weaponFunctionId)) return false;
    const delaySeconds = getVolleyExplosionDelaySeconds(weapon, weaponFunctionId);
    const center = getTokenAimPoint(token);
    const sceneId = token.document?.parent?.id ?? canvas.scene?.id ?? "";
    if (!center || !sceneId) return false;

    const delayedThrownItemId = foundry.utils.randomID();
    const explodeAtWorldTime = (Number(game.time?.worldTime) || 0) + delaySeconds;
    const geometry = {
      type: VOLLEY_ACTION_KEY,
      origin: serializePoint(center),
      end: serializePoint(center),
      angle: 0,
      distance: 1,
      halfAngle: 0,
      radiusPixels: metersToPixels(getVolleyDamageRadius(weapon, weaponFunctionId)),
      shapePoints: []
    };
    const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
    const rangeProfile = getWeaponRangeProfile(weapon, VOLLEY_ACTION_KEY, token, weaponFunctionId, {
      attackDistanceMeters: 0,
      weaponAttackId: delayedThrownItemId,
      chanceOperationId: delayedThrownItemId,
      weaponData
    });
    const damageContext = {
      actor: token.actor,
      actorToken: token,
      token,
      actionKey: VOLLEY_ACTION_KEY,
      weaponActionKey: VOLLEY_ACTION_KEY,
      weaponData,
      weaponFunctionId,
      attackDistanceMeters: 0,
      effectiveRange: rangeProfile.effectiveRange
    };
    const baseDamage = getWeaponDamage(weapon, weaponFunctionId);
    const regionRequest = buildDelayedVolleyExplosionRegionRequest({
      sceneId,
      delayedThrownItemId,
      attackId: delayedThrownItemId,
      explodeAtWorldTime,
      weapon,
      weaponFunctionId,
      actionKey: VOLLEY_ACTION_KEY,
      attackerToken: token,
      finalGeometries: [geometry],
      blastOutcomes: [{
        attackDistanceMeters: damageContext.attackDistanceMeters,
        effectiveRange: damageContext.effectiveRange,
        baseDamage
      }],
      baseDamage,
      damageContext,
      attachmentTokenId: token.id
    });
    const region = await requestCreateDelayedVolleyExplosionRegion(regionRequest);
    if (!region) {
      await rollbackDelayedThrownItemWorldDocuments(delayedThrownItemId);
      return false;
    }
    try {
      await executeInventoryMutation({
        actor: token.actor,
        updates: [{
          _id: weapon.id,
          [`flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_FLAG}`]: {
            id: delayedThrownItemId,
            explodeAtWorldTime
          }
        }]
      }, { reason: "arm-delayed-volley-weapon" });
      const armedId = String(
        token.actor.items?.get?.(weapon.id)?.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_FLAG)?.id ?? ""
      ).trim();
      if (armedId !== delayedThrownItemId) {
        throw new Error("Delayed volley Item marker was not committed.");
      }
    } catch (error) {
      await rollbackDelayedThrownItemWorldDocuments(delayedThrownItemId);
      throw error;
    }
    return true;
  });
}

export function buildWeaponExplosionDamageRequests({
  targetToken = null,
  center = null,
  radiusPixels = 0,
  baseDamage = 0,
  pelletCount = 1,
  concentratedPelletImpact = false,
  damageTypes = [],
  penetrationPower = 0,
  source = {},
  damageModifier = null
} = {}) {
  const __codexRequestProbe = captureDamageRequestProbe(); // codex-runtime-debug H21
  const actor = targetToken?.actor;
  if (!actor || !center) return [];
  const falloff = Number(radiusPixels) > 0
    ? getVolleyDamageFalloff(targetToken, { end: center, radiusPixels })
    : 1;
  const falloffDamage = Math.round(Math.max(0, Number(baseDamage) || 0) * falloff);
  const damageAmount = Math.max(0, Math.round(Number(
    typeof damageModifier === "function" ? damageModifier(falloffDamage, { falloff }) : falloffDamage
  ) || 0));
  const pelletDamages = distributeIntegerAmount(damageAmount, Array(Math.max(1, toInteger(pelletCount))).fill(1));
  const normalizedTypes = normalizeExplosionDamageTypes(damageTypes);
  const requests = [];
  const concentratedLimbKey = concentratedPelletImpact
    ? selectRandomLimbKey(actor)
    : "";

  for (let pelletIndex = 0; pelletIndex < pelletDamages.length; pelletIndex += 1) {
    const pelletDamage = pelletDamages[pelletIndex] ?? 0;
    if (pelletDamage <= 0) continue;
    const limbKey = concentratedPelletImpact
      ? concentratedLimbKey
      : selectRandomLimbKey(actor);
    if (!limbKey) continue;
    const conditionWearPacketId = foundry.utils.randomID();
    const typeAmounts = distributeIntegerAmount(pelletDamage, normalizedTypes.map(entry => entry.weight));
    for (let typeIndex = 0; typeIndex < normalizedTypes.length; typeIndex += 1) {
      const amount = typeAmounts[typeIndex] ?? 0;
      if (amount <= 0) continue;
      requests.push({
        actor,
        limbKey,
        amount,
        damageTypeKey: normalizedTypes[typeIndex].key,
        scope: "healthAndLimb",
        source: {
          ...source,
          targetTokenUuid: source.targetTokenUuid ?? targetToken?.document?.uuid ?? targetToken?.uuid ?? "",
          penetrationPower,
          pelletIndex,
          damagePacketId: conditionWearPacketId,
          conditionWearPacketId,
          ...(concentratedPelletImpact ? {
            pelletImpactCount: pelletDamages.length,
            pelletImpactIndex: pelletIndex
          } : {})
        }
      });
    }
  }
  // #region codex-runtime-debug H21 one numeric summary per generated target impact
  recordDamageRequestProbe(__codexRequestProbe, "weapon.explosionDamageRequests", requests, {
    configuredPellets: pelletDamages.length, configuredDamageTypes: normalizedTypes.length
  });
  // #endregion codex-runtime-debug
  return requests;
}

export function isWeaponPlacementDisabled(actor, weapon) {
  if (!actor || !weapon) return false;
  const placement = weapon.system?.placement ?? {};
  if (placement.mode !== "weapon" || isContainerWeaponSetKey(placement.weaponSet)) return false;
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const requiredSlots = getRequiredWeaponSlotsForItem(race, weapon, placement.weaponSet, placement.weaponSlot);
  if (getWeaponSlotRequirement(weapon).selectedKeys.size && !requiredSlots.length) return true;
  return requiredSlots.some(slot => slot.limbKey && getLimbHealingCap(actor, slot.limbKey) <= 0);
}

export class WeaponAttackController {
  constructor(token, weapon, actionKey, weaponFunctionId = "", attackModifier = null, options = {}) {
    this.token = token;
    this.weapon = weapon;
    this.actionKey = actionKey;
    this.weaponFunctionId = weaponFunctionId || ITEM_FUNCTIONS.weapon;
    this.stealthAttack = isActorStealthed(this.token?.actor);
    this.attackId = String(options.attackId ?? "").trim() || foundry.utils.randomID();
    // One controller can execute several attacks while its preview stays open.
    // Keep the preview/session identity stable and rotate attackId per cycle.
    this.previewAttackId = this.attackId;
    this.chanceOperationId = String(options.chanceOperationId ?? "").trim() || this.attackId;
    this.rangeProfile = getWeaponRangeProfile(weapon, actionKey, token, this.weaponFunctionId, {
      weaponAttackId: this.attackId,
      chanceOperationId: this.chanceOperationId
    });
    this.rangeProfilesByTarget = new Map();
    this.attackModifier = normalizeWeaponAttackModifier(attackModifier);
    this.originOverride = normalizeAttackOriginOverride(options.originOverride);
    this.onBeforeExecute = typeof options.onBeforeExecute === "function" ? options.onBeforeExecute : null;
    this.onProcessingStarted = typeof options.onProcessingStarted === "function" ? options.onProcessingStarted : null;
    this.onDestroy = typeof options.onDestroy === "function" ? options.onDestroy : null;
    this.chainRef = options.chainRef ?? null;
    this.damageHubOperationRef = String(options.damageHubOperationRef ?? "").trim();
    this.abilityTrialSession = options.abilityTrialSession ?? null;
    this.skipActionPointCost = Boolean(options.skipActionPointCost);
    this.skipBaseWeaponResourceCosts = Boolean(options.skipBaseWeaponResourceCosts);
    this.additionalActorResourceCosts = normalizeAdditionalActorResourceCosts(options.additionalActorResourceCosts);
    this.reportedActionPointCost = options.reportedActionPointCost === null
      || options.reportedActionPointCost === undefined
      ? null
      : Math.max(0, toInteger(options.reportedActionPointCost));
    this.reportedActionPointCostApplied = options.reportedActionPointCostApplied === null
      || options.reportedActionPointCostApplied === undefined
      ? (this.reportedActionPointCost === null ? null : true)
      : Boolean(options.reportedActionPointCostApplied);
    this.actionPointSpendReceipt = null;
    this.ignoreReactionLock = Boolean(options.ignoreReactionLock);
    this.suppressGenericEventReactions = Boolean(options.suppressGenericEventReactions);
    this.captureOnly = Boolean(options.captureOnly);
    this.onCapture = typeof options.onCapture === "function" ? options.onCapture : null;
    this.useGmAuthority = Boolean(options.useGmAuthority);
    this.authorityExecutionSucceeded = false;
    this.authorityShouldFinish = false;
    this.fixedTargetTokenUuidAllowlist = options.targetTokenUuidAllowlist !== null
      && options.targetTokenUuidAllowlist !== undefined;
    this.targetTokenUuidAllowlist = normalizeTargetTokenUuidAllowlist(options.targetTokenUuidAllowlist);
    this.refreshInactiveAttackerPerception();
    this.suppressAttackPreviewBroadcast = Boolean(options.suppressAttackPreviewBroadcast);
    this.headlessExecution = Boolean(options.headlessExecution);
    this.reuseValidatedGeometryOnce = false;
    this.chatMessageAuthorId = String(options.chatMessageAuthorId ?? "").trim();
    this.autoCoverAttackId = String(options.autoCoverAttackId ?? "").trim() || this.previewAttackId;
    this.ownsAttackAutoCoverLifecycle = options.ownsAttackAutoCoverLifecycle !== false;
    this.reactionCoordinator = options.reactionCoordinator?.run ? options.reactionCoordinator : null;
    this.deferWeaponNoiseDetection = Boolean(options.deferWeaponNoiseDetection);
    this.finishAfterAttack = Boolean(options.finishAfterAttack);
    this.constrainedTarget = Boolean(options.constrainedTarget);
    this.interactiveControlReleased = false;
    this.beforeExecuteCompleted = false;
    this.container = new PIXI.Container();
    this.shape = new PIXI.Graphics();
    this.meleeDirectionPreview = new PIXI.Graphics();
    this.targetMarkers = new PIXI.Graphics();
    this.focusedTargetMarker = new PIXI.Graphics();
    this.container.addChild(this.shape, this.meleeDirectionPreview, this.targetMarkers, this.focusedTargetMarker);
    this.targets = [];
    this.geometry = null;
    this.pointer = null;
    this.processing = false;
    this.destroyed = false;
    this.finishRequested = false;
    this.previewSuppressed = false;
    this.previewFrameScheduler = createLatestFrameScheduler(() => {
      if (
        !this.processing
        && !this.destroyed
        && !this.isInteractionLocked()
        && this.pushStrengthMaximum <= 0
        && !(this.targetedAction && ["limb", "direction"].includes(this.aimedMode))
      ) this.refresh();
    });
    this.meleeAction = MELEE_ACTION_KEYS.has(actionKey);
    this.aimedShot = isAimedShotAction(weapon, actionKey, this.weaponFunctionId);
    this.ignoreAimedObstructions = this.aimedShot
      && (
        hasActorFixedAbilityFunction(this.token?.actor, ABILITY_FIXED_FUNCTION_KEYS.hawkEye)
        || hasActorFixedAbilityFunction(this.token?.actor, ABILITY_FIXED_FUNCTION_KEYS.hawkEyePiercing)
      );
    this.targetedAction = this.attackModifier?.targetedAction ?? (this.aimedShot || this.meleeAction);
    this.requiresLimbSelection = this.attackModifier?.requiresLimbSelection ?? (this.aimedShot || actionKey === "aimedMeleeAttack");
    this.requiresDirectionSelection = this.attackModifier?.requiresDirectionSelection ?? this.meleeAction;
    this.aimedMode = "aim";
    this.hoveredTarget = null;
    this.selectedTarget = null;
    this.trajectoryAimTarget = null;
    this.hoveredLimbKey = "";
    this.selectedLimbKey = "";
    this.lockedGeometry = null;
    this.pushStrengthMaximum = 0;
    this.limbMenu = null;
    this.aimedLimbMenuCache = null;
    this.chanceMenu = null;
    this.rightClickCancelCandidate = null;
    this.targetSelectionSession = null;
    this.targetSelectionOutcome = null;
    this.nestedTargetSelectionSuspended = false;
    this.interactiveHandlersAttached = false;
    this.previousViewContextMenu = null;
    this.autoCoverActorUuids = new Set();
    this.lastAutoCoverSignature = "";
    this.pendingCriticalFailureResourceCosts = [];
    this.weaponActionModifierState = null;
    this.lastPreviewBroadcastAt = 0;
    this.lastBroadcastPreviewState = null;
    this.lastTargetMarkerRenderState = null;
    this.attackCanceledByReaction = false;
    this.attackCommitted = false;
    this.attackCostsCommitted = false;
    this.criticalDamageUsed = false;
    this.lastResolvedAttackOutcome = null;
    this.attackCheckCount = 0;
    this.successfulAttackCheckCount = 0;
    this.attackCheckTargetActorUuids = new Set();
    this.successfulAttackTargetActorUuids = new Set();
    this.attackCheckEventSequence = 0;
    this.pendingTerminalAttackOutcomes = [];
    this.weaponNoisePreviewSourceId = `weapon-attack:${this.previewAttackId}`;
    this.weaponNoiseLevel = getWeaponNoiseLevel(getWeaponAttackData(this.weapon, this.weaponFunctionId));
    this.weaponNoiseAttempted = false;
    this.weaponNoiseDetectionResolved = false;
    this.skillCheckCollectors = new Set();
    this.reactionTargetKeys = new Set();
    this.attackedTargetActorUuids = new Set();
    this.attackedTargetTokenUuids = new Set();
    this.preExistingUnconsciousTargetActorUuids = new Set();
    this.dodgeExposure = createDodgeAttackExposureTracker();
    this.burstTargetPreview = createBurstTargetPreviewState();
    this.burstPreviewStabilizeTimeout = null;
    this.volleyAction = isVolleyAttackAction(this.weapon, this.actionKey, this.weaponFunctionId);
    this.events = {
      move: event => this.onMove(event),
      confirm: event => this.onConfirm(event),
      cancel: event => this.onCancel(event),
      pointerDown: event => this.onPointerDown(event),
      tick: () => this.onTick(),
      itemUpdate: (item, changes, options) => this.onItemUpdate(item, changes, options)
    };
  }

  activate() {
    if (this.destroyed) return false;
    this.attachPreview();
    this.syncWeaponNoisePreview();
    if (isWhirlwindAttackModifier(this.attackModifier)) this.pointer = getTokenAimPoint(this.token);
    if (!this.startTargetSelectionLifecycle()) return false;
    this.attachInteractiveHandlers();
    return true;
  }

  startTargetSelectionLifecycle({ supersede = true } = {}) {
    if (this.targetSelectionSession?.active) return true;
    if (!supersede && getActiveCanvasTargetSelectionSession()) return false;
    const session = startCanvasTargetSelectionSession({
      kind: "weaponAttack",
      controller: this,
      token: this.token,
      weapon: this.weapon,
      actionKey: this.actionKey
    }, {
      onCancel: outcome => this.cancelFromTargetSelectionLifecycle(outcome)
    });
    this.targetSelectionSession = session;
    if (session.finished || this.destroyed) {
      this.targetSelectionSession = null;
      return false;
    }
    liveWeaponAttackTargetControllers.add(this);
    return true;
  }

  handleTokenUnavailable(tokenOrDocument = null, { matchUuid = false } = {}) {
    if (this.destroyed || !tokenOrDocument) return false;
    const matches = candidate => tokenLifecycleMatches(candidate, tokenOrDocument, { matchUuid });
    if (matches(this.token)) {
      this.finishRequested = true;
      if (activeDualWeaponAttack && tokenLifecycleMatches(activeDualWeaponAttack.token, tokenOrDocument, { matchUuid })) {
        activeDualWeaponAttack.destroy();
        activeDualWeaponAttack = null;
      }
      if (!this.processing) {
        if (activeAttack === this) activeAttack = null;
        this.destroy();
      } else {
        this.suppressPreview();
      }
      return true;
    }

    const selectedRemoved = matches(this.selectedTarget);
    const hoveredRemoved = matches(this.hoveredTarget);
    const trajectoryRemoved = matches(this.trajectoryAimTarget);
    const targetRemoved = this.targets.some(matches);
    const burstState = this.burstTargetPreview;
    const burstTargetRemoved = Boolean(
      burstState?.targets?.some(matches)
      || burstState?.pendingTargets?.some(matches)
      || Array.from(burstState?.burstRanges?.keys?.() ?? []).some(matches)
      || Array.from(burstState?.pendingBurstRanges?.keys?.() ?? []).some(matches)
    );
    const removedUuid = getTokenDocumentUuid(tokenOrDocument);
    const trial = getSharedAbilityAttackTrialSession(this.abilityTrialSession);
    const trialTargetRemoved = Boolean(removedUuid && trial?.targetObjects?.delete?.(removedUuid));
    if (trialTargetRemoved && Array.isArray(trial.targetUuids)) {
      trial.targetUuids = trial.targetUuids.filter(uuid => uuid !== removedUuid);
    }
    if (!selectedRemoved && !hoveredRemoved && !trajectoryRemoved && !targetRemoved && !burstTargetRemoved && !trialTargetRemoved) {
      return false;
    }

    this.targets = this.targets.filter(target => !matches(target));
    if (hoveredRemoved) this.hoveredTarget = null;
    if (trajectoryRemoved) this.trajectoryAimTarget = null;
    if (selectedRemoved) {
      this.selectedTarget = null;
      this.aimedMode = "aim";
      this.hoveredLimbKey = "";
      this.selectedLimbKey = "";
      this.lockedGeometry = null;
      this.pushStrengthMaximum = 0;
      if (this.constrainedTarget) this.finishRequested = true;
    }
    if (removedUuid) {
      for (const cacheKey of this.rangeProfilesByTarget.keys()) {
        if (cacheKey.startsWith(`${removedUuid}:`)) this.rangeProfilesByTarget.delete(cacheKey);
      }
    }
    if (burstTargetRemoved || targetRemoved) this.resetBurstTargetPreview();
    this.removeLimbMenu();
    this.removeChanceMenu();
    this.shape.clear();
    this.meleeDirectionPreview.clear();
    this.clearTargetMarkers();
    this.lastBroadcastPreviewState = null;

    if (this.finishRequested && !this.processing) {
      if (activeAttack === this) activeAttack = null;
      this.destroy();
      return true;
    }
    if (!this.processing && !this.previewSuppressed) this.previewFrameScheduler.request();
    return true;
  }

  attachInteractiveHandlers() {
    if (this.interactiveHandlersAttached || this.destroyed) return false;
    this.interactiveHandlersAttached = true;
    canvas.stage.on("mousemove", this.events.move);
    document.addEventListener("pointerdown", this.events.pointerDown, { capture: true });
    canvas.app.ticker.add(this.events.tick);
    Hooks.on("updateItem", this.events.itemUpdate);
    const canvasView = canvas.app?.view ?? null;
    this.previousViewContextMenu = canvasView?.oncontextmenu ?? null;
    if (canvasView) canvasView.oncontextmenu = this.events.cancel;
    return true;
  }

  detachInteractiveHandlers() {
    if (!this.interactiveHandlersAttached) return false;
    this.interactiveHandlersAttached = false;
    canvas.stage.off("mousemove", this.events.move);
    document.removeEventListener("pointerdown", this.events.pointerDown, { capture: true });
    canvas.app?.ticker?.remove?.(this.events.tick);
    Hooks.off("updateItem", this.events.itemUpdate);
    const canvasView = canvas.app?.view ?? null;
    if (canvasView?.oncontextmenu === this.events.cancel) canvasView.oncontextmenu = this.previousViewContextMenu;
    this.previousViewContextMenu = null;
    return true;
  }

  suspendForNestedTargetSelection() {
    if (this.destroyed) return false;
    if (this.nestedTargetSelectionSuspended) return true;
    this.nestedTargetSelectionSuspended = true;
    this.finishTargetSelection({
      cancelled: false,
      reason: "nestedSelectionSuspended"
    });
    this.detachInteractiveHandlers();
    this.suppressPreview();
    return true;
  }

  resumeFromNestedTargetSelection() {
    if (!this.nestedTargetSelectionSuspended || this.destroyed || this.finishRequested) return false;
    if (this.processing) {
      this.nestedTargetSelectionSuspended = false;
      return true;
    }
    this.attachInteractiveHandlers();
    if (!this.startTargetSelectionLifecycle({ supersede: false })) {
      this.detachInteractiveHandlers();
      return false;
    }
    this.nestedTargetSelectionSuspended = false;
    this.resumePreview();
    return true;
  }

  cancelFromTargetSelectionLifecycle(outcome = {}) {
    this.targetSelectionSession = null;
    this.targetSelectionOutcome = {
      ...outcome,
      cancelled: true
    };
    if (activeAttack === this) activeAttack = null;
    activeDualWeaponAttack?.destroy();
    activeDualWeaponAttack = null;
    this.destroy();
  }

  attachPreview() {
    if (this.container.parent) return;
    this.container.eventMode = "none";
    getCombatVisualizationLayer().addChild(this.container);
  }

  async notifyAttackResolved({
    attempted = true,
    killedTargetUuids = [],
    damageResults = [],
    deferredImpactPending = false,
    deferNoiseDetection = false
  } = {}) {
    if (!attempted) return;
    const resolvedDamageResults = Array.isArray(damageResults) ? damageResults : [];
    const mechanicalSelectedTarget = isPhantomEntity(this.selectedTarget) ? null : this.selectedTarget;
    const impactConditionWear = this.skipBaseWeaponResourceCosts
      ? summarizeWeaponImpactDamageResults(resolvedDamageResults)
      : await applyWeaponImpactConditionWear(this.weapon, this.weaponFunctionId, resolvedDamageResults, {
        modifierState: this.getWeaponActionModifierState(),
        chainRef: this.chainRef
      });
    const actionPointCostApplied = this.reportedActionPointCostApplied ?? (
      !this.skipActionPointCost && isCombatActionPointSpendingActive(this.token?.actor)
    );
    const actionPointCost = this.reportedActionPointCost ?? (
      actionPointCostApplied
        ? getWeaponActionPointCost(this.token?.actor, this.weapon, this.actionKey, this.weaponFunctionId, {
          ...this.createWeaponAttackSkillCheckContext(this.selectedTarget),
          chanceOperationId: this.chanceOperationId
        })
        : 0
    );
    const outcome = {
      actor: this.token?.actor ?? null,
      actorToken: this.token,
      targetActor: mechanicalSelectedTarget?.actor ?? null,
      targetToken: mechanicalSelectedTarget,
      weaponData: getWeaponAttackData(this.weapon, this.weaponFunctionId),
      weaponActionKey: this.actionKey,
      requester: "weaponAttack",
      ...this.createWeaponAttackDistanceContext(this.selectedTarget),
      attackerUuid: this.token?.actor?.uuid ?? "",
      actorUuid: this.token?.actor?.uuid ?? "",
      tokenUuid: this.token?.document?.uuid ?? "",
      weaponUuid: this.weapon?.uuid ?? "",
      weaponName: String(this.weapon?.name ?? ""),
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      stealthAttack: Boolean(this.stealthAttack),
      attackId: this.attackId,
      selectedLimbKey: String(this.selectedLimbKey ?? ""),
      selectedTargetActorUuid: mechanicalSelectedTarget?.actor?.uuid ?? "",
      preExistingUnconsciousTargetActorUuids: Array.from(this.preExistingUnconsciousTargetActorUuids),
      actionPointSpendReceipt: this.actionPointSpendReceipt,
      actionPointCost,
      actionPointCostApplied,
      targetActorUuids: Array.from(this.attackedTargetActorUuids),
      targetTokenUuids: Array.from(this.attackedTargetTokenUuids),
      killedTargetUuids: Array.from(new Set((killedTargetUuids ?? []).map(uuid => String(uuid ?? "").trim()).filter(Boolean))),
      canceledByReaction: Boolean(this.attackCanceledByReaction),
      criticalDamageUsed: this.criticalDamageUsed,
      attackCheckCount: Math.max(0, toInteger(this.attackCheckCount)),
      ...this.getAttackCheckAggregateData(),
      damageResults: resolvedDamageResults,
      impactConditionWear,
      modifierState: this.getWeaponActionModifierState(),
      deferredImpactPending: Boolean(deferredImpactPending),
      reactionCoordinator: this.reactionCoordinator,
      chainRef: this.chainRef,
      damageHubOperationRef: this.damageHubOperationRef,
      senderUserId: game.user?.id ?? ""
    };
    this.lastResolvedAttackOutcome = outcome;
    await publishWeaponAttackResolved(outcome);
    if (!deferNoiseDetection) await this.finalizeWeaponNoiseDetection();
    (this.pendingTerminalAttackOutcomes ??= []).push(outcome);
    return outcome;
  }

  syncWeaponNoisePreview() {
    if (this.destroyed || this.processing || this.previewSuppressed) return false;
    this.weaponNoiseLevel = getWeaponNoiseLevel(getWeaponAttackData(this.weapon, this.weaponFunctionId));
    setWeaponNoisePreview(this.token, this.weaponNoisePreviewSourceId, this.weaponNoiseLevel);
    return true;
  }

  clearWeaponNoisePreview() {
    clearWeaponNoisePreview(
      this.token?.id ?? this.token?.document?.id ?? "",
      this.weaponNoisePreviewSourceId
    );
  }

  async finalizeWeaponNoiseDetection() {
    if (
      !this.weaponNoiseAttempted
      || this.weaponNoiseDetectionResolved
      || this.deferWeaponNoiseDetection
    ) return false;
    this.weaponNoiseDetectionResolved = true;
    if (this.getWeaponActionModifierState().getOption("preventStealthDetection")) return true;
    await resolveWeaponNoiseDetection(this.token, { noiseLevel: this.weaponNoiseLevel });
    return true;
  }

  async notifyAttackCheckResolved(outcome = null, completionCollector = null, { recordAggregate = true } = {}) {
    const notify = async () => {
      if (recordAggregate) this.recordAttackCheckOutcome(outcome);
      const checkOccurrenceId = `${this.attackId}:${++this.attackCheckEventSequence}`;
      const context = {
        actor: this.token?.actor ?? null,
        token: this.token,
        weapon: this.weapon,
        actionKey: this.actionKey,
        weaponFunctionId: this.weaponFunctionId,
        weaponAttackId: this.attackId,
        checkOccurrenceId,
        chainRef: this.chainRef,
        damageHubOperationRef: this.damageHubOperationRef,
        modifierState: this.getWeaponActionModifierState(),
        outcome
      };
      await emitWeaponAttackCheckResolved(context);
      Hooks.callAll(WEAPON_ATTACK_CHECK_RESOLVED_HOOK, {
        ...context,
        falloutMawSemanticMirror: true
      });
    };
    if (completionCollector?.afterTerminal?.(outcome, notify)) return true;
    await notify();
    return true;
  }

  createSkillCheckCollector(options = {}) {
    const collector = createSkillCheckBatchCollector({
      ...options,
      messageData: {
        ...(options?.messageData ?? {}),
        ...(this.chatMessageAuthorId ? { author: this.chatMessageAuthorId } : {})
      }
    });
    this.skillCheckCollectors.add(collector);
    collector.onSettled(() => this.skillCheckCollectors.delete(collector));
    return collector;
  }

  async abortSkillCheckCollectors() {
    const collectors = Array.from(this.skillCheckCollectors);
    if (!collectors.length) return;
    await Promise.allSettled(collectors.map(collector => collector.abort()));
  }

  createAllOrNothingAttackContext({ mode = "", index = 0, count = 1 } = {}) {
    return {
      weaponAttackId: this.attackId,
      weaponActionKey: this.actionKey,
      allOrNothingAttackMode: String(mode ?? ""),
      allOrNothingAttackIndex: Math.max(0, toInteger(index)),
      allOrNothingAttackCount: Math.max(1, toInteger(count))
    };
  }

  createWeaponAttackDistanceContext(targetToken = null, weaponData = null) {
    const resolvedWeaponData = weaponData ?? getWeaponAttackData(this.weapon, this.weaponFunctionId);
    const rangeProfile = targetToken
      ? this.getRangeProfileForTarget(targetToken, resolvedWeaponData)
      : this.rangeProfile;
    return normalizeAttackDistanceContext({
      attackDistanceMeters: targetToken ? getTokenDistanceMeters(this.token, targetToken) : null,
      effectiveRange: rangeProfile?.effectiveRange
    });
  }

  getRangeProfileForTarget(targetToken = null, weaponData = null) {
    if (!targetToken?.actor) return this.rangeProfile;
    const attackDistanceMeters = getTokenDistanceMeters(this.token, targetToken);
    return this.getRangeProfileForDistance(attackDistanceMeters, { targetToken, weaponData });
  }

  getRangeProfileForDistance(attackDistanceMeters = null, { targetToken = null, weaponData = null } = {}) {
    const normalizedDistance = Number(attackDistanceMeters);
    if (!Number.isFinite(normalizedDistance)) return this.rangeProfile;
    const targetKey = String(targetToken?.document?.uuid ?? targetToken?.uuid ?? targetToken?.id ?? "");
    const cacheKey = `${targetKey}:${normalizedDistance.toFixed(3)}`;
    if (this.rangeProfilesByTarget.has(cacheKey)) return this.rangeProfilesByTarget.get(cacheKey);
    const profile = getWeaponRangeProfile(
      this.weapon,
      this.actionKey,
      this.token,
      this.weaponFunctionId,
      {
        targetToken,
        targetActor: targetToken?.actor ?? null,
        weaponData: weaponData ?? getWeaponAttackData(this.weapon, this.weaponFunctionId),
        attackDistanceMeters: normalizedDistance,
        weaponAttackId: this.attackId,
        chanceOperationId: this.chanceOperationId,
        rangeConditionEffectiveRange: this.rangeProfile?.conditionEffectiveRange
      }
    );
    this.rangeProfilesByTarget.set(cacheKey, profile);
    return profile;
  }

  usesAimedRangeLimits() {
    return this.requiresLimbSelection && !this.meleeAction;
  }

  getAimedTargetRangeState(targetToken = null) {
    if (!this.usesAimedRangeLimits() || !targetToken?.actor) {
      return { allowed: true, resolved: false, side: "" };
    }
    const weaponData = getWeaponAttackData(this.weapon, this.weaponFunctionId);
    const rangeProfile = this.getRangeProfileForTarget(targetToken, weaponData);
    return getAimedTargetRangeSelectionState({
      weapon: this.weapon,
      actionKey: this.actionKey,
      attackerToken: this.token,
      targetToken,
      weaponFunctionId: this.weaponFunctionId,
      rangeProfile,
      context: {
        weaponData,
        attackModifier: this.attackModifier,
        weaponActionModifierState: this.getWeaponActionModifierState(),
        weaponAttackId: this.attackId,
        chanceOperationId: this.chanceOperationId,
        chainRef: this.chainRef,
        rangeConditionEffectiveRange: this.rangeProfile?.conditionEffectiveRange
      }
    });
  }

  isAimedTargetInEffectiveRange(targetToken = null) {
    return this.getAimedTargetRangeState(targetToken).allowed !== false;
  }

  createWeaponAttackReactionContext(targetToken = null) {
    const weaponData = getWeaponAttackData(this.weapon, this.weaponFunctionId);
    return {
      ...this.createWeaponAttackDistanceContext(targetToken, weaponData),
      weaponData: serializeWeaponContextData(weaponData)
    };
  }

  createWeaponAttackSkillCheckContext(targetToken = null, extra = {}) {
    const weaponData = getWeaponAttackData(this.weapon, this.weaponFunctionId);
    const modifierState = this.getWeaponActionModifierState();
    const postureEdge = getPostureAttackEdgeModifiers({
      attackerToken: this.token,
      targetToken,
      weapon: this.weapon,
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId
    });
    const perceptionEdge = getUnseenAttackEdgeModifiers(
      targetToken,
      this.targetTokenUuidAllowlist,
      this.token
    );
    return {
      actorToken: this.token,
      targetToken,
      ...this.createWeaponAttackDistanceContext(targetToken, weaponData),
      chainRef: this.chainRef,
      damageHubOperationRef: this.damageHubOperationRef,
      systemEventOperationId: this.attackId,
      weaponAttackId: this.attackId,
      ...(this.processing || this.attackCommitted ? { chanceOperationId: this.chanceOperationId } : {}),
      weaponActionKey: this.actionKey,
      stealthAttack: this.stealthAttack,
      weaponData,
      attackModifier: this.attackModifier,
      weaponActionModifierState: modifierState,
      resultPolicy: mergeSkillCheckResultPolicies(
        this.attackModifier?.resultPolicy,
        modifierState?.getOption("attackResultPolicy")
      ),
      suppressGuardianAngelReaction: Boolean(this.attackModifier?.suppressGuardianAngelReaction),
      suppressGenericEventReactions: this.suppressGenericEventReactions,
      ...mergeAttackEdgeModifiers(postureEdge, perceptionEdge),
      attackTargetVisible: targetToken ? !perceptionEdge.disadvantage : true,
      unaimedAttack: Boolean(perceptionEdge.disadvantage),
      ...extra
    };
  }

  createWeaponActionContext({ targetToken = undefined, geometry = this.geometry } = {}) {
    const resolvedTarget = targetToken === undefined
      ? (this.trajectoryAimTarget ?? getNearestAttackChanceTarget(
        this.token,
        geometry,
        this.targets,
        this.targetTokenUuidAllowlist
      ))
      : targetToken;
    if (resolvedTarget) return this.createWeaponAttackSkillCheckContext(resolvedTarget);
    const attackDistanceMeters = geometry ? getAttackGeometryDistanceMeters(geometry) : null;
    return this.createWeaponAttackSkillCheckContext(null, {
      attackDistanceMeters: Number.isFinite(attackDistanceMeters) ? attackDistanceMeters : null
    });
  }

  stampAttackDamageSources(requests = []) {
    const attackId = String(this.attackId ?? "").trim();
    const weaponDataSnapshot = foundry.utils.deepClone(getWeaponAttackData(this.weapon, this.weaponFunctionId) ?? {});
    const sourceRequests = (Array.isArray(requests) ? requests : [requests]).filter(Boolean).map(request => ({
      ...request,
      source: {
        ...(request?.source ?? {}),
        ...(attackId ? { attackId } : {}),
        weaponAttackDamage: true,
        attackerActorUuid: request?.source?.attackerActorUuid ?? this.token?.actor?.uuid ?? "",
        attackerTokenUuid: request?.source?.attackerTokenUuid ?? this.token?.document?.uuid ?? "",
        weaponUuid: request?.source?.weaponUuid ?? this.weapon?.uuid ?? "",
        actionKey: request?.source?.actionKey ?? this.actionKey,
        chainRef: request?.source?.chainRef ?? this.chainRef,
        damageHubOperationRef: request?.source?.damageHubOperationRef ?? this.damageHubOperationRef,
        systemEventOperationId: String(request?.source?.systemEventOperationId ?? attackId),
        weaponFunctionId: request?.source?.weaponFunctionId ?? this.weaponFunctionId,
        weaponData: foundry.utils.deepClone(request?.source?.weaponData ?? weaponDataSnapshot)
      }
    }));
    this.criticalDamageUsed ||= sourceRequests.some(request => (
      request?.source?.criticalSuccess === true
      || request?.source?.criticalDamageUsed === true
    ));
    return sourceRequests;
  }

  createWeaponActionModifierContext(extra = {}) {
    return {
      actor: this.token?.actor ?? null,
      actorToken: this.token,
      token: this.token,
      weapon: this.weapon,
      actionKey: this.actionKey,
      weaponActionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      weaponData: getWeaponAttackData(this.weapon, this.weaponFunctionId),
      stealthAttack: Boolean(this.stealthAttack),
      attackModifier: this.attackModifier,
      controller: this,
      weaponAttackId: this.attackId,
      ...extra
    };
  }

  getWeaponActionModifierState() {
    this.weaponActionModifierState ??= collectWeaponActionModifierState(this.createWeaponActionModifierContext());
    return this.weaponActionModifierState;
  }

  getWatchOutDifficultyBonus() {
    return Math.max(0, this.getWeaponActionModifierState().getCombatValueBonus("watchOutDifficulty"));
  }

  getOriginalHitChance(target, { limbKey = "", direction = null } = {}) {
    const previewContext = this.createWeaponAttackSkillCheckContext(target);
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(
      this.weapon,
      this.token,
      target,
      this.weaponFunctionId,
      previewContext
    );
    if (direction) {
      return getDirectedAttackHitChance(this.token.actor, this.weapon, target.actor, {
        actionKey: this.actionKey,
        mode: direction.mode,
        limbKey,
        difficultyBonus: rangeDifficultyBonus + this.getAttackModifierDifficultyBonus(),
        weaponFunctionId: this.weaponFunctionId,
        accuracyBonus: getWeaponAttackModifierAccuracyModifier(this.attackModifier),
        context: previewContext
      });
    }
    if (this.aimedShot) {
      const targetSelection = resolveAimedTargetSelection(target.actor, limbKey);
      const resolvedLimbKey = targetSelection?.limbKey ?? limbKey;
      const geometry = deserializeGeometry(this.lockedGeometry) ?? this.geometry;
      const aimPoint = geometry ? (selectTargetTrajectoryAimPoint(this.token, target, geometry) ?? getTokenAimPoint(target)) : null;
      const trajectory = geometry && aimPoint ? buildTrajectoryThroughPoint(this.token, geometry, aimPoint) : null;
      const blockerCount = this.ignoreAimedObstructions || !trajectory
        ? 0
        : getAimedTargetBlockers(this.token, target, trajectory, this.targetTokenUuidAllowlist).length;
      return getAimedAttackHitChance(
        this.token.actor,
        this.weapon,
        target.actor,
        resolvedLimbKey,
        getAimedTargetBlockerBonus(blockerCount) + rangeDifficultyBonus + this.getAttackModifierDifficultyBonus(),
        this.weaponFunctionId,
        this.actionKey,
        {
          innateDifficultyIgnorePercent: this.getWeaponActionModifierState().getOption("innateAimedDifficultyIgnorePercent"),
          ignoreCover: this.ignoreAimedObstructions,
          accuracyBonus: getWeaponAttackModifierAccuracyModifier(this.attackModifier),
          context: previewContext
        }
      );
    }
    return getGeneralAttackHitChance(this.token.actor, this.weapon, target.actor, {
      difficultyBonus: rangeDifficultyBonus
        + this.getAttackModifierDifficultyBonus()
        + getBurstShotDifficultyBonus(
          this.weapon,
          this.actionKey,
          0,
          this.weaponFunctionId,
          this.token.actor,
          previewContext
        ),
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      accuracyBonus: getWeaponAttackModifierAccuracyModifier(this.attackModifier),
      context: previewContext
    });
  }

  async commitWeaponAttack(target, options = {}) {
    if (this.attackCommitted || !target?.actor || !target?.document?.uuid) return;
    this.attackCommitted = true;
    const originalHitChance = this.getOriginalHitChance(target, options);
    const attackDistanceContext = this.createWeaponAttackReactionContext(target);
    const result = await this.requestReaction(REACTION_EVENT_KEYS.weaponAttackCommitted, {
      attackId: this.attackId,
      attackerActorUuid: this.token?.actor?.uuid ?? "",
      attackerTokenUuid: this.token?.document?.uuid ?? "",
      targetActorUuid: target.actor.uuid,
      targetTokenUuid: target.document.uuid,
      weaponUuid: this.weapon?.uuid ?? "",
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      originalHitChance,
      ...attackDistanceContext,
      title: "Берегись!",
      message: `${this.token?.actor?.name ?? ""} атакует ${target.actor.name}: ${this.weapon?.name ?? ""}. Исходный шанс попадания: ${originalHitChance}%.`
    });
    if (result?.difficultyBonus) this.getWeaponActionModifierState().addCombatValue("watchOutDifficulty", result.difficultyBonus);
  }

  createWeaponDamageContext(extra = {}) {
    return {
      ...this.createWeaponAttackSkillCheckContext(extra?.targetToken ?? null),
      ...extra,
      weaponFunctionId: this.weaponFunctionId,
      weaponActionModifierState: this.getWeaponActionModifierState()
    };
  }

  getWeaponDamage(extra = {}) {
    return getWeaponDamage(this.weapon, this.weaponFunctionId, this.createWeaponDamageContext(extra));
  }

  getWeaponDamagePercentBase() {
    return getWeaponDamagePercentBase(this.weapon, this.weaponFunctionId);
  }

  getAbilityTrialSettings() {
    return getAbilityAttackSettings(this.weapon, this.weaponFunctionId);
  }

  usesAbilityTrialResolution() {
    return Boolean(this.getAbilityTrialSettings());
  }

  registerAbilityTrialTargets(targets = []) {
    const shared = getSharedAbilityAttackTrialSession(this.abilityTrialSession);
    if (!shared) return [];
    shared.targetObjects ??= new Map();
    for (const target of targets ?? []) {
      const token = target?.object ?? target;
      const uuid = String(token?.document?.uuid ?? token?.uuid ?? "").trim();
      if (!uuid || !token?.actor) continue;
      shared.targetObjects.set(uuid, token);
      if (!shared.targetUuids.includes(uuid)) shared.targetUuids.push(uuid);
    }
    return Array.from(shared.targetObjects.values());
  }

  async getAbilityTrialTargets(fallbackTarget = null) {
    const shared = getSharedAbilityAttackTrialSession(this.abilityTrialSession);
    if (!shared) return fallbackTarget ? [fallbackTarget] : [];
    this.registerAbilityTrialTargets(fallbackTarget ? [fallbackTarget] : []);
    shared.targetObjects ??= new Map();
    for (const uuid of shared.targetUuids ?? []) {
      if (shared.targetObjects.has(uuid)) continue;
      const document = typeof fromUuid === "function" ? await fromUuid(uuid) : null;
      const token = document?.object ?? document ?? null;
      if (token?.actor) shared.targetObjects.set(uuid, token);
    }
    return Array.from(shared.targetObjects.values());
  }

  async resolveAbilityTrialAttackAgainstTarget(target, {
    selectedLimbKey = "",
    penetrationStep = 0,
    reflectionCount = 0
  } = {}) {
    const settings = this.getAbilityTrialSettings();
    if (!settings || !target?.actor) return null;
    if (await this.resolveTargetReactions(target)) return null;

    if (!getSharedAbilityAttackTrialSession(this.abilityTrialSession)) {
      this.abilityTrialSession = createAbilityAttackTrialSession({
        abilityFunction: getAbilityAttackFunction(this.weapon, this.weaponFunctionId),
        settings,
        sourceActor: this.token?.actor ?? null,
        sourceToken: this.token
      });
    }
    const shared = getSharedAbilityAttackTrialSession(this.abilityTrialSession);
    this.registerAbilityTrialTargets([target]);
    const allTrialTargets = await this.getAbilityTrialTargets(target);
    const sourceOnceUnperceivedTarget = allTrialTargets.find(candidate => !isAttackTargetVisible(
      candidate,
      this.targetTokenUuidAllowlist,
      this.token
    ));
    const laneKey = String(
      this.abilityTrialSession?.laneKey
      ?? target?.document?.uuid
      ?? target?.uuid
      ?? target.actor.uuid
      ?? ""
    ).trim();
    const resolution = await resolveAttackTrialResolution({
      attackSettings: settings,
      sourceActor: this.token.actor,
      sourceToken: this.token,
      targets: [{
        actor: target.actor,
        token: target,
        laneKey
      }],
      state: shared.state,
      title: String(settings.name ?? "").trim() || String(this.weapon?.name ?? "Атакующее действие"),
      operationId: shared.operationId || this.attackId,
      chainRef: this.chainRef,
      source: {
        itemUuid: this.weapon?.uuid ?? "",
        weaponUuid: this.weapon?.uuid ?? "",
        weaponFunctionId: this.weaponFunctionId,
        actionKey: this.actionKey,
        attackId: this.attackId
      },
      sourceCheckDataByMode: {
        once: getUnseenAttackEdgeModifiers(
          sourceOnceUnperceivedTarget,
          this.targetTokenUuidAllowlist,
          this.token
        ),
        perTarget: getUnseenAttackEdgeModifiers(
          target,
          this.targetTokenUuidAllowlist,
          this.token
        )
      },
      requester: "abilityAttackTrial",
      animate: false,
      createMessage: true
    });
    this.attackCheckCount += Math.max(0, toInteger(resolution.attempted));

    shared.notifiedOutcomeKeys ??= new Set();
    for (const entry of resolution.outcomes) {
      if (entry.cached || !entry.check) continue;
      const notificationKey = [
        entry.trialId,
        entry.subject,
        entry.sourceMode,
        entry.laneKey,
        entry.actor?.uuid,
        entry.resultKey
      ].join(":");
      if (shared.notifiedOutcomeKeys.has(notificationKey)) continue;
      shared.notifiedOutcomeKeys.add(notificationKey);
      await this.notifyAttackCheckResolved(entry.check, null, { recordAggregate: false });
    }

    const resolvedTargetLane = resolution.targetOutcomes.find(entry => entry.laneKey === laneKey);
    const targetWasAffected = [
      ...(resolvedTargetLane?.outcomes ?? []),
      ...(resolvedTargetLane?.sourceOutcomes ?? [])
    ].some(entry => Array.isArray(entry?.links) && entry.links.length > 0);
    if (targetWasAffected && target.actor?.uuid) {
      this.attackCheckTargetActorUuids.add(String(target.actor.uuid));
      this.successfulAttackTargetActorUuids.add(String(target.actor.uuid));
    }

    const allTargetTokens = await this.getAbilityTrialTargets(target);
    const targets = allTargetTokens.map(token => ({
      actor: token.actor,
      token
    }));
    const constructs = normalizeAbilityConstructs(this.weapon?.system?.constructs ?? []);
    const damageRequests = [];
    for (const entry of resolution.outcomes) {
      damageRequests.push(...await applyAttackTrialOutcomeConsequences({
        entry,
        constructs,
        sourceActor: this.token.actor,
        sourceToken: this.token,
        targets,
        sourceItemUuid: this.weapon?.uuid ?? "",
        title: String(settings.name ?? "").trim() || String(this.weapon?.name ?? "Атакующее действие"),
        deduplicationSet: shared.appliedOutcomeKeys,
        getBaseDamage: recipient => {
          const recipientToken = recipient?.token?.object ?? recipient?.token ?? null;
          return this.getWeaponDamage({ targetToken: recipientToken });
        },
        getSelectedLimbKey: recipient => {
          if (recipient?.actor === target.actor && selectedLimbKey) return selectedLimbKey;
          return selectRandomLimbKey(recipient?.actor, { includeDestroyed: true });
        },
        buildDamageRequests: async ({
          recipient,
          amount,
          limbKey,
          scope,
          entry: resolvedEntry
        }) => {
          const recipientToken = recipient?.token?.object
            ?? recipient?.token
            ?? (recipient?.actor === target.actor ? target : null);
          const damageContext = this.createWeaponDamageContext({
            targetToken: recipientToken,
            limbKey,
            damageShareCount: 1,
            reflectionCount: Math.max(0, toInteger(reflectionCount))
          });
          let resolvedAmount = applyContextualDamageToAmount(this.weapon, amount, damageContext);
          resolvedAmount = applyRicochetDamageBonus(this.weapon, resolvedAmount, damageContext);
          // Ability trials do not turn the generic `criticalSuccess` result
          // into weapon critical damage. Preserve the ordinary non-critical
          // bonuses (including stealth), then apply only the property attached
          // to this exact outcome.
          resolvedAmount = applyCriticalDamageSnapshot(
            resolvedAmount,
            getCriticalDamageSnapshot(
              this.weapon,
              null,
              this.weaponFunctionId,
              damageContext
            )
          );
          const criticalDamage = await resolveAttackTrialOutcomeCriticalDamage({
            amount: resolvedAmount,
            specialProperties: settings.specialProperties,
            entry: resolvedEntry,
            recipient,
            sourceActor: this.token.actor,
            evaluateFormula: evaluateAbilityAttackFormula
          });
          resolvedAmount = criticalDamage.amount;
          return buildWeaponDamageRequests(this.weapon, {
            attackerActor: this.token.actor,
            attackerToken: this.token,
            modifierState: this.getWeaponActionModifierState(),
            actor: recipient.actor,
            targetToken: recipientToken,
            limbKey,
            amount: resolvedAmount,
            scope,
            source: {
              attackId: this.attackId,
              weaponUuid: this.weapon.uuid,
              weaponFunctionId: this.weaponFunctionId,
              weaponData: foundry.utils.deepClone(getWeaponAttackData(this.weapon, this.weaponFunctionId) ?? {}),
              actionKey: this.actionKey,
              attackerUuid: this.token.actor.uuid,
              tokenId: this.token.id,
              criticalSuccess: false,
              criticalDamageUsed: criticalDamage.applied,
              abilityCriticalDamagePercent: criticalDamage.percent,
              penetrationStep: Math.max(0, toInteger(penetrationStep)),
              reflectionCount: Math.max(0, toInteger(reflectionCount)),
              abilityTrialId: resolvedEntry.trialId,
              abilityTrialOutcomeId: resolvedEntry.outcomeId
            }
          }, this.weaponFunctionId);
        }
      }));
    }
    return damageRequests;
  }

  hasRequiredWeaponResources(multiplier = 1) {
    const attackCount = Math.max(1, toInteger(multiplier));
    const modifierState = this.getWeaponActionModifierState();
    if (!hasRequiredWeaponResources(this.weapon, attackCount, this.weaponFunctionId, {
      modifierState,
      additionalActorResourceCosts: this.additionalActorResourceCosts,
      skipBaseCosts: this.skipBaseWeaponResourceCosts
    })) return false;
    return modifierState.canSpend(this.createWeaponActionModifierContext({ attackCount }));
  }

  async commitWeaponActionModifierCosts(attackCount = 1) {
    return this.getWeaponActionModifierState().commit(this.createWeaponActionModifierContext({
      attackCount: Math.max(1, toInteger(attackCount))
    }));
  }

  async resolveTargetReactions(target) {
    if (this.interruptForIncapacitation()) return true;
    if (isPhantomEntity(target)) return false;
    if (this.attackCanceledByReaction || !target?.actor || !this.token?.actor || !this.weapon) return false;
    if (target.actor.statuses?.has?.("unconscious")) {
      this.preExistingUnconsciousTargetActorUuids.add(String(target.actor.uuid ?? "").trim());
    }
    const targetKey = String(target.actor.uuid ?? target.document?.uuid ?? target.id ?? "");
    if (!targetKey) return false;
    const reactionKey = `${this.attackId}:${targetKey}`;
    if (this.reactionTargetKeys.has(reactionKey)) return false;
    this.reactionTargetKeys.add(reactionKey);
    if (target.actor.uuid) this.attackedTargetActorUuids.add(target.actor.uuid);
    if (target.document?.uuid) this.attackedTargetTokenUuids.add(target.document.uuid);
    const attackDistanceContext = this.createWeaponAttackReactionContext(target);
    const result = await this.requestReaction(REACTION_EVENT_KEYS.weaponAttackTargeted, {
      attackId: this.attackId,
      attackerActorUuid: this.token.actor.uuid,
      attackerTokenUuid: this.token.document?.uuid ?? "",
      targetActorUuid: target.actor.uuid,
      targetTokenUuid: target.document?.uuid ?? "",
      weaponUuid: this.weapon.uuid,
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      suppressGuardianAngelReaction: Boolean(this.attackModifier?.suppressGuardianAngelReaction),
      ...attackDistanceContext,
      title: "Реакция на атаку",
      message: `${this.token.actor.name} атакует ${target.actor.name}: ${this.weapon.name}.`
    });
    if (result?.cancelCurrent || result?.cancelRemaining) {
      this.attackCanceledByReaction = true;
      return true;
    }
    if (this.interruptForIncapacitation()) return true;
    return false;
  }

  requestReaction(eventKey = "", context = {}) {
    const reactionContext = {
      ...context,
      chainRef: context?.chainRef ?? this.chainRef,
      damageHubOperationRef: context?.damageHubOperationRef ?? this.damageHubOperationRef
    };
    const operation = () => requestReactionEvent(eventKey, reactionContext);
    return this.reactionCoordinator?.run
      ? this.reactionCoordinator.run(operation)
      : operation();
  }

  requestFinish() {
    this.finishRequested = true;
    this.suppressPreview();
    if (!this.processing) this.completeProcessingCycle();
  }

  suppressPreview() {
    this.previewSuppressed = true;
    this.clearWeaponNoisePreview();
    this.shape.clear();
    this.meleeDirectionPreview.clear();
    this.clearTargetMarkers();
    this.removeLimbMenu();
    this.removeChanceMenu();
    if (!this.suppressAttackPreviewBroadcast) {
      broadcastAttackPreview({
        action: "clearPreview",
        attackId: this.previewAttackId
      });
    }
  }

  resumePreview() {
    if (this.destroyed) return;
    this.previewSuppressed = false;
    this.attachPreview();
    this.syncWeaponNoisePreview();
    this.refresh(true);
  }

  canContinueAfterProcessing() {
    const actor = this.token?.actor ?? null;
    const weapon = actor?.items?.get?.(this.weapon?.id) ?? null;
    if (!actor || !weapon || isActorUnableToAct(actor)) return false;
    if (!isAttackSource(weapon, this.weaponFunctionId)) return false;
    if (!getWeaponAttackData(weapon, this.weaponFunctionId)?.enabled) return false;
    if (!hasWeaponAction(weapon, this.actionKey, this.weaponFunctionId)) return false;
    if (getWeaponActionBlockState(actor, this.actionKey).blocked) return false;
    if (isWeaponPlacementDisabled(actor, weapon)) return false;

    this.weapon = weapon;
    this.rangeProfile = getWeaponRangeProfile(weapon, this.actionKey, this.token, this.weaponFunctionId, {
      weaponAttackId: this.attackId,
      chanceOperationId: this.chanceOperationId
    });
    this.rangeProfilesByTarget?.clear?.();
    this.weaponActionModifierState = null;
    const attackCount = getActionAttackCount(weapon, this.actionKey, this.weaponFunctionId);
    const modifierState = this.getWeaponActionModifierState();
    if (getMissingWeaponResourceCost(weapon, attackCount, this.weaponFunctionId, {
      modifierState,
      additionalActorResourceCosts: this.additionalActorResourceCosts,
      skipBaseCosts: this.skipBaseWeaponResourceCosts
    })) return false;
    if (!modifierState.canSpend(this.createWeaponActionModifierContext({ attackCount, silent: true }))) return false;
    if (!this.skipActionPointCost && !canSpendRequiredWeaponActionPoints(
      actor,
      weapon,
      this.actionKey,
      this.weaponFunctionId,
      this.createWeaponActionContext()
    )) return false;
    return true;
  }

  recordAttackCheckOutcome(outcome = null) {
    const targetToken = outcome?.check?.targetToken ?? outcome?.targetToken ?? null;
    const targetActor = targetToken?.actor ?? outcome?.check?.targetActor ?? outcome?.targetActor ?? null;
    const targetActorUuid = String(targetActor?.uuid ?? "").trim();
    if (targetActorUuid) this.attackCheckTargetActorUuids.add(targetActorUuid);
    if (!isSuccessfulAttack(outcome)) return false;
    this.successfulAttackCheckCount += 1;
    if (targetActorUuid) this.successfulAttackTargetActorUuids.add(targetActorUuid);
    return true;
  }

  getAttackCheckAggregateData() {
    const successfulAttack = this.successfulAttackCheckCount > 0
      || this.successfulAttackTargetActorUuids.size > 0;
    return {
      successfulAttackCheckCount: Math.max(0, toInteger(this.successfulAttackCheckCount)),
      successfulAttack,
      attackCheckTargetActorUuids: Array.from(this.attackCheckTargetActorUuids),
      successfulAttackTargetActorUuids: Array.from(this.successfulAttackTargetActorUuids),
      attackCheckAggregate: true
    };
  }

  flushPendingTerminalAttackOutcomes() {
    const outcomes = this.pendingTerminalAttackOutcomes?.splice(0) ?? [];
    for (const outcome of outcomes) void dispatchWeaponAttackTerminalHandlers(outcome);
  }

  completeProcessingCycle({ refresh = true } = {}) {
    if (this.destroyed) {
      this.flushPendingTerminalAttackOutcomes();
      return true;
    }
    this.processing = false;
    void this.abortSkillCheckCollectors();
    if (this.attackModifier?.finishAfterAttack || this.finishAfterAttack) this.finishRequested = true;
    if (!this.finishRequested && !this.attackCanceledByReaction) this.prepareNextAttackCycle();
    if (!this.finishRequested && !this.attackCanceledByReaction && !this.canContinueAfterProcessing()) {
      this.finishRequested = true;
    }
    if (this.finishRequested || this.attackCanceledByReaction) {
      if (activeAttack === this) activeAttack = null;
      this.destroy();
      return true;
    }
    if (refresh) {
      if (!this.startTargetSelectionLifecycle({ supersede: false })) {
        if (activeAttack === this) activeAttack = null;
        this.destroy();
        return true;
      }
      this.attachInteractiveHandlers();
      this.resumePreview();
    }
    this.flushPendingTerminalAttackOutcomes();
    return false;
  }

  prepareNextAttackCycle() {
    this.attackId = foundry.utils.randomID();
    this.chanceOperationId = this.attackId;
    this.stealthAttack = isActorStealthed(this.token?.actor);
    this.rangeProfilesByTarget?.clear?.();
    this.weaponActionModifierState = null;
    this.attackCommitted = false;
    this.attackCostsCommitted = false;
    this.criticalDamageUsed = false;
    this.lastResolvedAttackOutcome = null;
    this.attackCheckCount = 0;
    this.successfulAttackCheckCount = 0;
    this.attackCheckTargetActorUuids?.clear?.();
    this.successfulAttackTargetActorUuids?.clear?.();
    this.attackCheckEventSequence = 0;
    this.pendingCriticalFailureResourceCosts = [];
    this.reactionTargetKeys?.clear?.();
    this.attackedTargetActorUuids?.clear?.();
    this.attackedTargetTokenUuids?.clear?.();
    this.preExistingUnconsciousTargetActorUuids?.clear?.();
    this.reportedActionPointCost = null;
    this.reportedActionPointCostApplied = null;
    this.actionPointSpendReceipt = null;
    this.authorityExecutionSucceeded = false;
    this.authorityShouldFinish = false;
  }

  beginProcessingCycle() {
    if (this.processing) return false;
    this.refreshInactiveAttackerPerception({ force: true });
    this.finishTargetSelection();
    this.weaponNoiseLevel = getWeaponNoiseLevel(getWeaponAttackData(this.weapon, this.weaponFunctionId));
    this.weaponNoiseAttempted = false;
    this.weaponNoiseDetectionResolved = false;
    this.processing = true;
    this.clearWeaponNoisePreview();
    this.releaseInteractiveControl();
    if (this.onProcessingStarted) {
      try {
        this.onProcessingStarted({
          actor: this.token?.actor ?? null,
          token: this.token,
          weapon: this.weapon,
          actionKey: this.actionKey,
          weaponFunctionId: this.weaponFunctionId,
          controller: this
        });
      } catch (error) {
        console.error("Fallout MaW | Weapon attack processing callback failed", error);
      }
    }
    return true;
  }

  releaseInteractiveControl() {
    if (!this.finishAfterAttack || this.interactiveControlReleased || this.destroyed) return false;
    this.interactiveControlReleased = true;
    if (activeAttack === this) activeAttack = null;
    this.suppressPreview();
    return true;
  }

  async runInteractiveAttackOperation(operation) {
    // codex-runtime-debug: actual user-confirmation operation, before the attack ID rotates.
    const __codexFinish = globalThis.__falloutMawGameplayProbe?.span("attack.interactive", "H5", {
      sourceActorItemCount: this.token?.actor?.items?.size ?? 0,
      targetCount: this.targets?.length ?? 0,
      attackId: this.attackId ?? ""
    });
    try {
      return await operation();
    } catch (error) {
      console.error("Fallout MaW | Weapon attack processing failed", error);
      await this.abortSkillCheckCollectors();
      if (this.processing) this.completeProcessingCycle({ refresh: false });
      else if (this.finishAfterAttack && !this.destroyed) {
        if (activeAttack === this) activeAttack = null;
        this.destroy();
      }
      return false;
    } finally {
      __codexFinish?.(); // codex-runtime-debug
    }
  }

  shouldSpendWeaponResourcesForAttempt() {
    return !this.attackCanceledByReaction || this.attackCheckCount > 0;
  }

  shouldPlayWeaponAnimationForAttempt() {
    return !this.attackCanceledByReaction || this.attackCheckCount > 0;
  }

  async playAttackAnimationsIfNeeded(trajectories = [], { attempted = true, delayMs = null } = {}) {
    if (this.destroyed || !attempted || !this.shouldPlayWeaponAnimationForAttempt()) return;
    await this.playAttemptWeaponAnimations(trajectories, { delayMs });
  }

  async playAttemptWeaponAnimations(trajectories = [], { delayMs = null } = {}) {
    // codex-runtime-debug: distinguish animation waits from computation.
    const __codexFinish = globalThis.__falloutMawGameplayProbe?.span("attack.animations", "H5", {
      attackId: this.attackId ?? ""
    });
    try {
    await playWeaponAttackAnimations({
      weapon: this.weapon,
      weaponFunctionId: this.weaponFunctionId,
      weaponData: getWeaponAttackData(this.weapon, this.weaponFunctionId),
      trajectories,
      delayMs: delayMs ?? getWeaponAttackAnimationDelay(this.weapon, this.weaponFunctionId)
    });
    } finally {
      __codexFinish?.(); // codex-runtime-debug
    }
  }

  async spendCurrentAttackCosts({
    attackCount = 1,
    trajectories = [],
    point = null,
    createSpentQuantityTile = true,
    delayedThrownItemId = "",
    delayedThrownItemData = null,
    actionContext = null
  } = {}) {
    // codex-runtime-debug: document/resource commits during an actual attack.
    const __codexFinish = globalThis.__falloutMawGameplayProbe?.span("attack.costs", "H1", {
      sourceActorItemCount: this.token?.actor?.items?.size ?? 0,
      targetCount: this.targets?.length ?? 0,
      attackId: this.attackId ?? ""
    });
    try {
    this.spentQuantityItemData = null;
    const resolvedActionContext = actionContext && typeof actionContext === "object"
      ? actionContext
      : this.createWeaponAttackSkillCheckContext(this.selectedTarget);
    const actionPointCostApplied = !this.skipActionPointCost
      && isCombatActionPointSpendingActive(this.token.actor);
    const actionPointCost = actionPointCostApplied
      ? getWeaponActionPointCost(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId, {
        ...resolvedActionContext,
        chanceOperationId: this.chanceOperationId
      })
      : 0;
    const actorResourceActionPointCost = this.skipBaseWeaponResourceCosts
      ? 0
      : getWeaponActorResourceCostTotal(this.weapon, "actionPoints", {
        modifierState: this.getWeaponActionModifierState(),
        weaponFunctionId: this.weaponFunctionId
      });
    if (
      actionPointCostApplied
      && !canSpendCombinedWeaponActionPointCosts(
        this.token.actor,
        actionPointCost,
        actorResourceActionPointCost,
        { notify: true, label: "действия" }
      )
    ) {
      this.attackCanceledByReaction = true;
      return false;
    }
    this.reportedActionPointCostApplied ??= actionPointCostApplied;
    let committedActionPointSpend = null;
    let actionPointSpendStarted = false;
    const commitActionPointSpend = async () => {
      if (actionPointSpendStarted) {
        throw new Error("Weapon action-point transaction was invoked more than once.");
      }
      actionPointSpendStarted = true;
      committedActionPointSpend = await commitWeaponActionPointSpend(
        this.token.actor,
        this.weapon,
        this.actionKey,
        this.weaponFunctionId,
        {
          emitActionResolved: !this.attackCanceledByReaction,
          spendActionPoints: !this.skipActionPointCost,
          actionPointCostApplied: this.reportedActionPointCostApplied,
          attackId: this.attackId,
          actorToken: this.token,
          context: resolvedActionContext,
          chainRef: this.chainRef,
          damageHubOperationRef: this.damageHubOperationRef,
          resolvedCost: actionPointCost
        }
      );
      return committedActionPointSpend;
    };
    const rollbackActionPointSpend = async committed => {
      await rollbackCommittedWeaponActionPointSpend(this.token.actor, committed);
      committedActionPointSpend = null;
    };
    const weaponAttempted = this.shouldSpendWeaponResourcesForAttempt();
    let committedActorResourceCosts = [];
    if (weaponAttempted) {
      const modifierState = this.getWeaponActionModifierState();
      const spentQuantityItemData = getSpentQuantityItemData(this.weapon, attackCount, this.weaponFunctionId, { modifierState });
      this.spentQuantityItemData = spentQuantityItemData;
      const spentQuantityTileOperationId = createSpentQuantityTile && spentQuantityItemData
        ? `weapon-resource:${this.attackId}:${foundry.utils.randomID()}`
        : "";
      if (spentQuantityTileOperationId) {
        if (delayedThrownItemId) {
          foundry.utils.setProperty(
            spentQuantityItemData,
            `flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_FLAG}`,
            {
              id: delayedThrownItemId,
              explodeAtWorldTime: Number(delayedThrownItemData?.explodeAtWorldTime) || 0
            }
          );
        }
        const tile = await createSpentQuantityItemTile({
          itemData: spentQuantityItemData,
          point,
          token: this.token,
          sourceItemUuid: this.weapon.uuid,
          delayedThrownItemId,
          operationId: spentQuantityTileOperationId
        });
        if (!tile) {
          this.attackCanceledByReaction = true;
          return false;
        }
      }

      try {
        const resourcesSpent = await spendWeaponResources(
          this.weapon,
          attackCount,
          this.weaponFunctionId,
          [
            ...this.pendingCriticalFailureResourceCosts,
            ...this.additionalActorResourceCosts
          ],
          {
            modifierState,
            chainRef: this.chainRef,
            skipBaseCosts: this.skipBaseWeaponResourceCosts,
            beforeItemCommit: commitActionPointSpend,
            rollbackBeforeItemCommit: rollbackActionPointSpend
          }
        );
        if (!resourcesSpent) {
          await rollbackSpentQuantityItemTile(spentQuantityTileOperationId);
          this.attackCanceledByReaction = true;
          return false;
        }
        if (!(await this.commitWeaponActionModifierCosts(attackCount))) {
          throw new Error("Weapon action modifier state could not be committed after resource spending.");
        }
        committedActorResourceCosts = resourcesSpent.actorCosts ?? [];
      } catch (error) {
        await rollbackSpentQuantityItemTile(spentQuantityTileOperationId);
        throw error;
      }
    } else {
      await commitActionPointSpend();
    }
    const spentAttackActionPoints = (
      committedActionPointSpend?.receipt?.resourceKey === "actionPoints"
        ? Math.max(0, toInteger(committedActionPointSpend.receipt.amount))
        : 0
    ) + getPaidActorResourceAmount(committedActorResourceCosts, "actionPoints");
    if (spentAttackActionPoints > 0) {
      await applyAttackActionPointMovementLoss(this.token.actor, spentAttackActionPoints, {
        ...resolvedActionContext,
        actorToken: this.token,
        weapon: this.weapon,
        actionKey: this.actionKey,
        weaponActionKey: this.actionKey,
        weaponFunctionId: this.weaponFunctionId,
        attackId: this.attackId,
        chanceOperationId: this.chanceOperationId || this.attackId,
        chainRef: this.chainRef,
        requester: "weaponAttack",
        source: "weaponAttack"
      });
    }
    const spentActionPointCost = await finalizeCommittedWeaponActionPointSpend(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      committedActionPointSpend
    );
    this.actionPointSpendReceipt = committedActionPointSpend?.receipt ?? null;
    this.reportedActionPointCost ??= Math.max(0, toInteger(spentActionPointCost));
    this.attackCostsCommitted = weaponAttempted;
    this.weaponNoiseAttempted = weaponAttempted;
    this.interruptForIncapacitation();
    return true;
    } finally {
      __codexFinish?.(); // codex-runtime-debug
    }
  }

  async executeAgainstToken(targetToken) {
    this.pointer = getTokenAimPoint(targetToken);
    if (!this.pointer) return false;
    this.refresh(true);
    if (!this.geometry) return false;

    if (this.actionKey === PUSH_ACTION_KEY) {
      await this.performPushAttack(1);
      return true;
    }
    if (!this.targetedAction) {
      await this.performCurrentAttack();
      return true;
    }
    if (!this.targets.includes(targetToken)) return false;
    if (!this.isAimedTargetInEffectiveRange(targetToken)) return false;

    this.selectedTarget = targetToken;
    this.lockedGeometry = serializeGeometry(this.geometry);
    this.selectedLimbKey = this.requiresLimbSelection ? selectRandomWeightedLimbKey(targetToken.actor) : "";
    if (!this.requiresLimbSelection && !this.requiresDirectionSelection) {
      this.targetedAction = false;
      await this.performCurrentAttack();
      return true;
    }
    if (this.requiresDirectionSelection) {
      this.aimedMode = "direction";
      const directions = getEnabledMeleeDirections(this.weapon, this.actionKey, this.weaponFunctionId);
      const direction = directions.find(entry => entry.mode === "thrust") ?? directions[0];
      if (!direction) return false;
      await this.performDirectedAttack(direction.key);
      return true;
    }

    this.aimedMode = "limb";
    if (!this.selectedLimbKey) return false;
    await this.performAimedAttack(this.selectedLimbKey);
    return true;
  }

  async executeStrictlyAgainstToken(targetToken, { selectedLimbKey = "" } = {}) {
    this.pointer = getTokenAimPoint(targetToken);
    if (!this.pointer || !this.rebuildGeometryAndTargets()) return false;
    if (!this.targets.includes(targetToken)) return false;
    if (!this.isAimedTargetInEffectiveRange(targetToken)) return false;

    this.selectedTarget = targetToken;
    this.lockedGeometry = serializeGeometry(this.geometry);
    this.selectedLimbKey = String(selectedLimbKey ?? "");
    return this.performStrictSelectedTargetAttack(targetToken, {
      selectedLimbKey: this.selectedLimbKey
    });
  }

  async performStrictSelectedTargetAttack(targetToken, { selectedLimbKey = "" } = {}) {
    if (this.processing || !targetToken?.actor || !this.geometry) return false;
    if (!this.isAimedTargetInEffectiveRange(targetToken)) return false;
    const actionContext = this.createWeaponActionContext({ targetToken });
    if (!this.hasRequiredWeaponResources(1)) return false;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) return false;

    this.beginProcessingCycle();
    if (!(await this.runBeforeExecute())) {
      this.completeProcessingCycle();
      return false;
    }
    await this.commitWeaponAttack(targetToken, { limbKey: selectedLimbKey });
    this.pendingCriticalFailureResourceCosts = [];

    const aimPoint = selectTargetTrajectoryAimPoint(this.token, targetToken, this.geometry)
      ?? getTokenAimPoint(targetToken);
    const trajectory = aimPoint
      ? buildTrajectoryThroughPoint(this.token, this.geometry, aimPoint)
      : null;
    const damageRequests = await this.resolveAbilityTrialAttackAgainstTarget(targetToken, {
      selectedLimbKey
    });
    const attempted = damageRequests !== null;
    if (attempted) {
      await this.spendCurrentAttackCosts({
        attackCount: 1,
        point: getAttackLandingPoint(trajectory ? [trajectory] : [], aimPoint),
        actionContext
      });
    }
    await this.playAttackAnimationsIfNeeded(trajectory ? [trajectory] : [], { attempted });
    this.releaseInteractiveControl();
    const damageResults = !this.attackCanceledByReaction && damageRequests?.length
      ? flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests)))
      : [];
    await this.notifyAttackResolved({
      attempted,
      damageResults,
      killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults)
    });
    this.completeProcessingCycle();
    return attempted;
  }

  destroy() {
    if (this.destroyed) return;
    this.finishTargetSelection();
    liveWeaponAttackTargetControllers.delete(this);
    this.destroyed = true;
    this.previewFrameScheduler.destroy();
    this.clearWeaponNoisePreview();
    void this.abortSkillCheckCollectors();
    if (typeof this.attackModifier?.onDestroy === "function") {
      try {
        void this.attackModifier.onDestroy({
          actor: this.token?.actor ?? null,
          token: this.token,
          weapon: this.weapon,
          actionKey: this.actionKey,
          weaponFunctionId: this.weaponFunctionId,
          attackModifier: this.attackModifier,
          controller: this
        });
      } catch (error) {
        console.error("Fallout MaW | Weapon attack destroy callback failed", error);
      }
    }
    if (typeof this.onDestroy === "function") {
      try {
        void this.onDestroy({
          actor: this.token?.actor ?? null,
          token: this.token,
          weapon: this.weapon,
          actionKey: this.actionKey,
          weaponFunctionId: this.weaponFunctionId,
          controller: this
        });
      } catch (error) {
        console.error("Fallout MaW | Weapon attack destroy callback failed", error);
      }
    }
    if (this.ownsAttackAutoCoverLifecycle) clearAttackAutoCoverSync(this.autoCoverAttackId);
    this.autoCoverActorUuids.clear();
    this.detachInteractiveHandlers();
    this.removeLimbMenu();
    this.removeChanceMenu();
    this.clearBurstTargetPreviewTimer();
    if (!this.suppressAttackPreviewBroadcast) {
      broadcastAttackPreview({
        action: "clearPreview",
        attackId: this.previewAttackId
      });
    }
    this.container.destroy({ children: true });
    this.flushPendingTerminalAttackOutcomes();
  }

  getAttackOrigin() {
    return this.originOverride ?? getTokenAimPoint(this.token);
  }

  async runBeforeExecute() {
    if (this.beforeExecuteCompleted) return true;
    if (!this.onBeforeExecute) {
      this.beforeExecuteCompleted = true;
      return true;
    }
    const allowed = await this.onBeforeExecute({
      actor: this.token?.actor ?? null,
      token: this.token,
      weapon: this.weapon,
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      attackModifier: this.attackModifier,
      controller: this
    });
    if (allowed === false) return false;
    this.beforeExecuteCompleted = true;
    this.originOverride = null;
    return true;
  }

  async prepareDuplicateAttackPlan({ attackCount = 1 } = {}) {
    const baseAttackCount = Math.max(1, toInteger(attackCount));
    if (getAbilityAttackSettings(this.weapon, this.weaponFunctionId)) {
      return {
        baseAttackCount,
        duplicateCount: 0,
        cycles: 1,
        totalAttackCount: baseAttackCount
      };
    }
    const requests = [];
    Hooks.callAll(WEAPON_ATTACK_DUPLICATE_REQUEST_HOOK, {
      actor: this.token?.actor ?? null,
      token: this.token,
      weapon: this.weapon,
      actionKey: this.actionKey,
      weaponActionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      weaponData: getWeaponAttackData(this.weapon, this.weaponFunctionId),
      attackModifier: this.attackModifier,
      controller: this,
      addDuplicateRequest: request => requests.push(request)
    });

    let duplicateCount = 0;
    for (const request of requests) {
      const count = Math.max(0, toInteger(request?.count ?? request?.duplicateCount ?? 1));
      if (!count) continue;
      if (typeof request?.canDuplicate === "function" && (await request.canDuplicate({
        actor: this.token?.actor ?? null,
        token: this.token,
        weapon: this.weapon,
        actionKey: this.actionKey,
        weaponFunctionId: this.weaponFunctionId,
        controller: this,
        count
      })) === false) continue;

      const nextTotalAttackCount = baseAttackCount * (1 + duplicateCount + count);
      if (!this.hasRequiredWeaponResources(nextTotalAttackCount)) continue;
      if (typeof request?.onBeforeDuplicate === "function" && (await request.onBeforeDuplicate({
        actor: this.token?.actor ?? null,
        token: this.token,
        weapon: this.weapon,
        actionKey: this.actionKey,
        weaponFunctionId: this.weaponFunctionId,
        controller: this,
        count,
        totalAttackCount: nextTotalAttackCount
      })) === false) continue;
      duplicateCount += count;
    }

    return {
      baseAttackCount,
      duplicateCount,
      cycles: 1 + duplicateCount,
      totalAttackCount: baseAttackCount * (1 + duplicateCount)
    };
  }

  onMove(event) {
    if (this.processing || this.isInteractionLocked()) return;
    this.updateRightClickCancelCandidate(event);
    event.stopPropagation();
    if (this.pushStrengthMaximum > 0) {
      this.refreshPushStrengthMenu();
      return;
    }
    if (this.targetedAction && ["limb", "direction"].includes(this.aimedMode)) {
      this.refreshAimedLimbMenu();
      return;
    }
    this.pointer = event.data.getLocalPosition(getCombatVisualizationLayer());
    this.previewFrameScheduler.request();
  }

  onPointerDown(event) {
    if (![0, 2].includes(event.button) || this.processing) return;
    if (this.isInteractionLocked()) {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      return false;
    }
    if (this.handleLimbMenuPointerDown(event)) return;
    if (!isCanvasViewEvent(event)) return;

    if (event.button === 2) {
      this.startRightClickCancelCandidate(event);
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    event.cancelBubble = true;
    if (event.button === 0 && this.pushStrengthMaximum > 0) return false;
    return this.onConfirm(event);
  }

  handleLimbMenuPointerDown(event) {
    if (!this.limbMenu?.contains(event.target)) return false;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    if (event.button === 2) {
      this.onCancel(event);
      return true;
    }

    const directionButton = event.target?.closest?.("[data-attack-direction]");
    if (directionButton && this.aimedMode === "direction") {
      void this.runInteractiveAttackOperation(() => (
        this.performDirectedAttack(directionButton.dataset.attackDirection ?? "")
      ));
      return true;
    }

    const strengthButton = event.target?.closest?.("[data-push-strength]");
    if (strengthButton && this.pushStrengthMaximum > 0) {
      const strength = Math.max(1, Math.min(this.pushStrengthMaximum, toInteger(strengthButton.dataset.pushStrength)));
      void this.runInteractiveAttackOperation(() => this.performPushAttack(strength));
      return true;
    }

    const button = event.target?.closest?.("[data-limb-key]");
    if (!button || this.aimedMode !== "limb") return true;
    if (button.disabled || button.dataset.destroyed === "true") return true;
    const limbKey = button.dataset.limbKey ?? "";
    if (this.requiresDirectionSelection) {
      this.selectedLimbKey = limbKey;
      this.aimedMode = "direction";
      this.refreshAimedLimbMenu();
      return true;
    }
    void this.runInteractiveAttackOperation(() => this.performAimedAttack(limbKey));
    return true;
  }

  onCancel(event) {
    if (this.isInteractionLocked()) return false;
    if (this.processing) return false;
    if (this.isRightClickDragCancel(event)) {
      this.rightClickCancelCandidate = null;
      if (typeof this.previousViewContextMenu === "function") {
        return this.previousViewContextMenu.call(canvas.app?.view ?? null, event);
      }
      return false;
    }
    event?.preventDefault?.();
    this.rightClickCancelCandidate = null;
    if (this.attackModifier?.preventCancel) return false;
    if (this.pushStrengthMaximum > 0) {
      this.cancelPushStrengthSelection();
      return false;
    }
    if (this.targetedAction && ["limb", "direction"].includes(this.aimedMode)) {
      if (this.constrainedTarget) {
        if (activeAttack === this) activeAttack = null;
        this.finishTargetSelection({ cancelled: true });
        this.destroy();
        return false;
      }
      this.unlockAimedTarget();
      return false;
    }
    cancelWeaponAttack({ ignoreReactionLock: this.ignoreReactionLock });
    return false;
  }

  startRightClickCancelCandidate(event) {
    this.rightClickCancelCandidate = {
      pointerId: event.pointerId,
      x: Number(event.clientX) || 0,
      y: Number(event.clientY) || 0,
      dragged: false
    };
  }

  updateRightClickCancelCandidate(event) {
    const candidate = this.rightClickCancelCandidate;
    if (!candidate) return;
    const pointerId = event?.pointerId ?? event?.nativeEvent?.pointerId;
    if (pointerId !== undefined && candidate.pointerId !== undefined && pointerId !== candidate.pointerId) return;
    if (getPointerDistanceFromEvent(event, candidate) >= getFoundryDragResistance()) candidate.dragged = true;
  }

  isRightClickDragCancel(event) {
    this.updateRightClickCancelCandidate(event);
    const manager = canvas.mouseInteractionManager;
    return Boolean(this.rightClickCancelCandidate?.dragged || (manager?._dragRight && manager?.state >= 4));
  }

  onTick() {
    if (isActorUnableToAct(this.token?.actor)) {
      this.interruptForIncapacitation();
      return;
    }
    if (this.processing || this.isInteractionLocked()) return;
    this.drawFocusedTargetMarkerForPreview(performance.now());
  }

  onItemUpdate(item = null, changes = {}, options = {}) {
    if (isDeusExMachinaProgressItemUpdate(changes, options)) return;
    if (
      this.processing
      || this.destroyed
      || item?.parent?.uuid !== this.token?.actor?.uuid
    ) return;
    this.syncWeaponNoisePreview();
  }

  async onConfirm(event) {
    if (event.button !== 0 || this.processing) return;
    event.stopPropagation?.();
    event.preventDefault?.();
    this.updatePointerFromClientEvent(event);
    return this.runInteractiveAttackOperation(() => this.performCurrentAttack());
  }

  isInteractionLocked() {
    return !this.ignoreReactionLock && isReactionSystemLocked();
  }

  interruptForIncapacitation() {
    if (!isActorUnableToAct(this.token?.actor)) return false;
    this.attackCanceledByReaction = true;
    this.requestFinish();
    return true;
  }

  async captureAttackSelection(data = {}) {
    if (!this.captureOnly) return false;
    const selection = {
      token: this.token,
      weapon: this.weapon,
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      pointer: serializePoint(this.pointer),
      geometry: serializeGeometry(this.geometry),
      lockedGeometry: this.lockedGeometry ?? serializeGeometry(this.geometry),
      targetUuid: this.selectedTarget?.document?.uuid ?? this.selectedTarget?.uuid ?? "",
      selectedLimbKey: this.selectedLimbKey,
      ...data
    };
    if (activeAttack === this) activeAttack = null;
    this.finishTargetSelection();
    this.destroy();
    await this.onCapture?.(selection);
    return true;
  }

  shouldUseOrdinaryGmAuthority() {
    return Boolean(
      this.useGmAuthority
      && !game.user?.isGM
      && game.user?.hasPermission?.("QUERY_USER") !== false
      && !this.captureOnly
      && !this.attackModifier
      && !this.onBeforeExecute
      && !this.chainRef
      && !this.abilityTrialSession
      && !this.volleyAction
      && !this.skipActionPointCost
      && !this.skipBaseWeaponResourceCosts
    );
  }

  filterTargetTokens(targets = []) {
    if (this.targetTokenUuidAllowlist === null) return targets;
    return targets.filter(target => this.targetTokenUuidAllowlist.has(getTokenDocumentUuid(target)));
  }

  getAttackResolutionTargets(geometry = this.geometry, {
    includeAttacker = false,
    includeDead = false
  } = {}) {
    if (!geometry) return [];
    const impactTargets = getPotentialTargets(this.token, geometry, {
      includeAttacker,
      includeDead,
      purpose: "impact"
    });
    const impactSet = new Set(impactTargets);
    return Array.from(new Set([
      ...(this.targets ?? []).filter(target => impactSet.has(target)),
      ...impactTargets
    ]));
  }

  async executeOrdinaryAttackViaGm(data = {}) {
    if (!this.shouldUseOrdinaryGmAuthority() || this.processing) return false;
    const gm = getOrdinaryAttackSceneGM(this.token);
    if (!gm) {
      ui.notifications.warn("Нет активного GM на сцене и уровне атаки.");
      return false;
    }

    const selection = serializeOrdinaryAttackSelection({
      token: this.token,
      weapon: this.weapon,
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      pointer: serializePoint(this.pointer),
      geometry: serializeGeometry(this.geometry),
      lockedGeometry: this.lockedGeometry ?? serializeGeometry(this.geometry),
      targetUuid: this.selectedTarget?.document?.uuid ?? this.selectedTarget?.uuid ?? "",
      selectedLimbKey: this.selectedLimbKey,
      operationId: foundry.utils.randomID(),
      previewAttackId: this.previewAttackId || this.attackId,
      ...data
    });

    this.authorityExecutionSucceeded = false;
    cancelPendingAttackAutoCoverSync(this.autoCoverAttackId);
    this.beginProcessingCycle();
    try {
      const result = await requestOrdinaryWeaponAttackOperation(gm, selection);
      this.authorityExecutionSucceeded = Boolean(result?.ok && result.executed);
      this.attackCanceledByReaction = Boolean(result?.canceledByReaction);
      this.attackCheckCount = Math.max(this.attackCheckCount, Math.max(0, toInteger(result?.attackCheckCount)));
      if (data.mode === "push" && result?.selectionCommitted) {
        this.pushStrengthMaximum = 0;
        this.removeLimbMenu();
      }
      if (result?.shouldFinish) this.finishRequested = true;
      if (!result?.ok && result?.reason && result.reason !== "authorityCancelled") {
        ui.notifications.warn(getOrdinaryAttackFailureMessage(result.reason));
      }
      return this.authorityExecutionSucceeded;
    } finally {
      this.completeProcessingCycle();
    }
  }

  finishTargetSelection({ cancelled = false, ...outcome } = {}) {
    const session = this.targetSelectionSession;
    if (!session) return false;
    this.targetSelectionSession = null;
    this.targetSelectionOutcome = {
      ...outcome,
      cancelled: Boolean(cancelled)
    };
    return session.finish(this.targetSelectionOutcome);
  }

  async performCurrentAttack() {
    if (this.interruptForIncapacitation()) return;
    if (this.targetedAction) return this.onAimedConfirm();
    if (!this.pointer) return;
    if (isWhirlwindAttackModifier(this.attackModifier)) return this.performWhirlwindAttack();
    if (this.actionKey === PUSH_ACTION_KEY) return this.preparePushAttack();
    if (this.volleyAction) return this.performVolleyAttack();
    this.refresh(true, { skipBurstDistribution: true });
    const actionContext = this.createWeaponActionContext();
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) return;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) return;
    if (this.captureOnly) return this.captureAttackSelection({ mode: "current" });
    if (this.shouldUseOrdinaryGmAuthority()) {
      return this.executeOrdinaryAttackViaGm({ mode: "current" });
    }
    const originalTarget = this.trajectoryAimTarget;
    if (hasWeaponSpecialProperty(this.weapon, WEAPON_SPECIAL_PROPERTIES.hitAllConeTargets, this.weaponFunctionId)) {
      return this.performConeTargetsAttack({ attackCount, actionContext });
    }
    if (this.actionKey === "burst") {
      this.beginProcessingCycle();
      if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
      if (originalTarget) await this.commitWeaponAttack(originalTarget);
      return this.performBurstAttack({ attackCount, actionContext });
    }

    this.beginProcessingCycle();
    if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
    if (originalTarget) await this.commitWeaponAttack(originalTarget);
    this.pendingCriticalFailureResourceCosts = [];
    this.refresh(true);
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount });
    const totalAttackCount = duplicatePlan.totalAttackCount;
    const trajectories = [];
    const damageRequests = [];
    const damageResults = [];
    const forceBatchCheckMessage = totalAttackCount > 1;
    const collectCheckMessages = forceBatchCheckMessage
      || getWeaponProjectileCountPerAttack(this.weapon, this.weaponFunctionId) > 1
      || getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, {
      ...this.createWeaponDamageContext(),
      actor: this.token.actor,
      actionKey: this.actionKey
    }) > 0;
    const checkBatch = collectCheckMessages
      ? this.createSkillCheckCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    let attempted = false;
    for (let attackIndex = 0; attackIndex < totalAttackCount; attackIndex += 1) {
      this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
      const result = await this.resolveAttackPellets({
        checkBatch,
        attackIndex,
        attackCount: totalAttackCount,
        burstAttackIndex: attackIndex
      });
      await this.dodgeExposure.flush();
      for (const trajectory of result.trajectories) {
        trajectories.push({ ...trajectory, delayGroup: attackIndex });
      }
      damageRequests.push(...result.damageRequests);
      attempted ||= result.attempted;
      if (this.attackCanceledByReaction) break;
    }

    if (attempted) {
      await this.spendCurrentAttackCosts({
        attackCount: totalAttackCount,
        point: getAttackLandingPoint(trajectories, this.pointer),
        actionContext
      });
    }
    await checkBatch?.publish({ forceBatch: forceBatchCheckMessage });
    await this.playAttackAnimationsIfNeeded(trajectories, { attempted });
    this.releaseInteractiveControl();
    if (!this.attackCanceledByReaction && damageRequests.length) {
      damageResults.push(...flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests))));
    }
    await this.notifyAttackResolved({ attempted, damageResults, killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults) });
    this.completeProcessingCycle();
  }

  async performWhirlwindAttack() {
    if (this.processing || !this.geometry) return;

    this.refresh(true);
    const targets = Array.from(new Set(this.getAttackResolutionTargets()))
      .filter(target => target && target !== this.token);
    if (!targets.length) {
      ui.notifications.warn(`${this.attackModifier?.label || this.weapon.name}: нет целей в радиусе атаки.`);
      return;
    }

    const attacksPerTarget = Math.max(
      1,
      toInteger(1 + getActorSkillValue(this.token.actor, "athletics") / 80)
    );
    const plannedAttackCount = targets.length * attacksPerTarget;
    const actionContext = this.createWeaponActionContext();
    if (!this.hasRequiredWeaponResources(plannedAttackCount)) return;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) return;

    if (typeof this.attackModifier?.onBeforeAttack === "function") {
      const allowed = await this.attackModifier.onBeforeAttack({
        actor: this.token.actor,
        token: this.token,
        weapon: this.weapon,
        actionKey: this.actionKey,
        weaponFunctionId: this.weaponFunctionId,
        attackModifier: this.attackModifier,
        controller: this
      });
      if (!allowed) return;
    }

    this.beginProcessingCycle();
    this.pendingCriticalFailureResourceCosts = [];
    this.refresh(true);
    this.registerAbilityTrialTargets(targets);
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount: plannedAttackCount });
    const totalCycles = attacksPerTarget * duplicatePlan.cycles;

    const damageRequests = [];
    const damageResults = [];
    const trajectories = [];
    const checkBatch = this.createSkillCheckCollector({
      requester: "weaponAttack",
      title: this.attackModifier?.label || this.weapon.name
    });
    const baseDamage = getAttackModeDamage(this.weapon, this.actionKey, "swing", this.getWeaponDamage(), this.weaponFunctionId, {
      percentBaseAmount: this.getWeaponDamagePercentBase()
    });
    let attempted = false;
    let attemptedAttackCount = 0;

    this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let cycleIndex = 0; cycleIndex < totalCycles; cycleIndex += 1) {
      for (const target of targets) {
        if (this.attackCanceledByReaction) break;
        attempted = true;
        attemptedAttackCount += 1;
        const trajectory = buildSwingAnimationTrajectory(this.token, [target], "rightToLeft", this.geometry);
        if (trajectory) trajectories.push({ ...trajectory, delayGroup: cycleIndex });
        const request = await this.resolveDirectedAttackAgainstTarget(target, {
          mode: "swing",
          damageAmount: baseDamage,
          difficultyBonus: 0,
          penetrationStep: 0,
          checkBatch
        });
        if (this.attackCanceledByReaction) break;
        if (!request?.length) continue;
        damageRequests.push(...request);
      }
      if (this.attackCanceledByReaction) break;
    }
    await this.dodgeExposure.flush();

    if (attempted) {
      await this.spendCurrentAttackCosts({
        attackCount: Math.max(1, attemptedAttackCount),
        point: getAttackLandingPoint(trajectories, getTokenAimPoint(this.token)),
        actionContext
      });
    }
    await checkBatch.publish({ forceBatch: targets.length > 1 || totalCycles > 1 });
    await this.playAttackAnimationsIfNeeded(trajectories, { attempted });
    this.releaseInteractiveControl();
    if (!this.attackCanceledByReaction && damageRequests.length) damageResults.push(...flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests))));

    await this.notifyAttackResolved({ attempted, damageResults, killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults) });
    this.completeProcessingCycle();
  }

  async performConeTargetsAttack({ attackCount = 1, actionContext = null } = {}) {
    this.beginProcessingCycle();
    if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
    this.pendingCriticalFailureResourceCosts = [];
    this.refresh(true);
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount });
    const totalAttackCount = duplicatePlan.totalAttackCount;
    const resolutionTargets = this.getAttackResolutionTargets();
    this.registerAbilityTrialTargets(resolutionTargets);

    const trajectories = [];
    const damageRequests = [];
    const damageResults = [];
    const projectileCountPerAttack = getWeaponProjectileCountPerAttack(
      this.weapon,
      this.weaponFunctionId
    );
    const forceBatchCheckMessage = totalAttackCount > 1
      || resolutionTargets.length > 1
      || projectileCountPerAttack > 1;
    const checkBatch = forceBatchCheckMessage || getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, {
      ...this.createWeaponDamageContext(),
      actor: this.token.actor,
      actionKey: this.actionKey
    }) > 0
      ? this.createSkillCheckCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    let attempted = false;

    this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let attackIndex = 0; attackIndex < totalAttackCount; attackIndex += 1) {
      if (this.attackCanceledByReaction) break;
      const projectiles = createWeaponPelletImpactProjectiles(
        this.weapon,
        this.weaponFunctionId,
        this.getWeaponDamage()
      );
      const animationTrajectory = buildConeAnimationTrajectory(this.geometry);
      if (animationTrajectory) trajectories.push({ ...animationTrajectory, delayGroup: attackIndex });
      attempted = true;

      for (const target of resolutionTargets) {
        if (this.attackCanceledByReaction) break;
        for (const [projectileIndex, projectile] of projectiles.entries()) {
          if (this.attackCanceledByReaction) break;
          if (projectile.damageAmount <= 0) continue;
          const totalProjectileCount = totalAttackCount * projectiles.length;
          const request = await this.resolveAttackAgainstTarget(target, {
            damageAmount: projectile.damageAmount,
            damageShareIndex: projectileIndex,
            damageShareCount: projectiles.length,
            pelletImpactCount: projectile.pelletImpactCount,
            burstAttackIndex: attackIndex,
            penetrationStep: 0,
            checkBatch,
            allOrNothingContext: this.createAllOrNothingAttackContext({
              mode: projectiles.length > 1
                ? "pellet"
                : (
                  totalAttackCount > 1
                  && hasConcentratedPelletImpact(this.weapon, this.weaponFunctionId)
                    ? "burst"
                    : ""
                ),
              index: (attackIndex * projectiles.length) + projectileIndex,
              count: totalProjectileCount
            })
          });
          if (request) damageRequests.push(...request);
        }
      }
    }
    await this.dodgeExposure.flush();

    if (attempted) {
      await this.spendCurrentAttackCosts({
        attackCount: totalAttackCount,
        point: getAttackLandingPoint(trajectories, this.pointer),
        actionContext
      });
    }
    await checkBatch?.publish({ forceBatch: forceBatchCheckMessage });
    await this.playAttackAnimationsIfNeeded(trajectories, { attempted });
    this.releaseInteractiveControl();
    if (!this.attackCanceledByReaction && damageRequests.length) damageResults.push(...flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests))));

    await this.notifyAttackResolved({ attempted, damageResults, killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults) });
    this.completeProcessingCycle();
  }

  preparePushAttack() {
    if (this.processing || this.pushStrengthMaximum > 0 || !this.geometry) return;
    if (!this.hasRequiredWeaponResources(1)) return;
    const actionContext = this.createWeaponActionContext();
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) return;
    if (!this.filterTargetTokens(getPotentialTargets(this.token, this.geometry, {
      targetTokenUuidAllowlist: this.targetTokenUuidAllowlist
    })).length) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Settings.HUD.NoPushTargets"));
      return;
    }
    const maximumStrength = getKnockbackMaximumStrength(this.getPushDifficulty());
    if (maximumStrength <= 1) return this.performPushAttack(1);
    this.lockedGeometry = serializeGeometry(this.geometry);
    this.pushStrengthMaximum = maximumStrength;
    this.removeChanceMenu();
    this.refresh(true);
    this.refreshPushStrengthMenu();
  }

  cancelPushStrengthSelection() {
    this.pushStrengthMaximum = 0;
    this.lockedGeometry = null;
    this.hoveredLimbKey = "";
    this.removeLimbMenu();
    this.refresh(true);
  }

  getPushDifficulty() {
    return 50 + getActorSkillValue(this.token.actor, "ath")
      + getWeaponPushDifficultyModifier(this.weapon, this.weaponFunctionId);
  }

  async performPushAttack(selectedStrength = 1) {
    if (this.processing || !this.geometry) return;
    if (!this.hasRequiredWeaponResources(1)) return;
    const actionContext = this.createWeaponActionContext();
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) return;
    if (this.captureOnly) {
      return this.captureAttackSelection({
        mode: "push",
        selectedStrength: Math.max(1, toInteger(selectedStrength))
      });
    }
    if (this.shouldUseOrdinaryGmAuthority()) {
      return this.executeOrdinaryAttackViaGm({
        mode: "push",
        selectedStrength: Math.max(1, toInteger(selectedStrength))
      });
    }

    this.beginProcessingCycle();
    if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
    this.pushStrengthMaximum = 0;
    this.removeLimbMenu();
    this.pendingCriticalFailureResourceCosts = [];
    this.refresh(true);

    const targets = this.filterTargetTokens(getPotentialTargets(this.token, this.geometry, {
      targetTokenUuidAllowlist: this.targetTokenUuidAllowlist
    }));
    if (!targets.length) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Settings.HUD.NoPushTargets"));
      this.completeProcessingCycle();
      return;
    }
    const trajectories = buildAttackTrajectories(this.token, this.geometry, targets, Math.max(1, targets.length))
      .map(trajectory => ({ ...trajectory, delayGroup: 0 }));
    const forceBatchCheckMessage = targets.length > 1;
    const checkBatch = this.createSkillCheckCollector({
      requester: "weaponPush",
      title: this.weapon.name
    });
    let attempted = false;
    const hitTargets = [];

    this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (const target of targets) {
      const hit = await this.resolvePushHit(target, { checkBatch });
      attempted ||= Boolean(hit?.attempted);
      if (hit?.canceled || this.attackCanceledByReaction) break;
      if (!hit?.success) continue;
      hitTargets.push(target);
    }
    await this.dodgeExposure.flush();
    await checkBatch.publish({ forceBatch: forceBatchCheckMessage });
    this.releaseInteractiveControl();

    const pushDifficulty = this.getPushDifficulty();
    if (selectedStrength > 0) {
      for (const target of hitTargets) {
        await resolveKnockback({
          attackerToken: this.token,
          targetToken: target,
          difficulty: pushDifficulty,
          maximumStrength: selectedStrength,
          reason: this.weapon.name,
          requester: "weaponPushResistance"
        });
      }
    }

    if (attempted) {
      await this.spendCurrentAttackCosts({
        attackCount: 1,
        point: getAttackLandingPoint(trajectories, this.pointer),
        actionContext
      });
    }
    await this.playAttackAnimationsIfNeeded(trajectories, { attempted });
    await this.notifyAttackResolved();
    this.completeProcessingCycle();
  }

  async resolvePushHit(target, { checkBatch = null } = {}) {
    if (await this.resolveTargetReactions(target)) return { attempted: true, success: false, canceled: true };
    const attackContext = this.createWeaponAttackSkillCheckContext(target);
    this.dodgeExposure.record(target.actor, { ...attackContext, requester: "weaponPush" });
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(
      this.weapon,
      this.token,
      target,
      this.weaponFunctionId,
      attackContext
    );
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      messageData: this.chatMessageAuthorId ? { author: this.chatMessageAuthorId } : {},
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getDodgeDifficulty(target.actor) + rangeDifficultyBonus + requirementDifficultyBonus,
        situationalModifier: this.getAccuracyModifier(getWeaponPushAccuracyModifier(this.weapon, this.weaponFunctionId, attackContext)),
        ...getWeaponCriticalCheckModifiers(this.weapon, this.weaponFunctionId, attackContext),
        ...attackContext
      },
      animate: false,
      createMessage: !checkBatch,
      completionCollector: checkBatch,
      prompt: false,
      requester: "weaponPush"
    });
    this.attackCheckCount += 1;
    checkBatch?.add(outcome);
    this.recordCriticalFailureConsequences(outcome);
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    return {
      attempted: true,
      success: isSuccessfulAttack(outcome)
    };
  }

  async performBurstAttack({ attackCount = 1, actionContext = null } = {}) {
    this.beginProcessingCycle();
    this.pendingCriticalFailureResourceCosts = [];
    this.refresh(true, { skipBurstDistribution: true });
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount });
    const totalAttackCount = duplicatePlan.totalAttackCount;

    const trajectories = [];
    const damageRequests = [];
    const damageResults = [];
    const forceBatchCheckMessage = totalAttackCount > 1;
    const collectCheckMessages = forceBatchCheckMessage
      || getWeaponProjectileCountPerAttack(this.weapon, this.weaponFunctionId) > 1
      || getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, {
      ...this.createWeaponDamageContext(),
      actor: this.token.actor,
      actionKey: this.actionKey
    }) > 0;
    const checkBatch = collectCheckMessages
      ? this.createSkillCheckCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    const projectileCount = getBurstProjectileCount(
      totalAttackCount,
      getWeaponProjectileCountPerAttack(this.weapon, this.weaponFunctionId)
    );
    const exactDistribution = getBurstTargetHitDistribution(
      this.token,
      this.geometry,
      this.targets,
      projectileCount,
      { purpose: "resolution" }
    );
    const burstRanges = buildBurstTargetRanges(
      this.token,
      this.geometry,
      this.targets,
      projectileCount,
      { purpose: "resolution", distribution: exactDistribution }
    );
    const primaryShots = buildBurstPrimaryShotsForRanges(
      this.token,
      this.geometry,
      projectileCount,
      this.targets,
      burstRanges,
      { distribution: exactDistribution }
    );
    let attempted = false;

    this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let attackIndex = 0; attackIndex < totalAttackCount; attackIndex += 1) {
      if (this.attackCanceledByReaction) break;
      const projectiles = createWeaponPelletImpactProjectiles(
        this.weapon,
        this.weaponFunctionId,
        this.getWeaponDamage()
      );

      for (let shotIndex = 0; shotIndex < projectiles.length; shotIndex += 1) {
        if (this.attackCanceledByReaction) break;
        const projectile = projectiles[shotIndex];
        const projectileIndex = (attackIndex * projectiles.length) + shotIndex;
        const primaryTrajectory = primaryShots[projectileIndex]?.trajectory ?? buildRandomTrajectory(this.token, getRandomBurstMissGeometry(this.token, this.geometry));
        const trajectory = primaryTrajectory;
        attempted = true;
        const result = await this.resolveAttackTrajectory({
          checkBatch,
          trajectory,
          baseDamage: projectile?.damageAmount ?? 0,
          damageShareIndex: shotIndex,
          damageShareCount: projectiles.length,
          pelletImpactCount: projectile?.pelletImpactCount ?? 1,
          burstAttackIndex: attackIndex,
          allOrNothingContext: this.createAllOrNothingAttackContext({
            mode: "burst",
            index: projectileIndex,
            count: projectileCount
          })
        });
        trajectories.push({ ...(result.trajectory ?? trajectory), delayGroup: attackIndex });
        damageRequests.push(...result.damageRequests);
      }
    }
    await this.dodgeExposure.flush();

    if (attempted) {
      await this.spendCurrentAttackCosts({
        attackCount: totalAttackCount,
        point: getAttackLandingPoint(trajectories, this.pointer),
        actionContext
      });
    }
    await checkBatch?.publish({ forceBatch: forceBatchCheckMessage });
    await this.playAttackAnimationsIfNeeded(trajectories, { attempted });
    this.releaseInteractiveControl();
    if (!this.attackCanceledByReaction && damageRequests.length) {
      damageResults.push(...flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests))));
    }
    await this.notifyAttackResolved({ attempted, damageResults, killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults) });
    this.completeProcessingCycle();
  }

  onAimedConfirm() {
    if (this.aimedMode !== "aim" || !this.geometry) return undefined;
    if (!this.hoveredTarget) {
      if (this.actionKey === "meleeAttack" && !this.requiresLimbSelection) {
        void this.runInteractiveAttackOperation(() => this.performUnaimedMeleeAttack());
      }
      return undefined;
    }
    const actionContext = this.createWeaponActionContext({ targetToken: this.hoveredTarget });
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) return undefined;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) return undefined;

    this.selectedTarget = this.hoveredTarget;
    this.lockedGeometry = serializeGeometry(this.geometry);
    this.selectedLimbKey = "";
    if (!this.requiresLimbSelection && !this.requiresDirectionSelection) {
      if (this.captureOnly) {
        void this.runInteractiveAttackOperation(() => this.captureAttackSelection({ mode: "current" }));
        return undefined;
      }
      if (this.shouldUseOrdinaryGmAuthority()) {
        void this.runInteractiveAttackOperation(() => this.executeOrdinaryAttackViaGm({ mode: "current" }));
        return undefined;
      }
      this.targetedAction = false;
      this.refresh(true);
      void this.runInteractiveAttackOperation(() => this.performCurrentAttack());
      return undefined;
    }
    this.aimedMode = this.requiresLimbSelection ? "limb" : "direction";
    this.refresh(true);
    this.refreshAimedLimbMenu();
    return undefined;
  }

  async performUnaimedMeleeAttack() {
    if (
      this.processing
      || this.actionKey !== "meleeAttack"
      || this.aimedMode !== "aim"
      || !this.geometry
    ) return false;
    if (this.interruptForIncapacitation()) return false;

    this.refresh(true);
    const geometry = deserializeGeometry(this.lockedGeometry) ?? this.geometry;
    if (!geometry) return false;
    const enabledDirections = getEnabledMeleeDirections(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!enabledDirections.length) {
      ui.notifications.warn(`${this.weapon.name}: нет разрешённого направления удара.`);
      return false;
    }

    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    const actionContext = this.createWeaponActionContext({ targetToken: null, geometry });
    if (!this.hasRequiredWeaponResources(attackCount)) return false;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) return false;
    if (this.captureOnly) return this.captureAttackSelection({ mode: UNAIMED_ATTACK_MODE });
    if (this.shouldUseOrdinaryGmAuthority()) {
      return this.executeOrdinaryAttackViaGm({ mode: UNAIMED_ATTACK_MODE });
    }

    this.beginProcessingCycle();
    this.pendingCriticalFailureResourceCosts = [];
    this.removeLimbMenu();
    if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
    this.refresh(true);

    const resolvedGeometry = deserializeGeometry(this.lockedGeometry) ?? this.geometry;
    const direction = selectRandomMeleeDirection(
      getEnabledMeleeDirections(this.weapon, this.actionKey, this.weaponFunctionId)
    );
    if (!direction) return this.completeProcessingCycle();
    const impactTargets = this.getAttackResolutionTargets(resolvedGeometry);
    const thrustTrajectory = direction.mode === "thrust"
      ? buildTrajectoryByAngle(
        this.token,
        resolvedGeometry,
        Number(resolvedGeometry.angle) || 0,
        Number(resolvedGeometry.elevationSlope) || 0
      )
      : null;
    const selectedTarget = direction.mode === "swing"
      ? getUnaimedSwingTargetSequence(direction.key, impactTargets, resolvedGeometry).at(0) ?? null
      : getTrajectoryTargetEntries(
        this.token,
        thrustTrajectory,
        this.targetTokenUuidAllowlist,
        { purpose: "impact" }
      ).at(0)?.target ?? null;

    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount });
    const totalAttackCount = duplicatePlan.totalAttackCount;
    const damageRequests = [];
    const damageResults = [];
    const trajectories = [];
    const checkBatch = selectedTarget
      ? this.createSkillCheckCollector({ requester: "weaponAttack", title: this.weapon.name })
      : null;
    let attempted = false;

    this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let cycleIndex = 0; cycleIndex < duplicatePlan.cycles; cycleIndex += 1) {
      if (this.attackCanceledByReaction) break;
      if (direction.mode === "thrust") {
        const trajectory = foundry.utils.deepClone(thrustTrajectory);
        if (selectedTarget) {
          const result = await this.resolveDirectedThrustTrajectory(selectedTarget, trajectory, { checkBatch });
          damageRequests.push(...result.damageRequests);
          trajectories.push({ ...result.trajectory, delayGroup: cycleIndex });
        } else {
          trajectories.push({ ...trajectory, delayGroup: cycleIndex });
        }
        attempted = true;
      } else if (selectedTarget) {
        const result = await this.resolveDirectedSwing(selectedTarget, direction.key, {
          checkBatch,
          geometry: resolvedGeometry,
          targets: impactTargets
        });
        damageRequests.push(...result.damageRequests);
        if (result.trajectory) trajectories.push({ ...result.trajectory, delayGroup: cycleIndex });
        attempted ||= result.attempted;
      } else {
        const trajectory = buildConeAnimationTrajectory(resolvedGeometry);
        if (trajectory) trajectories.push({ ...trajectory, delayGroup: cycleIndex });
        attempted = true;
      }
    }
    await this.dodgeExposure.flush();

    if (attempted) {
      await this.spendCurrentAttackCosts({
        attackCount: totalAttackCount,
        point: getAttackLandingPoint(trajectories, resolvedGeometry.end ?? this.pointer),
        actionContext
      });
    }
    await checkBatch?.publish({ forceBatch: duplicatePlan.cycles > 1 });
    await this.playAttackAnimationsIfNeeded(trajectories, { attempted });
    this.releaseInteractiveControl();
    if (!this.attackCanceledByReaction && damageRequests.length) {
      damageResults.push(...flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests))));
    }
    await this.notifyAttackResolved({
      attempted,
      damageResults,
      killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults)
    });
    this.completeProcessingCycle();
    return true;
  }

  refreshInactiveAttackerPerception({ force = false } = {}) {
    if (this.fixedTargetTokenUuidAllowlist || !globalThis.canvas?.ready) return;
    if (this.token?.vision?.active) {
      this.targetTokenUuidAllowlist = null;
      return;
    }
    if (force || this.targetTokenUuidAllowlist === null) {
      this.targetTokenUuidAllowlist = getAuthoritativeAttackPerceptionUuids(this.token);
    }
  }

  async performAimedAttack(limbKey) {
    if (this.processing || this.aimedMode !== "limb" || !this.selectedTarget) return;
    if (this.interruptForIncapacitation()) return;
    const target = this.selectedTarget;
    const aimedRangeState = this.getAimedTargetRangeState(target);
    if (aimedRangeState.allowed === false) {
      if (!this.headlessExecution) ui.notifications.warn(formatAimedRangeBlockReason(aimedRangeState));
      return;
    }
    const actionContext = this.createWeaponActionContext({ targetToken: target });
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) {
      if (this.attackModifier?.preventCancel) this.requestFinish();
      return;
    }
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) {
      if (this.attackModifier?.preventCancel) this.requestFinish();
      return;
    }
    const targetSelection = resolveAimedTargetSelection(target.actor, limbKey);
    if (!targetSelection) {
      if (this.attackModifier?.preventCancel) this.requestFinish();
      return;
    }
    this.selectedLimbKey = limbKey;
    if (this.captureOnly) {
      return this.captureAttackSelection({
        mode: "aimed",
        selectedLimbKey: limbKey
      });
    }
    if (this.shouldUseOrdinaryGmAuthority()) {
      return this.executeOrdinaryAttackViaGm({
        mode: "aimed",
        selectedLimbKey: limbKey
      });
    }

    this.beginProcessingCycle();
    this.pendingCriticalFailureResourceCosts = [];
    this.removeLimbMenu();
    this.refresh(true);
    if (!this.attackModifier?.suppressCounterSniperReaction) {
      const reactionResult = await this.requestAimedLimbSelectedReaction(target, limbKey);
      if (
        reactionResult?.handled
        || reactionResult?.status === REACTION_RESULT.success
        || reactionResult?.status === REACTION_RESULT.failed
      ) {
        this.finishRequested = true;
        this.authorityShouldFinish = true;
      }
      if (this.interruptForIncapacitation()) return this.completeProcessingCycle();
    }
    if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
    await this.commitWeaponAttack(target, { limbKey });
    this.refresh(true);
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount });
    const totalAttackCount = duplicatePlan.totalAttackCount;

    const geometry = deserializeGeometry(this.lockedGeometry) ?? this.geometry;
    const aimPoint = selectTargetTrajectoryAimPoint(this.token, target, geometry) ?? getTokenAimPoint(target);
    const centerTrajectory = buildTrajectoryThroughPoint(this.token, geometry, aimPoint);
    const projectiles = createWeaponPelletImpactProjectiles(
      this.weapon,
      this.weaponFunctionId,
      this.getWeaponDamage()
    );
    const trajectories = buildAimedAttackTrajectories(
      this.token,
      geometry,
      centerTrajectory,
      target,
      projectiles.length
    );
    const checkBatch = (duplicatePlan.cycles > 1 || projectiles.length > 1 || getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, {
      ...this.createWeaponDamageContext({ targetToken: target }),
      actor: this.token.actor,
      actionKey: this.actionKey
    }) > 0)
      ? this.createSkillCheckCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    const damageRequests = [];
    const damageResults = [];
    const allTrajectories = [];
    const totalPelletCount = duplicatePlan.cycles * trajectories.length;

    this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let cycleIndex = 0; cycleIndex < duplicatePlan.cycles; cycleIndex += 1) {
      for (const [index, trajectory] of trajectories.entries()) {
        if (this.attackCanceledByReaction) break;
        const projectile = projectiles[index];
        const result = await this.resolveAimedPelletTrajectory(target, { ...trajectory }, targetSelection, {
          forceAimed: index === 0,
          checkBatch,
          baseDamage: projectile?.damageAmount ?? 0,
          damageShareIndex: index,
          damageShareCount: trajectories.length,
          pelletImpactCount: projectile?.pelletImpactCount ?? 1,
          allOrNothingContext: this.createAllOrNothingAttackContext({
            mode: trajectories.length > 1 || duplicatePlan.cycles > 1 ? "pellet" : "",
            index: (cycleIndex * trajectories.length) + index,
            count: totalPelletCount
          })
        });
        allTrajectories.push({ ...(result.trajectory ?? trajectory), delayGroup: cycleIndex });
        damageRequests.push(...result.damageRequests);
        if (this.attackCanceledByReaction) break;
      }
      if (this.attackCanceledByReaction) break;
    }
    await this.dodgeExposure.flush();

    await this.spendCurrentAttackCosts({
      attackCount: totalAttackCount,
      point: allTrajectories[0]?.end ?? trajectories[0]?.end ?? getTokenAimPoint(target),
      actionContext
    });
    await checkBatch?.publish({ forceBatch: duplicatePlan.cycles > 1 });
    await this.playAttackAnimationsIfNeeded(allTrajectories);
    this.releaseInteractiveControl();
    if (!this.attackCanceledByReaction && damageRequests.length) damageResults.push(...flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests))));

    await this.notifyAttackResolved({ damageResults, killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults) });
    this.completeProcessingCycle();
  }

  async requestAimedLimbSelectedReaction(target, limbKey = "") {
    if (this.actionKey !== "aimedShot" || isPhantomEntity(target)) return undefined;
    const attackDistanceContext = this.createWeaponAttackReactionContext(target);
    return this.requestReaction(REACTION_EVENT_KEYS.aimedAttackLimbSelected, {
      attackId: this.attackId,
      attackerActorUuid: this.token?.actor?.uuid ?? "",
      attackerTokenUuid: this.token?.document?.uuid ?? "",
      targetActorUuid: target?.actor?.uuid ?? "",
      targetTokenUuid: target?.document?.uuid ?? "",
      weaponUuid: this.weapon?.uuid ?? "",
      weaponFunctionId: this.weaponFunctionId,
      actionKey: this.actionKey,
      limbKey: String(limbKey ?? ""),
      ...attackDistanceContext,
      title: "Контр-снайпер",
      message: `${this.token?.actor?.name ?? ""} выбрал часть тела для прицельного выстрела по ${target?.actor?.name ?? ""}.`
    });
  }

  async resolveAimedPelletTrajectory(selectedTarget, trajectory, targetSelection, {
    forceAimed = false,
    baseDamage = null,
    damageShareIndex = 0,
    damageShareCount = 1,
    pelletImpactCount = 1,
    checkBatch = null,
    allOrNothingContext = null
  } = {}) {
    if (forceAimed || doesTrajectoryHitTarget(
      this.token,
      selectedTarget,
      trajectory,
      this.targetTokenUuidAllowlist
    )) {
      const blockerCount = this.ignoreAimedObstructions
        ? 0
        : getAimedTargetBlockers(
          this.token,
          selectedTarget,
          trajectory,
          this.targetTokenUuidAllowlist,
          { purpose: "impact" }
        ).length;
      return this.resolveAimedAttackTrajectory(selectedTarget, trajectory, targetSelection, {
        blockerBonus: getAimedTargetBlockerBonus(blockerCount),
        baseDamage,
        damageShareIndex,
        damageShareCount,
        pelletImpactCount,
        checkBatch,
        allOrNothingContext
      });
    }

    return this.resolveAttackTrajectory({
      checkBatch,
      trajectory,
      baseDamage,
      damageShareIndex,
      damageShareCount,
      pelletImpactCount,
      allOrNothingContext
    });
  }

  async performDirectedAttack(directionKey) {
    if (this.processing || this.aimedMode !== "direction" || !this.selectedTarget) return;
    const direction = getEnabledMeleeDirections(this.weapon, this.actionKey, this.weaponFunctionId)
      .find(entry => entry.key === directionKey);
    if (!direction) return;
    const target = this.selectedTarget;
    const actionContext = this.createWeaponActionContext({ targetToken: target });
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) return;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) return;
    if (this.captureOnly) {
      return this.captureAttackSelection({
        mode: "directed",
        directionKey: direction.key,
        selectedLimbKey: this.selectedLimbKey
      });
    }
    if (this.shouldUseOrdinaryGmAuthority()) {
      return this.executeOrdinaryAttackViaGm({
        mode: "directed",
        directionKey: direction.key,
        selectedLimbKey: this.selectedLimbKey
      });
    }

    this.beginProcessingCycle();
    this.pendingCriticalFailureResourceCosts = [];
    this.removeLimbMenu();
    if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
    await this.commitWeaponAttack(this.selectedTarget, { limbKey: this.selectedLimbKey, direction });
    this.refresh(true);
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount });
    const totalAttackCount = duplicatePlan.totalAttackCount;

    const geometry = deserializeGeometry(this.lockedGeometry) ?? this.geometry;
    const damageRequests = [];
    const damageResults = [];
    let trajectories = [];
    let attempted = false;

    const checkBatch = this.createSkillCheckCollector({
      requester: "weaponAttack",
      title: this.weapon.name
    });

    this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let cycleIndex = 0; cycleIndex < duplicatePlan.cycles; cycleIndex += 1) {
      if (this.attackCanceledByReaction) break;
      if (direction.mode === "thrust") {
        const aimPoint = selectTargetTrajectoryAimPoint(this.token, target, geometry) ?? getTokenAimPoint(target);
        const trajectory = buildTrajectoryThroughPoint(this.token, geometry, aimPoint);
        const result = await this.resolveDirectedThrustTrajectory(target, trajectory, {
          limbKey: this.selectedLimbKey,
          checkBatch
        });
        damageRequests.push(...result.damageRequests);
        trajectories.push({ ...result.trajectory, delayGroup: cycleIndex });
        attempted = true;
      } else {
        const result = await this.resolveDirectedSwing(target, direction.key, {
          limbKey: this.selectedLimbKey,
          checkBatch,
          geometry
        });
        damageRequests.push(...result.damageRequests);
        trajectories.push({ ...result.trajectory, delayGroup: cycleIndex });
        attempted ||= result.attempted;
      }
    }
    await this.dodgeExposure.flush();

    if (attempted) {
      await this.spendCurrentAttackCosts({
        attackCount: totalAttackCount,
        point: getAttackLandingPoint(trajectories, getTokenAimPoint(target)),
        actionContext
      });
    }
    await checkBatch.publish({ forceBatch: duplicatePlan.cycles > 1 });
    await this.playAttackAnimationsIfNeeded(trajectories, { attempted });
    this.releaseInteractiveControl();
    if (!this.attackCanceledByReaction && damageRequests.length) damageResults.push(...flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests))));

    await this.notifyAttackResolved({ attempted, damageResults, killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults) });
    this.completeProcessingCycle();
  }

  async resolveDirectedThrustTrajectory(selectedTarget, trajectory, { limbKey = "", checkBatch = null } = {}) {
    const damageRequests = [];
    const baseDamage = getAttackModeDamage(this.weapon, this.actionKey, "thrust", this.getWeaponDamage(), this.weaponFunctionId, {
      percentBaseAmount: this.getWeaponDamagePercentBase()
    });
    const targets = getTrajectoryTargetEntries(this.token, trajectory, this.targetTokenUuidAllowlist, { purpose: "impact" });
    this.registerAbilityTrialTargets([
      selectedTarget,
      ...targets.map(entry => entry.target)
    ]);
    const selectedEntry = targets.find(entry => entry.target === selectedTarget)
      ?? { target: selectedTarget, hit: getTokenTrajectoryHit(selectedTarget, trajectory) };
    const subsequentTargets = targets.filter(entry => (
      entry.target !== selectedTarget
      && (!selectedEntry.hit || entry.hit.distance > selectedEntry.hit.distance + 0.5)
    ));

    let penetrationsUsed = 0;
    let lastPenetrationPower = 0;
    let finalAnimationPoint = null;
    let hasSuccessfulHit = false;

    const firstRequest = await this.resolveDirectedAttackAgainstTarget(selectedTarget, {
      limbKey,
      mode: "thrust",
      damageAmount: getPenetratedDamageAmount(baseDamage, 0),
      penetrationStep: 0,
      checkBatch
    });
    if (!firstRequest) {
      updateTrajectoryEnd(trajectory, selectMissPointNearTarget(this.token, selectedTarget, trajectory));
      return { damageRequests, trajectory, checkBatch };
    }

    finalAnimationPoint = selectPointOnTrajectoryPastTarget(selectedTarget, trajectory);
    if (firstRequest.length) {
      damageRequests.push(...firstRequest);
      hasSuccessfulHit = true;
      lastPenetrationPower = getDamageRequestGroupPenetrationPower(firstRequest);
      const resolvedFirstLimbKey = limbKey || getSingleDamageRequestLimbKey(firstRequest);
      if (doesDamageRequestGroupPenetratePart(firstRequest, selectedTarget.actor, { type: "limb", limbKey: resolvedFirstLimbKey })) penetrationsUsed += 1;
    }

    for (const entry of subsequentTargets) {
      const passthroughStep = hasSuccessfulHit ? penetrationsUsed : 0;
      if (hasSuccessfulHit && (penetrationsUsed <= 0 || penetrationsUsed > lastPenetrationPower)) break;
      const damageAmount = getPenetratedDamageAmount(baseDamage, passthroughStep);
      if (damageAmount <= 0) break;

      const request = await this.resolveDirectedAttackAgainstTarget(entry.target, {
        mode: "thrust",
        damageAmount,
        difficultyBonus: passthroughStep * 20,
        penetrationStep: passthroughStep,
        checkBatch
      });
      if (!request) break;
      if (!request.length) {
        finalAnimationPoint = selectPointOnTrajectoryPastTarget(entry.target, trajectory);
        continue;
      }

      damageRequests.push(...request);
      hasSuccessfulHit = true;
      finalAnimationPoint = selectPointOnTrajectoryPastTarget(entry.target, trajectory);
      lastPenetrationPower = getDamageRequestGroupPenetrationPower(request);
      if (penetrationsUsed >= lastPenetrationPower) break;

      const resolvedLimbKey = getSingleDamageRequestLimbKey(request);
      if (!doesDamageRequestGroupPenetratePart(request, entry.target.actor, { type: "limb", limbKey: resolvedLimbKey })) break;
      penetrationsUsed += 1;
    }

    if (finalAnimationPoint) {
      if (hasSuccessfulHit) updateTrajectoryDistanceEnd(trajectory, finalAnimationPoint);
      else updateTrajectoryEnd(trajectory, finalAnimationPoint);
    }
    return { damageRequests, trajectory, checkBatch };
  }

  async resolveDirectedSwing(selectedTarget, directionKey, {
    limbKey = "",
    checkBatch = null,
    geometry = null,
    targets = this.targets
  } = {}) {
    const damageRequests = [];
    const targetSequence = getSwingTargetSequence(selectedTarget, directionKey, targets, geometry ?? this.geometry);
    this.registerAbilityTrialTargets(targetSequence);
    const hitTargets = [];
    const baseDamage = getAttackModeDamage(this.weapon, this.actionKey, "swing", this.getWeaponDamage(), this.weaponFunctionId, {
      percentBaseAmount: this.getWeaponDamagePercentBase()
    });

    for (const [index, target] of targetSequence.entries()) {
      const damageAmount = Math.max(0, Math.round(baseDamage * Math.max(0, 1 - (index * 0.2))));
      if (damageAmount <= 0) break;
      const request = await this.resolveDirectedAttackAgainstTarget(target, {
        limbKey: index === 0 ? limbKey : "",
        mode: "swing",
        damageAmount,
        difficultyBonus: index * 30,
        penetrationStep: index,
        checkBatch
      });
      if (!request) break;
      if (!request.length) continue;
      damageRequests.push(...request);
      hitTargets.push(target);
    }

    return {
      attempted: true,
      damageRequests,
      trajectory: buildSwingAnimationTrajectory(this.token, hitTargets.length ? hitTargets : [selectedTarget], directionKey, geometry ?? this.geometry)
    };
  }

  async resolveDirectedAttackAgainstTarget(target, { limbKey = "", mode = "thrust", damageAmount = 0, difficultyBonus = 0, penetrationStep = 0, checkBatch = null } = {}) {
    if (this.usesAbilityTrialResolution()) {
      return this.resolveAbilityTrialAttackAgainstTarget(target, {
        selectedLimbKey: limbKey,
        penetrationStep
      });
    }
    if (await this.resolveTargetReactions(target)) return null;
    const attackContext = this.createWeaponAttackSkillCheckContext(target);
    this.dodgeExposure.record(target.actor, attackContext);
    const resolvedLimbKey = limbKey || selectRandomLimbKey(target.actor);
    if (!resolvedLimbKey || isLimbDestroyed(target.actor, resolvedLimbKey)) return [];
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(
      this.weapon,
      this.token,
      target,
      this.weaponFunctionId,
      attackContext
    );
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      messageData: this.chatMessageAuthorId ? { author: this.chatMessageAuthorId } : {},
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getDirectedAttackDifficulty(
          target.actor,
          resolvedLimbKey,
          Boolean(limbKey),
          difficultyBonus
            + rangeDifficultyBonus
            + requirementDifficultyBonus
            + this.getWatchOutDifficultyBonus()
            + this.getAttackModifierDifficultyBonus()
        ),
        situationalModifier: this.getAccuracyModifier(getAttackModeAccuracyModifier(this.weapon, this.actionKey, mode, this.weaponFunctionId, attackContext)),
        ...getAttackModeCriticalCheckModifiers(this.weapon, this.actionKey, mode, this.weaponFunctionId, attackContext),
        ...attackContext
      },
      animate: false,
      createMessage: !checkBatch,
      completionCollector: checkBatch,
      prompt: false,
      requester: "weaponAttack"
    });
    this.attackCheckCount += 1;
    checkBatch?.add(outcome);
    this.recordCriticalFailureConsequences(outcome);
    if (!isSuccessfulAttack(outcome)) {
      await this.notifyAttackCheckResolved(outcome, checkBatch);
      return null;
    }
    const impactCount = hasConcentratedPelletImpact(this.weapon, this.weaponFunctionId)
      ? getWeaponPelletCount(this.weapon, this.weaponFunctionId)
      : 1;
    const impactDamages = distributePelletImpactDamage(damageAmount, impactCount);
    const requests = [];
    for (const [impactIndex, impactDamage] of impactDamages.entries()) {
      const damageContext = this.createWeaponDamageContext({
        targetToken: target,
        limbKey: resolvedLimbKey,
        damageShareIndex: impactIndex,
        damageShareCount: impactCount
      });
      let resolvedDamage = applyContextualDamageToAmount(this.weapon, impactDamage, damageContext);
      resolvedDamage = getCriticalDamageAmount(
        this.weapon,
        resolvedDamage,
        outcome,
        this.weaponFunctionId,
        damageContext
      );
      requests.push(...buildWeaponDamageRequests(this.weapon, {
        attackerActor: this.token.actor,
        attackerToken: this.token,
        modifierState: this.getWeaponActionModifierState(),
        actor: target.actor,
        targetToken: target,
        limbKey: resolvedLimbKey,
        amount: resolvedDamage,
        source: {
          attackId: this.attackId,
          weaponUuid: this.weapon.uuid,
          weaponFunctionId: this.weaponFunctionId,
          weaponData: foundry.utils.deepClone(getWeaponAttackData(this.weapon, this.weaponFunctionId) ?? {}),
          actionKey: this.actionKey,
          attackerUuid: this.token.actor.uuid,
          tokenId: this.token.id,
          criticalSuccess: isCriticalSuccessAttack(outcome),
          penetrationStep,
          ...(impactCount > 1 ? {
            pelletImpactCount: impactCount,
            pelletImpactIndex: impactIndex
          } : {})
        }
      }, this.weaponFunctionId));
    }
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    return requests;
  }

  async resolveAimedAttackTrajectory(selectedTarget, trajectory, targetSelection, {
    blockerBonus = 0,
    baseDamage = null,
    damageShareIndex = 0,
    damageShareCount = 1,
    pelletImpactCount = 1,
    checkBatch = null,
    allOrNothingContext = null
  } = {}) {
    const damageRequests = [];
    baseDamage = Math.max(0, Number(baseDamage ?? this.getWeaponDamage()) || 0);
    const selectedPenetrationPower = getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, {
      ...this.createWeaponDamageContext({
        targetToken: selectedTarget,
        limbKey: targetSelection?.limbKey ?? ""
      }),
      actor: this.token.actor,
      actorToken: this.token,
      actionKey: this.actionKey,
      targetActor: selectedTarget.actor,
      targetToken: selectedTarget,
      weaponData: getWeaponAttackData(this.weapon, this.weaponFunctionId)
    });
    checkBatch ??= selectedPenetrationPower > 0
      ? this.createSkillCheckCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    const targets = getTrajectoryTargetEntries(this.token, trajectory, this.targetTokenUuidAllowlist, { purpose: "impact" });
    this.registerAbilityTrialTargets([
      selectedTarget,
      ...targets.map(entry => entry.target)
    ]);
    const selectedEntry = targets.find(entry => entry.target === selectedTarget)
      ?? { target: selectedTarget, hit: getTokenTrajectoryHit(selectedTarget, trajectory) };
    const subsequentTargets = targets.filter(entry => (
      entry.target !== selectedTarget
      && (!selectedEntry.hit || entry.hit.distance > selectedEntry.hit.distance + 0.5)
    ));

    let penetrationsUsed = 0;
    let lastPenetrationPower = 0;
    let finalAnimationPoint = null;
    let hasSuccessfulHit = false;

    const firstRequest = targetSelection?.type === "weapon"
      ? await this.resolveAimedWeaponAttackAgainstTarget(selectedTarget, targetSelection, {
        baseDamage,
        damageAmount: getPenetratedDamageAmount(baseDamage, 0),
        damageShareIndex,
        damageShareCount,
        pelletImpactCount,
        difficultyBonus: blockerBonus,
        penetrationStep: 0,
        checkBatch,
        allOrNothingContext
      })
      : await this.resolveAimedAttackAgainstTarget(selectedTarget, {
        limbKey: targetSelection?.limbKey ?? "",
        damageAmount: getPenetratedDamageAmount(baseDamage, 0),
        damageShareIndex,
        damageShareCount,
        pelletImpactCount,
        difficultyBonus: blockerBonus,
        penetrationStep: 0,
        checkBatch,
        allOrNothingContext
      });
    if (!firstRequest) {
      updateTrajectoryEnd(trajectory, selectMissPointNearTarget(this.token, selectedTarget, trajectory));
      return { damageRequests, trajectory, checkBatch };
    }

    finalAnimationPoint = selectPointOnTrajectoryPastTarget(selectedTarget, trajectory);
    if (firstRequest.length) {
      damageRequests.push(...firstRequest);
      hasSuccessfulHit = true;
      lastPenetrationPower = getDamageRequestGroupPenetrationPower(firstRequest, selectedPenetrationPower);
      if (doesDamageRequestGroupPenetratePart(firstRequest, selectedTarget.actor, targetSelection)) penetrationsUsed += 1;
    }

    for (const entry of subsequentTargets) {
      const passthroughStep = hasSuccessfulHit ? penetrationsUsed : 0;
      if (hasSuccessfulHit && (penetrationsUsed <= 0 || penetrationsUsed > lastPenetrationPower)) break;
      const damageAmount = getPenetratedDamageAmount(baseDamage, passthroughStep);
      if (damageAmount <= 0) break;

      const request = await this.resolveAttackAgainstTarget(entry.target, {
        damageAmount,
        damageShareIndex,
        damageShareCount,
        pelletImpactCount,
        difficultyBonus: passthroughStep * 20,
        penetrationStep: passthroughStep,
        checkBatch,
        allOrNothingContext
      });
      if (!request) {
        finalAnimationPoint = hasSuccessfulHit
          ? selectPointOnTrajectoryPastTarget(entry.target, trajectory)
          : selectMissPointNearTarget(this.token, entry.target, trajectory);
        break;
      }
      if (!request.length) {
        finalAnimationPoint = selectPointOnTrajectoryPastTarget(entry.target, trajectory);
        continue;
      }

      damageRequests.push(...request);
      hasSuccessfulHit = true;
      finalAnimationPoint = selectPointOnTrajectoryPastTarget(entry.target, trajectory);
      lastPenetrationPower = getDamageRequestGroupPenetrationPower(request);
      if (penetrationsUsed >= lastPenetrationPower) break;

      const resolvedLimbKey = getSingleDamageRequestLimbKey(request);
      if (!doesDamageRequestGroupPenetratePart(request, entry.target.actor, { type: "limb", limbKey: resolvedLimbKey })) break;
      penetrationsUsed += 1;
    }

    if (finalAnimationPoint) {
      if (hasSuccessfulHit) updateTrajectoryDistanceEnd(trajectory, finalAnimationPoint);
      else updateTrajectoryEnd(trajectory, finalAnimationPoint);
    }
    return { damageRequests, trajectory, checkBatch };
  }

  async resolveAttackPellets({ checkBatch = null, difficultyBonus = 0, attackIndex = 0, attackCount = 1, burstAttackIndex = 0 } = {}) {
    const damageRequests = [];
    const projectiles = createWeaponPelletImpactProjectiles(
      this.weapon,
      this.weaponFunctionId,
      this.getWeaponDamage()
    );
    const trajectories = buildAttackTrajectories(
      this.token,
      this.geometry,
      this.targets,
      projectiles.length,
      { assignPelletTargets: true }
    );
    const totalProjectileCount = Math.max(1, toInteger(attackCount))
      * Math.max(1, trajectories.length);
    let attempted = false;

    for (const [index, trajectory] of trajectories.entries()) {
      if (this.attackCanceledByReaction) break;
      const projectile = projectiles[index];
      const result = await this.resolveAttackTrajectory({
        checkBatch,
        trajectory,
        baseDamage: projectile?.damageAmount ?? 0,
        damageShareIndex: index,
        damageShareCount: trajectories.length,
        pelletImpactCount: projectile?.pelletImpactCount ?? 1,
        difficultyBonus,
        burstAttackIndex,
        allOrNothingContext: this.createAllOrNothingAttackContext({
          mode: trajectories.length > 1 ? "pellet" : "",
          index: (Math.max(0, toInteger(attackIndex)) * trajectories.length) + index,
          count: totalProjectileCount
        })
      });
      damageRequests.push(...result.damageRequests);
      attempted ||= result.attempted;
    }

    return { attempted, damageRequests, trajectories };
  }

  async resolveAttackTrajectory({
    checkBatch = null,
    trajectory = null,
    baseDamage = null,
    damageShareIndex = 0,
    damageShareCount = 1,
    pelletImpactCount = 1,
    difficultyBonus = 0,
    burstAttackIndex = 0,
    allOrNothingContext = null
  } = {}) {
    const damageRequests = [];
    trajectory ??= buildAttackTrajectory(this.token, this.geometry, this.targets);
    const targets = getTrajectoryTargetEntries(this.token, trajectory, this.targetTokenUuidAllowlist, { purpose: "impact" });
    this.registerAbilityTrialTargets(targets.map(entry => entry.target));
    baseDamage = Math.max(0, Number(baseDamage ?? this.getWeaponDamage()) || 0);
    let penetrationsUsed = 0;
    let attempted = true;
    let finalAnimationPoint = null;
    let finalAnimationSegment = null;
    let hasSuccessfulHit = false;

    for (const entry of targets) {
      const damageAmount = getPenetratedDamageAmount(baseDamage, penetrationsUsed);
      if (damageAmount <= 0) break;
      const request = await this.resolveAttackAgainstTarget(entry.target, {
        damageAmount,
        damageShareIndex,
        damageShareCount,
        pelletImpactCount,
        difficultyBonus: Math.max(0, toInteger(difficultyBonus)) + (penetrationsUsed * 20),
        burstAttackIndex,
        penetrationStep: penetrationsUsed,
        reflectionCount: entry.reflectionCount,
        checkBatch,
        allOrNothingContext
      });
      if (!request) {
        finalAnimationSegment = entry.segment ?? trajectory;
        finalAnimationPoint = hasSuccessfulHit
          ? selectPointOnTrajectoryPastTarget(entry.target, finalAnimationSegment)
          : selectMissPointNearTarget(this.token, entry.target, finalAnimationSegment);
        break;
      }
      if (!request.length) {
        finalAnimationSegment = entry.segment ?? trajectory;
        finalAnimationPoint = selectPointOnTrajectoryPastTarget(entry.target, finalAnimationSegment);
        continue;
      }

      damageRequests.push(...request);
      hasSuccessfulHit = true;
      finalAnimationSegment = entry.segment ?? trajectory;
      finalAnimationPoint = selectPointOnTrajectoryPastTarget(entry.target, finalAnimationSegment);
      const targetPenetrationPower = getDamageRequestGroupPenetrationPower(request);
      if (penetrationsUsed >= targetPenetrationPower) break;

      const resolvedLimbKey = getSingleDamageRequestLimbKey(request);
      if (!doesDamageRequestGroupPenetratePart(request, entry.target.actor, { type: "limb", limbKey: resolvedLimbKey })) break;
      penetrationsUsed += 1;
    }

    if (finalAnimationPoint) {
      if (Array.isArray(trajectory.segments)) {
        truncateRicochetTrajectory(trajectory, finalAnimationSegment, finalAnimationPoint, { projected: hasSuccessfulHit });
      } else if (hasSuccessfulHit) updateTrajectoryDistanceEnd(trajectory, finalAnimationPoint);
      else updateTrajectoryEnd(trajectory, finalAnimationPoint);
    }
    return { attempted, damageRequests, trajectory };
  }

  async resolveAttackAgainstTarget(target, {
    damageAmount = 0,
    damageShareIndex = 0,
    damageShareCount = 1,
    pelletImpactCount = 1,
    difficultyBonus = 0,
    burstAttackIndex = 0,
    penetrationStep = 0,
    reflectionCount = 0,
    checkBatch = null,
    allOrNothingContext = null
  } = {}) {
    if (this.usesAbilityTrialResolution()) {
      return this.resolveAbilityTrialAttackAgainstTarget(target, {
        penetrationStep,
        reflectionCount
      });
    }
    if (await this.resolveTargetReactions(target)) return null;
    const limbKey = selectRandomLimbKey(target.actor, { includeDestroyed: true });
    const normalizedBurstAttackIndex = Math.max(0, toInteger(burstAttackIndex));
    const attackContext = this.createWeaponAttackSkillCheckContext(target, {
      reflectionCount: Math.max(0, toInteger(reflectionCount)),
      burstAttackIndex: normalizedBurstAttackIndex
    });
    this.dodgeExposure.record(target.actor, attackContext);
    if (!limbKey || isLimbDestroyed(target.actor, limbKey)) return [];
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(
      this.weapon,
      this.token,
      target,
      this.weaponFunctionId,
      attackContext
    );
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const burstDifficultyBonus = getBurstShotDifficultyBonus(
      this.weapon,
      this.actionKey,
      normalizedBurstAttackIndex,
      this.weaponFunctionId,
      this.token.actor,
      {
        ...attackContext,
        targetActor: target.actor
      }
    );
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      messageData: this.chatMessageAuthorId ? { author: this.chatMessageAuthorId } : {},
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getDodgeDifficulty(target.actor)
          + difficultyBonus
          + burstDifficultyBonus
          + rangeDifficultyBonus
          + requirementDifficultyBonus
          + this.getWatchOutDifficultyBonus()
          + this.getAttackModifierDifficultyBonus(),
        situationalModifier: this.getAccuracyModifier(getWeaponAccuracyModifier(this.weapon, this.weaponFunctionId, attackContext))
          + getRicochetAccuracyBonus(attackContext.weaponActionModifierState, reflectionCount),
        ...getWeaponCriticalCheckModifiers(this.weapon, this.weaponFunctionId, attackContext),
        ...attackContext,
        ...(allOrNothingContext ?? {})
      },
      animate: false,
      createMessage: !checkBatch,
      completionCollector: checkBatch,
      prompt: false,
      requester: "weaponAttack"
    });
    this.attackCheckCount += 1;
    checkBatch?.add(outcome);
    this.recordCriticalFailureConsequences(outcome);
    if (!isSuccessfulAttack(outcome)) {
      await this.notifyAttackCheckResolved(outcome, checkBatch);
      return null;
    }
    const impactCount = Math.max(1, toInteger(pelletImpactCount));
    const impactDamages = distributePelletImpactDamage(damageAmount, impactCount);
    const requests = [];
    for (const [impactIndex, impactDamage] of impactDamages.entries()) {
      const resolvedShareIndex = impactCount > 1 ? impactIndex : damageShareIndex;
      const resolvedShareCount = impactCount > 1 ? impactCount : damageShareCount;
      const damageContext = this.createWeaponDamageContext({
        targetToken: target,
        damageShareIndex: resolvedShareIndex,
        damageShareCount: resolvedShareCount,
        reflectionCount: Math.max(0, toInteger(reflectionCount))
      });
      let resolvedDamage = applyContextualDamageToAmount(this.weapon, impactDamage, damageContext);
      resolvedDamage = applyRicochetDamageBonus(this.weapon, resolvedDamage, damageContext);
      resolvedDamage = getCriticalDamageAmount(
        this.weapon,
        resolvedDamage,
        outcome,
        this.weaponFunctionId,
        damageContext
      );
      requests.push(...buildWeaponDamageRequests(this.weapon, {
        attackerActor: this.token.actor,
        attackerToken: this.token,
        modifierState: this.getWeaponActionModifierState(),
        actor: target.actor,
        targetToken: target,
        limbKey,
        amount: resolvedDamage,
        source: {
          attackId: this.attackId,
          weaponUuid: this.weapon.uuid,
          weaponFunctionId: this.weaponFunctionId,
          weaponData: foundry.utils.deepClone(getWeaponAttackData(this.weapon, this.weaponFunctionId) ?? {}),
          actionKey: this.actionKey,
          attackerUuid: this.token.actor.uuid,
          tokenId: this.token.id,
          criticalSuccess: isCriticalSuccessAttack(outcome),
          penetrationStep,
          reflectionCount: Math.max(0, toInteger(reflectionCount)),
          ...(impactCount > 1 ? {
            pelletImpactCount: impactCount,
            pelletImpactIndex: impactIndex
          } : {})
        }
      }, this.weaponFunctionId));
    }
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    return requests;
  }

  async performVolleyAttack() {
    const __codexRequestProbe = captureDamageRequestProbe(); // codex-runtime-debug H21
    if (this.processing || !this.geometry) return;
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) return;
    const actionContext = this.createWeaponActionContext({ targetToken: null, geometry: this.geometry });
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(
      this.token.actor,
      this.weapon,
      this.actionKey,
      this.weaponFunctionId,
      actionContext
    )) return;
    if (this.captureOnly) return this.captureAttackSelection({ mode: "current" });
    if (this.shouldUseOrdinaryGmAuthority()) {
      return this.executeOrdinaryAttackViaGm({ mode: "current" });
    }

    this.beginProcessingCycle();
    if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
    this.pendingCriticalFailureResourceCosts = [];
    this.refresh(true);
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount });
    const totalAttackCount = duplicatePlan.totalAttackCount;
    const explosionDelaySeconds = getVolleyExplosionDelaySeconds(this.weapon, this.weaponFunctionId);
    const existingDelayedThrownItem = this.weapon.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_FLAG) ?? {};
    const existingDelayedThrownItemId = String(existingDelayedThrownItem.id ?? "").trim();
    const delayedExplosion = Boolean(existingDelayedThrownItemId) || explosionDelaySeconds > 0;

    const intendedGeometry = this.geometry;
    const damageRequests = [];
    const finalGeometries = [];
    const blastOutcomes = [];
    const regionRequests = [];
    const checkBatch = totalAttackCount > 1
      ? this.createSkillCheckCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    const blastAttackContext = this.createWeaponActionContext({ targetToken: null, geometry: intendedGeometry });

    if (!delayedExplosion) this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let attackIndex = 0; attackIndex < totalAttackCount; attackIndex += 1) {
      const blastOutcome = await this.resolveVolleyBlastPoint(intendedGeometry, {
        checkBatch,
        difficultyBonus: getBurstShotDifficultyBonus(
          this.weapon,
          this.actionKey,
          attackIndex,
          this.weaponFunctionId,
          this.token.actor,
          blastAttackContext
        )
      });
      const finalGeometry = {
        ...intendedGeometry,
        end: blastOutcome.center,
        angle: Math.atan2(blastOutcome.center.y - intendedGeometry.origin.y, blastOutcome.center.x - intendedGeometry.origin.x),
        distance: Math.max(1, Math.hypot(blastOutcome.center.x - intendedGeometry.origin.x, blastOutcome.center.y - intendedGeometry.origin.y))
      };
      finalGeometries.push(finalGeometry);
      blastOutcomes.push(blastOutcome);
      if (!delayedExplosion) {
        const blastTargets = getPotentialTargets(this.token, finalGeometry, {
          includeAttacker: true,
          includeDead: true,
          purpose: "impact"
        });
        this.registerAbilityTrialTargets(blastTargets);
        const regionRequest = this.buildVolleyDamageRegionRequest(finalGeometry, blastOutcome);
        if (regionRequest) regionRequests.push(regionRequest);
        for (const target of blastTargets) {
          const result = await this.resolveVolleyDamageAgainstTarget(target, finalGeometry, blastOutcome);
          damageRequests.push(...(result ?? []));
          if (this.attackCanceledByReaction) break;
        }
      }
      if (this.attackCanceledByReaction) break;
    }
    // #region codex-runtime-debug H21 distinguish cycles, targets and generated components
    recordDamageRequestProbe(__codexRequestProbe, "weapon.volleyDamageRequests", damageRequests, {
      attackCycles: finalGeometries.length
    });
    // #endregion codex-runtime-debug
    if (!delayedExplosion) await this.dodgeExposure.flush();

    this.geometry = finalGeometries[finalGeometries.length - 1] ?? intendedGeometry;
    this.targets = this.filterTargetTokens(getPotentialTargets(
      this.token,
      this.geometry,
      {
        includeAttacker: true,
        includeDead: true,
        targetTokenUuidAllowlist: this.targetTokenUuidAllowlist
      }
    ));

    const delayedThrownItemId = delayedExplosion ? (existingDelayedThrownItemId || foundry.utils.randomID()) : "";
    const landingPoint = getAttackLandingPoint(finalGeometries, this.pointer);
    const delayedDamageContext = delayedExplosion ? this.createWeaponDamageContext(actionContext) : null;
    const delayedActionPointCostApplied = delayedExplosion && (
      this.reportedActionPointCostApplied ?? (
        !this.skipActionPointCost && isCombatActionPointSpendingActive(this.token.actor)
      )
    );
    const delayedActionPointCost = delayedExplosion
      ? (this.reportedActionPointCost ?? (
        delayedActionPointCostApplied
          ? getWeaponActionPointCost(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId, {
            ...actionContext,
            chanceOperationId: this.chanceOperationId
          })
          : 0
      ))
      : 0;
    const resolveWeaponNoiseAtImpact = delayedExplosion
      && !existingDelayedThrownItemId
      && !this.deferWeaponNoiseDetection;
    const delayedRegionRequest = delayedExplosion
      ? buildDelayedVolleyExplosionRegionRequest({
        sceneId: canvas.scene?.id ?? "",
        delayedThrownItemId,
        attackId: this.attackId,
        explodeAtWorldTime: Number(existingDelayedThrownItem.explodeAtWorldTime)
          || ((Number(game.time?.worldTime) || 0) + explosionDelaySeconds),
        weapon: this.weapon,
        weaponFunctionId: this.weaponFunctionId,
        actionKey: this.actionKey,
        attackerToken: this.token,
        finalGeometries,
        blastOutcomes,
        damageContext: delayedDamageContext,
        stealthAttack: this.stealthAttack,
        actionPointCost: delayedActionPointCost,
        actionPointCostApplied: delayedActionPointCostApplied,
        resolveWeaponNoiseAtImpact,
        weaponNoiseLevel: this.weaponNoiseLevel,
        preventStealthDetection: Boolean(
          this.getWeaponActionModifierState().getOption("preventStealthDetection")
        ),
        keepAwayEntries: this.getWeaponActionModifierState().getOption("keepAwayDeferredEntries"),
        suppressGuardianAngelReaction: Boolean(this.attackModifier?.suppressGuardianAngelReaction),
        chainRef: this.chainRef,
        damageHubOperationRef: this.damageHubOperationRef,
        impactConditionWearMultiplier: getWeaponImpactConditionWearMultiplier(
          getWeaponAttackData(this.weapon, this.weaponFunctionId),
          this.getWeaponActionModifierState()
        )
      })
      : null;

    const createsNewDelayedRegion = delayedExplosion && !existingDelayedThrownItemId;
    if (createsNewDelayedRegion) {
      const region = await requestCreateDelayedVolleyExplosionRegion(delayedRegionRequest);
      if (!region) {
        await rollbackDelayedThrownItemWorldDocuments(delayedThrownItemId);
        this.attackCanceledByReaction = true;
        await checkBatch?.publish({ forceBatch: true });
        this.releaseInteractiveControl();
        this.completeProcessingCycle();
        return;
      }
    }

    let costsSpent = false;
    try {
      costsSpent = await this.spendCurrentAttackCosts({
        attackCount: totalAttackCount,
        point: landingPoint,
        createSpentQuantityTile: delayedExplosion,
        delayedThrownItemId,
        delayedThrownItemData: delayedRegionRequest,
        actionContext
      });
    } catch (error) {
      if (createsNewDelayedRegion) {
        await rollbackDelayedThrownItemWorldDocuments(delayedThrownItemId);
      }
      throw error;
    }
    if (!costsSpent) {
      if (createsNewDelayedRegion) {
        await rollbackDelayedThrownItemWorldDocuments(delayedThrownItemId);
      }
      await checkBatch?.publish({ forceBatch: true });
      this.releaseInteractiveControl();
      this.completeProcessingCycle();
      return;
    }
    if (createsNewDelayedRegion) {
      Object.assign(delayedRegionRequest.source, {
        actionPointCost: Math.max(0, toInteger(this.reportedActionPointCost)),
        actionPointCostApplied: Boolean(this.reportedActionPointCostApplied),
        actionPointSpendReceipt: this.actionPointSpendReceipt
          ? foundry.utils.deepClone(this.actionPointSpendReceipt)
          : null
      });
      delayedRegionRequest.persistPendingData = true;
      let updatedRegion = null;
      let updateError = null;
      try {
        updatedRegion = await requestCreateDelayedVolleyExplosionRegion(delayedRegionRequest);
      } catch (error) {
        updateError = error;
      } finally {
        delete delayedRegionRequest.persistPendingData;
      }
      if (!updatedRegion) {
        console.error(`${SYSTEM_ID} | Failed to persist delayed volley attack outcome context.`, updateError ?? "");
      }
    }
    await checkBatch?.publish({ forceBatch: true });

    const playEffects = this.shouldPlayWeaponAnimationForAttempt();
    if (delayedExplosion) {
      if (playEffects) await this.playVolleyAttackEffects(finalGeometries, { includeExplosion: false });
      this.releaseInteractiveControl();
      if (existingDelayedThrownItemId) {
        const region = await requestCreateDelayedVolleyExplosionRegion(delayedRegionRequest);
        if (!region) {
          ui.notifications.warn("GM не подтвердил перемещение области отложенного взрыва.");
        }
      }
      await this.notifyAttackResolved({
        deferredImpactPending: true,
        deferNoiseDetection: resolveWeaponNoiseAtImpact
      });
      this.completeProcessingCycle();
      return;
    }

    if (playEffects) await this.playVolleyAttackEffects(finalGeometries);
    this.releaseInteractiveControl();
    const damageResults = this.attackCanceledByReaction
      ? []
      : flattenDamageResults(await applyQueuedDamageAndRegionRequests(this.stampAttackDamageSources(damageRequests), regionRequests));

    await this.notifyAttackResolved({ damageResults, killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults) });
    this.completeProcessingCycle();
  }

  async resolveVolleyBlastPoint(geometry, { checkBatch = null, difficultyBonus = 0 } = {}) {
    const weaponData = getWeaponAttackData(this.weapon, this.weaponFunctionId);
    const attackDistanceMeters = getAttackGeometryDistanceMeters(geometry);
    const rangeProfile = this.getRangeProfileForDistance(attackDistanceMeters, { weaponData });
    const attackContext = this.createWeaponAttackSkillCheckContext(null, {
      attackDistanceMeters,
      effectiveRange: rangeProfile.effectiveRange
    });
    if (this.usesAbilityTrialResolution()) {
      return {
        outcome: null,
        center: geometry.end,
        critical: false,
        attackDistanceMeters,
        effectiveRange: attackContext.effectiveRange,
        baseDamage: this.getWeaponDamage()
      };
    }
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonusForDistance(
      weaponData,
      attackDistanceMeters,
      this.token?.actor ?? null,
      attackContext
    );
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      messageData: this.chatMessageAuthorId ? { author: this.chatMessageAuthorId } : {},
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: BASE_VOLLEY_DIFFICULTY + rangeDifficultyBonus + requirementDifficultyBonus + Math.max(0, toInteger(difficultyBonus)),
        situationalModifier: this.getAccuracyModifier(getWeaponAccuracyModifier(this.weapon, this.weaponFunctionId, attackContext)),
        ...getWeaponCriticalCheckModifiers(this.weapon, this.weaponFunctionId, attackContext),
        ...attackContext,
        allowImplicitTarget: false
      },
      animate: false,
      createMessage: !checkBatch,
      completionCollector: checkBatch,
      prompt: false,
      requester: "weaponAttack"
    });
    this.attackCheckCount += 1;
    checkBatch?.add(outcome);
    this.recordCriticalFailureConsequences(outcome);
    const center = computeVolleyBlastCenter({
      attackerToken: this.token,
      intendedCenter: geometry.end,
      radiusPixels: geometry.radiusPixels,
      outcome
    });
    // A successful point check only controls scatter. The attack itself is
    // successful when the resulting area actually reaches at least one target.
    await this.notifyAttackCheckResolved(outcome, checkBatch, { recordAggregate: false });
    return {
      outcome,
      center,
      critical: isCriticalSuccessAttack(outcome),
      attackDistanceMeters,
      effectiveRange: attackContext.effectiveRange,
      baseDamage: this.getWeaponDamage()
    };
  }

  buildVolleyDamageRegionRequest(geometry, blastOutcome) {
    const settings = getVolleyRegionSettings(this.weapon, this.weaponFunctionId);
    if (!settings.enabled) return null;

    return {
      sceneId: canvas.scene?.id ?? "",
      name: this.weapon.name
        ? `${this.weapon.name}: ${game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.RegionName")}`
        : game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.RegionName"),
      center: serializePoint(geometry.end),
      radiusPixels: metersToPixels(settings.radiusMeters),
      color: getVolleyRegionColor(settings.damageEntries),
      damageEntries: settings.damageEntries,
      regionSpecialProperties: settings.regionSpecialProperties,
      delaySeconds: 0,
      durationSeconds: settings.durationSeconds,
      radiusDeltaMeters: settings.radiusDeltaMeters
    };
  }

  async playVolleyAttackEffects(finalGeometries = [], { includeProjectile = true, includeExplosion = true } = {}) {
    const delayMs = getWeaponAttackAnimationDelay(this.weapon, this.weaponFunctionId);
    const animationTasks = finalGeometries.map(async (geometry, index) => {
      if (index > 0 && delayMs > 0) await sleep(index * delayMs);
      const weaponData = getWeaponAttackData(this.weapon, this.weaponFunctionId);
      if (includeProjectile) {
        await this.playAttackAnimationsIfNeeded([buildVolleyAnimationTrajectory(geometry)], { delayMs: 0 });
      }
      if (includeExplosion) {
        await playWeaponExplosionAnimation({
          weapon: this.weapon,
          weaponFunctionId: this.weaponFunctionId,
          weaponData,
          center: geometry.end,
          radiusPixels: geometry.radiusPixels
        });
      }
    });
    await Promise.all(animationTasks);
  }

  async resolveVolleyDamageAgainstTarget(target, geometry, blastOutcome) {
    if (this.usesAbilityTrialResolution()) {
      return this.resolveAbilityTrialAttackAgainstTarget(target);
    }
    if (!isDeadTarget(target) && await this.resolveTargetReactions(target)) return null;
    if (!isDeadTarget(target) && target?.actor?.uuid) {
      this.successfulAttackTargetActorUuids.add(String(target.actor.uuid));
    }
    const distanceContext = normalizeAttackDistanceContext(blastOutcome);
    const targetDamageContext = this.createWeaponDamageContext({
      ...distanceContext,
      targetToken: target
    });
    if (!isDeadTarget(target)) this.dodgeExposure.record(target.actor, targetDamageContext);
    return buildWeaponExplosionDamageRequests({
      targetToken: target,
      center: geometry.end,
      radiusPixels: geometry.radiusPixels,
      baseDamage: Number.isFinite(Number(blastOutcome?.baseDamage))
        ? Math.max(0, Number(blastOutcome.baseDamage))
        : this.getWeaponDamage(distanceContext),
      pelletCount: getWeaponPelletCount(this.weapon, this.weaponFunctionId),
      concentratedPelletImpact: hasConcentratedPelletImpact(
        this.weapon,
        this.weaponFunctionId
      ),
      damageTypes: getWeaponDamageTypeEntries(this.weapon, this.weaponFunctionId),
      penetrationPower: getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, {
        ...targetDamageContext,
        actor: this.token.actor,
        actorToken: this.token,
        actionKey: this.actionKey,
        targetActor: target.actor,
        targetToken: target
      }),
      damageModifier: (amount, { falloff = 1 } = {}) => getCriticalDamageAmount(
        this.weapon,
        applyContextualDamageToAmount(this.weapon, amount, {
          ...targetDamageContext,
          damageShareCount: 1,
          damageScale: falloff
        }),
        blastOutcome.outcome,
        this.weaponFunctionId,
        targetDamageContext
      ),
      source: {
        attackId: this.attackId,
        weaponUuid: this.weapon.uuid,
        weaponFunctionId: this.weaponFunctionId,
        weaponData: foundry.utils.deepClone(getWeaponAttackData(this.weapon, this.weaponFunctionId) ?? {}),
        actionKey: this.actionKey,
        attackerUuid: this.token.actor.uuid,
        tokenId: this.token.id,
        criticalSuccess: isCriticalSuccessAttack(blastOutcome?.outcome),
        ...distanceContext,
        blastCenter: serializePoint(geometry.end),
        blastRadius: getVolleyDamageRadius(this.weapon, this.weaponFunctionId)
      }
    });
  }

  async resolveAimedAttackAgainstTarget(target, {
    limbKey = "",
    damageAmount = 0,
    damageShareIndex = 0,
    damageShareCount = 1,
    pelletImpactCount = 1,
    difficultyBonus = 0,
    penetrationStep = 0,
    checkBatch = null,
    allOrNothingContext = null
  } = {}) {
    if (this.usesAbilityTrialResolution()) {
      return this.resolveAbilityTrialAttackAgainstTarget(target, {
        selectedLimbKey: limbKey,
        penetrationStep
      });
    }
    if (await this.resolveTargetReactions(target)) return null;
    const attackContext = this.createWeaponAttackSkillCheckContext(target);
    this.dodgeExposure.record(target.actor, attackContext);
    if (!limbKey || isLimbDestroyed(target.actor, limbKey)) return [];
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(
      this.weapon,
      this.token,
      target,
      this.weaponFunctionId,
      attackContext
    );
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      messageData: this.chatMessageAuthorId ? { author: this.chatMessageAuthorId } : {},
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getAimedAttackDifficulty(
          target.actor,
          limbKey,
          difficultyBonus
            + rangeDifficultyBonus
            + requirementDifficultyBonus
            + this.getWatchOutDifficultyBonus()
            + this.getAttackModifierDifficultyBonus(),
          {
            innateDifficultyIgnorePercent: this.getWeaponActionModifierState().getOption("innateAimedDifficultyIgnorePercent"),
            ignoreCover: this.ignoreAimedObstructions
          }
        ),
        situationalModifier: this.getAccuracyModifier(getWeaponAccuracyModifier(this.weapon, this.weaponFunctionId, attackContext)),
        ...getWeaponCriticalCheckModifiers(this.weapon, this.weaponFunctionId, attackContext),
        ...attackContext,
        ...(allOrNothingContext ?? {})
      },
      animate: false,
      createMessage: !checkBatch,
      completionCollector: checkBatch,
      prompt: false,
      requester: "weaponAttack"
    });
    this.attackCheckCount += 1;
    checkBatch?.add(outcome);
    this.recordCriticalFailureConsequences(outcome);
    if (!isSuccessfulAttack(outcome)) {
      await this.notifyAttackCheckResolved(outcome, checkBatch);
      return null;
    }
    const impactCount = Math.max(1, toInteger(pelletImpactCount));
    const impactDamages = distributePelletImpactDamage(damageAmount, impactCount);
    const requests = [];
    for (const [impactIndex, impactDamage] of impactDamages.entries()) {
      const resolvedShareIndex = impactCount > 1 ? impactIndex : damageShareIndex;
      const resolvedShareCount = impactCount > 1 ? impactCount : damageShareCount;
      const damageContext = this.createWeaponDamageContext({
        targetToken: target,
        limbKey,
        damageShareIndex: resolvedShareIndex,
        damageShareCount: resolvedShareCount
      });
      let resolvedDamage = applyContextualDamageToAmount(this.weapon, impactDamage, damageContext);
      resolvedDamage = getCriticalDamageAmount(
        this.weapon,
        resolvedDamage,
        outcome,
        this.weaponFunctionId,
        damageContext
      );
      requests.push(...buildWeaponDamageRequests(this.weapon, {
        attackerActor: this.token.actor,
        attackerToken: this.token,
        modifierState: this.getWeaponActionModifierState(),
        actor: target.actor,
        targetToken: target,
        limbKey,
        amount: resolvedDamage,
        source: {
          attackId: this.attackId,
          weaponUuid: this.weapon.uuid,
          actionKey: this.actionKey,
          attackerUuid: this.token.actor.uuid,
          tokenId: this.token.id,
          criticalSuccess: isCriticalSuccessAttack(outcome),
          penetrationStep,
          ...(impactCount > 1 ? {
            pelletImpactCount: impactCount,
            pelletImpactIndex: impactIndex
          } : {})
        }
      }, this.weaponFunctionId));
    }
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    return requests;
  }

  async resolveAimedWeaponAttackAgainstTarget(target, targetSelection, {
    baseDamage = 0,
    damageAmount = 0,
    damageShareIndex = 0,
    damageShareCount = 1,
    pelletImpactCount = 1,
    difficultyBonus = 0,
    penetrationStep = 0,
    checkBatch = null,
    allOrNothingContext = null
  } = {}) {
    if (this.usesAbilityTrialResolution()) {
      return this.resolveAbilityTrialAttackAgainstTarget(target, {
        selectedLimbKey: String(targetSelection?.limbKey ?? "").trim(),
        penetrationStep
      });
    }
    if (await this.resolveTargetReactions(target)) return null;
    const targetWeapon = targetSelection?.item ?? null;
    const holdingLimbKey = String(targetSelection?.limbKey ?? "").trim();
    if (!targetWeapon || !holdingLimbKey || isLimbDestroyed(target.actor, holdingLimbKey)) return [];
    const attackContext = this.createWeaponAttackSkillCheckContext(target);
    this.dodgeExposure.record(target.actor, attackContext);
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(
      this.weapon,
      this.token,
      target,
      this.weaponFunctionId,
      attackContext
    );
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      messageData: this.chatMessageAuthorId ? { author: this.chatMessageAuthorId } : {},
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getAimedAttackDifficulty(
          target.actor,
          holdingLimbKey,
          difficultyBonus
            + rangeDifficultyBonus
            + requirementDifficultyBonus
            + this.getWatchOutDifficultyBonus()
            + this.getAttackModifierDifficultyBonus(),
          {
            innateDifficultyIgnorePercent: this.getWeaponActionModifierState().getOption("innateAimedDifficultyIgnorePercent"),
            ignoreCover: this.ignoreAimedObstructions
          }
        ),
        situationalModifier: this.getAccuracyModifier(getWeaponAccuracyModifier(this.weapon, this.weaponFunctionId, attackContext)),
        ...getWeaponCriticalCheckModifiers(this.weapon, this.weaponFunctionId, attackContext),
        ...attackContext,
        ...(allOrNothingContext ?? {})
      },
      animate: false,
      createMessage: !checkBatch,
      completionCollector: checkBatch,
      prompt: false,
      requester: "weaponAttack"
    });
    this.attackCheckCount += 1;
    checkBatch?.add(outcome);
    this.recordCriticalFailureConsequences(outcome);
    if (!isSuccessfulAttack(outcome)) {
      await this.notifyAttackCheckResolved(outcome, checkBatch);
      return null;
    }

    const impactCount = Math.max(1, toInteger(pelletImpactCount));
    const resolvedImpacts = distributePelletImpactDamage(damageAmount, impactCount)
      .map((impactDamage, impactIndex) => {
        const resolvedShareIndex = impactCount > 1 ? impactIndex : damageShareIndex;
        const resolvedShareCount = impactCount > 1 ? impactCount : damageShareCount;
        const damageContext = this.createWeaponDamageContext({
          targetToken: target,
          damageShareIndex: resolvedShareIndex,
          damageShareCount: resolvedShareCount
        });
        let resolvedDamage = applyContextualDamageToAmount(this.weapon, impactDamage, damageContext);
        resolvedDamage = getCriticalDamageAmount(
          this.weapon,
          resolvedDamage,
          outcome,
          this.weaponFunctionId,
          damageContext
        );
        return { impactIndex, resolvedDamage };
      });
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    const weaponDamageRequests = resolvedImpacts.flatMap(({ impactIndex, resolvedDamage }) => (
      buildWeaponConditionDamageRequests(this.weapon, {
        attackerActor: this.token.actor,
        attackerToken: this.token,
        modifierState: this.getWeaponActionModifierState(),
        actor: target.actor,
        targetToken: target,
        targetItem: targetWeapon,
        limbKey: holdingLimbKey,
        amount: resolvedDamage,
        source: {
          attackId: this.attackId,
          weaponUuid: this.weapon.uuid,
          actionKey: this.actionKey,
          attackerUuid: this.token.actor.uuid,
          tokenId: this.token.id,
          criticalSuccess: isCriticalSuccessAttack(outcome),
          targetItemId: targetWeapon.id,
          penetrationStep,
          ...(impactCount > 1 ? {
            pelletImpactCount: impactCount,
            pelletImpactIndex: impactIndex
          } : {})
        }
      }, this.weaponFunctionId)
    ));
    if (!weaponDamageRequests.length) return [];

    const requests = [...weaponDamageRequests];
    const targetPenetrationPower = getDamageRequestGroupPenetrationPower(weaponDamageRequests);
    const penetratesWeapon = doesDamageRequestGroupPenetratePart(weaponDamageRequests, target.actor, {
      type: "weapon",
      item: targetWeapon,
      limbKey: holdingLimbKey
    });
    const limbPenetrationStep = penetrationStep + 1;
    if (penetratesWeapon && limbPenetrationStep <= targetPenetrationPower) {
      for (const { impactIndex, resolvedDamage } of resolvedImpacts) {
        requests.push(...buildWeaponDamageRequests(this.weapon, {
          attackerActor: this.token.actor,
          attackerToken: this.token,
          modifierState: this.getWeaponActionModifierState(),
          actor: target.actor,
          targetToken: target,
          penetrationPower: targetPenetrationPower,
          limbKey: holdingLimbKey,
          amount: getPenetratedDamageAmount(resolvedDamage, limbPenetrationStep),
          source: {
            attackId: this.attackId,
            weaponUuid: this.weapon.uuid,
            actionKey: this.actionKey,
            attackerUuid: this.token.actor.uuid,
            tokenId: this.token.id,
            criticalSuccess: isCriticalSuccessAttack(outcome),
            aimedThroughItemId: targetWeapon.id,
            penetrationStep: limbPenetrationStep,
            ...(impactCount > 1 ? {
              pelletImpactCount: impactCount,
              pelletImpactIndex: impactIndex
            } : {})
          }
        }, this.weaponFunctionId));
      }
    }
    return requests;
  }

  refresh(forceBroadcast = false, { skipBurstDistribution = false } = {}) {
    if (this.destroyed) return;
    if (this.headlessExecution) {
      if (!this.pointer && !this.lockedGeometry && !isWhirlwindAttackModifier(this.attackModifier)) {
        this.targets = [];
        this.geometry = null;
        return;
      }
      if (this.reuseValidatedGeometryOnce && this.geometry) {
        this.reuseValidatedGeometryOnce = false;
      } else if (!this.rebuildGeometryAndTargets()) return;
      this.hoveredTarget = this.targetedAction && this.aimedMode === "aim"
        ? getAimedTargetUnderPointer(this.pointer, this.targets)
        : this.selectedTarget;
      return;
    }
    if (this.previewSuppressed) {
      this.shape.clear();
      this.meleeDirectionPreview.clear();
      this.clearTargetMarkers();
      return;
    }
    this.shape.clear();
    this.meleeDirectionPreview.clear();
    if (!this.pointer && !this.lockedGeometry && !isWhirlwindAttackModifier(this.attackModifier)) {
      this.syncAttackAutoCover([]);
      this.clearTargetMarkers();
      this.resetBurstTargetPreview();
      return;
    }

    if (!this.rebuildGeometryAndTargets()) return;
    this.syncAttackAutoCover();
    this.hoveredTarget = this.targetedAction && this.aimedMode === "aim"
      ? getAimedTargetUnderPointer(this.pointer, this.targets)
      : this.selectedTarget;
    drawAttackShape(this.shape, this.geometry, {
      locked: this.processing || this.pushStrengthMaximum > 0 || (this.targetedAction && ["limb", "direction"].includes(this.aimedMode)),
      hasTargets: this.targets.length > 0
    });
    this.drawMeleeDirectionHoverPreview();
    const markerPreview = this.getTargetMarkerPreview(
      forceBroadcast || this.processing,
      { skipBurstDistribution }
    );
    this.drawTargetMarkersForPreview(markerPreview, {
      force: forceBroadcast || this.processing,
      time: performance.now()
    });
    if (this.pushStrengthMaximum > 0) {
      this.removeChanceMenu();
      this.refreshPushStrengthMenu();
    } else if (this.targetedAction) {
      this.removeChanceMenu();
      this.refreshAimedLimbMenu();
    } else {
      this.removeLimbMenu();
      this.refreshUntargetedChanceMenu();
    }
    this.broadcastPreview(forceBroadcast, markerPreview);
  }

  /** Geometry/target membership only — used by reaction reach filters, not attack previews. */
  evaluateReachAgainstToken(targetToken) {
    if (this.destroyed || !targetToken?.actor) return false;
    const pointer = getTokenAimPoint(targetToken);
    if (!pointer) return false;
    this.pointer = pointer;
    if (!this.rebuildGeometryAndTargets()) return false;
    return this.targets.includes(targetToken);
  }

  rebuildGeometryAndTargets() {
    const origin = this.getAttackOrigin();
    this.geometry = this.pushStrengthMaximum > 0
      ? deserializeGeometry(this.lockedGeometry)
      : this.targetedAction && ["limb", "direction"].includes(this.aimedMode)
      ? deserializeGeometry(this.lockedGeometry)
      : this.getAttackGeometry(origin);
    if (!this.geometry) {
      this.targets = [];
      return false;
    }
    const ricochet = this.actionKey === "snapshot"
      ? this.getWeaponActionModifierState().getOption("ricochet")
      : null;
    if (ricochet?.maxReflections > 0) {
      const maximumConeDegrees = Number(ricochet.maximumConeDegrees);
      if (Number.isFinite(maximumConeDegrees) && maximumConeDegrees > 0) {
        const maximumHalfAngle = Math.min(Math.PI, maximumConeDegrees * Math.PI / 360);
        if (Number(this.geometry.halfAngle) > maximumHalfAngle) {
          this.geometry.halfAngle = maximumHalfAngle;
          this.geometry.shapePoints = buildClippedConePoints(this.token, this.geometry);
        }
      }
      this.geometry.ricochet = ricochet;
      this.geometry.ricochetTrajectory = buildTrajectoryByAngle(
        this.token,
        this.geometry,
        this.geometry.angle,
        Number(this.geometry.elevationSlope) || 0
      );
      this.geometry.ricochetCone = buildRicochetCone(this.token, this.geometry);
    }
    let potentialTargets = this.filterTargetTokens(getPotentialTargets(this.token, this.geometry, {
      includeAttacker: this.volleyAction,
      includeDead: this.volleyAction,
      targetTokenUuidAllowlist: this.targetTokenUuidAllowlist
    }));
    this.targets = potentialTargets;
    this.geometry.aimPoint = null;
    this.trajectoryAimTarget = isWhirlwindAttackModifier(this.attackModifier)
      ? null
      : this.volleyAction
      ? getVolleyTrajectoryAimTarget(this.token, this.geometry, {
        includeAttacker: true,
        includeDead: true,
        candidates: potentialTargets
      })
      : this.getTrajectoryAimTarget(potentialTargets);
    this.geometry.aimPoint = this.trajectoryAimTarget
      ? selectAttackGeometryAimPoint(this.token, this.trajectoryAimTarget, this.geometry)
      : null;
    if (this.volleyAction && this.geometry.aimPoint) {
      this.geometry = aimVolleyGeometryAtPoint(this.token, this.geometry, this.geometry.aimPoint);
      potentialTargets = this.filterTargetTokens(getPotentialTargets(this.token, this.geometry, {
        includeAttacker: true,
        includeDead: true,
        targetTokenUuidAllowlist: this.targetTokenUuidAllowlist
      }));
      this.targets = potentialTargets;
    } else if (this.geometry.aimPoint) {
      this.targets = getAimedElevationTargets(this.token, this.geometry, potentialTargets);
    }
    return true;
  }

  getTrajectoryAimTarget(potentialTargets = []) {
    if (this.volleyAction) return potentialTargets.at(0) ?? null;
    if (this.targetedAction && ["limb", "direction"].includes(this.aimedMode)) return this.selectedTarget;
    const hoveredTarget = getAimedTargetUnderPointer(this.pointer, potentialTargets);
    if (hoveredTarget) return hoveredTarget;
    if (this.targetedAction) return null;
    return potentialTargets.at(0) ?? null;
  }

  getAttackGeometry(origin) {
    if (isWhirlwindAttackModifier(this.attackModifier)) {
      return getCircularAttackGeometry(
        this.weapon,
        this.actionKey,
        this.token,
        origin,
        this.weaponFunctionId,
        this.rangeProfile
      );
    }
    return getAttackGeometry(
      this.weapon,
      this.actionKey,
      this.token,
      origin,
      this.pointer,
      this.weaponFunctionId,
      this.rangeProfile
    );
  }

  getAccuracyModifier(baseModifier = 0) {
    return toInteger(baseModifier) + getWeaponAttackModifierAccuracyModifier(this.attackModifier);
  }

  getAttackModifierDifficultyBonus() {
    return getWeaponAttackModifierDifficultyBonus(this.attackModifier);
  }

  syncAttackAutoCover(states = null) {
    const nextStates = this.ignoreAimedObstructions
      ? []
      : Array.isArray(states)
      ? states
      : getAttackAutoCoverStates(this.token, this.geometry, this.targets);
    const signature = getAttackAutoCoverSignature(nextStates);
    if (signature === this.lastAutoCoverSignature) return;
    this.lastAutoCoverSignature = signature;
    this.autoCoverActorUuids = new Set(nextStates.map(state => state.actorUuid).filter(Boolean));
    if (this.ownsAttackAutoCoverLifecycle) queueAttackAutoCoverSync(this.autoCoverAttackId, nextStates);
  }

  async syncAttackAutoCoverForExecution() {
    if (!this.headlessExecution) return;
    const states = this.ignoreAimedObstructions
      ? []
      : getAttackAutoCoverStates(this.token, this.geometry, this.targets);
    this.autoCoverActorUuids = new Set(states.map(state => state.actorUuid).filter(Boolean));
    await syncAttackAutoCoverNow(this.autoCoverAttackId, states);
  }

  getFocusedTarget() {
    return this.selectedTarget ?? this.hoveredTarget ?? this.trajectoryAimTarget;
  }

  getTargetMarkerPreview(force = false, { skipBurstDistribution = false } = {}) {
    if (skipBurstDistribution) {
      return {
        targets: this.targets,
        burstRanges: this.burstTargetPreview?.burstRanges ?? new Map()
      };
    }
    const burstRanges = this.getBurstTargetRanges(this.targets);
    if (!this.shouldStabilizeBurstTargetPreview()) return {
      targets: this.targets,
      burstRanges
    };
    return this.getStableBurstTargetPreview({ targets: this.targets, burstRanges }, force);
  }

  shouldStabilizeBurstTargetPreview() {
    return (
      this.actionKey === "burst"
      && !this.volleyAction
      && !this.processing
      && !this.targetedAction
      && !hasWeaponSpecialProperty(this.weapon, WEAPON_SPECIAL_PROPERTIES.hitAllConeTargets, this.weaponFunctionId)
    );
  }

  getStableBurstTargetPreview(rawPreview, force = false) {
    const now = performance.now();
    const signature = getBurstTargetPreviewSignature(rawPreview.targets, rawPreview.burstRanges);
    const state = this.burstTargetPreview;
    const shouldAcceptImmediately = force
      || !state.initialized
      || signature === state.signature
      || isMajorBurstPreviewGeometryShift(state.geometry, this.geometry);

    if (shouldAcceptImmediately) return this.acceptBurstTargetPreview(rawPreview, signature, now);

    if (signature !== state.pendingSignature) {
      state.pendingSignature = signature;
      state.pendingTargets = [...rawPreview.targets];
      state.pendingBurstRanges = rawPreview.burstRanges;
      state.pendingGeometry = serializeGeometry(this.geometry);
      state.pendingSince = now;
      this.scheduleBurstTargetPreviewRefresh();
      return this.getAcceptedBurstTargetPreview();
    }

    state.pendingTargets = [...rawPreview.targets];
    state.pendingBurstRanges = rawPreview.burstRanges;
    state.pendingGeometry = serializeGeometry(this.geometry);
    if (now - state.pendingSince >= BURST_PREVIEW_STABILIZE_MS) {
      return this.acceptBurstTargetPreview({
        targets: state.pendingTargets,
        burstRanges: state.pendingBurstRanges
      }, state.pendingSignature, now, state.pendingGeometry);
    }

    this.scheduleBurstTargetPreviewRefresh();
    return this.getAcceptedBurstTargetPreview();
  }

  acceptBurstTargetPreview(rawPreview, signature, now = performance.now(), geometry = serializeGeometry(this.geometry)) {
    const state = this.burstTargetPreview;
    this.clearBurstTargetPreviewTimer();
    state.initialized = true;
    state.signature = signature;
    state.targets = [...rawPreview.targets];
    state.burstRanges = rawPreview.burstRanges;
    state.geometry = geometry;
    state.pendingSignature = "";
    state.pendingTargets = [];
    state.pendingBurstRanges = new Map();
    state.pendingGeometry = null;
    state.pendingSince = now;
    return this.getAcceptedBurstTargetPreview();
  }

  getAcceptedBurstTargetPreview() {
    return {
      targets: this.burstTargetPreview.targets,
      burstRanges: this.burstTargetPreview.burstRanges
    };
  }

  scheduleBurstTargetPreviewRefresh() {
    if (this.burstPreviewStabilizeTimeout) return;
    this.burstPreviewStabilizeTimeout = window.setTimeout(() => {
      this.burstPreviewStabilizeTimeout = null;
      if (activeAttack !== this || this.processing || !this.pointer) return;
      this.previewFrameScheduler.request();
    }, BURST_PREVIEW_STABILIZE_MS + 16);
  }

  clearBurstTargetPreviewTimer() {
    if (!this.burstPreviewStabilizeTimeout) return;
    window.clearTimeout(this.burstPreviewStabilizeTimeout);
    this.burstPreviewStabilizeTimeout = null;
  }

  resetBurstTargetPreview() {
    this.clearBurstTargetPreviewTimer();
    this.burstTargetPreview = createBurstTargetPreviewState();
  }

  clearTargetMarkers() {
    clearTargetMarkerLayer(this.targetMarkers);
    clearTargetMarkerLayer(this.focusedTargetMarker);
    this.lastTargetMarkerRenderState = null;
  }

  drawTargetMarkersForPreview(markerPreview, { force = false, time = performance.now() } = {}) {
    const renderState = getTargetMarkerRenderState(markerPreview.targets, null, markerPreview.burstRanges);
    if (force || !isSameTargetMarkerRenderState(renderState, this.lastTargetMarkerRenderState)) {
      this.lastTargetMarkerRenderState = renderState;
      drawTargetMarkers(this.targetMarkers, markerPreview.targets, null, time, markerPreview.burstRanges);
    }
    this.drawFocusedTargetMarkerForPreview(time);
  }

  drawFocusedTargetMarkerForPreview(time = performance.now()) {
    clearTargetMarkerLayer(this.focusedTargetMarker);
    const focusedTarget = this.getFocusedTarget();
    if (!focusedTarget) return;
    const marker = getTargetCenterMarkerPosition(focusedTarget);
    if (marker) drawFocusedTargetMarker(this.focusedTargetMarker, marker, time);
  }

  getBurstTargetRanges(targets = this.targets) {
    if (
      this.actionKey !== "burst"
      || this.volleyAction
      || !this.geometry
      || hasWeaponSpecialProperty(this.weapon, WEAPON_SPECIAL_PROPERTIES.hitAllConeTargets, this.weaponFunctionId)
    ) return new Map();
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    const projectileCount = getBurstProjectileCount(
      attackCount,
      getWeaponProjectileCountPerAttack(this.weapon, this.weaponFunctionId)
    );
    return buildBurstTargetRanges(
      this.token,
      this.geometry,
      targets,
      projectileCount,
      { purpose: "preview" }
    );
  }

  updatePointerFromClientEvent(event) {
    if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return;
    this.pointer = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    if (
      !this.processing
      && this.pushStrengthMaximum <= 0
      && !(this.targetedAction && ["limb", "direction"].includes(this.aimedMode))
    ) {
      this.previewFrameScheduler.request();
      this.previewFrameScheduler.flush();
    }
  }

  unlockAimedTarget() {
    this.aimedMode = "aim";
    this.selectedTarget = null;
    this.hoveredLimbKey = "";
    this.selectedLimbKey = "";
    this.lockedGeometry = null;
    this.removeLimbMenu();
    this.refresh(true);
  }

  refreshAimedLimbMenu() {
    if (!this.targetedAction || this.processing) return;
    const target = this.getFocusedTarget();
    if (!target) {
      this.aimedLimbMenuCache = null;
      this.removeLimbMenu();
      return;
    }

    const menuContext = this.getAimedLimbMenuContext(target);
    if (
      this.aimedLimbMenuCache?.key === menuContext.key
      && this.limbMenu
      && this.limbMenu.dataset.mode === this.aimedMode
    ) {
      this.positionLimbMenu(target);
      this.updateLimbMenuHover();
      return;
    }

    const rows = this.aimedMode === "direction"
      ? this.prepareAttackDirectionRows(target)
      : this.prepareAimedLimbRows(target, menuContext);
    if (!rows.length) {
      this.aimedLimbMenuCache = null;
      this.removeLimbMenu();
      if (this.meleeAction && this.aimedMode === "aim") this.refreshTargetedGeneralChanceMenu(target);
      else this.removeChanceMenu();
      return;
    }

    this.removeChanceMenu();
    if (!this.limbMenu) this.createLimbMenu();
    this.limbMenu.dataset.mode = this.aimedMode;
    const rangeBlocked = menuContext.rangeBlocked === true;
    const blockReason = rangeBlocked ? String(menuContext.blockReason ?? "") : "";
    this.limbMenu.classList.toggle("range-unavailable", rangeBlocked);
    this.limbMenu.dataset.rangeUnavailable = rangeBlocked ? "true" : "false";
    const warning = rangeBlocked ? `
      <div class="fallout-maw-aimed-range-warning" role="status">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>${escapeHtml(blockReason)}</span>
      </div>
    ` : "";
    const buttons = rows.map(row => {
      const unavailable = row.destroyed || rangeBlocked;
      return `
        <button type="button" ${row.direction ? `data-attack-direction="${escapeHtml(row.key)}"` : `data-limb-key="${escapeHtml(row.key)}"`} class="${[
          row.key === this.hoveredLimbKey ? "hover" : "",
          row.destroyed ? "destroyed" : "",
          rangeBlocked ? "range-unavailable" : ""
        ].filter(Boolean).join(" ")}" ${row.destroyed ? 'data-destroyed="true"' : ""} ${rangeBlocked ? 'data-range-unavailable="true"' : ""} ${unavailable ? "disabled" : ""} ${rangeBlocked ? `title="${escapeHtml(blockReason)}"` : ""}>
          <span>${escapeHtml(row.label)}</span>
          <strong class="${row.destroyed ? "" : getAimedChanceClass(row.chance)}">${row.destroyed ? "—" : `${row.chance}%`}</strong>
        </button>
      `;
    }).join("");
    this.limbMenu.innerHTML = `${warning}${buttons}`;
    this.aimedLimbMenuCache = { key: menuContext.key };
    this.positionLimbMenu(target);
    this.updateLimbMenuHover();
  }

  getAimedLimbMenuContext(target) {
    const rangeState = this.getAimedTargetRangeState(target);
    const rangeBlocked = rangeState.allowed === false;
    const blockReason = rangeBlocked ? formatAimedRangeBlockReason(rangeState) : "";
    const aimPoint = this.geometry
      ? (selectTargetTrajectoryAimPoint(this.token, target, this.geometry) ?? getTokenAimPoint(target))
      : null;
    const trajectory = this.geometry && aimPoint
      ? buildTrajectoryThroughPoint(this.token, this.geometry, aimPoint)
      : null;
    const blockerCount = this.ignoreAimedObstructions || !trajectory
      ? 0
      : getAimedTargetBlockers(this.token, target, trajectory, this.targetTokenUuidAllowlist).length;
    const previewContext = this.createWeaponAttackSkillCheckContext(target);
    const blockerBonus = getAimedTargetBlockerBonus(blockerCount)
      + getEffectiveRangeDifficultyBonus(
        this.weapon,
        this.token,
        target,
        this.weaponFunctionId,
        previewContext
      );
    const chanceOptions = {
      innateDifficultyIgnorePercent: this.getWeaponActionModifierState().getOption("innateAimedDifficultyIgnorePercent"),
      ignoreCover: this.ignoreAimedObstructions
    };
    const key = [
      target?.id ?? "",
      this.aimedMode,
      this.selectedLimbKey,
      blockerBonus,
      toInteger(chanceOptions.innateDifficultyIgnorePercent),
      chanceOptions.ignoreCover ? 1 : 0,
      rangeBlocked ? rangeState.side : "",
      rangeBlocked ? formatAimedRangeMeters(rangeState.attackDistanceMeters) : "",
      rangeBlocked ? formatAimedRangeMeters(rangeState.effectiveRange?.min) : "",
      rangeBlocked ? formatAimedRangeMeters(rangeState.effectiveRange?.max) : "",
      this.actionKey,
      this.weaponFunctionId,
      this.weapon?.id ?? ""
    ].join("|");
    return {
      blockerBonus,
      chanceOptions,
      key,
      blockerCount,
      previewContext,
      rangeState,
      rangeBlocked,
      blockReason
    };
  }

  refreshPushStrengthMenu() {
    if (this.processing || this.pushStrengthMaximum <= 1) return;
    if (!this.limbMenu) this.createLimbMenu();
    this.limbMenu.dataset.mode = "push-strength";
    this.limbMenu.classList.remove("range-unavailable");
    this.limbMenu.dataset.rangeUnavailable = "false";
    const distanceUnit = game.i18n.localize("FALLOUTMAW.Common.MeterShort");
    this.limbMenu.innerHTML = Array.from({ length: this.pushStrengthMaximum }, (_entry, index) => index + 1)
      .map(strength => `
        <button type="button" data-push-strength="${strength}" class="${String(strength) === this.hoveredLimbKey ? "hover" : ""}">
          <span>${strength} ${escapeHtml(distanceUnit)}</span>
        </button>
      `).join("");
    this.positionPushStrengthMenu();
    this.updateLimbMenuHover();
  }

  refreshTargetedGeneralChanceMenu(target) {
    if (!target) {
      this.removeChanceMenu();
      return;
    }
    if (!this.chanceMenu) this.createChanceMenu();
    const previewContext = this.createWeaponAttackSkillCheckContext(target);
    const chance = getGeneralAttackHitChance(this.token.actor, this.weapon, target.actor, {
      difficultyBonus: getEffectiveRangeDifficultyBonus(
        this.weapon,
        this.token,
        target,
        this.weaponFunctionId,
        previewContext
      ),
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      context: previewContext
    });
    this.chanceMenu.innerHTML = `
      <button type="button">
        <span>${escapeHtml(game.i18n.localize("FALLOUTMAW.Item.AttackChanceHit"))}</span>
        <strong class="${getAimedChanceClass(chance)}">${chance}%</strong>
      </button>
    `;
    this.positionChanceMenu();
  }

  refreshUntargetedChanceMenu() {
    if (this.targetedAction || this.processing) {
      this.removeChanceMenu();
      return;
    }
    const rows = this.prepareUntargetedChanceRows();
    if (!rows.length) {
      this.removeChanceMenu();
      return;
    }

    if (!this.chanceMenu) this.createChanceMenu();
    this.chanceMenu.innerHTML = rows.map(row => `
      <button type="button">
        <span>${escapeHtml(row.label)}</span>
        <strong class="${getAimedChanceClass(row.chance)}">${row.chance}%</strong>
      </button>
    `).join("");
    this.positionChanceMenu();
  }

  prepareUntargetedChanceRows() {
    if (!this.geometry) return [];
    if (this.volleyAction) {
      const weaponData = getWeaponAttackData(this.weapon, this.weaponFunctionId);
      const attackDistanceMeters = getAttackGeometryDistanceMeters(this.geometry);
      const rangeProfile = this.getRangeProfileForDistance(attackDistanceMeters, { weaponData });
      const previewContext = this.createWeaponAttackSkillCheckContext(null, {
        attackDistanceMeters,
        effectiveRange: rangeProfile.effectiveRange
      });
      return [{
        label: game.i18n.localize("FALLOUTMAW.Item.AttackChanceArea"),
        chance: getVolleyAreaHitChance(this.token.actor, this.weapon, this.geometry, {
          actionKey: this.actionKey,
          weaponFunctionId: this.weaponFunctionId,
          difficultyBonus: getBurstShotDifficultyBonus(
            this.weapon,
            this.actionKey,
            0,
            this.weaponFunctionId,
            this.token.actor,
            previewContext
          ),
          context: previewContext
        })
      }];
    }
    const target = getNearestAttackChanceTarget(
      this.token,
      this.geometry,
      this.targets,
      this.targetTokenUuidAllowlist
    );
    if (!target) return [];
    const previewContext = this.createWeaponAttackSkillCheckContext(target);
    return [{
      label: String(target.name ?? target.actor?.name ?? game.i18n.localize("FALLOUTMAW.Item.AttackChanceHit")),
      chance: getGeneralAttackHitChance(this.token.actor, this.weapon, target.actor, {
        difficultyBonus: getEffectiveRangeDifficultyBonus(
          this.weapon,
          this.token,
          target,
          this.weaponFunctionId,
          previewContext
        ),
        actionKey: this.actionKey,
        weaponFunctionId: this.weaponFunctionId,
        context: previewContext
      })
    }];
  }

  createChanceMenu() {
    this.chanceMenu = document.createElement("div");
    this.chanceMenu.className = "fallout-maw-aimed-limb-menu fallout-maw-attack-chance-menu";
    this.chanceMenu.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    document.body.append(this.chanceMenu);
  }

  removeChanceMenu() {
    this.chanceMenu?.remove();
    this.chanceMenu = null;
  }

  positionChanceMenu() {
    if (!this.chanceMenu || !this.pointer) return;
    const position = canvas.clientCoordinatesFromCanvas(this.pointer);
    const rect = this.chanceMenu.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, position.x + 12));
    const top = Math.max(margin, Math.min(window.innerHeight - rect.height - margin, position.y + 12));
    this.chanceMenu.style.left = `${Math.round(left)}px`;
    this.chanceMenu.style.top = `${Math.round(top)}px`;
  }

  createLimbMenu() {
    this.limbMenu = document.createElement("div");
    this.limbMenu.className = "fallout-maw-aimed-limb-menu";
    this.limbMenu.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    this.limbMenu.addEventListener("pointerover", event => {
      const button = event.target?.closest?.("[data-limb-key]");
      const directionButton = event.target?.closest?.("[data-attack-direction]");
      const strengthButton = event.target?.closest?.("[data-push-strength]");
      const activeButton = button ?? directionButton ?? strengthButton;
      if (!activeButton || activeButton.disabled) return;
      this.hoveredLimbKey = activeButton.dataset.limbKey ?? activeButton.dataset.attackDirection ?? activeButton.dataset.pushStrength ?? "";
      this.updateLimbMenuHover();
    });
    this.limbMenu.addEventListener("pointerout", event => {
      if (this.limbMenu?.contains(event.relatedTarget)) return;
      this.hoveredLimbKey = "";
      this.updateLimbMenuHover();
    });
    document.body.append(this.limbMenu);
  }

  updateLimbMenuHover() {
    for (const button of this.limbMenu?.querySelectorAll("[data-limb-key], [data-attack-direction], [data-push-strength]") ?? []) {
      const key = button.dataset.limbKey ?? button.dataset.attackDirection ?? button.dataset.pushStrength ?? "";
      button.classList.toggle("hover", key === this.hoveredLimbKey);
    }
    this.drawMeleeDirectionHoverPreview();
  }

  drawMeleeDirectionHoverPreview() {
    this.meleeDirectionPreview.clear();
    if (
      this.previewSuppressed
      || this.processing
      || !this.meleeAction
      || this.aimedMode !== "direction"
      || !this.selectedTarget
    ) return;

    const direction = getEnabledMeleeDirections(this.weapon, this.actionKey, this.weaponFunctionId)
      .find(entry => entry.key === this.hoveredLimbKey);
    if (!direction || direction.mode !== "swing") return;

    const geometry = deserializeGeometry(this.lockedGeometry) ?? this.geometry;
    const points = buildSwingDirectionPreviewPoints(this.selectedTarget, direction.key, geometry);
    if (points.length < 3) return;

    drawSwingDirectionPreview(this.meleeDirectionPreview, points);
  }

  removeLimbMenu() {
    this.aimedLimbMenuCache = null;
    this.limbMenu?.remove();
    this.limbMenu = null;
  }

  positionLimbMenu(target) {
    if (!this.limbMenu) return;
    const bounds = getTokenShapeBounds(target);
    if (!bounds) return;
    const topLeft = canvas.clientCoordinatesFromCanvas({ x: bounds.left, y: bounds.top });
    const bottomRight = canvas.clientCoordinatesFromCanvas({ x: bounds.right, y: bounds.bottom });
    const rect = this.limbMenu.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, topLeft.x - rect.width - 10));
    const top = Math.max(margin, Math.min(window.innerHeight - rect.height - margin, (topLeft.y + bottomRight.y - rect.height) / 2));
    this.limbMenu.style.left = `${Math.round(left)}px`;
    this.limbMenu.style.top = `${Math.round(top)}px`;
  }

  positionPushStrengthMenu() {
    if (!this.limbMenu || !this.pointer) return;
    const position = canvas.clientCoordinatesFromCanvas(this.pointer);
    const rect = this.limbMenu.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, position.x + 12));
    const top = Math.max(margin, Math.min(window.innerHeight - rect.height - margin, position.y + 12));
    this.limbMenu.style.left = `${Math.round(left)}px`;
    this.limbMenu.style.top = `${Math.round(top)}px`;
  }

  prepareAimedLimbRows(target, menuContext = null) {
    if (!this.requiresLimbSelection) return [];
    const context = menuContext ?? this.getAimedLimbMenuContext(target);
    const limbRows = Object.entries(target.actor?.system?.limbs ?? {})
      .filter(([_key, limb]) => limb && typeof limb === "object")
      .map(([key, limb]) => ({
        key,
        limbKey: key,
        label: String(limb.label ?? key),
        destroyed: isLimbDestroyed(target.actor, key)
      }));
    const weaponRows = this.aimedShot
      ? getHeldWeaponAimTargets(target.actor).map(entry => ({
        key: getAimedWeaponTargetKey(entry.item),
        limbKey: entry.limbKey,
        label: entry.label,
        destroyed: entry.destroyed || isLimbDestroyed(target.actor, entry.limbKey)
      }))
      : [];
    const rows = [...limbRows, ...weaponRows];
    const { blockerBonus, chanceOptions } = context;
    // One attacker+target contextual resolve for the whole menu (Foundry attack-config style).
    const chanceBasis = buildAimedAttackChanceBasis(
      this.token.actor,
      this.weapon,
      target.actor,
      this.weaponFunctionId,
      this.actionKey,
      context.previewContext ?? this.createWeaponAttackSkillCheckContext(target)
    );
    return rows.map(row => ({
      ...row,
      chance: row.destroyed
        ? 0
        : getAimedAttackHitChanceFromBasis(chanceBasis, row.limbKey, blockerBonus, chanceOptions)
    }));
  }

  prepareAttackDirectionRows(target) {
    const limbKey = this.selectedLimbKey;
    const previewContext = this.createWeaponAttackSkillCheckContext(target);
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(
      this.weapon,
      this.token,
      target,
      this.weaponFunctionId,
      previewContext
    );
    return getEnabledMeleeDirections(this.weapon, this.actionKey, this.weaponFunctionId).map(direction => ({
      key: direction.key,
      label: direction.label,
      direction: true,
      chance: getDirectedAttackHitChance(this.token.actor, this.weapon, target.actor, {
        actionKey: this.actionKey,
        mode: direction.mode,
        limbKey,
        difficultyBonus: rangeDifficultyBonus,
        weaponFunctionId: this.weaponFunctionId,
        context: previewContext
      })
    }));
  }

  recordCriticalFailureConsequences(outcome) {
    if (!isCriticalFailureAttack(outcome)) return;
    this.pendingCriticalFailureResourceCosts.push(...getCriticalFailureResourceCosts(this.weapon, this.actionKey, this.weaponFunctionId));
  }

  broadcastPreview(force = false, markerPreview = null) {
    if (this.suppressAttackPreviewBroadcast) return;
    const now = performance.now();
    if (!force && now - this.lastPreviewBroadcastAt < PREVIEW_BROADCAST_INTERVAL_MS) return;
    markerPreview ??= this.getTargetMarkerPreview(force);
    const previewState = {
      geometry: serializeGeometry(this.geometry),
      targetMarkers: markerPreview.targets.map(target => getTargetMarkerPreviewData(target, markerPreview.burstRanges)).filter(Boolean),
      focusedTargetMarker: this.getFocusedTarget() ? getTargetCenterMarkerPosition(this.getFocusedTarget()) : null,
      processing: this.processing
    };
    if (!force && isSamePreviewState(previewState, this.lastBroadcastPreviewState)) return;
    this.lastPreviewBroadcastAt = now;
    this.lastBroadcastPreviewState = previewState;
    broadcastAttackPreview({
      action: "updatePreview",
      attackId: this.previewAttackId,
      sceneId: canvas.scene?.id ?? "",
      ...previewState
    });
  }
}

export function getWeaponAttackData(weapon, weaponFunctionId = "") {
  const id = weaponFunctionId || ITEM_FUNCTIONS.weapon;
  const attackSource = resolveAttackSource(weapon, id);
  if (attackSource?.kind === "abilityAttack") {
    return applyWeaponAttackPowerModifiers(projectAbilityAttackData(attackSource.settings));
  }
  return applyWeaponAttackPowerModifiers(applyWeaponModuleModifiers(
    applyDamageSourceWeaponModifiers(getWeaponFunctionById(weapon, id) ?? {}),
    { moduleSlots: getAttackSourceModuleSlots(weapon, id) }
  ));
}

function applyDamageSourceWeaponModifiers(weaponData = {}) {
  if (String(weaponData?.damageMode ?? "manual") !== "source") return weaponData;
  const sourceItem = getWeaponMagazineSourceItem(weaponData);
  if (!sourceItem || !hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageSource)) return weaponData;
  const source = getDamageSourceFunction(sourceItem);
  return {
    ...weaponData,
    damage: source.damage,
    pellets: source.pellets,
    damageTypeKey: source.damageTypeKey,
    damageTypes: source.damageTypes,
    attackAnimationKey: resolveDamageSourceAnimationKey(weaponData.attackAnimationKey, source.attackAnimationKey),
    accuracyBonus: addFormulaTexts(weaponData.accuracyBonus, source.accuracyBonus),
    criticalChanceModifier: addFormulaTexts(weaponData.criticalChanceModifier, source.criticalChanceModifier),
    criticalDamagePercent: addFormulaTexts(weaponData.criticalDamagePercent, source.criticalDamagePercent),
    maxRangeMeters: addFormulaTexts(weaponData.maxRangeMeters, source.maxRangeMeters),
    effectiveRange: {
      value: addFormulaTexts(weaponData.effectiveRange?.value, source.effectiveRange?.value),
      max: addFormulaTexts(weaponData.effectiveRange?.max, source.effectiveRange?.max)
    },
    penetration: addFormulaTexts(weaponData.penetration, source.penetration),
    noiseLevel: getDamageSourceAdjustedNoiseLevel(weaponData, source),
    specialProperties: mergeDamageSourceSpecialProperties(weaponData, source),
    volley: mergeDamageSourceVolleyData(weaponData.volley, source.volley)
  };
}

function applyWeaponAttackPowerModifiers(weaponData = {}) {
  const state = getWeaponAttackPowerState(weaponData);
  if (!state.active || state.increments <= 0) return weaponData;
  const result = foundry.utils.deepClone(weaponData);
  const multiplier = state.increments;
  const perLevel = state.perLevel ?? {};

  result.attackPowerDamagePercent = toInteger(perLevel.damagePercent) * multiplier;
  addFormulaNumber(result, "accuracyBonus", perLevel.accuracyBonus, multiplier);
  addFormulaNumber(result, "criticalChanceModifier", perLevel.criticalChanceModifier, multiplier);
  addFormulaNumber(result, "criticalDamagePercent", perLevel.criticalDamagePercent, multiplier, { min: 0 });
  addNumber(result, "attackConeDegrees", perLevel.attackConeDegrees, multiplier, { min: 0 });
  addFormulaNumber(result, "maxRangeMeters", perLevel.maxRangeMeters, multiplier, { min: 0 });
  addFormulaNumber(result, "effectiveRange.value", perLevel.effectiveRange?.value, multiplier, { min: 0 });
  addFormulaNumber(result, "effectiveRange.max", perLevel.effectiveRange?.max, multiplier, { min: 0 });
  addFormulaNumber(result, "penetration", perLevel.penetration, multiplier, { min: 0, integer: true });
  applyWeaponAttackPowerResourceCosts(result, state.resourceCosts, multiplier);
  return result;
}

function applyWeaponAttackPowerResourceCosts(weaponData = {}, resourceCosts = [], multiplier = 0) {
  const costs = Array.isArray(weaponData.resourceCosts) ? foundry.utils.deepClone(weaponData.resourceCosts) : [];
  if (String(weaponData?.damageMode ?? "manual") === "source"
    && !costs.some(cost => getWeaponResourceCostIdentity(cost) === "magazine")) {
    costs.push({ type: "magazine", amount: 1 });
  }

  for (const cost of resourceCosts ?? []) {
    const type = String(cost?.type ?? "").trim();
    const resourceKey = type === "actorResource"
      ? String(cost?.resourceKey ?? "").trim()
      : "";
    const delta = toInteger(cost?.amount) * Math.max(0, toInteger(multiplier));
    const identity = getWeaponResourceCostIdentity({ type, resourceKey });
    if (!identity || !delta || (type === "actorResource" && !resourceKey)) continue;
    let target = costs.find(entry => getWeaponResourceCostIdentity(entry) === identity);
    if (!target) {
      target = type === "actorResource"
        ? { type, resourceKey, formula: "0", amount: 0 }
        : { type, amount: 0 };
      costs.push(target);
    }
    if (type === "actorResource") {
      target.resourceKey = resourceKey;
      target.formula = addFormulaTexts(target.formula, String(delta));
      target.amount = 0;
    } else {
      target.amount = Math.max(0, toInteger(target.amount) + delta);
    }
  }
  weaponData.resourceCosts = costs;
}

function getWeaponResourceCostIdentity(cost = {}) {
  const type = String(cost?.type ?? "").trim();
  if (!type) return "";
  if (type !== "actorResource") return type;
  const resourceKey = String(cost?.resourceKey ?? "").trim();
  return resourceKey ? `${type}:${resourceKey}` : "";
}

function addFormulaNumber(target, path, delta, multiplier = 1, { min = null, integer = false } = {}) {
  const change = (integer ? toInteger(delta) : Number(delta)) * Math.max(0, toInteger(multiplier));
  if (!Number.isFinite(change) || change === 0) return;
  const currentRaw = foundry.utils.getProperty(target, path);
  const current = Number(currentRaw);
  if (Number.isFinite(current)) {
    const next = Number.isFinite(Number(min)) ? Math.max(Number(min), current + change) : current + change;
    foundry.utils.setProperty(target, path, integer ? Math.trunc(next) : next);
    return;
  }
  const currentText = normalizeFormulaText(currentRaw);
  const deltaText = integer ? String(Math.trunc(change)) : String(change);
  foundry.utils.setProperty(target, path, addFormulaTexts(currentText, deltaText));
}

function addNumber(target, path, delta, multiplier = 1, { min = null, integer = false } = {}) {
  const change = (integer ? toInteger(delta) : Number(delta)) * Math.max(0, toInteger(multiplier));
  if (!Number.isFinite(change) || change === 0) return;
  const currentRaw = foundry.utils.getProperty(target, path);
  const current = integer ? toInteger(currentRaw) : Number(currentRaw);
  const fallback = Number.isFinite(current) ? current : 0;
  let next = fallback + change;
  if (Number.isFinite(Number(min))) next = Math.max(Number(min), next);
  foundry.utils.setProperty(target, path, integer ? Math.trunc(next) : next);
}

function mergeDamageSourceVolleyData(weaponVolley = {}, sourceVolley = {}) {
  return {
    ...(weaponVolley ?? {}),
    damageRadius: normalizeFormulaText(sourceVolley?.damageRadius),
    regionRadius: normalizeFormulaText(sourceVolley?.regionRadius),
    regionDamageEntries: Array.isArray(sourceVolley?.regionDamageEntries)
      ? foundry.utils.deepClone(sourceVolley.regionDamageEntries)
      : [],
    regionSpecialProperties: Array.isArray(sourceVolley?.regionSpecialProperties)
      ? foundry.utils.deepClone(sourceVolley.regionSpecialProperties)
      : [],
    regionDurationSeconds: normalizeFormulaText(sourceVolley?.regionDurationSeconds),
    regionDelaySeconds: normalizeFormulaText(sourceVolley?.regionDelaySeconds),
    regionRadiusDeltaMeters: normalizeFormulaText(sourceVolley?.regionRadiusDeltaMeters),
    explosionAnimationKey: resolveDamageSourceAnimationKey(
      weaponVolley?.explosionAnimationKey,
      sourceVolley?.explosionAnimationKey
    )
  };
}

function getWeaponAttackSourceData(weapon, weaponFunctionId = "") {
  return getAttackSourceRawData(weapon, weaponFunctionId);
}

export function hasWeaponAction(weapon, actionKey, weaponFunctionId = "") {
  return Boolean(getWeaponAttackData(weapon, weaponFunctionId)?.availableActions?.[actionKey]);
}

function isWeaponActionBlocked(actor, actionKey = "") {
  const state = getWeaponActionBlockState(actor, actionKey);
  if (!state.blocked) return false;
  ui.notifications.warn(`${actor?.name ?? ""}: действие заблокировано (${state.effect?.name ?? actionKey}).`);
  return true;
}

function hasWeaponSpecialProperty(weapon, property, weaponFunctionId = "") {
  return hasWeaponSpecialPropertyData(getWeaponAttackData(weapon, weaponFunctionId), property);
}

function isVolleyAttackAction(weapon, actionKey, weaponFunctionId = "") {
  const actions = getWeaponAttackData(weapon, weaponFunctionId)?.availableActions ?? {};
  if (actionKey === VOLLEY_ACTION_KEY) return Boolean(actions.volley);
  return actionKey === "burst" && Boolean(actions.burst) && Boolean(actions.volley);
}

function broadcastAttackPreview(payload = {}) {
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    sceneId: canvas.scene?.id ?? "",
    levelId: canvas.level?.id ?? "",
    ...payload,
    senderUserId: game.user?.id ?? ""
  });
}

function handleWeaponAttackSocketMessage(payload = {}, socketSenderUserId = "") {
  const authenticatedSenderUserId = String(socketSenderUserId ?? "").trim();
  if (
    !payload
    || payload.scope !== WEAPON_ATTACK_SOCKET_SCOPE
    || !authenticatedSenderUserId
    || payload.senderUserId !== authenticatedSenderUserId
    || authenticatedSenderUserId === game.user?.id
  ) return;
  if (payload.action === "ordinaryAttackRequest") {
    void handleOrdinaryWeaponAttackSocketRequest(payload, authenticatedSenderUserId);
    return;
  }
  if (
    payload.action === "ordinaryAttackAccepted"
    || payload.action === "ordinaryAttackProgress"
    || payload.action === "ordinaryAttackResult"
  ) {
    settlePendingOrdinaryAttackRequest(payload, authenticatedSenderUserId);
    return;
  }
  if (payload.action === "weaponAttackTerminal") {
    if (!game.user?.isActiveGM || payload.targetUserId !== game.user.id) return;
    const sender = game.users?.get?.(authenticatedSenderUserId) ?? null;
    const context = authorizeWeaponAttackTerminalContext(payload.context, sender);
    if (context) void runWeaponAttackTerminalHandlers(context);
    return;
  }
  if (payload.action === "completeAttack") {
    requestActiveWeaponAttackFinish(payload.attackId);
    removeRemoteAttackPreview(payload.attackId);
    return;
  }
  if (payload.action === "createVolleyDamageRegionsResult") {
    if (payload.targetUserId && payload.targetUserId !== game.user?.id) return;
    const pending = pendingRegionSocketRequests.get(payload.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingRegionSocketRequests.delete(payload.requestId);
    if (payload.ok) {
      pending.resolve(Array.isArray(payload.damageResults)
        ? { damage: payload.damageResults, regions: payload.results ?? [] }
        : payload.results ?? []);
    }
    else pending.reject(new Error(payload.error || "Volley region socket request failed."));
    return;
  }
  if (payload.action === "createVolleyDamageRegions") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    void createVolleyDamageRegions(payload.regions).then(results => {
      respondVolleyRegionSocketRequest(payload, { ok: true, results: serializeRegionSocketResults(results) });
    }).catch(error => {
      console.error("Fallout MaW | Volley region socket request failed", error);
      respondVolleyRegionSocketRequest(payload, {
        ok: false,
        error: String(error?.message ?? error ?? "Volley region socket request failed."),
        results: []
      });
    });
    return;
  }
  if (payload.action === "applyDamageAndCreateVolleyDamageRegions") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    void applyDamageAndCreateVolleyDamageRegions(payload.damageRequests, payload.regionRequests).then(results => {
      respondVolleyRegionSocketRequest(payload, {
        ok: true,
        results: serializeRegionSocketResults(results.regions),
        damageResults: serializeWeaponAttackTerminalDamageResults(results.damage)
      });
    }).catch(error => {
      console.error("Fallout MaW | Volley damage and region socket request failed", error);
      respondVolleyRegionSocketRequest(payload, {
        ok: false,
        error: String(error?.message ?? error ?? "Volley damage and region socket request failed."),
        results: []
      });
    });
    return;
  }
  if (payload.action === "createVolleyDamageRegion") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    void createVolleyDamageRegion(payload.region);
    return;
  }
  if (payload.action === "createDelayedVolleyExplosionRegion") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    void createDelayedVolleyExplosionRegionNow(payload.region).then(region => {
      respondVolleyRegionSocketRequest(payload, { ok: true, results: serializeRegionSocketResults([region]) });
    }).catch(error => {
      console.error("Fallout MaW | Delayed volley region socket request failed", error);
      respondVolleyRegionSocketRequest(payload, {
        ok: false,
        error: String(error?.message ?? error ?? "Delayed volley region socket request failed."),
        results: []
      });
    });
    return;
  }
  if (payload.action === "clearPreview") {
    removeRemoteAttackPreview(payload.attackId);
    return;
  }
  if (payload.action !== "updatePreview") return;
  if (
    payload.sceneId !== canvas.scene?.id
    || String(payload.levelId ?? "") !== String(canvas.level?.id ?? "")
  ) {
    removeRemoteAttackPreview(payload.attackId);
    return;
  }
  updateRemoteAttackPreview(payload);
}

function requestActiveWeaponAttackFinish(attackId = "") {
  const normalizedAttackId = String(attackId ?? "").trim();
  if (!normalizedAttackId) return false;
  if (activeAttack?.previewAttackId === normalizedAttackId) {
    activeAttack.requestFinish();
    return true;
  }
  removeRemoteAttackPreview(normalizedAttackId);
  return false;
}

function updateRemoteAttackPreview(payload = {}) {
  const attackId = String(payload.attackId ?? "");
  const geometry = deserializeGeometry(payload.geometry);
  if (!attackId || !geometry) return;

  let preview = remoteAttackPreviews.get(attackId);
  if (!preview) {
    preview = {
      container: new PIXI.Container(),
      shape: new PIXI.Graphics(),
      targetMarkers: new PIXI.Graphics()
    };
    preview.container.eventMode = "none";
    preview.container.addChild(preview.shape, preview.targetMarkers);
    getCombatVisualizationLayer().addChild(preview.container);
    remoteAttackPreviews.set(attackId, preview);
  }

  preview.shape.clear();
  drawAttackShape(preview.shape, geometry, {
    locked: Boolean(payload.processing),
    hasTargets: Array.isArray(payload.targetMarkers) && payload.targetMarkers.length > 0
  });
  drawTargetMarkerPositions(preview.targetMarkers, payload.targetMarkers ?? [], payload.focusedTargetMarker ?? null);
}

function removeRemoteAttackPreview(attackId = "") {
  const preview = remoteAttackPreviews.get(String(attackId));
  if (!preview) return;
  if (!preview.container.destroyed) preview.container.destroy({ children: true });
  remoteAttackPreviews.delete(String(attackId));
}

function clearRemoteAttackPreviews() {
  for (const attackId of Array.from(remoteAttackPreviews.keys())) removeRemoteAttackPreview(attackId);
}

function respondVolleyRegionSocketRequest(payload = {}, {
  ok = true,
  error = "",
  results = [],
  damageResults = null
} = {}) {
  if (!payload.requestId || !payload.senderUserId) return;
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "createVolleyDamageRegionsResult",
    senderUserId: game.user?.id ?? "",
    targetUserId: payload.senderUserId,
    requestId: payload.requestId,
    ok,
    error,
    results,
    ...(Array.isArray(damageResults) ? { damageResults } : {})
  });
}

function serializeRegionSocketResults(regions = []) {
  return (Array.isArray(regions) ? regions : [regions])
    .filter(Boolean)
    .map(region => ({
      uuid: String(region.uuid ?? ""),
      id: String(region.id ?? ""),
      name: String(region.name ?? "")
    }));
}

async function requestCreateVolleyDamageRegion(regionData = {}) {
  if (!regionData?.sceneId) return null;
  const results = await requestCreateVolleyDamageRegions([regionData]);
  return results?.[0] ?? null;
}

async function requestCreateVolleyDamageRegions(regions = []) {
  const regionData = (Array.isArray(regions) ? regions : [regions])
    .filter(region => region?.sceneId);
  if (!regionData.length) return [];
  if (game.user?.isGM) return createVolleyDamageRegions(regionData);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для создания области урона.");
    return [];
  }

  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRegionSocketRequests.delete(requestId);
      reject(new Error("Volley region socket request timed out."));
    }, REGION_SOCKET_REQUEST_TIMEOUT_MS);
    pendingRegionSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "createVolleyDamageRegions",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    requestId,
    regions: regionData
  });

  try {
    return await promise;
  } catch (error) {
    console.error("Fallout MaW | Volley region socket request failed", error);
    ui.notifications.warn("Нет ответа GM на создание областей урона.");
    return [];
  }
}

async function requestCreateDelayedVolleyExplosionRegion(regionData = null) {
  if (!regionData?.sceneId) return null;
  if (game.user?.isGM) return createDelayedVolleyExplosionRegionNow(regionData);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для создания области отложенного взрыва.");
    return null;
  }

  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRegionSocketRequests.delete(requestId);
      reject(new Error("Delayed volley region socket request timed out."));
    }, REGION_SOCKET_REQUEST_TIMEOUT_MS);
    pendingRegionSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "createDelayedVolleyExplosionRegion",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    requestId,
    region: regionData
  });

  try {
    const results = await promise;
    return results?.[0] ?? null;
  } catch (error) {
    console.error("Fallout MaW | Delayed volley region socket request failed", error);
    ui.notifications.warn("Нет ответа GM на создание области отложенного взрыва.");
    return null;
  }
}

async function requestApplyDamageAndCreateVolleyDamageRegions(damageRequests = [], regionRequests = []) {
  const serializableDamageRequests = serializeWeaponDamageRequests(damageRequests);
  const regions = (Array.isArray(regionRequests) ? regionRequests : [regionRequests])
    .filter(region => region?.sceneId);
  if (!serializableDamageRequests.length && !regions.length) return { damage: [], regions: [] };
  if (game.user?.isGM) return applyDamageAndCreateVolleyDamageRegions(serializableDamageRequests, regions);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для обработки урона и областей.");
    return { damage: [], regions: [] };
  }

  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRegionSocketRequests.delete(requestId);
      reject(new Error("Volley damage and region socket request timed out."));
    }, REGION_SOCKET_REQUEST_TIMEOUT_MS);
    pendingRegionSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "applyDamageAndCreateVolleyDamageRegions",
    gmUserId: gm.id,
    senderUserId: game.user?.id ?? "",
    requestId,
    damageRequests: serializableDamageRequests,
    regionRequests: regions
  });

  try {
    const results = await promise;
    return Array.isArray(results)
      ? { damage: [], regions: results }
      : { damage: results?.damage ?? [], regions: results?.regions ?? [] };
  } catch (error) {
    console.error("Fallout MaW | Volley damage and region socket request failed", error);
    ui.notifications.warn("Нет ответа GM на обработку урона и областей.");
    return { damage: [], regions: [] };
  }
}

async function createVolleyDamageRegion(regionData = {}) {
  const results = await createVolleyDamageRegions([regionData]);
  return results?.[0] ?? null;
}

async function applyDamageAndCreateVolleyDamageRegions(damageRequests = [], regionRequests = []) {
  const serializableDamageRequests = serializeWeaponDamageRequests(damageRequests);
  const regions = (Array.isArray(regionRequests) ? regionRequests : [regionRequests])
    .filter(region => region?.sceneId);
  const operationRef = String(
    serializableDamageRequests.find(request => request?.source?.damageHubOperationRef)?.source?.damageHubOperationRef
    ?? ""
  ).trim();
  return runDamageHubOperation(async () => {
    const volleyLogicalWorldTime = Number(game.time?.worldTime) || 0;
    const damage = serializableDamageRequests.length
      ? await applyDamageRequestsInCurrentHubOperation(serializableDamageRequests, volleyLogicalWorldTime)
      : [];
    const createdRegions = regions.length ? await createVolleyDamageRegionsNow(regions) : [];
    return { damage, regions: createdRegions };
  }, { operationRef });
}

async function createVolleyDamageRegionsNow(regions = []) {
  const created = [];
  for (const data of regions) {
    const region = await createVolleyDamageRegionNow(data);
    if (region) created.push(region);
  }
  return created;
}

async function createVolleyDamageRegions(regions = []) {
  const regionData = (Array.isArray(regions) ? regions : [regions])
    .filter(region => region?.sceneId);
  if (!regionData.length) return [];
  return runDamageHubOperation(() => createVolleyDamageRegionsNow(regionData));
}

async function createVolleyDamageRegionNow(regionData = {}) {
  const scene = game.scenes?.get(String(regionData.sceneId ?? "")) ?? canvas.scene;
  if (!scene || !game.user?.isGM) return null;

  const center = serializePoint(regionData.center);
  const radiusPixels = Math.max(0, Number(regionData.radiusPixels) || 0);
  const damageEntries = (Array.isArray(regionData.damageEntries) ? regionData.damageEntries : [])
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      amount: String(entry?.amount ?? "0").trim() || "0"
    }))
    .filter(entry => entry.damageTypeKey && isFormulaTextConfigured(entry.amount));
  if (!radiusPixels) return null;

  const durationSeconds = Math.max(0, toInteger(regionData.durationSeconds));
  const delaySeconds = Math.max(0, toInteger(regionData.delaySeconds));
  if (durationSeconds <= 0) return null;
  const levelId = getRegionRestrictionLevelId(scene);
  const centerElevation = Number.isFinite(Number(center.elevation)) ? Number(center.elevation) : 0;

  const created = await scene.createEmbeddedDocuments("Region", [{
    name: String(regionData.name ?? "").trim() || game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.RegionName"),
    color: String(regionData.color ?? (damageEntries.length ? "#dd8431" : "#8a8a8a")),
    shapes: [{
      type: "circle",
      x: center.x,
      y: center.y,
      radius: radiusPixels,
      gridBased: false
    }],
    elevation: getSphericalRegionElevation(centerElevation, radiusPixels, scene),
    levels: levelId ? [levelId] : [],
    restriction: { enabled: Boolean(levelId), type: "move", priority: 0 },
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    highlightMode: "shapes",
    displayMeasurements: false,
    flags: getSphericalRegionFlags(centerElevation),
    behaviors: [{
      name: game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.Name"),
      type: PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE,
      system: {
        damageEntries,
        regionSpecialProperties: normalizeRegionSpecialProperties(regionData.regionSpecialProperties),
        intervalSeconds: DEFAULT_REGION_DAMAGE_INTERVAL_SECONDS,
        delaySeconds,
        durationSeconds,
        radiusDeltaMeters: Number(regionData.radiusDeltaMeters) || 0,
        deleteRegionWhenExpired: true
      }
    }]
  }]);
  return created?.[0] ?? null;
}

async function createDelayedVolleyExplosionRegionNow(regionData = {}) {
  const scene = game.scenes?.get(String(regionData.sceneId ?? "")) ?? canvas.scene;
  if (!scene || !game.user?.isGM) return null;

  const explosions = (Array.isArray(regionData.explosions) ? regionData.explosions : [])
    .filter(explosion => explosion?.center && Number(explosion.radiusPixels) > 0);
  const delayedThrownItemId = String(regionData.delayedThrownItemId ?? "").trim();
  const attachmentTokenId = String(regionData.attachmentTokenId ?? "").trim();
  const explodeAtWorldTime = Number(regionData.explodeAtWorldTime);
  if (!explosions.length || !delayedThrownItemId || !Number.isFinite(explodeAtWorldTime)) return null;
  registerDelayedThrownItemWorldOperation(
    delayedThrownItemId,
    regionData?.source?.attackerUuid
  );
  if (isDelayedThrownItemWorldOperationCancelled(delayedThrownItemId)) return null;

  const levelId = getRegionRestrictionLevelId(scene);
  const shapes = explosions.map(explosion => ({
    type: "circle",
    x: Number(explosion.center.x) || 0,
    y: Number(explosion.center.y) || 0,
    radius: Math.max(1, Number(explosion.radiusPixels) || 1),
    gridBased: false
  }));
  const existing = (scene.regions?.contents ?? []).find(region => (
    String(region.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_REGION_FLAG)?.id ?? "") === delayedThrownItemId
  ));
  if (existing) {
    const updateData = {
      _id: existing.id,
      shapes,
      levels: levelId ? [levelId] : [],
      hidden: false,
      attachment: { token: attachmentTokenId || null }
    };
    if (regionData.persistPendingData === true) {
      updateData[`flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_REGION_FLAG}.explodeAtWorldTime`] = explodeAtWorldTime;
      updateData[`flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_REGION_FLAG}.explosions`] = foundry.utils.deepClone(explosions);
      updateData[`flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_REGION_FLAG}.source`] = foundry.utils.deepClone(regionData.source ?? {});
    }
    const updated = await scene.updateEmbeddedDocuments("Region", [updateData]);
    const region = updated?.[0] ?? existing;
    if (isDelayedThrownItemWorldOperationCancelled(delayedThrownItemId)) {
      await deleteDelayedVolleyRegionIfMatching(scene, region, delayedThrownItemId);
      return null;
    }
    return region;
  }

  const created = await scene.createEmbeddedDocuments("Region", [{
    name: String(regionData.name ?? "").trim() || "Отложенный взрыв",
    color: String(regionData.color ?? "#dd8431"),
    shapes,
    elevation: { bottom: null, top: null },
    levels: levelId ? [levelId] : [],
    restriction: { enabled: false, type: "move", priority: 0 },
    attachment: { token: attachmentTokenId || null },
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    highlightMode: "shapes",
    displayMeasurements: false,
    behaviors: [],
    flags: {
      [SYSTEM_ID]: {
        [DELAYED_THROWN_ITEM_REGION_FLAG]: {
          id: delayedThrownItemId,
          explodeAtWorldTime,
          explosions: foundry.utils.deepClone(explosions),
          source: foundry.utils.deepClone(regionData.source ?? {})
        }
      }
    }
  }]);
  const region = created?.[0] ?? null;
  if (isDelayedThrownItemWorldOperationCancelled(delayedThrownItemId)) {
    await deleteDelayedVolleyRegionIfMatching(scene, region, delayedThrownItemId);
    return null;
  }
  return region;
}

async function deleteDelayedVolleyRegionIfMatching(scene = null, region = null, delayedThrownItemId = "") {
  const regionId = String(region?.id ?? "").trim();
  const id = String(delayedThrownItemId ?? "").trim();
  if (!scene || !regionId || !id) return false;
  const current = scene.regions?.get?.(regionId) ?? region;
  if (String(current?.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_REGION_FLAG)?.id ?? "") !== id) return false;
  await scene.deleteEmbeddedDocuments("Region", [regionId]);
  return true;
}

function createDelayedVolleySourceContextSnapshot(actor, effectKey = "", {
  baseValue = 0,
  alternateKeys = [],
  ...context
} = {}) {
  const numericBaseValue = Number(baseValue);
  const resolvedBaseValue = Number.isFinite(numericBaseValue) ? numericBaseValue : 0;
  const preparedChanges = getPreparedSourceContextualAbilityChanges(actor, effectKey, {
    ...context,
    alternateKeys
  });
  return {
    baseValue: resolvedBaseValue,
    sourceValue: applyPreparedSourceContextualAbilityChanges(resolvedBaseValue, preparedChanges),
    preparedChanges
  };
}

function getDelayedVolleyMergedSourceContextValue(actor, effectKey = "", context = {}, snapshot = null, {
  alternateKeys = []
} = {}) {
  const storedBaseValue = Number(snapshot?.baseValue);
  if (!Number.isFinite(storedBaseValue) || !Array.isArray(snapshot?.preparedChanges)) return null;
  if (!actor) {
    return applyPreparedSourceContextualAbilityChanges(storedBaseValue, snapshot.preparedChanges);
  }
  const targetChanges = getPreparedSourceContextualAbilityChanges(actor, effectKey, {
    ...context,
    alternateKeys,
    targetContextOnly: true
  });
  return applyPreparedSourceContextualAbilityChanges(storedBaseValue,
    mergePreparedSourceContextualAbilityChanges(snapshot.preparedChanges, targetChanges));
}

function getDelayedVolleyTargetPenetrationPower({
  explosion = {},
  source = {},
  attackerActor = null,
  attackerToken = null,
  targetToken = null
} = {}) {
  const hasDeferredContext = explosion.penetrationBasePower !== null
    && explosion.penetrationBasePower !== undefined
    && explosion.penetrationBasePower !== ""
    && Number.isFinite(Number(explosion.penetrationBasePower));
  const baseValue = hasDeferredContext
    ? Number(explosion.penetrationBasePower)
    : Number(explosion.penetrationPower) || 0;
  const effectKey = `${ACTION_PENETRATION_KEY_PREFIX}${String(source.actionKey ?? "").trim()}`;
  const context = {
    ...normalizeAttackDistanceContext(explosion),
    actorToken: attackerToken,
    alternateKeys: [ALL_ACTION_PENETRATION_KEY],
    targetActor: targetToken?.actor ?? null,
    targetToken,
    weaponActionKey: String(source.actionKey ?? ""),
    weaponData: source.weaponData ?? null
  };
  let value;
  const mergedSourceValue = getDelayedVolleyMergedSourceContextValue(
    attackerActor,
    effectKey,
    context,
    explosion.penetrationContextSnapshot,
    { alternateKeys: [ALL_ACTION_PENETRATION_KEY] }
  );
  if (Number.isFinite(mergedSourceValue)) {
    value = getTargetReverseAbilityChangeValue(attackerActor, effectKey, {
      ...context,
      baseValue: mergedSourceValue
    });
  } else if (hasDeferredContext) {
    const snapshottedTargetlessValue = Number.isFinite(Number(explosion.penetrationPower))
      ? Number(explosion.penetrationPower)
      : baseValue;
    const sourceTargetValue = getSourceContextualAbilityChangeValue(attackerActor, effectKey, {
      ...context,
      baseValue: snapshottedTargetlessValue,
      targetContextOnly: true
    });
    value = getTargetReverseAbilityChangeValue(attackerActor, effectKey, {
      ...context,
      baseValue: sourceTargetValue
    });
  } else {
    value = getTargetReverseAbilityChangeValue(null, effectKey, {
      ...context,
      baseValue
    });
  }
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function createDelayedVolleyCombatValueSnapshot(actor, key = "", context = {}) {
  const effectKey = `system.combat.${String(key ?? "").trim()}`;
  const actorBaseValue = toInteger(actor?.system?.combat?.[key]);
  const sourceSnapshot = createDelayedVolleySourceContextSnapshot(actor, effectKey, {
    ...context,
    baseValue: actorBaseValue
  });
  const fullContextValue = getContextualCombatValue(actor, key, context);
  const baselineValue = getContextualCombatValue(actor, key, getDamageBaselineContext(context));
  return {
    ...sourceSnapshot,
    abilityBaseValue: sourceSnapshot.sourceValue,
    baselineValue,
    modifierBonus: fullContextValue - sourceSnapshot.sourceValue
  };
}

function getDelayedVolleyCombatValueDelta(attackerActor, key = "", context = {}, snapshot = null) {
  const effectKey = `system.combat.${String(key ?? "").trim()}`;
  const baselineContext = getDamageBaselineContext(context);
  const storedAbilityBase = Number(snapshot?.abilityBaseValue);
  const storedModifierBonus = Number(snapshot?.modifierBonus);
  const mergedSourceValue = getDelayedVolleyMergedSourceContextValue(attackerActor, effectKey, context, snapshot);
  if (Number.isFinite(mergedSourceValue) && Number.isFinite(storedModifierBonus)) {
    const storedSourceValue = Number.isFinite(Number(snapshot?.sourceValue))
      ? Number(snapshot.sourceValue)
      : applyPreparedSourceContextualAbilityChanges(Number(snapshot?.baseValue) || 0, snapshot.preparedChanges);
    const targetAdjustedValue = getTargetReverseAbilityChangeValue(attackerActor, effectKey, {
      ...context,
      baseValue: mergedSourceValue
    });
    const storedBaselineValue = Number(snapshot?.baselineValue);
    const baselineValue = Number.isFinite(storedBaselineValue)
      ? storedBaselineValue
      : storedSourceValue + storedModifierBonus;
    const finalValue = targetAdjustedValue + storedModifierBonus;
    return finalValue - baselineValue;
  }

  if (Number.isFinite(storedAbilityBase) && Number.isFinite(storedModifierBonus)) {
    const snapshottedSourceValue = getSourceContextualAbilityChangeValue(attackerActor, effectKey, {
      ...context,
      baseValue: storedAbilityBase,
      targetContextOnly: true
    });
    const targetAdjustedValue = getTargetReverseAbilityChangeValue(attackerActor, effectKey, {
      ...context,
      baseValue: snapshottedSourceValue
    });
    const baselineValue = storedAbilityBase + storedModifierBonus;
    const finalValue = targetAdjustedValue + storedModifierBonus;
    return finalValue - baselineValue;
  }

  return getContextualCombatValue(attackerActor, key, context)
    - getContextualCombatValue(attackerActor, key, baselineContext);
}

function createDelayedVolleyTargetDamageContext({
  explosion = {},
  source = {},
  attackerToken = null,
  targetToken = null
} = {}) {
  return {
    ...normalizeAttackDistanceContext(explosion),
    actorToken: attackerToken,
    targetActor: targetToken?.actor ?? null,
    targetToken,
    weaponActionKey: String(source.actionKey ?? ""),
    weaponData: source.weaponData ?? null,
    weaponFunctionId: String(source.weaponFunctionId ?? "")
  };
}

function applyDelayedVolleyContextualDamageToAmount(amount, {
  explosion = {},
  source = {},
  weapon = null,
  attackerActor = null,
  attackerToken = null,
  targetToken = null,
  damageScale = 1
} = {}) {
  const context = createDelayedVolleyTargetDamageContext({
    explosion,
    source,
    attackerToken,
    targetToken
  });
  const flatDelta = getDelayedVolleyCombatValueDelta(
    attackerActor,
    "damageFlat",
    context,
    explosion.damageContextSnapshot?.damageFlat
  );
  const percentDelta = getDelayedVolleyCombatValueDelta(
    attackerActor,
    "damagePercent",
    context,
    explosion.damageContextSnapshot?.damagePercent
  );
  const storedPercentBase = Number(explosion.damagePercentBaseAmount);
  const percentBaseAmount = Number.isFinite(storedPercentBase)
    ? Math.max(0, storedPercentBase)
    : getWeaponDamagePercentBase(weapon, String(source.weaponFunctionId ?? ""));
  const scale = Math.max(0, Number(damageScale) || 0);
  const adjusted = Math.max(0, Number(amount) || 0)
    + (flatDelta * scale)
    + (percentBaseAmount * scale * percentDelta / 100);
  return Math.max(0, Math.round(adjusted));
}

function getDelayedVolleyTargetCriticalDamageSnapshot({
  explosion = {},
  source = {},
  attackerActor = null,
  attackerToken = null,
  targetToken = null
} = {}) {
  const storedCriticalSnapshot = explosion.criticalDamageSnapshot;
  if (!storedCriticalSnapshot || typeof storedCriticalSnapshot !== "object") return null;
  if (storedCriticalSnapshot.criticalSuccess !== true) return storedCriticalSnapshot;

  const contextSnapshot = explosion.criticalDamageContextSnapshot;
  const storedSourceValue = Number(contextSnapshot?.sourceValue);
  if (!Number.isFinite(storedSourceValue)) return storedCriticalSnapshot;
  const context = createDelayedVolleyTargetDamageContext({
    explosion,
    source,
    attackerToken,
    targetToken
  });
  const mergedSourceValue = getDelayedVolleyMergedSourceContextValue(
    attackerActor,
    CRITICAL_DAMAGE_PERCENT_EFFECT_KEY,
    context,
    contextSnapshot
  );
  if (!Number.isFinite(mergedSourceValue)) return storedCriticalSnapshot;
  const targetAdjustedValue = getTargetReverseAbilityChangeValue(
    attackerActor,
    CRITICAL_DAMAGE_PERCENT_EFFECT_KEY,
    {
      ...context,
      baseValue: mergedSourceValue
    }
  );
  const targetDelta = (Number(targetAdjustedValue) || 0) - storedSourceValue;
  return {
    ...storedCriticalSnapshot,
    criticalDamagePercent: Math.max(
      0,
      (Number(storedCriticalSnapshot.criticalDamagePercent) || 0) + targetDelta
    )
  };
}

async function requestDelayedVolleyTargetReaction({ source = {}, target = null, explosion = {} } = {}) {
  const attackerActorUuid = String(source.attackerUuid ?? "").trim();
  const attackerTokenUuid = String(source.attackerTokenUuid ?? "").trim();
  const targetActorUuid = String(target?.actor?.uuid ?? "").trim();
  const targetTokenUuid = String(target?.document?.uuid ?? "").trim();
  if (!attackerActorUuid || !attackerTokenUuid || !targetActorUuid || !targetTokenUuid) return null;
  try {
    return await requestReactionEvent(REACTION_EVENT_KEYS.weaponAttackTargeted, {
      attackId: String(source.attackId ?? ""),
      attackerActorUuid,
      attackerTokenUuid,
      targetActorUuid,
      targetTokenUuid,
      weaponUuid: String(source.weaponUuid ?? ""),
      actionKey: String(source.actionKey ?? ""),
      weaponFunctionId: String(source.weaponFunctionId ?? ""),
      suppressGuardianAngelReaction: Boolean(source.suppressGuardianAngelReaction),
      deferredImpactResolution: true,
      ...normalizeAttackDistanceContext(explosion),
      chainRef: source.chainRef ?? null,
      damageHubOperationRef: String(source.damageHubOperationRef ?? ""),
      title: "Реакция на атаку",
      message: `${target.actor.name}: попадание в область отложенного взрыва.`
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Delayed volley target reaction failed`, error);
    return null;
  }
}

async function processDelayedVolleyExplosions(worldTime = 0) {
  if (!game.user?.isGM || getResponsibleGM()?.id !== game.user.id) return;
  const scene = canvas.scene;
  if (!scene) return;
  const now = Number(worldTime) || Number(game.time?.worldTime) || 0;
  const dueRegions = (scene.regions?.contents ?? []).filter(region => {
    const pending = region.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_REGION_FLAG);
    return pending?.id && Number(pending.explodeAtWorldTime) <= now;
  });
  for (const region of dueRegions) await resolveDelayedVolleyExplosionRegion(region, now);
}

async function resolveDelayedVolleyExplosionRegion(region = null, worldTime = 0) {
  if (!region?.id || processingDelayedVolleyRegions.has(region.uuid)) return;
  const pending = region.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_REGION_FLAG);
  if (!pending?.id) return;
  processingDelayedVolleyRegions.add(region.uuid);
  try {
    const scene = region.parent;
    if (!scene || canvas.scene?.id !== scene.id) return;
    const source = pending.source ?? {};
    const attackerToken = scene.tokens?.get(String(region.attachment?.token ?? ""))?.object
      ?? scene.tokens?.get(String(source.attackerTokenId ?? ""))?.object
      ?? canvas.tokens?.placeables?.at(0)
      ?? null;
    const delayedWeapon = String(source.weaponUuid ?? "").trim() && typeof fromUuidSync === "function"
      ? fromUuidSync(String(source.weaponUuid))
      : null;
    const contextualAttackerToken = attackerToken?.actor?.uuid === String(source.attackerUuid ?? "")
      ? attackerToken
      : null;
    const storedAttackerDocument = String(source.attackerUuid ?? "").trim() && typeof fromUuidSync === "function"
      ? fromUuidSync(String(source.attackerUuid))
      : null;
    const contextualAttackerActor = contextualAttackerToken?.actor
      ?? getWeaponOwnerActor(delayedWeapon)
      ?? (storedAttackerDocument?.documentName === "Actor" ? storedAttackerDocument : storedAttackerDocument?.actor)
      ?? null;

    const damageRequests = [];
    const regionRequests = [];
    const targetActorUuids = new Set();
    const targetTokenUuids = new Set();
    const impactedLivingActorUuids = new Set();
    const preExistingUnconsciousTargetActorUuids = new Set();
    const reactedTargetTokenUuids = new Set();
    const explosions = Array.isArray(pending.explosions) ? pending.explosions : [];
    const shapes = Array.from(region.shapes ?? []);
    const dodgeExposure = createDodgeAttackExposureTracker();
    dodgeExposure.begin(getWeaponDodgeAttackMultiplier(String(source.actionKey ?? "")));

    for (const [index, explosion] of explosions.entries()) {
      const center = getDelayedVolleyRegionShapeCenter(shapes[index], explosion.center);
      const geometry = {
        type: VOLLEY_ACTION_KEY,
        origin: center,
        end: center,
        angle: 0,
        distance: 1,
        halfAngle: 0,
        radiusPixels: Math.max(1, Number(explosion.radiusPixels) || 1),
        shapePoints: []
      };
      const targets = attackerToken
        ? getPotentialTargets(attackerToken, geometry, {
          includeAttacker: true,
          includeDead: true,
          purpose: "impact"
        })
        : (canvas.tokens?.placeables ?? []).filter(target => (
          isAttackImpactTarget(target) && isTokenInVolleyPlanarRadius(target, geometry)
        ));
      for (const target of targets) {
        if (!isDeadTarget(target)) {
          const targetActorUuid = String(target.actor?.uuid ?? "").trim();
          if (targetActorUuid) {
            impactedLivingActorUuids.add(targetActorUuid);
            if (target.actor?.statuses?.has?.("unconscious")) {
              preExistingUnconsciousTargetActorUuids.add(targetActorUuid);
            }
          }
          const targetTokenUuid = String(target.document?.uuid ?? "").trim();
          if (targetTokenUuid && !reactedTargetTokenUuids.has(targetTokenUuid)) {
            reactedTargetTokenUuids.add(targetTokenUuid);
            await requestDelayedVolleyTargetReaction({ source, target, explosion });
          }
          dodgeExposure.record(target.actor, {
            actorToken: contextualAttackerToken,
            attackerActor: contextualAttackerActor,
            targetActor: target.actor,
            targetToken: target,
            ...normalizeAttackDistanceContext(explosion),
            weaponData: source.weaponData ?? null,
            weaponActionKey: String(source.actionKey ?? ""),
            requester: "weaponAttack"
          });
        }
        targetActorUuids.add(target.actor?.uuid);
        targetTokenUuids.add(target.document?.uuid);
        const hasCriticalDamageSnapshot = Number.isFinite(Number(explosion.damageBaseAmount))
          && explosion.criticalDamageSnapshot
          && typeof explosion.criticalDamageSnapshot === "object";
        const targetCriticalDamageSnapshot = hasCriticalDamageSnapshot
          ? getDelayedVolleyTargetCriticalDamageSnapshot({
            explosion,
            source,
            attackerActor: contextualAttackerActor,
            attackerToken: contextualAttackerToken,
            targetToken: target
          })
          : null;
        damageRequests.push(...buildWeaponExplosionDamageRequests({
          targetToken: target,
          center,
          radiusPixels: geometry.radiusPixels,
          baseDamage: hasCriticalDamageSnapshot ? explosion.damageBaseAmount : explosion.damageAmount,
          pelletCount: explosion.pelletCount,
          concentratedPelletImpact: hasWeaponSpecialPropertyData(
            source.weaponData,
            WEAPON_SPECIAL_PROPERTIES.concentratedPelletImpact
          ),
          damageTypes: explosion.damageTypes,
          penetrationPower: getDelayedVolleyTargetPenetrationPower({
            explosion,
            source,
            attackerActor: contextualAttackerActor,
            attackerToken: contextualAttackerToken,
            targetToken: target
          }),
          damageModifier: (amount, { falloff = 1 } = {}) => {
            const adjustedAmount = applyDelayedVolleyContextualDamageToAmount(amount, {
              explosion,
              source,
              weapon: delayedWeapon,
              attackerActor: contextualAttackerActor,
              attackerToken: contextualAttackerToken,
              targetToken: target,
              damageScale: falloff
            });
            return hasCriticalDamageSnapshot
              ? applyCriticalDamageSnapshot(adjustedAmount, targetCriticalDamageSnapshot)
              : adjustedAmount;
          },
          source: {
            attackId: source.attackId,
            weaponUuid: source.weaponUuid,
            weaponFunctionId: source.weaponFunctionId,
            weaponData: source.weaponData,
            actionKey: source.actionKey,
            attackerUuid: source.attackerUuid,
            attackerTokenUuid: source.attackerTokenUuid,
            tokenId: source.attackerTokenId,
            criticalSuccess: targetCriticalDamageSnapshot?.criticalSuccess === true,
            ...normalizeAttackDistanceContext(explosion),
            worldTime
          }
        }));
      }

      if (explosion.residualRegion) {
        regionRequests.push({
          sceneId: scene.id,
          ...foundry.utils.deepClone(explosion.residualRegion),
          center,
          delaySeconds: 0
        });
      }

      await playWeaponExplosionAnimation({
        weaponData: source.weaponData,
        center,
        radiusPixels: geometry.radiusPixels
      });
    }

    await dodgeExposure.flush();
    const damageResults = flattenDamageResults(await applyQueuedDamageAndRegionRequests(damageRequests, regionRequests));
    const impactConditionWear = delayedWeapon
      ? await applyWeaponImpactConditionWear(delayedWeapon, String(source.weaponFunctionId ?? ""), damageResults, {
        chainRef: source.chainRef ?? null,
        multiplier: source.impactConditionWearMultiplier,
        weaponData: source.weaponData
      })
      : summarizeWeaponImpactDamageResults(damageResults);
    const impactModifierState = new WeaponActionModifierState({
      actor: contextualAttackerActor,
      actorToken: contextualAttackerToken,
      weapon: delayedWeapon,
      weaponData: source.weaponData ?? null,
      actionKey: String(source.actionKey ?? ""),
      weaponActionKey: String(source.actionKey ?? ""),
      weaponFunctionId: String(source.weaponFunctionId ?? ""),
      attackId: String(source.attackId ?? pending.id ?? "")
    });
    if (source.preventStealthDetection === true) {
      impactModifierState.setOption("preventStealthDetection", true);
    }
    const resolvedContext = {
      actor: contextualAttackerActor,
      actorToken: contextualAttackerToken,
      weaponData: source.weaponData ?? null,
      weaponActionKey: String(source.actionKey ?? ""),
      requester: "weaponAttack",
      attackerUuid: String(source.attackerUuid ?? ""),
      actorUuid: String(source.attackerUuid ?? ""),
      tokenUuid: String(source.attackerTokenUuid ?? ""),
      weaponUuid: String(source.weaponUuid ?? ""),
      weaponName: String(source.weaponName ?? ""),
      actionKey: String(source.actionKey ?? ""),
      weaponFunctionId: String(source.weaponFunctionId ?? ""),
      stealthAttack: source.stealthAttack === true,
      attackId: String(source.attackId ?? pending.id ?? ""),
      preExistingUnconsciousTargetActorUuids: Array.from(preExistingUnconsciousTargetActorUuids),
      actionPointSpendReceipt: source.actionPointSpendReceipt ?? null,
      actionPointCost: Math.max(0, toInteger(source.actionPointCost)),
      actionPointCostApplied: Boolean(source.actionPointCostApplied),
      targetActorUuids: Array.from(targetActorUuids).filter(Boolean),
      targetTokenUuids: Array.from(targetTokenUuids).filter(Boolean),
      attackCheckTargetActorUuids: Array.from(targetActorUuids).filter(Boolean),
      successfulAttackTargetActorUuids: Array.from(impactedLivingActorUuids),
      successfulAttackCheckCount: impactedLivingActorUuids.size > 0 ? 1 : 0,
      successfulAttack: impactedLivingActorUuids.size > 0,
      killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults),
      canceledByReaction: false,
      criticalDamageUsed: damageRequests.some(request => request?.source?.criticalSuccess === true),
      attackCheckCount: explosions.length,
      attackCheckAggregate: true,
      damageResults,
      impactConditionWear,
      modifierState: impactModifierState,
      deferredImpactResolution: true,
      keepAwayEntries: Array.isArray(source.keepAwayEntries) ? source.keepAwayEntries : [],
      chainRef: source.chainRef ?? null,
      damageHubOperationRef: String(source.damageHubOperationRef ?? ""),
      senderUserId: game.user?.id ?? ""
    };
    await publishWeaponAttackResolved(resolvedContext);
    if (
      source.resolveWeaponNoiseAtImpact === true
      && contextualAttackerToken
      && !impactModifierState.getOption("preventStealthDetection")
    ) {
      await resolveWeaponNoiseDetection(contextualAttackerToken, {
        noiseLevel: getWeaponNoiseLevel({ noiseLevel: source.weaponNoiseLevel })
      });
    }
    dispatchWeaponAttackTerminalHandlers(resolvedContext);

    await scene.deleteEmbeddedDocuments("Region", [region.id]);
    await deleteDelayedThrownItemDocuments(String(pending.id));
  } catch (error) {
    console.error(`${SYSTEM_ID} | Delayed volley explosion failed.`, error);
  } finally {
    processingDelayedVolleyRegions.delete(region.uuid);
  }
}

function getDelayedVolleyRegionShapeCenter(shape = null, fallback = null) {
  const origin = shape?.origin;
  return serializePoint({
    x: Number(origin?.x ?? shape?.x ?? fallback?.x) || 0,
    y: Number(origin?.y ?? shape?.y ?? fallback?.y) || 0,
    elevation: Number(fallback?.elevation) || 0
  });
}

function getRegionRestrictionLevelId(scene) {
  if (canvas.scene?.id === scene?.id && canvas.level?.id) return canvas.level.id;
  return scene?._view ?? scene?.initialLevel?.id ?? scene?.firstLevel?.id ?? "";
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

/**
 * Resolve the exact source, executor and explicit attack-target TokenDocuments
 * needed by a commanded ability attack. The generic GM selector is deliberately
 * not used here because native attack geometry requires a rendered scene/level.
 */
async function resolveCommandedAttackAuthorityTokenDocuments({
  entries = [],
  selections = [],
  authorityContext = null
} = {}) {
  const sourceTokenUuid = String(authorityContext?.sourceTokenUuid ?? "").trim();
  if (!sourceTokenUuid) return null;

  const entryDocuments = (Array.isArray(entries) ? entries : [])
    .map(entry => entry?.token?.document ?? entry?.token ?? null);
  if (entryDocuments.some(document => !document?.uuid)) return null;

  const selectionTokenUuids = [];
  for (const selection of Array.isArray(selections) ? selections : []) {
    const executorTokenUuid = String(selection?.tokenUuid ?? "").trim();
    if (!executorTokenUuid) return null;
    selectionTokenUuids.push(executorTokenUuid);
    const attackTargetTokenUuid = String(selection?.targetUuid ?? "").trim();
    if (attackTargetTokenUuid) selectionTokenUuids.push(attackTargetTokenUuid);
  }

  const resolvedDocuments = await Promise.all([
    fromUuid(sourceTokenUuid),
    ...selectionTokenUuids.map(uuid => fromUuid(uuid))
  ]);
  const tokenDocuments = [...resolvedDocuments, ...entryDocuments];
  if (tokenDocuments.some(document => !document?.uuid || !document?.actor || !document?.parent?.id)) return null;

  return Array.from(new Map(tokenDocuments.map(document => [String(document.uuid), document])).values());
}

async function getCommandedAttackSceneGM(options = {}) {
  const tokenDocuments = await resolveCommandedAttackAuthorityTokenDocuments(options);
  if (!tokenDocuments?.length) return null;
  const eligible = Array.from(game.users?.contents ?? game.users ?? [])
    .filter(user => isCommandedAttackSceneAuthority(user, tokenDocuments));
  const activeGM = game.users?.activeGM ?? null;
  if (activeGM && eligible.some(user => user.id === activeGM.id)) return activeGM;
  return eligible
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .at(0) ?? null;
}

function getCommandedAttackAuthorityFailureReason() {
  const hasActiveGM = Array.from(game.users?.contents ?? game.users ?? [])
    .some(user => user?.active && user.isGM);
  return hasActiveGM ? "gmSceneUnavailable" : "missingGM";
}

function isCommandedAttackSceneAuthority(user, tokenDocuments, { requirePlaceables = false } = {}) {
  return Boolean(user?.isGM && isAttackSceneUser(user, tokenDocuments, { requirePlaceables }));
}

function isAttackSceneUser(user, tokenDocuments, { requirePlaceables = false } = {}) {
  if (!user?.active || !Array.isArray(tokenDocuments) || !tokenDocuments.length) return false;
  const sceneId = String(tokenDocuments[0]?.parent?.id ?? "");
  if (!sceneId || String(user.viewedScene ?? "") !== sceneId) return false;
  for (const tokenDocument of tokenDocuments) {
    if (String(tokenDocument?.parent?.id ?? "") !== sceneId) return false;
    try {
      if (!tokenDocument.includedInLevel(user.viewedLevel ?? null)) return false;
    } catch (_error) {
      return false;
    }
    if (requirePlaceables) {
      const token = tokenDocument.object ?? null;
      if (!token?.actor || String(token.document?.uuid ?? "") !== String(tokenDocument.uuid ?? "")) return false;
    }
  }
  return true;
}

function isAttackSceneClient(tokenDocuments, { requirePlaceables = false } = {}) {
  if (!Array.isArray(tokenDocuments) || !tokenDocuments.length) return false;
  const sceneId = String(canvas?.scene?.id ?? "");
  const levelId = String(canvas?.level?.id ?? "");
  if (!sceneId) return false;
  for (const tokenDocument of tokenDocuments) {
    if (String(tokenDocument?.parent?.id ?? "") !== sceneId) return false;
    try {
      if (!tokenDocument.includedInLevel(levelId || null)) return false;
    } catch (_error) {
      return false;
    }
    if (requirePlaceables) {
      const token = tokenDocument.object ?? null;
      if (!token?.actor || String(token.document?.uuid ?? "") !== String(tokenDocument.uuid ?? "")) return false;
    }
  }
  return true;
}

function getTokenDocumentUuid(token = null) {
  return String(token?.document?.uuid ?? token?.uuid ?? "").trim();
}

function tokenLifecycleMatches(candidate = null, tokenOrDocument = null, { matchUuid = false } = {}) {
  if (!candidate || !tokenOrDocument) return false;
  if (candidate === tokenOrDocument) return true;
  const candidateDocument = candidate?.document ?? null;
  const removedDocument = tokenOrDocument?.document ?? null;
  if (candidateDocument && (candidateDocument === tokenOrDocument || candidateDocument === removedDocument)) return true;
  if (!matchUuid) return false;
  const candidateUuid = getTokenDocumentUuid(candidate);
  const removedUuid = getTokenDocumentUuid(tokenOrDocument);
  return Boolean(candidateUuid && removedUuid && candidateUuid === removedUuid);
}

function isTokenPlaceableAvailable(token = null) {
  if (!token || typeof token !== "object") return false;
  // Foundry can redraw a live Token on a CanvasDocument whose private _destroyed marker survived layer teardown.
  if (token.destroyed === true) return false;
  return token.transform !== null;
}

function normalizeTargetTokenUuidAllowlist(value = null) {
  if (value === null || value === undefined) return null;
  if (value instanceof Set) return value;
  const entries = Array.isArray(value) ? value : [];
  return new Set(entries.map(uuid => String(uuid ?? "").trim()).filter(Boolean));
}

function serializeGeometry(geometry) {
  if (!geometry) return null;
  return {
    type: String(geometry.type ?? ""),
    origin: serializePoint(geometry.origin),
    end: serializePoint(geometry.end),
    angle: Number(geometry.angle) || 0,
    distance: Number(geometry.distance) || 0,
    rangeBonusMeters: Number(geometry.rangeBonusMeters) || 0,
    halfAngle: Number(geometry.halfAngle) || 0,
    radiusPixels: Number(geometry.radiusPixels) || 0,
    aimPoint: geometry.aimPoint ? serializePoint(geometry.aimPoint) : null,
    shapePoints: Array.isArray(geometry.shapePoints) ? geometry.shapePoints.map(serializePoint) : [],
    ricochet: geometry.ricochet ? { ...geometry.ricochet } : null,
    ricochetTrajectory: geometry.ricochetTrajectory ? serializeTrajectory(geometry.ricochetTrajectory) : null,
    ricochetCone: serializeRicochetCone(geometry.ricochetCone)
  };
}

function deserializeGeometry(geometry) {
  if (!geometry?.origin || !geometry?.end) return null;
  return {
    type: String(geometry.type ?? ""),
    origin: deserializePoint(geometry.origin),
    end: deserializePoint(geometry.end),
    angle: Number(geometry.angle) || 0,
    distance: Number(geometry.distance) || 0,
    rangeBonusMeters: Number(geometry.rangeBonusMeters) || 0,
    halfAngle: Number(geometry.halfAngle) || 0,
    radiusPixels: Number(geometry.radiusPixels) || 0,
    aimPoint: geometry.aimPoint ? deserializePoint(geometry.aimPoint) : null,
    shapePoints: Array.isArray(geometry.shapePoints) ? geometry.shapePoints.map(deserializePoint) : [],
    ricochet: geometry.ricochet ? { ...geometry.ricochet } : null,
    ricochetTrajectory: geometry.ricochetTrajectory ? deserializeTrajectory(geometry.ricochetTrajectory) : null,
    ricochetCone: deserializeRicochetCone(geometry.ricochetCone)
  };
}

function serializeRicochetCone(cone = null) {
  if (!cone) return null;
  return {
    rays: Array.isArray(cone.rays) ? cone.rays.map(serializeTrajectory) : [],
    strips: Array.isArray(cone.strips)
      ? cone.strips.map(strip => strip.map(serializePoint))
      : []
  };
}

function deserializeRicochetCone(cone = null) {
  if (!cone) return null;
  return {
    rays: Array.isArray(cone.rays) ? cone.rays.map(deserializeTrajectory) : [],
    strips: Array.isArray(cone.strips)
      ? cone.strips.map(strip => strip.map(deserializePoint))
      : []
  };
}

function serializeTrajectory(trajectory = {}) {
  return {
    ...trajectory,
    origin: serializePoint(trajectory.origin),
    end: serializePoint(trajectory.end),
    segments: Array.isArray(trajectory.segments) ? trajectory.segments.map(segment => ({
      ...segment,
      origin: serializePoint(segment.origin),
      end: serializePoint(segment.end)
    })) : []
  };
}

function deserializeTrajectory(trajectory = {}) {
  return {
    ...trajectory,
    origin: deserializePoint(trajectory.origin),
    end: deserializePoint(trajectory.end),
    segments: Array.isArray(trajectory.segments) ? trajectory.segments.map(segment => ({
      ...segment,
      origin: deserializePoint(segment.origin),
      end: deserializePoint(segment.end)
    })) : []
  };
}

function serializePoint(point) {
  const data = {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0
  };
  if (Number.isFinite(Number(point?.elevation))) data.elevation = Number(point.elevation);
  return data;
}

function deserializePoint(point) {
  const data = {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0
  };
  if (Number.isFinite(Number(point?.elevation))) data.elevation = Number(point.elevation);
  return data;
}

function createBurstTargetPreviewState() {
  return {
    initialized: false,
    signature: "",
    targets: [],
    burstRanges: new Map(),
    geometry: null,
    pendingSignature: "",
    pendingTargets: [],
    pendingBurstRanges: new Map(),
    pendingGeometry: null,
    pendingSince: 0
  };
}

function getBurstTargetPreviewSignature(targets = [], burstRanges = new Map()) {
  return targets.map(target => {
    const range = burstRanges.get(target) ?? {};
    return [
      getTargetPreviewKey(target),
      toInteger(range.min),
      toInteger(range.max),
      String(range.label ?? "")
    ].join(":");
  }).join("|");
}

function getTargetPreviewKey(target) {
  return String(target?.document?.uuid ?? target?.document?.id ?? target?.id ?? target?.actor?.uuid ?? "");
}

function isMajorBurstPreviewGeometryShift(previous, current) {
  if (!previous || !current) return true;
  const angleDelta = Math.abs(normalizeAngle((Number(current.angle) || 0) - (Number(previous.angle) || 0)));
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const distanceDelta = Math.hypot(
    (Number(current.end?.x) || 0) - (Number(previous.end?.x) || 0),
    (Number(current.end?.y) || 0) - (Number(previous.end?.y) || 0)
  );
  const distanceThreshold = Math.max(
    BURST_PREVIEW_FORCE_DISTANCE_DELTA,
    (Number(current.distance) || gridSize) * BURST_PREVIEW_FORCE_ANGLE_DELTA
  );
  return angleDelta >= BURST_PREVIEW_FORCE_ANGLE_DELTA
    || distanceDelta >= distanceThreshold
    || !isSamePoint(current.origin, previous.origin)
    || Math.abs((Number(current.distance) || 0) - (Number(previous.distance) || 0)) > BURST_PREVIEW_FORCE_DISTANCE_DELTA;
}

function getTargetMarkerRenderState(targets = [], focusedTarget = null, burstRanges = new Map()) {
  return {
    markers: targets.map(target => getTargetMarkerPreviewData(target, burstRanges)).filter(Boolean),
    focusedMarker: focusedTarget ? getTargetCenterMarkerPosition(focusedTarget) : null
  };
}

function isSameTargetMarkerRenderState(current, previous) {
  if (!current || !previous) return false;
  return isSameMarkerList(current.markers, previous.markers)
    && isSameNullablePoint(current.focusedMarker, previous.focusedMarker);
}

function isSamePreviewState(current, previous) {
  if (!current || !previous) return false;
  if (Boolean(current.processing) !== Boolean(previous.processing)) return false;
  if (!isSameGeometry(current.geometry, previous.geometry)) return false;
  return isSameMarkerList(current.targetMarkers, previous.targetMarkers)
    && isSameNullablePoint(current.focusedTargetMarker, previous.focusedTargetMarker);
}

function isSameGeometry(current, previous) {
  if (!current || !previous) return false;
  return String(current.type ?? "") === String(previous.type ?? "")
    && isSamePoint(current.origin, previous.origin)
    && isSamePoint(current.end, previous.end)
    && Math.abs((Number(current.angle) || 0) - (Number(previous.angle) || 0)) <= PREVIEW_ANGLE_EPSILON
    && Math.abs((Number(current.distance) || 0) - (Number(previous.distance) || 0)) <= PREVIEW_POSITION_EPSILON
    && Math.abs((Number(current.halfAngle) || 0) - (Number(previous.halfAngle) || 0)) <= PREVIEW_ANGLE_EPSILON
    && Math.abs((Number(current.radiusPixels) || 0) - (Number(previous.radiusPixels) || 0)) <= PREVIEW_POSITION_EPSILON
    && isSameNullablePoint(current.aimPoint, previous.aimPoint)
    && isSamePointList(current.shapePoints, previous.shapePoints);
}

function isSameMarkerList(current = [], previous = []) {
  if (current.length !== previous.length) return false;
  return current.every((marker, index) => isSamePoint(marker, previous[index])
    && String(marker?.burstLabel ?? "") === String(previous[index]?.burstLabel ?? "")
    && isSameOptionalPoint(marker?.burstLabelPoint, previous[index]?.burstLabelPoint));
}

function isSamePointList(current = [], previous = []) {
  if (current.length !== previous.length) return false;
  return current.every((point, index) => isSamePoint(point, previous[index]));
}

function isSamePoint(current, previous) {
  if (!current || !previous) return false;
  return Math.abs((Number(current.x) || 0) - (Number(previous.x) || 0)) <= PREVIEW_POSITION_EPSILON
    && Math.abs((Number(current.y) || 0) - (Number(previous.y) || 0)) <= PREVIEW_POSITION_EPSILON
    && Math.abs((Number(current.elevation) || 0) - (Number(previous.elevation) || 0)) <= PREVIEW_POSITION_EPSILON;
}

function isSameNullablePoint(current, previous) {
  if (!current && !previous) return true;
  if (!current || !previous) return false;
  return isSamePoint(current, previous);
}

function isSameOptionalPoint(current, previous) {
  if (!current && !previous) return true;
  if (!current || !previous) return false;
  return isSamePoint(current, previous);
}

export function getActionAttackCount(weapon, actionKey, weaponFunctionId = "") {
  const abilitySettings = getAbilityAttackSettings(weapon, weaponFunctionId);
  if (actionKey === VOLLEY_ACTION_KEY && abilitySettings?.targeting?.mode === "area") {
    return Math.max(1, toInteger(abilitySettings.sequence?.count) || 1);
  }
  if (actionKey !== "burst") return 1;
  return Math.max(1, evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.burst?.count, {
    minimum: 1,
    context: "burst count"
  }) || 1);
}

function getWeaponBurstDifficultyPerShot(weapon, weaponFunctionId = "") {
  return evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.burst?.difficultyPerShot, {
    fallback: 10,
    minimum: 0,
    context: "burst difficulty"
  });
}

function getEffectiveWeaponBurstDifficultyPerShot(weapon, weaponFunctionId = "", actor = null, context = {}) {
  const base = getWeaponBurstDifficultyPerShot(weapon, weaponFunctionId);
  const stabilityPercent = toInteger(getContextualAbilityChangeValue(actor, "system.combat.burstStability", {
    ...context,
    baseValue: toInteger(actor?.system?.combat?.burstStability),
    weaponActionKey: String(context?.weaponActionKey ?? "burst"),
    weaponData: context?.weaponData ?? getWeaponAttackData(weapon, weaponFunctionId)
  }));
  return Math.max(0, Math.round(base * Math.max(0, 1 - (stabilityPercent / 100))));
}

function getBurstShotDifficultyBonus(weapon, actionKey, attackIndex = 0, weaponFunctionId = "", actor = null, context = {}) {
  const abilitySettings = getAbilityAttackSettings(weapon, weaponFunctionId);
  const isSequencedAbilityArea = actionKey === VOLLEY_ACTION_KEY
    && abilitySettings?.targeting?.mode === "area";
  if (actionKey !== "burst" && !isSequencedAbilityArea) return 0;
  return Math.max(0, toInteger(attackIndex)) * getEffectiveWeaponBurstDifficultyPerShot(weapon, weaponFunctionId, actor, context);
}

function getWeaponPelletCount(weapon, weaponFunctionId = "") {
  return Math.max(1, evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.pellets, {
    fallback: 1,
    minimum: 1,
    context: "pellets"
  }) || 1);
}

function hasConcentratedPelletImpact(weapon, weaponFunctionId = "") {
  return hasWeaponSpecialProperty(
    weapon,
    WEAPON_SPECIAL_PROPERTIES.concentratedPelletImpact,
    weaponFunctionId
  );
}

function getWeaponProjectileCountPerAttack(weapon, weaponFunctionId = "") {
  return getPelletProjectileCount(getWeaponPelletCount(weapon, weaponFunctionId), {
    concentrated: hasConcentratedPelletImpact(weapon, weaponFunctionId)
  });
}

function createWeaponPelletImpactProjectiles(weapon, weaponFunctionId = "", damageAmount = 0) {
  return createPelletImpactProjectiles({
    damageAmount,
    pelletCount: getWeaponPelletCount(weapon, weaponFunctionId),
    concentrated: hasConcentratedPelletImpact(weapon, weaponFunctionId)
  });
}

function getBurstProjectileCount(attackCount = 1, pelletCount = 1) {
  return Math.max(1, toInteger(attackCount) || 1) * Math.max(1, toInteger(pelletCount) || 1);
}

export function hasRequiredWeaponResources(
  weapon,
  multiplier = 1,
  weaponFunctionId = "",
  {
    modifierState = null,
    additionalActorResourceCosts = [],
    skipBaseCosts = false
  } = {}
) {
  const missing = getMissingWeaponResourceCost(weapon, multiplier, weaponFunctionId, {
    modifierState,
    additionalActorResourceCosts,
    skipBaseCosts
  });
  if (!missing) return true;
  ui.notifications.warn(`${weapon?.name ?? ""}: не хватает ${missing.label} (${missing.current} / ${missing.required}).`);
  return false;
}

export function getMissingWeaponResourceCost(
  weapon,
  multiplier = 1,
  weaponFunctionId = "",
  {
    modifierState = null,
    additionalActorResourceCosts = [],
    skipBaseCosts = false
  } = {}
) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const costs = skipBaseCosts ? [] : getWeaponResourceCosts(weaponData, { modifierState });
  const defersConditionCost = hasWeaponSpecialPropertyData(
    weaponData,
    WEAPON_SPECIAL_PROPERTIES.impactConditionWear
  );
  const actor = getWeaponOwnerActor(weapon);
  const actorResourceTotals = getWeaponActorResourceCostTotals(weapon, { costs });
  const modifierEnergyCost = Math.max(
    0,
    toInteger(modifierState?.getEnergyCost?.({ attackCount: Math.max(1, toInteger(multiplier)) }))
  );
  if (modifierEnergyCost > 0) {
    actorResourceTotals.set(
      ENERGY_RESOURCE_KEY,
      (actorResourceTotals.get(ENERGY_RESOURCE_KEY) ?? 0) + modifierEnergyCost
    );
  }
  for (const cost of normalizeAdditionalActorResourceCosts(additionalActorResourceCosts)) {
    if (!isCombatResourceCostActive(actor, cost.resourceKey)) continue;
    actorResourceTotals.set(
      cost.resourceKey,
      (actorResourceTotals.get(cost.resourceKey) ?? 0) + cost.amount
    );
  }
  for (const [resourceKey, required] of actorResourceTotals) {
    if (required <= 0) continue;
    const current = getActorAttackResourceAvailable(actor, resourceKey);
    if (current < required) {
      return {
        type: "actorResource",
        resourceKey,
        label: getActorAttackResourceLabel(resourceKey),
        current,
        required
      };
    }
  }
  for (const cost of costs) {
    if (cost.type === "actorResource") continue;
    const amount = Math.max(0, toInteger(cost.amount) * Math.max(1, toInteger(multiplier)));
    if (!amount) continue;
    if (cost.type === "magazine") {
      const current = toInteger(weaponData?.magazine?.value);
      if (current < amount) return {
        type: "magazine",
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponMagazine"),
        current,
        required: amount
      };
    }
    if (cost.type === "condition") {
      if (defersConditionCost) continue;
      const current = toInteger(weapon.system?.functions?.condition?.value);
      if (current < amount) return {
        type: "condition",
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionCondition"),
        current,
        required: amount
      };
    }
    if (cost.type === "energyConsumer") {
      const state = getWeaponEnergyResourceState(weapon, weaponFunctionId);
      if (state.current < amount) return {
        type: "energyConsumer",
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostEnergy"),
        current: state.current,
        required: amount
      };
    }
    if (cost.type === "quantity") {
      const current = toInteger(weapon.system?.quantity);
      if (current < amount) return {
        type: "quantity",
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostQuantity"),
        current,
        required: amount
      };
    }
  }
  return null;
}

function evaluateWeaponActorResourceCostAmount(weapon = null, cost = {}) {
  return Math.max(0, Math.trunc(evaluateWeaponFormula(weapon, cost?.formula ?? cost?.amount, {
    fallback: 0,
    minimum: 0,
    context: `${weapon?.name ?? "weapon"} actor resource cost`
  }) || 0));
}

function getWeaponActorResourceCostTotals(
  weapon = null,
  {
    costs = null,
    modifierState = null,
    weaponFunctionId = ""
  } = {}
) {
  const actor = getWeaponOwnerActor(weapon);
  const preparedCosts = Array.isArray(costs)
    ? costs
    : getWeaponResourceCosts(getWeaponAttackData(weapon, weaponFunctionId), { modifierState });
  const totals = new Map();
  for (const cost of preparedCosts) {
    if (String(cost?.type ?? "") !== "actorResource") continue;
    const resourceKey = String(cost?.resourceKey ?? "").trim();
    if (!resourceKey || !isCombatResourceCostActive(actor, resourceKey)) continue;
    const amount = evaluateWeaponActorResourceCostAmount(weapon, cost);
    totals.set(resourceKey, (totals.get(resourceKey) ?? 0) + amount);
  }
  return totals;
}

function getWeaponActorResourceCostTotal(
  weapon = null,
  resourceKey = "",
  {
    modifierState = null,
    weaponFunctionId = ""
  } = {}
) {
  return getWeaponActorResourceCostTotals(weapon, {
    modifierState,
    weaponFunctionId
  }).get(String(resourceKey ?? "").trim()) ?? 0;
}

function getPaidActorResourceAmount(source = null, resourceKey = "") {
  const costs = Array.isArray(source)
    ? source
    : source?.actorCosts
      ?? source?.execution?.spendReceipt?.costs
      ?? source?.spendReceipt?.costs
      ?? [];
  const key = String(resourceKey ?? "").trim();
  return costs.reduce((total, cost) => (
    String(cost?.resourceKey ?? "").trim() === key
      ? total + Math.max(0, toInteger(cost?.amount))
      : total
  ), 0);
}

function getActorAttackResourceAvailable(actor = null, resourceKey = "") {
  const key = String(resourceKey ?? "").trim();
  if (!actor || !key || !isCombatResourceCostActive(actor, key)) return 0;
  if (key === "actionPoints") {
    const strict = getStrictActionPointState(actor);
    return Math.max(0, toInteger(strict?.value));
  }
  if (key === ENERGY_RESOURCE_KEY) {
    return Math.max(
      0,
      toInteger(getActorAvailableEnergy(actor))
        - Math.max(0, toInteger(actor.system?.resources?.[ENERGY_RESOURCE_KEY]?.min))
    );
  }
  const resource = actor.system?.resources?.[key];
  if (!resource) return 0;
  return Math.max(
    0,
    toInteger(resource.value)
      - toInteger(resource.min)
      - getActorResourceLimitAmount(actor, key)
  );
}

function getActorAttackResourceLabel(resourceKey = "") {
  const key = String(resourceKey ?? "").trim();
  if (key === "reactionPoints") {
    return game.i18n.localize("FALLOUTMAW.EventReaction.Resource.ReactionPoints");
  }
  return getResourceSettings().find(entry => String(entry?.key ?? "") === key)?.label ?? key;
}

export function isCombatActionPointSpendingActive(actor = null) {
  return isActorInActiveCombat(actor);
}

export function getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId = "", context = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const baseCost = evaluateActorFormula(weaponData?.[actionKey]?.actionPointCost, actor, {
    fallback: DEFAULT_WEAPON_ACTION_POINT_COST,
    minimum: 0,
    context: "weapon action point cost"
  });
  const preparedCost = applyDamageCostModifier(baseCost, getDamageCostModifierState(actor, { actionKey }).action);
  const actionContext = {
    ...context,
    weaponActionKey: String(actionKey ?? "").trim(),
    weaponData,
    activeUseStages: { action: true, check: false, damage: false }
  };
  const postureAction = String(getActorPostureAction(actor) ?? "").trim();
  const preparedPostureBonus = getActorPostureWeaponActionPointCostBonus(actor);
  const contextual = getContextualAbilityChangeValues(actor, [{
    id: "actionCost",
    key: `system.costs.actions.${String(actionKey ?? "").trim()}`,
    alternateKeys: ["system.costs.action"],
    baseValue: preparedCost
  }, ...(postureAction ? [{
    id: "postureCost",
    key: `system.postures.${postureAction}.weaponActionCost`,
    baseValue: preparedPostureBonus
  }] : [])], actionContext);
  const modifiedCost = contextual.actionCost ?? preparedCost;
  const postureBonus = contextual.postureCost ?? preparedPostureBonus;
  const atRandomReduction = getActorAtRandomActionPointCostReduction(actor, actionKey);
  return Math.max(0, Math.ceil(modifiedCost + postureBonus - atRandomReduction));
}

function hasRequiredWeaponActionPoints(actor, weapon, actionKey, weaponFunctionId = "", context = {}) {
  if (!isCombatActionPointSpendingActive(actor)) return true;
  const actionCost = getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId, context);
  const strictActorCost = getWeaponActorResourceCostTotal(weapon, "actionPoints", {
    modifierState: context?.weaponActionModifierState ?? null,
    weaponFunctionId
  });
  return canSpendCombinedWeaponActionPointCosts(actor, actionCost, strictActorCost, {
    notify: true,
    label: "действия"
  });
}

function canSpendRequiredWeaponActionPoints(actor, weapon, actionKey, weaponFunctionId = "", context = {}) {
  if (!isCombatActionPointSpendingActive(actor)) return true;
  const actionCost = getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId, context);
  const strictActorCost = getWeaponActorResourceCostTotal(weapon, "actionPoints", {
    modifierState: context?.weaponActionModifierState ?? null,
    weaponFunctionId
  });
  return canSpendCombinedWeaponActionPointCosts(actor, actionCost, strictActorCost);
}

function canSpendCombinedWeaponActionPointCosts(
  actor = null,
  actionCost = 0,
  strictActorCost = 0,
  { notify = false, label = "" } = {}
) {
  if (!isCombatActionPointSpendingActive(actor)) return true;
  const dynamicCost = Math.max(0, toInteger(actionCost));
  const strictCost = Math.max(0, toInteger(strictActorCost));
  const strictState = getStrictActionPointState(actor);
  if (strictCost > Math.max(0, toInteger(strictState?.value))) {
    if (notify) canSpendStrictActionPoints(actor, strictCost, { label });
    return false;
  }

  const dynamicState = getCombatActionPointState(actor);
  if (!dynamicState) return dynamicCost <= 0;
  const dynamicAvailable = dynamicState.ownTurn
    ? Math.max(0, dynamicState.value - strictCost)
    : dynamicState.value;
  if (dynamicCost <= dynamicAvailable) return true;
  if (notify) canSpendCombatActionPoints(actor, dynamicCost + (dynamicState.ownTurn ? strictCost : 0), { label });
  return false;
}

async function spendWeaponActionPoints(actor, weapon, actionKey, weaponFunctionId = "", {
  emitActionResolved = true,
  spendActionPoints = true,
  actionPointCostApplied = null,
  attackId = "",
  actorToken = null,
  context = null,
  chainRef = null,
  damageHubOperationRef = "",
  resolvedCost = null
} = {}) {
  const committed = await commitWeaponActionPointSpend(actor, weapon, actionKey, weaponFunctionId, {
    emitActionResolved,
    spendActionPoints,
    actionPointCostApplied,
    attackId,
    actorToken,
    context,
    chainRef,
    damageHubOperationRef,
    resolvedCost
  });
  return finalizeCommittedWeaponActionPointSpend(actor, weapon, actionKey, weaponFunctionId, committed);
}

async function commitWeaponActionPointSpend(actor, weapon, actionKey, weaponFunctionId = "", {
  emitActionResolved = true,
  spendActionPoints = true,
  actionPointCostApplied = null,
  attackId = "",
  actorToken = null,
  context = null,
  chainRef = null,
  damageHubOperationRef = "",
  resolvedCost = null
} = {}) {
  const actionPointCostWasApplied = actionPointCostApplied === null || actionPointCostApplied === undefined
    ? spendActionPoints && isCombatActionPointSpendingActive(actor)
    : Boolean(actionPointCostApplied);
  const resolvedAttackId = String(attackId ?? "").trim() || foundry.utils.randomID();
  const resolvedContext = {
    ...(context && typeof context === "object" ? context : {}),
    actor,
    actorToken,
    token: actorToken,
    weapon,
    actionKey,
    weaponActionKey: actionKey,
    weaponFunctionId,
    weaponData: getWeaponAttackData(weapon, weaponFunctionId),
    attackId: resolvedAttackId,
    chanceOperationId: resolvedAttackId,
    actionPointCostApplied: actionPointCostWasApplied,
    chainRef,
    damageHubOperationRef
  };
  if (emitActionResolved) {
    Hooks.callAll("fallout-maw.weaponActionWillResolve", resolvedContext);
  }
  const hasResolvedCost = resolvedCost !== null && resolvedCost !== undefined && resolvedCost !== "";
  const configuredCost = hasResolvedCost ? Number(resolvedCost) : Number.NaN;
  const cost = spendActionPoints && isCombatActionPointSpendingActive(actor)
    ? Number.isFinite(configuredCost)
      ? Math.max(0, configuredCost)
      : getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId, resolvedContext)
    : 0;
  let transaction = { spent: 0, receipt: null, events: [] };
  if (spendActionPoints && isCombatActionPointSpendingActive(actor)) {
    if (cost > 0) {
      transaction = await spendCombatActionPointsWithReceipt(actor, cost, {
        source: "weaponAction",
        actionKey,
        chainRef,
        damageHubOperationRef,
        suppressResourceNotification: true
      });
      if (transaction.spent !== cost || !transaction.receipt) {
        const error = new Error("Weapon action-point spend was cancelled or became unaffordable.");
        error.reason = "spendFailed";
        throw error;
      }
    }
  }
  return {
    cost,
    receipt: transaction.receipt,
    resolvedContext,
    emitActionResolved
  };
}

async function rollbackCommittedWeaponActionPointSpend(actor, committed = null) {
  const receipt = committed?.receipt;
  if (!receipt) return 0;
  const restored = await refundCombatActionPointReceipt(actor, receipt, {
    chainRef: committed?.resolvedContext?.chainRef
  });
  if (restored < Math.max(0, toInteger(receipt.amount))) {
    throw new Error(`Only ${restored} of ${receipt.amount} weapon action points were rolled back.`);
  }
  return restored;
}

async function finalizeCommittedWeaponActionPointSpend(
  actor,
  weapon,
  actionKey,
  weaponFunctionId = "",
  committed = null
) {
  const cost = Math.max(0, Number(committed?.cost) || 0);
  const resolvedContext = committed?.resolvedContext ?? {};
  if (committed?.receipt) {
    await notifyCombatActionPointReceipt(actor, committed.receipt, {
      source: "weaponAction",
      actionKey,
      chainRef: resolvedContext.chainRef,
      damageHubOperationRef: resolvedContext.damageHubOperationRef
    });
  }
  if (committed?.emitActionResolved && actionKey === "reload") {
    await publishWeaponAttackResolved({
      ...resolvedContext,
      attackerUuid: actor?.uuid ?? "",
      actorUuid: actor?.uuid ?? "",
      tokenUuid: resolvedContext.actorToken?.document?.uuid ?? resolvedContext.actorToken?.uuid ?? "",
      weaponUuid: weapon?.uuid ?? "",
      actionPointCost: cost,
      targetActorUuids: [],
      targetTokenUuids: [],
      killedTargetUuids: [],
      canceledByReaction: false,
      attackCheckCount: 0,
      damageResults: [],
      senderUserId: game.user?.id ?? ""
    });
  } else if (committed?.emitActionResolved) {
    Hooks.callAll("fallout-maw.weaponActionResolved", resolvedContext);
  }
  return cost;
}

async function spendWeaponResources(
  weapon,
  multiplier = 1,
  weaponFunctionId = "",
  extraCosts = [],
  {
    modifierState = null,
    chainRef = null,
    skipBaseCosts = false,
    beforeItemCommit = null,
    rollbackBeforeItemCommit = null
  } = {}
) {
  const actor = getWeaponOwnerActor(weapon);
  if (!actor || !weapon?.id) {
    throw new TypeError("Weapon resource spending requires an Actor-owned Item.");
  }

  return weaponResourceActorLock.run(actor, null, async () => {
    const currentWeapon = actor.items?.get?.(weapon.id);
    if (!currentWeapon) return false;

    const weaponData = getWeaponAttackData(currentWeapon, weaponFunctionId);
    const {
      itemTotals,
      actorCostRows
    } = collectWeaponResourceSpendTotals(weaponData, multiplier, extraCosts, {
      modifierState,
      skipBaseCosts
    });
    const missing = getMissingCollectedWeaponItemResourceCost(
      currentWeapon,
      weaponData,
      itemTotals,
      weaponFunctionId
    );
    if (missing) {
      ui.notifications.warn(`${currentWeapon.name ?? ""}: не хватает ${missing.label} (${missing.current} / ${missing.required}).`);
      return false;
    }

    const updates = [];
    const deletes = [];
    let workingWeapon = currentWeapon;

    const energyAmount = itemTotals.get("energyConsumer") ?? 0;
    if (energyAmount > 0) {
      const state = getWeaponEnergyResourceState(currentWeapon, weaponFunctionId);
      if (state.item) {
        const energyUpdate = createActorItemOrInstalledModuleUpdate(actor, state.item, {
          "system.functions.energyConsumer.installedSource.reserve.value": Math.max(0, state.current - energyAmount)
        });
        if (!energyUpdate) {
          throw new Error("Unable to persist the weapon energy consumer resource update.");
        }
        updates.push(energyUpdate);
        if (String(energyUpdate._id ?? "") === String(currentWeapon.id)) {
          workingWeapon = createWeaponResourceSnapshot(currentWeapon, energyUpdate);
        }
      }
    }

    const magazineAmount = itemTotals.get("magazine") ?? 0;
    if (magazineAmount > 0) {
      const currentMagazine = Math.max(0, toInteger(getWeaponAttackData(workingWeapon, weaponFunctionId)?.magazine?.value));
      const magazineUpdate = createWeaponFunctionUpdateData(workingWeapon, weaponFunctionId, {
        "magazine.value": Math.max(0, currentMagazine - magazineAmount)
      });
      if (Object.keys(magazineUpdate).length) {
        updates.push({ _id: currentWeapon.id, ...magazineUpdate });
        workingWeapon = createWeaponResourceSnapshot(workingWeapon, {
          _id: currentWeapon.id,
          ...magazineUpdate
        });
      }
    }

    const conditionAmount = itemTotals.get("condition") ?? 0;
    if (conditionAmount > 0) {
      updates.push({
        _id: currentWeapon.id,
        "system.functions.condition.value": Math.max(
          0,
          toInteger(currentWeapon.system?.functions?.condition?.value) - conditionAmount
        )
      });
    }

    const quantityAmount = itemTotals.get("quantity") ?? 0;
    if (quantityAmount > 0) {
      const consumption = planInventoryItemConsumption({
        item: currentWeapon,
        amount: quantityAmount
      });
      updates.push(...consumption.updates);
      deletes.push(...consumption.deletes);
      if (!consumption.deletes.length && currentWeapon.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_FLAG)?.id) {
        updates.push({
          _id: currentWeapon.id,
          [`flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_FLAG}`]: globalThis._del
        });
      }
    }

    const commitItemCosts = async () => {
      if (!updates.length && !deletes.length) return true;
      const mutation = await executeInventoryMutation({
        actor,
        updates,
        deletes
      }, {
        reason: "weapon-resource-spend",
        documentOptions: chainRef
          ? {
            chainRef,
            falloutMawSystemEventChainRef: chainRef
          }
          : {}
      });
      const touchedWeapon = mutation.plans?.some(plan => (
        plan.actor === actor
        && plan.touchedExistingIds?.has?.(String(currentWeapon.id))
      ));
      if (!touchedWeapon) {
        throw new Error("Weapon resource state changed before the inventory transaction could commit.");
      }
      return true;
    };

    const commitRemainingCosts = async () => {
      let beforeItemReceipt = null;
      try {
        if (typeof beforeItemCommit === "function") {
          beforeItemReceipt = await beforeItemCommit();
          if (beforeItemReceipt === false) {
            throw new Error("The action-point transaction was not committed.");
          }
        }
        return await commitItemCosts();
      } catch (error) {
        if (beforeItemReceipt && typeof rollbackBeforeItemCommit === "function") {
          try {
            await rollbackBeforeItemCommit(beforeItemReceipt);
          } catch (rollbackError) {
            error.rollbackError ??= rollbackError;
          }
        }
        throw error;
      }
    };

    if (!actorCostRows.length) {
      const committed = await commitRemainingCosts();
      return committed ? { actorCosts: [] } : false;
    }

    const identity = [
      "weapon-resource",
      currentWeapon.uuid ?? currentWeapon.id,
      weaponFunctionId,
      chainRef ?? foundry.utils.randomID()
    ].filter(Boolean).join(":");
    const costContext = {
      identity,
      rootId: identity,
      occurrenceId: identity,
      sourceItemUuid: String(currentWeapon.uuid ?? ""),
      functionId: String(weaponFunctionId ?? ""),
      chainRef
    };
    const quote = await quoteActorResourceCosts({
      actor,
      costRows: actorCostRows,
      context: costContext
    });
    if (!quote?.ok) {
      notifyAbilityTriggerCostFailure(quote);
      return false;
    }
    const payment = await payActorResourceCosts({
      actor,
      costRows: actorCostRows,
      expectedFingerprint: quote.fingerprint,
      context: {
        ...costContext,
        afterVectorSpend: commitRemainingCosts
      }
    });
    if (!payment?.ok) {
      notifyAbilityTriggerCostFailure(payment);
      return false;
    }
    return {
      actorCosts: payment.execution?.spendReceipt?.costs ?? []
    };
  });
}

function collectWeaponResourceSpendTotals(
  weaponData = {},
  multiplier = 1,
  extraCosts = [],
  {
    modifierState = null,
    skipBaseCosts = false
  } = {}
) {
  const itemTotals = new Map();
  const actorCostRows = [];
  const baseMultiplier = Math.max(1, toInteger(multiplier));
  const baseCosts = skipBaseCosts ? [] : getWeaponResourceCosts(weaponData, { modifierState });
  const defersConditionCost = hasWeaponSpecialPropertyData(
    weaponData,
    WEAPON_SPECIAL_PROPERTIES.impactConditionWear
  );
  for (const [index, cost] of baseCosts.entries()) {
    const type = String(cost?.type ?? "").trim();
    if (!type) continue;
    if (type === "condition" && defersConditionCost) continue;
    if (type === "actorResource") {
      actorCostRows.push({
        id: String(cost?.id ?? "").trim() || `weapon-actor-cost-${index + 1}`,
        resourceKey: String(cost?.resourceKey ?? "").trim(),
        formula: String(cost?.formula ?? cost?.amount ?? "0").trim() || "0"
      });
      continue;
    }
    const amount = Math.max(0, toInteger(cost?.amount) * baseMultiplier);
    if (amount > 0) itemTotals.set(type, (itemTotals.get(type) ?? 0) + amount);
  }
  const modifierEnergyCost = Math.max(
    0,
    toInteger(modifierState?.getEnergyCost?.({ attackCount: baseMultiplier }))
  );
  if (modifierEnergyCost > 0) {
    actorCostRows.push({
      id: "weapon-modifier-energy",
      resourceKey: ENERGY_RESOURCE_KEY,
      formula: String(modifierEnergyCost)
    });
  }
  for (const [index, cost] of (extraCosts ?? []).entries()) {
    const type = String(cost?.type ?? "").trim();
    const amount = Math.max(0, toInteger(cost?.amount));
    if (!type || amount <= 0) continue;
    if (type === "actorResource") {
      actorCostRows.push({
        id: `weapon-extra-actor-cost-${index + 1}`,
        resourceKey: String(cost?.resourceKey ?? "").trim(),
        formula: String(amount)
      });
      continue;
    }
    itemTotals.set(type, (itemTotals.get(type) ?? 0) + amount);
  }
  return { itemTotals, actorCostRows };
}

function summarizeWeaponImpactDamageResults(damageResults = []) {
  let hit = false;
  let totalBlockedDamage = 0;
  for (const result of damageResults.flat(Infinity).filter(Boolean)) {
    if ((result.mode && result.mode !== "damage") || result.cancelled || result.failed) continue;
    if (result.phantomDestroyed === true) continue;
    const blocked = Math.max(0, Number(result.mitigationBlocked) || 0);
    const hasImpact = blocked > 0 || [
      result.amount,
      result.potentialAmount,
      result.delayedAmount,
      result.preBarrierAmount,
      result.amountAfterBarrier,
      result.barrierAbsorbed,
      result.healthDelta,
      result.limbDelta,
      result.itemConditionDelta
    ].some(value => Number(value) > 0);
    if (!hasImpact) continue;
    hit = true;
    totalBlockedDamage += blocked;
  }
  return {
    hit,
    blockedDamage: Math.floor(totalBlockedDamage),
    multiplier: 0,
    conditionLoss: 0
  };
}

async function applyWeaponImpactConditionWear(
  weapon,
  weaponFunctionId = "",
  damageResults = [],
  { modifierState = null, chainRef = null, multiplier, weaponData: suppliedWeaponData = null } = {}
) {
  const summary = summarizeWeaponImpactDamageResults(damageResults);
  if (!summary.hit) return summary;
  const actor = getWeaponOwnerActor(weapon);
  if (!actor || !weapon?.id) return summary;

  return weaponResourceActorLock.run(actor, null, async () => {
    const currentWeapon = actor.items?.get?.(weapon.id);
    if (!currentWeapon || !hasItemFunction(currentWeapon, ITEM_FUNCTIONS.condition, { ignoreBroken: true })) return summary;
    const weaponData = suppliedWeaponData && typeof suppliedWeaponData === "object"
      ? suppliedWeaponData
      : getWeaponAttackData(currentWeapon, weaponFunctionId);
    if (!hasWeaponSpecialPropertyData(weaponData, WEAPON_SPECIAL_PROPERTIES.impactConditionWear)) return summary;
    const conditionMultiplier = Number.isFinite(Number(multiplier))
      ? Math.max(0, toInteger(multiplier))
      : getWeaponImpactConditionWearMultiplier(weaponData, modifierState);
    if (!conditionMultiplier) return summary;

    const current = Math.max(0, toInteger(currentWeapon.system?.functions?.condition?.value));
    const conditionLoss = calculateWeaponImpactConditionLoss(
      current,
      summary.blockedDamage,
      conditionMultiplier
    );
    if (conditionLoss > 0) {
      await currentWeapon.update({
        "system.functions.condition.value": current - conditionLoss
      }, chainRef ? {
        chainRef,
        falloutMawSystemEventChainRef: chainRef
      } : {});
    }
    return { ...summary, multiplier: conditionMultiplier, conditionLoss };
  });
}

function getWeaponImpactConditionWearMultiplier(weaponData = {}, modifierState = null) {
  if (!hasWeaponSpecialPropertyData(weaponData, WEAPON_SPECIAL_PROPERTIES.impactConditionWear)) return 0;
  return getWeaponResourceCosts(weaponData, { modifierState })
    .filter(cost => String(cost?.type ?? "").trim() === "condition")
    .reduce((total, cost) => total + Math.max(0, toInteger(cost?.amount)), 0);
}

function calculateWeaponImpactConditionLoss(current, blockedDamage, multiplier) {
  const available = Math.max(0, toInteger(current));
  const costMultiplier = Math.max(0, toInteger(multiplier));
  const blocked = Math.max(0, Math.floor(Number(blockedDamage) || 0));
  return Math.min(available, (2 + blocked) * costMultiplier);
}

function getMissingCollectedWeaponItemResourceCost(
  weapon,
  weaponData = {},
  itemTotals = new Map(),
  weaponFunctionId = ""
) {
  for (const [type, required] of itemTotals) {
    if (required <= 0) continue;
    if (type === "magazine") {
      const current = toInteger(weaponData?.magazine?.value);
      if (current < required) return {
        type,
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponMagazine"),
        current,
        required
      };
    }
    if (type === "condition") {
      const current = toInteger(weapon.system?.functions?.condition?.value);
      if (current < required) return {
        type,
        label: game.i18n.localize("FALLOUTMAW.Item.FunctionCondition"),
        current,
        required
      };
    }
    if (type === "energyConsumer") {
      const state = getWeaponEnergyResourceState(weapon, weaponFunctionId);
      if (state.current < required) return {
        type,
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostEnergy"),
        current: state.current,
        required
      };
    }
    if (type === "quantity") {
      const current = toInteger(weapon.system?.quantity);
      if (current < required) return {
        type,
        label: game.i18n.localize("FALLOUTMAW.Item.WeaponCostQuantity"),
        current,
        required
      };
    }
  }
  return null;
}

function createWeaponResourceSnapshot(weapon = null, update = {}) {
  const snapshot = foundry.utils.deepClone(weapon?.toObject?.() ?? weapon ?? {});
  const expanded = foundry.utils.expandObject(
    Object.fromEntries(Object.entries(update ?? {}).filter(([path]) => path !== "_id"))
  );
  foundry.utils.mergeObject(snapshot, expanded, { inplace: true });
  return snapshot;
}

export function canPerformWeaponActionAgainstToken({
  attackerToken = null,
  targetToken = null,
  weapon = null,
  actionKey = "",
  weaponFunctionId = ""
} = {}) {
  const attacker = attackerToken?.object ?? attackerToken;
  const target = targetToken?.object ?? targetToken;
  if (!attacker?.actor || !target?.actor || !weapon || isActorUnableToAct(attacker.actor)) return false;
  if (!isAttackSource(weapon, weaponFunctionId) || !hasWeaponAction(weapon, actionKey, weaponFunctionId)) return false;
  if (isWeaponActionBlocked(attacker.actor, actionKey) || isWeaponPlacementDisabled(attacker.actor, weapon)) return false;
  if (getMissingWeaponResourceCost(weapon, getActionAttackCount(weapon, actionKey, weaponFunctionId), weaponFunctionId)) return false;
  const origin = getTokenAimPoint(attacker);
  const targetPoint = getTokenAimPoint(target);
  const geometry = getAttackGeometry(weapon, actionKey, attacker, origin, targetPoint, weaponFunctionId);
  if (!geometry || !getPotentialTargets(attacker, geometry).includes(target)) return false;
  return canTokenPhysicallySeeTarget(attacker, target);
}

function getWeaponEnergyResourceState(weapon = null, weaponFunctionId = "") {
  const item = getWeaponEnergyConsumerItem(weapon, weaponFunctionId);
  const consumer = getEnergyConsumerFunction(item);
  const source = getActiveEnergySourceItem(getWeaponOwnerActor(weapon), consumer);
  if (!item || !source || !hasItemFunction(source, ITEM_FUNCTIONS.energySource, { ignoreBroken: true })) {
    return { item, current: 0, max: 0 };
  }
  if (!energySourceMatchesConsumer(source, consumer)) return { item, current: 0, max: 0 };
  const reserve = getEnergySourceReserveState(source);
  return {
    item,
    current: Math.max(0, Number(reserve.value) || 0),
    max: Math.max(0, Number(reserve.max) || 0)
  };
}

function getWeaponEnergyConsumerItem(weapon = null, weaponFunctionId = "") {
  const moduleFunction = parseModuleWeaponFunctionId(weaponFunctionId);
  if (!moduleFunction) return weapon;
  const actor = getWeaponOwnerActor(weapon);
  return getActorInstalledModuleItems(actor).find(item => (
    String(item.system?.placement?.parentItemId ?? "") === String(weapon?.id ?? "")
    && String(item.system?.placement?.moduleSlotId ?? "") === moduleFunction.slotId
  )) ?? null;
}

function getSpentQuantityItemData(weapon, multiplier = 1, weaponFunctionId = "", { modifierState = null } = {}) {
  const amount = getWeaponQuantityResourceCost(weapon, multiplier, weaponFunctionId, { modifierState });
  if (amount <= 0) return null;

  const itemData = weapon.toObject();
  foundry.utils.setProperty(itemData, "system.quantity", amount);
  return itemData;
}

function getWeaponQuantityResourceCost(weapon, multiplier = 1, weaponFunctionId = "", { modifierState = null } = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const countMultiplier = Math.max(1, toInteger(multiplier));
  return getWeaponResourceCosts(weaponData, { modifierState }).reduce((total, cost) => {
    if (cost?.type !== "quantity") return total;
    return total + (Math.max(0, toInteger(cost.amount)) * countMultiplier);
  }, 0);
}

async function createSpentQuantityItemTile({
  itemData = null,
  point = null,
  token = null,
  sourceItemUuid = "",
  delayedThrownItemId = "",
  operationId = ""
} = {}) {
  if (!itemData || !point) return null;
  return createThrownItemTile({
    sceneId: canvas.scene?.id ?? "",
    itemData,
    point,
    sourceActorUuid: token?.actor?.uuid ?? "",
    sourceItemUuid,
    delayedThrownItemId,
    operationId
  });
}

async function rollbackSpentQuantityItemTile(operationId = "") {
  const id = String(operationId ?? "").trim();
  if (!id) return true;
  const cleaned = await deleteThrownItemTileByOperation(id);
  if (!cleaned) {
    console.error(`${SYSTEM_ID} | Thrown Item Tile rollback was not confirmed for operation ${id}.`);
  }
  return cleaned;
}

async function rollbackDelayedThrownItemWorldDocuments(delayedThrownItemId = "") {
  const id = String(delayedThrownItemId ?? "").trim();
  if (!id) return true;
  try {
    const cleaned = await deleteDelayedThrownItemWorldDocuments(id);
    if (!cleaned) {
      console.error(`${SYSTEM_ID} | Delayed thrown Item world rollback was not confirmed for ${id}.`);
    }
    return cleaned;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Delayed thrown Item world rollback failed for ${id}.`, error);
    return false;
  }
}

function getAttackLandingPoint(trajectories = [], fallback = null) {
  return trajectories.find(trajectory => trajectory?.end)?.end ?? fallback;
}

function getAttackGeometry(weapon, actionKey, attackerToken, origin, pointer, weaponFunctionId = "", rangeProfile = null) {
  if (!origin || !pointer) return null;
  const resolvedRangeProfile = rangeProfile
    ?? getWeaponRangeProfile(weapon, actionKey, attackerToken, weaponFunctionId);
  if (isVolleyAttackAction(weapon, actionKey, weaponFunctionId)) {
    return getVolleyAttackGeometry(weapon, attackerToken, origin, pointer, weaponFunctionId, resolvedRangeProfile);
  }

  const rangeBonusMeters = getTokenAttackRangeBonusMeters(attackerToken);
  const maxDistancePixels = metersToPixels(getSizeScaledActionMaxRangeMeters(attackerToken, resolvedRangeProfile));
  const dx = pointer.x - origin.x;
  const dy = pointer.y - origin.y;
  const angle = Math.atan2(dy, dx);
  const distance = Math.max(1, maxDistancePixels);
  const halfAngle = getActionAttackConeRadians(weapon, actionKey, weaponFunctionId) / 2;
  const end = getWallClippedEndpoint(attackerToken, origin, angle, distance).point;
  const shapePoints = buildClippedConePoints(attackerToken, { origin, angle, distance, halfAngle });
  return { origin, angle, distance, rangeBonusMeters, halfAngle, end, shapePoints };
}

function getCircularAttackGeometry(weapon, actionKey, attackerToken, origin, weaponFunctionId = "", rangeProfile = null) {
  if (!origin) return null;
  const resolvedRangeProfile = rangeProfile
    ?? getWeaponRangeProfile(weapon, actionKey, attackerToken, weaponFunctionId);
  const rangeBonusMeters = getTokenAttackRangeBonusMeters(attackerToken);
  const distance = Math.max(1, metersToPixels(getSizeScaledActionMaxRangeMeters(attackerToken, resolvedRangeProfile)));
  const angle = 0;
  const halfAngle = Math.PI;
  const end = {
    x: origin.x + distance,
    y: origin.y,
    elevation: origin.elevation
  };
  const shapePoints = buildClippedCirclePoints(attackerToken, { origin, distance });
  return { origin, angle, distance, rangeBonusMeters, halfAngle, end, shapePoints };
}

function getVolleyAttackGeometry(weapon, attackerToken, origin, pointer, weaponFunctionId = "", rangeProfile = null) {
  const resolvedRangeProfile = rangeProfile
    ?? getWeaponRangeProfile(weapon, VOLLEY_ACTION_KEY, attackerToken, weaponFunctionId);
  const rangeBonusMeters = getTokenAttackRangeBonusMeters(attackerToken);
  const maxRangeMeters = resolvedRangeProfile.maxRangeUnlimited
    ? 0
    : Math.max(0, resolvedRangeProfile.maxRangeMeters + rangeBonusMeters);
  const maxDistancePixels = metersToPixels(maxRangeMeters);
  const radiusPixels = metersToPixels(getVolleyDamageRadius(weapon, weaponFunctionId));
  const dx = pointer.x - origin.x;
  const dy = pointer.y - origin.y;
  const angle = Math.atan2(dy, dx);
  const requestedDistance = Math.max(1, Math.hypot(dx, dy));
  const maxDistance = resolvedRangeProfile.maxRangeUnlimited
    ? requestedDistance
    : Math.min(requestedDistance, Math.max(1, maxDistancePixels));
  const clipped = getWallClippedEndpoint(attackerToken, origin, angle, maxDistance);
  return {
    type: VOLLEY_ACTION_KEY,
    origin,
    angle,
    distance: clipped.distance,
    rangeBonusMeters,
    halfAngle: 0,
    end: clipped.point,
    radiusPixels,
    shapePoints: []
  };
}

function getActionAttackConeRadians(weapon, actionKey, weaponFunctionId = "") {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const sourceWeaponData = getWeaponAttackSourceData(weapon, weaponFunctionId);
  const sourceActionData = sourceWeaponData?.[actionKey] ?? {};
  const hasActionCone = Object.hasOwn(sourceActionData, "attackConeDegrees");
  const actionCone = Number(weaponData?.[actionKey]?.attackConeDegrees);
  const fallbackCone = Number(weaponData.attackConeDegrees);
  const useActionCone = !getAbilityAttackSettings(weapon, weaponFunctionId) && hasActionCone;
  const degrees = useActionCone && Number.isFinite(actionCone)
    ? actionCone
    : (Number.isFinite(fallbackCone) && fallbackCone > 0 ? fallbackCone : DEFAULT_WEAPON_ATTACK_CONE_DEGREES);
  return Math.max(0, (Number(degrees) || 0) * (Math.PI / 180));
}

function getActionMaxRangeMeters(weapon, actionKey, weaponFunctionId = "") {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  if (actionKey === PUSH_ACTION_KEY) {
    const actionData = weaponData?.push ?? {};
    const hasValue = Object.hasOwn(actionData, "maxRangeMeters");
    return evaluateWeaponFormula(weapon, actionData.maxRangeMeters, {
      fallback: hasValue ? 0 : DEFAULT_WEAPON_PUSH_MAX_RANGE_METERS,
      minimum: 0,
      context: "push max range"
    });
  }
  return evaluateWeaponFormula(weapon, weaponData?.maxRangeMeters, {
    minimum: 0,
    context: "weapon max range"
  });
}

function getSizeScaledActionMaxRangeMeters(attackerToken = null, rangeProfile = null) {
  return Math.max(0, Number(rangeProfile?.maxRangeMeters) || 0) + getTokenAttackRangeBonusMeters(attackerToken);
}

function getWeaponRangeProfile(weapon, actionKey, attackerToken = null, weaponFunctionId = "", context = {}) {
  const actor = attackerToken?.actor ?? getWeaponOwnerActor(weapon);
  const weaponData = context?.weaponData ?? getWeaponAttackData(weapon, weaponFunctionId);
  const baseEffectiveRange = resolveBaseWeaponEffectiveRange(
    weaponData?.effectiveRange,
    value => weapon?.type === "ability"
      ? evaluateAbilityAttackFormula(value, actor, {
        minimum: 0,
        context: "effective range"
      })
      : evaluateActorFormula(value, actor, {
        minimum: 0,
        context: "effective range"
      })
  );
  const conditionEffectiveRange = applyWeaponEffectiveRangeBonuses(baseEffectiveRange, {
    nearBonusMeters: Number(actor?.system?.combat?.effectiveRangeNearBonus) || 0,
    farBonusMeters: Number(actor?.system?.combat?.effectiveRangeFarBonus) || 0
  });
  const modifierContext = {
    actorToken: attackerToken,
    token: attackerToken,
    weapon,
    weaponUuid: String(weapon?.uuid ?? "").trim(),
    weaponData,
    actionKey: String(actionKey ?? "").trim(),
    weaponActionKey: String(actionKey ?? "").trim(),
    weaponFunctionId,
    ...context,
    effectiveRange: context?.rangeConditionEffectiveRange ?? conditionEffectiveRange
  };
  const modifiers = getWeaponRangeModifierValues(actor, modifierContext);
  const baseMaxRangeMeters = getActionMaxRangeMeters(weapon, actionKey, weaponFunctionId);
  const maxRangeUnlimited = isVolleyAttackAction(weapon, actionKey, weaponFunctionId)
    && baseMaxRangeMeters <= 0;
  return {
    baseMaxRangeMeters,
    maxRangeMeters: maxRangeUnlimited
      ? 0
      : Math.max(0, baseMaxRangeMeters + modifiers.attackRangeBonus),
    maxRangeUnlimited,
    baseEffectiveRange,
    conditionEffectiveRange,
    effectiveRange: applyWeaponEffectiveRangeBonuses(baseEffectiveRange, {
      nearBonusMeters: modifiers.effectiveRangeNearBonus,
      farBonusMeters: modifiers.effectiveRangeFarBonus
    }),
    modifiers
  };
}

function getWeaponRangeModifierValues(actor, context = {}) {
  const fields = [
    ["attackRangeBonus", ATTACK_RANGE_BONUS_EFFECT_KEY],
    ["effectiveRangeNearBonus", EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY],
    ["effectiveRangeFarBonus", EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY]
  ];
  return getSourceContextualAbilityChangeValues(actor, fields.map(([id, key]) => ({
    id,
    key,
    baseValue: Number(actor?.system?.combat?.[id]) || 0
  })), context);
}

function getAimedRangeModifierValues(actor, context = {}) {
  const fields = [
    ["aimedEffectiveRangeNearBonus", AIMED_EFFECTIVE_RANGE_NEAR_BONUS_EFFECT_KEY],
    ["aimedEffectiveRangeFarBonus", AIMED_EFFECTIVE_RANGE_FAR_BONUS_EFFECT_KEY],
    ["aimedEffectiveRangeNearRestrictionDisabled", AIMED_EFFECTIVE_RANGE_NEAR_RESTRICTION_DISABLED_EFFECT_KEY],
    ["aimedEffectiveRangeFarRestrictionDisabled", AIMED_EFFECTIVE_RANGE_FAR_RESTRICTION_DISABLED_EFFECT_KEY]
  ];
  return getSourceContextualAbilityChangeValues(actor, fields.map(([id, key]) => ({
    id,
    key,
    baseValue: Number(actor?.system?.combat?.[id]) || 0
  })), context);
}

function getAimedTargetRangeSelectionState({
  weapon = null,
  actionKey = "",
  attackerToken = null,
  targetToken = null,
  weaponFunctionId = "",
  rangeProfile = null,
  context = {}
} = {}) {
  const actor = attackerToken?.actor ?? getWeaponOwnerActor(weapon);
  const attackDistanceMeters = getTokenDistanceMeters(attackerToken, targetToken);
  const resolvedProfile = rangeProfile ?? getWeaponRangeProfile(
    weapon,
    actionKey,
    attackerToken,
    weaponFunctionId,
    {
      ...context,
      targetToken,
      targetActor: targetToken?.actor ?? null,
      attackDistanceMeters
    }
  );
  const modifierContext = {
    ...context,
    actorToken: attackerToken,
    token: attackerToken,
    targetToken,
    targetActor: targetToken?.actor ?? null,
    weapon,
    weaponUuid: String(weapon?.uuid ?? "").trim(),
    weaponData: context?.weaponData ?? getWeaponAttackData(weapon, weaponFunctionId),
    actionKey: String(actionKey ?? "").trim(),
    weaponActionKey: String(actionKey ?? "").trim(),
    weaponFunctionId,
    attackDistanceMeters,
    effectiveRange: resolvedProfile?.effectiveRange ?? null
  };
  const modifiers = getAimedRangeModifierValues(actor, modifierContext);
  return {
    ...getAimedRangeSelectionState({
      attackDistanceMeters,
      effectiveRange: resolvedProfile?.effectiveRange,
      nearBonusMeters: modifiers.aimedEffectiveRangeNearBonus,
      farBonusMeters: modifiers.aimedEffectiveRangeFarBonus,
      nearLimitDisabled: modifiers.aimedEffectiveRangeNearRestrictionDisabled,
      farLimitDisabled: modifiers.aimedEffectiveRangeFarRestrictionDisabled
    }),
    modifiers,
    rangeProfile: resolvedProfile
  };
}

function getTokenAttackRangeBonusMeters(token) {
  const document = token?.document ?? token;
  const width = Math.max(1, Number(document?._source?.width ?? document?.width) || 1);
  const height = Math.max(1, Number(document?._source?.height ?? document?.height) || 1);
  return Math.max(0, Math.round(Math.max(width, height)) - 1);
}

function getAttackGeometryDistanceMeters(geometry = null) {
  return Math.max(0, pixelsToMeters(geometry?.distance) - Math.max(0, Number(geometry?.rangeBonusMeters) || 0));
}

function metersToPixels(meters) {
  const gridDistance = Math.max(0.0001, Number(canvas.scene?.grid?.distance ?? canvas.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  return Math.max(0, meters) * (gridSize / gridDistance);
}

function pixelsToMeters(pixels) {
  const gridDistance = Math.max(0.0001, Number(canvas.scene?.grid?.distance ?? canvas.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  return Math.max(0, Number(pixels) || 0) * (gridDistance / gridSize);
}

function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function drawAttackShape(graphics, geometry, { locked = false, hasTargets = false } = {}) {
  const color = hasTargets ? 0xff3b3b : 0xffd166;
  const alpha = locked ? 0.24 : 0.18;
  if (geometry.type === VOLLEY_ACTION_KEY) {
    graphics.lineStyle(2, color, 0.7);
    graphics.moveTo(geometry.origin.x, geometry.origin.y);
    graphics.lineTo(geometry.end.x, geometry.end.y);
    graphics.lineStyle(2, color, 0.9);
    graphics.beginFill(color, alpha);
    graphics.drawCircle(geometry.end.x, geometry.end.y, Math.max(1, Number(geometry.radiusPixels) || 0));
    graphics.endFill();
    return;
  }
  if (geometry.ricochet && Array.isArray(geometry.ricochetTrajectory?.segments)) {
    drawRicochetAttackShape(graphics, geometry, { color, alpha });
    return;
  }
  const points = Array.isArray(geometry.shapePoints) && geometry.shapePoints.length
    ? geometry.shapePoints.flatMap(point => [point.x, point.y])
    : buildConePoints(geometry);
  graphics.lineStyle(2, color, 0.9);
  graphics.beginFill(color, alpha);
  if (points.length >= 6) graphics.drawPolygon(points);
  else graphics.moveTo(geometry.origin.x, geometry.origin.y).lineTo(geometry.end.x, geometry.end.y);
  graphics.endFill();
}

function drawRicochetAttackShape(graphics, geometry, { color = 0xffd166, alpha = 0.18 } = {}) {
  const cone = geometry.ricochetCone;
  const rays = Array.isArray(cone?.rays) ? cone.rays : [];
  const strips = Array.isArray(cone?.strips) ? cone.strips : [];
  if (rays.length < 2 || !strips.length) return;

  graphics.lineStyle(0);
  graphics.beginFill(color, alpha);
  for (const strip of strips) {
    const points = strip.flatMap(point => [point.x, point.y]);
    if (points.length >= 6) graphics.drawPolygon(points);
  }
  graphics.endFill();

  graphics.lineStyle(2, color, 0.9);
  drawRicochetRayOutline(graphics, rays[0]);
  drawRicochetRayOutline(graphics, rays.at(-1));
}

function drawRicochetRayOutline(graphics, trajectory = {}) {
  const segments = trajectory?.segments ?? [];
  if (!segments.length) return;
  graphics.moveTo(segments[0].origin.x, segments[0].origin.y);
  for (const segment of segments) graphics.lineTo(segment.end.x, segment.end.y);
}

function buildConePoints({ origin, angle, distance, halfAngle }) {
  if (halfAngle <= 0) return [];
  const points = [origin.x, origin.y];
  const segments = 24;
  for (let index = 0; index <= segments; index += 1) {
    const step = -halfAngle + ((halfAngle * 2 * index) / segments);
    points.push(
      origin.x + (Math.cos(angle + step) * distance),
      origin.y + (Math.sin(angle + step) * distance)
    );
  }
  return points;
}

function buildClippedConePoints(attackerToken, { origin, angle, distance, halfAngle }) {
  if (halfAngle <= 0) return [];
  const points = [origin];
  const segments = 24;
  for (let index = 0; index <= segments; index += 1) {
    const step = -halfAngle + ((halfAngle * 2 * index) / segments);
    points.push(getWallClippedEndpoint(attackerToken, origin, angle + step, distance).point);
  }
  return points;
}

function buildClippedCirclePoints(attackerToken, { origin, distance }) {
  if (!origin) return [];
  const points = [];
  const segments = 48;
  for (let index = 0; index < segments; index += 1) {
    const angle = (Math.PI * 2 * index) / segments;
    points.push(getWallClippedEndpoint(attackerToken, origin, angle, distance).point);
  }
  return points;
}

function getAttackGeometryTokenCandidates(geometry) {
  return getCanvasTokenCandidates(getAttackGeometryCandidateBounds(geometry));
}

function getAttackGeometryCandidateBounds(geometry) {
  if (geometry?.type === VOLLEY_ACTION_KEY) {
    const x = Number(geometry.end?.x);
    const y = Number(geometry.end?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const radius = Math.max(0, Number(geometry.radiusPixels) || 0);
    const extent = radius + 1;
    return {
      left: x - extent,
      top: y - extent,
      width: Math.max(1, extent * 2),
      height: Math.max(1, extent * 2)
    };
  }

  const points = [...getAttackPolygonPoints(geometry)];
  for (const strip of geometry?.ricochetCone?.strips ?? []) {
    if (Array.isArray(strip)) points.push(...strip);
  }
  if (!points.length) points.push(geometry?.origin, geometry?.end);
  return getPointCollectionBounds(points);
}

function getTrajectoryTokenCandidates(trajectory) {
  return getCanvasTokenCandidates(getPointCollectionBounds([
    trajectory?.origin,
    trajectory?.end
  ], 1));
}

function getPointCollectionBounds(points = [], padding = 1) {
  const valid = points.filter(point => (
    Number.isFinite(Number(point?.x))
    && Number.isFinite(Number(point?.y))
  ));
  if (!valid.length) return null;
  const inset = Math.max(0, Number(padding) || 0);
  const left = Math.min(...valid.map(point => Number(point.x))) - inset;
  const right = Math.max(...valid.map(point => Number(point.x))) + inset;
  const top = Math.min(...valid.map(point => Number(point.y))) - inset;
  const bottom = Math.max(...valid.map(point => Number(point.y))) + inset;
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

function getCanvasTokenCandidates(bounds = null) {
  if (!bounds) return [];
  const Rectangle = globalThis.PIXI?.Rectangle;
  const quadtree = canvas.tokens?.quadtree;
  const rectangle = new Rectangle(bounds.left, bounds.top, bounds.width, bounds.height);
  return Array.from(quadtree.getObjects(rectangle));
}

function getPotentialTargets(attackerToken, geometry, {
  includeAttacker = false,
  includeDead = false,
  targetTokenUuidAllowlist = null,
  purpose = "preview"
} = {}) {
  const allowlist = normalizeTargetTokenUuidAllowlist(targetTokenUuidAllowlist);
  const impact = purpose === "impact";
  const candidates = getAttackGeometryTokenCandidates(geometry);
  const isEligible = target => impact
    ? isAttackImpactTarget(target)
    : isAttackTargetVisible(target, allowlist, attackerToken);
  if (Array.isArray(geometry?.ricochetCone?.strips)) {
    const entries = new Map();
    return candidates
      .filter(target => {
        if (
          (!includeAttacker && target === attackerToken)
          || !target.actor
          || !isEligible(target)
        ) return false;
        const entry = getRicochetTargetEntry(target, geometry, allowlist, { purpose });
        if (entry) entries.set(target, entry);
        return entry !== null;
      })
      .sort((left, right) => (
        (entries.get(left)?.distance ?? Infinity)
        - (entries.get(right)?.distance ?? Infinity)
      ));
  }
  return candidates.filter(target => {
    if (
      (!includeAttacker && target === attackerToken)
      || !target.actor
      || !isEligible(target)
    ) return false;
    return geometry.type === VOLLEY_ACTION_KEY
      ? Boolean(getVisibleTokenAttackPoint(attackerToken, target, geometry))
      : Boolean(selectTargetTrajectoryAimPoint(attackerToken, target, geometry));
  }).sort((left, right) => getTargetDistance(left, geometry) - getTargetDistance(right, geometry));
}

function getVolleyTrajectoryAimTarget(attackerToken, geometry, {
  includeAttacker = false,
  includeDead = false,
  candidates = null
} = {}) {
  if (!geometry || geometry.type !== VOLLEY_ACTION_KEY) return null;
  const perceivedCandidates = Array.isArray(candidates)
    ? candidates
    : (canvas.tokens?.placeables ?? []).filter(target => (
      target?.actor && isAttackTargetVisible(target, null, attackerToken)
    ));
  return perceivedCandidates
    .filter(target => {
      if ((!includeAttacker && target === attackerToken) || !target.actor) return false;
      if (!includeDead && isDeadTarget(target)) return false;
      return isTokenInVolleyPlanarRadius(target, geometry);
    })
    .sort((left, right) => getTokenVolleyPlanarCenterDistance(left, geometry) - getTokenVolleyPlanarCenterDistance(right, geometry))
    .at(0) ?? null;
}

function getAimedElevationTargets(attackerToken, geometry, targets = []) {
  if (!geometry?.aimPoint || geometry.type === VOLLEY_ACTION_KEY) return targets;
  const aimTrajectory = buildTrajectoryThroughPoint(attackerToken, geometry, geometry.aimPoint);
  return targets.filter(target => isTokenInAimedElevationSlice(attackerToken, target, geometry, aimTrajectory));
}

function getAttackAutoCoverStates(attackerToken, geometry, targets = []) {
  if (!attackerToken || !geometry || geometry.type === VOLLEY_ACTION_KEY) return [];
  const settings = getCoverSettings().entries
    .sort((left, right) => Math.max(0, toInteger(right.overlapPercent)) - Math.max(0, toInteger(left.overlapPercent)));
  if (!settings.length) return [];
  const hasWallCoverThreshold = settings.some(entry => Math.max(0, toInteger(entry.overlapPercent)) > 0);

  const targetTokenUuidAllowlist = new Set((targets ?? []).map(getTokenDocumentUuid).filter(Boolean));
  const ricochetEntries = Array.isArray(geometry?.ricochetCone?.strips)
    ? new Map((targets ?? []).map(target => [
      target,
      getRicochetTargetEntry(target, geometry, targetTokenUuidAllowlist)
    ]))
    : new Map();
  const states = [];
  for (const target of targets ?? []) {
    if (!target?.actor || target === attackerToken || isDeadTarget(target)) continue;
    if (getActorForcedCoverData(target.actor)?.key) continue;
    const ricochetEntry = ricochetEntries.get(target);
    const obstructionGeometry = ricochetEntry?.segment
      ? { ...geometry, origin: ricochetEntry.segment.origin }
      : geometry;
    const targetPolygon = ricochetEntry
      ? getTokenWorldPolygon(target)
      : getTokenAttackCoverPolygon(target, obstructionGeometry);
    const coverSamplePoints = targetPolygon
      ? getTokenActorCoverSamplePoints(target, obstructionGeometry.origin, targetPolygon)
      : [];
    const contourMasks = getCoverSampleMasksIntersectingSegments(
      target.document?.parent ?? target.scene ?? canvas.scene,
      obstructionGeometry.origin,
      coverSamplePoints,
      target.document?._source?.level ?? target.document?.level ?? target.level?.id ?? ""
    );
    const wallMask = hasWallCoverThreshold
      ? getTokenAttackObstructionMask(attackerToken, obstructionGeometry, coverSamplePoints)
      : null;
    const { cover, obstructionPercent } = resolveCoverFromSampleMasks(
      settings,
      wallMask,
      contourMasks,
      coverSamplePoints.length
    );
    states.push({
      actorUuid: target.actor.uuid,
      targetTokenUuid: target.document?.uuid ?? "",
      attackerTokenUuid: attackerToken.document?.uuid ?? "",
      coverKey: cover?.key ?? "",
      obstructionPercent
    });
  }
  return states;
}

function getAttackAutoCoverSignature(states = []) {
  return states
    .map(state => [
      String(state.actorUuid ?? ""),
      String(state.targetTokenUuid ?? ""),
      String(state.coverKey ?? "")
    ].join(":"))
    .sort()
    .join("|");
}

function getTokenAttackObstructionMask(attackerToken, geometry, preparedSamples = []) {
  const samples = Array.isArray(preparedSamples) ? preparedSamples : [];
  const mask = new Uint8Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    if (isAttackCoverSampleBlocked(attackerToken, samples[index], geometry.origin)) mask[index] = 1;
  }
  return mask;
}

function getTokenActorCoverSamplePoints(target, origin, targetPolygon = null) {
  const polygon = targetPolygon ?? getTokenWorldPolygon(target);
  const points = [];
  for (const point of getAttackIntersectionTestPoints(polygon, origin)) {
    addUniquePoint(points, withTokenAimElevation(target, point));
  }
  addTokenCoverGridSamplePoints(points, target, polygon);
  return sortContactPoints(points, origin);
}

function addTokenCoverGridSamplePoints(points, target, polygon) {
  const bounds = getPolygonBounds(polygon);
  if (!bounds) return;
  const stepCount = AUTO_COVER_GRID_STEPS;
  const stepX = (bounds.right - bounds.left) / stepCount;
  const stepY = (bounds.bottom - bounds.top) / stepCount;
  if (stepX <= GEOMETRY_EPSILON || stepY <= GEOMETRY_EPSILON) return;

  for (let xIndex = 0; xIndex < stepCount; xIndex += 1) {
    for (let yIndex = 0; yIndex < stepCount; yIndex += 1) {
      const point = {
        x: bounds.left + (stepX * (xIndex + 0.5)),
        y: bounds.top + (stepY * (yIndex + 0.5))
      };
      if (!polygon?.contains?.(point.x, point.y)) continue;
      addUniquePoint(points, withTokenAimElevation(target, point));
    }
  }
}

function isAttackCoverSampleBlocked(attackerToken, point, origin) {
  return !hasLineOfSight(attackerToken, point, origin);
}

function isTokenInAimedElevationSlice(attackerToken, target, geometry, aimTrajectory) {
  const hit = getTokenAimedElevationIntersection(target, geometry, aimTrajectory);
  return Boolean(hit?.point && hasLineOfSight(attackerToken, hit.point, geometry.origin));
}

function getVisibleTokenAttackPoint(attackerToken, target, geometry) {
  return getVisibleTokenAttackPoints(attackerToken, target, geometry).at(0) ?? null;
}

function selectTargetTrajectoryAimPoint(attackerToken, target, geometry) {
  if (!attackerToken || !target || !geometry || geometry.type === VOLLEY_ACTION_KEY) return null;
  const center = getTokenAimPoint(target);
  if (isTargetTrajectoryAimPointValid(attackerToken, target, geometry, center)) return center;

  const targetCenter = center ?? getTokenCenter(target);
  return getVisibleTokenAttackPoints(attackerToken, target, geometry)
    .filter(point => isTargetTrajectoryAimPointValid(attackerToken, target, geometry, point))
    .sort((left, right) => compareTargetTrajectoryAimPoints(left, right, targetCenter, geometry))
    .at(0) ?? null;
}

function selectAttackGeometryAimPoint(attackerToken, target, geometry) {
  if (geometry?.type === VOLLEY_ACTION_KEY) return selectVolleyTrajectoryAimPoint(target, geometry);
  return selectTargetTrajectoryAimPoint(attackerToken, target, geometry);
}

function selectVolleyTrajectoryAimPoint(target, geometry) {
  if (!target || !geometry?.end) return null;
  return getClosestPointOnTokenVolume(target, geometry.end) ?? getTokenAimPoint(target);
}

function aimVolleyGeometryAtPoint(attackerToken, geometry, point) {
  if (!geometry || geometry.type !== VOLLEY_ACTION_KEY || !point) return geometry;
  const clipped = getWallClippedEndpoint(
    attackerToken,
    geometry.origin,
    Number(geometry.angle) || 0,
    Math.max(1, Number(geometry.distance) || 1),
    point.elevation
  );
  return {
    ...geometry,
    distance: clipped.distance,
    end: clipped.point,
    aimPoint: point
  };
}

function isTargetTrajectoryAimPointValid(attackerToken, target, geometry, point) {
  if (!point || !isPointInsideAttackCone(point, geometry)) return false;
  if (!hasLineOfSight(attackerToken, point, geometry.origin)) return false;
  const trajectory = buildTrajectoryThroughPoint(attackerToken, geometry, point);
  const hit = getTokenTrajectoryHit(target, trajectory);
  return Boolean(hit?.point && hit.distance <= trajectory.distance + 0.5 && hasLineOfSight(attackerToken, hit.point, geometry.origin));
}

function compareTargetTrajectoryAimPoints(left, right, targetCenter, geometry) {
  const centerDistance = getPointDistance(left, targetCenter) - getPointDistance(right, targetCenter);
  if (Math.abs(centerDistance) > GEOMETRY_EPSILON) return centerDistance;
  const leftOffset = Math.abs(normalizeAngle(Math.atan2(left.y - geometry.origin.y, left.x - geometry.origin.x) - geometry.angle));
  const rightOffset = Math.abs(normalizeAngle(Math.atan2(right.y - geometry.origin.y, right.x - geometry.origin.x) - geometry.angle));
  if (Math.abs(leftOffset - rightOffset) > GEOMETRY_EPSILON) return leftOffset - rightOffset;
  return getPointDistance(left, geometry.origin) - getPointDistance(right, geometry.origin);
}

function getPointDistance(left, right) {
  if (!left || !right) return Infinity;
  return Math.hypot((Number(left.x) || 0) - (Number(right.x) || 0), (Number(left.y) || 0) - (Number(right.y) || 0));
}

function getVisibleTokenAttackPoints(attackerToken, target, geometry) {
  if (geometry.type === VOLLEY_ACTION_KEY) {
    return getTokenAttackContactPoints(target, geometry)
      .map(point => withTokenAimElevation(target, point))
      .filter(point => hasLineOfSight(attackerToken, point, geometry.end));
  }
  return getTokenAttackContactPoints(target, geometry)
    .map(point => withTokenAimElevation(target, point))
    .filter(point => hasLineOfSight(attackerToken, point, geometry.origin));
}

function hasLineOfSight(attackerToken, destination, origin) {
  return !attackerToken.checkCollision(destination, {
    origin,
    type: "sight",
    mode: "any"
  });
}

function getWallClippedEndpoint(attackerToken, origin, angle, distance, targetElevation = null) {
  const maxDistance = Math.max(1, Number(distance) || 1);
  const originElevation = Number(origin.elevation) || 0;
  const destinationElevation = Number.isFinite(Number(targetElevation)) ? Number(targetElevation) : originElevation;
  const destination = {
    x: origin.x + (Math.cos(angle) * maxDistance),
    y: origin.y + (Math.sin(angle) * maxDistance),
    elevation: destinationElevation
  };
  const collision = attackerToken?.checkCollision?.(destination, {
    origin,
    type: "sight",
    mode: "closest"
  });
  const point = collision
    ? {
      x: Number(collision.x) || destination.x,
      y: Number(collision.y) || destination.y,
      elevation: Number.isFinite(Number(collision.elevation))
        ? Number(collision.elevation)
        : getPointElevationAtDistance(originElevation, destinationElevation, Math.hypot((Number(collision.x) || destination.x) - origin.x, (Number(collision.y) || destination.y) - origin.y), maxDistance)
    }
    : destination;
  return {
    point,
    distance: Math.max(1, Math.hypot(point.x - origin.x, point.y - origin.y))
  };
}

function clearTargetMarkerLayer(graphics) {
  graphics?.clear?.();
  for (const child of [...(graphics?.children ?? [])]) child.destroy({ children: true });
}

function drawTargetMarkers(graphics, targets, focusedTarget = null, time = performance.now(), burstRanges = new Map()) {
  clearTargetMarkerLayer(graphics);
  graphics.beginFill(0xff1f1f, 0.95);
  graphics.lineStyle(1, 0x350000, 0.9);
  for (const target of targets) {
    const marker = getTargetMarkerPosition(target);
    if (!marker) continue;
    graphics.drawCircle(marker.x, marker.y, 7);
  }
  graphics.endFill();
  for (const target of targets) {
    const range = burstRanges.get(target);
    if (!range?.label) continue;
    const marker = getTargetBurstLabelPosition(target);
    if (marker) drawBurstAllocationLabel(graphics, marker, range.label);
  }
  const focusedMarker = focusedTarget ? getTargetCenterMarkerPosition(focusedTarget) : null;
  if (focusedMarker) drawFocusedTargetMarker(graphics, focusedMarker, time);
}

function drawTargetMarkerPositions(graphics, markers = [], focusedMarker = null) {
  clearTargetMarkerLayer(graphics);
  graphics.beginFill(0xff1f1f, 0.95);
  graphics.lineStyle(1, 0x350000, 0.9);
  for (const marker of markers) {
    graphics.drawCircle(Number(marker.x) || 0, Number(marker.y) || 0, 7);
  }
  graphics.endFill();
  for (const marker of markers) {
    if (!marker?.burstLabel) continue;
    drawBurstAllocationLabel(graphics, marker.burstLabelPoint ?? marker, marker.burstLabel);
  }
  if (focusedMarker) drawFocusedTargetMarker(graphics, focusedMarker, performance.now());
}

function getTargetMarkerPosition(target) {
  const center = getTokenCenter(target);
  const bounds = getTokenShapeBounds(target);
  if (!center || !bounds) return null;
  return {
    x: center.x,
    y: bounds.bottom + 8
  };
}

function getTargetMarkerPreviewData(target, burstRanges = new Map()) {
  const marker = getTargetMarkerPosition(target);
  if (!marker) return null;
  const range = burstRanges.get(target);
  if (range?.label) {
    marker.burstLabel = range.label;
    marker.burstLabelPoint = getTargetBurstLabelPosition(target);
  }
  return marker;
}

function getTargetCenterMarkerPosition(target) {
  return getTokenCenter(target);
}

function getTargetBurstLabelPosition(target) {
  const bounds = getTokenShapeBounds(target);
  if (!bounds) return null;
  return {
    x: bounds.right - 4,
    y: bounds.top + 12,
    anchor: "right"
  };
}

function drawFocusedTargetMarker(graphics, marker, time = performance.now()) {
  const pulse = (Math.sin((Number(time) || 0) / 420) + 1) / 2;
  const radius = 10 + (pulse * 5);
  const alpha = 0.35 + (pulse * 0.35);
  graphics.lineStyle(3, 0x39ff88, alpha);
  graphics.beginFill(0x39ff88, 0.12 + (pulse * 0.1));
  graphics.drawCircle(Number(marker.x) || 0, Number(marker.y) || 0, radius);
  graphics.endFill();
  graphics.lineStyle(1, 0xd9ffe8, 0.85);
  graphics.drawCircle(Number(marker.x) || 0, Number(marker.y) || 0, 4);
}

function drawBurstAllocationLabel(graphics, marker, label = "") {
  const text = new PIXI.Text(String(label), {
    fill: "#fff1b8",
    fontFamily: "Arial, sans-serif",
    fontSize: 16,
    fontWeight: "700",
    stroke: "#090604",
    strokeThickness: 2
  });
  text.resolution = Math.max(2, Number(canvas.app?.renderer?.resolution) || Number(window.devicePixelRatio) || 1);
  text.roundPixels = true;
  text.anchor.set(0.5);

  const x = Math.round(Number(marker?.x) || 0);
  const y = Math.round(Number(marker?.y) || 0);
  const width = Math.ceil(Math.max(24, text.width + 12));
  const height = 20;
  const left = marker?.anchor === "right" ? x - width : x;
  const top = y - (height / 2);
  graphics.lineStyle(1, 0xf2d581, 0.82);
  graphics.beginFill(0x080906, 0.78);
  graphics.drawRoundedRect(left, top, width, height, 4);
  graphics.endFill();
  text.position.set(Math.round(left + (width / 2)), y);
  graphics.addChild(text);
}

function buildAttackTrajectory(attackerToken, coneGeometry, targets = []) {
  const targetTokenUuidAllowlist = new Set((targets ?? []).map(getTokenDocumentUuid).filter(Boolean));
  if (Array.isArray(coneGeometry?.ricochetCone?.rays)) {
    for (const target of targets ?? []) {
      const entry = getRicochetTargetEntry(target, coneGeometry, targetTokenUuidAllowlist);
      if (entry?.trajectory) return foundry.utils.deepClone(entry.trajectory);
      const trajectory = findRicochetTrajectoryForTarget(
        attackerToken,
        target,
        coneGeometry,
        97,
        targetTokenUuidAllowlist
      );
      if (trajectory) return trajectory;
    }
    return buildRandomTrajectory(attackerToken, coneGeometry);
  }
  const aimPoint = selectTrajectoryAimPoint(attackerToken, coneGeometry, targets);
  if (aimPoint) return buildTrajectoryThroughPoint(attackerToken, coneGeometry, aimPoint);
  return buildRandomTrajectory(attackerToken, coneGeometry);
}

function buildAttackTrajectories(
  attackerToken,
  coneGeometry,
  targets = [],
  count = 1,
  { assignPelletTargets = false } = {}
) {
  const amount = Math.max(1, toInteger(count) || 1);
  if (amount <= 1) return [buildAttackTrajectory(attackerToken, coneGeometry, targets)];
  if (assignPelletTargets && targets.length) {
    const trajectories = buildAssignedPelletTrajectories(attackerToken, coneGeometry, targets, amount);
    if (trajectories.length === amount) return trajectories;
  }

  const trajectories = [];
  const reserved = new Set();
  const spacing = getPelletPointSpacing();
  const pelletGeometry = getRandomBurstMissGeometry(attackerToken, coneGeometry);

  for (let index = 0; index < amount; index += 1) {
    const trajectory = buildReservedPelletTrajectory(attackerToken, pelletGeometry, reserved, spacing);
    trajectories.push(trajectory);
  }

  return trajectories;
}

function buildAssignedPelletTrajectories(attackerToken, geometry, targets = [], count = 1) {
  const amount = Math.max(1, toInteger(count) || 1);
  const profiles = targets
    .map(target => ({
      target,
      points: getPelletTargetAimPoints(attackerToken, target, geometry),
      weight: getPelletTargetCenterWeight(target, geometry),
      pointIndex: 0
    }))
    .filter(profile => profile.points.length);
  if (!profiles.length) return [];

  return allocatePelletTargetProfiles(profiles, amount).map(profile => {
    const point = profile.points[profile.pointIndex % profile.points.length];
    profile.pointIndex += 1;
    return buildTrajectoryThroughPoint(attackerToken, geometry, point);
  });
}

function allocatePelletTargetProfiles(profiles = [], count = 1) {
  const amount = Math.max(1, toInteger(count) || 1);
  const totalWeight = profiles.reduce((sum, profile) => sum + profile.weight, 0);
  const allocations = profiles.map((profile, index) => {
    const exact = (profile.weight / totalWeight) * amount;
    return {
      profile,
      index,
      count: Math.floor(exact),
      remainder: exact - Math.floor(exact)
    };
  });
  const assigned = allocations.reduce((sum, entry) => sum + entry.count, 0);
  const remaining = amount - assigned;
  [...allocations]
    .sort((left, right) => (
      (right.remainder - left.remainder)
      || (right.profile.weight - left.profile.weight)
      || (left.index - right.index)
    ))
    .slice(0, remaining)
    .forEach(entry => { entry.count += 1; });

  return shuffleBurstShots(allocations.flatMap(entry => Array(entry.count).fill(entry.profile)));
}

function getPelletTargetCenterWeight(target, geometry) {
  const centrality = clamp(Number(getBurstTargetAxisProfile(target, geometry, 1)?.weight) || 0, 0, 1);
  return Math.max(GEOMETRY_EPSILON, centrality * centrality);
}

function getPelletTargetAimPoints(attackerToken, target, geometry) {
  const points = [];
  addUniquePoint(points, selectTargetTrajectoryAimPoint(attackerToken, target, geometry));
  for (const point of getVisibleTokenAttackPoints(attackerToken, target, geometry)) {
    if (isTargetTrajectoryAimPointValid(attackerToken, target, geometry, point)) addUniquePoint(points, point);
  }
  return points;
}

function buildAimedAttackTrajectories(attackerToken, coneGeometry, centerTrajectory, target, count = 1) {
  const amount = Math.max(1, toInteger(count) || 1);
  if (amount <= 1) return [centerTrajectory];

  const trajectories = [centerTrajectory];
  const points = getPelletTargetAimPoints(attackerToken, target, coneGeometry);
  if (!points.length) {
    return Array.from({ length: amount }, () => ({
      ...centerTrajectory,
      origin: { ...centerTrajectory.origin },
      end: { ...centerTrajectory.end }
    }));
  }

  for (let index = 1; index < amount; index += 1) {
    trajectories.push(buildTrajectoryThroughPoint(
      attackerToken,
      coneGeometry,
      points[index % points.length]
    ));
  }

  return trajectories;
}

function buildReservedPelletTrajectory(attackerToken, geometry, reserved, spacing) {
  const attempts = 220;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const trajectory = buildRandomTrajectory(attackerToken, geometry);
    if (reservePelletPoint(trajectory.end, reserved, spacing)) return trajectory;
  }

  const trajectory = buildRandomTrajectory(attackerToken, geometry);
  reservePelletPoint(trajectory.end, reserved, spacing, true);
  return trajectory;
}

function getPelletPointSpacing() {
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  return Math.max(1, gridSize / 10);
}

function reservePelletPoint(point, reserved, spacing, force = false) {
  const qx = Math.round((Number(point?.x) || 0) / spacing);
  const qy = Math.round((Number(point?.y) || 0) / spacing);
  const key = `${qx}:${qy}`;
  if (!force && reserved.has(key)) return false;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      reserved.add(`${qx + dx}:${qy + dy}`);
    }
  }
  return true;
}

function selectTrajectoryAimPoint(attackerToken, geometry, targets = []) {
  if (geometry?.aimPoint) return geometry.aimPoint;
  return (targets ?? [])
    .map(target => selectTargetTrajectoryAimPoint(attackerToken, target, geometry))
    .find(point => point) ?? null;
}

function buildTrajectoryThroughPoint(attackerToken, geometry, point) {
  const angle = Math.atan2(point.y - geometry.origin.y, point.x - geometry.origin.x);
  const pointDistance = Math.max(1, Math.hypot(point.x - geometry.origin.x, point.y - geometry.origin.y));
  const originElevation = Number(geometry.origin?.elevation) || 0;
  const elevationSlope = (Number(point.elevation ?? originElevation) - originElevation) / pointDistance;
  return buildTrajectoryByAngle(attackerToken, geometry, angle, elevationSlope);
}

function getRandomBurstMissGeometry(attackerToken, geometry) {
  if (!geometry?.aimPoint) return geometry;
  const aimTrajectory = buildTrajectoryThroughPoint(attackerToken, geometry, geometry.aimPoint);
  return {
    ...geometry,
    aimPoint: null,
    elevationSlope: aimTrajectory.elevationSlope
  };
}

function buildRandomTrajectory(attackerToken, geometry) {
  const spread = geometry.halfAngle > 0
    ? -geometry.halfAngle + (Math.random() * geometry.halfAngle * 2)
    : 0;
  return buildTrajectoryByAngle(attackerToken, geometry, geometry.angle + spread, Number(geometry.elevationSlope) || 0);
}

function buildTrajectoryByAngle(attackerToken, geometry, angle, elevationSlope = 0) {
  if (geometry?.ricochet?.maxReflections > 0) {
    return buildRicochetTrajectory(attackerToken, geometry, angle, elevationSlope, geometry.ricochet.maxReflections);
  }
  const originElevation = Number(geometry.origin?.elevation) || 0;
  const targetElevation = originElevation + ((Number(elevationSlope) || 0) * Math.max(1, Number(geometry.distance) || 1));
  const clipped = getWallClippedEndpoint(attackerToken, geometry.origin, angle, geometry.distance, targetElevation);
  const distance = clipped.distance;
  const endElevation = getPointElevationAtDistance(originElevation, targetElevation, distance, Math.max(1, Number(geometry.distance) || 1));
  return {
    origin: geometry.origin,
    angle,
    distance,
    halfAngle: 0,
    elevationSlope: Number(elevationSlope) || 0,
    end: {
      ...clipped.point,
      elevation: Number.isFinite(Number(clipped.point?.elevation)) ? Number(clipped.point.elevation) : endElevation
    }
  };
}

function buildRicochetTrajectory(attackerToken, geometry, initialAngle, elevationSlope = 0, maxReflections = 0) {
  const totalDistance = Math.max(1, Number(geometry.distance) || 1);
  const slope = Number(elevationSlope) || 0;
  const reflectionLimit = Math.max(0, toInteger(maxReflections));
  const segments = [];
  const reflectionPath = [];
  let origin = { ...geometry.origin };
  let angle = Number(initialAngle) || 0;
  let remaining = totalDistance;
  let traveled = 0;
  let reflectionCount = 0;

  while (remaining > GEOMETRY_EPSILON) {
    const targetElevation = (Number(geometry.origin?.elevation) || 0) + (slope * totalDistance);
    const collisionData = getWallCollision(attackerToken, origin, angle, remaining, targetElevation);
    const segmentDistance = collisionData.distance;
    const segment = {
      origin: { ...origin },
      angle,
      distance: segmentDistance,
      halfAngle: 0,
      elevationSlope: slope,
      reflectionCount,
      distanceOffset: traveled,
      end: { ...collisionData.point }
    };
    segments.push(segment);
    traveled += segmentDistance;
    remaining = Math.max(0, totalDistance - traveled);

    if (!collisionData.collision || reflectionCount >= reflectionLimit || remaining <= GEOMETRY_EPSILON) break;
    const wallDirection = getCollisionWallDirection(collisionData.collision, angle);
    if (!wallDirection) break;
    reflectionPath.push(getWallDirectionKey(wallDirection));
    angle = reflectAngleAcrossWall(angle, wallDirection);
    reflectionCount += 1;
    const nudge = Math.min(0.5, remaining);
    origin = {
      x: collisionData.point.x + (Math.cos(angle) * nudge),
      y: collisionData.point.y + (Math.sin(angle) * nudge),
      elevation: collisionData.point.elevation
    };
  }

  const last = segments.at(-1);
  return {
    origin: geometry.origin,
    angle: Number(initialAngle) || 0,
    distance: traveled,
    halfAngle: 0,
    elevationSlope: slope,
    end: last?.end ?? geometry.origin,
    reflectionCount,
    reflectionPath,
    branchKey: getRicochetTrajectoryBranchKey(reflectionPath),
    segments
  };
}

function buildRicochetCone(attackerToken, geometry, rayCount = 25) {
  const amount = Math.max(2, toInteger(rayCount));
  const halfAngle = Math.max(0, Number(geometry.halfAngle) || 0);
  const rays = [];
  for (let index = 0; index < amount; index += 1) {
    const ratio = amount <= 1 ? 0.5 : index / (amount - 1);
    const angle = geometry.angle - halfAngle + ((halfAngle * 2) * ratio);
    rays.push(buildRicochetTrajectory(
      attackerToken,
      geometry,
      angle,
      Number(geometry.elevationSlope) || 0,
      geometry.ricochet?.maxReflections
    ));
  }
  return {
    rays,
    strips: rays.slice(0, -1).flatMap((ray, index) => buildRicochetRayStrip(ray, rays[index + 1]))
  };
}

function buildRicochetRayStrip(leftRay, rightRay) {
  const distances = new Set([0, Math.max(0, Number(leftRay?.distance) || 0), Math.max(0, Number(rightRay?.distance) || 0)]);
  for (const ray of [leftRay, rightRay]) {
    for (const segment of ray?.segments ?? []) {
      distances.add(Math.max(0, Number(segment.distanceOffset) || 0));
      distances.add(
        Math.max(0, Number(segment.distanceOffset) || 0)
        + Math.max(0, Number(segment.distance) || 0)
      );
    }
  }
  const maximum = Math.min(Math.max(0, Number(leftRay?.distance) || 0), Math.max(0, Number(rightRay?.distance) || 0));
  const samples = Array.from(distances)
    .filter(distance => distance >= 0 && distance <= maximum + GEOMETRY_EPSILON)
    .sort((left, right) => left - right);
  const cells = [];
  for (let index = 0; index < samples.length - 1; index += 1) {
    const start = samples[index];
    const end = samples[index + 1];
    const midpoint = (start + end) / 2;
    const leftSample = getRicochetTrajectorySample(leftRay, midpoint);
    const rightSample = getRicochetTrajectorySample(rightRay, midpoint);
    if (!areRicochetSamplesCompatible(leftSample, rightSample)) continue;
    const leftStart = getPointOnRicochetTrajectory(leftRay, start);
    const leftEnd = getPointOnRicochetTrajectory(leftRay, end);
    const rightStart = getPointOnRicochetTrajectory(rightRay, start);
    const rightEnd = getPointOnRicochetTrajectory(rightRay, end);
    if (!leftStart || !leftEnd || !rightStart || !rightEnd) continue;
    cells.push([leftStart, leftEnd, rightEnd, rightStart]);
  }
  return cells;
}

function getRicochetTrajectoryBranchKey(trajectoryOrPath = null) {
  const path = Array.isArray(trajectoryOrPath)
    ? trajectoryOrPath
    : trajectoryOrPath?.reflectionPath;
  return path?.length ? path.join("|") : "direct";
}

function getPointOnRicochetTrajectory(trajectory, distance) {
  return getRicochetTrajectorySample(trajectory, distance)?.point ?? null;
}

function getRicochetTrajectorySample(trajectory, distance) {
  const requested = Math.max(0, Number(distance) || 0);
  const segments = trajectory?.segments ?? [];
  const segmentIndex = segments.findIndex(entry => {
    const start = Math.max(0, Number(entry.distanceOffset) || 0);
    const end = start + Math.max(0, Number(entry.distance) || 0);
    return requested <= end + GEOMETRY_EPSILON;
  });
  const segment = segmentIndex >= 0 ? segments[segmentIndex] : segments.at(-1);
  if (!segment) return null;
  const localDistance = clamp(
    requested - Math.max(0, Number(segment.distanceOffset) || 0),
    0,
    Math.max(0, Number(segment.distance) || 0)
  );
  return {
    trajectory,
    segment,
    segmentIndex: segmentIndex >= 0 ? segmentIndex : segments.length - 1,
    point: getPointOnTrajectory(segment, localDistance),
    branchKey: getRicochetSegmentBranchKey(trajectory, segment)
  };
}

function areRicochetSamplesCompatible(leftSample, rightSample) {
  if (!leftSample?.segment || !rightSample?.segment) return false;
  const leftReflectionCount = Math.max(0, toInteger(leftSample.segment.reflectionCount));
  const rightReflectionCount = Math.max(0, toInteger(rightSample.segment.reflectionCount));
  return leftReflectionCount === rightReflectionCount
    && leftSample.branchKey === rightSample.branchKey;
}

function getRicochetSegmentBranchKey(trajectory = {}, segment = {}) {
  const reflectionCount = Math.max(0, toInteger(segment?.reflectionCount));
  if (reflectionCount <= 0) return "direct";
  const path = Array.isArray(trajectory?.reflectionPath) ? trajectory.reflectionPath : [];
  return path.slice(0, reflectionCount).join("|") || "direct";
}

function getRicochetTargetEntry(target, geometry, targetTokenUuidAllowlist = null, { purpose = "preview" } = {}) {
  const tokenPolygon = getTokenWorldPolygon(target);
  const cone = geometry?.ricochetCone;
  if (!tokenPolygon || !Array.isArray(cone?.strips)) return null;
  const intersectsArea = cone.strips.some(strip => {
    if (!Array.isArray(strip) || strip.length < 3) return false;
    const stripPolygon = new PIXI.Polygon(strip.flatMap(point => [point.x, point.y]));
    const intersection = tokenPolygon.intersectPolygon?.(stripPolygon);
    return getPolygonPointObjects(intersection).length >= 3;
  });
  if (!intersectsArea) return null;

  let best = null;
  for (const trajectory of cone.rays ?? []) {
    const entries = getTrajectoryTargetEntries(null, trajectory, targetTokenUuidAllowlist, { purpose });
    const entry = entries.find(candidate => candidate.target === target);
    if (!entry) continue;
    if (!best || entry.distance < best.distance) best = { ...entry, trajectory };
  }
  if (best) return best;

  const center = getTokenAimPoint(target);
  const distance = Math.min(...(cone.strips ?? [])
    .flat()
    .map(point => Math.hypot(point.x - center.x, point.y - center.y)));
  return {
    target,
    distance: Number.isFinite(distance) ? distance : Infinity,
    trajectory: null,
    segment: null,
    reflectionCount: 0
  };
}

function findRicochetTrajectoryForTarget(
  attackerToken,
  target,
  geometry,
  sampleCount = 97,
  targetTokenUuidAllowlist = null
) {
  if (!attackerToken || !target || !geometry?.ricochet) return null;
  const amount = Math.max(3, toInteger(sampleCount));
  const halfAngle = Math.max(0, Number(geometry.halfAngle) || 0);
  let best = null;
  for (let index = 0; index < amount; index += 1) {
    const ratio = index / (amount - 1);
    const angle = geometry.angle - halfAngle + ((halfAngle * 2) * ratio);
    const trajectory = buildRicochetTrajectory(
      attackerToken,
      geometry,
      angle,
      Number(geometry.elevationSlope) || 0,
      geometry.ricochet.maxReflections
    );
    const entry = getTrajectoryTargetEntries(
      attackerToken,
      trajectory,
      targetTokenUuidAllowlist
    ).find(candidate => candidate.target === target);
    if (!entry) continue;
    if (!best || entry.distance < best.distance) best = { trajectory, distance: entry.distance };
  }
  return best?.trajectory ?? null;
}

function getWallCollision(attackerToken, origin, angle, distance, targetElevation = null) {
  const maxDistance = Math.max(1, Number(distance) || 1);
  const originElevation = Number(origin?.elevation) || 0;
  const destinationElevation = Number.isFinite(Number(targetElevation)) ? Number(targetElevation) : originElevation;
  const destination = {
    x: origin.x + (Math.cos(angle) * maxDistance),
    y: origin.y + (Math.sin(angle) * maxDistance),
    elevation: destinationElevation
  };
  const collision = attackerToken?.checkCollision?.(destination, {
    origin,
    type: "sight",
    mode: "closest"
  }) ?? null;
  const collisionX = Number.isFinite(Number(collision?.x)) ? Number(collision.x) : destination.x;
  const collisionY = Number.isFinite(Number(collision?.y)) ? Number(collision.y) : destination.y;
  const point = collision
    ? {
      x: collisionX,
      y: collisionY,
      elevation: getPointElevationAtDistance(
        originElevation,
        destinationElevation,
        Math.hypot(collisionX - origin.x, collisionY - origin.y),
        maxDistance
      )
    }
    : destination;
  return {
    collision,
    point,
    distance: Math.max(0, Math.min(maxDistance, Math.hypot(point.x - origin.x, point.y - origin.y)))
  };
}

function getCollisionWallDirection(collision, incomingAngle = null) {
  const directions = [];
  for (const edge of collision?.edges ?? []) {
    const dx = Number(edge?.b?.x) - Number(edge?.a?.x);
    const dy = Number(edge?.b?.y) - Number(edge?.a?.y);
    const length = Math.hypot(dx, dy);
    if (length <= GEOMETRY_EPSILON) continue;
    let ux = dx / length;
    let uy = dy / length;
    if (ux < -GEOMETRY_EPSILON || (Math.abs(ux) <= GEOMETRY_EPSILON && uy < 0)) {
      ux *= -1;
      uy *= -1;
    }
    const lineKey = getWallLineKey({ x: ux, y: uy }, edge);
    if (!directions.some(direction => direction.lineKey === lineKey)) {
      directions.push({ x: ux, y: uy, lineKey });
    }
  }
  if (directions.length <= 1) return directions[0] ?? null;
  return selectCollisionWallDirection(directions, incomingAngle);
}

function selectCollisionWallDirection(directions = [], incomingAngle = null) {
  if (!directions.length) return null;
  const angle = Number(incomingAngle);
  if (!Number.isFinite(angle)) return directions[0] ?? null;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  return directions
    .map(direction => {
      const nx = -direction.y;
      const ny = direction.x;
      const normalContact = Math.abs((dx * nx) + (dy * ny));
      const reflected = reflectAngleAcrossWall(angle, direction);
      return {
        direction,
        normalContact,
        turn: Math.abs(normalizeAngle(reflected - angle)),
        key: getWallDirectionKey(direction)
      };
    })
    .sort((left, right) => (
      (right.normalContact - left.normalContact)
      || (left.turn - right.turn)
      || left.key.localeCompare(right.key)
    ))[0]?.direction ?? null;
}

function getWallDirectionKey(direction = {}) {
  if (direction.lineKey) return String(direction.lineKey);
  const angle = normalizeAngle(Math.atan2(Number(direction.y) || 0, Number(direction.x) || 0));
  const canonical = angle < 0 ? angle + Math.PI : angle;
  return String(Math.round(canonical * 1000));
}

function getWallLineKey(direction = {}, edge = {}) {
  const ux = Number(direction.x) || 0;
  const uy = Number(direction.y) || 0;
  const angle = normalizeAngle(Math.atan2(uy, ux));
  const canonical = angle < 0 ? angle + Math.PI : angle;
  const nx = -uy;
  const ny = ux;
  const offset = (nx * (Number(edge?.a?.x) || 0)) + (ny * (Number(edge?.a?.y) || 0));
  return `${Math.round(canonical * 1000)}:${Math.round(offset * 10)}`;
}

function reflectAngleAcrossWall(angle, wallDirection) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -wallDirection.y;
  const ny = wallDirection.x;
  const dot = (dx * nx) + (dy * ny);
  return Math.atan2(dy - (2 * dot * ny), dx - (2 * dot * nx));
}

function getTrajectoryTargetEntries(attackerToken, trajectory, targetTokenUuidAllowlist = null, {
  purpose = "preview"
} = {}) {
  const allowlist = normalizeTargetTokenUuidAllowlist(targetTokenUuidAllowlist);
  const impact = purpose === "impact";
  const isEligible = target => impact
    ? isAttackImpactTarget(target)
    : isAttackTargetVisible(target, allowlist, attackerToken);
  if (Array.isArray(trajectory?.segments) && trajectory.segments.length) {
    const byTarget = new Map();
    for (const segment of trajectory.segments) {
      for (const target of getTrajectoryTokenCandidates(segment)) {
        if (target === attackerToken || !target.actor || !isEligible(target)) continue;
        const hit = getTokenTrajectoryHit(target, segment);
        if (!hit) continue;
        const distance = (Number(segment.distanceOffset) || 0) + hit.distance;
        const current = byTarget.get(target);
        if (!current || distance < current.distance) {
          byTarget.set(target, {
            target,
            hit,
            segment,
            distance,
            reflectionCount: Math.max(0, toInteger(segment.reflectionCount))
          });
        }
      }
    }
    return Array.from(byTarget.values()).sort((left, right) => left.distance - right.distance);
  }
  return getTrajectoryTokenCandidates(trajectory)
    .filter(target => (
      target !== attackerToken
      && target.actor
      && isEligible(target)
    ))
    .map(target => ({ target, hit: getTokenTrajectoryHit(target, trajectory) }))
    .filter(entry => entry.hit && hasLineOfSight(attackerToken, entry.hit.point, trajectory.origin))
    .sort((left, right) => left.hit.distance - right.hit.distance);
}

function doesTrajectoryHitTarget(attackerToken, target, trajectory, targetTokenUuidAllowlist = null) {
  if (!target || !trajectory) return false;
  return getTrajectoryTargetEntries(
    attackerToken,
    trajectory,
    targetTokenUuidAllowlist
  ).some(entry => entry.target === target);
}

function updateTrajectoryEnd(trajectory, point) {
  const dx = point.x - trajectory.origin.x;
  const dy = point.y - trajectory.origin.y;
  trajectory.end = {
    x: point.x,
    y: point.y,
    elevation: Number.isFinite(Number(point.elevation)) ? Number(point.elevation) : getTrajectoryElevationAtDistance(trajectory, Math.hypot(dx, dy))
  };
  trajectory.angle = Math.atan2(dy, dx);
  trajectory.distance = Math.max(1, Math.hypot(dx, dy));
  trajectory.elevationSlope = (Number(trajectory.end.elevation) - (Number(trajectory.origin?.elevation) || 0)) / trajectory.distance;
}

function updateTrajectoryDistanceEnd(trajectory, point) {
  const distance = Math.max(1, getProjectedDistanceOnTrajectory(point, trajectory));
  trajectory.distance = distance;
  trajectory.end = getPointOnTrajectory(trajectory, distance);
}

function selectMissPointNearTarget(attackerToken, target, trajectory) {
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const offsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1]
  ];
  const offset = offsets[Math.floor(Math.random() * offsets.length)];
  const center = getTokenCenter(target);
  if (!center) return trajectory.end ?? getPointOnTrajectory(trajectory, trajectory.distance);
  const missPoint = {
    x: center.x + (offset[0] * gridSize) + ((Math.random() - 0.5) * gridSize * 0.8),
    y: center.y + (offset[1] * gridSize) + ((Math.random() - 0.5) * gridSize * 0.8),
    elevation: Number(center.elevation) || 0
  };
  const angle = Math.atan2(missPoint.y - trajectory.origin.y, missPoint.x - trajectory.origin.x);
  const maxDistance = Math.min(trajectory.distance, Math.hypot(missPoint.x - trajectory.origin.x, missPoint.y - trajectory.origin.y));
  return getWallClippedEndpoint(attackerToken, trajectory.origin, angle, maxDistance, missPoint.elevation).point;
}

function selectPointOnTrajectoryPastTarget(target, trajectory) {
  const range = getTokenTrajectoryIntersectionRange(target, trajectory);
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const distance = range
    ? Math.min(trajectory.distance, range.exit + (gridSize * 0.1))
    : trajectory.distance;
  return getPointOnTrajectory(trajectory, distance);
}

function getProjectedDistanceOnTrajectory(point, trajectory) {
  const dx = point.x - trajectory.origin.x;
  const dy = point.y - trajectory.origin.y;
  return Math.max(1, (dx * Math.cos(trajectory.angle)) + (dy * Math.sin(trajectory.angle)));
}

function getPointOnTrajectory(trajectory, distance) {
  const range = Math.max(0, Number(distance) || 0);
  return {
    x: trajectory.origin.x + (Math.cos(trajectory.angle) * range),
    y: trajectory.origin.y + (Math.sin(trajectory.angle) * range),
    elevation: getTrajectoryElevationAtDistance(trajectory, range)
  };
}

function getTrajectoryElevationAtDistance(trajectory, distance) {
  return (Number(trajectory?.origin?.elevation) || 0) + ((Number(trajectory?.elevationSlope) || 0) * Math.max(0, Number(distance) || 0));
}

function getPointElevationAtDistance(originElevation, targetElevation, distance, maxDistance) {
  const total = Math.max(1, Number(maxDistance) || 1);
  const t = Math.max(0, Math.min(1, (Number(distance) || 0) / total));
  return (Number(originElevation) || 0) + (((Number(targetElevation) || 0) - (Number(originElevation) || 0)) * t);
}

function getWeaponDamage(weapon, weaponFunctionId = "", context = {}) {
  const actor = getWeaponOwnerActor(weapon);
  const weaponData = getEffectiveWeaponDamageData(weapon, weaponFunctionId);
  const formulaDamage = getWeaponDamagePercentBase(weapon, weaponFunctionId);
  const contextualDamage = getContextualCombatValues(actor, ["damageFlat", "damagePercent"], context);
  const flatDamage = contextualDamage.damageFlat;
  const skillKey = String(getWeaponAttackData(weapon, weaponFunctionId)?.skillKey ?? "");
  const skillDamageBonuses = getWeaponSkillDamageBonuses(actor, skillKey);
  const attackPowerDamagePercent = toInteger(weaponData?.attackPowerDamagePercent);
  const damagePercent = attackPowerDamagePercent
    + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "damage")
    + contextualDamage.damagePercent
    + skillDamageBonuses.percent
    + getWeaponAttackModifierDamagePercentModifier(context?.attackModifier);
  const modifiedDamage = Math.round(formulaDamage * Math.max(0, 100 + damagePercent) / 100)
    + flatDamage
    + skillDamageBonuses.flat;
  return Math.max(0, Math.floor(modifiedDamage * getWeaponConditionWeakeningRatio(weapon)));
}

function getWeaponDamagePercentBase(weapon, weaponFunctionId = "") {
  const weaponData = getEffectiveWeaponDamageData(weapon, weaponFunctionId);
  return evaluateWeaponFormula(weapon, weaponData?.damage, {
    minimum: 0,
    context: `${weapon?.name ?? "weapon"} damage`
  });
}

function getWeaponResourceCosts(weaponData = {}, { modifierState = null } = {}) {
  const costs = Array.isArray(weaponData?.resourceCosts)
    ? foundry.utils.deepClone(weaponData.resourceCosts)
    : [];
  if (String(weaponData?.damageMode ?? "manual") === "source"
    && !costs.some(cost => String(cost?.type ?? "") === "magazine")) {
    costs.push({ type: "magazine", amount: 1 });
  }
  if (!modifierState) return costs;
  return costs.map(cost => {
    const type = String(cost?.type ?? "").trim();
    const multiplier = typeof modifierState.getResourceCostMultiplier === "function"
      ? modifierState.getResourceCostMultiplier(type)
      : 1;
    return {
      ...cost,
      amount: Math.max(0, Math.ceil(toInteger(cost?.amount) * Math.max(0, Number(multiplier) || 0)))
    };
  });
}

function getVolleyDamageRadius(weapon, weaponFunctionId = "") {
  return evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.volley?.damageRadius, {
    minimum: 0,
    context: "volley damage radius"
  });
}

function getVolleyExplosionDelaySeconds(weapon, weaponFunctionId = "") {
  return evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.volley?.regionDelaySeconds, {
    minimum: 0,
    context: "volley explosion delay"
  });
}

function buildDelayedVolleyExplosionRegionRequest({
  sceneId = "",
  delayedThrownItemId = "",
  attackId = "",
  explodeAtWorldTime = 0,
  weapon = null,
  weaponFunctionId = "",
  actionKey = "",
  attackerToken = null,
  finalGeometries = [],
  blastOutcomes = [],
  baseDamage = 0,
  damageContext = null,
  stealthAttack = false,
  actionPointCost = 0,
  actionPointCostApplied = false,
  actionPointSpendReceipt = null,
  resolveWeaponNoiseAtImpact = false,
  weaponNoiseLevel = 0,
  preventStealthDetection = false,
  keepAwayEntries = [],
  suppressGuardianAngelReaction = false,
  chainRef = null,
  damageHubOperationRef = "",
  impactConditionWearMultiplier = 0,
  attachmentTokenId = ""
} = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const damageTypes = getWeaponDamageTypeEntries(weapon, weaponFunctionId);
  const resolvedDamageContext = damageContext && typeof damageContext === "object"
    ? damageContext
    : {
      actorToken: attackerToken,
      weaponActionKey: actionKey,
      weaponData,
      weaponFunctionId
    };
  const fixedDistanceContext = normalizeAttackDistanceContext(
    blastOutcomes.find(entry => normalizeAttackDistanceContext(entry).attackDistanceMeters !== null)
      ?? resolvedDamageContext
  );
  const regionSettings = getVolleyRegionSettings(weapon, weaponFunctionId);
  const residualRegion = regionSettings.enabled
    ? {
      name: weapon?.name
        ? `${weapon.name}: ${game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.RegionName")}`
        : game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.RegionName"),
      radiusPixels: metersToPixels(regionSettings.radiusMeters),
      color: getVolleyRegionColor(regionSettings.damageEntries),
      damageEntries: regionSettings.damageEntries,
      regionSpecialProperties: regionSettings.regionSpecialProperties,
      durationSeconds: regionSettings.durationSeconds,
      radiusDeltaMeters: regionSettings.radiusDeltaMeters
    }
    : null;
  const attackerActor = attackerToken?.actor ?? getWeaponOwnerActor(weapon);
  const penetrationBasePower = getWeaponPenetrationBaseValue(weapon, weaponFunctionId, {
    actor: attackerActor,
    actionKey
  });
  const explosions = finalGeometries.map((geometry, index) => {
    const outcomeBaseDamage = Number(blastOutcomes[index]?.baseDamage);
    const normalizedBaseDamage = Number.isFinite(outcomeBaseDamage)
      ? Math.max(0, outcomeBaseDamage)
      : Math.max(0, Number(baseDamage) || 0);
    const outcome = blastOutcomes[index]?.outcome;
    const blastDistanceContext = normalizeAttackDistanceContext(blastOutcomes[index]);
    const explosionDistanceContext = blastDistanceContext.attackDistanceMeters === null
      ? fixedDistanceContext
      : blastDistanceContext;
    const snapshotContext = {
      ...resolvedDamageContext,
      ...explosionDistanceContext
    };
    const damageContextSnapshot = {
      damageFlat: createDelayedVolleyCombatValueSnapshot(
        attackerActor,
        "damageFlat",
        snapshotContext
      ),
      damagePercent: createDelayedVolleyCombatValueSnapshot(
        attackerActor,
        "damagePercent",
        snapshotContext
      )
    };
    const criticalDamageContextSnapshot = createDelayedVolleyCombatValueSnapshot(
      attackerActor,
      "criticalDamagePercent",
      snapshotContext
    );
    const penetrationContextSnapshot = createDelayedVolleySourceContextSnapshot(
      attackerActor,
      `${ACTION_PENETRATION_KEY_PREFIX}${String(actionKey ?? "").trim()}`,
      {
        ...snapshotContext,
        alternateKeys: [ALL_ACTION_PENETRATION_KEY],
        baseValue: penetrationBasePower,
        weaponActionKey: String(actionKey ?? ""),
        weaponData
      }
    );
    const penetrationPower = Math.max(0, Math.trunc(Number(penetrationContextSnapshot.sourceValue) || 0));
    const criticalDamageSnapshot = getCriticalDamageSnapshot(
      weapon,
      outcome,
      weaponFunctionId,
      snapshotContext
    );
    return {
      center: serializePoint(geometry.end),
      ...explosionDistanceContext,
      radiusPixels: Math.max(1, Number(geometry.radiusPixels) || 1),
      damageAmount: applyCriticalDamageSnapshot(normalizedBaseDamage, criticalDamageSnapshot),
      damageBaseAmount: normalizedBaseDamage,
      criticalDamageSnapshot,
      criticalDamageContextSnapshot,
      damageContextSnapshot,
      damagePercentBaseAmount: getWeaponDamagePercentBase(weapon, weaponFunctionId),
      pelletCount: getWeaponPelletCount(weapon, weaponFunctionId),
      damageTypes,
      penetrationPower,
      penetrationBasePower,
      penetrationContextSnapshot,
      residualRegion
    };
  });
  const dominantDamageTypeKey = [...damageTypes]
    .sort((left, right) => right.weight - left.weight)
    .at(0)?.key;
  const dominantDamageType = getDamageTypeSettings()
    .find(type => type.key === dominantDamageTypeKey);

  return {
    sceneId,
    delayedThrownItemId,
    explodeAtWorldTime,
    attachmentTokenId: String(attachmentTokenId ?? ""),
    name: weapon?.name ? `${weapon.name}: отложенный взрыв` : "Отложенный взрыв",
    color: dominantDamageType?.color ?? "#dd8431",
    explosions,
    source: {
      attackId: String(attackId ?? ""),
      attackerUuid: attackerToken?.actor?.uuid ?? "",
      attackerTokenId: attackerToken?.id ?? "",
      attackerTokenUuid: attackerToken?.document?.uuid ?? "",
      weaponUuid: weapon?.uuid ?? "",
      weaponName: weapon?.name ?? "",
      weaponFunctionId,
      actionKey,
      stealthAttack: Boolean(stealthAttack),
      actionPointCost: Math.max(0, toInteger(actionPointCost)),
      actionPointCostApplied: Boolean(actionPointCostApplied),
      actionPointSpendReceipt: actionPointSpendReceipt
        ? foundry.utils.deepClone(actionPointSpendReceipt)
        : null,
      resolveWeaponNoiseAtImpact: Boolean(resolveWeaponNoiseAtImpact),
      weaponNoiseLevel: getWeaponNoiseLevel({ noiseLevel: weaponNoiseLevel }),
      preventStealthDetection: Boolean(preventStealthDetection),
      keepAwayEntries: Array.isArray(keepAwayEntries)
        ? foundry.utils.deepClone(keepAwayEntries)
        : [],
      suppressGuardianAngelReaction: Boolean(suppressGuardianAngelReaction),
      chainRef,
      damageHubOperationRef: String(damageHubOperationRef ?? ""),
      impactConditionWearMultiplier: Math.max(0, toInteger(impactConditionWearMultiplier)),
      weaponData: foundry.utils.deepClone(weaponData)
    }
  };
}

function getVolleyRegionSettings(weapon, weaponFunctionId = "") {
  const volley = getWeaponAttackData(weapon, weaponFunctionId)?.volley ?? {};
  const radiusMeters = evaluateWeaponFormula(weapon, volley.regionRadius, {
    minimum: 0,
    context: "volley region radius"
  });
  const damageEntries = getVolleyRegionDamageEntries(volley, weapon);
  const actor = getWeaponOwnerActor(weapon);
  const evaluateSmokeFormula = value => {
    const direct = Number(value);
    if (Number.isFinite(direct)) return direct;
    try {
      return evaluateFormula(String(value ?? "0"), buildActorFormulaData(actor));
    } catch (_error) {
      // Keep the established evaluator and its safe fallback for unsupported references.
    }
    return weapon?.type === "ability"
      ? evaluateAbilityAttackFormula(value, actor, { minimum: 0, context: "volley smoke" })
      : evaluateActorFormula(value, actor, { minimum: 0, context: "volley smoke" });
  };
  const regionSpecialProperties = resolveRegionSpecialProperties(
    volley.regionSpecialProperties,
    evaluateSmokeFormula
  );
  const durationSeconds = evaluateWeaponFormula(weapon, volley.regionDurationSeconds, {
    minimum: 0,
    context: "volley region duration"
  });
  const radiusDeltaMeters = evaluateWeaponFormula(weapon, volley.regionRadiusDeltaMeters, {
    context: "volley region radius delta"
  });
  return {
    enabled: radiusMeters > 0 && durationSeconds > 0,
    radiusMeters,
    damageEntries,
    regionSpecialProperties,
    durationSeconds,
    radiusDeltaMeters
  };
}

function getVolleyRegionDamageEntries(volley = {}, weapon = null) {
  const entries = Array.isArray(volley.regionDamageEntries) ? volley.regionDamageEntries : [];
  const actor = getWeaponOwnerActor(weapon);
  return entries
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      amount: weapon?.type === "ability"
        ? evaluateAbilityAttackFormula(entry?.amount, actor, {
          minimum: 0,
          context: "volley region damage"
        })
        : evaluateActorFormula(entry?.amount, actor, {
          minimum: 0,
          context: "volley region damage"
        })
    }))
    .filter(entry => entry.damageTypeKey && entry.amount > 0);
}

function getVolleyRegionColor(damageEntries = []) {
  if (!damageEntries.length) return "#8a8a8a";
  const damageTypes = getDamageTypeSettings();
  const dominant = [...damageEntries]
    .sort((left, right) => (Number(right.amount) || 0) - (Number(left.amount) || 0))
    .at(0);
  return damageTypes.find(type => type.key === dominant?.damageTypeKey)?.color ?? "#dd8431";
}

function computeVolleyBlastCenter({ attackerToken = null, intendedCenter = null, radiusPixels = 0, outcome = null } = {}) {
  const origin = getTokenAimPoint(attackerToken);
  if (!origin) return serializePoint(intendedCenter);
  const target = serializePoint(intendedCenter);
  const radius = Math.max(1, Number(radiusPixels) || 1);
  const resultKey = String(outcome?.result?.key ?? "");
  const rollMaximum = Math.max(1, toInteger(outcome?.resultProfile?.maximum) || 100);
  const roll = Math.max(1, Math.min(rollMaximum, toInteger(outcome?.selectedRoll?.total) || Math.ceil(rollMaximum / 2)));
  const rollQualityValue = outcome?.resultProfile?.rollDirection === "low"
    ? (rollMaximum - roll) + 1
    : roll;
  const difficulty = Math.max(1, toInteger(outcome?.check?.difficulty) || BASE_VOLLEY_DIFFICULTY);
  const total = Math.max(0, toInteger(outcome?.total));
  const baseAngle = Math.atan2(target.y - origin.y, target.x - origin.x);
  const margin = Number.isFinite(Number(outcome?.resolutionMargin))
    ? Number(outcome.resolutionMargin)
    : total - difficulty;
  const successQuality = Math.max(0, Math.min(1, (Math.max(0, margin) + rollQualityValue) / (rollMaximum + 60)));
  const missSeverity = Math.max(0, Math.min(1, ((Math.max(0, -margin) / Math.max(25, difficulty)) * 0.7)
    + (((rollMaximum - rollQualityValue) / rollMaximum) * 0.3)));
  const criticalFailure = resultKey === "criticalFailure";
  let candidate = target;

  if (resultKey === "success") {
    const maxOffset = radius * (0.08 + (0.62 * (1 - successQuality)));
    candidate = addPolar(target, Math.random() * Math.PI * 2, maxOffset * Math.sqrt(Math.random()));
  } else if (resultKey === "failure" || resultKey === "criticalFailure") {
    candidate = computeVolleyMissCenter({
      origin,
      target,
      baseAngle,
      radius,
      severity: criticalFailure ? Math.min(1, missSeverity + 0.2) : missSeverity,
      minSourceDistance: criticalFailure ? radius * 0.5 : radius + metersToPixels(5)
    });
  }

  const finalAngle = Math.atan2(candidate.y - origin.y, candidate.x - origin.x);
  const finalDistance = Math.max(1, Math.hypot(candidate.x - origin.x, candidate.y - origin.y));
  return getWallClippedEndpoint(attackerToken, origin, finalAngle, finalDistance, candidate.elevation).point;
}

function computeVolleyMissCenter({ origin, target, baseAngle, radius, severity = 0.5, minSourceDistance = 0 } = {}) {
  const minTargetDistance = (radius * 2) + 1;
  const maxTargetDistance = radius * (2.4 + (1.6 * Math.max(0, Math.min(1, severity))));
  const isValid = point => (
    Math.hypot(point.x - target.x, point.y - target.y) > minTargetDistance
    && Math.hypot(point.x - origin.x, point.y - origin.y) >= minSourceDistance
  );

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const roll = Math.random();
    const mode = roll < 0.42 ? "undershoot" : roll < 0.58 ? "overshoot" : "lateral";
    const point = buildVolleyMissCandidate(target, baseAngle, radius, maxTargetDistance, mode);
    if (isValid(point)) return point;
  }

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const point = addPolar(
      target,
      Math.random() * Math.PI * 2,
      randomRange(minTargetDistance, maxTargetDistance + radius)
    );
    if (isValid(point)) return point;
  }

  return addPolar(target, baseAngle, minTargetDistance + radius);
}

function buildVolleyMissCandidate(target, baseAngle, radius, maxDistance, mode) {
  const distance = randomRange((radius * 2) + 1, maxDistance);
  if (mode === "undershoot") {
    return addPolar(target, baseAngle + Math.PI + randomRange(-0.75, 0.75), distance);
  }
  if (mode === "overshoot") {
    return addPolar(target, baseAngle + randomRange(-0.65, 0.65), distance);
  }
  const side = Math.random() < 0.5 ? -1 : 1;
  return addPolar(target, baseAngle + (side * (Math.PI / 2 + randomRange(-0.9, 0.9))), distance);
}

function addPolar(point, angle, distance) {
  const result = {
    x: point.x + (Math.cos(angle) * distance),
    y: point.y + (Math.sin(angle) * distance)
  };
  if (Number.isFinite(Number(point?.elevation))) result.elevation = Number(point.elevation);
  return result;
}

function randomRange(min, max) {
  const low = Math.min(Number(min) || 0, Number(max) || 0);
  const high = Math.max(Number(min) || 0, Number(max) || 0);
  return low + (Math.random() * (high - low));
}

function getVolleyDamageFalloff(target, geometry) {
  const radius = Math.max(1, Number(geometry?.radiusPixels) || 1);
  const distance = getTokenVolleyDistanceToHitboxEdge(target, geometry);
  const ratio = Math.max(0, Math.min(1, distance / radius));
  return Math.max(0.2, 1 - (0.8 * ratio));
}

function getTokenVolleyDistanceToHitboxEdge(token, geometry) {
  const closest = getClosestPointOnTokenVolume(token, geometry?.end);
  if (!closest) return Infinity;
  return getSphericalDistancePixels(geometry.end, closest);
}

function isTokenInVolleyPlanarRadius(token, geometry) {
  const radius = Math.max(0, Number(geometry?.radiusPixels) || 0);
  if (radius <= 0) return false;
  return getTokenVolleyPlanarDistanceToHitboxEdge(token, geometry) <= radius + GEOMETRY_EPSILON;
}

function getTokenVolleyPlanarCenterDistance(token, geometry) {
  const center = getTokenCenter(token);
  if (!center || !geometry?.end) return Infinity;
  return Math.hypot(center.x - geometry.end.x, center.y - geometry.end.y);
}

function getTokenVolleyPlanarDistanceToHitboxEdge(token, geometry) {
  if (!geometry?.end) return Infinity;
  const polygon = getTokenWorldPolygon(token);
  const points = getPolygonPointObjects(polygon);
  if (points.length < 3) return Infinity;
  const closest = getClosestPointOnPolygon(points, geometry.end, polygon);
  return closest ? Math.hypot(closest.x - geometry.end.x, closest.y - geometry.end.y) : Infinity;
}

function getWeaponDamageTypeEntries(weapon, weaponFunctionId = "") {
  const effectiveDamageData = getEffectiveWeaponDamageData(weapon, weaponFunctionId);
  if (effectiveDamageData?.source === "damageSource") {
    const entries = Array.isArray(effectiveDamageData.damageTypes)
      ? effectiveDamageData.damageTypes
        .map(entry => ({
          key: String(entry?.key ?? "").trim(),
          weight: Math.max(0, toInteger(entry?.percent))
        }))
        .filter(entry => entry.key && entry.weight > 0)
      : [];
    if (entries.length) return entries;
    return [{ key: String(effectiveDamageData.damageTypeKey ?? "").trim() || "firearm", weight: 100 }];
  }

  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const sourceWeaponData = getWeaponAttackSourceData(weapon, weaponFunctionId);
  const hasConfiguredDamageTypes = Object.hasOwn(sourceWeaponData, "damageTypes");
  const entries = hasConfiguredDamageTypes && Array.isArray(weaponData.damageTypes)
    ? weaponData.damageTypes
      .map(entry => ({
        key: String(entry?.key ?? "").trim(),
        weight: Math.max(0, toInteger(entry?.percent))
      }))
      .filter(entry => entry.key && entry.weight > 0)
    : [];
  if (entries.length) return entries;
  const fallback = String(weaponData.damageTypeKey ?? "").trim() || "firearm";
  return [{ key: fallback, weight: 100 }];
}

function normalizeExplosionDamageTypes(entries = []) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map(entry => ({
      key: String(entry?.key ?? entry?.damageTypeKey ?? "").trim(),
      weight: Math.max(0, Number(entry?.weight ?? entry?.percent) || 0)
    }))
    .filter(entry => entry.key && entry.weight > 0);
  return normalized.length ? normalized : [{ key: "firearm", weight: 100 }];
}

function getEffectiveWeaponDamageData(weapon, weaponFunctionId = "") {
  return getWeaponAttackData(weapon, weaponFunctionId);
}

function getWeaponMagazineSourceItem(weaponData = {}) {
  const uuid = String(weaponData?.magazine?.sourceItemUuid ?? "").trim();
  if (!uuid) return null;
  return resolveWorldItemSync(uuid);
}

function buildWeaponDamageRequests(weapon, {
  attackerActor = null,
  attackerToken = null,
  actor = null,
  targetToken = null,
  modifierState = null,
  penetrationPower = null,
  limbKey = "",
  amount = 0,
  scope = "healthAndLimb",
  source = {}
} = {}, weaponFunctionId = "") {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const distanceContext = getWeaponDamageDistanceContext({
    source,
    weaponData,
    attackerActor,
    attackerToken,
    targetToken
  });
  const damageTypes = getWeaponDamageTypeEntries(weapon, weaponFunctionId);
  const amounts = distributeIntegerAmount(amount, damageTypes.map(entry => entry.weight));
  const hasExplicitPenetrationPower = penetrationPower !== null
    && penetrationPower !== undefined
    && penetrationPower !== ""
    && Number.isFinite(Number(penetrationPower));
  const resolvedPenetrationPower = hasExplicitPenetrationPower
    ? Math.max(0, Math.trunc(Number(penetrationPower)))
    : getWeaponPenetrationPower(weapon, weaponFunctionId, {
      actor: attackerActor,
      actorToken: attackerToken,
      actionKey: source.actionKey,
      targetActor: actor,
      targetToken,
      weaponData,
      weaponActionModifierState: modifierState,
      limbKey,
      reflectionCount: Math.max(0, toInteger(source.reflectionCount)),
      ...distanceContext,
      chanceOperationId: getActiveUseOperationId(source)
    });
  const damagePacketId = String(source.damagePacketId ?? "").trim()
    || String(source.conditionWearPacketId ?? "").trim()
    || foundry.utils.randomID();
  const mitigationIgnore = modifierState?.getOption?.("targetMitigationIgnore") ?? {};
  const requestSource = {
    ...source,
    damagePacketId,
    conditionWearPacketId: String(source.conditionWearPacketId ?? "").trim() || damagePacketId,
    weaponFunctionId: source.weaponFunctionId ?? weaponFunctionId,
    weaponData: foundry.utils.deepClone(source.weaponData ?? weaponData ?? {}),
    targetTokenUuid: source.targetTokenUuid ?? targetToken?.document?.uuid ?? targetToken?.uuid ?? "",
    ...distanceContext,
    penetrationPower: resolvedPenetrationPower,
    targetDefenseIgnorePercent: Math.max(0, Math.min(100, Number(mitigationIgnore.defenseIgnorePercent) || 0)),
    targetResistanceIgnorePercent: Math.max(0, Math.min(100, Number(mitigationIgnore.resistanceIgnorePercent) || 0))
  };
  return damageTypes
    .map((entry, index) => ({
      actor,
      limbKey,
      amount: amounts[index] ?? 0,
      damageTypeKey: entry.key,
      scope,
      source: requestSource
    }))
    .filter(request => request.amount > 0);
}

function buildWeaponConditionDamageRequests(weapon, {
  attackerActor = null,
  attackerToken = null,
  actor = null,
  targetToken = null,
  targetItem = null,
  modifierState = null,
  penetrationPower = null,
  limbKey = "",
  amount = 0,
  source = {}
} = {}, weaponFunctionId = "") {
  if (!targetItem?.id || !hasItemFunction(targetItem, ITEM_FUNCTIONS.condition)) return [];
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const distanceContext = getWeaponDamageDistanceContext({
    source,
    weaponData,
    attackerActor,
    attackerToken,
    targetToken
  });
  const damageTypes = getWeaponDamageTypeEntries(weapon, weaponFunctionId);
  const amounts = distributeIntegerAmount(amount, damageTypes.map(entry => entry.weight));
  const hasExplicitPenetrationPower = penetrationPower !== null
    && penetrationPower !== undefined
    && penetrationPower !== ""
    && Number.isFinite(Number(penetrationPower));
  const resolvedPenetrationPower = hasExplicitPenetrationPower
    ? Math.max(0, Math.trunc(Number(penetrationPower)))
    : getWeaponPenetrationPower(weapon, weaponFunctionId, {
      actor: attackerActor,
      actorToken: attackerToken,
      actionKey: source.actionKey,
      targetActor: actor,
      targetToken,
      weaponData,
      weaponActionModifierState: modifierState,
      limbKey,
      reflectionCount: Math.max(0, toInteger(source.reflectionCount)),
      ...distanceContext,
      chanceOperationId: getActiveUseOperationId(source)
    });
  const damagePacketId = String(source.damagePacketId ?? "").trim()
    || String(source.conditionWearPacketId ?? "").trim()
    || foundry.utils.randomID();
  const requestSource = {
    ...source,
    damagePacketId,
    conditionWearPacketId: String(source.conditionWearPacketId ?? "").trim() || damagePacketId,
    weaponFunctionId: source.weaponFunctionId ?? weaponFunctionId,
    weaponData: foundry.utils.deepClone(source.weaponData ?? weaponData ?? {}),
    targetTokenUuid: source.targetTokenUuid ?? targetToken?.document?.uuid ?? targetToken?.uuid ?? "",
    ...distanceContext,
    penetrationPower: resolvedPenetrationPower,
    targetItemUuid: targetItem.uuid
  };
  return damageTypes
    .map((entry, index) => ({
      actor,
      limbKey,
      itemId: targetItem.id,
      amount: amounts[index] ?? 0,
      damageTypeKey: entry.key,
      scope: "itemCondition",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source: requestSource
    }))
    .filter(request => request.amount > 0);
}

function getWeaponDamageDistanceContext({
  source = {},
  weaponData = null,
  attackerActor = null,
  attackerToken = null,
  targetToken = null
} = {}) {
  const supplied = normalizeAttackDistanceContext(source);
  const directDistance = attackerToken && targetToken
    ? getTokenDistanceMeters(attackerToken, targetToken)
    : null;
  const attackDistanceMeters = supplied.attackDistanceMeters !== null
    ? supplied.attackDistanceMeters
    : Number.isFinite(directDistance)
    ? Math.max(0, directDistance)
    : null;
  const effectiveRange = supplied.effectiveRange
    ?? getEffectiveRangeBounds(weaponData?.effectiveRange, attackerActor, {
      ...source,
      actorToken: attackerToken,
      targetToken,
      targetActor: targetToken?.actor ?? null,
      weaponData,
      attackDistanceMeters
    });
  return { attackDistanceMeters, effectiveRange };
}

function distributeIntegerAmount(amount, weights = []) {
  const totalAmount = Math.max(0, Math.round(Number(amount) || 0));
  if (!totalAmount || !weights.length) return weights.map(() => 0);
  const normalizedWeights = weights.map(weight => Math.max(0, Number(weight) || 0));
  let totalWeight = normalizedWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    normalizedWeights.fill(1);
    totalWeight = normalizedWeights.length;
  }

  const shares = normalizedWeights.map((weight, index) => {
    const exact = (totalAmount * weight) / totalWeight;
    const whole = Math.floor(exact);
    return {
      index,
      whole,
      remainder: exact - whole
    };
  });
  let remaining = totalAmount - shares.reduce((sum, share) => sum + share.whole, 0);
  [...shares]
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    .forEach(share => {
      if (remaining <= 0) return;
      share.whole += 1;
      remaining -= 1;
    });
  return [...shares].sort((left, right) => left.index - right.index).map(share => share.whole);
}

function estimateDamageRequestGroup(requests = [], actor = null) {
  return estimateDamageApplicationsBatch(actor, requests);
}

function doesDamageRequestGroupPenetratePart(requests = [], actor = null, targetSelection = null) {
  const relevantRequests = (Array.isArray(requests) ? requests : [requests])
    .filter(request => isDamageRequestForTargetSelection(request, targetSelection));
  const estimate = estimateDamageRequestGroup(relevantRequests, actor);
  const max = getTargetSelectionConditionMax(actor, targetSelection);
  if (max <= 0 || estimate.partDamage <= 0) return false;
  const remainingPenetration = Math.max(0, toInteger(estimate.penetrationRemainder));
  const requiredPercent = Math.max(0, 50 - remainingPenetration);
  const threshold = Math.ceil(max * requiredPercent / 100);
  return estimate.partDamage >= threshold;
}

function getDamageRequestGroupPenetrationPower(requests = [], fallback = 0) {
  const values = (Array.isArray(requests) ? requests : [requests])
    .map(request => Number(request?.source?.penetrationPower))
    .filter(Number.isFinite)
    .map(value => Math.max(0, Math.trunc(value)));
  if (values.length) return Math.min(...values);
  return Math.max(0, toInteger(fallback));
}

function isDamageRequestForTargetSelection(request = {}, targetSelection = null) {
  if (targetSelection?.type === "weapon") {
    const itemId = String(targetSelection.item?.id ?? "").trim();
    return itemId && String(request.itemId ?? request.targetItemId ?? request.source?.targetItemId ?? "").trim() === itemId;
  }
  const limbKey = String(targetSelection?.limbKey ?? "").trim();
  if (!limbKey) return false;
  return String(request.limbKey ?? "").trim() === limbKey && String(request.scope ?? "") !== "itemCondition";
}

function getTargetSelectionConditionMax(actor = null, targetSelection = null) {
  if (targetSelection?.type === "weapon") {
    const condition = getConditionFunction(targetSelection.item);
    return Math.max(0, toInteger(condition.max));
  }
  const limbKey = String(targetSelection?.limbKey ?? "").trim();
  if (!limbKey) return 0;
  return Math.max(0, toInteger(actor?.system?.limbs?.[limbKey]?.max));
}

function getSingleDamageRequestLimbKey(requests = []) {
  return String((Array.isArray(requests) ? requests : [requests]).find(request => request?.limbKey)?.limbKey ?? "").trim();
}

function getWeaponCriticalCheckModifiers(weapon, weaponFunctionId = "", context = {}) {
  const actor = getWeaponOwnerActor(weapon);
  const stealth = getStealthAttackModifiers(actor);
  const modifier = evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.criticalChanceModifier, {
    minimum: -Infinity,
    context: "critical chance"
  })
    + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "criticalChance")
    + getContextualCombatValue(actor, "criticalChance", context)
    + getWeaponAttackModifierCriticalChanceModifier(context?.attackModifier)
    + stealth.criticalChanceBonus
    - getWeaponConditionCritChancePenalty(weapon);
  return {
    criticalSuccessBonus: Math.max(0, modifier),
    criticalFailureBonus: Math.max(0, -modifier)
  };
}

function getCriticalDamageAmount(weapon, amount, outcome, weaponFunctionId = "", explicitContext = {}) {
  return applyCriticalDamageSnapshot(amount,
    getCriticalDamageSnapshot(weapon, outcome, weaponFunctionId, explicitContext));
}

function getCriticalDamageSnapshot(weapon, outcome, weaponFunctionId = "", explicitContext = {}) {
  const actor = getWeaponOwnerActor(weapon);
  const stealth = getStealthAttackModifiers(actor);
  const criticalSuccess = isCriticalSuccessAttack(outcome);
  const context = {
    ...(outcome && typeof outcome === "object" ? outcome : {}),
    ...(outcome?.check && typeof outcome.check === "object" ? outcome.check : {}),
    ...(explicitContext && typeof explicitContext === "object" ? explicitContext : {})
  };
  const criticalDamagePercent = criticalSuccess
    ? Math.max(0, evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.criticalDamagePercent, {
      fallback: 150,
      minimum: 0,
      context: "critical damage percent"
    })
      + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "criticalDamage")
      + getContextualCombatValue(actor, "criticalDamagePercent", context)
      + stealth.criticalDamageBonusPercent)
    : 100;
  return {
    stealthDamageBonusPercent: Math.max(0, toInteger(stealth.damageBonusPercent)),
    criticalSuccess,
    criticalDamagePercent
  };
}

function applyCriticalDamageSnapshot(amount, snapshot = {}) {
  const baseAmount = Math.max(0, Number(amount) || 0);
  const stealthDamage = calculateStealthDamageBonusAmount(
    baseAmount,
    snapshot.stealthDamageBonusPercent
  );
  const modifiedBaseAmount = baseAmount + stealthDamage;
  if (snapshot.criticalSuccess !== true) return modifiedBaseAmount;
  return Math.round(modifiedBaseAmount * Math.max(0, Number(snapshot.criticalDamagePercent) || 0) / 100);
}

function getCriticalFailureResourceCosts(weapon, actionKey, weaponFunctionId = "") {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const availableCosts = new Set(
    getWeaponResourceCosts(weaponData)
      .map(getWeaponResourceCostIdentity)
      .filter(Boolean)
  );
  return (weaponData?.[actionKey]?.criticalFailureConsequences ?? [])
    .filter(consequence => String(consequence?.type ?? "") === "extraResourceCost")
    .map(consequence => ({
      type: String(consequence?.resourceType ?? ""),
      resourceKey: String(consequence?.resourceKey ?? "").trim(),
      amount: Math.max(0, toInteger(consequence?.amount))
    }))
    .filter(consequence => (
      consequence.amount > 0
      && availableCosts.has(getWeaponResourceCostIdentity(consequence))
    ));
}

function isAttackTargetVisible(target, targetTokenUuidAllowlist = null, attackerToken = null) {
  if (!target?.actor) return false;
  if (target === attackerToken) return true;
  if (!isAttackImpactTarget(target)) return false;
  const allowlist = normalizeTargetTokenUuidAllowlist(targetTokenUuidAllowlist);
  if (allowlist !== null) return allowlist.has(getTokenDocumentUuid(target));
  if (!attackerToken?.actor) return Boolean(target?.visible);
  if (canvas.visibility?.tokenVision === false) return true;

  const visionSource = attackerToken.vision;
  const createConfig = canvas.visibility?._createVisibilityTestConfig;
  const getTestPoints = target.document?.getVisibilityTestPoints;
  if (!visionSource?.active || typeof createConfig !== "function" || typeof getTestPoints !== "function") {
    return Boolean(target.visible);
  }

  const config = createConfig.call(
    canvas.visibility,
    getTestPoints.call(target.document),
    { tolerance: 0, object: target }
  );
  const modes = globalThis.CONFIG?.Canvas?.detectionModes ?? {};
  const sourceModes = visionSource.object?.document?.detectionModes ?? {};
  if (!visionSource.isBlinded) {
    const basicMode = sourceModes.basicSight;
    if (basicMode && modes.basicSight?.testVisibility?.(visionSource, basicMode, config) === true) return true;
    const lightMode = sourceModes.lightPerception;
    if (lightMode && modes.lightPerception?.testVisibility?.(visionSource, lightMode, config) === true) return true;
  }
  for (const [id, mode] of Object.entries(sourceModes)) {
    if (id === "basicSight" || id === "lightPerception") continue;
    if (modes[id]?.testVisibility?.(visionSource, mode, config) === true) return true;
  }
  return false;
}

function isAttackImpactTarget(target) {
  if (!isTokenPlaceableAvailable(target) || !target?.actor || target?.document?.hidden === true) return false;
  const secretDisposition = globalThis.CONST?.TOKEN_DISPOSITIONS?.SECRET;
  return secretDisposition === undefined || target.document?.disposition !== secretDisposition;
}

function getUnseenAttackEdgeModifiers(target, targetTokenUuidAllowlist = null, attackerToken = null) {
  if (!target?.actor || isAttackTargetVisible(target, targetTokenUuidAllowlist, attackerToken)) return {};
  return {
    disadvantage: true,
    disadvantageCount: UNAIMED_ATTACK_DISADVANTAGE_COUNT
  };
}

function mergeAttackEdgeModifiers(...modifiers) {
  const entries = modifiers.filter(entry => entry && typeof entry === "object");
  const result = Object.assign({}, ...entries);
  const advantageCount = entries.reduce((total, entry) => (
    total + Math.max(0, toInteger(entry.advantageCount ?? (entry.advantage ? 1 : 0)))
  ), 0);
  const disadvantageCount = entries.reduce((total, entry) => (
    total + Math.max(0, toInteger(entry.disadvantageCount ?? (entry.disadvantage ? 1 : 0)))
  ), 0);
  if (advantageCount > 0) {
    result.advantage = true;
    result.advantageCount = advantageCount;
  }
  if (disadvantageCount > 0) {
    result.disadvantage = true;
    result.disadvantageCount = disadvantageCount;
  }
  return result;
}

function getEffectiveRangeDifficultyBonus(weapon, attackerToken, target, weaponFunctionId = "", context = {}) {
  const weaponData = context?.weaponData ?? getWeaponAttackData(weapon, weaponFunctionId);
  const contextualDistance = Number(context?.attackDistanceMeters);
  const distanceMeters = context?.attackDistanceMeters !== null
    && context?.attackDistanceMeters !== ""
    && Number.isFinite(contextualDistance)
    ? Math.max(0, contextualDistance)
    : getTokenDistanceMeters(attackerToken, target);
  return getEffectiveRangeDifficultyBonusForDistance(
    weaponData,
    distanceMeters,
    attackerToken?.actor ?? null,
    {
      ...context,
      actorToken: context?.actorToken ?? attackerToken,
      targetToken: context?.targetToken ?? target,
      weaponData,
      attackDistanceMeters: distanceMeters,
      effectiveRange: Object.hasOwn(context ?? {}, "effectiveRange")
        ? context.effectiveRange
        : getEffectiveRangeBounds(weaponData?.effectiveRange, attackerToken?.actor ?? null, {
          ...context,
          actorToken: attackerToken,
          targetToken: target,
          weaponData,
          attackDistanceMeters: distanceMeters
        })
    }
  );
}

function getPostureAttackEdgeModifiers({
  attackerToken = null,
  targetToken = null,
  weapon = null,
  actionKey = "",
  weaponFunctionId = ""
} = {}) {
  if (!isVulnerableAttackPosture(getTokenAttackPosture(targetToken))) return {};

  const rangeState = getConfiguredEffectiveRangeState(weapon, attackerToken, targetToken, actionKey, weaponFunctionId);
  if (rangeState === "inside") return { advantage: true, advantageCount: 1 };
  if (rangeState === "outside") return { disadvantage: true, disadvantageCount: 1 };
  return {};
}

function getConfiguredEffectiveRangeState(weapon, attackerToken, targetToken, actionKey = "", weaponFunctionId = "") {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const distance = getTokenDistanceMeters(attackerToken, targetToken);
  if (!Number.isFinite(distance)) return "";
  const range = getWeaponRangeProfile(weapon, actionKey, attackerToken, weaponFunctionId, {
    targetToken,
    targetActor: targetToken?.actor ?? null,
    weaponData,
    attackDistanceMeters: distance
  }).effectiveRange;
  if (!range) return "";
  return distance >= range.min && distance <= range.max ? "inside" : "outside";
}

function getTokenAttackPosture(token) {
  const direct = String(token?.document?._source?.movementAction ?? token?.document?.movementAction ?? "").trim();
  return direct || getActorPostureAction(token?.actor);
}

function isVulnerableAttackPosture(action = "") {
  return ["burrow", "knocked"].includes(String(action ?? "").trim());
}

function getEffectiveRangeDifficultyBonusForDistance(weaponData = {}, distanceMeters = 0, actor = null, context = {}) {
  const range = Object.hasOwn(context ?? {}, "effectiveRange")
    ? context.effectiveRange
    : getEffectiveRangeBounds(weaponData?.effectiveRange, actor, {
      ...context,
      weaponData,
      attackDistanceMeters: distanceMeters
    });
  const rangeState = getEffectiveRangeDistanceState({
    attackDistanceMeters: distanceMeters,
    effectiveRange: range
  });
  if (!rangeState.resolved || rangeState.side === "inside" || !rangeState.basePenalty) return 0;
  const nearSide = rangeState.side === "near";

  const effectKey = nearSide
    ? EFFECTIVE_RANGE_NEAR_PENALTY_PERCENT_EFFECT_KEY
    : EFFECTIVE_RANGE_FAR_PENALTY_PERCENT_EFFECT_KEY;
  const field = nearSide
    ? "effectiveRangeNearPenaltyPercent"
    : "effectiveRangeFarPenaltyPercent";
  const penaltyPercent = getContextualAbilityChangeValue(actor, effectKey, {
    ...context,
    weaponData,
    attackDistanceMeters: rangeState.attackDistanceMeters,
    effectiveRange: rangeState.effectiveRange,
    effectiveRangeSide: rangeState.side,
    baseValue: toInteger(actor?.system?.combat?.[field])
  });
  const multiplier = Math.max(0, 100 + Number(penaltyPercent || 0)) / 100;
  return Math.max(0, Math.round(rangeState.basePenalty * multiplier));
}

function getEffectiveRangeBounds(effectiveRange = {}, actor = null, context = {}) {
  if (context?.rangeProfile?.effectiveRange !== undefined) return context.rangeProfile.effectiveRange;
  const baseEffectiveRange = resolveBaseWeaponEffectiveRange(
    effectiveRange,
    value => evaluateActorFormula(value, actor, {
      minimum: 0,
      context: "effective range"
    })
  );
  const conditionEffectiveRange = applyWeaponEffectiveRangeBonuses(baseEffectiveRange, {
    nearBonusMeters: Number(actor?.system?.combat?.effectiveRangeNearBonus) || 0,
    farBonusMeters: Number(actor?.system?.combat?.effectiveRangeFarBonus) || 0
  });
  const modifiers = getWeaponRangeModifierValues(actor, {
    ...context,
    effectiveRange: context?.rangeConditionEffectiveRange ?? conditionEffectiveRange
  });
  return applyWeaponEffectiveRangeBonuses(baseEffectiveRange, {
    nearBonusMeters: modifiers.effectiveRangeNearBonus,
    farBonusMeters: modifiers.effectiveRangeFarBonus
  });
}

function getTokenDistanceMeters(leftToken, rightToken) {
  const left = getTokenAimPoint(leftToken);
  const right = getTokenAimPoint(rightToken);
  if (!left || !right) return Infinity;
  const centerDistance = pixelsToMeters(Math.hypot(right.x - left.x, right.y - left.y));
  return Math.max(0, centerDistance - getTokenAttackRangeBonusMeters(leftToken));
}

function getAttackModeSettings(weapon, actionKey, mode, weaponFunctionId = "") {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  return weaponData?.[actionKey]?.[mode] ?? {};
}

function getEnabledMeleeDirections(weapon, actionKey, weaponFunctionId = "") {
  const settings = getWeaponAttackData(weapon, weaponFunctionId)?.[actionKey] ?? {};
  return getEnabledMeleeDirectionsFromSettings(settings);
}

function getEnabledMeleeDirectionsFromSettings(settings = {}) {
  return MELEE_DIRECTIONS.filter(direction => settings?.[direction.mode]?.enabled !== false);
}

function selectRandomMeleeDirection(directions = [], random = Math.random) {
  if (!Array.isArray(directions) || !directions.length) return null;
  const roll = clamp(Number(random?.()) || 0, 0, 0.999999999999);
  return directions[Math.floor(roll * directions.length)] ?? null;
}

export function isWeaponAttackModeEnabled(weapon, actionKey, mode, weaponFunctionId = "") {
  return getAttackModeSettings(weapon, actionKey, mode, weaponFunctionId)?.enabled !== false;
}

function getAttackModeAccuracyModifier(weapon, actionKey, mode, weaponFunctionId = "", context = {}) {
  return getWeaponAccuracyModifier(weapon, weaponFunctionId, context)
    + toInteger(getAttackModeSettings(weapon, actionKey, mode, weaponFunctionId)?.accuracyModifier)
}

function getWeaponAccuracyModifier(weapon, weaponFunctionId = "", context = {}) {
  const actor = getWeaponOwnerActor(weapon);
  const stealth = getStealthAttackModifiers(actor);
  return evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.accuracyBonus, {
    minimum: -Infinity,
    context: "weapon accuracy"
  })
    + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "accuracy")
    + getContextualCombatValue(actor, "accuracy", context)
    + stealth.accuracyBonus
    - getWeaponConditionAccuracyPenalty(weapon);
}

function getWeaponPushAccuracyModifier(weapon, weaponFunctionId = "", context = {}) {
  return getWeaponAccuracyModifier(weapon, weaponFunctionId, context)
    + evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.push?.accuracyModifier, {
      minimum: -Infinity,
      context: "push accuracy"
    });
}

function getWeaponPushDifficultyModifier(weapon, weaponFunctionId = "") {
  return evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.push?.pushDifficultyModifier, {
    minimum: -Infinity,
    context: "push difficulty"
  });
}

function getActorSkillValue(actor, skillKey = "") {
  return toInteger(actor?.system?.skills?.[resolveSkillKey(actor, skillKey)]?.value);
}

function resolveSkillKey(actor, skillKey = "") {
  const requested = String(skillKey ?? "");
  if (actor?.system?.skills?.[requested]) return requested;
  const alias = SKILL_ALIASES[requested] ?? requested;
  if (actor?.system?.skills?.[alias]) return alias;
  const setting = getSkillSettings().find(skill => skill.key === requested || skill.abbr === requested || skill.key === alias || skill.abbr === alias);
  return setting?.key ?? alias;
}

function getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId = "", influenceKey = "") {
  const actor = getWeaponOwnerActor(weapon);
  if (!actor) return 0;
  return getWeaponProficiencyInfluenceBonusForData(
    actor,
    getWeaponAttackData(weapon, weaponFunctionId),
    influenceKey
  );
}

function getWeaponOwnerActor(weapon) {
  const parent = weapon?.parent;
  return parent?.documentName === "Actor" ? parent : null;
}

function evaluateWeaponFormula(weapon, formula, options = {}) {
  const actor = getWeaponOwnerActor(weapon);
  if (weapon?.type === "ability") return evaluateAbilityAttackFormula(formula, actor, options);
  return evaluateActorFormula(formula, actor, options);
}

function evaluateAbilityAttackFormula(formula, actor = null, {
  fallback = 0,
  minimum = 0,
  context = "",
  targetActor = null,
  subjectActor = null
} = {}) {
  const text = String(formula ?? "").trim();
  const fallbackValue = Number.isFinite(Number(fallback)) ? Math.trunc(Number(fallback)) : 0;
  if (!text) return Math.max(minimum, fallbackValue);
  const direct = Number(text);
  if (Number.isFinite(direct)) return Math.max(minimum, Math.trunc(direct));
  try {
    const data = buildAttackTrialFormulaData({
      baseData: buildActorFormulaData(actor),
      sourceActor: actor,
      targetActor,
      subjectActor
    });
    return Math.max(minimum, evaluateFormula(text, data));
  } catch (error) {
    const label = context ? ` (${context})` : "";
    console.warn(`Fallout MaW | Ability attack formula evaluation failed${label}: ${error.message}`);
    return Math.max(minimum, fallbackValue);
  }
}

function normalizeFormulaText(value, fallback = "0") {
  return String(value ?? fallback).trim() || fallback;
}

function addFormulaTexts(left, right) {
  const leftText = normalizeFormulaText(left);
  const rightText = normalizeFormulaText(right);
  if (leftText === "0") return rightText;
  if (rightText === "0") return leftText;
  return `(${leftText}) + (${rightText})`;
}

function getAttackModeCriticalCheckModifiers(weapon, actionKey, mode, weaponFunctionId = "", context = {}) {
  const actor = getWeaponOwnerActor(weapon);
  const stealth = getStealthAttackModifiers(actor);
  const modifier = evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.criticalChanceModifier, {
    minimum: -Infinity,
    context: "critical chance"
  })
    + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "criticalChance")
    + getContextualCombatValue(actor, "criticalChance", context)
    + evaluateWeaponFormula(weapon, getAttackModeSettings(weapon, actionKey, mode, weaponFunctionId)?.criticalChanceModifier, {
      minimum: -Infinity,
      context: "attack mode critical chance"
    })
    + stealth.criticalChanceBonus
    - getWeaponConditionCritChancePenalty(weapon);
  return {
    criticalSuccessBonus: Math.max(0, modifier),
    criticalFailureBonus: Math.max(0, -modifier)
  };
}

function getAttackModeDamage(weapon, actionKey, mode, baseDamage, weaponFunctionId = "", { percentBaseAmount = null } = {}) {
  const modifier = evaluateWeaponFormula(weapon, getAttackModeSettings(weapon, actionKey, mode, weaponFunctionId)?.damagePercentModifier, {
    context: "attack mode damage percent"
  });
  const damage = Math.max(0, Number(baseDamage) || 0);
  const percentBase = Math.max(0, Number(percentBaseAmount ?? damage) || 0);
  return Math.max(0, Math.round(damage + (percentBase * modifier / 100)));
}

function getWeaponConditionWeakening(weapon) {
  return getConditionWeakeningData(weapon, { minimumRatio: 0.1 });
}

function getWeaponConditionWeakeningRatio(weapon) {
  const weakening = getWeaponConditionWeakening(weapon);
  return weakening.active ? weakening.ratio : 1;
}

function getWeaponConditionAccuracyPenalty(weapon) {
  const weakening = getWeaponConditionWeakening(weapon);
  return weakening.active ? weakening.steps * 10 : 0;
}

function getWeaponConditionCritChancePenalty(weapon) {
  const weakening = getWeaponConditionWeakening(weapon);
  return weakening.active ? weakening.steps * 3 : 0;
}

function getWeaponPenetrationPower(weapon, weaponFunctionId = "", context = {}) {
  const {
    actor = null,
    actorToken = null,
    actionKey = "",
    targetActor = null,
    targetToken = null,
    weaponData = null
  } = context;
  const sourceActor = actor ?? getWeaponOwnerActor(weapon);
  let value = getWeaponPenetrationBaseValue(weapon, weaponFunctionId, {
    actor: sourceActor,
    actionKey
  });
  value = getContextualAbilityChangeValue(sourceActor, `${ACTION_PENETRATION_KEY_PREFIX}${String(actionKey ?? "").trim()}`, {
    ...context,
    actorToken,
    alternateKeys: [ALL_ACTION_PENETRATION_KEY],
    baseValue: value,
    targetActor,
    targetToken,
    weaponActionKey: String(actionKey ?? "").trim(),
    weaponData: weaponData ?? getWeaponAttackData(weapon, weaponFunctionId),
    activeUseStages: { action: false, check: false, damage: true }
  });
  value += context?.weaponActionModifierState?.getCombatValueBonus?.("penetration", context) ?? 0;
  return Math.max(0, Math.trunc(value));
}

function getWeaponPenetrationBaseValue(weapon, weaponFunctionId = "", { actor = null, actionKey = "" } = {}) {
  const sourceActor = actor ?? getWeaponOwnerActor(weapon);
  const formula = getWeaponAttackData(weapon, weaponFunctionId)?.penetration;
  const base = weapon?.type === "ability"
    ? evaluateAbilityAttackFormula(formula, sourceActor, {
      minimum: 0,
      context: "weapon penetration"
    })
    : evaluateActorFormula(formula, sourceActor, {
      minimum: 0,
      context: "weapon penetration"
    });
  const modifier = collectActionPenetrationModifier(sourceActor, actionKey);
  let value = base;
  if (modifier.override !== null && modifier.override !== undefined && modifier.override !== "") value = Number(modifier.override);
  value *= Number.isFinite(Number(modifier.multiplier)) ? Number(modifier.multiplier) : 1;
  value += Number(modifier.add) || 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function collectActionPenetrationModifier(actor, actionKey = "") {
  const key = `${ACTION_PENETRATION_KEY_PREFIX}${String(actionKey ?? "").trim()}`;
  const modifier = { add: 0, multiplier: 1, override: null };
  if (!actor || !actionKey) return modifier;

  for (const effect of getActorApplicableEffects(actor)) {
    if (effect.disabled) continue;
    for (const change of effect.system?.changes ?? effect.changes ?? []) {
      if (String(change?.key ?? "").trim() !== key) continue;
      const value = evaluateActorEffectChangeNumber(actor, { ...change, effect });
      if (!Number.isFinite(value)) continue;
      if (change.type === "override") modifier.override = value;
      else if (change.type === "multiply") modifier.multiplier *= value;
      else modifier.add += value;
    }
  }

  return modifier;
}

function getActorApplicableEffects(actor) {
  if (typeof actor?.allApplicableEffects === "function") return Array.from(actor.allApplicableEffects());
  return Array.from(actor?.effects ?? []);
}

function getWeaponAttackAnimationDelay(weapon, weaponFunctionId = "") {
  return Math.max(0, toInteger(getWeaponAttackData(weapon, weaponFunctionId)?.attackAnimationDelayMs));
}

function getPenetratedDamageAmount(baseDamage, penetrationsUsed) {
  return Math.max(0, Math.round(Math.max(0, Number(baseDamage) || 0) * Math.max(0, 1 - (penetrationsUsed * 0.1))));
}

function getTargetDistance(target, geometry) {
  if (geometry.type === VOLLEY_ACTION_KEY) {
    return getTokenVolleyDistanceToHitboxEdge(target, geometry);
  }
  const distances = getTokenAttackContactPoints(target, geometry)
    .map(point => Math.hypot(point.x - geometry.origin.x, point.y - geometry.origin.y));
  if (distances.length) return Math.min(...distances);
  return Infinity;
}

function getNearestAttackChanceTarget(attackerToken, geometry, targets = [], targetTokenUuidAllowlist = null) {
  if (!geometry || !targets.length) return null;
  const trajectory = buildAttackTrajectory(attackerToken, geometry, targets);
  return getTrajectoryTargetEntries(attackerToken, trajectory, targetTokenUuidAllowlist).at(0)?.target ?? null;
}

function buildBurstTargetRanges(
  attackerToken,
  geometry,
  targets = [],
  attackCount = 1,
  {
    primaryShots = null,
    purpose = "resolution",
    distribution = null
  } = {}
) {
  return new Map(buildBurstTargetEntries(attackerToken, geometry, targets, attackCount, {
    primaryShots,
    purpose,
    distribution
  })
    .map(entry => [entry.target, entry.range]));
}

function buildBurstTargetEntries(
  attackerToken,
  geometry,
  targets = [],
  attackCount = 1,
  {
    primaryShots = null,
    purpose = "resolution",
    distribution = null
  } = {}
) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  if (!geometry || geometry.type === VOLLEY_ACTION_KEY || !targets.length) return [];
  const {
    buckets,
    denominator,
    distances,
    weights
  } = distribution ?? getBurstTargetHitDistribution(
    attackerToken,
    geometry,
    targets,
    amount,
    { purpose }
  );
  if (denominator <= 0) return [];
  return Array.from(buckets.entries())
    .filter(([target, shots]) => ((weights.get(target) ?? shots.length) > 0) && target?.actor)
    .sort((left, right) => (distances.get(left[0]) ?? Infinity) - (distances.get(right[0]) ?? Infinity))
    .map(([target, shots]) => {
      const expected = ((weights.get(target) ?? shots.length) / denominator) * amount;
      const range = getBurstDistributionRange(amount, expected);
      return {
        target,
        expected,
        range: {
          ...range,
          label: formatBurstBulletRange(range)
        }
      };
    });
}

function buildBurstDistributionShots(
  attackerToken,
  geometry,
  attackCount = 1,
  {
    purpose = "resolution",
    targetTokenUuidAllowlist = null
  } = {}
) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  const sampleCount = getBurstSampleCount(amount, { purpose });
  const shotGeometry = getRandomBurstMissGeometry(attackerToken, geometry);
  return Array.from({ length: sampleCount }, (_value, index) => {
    const offset = getEvenBurstSampleOffset(index, sampleCount);
    const angle = (Number(geometry?.angle) || 0) + ((Number(geometry?.halfAngle) || 0) * offset);
    const trajectory = buildTrajectoryByAngle(attackerToken, shotGeometry, angle, Number(shotGeometry?.elevationSlope) || 0);
    const hit = getTrajectoryTargetEntries(attackerToken, trajectory, targetTokenUuidAllowlist).at(0) ?? null;
    return {
      trajectory,
      target: hit?.target ?? null,
      hit: hit?.hit ?? null
    };
  });
}

function getBurstTargetHitDistribution(
  attackerToken,
  geometry,
  targets = [],
  attackCount = 1,
  { purpose = "resolution" } = {}
) {
  const allowedTargets = new Set(targets);
  const targetTokenUuidAllowlist = new Set(targets.map(getTokenDocumentUuid).filter(Boolean));
  const aimShots = new Map();
  const buckets = new Map();
  const distances = new Map();
  const distributionShots = buildBurstDistributionShots(
    attackerToken,
    geometry,
    attackCount,
    { purpose, targetTokenUuidAllowlist }
  );
  for (const shot of distributionShots) {
    const target = shot?.target ?? null;
    if (!target || !allowedTargets.has(target) || !target.actor) continue;
    if (!buckets.has(target)) buckets.set(target, []);
    buckets.get(target).push(shot);
    distances.set(target, Math.min(distances.get(target) ?? Infinity, Number(shot.hit?.distance) || getTargetDistance(target, geometry)));
  }

  const sampleCount = Math.max(1, distributionShots.length);
  const weights = new Map(Array.from(buckets.entries()).map(([target, shots]) => [target, shots.length]));
  for (const target of allowedTargets) {
    if (!target?.actor) continue;
    const axisProfile = getBurstTargetAxisProfile(target, geometry, sampleCount);
    const aimWeight = axisProfile?.weight ?? 0;
    if (aimWeight <= 0 || !axisProfile?.point) continue;
    const aimShot = buildBurstTargetAimShot(
      attackerToken,
      geometry,
      target,
      axisProfile.point,
      targetTokenUuidAllowlist
    );
    if (!aimShot) continue;
    if (!buckets.has(target)) buckets.set(target, []);
    aimShots.set(target, aimShot);
    weights.set(target, Math.max(weights.get(target) ?? 0, aimWeight));
    distances.set(target, Math.min(distances.get(target) ?? Infinity, Number(aimShot.hit?.distance) || getTargetDistance(target, geometry)));
  }

  const targetWeight = Array.from(weights.values()).reduce((sum, weight) => sum + weight, 0);
  const denominator = Math.max(sampleCount, targetWeight);
  const missWeight = Math.max(0, denominator - targetWeight);
  return { aimShots, buckets, denominator, distances, missWeight, weights };
}

function getBurstTargetAxisProfile(target, geometry, sampleCount = 1) {
  if (!geometry?.origin || geometry.type === VOLLEY_ACTION_KEY || !target) return 0;
  const halfAngle = Math.max(0, Number(geometry.halfAngle) || 0);
  if (halfAngle <= GEOMETRY_EPSILON) return null;
  const polygon = getTokenWorldPolygon(target);
  const points = getPolygonPointObjects(polygon);
  if (points.length < 3) return null;

  const axis = getBurstAxisSegment(geometry);
  const intersection = getSegmentPolygonIntersectionRange(axis.origin, axis.end, polygon, axis.distance);
  if (intersection) {
    return {
      point: withTokenAimElevation(target, getPointOnBurstAxis(axis, intersection.entry)),
      weight: Math.max(1, sampleCount)
    };
  }

  const closest = getClosestBurstAxisPolygonPoint(axis, points);
  if (!closest) return null;
  const projectedDistance = clamp(getProjectedDistanceOnSegment(axis.origin, axis.end, closest.axisPoint), 1, axis.distance);
  const halfWidth = Math.tan(halfAngle) * projectedDistance;
  if (halfWidth <= GEOMETRY_EPSILON) return null;
  const normalizedOffset = clamp(closest.distance / halfWidth, 0, 1);
  const centrality = 1 - (normalizedOffset * normalizedOffset);
  return {
    point: withTokenAimElevation(target, closest.tokenPoint),
    weight: centrality * Math.max(1, sampleCount)
  };
}

function getBurstAxisSegment(geometry) {
  const origin = geometry.origin;
  const angle = Number(geometry.angle) || 0;
  const distance = Math.max(1, Number(geometry.distance) || 1);
  return {
    origin,
    end: {
      x: origin.x + (Math.cos(angle) * distance),
      y: origin.y + (Math.sin(angle) * distance)
    },
    angle,
    distance
  };
}

function getPointOnBurstAxis(axis, distance) {
  const range = Math.max(0, Number(distance) || 0);
  return {
    x: axis.origin.x + (Math.cos(axis.angle) * range),
    y: axis.origin.y + (Math.sin(axis.angle) * range)
  };
}

function getClosestBurstAxisPolygonPoint(axis, points = []) {
  let best = null;
  const consider = (axisPoint, tokenPoint) => {
    if (!axisPoint || !tokenPoint) return;
    const distance = Math.hypot(axisPoint.x - tokenPoint.x, axisPoint.y - tokenPoint.y);
    if (best && distance >= best.distance) return;
    best = { axisPoint, tokenPoint, distance };
  };

  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    consider(getClosestPointOnSegment(a, axis.origin, axis.end), a);
    consider(getClosestPointOnSegment(b, axis.origin, axis.end), b);
    consider(axis.origin, getClosestPointOnSegment(axis.origin, a, b));
    consider(axis.end, getClosestPointOnSegment(axis.end, a, b));
  }

  return best;
}

function buildBurstTargetAimShot(
  attackerToken,
  geometry,
  target,
  point = null,
  targetTokenUuidAllowlist = null
) {
  const aimPoint = isTargetTrajectoryAimPointValid(attackerToken, target, geometry, point)
    ? point
    : selectTargetTrajectoryAimPoint(attackerToken, target, geometry);
  if (!aimPoint) return null;
  const trajectory = buildTrajectoryThroughPoint(attackerToken, geometry, aimPoint);
  const hit = getTrajectoryTargetEntries(attackerToken, trajectory, targetTokenUuidAllowlist).at(0);
  if (hit?.target !== target) return null;
  if (!hit) return null;
  return {
    trajectory,
    target,
    hit: hit.hit
  };
}

function getBurstDistributionRange(amount = 1, expected = 0) {
  const count = Math.max(1, toInteger(amount) || 1);
  const value = clamp(Number(expected) || 0, 0, count);
  if (value <= GEOMETRY_EPSILON) return { min: 0, max: 0 };
  const min = clamp(Math.floor(value), 1, count);
  const max = clamp(Math.ceil(value), min, count);
  return { min, max };
}

function buildBurstPrimaryShots(
  attackerToken,
  geometry,
  attackCount = 1,
  targetTokenUuidAllowlist = null
) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  const shotGeometry = getRandomBurstMissGeometry(attackerToken, geometry);
  return Array.from({ length: amount }, () => {
    const trajectory = buildRandomTrajectory(attackerToken, shotGeometry);
    const hit = getTrajectoryTargetEntries(attackerToken, trajectory, targetTokenUuidAllowlist).at(0) ?? null;
    return {
      trajectory,
      target: hit?.target ?? null,
      hit: hit?.hit ?? null
    };
  });
}

function buildBurstPrimaryShotsForRanges(
  attackerToken,
  geometry,
  attackCount = 1,
  targets = [],
  burstRanges = new Map(),
  { distribution = null } = {}
) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  const targetTokenUuidAllowlist = new Set(targets.map(getTokenDocumentUuid).filter(Boolean));
  const distributedShots = buildBurstPrimaryShotsFromTargetDistribution(
    attackerToken,
    geometry,
    amount,
    targets,
    { distribution }
  );
  if (distributedShots.length === amount) return distributedShots;
  if (!burstRanges?.size) {
    return buildBurstPrimaryShots(attackerToken, geometry, amount, targetTokenUuidAllowlist);
  }
  const allowedTargets = new Set(targets);
  let bestShots = null;
  let bestScore = Infinity;
  const attempts = Math.max(120, amount * 30);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const shots = buildBurstPrimaryShots(attackerToken, geometry, amount, targetTokenUuidAllowlist);
    const score = getBurstShotRangeMismatchScore(shots, allowedTargets, burstRanges);
    if (score <= 0) return shots;
    if (score >= bestScore) continue;
    bestScore = score;
    bestShots = shots;
  }

  return bestShots ?? buildBurstPrimaryShots(attackerToken, geometry, amount, targetTokenUuidAllowlist);
}

function buildBurstPrimaryShotsFromTargetDistribution(
  attackerToken,
  geometry,
  attackCount = 1,
  targets = [],
  { distribution = null } = {}
) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  const resolvedDistribution = distribution ?? getBurstTargetHitDistribution(
    attackerToken,
    geometry,
    targets,
    amount,
    { purpose: "resolution" }
  );
  const {
    aimShots,
    buckets,
    denominator,
    distances,
    missWeight,
    weights
  } = resolvedDistribution;
  if (denominator <= 0) return [];

  const allocations = Array.from(buckets.entries())
    .filter(([target, shots]) => (weights.get(target) ?? shots.length) > 0)
    .map(([target, shots]) => {
      const exact = ((weights.get(target) ?? shots.length) / denominator) * amount;
      return {
        target,
        shots,
        count: Math.floor(exact),
        remainder: exact - Math.floor(exact),
        distance: distances.get(target) ?? Infinity
      };
    });
  if (missWeight > 0) {
    const exact = (missWeight / denominator) * amount;
    allocations.push({
      target: null,
      shots: [],
      count: Math.floor(exact),
      remainder: exact - Math.floor(exact),
      distance: Infinity
    });
  }

  let remaining = Math.max(0, amount - allocations.reduce((sum, entry) => sum + entry.count, 0));
  [...allocations]
    .sort((left, right) => (right.remainder - left.remainder) || (left.distance - right.distance))
    .slice(0, remaining)
    .forEach(entry => { entry.count += 1; });

  const shots = [];
  for (const entry of allocations) {
    for (let index = 0; index < entry.count; index += 1) {
      const shot = selectBurstDistributedShot(attackerToken, geometry, entry, aimShots);
      if (shot) shots.push(shot);
    }
  }
  return shuffleBurstShots(shots).slice(0, amount);
}

function selectBurstDistributedShot(attackerToken, geometry, entry, aimShots = new Map()) {
  if (!entry?.target) {
    return {
      trajectory: buildRandomTrajectory(attackerToken, getRandomBurstMissGeometry(attackerToken, geometry)),
      target: null,
      hit: null
    };
  }
  const aimShot = aimShots.get(entry.target) ?? null;
  if (aimShot && Math.random() < 0.5) return aimShot;
  if (entry.shots.length) return entry.shots[Math.floor(Math.random() * entry.shots.length)];
  if (aimShot) return aimShot;
  return null;
}

function shuffleBurstShots(shots = []) {
  const values = [...shots];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

function getBurstShotRangeMismatchScore(shots = [], allowedTargets = new Set(), burstRanges = new Map()) {
  const counts = new Map();
  for (const shot of shots) {
    const target = shot?.target ?? null;
    if (!target || !allowedTargets.has(target)) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }

  let score = 0;
  for (const [target, range] of burstRanges.entries()) {
    if (!allowedTargets.has(target)) continue;
    const count = counts.get(target) ?? 0;
    const min = Math.max(0, toInteger(range?.min));
    const max = Math.max(min, toInteger(range?.max));
    if (count < min) score += min - count;
    else if (count > max) score += count - max;
  }
  return score;
}

function getBurstPrimaryShots(
  attackerToken,
  geometry,
  attackCount = 1,
  primaryShots = null,
  targets = []
) {
  if (Array.isArray(primaryShots)) return primaryShots;
  const targetTokenUuidAllowlist = new Set(targets.map(getTokenDocumentUuid).filter(Boolean));
  return buildBurstPrimaryShots(attackerToken, geometry, attackCount, targetTokenUuidAllowlist);
}

function formatBurstBulletRange(range = {}) {
  const min = Math.max(0, toInteger(range.min));
  const max = Math.max(min, toInteger(range.max));
  return min === max ? String(max) : `${min}-${max}`;
}

function buildSwingDirectionPreviewPoints(selectedTarget, directionKey = "", geometry = null) {
  if (!selectedTarget || !geometry || geometry.halfAngle <= 0) return [];
  const attackPoints = getAttackPolygonPoints(geometry);
  if (!Array.isArray(attackPoints) || attackPoints.length < 3) return [];

  const selectedSpan = getTokenSwingArcSpan(selectedTarget, geometry);
  if (!selectedSpan) return [];

  const movingLeft = directionKey === "rightToLeft";
  const targetCenter = getTokenCenter(selectedTarget);
  const lateralBoundary = targetCenter
    ? getSwingLateralOffset(targetCenter, geometry)
    : selectedSpan.lateralCenter;
  return clipPolygonToSwingSide(attackPoints, geometry, lateralBoundary, { movingLeft });
}

function drawSwingDirectionPreview(graphics, points = []) {
  const values = points.flatMap(point => [point.x, point.y]);
  if (values.length < 6) return;
  graphics.lineStyle(2, 0xfff1a8, 0.95);
  graphics.beginFill(0xff5a36, 0.34);
  graphics.drawPolygon(values);
  graphics.endFill();
}

function clipPolygonToSwingSide(points = [], geometry = null, lateralBoundary = 0, { movingLeft = false } = {}) {
  const sign = movingLeft ? -1 : 1;
  const sideValue = point => sign * (getSwingLateralOffset(point, geometry) - lateralBoundary);
  const isInside = point => sideValue(point) >= -GEOMETRY_EPSILON;
  const clipped = [];

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const currentInside = isInside(current);
    const nextInside = isInside(next);

    if (currentInside) addUniquePoint(clipped, current);
    if (currentInside === nextInside) continue;

    const intersection = getSwingBoundaryIntersection(current, next, sideValue);
    if (intersection) addUniquePoint(clipped, intersection);
  }

  return removeSequentialDuplicatePoints(clipped);
}

function getSwingBoundaryIntersection(start, end, sideValue) {
  const startValue = sideValue(start);
  const endValue = sideValue(end);
  const denominator = startValue - endValue;
  if (Math.abs(denominator) <= GEOMETRY_EPSILON) return null;
  const t = clamp(startValue / denominator, 0, 1);
  return {
    x: start.x + ((end.x - start.x) * t),
    y: start.y + ((end.y - start.y) * t),
    elevation: Number.isFinite(Number(start.elevation)) || Number.isFinite(Number(end.elevation))
      ? (Number(start.elevation) || 0) + (((Number(end.elevation) || 0) - (Number(start.elevation) || 0)) * t)
      : undefined
  };
}

function removeSequentialDuplicatePoints(points = []) {
  const result = [];
  for (const point of points) {
    if (result.length && arePointsClose(result.at(-1), point)) continue;
    result.push(point);
  }
  if (result.length > 1 && arePointsClose(result[0], result.at(-1))) result.pop();
  return result;
}

function arePointsClose(left, right) {
  return Math.hypot(
    (Number(left?.x) || 0) - (Number(right?.x) || 0),
    (Number(left?.y) || 0) - (Number(right?.y) || 0)
  ) <= GEOMETRY_EPSILON;
}

function getSwingTargetSequence(selectedTarget, directionKey, targets = [], geometry = null) {
  if (!geometry) return [selectedTarget];
  const selectedSpan = getTokenSwingArcSpan(selectedTarget, geometry);
  if (!selectedSpan) return [selectedTarget];
  const movingLeft = directionKey === "rightToLeft";
  const anchor = selectedSpan.lateralCenter;
  const nextTargets = Array.from(new Set(targets ?? []))
    .filter(target => target !== selectedTarget && target?.actor)
    .map(target => ({ target, span: getTokenSwingArcSpan(target, geometry) }))
    .filter(entry => entry.span)
    .filter(entry => movingLeft
      ? entry.span.lateralCenter <= anchor + SWING_ARC_EPSILON
      : entry.span.lateralCenter >= anchor - SWING_ARC_EPSILON)
    .sort((left, right) => {
      const arcOrder = movingLeft
        ? right.span.lateralCenter - left.span.lateralCenter
        : left.span.lateralCenter - right.span.lateralCenter;
      return arcOrder || left.span.distance - right.span.distance;
    })
    .map(entry => entry.target);
  return [selectedTarget, ...nextTargets];
}

function getUnaimedSwingTargetSequence(directionKey, targets = [], geometry = null) {
  if (!geometry) return [];
  const movingLeft = directionKey === "rightToLeft";
  return Array.from(new Set(targets ?? []))
    .filter(target => target?.actor)
    .map(target => ({ target, span: getTokenSwingArcSpan(target, geometry) }))
    .filter(entry => entry.span)
    .sort((left, right) => {
      const arcOrder = movingLeft
        ? right.span.lateralCenter - left.span.lateralCenter
        : left.span.lateralCenter - right.span.lateralCenter;
      return arcOrder || left.span.distance - right.span.distance;
    })
    .map(entry => entry.target);
}

function getTokenSwingArcSpan(target, geometry) {
  const points = getTokenAttackContactPoints(target, geometry)
    .map(point => ({
      offset: normalizeAngle(Math.atan2(point.y - geometry.origin.y, point.x - geometry.origin.x) - geometry.angle),
      lateral: getSwingLateralOffset(point, geometry),
      distance: Math.hypot(point.x - geometry.origin.x, point.y - geometry.origin.y)
    }));
  if (!points.length) return null;
  points.sort((left, right) => left.offset - right.offset);
  const min = points[0].offset;
  const max = points.at(-1).offset;
  const lateralValues = points.map(point => point.lateral).sort((left, right) => left - right);
  const lateralMin = lateralValues[0];
  const lateralMax = lateralValues.at(-1);
  return {
    min,
    max,
    center: (min + max) / 2,
    lateralMin,
    lateralMax,
    lateralCenter: (lateralMin + lateralMax) / 2,
    distance: Math.min(...points.map(point => point.distance))
  };
}

function getSwingLateralOffset(point, geometry) {
  const dx = point.x - geometry.origin.x;
  const dy = point.y - geometry.origin.y;
  return (Math.cos(geometry.angle) * dy) - (Math.sin(geometry.angle) * dx);
}

function buildSwingAnimationTrajectory(attackerToken, targets = [], directionKey = "rightToLeft", geometry = null) {
  const centers = targets.map(getTokenCenter).filter(Boolean);
  const first = geometry?.origin ?? (attackerToken ? getTokenAimPoint(attackerToken) : null) ?? centers.at(0);
  if (!first) return null;
  const last = centers.at(-1) ?? null;
  const fallbackOffset = Math.max(24, (Number(canvas.grid?.size) || 100) * 0.7);
  const end = last
    ? last
    : {
      x: first.x + (directionKey === "rightToLeft" ? -fallbackOffset : fallbackOffset),
      y: first.y
    };
  const angle = Math.atan2(end.y - first.y, end.x - first.x);
  return {
    origin: first,
    angle,
    distance: Math.max(1, Math.hypot(end.x - first.x, end.y - first.y)),
    halfAngle: 0,
    end
  };
}

function buildVolleyAnimationTrajectory(geometry) {
  return {
    origin: geometry.origin,
    angle: geometry.angle,
    distance: geometry.distance,
    halfAngle: 0,
    end: geometry.end,
    delayGroup: 0
  };
}

function buildConeAnimationTrajectory(geometry) {
  if (!geometry?.origin) return null;
  const distance = Math.max(1, Number(geometry.distance) || 1);
  const angle = Number.isFinite(Number(geometry.angle)) ? Number(geometry.angle) : 0;
  return {
    origin: geometry.origin,
    angle,
    distance,
    halfAngle: Math.max(0, Number(geometry.halfAngle) || 0),
    end: {
      x: geometry.origin.x + (Math.cos(angle) * distance),
      y: geometry.origin.y + (Math.sin(angle) * distance),
      elevation: Number.isFinite(Number(geometry.end?.elevation)) ? Number(geometry.end.elevation) : geometry.origin.elevation
    },
    delayGroup: 0
  };
}

function getTokenTrajectoryIntersectionRange(token, trajectory) {
  const polygon = getTokenWorldPolygon(token);
  if (!polygon || !trajectory?.origin) return null;
  const origin = trajectory.origin;
  const end = trajectory.end ?? getPointOnTrajectory(trajectory, trajectory.distance);
  return getSegmentPolygonIntersectionRange(origin, end, polygon, trajectory.distance);
}

function getSegmentPolygonIntersectionRange(origin, end, polygon, maxDistance = null) {
  const points = getPolygonPointObjects(polygon);
  if (points.length < 3) return null;
  const segmentLength = Math.hypot((Number(end?.x) || 0) - (Number(origin?.x) || 0), (Number(end?.y) || 0) - (Number(origin?.y) || 0));
  const distance = Math.max(0, Number(maxDistance) || segmentLength);
  if (distance <= GEOMETRY_EPSILON || segmentLength <= GEOMETRY_EPSILON) return null;

  const values = [];
  const addDistance = point => {
    const value = clamp(getProjectedDistanceOnSegment(origin, end, point), 0, distance);
    if (values.some(existing => Math.abs(existing - value) <= GEOMETRY_EPSILON)) return;
    values.push(value);
  };

  if (polygon.contains?.(origin.x, origin.y)) values.push(0);
  if (polygon.contains?.(end.x, end.y)) values.push(distance);

  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const intersection = foundry.utils.lineSegmentIntersection?.(origin, end, a, b);
    if (intersection) addDistance(intersection);
  }

  if (values.length < 2) return null;
  values.sort((left, right) => left - right);
  const entry = values[0];
  const exit = values.at(-1);
  return exit - entry > GEOMETRY_EPSILON ? { entry, exit } : null;
}

function getProjectedDistanceOnSegment(origin, end, point) {
  const dx = (Number(end?.x) || 0) - (Number(origin?.x) || 0);
  const dy = (Number(end?.y) || 0) - (Number(origin?.y) || 0);
  const length = Math.hypot(dx, dy);
  if (length <= GEOMETRY_EPSILON) return 0;
  return (((Number(point?.x) || 0) - (Number(origin?.x) || 0)) * dx
    + ((Number(point?.y) || 0) - (Number(origin?.y) || 0)) * dy) / length;
}

function getTokenWorldPolygon(token) {
  const shape = token?.shape;
  const offset = getTokenShapeOffset(token);
  if (!shape || !offset) return null;
  if (shape instanceof PIXI.Polygon) return translatePolygon(shape, offset);
  if (shape instanceof PIXI.Rectangle) {
    return new PIXI.Rectangle(
      offset.x + shape.x,
      offset.y + shape.y,
      shape.width,
      shape.height
    ).normalize().toPolygon();
  }
  if (shape instanceof PIXI.Circle) {
    return new PIXI.Circle(offset.x + shape.x, offset.y + shape.y, shape.radius).toPolygon?.({ density: 48 }) ?? null;
  }
  if (shape instanceof PIXI.Ellipse) return ellipseToPolygon(shape, offset);
  return null;
}

function getTokenShapeOffset(token) {
  if (!isTokenPlaceableAvailable(token)) return null;
  const position = token.position;
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y
  };
}

function translatePolygon(polygon, offset) {
  const translated = [];
  const points = Array.isArray(polygon?.points) ? polygon.points : [];
  for (let index = 0; index < points.length - 1; index += 2) {
    translated.push((Number(points[index]) || 0) + offset.x, (Number(points[index + 1]) || 0) + offset.y);
  }
  return new PIXI.Polygon(translated);
}

function ellipseToPolygon(ellipse, offset, density = 48) {
  const radiusX = Number(ellipse.radiusX ?? ellipse.halfWidth ?? ellipse.width) || 0;
  const radiusY = Number(ellipse.radiusY ?? ellipse.halfHeight ?? ellipse.height) || 0;
  if (radiusX <= 0 || radiusY <= 0) return null;
  const center = {
    x: offset.x + (Number(ellipse.x) || 0),
    y: offset.y + (Number(ellipse.y) || 0)
  };
  const points = [];
  for (let index = 0; index < density; index += 1) {
    const angle = (Math.PI * 2 * index) / density;
    points.push(center.x + (Math.cos(angle) * radiusX), center.y + (Math.sin(angle) * radiusY));
  }
  return new PIXI.Polygon(points);
}

function getTokenTrajectoryHit(token, trajectory) {
  const range = getTokenTrajectoryIntersectionRange(token, trajectory);
  if (!range) return null;
  const elevationRange = getTokenElevationRange(token);
  const hitDistance = getTrajectoryTokenElevationHitDistance(trajectory, range, elevationRange);
  if (!Number.isFinite(hitDistance)) return null;
  return {
    distance: hitDistance,
    point: getPointOnTrajectory(trajectory, hitDistance)
  };
}

function getTokenAttackContactPoints(token, geometry) {
  if (geometry.type === VOLLEY_ACTION_KEY) return getTokenVolleyContactPoints(token, geometry);

  if (geometry.halfAngle <= 0) {
    const points = [];
    const hit = getTokenTrajectoryHit(token, geometry);
    if (hit?.point) addUniquePoint(points, hit.point);
    return sortContactPoints(points, geometry.origin);
  }

  return getAttackIntersectionTestPoints(getTokenAttackIntersectionPolygon(token, geometry), geometry.origin);
}

function getTokenAttackIntersectionPolygon(token, geometry) {
  const tokenPolygon = getTokenWorldPolygon(token);
  const attackPolygon = getAttackAreaPolygon(geometry);
  if (!tokenPolygon || !attackPolygon) return null;
  const intersection = tokenPolygon.intersectPolygon?.(attackPolygon);
  return getPolygonPointObjects(intersection).length >= 3 ? intersection : null;
}

function getTokenAttackCoverPolygon(token, geometry) {
  const tokenPolygon = getTokenWorldPolygon(token);
  if (!tokenPolygon || geometry?.ricochetCone) return tokenPolygon;
  const attackPolygon = getUnclippedAttackAreaPolygon(geometry);
  if (!attackPolygon) return tokenPolygon;
  const intersection = tokenPolygon.intersectPolygon?.(attackPolygon);
  return getPolygonPointObjects(intersection).length >= 3 ? intersection : null;
}

function getUnclippedAttackAreaPolygon(geometry) {
  const origin = geometry?.origin;
  const distance = Math.max(0, Number(geometry?.distance) || 0);
  const halfAngle = Math.min(Math.PI, Math.max(0, Number(geometry?.halfAngle) || 0));
  if (!origin || distance <= GEOMETRY_EPSILON || halfAngle <= GEOMETRY_EPSILON) return null;

  const values = [];
  if (halfAngle >= Math.PI - GEOMETRY_EPSILON) {
    const segments = 48;
    for (let index = 0; index < segments; index += 1) {
      const angle = (Math.PI * 2 * index) / segments;
      values.push(origin.x + (Math.cos(angle) * distance), origin.y + (Math.sin(angle) * distance));
    }
  } else {
    values.push(origin.x, origin.y);
    const segments = 24;
    for (let index = 0; index <= segments; index += 1) {
      const step = -halfAngle + ((halfAngle * 2 * index) / segments);
      values.push(
        origin.x + (Math.cos((Number(geometry.angle) || 0) + step) * distance),
        origin.y + (Math.sin((Number(geometry.angle) || 0) + step) * distance)
      );
    }
  }
  return new PIXI.Polygon(values);
}

function getAttackAreaPolygon(geometry) {
  const points = getAttackPolygonPoints(geometry);
  if (!Array.isArray(points) || points.length < 3) return null;
  const values = [];
  for (const point of points) {
    if (!Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) continue;
    values.push(Number(point.x), Number(point.y));
  }
  return values.length >= 6 ? new PIXI.Polygon(values) : null;
}

function getAttackIntersectionTestPoints(polygon, origin) {
  if (!polygon || !origin) return [];
  const points = getPolygonPointObjects(polygon);
  addUniquePoint(points, getPolygonCentroidPoint(polygon));
  addPolygonClosestEdgePoints(points, polygon, origin);
  return sortContactPoints(points, origin);
}

function getTokenAimedElevationIntersection(token, geometry, trajectory) {
  const polygon = getTokenAttackIntersectionPolygon(token, geometry);
  if (!polygon) return null;
  const distanceRange = getPolygonDistanceRangeFromOrigin(polygon, geometry.origin);
  if (!distanceRange) return null;

  const elevationRange = getTokenElevationRange(token);
  const originElevation = Number(trajectory?.origin?.elevation) || 0;
  const slope = Number(trajectory?.elevationSlope) || 0;

  if (Math.abs(slope) <= GEOMETRY_EPSILON) {
    if (originElevation < elevationRange.bottom - GEOMETRY_EPSILON || originElevation > elevationRange.top + GEOMETRY_EPSILON) return null;
    const point = getPolygonCentroidPoint(polygon) ?? distanceRange.closestPoint;
    return point ? { point: { ...point, elevation: originElevation }, distance: Math.hypot(point.x - geometry.origin.x, point.y - geometry.origin.y) } : null;
  }

  const first = (elevationRange.bottom - originElevation) / slope;
  const second = (elevationRange.top - originElevation) / slope;
  const elevationDistanceMin = Math.min(first, second);
  const elevationDistanceMax = Math.max(first, second);
  const distanceMin = Math.max(distanceRange.min, elevationDistanceMin);
  const distanceMax = Math.min(distanceRange.max, elevationDistanceMax);
  if (distanceMin > distanceMax + GEOMETRY_EPSILON) return null;

  const aimPoint = getTokenAimPoint(token);
  const aimDistance = aimPoint ? getProjectedDistanceOnTrajectory(aimPoint, trajectory) : Number.NaN;
  const distance = clamp(Number.isFinite(aimDistance) ? aimDistance : ((distanceMin + distanceMax) / 2), distanceMin, distanceMax);
  const point = getPolygonPointAtDistanceFromOrigin(polygon, geometry.origin, distance);
  if (!point) return null;
  return {
    distance,
    point: {
      x: point.x,
      y: point.y,
      elevation: getTrajectoryElevationAtDistance(trajectory, distance)
    }
  };
}

function withTokenAimElevation(token, point) {
  return {
    ...point,
    elevation: Number.isFinite(Number(point?.elevation)) ? Number(point.elevation) : getTokenAimElevation(token)
  };
}

function getTokenVolleyContactPoints(token, geometry) {
  const radius = Math.max(0, Number(geometry.radiusPixels) || 0);
  const closest = getClosestPointOnTokenVolume(token, geometry.end);
  const points = [];
  if (closest && getSphericalDistancePixels(geometry.end, closest) <= radius) addUniquePoint(points, closest);
  return sortContactPoints(points, geometry.end);
}

function isPointInsideAttackCone(point, geometry) {
  if (!point || !geometry?.origin) return false;
  const dx = point.x - geometry.origin.x;
  const dy = point.y - geometry.origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance > (Number(geometry.distance) || 0) + GEOMETRY_EPSILON) return false;
  const offset = normalizeAngle(Math.atan2(dy, dx) - geometry.angle);
  return offset >= -geometry.halfAngle - GEOMETRY_EPSILON
    && offset <= geometry.halfAngle + GEOMETRY_EPSILON;
}

function getTokenShapeBounds(token) {
  const points = getPolygonPointObjects(getTokenWorldPolygon(token));
  if (!points.length) return null;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys)
  };
}

function getTokenShapeCenter(token) {
  const bounds = getTokenShapeBounds(token);
  if (!bounds) return null;
  return {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
    elevation: getTokenAimElevation(token)
  };
}

function getTokenElevationRange(token) {
  const document = token?.document;
  const gridDistance = Math.max(0.0001, Number(token?.scene?.grid?.distance ?? canvas.scene?.grid?.distance ?? canvas.dimensions?.distance) || 1);
  // Foundry stores Token elevation in absolute Scene units even when the Token belongs to a non-zero Level.
  const rawBottom = Number(document?._source?.elevation ?? document?.elevation ?? token?.elevation);
  const bottom = Number.isFinite(rawBottom) ? rawBottom : 0;
  const depth = Math.max(0, Number(document?._source?.depth ?? document?.depth ?? 1) || 0) * gridDistance;
  const top = bottom + (depth > 0 ? depth : gridDistance);
  return { bottom: Math.min(bottom, top), top: Math.max(bottom, top) };
}

function getClosestPointOnTokenVolume(token, point) {
  if (!point) return null;
  const polygon = getTokenWorldPolygon(token);
  const points = getPolygonPointObjects(polygon);
  if (points.length < 3) return null;
  const closest = getClosestPointOnPolygon(points, point, polygon);
  if (!closest) return null;
  const elevationRange = getTokenElevationRange(token);
  const pointElevation = Number.isFinite(Number(point.elevation)) ? Number(point.elevation) : getTokenAimElevation(token);
  return {
    x: closest.x,
    y: closest.y,
    elevation: Math.max(elevationRange.bottom, Math.min(pointElevation, elevationRange.top))
  };
}

function getClosestPointOnPolygon(points, point, polygon = null) {
  const target = {
    x: Number(point?.x),
    y: Number(point?.y)
  };
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || points.length < 3) return null;
  if (polygon?.contains?.(target.x, target.y)) return target;

  let best = null;
  let bestDistance = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const candidate = getClosestPointOnSegment(target, a, b);
    const distance = Math.hypot(candidate.x - target.x, candidate.y - target.y);
    if (distance >= bestDistance) continue;
    best = candidate;
    bestDistance = distance;
  }
  return best;
}

function getClosestPointOnSegment(point, a, b) {
  const ax = Number(a?.x) || 0;
  const ay = Number(a?.y) || 0;
  const bx = Number(b?.x) || 0;
  const by = Number(b?.y) || 0;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= GEOMETRY_EPSILON) return { x: ax, y: ay };
  const t = clamp((((point.x - ax) * dx) + ((point.y - ay) * dy)) / lengthSquared, 0, 1);
  return {
    x: ax + (dx * t),
    y: ay + (dy * t)
  };
}

function addPolygonClosestEdgePoints(points, polygon, origin) {
  const polygonPoints = getPolygonPointObjects(polygon);
  if (polygonPoints.length < 3) return;
  for (let index = 0; index < polygonPoints.length; index += 1) {
    const a = polygonPoints[index];
    const b = polygonPoints[(index + 1) % polygonPoints.length];
    addUniquePoint(points, getClosestPointOnSegment(origin, a, b));
  }
}

function getPolygonDistanceRangeFromOrigin(polygon, origin) {
  if (!polygon || !origin) return null;
  const candidates = getAttackIntersectionTestPoints(polygon, origin);
  if (!candidates.length) return null;
  let closestPoint = null;
  let farthestPoint = null;
  let min = Infinity;
  let max = -Infinity;
  for (const point of candidates) {
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    if (distance < min) {
      min = distance;
      closestPoint = point;
    }
    if (distance > max) {
      max = distance;
      farthestPoint = point;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max, closestPoint, farthestPoint };
}

function getPolygonPointAtDistanceFromOrigin(polygon, origin, distance) {
  const radius = Math.max(0, Number(distance) || 0);
  const points = getPolygonPointObjects(polygon);
  if (!origin || points.length < 3) return null;

  for (const point of points) {
    if (Math.abs(Math.hypot(point.x - origin.x, point.y - origin.y) - radius) <= GEOMETRY_EPSILON) return point;
  }

  const radiusSquared = radius * radius;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const ax = a.x - origin.x;
    const ay = a.y - origin.y;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const qa = (dx * dx) + (dy * dy);
    const qb = 2 * ((ax * dx) + (ay * dy));
    const qc = (ax * ax) + (ay * ay) - radiusSquared;
    if (qa <= GEOMETRY_EPSILON) continue;
    const discriminant = (qb * qb) - (4 * qa * qc);
    if (discriminant < -GEOMETRY_EPSILON) continue;
    const root = Math.sqrt(Math.max(0, discriminant));
    for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
      if (t < -GEOMETRY_EPSILON || t > 1 + GEOMETRY_EPSILON) continue;
      return {
        x: a.x + (dx * clamp(t, 0, 1)),
        y: a.y + (dy * clamp(t, 0, 1))
      };
    }
  }

  const centroid = getPolygonCentroidPoint(polygon);
  if (centroid && Math.abs(Math.hypot(centroid.x - origin.x, centroid.y - origin.y) - radius) <= GEOMETRY_EPSILON) return centroid;
  return null;
}

function getPolygonCentroidPoint(polygon) {
  const points = getPolygonPointObjects(polygon);
  if (points.length < 3) return null;
  if (typeof foundry.utils.polygonCentroid === "function") return foundry.utils.polygonCentroid(polygon.points);

  let area = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = (current.x * next.y) - (next.x * current.y);
    area += cross;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }
  if (Math.abs(area) <= GEOMETRY_EPSILON) {
    return {
      x: points.reduce((total, point) => total + point.x, 0) / points.length,
      y: points.reduce((total, point) => total + point.y, 0) / points.length
    };
  }
  const factor = 1 / (3 * area);
  return { x: x * factor, y: y * factor };
}

function getSphericalDistancePixels(left, right) {
  const dx = (Number(left?.x) || 0) - (Number(right?.x) || 0);
  const dy = (Number(left?.y) || 0) - (Number(right?.y) || 0);
  const leftElevation = Number.isFinite(Number(left?.elevation)) ? Number(left.elevation) : 0;
  const rightElevation = Number.isFinite(Number(right?.elevation)) ? Number(right.elevation) : 0;
  const dz = metersToPixels(Math.abs(leftElevation - rightElevation));
  return Math.hypot(dx, dy, dz);
}

function getTokenAimElevation(token) {
  const range = getTokenElevationRange(token);
  return range.bottom + ((range.top - range.bottom) * 0.7);
}

function getTokenAimPoint(token) {
  const origin = token?.document?.getMovementOrigin?.();
  if (Number.isFinite(Number(origin?.x)) && Number.isFinite(Number(origin?.y))) {
    return {
      x: Number(origin.x) || 0,
      y: Number(origin.y) || 0,
      elevation: getTokenAimElevation(token)
    };
  }
  return null;
}

function normalizeAttackOriginOverride(value = null) {
  if (!Number.isFinite(Number(value?.x)) || !Number.isFinite(Number(value?.y))) return null;
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    elevation: Number.isFinite(Number(value.elevation)) ? Number(value.elevation) : 0
  };
}

function getTrajectoryTokenElevationHitDistance(trajectory, range, elevationRange) {
  const entry = Math.max(0, Number(range.entry) || 0);
  const exit = Math.min(Number(trajectory.distance) || 0, Number(range.exit) || 0);
  if (entry > exit) return Number.NaN;

  const slope = Number(trajectory.elevationSlope) || 0;
  const originElevation = Number(trajectory.origin?.elevation) || 0;
  if (Math.abs(slope) <= 0.000001) {
    return originElevation >= elevationRange.bottom - GEOMETRY_EPSILON
      && originElevation <= elevationRange.top + GEOMETRY_EPSILON
      ? entry
      : Number.NaN;
  }

  const first = (elevationRange.bottom - originElevation) / slope;
  const second = (elevationRange.top - originElevation) / slope;
  const verticalEntry = Math.min(first, second);
  const verticalExit = Math.max(first, second);
  const hit = Math.max(entry, verticalEntry);
  return hit <= Math.min(exit, verticalExit) + GEOMETRY_EPSILON ? hit : Number.NaN;
}

function getAttackPolygonPoints(geometry) {
  if (Array.isArray(geometry.shapePoints) && geometry.shapePoints.length >= 3) return geometry.shapePoints;
  if (geometry.halfAngle <= 0) return [];
  const points = [geometry.origin];
  const segments = 24;
  for (let index = 0; index <= segments; index += 1) {
    const step = -geometry.halfAngle + ((geometry.halfAngle * 2 * index) / segments);
    points.push({
      x: geometry.origin.x + (Math.cos(geometry.angle + step) * geometry.distance),
      y: geometry.origin.y + (Math.sin(geometry.angle + step) * geometry.distance)
    });
  }
  return points;
}

function getPolygonPointObjects(polygon) {
  const values = Array.isArray(polygon?.points) ? polygon.points : [];
  const points = [];
  for (let index = 0; index < values.length - 1; index += 2) {
    const x = Number(values[index]);
    const y = Number(values[index + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  return points;
}

function getPolygonBounds(polygon) {
  const points = getPolygonPointObjects(polygon);
  if (!points.length) return null;
  return {
    left: Math.min(...points.map(point => point.x)),
    right: Math.max(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)),
    bottom: Math.max(...points.map(point => point.y))
  };
}

function sortContactPoints(points, origin) {
  return points.sort((left, right) => (
    Math.hypot(left.x - origin.x, left.y - origin.y)
    - Math.hypot(right.x - origin.x, right.y - origin.y)
  ));
}

function addUniquePoint(points, point) {
  if (!Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) return;
  if (points.some(existing => (
    Math.abs(existing.x - point.x) <= GEOMETRY_EPSILON
    && Math.abs(existing.y - point.y) <= GEOMETRY_EPSILON
  ))) return;
  const entry = { x: Number(point.x), y: Number(point.y) };
  if (Number.isFinite(Number(point.elevation))) entry.elevation = Number(point.elevation);
  points.push(entry);
}

async function applyQueuedDamageRequests(requests = []) {
  return withWeaponDamagePreparedEvents(requests, async prepared => {
    notifyWeaponAttackDamageResolved(prepared);
    return requestDamageApplications(prepared);
  });
}

async function applyQueuedDamageAndRegionRequests(damageRequests = [], regionRequests = []) {
  if (regionRequests.length) {
    return withWeaponDamagePreparedEvents(damageRequests, async prepared => {
      notifyWeaponAttackDamageResolved(prepared);
      const result = await requestApplyDamageAndCreateVolleyDamageRegions(prepared, regionRequests);
      return result?.damage ?? [];
    });
  }
  if (damageRequests.length) return applyQueuedDamageRequests(damageRequests);
  return [];
}

async function withWeaponDamagePreparedEvents(requests = [], operation) {
  const sourceRequests = (Array.isArray(requests) ? requests : [requests]).filter(Boolean);
  // #region codex-runtime-debug H21 exactly one collection summary before per-request emits
  recordDamageRequestProbe(captureDamageRequestProbe(), "weapon.damagePreparedRequests", sourceRequests);
  // #endregion codex-runtime-debug
  if (!sourceRequests.length) return operation([]);
  const attackId = String(sourceRequests.find(request => request?.source?.attackId)?.source?.attackId ?? foundry.utils.randomID());
  const inheritedChainRef = sourceRequests.find(request => request?.source?.chainRef)?.source?.chainRef ?? null;
  return withSystemEventRoot({
    kind: "weaponDamagePrepared",
    operationId: `weapon-damage:${attackId}`,
    sceneUuid: getWeaponDamageRequestSceneUuid(sourceRequests),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: inheritedChainRef,
    data: { systemEventOperationId: attackId }
  }, async scope => {
    const prepared = [];
    for (const [index, request] of sourceRequests.entries()) {
      const actorUuid = String(request?.actor?.uuid ?? request?.actorUuid ?? "");
      const actor = request?.actor ?? (actorUuid ? await fromUuid(actorUuid) : null);
      if (!actorUuid || !actor) continue;
      const source = request?.source ?? {};
      if (isPhantomEntity(actor)) {
        prepared.push({
          ...request,
          source: {
            ...source,
            attackId,
            weaponAttackDamage: true,
            systemEventOperationId: String(source.systemEventOperationId ?? attackId),
            chainRef: scope.chainRef
          }
        });
        continue;
      }
      const participants = {
        source: {
          actorUuid: String(source.attackerActorUuid ?? source.attackerUuid ?? ""),
          tokenUuid: String(source.attackerTokenUuid ?? ""),
          itemUuid: String(source.weaponUuid ?? source.sourceItemUuid ?? "")
        },
        target: {
          actorUuid,
          tokenUuid: String(source.targetTokenUuid ?? ""),
          itemUuid: ""
        },
        related: []
      };
      const outcome = await scope.emit("fallout-maw.weapon.attack.damagePrepared", {
        data: {
          attackId,
          systemEventOperationId: attackId,
          actorUuid,
          limbKey: String(request?.limbKey ?? ""),
          amount: Math.max(0, Number(request?.amount) || 0),
          damageTypeKey: String(request?.damageTypeKey ?? ""),
          actionKey: String(source.actionKey ?? ""),
          weaponFunctionId: String(source.weaponFunctionId ?? ""),
          damageHubOperationRef: String(source.damageHubOperationRef ?? "")
        }
      }, {
        occurrenceKey: `weapon-damage:${attackId}:${actorUuid}:${index}`,
        participants
      });
      if (outcome?.control?.current || outcome?.control?.remaining || outcome?.control?.root) {
        if (outcome?.control?.remaining || outcome?.control?.root) break;
        continue;
      }
      prepared.push({
        ...request,
        source: {
          ...(request.source ?? {}),
          attackId,
          weaponAttackDamage: true,
          systemEventOperationId: String(request.source?.systemEventOperationId ?? attackId),
          chainRef: scope.chainRef
        }
      });
    }
    return operation(prepared);
  });
}

function getWeaponDamageRequestSceneUuid(requests = []) {
  for (const request of requests) {
    const source = request?.source ?? {};
    const tokenUuid = String(source.attackerTokenUuid ?? source.targetTokenUuid ?? "");
    const match = tokenUuid.match(/^(Scene\.[^.]+)/);
    if (match) return match[1];
  }
  return String(canvas?.scene?.uuid ?? "");
}

function flattenDamageResults(results = []) {
  return (Array.isArray(results) ? results : [results]).flat(Infinity).filter(Boolean);
}

function collectKilledTargetUuidsFromDamageResults(results = []) {
  return Array.from(new Set(flattenDamageResults(results)
    .filter(result => result?.mode === "damage" || !result?.mode)
    .filter(result => (Number(result?.healthDelta) || 0) > 0 || (Number(result?.limbDelta) || 0) > 0)
    .map(result => result.actor)
    .filter(actor => actor && isKilledTargetActor(actor))
    .map(actor => actor.uuid)
    .filter(Boolean)));
}

function isKilledTargetActor(actor) {
  return Boolean(actor?.statuses?.has?.("dead"));
}

function notifyWeaponAttackDamageResolved(requests = []) {
  const byAttacker = new Map();
  for (const request of (Array.isArray(requests) ? requests : [requests]).filter(Boolean)) {
    const attackerUuid = String(request?.source?.attackerUuid ?? "").trim();
    const targetUuid = String(request?.actor?.uuid ?? request?.actorUuid ?? "").trim();
    const targetActor = request?.actor ?? (targetUuid ? fromUuidSync(targetUuid) : null);
    if (!attackerUuid || !targetUuid || isPhantomEntity(targetActor)) continue;
    const targets = byAttacker.get(attackerUuid) ?? new Set();
    targets.add(targetUuid);
    byAttacker.set(attackerUuid, targets);
  }
  for (const [attackerUuid, targets] of byAttacker) {
    Hooks.callAll(WEAPON_ATTACK_DAMAGE_RESOLVED_HOOK, {
      attackerUuid,
      targetUuids: Array.from(targets),
      senderUserId: game.user?.id ?? ""
    });
  }
}

function serializeWeaponDamageRequests(requests = []) {
  return (Array.isArray(requests) ? requests : [requests])
    .map(request => ({
      actorUuid: String(request?.actor?.uuid ?? request?.actorUuid ?? "").trim(),
      limbKey: String(request?.limbKey ?? "").trim(),
      itemId: String(request?.itemId ?? request?.targetItemId ?? request?.source?.targetItemId ?? "").trim(),
      amount: Math.max(0, toInteger(request?.amount)),
      damageTypeKey: String(request?.damageTypeKey ?? "").trim(),
      scope: String(request?.scope ?? "healthAndLimb"),
      applyMitigation: request?.applyMitigation !== false,
      processDamageTypeSettings: request?.processDamageTypeSettings !== false,
      source: request?.source && typeof request.source === "object"
        ? foundry.utils.deepClone(request.source)
        : {}
    }))
    .filter(request => request.actorUuid && request.amount > 0 && request.damageTypeKey);
}

function getTokenCenter(token) {
  return getTokenShapeCenter(token);
}

function selectRandomLimbKey(actor, { includeDestroyed = false } = {}) {
  return selectRandomWeightedLimbKey(actor, { includeDestroyed });
}

function isAimedShotAction(weapon, actionKey, weaponFunctionId = "") {
  const actions = getWeaponAttackData(weapon, weaponFunctionId)?.availableActions ?? {};
  return actionKey === "aimedShot" && Boolean(actions.aimedShot);
}

function getAimedTargetUnderPointer(pointer, targets = []) {
  if (!pointer) return null;
  return targets.find(target => getTokenWorldPolygon(target)?.contains?.(pointer.x, pointer.y)) ?? null;
}

function getAimedAttackDifficulty(targetActor, limbKey = "", blockerBonus = 0, {
  innateDifficultyIgnorePercent = 0,
  ignoreCover = false,
  dodgeDifficulty = null
} = {}) {
  const dodge = Number.isFinite(dodgeDifficulty)
    ? Math.max(0, toInteger(dodgeDifficulty))
    : getDodgeDifficulty(targetActor, { ignoreCover });
  const limb = targetActor.system?.limbs?.[limbKey];
  const limbPercent = toInteger(limb?.aimedDifficultyPercent);
  const limbBonus = Math.max(0, toInteger(limb?.aimedDifficultyBonus));
  const innateDifficulty = Math.round(dodge * (limbPercent / 100)) + limbBonus;
  const ignorePercent = Math.max(0, Math.min(100, toInteger(innateDifficultyIgnorePercent)));
  const remainingInnateDifficulty = Math.round(innateDifficulty * (100 - ignorePercent) / 100);
  return dodge + remainingInnateDifficulty + Math.max(0, toInteger(blockerBonus));
}

function getContextualCombatValue(actor, key, context = {}) {
  return getContextualCombatValues(actor, [key], context)[key] ?? 0;
}

function getContextualCombatValues(actor, keys = [], context = {}) {
  const normalizedKeys = Array.from(new Set((keys ?? [])
    .map(key => String(key ?? "").trim())
    .filter(Boolean)));
  if (!normalizedKeys.length) return {};
  const values = getContextualAbilityChangeValues(actor, normalizedKeys.map(key => ({
    id: key,
    key: `system.combat.${key}`,
    baseValue: toInteger(actor?.system?.combat?.[key])
  })), context);
  const modifierState = context?.weaponActionModifierState ?? null;
  return Object.fromEntries(normalizedKeys.map(key => {
    const modifierBonus = typeof modifierState?.getCombatValueBonus === "function"
      ? modifierState.getCombatValueBonus(key, context)
      : 0;
    return [key, (Number(values[key]) || 0) + modifierBonus];
  }));
}

function applyContextualDamageToAmount(weapon, amount, context = {}) {
  const actor = getWeaponOwnerActor(weapon);
  const baselineContext = getDamageBaselineContext(context);
  const contextualValues = getContextualCombatValues(actor, ["damageFlat", "damagePercent"], context);
  const baselineValues = getContextualCombatValues(actor, ["damageFlat", "damagePercent"], baselineContext);
  const flatDelta = contextualValues.damageFlat - baselineValues.damageFlat;
  const percentDelta = contextualValues.damagePercent - baselineValues.damagePercent;
  const damageShareCount = Math.max(1, toInteger(context?.damageShareCount ?? 1));
  const damageShareIndex = Math.max(0, Math.min(damageShareCount - 1, toInteger(context?.damageShareIndex)));
  const damageScale = Math.max(0, Number(context?.damageScale ?? 1) || 0);
  const percentBase = Math.max(0, Number(
    context?.damagePercentBaseAmount ?? getWeaponDamagePercentBase(weapon, context?.weaponFunctionId)
  ) || 0);
  const totalDelta = Math.round((flatDelta + (percentBase * percentDelta / 100)) * damageScale);
  const distributedDeltas = distributeIntegerAmount(
    Math.abs(totalDelta),
    Array(damageShareCount).fill(1)
  );
  const distributedDelta = (totalDelta < 0 ? -1 : 1) * (distributedDeltas[damageShareIndex] ?? 0);
  const adjusted = Math.max(0, Number(amount) || 0) + distributedDelta;
  return Math.max(0, Math.round(adjusted));
}

function getDamageBaselineContext(context = {}) {
  const {
    targetActor,
    targetToken,
    attackDistanceMeters,
    effectiveRange,
    effectiveRangeBounds,
    effectiveRangeSide,
    ...targetlessBaseline
  } = context ?? {};
  return targetlessBaseline;
}

function getAimedWeaponTargetKey(item = null) {
  return `weapon:${String(item?.id ?? "").trim()}`;
}

function resolveAimedTargetSelection(actor, key = "") {
  const value = String(key ?? "").trim();
  if (!value) return null;
  if (!value.startsWith("weapon:")) {
    return actor?.system?.limbs?.[value] && !isLimbDestroyed(actor, value)
      ? { type: "limb", limbKey: value }
      : null;
  }

  const itemId = value.slice("weapon:".length);
  const entry = getHeldWeaponAimTargets(actor).find(target => target.item?.id === itemId);
  return entry && !entry.destroyed && !isLimbDestroyed(actor, entry.limbKey)
    ? { type: "weapon", item: entry.item, limbKey: entry.limbKey }
    : null;
}

function getHeldWeaponAimTargets(actor) {
  if (!actor) return [];
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const activeSetKey = getActiveAimedTargetWeaponSetKey(actor, race);
  if (!activeSetKey || activeSetKey === NATURAL_RACE_WEAPON_SET_KEY) return [];
  const rows = [];
  for (const item of actor.items?.contents ?? Array.from(actor.items ?? [])) {
    if (!isHeldWeaponAimTargetItem(actor, item)) continue;
    if (String(item.system?.placement?.weaponSet ?? "") !== activeSetKey) continue;
    const limbKey = getHeldWeaponHoldingLimbKey(actor, item, race);
    if (!limbKey) continue;
    const condition = getConditionFunction(item);
    const max = Math.max(0, toInteger(condition.max));
    if (max <= 0) continue;
    const current = Math.max(0, Math.min(max, toInteger(condition.value)));
    rows.push({
      item,
      limbKey,
      label: `${item.name} (${getActorLimbLabel(actor, limbKey)})`,
      destroyed: current <= 0
    });
  }
  return rows;
}

function isHeldWeaponAimTargetItem(actor, item = null) {
  if (item?.type !== "gear") return false;
  if (isNaturalRaceWeapon(item)) return false;
  if (!hasItemFunction(item, ITEM_FUNCTIONS.weapon, { ignoreBroken: true })) return false;
  if (!hasItemFunction(item, ITEM_FUNCTIONS.condition, { ignoreBroken: true })) return false;
  const placementMode = String(item.system?.placement?.mode ?? "");
  if (actor?.type === "construct" && placementMode === ITEM_FUNCTIONS.constructPart) return false;
  return placementMode === "weapon";
}

function getHeldWeaponHoldingLimbKey(actor, item = null, race = null) {
  const placement = item?.system?.placement ?? {};
  const setKey = String(placement.weaponSet ?? "");
  const slotKey = String(placement.weaponSlot ?? "");
  const constructPartLimbKey = getConstructPartWeaponSetLimbKey(setKey, actor);
  if (constructPartLimbKey) return constructPartLimbKey;

  const primarySlot = (race?.weaponSets ?? [])
    .find(set => set.key === setKey)?.slots
    ?.find(slot => slot.key === slotKey && String(slot?.limbKey ?? "").trim());
  if (primarySlot) return String(primarySlot.limbKey ?? "").trim();

  const requiredSlots = getRequiredWeaponSlotsForItem(race, item, setKey, slotKey);
  const limbSlot = requiredSlots.find(slot => String(slot?.limbKey ?? "").trim());
  return String(limbSlot?.limbKey ?? "").trim();
}

function getConstructPartWeaponSetLimbKey(setKey = "", actor = null) {
  const match = String(setKey ?? "").match(/^container:constructPart:([^:]+):/);
  if (!match) return "";
  const limbKey = getConstructPartLimbKey(match[1]);
  return actor?.system?.limbs?.[limbKey] ? limbKey : "";
}

function getActorLimbLabel(actor, limbKey = "") {
  return String(actor?.system?.limbs?.[limbKey]?.label ?? limbKey);
}

function getActiveAimedTargetWeaponSetKey(actor, race = null) {
  if (!actor) return "";
  const availableSetKeys = getActorWeaponSetKeys(actor, race);
  if (!availableSetKeys.size) return "";

  const selectedSetKey = String(actor.getFlag?.(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_SET_FLAG) ?? "");
  if (selectedSetKey && availableSetKeys.has(selectedSetKey)) return selectedSetKey;

  const selectedWeaponId = String(actor.getFlag?.(FALLOUT_MAW.id, SELECTED_HUD_WEAPON_FLAG) ?? "");
  const selectedWeaponSet = selectedWeaponId
    ? getDeployedWeaponSetKey(actor.items?.get?.(selectedWeaponId))
    : "";
  if (selectedWeaponSet && availableSetKeys.has(selectedWeaponSet)) return selectedWeaponSet;

  return Array.from(availableSetKeys).at(0) ?? "";
}

function getActorWeaponSetKeys(actor, race = null) {
  const keys = new Set((race?.weaponSets ?? []).map(set => String(set.key ?? "")).filter(Boolean));
  if (
    actor?.type !== "construct"
    && Array.from(actor?.items ?? []).some(item => getDeployedWeaponSetKey(item) === NATURAL_RACE_WEAPON_SET_KEY)
  ) {
    keys.add(NATURAL_RACE_WEAPON_SET_KEY);
  }
  for (const item of actor?.items ?? []) {
    if (
      item?.type !== "gear"
      || !hasItemFunction(item, ITEM_FUNCTIONS.constructPart)
      || String(item.system?.placement?.mode ?? "") !== ITEM_FUNCTIONS.constructPart
    ) continue;
    for (const set of item.system?.functions?.constructPart?.weaponSets ?? []) {
      const setId = String(set?.id ?? "").trim();
      const slotId = getConstructPartSlotId(item);
      if (setId && slotId) keys.add(`container:constructPart:${slotId}:${setId}`);
    }
  }
  for (const item of actor?.items ?? []) {
    const setKey = String(item?.system?.placement?.weaponSet ?? "");
    if (setKey) keys.add(setKey);
  }
  return keys;
}

function getDirectedAttackDifficulty(targetActor, limbKey = "", aimed = false, difficultyBonus = 0, {
  dodgeDifficulty = null
} = {}) {
  const base = aimed
    ? getAimedAttackDifficulty(targetActor, limbKey, 0, { dodgeDifficulty })
    : Number.isFinite(dodgeDifficulty)
      ? Math.max(0, toInteger(dodgeDifficulty))
      : getDodgeDifficulty(targetActor);
  return base + Math.max(0, toInteger(difficultyBonus));
}

function getGeneralAttackHitChance(attackerActor, weapon, targetActor, {
  difficultyBonus = 0,
  actionKey = "",
  weaponFunctionId = "",
  accuracyBonus = 0,
  context: previewContext = {}
} = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const skillKey = String(weaponData?.skillKey ?? "");
  const context = {
    ...previewContext,
    targetActor,
    weaponData,
    weaponActionKey: String(actionKey ?? "").trim()
  };
  const skillState = getContextualAttackSkillState(attackerActor, skillKey, context);
  const finalSkillValue = skillState.value
    + getWeaponAccuracyModifier(weapon, weaponFunctionId, context)
    + toInteger(accuracyBonus);
  const difficulty = getDisplayedAttackDodgeDifficulty(targetActor)
    + Math.max(0, toInteger(difficultyBonus))
    + getWeaponRequirementDifficultyPenalty(attackerActor, weapon, weaponFunctionId);
  return getSkillCheckSuccessChance(attackerActor, finalSkillValue, difficulty, {
    ...mergeSkillCriticalChanceModifiers(
      getWeaponCriticalCheckModifiers(weapon, weaponFunctionId, context),
      skillState
    ),
    disabledResults: skillState.disabledResults
  });
}

function getVolleyAreaHitChance(attackerActor, weapon, geometry, {
  difficultyBonus = 0,
  actionKey = "",
  weaponFunctionId = "",
  context: previewContext = {}
} = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const skillKey = String(weaponData?.skillKey ?? "");
  const attackDistanceMeters = getAttackGeometryDistanceMeters(geometry);
  const baseContext = {
    ...previewContext,
    weaponData,
    weaponActionKey: String(actionKey ?? "").trim(),
    attackDistanceMeters
  };
  const context = {
    ...baseContext,
    effectiveRange: getEffectiveRangeBounds(weaponData?.effectiveRange, attackerActor, baseContext)
  };
  const skillState = getContextualAttackSkillState(attackerActor, skillKey, context);
  const finalSkillValue = skillState.value
    + getWeaponAccuracyModifier(weapon, weaponFunctionId, context);
  const rangeDifficultyBonus = getEffectiveRangeDifficultyBonusForDistance(
    weaponData,
    attackDistanceMeters,
    attackerActor,
    context
  );
  const difficulty = BASE_VOLLEY_DIFFICULTY
    + rangeDifficultyBonus
    + getWeaponRequirementDifficultyPenalty(attackerActor, weapon, weaponFunctionId)
    + Math.max(0, toInteger(difficultyBonus));
  return getSkillCheckSuccessChance(attackerActor, finalSkillValue, difficulty, {
    ...mergeSkillCriticalChanceModifiers(
      getWeaponCriticalCheckModifiers(weapon, weaponFunctionId, context),
      skillState
    ),
    disabledResults: skillState.disabledResults
  });
}

function getAimedAttackHitChance(attackerActor, weapon, targetActor, limbKey = "", blockerBonus = 0, weaponFunctionId = "", actionKey = "", options = {}) {
  return getAimedAttackHitChanceFromBasis(
    buildAimedAttackChanceBasis(attackerActor, weapon, targetActor, weaponFunctionId, actionKey, options.context),
    limbKey,
    blockerBonus,
    options
  );
}

/** Shared attacker/target attack scalars for one target — limbs only change difficulty. */
function buildAimedAttackChanceBasis(attackerActor, weapon, targetActor, weaponFunctionId = "", actionKey = "", previewContext = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const skillKey = String(weaponData?.skillKey ?? "");
  const preparedSkill = attackerActor?.system?.skills?.[skillKey] ?? {};
  const context = {
    ...(previewContext ?? {}),
    targetActor,
    weaponData,
    weaponActionKey: String(actionKey ?? "").trim()
  };
  const disabledResultSpecs = buildSkillCheckDisabledResultContextSpecs(attackerActor);
  const contextual = getContextualAbilityChangeValues(attackerActor, [
    {
      id: "skill",
      key: `system.skills.${skillKey}.bonus`,
      baseValue: getSkillValueBeforePercent(preparedSkill),
      alternateKeys: ["system.skills.all.bonus"]
    },
    {
      id: "skillBonusPercent",
      key: `system.skills.${skillKey}.bonusPercent`,
      baseValue: toInteger(preparedSkill.bonusPercent),
      alternateKeys: [ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY]
    },
    {
      id: "skillCriticalSuccessChance",
      key: `system.skills.${skillKey}.criticalSuccessChance`,
      baseValue: toInteger(attackerActor?.system?.skills?.[skillKey]?.criticalSuccessChance),
      alternateKeys: [ALL_SKILLS_CRITICAL_SUCCESS_CHANCE_EFFECT_KEY]
    },
    {
      id: "skillCriticalFailureChance",
      key: `system.skills.${skillKey}.criticalFailureChance`,
      baseValue: toInteger(attackerActor?.system?.skills?.[skillKey]?.criticalFailureChance),
      alternateKeys: [ALL_SKILLS_CRITICAL_FAILURE_CHANCE_EFFECT_KEY]
    },
    {
      id: "accuracy",
      key: "system.combat.accuracy",
      baseValue: toInteger(attackerActor?.system?.combat?.accuracy)
    },
    {
      id: "criticalChance",
      key: "system.combat.criticalChance",
      baseValue: toInteger(attackerActor?.system?.combat?.criticalChance)
    },
    ...disabledResultSpecs
  ], context);

  const stealth = getStealthAttackModifiers(attackerActor);
  const criticalModifier = evaluateWeaponFormula(weapon, weaponData?.criticalChanceModifier, {
    minimum: -Infinity,
    context: "critical chance"
  })
    + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "criticalChance")
    + toInteger(contextual.criticalChance)
    + stealth.criticalChanceBonus
    - getWeaponConditionCritChancePenalty(weapon);

  const finalSkillValue = applySkillBonusPercent(contextual.skill, contextual.skillBonusPercent, {
    min: preparedSkill.min,
    max: preparedSkill.max,
    capResult: preparedSkill.developmentLimitPureOnly === false
  })
    + evaluateWeaponFormula(weapon, weaponData?.accuracyBonus, {
      minimum: -Infinity,
      context: "weapon accuracy"
    })
    + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "accuracy")
    + toInteger(contextual.accuracy)
    + stealth.accuracyBonus
    - getWeaponConditionAccuracyPenalty(weapon);

  return {
    attackerActor,
    targetActor,
    finalSkillValue,
    disabledResults: extractContextualSkillCheckDisabledResults(contextual, disabledResultSpecs),
    criticalModifiers: {
      criticalSuccessBonus: Math.max(0, criticalModifier)
        + toInteger(contextual.skillCriticalSuccessChance),
      criticalFailureBonus: Math.max(0, -criticalModifier)
        + toInteger(contextual.skillCriticalFailureChance)
    },
    requirementPenalty: getWeaponRequirementDifficultyPenalty(attackerActor, weapon, weaponFunctionId)
  };
}

function getAimedAttackHitChanceFromBasis(basis, limbKey = "", blockerBonus = 0, options = {}) {
  const dodgeDifficulty = getDisplayedAttackDodgeDifficulty(basis?.targetActor, {
    ignoreCover: options.ignoreCover
  });
  const difficulty = getAimedAttackDifficulty(
    basis?.targetActor,
    limbKey,
    blockerBonus + toInteger(basis?.requirementPenalty),
    { ...options, dodgeDifficulty }
  );
  return getSkillCheckSuccessChance(
    basis?.attackerActor,
    toInteger(basis?.finalSkillValue) + toInteger(options.accuracyBonus),
    difficulty,
    {
      ...(basis?.criticalModifiers ?? {}),
      disabledResults: basis?.disabledResults ?? {}
    }
  );
}

function getDirectedAttackHitChance(attackerActor, weapon, targetActor, {
  actionKey = "",
  mode = "thrust",
  limbKey = "",
  difficultyBonus = 0,
  weaponFunctionId = "",
  accuracyBonus = 0,
  context: previewContext = {}
} = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const skillKey = String(weaponData?.skillKey ?? "");
  const context = {
    ...previewContext,
    targetActor,
    weaponData,
    weaponActionKey: String(actionKey ?? "").trim()
  };
  const skillState = getContextualAttackSkillState(attackerActor, skillKey, context);
  const finalSkillValue = skillState.value
    + getAttackModeAccuracyModifier(weapon, actionKey, mode, weaponFunctionId, context)
    + toInteger(accuracyBonus);
  const difficulty = getDirectedAttackDifficulty(
    targetActor,
    limbKey,
    Boolean(limbKey),
    difficultyBonus + getWeaponRequirementDifficultyPenalty(attackerActor, weapon, weaponFunctionId),
    { dodgeDifficulty: getDisplayedAttackDodgeDifficulty(targetActor) }
  );
  return getSkillCheckSuccessChance(attackerActor, finalSkillValue, difficulty, {
    ...mergeSkillCriticalChanceModifiers(
      getAttackModeCriticalCheckModifiers(weapon, actionKey, mode, weaponFunctionId, context),
      skillState
    ),
    disabledResults: skillState.disabledResults
  });
}

function getContextualAttackSkillState(actor, skillKey = "", context = {}) {
  const preparedSkill = actor?.system?.skills?.[skillKey] ?? {};
  const disabledResultSpecs = buildSkillCheckDisabledResultContextSpecs(actor);
  const contextual = getContextualAbilityChangeValues(actor, [
    {
      id: "skill",
      key: `system.skills.${skillKey}.bonus`,
      baseValue: getSkillValueBeforePercent(preparedSkill),
      alternateKeys: ["system.skills.all.bonus"]
    },
    {
      id: "skillBonusPercent",
      key: `system.skills.${skillKey}.bonusPercent`,
      baseValue: toInteger(preparedSkill.bonusPercent),
      alternateKeys: [ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY]
    },
    {
      id: "skillCriticalSuccessChance",
      key: `system.skills.${skillKey}.criticalSuccessChance`,
      baseValue: toInteger(actor?.system?.skills?.[skillKey]?.criticalSuccessChance),
      alternateKeys: [ALL_SKILLS_CRITICAL_SUCCESS_CHANCE_EFFECT_KEY]
    },
    {
      id: "skillCriticalFailureChance",
      key: `system.skills.${skillKey}.criticalFailureChance`,
      baseValue: toInteger(actor?.system?.skills?.[skillKey]?.criticalFailureChance),
      alternateKeys: [ALL_SKILLS_CRITICAL_FAILURE_CHANCE_EFFECT_KEY]
    },
    ...disabledResultSpecs
  ], context);
  return {
    value: applySkillBonusPercent(contextual.skill, contextual.skillBonusPercent, {
      min: preparedSkill.min,
      max: preparedSkill.max,
      capResult: preparedSkill.developmentLimitPureOnly === false
    }),
    criticalSuccessBonus: toInteger(contextual.skillCriticalSuccessChance),
    criticalFailureBonus: toInteger(contextual.skillCriticalFailureChance),
    disabledResults: extractContextualSkillCheckDisabledResults(contextual, disabledResultSpecs)
  };
}

function mergeSkillCriticalChanceModifiers(combatModifiers = {}, skillState = {}) {
  return {
    criticalSuccessBonus: toInteger(combatModifiers?.criticalSuccessBonus)
      + toInteger(skillState?.criticalSuccessBonus),
    criticalFailureBonus: toInteger(combatModifiers?.criticalFailureBonus)
      + toInteger(skillState?.criticalFailureBonus)
  };
}

function buildSkillCheckDisabledResultContextSpecs(actor) {
  const prepared = actor?.system?.skillCheck?.disabledResults ?? {};
  return Object.entries(SKILL_CHECK_DISABLED_RESULT_EFFECT_KEYS).map(([resultKey, key]) => ({
    resultKey,
    id: `disabledResult:${resultKey}`,
    key,
    baseValue: Number(prepared?.[resultKey]) || 0
  }));
}

function extractContextualSkillCheckDisabledResults(contextual = {}, specs = []) {
  return Object.fromEntries(specs.map(spec => [spec.resultKey, contextual?.[spec.id]]));
}

function getSkillCheckSuccessChance(attackerActor, finalSkillValue, difficulty, criticalModifiers = {}) {
  return calculateSkillCheckSuccessChance(attackerActor, finalSkillValue, difficulty, criticalModifiers);
}

function getAimedChanceClass(chance) {
  const value = toInteger(chance);
  if (value >= 80) return "chance-high";
  if (value >= 30) return "chance-medium";
  return "chance-low";
}

function getWeaponRequirementDifficultyPenalty(actor, weapon, weaponFunctionId = "") {
  const requirements = getWeaponAttackData(weapon, weaponFunctionId)?.requirements ?? [];
  return requirements.reduce((total, requirement) => {
    const { required } = getAdjustedWeaponRequirement(actor, requirement);
    if (!required) return total;
    const current = getActorRequirementValue(actor, requirement);
    const deficit = Math.max(0, required - current);
    if (!deficit) return total;
    return total + (String(requirement?.type ?? "") === "skill" ? deficit : deficit * 10);
  }, 0);
}

function getActorRequirementValue(actor, requirement = {}) {
  const key = String(requirement?.key ?? "");
  if (!key) return 0;
  if (String(requirement?.type ?? "") === "skill") return toInteger(actor?.system?.skills?.[key]?.value);
  return toInteger(actor?.system?.characteristics?.[key]);
}

function getAimedTargetBlockers(attackerToken, selectedTarget, trajectory, targetTokenUuidAllowlist = null, {
  purpose = "preview"
} = {}) {
  const selectedHit = getTokenTrajectoryHit(selectedTarget, trajectory);
  if (!selectedHit) return [];
  return getTrajectoryTargetEntries(attackerToken, trajectory, targetTokenUuidAllowlist, { purpose })
    .filter(entry => entry.target !== selectedTarget && entry.hit.distance < selectedHit.distance - 0.5);
}

function getAimedTargetBlockerBonus(blockerCount) {
  const count = Math.max(0, toInteger(blockerCount));
  return (count * (count + 1) / 2) * AIMED_TARGET_BLOCKER_BONUS_STEP;
}

function getDodgeDifficulty(actor, { ignoreCover = false } = {}) {
  const value = toInteger(actor.system?.resources?.dodge?.value);
  if (!ignoreCover) return value;
  return Math.max(0, value - getActorCoverDodgeAdjustment(actor));
}

function getDisplayedAttackDodgeDifficulty(actor, { ignoreCover = false } = {}) {
  return getFalseBreachDisplayedDodgeDifficulty(
    actor,
    getDodgeDifficulty(actor, { ignoreCover })
  );
}

function truncateRicochetTrajectory(trajectory, segment, point, { projected = false } = {}) {
  const index = trajectory?.segments?.indexOf(segment) ?? -1;
  if (index < 0) return;
  if (projected) updateTrajectoryDistanceEnd(segment, point);
  else updateTrajectoryEnd(segment, point);
  trajectory.segments = trajectory.segments.slice(0, index + 1);
  let distance = 0;
  for (const entry of trajectory.segments) {
    entry.distanceOffset = distance;
    distance += Math.max(0, Number(entry.distance) || 0);
  }
  trajectory.distance = distance;
  trajectory.end = { ...segment.end };
  trajectory.reflectionCount = Math.max(0, toInteger(segment.reflectionCount));
}

function getRicochetAccuracyBonus(modifierState, reflectionCount = 0) {
  const settings = modifierState?.getOption?.("ricochet");
  return Math.max(0, toInteger(reflectionCount)) * toInteger(settings?.accuracyBonusPerReflection);
}

function applyRicochetDamageBonus(weapon, amount, context = {}) {
  const settings = context?.weaponActionModifierState?.getOption?.("ricochet");
  const reflections = Math.max(0, toInteger(context?.reflectionCount));
  const percent = reflections * toInteger(settings?.damagePercentBonusPerReflection);
  if (!percent) return Math.max(0, Math.round(Number(amount) || 0));
  const pelletCount = Math.max(1, getWeaponPelletCount(weapon, context?.weaponFunctionId));
  const percentBase = Math.max(0, getWeaponDamagePercentBase(weapon, context?.weaponFunctionId) / pelletCount);
  return Math.max(0, Math.round((Number(amount) || 0) + (percentBase * percent / 100)));
}

function getActorCoverDodgeAdjustment(actor) {
  const key = "system.resources.dodge.bonus";
  const baseValue = toInteger(foundry.utils.getProperty(actor?._source, key));
  const changes = [];
  for (const effect of actor?.allApplicableEffects?.() ?? actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    for (const change of effect.system?.changes ?? []) {
      if (String(change?.key ?? "").trim() !== key) continue;
      const value = evaluateActorEffectChangeNumber(actor, { ...change, effect });
      if (!Number.isFinite(value)) continue;
      changes.push({ ...change, value, effect });
    }
  }
  changes.sort((left, right) => toInteger(left?.priority) - toInteger(right?.priority));
  const withCover = applyNumericEffectChanges(baseValue, changes);
  const withoutCover = applyNumericEffectChanges(baseValue, changes.filter(change => !isCoverEffect(change.effect)));
  return withCover - withoutCover;
}

function applyNumericEffectChanges(baseValue = 0, changes = []) {
  let value = Number(baseValue) || 0;
  for (const change of changes) {
    const amount = Number(change?.value);
    if (!Number.isFinite(amount)) continue;
    if (change.type === "multiply") value *= amount;
    else if (change.type === "override") value = amount;
    else if (change.type === "upgrade") value = Math.max(value, amount);
    else if (change.type === "downgrade") value = Math.min(value, amount);
    else value += amount;
  }
  return value;
}

function isCoverEffect(effect) {
  return Boolean(
    effect?.getFlag?.(SYSTEM_ID, "forcedCover")
    || effect?.getFlag?.(SYSTEM_ID, "autoCover")
    || effect?.flags?.[SYSTEM_ID]?.forcedCover
    || effect?.flags?.[SYSTEM_ID]?.autoCover
  );
}

function isDeadTarget(token) {
  if (!token?.actor) return true;
  const defeatedStatus = CONFIG.specialStatusEffects.DEFEATED;
  return isDeadActor(token.actor)
    || (defeatedStatus && token.document?.hasStatusEffect?.(defeatedStatus))
    || token.document?.hasStatusEffect?.("dead");
}

function isDeadActor(actor) {
  if (!actor) return true;
  const defeatedStatus = CONFIG.specialStatusEffects.DEFEATED;
  return Boolean((defeatedStatus && actor.statuses?.has(defeatedStatus)) || actor.statuses?.has("dead"));
}

function isSuccessfulAttack(outcome) {
  return ["success", "criticalSuccess"].includes(String(outcome?.result?.key ?? ""));
}

function isCriticalSuccessAttack(outcome) {
  return String(outcome?.result?.key ?? "") === "criticalSuccess";
}

function isCriticalFailureAttack(outcome) {
  return String(outcome?.result?.key ?? "") === "criticalFailure";
}

function normalizeAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

function isCanvasViewEvent(event) {
  const view = canvas.app?.view;
  if (!view) return false;
  if (event.target === view) return true;
  return Array.from(event.composedPath?.() ?? []).includes(view);
}

function getPointerDistanceFromEvent(event, origin = {}) {
  const point = getClientPointFromEvent(event);
  return Math.hypot(
    point.x - (Number(origin.x) || 0),
    point.y - (Number(origin.y) || 0)
  );
}

function getClientPointFromEvent(event) {
  return {
    x: Number(event?.clientX ?? event?.client?.x ?? event?.nativeEvent?.clientX) || 0,
    y: Number(event?.clientY ?? event?.client?.y ?? event?.nativeEvent?.clientY) || 0
  };
}

function getFoundryDragResistance() {
  return Math.max(1, Number(foundry.canvas?.interaction?.MouseInteractionManager?.DEFAULT_DRAG_RESISTANCE_PX) || 10);
}

export async function spendWeaponReloadActionPoints(actor, weapon, weaponFunctionId = "") {
  await spendWeaponActionPoints(actor, weapon, "reload", weaponFunctionId);
}

export function hasRequiredWeaponReloadActionPoints(actor, weapon, weaponFunctionId = "") {
  return hasRequiredWeaponActionPoints(actor, weapon, "reload", weaponFunctionId);
}
