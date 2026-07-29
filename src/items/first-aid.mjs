import {
  getActorHealingModifierPercent,
  requestDamageApplication,
  requestFirstAidEffect,
  requestFirstAidRemoveEffects,
  requestFirstAidWithdrawalEffect,
  requestNeedChanges
} from "../combat/damage-hub.mjs";
import {
  canSpendCombatActionPoints,
  isActorInActiveCombat,
  spendCombatActionPoints
} from "../combat/reaction-resources.mjs";
import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import {
  getDamageTypeSettings,
  getNeedSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { escapeHtml } from "../utils/dom.mjs";
import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import {
  calculateFirstAidScalingMultipliers,
  scaleFirstAidDurationSeconds,
  scaleFirstAidSignedValue
} from "../utils/first-aid-scaling.mjs";
import { getFirstAidChargesData, getFirstAidFunction, hasItemFunction, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";
import { getItemQuantity } from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  getFirstAidResolutionActiveUseKeys,
  getHealingResolutionActiveUseKeys
} from "../abilities/active-use-keys.mjs";
import {
  commitPreparedActiveUseOperations,
  prepareActiveUseOperation
} from "../abilities/active-use-runtime.mjs";
import { commitInventoryItemConsumption } from "../inventory/consume.mjs";
import {
  PERIODIC_HEALING_INTERVAL_SECONDS,
  isPeriodicHealingEffectKey
} from "../combat/periodic-healing.mjs";
import { getActorFirstAidModifiers } from "./first-aid-modifiers.mjs";
import { buildFirstAidApplicationCardContext } from "./first-aid-chat-card.mjs";

const { DialogV2 } = foundry.applications.api;
const FIRST_AID_SOCKET = `system.${SYSTEM_ID}`;
const FIRST_AID_SOCKET_SCOPE = "fallout-maw.firstAid";
const FIRST_AID_SOCKET_TIMEOUT = 10000;
const HEALING_DAMAGE_TYPE_KEY = "healing";
const CRITICAL_SUCCESS_DEFAULT_BONUS = 20;
const pendingFirstAidSocketRequests = new Map();

export function registerFirstAidSocket() {
  game.socket.on(FIRST_AID_SOCKET, handleFirstAidSocketMessage);
}

export async function useFirstAidItem({
  sourceActor = null,
  targetActor = null,
  sourceToken = null,
  targetToken = null,
  item = null,
  source: workflowSource = {},
  chainRef = null,
  options = {}
} = {}) {
  if (!sourceActor || !targetActor || !item || !hasItemFunction(item, ITEM_FUNCTIONS.firstAid)) return false;

  const firstAid = getFirstAidFunction(item);
  const charges = getFirstAidChargesData(item);
  if (getItemQuantity(item) <= 0 || charges.value <= 0) {
    ui.notifications.warn(`${item.name}: item is depleted.`);
    return false;
  }
  const skillKey = getFirstAidSkillKey(firstAid);
  const checkDifficulty = Math.max(0, toInteger(firstAid.difficulty));
  const skillAvailable = sourceActor.system?.skills?.[skillKey]
    && getSkillSettings().some(skill => skill.key === skillKey);
  if (checkDifficulty > 0 && !skillAvailable) {
    ui.notifications.warn(game.i18n.format("FALLOUTMAW.Item.FirstAidSkillUnavailable", {
      item: item.name,
      skill: skillKey
    }));
    return false;
  }
  if (!isTargetInFirstAidRange(sourceToken, targetToken, firstAid)) return false;
  const firstAidOperationId = `first-aid:${String(item.uuid ?? item.id ?? "")}:${foundry.utils.randomID()}`;
  const targetContext = await getFirstAidTargetContext(targetToken, targetActor, {
    sourceActor,
    sourceToken,
    chanceOperationId: firstAidOperationId
  });
  if (!targetContext) return false;
  const selectedLimbs = await requestLimbSelection(targetActor, limitFirstAidSelectionByCharges(firstAid, charges.value), targetContext);
  if (selectedLimbs === null) return false;
  const removeEffectDamageTypeKeys = getFirstAidRemoveEffectDamageTypeKeys(firstAid);
  const removeEffectLimbKeys = getSelectedFirstAidLimbKeys(selectedLimbs);
  const hasEffectRemoval = removeEffectDamageTypeKeys.length > 0 && removeEffectLimbKeys.length > 0;
  const chargeCost = getFirstAidChargeCost(selectedLimbs);
  if (chargeCost > charges.value) {
    ui.notifications.warn(`${item.name}: not enough charges.`);
    return false;
  }
  if (!(await spendActionPointsIfNeeded(sourceActor, firstAid))) return false;

  const inheritedChainRef = chainRef
    ?? options?.falloutMawSystemEventChainRef
    ?? options?.chainRef
    ?? workflowSource?.chainRef
    ?? null;
  const source = {
    kind: "firstAid",
    sourceActorUuid: sourceActor.uuid,
    itemUuid: item.uuid,
    itemName: item.name,
    worldTime: Number(game.time?.worldTime) || 0,
    ...(inheritedChainRef ? { chainRef: inheritedChainRef } : {})
  };

  const checkResult = await rollFirstAidCheck({
    sourceActor,
    targetActor,
    sourceToken,
    targetToken,
    difficulty: checkDifficulty,
    skillKey,
    item,
    chainRef: inheritedChainRef
  });
  const resultKey = checkResult?.result?.key ?? (checkDifficulty > 0 ? "" : "success");
  if (!resultKey) return false;
  const resultMultiplier = resultKey === "criticalFailure"
    ? 0
    : resultKey === "failure"
      ? 0.5
      : 1;
  const criticalSuccessMultiplier = resultKey === "criticalSuccess"
    ? 1 + (Math.max(0, toInteger(firstAid.criticalSuccessHealingBonus ?? CRITICAL_SUCCESS_DEFAULT_BONUS)) / 100)
    : 1;
  source.chanceOperationId = firstAidOperationId;
  source.limitedUseOperationId = firstAidOperationId;

  const outgoingContext = {
    actorToken: sourceToken?.object ?? sourceToken,
    targetActor,
    targetToken: targetToken?.object ?? targetToken,
    chanceOperationId: firstAidOperationId
  };
  const incomingContext = {
    actorToken: targetToken?.object ?? targetToken,
    targetActor: sourceActor,
    targetToken: sourceToken?.object ?? sourceToken,
    chanceOperationId: firstAidOperationId
  };
  const canApplyMainEffects = resultKey !== "criticalFailure";
  const canScaleEffects = canApplyMainEffects
    && firstAidHasScalableEffects(firstAid, targetContext, selectedLimbs);
  const canScaleDuration = canApplyMainEffects && firstAidHasScalableDuration(firstAid);
  const canResistWithdrawal = firstAidHasWithdrawalEffects(firstAid);
  const canUseOutgoingHealing = canApplyMainEffects
    && firstAidCanUseOutgoingHealing(firstAid, targetContext, selectedLimbs);
  const outgoingActiveUseKeys = canScaleEffects
    ? getFirstAidResolutionActiveUseKeys({ direction: "outgoing" })
    : new Set();
  if (canUseOutgoingHealing) {
    for (const key of getHealingResolutionActiveUseKeys({ direction: "outgoing" })) {
      outgoingActiveUseKeys.add(key);
    }
  }
  const incomingActiveUseKeys = getFirstAidResolutionActiveUseKeys({
    direction: "incoming",
    includeEffectiveness: canScaleEffects,
    includeDuration: canScaleDuration,
    includeWithdrawalResistance: canResistWithdrawal
  });
  const hasDistinctActors = String(sourceActor?.uuid ?? sourceActor?.id ?? "")
    !== String(targetActor?.uuid ?? targetActor?.id ?? "");
  const activeUsePreparations = [
    outgoingActiveUseKeys.size
      ? prepareActiveUseOperation({
        kind: "firstAidOutgoing",
        actor: sourceActor,
        keys: outgoingActiveUseKeys,
        conditionContexts: [outgoingContext],
        reverseOnly: false
      })
      : null,
    hasDistinctActors && outgoingActiveUseKeys.size
      ? prepareActiveUseOperation({
        kind: "firstAidOutgoingReverse",
        actor: targetActor,
        keys: outgoingActiveUseKeys,
        conditionContexts: [incomingContext],
        reverseOnly: true
      })
      : null,
    incomingActiveUseKeys.size
      ? prepareActiveUseOperation({
        kind: "firstAidIncoming",
        actor: targetActor,
        keys: incomingActiveUseKeys,
        conditionContexts: [incomingContext],
        reverseOnly: false
      })
      : null,
    hasDistinctActors && incomingActiveUseKeys.size
      ? prepareActiveUseOperation({
        kind: "firstAidIncomingReverse",
        actor: sourceActor,
        keys: incomingActiveUseKeys,
        conditionContexts: [outgoingContext],
        reverseOnly: true
      })
      : null
  ].filter(Boolean);

  const outgoingFirstAidModifiers = getActorFirstAidModifiers(sourceActor, outgoingContext);
  const incomingFirstAidModifiers = targetContext.firstAidModifiers
    ?? getActorFirstAidModifiers(targetActor, incomingContext);
  const scaling = calculateFirstAidScalingMultipliers({
    resultMultiplier: resultMultiplier * criticalSuccessMultiplier,
    outgoingEffectivenessPercent: outgoingFirstAidModifiers.outgoingEffectivenessPercent,
    incomingEffectivenessPercent: incomingFirstAidModifiers.incomingEffectivenessPercent,
    outgoingHealingPercent: canUseOutgoingHealing
      ? getActorHealingModifierPercent(sourceActor, "outgoing", outgoingContext)
      : 0,
    durationPercent: incomingFirstAidModifiers.durationPercent,
    withdrawalResistancePercent: incomingFirstAidModifiers.withdrawalResistancePercent
  });

  const healing = calculateHealingAmount(targetActor, firstAid, scaling.healing, targetContext);
  const durationSeconds = scaleFirstAidDurationSeconds(firstAid.durationSeconds, scaling.duration);
  const normalizedChanges = normalizeFirstAidChanges(firstAid.changes, scaling.effect, scaling.healing);
  const healingPerTick = targetContext.isConstruct ? 0 : Math.max(0, normalizedChanges.healingPerTick);
  const changes = normalizedChanges.changes;
  const normalizedWithdrawal = normalizeFirstAidWithdrawal(
    firstAid,
    scaling.withdrawalEffect,
    scaling.withdrawalHealing
  );
  const withdrawalHealingPerTick = targetContext.isConstruct ? 0 : Math.max(0, normalizedWithdrawal.healingPerTick);
  const withdrawalChanges = normalizedWithdrawal.changes;
  const withdrawalDurationSeconds = scaleFirstAidDurationSeconds(
    firstAid.withdrawalDurationSeconds,
    scaling.withdrawalDuration
  );
  const hasWithdrawal = withdrawalDurationSeconds > 0
    && (withdrawalChanges.length > 0 || withdrawalHealingPerTick > 0);
  const needs = normalizeFirstAidNeeds(firstAid.needs, scaling.effect);
  const limbs = targetContext.isConstruct
    ? []
    : normalizeFirstAidLimbs(selectedLimbs, firstAid, scaling.effect, scaling.healing);
  const hasTimedEffect = durationSeconds > 0 && (healingPerTick > 0 || changes.length);
  const appliedDurationSeconds = hasTimedEffect ? durationSeconds : 0;
  const appliedWithdrawalDurationSeconds = hasWithdrawal ? withdrawalDurationSeconds : 0;
  source.limitedUseSkipOutgoing = true;

  if (resultKey === "criticalFailure") {
    await spendFirstAidItem(item, chargeCost, createFirstAidDocumentOptions(inheritedChainRef));
    const criticalFailureDamage = await applyCriticalFailureDamage(targetActor, firstAid, source);
    if (hasWithdrawal) {
      await requestFirstAidWithdrawalEffect({
        actor: targetActor,
        itemName: item.name,
        itemImg: item.img,
        healingPerTick: withdrawalHealingPerTick,
        durationSeconds: withdrawalDurationSeconds,
        intervalSeconds: PERIODIC_HEALING_INTERVAL_SECONDS,
        changes: withdrawalChanges,
        source
      });
    }
    await commitFirstAidActiveUsePreparations(activeUsePreparations, firstAidOperationId);
    await postFirstAidApplicationChat({
      sourceActor,
      targetActor,
      targetContext,
      item,
      firstAid,
      resultKey,
      scaling,
      selectedLimbs,
      healing: 0,
      appliedLimbs: [],
      appliedNeeds: [],
      appliedDurationSeconds: 0,
      appliedWithdrawalDurationSeconds,
      hasEffectRemoval: false,
      removeEffectDamageTypeKeys,
      removeEffectLimbKeys,
      criticalFailureDamage,
      chargeCost,
      showHealingEffectiveness: false
    });
    return true;
  }

  if (healing > 0) {
    await requestDamageApplication({
      actor: targetActor,
      amount: healing,
      damageTypeKey: HEALING_DAMAGE_TYPE_KEY,
      mode: "healing",
      scope: "health",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source
    });
  }

  for (const limb of limbs) {
    await requestDamageApplication({
      actor: targetActor,
      limbKey: limb.limbKey,
      amount: Math.abs(limb.value),
      damageTypeKey: limb.value >= 0 ? HEALING_DAMAGE_TYPE_KEY : "",
      mode: limb.value >= 0 ? "healing" : "damage",
      scope: "limb",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source
    });
  }

  const appliedNeeds = needs.length
    ? await requestNeedChanges({
      actor: targetActor,
      needs,
      context: {
        kind: "firstAidNeedChange",
        chanceOperationId: firstAidOperationId,
        limitedUseOperationId: firstAidOperationId,
        itemUuid: item.uuid,
        sourceActorUuid: sourceActor.uuid
      }
    })
    : [];

  if (hasEffectRemoval) {
    await requestFirstAidRemoveEffects({
      actor: targetActor,
      limbKeys: removeEffectLimbKeys,
      damageTypeKeys: removeEffectDamageTypeKeys
    });
  }

  if (hasTimedEffect) {
    await requestFirstAidEffect({
      actor: targetActor,
      itemName: item.name,
      itemImg: item.img,
      healingPerTick,
      durationSeconds,
      intervalSeconds: PERIODIC_HEALING_INTERVAL_SECONDS,
      changes,
      withdrawal: hasWithdrawal ? buildFirstAidWithdrawalPayload({
        itemName: item.name,
        itemImg: item.img,
        healingPerTick: withdrawalHealingPerTick,
        durationSeconds: withdrawalDurationSeconds,
        changes: withdrawalChanges,
        source
      }) : null,
      source
    });
  } else if (hasWithdrawal) {
    await requestFirstAidWithdrawalEffect({
      actor: targetActor,
      itemName: item.name,
      itemImg: item.img,
      healingPerTick: withdrawalHealingPerTick,
      durationSeconds: withdrawalDurationSeconds,
      intervalSeconds: PERIODIC_HEALING_INTERVAL_SECONDS,
      changes: withdrawalChanges,
      source
    });
  }

  await spendFirstAidItem(item, chargeCost, createFirstAidDocumentOptions(inheritedChainRef));
  await commitFirstAidActiveUsePreparations(activeUsePreparations, firstAidOperationId);
  await postFirstAidApplicationChat({
    sourceActor,
    targetActor,
    targetContext,
    item,
    firstAid,
    resultKey,
    scaling,
    selectedLimbs,
    healing,
    appliedLimbs: limbs,
    appliedNeeds,
    appliedDurationSeconds,
    appliedWithdrawalDurationSeconds,
    hasEffectRemoval,
    removeEffectDamageTypeKeys,
    removeEffectLimbKeys,
    criticalFailureDamage: 0,
    chargeCost,
    showHealingEffectiveness: canUseOutgoingHealing
  });
  return true;
}

function firstAidHasScalableEffects(firstAid = {}, targetContext = null, selectedLimbs = []) {
  if (!targetContext?.isConstruct && Math.max(0, toInteger(firstAid?.healing)) > 0) return true;
  if (!targetContext?.isConstruct
    && toInteger(firstAid?.limbSelection?.value)
    && selectedLimbs.some(entry => Math.max(0, toInteger(entry?.count)) > 0)) return true;
  if ((Array.isArray(firstAid?.needs) ? firstAid.needs : Object.values(firstAid?.needs ?? {}))
    .some(entry => toInteger(entry?.value ?? entry))) return true;
  const changes = Array.isArray(firstAid?.changes)
    ? firstAid.changes
    : Object.values(firstAid?.changes ?? {});
  return changes.some(change => String(change?.key ?? "").trim());
}

function firstAidHasScalableDuration(firstAid = {}) {
  if (Math.max(0, toInteger(firstAid?.durationSeconds)) <= 0) return false;
  const changes = Array.isArray(firstAid?.changes)
    ? firstAid.changes
    : Object.values(firstAid?.changes ?? {});
  return changes.some(change => String(change?.key ?? "").trim());
}

function firstAidHasWithdrawalEffects(firstAid = {}) {
  return (Array.isArray(firstAid?.withdrawal) ? firstAid.withdrawal : Object.values(firstAid?.withdrawal ?? {}))
    .some(change => String(change?.key ?? "").trim());
}

function firstAidCanUseOutgoingHealing(firstAid = {}, targetContext = null, selectedLimbs = []) {
  if (targetContext?.isConstruct) return false;
  if (Math.max(0, toInteger(firstAid?.healing)) > 0) return true;
  if (Math.max(0, toInteger(firstAid?.limbSelection?.value)) > 0
    && selectedLimbs.some(entry => Math.max(0, toInteger(entry?.count)) > 0)) return true;
  if (Math.max(0, toInteger(firstAid?.durationSeconds)) <= 0) return false;
  const changes = Array.isArray(firstAid?.changes)
    ? firstAid.changes
    : Object.values(firstAid?.changes ?? {});
  return changes.some(change => (
    isPeriodicHealingEffectKey(change?.key)
    && Number(change?.value) > 0
  ));
}

function calculateHealingAmount(actor, firstAid = {}, multiplier = 1, targetContext = null) {
  if (targetContext?.isConstruct || actor?.type === "construct") return 0;
  if (Number(multiplier) <= 0) return 0;
  const base = Math.max(0, toInteger(firstAid.healing));
  if (!base) return 0;
  if (firstAid.healingIsPercentage) {
    const max = Math.max(0, toInteger(targetContext?.healthMax ?? actor?.system?.resources?.health?.max));
    return Math.max(0, Math.floor((max * base * multiplier) / 100));
  }
  return Math.max(0, scaleFirstAidSignedValue(base, multiplier));
}

function normalizeFirstAidChanges(changes = [], multiplier = 1, healingMultiplier = multiplier) {
  return normalizeFirstAidEffectChangeList(changes, multiplier, healingMultiplier);
}

function normalizeFirstAidWithdrawal(firstAid = {}, multiplier = 1, healingMultiplier = multiplier) {
  return normalizeFirstAidEffectChangeList(firstAid.withdrawal, multiplier, healingMultiplier);
}

function normalizeFirstAidEffectChangeList(changes = [], multiplier = 1, healingMultiplier = multiplier) {
  const source = Array.isArray(changes) ? changes : Object.values(changes ?? {});
  if (Number(multiplier) <= 0 && Number(healingMultiplier) <= 0) {
    return { changes: [], healingPerTick: 0 };
  }
  let healingPerTick = 0;
  const normalized = source
    .map(change => {
      const key = String(change?.key ?? "").trim();
      if (isPeriodicHealingEffectKey(key)) {
        if (Number(healingMultiplier) <= 0) return null;
        const value = scaleHealingChangeValue(change?.value, healingMultiplier);
        healingPerTick += toInteger(value);
        return null;
      }
      if (Number(multiplier) <= 0) return null;
      const value = scaleChangeValue(change?.value, multiplier);
      return {
        key,
        type: ["add", "multiply", "override"].includes(String(change?.type ?? "")) ? String(change.type) : "add",
        value: String(value),
        phase: String(change?.phase ?? "initial") || "initial",
        priority: change?.priority === null || change?.priority === "" || change?.priority === undefined
          ? null
          : toInteger(change.priority)
      };
    })
    .filter(Boolean)
    .filter(change => change.key);
  return { changes: normalized, healingPerTick };
}

function buildFirstAidWithdrawalPayload({
  itemName = "",
  itemImg = "",
  healingPerTick = 0,
  durationSeconds = 0,
  changes = [],
  source = {}
} = {}) {
  if (!changes.length && healingPerTick <= 0) return null;
  return {
    itemName,
    itemImg,
    healingPerTick,
    durationSeconds,
    intervalSeconds: PERIODIC_HEALING_INTERVAL_SECONDS,
    changes,
    source
  };
}

function normalizeFirstAidNeeds(needs = [], multiplier = 1) {
  if (Number(multiplier) <= 0) return [];
  const source = Array.isArray(needs) ? needs : Object.entries(needs ?? {}).map(([needKey, value]) => ({ needKey, value }));
  return source
    .map(entry => ({
      key: String(entry?.needKey ?? "").trim(),
      value: scaleFirstAidSignedValue(toInteger(entry?.value), multiplier)
    }))
    .filter(entry => entry.key && entry.value);
}

function getFirstAidRemoveEffectDamageTypeKeys(firstAid = {}) {
  const source = Array.isArray(firstAid.removeEffects)
    ? firstAid.removeEffects
    : Object.entries(firstAid.removeEffects ?? {}).map(([damageTypeKey]) => ({ damageTypeKey }));
  return Array.from(new Set(source
    .map(entry => String(entry?.damageTypeKey ?? entry?.key ?? "").trim())
    .filter(Boolean)));
}

function getSelectedFirstAidLimbKeys(selectedLimbs = []) {
  return Array.from(new Set((Array.isArray(selectedLimbs) ? selectedLimbs : [])
    .filter(entry => Math.max(0, toInteger(entry?.count)) > 0)
    .map(entry => String(entry?.limbKey ?? "").trim())
    .filter(Boolean)));
}

function normalizeFirstAidLimbs(limbs = [], firstAid = {}, multiplier = 1, healingMultiplier = multiplier) {
  const baseValue = toInteger(firstAid.limbSelection?.value);
  const resolvedMultiplier = baseValue > 0 ? healingMultiplier : multiplier;
  if (Number(resolvedMultiplier) <= 0) return [];
  const value = baseValue > 0 && Number(healingMultiplier) <= 0
    ? 0
    : scaleFirstAidSignedValue(baseValue, resolvedMultiplier);
  if (!value) return [];
  const source = Array.isArray(limbs) ? limbs : [];
  return source
    .map(entry => ({
      limbKey: String(entry?.limbKey ?? "").trim(),
      value: value * Math.max(1, toInteger(entry?.count))
    }))
    .filter(entry => entry.limbKey && entry.value);
}

function limitFirstAidSelectionByCharges(firstAid = {}, availableCharges = 1) {
  const maxApplications = Math.max(0, toInteger(firstAid.limbSelection?.count));
  const available = Math.max(0, toInteger(availableCharges));
  return {
    ...firstAid,
    limbSelection: {
      ...(firstAid.limbSelection ?? {}),
      count: Math.min(maxApplications, available)
    }
  };
}

function getFirstAidChargeCost(selectedLimbs = []) {
  const limbApplications = (Array.isArray(selectedLimbs) ? selectedLimbs : [])
    .reduce((total, limb) => total + Math.max(0, toInteger(limb?.count)), 0);
  return Math.max(1, limbApplications);
}

function scaleChangeValue(value, multiplier = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isFinite(Number(multiplier)) || Number(multiplier) === 1) return value;
  return scaleFirstAidSignedValue(number, multiplier);
}

