import { BLEEDING_DAMAGE_TYPE_KEY, SYSTEM_ID, TEMPLATES, TRAUMA_CREATE_OPTION } from "../constants.mjs";
import { evaluateFormulaVariables } from "../formulas/index.mjs";
import {
  getCreatureOptions,
  getDamageTypeSettings,
  getTimeMechanicsIgnored,
  getTokenActionHudDamageIcons,
  getTraumaSettings
} from "../settings/accessors.mjs";
import { getTraumaGroupForActor } from "../settings/traumas.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import {
  DAMAGE_MITIGATION_MODES,
  ITEM_FUNCTIONS,
  getConditionFunction,
  getConditionWeakeningData,
  getDamageMitigationFunction,
  hasItemFunction
} from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";

const DAMAGE_SOCKET = `system.${SYSTEM_ID}`;
const DAMAGE_SOCKET_REQUEST_TIMEOUT_MS = 60000;
const TRAUMA_FLAG_SCOPE = "fallout-maw";
const TRAUMA_FLAG_KEY = "trauma";
const DAMAGE_EFFECT_FLAG_KEY = "damageEffect";
const LIMB_LOSS_EFFECT_KIND = "limbLoss";
const SHOCK_UNCONSCIOUS_FLAG_KEY = "shockUnconscious";
const FIRST_AID_TEMPORARY_EFFECT_KIND = "firstAidTemporary";
const BLEEDING_DAMAGE_EFFECT_KIND = "bleedingDamage";
const REGION_DAMAGE_BEHAVIOR_TYPE = "fallout-maw.periodicDamage";
const REGION_DAMAGE_FLAG_KEY = "periodicDamage";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const HEALING_DAMAGE_TYPE_KEY = "healing";
const MODE_DAMAGE = "damage";
const MODE_HEALING = "healing";
const SCOPE_LIMB = "limb";
const SCOPE_HEALTH = "health";
const SCOPE_HEALTH_AND_LIMB = "healthAndLimb";
const ROUND_SECONDS = 6;
const DAMAGE_NUMBER_ANIMATION_MS = 900;
const DAMAGE_MITIGATION_ICON_ANIMATION_MS = 1000;
const HEALING_NUMBER_COLOR = "#62d96b";
const EQUIPMENT_CONDITION_UNCONDITIONAL_RATIO = 0.2;
const DAMAGE_MITIGATION_PENETRATION_FLAT_STEP = 3;
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
const OVERLAY_STATUS_EFFECTS = new Set([
  STATUS_EFFECTS.dead,
  STATUS_EFFECTS.unconscious
]);
const COST_EFFECT_KEYS = Object.freeze({
  movement: "system.costs.movement",
  action: "system.costs.action"
});
const EQUIPMENT_CONDITION_DAMAGE_VARIABLES = Object.freeze([
  "incoming",
  "final",
  "blocked",
  "protected",
  "penetrated",
  "unconditional",
  "condition",
  "conditionMax",
  "mitigation",
  "penetration"
]);
let damageTimeHooksRegistered = false;
const combatRoundWorldTimes = new Map();
const processingPeriodicEffectUuids = new Set();
const damageMitigationTextureCache = new Map();
const actorDamageStatusSyncQueue = new Map();
const actorDamageMutationQueue = new Map();
const pendingDamageSocketRequests = new Map();
let damageHubOperationQueue = Promise.resolve();

