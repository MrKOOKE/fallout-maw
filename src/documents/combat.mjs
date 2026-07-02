import {
  TURN_CONVERSION_MODES,
  prepareActorTurnEnd
} from "../combat/reaction-resources.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { isActorUnableToAct } from "../combat/reaction-hub.mjs";
import {
  INITIATIVE_ADVANTAGE_EFFECT_KEY,
  INITIATIVE_DISADVANTAGE_EFFECT_KEY,
  evaluateActorEffectChangeNumber
} from "../utils/active-effect-changes.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  BLOCK_TURN_STATE_FLAG,
  createBlockTurnState,
  getActiveBlockProgress,
  getActiveBlockTokenObjects,
  getBlockTurnTargetCombatant,
  getNextBlockTurnIndex,
  isActiveBlockComplete,
  isBlockTurnOrderEnabled,
  isCombatantCompletedInActiveBlock,
  markCombatantCompletedInState
} from "../combat/turn-order-blocks.mjs";

const TURN_END_PROCESSED_OPTION = "falloutMawTurnEndProcessed";
const SURPRISED_INITIATIVE_OPTION = "falloutMawSurprisedCombatantIds";

export class FalloutMaWCombat extends Combat {
  #processingFalloutMawTurnEnd = false;

  async rollInitiative(ids, options = {}) {
    const surprisedIds = normalizeCombatantIdSet(options?.[SURPRISED_INITIATIVE_OPTION]);

    const {
      [SURPRISED_INITIATIVE_OPTION]: _surprised,
      formula = null,
      updateTurn = true,
      messageMode,
      messageOptions = {}
    } = options;

    return this.#rollInitiativeWithSurprise(ids, {
      formula,
      updateTurn,
      messageMode,
      messageOptions
    }, surprisedIds);
  }

  async nextTurn(options = {}) {
    if (isBlockTurnOrderEnabled(this)) return this.#nextBlockTurn(options);
    const processed = await this.#processCurrentTurnEnd(options);
    try {
      return await super.nextTurn({ ...options, [TURN_END_PROCESSED_OPTION]: processed });
    } finally {
      if (processed) this.#processingFalloutMawTurnEnd = false;
    }
  }

  async previousTurn(options = {}) {
    if (isBlockTurnOrderEnabled(this)) return this.#previousBlockTurn(options);
    const processed = await this.#processCurrentTurnEnd(options);
    try {
      return await super.previousTurn({ ...options, [TURN_END_PROCESSED_OPTION]: processed });
    } finally {
      if (processed) this.#processingFalloutMawTurnEnd = false;
    }
  }

  async nextRound(options = {}) {
    if (isBlockTurnOrderEnabled(this)) {
      const processed = await this.#processBlockTurnTargetEnd(options);
      try {
        return await super.nextRound({ ...options, [TURN_END_PROCESSED_OPTION]: processed });
      } finally {
        if (processed) this.#processingFalloutMawTurnEnd = false;
      }
    }
    const processed = await this.#processCurrentTurnEnd(options);
    try {
      return await super.nextRound({ ...options, [TURN_END_PROCESSED_OPTION]: processed });
    } finally {
      if (processed) this.#processingFalloutMawTurnEnd = false;
    }
  }

  async previousRound(options = {}) {
    if (isBlockTurnOrderEnabled(this)) return super.previousRound(options);
    const processed = await this.#processCurrentTurnEnd(options);
    try {
      return await super.previousRound({ ...options, [TURN_END_PROCESSED_OPTION]: processed });
    } finally {
      if (processed) this.#processingFalloutMawTurnEnd = false;
    }
  }

  async #nextBlockTurn(options = {}) {
    if (this.round === 0) return super.nextRound(options);
    const progress = getActiveBlockProgress(this);
    if (!progress) return this;

    let state = progress.state;
    const target = getBlockTurnTargetCombatant(this, options);
    if (target && !isCombatantCompletedInActiveBlock(target, this)) {
      const processed = await this.#processCombatantTurnEnd(target, options);
      if (processed) state = markCombatantCompletedInState(this, target, state);
    }

    try {
      if (!isActiveBlockComplete(this, state)) {
        await this.#updateBlockTurnState(state);
        return this;
      }

      const nextTurn = getNextBlockTurnIndex(this, 1);
      if (nextTurn === null) return super.nextRound({ ...options, [TURN_END_PROCESSED_OPTION]: true });
      await this.#advanceToTurn(nextTurn, 1);
      return this;
    } finally {
      this.#processingFalloutMawTurnEnd = false;
    }
  }

  async #previousBlockTurn(options = {}) {
    if (this.round === 0) return this;
    const previousTurn = getNextBlockTurnIndex(this, -1);
    if (previousTurn === null) return super.previousRound(options);
    await this.#advanceToTurn(previousTurn, -1);
    return this;
  }

  async #processBlockTurnTargetEnd(options = {}) {
    const target = getBlockTurnTargetCombatant(this, options);
    if (!target || isCombatantCompletedInActiveBlock(target, this)) return true;
    const processed = await this.#processCombatantTurnEnd(target, options);
    if (!processed) return false;
    const progress = getActiveBlockProgress(this);
    const state = markCombatantCompletedInState(this, target, progress?.state ?? createBlockTurnState(this, progress?.block));
    await this.#updateBlockTurnState(state);
    return true;
  }

  async #processCurrentTurnEnd(options = {}) {
    return this.#processCombatantTurnEnd(this.combatant, options);
  }

  async #processCombatantTurnEnd(combatant, options = {}) {
    if (options?.[TURN_END_PROCESSED_OPTION]) return true;
    if (this.#processingFalloutMawTurnEnd) return true;
    if (!game.user?.isActiveGM && !combatant?.isOwner) return false;
    if (!this.started || !combatant) return false;
    if (!combatant.actor) return true;
    const conversionMode = combatant.isDefeated || isActorUnableToAct(combatant.actor)
      ? TURN_CONVERSION_MODES.skip
      : (options?.falloutMawConversionMode ?? TURN_CONVERSION_MODES.dodge);
    this.#processingFalloutMawTurnEnd = true;
    await prepareActorTurnEnd(combatant.actor, { conversionMode });
    return true;
  }

  async #advanceToTurn(turn, direction = 1) {
    if (!Number.isInteger(turn) || turn < 0 || turn >= this.turns.length) return this;
    const advanceTime = this.getTimeDelta(this.round, this.turn, this.round, turn);
    const updateData = { round: this.round, turn };
    const updateOptions = { direction, worldTime: { delta: advanceTime } };
    Hooks.callAll("combatTurn", this, updateData, updateOptions);
    await this.update(updateData, updateOptions);
    return this;
  }

  async #updateBlockTurnState(state) {
    const progress = getActiveBlockProgress(this);
    const block = progress?.block;
    if (!block) return this;
    const next = createBlockTurnState(this, block, state);
    await this.update({
      [`flags.${SYSTEM_ID}.${BLOCK_TURN_STATE_FLAG}`]: next
    }, { turnEvents: false });
    this._updateTurnMarkers();
    return this;
  }

  _updateTurnMarkers() {
    if (!isBlockTurnOrderEnabled(this)) return super._updateTurnMarkers();
    if (!canvas.ready) return;
    const activeTokens = new Set(getActiveBlockTokenObjects(this));
    for (const token of canvas.tokens.turnMarkers) {
      if (!activeTokens.has(token)) token.renderFlags.set({ refreshTurnMarker: true });
    }
    if (this.isView) {
      for (const token of activeTokens) token.renderFlags.set({ refreshTurnMarker: true });
    }
  }

  async #rollInitiativeWithSurprise(ids, { formula = null, updateTurn = true, messageMode, messageOptions = {} } = {}, surprisedIds = new Set()) {
    ids = typeof ids === "string" ? [ids] : ids;
    if ("rollMode" in messageOptions) {
      foundry.utils.logCompatibilityWarning("The rollMode option of Combat#rollInitiative messageOptions is"
        + " deprecated in favor of the `messageMode` option, a string key of CONFIG.ChatMessage.modes",
      { since: 14, until: 16 });
      messageMode = foundry.dice.Roll._mapLegacyRollMode(messageOptions.rollMode);
      delete messageOptions.rollMode;
    }

    const updates = [];
    const messages = [];
    for (const [i, id] of ids.entries()) {
      const combatant = this.combatants.get(id);
      if (!combatant?.isOwner) continue;

      const rollFormula = buildInitiativeFormula(formula || combatant._getInitiativeFormula?.(), combatant.actor, {
        surprised: surprisedIds.has(id)
      });
      const roll = combatant.getInitiativeRoll(rollFormula);
      await roll.evaluate();
      updates.push({ _id: id, initiative: roll.total });

      const messageData = foundry.utils.mergeObject({
        speaker: foundry.documents.ChatMessage.implementation.getSpeaker({
          actor: combatant.actor,
          token: combatant.token,
          alias: combatant.name
        }),
        flavor: game.i18n.format("COMBAT.RollsInitiative", { name: foundry.utils.escapeHTML(combatant.name) }),
        flags: { "core.initiativeRoll": true }
      }, messageOptions);
      const chatData = await roll.toMessage(messageData, {
        messageMode: messageMode ?? (combatant.hidden ? "gm" : undefined),
        create: false
      });
      if (i > 0) chatData.sound = null;
      messages.push(chatData);
    }
    if (!updates.length) return this;

    const updateOptions = { turnEvents: false };
    if (!updateTurn) updateOptions.combatTurn = this.turn;
    await this.updateEmbeddedDocuments("Combatant", updates, updateOptions);
    await foundry.documents.ChatMessage.implementation.create(messages);
    return this;
  }
}

