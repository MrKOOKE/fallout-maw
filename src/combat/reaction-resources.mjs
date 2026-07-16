import { SYSTEM_ID } from "../constants.mjs";
import { getTokenActionHudIcons } from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { notifyCombatResourcesSpent } from "./resource-spending.mjs";
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
  restoreActorMovementResources
} from "./movement-resources.mjs";
import { restoreActorDodgeResource } from "./dodge-resource.mjs";
import {
  callActorTurnEndHandlers,
  callActorTurnStartPreparedHandlers
} from "./turn-events.mjs";
import {
  BLOCK_TURN_STATE_FLAG,
  getActiveBlockProgress,
  isActorInActiveBlock,
  isActorPendingInActiveBlock,
  isBlockTurnOrderEnabled,
  isCombatantAutoCompleted,
  markActorPreparedInState
} from "./turn-order-blocks.mjs";

export const REACTION_RESOURCE_KEY = "reactionPoints";
export const ONE_TIME_ACTION_POINTS_KEY = "system.resources.actionPoints.once";
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
const CLEAR_EFFECT_DURATION_UPDATE = Object.freeze({
  start: null,
  "duration.value": null,
  "duration.expiry": null,
  "duration.expired": false
});
const INCAPACITATING_COMBATANT_STATUSES = new Set(["dead", "unconscious", "stunned"]);

let advancingDefeatedTurnKey = "";

export function registerReactionResourceHooks() {
  Hooks.on("updateActor", (actor, changes, options) => {
    if (options?.[REACTION_UPDATE_OPTION]) return;
    const value = foundry.utils.getProperty(changes, `system.resources.${REACTION_RESOURCE_KEY}.value`);
    if (value === undefined) return;
    void convertInTurnReactionPoints(actor, value);
  });

  Hooks.on("combatTurnChange", async (combat, prior, current) => {
    if (!game.user?.isActiveGM || !combat?.started) return undefined;
    const previousActor = combat.combatants?.get(prior?.combatantId)?.actor ?? null;
    const currentActor = combat.combatants?.get(current?.combatantId)?.actor ?? combat.combatant?.actor ?? null;
    if (isBlockTurnOrderEnabled(combat)) {
      if (previousActor?.uuid && !isActorInActiveBlock(previousActor, combat)) {
        await restoreActorReactionResource(previousActor);
      }
      return prepareActiveBlockTurnStart(combat);
    }
    if (previousActor?.uuid && previousActor.uuid !== currentActor?.uuid) {
      await restoreActorReactionResource(previousActor);
    }
    await prepareActorTurnStart(currentActor);
    return syncActorDefeatedCombatants(currentActor, { advanceCurrent: false });
  });

  Hooks.on("createActiveEffect", effect => queueActorDefeatedCombatantSyncForEffect(effect));
  Hooks.on("updateActiveEffect", effect => queueActorDefeatedCombatantSyncForEffect(effect));
  Hooks.on("deleteActiveEffect", effect => queueActorDefeatedCombatantSyncForEffect(effect));
  Hooks.on("combatStart", (combat, updateData) => {
    prepareCombatStartDefeatedTurn(combat, updateData);
    void initializeCombatReactionResources(combat, updateData);
    globalThis.setTimeout(() => {
      void syncCombatDefeatedCombatants(combat, { advanceCurrent: true });
    }, 0);
  });
  Hooks.on("deleteCombat", combat => resetCombatReactionResources(combat));
  Hooks.on("createCombatant", async combatant => {
    const combat = combatant?.combat;
    if (!game.user?.isActiveGM || !combat?.started) return undefined;
    const isCurrentActor = combatant.actor?.uuid === combat.combatant?.actor?.uuid;
    await resetActorReactionResources(combatant.actor, { restore: !isCurrentActor });
    return syncActorDefeatedCombatants(combatant.actor, { advanceCurrent: isCurrentActor });
  });
}

async function prepareActiveBlockTurnStart(combat) {
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
      await syncActorDefeatedCombatants(actor, { combat, advanceCurrent: false });
      continue;
    }
    if (!prepared.has(actor.uuid)) {
      await prepareActorTurnStart(actor);
      state = markActorPreparedInState(combat, actor, state);
      prepared.add(actor.uuid);
      changed = true;
    }
    await syncActorDefeatedCombatants(actor, { combat, advanceCurrent: false });
  }

  if (changed) {
    await combat.update({
      [`flags.${SYSTEM_ID}.${BLOCK_TURN_STATE_FLAG}`]: state
    }, { turnEvents: false });
  }
  return undefined;
}

