import { GRAPPLE_FOLLOW_MOVEMENT_OPTION } from "../constants.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getActorPostureMovementCostMultiplier } from "../canvas/posture-movement.mjs";
import { getDamageCostModifierState, getResourceLimitState } from "./damage-hub.mjs";
import { REACTION_RESOURCE_KEY, getCombatActionPointState, spendCombatActionPoints } from "./reaction-resources.mjs";
import { beginCombatResourceSpending, notifyCombatResourcesSpent } from "./resource-spending.mjs";
import { ACTION_RESOURCE_KEY } from "./strict-action-points.mjs";
import { getActorActiveCombat, isActorInActiveCombat } from "./combat-membership.mjs";

export const MOVEMENT_RESOURCE_KEY = "movementPoints";
export { ACTION_RESOURCE_KEY };
export const MOVEMENT_RESOURCE_PREVIEW_HOOK = "falloutMawMovementResourcePreview";
export const ABILITY_FREE_MOVEMENT_OPTION = "falloutMawAbilityFreeMovement";
const MOVEMENT_RESOURCE_SPENDING_FLAG = "movementResourceSpending";
const MOVEMENT_RESOURCE_SPENDING_LIMIT = 50;
const movementResourceSpendingQueues = new Map();
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
  return applyCombatMovementCostProfile(getCombatMovementCostProfile(actor), cost);
}

/**
 * Convert an adjusted OP budget back into Foundry's raw movement-cost limit.
 *
 * Token#planMovement constrains raw grid/terrain cost, while Fallout MaW
 * applies posture and damage multipliers afterwards. The conversion is
 * monotonic and keeps the native planner's hard limit aligned with the OP
 * counter (for example, 8 OP at 2 OP per cell becomes maxCost 4).
 */
export function getRawMovementCostLimit(actor, adjustedBudget = Infinity) {
  const budget = Number(adjustedBudget);
  if (!Number.isFinite(budget)) return Infinity;
  if (budget < 0) return 0;

  const profile = getCombatMovementCostProfile(actor);
  const adjusted = rawCost => applyCombatMovementCostProfile(profile, Math.ceil(Math.max(0, rawCost)));
  if (adjusted(1) === 0) return Infinity;

  let lower = 0;
  let upper = Math.max(1, Math.floor(budget) + 1);
  const maximumSearchCost = Number.MAX_SAFE_INTEGER;
  while ((upper < maximumSearchCost) && (adjusted(upper) <= budget)) {
    lower = upper;
    upper = Math.min(maximumSearchCost, upper * 2);
  }
  if (adjusted(upper) <= budget) return Infinity;

  while ((lower + 1) < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (adjusted(middle) <= budget) lower = middle;
    else upper = middle;
  }
  return lower;
}

function getCombatMovementCostProfile(actor) {
  const postureMultiplierValue = Number(getActorPostureMovementCostMultiplier(actor));
  const postureMultiplier = Number.isFinite(postureMultiplierValue)
    ? Math.max(0, postureMultiplierValue)
    : 1;
  const modifier = getDamageCostModifierState(actor).movement;
  const hasOverride = modifier?.override !== null && modifier?.override !== undefined && modifier?.override !== "";
  const override = hasOverride ? Number(modifier.override) : NaN;
  const multiplier = Number(modifier?.multiplier);
  const perUnitCost = Number.isFinite(override)
    ? override
    : (Number.isFinite(multiplier) ? multiplier : 1) + (Number(modifier?.add) || 0);
  const normalizedPerUnitCost = Math.max(0, perUnitCost);
  return {
    key: JSON.stringify([postureMultiplier, normalizedPerUnitCost]),
    postureMultiplier,
    perUnitCost: normalizedPerUnitCost
  };
}

function applyCombatMovementCostProfile(profile = {}, cost = 0) {
  const postureMultiplier = Number.isFinite(Number(profile?.postureMultiplier))
    ? Math.max(0, Number(profile.postureMultiplier))
    : 1;
  const perUnitCost = Number.isFinite(Number(profile?.perUnitCost))
    ? Math.max(0, Number(profile.perUnitCost))
    : 1;
  const postureCost = Math.ceil(Math.max(0, cost) * postureMultiplier);
  return Math.max(0, Math.ceil(postureCost * perUnitCost));
}