export function registerDamageSocket() {
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
  const requests = (Array.isArray(entries) ? entries : [])
    .map(entry => ({
      actor: resolvedActor,
      limbKey,
      amount: Math.max(0, toInteger(entry?.amount)),
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      scope: SCOPE_HEALTH_AND_LIMB,
      source
    }))
    .filter(request => request.amount > 0 && request.damageTypeKey);
  if (!requests.length) return [];

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

export async function requestFirstAidNeedChanges({
  actor = null,
  actorUuid = "",
  needs = []
} = {}) {
  const resolvedActor = actor ?? await fromUuid(actorUuid);
  if (!resolvedActor) return [];

  const request = normalizeFirstAidNeedChangesRequest({
    actorUuid: resolvedActor.uuid,
    needs
  });
  if (!request.needs.length) return [];

  if (canApplyDamageLocally(resolvedActor)) {
    return runDamageHubOperation(() => applyFirstAidNeedChanges(resolvedActor, request.needs));
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("No active GM is available to apply first aid need changes.");
    return [];
  }

  return requestDamageSocketActionFromGM(gm, {
    action: "applyFirstAidNeedChanges",
    request
  });
}

async function applyDamageCycle(requests = []) {
  return runDamageHubOperation(() => applyDamageCycleNow(requests));
}

async function applyDamageCycleNow(requests = []) {
  const grouped = new Map();
  for (const request of requests) {
    const data = normalizeDamageRequest(request);
    if (!data.actorUuid) continue;
    const actorRequests = grouped.get(data.actorUuid) ?? [];
    actorRequests.push(data);
    grouped.set(data.actorUuid, actorRequests);
  }
  if (!grouped.size) return [];

  const results = [];
  for (const [actorUuid, actorRequests] of grouped) {
    const actor = await fromUuid(actorUuid);
    if (!actor || (!game.user?.isGM && !actor.isOwner)) continue;
    const actorResults = await queueActorDamageMutation(actorUuid, () => (
      applyDamageApplicationsNow({ actorUuid, requests: actorRequests }, { createSummary: false })
    ));
    if (Array.isArray(actorResults)) results.push(...actorResults);
  }

  await publishDamageSummaryMessage(results);
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
  return applyDamageCycleNow(stamped);
}

function serializeDamageCycleSocketResults(results = []) {
  return results.flat(Infinity).filter(Boolean).map(result => ({
    actorUuid: String(result.actor?.uuid ?? result.actorUuid ?? ""),
    amount: roundDamageAmount(result.amount),
    healthDelta: roundDamageAmount(result.healthDelta),
    limbDelta: roundDamageAmount(result.limbDelta),
    mode: result.mode ?? MODE_DAMAGE,
    scope: result.scope ?? "",
    limbKey: result.limbKey ?? "",
    damageTypeKey: result.damageTypeKey ?? ""
  }));
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
  return runDamageHubOperation(() => (
    queueActorDamageMutation(data.actorUuid, () => applyDamageApplicationNow(data, options))
  ));
}

async function applyDamageApplicationNow(request = {}, { createSummary = true } = {}) {
  const data = normalizeDamageRequest(request);
  const actor = await fromUuid(data.actorUuid);
  if (!actor) return undefined;
  if (!game.user?.isGM && !actor.isOwner) return undefined;

  const mode = data.mode === MODE_HEALING ? MODE_HEALING : MODE_DAMAGE;
  const scope = normalizeScope(data.scope, data.limbKey);
  if (mode === MODE_HEALING && isHealingBlocked(actor)) {
    await queueActorDamageStatusSync(actor);
    return { actor, amount: 0, healthDelta: 0, limbDelta: 0, mode, scope, limbKey: data.limbKey };
  }

  const damageType = getDamageTypeSettings().find(entry => entry.key === data.damageTypeKey);
  const periodic = damageType?.settings?.periodic;
  if (shouldSplitPeriodicDamage(data, mode, periodic)) {
    return applyPeriodicSplitDamageApplicationNow(actor, data, {
      createSummary,
      damageType,
      periodic,
      scope
    });
  }

  const mitigationResult = mode === MODE_DAMAGE && data.applyMitigation
    ? calculateDamageMitigation(actor, data.amount, damageType?.key ?? "", data.limbKey, data.source, {
      damageType,
      includeEquipmentConditionDamage: data.processDamageTypeSettings,
      includeResistanceOverheat: data.processDamageTypeSettings
    })
    : { amount: data.amount, display: null };
  const mitigatedAmount = mitigationResult.amount;
  if (mode === MODE_DAMAGE && data.applyMitigation && data.processDamageTypeSettings) {
    await applyEquipmentConditionDamage(actor, mitigationResult.equipmentConditionDamage);
    await applyResistanceOverheats(actor, [mitigationResult.resistanceOverheat]);
  }
  const effectiveAmount = mode === MODE_DAMAGE && data.processDamageTypeSettings
    ? applyLimbDamageMultiplier(actor, mitigatedAmount, data.limbKey)
    : mitigatedAmount;
  const mitigationDisplay = mode === MODE_DAMAGE && data.applyMitigation
    ? buildDamageMitigationDisplay(data.amount, mitigatedAmount)
    : null;
  if (mitigationDisplay) broadcastDamageMitigationIcon(actor, mitigationDisplay);
  if (effectiveAmount <= 0) return { actor, amount: 0, healthDelta: 0, limbDelta: 0, mode, scope };

  const needIncrease = damageType?.settings?.needIncrease;
  if (mode === MODE_DAMAGE && data.processDamageTypeSettings && needIncrease?.enabled) {
    await applyNeedIncrease(actor, {
      amount: effectiveAmount,
      settings: needIncrease
    });
    if (needIncrease.preventHealthDamage) {
      return { actor, amount: 0, potentialAmount: effectiveAmount, healthDelta: 0, limbDelta: 0, mode, scope };
    }
  }

  const result = await applyDirectDamageApplication(actor, {
    ...data,
    amount: effectiveAmount,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    mode,
    scope
  }, damageType);
  if (mode === MODE_DAMAGE && data.processDamageTypeSettings && result.healthDelta > 0) {
    await createResourceLimitEffect(actor, {
      damageType,
      healthDelta: result.healthDelta,
      source: data.source,
      worldTime: getDamageApplicationWorldTime(data.source)
    });
    await createBleedingDamageEffect(actor, {
      damageType,
      limbKey: data.limbKey,
      scope,
      healthDelta: result.healthDelta,
      source: data.source,
      worldTime: getDamageApplicationWorldTime(data.source)
    });
  }
  if (mode === MODE_DAMAGE && result.healthDelta > 0) {
    broadcastDamageNumbers(actor, [{
      amount: result.healthDelta,
      damageTypeKey: damageType?.key ?? data.damageTypeKey
    }]);
  }
  const healingNumberAmount = mode === MODE_HEALING ? getHealingNumberAmount(result) : 0;
  if (healingNumberAmount > 0) {
    broadcastDamageNumbers(actor, [{
      amount: healingNumberAmount,
      mode: MODE_HEALING
    }]);
  }
  if (createSummary) await publishDamageSummaryMessage([result]);
  return result;
}

async function applyPeriodicSplitDamageApplicationNow(actor, data = {}, { createSummary = true, damageType = null, periodic = {}, scope = SCOPE_HEALTH } = {}) {
  const { immediateAmount, delayedAmount } = calculatePeriodicDamageSplit(data.amount, periodic);
  const source = markPeriodicDamageSplitSource(data.source);
  const immediateResult = immediateAmount > 0
    ? await applyDamageApplicationNow({
      ...data,
      amount: immediateAmount,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      source
    }, { createSummary: false })
    : { actor, amount: 0, healthDelta: 0, limbDelta: 0, mode: MODE_DAMAGE, scope, createdTraumas: [] };

  if (delayedAmount > 0) await createPeriodicDamageEffect(actor, {
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
    amount: immediateAmount,
    delayedAmount
  };
  if (createSummary) await publishDamageSummaryMessage([result]);
  return result;
}

export function estimateDamageApplication(request = {}) {
  const data = normalizeDamageRequest(request);
  const actor = request.actor ?? (data.actorUuid ? fromUuidSync(data.actorUuid) : null);
  if (!actor || data.mode !== MODE_DAMAGE) {
    return { amount: 0, healthDamage: 0, damageTypeKey: data.damageTypeKey };
  }

  const damageType = getDamageTypeSettings().find(entry => entry.key === data.damageTypeKey);
  const mitigatedAmount = data.applyMitigation
    ? calculateEffectiveDamage(actor, data.amount, damageType?.key ?? "", data.limbKey, data.source, { damageType })
    : data.amount;
  let effectiveAmount = data.processDamageTypeSettings
    ? applyLimbDamageMultiplier(actor, mitigatedAmount, data.limbKey)
    : mitigatedAmount;

  const needIncrease = damageType?.settings?.needIncrease;
  if (data.processDamageTypeSettings && needIncrease?.enabled && needIncrease.preventHealthDamage) effectiveAmount = 0;

  const scope = normalizeScope(data.scope, data.limbKey);
  const result = data.limbKey && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB)
    ? calculateTargetedLimbDamage(actor, data.limbKey, effectiveAmount, {
      damageType,
      damageTypeKey: damageType?.key ?? data.damageTypeKey
    })
    : calculateEvenLimbDamage(actor, effectiveAmount, {
      damageType,
      damageTypeKey: damageType?.key ?? data.damageTypeKey
    });
  return {
    amount: Math.max(0, roundDamageAmount(data.amount)),
    healthDamage: Math.max(0, roundDamageAmount(result.healthDelta)),
    damageTypeKey: damageType?.key ?? data.damageTypeKey
  };
}

export async function applyDamageApplications({ actorUuid = "", requests = [] } = {}, options = {}) {
  const targetActorUuid = String(actorUuid ?? "").trim();
  if (!targetActorUuid) return undefined;
  return runDamageHubOperation(() => (
    queueActorDamageMutation(targetActorUuid, () => applyDamageApplicationsNow({ actorUuid: targetActorUuid, requests }, options))
  ));
}

async function applyDamageApplicationsNow({ actorUuid = "", requests = [] } = {}, { createSummary = true } = {}) {
  const actor = await fromUuid(actorUuid);
  if (!actor) return undefined;
  if (!game.user?.isGM && !actor.isOwner) return undefined;

  const batchRequests = [];
  const singleResults = [];
  const mitigationDisplays = [];
  const resistanceOverheats = [];
  const pendingPeriodicDamageEffects = [];
  const equipmentConditionDamageState = createEquipmentConditionDamageState(actor);
  for (const request of requests) {
    const data = normalizeDamageRequest({ ...request, actorUuid });
    if (data.mode !== MODE_DAMAGE) {
      singleResults.push(await applyDamageApplicationNow(data, { createSummary: false }));
      continue;
    }

    const entry = await prepareDamageBatchEntry(actor, data, { equipmentConditionDamageState, pendingPeriodicDamageEffects });
    if (entry?.damageMitigationDisplay) mitigationDisplays.push(entry.damageMitigationDisplay);
    if (entry?.resistanceOverheat) resistanceOverheats.push(entry.resistanceOverheat);
    if (entry?.amount > 0) batchRequests.push(entry);
  }

  const mitigationDisplay = combineDamageMitigationDisplays(mitigationDisplays);
  if (mitigationDisplay) broadcastDamageMitigationIcon(actor, mitigationDisplay);

  const batchResult = batchRequests.length
    ? await applyDamageEntriesBatch(actor, batchRequests)
    : undefined;
  await applyEquipmentConditionDamage(actor, getEquipmentConditionDamageStateEntries(equipmentConditionDamageState));
  await applyResistanceOverheats(actor, resistanceOverheats);
  for (const entry of pendingPeriodicDamageEffects) {
    await createPeriodicDamageEffect(actor, entry);
  }
  if (batchResult?.resourceLimitEntries?.length) {
    for (const entry of batchResult.resourceLimitEntries) {
      const damageType = getDamageTypeSettings().find(type => type.key === entry.damageTypeKey);
      await createResourceLimitEffect(actor, {
        damageType,
        healthDelta: entry.amount,
        source: entry.source,
        worldTime: getDamageApplicationWorldTime(entry.source)
      });
    }
  }
  if (batchResult?.bleedingEntries?.length) {
    for (const entry of batchResult.bleedingEntries) {
      await createBleedingDamageEffect(actor, entry);
    }
  }
  const results = [batchResult, ...singleResults].filter(Boolean);
  if (createSummary) await publishDamageSummaryMessage(results);
  return results;
}

async function prepareDamageBatchEntry(actor, data = {}, { equipmentConditionDamageState = null, pendingPeriodicDamageEffects = null } = {}) {
  const scope = normalizeScope(data.scope, data.limbKey);
  const damageType = getDamageTypeSettings().find(entry => entry.key === data.damageTypeKey);
  const periodic = damageType?.settings?.periodic;
  if (shouldSplitPeriodicDamage(data, MODE_DAMAGE, periodic)) {
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
    if (!immediateAmount) return null;
    return prepareDamageBatchEntry(actor, {
      ...data,
      amount: immediateAmount,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      source: markPeriodicDamageSplitSource(data.source)
    }, { equipmentConditionDamageState, pendingPeriodicDamageEffects });
  }

  const mitigationResult = data.applyMitigation
    ? calculateDamageMitigation(actor, data.amount, damageType?.key ?? "", data.limbKey, data.source, {
      damageType,
      includeEquipmentConditionDamage: data.processDamageTypeSettings,
      includeResistanceOverheat: data.processDamageTypeSettings,
      equipmentConditionDamageState: data.processDamageTypeSettings ? equipmentConditionDamageState : null
    })
    : { amount: data.amount, display: null };
  const mitigatedAmount = mitigationResult.amount;
  const effectiveAmount = data.processDamageTypeSettings
    ? applyLimbDamageMultiplier(actor, mitigatedAmount, data.limbKey)
    : mitigatedAmount;
  const damageMitigationDisplay = data.applyMitigation
    ? buildDamageMitigationDisplay(data.amount, mitigatedAmount)
    : null;
  if (effectiveAmount <= 0) {
    return damageMitigationDisplay
      ? {
        ...data,
        amount: 0,
        damageTypeKey: damageType?.key ?? data.damageTypeKey,
        damageType,
        scope,
        damageMitigationDisplay,
        resistanceOverheat: mitigationResult.resistanceOverheat
      }
      : null;
  }

  const needIncrease = damageType?.settings?.needIncrease;
  if (data.processDamageTypeSettings && needIncrease?.enabled) {
    await applyNeedIncrease(actor, {
      amount: effectiveAmount,
      settings: needIncrease
    });
    if (needIncrease.preventHealthDamage) return null;
  }

  return {
    ...data,
    amount: effectiveAmount,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    damageType,
    scope,
    damageMitigationDisplay,
    resistanceOverheat: mitigationResult.resistanceOverheat
  };
}

async function applyDirectDamageApplication(actor, data = {}, damageType = null) {
  const mode = data.mode === MODE_HEALING ? MODE_HEALING : MODE_DAMAGE;
  const scope = normalizeScope(data.scope, data.limbKey);
  const effectiveAmount = Math.max(0, roundDamageAmount(data.amount));

  const updateData = {};
  const limb = data.limbKey ? actor.system?.limbs?.[data.limbKey] : null;
  const shouldUpdateLimb = Boolean(limb) && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB);
  let actualHealthDelta = 0;
  let actualLimbDelta = 0;
  let previousLimbValue = limb ? toInteger(limb.value) : 0;
  let nextLimbValue = previousLimbValue;
  let limbStates = new Map();
  let damageAccumulation = new Map();
  let shockCheck = null;

  if (mode === MODE_DAMAGE) {
    const result = shouldUpdateLimb
      ? calculateTargetedLimbDamage(actor, data.limbKey, effectiveAmount, { damageType, damageTypeKey: data.damageTypeKey })
      : calculateEvenLimbDamage(actor, effectiveAmount, { damageType, damageTypeKey: data.damageTypeKey });
    limbStates = result.limbStates;
    damageAccumulation = result.damageAccumulation;
    shockCheck = result.shockCheck;
    actualHealthDelta = result.healthDelta;
    actualLimbDelta = result.limbDelta;
    if (shouldUpdateLimb) {
      const state = limbStates.get(data.limbKey);
      nextLimbValue = state?.nextValue ?? previousLimbValue;
    }
  } else if (shouldUpdateLimb) {
    const result = calculateTargetedLimbHealing(actor, data.limbKey, effectiveAmount);
    limbStates = result.limbStates;
    actualHealthDelta = result.healthDelta;
    actualLimbDelta = result.limbDelta;
    const state = limbStates.get(data.limbKey);
    nextLimbValue = state?.nextValue ?? previousLimbValue;
  } else {
    const result = calculateEvenLimbHealing(actor, effectiveAmount);
    limbStates = result.limbStates;
    actualHealthDelta = result.healthDelta;
    actualLimbDelta = result.limbDelta;
  }

  for (const [limbKey, state] of limbStates) {
    if (!state.totalDelta) continue;
    setLimbValueUpdate(updateData, actor, limbKey, state.nextValue);
  }
  for (const [limbKey, accumulation] of damageAccumulation) {
    updateData[`system.limbs.${limbKey}.damageAccumulation`] = normalizeDamageAccumulation(accumulation);
  }
  if (Object.keys(updateData).length) await actor.update(updateData, { falloutMawSkipDamageStatusSync: true });

  if (mode === MODE_HEALING && actualHealthDelta > 0) await advanceShockUnconsciousRecovery(actor, actualHealthDelta);
  const destroyedLimbKeys = mode === MODE_DAMAGE && actualLimbDelta > 0
    ? await applyDestroyedLimbConsequences(actor, Array.from(limbStates.keys()))
    : new Set();
  if (shockCheck) await performNegativeLimbShockCheck(actor, shockCheck);
  const destroyedLimbShockCheck = aggregateNegativeLimbShockChecks(actor, buildDestroyedLimbShockChecks(actor, destroyedLimbKeys));
  if (destroyedLimbShockCheck) await performNegativeLimbShockCheck(actor, destroyedLimbShockCheck);
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
        latestDamage
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
    createdTraumas
  };
}

export function getActorTraumas(actor) {
  return actor?.items?.filter(item => item.type === "trauma") ?? [];
}

export function getLimbHealingCap(actor, limbKey = "") {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return 0;
  if (isLimbDestroyed(actor, limbKey)) return 0;
  const max = toInteger(limb.max);
  return getActorTraumas(actor)
    .filter(item => item.system?.limbKey === limbKey)
    .reduce((cap, item) => Math.min(cap, toInteger(item.system?.thresholdValue)), max);
}

export function isLimbDestroyed(actor, limbKey = "") {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return false;
  return toInteger(limb.value) <= toInteger(limb.min);
}

export async function restoreDestroyedLimb(actor, limbKey = "") {
  if (!actor || !game.user?.isGM) return undefined;
  return queueActorDamageMutation(actor.uuid, async freshActor => {
    const limb = freshActor?.system?.limbs?.[limbKey];
    if (!freshActor || !limb) return undefined;
    const max = Math.max(0, toInteger(limb.max));

    await deleteLimbTraumas(freshActor, limbKey);
    await deleteLimbLossEffects(freshActor, limbKey);
    await freshActor.update({
      [`system.limbs.${limbKey}.value`]: max,
      [`system.limbs.${limbKey}.spent`]: 0,
      [`system.limbs.${limbKey}.damageAccumulation`]: {}
    }, { falloutMawSkipDamageStatusSync: true });
    await queueActorDamageStatusSync(freshActor);
    return freshActor;
  });
}

