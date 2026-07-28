import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getCombatSettings } from "../settings/accessors.mjs";
import { evaluateActorEffectChangeBaseNumber } from "../utils/active-effect-changes.mjs";
import { normalizeAttackDistanceContext } from "../utils/attack-distance.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { serializeWeaponContextData } from "../utils/weapon-context.mjs";
import {
  commitPreparedActiveUseOperations,
  prepareActiveUseOperation
} from "../abilities/active-use-runtime.mjs";
import {
  DODGE_LOSS_MODIFIER_EFFECT_KEY,
  DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY
} from "./dodge-effect-keys.mjs";
import { isActorInActiveCombat } from "./combat-membership.mjs";

const DODGE_RESOURCE_KEY = "dodge";
const DODGE_SOCKET_ACTION_SPEND = "spendDodgeResource";
const DODGE_SOCKET_ACTION_RESTORE = "restoreDodgeResource";
const DODGE_SOCKET_ACTION_RESULT = "dodgeResourceResult";
const DODGE_SOCKET_REQUEST_TIMEOUT_MS = 30000;
const pendingDodgeSocketRequests = new Map();
const actorDodgeMutationQueue = new Map();

export function registerCombatDodgeHooks() {
}

export function registerCombatDodgeSocket() {
  game.socket.on(`system.${FALLOUT_MAW.id}`, handleDodgeSocketMessage);
}

export function createDodgeAttackExposureTracker() {
  return new DodgeAttackExposureTracker();
}

export function getWeaponDodgeAttackMultiplier(actionKey = "") {
  const settings = getDodgeSettings();
  if (actionKey === "burst") return settings.burstMultiplier;
  if (actionKey === "volley") return settings.volleyMultiplier;
  return 1;
}

export async function spendActorDodgeForAreaDamage(actor) {
  return spendActorDodgeResource(actor, getDodgeSettings().areaDamageMultiplier);
}

export async function spendDodgeForAreaDamageRequests(requests = []) {
  const actors = new Map();
  for (const request of Array.isArray(requests) ? requests : []) {
    const actor = request?.actor ?? (request?.actorUuid ? await fromUuid(request.actorUuid) : null);
    if (!actor) continue;
    const source = request.source ?? {};
    const key = [
      actor.uuid,
      source.regionUuid ?? source.behaviorUuid ?? source.kind ?? "area",
      source.tokenId ?? "",
      source.worldTime ?? ""
    ].join("|");
    actors.set(key, actor);
  }

  for (const actor of actors.values()) {
    await spendActorDodgeForAreaDamage(actor);
  }
}

class DodgeAttackExposureTracker {
  #group = new Map();
  #multiplier = 1;

  begin(multiplier = 1) {
    this.#group.clear();
    this.#multiplier = Math.max(0, Number(multiplier) || 0);
  }

  record(actor, attackContext = {}) {
    if (!actor) return;
    const current = this.#group.get(actor.uuid);
    const entry = {
      actor,
      multiplier: this.#multiplier,
      conditionContext: normalizeIncomingDodgeAttackContext(actor, attackContext)
    };
    if (!current || entry.multiplier > current.multiplier) this.#group.set(actor.uuid, entry);
  }

