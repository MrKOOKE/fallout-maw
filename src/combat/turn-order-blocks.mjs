import { SYSTEM_ID } from "../constants.mjs";
import { getCombatSettings } from "../settings/accessors.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorPrimaryFaction,
  getRelationTo
} from "../settings/factions.mjs";
import { isActorUnableToAct } from "./reaction-hub.mjs";

export const TURN_ORDER_SCHEMES = Object.freeze({
  normal: "normal",
  block: "block"
});

export const BLOCK_TURN_STATE_FLAG = "blockTurnState";
export const BLOCK_TURN_COMBATANT_OPTION = "falloutMawBlockTurnCombatantId";
export const BLOCK_TURN_ACTOR_OPTION = "falloutMawBlockTurnActorUuid";

export function getCombatTurnOrderScheme() {
  const scheme = getCombatSettings().turnOrder?.scheme;
  return scheme === TURN_ORDER_SCHEMES.normal ? TURN_ORDER_SCHEMES.normal : TURN_ORDER_SCHEMES.block;
}

export function isBlockTurnOrderEnabled(combat = game.combat) {
  return Boolean(combat?.started && getCombatTurnOrderScheme() === TURN_ORDER_SCHEMES.block);
}

export function getCombatTurnBlocks(combat = game.combat) {
  const turns = Array.from(combat?.turns ?? []);
  const blocks = [];
  let current = [];

  for (const combatant of turns) {
    const previous = current.at(-1);
    if (previous && canJoinCombatants(previous, combatant)) {
      current.push(combatant);
      continue;
    }
    if (current.length) blocks.push(createTurnBlock(combat, blocks.length, current, turns));
    current = [combatant];
  }
  if (current.length) blocks.push(createTurnBlock(combat, blocks.length, current, turns));
  return blocks;
}

export function getActiveCombatTurnBlock(combat = game.combat) {
  if (!combat || !Number.isInteger(combat.turn)) return null;
  return getCombatTurnBlocks(combat).find(block => block.start <= combat.turn && combat.turn <= block.end) ?? null;
}

export function getActiveBlockProgress(combat = game.combat) {
  const block = getActiveCombatTurnBlock(combat);
  if (!block) return null;
  const source = getMatchingBlockState(combat, block);
  const completedActorUuids = new Set(source.completedActorUuids);
  const completedCombatantIds = new Set(source.completedCombatantIds);

  for (const combatant of block.combatants) {
    if (!isCombatantAutoCompleted(combatant)) continue;
    if (combatant.actor?.uuid) completedActorUuids.add(combatant.actor.uuid);
    else completedCombatantIds.add(combatant.id);
  }

  return {
    block,
    state: {
      ...source,
      completedActorUuids: Array.from(completedActorUuids),
      completedCombatantIds: Array.from(completedCombatantIds)
    },
    preparedActorUuids: new Set(source.preparedActorUuids),
    completedActorUuids,
    completedCombatantIds
  };
}

export function createBlockTurnState(combat, block, state = {}) {
  return {
    round: Math.max(0, Number(combat?.round) || 0),
    signature: String(block?.signature ?? ""),
    preparedActorUuids: normalizeStringArray(state.preparedActorUuids),
    completedActorUuids: normalizeStringArray(state.completedActorUuids),
    completedCombatantIds: normalizeStringArray(state.completedCombatantIds)
  };
}

export function getMatchingBlockState(combat, block) {
  const state = normalizeBlockTurnState(combat?.getFlag?.(SYSTEM_ID, BLOCK_TURN_STATE_FLAG));
  if (state.round !== combat?.round || state.signature !== block?.signature) {
    return createBlockTurnState(combat, block);
  }
  return state;
}

export function isCombatantInActiveBlock(combatant, combat = game.combat) {
  const block = getActiveCombatTurnBlock(combat);
  return Boolean(block?.combatants.includes(combatant));
}

export function isActorInActiveBlock(actor, combat = game.combat) {
  if (!actor?.uuid || !isBlockTurnOrderEnabled(combat)) return false;
  const block = getActiveCombatTurnBlock(combat);
  return Boolean(block?.combatants.some(combatant => combatant.actor?.uuid === actor.uuid));
}