export function calculateCombatMovementCostTrancheDelta(
  profile = {},
  priorRawCost = 0,
  priorAdjustedCost = 0,
  rawCost = 0
) {
  const totalRawCost = Math.max(0, Number(priorRawCost) || 0) + Math.max(0, Number(rawCost) || 0);
  const totalAdjustedCost = applyCombatMovementCostProfile(profile, Math.ceil(totalRawCost));
  return Math.max(0, totalAdjustedCost - Math.max(0, Number(priorAdjustedCost) || 0));
}

/**
 * Measure movement without spending resources. This uses Foundry's route measurement and then applies the same
 * actor-specific modifiers as combat movement spending.
 */
export function measureTheoreticalMovementPathCost(tokenDocument, waypoints = [], options = {}) {
  if (!tokenDocument?.actor) return 0;
  const normalized = Array.isArray(waypoints) ? waypoints.filter(Boolean) : [];
  if (normalized.length < 2) return 0;
  const rawCost = measureRawMovementPathIncrementCost(tokenDocument, normalized, options);
  if (rawCost <= 0) return 0;
  return applyCombatMovementCostModifier(tokenDocument.actor, Math.ceil(rawCost));
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
  const measurement = measureRawMovementPath(tokenDocument, waypoints, options);
  const cost = Number(measurement.cost);
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Foundry returned an invalid movement cost.");
  return cost;
}

function measureRawMovementPath(tokenDocument, waypoints = [], options = {}) {
  const preview = Boolean(options?.preview);
  const measureOptions = options?.measureOptions ?? options;
  return tokenDocument.rendered
    ? tokenDocument.object.measureMovementPath(waypoints, {
      ...measureOptions,
      preview
    })
    : tokenDocument.measureMovementPath(waypoints, measureOptions);
}

/**
 * Measure only the new route while preserving Foundry's accumulated movement
 * history. This matters for alternating diagonals and any custom cumulative
 * movement-cost aggregator.
 */
function measureRawMovementPathIncrementCost(tokenDocument, waypoints = [], options = {}) {
  const history = Array.from(
    Array.isArray(options?.history) ? options.history : (tokenDocument?.movementHistory ?? [])
  );
  if (!history.length) return measureRawMovementPathCost(tokenDocument, waypoints, options);

  const prefix = [...history];
  const previous = prefix.at(-1);
  const origin = waypoints[0];
  if (!areMovementPositionsEqual(tokenDocument, previous, origin)) {
    prefix.push({
      x: origin.x,
      y: origin.y,
      elevation: origin.elevation,
      width: origin.width,
      height: origin.height,
      depth: origin.depth,
      shape: origin.shape,
      level: origin.level,
      action: "displace",
      cost: 0,
      snapped: false,
      explicit: false,
      checkpoint: true
    });
  }

  const measurement = measureRawMovementPath(tokenDocument, [...prefix, ...waypoints], options);
  const total = Number(measurement?.cost);
  const prefixCost = Number(measurement?.waypoints?.[prefix.length - 1]?.cost ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(prefixCost) || total < prefixCost) {
    throw new Error("Foundry returned an invalid cumulative movement cost.");
  }
  return total - prefixCost;
}

function areMovementPositionsEqual(tokenDocument, left = {}, right = {}) {
  const compare = tokenDocument?.constructor?.arePositionsEqual;
  if (typeof compare === "function") return Boolean(compare.call(tokenDocument.constructor, left, right));
  return Number(left?.x) === Number(right?.x)
    && Number(left?.y) === Number(right?.y)
    && Number(left?.elevation ?? 0) === Number(right?.elevation ?? 0);
}

