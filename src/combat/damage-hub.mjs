import { BLEEDING_DAMAGE_TYPE_KEY, SYSTEM_ID, TEMPLATES, TRAUMA_CREATE_OPTION } from "../constants.mjs";
import { spendActorDodgeForAreaDamage, spendDodgeForAreaDamageRequests } from "./dodge-resource.mjs";
import { evaluateFormulaVariables, parseFormula } from "../formulas/index.mjs";
import {
  getCombatSettings,
  getPreparedRuntimeSettings,
  getTimeMechanicsIgnored,
  getTokenActionHudDamageIcons
} from "../settings/accessors.mjs";
import {
  canActorLimbBeAutomaticallyDestroyed,
  getActorLimbDestructionMode
} from "../settings/combat.mjs";
import { getTraumaGroupForActor } from "../settings/traumas.mjs";
import { getActiveRulesProfile } from "../settings/rules-profiles.mjs";
import { createSkillCheckBatchCollector, requestSkillCheck } from "../rolls/skill-check.mjs";
import { withQueuedReactionOpportunityWave } from "./reaction-hub.mjs";
import { advanceWorldTime, registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { registerWorldTimeActorCandidateIndex } from "../time/world-time-actor-index.mjs";
import { setActorTokensPosture } from "../canvas/posture-movement.mjs";
import { regionBehaviorTargetsActor } from "../canvas/region-targeting.mjs";
import { getPeriodicDamageScenes } from "../canvas/periodic-region-index.mjs";
import {
  CONSTRUCT_PART_MITIGATION_LIMB_KEY,
  DAMAGE_MITIGATION_MODES,
  ITEM_FUNCTIONS,
  getConditionFunction,
  getConditionWeakeningData,
  getConstructPartFunction,
  getDamageMitigationFunction,
  getProsthesisFunction,
  getWeaponLimbDamageMultiplier,
  getWeaponFunctionById,
  hasItemFunction
} from "../utils/item-functions.mjs";
import { selectRandomWeightedLimbKey } from "../utils/limb-randomization.mjs";
import {
  isConstructPartDestroyed,
  isLimbDestroyed,
  isLimbPhysicallyMissing
} from "../utils/limb-state.mjs";
import {
  evaluateActorEffectChangeBaseNumber,
  evaluateActorEffectChangeNumber,
  getActorSuppressedTraumaDiseaseIds
} from "../utils/active-effect-changes.mjs";
import { UNCONSCIOUSNESS_IMMUNITY_EFFECT_KEY } from "../utils/active-effect-keys.mjs";
import {
  createActorEffectSnapshot,
  getActorEffectChangeEntries
} from "../documents/actor-effect-preparation-index.mjs";
import {
  absorbDamageWithBarrier,
  commitDamageBarrierLedger,
  createDamageBarrierLedger
} from "./damage-barriers.mjs";
import {
  buildDamageApplicationBreakdownIndex,
  buildDamageApplicationDeltaIndex,
  getDamageEventIndexEntry
} from "./damage-batch-index.mjs";
import {
  PERIODIC_HEALING_INTERVAL_SECONDS,
  countPeriodicHealingTicks,
  evaluatePeriodicHealingPerTick,
  getPeriodicHealingEffectChanges,
  isPeriodicHealingEffectKey
} from "./periodic-healing.mjs";
import { getContextualAbilityChangeValue, getContextualAbilityChangeValues } from "../abilities/evaluation.mjs";
import { isPhantomEntity } from "../abilities/phantom-entity.mjs";
import { getUnconsciousnessResistanceActiveUseKeys } from "../abilities/active-use-keys.mjs";
import {
  commitPreparedActiveUseOperations,
  getActiveUseOperationId,
  prepareActiveUseOperation
} from "../abilities/active-use-runtime.mjs";
import { evaluateActorFormula, isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { toInteger, toOptionalFiniteNumber } from "../utils/numbers.mjs";
import { getSmokeSpecialProperty } from "../utils/region-special-properties.mjs";
import {
  getMaximumCircleRadiusPixels,
  getSphericalRegionCenterElevation,
  getSphericalRegionElevation
} from "../utils/region-elevation.mjs";
import {
  getActorInventoryGridDimensions
} from "../utils/actor-display-data.mjs";
import {
  LOCKED_STORAGE_PARENT_ID,
  LOCKED_STORAGE_PLACEMENT_MODE,
  ROOT_CONTAINER_ID,
  createStoredPlacement,
  findFirstAvailableResolvedInventoryPlacement,
  getContextInventoryItems,
  getItemFootprint
} from "../utils/inventory-containers.mjs";
import { planActorInventoryGrant } from "../utils/inventory-grants.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import { beginBulkOperation, endBulkOperation } from "../utils/bulk-operation.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { registerCombatRoundStartHandler } from "./turn-events.mjs";
import {
  getConstructPartLimbKey,
  getConstructPartSlotForLimb,
  getConstructPartSlotId,
  getConstructPartTypeLabel,
  getInstalledConstructPartForLimb
} from "../utils/construct-parts.mjs";
import {
  CONSCIOUSNESS_RESOURCE_KEY,
  CONSCIOUSNESS_RECOVERY_TARGET_PATH,
  buildConsciousnessUpdateData,
  calculateConsciousnessHealingGain,
  calculateConsciousnessRecoveryValue,
  calculateShockConsciousnessValue,
  hasConsciousnessDepletionTransition,
  isConsciousnessUnconscious
} from "./consciousness.mjs";
import {
  activeEffectChangesEqual,
  canonicalizeActiveEffectChanges
} from "../utils/active-effect-source.mjs";
import { applyActorNeedChanges } from "../needs/need-change-runtime.mjs";
import { mergeMatchingTraumaEffectChanges } from "./trauma-effect-merging.mjs";
import {
  applyIndependentHealthChange,
  buildIndependentHealthUpdate,
  calculateIndependentLimbDamage,
  calculateIntegratedProsthesisHealthLoss,
  createIndependentHealthState,
  usesIndependentHealthModel
} from "./independent-health.mjs";
export {
  getResourceBlockState,
  getResourceLimitState
} from "./resource-limits.mjs";
export { isLimbDestroyed, isLimbPhysicallyMissing };

const DAMAGE_SOCKET = `system.${SYSTEM_ID}`;
export const DAMAGE_APPLIED_HOOK = "fallout-maw.damageApplied";
const DAMAGE_SOCKET_REQUEST_TIMEOUT_MS = 60000;
const TRAUMA_FLAG_SCOPE = "fallout-maw";
const TRAUMA_FLAG_KEY = "trauma";
const DAMAGE_EFFECT_FLAG_KEY = "damageEffect";
const LIMB_LOSS_EFFECT_KIND = "limbLoss";
const FIRST_AID_TEMPORARY_EFFECT_KIND = "firstAidTemporary";
const FIRST_AID_WITHDRAWAL_EFFECT_KIND = "firstAidWithdrawal";
const FIRST_AID_WITHDRAWAL_PAYLOAD_FLAG_KEY = "firstAidWithdrawal";
const ITEM_ACTOR_HEALTH_SNAPSHOT_OPTION = "falloutMawActorHealthBeforeItemMutation";
const ACTOR_VITAL_STATUS_SNAPSHOTS_OPTION = "falloutMawVitalStatusBeforeByActor";
const ACTIVE_EFFECT_CONSCIOUSNESS_RELEVANCE_OPTION = "falloutMawConsciousnessEffectRelevantBefore";
const VITAL_STATUS_SYNCHRONIZATION_OPTION = "falloutMawVitalStatusSynchronization";
const BLEEDING_DAMAGE_EFFECT_KIND = "bleedingDamage";
const PERIODIC_DAMAGE_EFFECT_KIND = "periodicDamage";
const DAMAGE_EFFECT_CHANGE_ROOT = "system.damageEffects";
const DAMAGE_EFFECT_CHANGE_TYPE = "custom";
const MANAGED_TIMED_DAMAGE_FLAG_KEY = "managedTimedDamage";
const MANAGED_TIMED_DAMAGE_EXPIRY = "fallout-maw.managedTimedDamage";
const REGION_DAMAGE_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const REGION_DAMAGE_FLAG_KEY = "periodicDamage";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const HEALING_DAMAGE_TYPE_KEY = "healing";
const MODE_DAMAGE = "damage";
const MODE_HEALING = "healing";
const SCOPE_LIMB = "limb";
const SCOPE_HEALTH = "health";
const SCOPE_HEALTH_AND_LIMB = "healthAndLimb";
const SCOPE_ITEM_CONDITION = "itemCondition";
const ROUND_SECONDS = 6;
const DAMAGE_NUMBER_ANIMATION_MS = 900;
const DAMAGE_MITIGATION_ICON_ANIMATION_MS = 1000;
const HEALING_NUMBER_COLOR = "#62d96b";
const DAMAGE_MITIGATION_PENETRATION_FLAT_STEP = 1;
const RESISTANCE_OVERHEAT_DURATION_SECONDS = 24;
const RESISTANCE_OVERHEAT_RATIO = 0.1;
const RESISTANCE_OVERHEAT_EFFECT_KIND = "resistanceOverheat";
const RESISTANCE_OVERHEAT_EFFECT_NAME = "Перегрев сопротивлений";
const RESISTANCE_OVERHEAT_EFFECT_IMG = "icons/svg/fire-shield.svg";
const STATUS_EFFECTS = Object.freeze({
  dead: "dead",
  unconscious: "unconscious",
  blind: "blind"
});
const INCAPACITATING_DODGE_OVERRIDE_STATUSES = new Set([
  STATUS_EFFECTS.dead,
  STATUS_EFFECTS.unconscious
]);
const DODGE_RESOURCE_BONUS_EFFECT_KEY = "system.resources.dodge.bonus";
const INCAPACITATING_DODGE_OVERRIDE_PRIORITY = 9999;
const OVERLAY_STATUS_EFFECTS = new Set([
  STATUS_EFFECTS.dead,
  STATUS_EFFECTS.unconscious
]);
const SUPPRESSED_STATUS_EFFECT_ANIMATIONS = new Set([
  STATUS_EFFECTS.dead,
  STATUS_EFFECTS.unconscious
]);
const COST_EFFECT_KEYS = Object.freeze({
  movement: "system.costs.movement",
  action: "system.costs.action",
  actions: Object.freeze({
    aimedShot: "system.costs.actions.aimedShot",
    snapshot: "system.costs.actions.snapshot",
    burst: "system.costs.actions.burst",
    volley: "system.costs.actions.volley",
    meleeAttack: "system.costs.actions.meleeAttack",
    aimedMeleeAttack: "system.costs.actions.aimedMeleeAttack",
    push: "system.costs.actions.push",
    reload: "system.costs.actions.reload",
    firstAid: "system.costs.actions.firstAid"
  })
});
const EQUIPMENT_CONDITION_DAMAGE_VARIABLES = Object.freeze([
  "incoming",
  "final",
  "blocked",
  "protected",
  "penetrated",
  "condition",
  "conditionMax",
  "mitigation",
  "penetration"
]);
let damageTimeHooksRegistered = false;
let timedDamageActorIndex = null;
let periodicHealingEffectHooksRegistered = false;
let consciousnessHooksRegistered = false;
let consciousnessStatusSynchronizationReady = false;
const combatRoundWorldTimes = new Map();
const processingPeriodicEffectUuids = new Set();
const damageMitigationTextureCache = new Map();
const actorDamageStatusSyncQueue = new Map();
const actorDamageMutationQueue = new Map();
const pendingDamageSocketRequests = new Map();
const lethalDamagePreventionHandlers = new Set();
const unconsciousnessPreventionHandlers = new Set();
const finalHealthDamageInterceptors = new Map();
const damageAppliedHandlers = new Map();
let damageHubOperationQueue = Promise.resolve();
let activeDamageHubOperation = null;

export function registerLethalDamagePreventionHandler(handler) {
  if (typeof handler !== "function") return () => undefined;
  lethalDamagePreventionHandlers.add(handler);
  return () => lethalDamagePreventionHandlers.delete(handler);
}

/** Give system abilities an awaited opportunity to prevent new unconsciousness. */
export function registerUnconsciousnessPreventionHandler(handler) {
  if (typeof handler !== "function") return () => undefined;
  unconsciousnessPreventionHandlers.add(handler);
  return () => unconsciousnessPreventionHandlers.delete(handler);
}

/**
 * Register a system-owned gate for damage which has completed mitigation and is
 * immediately about to reduce health. Interceptors receive per-application
 * health deltas and may annul whole applications before any health or limb
 * mutation is committed.
 */
export function registerFinalHealthDamageInterceptor(id = "", handler = null) {
  const key = String(id ?? "").trim();
  const apply = typeof handler === "function" ? handler : handler?.apply;
  const estimate = typeof handler === "object" ? handler?.estimate : null;
  const applies = typeof handler === "object" ? handler?.applies : null;
  if (!key || typeof apply !== "function") return () => undefined;
  const entry = {
    apply,
    estimate: typeof estimate === "function" ? estimate : null,
    applies: typeof applies === "function" ? applies : null
  };
  finalHealthDamageInterceptors.set(key, entry);
  return () => {
    if (finalHealthDamageInterceptors.get(key) === entry) finalHealthDamageInterceptors.delete(key);
  };
}

/**
 * Register system-owned post-damage work which must complete before the damage
 * workflow releases its bulk boundary and starts visual feedback. Public
 * DAMAGE_APPLIED_HOOK listeners remain observational because Foundry does not
 * await Promises returned by Hooks.callAll callbacks.
 */
export function registerDamageAppliedHandler(id = "", handler = null) {
  const key = String(id ?? "").trim();
  if (!key || typeof handler !== "function") return () => undefined;
  damageAppliedHandlers.set(key, handler);
  return () => {
    if (damageAppliedHandlers.get(key) === handler) damageAppliedHandlers.delete(key);
  };
}

export function registerDamageHubConfig() {
  CONFIG.ActiveEffect.expiryEvents[MANAGED_TIMED_DAMAGE_EXPIRY] = "FALLOUTMAW.Effects.ManagedTimedDamageExpiry";
  registerPeriodicHealingEffectHooks();
  registerConsciousnessHooks();
}

function registerPeriodicHealingEffectHooks() {
  if (periodicHealingEffectHooksRegistered) return;
  Hooks.on("preCreateActiveEffect", preparePeriodicHealingEffectCreate);
  Hooks.on("preUpdateActiveEffect", preparePeriodicHealingEffectUpdate);
  periodicHealingEffectHooksRegistered = true;
}

function preparePeriodicHealingEffectCreate(effect) {
  if (effect?.parent?.documentName !== "Actor") return;
  if (!getPeriodicHealingEffectChanges(effect).length) return;
  const update = {
    [`flags.${TRAUMA_FLAG_SCOPE}.${MANAGED_TIMED_DAMAGE_FLAG_KEY}`]: true
  };
  if (hasFiniteActiveEffectDuration(effect)) {
    update["duration.expiry"] = MANAGED_TIMED_DAMAGE_EXPIRY;
  }
  effect.updateSource(update);
}

function preparePeriodicHealingEffectUpdate(effect, changes = {}) {
  if (effect?.parent?.documentName !== "Actor") return;
  const flattenedChanges = foundry.utils.flattenObject(changes);
  const changesWereUpdated = Object.keys(flattenedChanges)
    .some(path => path === "system.changes" || path.startsWith("system.changes."));
  const prospectiveSource = changesWereUpdated ? effect.toObject() : null;
  if (prospectiveSource) {
    for (const [path, value] of Object.entries(flattenedChanges)) {
      if (path === "system.changes" || path.startsWith("system.changes.")) {
        foundry.utils.setProperty(prospectiveSource, path, value);
      }
    }
  }
  const replacement = prospectiveSource
    ? foundry.utils.getProperty(prospectiveSource, "system.changes")
    : null;
  const healingChanges = changesWereUpdated
    ? getPeriodicHealingEffectChanges({ system: { changes: replacement } })
    : getPeriodicHealingEffectChanges(effect);
  if (!healingChanges.some(change => isPeriodicHealingEffectKey(change?.key))) {
    if (
      changesWereUpdated
      && getPeriodicHealingEffectChanges(effect).length
      && !effect?.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY)
    ) {
      changes[`flags.${TRAUMA_FLAG_SCOPE}.-=${MANAGED_TIMED_DAMAGE_FLAG_KEY}`] = null;
      if (effect?.duration?.expiry === MANAGED_TIMED_DAMAGE_EXPIRY) changes["duration.expiry"] = null;
    }
    return;
  }

  changes[`flags.${TRAUMA_FLAG_SCOPE}.${MANAGED_TIMED_DAMAGE_FLAG_KEY}`] = true;
  if (hasFiniteActiveEffectDuration(effect, changes)) {
    changes["duration.expiry"] = MANAGED_TIMED_DAMAGE_EXPIRY;
  } else if (isActiveEffectDurationUpdated(changes) && effect?.duration?.expiry === MANAGED_TIMED_DAMAGE_EXPIRY) {
    changes["duration.expiry"] = null;
  }
}

function isActiveEffectDurationUpdated(changes = {}) {
  return Object.keys(foundry.utils.flattenObject(changes))
    .some(path => path === "duration.value" || path === "duration.units");
}

function hasFiniteActiveEffectDuration(effect, changes = {}) {
  const changedValue = changes["duration.value"]
    ?? foundry.utils.getProperty(changes, "duration.value");
  const sourceValue = changedValue !== undefined
    ? changedValue
    : effect?._source?.duration?.value;
  return typeof sourceValue === "number" && Number.isFinite(sourceValue);
}

export async function startConsciousnessStatusSynchronization() {
  consciousnessStatusSynchronizationReady = true;

  const actors = new Map();
  for (const actor of game.actors?.contents ?? []) {
    if (
      actor?.uuid
      && ["character", "construct"].includes(actor.type)
      && actorNeedsStartupVitalStatusSync(actor)
    ) actors.set(actor.uuid, actor);
  }
  // Off-scene synthetic Actors are intentionally not materialized here.
  // Their persisted state is maintained by document hooks and they are checked
  // when their Scene becomes active.
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (
      actor?.uuid
      && ["character", "construct"].includes(actor.type)
      && actorNeedsStartupVitalStatusSync(actor)
    ) actors.set(actor.uuid, actor);
  }

  const synchronized = [];
  for (const actor of actors.values()) {
    if (!canApplyDamageLocally(actor)) continue;
    await queueActorDamageStatusSync(actor);
    synchronized.push(actor);
  }
  return synchronized;
}

function actorNeedsStartupVitalStatusSync(actor) {
  const dead = isActorHealthDepleted(actor) || hasDestroyedCriticalLimb(actor);
  const consciousnessEnabled = isConsciousnessRulesEnabled(actor);
  const unconscious = consciousnessEnabled && !dead && isActorConsciousnessDepleted(actor);
  const hasDeadStatus = actor?.statuses?.has?.(STATUS_EFFECTS.dead) === true;
  const hasUnconsciousStatus = actor?.statuses?.has?.(STATUS_EFFECTS.unconscious) === true;
  if (dead !== hasDeadStatus || unconscious !== hasUnconsciousStatus) return true;
  if (dead || unconscious || hasDeadStatus || hasUnconsciousStatus) return true;
  return consciousnessEnabled
    && toInteger(actor.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY]?.recoveryTarget)
      !== toInteger(actor.system?.combat?.consciousnessRecoveryTarget);
}

export function registerDamageSocket() {
  registerDamageHubConfig();
  game.socket.on(DAMAGE_SOCKET, handleDamageSocketMessage);
  registerDamageTimeHooks();
}

export async function requestDamageApplication({
  actor = null,
  actorUuid = "",
  limbKey = "",
  amount = 0,
  damageTypeKey = "",
  mode = MODE_DAMAGE,
  scope = SCOPE_HEALTH_AND_LIMB,
  applyMitigation = true,
  processDamageTypeSettings = true,
  source = {}
} = {}) {
  const resolvedActor = actor ?? await fromUuid(actorUuid);
  if (!resolvedActor) return undefined;

  const request = normalizeDamageRequest({
    actorUuid: resolvedActor.uuid,
    limbKey,
    amount,
    damageTypeKey,
    mode,
    scope,
    applyMitigation,
    processDamageTypeSettings,
    source,
    requesterUserId: game.user?.id ?? ""
  });

  if (canApplyDamageLocally(resolvedActor)) return applyDamageApplication(request);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("No active GM is available to apply damage.");
    return undefined;
  }

  const results = await requestDamageCycleFromGM(gm, [request]);
  return results?.[0];
}

export async function requestDamageApplications(requests = []) {
  const normalizedRequests = [];
  const actors = new Map();
  for (const request of requests) {
    const resolvedActor = request.actor ?? await fromUuid(request.actorUuid ?? "");
    if (!resolvedActor) continue;
    actors.set(resolvedActor.uuid, resolvedActor);
    normalizedRequests.push(normalizeDamageRequest({
      ...request,
      actorUuid: resolvedActor.uuid,
      requesterUserId: game.user?.id ?? ""
    }));
  }
  if (!normalizedRequests.length) return [];

  if (Array.from(actors.values()).every(actor => canApplyDamageLocally(actor))) {
    return applyDamageCycle(normalizedRequests);
  }

  const gm = getResponsibleGM();
  if (gm) return requestDamageCycleFromGM(gm, normalizedRequests);

  ui.notifications.warn("No active GM is available to apply damage.");
  return applyDamageCycle(normalizedRequests.filter(request => canApplyDamageLocally(actors.get(request.actorUuid))));

}

async function requestDamageCycleFromGM(gm, requests = []) {
  return requestDamageSocketActionFromGM(gm, {
    action: "applyDamageCycle",
    requests
  }, {
    fallback: [],
    timeoutWarning: "No GM response was received for damage application."
  });
}

async function requestDamageSocketActionFromGM(gm, payload = {}, { fallback = [], timeoutWarning = "No GM response was received for damage hub action." } = {}) {
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingDamageSocketRequests.delete(requestId);
      reject(new Error("Damage hub socket request timed out."));
    }, DAMAGE_SOCKET_REQUEST_TIMEOUT_MS);
    pendingDamageSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(DAMAGE_SOCKET, {
    ...payload,
    gmUserId: gm.id,
    requesterUserId,
    requestId
  });

  try {
    return await promise;
  } catch (error) {
    console.error("Fallout MaW | Damage hub socket request failed", error);
    ui.notifications.warn(timeoutWarning);
    return fallback;
  }
}

export async function requestRegionPeriodicDamage({ token = null, actor = null, entries = [], source = {} } = {}) {
  const resolvedActor = actor ?? token?.actor ?? null;
  if (!resolvedActor) return [];

  const limbKey = selectRandomDamageLimbKey(resolvedActor);
  const damagePacketId = String(source?.damagePacketId ?? "").trim() || foundry.utils.randomID();
  const requests = (Array.isArray(entries) ? entries : [])
    .map(entry => ({
      actor: resolvedActor,
      limbKey,
      amount: evaluateActorFormula(entry?.amount, resolvedActor, {
        minimum: 0,
        context: "requested region periodic damage"
      }),
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      scope: SCOPE_HEALTH_AND_LIMB,
      source: { ...source, damagePacketId }
    }))
    .filter(request => request.amount > 0 && request.damageTypeKey);
  if (!requests.length) return [];

  await spendActorDodgeForAreaDamage(resolvedActor);
  return requestDamageApplications(requests);
}

/**
 * Submit every movement-triggered region hit through one normal damage-hub cycle.
 * Each threshold crossing remains a regular damage request so mitigation and damage-type behavior stay centralized.
 */
export async function requestRegionMovementDamageBatch(groups = []) {
  const requests = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const actor = group?.actor ?? await fromUuid(String(group?.actorUuid ?? ""));
    const triggerCount = Math.max(0, toInteger(group?.triggerCount));
    const entries = Array.isArray(group?.entries) ? group.entries : [];
    if (!actor || !triggerCount || !entries.length) continue;

    for (let triggerIndex = 0; triggerIndex < triggerCount; triggerIndex += 1) {
      const limbKey = selectRandomDamageLimbKey(actor);
      const sourcePacketId = String(group?.source?.damagePacketId ?? "").trim();
      const damagePacketId = sourcePacketId
        ? `${sourcePacketId}:${triggerIndex}`
        : foundry.utils.randomID();
      for (const entry of entries) {
        const amount = evaluateActorFormula(entry?.amount, actor, {
          minimum: 0,
          context: "region movement damage"
        });
        const damageTypeKey = String(entry?.damageTypeKey ?? "").trim();
        if (!damageTypeKey || amount <= 0) continue;
        requests.push({
          actor,
          limbKey,
          amount,
          damageTypeKey,
          scope: SCOPE_HEALTH_AND_LIMB,
          source: {
            ...(group?.source ?? {}),
            kind: "regionMovementDamage",
            damagePacketId,
            triggerIndex,
            triggerCount
          }
        });
      }
    }
  }
  if (!requests.length) return [];
  await spendDodgeForAreaDamageRequests(requests);
  return requestDamageApplications(requests);
}

export async function requestFirstAidEffect({
  actor = null,
  actorUuid = "",
  itemName = "",
  itemImg = "",
  healingPerTick = 0,
  durationSeconds = 0,
  intervalSeconds = ROUND_SECONDS,
  changes = [],
  withdrawal = null,
  source = {}
} = {}) {
  const resolvedActor = actor ?? await fromUuid(actorUuid);
  if (!resolvedActor) return [];

  const request = normalizeFirstAidEffectRequest({
    actorUuid: resolvedActor.uuid,
    itemName,
    itemImg,
    healingPerTick,
    durationSeconds,
    intervalSeconds,
    changes,
    withdrawal,
    source
  });

  if (canApplyDamageLocally(resolvedActor)) {
    return runDamageHubOperation(() => createFirstAidEffect(resolvedActor, request));
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("No active GM is available to create a first aid effect.");
    return [];
  }

  return requestDamageSocketActionFromGM(gm, {
    action: "createFirstAidEffect",
    request
  });
}

export async function requestFirstAidWithdrawalEffect({
  actor = null,
  actorUuid = "",
  itemName = "",
  itemImg = "",
  healingPerTick = 0,
  durationSeconds = 0,
  intervalSeconds = ROUND_SECONDS,
  changes = [],
  source = {}
} = {}) {
  const resolvedActor = actor ?? await fromUuid(actorUuid);
  if (!resolvedActor) return [];

  const request = normalizeFirstAidWithdrawalRequest({
    actorUuid: resolvedActor.uuid,
    itemName,
    itemImg,
    healingPerTick,
    durationSeconds,
    intervalSeconds,
    changes,
    source
  });
  if (!request.changes.length && request.healingPerTick <= 0) return [];

  if (canApplyDamageLocally(resolvedActor)) {
    return runDamageHubOperation(() => createFirstAidWithdrawalEffect(resolvedActor, request));
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("No active GM is available to create a first aid withdrawal effect.");
    return [];
  }

  return requestDamageSocketActionFromGM(gm, {
    action: "createFirstAidWithdrawalEffect",
    request
  });
}

export async function requestNeedChanges({
  actor = null,
  actorUuid = "",
  needs = [],
  context = {}
} = {}) {
  const resolvedActor = actor ?? await fromUuid(actorUuid);
  if (!resolvedActor) return [];

  const request = normalizeNeedChangesRequest({
    actorUuid: resolvedActor.uuid,
    needs,
    context
  });
  if (!request.needs.length) return [];

  if (canApplyDamageLocally(resolvedActor)) {
    return runDamageHubOperation(() => applyNeedChanges(resolvedActor, request.needs, {
      context: request.context
    }));
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("No active GM is available to apply need changes.");
    return [];
  }

  return requestDamageSocketActionFromGM(gm, {
    action: "applyNeedChanges",
    request
  });
}

export async function requestFirstAidNeedChanges(options = {}) {
  return requestNeedChanges(options);
}

export async function requestFirstAidRemoveEffects({
  actor = null,
  actorUuid = "",
  limbKeys = [],
  damageTypeKeys = []
} = {}) {
  const resolvedActor = actor ?? await fromUuid(actorUuid);
  if (!resolvedActor) return [];

  const request = normalizeFirstAidRemoveEffectsRequest({
    actorUuid: resolvedActor.uuid,
    limbKeys,
    damageTypeKeys
  });
  if (!request.limbKeys.length || !request.damageTypeKeys.length) return [];

  if (canApplyDamageLocally(resolvedActor)) {
    return runDamageHubOperation(() => applyFirstAidRemoveEffects(resolvedActor, request));
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("No active GM is available to remove first aid effects.");
    return [];
  }

  return requestDamageSocketActionFromGM(gm, {
    action: "applyFirstAidRemoveEffects",
    request
  });
}

async function applyDamageCycle(requests = []) {
  const operationRef = getDamageHubOperationRefFromRequests(requests);
  return runDamageHubOperation(async () => {
    const feedbackQueue = [];
    try {
      return await executeDamageSystemEventWorkflow(
        requests,
        (allowedRequests, scope) => applyDamageCycleNow(allowedRequests, {
          chainRef: scope?.chainRef ?? null,
          feedbackQueue
        }),
        { batch: true }
      );
    } finally {
      flushDamageFeedback(feedbackQueue);
    }
  }, { operationRef });
}

async function executeDamageSystemEventWorkflow(requests = [], operation, {
  single = false,
  batch = false
} = {}) {
  const normalized = (Array.isArray(requests) ? requests : [requests])
    .map((request, index) => ({
      ...normalizeDamageRequest(request),
      damageEventIndex: index
    }))
    .filter(request => request.actorUuid);
  if (!normalized.length) return single ? undefined : [];
  const inheritedChainRef = normalized.find(request => request.source?.chainRef)?.source?.chainRef ?? null;
  const operationId = String(
    normalized.find(request => request.source?.attackId)?.source?.attackId
    ?? normalized.find(request => request.source?.operationId)?.source?.operationId
    ?? foundry.utils.randomID()
  );

  return withSystemEventRoot({
    kind: "damageHub",
    operationId: `damage:${operationId}`,
    sceneUuid: getDamageRequestsSceneUuid(normalized),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: inheritedChainRef,
    data: { systemEventOperationId: operationId }
  }, async scope => {
    const allowed = [];
    const cancelled = [];
    const beforeSnapshots = new Map();
    let mechanicalRequestCount = 0;
    for (const [index, request] of normalized.entries()) {
      const actor = await fromUuid(request.actorUuid);
      if (isPhantomEntity(actor)) {
        allowed.push(request);
        beforeSnapshots.set(request, { skipEvents: true, index });
        continue;
      }
      mechanicalRequestCount += 1;
      const before = getDamageEventActorSnapshot(actor, request);
      const occurrenceBase = `damage:${scope.rootId}:${index}:${request.actorUuid}:${request.mode}`;
      const beforeKey = request.mode === MODE_HEALING
        ? "fallout-maw.healing.beforeApply"
        : "fallout-maw.damage.beforeApply";
      const gate = await scope.emit(beforeKey, {
        data: {
          ...serializeDamageEventRequest(request),
          inDamageHubOperation: true,
          damageHubOperationRef: getCurrentDamageHubOperationRef()
        },
        before
      }, {
        occurrenceKey: `${occurrenceBase}:before`,
        participants: getDamageEventParticipants(request, actor)
      });
      if (gate?.control?.current || gate?.control?.remaining || gate?.control?.root) {
        const result = createCancelledDamageResult(actor, request, gate.control);
        cancelled.push({ request, result, index, before, occurrenceBase });
        await emitDamageResolvedSystemEvent(scope, request, result, {
          index,
          before,
          occurrenceBase,
          cancelled: true
        });
        if (gate?.control?.remaining || gate?.control?.root) {
          for (let remainingIndex = index + 1; remainingIndex < normalized.length; remainingIndex += 1) {
            const skippedRequest = normalized[remainingIndex];
            const skippedActor = await fromUuid(skippedRequest.actorUuid);
            if (isPhantomEntity(skippedActor)) {
              allowed.push(skippedRequest);
              beforeSnapshots.set(skippedRequest, { skipEvents: true, index: remainingIndex });
              continue;
            }
            mechanicalRequestCount += 1;
            const skippedBefore = getDamageEventActorSnapshot(skippedActor, skippedRequest);
            const skippedBase = `damage:${scope.rootId}:${remainingIndex}:${skippedRequest.actorUuid}:${skippedRequest.mode}`;
            const skippedResult = createCancelledDamageResult(skippedActor, skippedRequest, gate.control);
            cancelled.push({
              request: skippedRequest,
              result: skippedResult,
              index: remainingIndex,
              before: skippedBefore,
              occurrenceBase: skippedBase
            });
            await emitDamageResolvedSystemEvent(scope, skippedRequest, skippedResult, {
              index: remainingIndex,
              before: skippedBefore,
              occurrenceBase: skippedBase,
              cancelled: true
            });
          }
          break;
        }
        continue;
      }
      allowed.push(request);
      beforeSnapshots.set(request, { before, index, occurrenceBase });
    }

    let operationResult;
    let operationError = null;
    try {
      operationResult = allowed.length ? await operation(allowed, scope) : (single ? undefined : []);
    } catch (error) {
      operationError = error;
    }

    const flatResults = flattenDamageEventResults(operationResult);
    const applicationBreakdownIndexes = new WeakMap();
    for (const request of allowed) {
      const metadata = beforeSnapshots.get(request);
      if (metadata?.skipEvents) continue;
      const result = findDamageEventResult(request, flatResults) ?? createFailedDamageResult(request, operationError);
      const applications = result?.damageApplications;
      let applicationBreakdownIndex = null;
      if (Array.isArray(applications)) {
        applicationBreakdownIndex = applicationBreakdownIndexes.get(applications);
        if (!applicationBreakdownIndex) {
          applicationBreakdownIndex = buildDamageApplicationBreakdownIndex(applications);
          applicationBreakdownIndexes.set(applications, applicationBreakdownIndex);
        }
      }
      await emitDamageResolvedSystemEvent(scope, request, result, {
        ...metadata,
        applicationBreakdownIndex
      });
    }

    if (mechanicalRequestCount > 0 && (batch || mechanicalRequestCount > 1)) {
      await scope.emit("fallout-maw.damage.batch.resolved", {
        data: {
          requestCount: mechanicalRequestCount,
          appliedCount: allowed.filter(request => !beforeSnapshots.get(request)?.skipEvents).length,
          cancelledCount: cancelled.length,
          inDamageHubOperation: true,
          damageHubOperationRef: getCurrentDamageHubOperationRef()
        },
        outcome: {
          success: !operationError,
          cancelled: cancelled.length > 0,
          resultCount: flatResults.length
        },
        reason: operationError ? "error" : (cancelled.length ? "cancelled" : "resolved")
      }, {
        occurrenceKey: `damage:${scope.rootId}:batch:resolved`,
        participants: { source: null, target: null, related: [] }
      });
    }

    if (operationError) throw operationError;
    if (single) return operationResult ?? cancelled[0]?.result;
    const cancelledResults = cancelled.map(entry => entry.result);
    return Array.isArray(operationResult)
      ? [...operationResult, ...cancelledResults]
      : operationResult === undefined ? cancelledResults : [operationResult, ...cancelledResults];
  });
}

async function emitDamageResolvedSystemEvent(scope, request, result = {}, {
  index = 0,
  before = null,
  occurrenceBase = `damage:${scope?.rootId}:${index}`,
  cancelled = false,
  applicationBreakdownIndex = null
} = {}) {
  const actor = result?.actor ?? await fromUuid(request.actorUuid);
  const after = getDamageEventActorSnapshot(actor, request);
  const barrierResult = getDamageRequestBarrierResult(result, index, applicationBreakdownIndex);
  const serializedResult = serializeDamageEventResult({
    ...result,
    ...barrierResult
  });
  const resolvedKey = request.mode === MODE_HEALING
    ? "fallout-maw.healing.resolved"
    : "fallout-maw.damage.resolved";
  const eventDelta = barrierResult.hasApplicationBreakdown
    ? {
      health: -Math.max(0, Number(barrierResult.actualHealthDelta) || 0),
      limb: -Math.max(0, Number(barrierResult.actualLimbDelta) || 0)
    }
    : getDamageEventDelta(before, after);
  const emitted = await scope.emit(resolvedKey, {
    data: {
      ...serializeDamageEventRequest(request),
      result: serializedResult,
      inDamageHubOperation: true,
      damageHubOperationRef: getCurrentDamageHubOperationRef()
    },
    before,
    after,
    delta: eventDelta,
    outcome: {
      success: !result?.failed && !cancelled,
      cancelled: Boolean(cancelled || result?.cancelled),
      lethalDamagePrevented: Boolean(result?.lethalDamagePrevented)
    },
    reason: String(result?.reason ?? (cancelled ? "cancelled" : "resolved"))
  }, {
    occurrenceKey: `${occurrenceBase}:resolved`,
    participants: getDamageEventParticipants(request, actor)
  });
  if (request.mode === MODE_DAMAGE && serializedResult.barrierAbsorbed > 0) {
    const payload = {
      data: {
        ...serializeDamageEventRequest(request),
        result: serializedResult,
        barriers: barrierResult.depleted,
        inDamageHubOperation: true,
        damageHubOperationRef: getCurrentDamageHubOperationRef()
      },
      before,
      after,
      delta: eventDelta,
      outcome: {
        success: true,
        depleted: barrierResult.depleted.length > 0
      },
      reason: barrierResult.depleted.length ? "depleted" : "absorbed"
    };
    const participants = getDamageEventParticipants(request, actor);
    await scope.emit("fallout-maw.damage.barrier.absorbed", payload, {
      occurrenceKey: `${occurrenceBase}:barrier:absorbed`,
      participants
    });
    if (barrierResult.depleted.length) {
      await scope.emit("fallout-maw.damage.barrier.depleted", payload, {
        occurrenceKey: `${occurrenceBase}:barrier:depleted`,
        participants
      });
    }
  }
  return emitted;
}

function serializeDamageEventRequest(request = {}) {
  return {
    actorUuid: String(request.actorUuid ?? ""),
    limbKey: String(request.limbKey ?? ""),
    itemId: String(request.itemId ?? ""),
    amount: Math.max(0, Number(request.amount) || 0),
    damageTypeKey: String(request.damageTypeKey ?? ""),
    mode: String(request.mode ?? MODE_DAMAGE),
    scope: String(request.scope ?? ""),
    applyMitigation: request.applyMitigation !== false,
    processDamageTypeSettings: request.processDamageTypeSettings !== false,
    bypassBarrier: request.bypassBarrier === true,
    source: serializeDamageEventSource(request.source)
  };
}

function serializeDamageEventSource(source = {}) {
  if (!source || typeof source !== "object") return {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (["string", "boolean"].includes(typeof value) || (typeof value === "number" && Number.isFinite(value))) {
      result[key] = value;
    }
  }
  return result;
}

function serializeDamageEventResult(result = {}) {
  return {
    actorUuid: String(result?.actor?.uuid ?? result?.actorUuid ?? ""),
    amount: Math.max(0, Number(result?.amount) || 0),
    incomingAmount: Math.max(0, Number(result?.incomingAmount) || 0),
    amountBeforeResistance: Math.max(0, Number(result?.amountBeforeResistance) || 0),
    potentialAmount: Math.max(0, Number(result?.potentialAmount) || 0),
    preBarrierAmount: Math.max(0, Number(result?.preBarrierAmount) || 0),
    barrierAbsorbed: Math.max(0, Number(result?.barrierAbsorbed) || 0),
    amountAfterBarrier: Math.max(0, Number(result?.amountAfterBarrier ?? result?.amount) || 0),
    barrierDepletedCount: Array.isArray(result?.barrierDepleted) ? result.barrierDepleted.length : 0,
    mitigationBlocked: Math.max(0, Number(result?.mitigationBlocked) || 0),
    preventedAmount: Math.max(0, Number(result?.preventedAmount) || 0),
    healthDelta: Number(result?.healthDelta) || 0,
    resourceHealthDelta: Number(result?.resourceHealthDelta) || 0,
    limbDelta: Number(result?.limbDelta) || 0,
    itemConditionDelta: Number(result?.itemConditionDelta) || 0,
    mode: String(result?.mode ?? ""),
    scope: String(result?.scope ?? ""),
    limbKey: String(result?.limbKey ?? ""),
    damageTypeKey: String(result?.damageTypeKey ?? ""),
    cancelled: Boolean(result?.cancelled),
    failed: Boolean(result?.failed)
  };
}

function getDamageRequestBarrierResult(result = {}, eventIndex = 0, applicationBreakdownIndex = null) {
  const hasApplicationBreakdown = Array.isArray(result?.damageApplications);
  const application = hasApplicationBreakdown
    ? getDamageEventIndexEntry(
      applicationBreakdownIndex ?? buildDamageApplicationBreakdownIndex(result.damageApplications),
      eventIndex
    )
    : null;
  if (!application) {
    if (hasApplicationBreakdown) {
      return {
        incomingAmount: 0,
        amountBeforeResistance: 0,
        mitigationBlocked: 0,
        preBarrierAmount: 0,
        barrierAbsorbed: 0,
        amountAfterBarrier: 0,
        actualHealthDelta: 0,
        actualLimbDelta: 0,
        healthDelta: 0,
        limbDelta: 0,
        hasApplicationBreakdown: true,
        depleted: [],
        barrierDepleted: []
      };
    }
    return {
      incomingAmount: Math.max(0, Number(result?.incomingAmount) || 0),
      amountBeforeResistance: Math.max(0, Number(result?.amountBeforeResistance) || 0),
      mitigationBlocked: Math.max(0, Number(result?.mitigationBlocked) || 0),
      preBarrierAmount: Math.max(0, Number(result?.preBarrierAmount) || 0),
      barrierAbsorbed: Math.max(0, Number(result?.barrierAbsorbed) || 0),
      amountAfterBarrier: Math.max(0, Number(result?.amountAfterBarrier ?? result?.amount) || 0),
      actualHealthDelta: Math.max(0, Number(result?.healthDelta) || 0),
      actualLimbDelta: Math.max(0, Number(result?.limbDelta) || 0),
      hasApplicationBreakdown: false,
      depleted: Array.isArray(result?.barrierDepleted) ? result.barrierDepleted : [],
      barrierDepleted: Array.isArray(result?.barrierDepleted) ? result.barrierDepleted : []
    };
  }
  const depleted = application.depleted;
  return {
    incomingAmount: Math.max(0, Number(application.incomingAmount) || 0),
    amountBeforeResistance: Math.max(0, Number(application.amountBeforeResistance) || 0),
    mitigationBlocked: Math.max(0, Number(application.mitigationBlocked) || 0),
    preBarrierAmount: application.preBarrierAmount,
    barrierAbsorbed: application.barrierAbsorbed,
    amountAfterBarrier: application.amountAfterBarrier,
    actualHealthDelta: application.actualHealthDelta,
    actualLimbDelta: application.actualLimbDelta,
    healthDelta: application.actualHealthDelta,
    limbDelta: application.actualLimbDelta,
    hasApplicationBreakdown: true,
    depleted,
    barrierDepleted: depleted
  };
}

function getDamageEventActorSnapshot(actor, request = {}) {
  if (!actor) return null;
  const limb = request.limbKey ? actor.system?.limbs?.[request.limbKey] : null;
  return {
    health: getCurrentActorHealthValue(actor),
    limb: limb ? {
      key: request.limbKey,
      value: Number(limb.value) || 0,
      missing: Boolean(limb.missing)
    } : null
  };
}

function getDamageEventDelta(before, after) {
  if (!before || !after) return null;
  return {
    health: (Number(after.health) || 0) - (Number(before.health) || 0),
    limb: before.limb && after.limb
      ? (Number(after.limb.value) || 0) - (Number(before.limb.value) || 0)
      : 0
  };
}

function getDamageEventParticipants(request = {}, actor = null) {
  const source = request.source ?? {};
  return {
    source: normalizeDamageParticipant({
      actorUuid: source.attackerActorUuid ?? source.sourceActorUuid ?? source.actorUuid,
      tokenUuid: source.attackerTokenUuid ?? source.sourceTokenUuid ?? source.tokenUuid,
      itemUuid: source.sourceItemUuid ?? source.weaponUuid ?? source.itemUuid
    }),
    target: normalizeDamageParticipant({
      actorUuid: actor?.uuid ?? request.actorUuid,
      tokenUuid: source.targetTokenUuid,
      itemUuid: request.itemId ? `${actor?.uuid ?? request.actorUuid}.Item.${request.itemId}` : ""
    }),
    related: []
  };
}

function normalizeDamageParticipant(participant = {}) {
  const result = {
    actorUuid: String(participant.actorUuid ?? ""),
    tokenUuid: String(participant.tokenUuid ?? ""),
    itemUuid: String(participant.itemUuid ?? "")
  };
  return Object.values(result).some(Boolean) ? result : null;
}

function createCancelledDamageResult(actor, request, control = {}) {
  return {
    actor,
    actorUuid: String(actor?.uuid ?? request.actorUuid),
    amount: 0,
    potentialAmount: request.amount,
    healthDelta: 0,
    limbDelta: 0,
    mode: request.mode,
    scope: request.scope,
    limbKey: request.limbKey,
    damageTypeKey: request.damageTypeKey,
    cancelled: true,
    reason: String(control?.reasons?.at?.(-1)?.reason ?? "eventReaction")
  };
}

function createFailedDamageResult(request, error) {
  return {
    actorUuid: request.actorUuid,
    amount: 0,
    potentialAmount: request.amount,
    healthDelta: 0,
    limbDelta: 0,
    mode: request.mode,
    scope: request.scope,
    limbKey: request.limbKey,
    damageTypeKey: request.damageTypeKey,
    failed: Boolean(error),
    reason: error ? "error" : "noResult"
  };
}

function flattenDamageEventResults(result) {
  return (Array.isArray(result) ? result.flat(Infinity) : [result]).filter(Boolean);
}

function findDamageEventResult(request, results = []) {
  return results.find(result => (
    String(result?.actor?.uuid ?? result?.actorUuid ?? "") === request.actorUuid
    && String(result?.mode ?? request.mode) === request.mode
  )) ?? null;
}

function getDamageRequestsSceneUuid(requests = []) {
  for (const request of requests) {
    const source = request?.source ?? {};
    const tokenUuid = String(source.targetTokenUuid ?? source.attackerTokenUuid ?? source.sourceTokenUuid ?? "");
    const match = tokenUuid.match(/^(Scene\.[^.]+)/);
    if (match) return match[1];
  }
  return String(canvas?.scene?.uuid ?? "");
}

async function applyDamageCycleNow(requests = [], { chainRef = null, feedbackQueue = null } = {}) {
  const grouped = new Map();
  for (const request of requests) {
    const data = normalizeDamageRequest(request);
    if (!data.actorUuid) continue;
    const actorRequests = grouped.get(data.actorUuid) ?? [];
    actorRequests.push(data);
    grouped.set(data.actorUuid, actorRequests);
  }
  if (!grouped.size) return [];

  const ownsFeedbackQueue = !Array.isArray(feedbackQueue);
  const pendingFeedback = ownsFeedbackQueue ? [] : feedbackQueue;
  beginBulkOperation();

  const results = [];
  const deferredShockChecks = [];
  try {
    for (const [actorUuid, actorRequests] of grouped) {
      const actor = await fromUuid(actorUuid);
      if (!actor || (!game.user?.isGM && !actor.isOwner)) continue;
      const applyActorRequests = () => applyDamageApplicationsNow({ actorUuid, requests: actorRequests }, {
        createSummary: false,
        deferredShockChecks,
        feedbackQueue: pendingFeedback
      });
      // Phantom damage is a terminal marker and never mutates Actor state, so
      // it does not need to occupy the per-Actor mutation queue.
      const actorResults = isPhantomEntity(actor)
        ? await applyActorRequests()
        : await queueActorDamageMutation(actorUuid, applyActorRequests);
      if (Array.isArray(actorResults)) results.push(...actorResults);
    }

    await resolveDeferredShockChecks(deferredShockChecks, {
      chainRef,
      damageHubOperationRef: getCurrentDamageHubOperationRef()
    });
    await publishDamageSummaryMessage(results);
    await notifyDamageApplied(results);
  } finally {
    try {
      await endBulkOperation();
    } finally {
      if (ownsFeedbackQueue) flushDamageFeedback(pendingFeedback);
    }
  }
  return results;
}

function stampDamageRequestsLogicalWorldTime(requests = [], logicalWorldTime) {
  const lt = Number(logicalWorldTime);
  if (!Number.isFinite(lt) || lt <= 0) return requests;
  return requests.map(request => {
    const src = request?.source && typeof request.source === "object"
      ? { ...request.source }
      : {};
    if (!Number.isFinite(Number(src.worldTime))) src.worldTime = lt;
    return { ...request, source: src };
  });
}

export async function applyDamageRequestsInCurrentHubOperation(requests = [], logicalWorldTime = null) {
  const stamped = Number.isFinite(Number(logicalWorldTime))
    ? stampDamageRequestsLogicalWorldTime(requests, Number(logicalWorldTime))
    : requests;
  const feedbackQueue = [];
  try {
    return await executeDamageSystemEventWorkflow(
      stamped,
      (allowedRequests, scope) => applyDamageCycleNow(allowedRequests, {
        chainRef: scope?.chainRef ?? null,
        feedbackQueue
      }),
      { batch: true }
    );
  } finally {
    flushDamageFeedback(feedbackQueue);
  }
}

function serializeDamageCycleSocketResults(results = []) {
  return results.flat(Infinity).filter(Boolean).map(result => {
    const phantomDestroyed = result.phantomDestroyed === true;
    return {
      actorUuid: String(result.actor?.uuid ?? result.actorUuid ?? ""),
      amount: roundDamageAmount(result.amount),
      incomingAmount: roundDamageAmount(result.incomingAmount),
      amountBeforeResistance: roundDamageAmount(result.amountBeforeResistance),
      delayedAmount: roundDamageAmount(result.delayedAmount),
      preBarrierAmount: roundDamageAmount(result.preBarrierAmount),
      barrierAbsorbed: roundDamageAmount(result.barrierAbsorbed),
      amountAfterBarrier: roundDamageAmount(result.amountAfterBarrier ?? result.amount),
      barrierDepletedCount: Array.isArray(result.barrierDepleted) ? result.barrierDepleted.length : 0,
      mitigationBlocked: roundDamageAmount(result.mitigationBlocked),
      healthDelta: roundDamageAmount(result.healthDelta),
      resourceHealthDelta: roundDamageAmount(result.resourceHealthDelta),
      limbDelta: roundDamageAmount(result.limbDelta),
      mode: result.mode ?? MODE_DAMAGE,
      scope: result.scope ?? "",
      limbKey: result.limbKey ?? "",
      damageTypeKey: result.damageTypeKey ?? "",
      ...(phantomDestroyed ? {
        phantomDestroyed: true,
        source: {
          attackId: String(result.source?.attackId ?? ""),
          attackerActorUuid: String(result.source?.attackerActorUuid ?? result.source?.attackerUuid ?? ""),
          targetTokenUuid: String(result.source?.targetTokenUuid ?? ""),
          weaponAttackDamage: result.source?.weaponAttackDamage === true
        }
      } : {})
    };
  });
}

function serializeEmbeddedDocumentSocketResults(documents = []) {
  return (Array.isArray(documents) ? documents : [documents])
    .filter(Boolean)
    .map(document => ({
      uuid: String(document.uuid ?? ""),
      id: String(document.id ?? ""),
      name: String(document.name ?? "")
    }));
}

function respondDamageHubSocketAction(payload = {}, { ok = true, error = "", result = [] } = {}) {
  if (!payload.requestId || !payload.requesterUserId) return;
  game.socket.emit(DAMAGE_SOCKET, {
    action: "damageHubActionResult",
    targetUserId: payload.requesterUserId,
    requestId: payload.requestId,
    ok,
    error,
    result
  });
}

export async function applyDamageApplication(request = {}, options = {}) {
  const data = normalizeDamageRequest(request);
  if (!data.actorUuid) return undefined;
  const operationRef = getDamageHubOperationRefFromRequests([data]);
  return runDamageHubOperation(async () => {
    const feedbackQueue = [];
    try {
      return await executeDamageSystemEventWorkflow(
        [data],
        async (allowedRequests, scope) => {
          const allowed = allowedRequests[0];
          if (!allowed) return undefined;
          const operation = () => applyDamageApplicationNow(allowed, {
            ...options,
            chainRef: scope?.chainRef ?? null,
            feedbackQueue
          });
          return isPhantomEntity(fromUuidSync(allowed.actorUuid))
            ? operation()
            : queueActorDamageMutation(allowed.actorUuid, operation);
        },
        { single: true }
      );
    } finally {
      flushDamageFeedback(feedbackQueue);
    }
  }, { operationRef });
}

/**
 * Join an externally-owned healing mutation to the damage-hub lifecycle.
 *
 * Medicine and similar transactional subsystems already own their document
 * batch, so routing them through applyDamageApplication would calculate and
 * write the healing a second time. This adapter supplies the normal awaited
 * healing gates, actor serialization and terminal event while leaving the
 * actual mutation to the caller.
 */
export async function runExternalHealingSystemEventWorkflow(request = {}, operation) {
  if (typeof operation !== "function") {
    throw new TypeError("An external healing operation is required.");
  }

  const data = normalizeDamageRequest({
    ...request,
    mode: MODE_HEALING,
    scope: request.scope ?? (request.limbKey ? SCOPE_LIMB : SCOPE_HEALTH),
    applyMitigation: false,
    processDamageTypeSettings: false,
    bypassBarrier: true
  });
  if (!data.actorUuid || data.amount <= 0) return undefined;

  const operationRef = getDamageHubOperationRefFromRequests([data]);
  return runDamageHubOperation(() => executeDamageSystemEventWorkflow(
    [data],
    async (allowedRequests, scope) => {
      const allowed = allowedRequests[0];
      if (!allowed) return undefined;
      return queueActorDamageMutation(allowed.actorUuid, async freshActor => {
        if (!freshActor || (!game.user?.isGM && !freshActor.isOwner)) {
          return createFailedExternalHealingResult(freshActor, allowed, "healing-authority-unavailable");
        }
        if (isHealingBlocked(freshActor)) {
          await queueActorDamageStatusSync(freshActor);
          return createFailedExternalHealingResult(freshActor, allowed, "healing-blocked");
        }

        const result = await operation({
          actor: freshActor,
          request: allowed,
          scope,
          chainRef: scope?.chainRef ?? null
        });
        return normalizeExternalHealingResult(result, freshActor, allowed);
      });
    },
    { single: true }
  ), { operationRef });
}

function normalizeExternalHealingResult(result, actor, request) {
  if (!result || typeof result !== "object") {
    return createFailedExternalHealingResult(actor, request, "healing-not-committed");
  }
  return {
    ...result,
    actor: result.actor ?? actor,
    amount: Math.max(0, Number(result.amount ?? request.amount) || 0),
    healthDelta: Math.max(0, Number(result.healthDelta) || 0),
    limbDelta: Math.max(0, Number(result.limbDelta) || 0),
    mode: MODE_HEALING,
    scope: normalizeScope(result.scope ?? request.scope, result.limbKey ?? request.limbKey),
    limbKey: String(result.limbKey ?? request.limbKey ?? ""),
    damageTypeKey: HEALING_DAMAGE_TYPE_KEY
  };
}

function createFailedExternalHealingResult(actor, request = {}, reason = "healing-failed") {
  return {
    actor,
    amount: 0,
    healthDelta: 0,
    limbDelta: 0,
    mode: MODE_HEALING,
    scope: normalizeScope(request.scope, request.limbKey),
    limbKey: String(request.limbKey ?? ""),
    damageTypeKey: HEALING_DAMAGE_TYPE_KEY,
    failed: true,
    reason
  };
}

function createPhantomDamageResult(actor, data, scope = normalizeScope(data?.scope, data?.limbKey)) {
  const amount = roundDamageAmount(data?.amount);
  return {
    actor,
    actorUuid: String(actor?.uuid ?? data?.actorUuid ?? ""),
    amount,
    potentialAmount: amount,
    preBarrierAmount: amount,
    barrierAbsorbed: 0,
    amountAfterBarrier: amount,
    mitigationBlocked: 0,
    healthDelta: 0,
    resourceHealthDelta: 0,
    limbDelta: 0,
    mode: MODE_DAMAGE,
    scope,
    limbKey: String(data?.limbKey ?? ""),
    damageTypeKey: String(data?.damageTypeKey ?? ""),
    source: data?.source ?? {},
    phantomDestroyed: amount > 0
  };
}

async function finishPhantomDamageApplications(results = [], { createSummary = true } = {}) {
  const applied = results.filter(result => result?.phantomDestroyed === true);
  if (createSummary && applied.length) {
    await publishDamageSummaryMessage(applied);
    await notifyDamageApplied(applied);
  }
  return applied;
}

async function applyDamageApplicationNow(request = {}, {
  createSummary = true,
  damageBarrierLedger: suppliedDamageBarrierLedger = null,
  damageBarrierCommit: suppliedDamageBarrierCommit = null,
  feedbackQueue = null
} = {}) {
  const data = normalizeDamageRequest(request);
  const actor = await fromUuid(data.actorUuid);
  if (!actor) return undefined;
  if (!game.user?.isGM && !actor.isOwner) return undefined;

  const mode = data.mode === MODE_HEALING ? MODE_HEALING : MODE_DAMAGE;
  const scope = normalizeScope(data.scope, data.limbKey);
  if (mode === MODE_DAMAGE && scope === SCOPE_ITEM_CONDITION) {
    return applyItemConditionDamageApplicationNow(actor, { ...data, scope }, { createSummary });
  }
  if (isPhantomEntity(actor)) {
    if (mode !== MODE_DAMAGE) {
      return { actor, amount: 0, healthDelta: 0, resourceHealthDelta: 0, limbDelta: 0, mode, scope };
    }
    const [result] = await finishPhantomDamageApplications([
      createPhantomDamageResult(actor, data, scope)
    ], { createSummary });
    return result ?? createPhantomDamageResult(actor, data, scope);
  }
  if (mode === MODE_HEALING && isHealingBlocked(actor)) {
    await queueActorDamageStatusSync(actor);
    return { actor, amount: 0, healthDelta: 0, limbDelta: 0, mode, scope, limbKey: data.limbKey };
  }

  const ownsDamageBarrierLedger = mode === MODE_DAMAGE && !suppliedDamageBarrierLedger;
  const damageBarrierLedger = suppliedDamageBarrierLedger
    ?? (mode === MODE_DAMAGE ? createActorDamageBarrierLedger(actor) : null);
  let damageBarrierCommitted = false;
  const commitOwnedDamageBarrier = async () => {
    if (typeof suppliedDamageBarrierCommit === "function") {
      await suppliedDamageBarrierCommit();
      return;
    }
    if (!ownsDamageBarrierLedger || !damageBarrierLedger || damageBarrierCommitted) return;
    await commitDamageBarrierLedger(actor, damageBarrierLedger);
    damageBarrierCommitted = true;
  };
  const ownsFeedbackQueue = !Array.isArray(feedbackQueue);
  const pendingFeedback = ownsFeedbackQueue ? [] : feedbackQueue;
  let mitigationDisplay = null;
  let damageNumberEntries = [];
  try {
  const requestedAmount = mode === MODE_HEALING
    ? applyHealingModifierPercent(data.amount, getActorHealingModifierPercent(actor, "incoming", {
      chanceOperationId: getActiveUseOperationId(data?.source, getCurrentDamageHubOperationRef())
    }))
    : data.amount;
  const runtimeSettings = getPreparedRuntimeSettings();
  const damageType = runtimeSettings.damageTypeSettings.find(entry => entry.key === data.damageTypeKey);
  const periodic = damageType?.settings?.periodic;
  if (shouldSplitPeriodicDamage(data, mode, periodic) && !isLimbTimedDamageBlocked(actor, data.limbKey, damageType, "periodic")) {
    return applyPeriodicSplitDamageApplicationNow(actor, { ...data, amount: requestedAmount }, {
      createSummary,
      damageType,
      periodic,
      scope,
      damageBarrierLedger,
      damageBarrierCommit: commitOwnedDamageBarrier,
      feedbackQueue: pendingFeedback
    });
  }

  const mitigationResult = mode === MODE_DAMAGE && data.applyMitigation
    ? calculateDamageMitigation(actor, requestedAmount, damageType?.key ?? "", data.limbKey, data.source, {
      damageType,
      damageMitigationCalculation: runtimeSettings.rulesProfile.damageMitigationCalculation,
      itemOnlyMitigation: hasInstalledProsthesis(actor, data.limbKey),
      includeEquipmentConditionDamage: data.processDamageTypeSettings,
      includeResistanceOverheat: data.processDamageTypeSettings
    })
    : { amount: requestedAmount, amountBeforeResistance: requestedAmount, display: null };
  const mitigatedAmount = mitigationResult.amount;
  const amountBeforeResistance = mode === MODE_DAMAGE
    ? Math.max(0, Number(mitigationResult.amountBeforeResistance) || 0)
    : 0;
  const effectiveAmountBeforeBarrier = mode === MODE_DAMAGE && data.processDamageTypeSettings
    ? hasInstalledProsthesis(actor, data.limbKey) || isIndependentHealthModelActive(actor)
      ? mitigatedAmount
      : applyLimbDamageMultiplier(actor, mitigatedAmount, data.limbKey)
    : mitigatedAmount;
  mitigationDisplay = mode === MODE_DAMAGE && data.applyMitigation
    ? buildDamageMitigationDisplay(data.amount, mitigatedAmount)
    : null;
  const mitigationBlocked = Math.max(0, roundDamageAmount(mitigationDisplay?.blocked));
  if (effectiveAmountBeforeBarrier <= 0) {
    if (mode === MODE_DAMAGE && data.applyMitigation && data.processDamageTypeSettings) {
      await applyEquipmentConditionDamage(actor, mitigationResult.equipmentConditionDamage);
      await applyResistanceOverheats(actor, [mitigationResult.resistanceOverheat]);
    }
    const result = {
      actor,
      amount: 0,
      incomingAmount: mode === MODE_DAMAGE ? requestedAmount : 0,
      amountBeforeResistance,
      mitigationBlocked,
      healthDelta: 0,
      limbDelta: 0,
      mode,
      scope,
      limbKey: data.limbKey,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      source: data.source
    };
    if (createSummary && mode === MODE_DAMAGE && requestedAmount > 0) {
      await publishDamageSummaryMessage([result]);
      await notifyDamageApplied([result]);
    }
    return result;
  }

  const barrierApplication = mode === MODE_DAMAGE
    ? absorbDamageWithBarrier(damageBarrierLedger, {
      amount: effectiveAmountBeforeBarrier,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      bypassBarrier: data.bypassBarrier
    })
    : {
      incoming: effectiveAmountBeforeBarrier,
      absorbed: 0,
      remaining: effectiveAmountBeforeBarrier,
      depleted: []
    };
  const effectiveAmount = barrierApplication.remaining;
  await commitOwnedDamageBarrier();
  if (effectiveAmount <= 0) {
    if (mode === MODE_DAMAGE && data.applyMitigation && data.processDamageTypeSettings) {
      await applyEquipmentConditionDamage(actor, mitigationResult.equipmentConditionDamage);
      await applyResistanceOverheats(actor, [mitigationResult.resistanceOverheat]);
    }
    const result = {
      actor,
      amount: 0,
      incomingAmount: mode === MODE_DAMAGE ? requestedAmount : 0,
      amountBeforeResistance,
      potentialAmount: effectiveAmountBeforeBarrier,
      preBarrierAmount: effectiveAmountBeforeBarrier,
      barrierAbsorbed: barrierApplication.absorbed,
      amountAfterBarrier: 0,
      barrierDepleted: barrierApplication.depleted,
      mitigationBlocked,
      healthDelta: 0,
      limbDelta: 0,
      mode,
      scope,
      limbKey: data.limbKey,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      source: data.source
    };
    if (createSummary) {
      await publishDamageSummaryMessage([result]);
      await notifyDamageApplied([result]);
    }
    return result;
  }

  const needIncrease = damageType?.settings?.needIncrease;
  const applyPreHealthDamageTypeSettings = async () => {
    if (mode === MODE_DAMAGE && data.applyMitigation && data.processDamageTypeSettings) {
      await applyEquipmentConditionDamage(actor, mitigationResult.equipmentConditionDamage);
      await applyResistanceOverheats(actor, [mitigationResult.resistanceOverheat]);
    }
    if (mode === MODE_DAMAGE && data.processDamageTypeSettings && needIncrease?.enabled) {
      await applyNeedIncrease(actor, { amount: effectiveAmount, settings: needIncrease });
    }
  };

  if (mode === MODE_DAMAGE && data.processDamageTypeSettings && needIncrease?.enabled && needIncrease.preventHealthDamage) {
    await applyPreHealthDamageTypeSettings();
      const result = {
        actor,
        amount: 0,
        incomingAmount: requestedAmount,
        amountBeforeResistance,
        potentialAmount: effectiveAmountBeforeBarrier,
        preBarrierAmount: effectiveAmountBeforeBarrier,
        barrierAbsorbed: barrierApplication.absorbed,
        amountAfterBarrier: 0,
        barrierDepleted: barrierApplication.depleted,
        mitigationBlocked,
        healthDelta: 0,
        limbDelta: 0,
        mode,
        scope,
        limbKey: data.limbKey,
        damageTypeKey: damageType?.key ?? data.damageTypeKey,
        source: data.source
      };
      if (createSummary) {
        await publishDamageSummaryMessage([result]);
        await notifyDamageApplied([result]);
      }
      return result;
  }

  const finalRequest = {
    ...data,
    amount: effectiveAmount,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    damageType,
    scope
  };
  const estimate = mode === MODE_DAMAGE
    ? estimateDirectDamageApplication(actor, finalRequest, damageType)
    : null;
  if (estimate?.healthDelta > 0) {
    const finalApplication = {
      packetId: String(data.source?.damagePacketId ?? data.source?.conditionWearPacketId ?? "single"),
      request: finalRequest,
      requests: [finalRequest],
      healthDamage: calculateFinalHealthDamageInterceptionAmount([finalRequest], estimate.healthDelta),
      estimate
    };
    const interception = await applyFinalHealthDamageInterceptors(actor, [finalApplication], {
      source: data.source,
      worldTime: getDamageApplicationWorldTime(data.source)
    });
    if (!interception.applications.includes(finalApplication)) {
      await applyPreHealthDamageTypeSettings();
      const result = {
        actor,
        amount: 0,
        incomingAmount: requestedAmount,
        amountBeforeResistance,
        potentialAmount: effectiveAmountBeforeBarrier,
        preBarrierAmount: effectiveAmountBeforeBarrier,
        barrierAbsorbed: barrierApplication.absorbed,
        amountAfterBarrier: effectiveAmount,
        barrierDepleted: barrierApplication.depleted,
        mitigationBlocked,
        preventedAmount: interception.preventedHealthDamage,
        finalHealthDamagePrevented: interception.preventedHealthDamage,
        finalHealthDamagePreventions: interception.preventions,
        healthDelta: 0,
        limbDelta: 0,
        mode,
        scope,
        limbKey: data.limbKey,
        damageTypeKey: damageType?.key ?? data.damageTypeKey,
        source: data.source
      };
      if (createSummary) {
        await publishDamageSummaryMessage([result]);
        await notifyDamageApplied([result]);
      }
      return result;
    }
  }

  if (mode === MODE_DAMAGE) {
    const prevented = await preventLethalDamageIfApplicable(actor, estimate, {
      amount: effectiveAmount,
      source: data.source,
      requests: [finalRequest]
    });
    if (prevented) {
      const result = {
        actor,
        amount: 0,
        incomingAmount: requestedAmount,
        amountBeforeResistance,
        potentialAmount: effectiveAmountBeforeBarrier,
        preBarrierAmount: effectiveAmountBeforeBarrier,
        barrierAbsorbed: barrierApplication.absorbed,
        amountAfterBarrier: effectiveAmount,
        barrierDepleted: barrierApplication.depleted,
        mitigationBlocked,
        preventedAmount: effectiveAmount,
        lethalDamagePrevented: true,
        healthDelta: 0,
        limbDelta: 0,
        mode,
        scope,
        limbKey: data.limbKey,
        damageTypeKey: damageType?.key ?? data.damageTypeKey,
        source: data.source
      };
      if (createSummary) {
        await publishDamageSummaryMessage([result]);
        await notifyDamageApplied([result]);
      }
      return result;
    }
  }

  await applyPreHealthDamageTypeSettings();

  const result = await applyDirectDamageApplication(actor, { ...finalRequest, mode }, damageType);
  result.incomingAmount = mode === MODE_DAMAGE ? requestedAmount : 0;
  result.amountBeforeResistance = amountBeforeResistance;
  result.preBarrierAmount = effectiveAmountBeforeBarrier;
  result.barrierAbsorbed = barrierApplication.absorbed;
  result.amountAfterBarrier = effectiveAmount;
  result.barrierDepleted = barrierApplication.depleted;
  result.mitigationBlocked = mitigationBlocked;
  if (mode === MODE_DAMAGE && data.processDamageTypeSettings && result.healthDelta > 0) {
    await createResourceLimitEffect(actor, {
      damageType,
      healthDelta: result.healthDelta,
      source: data.source,
      worldTime: getDamageApplicationWorldTime(data.source)
    });
    if (!isLimbTimedDamageBlocked(actor, data.limbKey, damageType, "bleeding")) {
      await createBleedingDamageEffect(actor, {
        damageType,
        limbKey: data.limbKey,
        scope,
        healthDelta: result.healthDelta,
        source: data.source,
        worldTime: getDamageApplicationWorldTime(data.source)
      });
    }
  }
  if (mode === MODE_DAMAGE && result.healthDelta > 0) {
    damageNumberEntries = [{
      amount: result.healthDelta,
      damageTypeKey: damageType?.key ?? data.damageTypeKey
    }];
  }
  const healingNumberAmount = mode === MODE_HEALING ? getHealingNumberAmount(result) : 0;
  if (healingNumberAmount > 0) {
    damageNumberEntries = [{
      amount: healingNumberAmount,
      mode: MODE_HEALING
    }];
  }
  if (mode === MODE_DAMAGE && result?.amount > 0) {
    result.finishingBlow = await applyFinishingBlowIfEligible(actor, data);
  }
  if (createSummary) {
    await publishDamageSummaryMessage([result]);
    await notifyDamageApplied([result]);
  }
  return result;
  } finally {
    try {
      await commitOwnedDamageBarrier();
    } finally {
      queueDamageFeedback(pendingFeedback, {
        actor,
        mitigationDisplay,
        damageEntries: damageNumberEntries
      });
      if (ownsFeedbackQueue) flushDamageFeedback(pendingFeedback);
    }
  }
}

async function applyItemConditionDamageApplicationNow(actor, data = {}, { createSummary = false } = {}) {
  const item = getDamageRequestConditionItem(actor, data);
  const requestedAmount = roundDamageAmount(data.amount);
  if (!item || requestedAmount <= 0) {
    return {
      actor,
      amount: requestedAmount,
      healthDelta: 0,
      limbDelta: 0,
      itemConditionDelta: 0,
      mode: MODE_DAMAGE,
      scope: SCOPE_ITEM_CONDITION,
      itemId: data.itemId,
      limbKey: data.limbKey,
      damageTypeKey: data.damageTypeKey
    };
  }

  const condition = getConditionFunction(item);
  const conditionDamage = Math.max(0, requestedAmount - getDamageMitigationWearResistance(item));
  const current = Math.max(0, toInteger(condition.value));
  const next = Math.max(0, current - conditionDamage);
  const delta = Math.max(0, current - next);
  if (delta > 0) {
    await actor.updateEmbeddedDocuments("Item", [{
      _id: item.id,
      "system.functions.condition.value": next
    }]);
  }

  const result = {
    actor,
    amount: requestedAmount,
    healthDelta: 0,
    limbDelta: 0,
    itemConditionDelta: delta,
    mode: MODE_DAMAGE,
    scope: SCOPE_ITEM_CONDITION,
    itemId: item.id,
    itemName: item.name,
    limbKey: data.limbKey,
    damageTypeKey: data.damageTypeKey
  };
  if (createSummary) {
    await publishDamageSummaryMessage([result]);
    await notifyDamageApplied([result]);
  }
  return result;
}

async function applyPeriodicSplitDamageApplicationNow(actor, data = {}, {
  createSummary = true,
  damageType = null,
  periodic = {},
  scope = SCOPE_HEALTH,
  damageBarrierLedger = null,
  damageBarrierCommit = null,
  feedbackQueue = null
} = {}) {
  const { immediateAmount, delayedAmount } = calculatePeriodicDamageSplit(data.amount, periodic);
  const source = markPeriodicDamageSplitSource(data.source);
  const immediateResult = immediateAmount > 0
    ? await applyDamageApplicationNow({
      ...data,
      amount: immediateAmount,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      source
    }, {
      createSummary: false,
      damageBarrierLedger,
      damageBarrierCommit,
      feedbackQueue
    })
    : { actor, amount: 0, healthDelta: 0, limbDelta: 0, mode: MODE_DAMAGE, scope, createdTraumas: [] };

  if (delayedAmount > 0 && !immediateResult?.lethalDamagePrevented) await createPeriodicDamageEffect(actor, {
    damageType,
    limbKey: data.limbKey,
    scope,
    amount: delayedAmount,
    settings: periodic,
    source: data.source,
    worldTime: getDamageApplicationWorldTime(data.source)
  });

  const result = {
    ...immediateResult,
    amount: Math.max(0, Number(immediateResult?.amount) || 0),
    potentialAmount: Math.max(0, Number(immediateResult?.potentialAmount) || immediateAmount),
    delayedAmount
  };
  if (createSummary) {
    await publishDamageSummaryMessage([result]);
    await notifyDamageApplied([result]);
  }
  return result;
}

export function estimateDamageApplication(request = {}) {
  const data = normalizeDamageRequest(request);
  const actor = request.actor ?? (data.actorUuid ? fromUuidSync(data.actorUuid) : null);
  if (!actor || data.mode !== MODE_DAMAGE) {
    return { amount: 0, mitigationBlocked: 0, healthDamage: 0, limbDamage: 0, partDamage: 0, penetrationRemainder: 0, damageTypeKey: data.damageTypeKey };
  }

  if (data.scope === SCOPE_ITEM_CONDITION) {
    const itemConditionDamage = estimateItemConditionDamage(actor, data);
    return {
      amount: Math.max(0, roundDamageAmount(data.amount)),
      mitigationBlocked: 0,
      healthDamage: 0,
      limbDamage: 0,
      itemConditionDamage,
      partDamage: itemConditionDamage,
      penetrationRemainder: getDamageMitigationPenetration(data.source),
      damageTypeKey: data.damageTypeKey
    };
  }

  const runtimeSettings = getPreparedRuntimeSettings();
  const damageType = runtimeSettings.damageTypeSettings.find(entry => entry.key === data.damageTypeKey);
  const mitigationResult = data.applyMitigation
    ? calculateDamageMitigation(actor, data.amount, damageType?.key ?? "", data.limbKey, data.source, {
      damageType,
      damageMitigationCalculation: runtimeSettings.rulesProfile.damageMitigationCalculation,
      itemOnlyMitigation: hasInstalledProsthesis(actor, data.limbKey)
    })
    : { amount: data.amount, penetrationRemainder: getDamageMitigationPenetration(data.source) };
  const mitigatedAmount = mitigationResult.amount;
  let effectiveAmount = data.processDamageTypeSettings
    ? hasInstalledProsthesis(actor, data.limbKey) || isIndependentHealthModelActive(actor)
      ? mitigatedAmount
      : applyLimbDamageMultiplier(actor, mitigatedAmount, data.limbKey)
    : mitigatedAmount;
  const preBarrierAmount = effectiveAmount;
  const barrierApplication = absorbDamageWithBarrier(createActorDamageBarrierLedger(actor), {
    amount: effectiveAmount,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    bypassBarrier: data.bypassBarrier
  });
  effectiveAmount = barrierApplication.remaining;

  const needIncrease = damageType?.settings?.needIncrease;
  if (data.processDamageTypeSettings && needIncrease?.enabled && needIncrease.preventHealthDamage) effectiveAmount = 0;

  const scope = normalizeScope(data.scope, data.limbKey);
  const finalRequest = {
    ...data,
    amount: effectiveAmount,
    scope,
    damageTypeKey: damageType?.key ?? data.damageTypeKey
  };
  const result = estimateDirectDamageApplication(actor, finalRequest, damageType);
  const finalApplication = {
    packetId: String(data.source?.damagePacketId ?? data.source?.conditionWearPacketId ?? "estimate"),
    request: finalRequest,
    requests: [finalRequest],
    healthDamage: calculateFinalHealthDamageInterceptionAmount([finalRequest], result.healthDelta),
    estimate: result
  };
  const finalDamageAllowed = estimateFinalHealthDamageInterceptors(actor, [finalApplication], {
    source: data.source,
    worldTime: getDamageApplicationWorldTime(data.source)
  }).includes(finalApplication);
  return {
    amount: Math.max(0, roundDamageAmount(data.amount)),
    mitigationBlocked: Math.max(0, roundDamageAmount(data.amount - mitigatedAmount)),
    preBarrierAmount: Math.max(0, roundDamageAmount(preBarrierAmount)),
    barrierAbsorbed: Math.max(0, roundDamageAmount(barrierApplication.absorbed)),
    amountAfterBarrier: Math.max(0, roundDamageAmount(barrierApplication.remaining)),
    healthDamage: finalDamageAllowed ? Math.max(0, roundDamageAmount(result.healthDelta)) : 0,
    limbDamage: finalDamageAllowed ? Math.max(0, roundDamageAmount(result.limbDelta)) : 0,
    partDamage: finalDamageAllowed ? Math.max(0, roundDamageAmount(result.limbDelta)) : 0,
    penetrationRemainder: Math.max(0, toInteger(mitigationResult.penetrationRemainder)),
    damageTypeKey: damageType?.key ?? data.damageTypeKey
  };
}

export function estimateDamageApplicationsBatch(actor, requests = []) {
  if (!actor) {
    return {
      amount: 0,
      healthDamage: 0,
      limbDamage: 0,
      itemConditionDamage: 0,
      partDamage: 0,
      penetrationRemainder: 0
    };
  }

  const normalizedRequests = (Array.isArray(requests) ? requests : [requests])
    .map(request => normalizeDamageRequest(request))
    .filter(data => data.mode === MODE_DAMAGE);
  const damageBarrierLedger = normalizedRequests.some(data => data.scope !== SCOPE_ITEM_CONDITION)
    ? createActorDamageBarrierLedger(actor)
    : null;
  const preparationContext = createDamageBatchPreparationContext(actor);
  let preparedEntries = [];
  const conditionRemainingByItem = new Map();
  const conditionDamageByPacket = new Map();
  let amount = 0;
  let itemConditionDamage = 0;
  let penetrationRemainder = null;

  for (const [requestIndex, data] of normalizedRequests.entries()) {
    amount += Math.max(0, roundDamageAmount(data.amount));
    if (data.scope === SCOPE_ITEM_CONDITION) {
      const item = getDamageRequestConditionItem(actor, data);
      if (!item) continue;
      const remaining = conditionRemainingByItem.has(item.id)
        ? conditionRemainingByItem.get(item.id)
        : Math.max(0, toInteger(getConditionFunction(item).value));
      const packetId = getConditionWearPacketId(data.source) || `request:${requestIndex}`;
      const packetKey = `${item.id}:${packetId}`;
      const packet = conditionDamageByPacket.get(packetKey) ?? { raw: 0, applied: 0 };
      packet.raw += Math.max(0, roundDamageAmount(data.amount));
      const requested = Math.max(
        0,
        packet.raw - getDamageMitigationWearResistance(item) - packet.applied
      );
      const applied = Math.min(remaining, requested);
      packet.applied += applied;
      conditionDamageByPacket.set(packetKey, packet);
      conditionRemainingByItem.set(item.id, remaining - applied);
      itemConditionDamage += applied;
      const itemPenetration = getDamageMitigationPenetration(data.source);
      penetrationRemainder = penetrationRemainder === null
        ? itemPenetration
        : Math.min(penetrationRemainder, itemPenetration);
      continue;
    }

    const entry = prepareDamageBatchEntry(actor, data, {
      damageBarrierLedger,
      preparationContext,
      processEquipmentConditionDamage: false
    });
    if (!entry) continue;
    const entryPenetration = Math.max(
      0,
      toInteger(entry.penetrationRemainder ?? getDamageMitigationPenetration(data.source))
    );
    penetrationRemainder = penetrationRemainder === null
      ? entryPenetration
      : Math.min(penetrationRemainder, entryPenetration);
    if (entry.amount > 0) preparedEntries.push(entry);
  }

  if (hasApplicableFinalHealthDamageInterceptors(actor, { estimate: true })) {
    const finalApplications = buildFinalHealthDamageApplications(actor, preparedEntries);
    const previewSource = preparedEntries.find(entry => entry?.source)?.source ?? {};
    const allowedFinalApplications = estimateFinalHealthDamageInterceptors(actor, finalApplications, {
      source: previewSource,
      worldTime: getDamageApplicationWorldTime(previewSource)
    });
    if (allowedFinalApplications.length !== finalApplications.length) {
      const allowedRequests = new Set(
        allowedFinalApplications.flatMap(application => application.requests ?? [])
      );
      preparedEntries = preparedEntries.filter(entry => allowedRequests.has(entry));
    }
  }
  const batch = preparedEntries.length
    ? estimateDamageEntriesBatch(actor, preparedEntries)
    : createLimbMutationResult();
  const healthDamage = Math.max(0, roundDamageAmount(batch.healthDelta));
  const limbDamage = Math.max(0, roundDamageAmount(batch.limbDelta));
  return {
    amount,
    healthDamage,
    limbDamage,
    itemConditionDamage,
    partDamage: limbDamage + itemConditionDamage,
    penetrationRemainder: penetrationRemainder ?? 0
  };
}

export async function applyDamageApplications({ actorUuid = "", requests = [] } = {}, options = {}) {
  const targetActorUuid = String(actorUuid ?? "").trim();
  if (!targetActorUuid) return undefined;
  const normalizedRequests = requests.map(request => normalizeDamageRequest({ ...request, actorUuid: targetActorUuid }));
  return runDamageHubOperation(async () => {
    const feedbackQueue = [];
    try {
      return await executeDamageSystemEventWorkflow(
        normalizedRequests,
        allowedRequests => {
          const operation = () => applyDamageApplicationsNow(
            { actorUuid: targetActorUuid, requests: allowedRequests },
            { ...options, feedbackQueue }
          );
          return isPhantomEntity(fromUuidSync(targetActorUuid))
            ? operation()
            : queueActorDamageMutation(targetActorUuid, operation);
        },
        { batch: normalizedRequests.length > 1 }
      );
    } finally {
      flushDamageFeedback(feedbackQueue);
    }
  });
}

function combineItemConditionDamagePackets(requests = [], actorUuid = "") {
  const combined = [];
  for (const request of requests) {
    const data = normalizeDamageRequest({ ...request, actorUuid });
    const packetId = data.scope === SCOPE_ITEM_CONDITION
      ? getConditionWearPacketId(data.source)
      : "";
    const previous = combined.at(-1);
    if (
      packetId
      && previous?.scope === SCOPE_ITEM_CONDITION
      && previous.itemId === data.itemId
      && getConditionWearPacketId(previous.source) === packetId
    ) {
      previous.amount += data.amount;
      continue;
    }
    combined.push(data);
  }
  return combined;
}

async function applyDamageApplicationsNow(
  { actorUuid = "", requests = [] } = {},
  { createSummary = true, deferredShockChecks = null, feedbackQueue = null } = {}
) {
  const actor = await fromUuid(actorUuid);
  if (!actor) return undefined;
  if (!game.user?.isGM && !actor.isOwner) return undefined;
  if (isPhantomEntity(actor)) {
    const phantomResults = combineItemConditionDamagePackets(requests, actorUuid)
      .filter(data => data.mode === MODE_DAMAGE && data.scope !== SCOPE_ITEM_CONDITION)
      .map(data => createPhantomDamageResult(actor, data));
    return finishPhantomDamageApplications(phantomResults, { createSummary });
  }
  const hasBarrierEligibleDamage = requests.some(request => {
    const data = normalizeDamageRequest(request);
    return data.mode === MODE_DAMAGE && data.scope !== SCOPE_ITEM_CONDITION;
  });
  const damageBarrierLedger = hasBarrierEligibleDamage ? createActorDamageBarrierLedger(actor) : null;
  let damageBarrierCommitted = false;
  const commitDamageBarrier = async () => {
    if (!damageBarrierLedger || damageBarrierCommitted) return;
    await commitDamageBarrierLedger(actor, damageBarrierLedger);
    damageBarrierCommitted = true;
  };
  const ownsFeedbackQueue = !Array.isArray(feedbackQueue);
  const pendingFeedback = ownsFeedbackQueue ? [] : feedbackQueue;
  let results = [];
  let mitigationDisplay = null;
  let batchResult = null;
  try {
  const resourceHealthBefore = getCurrentActorHealthValue(actor);

  let batchRequests = [];
  const singleResults = [];
  const damageApplications = [];
  const mitigationDisplays = [];
  const resistanceOverheats = [];
  const pendingPeriodicDamageEffects = [];
  const equipmentConditionDamageState = createEquipmentConditionDamageState(actor);
  let preparationContext = null;
  for (const data of combineItemConditionDamagePackets(requests, actorUuid)) {
    if (data.mode !== MODE_DAMAGE) {
      singleResults.push(await applyDamageApplicationNow(data, {
        createSummary: false,
        damageBarrierLedger,
        feedbackQueue: pendingFeedback
      }));
      preparationContext = null;
      continue;
    }
    if (data.scope === SCOPE_ITEM_CONDITION) {
      singleResults.push(await applyItemConditionDamageApplicationNow(actor, data));
      preparationContext = null;
      continue;
    }

    preparationContext ??= createDamageBatchPreparationContext(actor);
    const entry = prepareDamageBatchEntry(actor, data, {
      equipmentConditionDamageState,
      pendingPeriodicDamageEffects,
      damageBarrierLedger,
      preparationContext
    });
    if (entry?.damageMitigationDisplay) mitigationDisplays.push(entry.damageMitigationDisplay);
    if (entry?.resistanceOverheat) resistanceOverheats.push(entry.resistanceOverheat);
    if (entry) damageApplications.push(entry);
    if (entry?.amount > 0) batchRequests.push(entry);
  }
  await commitDamageBarrier();
  for (const entry of damageApplications) {
    if (!entry?.needIncreaseApplication) continue;
    await applyNeedIncrease(actor, entry.needIncreaseApplication);
  }

  mitigationDisplay = combineDamageMitigationDisplays(mitigationDisplays);
  const batchMitigationBlocked = Math.max(0, roundDamageAmount(mitigationDisplay?.blocked));

  const batchPotentialAmountBeforeInterception = batchRequests
    .reduce((sum, entry) => sum + Math.max(0, roundDamageAmount(entry.amount)), 0);
  const batchPreBarrierAmount = damageApplications
    .reduce((sum, entry) => sum + Math.max(0, roundDamageAmount(entry.preBarrierAmount ?? entry.amount)), 0);
  const batchAmountAfterBarrier = damageApplications
    .reduce((sum, entry) => sum + Math.max(0, roundDamageAmount(entry.amountAfterBarrier ?? entry.amount)), 0);
  const batchBarrierAbsorbed = damageApplications
    .reduce((sum, entry) => sum + Math.max(0, roundDamageAmount(entry.barrierAbsorbed)), 0);
  const batchBarrierDepleted = damageApplications.flatMap(entry => entry.barrierDepleted ?? []);
  const initialBatchSource = selectBatchFinishingBlowSource(batchRequests)?.source
    ?? damageApplications.find(entry => entry?.source)?.source
    ?? {};
  let batchSource = initialBatchSource;
  let finalHealthDamageInterception = {
    applications: [],
    preventions: [],
    preventedHealthDamage: 0
  };
  if (hasApplicableFinalHealthDamageInterceptors(actor)) {
    const finalHealthDamageApplications = buildFinalHealthDamageApplications(actor, batchRequests);
    finalHealthDamageInterception = await applyFinalHealthDamageInterceptors(
      actor,
      finalHealthDamageApplications,
      {
        source: initialBatchSource,
        worldTime: getDamageApplicationWorldTime(initialBatchSource)
      }
    );
    if (finalHealthDamageInterception.applications.length !== finalHealthDamageApplications.length) {
      const allowedRequests = new Set(
        finalHealthDamageInterception.applications.flatMap(application => application.requests ?? [])
      );
      batchRequests = batchRequests.filter(entry => allowedRequests.has(entry));
    }
    batchSource = selectBatchFinishingBlowSource(batchRequests)?.source ?? initialBatchSource;
  }
  const batchPotentialAmount = batchRequests
    .reduce((sum, entry) => sum + Math.max(0, roundDamageAmount(entry.amount)), 0);
  const batchEstimate = batchRequests.length ? estimateDamageEntriesBatch(actor, batchRequests) : null;
  const batchPrevented = batchEstimate
    ? await preventLethalDamageIfApplicable(actor, batchEstimate, {
      amount: batchPotentialAmount,
      source: batchSource,
      requests: batchRequests
    })
    : false;
  batchResult = batchPrevented
    ? {
      actor,
      amount: 0,
      potentialAmount: batchPotentialAmount,
      preventedAmount: batchPotentialAmount,
      lethalDamagePrevented: true,
      healthDelta: 0,
      limbDelta: 0,
      mode: MODE_DAMAGE,
      scope: SCOPE_HEALTH_AND_LIMB,
      source: batchSource
    }
    : batchRequests.length
      ? await applyDamageEntriesBatch(actor, batchRequests, { deferredShockChecks })
      : batchPreBarrierAmount > 0
        || batchBarrierAbsorbed > 0
        || batchMitigationBlocked > 0
        || pendingPeriodicDamageEffects.length > 0
        ? {
          actor,
          amount: 0,
          healthDelta: 0,
          limbDelta: 0,
          mode: MODE_DAMAGE,
          scope: SCOPE_HEALTH_AND_LIMB,
          source: batchSource
        }
        : undefined;
  const applicationDeltaIndex = buildDamageApplicationDeltaIndex(batchResult?.applicationDeltas);
  if (batchResult) {
    batchResult.mitigationBlocked = batchMitigationBlocked;
    batchResult.incomingAmount = damageApplications.reduce(
      (sum, entry) => sum + Math.max(0, roundDamageAmount(entry.incomingAmount)),
      0
    );
    batchResult.amountBeforeResistance = damageApplications.reduce(
      (sum, entry) => sum + Math.max(0, roundDamageAmount(entry.amountBeforeResistance)),
      0
    );
    batchResult.potentialAmount = batchPotentialAmountBeforeInterception;
    batchResult.preventedAmount = Math.max(0, Number(batchResult.preventedAmount) || 0)
      + finalHealthDamageInterception.preventedHealthDamage;
    batchResult.finalHealthDamagePrevented = finalHealthDamageInterception.preventedHealthDamage;
    batchResult.finalHealthDamagePreventions = finalHealthDamageInterception.preventions;
  }
  if (batchResult && pendingPeriodicDamageEffects.length) {
    batchResult.delayedAmount = pendingPeriodicDamageEffects.reduce(
      (total, entry) => total + Math.max(0, roundDamageAmount(entry.amount)),
      0
    );
  }
  if (batchResult && (batchPreBarrierAmount > 0 || batchBarrierAbsorbed > 0 || batchMitigationBlocked > 0)) {
    batchResult.preBarrierAmount = batchPreBarrierAmount;
    batchResult.barrierAbsorbed = batchBarrierAbsorbed;
    batchResult.amountAfterBarrier = batchAmountAfterBarrier;
    batchResult.barrierDepleted = batchBarrierDepleted;
    batchResult.damageApplications = damageApplications.map(entry => {
      const deltas = getDamageEventIndexEntry(applicationDeltaIndex, entry.damageEventIndex);
      return {
        damageEventIndex: entry.damageEventIndex,
        damageTypeKey: entry.damageTypeKey,
        incomingAmount: Math.max(0, roundDamageAmount(entry.incomingAmount)),
        amountBeforeResistance: Math.max(0, roundDamageAmount(entry.amountBeforeResistance)),
        source: entry.source && typeof entry.source === "object" ? entry.source : {},
        mitigationBlocked: Math.max(0, roundDamageAmount(entry.damageMitigationDisplay?.blocked)),
        preBarrierAmount: entry.preBarrierAmount,
        barrierAbsorbed: entry.barrierAbsorbed,
        amountAfterBarrier: entry.amount,
        actualHealthDelta: deltas?.healthDelta ?? 0,
        actualLimbDelta: deltas?.limbDelta ?? 0,
        barrierDepleted: entry.barrierDepleted
      };
    });
  }
  if (!batchPrevented) {
    await applyEquipmentConditionDamage(actor, getEquipmentConditionDamageStateEntries(equipmentConditionDamageState));
    await applyResistanceOverheats(actor, resistanceOverheats);
    for (const entry of combinePendingPeriodicDamageEffects(pendingPeriodicDamageEffects)) {
      await createPeriodicDamageEffect(actor, entry);
    }
  }
  if (batchResult?.resourceLimitEntries?.length) {
    for (const entry of batchResult.resourceLimitEntries) {
      const damageType = getPreparedRuntimeSettings().damageTypeSettings.find(type => type.key === entry.damageTypeKey);
      await createResourceLimitEffect(actor, {
        damageType,
        healthDelta: entry.amount,
        source: entry.source,
        worldTime: getDamageApplicationWorldTime(entry.source)
      });
    }
  }
  if (batchResult?.bleedingEntries?.length) {
    await createCombinedBleedingDamageEffect(actor, batchResult.bleedingEntries);
  }
  if (batchResult) {
    const resourceHealthAfter = getCurrentActorHealthValue(actor);
    batchResult = {
      ...batchResult,
      resourceHealthDelta: Math.max(0, roundDamageAmount(resourceHealthBefore - resourceHealthAfter))
    };
  }
  results = [batchResult, ...singleResults].filter(Boolean);
  if (createSummary) {
    await publishDamageSummaryMessage(results);
    await notifyDamageApplied(results);
  }
  } finally {
    try {
      await commitDamageBarrier();
    } finally {
      queueDamageFeedback(pendingFeedback, {
        actor,
        mitigationDisplay,
        damageEntries: batchResult?.healthDelta > 0 ? batchResult.healthDeltasByType : []
      });
      if (ownsFeedbackQueue) flushDamageFeedback(pendingFeedback);
    }
  }
  return results;
}

export function createDamageBatchPreparationContext(actor) {
  return {
    actor,
    prosthesisContext: null,
    mitigationEquipmentByTarget: new Map(),
    timedDamageBlockedByTarget: new Map(),
    contextualAbilitySnapshots: new Map()
  };
}

function getDamageBatchProsthesisContext(context, actor) {
  if (context?.actor !== actor) return buildActorProsthesisContext(actor);
  context.prosthesisContext ??= buildActorProsthesisContext(actor);
  return context.prosthesisContext;
}

function getDamageBatchPreparationKey(...parts) {
  return JSON.stringify(parts.map(part => String(part ?? "")));
}

export function getDamageBatchMitigationEquipmentSnapshot(
  context,
  actor,
  damageTypeKey = "",
  limbKey = ""
) {
  if (context?.actor !== actor || !(context.mitigationEquipmentByTarget instanceof Map)) {
    return buildDamageMitigationEquipmentSnapshot(actor, damageTypeKey, limbKey);
  }
  const key = getDamageBatchPreparationKey(limbKey, damageTypeKey);
  let snapshot = context.mitigationEquipmentByTarget.get(key);
  if (!snapshot) {
    snapshot = buildDamageMitigationEquipmentSnapshot(actor, damageTypeKey, limbKey);
    context.mitigationEquipmentByTarget.set(key, snapshot);
  }
  return snapshot;
}

export function buildDamageMitigationEquipmentSnapshot(actor, damageTypeKey = "", limbKey = "") {
  const totals = {
    [DAMAGE_MITIGATION_MODES.defense]: 0,
    [DAMAGE_MITIGATION_MODES.resistance]: 0
  };
  const sources = [];
  if (!actor || !damageTypeKey || !limbKey) return { totals, sources };

  for (const item of actor.items?.contents ?? Array.from(actor.items ?? [])) {
    const isConstructPart = item.type === "gear"
      && hasItemFunction(item, ITEM_FUNCTIONS.constructPart)
      && String(item.system?.placement?.mode ?? "") === ITEM_FUNCTIONS.constructPart;
    if (item.type !== "gear" || (!item.system?.equipped && !isConstructPart)) continue;
    if (!hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation)) continue;
    if (isConstructPart && getConstructPartLimbKey(getConstructPartSlotId(item)) !== limbKey) continue;

    const mitigation = getDamageMitigationFunction(item);
    const mode = String(mitigation.mode || DAMAGE_MITIGATION_MODES.defense);
    const entryKey = isConstructPart ? CONSTRUCT_PART_MITIGATION_LIMB_KEY : limbKey;
    const entry = mitigation.entries?.[entryKey]?.[damageTypeKey];
    const baseValue = toInteger(entry?.value);
    if (!baseValue) continue;

    const weakening = getConditionWeakeningData(item);
    const value = baseValue > 0
      ? Math.floor(baseValue * (weakening.active ? weakening.ratio : 1))
      : baseValue;
    if (!value) continue;
    if (Object.hasOwn(totals, mode)) totals[mode] += value;
    if (value < 0 || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) continue;
    sources.push({
      item,
      itemId: item.id,
      mode,
      mitigation: value
    });
  }

  return { totals, sources };
}

function shouldCalculateEquipmentConditionDamage(damageType = null, requested = false) {
  if (!requested) return false;
  const settings = damageType?.settings?.equipmentConditionDamage;
  return Boolean(settings?.enabled && String(settings.formula ?? "").trim());
}

function prepareDamageBatchEntry(actor, data = {}, {
  equipmentConditionDamageState = null,
  pendingPeriodicDamageEffects = null,
  damageBarrierLedger = null,
  preparationContext = null,
  processEquipmentConditionDamage = true
} = {}) {
  const scope = normalizeScope(data.scope, data.limbKey);
  const runtimeSettings = getPreparedRuntimeSettings();
  const damageType = runtimeSettings.damageTypeSettings.find(entry => entry.key === data.damageTypeKey);
  const periodic = damageType?.settings?.periodic;
  if (
    shouldSplitPeriodicDamage(data, MODE_DAMAGE, periodic)
    && !isLimbTimedDamageBlocked(actor, data.limbKey, damageType, "periodic", preparationContext)
  ) {
    const { immediateAmount, delayedAmount } = calculatePeriodicDamageSplit(data.amount, periodic);
    if (delayedAmount > 0) pendingPeriodicDamageEffects?.push({
      damageType,
      limbKey: data.limbKey,
      scope,
      amount: delayedAmount,
      settings: periodic,
      source: data.source,
      worldTime: getDamageApplicationWorldTime(data.source)
    });
    if (!immediateAmount) {
      return {
        ...data,
        amount: 0,
        incomingAmount: 0,
        amountBeforeResistance: 0,
        delayedAmount,
        damageTypeKey: damageType?.key ?? data.damageTypeKey,
        damageType,
        scope,
        penetrationRemainder: getDamageMitigationPenetration(data.source)
      };
    }
    return prepareDamageBatchEntry(actor, {
      ...data,
      amount: immediateAmount,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      source: markPeriodicDamageSplitSource(data.source)
    }, {
      equipmentConditionDamageState,
      pendingPeriodicDamageEffects,
      damageBarrierLedger,
      preparationContext,
      processEquipmentConditionDamage
    });
  }

  const needsProsthesisLookup = data.applyMitigation || data.processDamageTypeSettings;
  const prosthesis = needsProsthesisLookup
    ? getInstalledProsthesis(
      actor,
      data.limbKey,
      getDamageBatchProsthesisContext(preparationContext, actor)
    )
    : null;
  const includeEquipmentConditionDamage = processEquipmentConditionDamage
    && shouldCalculateEquipmentConditionDamage(damageType, data.processDamageTypeSettings);
  const equipmentSnapshot = data.applyMitigation && (prosthesis || includeEquipmentConditionDamage)
    ? getDamageBatchMitigationEquipmentSnapshot(
      preparationContext,
      actor,
      damageType?.key ?? "",
      data.limbKey
    )
    : null;
  const mitigationResult = data.applyMitigation
    ? calculateDamageMitigation(actor, data.amount, damageType?.key ?? "", data.limbKey, data.source, {
      damageType,
      damageMitigationCalculation: runtimeSettings.rulesProfile.damageMitigationCalculation,
      itemOnlyMitigation: Boolean(prosthesis),
      itemMitigationTotals: equipmentSnapshot?.totals,
      includeEquipmentConditionDamage,
      equipmentSources: includeEquipmentConditionDamage ? equipmentSnapshot?.sources : null,
      includeResistanceOverheat: data.processDamageTypeSettings,
      equipmentConditionDamageState: includeEquipmentConditionDamage ? equipmentConditionDamageState : null,
      contextualAbilitySnapshots: preparationContext?.contextualAbilitySnapshots
    })
    : { amount: data.amount, amountBeforeResistance: data.amount, display: null };
  const amountBeforeResistance = Math.max(0, Number(mitigationResult.amountBeforeResistance) || 0);
  const mitigatedAmount = mitigationResult.amount;
  const effectiveAmountBeforeBarrier = data.processDamageTypeSettings
    ? prosthesis || isIndependentHealthModelActive(actor)
      ? mitigatedAmount
      : applyLimbDamageMultiplier(actor, mitigatedAmount, data.limbKey)
    : mitigatedAmount;
  const damageMitigationDisplay = data.applyMitigation
    ? buildDamageMitigationDisplay(data.amount, mitigatedAmount)
    : null;
  if (effectiveAmountBeforeBarrier <= 0) {
    return damageMitigationDisplay
      ? {
        ...data,
        amount: 0,
        incomingAmount: Math.max(0, Number(data.amount) || 0),
        amountBeforeResistance,
        damageTypeKey: damageType?.key ?? data.damageTypeKey,
        damageType,
        scope,
        damageMitigationDisplay,
        resistanceOverheat: mitigationResult.resistanceOverheat,
        penetrationRemainder: mitigationResult.penetrationRemainder
      }
      : null;
  }

  const barrierApplication = absorbDamageWithBarrier(damageBarrierLedger, {
    amount: effectiveAmountBeforeBarrier,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    bypassBarrier: data.bypassBarrier
  });
  const effectiveAmount = barrierApplication.remaining;
  if (effectiveAmount <= 0) {
    return {
      ...data,
      amount: 0,
      incomingAmount: Math.max(0, Number(data.amount) || 0),
      amountBeforeResistance,
      preBarrierAmount: effectiveAmountBeforeBarrier,
      barrierAbsorbed: barrierApplication.absorbed,
      amountAfterBarrier: 0,
      barrierDepleted: barrierApplication.depleted,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      damageType,
      scope,
      damageMitigationDisplay,
      resistanceOverheat: mitigationResult.resistanceOverheat,
      penetrationRemainder: mitigationResult.penetrationRemainder
    };
  }

  const needIncrease = damageType?.settings?.needIncrease;
  const needIncreaseApplication = data.processDamageTypeSettings && needIncrease?.enabled
    ? { amount: effectiveAmount, settings: needIncrease }
    : null;
  const amountAfterNeed = needIncreaseApplication && needIncrease.preventHealthDamage
    ? 0
    : effectiveAmount;

  return {
    ...data,
    amount: amountAfterNeed,
    incomingAmount: Math.max(0, Number(data.amount) || 0),
    amountBeforeResistance,
    preBarrierAmount: effectiveAmountBeforeBarrier,
    barrierAbsorbed: barrierApplication.absorbed,
    amountAfterBarrier: effectiveAmount,
    barrierDepleted: barrierApplication.depleted,
    needIncreaseApplication,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    damageType,
    scope,
    damageMitigationDisplay,
    resistanceOverheat: mitigationResult.resistanceOverheat,
    penetrationRemainder: mitigationResult.penetrationRemainder
  };
}

async function applyDirectDamageApplication(actor, data = {}, damageType = null) {
  const mode = data.mode === MODE_HEALING ? MODE_HEALING : MODE_DAMAGE;
  const scope = normalizeScope(data.scope, data.limbKey);
  const effectiveAmount = Math.max(0, roundDamageAmount(data.amount));
  const independentHealthRules = getIndependentHealthRules(actor);
  if (mode === MODE_HEALING && actor?.type === "construct") {
    return {
      actor,
      amount: 0,
      healthDelta: 0,
      limbDelta: 0,
      mode,
      scope,
      limbKey: data.limbKey,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      createdTraumas: []
    };
  }

  const updateData = {};
  const limb = data.limbKey ? actor.system?.limbs?.[data.limbKey] : null;
  const shouldUpdateLimb = Boolean(limb) && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB);
  let actualHealthDelta = 0;
  let actualLimbDelta = 0;
  let previousLimbValue = limb ? getEffectiveLimbStateValue(actor, data.limbKey) : 0;
  let nextLimbValue = previousLimbValue;
  let limbStates = new Map();
  let damageAccumulation = new Map();
  let shockCheck = null;
  let targetedProsthesis = null;

  if (mode === MODE_DAMAGE) {
    const traumaDamageTypeKey = getTraumaDamageTypeKey(data.damageTypeKey);
    targetedProsthesis = shouldUpdateLimb ? getInstalledProsthesis(actor, data.limbKey) : null;
    let independentHealthDelta = 0;
    let result;
    if (independentHealthRules && targetedProsthesis) {
      result = await calculateProsthesisLimbDamage(actor, data.limbKey, effectiveAmount, {
        prosthesis: targetedProsthesis,
        limbDamageMultiplier: getWeaponLimbDamageMultiplier(data.source?.weaponData, data.limbKey),
        damageType,
        damageTypeKey: data.damageTypeKey,
        traumaDamageTypeKey
      });
      const healthState = createIndependentHealthState(actor.system?.resources?.health);
      independentHealthDelta = applyIndependentHealthChange(
        healthState,
        result.healthDelta,
        MODE_DAMAGE
      );
      if (independentHealthDelta > 0) Object.assign(updateData, buildIndependentHealthUpdate(healthState));
    } else if (independentHealthRules) {
      const healthState = createIndependentHealthState(actor.system?.resources?.health);
      independentHealthDelta = applyIndependentHealthChange(
        healthState,
        effectiveAmount,
        MODE_DAMAGE
      );
      if (independentHealthDelta > 0) Object.assign(updateData, buildIndependentHealthUpdate(healthState));
      result = shouldUpdateLimb
        ? calculateIndependentOrganicLimbDamage(actor, data.limbKey, independentHealthDelta, {
          profileMultiplier: independentHealthRules.limbDamageFromLostHealthMultiplier,
          limbDamageMultiplier: getWeaponLimbDamageMultiplier(data.source?.weaponData, data.limbKey),
          damageType,
          damageTypeKey: data.damageTypeKey,
          traumaDamageTypeKey
        })
        : createLimbMutationResult();
    } else {
      result = targetedProsthesis
        ? await calculateProsthesisLimbDamage(actor, data.limbKey, effectiveAmount, {
          prosthesis: targetedProsthesis,
          limbDamageMultiplier: getWeaponLimbDamageMultiplier(data.source?.weaponData, data.limbKey),
          damageType,
          damageTypeKey: data.damageTypeKey,
          traumaDamageTypeKey
        })
        : shouldUpdateLimb
          ? await calculateTargetedLimbDamage(actor, data.limbKey, effectiveAmount, {
            limbDamageMultiplier: getWeaponLimbDamageMultiplier(data.source?.weaponData, data.limbKey),
            damageType,
            damageTypeKey: data.damageTypeKey,
            traumaDamageTypeKey
          })
          : await calculateEvenLimbDamage(actor, effectiveAmount, { damageType, damageTypeKey: data.damageTypeKey, traumaDamageTypeKey });
    }
    limbStates = result.limbStates;
    damageAccumulation = result.damageAccumulation;
    shockCheck = result.shockCheck;
    actualHealthDelta = independentHealthRules ? independentHealthDelta : result.healthDelta;
    actualLimbDelta = result.limbDelta;
    if (shouldUpdateLimb) {
      const state = limbStates.get(data.limbKey);
      nextLimbValue = state?.nextValue ?? previousLimbValue;
    }
  } else if (independentHealthRules) {
    const healthState = createIndependentHealthState(actor.system?.resources?.health);
    actualHealthDelta = applyIndependentHealthChange(
      healthState,
      scope === SCOPE_LIMB ? 0 : effectiveAmount,
      MODE_HEALING
    );
    if (actualHealthDelta > 0) Object.assign(updateData, buildIndependentHealthUpdate(healthState));
    if (shouldUpdateLimb) {
      const result = calculateTargetedLimbHealing(actor, data.limbKey, effectiveAmount);
      limbStates = result.limbStates;
      damageAccumulation = result.damageAccumulation;
      actualLimbDelta = result.limbDelta;
      const state = limbStates.get(data.limbKey);
      nextLimbValue = state?.nextValue ?? previousLimbValue;
    }
  } else if (shouldUpdateLimb) {
    const result = calculateTargetedLimbHealing(actor, data.limbKey, effectiveAmount);
    limbStates = result.limbStates;
    damageAccumulation = result.damageAccumulation;
    actualHealthDelta = result.healthDelta;
    actualLimbDelta = result.limbDelta;
    const state = limbStates.get(data.limbKey);
    nextLimbValue = state?.nextValue ?? previousLimbValue;
  } else {
    const result = calculateEvenLimbHealing(actor, effectiveAmount);
    limbStates = result.limbStates;
    damageAccumulation = result.damageAccumulation;
    actualHealthDelta = result.healthDelta;
    actualLimbDelta = result.limbDelta;
  }

  for (const [limbKey, state] of limbStates) {
    if (!state.totalDelta) continue;
    if (isConstructPartLimb(actor, limbKey)) continue;
    setLimbValueUpdate(updateData, actor, limbKey, state.nextValue, { persistValue: false });
  }
  for (const [limbKey, accumulation] of damageAccumulation) {
    if (isConstructPartLimb(actor, limbKey)) continue;
    updateData[`system.limbs.${limbKey}.damageAccumulation`] = replaceDamageAccumulation(accumulation);
  }
  if (mode === MODE_HEALING && actualLimbDelta > 0) {
    mergeConsciousnessRecoveryUpdate(updateData, actor, actualLimbDelta);
  }
  if (Object.keys(updateData).length) {
    await actor.update(updateData, { falloutMawSkipDamageStatusSync: true });
  }
  if (actor?.type === "construct" && limbStates.size) await syncConstructPartConditionValues(actor, limbStates);

  let destroyedLimbKeys = new Set();
  if (mode === MODE_DAMAGE) {
    const destructionCandidates = new Set(limbStates.keys());
    if (
      shouldUpdateLimb
      && !targetedProsthesis
      && !isLimbPhysicallyMissing(actor, data.limbKey)
    ) destructionCandidates.add(data.limbKey);
    if (destructionCandidates.size) {
      destroyedLimbKeys = await applyDestroyedLimbConsequencesNow(actor, Array.from(destructionCandidates));
    }
  }
  if (shockCheck) await performNegativeLimbShockCheck(actor, shockCheck, { chainRef: data.source?.chainRef ?? null });
  const destroyedLimbShockCheck = aggregateNegativeLimbShockChecks(actor, buildDestroyedLimbShockChecks(actor, destroyedLimbKeys));
  if (destroyedLimbShockCheck) {
    await performNegativeLimbShockCheck(actor, destroyedLimbShockCheck, { chainRef: data.source?.chainRef ?? null });
  }
  await queueActorDamageStatusSync(actor);

  const createdTraumas = [];
  if (mode === MODE_DAMAGE && actualLimbDelta > 0) {
    for (const [limbKey, state] of limbStates) {
      if (!state.totalDelta || destroyedLimbKeys.has(limbKey)) continue;
      const [damageTypeKey, latestDamage] = Object.entries(state.damageByType)
        .sort((left, right) => right[1] - left[1])
        .at(0) ?? [damageType?.key ?? data.damageTypeKey, state.totalDelta];
      createdTraumas.push(...await createTriggeredTraumas(actor, {
        limbKey,
        damageTypeKey,
        previousValue: state.previousValue,
        nextValue: state.nextValue,
        latestDamage,
        damageSnapshot: state.damageAccumulationSnapshot
      }));
    }
  }

  return {
    actor,
    amount: effectiveAmount,
    healthDelta: actualHealthDelta,
    limbDelta: actualLimbDelta,
    mode,
    scope,
    limbKey: data.limbKey,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    source: data.source,
    createdTraumas
  };
}

async function applyFinishingBlowIfEligible(targetActor, data = {}) {
  if (!targetActor || isActorDead(targetActor)) return null;

  const attackerUuid = String(data?.source?.attackerUuid ?? "").trim();
  if (!attackerUuid) return null;

  const attacker = await fromUuid(attackerUuid);
  if (!attacker) return null;

  const weaponUuid = String(data?.source?.weaponUuid ?? "").trim();
  const attackerTokenUuid = String(data?.source?.attackerTokenUuid ?? "").trim();
  const targetTokenUuid = String(data?.source?.targetTokenUuid ?? "").trim();
  const [weapon, attackerTokenDocument, targetTokenDocument] = await Promise.all([
    weaponUuid ? fromUuid(weaponUuid).catch(() => null) : null,
    attackerTokenUuid ? fromUuid(attackerTokenUuid).catch(() => null) : null,
    targetTokenUuid ? fromUuid(targetTokenUuid).catch(() => null) : null
  ]);
  const weaponDataSnapshot = data?.source?.weaponData && typeof data.source.weaponData === "object"
    ? data.source.weaponData
    : null;
  const weaponData = weaponDataSnapshot ?? (weapon
    ? getWeaponFunctionById(weapon, String(data?.source?.weaponFunctionId ?? ""))
    : null);
  const applyTargetReverseChange = (key, baseValue) => getContextualAbilityChangeValue(attacker, key, {
    baseValue,
    actorToken: attackerTokenDocument?.object ?? attackerTokenDocument ?? null,
    targetActor,
    targetToken: targetTokenDocument?.object ?? targetTokenDocument ?? null,
    weaponActionKey: String(data?.source?.actionKey ?? ""),
    weaponData,
    attackDistanceMeters: data?.source?.attackDistanceMeters ?? null,
    effectiveRange: data?.source?.effectiveRange ?? null,
    chanceOperationId: getActiveUseOperationId(data?.source, getCurrentDamageHubOperationRef())
  });
  const threshold = Math.max(0, Math.min(100, toInteger(applyTargetReverseChange(
    "system.combat.finishingBlow",
    attacker.system?.combat?.finishingBlow
  ))));
  if (threshold <= 0) return null;

  const health = targetActor.health;
  const healthMax = Math.max(0, toInteger(health?.max));
  if (healthMax <= 0) return null;

  const healthValue = Math.max(0, Math.min(healthMax, toInteger(health?.value)));
  const healthPercent = (healthValue / healthMax) * 100;
  if (!(healthPercent < threshold)) return null;

  const limbKey = selectFinishingBlowCriticalLimbKey(targetActor, data.limbKey);
  if (!limbKey) return null;

  const chance = Math.max(0, Math.min(100, toInteger(applyTargetReverseChange(
    "system.combat.finishingBlowChance",
    attacker.system?.combat?.finishingBlowChance
  ))));
  const roll = chance > 0 ? Math.ceil(Math.random() * 100) : 0;
  if (chance > 0 && roll > chance) return null;

  const destroyed = await destroyActorLimbExplicitly(targetActor, limbKey);
  if (!destroyed) return null;

  const result = {
    attacker,
    target: targetActor,
    limbKey,
    threshold,
    healthPercent,
    chance,
    roll
  };
  await publishFinishingBlowMessage(result);
  return {
    attackerUuid: attacker.uuid,
    targetUuid: targetActor.uuid,
    limbKey,
    threshold,
    healthPercent,
    chance,
    roll
  };
}

function selectFinishingBlowCriticalLimbKey(actor, preferredLimbKey = "") {
  const preferred = String(preferredLimbKey ?? "").trim();
  if (preferred && isCriticalLimb(actor, preferred) && !isLimbDestroyed(actor, preferred)) return preferred;

  const limbHealthContext = buildActorLimbHealthContext(actor);
  return Object.entries(actor?.system?.limbs ?? {})
    .filter(([limbKey]) => isCriticalLimb(actor, limbKey) && !isLimbDestroyed(actor, limbKey))
    .map(([limbKey, limb]) => ({
      limbKey,
      value: Math.max(0, getEffectiveLimbStateValue(actor, limbKey, null, limbHealthContext)),
      max: Math.max(1, toInteger(limb?.max))
    }))
    .sort((left, right) => (left.value / left.max) - (right.value / right.max))
    .at(0)?.limbKey ?? "";
}

/** Explicitly destroy a limb, independently from automatic −100% destruction policy. */
export async function destroyActorLimbExplicitly(actor, limbKey = "") {
  const key = String(limbKey ?? "").trim();
  if (!actor || !key || isLimbDestroyed(actor, key)) return false;

  const constructPart = getConstructPartItemForLimb(actor, key);
  if (constructPart) {
    if (!hasItemFunction(constructPart, ITEM_FUNCTIONS.condition)) return false;
    await actor.updateEmbeddedDocuments("Item", [{
      _id: constructPart.id,
      "system.functions.condition.value": 0
    }], { falloutMawConstructPartConditionSync: true });
  } else {
    const installedProsthesis = getInstalledProsthesis(actor, key);
    if (installedProsthesis) {
      await breakInstalledProsthesis(actor, installedProsthesis);
      await queueActorDamageStatusSync(actor);
      return true;
    }
    const limb = actor.system?.limbs?.[key];
    if (!limb) return false;
    const updateData = {
      [`system.limbs.${key}.missing`]: true,
      [`system.limbs.${key}.damageAccumulation`]: replaceDamageAccumulation()
    };
    setLimbValueUpdate(updateData, actor, key, toInteger(limb.min));
    await actor.update(updateData, { falloutMawSkipDamageStatusSync: true });
  }

  await applyDestroyedLimbConsequences(actor, [key], { ignoreInstalledProsthesis: true });
  await queueActorDamageStatusSync(actor);
  return true;
}

async function publishFinishingBlowMessage({
  attacker = null,
  target = null,
  limbKey = "",
  threshold = 0,
  healthPercent = 0,
  chance = 0,
  roll = 0
} = {}) {
  if (!target) return undefined;
  const roundedHealthPercent = Math.max(0, Math.floor(Number(healthPercent) || 0));
  const chanceText = chance > 0
    ? ` Шанс: ${chance}%, бросок: ${roll}%.`
    : "";
  const context = {
    attacker: {
      name: String(attacker?.name ?? game.i18n.localize("DOCUMENT.Actor"))
    },
    target: {
      name: String(target.name ?? game.i18n.localize("DOCUMENT.Actor")),
      img: getActorDamageSummaryImage(target)
    },
    limb: {
      key: limbKey,
      label: getLimbLabel(target, limbKey)
    },
    labels: {
      kicker: "Добивание",
      title: "Сработало добивание",
      attacker: "Атакующий",
      limb: "Критическая часть",
      description: `Общее здоровье цели ${roundedHealthPercent}% ниже порога ${threshold}%. Критическая часть уничтожена.${chanceText}`
    }
  };
  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATES.finishingBlowChatCard, context);
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: attacker ?? target }),
    content,
    sound: null,
    flags: {
      [SYSTEM_ID]: {
        finishingBlow: {
          attackerUuid: attacker?.uuid ?? "",
          targetUuid: target.uuid,
          limbKey,
          threshold,
          healthPercent: roundedHealthPercent,
          chance,
          roll
        }
      }
    }
  });
}

export function getActorTraumas(actor) {
  return getActorItemsByType(actor, "trauma");
}

/**
 * Build item-dependent limb lookups for one synchronous Actor snapshot.
 * Rebuild after any Actor or embedded Item mutation; never retain across await.
 */
function buildActorProsthesisContext(actor) {
  const prosthesesByLimb = new Map();
  for (const item of getActorItemsByType(actor, "gear")) {
    if (
      !item.system?.equipped
      || !hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
      || String(item.system?.placement?.mode ?? "") !== "prosthesis"
    ) continue;
    const limbKey = String(item.system?.placement?.limbKey ?? "");
    if (!limbKey || prosthesesByLimb.has(limbKey)) continue;
    prosthesesByLimb.set(limbKey, item);
  }
  return { actor, prosthesesByLimb };
}

export function buildActorLimbHealthContext(actor) {
  const { prosthesesByLimb } = buildActorProsthesisContext(actor);
  const traumas = getActorTraumas(actor);
  const suppressedTraumaIds = traumas.length
    ? getActorSuppressedTraumaDiseaseIds(actor).trauma
    : new Set();
  const activeTraumasByLimb = new Map();
  for (const trauma of traumas) {
    if (suppressedTraumaIds.has(trauma?.id)) continue;
    const limbKey = trauma?.system?.limbKey;
    const entries = activeTraumasByLimb.get(limbKey) ?? [];
    entries.push(trauma);
    activeTraumasByLimb.set(limbKey, entries);
  }

  return {
    actor,
    prosthesesByLimb,
    activeTraumasByLimb
  };
}

export function getLimbHealingCap(actor, limbKey = "", context = null) {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return 0;
  if (hasInstalledProsthesis(actor, limbKey, context)) return 0;
  if (isLimbPhysicallyMissing(actor, limbKey)) return 0;
  const max = toInteger(limb.max);
  if (isActorLimbHealthContextFor(context, actor)) {
    return (context.activeTraumasByLimb.get(limbKey) ?? [])
      .reduce((cap, item) => Math.min(cap, getTraumaLimbHealingCap(item, max)), max);
  }
  const suppressedTraumas = getActorSuppressedTraumaDiseaseIds(actor).trauma;
  return getActorTraumas(actor)
    .filter(item => item.system?.limbKey === limbKey)
    .filter(item => !suppressedTraumas.has(item.id))
    .reduce((cap, item) => Math.min(cap, getTraumaLimbHealingCap(item, max)), max);
}

export function getLimbEffectiveMaximum(actor, limbKey = "", context = null) {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return 0;
  const max = Math.max(0, toInteger(limb.max));
  return Math.min(max, getLimbHealingCap(actor, limbKey, context));
}

/**
 * Prepare the complete Actor update for a targeted limb-healing operation
 * without writing it. Transactional callers can batch this update with their
 * own resource costs while reusing the same caps, accumulation dilution and
 * consciousness recovery as the normal damage hub.
 */
export function prepareTargetedLimbHealingActorUpdate(
  actor,
  limbKey = "",
  amount = 0,
  context = buildActorLimbHealthContext(actor)
) {
  const key = String(limbKey ?? "").trim();
  const limb = actor?.system?.limbs?.[key];
  const previousValue = limb ? getEffectiveLimbStateValue(actor, key, null, context) : 0;
  const empty = {
    updateData: {},
    previousValue,
    finalValue: previousValue,
    appliedHealing: 0,
    healthDelta: 0,
    healingCap: limb ? getLimbEffectiveMaximum(actor, key, context) : 0
  };
  if (!limb || actor?.type === "construct" || isConstructPartLimb(actor, key)) return empty;

  const result = calculateTargetedLimbHealing(actor, key, amount, { context });
  const state = result.limbStates.get(key);
  if (!state?.totalDelta) return empty;

  const updateData = {};
  setLimbValueUpdate(updateData, actor, key, state.nextValue);
  const accumulation = result.damageAccumulation.get(key);
  if (accumulation) {
    updateData[`system.limbs.${key}.damageAccumulation`] = replaceDamageAccumulation(accumulation);
  }
  if (result.limbDelta > 0) mergeConsciousnessRecoveryUpdate(updateData, actor, result.limbDelta);

  return {
    // This plan is consumed both by ordinary Document#update calls and by
    // exact-leaf atomic batches. Foundry accepts dotted update paths in both
    // cases, while a nested root such as {system: {...}} is deliberately not
    // a safe atomic update. Flatten only after every coupled limb and
    // consciousness field has been assembled so the public plan has one
    // unambiguous representation.
    updateData: foundry.utils.flattenObject(updateData),
    previousValue: state.previousValue,
    finalValue: state.nextValue,
    appliedHealing: result.limbDelta,
    healthDelta: Math.max(0, state.nextValue) - Math.max(0, state.previousValue),
    healingCap: getLimbEffectiveMaximum(actor, key, context)
  };
}

export function clampActorLimbValuesToCurrentCaps(
  actor,
  context = buildActorLimbHealthContext(actor)
) {
  let changed = false;
  for (const [limbKey, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    if (!limb || typeof limb !== "object") continue;
    const boundedValue = clampLimbStateValue(actor, limbKey, limb.value, context);
    if (boundedValue === toInteger(limb.value)) continue;
    limb.value = boundedValue;
    limb.spent = calculateLimbSpentFromValue(limb, boundedValue);
    changed = true;
  }
  if (changed && !isIndependentHealthModelActive(actor)) {
    synchronizePreparedAggregateHealthResource(actor, context);
  }
  return changed;
}

export function synchronizeActorLimbValueCaps(actor) {
  if (!canApplyDamageLocally(actor)) return undefined;
  return queueActorDamageMutation(actor, async freshActor => {
    if (!freshActor) return undefined;
    const updates = buildLimbValueCapSyncUpdate(freshActor);
    if (!Object.keys(updates).length) return freshActor;
    await freshActor.update(updates, {
      falloutMawSkipDamageStatusSync: true,
      falloutMawLimbCapSync: true
    });
    await queueActorDamageStatusSync(freshActor);
    return freshActor;
  });
}

function getTraumaLimbHealingCap(trauma, limbMax = 0) {
  const max = Math.max(0, toInteger(limbMax));
  const percent = Math.max(0, Math.min(100, toInteger(trauma?.system?.thresholdPercent)));
  return Math.floor((max * percent) / 100);
}

export function getDestroyedLimbStateLabel(actor, limbKey = "") {
  if (getConstructPartSlotForLimb(actor, limbKey)) {
    return getConstructPartItemForLimb(actor, limbKey) ? "Разрушен" : "Отсутствует";
  }
  return "Отсутствует";
}

export async function restoreDestroyedLimb(actor, limbKey = "") {
  if (!actor || !game.user?.isGM) return undefined;
  const constructSlot = getConstructPartSlotForLimb(actor, limbKey);
  if (constructSlot) {
    const message = getConstructPartItemForLimb(actor, limbKey)
      ? "Детали конструкта восстанавливаются через ремонт самой детали."
      : "Сначала установите подходящую деталь в пустой слот конструкта.";
    ui.notifications?.warn?.(message);
    return undefined;
  }
  return queueActorDamageMutation(actor.uuid, async freshActor => {
    const limb = freshActor?.system?.limbs?.[limbKey];
    if (!freshActor || !limb) return undefined;
    const max = Math.max(0, toInteger(limb.max));
    const restoredLimbHealth = Math.max(
      max,
      calculateConsciousnessHealingGain(limb.value, max)
    );

    await deleteLimbTraumas(freshActor, limbKey);
    await deleteLimbLossEffects(freshActor, limbKey);
    const updateData = {
      [`system.limbs.${limbKey}.missing`]: false,
      [`system.limbs.${limbKey}.value`]: max,
      [`system.limbs.${limbKey}.spent`]: 0,
      [`system.limbs.${limbKey}.damageAccumulation`]: replaceDamageAccumulation()
    };
    mergeConsciousnessRecoveryUpdate(updateData, freshActor, restoredLimbHealth);
    await freshActor.update(updateData, { falloutMawSkipDamageStatusSync: true });
    await queueActorDamageStatusSync(freshActor);
    return freshActor;
  });
}

export async function clearLimbLossState(actor, limbKey = "") {
  if (!actor || !limbKey) return undefined;
  return queueActorDamageMutation(actor.uuid, async freshActor => {
    await deleteLimbLossEffects(freshActor, limbKey);
    await queueActorDamageStatusSync(freshActor);
    return freshActor;
  });
}

export async function deleteHealedTraumas(actor, traumaIds = []) {
  const actorUuid = actor?.uuid;
  const ids = Array.from(new Set(
    (Array.isArray(traumaIds) ? traumaIds : [traumaIds])
      .map(id => String(id ?? "").trim())
      .filter(Boolean)
  ));
  if (!actorUuid || !ids.length) return actor;

  return queueActorDamageMutation(actorUuid, async freshActor => {
    if (!freshActor) return undefined;
    const traumas = ids
      .map(id => freshActor.items?.get?.(id))
      .filter(item => item?.type === "trauma");
    if (!traumas.length) return freshActor;

    const limbKeys = new Set();
    for (const trauma of traumas) {
      const primaryLimbKey = String(trauma.system?.limbKey ?? "").trim();
      if (primaryLimbKey) limbKeys.add(primaryLimbKey);
      for (const source of trauma.system?.sources ?? []) {
        const limbKey = String(source?.limbKey ?? "").trim();
        if (limbKey) limbKeys.add(limbKey);
      }
    }

    const updates = {};
    for (const limbKey of limbKeys) {
      if (!freshActor.system?.limbs?.[limbKey]) continue;
      updates[`system.limbs.${limbKey}.damageAccumulation`] = replaceDamageAccumulation();
    }
    if (Object.keys(updates).length) {
      await freshActor.update(updates, { falloutMawSkipDamageStatusSync: true });
    }
    await freshActor.deleteEmbeddedDocuments("Item", traumas.map(item => item.id), { animate: false });
    await queueActorDamageStatusSync(freshActor);
    return freshActor;
  });
}

/**
 * Refresh derived vital-status effects after another transactional subsystem
 * has changed trauma Items or limb state through Foundry's batch API.
 */
export function synchronizeActorDamageStatusesAfterInventoryMutation(actor) {
  return queueActorDamageStatusSync(actor);
}

export async function setLimbMissingState(actor, limbKey = "", { syncStatus = false } = {}) {
  if (!actor || !limbKey) return undefined;
  const limb = actor.system?.limbs?.[limbKey];
  if (!limb) return undefined;
  await actor.update({
    [`system.limbs.${limbKey}.missing`]: true,
    [`system.limbs.${limbKey}.damageAccumulation`]: replaceDamageAccumulation()
  }, { falloutMawSkipDamageStatusSync: !syncStatus });
  if (syncStatus) await queueActorDamageStatusSync(actor);
  return actor;
}

export async function fullyRestoreActorDamageState(actor) {
  if (!actor?.isOwner) return undefined;
  return queueActorDamageMutation(actor.uuid, async freshActor => {
    if (!freshActor?.isOwner) return undefined;

    await deleteDamageStateItems(freshActor);
    await deleteDamageSystemEffects(freshActor);
    const updates = buildFullDamageRestoreUpdate(freshActor);
    if (Object.keys(updates).length) await freshActor.update(updates, { falloutMawSkipDamageStatusSync: true });
    const prosthesisUpdates = buildFullProsthesisRestoreUpdates(freshActor);
    if (prosthesisUpdates.length) await freshActor.updateEmbeddedDocuments("Item", prosthesisUpdates);
    await queueActorDamageStatusSync(freshActor);
    return freshActor;
  });
}

/**
 * Reverse health paid as a system resource cost without treating the reversal as healing.
 * This bypasses healing blocks, healing modifiers, and trauma healing caps while preserving
 * the normal aggregate-health distribution across limbs and integrated prostheses.
 */
export async function restoreActorHealthCost(actor, amount = 0, { chainRef = null } = {}) {
  const requested = Math.max(0, roundDamageAmount(amount));
  if (!actor?.isOwner || requested <= 0) {
    return { actor, requested, healthDelta: 0 };
  }
  return queueActorDamageMutation(actor.uuid, async freshActor => {
    if (!freshActor?.isOwner) return { actor: freshActor ?? actor, requested, healthDelta: 0 };
    if (isIndependentHealthModelActive(freshActor)) {
      const health = createIndependentHealthState(freshActor.system?.resources?.health);
      const healthDelta = applyIndependentHealthChange(health, requested, MODE_HEALING);
      if (healthDelta > 0) {
        await freshActor.update(buildIndependentHealthUpdate(health), {
          falloutMawSkipDamageStatusSync: true,
          falloutMawHealthCostRollback: true,
          ...(chainRef ? { chainRef, falloutMawSystemEventChainRef: chainRef } : {})
        });
      }
      await queueActorDamageStatusSync(freshActor);
      return { actor: freshActor, requested, healthDelta, limbDelta: 0 };
    }
    const result = await calculateManualAggregateHealthAdjustment(
      freshActor,
      requested,
      MODE_HEALING,
      { ignoreHealingCaps: true }
    );
    const updates = {};
    for (const [limbKey, state] of result.limbStates ?? []) {
      if (!state?.totalDelta) continue;
      setLimbValueUpdate(updates, freshActor, limbKey, state.nextValue);
    }
    for (const [limbKey, accumulation] of result.damageAccumulation ?? []) {
      updates[`system.limbs.${limbKey}.damageAccumulation`] = replaceDamageAccumulation(accumulation);
    }
    if (Object.keys(updates).length) {
      await freshActor.update(updates, {
        falloutMawSkipDamageStatusSync: true,
        falloutMawHealthCostRollback: true,
        ...(chainRef ? { chainRef, falloutMawSystemEventChainRef: chainRef } : {})
      });
    }
    if (result.prosthesisHealthAdjustments?.length) {
      await applyManualProsthesisHealthAdjustments(freshActor, result.prosthesisHealthAdjustments);
    }
    await queueActorDamageStatusSync(freshActor);
    return { ...result, actor: freshActor, requested };
  });
}

export function getDamageCostModifierState(actor, { actionKey = "" } = {}) {
  const effectSnapshot = createActorEffectSnapshot(actor);
  return {
    movement: collectCostModifier(actor, COST_EFFECT_KEYS.movement, { effectSnapshot }),
    action: getActionCostModifierState(actor, { actionKey, effectSnapshot })
  };
}

export function getActionCostModifierState(actor, { actionKey = "", effectSnapshot = null } = {}) {
  const snapshot = effectSnapshot ?? createActorEffectSnapshot(actor);
  return mergeCostModifiers(
    collectCostModifier(actor, COST_EFFECT_KEYS.action, { effectSnapshot: snapshot }),
    collectCostModifier(actor, COST_EFFECT_KEYS.actions[String(actionKey ?? "").trim()], {
      effectSnapshot: snapshot
    })
  );
}

export async function prepareActorDamageUpdate(actor, changes = {}, options = {}) {
  captureActorVitalStatusSnapshot(actor, changes, options);
  normalizeIndependentHealthValueUpdate(actor, changes);
  const manualHealthAdjusted = !options?.falloutMawSkipDamageStatusSync
    && await distributeManualHealthValueUpdate(actor, changes);
  const manuallyRestoredHealth = synchronizeManualLimbValueUpdates(actor, changes);
  if (
    !options?.falloutMawSkipDamageStatusSync
    && !manualHealthAdjusted
    && manuallyRestoredHealth > 0
  ) {
    mergeConsciousnessRecoveryUpdate(changes, actor, manuallyRestoredHealth);
  }
  const consciousnessValuePath = `system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.value`;
  if (hasUpdatePath(changes, consciousnessValuePath)) {
    mergeConsciousnessValueUpdate(
      changes,
      actor,
      getUpdatePath(changes, consciousnessValuePath)
    );
  }
  return preventCriticalLimbHealthRecovery(actor, changes);
}

export function prepareItemDamageUpdate(item, changes = {}, options = {}, { operation = "update" } = {}) {
  if (
    options?.falloutMawSkipConsciousnessRecovery
    || options?.falloutMawConstructPartConditionSync
  ) return 0;

  const actor = item?.parent;
  if (isIndependentHealthModelActive(actor)) return 0;
  const actorUuid = String(actor?.uuid ?? "").trim();
  if (!actorUuid || !itemMutationMayChangeAggregateHealth(item, changes, operation)) return 0;

  const snapshots = options[ITEM_ACTOR_HEALTH_SNAPSHOT_OPTION] ??= {};
  snapshots[actorUuid] ??= {
    value: Math.max(0, roundDamageAmount(actor?.system?.resources?.health?.value)),
    consumed: false
  };
  return snapshots[actorUuid].value;
}

export function handleActorDamageUpdate(actor, changes = {}, options = {}) {
  if (!canApplyDamageLocally(actor)) return undefined;
  if (!options?.falloutMawLimbCapSync) void synchronizeActorLimbValueCaps(actor);
  if (options?.falloutMawSkipDamageStatusSync) return undefined;
  const directlyRelevant = isDamageStatusUpdateRelevant(changes);
  const derivedRelevant = isDerivedVitalStatusUpdateRelevant(changes);
  if (!directlyRelevant && !derivedRelevant) return undefined;
  const restoredDerivedHealth = getActorDerivedHealthRecovery(actor, changes, options);
  if (restoredDerivedHealth > 0) {
    return recoverConsciousnessFromDerivedHealth(actor, restoredDerivedHealth, options);
  }
  if (
    !directlyRelevant
    && derivedRelevant
    && !hasActorVitalStatusTransition(actor, options)
  ) return undefined;
  return queueActorDamageStatusSync(actor);
}

export function handleItemDamageUpdate(item, changes = {}, options = {}) {
  if (isTraumaCapUpdateRelevant(item, changes, options)) void synchronizeActorLimbValueCaps(item.parent);
  const actor = item?.parent;
  const restoredHealth = consumeItemActorHealthRecovery(actor, options);
  const consciousness = actor?.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY];
  const consciousnessRecoveryRequired = restoredHealth > 0
    && calculateConsciousnessRecoveryValue(consciousness, restoredHealth) !== toInteger(consciousness?.value);
  const constructPartChanged = !options?.falloutMawConstructPartConditionSync
    && isConstructPartConditionUpdateRelevant(item, changes);
  const prosthesisVitalStatusChanged = isProsthesisVitalStatusUpdateRelevant(item, changes);
  if (!consciousnessRecoveryRequired && !constructPartChanged && !prosthesisVitalStatusChanged) {
    return undefined;
  }
  if (!canApplyDamageLocally(actor)) return undefined;

  const actorUuid = actor?.uuid;
  const itemId = item?.id;
  if (!actorUuid || !itemId) return undefined;

  return queueActorDamageMutation(actorUuid, async freshActor => {
    const freshItem = freshActor?.items?.get?.(itemId);
    let consciousnessThresholdChanged = false;

    if (consciousnessRecoveryRequired) {
      const updateData = {};
      mergeConsciousnessRecoveryUpdate(updateData, freshActor, restoredHealth);
      if (Object.keys(updateData).length) {
        consciousnessThresholdChanged = hasConsciousnessThresholdTransition(freshActor, updateData);
        await freshActor.update(updateData, {
          falloutMawSkipDamageStatusSync: true,
          falloutMawConsciousnessStateSync: true
        });
      }
    }

    if (constructPartChanged) {
      const limbKey = getConstructPartLimbKey(getConstructPartSlotId(freshItem ?? item));
      if (limbKey) {
        if (!freshItem || isConstructPartDestroyed(freshItem)) {
          await applyDestroyedLimbConsequencesNow(freshActor, [limbKey]);
        } else {
          await deleteLimbTraumas(freshActor, limbKey);
          await deleteLimbLossEffects(freshActor, limbKey);
          await deleteLimbTimedDamageEffects(freshActor, limbKey);
        }
      }
    }
    if (!consciousnessThresholdChanged && !constructPartChanged && !prosthesisVitalStatusChanged) {
      return freshActor;
    }
    await queueActorDamageStatusSync(freshActor);
    return freshActor;
  });
}

export function applyDamageCostModifier(baseCost = 0, modifier = {}) {
  let cost = Math.max(0, Number(baseCost) || 0);
  const hasOverride = modifier?.override !== null && modifier?.override !== undefined && modifier?.override !== "";
  const override = hasOverride ? Number(modifier.override) : NaN;
  if (Number.isFinite(override)) cost = override;
  const multiplier = Number(modifier?.multiplier);
  cost *= Number.isFinite(multiplier) ? multiplier : 1;
  cost += Number(modifier?.add) || 0;
  return Math.max(0, Math.ceil(cost));
}

export function getActorHealingModifierPercent(actor, direction = "incoming", context = {}) {
  const key = direction === "outgoing" ? "outgoingPercent" : "incomingPercent";
  return toInteger(getContextualAbilityChangeValue(actor, `system.healing.${key}`, {
    ...context,
    baseValue: toInteger(actor?.system?.healing?.[key])
  }));
}

export function applyHealingModifierPercent(amount = 0, percent = 0) {
  const value = Math.max(0, Number(amount) || 0);
  if (!value) return 0;
  return roundDamageAmount(value * Math.max(0, 1 + (toInteger(percent) / 100)));
}

function preventCriticalLimbHealthRecovery(actor, changes = {}) {
  const healthValuePath = "system.resources.health.value";
  if (!hasUpdatePath(changes, healthValuePath)) return false;
  if (!hasDestroyedCriticalLimbAfterUpdate(actor, changes)) return false;

  const current = toInteger(actor?.system?.resources?.health?.value);
  const requested = toInteger(getUpdatePath(changes, healthValuePath));
  if (requested <= current) return false;

  setUpdatePath(changes, healthValuePath, current);
  return true;
}

function hasDestroyedCriticalLimbAfterUpdate(actor, changes = {}) {
  const limbHealthContext = buildActorLimbHealthContext(actor);
  let combatSettings = null;
  for (const [key, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    const critical = isCriticalLimb(actor, key) || Boolean(getUpdatePath(changes, `system.limbs.${key}.critical`) ?? limb?.critical);
    if (!critical) continue;
    if (hasInstalledProsthesis(actor, key, limbHealthContext)) continue;

    const missing = Boolean(getUpdatePath(changes, `system.limbs.${key}.missing`) ?? limb?.missing);
    if (missing) return true;
    const min = toInteger(getUpdatePath(changes, `system.limbs.${key}.min`) ?? limb?.min);
    const value = toInteger(getUpdatePath(changes, `system.limbs.${key}.value`) ?? limb?.value);
    if (
      value <= min
      && (
        isConstructPartLimb(actor, key)
        || canActorLimbBeAutomaticallyDestroyed(
          actor,
          { critical: true },
          combatSettings ??= getCombatSettings()
        )
      )
    ) return true;
  }
  return false;
}

function isDamageStatusUpdateRelevant(changes = {}) {
  return hasUpdatePath(changes, "system.resources.health.value")
    || hasUpdatePath(changes, `system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.value`)
    || updateTouchesPath(changes, "system.limbs");
}

function isDerivedVitalStatusUpdateRelevant(changes = {}) {
  return updateTouchesPath(changes, "system.characteristics")
    || updateTouchesPath(changes, "system.skills")
    || updateTouchesPath(changes, "system.development.characteristics")
    || updateTouchesPath(changes, "system.development.skills")
    || updateTouchesPath(changes, "system.creature.raceId")
    || updateTouchesPath(changes, "system.constructPartSlots")
    || updateTouchesPath(changes, `system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.bonus`)
    || updateTouchesPath(changes, `system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.spent`)
    || updateTouchesPath(changes, CONSCIOUSNESS_RECOVERY_TARGET_PATH);
}

function captureActorVitalStatusSnapshot(actor, changes = {}, options = {}) {
  if (
    options?.falloutMawSkipDamageStatusSync
    || !isDerivedVitalStatusUpdateRelevant(changes)
  ) return;

  const actorUuid = String(actor?.uuid ?? "").trim();
  if (!actorUuid) return;
  const snapshots = options[ACTOR_VITAL_STATUS_SNAPSHOTS_OPTION] ??= {};
  snapshots[actorUuid] ??= {
    dead: isActorHealthDepleted(actor) || hasDestroyedCriticalLimb(actor),
    unconscious: isActorConsciousnessDepleted(actor),
    healthValue: Math.max(0, roundDamageAmount(actor?.system?.resources?.health?.value)),
    consciousnessValue: toInteger(actor?.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY]?.value)
  };
}

function hasActorVitalStatusTransition(actor, options = {}) {
  const actorUuid = String(actor?.uuid ?? "").trim();
  const snapshot = options?.[ACTOR_VITAL_STATUS_SNAPSHOTS_OPTION]?.[actorUuid];
  if (!snapshot) return true;
  return snapshot.dead !== (isActorHealthDepleted(actor) || hasDestroyedCriticalLimb(actor))
    || snapshot.unconscious !== isActorConsciousnessDepleted(actor);
}

function getActorDerivedHealthRecovery(actor, changes = {}, options = {}) {
  if (!isConsciousnessRulesEnabled(actor)) return 0;
  if (
    !isDerivedVitalStatusUpdateRelevant(changes)
    || hasUpdatePath(changes, "system.resources.health.value")
    || hasUpdatePath(changes, `system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.value`)
  ) return 0;

  const actorUuid = String(actor?.uuid ?? "").trim();
  const snapshot = options?.[ACTOR_VITAL_STATUS_SNAPSHOTS_OPTION]?.[actorUuid];
  if (!snapshot) return 0;
  const current = Math.max(0, roundDamageAmount(actor?.system?.resources?.health?.value));
  return Math.max(0, current - Math.max(0, roundDamageAmount(snapshot.healthValue)));
}

function recoverConsciousnessFromDerivedHealth(actor, restoredHealth = 0, options = {}) {
  if (!isConsciousnessRulesEnabled(actor)) return undefined;
  const actorUuid = String(actor?.uuid ?? "").trim();
  if (!actorUuid) return undefined;
  const snapshot = options?.[ACTOR_VITAL_STATUS_SNAPSHOTS_OPTION]?.[actorUuid];

  return queueActorDamageMutation(actorUuid, async freshActor => {
    const resource = freshActor?.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY];
    const requestedValue = toInteger(snapshot?.consciousnessValue) + restoredHealth;
    const valueData = buildConsciousnessUpdateData(resource, requestedValue);
    if (
      valueData
      && (
        valueData.value !== toInteger(resource?.value)
        || valueData.spent !== toInteger(resource?.spent)
      )
    ) {
      await freshActor.update({
        [`system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.value`]: valueData.value,
        [`system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.spent`]: valueData.spent,
        [CONSCIOUSNESS_RECOVERY_TARGET_PATH]: valueData.recoveryTarget
      }, {
        falloutMawSkipDamageStatusSync: true,
        falloutMawConsciousnessStateSync: true
      });
    }
    await queueActorDamageStatusSync(freshActor);
    return freshActor;
  });
}

function queueActorDamageStatusSync(actor) {
  const actorUuid = actor?.uuid;
  if (!actorUuid) return undefined;

  const pending = actorDamageStatusSyncQueue.get(actorUuid);
  if (pending) {
    pending.actor = actor;
    pending.requested = true;
    return pending.promise;
  }

  const state = { actor, requested: true, promise: null };
  state.promise = Promise.resolve()
    .then(async () => {
      do {
        state.requested = false;
        const freshActor = fromUuidSync(actorUuid) ?? state.actor;
        await synchronizeActorVitalStatuses(freshActor);
      } while (state.requested);
    })
    .finally(() => {
      if (actorDamageStatusSyncQueue.get(actorUuid) === state) actorDamageStatusSyncQueue.delete(actorUuid);
    });
  actorDamageStatusSyncQueue.set(actorUuid, state);
  return state.promise;
}

function queueActorDamageMutation(actorOrUuid, operation) {
  const actorUuid = typeof actorOrUuid === "string" ? actorOrUuid : actorOrUuid?.uuid;
  if (!actorUuid) return operation(null);
  const operationContext = activeDamageHubOperation;
  if (operationContext?.reentrantDepth > 0 && operationContext.mutatingActorUuids?.has(actorUuid)) {
    return Promise.resolve().then(() => operation(fromUuidSync(actorUuid)));
  }

  const previous = actorDamageMutationQueue.get(actorUuid) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      operationContext?.mutatingActorUuids?.add(actorUuid);
      try {
        return await operation(fromUuidSync(actorUuid));
      } finally {
        operationContext?.mutatingActorUuids?.delete(actorUuid);
      }
    })
    .finally(() => {
      if (actorDamageMutationQueue.get(actorUuid) === next) actorDamageMutationQueue.delete(actorUuid);
    });
  actorDamageMutationQueue.set(actorUuid, next);
  return next;
}

export async function runDamageHubOperation(operation, { operationRef = "" } = {}) {
  const requestedRef = String(operationRef ?? "").trim();
  // Damage may trigger an awaited check whose chosen reaction deals damage before the parent operation can finish.
  // Only the opaque reference issued by that active operation may enter it recursively; unrelated damage stays queued.
  if (requestedRef && activeDamageHubOperation?.id === requestedRef) {
    const operationContext = activeDamageHubOperation;
    operationContext.reentrantDepth += 1;
    try {
      return await operation(operationContext);
    } finally {
      operationContext.reentrantDepth = Math.max(0, operationContext.reentrantDepth - 1);
    }
  }

  const previous = damageHubOperationQueue.catch(() => undefined);
  let releaseQueuedOperation;
  const queuedOperation = new Promise(resolve => {
    releaseQueuedOperation = resolve;
  });
  damageHubOperationQueue = previous.then(() => queuedOperation);
  await previous;
  const operationContext = {
    id: foundry.utils.randomID(),
    reentrantDepth: 0,
    mutatingActorUuids: new Set()
  };
  activeDamageHubOperation = operationContext;

  try {
    return await operation(operationContext);
  } finally {
    if (activeDamageHubOperation === operationContext) activeDamageHubOperation = null;
    releaseQueuedOperation();
  }
}

export function getCurrentDamageHubOperationRef() {
  return String(activeDamageHubOperation?.id ?? "");
}

function getDamageHubOperationRefFromRequests(requests = []) {
  for (const request of Array.isArray(requests) ? requests : [requests]) {
    const ref = String(request?.source?.damageHubOperationRef ?? "").trim();
    if (ref) return ref;
  }
  return "";
}

export async function applyDestroyedLimbConsequences(actor, limbKeys = [], options = {}) {
  const result = await applyDestroyedLimbConsequencesNow(actor, limbKeys, options);
  await queueActorDamageStatusSync(actor);
  return result;
}

async function applyDestroyedLimbConsequencesNow(actor, limbKeys = [], { ignoreInstalledProsthesis = false } = {}) {
  const destroyed = new Set();
  const missingUpdates = {};
  const destroyedLimbKeys = [];
  const limbLossEffectData = [];
  const limbHealthContext = buildActorLimbHealthContext(actor);
  let combatSettings = null;
  let limbDestructionMode = null;
  for (const limbKey of Array.from(new Set(limbKeys.filter(Boolean)))) {
    const limb = actor?.system?.limbs?.[limbKey];
    if (!limb) continue;
    const constructSlot = getConstructPartSlotForLimb(actor, limbKey);
    const constructPart = getConstructPartItemForLimb(actor, limbKey);
    const missing = constructSlot
      ? !constructPart || isConstructPartDestroyed(constructPart)
      : isLimbPhysicallyMissing(actor, limbKey);
    const reachedDestruction = constructSlot ? missing : toInteger(limb.value) <= toInteger(limb.min);
    if (!missing && !reachedDestruction) continue;
    if (
      !missing
      && !constructSlot
      && !canActorLimbBeAutomaticallyDestroyed(
        actor,
        {
          critical: isCriticalLimb(actor, limbKey),
          mode: limbDestructionMode ??= getActorLimbDestructionMode(
            actor,
            combatSettings ??= getCombatSettings()
          )
        },
        combatSettings
      )
    ) continue;
    destroyed.add(limbKey);
    destroyedLimbKeys.push(limbKey);
    if (!missing) missingUpdates[`system.limbs.${limbKey}.missing`] = true;
    if (!ignoreInstalledProsthesis && hasInstalledProsthesis(actor, limbKey, limbHealthContext)) continue;
    if (!isCriticalLimb(actor, limbKey)) {
      const effectData = prepareLimbLossEffectData(actor, limbKey);
      if (effectData) limbLossEffectData.push(effectData);
    }
  }
  if (Object.keys(missingUpdates).length) await actor.update(missingUpdates, { falloutMawSkipDamageStatusSync: true });
  if (destroyedLimbKeys.length) {
    await deleteLimbTraumasBatch(actor, destroyedLimbKeys);
    await deleteLimbLossEffectsBatch(actor, destroyedLimbKeys);
    await deleteLimbTimedDamageEffectsBatch(actor, destroyedLimbKeys);
  }
  if (limbLossEffectData.length) await actor.createEmbeddedDocuments("ActiveEffect", limbLossEffectData, { animate: false });
  return destroyed;
}

async function deleteLimbTraumas(actor, limbKey = "") {
  const ids = getActorTraumas(actor)
    .filter(item => item.system?.limbKey === limbKey)
    .map(item => item.id)
    .filter(Boolean);
  await deleteActorItems(actor, ids);
}

async function deleteLimbTraumasBatch(actor, limbKeys = []) {
  const keys = new Set(limbKeys.filter(Boolean));
  if (!keys.size) return [];
  const ids = getActorTraumas(actor)
    .filter(item => keys.has(item.system?.limbKey))
    .map(item => item.id)
    .filter(Boolean);
  return deleteActorItems(actor, ids);
}

async function deleteLimbLossEffects(actor, limbKey = "") {
  const ids = Array.from(actor?.effects ?? [])
    .filter(effect => {
      return getDamageEffectChanges(effect).some(data => data.kind === LIMB_LOSS_EFFECT_KIND && data.limbKey === limbKey);
    })
    .map(effect => effect.id)
    .filter(Boolean);
  await deleteActorActiveEffects(actor, ids);
}

async function deleteLimbLossEffectsBatch(actor, limbKeys = []) {
  const keys = new Set(limbKeys.filter(Boolean));
  if (!keys.size) return [];
  const ids = Array.from(actor?.effects ?? [])
    .filter(effect => getDamageEffectChanges(effect).some(data => data.kind === LIMB_LOSS_EFFECT_KIND && keys.has(data.limbKey)))
    .map(effect => effect.id)
    .filter(Boolean);
  return deleteActorActiveEffects(actor, ids);
}

async function deleteLimbTimedDamageEffects(actor, limbKey = "") {
  const key = String(limbKey ?? "").trim();
  if (!key) return [];
  return removeDamageEffectChanges(actor, data => isLimbTimedDamageEffect(data) && data.limbKey === key);
}

async function deleteLimbTimedDamageEffectsBatch(actor, limbKeys = []) {
  const keys = new Set(limbKeys.filter(Boolean));
  if (!keys.size) return [];
  const results = await removeDamageEffectChanges(actor, data => isLimbTimedDamageEffect(data) && keys.has(data.limbKey));
  return results;
}

async function deleteDamageStateItems(actor) {
  const ids = Array.from(actor?.items ?? [])
    .filter(item => item.type === "trauma" || item.type === "disease")
    .map(item => item.id)
    .filter(Boolean);
  await deleteActorItems(actor, ids);
}

async function deleteDamageSystemEffects(actor) {
  const ids = Array.from(actor?.effects ?? [])
    .filter(effect => isDamageSystemEffect(effect))
    .map(effect => effect.id)
    .filter(Boolean);
  await deleteActorActiveEffects(actor, ids);
}

async function deleteActorItems(actor, itemIds = []) {
  const ids = Array.from(new Set(itemIds)).filter(id => actor?.items?.has(id));
  if (!ids.length) return [];
  return actor.deleteEmbeddedDocuments("Item", ids.filter(id => actor.items?.has(id)), { animate: false });
}

async function deleteActorActiveEffects(actor, effectIds = []) {
  const ids = Array.from(new Set(effectIds)).filter(id => actor?.effects?.has(id));
  if (!ids.length) return [];
  try {
    return await actor.deleteEmbeddedDocuments("ActiveEffect", ids.filter(id => actor.effects?.has(id)), {
      animate: false,
      falloutMawAllowManagedTimedDamageExpiration: true
    });
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
    return [];
  }
}

async function removeDamageEffectChanges(actor, predicate) {
  const deleteIds = [];
  const updates = [];
  const results = [];

  for (const effect of Array.from(actor?.effects ?? [])) {
    const changes = getEffectChangeSource(effect);
    const damageChanges = getDamageEffectChanges(effect);
    if (!changes.length || !damageChanges.length) continue;

    const removeIndexes = new Set(
      damageChanges
        .filter(data => predicate(data, effect))
        .map(data => data.changeIndex)
    );
    if (!removeIndexes.size) continue;

    const remainingChanges = changes.filter((_change, index) => !removeIndexes.has(index));
    const remainingDamageChanges = remainingChanges
      .map((change, index) => parseDamageEffectChange(change, index))
      .filter(Boolean);

    results.push({ effectId: effect.id, removed: removeIndexes.size });
    if (!remainingDamageChanges.length && changes.every((change, index) => removeIndexes.has(index) || parseDamageEffectChange(change, index))) {
      deleteIds.push(effect.id);
    } else {
      updates.push({ effect, changes: remainingChanges });
    }
  }

  for (const update of updates) await updatePeriodicEffect(update.effect, { "system.changes": update.changes });
  await deleteActorActiveEffects(actor, deleteIds);
  return results;
}

function isDamageSystemEffect(effect) {
  if (!effect) return false;
  const flags = effect.flags?.[SYSTEM_ID] ?? effect.flags?.[TRAUMA_FLAG_SCOPE] ?? {};
  const flagKind = flags[DAMAGE_EFFECT_FLAG_KEY]?.kind;
  const flagManaged = flagKind === "resourceLimit"
    || flagKind === "resourceBlock"
    || flagKind === RESISTANCE_OVERHEAT_EFFECT_KIND;
  return Boolean(getDamageEffectChanges(effect).length || flagManaged);
}

function getEffectChangeSource(effect) {
  const changes = effect?.system?.changes ?? effect?.changes ?? [];
  return Array.isArray(changes) ? changes : [];
}

function getDamageEffectChanges(effect) {
  return getEffectChangeSource(effect)
    .map((change, index) => parseDamageEffectChange(change, index))
    .filter(Boolean);
}

function parseDamageEffectChange(change, index = 0) {
  const key = String(change?.key ?? "").trim();
  if (!key.startsWith(`${DAMAGE_EFFECT_CHANGE_ROOT}.`)) return null;
  const data = parseDamageEffectChangeValue(change?.value);
  if (!data) return null;
  return {
    ...data,
    key,
    changeIndex: index
  };
}

function parseDamageEffectChangeValue(value) {
  if (foundry.utils.isPlainObject(value)) return foundry.utils.deepClone(value);
  if (typeof value !== "string") return null;
  try {
    const data = JSON.parse(value);
    return foundry.utils.isPlainObject(data) ? data : null;
  } catch (_error) {
    return null;
  }
}

function createDamageEffectChange(key, data = {}) {
  return {
    key,
    type: DAMAGE_EFFECT_CHANGE_TYPE,
    value: JSON.stringify(data),
    phase: "initial",
    priority: 0
  };
}

function buildDamageEffectChangeKey(kind, ...segments) {
  const path = [DAMAGE_EFFECT_CHANGE_ROOT, normalizeDamageEffectKeySegment(kind, "effect")];
  for (const segment of segments) path.push(normalizeDamageEffectKeySegment(segment, "any"));
  return path.join(".");
}

function getPeriodicDamageSourceIdentity(source = {}) {
  return [source?.damagePacketId, source?.conditionWearPacketId]
    .map(value => String(value ?? "").trim())
    .find(Boolean) ?? "";
}

function normalizeDamageEffectKeySegment(value, fallback = "any") {
  const text = String(value ?? "").trim();
  return (text || fallback).replace(/[^A-Za-z0-9_-]/g, "_");
}

function serializeDamageEffectChangeData(data = {}) {
  const copy = foundry.utils.deepClone(data);
  delete copy.key;
  delete copy.changeIndex;
  return JSON.stringify(copy);
}

async function upsertManagedTimedDamageEffect(actor, effectData = {}, kinds = []) {
  const newChanges = getDamageEffectChanges(effectData).filter(data => kinds.includes(data.kind));
  if (!newChanges.length) return actor.createEmbeddedDocuments("ActiveEffect", [effectData], getDamageActiveEffectOperationOptions());

  const existing = findStackableManagedTimedDamageEffect(actor, effectData, newChanges, kinds);
  if (!existing) return actor.createEmbeddedDocuments("ActiveEffect", [effectData], getDamageActiveEffectOperationOptions());

  const mergedChanges = mergeManagedTimedDamageEffectChanges(
    getEffectChangeSource(existing),
    getEffectChangeSource(effectData),
    kinds
  );
  await updatePeriodicEffect(existing, { "system.changes": mergedChanges });
  return [existing];
}

function findStackableManagedTimedDamageEffect(actor, effectData = {}, newChanges = [], kinds = []) {
  const newDuration = getManagedTimedDamageEffectDuration(newChanges);
  if (!newDuration) return null;
  const newName = String(effectData.name ?? "");
  const newImg = String(effectData.img ?? "");

  return Array.from(actor?.effects ?? []).find(effect => {
    if (effect.disabled || !effect.getFlag?.(TRAUMA_FLAG_SCOPE, MANAGED_TIMED_DAMAGE_FLAG_KEY)) return false;
    if (String(effect.name ?? "") !== newName || String(effect.img ?? "") !== newImg) return false;
    const existingChanges = getDamageEffectChanges(effect).filter(data => kinds.includes(data.kind));
    if (!existingChanges.length) return false;
    if (!isManagedTimedDamageEffectAtFullDuration(existingChanges)) return false;
    return getManagedTimedDamageEffectDuration(existingChanges) === newDuration;
  }) ?? null;
}

function getManagedTimedDamageEffectDuration(changes = []) {
  const durations = new Set(changes.map(getManagedTimedDamageChangeDuration).filter(Boolean));
  return durations.size === 1 ? Array.from(durations)[0] : 0;
}

function getManagedTimedDamageChangeDuration(data = {}) {
  const intervalSeconds = Math.max(1, toInteger(data.intervalSeconds || ROUND_SECONDS));
  const totalTicks = Math.max(0, toInteger(data.totalTicks));
  if (totalTicks > 0) return intervalSeconds * totalTicks;
  const startTime = Number(data.startTime);
  const endTime = Number(data.endTime);
  return Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime
    ? Math.round(endTime - startTime)
    : 0;
}

function isManagedTimedDamageEffectAtFullDuration(changes = []) {
  return changes.every(data => Math.max(0, toInteger(data.remainingTicks)) === Math.max(0, toInteger(data.totalTicks)));
}

function mergeManagedTimedDamageEffectChanges(existingChanges = [], newChanges = [], kinds = []) {
  const mergedChanges = [...existingChanges];
  const existingDamageChanges = getDamageChangesFromChangeSource(existingChanges).filter(data => kinds.includes(data.kind));

  for (const newChange of getDamageChangesFromChangeSource(newChanges).filter(data => kinds.includes(data.kind))) {
    const existing = existingDamageChanges.find(data => (
      data.key === newChange.key
      && data.kind === newChange.kind
      && (
        data.kind !== PERIODIC_DAMAGE_EFFECT_KIND
        || String(data.sourceIdentity ?? "") === String(newChange.sourceIdentity ?? "")
      )
    ));
    if (!existing) {
      mergedChanges.push(newChanges[newChange.changeIndex]);
      existingDamageChanges.push({ ...newChange, changeIndex: mergedChanges.length - 1 });
      continue;
    }

    const mergedData = mergeManagedTimedDamageChangeData(existing, newChange);
    mergedChanges[existing.changeIndex] = {
      ...mergedChanges[existing.changeIndex],
      value: serializeDamageEffectChangeData(mergedData)
    };
    Object.assign(existing, mergedData);
  }

  return mergedChanges;
}

function getDamageChangesFromChangeSource(changes = []) {
  return (Array.isArray(changes) ? changes : [])
    .map((change, index) => parseDamageEffectChange(change, index))
    .filter(Boolean);
}

function mergeManagedTimedDamageChangeData(existing = {}, incoming = {}) {
  if (existing.kind === BLEEDING_DAMAGE_EFFECT_KIND) {
    return {
      ...existing,
      sourceDamageTypeKey: existing.sourceDamageTypeKey === incoming.sourceDamageTypeKey ? existing.sourceDamageTypeKey : "",
      tickAmounts: sumTickAmounts(existing.tickAmounts, incoming.tickAmounts),
      totalTicks: Math.max(toInteger(existing.totalTicks), toInteger(incoming.totalTicks)),
      remainingTicks: Math.max(toInteger(existing.remainingTicks), toInteger(incoming.remainingTicks)),
      source: combineDamageEffectSources(existing.source, incoming.source)
    };
  }

  return {
    ...existing,
    amountPerTick: roundDamageAmount((Number(existing.amountPerTick) || 0) + (Number(incoming.amountPerTick) || 0)),
    source: existing.source
  };
}

function buildFullDamageRestoreUpdate(actor) {
  const updates = {};
  if (isIndependentHealthModelActive(actor)) {
    const health = createIndependentHealthState(actor.system?.resources?.health);
    health.value = health.max;
    Object.assign(updates, buildIndependentHealthUpdate(health));
  }
  for (const [key, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    if (getConstructPartSlotForLimb(actor, key)) continue;
    const max = Math.max(0, toInteger(limb?.max));
    updates[`system.limbs.${key}.missing`] = false;
    updates[`system.limbs.${key}.value`] = max;
    updates[`system.limbs.${key}.spent`] = 0;
    updates[`system.limbs.${key}.damageAccumulation`] = replaceDamageAccumulation();
  }
  for (const [key, resource] of Object.entries(actor?.system?.resources ?? {})) {
    if (key === "health") continue;
    const max = Math.max(Math.max(0, toInteger(resource?.min)), toInteger(resource?.max));
    updates[`system.resources.${key}.value`] = max;
    updates[`system.resources.${key}.spent`] = 0;
  }
  for (const [key, need] of Object.entries(actor?.system?.needs ?? {})) {
    const min = Math.max(0, toInteger(need?.min));
    updates[`system.needs.${key}.value`] = min;
    updates[`system.needs.${key}.spent`] = 0;
  }
  return updates;
}

function buildFullProsthesisRestoreUpdates(actor) {
  const updates = [];
  for (const item of actor?.items ?? []) {
    if (!isFullRestoreConditionBypassItem(item)) continue;
    if (!hasItemFunction(item, ITEM_FUNCTIONS.condition)) continue;
    const condition = getConditionFunction(item);
    const max = Math.max(0, toInteger(condition.max));
    const current = Math.max(0, toInteger(condition.value));
    if (current >= max) continue;
    updates.push({
      _id: item.id,
      "system.functions.condition.value": max
    });
  }
  return updates;
}

function isFullRestoreConditionBypassItem(item) {
  if (item?.type !== "gear") return false;
  const placementMode = String(item.system?.placement?.mode ?? "");
  if (
    item.system?.equipped
    && hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
    && placementMode === "prosthesis"
    && String(item.system?.placement?.limbKey ?? "").trim()
  ) return true;
  return Boolean(
    hasItemFunction(item, ITEM_FUNCTIONS.constructPart)
    && placementMode === ITEM_FUNCTIONS.constructPart
  );
}

async function createLimbLossEffect(actor, limbKey = "") {
  const effectData = prepareLimbLossEffectData(actor, limbKey);
  if (!effectData) return [];
  return actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
}

function prepareLimbLossEffectData(actor, limbKey = "") {
  const limb = actor?.system?.limbs?.[limbKey];
  const effectEntries = getLimbLossEffects(actor, limbKey).map(prepareEffectChange).filter(change => change.key);
  const { changes, statuses } = splitSpecialEffectChanges(effectEntries);
  if (!changes.length && !statuses.length) return null;

  const label = String(limb?.label ?? limbKey);
  changes.unshift(createDamageEffectChange(
    buildDamageEffectChangeKey("limbLoss", limbKey),
    { kind: LIMB_LOSS_EFFECT_KIND, limbKey }
  ));
  return {
    type: "base",
    name: `${label}: ${getDestroyedLimbStateLabel(actor, limbKey).toLocaleLowerCase(game.i18n?.lang ?? "ru")}`,
    img: "icons/svg/blood.svg",
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    statuses,
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "active"
      }
    },
    system: { changes }
  };
}

function getLimbLossEffects(actor, limbKey = "") {
  const limbSettings = getActorLimbSettings(actor, limbKey);
  if (limbSettings?.critical) return [];
  return Array.isArray(limbSettings?.lossEffects)
    ? limbSettings.lossEffects.map(effect => ({ ...effect }))
    : [];
}

function getActorLimbSettings(actor, limbKey = "") {
  const constructSlot = getConstructPartSlotForLimb(actor, limbKey);
  const constructPart = getConstructPartItemForLimb(actor, limbKey);
  if (constructSlot) {
    const part = constructPart
      ? getConstructPartFunction(constructPart)
      : constructSlot.profile?.constructPart ?? {};
    return {
      key: limbKey,
      label: getConstructPartTypeLabel(constructPart ?? constructSlot) || limbKey,
      stateMax: String(
        constructPart?.system?.functions?.condition?.max
        ?? constructSlot.profile?.conditionMax
        ?? actor?.system?.limbs?.[limbKey]?.max
        ?? "0"
      ),
      damageMultiplier: 1,
      aimedDifficultyPercent: toInteger(part.aimedDifficultyPercent),
      aimedDifficultyBonus: toInteger(part.aimedDifficultyBonus),
      critical: Boolean(part.critical),
      lossEffects: normalizeLimbLossEffects(part.lossEffects)
    };
  }
  const race = getPreparedRuntimeSettings().creatureOptions.races.find(entry => entry.id === actor?.system?.creature?.raceId);
  return race?.limbs?.find(limb => limb.key === limbKey) ?? actor?.system?.limbs?.[limbKey] ?? null;
}

async function syncConstructPartConditionValues(actor, limbStates = new Map()) {
  const updates = [];
  for (const [limbKey, state] of limbStates) {
    if (!state?.totalDelta) continue;
    const item = getConstructPartItemForLimb(actor, limbKey);
    if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) continue;
    const condition = getConditionFunction(item);
    const max = Math.max(0, toInteger(condition.max));
    const nextValue = Math.max(0, Math.min(max, toInteger(state.nextValue)));
    if (nextValue === toInteger(condition.value)) continue;
    updates.push({
      _id: item.id,
      "system.functions.condition.value": nextValue
    });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { falloutMawConstructPartConditionSync: true });
}

function getConstructPartItemForLimb(actor, limbKey = "") {
  return getInstalledConstructPartForLimb(actor, limbKey);
}

function isConstructPartLimb(actor, limbKey = "") {
  return Boolean(getConstructPartSlotForLimb(actor, limbKey));
}

function isConstructPartConditionUpdateRelevant(item, changes = {}) {
  if (
    item?.type !== "gear"
    || item.parent?.type !== "construct"
    || (
      !hasItemFunction(item, ITEM_FUNCTIONS.constructPart)
      && !updateTouchesPath(changes, "system.functions.constructPart")
    )
  ) return false;

  return updateTouchesPath(changes, "system.functions.condition")
    || updateTouchesPath(changes, "system.functions.constructPart")
    || updateTouchesPath(changes, "system.equipped")
    || updateTouchesPath(changes, "system.placement");
}

function isProsthesisVitalStatusUpdateRelevant(item, changes = {}) {
  if (
    item?.type !== "gear"
    || !["character", "construct"].includes(item.parent?.type)
    || (
      !hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
      && !updateTouchesPath(changes, "system.functions.prosthesis")
    )
  ) return false;

  return updateTouchesPath(changes, "system.functions.condition")
    || updateTouchesPath(changes, "system.functions.prosthesis")
    || updateTouchesPath(changes, "system.equipped")
    || updateTouchesPath(changes, "system.placement");
}

function itemMutationMayChangeAggregateHealth(item, changes = {}, operation = "update") {
  if (item?.type !== "gear" || !["character", "construct"].includes(item.parent?.type)) return false;
  const healthFunction = hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
    || hasItemFunction(item, ITEM_FUNCTIONS.constructPart);
  if (operation !== "update") return healthFunction;
  if (!healthFunction && !(
    updateTouchesPath(changes, "system.functions.prosthesis")
    || updateTouchesPath(changes, "system.functions.constructPart")
  )) return false;

  return updateTouchesPath(changes, "system.functions.condition")
    || updateTouchesPath(changes, "system.functions.prosthesis")
    || updateTouchesPath(changes, "system.functions.constructPart")
    || updateTouchesPath(changes, "system.equipped")
    || updateTouchesPath(changes, "system.placement");
}

function consumeItemActorHealthRecovery(actor, options = {}) {
  const actorUuid = String(actor?.uuid ?? "").trim();
  const snapshot = options?.[ITEM_ACTOR_HEALTH_SNAPSHOT_OPTION]?.[actorUuid];
  if (!snapshot || snapshot.consumed) return 0;

  snapshot.consumed = true;
  const current = Math.max(0, roundDamageAmount(actor?.system?.resources?.health?.value));
  return Math.max(0, current - Math.max(0, roundDamageAmount(snapshot.value)));
}

function isTraumaCapUpdateRelevant(item, changes = {}, options = {}) {
  if (options?.falloutMawLimbCapSync) return false;
  if (item?.type !== "trauma" || !item.parent) return false;
  return !Object.keys(changes ?? {}).length
    || updateTouchesPath(changes, "system.limbKey")
    || updateTouchesPath(changes, "system.thresholdPercent");
}

function normalizeLimbLossEffects(value = []) {
  const effects = Array.isArray(value) ? value : Object.values(value ?? {});
  return effects
    .map(effect => ({
      key: String(effect?.key ?? "").trim(),
      type: ["add", "multiply", "override"].includes(String(effect?.type ?? "")) ? String(effect.type) : "add",
      value: String(effect?.value ?? "0"),
      phase: String(effect?.phase || "initial"),
      priority: effect?.priority === "" || effect?.priority === null || effect?.priority === undefined
        ? null
        : toInteger(effect.priority)
    }))
    .filter(effect => effect.key);
}

function hasInstalledProsthesis(actor, limbKey = "", context = null) {
  return Boolean(getInstalledProsthesis(actor, limbKey, context));
}

function isLimbTimedDamageBlocked(actor, limbKey = "", damageType = {}, kind = "", context = null) {
  const cache = context?.actor === actor && context.timedDamageBlockedByTarget instanceof Map
    ? context.timedDamageBlockedByTarget
    : null;
  const cacheKey = cache
    ? getDamageBatchPreparationKey(kind, limbKey, damageType?.key)
    : "";
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  let blocked = false;
  const prosthesis = getInstalledProsthesis(
    actor,
    limbKey,
    context ? getDamageBatchProsthesisContext(context, actor) : null
  );
  if (prosthesis) {
    if (kind === "bleeding") blocked = true;
    else if (
      isTimedDamageKeyBlocked(
        getProsthesisFunction(prosthesis).blockedPeriodicEffects,
        damageType,
        kind
      )
    ) blocked = true;
  }
  if (!blocked) {
    const constructPart = getConstructPartItemForLimb(actor, limbKey);
    blocked = Boolean(
      constructPart
      && isTimedDamageKeyBlocked(
        getConstructPartBlockedPeriodicEffects(constructPart),
        damageType,
        kind
      )
    );
  }
  cache?.set(cacheKey, blocked);
  return blocked;
}

function getConstructPartBlockedPeriodicEffects(itemOrData = null) {
  const source = itemOrData?._source?.system?.functions?.constructPart?.blockedPeriodicEffects
    ?? itemOrData?.system?._source?.functions?.constructPart?.blockedPeriodicEffects
    ?? [];
  return Array.isArray(source)
    ? source
    : source && typeof source === "object" ? Object.values(source) : [];
}

function isTimedDamageKeyBlocked(blockedKeys = [], damageType = {}, kind = "") {
  const blocked = new Set((blockedKeys ?? [])
    .map(key => String(key ?? "").trim())
    .filter(Boolean));
  if (!blocked.size) return false;
  if (kind === "bleeding") return blocked.has(BLEEDING_DAMAGE_TYPE_KEY);
  if (kind === "periodic") return blocked.has(String(damageType?.key ?? "").trim());
  return false;
}

function getInstalledProsthesis(actor, limbKey = "", context = null) {
  const key = String(limbKey ?? "").trim();
  if (!key) return null;
  if (isActorProsthesisContextFor(context, actor)) {
    return context.prosthesesByLimb.get(key) ?? null;
  }
  return getActorItemsByType(actor, "gear")
    .find(item => (
      item.system?.equipped
      && hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
      && String(item.system?.placement?.mode ?? "") === "prosthesis"
      && String(item.system?.placement?.limbKey ?? "") === key
    )) ?? null;
}

function getActorItemsByType(actor, type = "") {
  const typed = actor?.itemTypes?.[type];
  if (Array.isArray(typed)) return typed;
  return actor?.items?.filter?.(item => item?.type === type)
    ?? Array.from(actor?.items ?? []).filter(item => item?.type === type);
}

function isActorProsthesisContextFor(context, actor) {
  return Boolean(
    context
    && context.actor === actor
    && context.prosthesesByLimb instanceof Map
  );
}

function isActorLimbHealthContextFor(context, actor) {
  return Boolean(
    isActorProsthesisContextFor(context, actor)
    && context.activeTraumasByLimb instanceof Map
  );
}

export function isCriticalLimb(actor, limbKey = "") {
  const constructPart = getConstructPartItemForLimb(actor, limbKey);
  if (constructPart) return Boolean(getConstructPartFunction(constructPart).critical);
  const actorLimb = actor?.system?.limbs?.[limbKey];
  if (actorLimb && "critical" in actorLimb) return Boolean(actorLimb.critical);
  return Boolean(getActorLimbSettings(actor, limbKey)?.critical);
}

function hasDestroyedCriticalLimb(actor) {
  return Object.keys(actor?.system?.limbs ?? {})
    .some(limbKey => isCriticalLimb(actor, limbKey) && isLimbDestroyed(actor, limbKey));
}

export function canActorReceiveHealing(actor) {
  return Boolean(actor) && !isHealingBlocked(actor);
}

function isHealingBlocked(actor) {
  return isActorDead(actor);
}

function getIndependentHealthRules(actor) {
  if (!globalThis.game?.settings) return null;
  const runtimeSettings = getPreparedRuntimeSettings();
  return usesIndependentHealthModel(actor, runtimeSettings)
    ? runtimeSettings.rulesProfile
    : null;
}

function isIndependentHealthModelActive(actor) {
  return Boolean(getIndependentHealthRules(actor));
}

function isConsciousnessRulesEnabled(actor = null) {
  if (!globalThis.game?.settings) {
    return !actor || Boolean(actor.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY]);
  }
  const profile = getActiveRulesProfile();
  if (profile?.disableConsciousness) return false;
  return !actor || Boolean(actor.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY]);
}

function isActorHealthDepleted(actor) {
  if (!isIndependentHealthModelActive(actor)) return false;
  const health = actor?.system?.resources?.health;
  return Boolean(health) && toInteger(health.value) <= toInteger(health.min);
}

function isActorDead(actor) {
  return Boolean(
    actor?.statuses?.has?.(STATUS_EFFECTS.dead)
    || isActorHealthDepleted(actor)
    || hasDestroyedCriticalLimb(actor)
  );
}

async function synchronizeActorVitalStatuses(actor) {
  if (!actor?.toggleStatusEffect) return;
  const consciousnessEnabled = isConsciousnessRulesEnabled(actor);
  const preparedRecoveryTarget = consciousnessEnabled
    ? toInteger(actor.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY]?.recoveryTarget)
    : 0;
  if (
    consciousnessEnabled
    && preparedRecoveryTarget !== toInteger(actor.system?.combat?.consciousnessRecoveryTarget)
  ) {
    await actor.update({
      [CONSCIOUSNESS_RECOVERY_TARGET_PATH]: preparedRecoveryTarget
    }, {
      falloutMawSkipDamageStatusSync: true,
      falloutMawConsciousnessStateSync: true
    });
  }
  const dead = isActorHealthDepleted(actor) || hasDestroyedCriticalLimb(actor);
  let unconscious = consciousnessEnabled && !dead && isActorConsciousnessDepleted(actor);
  if (dead) {
    await knockdownActorForIncapacitation(actor, STATUS_EFFECTS.dead);
    await setActorStatus(actor, STATUS_EFFECTS.unconscious, false, { animate: false });
    await setActorStatus(actor, STATUS_EFFECTS.dead, true);
    return;
  }

  if (unconscious && !actor.statuses?.has?.(STATUS_EFFECTS.unconscious)) {
    for (const handler of unconsciousnessPreventionHandlers) {
      try {
        const result = await handler({ actor });
        if (!result?.handled) continue;
        unconscious = result.prevented ? isActorConsciousnessDepleted(actor) : unconscious;
        break;
      } catch (error) {
        console.error("Fallout MaW | Unconsciousness prevention handler failed", error);
      }
    }
  }
  if (unconscious) await knockdownActorForIncapacitation(actor, STATUS_EFFECTS.unconscious);
  await setActorStatus(actor, STATUS_EFFECTS.dead, false);
  await setActorStatus(actor, STATUS_EFFECTS.unconscious, Boolean(unconscious));
}

async function knockdownActorForIncapacitation(actor, state = "") {
  if (!actor || !state) return;
  await setActorTokensPosture(actor, "knocked");
}

async function performNegativeLimbShockCheck(actor, shockCheck = null, {
  chainRef = null,
  damageHubOperationRef = getCurrentDamageHubOperationRef()
} = {}) {
  if (!isConsciousnessRulesEnabled(actor) || !actor || !shockCheck || isActorConsciousnessDepleted(actor) || isActorDead(actor)) return undefined;
  const limitedUseOperationId = createLimbShockLimitedUseOperationId(actor, shockCheck, damageHubOperationRef);
  if (shockCheck.difficulty <= 0) {
    await commitLimbShockActiveUse(shockCheck, limitedUseOperationId);
    return undefined;
  }
  const outcome = await requestSkillCheck({
    actor,
    skillKey: "resilience",
    data: {
      difficulty: shockCheck.difficulty,
      allowImplicitTarget: false,
      damageHubOperationRef,
      limitedUseOperationId
    },
    chainRef,
    animate: false,
    createMessage: true,
    requester: getNegativeLimbShockRequester(actor, shockCheck)
  });
  if (outcome) await commitLimbShockActiveUse(shockCheck, limitedUseOperationId);
  const resultKey = String(outcome?.result?.key ?? "");
  if (resultKey) await applyShockConsciousnessResult(actor, resultKey);
  return outcome;
}

async function queueOrPerformNegativeLimbShockCheck(actor, shockCheck = null, deferredShockChecks = null, reason = "") {
  if (!isConsciousnessRulesEnabled(actor)) return undefined;
  if (!Array.isArray(deferredShockChecks)) return performNegativeLimbShockCheck(actor, shockCheck);
  if (!actor || !shockCheck || isActorConsciousnessDepleted(actor) || isActorDead(actor)) return undefined;
  if (shockCheck.difficulty <= 0) {
    await commitLimbShockActiveUse(
      shockCheck,
      createLimbShockLimitedUseOperationId(actor, shockCheck, getCurrentDamageHubOperationRef())
    );
    return undefined;
  }
  deferredShockChecks.push({
    actorUuid: actor.uuid,
    actor,
    shockCheck,
    reason,
    requester: getNegativeLimbShockRequester(actor, shockCheck)
  });
  return undefined;
}

async function resolveDeferredShockChecks(entries = [], {
  chainRef = null,
  damageHubOperationRef = getCurrentDamageHubOperationRef()
} = {}) {
  const queued = entries.filter(entry => entry?.actorUuid && entry?.shockCheck);
  if (!queued.length) return [];

  const runChecks = async () => {
    const batch = createSkillCheckBatchCollector({
      requester: "damageShock",
      title: "Проверки стойкости: шок"
    });
    const outcomes = [];
    try {
      for (const entry of queued) {
        const actor = fromUuidSync(entry.actorUuid) ?? entry.actor;
        if (!isConsciousnessRulesEnabled(actor) || !actor || isActorConsciousnessDepleted(actor) || isActorDead(actor)) continue;
        const shockCheck = entry.shockCheck;
        const limitedUseOperationId = createLimbShockLimitedUseOperationId(actor, shockCheck, damageHubOperationRef);
        const outcome = await requestSkillCheck({
          actor,
          skillKey: "resilience",
          data: {
            difficulty: shockCheck.difficulty,
            allowImplicitTarget: false,
            damageHubOperationRef,
            limitedUseOperationId
          },
          chainRef,
          animate: false,
          createMessage: false,
          completionCollector: batch,
          requester: entry.requester
        });
        if (outcome) await commitLimbShockActiveUse(shockCheck, limitedUseOperationId);
        batch.add(outcome);
        if (outcome) outcomes.push(outcome);
        const resultKey = String(outcome?.result?.key ?? "");
        if (resultKey) await applyShockConsciousnessResult(actor, resultKey);
      }
      if (batch.size) await batch.publish({ forceBatch: true });
      return outcomes;
    } finally {
      // Release every collected terminal event if a later shock side effect or
      // card publication fails. abort() is idempotent after publish().
      await Promise.allSettled([batch.abort()]);
    }
  };

  // Multiple shock subjects → one reaction wave with a column per subject.
  if (queued.length > 1) return withQueuedReactionOpportunityWave(runChecks);
  return runChecks();
}

function aggregateNegativeLimbShockChecks(actor, shockChecks = []) {
  const entries = shockChecks
    .filter(entry => entry && Number(entry.damage) > 0)
    .map(entry => ({
      limbKey: String(entry.limbKey ?? ""),
      damage: Math.max(0, roundDamageAmount(entry.damage)),
      difficulty: Math.max(0, roundDamageAmount(entry.difficulty)),
      chanceOperationId: String(entry.chanceOperationId ?? "").trim(),
      activeUsePreparations: Array.from(entry.activeUsePreparations ?? []).filter(Boolean)
    }));
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0];

  const limbKeys = Array.from(new Set(entries.map(entry => entry.limbKey).filter(Boolean)));
  return {
    limbKey: limbKeys.at(0) ?? "",
    limbKeys,
    damage: entries.reduce((sum, entry) => sum + entry.damage, 0),
    difficulty: entries.reduce((sum, entry) => sum + entry.difficulty, 0),
    chanceOperationId: entries.find(entry => entry.chanceOperationId)?.chanceOperationId ?? "",
    activeUsePreparations: entries.flatMap(entry => entry.activeUsePreparations)
  };
}

function createLimbShockLimitedUseOperationId(actor, shockCheck = {}, damageHubOperationRef = "") {
  const existing = String(shockCheck?.chanceOperationId ?? "").trim();
  if (existing) return existing;
  const scope = String(damageHubOperationRef ?? "").trim() || foundry.utils.randomID();
  const limbScope = Array.from(shockCheck?.limbKeys ?? [shockCheck?.limbKey])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)
    .join(",") || "limb";
  return `limb-shock:${scope}:${String(actor?.uuid ?? actor?.id ?? "actor")}:${limbScope}`;
}

async function commitLimbShockActiveUse(shockCheck = {}, operationId = "") {
  const preparations = Array.from(shockCheck?.activeUsePreparations ?? []).filter(Boolean);
  if (!preparations.length) return [];
  try {
    return await commitPreparedActiveUseOperations(preparations, { operationId });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Limb-shock active-use commit failed`, error);
    return [];
  }
}

function buildDestroyedLimbShockChecks(actor, limbKeys = []) {
  return Array.from(limbKeys ?? [])
    .filter(limbKey => limbKey && !isCriticalLimb(actor, limbKey))
    .map(limbKey => {
      const limb = actor?.system?.limbs?.[limbKey];
      const fullLimbDamage = Math.max(0, -toInteger(limb?.min));
      return createLimbShockCheck(actor, limbKey, fullLimbDamage, toInteger(limb?.min));
    })
    .filter(Boolean);
}

function getNegativeLimbShockRequester(actor, shockCheck = {}) {
  const limbKeys = Array.isArray(shockCheck.limbKeys) && shockCheck.limbKeys.length
    ? shockCheck.limbKeys
    : [shockCheck.limbKey].filter(Boolean);
  const label = limbKeys.length > 1
    ? limbKeys.map(limbKey => getLimbLabel(actor, limbKey)).join(", ")
    : getLimbLabel(actor, limbKeys.at(0) ?? shockCheck.limbKey);
  return `${label}: шок (${shockCheck.damage})`;
}

export function isActorConsciousnessDepleted(actor) {
  if (!isConsciousnessRulesEnabled(actor)) return false;
  if (isActorUnconsciousnessImmune(actor)) return false;
  return isConsciousnessUnconscious(actor?.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY]);
}

export function isActorUnconsciousnessImmune(actor = null) {
  return toInteger(actor?.system?.combat?.unconsciousnessImmunity) > 0;
}

async function applyShockConsciousnessResult(actor, resultKey = "") {
  if (
    !isConsciousnessRulesEnabled(actor)
    || !actor
    || isActorDead(actor)
    || isActorUnconsciousnessImmune(actor)
  ) return false;
  const resource = actor.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY];
  const nextValue = calculateShockConsciousnessValue(resource, resultKey);
  return updateActorConsciousnessValue(actor, nextValue);
}

function mergeConsciousnessRecoveryUpdate(updateData, actor, restoredHealth = 0) {
  if (!isConsciousnessRulesEnabled(actor)) return false;
  const resource = actor?.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY];
  if (!resource || roundDamageAmount(restoredHealth) <= 0) return false;

  const valuePath = `system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.value`;
  const pendingValue = hasUpdatePath(updateData, valuePath)
    ? getUpdatePath(updateData, valuePath)
    : resource.value;
  const nextValue = calculateConsciousnessRecoveryValue(
    { ...resource, value: pendingValue },
    restoredHealth
  );
  return mergeConsciousnessValueUpdate(updateData, actor, nextValue);
}

function mergeConsciousnessValueUpdate(updateData, actor, requestedValue = 0) {
  if (!isConsciousnessRulesEnabled(actor)) return false;
  const resource = actor?.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY];
  const pendingRecoveryTarget = hasUpdatePath(updateData, CONSCIOUSNESS_RECOVERY_TARGET_PATH)
    ? getUpdatePath(updateData, CONSCIOUSNESS_RECOVERY_TARGET_PATH)
    : resource?.recoveryTarget;
  const valueData = buildConsciousnessUpdateData({
    ...resource,
    recoveryTarget: pendingRecoveryTarget
  }, requestedValue);
  if (!valueData) return false;

  const valuePath = `system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.value`;
  const spentPath = `system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.spent`;
  const currentValue = hasUpdatePath(updateData, valuePath)
    ? toInteger(getUpdatePath(updateData, valuePath))
    : toInteger(resource.value);
  const currentSpent = hasUpdatePath(updateData, spentPath)
    ? toInteger(getUpdatePath(updateData, spentPath))
    : toInteger(resource.spent);
  const currentRecoveryTarget = hasUpdatePath(updateData, CONSCIOUSNESS_RECOVERY_TARGET_PATH)
    ? toInteger(getUpdatePath(updateData, CONSCIOUSNESS_RECOVERY_TARGET_PATH))
    : toInteger(actor?.system?.combat?.consciousnessRecoveryTarget);
  if (
    valueData.value === currentValue
    && valueData.spent === currentSpent
    && valueData.recoveryTarget === currentRecoveryTarget
  ) return false;

  setUpdatePath(updateData, valuePath, valueData.value);
  setUpdatePath(updateData, spentPath, valueData.spent);
  setUpdatePath(updateData, CONSCIOUSNESS_RECOVERY_TARGET_PATH, valueData.recoveryTarget);
  return true;
}

async function updateActorConsciousnessValue(actor, requestedValue = 0) {
  if (!actor) return false;
  const updateData = {};
  if (!mergeConsciousnessValueUpdate(updateData, actor, requestedValue)) return false;
  const thresholdChanged = hasConsciousnessThresholdTransition(actor, updateData);

  await actor.update(updateData, {
    falloutMawSkipDamageStatusSync: true,
    falloutMawConsciousnessStateSync: true
  });
  if (thresholdChanged) await queueActorDamageStatusSync(actor);
  return true;
}

function hasConsciousnessThresholdTransition(actor, updateData = {}) {
  const resource = actor?.system?.resources?.[CONSCIOUSNESS_RESOURCE_KEY];
  if (!resource) return false;
  const valuePath = `system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.value`;
  if (!hasUpdatePath(updateData, valuePath)) return false;
  return hasConsciousnessDepletionTransition(resource, getUpdatePath(updateData, valuePath));
}

async function setActorStatus(actor, statusId = "", active = false, options = {}) {
  if (!statusId || !actor) return;
  if (actor.statuses?.has?.(statusId) === active) {
    if (active) await ensureActorStatusEffectData(actor, getActorStatusEffectIds(actor, CONFIG.statusEffects?.[statusId]), statusId, options);
    return;
  }
  try {
    await setActorStatusEffect(actor, statusId, active, options);
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
    const freshActor = fromUuidSync(actor.uuid) ?? actor;
    if (freshActor.statuses?.has?.(statusId) === active) return;
    if (!active) return;
    await setActorStatusEffect(freshActor, statusId, active, options);
  }
}

async function setActorStatusEffect(actor, statusId = "", active = false, options = {}) {
  const status = CONFIG.statusEffects?.[statusId];
  if (!status) return undefined;
  const animationOptions = getStatusAnimationOptions(statusId, options);

  const existing = getActorStatusEffectIds(actor, status);

  if (existing.length) {
    if (active) {
      await ensureActorStatusEffectData(actor, existing, statusId, options);
      return true;
    }
    await actor.deleteEmbeddedDocuments("ActiveEffect", existing, animationOptions);
    return false;
  }

  if (!active && active !== undefined) return undefined;
  const ActiveEffect = getDocumentClass("ActiveEffect");
  const effect = await ActiveEffect.fromStatusEffect(statusId);
  if (isOverlayStatusEffect(statusId)) effect.updateSource({ "flags.core.overlay": true });
  prepareIncapacitatingStatusDodgeOverride(effect, statusId);
  return ActiveEffect.implementation.create(effect, {
    parent: actor,
    keepId: true,
    ...animationOptions
  });
}

async function ensureActorStatusEffectData(actor, effectIds = [], statusId = "", options = {}) {
  const updates = effectIds
    .map(effectId => actor?.effects?.get(effectId))
    .filter(Boolean)
    .map(effect => buildStatusEffectDataUpdate(effect, statusId))
    .filter(update => Object.keys(update).length);
  if (updates.length) await actor.updateEmbeddedDocuments("ActiveEffect", updates, getStatusAnimationOptions(statusId, options));
}

function buildStatusEffectDataUpdate(effect, statusId = "") {
  const update = { _id: effect.id };
  if (isOverlayStatusEffect(statusId) && !effect.flags?.core?.overlay) update["flags.core.overlay"] = true;

  const changes = ensureIncapacitatingDodgeOverrideChanges(effect.system?.changes ?? [], statusId);
  if (changes && !activeEffectChangesEqual(changes, effect.system?.changes ?? [])) {
    update["system.changes"] = changes;
  }
  return Object.keys(update).length > 1 ? update : {};
}

function prepareIncapacitatingStatusDodgeOverride(effect, statusId = "") {
  const changes = ensureIncapacitatingDodgeOverrideChanges(effect.system?.changes ?? [], statusId);
  if (changes) effect.updateSource({ "system.changes": changes });
}

function ensureIncapacitatingDodgeOverrideChanges(changes = [], statusId = "") {
  if (!INCAPACITATING_DODGE_OVERRIDE_STATUSES.has(statusId)) return null;
  const retained = canonicalizeActiveEffectChanges(changes)
    .filter(change => String(change?.key ?? "").trim() !== DODGE_RESOURCE_BONUS_EFFECT_KEY);
  return [
    ...retained,
    {
      key: DODGE_RESOURCE_BONUS_EFFECT_KEY,
      type: "override",
      value: "0",
      phase: "initial",
      priority: INCAPACITATING_DODGE_OVERRIDE_PRIORITY
    }
  ];
}

function isOverlayStatusEffect(statusId = "") {
  return OVERLAY_STATUS_EFFECTS.has(statusId);
}

function getStatusAnimationOptions(statusId = "", { animate = null } = {}) {
  const options = { [VITAL_STATUS_SYNCHRONIZATION_OPTION]: true };
  if (SUPPRESSED_STATUS_EFFECT_ANIMATIONS.has(statusId)) return { ...options, animate: false };
  if (animate === false) return { ...options, animate: false };
  if (animate === true) return options;
  return isOverlayStatusEffect(statusId) ? options : { ...options, animate: false };
}

function getActorStatusEffectIds(actor, status) {
  if (!actor || !status) return [];
  const existing = [];
  if (status._id) {
    const effect = actor.effects?.get(status._id);
    if (effect) existing.push(effect.id);
    return existing;
  }

  for (const effect of actor.effects ?? []) {
    const statuses = effect.statuses;
    if (statuses?.size === 1 && statuses.has(status.id)) existing.push(effect.id);
  }
  return existing;
}

function splitSpecialEffectChanges(effectChanges = []) {
  const statuses = [];
  const changes = [];
  for (const change of effectChanges) {
    const statusId = getStatusEffectId(change.key);
    if (statusId) {
      if (isTruthyEffectValue(change.value) && !statuses.includes(statusId)) statuses.push(statusId);
      continue;
    }
    changes.push(change);
  }
  return { changes, statuses };
}

function getStatusEffectId(key = "") {
  const normalized = String(key ?? "").trim();
  if (!normalized.startsWith("status.")) return "";
  return normalized.slice("status.".length).trim();
}

function isTruthyEffectValue(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(text);
}

function collectCostModifier(actor, key = "", { effectSnapshot = null } = {}) {
  const modifier = { add: 0, multiplier: 1, override: null };
  if (!key) return modifier;
  for (const { effect, change } of getActorEffectChangeEntries(actor, key, {
    snapshot: effectSnapshot
  })) {
    if (effect.disabled) continue;
    const value = evaluateActorEffectChangeNumber(actor, { ...change, effect });
    if (!Number.isFinite(value)) continue;
    if (change.type === "override") modifier.override = value;
    else if (change.type === "multiply") modifier.multiplier *= value;
    else modifier.add += value;
  }
  return modifier;
}

function mergeCostModifiers(...modifiers) {
  return modifiers.reduce((result, modifier) => ({
    add: result.add + (Number(modifier?.add) || 0),
    multiplier: result.multiplier * (Number.isFinite(Number(modifier?.multiplier)) ? Number(modifier.multiplier) : 1),
    override: modifier?.override !== null && modifier?.override !== undefined && modifier?.override !== ""
      ? modifier.override
      : result.override
  }), { add: 0, multiplier: 1, override: null });
}

async function createPeriodicDamageEffect(actor, {
  damageType = {},
  limbKey = "",
  scope = SCOPE_HEALTH,
  amount = 0,
  settings = {},
  source = {},
  sourceIdentity = "",
  worldTime = null
} = {}) {
  if (!canCreateLimbTimedDamageEffect(actor, limbKey)) return [];
  const tickCount = Math.max(0, toInteger(settings.tickCount));
  const tickAmount = tickCount > 0 ? roundDamageAmount(amount / tickCount) : 0;
  if (!tickCount || !tickAmount) return [];

  const intervalSeconds = Math.max(1, toInteger(settings.intervalSeconds || ROUND_SECONDS));
  const startTime = Number.isFinite(Number(worldTime)) ? Number(worldTime) : (Number(game.time?.worldTime) || 0);
  const endTime = startTime + (intervalSeconds * tickCount);
  const effectName = String(settings.effectName || damageType.label || damageType.key || "Урон").trim();
  const resolvedSourceIdentity = getPeriodicDamageSourceIdentity(source)
    || String(sourceIdentity ?? "").trim()
    || foundry.utils.randomID();
  const changeData = {
    kind: PERIODIC_DAMAGE_EFFECT_KIND,
    damageTypeKey: damageType.key ?? "",
    limbKey,
    scope,
    amountPerTick: tickAmount,
    totalTicks: tickCount,
    remainingTicks: tickCount,
    intervalSeconds,
    startTime,
    endTime,
    nextTickTime: startTime + intervalSeconds,
    sourceIdentity: resolvedSourceIdentity,
    source
  };
  const effectData = {
    type: "base",
    name: effectName,
    img: String(settings.img || "icons/svg/hazard.svg"),
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      startTime,
      seconds: intervalSeconds * tickCount,
      expiry: MANAGED_TIMED_DAMAGE_EXPIRY
    },
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "active",
        [MANAGED_TIMED_DAMAGE_FLAG_KEY]: true
      }
    },
    system: {
      changes: [createDamageEffectChange(
        buildDamageEffectChangeKey(
          "periodic",
          damageType.key || "damage",
          limbKey || scope || "health",
          resolvedSourceIdentity
        ),
        changeData
      )]
    }
  };
  return upsertManagedTimedDamageEffect(actor, effectData, [PERIODIC_DAMAGE_EFFECT_KIND]);
}

async function createBleedingDamageEffect(actor, { damageType = {}, limbKey = "", scope = SCOPE_HEALTH, healthDelta = 0, source = {}, worldTime = null } = {}) {
  const effectData = buildBleedingDamageEffectData(actor, [{ damageType, limbKey, scope, healthDelta, source, worldTime }]);
  if (!effectData) return [];
  return upsertManagedTimedDamageEffect(actor, effectData, [BLEEDING_DAMAGE_EFFECT_KIND]);
}

async function createCombinedBleedingDamageEffect(actor, entries = []) {
  const effectData = buildBleedingDamageEffectData(actor, entries);
  if (!effectData) return [];
  return upsertManagedTimedDamageEffect(actor, effectData, [BLEEDING_DAMAGE_EFFECT_KIND]);
}

function buildBleedingDamageEffectData(actor, entries = []) {
  const bleedingEntries = (Array.isArray(entries) ? entries : [entries])
    .map(entry => buildBleedingDamageEffectEntry(actor, entry))
    .filter(Boolean);
  if (!bleedingEntries.length) return null;

  const totalTicks = Math.max(...bleedingEntries.map(entry => entry.tickAmounts.length));
  const startTime = Math.min(...bleedingEntries.map(entry => entry.startTime));
  const endTime = startTime + (ROUND_SECONDS * totalTicks);
  if (!bleedingEntries.some(entry => entry.tickAmounts.some(amount => amount > 0))) return null;

  const names = new Set(bleedingEntries.map(entry => entry.effectName).filter(Boolean));
  const effectName = names.size === 1 ? bleedingEntries[0].effectName : "Кровотечение";
  const img = bleedingEntries.find(entry => entry.img)?.img || "icons/skills/wounds/blood-drip-droplet-red.webp";
  const changes = combineBleedingDamageEffectEntries(bleedingEntries).map(entry => {
    const entryTotalTicks = Math.max(0, entry.tickAmounts.length);
    const entryStartTime = Number(entry.startTime) || startTime;
    const entryEndTime = entryStartTime + (ROUND_SECONDS * entryTotalTicks);
    return createDamageEffectChange(
      buildDamageEffectChangeKey("bleeding", entry.limbKey || entry.scope || "health"),
      {
        kind: BLEEDING_DAMAGE_EFFECT_KIND,
        damageTypeKey: BLEEDING_DAMAGE_TYPE_KEY,
        sourceDamageTypeKey: entry.sourceDamageTypeKey,
        limbKey: entry.limbKey,
        scope: entry.scope,
        tickAmounts: entry.tickAmounts,
        totalTicks: entryTotalTicks,
        remainingTicks: entryTotalTicks,
        intervalSeconds: ROUND_SECONDS,
        startTime: entryStartTime,
        endTime: entryEndTime,
        nextTickTime: entryStartTime + ROUND_SECONDS,
        source: entry.source
      }
    );
  });

  return {
    type: "base",
    name: effectName,
    img,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      startTime,
      seconds: Math.max(0, endTime - startTime),
      expiry: MANAGED_TIMED_DAMAGE_EXPIRY
    },
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "temporary",
        [MANAGED_TIMED_DAMAGE_FLAG_KEY]: true
      }
    },
    system: { changes }
  };
}

function combineBleedingDamageEffectEntries(entries = []) {
  const combined = new Map();
  for (const entry of entries ?? []) {
    const limbKey = String(entry.limbKey ?? "").trim();
    const scope = String(entry.scope ?? SCOPE_HEALTH);
    const sourceDamageTypeKey = String(entry.sourceDamageTypeKey ?? "").trim();
    const key = buildDamageEffectChangeKey("bleeding", limbKey || scope || "health");
    const current = combined.get(key);
    if (!current) {
      combined.set(key, {
        ...entry,
        sourceDamageTypeKey,
        limbKey,
        scope,
        tickAmounts: [...entry.tickAmounts],
        source: entry.source && typeof entry.source === "object" ? foundry.utils.deepClone(entry.source) : {}
      });
      continue;
    }

    current.sourceDamageTypeKey = current.sourceDamageTypeKey === sourceDamageTypeKey ? current.sourceDamageTypeKey : "";
    current.startTime = Math.min(Number(current.startTime) || 0, Number(entry.startTime) || Number(current.startTime) || 0);
    current.tickAmounts = sumTickAmounts(current.tickAmounts, entry.tickAmounts);
    current.source = combineDamageEffectSources(current.source, entry.source);
  }
  return Array.from(combined.values());
}

function sumTickAmounts(left = [], right = []) {
  const length = Math.max(left.length, right.length);
  return Array.from({ length }, (_value, index) => (
    Math.max(0, toInteger(left[index])) + Math.max(0, toInteger(right[index]))
  ));
}

function buildBleedingDamageEffectEntry(actor, { damageType = {}, limbKey = "", scope = SCOPE_HEALTH, healthDelta = 0, source = {}, worldTime = null } = {}) {
  if (!canCreateLimbTimedDamageEffect(actor, limbKey)) return null;
  const settings = damageType?.settings?.bleeding;
  if (!shouldCreateBleedingDamageEffect(damageType, settings, source)) return null;

  const totalAmount = roundDamageAmount((Number(healthDelta) || 0) * (Number(settings.percent) || 0) / 100);
  if (totalAmount <= 0) return null;

  const durationSeconds = Math.max(1, toInteger(settings.durationSeconds || ROUND_SECONDS));
  const tickCount = Math.max(1, Math.ceil(durationSeconds / ROUND_SECONDS));
  const tickAmounts = distributeIntegerAmountAcrossTicks(totalAmount, tickCount);
  if (!tickAmounts.some(amount => amount > 0)) return null;

  const startTime = Number.isFinite(Number(worldTime)) ? Number(worldTime) : (Number(game.time?.worldTime) || 0);
  const effectName = String(settings.effectName || "Кровотечение").trim();
  return {
    sourceDamageTypeKey: damageType?.key ?? "",
    limbKey,
    scope,
    tickAmounts,
    startTime,
    effectName,
    img: String(settings.img || "icons/skills/wounds/blood-drip-droplet-red.webp"),
    source
  };
}

function canCreateLimbTimedDamageEffect(actor, limbKey = "") {
  const key = String(limbKey ?? "").trim();
  return !key || !isLimbDestroyed(actor, key);
}

async function createResourceLimitEffect(actor, { damageType = {}, healthDelta = 0, source = {}, worldTime = null } = {}) {
  const settings = damageType?.settings?.resourceLimit ?? damageType?.settings?.resourceBlock;
  if (!settings?.enabled) return [];
  const healthMax = Math.max(0, toInteger(actor.health?.max));
  if (!healthMax) return [];
  const percent = Math.max(0, Number(healthDelta) || 0) / healthMax;
  const resources = {};
  for (const rule of settings.resources ?? []) {
    const resourceKey = String(rule?.resourceKey ?? "").trim();
    const resource = actor.system?.resources?.[resourceKey];
    const resourceMax = Math.max(0, toInteger(resource?.max));
    if (!resourceKey || !resourceMax) continue;
    const rulePercent = Math.max(0, Number(rule?.percent) || 0) / 100;
    const amount = roundDamageAmount(percent * resourceMax * rulePercent);
    if (amount) resources[resourceKey] = (resources[resourceKey] ?? 0) + amount;
  }
  if (!Object.keys(resources).length) return [];

  const durationSeconds = Math.max(1, toInteger(settings.durationSeconds || 12));
  const startTime = Number.isFinite(Number(worldTime)) ? Number(worldTime) : (Number(game.time?.worldTime) || 0);
  return actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: String(settings.effectName || damageType.label || "Ограничение ресурсов"),
    img: String(settings.img || "icons/svg/frozen.svg"),
    disabled: false,
    tint: settings.color,
    duration: {
      seconds: durationSeconds,
      startTime
    },
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "temporary",
        [DAMAGE_EFFECT_FLAG_KEY]: {
          kind: "resourceLimit",
          damageTypeKey: damageType.key ?? "",
          resources,
          color: settings.color,
          source
        }
      }
    },
    system: { changes: [] }
  }], getDamageActiveEffectOperationOptions());
}

async function createFirstAidEffect(actor, request = {}) {
  const data = normalizeFirstAidEffectRequest(request);
  if (!actor || data.durationSeconds <= 0) return [];
  if (data.healingPerTick <= 0 && !data.changes.length) return [];

  const startTime = Number.isFinite(Number(data.source?.worldTime))
    ? Number(data.source.worldTime)
    : (Number(game.time?.worldTime) || 0);
  const tickCount = data.healingPerTick > 0
    ? Math.max(1, Math.ceil(data.durationSeconds / data.intervalSeconds))
    : 0;
  const effectName = data.itemName || "Первая помощь";
  const description = [
    data.healingPerTick > 0 ? `Заживление: +${data.healingPerTick}` : "",
    `Длительность: ${data.durationSeconds} сек.`
  ].filter(Boolean).join("<br>");
  const damageEffect = data.healingPerTick > 0
    ? {
      kind: "periodicHealing",
      amountPerTick: data.healingPerTick,
      totalTicks: tickCount,
      remainingTicks: tickCount,
      intervalSeconds: data.intervalSeconds,
      startTime,
      endTime: startTime + data.durationSeconds,
      nextTickTime: startTime + data.intervalSeconds,
      source: data.source
    }
    : {
      kind: FIRST_AID_TEMPORARY_EFFECT_KIND,
      startTime,
      endTime: startTime + data.durationSeconds,
      source: data.source
    };
  const flags = {
    [TRAUMA_FLAG_SCOPE]: {
      kind: "temporary",
      [MANAGED_TIMED_DAMAGE_FLAG_KEY]: true,
      [DAMAGE_EFFECT_FLAG_KEY]: damageEffect
    }
  };
  const withdrawalPayload = normalizeStoredFirstAidWithdrawalPayload(request.withdrawal, request.itemName);
  if (withdrawalPayload) flags[TRAUMA_FLAG_SCOPE][FIRST_AID_WITHDRAWAL_PAYLOAD_FLAG_KEY] = withdrawalPayload;

  const effectData = {
    type: "base",
    name: effectName,
    img: data.itemImg || "icons/svg/heal.svg",
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    description,
    flags,
    system: { changes: data.changes }
  };
  if (data.durationSeconds > 0) {
    effectData.duration = {
      seconds: data.durationSeconds,
      startTime,
      expiry: MANAGED_TIMED_DAMAGE_EXPIRY
    };
  }
  return actor.createEmbeddedDocuments("ActiveEffect", [effectData], getDamageActiveEffectOperationOptions());
}

async function createFirstAidWithdrawalEffect(actor, request = {}) {
  const data = normalizeFirstAidWithdrawalRequest(request);
  if (!actor || !data.changes.length && data.healingPerTick <= 0) return [];
  if (data.durationSeconds <= 0 && data.healingPerTick <= 0) return [];

  const startTime = Number.isFinite(Number(data.source?.worldTime))
    ? Number(data.source.worldTime)
    : (Number(game.time?.worldTime) || 0);
  const tickCount = data.healingPerTick > 0 && data.durationSeconds > 0
    ? Math.max(1, Math.ceil(data.durationSeconds / data.intervalSeconds))
    : 0;
  const effectName = data.itemName ? `Отдача: ${data.itemName}` : "Отдача";
  const description = [
    data.healingPerTick > 0 ? `Заживление: ${data.healingPerTick > 0 ? "+" : ""}${data.healingPerTick}` : "",
    data.durationSeconds > 0 ? `Длительность: ${data.durationSeconds} сек.` : ""
  ].filter(Boolean).join("<br>");
  const damageEffect = data.healingPerTick > 0 && data.durationSeconds > 0
    ? {
      kind: "periodicHealing",
      amountPerTick: data.healingPerTick,
      totalTicks: tickCount,
      remainingTicks: tickCount,
      intervalSeconds: data.intervalSeconds,
      startTime,
      endTime: startTime + data.durationSeconds,
      nextTickTime: startTime + data.intervalSeconds,
      source: data.source
    }
    : data.durationSeconds > 0
      ? {
        kind: FIRST_AID_WITHDRAWAL_EFFECT_KIND,
        startTime,
        endTime: startTime + data.durationSeconds,
        source: data.source
      }
      : null;
  const flags = damageEffect
    ? {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "temporary",
        [MANAGED_TIMED_DAMAGE_FLAG_KEY]: true,
        [DAMAGE_EFFECT_FLAG_KEY]: damageEffect
      }
    }
    : {};
  const effectData = {
    type: "base",
    name: effectName,
    img: data.itemImg || "icons/svg/downgrade.svg",
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    description,
    flags,
    system: { changes: data.changes }
  };
  if (data.durationSeconds > 0) {
    effectData.duration = {
      seconds: data.durationSeconds,
      startTime,
      expiry: MANAGED_TIMED_DAMAGE_EXPIRY
    };
  }
  return actor.createEmbeddedDocuments("ActiveEffect", [effectData], getDamageActiveEffectOperationOptions());
}

function normalizeFirstAidEffectRequest(request = {}) {
  const source = request.source && typeof request.source === "object" ? foundry.utils.deepClone(request.source) : {};
  return {
    actorUuid: String(request.actorUuid ?? "").trim(),
    itemName: String(request.itemName ?? "").trim(),
    itemImg: String(request.itemImg ?? "").trim(),
    healingPerTick: Math.max(0, toInteger(request.healingPerTick)),
    durationSeconds: Math.max(0, toInteger(request.durationSeconds)),
    intervalSeconds: source.kind === "firstAid"
      ? PERIODIC_HEALING_INTERVAL_SECONDS
      : Math.max(1, toInteger(request.intervalSeconds || ROUND_SECONDS)),
    changes: normalizeEffectChanges(request.changes),
    withdrawal: request.withdrawal && typeof request.withdrawal === "object"
      ? foundry.utils.deepClone(request.withdrawal)
      : null,
    source
  };
}

function normalizeFirstAidWithdrawalRequest(request = {}) {
  const source = request.source && typeof request.source === "object" ? foundry.utils.deepClone(request.source) : {};
  return {
    actorUuid: String(request.actorUuid ?? "").trim(),
    itemName: String(request.itemName ?? "").trim(),
    itemImg: String(request.itemImg ?? "").trim(),
    healingPerTick: Math.max(0, toInteger(request.healingPerTick)),
    durationSeconds: Math.max(0, toInteger(request.durationSeconds)),
    intervalSeconds: source.kind === "firstAid"
      ? PERIODIC_HEALING_INTERVAL_SECONDS
      : Math.max(1, toInteger(request.intervalSeconds || ROUND_SECONDS)),
    changes: normalizeEffectChanges(request.changes),
    source
  };
}

function normalizeStoredFirstAidWithdrawalPayload(withdrawal = null, itemName = "") {
  if (!withdrawal || typeof withdrawal !== "object") return null;
  const normalized = normalizeFirstAidWithdrawalRequest({
    ...withdrawal,
    itemName: String(withdrawal.itemName ?? itemName ?? "").trim()
  });
  if (!normalized.changes.length && normalized.healingPerTick <= 0) return null;
  return normalized;
}

async function applyStoredFirstAidWithdrawalOnDelete(effect) {
  if (!game.user?.isActiveGM) return;
  const payload = effect.getFlag?.(TRAUMA_FLAG_SCOPE, FIRST_AID_WITHDRAWAL_PAYLOAD_FLAG_KEY);
  if (!payload) return;
  const actor = effect.parent;
  if (!actor) return;
  await createFirstAidWithdrawalEffect(actor, payload);
}

function normalizeNeedChangesRequest(request = {}) {
  const source = Array.isArray(request.needs) ? request.needs : Object.values(request.needs ?? {});
  return {
    actorUuid: String(request.actorUuid ?? "").trim(),
    needs: source
      .map(entry => ({
        key: String(entry?.key ?? entry?.needKey ?? "").trim(),
        value: toInteger(entry?.value)
      }))
      .filter(entry => entry.key && entry.value),
    context: normalizeNeedChangeContext(request.context)
  };
}

function normalizeNeedChangeContext(context = {}) {
  const source = context && typeof context === "object" ? context : {};
  return {
    kind: String(source.kind ?? "needChange"),
    chanceOperationId: String(source.chanceOperationId ?? ""),
    limitedUseOperationId: String(source.limitedUseOperationId ?? ""),
    operationId: String(source.operationId ?? ""),
    rootId: String(source.rootId ?? ""),
    itemUuid: String(source.itemUuid ?? ""),
    sourceActorUuid: String(source.sourceActorUuid ?? "")
  };
}

function normalizeFirstAidRemoveEffectsRequest(request = {}) {
  const limbKeys = Array.isArray(request.limbKeys)
    ? request.limbKeys
    : Object.keys(request.limbKeys ?? {});
  const damageTypeKeys = Array.isArray(request.damageTypeKeys)
    ? request.damageTypeKeys
    : Object.keys(request.damageTypeKeys ?? {});
  return {
    actorUuid: String(request.actorUuid ?? "").trim(),
    limbKeys: Array.from(new Set(limbKeys
      .map(key => String(key ?? "").trim())
      .filter(Boolean))),
    damageTypeKeys: Array.from(new Set(damageTypeKeys
      .map(key => String(key ?? "").trim())
      .filter(Boolean)))
  };
}

async function applyNeedChanges(actor, needs = [], { context = {} } = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return [];
  return applyActorNeedChanges(actor, needs, { context });
}

async function applyFirstAidRemoveEffects(actor, request = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return [];
  const limbKeys = new Set((request.limbKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean));
  const damageTypeKeys = new Set((request.damageTypeKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean));
  if (!limbKeys.size || !damageTypeKeys.size) return [];

  const deleteIds = [];
  const updateResults = [];
  for (const effect of Array.from(actor.effects ?? [])) {
    if (effect.disabled) continue;
    const changes = getEffectChangeSource(effect);
    const removableChanges = getDamageEffectChanges(effect).filter(data => (
      isFirstAidRemovablePeriodicEffect(data, damageTypeKeys)
      && limbKeys.has(String(data.limbKey ?? "").trim())
    ));
    if (!removableChanges.length) continue;

    const removeIndexes = new Set(removableChanges.map(data => data.changeIndex));
    const remainingChanges = changes.filter((_change, index) => !removeIndexes.has(index));
    const remainingDamageChanges = remainingChanges
      .map((change, index) => parseDamageEffectChange(change, index))
      .filter(Boolean);
    updateResults.push({ effectId: effect.id, kind: "damageEffect", removed: removeIndexes.size });
    if (!remainingDamageChanges.length && changes.every((change, index) => removeIndexes.has(index) || parseDamageEffectChange(change, index))) {
      deleteIds.push(effect.id);
    } else {
      await updatePeriodicEffect(effect, { "system.changes": remainingChanges });
    }
  }

  const deleted = await deleteActorActiveEffects(actor, deleteIds);
  return [
    ...updateResults,
    ...deleted.map(effect => ({ effectId: effect.id, kind: "deleted" }))
  ];
}

function isFirstAidRemovablePeriodicEffect(data = {}, damageTypeKeys = new Set()) {
  if (data?.kind === PERIODIC_DAMAGE_EFFECT_KIND) return damageTypeKeys.has(String(data.damageTypeKey ?? "").trim());
  if (data?.kind === BLEEDING_DAMAGE_EFFECT_KIND) return damageTypeKeys.has(BLEEDING_DAMAGE_TYPE_KEY);
  return false;
}

function normalizeEffectChanges(changes = []) {
  const source = Array.isArray(changes) ? changes : Object.values(changes ?? {});
  return source
    .map(change => ({
      key: String(change?.key ?? "").trim(),
      type: ["add", "multiply", "override"].includes(String(change?.type ?? "")) ? String(change.type) : "add",
      value: String(change?.value ?? "0"),
      phase: String(change?.phase ?? "initial") || "initial",
      priority: change?.priority === null || change?.priority === "" || change?.priority === undefined
        ? null
        : toInteger(change.priority)
    }))
    .filter(change => change.key);
}

async function applyNeedIncrease(actor, { amount = 0, settings = {} } = {}) {
  const needKey = String(settings.needKey ?? "").trim();
  const need = actor.system?.needs?.[needKey];
  if (!need) return null;

  const delta = roundDamageAmount(Math.max(0, Number(amount) || 0) * (Math.max(0, Number(settings.percent) || 0) / 100));
  if (!delta) return null;

  const [result] = await applyActorNeedChanges(actor, [{ key: needKey, value: delta }], {
    context: {
      kind: "damageNeedIncrease",
      source: settings
    }
  });
  if (!result) return null;
  return {
    needKey,
    delta: result.appliedDelta,
    value: result.value,
    requestedDelta: result.requestedDelta,
    scaledDelta: result.scaledDelta
  };
}

async function handleDamageSocketMessage(payload = {}) {
  if (!payload) return;
  if (payload.action === "applyDamageCycleResult" || payload.action === "damageHubActionResult") {
    if (payload.targetUserId && payload.targetUserId !== game.user?.id) return;
    const pending = pendingDamageSocketRequests.get(payload.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingDamageSocketRequests.delete(payload.requestId);
    if (payload.ok) pending.resolve(payload.results ?? payload.result ?? []);
    else pending.reject(new Error(payload.error || "Damage hub socket request failed."));
    return;
  }
  if (payload.action === "showDamageNumbers") {
    if (payload.senderUserId === game.user?.id) return;
    displayDamageNumbersForActor(payload.actorUuid, payload.entries);
    return;
  }
  if (payload.action === "showDamageMitigationIcon") {
    if (payload.senderUserId === game.user?.id) return;
    displayDamageMitigationIconForActor(payload.actorUuid, payload.display);
    return;
  }
  if (payload.action === "applyDamageBatch") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    await applyDamageApplications({
      actorUuid: payload.actorUuid,
      requests: payload.requests
    });
    return;
  }
  if (payload.action === "applyDamageCycle") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    let ok = true;
    let results = [];
    let error = "";
    try {
      results = await applyDamageCycle(payload.requests);
    } catch (caught) {
      ok = false;
      error = String(caught?.message ?? caught ?? "Damage hub socket request failed.");
      console.error("Fallout MaW | Damage hub socket request failed", caught);
    }
    if (payload.requestId && payload.requesterUserId) {
      game.socket.emit(DAMAGE_SOCKET, {
        action: "applyDamageCycleResult",
        targetUserId: payload.requesterUserId,
        requestId: payload.requestId,
        ok,
        error,
        results: ok ? serializeDamageCycleSocketResults(results) : []
      });
    }
    return;
  }
  if (payload.action === "createFirstAidEffect") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    let ok = true;
    let result = [];
    let error = "";
    try {
      const request = normalizeFirstAidEffectRequest(payload.request);
      const actor = await fromUuid(request.actorUuid);
      if (actor) result = await runDamageHubOperation(() => createFirstAidEffect(actor, request));
    } catch (caught) {
      ok = false;
      error = String(caught?.message ?? caught ?? "Damage hub socket request failed.");
      console.error("Fallout MaW | First aid effect socket request failed", caught);
    }
    respondDamageHubSocketAction(payload, {
      ok,
      error,
      result: ok ? serializeEmbeddedDocumentSocketResults(result) : []
    });
    return;
  }
  if (payload.action === "createFirstAidWithdrawalEffect") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    let ok = true;
    let result = [];
    let error = "";
    try {
      const request = normalizeFirstAidWithdrawalRequest(payload.request);
      const actor = await fromUuid(request.actorUuid);
      if (actor) result = await runDamageHubOperation(() => createFirstAidWithdrawalEffect(actor, request));
    } catch (caught) {
      ok = false;
      error = String(caught?.message ?? caught ?? "Damage hub socket request failed.");
      console.error("Fallout MaW | First aid withdrawal effect socket request failed", caught);
    }
    respondDamageHubSocketAction(payload, {
      ok,
      error,
      result: ok ? serializeEmbeddedDocumentSocketResults(result) : []
    });
    return;
  }
  if (payload.action === "applyNeedChanges" || payload.action === "applyFirstAidNeedChanges") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    let ok = true;
    let result = [];
    let error = "";
    try {
      const request = normalizeNeedChangesRequest(payload.request);
      const actor = await fromUuid(request.actorUuid);
      if (actor) {
        result = await runDamageHubOperation(() => applyNeedChanges(actor, request.needs, {
          context: request.context
        }));
      }
    } catch (caught) {
      ok = false;
      error = String(caught?.message ?? caught ?? "Damage hub socket request failed.");
      console.error("Fallout MaW | Need change socket request failed", caught);
    }
    respondDamageHubSocketAction(payload, { ok, error, result: ok ? result : [] });
    return;
  }
  if (payload.action === "applyFirstAidRemoveEffects") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    let ok = true;
    let result = [];
    let error = "";
    try {
      const request = normalizeFirstAidRemoveEffectsRequest(payload.request);
      const actor = await fromUuid(request.actorUuid);
      if (actor) result = await runDamageHubOperation(() => applyFirstAidRemoveEffects(actor, request));
    } catch (caught) {
      ok = false;
      error = String(caught?.message ?? caught ?? "Damage hub socket request failed.");
      console.error("Fallout MaW | First aid remove effects socket request failed", caught);
    }
    respondDamageHubSocketAction(payload, { ok, error, result: ok ? result : [] });
    return;
  }
  if (payload.action !== "applyDamage") return;
  if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
  await applyDamageApplication(payload.request);
}

function registerDamageTimeHooks() {
  if (damageTimeHooksRegistered) return;
  timedDamageActorIndex ??= registerWorldTimeActorCandidateIndex(actorHasTimedDamageTimeWork);
  Hooks.on("combatStart", combat => {
    if (!game.user?.isActiveGM) return;
    combatRoundWorldTimes.set(combat.id, Number(game.time?.worldTime) || 0);
  });
  Hooks.on("deleteCombat", combat => combatRoundWorldTimes.delete(combat.id));
  registerCombatRoundStartHandler(advanceWorldTimeForCombatRound);
  registerQueuedWorldTimeProcessor(processTimedDamageEffects, { priority: 100 });
  Hooks.on("preDeleteActiveEffect", preventIgnoredTimedDamageEffectDeletion);
  Hooks.on("preUpdateActiveEffect", preventManagedTimedDamageEffectExpiration);
  Hooks.on("deleteActiveEffect", effect => {
    void applyStoredFirstAidWithdrawalOnDelete(effect);
  });
  damageTimeHooksRegistered = true;
}

async function advanceWorldTimeForCombatRound({ combat, round, skipped = false } = {}) {
  if (!game.user?.isActiveGM || !combat?.started) return;
  const currentRound = toInteger(round);
  if (skipped || currentRound <= 1) return;

  const roundSeconds = getRoundSeconds();
  const previousWorldTime = combatRoundWorldTimes.get(combat.id) ?? (Number(game.time?.worldTime) || 0);
  const currentWorldTime = Number(game.time?.worldTime) || 0;
  const elapsed = Math.max(0, currentWorldTime - previousWorldTime);
  if (elapsed < roundSeconds) await advanceWorldTime(roundSeconds - elapsed, { source: "combatRound" });
  combatRoundWorldTimes.set(combat.id, Number(game.time?.worldTime) || currentWorldTime + roundSeconds);
}

function getRoundSeconds() {
  if (CONFIG.time) CONFIG.time.roundTime = ROUND_SECONDS;
  return ROUND_SECONDS;
}

async function processTimedDamageEffects(worldTime, deltaTime) {
  const dt = Number(deltaTime) || 0;
  if (!game.user?.isActiveGM || dt <= 0) return;
  if (!await hasTimedDamageWorldTimeWork()) return;
  return runDamageHubOperation(async () => {
    const clock = Number(game.time?.worldTime) || 0;
    let wt = Number(worldTime) || 0;
    let dtInner = Number(deltaTime) || 0;
    if (clock > wt) {
      dtInner += clock - wt;
      wt = clock;
    }
    return processTimedDamageEffectsNow(wt, dtInner);
  });
}

async function hasTimedDamageWorldTimeWork() {
  const actors = await timedDamageActorIndex.values();
  if (!actors.next().done) return true;
  return (globalThis.canvas?.scene?.regions?.contents ?? []).some(region => (
    (region.behaviors?.contents ?? []).some(behavior => behavior.type === REGION_DAMAGE_BEHAVIOR_TYPE)
  ));
}

async function processTimedDamageEffectsNow(worldTime, deltaTime) {
  const elapsed = Number(deltaTime) || 0;
  if (getTimeMechanicsIgnored()) {
    await preserveTimedDamageEffects(elapsed);
    await preserveRegionPeriodicDamage(elapsed);
    return;
  }
  const now = Number(worldTime) || Number(game.time?.worldTime) || 0;
  await processRegionPeriodicDamage(now, elapsed);
  const damageResults = [];
  for (const actor of await timedDamageActorIndex.values()) {
    if (!actor?.isOwner) continue;
    await queueActorDamageMutation(actor.uuid, async freshActor => {
      if (!freshActor?.isOwner) return;
      const entries = [];
      const effectUpdates = [];
      const effectDeleteIds = new Set();
      const lockedEffectUuids = new Set();
      let refreshManagedExpiry = false;

      for (const effect of Array.from(freshActor.effects ?? [])) {
        const damageChanges = getDamageEffectChanges(effect).filter(isDamageHubManagedTimedEffect);
        const periodicHealingChanges = getPeriodicHealingEffectChanges(effect);
        const flagData = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
        const flagManaged = isFlagManagedTimedEffect(flagData);
        if (effect.disabled || (!damageChanges.length && !flagManaged && !periodicHealingChanges.length)) continue;
        if (!effect.uuid || processingPeriodicEffectUuids.has(effect.uuid)) continue;
        const tickResults = [];
        if (damageChanges.length) {
          tickResults.push(collectDamageHubManagedTimedEffectTicks(effect, damageChanges, now));
        } else if (flagManaged) {
          tickResults.push(collectFlagManagedTimedEffectTicks(effect, flagData, now));
        }
        if (periodicHealingChanges.length) {
          tickResults.push(collectAbilityPeriodicHealingEffectTicks(
            effect,
            periodicHealingChanges,
            freshActor,
            now,
            now - elapsed
          ));
        }
        if (!tickResults.some(result => (
          result.entries.length || result.update || result.deleteEffectId || result.refreshExpiry
        ))) continue;
        processingPeriodicEffectUuids.add(effect.uuid);
        lockedEffectUuids.add(effect.uuid);
        for (const tickResult of tickResults) {
          entries.push(...tickResult.entries);
          if (tickResult.update) effectUpdates.push(tickResult.update);
          if (tickResult.deleteEffectId) effectDeleteIds.add(tickResult.deleteEffectId);
          if (tickResult.refreshExpiry) refreshManagedExpiry = true;
        }
      }

      try {
        for (const update of effectUpdates) {
          if (effectDeleteIds.has(update.effectId)) continue;
          const effect = freshActor.effects?.get(update.effectId);
          if (!effect) continue;
          await updatePeriodicEffect(effect, update.data);
        }
        await deletePeriodicEffects(freshActor, Array.from(effectDeleteIds));
        const damageEntries = entries.filter(entry => entry.mode !== MODE_HEALING);
        const healingEntries = entries.filter(entry => entry.mode === MODE_HEALING);
        if (damageEntries.length) damageResults.push(await applyPeriodicDamageBatch(freshActor, damageEntries));
        if (healingEntries.length) {
          const healingRequests = healingEntries.map(entry => ({
            actorUuid: freshActor.uuid,
            amount: entry.amount,
            damageTypeKey: entry.damageTypeKey || HEALING_DAMAGE_TYPE_KEY,
            mode: MODE_HEALING,
            scope: SCOPE_HEALTH,
            applyMitigation: false,
            processDamageTypeSettings: false,
            source: {
              ...(entry.source ?? {})
            }
          }));
          await executeDamageSystemEventWorkflow(
            healingRequests,
            allowedRequests => applyDamageApplicationsNow({
              actorUuid: freshActor.uuid,
              requests: allowedRequests
            }, { createSummary: false }),
            { batch: healingRequests.length > 1 }
          );
        }
        if (refreshManagedExpiry) await refreshManagedTimedEffectExpiration(freshActor);
      } finally {
        for (const uuid of lockedEffectUuids) processingPeriodicEffectUuids.delete(uuid);
      }
    });
  }
  await publishDamageSummaryMessage(damageResults);
  await notifyDamageApplied(damageResults);
}

async function processRegionPeriodicDamage(now = 0, deltaTime = 0) {
  const batches = [];
  const previousTime = Math.max(0, (Number(now) || 0) - Math.max(0, Number(deltaTime) || 0));
  for (const scene of getPeriodicDamageScenes()) {
    for (const region of scene.regions?.contents ?? []) {
      if (region.hidden) continue;
      for (const behavior of region.behaviors?.contents ?? []) {
        if (behavior.disabled || behavior.type !== REGION_DAMAGE_BEHAVIOR_TYPE) continue;
        const batch = await collectRegionPeriodicDamageBehavior(region, behavior, Number(now) || 0, previousTime);
        if (batch) batches.push(batch);
      }
    }
  }
  if (!batches.length) return;

  for (const batch of batches) {
    if (batch.dueTicks > 0) await updateRegionPeriodicDamageRadius(batch.region, batch.system, batch.dueTicks);
    if (batch.shouldExpire) {
      await expireRegionPeriodicDamage(batch.region, batch.behavior, batch.system);
      continue;
    }
    if (batch.dueTicks > 0) {
      await batch.behavior.setFlag(SYSTEM_ID, REGION_DAMAGE_FLAG_KEY, {
        ...batch.state,
        nextTickTime: batch.nextTickTime
      });
    }
  }

  const requests = batches.flatMap(batch => batch.requests);
  if (requests.length) {
    await spendDodgeForAreaDamageRequests(requests);
    await applyDamageCycleNow(requests);
  }
}

async function collectRegionPeriodicDamageBehavior(region, behavior, now = 0, previousTime = now) {
  const system = behavior.system ?? {};
  const entries = getRegionPeriodicDamageEntries(system);

  const intervalSeconds = Math.max(1, toInteger(system.intervalSeconds) || ROUND_SECONDS);
  const delaySeconds = Math.max(0, toInteger(system.delaySeconds));
  const durationSeconds = Math.max(0, toInteger(system.durationSeconds));
  const hasRadiusWork = Math.abs(Number(system.radiusDeltaMeters) || 0) > 0;
  const hasRegionSpecialProperties = Boolean(getSmokeSpecialProperty(system.regionSpecialProperties));
  if (!entries.length && !hasRadiusWork && durationSeconds <= 0
    && (!hasRegionSpecialProperties || delaySeconds <= 0)) return null;
  const state = await getRegionPeriodicDamageState(behavior, {
    now,
    previousTime,
    intervalSeconds,
    delaySeconds,
    durationSeconds
  });
  if (!state) return null;

  const expiresAt = toOptionalFiniteNumber(state.expiresAt);
  if (!entries.length && !hasRadiusWork) {
    if (!Number.isFinite(expiresAt) || now < expiresAt) return null;
    return {
      region,
      behavior,
      system,
      state,
      nextTickTime: Number(state.nextTickTime),
      dueTicks: 0,
      shouldExpire: true,
      requests: []
    };
  }
  let nextTickTime = Number(state.nextTickTime);
  if (!Number.isFinite(nextTickTime)) nextTickTime = now + intervalSeconds;

  const tickTimes = [];
  while (now >= nextTickTime && (!Number.isFinite(expiresAt) || nextTickTime <= expiresAt)) {
    tickTimes.push(nextTickTime);
    nextTickTime += intervalSeconds;
  }
  const dueTicks = tickTimes.length;

  const shouldExpire = Number.isFinite(expiresAt) && now >= expiresAt;
  if (!dueTicks && !shouldExpire) return null;

  return {
    region,
    behavior,
    system,
    state,
    nextTickTime,
    dueTicks,
    shouldExpire,
    requests: dueTicks > 0 ? buildRegionPeriodicDamageRequests(region, behavior, entries, tickTimes) : []
  };
}

async function getRegionPeriodicDamageState(behavior, { now = 0, previousTime = now, intervalSeconds = ROUND_SECONDS, delaySeconds = 0, durationSeconds = 0 } = {}) {
  const current = behavior.getFlag(SYSTEM_ID, REGION_DAMAGE_FLAG_KEY) ?? {};
  if (Number.isFinite(Number(current.startedAt))) return current;

  const startedAt = Number.isFinite(Number(previousTime)) ? Math.max(0, Number(previousTime)) : (Number(now) || 0);
  const activateAt = startedAt + Math.max(0, toInteger(delaySeconds));
  const hasDelay = Math.max(0, toInteger(delaySeconds)) > 0;
  const state = {
    startedAt,
    activateAt,
    expiresAt: durationSeconds > 0 ? activateAt + durationSeconds : null,
    nextTickTime: hasDelay ? activateAt : activateAt + Math.max(1, toInteger(intervalSeconds) || ROUND_SECONDS)
  };
  await behavior.setFlag(SYSTEM_ID, REGION_DAMAGE_FLAG_KEY, state);
  return state;
}

function buildRegionPeriodicDamageRequests(region, behavior, entries = [], tickTimes = []) {
  const damageEntries = entries.map(entry => ({
    ...entry,
    amount: String(entry.amount ?? "0").trim() || "0"
  }));
  const times = (Array.isArray(tickTimes) ? tickTimes : [])
    .map(time => Number(time))
    .filter(Number.isFinite);
  if (!times.length) times.push(Number(game.time?.worldTime) || 0);
  const requests = [];
  for (const token of getTokensInsideRegion(region, behavior)) {
    if (!token.actor) continue;
    const limbKey = selectRandomDamageLimbKey(token.actor);
    for (const worldTime of times) {
      const source = {
        regionUuid: region.uuid,
        behaviorUuid: behavior.uuid,
        tokenId: token.id,
        kind: "regionPeriodicDamage",
        damagePacketId: foundry.utils.randomID(),
        dueTicks: 1,
        worldTime
      };
      for (const entry of damageEntries) {
        const damageTypeKey = String(entry?.damageTypeKey ?? "").trim();
        const amount = evaluateActorFormula(entry?.amount, token.actor, {
          minimum: 0,
          context: "region periodic damage"
        });
        if (!damageTypeKey || amount <= 0) continue;
        requests.push({
          actor: token.actor,
          limbKey,
          amount,
          damageTypeKey,
          scope: SCOPE_HEALTH_AND_LIMB,
          source
        });
      }
    }
  }
  return requests;
}

function getRegionPeriodicDamageEntries(system = {}) {
  return Array.isArray(system.damageEntries)
    ? system.damageEntries
      .map(entry => ({
        damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
        amount: String(entry?.amount ?? "0").trim() || "0"
      }))
      .filter(entry => entry.damageTypeKey && isFormulaTextConfigured(entry.amount))
    : [];
}

function getTokensInsideRegion(region, behavior = null) {
  const scene = region?.parent;
  if (!scene) return [];
  return (scene.tokens?.contents ?? [])
    .filter(token => {
      if (!token?.actor || !regionBehaviorTargetsActor(region, behavior, token.actor)) return false;
      try {
        return token.testInsideRegion(region);
      } catch (_error) {
        return false;
      }
    });
}

async function updateRegionPeriodicDamageRadius(region, system = {}, dueTicks = 1) {
  const deltaMeters = Number(system.radiusDeltaMeters) || 0;
  if (!deltaMeters || !region?.parent?.regions?.has(region.id)) return;
  const deltaPixels = metersToPixelsForScene(deltaMeters * Math.max(1, toInteger(dueTicks)), region.parent);
  const shapes = region.shapes.map(shape => {
    const data = shape.toObject ? shape.toObject() : foundry.utils.deepClone(shape);
    if (data.type !== "circle") return data;
    return {
      ...data,
      radius: Math.max(0, (Number(data.radius) || 0) + deltaPixels)
    };
  });
  const update = { shapes };
  const centerElevation = getSphericalRegionCenterElevation(region);
  if (centerElevation !== null) {
    update.elevation = getSphericalRegionElevation(
      centerElevation,
      getMaximumCircleRadiusPixels(shapes),
      region.parent
    );
  }
  await region.update(update);
}

async function expireRegionPeriodicDamage(region, behavior, system = {}) {
  if (system.deleteRegionWhenExpired !== false && region?.parent?.regions?.has(region.id)) {
    await region.delete();
    return;
  }
  if (behavior?.parent?.behaviors?.has(behavior.id)) await behavior.update({ disabled: true });
}

function metersToPixelsForScene(meters, scene = null) {
  const gridDistance = Math.max(0.0001, Number(scene?.grid?.distance ?? canvas?.scene?.grid?.distance ?? canvas?.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(scene?.grid?.size ?? canvas?.grid?.size) || 100);
  return Number(meters || 0) * (gridSize / gridDistance);
}

async function preserveRegionPeriodicDamage(deltaTime) {
  const elapsed = Math.max(0, Number(deltaTime) || 0);
  if (!elapsed) return;

  for (const scene of getPeriodicDamageScenes()) {
    for (const region of scene.regions?.contents ?? []) {
      for (const behavior of region.behaviors?.contents ?? []) {
        if (behavior.type !== REGION_DAMAGE_BEHAVIOR_TYPE) continue;
        const state = behavior.getFlag(SYSTEM_ID, REGION_DAMAGE_FLAG_KEY);
        if (!state) continue;

        const updateData = {};
        for (const key of ["startedAt", "activateAt", "expiresAt", "nextTickTime"]) {
          const value = Number(state[key]);
          if (Number.isFinite(value)) updateData[`flags.${SYSTEM_ID}.${REGION_DAMAGE_FLAG_KEY}.${key}`] = value + elapsed;
        }
        if (Object.keys(updateData).length) await behavior.update(updateData);
      }
    }
  }
}

async function preserveTimedDamageEffects(deltaTime) {
  const elapsed = Math.max(0, Number(deltaTime) || 0);
  if (!elapsed) return;

  for (const actor of await timedDamageActorIndex.values()) {
    if (!actor?.isOwner) continue;
    for (const effect of Array.from(actor.effects ?? [])) {
      if (effect.disabled) continue;
      const damageChanges = getDamageEffectChanges(effect).filter(isDamageHubManagedTimedEffect);
      const periodicHealingChanges = getPeriodicHealingEffectChanges(effect);
      const flagData = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
      const updateData = damageChanges.length
        ? buildIgnoredDamageEffectChangesUpdate(effect, damageChanges, elapsed)
        : {};
      if (isFlagManagedTimedEffect(flagData)) {
        Object.assign(updateData, buildIgnoredTimedDamageEffectUpdate(effect, flagData, elapsed));
      }
      if (periodicHealingChanges.length) {
        const startTime = Number(effect?.start?.time);
        if (Number.isFinite(startTime)) updateData["start.time"] = startTime + elapsed;
      }
      if (!Object.keys(updateData).length) continue;
      await updatePeriodicEffect(effect, updateData);
    }
  }
}

function buildIgnoredDamageEffectChangesUpdate(effect, damageChanges = [], elapsed = 0) {
  const changes = getEffectChangeSource(effect);
  const nextChanges = [...changes];
  let changed = false;
  for (const data of damageChanges) {
    if (data.kind !== PERIODIC_DAMAGE_EFFECT_KIND && data.kind !== BLEEDING_DAMAGE_EFFECT_KIND) continue;
    const nextData = { ...data };
    for (const key of ["startTime", "endTime", "nextTickTime"]) {
      const value = Number(nextData[key]);
      if (Number.isFinite(value)) {
        nextData[key] = value + elapsed;
        changed = true;
      }
    }
    nextChanges[data.changeIndex] = {
      ...changes[data.changeIndex],
      value: serializeDamageEffectChangeData(nextData)
    };
  }
  return changed ? { "system.changes": nextChanges } : {};
}

function buildIgnoredTimedDamageEffectUpdate(effect, data, elapsed) {
  if (data?.kind === "periodicHealing" || data?.kind === FIRST_AID_TEMPORARY_EFFECT_KIND || data?.kind === FIRST_AID_WITHDRAWAL_EFFECT_KIND) {
    const updateData = {};
    const startTime = Number(data.startTime);
    const endTime = Number(data.endTime);
    const nextTickTime = Number(data.nextTickTime);
    if (Number.isFinite(startTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.startTime`] = startTime + elapsed;
    if (Number.isFinite(endTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.endTime`] = endTime + elapsed;
    if (Number.isFinite(nextTickTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.nextTickTime`] = nextTickTime + elapsed;
    return updateData;
  }

  if (data?.kind === "resourceLimit" || data?.kind === "resourceBlock") {
    const startTime = Number(effect.duration?.startTime);
    if (Number.isFinite(startTime)) return { "duration.startTime": startTime + elapsed };
  }

  return {};
}

function preventIgnoredTimedDamageEffectDeletion(effect, options = {}, _userId) {
  if (options?.falloutMawAllowManagedTimedDamageExpiration) return undefined;
  if (isManagedTimedDamageEffect(effect) && (Number(effect.duration?.remaining) <= 0 || effect.duration?.expired)) {
    return effect.duration?.expiry === MANAGED_TIMED_DAMAGE_EXPIRY ? undefined : false;
  }
  if (!getTimeMechanicsIgnored()) return undefined;
  const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
  if (data?.kind !== "resourceLimit" && data?.kind !== "resourceBlock") return undefined;
  if (!Number(effect.duration?.seconds)) return undefined;
  const remaining = Number(effect.duration?.remaining);
  if (Number.isFinite(remaining) && remaining <= 0) return false;
  return undefined;
}

function preventManagedTimedDamageEffectExpiration(effect, changes = {}, options = {}, _userId) {
  if (options?.falloutMawAllowManagedTimedDamageExpiration) return undefined;
  if (!isManagedTimedDamageEffect(effect)) return undefined;
  const expired = foundry.utils.getProperty(changes, "duration.expired");
  return expired === true ? false : undefined;
}

function isManagedTimedDamageEffect(effect) {
  return Boolean(
    effect?.getFlag?.(TRAUMA_FLAG_SCOPE, MANAGED_TIMED_DAMAGE_FLAG_KEY)
    || getPeriodicHealingEffectChanges(effect).length
  );
}

function isDamageHubManagedTimedEffect(data) {
  return data?.kind === PERIODIC_DAMAGE_EFFECT_KIND
    || data?.kind === BLEEDING_DAMAGE_EFFECT_KIND;
}

function isFlagManagedTimedEffect(data) {
  return data?.kind === "periodicHealing"
    || data?.kind === FIRST_AID_TEMPORARY_EFFECT_KIND
    || data?.kind === FIRST_AID_WITHDRAWAL_EFFECT_KIND;
}

function isLimbTimedDamageEffect(data) {
  return data?.kind === PERIODIC_DAMAGE_EFFECT_KIND || data?.kind === BLEEDING_DAMAGE_EFFECT_KIND;
}

function collectDamageHubManagedTimedEffectTicks(effect, damageChanges, now) {
  const changes = getEffectChangeSource(effect);
  const nextChanges = [...changes];
  const deleteIndexes = new Set();
  const entries = [];
  let changed = false;

  for (const data of damageChanges) {
    if (isLimbTimedDamageEffect(data) && data.limbKey && isLimbDestroyed(effect?.parent, data.limbKey)) {
      deleteIndexes.add(data.changeIndex);
      changed = true;
      continue;
    }

    const result = data.kind === BLEEDING_DAMAGE_EFFECT_KIND
      ? collectBleedingDamageEffectTicks(effect, data, now)
      : collectPeriodicDamageEffectTicks(effect, data, now);
    entries.push(...result.entries);
    if (result.deleteEffectId) {
      deleteIndexes.add(data.changeIndex);
      changed = true;
    } else if (result.data) {
      nextChanges[data.changeIndex] = {
        ...changes[data.changeIndex],
        value: serializeDamageEffectChangeData(result.data)
      };
      changed = true;
    }
  }

  const remainingChanges = nextChanges.filter((_change, index) => !deleteIndexes.has(index));
  const remainingDamageChanges = remainingChanges
    .map((change, index) => parseDamageEffectChange(change, index))
    .filter(isDamageHubManagedTimedEffect);
  const deleteEffectId = !remainingDamageChanges.length
    && changes.every((change, index) => deleteIndexes.has(index) || parseDamageEffectChange(change, index))
    ? effect.id
    : "";

  return {
    entries,
    update: changed && !deleteEffectId ? { effectId: effect.id, data: { "system.changes": remainingChanges } } : null,
    deleteEffectId
  };
}

function collectFlagManagedTimedEffectTicks(effect, data, now) {
  if (data.kind === "periodicHealing") return collectPeriodicHealingEffectTicks(effect, data, now);
  if (data.kind === FIRST_AID_TEMPORARY_EFFECT_KIND || data.kind === FIRST_AID_WITHDRAWAL_EFFECT_KIND) {
    return collectFirstAidTemporaryEffectTicks(effect, data, now);
  }
  return { entries: [], update: null, deleteEffectId: "" };
}

function collectAbilityPeriodicHealingEffectTicks(effect, changes, actor, now, previousTime) {
  const startTime = Number(effect?.start?.time);
  const durationSeconds = getPeriodicHealingEffectDurationSeconds(effect);
  const dueTicks = countPeriodicHealingTicks({
    startTime,
    previousTime,
    currentTime: now,
    durationSeconds
  });
  const amountPerTick = evaluatePeriodicHealingPerTick(changes, change => (
    evaluateActorEffectChangeBaseNumber(actor, { ...change, effect }, {
      fallback: Number(change?.value),
      stage: "prepared"
    })
  ));
  const sourceActor = getPeriodicHealingSourceActor(effect, actor);
  const operationId = `periodic-healing:${String(effect?.uuid ?? effect?.id ?? "")}:${Number(now) || 0}`;
  const outgoingPercent = amountPerTick > 0
    ? getActorHealingModifierPercent(sourceActor, "outgoing", {
      targetActor: actor,
      chanceOperationId: operationId
    })
    : 0;
  const effectivePerTick = applyHealingModifierPercent(amountPerTick, outgoingPercent);
  const reachedEnd = Number.isFinite(durationSeconds)
    && Number.isFinite(startTime)
    && Number(now) >= startTime + durationSeconds;
  const usesManagedExpiry = effect?.duration?.expiry === MANAGED_TIMED_DAMAGE_EXPIRY;
  const sourceActorUuid = String(sourceActor?.uuid ?? actor?.uuid ?? "");
  const entries = dueTicks > 0 && effectivePerTick > 0
    ? [{
      mode: MODE_HEALING,
      amount: effectivePerTick * dueTicks,
      damageTypeKey: HEALING_DAMAGE_TYPE_KEY,
      scope: SCOPE_HEALTH,
      source: {
        kind: "abilityPeriodicHealing",
        sourceActorUuid,
        sourceItemUuid: getPeriodicHealingSourceItemUuid(effect),
        periodicHealingEffectUuid: String(effect?.uuid ?? ""),
        dueTicks,
        chanceOperationId: operationId,
        limitedUseOperationId: operationId,
        worldTime: Number(now) || 0
      }
    }]
    : [];
  return {
    entries,
    update: null,
    deleteEffectId: reachedEnd && !usesManagedExpiry ? String(effect?.id ?? "") : "",
    refreshExpiry: reachedEnd && usesManagedExpiry
  };
}

function getPeriodicHealingEffectDurationSeconds(effect) {
  const seconds = Number(effect?.duration?.seconds);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : Number.POSITIVE_INFINITY;
}

function getPeriodicHealingSourceActor(effect, fallbackActor = null) {
  const systemFlags = effect?.flags?.[SYSTEM_ID] ?? {};
  const actorUuids = Object.values(systemFlags)
    .filter(value => value && typeof value === "object")
    .map(value => String(value?.sourceActorUuid ?? "").trim())
    .filter(Boolean);
  for (const uuid of actorUuids) {
    const actor = resolvePeriodicHealingSourceDocument(uuid, effect);
    if (actor) return actor;
  }

  const origin = resolvePeriodicHealingSourceDocument(String(effect?.origin ?? ""), effect);
  if (origin?.documentName === "Actor") return origin;
  if (origin?.parent?.documentName === "Actor") return origin.parent;
  return fallbackActor;
}

function getPeriodicHealingSourceItemUuid(effect) {
  const origin = resolvePeriodicHealingSourceDocument(String(effect?.origin ?? ""), effect);
  return origin?.documentName === "Item" ? String(origin.uuid ?? effect?.origin ?? "") : "";
}

function resolvePeriodicHealingSourceDocument(uuid = "", relative = null) {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  try {
    return globalThis.fromUuidSync?.(value, { relative })
      ?? globalThis.foundry?.utils?.fromUuidSync?.(value, { relative })
      ?? null;
  } catch (_error) {
    return null;
  }
}

function collectPeriodicDamageEffectTicks(effect, data, now) {
  const intervalSeconds = Math.max(1, toInteger(data.intervalSeconds || ROUND_SECONDS));
  let remainingTicks = Math.max(0, toInteger(data.remainingTicks));
  let nextTickTime = Number(data.nextTickTime) || ((Number(data.startTime) || 0) + intervalSeconds);
  const tickTimes = [];

  while (remainingTicks > 0 && now >= nextTickTime) {
    tickTimes.push(nextTickTime);
    remainingTicks -= 1;
    nextTickTime += intervalSeconds;
  }

  const entries = tickTimes.map((worldTime, tickIndex) => ({
      limbKey: data.limbKey,
      amount: roundDamageAmount(Number(data.amountPerTick) || 0),
      damageTypeKey: data.damageTypeKey,
      scope: data.scope,
      source: {
        ...(data.source ?? {}),
        periodicDamageEffectUuid: effect.uuid,
        damagePacketId: getTimedDamageTickPacketId(effect, worldTime, data.sourceIdentity),
        dueTicks: 1,
        tickIndex,
        worldTime
      }
    }));
  const shouldDelete = remainingTicks <= 0 || (Number(data.endTime) && now >= Number(data.endTime) && !tickTimes.length);
  return {
    entries: entries.filter(entry => entry.amount > 0),
    data: !shouldDelete && tickTimes.length ? { ...data, remainingTicks, nextTickTime } : null,
    deleteEffectId: shouldDelete ? effect.id : ""
  };
}

function collectBleedingDamageEffectTicks(effect, data, now) {
  const intervalSeconds = Math.max(1, toInteger(data.intervalSeconds || ROUND_SECONDS));
  const tickAmounts = Array.isArray(data.tickAmounts) ? data.tickAmounts.map(amount => Math.max(0, toInteger(amount))) : [];
  const totalTicks = Math.max(tickAmounts.length, toInteger(data.totalTicks));
  let remainingTicks = Math.max(0, toInteger(data.remainingTicks));
  let nextTickTime = Number(data.nextTickTime) || ((Number(data.startTime) || 0) + intervalSeconds);
  const tickTimes = [];

  while (remainingTicks > 0 && now >= nextTickTime) {
    tickTimes.push(nextTickTime);
    remainingTicks -= 1;
    nextTickTime += intervalSeconds;
  }

  const startIndex = Math.max(0, totalTicks - toInteger(data.remainingTicks));
  const entries = tickTimes.length
    ? buildBleedingDamageTickRequests(effect, data, startIndex, tickTimes)
    : [];
  const shouldDelete = remainingTicks <= 0 || (Number(data.endTime) && now >= Number(data.endTime) && !tickTimes.length);
  return {
    entries: entries.filter(entry => entry.amount > 0),
    data: !shouldDelete && tickTimes.length ? { ...data, remainingTicks, nextTickTime } : null,
    deleteEffectId: shouldDelete ? effect.id : ""
  };
}

function buildBleedingDamageTickRequests(effect, data = {}, startIndex = 0, tickTimes = []) {
  if (data.limbKey && isLimbDestroyed(effect?.parent, data.limbKey)) return [];
  const amounts = Array.isArray(data.tickAmounts) ? data.tickAmounts : [];
  return tickTimes.map((worldTime, tickIndex) => ({
    limbKey: data.limbKey,
    amount: Math.max(0, toInteger(amounts[startIndex + tickIndex])),
    damageTypeKey: BLEEDING_DAMAGE_TYPE_KEY,
    scope: data.scope,
    source: markBleedingDamageTickSource({
      ...(data.source ?? {}),
      bleedingDamageEffectUuid: effect.uuid,
      damagePacketId: getTimedDamageTickPacketId(effect, worldTime),
      dueTicks: 1,
      tickIndex,
      worldTime
    })
  })).filter(entry => entry.amount > 0);
}

function getTimedDamageTickPacketId(effect, worldTime, sourceIdentity = "") {
  const identity = String(sourceIdentity ?? "").trim();
  const identitySuffix = identity ? `:${identity}` : "";
  return `timed:${String(effect?.uuid ?? effect?.id ?? "effect")}${identitySuffix}:${Number(worldTime) || 0}`;
}

function collectPeriodicHealingEffectTicks(effect, data, now) {
  const intervalSeconds = Math.max(1, toInteger(data.intervalSeconds || ROUND_SECONDS));
  let remainingTicks = Math.max(0, toInteger(data.remainingTicks));
  let nextTickTime = Number(data.nextTickTime) || ((Number(data.startTime) || 0) + intervalSeconds);
  let dueTicks = 0;

  while (remainingTicks > 0 && now >= nextTickTime) {
    dueTicks += 1;
    remainingTicks -= 1;
    nextTickTime += intervalSeconds;
  }

  const entries = dueTicks > 0
    ? [{
      mode: MODE_HEALING,
      amount: roundDamageAmount((Number(data.amountPerTick) || 0) * dueTicks),
      damageTypeKey: HEALING_DAMAGE_TYPE_KEY,
      scope: SCOPE_HEALTH,
      source: {
        ...(data.source ?? {}),
        periodicHealingEffectUuid: effect.uuid,
        dueTicks,
        worldTime: Number.isFinite(Number(now)) ? Number(now) : (Number(game.time?.worldTime) || 0)
      }
    }]
    : [];
  const reachedEnd = remainingTicks <= 0 || hasTimedEffectReachedEnd(effect, data, now);
  const hasFoundryDuration = Number(effect.duration?.seconds) > 0;
  const usesManagedExpiry = effect.duration?.expiry === MANAGED_TIMED_DAMAGE_EXPIRY;
  const shouldDelete = reachedEnd && !hasFoundryDuration;
  return {
    entries: entries.filter(entry => entry.amount > 0),
    update: !reachedEnd && dueTicks > 0
      ? {
        effectId: effect.id,
        data: {
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.remainingTicks`]: remainingTicks,
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.nextTickTime`]: nextTickTime
        }
      }
      : null,
    deleteEffectId: shouldDelete ? effect.id : "",
    refreshExpiry: reachedEnd && usesManagedExpiry
  };
}

function collectFirstAidTemporaryEffectTicks(effect, data, now) {
  const reachedEnd = hasTimedEffectReachedEnd(effect, data, now);
  const hasFoundryDuration = Number(effect.duration?.seconds) > 0;
  return {
    entries: [],
    update: null,
    deleteEffectId: reachedEnd && !hasFoundryDuration ? effect.id : "",
    refreshExpiry: reachedEnd && effect.duration?.expiry === MANAGED_TIMED_DAMAGE_EXPIRY
  };
}

async function refreshManagedTimedEffectExpiration(actor) {
  const ActiveEffectClass = foundry.documents?.ActiveEffect?.implementation ?? globalThis.ActiveEffect;
  if (!ActiveEffectClass?.registry?.refresh || !actor) return;
  await ActiveEffectClass.registry.refresh(MANAGED_TIMED_DAMAGE_EXPIRY, {
    actors: new Set([actor])
  });
}

async function updatePeriodicEffect(effect, updateData = {}) {
  try {
    if (!effect?.parent?.effects?.has(effect.id)) return;
    await effect.update(updateData, getDamageActiveEffectOperationOptions());
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
  }
}

function getDamageActiveEffectOperationOptions() {
  return { animate: false };
}

async function deletePeriodicEffects(actor, effectIds = []) {
  await deleteActorActiveEffects(actor, effectIds);
}

function isMissingDocumentError(error) {
  return /does not exist/i.test(String(error?.message ?? error ?? ""));
}

async function applyPeriodicDamageBatch(actor, entries = []) {
  const requests = combinePeriodicDamageEntries(entries)
    .map(entry => ({
      actorUuid: actor.uuid,
      limbKey: entry.limbKey,
      amount: roundDamageAmount(entry.amount),
      damageTypeKey: entry.damageTypeKey,
      scope: entry.scope,
      applyMitigation: true,
      processDamageTypeSettings: true,
      source: markPeriodicDamageTickSource(entry.source)
    }))
    .filter(entry => entry.amount > 0);
  if (!requests.length) return [];
  return applyDamageApplicationsNow({ actorUuid: actor.uuid, requests }, { createSummary: false });
}

async function distributeManualHealthValueUpdate(actor, changes = {}) {
  if (isIndependentHealthModelActive(actor)) return false;
  const healthValuePath = "system.resources.health.value";
  if (!hasUpdatePath(changes, healthValuePath)) return false;

  const currentHealth = calculateAggregateHealth(actor);
  const requested = Math.min(
    Math.max(toInteger(getUpdatePath(changes, healthValuePath)), currentHealth.min),
    currentHealth.max
  );
  const delta = requested - currentHealth.value;

  deleteUpdatePath(changes, healthValuePath);
  deleteUpdatePath(changes, "system.resources.health.spent");
  if (!delta) return false;

  const mode = delta > 0 ? MODE_HEALING : MODE_DAMAGE;
  if (mode === MODE_HEALING && isHealingBlocked(actor)) return false;
  const amount = mode === MODE_HEALING
    ? applyHealingModifierPercent(Math.abs(delta), getActorHealingModifierPercent(actor, "incoming"))
    : Math.abs(delta);
  const result = await calculateManualAggregateHealthAdjustment(actor, amount, mode);
  for (const [limbKey, value] of Object.entries(result.values)) {
    setLimbValueUpdate(changes, actor, limbKey, value);
  }
  for (const [limbKey, accumulation] of result.damageAccumulation ?? new Map()) {
    changes[`system.limbs.${limbKey}.damageAccumulation`] = replaceDamageAccumulation(accumulation);
  }
  let consciousnessRecoveryDelta = result.limbDelta;
  if (result.prosthesisHealthAdjustments?.length) {
    const actualProsthesisHealthDelta = await applyManualProsthesisHealthAdjustments(
      actor,
      result.prosthesisHealthAdjustments
    );
    consciousnessRecoveryDelta += actualProsthesisHealthDelta;
  }
  if (mode === MODE_HEALING && consciousnessRecoveryDelta > 0) {
    mergeConsciousnessRecoveryUpdate(changes, actor, consciousnessRecoveryDelta);
  }
  return true;
}

function normalizeIndependentHealthValueUpdate(actor, changes = {}) {
  if (!isIndependentHealthModelActive(actor)) return false;
  const valuePath = "system.resources.health.value";
  if (!hasUpdatePath(changes, valuePath)) return false;
  const health = createIndependentHealthState(actor.system?.resources?.health);
  health.value = Math.min(
    health.max,
    Math.max(health.min, toInteger(getUpdatePath(changes, valuePath)))
  );
  setUpdatePath(changes, valuePath, health.value);
  setUpdatePath(changes, "system.resources.health.spent", Math.max(0, health.max - health.value));
  return true;
}

function registerConsciousnessHooks() {
  if (consciousnessHooksRegistered) return;
  consciousnessHooksRegistered = true;

  Hooks.on("preUpdateActiveEffect", (effect, _changes, options = {}) => {
    if (options?.[VITAL_STATUS_SYNCHRONIZATION_OPTION]) return;
    if (activeEffectMayAffectConsciousness(effect)) {
      options[ACTIVE_EFFECT_CONSCIOUSNESS_RELEVANCE_OPTION] = true;
    }
  });
  Hooks.on("createActiveEffect", (effect, options = {}) => {
    if (options?.[VITAL_STATUS_SYNCHRONIZATION_OPTION]) return;
    if (activeEffectMayAffectConsciousness(effect)) queueConsciousnessStatusSyncForEffect(effect);
  });
  Hooks.on("updateActiveEffect", (effect, changes = {}, options = {}) => {
    if (options?.[VITAL_STATUS_SYNCHRONIZATION_OPTION]) return;
    const relevant = Boolean(
      options?.[ACTIVE_EFFECT_CONSCIOUSNESS_RELEVANCE_OPTION]
      || activeEffectMayAffectConsciousness(effect)
    );
    if (!relevant) return;
    if (
      updateTouchesPath(changes, "system.changes")
      || updateTouchesPath(changes, "disabled")
      || updateTouchesPath(changes, "transfer")
      || updateTouchesPath(changes, "statuses")
    ) queueConsciousnessStatusSyncForEffect(effect);
  });
  Hooks.on("deleteActiveEffect", (effect, options = {}) => {
    if (options?.[VITAL_STATUS_SYNCHRONIZATION_OPTION]) return;
    if (activeEffectMayAffectConsciousness(effect)) queueConsciousnessStatusSyncForEffect(effect);
  });
  Hooks.on(`${SYSTEM_ID}.preparedActorsRefreshed`, actors => {
    if (!consciousnessStatusSynchronizationReady) return;
    for (const actor of actors ?? []) {
      if (canApplyDamageLocally(actor) && actorNeedsStartupVitalStatusSync(actor)) {
        void queueActorDamageStatusSync(actor);
      }
    }
  });
  Hooks.on(`${SYSTEM_ID}.consciousnessDocumentMigrated`, actor => {
    if (consciousnessStatusSynchronizationReady && canApplyDamageLocally(actor)) {
      void queueActorDamageStatusSync(actor);
    }
  });
  Hooks.on("canvasReady", () => {
    if (!consciousnessStatusSynchronizationReady) return;
    for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
      const actor = token?.actor;
      if (
        ["character", "construct"].includes(actor?.type)
        && canApplyDamageLocally(actor)
        && actorNeedsStartupVitalStatusSync(actor)
      ) {
        void queueActorDamageStatusSync(actor);
      }
    }
  });
}

function queueConsciousnessStatusSyncForEffect(effect) {
  if (!consciousnessStatusSynchronizationReady) return undefined;
  const actor = getActiveEffectActor(effect);
  if (!["character", "construct"].includes(actor?.type) || !canApplyDamageLocally(actor)) return undefined;
  return queueActorDamageStatusSync(actor);
}

function getActiveEffectActor(effect) {
  const parent = effect?.parent;
  if (parent?.documentName === "Actor") return parent;
  if (parent?.documentName === "Item") {
    return parent.actor ?? (parent.parent?.documentName === "Actor" ? parent.parent : null);
  }
  return null;
}

function activeEffectMayAffectConsciousness(effect) {
  if (Array.from(effect?.statuses ?? []).some(statusId => (
    INCAPACITATING_DODGE_OVERRIDE_STATUSES.has(String(statusId ?? "").trim())
  ))) return true;

  const consciousnessEnabled = isConsciousnessRulesEnabled(getActiveEffectActor(effect));
  return Array.from(effect?.system?.changes ?? []).some(change => {
    const key = String(change?.key ?? "").trim();
    return key.startsWith("system.resources.health.")
      || key.startsWith("system.limbs.")
      || (consciousnessEnabled && (
        key.startsWith(`system.resources.${CONSCIOUSNESS_RESOURCE_KEY}.`)
        || key.startsWith("system.characteristics.")
        || key.startsWith("system.skills.")
        || key === UNCONSCIOUSNESS_IMMUNITY_EFFECT_KEY
      ));
  });
}

async function applyDamageEntriesBatch(actor, entries = [], { deferredShockChecks = null } = {}) {
  const normalizedEntries = entries
    .map(entry => ({
      ...entry,
      amount: roundDamageAmount(entry.amount),
      scope: normalizeScope(entry.scope, entry.limbKey)
    }))
    .filter(entry => entry.amount > 0);
  if (!normalizedEntries.length) return { actor, amount: 0, healthDelta: 0, limbDelta: 0, createdTraumas: [], healthDeltasByType: [], resourceLimitEntries: [], bleedingEntries: [] };

  const updateData = {};
  let actualHealthDelta = 0;
  let prosthesisConditionDelta = 0;
  const limbStates = new Map();
  const damageAccumulation = new Map();
  const destructionCandidates = new Set();
  const shockChecks = [];
  const independentHealthRules = getIndependentHealthRules(actor);
  const independentHealthState = independentHealthRules
    ? createIndependentHealthState(actor.system?.resources?.health)
    : null;

  for (const entry of normalizedEntries) {
    const traumaDamageTypeKey = getTraumaDamageTypeKey(entry.damageTypeKey);
    const installedProsthesis = entry.limbKey && (entry.scope === SCOPE_LIMB || entry.scope === SCOPE_HEALTH_AND_LIMB)
      ? getInstalledProsthesis(actor, entry.limbKey)
      : null;
    if (
      entry.limbKey
      && (entry.scope === SCOPE_LIMB || entry.scope === SCOPE_HEALTH_AND_LIMB)
      && !installedProsthesis
      && !isLimbPhysicallyMissing(actor, entry.limbKey)
    ) destructionCandidates.add(entry.limbKey);
    let result;
    let independentHealthDelta = 0;
    if (independentHealthRules && installedProsthesis) {
      result = await calculateProsthesisLimbDamage(actor, entry.limbKey, entry.amount, {
        prosthesis: installedProsthesis,
        limbDamageMultiplier: getWeaponLimbDamageMultiplier(entry.source?.weaponData, entry.limbKey),
        damageType: entry.damageType,
        damageTypeKey: entry.damageTypeKey,
        traumaDamageTypeKey,
        limbStates,
        damageAccumulation
      });
      independentHealthDelta = applyIndependentHealthChange(
        independentHealthState,
        result.healthDelta,
        MODE_DAMAGE
      );
    } else if (independentHealthRules) {
      independentHealthDelta = applyIndependentHealthChange(
        independentHealthState,
        entry.amount,
        MODE_DAMAGE
      );
      result = entry.limbKey && (entry.scope === SCOPE_LIMB || entry.scope === SCOPE_HEALTH_AND_LIMB)
        ? calculateIndependentOrganicLimbDamage(actor, entry.limbKey, independentHealthDelta, {
          profileMultiplier: independentHealthRules.limbDamageFromLostHealthMultiplier,
          limbDamageMultiplier: getWeaponLimbDamageMultiplier(entry.source?.weaponData, entry.limbKey),
          damageType: entry.damageType,
          damageTypeKey: entry.damageTypeKey,
          traumaDamageTypeKey,
          limbStates,
          damageAccumulation
        })
        : createLimbMutationResult(limbStates, damageAccumulation);
    } else {
      result = installedProsthesis
        ? await calculateProsthesisLimbDamage(actor, entry.limbKey, entry.amount, {
          prosthesis: installedProsthesis,
          limbDamageMultiplier: getWeaponLimbDamageMultiplier(entry.source?.weaponData, entry.limbKey),
          damageType: entry.damageType,
          damageTypeKey: entry.damageTypeKey,
          traumaDamageTypeKey,
          limbStates,
          damageAccumulation
        })
        : entry.limbKey && (entry.scope === SCOPE_LIMB || entry.scope === SCOPE_HEALTH_AND_LIMB)
          ? await calculateTargetedLimbDamage(actor, entry.limbKey, entry.amount, {
            limbDamageMultiplier: getWeaponLimbDamageMultiplier(entry.source?.weaponData, entry.limbKey),
            damageType: entry.damageType,
            damageTypeKey: entry.damageTypeKey,
            traumaDamageTypeKey,
            limbStates,
            damageAccumulation
          })
          : await calculateEvenLimbDamage(actor, entry.amount, {
          damageType: entry.damageType,
          damageTypeKey: entry.damageTypeKey,
          traumaDamageTypeKey,
          limbStates,
          damageAccumulation
        });
    }
    const entryHealthDelta = independentHealthRules ? independentHealthDelta : result.healthDelta;
    if (installedProsthesis) prosthesisConditionDelta += Math.max(0, Number(result.limbDelta) || 0);
    actualHealthDelta += entryHealthDelta;
    entry.actualHealthDelta = Math.max(0, Number(entryHealthDelta) || 0);
    entry.actualLimbDelta = Math.max(0, Number(result.limbDelta) || 0);
    if (result.shockCheck) shockChecks.push(result.shockCheck);
  }

  if (independentHealthRules && actualHealthDelta > 0) {
    Object.assign(updateData, buildIndependentHealthUpdate(independentHealthState));
  }

  for (const [limbKey, state] of limbStates) {
    if (!state.totalDelta) continue;
    if (isConstructPartLimb(actor, limbKey)) continue;
    setLimbValueUpdate(updateData, actor, limbKey, state.nextValue, { persistValue: false });
  }
  for (const [limbKey, accumulation] of damageAccumulation) {
    if (isConstructPartLimb(actor, limbKey)) continue;
    updateData[`system.limbs.${limbKey}.damageAccumulation`] = replaceDamageAccumulation(accumulation);
  }

  if (Object.keys(updateData).length) {
    await actor.update(updateData, { falloutMawSkipDamageStatusSync: true });
  }
  if (actor?.type === "construct" && limbStates.size) {
    await syncConstructPartConditionValues(actor, limbStates);
  }
  for (const limbKey of limbStates.keys()) destructionCandidates.add(limbKey);
  const destroyedLimbKeys = destructionCandidates.size
    ? await applyDestroyedLimbConsequencesNow(actor, Array.from(destructionCandidates))
    : new Set();
  const shockCheck = aggregateNegativeLimbShockChecks(actor, shockChecks);
  if (shockCheck) await queueOrPerformNegativeLimbShockCheck(actor, shockCheck, deferredShockChecks, "damage");
  const destroyedLimbShockCheck = aggregateNegativeLimbShockChecks(actor, buildDestroyedLimbShockChecks(actor, destroyedLimbKeys));
  if (destroyedLimbShockCheck) {
    await queueOrPerformNegativeLimbShockCheck(actor, destroyedLimbShockCheck, deferredShockChecks, "destroyedLimb");
  }
  await queueActorDamageStatusSync(actor);
  const healthEntries = normalizedEntries;
  const requestedHealthDamage = healthEntries.reduce((sum, entry) => sum + entry.amount, 0);
  const healthDeltasByType = buildBatchDamageNumberEntries(healthEntries, actualHealthDelta, requestedHealthDamage);
  const resourceLimitEntries = buildBatchDamageNumberEntries(
    healthEntries.filter(entry => entry.processDamageTypeSettings !== false),
    actualHealthDelta,
    requestedHealthDamage
  );
  const bleedingEntries = buildBatchBleedingEntries(
    healthEntries.filter(entry => (
      entry.processDamageTypeSettings !== false
      && !isLimbTimedDamageBlocked(actor, entry.limbKey, entry.damageType, "bleeding")
    )),
    actualHealthDelta,
    requestedHealthDamage
  );
  const createdTraumas = [];
  const traumaPlans = [];
  for (const [limbKey, state] of limbStates) {
    if (!state.totalDelta) continue;
    if (destroyedLimbKeys.has(limbKey)) continue;
    const [damageTypeKey, latestDamage] = Object.entries(state.damageByType)
      .sort((left, right) => right[1] - left[1])
      .at(0) ?? ["untyped", state.totalDelta];
    const plan = prepareTriggeredTraumaPlan(actor, {
      limbKey,
      damageTypeKey,
      previousValue: state.previousValue,
      nextValue: state.nextValue,
      latestDamage,
      damageSnapshot: state.damageAccumulationSnapshot
    });
    if (plan.createData.length || plan.deleteIds.length) traumaPlans.push(plan);
  }
  createdTraumas.push(...await commitTriggeredTraumaPlans(actor, traumaPlans));

  const finishingBlowSource = selectBatchFinishingBlowSource(normalizedEntries);
  const totalLimbDelta = prosthesisConditionDelta
    + Array.from(limbStates.values()).reduce((sum, state) => sum + state.totalDelta, 0);
  const sourceDamageEntries = buildBatchSourceDamageEntries(healthEntries);
  const applicationDeltas = normalizedEntries.map(entry => ({
    damageEventIndex: entry.damageEventIndex,
    healthDelta: Math.max(0, Number(entry.actualHealthDelta) || 0),
    limbDelta: Math.max(0, Number(entry.actualLimbDelta) || 0)
  }));
  const finishingBlow = actualHealthDelta > 0 && finishingBlowSource
    ? await applyFinishingBlowIfEligible(actor, finishingBlowSource)
    : null;

  return {
    actor,
    amount: normalizedEntries.reduce((sum, entry) => sum + entry.amount, 0),
    healthDelta: actualHealthDelta,
    limbDelta: totalLimbDelta,
    limbDeltas: buildBatchLimbDeltaEntries(actor, limbStates),
    mode: MODE_DAMAGE,
    scope: SCOPE_HEALTH_AND_LIMB,
    healthDeltasByType,
    resourceLimitEntries,
    bleedingEntries,
    createdTraumas,
    sourceDamageEntries,
    applicationDeltas,
    source: finishingBlowSource?.source ?? {},
    finishingBlow
  };
}

function selectBatchFinishingBlowSource(entries = []) {
  const entry = entries.find(candidate => String(candidate?.source?.attackerUuid ?? "").trim());
  if (!entry) return null;
  return {
    limbKey: String(entry.limbKey ?? "").trim(),
    source: entry.source
  };
}

function combinePeriodicDamageEntries(entries = []) {
  const combined = new Map();
  for (const entry of entries) {
    const key = [
      String(entry.source?.damagePacketId ?? ""),
      String(entry.source?.worldTime ?? ""),
      String(entry.limbKey ?? ""),
      String(entry.damageTypeKey ?? ""),
      String(entry.scope ?? SCOPE_HEALTH)
    ].join("\u0000");
    const current = combined.get(key);
    if (current) current.amount += Math.max(0, Number(entry.amount) || 0);
    else combined.set(key, {
      limbKey: String(entry.limbKey ?? ""),
      damageTypeKey: String(entry.damageTypeKey ?? ""),
      scope: String(entry.scope ?? SCOPE_HEALTH),
      amount: Math.max(0, Number(entry.amount) || 0),
      source: entry.source && typeof entry.source === "object" ? entry.source : {}
    });
  }
  return Array.from(combined.values());
}

function combinePendingPeriodicDamageEffects(entries = []) {
  const combined = new Map();
  for (const entry of entries ?? []) {
    const damageTypeKey = String(entry.damageType?.key ?? "").trim();
    const limbKey = String(entry.limbKey ?? "").trim();
    const scope = String(entry.scope ?? SCOPE_HEALTH);
    const settings = entry.settings ?? {};
    const sourceIdentity = getPeriodicDamageSourceIdentity(entry.source)
      || foundry.utils.randomID();
    const key = [
      damageTypeKey,
      limbKey,
      scope,
      toInteger(settings.tickCount),
      toInteger(settings.intervalSeconds || ROUND_SECONDS),
      String(settings.effectName ?? ""),
      String(settings.img ?? ""),
      sourceIdentity
    ].join("\u0000");
    const current = combined.get(key);
    if (current) {
      current.amount += Math.max(0, Number(entry.amount) || 0);
      current.worldTime = Math.min(Number(current.worldTime) || 0, Number(entry.worldTime) || Number(current.worldTime) || 0);
    } else {
      combined.set(key, {
        ...entry,
        damageType: entry.damageType,
        limbKey,
        scope,
        amount: Math.max(0, Number(entry.amount) || 0),
        settings,
        sourceIdentity,
        source: entry.source && typeof entry.source === "object" ? foundry.utils.deepClone(entry.source) : {},
        worldTime: Number(entry.worldTime) || 0
      });
    }
  }
  return Array.from(combined.values()).filter(entry => entry.amount > 0);
}

function combineDamageEffectSources(left = {}, right = {}) {
  const sources = [];
  for (const source of [left, right]) {
    if (source?.combinedSources && Array.isArray(source.combinedSources)) sources.push(...source.combinedSources);
    else if (source && typeof source === "object" && Object.keys(source).length) sources.push(foundry.utils.deepClone(source));
  }
  if (!sources.length) return {};
  if (sources.length === 1) return sources[0];
  return { combined: true, combinedSources: sources };
}

function buildBatchDamageNumberEntries(entries = [], actualHealthDelta = 0, requestedHealthDamage = 0) {
  if (!actualHealthDelta || !requestedHealthDamage) return [];
  const healthRatio = actualHealthDelta / requestedHealthDamage;
  const grouped = new Map();
  for (const entry of entries) {
    const key = entry.damageTypeKey || "untyped";
    const current = grouped.get(key) ?? {
      damageTypeKey: key,
      exact: 0,
      source: entry.source && typeof entry.source === "object" ? entry.source : {}
    };
    current.exact += entry.amount * healthRatio;
    grouped.set(key, current);
  }
  const rows = Array.from(grouped.values())
    .map(row => ({
      ...row,
      amount: Math.floor(row.exact),
      fraction: row.exact - Math.floor(row.exact)
    }))
    .filter(row => row.exact > 0);
  let remaining = actualHealthDelta - rows.reduce((sum, row) => sum + row.amount, 0);
  for (const row of rows.sort((left, right) => right.fraction - left.fraction)) {
    if (remaining <= 0) break;
    row.amount += 1;
    remaining -= 1;
  }
  return rows
    .filter(row => row.amount > 0)
    .map(({ damageTypeKey, amount, source }) => ({ damageTypeKey, amount, source }));
}

function buildBatchSourceDamageEntries(entries = []) {
  return entries
    .map(entry => ({
      damage: roundDamageAmount(entry?.actualHealthDelta),
      source: entry?.source && typeof entry.source === "object" ? entry.source : {}
    }))
    .filter(entry => entry.damage > 0);
}

function buildBatchBleedingEntries(entries = [], actualHealthDelta = 0, requestedHealthDamage = 0) {
  if (!actualHealthDelta || !requestedHealthDamage) return [];
  const healthRatio = actualHealthDelta / requestedHealthDamage;
  const rows = entries
    .map((entry, index) => {
      const exact = entry.amount * healthRatio;
      return {
        index,
        entry,
        exact,
        healthDelta: Math.floor(exact),
        fraction: exact - Math.floor(exact)
      };
    })
    .filter(row => row.exact > 0);
  let remaining = actualHealthDelta - rows.reduce((sum, row) => sum + row.healthDelta, 0);
  for (const row of rows.sort((left, right) => right.fraction - left.fraction)) {
    if (remaining <= 0) break;
    row.healthDelta += 1;
    remaining -= 1;
  }
  return rows
    .sort((left, right) => left.index - right.index)
    .map(row => ({
      damageType: row.entry.damageType,
      limbKey: row.entry.limbKey,
      scope: row.entry.scope,
      healthDelta: row.healthDelta,
      source: row.entry.source && typeof row.entry.source === "object" ? row.entry.source : {},
      worldTime: getDamageApplicationWorldTime(row.entry.source)
    }))
    .filter(entry => entry.healthDelta > 0)
    .map(entry => ({
      damageType: entry.damageType,
      limbKey: entry.limbKey,
      scope: entry.scope,
      healthDelta: entry.healthDelta,
      source: entry.source && typeof entry.source === "object" ? entry.source : {},
      worldTime: getDamageApplicationWorldTime(entry.source)
    }));
}

function buildBatchLimbDeltaEntries(actor, limbStates = new Map()) {
  return Array.from(limbStates.entries())
    .map(([limbKey, state]) => ({
      limbKey,
      limbLabel: getLimbLabel(actor, limbKey),
      amount: roundDamageAmount(state.totalDelta),
      damageByType: { ...(state.damageByType ?? {}) }
    }))
    .filter(entry => entry.amount > 0);
}

async function publishDamageSummaryMessage(results = []) {
  const context = buildDamageSummaryViewContext(results);
  if (!context.victims.length) return undefined;

  const content = await foundry.applications.handlebars.renderTemplate(TEMPLATES.damageSummaryChatCard, context);
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: context.primaryActor }),
    content,
    sound: null,
    flags: {
      [SYSTEM_ID]: {
        damageSummary: {
          totalHealthDamage: context.totalHealthDamage,
          totalLimbDamage: context.totalLimbDamage,
          totalBarrierAbsorbed: context.totalBarrierAbsorbed,
          victims: context.victims.map(victim => ({
            actorUuid: victim.actorUuid,
            name: victim.name,
            healthDamage: victim.healthDamage,
            limbDamage: victim.limbDamage,
            barrierAbsorbed: victim.barrierAbsorbed,
            limbs: victim.limbs.map(limb => ({
              key: limb.key,
              label: limb.label,
              amount: limb.amount
            })),
            traumas: victim.traumas.map(trauma => ({
              key: trauma.key,
              name: trauma.name,
              summary: trauma.summary
            }))
          }))
        }
      }
    }
  });
}

async function notifyDamageApplied(results = []) {
  const flatResults = results.flat(Infinity).filter(Boolean);
  if (!flatResults.length) return;
  const context = { results: flatResults };
  for (const [id, handler] of damageAppliedHandlers) {
    try {
      await handler(context);
    } catch (error) {
      console.error(`Fallout MaW | Damage-applied handler "${id}" failed`, error);
    }
  }
  Hooks.callAll(DAMAGE_APPLIED_HOOK, context);
}

function buildDamageSummaryViewContext(results = []) {
  const victims = new Map();
  for (const result of results.flat(Infinity).filter(Boolean)) {
    if (result.mode && result.mode !== MODE_DAMAGE) continue;
    const actor = result.actor;
    if (!actor?.uuid) continue;

    const healthDelta = roundDamageAmount(result.healthDelta);
    const limbDelta = roundDamageAmount(result.limbDelta);
    const barrierAbsorbed = roundDamageAmount(result.barrierAbsorbed);
    const createdTraumas = Array.isArray(result.createdTraumas) ? result.createdTraumas.filter(Boolean) : [];
    if (healthDelta <= 0 && limbDelta <= 0 && barrierAbsorbed <= 0 && !createdTraumas.length) continue;

    const victim = getDamageSummaryVictim(victims, actor);
    victim.healthDamage += healthDelta;
    victim.limbDamage += limbDelta;
    victim.barrierAbsorbed += barrierAbsorbed;

    for (const entry of result.healthDeltasByType ?? []) {
      const damageTypeKey = String(entry?.damageTypeKey ?? "untyped");
      const amount = roundDamageAmount(entry?.amount);
      if (amount <= 0) continue;
      victim.damageByType.set(damageTypeKey, (victim.damageByType.get(damageTypeKey) ?? 0) + amount);
    }

    if (Array.isArray(result.limbDeltas) && result.limbDeltas.length) {
      for (const entry of result.limbDeltas) {
        addDamageSummaryLimb(victim, actor, entry.limbKey, entry.amount, entry.damageByType);
      }
    } else {
      addDamageSummaryLimb(victim, actor, result.limbKey, result.limbDelta, {
        [result.damageTypeKey || "untyped"]: result.limbDelta
      });
    }

    for (const trauma of createdTraumas) addDamageSummaryTrauma(victim, trauma);
  }

  const rows = Array.from(victims.values())
    .map(victim => ({
      actorUuid: victim.actor.uuid,
      name: String(victim.actor.name ?? game.i18n.localize("DOCUMENT.Actor")),
      img: getActorDamageSummaryImage(victim.actor),
      healthDamage: roundDamageAmount(victim.healthDamage),
      limbDamage: roundDamageAmount(victim.limbDamage),
      barrierAbsorbed: roundDamageAmount(victim.barrierAbsorbed),
      limbs: Array.from(victim.limbs.values())
        .map(limb => ({
          key: limb.key,
          label: limb.label,
          amount: roundDamageAmount(limb.amount)
        }))
        .filter(limb => limb.amount > 0)
        .sort((left, right) => right.amount - left.amount),
      traumas: Array.from(victim.traumas.values())
        .map(trauma => ({
          key: trauma.key,
          name: trauma.name,
          img: trauma.img,
          summary: trauma.summary
        }))
    }))
    .filter(victim => (
      victim.healthDamage > 0
      || victim.limbDamage > 0
      || victim.barrierAbsorbed > 0
      || victim.traumas.length > 0
    ))
    .sort((left, right) => (
      (right.healthDamage + right.limbDamage + right.barrierAbsorbed)
      - (left.healthDamage + left.limbDamage + left.barrierAbsorbed)
    ));

  return {
    primaryActor: victims.values().next().value?.actor ?? null,
    totalHealthDamage: rows.reduce((sum, victim) => sum + victim.healthDamage, 0),
    totalLimbDamage: rows.reduce((sum, victim) => sum + victim.limbDamage, 0),
    totalBarrierAbsorbed: rows.reduce((sum, victim) => sum + victim.barrierAbsorbed, 0),
    victims: rows,
    labels: {
      kicker: "Итог цикла",
      title: "Сводка урона",
      totalDamage: "Урон",
      barrierAbsorbed: "Поглощено барьером",
      limbs: "Поврежденные конечности",
      noLimbDamage: "Конечности не повреждены",
      traumas: "Полученные травмы"
    }
  };
}

function getDamageSummaryVictim(victims, actor) {
  let victim = victims.get(actor.uuid);
  if (victim) return victim;
  victim = {
    actor,
    healthDamage: 0,
    limbDamage: 0,
    barrierAbsorbed: 0,
    limbs: new Map(),
    traumas: new Map(),
    damageByType: new Map()
  };
  victims.set(actor.uuid, victim);
  return victim;
}

function addDamageSummaryLimb(victim, actor, limbKey = "", amount = 0, damageByType = {}) {
  const key = String(limbKey ?? "").trim();
  const delta = roundDamageAmount(amount);
  if (!key || delta <= 0) return;

  let limb = victim.limbs.get(key);
  if (!limb) {
    limb = {
      key,
      label: getLimbLabel(actor, key),
      amount: 0,
      damageByType: new Map()
    };
    victim.limbs.set(key, limb);
  }
  limb.amount += delta;

  for (const [damageTypeKey, value] of Object.entries(damageByType ?? {})) {
    const typeDelta = roundDamageAmount(value);
    if (typeDelta <= 0) continue;
    const typeKey = String(damageTypeKey || "untyped");
    limb.damageByType.set(typeKey, (limb.damageByType.get(typeKey) ?? 0) + typeDelta);
  }
}

function addDamageSummaryTrauma(victim, trauma) {
  const key = getDamageSummaryTraumaKey(trauma);
  if (!key || victim.traumas.has(key)) return;
  victim.traumas.set(key, {
    key,
    name: String(trauma?.name ?? game.i18n.localize("DOCUMENT.Item")),
    img: String(trauma?.img ?? "icons/svg/blood.svg"),
    summary: buildDamageSummaryTraumaSummary(trauma)
  });
}

function getDamageSummaryTraumaKey(trauma) {
  return String(trauma?.uuid ?? trauma?.id ?? trauma?.name ?? "").trim();
}

function buildDamageSummaryTraumaSummary(trauma) {
  const sources = Array.isArray(trauma?.system?.sources) ? trauma.system.sources : [];
  const sourceText = sources
    .map(getDamageSummaryTraumaSourceText)
    .filter(Boolean)
    .join("; ");
  if (sourceText) return sourceText;

  const limbLabel = String(trauma?.system?.limbLabel ?? trauma?.system?.limbKey ?? "").trim();
  const damageTypeLabel = String(trauma?.system?.damageTypeLabel ?? trauma?.system?.damageTypeKey ?? "").trim();
  const threshold = toInteger(trauma?.system?.thresholdPercent);
  return [
    limbLabel,
    damageTypeLabel,
    threshold > 0 ? `${threshold}%` : ""
  ].filter(Boolean).join(" - ");
}

function getDamageSummaryTraumaSourceText(source = {}) {
  const limbLabel = String(source?.limbLabel ?? source?.limbKey ?? "").trim();
  const damageTypeLabel = String(source?.damageTypeLabel ?? source?.damageTypeKey ?? "").trim();
  const threshold = toInteger(source?.thresholdPercent);
  return [
    limbLabel,
    damageTypeLabel,
    threshold > 0 ? `${threshold}%` : ""
  ].filter(Boolean).join(" - ");
}

function getActorDamageSummaryImage(actor) {
  const token = (globalThis.canvas?.tokens?.placeables ?? [])
    .find(placeable => placeable.actor?.uuid === actor.uuid && isTokenVisibleToCurrentUser(placeable));
  return String(token?.document?.texture?.src ?? actor.img ?? "icons/svg/mystery-man.svg");
}

function getLimbLabel(actor, limbKey = "") {
  return String(actor?.system?.limbs?.[limbKey]?.label ?? limbKey);
}

function calculateAggregateHealth(
  actor,
  context = buildActorLimbHealthContext(actor)
) {
  const entries = Object.entries(actor?.system?.limbs ?? {}).filter(([_key, limb]) => limb && typeof limb === "object");
  return entries.reduce((result, [limbKey, limb]) => {
    const prosthesis = getInstalledProsthesis(actor, limbKey, context);
    if (prosthesis) {
      const replacement = getProsthesisHealthForAggregate(prosthesis, limb);
      result.value += replacement.value;
      result.max += replacement.max;
      return result;
    }
    if (isLimbPhysicallyMissing(actor, limbKey)) return result;
    result.value += Math.max(0, getEffectiveLimbStateValue(actor, limbKey, null, context));
    result.max += Math.max(0, toInteger(limb?.max));
    return result;
  }, { min: 0, value: 0, max: 0 });
}

function getCurrentActorHealthValue(actor) {
  if (isIndependentHealthModelActive(actor)) {
    return createIndependentHealthState(actor?.system?.resources?.health).value;
  }
  return Math.max(0, Number(calculateAggregateHealth(actor).value) || 0);
}

function estimateDirectDamageApplication(actor, data = {}, damageType = null) {
  const scope = normalizeScope(data.scope, data.limbKey);
  const effectiveAmount = Math.max(0, roundDamageAmount(data.amount));
  const independentHealthRules = getIndependentHealthRules(actor);
  if (independentHealthRules) {
    const healthState = createIndependentHealthState(actor.system?.resources?.health);
    const previousHealth = healthState.value;
    const installedProsthesis = data.limbKey && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB)
      ? getInstalledProsthesis(actor, data.limbKey)
      : null;
    let result;
    if (installedProsthesis) {
      result = estimateProsthesisLimbDamage(actor, data.limbKey, effectiveAmount, {
        prosthesis: installedProsthesis,
        limbDamageMultiplier: getWeaponLimbDamageMultiplier(data.source?.weaponData, data.limbKey),
        damageType,
        damageTypeKey: data.damageTypeKey
      });
      applyIndependentHealthChange(
        healthState,
        result.healthDelta,
        MODE_DAMAGE
      );
    } else {
      const lostHealth = applyIndependentHealthChange(
        healthState,
        effectiveAmount,
        MODE_DAMAGE
      );
      result = data.limbKey && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB)
        ? calculateIndependentOrganicLimbDamage(actor, data.limbKey, lostHealth, {
          profileMultiplier: independentHealthRules.limbDamageFromLostHealthMultiplier,
          limbDamageMultiplier: getWeaponLimbDamageMultiplier(data.source?.weaponData, data.limbKey),
          damageType,
          damageTypeKey: data.damageTypeKey
        })
        : createLimbMutationResult();
    }
    result.healthDelta = Math.max(0, previousHealth - healthState.value);
    result.healthValue = healthState.value;
    result.healthMin = healthState.min;
    result.lethal = isDamageEstimateLethal(actor, result);
    return result;
  }
  const installedProsthesis = data.limbKey && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB)
    ? getInstalledProsthesis(actor, data.limbKey)
    : null;
  const result = installedProsthesis
    ? estimateProsthesisLimbDamage(actor, data.limbKey, effectiveAmount, {
      prosthesis: installedProsthesis,
      limbDamageMultiplier: getWeaponLimbDamageMultiplier(data.source?.weaponData, data.limbKey),
      damageType,
      damageTypeKey: data.damageTypeKey
    })
    : data.limbKey && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB)
      ? estimateTargetedLimbDamage(actor, data.limbKey, effectiveAmount, {
        limbDamageMultiplier: getWeaponLimbDamageMultiplier(data.source?.weaponData, data.limbKey),
        damageType,
        damageTypeKey: data.damageTypeKey
      })
      : estimateEvenLimbDamage(actor, effectiveAmount, { damageType, damageTypeKey: data.damageTypeKey });
  result.lethal = isDamageEstimateLethal(actor, result);
  return result;
}

function estimateDamageEntriesBatch(actor, entries = []) {
  const ledger = createDamageBatchEstimateLedger(actor);
  applyDamageEntriesToEstimateLedger(actor, ledger, entries);
  return createDamageBatchEstimateResult(actor, ledger);
}

function createDamageBatchEstimateLedger(actor) {
  const independentHealthRules = getIndependentHealthRules(actor);
  const independentHealthState = independentHealthRules
    ? createIndependentHealthState(actor.system?.resources?.health)
    : null;
  return {
    independentHealthRules,
    independentHealthState,
    initialIndependentHealthValue: independentHealthState?.value ?? 0,
    limbStates: new Map(),
    damageAccumulation: new Map(),
    brokenProsthesisLimbKeys: new Set(),
    prosthesisConditionDamage: new Map(),
    prosthesisHealthDamage: new Map(),
    prosthesisConditionDelta: new Map(),
    organicHealthDelta: 0
  };
}

function cloneDamageBatchEstimateLedger(ledger) {
  return {
    independentHealthRules: ledger.independentHealthRules,
    independentHealthState: ledger.independentHealthState ? { ...ledger.independentHealthState } : null,
    initialIndependentHealthValue: ledger.initialIndependentHealthValue,
    limbStates: new Map(Array.from(ledger.limbStates, ([key, state]) => [key, {
      ...state,
      damageByType: { ...(state.damageByType ?? {}) },
      damageAccumulationSnapshot: { ...(state.damageAccumulationSnapshot ?? {}) }
    }])),
    damageAccumulation: new Map(Array.from(ledger.damageAccumulation, ([key, value]) => [key, { ...value }])),
    brokenProsthesisLimbKeys: new Set(ledger.brokenProsthesisLimbKeys),
    prosthesisConditionDamage: new Map(ledger.prosthesisConditionDamage),
    prosthesisHealthDamage: new Map(ledger.prosthesisHealthDamage),
    prosthesisConditionDelta: new Map(ledger.prosthesisConditionDelta),
    organicHealthDelta: ledger.organicHealthDelta
  };
}

function applyDamageEntriesToEstimateLedger(actor, ledger, entries = []) {
  for (const entry of entries) applyDamageEntryToEstimateLedger(actor, ledger, entry);
  return ledger;
}

function applyDamageEntryToEstimateLedger(actor, ledger, entry = {}) {
  const scope = normalizeScope(entry.scope, entry.limbKey);
  const installedProsthesis = entry.limbKey
    && !ledger.brokenProsthesisLimbKeys.has(entry.limbKey)
    && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB)
    ? getInstalledProsthesis(actor, entry.limbKey)
    : null;
  if (installedProsthesis) {
    const estimate = applyProsthesisDamageToEstimateLedger(
      ledger,
      installedProsthesis,
      entry.limbKey,
      roundDamageAmount(entry.amount * getWeaponLimbDamageMultiplier(entry.source?.weaponData, entry.limbKey))
    );
    if (ledger.independentHealthState) {
      applyIndependentHealthChange(
        ledger.independentHealthState,
        estimate.incrementalHealthDelta,
        MODE_DAMAGE
      );
    }
    return;
  }

  if (ledger.independentHealthState) {
    const lostHealth = applyIndependentHealthChange(ledger.independentHealthState, entry.amount, MODE_DAMAGE);
    if (!entry.limbKey || (scope !== SCOPE_LIMB && scope !== SCOPE_HEALTH_AND_LIMB)) return;
    calculateIndependentOrganicLimbDamage(actor, entry.limbKey, lostHealth, {
      profileMultiplier: ledger.independentHealthRules.limbDamageFromLostHealthMultiplier,
      limbDamageMultiplier: getWeaponLimbDamageMultiplier(entry.source?.weaponData, entry.limbKey),
      damageType: entry.damageType,
      damageTypeKey: entry.damageTypeKey,
      limbStates: ledger.limbStates,
      damageAccumulation: ledger.damageAccumulation
    });
    return;
  }

  const previousProsthesisHealthDamage = sumEstimateLedgerProsthesisHealthDamage(ledger);
  const evenDamageEstimator = (amount, { excludeLimbKeys = new Set() } = {}) => (
    estimateEvenLimbDamageWithLedger(actor, ledger, amount, {
      damageType: entry.damageType,
      damageTypeKey: entry.damageTypeKey,
      excludeLimbKeys
    })
  );
  const result = entry.limbKey && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB)
    ? estimateTargetedLimbDamage(actor, entry.limbKey, entry.amount, {
      limbDamageMultiplier: getWeaponLimbDamageMultiplier(entry.source?.weaponData, entry.limbKey),
      damageType: entry.damageType,
      damageTypeKey: entry.damageTypeKey,
      limbStates: ledger.limbStates,
      damageAccumulation: ledger.damageAccumulation,
      evenDamageEstimator
    })
    : evenDamageEstimator(entry.amount, { excludeLimbKeys: ledger.brokenProsthesisLimbKeys });
  const prosthesisHealthDelta = Math.max(
    0,
    sumEstimateLedgerProsthesisHealthDamage(ledger) - previousProsthesisHealthDamage
  );
  ledger.organicHealthDelta += Math.max(0, (Number(result.healthDelta) || 0) - prosthesisHealthDelta);
  for (const limbKey of result.brokenProsthesisLimbKeys ?? []) {
    ledger.brokenProsthesisLimbKeys.add(limbKey);
  }
}

function applyProsthesisDamageToEstimateLedger(ledger, prosthesis, limbKey, conditionDamage = 0) {
  const itemId = String(prosthesis?.id ?? "");
  const additionalDamage = Math.max(0, roundDamageAmount(conditionDamage));
  if (!itemId || additionalDamage <= 0 || !hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    return {
      current: 0,
      next: 0,
      conditionDelta: 0,
      healthDelta: 0,
      incrementalHealthDelta: 0
    };
  }
  const previousHealthDelta = ledger.prosthesisHealthDamage.get(itemId) ?? 0;
  const accumulatedDamage = (ledger.prosthesisConditionDamage.get(itemId) ?? 0) + additionalDamage;
  ledger.prosthesisConditionDamage.set(itemId, accumulatedDamage);
  const estimate = estimateProsthesisConditionDamage(prosthesis, accumulatedDamage);
  ledger.prosthesisHealthDamage.set(itemId, estimate.healthDelta);
  ledger.prosthesisConditionDelta.set(itemId, estimate.conditionDelta);
  if (estimate.next < estimate.current && estimate.next <= 0) {
    ledger.brokenProsthesisLimbKeys.add(limbKey);
  }
  return {
    ...estimate,
    incrementalHealthDelta: Math.max(0, estimate.healthDelta - previousHealthDelta)
  };
}

function sumEstimateLedgerProsthesisHealthDamage(ledger) {
  return Array.from(ledger?.prosthesisHealthDamage?.values?.() ?? [])
    .reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

function estimateEvenLimbDamageWithLedger(actor, ledger, amount = 0, {
  damageType = null,
  damageTypeKey = "",
  traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey),
  excludeLimbKeys = new Set()
} = {}) {
  const excluded = new Set([
    ...Array.from(excludeLimbKeys ?? []),
    ...ledger.brokenProsthesisLimbKeys
  ]);
  const limbHealthContext = buildActorLimbHealthContext(actor);
  const targets = [
    ...getPositiveLimbTargets(actor, ledger.limbStates, excluded, limbHealthContext),
    ...getIntegratedProsthesisHealthDamageTargets(actor, excluded, limbHealthContext)
      .map(target => ({
        ...target,
        capacity: Math.max(
          0,
          target.capacity - (ledger.prosthesisHealthDamage.get(target.itemId) ?? 0)
        )
      }))
      .filter(target => target.capacity > 0)
  ];
  const allocations = distributeCappedIntegerAmount(amount, targets.map(target => ({
    key: target.key,
    capacity: target.capacity
  })));
  const targetsByKey = new Map(targets.map(target => [target.key, target]));
  const limbAllocations = new Map();
  let prosthesisHealthDelta = 0;
  for (const [targetKey, allocated] of allocations) {
    const target = targetsByKey.get(targetKey);
    if (!target) continue;
    if (target.type === "prosthesis") {
      const integration = getProsthesisIntegrationPercent(target.prosthesis);
      if (integration <= 0) continue;
      const conditionDamage = Math.max(1, Math.ceil((roundDamageAmount(allocated) * 100) / integration));
      const estimate = applyProsthesisDamageToEstimateLedger(
        ledger,
        target.prosthesis,
        target.limbKey,
        conditionDamage
      );
      prosthesisHealthDelta += estimate.incrementalHealthDelta;
      continue;
    }
    const limbKey = target.limbKey ?? target.key;
    limbAllocations.set(limbKey, (limbAllocations.get(limbKey) ?? 0) + allocated);
  }
  const limbResult = applyDamageAllocations(actor, limbAllocations, {
    damageType,
    damageTypeKey,
    traumaDamageTypeKey,
    limbStates: ledger.limbStates,
    damageAccumulation: ledger.damageAccumulation
  });
  return createLimbMutationResult(ledger.limbStates, ledger.damageAccumulation, {
    healthDelta: limbResult.healthDelta + prosthesisHealthDelta,
    limbDelta: Array.from(ledger.limbStates.values()).reduce((sum, state) => sum + state.totalDelta, 0)
      + Array.from(ledger.prosthesisConditionDelta.values()).reduce((sum, value) => sum + value, 0)
  });
}

function getDamageBatchEstimateHealthDelta(ledger) {
  if (ledger.independentHealthState) {
    return Math.max(0, ledger.initialIndependentHealthValue - ledger.independentHealthState.value);
  }
  return ledger.organicHealthDelta
    + sumEstimateLedgerProsthesisHealthDamage(ledger);
}

function createDamageBatchEstimateResult(actor, ledger) {
  const result = createLimbMutationResult(ledger.limbStates, ledger.damageAccumulation, {
    healthDelta: getDamageBatchEstimateHealthDelta(ledger),
    limbDelta: Array.from(ledger.limbStates.values()).reduce((sum, state) => sum + state.totalDelta, 0)
      + Array.from(ledger.prosthesisConditionDelta.values()).reduce((sum, value) => sum + value, 0)
  });
  if (ledger.independentHealthState) {
    result.healthValue = ledger.independentHealthState.value;
    result.healthMin = ledger.independentHealthState.min;
  }
  result.brokenProsthesisLimbKeys = [...ledger.brokenProsthesisLimbKeys];
  result.lethal = isDamageEstimateLethal(actor, result);
  return result;
}

/**
 * Damage reaching the final health boundary is measured after mitigation and
 * barriers, but before the actor's remaining health clamps the actual loss.
 * The positive actual delta is retained as the cheap proof that this packet
 * can affect health at all; this avoids intercepting pure limb/condition hits.
 */
export function calculateFinalHealthDamageInterceptionAmount(requests = [], actualHealthDamage = 0) {
  const actual = Math.max(0, roundDamageAmount(actualHealthDamage));
  if (actual <= 0) return 0;
  const incoming = Array.from(requests ?? []).reduce(
    (total, request) => total + Math.max(0, roundDamageAmount(request?.amount)),
    0
  );
  return Math.max(actual, incoming);
}

function buildFinalHealthDamageApplications(actor, requests = []) {
  const groups = new Map();
  for (const [index, request] of requests.entries()) {
    const source = request?.source ?? {};
    const explicitPacketId = [source.damagePacketId, source.conditionWearPacketId]
      .map(value => String(value ?? "").trim())
      .find(Boolean) ?? "";
    const packetId = explicitPacketId || `application:${request?.damageEventIndex ?? index}:${index}`;
    let group = groups.get(packetId);
    if (!group) {
      group = { packetId, request, requests: [] };
      groups.set(packetId, group);
    }
    group.requests.push(request);
  }
  const initialLedger = createDamageBatchEstimateLedger(actor);
  return Array.from(groups.values(), group => {
    const initialCandidate = cloneDamageBatchEstimateLedger(initialLedger);
    applyDamageEntriesToEstimateLedger(actor, initialCandidate, group.requests);
    const estimate = createDamageBatchEstimateResult(actor, initialCandidate);
    const application = {
      ...group,
      healthDamage: calculateFinalHealthDamageInterceptionAmount(group.requests, estimate?.healthDelta),
      estimate,
      health: getDamageBatchEstimateHealthSnapshot(actor, initialLedger),
      worldTime: getDamageApplicationWorldTime(group.request?.source)
    };
    application.resolveSequentialEstimate = (sequence = {}) => {
      const ledger = sequence?.ledger ?? initialLedger;
      const previousHealthDamage = getDamageBatchEstimateHealthDelta(ledger);
      const candidate = cloneDamageBatchEstimateLedger(ledger);
      applyDamageEntriesToEstimateLedger(actor, candidate, group.requests);
      const combinedEstimate = createDamageBatchEstimateResult(actor, candidate);
      const cumulativeHealthDamage = getDamageBatchEstimateHealthDelta(candidate);
      const actualHealthDamage = Math.max(0, cumulativeHealthDamage - previousHealthDamage);
      return {
        healthDamage: calculateFinalHealthDamageInterceptionAmount(group.requests, actualHealthDamage),
        estimate: combinedEstimate,
        health: getDamageBatchEstimateHealthSnapshot(actor, ledger),
        nextSequence: { ledger: candidate }
      };
    };
    return application;
  });
}

function getDamageBatchEstimateHealthSnapshot(actor, ledger) {
  if (ledger?.independentHealthState) return { ...ledger.independentHealthState };
  const health = calculateAggregateHealth(actor);
  const min = Number(health?.min) || 0;
  const max = Math.max(min, Number(health?.max) || 0);
  const value = Math.min(max, Math.max(
    min,
    (Number(health?.value) || 0) - getDamageBatchEstimateHealthDelta(ledger)
  ));
  return { min, max, value };
}

function finalHealthDamageInterceptorApplies(handler, actor) {
  if (typeof handler?.applies !== "function") return true;
  try {
    return handler.applies(actor) === true;
  } catch (error) {
    console.error("Fallout MaW | Final-health-damage interceptor applicability check failed", error);
    return false;
  }
}

function hasApplicableFinalHealthDamageInterceptors(actor, { estimate = false } = {}) {
  for (const handler of finalHealthDamageInterceptors.values()) {
    if (estimate && typeof handler.estimate !== "function") continue;
    if (finalHealthDamageInterceptorApplies(handler, actor)) return true;
  }
  return false;
}

async function applyFinalHealthDamageInterceptors(actor, applications = [], context = {}) {
  let remaining = applications.filter(application => (
    application?.request || application?.requests?.length
  ));
  const passthrough = applications.filter(application => !remaining.includes(application));
  const preventions = [];
  if (!remaining.length || !finalHealthDamageInterceptors.size) {
    return { applications, preventions, preventedHealthDamage: 0 };
  }

  for (const [id, handler] of finalHealthDamageInterceptors) {
    if (!finalHealthDamageInterceptorApplies(handler, actor)) continue;
    let result;
    try {
      result = await handler.apply({ actor, applications: remaining, ...context });
    } catch (error) {
      console.error(`Fallout MaW | Final-health-damage interceptor "${id}" failed`, error);
      continue;
    }
    const blocked = new Set(
      Array.isArray(result?.blockedApplications) ? result.blockedApplications : []
    );
    if (!blocked.size) continue;
    const blockedEntries = remaining.filter(application => blocked.has(application));
    if (!blockedEntries.length) continue;
    const preventedHealthDamage = blockedEntries.reduce(
      (total, application) => total + Math.max(0, Number(application.healthDamage) || 0),
      0
    );
    preventions.push({ id, preventedHealthDamage, data: result?.data ?? null });
    remaining = remaining.filter(application => !blocked.has(application));
    if (!remaining.length) break;
  }

  const allowed = new Set([...passthrough, ...remaining]);
  return {
    applications: applications.filter(application => allowed.has(application)),
    preventions,
    preventedHealthDamage: preventions.reduce((total, entry) => total + entry.preventedHealthDamage, 0)
  };
}

function estimateFinalHealthDamageInterceptors(actor, applications = [], context = {}) {
  let remaining = applications.filter(application => (
    application?.request || application?.requests?.length
  ));
  const passthrough = applications.filter(application => !remaining.includes(application));
  if (!remaining.length || !finalHealthDamageInterceptors.size) return applications;

  for (const [id, handler] of finalHealthDamageInterceptors) {
    if (typeof handler.estimate !== "function") continue;
    if (!finalHealthDamageInterceptorApplies(handler, actor)) continue;
    let result;
    try {
      result = handler.estimate({ actor, applications: remaining, ...context });
    } catch (error) {
      console.error(`Fallout MaW | Final-health-damage estimate interceptor "${id}" failed`, error);
      continue;
    }
    const blocked = new Set(
      Array.isArray(result?.blockedApplications) ? result.blockedApplications : []
    );
    if (!blocked.size) continue;
    remaining = remaining.filter(application => !blocked.has(application));
    if (!remaining.length) break;
  }

  const allowed = new Set([...passthrough, ...remaining]);
  return applications.filter(application => allowed.has(application));
}

async function preventLethalDamageIfApplicable(actor, estimate = {}, context = {}) {
  if (isActorDead(actor)) return false;
  if (!isDamageEstimateLethal(actor, estimate)) return false;
  for (const handler of lethalDamagePreventionHandlers) {
    let result;
    try {
      result = await handler({ actor, estimate, ...context });
    } catch (error) {
      console.error("Fallout MaW | Lethal damage prevention handler failed", error);
      continue;
    }
    if (!result?.handled) continue;
    return Boolean(result.prevented);
  }
  return false;
}

function isDamageEstimateLethal(actor, estimate = {}) {
  if (estimate?.lethal === true) return true;
  if (
    isIndependentHealthModelActive(actor)
    && Number.isFinite(Number(estimate?.healthValue))
    && toInteger(estimate.healthValue) <= toInteger(estimate.healthMin)
  ) return true;
  let combatSettings = null;
  for (const [limbKey, state] of estimate?.limbStates ?? []) {
    if (!isCriticalLimb(actor, limbKey)) continue;
    if (hasInstalledProsthesis(actor, limbKey)) continue;
    if (toInteger(state?.nextValue) > toInteger(state?.min)) continue;
    if (isConstructPartLimb(actor, limbKey)) return true;
    if (canActorLimbBeAutomaticallyDestroyed(
      actor,
      { critical: true },
      combatSettings ??= getCombatSettings()
    )) return true;
  }
  return (estimate?.brokenProsthesisLimbKeys ?? [])
    .some(limbKey => isCriticalLimb(actor, limbKey));
}

function getProsthesisHealthForAggregate(prosthesis, limb = {}) {
  if (!prosthesis) return { value: 0, max: 0 };
  const integration = getProsthesisIntegrationPercent(prosthesis);
  if (integration <= 0) return { value: 0, max: 0 };

  if (!hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    const max = toIntegratedProsthesisHealthValue(Math.max(0, toInteger(limb?.max)), integration);
    return { value: max, max };
  }
  const condition = getConditionFunction(prosthesis);
  const max = Math.max(0, toInteger(condition.max));
  const value = Math.min(Math.max(0, toInteger(condition.value)), max);
  return {
    value: toIntegratedProsthesisHealthValue(value, integration),
    max: toIntegratedProsthesisHealthValue(max, integration)
  };
}

function getProsthesisIntegrationPercent(prosthesis) {
  return Math.max(0, Math.min(100, toInteger(getProsthesisFunction(prosthesis).integrationPercent)));
}

function synchronizePreparedAggregateHealthResource(
  actor,
  context = buildActorLimbHealthContext(actor)
) {
  if (isIndependentHealthModelActive(actor)) return;
  const health = actor?.system?.resources?.health;
  if (!health) return;
  const aggregate = calculateAggregateHealth(actor, context);
  health.min = aggregate.min;
  health.max = aggregate.max;
  health.value = Math.min(Math.max(aggregate.value, aggregate.min), aggregate.max);
  health.spent = Math.max(0, health.max - health.value);
}

function toIntegratedProsthesisHealthValue(value = 0, integration = 0) {
  return roundDamageAmount((Math.max(0, toInteger(value)) * Math.max(0, Math.min(100, toInteger(integration)))) / 100);
}

async function calculateManualAggregateHealthAdjustment(
  actor,
  amount = 0,
  mode = MODE_DAMAGE,
  { ignoreHealingCaps = false } = {}
) {
  const limbStates = new Map();
  const damageAccumulation = new Map();
  const requested = roundDamageAmount(amount);
  if (requested <= 0) return createLimbMutationResult(limbStates, damageAccumulation);

  const targets = mode === MODE_HEALING
    ? getManualHealthHealingTargets(actor, { ignoreHealingCaps })
    : getManualHealthDamageTargets(actor);
  const targetsByKey = new Map(targets.map(target => [target.key, target]));
  const allocations = distributeCappedIntegerAmount(requested, targets.map(target => ({
    key: target.key,
    capacity: target.capacity
  })));

  let healthDelta = 0;
  let limbDelta = 0;
  const prosthesisHealthAdjustments = [];
  for (const [targetKey, allocated] of allocations) {
    const target = targetsByKey.get(targetKey);
    if (target?.type === "prosthesis") {
      prosthesisHealthAdjustments.push({ itemId: target.itemId, amount: allocated, mode });
      healthDelta += allocated;
      continue;
    }

    const limbKey = target?.limbKey ?? targetKey;
    const limb = actor?.system?.limbs?.[limbKey];
    if (!limb) continue;
    const state = getBatchLimbState(limbStates, actor, limbKey, limb);
    const currentPositive = Math.max(0, state.nextValue);
    const nextPositive = mode === MODE_HEALING
      ? Math.min(target?.cap ?? Math.max(0, toInteger(limb.max)), currentPositive + allocated)
      : Math.max(0, currentPositive - allocated);
    const nextValue = nextPositive;
    const previousValue = state.nextValue;
    state.nextValue = nextValue;
    const delta = Math.abs(nextValue - previousValue);
    state.totalDelta += delta;
    limbDelta += delta;
    healthDelta += Math.abs(nextPositive - currentPositive);
    if (mode === MODE_HEALING && delta > 0) {
      diluteBatchDamageAccumulation(damageAccumulation, actor, limbKey, delta);
    }
  }

  const result = createLimbMutationResult(limbStates, damageAccumulation, { healthDelta, limbDelta });
  result.prosthesisHealthAdjustments = prosthesisHealthAdjustments;
  return result;
}

function getManualHealthDamageTargets(actor) {
  const limbHealthContext = buildActorLimbHealthContext(actor);
  const limbTargets = Object.entries(actor?.system?.limbs ?? {})
    .filter(([key]) => !isLimbPhysicallyMissing(actor, key))
    .map(([key, limb]) => ({
      type: "limb",
      key,
      limbKey: key,
      capacity: Math.max(0, getEffectiveLimbStateValue(actor, key, null, limbHealthContext))
    }))
    .filter(target => target.capacity > 0);
  return [
    ...limbTargets,
    ...getIntegratedProsthesisHealthDamageTargets(actor, new Set(), limbHealthContext)
  ];
}

function getManualHealthHealingTargets(actor, { ignoreHealingCaps = false } = {}) {
  const limbHealthContext = buildActorLimbHealthContext(actor);
  const limbTargets = Object.entries(actor?.system?.limbs ?? {})
    .filter(([key]) => !isLimbPhysicallyMissing(actor, key))
    .map(([key, limb]) => {
      const currentPositive = Math.max(0, getEffectiveLimbStateValue(actor, key, null, limbHealthContext));
      const physicalMaximum = Math.max(0, toInteger(limb?.max));
      const cap = ignoreHealingCaps
        ? physicalMaximum
        : Math.min(physicalMaximum, getLimbHealingCap(actor, key, limbHealthContext));
      return {
        type: "limb",
        key,
        limbKey: key,
        cap,
        capacity: Math.max(0, cap - currentPositive)
      };
    })
    .filter(target => target.capacity > 0);
  return [
    ...limbTargets,
    ...getIntegratedProsthesisHealthHealingTargets(actor, limbHealthContext)
  ];
}

async function calculateEvenLimbDamage(actor, amount = 0, { damageType = null, damageTypeKey = "", traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey), limbStates = new Map(), damageAccumulation = new Map(), excludeLimbKeys = new Set() } = {}) {
  const targets = getPositiveHealthDamageTargets(actor, limbStates, excludeLimbKeys);
  const allocations = distributeCappedIntegerAmount(amount, targets.map(target => ({
    key: target.key,
    capacity: target.capacity
  })));
  return applyHealthDamageTargetAllocations(actor, allocations, targets, {
    damageType,
    damageTypeKey,
    traumaDamageTypeKey,
    limbStates,
    damageAccumulation
  });
}

async function calculateProsthesisLimbDamage(actor, limbKey = "", amount = 0, { prosthesis = null, limbDamageMultiplier = 1, damageType = null, damageTypeKey = "", traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey), limbStates = new Map(), damageAccumulation = new Map() } = {}) {
  const damage = roundDamageAmount(amount * limbDamageMultiplier);
  if (!prosthesis || damage <= 0) return createLimbMutationResult(limbStates, damageAccumulation);

  const result = await applyProsthesisConditionDamage(actor, prosthesis, damage);
  const mutationResult = createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta: result?.healthDelta ?? 0,
    limbDelta: result?.conditionDelta ?? 0
  });
  if (result?.broken) mutationResult.shockCheck = createProsthesisBreakShockCheck(actor, prosthesis, limbKey);
  return mutationResult;
}

function calculateIndependentOrganicLimbDamage(actor, limbKey = "", lostHealth = 0, {
  profileMultiplier = 0,
  limbDamageMultiplier = 1,
  damageType = null,
  damageTypeKey = "",
  traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey),
  limbStates = new Map(),
  damageAccumulation = new Map()
} = {}) {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb || isLimbPhysicallyMissing(actor, limbKey)) {
    return createLimbMutationResult(limbStates, damageAccumulation);
  }
  const anatomicalMultiplier = Math.max(0, toOptionalFiniteNumber(limb.damageMultiplier) ?? 1);
  const damage = roundDamageAmount(calculateIndependentLimbDamage(
    lostHealth,
    actor.system?.resources?.health?.max,
    profileMultiplier
  ) * anatomicalMultiplier * limbDamageMultiplier);
  if (damage <= 0) return createLimbMutationResult(limbStates, damageAccumulation);

  const previousTotal = Array.from(limbStates.values())
    .reduce((sum, state) => sum + Math.max(0, Number(state?.totalDelta) || 0), 0);
  const previousValue = getLimbStateValue(actor, limbKey, limbStates);
  const applied = applyDamageAllocations(actor, new Map([[limbKey, damage]]), {
    damageType,
    damageTypeKey,
    traumaDamageTypeKey,
    limbStates,
    damageAccumulation
  });
  const state = limbStates.get(limbKey);
  const currentTotal = Array.from(limbStates.values())
    .reduce((sum, entry) => sum + Math.max(0, Number(entry?.totalDelta) || 0), 0);
  const result = createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta: 0,
    limbDelta: Math.max(0, currentTotal - previousTotal)
  });
  result.shockCheck = createLimbShockCheck(
    actor,
    limbKey,
    result.limbDelta,
    state?.nextValue,
    previousValue
  );
  return result;
}

function estimateProsthesisLimbDamage(actor, limbKey = "", amount = 0, { prosthesis = null, limbDamageMultiplier = 1, damageType = null, damageTypeKey = "", traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey) } = {}) {
  const damage = roundDamageAmount(amount * limbDamageMultiplier);
  const limbStates = new Map();
  const damageAccumulation = new Map();
  if (!prosthesis || damage <= 0) return createLimbMutationResult(limbStates, damageAccumulation);
  const result = estimateProsthesisConditionDamage(prosthesis, damage);
  const mutationResult = createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta: result.healthDelta,
    limbDelta: result.conditionDelta
  });
  mutationResult.brokenProsthesisLimbKeys = result.next <= 0 ? [limbKey] : [];
  return mutationResult;
}

function estimateEvenLimbDamage(actor, amount = 0, { damageType = null, damageTypeKey = "", traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey), limbStates = new Map(), damageAccumulation = new Map(), excludeLimbKeys = new Set() } = {}) {
  const targets = getPositiveHealthDamageTargets(actor, limbStates, excludeLimbKeys);
  const allocations = distributeCappedIntegerAmount(amount, targets.map(target => ({
    key: target.key,
    capacity: target.capacity
  })));
  return estimateHealthDamageTargetAllocations(actor, allocations, targets, {
    damageType,
    damageTypeKey,
    traumaDamageTypeKey,
    limbStates,
    damageAccumulation
  });
}

function estimateTargetedLimbDamage(actor, limbKey = "", amount = 0, {
  limbDamageMultiplier = 1,
  damageType = null,
  damageTypeKey = "",
  traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey),
  limbStates = new Map(),
  damageAccumulation = new Map(),
  evenDamageEstimator = null
} = {}) {
  const limb = actor?.system?.limbs?.[limbKey];
  const damage = roundDamageAmount(amount * limbDamageMultiplier);
  if (!limb || damage <= 0) return createLimbMutationResult(limbStates, damageAccumulation);
  if (isLimbPhysicallyMissing(actor, limbKey)) return createLimbMutationResult(limbStates, damageAccumulation);

  const currentValue = getLimbStateValue(actor, limbKey, limbStates);
  if (currentValue <= toInteger(limb.min)) return createLimbMutationResult(limbStates, damageAccumulation);
  if (currentValue < 0) {
    const limbResult = applyDamageAllocations(actor, new Map([[limbKey, damage]]), {
      damageType,
      damageTypeKey,
      traumaDamageTypeKey,
      limbStates,
      damageAccumulation
    });
    const spreadOptions = { excludeLimbKeys: new Set([limbKey]) };
    const spreadResult = typeof evenDamageEstimator === "function"
      ? evenDamageEstimator(damage, spreadOptions)
      : estimateEvenLimbDamage(actor, damage, {
        damageType,
        damageTypeKey,
        traumaDamageTypeKey,
        limbStates,
        damageAccumulation,
        ...spreadOptions
      });
    return createLimbMutationResult(limbStates, damageAccumulation, {
      healthDelta: limbResult.healthDelta + spreadResult.healthDelta,
      limbDelta: Array.from(limbStates.values()).reduce((sum, entry) => sum + entry.totalDelta, 0) + (spreadResult.prosthesisConditionDelta ?? 0)
    });
  }

  const result = applyDamageAllocations(actor, new Map([[limbKey, damage]]), {
    damageType,
    damageTypeKey,
    traumaDamageTypeKey,
    limbStates,
    damageAccumulation
  });
  const state = limbStates.get(limbKey);
  const negativeDamage = calculateNewNegativeLimbDamage(currentValue, state?.nextValue);
  if (negativeDamage <= 0) return result;

  const spreadOptions = { excludeLimbKeys: new Set([limbKey]) };
  const spreadResult = typeof evenDamageEstimator === "function"
    ? evenDamageEstimator(negativeDamage, spreadOptions)
    : estimateEvenLimbDamage(actor, negativeDamage, {
      damageType,
      damageTypeKey,
      traumaDamageTypeKey,
      limbStates,
      damageAccumulation,
      ...spreadOptions
    });
  return createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta: result.healthDelta + spreadResult.healthDelta,
    limbDelta: Array.from(limbStates.values()).reduce((sum, entry) => sum + entry.totalDelta, 0) + (spreadResult.prosthesisConditionDelta ?? 0)
  });
}

async function calculateTargetedLimbDamage(actor, limbKey = "", amount = 0, {
  limbDamageMultiplier = 1,
  damageType = null,
  damageTypeKey = "",
  traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey),
  limbStates = new Map(),
  damageAccumulation = new Map()
} = {}) {
  const limb = actor?.system?.limbs?.[limbKey];
  const damage = roundDamageAmount(amount * limbDamageMultiplier);
  if (!limb || damage <= 0) return createLimbMutationResult(limbStates, damageAccumulation);
  if (isLimbPhysicallyMissing(actor, limbKey)) return createLimbMutationResult(limbStates, damageAccumulation);

  const currentValue = getLimbStateValue(actor, limbKey, limbStates);
  if (currentValue <= toInteger(limb.min)) return createLimbMutationResult(limbStates, damageAccumulation);
  if (currentValue < 0) {
    const previousTotalDelta = Math.max(0, roundDamageAmount(limbStates.get(limbKey)?.totalDelta));
    const limbResult = applyDamageAllocations(actor, new Map([[limbKey, damage]]), {
      damageType,
      damageTypeKey,
      traumaDamageTypeKey,
      limbStates,
      damageAccumulation
    });
    const state = limbStates.get(limbKey);
    const appliedLimbDamage = Math.max(0, roundDamageAmount((state?.totalDelta ?? 0) - previousTotalDelta));
    const shockCheck = createLimbShockCheck(actor, limbKey, appliedLimbDamage, state?.nextValue, currentValue);
    const spreadResult = await calculateEvenLimbDamage(actor, damage, {
      damageType,
      damageTypeKey,
      traumaDamageTypeKey,
      limbStates,
      damageAccumulation,
      excludeLimbKeys: new Set([limbKey])
    });
    const result = createLimbMutationResult(limbStates, damageAccumulation, {
      healthDelta: limbResult.healthDelta + spreadResult.healthDelta,
      limbDelta: Array.from(limbStates.values()).reduce((sum, entry) => sum + entry.totalDelta, 0)
    });
    result.shockCheck = aggregateNegativeLimbShockChecks(actor, [shockCheck, spreadResult.shockCheck]);
    return result;
  }

  const previousTotalDelta = Math.max(0, roundDamageAmount(limbStates.get(limbKey)?.totalDelta));
  const result = applyDamageAllocations(actor, new Map([[limbKey, damage]]), {
    damageType,
    damageTypeKey,
    traumaDamageTypeKey,
    limbStates,
    damageAccumulation
  });
  const state = limbStates.get(limbKey);
  const appliedLimbDamage = Math.max(0, roundDamageAmount((state?.totalDelta ?? 0) - previousTotalDelta));
  const negativeDamage = calculateNewNegativeLimbDamage(currentValue, state?.nextValue);
  if (negativeDamage <= 0) return result;

  const spreadResult = await calculateEvenLimbDamage(actor, negativeDamage, {
    damageType,
    damageTypeKey,
    traumaDamageTypeKey,
    limbStates,
    damageAccumulation,
    excludeLimbKeys: new Set([limbKey])
  });
  const finalResult = createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta: result.healthDelta + spreadResult.healthDelta,
    limbDelta: Array.from(limbStates.values()).reduce((sum, entry) => sum + entry.totalDelta, 0)
  });
  finalResult.shockCheck = aggregateNegativeLimbShockChecks(actor, [
    createLimbShockCheck(actor, limbKey, appliedLimbDamage, state?.nextValue, currentValue),
    spreadResult.shockCheck
  ]);
  return finalResult;
}

function createLimbShockCheck(actor, limbKey = "", damage = 0, nextValue = null, previousValue = null) {
  if (!isConsciousnessRulesEnabled(actor) || isActorUnconsciousnessImmune(actor)) return null;
  const shockDamage = Math.max(0, roundDamageAmount(damage));
  if (shockDamage <= 0) return null;
  const damageHubOperationRef = String(getCurrentDamageHubOperationRef() ?? "").trim();
  const chanceOperationId = damageHubOperationRef
    ? `limb-shock:${damageHubOperationRef}:${String(actor?.uuid ?? actor?.id ?? "actor")}`
    : "";
  const activeUsePreparation = prepareActiveUseOperation({
    kind: "limbShockResistance",
    actor,
    keys: getUnconsciousnessResistanceActiveUseKeys(),
    conditionContexts: [{
      actorToken: actor?.token?.object ?? actor?.token ?? null,
      chanceOperationId
    }],
    reverseOnly: false
  });
  return {
    limbKey,
    damage: shockDamage,
    difficulty: calculateLimbShockDifficulty(actor, limbKey, shockDamage, nextValue, previousValue, { chanceOperationId }),
    chanceOperationId,
    activeUsePreparations: activeUsePreparation ? [activeUsePreparation] : []
  };
}

function calculateLimbShockDifficulty(actor, limbKey = "", damage = 0, nextValue = null, previousValue = null, context = {}) {
  const settings = getCombatSettings().unconsciousness;
  const variables = buildLimbShockFormulaVariables(actor, limbKey, damage, nextValue, previousValue);
  variables.resistance = toInteger(getContextualAbilityChangeValue(actor, "system.combat.unconsciousnessResistance", {
    ...context,
    actorToken: actor?.token?.object ?? actor?.token ?? null,
    baseValue: variables.resistance
  }));
  const normalDifficultyDamage = evaluateLimbShockFormula(settings.normalDamageFormula, {
    ...variables,
    damage: variables.normalDamage
  });
  const negativeDifficultyDamage = evaluateLimbShockFormula(settings.negativeDamageFormula, {
    ...variables,
    damage: variables.negativeDamage
  });
  const difficultyDamage = Math.max(0, normalDifficultyDamage + negativeDifficultyDamage);
  const limbDifficulty = variables.critical
    ? Math.max(0, evaluateLimbShockFormula(settings.criticalDamageFormula, {
      ...variables,
      damage: difficultyDamage
    }))
    : difficultyDamage;
  const stateMultiplier = Math.max(0, evaluateLimbShockFormula(settings.stateMultiplierFormula, {
    ...variables,
    damage: limbDifficulty
  }));
  return Math.max(0, roundDamageAmount((limbDifficulty * stateMultiplier) - variables.resistance));
}

function buildLimbShockFormulaVariables(actor, limbKey = "", damage = 0, nextValue = null, previousValue = null) {
  const amount = Math.max(0, roundDamageAmount(damage));
  const limb = actor?.system?.limbs?.[limbKey];
  const previous = Number.isFinite(Number(previousValue))
    ? toInteger(previousValue)
    : Number.isFinite(Number(nextValue))
      ? toInteger(nextValue) + amount
      : null;
  const resolvedPrevious = Number.isFinite(Number(previous)) ? toInteger(previous) : amount;
  const normalDamage = Math.min(amount, Math.max(0, resolvedPrevious));
  const negativeDamage = Math.max(0, amount - normalDamage);
  const min = toInteger(limb?.min);
  const max = Math.max(0, toInteger(limb?.max));
  const span = Math.max(1, Math.abs(min));
  const value = Number.isFinite(Number(nextValue)) ? toInteger(nextValue) : toInteger(limb?.value);
  const negativeDepthRatio = Math.min(1, Math.max(0, -value / span));
  const stateSpan = Math.max(1, max - min);
  const missingStateRatio = Math.min(1, Math.max(0, (max - value) / stateSpan));
  return {
    damage: amount,
    normalDamage,
    negativeDamage,
    previous: resolvedPrevious,
    next: value,
    min,
    max,
    missingStateRatio,
    negativeDepthRatio,
    critical: isCriticalLimb(actor, limbKey) ? 1 : 0,
    resistance: toInteger(actor?.system?.combat?.unconsciousnessResistance)
  };
}

function evaluateLimbShockFormula(formula, variables = {}) {
  try {
    const normalizedVariables = Object.fromEntries(
      Object.entries(variables ?? {}).map(([key, value]) => [String(key).toLowerCase(), Number(value) || 0])
    );
    const expression = parseFormula(String(formula ?? "0").trim() || "0", {
      variables: Object.keys(variables ?? {})
    });
    const value = expression.evaluate(identifier => normalizedVariables[String(identifier).toLowerCase()] ?? 0);
    return Number.isFinite(value) ? value : 0;
  } catch (error) {
    console.warn(`fallout-maw | Unconsciousness formula failed: ${error.message}`);
    return 0;
  }
}

function calculateEvenLimbHealing(actor, amount = 0, { limbStates = new Map(), damageAccumulation = new Map() } = {}) {
  const targets = getHealingLimbTargets(actor, limbStates);
  const allocations = distributeCappedIntegerAmount(amount, targets.map(target => ({
    key: target.key,
    capacity: Math.max(0, target.cap - target.value)
  })));
  return applyHealingAllocations(actor, allocations, { limbStates, damageAccumulation });
}

function calculateTargetedLimbHealing(actor, limbKey = "", amount = 0, {
  limbStates = new Map(),
  damageAccumulation = new Map(),
  context = buildActorLimbHealthContext(actor)
} = {}) {
  const limb = actor?.system?.limbs?.[limbKey];
  const healing = roundDamageAmount(amount);
  if (!limb || healing <= 0) return createLimbMutationResult(limbStates, damageAccumulation);
  if (isLimbPhysicallyMissing(actor, limbKey)) return createLimbMutationResult(limbStates, damageAccumulation);

  const currentValue = getLimbStateValue(actor, limbKey, limbStates);
  const cap = Math.min(Math.max(0, toInteger(limb.max)), getLimbHealingCap(actor, limbKey, context));
  const capacity = Math.max(0, cap - currentValue);
  return applyHealingAllocations(actor, new Map([[limbKey, Math.min(healing, capacity)]]), {
    limbStates,
    damageAccumulation,
    context
  });
}

async function applyHealthDamageTargetAllocations(actor, allocations = new Map(), targets = [], { damageType = null, damageTypeKey = "", traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey), limbStates = new Map(), damageAccumulation = new Map() } = {}) {
  const targetsByKey = new Map(targets.map(target => [target.key, target]));
  const limbAllocations = new Map();
  let prosthesisHealthDelta = 0;
  let prosthesisConditionDelta = 0;
  const shockChecks = [];

  for (const [targetKey, amount] of allocations) {
    const target = targetsByKey.get(targetKey);
    if (!target) continue;
    if (target.type === "prosthesis") {
      const result = await applyProsthesisIntegratedHealthDamage(actor, target.prosthesis, amount);
      prosthesisHealthDelta += result.healthDelta;
      prosthesisConditionDelta += result.conditionDelta;
      if (result.shockCheck) shockChecks.push(result.shockCheck);
      continue;
    }
    limbAllocations.set(target.limbKey ?? target.key, (limbAllocations.get(target.limbKey ?? target.key) ?? 0) + amount);
  }

  const limbResult = applyDamageAllocations(actor, limbAllocations, {
    damageType,
    damageTypeKey,
    traumaDamageTypeKey,
    limbStates,
    damageAccumulation
  });
  const result = createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta: limbResult.healthDelta + prosthesisHealthDelta,
    limbDelta: limbResult.limbDelta + prosthesisConditionDelta
  });
  result.prosthesisConditionDelta = prosthesisConditionDelta;
  result.shockCheck = aggregateNegativeLimbShockChecks(actor, shockChecks);
  return result;
}

function estimateHealthDamageTargetAllocations(actor, allocations = new Map(), targets = [], { damageType = null, damageTypeKey = "", traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey), limbStates = new Map(), damageAccumulation = new Map() } = {}) {
  const targetsByKey = new Map(targets.map(target => [target.key, target]));
  const limbAllocations = new Map();
  let prosthesisHealthDelta = 0;
  let prosthesisConditionDelta = 0;
  const brokenProsthesisLimbKeys = [];

  for (const [targetKey, amount] of allocations) {
    const target = targetsByKey.get(targetKey);
    if (!target) continue;
    if (target.type === "prosthesis") {
      const result = estimateProsthesisIntegratedHealthDamage(target.prosthesis, amount);
      prosthesisHealthDelta += result.healthDelta;
      prosthesisConditionDelta += result.conditionDelta;
      if (result.broken) brokenProsthesisLimbKeys.push(target.limbKey);
      continue;
    }
    limbAllocations.set(target.limbKey ?? target.key, (limbAllocations.get(target.limbKey ?? target.key) ?? 0) + amount);
  }

  const limbResult = applyDamageAllocations(actor, limbAllocations, {
    damageType,
    damageTypeKey,
    traumaDamageTypeKey,
    limbStates,
    damageAccumulation
  });
  const result = createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta: limbResult.healthDelta + prosthesisHealthDelta,
    limbDelta: limbResult.limbDelta + prosthesisConditionDelta
  });
  result.prosthesisConditionDelta = prosthesisConditionDelta;
  result.brokenProsthesisLimbKeys = brokenProsthesisLimbKeys;
  return result;
}

function applyDamageAllocations(actor, allocations = new Map(), { damageType = null, damageTypeKey = "", traumaDamageTypeKey = getTraumaDamageTypeKey(damageTypeKey), limbStates = new Map(), damageAccumulation = new Map() } = {}) {
  let healthDelta = 0;
  for (const [limbKey, amount] of allocations) {
    const limb = actor?.system?.limbs?.[limbKey];
    const damage = roundDamageAmount(amount);
    if (!limb || damage <= 0) continue;

    const state = getBatchLimbState(limbStates, actor, limbKey, limb);
    const limbDamage = calculateLimbStateDamage(damage);
    if (!limbDamage) continue;

    const previousRunningValue = state.nextValue;
    state.nextValue = Math.max(state.min, state.nextValue - limbDamage);
    const actualLimbDelta = Math.max(0, previousRunningValue - state.nextValue);
    if (!actualLimbDelta) continue;

    const positiveLoss = Math.max(0, previousRunningValue) - Math.max(0, state.nextValue);
    healthDelta += Math.max(0, positiveLoss);
    state.totalDelta += actualLimbDelta;
    if (traumaDamageTypeKey) {
      state.damageByType[traumaDamageTypeKey] = (state.damageByType[traumaDamageTypeKey] ?? 0) + actualLimbDelta;
      addBatchDamageAccumulation(damageAccumulation, actor, limbKey, traumaDamageTypeKey, actualLimbDelta);
    }
  }

  return createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta,
    limbDelta: Array.from(limbStates.values()).reduce((sum, state) => sum + state.totalDelta, 0)
  });
}

function getTraumaDamageTypeKey(damageTypeKey = "") {
  const key = String(damageTypeKey ?? "").trim();
  return key === BLEEDING_DAMAGE_TYPE_KEY ? "" : key;
}

function applyHealingAllocations(actor, allocations = new Map(), {
  limbStates = new Map(),
  damageAccumulation = new Map(),
  context = buildActorLimbHealthContext(actor)
} = {}) {
  let healthDelta = 0;
  for (const [limbKey, amount] of allocations) {
    const limb = actor?.system?.limbs?.[limbKey];
    const healing = roundDamageAmount(amount);
    if (!limb || healing <= 0) continue;

    const state = getBatchLimbState(limbStates, actor, limbKey, limb);
    const cap = Math.min(Math.max(0, toInteger(limb.max)), getLimbHealingCap(actor, limbKey, context));
    const previousRunningValue = state.nextValue;
    state.nextValue = Math.min(cap, state.nextValue + healing);
    const actualLimbDelta = calculateConsciousnessHealingGain(previousRunningValue, state.nextValue);
    if (!actualLimbDelta) continue;

    const positiveGain = Math.max(0, state.nextValue) - Math.max(0, previousRunningValue);
    healthDelta += Math.max(0, positiveGain);
    state.totalDelta += actualLimbDelta;
    diluteBatchDamageAccumulation(damageAccumulation, actor, limbKey, actualLimbDelta);
  }

  return createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta,
    limbDelta: Array.from(limbStates.values()).reduce((sum, state) => sum + state.totalDelta, 0)
  });
}

function createLimbMutationResult(limbStates = new Map(), damageAccumulation = new Map(), { healthDelta = 0, limbDelta = 0 } = {}) {
  return {
    limbStates,
    damageAccumulation,
    values: Object.fromEntries(Array.from(limbStates.entries()).map(([limbKey, state]) => [limbKey, state.nextValue])),
    healthDelta: roundDamageAmount(healthDelta),
    limbDelta: roundDamageAmount(limbDelta),
    shockCheck: null
  };
}

function getHealingNumberAmount(result = {}) {
  return Math.max(roundDamageAmount(result?.healthDelta), roundDamageAmount(result?.limbDelta));
}

function calculateNewNegativeLimbDamage(previousValue = 0, nextValue = 0) {
  const previousNegativeDepth = Math.max(0, -toInteger(previousValue));
  const nextNegativeDepth = Math.max(0, -toInteger(nextValue));
  return roundDamageAmount(Math.max(0, nextNegativeDepth - previousNegativeDepth));
}

function getPositiveHealthDamageTargets(actor, limbStates = new Map(), excludeLimbKeys = new Set()) {
  const limbHealthContext = buildActorLimbHealthContext(actor);
  return [
    ...getPositiveLimbTargets(actor, limbStates, excludeLimbKeys, limbHealthContext),
    ...getIntegratedProsthesisHealthDamageTargets(actor, excludeLimbKeys, limbHealthContext)
  ];
}

function getPositiveLimbTargets(
  actor,
  limbStates = new Map(),
  excludeLimbKeys = new Set(),
  context = buildActorLimbHealthContext(actor)
) {
  const excluded = new Set(Array.from(excludeLimbKeys ?? []).map(key => String(key)));
  return Object.entries(actor?.system?.limbs ?? {})
    .filter(([key]) => !excluded.has(String(key)))
    .filter(([key]) => !isLimbPhysicallyMissing(actor, key))
    .map(([key, limb]) => {
      const value = getLimbStateValue(actor, key, limbStates, context);
      const min = toInteger(limb?.min);
      return {
        type: "limb",
        key,
        limbKey: key,
        value,
        min,
        capacity: Math.max(0, value - min)
      };
    })
    .filter(target => target.value > 0 && target.value > target.min);
}

function getIntegratedProsthesisHealthDamageTargets(
  actor,
  excludeLimbKeys = new Set(),
  context = buildActorLimbHealthContext(actor)
) {
  const excluded = new Set(Array.from(excludeLimbKeys ?? []).map(key => String(key)));
  const targets = [];
  for (const [limbKey, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    if (!isLimbPhysicallyMissing(actor, limbKey) || excluded.has(String(limbKey))) continue;
    const prosthesis = getInstalledProsthesis(actor, limbKey, context);
    if (!prosthesis || !hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) continue;
    const contribution = getProsthesisHealthForAggregate(prosthesis, limb);
    if (contribution.value <= 0) continue;
    targets.push({
      type: "prosthesis",
      key: getProsthesisHealthDamageTargetKey(prosthesis),
      itemId: prosthesis.id,
      limbKey,
      prosthesis,
      capacity: contribution.value
    });
  }
  return targets;
}

function getProsthesisHealthDamageTargetKey(prosthesis) {
  return `prosthesis:${prosthesis?.id ?? ""}`;
}

function getIntegratedProsthesisHealthHealingTargets(
  actor,
  context = buildActorLimbHealthContext(actor)
) {
  const targets = [];
  for (const [limbKey, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    if (!isLimbPhysicallyMissing(actor, limbKey)) continue;
    const prosthesis = getInstalledProsthesis(actor, limbKey, context);
    if (!prosthesis || !hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) continue;
    const contribution = getProsthesisHealthForAggregate(prosthesis, limb);
    if (contribution.value >= contribution.max) continue;
    targets.push({
      type: "prosthesis",
      key: getProsthesisHealthDamageTargetKey(prosthesis),
      itemId: prosthesis.id,
      limbKey,
      prosthesis,
      capacity: Math.max(0, contribution.max - contribution.value)
    });
  }
  return targets;
}

function getHealingLimbTargets(actor, limbStates = new Map()) {
  const limbHealthContext = buildActorLimbHealthContext(actor);
  return Object.entries(actor?.system?.limbs ?? {})
    .filter(([key]) => !isLimbPhysicallyMissing(actor, key))
    .map(([key, limb]) => {
      const value = getLimbStateValue(actor, key, limbStates, limbHealthContext);
      return {
        key,
        value,
        cap: Math.min(
          Math.max(0, toInteger(limb?.max)),
          getLimbHealingCap(actor, key, limbHealthContext)
        )
      };
    })
    .filter(target => target.value < target.cap);
}

function getLimbStateValue(actor, limbKey = "", limbStates = new Map(), context = null) {
  if (limbStates.has(limbKey)) return toInteger(limbStates.get(limbKey)?.nextValue);
  return getEffectiveLimbStateValue(actor, limbKey, null, context);
}

function distributeCappedIntegerAmount(amount = 0, targets = []) {
  let remaining = roundDamageAmount(amount);
  const allocations = new Map();
  let open = targets
    .map(target => ({
      key: String(target.key ?? ""),
      capacity: Math.max(0, roundDamageAmount(target.capacity))
    }))
    .filter(target => target.key && target.capacity > 0);

  while (remaining > 0 && open.length) {
    const share = Math.max(1, Math.floor(remaining / open.length));
    let spentThisPass = 0;
    const nextOpen = [];
    for (const target of open) {
      if (remaining <= 0) {
        nextOpen.push(target);
        continue;
      }
      const applied = Math.min(target.capacity, share, remaining);
      if (applied > 0) {
        allocations.set(target.key, (allocations.get(target.key) ?? 0) + applied);
        target.capacity -= applied;
        remaining -= applied;
        spentThisPass += applied;
      }
      if (target.capacity > 0) nextOpen.push(target);
    }
    if (!spentThisPass) break;
    open = nextOpen;
  }

  return allocations;
}

function getBatchLimbState(limbStates, actor, limbKey, limb) {
  let state = limbStates.get(limbKey);
  if (state) return state;
  const previousValue = clampLimbStateValue(actor, limbKey, limb.value);
  state = {
    previousValue,
    nextValue: previousValue,
    min: toInteger(limb.min),
    totalDelta: 0,
    damageByType: {},
    damageAccumulationSnapshot: normalizeDamageAccumulation(actor?.system?.limbs?.[limbKey]?.damageAccumulation ?? {})
  };
  limbStates.set(limbKey, state);
  return state;
}

function addBatchDamageAccumulation(accumulations, actor, limbKey, damageTypeKey, amount) {
  if (!amount) return;
  let accumulation = accumulations.get(limbKey);
  if (!accumulation) {
    accumulation = { ...(actor.system?.limbs?.[limbKey]?.damageAccumulation ?? {}) };
    accumulations.set(limbKey, accumulation);
  }
  const key = damageTypeKey || "untyped";
  accumulation[key] = Math.max(0, Number(accumulation[key]) || 0) + amount;
}

function diluteBatchDamageAccumulation(accumulations, actor, limbKey, amount) {
  if (!amount) return;
  let accumulation = accumulations.get(limbKey);
  if (!accumulation) {
    accumulation = { ...(actor.system?.limbs?.[limbKey]?.damageAccumulation ?? {}) };
    accumulations.set(limbKey, accumulation);
  }
  diluteDamageAccumulation(accumulation, amount);
}

function normalizeDamageAccumulation(value = {}) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([key, amount]) => [key, Math.max(0, Number(amount) || 0)])
      .filter(([_key, amount]) => amount > 0)
  );
}

function actorHasTimedDamageTimeWork(actor) {
  return Boolean(actor?.effects?.some(effect => {
    if (effect?.disabled) return false;
    if (getDamageEffectChanges(effect).some(isDamageHubManagedTimedEffect)) return true;
    if (getPeriodicHealingEffectChanges(effect).length) return true;
    return isFlagManagedTimedEffect(effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY));
  }));
}

function hasTimedEffectReachedEnd(effect, data = {}, now = 0) {
  const endTime = Number(data.endTime);
  if (Number.isFinite(endTime) && Number(now) >= endTime) return true;
  const remaining = Number(effect?.duration?.remaining);
  return Number.isFinite(remaining) && remaining <= 0;
}

function queueDamageFeedback(queue, {
  actor = null,
  mitigationDisplay = null,
  damageEntries = []
} = {}) {
  const descriptor = {
    actor,
    mitigationDisplay,
    damageEntries: Array.isArray(damageEntries) ? damageEntries : []
  };
  if (!descriptor.actor?.uuid) return;
  if (!descriptor.mitigationDisplay && !descriptor.damageEntries.length) return;
  if (Array.isArray(queue)) {
    queue.push(descriptor);
    return;
  }
  flushDamageFeedback([descriptor]);
}

function flushDamageFeedback(queue = []) {
  for (const descriptor of queue) {
    if (descriptor?.mitigationDisplay) {
      broadcastDamageMitigationIcon(descriptor.actor, descriptor.mitigationDisplay);
    }
    if (descriptor?.damageEntries?.length) {
      broadcastDamageNumbers(descriptor.actor, descriptor.damageEntries);
    }
  }
  if (Array.isArray(queue)) queue.length = 0;
}

function broadcastDamageNumbers(actor, entries = []) {
  const payloadEntries = prepareDamageNumberEntries(entries);
  if (!actor?.uuid || !payloadEntries.length) return;
  displayDamageNumbersForActor(actor.uuid, payloadEntries);
  game.socket.emit(DAMAGE_SOCKET, {
    action: "showDamageNumbers",
    senderUserId: game.user?.id ?? "",
    actorUuid: actor.uuid,
    entries: payloadEntries
  });
}

function broadcastDamageMitigationIcon(actor, display = null) {
  const payloadDisplay = normalizeDamageMitigationDisplay(display);
  if (!actor?.uuid || !payloadDisplay) return;
  displayDamageMitigationIconForActor(actor.uuid, payloadDisplay);
  game.socket.emit(DAMAGE_SOCKET, {
    action: "showDamageMitigationIcon",
    senderUserId: game.user?.id ?? "",
    actorUuid: actor.uuid,
    display: payloadDisplay
  });
}

function prepareDamageNumberEntries(entries = []) {
  const damageTypes = getPreparedRuntimeSettings().damageTypeSettings;
  return entries
    .map(entry => {
      const amount = roundDamageAmount(entry.amount);
      const damageTypeKey = String(entry.damageTypeKey ?? "").trim();
      const mode = entry.mode === MODE_HEALING ? MODE_HEALING : MODE_DAMAGE;
      const damageType = damageTypes.find(type => type.key === damageTypeKey);
      return {
        amount,
        damageTypeKey,
        mode,
        color: mode === MODE_HEALING ? HEALING_NUMBER_COLOR : (damageType?.color ?? "#f0d48a")
      };
    })
    .filter(entry => entry.amount > 0);
}

function displayDamageNumbersForActor(actorUuid = "", entries = []) {
  if (!canvas?.ready || !actorUuid || !entries?.length) return;
  const tokens = (canvas.tokens?.placeables ?? []).filter(token => (
    token.actor?.uuid === actorUuid
    && isTokenVisibleToCurrentUser(token)
  ));
  for (const token of tokens) {
    entries.forEach((entry, index) => animateDamageNumber(token, entry, index, entries.length));
  }
}

function animateDamageNumber(token, entry, index = 0, total = 1) {
  const layer = canvas.controls?._rulerPaths;
  if (!layer) return;

  const text = new PIXI.Text(entry.mode === MODE_HEALING ? `+${entry.amount}` : String(entry.amount), {
    fill: entry.color,
    fontFamily: "serif",
    fontSize: 32,
    fontWeight: "700",
    stroke: "#090604",
    strokeThickness: 4,
    dropShadow: true,
    dropShadowColor: "#000000",
    dropShadowAlpha: 0.75,
    dropShadowBlur: 4,
    dropShadowDistance: 2
  });
  text.anchor.set(0.5);
  text.zIndex = 10000;

  const center = getTokenAnimationOrigin(token);
  const spreadOffset = (index - ((total - 1) / 2)) * 24;
  const angle = ((-160 + (Math.random() * 120)) * Math.PI) / 180;
  const distance = 72 + (Math.random() * 42);
  const driftX = Math.cos(angle) * distance + spreadOffset;
  const driftY = Math.sin(angle) * distance - 30;
  const arc = 72 + (Math.random() * 24);
  const startedAt = performance.now();

  text.position.set(center.x + spreadOffset, center.y - (token.h * 0.35));
  layer.addChild(text);

  const tick = () => {
    if (text.destroyed) {
      canvas.app.ticker.remove(tick);
      return;
    }
    const elapsed = performance.now() - startedAt;
    const t = Math.min(1, elapsed / DAMAGE_NUMBER_ANIMATION_MS);
    const eased = 1 - ((1 - t) ** 3);
    text.position.set(
      center.x + spreadOffset + (driftX * eased),
      center.y - (token.h * 0.35) + (driftY * eased) + (arc * t * t)
    );
    text.alpha = Math.max(0, 1 - (t * 0.9));
    text.scale.set(1 + (Math.sin(Math.PI * t) * 0.18));
    if (t < 1) return;
    canvas.app.ticker.remove(tick);
    text.destroy();
  };
  canvas.app.ticker.add(tick);
}

function displayDamageMitigationIconForActor(actorUuid = "", display = null) {
  const payloadDisplay = normalizeDamageMitigationDisplay(display);
  if (!canvas?.ready || !actorUuid || !payloadDisplay) return;
  const tokens = (canvas.tokens?.placeables ?? []).filter(token => token.actor?.uuid === actorUuid);
  for (const token of tokens) void animateDamageMitigationIcon(token, payloadDisplay);
}

async function animateDamageMitigationIcon(token, display = null) {
  const payloadDisplay = normalizeDamageMitigationDisplay(display);
  if (!payloadDisplay || !isTokenVisibleToCurrentUser(token)) return;

  const icons = getTokenActionHudDamageIcons();
  const path = payloadDisplay.tier === 2 ? icons.damageBlockedIcon : icons.damageReductionIcon;
  const texture = await getDamageMitigationTexture(path);
  if (!texture?.valid) return;

  const layer = canvas.controls?._rulerPaths ?? canvas.interface ?? canvas.stage;
  if (!layer) return;

  const container = new PIXI.Container();
  container.eventMode = "none";
  container.interactive = false;
  container.interactiveChildren = false;
  container.zIndex = 10000;

  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5);

  const gridSize = canvas?.grid?.size || canvas?.scene?.grid?.size || 100;
  const baseSize = Math.max(24, Math.floor(gridSize * 0.95));
  const textureSize = Math.max(1, Number(texture.width) || 0, Number(texture.height) || 0);
  const baseScale = baseSize / textureSize;
  sprite.scale.set(baseScale * 0.86);
  container.addChild(sprite);

  const label = payloadDisplay.tier === 1
    ? createDamageMitigationPercentLabel(payloadDisplay.percent, baseSize)
    : null;
  if (label) container.addChild(label);

  const center = getTokenAnimationOrigin(token);
  const tokenTop = Number(token.top ?? token.y ?? (center.y - (token.h / 2))) || center.y;
  const startY = tokenTop - Math.max(4, gridSize * 0.06);
  const floatUp = Math.max(22, gridSize * 0.32);
  const startedAt = performance.now();

  container.position.set(center.x, startY);
  layer.sortableChildren = true;
  layer.addChild(container);

  const tick = () => {
    if (container.destroyed) {
      canvas.app.ticker.remove(tick);
      return;
    }

    const elapsed = performance.now() - startedAt;
    const t = Math.min(1, elapsed / DAMAGE_MITIGATION_ICON_ANIMATION_MS);
    const eased = 1 - ((1 - t) ** 3);
    const fadeIn = Math.min(1, t / 0.18);
    const fadeOut = t > 0.78 ? Math.max(0, 1 - ((t - 0.78) / 0.22)) : 1;
    const alpha = fadeIn * fadeOut;

    container.y = startY - (floatUp * eased);
    container.alpha = alpha;
    const pulse = 0.86 + (Math.sin(Math.PI * t) * 0.18);
    sprite.scale.set(baseScale * pulse);
    if (t < 1) return;

    canvas.app.ticker.remove(tick);
    container.destroy({ children: true, texture: false, baseTexture: false });
  };
  canvas.app.ticker.add(tick);
}

function createDamageMitigationPercentLabel(percent, baseSize) {
  const label = new PIXI.Text(`${Math.max(1, Math.min(100, toInteger(percent)))}%`, {
    fill: "#ffffff",
    fontFamily: "Arial",
    fontSize: Math.max(11, Math.floor(baseSize * 0.24)),
    fontWeight: "900",
    stroke: "#17110b",
    strokeThickness: 5,
    dropShadow: true,
    dropShadowColor: "#000000",
    dropShadowAlpha: 0.7,
    dropShadowBlur: 2,
    dropShadowDistance: 1
  });
  label.anchor.set(0.5);
  label.y = -baseSize * 0.08;
  return label;
}

async function getDamageMitigationTexture(path) {
  const src = String(path ?? "").trim();
  if (!src) return null;
  if (damageMitigationTextureCache.has(src)) return damageMitigationTextureCache.get(src);
  try {
    const texture = await foundry.canvas.loadTexture(src);
    damageMitigationTextureCache.set(src, texture);
    return texture;
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Damage mitigation icon failed to load: ${src}`, error);
    damageMitigationTextureCache.set(src, null);
    return null;
  }
}

function isTokenVisibleToCurrentUser(token) {
  if (!token) return false;
  if (token.document?.hidden && !game.user?.isGM) return false;
  if (token.visible === false) return false;
  return true;
}

function getTokenAnimationOrigin(token) {
  return token.center ?? {
    x: token.x + (token.w / 2),
    y: token.y + (token.h / 2)
  };
}

function normalizeDamageRequest(request = {}) {
  const amount = Math.max(0, Math.floor(Number(request.amount) || 0));
  const limbKey = String(request.limbKey ?? "").trim();
  const mode = request.mode === MODE_HEALING || request.mode === "heal" ? MODE_HEALING : MODE_DAMAGE;
  const source = request.source && typeof request.source === "object" ? request.source : {};
  return {
    actorUuid: String(request.actorUuid ?? request.actor?.uuid ?? "").trim(),
    limbKey,
    itemId: String(request.itemId ?? request.targetItemId ?? source.targetItemId ?? "").trim(),
    amount,
    damageTypeKey: mode === MODE_HEALING ? HEALING_DAMAGE_TYPE_KEY : String(request.damageTypeKey ?? "").trim(),
    mode,
    scope: normalizeScope(request.scope, limbKey, request.itemId ?? request.targetItemId ?? source.targetItemId),
    applyMitigation: request.applyMitigation !== false,
    processDamageTypeSettings: request.processDamageTypeSettings !== false,
    bypassBarrier: request.bypassBarrier === true || source.bypassBarrier === true,
    damageEventIndex: Number.isInteger(Number(request.damageEventIndex))
      ? Number(request.damageEventIndex)
      : -1,
    source,
    requesterUserId: String(request.requesterUserId ?? "")
  };
}

function createActorDamageBarrierLedger(actor) {
  return createDamageBarrierLedger(actor, {
    evaluateChange: (targetActor, change) => evaluateActorEffectChangeBaseNumber(targetActor, change, {
      fallback: 0
    })
  });
}

function replaceDamageAccumulation(value = {}) {
  return foundry.data.operators.ForcedReplacement.create(normalizeDamageAccumulation(value));
}

function getDamageRequestConditionItem(actor, data = {}) {
  const itemId = String(data.itemId ?? data.targetItemId ?? data.source?.targetItemId ?? "").trim();
  if (!itemId) return null;
  const item = actor?.items?.get?.(itemId) ?? null;
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) return null;
  return item;
}

function getDamageMitigationWearResistance(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation)) return 0;
  return Math.max(0, toInteger(getDamageMitigationFunction(item).wearResistance));
}

function getConditionWearPacketId(source = {}) {
  return String(source?.conditionWearPacketId ?? "").trim();
}

function estimateItemConditionDamage(actor, data = {}) {
  const item = getDamageRequestConditionItem(actor, data);
  if (!item) return 0;
  const current = Math.max(0, toInteger(getConditionFunction(item).value));
  const amount = Math.max(0, roundDamageAmount(data.amount) - getDamageMitigationWearResistance(item));
  return Math.min(current, amount);
}

function getDamageApplicationWorldTime(source = {}) {
  const value = Number(source?.worldTime);
  return Number.isFinite(value) ? value : (Number(game.time?.worldTime) || 0);
}

function shouldSplitPeriodicDamage(data = {}, mode = MODE_DAMAGE, periodic = null) {
  return mode === MODE_DAMAGE
    && data.processDamageTypeSettings
    && periodic?.enabled
    && !isPeriodicDamageSplitSuppressed(data.source);
}

function calculatePeriodicDamageSplit(amount = 0, periodic = {}) {
  const incoming = Math.max(0, roundDamageAmount(amount));
  return {
    immediateAmount: roundDamageAmount(incoming * (Number(periodic.immediatePercent) || 0) / 100),
    delayedAmount: roundDamageAmount(incoming * (Number(periodic.delayedPercent) || 0) / 100)
  };
}

function isPeriodicDamageSplitSuppressed(source = {}) {
  return Boolean(source?.falloutMawPeriodicDamageNoSplit || source?.periodicDamageEffectUuid);
}

function shouldCreateBleedingDamageEffect(damageType = {}, bleeding = null, source = {}) {
  return Boolean(
    damageType?.key
    && damageType.key !== BLEEDING_DAMAGE_TYPE_KEY
    && bleeding?.enabled
    && !source?.falloutMawBleedingDamageTick
    && !source?.bleedingDamageEffectUuid
  );
}

function distributeIntegerAmountAcrossTicks(amount = 0, tickCount = 1) {
  const total = roundDamageAmount(amount);
  const count = Math.max(1, toInteger(tickCount));
  const base = Math.floor(total / count);
  let remainder = total - (base * count);
  return Array.from({ length: count }, () => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    return base + extra;
  });
}

function markPeriodicDamageSplitSource(source = {}) {
  return {
    ...(source && typeof source === "object" ? source : {}),
    falloutMawPeriodicDamageNoSplit: true
  };
}

function markPeriodicDamageTickSource(source = {}) {
  return {
    ...markPeriodicDamageSplitSource(source),
    falloutMawPeriodicDamageTick: true
  };
}

function markBleedingDamageTickSource(source = {}) {
  return {
    ...markPeriodicDamageSplitSource(source),
    ...(source && typeof source === "object" ? source : {}),
    falloutMawBleedingDamageTick: true
  };
}

function normalizeScope(scope, limbKey = "", itemId = "") {
  if (scope === SCOPE_ITEM_CONDITION) return String(itemId ?? "").trim() ? SCOPE_ITEM_CONDITION : SCOPE_HEALTH;
  if (scope === SCOPE_HEALTH) return SCOPE_HEALTH;
  if (scope === SCOPE_LIMB) return limbKey ? SCOPE_LIMB : SCOPE_HEALTH;
  return limbKey ? SCOPE_HEALTH_AND_LIMB : SCOPE_HEALTH;
}

function canApplyDamageLocally(actor) {
  const activeGM = game.users?.activeGM ?? null;
  if (activeGM) return activeGM.id === game.user?.id;
  return Boolean(actor?.isOwner);
}

function getResponsibleGM() {
  return game.users?.activeGM ?? null;
}

function synchronizeManualLimbValueUpdates(actor, changes = {}) {
  let restoredHealth = 0;
  const limbHealthContext = buildActorLimbHealthContext(actor);
  for (const [limbKey, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    const valuePath = `system.limbs.${limbKey}.value`;
    if (!hasUpdatePath(changes, valuePath)) continue;
    const previousValue = getEffectiveLimbStateValue(actor, limbKey, null, limbHealthContext);
    const restoringMissing = getUpdatePath(changes, `system.limbs.${limbKey}.missing`) === false;
    const value = clampLimbStateValueForUpdate(actor, limbKey, getUpdatePath(changes, valuePath), {
      restoringMissing,
      context: limbHealthContext
    });
    setUpdatePath(changes, valuePath, value);
    setUpdatePath(changes, `system.limbs.${limbKey}.spent`, calculateLimbSpentFromValue(limb, value));
    const accumulationPath = `system.limbs.${limbKey}.damageAccumulation`;
    if (value > previousValue) {
      restoredHealth += calculateConsciousnessHealingGain(previousValue, value);
      if (!hasUpdatePath(changes, accumulationPath)) {
        Object.assign(changes, buildAccumulationUpdate(actor, limbKey, "", value - previousValue, MODE_HEALING));
      }
    }
  }
  return roundDamageAmount(restoredHealth);
}

function setLimbValueUpdate(updateData, actor, limbKey, value, { persistValue = true } = {}) {
  const limb = actor?.system?.limbs?.[limbKey];
  if (persistValue) setUpdatePath(updateData, `system.limbs.${limbKey}.value`, value);
  setUpdatePath(updateData, `system.limbs.${limbKey}.spent`, calculateLimbSpentFromValue(limb, value));
}

function calculateLimbSpentFromValue(limb, value) {
  const max = Math.max(0, toInteger(limb?.max));
  const min = -max;
  const capacity = Math.max(0, max - min);
  const boundedValue = Math.min(Math.max(toInteger(value), min), max);
  return Math.min(Math.max(0, max - boundedValue), capacity);
}

function buildLimbValueCapSyncUpdate(actor) {
  const updates = {};
  const limbHealthContext = buildActorLimbHealthContext(actor);
  for (const [limbKey, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    if (!limb || typeof limb !== "object") continue;
    const currentValue = getUncappedSourceLimbValue(actor, limbKey, limb);
    const boundedValue = clampLimbStateValue(actor, limbKey, currentValue, limbHealthContext);
    const spent = calculateLimbSpentFromValue(limb, boundedValue);
    const sourceLimb = getSourceLimb(actor, limbKey);
    const sourceSpentMatches = !sourceLimb
      || !Object.hasOwn(sourceLimb, "spent")
      || toInteger(sourceLimb.spent) === spent;
    if (boundedValue === currentValue && sourceSpentMatches) continue;
    updates[`system.limbs.${limbKey}.value`] = boundedValue;
    updates[`system.limbs.${limbKey}.spent`] = spent;
  }
  return updates;
}

function getSourceLimb(actor, limbKey = "") {
  return actor?._source?.system?.limbs?.[limbKey] ?? actor?.system?._source?.limbs?.[limbKey] ?? null;
}

function getUncappedSourceLimbValue(actor, limbKey = "", limb = null) {
  const source = getSourceLimb(actor, limbKey);
  const max = Math.max(0, toInteger(limb?.max));
  const min = toInteger(limb?.min ?? -max);
  const capacity = Math.max(0, max - min);
  if (source && typeof source === "object" && Object.hasOwn(source, "spent")) {
    const spent = Math.min(Math.max(0, toInteger(source.spent)), capacity);
    return Math.min(Math.max(max - spent, min), max);
  }
  return Math.min(Math.max(toInteger(source?.value ?? limb?.value), min), max);
}

function getEffectiveLimbStateValue(actor, limbKey = "", value = null, context = null) {
  const limb = actor?.system?.limbs?.[limbKey];
  return clampLimbStateValue(actor, limbKey, value ?? limb?.value, context);
}

function clampLimbStateValueForUpdate(
  actor,
  limbKey = "",
  value = null,
  { restoringMissing = false, context = null } = {}
) {
  if (!restoringMissing) return clampLimbStateValue(actor, limbKey, value, context);
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return 0;
  const max = Math.max(0, toInteger(limb.max));
  const min = toInteger(limb.min ?? -max);
  return Math.min(Math.max(toInteger(value), min), max);
}

function clampLimbStateValue(actor, limbKey = "", value = null, context = null) {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return 0;
  const max = Math.max(0, toInteger(limb.max));
  const min = toInteger(limb.min ?? -max);
  const cap = getLimbEffectiveMaximum(actor, limbKey, context);
  return Math.min(Math.max(toInteger(value), min), cap);
}

function hasUpdatePath(object, path) {
  return foundry.utils.hasProperty(object, path) || Object.hasOwn(object ?? {}, path);
}

function getUpdatePath(object, path) {
  if (foundry.utils.hasProperty(object, path)) return foundry.utils.getProperty(object, path);
  return object?.[path];
}

function setUpdatePath(object, path, value) {
  if (Object.hasOwn(object ?? {}, path)) object[path] = value;
  else foundry.utils.setProperty(object, path, value);
}

function deleteUpdatePath(object, path) {
  if (Object.hasOwn(object ?? {}, path)) delete object[path];
  if (foundry.utils.hasProperty(object, path)) foundry.utils.deleteProperty(object, path);
}

function updateTouchesPath(object, path) {
  if (foundry.utils.hasProperty(object, path)) return true;
  return Object.keys(object ?? {}).some(key => key === path || key.startsWith(`${path}.`));
}

function selectRandomDamageLimbKey(actor) {
  return selectRandomWeightedLimbKey(actor);
}

function calculateEffectiveDamage(actor, amount, damageTypeKey = "", limbKey = "", source = {}, options = {}) {
  return calculateDamageMitigation(actor, amount, damageTypeKey, limbKey, source, options).amount;
}

export function calculateDamageMitigation(actor, amount, damageTypeKey = "", limbKey = "", source = {}, options = {}) {
  const incomingDamage = Math.max(0, Math.floor(Number(amount) || 0));
  const mitigationPenetration = getDamageMitigationPenetration(source);
  if (!incomingDamage) return { amount: 0, amountBeforeResistance: 0, display: null, equipmentConditionDamage: [], resistanceOverheat: null, penetration: mitigationPenetration, penetrationSpent: 0, penetrationRemainder: mitigationPenetration };
  if (!damageTypeKey) return { amount: incomingDamage, amountBeforeResistance: incomingDamage, display: null, equipmentConditionDamage: [], resistanceOverheat: null, penetration: mitigationPenetration, penetrationSpent: 0, penetrationRemainder: mitigationPenetration };

  const includeEquipmentConditionDamage = shouldCalculateEquipmentConditionDamage(
    options.damageType,
    options.includeEquipmentConditionDamage
  );
  const itemMitigationTotalsProvided = options.itemMitigationTotals
    && typeof options.itemMitigationTotals === "object";
  const equipmentSourcesProvided = Array.isArray(options.equipmentSources);
  const equipmentSnapshot = (
    (options.itemOnlyMitigation && !itemMitigationTotalsProvided)
    || (includeEquipmentConditionDamage && !equipmentSourcesProvided)
  )
    ? buildDamageMitigationEquipmentSnapshot(actor, damageTypeKey, limbKey)
    : null;
  const equipmentSources = includeEquipmentConditionDamage
    ? equipmentSourcesProvided
      ? options.equipmentSources
      : equipmentSnapshot.sources
    : [];
  const itemWear = new Map();
  const defenseSources = equipmentSources.filter(entry => entry.mode === DAMAGE_MITIGATION_MODES.defense);
  const resistanceSources = equipmentSources.filter(entry => entry.mode === DAMAGE_MITIGATION_MODES.resistance);
  const defenseEquipmentMitigation = sumEquipmentMitigationSources(defenseSources);
  const resistanceEquipmentMitigation = sumEquipmentMitigationSources(resistanceSources);
  const itemMitigationTotals = itemMitigationTotalsProvided
    ? options.itemMitigationTotals
    : equipmentSnapshot?.totals;
  const percentageMitigation = options.damageMitigationCalculation === "percentage";
  const preparedDefense = options.itemOnlyMitigation
    ? Number(itemMitigationTotals?.[DAMAGE_MITIGATION_MODES.defense]) || 0
    : Number(actor.getDamageDefense?.(damageTypeKey, limbKey)) || 0;
  const preparedResistance = options.itemOnlyMitigation
    ? Number(itemMitigationTotals?.[DAMAGE_MITIGATION_MODES.resistance]) || 0
    : Number(actor.getDamageResistance?.(damageTypeKey, limbKey)) || 0;
  const mitigationContext = getDamageMitigationChanceContext(actor, source, options);
  let contextual = {};
  if (!options.itemOnlyMitigation) {
    const defenseChange = {
      key: `system.damageDefenseBonuses.${limbKey}.${damageTypeKey}`,
      alternateKeys: [
        "system.damageDefenseBonuses.all.all",
        `system.damageDefenseBonuses.all.${damageTypeKey}`,
        `system.damageDefenseBonuses.${limbKey}.all`
      ]
    };
    const resistanceChange = {
      key: `system.damageResistanceBonuses.${limbKey}.${damageTypeKey}`,
      alternateKeys: [
        "system.damageResistanceBonuses.all.all",
        `system.damageResistanceBonuses.all.${damageTypeKey}`,
        `system.damageResistanceBonuses.${limbKey}.all`
      ]
    };
    const changes = [
      { id: "defense", ...defenseChange, baseValue: preparedDefense },
      { id: "resistance", ...resistanceChange, baseValue: preparedResistance }
    ];
    if (defenseEquipmentMitigation > 0) changes.push({
      id: "defenseWithoutEquipment",
      ...defenseChange,
      baseValue: preparedDefense - defenseEquipmentMitigation
    });
    if (resistanceEquipmentMitigation > 0) changes.push({
      id: "resistanceWithoutEquipment",
      ...resistanceChange,
      baseValue: preparedResistance - resistanceEquipmentMitigation
    });
    contextual = getContextualAbilityChangeValues(actor, changes, mitigationContext);
  }
  const contextualDefense = Number(contextual.defense ?? preparedDefense) || 0;
  const rawDefense = applySourceMitigationIgnore(
    percentageMitigation ? contextualDefense : Math.max(0, contextualDefense),
    source?.targetDefenseIgnorePercent
  );
  const contextualDefenseWithoutEquipment = Number(
    contextual.defenseWithoutEquipment ?? preparedDefense - defenseEquipmentMitigation
  ) || 0;
  const rawDefenseWithoutEquipment = applySourceMitigationIgnore(
    percentageMitigation ? contextualDefenseWithoutEquipment : Math.max(0, contextualDefenseWithoutEquipment),
    source?.targetDefenseIgnorePercent
  );
  const defensePenetration = Math.min(Math.max(0, rawDefense), mitigationPenetration);
  const defense = rawDefense - defensePenetration;
  let remaining = incomingDamage;
  const defenseBlocked = calculateDamageMitigationReduction(remaining, defense, percentageMitigation);
  const defenseEquipmentContribution = calculateEquipmentMitigationContribution({
    amount: remaining,
    rawMitigation: rawDefense,
    rawMitigationWithoutEquipment: rawDefenseWithoutEquipment,
    penetration: mitigationPenetration,
    percentageMitigation
  });
  addEquipmentProtectionWear(itemWear, defenseSources, {
    incoming: incomingDamage,
    protectedAmount: defenseEquipmentContribution.protected,
    blocked: defenseEquipmentContribution.blocked
  });
  remaining = Math.max(0, remaining - defenseBlocked);
  const amountBeforeResistance = remaining;
  const contextualResistance = Number(contextual.resistance ?? preparedResistance) || 0;
  const rawResistance = applySourceMitigationIgnore(
    percentageMitigation ? contextualResistance : Math.max(0, contextualResistance),
    source?.targetResistanceIgnorePercent
  );
  const contextualResistanceWithoutEquipment = Number(
    contextual.resistanceWithoutEquipment ?? preparedResistance - resistanceEquipmentMitigation
  ) || 0;
  const rawResistanceWithoutEquipment = applySourceMitigationIgnore(
    percentageMitigation ? contextualResistanceWithoutEquipment : Math.max(0, contextualResistanceWithoutEquipment),
    source?.targetResistanceIgnorePercent
  );
  const resistancePenetration = Math.max(0, mitigationPenetration - defensePenetration);
  const resistancePenetrationSpent = Math.min(Math.max(0, rawResistance), resistancePenetration);
  const resistance = rawResistance - resistancePenetrationSpent;
  const spentPenetration = defensePenetration + resistancePenetrationSpent;
  const resistanceBlocked = calculateDamageMitigationReduction(remaining, resistance, percentageMitigation);
  const resistanceEquipmentContribution = calculateEquipmentMitigationContribution({
    amount: remaining,
    rawMitigation: rawResistance,
    rawMitigationWithoutEquipment: rawResistanceWithoutEquipment,
    penetration: resistancePenetration,
    percentageMitigation
  });
  addEquipmentProtectionWear(itemWear, resistanceSources, {
    incoming: remaining,
    protectedAmount: resistanceEquipmentContribution.protected,
    blocked: resistanceEquipmentContribution.blocked
  });
  remaining = Math.max(0, remaining - resistanceBlocked);
  const finalAmount = remaining;
  const overheatAmount = options.includeResistanceOverheat
    ? roundHalfUp(resistanceBlocked * RESISTANCE_OVERHEAT_RATIO)
    : 0;
  return {
    amount: finalAmount,
    amountBeforeResistance,
    display: null,
    penetration: mitigationPenetration,
    penetrationSpent: spentPenetration,
    penetrationRemainder: Math.max(0, mitigationPenetration - spentPenetration),
    resistanceOverheat: overheatAmount > 0 ? {
      damageTypeKey,
      amount: overheatAmount,
      blocked: resistanceBlocked
    } : null,
    equipmentConditionDamage: includeEquipmentConditionDamage
      ? calculateEquipmentConditionDamage(actor, itemWear, {
        damageType: options.damageType,
        damageTypeKey,
        incoming: incomingDamage,
        final: finalAmount,
        penetration: mitigationPenetration,
        state: options.equipmentConditionDamageState,
        packetId: getConditionWearPacketId(source)
      })
      : []
  };
}

function getDamageMitigationChanceContext(actor, source = {}, options = {}) {
  const attackerActorUuid = String(
    source?.attackerActorUuid
    ?? source?.attackerUuid
    ?? source?.sourceActorUuid
    ?? ""
  ).trim();
  const attackerTokenUuid = String(
    source?.attackerTokenUuid
    ?? source?.sourceTokenUuid
    ?? ""
  ).trim();
  const attackerActor = attackerActorUuid ? fromUuidSync(attackerActorUuid) : null;
  const attackerToken = attackerTokenUuid ? fromUuidSync(attackerTokenUuid) : null;
  return {
    actorToken: actor?.token?.object ?? actor?.token ?? null,
    targetActor: attackerActor,
    targetToken: attackerToken?.object ?? attackerToken,
    weaponActionKey: String(source?.actionKey ?? "").trim(),
    weaponData: source?.weaponData && typeof source.weaponData === "object"
      ? source.weaponData
      : null,
    attackDistanceMeters: source?.attackDistanceMeters ?? null,
    effectiveRange: source?.effectiveRange ?? null,
    chanceOperationId: getActiveUseOperationId(source, getCurrentDamageHubOperationRef()),
    contextualAbilitySnapshots: options.contextualAbilitySnapshots ?? null
  };
}

function calculatePercentageDamageReduction(amount, percentage) {
  const normalizedPercentage = Math.min(100, Number(percentage) || 0);
  const magnitude = Math.floor(amount * Math.abs(normalizedPercentage) / 100);
  return normalizedPercentage < 0 ? -magnitude : magnitude;
}

function applySourceMitigationIgnore(value = 0, percent = 0) {
  const mitigation = Number(value) || 0;
  if (mitigation <= 0) return mitigation;
  const ignoredPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return mitigation * (100 - ignoredPercent) / 100;
}

function calculateDamageMitigationReduction(amount, mitigation, percentageMitigation = false) {
  return percentageMitigation
    ? calculatePercentageDamageReduction(amount, mitigation)
    : Math.min(amount, Math.max(0, mitigation));
}

function sumEquipmentMitigationSources(sources = []) {
  return sources.reduce((sum, source) => sum + Math.max(0, toInteger(source.mitigation)), 0);
}

function calculateEquipmentMitigationContribution({
  amount = 0,
  rawMitigation = 0,
  rawMitigationWithoutEquipment = 0,
  penetration = 0,
  percentageMitigation = false
} = {}) {
  const protectedBeforePenetration = Math.max(0,
    calculateDamageMitigationReduction(amount, rawMitigation, percentageMitigation)
    - calculateDamageMitigationReduction(amount, rawMitigationWithoutEquipment, percentageMitigation)
  );
  const effectiveMitigation = rawMitigation - Math.min(Math.max(0, rawMitigation), penetration);
  const effectiveWithoutEquipment = rawMitigationWithoutEquipment
    - Math.min(Math.max(0, rawMitigationWithoutEquipment), penetration);
  const blocked = Math.max(0,
    calculateDamageMitigationReduction(amount, effectiveMitigation, percentageMitigation)
    - calculateDamageMitigationReduction(amount, effectiveWithoutEquipment, percentageMitigation)
  );
  return { protected: Math.max(protectedBeforePenetration, blocked), blocked };
}

function addEquipmentProtectionWear(itemWear, sources = [], { incoming = 0, protectedAmount = 0, blocked = 0 } = {}) {
  const layerIncoming = Math.max(0, Math.floor(Number(incoming) || 0));
  if (!layerIncoming || !sources.length) return;

  const totalMitigation = sources.reduce((sum, source) => sum + Math.max(0, toInteger(source.mitigation)), 0);
  if (totalMitigation <= 0) return;

  const protectedTotal = Math.min(layerIncoming, Math.max(0, Math.floor(Number(protectedAmount) || 0)));
  if (!protectedTotal) return;

  const blockedTotal = Math.min(protectedTotal, Math.max(0, Math.floor(Number(blocked) || 0)));
  const protectedAllocations = allocateIntegerByWeight(protectedTotal, sources, source => source.mitigation);
  const blockedAllocations = allocateIntegerByWeight(blockedTotal, sources, source => source.mitigation);

  for (const source of sources) {
    const protectedAmount = protectedAllocations.get(source.itemId) ?? 0;
    const blockedAmount = blockedAllocations.get(source.itemId) ?? 0;
    const wear = getOrCreateEquipmentWear(itemWear, source);
    wear.protected += protectedAmount;
    wear.blocked += blockedAmount;
    wear.penetrated += Math.max(0, protectedAmount - blockedAmount);
    wear.mitigation += Math.max(0, toInteger(source.mitigation));
  }
}

function getOrCreateEquipmentWear(itemWear, source) {
  let entry = itemWear.get(source.itemId);
  if (!entry) {
    entry = {
      item: source.item,
      itemId: source.itemId,
      protected: 0,
      blocked: 0,
      penetrated: 0,
      mitigation: 0
    };
    itemWear.set(source.itemId, entry);
  }
  return entry;
}

function allocateIntegerByWeight(total, sources = [], getWeight) {
  const amount = Math.max(0, Math.floor(Number(total) || 0));
  const entries = sources
    .map(source => ({
      source,
      weight: Math.max(0, Number(getWeight(source)) || 0),
      amount: 0,
      exact: 0
    }))
    .filter(entry => entry.weight > 0);
  const allocations = new Map();
  if (!amount || !entries.length) return allocations;

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let allocated = 0;
  for (const entry of entries) {
    entry.exact = (amount * entry.weight) / totalWeight;
    entry.amount = Math.floor(entry.exact);
    allocated += entry.amount;
  }

  let remainder = amount - allocated;
  entries.sort((left, right) => (right.exact - Math.floor(right.exact)) - (left.exact - Math.floor(left.exact)));
  for (const entry of entries) {
    if (remainder <= 0) break;
    entry.amount += 1;
    remainder -= 1;
  }

  for (const entry of entries) {
    if (entry.amount > 0) allocations.set(entry.source.itemId, entry.amount);
  }
  return allocations;
}

function buildDamageMitigationDisplay(incomingDamage, finalAmount) {
  const incoming = Math.max(0, Math.floor(Number(incomingDamage) || 0));
  if (!incoming) return null;
  const final = Math.max(0, Math.floor(Number(finalAmount) || 0));
  const blocked = Math.max(0, incoming - final);
  if (!blocked) return null;
  const ratio = blocked / incoming;
  return {
    incoming,
    blocked,
    percent: ratio >= 1 ? 100 : Math.min(99, Math.max(1, Math.floor(ratio * 100))),
    tier: ratio >= 1 ? 2 : 1
  };
}

function normalizeDamageMitigationDisplay(display = null) {
  const incoming = Math.max(0, Math.floor(Number(display?.incoming) || 0));
  const blocked = Math.max(0, Math.floor(Number(display?.blocked) || 0));
  if (!incoming || !blocked) return null;
  const ratio = blocked / incoming;
  return {
    incoming,
    blocked,
    percent: ratio >= 1 ? 100 : Math.min(99, Math.max(1, Math.floor(ratio * 100))),
    tier: ratio >= 1 || display?.tier === 2 ? 2 : 1
  };
}

function combineDamageMitigationDisplays(displays = []) {
  const totals = displays.reduce((result, display) => {
    const normalized = normalizeDamageMitigationDisplay(display);
    if (!normalized) return result;
    result.incoming += normalized.incoming;
    result.blocked += normalized.blocked;
    return result;
  }, { incoming: 0, blocked: 0 });
  return normalizeDamageMitigationDisplay(totals);
}

function getDamageMitigationPenetration(source = {}) {
  const penetrationPower = Math.max(0, toInteger(source?.penetrationPower));
  const penetrationStep = Math.max(0, toInteger(source?.penetrationStep));
  return Math.max(0, penetrationPower - penetrationStep) * DAMAGE_MITIGATION_PENETRATION_FLAT_STEP;
}

async function applyResistanceOverheats(actor, entries = []) {
  const totals = new Map();
  for (const entry of entries ?? []) {
    const damageTypeKey = String(entry?.damageTypeKey ?? "").trim();
    const amount = Math.max(0, toInteger(entry?.amount));
    if (!damageTypeKey || !amount) continue;
    totals.set(damageTypeKey, (totals.get(damageTypeKey) ?? 0) + amount);
  }
  return applyResistanceOverheat(actor, totals);
}

async function applyResistanceOverheat(actor, increments = new Map()) {
  if (!actor || !(increments instanceof Map) || !increments.size) return [];
  const existing = Array.from(actor.effects ?? [])
    .filter(effect => !effect.disabled && isResistanceOverheatEffect(effect));
  const totals = getResistanceOverheatEffectTotals(existing);
  for (const [damageTypeKey, amount] of increments) {
    const key = String(damageTypeKey ?? "").trim();
    const value = Math.max(0, toInteger(amount));
    if (!key || !value) continue;
    totals.set(key, (totals.get(key) ?? 0) + value);
  }
  const cleanTotals = new Map(Array.from(totals)
    .map(([damageTypeKey, amount]) => [String(damageTypeKey ?? "").trim(), Math.max(0, toInteger(amount))])
    .filter(([damageTypeKey, amount]) => damageTypeKey && amount));
  if (!cleanTotals.size) return [];

  const startTime = Number(game.time?.worldTime) || 0;
  const flagData = {
    kind: RESISTANCE_OVERHEAT_EFFECT_KIND,
    resistances: Object.fromEntries(cleanTotals)
  };
  const changes = buildResistanceOverheatChanges(actor, cleanTotals);

  if (existing[0]) {
    const updates = [{
      _id: existing[0].id,
      name: RESISTANCE_OVERHEAT_EFFECT_NAME,
      img: RESISTANCE_OVERHEAT_EFFECT_IMG,
      disabled: false,
      showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
      "duration.seconds": RESISTANCE_OVERHEAT_DURATION_SECONDS,
      "duration.startTime": startTime,
      "system.changes": changes,
      [`flags.${TRAUMA_FLAG_SCOPE}.kind`]: "temporary",
      [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}`]: flagData
    }];
    const obsolete = existing.slice(1).map(effect => effect.id);
    if (obsolete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete, { animate: false });
    return actor.updateEmbeddedDocuments("ActiveEffect", updates, { animate: false });
  }

  return actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: RESISTANCE_OVERHEAT_EFFECT_NAME,
    img: RESISTANCE_OVERHEAT_EFFECT_IMG,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: RESISTANCE_OVERHEAT_DURATION_SECONDS,
      startTime
    },
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "temporary",
        [DAMAGE_EFFECT_FLAG_KEY]: flagData
      }
    },
    system: { changes }
  }], { animate: false });
}

function getResistanceOverheatEffectTotals(effects = []) {
  const totals = new Map();
  for (const effect of effects ?? []) {
    const data = effect?.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY)
      ?? effect?.flags?.[TRAUMA_FLAG_SCOPE]?.[DAMAGE_EFFECT_FLAG_KEY];
    if (data?.kind !== RESISTANCE_OVERHEAT_EFFECT_KIND) continue;
    for (const [damageTypeKey, amount] of Object.entries(data.resistances ?? {})) {
      const key = String(damageTypeKey ?? "").trim();
      const value = Math.max(0, toInteger(amount));
      if (!key || !value) continue;
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
    const legacyDamageTypeKey = String(data.damageTypeKey ?? "").trim();
    const legacyAmount = Math.max(0, toInteger(data.amount));
    if (legacyDamageTypeKey && legacyAmount) {
      totals.set(legacyDamageTypeKey, (totals.get(legacyDamageTypeKey) ?? 0) + legacyAmount);
    }
  }
  return totals;
}

function buildResistanceOverheatChanges(actor, totals = new Map()) {
  return Array.from(totals, ([damageTypeKey, amount]) => ({
    key: `system.damageResistanceBonuses.all.${damageTypeKey}`,
    type: "add",
    value: String(-Math.max(0, toInteger(amount))),
    phase: "initial",
    priority: 0
  }));
}

function isResistanceOverheatEffect(effect) {
  const data = effect?.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[TRAUMA_FLAG_SCOPE]?.[DAMAGE_EFFECT_FLAG_KEY];
  return data?.kind === RESISTANCE_OVERHEAT_EFFECT_KIND;
}

function calculateEquipmentConditionDamage(actor, itemWear = new Map(), { damageType = null, damageTypeKey = "", incoming = 0, final = 0, penetration = 0, state = null, packetId = "" } = {}) {
  const settings = damageType?.settings?.equipmentConditionDamage;
  if (!settings?.enabled || !itemWear.size) return [];

  const formula = String(settings.formula ?? "").trim();
  if (!formula) return [];

  const results = [];
  for (const wear of itemWear.values()) {
    const condition = getEquipmentConditionValue(wear.item, state);
    const conditionMax = getEquipmentConditionMax(wear.item, state);
    if (condition <= 0) continue;

    let amount = 0;
    try {
      const variables = Object.fromEntries(EQUIPMENT_CONDITION_DAMAGE_VARIABLES.map(key => [key, 0]));
      Object.assign(variables, {
        incoming,
        final,
        blocked: wear.blocked,
        protected: wear.protected,
        penetrated: wear.penetrated,
        condition,
        conditionMax,
        mitigation: wear.mitigation,
        penetration
      });
      amount = Math.max(0, evaluateFormulaVariables(formula, variables));
    } catch (error) {
      console.warn(`${SYSTEM_ID} | Equipment condition damage formula error (${damageTypeKey}): ${error.message}`);
      continue;
    }

    const applied = state
      ? reserveEquipmentConditionDamagePacket(wear.item, amount, packetId, state)
      : reserveEquipmentConditionDamage(
        wear.item,
        amount - getDamageMitigationWearResistance(wear.item)
      );
    if (applied > 0) results.push({ itemId: wear.itemId, amount: applied });
  }
  return results;
}

function createEquipmentConditionDamageState(actor) {
  return {
    actor,
    entries: new Map(),
    totals: new Map(),
    packets: new Map(),
    nextPacketIndex: 0
  };
}

function reserveEquipmentConditionDamagePacket(item, amount, packetId = "", state = null) {
  if (!state) return 0;
  const id = String(packetId ?? "").trim() || `request:${state.nextPacketIndex++}`;
  const key = `${item.id}:${id}`;
  const packet = state.packets.get(key) ?? { raw: 0, applied: 0 };
  packet.raw += Math.max(0, Number(amount) || 0);
  const requested = Math.max(
    0,
    Math.floor(packet.raw - getDamageMitigationWearResistance(item)) - packet.applied
  );
  const applied = reserveEquipmentConditionDamage(item, requested, state);
  packet.applied += applied;
  state.packets.set(key, packet);
  return applied;
}

function getEquipmentConditionDamageStateEntries(state = null) {
  if (!state?.totals?.size) return [];
  return Array.from(state.totals.entries())
    .map(([itemId, amount]) => ({ itemId, amount }))
    .filter(entry => entry.amount > 0);
}

function getEquipmentConditionStateEntry(item, state = null) {
  if (!state || !item?.id) return null;
  let entry = state.entries.get(item.id);
  if (!entry) {
    const condition = getConditionFunction(item);
    entry = {
      current: Math.max(0, toInteger(condition.value)),
      max: Math.max(0, toInteger(condition.max))
    };
    state.entries.set(item.id, entry);
  }
  return entry;
}

function getEquipmentConditionValue(item, state = null) {
  const stateEntry = getEquipmentConditionStateEntry(item, state);
  if (stateEntry) return stateEntry.current;
  return Math.max(0, toInteger(getConditionFunction(item).value));
}

function getEquipmentConditionMax(item, state = null) {
  const stateEntry = getEquipmentConditionStateEntry(item, state);
  if (stateEntry) return stateEntry.max;
  return Math.max(0, toInteger(getConditionFunction(item).max));
}

function reserveEquipmentConditionDamage(item, amount, state = null) {
  const requested = Math.max(0, Math.floor(Number(amount) || 0));
  if (!requested || !item?.id) return 0;

  const stateEntry = getEquipmentConditionStateEntry(item, state);
  if (stateEntry) {
    const applied = Math.min(requested, Math.max(0, stateEntry.current));
    if (!applied) return 0;
    stateEntry.current = Math.max(0, stateEntry.current - applied);
    state.totals.set(item.id, (state.totals.get(item.id) ?? 0) + applied);
    return applied;
  }

  return Math.min(requested, Math.max(0, toInteger(getConditionFunction(item).value)));
}

export async function applyEquipmentConditionDamage(actor, entries = []) {
  const totals = new Map();
  for (const entry of entries ?? []) {
    const itemId = String(entry?.itemId ?? "");
    const amount = Math.max(0, Math.floor(Number(entry?.amount) || 0));
    if (!itemId || !amount) continue;
    totals.set(itemId, (totals.get(itemId) ?? 0) + amount);
  }
  if (!totals.size) return;

  const updates = [];
  const brokenProstheses = [];
  let prosthesisHealthChanged = false;
  for (const [itemId, amount] of totals) {
    const item = actor.items?.get?.(itemId);
    if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) continue;
    const current = Math.max(0, toInteger(getConditionFunction(item).value));
    const next = Math.max(0, current - amount);
    if (next === current) continue;
    if (next <= 0 && isInstalledProsthesisItem(item)) {
      brokenProstheses.push(item);
      continue;
    }
    if (isInstalledProsthesisItem(item)) prosthesisHealthChanged = true;
    updates.push({
      _id: item.id,
      "system.functions.condition.value": next
    });
  }

  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (prosthesisHealthChanged) await queueActorDamageStatusSync(actor);
  for (const item of brokenProstheses) {
    const prosthesis = actor.items?.get?.(item.id) ?? item;
    const shockCheck = createProsthesisBreakShockCheck(actor, prosthesis);
    await breakInstalledProsthesis(actor, prosthesis);
    if (shockCheck) await performNegativeLimbShockCheck(actor, shockCheck);
  }
}

async function applyManualProsthesisHealthAdjustments(actor, entries = []) {
  let healthDelta = 0;
  for (const entry of entries ?? []) {
    const item = actor?.items?.get?.(String(entry?.itemId ?? ""));
    if (!item) continue;
    const result = entry?.mode === MODE_HEALING
      ? await applyProsthesisIntegratedHealthHealing(actor, item, entry.amount)
      : await applyProsthesisIntegratedHealthDamage(actor, item, entry.amount);
    healthDelta += Math.max(0, roundDamageAmount(result?.healthDelta));
  }
  return roundDamageAmount(healthDelta);
}

async function applyProsthesisIntegratedHealthDamage(actor, prosthesis, healthAmount = 0) {
  const estimate = estimateProsthesisIntegratedHealthDamage(prosthesis, healthAmount);
  if (estimate.conditionDamage <= 0) {
    return { item: prosthesis, conditionDelta: 0, healthDelta: 0, broken: false, shockCheck: null };
  }
  const result = await applyProsthesisConditionDamage(actor, prosthesis, estimate.conditionDamage);
  return {
    ...result,
    shockCheck: result?.broken ? createProsthesisBreakShockCheck(actor, prosthesis) : null
  };
}

function estimateProsthesisIntegratedHealthDamage(prosthesis, healthAmount = 0) {
  const integration = getProsthesisIntegrationPercent(prosthesis);
  const requestedHealth = roundDamageAmount(healthAmount);
  if (!prosthesis || integration <= 0 || requestedHealth <= 0 || !hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    return { conditionDamage: 0, conditionDelta: 0, healthDelta: 0, broken: false };
  }
  const conditionDamage = Math.max(1, Math.ceil((requestedHealth * 100) / integration));
  const result = estimateProsthesisConditionDamage(prosthesis, conditionDamage);
  return {
    conditionDamage,
    conditionDelta: result.conditionDelta,
    healthDelta: result.healthDelta,
    broken: result.next <= 0
  };
}

async function applyProsthesisIntegratedHealthHealing(actor, prosthesis, healthAmount = 0) {
  const estimate = estimateProsthesisIntegratedHealthHealing(prosthesis, healthAmount);
  if (estimate.conditionHealing <= 0) {
    return { item: prosthesis, conditionDelta: 0, healthDelta: 0 };
  }
  return applyProsthesisConditionHealing(actor, prosthesis, estimate.conditionHealing);
}

function estimateProsthesisIntegratedHealthHealing(prosthesis, healthAmount = 0) {
  const integration = getProsthesisIntegrationPercent(prosthesis);
  const requestedHealth = roundDamageAmount(healthAmount);
  if (!prosthesis || integration <= 0 || requestedHealth <= 0 || !hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    return { conditionHealing: 0, conditionDelta: 0, healthDelta: 0 };
  }
  const conditionHealing = Math.max(1, Math.ceil((requestedHealth * 100) / integration));
  const result = estimateProsthesisConditionHealing(prosthesis, conditionHealing);
  return {
    conditionHealing,
    conditionDelta: result.conditionDelta,
    healthDelta: result.healthDelta
  };
}

async function applyProsthesisConditionDamage(actor, prosthesis, amount = 0) {
  if (!actor || !prosthesis || !hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    return { item: prosthesis, conditionDelta: 0, healthDelta: 0, broken: false };
  }
  const damage = roundDamageAmount(amount);
  if (damage <= 0) return { item: prosthesis, conditionDelta: 0, healthDelta: 0, broken: false };

  const result = estimateProsthesisConditionDamage(prosthesis, damage);
  if (result.next === result.current) {
    return { item: prosthesis, conditionDelta: 0, healthDelta: 0, broken: false };
  }

  if (result.next > 0) {
    await actor.updateEmbeddedDocuments("Item", [{
      _id: prosthesis.id,
      "system.functions.condition.value": result.next
    }]);
    await queueActorDamageStatusSync(actor);
    return {
      item: actor.items?.get(prosthesis.id) ?? prosthesis,
      conditionDelta: result.conditionDelta,
      healthDelta: result.healthDelta,
      broken: false
    };
  }

  const item = await breakInstalledProsthesis(actor, prosthesis);
  return {
    item,
    conditionDelta: result.conditionDelta,
    healthDelta: result.healthDelta,
    broken: true
  };
}

function estimateProsthesisConditionDamage(prosthesis, amount = 0) {
  if (!prosthesis || !hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    return { current: 0, next: 0, conditionDelta: 0, healthDelta: 0 };
  }

  const condition = getConditionFunction(prosthesis);
  const max = Math.max(0, toInteger(condition.max));
  const current = Math.min(Math.max(0, toInteger(condition.value)), max);
  const next = Math.max(0, current - roundDamageAmount(amount));
  const integration = getProsthesisIntegrationPercent(prosthesis);
  return {
    current,
    next,
    conditionDelta: Math.max(0, current - next),
    healthDelta: calculateIntegratedProsthesisHealthLoss(current, next, integration)
  };
}

async function applyProsthesisConditionHealing(actor, prosthesis, amount = 0) {
  if (!actor || !prosthesis || !hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    return { item: prosthesis, conditionDelta: 0, healthDelta: 0 };
  }
  const healing = roundDamageAmount(amount);
  if (healing <= 0) return { item: prosthesis, conditionDelta: 0, healthDelta: 0 };

  const result = estimateProsthesisConditionHealing(prosthesis, healing);
  if (result.next === result.current) {
    return { item: prosthesis, conditionDelta: 0, healthDelta: 0 };
  }

  await actor.updateEmbeddedDocuments("Item", [{
    _id: prosthesis.id,
    "system.functions.condition.value": result.next
  }], { falloutMawSkipConsciousnessRecovery: true });
  await queueActorDamageStatusSync(actor);
  return {
    item: actor.items?.get(prosthesis.id) ?? prosthesis,
    conditionDelta: result.conditionDelta,
    healthDelta: result.healthDelta
  };
}

function estimateProsthesisConditionHealing(prosthesis, amount = 0) {
  if (!prosthesis || !hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    return { current: 0, next: 0, conditionDelta: 0, healthDelta: 0 };
  }

  const condition = getConditionFunction(prosthesis);
  const max = Math.max(0, toInteger(condition.max));
  const current = Math.min(Math.max(0, toInteger(condition.value)), max);
  const next = Math.min(max, current + roundDamageAmount(amount));
  const integration = getProsthesisIntegrationPercent(prosthesis);
  return {
    current,
    next,
    conditionDelta: Math.max(0, next - current),
    healthDelta: Math.max(
      0,
      toIntegratedProsthesisHealthValue(next, integration) - toIntegratedProsthesisHealthValue(current, integration)
    )
  };
}

function createProsthesisBreakShockCheck(actor, prosthesis, limbKey = "") {
  const key = String(limbKey || prosthesis?.system?.placement?.limbKey || "").trim();
  if (!key) return null;
  const data = getProsthesisFunction(prosthesis);
  if (getProsthesisIntegrationPercent(prosthesis) <= 0 || data.breakShockResistant) return null;
  return buildDestroyedLimbShockChecks(actor, [key]).at(0) ?? null;
}

async function breakInstalledProsthesis(actor, prosthesis) {
  if (!actor || !prosthesis) return undefined;
  const limbKey = String(prosthesis.system?.placement?.limbKey ?? "");
  await returnBrokenProsthesisToInventory(actor, prosthesis);
  if (limbKey) {
    if (!isLimbPhysicallyMissing(actor, limbKey)) await setLimbMissingState(actor, limbKey);
    await applyDestroyedLimbConsequences(actor, [limbKey], { ignoreInstalledProsthesis: true });
    await queueActorDamageStatusSync(actor);
  }
  return actor.items?.get(prosthesis.id) ?? prosthesis;
}

function isInstalledProsthesisItem(item) {
  return Boolean(
    item?.type === "gear"
    && item.system?.equipped
    && hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
    && String(item.system?.placement?.mode ?? "") === "prosthesis"
    && String(item.system?.placement?.limbKey ?? "").trim()
  );
}

async function returnBrokenProsthesisToInventory(actor, prosthesis) {
  const planned = createBrokenProsthesisInventoryPlacement(actor, prosthesis);
  const placement = planned?.placement ?? createBrokenProsthesisLockedStoragePlacement(actor, prosthesis);
  const update = {
    _id: prosthesis.id,
    "system.equipped": false,
    "system.container.parentId": ROOT_CONTAINER_ID,
    "system.placement.mode": placement.mode,
    "system.placement.equipmentSlot": placement.equipmentSlot,
    "system.placement.weaponSet": placement.weaponSet,
    "system.placement.weaponSlot": placement.weaponSlot,
    "system.placement.limbKey": placement.limbKey,
    "system.placement.constructPartOrder": placement.constructPartOrder,
    "system.placement.x": placement.x,
    "system.placement.y": placement.y,
    "system.placement.width": placement.width,
    "system.placement.height": placement.height,
    "system.placement.rotated": Boolean(placement.rotated),
    "system.functions.condition.value": 0
  };
  if (planned?.stackParts) update["system.stackParts"] = planned.stackParts;
  return executeInventoryMutation({
    actor,
    updates: [update]
  }, { reason: "return-broken-prosthesis" });
}

function createBrokenProsthesisInventoryPlacement(actor, prosthesis) {
  try {
    const planningData = foundry.utils.deepClone(prosthesis.toObject());
    // The document already belongs to this Actor. The grant planner is used
    // only for its canonical packing rules, so its synthetic copy must not
    // count the same weight for a second time.
    foundry.utils.setProperty(planningData, "system.weight", 0);
    const plan = planActorInventoryGrant(actor, planningData, {
      quantity: Math.max(1, toInteger(prosthesis.system?.quantity) || 1),
      parentId: ROOT_CONTAINER_ID,
      merge: false
    });
    if (plan?.creates?.length !== 1) return null;
    const createData = plan.creates[0];
    return {
      placement: createStoredPlacement(createData.system?.placement, prosthesis),
      stackParts: foundry.utils.deepClone(createData.system?.stackParts ?? [])
    };
  } catch (_error) {
    return null;
  }
}

function createBrokenProsthesisLockedStoragePlacement(actor, prosthesis) {
  const raceId = String(actor?.system?.creature?.raceId ?? "");
  const race = getPreparedRuntimeSettings().creatureOptions.races.find(entry => String(entry.id) === raceId) ?? null;
  const dimensions = getActorInventoryGridDimensions(actor, race);
  const footprint = getItemFootprint(prosthesis, actor.items);
  const columns = Math.max(1, dimensions.columns, footprint.width);
  const contextItems = getContextInventoryItems(LOCKED_STORAGE_PARENT_ID, actor.items);
  const options = {
    allowOverflowRows: true,
    placementMode: LOCKED_STORAGE_PLACEMENT_MODE,
    preferredPlacementModes: [LOCKED_STORAGE_PLACEMENT_MODE]
  };
  const placement = findFirstAvailableResolvedInventoryPlacement(
    contextItems,
    columns,
    1,
    prosthesis,
    actor.items,
    [prosthesis.id],
    [],
    options
  ) ?? {
    mode: LOCKED_STORAGE_PLACEMENT_MODE,
    x: 1,
    y: contextItems.reduce((bottom, item) => {
      const stored = item.system?.placement ?? {};
      return Math.max(
        bottom,
        Math.max(1, toInteger(stored.y)) + getItemFootprint(item, actor.items).height
      );
    }, 1),
    rotated: Boolean(prosthesis.system?.placement?.rotated)
  };
  return createStoredPlacement({
    ...placement,
    mode: LOCKED_STORAGE_PLACEMENT_MODE,
    equipmentSlot: "",
    weaponSet: "",
    weaponSlot: "",
    limbKey: "",
    constructPartOrder: 0
  }, prosthesis);
}

function applyLimbDamageMultiplier(actor, amount, limbKey = "") {
  const incomingDamage = Math.max(0, Number(amount) || 0);
  if (!incomingDamage || !limbKey) {
    return roundDamageAmount(incomingDamage);
  }
  const multiplier = Math.max(0, toOptionalFiniteNumber(actor.system?.limbs?.[limbKey]?.damageMultiplier) ?? 1);
  return roundDamageAmount(incomingDamage * multiplier);
}

function calculateLimbStateDamage(amount = 0) {
  return roundDamageAmount(amount);
}

function roundDamageAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function roundHalfUp(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number + 0.5)) : 0;
}

function buildAccumulationUpdate(actor, limbKey, damageTypeKey, amount, mode) {
  const limb = actor.system?.limbs?.[limbKey];
  const current = { ...(limb?.damageAccumulation ?? {}) };
  const update = {};
  if (!amount) return update;

  if (mode === MODE_DAMAGE) {
    const key = damageTypeKey || "untyped";
    current[key] = Math.max(0, Number(current[key]) || 0) + amount;
  } else {
    diluteDamageAccumulation(current, amount);
  }

  const normalized = Object.fromEntries(
    Object.entries(current)
      .map(([key, value]) => [key, Math.max(0, Number(value) || 0)])
      .filter(([_key, value]) => value > 0.0001)
  );

  update[`system.limbs.${limbKey}.damageAccumulation`] = replaceDamageAccumulation(normalized);
  return update;
}

function diluteDamageAccumulation(accumulation, healingAmount) {
  const total = Object.values(accumulation).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (total <= 0) return;
  const reduction = Math.min(total, Math.max(0, Number(healingAmount) || 0));
  for (const [key, value] of Object.entries(accumulation)) {
    const share = Math.max(0, Number(value) || 0) / total;
    accumulation[key] = Math.max(0, value - (reduction * share));
  }
}

async function createTriggeredTraumas(actor, { limbKey, damageTypeKey, previousValue, nextValue, latestDamage, damageSnapshot = null } = {}) {
  return commitTriggeredTraumaPlans(actor, [
    prepareTriggeredTraumaPlan(actor, {
      limbKey,
      damageTypeKey,
      previousValue,
      nextValue,
      latestDamage,
      damageSnapshot
    })
  ]);
}

function prepareTriggeredTraumaPlan(actor, { limbKey, damageTypeKey, previousValue, nextValue, latestDamage, damageSnapshot = null } = {}) {
  const limb = actor.system?.limbs?.[limbKey];
  const empty = { createData: [], deleteIds: [] };
  if (!limb || toInteger(limb.max) <= 0) return empty;

  const {
    creatureOptions,
    damageTypeSettings: damageTypes,
    traumaSettings
  } = getPreparedRuntimeSettings();
  const traumaGroup = getTraumaGroupForActor(actor, traumaSettings, creatureOptions, damageTypes);
  const stages = traumaGroup.config?.limbs?.[limbKey]?.stages ?? [];
  if (!stages.length) return empty;

  const max = toInteger(limb.max);
  const previousPercent = (previousValue / max) * 100;
  const nextPercent = (nextValue / max) * 100;
  const existingLimbTraumas = getActorTraumas(actor)
    .filter(item => item.system?.limbKey === limbKey);
  const triggeredStages = stages.filter(stage => (
    previousPercent > Number(stage.thresholdPercent)
    && nextPercent <= Number(stage.thresholdPercent)
    && !existingLimbTraumas.some(item => hasTraumaStageEntry(item, stage, limbKey, damageTypes))
  )).sort((left, right) => Number(right.thresholdPercent) - Number(left.thresholdPercent));
  if (!triggeredStages.length) return empty;

  const snapshot = normalizeDamageAccumulation(damageSnapshot ?? actor.system?.limbs?.[limbKey]?.damageAccumulation ?? {});

  const progressionData = triggeredStages
    .map(stage => buildTraumaItemData(actor, {
      limb,
      limbKey,
      limbSetId: traumaGroup.id,
      stage,
      damageTypes,
      damageTypeKey,
      latestDamage,
      snapshot,
      nextValue
    }))
    .filter(Boolean);

  if (!progressionData.length) return empty;
  const finalTraumaData = mergeEscalatedTraumaData({
    finalTraumaData: progressionData.at(-1),
    previousTraumas: existingLimbTraumas,
    intermediateTraumaData: progressionData.slice(0, -1),
    damageTypes
  });

  return {
    createData: [finalTraumaData],
    deleteIds: existingLimbTraumas.map(item => item.id)
  };
}

async function commitTriggeredTraumaPlans(actor, plans = []) {
  const createData = plans.flatMap(plan => plan?.createData ?? []);
  const deleteIds = Array.from(new Set(plans.flatMap(plan => plan?.deleteIds ?? [])));
  if (!createData.length && !deleteIds.length) return [];

  const created = createData.length
    ? await actor.createEmbeddedDocuments("Item", createData, {
    [TRAUMA_CREATE_OPTION]: true,
    animate: false
  })
    : [];
  if (deleteIds.length) await actor.deleteEmbeddedDocuments("Item", deleteIds, { animate: false });
  return created;
}

function hasTraumaStageEntry(item, stage = {}, limbKey = "", damageTypes = []) {
  if (item.system?.stageId === stage.id) return true;
  const thresholdPercent = toInteger(stage.thresholdPercent);
  return getTraumaSourceEntries(item, damageTypes).some(source => (
    source.limbKey === limbKey
    && toInteger(source.thresholdPercent) === thresholdPercent
  ));
}

function buildTraumaItemData(actor, { limb, limbKey, limbSetId, stage, damageTypes, damageTypeKey, latestDamage, snapshot, nextValue }) {
  const profileEntry = selectTraumaProfile(stage, snapshot, damageTypeKey, latestDamage);
  if (!profileEntry) return null;

  const damageType = damageTypes.find(entry => entry.key === profileEntry.damageTypeKey);
  const thresholdPercent = toInteger(stage.thresholdPercent);
  const thresholdValue = Math.floor((toInteger(limb.max) * thresholdPercent) / 100);
  const limbLabel = String(limb.label ?? limbKey);
  const name = profileEntry.profile.name || `${limbLabel}: ${damageType?.label ?? profileEntry.damageTypeKey}`;
  const img = profileEntry.profile.img || "icons/svg/blood.svg";
  const effectEntries = mergeMatchingTraumaEffectChanges(
    (profileEntry.profile.effects ?? [])
      .map(prepareEffectChange)
      .filter(change => change.key)
  );
  const { changes: activeEffectChanges, statuses } = splitSpecialEffectChanges(effectEntries);

  return {
    type: "trauma",
    name,
    img,
    system: {
      description: "",
      limbSetId,
      limbKey,
      limbLabel,
      stageId: stage.id,
      damageTypeKey: profileEntry.damageTypeKey,
      damageTypeLabel: damageType?.label ?? profileEntry.damageTypeKey,
      thresholdPercent,
      thresholdValue,
      triggeredAtValue: nextValue,
      healingDifficulty: toInteger(profileEntry.profile.healingDifficulty ?? 60),
      healingToolClass: String(profileEntry.profile.healingToolClass ?? "D").trim().toUpperCase() || "D",
      healingProgress: 0,
      healingProgressMax: toInteger(profileEntry.profile.healingProgress ?? 100),
      healingSkillKey: String(profileEntry.profile.healingSkillKey ?? "doctor").trim() || "doctor",
      damageSnapshot: snapshot,
      sources: [{
        limbKey,
        limbLabel,
        damageTypeKey: profileEntry.damageTypeKey,
        damageTypeLabel: damageType?.label ?? profileEntry.damageTypeKey,
        thresholdPercent
      }],
      generated: true,
      effects: effectEntries
    },
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        generatedTrauma: true,
        [TRAUMA_FLAG_KEY]: {
          actorUuid: actor.uuid,
          limbKey,
          stageId: stage.id
        }
      }
    },
    effects: [{
      type: "base",
      name,
      img,
      transfer: true,
      disabled: false,
      showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
      statuses,
      system: {
        changes: activeEffectChanges
      },
      flags: {
        [TRAUMA_FLAG_SCOPE]: {
          kind: "active",
          traumaItem: true
        }
      }
    }]
  };
}

function prepareEffectChange(effect = {}) {
  const change = {
    key: String(effect.key ?? "").trim(),
    type: effect.type || "add",
    value: String(effect.value ?? "0"),
    phase: effect.phase || "initial"
  };
  const priority = Number(effect.priority);
  if (Number.isFinite(priority)) change.priority = Math.trunc(priority);
  return change;
}

function mergeEscalatedTraumaData({ finalTraumaData, previousTraumas = [], intermediateTraumaData = [], damageTypes = [] } = {}) {
  const effectChanges = mergeMatchingTraumaEffectChanges([
    ...previousTraumas.flatMap(item => item.system?.effects ?? []),
    ...intermediateTraumaData.flatMap(data => data.system?.effects ?? []),
    ...(finalTraumaData.system?.effects ?? [])
  ].map(prepareEffectChange).filter(change => change.key));
  const damageTypeEntries = [
    ...previousTraumas.flatMap(item => getTraumaDamageTypeEntries(item, damageTypes)),
    ...intermediateTraumaData.map(data => ({
      key: data.system?.damageTypeKey ?? "",
      label: data.system?.damageTypeLabel ?? ""
    })),
    {
      key: finalTraumaData.system?.damageTypeKey ?? "",
      label: finalTraumaData.system?.damageTypeLabel ?? ""
    }
  ];
  const sources = [
    ...previousTraumas.flatMap(item => getTraumaSourceEntries(item, damageTypes)),
    ...intermediateTraumaData.flatMap(data => data.system?.sources?.length ? data.system.sources : [getTraumaSourceEntryFromData(data, damageTypes)]),
    ...(finalTraumaData.system?.sources?.length ? finalTraumaData.system.sources : [getTraumaSourceEntryFromData(finalTraumaData, damageTypes)])
  ].filter(source => source.limbLabel || source.damageTypeLabel);
  const combinedDamageTypes = combineDamageTypeEntries(damageTypeEntries, damageTypes);

  foundry.utils.setProperty(finalTraumaData, "system.effects", effectChanges);
  foundry.utils.setProperty(finalTraumaData, "system.damageTypeLabel", combinedDamageTypes.label);
  foundry.utils.setProperty(finalTraumaData, "system.sources", sources);
  if (combinedDamageTypes.key) foundry.utils.setProperty(finalTraumaData, "system.damageTypeKey", combinedDamageTypes.key);

  const { changes: activeEffectChanges, statuses } = splitSpecialEffectChanges(effectChanges);
  for (const effect of finalTraumaData.effects ?? []) {
    foundry.utils.setProperty(effect, "system.changes", activeEffectChanges);
    foundry.utils.setProperty(effect, "statuses", statuses);
  }
  return finalTraumaData;
}

function getTraumaSourceEntries(item, damageTypes = []) {
  const sources = item.system?.sources;
  if (Array.isArray(sources) && sources.length) {
    return sources.map(source => normalizeTraumaSource(source, damageTypes));
  }
  return [normalizeTraumaSource({
    limbKey: item.system?.limbKey,
    limbLabel: item.system?.limbLabel,
    damageTypeKey: item.system?.damageTypeKey,
    damageTypeLabel: item.system?.damageTypeLabel,
    thresholdPercent: item.system?.thresholdPercent
  }, damageTypes)];
}

function getTraumaSourceEntryFromData(data, damageTypes = []) {
  return normalizeTraumaSource({
    limbKey: data.system?.limbKey,
    limbLabel: data.system?.limbLabel,
    damageTypeKey: data.system?.damageTypeKey,
    damageTypeLabel: data.system?.damageTypeLabel,
    thresholdPercent: data.system?.thresholdPercent
  }, damageTypes);
}

function normalizeTraumaSource(source = {}, damageTypes = []) {
  const damageTypeKey = String(source.damageTypeKey ?? "").trim();
  return {
    limbKey: String(source.limbKey ?? "").trim(),
    limbLabel: String(source.limbLabel ?? source.limbKey ?? "").trim(),
    damageTypeKey,
    damageTypeLabel: String(source.damageTypeLabel ?? "").trim() || damageTypes.find(type => type.key === damageTypeKey)?.label || damageTypeKey,
    thresholdPercent: Math.max(0, Math.min(100, toInteger(source.thresholdPercent)))
  };
}

function getTraumaDamageTypeEntries(item, damageTypes = []) {
  const keyParts = splitCombinedDamageTypeValue(item.system?.damageTypeKey);
  const labelParts = splitCombinedDamageTypeValue(item.system?.damageTypeLabel);
  const entries = [];
  const maxLength = Math.max(keyParts.length, labelParts.length, 1);

  for (let index = 0; index < maxLength; index += 1) {
    const key = keyParts[index] ?? "";
    const label = labelParts[index]
      ?? damageTypes.find(type => type.key === key)?.label
      ?? key;
    if (key || label) entries.push({ key, label });
  }
  return entries;
}

function splitCombinedDamageTypeValue(value) {
  return String(value ?? "")
    .split(/\s*(?:\/|\+|,)\s*|\s+\u0438\s+/iu)
    .map(part => part.trim())
    .filter(Boolean);
}

function combineDamageTypeEntries(entries = [], damageTypes = []) {
  const combined = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = String(entry.key ?? "").trim();
    const label = String(entry.label ?? "").trim() || damageTypes.find(type => type.key === key)?.label || key;
    const uniqueKey = key || label.toLocaleLowerCase();
    if (!uniqueKey || seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    combined.push({ key, label });
  }

  return {
    key: combined.map(entry => entry.key).filter(Boolean).join("/"),
    label: combined.map(entry => entry.label).filter(Boolean).join(" / ")
  };
}

function selectTraumaProfile(stage, snapshot = {}, latestDamageTypeKey = "", latestDamage = 0) {
  const latestDamageWeight = Math.max(0, Number(latestDamage) || 0) * 2;
  const weighted = Object.entries(snapshot ?? {})
    .map(([key, value]) => [
      key,
      Math.max(0, Number(value) || 0) + (key === latestDamageTypeKey ? latestDamageWeight : 0)
    ])
    .sort((left, right) => right[1] - left[1]);
  if (latestDamageTypeKey && !weighted.some(([key]) => key === latestDamageTypeKey)) {
    weighted.push([latestDamageTypeKey, latestDamageWeight]);
  }

  for (const [damageTypeKey] of weighted) {
    const profile = stage.profiles?.[damageTypeKey];
    if (profile) return { damageTypeKey, profile };
  }
  return Object.entries(stage.profiles ?? {})
    .map(([damageTypeKey, profile]) => profile ? { damageTypeKey, profile } : null)
    .find(Boolean) ?? null;
}
