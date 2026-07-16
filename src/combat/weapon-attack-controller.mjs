import { calculateSkillCheckSuccessChance, createSkillCheckBatchCollector, requestSkillCheck } from "../rolls/skill-check.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { playWeaponAttackAnimations, playWeaponExplosionAnimation } from "./attack-animations.mjs";
import { applyDamageCostModifier, applyDamageRequestsInCurrentHubOperation, estimateDamageApplication, getDamageCostModifierState, getLimbHealingCap, isLimbDestroyed, requestDamageApplications, runDamageHubOperation } from "./damage-hub.mjs";
import { createDodgeAttackExposureTracker, getWeaponDodgeAttackMultiplier } from "./dodge-resource.mjs";
import {
  DELAYED_THROWN_ITEM_FLAG,
  DELAYED_THROWN_ITEM_REGION_FLAG,
  createThrownItemTile,
  deleteDelayedThrownItemDocuments
} from "../canvas/thrown-items.mjs";
import { getActorPostureAction, getActorPostureWeaponActionPointCostBonus } from "../canvas/posture-movement.mjs";
import {
  ITEM_FUNCTIONS,
  WEAPON_SPECIAL_PROPERTIES,
  createWeaponFunctionUpdateData,
  getActorInstalledModuleItems,
  getConditionFunction,
  getConditionWeakeningData,
  getDamageSourceFunction,
  getEnergyConsumerFunction,
  getWeaponAttackPowerState,
  getWeaponFunctionById,
  getWeaponFunctionModuleSlots,
  hasItemFunction,
  hasWeaponSpecialPropertyData,
  parseModuleWeaponFunctionId
} from "../utils/item-functions.mjs";
import { getCoverSettings, getCombatSettings, getCreatureOptions, getDamageTypeSettings, getProficiencyInfluenceSettings, getProficiencySettings, getSkillSettings } from "../settings/accessors.mjs";
import {
  ABILITY_ACTION_EXECUTOR_MODES,
  ABILITY_ACTION_POINT_COST_MODES,
  ABILITY_ACTION_TARGET_MODES,
  ABILITY_ACTION_TYPES,
  ABILITY_ATTACK_ACTION_ALL,
  ABILITY_ATTACKING_WEAPON_ACTION_KEYS,
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizeActiveApplicationSettings
} from "../settings/abilities.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  canSpendCombatActionPoints,
  canSpendStrictActionPoints,
  getCombatActionPointState,
  getStrictActionPointState,
  spendCombatActionPoints,
  spendStrictActionPoints
} from "./reaction-resources.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { evaluateActorEffectChangeNumber } from "../utils/active-effect-changes.mjs";
import { getRequiredWeaponSlotsForItem, getWeaponSlotRequirement, isContainerWeaponSetKey } from "../utils/equipment-slots.mjs";
import { selectRandomWeightedLimbKey } from "../utils/limb-randomization.mjs";
import { applyWeaponModuleModifiers } from "../utils/weapon-modules.mjs";
import { NATURAL_RACE_WEAPON_SET_KEY, isNaturalRaceWeapon } from "../races/natural-items.mjs";
import { getStealthAttackModifiers, revealActorFromStealth } from "../stealth/index.mjs";
import {
  getActorAtRandomActionPointCostReduction,
  getWeaponActionBlockState,
  hasActorFixedAbilityFunction
} from "../abilities/runtime-state.mjs";
import { getContextualAbilityChangeValue } from "../abilities/evaluation.mjs";
import {
  getAuraRelation,
  hasAuraLineOfSight,
  measureTokenDistanceMeters
} from "../abilities/aura-conditions.mjs";
import { getKnockbackMaximumStrength, resolveKnockback } from "./active-actions.mjs";
import { getWeaponSkillDamageBonuses } from "./weapon-skill-damage.mjs";
import { evaluateActorFormula, isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";
import {
  clearAttackAutoCoverSync,
  getActorForcedCoverData,
  queueAttackAutoCoverSync
} from "../canvas/cover.mjs";
import { REACTION_EVENT_KEYS, REACTION_RESULT, isActorUnableToAct, isReactionSystemLocked, requestReactionEvent } from "./reaction-hub.mjs";
import {
  createCounterSniperAttackModifier,
  getWeaponAttackModifierAccuracyModifier,
  isWhirlwindAttackModifier,
  normalizeWeaponAttackModifier
} from "./weapon-attack-modifiers.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { energySourceMatchesConsumer, getActiveEnergySourceItem, getEnergySourceReserveState } from "../items/light-source.mjs";
import { getConstructPartLimbKey, getConstructPartSlotId } from "../utils/construct-parts.mjs";
import { canTokenPhysicallySeeTarget } from "../canvas/physical-los.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { emitWeaponAttackCheckResolved } from "../events/foundry-compatibility-events.mjs";
import { isActorInActiveCombat } from "./combat-membership.mjs";

export { canTokenPhysicallySeeTarget } from "../canvas/physical-los.mjs";

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
const BURST_DISTRIBUTION_SAMPLE_MIN = 64;
const BURST_DISTRIBUTION_SAMPLE_MULTIPLIER = 12;
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
const SELECTED_HUD_WEAPON_FLAG = "selectedHudWeaponItemId";
const SELECTED_HUD_WEAPON_SET_FLAG = "selectedHudWeaponSetKey";
const PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const DEFAULT_REGION_DAMAGE_INTERVAL_SECONDS = 6;
const REGION_SOCKET_REQUEST_TIMEOUT_MS = 60000;
const COMMANDED_ATTACK_SOCKET_TIMEOUT_MS = 120000;
const MELEE_ACTION_KEYS = new Set(["meleeAttack", "aimedMeleeAttack"]);
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
const pendingCommandedAttackRequests = new Map();
const processingDelayedVolleyRegions = new Set();
const weaponAttackResolvedHandlers = new Map();
let activeAttack = null;
let activeDualWeaponAttack = null;
let activeCommandedAttack = null;
let delayedVolleyProcessorRegistered = false;

export function registerWeaponAttackResolvedHandler(id = "", handler = null) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId || typeof handler !== "function") return () => undefined;
  weaponAttackResolvedHandlers.set(normalizedId, handler);
  return () => {
    if (weaponAttackResolvedHandlers.get(normalizedId) === handler) weaponAttackResolvedHandlers.delete(normalizedId);
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
  Hooks.callAll(WEAPON_ATTACK_RESOLVED_HOOK, context);
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
    this.resourceCostMultipliers.set(
      normalizedType,
      (Number(this.resourceCostMultipliers.get(normalizedType)) || 1) * normalizedMultiplier
    );
  }

  getResourceCostMultiplier(type = "") {
    return Number(this.resourceCostMultipliers.get(String(type ?? "").trim())) || 1;
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
    if (typeof requirement.canSpend !== "function" && typeof requirement.spend !== "function") return;
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
    for (const requirement of this.spendRequirements) {
      if (typeof requirement.canSpend !== "function") continue;
      if (requirement.canSpend({ ...this.context, ...context }) === false) return false;
    }
    return true;
  }

  async spend(context = {}) {
    for (const requirement of this.spendRequirements) {
      if (typeof requirement.spend !== "function") continue;
      if ((await requirement.spend({ ...this.context, ...context })) === false) return false;
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
  Hooks.callAll(WEAPON_ACTION_MODIFIER_REQUEST_HOOK, {
    ...context,
    modifierState: state,
    addCombatValue: (key, value) => state.addCombatValue(key, value),
    multiplyResourceCost: (type, multiplier) => state.multiplyResourceCost(type, multiplier),
    addSpendRequirement: requirement => state.addSpendRequirement(requirement)
  });
  return state;
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
  const resolvedToken = token ?? attackerToken?.object ?? attackerToken ?? null;
  const resolvedActor = actor ?? resolvedToken?.actor ?? weapon?.actor ?? null;
  const normalizedActionKey = String(actionKey ?? "").trim();
  if (!resolvedActor || !weapon || !normalizedActionKey) return 0;
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
  return collectWeaponActionModifierState(context).getEnergyCost({ attackCount: normalizedAttackCount });
}

export function registerWeaponAttackSocket() {
  game.socket.on(WEAPON_ATTACK_SOCKET, handleWeaponAttackSocketMessage);
  Hooks.on("canvasReady", clearRemoteAttackPreviews);
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
  constructor() {
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    this.entries = [];
    getAttackPreviewLayer().addChild(this.container);
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
  }

  destroy() {
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
  skipActionPointCost = false,
  ignoreReactionLock = false,
  finishAfterAttack = false,
  suppressGenericEventReactions = false
} = {}) {
  if (!ignoreReactionLock && isReactionSystemLocked()) return undefined;
  if (!token?.actor || !weapon || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) return undefined;
  if (isActorUnableToAct(token.actor)) return undefined;
  if (!getWeaponAttackData(weapon, weaponFunctionId)?.enabled) return undefined;
  if (!hasWeaponAction(weapon, actionKey, weaponFunctionId)) return undefined;
  if (isWeaponActionBlocked(token.actor, actionKey)) return undefined;
  if (isWeaponPlacementDisabled(token.actor, weapon)) return undefined;
  if (!skipActionPointCost && !hasRequiredWeaponActionPoints(token.actor, weapon, actionKey, weaponFunctionId)) return undefined;

  if (activeAttack && !cancelWeaponAttack({ ignoreReactionLock })) return undefined;
  const controller = new WeaponAttackController(token, weapon, actionKey, weaponFunctionId, attackModifier, {
    originOverride,
    onBeforeExecute,
    onProcessingStarted,
    onDestroy,
    chainRef,
    damageHubOperationRef,
    skipActionPointCost,
    ignoreReactionLock,
    finishAfterAttack,
    suppressGenericEventReactions
  });
  if (!controller.hasRequiredWeaponResources(getActionAttackCount(weapon, actionKey, weaponFunctionId))) return undefined;
  activeAttack = controller;
  activeAttack.activate();
  return activeAttack;
}

export function startWeaponAttackAndWait(options = {}) {
  const timeoutMs = Math.max(1000, Math.trunc(Number(options?.timeoutMs) || 120000));
  return new Promise(resolve => {
    let completed = false;
    let timeoutId = null;
    const suspendedAttack = options?.suspendActiveAttack ? activeAttack : null;
    if (suspendedAttack) {
      suspendedAttack.suppressPreview();
      activeAttack = null;
    }
    const restoreSuspendedAttack = () => {
      if (!suspendedAttack || suspendedAttack.destroyed || activeAttack) return;
      activeAttack = suspendedAttack;
      if (!suspendedAttack.processing && !suspendedAttack.finishRequested) suspendedAttack.resumePreview();
    };
    const finish = value => {
      if (completed) return;
      completed = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      restoreSuspendedAttack();
      resolve(Boolean(value));
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
        Boolean(destroyed?.lastResolvedAttackOutcome) || destroyed?.attackCheckCount > 0
      )
    });
    if (!controller) {
      restoreSuspendedAttack();
      return finish(false);
    }
    timeoutId = window.setTimeout(() => {
      if (activeAttack === controller) activeAttack = null;
      controller.destroy();
      finish(false);
    }, timeoutMs);
  });
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
    if (!entry.weapon || !hasItemFunction(entry.weapon, ITEM_FUNCTIONS.weapon)) return undefined;
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
      const actionPointCost = Math.max(0, ...captured.map(entry => getWeaponActionPointCost(actor, entry.weapon, entry.actionKey, entry.weaponFunctionId)));
      if (isCombatActionPointSpendingActive(actor) && actionPointCost > 0 && !canSpendCombatActionPoints(actor, actionPointCost, { label: "действия" })) return false;
      if (typeof spendEnergy === "function" && (await spendEnergy()) === false) return false;
      if (isCombatActionPointSpendingActive(actor) && actionPointCost > 0) await spendCombatActionPoints(actor, actionPointCost);
      const results = await Promise.allSettled(captured.map(selection => executeCapturedWeaponAttack(selection, {
        skipActionPointCost: true,
        reactionCoordinator
      })));
      for (const result of results) {
        if (result.status === "rejected") console.error("Fallout MaW | Dual weapon attack execution failed", result.reason);
      }
      await reactionCoordinator.drain();
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
    if (index === 0 && !activeDualWeaponAttack) activeDualWeaponAttack = new DualWeaponAttackPreview();
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
    if (!entry.weapon || !hasItemFunction(entry.weapon, ITEM_FUNCTIONS.weapon)) return undefined;
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
  if (!game.user?.isGM && !getResponsibleGM()) {
    ui.notifications.warn(`${label}: нет активного GM для выполнения атак.`);
    return createCommandedAttackResult({ reason: "missingGM" });
  }
  if (!authorityContext || String(authorityContext?.kind ?? "") !== "abilityAction") {
    return createCommandedAttackResult({ reason: "missingAuthorityContext" });
  }
  const entries = normalizeCommandedWeaponAttackEntries(attacks);
  if (!entries.length || !validateCommandedWeaponAttackEntries(entries)) {
    return createCommandedAttackResult({ reason: "invalidAttacks" });
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
    const selection = await captureCommandedWeaponAttackSelection(entries[index], {
      label,
      index,
      count: entries.length
    });
    if (!selection) {
      onCancel?.();
      return createCommandedAttackResult({
        started: true,
        cancelled: true,
        reason: "captureCancelled"
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
    if (!entry.weapon || !hasItemFunction(entry.weapon, ITEM_FUNCTIONS.weapon)) return false;
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
  count = 1
} = {}) {
  if (activeAttack && !cancelWeaponAttack()) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    let captured = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value ?? null);
    };
    const controller = new WeaponAttackController(
      entry.token,
      entry.weapon,
      entry.actionKey,
      entry.weaponFunctionId,
      null,
      {
        skipActionPointCost: true,
        captureOnly: true,
        ignoreReactionLock: true,
        onCapture: selection => {
          captured = true;
          finish(selection);
        },
        onDestroy: () => queueMicrotask(() => {
          if (!captured) finish(null);
        })
      }
    );
    const attackCount = getActionAttackCount(entry.weapon, entry.actionKey, entry.weaponFunctionId);
    if (!controller.hasRequiredWeaponResources(attackCount)) {
      controller.destroy();
      finish(null);
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
    this.onCancel = typeof onCancel === "function" ? onCancel : null;
    this.onBeforeExecute = typeof onBeforeExecute === "function" ? onBeforeExecute : null;
    this.onComplete = typeof onComplete === "function" ? onComplete : null;
    this.chainRef = chainRef ?? null;
    this.authorityContext = authorityContext ?? null;
    this.events = {
      move: event => this.onMove(event),
      pointerDown: event => this.onPointerDown(event),
      keyDown: event => this.onKeyDown(event),
      tick: () => this.onTick()
    };
  }

  createEntry(entry = {}, index = 0) {
    const shape = new PIXI.Graphics();
    const targetMarkers = new PIXI.Graphics();
    const focusedTargetMarker = new PIXI.Graphics();
    this.container.addChild(shape, targetMarkers, focusedTargetMarker);
    return {
      ...entry,
      index,
      previewId: `${this.id}:${index}`,
      previewBroadcasted: false,
      lastBroadcastPreviewState: null,
      pointer: null,
      geometry: null,
      lockedGeometry: null,
      targetUuid: "",
      selectedLimbKey: "",
      directionKey: "",
      mode: "current",
      locked: false,
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
    getAttackPreviewLayer().addChild(this.container);
    canvas.stage.on("mousemove", this.events.move);
    document.addEventListener("pointerdown", this.events.pointerDown, { capture: true });
    document.addEventListener("keydown", this.events.keyDown, { capture: true });
    canvas.app?.ticker?.add?.(this.events.tick);
    ui.notifications.info(`${this.label}: клик фиксирует луч, Esc отменяет.`);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    canvas.stage.off("mousemove", this.events.move);
    document.removeEventListener("pointerdown", this.events.pointerDown, { capture: true });
    document.removeEventListener("keydown", this.events.keyDown, { capture: true });
    canvas.app?.ticker?.remove?.(this.events.tick);
    this.clearBroadcastPreviews();
    this.container.destroy({ children: true });
    if (activeCommandedAttack === this) activeCommandedAttack = null;
  }

  onMove(event) {
    if (this.processing) return;
    event.stopPropagation();
    this.pointer = event.data.getLocalPosition(getAttackPreviewLayer());
    this.refresh();
  }

  onTick() {
    if (this.processing || this.destroyed) return;
    for (const entry of this.entries) this.drawFocusedTargetMarkerForEntry(entry, performance.now());
  }

  onKeyDown(event) {
    if (event.key !== "Escape" || this.processing) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    this.cancel();
  }

  onPointerDown(event) {
    if (event.button !== 0 || this.processing || !isCanvasViewEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    this.updatePointerFromClientEvent(event);
    const entry = this.entries.find(entry => !entry.locked);
    if (!entry) return;
    if (!this.lockEntry(entry)) return;
    if (this.entries.every(entry => entry.locked)) void this.execute();
  }

  updatePointerFromClientEvent(event) {
    if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return;
    this.pointer = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    this.refresh();
  }

  lockEntry(entry) {
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
    let geometry = getAttackGeometry(entry.weapon, entry.actionKey, entry.token, origin, pointer, entry.weaponFunctionId);
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
      includeDead: isVolleyAttackAction(entry.weapon, entry.actionKey, entry.weaponFunctionId)
    });
    entry.hoveredTarget = MELEE_ACTION_KEYS.has(entry.actionKey)
      ? getAimedTargetUnderPointer(pointer, potentialTargets)
      : null;
    entry.trajectoryAimTarget = isVolleyAttackAction(entry.weapon, entry.actionKey, entry.weaponFunctionId)
      ? getVolleyTrajectoryAimTarget(entry.token, geometry, { includeAttacker: true, includeDead: true })
      : (entry.hoveredTarget ?? potentialTargets.at(0) ?? null);
    geometry.aimPoint = entry.trajectoryAimTarget
      ? selectAttackGeometryAimPoint(entry.token, entry.trajectoryAimTarget, geometry)
      : null;
    if (isVolleyAttackAction(entry.weapon, entry.actionKey, entry.weaponFunctionId) && geometry.aimPoint) {
      geometry = aimVolleyGeometryAtPoint(entry.token, geometry, geometry.aimPoint);
      potentialTargets = getPotentialTargets(entry.token, geometry, { includeAttacker: true, includeDead: true });
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
      if (!target?.actor) {
        ui.notifications.warn(`${entry.token?.name ?? entry.token?.actor?.name ?? this.label}: нет цели для удара.`);
        return null;
      }
      const directions = getEnabledMeleeDirections(entry.weapon, entry.actionKey, entry.weaponFunctionId);
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
    const projectileCount = getBurstProjectileCount(attackCount, getWeaponPelletCount(entry.weapon, entry.weaponFunctionId));
    return buildBurstTargetRanges(entry.token, entry.geometry, entry.targets, projectileCount);
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
    drawTargetMarkers(entry.targetMarkers, entry.targets, null, time, entry.burstRanges);
    this.drawFocusedTargetMarkerForEntry(entry, time);
  }

  clearEntryTargetMarkers(entry) {
    clearTargetMarkerLayer(entry.targetMarkers);
    clearTargetMarkerLayer(entry.focusedTargetMarker);
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
    this.destroy();
    this.onCancel?.();
    ui.notifications.info(`${this.label}: отменено.`);
    return true;
  }

  async execute() {
    if (this.processing) return false;
    this.processing = true;
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
  if (game.user?.isGM) return processCommandedWeaponAttackSelections(serialized, {
    chainRef,
    authorityContext,
    senderUserId: game.user?.id ?? ""
  });
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для выполнения командной атаки.");
    return createCommandedAttackResult({ reason: "missingGM" });
  }
  return requestCommandedWeaponAttackOperation("executeCommandedAttacks", {
    selections: serialized,
    chainRef,
    authorityContext
  });
}

async function preflightCommandedWeaponAttackSelections(selections = [], {
  chainRef = null,
  authorityContext = null
} = {}) {
  const serialized = (Array.isArray(selections) ? selections : []).filter(selection => selection?.tokenUuid && selection?.weaponUuid);
  if (!serialized.length || !authorityContext) return { ok: false, reason: "invalidPreflight" };
  if (game.user?.isGM) return processCommandedWeaponAttackSelections(serialized, {
    chainRef,
    authorityContext,
    senderUserId: game.user?.id ?? "",
    validateOnly: true
  });
  if (!getResponsibleGM()) return { ok: false, reason: "missingGM" };
  return requestCommandedWeaponAttackOperation("preflightCommandedAttacks", {
    selections: serialized,
    chainRef,
    authorityContext
  });
}

function requestCommandedWeaponAttackOperation(action, {
  selections = [],
  chainRef = null,
  authorityContext = null
} = {}) {
  const gm = getResponsibleGM();
  if (!gm) return Promise.resolve({ ok: false, reason: "missingGM" });
  const requestId = foundry.utils.randomID();
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      pendingCommandedAttackRequests.delete(requestId);
      resolve({ ok: false, reason: "authorityTimeout" });
    }, COMMANDED_ATTACK_SOCKET_TIMEOUT_MS);
    pendingCommandedAttackRequests.set(requestId, { resolve, timeout });
    game.socket.emit(WEAPON_ATTACK_SOCKET, {
      scope: WEAPON_ATTACK_SOCKET_SCOPE,
      action,
      requestId,
      gmUserId: gm.id,
      senderUserId: game.user?.id ?? "",
      chainRef,
      authorityContext,
      selections
    });
  });
}

