import { SYSTEM_ID } from "../constants.mjs";
import { COMBAT_LIFECYCLE_CONTEXT_OPTION } from "./combat-lifecycle-lease.mjs";
import { getTokenActionHudIcons } from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { notifyCombatResourcesSpent } from "./resource-spending.mjs";
import { getActorResourceLimitAmount } from "./resource-limits.mjs";
import {
  ACTION_RESOURCE_KEY,
  canSpendStrictActionPoints,
  getActorActiveCombat,
  getStrictActionPointState,
  isActorInActiveCombat,
  refundStrictActionPointReceipt,
  spendStrictActionPointsWithReceipt,
  spendStrictActionPoints
} from "./strict-action-points.mjs";
import { actorHasIncapacitatingStatus } from "./reaction-hub.mjs";
import {
  MOVEMENT_RESOURCE_KEY,
  buildActorMovementResourceRestoreUpdate,
  restoreCombatMovementResources
} from "./movement-resources.mjs";
import {
  initializeCombatDodgeResources,
  restoreActorDodgeResource
} from "./dodge-resource.mjs";
import {
  callActorTurnEndHandlers,
  callActorTurnStartPreparedHandlers
} from "./turn-events.mjs";
import {
  BLOCK_TURN_ACTOR_OPTION,
  BLOCK_TURN_STATE_FLAG,
  TURN_ORDER_SCHEMES,
  getActiveBlockProgress,
  getCombatTurnBlocks,
  getCombatTurnOrderScheme,
  isActorInActiveBlock,
  isActorPendingInActiveBlock,
  isBlockTurnOrderEnabled,
  isCombatantAutoCompleted,
  markActorPreparedInState
} from "./turn-order-blocks.mjs";

export const REACTION_RESOURCE_KEY = "reactionPoints";
export const ONE_TIME_ACTION_POINTS_KEY = "system.resources.actionPoints.once";
export const ONE_TIME_REACTION_POINTS_FLAG = "oneTimeReactionPoints";
export {
  canSpendStrictActionPoints,
  getActorActiveCombat,
  getStrictActionPointState,
  isActorInActiveCombat,
  refundStrictActionPointReceipt,
  spendStrictActionPointsWithReceipt,
  spendStrictActionPoints
};

export const TURN_CONVERSION_MODES = Object.freeze({
  dodge: "dodge",
  reaction: "reaction",
  none: "none",
  skip: "skip"
});

const DODGE_RESOURCE_KEY = "dodge";
const REACTION_UPDATE_OPTION = "falloutMawReactionResourceUpdate";
const REACTION_DODGE_EFFECT_FLAG = "reactionDodgeConversion";
const REACTION_POINTS_EFFECT_FLAG = "reactionPointsConversion";
const ONE_TIME_ACTION_EFFECT_FLAG = "oneTimeActionPoints";
const COMBATANT_DEFEATED_SYNC_FLAG = "incapacitatedDefeated";
const IN_TURN_REACTION_SOURCE = "inTurnReaction";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const DODGE_CONVERSION_MULTIPLIER = 5;
const REACTION_FILL_COLOR = "#f2f2eb";
const ONE_TIME_RESOURCE_FILL_COLOR = "#b9d9ff";
const CLEAR_EFFECT_DURATION_UPDATE = Object.freeze({
  start: null,
  "duration.value": null,
  "duration.expiry": null,
  "duration.expired": false
});
const INCAPACITATING_COMBATANT_STATUSES = new Set(["dead", "unconscious"]);

let advancingDefeatedTurnKey = "";
const combatReactionResourceInitializations = new WeakMap();
const queuedDefeatedActorSyncs = new Map();

export function registerReactionResourceHooks() {
  Hooks.on("updateActor", (actor, changes, options) => {
    if (options?.[REACTION_UPDATE_OPTION]) return;
    const value = foundry.utils.getProperty(changes, `system.resources.${REACTION_RESOURCE_KEY}.value`);
    if (value === undefined) return;
    void convertInTurnReactionPoints(actor, value);
  });

  Hooks.on("createActiveEffect", effect => queueActorDefeatedCombatantSyncForEffect(effect));
  Hooks.on("updateActiveEffect", (effect, changes) => {
    queueActorDefeatedCombatantSyncForEffect(effect, {
      statusMutation: hasActiveEffectStatusUpdate(changes)
    });
  });
  Hooks.on("deleteActiveEffect", effect => queueActorDefeatedCombatantSyncForEffect(effect));
  Hooks.on("combatStart", (combat, updateData) => {
    prepareCombatStartDefeatedTurn(combat, updateData);
    queueCombatReactionResourceInitialization(combat, updateData);
  });
}

async function prepareActiveBlockTurnStart(combat, { lifecycleContextId = "" } = {}) {
  const progress = getActiveBlockProgress(combat);
  if (!progress) return undefined;

  let state = progress.state;
  let changed = false;
  const prepared = new Set(progress.preparedActorUuids);
  const seenActors = new Set();

  for (const combatant of progress.block.combatants) {
    const actor = combatant.actor;
    if (!actor?.uuid || seenActors.has(actor.uuid)) continue;
    seenActors.add(actor.uuid);
    if (isCombatantAutoCompleted(combatant)) {
      await syncActorDefeatedCombatants(actor, {
        combat,
        advanceCurrent: false,
        lifecycleContextId
      });
      continue;
    }
    if (!prepared.has(actor.uuid)) {
      await prepareActorTurnStart(actor, { combat });
      state = markActorPreparedInState(combat, actor, state);
      prepared.add(actor.uuid);
      changed = true;
    }
    await syncActorDefeatedCombatants(actor, {
      combat,
      advanceCurrent: false,
      lifecycleContextId
    });
  }

  if (changed) {
    await combat.update({
      [`flags.${SYSTEM_ID}.${BLOCK_TURN_STATE_FLAG}`]: state
    }, createCombatLifecycleOptions({ turnEvents: false }, lifecycleContextId));
  }
  return undefined;
}

export async function prepareActorTurnStart(actor, { combat = game.combat } = {}) {
  if (!actor?.isOwner) return;
  await deleteTurnStartResourceEffects(actor);

  const updates = buildActorMovementResourceRestoreUpdate(actor);
  const reaction = actor.system?.resources?.[REACTION_RESOURCE_KEY];
  if (reaction) {
    const max = Math.max(0, toInteger(reaction.max));
    if (toInteger(reaction.value) !== 0) {
      updates[`system.resources.${REACTION_RESOURCE_KEY}.value`] = 0;
    }
    if (toInteger(reaction.spent) !== max) {
      updates[`system.resources.${REACTION_RESOURCE_KEY}.spent`] = max;
    }
  }
  if (Object.keys(updates).length) await actor.update(updates, { [REACTION_UPDATE_OPTION]: true });

  await restoreActorDodgeResource(actor, { mode: "round" });
  await callActorTurnStartPreparedHandlers({ actor, combat });
}