export async function fullyRestoreActorDamageState(actor) {
  if (!actor?.isOwner) return undefined;
  return queueActorDamageMutation(actor.uuid, async freshActor => {
    if (!freshActor?.isOwner) return undefined;

    await deleteDamageStateItems(freshActor);
    await deleteDamageSystemEffects(freshActor);
    await freshActor.unsetFlag(SYSTEM_ID, SHOCK_UNCONSCIOUS_FLAG_KEY);

    const updates = buildFullDamageRestoreUpdate(freshActor);
    if (Object.keys(updates).length) await freshActor.update(updates, { falloutMawSkipDamageStatusSync: true });
    await queueActorDamageStatusSync(freshActor);
    return freshActor;
  });
}

export function getDamageCostModifierState(actor) {
  return {
    movement: collectCostModifier(actor, COST_EFFECT_KEYS.movement),
    action: collectCostModifier(actor, COST_EFFECT_KEYS.action)
  };
}

export function prepareActorDamageUpdate(actor, changes = {}, options = {}) {
  if (!options?.falloutMawSkipDamageStatusSync) distributeManualHealthValueUpdate(actor, changes, options);
  synchronizeManualLimbValueUpdates(actor, changes);
  return preventCriticalLimbHealthRecovery(actor, changes);
}

export function handleActorDamageUpdate(actor, changes = {}, options = {}) {
  const healingDelta = Math.max(0, roundDamageAmount(options?.falloutMawShockHealingDelta));
  if (healingDelta > 0) void advanceShockUnconsciousRecovery(actor, healingDelta);
  if (options?.falloutMawSkipDamageStatusSync) return undefined;
  if (!isDamageStatusUpdateRelevant(changes)) return undefined;
  return queueActorDamageStatusSync(actor);
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
  for (const [key, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    const critical = Boolean(getUpdatePath(changes, `system.limbs.${key}.critical`) ?? limb?.critical);
    if (!critical) continue;

    const min = toInteger(getUpdatePath(changes, `system.limbs.${key}.min`) ?? limb?.min);
    const value = toInteger(getUpdatePath(changes, `system.limbs.${key}.value`) ?? limb?.value);
    if (value <= min) return true;
  }
  return false;
}

function isDamageStatusUpdateRelevant(changes = {}) {
  return hasUpdatePath(changes, "system.resources.health.value")
    || updateTouchesPath(changes, "system.limbs");
}

function queueActorDamageStatusSync(actor) {
  const actorUuid = actor?.uuid;
  if (!actorUuid) return undefined;

  const previous = actorDamageStatusSyncQueue.get(actorUuid) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const freshActor = fromUuidSync(actorUuid) ?? actor;
      await synchronizeActorVitalStatuses(freshActor);
    })
    .finally(() => {
      if (actorDamageStatusSyncQueue.get(actorUuid) === next) actorDamageStatusSyncQueue.delete(actorUuid);
    });
  actorDamageStatusSyncQueue.set(actorUuid, next);
  return next;
}

function queueActorDamageMutation(actorOrUuid, operation) {
  const actorUuid = typeof actorOrUuid === "string" ? actorOrUuid : actorOrUuid?.uuid;
  if (!actorUuid) return operation(null);

  const previous = actorDamageMutationQueue.get(actorUuid) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => operation(fromUuidSync(actorUuid)))
    .finally(() => {
      if (actorDamageMutationQueue.get(actorUuid) === next) actorDamageMutationQueue.delete(actorUuid);
    });
  actorDamageMutationQueue.set(actorUuid, next);
  return next;
}

export async function runDamageHubOperation(operation) {
  const previous = damageHubOperationQueue.catch(() => undefined);
  let releaseQueuedOperation;
  const queuedOperation = new Promise(resolve => {
    releaseQueuedOperation = resolve;
  });
  damageHubOperationQueue = previous.then(() => queuedOperation);
  await previous;

  try {
    return await operation();
  } finally {
    releaseQueuedOperation();
  }
}

async function applyDestroyedLimbConsequences(actor, limbKeys = []) {
  return applyDestroyedLimbConsequencesNow(actor, limbKeys);
}

async function applyDestroyedLimbConsequencesNow(actor, limbKeys = []) {
  const destroyed = new Set();
  for (const limbKey of Array.from(new Set(limbKeys.filter(Boolean)))) {
    if (!isLimbDestroyed(actor, limbKey)) continue;
    destroyed.add(limbKey);
    await deleteLimbTraumas(actor, limbKey);
    await deleteLimbLossEffects(actor, limbKey);
    await deleteLimbTimedDamageEffects(actor, limbKey);
    if (!isCriticalLimb(actor, limbKey)) await createLimbLossEffect(actor, limbKey);
  }
  return destroyed;
}

async function deleteLimbTraumas(actor, limbKey = "") {
  const ids = getActorTraumas(actor)
    .filter(item => item.system?.limbKey === limbKey)
    .map(item => item.id)
    .filter(Boolean);
  await deleteActorItems(actor, ids);
}

async function deleteLimbLossEffects(actor, limbKey = "") {
  const ids = Array.from(actor?.effects ?? [])
    .filter(effect => {
      const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
      return data?.kind === LIMB_LOSS_EFFECT_KIND && data?.limbKey === limbKey;
    })
    .map(effect => effect.id)
    .filter(Boolean);
  await deleteActorActiveEffects(actor, ids);
}

async function deleteLimbTimedDamageEffects(actor, limbKey = "") {
  const key = String(limbKey ?? "").trim();
  if (!key) return [];
  const ids = Array.from(actor?.effects ?? [])
    .filter(effect => {
      const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
      return isLimbTimedDamageEffect(data) && data.limbKey === key;
    })
    .map(effect => effect.id)
    .filter(Boolean);
  return deleteActorActiveEffects(actor, ids);
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
    return await actor.deleteEmbeddedDocuments("ActiveEffect", ids.filter(id => actor.effects?.has(id)), { animate: false });
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
    return [];
  }
}

function isDamageSystemEffect(effect) {
  if (!effect) return false;
  const flags = effect.flags?.[SYSTEM_ID] ?? effect.flags?.[TRAUMA_FLAG_SCOPE] ?? {};
  return Boolean(flags[DAMAGE_EFFECT_FLAG_KEY] || flags.traumaItem || flags.diseaseItem);
}

function buildFullDamageRestoreUpdate(actor) {
  const updates = {};
  for (const [key, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    const max = Math.max(0, toInteger(limb?.max));
    updates[`system.limbs.${key}.value`] = max;
    updates[`system.limbs.${key}.spent`] = 0;
    updates[`system.limbs.${key}.damageAccumulation`] = {};
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

async function createLimbLossEffect(actor, limbKey = "") {
  const limb = actor?.system?.limbs?.[limbKey];
  const effectEntries = getLimbLossEffects(actor, limbKey).map(prepareEffectChange).filter(change => change.key);
  const { changes, statuses } = splitSpecialEffectChanges(effectEntries);
  if (!changes.length && !statuses.length) return [];

  const label = String(limb?.label ?? limbKey);
  return actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: `${label}: отсутствует`,
    img: "icons/svg/blood.svg",
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    statuses,
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "active",
        [DAMAGE_EFFECT_FLAG_KEY]: {
          kind: LIMB_LOSS_EFFECT_KIND,
          limbKey
        }
      }
    },
    system: { changes }
  }], { animate: false });
}

function getLimbLossEffects(actor, limbKey = "") {
  const limbSettings = getActorLimbSettings(actor, limbKey);
  if (limbSettings?.critical) return [];
  return Array.isArray(limbSettings?.lossEffects)
    ? limbSettings.lossEffects.map(effect => ({ ...effect }))
    : [];
}

function getActorLimbSettings(actor, limbKey = "") {
  const race = getCreatureOptions().races.find(entry => entry.id === actor?.system?.creature?.raceId);
  return race?.limbs?.find(limb => limb.key === limbKey) ?? actor?.system?.limbs?.[limbKey] ?? null;
}

function isCriticalLimb(actor, limbKey = "") {
  const actorLimb = actor?.system?.limbs?.[limbKey];
  if (actorLimb && "critical" in actorLimb) return Boolean(actorLimb.critical);
  return Boolean(getActorLimbSettings(actor, limbKey)?.critical);
}

function hasDestroyedCriticalLimb(actor) {
  return Object.keys(actor?.system?.limbs ?? {})
    .some(limbKey => isCriticalLimb(actor, limbKey) && isLimbDestroyed(actor, limbKey));
}

function isHealingBlocked(actor) {
  return isActorDead(actor);
}

function isActorDead(actor) {
  return Boolean(actor?.statuses?.has?.(STATUS_EFFECTS.dead) || hasDestroyedCriticalLimb(actor));
}

async function synchronizeActorVitalStatuses(actor) {
  if (!actor?.toggleStatusEffect) return;
  const dead = hasDestroyedCriticalLimb(actor);
  if (dead) {
    if (hasShockUnconscious(actor)) await actor.unsetFlag(SYSTEM_ID, SHOCK_UNCONSCIOUS_FLAG_KEY);
    await setActorStatus(actor, STATUS_EFFECTS.unconscious, false, { animate: false });
    await setActorStatus(actor, STATUS_EFFECTS.dead, true);
    return;
  }

  const health = actor.health;
  const unconscious = hasShockUnconscious(actor) || (health && toInteger(health.value) <= toInteger(health.min));
  await setActorStatus(actor, STATUS_EFFECTS.dead, false);
  await setActorStatus(actor, STATUS_EFFECTS.unconscious, Boolean(unconscious));
}

async function performNegativeLimbShockCheck(actor, shockCheck = null) {
  if (!actor || !shockCheck || shockCheck.difficulty <= 0 || hasShockUnconscious(actor) || isActorDead(actor)) return undefined;
  const outcome = await requestSkillCheck({
    actor,
    skillKey: "resilience",
    data: {
      difficulty: shockCheck.difficulty
    },
    animate: false,
    createMessage: true,
    requester: getNegativeLimbShockRequester(actor, shockCheck)
  });
  const resultKey = String(outcome?.result?.key ?? "");
  if (!["failure", "criticalFailure"].includes(resultKey)) return outcome;
  await createShockUnconsciousState(actor);
  return outcome;
}

