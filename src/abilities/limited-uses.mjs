import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  isAbilityFunctionTimedTriggerCost,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { isDeusExMachinaProgressItemUpdate } from "./deus-ex-machina-progress-runtime.mjs";
import { getOriginalEffectKeyFromReverse } from "../utils/active-effect-keys.mjs";
import {
  normalizeAttackDistanceMeters,
  normalizeAttackEffectiveRange
} from "../utils/attack-distance.mjs";
import { getActorItemsWithActiveHudModules } from "../utils/hud-active-items.mjs";
import {
  registerSystemEventObserver,
  registerSystemEventRootFinalizer
} from "../events/dispatcher.mjs";
import {
  getWeaponAttackData,
  registerWeaponAttackResolvedHandler
} from "../combat/weapon-attack-controller.mjs";
import {
  getDamageResolutionActiveUseKeys,
  getHealingResolutionActiveUseKeys,
  getInitiativeActiveUseKeys,
  getSkillCheckActiveUseKeys,
  getWeaponActionActiveUseKeys,
  isWeaponContextSkillCheckRequester
} from "./active-use-keys.mjs";
import { isConsumableActiveUseChange } from "./active-use-changes.mjs";
import { getAuraGeneratedEffectFlag } from "./aura-conditions.mjs";
import {
  EFFECT_LIFECYCLE_FLAG_KEY,
  EFFECT_LIFECYCLE_KINDS,
  getEffectFunctionDescriptor
} from "./effect-lifecycle.mjs";
import { syncActorAbilityEffects, syncAuraGeneratedEffects } from "./effects.mjs";
import { getActiveUseOperationId, registerActiveUseRuntimeHandler } from "./active-use-runtime.mjs";
import { getConditionalFunctionChanges, getLateAuraContextualChanges } from "./evaluation.mjs";
import {
  getLimitedUseConditionState,
  getLimitedUseConditions,
  hasExhaustedLimitedUses
} from "./limited-uses-state.mjs";

const LIMITED_USE_UPDATE_OPTION = "falloutMawLimitedUses";
const MAX_RETAINED_OPERATION_CLAIMS = 256;
const LIMITED_USE_SOCKET = `system.${SYSTEM_ID}`;
const LIMITED_USE_ATTACK_REQUEST = "limitedUses.weaponAttack.request";
const LIMITED_USE_ATTACK_RESPONSE = "limitedUses.weaponAttack.response";
const LIMITED_USE_CANDIDATES_REQUEST = "limitedUses.candidates.request";
const LIMITED_USE_CANDIDATES_RESPONSE = "limitedUses.candidates.response";
const LIMITED_USE_SOCKET_TIMEOUT_MS = 15000;
const documentMutationQueues = new Map();
const operationClaims = new Map();
const actorLimitedUseIndexes = new WeakMap();
const pendingRootUses = new Map();
const pendingEventUseCaptures = new Map();
const pendingWeaponActionCaptures = new Map();
const pendingSocketRequests = new Map();
let hooksRegistered = false;
let socketRegistered = false;

/** Register only terminal semantic events; previews and value reads never spend uses. */
export function registerLimitedUseHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  registerActiveUseRuntimeHandler("fallout-maw.limitedUses", {
    prepare: context => {
      const candidates = captureActorLimitedUseCandidates(
        context?.actor,
        context?.keys,
        context?.conditionContexts ?? [],
        Boolean(context?.reverseOnly)
      );
      return candidates.length ? candidates : null;
    },
    commit: (captures, context) => consumeCapturedLimitedUseCandidates(
      captures.flat(),
      String(context?.operationId ?? "").trim()
        || buildOperationId("active-use", foundry.utils.randomID())
    )
  });

  Hooks.on("fallout-maw.weaponActionWillResolve", captureLimitedUsesBeforeWeaponAction);
  for (const hookName of ["createItem", "deleteItem", "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(hookName, document => invalidateActorLimitedUseIndex(document?.parent));
  }
  Hooks.on("updateItem", (item, changes = {}, options = {}) => {
    if (!isDeusExMachinaProgressItemUpdate(changes, options)) {
      invalidateActorLimitedUseIndex(item?.parent);
    }
  });
  registerWeaponAttackResolvedHandler("fallout-maw.limitedUses", consumeLimitedUsesForWeaponAttack);
  registerSystemEventObserver({
    id: "fallout-maw.limitedUses.resolvedOperations",
    eventKeys: [
      "fallout-maw.skill.check.beforeRoll",
      "fallout-maw.skill.check.committed",
      "fallout-maw.skill.check.resolved",
      "fallout-maw.damage.beforeApply",
      "fallout-maw.damage.resolved",
      "fallout-maw.healing.beforeApply",
      "fallout-maw.healing.resolved",
      "fallout-maw.initiative.roll.beforeRoll",
      "fallout-maw.initiative.roll.resolved"
    ],
    priority: 250,
    observe: observeLimitedUseResolvedOperation
  });
  registerSystemEventRootFinalizer({
    id: "fallout-maw.limitedUses.commitResolvedOperations",
    priority: 250,
    finalize: commitPendingRootUses
  });
}

export function registerLimitedUseSocket() {
  if (socketRegistered) return;
  socketRegistered = true;
  game.socket.on(LIMITED_USE_SOCKET, handleLimitedUseSocketMessage);
}

async function observeLimitedUseResolvedOperation(context = {}) {
  const eventKey = String(context?.event?.key ?? "");
  if (eventKey.endsWith(".beforeRoll") || eventKey.endsWith(".beforeApply")) {
    return captureLimitedUsesBeforeOperation(context);
  }
  if (eventKey === "fallout-maw.skill.check.committed") {
    return consumeLimitedUsesForSkillEvent(context);
  }
  if (eventKey === "fallout-maw.skill.check.resolved") return [];
  if (eventKey === "fallout-maw.initiative.roll.resolved") {
    return consumeLimitedUsesForInitiativeEvent(context);
  }
  return consumeLimitedUsesForDamageEvent(context);
}

async function captureLimitedUsesBeforeOperation({ event } = {}) {
  if (String(event?.key ?? "") === "fallout-maw.skill.check.beforeRoll") {
    return captureLimitedUsesBeforeSkillCheck(event);
  }
  if (String(event?.key ?? "") === "fallout-maw.initiative.roll.beforeRoll") {
    return captureLimitedUsesBeforeInitiative(event);
  }
  return captureLimitedUsesBeforeDamage(event);
}

async function captureLimitedUsesBeforeInitiative(event = {}) {
  const actor = await resolveUuid(String(event?.source?.actorUuid ?? event?.data?.actorUuid ?? "").trim());
  if (!actor) {
    storeEventUseCapture(event, []);
    return [];
  }
  const actorToken = await resolveUuid(String(event?.source?.tokenUuid ?? event?.data?.tokenUuid ?? "").trim());
  const conditionContext = buildConditionContext({
    actorToken,
    requester: "initiative",
    chanceOperationId: getActiveUseOperationId(event?.data, getEventOccurrenceBase(event))
  });
  const captures = captureActorLimitedUseCandidates(actor, getInitiativeActiveUseKeys({
    formula: event?.data?.requestedFormula
  }), [conditionContext], false);
  storeEventUseCapture(event, captures);
  return captures;
}

async function consumeLimitedUsesForInitiativeEvent({ event } = {}) {
  const captured = takeEventUseCapture(event);
  if (!event?.outcome?.success || event?.outcome?.cancelled || captured === null) return [];
  return consumeCapturedLimitedUseCandidates(
    captured,
    buildOperationId("initiative", getEventOccurrenceBase(event))
  );
}