async function syncCombatDefeatedCombatants(combat, {
  advanceCurrent = false,
  lifecycleContextId = ""
} = {}) {
  if (!game.user?.isActiveGM || !combat) return false;
  const actors = new Map();
  for (const combatant of combat.combatants ?? []) {
    if (combatant.actor) actors.set(combatant.actor.uuid, combatant.actor);
  }
  let changed = false;
  for (const actor of actors.values()) {
    changed = (await syncActorDefeatedCombatants(actor, {
      combat,
      advanceCurrent,
      lifecycleContextId
    })) || changed;
  }
  return changed;
}

export async function syncActorDefeatedCombatants(actor, {
  combat = game.combat,
  advanceCurrent = false,
  lifecycleContextId = ""
} = {}) {
  if (!game.user?.isActiveGM || !combat || !actor?.uuid) return false;
  const freshActor = fromUuidSync(actor.uuid) ?? actor;
  const defeated = actorHasIncapacitatingStatus(freshActor);
  const combatants = Array.from(combat.combatants ?? [])
    .filter(combatant => combatant.actor?.uuid === freshActor.uuid);
  let changed = false;
  for (const combatant of combatants) {
    changed = (await syncCombatantDefeatedState(combatant, defeated, {
      lifecycleContextId
    })) || changed;
  }
  if (defeated && advanceCurrent) {
    changed = (await advanceCurrentDefeatedTurn(combat, freshActor, {
      lifecycleContextId
    })) || changed;
  }
  return changed;
}

async function syncCombatantDefeatedState(combatant, defeated, {
  lifecycleContextId = ""
} = {}) {
  const syncData = combatant.getFlag?.(SYSTEM_ID, COMBATANT_DEFEATED_SYNC_FLAG);
  const hasSyncFlag = Boolean(syncData);
  if (defeated) {
    if (combatant.defeated && hasSyncFlag) return false;
    const previousDefeated = hasSyncFlag
      ? Boolean(syncData?.previousDefeated)
      : Boolean(combatant.defeated);
    const update = {
      [`flags.${SYSTEM_ID}.${COMBATANT_DEFEATED_SYNC_FLAG}`]: { previousDefeated }
    };
    if (!combatant.defeated) update.defeated = true;
    await combatant.update(update, createCombatLifecycleOptions({
      turnEvents: false
    }, lifecycleContextId));
    return true;
  }

  if (!hasSyncFlag) return false;
  const update = {
    [`flags.${SYSTEM_ID}.${COMBATANT_DEFEATED_SYNC_FLAG}`]: globalThis._del
  };
  if (combatant.defeated && !syncData?.previousDefeated) update.defeated = false;
  await combatant.update(update, createCombatLifecycleOptions({
    turnEvents: false
  }, lifecycleContextId));
  return true;
}

async function advanceCurrentDefeatedTurn(combat, actor, {
  lifecycleContextId = ""
} = {}) {
  if (!game.user?.isActiveGM || !combat?.started || !combat.settings?.skipDefeated || !actor?.uuid) return false;
  const blockTurn = isBlockTurnOrderEnabled(combat);
  const combatant = blockTurn
    ? getActiveBlockProgress(combat)?.block.combatants.find(candidate => (
      candidate.actor?.uuid === actor.uuid
      && candidate.isDefeated
    )) ?? null
    : combat.combatant;
  if (!combatant || combatant.actor?.uuid !== actor.uuid || !combatant.isDefeated) return false;
  const advanceKey = `${combat.id}:${combat.round}:${combat.turn}:${combatant.id}`;
  if (advancingDefeatedTurnKey === advanceKey) return false;
  advancingDefeatedTurnKey = advanceKey;
  try {
    const options = {
      falloutMawConversionMode: TURN_CONVERSION_MODES.skip
    };
    if (blockTurn) {
      options[BLOCK_TURN_ACTOR_OPTION] = actor.uuid;
    }
    await combat.nextTurn(createCombatLifecycleOptions(options, lifecycleContextId));
  } finally {
    if (advancingDefeatedTurnKey === advanceKey) advancingDefeatedTurnKey = "";
  }
  return true;
}

function prepareCombatStartDefeatedTurn(combat, updateData) {
  if (!game.user?.isActiveGM || !combat?.settings?.skipDefeated || !Number.isInteger(updateData?.turn)) return;
  const nextTurn = combat.turns.findIndex(combatant => !combatantShouldBeSkippedByDefeatedState(combatant));
  if (nextTurn === -1) return;
  updateData.turn = nextTurn;
}

function combatantShouldBeSkippedByDefeatedState(combatant) {
  return Boolean(combatant?.defeated || actorHasIncapacitatingStatus(combatant?.actor));
}

function queueActorDefeatedCombatantSyncForEffect(effect, { statusMutation = false } = {}) {
  const actor = effect?.parent;
  if (!actor?.uuid) return;
  if (
    !statusMutation
    && !effectHasIncapacitatingCombatantStatus(effect)
    && !actorHasIncapacitatingStatus(actor)
  ) return;
  if (queuedDefeatedActorSyncs.has(actor.uuid)) return;
  queuedDefeatedActorSyncs.set(actor.uuid, actor);
  globalThis.setTimeout(() => {
    const queuedActor = queuedDefeatedActorSyncs.get(actor.uuid) ?? actor;
    queuedDefeatedActorSyncs.delete(actor.uuid);
    const freshActor = fromUuidSync(queuedActor.uuid) ?? queuedActor;
    const combat = getActorActiveCombat(freshActor) ?? game.combat;
    const isActiveTurnActor = isBlockTurnOrderEnabled(combat)
      ? isActorInActiveBlock(freshActor, combat)
      : combat?.combatant?.actor?.uuid === freshActor.uuid;
    void syncActorDefeatedCombatants(freshActor, {
      combat,
      advanceCurrent: isActiveTurnActor
    }).catch(error => {
      console.error(`${SYSTEM_ID} | Failed to synchronize defeated Combatants`, error);
    });
  }, 0);
}

function hasActiveEffectStatusUpdate(changes = {}) {
  return Object.keys(changes ?? {}).some(path => (
    path === "statuses"
    || path.startsWith("statuses.")
  ));
}

function effectHasIncapacitatingCombatantStatus(effect) {
  for (const status of effect?.statuses ?? []) {
    if (INCAPACITATING_COMBATANT_STATUSES.has(status)) return true;
  }
  return false;
}

export async function prepareActorTurnEnd(actor, {
  conversionMode = TURN_CONVERSION_MODES.dodge,
  combat = game.combat,
  turnContext = null
} = {}) {
  if (!actor?.isOwner) return;
  await callActorTurnEndHandlers({ actor, combat, conversionMode, turnContext });
  if (conversionMode !== TURN_CONVERSION_MODES.skip) {
    const remainingActionPoints = getAvailableNormalActionPointValue(actor);
    if (remainingActionPoints > 0) {
      if (conversionMode === TURN_CONVERSION_MODES.reaction) {
        await convertActionPointsToReactionPoints(actor, remainingActionPoints);
      } else if (conversionMode === TURN_CONVERSION_MODES.dodge) {
        await createOrUpdateReactionDodgeEffect(actor, remainingActionPoints * DODGE_CONVERSION_MULTIPLIER);
      }
    }
  }
  await closeActorTurnResources(actor);
  await deleteOneTimeActionPointEffects(actor, { source: IN_TURN_REACTION_SOURCE });
}

