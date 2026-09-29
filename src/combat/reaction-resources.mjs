import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { COMBAT_LIFECYCLE_CONTEXT_OPTION } from "./combat-lifecycle-lease.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { notifyCombatResourcesSpent } from "./resource-spending.mjs";
import { decorateOneTimeResourceDisplay } from "../utils/one-time-resource-display.mjs";
import { getActorResourceLimitAmount } from "./resource-limits.mjs";
import { getOneTimeResourceValue, addOneTimeResourcePoints, clearOneTimeResourcePoints, runOneTimeResourceMutation } from "./one-time-resources.mjs";
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
const COMBATANT_DEFEATED_SYNC_FLAG = "incapacitatedDefeated";
const DODGE_CONVERSION_MULTIPLIER = 5;
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
  await clearOneTimeResourcePoints(actor, { [REACTION_UPDATE_OPTION]: true });

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
  const remainingActionPoints = getAvailableNormalActionPointValue(actor);
  if (conversionMode !== TURN_CONVERSION_MODES.skip) {
    if (remainingActionPoints > 0) {
      if (conversionMode === TURN_CONVERSION_MODES.reaction) {
        await convertActionPointsToReactionPoints(actor, remainingActionPoints);
      } else if (conversionMode === TURN_CONVERSION_MODES.dodge) {
        await addOneTimeResourcePoints(actor, DODGE_RESOURCE_KEY, remainingActionPoints * DODGE_CONVERSION_MULTIPLIER);
      }
    }
  }
  await closeActorTurnResources(actor);
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
 * bonus. They are consumed before normal ОР; the shared lifecycle expires them.
 */
export async function grantActorReactionPoints(actor, amount = 0) {
  const granted = Math.max(0, toInteger(amount));
  if (!actor?.isOwner || !granted) return 0;
  return addOneTimeResourcePoints(actor, REACTION_RESOURCE_KEY, granted, { [REACTION_UPDATE_OPTION]: true });
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
  return getOneTimeResourceValue(actor, ACTION_RESOURCE_KEY);
}

export function getOneTimeReactionPointTotal(actor) {
  return getOneTimeResourceValue(actor, REACTION_RESOURCE_KEY);
}

export function decorateActionPointHudEntry(actor, entry) {
  if (!entry?.key || entry.key !== ACTION_RESOURCE_KEY) return entry;
  const combat = getActorActiveCombat(actor);
  if (combat && !isActorCurrentCombatant(actor, combat)) {
    entry = {
      ...entry,
      key: REACTION_RESOURCE_KEY,
      label: auditLocalize("FALLOUTMAW.AuditRuntime.R0781", "Очки реакции"),
      value: getReactionPointValue(actor),
      min: 0,
      max: Math.max(0, toInteger(actor?.system?.resources?.[REACTION_RESOURCE_KEY]?.max))
    };
  }
  return decorateOneTimeResourceDisplay(actor, entry);
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
    label: ownTurn ? auditLocalize("FALLOUTMAW.AuditRuntime.R0008", "ОД") : auditLocalize("FALLOUTMAW.AuditRuntime.R0782", "ОР"),
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
  ui.notifications.warn(auditFormat("FALLOUTMAW.AuditRuntime.R0783", { p0: (actor?.name ?? ""), p1: (state.label), p2: (label ? auditFormat("FALLOUTMAW.AuditRuntime.R0784", { p0: (label) }, " для {p0}") : ""), p3: (cost), p4: (state.value) }, "{p0}: не хватает {p1}{p2} ({p3} > {p4})."));
  return false;
}

/** Keep external combined writes on the ordinary-only shortcut. */
export function prepareDirectCombatActionPointSpend(actor, amount = 0) {
  const plan = buildCombatActionPointSpend(actor, amount);
  return plan?.onceSpent ? null : plan;
}

/** Build one Actor update for ordinary and one-time points, consuming once first. */
function buildCombatActionPointSpend(actor, amount = 0) {
  if (!isActorInActiveCombat(actor)) return null;
  const cost = Math.max(0, toInteger(amount));
  const state = getCombatActionPointState(actor);
  if (!actor?.isOwner || cost <= 0 || !state || cost > state.value) return null;
  const onceSpend = Math.min(cost, state.once);
  const normalSpend = cost - onceSpend;
  const next = state.current - normalSpend;
  return Object.freeze({
    amount: cost,
    resourceKey: state.key,
    normalSpent: normalSpend,
    onceSpent: onceSpend,
    updates: Object.freeze({
      ...(normalSpend ? {
        [`system.resources.${state.key}.value`]: next,
        [`system.resources.${state.key}.spent`]: Math.max(0, state.max - next)
      } : {}),
      ...(onceSpend ? { [`system.resources.${state.key}.once`]: state.once - onceSpend } : {})
    }),
    documentOptions: Object.freeze({ [REACTION_UPDATE_OPTION]: true })
  });
}