function captureLimitedUsesBeforeWeaponAction(context = {}) {
  if (context?.actionPointCostApplied !== true) return;
  const actor = context?.actor ?? null;
  const actionKey = String(context?.actionKey ?? "").trim();
  if (!actor || !actionKey) return;
  const operationId = getWeaponAttackOperationId(context);
  const conditionContext = buildConditionContext({
    actorToken: context?.actorToken ?? context?.token ?? null,
    weaponData: context?.weaponData,
    attackDistanceMeters: context?.attackDistanceMeters,
    effectiveRange: context?.effectiveRange,
    weaponActionKey: actionKey,
    requester: "weaponAttack",
    chanceOperationId: getActiveUseOperationId(context, operationId)
  });
  const keys = getWeaponActionActiveUseKeys({
    ...conditionContext,
    actor,
    actionKey,
    activeUseStages: { action: true }
  });
  const candidates = captureActorLimitedUseCandidates(actor, keys, [conditionContext], false)
    .map(serializeCapturedCandidate)
    .filter(Boolean);
  mergeWeaponUseCaptures(operationId, candidates);
}

async function captureLimitedUsesBeforeSkillCheck(event = {}) {
  const data = event?.data ?? {};
  const request = data?.request && typeof data.request === "object" ? data.request : {};
  const skillKey = String(data?.skill?.key ?? "").trim();
  const actor = await resolveUuid(String(event?.source?.actorUuid ?? "").trim());
  if (!actor || !skillKey) {
    storeEventUseCapture(event, []);
    return [];
  }
  const [actorToken, targetToken, targetActor] = await Promise.all([
    resolveUuid(String(event?.source?.tokenUuid ?? "").trim()),
    resolveUuid(String(event?.target?.tokenUuid ?? "").trim()),
    resolveUuid(String(event?.target?.actorUuid ?? "").trim())
  ]);
  const conditionContext = buildConditionContext({
    actorToken,
    targetToken,
    targetActor,
    skillKey,
    weaponData: request.weaponData,
    attackDistanceMeters: request.attackDistanceMeters,
    effectiveRange: request.effectiveRange,
    weaponActionKey: request.weaponActionKey,
    requester: request.requester,
    chanceOperationId: request.chanceOperationId
  });
  const keys = isWeaponContextSkillCheckRequester(request.requester)
    ? getWeaponActionActiveUseKeys({
      ...conditionContext,
      actor,
      actionKey: request.weaponActionKey,
      activeUseStages: { check: true }
    })
    : getSkillCheckActiveUseKeys(skillKey, request);
  const captures = captureActorLimitedUseCandidates(actor, keys, [conditionContext], false);
  if (targetActor && targetActor.uuid !== actor.uuid) {
    captures.push(...captureActorLimitedUseCandidates(
      targetActor,
      keys,
      [reverseInteractionContext(conditionContext, actor, actorToken, targetToken)],
      true
    ));
  }
  storeEventUseCapture(event, captures);
  return captures;
}

async function captureLimitedUsesBeforeDamage(event = {}) {
  const data = event?.data ?? {};
  const targetActor = await resolveUuid(String(data?.actorUuid ?? event?.target?.actorUuid ?? "").trim());
  if (!targetActor || !(Number(data?.amount) > 0)) {
    storeEventUseCapture(event, []);
    return [];
  }
  const sourceData = data?.source && typeof data.source === "object" ? data.source : {};
  const chanceOperationId = firstText(
    sourceData.attackId,
    sourceData.limitedUseOperationId,
    data.chanceOperationId,
    data.damageHubOperationRef,
    event?.operationId,
    event?.eventId,
    event?.rootId
  );
  const sourceActorUuid = firstText(
    sourceData.attackerActorUuid,
    sourceData.attackerUuid,
    sourceData.sourceActorUuid,
    sourceData.actorUuid,
    event?.source?.actorUuid
  );
  const [sourceActor, targetToken, sourceToken] = await Promise.all([
    resolveUuid(sourceActorUuid),
    resolveUuid(firstText(sourceData.targetTokenUuid, event?.target?.tokenUuid)),
    resolveUuid(firstText(
      sourceData.attackerTokenUuid,
      sourceData.sourceTokenUuid,
      sourceData.tokenUuid,
      event?.source?.tokenUuid
    ))
  ]);
  const actionKey = String(sourceData?.actionKey ?? "").trim();
  let weaponData = sourceData?.weaponData && typeof sourceData.weaponData === "object"
    ? sourceData.weaponData
    : null;
  let weapon = null;
  if (!weaponData && actionKey && String(sourceData?.weaponUuid ?? "").trim()) {
    weapon = await resolveUuid(String(sourceData.weaponUuid).trim());
    weaponData = weapon
      ? getWeaponAttackData(weapon, String(sourceData?.weaponFunctionId ?? ""))
      : null;
  }
  const targetContext = buildConditionContext({
    actorToken: targetToken,
    targetActor: sourceActor,
    targetToken: sourceToken,
    weaponData,
    attackDistanceMeters: sourceData.attackDistanceMeters,
    effectiveRange: sourceData.effectiveRange,
    weaponActionKey: actionKey,
    requester: actionKey ? "weaponAttack" : "",
    chanceOperationId
  });
  const captures = [];

  if (String(event?.key ?? "") === "fallout-maw.healing.beforeApply") {
    captures.push(...captureActorLimitedUseCandidates(
      targetActor,
      getHealingResolutionActiveUseKeys({ direction: "incoming" }),
      [targetContext],
      false
    ));
    if (sourceActor && sourceData?.limitedUseSkipOutgoing !== true) {
      captures.push(...captureActorLimitedUseCandidates(
        sourceActor,
        getHealingResolutionActiveUseKeys({ direction: "outgoing" }),
        [reverseInteractionContext(targetContext, targetActor, targetToken)],
        false
      ));
    }
    storeEventUseCapture(event, captures);
    return captures;
  }

  captures.push(...captureActorLimitedUseCandidates(targetActor, getDamageResolutionActiveUseKeys({
    actor: targetActor,
    limbKey: data?.limbKey,
    damageTypeKey: data?.damageTypeKey,
    includeMitigation: data?.applyMitigation !== false,
    includeBarriers: data?.bypassBarrier !== true
  }), [targetContext], false));

  if (sourceActor && actionKey) {
    const sourceContext = buildConditionContext({
      actorToken: sourceToken,
      targetActor,
      targetToken,
      weaponData,
      attackDistanceMeters: sourceData.attackDistanceMeters,
      effectiveRange: sourceData.effectiveRange,
      weaponActionKey: actionKey,
      requester: "weaponAttack",
      criticalSuccess: sourceData.criticalSuccess === true,
      chanceOperationId
    });
    const damageKeys = getWeaponActionActiveUseKeys({
      ...sourceContext,
      actor: sourceActor,
      actionKey,
      activeUseStages: { damage: true }
    });
    captures.push(...captureActorLimitedUseCandidates(sourceActor, damageKeys, [sourceContext], false));
    if (targetActor.uuid !== sourceActor.uuid) {
      captures.push(...captureActorLimitedUseCandidates(
        targetActor,
        damageKeys,
        [reverseInteractionContext(sourceContext, sourceActor, sourceToken, targetToken)],
        true
      ));
    }
  }
  storeEventUseCapture(event, captures);
  return captures;
}