export async function restoreActorReactionResource(actor) {
  if (!actor?.isOwner) return;
  const reaction = actor.system?.resources?.[REACTION_RESOURCE_KEY];
  if (!reaction) return;
  const max = Math.max(0, toInteger(reaction.max));
  const updates = {};
  if (toInteger(reaction.value) !== max) {
    updates[`system.resources.${REACTION_RESOURCE_KEY}.value`] = max;
  }
  if (toInteger(reaction.spent) !== 0) {
    updates[`system.resources.${REACTION_RESOURCE_KEY}.spent`] = 0;
  }
  if (Object.keys(updates).length) {
    await actor.update(updates, { [REACTION_UPDATE_OPTION]: true });
  }
}

export async function prepareCombatTurnStart(combat, combatant, {
  skipped = false,
  lifecycleContextId = ""
} = {}) {
  if (!game.user?.isActiveGM || !combat?.started || skipped) return undefined;
  await waitForCombatReactionResourceInitialization(combat);
  if (isBlockTurnOrderEnabled(combat)) {
    return prepareActiveBlockTurnStart(combat, { lifecycleContextId });
  }
  const actor = combatant?.actor ?? combat.combatant?.actor ?? null;
  await prepareActorTurnStart(actor, { combat });
  return syncActorDefeatedCombatants(actor, {
    combat,
    advanceCurrent: false,
    lifecycleContextId
  });
}

export async function prepareCombatTurnRewind(combat, prior, current, {
  turnEndProcessed = false,
  lifecycleContextId = ""
} = {}) {
  if (!game.user?.isActiveGM || !combat?.started) return undefined;
  await waitForCombatReactionResourceInitialization(combat);
  const previousActor = combat.combatants?.get(prior?.combatantId)?.actor ?? null;
  const currentActor = combat.combatants?.get(current?.combatantId)?.actor ?? combat.combatant?.actor ?? null;
  if (isBlockTurnOrderEnabled(combat)) {
    if (previousActor?.uuid && !isActorInActiveBlock(previousActor, combat)) {
      await restoreActorReactionResource(previousActor);
    }
    return prepareActiveBlockTurnStart(combat, { lifecycleContextId });
  }
  if (!turnEndProcessed && previousActor?.uuid && previousActor.uuid !== currentActor?.uuid) {
    await restoreActorReactionResource(previousActor);
  }
  await prepareActorTurnStart(currentActor, { combat });
  return syncActorDefeatedCombatants(currentActor, {
    combat,
    advanceCurrent: false,
    lifecycleContextId
  });
}

/**
 * Grant one-time reaction points directly on the Actor.
 *
 * This is deliberately not an Active Effect: the points are a temporary
 * spendable balance, not a modifier to the actor's reaction-point maximum or
 * bonus. They are consumed before normal ОР and cleared at turn start.
 */
export async function grantActorReactionPoints(actor, amount = 0) {
  const granted = Math.max(0, toInteger(amount));
  if (!actor?.isOwner || !granted) return 0;
  await deleteLegacyReactionPointGrantEffects(actor);
  await addOneTimeReactionPoints(actor, granted);
  return granted;
}

export function getNormalActionPointValue(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[ACTION_RESOURCE_KEY]?.value));
}

export function getAvailableNormalActionPointValue(actor) {
  return Math.max(
    0,
    getNormalActionPointValue(actor) - getActorResourceLimitAmount(actor, ACTION_RESOURCE_KEY)
  );
}

export function getReactionPointValue(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[REACTION_RESOURCE_KEY]?.value));
}

export function getOneTimeActionPointTotal(actor) {
  return getOneTimeActionPointEntries(actor)
    .reduce((total, entry) => total + Math.max(0, toInteger(entry.value)), 0);
}

export function getOneTimeReactionPointTotal(actor) {
  const raw = actor?.getFlag?.(SYSTEM_ID, ONE_TIME_REACTION_POINTS_FLAG)
    ?? actor?.flags?.[SYSTEM_ID]?.[ONE_TIME_REACTION_POINTS_FLAG];
  return Math.max(0, toInteger(raw));
}

export function decorateActionPointHudEntry(actor, entry) {
  if (!entry?.key || entry.key !== ACTION_RESOURCE_KEY) return entry;
  const reactionValue = getReactionPointValue(actor);
  const combat = getActorActiveCombat(actor);
  if (combat && !isActorCurrentCombatant(actor, combat)) {
    const reactionMax = Math.max(0, toInteger(actor?.system?.resources?.[REACTION_RESOURCE_KEY]?.max));
    const reactionOnce = getOneTimeReactionPointTotal(actor);
    const reactionTotal = reactionValue + reactionOnce;
    const visualMax = Math.max(1, reactionMax, reactionTotal);
    const hasOneTimeResource = reactionOnce > 0;
    const normalPercent = (reactionValue / visualMax) * 100;
    const oneTimePercent = (reactionOnce / visualMax) * 100;
    return {
      ...entry,
      key: REACTION_RESOURCE_KEY,
      label: "Очки реакции",
      value: reactionValue,
      min: 0,
      max: reactionMax,
      valueLabel: hasOneTimeResource
        ? `${reactionValue}+${reactionOnce}`
        : reactionValue,
      maxLabel: hasOneTimeResource ? reactionTotal : reactionMax,
      oneTimeResource: hasOneTimeResource,
      meterValue: reactionTotal,
      meterMax: visualMax,
      meterStyle: buildFlatMeterStyle(REACTION_FILL_COLOR, getMeterSections(visualMax)),
      fillStyle: buildFlatFillStyle(REACTION_FILL_COLOR, normalPercent),
      oneTimeFillStyle: buildFlatOverlayFillStyle(
        ONE_TIME_RESOURCE_FILL_COLOR,
        normalPercent,
        oneTimePercent
      )
    };
  }

  const once = getOneTimeActionPointTotal(actor);
  if (!once) return entry;
  const total = Math.max(0, toInteger(entry.value)) + once;
  const visualMax = Math.max(1, toInteger(entry.max), total);
  const normalPercent = (Math.max(0, toInteger(entry.value)) / visualMax) * 100;
  const oneTimePercent = (once / visualMax) * 100;
  return {
    ...entry,
    valueLabel: `${Math.max(0, toInteger(entry.value))}+${once}`,
    maxLabel: total,
    oneTimeResource: true,
    meterValue: total,
    meterMax: visualMax,
    meterStyle: buildFlatMeterStyle(REACTION_FILL_COLOR, getMeterSections(visualMax)),
    fillStyle: buildFlatFillStyle(REACTION_FILL_COLOR, normalPercent),
    oneTimeFillStyle: buildFlatOverlayFillStyle(
      ONE_TIME_RESOURCE_FILL_COLOR,
      normalPercent,
      oneTimePercent
    )
  };
}