  async flush() {
    const entries = Array.from(this.#group.values());
    this.#group.clear();
    for (const entry of entries) {
      await spendActorDodgeResource(entry.actor, entry.multiplier, entry.conditionContext);
    }
  }
}

export async function restoreCombatDodgeResources(combat, { mode = "full" } = {}) {
  if (!game.user.isActiveGM) return;
  const actors = getCombatDodgeActors(combat);
  for (const actor of actors.values()) {
    await restoreActorDodgeResource(actor, { mode });
  }
}

export async function initializeCombatDodgeResources(combat) {
  if (!getDodgeSettings().restoreOnCombatStart) return;
  await restoreCombatDodgeResources(combat, { mode: "full" });
}

export async function initializeActorDodgeResource(actor) {
  if (!getDodgeSettings().restoreOnCombatStart) return;
  await restoreActorDodgeResource(actor, { mode: "full" });
}

export async function cleanupCombatDodgeResources(combat) {
  if (!getDodgeSettings().restoreOnCombatEnd) return;
  await restoreCombatDodgeResources(combat, { mode: "full" });
}

export async function cleanupActorDodgeResource(actor) {
  if (!getDodgeSettings().restoreOnCombatEnd) return;
  await restoreActorDodgeResource(actor, { mode: "full" });
}

export async function restoreActorDodgeResource(actor, { mode = "full" } = {}) {
  return runActorDodgeMutation(actor, () => restoreActorDodgeResourceNow(actor, { mode }));
}

async function restoreActorDodgeResourceNow(actor, { mode = "full" } = {}) {
  const resource = getDodgeResource(actor);
  if (!resource) return;

  const max = Math.max(0, toInteger(resource.max));
  const current = Math.max(0, toInteger(resource.value));
  const operationId = mode === "round"
    ? `dodgeRoundRecovery:${String(actor?.uuid ?? actor?.id ?? "")}:${foundry.utils.randomID()}`
    : "";
  const roundRecovery = mode === "round"
    ? await resolveDodgePercentModifier(
      actor,
      getDodgeSettings().roundRecoveryPercent,
      DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY,
      { chanceOperationId: operationId }
    )
    : { value: 0, materiallyModified: false };
  const nextValue = mode === "round"
    ? Math.min(max, current + calculateDodgeAmount(max, roundRecovery.value))
    : max;
  if (nextValue === current) return;
  await updateActorDodgeValue(actor, nextValue, {
    socketAction: DODGE_SOCKET_ACTION_RESTORE,
    activeUseKey: mode === "round" && roundRecovery.materiallyModified
      ? DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY
      : "",
    activeUseKind: "dodgeRoundRecovery",
    operationId
  });
}

async function spendActorDodgeResource(actor, multiplier = 1, conditionContext = {}) {
  return runActorDodgeMutation(actor, () => spendActorDodgeResourceNow(actor, multiplier, conditionContext));
}

async function spendActorDodgeResourceNow(actor, multiplier = 1, conditionContext = {}) {
  const settings = getDodgeSettings();
  if (!settings.enabled) return;
  if (!isActorInActiveCombat(actor)) return;
  const resource = getDodgeResource(actor);
  if (!resource) return;

  const max = Math.max(0, toInteger(resource.max));
  const current = Math.max(0, toInteger(resource.value));
  const operationId = `dodgeLoss:${String(actor?.uuid ?? actor?.id ?? "")}:${foundry.utils.randomID()}`;
  const loss = await resolveDodgePercentModifier(
    actor,
    settings.attackCostPercent * Math.max(0, Number(multiplier) || 0),
    DODGE_LOSS_MODIFIER_EFFECT_KEY,
    { ...conditionContext, chanceOperationId: operationId }
  );
  const amount = calculateDodgeAmount(max, loss.value);
  if (amount <= 0 || current <= 0) return;

  await updateActorDodgeValue(actor, Math.max(0, current - amount), {
    socketAction: DODGE_SOCKET_ACTION_SPEND,
    activeUseKey: loss.materiallyModified ? DODGE_LOSS_MODIFIER_EFFECT_KEY : "",
    activeUseKind: "dodgeLoss",
    operationId,
    conditionContext
  });
}

function runActorDodgeMutation(actor, operation) {
  const actorUuid = String(actor?.uuid ?? "");
  if (!actorUuid) return operation();
  const previous = actorDodgeMutationQueue.get(actorUuid) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (actorDodgeMutationQueue.get(actorUuid) === next) actorDodgeMutationQueue.delete(actorUuid);
    });
  actorDodgeMutationQueue.set(actorUuid, next);
  return next;
}