export async function consumeLimitedUsesForSkillEvent({ event } = {}) {
  const captured = takeEventUseCapture(event);
  if (!event?.outcome?.success || event?.outcome?.cancelled) return [];
  if (captured !== null) {
    const weaponAttackId = String(event?.data?.weaponAttackId ?? "").trim();
    if (weaponAttackId) {
      mergeWeaponUseCaptures(buildOperationId("attack", weaponAttackId), captured);
      return [];
    }
    return consumeCapturedLimitedUseCandidates(
      captured,
      String(event?.data?.limitedUseOperationId ?? "").trim()
        || buildOperationId("skill", getEventOccurrenceBase(event))
    );
  }
  const data = event?.data ?? {};
  const actor = await resolveUuid(String(event?.source?.actorUuid ?? "").trim());
  const skillKey = String(data?.skillKey ?? "").trim();
  if (!canMutateActor(actor) || !skillKey) return [];

  const [actorToken, targetToken, targetActor] = await Promise.all([
    resolveUuid(String(event?.source?.tokenUuid ?? "").trim()),
    resolveUuid(String(event?.target?.tokenUuid ?? "").trim()),
    resolveUuid(String(event?.target?.actorUuid ?? "").trim())
  ]);
  const conditionContext = buildConditionContext({
    actorToken,
    targetToken,
    targetActor,
    skillKey,
    attackDistanceMeters: data?.attackDistanceMeters,
    effectiveRange: data?.effectiveRange,
    requester: data?.requester,
    weaponActionKey: data?.weaponActionKey
  });
  const keys = getSkillCheckActiveUseKeys(skillKey, {
    requester: data?.requester,
    weaponActionKey: data?.weaponActionKey
  });
  return consumeInteractionLimitedUses(actor, keys, {
    operationId: buildOperationId("skill", event?.eventId),
    conditionContexts: [conditionContext],
    targetActor: conditionContext.targetActor,
    targetToken: conditionContext.targetToken,
    actorToken: conditionContext.actorToken
  });
}

export async function consumeLimitedUsesForWeaponAttack(context = {}) {
  const payload = serializeWeaponAttackUseContext(context);
  if (!payload.attackerUuid || !payload.actionKey) return [];

  const activeGM = game.users?.activeGM ?? null;
  if (!game.user?.isGM && activeGM?.id) {
    return requestWeaponAttackUseAuthority(payload, activeGM);
  }
  return consumeLimitedUsesForWeaponAttackDirect(payload);
}

async function consumeLimitedUsesForWeaponAttackDirect(context = {}) {
  const actorUuid = String(context?.attackerUuid ?? context?.actorUuid ?? "").trim();
  const actionKey = String(context?.actionKey ?? "").trim();
  if (!actorUuid || !actionKey) return [];

  const actor = await resolveUuid(actorUuid);
  if (!canMutateActor(actor)) return [];
  const weapon = await resolveUuid(String(context?.weaponUuid ?? "").trim());
  const weaponData = weapon
    ? getWeaponAttackData(weapon, String(context?.weaponFunctionId ?? ""))
    : context?.weaponData && typeof context.weaponData === "object" ? context.weaponData : null;
  const actorToken = await resolveUuid(String(context?.tokenUuid ?? "").trim());
  const operationId = getWeaponAttackOperationId(context);
  const authorityCandidates = pendingWeaponActionCaptures.get(operationId) ?? [];
  pendingWeaponActionCaptures.delete(operationId);
  if (context?.actionUseCaptured === true || authorityCandidates.length) {
    const merged = new Map();
    for (const candidate of [
      ...(Array.isArray(context?.actionUseCandidates) ? context.actionUseCandidates : []),
      ...authorityCandidates
    ]) {
      const identity = getCapturedCandidateIdentity(candidate);
      if (identity) merged.set(identity, candidate);
    }
    return consumeCapturedLimitedUseCandidates(
      Array.from(merged.values()),
      operationId
    );
  }
  if (context?.actionPointCostApplied !== true) return [];
  const conditionContext = buildConditionContext({
    actorToken,
    weaponData,
    attackDistanceMeters: context?.attackDistanceMeters,
    effectiveRange: context?.effectiveRange,
    weaponActionKey: actionKey,
    requester: "weaponAttack"
  });
  const keys = getWeaponActionActiveUseKeys({
    ...context,
    actor,
    weaponData,
    weaponActionKey: actionKey,
    requester: "weaponAttack",
    activeUseStages: { action: true }
  });
  return consumeActorLimitedUses(actor, keys, {
    operationId,
    conditionContexts: [conditionContext],
    reverseOnly: false
  });
}

async function consumeLimitedUsesForDamageEvent({ event } = {}) {
  const captured = takeEventUseCapture(event);
  if (!event?.outcome?.success || event?.outcome?.cancelled) return [];
  const data = event?.data ?? {};
  if (!(Number(data?.amount) > 0)) return [];
  if (captured !== null) {
    const attackId = String(data?.source?.attackId ?? "").trim();
    if (attackId) {
      mergeWeaponUseCaptures(buildOperationId("attack", attackId), captured);
      return [];
    }
    return consumeCapturedLimitedUseCandidates(
      captured,
      buildOperationId(
        "application",
        String(data?.source?.limitedUseOperationId ?? event?.rootId ?? "").trim()
          || getEventOccurrenceBase(event)
      )
    );
  }
  const targetActor = await resolveUuid(String(data?.actorUuid ?? "").trim());
  if (!canMutateActor(targetActor)) return [];

  const sourceData = data?.source && typeof data.source === "object" ? data.source : {};
  const sourceActorUuid = String(
    sourceData?.attackerActorUuid
    ?? sourceData?.attackerUuid
    ?? sourceData?.sourceActorUuid
    ?? sourceData?.actorUuid
    ?? ""
  ).trim();
  const sourceActor = sourceActorUuid ? await resolveUuid(sourceActorUuid) : null;
  const targetToken = await resolveUuid(String(sourceData?.targetTokenUuid ?? "").trim());
  const sourceToken = await resolveUuid(String(
    sourceData?.attackerTokenUuid
    ?? sourceData?.sourceTokenUuid
    ?? sourceData?.tokenUuid
    ?? ""
  ).trim());
  const context = buildConditionContext({
    actorToken: targetToken,
    targetActor: sourceActor,
    targetToken: sourceToken
  });
  const rootId = String(event?.rootId ?? "").trim();
  const attackId = String(sourceData?.attackId ?? "").trim();
  const operationId = attackId
    ? buildOperationId("attack", attackId)
    : buildOperationId(
      String(event?.key ?? "").includes("healing") ? "healing" : "damage",
      String(event?.operationId ?? rootId ?? event?.eventId ?? "").trim()
    );

  if (String(event?.key ?? "") === "fallout-maw.healing.resolved") {
    const operations = [queuePendingRootUse(rootId, targetActor, getHealingResolutionActiveUseKeys({
      direction: "incoming"
    }), {
      operationId,
      conditionContexts: [context],
      reverseOnly: false
    })];
    if (sourceActor && canMutateActor(sourceActor)) {
      operations.push(queuePendingRootUse(rootId, sourceActor, getHealingResolutionActiveUseKeys({
        direction: "outgoing"
      }), {
        operationId,
        conditionContexts: [reverseInteractionContext(context, targetActor, targetToken)],
        reverseOnly: false
      }));
    }
    await Promise.all(operations);
    return [];
  }

  const keys = getDamageResolutionActiveUseKeys({
    actor: targetActor,
    limbKey: data?.limbKey,
    damageTypeKey: data?.damageTypeKey,
    includeMitigation: data?.applyMitigation !== false,
    includeBarriers: data?.bypassBarrier !== true
  });
  if (!keys.size) return [];
  await queuePendingRootUse(rootId, targetActor, keys, {
    operationId,
    conditionContexts: [context],
    reverseOnly: false
  });
  return [];
}

function storeEventUseCapture(event = {}, candidates = []) {
  const rootId = String(event?.rootId ?? "").trim();
  const occurrence = getEventOccurrenceBase(event);
  if (!rootId || !occurrence) return;
  const rootCaptures = pendingEventUseCaptures.get(rootId) ?? new Map();
  rootCaptures.set(occurrence, Array.from(candidates ?? []));
  pendingEventUseCaptures.set(rootId, rootCaptures);
}