export async function prepareActorTurnStart(actor) {
  if (!actor?.isOwner) return;
  await deleteReactionDodgeEffects(actor);
  await deleteReactionPointEffects(actor);

  const updates = {};
  const reaction = actor.system?.resources?.[REACTION_RESOURCE_KEY];
  if (reaction) {
    updates[`system.resources.${REACTION_RESOURCE_KEY}.value`] = 0;
    updates[`system.resources.${REACTION_RESOURCE_KEY}.spent`] = Math.max(0, toInteger(reaction.max));
  }
  if (Object.keys(updates).length) await actor.update(updates, { [REACTION_UPDATE_OPTION]: true });

  await restoreActorMovementResources(actor);
  await restoreActorDodgeResource(actor, { mode: "round" });
  await callActorTurnStartPreparedHandlers({ actor, combat: game.combat });
}

async function syncCombatDefeatedCombatants(combat, { advanceCurrent = false } = {}) {
  if (!game.user?.isActiveGM || !combat) return false;
  const actors = new Map();
  for (const combatant of combat.combatants ?? []) {
    if (combatant.actor) actors.set(combatant.actor.uuid, combatant.actor);
  }
  let changed = false;
  for (const actor of actors.values()) {
    changed = (await syncActorDefeatedCombatants(actor, { combat, advanceCurrent })) || changed;
  }
  return changed;
}

async function syncActorDefeatedCombatants(actor, { combat = game.combat, advanceCurrent = false } = {}) {
  if (!game.user?.isActiveGM || !combat || !actor?.uuid) return false;
  const freshActor = fromUuidSync(actor.uuid) ?? actor;
  const defeated = actorHasIncapacitatingStatus(freshActor);
  const combatants = Array.from(combat.combatants ?? [])
    .filter(combatant => combatant.actor?.uuid === freshActor.uuid);
  let changed = false;
  for (const combatant of combatants) {
    changed = (await syncCombatantDefeatedState(combatant, defeated)) || changed;
  }
  if (defeated && advanceCurrent) {
    changed = (await advanceCurrentDefeatedTurn(combat, freshActor)) || changed;
  }
  return changed;
}

async function syncCombatantDefeatedState(combatant, defeated) {
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
    await combatant.update(update);
    return true;
  }

  if (!hasSyncFlag) return false;
  const update = {
    [`flags.${SYSTEM_ID}.${COMBATANT_DEFEATED_SYNC_FLAG}`]: globalThis._del
  };
  if (combatant.defeated && !syncData?.previousDefeated) update.defeated = false;
  await combatant.update(update);
  return true;
}

