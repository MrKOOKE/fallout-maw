import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getResourceLimitState } from "./damage-hub.mjs";

export const MOVEMENT_RESOURCE_KEY = "movementPoints";
export const ACTION_RESOURCE_KEY = "actionPoints";
export const MOVEMENT_RESOURCE_PREVIEW_HOOK = "falloutMawMovementResourcePreview";
const MOVEMENT_RESOURCE_SPENDING_FLAG = "movementResourceSpending";
const MOVEMENT_RESOURCE_SPENDING_LIMIT = 50;
const MOVEMENT_RESOURCE_LABEL = "ОП";
const ACTION_RESOURCE_LABEL = "ОД";

export const MOVEMENT_RULER_COLORS = Object.freeze({
  movement: 0x43c96b,
  action: 0xf2b84b,
  exhausted: 0xcf4f4f
});

export function registerCombatMovementHooks() {
  Hooks.on("preMoveToken", preventUnaffordableCombatMovement);
  Hooks.on("moveToken", spendCombatMovementResources);
  Hooks.on("combatStart", combat => restoreCombatMovementResources(combat));
  Hooks.on("combatTurnChange", (combat, previous, current) => {
    if (!game.user.isActiveGM) return;
    if (!combat?.started) return;
    if (toInteger(current?.round) <= 1) return;
    if (toInteger(current?.round) <= toInteger(previous?.round)) return;
    return restoreCombatMovementResources(combat);
  });
  Hooks.on("deleteCombat", combat => restoreCombatMovementResources(combat));
  Hooks.on("createCombatant", combatant => {
    const combat = combatant?.combat;
    if (!game.user.isActiveGM || !combat?.started) return;
    return restoreActorMovementResources(combatant.actor);
  });
}

export function getCombatMovementResourceState(actor) {
  const resources = actor?.system?.resources;
  const movement = resources?.[MOVEMENT_RESOURCE_KEY];
  const action = resources?.[ACTION_RESOURCE_KEY];
  if (!movement || !action) return null;

  const movementValue = Math.max(0, toInteger(movement.value));
  const actionValue = Math.max(0, toInteger(action.value));
  const limited = getResourceLimitState(actor).resources;
  const limitedMovement = Math.min(movementValue, Math.max(0, toInteger(limited[MOVEMENT_RESOURCE_KEY]?.amount)));
  const limitedAction = Math.min(actionValue, Math.max(0, toInteger(limited[ACTION_RESOURCE_KEY]?.amount)));
  return {
    movement: {
      key: MOVEMENT_RESOURCE_KEY,
      label: MOVEMENT_RESOURCE_LABEL,
      current: movementValue,
      limited: limitedMovement,
      value: Math.max(0, movementValue - limitedMovement),
      max: Math.max(0, toInteger(movement.max))
    },
    action: {
      key: ACTION_RESOURCE_KEY,
      label: ACTION_RESOURCE_LABEL,
      current: actionValue,
      limited: limitedAction,
      value: Math.max(0, actionValue - limitedAction),
      max: Math.max(0, toInteger(action.max))
    },
    total: Math.max(0, movementValue - limitedMovement) + Math.max(0, actionValue - limitedAction)
  };
}

export function publishCombatMovementResourcePreview(tokenDocument, cost = 0) {
  Hooks.callAll(MOVEMENT_RESOURCE_PREVIEW_HOOK, createCombatMovementResourcePreview(tokenDocument, cost));
}

export function clearCombatMovementResourcePreview(tokenDocument) {
  Hooks.callAll(MOVEMENT_RESOURCE_PREVIEW_HOOK, {
    actorUuid: tokenDocument?.actor?.uuid ?? "",
    sceneId: tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "",
    tokenId: tokenDocument?.id ?? "",
    resources: {}
  });
}