function takeEventUseCapture(event = {}) {
  const rootId = String(event?.rootId ?? "").trim();
  const occurrence = getEventOccurrenceBase(event);
  const rootCaptures = pendingEventUseCaptures.get(rootId);
  if (!rootCaptures?.has(occurrence)) return null;
  const captured = rootCaptures.get(occurrence) ?? [];
  rootCaptures.delete(occurrence);
  if (!rootCaptures.size) pendingEventUseCaptures.delete(rootId);
  return captured;
}

function getEventOccurrenceBase(event = {}) {
  return String(event?.occurrenceKey ?? "").trim().replace(/:(?:before|committed|resolved)$/, "");
}

function mergeWeaponUseCaptures(operationId = "", candidates = []) {
  const identity = String(operationId ?? "").trim();
  if (!identity) return;
  const merged = new Map((pendingWeaponActionCaptures.get(identity) ?? [])
    .map(candidate => [getCapturedCandidateIdentity(candidate), candidate])
    .filter(([key]) => key));
  for (const candidate of candidates ?? []) {
    const key = getCapturedCandidateIdentity(candidate);
    if (key) merged.set(key, serializeCapturedCandidate(candidate) ?? candidate);
  }
  pendingWeaponActionCaptures.set(identity, Array.from(merged.values()));
  while (pendingWeaponActionCaptures.size > 64) {
    pendingWeaponActionCaptures.delete(pendingWeaponActionCaptures.keys().next().value);
  }
}

function queuePendingRootUse(rootId = "", actor = null, keys = new Set(), {
  operationId = "",
  conditionContexts = [],
  reverseOnly = false
} = {}) {
  const rootIdentity = String(rootId ?? "").trim();
  if (!rootIdentity) {
    return consumeActorLimitedUses(actor, keys, { operationId, conditionContexts, reverseOnly });
  }
  if (!canMutateActor(actor) || !(keys instanceof Set) || !keys.size) return Promise.resolve([]);

  const actorIdentity = String(actor.uuid ?? actor.id ?? "").trim();
  if (!actorIdentity) return Promise.resolve([]);
  const operationIdentity = String(operationId ?? "").trim() || buildOperationId("root", rootIdentity);
  const rootEntries = pendingRootUses.get(rootIdentity) ?? new Map();
  const entryIdentity = `${operationIdentity}:${actorIdentity}:${reverseOnly ? "reverse" : "direct"}`;
  const entry = rootEntries.get(entryIdentity) ?? {
    actor,
    keys: new Set(),
    operationId: operationIdentity,
    reverseOnly: Boolean(reverseOnly),
    contexts: new Map()
  };
  for (const key of keys) entry.keys.add(key);
  for (const context of conditionContexts.length ? conditionContexts : [{}]) {
    entry.contexts.set(getConditionContextIdentity(context), context);
  }
  rootEntries.set(entryIdentity, entry);
  pendingRootUses.set(rootIdentity, rootEntries);
  return Promise.resolve([]);
}

async function commitPendingRootUses({ rootId = "" } = {}) {
  const rootIdentity = String(rootId ?? "").trim();
  const entries = pendingRootUses.get(rootIdentity);
  pendingRootUses.delete(rootIdentity);
  pendingEventUseCaptures.delete(rootIdentity);
  const operations = entries?.size
    ? Array.from(entries.values(), entry => consumeActorLimitedUses(entry.actor, entry.keys, {
      operationId: entry.operationId,
      conditionContexts: Array.from(entry.contexts.values()),
      reverseOnly: entry.reverseOnly
    }))
    : [];
  if (!operations.length) return [];
  return (await Promise.all(operations)).flat();
}

async function consumeInteractionLimitedUses(actor, keys, {
  operationId = "",
  conditionContexts = [],
  targetActor = null,
  targetToken = null,
  actorToken = null
} = {}) {
  const operations = [consumeActorLimitedUses(actor, keys, {
    operationId,
    conditionContexts,
    reverseOnly: false
  })];
  if (targetActor && targetActor.uuid !== actor.uuid && canMutateActor(targetActor)) {
    const context = conditionContexts[0] ?? {};
    operations.push(consumeActorLimitedUses(targetActor, keys, {
      operationId,
      conditionContexts: [reverseInteractionContext(context, actor, actorToken, targetToken)],
      reverseOnly: true
    }));
  }
  return (await Promise.all(operations)).flat();
}