async function processCommandedWeaponAttackSocketRequest(payload = {}) {
  let result = { ok: false, reason: "authorityError" };
  try {
    result = await processCommandedWeaponAttackSelections(payload.selections ?? [], {
      chainRef: payload.chainRef ?? null,
      authorityContext: payload.authorityContext ?? null,
      senderUserId: payload.senderUserId ?? "",
      validateOnly: payload.action === "preflightCommandedAttacks"
    });
  } catch (error) {
    console.error("Fallout MaW | Commanded weapon attack authority operation failed", error);
  }
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "commandedAttacksResult",
    requestId: payload.requestId,
    targetUserId: payload.senderUserId ?? "",
    result,
    senderUserId: game.user?.id ?? ""
  });
}

async function processCommandedWeaponAttackSelections(selections = [], {
  chainRef = null,
  authorityContext = null,
  senderUserId = "",
  validateOnly = false
} = {}) {
  if (authorityContext && !(await validateCommandedAbilityAuthority({
    authorityContext,
    selections,
    senderUserId
  }))) return { ok: false, reason: "authorityRejected" };
  const resolved = [];
  for (const selection of selections ?? []) {
    const tokenDocument = await fromUuid(String(selection.tokenUuid ?? ""));
    const token = tokenDocument?.object ?? (authorityContext ? null : tokenDocument) ?? null;
    const weapon = await fromUuid(String(selection.weaponUuid ?? ""));
    if (!token?.actor || !weapon) {
      return { ok: false, reason: authorityContext ? "gmSceneUnavailable" : "missingDocument" };
    }
    if (selection.targetUuid) {
      const targetDocument = await fromUuid(String(selection.targetUuid));
      if (!targetDocument?.object && authorityContext) return { ok: false, reason: "gmSceneUnavailable" };
    }
    resolved.push({
      token,
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
    if (!hasItemFunction(selection.weapon, ITEM_FUNCTIONS.weapon)) return { ok: false, reason: "invalidWeapon" };
    if (isActorUnableToAct(selection.token.actor)) return { ok: false, reason: "unableToAct" };
    if (!getWeaponAttackData(selection.weapon, selection.weaponFunctionId)?.enabled) return { ok: false, reason: "disabledWeapon" };
    if (!hasWeaponAction(selection.weapon, selection.actionKey, selection.weaponFunctionId)) return { ok: false, reason: "missingAction" };
    if (getWeaponActionBlockState(selection.token.actor, selection.actionKey).blocked) return { ok: false, reason: "blockedAction" };
    if (isWeaponPlacementDisabled(selection.token.actor, selection.weapon)) return { ok: false, reason: "disabledPlacement" };
    const attackCount = getActionAttackCount(selection.weapon, selection.actionKey, selection.weaponFunctionId);
    if (!hasRequiredWeaponResources(selection.weapon, attackCount, selection.weaponFunctionId)) return { ok: false, reason: "weaponResources" };
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
    chainRef
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
  if (!executedCount) await rollbackCommandedActionPointCosts(actionPointReceipts.receipts, chainRef);
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
      const before = getStrictActionPointState(actor);
      if (!before || before.current < cost) throw new Error("Action point state changed before spend.");
      await spendStrictActionPoints(actor, cost, {
        source: "abilityAction",
        actionKey: "commandedAttack",
        chainRef
      });
      const after = getStrictActionPointState(actor);
      if (!after || after.current !== before.current - cost) {
        throw new Error("Action point spend was not applied exactly.");
      }
      receipts.push({ actor, before });
    }
    return { ok: true, receipts };
  } catch (error) {
    console.error("Fallout MaW | Commanded attack action point spend failed", error);
    await rollbackCommandedActionPointCosts(receipts, chainRef);
    return { ok: false, receipts: [] };
  }
}

async function rollbackCommandedActionPointCosts(receipts = [], chainRef = null) {
  for (const receipt of [...receipts].reverse()) {
    const actor = receipt?.actor;
    const before = receipt?.before;
    if (!actor || !before) continue;
    try {
      await actor.update({
        [`system.resources.actionPoints.value`]: before.current,
        [`system.resources.actionPoints.spent`]: Math.max(0, before.max - before.current)
      }, chainRef ? {
        chainRef,
        falloutMawSystemEventChainRef: chainRef,
        falloutMawCommandedAttackRollback: true
      } : { falloutMawCommandedAttackRollback: true });
    } catch (error) {
      console.error("Fallout MaW | Failed to roll back commanded attack action points", error);
    }
  }
}

async function validateCommandedAbilityAuthority({
  authorityContext = {},
  selections = [],
  senderUserId = ""
} = {}) {
  if (String(authorityContext?.kind ?? "") !== "abilityAction") return false;
  const sender = game.users?.get(String(senderUserId ?? "")) ?? null;
  const sourceActor = await fromUuid(String(authorityContext?.actorUuid ?? ""));
  const sourceTokenDocument = await fromUuid(String(authorityContext?.sourceTokenUuid ?? ""));
  if (!sender || !sourceActor || !sourceTokenDocument?.actor) return false;
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
  const sourceSceneUuid = String(sourceTokenDocument.parent?.uuid ?? "");
  const seenActors = new Set();
  for (const targetTokenDocument of targetTokenDocuments) {
    const targetActor = targetTokenDocument?.actor;
    if (!targetActor || String(targetTokenDocument.parent?.uuid ?? "") !== sourceSceneUuid) return false;
    if (!sender.isGM && targetTokenDocument.hidden) return false;
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
    if (!(await validateCommandedAttackSelectionGeometry(selection, tokenDocument.object, weapon))) return false;
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

async function validateCommandedAttackSelectionGeometry(selection = {}, token = null, weapon = null) {
  if (!token?.actor || !weapon) return false;
  if (!isFiniteCommandedPoint(selection?.pointer)) return false;
  const submittedGeometry = deserializeGeometry(selection?.lockedGeometry ?? selection?.geometry);
  if (!submittedGeometry || !isFiniteCommandedPoint(submittedGeometry.origin) || !isFiniteCommandedPoint(submittedGeometry.end)) {
    return false;
  }

  const actionKey = String(selection?.actionKey ?? "");
  const weaponFunctionId = String(selection?.weaponFunctionId || ITEM_FUNCTIONS.weapon);
  const controller = new WeaponAttackController(token, weapon, actionKey, weaponFunctionId, null, {
    skipActionPointCost: true,
    ignoreReactionLock: true
  });
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
      return Boolean(resolveAimedTargetSelection(selectedTarget?.actor, String(selection?.selectedLimbKey ?? "")));
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
    controller.clearBurstTargetPreviewTimer();
    controller.container.destroy({ children: true });
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
    if (!weapon || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) return false;
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
  reportedActionPointCost = null,
  reactionCoordinator = null,
  chainRef = null
} = {}) {
  const token = selection?.token ?? null;
  const weapon = selection?.weapon ?? null;
  const actionKey = String(selection?.actionKey ?? "");
  const weaponFunctionId = String(selection?.weaponFunctionId || ITEM_FUNCTIONS.weapon);
  if (!token?.actor || !weapon || !actionKey) return false;

  const controller = new WeaponAttackController(token, weapon, actionKey, weaponFunctionId, null, {
    skipActionPointCost,
    reportedActionPointCost,
    reactionCoordinator,
    chainRef
  });
  controller.pointer = deserializePoint(selection.pointer);
  controller.geometry = deserializeGeometry(selection.geometry);
  controller.lockedGeometry = selection.lockedGeometry ?? serializeGeometry(controller.geometry);
  controller.selectedLimbKey = String(selection.selectedLimbKey ?? "");

  const targetDocument = selection.targetUuid ? await fromUuid(selection.targetUuid) : null;
  const selectedTarget = targetDocument?.object ?? targetDocument ?? null;
  try {
    if (selection.mode === "aimed") {
      controller.selectedTarget = selectedTarget;
      controller.aimedMode = "limb";
      controller.refresh(true);
      await controller.performAimedAttack(selection.selectedLimbKey);
      return didCapturedWeaponAttackExecute(controller);
    }
    if (selection.mode === "directed") {
      controller.selectedTarget = selectedTarget;
      controller.aimedMode = "direction";
      controller.refresh(true);
      await controller.performDirectedAttack(selection.directionKey);
      return didCapturedWeaponAttackExecute(controller);
    }
    if (selection.mode === "push") {
      controller.refresh(true);
      await controller.performPushAttack(selection.selectedStrength);
      return didCapturedWeaponAttackExecute(controller);
    }
    controller.refresh(true);
    await controller.performCurrentAttack();
    return didCapturedWeaponAttackExecute(controller);
  } finally {
    controller.destroy();
  }
}

function didCapturedWeaponAttackExecute(controller = null) {
  return Boolean(controller?.lastResolvedAttackOutcome) || Number(controller?.attackCheckCount) > 0;
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
  skipActionPointCost = false,
  ignoreReactionLock = false,
  suspendActiveAttack = false,
  suppressGenericEventReactions = false
} = {}) {
  if (!ignoreReactionLock && isReactionSystemLocked()) return false;
  if (!attackerToken?.actor || !targetToken?.actor || !weapon || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) return false;
  if (isActorUnableToAct(attackerToken.actor)) return false;
  if (!getWeaponAttackData(weapon, weaponFunctionId)?.enabled) return false;
  if (!hasWeaponAction(weapon, actionKey, weaponFunctionId)) return false;
  if (isWeaponActionBlocked(attackerToken.actor, actionKey)) return false;
  if (isWeaponPlacementDisabled(attackerToken.actor, weapon)) return false;
  if (!skipActionPointCost && !hasRequiredWeaponActionPoints(attackerToken.actor, weapon, actionKey, weaponFunctionId)) return false;

  const suspendedAttack = suspendActiveAttack ? activeAttack : null;
  if (suspendedAttack) {
    suspendedAttack.suppressPreview();
    activeAttack = null;
  } else if (activeAttack && !cancelWeaponAttack({ ignoreReactionLock })) {
    return false;
  }
  const controller = new WeaponAttackController(attackerToken, weapon, actionKey, weaponFunctionId, attackModifier, {
    chainRef,
    damageHubOperationRef,
    onBeforeExecute,
    skipActionPointCost,
    ignoreReactionLock,
    finishAfterAttack: true,
    suppressGenericEventReactions
  });
  if (!controller.hasRequiredWeaponResources(getActionAttackCount(weapon, actionKey, weaponFunctionId))) {
    if (suspendedAttack && !suspendedAttack.destroyed && !activeAttack) {
      activeAttack = suspendedAttack;
      if (!suspendedAttack.processing && !suspendedAttack.finishRequested) suspendedAttack.resumePreview();
    }
    return false;
  }
  try {
    activeAttack = controller;
    controller.attachPreview();
    return await controller.executeAgainstToken(targetToken);
  } finally {
    if (activeAttack === controller) activeAttack = null;
    controller.destroy();
    if (suspendedAttack && !suspendedAttack.destroyed && !activeAttack) {
      activeAttack = suspendedAttack;
      if (!suspendedAttack.processing && !suspendedAttack.finishRequested) suspendedAttack.resumePreview();
    }
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
  if (!hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) return [];
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
  timeoutMs = 120000,
  suppressGenericEventReactions = false
} = {}) {
  const normalizedActionKey = ["aimedShot", "aimedMeleeAttack"].includes(actionKey) ? actionKey : "";
  if (!attackerToken?.actor || !targetToken?.actor || !weapon || isActorUnableToAct(attackerToken.actor)) return false;
  if (!normalizedActionKey || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon) || !hasWeaponAction(weapon, normalizedActionKey, weaponFunctionId)) return false;
  if (isWeaponActionBlocked(attackerToken.actor, normalizedActionKey)) return false;
  if (isWeaponPlacementDisabled(attackerToken.actor, weapon)) return false;
  const suspendedAttack = activeAttack;
  if (suspendedAttack) {
    suspendedAttack.suppressPreview();
    activeAttack = null;
  }

  return new Promise(resolve => {
    let completed = false;
    let timeoutId = null;
    const finish = value => {
      if (completed) return;
      completed = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      if (suspendedAttack && !suspendedAttack.destroyed && (!activeAttack || activeAttack === controller)) {
        activeAttack = suspendedAttack;
        if (!suspendedAttack.processing && !suspendedAttack.finishRequested) suspendedAttack.resumePreview();
      }
      resolve(Boolean(value));
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
        Boolean(destroyed?.lastResolvedAttackOutcome) || destroyed?.attackCheckCount > 0
      ),
      finishAfterAttack: true,
      constrainedTarget: true,
      skipActionPointCost: true,
      ignoreReactionLock: true,
      suppressGenericEventReactions
    });
    if (!controller.hasRequiredWeaponResources(getActionAttackCount(weapon, normalizedActionKey, weaponFunctionId))) {
      finish(false);
      return;
    }

    controller.pointer = getTokenAimPoint(targetToken);
    controller.refresh(true);
    if (!controller.geometry || !controller.targets.includes(targetToken)) {
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

export function startForcedAimedAttackSelection({ label = "Контр-снайпер", ...options } = {}) {
  return startConstrainedAimedAttackSelection({
    ...options,
    attackModifier: createCounterSniperAttackModifier({ label })
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
  if (!normalizedActionKey || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon) || !hasWeaponAction(weapon, normalizedActionKey, weaponFunctionId)) return false;
  if (isWeaponPlacementDisabled(attacker.actor, weapon)) return false;
  if (getMissingWeaponResourceCost(weapon, getActionAttackCount(weapon, normalizedActionKey, weaponFunctionId), weaponFunctionId)) return false;
  const origin = getTokenAimPoint(attacker);
  const targetPoint = getTokenAimPoint(target);
  const geometry = getAttackGeometry(weapon, normalizedActionKey, attacker, origin, targetPoint, weaponFunctionId);
  if (!geometry || !selectTargetTrajectoryAimPoint(attacker, target, geometry)) return false;
  return canTokenPhysicallySeeTarget(attacker, target);
}

export function getDelayedVolleyWeaponState(weapon = null, weaponFunctionId = "") {
  const flag = weapon?.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_FLAG) ?? {};
  const delaySeconds = weapon && hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)
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
  const regionRequest = buildDelayedVolleyExplosionRegionRequest({
    sceneId,
    delayedThrownItemId,
    explodeAtWorldTime,
    weapon,
    weaponFunctionId,
    actionKey: VOLLEY_ACTION_KEY,
    attackerToken: token,
    finalGeometries: [geometry],
    blastOutcomes: [{}],
    baseDamage: getWeaponDamage(weapon, weaponFunctionId, {
      actor: token.actor,
      actorToken: token,
      token,
      actionKey: VOLLEY_ACTION_KEY,
      weaponActionKey: VOLLEY_ACTION_KEY,
      weaponFunctionId
    }),
    attachmentTokenId: token.id
  });
  const region = await requestCreateDelayedVolleyExplosionRegion(regionRequest);
  if (!region) return false;
  await weapon.update({
    [`flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_FLAG}`]: {
      id: delayedThrownItemId,
      explodeAtWorldTime
    }
  });
  return true;
}

export function buildWeaponExplosionDamageRequests({
  targetToken = null,
  center = null,
  radiusPixels = 0,
  baseDamage = 0,
  pelletCount = 1,
  damageTypes = [],
  penetrationPower = 0,
  source = {},
  damageModifier = null
} = {}) {
  const actor = targetToken?.actor;
  if (!actor || !center) return [];
  const falloff = Number(radiusPixels) > 0
    ? getVolleyDamageFalloff(targetToken, { end: center, radiusPixels })
    : 1;
  const falloffDamage = Math.round(Math.max(0, Number(baseDamage) || 0) * falloff);
  const damageAmount = Math.max(0, Math.round(Number(
    typeof damageModifier === "function" ? damageModifier(falloffDamage) : falloffDamage
  ) || 0));
  const pelletDamages = distributeIntegerAmount(damageAmount, Array(Math.max(1, toInteger(pelletCount))).fill(1));
  const normalizedTypes = normalizeExplosionDamageTypes(damageTypes);
  const requests = [];

  for (let pelletIndex = 0; pelletIndex < pelletDamages.length; pelletIndex += 1) {
    const pelletDamage = pelletDamages[pelletIndex] ?? 0;
    if (pelletDamage <= 0) continue;
    const limbKey = selectRandomLimbKey(actor);
    if (!limbKey) continue;
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
          penetrationPower,
          pelletIndex
        }
      });
    }
  }
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