function aggregateNegativeLimbShockChecks(actor, shockChecks = []) {
  const entries = shockChecks
    .filter(entry => entry && Number(entry.difficulty) > 0)
    .map(entry => ({
      limbKey: String(entry.limbKey ?? ""),
      damage: Math.max(0, roundDamageAmount(entry.damage)),
      difficulty: Math.max(0, roundDamageAmount(entry.difficulty))
    }));
  if (!entries.length) return null;
  if (entries.length === 1) return entries[0];

  const limbKeys = Array.from(new Set(entries.map(entry => entry.limbKey).filter(Boolean)));
  return {
    limbKey: limbKeys.at(0) ?? "",
    limbKeys,
    damage: entries.reduce((sum, entry) => sum + entry.damage, 0),
    difficulty: entries.reduce((sum, entry) => sum + entry.difficulty, 0)
  };
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

async function createShockUnconsciousState(actor) {
  if (!actor || isActorDead(actor)) return false;
  const target = calculateShockRecoveryTarget(actor);
  await actor.setFlag(SYSTEM_ID, SHOCK_UNCONSCIOUS_FLAG_KEY, {
    target,
    progress: 0,
    createdAt: Number(game.time?.worldTime) || 0
  });
  await setActorStatus(actor, STATUS_EFFECTS.unconscious, true);
  return true;
}

async function advanceShockUnconsciousRecovery(actor, amount = 0) {
  const recovery = getShockUnconscious(actor);
  const healing = roundDamageAmount(amount);
  if (!recovery || healing <= 0) return false;

  const target = Math.max(1, roundDamageAmount(recovery.target));
  const progress = Math.min(target, Math.max(0, roundDamageAmount(recovery.progress)) + healing);
  if (progress >= target) {
    await actor.unsetFlag(SYSTEM_ID, SHOCK_UNCONSCIOUS_FLAG_KEY);
    await queueActorDamageStatusSync(actor);
    return true;
  }

  await actor.setFlag(SYSTEM_ID, SHOCK_UNCONSCIOUS_FLAG_KEY, {
    ...recovery,
    target,
    progress
  });
  await queueActorDamageStatusSync(actor);
  return false;
}

function hasShockUnconscious(actor) {
  return Boolean(getShockUnconscious(actor));
}

function getShockUnconscious(actor) {
  const data = actor?.getFlag?.(SYSTEM_ID, SHOCK_UNCONSCIOUS_FLAG_KEY)
    ?? actor?.flags?.[SYSTEM_ID]?.[SHOCK_UNCONSCIOUS_FLAG_KEY];
  if (!data || typeof data !== "object") return null;
  const target = Math.max(1, roundDamageAmount(data.target));
  const progress = Math.max(0, roundDamageAmount(data.progress));
  return { ...data, target, progress };
}

function calculateShockRecoveryTarget(actor) {
  const criticalLimbs = Object.values(actor?.system?.limbs ?? {}).filter(limb => Boolean(limb?.critical));
  const count = Math.max(1, criticalLimbs.length);
  const total = criticalLimbs.reduce((sum, limb) => sum + Math.max(0, toInteger(limb?.value)), 0);
  return Math.max(1, roundDamageAmount(total / (count * 2)));
}

async function setActorStatus(actor, statusId = "", active = false, options = {}) {
  if (!statusId || !actor) return;
  if (actor.statuses?.has?.(statusId) === active) {
    if (active) await ensureActorStatusOverlay(actor, getActorStatusEffectIds(actor, CONFIG.statusEffects?.[statusId]), statusId, options);
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
      await ensureActorStatusOverlay(actor, existing, statusId, options);
      return true;
    }
    await actor.deleteEmbeddedDocuments("ActiveEffect", existing, animationOptions);
    return false;
  }

  if (!active && active !== undefined) return undefined;
  const ActiveEffect = getDocumentClass("ActiveEffect");
  const effect = await ActiveEffect.fromStatusEffect(statusId);
  if (isOverlayStatusEffect(statusId)) effect.updateSource({ "flags.core.overlay": true });
  return ActiveEffect.implementation.create(effect, {
    parent: actor,
    keepId: true,
    ...animationOptions
  });
}

async function ensureActorStatusOverlay(actor, effectIds = [], statusId = "", options = {}) {
  if (!isOverlayStatusEffect(statusId)) return;
  const updates = effectIds
    .map(effectId => actor?.effects?.get(effectId))
    .filter(effect => effect && !effect.flags?.core?.overlay)
    .map(effect => ({
      _id: effect.id,
      "flags.core.overlay": true
    }));
  if (updates.length) await actor.updateEmbeddedDocuments("ActiveEffect", updates, getStatusAnimationOptions(statusId, options));
}

function isOverlayStatusEffect(statusId = "") {
  return OVERLAY_STATUS_EFFECTS.has(statusId);
}

function getStatusAnimationOptions(statusId = "", { animate = null } = {}) {
  if (animate === false) return { animate: false };
  if (animate === true) return {};
  return isOverlayStatusEffect(statusId) ? {} : { animate: false };
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

function collectCostModifier(actor, key = "") {
  const modifier = { add: 0, multiplier: 1, override: null };
  for (const effect of getActorApplicableEffects(actor)) {
    if (effect.disabled) continue;
    for (const change of effect.system?.changes ?? effect.changes ?? []) {
      if (String(change.key ?? "").trim() !== key) continue;
      const value = Number(change.value);
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

export function getResourceLimitState(actor) {
  const resources = {};
  for (const effect of actor?.effects ?? []) {
    if (effect.disabled) continue;
    const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
    if (data?.kind !== "resourceLimit" && data?.kind !== "resourceBlock") continue;
    const color = String(data.color ?? "#3f8cff");
    for (const [key, amount] of Object.entries(data.resources ?? {})) {
      const value = Math.max(0, toInteger(amount));
      if (!value) continue;
      resources[key] ??= { amount: 0, color };
      resources[key].amount += value;
      resources[key].color = color;
    }
  }
  return { resources };
}

export const getResourceBlockState = getResourceLimitState;

async function createPeriodicDamageEffect(actor, { damageType = {}, limbKey = "", scope = SCOPE_HEALTH, amount = 0, settings = {}, source = {}, worldTime = null } = {}) {
  if (!canCreateLimbTimedDamageEffect(actor, limbKey)) return [];
  const tickCount = Math.max(0, toInteger(settings.tickCount));
  const tickAmount = tickCount > 0 ? roundDamageAmount(amount / tickCount) : 0;
  if (!tickCount || !tickAmount) return [];

  const intervalSeconds = Math.max(1, toInteger(settings.intervalSeconds || ROUND_SECONDS));
  const startTime = Number.isFinite(Number(worldTime)) ? Number(worldTime) : (Number(game.time?.worldTime) || 0);
  const endTime = startTime + (intervalSeconds * tickCount);
  const effectName = String(settings.effectName || damageType.label || damageType.key || "Урон").trim();
  const effectData = {
    type: "base",
    name: effectName,
    img: String(settings.img || "icons/svg/hazard.svg"),
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "active",
        [DAMAGE_EFFECT_FLAG_KEY]: {
          kind: "periodicDamage",
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
          source
        }
      }
    },
    system: { changes: [] }
  };
  return actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
}

async function createBleedingDamageEffect(actor, { damageType = {}, limbKey = "", scope = SCOPE_HEALTH, healthDelta = 0, source = {}, worldTime = null } = {}) {
  if (!canCreateLimbTimedDamageEffect(actor, limbKey)) return [];
  const settings = damageType?.settings?.bleeding;
  if (!shouldCreateBleedingDamageEffect(damageType, settings, source)) return [];

  const totalAmount = roundDamageAmount((Number(healthDelta) || 0) * (Number(settings.percent) || 0) / 100);
  if (totalAmount <= 0) return [];

  const durationSeconds = Math.max(1, toInteger(settings.durationSeconds || ROUND_SECONDS));
  const tickCount = Math.max(1, Math.ceil(durationSeconds / ROUND_SECONDS));
  const tickAmounts = distributeIntegerAmountAcrossTicks(totalAmount, tickCount);
  if (!tickAmounts.some(amount => amount > 0)) return [];

  const startTime = Number.isFinite(Number(worldTime)) ? Number(worldTime) : (Number(game.time?.worldTime) || 0);
  const endTime = startTime + (ROUND_SECONDS * tickCount);
  const effectName = String(settings.effectName || "Кровотечение").trim();
  return actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: effectName,
    img: String(settings.img || "icons/skills/wounds/blood-drip-droplet-red.webp"),
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        kind: "temporary",
        [DAMAGE_EFFECT_FLAG_KEY]: {
          kind: BLEEDING_DAMAGE_EFFECT_KIND,
          damageTypeKey: BLEEDING_DAMAGE_TYPE_KEY,
          sourceDamageTypeKey: damageType?.key ?? "",
          limbKey,
          scope,
          tickAmounts,
          totalTicks: tickCount,
          remainingTicks: tickCount,
          intervalSeconds: ROUND_SECONDS,
          startTime,
          endTime,
          nextTickTime: startTime + ROUND_SECONDS,
          source
        }
      }
    },
    system: { changes: [] }
  }]);
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
  }]);
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
      [DAMAGE_EFFECT_FLAG_KEY]: damageEffect
    }
  };

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
  return actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
}

function normalizeFirstAidEffectRequest(request = {}) {
  return {
    actorUuid: String(request.actorUuid ?? "").trim(),
    itemName: String(request.itemName ?? "").trim(),
    itemImg: String(request.itemImg ?? "").trim(),
    healingPerTick: Math.max(0, toInteger(request.healingPerTick)),
    durationSeconds: Math.max(0, toInteger(request.durationSeconds)),
    intervalSeconds: Math.max(1, toInteger(request.intervalSeconds || ROUND_SECONDS)),
    changes: normalizeEffectChanges(request.changes),
    source: request.source && typeof request.source === "object" ? foundry.utils.deepClone(request.source) : {}
  };
}

function normalizeFirstAidNeedChangesRequest(request = {}) {
  const source = Array.isArray(request.needs) ? request.needs : Object.values(request.needs ?? {});
  return {
    actorUuid: String(request.actorUuid ?? "").trim(),
    needs: source
      .map(entry => ({
        key: String(entry?.key ?? entry?.needKey ?? "").trim(),
        value: toInteger(entry?.value)
      }))
      .filter(entry => entry.key && entry.value)
  };
}