async function advanceCurrentDefeatedTurn(combat, actor) {
  if (!game.user?.isActiveGM || !combat?.started || !combat.settings?.skipDefeated || !actor?.uuid) return false;
  const combatant = combat.combatant;
  if (!combatant || combatant.actor?.uuid !== actor.uuid || !combatant.isDefeated) return false;
  const advanceKey = `${combat.id}:${combat.round}:${combat.turn}:${combatant.id}`;
  if (advancingDefeatedTurnKey === advanceKey) return false;
  advancingDefeatedTurnKey = advanceKey;
  try {
    await combat.nextTurn({ falloutMawConversionMode: TURN_CONVERSION_MODES.skip });
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

function queueActorDefeatedCombatantSyncForEffect(effect) {
  const actor = effect?.parent;
  if (!actor?.uuid) return;
  if (!effectHasIncapacitatingCombatantStatus(effect) && !actorHasIncapacitatingStatus(actor)) return;
  globalThis.setTimeout(() => {
    const combat = game.combat;
    const isCurrentActor = combat?.combatant?.actor?.uuid === actor.uuid;
    void syncActorDefeatedCombatants(actor, { combat, advanceCurrent: isCurrentActor });
  }, 0);
}

function effectHasIncapacitatingCombatantStatus(effect) {
  for (const status of effect?.statuses ?? []) {
    if (INCAPACITATING_COMBATANT_STATUSES.has(status)) return true;
  }
  return false;
}

export async function prepareActorTurnEnd(actor, { conversionMode = TURN_CONVERSION_MODES.dodge } = {}) {
  if (!actor?.isOwner) return;
  await callActorTurnEndHandlers({ actor, combat: game.combat, conversionMode });
  if (conversionMode !== TURN_CONVERSION_MODES.skip) {
    const remainingActionPoints = getNormalActionPointValue(actor);
    if (remainingActionPoints > 0) {
      if (conversionMode === TURN_CONVERSION_MODES.reaction) {
        await convertActionPointsToReactionPoints(actor, remainingActionPoints);
      } else if (conversionMode === TURN_CONVERSION_MODES.dodge) {
        await createOrUpdateReactionDodgeEffect(actor, remainingActionPoints * DODGE_CONVERSION_MULTIPLIER);
      }
    }
  }
  await zeroTurnResources(actor);
  await restoreActorReactionResource(actor);
  await deleteOneTimeActionPointEffects(actor, { source: IN_TURN_REACTION_SOURCE });
}

export async function restoreActorReactionResource(actor) {
  if (!actor?.isOwner) return;
  const reaction = actor.system?.resources?.[REACTION_RESOURCE_KEY];
  if (!reaction) return;
  const max = Math.max(0, toInteger(reaction.max));
  await actor.update({
    [`system.resources.${REACTION_RESOURCE_KEY}.value`]: max,
    [`system.resources.${REACTION_RESOURCE_KEY}.spent`]: 0
  }, { [REACTION_UPDATE_OPTION]: true });
}

export function getNormalActionPointValue(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[ACTION_RESOURCE_KEY]?.value));
}

export function getReactionPointValue(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[REACTION_RESOURCE_KEY]?.value));
}

export function getOneTimeActionPointTotal(actor) {
  return getOneTimeActionPointEntries(actor)
    .reduce((total, entry) => total + Math.max(0, toInteger(entry.value)), 0);
}

export function decorateActionPointHudEntry(actor, entry) {
  if (!entry?.key || entry.key !== ACTION_RESOURCE_KEY) return entry;
  const reactionValue = getReactionPointValue(actor);
  const combat = getActorActiveCombat(actor);
  if (combat && !isActorCurrentCombatant(actor, combat)) {
    const reactionMax = Math.max(0, toInteger(actor?.system?.resources?.[REACTION_RESOURCE_KEY]?.max));
    return {
      ...entry,
      key: REACTION_RESOURCE_KEY,
      label: "Очки реакции",
      value: reactionValue,
      min: 0,
      max: reactionMax,
      valueLabel: reactionValue,
      maxLabel: reactionMax,
      meterStyle: buildFlatMeterStyle(REACTION_FILL_COLOR, getMeterSections(reactionMax)),
      fillStyle: buildFlatFillStyle(REACTION_FILL_COLOR, reactionMax ? (reactionValue / reactionMax) * 100 : 0)
    };
  }

  const once = getOneTimeActionPointTotal(actor);
  if (!once) return entry;
  return {
    ...entry,
    valueLabel: `${entry.value}+${once}`,
    maxLabel: entry.max
  };
}