export function isCombatMovementTracked(tokenDocument) {
  return isActorInActiveCombat(tokenDocument?.actor);
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

  const cost = getCombatMovementAffordabilityDelta(tokenDocument.actor, tokenDocument, movement);
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
  if (movement?.method === "undo") {
    return runMovementResourceSpendingSerially(
      tokenDocument.actor,
      () => restoreLastMovementResourceSpending(tokenDocument)
    );
  }
  if (isGMDebugMovementBypassActive()) return;

  const actor = tokenDocument.actor;
  const finishSpending = beginCombatResourceSpending(actor);
  try {
    await runMovementResourceSpendingSerially(actor, async () => {
      await waitForMovementAnimation(movement);
      if (!isCombatMovementTracked(tokenDocument)) return;

      const costProfile = getCombatMovementCostProfile(actor);
      const cost = getCombatMovementSpendDelta(actor, tokenDocument, movement, costProfile);
      const rawCost = getMovementSectionCost(movement?.passed);
      if (!(rawCost > 0)) return;
      const state = getCombatMovementResourceState(actor);
      if (!state || cost > state.total) return;

      const movementSpend = Math.min(cost, state.movement.value);
      const actionSpend = cost - movementSpend;

      const updates = {};
      if (movementSpend) updates[`system.resources.${MOVEMENT_RESOURCE_KEY}.value`] = Math.max(0, state.movement.current - movementSpend);
      updates[`flags.${FALLOUT_MAW.id}.${MOVEMENT_RESOURCE_SPENDING_FLAG}`] = [
        ...getMovementResourceSpendingStack(actor),
        createMovementResourceSpendingEntry(tokenDocument, movement, {
          [MOVEMENT_RESOURCE_KEY]: movementSpend,
          [state.action.key]: actionSpend
        }, { adjustedCost: cost, costProfileKey: costProfile.key })
      ].slice(-MOVEMENT_RESOURCE_SPENDING_LIMIT);
      await actor.update(updates);
      if (actionSpend) await spendCombatActionPoints(actor, actionSpend, { suppressResourceNotification: true });
      if (movementSpend || actionSpend) {
        await notifyCombatResourcesSpent(actor, {
          [MOVEMENT_RESOURCE_KEY]: movementSpend,
          [state.action.key]: actionSpend
        }, { type: "movement", tokenDocument, movement, operation });
      }
    });
  } finally {
    finishSpending();
  }
}