async function applyFirstAidNeedChanges(actor, needs = []) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return [];
  const updates = {};
  for (const entry of needs) {
    const need = actor.system?.needs?.[entry.key];
    if (!need) continue;
    const min = Math.max(0, toInteger(need.min));
    const max = Math.max(min, toInteger(need.max));
    const next = Math.min(max, Math.max(min, toInteger(need.value) + toInteger(entry.value)));
    updates[`system.needs.${entry.key}.value`] = next;
  }
  if (!Object.keys(updates).length) return [];
  await actor.update(updates);
  return Object.entries(updates).map(([path, value]) => ({ path, value }));
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

  const min = Math.max(0, toInteger(need.min));
  const max = Math.max(min, toInteger(need.max));
  const current = Math.min(Math.max(toInteger(need.value), min), max);
  const next = Math.min(max, current + delta);
  if (next === current) return null;

  await actor.update({ [`system.needs.${needKey}.value`]: next });
  return { needKey, delta: next - current, value: next };
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
  if (payload.action === "applyFirstAidNeedChanges") {
    if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
    let ok = true;
    let result = [];
    let error = "";
    try {
      const request = normalizeFirstAidNeedChangesRequest(payload.request);
      const actor = await fromUuid(request.actorUuid);
      if (actor) result = await runDamageHubOperation(() => applyFirstAidNeedChanges(actor, request.needs));
    } catch (caught) {
      ok = false;
      error = String(caught?.message ?? caught ?? "Damage hub socket request failed.");
      console.error("Fallout MaW | First aid need socket request failed", caught);
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
  Hooks.on("combatStart", combat => {
    if (!game.user?.isActiveGM) return;
    combatRoundWorldTimes.set(combat.id, Number(game.time?.worldTime) || 0);
  });
  Hooks.on("deleteCombat", combat => combatRoundWorldTimes.delete(combat.id));
  Hooks.on("combatTurnChange", advanceWorldTimeForCombatRound);
  registerQueuedWorldTimeProcessor(processTimedDamageEffects, { priority: 100 });
  Hooks.on("preDeleteActiveEffect", preventIgnoredTimedDamageEffectDeletion);
  damageTimeHooksRegistered = true;
}

async function advanceWorldTimeForCombatRound(combat, previous, current) {
  if (!game.user?.isActiveGM || !combat?.started) return;
  const previousRound = toInteger(previous?.round);
  const currentRound = toInteger(current?.round);
  if (currentRound <= 1 || currentRound <= previousRound) return;

  const roundSeconds = getRoundSeconds();
  const previousWorldTime = combatRoundWorldTimes.get(combat.id) ?? (Number(game.time?.worldTime) || 0);
  const currentWorldTime = Number(game.time?.worldTime) || 0;
  const elapsed = Math.max(0, currentWorldTime - previousWorldTime);
  if (elapsed < roundSeconds) await game.time.advance(roundSeconds - elapsed);
  combatRoundWorldTimes.set(combat.id, Number(game.time?.worldTime) || currentWorldTime + roundSeconds);
}

function getRoundSeconds() {
  if (CONFIG.time) CONFIG.time.roundTime = ROUND_SECONDS;
  return ROUND_SECONDS;
}

async function processTimedDamageEffects(worldTime, deltaTime) {
  const dt = Number(deltaTime) || 0;
  if (!game.user?.isActiveGM || dt <= 0) return;
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
  for (const actor of getLoadedActors()) {
    if (!actor?.isOwner) continue;
    await queueActorDamageMutation(actor.uuid, async freshActor => {
      if (!freshActor?.isOwner) return;
      const entries = [];
      const effectUpdates = [];
      const effectDeleteIds = new Set();
      const lockedEffectUuids = new Set();

      for (const effect of Array.from(freshActor.effects ?? [])) {
        const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
        if (effect.disabled || !isDamageHubManagedTimedEffect(data)) continue;
        if (!effect.uuid || processingPeriodicEffectUuids.has(effect.uuid)) continue;
        const tickResult = collectDamageHubManagedTimedEffectTicks(effect, data, now);
        if (!tickResult.entries.length && !tickResult.update && !tickResult.deleteEffectId) continue;
        processingPeriodicEffectUuids.add(effect.uuid);
        lockedEffectUuids.add(effect.uuid);
        entries.push(...tickResult.entries);
        if (tickResult.update) effectUpdates.push(tickResult.update);
        if (tickResult.deleteEffectId) effectDeleteIds.add(tickResult.deleteEffectId);
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
          await applyDamageApplicationsNow({
            actorUuid: freshActor.uuid,
            requests: healingEntries.map(entry => ({
              actorUuid: freshActor.uuid,
              amount: entry.amount,
              damageTypeKey: entry.damageTypeKey || HEALING_DAMAGE_TYPE_KEY,
              mode: MODE_HEALING,
              scope: SCOPE_HEALTH,
              applyMitigation: false,
              processDamageTypeSettings: false,
              source: entry.source
            }))
          }, { createSummary: false });
        }
      } finally {
        for (const uuid of lockedEffectUuids) processingPeriodicEffectUuids.delete(uuid);
      }
    });
  }
  await publishDamageSummaryMessage(damageResults);
}

async function processRegionPeriodicDamage(now = 0, deltaTime = 0) {
  const batches = [];
  const previousTime = Math.max(0, (Number(now) || 0) - Math.max(0, Number(deltaTime) || 0));
  for (const scene of game.scenes?.contents ?? []) {
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
  if (requests.length) await applyDamageCycleNow(requests);
}

async function collectRegionPeriodicDamageBehavior(region, behavior, now = 0, previousTime = now) {
  const system = behavior.system ?? {};
  const entries = getRegionPeriodicDamageEntries(system);
  if (!entries.length) return null;

  const intervalSeconds = Math.max(1, toInteger(system.intervalSeconds) || ROUND_SECONDS);
  const delaySeconds = Math.max(0, toInteger(system.delaySeconds));
  const durationSeconds = Math.max(0, toInteger(system.durationSeconds));
  const state = await getRegionPeriodicDamageState(behavior, {
    now,
    previousTime,
    intervalSeconds,
    delaySeconds,
    durationSeconds
  });
  if (!state) return null;

  const expiresAt = Number(state.expiresAt);
  const oneShotDelayed = delaySeconds > 0 && durationSeconds <= 0;
  let nextTickTime = Number(state.nextTickTime);
  if (!Number.isFinite(nextTickTime)) nextTickTime = now + intervalSeconds;

  const tickTimes = [];
  while (now >= nextTickTime && (!Number.isFinite(expiresAt) || nextTickTime <= expiresAt)) {
    tickTimes.push(nextTickTime);
    nextTickTime += intervalSeconds;
    if (oneShotDelayed) break;
  }
  const dueTicks = tickTimes.length;

  const shouldExpire = oneShotDelayed && dueTicks > 0
    || (Number.isFinite(expiresAt) && now >= expiresAt);
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
    amount: Math.max(0, toInteger(entry.amount))
  }));
  const times = (Array.isArray(tickTimes) ? tickTimes : [])
    .map(time => Number(time))
    .filter(Number.isFinite);
  if (!times.length) times.push(Number(game.time?.worldTime) || 0);
  const requests = [];
  for (const token of getTokensInsideRegion(region)) {
    if (!token.actor) continue;
    const limbKey = selectRandomDamageLimbKey(token.actor);
    for (const worldTime of times) {
      const source = {
        regionUuid: region.uuid,
        behaviorUuid: behavior.uuid,
        tokenId: token.id,
        kind: "regionPeriodicDamage",
        dueTicks: 1,
        worldTime
      };
      for (const entry of damageEntries) {
        const damageTypeKey = String(entry?.damageTypeKey ?? "").trim();
        const amount = Math.max(0, toInteger(entry?.amount));
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
        amount: Math.max(0, toInteger(entry?.amount))
      }))
      .filter(entry => entry.damageTypeKey && entry.amount > 0)
    : [];
}