export function getCombatActionPointState(actor) {
  const action = actor?.system?.resources?.[ACTION_RESOURCE_KEY];
  const reaction = actor?.system?.resources?.[REACTION_RESOURCE_KEY];
  if (!action) return null;
  const actionValue = Math.max(0, toInteger(action.value));
  const reactionValue = Math.max(0, toInteger(reaction?.value));
  const combat = getActorActiveCombat(actor);
  const ownTurn = !combat || isActorCurrentCombatant(actor, combat);
  const actionOnceValue = getOneTimeActionPointTotal(actor);
  const reactionOnceValue = getOneTimeReactionPointTotal(actor);
  const onceValue = ownTurn ? actionOnceValue : reactionOnceValue;
  const key = ownTurn ? ACTION_RESOURCE_KEY : REACTION_RESOURCE_KEY;
  const current = ownTurn ? actionValue : reactionValue;
  const total = ownTurn
    ? actionValue + actionOnceValue
    : reactionValue + reactionOnceValue;
  const limited = Math.min(total, getActorResourceLimitAmount(actor, key));
  return {
    ownTurn,
    key,
    label: ownTurn ? "ОД" : "ОР",
    current,
    limited,
    value: Math.max(0, total - limited),
    normal: actionValue,
    once: onceValue,
    reactionOnce: reactionOnceValue,
    max: ownTurn
      ? Math.max(0, toInteger(action.max))
      : Math.max(0, toInteger(reaction?.max))
  };
}

export function canSpendCombatActionPoints(actor, amount = 0, { label = "" } = {}) {
  if (!isActorInActiveCombat(actor)) return true;
  const cost = Math.max(0, toInteger(amount));
  const state = getCombatActionPointState(actor);
  if (!state || cost <= state.value) return true;
  ui.notifications.warn(`${actor?.name ?? ""}: не хватает ${state.label}${label ? ` для ${label}` : ""} (${cost} > ${state.value}).`);
  return false;
}

export async function spendCombatActionPoints(actor, amount = 0, context = {}) {
  if (!isActorInActiveCombat(actor)) return [];
  const cost = Math.max(0, toInteger(amount));
  if (!actor?.isOwner || cost <= 0) return;

  const state = getCombatActionPointState(actor);
  if (!state || cost > state.value) return;
  if (!state.ownTurn) {
    const onceSpend = Math.min(cost, state.once);
    const normalSpend = cost - onceSpend;
    if (onceSpend) await spendOneTimeReactionPoints(actor, onceSpend);
    if (normalSpend) {
      const next = Math.max(0, state.current - normalSpend);
      await actor.update({
        [`system.resources.${REACTION_RESOURCE_KEY}.value`]: next,
        [`system.resources.${REACTION_RESOURCE_KEY}.spent`]: Math.max(0, toInteger(actor.system?.resources?.[REACTION_RESOURCE_KEY]?.max) - next)
      }, { [REACTION_UPDATE_OPTION]: true });
    }
    if (context?.suppressResourceNotification) return [];
    return notifyCombatResourcesSpent(actor, { [REACTION_RESOURCE_KEY]: cost }, context);
  }

  const onceSpend = Math.min(cost, state.once);
  const normalSpend = cost - onceSpend;
  const updates = {};
  if (normalSpend) updates[`system.resources.${ACTION_RESOURCE_KEY}.value`] = Math.max(0, state.normal - normalSpend);
  if (onceSpend) await spendOneTimeActionPoints(actor, onceSpend);
  if (Object.keys(updates).length) await actor.update(updates);
  if (context?.suppressResourceNotification) return [];
  return notifyCombatResourcesSpent(actor, { [ACTION_RESOURCE_KEY]: cost }, context);
}

/**
 * Spend dynamic combat action points and return a refundable delta receipt.
 *
 * Unlike strict ОД, an ordinary action may draw from ОР outside the actor's
 * turn or from normal plus one-time ОД during its turn. The receipt preserves
 * that split so a surrounding weapon transaction can compensate its own
 * spend without converting one-time points into permanent points.
 */