async function consumeActorLimitedUses(actor, keys, {
  operationId = "",
  conditionContexts = [],
  reverseOnly = false
} = {}) {
  if (!canMutateActor(actor) || !(keys instanceof Set) || !keys.size) return [];
  const contexts = conditionContexts.length ? conditionContexts : [{}];
  const operations = [];

  for (const { item, functionIds } of findTriggeredSourceItemFunctions(actor, keys, contexts, reverseOnly)) {
    operations.push(consumeSourceItemFunctionUses(item, functionIds, operationId));
  }

  for (const effect of getActorLimitedUseIndex(actor).effects) {
    if (effect?.disabled || effect?.active === false) continue;
    const lifecycleKind = String(effect.getFlag?.(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind ?? "");
    if (![
      EFFECT_LIFECYCLE_KINDS.disposableInstance,
      EFFECT_LIFECYCLE_KINDS.reconciledInstance
    ].includes(lifecycleKind)) continue;
    const descriptor = getEffectFunctionDescriptor(effect);
    if (!descriptor || !getLimitedUseConditions(descriptor.functionData?.conditions).length) continue;
    const triggered = lifecycleKind === EFFECT_LIFECYCLE_KINDS.reconciledInstance
      ? hasTriggeredReconciledEffectChange(actor, effect, keys, contexts, reverseOnly)
      : hasTriggeredChange(actor, effect.system?.changes, keys, reverseOnly);
    if (!triggered) continue;

    if (lifecycleKind === EFFECT_LIFECYCLE_KINDS.disposableInstance) {
      operations.push(consumeDisposableEffectUse(effect, keys, reverseOnly, operationId));
    } else {
      operations.push(consumeReconciledEffectSourceUse(effect, descriptor, operationId));
    }
  }

  return (await Promise.all(operations)).filter(Boolean);
}

function captureActorLimitedUseCandidates(actor, keys, contexts = [], reverseOnly = false) {
  if (!actor || !(keys instanceof Set) || !keys.size) return [];
  const resolvedContexts = contexts.length ? contexts : [{}];
  const candidates = [];
  for (const { item, functionIds } of findTriggeredSourceItemFunctions(
    actor,
    keys,
    resolvedContexts,
    reverseOnly
  )) {
    for (const functionId of functionIds) {
      candidates.push({
        kind: "sourceItem",
        item,
        itemUuid: String(item?.uuid ?? ""),
        hostActorUuid: String(actor?.uuid ?? ""),
        functionId: String(functionId ?? "")
      });
    }
  }
  for (const effect of getActorLimitedUseIndex(actor).effects) {
    if (effect?.disabled || effect?.active === false) continue;
    const lifecycleKind = String(effect.getFlag?.(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind ?? "");
    if (![
      EFFECT_LIFECYCLE_KINDS.disposableInstance,
      EFFECT_LIFECYCLE_KINDS.reconciledInstance
    ].includes(lifecycleKind)) continue;
    const descriptor = getEffectFunctionDescriptor(effect);
    if (!descriptor || !getLimitedUseConditions(descriptor.functionData?.conditions).length) continue;
    const triggered = lifecycleKind === EFFECT_LIFECYCLE_KINDS.reconciledInstance
      ? hasTriggeredReconciledEffectChange(actor, effect, keys, resolvedContexts, reverseOnly)
      : hasTriggeredChange(actor, effect.system?.changes, keys, reverseOnly);
    if (!triggered) continue;
    if (lifecycleKind === EFFECT_LIFECYCLE_KINDS.disposableInstance) {
      candidates.push({
        kind: "disposableEffect",
        effect,
        effectUuid: String(effect.uuid ?? ""),
        hostActorUuid: String(actor?.uuid ?? "")
      });
      continue;
    }
    candidates.push({
      kind: "reconciledSource",
      hostActorUuid: String(actor?.uuid ?? ""),
      hostEffectUuid: String(effect?.uuid ?? ""),
      sourceItemUuid: String(descriptor.data?.sourceItemUuid ?? ""),
      sourceActorUuid: String(descriptor.data?.sourceActorUuid ?? ""),
      sourceItemId: String(descriptor.data?.itemId ?? descriptor.data?.sourceItemId ?? ""),
      functionId: String(descriptor.data?.functionId ?? descriptor.functionData?.id ?? "")
    });
  }
  return candidates;
}

function getCapturedCandidateIdentity(candidate = {}) {
  if (candidate.kind === "sourceItem") {
    return `Item:${String(candidate.itemUuid ?? candidate.item?.uuid ?? "")}:${String(candidate.functionId ?? "")}`;
  }
  if (candidate.kind === "disposableEffect") {
    return `ActiveEffect:${String(candidate.effectUuid ?? candidate.effect?.uuid ?? "")}`;
  }
  if (candidate.kind === "reconciledSource") {
    return `Reconciled:${String(candidate.sourceItemUuid ?? candidate.sourceActorUuid ?? "")}:${String(
      candidate.sourceItemId ?? ""
    )}:${String(candidate.functionId ?? "")}`;
  }
  return "";
}

function serializeCapturedCandidate(candidate = {}) {
  if (candidate.kind === "sourceItem") {
    return {
      kind: "sourceItem",
      itemUuid: String(candidate.itemUuid ?? candidate.item?.uuid ?? ""),
      hostActorUuid: String(candidate.hostActorUuid ?? candidate.item?.parent?.uuid ?? ""),
      functionId: String(candidate.functionId ?? "")
    };
  }
  if (candidate.kind === "disposableEffect") {
    return {
      kind: "disposableEffect",
      effectUuid: String(candidate.effectUuid ?? candidate.effect?.uuid ?? ""),
      hostActorUuid: String(candidate.hostActorUuid ?? candidate.effect?.parent?.uuid ?? "")
    };
  }
  if (candidate.kind === "reconciledSource") {
    return {
      kind: "reconciledSource",
      hostActorUuid: String(candidate.hostActorUuid ?? ""),
      hostEffectUuid: String(candidate.hostEffectUuid ?? ""),
      sourceItemUuid: String(candidate.sourceItemUuid ?? ""),
      sourceActorUuid: String(candidate.sourceActorUuid ?? ""),
      sourceItemId: String(candidate.sourceItemId ?? ""),
      functionId: String(candidate.functionId ?? "")
    };
  }
  return null;
}

async function consumeCapturedLimitedUseCandidates(candidates = [], operationId = "") {
  const serialized = Array.from(candidates ?? [], serializeCapturedCandidate).filter(Boolean);
  if (!serialized.length) return [];
  const activeGM = game.users?.activeGM ?? null;
  if (!game.user?.isGM && activeGM?.id) {
    return requestCapturedUseAuthority(serialized, operationId, activeGM);
  }
  return consumeCapturedLimitedUseCandidatesDirect(candidates, operationId);
}

async function consumeCapturedLimitedUseCandidatesDirect(candidates = [], operationId = "") {
  const sourceFunctions = new Map();
  const disposableEffects = [];
  for (const candidate of candidates ?? []) {
    if (candidate?.kind === "disposableEffect") {
      disposableEffects.push(candidate);
      continue;
    }
    let item = candidate?.item ?? null;
    if (!item && candidate?.itemUuid) item = await resolveUuid(candidate.itemUuid);
    if (!item && candidate?.sourceItemUuid) item = await resolveUuid(candidate.sourceItemUuid);
    if (!item && candidate?.sourceActorUuid) {
      const sourceActor = await resolveUuid(candidate.sourceActorUuid);
      item = sourceActor?.items?.get?.(String(candidate.sourceItemId ?? "")) ?? null;
    }
    const functionId = String(candidate?.functionId ?? "").trim();
    const itemIdentity = String(item?.uuid ?? item?.id ?? "").trim();
    if (!item || !functionId || !itemIdentity) continue;
    const entry = sourceFunctions.get(itemIdentity) ?? { item, functionIds: new Set() };
    entry.functionIds.add(functionId);
    sourceFunctions.set(itemIdentity, entry);
  }

  const operations = Array.from(sourceFunctions.values(), entry => (
    consumeSourceItemFunctionUses(entry.item, entry.functionIds, operationId)
  ));
  for (const candidate of disposableEffects) {
    const effect = candidate.effect
      ?? await resolveUuid(String(candidate.effectUuid ?? "").trim());
    if (!effect) continue;
    operations.push(consumeDisposableEffectUse(effect, new Set(), false, operationId, { captured: true }));
  }
  return (await Promise.all(operations)).filter(Boolean);
}

function findTriggeredSourceItemFunctions(actor, keys, contexts, reverseOnly) {
  const candidates = [];
  for (const { item, functions } of getActorLimitedUseIndex(actor).sourceItems) {
    const functionIds = new Set();
    for (const abilityFunction of functions) {
      if (hasExhaustedLimitedUses(abilityFunction.conditions)) continue;
      const triggered = contexts.some(context => {
        const changes = getConditionalFunctionChanges(actor, abilityFunction, {
          ...context,
          abilityItemId: item.id,
          functionId: abilityFunction.id,
          allowContextual: true
        });
        return hasTriggeredChange(actor, changes, keys, reverseOnly);
      });
      if (triggered) functionIds.add(String(abilityFunction.id ?? ""));
    }
    if (functionIds.size) candidates.push({ item, functionIds });
  }
  return candidates;
}

function getActorLimitedUseIndex(actor = null) {
  if (!actor || typeof actor !== "object") return { sourceItems: [], effects: [] };
  const cached = actorLimitedUseIndexes.get(actor);
  if (cached) return cached;

  const sourceItems = [];
  const seenItems = new Set();
  for (const item of getActorItemsWithActiveHudModules(actor)) {
    const itemIdentity = String(item?.uuid ?? item?.id ?? "").trim();
    if (!itemIdentity || seenItems.has(itemIdentity)) continue;
    seenItems.add(itemIdentity);
    const functions = normalizeAbilityFunctions(getActiveSourceItemFunctions(item)).filter(abilityFunction => (
      abilityFunction.type === ABILITY_FUNCTION_TYPES.effectChanges
      && !isAbilityFunctionTimedTriggerCost(abilityFunction)
      && getLimitedUseConditions(abilityFunction.conditions).length > 0
    ));
    if (functions.length) sourceItems.push({ item, functions });
  }

  const effects = Array.from(actor.effects ?? []).filter(effect => {
    const lifecycleKind = String(effect.getFlag?.(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind ?? "");
    if (![
      EFFECT_LIFECYCLE_KINDS.disposableInstance,
      EFFECT_LIFECYCLE_KINDS.reconciledInstance
    ].includes(lifecycleKind)) return false;
    const descriptor = getEffectFunctionDescriptor(effect);
    return getLimitedUseConditions(descriptor?.functionData?.conditions).length > 0;
  });
  const index = { sourceItems, effects };
  actorLimitedUseIndexes.set(actor, index);
  return index;
}

function invalidateActorLimitedUseIndex(actor = null) {
  if (actor && typeof actor === "object") actorLimitedUseIndexes.delete(actor);
}

async function consumeSourceItemFunctionUses(item, requestedFunctionIds = new Set(), operationId = "") {
  const identity = String(item?.uuid ?? item?.id ?? "").trim();
  if (!identity || !requestedFunctionIds.size) return null;
  return enqueueDocumentMutation(`Item:${identity}`, async () => {
    if (!item || (!game.user?.isGM && !item.isOwner)) return null;
    const container = getSourceItemFunctionContainer(item);
    if (!container) return null;
    const functions = clonePlainData(container.functions);
    const normalized = normalizeAbilityFunctions(functions);
    let changed = false;
    let becameExhausted = false;
    let needsAuraSync = false;
    const consumedIdentities = [];
    for (const [index, abilityFunction] of normalized.entries()) {
      const functionId = String(abilityFunction?.id ?? "");
      if (!requestedFunctionIds.has(functionId)) continue;
      if (hasExhaustedLimitedUses(abilityFunction?.conditions)) continue;
      const claimIdentity = `Item:${identity}:${functionId}`;
      if (hasOperationClaim(operationId, claimIdentity)) continue;
      const advance = advanceLimitedUseConditions(functions[index]?.conditions);
      if (advance.changed) {
        changed = true;
        becameExhausted ||= advance.becameExhausted;
        needsAuraSync ||= advance.becameExhausted && (abilityFunction.conditions ?? [])
          .some(condition => condition?.type === ABILITY_CONDITION_TYPES.aura);
        consumedIdentities.push(claimIdentity);
      }
    }
    if (!changed) return null;
    await item.update({ [container.path]: functions }, {
      [LIMITED_USE_UPDATE_OPTION]: true,
      falloutMawLimitedUsesExhausted: becameExhausted
    });
    if (becameExhausted) {
      await syncActorAbilityEffects(item.parent);
      if (needsAuraSync) await syncAuraGeneratedEffects();
    }
    for (const claimIdentity of consumedIdentities) recordOperationClaim(operationId, claimIdentity);
    return item;
  });
}

async function consumeDisposableEffectUse(effect, keys, reverseOnly, operationId = "", { captured = false } = {}) {
  const identity = String(effect?.uuid ?? effect?.id ?? "").trim();
  if (!identity) return null;
  return enqueueDocumentMutation(`ActiveEffect:${identity}`, async () => {
    const actor = effect?.parent;
    const current = actor?.effects?.get?.(effect.id) ?? effect;
    if (!current || current.disabled || !canMutateActor(actor)) return null;
    const descriptor = getEffectFunctionDescriptor(current);
    if (!descriptor || (!captured && !hasTriggeredChange(actor, current.system?.changes, keys, reverseOnly))) return null;
    const claimIdentity = `ActiveEffect:${identity}:${String(descriptor?.functionData?.id ?? "")}`;
    if (hasOperationClaim(operationId, claimIdentity)) return null;
    const functionData = clonePlainData(descriptor.functionData);
    const conditions = functionData?.conditions;
    if (!getLimitedUseConditions(conditions).length) return null;
    if (!hasExhaustedLimitedUses(conditions)) advanceLimitedUseConditions(conditions);
    if (hasExhaustedLimitedUses(conditions)) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", [current.id], {
        animate: false,
        falloutMawLimitedUseExhaustion: true
      });
      recordOperationClaim(operationId, claimIdentity);
      return current;
    }
    await current.update({
      [`flags.${SYSTEM_ID}.${descriptor.flagKey}.functionData`]: functionData
    }, {
      [LIMITED_USE_UPDATE_OPTION]: true
    });
    recordOperationClaim(operationId, claimIdentity);
    return current;
  });
}