function getTokensInsideRegion(region) {
  const scene = region?.parent;
  if (!scene) return [];
  return (scene.tokens?.contents ?? [])
    .filter(token => {
      if (!token?.actor) return false;
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
  await region.update({ shapes });
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

  for (const scene of game.scenes?.contents ?? []) {
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

  for (const actor of getLoadedActors()) {
    if (!actor?.isOwner) continue;
    for (const effect of Array.from(actor.effects ?? [])) {
      const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
      if (!data || effect.disabled) continue;
      const updateData = buildIgnoredTimedDamageEffectUpdate(effect, data, elapsed);
      if (!Object.keys(updateData).length) continue;
      await updatePeriodicEffect(effect, updateData);
    }
  }
}

function buildIgnoredTimedDamageEffectUpdate(effect, data, elapsed) {
  if (data.kind === "periodicDamage" || data.kind === BLEEDING_DAMAGE_EFFECT_KIND) {
    const updateData = {};
    const startTime = Number(data.startTime);
    const endTime = Number(data.endTime);
    const nextTickTime = Number(data.nextTickTime);
    if (Number.isFinite(startTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.startTime`] = startTime + elapsed;
    if (Number.isFinite(endTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.endTime`] = endTime + elapsed;
    if (Number.isFinite(nextTickTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.nextTickTime`] = nextTickTime + elapsed;
    return updateData;
  }

  if (data.kind === "periodicHealing" || data.kind === FIRST_AID_TEMPORARY_EFFECT_KIND) {
    const updateData = {};
    const startTime = Number(data.startTime);
    const endTime = Number(data.endTime);
    const nextTickTime = Number(data.nextTickTime);
    if (Number.isFinite(startTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.startTime`] = startTime + elapsed;
    if (Number.isFinite(endTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.endTime`] = endTime + elapsed;
    if (Number.isFinite(nextTickTime)) updateData[`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.nextTickTime`] = nextTickTime + elapsed;
    return updateData;
  }

  if (data.kind === "resourceLimit" || data.kind === "resourceBlock") {
    const startTime = Number(effect.duration?.startTime);
    if (Number.isFinite(startTime)) return { "duration.startTime": startTime + elapsed };
  }

  return {};
}

function preventIgnoredTimedDamageEffectDeletion(effect, _options, _userId) {
  if (!getTimeMechanicsIgnored()) return undefined;
  const data = effect.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
  if (data?.kind !== "resourceLimit" && data?.kind !== "resourceBlock") return undefined;
  if (!Number(effect.duration?.seconds)) return undefined;
  const remaining = Number(effect.duration?.remaining);
  if (Number.isFinite(remaining) && remaining <= 0) return false;
  return undefined;
}

function isDamageHubManagedTimedEffect(data) {
  return data?.kind === "periodicDamage"
    || data?.kind === BLEEDING_DAMAGE_EFFECT_KIND
    || data?.kind === "periodicHealing"
    || data?.kind === FIRST_AID_TEMPORARY_EFFECT_KIND;
}

function isLimbTimedDamageEffect(data) {
  return data?.kind === "periodicDamage" || data?.kind === BLEEDING_DAMAGE_EFFECT_KIND;
}

function collectDamageHubManagedTimedEffectTicks(effect, data, now) {
  if (data.kind === "periodicHealing") return collectPeriodicHealingEffectTicks(effect, data, now);
  if (data.kind === FIRST_AID_TEMPORARY_EFFECT_KIND) return collectFirstAidTemporaryEffectTicks(effect, data, now);
  if (isLimbTimedDamageEffect(data) && data.limbKey && isLimbDestroyed(effect?.parent, data.limbKey)) {
    return {
      entries: [],
      update: null,
      deleteEffectId: effect.id ?? ""
    };
  }
  if (data.kind === BLEEDING_DAMAGE_EFFECT_KIND) return collectBleedingDamageEffectTicks(effect, data, now);
  return collectPeriodicDamageEffectTicks(effect, data, now);
}

function collectPeriodicDamageEffectTicks(effect, data, now) {
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
      limbKey: data.limbKey,
      amount: roundDamageAmount((Number(data.amountPerTick) || 0) * dueTicks),
      damageTypeKey: data.damageTypeKey,
      scope: data.scope,
      source: {
        ...(data.source ?? {}),
        periodicDamageEffectUuid: effect.uuid,
        dueTicks,
        worldTime: Number.isFinite(Number(now)) ? Number(now) : (Number(game.time?.worldTime) || 0)
      }
    }]
    : [];
  const shouldDelete = remainingTicks <= 0 || (Number(data.endTime) && now >= Number(data.endTime) && dueTicks === 0);
  return {
    entries: entries.filter(entry => entry.amount > 0),
    update: !shouldDelete && dueTicks > 0
      ? {
        effectId: effect.id,
        data: {
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.remainingTicks`]: remainingTicks,
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.nextTickTime`]: nextTickTime
        }
      }
      : null,
    deleteEffectId: shouldDelete ? effect.id : ""
  };
}

function collectBleedingDamageEffectTicks(effect, data, now) {
  const intervalSeconds = Math.max(1, toInteger(data.intervalSeconds || ROUND_SECONDS));
  const tickAmounts = Array.isArray(data.tickAmounts) ? data.tickAmounts.map(amount => Math.max(0, toInteger(amount))) : [];
  const totalTicks = Math.max(tickAmounts.length, toInteger(data.totalTicks));
  let remainingTicks = Math.max(0, toInteger(data.remainingTicks));
  let nextTickTime = Number(data.nextTickTime) || ((Number(data.startTime) || 0) + intervalSeconds);
  let dueTicks = 0;

  while (remainingTicks > 0 && now >= nextTickTime) {
    dueTicks += 1;
    remainingTicks -= 1;
    nextTickTime += intervalSeconds;
  }

  const startIndex = Math.max(0, totalTicks - toInteger(data.remainingTicks));
  const amount = tickAmounts.slice(startIndex, startIndex + dueTicks)
    .reduce((sum, value) => sum + Math.max(0, toInteger(value)), 0);
  const entries = dueTicks > 0
    ? [{
      limbKey: data.limbKey,
      amount,
      damageTypeKey: BLEEDING_DAMAGE_TYPE_KEY,
      scope: data.scope,
      source: markBleedingDamageTickSource({
        ...(data.source ?? {}),
        bleedingDamageEffectUuid: effect.uuid,
        dueTicks,
        worldTime: Number.isFinite(Number(now)) ? Number(now) : (Number(game.time?.worldTime) || 0)
      })
    }]
    : [];
  const shouldDelete = remainingTicks <= 0 || (Number(data.endTime) && now >= Number(data.endTime) && dueTicks === 0);
  return {
    entries: entries.filter(entry => entry.amount > 0),
    update: !shouldDelete && dueTicks > 0
      ? {
        effectId: effect.id,
        data: {
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.remainingTicks`]: remainingTicks,
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.nextTickTime`]: nextTickTime
        }
      }
      : null,
    deleteEffectId: shouldDelete ? effect.id : ""
  };
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
  const shouldDelete = remainingTicks <= 0 || (Number(data.endTime) && now >= Number(data.endTime) && dueTicks === 0);
  return {
    entries: entries.filter(entry => entry.amount > 0),
    update: !shouldDelete && dueTicks > 0
      ? {
        effectId: effect.id,
        data: {
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.remainingTicks`]: remainingTicks,
          [`flags.${TRAUMA_FLAG_SCOPE}.${DAMAGE_EFFECT_FLAG_KEY}.nextTickTime`]: nextTickTime
        }
      }
      : null,
    deleteEffectId: shouldDelete ? effect.id : ""
  };
}

function collectFirstAidTemporaryEffectTicks(effect, data, now) {
  const endTime = Number(data.endTime);
  const shouldDelete = Number.isFinite(endTime) && endTime > 0 && now >= endTime;
  return {
    entries: [],
    update: null,
    deleteEffectId: shouldDelete ? effect.id : ""
  };
}

async function updatePeriodicEffect(effect, updateData = {}) {
  try {
    if (!effect?.parent?.effects?.has(effect.id)) return;
    await effect.update(updateData);
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
  }
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

function distributeManualHealthValueUpdate(actor, changes = {}, options = {}) {
  const healthValuePath = "system.resources.health.value";
  if (!hasUpdatePath(changes, healthValuePath)) return false;

  const currentHealth = calculateAggregateHealth(actor?.system?.limbs);
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
  const amount = Math.abs(delta);
  const result = calculateManualAggregateHealthAdjustment(actor, amount, mode);
  for (const [limbKey, value] of Object.entries(result.values)) {
    setLimbValueUpdate(changes, actor, limbKey, value);
  }
  if (mode === MODE_HEALING && result.healthDelta > 0) {
    options.falloutMawShockHealingDelta = (Number(options.falloutMawShockHealingDelta) || 0) + result.healthDelta;
  }
  return true;
}

async function applyDamageEntriesBatch(actor, entries = []) {
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
  const limbStates = new Map();
  const damageAccumulation = new Map();
  const shockChecks = [];

  for (const entry of normalizedEntries) {
    const result = entry.limbKey && (entry.scope === SCOPE_LIMB || entry.scope === SCOPE_HEALTH_AND_LIMB)
      ? calculateTargetedLimbDamage(actor, entry.limbKey, entry.amount, {
        damageType: entry.damageType,
        damageTypeKey: entry.damageTypeKey,
        limbStates,
        damageAccumulation
      })
      : calculateEvenLimbDamage(actor, entry.amount, {
        damageType: entry.damageType,
        damageTypeKey: entry.damageTypeKey,
        limbStates,
        damageAccumulation
      });
    actualHealthDelta += result.healthDelta;
    if (result.shockCheck) shockChecks.push(result.shockCheck);
  }

  for (const [limbKey, state] of limbStates) {
    if (!state.totalDelta) continue;
    setLimbValueUpdate(updateData, actor, limbKey, state.nextValue);
  }
  for (const [limbKey, accumulation] of damageAccumulation) {
    updateData[`system.limbs.${limbKey}.damageAccumulation`] = normalizeDamageAccumulation(accumulation);
  }

  if (Object.keys(updateData).length) await actor.update(updateData, { falloutMawSkipDamageStatusSync: true });
  const destroyedLimbKeys = await applyDestroyedLimbConsequences(actor, Array.from(limbStates.keys()));
  const shockCheck = aggregateNegativeLimbShockChecks(actor, shockChecks);
  if (shockCheck) await performNegativeLimbShockCheck(actor, shockCheck);
  const destroyedLimbShockCheck = aggregateNegativeLimbShockChecks(actor, buildDestroyedLimbShockChecks(actor, destroyedLimbKeys));
  if (destroyedLimbShockCheck) await performNegativeLimbShockCheck(actor, destroyedLimbShockCheck);
  await queueActorDamageStatusSync(actor);
  const requestedHealthDamage = normalizedEntries.reduce((sum, entry) => sum + entry.amount, 0);
  const healthDeltasByType = buildBatchDamageNumberEntries(normalizedEntries, actualHealthDelta, requestedHealthDamage);
  const resourceLimitEntries = buildBatchDamageNumberEntries(
    normalizedEntries.filter(entry => entry.processDamageTypeSettings !== false),
    actualHealthDelta,
    requestedHealthDamage
  );
  const bleedingEntries = buildBatchBleedingEntries(
    normalizedEntries.filter(entry => entry.processDamageTypeSettings !== false),
    actualHealthDelta,
    requestedHealthDamage
  );
  if (actualHealthDelta > 0) {
    broadcastDamageNumbers(actor, healthDeltasByType);
  }

  const createdTraumas = [];
  for (const [limbKey, state] of limbStates) {
    if (!state.totalDelta) continue;
    if (destroyedLimbKeys.has(limbKey)) continue;
    const [damageTypeKey, latestDamage] = Object.entries(state.damageByType)
      .sort((left, right) => right[1] - left[1])
      .at(0) ?? ["untyped", state.totalDelta];
    createdTraumas.push(...await createTriggeredTraumas(actor, {
      limbKey,
      damageTypeKey,
      previousValue: state.previousValue,
      nextValue: state.nextValue,
      latestDamage
    }));
  }

  return {
    actor,
    amount: normalizedEntries.reduce((sum, entry) => sum + entry.amount, 0),
    healthDelta: actualHealthDelta,
    limbDelta: Array.from(limbStates.values()).reduce((sum, state) => sum + state.totalDelta, 0),
    limbDeltas: buildBatchLimbDeltaEntries(actor, limbStates),
    mode: MODE_DAMAGE,
    scope: SCOPE_HEALTH_AND_LIMB,
    healthDeltasByType,
    resourceLimitEntries,
    bleedingEntries,
    createdTraumas
  };
}

function combinePeriodicDamageEntries(entries = []) {
  const combined = new Map();
  for (const entry of entries) {
    const key = [
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

  const content = await renderTemplate(TEMPLATES.damageSummaryChatCard, context);
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: context.primaryActor }),
    content,
    sound: null,
    flags: {
      [SYSTEM_ID]: {
        damageSummary: {
          totalHealthDamage: context.totalHealthDamage,
          totalLimbDamage: context.totalLimbDamage,
          victims: context.victims.map(victim => ({
            actorUuid: victim.actorUuid,
            name: victim.name,
            healthDamage: victim.healthDamage,
            limbDamage: victim.limbDamage,
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

function buildDamageSummaryViewContext(results = []) {
  const victims = new Map();
  for (const result of results.flat(Infinity).filter(Boolean)) {
    if (result.mode && result.mode !== MODE_DAMAGE) continue;
    const actor = result.actor;
    if (!actor?.uuid) continue;

    const healthDelta = roundDamageAmount(result.healthDelta);
    const limbDelta = roundDamageAmount(result.limbDelta);
    const createdTraumas = Array.isArray(result.createdTraumas) ? result.createdTraumas.filter(Boolean) : [];
    if (healthDelta <= 0 && limbDelta <= 0 && !createdTraumas.length) continue;

    const victim = getDamageSummaryVictim(victims, actor);
    victim.healthDamage += healthDelta;
    victim.limbDamage += limbDelta;

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
    .filter(victim => victim.healthDamage > 0 || victim.limbDamage > 0 || victim.traumas.length > 0)
    .sort((left, right) => (right.healthDamage + right.limbDamage) - (left.healthDamage + left.limbDamage));

  return {
    primaryActor: victims.values().next().value?.actor ?? null,
    totalHealthDamage: rows.reduce((sum, victim) => sum + victim.healthDamage, 0),
    totalLimbDamage: rows.reduce((sum, victim) => sum + victim.limbDamage, 0),
    victims: rows,
    labels: {
      kicker: "Итог цикла",
      title: "Сводка урона",
      totalDamage: "Урон",
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

function calculateAggregateHealth(limbs = {}) {
  const entries = Object.values(limbs ?? {}).filter(limb => limb && typeof limb === "object");
  const max = entries.reduce((sum, limb) => sum + Math.max(0, toInteger(limb?.max)), 0);
  const value = entries.reduce((sum, limb) => sum + Math.max(0, toInteger(limb?.value)), 0);
  return { min: 0, value, max };
}

function calculateManualAggregateHealthAdjustment(actor, amount = 0, mode = MODE_DAMAGE) {
  const limbStates = new Map();
  const requested = roundDamageAmount(amount);
  if (requested <= 0) return createLimbMutationResult(limbStates);

  const targets = mode === MODE_HEALING
    ? getManualHealthHealingTargets(actor)
    : getManualHealthDamageTargets(actor);
  const allocations = distributeCappedIntegerAmount(requested, targets.map(target => ({
    key: target.key,
    capacity: target.capacity
  })));

  let healthDelta = 0;
  let limbDelta = 0;
  for (const [limbKey, allocated] of allocations) {
    const limb = actor?.system?.limbs?.[limbKey];
    if (!limb) continue;
    const target = targets.find(entry => entry.key === limbKey);
    const state = getBatchLimbState(limbStates, limbKey, limb);
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
  }

  return createLimbMutationResult(limbStates, new Map(), { healthDelta, limbDelta });
}

function getManualHealthDamageTargets(actor) {
  return Object.entries(actor?.system?.limbs ?? {})
    .map(([key, limb]) => ({
      key,
      capacity: Math.max(0, toInteger(limb?.value))
    }))
    .filter(target => target.capacity > 0);
}

function getManualHealthHealingTargets(actor) {
  return Object.entries(actor?.system?.limbs ?? {})
    .filter(([key]) => !isLimbDestroyed(actor, key))
    .map(([key, limb]) => {
      const currentPositive = Math.max(0, toInteger(limb?.value));
      const cap = Math.min(Math.max(0, toInteger(limb?.max)), getLimbHealingCap(actor, key));
      return {
        key,
        cap,
        capacity: Math.max(0, cap - currentPositive)
      };
    })
    .filter(target => target.capacity > 0);
}

function calculateEvenLimbDamage(actor, amount = 0, { damageType = null, damageTypeKey = "", limbStates = new Map(), damageAccumulation = new Map(), excludeLimbKeys = new Set() } = {}) {
  const targets = getPositiveLimbTargets(actor, limbStates, excludeLimbKeys);
  const allocations = distributeCappedIntegerAmount(amount, targets.map(target => ({
    key: target.key,
    capacity: Math.max(0, target.value - target.min)
  })));
  return applyDamageAllocations(actor, allocations, {
    damageType,
    damageTypeKey,
    limbStates,
    damageAccumulation
  });
}

function calculateTargetedLimbDamage(actor, limbKey = "", amount = 0, { damageType = null, damageTypeKey = "", limbStates = new Map(), damageAccumulation = new Map() } = {}) {
  const limb = actor?.system?.limbs?.[limbKey];
  const damage = roundDamageAmount(amount);
  if (!limb || damage <= 0) return createLimbMutationResult(limbStates, damageAccumulation);

  const currentValue = getLimbStateValue(actor, limbKey, limbStates);
  if (currentValue <= toInteger(limb.min)) return createLimbMutationResult(limbStates, damageAccumulation);
  if (currentValue < 0) {
    const previousTotalDelta = Math.max(0, roundDamageAmount(limbStates.get(limbKey)?.totalDelta));
    const limbResult = applyDamageAllocations(actor, new Map([[limbKey, damage]]), {
      damageType,
      damageTypeKey,
      limbStates,
      damageAccumulation
    });
    const state = limbStates.get(limbKey);
    const appliedLimbDamage = Math.max(0, roundDamageAmount((state?.totalDelta ?? 0) - previousTotalDelta));
    const shockCheck = createLimbShockCheck(actor, limbKey, appliedLimbDamage, state?.nextValue);
    const spreadResult = calculateEvenLimbDamage(actor, damage, {
      damageType,
      damageTypeKey,
      limbStates,
      damageAccumulation,
      excludeLimbKeys: new Set([limbKey])
    });
    const result = createLimbMutationResult(limbStates, damageAccumulation, {
      healthDelta: limbResult.healthDelta + spreadResult.healthDelta,
      limbDelta: Array.from(limbStates.values()).reduce((sum, entry) => sum + entry.totalDelta, 0)
    });
    result.shockCheck = shockCheck;
    return result;
  }

  const previousTotalDelta = Math.max(0, roundDamageAmount(limbStates.get(limbKey)?.totalDelta));
  const result = applyDamageAllocations(actor, new Map([[limbKey, damage]]), {
    damageType,
    damageTypeKey,
    limbStates,
    damageAccumulation
  });
  const state = limbStates.get(limbKey);
  const appliedLimbDamage = Math.max(0, roundDamageAmount((state?.totalDelta ?? 0) - previousTotalDelta));
  const negativeDamage = calculateNewNegativeLimbDamage(currentValue, state?.nextValue);
  if (negativeDamage <= 0) return result;

  const spreadResult = calculateEvenLimbDamage(actor, negativeDamage, {
    damageType,
    damageTypeKey,
    limbStates,
    damageAccumulation,
    excludeLimbKeys: new Set([limbKey])
  });
  const finalResult = createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta: result.healthDelta + spreadResult.healthDelta,
    limbDelta: Array.from(limbStates.values()).reduce((sum, entry) => sum + entry.totalDelta, 0)
  });
  finalResult.shockCheck = createLimbShockCheck(actor, limbKey, appliedLimbDamage, state?.nextValue);
  return finalResult;
}

function createLimbShockCheck(actor, limbKey = "", damage = 0, nextValue = null) {
  const shockDamage = Math.max(0, roundDamageAmount(damage));
  if (shockDamage <= 0) return null;
  return {
    limbKey,
    damage: shockDamage,
    difficulty: calculateLimbShockDifficulty(actor, limbKey, shockDamage, nextValue)
  };
}

function calculateLimbShockDifficulty(actor, limbKey = "", damage = 0, nextValue = null) {
  const base = Math.max(0, roundDamageAmount(damage * (isCriticalLimb(actor, limbKey) ? 2 : 1)));
  return Math.max(0, roundDamageAmount(base * getLimbShockStateMultiplier(actor, limbKey, nextValue)));
}

function getLimbShockStateMultiplier(actor, limbKey = "", nextValue = null) {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return 1;
  const min = toInteger(limb.min);
  const span = Math.max(1, Math.abs(min));
  const value = Number.isFinite(Number(nextValue)) ? toInteger(nextValue) : toInteger(limb.value);
  const negativeDepthRatio = Math.min(1, Math.max(0, -value / span));
  return 1 + negativeDepthRatio;
}

function calculateEvenLimbHealing(actor, amount = 0, { limbStates = new Map() } = {}) {
  const targets = getHealingLimbTargets(actor, limbStates);
  const allocations = distributeCappedIntegerAmount(amount, targets.map(target => ({
    key: target.key,
    capacity: Math.max(0, target.cap - target.value)
  })));
  return applyHealingAllocations(actor, allocations, { limbStates });
}

function calculateTargetedLimbHealing(actor, limbKey = "", amount = 0, { limbStates = new Map() } = {}) {
  const limb = actor?.system?.limbs?.[limbKey];
  const healing = roundDamageAmount(amount);
  if (!limb || healing <= 0) return createLimbMutationResult(limbStates);
  if (isLimbDestroyed(actor, limbKey)) return createLimbMutationResult(limbStates);

  const currentValue = getLimbStateValue(actor, limbKey, limbStates);
  const cap = Math.min(Math.max(0, toInteger(limb.max)), getLimbHealingCap(actor, limbKey));
  const capacity = Math.max(0, cap - currentValue);
  return applyHealingAllocations(actor, new Map([[limbKey, Math.min(healing, capacity)]]), { limbStates });
}

function applyDamageAllocations(actor, allocations = new Map(), { damageType = null, damageTypeKey = "", limbStates = new Map(), damageAccumulation = new Map() } = {}) {
  let healthDelta = 0;
  for (const [limbKey, amount] of allocations) {
    const limb = actor?.system?.limbs?.[limbKey];
    const damage = roundDamageAmount(amount);
    if (!limb || damage <= 0) continue;

    const state = getBatchLimbState(limbStates, limbKey, limb);
    const limbDamage = calculateLimbStateDamage(damage);
    if (!limbDamage) continue;

    const previousRunningValue = state.nextValue;
    state.nextValue = Math.max(state.min, state.nextValue - limbDamage);
    const actualLimbDelta = Math.max(0, previousRunningValue - state.nextValue);
    if (!actualLimbDelta) continue;

    const positiveLoss = Math.max(0, previousRunningValue) - Math.max(0, state.nextValue);
    healthDelta += Math.max(0, positiveLoss);
    state.totalDelta += actualLimbDelta;
    state.damageByType[damageTypeKey || "untyped"] = (state.damageByType[damageTypeKey || "untyped"] ?? 0) + actualLimbDelta;
    addBatchDamageAccumulation(damageAccumulation, actor, limbKey, damageTypeKey, actualLimbDelta);
  }

  return createLimbMutationResult(limbStates, damageAccumulation, {
    healthDelta,
    limbDelta: Array.from(limbStates.values()).reduce((sum, state) => sum + state.totalDelta, 0)
  });
}

function applyHealingAllocations(actor, allocations = new Map(), { limbStates = new Map() } = {}) {
  let healthDelta = 0;
  for (const [limbKey, amount] of allocations) {
    const limb = actor?.system?.limbs?.[limbKey];
    const healing = roundDamageAmount(amount);
    if (!limb || healing <= 0) continue;

    const state = getBatchLimbState(limbStates, limbKey, limb);
    const cap = Math.min(Math.max(0, toInteger(limb.max)), getLimbHealingCap(actor, limbKey));
    const previousRunningValue = state.nextValue;
    state.nextValue = Math.min(cap, state.nextValue + healing);
    const actualLimbDelta = Math.max(0, state.nextValue - previousRunningValue);
    if (!actualLimbDelta) continue;

    const positiveGain = Math.max(0, state.nextValue) - Math.max(0, previousRunningValue);
    healthDelta += Math.max(0, positiveGain);
    state.totalDelta += actualLimbDelta;
  }

  return createLimbMutationResult(limbStates, new Map(), {
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

function getPositiveLimbTargets(actor, limbStates = new Map(), excludeLimbKeys = new Set()) {
  const excluded = new Set(Array.from(excludeLimbKeys ?? []).map(key => String(key)));
  return Object.entries(actor?.system?.limbs ?? {})
    .filter(([key]) => !excluded.has(String(key)))
    .map(([key, limb]) => ({
      key,
      value: getLimbStateValue(actor, key, limbStates),
      min: toInteger(limb?.min)
    }))
    .filter(target => target.value > 0 && target.value > target.min);
}

function getHealingLimbTargets(actor, limbStates = new Map()) {
  return Object.entries(actor?.system?.limbs ?? {})
    .filter(([key]) => !isLimbDestroyed(actor, key))
    .map(([key, limb]) => ({
      key,
      value: getLimbStateValue(actor, key, limbStates),
      cap: Math.min(Math.max(0, toInteger(limb?.max)), getLimbHealingCap(actor, key))
    }))
    .filter(target => target.value < target.cap);
}

function getLimbStateValue(actor, limbKey = "", limbStates = new Map()) {
  if (limbStates.has(limbKey)) return toInteger(limbStates.get(limbKey)?.nextValue);
  return toInteger(actor?.system?.limbs?.[limbKey]?.value);
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

function getBatchLimbState(limbStates, limbKey, limb) {
  let state = limbStates.get(limbKey);
  if (state) return state;
  const previousValue = toInteger(limb.value);
  state = {
    previousValue,
    nextValue: previousValue,
    min: toInteger(limb.min),
    totalDelta: 0,
    damageByType: {}
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

function normalizeDamageAccumulation(value = {}) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([key, amount]) => [key, Math.max(0, Number(amount) || 0)])
      .filter(([_key, amount]) => amount > 0)
  );
}

function getLoadedActors() {
  const actors = new Map();
  for (const actor of game.actors?.contents ?? []) {
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token.actor?.uuid && !actors.has(token.actor.uuid)) actors.set(token.actor.uuid, token.actor);
  }
  return actors.values();
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
  const damageTypes = getDamageTypeSettings();
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
  const tokens = (canvas.tokens?.placeables ?? []).filter(token => token.actor?.uuid === actorUuid);
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
  return {
    actorUuid: String(request.actorUuid ?? request.actor?.uuid ?? "").trim(),
    limbKey,
    amount,
    damageTypeKey: mode === MODE_HEALING ? HEALING_DAMAGE_TYPE_KEY : String(request.damageTypeKey ?? "").trim(),
    mode,
    scope: normalizeScope(request.scope, limbKey),
    applyMitigation: request.applyMitigation !== false,
    processDamageTypeSettings: request.processDamageTypeSettings !== false,
    source: request.source && typeof request.source === "object" ? request.source : {},
    requesterUserId: String(request.requesterUserId ?? "")
  };
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

function normalizeScope(scope, limbKey = "") {
  if (scope === SCOPE_HEALTH) return SCOPE_HEALTH;
  if (scope === SCOPE_LIMB) return limbKey ? SCOPE_LIMB : SCOPE_HEALTH;
  return limbKey ? SCOPE_HEALTH_AND_LIMB : SCOPE_HEALTH;
}

function canApplyDamageLocally(actor) {
  return Boolean(game.user?.isGM || actor?.isOwner);
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function synchronizeManualLimbValueUpdates(actor, changes = {}) {
  for (const [limbKey, limb] of Object.entries(actor?.system?.limbs ?? {})) {
    const valuePath = `system.limbs.${limbKey}.value`;
    if (!hasUpdatePath(changes, valuePath)) continue;
    const value = toInteger(getUpdatePath(changes, valuePath));
    setUpdatePath(changes, `system.limbs.${limbKey}.spent`, calculateLimbSpentFromValue(limb, value));
  }
}

function setLimbValueUpdate(updateData, actor, limbKey, value) {
  const limb = actor?.system?.limbs?.[limbKey];
  setUpdatePath(updateData, `system.limbs.${limbKey}.value`, value);
  setUpdatePath(updateData, `system.limbs.${limbKey}.spent`, calculateLimbSpentFromValue(limb, value));
}

function calculateLimbSpentFromValue(limb, value) {
  const max = Math.max(0, toInteger(limb?.max));
  const min = -max;
  const capacity = Math.max(0, max - min);
  const boundedValue = Math.min(Math.max(toInteger(value), min), max);
  return Math.min(Math.max(0, max - boundedValue), capacity);
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
  const keys = Object.entries(actor?.system?.limbs ?? {})
    .filter(([key, limb]) => limb && typeof limb === "object" && !isLimbDestroyed(actor, key))
    .map(([key]) => key);
  return keys[Math.floor(Math.random() * keys.length)] ?? "";
}

function calculateEffectiveDamage(actor, amount, damageTypeKey = "", limbKey = "", source = {}, options = {}) {
  return calculateDamageMitigation(actor, amount, damageTypeKey, limbKey, source, options).amount;
}

function calculateDamageMitigation(actor, amount, damageTypeKey = "", limbKey = "", source = {}, options = {}) {
  const incomingDamage = Math.max(0, Math.floor(Number(amount) || 0));
  if (!incomingDamage) return { amount: 0, display: null, equipmentConditionDamage: [], resistanceOverheat: null };
  if (!damageTypeKey) return { amount: incomingDamage, display: null, equipmentConditionDamage: [], resistanceOverheat: null };

  const mitigationPenetration = getDamageMitigationPenetration(source);
  const equipmentSources = options.includeEquipmentConditionDamage
    ? getEquipmentConditionDamageSources(actor, damageTypeKey, limbKey)
    : [];
  const itemWear = new Map();
  const defenseSources = equipmentSources.filter(entry => entry.mode === DAMAGE_MITIGATION_MODES.defense);
  const resistanceSources = equipmentSources.filter(entry => entry.mode === DAMAGE_MITIGATION_MODES.resistance);
  const rawDefense = Math.max(0, actor.getDamageDefense?.(damageTypeKey, limbKey) ?? 0);
  const defensePenetration = Math.min(rawDefense, mitigationPenetration);
  const defense = Math.max(0, rawDefense - defensePenetration);
  let remaining = incomingDamage;
  const defenseProtected = Math.min(remaining, rawDefense);
  const defenseBlocked = Math.min(remaining, defense);
  addEquipmentProtectionWear(itemWear, defenseSources, {
    incoming: incomingDamage,
    protectedAmount: defenseProtected,
    blocked: defenseBlocked
  });
  remaining = Math.max(0, remaining - defenseBlocked);
  const rawResistance = Math.max(0, actor.getDamageResistance?.(damageTypeKey, limbKey) ?? 0);
  const resistancePenetration = Math.max(0, mitigationPenetration - defensePenetration);
  const resistance = Math.max(0, rawResistance - resistancePenetration);
  const resistanceProtected = Math.min(remaining, rawResistance);
  const resistanceBlocked = Math.min(remaining, resistance);
  addEquipmentProtectionWear(itemWear, resistanceSources, {
    incoming: remaining,
    protectedAmount: resistanceProtected,
    blocked: resistanceBlocked
  });
  remaining = Math.max(0, remaining - resistanceBlocked);
  addEquipmentUnconditionalWear(itemWear, equipmentSources, incomingDamage);
  const finalAmount = remaining;
  const overheatAmount = options.includeResistanceOverheat
    ? roundHalfUp(resistanceBlocked * RESISTANCE_OVERHEAT_RATIO)
    : 0;
  return {
    amount: finalAmount,
    display: null,
    resistanceOverheat: overheatAmount > 0 ? {
      damageTypeKey,
      amount: overheatAmount,
      blocked: resistanceBlocked
    } : null,
    equipmentConditionDamage: options.includeEquipmentConditionDamage
      ? calculateEquipmentConditionDamage(actor, itemWear, {
        damageType: options.damageType,
        damageTypeKey,
        incoming: incomingDamage,
        final: finalAmount,
        penetration: mitigationPenetration,
        state: options.equipmentConditionDamageState
      })
      : []
  };
}

function getEquipmentConditionDamageSources(actor, damageTypeKey = "", limbKey = "") {
  if (!actor || !damageTypeKey || !limbKey) return [];

  const sources = [];
  for (const item of actor.items?.contents ?? Array.from(actor.items ?? [])) {
    if (item.type !== "gear" || !item.system?.equipped) continue;
    if (!hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation) || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) continue;

    const mitigation = getDamageMitigationFunction(item);
    const entry = mitigation.entries?.[limbKey]?.[damageTypeKey];
    const baseValue = toInteger(entry?.value);
    if (baseValue <= 0) continue;

    const weakening = getConditionWeakeningData(item);
    const weakeningRatio = weakening.active ? weakening.ratio : 1;
    const value = Math.floor(baseValue * weakeningRatio);
    if (value <= 0) continue;

    sources.push({
      item,
      itemId: item.id,
      mode: String(mitigation.mode || DAMAGE_MITIGATION_MODES.defense),
      mitigation: value
    });
  }

  return sources;
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

function addEquipmentUnconditionalWear(itemWear, sources = [], incomingDamage = 0) {
  const amount = Math.floor(Math.max(0, Number(incomingDamage) || 0) * EQUIPMENT_CONDITION_UNCONDITIONAL_RATIO);
  if (!amount || !sources.length) return;

  const allocations = allocateIntegerByWeight(amount, sources, () => 1);
  for (const source of sources) {
    const allocated = allocations.get(source.itemId) ?? 0;
    if (!allocated) continue;
    getOrCreateEquipmentWear(itemWear, source).unconditional += allocated;
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
      unconditional: 0,
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
    key: `system.damageResistances.all.${damageTypeKey}`,
    type: "add",
    value: String(-Math.max(0, toInteger(amount))),
    phase: "final",
    priority: 0
  }));
}

function isResistanceOverheatEffect(effect) {
  const data = effect?.getFlag?.(TRAUMA_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[TRAUMA_FLAG_SCOPE]?.[DAMAGE_EFFECT_FLAG_KEY];
  return data?.kind === RESISTANCE_OVERHEAT_EFFECT_KIND;
}

function calculateEquipmentConditionDamage(actor, itemWear = new Map(), { damageType = null, damageTypeKey = "", incoming = 0, final = 0, penetration = 0, state = null } = {}) {
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
        unconditional: wear.unconditional,
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

    const applied = reserveEquipmentConditionDamage(wear.item, amount, state);
    if (applied > 0) results.push({ itemId: wear.itemId, amount: applied });
  }
  return results;
}

function createEquipmentConditionDamageState(actor) {
  return {
    actor,
    entries: new Map(),
    totals: new Map()
  };
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

async function applyEquipmentConditionDamage(actor, entries = []) {
  const totals = new Map();
  for (const entry of entries ?? []) {
    const itemId = String(entry?.itemId ?? "");
    const amount = Math.max(0, Math.floor(Number(entry?.amount) || 0));
    if (!itemId || !amount) continue;
    totals.set(itemId, (totals.get(itemId) ?? 0) + amount);
  }
  if (!totals.size) return;

  const updates = [];
  for (const [itemId, amount] of totals) {
    const item = actor.items?.get?.(itemId);
    if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) continue;
    const current = Math.max(0, toInteger(getConditionFunction(item).value));
    const next = Math.max(0, current - amount);
    if (next === current) continue;
    updates.push({
      _id: item.id,
      "system.functions.condition.value": next
    });
  }

  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

function applyLimbDamageMultiplier(actor, amount, limbKey = "") {
  const incomingDamage = Math.max(0, Number(amount) || 0);
  if (!incomingDamage || !limbKey) {
    return roundDamageAmount(incomingDamage);
  }
  const multiplier = Math.max(0, Number(actor.system?.limbs?.[limbKey]?.damageMultiplier) || 1);
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

  update[`system.limbs.${limbKey}.damageAccumulation`] = normalized;
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

async function createTriggeredTraumas(actor, { limbKey, damageTypeKey, previousValue, nextValue, latestDamage } = {}) {
  const limb = actor.system?.limbs?.[limbKey];
  if (!limb || toInteger(limb.max) <= 0) return [];

  const creatureOptions = getCreatureOptions();
  const damageTypes = getDamageTypeSettings();
  const traumaSettings = getTraumaSettings(creatureOptions, damageTypes);
  const traumaGroup = getTraumaGroupForActor(actor, traumaSettings, creatureOptions, damageTypes);
  const stages = traumaGroup.config?.limbs?.[limbKey]?.stages ?? [];
  if (!stages.length) return [];

  const max = toInteger(limb.max);
  const previousPercent = (previousValue / max) * 100;
  const nextPercent = (nextValue / max) * 100;
  const existingLimbTraumas = getActorTraumas(actor)
    .filter(item => item.system?.limbKey === limbKey);
  const triggeredStages = stages.filter(stage => (
    previousPercent > Number(stage.thresholdPercent)
    && nextPercent <= Number(stage.thresholdPercent)
    && !existingLimbTraumas.some(item => item.system?.stageId === stage.id)
  )).sort((left, right) => Number(right.thresholdPercent) - Number(left.thresholdPercent));
  if (!triggeredStages.length) return [];

  const snapshot = {
    ...(actor.system?.limbs?.[limbKey]?.damageAccumulation ?? {})
  };

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

  if (!progressionData.length) return [];
  const finalTraumaData = mergeEscalatedTraumaData({
    finalTraumaData: progressionData.at(-1),
    previousTraumas: existingLimbTraumas,
    intermediateTraumaData: progressionData.slice(0, -1),
    damageTypes
  });

  const created = await actor.createEmbeddedDocuments("Item", [finalTraumaData], {
    [TRAUMA_CREATE_OPTION]: true,
    animate: false
  });
  if (existingLimbTraumas.length) {
    await actor.deleteEmbeddedDocuments("Item", existingLimbTraumas.map(item => item.id), { animate: false });
  }
  return created;
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
  const effectEntries = (profileEntry.profile.effects ?? [])
    .map(prepareEffectChange)
    .filter(change => change.key);
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
  const effectChanges = [
    ...previousTraumas.flatMap(item => item.system?.effects ?? []),
    ...intermediateTraumaData.flatMap(data => data.system?.effects ?? []),
    ...(finalTraumaData.system?.effects ?? [])
  ].map(prepareEffectChange).filter(change => change.key);
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
  const weighted = Object.entries(snapshot ?? {})
    .map(([key, value]) => [key, Math.max(0, Number(value) || 0) + (key === latestDamageTypeKey ? Math.max(0, Number(latestDamage) || 0) : 0)])
    .sort((left, right) => right[1] - left[1]);
  if (latestDamageTypeKey && !weighted.some(([key]) => key === latestDamageTypeKey)) {
    weighted.push([latestDamageTypeKey, Math.max(0, Number(latestDamage) || 0)]);
  }

  for (const [damageTypeKey] of weighted) {
    const profile = stage.profiles?.[damageTypeKey];
    if (isConfiguredProfile(profile)) return { damageTypeKey, profile };
  }
  return null;
}

function isConfiguredProfile(profile) {
  if (!profile) return false;
  return Boolean(String(profile.name ?? "").trim() || String(profile.img ?? "").trim() || profile.effects?.length);
}