export function createCombatMovementResourcePreview(tokenDocument, cost = 0) {
  const state = getCombatMovementResourceState(tokenDocument?.actor);
  const normalizedCost = Math.max(0, toInteger(cost));
  const movementSpend = Math.min(normalizedCost, state?.movement?.value ?? 0);
  const actionSpend = Math.min(Math.max(0, normalizedCost - movementSpend), state?.action?.value ?? 0);

  return {
    actorUuid: tokenDocument?.actor?.uuid ?? "",
    sceneId: tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "",
    tokenId: tokenDocument?.id ?? "",
    cost: normalizedCost,
    resources: {
      [MOVEMENT_RESOURCE_KEY]: movementSpend,
      [ACTION_RESOURCE_KEY]: actionSpend
    }
  };
}

export function getCombatMovementCost(movement) {
  const rawCost = Number(movement?.passed?.cost ?? movement?.cost ?? 0);
  if (!Number.isFinite(rawCost) || rawCost <= 0) return 0;
  return Math.ceil(rawCost);
}

export function getCombatMovementAffordabilityCost(movement) {
  const cost = getMovementSectionCost(movement?.passed) + getMovementSectionCost(movement?.pending);
  if (cost > 0) return Math.ceil(cost);
  return getCombatMovementCost(movement);
}

export function isCombatMovementTracked(tokenDocument) {
  const combat = game.combat;
  if (!combat?.started || !tokenDocument?.actor) return false;

  const tokenId = tokenDocument.id;
  const sceneId = tokenDocument.parent?.id ?? tokenDocument.scene?.id ?? null;
  return combat.combatants.some(combatant => {
    if (combatant.tokenId !== tokenId) return false;
    if (sceneId && combatant.sceneId && combatant.sceneId !== sceneId) return false;
    return combatant.actor?.uuid === tokenDocument.actor?.uuid;
  });
}

export function isGMDebugMovementBypassActive() {
  return Boolean(game.user?.isGM && game.keyboard?.downKeys?.has("AltLeft"));
}

function preventUnaffordableCombatMovement(tokenDocument, movement) {
  if (!isCombatMovementTracked(tokenDocument)) return true;
  if (movement?.method === "undo") return true;
  if (isGMDebugMovementBypassActive()) return true;

  const cost = getCombatMovementAffordabilityCost(movement);
  if (cost <= 0) return true;

  const state = getCombatMovementResourceState(tokenDocument.actor);
  if (!state) return true;
  if (cost <= state.total) return true;

  ui.notifications.warn(
    `${tokenDocument.actor.name}: не хватает ${MOVEMENT_RESOURCE_LABEL}/${ACTION_RESOURCE_LABEL} для перемещения (${cost} > ${state.total}).`
  );
  return false;
}

async function spendCombatMovementResources(tokenDocument, movement, _operation, user) {
  if (!user?.isSelf) return;
  if (!isCombatMovementTracked(tokenDocument)) return;
  if (movement?.method === "undo") return restoreLastMovementResourceSpending(tokenDocument);
  if (isGMDebugMovementBypassActive()) return;

  const cost = getCombatMovementCost(movement);
  if (cost <= 0) return;

  await waitForMovementAnimation(movement);

  const actor = tokenDocument.actor;
  const state = getCombatMovementResourceState(actor);
  if (!state || cost > state.total) return;

  const movementSpend = Math.min(cost, state.movement.value);
  const actionSpend = cost - movementSpend;
  if (!movementSpend && !actionSpend) return;

  const updates = {};
  if (movementSpend) updates[`system.resources.${MOVEMENT_RESOURCE_KEY}.value`] = Math.max(0, state.movement.current - movementSpend);
  if (actionSpend) updates[`system.resources.${ACTION_RESOURCE_KEY}.value`] = Math.max(0, state.action.current - actionSpend);
  updates[`flags.${FALLOUT_MAW.id}.${MOVEMENT_RESOURCE_SPENDING_FLAG}`] = [
    ...getMovementResourceSpendingStack(actor),
    createMovementResourceSpendingEntry(tokenDocument, movement, {
      [MOVEMENT_RESOURCE_KEY]: movementSpend,
      [ACTION_RESOURCE_KEY]: actionSpend
    })
  ].slice(-MOVEMENT_RESOURCE_SPENDING_LIMIT);
  await actor.update(updates);
}