export async function spendCombatActionPointsWithReceipt(actor, amount = 0, context = {}) {
  if (!isActorInActiveCombat(actor)) return emptyCombatActionPointTransaction();
  const cost = Math.max(0, toInteger(amount));
  const state = getCombatActionPointState(actor);
  if (!actor?.isOwner || cost <= 0 || !state || cost > state.value) {
    return emptyCombatActionPointTransaction();
  }

  if (!state.ownTurn) {
    const resource = actor.system?.resources?.[REACTION_RESOURCE_KEY];
    const normalBefore = Math.max(0, toInteger(resource?.value));
    const onceBefore = getOneTimeReactionPointTotal(actor);
    const onceSpend = Math.min(cost, onceBefore);
    const normalSpend = cost - onceSpend;
    let observedNormalSpend = 0;
    let observedOnceSpend = 0;
    try {
      if (onceSpend > 0) {
        observedOnceSpend = await spendOneTimeReactionPoints(actor, onceSpend);
        if (observedOnceSpend !== onceSpend) {
          const error = new Error("One-time reaction-point update was cancelled or altered.");
          error.cancelled = true;
          throw error;
        }
      }
      if (normalSpend > 0) {
        const maximum = Math.max(0, toInteger(resource?.max));
        const next = Math.max(0, normalBefore - normalSpend);
        await actor.update({
          [`system.resources.${REACTION_RESOURCE_KEY}.value`]: next,
          [`system.resources.${REACTION_RESOURCE_KEY}.spent`]: Math.max(0, maximum - next)
        }, { [REACTION_UPDATE_OPTION]: true });
        const applied = getDirectCombatResourceValue(actor, REACTION_RESOURCE_KEY);
        observedNormalSpend = Math.min(normalSpend, Math.max(0, normalBefore - applied));
        if (applied !== next) {
          const error = new Error("Combat reaction-point Actor update was cancelled or altered.");
          error.cancelled = true;
          throw error;
        }
      }
    } catch (error) {
      const partialAmount = observedNormalSpend + observedOnceSpend;
      if (partialAmount > 0) {
        try {
          const restored = await refundCombatActionPointReceipt(actor, createCombatActionPointReceipt(actor, {
            mode: "reaction",
            resourceKey: REACTION_RESOURCE_KEY,
            amount: partialAmount,
            reactionSpent: observedNormalSpend,
            reactionOnceSpent: observedOnceSpend
          }), context);
          if (restored < partialAmount) {
            throw new Error(`Only ${restored} of ${partialAmount} reaction points were rolled back.`);
          }
        } catch (rollbackError) {
          error.rollbackError ??= rollbackError;
        }
      }
      if (error.cancelled && !error.rollbackError) return emptyCombatActionPointTransaction();
      throw error;
    }
    const receipt = createCombatActionPointReceipt(actor, {
      mode: "reaction",
      resourceKey: REACTION_RESOURCE_KEY,
      amount: cost,
      reactionSpent: normalSpend,
      reactionOnceSpent: onceSpend
    });
    return {
      spent: cost,
      receipt,
      events: context?.suppressResourceNotification
        ? []
        : await notifyCombatActionPointReceipt(actor, receipt, context)
    };
  }

  const normalBefore = getNormalActionPointValue(actor);
  const onceBefore = getOneTimeActionPointTotal(actor);
  const onceSpend = Math.min(cost, onceBefore);
  const normalSpend = cost - onceSpend;
  const onceRestores = planOneTimeActionPointRestores(actor, onceSpend);
  let observedNormalSpend = 0;
  let observedOnceSpend = 0;
  try {
    if (onceSpend > 0) {
      await spendOneTimeActionPoints(actor, onceSpend);
      const onceAfter = getOneTimeActionPointTotal(actor);
      observedOnceSpend = Math.min(onceSpend, Math.max(0, onceBefore - onceAfter));
      if (onceAfter !== onceBefore - onceSpend) {
        const error = new Error("One-time action-point update was cancelled or altered.");
        error.cancelled = true;
        throw error;
      }
    }
    if (normalSpend > 0) {
      const next = normalBefore - normalSpend;
      await actor.update({
        [`system.resources.${ACTION_RESOURCE_KEY}.value`]: next
      });
      const applied = getDirectCombatResourceValue(actor, ACTION_RESOURCE_KEY);
      observedNormalSpend = Math.min(normalSpend, Math.max(0, normalBefore - applied));
      if (applied !== next) {
        const error = new Error("Combat action-point Actor update was cancelled or altered.");
        error.cancelled = true;
        throw error;
      }
    }
  } catch (error) {
    const partialAmount = observedNormalSpend + observedOnceSpend;
    if (partialAmount > 0) {
      try {
        const restored = await refundCombatActionPointReceipt(actor, createCombatActionPointReceipt(actor, {
          mode: "action",
          resourceKey: ACTION_RESOURCE_KEY,
          amount: partialAmount,
          normalSpent: observedNormalSpend,
          onceSpent: observedOnceSpend,
          onceRestores: trimOneTimeActionPointRestores(onceRestores, observedOnceSpend)
        }), context);
        if (restored < partialAmount) {
          throw new Error(`Only ${restored} of ${partialAmount} combat action points were rolled back.`);
        }
      } catch (rollbackError) {
        error.rollbackError ??= rollbackError;
      }
    }
    if (error.cancelled && !error.rollbackError) return emptyCombatActionPointTransaction();
    throw error;
  }

  const receipt = createCombatActionPointReceipt(actor, {
    mode: "action",
    resourceKey: ACTION_RESOURCE_KEY,
    amount: cost,
    normalSpent: normalSpend,
    onceSpent: onceSpend,
    onceRestores
  });
  return {
    spent: cost,
    receipt,
    events: context?.suppressResourceNotification
      ? []
      : await notifyCombatActionPointReceipt(actor, receipt, context)
  };
}

/** Refund only the dynamic combat-point delta represented by a receipt. */
export async function refundCombatActionPointReceipt(actor, receipt = null, context = {}) {
  const amount = Math.max(0, toInteger(receipt?.amount));
  if (
    !actor?.isOwner
    || !amount
    || String(receipt?.actorUuid ?? "") !== String(actor?.uuid ?? "")
  ) return 0;

  if (receipt.mode === "reaction" && receipt.resourceKey === REACTION_RESOURCE_KEY) {
    const resource = actor.system?.resources?.[REACTION_RESOURCE_KEY];
    let restored = 0;
    const normalAmount = Math.max(0, toInteger(receipt.reactionSpent));
    if (resource && normalAmount > 0) {
      const before = Math.max(0, toInteger(resource.value));
      const maximum = Math.max(0, toInteger(resource.max));
      const next = Math.min(maximum, before + normalAmount);
      const requested = next - before;
      if (requested > 0) {
        await actor.update({
          [`system.resources.${REACTION_RESOURCE_KEY}.value`]: next,
          [`system.resources.${REACTION_RESOURCE_KEY}.spent`]: Math.max(0, maximum - next)
        }, {
          [REACTION_UPDATE_OPTION]: true,
          falloutMawCombatActionPointRefund: true,
          ...getCombatActionPointOperationOptions(context)
        });
        restored += Math.min(requested, Math.max(0, getDirectCombatResourceValue(actor, REACTION_RESOURCE_KEY) - before));
      }
    }
    const onceAmount = Math.max(0, toInteger(receipt.reactionOnceSpent));
    if (onceAmount > 0) {
      restored += await addOneTimeReactionPoints(actor, onceAmount);
    }
    return Math.min(amount, restored);
  }

  if (receipt.mode !== "action" || receipt.resourceKey !== ACTION_RESOURCE_KEY) return 0;
  let restored = 0;
  const normalAmount = Math.max(0, toInteger(receipt.normalSpent));
  if (normalAmount > 0) {
    const resource = actor.system?.resources?.[ACTION_RESOURCE_KEY];
    if (resource) {
      const before = Math.max(0, toInteger(resource.value));
      const maximum = Math.max(0, toInteger(resource.max));
      const next = Math.min(maximum, before + normalAmount);
      const requested = next - before;
      if (requested > 0) {
        await actor.update({
          [`system.resources.${ACTION_RESOURCE_KEY}.value`]: next,
          [`system.resources.${ACTION_RESOURCE_KEY}.spent`]: Math.max(0, maximum - next)
        }, {
          falloutMawCombatActionPointRefund: true,
          ...getCombatActionPointOperationOptions(context)
        });
        restored += Math.min(
          requested,
          Math.max(0, getDirectCombatResourceValue(actor, ACTION_RESOURCE_KEY) - before)
        );
      }
    }
  }

  const onceAmount = Math.max(0, toInteger(receipt.onceSpent));
  if (onceAmount > 0) {
    const before = getOneTimeActionPointTotal(actor);
    const restores = trimOneTimeActionPointRestores(receipt.onceRestores, onceAmount);
    for (const entry of restores) {
      await addOneTimeActionPointEffect(actor, entry.amount, { source: entry.source });
    }
    const after = getOneTimeActionPointTotal(actor);
    restored += Math.min(onceAmount, Math.max(0, after - before));
  }
  return Math.min(amount, restored);
}