async function resolveDodgePercentModifier(actor, percent, effectKey, context = {}) {
  const changes = collectDodgeAmountModifierChanges(actor, effectKey);
  let result = Math.max(0, Number(percent) || 0);
  let materiallyModified = false;
  for (const change of changes) {
    const value = evaluateActorEffectChangeBaseNumber(actor, change, { fallback: Number.NaN });
    if (!Number.isFinite(value)) continue;
    const previous = result;
    if (change.type === "multiply") result *= value;
    else if (change.type === "override") result = value;
    else if (change.type === "upgrade") result = Math.max(result, value);
    else if (change.type === "downgrade") result = Math.min(result, value);
    else result += value;
    if (result !== previous) materiallyModified = true;
  }
  // Lazy import keeps the damage-hub -> dodge-resource dependency acyclic at startup.
  const { getContextualAbilityChangeValue } = await import("../abilities/evaluation.mjs");
  const contextualResult = getContextualAbilityChangeValue(actor, effectKey, {
    ...context,
    baseValue: result
  });
  return {
    value: Math.max(0, contextualResult),
    materiallyModified: materiallyModified || contextualResult !== Math.max(0, Number(percent) || 0)
  };
}

function collectDodgeAmountModifierChanges(actor, effectKey) {
  const acceptedKey = String(effectKey ?? "").trim();
  if (!acceptedKey) return [];
  const changes = [];
  for (const effect of actor?.allApplicableEffects?.() ?? actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    for (const change of effect?.system?.changes ?? []) {
      if (String(change?.key ?? "").trim() !== acceptedKey) continue;
      changes.push({ ...change, effect });
    }
  }
  return changes.sort((left, right) => toInteger(left?.priority) - toInteger(right?.priority));
}

async function updateActorDodgeValue(actor, value, {
  socketAction = DODGE_SOCKET_ACTION_SPEND,
  activeUseKey = "",
  activeUseKind = "dodgeResource",
  operationId = "",
  conditionContext = {}
} = {}) {
  if (!actor) return false;
  const nextValue = Math.max(0, toInteger(value));
  const currentValue = Math.max(0, toInteger(getDodgeResource(actor)?.value));
  if (nextValue === currentValue) return false;
  const resolvedOperationId = String(operationId ?? "").trim()
    || `${activeUseKind}:${String(actor.uuid ?? actor.id ?? "")}:${foundry.utils.randomID()}`;
  if (actor.isOwner) {
    const activeUsePreparations = prepareDodgeActiveUseOperations(
      actor,
      activeUseKey,
      activeUseKind,
      resolvedOperationId,
      conditionContext
    );
    await actor.update({ [`system.resources.${DODGE_RESOURCE_KEY}.value`]: nextValue });
    await commitDodgeActiveUseOperations(activeUsePreparations, resolvedOperationId);
    return true;
  }
  if (game.user?.isActiveGM) return false;

  const gm = getResponsibleGM();
  if (!gm) return false;
  return requestDodgeSocketAction(gm, {
    action: socketAction,
    actorUuid: actor.uuid,
    value: nextValue,
    activeUseKey,
    operationId: resolvedOperationId,
    conditionContext: serializeDodgeConditionContext(conditionContext)
  });
}

function prepareDodgeActiveUseOperations(
  actor,
  key = "",
  kind = "dodgeResource",
  operationId = "",
  conditionContext = {}
) {
  const activeUseKey = String(key ?? "").trim();
  if (!activeUseKey) return [];
  const directPreparation = prepareActiveUseOperation({
    kind,
    actor,
    keys: new Set([activeUseKey]),
    conditionContexts: [{
      ...conditionContext,
      actorToken: conditionContext?.actorToken ?? actor?.token?.object ?? actor?.token ?? null,
      chanceOperationId: operationId
    }],
    reverseOnly: false
  });
  const reverseActor = conditionContext?.targetActor ?? conditionContext?.targetToken?.actor ?? null;
  const reversePreparation = reverseActor && !isSameActor(actor, reverseActor)
    ? prepareActiveUseOperation({
      kind,
      actor: reverseActor,
      keys: new Set([activeUseKey]),
      conditionContexts: [{
        ...conditionContext,
        actorToken: conditionContext?.targetToken ?? null,
        targetActor: actor,
        targetToken: conditionContext?.actorToken ?? null,
        chanceOperationId: operationId
      }],
      reverseOnly: true
    })
    : null;
  return [directPreparation, reversePreparation].filter(Boolean);
}