export function isActorCompletedInActiveBlock(actor, combat = game.combat) {
  if (!actor?.uuid || !isBlockTurnOrderEnabled(combat)) return false;
  const progress = getActiveBlockProgress(combat);
  return Boolean(progress?.completedActorUuids.has(actor.uuid));
}

export function isActorPendingInActiveBlock(actor, combat = game.combat) {
  if (!isActorInActiveBlock(actor, combat)) return false;
  return !isActorCompletedInActiveBlock(actor, combat);
}

export function isCombatantCompletedInActiveBlock(combatant, combat = game.combat) {
  if (!combatant || !isBlockTurnOrderEnabled(combat)) return false;
  const progress = getActiveBlockProgress(combat);
  if (!progress?.block.combatants.includes(combatant)) return false;
  return isCombatantCompleted(combatant, progress);
}

export function isTokenDocumentInActiveBlockTurn(tokenDocument, combat = game.combat) {
  if (!tokenDocument || !isBlockTurnOrderEnabled(combat)) return false;
  return getActiveBlockManualCombatants(combat)
    .some(combatant => isCombatantTokenDocument(combatant, tokenDocument));
}

export function getActiveBlockTokenObjects(combat = game.combat) {
  if (!isBlockTurnOrderEnabled(combat)) return [];
  return getActiveBlockManualCombatants(combat)
    .map(getCombatantTokenObject)
    .filter(Boolean);
}

export function isActiveBlockComplete(combat = game.combat, state = null) {
  const progress = state
    ? getProgressForState(combat, state)
    : getActiveBlockProgress(combat);
  if (!progress) return false;
  return progress.block.combatants.every(combatant => isCombatantCompleted(combatant, progress));
}

export function getBlockTurnTargetCombatant(combat = game.combat, options = {}) {
  const progress = getActiveBlockProgress(combat);
  if (!progress) return null;
  const block = progress.block;
  const firstIncomplete = getFirstIncompleteBlockCombatant(block, progress);

  const byCombatantId = normalizeId(options?.[BLOCK_TURN_COMBATANT_OPTION]);
  if (byCombatantId) {
    const combatant = block.combatants.find(candidate => candidate.id === byCombatantId);
    if (combatant && !isCombatantCompleted(combatant, progress)) return combatant;
    return firstIncomplete;
  }

  const byActorUuid = normalizeId(options?.[BLOCK_TURN_ACTOR_OPTION]);
  if (byActorUuid) {
    const combatant = block.combatants.find(candidate => candidate.actor?.uuid === byActorUuid);
    if (combatant && !isCombatantCompleted(combatant, progress)) return combatant;
    return firstIncomplete;
  }

  const selected = getSelectedBlockCombatant(combat, block);
  if (selected && !isCombatantCompleted(selected, progress)) return selected;
  if (block.combatants.includes(combat.combatant) && !isCombatantCompleted(combat.combatant, progress)) {
    return combat.combatant;
  }
  return firstIncomplete;
}

export function markCombatantCompletedInState(combat, combatant, state) {
  const next = createBlockTurnState(combat, getActiveCombatTurnBlock(combat), state);
  if (combatant?.actor?.uuid) next.completedActorUuids = addUnique(next.completedActorUuids, combatant.actor.uuid);
  else if (combatant?.id) next.completedCombatantIds = addUnique(next.completedCombatantIds, combatant.id);
  return next;
}

export function markActorPreparedInState(combat, actor, state) {
  const next = createBlockTurnState(combat, getActiveCombatTurnBlock(combat), state);
  if (actor?.uuid) next.preparedActorUuids = addUnique(next.preparedActorUuids, actor.uuid);
  return next;
}

export function getNextBlockTurnIndex(combat = game.combat, direction = 1) {
  const blocks = getCombatTurnBlocks(combat);
  const active = getActiveCombatTurnBlock(combat);
  if (!active) return null;
  const step = direction < 0 ? -1 : 1;
  for (let index = active.index + step; index >= 0 && index < blocks.length; index += step) {
    if (blockHasManualTurn(blocks[index])) return blocks[index].start;
  }
  return null;
}

export function getFirstBlockTurnIndex(combat = game.combat) {
  return getCombatTurnBlocks(combat).find(blockHasManualTurn)?.start ?? null;
}