function normalizeCombatantIdSet(value) {
  if (value instanceof Set) return new Set(Array.from(value, normalizeCombatantId).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map(normalizeCombatantId).filter(Boolean));
  const id = normalizeCombatantId(value);
  return id ? new Set([id]) : new Set();
}

function normalizeCombatantId(value) {
  return String(value ?? "").trim();
}

function buildInitiativeFormula(formula, actor, { surprised = false } = {}) {
  const source = String(formula || CONFIG.Combat.initiative.formula || game.system.initiative || "1d20");
  const edge = calculateInitiativeEdge(actor, { surprised });
  const edgeFormula = applyInitiativeRollMode(source, edge.rollMode);
  const modifier = edge.skillModifier + (surprised ? -10 : 0);
  return modifier ? `(${edgeFormula}) ${modifier >= 0 ? "+" : "-"} ${Math.abs(modifier)}` : edgeFormula;
}

function calculateInitiativeEdge(actor, { surprised = false } = {}) {
  const advantageCount = getActorInitiativeEdgeCount(actor, INITIATIVE_ADVANTAGE_EFFECT_KEY);
  const disadvantageCount = getActorInitiativeEdgeCount(actor, INITIATIVE_DISADVANTAGE_EFFECT_KEY) + (surprised ? 1 : 0);
  const net = advantageCount - disadvantageCount;
  if (net > 0) return {
    rollMode: "advantage",
    skillModifier: Math.max(0, net - 1) * 4
  };
  if (net < 0) return {
    rollMode: "disadvantage",
    skillModifier: Math.max(0, Math.abs(net) - 1) * -4
  };
  return {
    rollMode: "normal",
    skillModifier: 0
  };
}

function getActorInitiativeEdgeCount(actor, effectKey = "") {
  let total = 0;
  for (const effect of actor?.allApplicableEffects?.() ?? actor?.effects ?? []) {
    if (effect?.disabled || effect?.active === false) continue;
    for (const change of effect?.system?.changes ?? []) {
      if (String(change?.key ?? "").trim() !== effectKey) continue;
      total += Math.max(0, toInteger(evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: 0 })));
    }
  }
  return total;
}

function applyInitiativeRollMode(formula = "", rollMode = "normal") {
  if (rollMode === "advantage") return String(formula).replace(/\b1d20\b/i, "2d20kh");
  if (rollMode === "disadvantage") return String(formula).replace(/\b1d20\b/i, "2d20kl");
  return String(formula);
}