async function consumeReconciledEffectSourceUse(effect, descriptor, operationId = "") {
  const data = descriptor?.data ?? {};
  const sourceActorUuid = String(data?.sourceActorUuid ?? "").trim();
  const sourceItemUuid = String(data?.sourceItemUuid ?? "").trim();
  let sourceItem = sourceItemUuid ? await resolveUuid(sourceItemUuid) : null;
  if (!sourceItem && sourceActorUuid) {
    const sourceActor = await resolveUuid(sourceActorUuid);
    sourceItem = sourceActor?.items?.get?.(String(data?.itemId ?? data?.sourceItemId ?? "")) ?? null;
  }
  const functionId = String(data?.functionId ?? descriptor?.functionData?.id ?? "").trim();
  if (!sourceItem || !functionId) return null;
  return consumeSourceItemFunctionUses(sourceItem, new Set([functionId]), operationId);
}

function serializeWeaponAttackUseContext(context = {}) {
  const operationId = getWeaponAttackOperationId(context);
  const actionUseCaptured = pendingWeaponActionCaptures.has(operationId);
  const actionUseCandidates = pendingWeaponActionCaptures.get(operationId) ?? [];
  pendingWeaponActionCaptures.delete(operationId);
  const weaponData = context?.weaponData && typeof context.weaponData === "object"
    ? context.weaponData
    : null;
  const payload = {
    attackerUuid: String(context?.attackerUuid ?? context?.actorUuid ?? "").trim(),
    tokenUuid: String(context?.tokenUuid ?? "").trim(),
    weaponUuid: String(context?.weaponUuid ?? "").trim(),
    actionKey: String(context?.actionKey ?? "").trim(),
    weaponFunctionId: String(context?.weaponFunctionId ?? "").trim(),
    attackId: String(context?.attackId ?? "").trim(),
    damageHubOperationRef: String(context?.damageHubOperationRef ?? "").trim(),
    actionPointCostApplied: context?.actionPointCostApplied === true,
    attackDistanceMeters: normalizeAttackDistanceMeters(context?.attackDistanceMeters),
    effectiveRange: normalizeAttackEffectiveRange(context?.effectiveRange),
    actionUseCaptured,
    actionUseCandidates,
    targetActorUuids: Array.from(context?.targetActorUuids ?? [])
      .map(value => String(value ?? "").trim())
      .filter(Boolean),
    weaponData: weaponData ? {
      skillKey: String(weaponData.skillKey ?? "").trim(),
      proficiencyKey: String(weaponData.proficiencyKey ?? "").trim()
    } : null
  };
  payload.limitedUseOperationId = operationId;
  return payload;
}

function getWeaponAttackOperationId(context = {}) {
  const explicit = String(context?.limitedUseOperationId ?? "").trim();
  if (explicit) return explicit;
  const identity = [context?.attackId, context?.damageHubOperationRef, context?.chainRef?.rootId]
    .map(value => String(value ?? "").trim())
    .find(Boolean)
    || foundry.utils.randomID();
  return buildOperationId("attack", identity);
}

function getConditionContextIdentity(context = {}) {
  return [
    getDocumentUuid(context?.actorToken),
    getDocumentUuid(context?.targetToken),
    getDocumentUuid(context?.targetActor),
    String(context?.weaponActionKey ?? "").trim(),
    String(context?.requester ?? "").trim()
  ].join(":");
}

function getDocumentUuid(document = null) {
  return String(document?.document?.uuid ?? document?.uuid ?? document?.id ?? "").trim();
}

function firstText(...values) {
  return values.map(value => String(value ?? "").trim()).find(Boolean) ?? "";
}

async function requestWeaponAttackUseAuthority(payload = {}, activeGM = null) {
  if (!activeGM?.id) return consumeLimitedUsesForWeaponAttackDirect(payload);
  const requestId = foundry.utils.randomID();
  return new Promise(resolve => {
    const timeout = globalThis.setTimeout(() => {
      pendingSocketRequests.delete(requestId);
      console.warn(`${SYSTEM_ID} | Limited-use weapon request timed out`);
      resolve([]);
    }, LIMITED_USE_SOCKET_TIMEOUT_MS);
    pendingSocketRequests.set(requestId, { resolve, timeout });
    game.socket.emit(LIMITED_USE_SOCKET, {
      type: LIMITED_USE_ATTACK_REQUEST,
      requestId,
      targetUserId: activeGM.id,
      senderUserId: game.user?.id ?? "",
      payload
    });
  });
}