export function blockHasManualTurn(block) {
  return Boolean(block?.combatants.some(combatant => !isCombatantAutoCompleted(combatant)));
}

export function isCombatantAutoCompleted(combatant) {
  if (!combatant) return true;
  return Boolean(combatant.isDefeated || (combatant.actor && isActorUnableToAct(combatant.actor)));
}

function getProgressForState(combat, state) {
  const block = getActiveCombatTurnBlock(combat);
  if (!block) return null;
  const normalized = createBlockTurnState(combat, block, state);
  return {
    block,
    state: normalized,
    preparedActorUuids: new Set(normalized.preparedActorUuids),
    completedActorUuids: new Set(normalized.completedActorUuids),
    completedCombatantIds: new Set(normalized.completedCombatantIds)
  };
}

function isCombatantCompleted(combatant, progress) {
  if (isCombatantAutoCompleted(combatant)) return true;
  if (combatant.actor?.uuid) return progress.completedActorUuids.has(combatant.actor.uuid);
  return progress.completedCombatantIds.has(combatant.id);
}

function getActiveBlockManualCombatants(combat) {
  const progress = getActiveBlockProgress(combat);
  if (!progress) return [];
  return progress.block.combatants.filter(combatant => !isCombatantCompleted(combatant, progress));
}

function getFirstIncompleteBlockCombatant(block, progress) {
  return block?.combatants.find(combatant => !isCombatantCompleted(combatant, progress)) ?? null;
}

function getCombatantTokenObject(combatant) {
  const object = combatant?.token?._object;
  if (object) return object;
  return canvas?.tokens?.placeables?.find(token => isCombatantTokenDocument(combatant, token.document)) ?? null;
}

function isCombatantTokenDocument(combatant, tokenDocument) {
  if (!combatant?.tokenId || !tokenDocument?.id || combatant.tokenId !== tokenDocument.id) return false;
  const sceneId = tokenDocument.parent?.id ?? tokenDocument.scene?.id;
  return !combatant.sceneId || !sceneId || combatant.sceneId === sceneId;
}

function createTurnBlock(combat, index, combatants, turns) {
  const start = turns.indexOf(combatants[0]);
  const end = start + combatants.length - 1;
  return {
    index,
    start,
    end,
    combatants: Array.from(combatants),
    signature: `${combat?.id ?? ""}:${combatants.map(combatant => combatant.id).join("|")}`
  };
}

function canJoinCombatants(left, right) {
  if (!isFactionBlockEligible(left) || !isFactionBlockEligible(right)) return false;
  const leftFaction = getActorPrimaryFaction(left.actor);
  const rightFaction = getActorPrimaryFaction(right.actor);
  if (leftFaction === rightFaction) return true;
  return getRelationTo(left.actor, rightFaction) === "ally";
}

function isFactionBlockEligible(combatant) {
  if (!combatant?.actor || combatant.getFlag?.(SYSTEM_ID, "event")) return false;
  const primary = getActorPrimaryFaction(combatant.actor);
  return Boolean(primary && primary !== DEFAULT_FACTION_NAME);
}

function getSelectedBlockCombatant(combat, block) {
  for (const token of canvas?.tokens?.controlled ?? []) {
    const tokenDocument = token?.document;
    const combatant = block.combatants.find(candidate => (
      candidate.tokenId === tokenDocument?.id
      && (!candidate.sceneId || !tokenDocument?.parent?.id || candidate.sceneId === tokenDocument.parent.id)
    ));
    if (combatant) return combatant;
  }
  return null;
}

function normalizeBlockTurnState(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    round: Math.max(0, Number(source.round) || 0),
    signature: String(source.signature ?? ""),
    preparedActorUuids: normalizeStringArray(source.preparedActorUuids),
    completedActorUuids: normalizeStringArray(source.completedActorUuids),
    completedCombatantIds: normalizeStringArray(source.completedCombatantIds)
  };
}

function normalizeStringArray(value = []) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map(normalizeId)
    .filter(Boolean)));
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

function addUnique(values, value) {
  const normalized = normalizeId(value);
  if (!normalized || values.includes(normalized)) return values;
  return [...values, normalized];
}