function scaleHealingChangeValue(value, multiplier = 1) {
  if (Number(multiplier) <= 0) return 0;
  return scaleChangeValue(value, multiplier);
}

async function rollFirstAidCheck({
  sourceActor = null,
  targetActor = null,
  sourceToken = null,
  targetToken = null,
  difficulty = 0,
  skillKey = "doctor",
  item = null,
  chainRef = null
} = {}) {
  const resolvedDifficulty = Math.max(0, toInteger(difficulty));
  if (!resolvedDifficulty) return null;
  return requestSkillCheck({
    actor: sourceActor,
    skillKey: String(skillKey ?? "").trim() || "doctor",
    data: {
      difficulty: resolvedDifficulty,
      actorToken: sourceToken?.object ?? sourceToken,
      targetToken: targetToken?.object ?? targetToken,
      targetActor
    },
    animate: false,
    requester: item?.name ?? "",
    chainRef,
    source: {
      itemUuid: item?.uuid ?? "",
      chainRef
    }
  });
}

function getFirstAidSkillKey(firstAid = {}) {
  return String(firstAid?.skillKey ?? "").trim() || "doctor";
}

async function getFirstAidTargetContext(targetToken, fallbackActor = null, {
  sourceActor = null,
  sourceToken = null,
  chanceOperationId = ""
} = {}) {
  const actor = targetToken?.actor ?? fallbackActor;
  if (!actor) return null;
  if (canUseActorLocally(actor)) {
    return buildFirstAidTargetContext(actor, targetToken, {
      sourceActor,
      sourceToken,
      chanceOperationId
    });
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для доступа к цели первой помощи.");
    return null;
  }

  try {
    const result = await requestFirstAidSocket("getTargetContext", {
      actorUuid: actor.uuid,
      tokenName: targetToken?.name ?? "",
      targetTokenUuid: getDocumentUuid(targetToken),
      sourceActorUuid: sourceActor?.uuid ?? "",
      sourceTokenUuid: getDocumentUuid(sourceToken),
      chanceOperationId
    }, gm);
    return result?.targetContext ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | First aid target socket failed`, error);
    ui.notifications.error(`Не удалось получить данные цели первой помощи: ${error.message}`);
    return null;
  }
}

function buildFirstAidTargetContext(actor, token = null, {
  sourceActor = null,
  sourceToken = null,
  chanceOperationId = ""
} = {}) {
  const installedProstheses = getInstalledProsthesesByLimb(actor);
  return {
    actorUuid: actor?.uuid ?? "",
    name: token?.name ?? actor?.name ?? "",
    actorName: actor?.name ?? "",
    tokenName: token?.name ?? "",
    healthMax: Math.max(0, toInteger(actor?.system?.resources?.health?.max)),
    isConstruct: isConstructActor(actor),
    firstAidModifiers: getActorFirstAidModifiers(actor, {
      actorToken: token?.object ?? token,
      targetActor: sourceActor,
      targetToken: sourceToken?.object ?? sourceToken,
      chanceOperationId
    }),
    limbs: Object.entries(actor?.system?.limbs ?? {})
      .map(([key, limb]) => {
        const value = toInteger(limb?.value);
        const prosthesis = installedProstheses.get(key) ?? null;
        return {
          key,
          label: String(limb?.label ?? key),
          value,
          min: toInteger(limb?.min),
          max: toInteger(limb?.max),
          missing: Boolean(limb?.missing),
          prosthesis: prosthesis ? { id: prosthesis.id, name: prosthesis.name } : null
        };
      })
      .filter(limb => limb.key)
  };
}

async function requestLimbSelection(actor, firstAid = {}, targetContext = null) {
  const count = Math.max(0, toInteger(firstAid.limbSelection?.count));
  const value = toInteger(firstAid.limbSelection?.value);
  const hasEffectRemoval = getFirstAidRemoveEffectDamageTypeKeys(firstAid).length > 0;
  if (targetContext?.isConstruct && value > 0 && !hasEffectRemoval) return [];
  if (!count || (!value && !hasEffectRemoval)) return [];
  const limbs = (Array.isArray(targetContext?.limbs) && targetContext.limbs.length
    ? targetContext.limbs
    : Object.entries(actor.system?.limbs ?? {}).map(([key, limb]) => ({
      key,
      label: String(limb?.label ?? key),
      value: toInteger(limb?.value),
      min: toInteger(limb?.min),
      max: toInteger(limb?.max),
      missing: Boolean(limb?.missing),
      prosthesis: null
    })))
    .filter(limb => limb.key);
  if (!limbs.length) return [];

  const applicationColumnLabel = game.i18n.localize("FALLOUTMAW.Item.FirstAidSelectLimbsApplications");
  const currentColumnLabel = game.i18n.localize("FALLOUTMAW.Item.FirstAidSelectLimbsCurrent");
  const resultColumnLabel = game.i18n.localize("FALLOUTMAW.Item.FirstAidSelectLimbsResult");
  const rows = limbs.map(limb => {
    const unavailable = Boolean(limb.missing || limb.prosthesis);
    const disabled = unavailable || (value > 0
      ? limb.value >= limb.max
      : value < 0
        ? limb.value <= limb.min
        : false);
    const result = calculateLimbSelectionPreview(limb.value, value, 0, limb.min, limb.max);
    const currentLabel = limb.prosthesis
      ? "Протез"
      : limb.missing
        ? "Отсутствует"
        : `${limb.value} / ${limb.max}`;
    return `
    <button type="button" class="fallout-maw-first-aid-limb-choice${disabled ? " disabled" : ""}" data-limb-key="${escapeHtml(limb.key)}" data-count="0" data-current="${limb.value}" data-min="${limb.min}" data-max="${limb.max}" data-disabled="${disabled ? "true" : "false"}">
      <span class="fallout-maw-first-aid-limb-count">${disabled ? "-" : "0"}</span>
      <span>${escapeHtml(limb.label)}</span>
      <small>${currentLabel}</small>
      <strong data-limb-result>${disabled ? "-" : result}</strong>
    </button>
  `;
  }).join("");

  const result = await DialogV2.wait({
    classes: ["dialog", "fallout-maw", "fallout-maw-first-aid-limb-dialog"],
    position: { width: 680 },
    window: { title: game.i18n.localize("FALLOUTMAW.Item.FirstAidSelectLimbs") },
    content: `
      <div class="fallout-maw-first-aid-limb-summary">
        <p>${game.i18n.format("FALLOUTMAW.Item.FirstAidSelectLimbsHint", { count })}</p>
        <p>${game.i18n.format("FALLOUTMAW.Item.FirstAidSelectLimbsHealing", { value: formatSignedInteger(value) })}</p>
        <p class="fallout-maw-first-aid-limb-total">${game.i18n.localize("FALLOUTMAW.Common.Total")}: <strong><span data-limb-total>0</span> / ${count}</strong></p>
      </div>
      <div class="fallout-maw-first-aid-limb-choice-list">
        <div class="fallout-maw-first-aid-limb-choice-header">
          <span>${applicationColumnLabel}</span>
          <span>${game.i18n.localize("FALLOUTMAW.Item.FirstAidLimbs")}</span>
          <span>${currentColumnLabel}</span>
          <span>${resultColumnLabel}</span>
        </div>
        ${rows}
      </div>
    `,
    render: (_event, dialog) => activateFirstAidLimbSelection(dialog, { count, value }),
    buttons: [
      {
        action: "apply",
        label: "FALLOUTMAW.Common.SaveChanges",
        icon: "fa-solid fa-check",
        default: true,
        disabled: true,
        callback: (_event, button) => {
          const entries = collectFirstAidLimbSelection(button.form);
          const total = entries.reduce((sum, entry) => sum + entry.count, 0);
          if (total < 1 || total > count) {
            ui.notifications.warn(game.i18n.format("FALLOUTMAW.Item.FirstAidSelectLimbsInvalid", { count }));
            return false;
          }
          return entries;
        }
      },
      {
        action: "cancel",
        label: "Cancel",
        icon: "fa-solid fa-xmark",
        callback: () => false
      }
    ]
  });
  return result === false ? null : result;
}

function collectFirstAidLimbSelection(form) {
  return Array.from(form?.querySelectorAll("[data-limb-key]") ?? [])
    .map(row => ({
      limbKey: String(row.dataset.limbKey ?? "").trim(),
      count: Math.max(0, toInteger(row.dataset.count))
    }))
    .filter(entry => entry.limbKey && entry.count > 0);
}

function activateFirstAidLimbSelection(dialog, { count = 0, value = 0 } = {}) {
  const form = dialog.element?.querySelector("form");
  if (!form) return;
  const applyButton = form.querySelector('button[data-action="apply"]');
  const totalElement = form.querySelector("[data-limb-total]");

  const getTotal = () => collectFirstAidLimbSelection(form)
    .reduce((sum, entry) => sum + entry.count, 0);
  const updateRow = row => {
    const rowCount = Math.max(0, toInteger(row.dataset.count));
    const current = toInteger(row.dataset.current);
    const min = toInteger(row.dataset.min);
    const max = toInteger(row.dataset.max);
    row.classList.toggle("selected", rowCount > 0);
    const countElement = row.querySelector(".fallout-maw-first-aid-limb-count");
    const resultElement = row.querySelector("[data-limb-result]");
    if (countElement) countElement.textContent = String(rowCount);
    if (resultElement) resultElement.textContent = String(calculateLimbSelectionPreview(current, value, rowCount, min, max));
  };
  const updateTotal = () => {
    const total = getTotal();
    if (totalElement) totalElement.textContent = String(total);
    if (applyButton) applyButton.disabled = total <= 0;
  };

  for (const row of form.querySelectorAll("[data-limb-key]")) {
    if (row.dataset.disabled === "true") continue;
    row.addEventListener("click", event => {
      event.preventDefault();
      if (getTotal() >= count) {
        ui.notifications.warn(game.i18n.format("FALLOUTMAW.Item.FirstAidSelectLimbsInvalid", { count }));
        return;
      }
      row.dataset.count = String(Math.max(0, toInteger(row.dataset.count)) + 1);
      updateRow(row);
      updateTotal();
    });
    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      row.dataset.count = String(Math.max(0, toInteger(row.dataset.count) - 1));
      updateRow(row);
      updateTotal();
    });
  }
  updateTotal();
}

function calculateLimbSelectionPreview(current, value, count, min, max) {
  const next = toInteger(current) + (toInteger(value) * Math.max(0, toInteger(count)));
  return Math.min(Math.max(toInteger(min), next), toInteger(max));
}

function getInstalledProsthesesByLimb(actor) {
  const entries = new Map();
  for (const item of actor?.items ?? []) {
    if (item?.type !== "gear" || !hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)) continue;
    if (!item.system?.equipped || String(item.system?.placement?.mode ?? "") !== "prosthesis") continue;
    const limbKey = String(item.system?.placement?.limbKey ?? "").trim();
    if (limbKey) entries.set(limbKey, item);
  }
  return entries;
}

function formatSignedInteger(value) {
  const number = toInteger(value);
  return number > 0 ? `+${number}` : String(number);
}

function isConstructActor(actor) {
  const type = String(actor?.system?.creature?.typeId ?? actor?.system?.details?.type?.value ?? "").toLowerCase();
  return type === "construct" || type === "robot" || type === "робот" || type === "конструкт";
}

async function requestFirstAidSocket(action, payload = {}, gm = getResponsibleGM()) {
  if (!gm) throw new Error("нет активного GM");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingFirstAidSocketRequests.delete(requestId);
      reject(new Error("GM не ответил на запрос первой помощи"));
    }, FIRST_AID_SOCKET_TIMEOUT);
    pendingFirstAidSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(FIRST_AID_SOCKET, {
    scope: FIRST_AID_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleFirstAidSocketMessage(message = {}) {
  if (message?.scope !== FIRST_AID_SOCKET_SCOPE) return;

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingFirstAidSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingFirstAidSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "ошибка GM-сокета первой помощи"));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    const result = await handleFirstAidSocketRequest(message.action, message.payload ?? {});
    game.socket.emit(FIRST_AID_SOCKET, {
      scope: FIRST_AID_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | First aid socket request failed`, error);
    game.socket.emit(FIRST_AID_SOCKET, {
      scope: FIRST_AID_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

async function handleFirstAidSocketRequest(action, payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  if (!actor) throw new Error("цель не найдена");

  if (action === "getTargetContext") {
    const [sourceActor, sourceToken, targetToken] = await Promise.all([
      resolveFirstAidUuid(payload.sourceActorUuid),
      resolveFirstAidUuid(payload.sourceTokenUuid),
      resolveFirstAidUuid(payload.targetTokenUuid)
    ]);
    return {
      targetContext: {
        ...buildFirstAidTargetContext(actor, targetToken, {
          sourceActor,
          sourceToken,
          chanceOperationId: String(payload.chanceOperationId ?? "")
        }),
        name: String(payload.tokenName ?? "") || actor.name,
        tokenName: String(payload.tokenName ?? "")
      }
    };
  }

  throw new Error(`неизвестное действие первой помощи: ${action}`);
}

async function resolveFirstAidUuid(uuid = "") {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  try {
    return await fromUuid(value);
  } catch (_error) {
    return null;
  }
}

function getDocumentUuid(document = null) {
  return String(document?.document?.uuid ?? document?.uuid ?? "").trim();
}

function canUseActorLocally(actor) {
  return Boolean(game.user?.isGM || actor?.isOwner);
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

async function spendActionPointsIfNeeded(actor, firstAid = {}) {
  const cost = Math.max(0, toInteger(firstAid.actionPointCost));
  if (!cost || !isActorInActiveCombat(actor)) return true;
  if (!canSpendCombatActionPoints(actor, cost, { label: "первой помощи" })) return false;
  await spendCombatActionPoints(actor, cost);
  return true;
}

export function isTargetInFirstAidRange(sourceToken, targetToken, firstAid = {}, { warn = true } = {}) {
  const maxDistance = Number(firstAid.maxDistance) || 0;
  if (maxDistance <= 0 || !sourceToken || !targetToken || sourceToken === targetToken) return true;
  const distance = getTokenDistance(sourceToken, targetToken);
  if (distance <= maxDistance) return true;
  if (warn) ui.notifications.warn(`Цель слишком далеко (${Math.round(distance)}; максимум: ${maxDistance}).`);
  return false;
}

function getTokenDistance(leftToken, rightToken) {
  const leftDoc = leftToken?.document ?? leftToken;
  const rightDoc = rightToken?.document ?? rightToken;
  return measureTokenGridDistance(leftDoc, rightDoc);
}

function measureTokenGridDistance(leftDoc, rightDoc) {
  const grid = canvas?.grid;
  if (!leftDoc || !rightDoc || !grid) return Infinity;
  if (grid.isGridless) {
    return grid.measurePath([leftDoc.getCenterPoint(), rightDoc.getCenterPoint()]).distance;
  }

  const leftOffsets = leftDoc.getOccupiedGridSpaceOffsets();
  const rightOffsets = rightDoc.getOccupiedGridSpaceOffsets();
  let min = Infinity;
  for (const leftOffset of leftOffsets) {
    for (const rightOffset of rightOffsets) {
      const segmentDistance = grid.measurePath([
        grid.getCenterPoint(leftOffset),
        grid.getCenterPoint(rightOffset)
      ]).distance;
      if (segmentDistance < min) min = segmentDistance;
    }
  }
  return min;
}

async function applyCriticalFailureDamage(actor, firstAid = {}, source = {}) {
  const min = Math.max(0, toInteger(firstAid.criticalFailureDamageMin));
  const max = Math.max(min, toInteger(firstAid.criticalFailureDamageMax));
  const amount = min + Math.floor(Math.random() * ((max - min) + 1));
  if (!amount) return 0;
  await requestDamageApplication({
    actor,
    amount,
    damageTypeKey: "",
    mode: "damage",
    scope: "health",
    applyMitigation: false,
    processDamageTypeSettings: false,
    source: { ...source, criticalFailure: true }
  });
  return amount;
}

async function spendFirstAidItem(item, amount = 1, updateOptions = {}) {
  return commitInventoryItemConsumption({
    item,
    amount,
    charges: getFirstAidChargesData(item),
    chargePath: "system.functions.firstAid.charges.value",
    documentOptions: updateOptions,
    reason: "first-aid-consume"
  });
}

async function commitFirstAidActiveUsePreparations(preparations = [], operationId = "") {
  if (!preparations.length) return;
  try {
    await commitPreparedActiveUseOperations(preparations, { operationId });
  } catch (error) {
    console.error(`${SYSTEM_ID} | First-aid modifier active-use commit failed`, error);
  }
}

function createFirstAidDocumentOptions(chainRef = null) {
  return chainRef
    ? { chainRef, falloutMawSystemEventChainRef: chainRef }
    : {};
}

async function postFirstAidApplicationChat({
  sourceActor = null,
  targetActor = null,
  targetContext = null,
  item = null,
  firstAid = {},
  resultKey = "success",
  scaling = {},
  selectedLimbs = [],
  healing = 0,
  appliedLimbs = [],
  appliedNeeds = null,
  appliedDurationSeconds = 0,
  appliedWithdrawalDurationSeconds = 0,
  hasEffectRemoval = false,
  removeEffectDamageTypeKeys = [],
  removeEffectLimbKeys = [],
  criticalFailureDamage = 0,
  chargeCost = 1,
  showHealingEffectiveness = false
} = {}) {
  try {
    const pathLabels = new Map(buildEffectKeyTokens({ includePeriodicHealing: true })
      .filter(token => token?.path)
      .map(token => [token.path, token.label || token.path]));
    const needLabels = new Map(getNeedSettings().map(need => [need.key, need.label || need.key]));
    const limbLabels = new Map((targetContext?.limbs ?? []).map(limb => [
      String(limb?.key ?? ""),
      String(limb?.label ?? limb?.key ?? "")
    ]));
    const damageTypeLabels = new Map(getDamageTypeSettings().map(damageType => [
      damageType.key,
      damageType.label || damageType.key
    ]));
    const context = buildFirstAidApplicationCardContext({
      item,
      sourceActor,
      targetActor,
      targetName: targetContext?.name || targetContext?.tokenName || targetActor?.name,
      resultKey,
      resultLabel: getFirstAidResultLabel(resultKey),
      firstAid,
      scaling,
      healing,
      selectedLimbs,
      appliedLimbs,
      appliedNeeds,
      appliedDurationSeconds,
      appliedWithdrawalDurationSeconds,
      hasEffectRemoval,
      removeEffectDamageTypeKeys,
      removeEffectLimbKeys,
      criticalFailureDamage,
      spentCharges: chargeCost,
      showHealingEffectiveness,
      pathLabels,
      needLabels,
      limbLabels,
      damageTypeLabels,
      labels: {
        directHealing: game.i18n.localize("FALLOUTMAW.Item.FirstAidChatDirectHealing"),
        periodicHealing: game.i18n.localize("FALLOUTMAW.Item.FirstAidHealingPerTick"),
        limbs: game.i18n.localize("FALLOUTMAW.Item.FirstAidLimbs"),
        needs: game.i18n.localize("FALLOUTMAW.Item.FirstAidNeeds"),
        effectRemoval: game.i18n.localize("FALLOUTMAW.Item.FirstAidRemoveEffects"),
        criticalFailureDamage: game.i18n.localize("FALLOUTMAW.Item.FirstAidChatCriticalFailureDamage"),
        notApplied: "—",
        zeroDuration: game.i18n.localize("FALLOUTMAW.Item.FirstAidChatZeroDuration")
      }
    });
    const content = await foundry.applications.handlebars.renderTemplate(TEMPLATES.firstAidChatCard, context);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: sourceActor }),
      content,
      sound: null,
      flags: {
        [SYSTEM_ID]: {
          firstAidCard: {
            itemUuid: String(item?.uuid ?? ""),
            targetActorUuid: String(targetActor?.uuid ?? ""),
            resultKey: String(resultKey ?? ""),
            effectiveness: String(context.effectiveness ?? ""),
            duration: String(context.duration?.applied ?? ""),
            spentCharges: Math.max(1, toInteger(chargeCost))
          }
        }
      }
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | First-aid chat card failed`, error);
  }
}

function getFirstAidResultLabel(resultKey = "") {
  const key = {
    criticalSuccess: "CriticalSuccess",
    success: "Success",
    failure: "Failure",
    criticalFailure: "CriticalFailure"
  }[resultKey] ?? "Success";
  return game.i18n.localize(`FALLOUTMAW.SkillCheck.${key}`);
}
