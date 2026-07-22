import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getCombatSettings } from "../settings/accessors.mjs";
import { evaluateActorEffectChangeBaseNumber } from "../utils/active-effect-changes.mjs";
import { toInteger } from "../utils/numbers.mjs";
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
  Hooks.on("combatStart", combat => {
    if (!getDodgeSettings().restoreOnCombatStart) return undefined;
    return restoreCombatDodgeResources(combat, { mode: "full" });
  });

  Hooks.on("deleteCombat", combat => {
    if (!getDodgeSettings().restoreOnCombatEnd) return undefined;
    return restoreCombatDodgeResources(combat, { mode: "full" });
  });

  Hooks.on("createCombatant", combatant => {
    const combat = combatant?.combat;
    if (!game.user.isActiveGM || !combat?.started) return undefined;
    if (!getDodgeSettings().restoreOnCombatStart) return undefined;
    return restoreActorDodgeResource(combatant.actor, { mode: "full" });
  });
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

  record(actor) {
    if (!actor) return;
    const current = this.#group.get(actor.uuid);
    const entry = { actor, multiplier: this.#multiplier };
    if (!current || entry.multiplier > current.multiplier) this.#group.set(actor.uuid, entry);
  }

  async flush() {
    const entries = Array.from(this.#group.values());
    this.#group.clear();
    for (const entry of entries) {
      await spendActorDodgeResource(entry.actor, entry.multiplier);
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

async function spendActorDodgeResource(actor, multiplier = 1) {
  return runActorDodgeMutation(actor, () => spendActorDodgeResourceNow(actor, multiplier));
}

async function spendActorDodgeResourceNow(actor, multiplier = 1) {
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
    { chanceOperationId: operationId }
  );
  const amount = calculateDodgeAmount(max, loss.value);
  if (amount <= 0 || current <= 0) return;

  await updateActorDodgeValue(actor, Math.max(0, current - amount), {
    socketAction: DODGE_SOCKET_ACTION_SPEND,
    activeUseKey: loss.materiallyModified ? DODGE_LOSS_MODIFIER_EFFECT_KEY : "",
    activeUseKind: "dodgeLoss",
    operationId
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
  operationId = ""
} = {}) {
  if (!actor) return false;
  const nextValue = Math.max(0, toInteger(value));
  const currentValue = Math.max(0, toInteger(getDodgeResource(actor)?.value));
  if (nextValue === currentValue) return false;
  const resolvedOperationId = String(operationId ?? "").trim()
    || `${activeUseKind}:${String(actor.uuid ?? actor.id ?? "")}:${foundry.utils.randomID()}`;
  if (actor.isOwner) {
    const activeUsePreparation = prepareDodgeActiveUseOperation(actor, activeUseKey, activeUseKind, resolvedOperationId);
    await actor.update({ [`system.resources.${DODGE_RESOURCE_KEY}.value`]: nextValue });
    await commitDodgeActiveUseOperation(activeUsePreparation, resolvedOperationId);
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
    operationId: resolvedOperationId
  });
}

function prepareDodgeActiveUseOperation(actor, key = "", kind = "dodgeResource", operationId = "") {
  const activeUseKey = String(key ?? "").trim();
  if (!activeUseKey) return null;
  return prepareActiveUseOperation({
    kind,
    actor,
    keys: new Set([activeUseKey]),
    conditionContexts: [{
      actorToken: actor?.token?.object ?? actor?.token ?? null,
      chanceOperationId: operationId
    }],
    reverseOnly: false
  });
}

async function commitDodgeActiveUseOperation(preparation, operationId = "") {
  if (!preparation) return [];
  try {
    return await commitPreparedActiveUseOperations([preparation], { operationId });
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
      const activeUsePreparation = prepareDodgeActiveUseOperation(actor, activeUseKey, activeUseKind, operationId);
      await actor.update({ [`system.resources.${DODGE_RESOURCE_KEY}.value`]: nextValue });
      success = true;
      await commitDodgeActiveUseOperation(activeUsePreparation, operationId);
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
