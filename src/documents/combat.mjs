import {
  TURN_CONVERSION_MODES,
  prepareActorTurnEnd
} from "../combat/reaction-resources.mjs";
import { isActorUnableToAct } from "../combat/reaction-hub.mjs";

const TURN_END_PROCESSED_OPTION = "falloutMawTurnEndProcessed";
const SURPRISED_INITIATIVE_OPTION = "falloutMawSurprisedCombatantIds";

export class FalloutMaWCombat extends Combat {
  #processingFalloutMawTurnEnd = false;

  async rollInitiative(ids, options = {}) {
    const surprisedIds = normalizeCombatantIdSet(options?.[SURPRISED_INITIATIVE_OPTION]);
    if (!surprisedIds.size) return super.rollInitiative(ids, options);

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
    const processed = await this.#processCurrentTurnEnd(options);
    try {
      return await super.nextTurn({ ...options, [TURN_END_PROCESSED_OPTION]: processed });
    } finally {
      if (processed) this.#processingFalloutMawTurnEnd = false;
    }
  }

  async previousTurn(options = {}) {
    const processed = await this.#processCurrentTurnEnd(options);
    try {
      return await super.previousTurn({ ...options, [TURN_END_PROCESSED_OPTION]: processed });
    } finally {
      if (processed) this.#processingFalloutMawTurnEnd = false;
    }
  }

  async nextRound(options = {}) {
    const processed = await this.#processCurrentTurnEnd(options);
    try {
      return await super.nextRound({ ...options, [TURN_END_PROCESSED_OPTION]: processed });
    } finally {
      if (processed) this.#processingFalloutMawTurnEnd = false;
    }
  }

  async previousRound(options = {}) {
    const processed = await this.#processCurrentTurnEnd(options);
    try {
      return await super.previousRound({ ...options, [TURN_END_PROCESSED_OPTION]: processed });
    } finally {
      if (processed) this.#processingFalloutMawTurnEnd = false;
    }
  }

  async #processCurrentTurnEnd(options = {}) {
    if (options?.[TURN_END_PROCESSED_OPTION]) return true;
    if (this.#processingFalloutMawTurnEnd) return true;
    if (!game.user?.isActiveGM && !this.combatant?.isOwner) return false;
    if (!this.started || !this.combatant?.actor) return false;
    const conversionMode = this.combatant.isDefeated || isActorUnableToAct(this.combatant.actor)
      ? TURN_CONVERSION_MODES.skip
      : (options?.falloutMawConversionMode ?? TURN_CONVERSION_MODES.dodge);
    this.#processingFalloutMawTurnEnd = true;
    await prepareActorTurnEnd(this.combatant.actor, { conversionMode });
    return true;
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

      const rollFormula = surprisedIds.has(id)
        ? buildSurprisedInitiativeFormula(formula || combatant._getInitiativeFormula?.())
        : formula;
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

function buildSurprisedInitiativeFormula(formula) {
  const source = String(formula || CONFIG.Combat.initiative.formula || game.system.initiative || "1d20");
  const disadvantaged = source.replace(/\b1d20\b/i, "2d20kl");
  return `(${disadvantaged}) - 10`;
}