class WeaponAttackController {
  constructor(token, weapon, actionKey, weaponFunctionId = "", attackModifier = null, options = {}) {
    this.token = token;
    this.weapon = weapon;
    this.actionKey = actionKey;
    this.weaponFunctionId = weaponFunctionId || ITEM_FUNCTIONS.weapon;
    this.attackModifier = normalizeWeaponAttackModifier(attackModifier);
    this.originOverride = normalizeAttackOriginOverride(options.originOverride);
    this.onBeforeExecute = typeof options.onBeforeExecute === "function" ? options.onBeforeExecute : null;
    this.onProcessingStarted = typeof options.onProcessingStarted === "function" ? options.onProcessingStarted : null;
    this.onDestroy = typeof options.onDestroy === "function" ? options.onDestroy : null;
    this.chainRef = options.chainRef ?? null;
    this.damageHubOperationRef = String(options.damageHubOperationRef ?? "").trim();
    this.skipActionPointCost = Boolean(options.skipActionPointCost);
    this.reportedActionPointCost = options.reportedActionPointCost === null
      || options.reportedActionPointCost === undefined
      ? null
      : Math.max(0, toInteger(options.reportedActionPointCost));
    this.ignoreReactionLock = Boolean(options.ignoreReactionLock);
    this.suppressGenericEventReactions = Boolean(options.suppressGenericEventReactions);
    this.captureOnly = Boolean(options.captureOnly);
    this.onCapture = typeof options.onCapture === "function" ? options.onCapture : null;
    this.reactionCoordinator = options.reactionCoordinator?.run ? options.reactionCoordinator : null;
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
    this.meleeAction = MELEE_ACTION_KEYS.has(actionKey);
    this.aimedShot = isAimedShotAction(weapon, actionKey, this.weaponFunctionId);
    this.ignoreAimedObstructions = this.aimedShot
      && hasActorFixedAbilityFunction(this.token?.actor, ABILITY_FIXED_FUNCTION_KEYS.hawkEye);
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
    this.chanceMenu = null;
    this.rightClickCancelCandidate = null;
    this.attackId = foundry.utils.randomID();
    this.autoCoverActorUuids = new Set();
    this.lastAutoCoverSignature = "";
    this.pendingCriticalFailureResourceCosts = [];
    this.weaponActionModifierState = null;
    this.lastPreviewBroadcastAt = 0;
    this.lastBroadcastPreviewState = null;
    this.lastTargetMarkerRenderState = null;
    this.attackCanceledByReaction = false;
    this.attackCommitted = false;
    this.lastResolvedAttackOutcome = null;
    this.attackCheckCount = 0;
    this.attackCheckEventSequence = 0;
    this.skillCheckCollectors = new Set();
    this.reactionTargetKeys = new Set();
    this.attackedTargetActorUuids = new Set();
    this.attackedTargetTokenUuids = new Set();
    this.dodgeExposure = createDodgeAttackExposureTracker();
    this.burstTargetPreview = createBurstTargetPreviewState();
    this.burstPreviewStabilizeTimeout = null;
    this.volleyAction = isVolleyAttackAction(this.weapon, this.actionKey, this.weaponFunctionId);
    this.events = {
      move: event => this.onMove(event),
      confirm: event => this.onConfirm(event),
      cancel: event => this.onCancel(event),
      pointerDown: event => this.onPointerDown(event),
      tick: () => this.onTick()
    };
  }

  activate() {
    this.attachPreview();
    if (isWhirlwindAttackModifier(this.attackModifier)) this.pointer = getTokenAimPoint(this.token);
    canvas.stage.on("mousemove", this.events.move);
    document.addEventListener("pointerdown", this.events.pointerDown, { capture: true });
    canvas.app.ticker.add(this.events.tick);
    canvas.app.view.oncontextmenu = this.events.cancel;
  }

  attachPreview() {
    if (this.container.parent) return;
    this.container.eventMode = "none";
    getAttackPreviewLayer().addChild(this.container);
  }

  async notifyAttackResolved({ attempted = true, killedTargetUuids = [], damageResults = [] } = {}) {
    if (!attempted) return;
    const actionPointCost = this.reportedActionPointCost ?? (
      isCombatActionPointSpendingActive(this.token?.actor)
        ? getWeaponActionPointCost(this.token?.actor, this.weapon, this.actionKey, this.weaponFunctionId)
        : 0
    );
    const outcome = {
      attackerUuid: this.token?.actor?.uuid ?? "",
      actorUuid: this.token?.actor?.uuid ?? "",
      tokenUuid: this.token?.document?.uuid ?? "",
      weaponUuid: this.weapon?.uuid ?? "",
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      attackId: this.attackId,
      selectedLimbKey: String(this.selectedLimbKey ?? ""),
      selectedTargetActorUuid: this.selectedTarget?.actor?.uuid ?? "",
      actionPointCost,
      targetActorUuids: Array.from(this.attackedTargetActorUuids),
      targetTokenUuids: Array.from(this.attackedTargetTokenUuids),
      killedTargetUuids: Array.from(new Set((killedTargetUuids ?? []).map(uuid => String(uuid ?? "").trim()).filter(Boolean))),
      canceledByReaction: Boolean(this.attackCanceledByReaction),
      attackCheckCount: Math.max(0, toInteger(this.attackCheckCount)),
      damageResults: Array.isArray(damageResults) ? damageResults : [],
      modifierState: this.getWeaponActionModifierState(),
      reactionCoordinator: this.reactionCoordinator,
      chainRef: this.chainRef,
      damageHubOperationRef: this.damageHubOperationRef,
      senderUserId: game.user?.id ?? ""
    };
    this.lastResolvedAttackOutcome = outcome;
    await publishWeaponAttackResolved(outcome);
    return outcome;
  }