/** Publish the deferred resource-spent event of one committed receipt. */
export function notifyCombatActionPointReceipt(actor, receipt = null, context = {}) {
  const amount = Math.max(0, toInteger(receipt?.amount));
  const resourceKey = receipt?.resourceKey === REACTION_RESOURCE_KEY
    ? REACTION_RESOURCE_KEY
    : ACTION_RESOURCE_KEY;
  if (!amount || String(receipt?.actorUuid ?? "") !== String(actor?.uuid ?? "")) return [];
  return notifyCombatResourcesSpent(actor, { [resourceKey]: amount }, context);
}

function emptyCombatActionPointTransaction() {
  return { spent: 0, receipt: null, events: [] };
}

function createCombatActionPointReceipt(actor, data = {}) {
  return Object.freeze({
    actorUuid: String(actor?.uuid ?? ""),
    mode: String(data.mode ?? ""),
    resourceKey: String(data.resourceKey ?? ""),
    amount: Math.max(0, toInteger(data.amount)),
    normalSpent: Math.max(0, toInteger(data.normalSpent)),
    onceSpent: Math.max(0, toInteger(data.onceSpent)),
    reactionSpent: Math.max(0, toInteger(data.reactionSpent)),
    reactionOnceSpent: Math.max(0, toInteger(data.reactionOnceSpent)),
    onceRestores: Object.freeze((data.onceRestores ?? []).map(entry => Object.freeze({
      amount: Math.max(0, toInteger(entry?.amount)),
      source: String(entry?.source ?? "")
    })).filter(entry => entry.amount > 0))
  });
}

function planOneTimeActionPointRestores(actor, amount = 0) {
  let remaining = Math.max(0, toInteger(amount));
  const restores = [];
  for (const entry of getOneTimeActionPointEntries(actor)) {
    if (remaining <= 0) break;
    const spend = Math.min(remaining, Math.max(0, toInteger(entry.value)));
    remaining -= spend;
    if (spend <= 0) continue;
    const flag = entry.effect?.getFlag?.(SYSTEM_ID, ONE_TIME_ACTION_EFFECT_FLAG);
    restores.push({
      amount: spend,
      source: String(flag?.source ?? "")
    });
  }
  return restores;
}

function trimOneTimeActionPointRestores(entries = [], amount = 0) {
  let remaining = Math.max(0, toInteger(amount));
  const result = [];
  for (const entry of entries ?? []) {
    if (remaining <= 0) break;
    const restored = Math.min(remaining, Math.max(0, toInteger(entry?.amount)));
    remaining -= restored;
    if (restored > 0) result.push({ amount: restored, source: String(entry?.source ?? "") });
  }
  if (remaining > 0) result.push({ amount: remaining, source: "weaponActionRollback" });
  return result;
}

function getDirectCombatResourceValue(actor, resourceKey = "") {
  return Math.max(0, toInteger(actor?.system?.resources?.[resourceKey]?.value));
}

function getCombatActionPointOperationOptions(context = {}) {
  return context?.chainRef ? {
    chainRef: context.chainRef,
    falloutMawSystemEventChainRef: context.chainRef
  } : {};
}

export async function promptEndTurnConversion(actor) {
  const remaining = getAvailableNormalActionPointValue(actor);
  if (remaining <= 0) return TURN_CONVERSION_MODES.none;

  const { DialogV2 } = foundry.applications.api;
  const result = await DialogV2.wait({
    window: { title: "Конвертация ОД" },
    content: `<p>Осталось ОД: <strong>${remaining}</strong>. Куда конвертировать остаток?</p>`,
    buttons: [{
      action: TURN_CONVERSION_MODES.reaction,
      label: "Очки реакции",
      icon: "fa-solid fa-bolt",
      callback: () => TURN_CONVERSION_MODES.reaction
    }, {
      action: TURN_CONVERSION_MODES.dodge,
      label: "Очки уклонения",
      icon: "fa-solid fa-shield-halved",
      callback: () => TURN_CONVERSION_MODES.dodge
    }, {
      action: "cancel",
      label: "Отмена",
      callback: () => null
    }],
    rejectClose: false,
    modal: true
  });
  if (!result) return null;
  return result;
}

export function isReactionResourceUpdateOption(options = {}) {
  return Boolean(options?.[REACTION_UPDATE_OPTION]);
}

export async function resetCombatReactionResources(combat) {
  if (!game.user?.isActiveGM) return;
  const actors = new Map();
  for (const combatant of combat?.combatants ?? []) {
    if (combatant.actor) actors.set(combatant.actor.uuid, combatant.actor);
  }
  for (const actor of actors.values()) await resetActorReactionResources(actor);
}

function queueCombatReactionResourceInitialization(combat, updateData = {}) {
  if (!game.user?.isActiveGM || !combat) return;
  const lifecycleContextId = String(combat.falloutMawLifecycleContextId ?? "");
  const initialization = initializeCombatReactionResources(combat, updateData, {
    lifecycleContextId
  })
    .catch(error => {
      console.error(`${SYSTEM_ID} | Combat resource initialization failed`, error);
    });
  const tracked = initialization.finally(() => {
    if (combatReactionResourceInitializations.get(combat) === tracked) {
      combatReactionResourceInitializations.delete(combat);
    }
  });
  combatReactionResourceInitializations.set(combat, tracked);
}

async function waitForCombatReactionResourceInitialization(combat) {
  const initialization = combatReactionResourceInitializations.get(combat);
  if (initialization) await initialization;
}

async function initializeCombatReactionResources(combat, updateData = {}, {
  lifecycleContextId = ""
} = {}) {
  if (!game.user?.isActiveGM) return;
  const initialTurn = Number.isInteger(updateData?.turn) ? updateData.turn : combat?.turn;
  const initiallyPreparedActorUuids = getInitiallyPreparedActorUuids(combat, initialTurn);
  await initializeCombatDodgeResources(combat);
  await restoreCombatMovementResources(combat, {
    excludeActorUuids: initiallyPreparedActorUuids,
    includeSceneTokenActors: false
  });
  const actors = new Map();
  for (const combatant of combat?.combatants ?? []) {
    if (combatant.actor) actors.set(combatant.actor.uuid, combatant.actor);
  }
  for (const actor of actors.values()) {
    if (initiallyPreparedActorUuids.has(actor.uuid)) continue;
    await resetActorReactionResources(actor, { restore: true });
  }
  await syncCombatDefeatedCombatants(combat, {
    advanceCurrent: false,
    lifecycleContextId
  });
}

function createCombatLifecycleOptions(options = {}, lifecycleContextId = "") {
  if (!lifecycleContextId) return options;
  return {
    ...options,
    [COMBAT_LIFECYCLE_CONTEXT_OPTION]: lifecycleContextId
  };
}

function getInitiallyPreparedActorUuids(combat, initialTurn) {
  const currentCombatant = combat?.turns?.[initialTurn] ?? combat?.combatant ?? null;
  const actorUuids = new Set();
  if (currentCombatant?.actor?.uuid) actorUuids.add(currentCombatant.actor.uuid);
  if (getCombatTurnOrderScheme() !== TURN_ORDER_SCHEMES.block || !Number.isInteger(initialTurn)) {
    return actorUuids;
  }

  const block = getCombatTurnBlocks(combat)
    .find(candidate => candidate.start <= initialTurn && initialTurn <= candidate.end);
  for (const combatant of block?.combatants ?? []) {
    if (!isCombatantAutoCompleted(combatant) && combatant.actor?.uuid) {
      actorUuids.add(combatant.actor.uuid);
    }
  }
  return actorUuids;
}