async function restoreLastMovementResourceSpending(tokenDocument) {
  const actor = tokenDocument.actor;
  const stack = getMovementResourceSpendingStack(actor);
  const index = findLastMovementResourceSpendingIndex(stack, tokenDocument);
  if (index < 0) return;

  const entry = stack[index];
  const nextStack = stack.slice();
  nextStack.splice(index, 1);
  const updates = {
    [`flags.${FALLOUT_MAW.id}.${MOVEMENT_RESOURCE_SPENDING_FLAG}`]: nextStack
  };

  for (const key of [MOVEMENT_RESOURCE_KEY, ACTION_RESOURCE_KEY]) {
    const resource = actor.system?.resources?.[key];
    if (!resource) continue;

    const current = toInteger(resource.value);
    const min = Math.max(0, toInteger(resource.min));
    const max = Math.max(min, toInteger(resource.max));
    const restored = Math.min(max, Math.max(min, current + Math.max(0, toInteger(entry?.resources?.[key]))));
    updates[`system.resources.${key}.value`] = restored;
    updates[`system.resources.${key}.spent`] = Math.max(0, max - restored);
  }

  await actor.update(updates);
}

async function restoreCombatMovementResources(combat) {
  if (!game.user.isActiveGM) return;
  const actors = new Map();
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant.actor;
    if (!actor) continue;
    actors.set(actor.uuid, actor);
  }

  for (const actor of actors.values()) {
    await restoreActorMovementResources(actor);
  }
}

async function restoreActorMovementResources(actor) {
  if (!actor?.isOwner) return;

  const updates = {
    [`flags.${FALLOUT_MAW.id}.${MOVEMENT_RESOURCE_SPENDING_FLAG}`]: []
  };
  for (const key of [MOVEMENT_RESOURCE_KEY, ACTION_RESOURCE_KEY]) {
    const resource = actor.system?.resources?.[key];
    if (!resource) continue;
    const max = Math.max(0, toInteger(resource.max));
    updates[`system.resources.${key}.value`] = max;
    updates[`system.resources.${key}.spent`] = 0;
  }

  if (Object.keys(updates).length) await actor.update(updates);
}

function createMovementResourceSpendingEntry(tokenDocument, movement, resources) {
  return {
    id: foundry.utils.randomID(),
    movementId: movement?.id ?? "",
    actorUuid: tokenDocument?.actor?.uuid ?? "",
    sceneId: tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "",
    tokenId: tokenDocument?.id ?? "",
    round: game.combat?.round ?? 0,
    resources
  };
}

function getMovementResourceSpendingStack(actor) {
  const stack = actor?.getFlag?.(FALLOUT_MAW.id, MOVEMENT_RESOURCE_SPENDING_FLAG);
  return Array.isArray(stack) ? stack.filter(entry => entry && typeof entry === "object") : [];
}

function findLastMovementResourceSpendingIndex(stack, tokenDocument) {
  const actorUuid = tokenDocument?.actor?.uuid ?? "";
  const sceneId = tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "";
  const tokenId = tokenDocument?.id ?? "";
  return stack.findLastIndex(entry => (
    entry?.actorUuid === actorUuid
    && entry?.tokenId === tokenId
    && (!entry?.sceneId || !sceneId || entry.sceneId === sceneId)
  ));
}

async function waitForMovementAnimation(movement) {
  try {
    await movement?.animation?.ended;
  } catch (_error) {
    // Movement resource spending is best-effort after whatever animation state Foundry exposes.
  }
}

function getMovementSectionCost(section) {
  const cost = Number(section?.cost ?? 0);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  return cost;
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