  async notifyAttackCheckResolved(outcome = null, completionCollector = null) {
    const notify = async () => {
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
    const collector = createSkillCheckBatchCollector(options);
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

  createWeaponAttackSkillCheckContext(targetToken = null, extra = {}) {
    return {
      actorToken: this.token,
      targetToken,
      chainRef: this.chainRef,
      damageHubOperationRef: this.damageHubOperationRef,
      systemEventOperationId: this.attackId,
      weaponAttackId: this.attackId,
      weaponActionKey: this.actionKey,
      weaponData: getWeaponAttackData(this.weapon, this.weaponFunctionId),
      weaponActionModifierState: this.getWeaponActionModifierState(),
      suppressGenericEventReactions: this.suppressGenericEventReactions,
      ...getPostureAttackEdgeModifiers({
        attackerToken: this.token,
        targetToken,
        weapon: this.weapon,
        weaponFunctionId: this.weaponFunctionId
      }),
      ...extra
    };
  }

  stampAttackDamageSources(requests = []) {
    const attackId = String(this.attackId ?? "").trim();
    if (!attackId) return Array.isArray(requests) ? requests : [requests];
    return (Array.isArray(requests) ? requests : [requests]).filter(Boolean).map(request => ({
      ...request,
      source: {
        ...(request?.source ?? {}),
        attackId,
        chainRef: request?.source?.chainRef ?? this.chainRef,
        damageHubOperationRef: request?.source?.damageHubOperationRef ?? this.damageHubOperationRef,
        systemEventOperationId: String(request?.source?.systemEventOperationId ?? attackId)
      }
    }));
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
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(this.weapon, this.token, target, this.weaponFunctionId);
    if (direction) {
      return getDirectedAttackHitChance(this.token.actor, this.weapon, target.actor, {
        actionKey: this.actionKey,
        mode: direction.mode,
        limbKey,
        difficultyBonus: rangeDifficultyBonus,
        weaponFunctionId: this.weaponFunctionId,
        accuracyBonus: getWeaponAttackModifierAccuracyModifier(this.attackModifier)
      });
    }
    if (this.aimedShot) {
      const targetSelection = resolveAimedTargetSelection(target.actor, limbKey);
      const resolvedLimbKey = targetSelection?.limbKey ?? limbKey;
      const geometry = deserializeGeometry(this.lockedGeometry) ?? this.geometry;
      const aimPoint = geometry ? (selectTargetTrajectoryAimPoint(this.token, target, geometry) ?? getTokenAimPoint(target)) : null;
      const trajectory = geometry && aimPoint ? buildTrajectoryThroughPoint(this.token, geometry, aimPoint) : null;
      const blockerCount = this.ignoreAimedObstructions || !trajectory ? 0 : getAimedTargetBlockers(this.token, target, trajectory).length;
      return getAimedAttackHitChance(
        this.token.actor,
        this.weapon,
        target.actor,
        resolvedLimbKey,
        getAimedTargetBlockerBonus(blockerCount) + rangeDifficultyBonus,
        this.weaponFunctionId,
        this.actionKey,
        {
          innateDifficultyIgnorePercent: this.getWeaponActionModifierState().getOption("innateAimedDifficultyIgnorePercent"),
          ignoreCover: this.ignoreAimedObstructions,
          accuracyBonus: getWeaponAttackModifierAccuracyModifier(this.attackModifier)
        }
      );
    }
    return getGeneralAttackHitChance(this.token.actor, this.weapon, target.actor, {
      difficultyBonus: rangeDifficultyBonus
        + getBurstShotDifficultyBonus(this.weapon, this.actionKey, 0, this.weaponFunctionId, this.token.actor),
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
      accuracyBonus: getWeaponAttackModifierAccuracyModifier(this.attackModifier)
    });
  }

  async commitWeaponAttack(target, options = {}) {
    if (this.attackCommitted || !target?.actor || !target?.document?.uuid) return;
    this.attackCommitted = true;
    const originalHitChance = this.getOriginalHitChance(target, options);
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

  hasRequiredWeaponResources(multiplier = 1) {
    const attackCount = Math.max(1, toInteger(multiplier));
    const modifierState = this.getWeaponActionModifierState();
    if (!hasRequiredWeaponResources(this.weapon, attackCount, this.weaponFunctionId, { modifierState })) return false;
    return modifierState.canSpend(this.createWeaponActionModifierContext({ attackCount }));
  }

  async spendWeaponActionModifierCosts(attackCount = 1) {
    return this.getWeaponActionModifierState().spend(this.createWeaponActionModifierContext({
      attackCount: Math.max(1, toInteger(attackCount))
    }));
  }

  async resolveTargetReactions(target) {
    if (this.interruptForIncapacitation()) return true;
    if (this.attackCanceledByReaction || !target?.actor || !this.token?.actor || !this.weapon) return false;
    const targetKey = String(target.actor.uuid ?? target.document?.uuid ?? target.id ?? "");
    if (!targetKey) return false;
    const reactionKey = `${this.attackId}:${targetKey}`;
    if (this.reactionTargetKeys.has(reactionKey)) return false;
    this.reactionTargetKeys.add(reactionKey);
    if (target.actor.uuid) this.attackedTargetActorUuids.add(target.actor.uuid);
    if (target.document?.uuid) this.attackedTargetTokenUuids.add(target.document.uuid);
    const result = await this.requestReaction(REACTION_EVENT_KEYS.weaponAttackTargeted, {
      attackId: this.attackId,
      attackerActorUuid: this.token.actor.uuid,
      attackerTokenUuid: this.token.document?.uuid ?? "",
      targetActorUuid: target.actor.uuid,
      targetTokenUuid: target.document?.uuid ?? "",
      weaponUuid: this.weapon.uuid,
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId,
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
    this.shape.clear();
    this.meleeDirectionPreview.clear();
    this.clearTargetMarkers();
    this.removeLimbMenu();
    this.removeChanceMenu();
    broadcastAttackPreview({
      action: "clearPreview",
      attackId: this.attackId
    });
  }

  resumePreview() {
    if (this.destroyed) return;
    this.previewSuppressed = false;
    this.attachPreview();
    this.refresh(true);
  }

  canContinueAfterProcessing() {
    const actor = this.token?.actor ?? null;
    const weapon = actor?.items?.get?.(this.weapon?.id) ?? null;
    if (!actor || !weapon || isActorUnableToAct(actor)) return false;
    if (!hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) return false;
    if (!getWeaponAttackData(weapon, this.weaponFunctionId)?.enabled) return false;
    if (!hasWeaponAction(weapon, this.actionKey, this.weaponFunctionId)) return false;
    if (getWeaponActionBlockState(actor, this.actionKey).blocked) return false;
    if (isWeaponPlacementDisabled(actor, weapon)) return false;

    this.weapon = weapon;
    this.weaponActionModifierState = null;
    const attackCount = getActionAttackCount(weapon, this.actionKey, this.weaponFunctionId);
    const modifierState = this.getWeaponActionModifierState();
    if (getMissingWeaponResourceCost(weapon, attackCount, this.weaponFunctionId, { modifierState })) return false;
    if (!modifierState.canSpend(this.createWeaponActionModifierContext({ attackCount, silent: true }))) return false;
    if (!this.skipActionPointCost && !canSpendRequiredWeaponActionPoints(actor, weapon, this.actionKey, this.weaponFunctionId)) return false;
    return true;
  }

  completeProcessingCycle({ refresh = true } = {}) {
    this.processing = false;
    void this.abortSkillCheckCollectors();
    if (this.attackModifier?.finishAfterAttack || this.finishAfterAttack) this.finishRequested = true;
    if (!this.finishRequested && !this.attackCanceledByReaction && !this.canContinueAfterProcessing()) {
      this.finishRequested = true;
    }
    if (this.finishRequested || this.attackCanceledByReaction) {
      if (activeAttack === this) activeAttack = null;
      this.destroy();
      return true;
    }
    if (refresh) this.refresh(true);
    return false;
  }

  beginProcessingCycle() {
    if (this.processing) return false;
    this.processing = true;
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
    }
  }

  shouldSpendWeaponResourcesForAttempt() {
    return !this.attackCanceledByReaction || this.attackCheckCount > 0;
  }

  shouldPlayWeaponAnimationForAttempt() {
    return !this.attackCanceledByReaction || this.attackCheckCount > 0;
  }

  async playAttackAnimationsIfNeeded(trajectories = [], { attempted = true, delayMs = null } = {}) {
    if (!attempted || !this.shouldPlayWeaponAnimationForAttempt()) return;
    await this.playAttemptWeaponAnimations(trajectories, { delayMs });
  }

  async playAttemptWeaponAnimations(trajectories = [], { delayMs = null } = {}) {
    await playWeaponAttackAnimations({
      weapon: this.weapon,
      weaponFunctionId: this.weaponFunctionId,
      weaponData: getWeaponAttackData(this.weapon, this.weaponFunctionId),
      trajectories,
      delayMs: delayMs ?? getWeaponAttackAnimationDelay(this.weapon, this.weaponFunctionId)
    });
  }

  async spendCurrentAttackCosts({ attackCount = 1, trajectories = [], point = null, createSpentQuantityTile = true, delayedThrownItemId = "" } = {}) {
    this.spentQuantityItemData = null;
    if (this.shouldSpendWeaponResourcesForAttempt()) {
      if (!(await this.spendWeaponActionModifierCosts(attackCount))) return false;
      const modifierState = this.getWeaponActionModifierState();
      const spentQuantityItemData = getSpentQuantityItemData(this.weapon, attackCount, this.weaponFunctionId, { modifierState });
      this.spentQuantityItemData = spentQuantityItemData;
      await spendWeaponResources(this.weapon, attackCount, this.weaponFunctionId, this.pendingCriticalFailureResourceCosts, { modifierState });
      if (createSpentQuantityTile) {
        await createSpentQuantityItemTile({
          itemData: spentQuantityItemData,
          point,
          token: this.token,
          sourceItemUuid: this.weapon.uuid,
          delayedThrownItemId
        });
      }
    }
    await spendWeaponActionPoints(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId, {
      emitActionResolved: !this.attackCanceledByReaction,
      spendActionPoints: !this.skipActionPointCost,
      chainRef: this.chainRef,
      damageHubOperationRef: this.damageHubOperationRef
    });
    this.interruptForIncapacitation();
    return true;
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

    this.selectedTarget = targetToken;
    this.lockedGeometry = serializeGeometry(this.geometry);
    this.selectedLimbKey = this.requiresLimbSelection ? selectRandomWeightedLimbKey(targetToken.actor) : "";
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

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
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
    clearAttackAutoCoverSync(this.attackId);
    this.autoCoverActorUuids.clear();
    canvas.stage.off("mousemove", this.events.move);
    document.removeEventListener("pointerdown", this.events.pointerDown, { capture: true });
    canvas.app?.ticker?.remove?.(this.events.tick);
    if (canvas.app?.view?.oncontextmenu === this.events.cancel) canvas.app.view.oncontextmenu = null;
    this.removeLimbMenu();
    this.removeChanceMenu();
    this.clearBurstTargetPreviewTimer();
    broadcastAttackPreview({
      action: "clearPreview",
      attackId: this.attackId
    });
    this.container.destroy({ children: true });
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
    this.pointer = event.data.getLocalPosition(getAttackPreviewLayer());
    this.refresh();
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
    this.updatePointerFromClientEvent(event);
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
    event?.preventDefault?.();
    if (this.isInteractionLocked()) return false;
    if (this.processing) return false;
    if (this.isRightClickDragCancel(event)) {
      this.rightClickCancelCandidate = null;
      return false;
    }
    this.rightClickCancelCandidate = null;
    if (this.attackModifier?.preventCancel) return false;
    if (this.pushStrengthMaximum > 0) {
      this.cancelPushStrengthSelection();
      return false;
    }
    if (this.targetedAction && ["limb", "direction"].includes(this.aimedMode)) {
      if (this.constrainedTarget) {
        if (activeAttack === this) activeAttack = null;
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
    return Boolean(this.rightClickCancelCandidate?.dragged);
  }

  onTick() {
    if (isActorUnableToAct(this.token?.actor)) {
      this.interruptForIncapacitation();
      return;
    }
    if (this.processing || this.isInteractionLocked()) return;
    this.drawFocusedTargetMarkerForPreview(performance.now());
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
    this.destroy();
    await this.onCapture?.(selection);
    return true;
  }

  async performCurrentAttack() {
    if (this.interruptForIncapacitation()) return;
    if (this.targetedAction) return this.onAimedConfirm();
    if (!this.pointer) return;
    if (isWhirlwindAttackModifier(this.attackModifier)) return this.performWhirlwindAttack();
    if (this.actionKey === PUSH_ACTION_KEY) return this.preparePushAttack();
    if (this.volleyAction) return this.performVolleyAttack();
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    const pelletCount = getWeaponPelletCount(this.weapon, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) return;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId)) return;
    if (this.captureOnly) return this.captureAttackSelection({ mode: "current" });
    this.refresh(true);
    const originalTarget = this.trajectoryAimTarget;
    if (hasWeaponSpecialProperty(this.weapon, WEAPON_SPECIAL_PROPERTIES.hitAllConeTargets, this.weaponFunctionId)) {
      return this.performConeTargetsAttack({ attackCount, pelletCount });
    }
    if (this.actionKey === "burst") {
      this.beginProcessingCycle();
      if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
      if (originalTarget) await this.commitWeaponAttack(originalTarget);
      return this.performBurstAttack({ attackCount, pelletCount });
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
    const collectCheckMessages = forceBatchCheckMessage || pelletCount > 1 || getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, { actor: this.token.actor, actionKey: this.actionKey }) > 0;
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
        difficultyBonus: getBurstShotDifficultyBonus(this.weapon, this.actionKey, attackIndex, this.weaponFunctionId, this.token.actor),
        attackIndex,
        attackCount: totalAttackCount
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
        point: getAttackLandingPoint(trajectories, this.pointer)
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
    const targets = Array.from(new Set(this.targets ?? []))
      .filter(target => target && target !== this.token);
    if (!targets.length) {
      ui.notifications.warn(`${this.attackModifier?.label || this.weapon.name}: нет целей в радиусе атаки.`);
      return;
    }

    const plannedAttackCount = Math.max(1, targets.length);
    if (!this.hasRequiredWeaponResources(plannedAttackCount)) return;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId)) return;

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
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount: plannedAttackCount });

    const damageRequests = [];
    const damageResults = [];
    const hitTargets = [];
    const attemptedTargets = [];
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
    for (let cycleIndex = 0; cycleIndex < duplicatePlan.cycles; cycleIndex += 1) {
      for (const target of targets) {
        if (this.attackCanceledByReaction) break;
        attemptedTargets.push(target);
        attempted = true;
        attemptedAttackCount += 1;
        const request = await this.resolveDirectedAttackAgainstTarget(target, {
          mode: "swing",
          damageAmount: baseDamage,
          difficultyBonus: 0,
          penetrationStep: 0,
          checkBatch
        });
        if (!request) break;
        if (!request.length) continue;
        damageRequests.push(...request);
        hitTargets.push(target);
      }
      if (this.attackCanceledByReaction) break;
    }
    await this.dodgeExposure.flush();

    const animationTargets = attemptedTargets.length ? attemptedTargets : (hitTargets.length ? hitTargets : targets);
    const trajectories = animationTargets
      .map(target => buildSwingAnimationTrajectory(this.token, [target], "rightToLeft", this.geometry))
      .filter(Boolean)
      .map(trajectory => ({ ...trajectory, delayGroup: 0 }));

    if (attempted) {
      await this.spendCurrentAttackCosts({
        attackCount: Math.max(1, attemptedAttackCount),
        point: getAttackLandingPoint(trajectories, getTokenAimPoint(this.token))
      });
    }
    await checkBatch.publish({ forceBatch: targets.length > 1 || duplicatePlan.cycles > 1 });
    await this.playAttackAnimationsIfNeeded(trajectories, { attempted });
    this.releaseInteractiveControl();
    if (!this.attackCanceledByReaction && damageRequests.length) damageResults.push(...flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests))));

    await this.notifyAttackResolved({ attempted, damageResults, killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults) });
    this.completeProcessingCycle();
  }

  async performConeTargetsAttack({ attackCount = 1, pelletCount = 1 } = {}) {
    this.beginProcessingCycle();
    if (!(await this.runBeforeExecute())) return this.completeProcessingCycle();
    this.pendingCriticalFailureResourceCosts = [];
    this.refresh(true);
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount });
    const totalAttackCount = duplicatePlan.totalAttackCount;

    const trajectories = [];
    const damageRequests = [];
    const damageResults = [];
    const forceBatchCheckMessage = totalAttackCount > 1 || this.targets.length > 1 || pelletCount > 1;
    const checkBatch = forceBatchCheckMessage || getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, { actor: this.token.actor, actionKey: this.actionKey }) > 0
      ? this.createSkillCheckCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    let attempted = false;

    this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let attackIndex = 0; attackIndex < totalAttackCount; attackIndex += 1) {
      if (this.attackCanceledByReaction) break;
      const difficultyBonus = getBurstShotDifficultyBonus(this.weapon, this.actionKey, attackIndex, this.weaponFunctionId, this.token.actor);
      const shotCount = Math.max(1, toInteger(pelletCount));
      const pelletDamages = distributeIntegerAmount(this.getWeaponDamage(), Array(shotCount).fill(1));
      const animationTrajectory = buildConeAnimationTrajectory(this.geometry);
      if (animationTrajectory) trajectories.push({ ...animationTrajectory, delayGroup: attackIndex });
      attempted = true;

      for (const target of this.targets) {
        if (this.attackCanceledByReaction) break;
        for (const [pelletIndex, damageAmount] of pelletDamages.entries()) {
          if (this.attackCanceledByReaction) break;
          if (damageAmount <= 0) continue;
          const totalPelletCount = totalAttackCount * pelletDamages.length;
          const request = await this.resolveAttackAgainstTarget(target, {
            damageAmount,
            difficultyBonus,
            penetrationStep: 0,
            checkBatch,
            allOrNothingContext: this.createAllOrNothingAttackContext({
              mode: pelletDamages.length > 1 ? "pellet" : "",
              index: (attackIndex * pelletDamages.length) + pelletIndex,
              count: totalPelletCount
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
        point: getAttackLandingPoint(trajectories, this.pointer)
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
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId)) return;
    if (!getPotentialTargets(this.token, this.geometry).length) {
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
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId)) return;
    if (this.captureOnly) {
      return this.captureAttackSelection({
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

    const targets = getPotentialTargets(this.token, this.geometry);
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
        point: getAttackLandingPoint(trajectories, this.pointer)
      });
    }
    await this.playAttackAnimationsIfNeeded(trajectories, { attempted });
    this.completeProcessingCycle();
  }

  async resolvePushHit(target, { checkBatch = null } = {}) {
    if (await this.resolveTargetReactions(target)) return { attempted: true, success: false, canceled: true };
    this.dodgeExposure.record(target.actor);
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getDodgeDifficulty(target.actor) + requirementDifficultyBonus,
        situationalModifier: this.getAccuracyModifier(getWeaponPushAccuracyModifier(this.weapon, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext(target))),
        ...getWeaponCriticalCheckModifiers(this.weapon, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext(target)),
        ...this.createWeaponAttackSkillCheckContext(target)
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

  async performBurstAttack({ attackCount = 1, pelletCount = 1 } = {}) {
    this.beginProcessingCycle();
    this.pendingCriticalFailureResourceCosts = [];
    this.refresh(true);
    const duplicatePlan = await this.prepareDuplicateAttackPlan({ attackCount });
    const totalAttackCount = duplicatePlan.totalAttackCount;

    const trajectories = [];
    const damageRequests = [];
    const damageResults = [];
    const forceBatchCheckMessage = totalAttackCount > 1;
    const collectCheckMessages = forceBatchCheckMessage || pelletCount > 1 || getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, { actor: this.token.actor, actionKey: this.actionKey }) > 0;
    const checkBatch = collectCheckMessages
      ? this.createSkillCheckCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    const projectileCount = getBurstProjectileCount(totalAttackCount, pelletCount);
    const burstRanges = this.getBurstTargetRanges(this.targets);
    const primaryShots = buildBurstPrimaryShotsForRanges(this.token, this.geometry, projectileCount, this.targets, burstRanges);
    const assignments = buildBurstBulletAssignments(this.token, this.geometry, this.targets, projectileCount, { primaryShots });
    let attempted = false;

    this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let attackIndex = 0; attackIndex < totalAttackCount; attackIndex += 1) {
      if (this.attackCanceledByReaction) break;
      const difficultyBonus = getBurstShotDifficultyBonus(this.weapon, this.actionKey, attackIndex, this.weaponFunctionId, this.token.actor);
      const pelletDamages = distributeIntegerAmount(this.getWeaponDamage(), Array(Math.max(1, toInteger(pelletCount))).fill(1));

      for (let pelletIndex = 0; pelletIndex < pelletDamages.length; pelletIndex += 1) {
        if (this.attackCanceledByReaction) break;
        const projectileIndex = (attackIndex * pelletDamages.length) + pelletIndex;
        const target = assignments[projectileIndex] ?? null;
        const primaryTrajectory = primaryShots[projectileIndex]?.trajectory ?? buildRandomTrajectory(this.token, getRandomBurstMissGeometry(this.token, this.geometry));
        const trajectory = primaryTrajectory;
        attempted = true;
        if (!target) {
          trajectories.push({ ...trajectory, delayGroup: attackIndex });
          continue;
        }
        const result = await this.resolveAttackTrajectory({
          checkBatch,
          trajectory,
          baseDamage: pelletDamages[pelletIndex] ?? 0,
          difficultyBonus,
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
        point: getAttackLandingPoint(trajectories, this.pointer)
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
    if (this.aimedMode !== "aim" || !this.hoveredTarget || !this.geometry) return undefined;
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) return undefined;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId)) return undefined;

    this.selectedTarget = this.hoveredTarget;
    this.lockedGeometry = serializeGeometry(this.geometry);
    this.selectedLimbKey = "";
    this.aimedMode = this.requiresLimbSelection ? "limb" : "direction";
    this.refresh(true);
    this.refreshAimedLimbMenu();
    return undefined;
  }

  async performAimedAttack(limbKey) {
    if (this.processing || this.aimedMode !== "limb" || !this.selectedTarget) return;
    if (this.interruptForIncapacitation()) return;
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) {
      if (this.attackModifier?.preventCancel) this.requestFinish();
      return;
    }
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId)) {
      if (this.attackModifier?.preventCancel) this.requestFinish();
      return;
    }
    const target = this.selectedTarget;
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
      ) this.finishRequested = true;
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
    const pelletCount = getWeaponPelletCount(this.weapon, this.weaponFunctionId);
    const pelletDamages = distributeIntegerAmount(this.getWeaponDamage(), Array(pelletCount).fill(1));
    const trajectories = buildAimedAttackTrajectories(this.token, geometry, centerTrajectory, pelletCount);
    const checkBatch = (duplicatePlan.cycles > 1 || pelletCount > 1 || getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, { actor: this.token.actor, actionKey: this.actionKey }) > 0)
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
        const result = await this.resolveAimedPelletTrajectory(target, { ...trajectory }, targetSelection, {
          forceAimed: index === 0,
          checkBatch,
          baseDamage: pelletDamages[index] ?? 0,
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
      point: allTrajectories[0]?.end ?? trajectories[0]?.end ?? getTokenAimPoint(target)
    });
    await checkBatch?.publish({ forceBatch: duplicatePlan.cycles > 1 });
    await this.playAttackAnimationsIfNeeded(allTrajectories);
    this.releaseInteractiveControl();
    if (!this.attackCanceledByReaction && damageRequests.length) damageResults.push(...flattenDamageResults(await applyQueuedDamageRequests(this.stampAttackDamageSources(damageRequests))));

    await this.notifyAttackResolved({ damageResults, killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults) });
    this.completeProcessingCycle();
  }

  async requestAimedLimbSelectedReaction(target, limbKey = "") {
    if (this.actionKey !== "aimedShot") return undefined;
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
      title: "Контр-снайпер",
      message: `${this.token?.actor?.name ?? ""} выбрал часть тела для прицельного выстрела по ${target?.actor?.name ?? ""}.`
    });
  }

  async resolveAimedPelletTrajectory(selectedTarget, trajectory, targetSelection, { forceAimed = false, baseDamage = null, checkBatch = null, allOrNothingContext = null } = {}) {
    if (forceAimed || doesTrajectoryHitTarget(this.token, selectedTarget, trajectory)) {
      const blockerCount = this.ignoreAimedObstructions
        ? 0
        : getAimedTargetBlockers(this.token, selectedTarget, trajectory).length;
      return this.resolveAimedAttackTrajectory(selectedTarget, trajectory, targetSelection, {
        blockerBonus: getAimedTargetBlockerBonus(blockerCount),
        baseDamage,
        checkBatch,
        allOrNothingContext
      });
    }

    return this.resolveAttackTrajectory({
      checkBatch,
      trajectory,
      baseDamage,
      allOrNothingContext
    });
  }

  async performDirectedAttack(directionKey) {
    if (this.processing || this.aimedMode !== "direction" || !this.selectedTarget) return;
    const direction = getEnabledMeleeDirections(this.weapon, this.actionKey, this.weaponFunctionId)
      .find(entry => entry.key === directionKey);
    if (!direction) return;
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) return;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId)) return;
    if (this.captureOnly) {
      return this.captureAttackSelection({
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

    const target = this.selectedTarget;
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
        point: getAttackLandingPoint(trajectories, getTokenAimPoint(target))
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
    const penetrationPower = getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, { actor: this.token.actor, actionKey: this.actionKey });
    const targets = getTrajectoryTargetEntries(this.token, trajectory);
    const selectedEntry = targets.find(entry => entry.target === selectedTarget)
      ?? { target: selectedTarget, hit: getTokenTrajectoryHit(selectedTarget, trajectory) };
    const subsequentTargets = targets.filter(entry => (
      entry.target !== selectedTarget
      && (!selectedEntry.hit || entry.hit.distance > selectedEntry.hit.distance + 0.5)
    ));

    let penetrationsUsed = 0;
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
      if (doesDamageRequestGroupPenetratePart(firstRequest, selectedTarget.actor, { type: "limb", limbKey })) penetrationsUsed += 1;
    }

    for (const entry of subsequentTargets) {
      const passthroughStep = hasSuccessfulHit ? penetrationsUsed : 0;
      if (hasSuccessfulHit && (penetrationsUsed <= 0 || penetrationsUsed > penetrationPower)) break;
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
      if (penetrationsUsed >= penetrationPower) break;

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

  async resolveDirectedSwing(selectedTarget, directionKey, { limbKey = "", checkBatch = null, geometry = null } = {}) {
    const damageRequests = [];
    const targets = getSwingTargetSequence(selectedTarget, directionKey, this.targets, geometry ?? this.geometry);
    const hitTargets = [];
    const baseDamage = getAttackModeDamage(this.weapon, this.actionKey, "swing", this.getWeaponDamage(), this.weaponFunctionId, {
      percentBaseAmount: this.getWeaponDamagePercentBase()
    });

    for (const [index, target] of targets.entries()) {
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
    if (await this.resolveTargetReactions(target)) return null;
    this.dodgeExposure.record(target.actor);
    const resolvedLimbKey = limbKey || selectRandomLimbKey(target.actor);
    if (!resolvedLimbKey || isLimbDestroyed(target.actor, resolvedLimbKey)) return [];
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(this.weapon, this.token, target, this.weaponFunctionId);
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getDirectedAttackDifficulty(target.actor, resolvedLimbKey, Boolean(limbKey), difficultyBonus + rangeDifficultyBonus + requirementDifficultyBonus + this.getWatchOutDifficultyBonus()),
        situationalModifier: this.getAccuracyModifier(getAttackModeAccuracyModifier(this.weapon, this.actionKey, mode, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext(target))),
        ...getAttackModeCriticalCheckModifiers(this.weapon, this.actionKey, mode, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext(target)),
        ...this.createWeaponAttackSkillCheckContext(target)
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
    damageAmount = applyContextualDamageToAmount(this.weapon, damageAmount, this.createWeaponDamageContext({
      targetToken: target,
      limbKey: resolvedLimbKey
    }));
    damageAmount = getCriticalDamageAmount(this.weapon, damageAmount, outcome, this.weaponFunctionId);
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    return buildWeaponDamageRequests(this.weapon, {
      attackerActor: this.token.actor,
      actor: target.actor,
      limbKey: resolvedLimbKey,
      amount: damageAmount,
      source: {
        weaponUuid: this.weapon.uuid,
        actionKey: this.actionKey,
        attackerUuid: this.token.actor.uuid,
        tokenId: this.token.id,
        penetrationStep
      }
    }, this.weaponFunctionId);
  }

  async resolveAimedAttackTrajectory(selectedTarget, trajectory, targetSelection, { blockerBonus = 0, baseDamage = null, checkBatch = null, allOrNothingContext = null } = {}) {
    const damageRequests = [];
    baseDamage = Math.max(0, Number(baseDamage ?? this.getWeaponDamage()) || 0);
    const penetrationPower = getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, { actor: this.token.actor, actionKey: this.actionKey });
    checkBatch ??= penetrationPower > 0
      ? this.createSkillCheckCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    const targets = getTrajectoryTargetEntries(this.token, trajectory);
    const selectedEntry = targets.find(entry => entry.target === selectedTarget)
      ?? { target: selectedTarget, hit: getTokenTrajectoryHit(selectedTarget, trajectory) };
    const subsequentTargets = targets.filter(entry => (
      entry.target !== selectedTarget
      && (!selectedEntry.hit || entry.hit.distance > selectedEntry.hit.distance + 0.5)
    ));

    let penetrationsUsed = 0;
    let finalAnimationPoint = null;
    let hasSuccessfulHit = false;

    const firstRequest = targetSelection?.type === "weapon"
      ? await this.resolveAimedWeaponAttackAgainstTarget(selectedTarget, targetSelection, {
        baseDamage,
        damageAmount: getPenetratedDamageAmount(baseDamage, 0),
        difficultyBonus: blockerBonus,
        penetrationStep: 0,
        penetrationPower,
        checkBatch,
        allOrNothingContext
      })
      : await this.resolveAimedAttackAgainstTarget(selectedTarget, {
        limbKey: targetSelection?.limbKey ?? "",
        damageAmount: getPenetratedDamageAmount(baseDamage, 0),
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
      if (doesDamageRequestGroupPenetratePart(firstRequest, selectedTarget.actor, targetSelection)) penetrationsUsed += 1;
    }

    for (const entry of subsequentTargets) {
      const passthroughStep = hasSuccessfulHit ? penetrationsUsed : 0;
      if (hasSuccessfulHit && (penetrationsUsed <= 0 || penetrationsUsed > penetrationPower)) break;
      const damageAmount = getPenetratedDamageAmount(baseDamage, passthroughStep);
      if (damageAmount <= 0) break;

      const request = await this.resolveAttackAgainstTarget(entry.target, {
        damageAmount,
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
      if (penetrationsUsed >= penetrationPower) break;

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

  async resolveAttackPellets({ checkBatch = null, difficultyBonus = 0, attackIndex = 0, attackCount = 1 } = {}) {
    const damageRequests = [];
    const trajectories = buildAttackTrajectories(this.token, this.geometry, this.targets, getWeaponPelletCount(this.weapon, this.weaponFunctionId));
    const pelletDamages = distributeIntegerAmount(this.getWeaponDamage(), trajectories.map(() => 1));
    const totalPelletCount = Math.max(1, toInteger(attackCount)) * Math.max(1, trajectories.length);
    let attempted = false;

    for (const [index, trajectory] of trajectories.entries()) {
      if (this.attackCanceledByReaction) break;
      const result = await this.resolveAttackTrajectory({
        checkBatch,
        trajectory,
        baseDamage: pelletDamages[index] ?? 0,
        difficultyBonus,
        allOrNothingContext: this.createAllOrNothingAttackContext({
          mode: trajectories.length > 1 ? "pellet" : "",
          index: (Math.max(0, toInteger(attackIndex)) * trajectories.length) + index,
          count: totalPelletCount
        })
      });
      damageRequests.push(...result.damageRequests);
      attempted ||= result.attempted;
    }

    return { attempted, damageRequests, trajectories };
  }

  async resolveAttackTrajectory({ checkBatch = null, trajectory = null, baseDamage = null, difficultyBonus = 0, allOrNothingContext = null } = {}) {
    const damageRequests = [];
    trajectory ??= buildAttackTrajectory(this.token, this.geometry, this.targets);
    if (!this.targets.length && !Array.isArray(trajectory?.segments)) return { attempted: true, damageRequests, trajectory };
    const targets = getTrajectoryTargetEntries(this.token, trajectory);
    baseDamage = Math.max(0, Number(baseDamage ?? this.getWeaponDamage()) || 0);
    const penetrationPower = getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, { actor: this.token.actor, actionKey: this.actionKey });
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
        difficultyBonus: Math.max(0, toInteger(difficultyBonus)) + (penetrationsUsed * 20),
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
      if (penetrationsUsed >= penetrationPower) break;

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

  async resolveAttackAgainstTarget(target, { damageAmount = 0, difficultyBonus = 0, penetrationStep = 0, reflectionCount = 0, checkBatch = null, allOrNothingContext = null } = {}) {
    if (await this.resolveTargetReactions(target)) return null;
    this.dodgeExposure.record(target.actor);
    const limbKey = selectRandomLimbKey(target.actor, { includeDestroyed: true });
    if (!limbKey || isLimbDestroyed(target.actor, limbKey)) return [];
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(this.weapon, this.token, target, this.weaponFunctionId);
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const attackContext = this.createWeaponAttackSkillCheckContext(target, {
      reflectionCount: Math.max(0, toInteger(reflectionCount))
    });
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getDodgeDifficulty(target.actor) + difficultyBonus + rangeDifficultyBonus + requirementDifficultyBonus + this.getWatchOutDifficultyBonus(),
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
    const damageContext = this.createWeaponDamageContext({
      targetToken: target,
      reflectionCount: Math.max(0, toInteger(reflectionCount))
    });
    damageAmount = applyContextualDamageToAmount(this.weapon, damageAmount, damageContext);
    damageAmount = applyRicochetDamageBonus(this.weapon, damageAmount, damageContext);
    damageAmount = getCriticalDamageAmount(this.weapon, damageAmount, outcome, this.weaponFunctionId);
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    return buildWeaponDamageRequests(this.weapon, {
      attackerActor: this.token.actor,
      actor: target.actor,
      limbKey,
      amount: damageAmount,
      source: {
        weaponUuid: this.weapon.uuid,
        actionKey: this.actionKey,
        attackerUuid: this.token.actor.uuid,
        tokenId: this.token.id,
        penetrationStep,
        reflectionCount: Math.max(0, toInteger(reflectionCount))
      }
    }, this.weaponFunctionId);
  }

  async performVolleyAttack() {
    if (this.processing || !this.geometry) return;
    const attackCount = getActionAttackCount(this.weapon, this.actionKey, this.weaponFunctionId);
    if (!this.hasRequiredWeaponResources(attackCount)) return;
    if (!this.skipActionPointCost && !hasRequiredWeaponActionPoints(this.token.actor, this.weapon, this.actionKey, this.weaponFunctionId)) return;
    if (this.captureOnly) return this.captureAttackSelection({ mode: "current" });

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

    if (!delayedExplosion) this.dodgeExposure.begin(getWeaponDodgeAttackMultiplier(this.actionKey));
    for (let attackIndex = 0; attackIndex < totalAttackCount; attackIndex += 1) {
      const blastOutcome = await this.resolveVolleyBlastPoint(intendedGeometry, {
        checkBatch,
        difficultyBonus: getBurstShotDifficultyBonus(this.weapon, this.actionKey, attackIndex, this.weaponFunctionId, this.token.actor)
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
          includeDead: true
        });
        const regionRequest = this.buildVolleyDamageRegionRequest(finalGeometry, blastOutcome);
        if (regionRequest) regionRequests.push(regionRequest);
        for (const target of blastTargets) {
          const result = this.resolveVolleyDamageAgainstTarget(target, finalGeometry, blastOutcome);
          damageRequests.push(...(result ?? []));
        }
      }
    }
    if (!delayedExplosion) await this.dodgeExposure.flush();

    this.geometry = finalGeometries[finalGeometries.length - 1] ?? intendedGeometry;
    this.targets = getPotentialTargets(this.token, this.geometry, { includeAttacker: true, includeDead: true });

    const delayedThrownItemId = delayedExplosion ? (existingDelayedThrownItemId || foundry.utils.randomID()) : "";
    const sourceItemUuid = this.weapon.uuid;
    const landingPoint = getAttackLandingPoint(finalGeometries, this.pointer);
    const delayedRegionRequest = delayedExplosion
      ? buildDelayedVolleyExplosionRegionRequest({
        sceneId: canvas.scene?.id ?? "",
        delayedThrownItemId,
        explodeAtWorldTime: Number(existingDelayedThrownItem.explodeAtWorldTime)
          || ((Number(game.time?.worldTime) || 0) + explosionDelaySeconds),
        weapon: this.weapon,
        weaponFunctionId: this.weaponFunctionId,
        actionKey: this.actionKey,
        attackerToken: this.token,
        finalGeometries,
        blastOutcomes,
        baseDamage: this.getWeaponDamage()
      })
      : null;

    await this.spendCurrentAttackCosts({
      attackCount: totalAttackCount,
      point: landingPoint,
      createSpentQuantityTile: false
    });
    await checkBatch?.publish({ forceBatch: true });

    const playEffects = this.shouldPlayWeaponAnimationForAttempt();
    if (delayedExplosion) {
      if (playEffects) await this.playVolleyAttackEffects(finalGeometries, { includeExplosion: false });
      this.releaseInteractiveControl();
      if (this.spentQuantityItemData) {
        foundry.utils.setProperty(
          this.spentQuantityItemData,
          `flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_FLAG}`,
          {
            id: delayedThrownItemId,
            explodeAtWorldTime: delayedRegionRequest.explodeAtWorldTime
          }
        );
      }
      await Promise.all([
        createSpentQuantityItemTile({
          itemData: this.spentQuantityItemData,
          point: landingPoint,
          token: this.token,
          sourceItemUuid,
          delayedThrownItemId
        }),
        requestCreateDelayedVolleyExplosionRegion(delayedRegionRequest)
      ]);
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
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonusForDistance(
      getWeaponAttackData(this.weapon, this.weaponFunctionId),
      getAttackGeometryDistanceMeters(geometry),
      this.token?.actor ?? null
    );
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: BASE_VOLLEY_DIFFICULTY + rangeDifficultyBonus + requirementDifficultyBonus + Math.max(0, toInteger(difficultyBonus)),
        situationalModifier: this.getAccuracyModifier(getWeaponAccuracyModifier(this.weapon, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext())),
        ...getWeaponCriticalCheckModifiers(this.weapon, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext()),
        ...this.createWeaponAttackSkillCheckContext()
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
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    return {
      outcome,
      center,
      critical: isCriticalSuccessAttack(outcome)
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

  resolveVolleyDamageAgainstTarget(target, geometry, blastOutcome) {
    if (!isDeadTarget(target)) this.dodgeExposure.record(target.actor);
    return buildWeaponExplosionDamageRequests({
      targetToken: target,
      center: geometry.end,
      radiusPixels: geometry.radiusPixels,
      baseDamage: this.getWeaponDamage(),
      pelletCount: getWeaponPelletCount(this.weapon, this.weaponFunctionId),
      damageTypes: getWeaponDamageTypeEntries(this.weapon, this.weaponFunctionId),
      penetrationPower: getWeaponPenetrationPower(this.weapon, this.weaponFunctionId, {
        actor: this.token.actor,
        actionKey: this.actionKey
      }),
      damageModifier: amount => getCriticalDamageAmount(
        this.weapon,
        applyContextualDamageToAmount(this.weapon, amount, this.createWeaponDamageContext({ targetToken: target })),
        blastOutcome.outcome,
        this.weaponFunctionId
      ),
      source: {
        weaponUuid: this.weapon.uuid,
        actionKey: this.actionKey,
        attackerUuid: this.token.actor.uuid,
        tokenId: this.token.id,
        blastCenter: serializePoint(geometry.end),
        blastRadius: getVolleyDamageRadius(this.weapon, this.weaponFunctionId)
      }
    });
  }

  async resolveAimedAttackAgainstTarget(target, { limbKey = "", damageAmount = 0, difficultyBonus = 0, penetrationStep = 0, checkBatch = null, allOrNothingContext = null } = {}) {
    if (await this.resolveTargetReactions(target)) return null;
    this.dodgeExposure.record(target.actor);
    if (!limbKey || isLimbDestroyed(target.actor, limbKey)) return [];
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(this.weapon, this.token, target, this.weaponFunctionId);
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getAimedAttackDifficulty(
          target.actor,
          limbKey,
          difficultyBonus + rangeDifficultyBonus + requirementDifficultyBonus + this.getWatchOutDifficultyBonus(),
          {
            innateDifficultyIgnorePercent: this.getWeaponActionModifierState().getOption("innateAimedDifficultyIgnorePercent"),
            ignoreCover: this.ignoreAimedObstructions
          }
        ),
        situationalModifier: this.getAccuracyModifier(getWeaponAccuracyModifier(this.weapon, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext(target))),
        ...getWeaponCriticalCheckModifiers(this.weapon, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext(target)),
        ...this.createWeaponAttackSkillCheckContext(target),
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
    damageAmount = applyContextualDamageToAmount(this.weapon, damageAmount, this.createWeaponDamageContext({
      targetToken: target,
      limbKey
    }));
    damageAmount = getCriticalDamageAmount(this.weapon, damageAmount, outcome, this.weaponFunctionId);
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    return buildWeaponDamageRequests(this.weapon, {
      attackerActor: this.token.actor,
      actor: target.actor,
      limbKey,
      amount: damageAmount,
      source: {
        weaponUuid: this.weapon.uuid,
        actionKey: this.actionKey,
        attackerUuid: this.token.actor.uuid,
        tokenId: this.token.id,
        penetrationStep
      }
    }, this.weaponFunctionId);
  }

  async resolveAimedWeaponAttackAgainstTarget(target, targetSelection, { baseDamage = 0, damageAmount = 0, difficultyBonus = 0, penetrationStep = 0, penetrationPower = 0, checkBatch = null, allOrNothingContext = null } = {}) {
    if (await this.resolveTargetReactions(target)) return null;
    const targetWeapon = targetSelection?.item ?? null;
    const holdingLimbKey = String(targetSelection?.limbKey ?? "").trim();
    if (!targetWeapon || !holdingLimbKey || isLimbDestroyed(target.actor, holdingLimbKey)) return [];
    this.dodgeExposure.record(target.actor);
    const rangeDifficultyBonus = getEffectiveRangeDifficultyBonus(this.weapon, this.token, target, this.weaponFunctionId);
    const requirementDifficultyBonus = getWeaponRequirementDifficultyPenalty(this.token.actor, this.weapon, this.weaponFunctionId);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      skillKey: String(getWeaponAttackData(this.weapon, this.weaponFunctionId)?.skillKey ?? ""),
      data: {
        difficulty: getAimedAttackDifficulty(
          target.actor,
          holdingLimbKey,
          difficultyBonus + rangeDifficultyBonus + requirementDifficultyBonus + this.getWatchOutDifficultyBonus(),
          {
            innateDifficultyIgnorePercent: this.getWeaponActionModifierState().getOption("innateAimedDifficultyIgnorePercent"),
            ignoreCover: this.ignoreAimedObstructions
          }
        ),
        situationalModifier: this.getAccuracyModifier(getWeaponAccuracyModifier(this.weapon, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext(target))),
        ...getWeaponCriticalCheckModifiers(this.weapon, this.weaponFunctionId, this.createWeaponAttackSkillCheckContext(target)),
        ...this.createWeaponAttackSkillCheckContext(target),
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

    damageAmount = applyContextualDamageToAmount(this.weapon, damageAmount, this.createWeaponDamageContext({ targetToken: target }));
    damageAmount = getCriticalDamageAmount(this.weapon, damageAmount, outcome, this.weaponFunctionId);
    await this.notifyAttackCheckResolved(outcome, checkBatch);
    const weaponDamageRequests = buildWeaponConditionDamageRequests(this.weapon, {
      attackerActor: this.token.actor,
      actor: target.actor,
      targetItem: targetWeapon,
      limbKey: holdingLimbKey,
      amount: damageAmount,
      source: {
        weaponUuid: this.weapon.uuid,
        actionKey: this.actionKey,
        attackerUuid: this.token.actor.uuid,
        tokenId: this.token.id,
        targetItemId: targetWeapon.id,
        penetrationStep
      }
    }, this.weaponFunctionId);
    if (!weaponDamageRequests.length) return [];

    const requests = [...weaponDamageRequests];
    const penetratesWeapon = doesDamageRequestGroupPenetratePart(weaponDamageRequests, target.actor, {
      type: "weapon",
      item: targetWeapon,
      limbKey: holdingLimbKey
    });
    const limbPenetrationStep = penetrationStep + 1;
    if (penetratesWeapon && limbPenetrationStep <= penetrationPower) {
      requests.push(...buildWeaponDamageRequests(this.weapon, {
        attackerActor: this.token.actor,
        actor: target.actor,
        limbKey: holdingLimbKey,
        amount: getPenetratedDamageAmount(baseDamage, limbPenetrationStep),
        source: {
          weaponUuid: this.weapon.uuid,
          actionKey: this.actionKey,
          attackerUuid: this.token.actor.uuid,
          tokenId: this.token.id,
          aimedThroughItemId: targetWeapon.id,
          penetrationStep: limbPenetrationStep
        }
      }, this.weaponFunctionId));
    }
    return requests;
  }

  refresh(forceBroadcast = false) {
    if (this.destroyed) return;
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
    const markerPreview = this.getTargetMarkerPreview(forceBroadcast || this.processing);
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
      this.geometry.ricochet = ricochet;
      this.geometry.ricochetTrajectory = buildTrajectoryByAngle(
        this.token,
        this.geometry,
        this.geometry.angle,
        Number(this.geometry.elevationSlope) || 0
      );
      this.geometry.ricochetCone = buildRicochetCone(this.token, this.geometry);
    }
    let potentialTargets = getPotentialTargets(this.token, this.geometry, {
      includeAttacker: this.volleyAction,
      includeDead: this.volleyAction
    });
    this.targets = potentialTargets;
    this.geometry.aimPoint = null;
    this.trajectoryAimTarget = isWhirlwindAttackModifier(this.attackModifier)
      ? null
      : this.volleyAction
      ? getVolleyTrajectoryAimTarget(this.token, this.geometry, {
        includeAttacker: true,
        includeDead: true
      })
      : this.getTrajectoryAimTarget(potentialTargets);
    this.geometry.aimPoint = this.trajectoryAimTarget
      ? selectAttackGeometryAimPoint(this.token, this.trajectoryAimTarget, this.geometry)
      : null;
    if (this.volleyAction && this.geometry.aimPoint) {
      this.geometry = aimVolleyGeometryAtPoint(this.token, this.geometry, this.geometry.aimPoint);
      potentialTargets = getPotentialTargets(this.token, this.geometry, {
        includeAttacker: true,
        includeDead: true
      });
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
      return getCircularAttackGeometry(this.weapon, this.actionKey, this.token, origin, this.weaponFunctionId);
    }
    return getAttackGeometry(this.weapon, this.actionKey, this.token, origin, this.pointer, this.weaponFunctionId);
  }

  getAccuracyModifier(baseModifier = 0) {
    return toInteger(baseModifier) + getWeaponAttackModifierAccuracyModifier(this.attackModifier);
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
    queueAttackAutoCoverSync(this.attackId, nextStates);
  }

  getFocusedTarget() {
    return this.selectedTarget ?? this.hoveredTarget ?? this.trajectoryAimTarget;
  }

  getTargetMarkerPreview(force = false) {
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
      this.refresh();
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
    const projectileCount = getBurstProjectileCount(attackCount, getWeaponPelletCount(this.weapon, this.weaponFunctionId));
    return buildBurstTargetRanges(this.token, this.geometry, targets, projectileCount);
  }

  updatePointerFromClientEvent(event) {
    if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return;
    this.pointer = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    if (!this.processing && this.pushStrengthMaximum <= 0 && !(this.targetedAction && ["limb", "direction"].includes(this.aimedMode))) this.refresh();
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
      this.removeLimbMenu();
      return;
    }

    const rows = this.aimedMode === "direction"
      ? this.prepareAttackDirectionRows(target)
      : this.prepareAimedLimbRows(target);
    if (!rows.length) {
      this.removeLimbMenu();
      if (this.meleeAction && this.aimedMode === "aim") this.refreshTargetedGeneralChanceMenu(target);
      else this.removeChanceMenu();
      return;
    }

    this.removeChanceMenu();
    if (!this.limbMenu) this.createLimbMenu();
    this.limbMenu.dataset.mode = this.aimedMode;
    this.limbMenu.innerHTML = rows.map(row => `
      <button type="button" ${row.direction ? `data-attack-direction="${escapeHtml(row.key)}"` : `data-limb-key="${escapeHtml(row.key)}"`} class="${[
        row.key === this.hoveredLimbKey ? "hover" : "",
        row.destroyed ? "destroyed" : ""
      ].filter(Boolean).join(" ")}" ${row.destroyed ? 'data-destroyed="true" disabled' : ""}>
        <span>${escapeHtml(row.label)}</span>
        <strong class="${getAimedChanceClass(row.chance)}">${row.destroyed ? "—" : `${row.chance}%`}</strong>
      </button>
    `).join("");
    this.positionLimbMenu(target);
    this.updateLimbMenuHover();
  }

  refreshPushStrengthMenu() {
    if (this.processing || this.pushStrengthMaximum <= 1) return;
    if (!this.limbMenu) this.createLimbMenu();
    this.limbMenu.dataset.mode = "push-strength";
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
    const chance = getGeneralAttackHitChance(this.token.actor, this.weapon, target.actor, {
      difficultyBonus: getEffectiveRangeDifficultyBonus(this.weapon, this.token, target, this.weaponFunctionId),
      actionKey: this.actionKey,
      weaponFunctionId: this.weaponFunctionId
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
      return [{
        label: game.i18n.localize("FALLOUTMAW.Item.AttackChanceArea"),
        chance: getVolleyAreaHitChance(this.token.actor, this.weapon, this.geometry, {
          actionKey: this.actionKey,
          weaponFunctionId: this.weaponFunctionId,
          difficultyBonus: getBurstShotDifficultyBonus(this.weapon, this.actionKey, 0, this.weaponFunctionId, this.token.actor)
        })
      }];
    }
    const target = getNearestAttackChanceTarget(this.token, this.geometry, this.targets);
    if (!target) return [];
    return [{
      label: String(target.name ?? target.actor?.name ?? game.i18n.localize("FALLOUTMAW.Item.AttackChanceHit")),
      chance: getGeneralAttackHitChance(this.token.actor, this.weapon, target.actor, {
        difficultyBonus: getEffectiveRangeDifficultyBonus(this.weapon, this.token, target, this.weaponFunctionId),
        actionKey: this.actionKey,
        weaponFunctionId: this.weaponFunctionId
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
      if (!activeButton) return;
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

  prepareAimedLimbRows(target) {
    if (!this.requiresLimbSelection) return [];
    const aimPoint = this.geometry ? (selectTargetTrajectoryAimPoint(this.token, target, this.geometry) ?? getTokenAimPoint(target)) : null;
    const trajectory = this.geometry && aimPoint ? buildTrajectoryThroughPoint(this.token, this.geometry, aimPoint) : null;
    const blockerCount = this.ignoreAimedObstructions || !trajectory
      ? 0
      : getAimedTargetBlockers(this.token, target, trajectory).length;
    const blockerBonus = getAimedTargetBlockerBonus(blockerCount)
      + getEffectiveRangeDifficultyBonus(this.weapon, this.token, target, this.weaponFunctionId);
    const limbRows = Object.entries(target.actor?.system?.limbs ?? {})
      .filter(([_key, limb]) => limb && typeof limb === "object")
      .map(([key, limb]) => ({
        key,
        label: String(limb.label ?? key),
        destroyed: isLimbDestroyed(target.actor, key),
        chance: isLimbDestroyed(target.actor, key)
          ? 0
          : getAimedAttackHitChance(this.token.actor, this.weapon, target.actor, key, blockerBonus, this.weaponFunctionId, this.actionKey, {
            innateDifficultyIgnorePercent: this.getWeaponActionModifierState().getOption("innateAimedDifficultyIgnorePercent"),
            ignoreCover: this.ignoreAimedObstructions
          })
      }));
    if (!this.aimedShot) return limbRows;
    const weaponRows = getHeldWeaponAimTargets(target.actor)
      .map(entry => ({
        key: getAimedWeaponTargetKey(entry.item),
        label: entry.label,
        destroyed: entry.destroyed || isLimbDestroyed(target.actor, entry.limbKey),
        chance: entry.destroyed || isLimbDestroyed(target.actor, entry.limbKey)
          ? 0
          : getAimedAttackHitChance(this.token.actor, this.weapon, target.actor, entry.limbKey, blockerBonus, this.weaponFunctionId, this.actionKey, {
            innateDifficultyIgnorePercent: this.getWeaponActionModifierState().getOption("innateAimedDifficultyIgnorePercent"),
            ignoreCover: this.ignoreAimedObstructions
          })
      }));
    return [...limbRows, ...weaponRows];
  }

  prepareAttackDirectionRows(target) {
    const limbKey = this.selectedLimbKey;
    return getEnabledMeleeDirections(this.weapon, this.actionKey, this.weaponFunctionId).map(direction => ({
      key: direction.key,
      label: direction.label,
      direction: true,
      chance: getDirectedAttackHitChance(this.token.actor, this.weapon, target.actor, {
        actionKey: this.actionKey,
        mode: direction.mode,
        limbKey,
        difficultyBonus: getEffectiveRangeDifficultyBonus(this.weapon, this.token, target, this.weaponFunctionId),
        weaponFunctionId: this.weaponFunctionId
      })
    }));
  }

  recordCriticalFailureConsequences(outcome) {
    if (!isCriticalFailureAttack(outcome)) return;
    this.pendingCriticalFailureResourceCosts.push(...getCriticalFailureResourceCosts(this.weapon, this.actionKey, this.weaponFunctionId));
  }

  broadcastPreview(force = false, markerPreview = null) {
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
      attackId: this.attackId,
      sceneId: canvas.scene?.id ?? "",
      ...previewState
    });
  }
}

export function getWeaponAttackData(weapon, weaponFunctionId = "") {
  const id = weaponFunctionId || ITEM_FUNCTIONS.weapon;
  return applyWeaponAttackPowerModifiers(applyWeaponModuleModifiers(
    applyDamageSourceWeaponModifiers(getWeaponFunctionById(weapon, id) ?? {}),
    { moduleSlots: getWeaponFunctionModuleSlots(weapon, id) }
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
    attackAnimationKey: String(source.attackAnimationKey ?? ""),
    accuracyBonus: addFormulaTexts(weaponData.accuracyBonus, source.accuracyBonus),
    criticalChanceModifier: addFormulaTexts(weaponData.criticalChanceModifier, source.criticalChanceModifier),
    criticalDamagePercent: addFormulaTexts(weaponData.criticalDamagePercent, source.criticalDamagePercent),
    maxRangeMeters: addFormulaTexts(weaponData.maxRangeMeters, source.maxRangeMeters),
    effectiveRange: {
      value: addFormulaTexts(weaponData.effectiveRange?.value, source.effectiveRange?.value),
      max: addFormulaTexts(weaponData.effectiveRange?.max, source.effectiveRange?.max)
    },
    penetration: addFormulaTexts(weaponData.penetration, source.penetration),
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
    && !costs.some(cost => String(cost?.type ?? "") === "magazine")) {
    costs.push({ type: "magazine", amount: 1 });
  }

  for (const cost of resourceCosts ?? []) {
    const type = String(cost?.type ?? "").trim();
    const delta = toInteger(cost?.amount) * Math.max(0, toInteger(multiplier));
    if (!type || !delta) continue;
    let target = costs.find(entry => String(entry?.type ?? "") === type);
    if (!target) {
      target = { type, amount: 0 };
      costs.push(target);
    }
    target.amount = Math.max(0, toInteger(target.amount) + delta);
  }
  weaponData.resourceCosts = costs;
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
    regionDurationSeconds: normalizeFormulaText(sourceVolley?.regionDurationSeconds),
    regionDelaySeconds: normalizeFormulaText(sourceVolley?.regionDelaySeconds),
    regionRadiusDeltaMeters: normalizeFormulaText(sourceVolley?.regionRadiusDeltaMeters),
    explosionAnimationKey: String(sourceVolley?.explosionAnimationKey ?? "")
  };
}

function getWeaponAttackSourceData(weapon, weaponFunctionId = "") {
  const id = String(weaponFunctionId || ITEM_FUNCTIONS.weapon);
  if (!id || id === ITEM_FUNCTIONS.weapon) return weapon.system?._source?.functions?.weapon ?? {};
  const sourceAdditionalWeapons = weapon.system?._source?.functions?.additionalWeapons ?? [];
  if (Array.isArray(sourceAdditionalWeapons)) {
    return sourceAdditionalWeapons.find(entry => String(entry?.id ?? "") === id) ?? {};
  }
  return sourceAdditionalWeapons?.[id] ?? {};
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
    ...payload,
    senderUserId: game.user?.id ?? ""
  });
}

function handleWeaponAttackSocketMessage(payload = {}) {
  if (!payload || payload.scope !== WEAPON_ATTACK_SOCKET_SCOPE || payload.senderUserId === game.user?.id) return;
  if (payload.action === "commandedAttacksResult") {
    if (payload.targetUserId && payload.targetUserId !== game.user?.id) return;
    const pending = pendingCommandedAttackRequests.get(String(payload.requestId ?? ""));
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingCommandedAttackRequests.delete(String(payload.requestId ?? ""));
    pending.resolve(payload.result ?? { ok: false, reason: "emptyAuthorityResult" });
    return;
  }
  if (["executeCommandedAttacks", "preflightCommandedAttacks"].includes(payload.action)) {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    void processCommandedWeaponAttackSocketRequest(payload);
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
    if (payload.ok) pending.resolve(payload.results ?? []);
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
      respondVolleyRegionSocketRequest(payload, { ok: true, results: serializeRegionSocketResults(results.regions) });
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
  if (payload.sceneId !== canvas.scene?.id) {
    removeRemoteAttackPreview(payload.attackId);
    return;
  }
  updateRemoteAttackPreview(payload);
}

function requestActiveWeaponAttackFinish(attackId = "") {
  const normalizedAttackId = String(attackId ?? "").trim();
  if (!normalizedAttackId) return false;
  if (activeAttack?.attackId === normalizedAttackId) {
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
    getAttackPreviewLayer().addChild(preview.container);
    remoteAttackPreviews.set(attackId, preview);
  }

  preview.shape.clear();
  clearTargetMarkerLayer(preview.targetMarkers);
  drawAttackShape(preview.shape, geometry, {
    locked: Boolean(payload.processing),
    hasTargets: Array.isArray(payload.targetMarkers) && payload.targetMarkers.length > 0
  });
  drawTargetMarkerPositions(preview.targetMarkers, payload.targetMarkers ?? [], payload.focusedTargetMarker ?? null);
}

function removeRemoteAttackPreview(attackId = "") {
  const preview = remoteAttackPreviews.get(String(attackId));
  if (!preview) return;
  preview.container.destroy({ children: true });
  remoteAttackPreviews.delete(String(attackId));
}

function clearRemoteAttackPreviews() {
  for (const attackId of Array.from(remoteAttackPreviews.keys())) removeRemoteAttackPreview(attackId);
}

function respondVolleyRegionSocketRequest(payload = {}, { ok = true, error = "", results = [] } = {}) {
  if (!payload.requestId || !payload.senderUserId) return;
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    action: "createVolleyDamageRegionsResult",
    senderUserId: game.user?.id ?? "",
    targetUserId: payload.senderUserId,
    requestId: payload.requestId,
    ok,
    error,
    results
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
    return { damage: [], regions: results };
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
  if (!radiusPixels || !damageEntries.length) return null;

  const durationSeconds = Math.max(0, toInteger(regionData.durationSeconds));
  const delaySeconds = Math.max(0, toInteger(regionData.delaySeconds));
  const levelId = getRegionRestrictionLevelId(scene);

  const created = await scene.createEmbeddedDocuments("Region", [{
    name: String(regionData.name ?? "").trim() || game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.RegionName"),
    color: String(regionData.color ?? "#dd8431"),
    shapes: [{
      type: "circle",
      x: center.x,
      y: center.y,
      radius: radiusPixels,
      gridBased: false
    }],
    elevation: { bottom: null, top: null },
    levels: levelId ? [levelId] : [],
    restriction: { enabled: Boolean(levelId), type: "move", priority: 0 },
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    highlightMode: "shapes",
    displayMeasurements: false,
    behaviors: [{
      name: game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.Name"),
      type: PERIODIC_DAMAGE_REGION_BEHAVIOR_TYPE,
      system: {
        damageEntries,
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
    const updated = await scene.updateEmbeddedDocuments("Region", [{
      _id: existing.id,
      shapes,
      levels: levelId ? [levelId] : [],
      hidden: false,
      attachment: { token: attachmentTokenId || null }
    }]);
    return updated?.[0] ?? existing;
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
  return created?.[0] ?? null;
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

    const damageRequests = [];
    const regionRequests = [];
    const targetActorUuids = new Set();
    const targetTokenUuids = new Set();
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
        ? getPotentialTargets(attackerToken, geometry, { includeAttacker: true, includeDead: true })
        : (canvas.tokens?.placeables ?? []).filter(target => (
          target.actor && target.visible && isTokenInVolleyPlanarRadius(target, geometry)
        ));
      for (const target of targets) {
        if (!isDeadTarget(target)) dodgeExposure.record(target.actor);
        targetActorUuids.add(target.actor?.uuid);
        targetTokenUuids.add(target.document?.uuid);
        damageRequests.push(...buildWeaponExplosionDamageRequests({
          targetToken: target,
          center,
          radiusPixels: geometry.radiusPixels,
          baseDamage: explosion.damageAmount,
          pelletCount: explosion.pelletCount,
          damageTypes: explosion.damageTypes,
          penetrationPower: explosion.penetrationPower,
          source: {
            weaponUuid: source.weaponUuid,
            actionKey: source.actionKey,
            attackerUuid: source.attackerUuid,
            tokenId: source.attackerTokenId,
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
    await publishWeaponAttackResolved({
      attackerUuid: String(source.attackerUuid ?? ""),
      actorUuid: String(source.attackerUuid ?? ""),
      tokenUuid: String(source.attackerTokenUuid ?? ""),
      weaponUuid: String(source.weaponUuid ?? ""),
      actionKey: String(source.actionKey ?? ""),
      weaponFunctionId: String(source.weaponFunctionId ?? ""),
      actionPointCost: 0,
      targetActorUuids: Array.from(targetActorUuids).filter(Boolean),
      targetTokenUuids: Array.from(targetTokenUuids).filter(Boolean),
      killedTargetUuids: collectKilledTargetUuidsFromDamageResults(damageResults),
      canceledByReaction: false,
      attackCheckCount: explosions.length,
      chainRef: source.chainRef ?? null,
      damageHubOperationRef: String(source.damageHubOperationRef ?? ""),
      senderUserId: game.user?.id ?? ""
    });

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

function getEffectiveWeaponBurstDifficultyPerShot(weapon, weaponFunctionId = "", actor = null) {
  const base = getWeaponBurstDifficultyPerShot(weapon, weaponFunctionId);
  const stabilityPercent = toInteger(actor?.system?.combat?.burstStability);
  return Math.max(0, Math.round(base * Math.max(0, 1 - (stabilityPercent / 100))));
}

function getBurstShotDifficultyBonus(weapon, actionKey, attackIndex = 0, weaponFunctionId = "", actor = null) {
  if (actionKey !== "burst") return 0;
  return Math.max(0, toInteger(attackIndex)) * getEffectiveWeaponBurstDifficultyPerShot(weapon, weaponFunctionId, actor);
}

function getWeaponPelletCount(weapon, weaponFunctionId = "") {
  return Math.max(1, evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.pellets, {
    fallback: 1,
    minimum: 1,
    context: "pellets"
  }) || 1);
}

function getBurstProjectileCount(attackCount = 1, pelletCount = 1) {
  return Math.max(1, toInteger(attackCount) || 1) * Math.max(1, toInteger(pelletCount) || 1);
}

export function hasRequiredWeaponResources(weapon, multiplier = 1, weaponFunctionId = "", { modifierState = null } = {}) {
  const missing = getMissingWeaponResourceCost(weapon, multiplier, weaponFunctionId, { modifierState });
  if (!missing) return true;
  ui.notifications.warn(`${weapon?.name ?? ""}: не хватает ${missing.label} (${missing.current} / ${missing.required}).`);
  return false;
}

export function getMissingWeaponResourceCost(weapon, multiplier = 1, weaponFunctionId = "", { modifierState = null } = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const costs = getWeaponResourceCosts(weaponData, { modifierState });
  for (const cost of costs) {
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

export function isCombatActionPointSpendingActive(actor = null) {
  return isActorInActiveCombat(actor);
}

export function getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId = "") {
  const baseCost = evaluateActorFormula(getWeaponAttackData(weapon, weaponFunctionId)?.[actionKey]?.actionPointCost, actor, {
    fallback: DEFAULT_WEAPON_ACTION_POINT_COST,
    minimum: 0,
    context: "weapon action point cost"
  });
  const modifiedCost = applyDamageCostModifier(baseCost, getDamageCostModifierState(actor, { actionKey }).action);
  const atRandomReduction = getActorAtRandomActionPointCostReduction(actor, actionKey);
  return Math.max(0, Math.ceil(modifiedCost + getActorPostureWeaponActionPointCostBonus(actor) - atRandomReduction));
}

function hasRequiredWeaponActionPoints(actor, weapon, actionKey, weaponFunctionId = "") {
  if (!isCombatActionPointSpendingActive(actor)) return true;
  const cost = getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId);
  if (cost <= 0) return true;
  return canSpendCombatActionPoints(actor, cost, { label: "действия" });
}

function canSpendRequiredWeaponActionPoints(actor, weapon, actionKey, weaponFunctionId = "") {
  if (!isCombatActionPointSpendingActive(actor)) return true;
  const cost = getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId);
  if (cost <= 0) return true;
  const state = getCombatActionPointState(actor);
  return !state || cost <= state.value;
}

async function spendWeaponActionPoints(actor, weapon, actionKey, weaponFunctionId = "", {
  emitActionResolved = true,
  spendActionPoints = true,
  chainRef = null,
  damageHubOperationRef = ""
} = {}) {
  if (actionKey !== "reload") await revealActorFromStealth(actor);
  if (spendActionPoints && isCombatActionPointSpendingActive(actor)) {
    const cost = getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId);
    if (cost > 0) {
      const state = getCombatActionPointState(actor);
      if (state && cost <= state.value) {
        await spendCombatActionPoints(actor, cost, {
          source: "weaponAction",
          actionKey,
          chainRef,
          damageHubOperationRef
        });
      }
    }
  }
  if (emitActionResolved && actionKey !== "reload") {
    Hooks.callAll("fallout-maw.weaponActionResolved", {
      actor,
      weapon,
      actionKey,
      weaponActionKey: actionKey,
      weaponFunctionId,
      weaponData: getWeaponAttackData(weapon, weaponFunctionId),
      chainRef,
      damageHubOperationRef
    });
  }
}

async function spendWeaponResources(weapon, multiplier = 1, weaponFunctionId = "", extraCosts = [], { modifierState = null } = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const updateData = {};
  let deleteWeapon = false;
  let magazineValue = Math.max(0, toInteger(weaponData?.magazine?.value));
  let energyConsumerItem = null;
  let energyValue = null;
  const costs = [
    ...getWeaponResourceCosts(weaponData, { modifierState }).map(cost => ({
      type: cost.type,
      amount: Math.max(0, toInteger(cost.amount) * Math.max(1, toInteger(multiplier)))
    })),
    ...(extraCosts ?? []).map(cost => ({
      type: cost.type,
      amount: Math.max(0, toInteger(cost.amount))
    }))
  ];
  for (const cost of costs) {
    const amount = Math.max(0, toInteger(cost.amount));
    if (!amount) continue;
    if (cost.type === "magazine") {
      magazineValue = Math.max(0, magazineValue - amount);
      Object.assign(updateData, createWeaponFunctionUpdateData(weapon, weaponFunctionId, {
        "magazine.value": magazineValue
      }));
    } else if (cost.type === "condition") {
      const current = Object.hasOwn(updateData, "system.functions.condition.value")
        ? toInteger(updateData["system.functions.condition.value"])
        : toInteger(weapon.system?.functions?.condition?.value);
      updateData["system.functions.condition.value"] = Math.max(0, current - amount);
    } else if (cost.type === "energyConsumer") {
      if (energyValue === null) {
        const state = getWeaponEnergyResourceState(weapon, weaponFunctionId);
        energyConsumerItem = state.item;
        energyValue = state.current;
      }
      energyValue = Math.max(0, energyValue - amount);
    } else if (cost.type === "quantity") {
      const current = Object.hasOwn(updateData, "system.quantity")
        ? toInteger(updateData["system.quantity"])
        : toInteger(weapon.system?.quantity);
      const next = Math.max(0, current - amount);
      if (next <= 0) deleteWeapon = true;
      else {
        updateData["system.quantity"] = next;
        if (weapon.getFlag?.(SYSTEM_ID, DELAYED_THROWN_ITEM_FLAG)?.id) {
          updateData[`flags.${SYSTEM_ID}.${DELAYED_THROWN_ITEM_FLAG}`] = globalThis._del;
        }
      }
    }
  }
  if (energyConsumerItem === weapon) {
    updateData["system.functions.energyConsumer.installedSource.reserve.value"] = energyValue;
  }
  if (Object.keys(updateData).length) await weapon.update(updateData);
  if (energyConsumerItem && energyConsumerItem !== weapon) {
    await energyConsumerItem.update({
      "system.functions.energyConsumer.installedSource.reserve.value": energyValue
    });
  }
  if (deleteWeapon && weapon.id) await weapon.delete();
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
  if (!hasItemFunction(weapon, ITEM_FUNCTIONS.weapon) || !hasWeaponAction(weapon, actionKey, weaponFunctionId)) return false;
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

async function createSpentQuantityItemTile({ itemData = null, point = null, token = null, sourceItemUuid = "", delayedThrownItemId = "" } = {}) {
  if (!itemData || !point) return null;
  return createThrownItemTile({
    sceneId: canvas.scene?.id ?? "",
    itemData,
    point,
    sourceActorUuid: token?.actor?.uuid ?? "",
    sourceItemUuid,
    delayedThrownItemId
  });
}

function getAttackLandingPoint(trajectories = [], fallback = null) {
  return trajectories.find(trajectory => trajectory?.end)?.end ?? fallback;
}

function getAttackGeometry(weapon, actionKey, attackerToken, origin, pointer, weaponFunctionId = "") {
  if (!origin || !pointer) return null;
  if (isVolleyAttackAction(weapon, actionKey, weaponFunctionId)) return getVolleyAttackGeometry(weapon, attackerToken, origin, pointer, weaponFunctionId);

  const rangeBonusMeters = getTokenAttackRangeBonusMeters(attackerToken);
  const maxDistancePixels = metersToPixels(getSizeScaledActionMaxRangeMeters(weapon, actionKey, attackerToken, weaponFunctionId));
  const dx = pointer.x - origin.x;
  const dy = pointer.y - origin.y;
  const angle = Math.atan2(dy, dx);
  const distance = Math.max(1, maxDistancePixels);
  const halfAngle = getActionAttackConeRadians(weapon, actionKey, weaponFunctionId) / 2;
  const end = getWallClippedEndpoint(attackerToken, origin, angle, distance).point;
  const shapePoints = buildClippedConePoints(attackerToken, { origin, angle, distance, halfAngle });
  return { origin, angle, distance, rangeBonusMeters, halfAngle, end, shapePoints };
}

function getCircularAttackGeometry(weapon, actionKey, attackerToken, origin, weaponFunctionId = "") {
  if (!origin) return null;
  const rangeBonusMeters = getTokenAttackRangeBonusMeters(attackerToken);
  const distance = Math.max(1, metersToPixels(getSizeScaledActionMaxRangeMeters(weapon, actionKey, attackerToken, weaponFunctionId)));
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

function getVolleyAttackGeometry(weapon, attackerToken, origin, pointer, weaponFunctionId = "") {
  const rangeBonusMeters = getTokenAttackRangeBonusMeters(attackerToken);
  const configuredMaxRangeMeters = evaluateActorFormula(getWeaponAttackData(weapon, weaponFunctionId)?.maxRangeMeters, attackerToken?.actor, {
    minimum: 0,
    context: "volley max range"
  });
  const maxRangeMeters = configuredMaxRangeMeters > 0 ? configuredMaxRangeMeters + rangeBonusMeters : 0;
  const maxDistancePixels = metersToPixels(maxRangeMeters);
  const radiusPixels = metersToPixels(getVolleyDamageRadius(weapon, weaponFunctionId));
  const dx = pointer.x - origin.x;
  const dy = pointer.y - origin.y;
  const angle = Math.atan2(dy, dx);
  const requestedDistance = Math.max(1, Math.hypot(dx, dy));
  const maxDistance = maxDistancePixels > 0 ? Math.min(requestedDistance, maxDistancePixels) : requestedDistance;
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
  const degrees = hasActionCone && Number.isFinite(actionCone)
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

function getSizeScaledActionMaxRangeMeters(weapon, actionKey, attackerToken = null, weaponFunctionId = "") {
  return getActionMaxRangeMeters(weapon, actionKey, weaponFunctionId) + getTokenAttackRangeBonusMeters(attackerToken);
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

function getPotentialTargets(attackerToken, geometry, { includeAttacker = false, includeDead = false } = {}) {
  if (Array.isArray(geometry?.ricochetCone?.strips)) {
    const entries = new Map();
    return (canvas.tokens?.placeables ?? [])
      .filter(target => {
        if ((!includeAttacker && target === attackerToken) || !target.actor || !target.visible) return false;
        const entry = getRicochetTargetEntry(target, geometry);
        if (entry) entries.set(target, entry);
        return entry !== null;
      })
      .sort((left, right) => (
        (entries.get(left)?.distance ?? Infinity)
        - (entries.get(right)?.distance ?? Infinity)
      ));
  }
  return (canvas.tokens?.placeables ?? []).filter(target => {
    if ((!includeAttacker && target === attackerToken) || !target.actor || !target.visible) return false;
    return geometry.type === VOLLEY_ACTION_KEY
      ? Boolean(getVisibleTokenAttackPoint(attackerToken, target, geometry))
      : Boolean(selectTargetTrajectoryAimPoint(attackerToken, target, geometry));
  }).sort((left, right) => getTargetDistance(left, geometry) - getTargetDistance(right, geometry));
}

function getVolleyTrajectoryAimTarget(attackerToken, geometry, { includeAttacker = false, includeDead = false } = {}) {
  if (!geometry || geometry.type !== VOLLEY_ACTION_KEY) return null;
  return (canvas.tokens?.placeables ?? [])
    .filter(target => {
      if ((!includeAttacker && target === attackerToken) || !target.actor || !target.visible) return false;
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
    .filter(entry => Math.max(0, toInteger(entry.overlapPercent)) > 0)
    .sort((left, right) => Math.max(0, toInteger(right.overlapPercent)) - Math.max(0, toInteger(left.overlapPercent)));
  if (!settings.length) return [];

  const ricochetEntries = Array.isArray(geometry?.ricochetCone?.strips)
    ? new Map((targets ?? []).map(target => [target, getRicochetTargetEntry(target, geometry)]))
    : new Map();
  const states = [];
  for (const target of targets ?? []) {
    if (!target?.actor || target === attackerToken || isDeadTarget(target)) continue;
    if (getActorForcedCoverData(target.actor)?.key) continue;
    const ricochetEntry = ricochetEntries.get(target);
    const obstructionGeometry = ricochetEntry?.segment
      ? { ...geometry, origin: ricochetEntry.segment.origin }
      : geometry;
    const obstructionPercent = getTokenAttackObstructionPercent(attackerToken, target, obstructionGeometry);
    const cover = settings.find(entry => obstructionPercent >= Math.max(0, toInteger(entry.overlapPercent)));
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

function getTokenAttackObstructionPercent(attackerToken, target, geometry) {
  const samples = getTokenActorCoverSamplePoints(target, geometry.origin);
  if (!samples.length) return 0;
  const blocked = samples.reduce((total, point) => (
    total + (isAttackCoverSampleBlocked(attackerToken, target, point, geometry.origin) ? 1 : 0)
  ), 0);
  return Math.round((blocked / samples.length) * 100);
}

function getTokenActorCoverSamplePoints(target, origin) {
  const polygon = getTokenWorldPolygon(target);
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

function isAttackCoverSampleBlocked(attackerToken, target, point, origin) {
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
  if (Array.isArray(coneGeometry?.ricochetCone?.rays)) {
    for (const target of targets ?? []) {
      const entry = getRicochetTargetEntry(target, coneGeometry);
      if (entry?.trajectory) return foundry.utils.deepClone(entry.trajectory);
      const trajectory = findRicochetTrajectoryForTarget(attackerToken, target, coneGeometry);
      if (trajectory) return trajectory;
    }
    return buildRandomTrajectory(attackerToken, coneGeometry);
  }
  const aimPoint = selectTrajectoryAimPoint(attackerToken, coneGeometry, targets);
  if (aimPoint) return buildTrajectoryThroughPoint(attackerToken, coneGeometry, aimPoint);
  return buildRandomTrajectory(attackerToken, coneGeometry);
}

function buildAttackTrajectories(attackerToken, coneGeometry, targets = [], count = 1) {
  const amount = Math.max(1, toInteger(count) || 1);
  if (amount <= 1) return [buildAttackTrajectory(attackerToken, coneGeometry, targets)];

  const trajectories = [];
  const reserved = new Set();
  const spacing = getPelletPointSpacing();

  for (let index = 0; index < amount; index += 1) {
    const trajectory = buildReservedPelletTrajectory(attackerToken, coneGeometry, reserved, spacing);
    trajectories.push(trajectory);
  }

  return trajectories;
}

function buildAimedAttackTrajectories(attackerToken, coneGeometry, centerTrajectory, count = 1) {
  const amount = Math.max(1, toInteger(count) || 1);
  if (amount <= 1) return [centerTrajectory];

  const trajectories = [centerTrajectory];
  const reserved = new Set();
  const spacing = getPelletPointSpacing();
  reservePelletPoint(centerTrajectory.end, reserved, spacing, true);

  for (let index = 1; index < amount; index += 1) {
    trajectories.push(buildReservedPelletTrajectory(attackerToken, coneGeometry, reserved, spacing));
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

function getRicochetTargetEntry(target, geometry) {
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
    const entries = getTrajectoryTargetEntries(null, trajectory);
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

function findRicochetTrajectoryForTarget(attackerToken, target, geometry, sampleCount = 97) {
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
    const entry = getTrajectoryTargetEntries(attackerToken, trajectory).find(candidate => candidate.target === target);
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

function getTrajectoryTargetEntries(attackerToken, trajectory) {
  if (Array.isArray(trajectory?.segments) && trajectory.segments.length) {
    const byTarget = new Map();
    for (const segment of trajectory.segments) {
      for (const target of canvas.tokens?.placeables ?? []) {
        if (target === attackerToken || !target.actor || !target.visible) continue;
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
  return (canvas.tokens?.placeables ?? [])
    .filter(target => target !== attackerToken && target.actor && target.visible)
    .map(target => ({ target, hit: getTokenTrajectoryHit(target, trajectory) }))
    .filter(entry => entry.hit && hasLineOfSight(attackerToken, entry.hit.point, trajectory.origin))
    .sort((left, right) => left.hit.distance - right.hit.distance);
}

function doesTrajectoryHitTarget(attackerToken, target, trajectory) {
  if (!target || !trajectory) return false;
  return getTrajectoryTargetEntries(attackerToken, trajectory).some(entry => entry.target === target);
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
  const flatDamage = getContextualCombatValue(actor, "damageFlat", context);
  const skillKey = String(getWeaponAttackData(weapon, weaponFunctionId)?.skillKey ?? "");
  const skillDamageBonuses = getWeaponSkillDamageBonuses(actor, skillKey);
  const attackPowerDamagePercent = toInteger(weaponData?.attackPowerDamagePercent);
  const damagePercent = attackPowerDamagePercent
    + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "damage")
    + getContextualCombatValue(actor, "damagePercent", context)
    + skillDamageBonuses.percent;
  const modifiedDamage = Math.round(formulaDamage * Math.max(0, 100 + damagePercent) / 100)
    + flatDamage
    + skillDamageBonuses.flat;
  return Math.max(0, Math.floor(modifiedDamage * getWeaponConditionWeakeningRatio(weapon)));
}

function getWeaponDamagePercentBase(weapon, weaponFunctionId = "") {
  const actor = getWeaponOwnerActor(weapon);
  const weaponData = getEffectiveWeaponDamageData(weapon, weaponFunctionId);
  return evaluateActorFormula(weaponData?.damage, actor, {
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
  explodeAtWorldTime = 0,
  weapon = null,
  weaponFunctionId = "",
  actionKey = "",
  attackerToken = null,
  finalGeometries = [],
  blastOutcomes = [],
  baseDamage = 0,
  attachmentTokenId = ""
} = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const damageTypes = getWeaponDamageTypeEntries(weapon, weaponFunctionId);
  const regionSettings = getVolleyRegionSettings(weapon, weaponFunctionId);
  const residualRegion = regionSettings.enabled
    ? {
      name: weapon?.name
        ? `${weapon.name}: ${game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.RegionName")}`
        : game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.RegionName"),
      radiusPixels: metersToPixels(regionSettings.radiusMeters),
      color: getVolleyRegionColor(regionSettings.damageEntries),
      damageEntries: regionSettings.damageEntries,
      durationSeconds: regionSettings.durationSeconds,
      radiusDeltaMeters: regionSettings.radiusDeltaMeters
    }
    : null;
  const explosions = finalGeometries.map((geometry, index) => ({
    center: serializePoint(geometry.end),
    radiusPixels: Math.max(1, Number(geometry.radiusPixels) || 1),
    damageAmount: getCriticalDamageAmount(
      weapon,
      Math.max(0, Number(baseDamage) || 0),
      blastOutcomes[index]?.outcome,
      weaponFunctionId
    ),
    pelletCount: getWeaponPelletCount(weapon, weaponFunctionId),
    damageTypes,
    penetrationPower: getWeaponPenetrationPower(weapon, weaponFunctionId, {
      actor: attackerToken?.actor,
      actionKey
    }),
    residualRegion
  }));
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
      attackerUuid: attackerToken?.actor?.uuid ?? "",
      attackerTokenId: attackerToken?.id ?? "",
      attackerTokenUuid: attackerToken?.document?.uuid ?? "",
      weaponUuid: weapon?.uuid ?? "",
      weaponName: weapon?.name ?? "",
      weaponFunctionId,
      actionKey,
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
  const durationSeconds = evaluateWeaponFormula(weapon, volley.regionDurationSeconds, {
    minimum: 0,
    context: "volley region duration"
  });
  const radiusDeltaMeters = evaluateWeaponFormula(weapon, volley.regionRadiusDeltaMeters, {
    context: "volley region radius delta"
  });
  return {
    enabled: radiusMeters > 0 && damageEntries.length > 0 && durationSeconds > 0,
    radiusMeters,
    damageEntries,
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
      amount: evaluateActorFormula(entry?.amount, actor, {
        minimum: 0,
        context: "volley region damage"
      })
    }))
    .filter(entry => entry.damageTypeKey && entry.amount > 0);
}

function getVolleyRegionColor(damageEntries = []) {
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
  const roll = Math.max(1, Math.min(100, toInteger(outcome?.selectedRoll?.total) || 50));
  const difficulty = Math.max(1, toInteger(outcome?.check?.difficulty) || BASE_VOLLEY_DIFFICULTY);
  const total = Math.max(0, toInteger(outcome?.total));
  const baseAngle = Math.atan2(target.y - origin.y, target.x - origin.x);
  const margin = total - difficulty;
  const successQuality = Math.max(0, Math.min(1, (Math.max(0, margin) + roll) / 160));
  const missSeverity = Math.max(0, Math.min(1, ((Math.max(0, -margin) / Math.max(25, difficulty)) * 0.7) + ((100 - roll) / 100 * 0.3)));
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

function buildWeaponDamageRequests(weapon, { attackerActor = null, actor = null, limbKey = "", amount = 0, source = {} } = {}, weaponFunctionId = "") {
  const damageTypes = getWeaponDamageTypeEntries(weapon, weaponFunctionId);
  const amounts = distributeIntegerAmount(amount, damageTypes.map(entry => entry.weight));
  const penetrationPower = getWeaponPenetrationPower(weapon, weaponFunctionId, {
    actor: attackerActor,
    actionKey: source.actionKey
  });
  const requestSource = {
    ...source,
    penetrationPower
  };
  return damageTypes
    .map((entry, index) => ({
      actor,
      limbKey,
      amount: amounts[index] ?? 0,
      damageTypeKey: entry.key,
      scope: "healthAndLimb",
      source: requestSource
    }))
    .filter(request => request.amount > 0);
}

function buildWeaponConditionDamageRequests(weapon, { attackerActor = null, actor = null, targetItem = null, limbKey = "", amount = 0, source = {} } = {}, weaponFunctionId = "") {
  if (!targetItem?.id || !hasItemFunction(targetItem, ITEM_FUNCTIONS.condition)) return [];
  const damageTypes = getWeaponDamageTypeEntries(weapon, weaponFunctionId);
  const amounts = distributeIntegerAmount(amount, damageTypes.map(entry => entry.weight));
  const penetrationPower = getWeaponPenetrationPower(weapon, weaponFunctionId, {
    actor: attackerActor,
    actionKey: source.actionKey
  });
  const requestSource = {
    ...source,
    penetrationPower,
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

function estimateDamageRequestGroup(requests = []) {
  return requests.reduce((total, request) => {
    const estimate = estimateDamageApplication(request);
    total.amount += estimate.amount ?? 0;
    total.healthDamage += estimate.healthDamage ?? 0;
    total.limbDamage += estimate.limbDamage ?? 0;
    total.itemConditionDamage += estimate.itemConditionDamage ?? 0;
    total.partDamage += estimate.partDamage ?? Math.max(estimate.limbDamage ?? 0, estimate.itemConditionDamage ?? 0);
    if (Number.isFinite(Number(estimate.penetrationRemainder))) {
      total.penetrationRemainder = total.penetrationRemainder === null
        ? Math.max(0, toInteger(estimate.penetrationRemainder))
        : Math.min(total.penetrationRemainder, Math.max(0, toInteger(estimate.penetrationRemainder)));
    }
    return total;
  }, { amount: 0, healthDamage: 0, limbDamage: 0, itemConditionDamage: 0, partDamage: 0, penetrationRemainder: null });
}

function doesDamageRequestGroupPenetratePart(requests = [], actor = null, targetSelection = null) {
  const relevantRequests = (Array.isArray(requests) ? requests : [requests])
    .filter(request => isDamageRequestForTargetSelection(request, targetSelection));
  const estimate = estimateDamageRequestGroup(relevantRequests);
  const max = getTargetSelectionConditionMax(actor, targetSelection);
  if (max <= 0 || estimate.partDamage <= 0) return false;
  const remainingPenetration = Math.max(0, toInteger(estimate.penetrationRemainder));
  const requiredPercent = Math.max(0, 50 - remainingPenetration);
  const threshold = Math.ceil(max * requiredPercent / 100);
  return estimate.partDamage >= threshold;
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
    + stealth.criticalChanceBonus
    - getWeaponConditionCritChancePenalty(weapon);
  return {
    criticalSuccessBonus: Math.max(0, modifier),
    criticalFailureBonus: Math.max(0, -modifier)
  };
}

function getCriticalDamageAmount(weapon, amount, outcome, weaponFunctionId = "") {
  const baseAmount = Math.max(0, Number(amount) || 0);
  const stealth = getStealthAttackModifiers(getWeaponOwnerActor(weapon));
  const stealthDamage = Math.floor(baseAmount * Math.max(0, toInteger(stealth.damageBonusPercent)) / 100);
  const modifiedBaseAmount = baseAmount + stealthDamage;
  if (!isCriticalSuccessAttack(outcome)) return modifiedBaseAmount;
  const rawPercent = evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.criticalDamagePercent, {
    fallback: 150,
    minimum: 0,
    context: "critical damage percent"
  });
  const percent = Math.max(0, rawPercent
    + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "criticalDamage"));
  return Math.round(modifiedBaseAmount * percent / 100);
}

function getCriticalFailureResourceCosts(weapon, actionKey, weaponFunctionId = "") {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const availableTypes = new Set(getWeaponResourceCosts(weaponData).map(cost => String(cost?.type ?? "")).filter(Boolean));
  return (weaponData?.[actionKey]?.criticalFailureConsequences ?? [])
    .filter(consequence => String(consequence?.type ?? "") === "extraResourceCost")
    .map(consequence => ({
      type: String(consequence?.resourceType ?? ""),
      amount: Math.max(0, toInteger(consequence?.amount))
    }))
    .filter(consequence => consequence.amount > 0 && availableTypes.has(consequence.type));
}

function getEffectiveRangeDifficultyBonus(weapon, attackerToken, target, weaponFunctionId = "") {
  return getEffectiveRangeDifficultyBonusForDistance(
    getWeaponAttackData(weapon, weaponFunctionId),
    getTokenDistanceMeters(attackerToken, target),
    attackerToken?.actor ?? null
  );
}

function getPostureAttackEdgeModifiers({ attackerToken = null, targetToken = null, weapon = null, weaponFunctionId = "" } = {}) {
  if (!isVulnerableAttackPosture(getTokenAttackPosture(targetToken))) return {};

  const rangeState = getConfiguredEffectiveRangeState(weapon, attackerToken, targetToken, weaponFunctionId);
  if (rangeState === "inside") return { advantage: true, advantageCount: 1 };
  if (rangeState === "outside") return { disadvantage: true, disadvantageCount: 1 };
  return {};
}

function getConfiguredEffectiveRangeState(weapon, attackerToken, targetToken, weaponFunctionId = "") {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const range = getEffectiveRangeBounds(weaponData?.effectiveRange, attackerToken?.actor ?? null);
  if (!range) return "";

  const distance = getTokenDistanceMeters(attackerToken, targetToken);
  if (!Number.isFinite(distance)) return "";
  return distance >= range.min && distance <= range.max ? "inside" : "outside";
}

function getTokenAttackPosture(token) {
  const direct = String(token?.document?._source?.movementAction ?? token?.document?.movementAction ?? "").trim();
  return direct || getActorPostureAction(token?.actor);
}

function isVulnerableAttackPosture(action = "") {
  return ["burrow", "knocked"].includes(String(action ?? "").trim());
}

function getEffectiveRangeDifficultyBonusForDistance(weaponData = {}, distanceMeters = 0, actor = null) {
  const range = getEffectiveRangeBounds(weaponData?.effectiveRange, actor);
  if (!range) return 0;
  const distance = Math.max(0, Number(distanceMeters) || 0);
  if (distance >= range.min && distance <= range.max) return 0;
  const overrun = distance < range.min ? range.min - distance : distance - range.max;
  return Math.max(0, Math.round(overrun)) * 10;
}

function getEffectiveRangeBounds(effectiveRange = {}, actor = null) {
  const first = evaluateActorFormula(effectiveRange?.value, actor, {
    minimum: 0,
    context: "effective range"
  });
  const second = evaluateActorFormula(effectiveRange?.max, actor, {
    minimum: 0,
    context: "effective range max"
  });
  if (first <= 0 && second <= 0) return null;
  if (second <= 0) return { min: 0, max: first };
  return {
    min: Math.min(first, second),
    max: Math.max(first, second)
  };
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
  const directions = MELEE_DIRECTIONS.filter(direction => isWeaponAttackModeEnabled(weapon, actionKey, direction.mode, weaponFunctionId));
  return directions.length ? directions : MELEE_DIRECTIONS;
}

export function isWeaponAttackModeEnabled(weapon, actionKey, mode, weaponFunctionId = "") {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const thrustEnabled = weaponData?.[actionKey]?.thrust?.enabled !== false;
  const swingEnabled = weaponData?.[actionKey]?.swing?.enabled !== false;
  if (!thrustEnabled && !swingEnabled) return true;
  return getAttackModeSettings(weapon, actionKey, mode, weaponFunctionId)?.enabled !== false;
}

function getAttackModeAccuracyModifier(weapon, actionKey, mode, weaponFunctionId = "", context = {}) {
  return getWeaponAccuracyModifier(weapon, weaponFunctionId, context)
    + toInteger(getAttackModeSettings(weapon, actionKey, mode, weaponFunctionId)?.accuracyModifier)
}

function getWeaponAccuracyModifier(weapon, weaponFunctionId = "", context = {}) {
  const actor = getWeaponOwnerActor(weapon);
  return evaluateWeaponFormula(weapon, getWeaponAttackData(weapon, weaponFunctionId)?.accuracyBonus, {
    minimum: -Infinity,
    context: "weapon accuracy"
  })
    + getWeaponProficiencyInfluenceBonus(weapon, weaponFunctionId, "accuracy")
    + getContextualCombatValue(actor, "accuracy", context)
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
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const proficiency = getWeaponProficiencySetting(weaponData);
  if (!proficiency) return 0;

  const range = getProficiencyInfluenceSettings()?.[influenceKey] ?? { min: 0, max: 0 };
  const minimum = toInteger(range.min);
  const maximum = toInteger(range.max);
  const actorValue = toInteger(actor.system?.proficiencies?.[proficiency.key]?.value);
  const settingMax = Math.max(0, toInteger(proficiency.max));
  const ratio = settingMax > 0 ? clamp(actorValue / settingMax, 0, 1) : 0;
  return Math.round(minimum + ((maximum - minimum) * ratio));
}

function getWeaponProficiencySetting(weaponData = {}) {
  const proficiencies = getProficiencySettings();
  if (!proficiencies.length) return null;
  const key = String(weaponData?.proficiencyKey ?? "");
  return proficiencies.find(proficiency => proficiency.key === key) ?? proficiencies[0] ?? null;
}

function getWeaponOwnerActor(weapon) {
  const parent = weapon?.parent;
  return parent?.documentName === "Actor" ? parent : null;
}

function evaluateWeaponFormula(weapon, formula, options = {}) {
  return evaluateActorFormula(formula, getWeaponOwnerActor(weapon), options);
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

function getWeaponPenetrationPower(weapon, weaponFunctionId = "", { actor = null, actionKey = "" } = {}) {
  const base = evaluateActorFormula(getWeaponAttackData(weapon, weaponFunctionId)?.penetration, actor ?? getWeaponOwnerActor(weapon), {
    minimum: 0,
    context: "weapon penetration"
  });
  const modifier = collectActionPenetrationModifier(actor, actionKey);
  let value = base;
  if (modifier.override !== null && modifier.override !== undefined && modifier.override !== "") value = Number(modifier.override);
  value *= Number.isFinite(Number(modifier.multiplier)) ? Number(modifier.multiplier) : 1;
  value += Number(modifier.add) || 0;
  return Math.max(0, Math.trunc(value));
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

function getNearestAttackChanceTarget(attackerToken, geometry, targets = []) {
  if (!geometry || !targets.length) return null;
  const trajectory = buildAttackTrajectory(attackerToken, geometry, targets);
  return getTrajectoryTargetEntries(attackerToken, trajectory).at(0)?.target ?? null;
}

function buildBurstTargetRanges(attackerToken, geometry, targets = [], attackCount = 1, { primaryShots = null } = {}) {
  return new Map(buildBurstTargetEntries(attackerToken, geometry, targets, attackCount, { primaryShots })
    .map(entry => [entry.target, entry.range]));
}

function buildBurstBulletAssignments(attackerToken, geometry, targets = [], attackCount = 1, { primaryShots = null } = {}) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  const allowedTargets = new Set(targets);
  const shots = getBurstPrimaryShots(attackerToken, geometry, amount, primaryShots);
  return Array.from({ length: amount }, (_value, index) => {
    const target = shots[index]?.target ?? null;
    return target && allowedTargets.has(target) ? target : null;
  });
}

function buildBurstTargetEntries(attackerToken, geometry, targets = [], attackCount = 1, { primaryShots = null } = {}) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  if (!geometry || geometry.type === VOLLEY_ACTION_KEY || !targets.length) return [];
  const { buckets, denominator, distances, weights } = getBurstTargetHitDistribution(attackerToken, geometry, targets, amount);
  if (denominator <= 0) return [];
  return Array.from(buckets.entries())
    .filter(([target, shots]) => ((weights.get(target) ?? shots.length) > 0) && target?.actor && target.visible)
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

function buildBurstDistributionShots(attackerToken, geometry, attackCount = 1) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  const sampleCount = Math.max(BURST_DISTRIBUTION_SAMPLE_MIN, amount * BURST_DISTRIBUTION_SAMPLE_MULTIPLIER);
  const shotGeometry = getRandomBurstMissGeometry(attackerToken, geometry);
  return Array.from({ length: sampleCount }, (_value, index) => {
    const offset = sampleCount <= 1 ? 0 : -1 + ((2 * index) / (sampleCount - 1));
    const angle = (Number(geometry?.angle) || 0) + ((Number(geometry?.halfAngle) || 0) * offset);
    const trajectory = buildTrajectoryByAngle(attackerToken, shotGeometry, angle, Number(shotGeometry?.elevationSlope) || 0);
    const hit = getTrajectoryTargetEntries(attackerToken, trajectory).at(0) ?? null;
    return {
      trajectory,
      target: hit?.target ?? null,
      hit: hit?.hit ?? null
    };
  });
}

function getBurstTargetHitDistribution(attackerToken, geometry, targets = [], attackCount = 1) {
  const allowedTargets = new Set(targets);
  const aimShots = new Map();
  const buckets = new Map();
  const distances = new Map();
  const distributionShots = buildBurstDistributionShots(attackerToken, geometry, attackCount);
  for (const shot of distributionShots) {
    const target = shot?.target ?? null;
    if (!target || !allowedTargets.has(target) || !target.actor || !target.visible) continue;
    if (!buckets.has(target)) buckets.set(target, []);
    buckets.get(target).push(shot);
    distances.set(target, Math.min(distances.get(target) ?? Infinity, Number(shot.hit?.distance) || getTargetDistance(target, geometry)));
  }

  const sampleCount = Math.max(1, distributionShots.length);
  const weights = new Map(Array.from(buckets.entries()).map(([target, shots]) => [target, shots.length]));
  for (const target of allowedTargets) {
    if (!target?.actor || !target.visible) continue;
    const axisProfile = getBurstTargetAxisProfile(target, geometry, sampleCount);
    const aimWeight = axisProfile?.weight ?? 0;
    if (aimWeight <= 0 || !axisProfile?.point) continue;
    const aimShot = buildBurstTargetAimShot(attackerToken, geometry, target, axisProfile.point);
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

function buildBurstTargetAimShot(attackerToken, geometry, target, point = null) {
  const aimPoint = isTargetTrajectoryAimPointValid(attackerToken, target, geometry, point)
    ? point
    : selectTargetTrajectoryAimPoint(attackerToken, target, geometry);
  if (!aimPoint) return null;
  const trajectory = buildTrajectoryThroughPoint(attackerToken, geometry, aimPoint);
  const hit = getTrajectoryTargetEntries(attackerToken, trajectory).at(0);
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

function buildBurstPrimaryShots(attackerToken, geometry, attackCount = 1) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  const shotGeometry = getRandomBurstMissGeometry(attackerToken, geometry);
  return Array.from({ length: amount }, () => {
    const trajectory = buildRandomTrajectory(attackerToken, shotGeometry);
    const hit = getTrajectoryTargetEntries(attackerToken, trajectory).at(0) ?? null;
    return {
      trajectory,
      target: hit?.target ?? null,
      hit: hit?.hit ?? null
    };
  });
}

function buildBurstPrimaryShotsForRanges(attackerToken, geometry, attackCount = 1, targets = [], burstRanges = new Map()) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  const distributedShots = buildBurstPrimaryShotsFromTargetDistribution(attackerToken, geometry, amount, targets);
  if (distributedShots.length === amount) return distributedShots;
  if (!burstRanges?.size) return buildBurstPrimaryShots(attackerToken, geometry, amount);
  const allowedTargets = new Set(targets);
  let bestShots = null;
  let bestScore = Infinity;
  const attempts = Math.max(120, amount * 30);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const shots = buildBurstPrimaryShots(attackerToken, geometry, amount);
    const score = getBurstShotRangeMismatchScore(shots, allowedTargets, burstRanges);
    if (score <= 0) return shots;
    if (score >= bestScore) continue;
    bestScore = score;
    bestShots = shots;
  }

  return bestShots ?? buildBurstPrimaryShots(attackerToken, geometry, amount);
}

function buildBurstPrimaryShotsFromTargetDistribution(attackerToken, geometry, attackCount = 1, targets = []) {
  const amount = Math.max(1, toInteger(attackCount) || 1);
  const distribution = getBurstTargetHitDistribution(attackerToken, geometry, targets, amount);
  const { aimShots, buckets, denominator, distances, missWeight, weights } = distribution;
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

function getBurstPrimaryShots(attackerToken, geometry, attackCount = 1, primaryShots = null) {
  return Array.isArray(primaryShots) ? primaryShots : buildBurstPrimaryShots(attackerToken, geometry, attackCount);
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
    .filter(target => target !== selectedTarget && target?.actor && target.visible)
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
  const x = Number(token?.position?.x);
  const y = Number(token?.position?.y);
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
  const bottom = getTokenAbsoluteElevation(token, document?._source?.elevation ?? document?.elevation ?? token?.elevation ?? 0);
  const depth = Math.max(0, Number(document?._source?.depth ?? document?.depth ?? 1) || 0) * gridDistance;
  const top = bottom + (depth > 0 ? depth : gridDistance);
  return { bottom: Math.min(bottom, top), top: Math.max(bottom, top) };
}

function getTokenAbsoluteElevation(token, elevation = null) {
  const localElevation = Number.isFinite(Number(elevation))
    ? Number(elevation)
    : Number(token?.document?._source?.elevation ?? token?.document?.elevation ?? token?.elevation ?? 0) || 0;
  return localElevation + getTokenLevelBaseElevation(token);
}

function getTokenLevelBaseElevation(token) {
  const document = token?.document;
  const scene = document?.parent ?? token?.scene ?? canvas.scene;
  const levelId = document?._source?.level ?? document?.level ?? token?.level?.id ?? "";
  const level = levelId ? scene?.levels?.get?.(levelId) : null;
  const base = Number(level?.elevation?.base ?? level?.elevation?.bottom);
  return Number.isFinite(base) ? base : 0;
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
    if (!attackerUuid || !targetUuid) continue;
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

function getAimedAttackDifficulty(targetActor, limbKey = "", blockerBonus = 0, { innateDifficultyIgnorePercent = 0, ignoreCover = false } = {}) {
  const dodge = getDodgeDifficulty(targetActor, { ignoreCover });
  const limb = targetActor.system?.limbs?.[limbKey];
  const limbPercent = toInteger(limb?.aimedDifficultyPercent);
  const limbBonus = Math.max(0, toInteger(limb?.aimedDifficultyBonus));
  const innateDifficulty = Math.round(dodge * (limbPercent / 100)) + limbBonus;
  const ignorePercent = Math.max(0, Math.min(100, toInteger(innateDifficultyIgnorePercent)));
  const remainingInnateDifficulty = Math.round(innateDifficulty * (100 - ignorePercent) / 100);
  return dodge + remainingInnateDifficulty + Math.max(0, toInteger(blockerBonus));
}

function getContextualCombatValue(actor, key, context = {}) {
  const value = getContextualAbilityChangeValue(actor, `system.combat.${key}`, {
    ...context,
    baseValue: toInteger(actor?.system?.combat?.[key])
  });
  const modifierState = context?.weaponActionModifierState ?? null;
  const modifierBonus = typeof modifierState?.getCombatValueBonus === "function"
    ? modifierState.getCombatValueBonus(key, context)
    : 0;
  return value + modifierBonus;
}

function applyContextualDamageToAmount(weapon, amount, context = {}) {
  const actor = getWeaponOwnerActor(weapon);
  const baselineContext = getDamageBaselineContext(context);
  const flatDelta = getContextualCombatValue(actor, "damageFlat", context)
    - getContextualCombatValue(actor, "damageFlat", baselineContext);
  const percentDelta = getContextualCombatValue(actor, "damagePercent", context)
    - getContextualCombatValue(actor, "damagePercent", baselineContext);
  const pelletCount = Math.max(1, getWeaponPelletCount(weapon, context?.weaponFunctionId));
  const percentBase = Math.max(0, Number(context?.damagePercentBaseAmount ?? (getWeaponDamagePercentBase(weapon, context?.weaponFunctionId) / pelletCount)) || 0);
  const adjusted = Math.max(0, Number(amount) || 0) + (flatDelta / pelletCount) + (percentBase * percentDelta / 100);
  return Math.max(0, Math.round(adjusted));
}

function getDamageBaselineContext(context = {}) {
  const {
    targetActor,
    targetToken,
    ...baseline
  } = context ?? {};
  return baseline;
}

function getAimedWeaponTargetKey(item = null) {
  return `weapon:${String(item?.id ?? "").trim()}`;
}

function resolveAimedTargetSelection(actor, key = "") {
  const value = String(key ?? "").trim();
  if (!value) return null;
  if (!value.startsWith("weapon:")) {
    return actor?.system?.limbs?.[value] ? { type: "limb", limbKey: value } : null;
  }

  const itemId = value.slice("weapon:".length);
  const entry = getHeldWeaponAimTargets(actor).find(target => target.item?.id === itemId);
  return entry ? { type: "weapon", item: entry.item, limbKey: entry.limbKey } : null;
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
    ? String(actor.items?.get?.(selectedWeaponId)?.system?.placement?.weaponSet ?? "")
    : "";
  if (selectedWeaponSet && availableSetKeys.has(selectedWeaponSet)) return selectedWeaponSet;

  return Array.from(availableSetKeys).at(0) ?? "";
}

function getActorWeaponSetKeys(actor, race = null) {
  const keys = new Set((race?.weaponSets ?? []).map(set => String(set.key ?? "")).filter(Boolean));
  if (actor?.type !== "construct" && Array.from(actor?.items ?? []).some(item => isNaturalRaceWeapon(item))) {
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

function getDirectedAttackDifficulty(targetActor, limbKey = "", aimed = false, difficultyBonus = 0) {
  const base = aimed
    ? getAimedAttackDifficulty(targetActor, limbKey, 0)
    : getDodgeDifficulty(targetActor);
  return base + Math.max(0, toInteger(difficultyBonus));
}

function getGeneralAttackHitChance(attackerActor, weapon, targetActor, { difficultyBonus = 0, actionKey = "", weaponFunctionId = "", accuracyBonus = 0 } = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const skillKey = String(weaponData?.skillKey ?? "");
  const context = { targetActor, weaponData, weaponActionKey: String(actionKey ?? "").trim() };
  const finalSkillValue = getContextualAttackSkillValue(attackerActor, skillKey, context)
    + getWeaponAccuracyModifier(weapon, weaponFunctionId, context)
    + toInteger(accuracyBonus);
  const difficulty = getDodgeDifficulty(targetActor)
    + Math.max(0, toInteger(difficultyBonus))
    + getWeaponRequirementDifficultyPenalty(attackerActor, weapon, weaponFunctionId);
  return getSkillCheckSuccessChance(attackerActor, finalSkillValue, difficulty, getWeaponCriticalCheckModifiers(weapon, weaponFunctionId, context));
}

function getVolleyAreaHitChance(attackerActor, weapon, geometry, { difficultyBonus = 0, actionKey = "", weaponFunctionId = "" } = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const skillKey = String(weaponData?.skillKey ?? "");
  const context = { weaponData, weaponActionKey: String(actionKey ?? "").trim() };
  const finalSkillValue = getContextualAttackSkillValue(attackerActor, skillKey, context)
    + getWeaponAccuracyModifier(weapon, weaponFunctionId, context);
  const rangeDifficultyBonus = getEffectiveRangeDifficultyBonusForDistance(
    weaponData,
    getAttackGeometryDistanceMeters(geometry),
    attackerActor
  );
  const difficulty = BASE_VOLLEY_DIFFICULTY
    + rangeDifficultyBonus
    + getWeaponRequirementDifficultyPenalty(attackerActor, weapon, weaponFunctionId)
    + Math.max(0, toInteger(difficultyBonus));
  return getSkillCheckSuccessChance(attackerActor, finalSkillValue, difficulty, getWeaponCriticalCheckModifiers(weapon, weaponFunctionId, context));
}

function getAimedAttackHitChance(attackerActor, weapon, targetActor, limbKey = "", blockerBonus = 0, weaponFunctionId = "", actionKey = "", options = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const skillKey = String(weaponData?.skillKey ?? "");
  const context = { targetActor, weaponData, weaponActionKey: String(actionKey ?? "").trim() };
  const finalSkillValue = getContextualAttackSkillValue(attackerActor, skillKey, context)
    + getWeaponAccuracyModifier(weapon, weaponFunctionId, context)
    + toInteger(options.accuracyBonus);
  const difficulty = getAimedAttackDifficulty(
    targetActor,
    limbKey,
    blockerBonus + getWeaponRequirementDifficultyPenalty(attackerActor, weapon, weaponFunctionId),
    options
  );
  return getSkillCheckSuccessChance(attackerActor, finalSkillValue, difficulty, getWeaponCriticalCheckModifiers(weapon, weaponFunctionId, context));
}

function getDirectedAttackHitChance(attackerActor, weapon, targetActor, { actionKey = "", mode = "thrust", limbKey = "", difficultyBonus = 0, weaponFunctionId = "", accuracyBonus = 0 } = {}) {
  const weaponData = getWeaponAttackData(weapon, weaponFunctionId);
  const skillKey = String(weaponData?.skillKey ?? "");
  const context = { targetActor, weaponData, weaponActionKey: String(actionKey ?? "").trim() };
  const finalSkillValue = getContextualAttackSkillValue(attackerActor, skillKey, context)
    + getAttackModeAccuracyModifier(weapon, actionKey, mode, weaponFunctionId, context)
    + toInteger(accuracyBonus);
  const difficulty = getDirectedAttackDifficulty(
    targetActor,
    limbKey,
    Boolean(limbKey),
    difficultyBonus + getWeaponRequirementDifficultyPenalty(attackerActor, weapon, weaponFunctionId)
  );
  return getSkillCheckSuccessChance(attackerActor, finalSkillValue, difficulty, getAttackModeCriticalCheckModifiers(weapon, actionKey, mode, weaponFunctionId, context));
}

function getContextualAttackSkillValue(actor, skillKey = "", context = {}) {
  return getContextualAbilityChangeValue(actor, `system.skills.${skillKey}.bonus`, {
    ...context,
    baseValue: toInteger(actor?.system?.skills?.[skillKey]?.value),
    alternateKeys: ["system.skills.all.bonus"]
  });
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
    const required = Math.max(0, toInteger(requirement?.value));
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

function getAimedTargetBlockers(attackerToken, selectedTarget, trajectory) {
  const selectedHit = getTokenTrajectoryHit(selectedTarget, trajectory);
  if (!selectedHit) return [];
  return getTrajectoryTargetEntries(attackerToken, trajectory)
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

function getAttackPreviewLayer() {
  return canvas.controls._rulerPaths;
}

export async function spendWeaponReloadActionPoints(actor, weapon, weaponFunctionId = "") {
  await spendWeaponActionPoints(actor, weapon, "reload", weaponFunctionId);
}

export function hasRequiredWeaponReloadActionPoints(actor, weapon, weaponFunctionId = "") {
  return hasRequiredWeaponActionPoints(actor, weapon, "reload", weaponFunctionId);
}