async function requestCapturedUseAuthority(candidates = [], operationId = "", activeGM = null) {
  if (!activeGM?.id) return consumeCapturedLimitedUseCandidatesDirect(candidates, operationId);
  const requestId = foundry.utils.randomID();
  return new Promise(resolve => {
    const timeout = globalThis.setTimeout(() => {
      pendingSocketRequests.delete(requestId);
      console.warn(`${SYSTEM_ID} | Limited-use candidate request timed out`);
      resolve([]);
    }, LIMITED_USE_SOCKET_TIMEOUT_MS);
    pendingSocketRequests.set(requestId, { resolve, timeout });
    game.socket.emit(LIMITED_USE_SOCKET, {
      type: LIMITED_USE_CANDIDATES_REQUEST,
      requestId,
      targetUserId: activeGM.id,
      senderUserId: game.user?.id ?? "",
      payload: {
        operationId: String(operationId ?? "").trim(),
        candidates
      }
    });
  });
}

async function handleLimitedUseSocketMessage(message = {}) {
  if ([LIMITED_USE_ATTACK_RESPONSE, LIMITED_USE_CANDIDATES_RESPONSE].includes(message.type)) {
    if (message.targetUserId && message.targetUserId !== game.user?.id) return;
    const pending = pendingSocketRequests.get(String(message.requestId ?? ""));
    if (!pending) return;
    globalThis.clearTimeout(pending.timeout);
    pendingSocketRequests.delete(message.requestId);
    pending.resolve([]);
    return;
  }
  if (message.type === LIMITED_USE_CANDIDATES_REQUEST) {
    if (!game.user?.isGM || (message.targetUserId && message.targetUserId !== game.user.id)) return;
    let ok = false;
    try {
      const sender = game.users?.get?.(String(message.senderUserId ?? "")) ?? null;
      if (sender?.active) {
        const candidates = await filterAuthorizedCapturedUseCandidates(message.payload?.candidates);
        await consumeCapturedLimitedUseCandidatesDirect(
          candidates,
          String(message.payload?.operationId ?? "").trim()
        );
        ok = true;
      }
    } catch (error) {
      console.error(`${SYSTEM_ID} | Limited-use candidate authority failed`, error);
    }
    game.socket.emit(LIMITED_USE_SOCKET, {
      type: LIMITED_USE_CANDIDATES_RESPONSE,
      requestId: String(message.requestId ?? ""),
      targetUserId: String(message.senderUserId ?? ""),
      senderUserId: game.user.id,
      ok
    });
    return;
  }
  if (message.type !== LIMITED_USE_ATTACK_REQUEST) return;
  if (!game.user?.isGM || (message.targetUserId && message.targetUserId !== game.user.id)) return;

  let ok = false;
  try {
    const sender = game.users?.get?.(String(message.senderUserId ?? "")) ?? null;
    const actorUuid = String(message.payload?.attackerUuid ?? "").trim();
    const actor = await resolveUuid(actorUuid);
    if (sender?.active && actor && (sender.isGM || actor.testUserPermission?.(sender, "OWNER"))) {
      const payload = {
        ...(message.payload ?? {}),
        actionUseCandidates: await filterAuthorizedActionUseCandidates(
          actor,
          message.payload?.actionUseCandidates,
          message.payload?.targetActorUuids
        )
      };
      await consumeLimitedUsesForWeaponAttackDirect(payload);
      ok = true;
    }
  } catch (error) {
    console.error(`${SYSTEM_ID} | Limited-use weapon attack authority failed`, error);
  }
  game.socket.emit(LIMITED_USE_SOCKET, {
    type: LIMITED_USE_ATTACK_RESPONSE,
    requestId: String(message.requestId ?? ""),
    targetUserId: String(message.senderUserId ?? ""),
    senderUserId: game.user.id,
    ok
  });
}