export async function resetActorReactionResources(actor, { restore = false } = {}) {
  if (!actor?.isOwner) return;
  await deleteTurnStartResourceEffects(actor);
  const updates = {};
  const reaction = actor.system?.resources?.[REACTION_RESOURCE_KEY];
  if (reaction) {
    const max = Math.max(0, toInteger(reaction.max));
    const nextValue = restore ? max : 0;
    const nextSpent = restore ? 0 : max;
    if (toInteger(reaction.value) !== nextValue) {
      updates[`system.resources.${REACTION_RESOURCE_KEY}.value`] = nextValue;
    }
    if (toInteger(reaction.spent) !== nextSpent) {
      updates[`system.resources.${REACTION_RESOURCE_KEY}.spent`] = nextSpent;
    }
  }
  if (Object.keys(updates).length) await actor.update(updates, { [REACTION_UPDATE_OPTION]: true });
}

async function convertInTurnReactionPoints(actor, rawValue) {
  if (!actor?.isOwner || !isActorCurrentCombatant(actor, getActorActiveCombat(actor))) return;
  const nextValue = Math.max(0, toInteger(rawValue));
  if (!nextValue) return;
  await addOneTimeActionPointEffect(actor, nextValue, { source: IN_TURN_REACTION_SOURCE });
  await actor.update({
    [`system.resources.${REACTION_RESOURCE_KEY}.value`]: 0,
    [`system.resources.${REACTION_RESOURCE_KEY}.spent`]: Math.max(0, toInteger(actor.system?.resources?.[REACTION_RESOURCE_KEY]?.max))
  }, { [REACTION_UPDATE_OPTION]: true });
  await deleteReactionPointEffects(actor);
}

async function convertActionPointsToReactionPoints(actor, amount) {
  const value = Math.max(0, toInteger(amount));
  await createOrUpdateReactionPointEffect(actor, value);
}

async function closeActorTurnResources(actor) {
  const updates = {};
  for (const key of [ACTION_RESOURCE_KEY, MOVEMENT_RESOURCE_KEY]) {
    const resource = actor.system?.resources?.[key];
    if (!resource) continue;
    const max = Math.max(0, toInteger(resource.max));
    if (toInteger(resource.value) !== 0) {
      updates[`system.resources.${key}.value`] = 0;
    }
    if (toInteger(resource.spent) !== max) {
      updates[`system.resources.${key}.spent`] = max;
    }
  }
  const reaction = actor.system?.resources?.[REACTION_RESOURCE_KEY];
  if (reaction) {
    const max = Math.max(0, toInteger(reaction.max));
    if (toInteger(reaction.value) !== max) {
      updates[`system.resources.${REACTION_RESOURCE_KEY}.value`] = max;
    }
    if (toInteger(reaction.spent) !== 0) {
      updates[`system.resources.${REACTION_RESOURCE_KEY}.spent`] = 0;
    }
  }
  if (Object.keys(updates).length) {
    await actor.update(updates, { [REACTION_UPDATE_OPTION]: true });
  }
}

async function createOrUpdateReactionDodgeEffect(actor, amount) {
  const value = Math.max(0, toInteger(amount));
  if (!value) return;
  const existing = actor.effects?.find(effect => effect.getFlag(SYSTEM_ID, REACTION_DODGE_EFFECT_FLAG)) ?? null;
  const data = buildReactionDodgeEffectData(actor, value);
  if (existing) {
    await existing.update({
      name: data.name,
      img: data.img,
      "system.changes": data.system.changes,
      flags: data.flags,
      ...CLEAR_EFFECT_DURATION_UPDATE
    }, { animate: false });
    return;
  }
  await actor.createEmbeddedDocuments("ActiveEffect", [data], { animate: false });
}

async function createOrUpdateReactionPointEffect(actor, amount, operationOptions = {}) {
  const value = Math.max(0, toInteger(amount));
  if (!value) return;
  const existing = actor.effects?.find(effect => (
    effect.getFlag(SYSTEM_ID, REACTION_POINTS_EFFECT_FLAG) === true
  )) ?? null;
  const data = buildReactionPointEffectData(actor, value);
  if (existing) {
    await existing.update({
      name: data.name,
      img: data.img,
      "system.changes": data.system.changes,
      flags: data.flags,
      ...CLEAR_EFFECT_DURATION_UPDATE
    }, { animate: false, ...operationOptions });
    return;
  }
  await actor.createEmbeddedDocuments("ActiveEffect", [data], { animate: false, ...operationOptions });
}

async function deleteReactionPointEffects(actor) {
  const ids = actor?.effects
    ?.filter(effect => effect.getFlag(SYSTEM_ID, REACTION_POINTS_EFFECT_FLAG))
    .map(effect => effect.id) ?? [];
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { animate: false });
}

async function deleteTurnStartResourceEffects(actor) {
  const ids = new Set();
  for (const effect of actor?.effects ?? []) {
    if (
      effect.getFlag?.(SYSTEM_ID, REACTION_DODGE_EFFECT_FLAG)
      || effect.getFlag?.(SYSTEM_ID, REACTION_POINTS_EFFECT_FLAG)
    ) {
      if (effect.id) ids.add(effect.id);
      continue;
    }
    const oneTime = effect.getFlag?.(SYSTEM_ID, ONE_TIME_ACTION_EFFECT_FLAG);
    if (oneTime?.source === IN_TURN_REACTION_SOURCE && effect.id) ids.add(effect.id);
  }
  if (ids.size) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", Array.from(ids), { animate: false });
  }
  await clearOneTimeReactionPoints(actor);
}

async function deleteLegacyReactionPointGrantEffects(actor) {
  const ids = actor?.effects
    ?.filter(effect => effect.getFlag?.(SYSTEM_ID, REACTION_POINTS_EFFECT_FLAG)?.source === "abilityGrant")
    .map(effect => effect.id)
    .filter(Boolean) ?? [];
  if (ids.length && typeof actor?.deleteEmbeddedDocuments === "function") {
    await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { animate: false });
  }
}

async function setOneTimeReactionPointTotal(actor, value) {
  const next = Math.max(0, toInteger(value));
  const options = { [REACTION_UPDATE_OPTION]: true };
  if (next > 0 && typeof actor?.setFlag === "function") {
    await actor.setFlag(SYSTEM_ID, ONE_TIME_REACTION_POINTS_FLAG, next, options);
    return next;
  }
  if (next <= 0 && typeof actor?.unsetFlag === "function") {
    await actor.unsetFlag(SYSTEM_ID, ONE_TIME_REACTION_POINTS_FLAG, options);
    return 0;
  }
  if (typeof actor?.update === "function") {
    await actor.update({
      [`flags.${SYSTEM_ID}.${ONE_TIME_REACTION_POINTS_FLAG}`]: next > 0 ? next : null
    }, options);
  }
  return next;
}

