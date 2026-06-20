import { GRAPPLE_FOLLOW_MOVEMENT_OPTION } from "../constants.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getActorPostureMovementCostMultiplier } from "../canvas/posture-movement.mjs";
import { getDamageCostModifierState, getResourceLimitState } from "./damage-hub.mjs";
import { REACTION_RESOURCE_KEY, getCombatActionPointState, spendCombatActionPoints } from "./reaction-resources.mjs";

export const MOVEMENT_RESOURCE_KEY = "movementPoints";
export const ACTION_RESOURCE_KEY = "actionPoints";
export const MOVEMENT_RESOURCE_PREVIEW_HOOK = "falloutMawMovementResourcePreview";
export const ABILITY_FREE_MOVEMENT_OPTION = "falloutMawAbilityFreeMovement";
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
  const action = getCombatActionPointState(actor);
  if (!movement || !action) return null;

  const movementValue = Math.max(0, toInteger(movement.value));
  const limited = getResourceLimitState(actor).resources;
  const movementAvailable = action.ownTurn ? movementValue : 0;
  const limitedMovement = Math.min(movementAvailable, Math.max(0, toInteger(limited[MOVEMENT_RESOURCE_KEY]?.amount)));
  const limitedAction = action.ownTurn
    ? Math.min(action.value, Math.max(0, toInteger(limited[ACTION_RESOURCE_KEY]?.amount)))
    : 0;
  return {
    movement: {
      key: MOVEMENT_RESOURCE_KEY,
      label: MOVEMENT_RESOURCE_LABEL,
      current: movementValue,
      limited: limitedMovement,
      value: Math.max(0, movementAvailable - limitedMovement),
      max: Math.max(0, toInteger(movement.max))
    },
    action: {
      key: action.key,
      label: action.label,
      current: action.current,
      limited: limitedAction,
      value: Math.max(0, action.value - limitedAction),
      max: action.max
    },
    total: Math.max(0, movementAvailable - limitedMovement) + Math.max(0, action.value - limitedAction)
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
      [state?.action?.key ?? ACTION_RESOURCE_KEY]: actionSpend
    }
  };
}

export function getCombatMovementCost(movement, actor = null) {
  const rawCost = Number(movement?.passed?.cost ?? movement?.cost ?? 0);
  if (!Number.isFinite(rawCost) || rawCost <= 0) return 0;
  return applyCombatMovementCostModifier(actor, Math.ceil(rawCost));
}

export function getCombatMovementAffordabilityCost(movement, actor = null) {
  const cost = getMovementSectionCost(movement?.passed) + getMovementSectionCost(movement?.pending);
  if (cost > 0) return applyCombatMovementCostModifier(actor, Math.ceil(cost));
  return getCombatMovementCost(movement, actor);
}

export function applyCombatMovementCostModifier(actor, cost = 0) {
  const postureCost = Math.ceil(Math.max(0, cost) * getActorPostureMovementCostMultiplier(actor));
  const modifier = getDamageCostModifierState(actor).movement;
  const hasOverride = modifier?.override !== null && modifier?.override !== undefined && modifier?.override !== "";
  const override = hasOverride ? Number(modifier.override) : NaN;
  const multiplier = Number(modifier?.multiplier);
  const perUnitCost = Number.isFinite(override)
    ? override
    : (Number.isFinite(multiplier) ? multiplier : 1) + (Number(modifier?.add) || 0);
  return Math.max(0, Math.ceil(postureCost * Math.max(0, perUnitCost)));
}

/**
 * Measure movement without spending resources. This uses Foundry's route measurement and then applies the same
 * actor-specific modifiers as combat movement spending.
 */
export function measureTheoreticalMovementPathCost(tokenDocument, waypoints = [], options = {}) {
  return measureTheoreticalMovementSegmentsCost(tokenDocument, [{
    from: waypoints[0],
    to: waypoints.at(-1),
    waypoints
  }], options);
}

/** Measure and combine a set of route segments before applying actor movement modifiers once. */
export function measureTheoreticalMovementSegmentsCost(tokenDocument, segments = [], options = {}) {
  if (!tokenDocument?.actor) return 0;
  let rawCost = 0;
  for (const segment of Array.isArray(segments) ? segments : []) {
    const waypoints = Array.isArray(segment?.waypoints)
      ? segment.waypoints.filter(Boolean)
      : [
        segment?.from,
        segment?.to ? {
          ...segment.to,
          action: segment.action ?? segment.to.action,
          terrain: segment.terrain ?? segment.to.terrain,
          snapped: segment.snapped ?? segment.to.snapped
        } : null
      ].filter(Boolean);
    if (waypoints.length < 2) continue;
    rawCost += measureRawMovementPathCost(tokenDocument, waypoints, options);
  }
  if (rawCost <= 0) return 0;
  return applyCombatMovementCostModifier(tokenDocument.actor, Math.ceil(rawCost));
}