async function filterAuthorizedCapturedUseCandidates(candidates = []) {
  if (!Array.isArray(candidates)) return [];
  const authorized = [];
  for (const candidate of candidates) {
    if (candidate?.kind === "sourceItem") {
      const item = await resolveUuid(String(candidate.itemUuid ?? "").trim());
      const hostActorUuid = String(candidate.hostActorUuid ?? "").trim();
      const functionId = String(candidate.functionId ?? "").trim();
      const activeItem = item?.parent && getActorItemsWithActiveHudModules(item.parent)
        .some(entry => entry?.id === item.id);
      const abilityFunction = normalizeAbilityFunctions(getActiveSourceItemFunctions(item))
        .find(entry => String(entry?.id ?? "") === functionId);
      if (activeItem
        && (!hostActorUuid || item.parent.uuid === hostActorUuid)
        && getLimitedUseConditions(abilityFunction?.conditions).length
        && !hasExhaustedLimitedUses(abilityFunction?.conditions)) {
        authorized.push(serializeCapturedCandidate(candidate));
      }
      continue;
    }
    if (candidate?.kind === "disposableEffect") {
      const effect = await resolveUuid(String(candidate.effectUuid ?? "").trim());
      const descriptor = getEffectFunctionDescriptor(effect);
      const hostActorUuid = String(candidate.hostActorUuid ?? "").trim();
      if (effect
        && effect.getFlag?.(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind === EFFECT_LIFECYCLE_KINDS.disposableInstance
        && (!hostActorUuid || effect.parent?.uuid === hostActorUuid)
        && getLimitedUseConditions(descriptor?.functionData?.conditions).length) {
        authorized.push(serializeCapturedCandidate(candidate));
      }
      continue;
    }
    if (candidate?.kind !== "reconciledSource") continue;
    const effect = await resolveUuid(String(candidate.hostEffectUuid ?? "").trim());
    const descriptor = getEffectFunctionDescriptor(effect);
    const data = descriptor?.data ?? {};
    const hostActorUuid = String(candidate.hostActorUuid ?? "").trim();
    const functionId = String(data.functionId ?? descriptor?.functionData?.id ?? "");
    const sameSource = String(data.sourceItemUuid ?? "") === String(candidate.sourceItemUuid ?? "")
      || (
        String(data.sourceActorUuid ?? "") === String(candidate.sourceActorUuid ?? "")
        && String(data.itemId ?? data.sourceItemId ?? "") === String(candidate.sourceItemId ?? "")
      );
    if (effect
      && effect.getFlag?.(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind === EFFECT_LIFECYCLE_KINDS.reconciledInstance
      && (!hostActorUuid || effect.parent?.uuid === hostActorUuid)
      && functionId === String(candidate.functionId ?? "")
      && sameSource
      && getLimitedUseConditions(descriptor?.functionData?.conditions).length) {
      authorized.push(serializeCapturedCandidate(candidate));
    }
  }
  return authorized.filter(Boolean);
}

async function filterAuthorizedActionUseCandidates(actor = null, candidates = [], targetActorUuids = []) {
  if (!actor || !Array.isArray(candidates)) return [];
  const participantActors = [actor];
  for (const uuid of Array.from(targetActorUuids ?? [])) {
    const targetActor = await resolveUuid(String(uuid ?? "").trim());
    if (targetActor && !participantActors.some(entry => entry.uuid === targetActor.uuid)) {
      participantActors.push(targetActor);
    }
  }
  const participantActorUuids = new Set(participantActors.map(entry => String(entry.uuid ?? "")).filter(Boolean));
  const authorized = [];
  for (const candidate of candidates) {
    if (candidate?.kind === "sourceItem") {
      const item = await resolveUuid(String(candidate.itemUuid ?? "").trim());
      if (participantActorUuids.has(String(item?.parent?.uuid ?? ""))) {
        authorized.push(serializeCapturedCandidate(candidate));
      }
      continue;
    }
    if (candidate?.kind === "disposableEffect") {
      const effect = await resolveUuid(String(candidate.effectUuid ?? "").trim());
      if (participantActorUuids.has(String(effect?.parent?.uuid ?? ""))) {
        authorized.push(serializeCapturedCandidate(candidate));
      }
      continue;
    }
    if (candidate?.kind !== "reconciledSource") continue;
    const matchesProjection = participantActors.some(participantActor => Array.from(participantActor.effects ?? []).some(effect => {
      if (effect?.disabled || effect?.active === false) return false;
      if (effect.getFlag?.(SYSTEM_ID, EFFECT_LIFECYCLE_FLAG_KEY)?.kind !== EFFECT_LIFECYCLE_KINDS.reconciledInstance) {
        return false;
      }
      const descriptor = getEffectFunctionDescriptor(effect);
      if (!descriptor) return false;
      const functionId = String(descriptor.data?.functionId ?? descriptor.functionData?.id ?? "");
      if (functionId !== String(candidate.functionId ?? "")) return false;
      const sourceItemUuid = String(descriptor.data?.sourceItemUuid ?? "");
      if (sourceItemUuid && sourceItemUuid === String(candidate.sourceItemUuid ?? "")) return true;
      return String(descriptor.data?.sourceActorUuid ?? "") === String(candidate.sourceActorUuid ?? "")
        && String(descriptor.data?.itemId ?? descriptor.data?.sourceItemId ?? "") === String(candidate.sourceItemId ?? "");
    }));
    if (matchesProjection) authorized.push(serializeCapturedCandidate(candidate));
  }
  return authorized.filter(Boolean);
}

function getActiveSourceItemFunctions(item) {
  if (item?.type === "ability") return Array.from(item.system?.functions ?? []);
  if (!isActiveFreeSettingsItem(item)) return [];
  return Array.from(item.system?.functions?.freeSettings?.entries ?? []);
}

function getSourceItemFunctionContainer(item) {
  const system = item?.toObject?.()?.system ?? {};
  if (item?.type === "ability") {
    return {
      path: "system.functions",
      functions: Array.isArray(system?.functions) ? system.functions : Object.values(system?.functions ?? {})
    };
  }
  if (!isActiveFreeSettingsItem(item)) return null;
  const entries = system?.functions?.freeSettings?.entries;
  return {
    path: "system.functions.freeSettings.entries",
    functions: Array.isArray(entries) ? entries : Object.values(entries ?? {})
  };
}

function isActiveFreeSettingsItem(item) {
  if (item?.type !== "gear" || !item.system?.functions?.freeSettings?.enabled) return false;
  return Boolean(item.system?.equipped)
    || ["equipment", "weapon", "constructPart"].includes(item.system?.placement?.mode);
}

function advanceLimitedUseConditions(conditions = []) {
  let changed = false;
  let becameExhausted = false;
  for (const condition of conditions ?? []) {
    if (condition?.type !== ABILITY_CONDITION_TYPES.limitedUses) continue;
    const state = getLimitedUseConditionState(condition);
    if (state.exhausted) continue;
    condition.usesSpent = Math.min(state.usesMax, state.usesSpent + 1);
    condition.usesMax = state.usesMax;
    changed = true;
    becameExhausted ||= condition.usesSpent >= condition.usesMax;
  }
  return { changed, becameExhausted };
}

function hasTriggeredChange(actor, changes, keys, reverseOnly) {
  return (changes ?? []).some(change => {
    const key = String(change?.key ?? "").trim();
    const sourceKey = getOriginalEffectKeyFromReverse(key);
    if (reverseOnly !== Boolean(sourceKey)) return false;
    if (!keys.has(sourceKey || key)) return false;
    return isConsumableActiveUseChange(actor, change);
  });
}

function hasTriggeredReconciledEffectChange(actor, effect, keys, contexts, reverseOnly) {
  const auraFlag = getAuraGeneratedEffectFlag(effect);
  if (auraFlag?.lateContextual !== true) {
    return hasTriggeredChange(actor, effect?.system?.changes, keys, reverseOnly);
  }
  return (contexts ?? []).some(context => hasTriggeredChange(
    actor,
    getLateAuraContextualChanges(actor, effect, context),
    keys,
    reverseOnly
  ));
}

function buildConditionContext(context = {}) {
  const check = context?.check ?? {};
  return {
    actorToken: context?.actorToken ?? context?.token ?? check?.actorToken ?? null,
    targetToken: context?.targetToken ?? check?.targetToken ?? null,
    targetActor: context?.targetActor ?? check?.targetActor ?? context?.targetToken?.actor ?? check?.targetToken?.actor ?? null,
    weaponData: context?.weaponData && typeof context.weaponData === "object"
      ? context.weaponData
      : check?.weaponData && typeof check.weaponData === "object" ? check.weaponData : null,
    attackDistanceMeters: context?.attackDistanceMeters ?? check?.attackDistanceMeters ?? null,
    effectiveRange: context?.effectiveRange ?? check?.effectiveRange ?? null,
    skillKey: String(
      context?.skillKey
      ?? context?.skill?.key
      ?? check?.skillKey
      ?? check?.skill?.key
      ?? ""
    ).trim(),
    weaponActionKey: String(context?.weaponActionKey ?? context?.actionKey ?? check?.weaponActionKey ?? "").trim(),
    requester: String(context?.requester ?? check?.requester ?? "").trim(),
    criticalSuccess: context?.criticalSuccess === true
      || String(context?.resultKey ?? context?.result?.key ?? check?.result?.key ?? "").trim() === "criticalSuccess",
    chanceOperationId: getActiveUseOperationId(context)
  };
}

function reverseInteractionContext(context = {}, sourceActor = null, sourceToken = null, originalTargetToken = null) {
  return {
    ...context,
    actorToken: originalTargetToken ?? context?.targetToken ?? null,
    targetToken: sourceToken ?? context?.actorToken ?? null,
    targetActor: sourceActor,
    weaponData: context?.weaponData ?? null,
    weaponActionKey: context?.weaponActionKey ?? "",
    requester: context?.requester ?? ""
  };
}

function canMutateActor(actor) {
  return Boolean(actor && (game.user?.isGM || actor.isOwner));
}

async function resolveUuid(uuid = "") {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  try {
    return await fromUuid(value);
  } catch (_error) {
    return null;
  }
}

function enqueueDocumentMutation(key, operation) {
  const previous = documentMutationQueues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (documentMutationQueues.get(key) === current) documentMutationQueues.delete(key);
    });
  documentMutationQueues.set(key, current);
  return current;
}

function hasOperationClaim(operationId = "", identity = "") {
  const operation = String(operationId ?? "").trim();
  const source = String(identity ?? "").trim();
  return Boolean(operation && source && operationClaims.get(operation)?.has(source));
}

function buildOperationId(kind = "", value = "") {
  const key = String(value ?? "").trim();
  return key ? `${String(kind ?? "use").trim() || "use"}:${key}` : "";
}

function recordOperationClaim(operationId = "", identity = "") {
  const operation = String(operationId ?? "").trim();
  const source = String(identity ?? "").trim();
  if (!operation || !source) return;
  const claims = operationClaims.get(operation) ?? new Set();
  claims.add(source);
  operationClaims.delete(operation);
  operationClaims.set(operation, claims);
  while (operationClaims.size > MAX_RETAINED_OPERATION_CLAIMS) {
    operationClaims.delete(operationClaims.keys().next().value);
  }
}

function clonePlainData(value) {
  if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