async function addOneTimeReactionPoints(actor, amount) {
  const value = Math.max(0, toInteger(amount));
  if (!value) return 0;
  const before = getOneTimeReactionPointTotal(actor);
  const next = before + value;
  await setOneTimeReactionPointTotal(actor, next);
  return Math.max(0, getOneTimeReactionPointTotal(actor) - before);
}

async function spendOneTimeReactionPoints(actor, amount) {
  const requested = Math.max(0, toInteger(amount));
  if (!requested) return 0;
  const before = getOneTimeReactionPointTotal(actor);
  const spent = Math.min(requested, before);
  if (!spent) return 0;
  await setOneTimeReactionPointTotal(actor, before - spent);
  return Math.min(spent, Math.max(0, before - getOneTimeReactionPointTotal(actor)));
}

async function clearOneTimeReactionPoints(actor) {
  if (!getOneTimeReactionPointTotal(actor)) return;
  await setOneTimeReactionPointTotal(actor, 0);
}

async function addOneTimeActionPointEffect(actor, amount, { source = "" } = {}) {
  const value = Math.max(0, toInteger(amount));
  if (!value) return;
  const data = buildOneTimeActionPointEffectData(actor, value, { source });
  await actor.createEmbeddedDocuments("ActiveEffect", [data], { animate: false });
}

async function spendOneTimeActionPoints(actor, amount) {
  let remaining = Math.max(0, toInteger(amount));
  for (const entry of getOneTimeActionPointEntries(actor)) {
    if (remaining <= 0) break;
    const spend = Math.min(remaining, Math.max(0, toInteger(entry.value)));
    remaining -= spend;
    const nextValue = Math.max(0, toInteger(entry.value) - spend);
    await updateOneTimeActionPointChange(entry.effect, entry.index, nextValue);
  }
}

async function updateOneTimeActionPointChange(effect, index, value) {
  const changes = foundry.utils.deepClone(effect.system?.changes ?? []);
  const change = changes[index];
  if (!change) return;
  change.value = String(Math.max(0, toInteger(value)));
  const activeChanges = changes.filter(candidate => (
    String(candidate?.key ?? "") !== ONE_TIME_ACTION_POINTS_KEY
    || Math.max(0, toInteger(candidate.value)) > 0
  ));
  if (!activeChanges.some(candidate => String(candidate?.key ?? "") === ONE_TIME_ACTION_POINTS_KEY)) {
    if (!activeChanges.length) {
      await effect.delete({ animate: false });
      return;
    }
  }
  await effect.update({ "system.changes": activeChanges }, { animate: false });
}

async function deleteOneTimeActionPointEffects(actor, { source = "" } = {}) {
  const ids = actor?.effects
    ?.filter(effect => {
      const flag = effect.getFlag(SYSTEM_ID, ONE_TIME_ACTION_EFFECT_FLAG);
      if (!flag) return false;
      return !source || flag.source === source;
    })
    .map(effect => effect.id) ?? [];
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { animate: false });
}

function getOneTimeActionPointEntries(actor) {
  const entries = [];
  for (const effect of actor?.effects ?? []) {
    const changes = Array.from(effect.system?.changes ?? []);
    changes.forEach((change, index) => {
      if (String(change?.key ?? "") !== ONE_TIME_ACTION_POINTS_KEY) return;
      entries.push({ effect, index, value: Math.max(0, toInteger(change.value)) });
    });
  }
  return entries;
}

function buildReactionDodgeEffectData(actor, value) {
  return {
    type: "base",
    name: "Очки уклонения",
    img: getTokenActionHudIcons().dodgeConversionIcon || "icons/svg/shield.svg",
    origin: actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: {
      changes: [{
        key: `system.resources.${DODGE_RESOURCE_KEY}.bonus`,
        type: "add",
        value: String(value),
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [REACTION_DODGE_EFFECT_FLAG]: true
      }
    }
  };
}

function buildReactionPointEffectData(actor, value) {
  return {
    type: "base",
    name: "Очки реакции",
    img: "icons/svg/upgrade.svg",
    origin: actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: {
      changes: [{
        key: `system.resources.${REACTION_RESOURCE_KEY}.bonus`,
        type: "add",
        value: String(value),
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [REACTION_POINTS_EFFECT_FLAG]: true
      }
    }
  };
}

function buildOneTimeActionPointEffectData(actor, value, { source = "" } = {}) {
  return {
    type: "base",
    name: "Одноразовые ОД",
    img: "icons/svg/upgrade.svg",
    origin: actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    ...(source === IN_TURN_REACTION_SOURCE
      ? { duration: { expiry: "combatEnd" } }
      : {}),
    system: {
      changes: [{
        key: ONE_TIME_ACTION_POINTS_KEY,
        type: "add",
        value: String(value),
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [ONE_TIME_ACTION_EFFECT_FLAG]: { source }
      }
    }
  };
}

function isActorCurrentCombatant(actor, combat = getActorActiveCombat(actor)) {
  if (!combat?.started || !actor?.uuid) return false;
  if (isBlockTurnOrderEnabled(combat)) return isActorPendingInActiveBlock(actor, combat);
  return combat.combatant?.actor?.uuid === actor.uuid;
}

function buildFlatMeterStyle(color, sections = 10) {
  return [
    `--meter-sections: ${Math.max(1, Math.min(24, toInteger(sections)))}`,
    `--meter-color: ${color}`,
    `--meter-color-strong: ${color}`,
    "--meter-color-dark: #b9b9b0",
    "--meter-color-soft: rgba(242, 242, 235, 0.2)",
    "--meter-color-glow: rgba(242, 242, 235, 0.34)"
  ].join("; ");
}

function getMeterSections(value = 0) {
  const number = Math.max(0, toInteger(value));
  return number > 0 ? number : 10;
}

function buildFlatFillStyle(color, percent) {
  return [
    `width: ${Math.max(0, Math.min(100, Number(percent) || 0)).toFixed(2)}%`,
    `background: linear-gradient(180deg, ${color}, #b9b9b0)`,
    "box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 0 14px rgba(242, 242, 235, 0.34)"
  ].join("; ");
}

function buildFlatOverlayFillStyle(color, leftPercent, widthPercent) {
  return [
    `left: ${Math.max(0, Math.min(100, Number(leftPercent) || 0)).toFixed(2)}%`,
    `width: ${Math.max(0, Math.min(100, Number(widthPercent) || 0)).toFixed(2)}%`,
    `background: linear-gradient(180deg, ${color}, #78aee8)`,
    `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28), 0 0 14px rgba(118, 185, 255, 0.48)`
  ].join("; ");
}
