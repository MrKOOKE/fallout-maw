import {
  TURN_CONVERSION_MODES,
  prepareActorTurnEnd
} from "../combat/reaction-resources.mjs";

const TURN_END_PROCESSED_OPTION = "falloutMawTurnEndProcessed";

export class FalloutMaWCombat extends Combat {
  #processingFalloutMawTurnEnd = false;

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
    const conversionMode = options?.falloutMawConversionMode ?? TURN_CONVERSION_MODES.dodge;
    this.#processingFalloutMawTurnEnd = true;
    await prepareActorTurnEnd(this.combatant.actor, { conversionMode });
    return true;
  }
}