function measureRawMovementPathCost(tokenDocument, waypoints = [], options = {}) {
  const measurement = tokenDocument.rendered
    ? tokenDocument.object.measureMovementPath(waypoints, {
      ...(options?.measureOptions ?? options),
      preview: false
    })
    : tokenDocument.measureMovementPath(waypoints, options?.measureOptions ?? options);
  const cost = Number(measurement.cost);
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Foundry returned an invalid movement cost.");
  return cost;
}

export function isCombatMovementTracked(tokenDocument) {
  const combat = game.combat;
  return Boolean(combat && tokenDocument?.actor);
}

export function isGMDebugMovementBypassActive() {
  return Boolean(game.user?.isGM && game.keyboard?.downKeys?.has("AltLeft"));
}

function preventUnaffordableCombatMovement(tokenDocument, movement, operation) {
  if (isGrappleFollowMovement(tokenDocument, operation)) return true;
  if (isAbilityFreeMovement(tokenDocument, operation)) return true;
  if (!isCombatMovementTracked(tokenDocument)) return true;
  if (movement?.method === "undo") return true;
  if (isGMDebugMovementBypassActive()) return true;

  const cost = getCombatMovementAffordabilityCost(movement, tokenDocument.actor);
  if (cost <= 0) return true;

  const state = getCombatMovementResourceState(tokenDocument.actor);
  if (!state) return true;
  if (cost <= state.total) return true;

  ui.notifications.warn(
    `${tokenDocument.actor.name}: не хватает ${MOVEMENT_RESOURCE_LABEL}/${ACTION_RESOURCE_LABEL} для перемещения (${cost} > ${state.total}).`
  );
  return false;
}

async function spendCombatMovementResources(tokenDocument, movement, operation, user) {
  if (!user?.isSelf) return;
  if (isGrappleFollowMovement(tokenDocument, operation)) return;
  if (isAbilityFreeMovement(tokenDocument, operation)) return;
  if (!isCombatMovementTracked(tokenDocument)) return;
  if (movement?.method === "undo") return restoreLastMovementResourceSpending(tokenDocument);
  if (isGMDebugMovementBypassActive()) return;

  const cost = getCombatMovementCost(movement, tokenDocument.actor);
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
  updates[`flags.${FALLOUT_MAW.id}.${MOVEMENT_RESOURCE_SPENDING_FLAG}`] = [
    ...getMovementResourceSpendingStack(actor),
    createMovementResourceSpendingEntry(tokenDocument, movement, {
      [MOVEMENT_RESOURCE_KEY]: movementSpend,
      [state.action.key]: actionSpend
    })
  ].slice(-MOVEMENT_RESOURCE_SPENDING_LIMIT);
  await actor.update(updates);
  if (actionSpend) await spendCombatActionPoints(actor, actionSpend);
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

  for (const key of [MOVEMENT_RESOURCE_KEY, ACTION_RESOURCE_KEY, REACTION_RESOURCE_KEY]) {
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

export async function restoreCombatMovementResources(combat) {
  if (!game.user.isActiveGM) return;
  const actors = getCombatMovementRestoreActors(combat);

  for (const actor of actors.values()) {
    await restoreActorMovementResources(actor);
  }
}

function getCombatMovementRestoreActors(combat) {
  const actors = new Map();
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant.actor;
    if (!actor) continue;
    actors.set(actor.uuid, actor);
  }

  for (const scene of getCombatMovementRestoreScenes(combat)) {
    for (const tokenDocument of scene.tokens?.contents ?? []) {
      const actor = tokenDocument.actor;
      if (!actor) continue;
      actors.set(actor.uuid, actor);
    }
  }

  return actors;
}

function getCombatMovementRestoreScenes(combat) {
  const scenes = new Map();
  const addScene = sceneOrId => {
    const scene = typeof sceneOrId === "string" ? game.scenes?.get(sceneOrId) : sceneOrId;
    if (scene?.id) scenes.set(scene.id, scene);
  };

  addScene(combat?.scene);
  for (const combatant of combat?.combatants ?? []) addScene(combatant.sceneId);
  if (!scenes.size && game.combat?.id === combat?.id) addScene(canvas.scene);
  return scenes.values();
}

export async function restoreActorMovementResources(actor) {
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

export function hasActorCombatMovementInCurrentTurn(actor) {
  if (!actor) return false;
  const currentRound = Math.max(0, toInteger(game.combat?.round));
  return getMovementResourceSpendingStack(actor).some(entry => {
    if (String(entry?.actorUuid ?? "") !== String(actor.uuid ?? "")) return false;
    if (currentRound > 0 && toInteger(entry?.round) !== currentRound) return false;
    const resources = entry?.resources ?? {};
    return [MOVEMENT_RESOURCE_KEY, ACTION_RESOURCE_KEY, REACTION_RESOURCE_KEY]
      .some(key => Math.max(0, toInteger(resources[key])) > 0);
  });
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

function isGrappleFollowMovement(tokenDocument, operation) {
  return Boolean(operation?.[GRAPPLE_FOLLOW_MOVEMENT_OPTION]?.[tokenDocument?.id]);
}

function isAbilityFreeMovement(tokenDocument, operation) {
  return Boolean(operation?.[ABILITY_FREE_MOVEMENT_OPTION]?.[tokenDocument?.id]);
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