async function commitDodgeActiveUseOperations(preparations = [], operationId = "") {
  const operations = (Array.isArray(preparations) ? preparations : [preparations]).filter(Boolean);
  if (!operations.length) return [];
  try {
    return await commitPreparedActiveUseOperations(operations, { operationId });
  } catch (error) {
    console.error(`${FALLOUT_MAW.id} | Dodge active-use commit failed`, error);
    return [];
  }
}

async function requestDodgeSocketAction(gm, payload = {}) {
  const requestId = foundry.utils.randomID();
  const promise = new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      pendingDodgeSocketRequests.delete(requestId);
      resolve(false);
    }, DODGE_SOCKET_REQUEST_TIMEOUT_MS);
    pendingDodgeSocketRequests.set(requestId, { resolve, timeout });
  });

  game.socket.emit(`system.${FALLOUT_MAW.id}`, {
    ...payload,
    gmUserId: gm.id,
    requesterUserId: game.user?.id ?? "",
    requestId
  });
  return promise;
}

async function handleDodgeSocketMessage(payload = {}) {
  if (payload.action === DODGE_SOCKET_ACTION_RESULT) {
    const pending = pendingDodgeSocketRequests.get(payload.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingDodgeSocketRequests.delete(payload.requestId);
    pending.resolve(Boolean(payload.success));
    return;
  }

  if (![DODGE_SOCKET_ACTION_SPEND, DODGE_SOCKET_ACTION_RESTORE].includes(payload.action)) return;
  if (!game.user?.isActiveGM || payload.gmUserId !== game.user.id) return;

  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  let success = false;
  try {
    const combatSpendAllowed = payload.action !== DODGE_SOCKET_ACTION_SPEND || isActorInActiveCombat(actor);
    if (actor?.isOwner && combatSpendAllowed) {
      const nextValue = Math.max(0, toInteger(payload.value));
      const currentValue = Math.max(0, toInteger(getDodgeResource(actor)?.value));
      if (nextValue === currentValue) return;
      const expectedActiveUseKey = payload.action === DODGE_SOCKET_ACTION_SPEND
        ? DODGE_LOSS_MODIFIER_EFFECT_KEY
        : DODGE_ROUND_RECOVERY_MODIFIER_EFFECT_KEY;
      const requestedActiveUseKey = String(payload.activeUseKey ?? "").trim();
      const directionMatches = payload.action === DODGE_SOCKET_ACTION_SPEND
        ? nextValue < currentValue
        : nextValue > currentValue;
      const activeUseKey = directionMatches && requestedActiveUseKey === expectedActiveUseKey
        ? expectedActiveUseKey
        : "";
      const activeUseKind = payload.action === DODGE_SOCKET_ACTION_SPEND
        ? "dodgeLoss"
        : "dodgeRoundRecovery";
      const operationId = String(payload.operationId ?? "").trim()
        || `${activeUseKind}:${String(actor.uuid ?? actor.id ?? "")}:${foundry.utils.randomID()}`;
      const conditionContext = await resolveDodgeConditionContextPayload(payload.conditionContext);
      const activeUsePreparations = prepareDodgeActiveUseOperations(
        actor,
        activeUseKey,
        activeUseKind,
        operationId,
        conditionContext
      );
      await actor.update({ [`system.resources.${DODGE_RESOURCE_KEY}.value`]: nextValue });
      success = true;
      await commitDodgeActiveUseOperations(activeUsePreparations, operationId);
    }
  } finally {
    game.socket.emit(`system.${FALLOUT_MAW.id}`, {
      action: DODGE_SOCKET_ACTION_RESULT,
      requestId: payload.requestId,
      requesterUserId: payload.requesterUserId,
      success
    });
  }
}

function getDodgeResource(actor) {
  return actor?.system?.resources?.[DODGE_RESOURCE_KEY] ?? null;
}

function normalizeIncomingDodgeAttackContext(actor, context = {}) {
  const attackerToken = context?.actorToken ?? context?.attackerToken ?? null;
  const defenderToken = isTokenForActor(context?.targetToken, actor)
    ? context.targetToken
    : actor?.token?.object ?? actor?.token ?? null;
  return {
    actorToken: defenderToken,
    targetActor: attackerToken?.actor ?? attackerToken?.document?.actor ?? context?.attackerActor ?? null,
    targetToken: attackerToken,
    ...normalizeAttackDistanceContext(context),
    weaponData: serializeWeaponContextData(context?.weaponData),
    weaponActionKey: String(context?.weaponActionKey ?? context?.actionKey ?? "").trim(),
    requester: String(context?.requester ?? "weaponAttack").trim() || "weaponAttack"
  };
}

function serializeDodgeConditionContext(context = {}) {
  return {
    actorTokenUuid: getTokenUuid(context?.actorToken),
    targetActorUuid: String(context?.targetActor?.uuid ?? "").trim(),
    targetTokenUuid: getTokenUuid(context?.targetToken),
    ...normalizeAttackDistanceContext(context),
    weaponData: serializeWeaponContextData(context?.weaponData),
    weaponActionKey: String(context?.weaponActionKey ?? "").trim(),
    requester: String(context?.requester ?? "").trim()
  };
}

async function resolveDodgeConditionContextPayload(payload = {}) {
  const [actorTokenDocument, targetActor, targetTokenDocument] = await Promise.all([
    resolveDodgeContextUuid(payload?.actorTokenUuid),
    resolveDodgeContextUuid(payload?.targetActorUuid),
    resolveDodgeContextUuid(payload?.targetTokenUuid)
  ]);
  return {
    actorToken: actorTokenDocument?.object ?? actorTokenDocument ?? null,
    targetActor: targetActor ?? targetTokenDocument?.actor ?? null,
    targetToken: targetTokenDocument?.object ?? targetTokenDocument ?? null,
    ...normalizeAttackDistanceContext(payload),
    weaponData: serializeWeaponContextData(payload?.weaponData),
    weaponActionKey: String(payload?.weaponActionKey ?? "").trim(),
    requester: String(payload?.requester ?? "").trim()
  };
}

async function resolveDodgeContextUuid(uuid = "") {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  try {
    return await fromUuid(value);
  } catch (_error) {
    return null;
  }
}

function getTokenUuid(token = null) {
  return String(token?.document?.uuid ?? token?.uuid ?? "").trim();
}

function isTokenForActor(token = null, actor = null) {
  const tokenActor = token?.actor ?? token?.document?.actor ?? null;
  if (!tokenActor || !actor) return false;
  if (tokenActor === actor) return true;
  return Boolean(tokenActor.uuid && actor.uuid && tokenActor.uuid === actor.uuid);
}

function isSameActor(left = null, right = null) {
  if (left === right) return true;
  const leftUuid = String(left?.uuid ?? "").trim();
  const rightUuid = String(right?.uuid ?? "").trim();
  return Boolean(leftUuid && rightUuid && leftUuid === rightUuid);
}

function calculateDodgeAmount(max = 0, percent = 0) {
  if (max <= 0 || percent <= 0) return 0;
  return Math.max(1, Math.ceil((max * percent) / 100));
}

function getCombatDodgeActors(combat) {
  const actors = new Map();
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant.actor;
    if (!actor) continue;
    actors.set(actor.uuid, actor);
  }
  return actors;
}

function getDodgeSettings() {
  return getCombatSettings().dodge;
}

function getResponsibleGM() {
  return game.users?.activeGM ?? game.users?.find?.(user => user.active && user.isGM) ?? null;
}