export async function spendCombatActionPoints(actor, amount = 0, context = {}) {
  return (await spendCombatActionPointsWithReceipt(actor, amount, context)).events;
}

/** Spend the normal/once split in one Actor write and retain its refund receipt. */
export async function spendCombatActionPointsWithReceipt(actor, amount = 0, context = {}) {
  const transaction = await runOneTimeResourceMutation(actor, () => spendCombatActionPointsNow(actor, amount, context));
  if (transaction.receipt && !context?.suppressResourceNotification) {
    transaction.events = await notifyCombatActionPointReceipt(actor, transaction.receipt, context);
  }
  return transaction;
}

async function spendCombatActionPointsNow(actor, amount = 0, context = {}) {
  const plan = buildCombatActionPointSpend(actor, amount);
  if (!plan) return emptyCombatActionPointTransaction();
  const key = plan.resourceKey;
  const normalBefore = getDirectCombatResourceValue(actor, key);
  const onceBefore = getOneTimeResourceValue(actor, key);
  const buildReceipt = (normal, once) => createCombatActionPointReceipt(actor, {
    mode: key === REACTION_RESOURCE_KEY ? "reaction" : "action",
    resourceKey: key,
    amount: normal + once,
    ...(key === REACTION_RESOURCE_KEY
      ? { reactionSpent: normal, reactionOnceSpent: once }
      : { normalSpent: normal, onceSpent: once })
  });
  try {
    await actor.update({ ...plan.updates }, {
      ...context?.documentOptions,
      ...getCombatActionPointOperationOptions(context),
      ...plan.documentOptions
    });
    if (
      getDirectCombatResourceValue(actor, key) !== normalBefore - plan.normalSpent
      || getOneTimeResourceValue(actor, key) !== onceBefore - plan.onceSpent
    ) {
      const error = new Error("Combat point Actor update was cancelled or altered.");
      error.cancelled = true;
      throw error;
    }
  } catch (error) {
    const normal = Math.min(plan.normalSpent, Math.max(0, normalBefore - getDirectCombatResourceValue(actor, key)));
    const once = Math.min(plan.onceSpent, Math.max(0, onceBefore - getOneTimeResourceValue(actor, key)));
    if (normal + once > 0) {
      try {
        const restored = await refundCombatActionPointReceiptNow(actor, buildReceipt(normal, once), context);
        if (restored < normal + once) throw new Error(`Only ${restored} of ${normal + once} combat points were rolled back.`);
      } catch (rollbackError) {
        error.rollbackError ??= rollbackError;
      }
    }
    if (error.cancelled && !error.rollbackError) return emptyCombatActionPointTransaction();
    throw error;
  }
  const receipt = buildReceipt(plan.normalSpent, plan.onceSpent);
  return {
    spent: plan.amount,
    receipt,
    events: []
  };
}

/** Refund the persisted split in one write; later gains/spends are preserved. */
export async function refundCombatActionPointReceipt(actor, receipt = null, context = {}) {
  return runOneTimeResourceMutation(actor, () => refundCombatActionPointReceiptNow(actor, receipt, context));
}