async function runMovementResourceSpendingSerially(actor, operation) {
  const actorKey = String(actor?.uuid ?? actor?.id ?? "");
  if (!actorKey) return operation();
  const previous = movementResourceSpendingQueues.get(actorKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  movementResourceSpendingQueues.set(actorKey, current);
  try {
    return await current;
  } finally {
    if (movementResourceSpendingQueues.get(actorKey) === current) movementResourceSpendingQueues.delete(actorKey);
  }
}

function getCombatMovementSpendDelta(
  actor,
  tokenDocument,
  movement = {},
  costProfile = getCombatMovementCostProfile(actor)
) {
  const rawCost = getMovementSectionCost(movement?.passed);
  if (!(rawCost > 0)) return 0;
  const { rawCost: priorRawCost, adjustedCost: priorAdjustedCost } = getCurrentMovementSpendingTranche(
    actor,
    tokenDocument,
    movement,
    costProfile.key
  );
  return calculateCombatMovementCostTrancheDelta(costProfile, priorRawCost, priorAdjustedCost, rawCost);
}

function getCombatMovementAffordabilityDelta(actor, tokenDocument, movement = {}) {
  const remainingRawCost = getMovementSectionCost(movement?.passed) + getMovementSectionCost(movement?.pending);
  if (!(remainingRawCost > 0)) return 0;
  const costProfile = getCombatMovementCostProfile(actor);
  const { rawCost: priorRawCost, adjustedCost: priorAdjustedCost } = getCurrentMovementSpendingTranche(
    actor,
    tokenDocument,
    movement,
    costProfile.key
  );
  return calculateCombatMovementCostTrancheDelta(
    costProfile,
    priorRawCost,
    priorAdjustedCost,
    remainingRawCost
  );
}

function getCurrentMovementSpendingTranche(actor, tokenDocument, movement = {}, costProfileKey = "") {
  const rootId = getMovementRootId(movement);
  const sceneId = tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "";
  const tokenId = tokenDocument?.id ?? "";
  const entries = getMovementResourceSpendingStack(actor).filter(entry => (
    entry?.sceneId === sceneId
    && entry?.tokenId === tokenId
    && String(entry?.movementRootId ?? entry?.movementId ?? "") === rootId
  ));
  let rawCost = 0;
  let adjustedCost = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (String(entry?.costProfileKey ?? "") !== String(costProfileKey ?? "")) break;
    rawCost += Math.max(0, Number(entry?.rawCost) || 0);
    adjustedCost += Math.max(0, Number(entry?.adjustedCost)
      || Object.values(entry?.resources ?? {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0));
  }
  return { rawCost, adjustedCost };
}

function getMovementRootId(movement = {}) {
  return String(movement?.chain?.at?.(0) ?? movement?.id ?? "");
}

async function restoreLastMovementResourceSpending(tokenDocument) {
  const actor = tokenDocument.actor;
  const stack = getMovementResourceSpendingStack(actor);
  const index = findLastMovementResourceSpendingIndex(stack, tokenDocument);
  if (index < 0) return;

  const lastEntry = stack[index];
  const movementRootId = String(lastEntry?.movementRootId ?? lastEntry?.movementId ?? "");
  const restoredEntries = stack.filter(entry => (
    movementResourceSpendingEntryMatchesToken(entry, tokenDocument)
    && String(entry?.movementRootId ?? entry?.movementId ?? "") === movementRootId
  ));
  const restoredResources = restoredEntries.reduce((totals, entry) => {
    for (const [key, value] of Object.entries(entry?.resources ?? {})) {
      totals[key] = (totals[key] ?? 0) + Math.max(0, toInteger(value));
    }
    return totals;
  }, {});
  const restoredIds = new Set(restoredEntries.map(entry => entry?.id).filter(Boolean));
  const nextStack = stack.filter(entry => (
    entry?.id
      ? !restoredIds.has(entry.id)
      : !(movementResourceSpendingEntryMatchesToken(entry, tokenDocument)
        && String(entry?.movementRootId ?? entry?.movementId ?? "") === movementRootId)
  ));
  const updates = {
    [`flags.${FALLOUT_MAW.id}.${MOVEMENT_RESOURCE_SPENDING_FLAG}`]: nextStack
  };

  for (const key of [MOVEMENT_RESOURCE_KEY, ACTION_RESOURCE_KEY, REACTION_RESOURCE_KEY]) {
    const resource = actor.system?.resources?.[key];
    if (!resource) continue;

    const current = toInteger(resource.value);
    const min = Math.max(0, toInteger(resource.min));
    const max = Math.max(min, toInteger(resource.max));
    const restored = Math.min(max, Math.max(min, current + Math.max(0, toInteger(restoredResources[key]))));
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

function createMovementResourceSpendingEntry(tokenDocument, movement, resources, {
  adjustedCost = null,
  costProfileKey = ""
} = {}) {
  const actor = tokenDocument?.actor;
  const rawCost = Math.max(0, getMovementSectionCost(movement?.passed));
  return {
    id: foundry.utils.randomID(),
    movementId: movement?.id ?? "",
    movementRootId: getMovementRootId(movement),
    rawCost,
    adjustedCost: Math.max(0, Number(adjustedCost) || 0),
    costProfileKey: String(costProfileKey ?? ""),
    actorUuid: actor?.uuid ?? "",
    sceneId: tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "",
    tokenId: tokenDocument?.id ?? "",
    round: getActorActiveCombat(actor)?.round ?? 0,
    resources
  };
}

function getMovementResourceSpendingStack(actor) {
  const stack = actor?.getFlag?.(FALLOUT_MAW.id, MOVEMENT_RESOURCE_SPENDING_FLAG);
  return Array.isArray(stack) ? stack.filter(entry => entry && typeof entry === "object") : [];
}

export function hasActorCombatMovementInCurrentTurn(actor) {
  if (!actor) return false;
  const currentRound = Math.max(0, toInteger(getActorActiveCombat(actor)?.round));
  return getMovementResourceSpendingStack(actor).some(entry => {
    if (String(entry?.actorUuid ?? "") !== String(actor.uuid ?? "")) return false;
    if (currentRound > 0 && toInteger(entry?.round) !== currentRound) return false;
    const resources = entry?.resources ?? {};
    return [MOVEMENT_RESOURCE_KEY, ACTION_RESOURCE_KEY, REACTION_RESOURCE_KEY]
      .some(key => Math.max(0, toInteger(resources[key])) > 0);
  });
}

function findLastMovementResourceSpendingIndex(stack, tokenDocument) {
  return stack.findLastIndex(entry => movementResourceSpendingEntryMatchesToken(entry, tokenDocument));
}

function movementResourceSpendingEntryMatchesToken(entry, tokenDocument) {
  const actorUuid = tokenDocument?.actor?.uuid ?? "";
  const sceneId = tokenDocument?.parent?.id ?? tokenDocument?.scene?.id ?? "";
  const tokenId = tokenDocument?.id ?? "";
  return entry?.actorUuid === actorUuid
    && entry?.tokenId === tokenId
    && (!entry?.sceneId || !sceneId || entry.sceneId === sceneId);
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