export function getCombatActionPointState(actor) {
  const action = actor?.system?.resources?.[ACTION_RESOURCE_KEY];
  const reaction = actor?.system?.resources?.[REACTION_RESOURCE_KEY];
  if (!action) return null;
  const actionValue = Math.max(0, toInteger(action.value));
  const reactionValue = Math.max(0, toInteger(reaction?.value));
  const onceValue = getOneTimeActionPointTotal(actor);
  const combat = getActorActiveCombat(actor);
  const ownTurn = !combat || isActorCurrentCombatant(actor, combat);
  return {
    ownTurn,
    key: ownTurn ? ACTION_RESOURCE_KEY : REACTION_RESOURCE_KEY,
    label: ownTurn ? "ОД" : "ОР",
    current: ownTurn ? actionValue : reactionValue,
    value: ownTurn ? actionValue + onceValue : reactionValue,
    normal: actionValue,
    once: onceValue,
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
    await actor.update({
      [`system.resources.${REACTION_RESOURCE_KEY}.value`]: Math.max(0, state.current - cost),
      [`system.resources.${REACTION_RESOURCE_KEY}.spent`]: Math.max(0, toInteger(actor.system?.resources?.[REACTION_RESOURCE_KEY]?.max) - Math.max(0, state.current - cost))
    }, { [REACTION_UPDATE_OPTION]: true });
    if (context?.suppressResourceNotification) return [];
    return notifyCombatResourcesSpent(actor, { [REACTION_RESOURCE_KEY]: cost }, context);
  }

  const normalSpend = Math.min(cost, state.normal);
  const onceSpend = cost - normalSpend;
  const updates = {};
  if (normalSpend) updates[`system.resources.${ACTION_RESOURCE_KEY}.value`] = Math.max(0, state.normal - normalSpend);
  if (Object.keys(updates).length) await actor.update(updates);
  if (onceSpend) await spendOneTimeActionPoints(actor, onceSpend);
  if (context?.suppressResourceNotification) return [];
  return notifyCombatResourcesSpent(actor, { [ACTION_RESOURCE_KEY]: cost }, context);
}

export async function promptEndTurnConversion(actor) {
  const remaining = getNormalActionPointValue(actor);
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

async function resetCombatReactionResources(combat) {
  if (!game.user?.isActiveGM) return;
  const actors = new Map();
  for (const combatant of combat?.combatants ?? []) {
    if (combatant.actor) actors.set(combatant.actor.uuid, combatant.actor);
  }
  for (const actor of actors.values()) await resetActorReactionResources(actor);
}

async function initializeCombatReactionResources(combat, updateData = {}) {
  if (!game.user?.isActiveGM) return;
  const initialTurn = Number.isInteger(updateData?.turn) ? updateData.turn : combat?.turn;
  const currentActorUuid = combat?.turns?.[initialTurn]?.actor?.uuid ?? combat?.combatant?.actor?.uuid ?? "";
  const actors = new Map();
  for (const combatant of combat?.combatants ?? []) {
    if (combatant.actor) actors.set(combatant.actor.uuid, combatant.actor);
  }
  for (const actor of actors.values()) {
    await resetActorReactionResources(actor, { restore: actor.uuid !== currentActorUuid });
  }
}

async function resetActorReactionResources(actor, { restore = false } = {}) {
  if (!actor?.isOwner) return;
  await deleteReactionDodgeEffects(actor);
  await deleteReactionPointEffects(actor);
  const updates = {};
  const reaction = actor.system?.resources?.[REACTION_RESOURCE_KEY];
  if (reaction) {
    const max = Math.max(0, toInteger(reaction.max));
    updates[`system.resources.${REACTION_RESOURCE_KEY}.value`] = restore ? max : 0;
    updates[`system.resources.${REACTION_RESOURCE_KEY}.spent`] = restore ? 0 : max;
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

async function zeroTurnResources(actor) {
  const updates = {};
  for (const key of [ACTION_RESOURCE_KEY, MOVEMENT_RESOURCE_KEY]) {
    const resource = actor.system?.resources?.[key];
    if (!resource) continue;
    updates[`system.resources.${key}.value`] = 0;
    updates[`system.resources.${key}.spent`] = Math.max(0, toInteger(resource.max));
  }
  if (Object.keys(updates).length) await actor.update(updates);
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

async function createOrUpdateReactionPointEffect(actor, amount) {
  const value = Math.max(0, toInteger(amount));
  if (!value) return;
  const existing = actor.effects?.find(effect => effect.getFlag(SYSTEM_ID, REACTION_POINTS_EFFECT_FLAG)) ?? null;
  const data = buildReactionPointEffectData(actor, value);
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

async function deleteReactionPointEffects(actor) {
  const ids = actor?.effects
    ?.filter(effect => effect.getFlag(SYSTEM_ID, REACTION_POINTS_EFFECT_FLAG))
    .map(effect => effect.id) ?? [];
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { animate: false });
}

async function deleteReactionDodgeEffects(actor) {
  const ids = actor?.effects
    ?.filter(effect => effect.getFlag(SYSTEM_ID, REACTION_DODGE_EFFECT_FLAG))
    .map(effect => effect.id) ?? [];
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, { animate: false });
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