async function refundCombatActionPointReceiptNow(actor, receipt = null, context = {}) {
  const amount = Math.max(0, toInteger(receipt?.amount));
  const key = receipt?.resourceKey;
  const reaction = receipt?.mode === "reaction" && key === REACTION_RESOURCE_KEY;
  const action = receipt?.mode === "action" && key === ACTION_RESOURCE_KEY;
  if (!actor?.isOwner || !amount || (!reaction && !action)
    || String(receipt?.actorUuid ?? "") !== String(actor?.uuid ?? "")) return 0;
  const resource = actor.system?.resources?.[key];
  if (!resource) return 0;
  const normalBefore = getDirectCombatResourceValue(actor, key);
  const onceBefore = getOneTimeResourceValue(actor, key);
  const normalAmount = Math.max(0, toInteger(reaction ? receipt.reactionSpent : receipt.normalSpent));
  const onceAmount = Math.max(0, toInteger(reaction ? receipt.reactionOnceSpent : receipt.onceSpent));
  const maximum = Math.max(0, toInteger(resource.max));
  const normalRestored = Math.max(0, Math.min(normalAmount, maximum - normalBefore));
  const updates = {
    ...(normalRestored ? {
      [`system.resources.${key}.value`]: normalBefore + normalRestored,
      [`system.resources.${key}.spent`]: Math.max(0, maximum - normalBefore - normalRestored)
    } : {}),
    ...(onceAmount ? { [`system.resources.${key}.once`]: onceBefore + onceAmount } : {})
  };
  if (!Object.keys(updates).length) return 0;
  await actor.update(updates, {
    ...context?.documentOptions,
    ...getCombatActionPointOperationOptions(context),
    [REACTION_UPDATE_OPTION]: true,
    falloutMawCombatActionPointRefund: true
  });
  return Math.min(amount,
    Math.min(normalRestored, Math.max(0, getDirectCombatResourceValue(actor, key) - normalBefore))
    + Math.min(onceAmount, Math.max(0, getOneTimeResourceValue(actor, key) - onceBefore))
  );
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
    reactionOnceSpent: Math.max(0, toInteger(data.reactionOnceSpent))
  });
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
    window: { title: auditLocalize("FALLOUTMAW.AuditRuntime.R0785", "Конвертация ОД") },
    content: auditFormat("FALLOUTMAW.AuditRuntime.R0786", { p0: (remaining) }, "<p>Осталось ОД: <strong>{p0}</strong>. Куда конвертировать остаток?</p>"),
    buttons: [{
      action: TURN_CONVERSION_MODES.reaction,
      label: auditLocalize("FALLOUTMAW.AuditRuntime.R0781", "Очки реакции"),
      icon: "fa-solid fa-bolt",
      callback: () => TURN_CONVERSION_MODES.reaction
    }, {
      action: TURN_CONVERSION_MODES.dodge,
      label: auditLocalize("FALLOUTMAW.AuditRuntime.R0787", "Очки уклонения"),
      icon: "fa-solid fa-shield-halved",
      callback: () => TURN_CONVERSION_MODES.dodge
    }, {
      action: "cancel",
      label: auditLocalize("FALLOUTMAW.AuditRuntime.R0064", "Отмена"),
      callback: () => false
    }],
    rejectClose: false,
    modal: true
  });
  return [TURN_CONVERSION_MODES.reaction, TURN_CONVERSION_MODES.dodge].includes(result)
    ? result
    : null;
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
  // updateActor is broadcast to all clients, including every owner of this Actor.
  // Only the combat authority may turn that single update into one-time action points.
  if (!game.user?.isActiveGM) return;
  if (!actor?.isOwner || !isActorCurrentCombatant(actor, getActorActiveCombat(actor))) return;
  if (!Math.max(0, toInteger(rawValue))) return;
  await runOneTimeResourceMutation(actor, async () => {
    // Read after entering the queue: another broadcast may already have been
    // converted, or a newer Actor update may have replaced this event's value.
    const available = getReactionPointValue(actor);
    if (!available) return false;
    const nextOnce = getOneTimeActionPointTotal(actor) + available;
    await actor.update({
      [`system.resources.${ACTION_RESOURCE_KEY}.once`]: nextOnce,
      [`system.resources.${REACTION_RESOURCE_KEY}.value`]: 0,
      [`system.resources.${REACTION_RESOURCE_KEY}.spent`]: Math.max(0, toInteger(actor.system?.resources?.[REACTION_RESOURCE_KEY]?.max))
    }, { [REACTION_UPDATE_OPTION]: true });
    return getReactionPointValue(actor) === 0 && getOneTimeActionPointTotal(actor) === nextOnce;
  });
}

async function convertActionPointsToReactionPoints(actor, amount) {
  const value = Math.max(0, toInteger(amount));
  await addOneTimeResourcePoints(actor, REACTION_RESOURCE_KEY, value, { [REACTION_UPDATE_OPTION]: true });
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

function isActorCurrentCombatant(actor, combat = getActorActiveCombat(actor)) {
  if (!combat?.started || !actor?.uuid) return false;
  if (isBlockTurnOrderEnabled(combat)) return isActorPendingInActiveBlock(actor, combat);
  return combat.combatant?.actor?.uuid === actor.uuid;
}

